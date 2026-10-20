import type { DanmakuComment } from '@shared/types'
import { log } from '../../log'
import { captureRequestUrl } from './iframeCapture'
import type { DanmakuFetcher, FetcherContext, FetcherEntry, FetcherEpisodeResult } from './types'

/**
 * E站（ezdmw.org）弹幕获取器。
 *
 * ## 数据链路（真机抓包确认）
 *   播放页 `/Index/video/<id>.html`
 *     └─ 跨站 iframe `player.ezdmw.com/danmuku/?nk=<nk>&…&timeAxis=…`
 *          └─ XHR `/index/getData.html?video_id=<nk>&json=xml&danmu=<nk>&sign=<md5>&timeAxis=false`
 *               └─ 返回标准 **B 站 XML**：`<d p="时间,模式,字号,颜色,时间戳,…">文本</d>`
 *
 * ## 两个必须绕过去的坑
 * 1. **`sign` 是必需的**：去掉它 HTTP 200 但**返回 0 字节**（真机实测）。
 *    sign 由站点 JS 现算，拿不到就算不出来 —— 所以用隐藏窗口加载 iframe、
 *    把它自己发出的那条 `getData.html` 请求 URL 截下来（见 `iframeCapture.ts`）。
 * 2. **iframe 地址带时效**：过期后页面只显示「请求过期了，请刷新」。
 *    因此每次都从播放页现场取一条新的 iframe 地址，不能缓存。
 */

const BASE = 'https://www.ezdmw.org'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function getText(url: string, referer = `${BASE}/`): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: referer, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(25_000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

interface Hit {
  bangumiId: string
  title: string
}

/** 搜索结果：条目链接形如 `/Index/bangumi/83113.html` */
async function searchEzdmw(keyword: string): Promise<Hit[]> {
  const html = await getText(`${BASE}/Index/search.html?searchText=${encodeURIComponent(keyword)}`)
  /*
   * 真机结构（别按"锚文本就是标题"想）：
   *   <a href="/Index/bangumi/83113.html" target="_blank"><img src="…" alt="…"></a>
   * 锚里面包的是封面 `<img>`，标题要么在 `title=` 属性上、要么在图片 `alt` 里。
   * 所以这里只可靠地取 id，标题按"属性 → alt → 兜底"三级回退。
   */
  const out: Hit[] = []
  const re = /href="\/Index\/bangumi\/(\d+)\.html"([^>]*)>/gi
  for (const m of html.matchAll(re)) {
    const id = m[1]
    if (out.some((h) => h.bangumiId === id)) continue
    const attrs = String(m[2] ?? '')
    let title = (attrs.match(/title="([^"]{1,80})"/i) ?? [])[1] ?? ''
    if (!title) {
      const after = html.slice(m.index ?? 0, (m.index ?? 0) + 300)
      title = (after.match(/alt="([^"]{1,80})"/i) ?? [])[1] ?? ''
    }
    title = title.replace(/&amp;/g, '&').trim()
    out.push({ bangumiId: id, title: title || `${keyword}（E站 #${id}）` })
  }
  return out
}

/** 选集：番剧页里每条视频是 `/Index/video/<id>.html` */
async function episodesEzdmw(bangumiId: string): Promise<{ videoId: string; title: string }[]> {
  const html = await getText(`${BASE}/Index/bangumi/${bangumiId}.html`)
  const out: { videoId: string; title: string }[] = []
  const re = /<a[^>]+href="\/Index\/video\/(\d+)\.html"[^>]*>([\s\S]{0,80}?)<\/a>/gi
  for (const m of html.matchAll(re)) {
    const title = String(m[2] ?? '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .trim()
    if (out.some((x) => x.videoId === m[1])) continue
    out.push({ videoId: m[1], title: title || `第 ${out.length + 1} 集` })
  }
  return out
}

/** 从播放页取出**当前有效**的弹幕 iframe 地址 */
function iframeUrlOf(playHtml: string): string | null {
  const m = playHtml.match(/<iframe[^>]+src="(https:\/\/player\.ezdmw\.com\/danmuku\/[^"]+)"/i)
  return m ? m[1].replace(/&amp;/g, '&') : null
}

/**
 * 解析 B 站 XML 弹幕。
 *
 * `p` 属性字段顺序：`时间,模式,字号,颜色,时间戳,弹幕池,用户hash,行号`
 * 模式：1/2/3 = 滚动，4 = 底部，5 = 顶部 → 映射到我们内部的 1（滚动）/ 4（底部）/ 5（顶部）。
 */
function parseXml(xml: string): DanmakuComment[] {
  const out: DanmakuComment[] = []
  const re = /<d\s+p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/gi
  for (const m of xml.matchAll(re)) {
    const parts = String(m[1]).split(',')
    const time = Number(parts[0])
    if (!Number.isFinite(time) || time < 0) continue
    const modeRaw = Number(parts[1] ?? 1)
    const mode = modeRaw === 5 ? 5 : modeRaw === 4 ? 4 : 1
    const size = Number(parts[2] ?? 25) || 25
    const colorNum = Number(parts[3] ?? 16777215)
    const color = Number.isFinite(colorNum) ? `#${(colorNum & 0xffffff).toString(16).padStart(6, '0')}` : '#ffffff'
    const text = String(m[2] ?? '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .trim()
    if (!text) continue
    out.push({ time, text, mode: mode as 1 | 4 | 5, color, size })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

export const ezdmwFetcher: DanmakuFetcher = {
  id: 'ezdmw',
  name: 'E站(ezdmw)',
  kind: 'site',

  async search(keyword: string, _ctx: FetcherContext): Promise<FetcherEntry[]> {
    const hits = await searchEzdmw(keyword)
    const out: FetcherEntry[] = []
    for (const hit of hits.slice(0, 3)) {
      let eps: { videoId: string; title: string }[] = []
      try {
        eps = await episodesEzdmw(hit.bangumiId)
      } catch {
        eps = []
      }
      if (eps.length === 0) continue
      out.push({
        id: hit.bangumiId,
        title: hit.title,
        extra: `${eps.length} 集`,
        keyword,
        episodes: eps.map((e, i) => ({ id: e.videoId, index: i + 1, title: e.title })),
        raw: { episodes: eps }
      })
    }
    return out
  },

  async fetchEpisode(entry: FetcherEntry, episode: number, ctx: FetcherContext): Promise<FetcherEpisodeResult> {
    const raw = (entry.raw ?? {}) as { episodes?: { videoId: string; title: string }[] }
    const target = raw.episodes?.[episode - 1]
    const videoId = target?.videoId
    if (!videoId) throw new Error(`E站条目里没有第 ${episode} 集`)

    ctx.onProgress?.({ step: 3, total: 4, label: `正在打开 E站第 ${episode} 集播放页…` })
    const playHtml = await getText(`${BASE}/Index/video/${videoId}.html`)
    const iframeUrl = iframeUrlOf(playHtml)
    if (!iframeUrl) throw new Error('播放页里没有弹幕 iframe（站点结构可能变了）')

    ctx.onProgress?.({ step: 3, total: 4, label: '正在截获 E站弹幕签名…' })
    const dataUrl = await captureRequestUrl(iframeUrl, {
      match: /\/index\/getData\.html\?/i,
      referer: `${BASE}/`,
      label: 'E站弹幕'
    })
    if (!dataUrl) throw new Error('没能截获弹幕请求（iframe 未加载出播放器）')

    ctx.onProgress?.({ step: 3, total: 4, label: '正在下载 E站弹幕…' })
    const xml = await getText(dataUrl, 'https://player.ezdmw.com/')
    const comments = parseXml(xml)
    if (comments.length === 0) {
      log.append('warn', 'danmaku', `E站弹幕解析出 0 条（XML ${xml.length} 字节）`)
    }
    return {
      comments,
      detail: `《${entry.title}》第 ${episode} 集（videoId=${videoId}）`,
      entryName: entry.title,
      keyword: entry.keyword,
      episodeTitle: target?.title ?? `第 ${episode} 集`
    }
  }
}

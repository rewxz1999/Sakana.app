import type { DanmakuComment } from '@shared/types'
import { chromiumGetText } from '../../net'
import { log } from '../../log'
import type { DanmakuFetcher, FetcherContext, FetcherEntry, FetcherEpisodeResult } from './types'

/**
 * Tucao（吐槽弹幕网）弹幕获取器。
 *
 * ## 为什么必须走 Chromium 会话
 * 实测：裸 axios（带 UA/Referer）请求 Tucao 的搜索页只拿到 15KB 残缺页，连 `class="list"` 都没有；
 * 而用应用内 Chromium 会话（会保存 Cookie、路径与用户手动打开浏览器一致）能拿到 32KB 完整页。
 * 弹幕接口 `mukio` 同理 —— 裸 curl 直接 HTTP 000，只有浏览器会话能过。
 *
 * ## 接口（来自站点自己的 danmaku.js）
 *   apiurl = options.api.address + '?m=mukio&c=index&a=init&playerID=' + options.api.id
 * 其中 `playerID` 的格式实测为 `<站点id>-<mid>-<季>-<集序号>`，例如 `11-4107864-1-0`（集从 0 开始）；
 * 返回值被站点当成弹幕数组用（`dan = [].concat(...).sort((a,b)=>a.time-b.time)`）。
 *
 * ## 播放页地址
 *   https://www.tucao.my/play/<mid>/      例：/play/h4107864/
 *   集数列表在 `<ul id="player_code"><li>…|01**…|02</li></ul>`（** 分隔），
 *   也就是我们给规则引擎加的 `episodesSplit` 那种结构。
 */

const BASE = 'https://www.tucao.my'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 站点内页一律走浏览器会话（裸请求会被降级成残缺页） */
function fetchPage(url: string): Promise<string> {
  return chromiumGetText(url, 25_000, {
    'User-Agent': UA,
    Referer: `${BASE}/`,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  })
}

interface PlayRef {
  /** 播放页里的 mid（h4107864 → 4107864） */
  mid: string
  /** 站点 id（playerID 第一段，实测固定 11） */
  siteId: string
  title: string
  /** 集数（从 player_code 的 ** 串里数出来） */
  episodes: number
}

/**
 * 从播放页 HTML 里取出 mid / 站点 id / 集数。
 *
 * mid 的两种来源：URL 里的 `/play/<slug>/`（slug 形如 h4107864 或 d7095）优先，
 * 其次是 `<ul id="player_code" mid="4107864_">` 的属性（更可靠，但我们不一定拿得到完整页）。
 */
function parsePlayPage(html: string, fallbackMid: string, title: string): PlayRef {
  const midAttr = html.match(/id="player_code"[^>]*\s(?:mid|data-mid)="(\d+)/i)
  const urlMid = html.match(/playerID=(\d+)-(\d+)-/i)
  const rawMid = midAttr?.[1] ?? urlMid?.[2] ?? fallbackMid.replace(/^[a-z]+/i, '')
  const siteId = urlMid?.[1] ?? '11'
  // 集数：player_code 里那串 `...mp4|01**...mp4|02` 的段数
  const blob = html.match(/id="player_code"[^>]*>([\s\S]*?)<\/ul>/i)?.[1] ?? ''
  const episodes = Math.max(1, (blob.match(/\|/g) ?? []).length)
  return { mid: rawMid, siteId, title, episodes }
}

async function searchTucao(keyword: string): Promise<PlayRef[]> {
  const url = `${BASE}/index.php?m=content&c=search&a=init&dosubmit=1&k=${encodeURIComponent(keyword)}`
  const html = await fetchPage(url)
  /*
   * 结果结构（实测）：
   *   <div class="list"><div class="item"><div class="b">
   *     <a href="/play/h4107864/" class="t">【10月】脑洞学生会/学生会也有洞！【ANi】</a>
   * 用正则而不是 XPath：这里只需要"链接 + 标题"，正则对残缺 HTML 更宽容
   * （XPath 那条路对 Tucao 的整页解析会建出空树，规则引擎里已经为此加了 body 兜底）。
   */
  const out: PlayRef[] = []
  const re = /<a[^>]+href="\/play\/([a-z0-9]+)\/"[^>]*class="t"[^>]*>([^<]{1,120})</gi
  for (const m of html.matchAll(re)) {
    const slug = m[1]
    const title = m[2].replace(/&amp;/g, '&').trim()
    if (!out.some((x) => x.mid === slug.replace(/^[a-z]+/i, ''))) {
      out.push({ mid: slug.replace(/^[a-z]+/i, ''), siteId: '11', title, episodes: 0 })
    }
  }
  return out
}

/** 数出某一部番的集数（进播放页看 player_code） */
async function episodesOf(mid: string, title: string): Promise<PlayRef> {
  try {
    const html = await fetchPage(`${BASE}/play/${mid}/`)
    return parsePlayPage(html, mid, title)
  } catch {
    return { mid, siteId: '11', title, episodes: 1 }
  }
}

function toComment(raw: unknown): DanmakuComment | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const text = String(r.message ?? r.text ?? r.content ?? '').trim()
  if (!text) return null
  const time = Number(r.time ?? r.t ?? 0)
  if (!Number.isFinite(time) || time < 0) return null
  const colorRaw = String(r.color ?? '#ffffff').trim()
  const color = /^#[0-9a-f]{6}$/i.test(colorRaw) ? colorRaw : `#${colorRaw.replace(/^#/, '')}`
  const typeNum = Number(r.type ?? 1)
  // 站点用 1=滚动 2=顶部 3=底部（见 danmaku.js 的 send()），与我们 1/5/4 的编码对齐
  const mode = typeNum === 2 ? 5 : typeNum === 3 ? 4 : 1
  return { time, text, mode, color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff', size: 25 }
}

export const tucaoFetcher: DanmakuFetcher = {
  id: 'tucao',
  name: 'Tucao',
  kind: 'api',

  async search(keyword: string, _ctx: FetcherContext): Promise<FetcherEntry[]> {
    const hits = await searchTucao(keyword)
    const out: FetcherEntry[] = []
    for (const hit of hits.slice(0, 3)) {
      const full = await episodesOf(hit.mid, hit.title)
      out.push({
        id: full.mid,
        title: full.title,
        extra: `${full.episodes} 集`,
        keyword,
        episodes: Array.from({ length: full.episodes }, (_, i) => ({
          id: `${full.siteId}-${full.mid}-1-${i}`,
          index: i + 1,
          title: `第 ${i + 1} 集`
        })),
        raw: full
      })
    }
    return out
  },

  async fetchEpisode(entry: FetcherEntry, episode: number, ctx: FetcherContext): Promise<FetcherEpisodeResult> {
    const ref = (entry.raw ?? {}) as PlayRef
    const siteId = ref.siteId ?? '11'
    const mid = ref.mid ?? entry.id
    // playerID 里集序号是 0 基（实测 `11-4107864-1-0` 就是第 1 集）
    const playerID = `${siteId}-${mid}-1-${Math.max(0, episode - 1)}`
    const url = `${BASE}/index.php?m=mukio&c=index&a=init&playerID=${playerID}`
    ctx.onProgress?.({ step: 3, total: 4, label: `正在从 Tucao 取第 ${episode} 集弹幕…` })
    const text = await fetchPage(url)
    let rows: unknown[] = []
    try {
      const json = JSON.parse(text) as { data?: unknown[] } | unknown[]
      rows = Array.isArray(json) ? json : (json.data ?? [])
    } catch {
      // 不是 JSON：把开头打出来（排障用；不含完整地址，避免违反日志红线）
      log.append('warn', 'danmaku', `Tucao 弹幕返回的不是 JSON（前 60 字：${text.slice(0, 60).replace(/\s+/g, ' ')}）`)
    }
    const comments: DanmakuComment[] = []
    for (const r of rows) {
      const c = toComment(r)
      if (c) comments.push(c)
    }
    comments.sort((a, b) => a.time - b.time)
    return {
      comments,
      detail: `《${entry.title}》第 ${episode} 集（playerID=${playerID}）`,
      entryName: entry.title,
      keyword: entry.keyword,
      episodeTitle: `第 ${episode} 集`
    }
  }
}

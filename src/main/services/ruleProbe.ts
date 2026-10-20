import { BrowserWindow, session } from 'electron'
import { addProbeListeners } from './probeEvents'
import { noteCapturedStream } from './playerInfo'
import axios from 'axios'
import { CH } from '@shared/channels'
import { ONLINE_PLAY_TIMEOUT_MS } from '@shared/onlinePlay'
import { log } from '../log'
import { BROWSER_UA, httpGetText } from '../net'
import {
  browserLikeHeaders,
  freshConnectionAgents,
  sameSiteRedirectUpgrade,
  upgradeSameSite,
  withNetRetry
} from './rules'
import { beginStage, flowDetail, pushStep, succeedStage } from './playFlow'
import { offerHandoffCandidate } from './playHandoff'

/**
 * 播放页流嗅探（Kazumi 同思路）：隐藏窗口加载播放页，
 * 通过 webRequest 捕获视频流地址（m3u8/mp4/flv 等），交给 libVLC 直连播放。
 * 用户全程不看到网页。
 *
 * 另外：大量站点（MacCMS 系）把真实播放地址写在播放页 HTML 的 `player_aaaa.url` 里
 * 并做了一次百分号编码，播放器由 JS 解密后再请求，因此“只看网络请求”会一无所获。
 * 这里先直接抓取页面 HTML 提取真实地址，命中即用；未命中再走窗口嗅探兜底。
 */

/** 本模块属于「获取播放资源」阶段：所有过程记录都写进这个阶段（见 playFlow 的三阶段模型） */
const STAGE = 'acquire' as const

const PARTITION = 'rule-probe'
export const MEDIA_EXT_RE = /\.(m3u8|mp4|flv|mkv|webm|ts|m4s|mov)(\?|$)/i

/**
 * HEAD 预筛的超时故意**短**（v0.3.9 明确保留）：
 *
 * 它不参与「成功/失败」的判定 —— 只是给多个候选**并行**排个序，
 * 任何一个没在 6 秒内回答就交给后面的完整校验（`resolvePlayable`，按 60 秒口径）。
 * 把它也拉长到 60 秒的话，`Promise.all` 会被最慢的那个候选拖住，
 * 「抓到候选 → 交给播放器」这段本来几百毫秒的路会被拖成分钟级。
 */
const HEAD_PROBE_TIMEOUT_MS = 6_000

/**
 * 「疑似广告短片」判定的超时同样保持短（v0.3.9 明确保留）。
 *
 * 它是**启发式预筛**，不是失败判据：最坏情况是候选晚几秒才上报给播放器，
 * 绝不会让它判失败。拉长到 60 秒反而会把「抓到真流」这件事一起拖慢。
 */
const AD_CLIP_PROBE_TIMEOUT_MS = 8_000

/**
 * 这个 URL 该不该被当成「视频流候选」（v0.3.5）。
 *
 * 起因是一次真实的误捕（用户报「AGE 一直卡在加载播放流，却已经能听到声音」）：
 *   · 开发态渲染层是从 Vite 开发服务器（`http://localhost:5173/…`）加载的，
 *     它的源码模块后缀正是 **`.ts`**；
 *   · 而 `MEDIA_EXT_RE` 里的 `ts` 指的是 MPEG-TS 视频分片，两者撞在一起；
 *   · 嗅探窗口一开，渲染层自己的 `src/stores/library.ts` 等模块就先被
 *     `onBeforeRequest` 当成媒体流上报（日志：「捕获媒体流(media): http://localhost:5173/src/stores/library.ts」）；
 *   · 渲染层只接受第一个候选（见 PlayerPage 的 onFound），于是**真流地址永远被挡在门外**，
 *     mpv 拿到的是一个 JS 模块，界面停在加载态。
 *
 * 判据只针对「本机开发服务器 / 打包产物的 JS 模块」，不会误伤真实流：
 * - 只处理 `localhost`/`127.0.0.1`/`[::1]` 上的 http(s) 请求；
 * - 路径里出现 `/src/`、`/@vite/`、`/@fs/`、`/node_modules/`、`/assets/` 或
 *   以 `.ts`/`.tsx`/`.js`/`.mjs`/`.css`/`.map` 结尾 → 一律不算流。
 * 应用自己的 `127.0.0.1:<随机端口>/live/…`（FFmpeg 中转）与
 * `127.0.0.1:<随机端口>/adfilter/…/index.m3u8`（HLS 广告过滤）都不匹配上述路径特征，仍然照常可用。
 */
export function isDevServerAsset(rawUrl: string): boolean {
  const u = String(rawUrl ?? '')
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(u)) return false
  let path = ''
  try {
    path = new URL(u).pathname
  } catch {
    return false
  }
  if (/\/(src|@vite|@fs|node_modules|assets)\//i.test(path)) return true
  return /\.(ts|tsx|js|mjs|mts|cts|jsx|css|map)$/i.test(path)
}

/**
 * 是否是「看起来像媒体、但扩展名被伪装过」的地址（V1.4）。
 *
 * 真机证据（E站/ezdmw）：视频播放列表的真实地址是
 *   `https://player.ezdmw.com/index/listres/resource_name/<nk>/key/…/sign/<hash>.webp?…`
 * 扩展名写的是 **.webp**（图片），内容其实是 **HLS 播放列表（#EXTM3U）**。
 * 只看扩展名的嗅探器永远抓不到它 —— 这就是 ezdmw 四部番"0 候选"的真正原因。
 * 这里只负责"值得进一步验证"的猜测，真正的判定交给 `verifyM3u8ByContent`。
 */
export function looksLikeDisguisedPlaylist(rawUrl: string): boolean {
  try {
    const u = new URL(String(rawUrl ?? ''))
    const p = u.pathname.toLowerCase()
    if (/\.(m3u8|mpd)$/.test(p)) return true
    // 站点常用的伪装形态：listres/、hls/、playlist/ 路径，或图片扩展名 + 签名查询串
    if (/\/(listres|hls|playlist|m3u8)\//.test(p)) return true
    if (/\.(webp|jpg|jpeg|png|gif)$/.test(p) && /(sign|key|token|expire)=/i.test(u.search)) return true
    return false
  } catch {
    return false
  }
}

/**
 * 用**内容**判断是否播放列表（取前 64 字节看 `#EXTM3U` / `<MPD`）。
 *
 * 为什么不看 Content-Type：这类站点常常把 m3u8 以 `image/webp` 返回，头不可信，只有正文可信。
 * 失败一律返回 null（"判断不了"），调用方据此决定要不要继续等，不会误杀。
 */
export async function verifyM3u8ByContent(rawUrl: string): Promise<'m3u8' | 'dash' | null> {
  try {
    const res = await axios.get(String(rawUrl), {
      timeout: 6000,
      responseType: 'text',
      headers: { Range: 'bytes=0-63' },
      validateStatus: () => true
    })
    const head = String(res.data ?? '').slice(0, 200)
    if (head.includes('#EXTM3U')) return 'm3u8'
    if (head.includes('<MPD')) return 'dash'
    return null
  } catch {
    return null
  }
}

/** 媒体流候选的统一过滤器：调用方在任何上报点都先过这一层 */
export function isStreamCandidate(rawUrl: string): boolean {
  return !isDevServerAsset(rawUrl)
}

/**
 * 媒体扩展名必须出现在**路径**里，而不是查询串里（V1.4 修）。
 *
 * 真机踩到的坑：E站（ezdmw）的弹幕 iframe 地址是
 *   `https://player.ezdmw.com/danmuku/?nk=…&type=1&owner_qid=0&name=…&…=.ts…`
 * 扩展名藏在 query 里，于是 `MEDIA_EXT_RE`（正则不区分路径/查询）把它当成视频候选上报，
 * 界面上就会出现「1 个资源」，点进去必然失败 —— 假阳性比没有更糟。
 * 判定只看 `pathname`：真正媒体流的 `.m3u8/.mp4/.ts` 永远在路径上。
 */
export function hasMediaExtensionInPath(rawUrl: string): boolean {
  try {
    const p = new URL(String(rawUrl ?? '')).pathname
    return MEDIA_EXT_RE.test(p)
  } catch {
    return false
  }
}

/**
 * 是否是「播放器/弹幕页」而不是媒体流（V1.4）。
 *
 * E站的播放窗口是外站 iframe（`player.ezdmw.com/danmuku/`），它本身是个 HTML 页面；
 * 只要路径里带这些片段且**路径里没有媒体扩展名**，就一律不算候选。
 */
export function isPlayerOrDanmakuPage(rawUrl: string): boolean {
  if (hasMediaExtensionInPath(rawUrl)) return false
  try {
    const p = new URL(String(rawUrl ?? '')).pathname.toLowerCase()
    return /\/(danmuku|danmaku)(\/|$)/.test(p) || /\/danmu[^/]*\//.test(p)
  } catch {
    return false
  }
}

/** 只解码外层混淆（解码到成为 http(s) 地址为止），保留路径内的百分号编码 */
function decodeOuter(s: string): string {
  let out = String(s ?? '').replace(/\\\//g, '/')
  for (let i = 0; i < 3; i++) {
    if (/^https?:\/\//i.test(out)) return out
    try {
      const d = decodeURIComponent(out)
      if (d === out) return out
      out = d
    } catch {
      return out
    }
  }
  return out
}

/**
 * MacCMS `player_aaaa` 的 `encrypt` 解码。
 *
 * 实测（樱之空等 MacCMS V10 站点）：`encrypt:2` 时 `url` 是
 * **base64(百分号编码)** 双层编码，站点 player.js 里的算法就是
 * `unescape(base64decode(url))`；`encrypt:1` 只有百分号编码；其它为明文。
 * 过去这里不做 base64 解码，导致这类站点的直出地址恒为 null，
 * 只能依赖网页播放器（而 /player/ 对非浏览器请求常常 408），表现为「抓不到视频流」。
 */
function decodeMacPlayerUrl(raw: string, encrypt: unknown): string {
  let out = String(raw ?? '').replace(/\\\//g, '/')
  const mode = Number(encrypt ?? 0)
  if (mode === 2) {
    try {
      // 先按 base64 解码（站点用的是 unescape 的输入，即百分号编码串）
      const decoded = Buffer.from(out, 'base64').toString('utf8')
      if (decoded && /^%|^https?:\/\//i.test(decoded)) out = decoded
    } catch {
      /* 不是 base64 就按原文继续 */
    }
  }
  // 再解开百分号编码（encrypt 1/2 都需要）
  for (let i = 0; i < 3; i++) {
    if (/^https?:\/\//i.test(out)) break
    try {
      const d = decodeURIComponent(out)
      if (d === out) break
      out = d
    } catch {
      break
    }
  }
  return out.replace(/\\\//g, '/')
}

/** 从播放页 HTML 中提取真实媒体地址（MacCMS player_aaaa / 常见播放器字段 / 直链） */
/**
 * 收集播放页 HTML 里的**全部**候选媒体地址（按优先级去重）。
 *
 * v0.2.7 附加：过去 `findMediaUrl` 是「命中第一个就返回」——
 * 实测 aafun（moonci）播放页里第一个候选是个已失效的 mp4（HEAD 400），
 * 真正能播的地址排在后面，于是白等两轮校验。
 * 现在把所有候选都收出来（MacCMS 的 `url`/`url_next` → 播放器配置字段 → 页面里的裸直链），
 * 交给 `resolveFirstPlayable` **并行探测**，谁先确认可播就用谁。
 */
export function findMediaUrls(html: string): string[] {
  const text = String(html ?? '')
  const out: string[] = []
  const push = (u: string): void => {
    if (!u || !/^https?:\/\//i.test(u)) return
    if (!out.includes(u)) out.push(u)
  }
  // 1) MacCMS 标准：player_aaaa = {... "url":"%68%74%74%70…" …}
  const pa = text.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;)/)
  if (pa) {
    try {
      const obj = JSON.parse(pa[1]) as { url?: string; url_next?: string; encrypt?: unknown }
      const u = decodeMacPlayerUrl(obj?.url ?? '', obj?.encrypt)
      if (MEDIA_EXT_RE.test(u)) push(u)
      const next = decodeMacPlayerUrl(obj?.url_next ?? '', obj?.encrypt)
      if (MEDIA_EXT_RE.test(next)) push(next)
    } catch {
      const m = pa[1].match(/"url"\s*:\s*"([^"]+)"/)
      const enc = pa[1].match(/"encrypt"\s*:\s*(\d+)/)
      if (m) {
        const u = decodeMacPlayerUrl(m[1], enc ? Number(enc[1]) : 0)
        if (MEDIA_EXT_RE.test(u)) push(u)
      }
    }
  }
  // 2) 常见播放器配置字段
  const fieldRe = [
    /"url"\s*:\s*"([^"]+)"/g,
    /"video"\s*:\s*"([^"]+)"/g,
    /"source"\s*:\s*"([^"]+)"/g,
    /(?:source|file|src|videoUrl)\s*[:=]\s*['"]([^'"]+)['"]/g
  ]
  for (const re of fieldRe) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const u = decodeOuter(m[1])
      if (MEDIA_EXT_RE.test(u)) push(u)
    }
  }
  // 3) HTML/JS 中直接出现的媒体直链
  const direct = text.match(
    /https?:\\?\/\\?\/[^"'\s\\<>]+\.(?:m3u8|mp4|flv|mkv|webm)(?:\?[^"'\s\\<>]*)?/gi
  )
  if (direct) for (const d of direct) push(decodeOuter(d))
  return out
}

export function findMediaUrl(html: string): string | null {
  return findMediaUrls(html)[0] ?? null
}

/**
 * 播放页直出解析的**单次尝试**超时（v1.7）。
 *
 * 总预算仍是 @shared/onlinePlay 的 60 秒，但把它切成「最多 3 次 × 20 秒」，理由是真机日志：
 * 失败几乎全是 `timeout of 60000ms exceeded`，而 AGE 这类站点的播放页正常 **0.5~2 秒**就回来。
 * 20 秒还没回只有两种可能 ——
 *   ① 连接被中间设备掐住（黑洞）：等满 60 秒也是白等，换条连接重发才有用；
 *   ② 站点限流：直接 RST，几十毫秒就失败。
 * 所以 60 秒不再是一次干等，而是三次机会；单次失败的成本也从 60 秒降到 20 秒，
 * 后面的窗口嗅探不用再陪着一起等。
 */
const DIRECT_ATTEMPT_TIMEOUT_MS = 20_000

/** 抓取播放页 HTML 并提取**全部**候选媒体地址（空数组则交给窗口嗅探兜底） */
export async function extractStreamCandidates(url: string, referer?: string): Promise<string[]> {
  /*
   * 同站 http→https（v1.7）。
   * AGE 的搜索/详情页里给的播放链接本身就是 `http://www.agedm.io/play/...`，
   * 而它的 :80 是黑洞（实测直连 21 秒都不回，足够把 60 秒预算耗光）。
   * 这一步在**发请求之前**就把协议换掉，比等 301 再补救可靠（301 也可能指向 http）。
   */
  const target = upgradeSameSite(url, referer)
  try {
    let origin = ''
    try {
      origin = new URL(target).origin + '/'
    } catch {
      origin = target
    }
    const html = await withNetRetry('播放页直出解析', async (fresh) => {
      const res = await axios.get<string>(target, {
        timeout: DIRECT_ATTEMPT_TIMEOUT_MS,
        maxRedirects: 5,
        // 跳转目标同样可能是 http:80 → 同站时升级（与规则引擎同一个钩子）
        beforeRedirect: sameSiteRedirectUpgrade(target),
        responseType: 'text',
        headers: {
          ...browserLikeHeaders(target),
          'User-Agent': BROWSER_UA,
          Referer: referer || origin,
          // 重试时不要复用可能已被站点掐掉的 keep-alive 连接
          ...(fresh ? { Connection: 'close' } : {})
        },
        ...(fresh ? freshConnectionAgents() : {})
      })
      return String(res.data ?? '')
    })
    const list = findMediaUrls(html)
    if (list.length > 0) {
      log.append('info', 'rule-probe', `播放页直出候选 ${list.length} 个，首选: ${list[0].slice(0, 110)}`)
      flowDetail(STAGE, `播放页直出候选 ${list.length} 个，第一个直接交给播放器`)
      pushStep(STAGE, `播放页直出候选 ${list.length} 个`)
    } else {
      flowDetail(STAGE, '播放页里没有直出地址，继续等页面播放器发请求')
      pushStep(STAGE, '播放页 HTML 无直出地址')
    }
    return list
  } catch (err) {
    const text = String((err as { message?: string })?.message ?? err)
    log.append('warn', 'rule-probe', `播放页直出解析失败: ${text}`)
    pushStep(STAGE, `播放页直出解析失败：${text.slice(0, 80)}`)
    return []
  }
}

/**
 * 播放页直出解析的**短缓存 + 同页去重**（v1.3 提速）。
 *
 * 为什么需要：同一次点击会先后有两处去抓同一个播放页 ——
 *   ① 预取（`prefetchStream`，为了让「选源」那一刻就可能直接命中）；
 *   ② 网页嗅探窗口自己的直出解析（它和页面加载并行跑）。
 * 两处各发一次 GET，等于把站点打两遍；预取已经拿到「没有直出地址」的结论时，
 * 第二遍纯属白拉一个几十 KB 的 HTML。缓存 8 秒足够覆盖这一轮，
 * 又短到不会把「站点刚改版」这种变化藏起来。
 */
const EXTRACT_CACHE_TTL_MS = 8_000
const EXTRACT_CACHE_MAX = 60
const extractCache = new Map<string, { at: number; list: string[] }>()
/** 同一个播放页正在解析时，后来者等它（避免并发抓两次） */
const inflightExtract = new Map<string, Promise<string[]>>()

export async function extractStreamCandidatesCached(url: string, referer?: string): Promise<string[]> {
  const hit = extractCache.get(url)
  if (hit && Date.now() - hit.at < EXTRACT_CACHE_TTL_MS) return [...hit.list]
  const running = inflightExtract.get(url)
  if (running) return await running
  const task = extractStreamCandidates(url, referer)
    .then((list) => {
      extractCache.delete(url)
      extractCache.set(url, { at: Date.now(), list })
      while (extractCache.size > EXTRACT_CACHE_MAX) {
        const oldest = extractCache.keys().next().value as string | undefined
        if (!oldest) break
        extractCache.delete(oldest)
      }
      return list
    })
    .finally(() => {
      inflightExtract.delete(url)
    })
  inflightExtract.set(url, task)
  return await task
}

/** 清空直出解析缓存（自检/计时脚本用） */
export function clearExtractCache(): void {
  extractCache.clear()
  inflightExtract.clear()
}

/**
 * 给候选挑一个 Referer（v1.3 乐观交接的配套判定）。
 *
 * 为什么不再发 HEAD 去「试探哪种 Referer 能用」：那一次探测正是要省掉的等待。
 * 这里用一条实测足够可靠的启发式：
 *   · 候选与播放页**同站**（或子域）→ 带播放页地址（站点自己的播放器就是这么请求的）；
 *   · 候选在**另一个域**（典型是 CDN）→ **不带** Referer。
 *     历史日志里大量 CDN 会因跨域 Referer 直接 400（`rule-probe` 的旧注释也记着这一条），
 *     而不带 Referer 的请求它们都接受。
 * 判错的代价被「5 秒零字节换候选」兜住，不会像过去那样卡住整轮。
 */
export function refererForCandidate(candidate: string, pageUrl?: string): string | undefined {
  if (!pageUrl) return undefined
  try {
    const c = new URL(candidate)
    const p = new URL(pageUrl)
    const sameHost =
      c.hostname === p.hostname || c.hostname.endsWith(`.${p.hostname}`) || p.hostname.endsWith(`.${c.hostname}`)
    // 空串 = 「经判定不能带 Referer」，与播放页侧的既有语义一致
    return sameHost ? pageUrl : ''
  } catch {
    return undefined
  }
}

/** 兼容旧调用：只取第一个候选 */
export async function extractStreamFromHtml(url: string, referer?: string): Promise<string | null> {
  return (await extractStreamCandidatesCached(url, referer))[0] ?? null
}

const PLAYABLE_MIME_RE = /^(video\/|audio\/|application\/(octet-stream|vnd\.apple\.mpegurl|mp2t|x-mpegurl|dash\+xml))/i

/**
 * 把 URL 规范成 VLC 能正确解析的形式：
 * 部分 CDN 的签名参数里带未转义的 '/'、'+'、'='，浏览器能容忍，
 * 但 libVLC 的 URL 解析会走偏（表现为拿到地址却一直不播放）。
 */
export function encodeForVlc(url: string): string {
  try {
    const u = new URL(url)
    const parts: string[] = []
    u.searchParams.forEach((v, k) => {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    })
    // searchParams 会把 '+' 解析成空格，这里用原始串重建更安全
    if (u.search && parts.length === 0) {
      const raw = u.search.slice(1).replace(/%(?![0-9a-fA-F]{2})/g, '%25')
      u.search = '?' + raw
    } else if (u.search) {
      const rawPairs = u.search
        .slice(1)
        .split('&')
        .map((pair) => {
          const idx = pair.indexOf('=')
          if (idx < 0) return encodeURIComponent(pair)
          const k = pair.slice(0, idx)
          let v = pair.slice(idx + 1)
          // 已转义的保持原样，其余保留字符统一转义
          v = v.replace(/%(?![0-9a-fA-F]{2})/g, '%25').replace(/[+/=]/g, (m) => {
            if (m === '+') return '%2B'
            if (m === '/') return '%2F'
            return '%3D'
          })
          return `${k}=${v}`
        })
        .join('&')
      u.search = '?' + rawPairs
    }
    return u.toString()
  } catch {
    return url
  }
}

/**
 * 校验直出地址是否真的可播：
 * 这类 CDN 常返回 302 跳转，跳转目标又可能 400/HTML 错误页——
 * 直接把原始地址交给 VLC 就会被当成「空播放列表」。
 * 优先用 HEAD 探测（避免消耗一次性下载令牌），必要时才回退 Range GET。
 */
export async function resolvePlayable(
  url: string,
  referer?: string
): Promise<{ url: string; referer?: string } | null> {
  const attempts: (string | undefined)[] = referer ? [referer, undefined] : [undefined]
  for (const ref of attempts) {
    const baseHeaders: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      ...(ref ? { Referer: ref } : {})
    }
    // 1) HEAD 探测（不消耗下载令牌）
    try {
      const head = await axios.head(url, {
        // v0.3.9：与在线播放链路口径统一为 60 秒（此前 12 秒）
        timeout: ONLINE_PLAY_TIMEOUT_MS,
        maxRedirects: 6,
        validateStatus: () => true,
        headers: baseHeaders
      })
      const mime = String(head.headers['content-type'] ?? '')
      const status = head.status
      const finalUrl = String((head.request as { res?: { responseUrl?: string } })?.res?.responseUrl ?? url)
      if (status >= 200 && status < 400 && PLAYABLE_MIME_RE.test(mime)) {
        log.append('info', 'rule-probe', `直出地址校验通过(HEAD ${mime.split(';')[0]} ${status})`)
        return { url: encodeForVlc(finalUrl), referer: ref }
      }
      log.append('warn', 'rule-probe', `HEAD 校验未通过(${status} ${mime.split(';')[0] || 'unknown'})`)
    } catch (err) {
      log.append('warn', 'rule-probe', `HEAD 校验异常: ${String((err as { message?: string })?.message ?? err)}`)
    }
    // 2) 回退：Range GET（有些 CDN 不支持 HEAD）
    try {
      const res = await axios.get(url, {
        // v0.3.9：与在线播放链路口径统一为 60 秒（此前 12 秒）
        timeout: ONLINE_PLAY_TIMEOUT_MS,
        maxRedirects: 6,
        responseType: 'arraybuffer',
        decompress: true,
        validateStatus: () => true,
        headers: { ...baseHeaders, Range: 'bytes=0-2047' }
      })
      const mime = String(res.headers['content-type'] ?? '')
      const status = res.status
      const finalUrl = String((res.request as { res?: { responseUrl?: string } })?.res?.responseUrl ?? url)
      if (status >= 200 && status < 400 && PLAYABLE_MIME_RE.test(mime)) {
        log.append('info', 'rule-probe', `直出地址校验通过(${mime.split(';')[0]} ${status})`)
        return { url: encodeForVlc(finalUrl), referer: ref }
      }
      log.append(
        'warn',
        'rule-probe',
        `直出地址不可播(${status} ${mime.split(';')[0] || 'unknown'}${ref ? ' 带 Referer' : ''}): ${finalUrl.slice(0, 110)}`
      )
    } catch (err) {
      log.append('warn', 'rule-probe', `直出地址校验失败: ${String((err as { message?: string })?.message ?? err)}`)
    }
  }
  return null
}

/** 只发 HEAD 的轻量探测：不消耗一次性下载令牌，用来给多个候选**并行**排序 */
async function headProbeOnce(url: string, referer?: string): Promise<{ url: string; referer?: string } | null> {
  try {
    const head = await axios.head(url, {
      // 预筛用，故意短（见 HEAD_PROBE_TIMEOUT_MS 的说明）：超时了就交给完整校验
      timeout: HEAD_PROBE_TIMEOUT_MS,
      maxRedirects: 6,
      validateStatus: () => true,
      headers: { 'User-Agent': BROWSER_UA, ...(referer ? { Referer: referer } : {}) }
    })
    const mime = String(head.headers['content-type'] ?? '')
    if (head.status >= 200 && head.status < 400 && PLAYABLE_MIME_RE.test(mime)) {
      const finalUrl = String((head.request as { res?: { responseUrl?: string } })?.res?.responseUrl ?? url)
      return { url: encodeForVlc(finalUrl), referer }
    }
  } catch {
    /* 交给完整校验兜底 */
  }
  return null
}

/**
 * 从多个候选里挑出第一个真正可播的地址（v0.2.7 附加）。
 *
 * 做法：先对所有候选**并行发 HEAD**（便宜且不消耗令牌），
 * 按优先级取第一个通过的；若一个都没通过，再按优先级逐个做完整校验（HEAD+Range GET）。
 * 这样既不会因为「第一个候选已失效」而白等，也保留了「某些 CDN 不支持 HEAD」的兜底。
 */
export async function resolveFirstPlayable(
  candidates: string[],
  referer?: string,
  /**
   * 整步预算（v0.3.9）。
   *
   * 为什么不是「每个候选各等 60 秒」：`resolvePlayable` 现在单次就允许 60 秒，
   * 而候选最多 6 个 —— 逐个串起来最坏是 12 分钟，那是用户绝对不能接受的。
   * 「60 秒」在工单里的语义是**这一步的判定时间**，所以这里给整步一个 60 秒的截止时间：
   * 到点就返回 null，交给上层按「网站问题/格式不支持」出结论（上层还有可达性探测作为证据）。
   */
  budgetMs = ONLINE_PLAY_TIMEOUT_MS
): Promise<{ url: string; referer?: string } | null> {
  const list = candidates.slice(0, 6)
  if (list.length === 0) return null
  const deadline = Date.now() + budgetMs
  if (list.length > 1) {
    const probes = await Promise.all(list.map((u) => headProbeOnce(u, referer)))
    const idx = probes.findIndex((p) => p !== null)
    if (idx >= 0) {
      log.append('info', 'rule-probe', `并行探测命中第 ${idx + 1} 个候选`)
      flowDetail(STAGE, `直出地址校验通过（第 ${idx + 1} 个候选）`)
      return probes[idx]
    }
  }
  for (const u of list) {
    if (Date.now() >= deadline) {
      log.append('warn', 'rule-probe', `直出地址校验超出 ${Math.round(budgetMs / 1000)} 秒预算，停止串行重试`)
      pushStep(STAGE, `直出地址校验超时（${Math.round(budgetMs / 1000)}s 预算用尽）`)
      return null
    }
    const ok = await resolvePlayable(u, referer)
    if (ok) return ok
  }
  return null
}

/**
 * 是否是**一次性 / 超短时效**的下载直链（v0.2.7 附加）。
 *
 * 实测 aafun（moonci）的可用地址是 `tjdownload.pan.wo.cn/openapi/download?fid=…`：
 * 每次抓播放页都会生成一个**新的 fid**，而且这个令牌用过（甚至只是被校验过）就失效。
 * 对这类地址：预取与缓存不仅没意义，还会把令牌提前烧掉 ——
 * 实测「预取 7 秒后再用」必然是 0 秒不播，反而比不预取更慢。
 * 所以只缓存**可复用**的直链（普通 CDN 的 m3u8 / mp4），这些一律不缓存、不预取。
 */
export function isOneTimeStream(url: string): boolean {
  try {
    const u = new URL(url)
    if (/openapi\/download|downapi|\/download(\/|$)/i.test(u.pathname)) return true
    if (/[?&](fid|sign|expire|expires|token|e|st)=/i.test(u.search)) return true
    if (/(^|\.)pan\./i.test(u.hostname)) return true
    return false
  } catch {
    return false
  }
}

/**
 * 会话内的「播放页地址 → 媒体地址」缓存。
 *
 * 为什么有用：进入播放器、以及播放器里切集，最慢的一环都是「重新嗅探」。
 * 同一个播放页在短时间内（同一集来回切、A/B 比较、退出再进）拿到的地址通常仍然可用，
 * 缓存命中就能直接交给内核，省掉整轮嗅探。
 * 反代/CDN 的直链有时效（有的是**一次性令牌**），所以：
 * - TTL 只给 6 分钟；
 * - 播放器侧仍保留「N 秒没开播就重新嗅探」的看门狗 —— 缓存过期不会变成卡死，只是白等几秒。
 *
 * v1.3：条目里额外保存**同一播放页的其它候选**。命中缓存时把它们交给交接队列，
 * 于是缓存里那条地址万一失效，5 秒零字节就能换到下一条 —— 不必重开一整轮嗅探。
 */
interface StreamCacheEntry {
  url: string
  referer?: string
  at: number
  alternatives: { url: string; referer?: string }[]
}
const streamCache = new Map<string, StreamCacheEntry>()
const STREAM_CACHE_TTL = 6 * 60 * 1000

export function rememberStream(
  pageUrl: string,
  url: string,
  referer?: string,
  alternatives: { url: string; referer?: string }[] = []
): void {
  if (!pageUrl || !url) return
  // 一次性令牌类直链不缓存（缓存下来也已经失效，只会让下次切集白等一轮看门狗）
  if (isOneTimeStream(url)) return
  const rest = alternatives.filter((a) => a && a.url && a.url !== url).slice(0, 6)
  streamCache.set(pageUrl, { url, referer, at: Date.now(), alternatives: rest })
}

export function getCachedStream(pageUrl: string): { url: string; referer?: string } | null {
  const hit = streamCache.get(pageUrl)
  if (!hit) return null
  if (Date.now() - hit.at > STREAM_CACHE_TTL) {
    streamCache.delete(pageUrl)
    return null
  }
  return { url: hit.url, referer: hit.referer }
}

/**
 * 「当前要播的这条地址」在缓存里还带着哪些备选候选。
 *
 * 用途：播放页命中缓存直接开播时，把备选也放进交接队列 ——
 * 缓存地址过期/被限流时，内核 5 秒零字节就能切到下一条，而不是让用户等重嗅探。
 */
export function alternativesForStreamUrl(url: string): { url: string; referer?: string }[] {
  if (!url) return []
  for (const entry of streamCache.values()) {
    if (entry.url === url) return entry.alternatives.map((a) => ({ ...a }))
    if (entry.alternatives.some((a) => a.url === url)) {
      return [{ url: entry.url, referer: entry.referer }, ...entry.alternatives.filter((a) => a.url !== url)]
    }
  }
  return []
}

export function clearStreamCache(): void {
  streamCache.clear()
}

/**
 * 正在进行的预取（按播放页地址索引）。
 *
 * 用途：从番剧详情页点「选集」时我们会先发起预取再跳转播放页，
 * 播放页挂载后立刻来查缓存 —— 此时预取往往还在飞。
 * `getCachedStreamOrWait` 会**短暂等它一下**（默认 2.5 秒），
 * 命中就完全跳过「建嗅探窗口 → 加载播放页 → 等播放器发请求」这几步。
 */
const inflightPrefetch = new Map<string, Promise<{ url: string; referer?: string } | null>>()

/** 查缓存；若该地址正在预取则等它落地（超时返回 null，交给正常嗅探） */
export async function getCachedStreamOrWait(
  pageUrl: string,
  timeoutMs = 2500
): Promise<{ url: string; referer?: string } | null> {
  const hit = getCachedStream(pageUrl)
  if (hit) return hit
  const pending = inflightPrefetch.get(pageUrl)
  if (!pending) return null
  const raced = await Promise.race([
    pending,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ])
  return raced ?? getCachedStream(pageUrl)
}

/**
 * 预取某个播放页的直链（v0.2.7 附加：让切集更快；v1.3 改成**乐观交接**）。
 *
 * 只走**直出解析**这一条路（纯 HTTP，不创建浏览器窗口）。
 *
 * v1.3 的关键改动：**不再发 HEAD/Range 预校验**。
 * 过去的顺序是「解析出候选 → 并行 HEAD → 按优先级完整校验 → 才写缓存」，
 * 正常站点要多花 0.3~6 秒，慢 CDN 上更久，而它换来的只是「第一个候选可能是坏的」。
 * 现在第一个候选**立刻**写进缓存并交给播放器，坏候选由内核的「5 秒零字节换候选」兜住
 * （见 playHandoff 的说明）。全部候选都会进交接队列，所以换的时候不需要重新嗅探。
 */
export async function prefetchStream(
  pageUrl: string,
  referer?: string,
  /**
   * `handoff=true`：这次的候选就是**用户马上要播的那一集**，可以进交接队列
   * （5 秒零字节时才用得到）。预取下一集时必须传 false —— 否则当前这一集卡住 5 秒时，
   * 内核会被换到「下一集」的地址上（真实会发生的串台）。
   */
  opts: { handoff?: boolean } = {}
): Promise<{ url: string; referer?: string } | null> {
  const cached = getCachedStream(pageUrl)
  if (cached) return cached
  const running = inflightPrefetch.get(pageUrl)
  if (running) return await running
  const task = (async (): Promise<{ url: string; referer?: string } | null> => {
    const candidates = await extractStreamCandidatesCached(pageUrl, referer)
    if (candidates.length === 0) return null
    /*
     * 候选的 Referer 用启发式判定（同站带、跨域 CDN 不带），不再发 HEAD 试探 ——
     * 判错的代价被「5 秒零字节换候选」兜住（见 refererForCandidate 的说明）。
     */
    const alts = candidates.slice(0, 6).map((u) => ({ url: u, referer: refererForCandidate(u, pageUrl) }))
    if (opts.handoff === true) for (const a of alts) offerHandoffCandidate(a)
    const reusable = alts.filter((a) => !isOneTimeStream(a.url))
    if (reusable.length === 0) {
      /*
       * 一次性令牌类站点（如 pan.wo.cn 下载接口）不入缓存，但**首个候选照样直接交给播放器**：
       * 预取本身已经不再发任何试探请求，不存在「把令牌提前烧掉」的问题；
       * 不入缓存只是为了避免下次切集命中一条必然失效的地址。
       */
      log.append('info', 'rule-probe', '该站点为一次性直链：不入缓存，首个候选仍直接交给播放器')
      return { url: alts[0].url, referer: alts[0].referer }
    }
    const first = reusable[0]
    rememberStream(pageUrl, first.url, first.referer, reusable.slice(1))
    log.append(
      'info',
      'rule-probe',
      `预取完成（不做预校验，${alts.length} 个候选已入交接队列，首个直接交给播放器）: ${first.url.slice(0, 110)}`
    )
    return { url: first.url, referer: first.referer }
  })().finally(() => {
    inflightPrefetch.delete(pageUrl)
  })
  inflightPrefetch.set(pageUrl, task)
  return await task
}

let probeWin: BrowserWindow | null = null
let foundUrls: string[] = []
let doneSent = false
let probeActive = false
let timeoutTimer: NodeJS.Timeout | null = null

/** 自动点击脚本：播放页大多要"交互"才会加载播放器（见 runAutoPlayClicks 的说明） */
const AUTOPLAY_SCRIPT = `(() => {
    const tryPlay = () => {
      const videos = Array.from(document.querySelectorAll('video'))
      for (const v of videos) {
        try { v.muted = true; v.play && v.play() } catch (e) {}
      }
      const sels = ['#play','.play','.play-btn','.play-button','.vjs-big-play-button','.dplayer-play-icon','.artplayer-plugin-video-control','[class*="play" i]','[title*="播放"]','[aria-label*="播放"]']
      for (const sel of sels) {
        const el = document.querySelector(sel)
        if (el && el.click) { try { el.click() } catch (e) {} }
      }
      const iframes = Array.from(document.querySelectorAll('iframe'))
      for (const f of iframes) {
        try { f.contentWindow && f.contentWindow.postMessage('play', '*') } catch (e) {}
      }
    }
    let n = 0
    const t = setInterval(() => { n++; tryPlay(); if (n > 8) clearInterval(t) }, 1500)
    tryPlay()
  })()`

/**
 * 往一个窗口的所有子框架注入"自动点击播放"，再点一次页面里的 iframe 元素。
 *
 * 为什么单独抽出来（v0.3.7）：批量预嗅探（ruleProbeBatch）要开自己的窗口，
 * 它面对的是同一批站点、同一个"不点就不播"的问题。复制一份脚本出来
 * 迟早会出现"单规则探得到、批量探不到"这种最难查的差异，所以只有这一份。
 *
 * 为什么要点进每一个子框架：播放器常常在**跨域 iframe** 里，主框架的脚本够不着它。
 */
export function runAutoPlayClicks(win: BrowserWindow | null): void {
  const w = win
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return
  try {
    const frames = [w.webContents.mainFrame, ...w.webContents.mainFrame.framesInSubtree]
    for (const f of frames) {
      if (!f || f.isDestroyed()) continue
      void f.executeJavaScript(AUTOPLAY_SCRIPT, true).catch(() => undefined)
    }
    // 再直接点击页面里的 iframe 元素（部分站点靠父页点击才初始化播放器）
    void w.webContents
      .executeJavaScript(
        `Array.from(document.querySelectorAll('iframe')).forEach(f=>{try{f.click()}catch(e){}})`,
        true
      )
      .catch(() => undefined)
  } catch {
    /* 窗口正在销毁时会抛，忽略 */
  }
}


/** 自检钩子：主进程内直接观察嗅探事件（SAKANA_ONLINE_TEST 使用） */
let probeHook: ((payload: Record<string, unknown>) => void) | null = null
export function setProbeHook(cb: ((payload: Record<string, unknown>) => void) | null): void {
  probeHook = cb
}

/** 供 ruleWebview 等其它嗅探实现复用同一个自检钩子 */
export function notifyProbeHook(payload: Record<string, unknown>): void {
  try {
    probeHook?.(payload)
  } catch {
    /* ignore */
  }
}

function emit(win: BrowserWindow | null | undefined, payload: Record<string, unknown>): void {
  // win 可能已经随窗口销毁而失效（播放页所在的窗口先没了），
  // 此时若直接读 win.isDestroyed() 会抛 TypeError 并变成未处理的 Promise 拒绝
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(CH.evRuleProbe, payload)
  }
  try {
    probeHook?.(payload)
  } catch {
    /* ignore */
  }
  if (process.env.SAKANA_PROBE_TEST) {
    console.log(`[rule-probe] emit: ${JSON.stringify(payload).slice(0, 160)}`)
  }
}

/**
 * 「占位/广告命名」的媒体地址（v1.7）。
 *
 * 只认**路径里的独立词**，不碰正常文件名：
 *   命中：`/Play/adposter.mp4`、`/ads/pre.mp4`、`/ad/intro.mp4`、`/placeholder.mp4`
 *   不命中：`/video/adam.mp4`（adam 不是独立词）、`/player/movie.mp4`
 *
 * 为什么值得单独认：AGE 这类站的播放页交给第三方解析器，解析器初始化会先请求一段
 * `adposter.mp4` 当占位，而那个地址由解析器自己的机器提供，实测会 ECONNREFUSED。
 * 它一旦被乐观交接给内核，就是「15 秒零字节 → 注入失败」，整轮白等。
 */
const AD_PLACEHOLDER_RE = /(?:^|[\/_.-])(?:ad|ads|adv|adposter|advert|advertisement|placeholder|blank|spacer)(?:[\/_.-]|$)/i

function isAdPlaceholder(rawUrl: string): boolean {
  try {
    return AD_PLACEHOLDER_RE.test(new URL(rawUrl).pathname)
  } catch {
    return false
  }
}

/** 占位地址能不能打开（只对上面那类地址调用，所以超时给得短） */
const PLACEHOLDER_PROBE_TIMEOUT_MS = 2_500

async function adPlaceholderReachable(u: string): Promise<boolean> {
  try {
    const r = await axios.head(u, {
      timeout: PLACEHOLDER_PROBE_TIMEOUT_MS,
      maxRedirects: 4,
      validateStatus: () => true,
      headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' }
    })
    // 2xx/3xx 视为「真能取到」；405/403 这类站点可能不支持 HEAD，保守地当作可用（交给内核去试）
    if (r.status >= 400 && r.status !== 405 && r.status !== 403) return false
    return r.status < 500
  } catch {
    // 连接被拒/超时 → 明确不可用
    return false
  }
}

function pickBest(urls: string[], adClips?: Set<string>): string | null {
  /*
   * 收尾兜底：先把「已确认是占位/广告」的地址排到最后，再按类型挑。
   * 过去只要页面上先出现的是广告 mp4，收尾的 `pickBest` 就把它当选交出去 ——
   * 那正是「播放页卡在广告 src 上、永远不切真流」的一条成因。
   */
  const clean = adClips ? urls.filter((u) => !adClips.has(u)) : urls
  const pool = clean.length > 0 ? clean : urls
  // 优先 m3u8（HLS 主列表），其次 mp4/flv
  const m3u8 = pool.find((u) => /\.m3u8(\?|$)/i.test(u))
  if (m3u8) return m3u8
  const master = pool.find((u) => /master|index\.m3u8/i.test(u))
  if (master) return master
  return pool.find((u) => /\.(mp4|flv)(\?|$)/i.test(u)) ?? pool[0] ?? null
}

export function startRuleProbe(mainWin: BrowserWindow, url: string, referer?: string): boolean {
  stopRuleProbe()
  foundUrls = []
  doneSent = false
  probeActive = true
  beginStage(STAGE, '正在打开嗅探窗口（规则站点的隐藏网页）')
  pushStep(STAGE, `开始嗅探播放页：${url.slice(0, 90)}`)
  // 使用默认会话（自定义分区会话会导致页面加载 ERR_FAILED；probeActive 标志防止误报）
  const ses = session.defaultSession
  try {
    // 注意：show:false 的窗口会被页面视为不可见（document.hidden），
    // 多数站点因此不初始化播放器；改为屏幕外可见窗口，页面行为与正常浏览一致。
    probeWin = new BrowserWindow({
      show: true,
      x: -4000,
      y: 0,
      width: 1280,
      height: 720,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })
  } catch (err) {
    log.append('error', 'rule-probe', `隐藏窗口创建失败: ${String(err)}`)
    pushStep(STAGE, `嗅探窗口创建失败：${String(err).slice(0, 80)}`)
    return false
  }

  /*
   * 候选流的「疑似广告短片」判定（v0.3.7）。
   *
   * 为什么需要：有些站点（实测 gugu3 是 `player.gugu3.com/milimili.mp4`）的播放页会先请求一段
   * **几秒钟的广告/占位视频**，而 webRequest 嗅探是"谁先请求谁先被捕获" ——
   * 于是我们把这个广告短片当成片源交给了播放器，用户看到的就是"一进去就在放广告"
   * （用户报的"广告跳屏"里就有这一类）。
   *
   * 判据只做**保守**的两条，宁可放过也不误杀：
   *   · 非 HLS（整段 mp4/flv）：HEAD 一下看 Content-Length，小于 4MB 的当作疑似广告
   *     （正片动辄几十上百 MB，一集 24 分钟的 mp4 不可能只有几 MB）；
   *   · HLS：把列表拉下来把 #EXTINF 加起来，总时长小于 90 秒的当作疑似广告
   *     （正片播放列表的时长都是整集）。
   * 判定为"疑似"后**不移除**，只是不立刻上报：继续等真正的正片；
   * 若直到超时都只有疑似候选，收尾时仍会把它交出去（有广告看总比什么都放不出来强），
   * 日志里会写明"只抓到疑似广告短片"，用户与我们都还能看出发生了什么。
   */
  const AD_CLIP_MAX_BYTES = 4 * 1024 * 1024
  const AD_CLIP_MAX_SECONDS = 90
  const adClipUrls = new Set<string>()

  const looksLikeAdClip = async (u: string): Promise<boolean> => {
    try {
      if (/\.m3u8(\?|$)/i.test(u)) {
        const text = await httpGetText(u, AD_CLIP_PROBE_TIMEOUT_MS, {})
        if (!text.includes('#EXTM3U')) return false
        const durs = [...text.matchAll(/#EXTINF:\s*([\d.]+)/g)].map((m) => Number(m[1]) || 0)
        // 主列表（EXT-X-STREAM-INF）里没有 EXTINF，看不到真实时长 → 不判定
        if (durs.length === 0) return false
        const total = durs.reduce((n, d) => n + d, 0)
        return total > 0 && total < AD_CLIP_MAX_SECONDS
      }
      const head = await axios.head(u, {
        timeout: AD_CLIP_PROBE_TIMEOUT_MS,
        maxRedirects: 6,
        validateStatus: () => true,
        headers: { 'User-Agent': BROWSER_UA }
      })
      const len = Number(head.headers['content-length'] ?? 0)
      if (!Number.isFinite(len) || len <= 0) return false
      return len < AD_CLIP_MAX_BYTES
    } catch {
      // 探测失败一律按"不是广告"处理：不能因为一次 HEAD 失败就把真片源扔了
      return false
    }
  }

  /**
   * 捕获到一个候选 → 交给播放器（v1.3 乐观交接；v1.7 只对「占位/广告命名」的地址先验一次）。
   *
   * v1.3 的理由仍然成立：广告判定要「拉一遍 m3u8 / HEAD 一次 mp4」，最多 8 秒，
   * 挡在「抓到第一个媒体请求 → 交给内核」这条最短路上不划算，所以默认**不等**、
   * 先交给播放器，真流后到时由播放页的"后到候选顶掉前一个"逻辑兜住。
   *
   * v1.7 补的那一刀（AGE 真机链路的最后一环）：
   *   AGE 的播放页由第三方解析器接管，它初始化时先请求一段 `adposter.mp4` 当占位，
   *   而这个地址由解析器自己的服务器提供，实测会直接 ECONNREFUSED。
   *   乐观交接把它交给内核 → 内核 15 秒一个字节都收不到 → 整轮被判「注入失败」，
   *   真流即使随后到达也只能等下一轮。用户看到的就是「AGE 老是播放失败」。
   *   所以**只对**「路径里带 ad/ads/adposter/placeholder 这类命名」的候选先发一次 HEAD：
   *   真能打开就照旧先交给播放器（有画面总比没有强），打不开就不交，继续等真流。
   *   普通站点（URL 里没有这些词）一次额外请求都不会发，没有任何延迟代价。
   */
  const deliverCandidate = (u: string, channel: string): void => {
    log.append('info', 'rule-probe', `捕获媒体流: ${u.slice(0, 120)}`)
    pushStep(STAGE, `捕获媒体流（${channel}）：${u.slice(0, 70)}`)
    flowDetail(STAGE, `已捕获 ${foundUrls.length} 个候选，已直接交给播放器（1 字节未到时才换下一个）`)
    offerHandoffCandidate({ url: u })
    noteCapturedStream({
      url: u,
      kind: /\.m3u8(\?|$)/i.test(u) ? 'm3u8' : 'media',
      channel,
      capturedAt: Date.now()
    })
    // 拿到可用候选 = 「获取播放资源」阶段达成（后面交给播放器是 inject 阶段的事）
    succeedStage(STAGE, `已获取播放资源（${channel}）`)
    emit(mainWin, { type: 'found', url: u, kind: /\.m3u8(\?|$)/i.test(u) ? 'm3u8' : 'media' })
    void looksLikeAdClip(u).then((suspect) => {
      if (!probeActive || !suspect) return
      adClipUrls.add(u)
      log.append(
        'warn',
        'rule-probe',
        `疑似广告短片（已先交给播放器；真流到达后会自动顶掉）: ${u.slice(0, 110)}`
      )
      pushStep(STAGE, `疑似广告短片（已先播，等真流顶掉）：${u.slice(0, 60)}`)
    })
  }

  const captureCandidate = (u: string, channel: string): void => {
    if (!probeActive || foundUrls.includes(u)) return
    // 先进列表：收尾时 `pickBest` 才有兜底可交（收到 adClipUrls 里，兜底时会被排到后面）
    foundUrls.push(u)
    if (!isAdPlaceholder(u)) {
      deliverCandidate(u, channel)
      return
    }
    adClipUrls.add(u)
    void adPlaceholderReachable(u).then((ok) => {
      if (!probeActive) return
      if (ok) {
        deliverCandidate(u, channel)
        return
      }
      log.append(
        'warn',
        'rule-probe',
        `占位/广告地址打不开（连接被拒/超时），先不交给播放器，继续等真流: ${u.slice(0, 110)}`
      )
      pushStep(STAGE, `占位/广告地址不可达，继续等真流：${u.slice(0, 60)}`)
    })
  }

  // 嗅探会话结束：注销共享监听，避免与其它实现互相覆盖
  const onBeforeRequest = (details: { url: string; resourceType: string }): void => {
    if (!probeActive) return
    const u = details.url
    /*
     * 诊断开关（V1.4）：`SAKANA_PROBE_LOG_ALL=1` 时把探针窗口发出的所有请求打到日志。
     *
     * 用途：有些站点的媒体/弹幕接口藏在 JS 里（E站的弹幕池是
     * `player.ezdmw.com/danmuku/` 这个 iframe 内部的 XHR），抓包工具又会被站点的
     * 反调试挡住（devtools 一开就 about:blank）。我们自己的探针窗口没有 devtools 附加，
     * 站点不会自我清空，于是可以借它"代理一次 devtools"。
     */
    if (process.env.SAKANA_PROBE_LOG_ALL === '1') {
      log.append('info', 'probe', `REQ[${details.resourceType}] ${u.slice(0, 180)}`)
    }
    if (!isStreamCandidate(u)) return
    if (details.resourceType === 'media' || MEDIA_EXT_RE.test(u)) {
      captureCandidate(u, 'webRequest')
      return
    }
    /*
     * V1.4：扩展名被伪装成图片的播放列表（E站用 `.webp` 装 m3u8）。
     * 这里只做"可疑"的预判，真正判定要看到 `#EXTM3U` 才收 —— 避免把普通图片当成视频。
     */
    if (looksLikeDisguisedPlaylist(u)) {
      void verifyM3u8ByContent(u).then((kind) => {
        if (!probeActive) return
        if (kind) captureCandidate(u, kind === 'm3u8' ? 'm3u8(伪装扩展名)' : 'dash(伪装扩展名)')
      })
    }
  }
  const onCompleted = (details: { url: string; statusCode: number }): void => {
    if (!probeActive) return
    if (!isStreamCandidate(details.url)) return
    if (details.statusCode < 400 && MEDIA_EXT_RE.test(details.url)) {
      captureCandidate(details.url, 'webRequest')
    }
  }
  // 共享嗅探监听（webRequest 每事件只允许一个监听器，统一在 probeEvents 注册）
  if (disposeListeners) disposeListeners()
  disposeListeners = addProbeListeners({ onBeforeRequest, onCompleted })

  // 先尝试直接从播放页 HTML 提取真实地址（MacCMS 等）：**首个候选立即交给播放器**，窗口仅作兜底
  void extractStreamCandidatesCached(url, referer).then((candidates) => {
    if (!probeActive || candidates.length === 0) return
    const alts = candidates.slice(0, 6).map((u) => ({ url: u, referer: refererForCandidate(u, url) }))
    for (const a of alts) offerHandoffCandidate(a)
    const first = alts[0]
    if (foundUrls.includes(first.url)) return
    foundUrls.push(first.url)
    log.append('info', 'rule-probe', `直出地址命中（不做预校验，直接交给播放器）: ${first.url.slice(0, 120)}`)
    /*
     * 直出地址也过一遍"疑似广告短片"判定（v0.3.7）—— 但**不再等它**：
     * MacCMS 系的 `player_aaaa.url` 有时被站点填成前置广告，先交给播放器最多多看几秒广告，
     * 而等它（最长 8 秒）是每一集都要付的时间。判定结论只记日志与阶段步骤。
     */
    void looksLikeAdClip(first.url).then((suspect) => {
      if (!probeActive || !suspect) return
      adClipUrls.add(first.url)
      log.append('warn', 'rule-probe', `直出地址疑似广告短片（已先播，等真流顶掉）: ${first.url.slice(0, 110)}`)
      pushStep(STAGE, '直出地址疑似广告短片（已先播，等真流顶掉）')
    })
    // 记进会话直链缓存（同一集来回切 / 退出再进可直接命中）；备选一起存，缓存失效时 5 秒内可换
    rememberStream(url, first.url, first.referer, alts.slice(1))
    noteCapturedStream({
      url: first.url,
      kind: /\.m3u8(\?|$)/i.test(first.url) ? 'm3u8' : 'direct',
      referer: first.referer,
      channel: 'html 直出',
      capturedAt: Date.now()
    })
    succeedStage(STAGE, '已获取播放资源（播放页直出）')
    // Referer 语义：undefined=未判定（回退规则站点）；''=判定不能带（跨域 CDN）
    emit(mainWin, { type: 'found', url: first.url, referer: first.referer ?? '', kind: 'direct' })
  })

  /**
   * CDP 深度嗅探：现代站点常用无扩展名地址（签名 URL / MSE / blob 前置分片），
   * 只看 URL 会漏。这里通过 DevTools Protocol 读取 XHR/Fetch 响应体，
   * 识别 #EXTM3U（HLS）与 <MPD（DASH）播放列表，直接拿到真实流地址。
   */
  const cdpCandidates = new Map<string, string>()
  const dbg = probeWin.webContents.debugger
  let cdpReady: Promise<void> = Promise.resolve()
  try {
    dbg.attach('1.3')
    // 必须先完成 Network.enable 再加载页面，否则页面首批请求（播放器 API）不会被记录
    cdpReady = dbg
      .sendCommand('Network.enable')
      .then(() => undefined)
      .catch(() => undefined)
    const emitFound = (u: string, kind: string): void => {
      if (foundUrls.includes(u)) return
      foundUrls.push(u)
      log.append('info', 'rule-probe', `捕获媒体流(${kind}): ${u.slice(0, 120)}`)
      emit(mainWin, { type: 'found', url: u, kind })
    }
    dbg.on('message', (_e, method, params) => {
      if (!probeActive) return
      try {
        if (method === 'Network.responseReceived') {
          const p = params as {
            requestId?: string
            type?: string
            response?: { url?: string; mimeType?: string; status?: number }
          }
          const url = p.response?.url ?? ''
          const mime = (p.response?.mimeType ?? '').toLowerCase()
          if (process.env.SAKANA_PROBE_VERBOSE && url) {
            console.log(
              `[probe-net] ${String(p.type ?? '?')} ${String(p.response?.status ?? '')} ${mime.split(';')[0]} ${url.slice(0, 150)}`
            )
          }
          if (!url) return
          const looksPlaylist =
            /mpegurl|dash\+xml|vnd\.apple/i.test(mime) || /\.(m3u8|mpd)(\?|$)/i.test(url)
          const looksMedia = /^video\//i.test(mime) || /audio\/(mpegurl|mp4)/i.test(mime)
          if (looksPlaylist) {
            // 播放列表地址本身就是可播流，优先直接采用
            emitFound(url, /mpd/i.test(url) ? 'dash' : 'm3u8')
          } else if (
            looksMedia ||
            ['XHR', 'Fetch', 'Media', 'Other'].includes(String(p.type ?? '')) ||
            MEDIA_EXT_RE.test(url)
          ) {
            if (p.requestId) cdpCandidates.set(p.requestId, url)
          }
        } else if (method === 'Network.loadingFinished') {
          const p = params as { requestId?: string }
          const id = p.requestId
          if (!id) return
          const url = cdpCandidates.get(id)
          if (!url) return
          cdpCandidates.delete(id)
          void dbg
            .sendCommand('Network.getResponseBody', { requestId: id })
            .then((res) => {
              const body = (res as { body?: string; base64Encoded?: boolean })?.body
              if (!body) return
              const head = body.slice(0, 400)
              if (head.includes('#EXTM3U')) emitFound(url, 'm3u8')
              else if (head.includes('<MPD')) emitFound(url, 'dash')
            })
            .catch(() => undefined)
        }
      } catch {
        /* CDP 消息异常忽略 */
      }
    })
  } catch (err) {
    log.append('warn', 'rule-probe', `CDP 深度嗅探不可用（仅按 URL 嗅探）: ${String(err)}`)
  }

  const headers: Record<string, string> = { 'User-Agent': BROWSER_UA }
  if (referer) headers['Referer'] = referer
  const loadOpts: Electron.LoadURLOptions = { userAgent: BROWSER_UA }
  if (referer) loadOpts.httpReferrer = referer
  // 等 CDP 就绪后再加载页面（保证不丢首批请求）
  void cdpReady.then(() => {
    const w = probeWin
    if (!probeActive || !w || w.isDestroyed()) return
    void w.loadURL(url, loadOpts).catch((err) => {
      const e = err as { code?: string; message?: string }
      log.append('warn', 'rule-probe', `播放页加载失败 (${e.code ?? ''}): ${e.message ?? String(err)}`)
    })
  })
  probeWin.on('closed', () => {
    probeWin = null
  })

  // 播放页大多需要“交互”才会加载播放器：注入脚本自动点击播放按钮 / 触发 video.play()
  probeWin.webContents.on('did-finish-load', () => {
    flowDetail(STAGE, '播放页已加载，正在触发页面播放器（自动点击）')
    pushStep(STAGE, '播放页已加载，注入自动点击')
    for (const delay of [1200, 3000, 6000, 10000]) setTimeout(() => runAutoPlayClicks(probeWin), delay)
  })

  /*
   * 收尾时间（v0.3.9：20 秒 → 60 秒，与在线播放链路统一）。
   *
   * 为什么必须拉长：实测慢站点的播放页从加载到播放器真正发出取流请求，
   * 冷启动 + 广告脚本 + 播放器 CDN 一起排队时经常要 30–50 秒
   * （`.e2e/online-test-v037.log` 里 7sefun/AGE 这类站点都在 20 秒后才出流）。
   * 20 秒收尾的结果是「明明再多等十几秒就能拿到，却先判成未捕获到视频流」，
   * 界面回退到网页播放 —— 用户看到的就是「有些源偶尔能播、偶尔播不了」。
   */
  timeoutTimer = setTimeout(() => {
    // 收尾时别再优先选已知的占位/广告地址（理由见 pickBest）
    const best = pickBest(foundUrls, adClipUrls)
    if (!doneSent) {
      doneSent = true
      /*
       * 收尾时如果只剩"疑似广告短片"，仍然交出去（有得看总比什么都没有强），
       * 但 message 里写清楚 —— 用户看到的是"已捕获视频流"，日志里能看出这次只抓到广告。
       */
      const onlyAdClip = !!best && adClipUrls.has(best)
      emit(mainWin, {
        type: 'done',
        found: !!best,
        message: best
          ? onlyAdClip
            ? '只捕获到疑似广告短片，已按兜底交给播放器（继续等待正片）'
            : '已捕获视频流'
          : `等待 ${ONLINE_PLAY_TIMEOUT_MS / 1000} 秒仍未捕获到视频流（站点可能已失效或需要交互）`,
        url: best ?? undefined
      })
    }
    stopRuleProbe()
  }, ONLINE_PLAY_TIMEOUT_MS)
  return true
}

/** 当前嗅探的监听注销函数（停止/换集时清掉，避免与其它嗅探实现互相覆盖） */
let disposeListeners: (() => void) | null = null

export function stopRuleProbe(): void {
  probeActive = false
  if (disposeListeners) {
    try {
      disposeListeners()
    } catch {
      /* ignore */
    }
    disposeListeners = null
  }
  if (timeoutTimer) {
    clearTimeout(timeoutTimer)
    timeoutTimer = null
  }
  const w = probeWin
  probeWin = null
  try {
    if (w && !w.isDestroyed()) {
      if (w.webContents.debugger.isAttached()) w.webContents.debugger.detach()
      w.destroy()
    }
  } catch {
    /* ignore */
  }
}

/**
 * 自检读数的现场快照（v0.3.9）。
 *
 * 用户报的现象是「上一路播完之后换源/换集会出现播放失败，怀疑嗅探程序没反应过来、
 * 或者播放器销毁后没重建」。要判定这件事，必须能**从外面看到**嗅探模块的内部状态：
 * 探针窗口还在不在、共享监听还挂着没有、收尾计时器还在不在跑。
 * 这些是模块私有变量，所以由模块自己导出读数，而不是让自检去猜。
 */
export function ruleProbeDiagnostics(): {
  active: boolean
  windowAlive: boolean
  windowDestroyed: boolean
  listenersRegistered: boolean
  timeoutPending: boolean
  foundCount: number
} {
  const w = probeWin
  return {
    active: probeActive,
    windowAlive: !!w && !w.isDestroyed(),
    windowDestroyed: !!w && w.isDestroyed(),
    listenersRegistered: disposeListeners !== null,
    timeoutPending: timeoutTimer !== null,
    foundCount: foundUrls.length
  }
}

/**
 * 忘掉某个播放页的直链缓存（v0.3.9 自检用）。
 *
 * 为什么要能单独忘掉一条：「切源/切集后仍然播放失败」最常见的成因之一，
 * 就是命中了缓存里那条**已经失效的直链**（一次性令牌被用掉、签名过期）。
 * 全清会连带丢掉其它还能用的条目，所以自检只清掉「刚刚失败的那一页」。
 */
export function forgetStream(pageUrl: string): boolean {
  if (!pageUrl) return false
  const had = streamCache.delete(pageUrl)
  if (had) log.append('warn', 'rule-probe', `自检：清除失效直链缓存 ${pageUrl.slice(0, 110)}`)
  return had
}

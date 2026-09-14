import axios from 'axios'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import {
  type AdRemovalPlan,
  pickVariant,
  planAdRemoval
} from './hlsAdFilterCore'

/**
 * HLS 播放列表广告分片过滤（本机 HTTP 改写代理）
 *
 * 背景（MXdm / MacCMS 系站点实测，2026-09 验证）：
 * 这些 CDN 的「正片」m3u8 是**预处理拼接过**的——贴片广告被真正拼进了流里，
 * 并用 #EXT-X-DISCONTINUITY 标出拼接点。分片 URL 同域同路径、命名规律一致，
 * 唯一可靠的判据就是「被两个 discontinuity 夹住的 4~60s 短区段」：
 *
 *   #EXT-X-DISCONTINUITY            ← 中插广告起始
 *   #EXTINF:6.633333,
 *   a8971dda....ts                  （共 4 片 16.47s）
 *   #EXT-X-DISCONTINUITY            ← 广告结束，回到正片
 *   #EXTINF:2.085422,
 *   5b2e8a47....ts
 *
 * 关键实测：广告分片的 PTS 是**另一条时间轴**（1.445s 起算），
 * 而广告前后的正片 PTS 连续（前段末尾 500.27s → 后段起始 500.19s）。
 * 所以「删掉广告分片 + 删掉界定它的两个 DISCONTINUITY」得到的正是
 * 时间轴完全连续的正片流，播放器不会在拼接点停顿或跳变。
 *
 * 为什么必须在主进程做：libmpv / libVLC / Chromium 都只是**消费**播放列表，
 * 没有任何内核选项或解码器行为能「跳过」已拼进时间轴的广告分片
 * （mpv 的 --ytdl / --hls-bitrate 与广告无关；解码器层面无法区分广告与正片）。
 * 唯一可行且可控的位置就是在取流链路上改写播放列表。
 *
 * 安全策略见 hlsAdFilterCore.planAdRemoval：判据不足一律不改，并 302 回源。
 */

/** 会话：把「远端播放列表地址」登记成本机改写地址 */
interface AdSession {
  id: string
  url: string
  referer?: string
  cookies?: string
  userAgent?: string
  createdAt: number
  /** 改写结果缓存：播放器 seek 时会重复请求列表，缓存保证前后一致 */
  cache?: { plan: AdRemovalPlan | null; at: number }
}

const sessions = new Map<string, AdSession>()
/**
 * 会话保留时长：必须长于「一次播放 + 之后可能的重播」。
 * 播放器 seek / 重连时会重新请求播放列表，此时若会话已被回收，
 * /adfilter/<id>/ 只能返回 404，会直接打断播放。
 * 所以 TTL 取 6 小时，另外用条数上限兜住内存（每条最多约 25KB 改写结果）。
 */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000
const SESSION_MAX = 256
const CACHE_TTL_MS = 10 * 60 * 1000

/** 中转流服务监听的端口（由 transcode.initLiveServer 注入，避免模块循环依赖） */
let proxyPort = 0

export function setAdProxyPort(port: number): void {
  proxyPort = port > 0 ? port : 0
}

export function adProxyPort(): number {
  return proxyPort
}

/** 开关：默认开启；settings.hlsAdFilter === false 或 SAKANA_AD_FILTER=0 时关闭 */
export function adFilterEnabled(): boolean {
  const env = process.env.SAKANA_AD_FILTER
  if (env === '0' || env === 'false') return false
  if (env === '1' || env === 'true') return true
  const s = getSettings() as { hlsAdFilter?: boolean }
  return s.hlsAdFilter !== false
}

/** 是否是可改写的 HLS 播放列表地址（只认 .m3u8，保守起见不猜无扩展名的签名地址） */
export function isHlsPlaylistUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  return /\.m3u8(\?|#|$)/i.test(url)
}

function pruneSessions(): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    // 按最后一次活动时间回收
    const at = Math.max(s.createdAt, s.cache?.at ?? 0)
    if (now - at > SESSION_TTL_MS) sessions.delete(id)
  }
  // 条数上限：Map 迭代顺序是插入顺序，超限时从最旧的开始删
  while (sessions.size > SESSION_MAX) {
    const oldest = sessions.keys().next()
    if (oldest.done) break
    sessions.delete(oldest.value)
  }
}

/**
 * 把远端 m3u8 地址登记为本机改写地址。
 * 同步返回（播放调用方是同步 API），真正的抓取与改写发生在播放器请求列表时。
 * 未开启过滤 / 端口未就绪 / 非 HLS 地址时原样返回，保证对本地文件与中转流零副作用。
 */
export function proxyHlsUrl(
  url: string,
  opts: { referer?: string; cookies?: string; userAgent?: string } = {}
): string {
  if (!adFilterEnabled()) return url
  if (proxyPort <= 0) return url
  if (!isHlsPlaylistUrl(url)) return url
  pruneSessions()
  const id = randomUUID().replace(/-/g, '').slice(0, 16)
  sessions.set(id, {
    id,
    url,
    referer: opts.referer,
    cookies: opts.cookies,
    userAgent: opts.userAgent,
    createdAt: Date.now()
  })
  const local = `http://127.0.0.1:${proxyPort}/adfilter/${id}/index.m3u8`
  log.append('info', 'ad-filter', `播放列表改写代理已登记: ${url.slice(0, 110)} → ${local}`)
  return local
}

// ---------------- HTTP ----------------

const AD_PATH_RE = /^\/adfilter\/([A-Za-z0-9_-]+)\//

async function fetchText(url: string, s: AdSession): Promise<string | null> {
  const headers: Record<string, string> = { 'User-Agent': s.userAgent || BROWSER_UA }
  if (s.referer) headers['Referer'] = s.referer
  if (s.cookies) headers['Cookie'] = s.cookies
  const res = await axios.get<string>(url, {
    timeout: 20000,
    maxRedirects: 5,
    responseType: 'text',
    maxContentLength: 16 * 1024 * 1024,
    headers,
    ...buildProxyAgents(getSettings().proxy)
  })
  return typeof res.data === 'string' ? res.data : null
}

/** 抓取远端列表并尝试改写；返回 null 表示应回源 */
async function rewriteRemote(s: AdSession): Promise<AdRemovalPlan | null> {
  if (s.cache && Date.now() - s.cache.at < CACHE_TTL_MS) return s.cache.plan
  const master = await fetchText(s.url, s)
  if (!master) return null
  let mediaText = master
  let mediaUrl = s.url
  if (master.includes('#EXT-X-STREAM-INF')) {
    const variant = pickVariant(master, s.url)
    if (!variant) return null
    const v = await fetchText(variant, s)
    if (!v) return null
    mediaText = v
    mediaUrl = variant
  }
  const plan = planAdRemoval(mediaText, mediaUrl)
  if (!plan) {
    log.append('info', 'ad-filter', `未发现可安全剔除的贴片广告分片，按原列表播放: ${mediaUrl.slice(0, 110)}`)
    s.cache = { plan: null, at: Date.now() }
    return null
  }
  log.append(
    'info',
    'ad-filter',
    `跳过 ${plan.removedSegments} 个广告分片（共 ${plan.removedSeconds.toFixed(1)}s，${plan.removedBlocks.length} 段），保留正片 ${plan.keptSeconds.toFixed(1)}s: ${mediaUrl.slice(0, 100)}`
  )
  s.cache = { plan, at: Date.now() }
  return plan
}

function redirect(res: ServerResponse, url: string): void {
  res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' })
  res.end()
}

/**
 * 处理 /adfilter/<id>/... 请求。返回 true 表示请求已由本模块接管（可能异步完成）。
 * 任何异常都退化为 302 回源：改写失败绝不能导致播不出来。
 */
export function handleAdProxyRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const pathname = (req.url ?? '').split('?')[0]
  const m = AD_PATH_RE.exec(pathname)
  if (!m) return false
  const s = sessions.get(m[1])
  if (!s) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('ad-filter session gone')
    return true
  }
  if (!adFilterEnabled()) {
    redirect(res, s.url)
    return true
  }
  void (async () => {
    try {
      const plan = await rewriteRemote(s)
      if (!plan) {
        redirect(res, s.url)
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store'
      })
      res.end(plan.text)
    } catch (err) {
      log.append('warn', 'ad-filter', `播放列表改写失败，回源原始地址: ${String(err).slice(0, 160)}`)
      try {
        redirect(res, s.url)
      } catch {
        /* 响应已发出则忽略 */
      }
    }
  })()
  return true
}

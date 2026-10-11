import axios from 'axios'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import { BOOST_MODE_LABEL } from '@shared/streamBoost'
import {
  BOOST_BUFFER_CAP_BYTES,
  BOOST_CHUNK_BYTES,
  BOOST_FAST_BPS,
  BOOST_FAST_SEGMENT_MARGIN,
  BOOST_MEASURE_MAX_MS,
  BOOST_PARALLEL,
  BOOST_PLAYLIST_TTL_MS,
  BOOST_RECORD_FLUSH_MS,
  BOOST_RECORD_MAX,
  BOOST_RECORD_MIN_BYTES,
  BOOST_SESSION_IDLE_MS,
  BOOST_URL_DISPLAY_CHARS,
  BOOST_WARM_MAX_MS
} from '@shared/streamBoost'
import { SLOW_STREAM_CONFIRM_MS, SLOW_STREAM_RATE_BPS } from '@shared/onlinePlay'
import type { StreamBoostMode, StreamBoostRecord, StreamBoostStatus } from '@shared/types'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import { store } from '../store'
import { adProxyPort } from './adFilter'
import { pickVariant } from './hlsAdFilterCore'
import { noteSlow, setMetrics } from './playFlow'

/**
 * 在线播放加速器（v0.3.9）—— 「嗅探到直链之后、交给播放器之前」这一段。
 *
 * ## 要解决的问题（用户原话）
 *
 * 「嗅探到资源后，开始进行播放才是获取资源的正式过程，这一过程受制于网络速度……
 *   在线播放往往就是在这一阶段失败的。」
 *
 * 也就是说：**地址已经拿到了，卡在取流上**。这一段的瓶颈不在解析规则、不在嗅探，
 * 而在「单条 TCP 连接能从 CDN 拉到多少带宽」。
 *
 * ## 实测（`.e2e/measure-boost.mjs`，2026-10-11，真实站点直链）
 *
 *   MXdm（svip.yyzy-play.vip HLS，370 片/1479s）前 8 个分片：
 *     顺序取（播放器的做法）359KB/s → 3.87 视频秒/秒；4 路并发预读 769KB/s → 8.28 视频秒/秒（+114%）
 *   baimao（v.lzv22.com HLS，368 片/1470s）前 8 个分片：
 *     顺序 279KB/s → 2.29 视频秒/秒；4 路并发 657KB/s → 5.38 视频秒/秒（+135%）
 *
 * 结论：这类 MacCMS CDN **按连接限速**（单连接 300KB/s 上下，而 1080p 实时只够 2–6Mbps 的余量都不多），
 * 而 libmpv 取 HLS 是**一个分片一个请求、串行**的 —— 所以这里真正有效的做法是
 * 「本机代理 + 并发预读/并发 Range」，把多条连接的带宽合起来喂给播放器的单条连接。
 *
 * ## 两种形态（都是「只读」中转，绝不重编码、不改一个字节的媒体内容）
 *
 * 1. `hls`：只改写播放列表，把分片地址换成 `127.0.0.1` 上的地址；
 *    播放器来取第 N 片时，我们已经在后台把第 N+1…N+4 片拉回来了（并发 4 路），
 *    于是播放器的每次请求都命中本机缓存 —— 既提速也抗抖动。分片仍直连 CDN，支持拖进度。
 * 2. `file`：整段文件（mp4/flv/ts）。对同一个直链开 4 条**并发 Range** 连接分块拉，
 *    按序汇流成一条连续流从本机发给播放器（播放器只看到 127.0.0.1）。
 *
 * ## 三条硬约束（不做安慰剂）
 *
 * - **慢才加速**：`auto`（默认）先量一次直连，≥ `BOOST_FAST_BPS` 就原样直连 —— 多一层转发只会更慢；
 * - **不支持就立刻退回**：源站不认 Range（返回 200 全量）时 file 形态直接放弃，HLS 形态仍可用（分片本来就独立）；
 * - **内存有上限**：并发窗口本身把内存钉在 `并发数 × 块大小`（默认 8–12MB），
 *   另有 `BOOST_BUFFER_CAP_BYTES` 作为第二道闸（客户端卡住就不再拉新数据），见文件末尾说明。
 */

// ---------------- 设置与开关 ----------------

/** 加速档位：设置项 streamBoost；环境变量 SAKANA_BOOST=off|auto|force 可临时覆盖（自检用） */
export function boostMode(): StreamBoostMode {
  const env = String(process.env.SAKANA_BOOST ?? '').toLowerCase()
  if (env === 'off' || env === '0' || env === 'false') return 'off'
  if (env === 'force' || env === '1' || env === 'true') return 'force'
  if (env === 'auto') return 'auto'
  const s = getSettings() as { streamBoost?: StreamBoostMode }
  const v = s.streamBoost
  return v === 'off' || v === 'force' ? v : 'auto'
}

/** 本机中转端口：与 HLS 广告过滤 / FFmpeg 中转共用同一个监听（transcode.initLiveServer） */
function relayPort(): number {
  return adProxyPort()
}

// ---------------- 统计与速率（界面与「过慢」判据都读它） ----------------

interface Sample {
  at: number
  bytes: number
}

/**
 * 速率采样。
 *
 * 为什么是「累计字节 + 时间戳」的样本序列而不是定时器累加：
 * 定时器会把「没有流量」也算进平均，反而看不清真实的瞬时速率；
 * 而样本序列可以在任意时刻回答两个问题：
 *   · 最近 1 秒多少字节（界面上的实时速率）；
 *   · 最近 5 秒平均多少字节（判「过慢」——用户要的那个口径，见 @shared/onlinePlay）。
 */
let samples: Sample[] = []
let servedBytes = 0
let firstByteAt: number | null = null
let ttfbMs: number | null = null
let sessionStartedAt: number | null = null
let lastSlowNoteAt = 0

function pushSample(): void {
  const now = Date.now()
  samples.push({ at: now, bytes: servedBytes })
  const cutoff = now - 8000
  while (samples.length > 2 && samples[0].at < cutoff) samples.shift()
}

function rateOver(windowMs: number): number {
  if (samples.length === 0) return 0
  const now = Date.now()
  const newest = samples[samples.length - 1]
  if (now - newest.at > 200) samples.push({ at: now, bytes: servedBytes })
  const head = samples[samples.length - 1]
  let oldest = samples[0]
  for (const s of samples) {
    if (head.at - s.at >= windowMs) oldest = s
    else break
  }
  const dt = head.at - oldest.at
  if (dt <= 0) return 0
  return ((head.bytes - oldest.bytes) / dt) * 1000
}

/** 记一次「转发给播放器的字节」——速率、界面状态、playFlow 指标都从这里来 */
function noteServed(n: number): void {
  if (n <= 0) return
  if (firstByteAt === null) {
    firstByteAt = Date.now()
    ttfbMs = sessionStartedAt ? firstByteAt - sessionStartedAt : null
  }
  servedBytes += n
  pushSample()
  const current = rateOver(1000)
  const avg5s = rateOver(5000)
  // playFlow 是本轮「过程进度」的唯一数据源（另一个 agent 的实现）：
  // 这里只**写指标**，不去动它的状态区与失败判定，避免与它的改动冲突。
  setMetrics({ bytes: servedBytes, rateBps: Math.round(current), ttfbMs })
  if (avg5s > 0 && avg5s < SLOW_STREAM_RATE_BPS) {
    const now = Date.now()
    if (now - lastSlowNoteAt > SLOW_STREAM_CONFIRM_MS + 2000) {
      lastSlowNoteAt = now
      noteSlow(
        Math.round(avg5s),
        `本机中转速率 ${Math.round(avg5s / 1024)}KB/s（低于 ${Math.round(SLOW_STREAM_RATE_BPS / 1024)}KB/s 的 1080p 门槛）`
      )
    }
  }
  /*
   * 优化记录按 5 秒节奏落盘（见 BOOST_RECORD_FLUSH_MS）：
   * 这样「播放中途崩溃 / 直接关进程」也留下了这次加速的真实结果，
   * 而不是只在优雅退出（stopAllBoost / detach）时才写。
   */
  const cur = nowSession()
  if (cur) flushRecord(cur, false)
}

function resetStats(): void {
  samples = []
  servedBytes = 0
  firstByteAt = null
  ttfbMs = null
  lastSlowNoteAt = 0
}

// ---------------- 会话 ----------------

interface HlsSegment {
  url: string
  dur: number
}

interface BoostSession {
  id: string
  /** 源地址（HLS 时通常已是广告过滤后的本机播放列表地址） */
  origin: string
  kind: 'hls' | 'file'
  /** 请求源站时要带的头（站点会话） */
  referer?: string
  cookies?: string
  userAgent?: string
  createdAt: number
  lastAt: number
  /** 播放器已经取走的字节（界面显示「当前是否在加速」的判据） */
  bytes: number
  /** 决策说明（界面上要如实显示为什么在/不在加速） */
  reason: string
  /** 本次会话生效的档位（auto / force）—— 优化记录里要能看出是自动判定的还是用户强制的 */
  mode: StreamBoostMode
  parallel: number
  // file 形态
  totalBytes: number | null
  rangeOk: boolean
  /** 源站声明的 Content-Type（回给播放器时照抄） */
  contentType: string
  /** 预热到手的头部数据：播放器第一次读就从内存里拿，不用回源 */
  head: Buffer
  // hls 形态
  mediaUrl: string
  segments: HlsSegment[]
  segCache: Map<string, { data: Buffer; at: number }>
  segFetched: number
  segFailed: number
  /** 正在预读的分片（url 集合，避免同一片重复拉） */
  segInflight: Set<string>
  /**
   * VOD 播放列表文本的短缓存（url → 文本）。
   * 为什么必须有：播放器请求播放列表时若我们再向 CDN 拉一遍，慢站点上就是 1~2 秒的往返，
   * 正好把预热省下的时间还回去（自检记录里量到 localTtfbMs 1.2~1.8s 就是这个原因）。
   * 只缓存带 #EXT-X-ENDLIST 的列表，直播列表不进这里。
   */
  playlists: Map<string, { text: string; at: number }>
  /** 本轮已在排队预读的片索引（相对当前播放位置的前瞻窗口） */
  warmed: boolean
  // ---- 优化记录（v0.3.9 补充更新）----
  /** 决策时量到的直连速率 / 首字节（真实测量值，量不到就是 null） */
  directRateBps: number | null
  directTtfbMs: number | null
  /** 决策 + 预热花了多久（真实成本） */
  decisionMs: number | null
  /** 片源域名（HLS 取媒体列表的 CDN 域名） */
  host: string
  /** 站点域名（Referer 的 host） */
  site: string
  /** 中途退化为单连接直连的原因 */
  degraded: string | null
  /** 上一次落盘时间（限流用） */
  lastFlushAt: number
  /** 已经写过「结束」记录：避免 stop/prune 反复写同一条 */
  finalized: boolean
}

const sessions = new Map<string, BoostSession>()

function nowSession(): BoostSession | null {
  let best: BoostSession | null = null
  for (const s of sessions.values()) {
    if (!best || s.lastAt > best.lastAt) best = s
  }
  if (!best) return null
  if (Date.now() - best.lastAt > BOOST_SESSION_IDLE_MS) return null
  return best
}

function headersFor(s: BoostSession): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': s.userAgent || BROWSER_UA }
  if (s.referer) h.Referer = s.referer
  if (s.cookies) h.Cookie = s.cookies
  return h
}

function pruneSessions(): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.lastAt > BOOST_SESSION_IDLE_MS) {
      // 回收前先把这一路的结果落成优化记录，否则「换集/退出播放器」这条最常见的路径就没有记录
      flushRecord(s, true)
      sessions.delete(id)
    }
  }
  // 同时只可能有一路在播，多于 4 个会话一定是历史残留
  while (sessions.size > 4) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastAt - b.lastAt)[0]
    flushRecord(oldest, true)
    sessions.delete(oldest.id)
  }
}

/** 拆掉所有加速会话（退出播放器、换集、关设置时调用） */
export function stopAllBoost(): void {
  if (sessions.size > 0) {
    log.append('info', 'boost', `停止加速中转（${sessions.size} 个会话）`)
    for (const s of sessions.values()) flushRecord(s, true)
  }
  sessions.clear()
  resetStats()
}

// ---------------- 优化记录（v0.3.9 补充更新） ----------------

/**
 * 优化记录的落盘命名空间。
 *
 * 为什么**不塞进 settings**：记录是「越写越多」的流水，而 settings 是「用户配置」——
 * 两者混在一起会让设置文件的每次读写都拖着 35KB 的历史；而且设置页有导出/导入语义，
 * 把播放历史混进去会很奇怪。这里单独一个命名空间 `streamBoostLog`
 * （文件：`<userData>/data/streamBoostLog.json`，上限见 @shared/streamBoost 的 BOOST_RECORD_MAX）。
 */
const RECORD_NS = 'streamBoostLog'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function getStreamBoostRecords(): StreamBoostRecord[] {
  const list = store.get<StreamBoostRecord[]>(RECORD_NS, [])
  return Array.isArray(list) ? list.slice(0, BOOST_RECORD_MAX) : []
}

export function clearStreamBoostRecords(): number {
  const n = getStreamBoostRecords().length
  store.set(RECORD_NS, [])
  /*
   * 注意语义：清空的是**历史**。若此刻正在加速，这一路播完仍会写下它自己的那条记录
   * （那是"现在正在发生的事"，不该因为清了历史就消失）。这条规则在界面上也写着。
   */
  log.append('info', 'boost', `已清空优化记录（${n} 条）`)
  return n
}

/**
 * 把当前会话的真实测量结果落成一条优化记录。
 *
 * 三条原则（对应工单里的「不许编数据」）：
 * 1. **量不到就 null**：直连速率/首字节、本机首字节都是真测出来的，没测到就留空（界面显示「—」）；
 * 2. **样本不足不记**：转发字节 < BOOST_RECORD_MIN_BYTES 的会话不产生记录（见常量注释）；
 * 3. **同一会话只留一条**：按会话 id 覆盖，`final` 表示这是收尾快照（结束时间写实）。
 */
function flushRecord(s: BoostSession, final: boolean): void {
  if (s.bytes <= 0 || s.bytes < BOOST_RECORD_MIN_BYTES) return
  if (final && s.finalized) return
  const now = Date.now()
  if (!final && now - s.lastFlushAt < BOOST_RECORD_FLUSH_MS) return
  s.lastFlushAt = now
  if (final) s.finalized = true

  /*
   * 加速速率 = 本机真正转发给播放器的字节 / **从开始处理到现在**的墙钟。
   *
   * 分母为什么从 `createdAt`（决策开始）算、而不是从「交给播放器」算：
   * 预热阶段已经拉进本机缓存的那一段字节，播放器是**瞬间**拿到的 ——
   * 若把它们算成"白送"，加速的速率会被系统性高估（实测里就翻过车：
   * 全站限速 1MB/s 的源本来并发毫无收益，却因为 2MB 预热头被算成「+99%」）。
   * 用同一个分母（用户真实等待的墙钟）算出来的数字才对得起「不许编数据」。
   * 供流不足 1.5 秒时不给数字（几十毫秒的抖动就能翻倍），留 null 让界面显示「—」。
   */
  const elapsedMs = now - s.createdAt
  const boostedRateBps = elapsedMs >= 1500 ? Math.round((s.bytes / elapsedMs) * 1000) : null
  const localTtfbMs = s.bytes > 0 ? ttfbMs : null
  const saved =
    s.directTtfbMs !== null && localTtfbMs !== null ? Math.max(0, s.directTtfbMs - localTtfbMs) : null

  const rec: StreamBoostRecord = {
    id: s.id,
    at: s.createdAt,
    endedAt: final ? now : null,
    host: s.host || hostOf(s.origin),
    site: s.site,
    kind: s.kind,
    mode: s.mode,
    parallel: s.parallel,
    directRateBps: s.directRateBps,
    boostedRateBps,
    directTtfbMs: s.directTtfbMs,
    localTtfbMs,
    coldStartSavedMs: saved,
    decisionMs: s.decisionMs,
    bytes: s.bytes,
    degraded: s.degraded,
    segFailed: s.segFailed
  }
  const list = getStreamBoostRecords().filter((r) => r.id !== rec.id)
  list.unshift(rec)
  store.set(RECORD_NS, list.slice(0, BOOST_RECORD_MAX))
}


/** 界面上「当前是否在加速 / 当前速率」的唯一数据源 */
export function getStreamBoostStatus(): StreamBoostStatus {
  const s = nowSession()
  const mode = boostMode()
  if (!s) {
    return {
      mode,
      active: false,
      kind: 'none',
      origin: '',
      local: '',
      parallel: 0,
      rateBps: 0,
      avg5sBps: 0,
      ttfbMs: null,
      bytes: 0,
      reason: '当前没有在线播放会话',
      startedAt: null
    }
  }
  return {
    mode,
    active: s.bytes > 0,
    kind: s.kind,
    origin: s.origin.slice(0, BOOST_URL_DISPLAY_CHARS),
    local: localUrl(s),
    parallel: s.bytes > 0 ? s.parallel : 0,
    rateBps: Math.round(rateOver(1000)),
    avg5sBps: Math.round(rateOver(5000)),
    ttfbMs,
    bytes: s.bytes,
    reason: s.reason,
    startedAt: s.createdAt
  }
}

// ---------------- 源站 HTTP 小工具 ----------------

interface StreamResponse {
  status: number
  headers: Record<string, unknown>
  stream: Readable
  /** 主动掐断这次请求（客户端断了 / 超时） */
  abort: () => void
}

async function openStream(
  url: string,
  headers: Record<string, string>,
  opts: { range?: string; timeoutMs?: number } = {}
): Promise<StreamResponse> {
  const res = await axios.get(url, {
    timeout: opts.timeoutMs ?? 20000,
    responseType: 'stream',
    maxRedirects: 5,
    validateStatus: () => true,
    // 媒体字节一律不参与解压：有些 CDN 会声明 content-encoding，
    // 一旦被 axios 解压，Range 分段的字节数就对不上了（续传会错位）
    decompress: false,
    headers: { ...headers, ...(opts.range ? { Range: opts.range } : {}) },
    ...buildProxyAgents(getSettings().proxy)
  })
  return {
    status: res.status,
    headers: res.headers as Record<string, unknown>,
    stream: res.data as Readable,
    abort: () => {
      try {
        ;(res.data as Readable).destroy()
      } catch {
        /* ignore */
      }
    }
  }
}

/** 读一小段（有字节上限与时间上限），用于测速与预热 */
function readBounded(
  stream: Readable,
  maxBytes: number,
  maxMs: number
): Promise<{ data: Buffer; ended: boolean; firstByteMs: number | null }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const chunks: Buffer[] = []
    let total = 0
    let firstByteMs: number | null = null
    let done = false
    const finish = (ended: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      stream.removeAllListeners('data')
      try {
        stream.destroy()
      } catch {
        /* ignore */
      }
      resolve({ data: Buffer.concat(chunks), ended, firstByteMs })
    }
    const timer = setTimeout(() => finish(false), maxMs)
    stream.on('data', (c: Buffer) => {
      if (firstByteMs === null) firstByteMs = Date.now() - t0
      chunks.push(c)
      total += c.length
      if (total >= maxBytes) finish(false)
    })
    stream.on('end', () => finish(true))
    stream.on('error', () => finish(false))
  })
}

function contentLengthOf(headers: Record<string, unknown>): number | null {
  const raw = headers['content-length']
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 从 Content-Range: bytes 0-1023/1234567 里取总长度 */
function totalFromContentRange(headers: Record<string, unknown>): number | null {
  const raw = String(headers['content-range'] ?? '')
  const m = /\/(\d+)\s*$/.exec(raw)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

export function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(url)
}

/**
 * 是不是「本机中转地址」（FFmpeg 中转 / 广告过滤后的播放列表 / 我们自己）。
 *
 * 为什么要把广告过滤后的播放列表单独放行：在线播放的链路是
 * `mpvPlay(boost(adFilter(原始地址)))` —— 先去广告分片，再做并发加速，
 * 这样预热与并发面对的已经是**去掉广告之后**的播放列表，不会把广告分片也算进去。
 */
export function isLocalRelayUrl(url: string): boolean {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(url)) return false
  // /adfilter/ 是本应用自己的播放列表改写地址，允许继续套一层加速
  return !/\/adfilter\//i.test(url)
}

// ---------------- 测速（自检与决策共用同一套口径） ----------------

export interface ThroughputSample {
  ok: boolean
  status: number
  bytes: number
  ms: number
  ttfbMs: number | null
  rateBps: number
  /** 服务器是否认 Range（206）= 能不能并发分段 */
  rangeOk: boolean
  totalBytes: number | null
  /** 源站声明的类型（转给播放器时照抄，避免一律报 video/mp4） */
  contentType: string
  /** keepData=true 时把读到的字节带回去（当预热缓冲用，不浪费这次请求） */
  data: Buffer
  note: string
}

/**
 * 量一条地址的真实吞吐（**单连接**，也就是播放器视角下的速率）。
 *
 * 为什么自检要用同一个函数：报告里那张「直连 vs 加速」的对比表必须同口径 ——
 * 播放器拉流是一条连接，那么两边都用一条连接去量才说明问题
 * （加速那一条是「本机一条连接进、源站四条连接出」，正是我们要证的东西）。
 */
export async function measureThroughput(
  url: string,
  headers: Record<string, string>,
  opts: { maxBytes?: number; maxMs?: number; keepData?: boolean } = {}
): Promise<ThroughputSample> {
  const maxBytes = opts.maxBytes ?? 1024 * 1024
  const maxMs = opts.maxMs ?? BOOST_MEASURE_MAX_MS
  const t0 = Date.now()
  let res: StreamResponse
  try {
    res = await openStream(url, headers, {
      range: `bytes=0-${maxBytes - 1}`,
      timeoutMs: maxMs + 4000
    })
  } catch (err) {
    return {
      ok: false,
      status: 0,
      bytes: 0,
      ms: Date.now() - t0,
      ttfbMs: null,
      rateBps: 0,
      rangeOk: false,
      totalBytes: null,
      contentType: '',
      data: Buffer.alloc(0),
      note: `连接失败：${String((err as Error)?.message ?? err).slice(0, 100)}`
    }
  }
  const read = await readBounded(res.stream, maxBytes, maxMs)
  const ms = Date.now() - t0
  const status = res.status
  const ok = status >= 200 && status < 400 && read.data.length > 0
  /*
   * 总长度只能从 Content-Range 拿：206 的 `content-length` 是**这一段的长度**（我们主动要的 1MB），
   * 不是文件总长 —— 早先把两者混用会让「秒开时间/进度条」全错。
   */
  const total = status === 206 ? totalFromContentRange(res.headers) : contentLengthOf(res.headers)
  const rangeOk = status === 206
  const rateBps = ms > 0 ? (read.data.length / ms) * 1000 : 0
  return {
    ok,
    status,
    bytes: read.data.length,
    ms,
    ttfbMs: read.firstByteMs,
    rateBps,
    rangeOk,
    totalBytes: total,
    contentType: String(res.headers['content-type'] ?? ''),
    data: opts.keepData ? read.data : Buffer.alloc(0),
    note: ok
      ? `HTTP ${status}，${Math.round(read.data.length / 1024)}KB / ${(ms / 1000).toFixed(2)}s = ${Math.round(rateBps / 1024)}KB/s${rangeOk ? '，支持 Range' : '，不支持 Range'}`
      : `HTTP ${status}，未取到数据`
  }
}

// ---------------- 决策：直连还是加速 ----------------

/**
 * HLS 的「播放器视角」吞吐测量：**一片一片顺序取**（libmpv 就是这么取 HLS 的）。
 *
 * 为什么不能拿 measureThroughput 量 m3u8：那是对播放列表文本发 Range，
 * 量出来的是「列表文本多大」，与视频比特率毫无关系。
 * 自检（SAKANA_BOOST_TEST）与报告里的「直连 vs 加速」对比都用这一个口径：
 * 同一个地址、同样的分片数、同样串行 —— 差别只在「是不是经过本机并发中转」。
 */
export interface HlsThroughputSample {
  ok: boolean
  mediaUrl: string
  segments: number
  videoSeconds: number
  bytes: number
  ms: number
  ttfbMs: number | null
  rateBps: number
  note: string
}

export async function measureHlsThroughput(
  url: string,
  headers: Record<string, string>,
  opts: { segments?: number; maxMs?: number } = {}
): Promise<HlsThroughputSample> {
  const want = opts.segments ?? 8
  const maxMs = opts.maxMs ?? 20000
  const t0 = Date.now()
  const empty: HlsThroughputSample = {
    ok: false,
    mediaUrl: url,
    segments: 0,
    videoSeconds: 0,
    bytes: 0,
    ms: 0,
    ttfbMs: null,
    rateBps: 0,
    note: '播放列表读取失败'
  }
  const text = await httpText(url, headers)
  if (!text || !text.includes('#EXTM3U')) return empty
  let mediaUrl = url
  let mediaText = text
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variant = pickVariant(text, url)
    if (!variant) return empty
    const sub = await httpText(variant, headers)
    if (!sub || !sub.includes('#EXTM3U')) return empty
    mediaUrl = variant
    mediaText = sub
  }
  const list = parseSegments(mediaText, mediaUrl)
  if (list.length === 0) return empty
  let bytes = 0
  let videoSeconds = 0
  let count = 0
  let ttfbMs: number | null = null
  for (const seg of list.slice(0, want)) {
    if (Date.now() - t0 > maxMs) break
    const st = Date.now()
    try {
      const r = await openStream(seg.url, headers, { timeoutMs: Math.max(5000, maxMs - (Date.now() - t0)) })
      const read = await readBounded(
        r.stream,
        32 * 1024 * 1024,
        Math.max(3000, maxMs - (Date.now() - t0))
      )
      if (ttfbMs === null && read.firstByteMs !== null) ttfbMs = read.firstByteMs
      bytes += read.data.length
      videoSeconds += seg.dur
      count += 1
      void st
    } catch {
      break
    }
  }
  const ms = Math.max(1, Date.now() - t0)
  const rateBps = (bytes / ms) * 1000
  return {
    ok: count > 0,
    mediaUrl,
    segments: count,
    videoSeconds,
    bytes,
    ms,
    ttfbMs,
    rateBps,
    note: `${count} 片（${videoSeconds.toFixed(1)}s 视频）${Math.round(bytes / 1024)}KB / ${(ms / 1000).toFixed(2)}s = ${Math.round(rateBps / 1024)}KB/s，首字节 ${ttfbMs ?? '?'}ms`
  }
}

export interface BoostPlan {
  /** 交给播放器的地址（可能是本机中转地址） */
  url: string
  kind: 'hls' | 'file' | 'none'
  boosted: boolean
  reason: string
  sample: ThroughputSample | null
}

const DIRECT: (reason: string, kind: BoostPlan['kind'], sample?: ThroughputSample | null) => BoostPlan = (
  reason,
  kind,
  sample = null
) => ({ url: '', kind, boosted: false, reason, sample })

function localUrl(s: BoostSession): string {
  const port = relayPort()
  const base = `http://127.0.0.1:${port}/boost/${s.id}`
  return s.kind === 'hls' ? `${base}/index.m3u8` : `${base}/stream`
}

function newSession(origin: string, kind: 'hls' | 'file', opts: BoostOpts, reason: string): BoostSession {
  return {
    id: randomUUID().replace(/-/g, '').slice(0, 16),
    origin,
    kind,
    referer: opts.referer,
    cookies: opts.cookies,
    userAgent: opts.userAgent,
    createdAt: Date.now(),
    lastAt: Date.now(),
    bytes: 0,
    reason,
    mode: 'auto',
    parallel: BOOST_PARALLEL,
    totalBytes: null,
    rangeOk: false,
    contentType: '',
    head: Buffer.alloc(0),
    mediaUrl: origin,
    segments: [],
    segCache: new Map(),
    segFetched: 0,
    segFailed: 0,
    segInflight: new Set(),
    playlists: new Map(),
    warmed: false,
    directRateBps: null,
    directTtfbMs: null,
    decisionMs: null,
    host: '',
    site: opts.referer ? hostOf(opts.referer) : '',
    degraded: null,
    lastFlushAt: 0,
    finalized: false
  }
}

export interface BoostOpts {
  referer?: string
  cookies?: string
  userAgent?: string
}

/**
 * 取一份播放列表文本：**VOD 走会话缓存**，直播每次都重新拉。
 *
 * 见 BoostSession.playlists 的说明 —— 这里是「播放器请求播放列表」和「预热时拉列表」
 * 共用的唯一入口，两边都过缓存才不会出现「预热拉过一遍、播放器再拉一遍」的重复往返。
 */
async function playlistText(s: BoostSession, url: string): Promise<string | null> {
  const hit = s.playlists.get(url)
  if (hit && Date.now() - hit.at < BOOST_PLAYLIST_TTL_MS) return hit.text
  const text = await httpText(url, headersFor(s))
  if (!text || !text.includes('#EXTM3U')) return text
  /*
   * 什么能缓存：
   *  · VOD 媒体列表（带 #EXT-X-ENDLIST）—— 内容不会变；
   *  · **主列表（带 #EXT-X-STREAM-INF）** —— 变体清单是站点固定的，直播也一样；
   *    ⚠️ 这一条是实测补上的：主列表本来永远不会有 ENDLIST，
   *    于是「播放器第一个请求」恰好永远缓存不中（自检记录里 localTtfbMs 1.6 秒就是这么来的）。
   * 直播的**媒体**列表不缓存（分片窗口会滚动，缓存住就是让播放器看旧片段）。
   */
  if (text.includes('#EXT-X-ENDLIST') || text.includes('#EXT-X-STREAM-INF')) {
    s.playlists.set(url, { text, at: Date.now() })
  }
  return text
}

/**
 * HLS：取播放列表（主列表就挑一个变体），把分片列表登记进会话。
 * 只读文本，很便宜；真正的开销在随后的分片预读。
 */
async function loadHlsPlaylist(s: BoostSession): Promise<boolean> {
  const text = await playlistText(s, s.mediaUrl)
  if (!text || !text.includes('#EXTM3U')) return false
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variant = pickVariant(text, s.mediaUrl)
    if (!variant) return false
    s.mediaUrl = variant
    const sub = await playlistText(s, variant)
    if (!sub || !sub.includes('#EXTM3U')) return false
    s.segments = parseSegments(sub, variant)
    return s.segments.length > 0
  }
  s.segments = parseSegments(text, s.mediaUrl)
  return s.segments.length > 0
}

async function httpText(url: string, headers: Record<string, string>): Promise<string | null> {
  try {
    const res = await axios.get<string>(url, {
      timeout: 12000,
      responseType: 'text',
      maxRedirects: 5,
      headers,
      ...buildProxyAgents(getSettings().proxy)
    })
    return typeof res.data === 'string' ? res.data : String(res.data ?? '')
  } catch (err) {
    log.append('warn', 'boost', `播放列表读取失败: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
    return null
  }
}

function parseSegments(text: string, base: string): HlsSegment[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const out: HlsSegment[] = []
  let dur = 0
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      dur = Number.parseFloat(line.slice(8)) || 0
      continue
    }
    if (!line || line.startsWith('#')) continue
    try {
      out.push({ url: /^https?:/i.test(line) ? line : new URL(line, base).toString(), dur })
    } catch {
      /* 相对地址解析失败就跳过这一片 */
    }
  }
  return out
}

/** 并发预读：把 index 起的前 window 片拉进缓存（单条在飞的分片只拉一次） */
function prefetchSegments(s: BoostSession, fromIndex: number, window = BOOST_PARALLEL): void {
  const inflightLimit = BOOST_PARALLEL
  for (let i = fromIndex; i < Math.min(s.segments.length, fromIndex + window); i++) {
    const seg = s.segments[i]
    if (!seg) continue
    if (s.segCache.has(seg.url) || s.segInflight.has(seg.url)) continue
    if (s.segInflight.size >= inflightLimit) return
    if (cacheBytes(s) >= BOOST_BUFFER_CAP_BYTES) return
    s.segInflight.add(seg.url)
    void fetchSegment(s, seg.url).finally(() => {
      s.segInflight.delete(seg.url)
    })
  }
}

function cacheBytes(s: BoostSession): number {
  let n = 0
  for (const v of s.segCache.values()) n += v.data.length
  return n
}

function evictCache(s: BoostSession): void {
  // 超过上限时按「最早进来的」丢，直到回到上限的 3/4（避免频繁抖动）
  if (cacheBytes(s) <= BOOST_BUFFER_CAP_BYTES) return
  const entries = [...s.segCache.entries()].sort((a, b) => a[1].at - b[1].at)
  const target = BOOST_BUFFER_CAP_BYTES * 0.75
  let bytes = cacheBytes(s)
  for (const [url, v] of entries) {
    if (bytes <= target) break
    s.segCache.delete(url)
    bytes -= v.data.length
  }
}

async function fetchSegment(s: BoostSession, url: string, timeoutMs = 25000): Promise<Buffer | null> {
  const t0 = Date.now()
  try {
    const res = await openStream(url, headersFor(s), { timeoutMs })
    if (res.status < 200 || res.status >= 400) {
      res.abort()
      s.segFailed += 1
      log.append('warn', 'boost', `分片取回失败 HTTP ${res.status}: ${url.slice(0, 100)}`)
      return null
    }
    const read = await readBounded(res.stream, 32 * 1024 * 1024, timeoutMs)
    if (read.data.length === 0) {
      s.segFailed += 1
      return null
    }
    s.segCache.set(url, { data: read.data, at: Date.now() })
    s.segFetched += 1
    evictCache(s)
    if (process.env.SAKANA_BOOST_VERBOSE) {
      console.log(`[boost] 分片 ${Math.round(read.data.length / 1024)}KB / ${Date.now() - t0}ms`)
    }
    return read.data
  } catch (err) {
    s.segFailed += 1
    if (process.env.SAKANA_BOOST_VERBOSE) {
      console.log(`[boost] 分片失败: ${String((err as Error)?.message ?? err).slice(0, 80)}`)
    }
    return null
  }
}

/**
 * 起播预热（用户要求：别让「开始播放就转圈」）。
 *
 * HLS：决策阶段取回的那一片留在缓存里（= 预热），决定加速后立刻并发预读后面 4 片，
 *       播放器第一次请求就命中本机；
 * file：先读最多 2MB 当头部缓冲，`/stream` 路由会把它直接吐给播放器（不回源、不重下）。
 * 两者都有**时间上限**：拿不到就带着已有数据起播（宁可少预热，也不能把起播拖慢）。
 */
async function warmSession(s: BoostSession): Promise<{ sample: ThroughputSample | null; ok: boolean; margin: number }> {
  if (s.kind === 'hls') {
    const ok = await loadHlsPlaylist(s)
    if (!ok) return { sample: null, ok: false, margin: 0 }
    /*
     * 测速：**只取第 1 片**，而且必须串行（= 播放器的取流方式）。
     *
     * 为什么只取一片：决策时间就是用户的等待时间。取两片在真实站点上要 2.4 秒
     * （MXdm 一片 1.2s），而取一片只要 0.7~1.3 秒，且这一片同样是预热缓冲。
     * 早先「头两片并发拉」还会把单连接速率量成 2 倍（阈值等于被偷偷改成 3MB/s）；
     * 现在改用「余量判据 + 速率判据」两条（见 @shared/streamBoost），单片样本也够用。
     */
    const first = s.segments[0]
    if (!first) return { sample: null, ok: false, margin: 0 }
    const budget = BOOST_WARM_MAX_MS + BOOST_MEASURE_MAX_MS
    const t0 = Date.now()
    let bytes = 0
    let ttfb: number | null = null
    {
      const st = Date.now()
      const data = await fetchSegment(s, first.url, budget)
      if (data) ttfb = Date.now() - st
      bytes += data?.length ?? 0
    }
    const ms = Math.max(1, Date.now() - t0)
    const margin = first.dur > 0 ? first.dur / (ms / 1000) : 0
    const sample: ThroughputSample = {
      ok: bytes > 0,
      status: 200,
      bytes,
      ms,
      ttfbMs: ttfb,
      rateBps: (bytes / ms) * 1000,
      rangeOk: true,
      totalBytes: null,
      contentType: 'application/vnd.apple.mpegurl',
      data: Buffer.alloc(0),
      note: `HLS 第 1 片（播放器式串行）${Math.round(bytes / 1024)}KB / ${(ms / 1000).toFixed(2)}s = ${Math.round(((bytes / ms) * 1000) / 1024)}KB/s，该片 ${first.dur.toFixed(1)}s → 余量 ${margin.toFixed(1)} 倍`
    }
    log.append('info', 'boost', `HLS 直连测速：${sample.note}`)
    return { sample, ok: sample.ok, margin }
  }
  /*
   * file：头 2MB 当预热缓冲（同时也是一次测速），但**硬卡时间**：
   * 预算内拿到多少就算多少。理由：
   *   · 时间上限保证「起播不会被预热拖慢」（最坏 2.5s，且这 2.5s 拉到的数据全部直接喂给播放器）；
   *   · 2MB 的目标保证快源上样本足够长，速率判据不会像小分片那样有个测不准的地板。
   */
  const sample = await measureThroughput(s.origin, headersFor(s), {
    maxBytes: 2 * 1024 * 1024,
    maxMs: BOOST_WARM_MAX_MS,
    keepData: true
  })
  s.rangeOk = sample.rangeOk
  s.totalBytes = sample.totalBytes
  s.contentType = sample.contentType
  s.head = sample.data
  log.append('info', 'boost', `直连测速：${sample.note}`)
  return { sample, ok: sample.ok, margin: 0 }
}

/**
 * 决策入口：enginePlay 在把地址交给 mpv 之前调它。
 *
 * 返回 `boosted: false` 时 `url` 为空串 —— 调用方继续用原地址，行为与没有这个功能时完全一致。
 */
export async function planStreamBoost(url: string, opts: BoostOpts = {}): Promise<BoostPlan> {
  const mode = boostMode()
  if (!/^https?:\/\//i.test(url)) return DIRECT('本地文件，不走在线加速', 'none')
  if (mode === 'off') return DIRECT(BOOST_MODE_LABEL.off, 'none')
  if (isLocalRelayUrl(url)) return DIRECT('本机中转地址，不再套一层加速', 'none')
  if (relayPort() <= 0) return DIRECT('本机中转服务未就绪，按直连播放', 'none')

  pruneSessions()
  stopAllBoost()
  const kind: 'hls' | 'file' = isHlsUrl(url) ? 'hls' : 'file'
  resetStats()
  sessionStartedAt = Date.now()
  /** 决策 + 预热的起算点：它会被如实记进优化记录（这一段是加速的真实成本） */
  const decisionStartAt = Date.now()

  const session = newSession(
    url,
    kind,
    opts,
    mode === 'force' ? '强制加速（设置里选择「强制加速」）' : '自动：正在测速'
  )
  sessions.set(session.id, session)

  let warm: { sample: ThroughputSample | null; ok: boolean; margin: number }
  try {
    warm = await warmSession(session)
  } catch (err) {
    warm = { sample: null, ok: false, margin: 0 }
    log.append('warn', 'boost', `预热异常，按直连播放: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
  }

  const sample = warm.sample
  const rate = sample?.rateBps ?? 0
  const rateText = `${Math.round(rate / 1024)}KB/s`

  if (!warm.ok || !sample) {
    sessions.delete(session.id)
    resetStats()
    sessionStartedAt = null
    log.append('warn', 'boost', `源站没取出数据（${sample?.note ?? '预热失败'}），按直连播放`)
    return DIRECT(`预热/测速失败（${sample?.note ?? '未取到数据'}），回退直连`, kind, sample)
  }

  if (mode === 'auto') {
    const rateFast = rate >= BOOST_FAST_BPS
    /*
     * HLS 用第二条判据：单连接取片的**实时余量**（该片时长 / 取回耗时 ≥ 10 倍）。
     * 见 @shared/streamBoost 里 BOOST_FAST_SEGMENT_MARGIN 的说明 ——
     * 小分片上的字节速率有个测不准的地板，只看速率会把「本来就很快的源」误判成慢；
     * 而余量判据同时能挡掉「全站限速但分片小到永远追得上」的那种源（加中转纯属白折腾）。
     */
    const marginFast = kind === 'hls' && warm.margin >= BOOST_FAST_SEGMENT_MARGIN
    if (rateFast || marginFast) {
      sessions.delete(session.id)
      resetStats()
      sessionStartedAt = null
      const reason = marginFast && !rateFast
        ? `直连单连接一片只用 ${(sample.ms / 1000).toFixed(2)}s（该片 ${(sample.ms / 1000 * warm.margin).toFixed(1)}s 时长，余量 ${warm.margin.toFixed(1)} 倍 ≥ ${BOOST_FAST_SEGMENT_MARGIN}），链路够快，不再加一层中转`
        : `直连实测 ${rateText}（≥ 阈值 ${Math.round(BOOST_FAST_BPS / 1024)}KB/s），不再加一层中转`
      log.append('info', 'boost', reason)
      return DIRECT(reason, kind, sample)
    }
  }

  if (kind === 'file' && !sample.rangeOk) {
    sessions.delete(session.id)
    resetStats()
    sessionStartedAt = null
    const reason = `源站不支持 Range（HTTP ${sample.status} 返回全量），并发分段无法进行，回退直连（实测 ${rateText}）`
    log.append('warn', 'boost', reason)
    return DIRECT(reason, kind, sample)
  }

  if (kind === 'hls') {
    // 决策阶段那片已在缓存里；这里把后面 4 片一起拉起来，播放器一开口就是本机命中
    prefetchSegments(session, 0, BOOST_PARALLEL)
  }
  session.reason =
    mode === 'force'
      ? `强制加速：并发 ${BOOST_PARALLEL} 路，测速 ${rateText}`
      : kind === 'hls'
        ? `自动：直连一片要 ${(sample.ms / 1000).toFixed(2)}s（该片 ${(sample.ms / 1000 * warm.margin).toFixed(1)}s，余量仅 ${warm.margin.toFixed(1)} 倍），已启用 ${BOOST_PARALLEL} 路并发预读`
        : `自动：直连实测 ${rateText}（< 阈值 ${Math.round(BOOST_FAST_BPS / 1024)}KB/s），已启用 ${BOOST_PARALLEL} 路并发分段中转`
  sessionStartedAt = Date.now()
  resetStats()
  /*
   * 优化记录的真实测量值：直连速率/首字节取决策阶段那一次实测（不是估算），
   * 决策耗时也记下来 —— 它是「加速换来更深缓冲」的代价，界面上要一并显示。
   * 片源域名用媒体列表/CDN 的 host（HLS 的 origin 可能是本机广告过滤地址，不能拿来当域名）。
   */
  session.directRateBps = Math.round(rate)
  session.directTtfbMs = sample.ttfbMs
  session.decisionMs = Date.now() - decisionStartAt
  session.mode = mode === 'force' ? 'force' : 'auto'
  session.host = hostOf(kind === 'hls' ? session.mediaUrl : url)
  const local = localUrl(session)
  log.append(
    'info',
    'boost',
    `加速中转已启用（${kind === 'hls' ? 'HLS 并发预读' : '并发 Range 分段'} ${BOOST_PARALLEL} 路，测速 ${rateText}）: ${url.slice(0, 100)} → ${local}`
  )
  setMetrics({ bytes: 0, rateBps: Math.round(rate), ttfbMs: sample.ttfbMs })
  return { url: local, kind, boosted: true, reason: session.reason, sample }
}

// ---------------- 本机 HTTP 处理 ----------------

const PATH_RE = /^\/boost\/([A-Za-z0-9_-]+)\/(index\.m3u8|v\.m3u8|seg|raw|stream)$/

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64url')
}

function b64urlDecode(s: string): string {
  try {
    return Buffer.from(s, 'base64url').toString('utf-8')
  } catch {
    return ''
  }
}

/** 只改写「播放列表里的地址」，媒体字节一个都不动 */
function rewritePlaylist(text: string, s: BoostSession): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  const proxyUri = (abs: string): string => `/boost/${s.id}/raw?u=${b64urlEncode(abs)}`
  const proxySeg = (abs: string): string => `/boost/${s.id}/seg?u=${b64urlEncode(abs)}`
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 里的 URI="..." 也要走本机，
      // 否则这些子资源仍由播放器直连（相对地址还会解析到 127.0.0.1 上而取不到）
      out.push(
        line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          let abs = uri
          try {
            abs = /^https?:/i.test(uri) ? uri : new URL(uri, s.mediaUrl).toString()
          } catch {
            /* 保留原文 */
          }
          return `URI="${proxyUri(abs)}"`
        })
      )
      continue
    }
    let abs = line
    try {
      abs = /^https?:/i.test(line) ? line : new URL(line, s.mediaUrl).toString()
    } catch {
      /* 保留原文 */
    }
    if (isHlsUrl(abs)) {
      // 变体播放列表（主列表 → 媒体列表）
      out.push(`/boost/${s.id}/v.m3u8?u=${b64urlEncode(abs)}`)
    } else {
      out.push(proxySeg(abs))
    }
  }
  return out.join('\n') + '\n'
}

function parseClientRange(
  header: string | undefined,
  total: number | null
): { start: number; end: number | null } | null {
  if (!header) return null
  const m = /bytes=(\d+)-(\d*)/.exec(header)
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] ? Number(m[2]) : total !== null ? total - 1 : null
  if (!Number.isFinite(start)) return null
  return { start, end }
}

/**
 * 文件型：并发 Range 分段拉取 → 按序汇流 → 从本机吐一条连续流。
 *
 * 关键点：
 * - 窗口式流水线（同时最多 `parallel` 个块在飞），**按块序写出**；
 * - 源站中途不认 Range / 出错 → 立刻退化成「单连接从当前位置继续」的透传，
 *   已经吐给播放器的字节不会重复也不会丢，播放不会断；
 * - 客户端断开（播放器 seek / 退出）→ 掐掉所有在飞请求，不留后台连接。
 */
async function serveFileStream(s: BoostSession, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const range = parseClientRange(req.headers.range, s.totalBytes)
  const start = Math.max(0, range?.start ?? 0)
  const end = range?.end ?? (s.totalBytes !== null ? s.totalBytes - 1 : null)

  /*
   * 回给播放器的响应头：播放器（libmpv/libcurl）要靠 `Accept-Ranges: bytes` 才能拖进度。
   * 总长度未知时用 RFC 7233 允许的 `bytes start-*​/*` 形式，仍然声明这是 206 部分内容 ——
   * 否则播放器会把「从 N 开始的一段」当成整个文件（拖进度会跳回开头）。
   */
  const headersOf: Record<string, string> = {
    'Content-Type': s.contentType ?? 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  }
  if (range) {
    headersOf['Content-Range'] = `bytes ${start}-${end === null ? '*' : end}/${s.totalBytes ?? '*'}`
  }
  if (end !== null) headersOf['Content-Length'] = String(Math.max(0, end - start + 1))
  res.writeHead(range ? 206 : 200, headersOf)

  const CHUNK = BOOST_CHUNK_BYTES
  const inflight = new Map<number, Promise<{ data: Buffer | null; status: number }>>()
  const liveStreams = new Set<Readable>()
  let aborted = false
  let written = 0
  const maxChunks = 512 // 单次请求最多拼 1GB，防止异常情况下无限跑
  res.on('close', () => {
    aborted = true
    for (const st of liveStreams) {
      try {
        st.destroy()
      } catch {
        /* ignore */
      }
    }
  })

  /*
   * 头部预热缓冲：预热已经拿到的那一段先直接吐给播放器（不回源、不重下）。
   * 之后的分块从 `base` 开始对齐 —— 这样预热下来的字节**一个都不会重复下载**。
   */
  let served = 0 // 已经从本机吐给播放器的字节
  /*
   * 所有「发给播放器的字节」都走这里：`s.bytes`（状态面板与会话活跃判据）与
   * `servedBytes`（速率/记录）必须一起加。
   * ⚠️ 这里踩过一次：整段文件这条路只加了速率用的 `servedBytes`，忘了 `s.bytes`，
   * 于是 file 形态在状态面板上永远显示「没有在加速」、优化记录也一条都写不出来
   * （`flushRecord` 的第一道闸就是 bytes > 0）。
   */
  const serve = (buf: Buffer): void => {
    s.bytes += buf.length
    noteServed(buf.length)
  }
  if (s.head.length > 0 && start < s.head.length) {
    const limit = end !== null ? end + 1 : s.head.length
    const slice = s.head.subarray(start, Math.min(s.head.length, limit))
    if (slice.length > 0) {
      served += slice.length
      serve(slice)
      if (!res.write(slice)) await new Promise<void>((resolve) => res.once('drain', () => resolve()))
    }
  }
  const base = start + served

  const fetchChunk = (index: number): Promise<{ data: Buffer | null; status: number }> => {
    const from = base + index * CHUNK
    const to = from + CHUNK - 1
    return new Promise((resolve) => {
      void (async () => {
        try {
          const r = await openStream(s.origin, headersFor(s), {
            range: `bytes=${from}-${to}`,
            timeoutMs: 30000
          })
          liveStreams.add(r.stream)
          const read = await readBounded(r.stream, CHUNK, 30000)
          liveStreams.delete(r.stream)
          resolve({ data: read.data.length > 0 ? read.data : null, status: r.status })
        } catch {
          resolve({ data: null, status: 0 })
        }
      })()
    })
  }

  /** 退化：从当前位置起用**单连接**继续（源站不认 Range 或并发段出错时用），播放不中断 */
  const degradeToPassthrough = async (offset: number, why: string): Promise<void> => {
    // 优化记录里要如实标出「这次中途退化成直连了」，否则用户会以为并发一直有效
    s.degraded = why
    log.append('warn', 'boost', `并发分段不可用（${why}），从 ${offset} 字节起退化为单连接直连`)
    try {
      const r = await openStream(s.origin, headersFor(s), {
        range: offset > 0 ? `bytes=${offset}-` : undefined,
        timeoutMs: 30000
      })
      r.stream.on('data', (c: Buffer) => {
        if (aborted) return
        written += c.length
        serve(c)
        if (!res.write(c)) r.stream.pause()
      })
      res.on('drain', () => r.stream.resume())
      const finish = (): void => {
        try {
          res.end()
        } catch {
          /* ignore */
        }
      }
      r.stream.on('end', finish)
      r.stream.on('error', finish)
    } catch (err) {
      log.append('warn', 'boost', `退化透传失败: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
  }

  /** 开一个分块请求（窗口上限 = 并发数；总在飞字节也受缓冲上限约束） */
  const startFetch = (index: number): void => {
    if (inflight.has(index)) return
    if (inflight.size >= s.parallel) return
    if (inflight.size * CHUNK >= BOOST_BUFFER_CAP_BYTES) return
    inflight.set(index, fetchChunk(index))
  }

  let nextIndex = 0
  /*
   * 先把并发窗口**填满**再开始等第一块。
   *
   * 这一行是实测逼出来的：早先只在循环里「用掉一块才补一块」，
   * 于是第一块（2MB）只能按单连接速度爬（受控源站 300KB/s 时要 7 秒），
   * 并发要等到第二块才见效 —— 自检里表现为 4 路并发只提升 49%，
   * 而 HLS 那条路（一次就把 4 片全发出去）是 +451%。差别就在这个窗口上。
   */
  for (let i = 0; i < s.parallel; i++) startFetch(i)
  while (!aborted && nextIndex < maxChunks) {
    const from = base + nextIndex * CHUNK
    if (end !== null && from > end) break
    startFetch(nextIndex)
    const p = inflight.get(nextIndex)
    if (!p) break
    const r = await p
    inflight.delete(nextIndex)
    if (aborted) return
    if (!r.data) {
      if (r.status === 416) break // 越过文件末尾：正常收尾，不是错误
      await degradeToPassthrough(from, `第 ${nextIndex + 1} 块无数据（HTTP ${r.status || '连接失败'}）`)
      return
    }
    if (r.status !== 206 && nextIndex > 0) {
      // 源站忽略了 Range：并发分段没意义，退化成单连接透传（续传位置 = 当前 from）
      await degradeToPassthrough(from, `源站忽略 Range（HTTP ${r.status} 全量返回）`)
      return
    }
    written += r.data.length
    serve(r.data)
    if (!res.write(r.data)) {
      await new Promise<void>((resolve) => res.once('drain', () => resolve()))
    }
    nextIndex += 1
    if (end !== null && from + r.data.length > end) break
    // 保持「写入位置之后始终有 parallel 块在飞」
    for (let i = nextIndex; i < nextIndex + s.parallel; i++) startFetch(i)
  }
  s.lastAt = Date.now()
  if (!aborted) {
    try {
      res.end()
    } catch {
      /* ignore */
    }
  }
  if (process.env.SAKANA_BOOST_VERBOSE) {
    console.log(`[boost] 文件流转发结束：${Math.round(written / 1024)}KB`)
  }
}

/** HLS 分片：命中预读缓存就直接给，没命中就现取（并继续向前预读） */
async function serveSegment(s: BoostSession, req: IncomingMessage, res: ServerResponse, target: string): Promise<void> {
  const index = s.segments.findIndex((x) => x.url === target)
  const range = req.headers.range
  // EXT-X-BYTERANGE 的分片：同一个文件的不同区间，直接带 Range 透传（不缓存，避免把整文件当一片）
  if (range) {
    const r = await openStream(target, headersFor(s), { range, timeoutMs: 25000 })
    const pass: Record<string, string> = {
      'Content-Type': String(r.headers['content-type'] ?? 'video/mp2t'),
      'Accept-Ranges': 'bytes'
    }
    for (const k of ['content-length', 'content-range'] as const) {
      const v = r.headers[k]
      if (v) pass[k === 'content-length' ? 'Content-Length' : 'Content-Range'] = String(v)
    }
    res.writeHead(r.status, pass)
    r.stream.on('data', (c: Buffer) => {
      s.bytes += c.length
      noteServed(c.length)
      if (!res.write(c)) r.stream.pause()
    })
    res.on('drain', () => r.stream.resume())
    r.stream.on('end', () => res.end())
    r.stream.on('error', () => res.end())
    return
  }

  let data = s.segCache.get(target)?.data ?? null
  if (!data) {
    // 可能正在预读：等一下它（最多 6 秒），避免同一片拉两遍
    if (s.segInflight.has(target)) {
      const t0 = Date.now()
      while (Date.now() - t0 < 6000 && !data) {
        await new Promise((r) => setTimeout(r, 60))
        data = s.segCache.get(target)?.data ?? null
        if (!s.segInflight.has(target)) break
      }
    }
    if (!data) data = await fetchSegment(s, target)
  }
  s.lastAt = Date.now()
  if (!data) {
    // 拿不到这一片只能回源让播放器自己取（比卡死强）
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  s.bytes += data.length
  noteServed(data.length)
  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes'
  })
  res.end(data)
  // 播放到第 N 片 → 立刻把 N+1…N+4 拉回来（并发在这里起作用）
  if (index >= 0) prefetchSegments(s, index + 1, BOOST_PARALLEL)
}

/** 播放列表 / 密钥 / init 段：原样透传（文本类的做地址改写） */
async function servePlaylistOrRaw(
  s: BoostSession,
  res: ServerResponse,
  target: string,
  kind: 'index' | 'variant' | 'raw'
): Promise<void> {
  try {
    if (kind === 'raw') {
      const r = await openStream(target, headersFor(s), { timeoutMs: 20000 })
      res.writeHead(r.status, {
        'Content-Type': String(r.headers['content-type'] ?? 'application/octet-stream'),
        'Cache-Control': 'no-store'
      })
      r.stream.on('data', (c: Buffer) => {
        if (!res.write(c)) r.stream.pause()
      })
      res.on('drain', () => r.stream.resume())
      r.stream.on('end', () => res.end())
      r.stream.on('error', () => res.end())
      return
    }
    // 走会话缓存（VOD）：播放器这一趟不该再向慢 CDN 要一遍列表，见 playlistText 的说明
    const text = await playlistText(s, target)
    if (!text) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('boost: upstream playlist failed')
      return
    }
    s.mediaUrl = target
    if (kind === 'variant' || !text.includes('#EXT-X-STREAM-INF')) {
      s.segments = parseSegments(text, target)
      if (s.segments.length > 0) prefetchSegments(s, 0, BOOST_PARALLEL)
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store'
    })
    res.end(rewritePlaylist(text, s))
  } catch (err) {
    log.append('warn', 'boost', `播放列表处理失败: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
    try {
      res.writeHead(502).end('boost: playlist error')
    } catch {
      /* ignore */
    }
  }
}

/**
 * 处理 `/boost/<id>/...`。返回 true 表示请求已由本模块接管。
 * 与 adFilter 一样挂在 transcode 的本机中转服务上（同一个端口，不新开第三个 server）。
 */
export function handleBoostRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const pathname = (req.url ?? '').split('?')[0]
  const m = PATH_RE.exec(pathname)
  if (!m) return false
  const s = sessions.get(m[1])
  if (!s) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('boost session gone')
    return true
  }
  s.lastAt = Date.now()
  if (boostMode() === 'off') {
    // 播放中途用户把加速关掉：不打断当前播放，继续供流（否则会直接卡死），
    // 但下一次播放不会再建会话 —— 与广告过滤的「关了就回源」不同，这里不能中途回源。
    s.reason = '加速已在设置里关闭（当前会话继续供流，下次播放生效）'
  }
  const route = m[2]
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const task = (async () => {
    try {
      if (route === 'stream') {
        await serveFileStream(s, req, res)
        return
      }
      if (route === 'seg') {
        const target = b64urlDecode(url.searchParams.get('u') ?? '')
        if (!target) {
          res.writeHead(400).end('bad segment')
          return
        }
        await serveSegment(s, req, res, target)
        return
      }
      if (route === 'raw') {
        const target = b64urlDecode(url.searchParams.get('u') ?? '')
        if (!target) {
          res.writeHead(400).end('bad uri')
          return
        }
        await servePlaylistOrRaw(s, res, target, 'raw')
        return
      }
      if (route === 'v.m3u8') {
        const target = b64urlDecode(url.searchParams.get('u') ?? '')
        if (!target) {
          res.writeHead(400).end('bad variant')
          return
        }
        await servePlaylistOrRaw(s, res, target, 'variant')
        return
      }
      await servePlaylistOrRaw(s, res, s.origin, 'index')
    } catch (err) {
      log.append('warn', 'boost', `加速中转请求失败: ${String((err as Error)?.message ?? err).slice(0, 140)}`)
      try {
        if (!res.headersSent) res.writeHead(502).end('boost failed')
        else res.end()
      } catch {
        /* ignore */
      }
    }
  })()
  void task
  return true
}

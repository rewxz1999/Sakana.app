import axios, { type AxiosResponse } from 'axios'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { open as openFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import { resolveTempMediaCacheEpisodes } from '@shared/mediaCache'
import { resolveSniffSettings, tuneConnections, type SniffSettings } from '@shared/sniff'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import { dataPaths } from './paths'
import { addRangeTo, availableEndOf, cachedBytesOf, nextRangeStart } from './mediaCacheCoverage'
import { markCacheTiming, playTimingStartedAt } from './playTiming'

/**
 * 本地临时缓存（边下边播，v1.4）。
 *
 * ## 它解决的是什么
 *
 * 以前候选直链是**原样交给内核**的：内核每读一段都受上游那条连接当次的延迟与抖动影响，
 * 拖动进度时还要再等一次 CDN 往返。用户的原话是
 * 「先将资源临时缓存到本地，缓存多少播多少……播放速度就源自缓存资源的速度」。
 *
 * 所以这里的形状是：
 *   候选地址 → 本服务按顺序拉上游字节 → 写进 `<缓存根>/tmp-media/media-<id>.bin`
 *            → 本机 HTTP（/cache/<id>/media.xxx）把**已落盘的部分**喂给播放器
 *
 * 播放器（libmpv）看到的是一个支持 Range 的普通 HTTP 资源：
 *   · 已经缓存到的区间：立即从磁盘返回（拖动、重播都只读磁盘）；
 *   · 还没缓存到的位置：等上游写进来（这就是「缓存多少播多少」）；
 *   · 总长度已知时透传 `Content-Length` / `Content-Range`，内核据此获得可 seek 的时长。
 *
 * ## 为什么复用 transcode.ts 的本机中转监听，而不另起一个服务
 *
 * 那个监听已经在应用启动时起好、退出时统一关闭，也被 HLS 广告过滤与加速中转共用
 * （见 transcode.initLiveServer 的注释）。再开一个端口会多一套生命周期要维护：
 * 端口冲突、退出没关、日志里多一个内部地址 —— 都是已经踩过的坑。
 * 这里只按路径前缀 `/cache/` 接管请求，端口由 transcode 注入（避免模块循环依赖）。
 *
 * ## 三条硬约束
 *
 * 1. **不许因为它播不了**：目录/写盘/上游任何一步失败，都会通知播放层回退直连原地址
 *    （见 onTempMediaCacheFailure），失败会话本身也还能继续读出已缓存的前缀。
 * 2. **HLS 不进这条链**：m3u8 是「一个列表 + 很多独立分片」，整段字节缓存对它没有意义，
 *    而且分片相对地址会解析到本机服务上直接失效。所以只缓存整段文件，HLS 仍走原有链路。
 * 3. **生命周期只到关应用为止**：启动清一次、退出清一次（见 initTempMediaCache /
 *    releaseTempMediaCacheOnQuit），缓存目录固定是数据根下的 cache/tmp-media，
 *    用户不需要（也不应该）自己去删。
 *
 * ## 红线
 *
 * 本文件所有日志都走 `log.append`，并且**不打印本机地址/上游完整地址**：
 * 只写会话 id、字节数、耗时与失败原因。原因文本里的 URL 也会先被抹掉。
 */

/* ───────────────────────── 口径与常量 ───────────────────────── */

/** 缓存目录名（在缓存根下；缓存根默认是 <数据根>/cache，见 settingsExt.cacheRoot） */
const CACHE_DIR_NAME = 'tmp-media'

/** 临时文件名前缀：启动清理只认这个前缀，避免误删同目录里别人的东西 */
const FILE_PREFIX = 'media-'

/**
 * 等上游响应头的上限。
 *
 * 为什么是 8 秒：它必须明显短于播放层「注入播放器」的 15 秒看门狗，
 * 否则缓存失败时已经没有时间让直连再试一次 —— 用户等满 15 秒后只得到一句失败。
 * 8 秒没拿到响应头，5 秒零字节换候选通常已经先动过一轮；这里再回退直连，
 * 仍留 7 秒给直连出首帧。慢到 8 秒还没响应头的源，直连也不会更快。
 */
const UPSTREAM_HEADER_TIMEOUT_MS = 8_000

/** 播放器来取数据时，最多等这么久「响应头就绪」（之后回 504，让内核自己重试/由看门狗收尾） */
const CLIENT_HEADER_TIMEOUT_MS = 12_000

/** 等已经落盘的字节时，单次等待切片（到点后重新检查状态，避免丢唤醒就永久挂住） */
const WAIT_SLICE_MS = 500

/** 一次从磁盘读给播放器的块大小：256KB 在吞吐与内存之间够用（同时最多一个客户端一份） */
const READ_CHUNK = 256 * 1024

/**
 * 上游写盘队列的高/低水位（字节）。
 *
 * 上游是事件流、磁盘写入是异步的：不设水位时，一个 200MB 的快速源会在内存里堆满待写块。
 * 高水位暂停上游读取、低水位恢复 —— 内存上限约 8MB，同时不会因为一次 GC 就频繁暂停。
 */
const WRITE_QUEUE_HIGH = 8 * 1024 * 1024
const WRITE_QUEUE_LOW = 2 * 1024 * 1024

/**
 * 单个客户端「一直等不到新字节」的上限。
 *
 * 正常播放时这个等待是毫秒级的（写盘比播放快得多）；真的挂住说明上游已经停了很久。
 * 这里主动断开，让内核按自己的重试/换候选流程走，而不是抱着一条永远不动的连接。
 */
const CLIENT_STALL_DROP_MS = 60_000

/**
 * 上游「已给响应头、但正文不再有字节」多久算死。
 *
 * 为什么要单独一条：换候选之后（内核已经改直连）缓存会话不再有读者，
 * 若上游是「连上了但永远不吐数据」的形状，它会一直挂着占一个集数名额。
 * 90 秒足够跨过 CDN 的正常抖动，又不会让僵尸会话活到应用退出。
 */
const UPSTREAM_STALL_MS = 90_000

/** 检查上游停滞的间隔（独立于数据事件，避免「没有数据就永远不检查」） */
const STALL_CHECK_MS = 15_000

/**
 * 「播放器要的位置比已缓存区远这么多」时改走上游 Range 直供（不写缓存）。
 *
 * 为什么需要它（真实世界的形状）：非 faststart 的 MP4 把 moov 放在文件尾部，
 * 播放器一上来就会请求最后几 MB 来读索引；如果让我们「等缓存按顺序爬到末尾」，
 * 用户会先黑屏几十秒到几分钟 —— 那比直连还慢。
 *
 * 所以规则是：**近处的缺口等缓存（毫秒级），远处的跳转直接向源站要那一段**。
 * 代价是那一段不落盘，但它本来就不是顺序播放要用的数据；顺序播放仍然只读磁盘。
 */
const UNCACHED_JUMP_BYTES = 1024 * 1024

/**
 * 单个文件允许缓存的最大字节数（8GB）。
 *
 * 为什么要这道闸：临时文件是**按整集落盘**的，一集 20GB 的片源会把 3 集名额变成 60GB，
 * 用户的硬盘可能在毫无提示的情况下被写满。常见番剧一集 200MB~1.5GB，8GB 已经留了足够余量；
 * 超过就按直连处理（播放不受影响，只是不享受缓存）。
 */
const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024 * 1024

/** 文件扩展名白名单：写进本机地址，让 mpv 不必只靠内容探测来选 demuxer */
const KNOWN_EXT = new Set([
  'mp4',
  'm4v',
  'mov',
  'mkv',
  'webm',
  'flv',
  'ts',
  'm2ts',
  'avi',
  'wmv',
  'mpg',
  'mpeg',
  '3gp',
  'ogv'
])

/* ───────────────────────── 类型 ───────────────────────── */

type CacheState = 'opening' | 'streaming' | 'done' | 'paused' | 'failed' | 'closed'

interface CacheSession {
  id: string
  /** 同一路（地址+头）去重：重播/拖回来时复用已缓存的文件，而不是重新拉一遍 */
  key: string
  directUrl: string
  referer?: string
  cookies?: string
  userAgent?: string
  file: string
  ext: string
  createdAt: number
  lastUsedAt: number
  state: CacheState
  /** 失败原因（人话；写日志前会抹掉 URL） */
  error: string
  /** 已可靠落盘的字节数：客户端只能读到这个位置之前（写完才推进，避免读到半块） */
  received: number
  /** 上游响应给出的总字节数；未知（chunked）时为 null */
  total: number | null
  contentType: string
  /** 上游首个正文字节到达的时刻（0=还没到） */
  firstUpstreamByteAt: number
  /** 本机第一次把字节交给播放器的时刻（0=还没发生） */
  firstClientByteAt: number
  /** 正在读这个会话的客户端数量（>0 时 LRU 不淘汰它） */
  clients: number
  /** 等待状态变化的读方（新字节/结束/失败） */
  waiters: Set<() => void>
  abort: AbortController | null
  upstream: Readable | null
  writeFh: FileHandle | null
  /** 上游响应已结束、但待写队列还没排空 */
  upstreamEnded: boolean
  /** 上一次收到上游正文字节的时刻（停滞看门狗用） */
  lastDataAt: number
  /** 停滞看门狗 */
  stallTimer: NodeJS.Timeout | null
  /** 「已完整落盘」的日志只写一次 */
  completionLogged: boolean
  /*
   * ── V1.5.1：Range 多连接分段下载（「嗅探设置」里的加速）──
   *
   * 形状：主链路负责 [0, primaryEnd)（播放器最先要的那一段，保持原来的顺序语义），
   * 其余字节由 N-1 个 worker 各自用 Range 并行拉取、按**绝对偏移**写进同一个文件。
   * 于是「播放起播」仍由顺序主链路保证（不会被并行打乱），而整集的落盘速度是原来的 N 倍左右。
   *
   * ranges 只记**已经完整落盘**的分段（半截分段不能算可用，否则播放器会读到空洞）。
   */
  ranges: { start: number; end: number }[]
  /** 本次会话使用的分段数（1 = 纯单连接，没有并行） */
  segments: number
  /** 主链路只拉到这个位置（闭开）；null = 一直拉到文件末尾 */
  primaryEnd: number | null
  /** 本轮主链路是从哪个字节开始写的（收尾时要把它记成一段） */
  primaryStart: number
  /** 分段 worker 的取消器 */
  segmentAbort: AbortController | null
  /** 还在跑的分段 worker 数量（归零后统一检查是否补缺口） */
  segmentActive: number
  /** 是否已经有 repair 在补缺口（防止并发补同一段） */
  repairing: boolean
  /**
   * 本轮从上游实际写进文件的字节数（含并行分段里"还没写完的那一段"已经落盘的部分）。
   *
   * 为什么需要它：进度百分比用 `cachedBytesOf`（只有**完整**分段才算缓存好），
   * 但速率必须用这个增量 —— 否则一段 150MB 的分段完成时，进度会在一瞬间跳 150MB，
   * 界面上就会闪出一个"几百 MB/s"的假速度。用"每写一块就+1"的计数器算速率才是真实吞吐。
   */
  writtenBytes: number
  /**
   * V1.5.1：播放器此刻正在等这一集补字节（读到还没缓存到的位置）。
   *
   * 由本机 HTTP 服务在"要读的位置还没有数据"时置位、读到新数据时清零。
   * 界面拿它显示「正在加载中…」—— 这比按时间猜缓冲准确：它就是"卡在没缓存的地方"本身。
   */
  waitingForBytes: boolean
}

export interface TempMediaCacheStartInput {
  url: string
  referer?: string
  cookies?: string
  userAgent?: string
}

export interface TempMediaCacheStartResult {
  ok: boolean
  /** ok=true 时是本机播放地址（不要写进日志） */
  url: string
  sessionId: string
  /** 没启用/启动失败的原因（人话，给播放层写日志用） */
  reason: string
  /** 复用了一个已存在的缓存会话（同一集重播/拖回） */
  reused: boolean
}

export interface TempMediaCacheFailure {
  sessionId: string
  /** 原始直链：回退时交给内核用（不要写进日志） */
  directUrl: string
  referer?: string
  cookies?: string
  /** 失败原因（人话，可直接进日志） */
  reason: string
}

/* ───────────────────────── 状态 ───────────────────────── */

const sessions = new Map<string, CacheSession>()
const failureHandlers = new Set<(f: TempMediaCacheFailure) => void>()

/** 本机中转端口（由 transcode.initLiveServer 注入；0 = 未就绪） */
let relayPort = 0

export function setMediaCachePort(port: number): void {
  relayPort = port > 0 ? port : 0
}

/* ───────────────────────── 小工具 ───────────────────────── */

/** 缓存根：settings.cacheDir 优先，留空用数据根下的 cache（与设置页「缓存设置」同一位置） */
function cacheRootDir(): string {
  /*
   * 这里不直接 import settingsExt.cacheRoot：settingsExt → media → transcode → mediaCache
   * 会形成模块循环（media 需要 transcode 的 liveStream）。两行的规则完全相同，
   * 所以在本文件重算一遍，换来一条没有环的依赖链。
   */
  const custom = (getSettings().cacheDir ?? '').trim()
  return custom || dataPaths().cache
}

/** 临时缓存目录（固定 <缓存根>/tmp-media，关闭应用时整目录删除） */
export function tempMediaCacheDir(): string {
  return join(cacheRootDir(), CACHE_DIR_NAME)
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 上游错误信息：把地址抹掉再进日志（红线：日志里不许出现内部/源站完整地址） */
function shortError(err: unknown): string {
  const anyErr = err as { code?: string; message?: string }
  const raw = String(anyErr?.message ?? err ?? '')
    .replace(/https?:\/\/\S+/gi, '<地址>')
    .replace(/\s+/g, ' ')
    .trim()
  const code = String(anyErr?.code ?? '').trim()
  const text = code && !raw.includes(code) ? `${code} ${raw}` : raw
  return text.slice(0, 120) || '未知错误'
}

function headerValue(headers: Record<string, unknown>, name: string): string {
  const v = headers[name.toLowerCase()] ?? headers[name]
  if (Array.isArray(v)) return String(v[0] ?? '')
  return v == null ? '' : String(v)
}

function guessExt(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const m = /\.([a-z0-9]{2,4})$/i.exec(pathname)
    const ext = (m?.[1] ?? '').toLowerCase()
    return KNOWN_EXT.has(ext) ? `.${ext}` : ''
  } catch {
    return ''
  }
}

function sessionLocalUrl(s: CacheSession): string {
  if (relayPort <= 0) return ''
  return `http://127.0.0.1:${relayPort}/cache/${s.id}/media${s.ext}`
}

/** 本机地址只用于交给内核；日志里一律不出现（见文件头红线） */
function logSession(s: CacheSession, level: 'info' | 'warn' | 'error', message: string): void {
  log.append(level, 'cache', `${message}（会话 ${s.id.slice(0, 8)}）`)
}

function maxEpisodes(): number {
  return resolveTempMediaCacheEpisodes(getSettings().tempMediaCacheEpisodes)
}

/**
 * 这个地址要不要走本地缓存。
 *
 * 返回空串 = 可以；否则是人话原因（播放层会照着写一行「未启用」的日志）。
 * 判据保守：只要拿不准就不缓存 —— 这是「不能因为它播不了」的第一道闸。
 */
export function tempMediaCacheEligibility(url: string): string {
  if (!/^https?:\/\//i.test(url)) return '不是 HTTP(S) 地址（本地文件或自定义协议）'
  if (!cacheEnabledByEnv()) return '已通过环境变量关闭（SAKANA_TEMP_CACHE=0）'
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return '地址无法解析'
  }
  const host = u.hostname.toLowerCase()
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') {
    /*
     * 本机地址说明它已经是「HLS 改写 / 加速中转 / 临时缓存自己」的地址，不能再套一层
     * （否则会把本机转发当成上游，既不提速还可能递归）。
     *
     * 唯一的例外是计时/自检脚本：它必须用本机 HTTP fixture 才能可复现地量真实字节，
     * 所以给一个**只由脚本设置**的环境变量开口子；正常启动永远没有这个变量。
     */
    if (String(process.env.SAKANA_TEMP_CACHE_ALLOW_LOOPBACK ?? '') !== '1') {
      return '地址已经指向本机中转（HLS 改写/加速中转），不再套一层'
    }
  }
  // 整段字节缓存只对「一个连续文件」有意义；分片列表交给原有链路处理
  if (/\.m3u8/i.test(u.pathname)) {
    return '这是 HLS 播放列表（按分片直连，不做整段缓存）'
  }
  return ''
}

/**
 * 自检开关：`SAKANA_TEMP_CACHE=0` 关闭（用于「改前/改后」用同一份代码对照计时）。
 * 默认开启 —— 设置页只暴露「集数」，不暴露总开关。
 */
function cacheEnabledByEnv(): boolean {
  const env = String(process.env.SAKANA_TEMP_CACHE ?? '').trim().toLowerCase()
  if (env === '0' || env === 'off' || env === 'false') return false
  /*
   * V1.2.8：设置里的 **集数 0 = 关闭临时缓存**。
   *
   * 为什么把"关闭"做进这里而不是只改界面：`startTempMediaCache` 的第一道闸就是
   * `tempMediaCacheEligibility`，所有播放路径都会经过它；在这里判 0，等于"关了就真的
   * 全程直连原地址"，也方便排查"缩略图白窗是不是缓存服务造成的"。
   */
  try {
    if (resolveTempMediaCacheEpisodes(getSettings().tempMediaCacheEpisodes) === 0) return false
  } catch {
    /* 读取设置失败时按"开启"处理，保持原行为 */
  }
  return true
}

/* ───────────────────────── 会话激活/唤醒 ───────────────────────── */

function waitForChange(s: CacheSession, timeoutMs = WAIT_SLICE_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | null = null
    const fire = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      s.waiters.delete(fire)
      resolve()
    }
    timer = setTimeout(fire, timeoutMs)
    s.waiters.add(fire)
  })
}

function wake(s: CacheSession): void {
  for (const fn of [...s.waiters]) {
    try {
      fn()
    } catch {
      /* 单个等待者的异常不能影响其它读方 */
    }
  }
  s.waiters.clear()
}

function touch(s: CacheSession): void {
  s.lastUsedAt = Date.now()
}

/** 停掉上游停滞看门狗（结束/暂停/回收时必须调，否则定时器会拖到进程退出） */
function clearStall(s: CacheSession): void {
  if (s.stallTimer) clearInterval(s.stallTimer)
  s.stallTimer = null
}

/** 启动上游停滞看门狗（见 UPSTREAM_STALL_MS 的说明） */
function startStallWatch(s: CacheSession): void {
  clearStall(s)
  s.lastDataAt = Date.now()
  const timer = setInterval(() => {
    if (s.state !== 'streaming') {
      clearStall(s)
      return
    }
    const idle = Date.now() - s.lastDataAt
    if (idle < UPSTREAM_STALL_MS) return
    failSession(s, `上游 ${Math.round(UPSTREAM_STALL_MS / 1000)} 秒没有新数据（已落盘 ${fmtBytes(s.received)}）`)
  }, STALL_CHECK_MS)
  // 不让一个纯诊断用的定时器把进程退出拖住
  timer.unref?.()
  s.stallTimer = timer
}

/**
 * 读会话状态。
 *
 * 为什么绕一层函数：这个模块里状态会被**异步**改（暂停/失败/结束时另一个出口在写），
 * 而 TypeScript 在 `s.state = 'opening'` 之后会把后续比较全部窄化成 'opening'，
 * 于是「此刻可能已经是 paused/failed」的判断会被判成恒假。函数调用会打断这种窄化，
 * 让类型检查如实反映「状态随时可能被别处改」。
 */
function sessionState(s: CacheSession): CacheState {
  return s.state
}

/* ───────────────────────── 失败与回收 ───────────────────────── */

/**
 * 会话失败：通知播放层回退直连（这是「不能因此播不了」的核心动作）。
 *
 * 注意**不删文件**：已经缓存的字节对正在等数据的客户端仍然有价值（它可能刚好读完前缀），
 * 文件会交给 LRU/退出清理回收。失败只发生一次，避免重复回退把内核来回切。
 */
function failSession(s: CacheSession, reason: string): void {
  /*
   * paused：主动暂停时会 abort 上游，axios 随即抛 ERR_CANCELED 并触发 stream 'error'。
   * 那是**我们自己掐的**，不是上游故障 —— 若当成失败，退出播放器/切集就会白触发一次
   * 「回退直连」，把用户刚离开的播放重新拉起来。
   */
  if (
    s.state === 'failed' ||
    s.state === 'done' ||
    s.state === 'closed' ||
    s.state === 'paused'
  ) {
    return
  }
  s.state = 'failed'
  // V1.5.1：并行分段也要一起停（否则会话失败了 worker 还在往文件里写）
  abortSegments(s, '会话失败')
  s.error = reason
  clearStall(s)
  s.abort?.abort()
  s.abort = null
  try {
    s.upstream?.destroy()
  } catch {
    /* ignore */
  }
  s.upstream = null
  const fh = s.writeFh
  s.writeFh = null
  if (fh) void fh.close().catch(() => undefined)
  wake(s)
  logSession(s, 'warn', `本地临时缓存失败：${reason}`)
  const evt: TempMediaCacheFailure = {
    sessionId: s.id,
    directUrl: s.directUrl,
    referer: s.referer,
    cookies: s.cookies,
    reason
  }
  for (const cb of [...failureHandlers]) {
    try {
      cb(evt)
    } catch (err) {
      log.append('warn', 'cache', `缓存失败回调异常（已忽略）：${shortError(err)}`)
    }
  }
  /*
   * 一个字节都没写成功就失败（403/超时/写盘打不开）：立刻删文件并退出会话表。
   * 否则「连续点几集坏源」会用 0 字节的失败会话占满集数名额，把真正缓存好的剧集挤掉。
   */
  if (s.received === 0) {
    sessions.delete(s.id)
    try {
      unlinkSync(s.file)
    } catch {
      /* ignore */
    }
  }
}

/** 丢弃会话（可选删文件）：供 LRU 淘汰与退出清理使用，不触发回退 */
function dropSession(s: CacheSession, deleteFile: boolean): void {
  if (s.state === 'closed') return
  s.state = 'closed'
  clearStall(s)
  // V1.5.1：先停并行分段，再关主链路（顺序反了 worker 可能还会写一次到已删文件）
  abortSegments(s, '会话被回收')
  s.abort?.abort()
  s.abort = null
  try {
    s.upstream?.destroy()
  } catch {
    /* ignore */
  }
  s.upstream = null
  const fh = s.writeFh
  s.writeFh = null
  if (fh) void fh.close().catch(() => undefined)
  wake(s)
  sessions.delete(s.id)
  if (deleteFile) {
    try {
      unlinkSync(s.file)
    } catch {
      /* 文件可能已被系统清掉 */
    }
  }
}

/**
 * LRU 淘汰：超过设置里的集数时，删掉「最久没有被播放器读过」的那一集。
 *
 * 为什么排除当前会话与有活动客户端的会话：淘汰正在喂数据的文件会造成播放中断，
 * 那不是「省空间」而是制造故障；没有可淘汰对象时宁可暂时超限（下一次切集会再淘汰）。
 */
function evictIfNeeded(keepId: string): void {
  const max = maxEpisodes()
  while (sessions.size > max) {
    const candidates = [...sessions.values()].filter((s) => s.id !== keepId && s.clients === 0)
    if (candidates.length === 0) {
      log.append('warn', 'cache', `临时缓存已有 ${sessions.size} 集（上限 ${max}），但当前都在使用中，暂不淘汰`)
      return
    }
    candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    const victim = candidates[0]
    const size = Math.max(victim.received, 0)
    dropSession(victim, true)
    log.append(
      'info',
      'cache',
      `临时缓存超出上限（最多 ${max} 集），已淘汰最久未用的一集（释放 ${fmtBytes(size)}；会话 ${victim.id.slice(0, 8)}）`
    )
  }
}

/* ───────────────────────── 生命周期 ───────────────────────── */

/**
 * 启动时清一次残留（用户要求「启动清一次 + 退出清一次，防崩溃残留」）。
 *
 * 为什么整目录删除而不是只删旧文件：tmp-media 是本模块独占的目录，
 * 上次被强杀时可能留下写了一半的 .bin；逐个判断大小/年龄反而更容易漏。
 */
export function initTempMediaCache(): void {
  // 极端情况下启动清理可能与「第一次播放」并发（动态 import 刚 resolve 就有人点了播放）：
  // 已经有会话时绝不能再删目录，否则会把正在写的文件一起删掉。
  if (sessions.size > 0) return
  const dir = tempMediaCacheDir()
  let files = 0
  let bytes = 0
  try {
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(FILE_PREFIX)) continue
        try {
          const st = statSync(join(dir, name))
          if (st.isFile()) {
            files += 1
            bytes += st.size
          }
        } catch {
          /* 统计失败不影响清理 */
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    log.append('warn', 'cache', `启动清理临时缓存失败（不影响播放，失败时会自动回退直连）：${shortError(err)}`)
    return
  }
  if (files > 0) {
    log.append('info', 'cache', `启动清理：已删除上次残留的 ${files} 个临时缓存文件（${fmtBytes(bytes)}）`)
  } else {
    log.append('info', 'cache', `本地临时缓存目录已就绪（最多保留 ${maxEpisodes()} 集，关闭应用时自动清空）`)
  }
}

/**
 * 退出时释放全部临时缓存（用户要求「关闭应用后释放缓存的视频资源」）。
 *
 * 同步实现：`before-quit` 的回调不是 async，Electron 不会等 Promise；
 * 这里只有「abort + close + rm」这些立即返回的动作，删目录交给系统完成。
 */
export function releaseTempMediaCacheOnQuit(): void {
  const t0 = Date.now()
  let files = 0
  let bytes = 0
  for (const s of [...sessions.values()]) {
    files += 1
    bytes += Math.max(0, s.received)
    /*
     * 逐个删文件，而不是只删「当前缓存根」的目录：
     * 用户可能中途改过 settings.cacheDir，旧会话的文件就在旧目录里；
     * dropSession 用的是会话自己的绝对路径，能一并释放掉。
     */
    dropSession(s, true)
  }
  sessions.clear()
  /*
   * V1.2.7：**目录删除不再同步做**。
   *
   * 真机上（Application Hang，Event 1002，AppHangB1）出现过"退出播放/退出应用时整个窗口卡死"。
   * 这里原来的 `rmSync(dir, {recursive:true})` 会在主线程上把几十上百 MB 的临时文件逐个删除 ——
   * Windows 上删大文件要等文件句柄释放，几百毫秒到数秒都可能，正好超过 Windows 判定
   * "无响应"的 5 秒阈值。现在把删除挪到一个**独立的一轮事件循环之后**，
   * 主线程先把退出流程走完；日志记下我们自己的耗时，下一次卡住时能直接区分
   * "是我们删文件慢"还是"别的同步操作慢"。
   */
  const dir = tempMediaCacheDir()
  setTimeout(() => {
    const t1 = Date.now()
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      log.append('warn', 'cache', `退出清理临时缓存目录失败：${shortError(err)}`)
    }
    log.append(
      'info',
      'cache',
      `退出清理：已释放 ${files} 个临时缓存文件（${fmtBytes(bytes)}），目录已清空（同步部分 ${t1 - t0}ms，删除耗时 ${Date.now() - t1}ms）`
    )
  }, 0)
}

/* ───────────────────────── 启动一个缓存会话 ───────────────────────── */

function keyOf(input: TempMediaCacheStartInput): string {  return createHash('sha1')
    .update(`${input.url}\n${input.referer ?? ''}\n${input.cookies ?? ''}`)
    .digest('hex')
    .slice(0, 20)
}

function findByKey(key: string): CacheSession | null {
  for (const s of sessions.values()) {
    if (s.key === key && s.state !== 'closed') return s
  }
  return null
}

/**
 * 起一个本地缓存会话（同步返回，真正的上游拉取在后台）。
 *
 * 为什么同步：播放层要在「交给内核 loadfile」那一刻就拿到本机地址，
 * 不能为了等上游响应头把起播再推后几秒 —— 那正好是这次工单要消灭的等待。
 * 所以这里只做「建文件 + 登记会话 + 把上游请求发出去」，上游失败再通过
 * onTempMediaCacheFailure 通知播放层回退直连。
 */
export function startTempMediaCache(input: TempMediaCacheStartInput): TempMediaCacheStartResult {
  const reject = (reason: string): TempMediaCacheStartResult => ({ ok: false, url: '', sessionId: '', reason, reused: false })
  if (relayPort <= 0) return reject('本机缓存服务未就绪（HTTP 监听未启动）')
  const ineligible = tempMediaCacheEligibility(input.url)
  if (ineligible) return reject(ineligible)

  const key = keyOf(input)
  const existing = findByKey(key)
  if (existing && existing.state === 'failed') {
    // 同一集上次失败（坏源/写盘错误）：旧文件没有复用价值，清掉重新开一个会话
    dropSession(existing, true)
  } else if (existing) {
    touch(existing)
    if (existing.state === 'paused') {
      /*
       * 暂停时可能已经拉到文件末尾（上游刚好结束、finishUpstream 还没来得及跑）。
       * 这时不能再发 Range（bytes=<total>- 会得到 416），直接按「已完整」处理，
       * 否则一份完整文件会被误判成坏源、白白触发回退。
       */
      if (
        existing.received > 0 &&
        (existing.total === null ? existing.upstreamEnded : availableEndOf(existing, 0) >= existing.total)
      ) {
        existing.state = 'done'
        if (existing.total === null) existing.total = existing.received
        const fh = existing.writeFh
        existing.writeFh = null
        if (fh) void fh.close().catch(() => undefined)
        wake(existing)
        logSession(existing, 'info', `复用的临时缓存其实已完整（${fmtBytes(existing.received)}），直接只读本地文件`)
      } else {
        /*
         * 上一轮离开这一集时暂停了后台拉取：重播时从已落盘的位置继续。
         * V1.5.1：续传一律**回到单连接**，并丢掉内存里的分段记录 —— 分段记录只对"本次这一轮"
         * 有效，续传时若还按它判断可用区，播放器可能读到上次没真正写完的区域。
         */
        abortSegments(existing, '重播/续传')
        existing.ranges = []
        existing.primaryEnd = null
        existing.primaryStart = existing.received
        existing.repairing = false
        void pullUpstream(existing, existing.received)
        logSession(existing, 'info', `复用已暂停的临时缓存并继续拉取（已落盘 ${fmtBytes(existing.received)}）`)
      }
    } else if (existing.state === 'opening' || existing.state === 'streaming') {
      logSession(existing, 'info', `复用正在拉取的临时缓存（已落盘 ${fmtBytes(existing.received)}）`)
    } else {
      logSession(existing, 'info', `复用已完整缓存的剧集（${fmtBytes(existing.received)}）：本次播放只读本地文件`)
    }
    return { ok: true, url: sessionLocalUrl(existing), sessionId: existing.id, reason: '', reused: true }
  }

  const dir = tempMediaCacheDir()
  const id = randomUUID().replace(/-/g, '').slice(0, 16)
  const file = join(dir, `${FILE_PREFIX}${id}.bin`)
  const localUrl = `http://127.0.0.1:${relayPort}/cache/${id}/media${guessExt(input.url)}`
  if (!localUrl) return reject('本机缓存地址生成失败（服务端口已失效）')
  try {
    mkdirSync(dir, { recursive: true })
    // 先真的写一个空文件：目录只读/磁盘满会在这里就暴露，
    // 而不是等播放器已经指向本机地址、拉到一半才发现写不进去。
    writeFileSync(file, Buffer.alloc(0))
  } catch (err) {
    return reject(`临时缓存目录不可用（${shortError(err)}）`)
  }

  const now = Date.now()
  const s: CacheSession = {
    id,
    key,
    directUrl: input.url,
    referer: input.referer,
    cookies: input.cookies,
    userAgent: input.userAgent,
    file,
    ext: guessExt(input.url),
    createdAt: now,
    lastUsedAt: now,
    state: 'opening',
    error: '',
    received: 0,
    total: null,
    contentType: '',
    firstUpstreamByteAt: 0,
    firstClientByteAt: 0,
    clients: 0,
    waiters: new Set(),
    abort: null,
    upstream: null,
    writeFh: null,
    upstreamEnded: false,
    lastDataAt: 0,
    stallTimer: null,
    completionLogged: false,
    ranges: [],
    segments: 1,
    primaryEnd: null,
    primaryStart: 0,
    segmentAbort: null,
    segmentActive: 0,
    repairing: false,
    waitingForBytes: false,
    writtenBytes: 0
  }
  sessions.set(id, s)
  // 计时起点：这一刻起「建会话 → 上游首字节 → 本地可播」三段才算进本轮 [play-flow] 计时
  // （markCacheTiming 自己会在「本轮没有点击」时忽略，本地文件/托盘播放不受影响）
  markCacheTiming('建会话')
  logSession(
    s,
    'info',
    `本地临时缓存已开始（最多保留 ${maxEpisodes()} 集，退出应用自动清空）：按顺序拉上游字节并写盘，` +
      '播放器读已落盘部分'
  )
  void pullUpstream(s, 0)
  evictIfNeeded(id)
  return { ok: true, url: localUrl, sessionId: s.id, reason: '', reused: false }
}

/**
 * 暂停某一集的缓存拉取（换集/退出播放器时调用）。
 *
 * 为什么暂停而不是继续下完：用户已经离开这一集，后台再拉几个 GB 是纯浪费带宽；
 * 已落盘的部分保留在 LRU 里，拖回来时还能从断点继续（这就是「允许临时缓存的集数」的意义）。
 */
export function pauseTempMediaCache(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  if (s.state !== 'opening' && s.state !== 'streaming') return
  s.state = 'paused'
  clearStall(s)
  // V1.5.1：暂停时并行分段也停（下次重播会清掉内存里的分段记录，从顺序区继续）
  abortSegments(s, '暂停')
  s.abort?.abort()
  s.abort = null
  try {
    s.upstream?.destroy()
  } catch {
    /* ignore */
  }
  s.upstream = null
  const fh = s.writeFh
  s.writeFh = null
  if (fh) void fh.close().catch(() => undefined)
  wake(s)
  logSession(
    s,
    'info',
    `已暂停后台缓存（已落盘 ${fmtBytes(s.received)}${s.total ? ` / ${fmtBytes(s.total)}` : ''}），文件保留待下次继续`
  )
}

/**
 * 通知「这个缓存会话失败了」的订阅（播放层据此回退直连）。
 * 返回退订函数；播放层只订阅一次。
 */
export function onTempMediaCacheFailure(cb: (f: TempMediaCacheFailure) => void): () => void {
  failureHandlers.add(cb)
  return () => {
    failureHandlers.delete(cb)
  }
}

/** 自检/计时脚本读现场（不含任何地址，红线同日志） */
export function tempMediaCacheSnapshot(): {
  port: number
  dir: string
  limit: number
  sessions: {
    id: string
    state: CacheState
    received: number
    total: number | null
    contentType: string
    clients: number
    lastUsedAt: number
    firstUpstreamByteAt: number
    firstClientByteAt: number
    error: string
    /** V1.5.1：播放器正在等这一集补字节（界面显示「正在加载中…」） */
    waiting: boolean
    /** V1.5.1：本轮真实写盘字节数（速率用它算，避免分段完成时闪出假速度） */
    written: number
  }[]
} {
  return {
    port: relayPort,
    dir: tempMediaCacheDir(),
    limit: maxEpisodes(),
    sessions: [...sessions.values()].map((s) => ({
      id: s.id,
      state: s.state,
      /*
       * V1.5.1：进度条要的是"已经缓存了多少"，而不是"顺序区到哪了"。
       * 并行分段下后半段可能先下完（顺序区还停在一半），只报 received 会让百分比看起来卡住。
       */
      received: cachedBytesOf(s),
      total: s.total,
      contentType: s.contentType,
      clients: s.clients,
      lastUsedAt: s.lastUsedAt,
      firstUpstreamByteAt: s.firstUpstreamByteAt,
      firstClientByteAt: s.firstClientByteAt,
      error: s.error,
      waiting: s.waitingForBytes,
      written: s.writtenBytes
    }))
  }
}

/**
 * 发往上游的请求头：UA/Referer/Cookie 与「原样交给内核」时保持一致。
 *
 * 为什么必须有浏览器 UA：与 mpv.loadSource 的注释同一个原因 ——
 * 不少 CDN/WAF 会拒绝 "libmpv"/空 UA，表现为「地址校验能通、内核取流却播不了」。
 */
function upstreamHeaders(s: CacheSession, range?: string): Record<string, string> {
  const cfg = sniffSettings()
  const headers: Record<string, string> = {
    'User-Agent': s.userAgent || BROWSER_UA,
    Accept: '*/*'
  }
  if (s.referer) headers.Referer = s.referer
  if (s.cookies) headers.Cookie = s.cookies
  if (range) headers.Range = range
  /*
   * V1.5.1「请求头伪装」（嗅探设置里可关）。
   *
   * 为什么需要：不少 CDN/WAF 除了 UA，还会看 Origin / Accept-Language / Sec-Fetch-* 这一组
   * 「只有真实浏览器才会带全」的头。实测有的直链只带 UA 能过，但一旦站点侧开始按"请求特征"
   * 限速，缺这几个头的那类请求会率先被降速或 403 —— 补齐它们的代价是零，收益是被当成真人。
   *
   * 注意几件事：
   *   · `Accept-Encoding: identity` 是**必须**的：媒体字节一旦被压缩，写进缓存的就是解压前的
   *     另一份字节，长度对不上播放器声明的内容（这条以前在响应头检查里兜底，现在请求端就拒绝）；
   *   · Origin 由 Referer 推（同源），推不出来就不写 —— 空 Origin 比错的 Origin 更容易被拦；
   *   · `Connection: keep-alive` 不提：Node 自己会按 Agent 设置，自己写反而可能触发 h2 拒绝。
   */
  if (cfg.headerSpoof) {
    headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8'
    headers['Accept-Encoding'] = 'identity'
    headers['Sec-Fetch-Dest'] = 'video'
    headers['Sec-Fetch-Mode'] = 'no-cors'
    headers['Sec-Fetch-Site'] = 'cross-site'
    if (s.referer) {
      try {
        headers.Origin = new URL(s.referer).origin
      } catch {
        /* Referer 不是合法 URL 时不写 Origin */
      }
    }
  }
  return headers
}

/** 当前的嗅探设置（每次现读：用户改完设置不用重开会话就生效） */
function sniffSettings(): SniffSettings {
  return resolveSniffSettings(getSettings().sniff)
}

/* ───────────────────────── V1.5.1：Range 多连接分段 ───────────────────────── */

/** 分段下载的最小文件体积（再小就单连接：多开只会多几个请求） */
const SEGMENT_MIN_BYTES = 8 * 1024 * 1024
/** 分段边界对齐到 1MiB：一是好看，二是避免最后一段小到没有意义 */
const SEGMENT_ALIGN = 1024 * 1024

/*
 * 「已缓存区间」的三个判定（availableEndOf / cachedBytesOf / addRangeTo / nextRangeStart）
 * 全部在 `mediaCacheCoverage.ts` 里，是**不依赖 Electron 的纯函数**，可以脱离播放链路跑断言。
 * 这里保留一个 addRange 包装，因为写完之后必须 wake() 等待中的客户端；
 * 其余三个直接用导入的实现（CacheSession 结构上满足 CoverageState）。
 */

/** 记一段已完成并唤醒等待中的读方 */
function addRange(s: CacheSession, start: number, end: number): void {
  addRangeTo(s, start, end)
  wake(s)
}

/** 自适应并发：上一次分段任务的表现决定这一次开几条连接（用户可关） */
let adaptiveConnections = 0

/** 本次会话实际使用的分段数：基准值 + 自适应偏移，夹在合法区间内 */
function planConnections(cfg: SniffSettings): number {
  const base = cfg.connections
  if (!cfg.adaptive) return base
  if (adaptiveConnections <= 0) return base
  return Math.min(8, Math.max(2, adaptiveConnections))
}

/** 分段任务结束后的统计（用于下一轮自适应；纯内存，不落盘） */
const segmentStats = { ok: 0, failed: 0, bytes: 0, ms: 0 }

function resetSegmentStats(): void {
  segmentStats.ok = 0
  segmentStats.failed = 0
  segmentStats.bytes = 0
  segmentStats.ms = 0
}

/**
 * 决定本次会话要不要并行分段，并把 worker 拉起来。
 *
 * 只在这一刻判定一次：响应头已经拿到（知道总长）、文件已经以 `w+` 打开（不会被再次截断）、
 * 且这是从头开始的第一次拉取。任何一条不满足就保持单连接 —— 复用的旧会话/续传路径不参与，
 * 免得"一半顺序区 + 一半分段"让可用区间变得难以推理。
 */
function maybeStartSegments(s: CacheSession): void {
  void (async () => {
    if (s.segments > 1) return
    const cfg = sniffSettings()
    if (!cfg.multiConnection) return
    if (s.total === null || s.total < SEGMENT_MIN_BYTES || s.total < cfg.minFileMB * 1024 * 1024) return
    if (s.primaryStart !== 0 || s.received !== 0) return
    const k = planConnections(cfg)
    if (k < 2) return
    // 分段边界按 MiB 对齐，并保证每段至少有 SEGMENT_MIN_BYTES/k 的大小
    const per = Math.max(SEGMENT_ALIGN, Math.ceil(s.total / k / SEGMENT_ALIGN) * SEGMENT_ALIGN)
    if (per <= 0 || per >= s.total) return
    resetSegmentStats()
    s.segments = k
    s.primaryEnd = Math.min(s.total, per)
    s.primaryStart = 0
    s.segmentAbort = new AbortController()
    let started = 0
    for (let i = 1; i < k; i++) {
      const start = i * per
      if (start >= s.total) break
      const end = Math.min(s.total, start + per)
      s.segmentActive += 1
      started += 1
      void runSegment(s, start, end)
    }
    if (started === 0) {
      s.segments = 1
      s.primaryEnd = null
      return
    }
    logSession(
      s,
      'info',
      `启用 Range 多连接分段下载：${started + 1} 条连接（主链路 ${fmtBytes(s.primaryEnd ?? 0)}，其余并行，` +
        `文件 ${fmtBytes(s.total)}）`
    )
  })()
}

/**
 * 一个分段 worker：用 Range 拉 [start,end) 并在**绝对偏移**处写盘。
 *
 * 与主链路的隔离：worker 只碰自己那一段，失败也只是"这一段没下来"，
 * 由 repair 用单连接补齐（见 repairGaps）—— 绝不因为并行失败影响正在播放的顺序区。
 */
async function runSegment(s: CacheSession, start: number, end: number): Promise<void> {
  const signal = s.segmentAbort?.signal
  if (!signal) return
  const t0 = Date.now()
  let written = 0
  let res: AxiosResponse
  try {
    res = await axios.get(s.directUrl, {
      timeout: UPSTREAM_HEADER_TIMEOUT_MS,
      responseType: 'stream',
      maxRedirects: 5,
      validateStatus: () => true,
      decompress: false,
      headers: upstreamHeaders(s, `bytes=${start}-${end - 1}`),
      signal,
      netBypass: true,
      ...buildProxyAgents(getSettings().proxy)
    })
  } catch (err) {
    segmentSettled(s, false, 0, 0, `请求失败：${shortError(err)}`)
    return
  }
  const stream = res.data as Readable
  if (res.status !== 206) {
    try {
      stream?.destroy()
    } catch {
      /* ignore */
    }
    /*
     * 200 = 源站忽略了 Range。这时**不能再并行**：继续拉会把整份文件重复写进各段。
     * 收掉所有 worker，让主链路继续按顺序拉完（功能不受影响，只是没有加速）。
     */
    segmentSettled(s, false, 0, 0, `源站不支持 Range（HTTP ${res.status}）`)
    abortSegments(s, '源站不支持 Range，改用单连接')
    return
  }
  let fh: FileHandle | null = null
  try {
    fh = await openFile(s.file, 'r+')
    let pos = start
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (s.state === 'paused' || s.state === 'closed' || s.state === 'failed' || signal.aborted) break
      const remain = end - pos
      if (remain <= 0) break
      const buf = chunk.length > remain ? chunk.subarray(0, remain) : chunk
      let offset = 0
      while (offset < buf.length) {
        const r = await fh.write(buf, offset, buf.length - offset, pos + offset)
        if (!r.bytesWritten) throw new Error('磁盘写入 0 字节')
        offset += r.bytesWritten
      }
      pos += buf.length
      written = pos - start
      s.writtenBytes += buf.length
      s.lastDataAt = Date.now()
      wake(s)
    }
    if (pos >= end) {
      addRange(s, start, end)
      segmentSettled(s, true, written, Date.now() - t0)
    } else {
      segmentSettled(s, false, written, Date.now() - t0, `提前结束（${fmtBytes(pos - start)}/${fmtBytes(end - start)}）`)
    }
  } catch (err) {
    if (s.state === 'paused' || s.state === 'closed' || s.state === 'failed' || signal.aborted) {
      // 暂停/关闭导致的写入中断不算失败（文件留着下次继续）
      segmentSettled(s, false, written, Date.now() - t0, '会话已暂停/关闭')
    } else {
      segmentSettled(s, false, written, Date.now() - t0, shortError(err))
    }
  } finally {
    if (fh) void fh.close().catch(() => undefined)
    try {
      stream?.destroy()
    } catch {
      /* ignore */
    }
  }
}

/** 一个分段 worker 收尾：记统计、减计数，全部结束后检查缺口 */
function segmentSettled(s: CacheSession, ok: boolean, bytes: number, ms: number, why?: string): void {
  if (ok) {
    segmentStats.ok += 1
    segmentStats.bytes += bytes
    segmentStats.ms += ms
  } else {
    segmentStats.failed += 1
    if (why && !/会话已暂停|闭/.test(why)) logSession(s, 'warn', `分段下载未完成：${why}；该段将由单连接补齐`)
  }
  s.segmentActive = Math.max(0, s.segmentActive - 1)
  if (s.segmentActive > 0) return
  const cfg = sniffSettings()
  if (cfg.adaptive) {
    const avg = segmentStats.ms > 0 ? (segmentStats.bytes / segmentStats.ms) * 1000 : 0
    adaptiveConnections = tuneConnections(s.segments, {
      ok: segmentStats.ok,
      failed: segmentStats.failed,
      avgBytesPerSec: avg
    })
  }
  repairGaps(s)
}

/** 取消所有分段 worker（暂停/回收/失败时调用） */
function abortSegments(s: CacheSession, why: string): void {
  if (!s.segmentAbort) return
  try {
    s.segmentAbort.abort()
  } catch {
    /* ignore */
  }
  s.segmentAbort = null
  s.segmentActive = 0
  if (s.segments > 1) logSession(s, 'info', `已停止 Range 分段下载（${why}）`)
  s.segments = 1
}

/**
 * 补缺口：并行分段可能因为源站抖动少下一段。
 *
 * 做法：把「从顺序区末尾到下一个已完成段起点」这一段交给**原来的单连接拉取**，
 * 拉到边界即停，收尾时 addRange 合并，再决定要不要继续补下一段（见 finishUpstream）。
 * 这样即使并行全部失败，最终仍然是一份完整文件（只是慢一点），不会留下永久空洞。
 *
 * 为什么一次只补一段而不是 while 循环：`pullUpstream` 是**事件驱动**的，
 * 它在挂好监听后就返回了，真正写完要靠流的 'end'。用 while 循环会在第一段还没写完时
 * 就启动第二轮，两个写偏移互相覆盖 —— 文件直接烂掉。
 */
function repairGaps(s: CacheSession): void {
  if (s.repairing) return
  if (s.state !== 'streaming' || s.total === null) return
  if (s.segmentActive > 0) return
  // 主链路还在跑（worker 先结束）：等它停到 primaryEnd 后由 finishUpstream 再调这里
  if (s.upstream && !s.upstreamEnded) return
  const from = availableEndOf(s, 0)
  if (from >= s.total) {
    markDone(s)
    return
  }
  const next = nextRangeStart(s, from)
  if (next !== null && next <= from) return
  s.repairing = true
  s.segmentAbort = null
  s.segments = 1
  s.primaryStart = from
  s.primaryEnd = next
  logSession(
    s,
    'info',
    `补拉缺口：${fmtBytes(from)} → ${next === null ? '文件末尾' : fmtBytes(next)}（单连接）`
  )
  void pullUpstream(s, from)
}

/** 收尾：整份文件已经齐了 */
function markDone(s: CacheSession): void {
  if (s.state !== 'streaming') return
  s.state = 'done'
  clearStall(s)
  const fh = s.writeFh
  s.writeFh = null
  if (fh) void fh.close().catch(() => undefined)
  s.abort = null
  s.upstream = null
  if (s.total === null) s.total = s.received
  wake(s)
  if (!s.completionLogged) {
    s.completionLogged = true
    logSession(s, 'info', `临时缓存已完整落盘（${fmtBytes(s.received)}，本次播放可直接从磁盘读取）`)
  }
}

/* ───────────────────────── 上游拉取 → 写盘 ───────────────────────── */

/**
 * 从上游顺序拉字节并写盘。
 *
 * @param fromByte 从哪个字节继续（0=从头；重播断点续拉时 >0，会带上 Range 请求头）
 *
 * 关于 Range：源站支持就从 `received` 继续，不支持（仍回 200 全量）就截断文件从头写。
 * 这两条都必须处理 —— 直接把 200 的全量数据写到半截文件后面会得到**损坏的媒体**。
 */
async function pullUpstream(s: CacheSession, fromByte: number): Promise<void> {
  if (s.state === 'failed' || s.state === 'done' || s.state === 'closed') return
  s.state = 'opening'
  // V1.5.1：本轮吞吐从 0 起算（续传/补拉时旧值会让速率首帧出现一个巨大的假峰值）
  s.writtenBytes = 0
  s.abort = new AbortController()
  const headers = upstreamHeaders(s, fromByte > 0 ? `bytes=${fromByte}-` : undefined)

  let res: AxiosResponse
  const requestStartedAt = Date.now()
  try {
    res = await axios.get(s.directUrl, {
      timeout: UPSTREAM_HEADER_TIMEOUT_MS,
      responseType: 'stream',
      maxRedirects: 5,
      validateStatus: () => true,
      // 媒体字节一律不解压：一旦被 axios 解压，写进文件的就是「解压后的字节」，
      // 而播放器读的是「按原长度声明的内容」—— 长度和字节都会对不上，直接播不了。
      decompress: false,
      headers,
      signal: s.abort.signal,
      netBypass: true,
      ...buildProxyAgents(getSettings().proxy)
    })
  } catch (err) {
    failSession(s, `上游请求失败：${shortError(err)}`)
    return
  }

  if (sessionState(s) === 'paused' || sessionState(s) === 'closed' || sessionState(s) === 'failed') {
    try {
      ;(res.data as Readable)?.destroy()
    } catch {
      /* ignore */
    }
    return
  }

  const status = res.status
  if (status !== 200 && status !== 206) {
    try {
      ;(res.data as Readable)?.destroy()
    } catch {
      /* ignore */
    }
    failSession(s, `上游返回 HTTP ${status}`)
    return
  }

  const h = res.headers as Record<string, unknown>
  const contentType = headerValue(h, 'content-type')
  if (/mpegurl|vnd\.apple/i.test(contentType)) {
    try {
      ;(res.data as Readable)?.destroy()
    } catch {
      /* ignore */
    }
    failSession(s, '上游实际返回的是 HLS 播放列表（无法整段缓存，按直连处理）')
    return
  }
  if (/^text\/html/i.test(contentType)) {
    /*
     * 200 + text/html 是「一条失效直链」最常见的形状：CDN/站点把错误页当成功返回。
     * 这种字节缓存下来播放器也解不出画面，还会白占一集名额 —— 直接判定失败并回退直连，
     * 让内核（和原有的可达性判据）自己去处理，而不是在这里假装缓存成功。
     */
    try {
      ;(res.data as Readable)?.destroy()
    } catch {
      /* ignore */
    }
    failSession(s, '上游返回的是网页（text/html）而不是媒体文件')
    return
  }
  const contentEncoding = headerValue(h, 'content-encoding').toLowerCase()
  if (contentEncoding && contentEncoding !== 'identity') {
    try {
      ;(res.data as Readable)?.destroy()
    } catch {
      /* ignore */
    }
    failSession(s, `上游用了 ${contentEncoding} 压缩（解压后的字节无法按原长度给播放器）`)
    return
  }

  let writeFrom = fromByte
  if (fromByte > 0 && status === 200) {
    // 源站忽略了 Range：只能从头写，否则文件会变成「半截 + 全量」的损坏数据
    writeFrom = 0
    s.received = 0
    logSession(s, 'warn', '上游不支持断点续传（Range 被忽略），本次从 0 重新缓存')
  }

  s.contentType = contentType
  const knownTotal = totalFromHeaders(h, status, writeFrom)
  /*
   * 总长未知（chunked/直播）时不缓存，直接回退直连。
   *
   * 为什么必须在**收到响应头、还没写第一个字节**时就判定：这类流没有终点，
   * 临时文件会一直长到把磁盘写满（两小时直播就是好几 GB）；等播到一半再停，
   * 又会把正在播的画面截断 —— 那正好违反「不能因为它播不了」。
   * 此时播放器还没从本机拿到任何字节，回退直连是安全的。
   */
  if (knownTotal === null) {
    try {
      ;(res.data as Readable)?.destroy()
    } catch {
      /* ignore */
    }
    failSession(s, '上游没有给出总长度（直播/分块流），无法限制缓存体积，按直连处理')
    return
  }
  if (knownTotal > MAX_SINGLE_FILE_BYTES) {
    try {
      ;(res.data as Readable)?.destroy()
    } catch {
      /* ignore */
    }
    failSession(s, `文件太大（${fmtBytes(knownTotal)}，超过单集 8GB 上限），不缓存，按直连处理`)
    return
  }
  s.total = knownTotal
  s.upstream = res.data as Readable
  s.upstreamEnded = false

  const queue: Buffer[] = []
  let queueBytes = 0
  let writing = false
  let failedLocal = false
  try {
    const fh = await openFile(s.file, writeFrom > 0 ? 'r+' : 'w+')
    if (sessionState(s) === 'paused' || sessionState(s) === 'closed' || sessionState(s) === 'failed') {
      await fh.close().catch(() => undefined)
      return
    }
    s.writeFh = fh
    s.state = 'streaming'
    s.primaryStart = writeFrom
    startStallWatch(s)
    wake(s)
    logSession(
      s,
      'info',
      `上游已响应（HTTP ${status}，${s.total ? `总长 ${fmtBytes(s.total)}` : '总长未知'}，` +
        `响应头 ${Date.now() - requestStartedAt}ms 到达）：开始写盘`
    )
    // V1.5.1：文件已按 w+ 打开（不会被再次截断），这时才允许并行分段写同一文件
    maybeStartSegments(s)
  } catch (err) {
    failSession(s, `写盘失败（无法打开临时文件）：${shortError(err)}`)
    return
  }

  const stream = s.upstream as Readable

  /** 排空写队列；返回时队列可能又有新数据（会由 finally 再排一次） */
  const pumpWrites = async (): Promise<void> => {
    if (writing) return
    writing = true
    try {
      while (queue.length > 0) {
        if (s.state !== 'streaming') return
        let chunk = queue.shift() as Buffer
        queueBytes -= chunk.length
        const fh = s.writeFh
        if (!fh) return
        /*
         * V1.5.1：主链路只负责到 primaryEnd（并行模式下是第一段）。
         * 到点后立刻收尾：丢掉落进队列的多余字节，它们属于别的分段，会由对应 worker 补齐 ——
         * 继续写下去就会把 worker 写的同一块区域覆盖掉（内容一样但白耗流量与磁盘）。
         */
        const limit = s.primaryEnd
        if (limit !== null) {
          const remain = limit - writeFrom
          if (remain <= 0) {
            queue.length = 0
            queueBytes = 0
            endPrimary(s)
            return
          }
          if (chunk.length > remain) chunk = chunk.subarray(0, remain)
        }
        /*
         * 常规文件一般一次 write 就写完整块，但 FileHandle.write 允许只写一部分；
         * 这里按实际写入字节推进，避免「少写一块」在文件里留下空洞（媒体文件会因此解不出来）。
         */
        let offset = 0
        while (offset < chunk.length) {
          const r = await fh.write(chunk, offset, chunk.length - offset, writeFrom + offset)
          if (!r.bytesWritten) throw new Error('磁盘写入 0 字节')
          offset += r.bytesWritten
        }
        writeFrom += chunk.length
        s.received = writeFrom
        // V1.5.1：真实吞吐计数（进度条百分比不用它，速率用它，见 writtenBytes 的说明）
        s.writtenBytes += chunk.length
        // 写盘也算「有进展」：磁盘慢导致的背压不该被上游停滞看门狗误判成上游死了
        s.lastDataAt = Date.now()
        wake(s)
        if (stream.isPaused() && queueBytes < WRITE_QUEUE_LOW) stream.resume()
      }
    } catch (err) {
      /*
       * 暂停/回收会话时会主动关掉写文件句柄，正在 await 的那次 write 会因此报错。
       * 这**不是**写盘失败，不能触发「回退直连」——否则用户一退出播放器就白切一次源。
       */
      if (s.state === 'paused' || s.state === 'closed' || s.state === 'failed') return
      failedLocal = true
      failSession(s, `写盘失败：${shortError(err)}`)
      try {
        stream.destroy()
      } catch {
        /* ignore */
      }
    } finally {
      writing = false
      if (!failedLocal && s.state === 'streaming' && queue.length > 0) void pumpWrites()
      else if (!failedLocal && s.state === 'streaming' && s.upstreamEnded && queue.length === 0) finishUpstream(s)
    }
  }

  stream.on('data', (buf: Buffer) => {
    if (s.state !== 'streaming') return
    s.lastDataAt = Date.now()
    if (s.firstUpstreamByteAt === 0) {
      s.firstUpstreamByteAt = Date.now()
      /*
       * 「上游首字节」按**到达本进程**的时刻记（不是写盘完成的时刻）：
       * 工单要量的是「上游首字节 → 本地可播首字节」，两者之间的差就是这条本机链路的开销。
       * 只有本轮播放新建的会话才打点：上一轮遗留会话的首字节不该算进这一轮的计时。
       */
      const roundStart = playTimingStartedAt()
      if (roundStart <= 0 || s.createdAt >= roundStart) markCacheTiming('上游首字节')
    }
    queue.push(buf)
    queueBytes += buf.length
    if (queueBytes > WRITE_QUEUE_HIGH && !stream.isPaused()) stream.pause()
    void pumpWrites()
  })

  stream.on('end', () => {
    if (s.state === 'failed' || s.state === 'closed') return
    s.upstreamEnded = true
    if (!writing) void pumpWrites()
  })

  stream.on('error', (err: Error) => {
    /*
     * V1.5.1：主链路在 primaryEnd 主动 destroy 时会触发一次 error（ERR_STREAM_DESTROYED）。
     * 那是我们自己掐的，不是上游故障 —— 当成失败就会让整集回退直连，白扔掉已经缓存好的部分。
     */
    if (s.upstreamEnded || s.state !== 'streaming') return
    failSession(s, `上游中断：${shortError(err)}`)
  })
}

/** 上游读完且队列排空：落盘完成 */
function finishUpstream(s: CacheSession): void {
  if (s.state !== 'streaming') return
  /*
   * V1.5.1：并行模式下主链路是**主动停在 primaryEnd** 的（见 endPrimary），
   * 此时 received < total 是正常现象，不能当成"上游提前结束"判失败。
   * 把它记成一段已完成，剩下的交给 worker；worker 都结束后 repairGaps 决定是收尾还是补缺口。
   */
  if (s.primaryEnd !== null) {
    /*
     * 只登记**真的写到了**的位置：源站可能提前结束（received < primaryEnd），
     * 这时把整段记成"已完成"会让播放器读到不存在的字节（文件里是空洞）。
     */
    addRange(s, s.primaryStart, Math.min(s.received, s.primaryEnd))
    s.repairing = false
    if (s.segmentActive > 0) return
    if (s.total !== null && availableEndOf(s, 0) >= s.total) {
      markDone(s)
      return
    }
    // 还有缺口：接着补下一段（每次补一段，补完会再回到这里）
    repairGaps(s)
    return
  }
  if (s.received === 0) {
    // 200 + 立即 EOF 也是「失效直链」的一种形状：没有字节可播，按失败回退直连
    failSession(s, '上游连接结束但一个字节都没有返回')
    return
  }
  /*
   * 上游「正常结束」但没给够 Content-Length 声明的字节（CDN 掐流/源站截断）：
   * 这不能当成功 —— 我们已经对播放器声明了完整长度，客户端会拿到一个截断响应，
   * 内核只会报 "partial file" 并卡住。按失败处理，交给回退直连。
   */
  if (s.total !== null && s.received < s.total) {
    failSession(s, `上游提前结束（只收到 ${fmtBytes(s.received)} / ${fmtBytes(s.total)}）`)
    return
  }
  markDone(s)
}

/**
 * 主链路到达 primaryEnd：停掉上游、丢掉剩余队列，让收尾逻辑把这一段登记完成。
 *
 * 为什么必须先 `destroy()` 再交给 finishUpstream：不掐掉上游的话，'end' 事件永远不会来，
 * 队列虽然空着也会一直挂着 streaming，界面就会一直显示"还在缓存"。
 */
function endPrimary(s: CacheSession): void {
  if (s.upstreamEnded) return
  s.upstreamEnded = true
  try {
    ;(s.upstream as Readable)?.destroy()
  } catch {
    /* ignore */
  }
  s.upstream = null
}

function totalFromHeaders(headers: Record<string, unknown>, status: number, fromByte: number): number | null {
  if (status === 206) {
    const contentRange = headerValue(headers, 'content-range')
    const m = /\/(\d+)\s*$/.exec(contentRange)
    if (m) return Number(m[1])
    // 206 却没给总长：不能拿「这一段长度」当总长（会算出错的进度与 seek 范围）
    return null
  }
  const len = Number(headerValue(headers, 'content-length'))
  if (Number.isFinite(len) && len > 0) return fromByte + len
  return null
}

/* ───────────────────────── 本机 HTTP：把已落盘字节喂给播放器 ───────────────────────── */

const CACHE_PATH_RE = /^\/cache\/([A-Za-z0-9_-]+)(?:\/[^?#]*)?(?:\?[^#]*)?$/

/**
 * 接管 `/cache/<id>/...` 请求。返回 true = 本模块处理了（同一监听上的其它路径照旧走下去）。
 *
 * 为什么用异步处理但仍同步返回 true：上层 createServer 的回调没有 await 语义，
 * 这里只需要「声明这条请求归我」，后续等待/写响应在 serveClient 里做。
 */
export function handleMediaCacheRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const id = CACHE_PATH_RE.exec(req.url ?? '')?.[1] ?? ''
  if (!id) return false
  const s = sessions.get(id)
  if (!s) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end('media cache session gone')
    return true
  }
  void serveClient(s, req, res).catch((err) => {
    logSession(s, 'warn', `本地缓存响应异常：${shortError(err)}`)
    try {
      res.destroy()
    } catch {
      /* ignore */
    }
  })
  return true
}

interface ParsedRange {
  start: number
  /** 结束位置（含）；null=到文件末尾 */
  end: number | null
  /** 请求里确实带了可解析的 Range（决定回 206 还是 200） */
  partial: boolean
}

function parseRange(header: string | undefined, total: number | null): ParsedRange | 'invalid' | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!m) return 'invalid'
  const startRaw = m[1]
  const endRaw = m[2]
  if (startRaw === '' && endRaw === '') return 'invalid'

  if (startRaw === '') {
    // 后缀范围：最后 N 字节。总长未知时无法定位，只能从头给
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    if (total === null) return { start: 0, end: null, partial: false }
    const start = Math.max(0, total - suffix)
    return { start, end: total - 1, partial: true }
  }

  const start = Number(startRaw)
  if (!Number.isFinite(start) || start < 0) return 'invalid'
  if (total !== null) {
    if (start >= total) return 'unsatisfiable'
    if (endRaw === '') return { start, end: total - 1, partial: true }
    const end = Math.min(total - 1, Number(endRaw))
    if (!Number.isFinite(end) || end < start) return 'invalid'
    return { start, end, partial: true }
  }
  if (endRaw === '') return { start, end: null, partial: true }
  const end = Number(endRaw)
  if (!Number.isFinite(end) || end < start) return 'invalid'
  return { start, end, partial: true }
}

async function serveClient(s: CacheSession, req: IncomingMessage, res: ServerResponse): Promise<void> {
  touch(s)
  s.clients += 1
  /*
   * close 与 error 可能先后各触发一次；用标记保证客户端计数只减一次，
   * 否则计数会被减成 0，LRU 就可能把**正在被另一个播放器读**的文件淘汰掉。
   */
  let released = false
  const onClose = (): void => {
    if (released) return
    released = true
    s.clients = Math.max(0, s.clients - 1)
    touch(s)
  }
  res.on('close', onClose)
  res.on('error', onClose)

  // ① 等上游响应头（有了类型与总长才能回正确的 Range 语义）
  const deadline = Date.now() + CLIENT_HEADER_TIMEOUT_MS
  while (s.state === 'opening' && Date.now() < deadline) await waitForChange(s)
  if (s.state === 'failed' || s.state === 'closed') {
    res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end('media cache failed')
    return
  }
  if (s.state === 'opening') {
    res.writeHead(504, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Retry-After': '1' })
    res.end('media cache not ready')
    return
  }

  const total = s.total
  const parsed = parseRange(req.headers.range, total)

  if (parsed === 'unsatisfiable' && total !== null) {
    res.writeHead(416, {
      'Content-Type': 'text/plain',
      'Content-Range': `bytes */${total}`,
      'Cache-Control': 'no-store'
    })
    res.end()
    return
  }

  if (req.method === 'HEAD') {
    const head: Record<string, string | number> = {
      'Content-Type': s.contentType || 'application/octet-stream',
      'Cache-Control': 'no-store'
    }
    // 总长未知时不能声称支持 Range（我们确实无法给合法的 Content-Range）
    if (total !== null) {
      head['Accept-Ranges'] = 'bytes'
      head['Content-Length'] = total
    }
    res.writeHead(200, head)
    res.end()
    return
  }

  const baseHeaders: Record<string, string | number> = {
    'Content-Type': s.contentType || 'application/octet-stream',
    'Cache-Control': 'no-store'
  }
  if (total !== null) baseHeaders['Accept-Ranges'] = 'bytes'

  let start = 0
  let end: number | null = total !== null ? total - 1 : null
  let status = 200
  if (parsed && parsed !== 'invalid' && parsed !== 'unsatisfiable') {
    if (total === null) {
      /*
       * 总长未知时无法给出合法的 Content-Range（206 必须带它）。
       * 这种情况下忽略 Range、按 200 从**头**发整段：播放器会当成「不可 seek 的流」，
       * 至少能播；而不是从半截开始却声明成完整内容（那会直接解不出来）。
       */
      start = 0
      end = null
      status = 200
    } else {
      start = parsed.start
      end = parsed.end
      status = parsed.partial ? 206 : 200
    }
  }

  /*
   * V1.5.1：判断"要不要改走上游直供"时先看**可用区间**（顺序区 + 并行分段），
   * 只有确实没有这段数据、且离顺序区很远时才去问源站 —— 否则并行已经下好的段
   * 还要再向源站拉一遍，白耗流量还更慢。
   */
  if (total !== null && availableEndOf(s, start) <= start && start - s.received > UNCACHED_JUMP_BYTES) {
    /*
     * 播放器要的位置远在已缓存区之后：不再等顺序缓存爬过去，直接向源站要这一段。
     * 典型场景就是非 faststart 的 MP4（moov 在尾部）与用户拖到很后面的进度条 ——
     * 等缓存会让用户黑屏几十秒到几分钟，而这本可以直接从源站取。
     */
    await proxyUpstreamRange(s, res, start, end)
    return
  }

  if (total !== null && end !== null) {
    const headers: Record<string, string | number> = { ...baseHeaders, 'Content-Length': end - start + 1 }
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`
    res.writeHead(status, headers)
  } else {
    // 总长未知：chunked 输出（不写 Content-Length），播放器能播，但进度条可能拿不到总时长
    res.writeHead(status, baseHeaders)
  }

  await streamCachedBytes(s, res, start, end)
}

/**
 * 把「已缓存区之后的某一段」用一条上游 Range 请求直接转给播放器（不写缓存）。
 *
 * 为什么先等上游响应头再写客户端响应头：源站可能不认 Range（回 200 全量）。
 * 那种情况下我们从半截开始发却声明 206 会让播放器解出损坏数据；先拿到 206 再回，
 * 认不出来就回 502 —— 与「直连时无法 seek」是同一结果，不会更糟。
 */
async function proxyUpstreamRange(
  s: CacheSession,
  res: ServerResponse,
  start: number,
  end: number | null
): Promise<void> {
  const range = end === null ? `bytes=${start}-` : `bytes=${start}-${end}`
  let upstream: AxiosResponse
  try {
    upstream = await axios.get(s.directUrl, {
      timeout: 20_000,
      responseType: 'stream',
      maxRedirects: 5,
      validateStatus: () => true,
      decompress: false,
      headers: upstreamHeaders(s, range),
      netBypass: true,
      ...buildProxyAgents(getSettings().proxy)
    })
  } catch (err) {
    logSession(s, 'warn', `未缓存区间的上游请求失败：${shortError(err)}`)
    res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end('upstream range failed')
    return
  }
  const stream = upstream.data as Readable
  if (upstream.status !== 206 && upstream.status !== 200) {
    try {
      stream?.destroy()
    } catch {
      /* ignore */
    }
    logSession(s, 'warn', `未缓存区间的上游返回 HTTP ${upstream.status}，本次跳转无法供给`)
    res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end('upstream range failed')
    return
  }

  const upHeaders = upstream.headers as Record<string, unknown>
  const headers: Record<string, string | number> = {
    'Content-Type': headerValue(upHeaders, 'content-type') || s.contentType || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  }
  // 长度/范围一律沿用上游原值：源站可能把请求的 end 夹小，自己算会与实际字节数对不上
  const contentLength = headerValue(upHeaders, 'content-length')
  const contentRange = headerValue(upHeaders, 'content-range')
  if (contentLength) headers['Content-Length'] = contentLength
  if (upstream.status === 206 && contentRange) headers['Content-Range'] = contentRange
  /*
   * 源站不认 Range（回 200 全量）时**原样回 200**：HTTP 允许服务端忽略 Range，
   * 播放器会当成「不可 seek 的完整流」从头读 —— 这正是它直连时会遇到的行为，
   * 比我们自己造一个 206 或直接报错都更安全。
   */
  res.writeHead(upstream.status === 206 ? 206 : 200, headers)
  logSession(
    s,
    'info',
    `播放器跳到未缓存区间（已缓存 ${fmtBytes(s.received)}，请求位置 ${fmtBytes(start)}）：` +
      `这一段由上游 ${upstream.status === 206 ? 'Range' : '200 全量（源站不支持 Range）'} 直接供给，不写缓存`
  )

  /*
   * 双向背压：源站快、客户端慢时暂停上游；客户端断开时立刻掐掉上游。
   * 这里不写盘，所以不需要队列 —— 它只是一次「直连转发」。
   */
  stream.on('data', (buf: Buffer) => {
    if (!res.write(buf)) stream.pause()
  })
  res.on('drain', () => stream.resume())
  stream.on('end', () => {
    if (!res.writableEnded) res.end()
  })
  stream.on('error', () => {
    try {
      res.destroy()
    } catch {
      /* ignore */
    }
  })
  res.on('close', () => {
    try {
      stream.destroy()
    } catch {
      /* ignore */
    }
  })
}

/**
 * 把 [start, end] 的已落盘字节写给客户端；没有的字节就等（缓存多少播多少）。
 *
 * 为什么每块都重新分配 Buffer：`res.write()` 不保证立刻复制数据，
 * 复用同一块内存会在下一次 `fh.read` 覆盖掉还没发出去的字节（实测会造成花屏/损坏）。
 */
async function streamCachedBytes(
  s: CacheSession,
  res: ServerResponse,
  start: number,
  end: number | null
): Promise<void> {
  let fh: FileHandle
  try {
    fh = await openFile(s.file, 'r')
  } catch {
    res.destroy()
    return
  }
  let pos = start
  let lastProgressAt = Date.now()
  try {
    while (!res.destroyed && !res.writableEnded) {
      if (end !== null && pos > end) break
      /*
       * V1.5.1：可用区间 = 顺序区 + 已完成的并行分段（availableEndOf 会跨过相邻段但**不跨缺口**）。
       * 之前只看 s.received，并行下好的段会被当成"还没缓存"，播放器只好干等。
       */
      const available = availableEndOf(s, pos) - pos
      if (available <= 0) {
        /*
         * V1.5.1：播放器正卡在还没缓存到的位置 —— 置位给界面显示「正在加载中…」。
         * 一旦读到数据（下面的分支）立刻清零，所以这个标记永远不会"卡住不消失"。
         */
        s.waitingForBytes = true
        if (s.state === 'done') {
          s.waitingForBytes = false
          break // 正常结束：下面统一 end()
        }
        if (s.state === 'failed' || s.state === 'closed' || s.state === 'paused') {
          // 缓存坏了/被回收：截断响应，让内核报错并走播放层的回退流程，而不是永远等下去
          s.waitingForBytes = false
          res.destroy()
          return
        }
        if (Date.now() - lastProgressAt > CLIENT_STALL_DROP_MS) {
          s.waitingForBytes = false
          logSession(s, 'warn', '播放器等待的位置超过 60 秒仍未缓存到，已断开本次连接（内核会重试/换候选）')
          res.destroy()
          return
        }
        await waitForChange(s)
        continue
      }
      s.waitingForBytes = false
      const want = Math.min(READ_CHUNK, available, end === null ? READ_CHUNK : end - pos + 1)
      if (want <= 0) break
      const chunk = Buffer.allocUnsafe(want)
      const { bytesRead } = await fh.read(chunk, 0, want, pos)
      if (bytesRead <= 0) {
        await waitForChange(s)
        continue
      }
      pos += bytesRead
      lastProgressAt = Date.now()
      if (s.firstClientByteAt === 0) {
        s.firstClientByteAt = Date.now()
        /*
         * 「本地可播首字节」= 播放器真的从本机拿到第一个字节的那一刻。
         * 与上面的「上游首字节」配对，就是工单要求写进 [play-flow] 计时的那一段。
         * 同样只给本轮新建的会话打点（复用旧会话不该污染这一轮）。
         */
        const roundStart = playTimingStartedAt()
        if (roundStart <= 0 || s.createdAt >= roundStart) {
          markCacheTiming('本地可播')
          const delta = s.firstUpstreamByteAt > 0 ? Date.now() - s.firstUpstreamByteAt : null
          logSession(
            s,
            'info',
            '本地缓存已可播' +
              (delta === null ? '（上游首字节时间未知）' : `：上游首字节后 ${delta}ms 播放器拿到本地首字节`) +
              `，当前已落盘 ${fmtBytes(s.received)}`
          )
        }
      }
      const ok = res.write(chunk.subarray(0, bytesRead))
      if (!ok) {
        const canContinue = await waitDrain(res)
        if (!canContinue) return
      }
    }
    if (!res.writableEnded && !res.destroyed) res.end()
  } finally {
    void fh.close().catch(() => undefined)
  }
}

/** 等内核把缓冲写出去（drain）或连接关闭；返回 false 表示连接已经不能继续写 */
function waitDrain(res: ServerResponse): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      res.off('drain', onDrain)
      res.off('close', onClose)
      res.off('error', onClose)
      resolve(ok)
    }
    const onDrain = (): void => finish(true)
    const onClose = (): void => finish(false)
    res.on('drain', onDrain)
    res.on('close', onClose)
    res.on('error', onClose)
  })
}

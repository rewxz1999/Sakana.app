import axios from 'axios'
import type { PlayFlowMetrics, PlayFlowReason } from '@shared/types'
import {
  ONLINE_IDLE_TIMEOUT_MS,
  ONLINE_PLAY_TIMEOUT_MS,
  SLOW_STREAM_CONFIRM_MS,
  SLOW_STREAM_RATE_BPS,
  SPEED_SAMPLE_WINDOW_MS
} from '@shared/onlinePlay'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'

/**
 * 资源获取原因分析（v0.3.9）。
 *
 * 用户的诉求（原话）：「我们已经获取到了媒体播放地址后，仍然播放失败…
 * 建议做个检测资源获取原因分析，播放失败后就显示原因，是网站问题，还是网速太慢。
 * 同时建议将超时延迟改为 60s，只要能获取到一点资源就不该结束而是显示资源获取速度过慢，
 * 一点都获取不到再显示网站问题。」
 *
 * 所以这里做的**不是**「再试一次能不能播」，而是**取证**：
 * 带着站点会话（UA/Referer/Cookie/代理）真的去请求一次这条直链，
 * 量出首字节耗时、累计字节数、实时速率、HTTP 状态、响应头与网络层错误码，
 * 把这些**事实**翻译成人能看懂的结论：
 *
 *   · 一个字节都没到（或 HTTP 4xx/5xx、DNS/TLS 失败）        → `site`   「网站问题/资源失效」
 *   · 有数据但在动得很慢（长期低于 SLOW_STREAM_RATE_BPS）      → `slow`   「资源获取速度过慢」（**不算失败**）
 *   · 有数据、速率正常，但拿到的根本不是媒体（HTML/错误页）    → `format` 「格式不支持」
 *   · 等满 60 秒仍无首字节                                     → `timeout`
 *
 * ⚠️ 两条与「不要假状态」有关的自我约束：
 *   1. 这个探测**只在拿不到画面时才需要**，所以调用方应让它与播放并行跑，
 *      绝不能拿它去挡「把地址交给 mpv」这一步（那会白白多等一次网络往返）；
 *   2. 它一旦确认「数据在流动」就立刻收手（默认够 1.5MB 或看见 m3u8 头就够），
 *      不会把整整一集下载下来 —— 取证不能变成给用户偷跑流量。
 */

/** 够多少字节就认为「链路是通的」，可以收手了（HLS 播完这个量早出画面了） */
const ENOUGH_BYTES = 1.5 * 1024 * 1024
/**
 * 探测的总时长硬上限（10 分钟）。
 *
 * 为什么不是 60 秒：按用户要求「只要能获取到一点资源就不该结束」，
 * 一个 30 KB/s 的流理论上可以一直探测下去 —— 但探测本身要占一条连接，
 * 不能无限期挂着。10 分钟足够让「极慢但确实在动」的站点把结论说清楚，
 * 又不至于让一条僵尸探测陪跑整集。
 */
const PROBE_HARD_CAP_MS = 10 * 60_000

/**
 * 判为「资源获取速度过慢」之后，继续观测多久（v0.3.9）。
 *
 * 为什么需要这个窗口：用户要的是「不要结束播放，继续等并**显示实时速率**」——
 * 速率是探测在量的，所以探测不能在判出「过慢」的那一刻就收手，
 * 否则界面上的速率会停在最后一个数字上不动，看起来又像卡死了。
 * 45 秒足够让用户看清「它确实在动、只是很慢」，同时把这条探测占用的流量
 * 控制在几 MB 量级（按 50 KB/s 算约 2.2MB），不会替用户偷偷跑掉一整集。
 */
const SLOW_PROBE_HOLD_MS = 45_000

export interface ReachabilityOutcome {
  /** 归因 */
  reason: PlayFlowReason
  /** 人话结论（直接显示给用户） */
  verdict: string
  /** 采集到的证据 */
  metrics: PlayFlowMetrics
  /** 从响应头/首块数据里看出来的容器类型（EXTM3U / MP4 / FLV / HTML…） */
  container?: string
  /** 首块数据（调用方可用于进一步判定，避免重复下载） */
  firstChunk?: Buffer
}

/** 从 node/axios 的错误码判定网络层类别：这是「网站问题」里最有价值的部分 */
function classifyError(err: unknown): { kind: string; text: string } {
  const e = err as { code?: string; message?: string; cause?: { code?: string } }
  const code = String(e?.code ?? e?.cause?.code ?? '')
  const msg = String(e?.message ?? err ?? '')
  const upper = `${code} ${msg}`.toUpperCase()
  if (/ENOTFOUND|EAI_AGAIN|GETADDRINFO/.test(upper)) {
    return { kind: 'dns', text: `域名解析失败（DNS ${code || 'ENOTFOUND'}）：这个站点在当前网络下根本找不到` }
  }
  if (
    /CERT|SELF_SIGNED|SSL|TLS|EPROTO|UNABLE_TO_VERIFY|ALTNAME/.test(upper)
  ) {
    return { kind: 'tls', text: `TLS/证书握手失败（${code || 'TLS'}）：多为代理/中间设备或站点证书问题` }
  }
  if (/ECONNREFUSED/.test(upper)) return { kind: 'refused', text: `连接被拒绝（${code}）：服务器没在监听该端口或被防火墙拦了` }
  if (/ECONNRESET|EPIPE|SOCKET HANG UP/.test(upper)) return { kind: 'reset', text: `连接被对端重置（${code}）：常见于签名过期/防盗链` }
  if (/ETIMEDOUT|ECONNABORTED|TIMEOUT/.test(upper)) {
    return { kind: 'timeout', text: `请求超时（${code || 'ETIMEDOUT'}）：服务器/线路没有在 ${ONLINE_PLAY_TIMEOUT_MS / 1000} 秒内给出响应` }
  }
  return { kind: 'network', text: msg.slice(0, 160) || '未知网络错误' }
}

/** 只看响应头里对排查有用的几行，别把整个 header 塞进界面 */
function pickHeaders(headers: Record<string, unknown>): Record<string, string> {
  const keys = [
    'content-type',
    'content-length',
    'content-range',
    'server',
    'location',
    'cache-control',
    'x-cache',
    'cf-ray',
    'via',
    'age'
  ]
  const out: Record<string, string> = {}
  for (const k of keys) {
    const v = headers[k]
    if (v === undefined || v === null) continue
    out[k] = String(Array.isArray(v) ? v[0] : v).slice(0, 120)
  }
  return out
}

/**
 * 从首块数据认出容器。
 *
 * 为什么不用 ffprobe：探测发生在**播放之前**，ffprobe 要先把输入拉成文件或跑完整
 * probe（对在线流要额外一次完整连接）；而「是不是媒体、是什么容器」用魔数就够判了。
 * 真的解不出来时（拿到的是合法容器但编码不支持）由播放内核那边给结论（见 diagnoseAfterFailure）。
 */
export function sniffContainer(buf: Buffer | undefined): string | undefined {
  if (!buf || buf.length === 0) return undefined
  const head = buf.subarray(0, 64).toString('latin1')
  if (head.includes('#EXTM3U')) return 'HLS 播放列表(m3u8)'
  if (head.includes('<MPD') || head.includes('<?xml')) return 'DASH 清单(mpd)'
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'MP4'
  if (head.startsWith('FLV')) return 'FLV'
  if (head.startsWith('OggS')) return 'Ogg'
  if (head.startsWith('fLaC')) return 'FLAC'
  if (head.startsWith('ID3')) return 'MP3'
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'RIFF') return 'WebM/WAV'
  if (buf[0] === 0x47) return 'MPEG-TS'
  const lower = head.toLowerCase()
  if (lower.includes('<!doctype html') || lower.includes('<html') || lower.includes('<head')) return 'HTML 网页'
  if (head.trimStart().startsWith('{') || head.trimStart().startsWith('[')) return 'JSON'
  return undefined
}

/** 容器是不是「根本不能当媒体播」的东西 —— 这类要直接判格式不支持 */
function isNonMediaContainer(container: string | undefined): boolean {
  return container === 'HTML 网页' || container === 'JSON'
}

function isPlayableContentType(ct: string): boolean {
  if (!ct) return true // 有些 CDN 不给 content-type，不能因此判死
  return /^(video\/|audio\/|application\/(octet-stream|vnd\.apple\.mpegurl|mp2t|x-mpegurl|dash\+xml|mp4|f4v|x-shockwave-flash|ogg))/i.test(
    ct
  )
}

export interface ProbeOptions {
  url: string
  referer?: string
  cookies?: string
  /** 是否阻止请求体继续下载（自检脚本只想知道结论时用） */
  signal?: AbortSignal
  /** 每 500ms 一次进度回调：拿到的是「目前为止」的真实指标 */
  onProgress?: (metrics: PlayFlowMetrics, note: string) => void
}

/**
 * 取证式探测一条媒体直链：返回可判定的结论，而不是布尔值。
 *
 * 调用方（PlayerPage → player:diagnose）应当在**把地址交给播放内核之后**并行调用它，
 * 这样正常情况下用户完全感觉不到它的存在，失败时却能立刻拿到证据。
 */
export async function probeStreamReachability(opts: ProbeOptions): Promise<ReachabilityOutcome> {
  const { url, referer, cookies } = opts
  const headers: Record<string, string> = { 'User-Agent': BROWSER_UA, Accept: '*/*' }
  if (referer) headers['Referer'] = referer
  if (cookies) headers['Cookie'] = cookies

  const t0 = Date.now()
  const metrics: PlayFlowMetrics = { bytes: 0, rateBps: 0, ttfbMs: null }
  /** 速率采样窗口：{at, bytes} 滑动窗口，避免用「首字节那一瞬间」的爆表速率判快慢 */
  const samples: { at: number; bytes: number }[] = []
  let slowSince: number | null = null

  const emit = (note: string): void => {
    opts.onProgress?.({ ...metrics }, note)
  }

  log.append('info', 'stream-diag', `开始资源可达性探测: ${url.slice(0, 130)}`)

  /*
   * 显式标注响应类型：`responseType:'stream'` 时 body 是 Node 的 Readable，
   * 但 axios 的重载在这种情况下会把返回推断成 unknown（它无法表达「按 responseType 变化的 data 类型」），
   * 所以这里自己收窄一次，后续读 status/headers/data 才有类型。
   * 用确定赋值断言（`!`）：唯一的赋值点就在下面那个 try 里，而 catch 分支一定会 return ——
   * 走到 try 之后 res 必然有值。
   */
  let res!: {
    status: number
    headers: Record<string, unknown>
    data: NodeJS.ReadableStream & { destroy?: () => void }
  }
  /*
   * 首字节的限时**自己管**，不走 axios 的 `timeout`。
   *
   * 原因：axios 的 timeout 是「整个请求」的墙钟超时，对 `responseType:'stream'` 来说
   * 它会在响应头早就到了、正文正在慢慢传的时候把连接掐掉 ——
   * 那就直接违反了用户的要求「只要能获取到一点资源就不该结束」。
   * 所以这里 timeout 给 0（不限），只在**等响应头**这一段时间上挂钩一个 60 秒的中止器。
   */
  const ttfbAbort = new AbortController()
  const ttfbTimer = setTimeout(() => ttfbAbort.abort(), ONLINE_PLAY_TIMEOUT_MS)
  const onOuterAbort = (): void => ttfbAbort.abort()
  opts.signal?.addEventListener('abort', onOuterAbort)
  try {
    res = await axios.get(url, {
      /*
       * responseType:'stream' 是这次探测的关键：axios 在**响应头到达时**就 resolve，
       * 于是 ttfbMs 量的就是真正的首字节等待，而 body 以流的形式给我们，
       * 可以在「确认通了」的瞬间 destroy 掉，不必把整集拉完。
       */
      responseType: 'stream',
      timeout: 0,
      signal: ttfbAbort.signal,
      maxRedirects: 6,
      // 必须在 axios 层解压：m3u8 常以 gzip 传输，拿到压缩字节会认不出 #EXTM3U 头
      decompress: true,
      validateStatus: () => true,
      headers,
      /*
       * 绕过分级队列（v1.2.1）：这是与播放**并行**的取证请求，
       * 一旦排到 A 级后面，排队超时会被 classifyError 当成 site（网站问题），
       * 而它本来只是"我们自己的队列让路"。它有自己的 60s 首字节中止器，不需要队列兜底。
       */
      netBypass: true,
      ...buildProxyAgents(getSettings().proxy)
    })
  } catch (err) {
    clearTimeout(ttfbTimer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
    const abortedByUs = ttfbAbort.signal.aborted
    const { kind, text } = classifyError(err)
    metrics.errorKind = abortedByUs ? 'timeout' : kind
    metrics.lastError = abortedByUs
      ? `等待 ${ONLINE_PLAY_TIMEOUT_MS / 1000} 秒未收到响应头`
      : text
    emit(metrics.lastError)
    const reason: PlayFlowReason = abortedByUs || kind === 'timeout' ? 'timeout' : 'site'
    const verdict =
      reason === 'timeout'
        ? `等待 ${ONLINE_PLAY_TIMEOUT_MS / 1000} 秒仍未收到任何数据：${text}`
        : `网站问题/资源失效：${text}`
    log.append('warn', 'stream-diag', `探测失败(${kind})：${text}`)
    return { reason, verdict, metrics }
  }
  clearTimeout(ttfbTimer)

  metrics.ttfbMs = Date.now() - t0
  metrics.status = res.status
  const ct = String(res.headers?.['content-type'] ?? '')
  metrics.contentType = ct || undefined
  metrics.headers = pickHeaders((res.headers ?? {}) as Record<string, unknown>)
  emit(`已收到响应头（HTTP ${res.status}，${ct || '无 content-type'}）`)
  log.append(
    'info',
    'stream-diag',
    `响应头到达 ${metrics.ttfbMs}ms：HTTP ${res.status} ${ct || '(无 content-type)'} ${JSON.stringify(metrics.headers)}`
  )

  // HTTP 层面的硬失败：明显不是「慢」，而是「没有」——直接给结论，不必再等
  if (res.status >= 400) {
    metrics.errorKind = 'http'
    metrics.lastError = `HTTP ${res.status}`
    const verdict =
      `网站问题/资源失效：源站返回 HTTP ${res.status}` +
      (res.status === 403 || res.status === 401
        ? '（防盗链/签名过期，通常需要重新嗅探这条流的地址）'
        : res.status === 404
          ? '（地址已失效，需重新嗅探）'
          : '（站点或 CDN 故障）')
    emit(verdict)
    try {
      res.data.destroy?.()
    } catch {
      /* ignore */
    }
    log.append('warn', 'stream-diag', verdict)
    return { reason: 'site', verdict, metrics }
  }

  const stream = res.data as NodeJS.ReadableStream & { destroy?: () => void }
  let firstChunk: Buffer | undefined
  let container: string | undefined
  let settled = false

  const outcome = await new Promise<ReachabilityOutcome>((resolve) => {
    let lastEmit = 0
    let idleTimer: NodeJS.Timeout | null = null
    /** 判出「过慢」之后的继续观测计时器（见 SLOW_PROBE_HOLD_MS） */
    let slowHoldTimer: NodeJS.Timeout | null = null

    const finish = (o: ReachabilityOutcome): void => {
      if (settled) return
      settled = true
      if (idleTimer) clearTimeout(idleTimer)
      if (slowHoldTimer) clearTimeout(slowHoldTimer)
      clearTimeout(hardCapTimer)
      opts.signal?.removeEventListener('abort', onOuterAbort)
      try {
        stream.destroy?.()
      } catch {
        /* ignore */
      }
      resolve(o)
    }

    /*
     * 总时长硬上限：只在「数据一直在动、但一直很少」这种极端情况下才用到。
     * 到点按「慢」而不是「失败」收尾 —— 因为此时确实有数据在流动，
     * 按用户的要求不能判它失败（真实失败由播放内核那边的 60 秒判决给出）。
     */
    const hardCapTimer = setTimeout(() => {
      if (settled) return
      const verdict =
        metrics.bytes > 0
          ? `资源获取速度过慢：${Math.round(PROBE_HARD_CAP_MS / 60000)} 分钟只收到 ${Math.round(metrics.bytes / 1024)} KB（约 ${Math.round(metrics.rateBps / 1024)} KB/s），数据一直在动但太慢`
          : `网站问题/资源失效：${Math.round(PROBE_HARD_CAP_MS / 60000)} 分钟未收到任何数据`
      metrics.lastError = verdict
      emit(verdict)
      finish({
        reason: metrics.bytes > 0 ? 'slow' : 'site',
        verdict,
        metrics,
        container,
        firstChunk
      })
    }, PROBE_HARD_CAP_MS)

    /** 空闲看门狗：数据流动起来之后，「连续 N 秒一个字节都没有」才算断 */
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        const verdict =
          metrics.bytes > 0
            ? `网站问题/资源失效：连接已停止传输（已收到 ${Math.round(metrics.bytes / 1024)} KB 后连续 ${ONLINE_IDLE_TIMEOUT_MS / 1000} 秒没有新数据）`
            : `网站问题/资源失效：等待 ${ONLINE_PLAY_TIMEOUT_MS / 1000} 秒仍未收到任何数据（HTTP ${metrics.status ?? '?'}）`
        metrics.lastError = verdict
        metrics.errorKind = 'timeout'
        emit(verdict)
        finish({ reason: metrics.bytes > 0 ? 'site' : 'timeout', verdict, metrics, container, firstChunk })
      }, metrics.bytes > 0 ? ONLINE_IDLE_TIMEOUT_MS : ONLINE_PLAY_TIMEOUT_MS)
    }
    armIdle()

    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      if (!firstChunk) {
        firstChunk = Buffer.from(chunk)
        container = sniffContainer(firstChunk)
        if (container) metrics.headers = { ...(metrics.headers ?? {}), 容器: container }
      }
      metrics.bytes += chunk.length
      const now = Date.now()
      samples.push({ at: now, bytes: metrics.bytes })
      while (samples.length > 1 && now - samples[0].at > SPEED_SAMPLE_WINDOW_MS) samples.shift()
      const windowMs = now - (samples[0]?.at ?? now)
      const windowBytes = metrics.bytes - (samples[0]?.bytes ?? metrics.bytes)
      metrics.rateBps = windowMs > 300 ? Math.round((windowBytes / windowMs) * 1000) : 0

      // 有数据在动 → 重新计时（这就是「只要还有数据在动就不算超时」的落点）
      armIdle()

      if (now - lastEmit > 500) {
        lastEmit = now
        emit(
          `已收 ${Math.round(metrics.bytes / 1024)} KB，速率 ${Math.round(metrics.rateBps / 1024)} KB/s` +
            (container ? `，容器 ${container}` : '')
        )
      }

      // 拿到的东西根本不是媒体：直接判「格式不支持」，等下去也不会变
      if (isNonMediaContainer(container) && metrics.bytes > 512) {
        const verdict = `格式不支持：源站返回的是 ${container}（HTTP ${metrics.status}，${metrics.contentType ?? '无 content-type'}），不是媒体流`
        metrics.lastError = verdict
        metrics.errorKind = 'format'
        emit(verdict)
        finish({ reason: 'format', verdict, metrics, container, firstChunk })
        return
      }

      // 速率判定：连续低于阈值达到确认窗口才算「过慢」（躲开 HLS 换分片的正常停顿）
      if (now - t0 > SPEED_SAMPLE_WINDOW_MS && metrics.rateBps > 0 && metrics.rateBps < SLOW_STREAM_RATE_BPS) {
        if (slowSince === null) slowSince = now
        else if (now - slowSince >= SLOW_STREAM_CONFIRM_MS) {
          const verdict = `资源获取速度过慢：速率长期约 ${Math.round(metrics.rateBps / 1024)} KB/s（低于 ${Math.round(SLOW_STREAM_RATE_BPS / 1024)} KB/s），画面会持续缓冲`
          emit(verdict)
          slowSince = now
          /*
           * 判出「过慢」之后**继续观测 45 秒**，让界面上的实时速率继续跳
           * （用户要求「不要结束播放，继续等并显示实时速率」），到点再以 'slow' 收尾。
           * 只挂一次：计时器已经在跑时不重复挂。
           */
          if (!slowHoldTimer) {
            slowHoldTimer = setTimeout(() => {
              if (settled) return
              const v = `资源获取速度过慢：首字节 ${metrics.ttfbMs}ms，速率约 ${Math.round(metrics.rateBps / 1024)} KB/s（数据一直在流动，只是太慢）`
              emit(v)
              finish({ reason: 'slow', verdict: v, metrics, container, firstChunk })
            }, SLOW_PROBE_HOLD_MS)
          }
        }
      } else {
        slowSince = null
      }

      // 已经确认链路是通的（够量 / 认出 HLS 清单）→ 收手，别替用户把整集拉下来。
      // 但「过慢」的情况下不收手：那时最该继续给用户的是实时速率（见 SLOW_PROBE_HOLD_MS）。
      const slow = metrics.rateBps > 0 && metrics.rateBps < SLOW_STREAM_RATE_BPS
      const enough =
        !slow &&
        (metrics.bytes >= ENOUGH_BYTES ||
          (container === 'HLS 播放列表(m3u8)' && metrics.bytes > 256) ||
          (container !== undefined && metrics.bytes >= 256 * 1024))
      if (enough) {
        const verdict = `数据已到达：首字节 ${metrics.ttfbMs}ms，${Math.round(metrics.bytes / 1024)} KB，约 ${Math.round(metrics.rateBps / 1024)} KB/s（${container ?? metrics.contentType ?? '未知容器'}）`
        emit(verdict)
        finish({
          reason: 'none',
          verdict,
          metrics,
          container,
          firstChunk
        })
      }
    })

    stream.on('end', () => {
      // 流正常结束：m3u8 清单这样结束很正常，算「拿到了」
      const verdict =
        metrics.bytes > 0
          ? `数据已到达并结束：共 ${Math.round(metrics.bytes / 1024)} KB（${container ?? metrics.contentType ?? '未知容器'}）`
          : '网站问题/资源失效：连接建立成功但响应体为空（0 字节）'
      finish({
        reason: metrics.bytes > 0 ? 'none' : 'site',
        verdict,
        metrics,
        container,
        firstChunk
      })
    })

    stream.on('error', (err: unknown) => {
      const { kind, text } = classifyError(err)
      metrics.errorKind = kind
      metrics.lastError = text
      const verdict =
        metrics.bytes > 0
          ? `资源获取中断：已收到 ${Math.round(metrics.bytes / 1024)} KB 后出错（${text}）`
          : `网站问题/资源失效：${text}`
      emit(verdict)
      finish({ reason: 'site', verdict, metrics, container, firstChunk })
    })
  })

  log.append(
    outcome.reason === 'none' || outcome.reason === 'slow' ? 'info' : 'warn',
    'stream-diag',
    `探测结论(${outcome.reason})：${outcome.verdict}`
  )
  return outcome
}

/**
 * 「拿到了地址、却仍然播不出来」时的最终归因。
 *
 * 输入是两条证据：可达性探测的结论 + 播放内核给出的状态。
 * 组合规则（顺序即优先级）：
 *   1. 数据在流动且速率正常，但内核没有画面 → 只能是**格式/解码**问题 → `format`；
 *   2. 数据在流动但很慢 → `slow`（继续等，不算失败）；
 *   3. 一点数据都拿不到 → `site`；
 *   4. 内核自己报了错且与网络无关 → `internal`。
 */
export function diagnoseAfterFailure(args: {
  reach: ReachabilityOutcome | null
  engineMessage?: string
  engineLoadedSomething: boolean
}): { reason: PlayFlowReason; verdict: string } {
  const { reach, engineMessage, engineLoadedSomething } = args
  if (reach) {
    if (reach.reason === 'site' || reach.reason === 'format' || reach.reason === 'timeout') {
      return { reason: reach.reason, verdict: reach.verdict }
    }
    if (reach.reason === 'slow') return { reason: 'slow', verdict: reach.verdict }
    if (reach.reason === 'none') {
      const detail = [
        reach.container ? `容器 ${reach.container}` : reach.metrics.contentType ? `类型 ${reach.metrics.contentType}` : '',
        reach.metrics.ttfbMs !== null ? `首字节 ${reach.metrics.ttfbMs}ms` : '',
        `速率 ${Math.round(reach.metrics.rateBps / 1024)} KB/s`
      ]
        .filter(Boolean)
        .join('，')
      return {
        reason: 'format',
        verdict:
          `格式不支持：地址可取到数据（${detail}），但播放内核没能解出画面` +
          (engineMessage ? `（内核：${engineMessage.slice(0, 80)}）` : '') +
          '。多为编码/容器不被支持，可尝试切换其它播放源'
      }
    }
  }
  if (engineLoadedSomething) {
    return { reason: 'internal', verdict: `播放内核未出画面${engineMessage ? `：${engineMessage.slice(0, 120)}` : '（原因未知）'}` }
  }
  return {
    reason: 'timeout',
    verdict: `播放未开始且未取得可达性证据${engineMessage ? `：${engineMessage.slice(0, 120)}` : ''}（已等满 ${ONLINE_PLAY_TIMEOUT_MS / 1000} 秒）`
  }
}

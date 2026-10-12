import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { networkInterfaces, tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import { proxyHlsUrl } from './adFilter'
import { ffmpegExe } from './transcode'

/**
 * 投屏用的**局域网中转**（v0.3.8）
 *
 * ## 为什么需要它
 *
 * 电视（DLNA）与我们的安卓接收端拿到的是一个**裸地址**，没法带 Referer / Cookie ——
 * 而番剧站的片源几乎都校验 Referer，直接把这个地址交给电视只会 403。
 * 所以在电脑上开一个局域网可访问的小服务：由电脑带着站点会话去取流，再把字节原样转发给电视。
 *
 * ## 两种中转形态（为什么都要有）
 *
 * 1. **`hls`：只改写播放列表**（源就是 m3u8 时）
 *    把子列表与分片的地址换成经过我们的地址，每个请求到达时带上站点会话去源站取。
 *    编解码、缓冲都在电视那边做，电脑只当"带鉴权的通道"，**不重编码**，也支持电视自己拖进度。
 *    ⚠️ 但**不是所有 DLNA 电视都支持 HLS**（实测很多国产电视只认 mp4/ts），
 *    所以要不要走这条路由 `cast.ts` 先问电视它支持什么（ConnectionManager.GetProtocolInfo）再决定。
 *
 * 2. **`mp4`：FFmpeg 重新封装成一路渐进式 MP4**（源是 HLS 而电视不认 HLS，或源就是整段文件时）
 *    `-c:v copy -c:a aac -movflags frag_keyframe+empty_moov` —— 视频流**原样复制不重编码**，
 *    只是换个容器；任何 DLNA 电视都能播。代价是这一路是单向流，电视只能从头顺序播。
 *
 * 重编码只在用户在设置里显式选择时才发生（那属于 `transcode.ts` 的活），
 * 因为一重编码就会引入延迟与画质损失 —— 与"投屏要流畅"直接冲突。
 *
 * ## 为什么端口固定在 52890
 *
 * 电视端（DLNA）会把地址写进它的播放列表并可能长时间缓存；端口一变，
 * 之前的会话地址全部失效（用户看到"投屏中途断了"）。固定端口 + 顺延到下一个可用端口，
 * 是这里最稳的做法。
 */

/** 中转形态：hls=只改写播放列表；mp4=重封装成渐进式 MP4；transcode=真转码成 H.264/AAC */
export type RelayMode = 'hls' | 'mp4' | 'transcode'

/** 中转服务端口（被占用时顺延） */
const BASE_PORT = 52890
/** 会话保留时长：一次投屏可能看两小时，留足余量 */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000
/**
 * 单次取流的流水记录（诊断"电视到底走到哪一步"的唯一硬证据）。
 *
 * 为什么要有它：原来的 `hits` 只是个计数器，**分不清是谁在取流** ——
 * 自检里本机 `fetch(中转地址)` 也会 +1，于是日志打出"电视已开始从本机取流"，
 * 实际上电视一个包都没发过（`.e2e/cast-test6.log` 就是这么骗过我的）。
 * 记下 remote / 路由 / 状态码 / 字节数之后，"电视没来"与"来了但被 404/502 挡住"
 * 才是两件可以分辨的事。
 */
export interface CastRelayHit {
  /** 毫秒时间戳 */
  at: number
  /** 从会话建立起过了多少毫秒（判断"第几秒才来取流"） */
  sinceMs: number
  /** 请求的路由：index=主列表 / sub=子列表 / seg=分片或密钥 / stream.mp4=重封装流 */
  route: 'index' | 'sub' | 'seg' | 'stream.mp4'
  method: string
  /** 请求方地址（带端口），电视的地址一眼能认出来 */
  remote: string
  /** 是不是本机自己（自检、播放器探针）：这类命中**不算**电视来过 */
  local: boolean
  ua: string
  /** 电视端的 Range 请求头（它是否按分片/按字节取流） */
  range: string
  /** 真正去源站取的地址（播放列表时为源地址，分片时为 base64 解出来的地址） */
  target: string
  /** 回给请求方的 HTTP 状态码（0 = 连接被中断，还没写头） */
  status: number
  /** 回给请求方的字节数 */
  bytes: number
  /** 上游耗时（毫秒） */
  ms: number
}
/** 每个会话最多留多少条流水（一集可能有几百个分片，够定位即可） */
const HIT_LOG_MAX = 240
/**
 * 重封装（落盘）这条路的时间上限。
 *
 * 为什么比"等首字节"宽这么多：改成落盘之后，电视要等的是**整段重封装的完成**，不是首字节。
 * 24 分钟一集、`-c:v copy` 通常几十秒（受源站带宽限制），20s 会把正常情况也误判成失败。
 * 但也不能无限等：源站挂掉时必须让电视收到明确的 502，而不是一直转圈。
 */
const PREPARE_TIMEOUT_MS = 180_000

/** MP4 模式下拉流失败时写入状态，界面/日志能看出来 */
interface RelaySession {
  id: string
  source: string
  headers: Record<string, string>
  createdAt: number
  /** 源是不是 HLS（决定是改写播放列表还是透传文件） */
  hls: boolean
  mode: RelayMode
  /** 落下过多少次请求：用来判断"电视到底有没有来取流"（防火墙排查的关键证据） */
  hits: number
  /** 请求流水（含 remote，用来区分本机自检与电视） */
  hitLog: CastRelayHit[]
  /** MP4 模式：FFmpeg 进程与它的状态 */
  proc?: import('node:child_process').ChildProcess | null
  stderrTail?: string
  /** MP4 模式：已经在拉的数据（首帧前后的等待者） */
  startedAt?: number
  /**
   * MP4 模式：重封装完成后**落地的可定位文件**（见 prepareRemuxFile 的文件头注释）。
   * 电视对同一路内容的 Range 请求有很多次，必须复用同一个文件，不能每来一个请求转一遍。
   */
  readyFile?: string
  /** 正在进行的重封装（并发请求共用同一个 Promise，避免同时拉多路 FFmpeg） */
  readyPromise?: Promise<boolean>
  /** 重封装失败的短原因（回给电视的 502/504 与日志都用它） */
  readyError?: string
  /** FFmpeg 的 stderr 落盘文件（不用管道：见 prepareRemuxFile 的说明） */
  stderrFile?: string
}

const sessions = new Map<string, RelaySession>()
let server: Server | null = null
let port = 0

/**
 * 本机在局域网里的 IPv4（给电视访问用的那个地址）。
 *
 * ⚠️ 必须**挑真实网卡**：自检时本机返回的是 `192.168.174.1`，那是 WSL/Hyper-V 的虚拟网卡，
 * 电视根本路由不到它 —— 直接拿它当中转地址，投屏必然失败（而且是"看起来一切正常"的失败）。
 * Node 不告诉我们哪块网卡是虚拟的，只能靠网卡名判断：
 * 名字像 Wi-Fi/以太网的加分，像 WSL/VMware/VirtualBox/Hyper-V/Docker/蓝牙/VPN 的减分，
 * 再叠加"像内网段"的偏好。选不出就用第一个非回环地址。
 */
export function lanIPv4(): string {
  const ifaces = networkInterfaces()
  const REAL = /(wi-?fi|wlan|wireless|ethernet|以太网|无线|本地连接|en\d|eth\d)/i
  const VIRTUAL =
    /(virtual|vmware|vbox|virtualbox|hyper-?v|wsl|docker|loopback|bluetooth|蓝牙|tap|tun|vpn|zerotier|tailscale|radmin|hamachi|npcap|loopback)/i
  let best: { ip: string; score: number } | null = null
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      let score = 0
      if (REAL.test(name)) score += 10
      if (VIRTUAL.test(name)) score -= 10
      if (/^192\.168\./.test(info.address)) score += 3
      else if (/^10\./.test(info.address)) score += 2
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) score += 1
      // 169.254.x 是"没拿到 DHCP"的地址，一定不通
      if (/^169\.254\./.test(info.address)) score -= 20
      if (!best || score > best.score) best = { ip: info.address, score }
    }
  }
  return best?.ip ?? '127.0.0.1'
}

function headersFor(s: RelaySession): Record<string, string> {
  return { 'User-Agent': BROWSER_UA, ...s.headers }
}

/**
 * 这个地址是不是本机自己？
 *
 * 为什么必须判断：投屏自检（以及用户重投时本机播放器的预探测）都会去拉一次中转地址，
 * 那一次命中**不能**当成"电视来了" —— 早先就是因为没区分，日志里出现了
 * 假的"电视已开始从本机取流"，把排查引到了防火墙这条错路上。
 */
function isLocalAddr(addr: string | undefined): boolean {
  const a = String(addr ?? '').replace(/^::ffff:/, '')
  if (!a) return false
  if (a === '127.0.0.1' || a === '::1' || a === 'localhost') return true
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.address === a) return true
  }
  return false
}

/** 统计回给请求方的字节数（Node 的 http 不会告诉我们写出去多少） */
function chunkBytes(chunk: unknown, enc?: unknown): number {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, typeof enc === 'string' ? (enc as BufferEncoding) : 'utf-8')
  }
  if (Buffer.isBuffer(chunk)) return chunk.byteLength
  if (chunk instanceof Uint8Array) return chunk.byteLength
  return 0
}

/** 把一次响应挂上"状态码 + 字节数 + 耗时"的采集，结束时回调（finish/close 只算一次） */
function instrumentResponse(res: ServerResponse, done: (status: number, bytes: number) => void): void {
  let bytes = 0
  let settled = false
  const w = res.write.bind(res)
  res.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    bytes += chunkBytes(chunk, enc)
    return (w as (...a: unknown[]) => boolean)(chunk, enc, cb)
  }) as typeof res.write
  const e = res.end.bind(res)
  res.end = ((chunk?: unknown, enc?: unknown, cb?: unknown) => {
    if (chunk !== undefined && typeof chunk !== 'function') bytes += chunkBytes(chunk, enc)
    return (e as (...a: unknown[]) => unknown)(chunk, enc, cb)
  }) as typeof res.end
  const settle = (): void => {
    if (settled) return
    settled = true
    done(res.statusCode, bytes)
  }
  res.on('finish', settle)
  res.on('close', settle)
}

/** 记录一条流水，并把关键节点写进日志（首次、非 2xx、每 20 条一次，避免刷屏） */
function recordHit(session: RelaySession, hit: CastRelayHit): void {
  session.hitLog.push(hit)
  if (session.hitLog.length > HIT_LOG_MAX) session.hitLog.splice(0, session.hitLog.length - HIT_LOG_MAX)
  const who = hit.local ? '本机自检' : `电视 ${hit.remote}`
  const bad = hit.status === 0 || hit.status >= 400
  if (session.hitLog.length <= 6 || bad || session.hitLog.length % 20 === 0) {
    log.append(
      bad ? 'warn' : 'info',
      'cast',
      `中转取流[${hit.route}] ← ${who}（+${(hit.sinceMs / 1000).toFixed(1)}s）：HTTP ${hit.status}，${hit.bytes} 字节，耗时 ${hit.ms}ms${hit.range ? `，Range=${hit.range}` : ''}`
    )
  }
  if (!hit.local && session.hitLog.filter((h) => !h.local).length === 1) {
    // 第一条来自局域网的命中 = 电视真的连上了我们（防火墙排查里最关键的一行）
    log.append('info', 'cast', `电视已连上本机中转并从我们这里取流（首个请求 ${hit.route}，UA=${hit.ua.slice(0, 60) || '无'}）`)
  }
}

/** 取这次会话的完整请求流水（诊断用；返回的是副本，调用方改不到内部状态） */
export function castRelayHitLog(id: string): CastRelayHit[] {
  return sessions.get(id)?.hitLog.slice() ?? []
}

/** 只数**非本机**的命中：>0 才说明电视真的来取流了 */
export function castRelayRemoteHits(id: string): number {
  return (sessions.get(id)?.hitLog ?? []).filter((h) => !h.local).length
}

/** 确保服务在跑（返回端口）；失败返回 0 */
async function ensureServer(): Promise<number> {
  if (server && port > 0) return port
  return await new Promise<number>((resolve) => {
    const srv = createServer((req, res) => {
      void handle(req, res)
    })
    let attempt = 0
    const tryListen = (p: number): void => {
      srv.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < 12) {
          attempt += 1
          tryListen(p + 1)
          return
        }
        log.append('error', 'cast', `投屏中转服务启动失败: ${err.message}`)
        resolve(0)
      })
      // 必须绑 0.0.0.0：电视在局域网的另一台设备上访问
      srv.listen(p, '0.0.0.0', () => {
        server = srv
        port = p
        log.append('info', 'cast', `投屏中转服务已启动: http://${lanIPv4()}:${p}/cast/<id>/...`)
        resolve(p)
      })
    }
    tryListen(BASE_PORT)
  })
}

function prune(): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      removeSessionFiles(s)
      sessions.delete(id)
    }
  }
}

/**
 * 登记一个投屏中转会话，返回**局域网可访问**的播放地址。
 *
 * `mode`：
 *   · `'hls'`（源是 m3u8 时默认）—— 只改写播放列表，分片仍从源站取，支持电视拖进度；
 *   · `'mp4'` —— 用 FFmpeg 把源重新封装成一路渐进式 MP4（`-c:v copy`，不重编码）。
 *     给不支持 HLS 的电视用，也适合"源本来就是整段文件但要带鉴权"的情况。
 */
export async function startCastRelay(
  source: string,
  opts: { referer?: string; cookies?: string; userAgent?: string; mode?: RelayMode } = {}
): Promise<{ id: string; url: string; kind: 'hls' | 'file'; lanIp: string; port: number } | null> {
  const p = await ensureServer()
  if (p <= 0) return null
  prune()
  const id = randomUUID().replace(/-/g, '').slice(0, 16)
  const headers: Record<string, string> = {}
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent
  if (opts.referer) headers['Referer'] = opts.referer
  if (opts.cookies) headers['Cookie'] = opts.cookies
  const hls = /\.m3u8(\?|$)/i.test(source)
  const mode: RelayMode = opts.mode ?? (hls ? 'hls' : 'mp4')
  sessions.set(id, { id, source, headers, createdAt: Date.now(), hls, mode, hits: 0, hitLog: [] })
  /*
   * 地址里的主机名必须是**局域网 IPv4**（电视只认这个）。
   * `lanIPv4()` 只算一次并在这个会话里复用：多网卡机器上它每次调用理论上都可能选到别的网卡，
   * 那会让"交给电视的地址"和"日志里显示的地址"对不上（排查时极容易看歪）。
   */
  const lanIp = lanIPv4()
  const base = `http://${lanIp}:${p}/cast/${id}`
  return {
    id,
    url: mode === 'hls' ? `${base}/index.m3u8` : `${base}/stream.mp4`,
    kind: mode === 'hls' ? 'hls' : 'file',
    lanIp,
    port: p
  }
}

/** 这个会话被请求过多少次（>0 说明电视真的来取流了，是排查防火墙的关键证据） */
export function castRelayHits(id: string): number {
  return sessions.get(id)?.hits ?? 0
}

/** MP4 模式下 FFmpeg 的错误尾巴（电视播不出来时把它写进日志/提示） */
export function castRelayError(id: string): string {
  return sessions.get(id)?.stderrTail ?? ''
}

/** 会话开始时间（诊断里算"第几秒失败"用） */
export function castRelayStartedAt(id: string): number {
  return sessions.get(id)?.createdAt ?? 0
}

export function stopCastRelay(id?: string): void {
  if (id) {
    const s = sessions.get(id)
    if (s) removeSessionFiles(s)
    sessions.delete(id)
  } else {
    for (const s of sessions.values()) removeSessionFiles(s)
    sessions.clear()
  }
}

/** 删掉这个会话留下的临时重封装文件（不删就会在 %TEMP% 里越积越大） */
function removeSessionFiles(s: RelaySession): void {
  if (s.proc) {
    try {
      s.proc.kill()
    } catch {
      /* ignore */
    }
    s.proc = null
  }
  if (s.readyFile) {
    try {
      unlinkSync(s.readyFile)
    } catch {
      /* 删不掉也无所谓：%TEMP% 会被系统清理 */
    }
    s.readyFile = undefined
  }
  if (s.stderrFile) {
    try {
      unlinkSync(s.stderrFile)
    } catch {
      /* ignore */
    }
    s.stderrFile = undefined
  }
}

export function castRelayUrl(): { ip: string; port: number } {
  return { ip: lanIPv4(), port }
}

// ---------------- HTTP ----------------

const PATH_RE = /^\/cast\/([A-Za-z0-9_-]+)\/(index\.m3u8|stream\.mp4|sub|seg)$/

/**
 * DLNA 规定的两个 HTTP 响应头。
 *
 * 为什么要加：DLNA 的渲染端（尤其国产电视）在 GET 时如果看不到
 * `contentFeatures.dlna.org` / `transferMode.dlna.org`，有一部分会直接判定
 * "这不是一段可播放的 DLNA 内容"而不出画 —— 光靠 DIDL 里的 `protocolInfo` 不够，
 * 这两个头是 DLNA 规范里**必须**由服务端在内容响应上给出的东西，我们之前一直没给。
 *
 * `DLNA.ORG_OP`：第一位=是否支持按字节定位，第二位=是否支持按时间定位。
 *   · HLS/分片：支持 Range，给 `01`；
 *   · 重封装成的单向流：不支持任何定位，给 `00`（报 01 会让电视去发 Range 请求然后落空）。
 * `DLNA.ORG_CI`：0=内容未经转换，1=经过转换。重封装/转码这条路真的转换了，所以给 1 ——
 *   报 0 是"骗"渲染端，遇到较真的实现会被判成不匹配。
 */
function dlnaHeaders(op: '00' | '01', ci: 0 | 1): Record<string, string> {
  // 0x0170... = 发送方定速（sender paced）+ 流式传输（background transfer），"边传边播"该报的标志位
  return {
    'contentFeatures.dlna.org': `DLNA.ORG_OP=${op};DLNA.ORG_CI=${ci};DLNA.ORG_FLAGS=01700000000000000000000000000000`,
    'transferMode.dlna.org': 'Streaming'
  }
}

/**
 * MP4 / 转码模式：把源重封装成**可定位的落盘 MP4**，再按普通文件（Content-Length + Range）发给电视。
 *
 * ## 为什么从"边转边发的单向流"改成"先落盘再发"（V1.1 真机实测的结论）
 *
 * 原实现是 `-movflags frag_keyframe+empty_moov -f mp4 pipe:1`：FFmpeg 产出**分片 MP4**，
 * 响应没有 Content-Length、不支持 Range，DLNA 头报 `DLNA.ORG_OP=00;DLNA.ORG_CI=1`。
 * 用客厅那台电视（192.168.1.7:38400，能力表 82 项）逐组合实测：
 *
 * | 交给电视的东西 | 电视的反应 |
 * |---|---|
 * | 我们中转的 `.m3u8`（电视能力表里**没有** mpegurl） | 接受地址、**一次都不来取**、不出画 |
 * | 分片 MP4 单向流（无 CL / 无 Range / OP=00） | 来取了整段 1.9MB，`RelTime` 恒 0、`duration` 恒 0 → **不出画** |
 * | MPEG-TS 单向流（无 CL / 无 Range） | 同上：来取了，但不出画 |
 * | **可定位 MP4 + Content-Length + Range + OP=01** | **正常播放**：`duration=00:01:00`、`RelTime` 从 2s 走到 30s |
 *
 * 结论：这台电视不是"不支持 mp4"，而是**不接受不可定位的流** —— 它会老老实实把整段收完，
 * 然后因为没有索引/长度而判定无法播放。用户看到的"连上了、加载一会、说无法播放"正是这一幕。
 * 所以这里改成：FFmpeg 用 `-movflags +faststart` 写一个**索引在文件头**的 MP4，
 * 写完整再按普通文件发（`Content-Length` + `Range` + `DLNA.ORG_OP=01`）。
 * 顺带好处：电视能拖进度，而不是被迫从头顺播。
 *
 * ## 为什么 stderr 写文件而不是插管道
 *
 * 分片流那条路要在 stdout 上插管道边读边发；落盘之后不再需要 stdout 管道，
 * 而 Windows 上"带管道地 spawn 子进程"在受限环境里会直接 EPERM（本仓库自检踩过）。
 * 改成 `stdio: ['ignore','ignore', fd]` 后没有任何管道，FFmpeg 的错误照样完整拿到。
 *
 * ## 代价（说清楚）
 *
 * 开播前必须等重封装完成 —— 24 分钟 1080p 的 `-c:v copy` 通常几十秒（受源站带宽限制）。
 * 这是"能不能播"与"多久开播"的取舍：实测这台电视上**流式方案 100% 不出画**，只能选前者。
 */
async function prepareRemuxFile(session: RelaySession): Promise<boolean> {
  if (session.readyFile && existsSync(session.readyFile)) return true
  if (session.readyPromise) return await session.readyPromise
  const ffmpeg = ffmpegExe()
  if (!ffmpeg) {
    session.readyError = '未找到 FFmpeg，无法为电视重新封装该流'
    return false
  }
  session.readyPromise = (async (): Promise<boolean> => {
    const ua = session.headers['User-Agent'] || BROWSER_UA
    const headerLines: string[] = []
    if (session.headers['Referer']) headerLines.push(`Referer: ${session.headers['Referer']}`)
    if (session.headers['Cookie']) headerLines.push(`Cookie: ${session.headers['Cookie']}`)
    // 源是 m3u8 时同样走广告过滤代理（与本地播放一致：贴片广告分片不投给电视）
    const input = proxyHlsUrl(session.source, {
      referer: session.headers['Referer'],
      cookies: session.headers['Cookie'],
      userAgent: ua
    })
    const dir = join(tmpdir(), 'sakana-cast')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* 已存在 */
    }
    const outFile = join(dir, `${session.id}.mp4`)
    const errFile = join(dir, `${session.id}.err.txt`)
    session.stderrFile = errFile
    const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y']
    args.push('-user_agent', ua)
    if (headerLines.length > 0) args.push('-headers', headerLines.join('\r\n') + '\r\n')
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5')
    args.push('-i', input)
    args.push('-map', '0:v:0?', '-map', '0:a:0?')
    if (session.mode === 'transcode') {
      /*
       * 真转码：只在用户显式选「中转并转码」时走这里。
       * 为什么要有它：有些电视不认 HEVC/10bit/H.265，只有转成 H.264+AAC 才能播 ——
       * 代价是明显增加延迟与画质损失，所以绝不作为默认。
       */
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p')
      args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2')
    } else {
      args.push('-c:v', 'copy')
      args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2')
    }
    // +faststart：把 moov 挪到文件头，电视一上来就能拿到索引（也是它能拖进度的前提）
    args.push('-movflags', '+faststart', '-f', 'mp4', outFile)

    session.startedAt = Date.now()
    log.append('info', 'cast', `投屏重封装开始（写临时文件，完成后按可定位文件发给电视）: ${outFile}`)
    let fd = -1
    try {
      fd = openSync(errFile, 'w')
    } catch {
      fd = -1
    }
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (v: boolean): void => {
        if (settled) return
        settled = true
        resolve(v)
      }
      let proc: import('node:child_process').ChildProcess
      try {
        // 无管道：stdout 丢弃，stderr 直接写文件（受限环境下管道会被 EPERM 拒绝）
        proc = spawn(ffmpeg, args, {
          windowsHide: true,
          stdio: ['ignore', 'ignore', fd >= 0 ? fd : 'ignore']
        })
      } catch (err) {
        session.readyError = `FFmpeg 启动失败：${String((err as Error)?.message ?? err)}`
        done(false)
        return
      }
      session.proc = proc
      const timer = setTimeout(() => {
        session.readyError = `重封装超过 ${Math.round(PREPARE_TIMEOUT_MS / 1000)}s 仍未完成`
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        done(false)
      }, PREPARE_TIMEOUT_MS)
      proc.on('error', (err) => {
        clearTimeout(timer)
        session.readyError = `FFmpeg 进程错误：${err.message}`
        done(false)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (session.proc === proc) session.proc = null
        session.stderrTail = readTail(errFile)
        if (code !== 0) {
          session.readyError = `FFmpeg 退出码 ${code}`
          done(false)
          return
        }
        try {
          if (statSync(outFile).size <= 0) {
            session.readyError = '重封装产物为空'
            done(false)
            return
          }
        } catch (err) {
          session.readyError = `重封装产物不可读：${String((err as Error)?.message ?? err)}`
          done(false)
          return
        }
        done(true)
      })
    })
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        /* spawn 已经复制了这份 fd，关掉我们自己这份即可 */
      }
    }
    if (ok) {
      session.readyFile = outFile
      session.readyError = undefined
      const secs = Math.round((Date.now() - (session.startedAt ?? Date.now())) / 1000)
      log.append('info', 'cast', `投屏重封装完成: ${outFile}（${(statSync(outFile).size / 1048576).toFixed(1)}MB，${secs}s）`)
      return true
    }
    log.append(
      'warn',
      'cast',
      `投屏重封装失败: ${session.readyError ?? '未知原因'}；FFmpeg: ${(session.stderrTail ?? '(无输出)').slice(-200)}`
    )
    try {
      unlinkSync(outFile)
    } catch {
      /* 没生成就不用删 */
    }
    return false
  })()
  try {
    return await session.readyPromise
  } finally {
    // 失败的 Promise 不缓存，允许电视重试时再来一次
    if (!session.readyFile) session.readyPromise = undefined
  }
}

/** 读文件尾部（FFmpeg 的错误通常就在最后几行） */
function readTail(file: string, max = 800): string {
  let fd = -1
  try {
    const size = statSync(file).size
    if (size <= 0) return ''
    const start = Math.max(0, size - max)
    const buf = Buffer.alloc(size - start)
    fd = openSync(file, 'r')
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf-8').trim()
  } catch {
    return ''
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/** 把重封装好的可定位 MP4 按普通文件发给电视（Content-Length + Range + OP=01） */
async function serveRemuxFile(session: RelaySession, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ok = await prepareRemuxFile(session)
  if (!ok || !session.readyFile) {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(session.readyError ?? 'remux failed')
    return
  }
  const file = session.readyFile
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('remux file gone')
    return
  }
  const head = {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    // 重封装过 → CI=1；可定位文件 → OP=01（电视实测要吃这个组合才出画）
    ...dlnaHeaders('01', 1)
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...head, 'Content-Length': String(size) })
    res.end()
    return
  }
  const m = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ''))
  if (m) {
    const start = m[1] ? Number(m[1]) : 0
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (!(start <= end && start < size)) {
      res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      ...head,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1)
    })
    createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...head, 'Content-Length': String(size) })
  createReadStream(file).pipe(res)
}

/**
 * 把播放列表里的 URI 换成"经过我们"的地址；绝对地址放进查询串里（base64url 免得转义）。
 *
 * ⚠️ 两个坑，都是实测踩出来的：
 *
 * 1. 相对地址必须相对**源播放列表自己的地址**解析，不能相对我们的中转地址 ——
 *    这个错自检当场抓到过：`test.m3u8` 里写的是 `seg0.ts`，早先按我们的地址解析成了
 *    `http://<本机>:52890/cast/seg0.ts`（404）。
 * 2. 改写结果必须是**绝对地址**，不能用 `/cast/<id>/seg?u=...` 这种站内相对路径。
 *    HLS 规范允许相对地址（相对于播放列表自己的 URL 解析），但电视端的实现未必照做：
 *    它可能相对 `res` 里的地址、相对自己的根路径去拼，拼歪了就是一个 404，
 *    表现为"列表加载出来了、然后说无法播放"。绝对地址把这层不确定性直接消掉，
 *    而且用请求方自己用的 Host 来拼，电视一定能回连（多网卡机器上尤其重要）。
 *
 * 所以这里同时要两个 base：
 *   · `srcBase`  —— 源播放列表的地址（解析相对地址用）；
 *   · `selfBase` —— 我们自己的地址（拼中转地址用，取自请求的 Host 头）。
 */
function rewritePlaylist(
  text: string,
  id: string,
  selfBase: string,
  srcBase: string,
  kind: 'index' | 'sub'
): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  const resolve = (uri: string): string => {
    try {
      return /^https?:/i.test(uri) ? uri : new URL(uri, srcBase).toString()
    } catch {
      return uri
    }
  }
  const proxy = (abs: string, forceSeg = false): string => {
    const isPlaylist = !forceSeg && /\.m3u8(\?|$)/i.test(abs)
    const route = isPlaylist ? (kind === 'index' ? 'sub' : 'seg') : 'seg'
    return `${selfBase}/${route}?u=${Buffer.from(abs, 'utf-8').toString('base64url')}`
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 里的 URI="..." 也要走我们（否则密钥取不到）
      out.push(line.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${proxy(resolve(uri))}"`))
      continue
    }
    out.push(proxy(resolve(line)))
  }
  return out.join('\n') + '\n'
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  /*
   * 数据同步接口（v0.3.8）：`/sync/*` 交给 castSync 处理。
   *
   * 为什么挂在这个服务上：它已经是唯一一个"仅监听局域网、手机必然知道地址"的入口
   * （每次投屏都会把 syncUrl 发给手机），再单开一个端口、再让手机去找地址纯属多余。
   * 用动态 import 是为了避免模块循环（castSync 需要 cast，cast 需要 castRelay）。
   */
  if (url.pathname.startsWith('/sync/')) {
    const chunks: Buffer[] = []
    let size = 0
    await new Promise<void>((resolve) => {
      req.on('data', (c: Buffer) => {
        size += c.byteLength
        // 同步的历史/收藏都是小 JSON；超过 2MB 直接截断，避免被人当上传口
        if (size <= 2 * 1024 * 1024) chunks.push(c)
      })
      req.on('end', () => resolve())
      req.on('error', () => resolve())
    })
    res.setHeader('Access-Control-Allow-Origin', '*')
    let payload: Record<string, unknown>
    try {
      const { handleCastSync } = await import('./castSync')
      const out = await handleCastSync(url.pathname, req.method ?? 'GET', Buffer.concat(chunks).toString('utf-8'))
      payload = out ?? { ok: false, error: '未知的同步接口' }
    } catch (err) {
      payload = { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
    return
  }
  const m = PATH_RE.exec(url.pathname)
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('sakana cast relay: not found')
    return
  }
  const session = sessions.get(m[1])
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('cast session gone')
    return
  }
  const route = m[2] as 'index.m3u8' | 'stream.mp4' | 'sub' | 'seg'
  const routeName: CastRelayHit['route'] =
    route === 'index.m3u8' ? 'index' : route === 'sub' ? 'sub' : route === 'seg' ? 'seg' : 'stream.mp4'
  session.hits += 1
  const remote = String(req.socket.remoteAddress ?? '')
  const t0 = Date.now()
  const hit: CastRelayHit = {
    at: t0,
    sinceMs: t0 - session.createdAt,
    route: routeName,
    method: req.method ?? 'GET',
    remote,
    local: isLocalAddr(remote),
    ua: String(req.headers['user-agent'] ?? ''),
    range: String(req.headers.range ?? ''),
    target: '',
    status: 0,
    bytes: 0,
    ms: 0
  }
  instrumentResponse(res, (status, bytes) => {
    hit.status = status
    hit.bytes = bytes
    hit.ms = Date.now() - t0
    recordHit(session, hit)
  })
  /*
   * 落盘重封装那条路（mode !== 'hls'）的 HEAD 与 GET 都由 serveRemuxFile 处理：
   * 它会在返回响应前确保文件已经重封装完成，然后带上 Content-Length（HEAD 也要有长度，
   * 部分电视会先 HEAD 拿长度再决定要不要播）。HLS 那条路的 HEAD 仍然只回类型与能力标志。
   */
  if (session.mode !== 'hls' && route === 'stream.mp4') {
    hit.target = session.source
    await serveRemuxFile(session, req, res)
    return
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': session.mode === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...dlnaHeaders(session.mode === 'hls' ? '01' : '00', session.mode === 'hls' ? 0 : 1)
    })
    res.end()
    return
  }
  /*
   * 用**请求方自己用的 Host** 拼我们自己的地址，电视一定能回连（多网卡机器上尤其重要）。
   * 但 Host 里必须带端口：HTTP/1.1 允许省略默认端口，一旦省略就说明对方是按 80 端口在说话
   * （多半是 Host 拼错了），这时不能用它拼分片地址 —— 那会把分片全拼到 80 端口上，
   * 表现为"列表拿到了、分片 404、于是无法播放"。这种情况退回我们自己算出来的局域网地址。
   */
  const hostHeader = String(req.headers.host ?? '')
  const selfBase = `http://${/:\d+$/.test(hostHeader) ? hostHeader : `${lanIPv4()}:${port}`}/cast/${session.id}`
  const target = route === 'index.m3u8'
    ? session.source
    : (() => {
        const u = url.searchParams.get('u')
        if (!u) return ''
        try {
          return Buffer.from(u, 'base64url').toString('utf-8')
        } catch {
          return ''
        }
      })()
  hit.target = target
  if (!target) {
    res.writeHead(400).end('bad target')
    return
  }
  try {
    /*
     * `seg` 路由也可能拿到一份播放列表：多级 HLS（主列表 → 主列表 → 媒体列表）里，
     * 子列表引用的还是 `.m3u8`，按"子列表"的规则它会被改写成 `seg` 路由。
     * 这种情况必须**继续按播放列表改写**，否则那份列表会被原样透传出去 ——
     * 里面的地址没经过我们，密钥/分片就会 403（原样透传在自检里看着还"成功"）。
     */
    const isPlaylist = route === 'index.m3u8' || route === 'sub' || (route === 'seg' && /\.m3u8(\?|$)/i.test(target))
    if (isPlaylist) {
      const r = await axios.get<string>(target, {
        timeout: 20000,
        responseType: 'text',
        maxRedirects: 5,
        headers: headersFor(session),
        ...buildProxyAgents(getSettings().proxy)
      })
      const body = rewritePlaylist(
        String(r.data ?? ''),
        session.id,
        selfBase,
        target,
        route === 'index.m3u8' ? 'index' : 'sub'
      )
      // 播放列表不能被缓存：站点地址里有一次性令牌，缓存住会导致下一次投屏放不出来
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        ...dlnaHeaders('01', 0)
      })
      res.end(body)
      return
    }
    /*
     * 分片 / 文件：**原样透传**（含 Range）。
     * 这里刻意用 stream 而不是先读进内存：一集分片几百 KB、整段文件可能几个 GB，
     * 读进内存既慢又容易把主进程顶爆。
     */
    const range = req.headers.range
    const upstream = await axios.get(target, {
      timeout: 30000,
      responseType: 'stream',
      maxRedirects: 5,
      headers: { ...headersFor(session), ...(range ? { Range: range } : {}) },
      validateStatus: () => true,
      ...buildProxyAgents(getSettings().proxy)
    })
    const pass: Record<string, string> = {
      /*
       * 分片的 Content-Type 用源站给的原值（退回 octet-stream）。
       * 这里不去硬改成 `video/mp2t`：一是源站给 `video/MP2T` 与 `video/mp2t` 都有先例，
       * 二是分片是不是 TS 由播放列表说，不靠这个头（电视也基本不看它）。
       */
      'Content-Type': String(upstream.headers['content-type'] ?? 'application/octet-stream'),
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      ...dlnaHeaders('01', 0)
    }
    for (const k of ['content-length', 'content-range'] as const) {
      const v = upstream.headers[k]
      if (v) pass[k === 'content-length' ? 'Content-Length' : 'Content-Range'] = String(v)
    }
    res.writeHead(upstream.status, pass)
    upstream.data.pipe(res)
  } catch (err) {
    log.append('warn', 'cast', `中转取流失败: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
    if (!res.headersSent) res.writeHead(502).end('upstream failed')
    else res.end()
  }
}

export function stopCastServer(): void {
  stopCastRelay()
  if (server) {
    try {
      server.close()
    } catch {
      /* ignore */
    }
    server = null
    port = 0
  }
}

/**
 * 提前把中转/同步服务拉起来（v0.3.8）。
 *
 * 为什么要单独暴露：同步接口（`/sync/*`）在**没有投屏**时也要能用 ——
 * 手机端随时可能来拉收藏/历史，而这时可能还没投过任何东西（服务还没被 startCastRelay 唤醒）。
 */
export async function ensureCastServer(): Promise<number> {
  return await ensureServer()
}

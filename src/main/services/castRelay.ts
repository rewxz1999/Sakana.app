import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'
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
  /** MP4 模式：FFmpeg 进程与它的状态 */
  proc?: import('node:child_process').ChildProcess | null
  stderrTail?: string
  /** MP4 模式：已经在拉的数据（首帧前后的等待者） */
  startedAt?: number
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
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id)
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
  sessions.set(id, { id, source, headers, createdAt: Date.now(), hls, mode, hits: 0 })
  const base = `http://${lanIPv4()}:${p}/cast/${id}`
  return {
    id,
    url: mode === 'hls' ? `${base}/index.m3u8` : `${base}/stream.mp4`,
    kind: mode === 'hls' ? 'hls' : 'file',
    lanIp: lanIPv4(),
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

export function stopCastRelay(id?: string): void {
  if (id) sessions.delete(id)
  else sessions.clear()
}

export function castRelayUrl(): { ip: string; port: number } {
  return { ip: lanIPv4(), port }
}

// ---------------- HTTP ----------------

const PATH_RE = /^\/cast\/([A-Za-z0-9_-]+)\/(index\.m3u8|stream\.mp4|sub|seg)$/

/**
 * MP4 模式：把源重新封装成一路渐进式 MP4，边转边发给电视。
 *
 * 为什么用 `-c:v copy`：视频流原样复制（不重编码），只换容器 —— 这是"电视不认 HLS"时
 * 唯一既兼容又不损失画质的办法。音频统一转 AAC：不少电视不认 AC-3/E-AC-3/FLAC。
 */
function pipeRemux(session: RelaySession, req: IncomingMessage, res: ServerResponse): void {
  const ffmpeg = ffmpegExe()
  if (!ffmpeg) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('未找到 FFmpeg，无法为电视重新封装该流')
    return
  }
  // 上一次的进程还在（电视重连/重试）：先收掉，避免同时拉两路占带宽
  if (session.proc) {
    try {
      session.proc.kill()
    } catch {
      /* ignore */
    }
    session.proc = null
  }
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
  args.push('-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1')

  let proc: import('node:child_process').ChildProcess
  try {
    proc = spawn(ffmpeg, args, { windowsHide: true })
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`FFmpeg 启动失败：${String(err)}`)
    return
  }
  session.proc = proc
  session.startedAt = Date.now()
  session.stderrTail = ''
  proc.stdout?.on('data', (chunk: Buffer) => {
    if (!res.write(chunk)) proc.stdout?.pause()
  })
  res.on('drain', () => proc.stdout?.resume())
  proc.stderr?.on('data', (d: Buffer) => {
    session.stderrTail = ((session.stderrTail ?? '') + d.toString('utf-8')).slice(-800)
  })
  proc.on('error', (err) => {
    log.append('error', 'cast', `投屏重新封装进程错误: ${err.message}`)
    try {
      res.end()
    } catch {
      /* ignore */
    }
  })
  proc.on('close', () => {
    if (session.proc === proc) session.proc = null
    try {
      res.end()
    } catch {
      /* ignore */
    }
  })
  // 电视中途断开：立刻收掉 FFmpeg，别让它在后台一直拉流
  req.on('close', () => {
    if (session.proc === proc) {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      session.proc = null
    }
  })
}

/**
 * 把播放列表里的 URI 换成"经过我们"的地址；绝对地址放进查询串里（base64url 免得转义）。
 *
 * ⚠️ 相对地址必须相对**源播放列表自己的地址**解析，不能相对我们的中转地址 ——
 * 这个错自检当场抓到过：`test.m3u8` 里写的是 `seg0.ts`，早先按我们的地址解析成了
 * `http://<本机>:52890/cast/seg0.ts`（404）。所以这里同时要两个 base：
 *   · `srcBase` —— 源播放列表的地址（解析相对地址用）；
 *   · `selfBase` —— 我们自己的地址（拼中转地址用）。
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
    return `/cast/${id}/${route}?u=${Buffer.from(abs, 'utf-8').toString('base64url')}`
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
  session.hits += 1
  if (session.hits === 1) {
    // 第一次被取流 = 电视真的连上了我们（排查防火墙时这是最关键的一行日志）
    log.append('info', 'cast', `电视已开始从本机取流（${m[2]}）`)
  }
  // MP4/转码模式：交给 FFmpeg 边转边发（下面那些走 HTTP 取源的逻辑不适用）
  if (session.mode !== 'hls' && m[2] === 'stream.mp4') {
    pipeRemux(session, req, res)
    return
  }
  const selfBase = `http://${req.headers.host ?? `${lanIPv4()}:${port}`}/cast/${session.id}`
  const target = m[2] === 'index.m3u8'
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
  if (!target) {
    res.writeHead(400).end('bad target')
    return
  }
  try {
    const isPlaylist = m[2] === 'index.m3u8' || m[2] === 'sub'
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
        m[2] === 'sub' ? 'sub' : 'index'
      )
      // 播放列表不能被缓存：站点地址里有一次性令牌，缓存住会导致下一次投屏放不出来
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
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
      'Content-Type': String(upstream.headers['content-type'] ?? 'application/octet-stream'),
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
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

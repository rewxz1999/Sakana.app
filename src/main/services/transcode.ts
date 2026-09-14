import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { LiveStartResult, MediaInspectResult } from '@shared/types'
import { log } from '../log'
import { getSettings } from '../net'
import { handleAdProxyRequest, proxyHlsUrl, setAdProxyPort } from './adFilter'

/**
 * FFmpeg 转码播放管线
 * - Chromium 不支持的编码（H.265/HEVC、DDP5.1/E-AC-3、AC-3、DTS 等）经 FFmpeg 实时转换：
 *   视频可复制（hvc1）或转 H.264（1080p veryfast），音频转 AAC，输出分片 MP4 流
 * - 输出经本机 HTTP（http://127.0.0.1:<port>/live/<id>）边转边播；
 *   seek 通过重启 ffmpeg 加 -ss 实现
 *
 * 为什么必须是本机 HTTP 而不是自定义协议：
 * sakana-live:// 只有 Electron/Chromium 认识，libVLC 与 libmpv 都是独立媒体栈，
 * 拿到这个 URL 会直接打不开（此前中转回退因此在两个内核上都失效）。
 * 本机 HTTP 渲染层 <video>、libVLC、libmpv 三方都能播，所以统一用它。
 */

interface LiveSession {
  id: string
  proc: ChildProcess | null
  file: string
  mode: 'vcopy' | 'vtranscode'
  startSec: number
  ended: boolean
  /** 已产出的分片 MP4 数据（回放缓冲）：中途接入的客户端可从头开始播 */
  chunks: Buffer[]
  bytes: number
  trimmed: boolean
  clients: Set<ServerResponse>
  /** FFmpeg 结束后保留缓冲的定时器：让晚到的客户端仍能从头播放 */
  reapTimer?: NodeJS.Timeout
}

const sessions = new Map<string, LiveSession>()

/** 回放缓冲上限：够中途接入的客户端从头开始播，又不会无限吃内存 */
const LIVE_BUFFER_LIMIT = 48 * 1024 * 1024

let liveServer: Server | null = null
let livePort = 0

/** 启动本机中转 HTTP 服务（应用启动时调用一次，之后 liveUrl 同步可用） */
export function initLiveServer(): Promise<number> {
  if (liveServer && livePort > 0) return Promise.resolve(livePort)
  return new Promise<number>((resolve) => {
    const server = createServer((req, res) => {
      // 在线播放的 HLS 改写代理复用同一个监听端口（见 adFilter.ts）
      if (handleAdProxyRequest(req, res)) return
      const id = /^\/live\/([A-Za-z0-9_-]+)/.exec(req.url ?? '')?.[1] ?? ''
      const s = sessions.get(id)
      if (!s) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('live session gone')
        return
      }
      // 注意：FFmpeg 已结束（s.ended）但仍留有缓冲时照样服务，否则短文件/重连会拿到 404
      // 无 Content-Length → Node 用 chunked 输出，边转边播；忽略 Range（不可 seek）
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'none'
      })
      for (const c of s.chunks) res.write(c)
      s.clients.add(res)
      const drop = (): void => {
        s.clients.delete(res)
      }
      res.on('close', drop)
      res.on('error', drop)
      log.append('info', 'ffmpeg', `中转流接入客户端（已回放 ${Math.round(s.bytes / 1024)}KB）`)
    })
    server.on('error', (err) => {
      log.append('error', 'ffmpeg', `中转流服务启动失败: ${err.message}`)
      resolve(0)
    })
    server.listen(0, '127.0.0.1', () => {
      liveServer = server
      livePort = (server.address() as AddressInfo).port
      // 把端口交给 HLS 改写代理：它复用这个监听端口提供改写后的播放列表
      setAdProxyPort(livePort)
      log.append('info', 'ffmpeg', `中转流服务已启动: http://127.0.0.1:${livePort}/live/<id>`)
      resolve(livePort)
    })
  })
}

/** 会话的中转地址；服务未就绪时直接报错，避免返回内核打不开的自定义协议地址 */
function liveUrl(id: string): string {
  if (livePort <= 0) {
    throw new Error('中转流服务未就绪（本机 HTTP 端口未监听），请重试或重启应用')
  }
  return `http://127.0.0.1:${livePort}/live/${id}`
}

/** 客户端单连接积压上限：真的跟不上才断开（背压 ≠ 太慢） */
const LIVE_CLIENT_LIMIT = 64 * 1024 * 1024

/** 把 FFmpeg 输出接到回放缓冲 + 所有在线客户端 */
function pipeLiveOutput(s: LiveSession): void {
  const out = s.proc?.stdout
  if (!out) return
  out.on('data', (d: Buffer) => {
    s.chunks.push(d)
    s.bytes += d.length
    while (s.bytes > LIVE_BUFFER_LIMIT && s.chunks.length > 1) {
      const dropped = s.chunks.shift()!
      s.bytes -= dropped.length
      s.trimmed = true
    }
    for (const c of [...s.clients]) {
      if (c.writableEnded || c.destroyed) {
        s.clients.delete(c)
        continue
      }
      /*
       * 注意：res.write() 返回 false 只是「内核缓冲已满」这一正常背压信号，
       * 数据仍会被排入队列。这里如果因为 false 就 destroy，会直接掐断连接，
       * 播放器（libmpv/libcurl）会报 “Transferred a partial file” 而无法开播。
       * 只有在积压真的超过上限时才断开，避免内存无上限增长。
       */
      if (c.writableLength > LIVE_CLIENT_LIMIT) {
        log.append('warn', 'ffmpeg', `中转流客户端积压过多，已断开（${Math.round(c.writableLength / 1024)}KB）`)
        try {
          c.destroy()
        } catch {
          /* ignore */
        }
        s.clients.delete(c)
        continue
      }
      c.write(d)
    }
  })
  out.on('end', () => {
    // 不立刻删除会话：短文件（FFmpeg 秒转完）或播放器重连时，
    // 晚到的客户端仍需读到已产出的数据，否则会拿到 404。
    s.ended = true
    if (s.reapTimer) clearTimeout(s.reapTimer)
    // 缓冲只为"晚到的客户端"保留，30 秒足够；此前保留 120 秒会白占最多 48MB 内存
    s.reapTimer = setTimeout(() => {
      for (const c of [...s.clients]) {
        try {
          c.end()
        } catch {
          /* ignore */
        }
      }
      s.clients.clear()
      s.chunks = []
      s.bytes = 0
      sessions.delete(s.id)
    }, 30_000)
  })
}

const COMPAT_VIDEO = new Set(['h264', 'av1', 'vp8', 'vp9', 'theora'])
const COMPAT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le'])

function bundledFfmpeg(exe: string): string | null {
  const candidates = [
    join(app.getAppPath(), 'resources', 'ffmpeg', exe),
    join(process.resourcesPath ?? '', 'ffmpeg', exe)
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

export function ffmpegExe(): string | null {
  const cfg = getSettings()
  if (cfg.ffmpegPath && existsSync(cfg.ffmpegPath)) return cfg.ffmpegPath
  return bundledFfmpeg('ffmpeg.exe')
}

function ffprobeExe(): string | null {
  const cfg = getSettings()
  if (cfg.ffmpegPath) {
    const dir = cfg.ffmpegPath.replace(/[\\/][^\\/]*$/, '')
    const probe = join(dir, 'ffprobe.exe')
    if (existsSync(probe)) return probe
  }
  return bundledFfmpeg('ffprobe.exe')
}

function runCapture(exe: string, args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let child: ChildProcess
    try {
      child = spawn(exe, args, { windowsHide: true })
    } catch (e) {
      reject(e)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('探测超时'))
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf-8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf-8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err.slice(-300) || `exit ${code}`))
    })
  })
}

/** 探测媒体编码（ffprobe），判断 Chromium 是否可直接播放 */
export async function inspectMedia(path: string): Promise<MediaInspectResult> {
  const probe = ffprobeExe()
  if (!probe) {
    return {
      videoCodec: null,
      audioCodec: null,
      width: null,
      height: null,
      durationSec: 0,
      compatible: true,
      reason: '未安装 FFmpeg（无法探测编码，按兼容处理）',
      hasFfmpeg: false
    }
  }
  try {
    const json = await runCapture(probe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', path])
    const data = JSON.parse(json) as {
      streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[]
      format?: { duration?: string }
    }
    const video = data.streams?.find((s) => s.codec_type === 'video') ?? null
    const audio = data.streams?.find((s) => s.codec_type === 'audio') ?? null
    const videoCodec = video?.codec_name ?? null
    const audioCodec = audio?.codec_name ?? null
    const durationSec = Math.round(Number(data.format?.duration ?? 0))
    const compatible =
      !!videoCodec &&
      COMPAT_VIDEO.has(videoCodec) &&
      (!audioCodec || COMPAT_AUDIO.has(audioCodec))
    const reasons: string[] = []
    if (videoCodec && !COMPAT_VIDEO.has(videoCodec)) reasons.push(`视频编码 ${videoCodec.toUpperCase()} 不支持`)
    if (audioCodec && !COMPAT_AUDIO.has(audioCodec)) reasons.push(`音轨编码 ${audioCodec.toUpperCase()} 不支持`)
    return {
      videoCodec,
      audioCodec,
      width: video?.width ?? null,
      height: video?.height ?? null,
      durationSec,
      compatible,
      reason: reasons.join('；') || '可直接播放',
      hasFfmpeg: true
    }
  } catch (err) {
    log.append('warn', 'ffmpeg', `ffprobe 失败 (${path}): ${String(err)}`)
    return {
      videoCodec: null,
      audioCodec: null,
      width: null,
      height: null,
      durationSec: 0,
      compatible: true,
      reason: `探测失败（${String(err).slice(0, 80)}），按兼容处理`,
      hasFfmpeg: true
    }
  }
}

function stopSession(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  s.ended = true
  if (s.reapTimer) {
    clearTimeout(s.reapTimer)
    s.reapTimer = undefined
  }
  for (const c of [...s.clients]) {
    try {
      c.end()
    } catch {
      /* ignore */
    }
  }
  s.clients.clear()
  try {
    s.proc?.kill()
  } catch {
    /* ignore */
  }
  s.proc = null
  sessions.delete(id)
}

export function stopAllLive(): void {
  for (const id of [...sessions.keys()]) stopSession(id)
}

/** 启动转码流会话（vcopy=视频复制 / vtranscode=视频转 H.264） */
export function startLive(
  path: string,
  opts: {
    mode: 'vcopy' | 'vtranscode'
    startSec?: number
    height?: number | null
    videoCodec?: string | null
  }
): LiveStartResult {
  const ffmpeg = ffmpegExe()
  if (!ffmpeg) {
    throw new Error('未找到 FFmpeg：请运行 npm run ffmpeg:fetch 下载，或在设置中指定 ffmpeg.exe 路径')
  }
  // 全局同时只保留一个转码会话
  for (const id of [...sessions.keys()]) stopSession(id)

  const id = randomUUID()
  const startSec = Math.max(0, Math.round(opts.startSec ?? 0))
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y']
  if (startSec > 0) args.push('-ss', String(startSec))
  args.push('-i', path)
  // 视频：hevc 复制需要 hvc1 标签（MP4 HEVC 需硬件解码）；转码则降到 1080p
  args.push('-map', '0:v:0')
  if (opts.mode === 'vcopy') {
    args.push('-c:v', 'copy')
    // hvc1 标签只对 HEVC 有效：对 H.264 源加该标签会让 FFmpeg 直接报
    // “Tag hvc1 incompatible with output codec id '27' (avc1)” 并退出。
    // H.264 视频 + AC3/DTS 音轨这类常见组合正是走 vcopy，因此必须按实际编码判断。
    const codec = String(opts.videoCodec ?? '').toLowerCase()
    if (codec === 'hevc' || codec === 'h265') args.push('-tag:v', 'hvc1')
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p')
    if (opts.height && opts.height > 1080) {
      args.push('-vf', 'scale=-2:1080')
    }
  }
  // 音频：AAC 复制，其余转 AAC 立体声
  args.push('-map', '0:a:0?')
  args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2')
  args.push('-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1')

  let proc: ChildProcess
  try {
    proc = spawn(ffmpeg, args, { windowsHide: true })
  } catch (err) {
    throw new Error(`FFmpeg 启动失败: ${String(err)}`)
  }
  let stderrTail = ''
  proc.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString('utf-8')).slice(-600)
  })
  proc.on('error', (err) => {
    log.append('error', 'ffmpeg', `转码进程错误: ${err.message}`)
    stopSession(id)
  })
  proc.on('close', (code) => {
    const s = sessions.get(id)
    if (s && !s.ended && code !== 0) {
      log.append('warn', 'ffmpeg', `转码提前结束 (${code}): ${stderrTail.slice(-200)}`)
    }
    // 会话不在这里删除：stdout end 时会保留缓冲一段时间，供晚到的客户端读取
  })

  const session: LiveSession = {
    id,
    proc,
    file: path,
    mode: opts.mode,
    startSec,
    ended: false,
    chunks: [],
    bytes: 0,
    trimmed: false,
    clients: new Set()
  }
  sessions.set(id, session)
  pipeLiveOutput(session)
  log.append(
    'info',
    'ffmpeg',
    `转码流启动 (${opts.mode === 'vcopy' ? '视频复制' : '视频转码'}${startSec > 0 ? ` @${startSec}s` : ''}): ${path}`
  )
  return { sessionId: id, url: liveUrl(id), mode: opts.mode }
}

export function liveStream(id: string): NodeJS.ReadableStream | null {
  const s = sessions.get(id)
  if (!s || s.ended || !s.proc?.stdout) return null
  return s.proc.stdout
}

/**
 * 在线流中转（FFmpeg relay）：
 * 有些 CDN 会对 libVLC 的 HTTP 栈返回错误（但浏览器/其它客户端正常），
 * 这里让 FFmpeg 带着 UA / Referer / Cookie 去取流，remux 成 MP4 分片后经
 * sakana-live:// 交给播放器——等于给播放器换一套取流实现。
 */
export function startLiveUrl(
  inputUrl: string,
  opts: { referer?: string; cookies?: string; userAgent?: string } = {}
): LiveStartResult {
  const ffmpeg = ffmpegExe()
  if (!ffmpeg) throw new Error('未找到 FFmpeg：无法中转该在线流')
  for (const id of [...sessions.keys()]) stopSession(id)

  const id = randomUUID()
  const ua =
    opts.userAgent ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  const headerLines: string[] = []
  if (opts.referer) headerLines.push(`Referer: ${opts.referer}`)
  if (opts.cookies) headerLines.push(`Cookie: ${opts.cookies}`)

  /*
   * 广告过滤：把 m3u8 输入换成本机改写代理地址。
   * FFmpeg 的 -headers 对整个输入（含后续分片请求）生效，
   * 因此 Referer/Cookie 仍会随每个广告外分片一起发往 CDN，取流行为不变。
   */
  const input = proxyHlsUrl(inputUrl, { referer: opts.referer, cookies: opts.cookies, userAgent: ua })

  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y']
  args.push('-user_agent', ua)
  if (headerLines.length > 0) args.push('-headers', headerLines.join('\r\n') + '\r\n')
  // 网络流容错参数：HLS/mp4 都适用
  args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5')
  // 注意：这里不能加 -re。对 moov 在尾部的非 faststart MP4，-re 会把输入读取
  // 限速到实时，反而让首帧出不来（实测中转一直 0 字节）。
  args.push('-i', input)
  args.push('-map', '0:v:0?', '-map', '0:a:0?')
  args.push('-c:v', 'copy')
  args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2')
  args.push('-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1')

  let proc: ChildProcess
  try {
    proc = spawn(ffmpeg, args, { windowsHide: true })
  } catch (err) {
    throw new Error(`FFmpeg 中转启动失败: ${String(err)}`)
  }
  let stderrTail = ''
  proc.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString('utf-8')).slice(-600)
  })
  proc.on('error', (err) => {
    log.append('error', 'ffmpeg', `在线中转进程错误: ${err.message}`)
    stopSession(id)
  })
  proc.on('close', (code) => {
    const s = sessions.get(id)
    if (s && !s.ended && code !== 0) {
      log.append('warn', 'ffmpeg', `在线中转提前结束 (${code}): ${stderrTail.slice(-200)}`)
    }
    // 同上：保留会话与缓冲，交由 reapTimer 回收
  })

  const session: LiveSession = {
    id,
    proc,
    file: input,
    mode: 'vcopy',
    startSec: 0,
    ended: false,
    chunks: [],
    bytes: 0,
    trimmed: false,
    clients: new Set()
  }
  sessions.set(id, session)
  pipeLiveOutput(session)
  log.append('info', 'ffmpeg', `在线流中转启动: ${input.slice(0, 120)}`)
  return { sessionId: id, url: liveUrl(id), mode: 'vcopy' }
}

export function liveSessionMode(id: string): 'vcopy' | 'vtranscode' | null {
  return sessions.get(id)?.mode ?? null
}

export function stopLive(id: string): void {
  stopSession(id)
}

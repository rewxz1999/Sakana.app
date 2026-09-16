import { app, protocol } from 'electron'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import iconv from 'iconv-lite'
import type { LocalSubFile, LocalVideoFile } from '@shared/types'
import { parseEpisode } from '../lib/parse'
import { log } from '../log'
import { BROWSER_UA, getSettings } from '../net'
import { rewriteImageUrl, unresizedImageUrl } from './bangumi'
import { liveStream } from './transcode'

const VIDEO_EXTS = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.avi',
  '.mov',
  '.flv',
  '.ts',
  '.m4v',
  '.rmvb',
  '.wmv',
  '.mpg',
  '.mpeg',
  '.3gp',
  '.ogv',
  '.m2ts'
])
const SUB_EXTS = new Set(['.srt', '.ass', '.ssa', '.vtt'])
const IMAGE_EXTS: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif'
}
const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.m4v': 'video/x-m4v',
  '.rmvb': 'application/vnd.rn-realmedia',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.ogv': 'video/ogg',
  '.m2ts': 'video/mp2t'
}
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_SCAN_DEPTH = 5
// 视频元素带 crossOrigin="anonymous"，协议响应必须带 CORS 头，否则媒体加载被拒
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
}

/**
 * 自定义协议（图片代理 + 本地媒体流 + 字幕转换）
 * - sakana-img://fetch/<base64url>   远程图片（带 UA/Referer，bangumi 图床需要），磁盘缓存
 * - sakana-img://local/<base64url>   本地文件图片（工具封面等）
 * - sakana-media://local/<base64url> 本地视频（支持 Range 拖动进度条）
 * - sakana-sub://local/<base64url>   本地字幕（srt/ass/ssa 实时转 WebVTT，GBK 自动识别）
 */
function decodeTarget(pathname: string): { kind: 'local' | 'http'; target: string } {
  const seg = pathname.split('/').filter(Boolean)
  const isLocal = seg[0] === 'local'
  const b64 = seg[seg.length - 1] ?? ''
  let target = ''
  try {
    target = Buffer.from(b64, 'base64url').toString('utf-8')
  } catch {
    target = ''
  }
  const looksLikePath =
    /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('\\\\') || target.startsWith('/')
  return { kind: isLocal || looksLikePath ? 'local' : 'http', target }
}

/**
 * 允许通过自定义协议读取的本地目录白名单。
 *
 * 安全背景：`sakana-media://` / `sakana-sub://` / `sakana-img://local` 会把 Base64 解码成
 * 本地路径直接读盘——等于渲染层（以及被它加载的任何脚本）能读取任意本地文件。
 * 这里只放行应用自己用过的目录：下载目录、缓存目录、用户数据目录，
 * 以及用户明确打开过的视频/剧集文件夹（由 listVideos 记录）。
 */
const allowedRoots = new Set<string>()

export function allowMediaRoot(dir: string): void {
  if (!dir) return
  try {
    allowedRoots.add(resolve(dir).toLowerCase())
  } catch {
    /* ignore */
  }
}

function registerDefaultRoots(): void {
  const s = getSettings()
  const dirs = [
    s.downloadDir,
    s.cacheDir,
    s.screenshotDir,
    join(app.getPath('userData'), 'downloads'),
    join(app.getPath('userData'), 'cache'),
    join(app.getPath('userData'), 'screenshots'),
    app.getPath('userData'),
    app.getPath('temp')
  ]
  for (const d of dirs) if (d) allowMediaRoot(d)
}

/** 路径是否在白名单目录内（防目录穿越：先解析成绝对路径再前缀比较） */
function isPathAllowed(p: string): boolean {
  if (!p) return false
  let abs: string
  try {
    abs = resolve(p).toLowerCase()
  } catch {
    return false
  }
  for (const root of allowedRoots) {
    if (abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep)) return true
  }
  return false
}

function imageCacheDir(): string {
  // 缓存根目录可由「设置 → 缓存设置」自定义（留空则 userData/cache）
  const root = getSettings().cacheDir?.trim() || join(app.getPath('userData'), 'cache')
  const dir = join(root, 'img')
  mkdirSync(dir, { recursive: true })
  return dir
}

const inflight = new Map<string, Promise<Response>>()

export function registerMediaProtocols(): void {
  registerDefaultRoots()
  protocol.handle('sakana-img', async (req) => {
    const url = new URL(req.url)
    const { kind, target } = decodeTarget(url.pathname)
    try {
      if (kind === 'local') {
        if (!target || !existsSync(target)) return new Response('not found', { status: 404 })
        if (!isPathAllowed(target)) {
          log.append('warn', 'img', `拒绝读取白名单外的路径: ${target}`)
          return new Response('forbidden', { status: 403 })
        }
        const ext = extname(target).toLowerCase()
        const type = IMAGE_EXTS[ext] ?? 'application/octet-stream'
        return new Response(createReadStream(target) as unknown as ReadableStream, {
          headers: { 'Content-Type': type, 'Cache-Control': 'max-age=86400' }
        })
      }
      return await fetchImageWithCache(target)
    } catch (err) {
      log.append('warn', 'img', `图片加载失败 (${target}): ${String(err)}`)
      return new Response('error', { status: 502 })
    }
  })

  protocol.handle('sakana-media', async (req) => {
    const url = new URL(req.url)
    const { target } = decodeTarget(url.pathname)
    try {
      if (!target || !existsSync(target)) return new Response('not found', { status: 404 })
      if (!isPathAllowed(target)) {
        log.append('warn', 'media', `拒绝读取白名单外的路径: ${target}`)
        return new Response('forbidden', { status: 403 })
      }
      const stat = statSync(target)
      const size = stat.size
      const ext = extname(target).toLowerCase()
      const type = VIDEO_TYPES[ext] ?? 'application/octet-stream'
      const range = req.headers.get('range')
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0
          const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
          if (start <= end && start < size) {
            const stream = createReadStream(target, { start, end }) as unknown as ReadableStream
            return new Response(stream, {
              status: 206,
              headers: {
                ...CORS_HEADERS,
                'Content-Type': type,
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': String(end - start + 1)
              }
            })
          }
        }
      }
      return new Response(createReadStream(target) as unknown as ReadableStream, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': type,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(size)
        }
      })
    } catch (err) {
      return new Response('error', { status: 500 })
    }
  })

  protocol.handle('sakana-sub', async (req) => {
    const url = new URL(req.url)
    const { target } = decodeTarget(url.pathname)
    try {
      if (!target || !existsSync(target)) return new Response('not found', { status: 404 })
      if (!isPathAllowed(target)) {
        log.append('warn', 'media', `拒绝读取白名单外的字幕: ${target}`)
        return new Response('forbidden', { status: 403 })
      }
      const vtt = convertSubtitleToVtt(target)
      return new Response(vtt, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'no-cache'
        }
      })
    } catch (err) {
      log.append('warn', 'media', `字幕转换失败 (${target}): ${String(err)}`)
      return new Response('error', { status: 500 })
    }
  })

  // 转码流（FFmpeg 边转边播，无 Content-Length，不支持 Range/seek）
  protocol.handle('sakana-live', async (req) => {
    const url = new URL(req.url)
    const sessionId = url.pathname.split('/').filter(Boolean)[0] ?? ''
    try {
      const stream = liveStream(sessionId)
      if (!stream) return new Response('session gone', { status: 404 })
      return new Response(stream as unknown as ReadableStream, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'video/mp4',
          'Cache-Control': 'no-store'
        }
      })
    } catch (err) {
      return new Response('error', { status: 500 })
    }
  })
}

// ---------------- 字幕转换 ----------------

/** 读取字幕文件（UTF-8 优先，失败回退 GBK/GB18030） */
function readSubText(path: string): string {
  const buf = readFileSync(path)
  let text = buf.toString('utf-8')
  if (text.includes('\uFFFD')) {
    text = iconv.decode(buf, 'gb18030')
  }
  return text.replace(/^\uFEFF/, '')
}

function srtToVtt(text: string): string {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
  const cues: string[] = []
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) continue
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    if (timeIdx < 0) continue
    const timeLine = lines[timeIdx].replace(/,/g, '.')
    const cueText = lines.slice(timeIdx + 1).join('\n')
    if (!cueText) continue
    cues.push(`${timeLine}\n${cueText}`)
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

function assTimeToVtt(t: string): string {
  const m = /(\d+):(\d+):(\d+)[.:](\d+)/.exec(t)
  if (!m) return '00:00:00.000'
  const h = m[1].padStart(2, '0')
  const mm = m[2].padStart(2, '0')
  const ss = m[3].padStart(2, '0')
  // ASS 为厘秒，VTT 为毫秒：×10
  const ms = (m[4] + '0').slice(0, 3).padStart(3, '0')
  return `${h}:${mm}:${ss}.${ms}`
}

function assToVtt(text: string): string {
  const cues: string[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (const line of lines) {
    if (!line.startsWith('Dialogue:')) continue
    const body = line.slice('Dialogue:'.length)
    const parts = body.split(',')
    if (parts.length < 9) continue
    const start = parts[1].trim()
    const end = parts[2].trim()
    const cueText = parts
      .slice(9)
      .join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\h/g, ' ')
      .trim()
    if (!cueText) continue
    cues.push(`${assTimeToVtt(start)} --> ${assTimeToVtt(end)}\n${cueText}`)
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

export function convertSubtitleToVtt(path: string): string {
  const ext = extname(path).toLowerCase()
  const text = readSubText(path)
  if (ext === '.srt') return srtToVtt(text)
  if (ext === '.ass' || ext === '.ssa') return assToVtt(text)
  if (ext === '.vtt') return text.startsWith('WEBVTT') ? text : `WEBVTT\n\n${text}`
  return 'WEBVTT\n\n'
}

// ---------------- 图片代理 ----------------

/** 按图床域名选择 Referer（lain.bgm.tv 主站 / 镜像站自己的图床） */
function refererFor(target: string): string | undefined {
  try {
    const host = new URL(target).hostname.toLowerCase()
    // 镜像图床（lain.bangumi.vip 等）实测不带 Referer 也放行，带上更稳妥
    if (host.includes('bangumi.vip')) return 'https://bangumi.vip/'
    if (host.includes('bangumi.pro')) return 'https://bangumi.pro/'
    if (host.includes('bangumi.lol')) return 'https://bangumi.lol/'
    // 自建反代（Cloudflare Worker）自己会带正确的上游 Referer，本地不必再补
    if (host.endsWith('.workers.dev')) return undefined
    if (host.includes('bgm.tv')) return 'https://bgm.tv/'
  } catch {
    /* ignore */
  }
  return undefined
}

/**
 * 图片取数的并发闸门（v0.2.7 附加）。
 *
 * 番剧表一屏就有十几张卡片，收藏/搜索结果更多。过去它们是**一次性全部并发**打向图片反代，
 * 实测反代在并发下会明显劣化（同图并发 4 时单张要 200 秒，并发 8 时 48 秒），
 * 表现就是「卡片经常加载不出来」。这里限制同时最多 4 张在取，其余排队 ——
 * 单张只要 0.6~1 秒，整体反而更快、更稳定。
 */
const IMG_CONCURRENCY = 4
let imgInFlight = 0
const imgQueue: (() => void)[] = []

async function withImageSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (imgInFlight >= IMG_CONCURRENCY) {
    await new Promise<void>((resolve) => imgQueue.push(resolve))
  }
  imgInFlight += 1
  try {
    return await fn()
  } finally {
    imgInFlight -= 1
    const next = imgQueue.shift()
    if (next) next()
  }
}

/** 单次图片请求超时（毫秒）：卡住的图不能一直占着并发额度 */
const IMG_TIMEOUT = 20000

async function fetchImageOnce(target: string): Promise<Response> {
  const headers: Record<string, string> = { 'User-Agent': BROWSER_UA }
  const referer = refererFor(target)
  if (referer) headers['Referer'] = referer
  const res = await fetch(target, { headers, signal: AbortSignal.timeout(IMG_TIMEOUT) })
  return res
}

async function fetchImageWithCache(rawTarget: string): Promise<Response> {
  // 配了自建图片反代时，官方图床地址改写到反代域名（Worker 按路径转发 + 按需缩放）
  const target = rewriteImageUrl(rawTarget)
  const existing = inflight.get(target)
  if (existing) return existing
  const p = (async () => {
    const hash = createHash('sha1').update(target).digest('hex').slice(0, 24)
    const ext = (() => {
      const e = extname(new URL(target).pathname).toLowerCase()
      return IMAGE_EXTS[e] ? e : '.img'
    })()
    const cachePath = join(imageCacheDir(), `${hash}${ext}`)
    if (existsSync(cachePath)) {
      const type = IMAGE_EXTS[ext] ?? 'image/jpeg'
      return new Response(createReadStream(cachePath) as unknown as ReadableStream, {
        headers: { 'Content-Type': type, 'Cache-Control': 'max-age=86400' }
      })
    }
    /*
     * 取图：并发受限 + 超时 + 一次重试 + 缩放路径兜底（v0.2.7 附加）。
     * 反代在并发下会瞬时 429/5xx 或变慢，过去一次失败就直接给界面 502 →
     * 卡片永久显示占位图（CoverImage 的 onError 之后不再重试）。
     */
    const attempt = async (url: string): Promise<Response | null> => {
      for (let i = 0; i < 2; i++) {
        try {
          const res = await withImageSlot(() => fetchImageOnce(url))
          if (res.ok) return res
          if (res.status < 500 && res.status !== 429) return null // 4xx：重试也没意义
          await new Promise((r) => setTimeout(r, 500 + i * 700))
        } catch (err) {
          log.append('warn', 'img', `取图失败（第 ${i + 1} 次）${url.slice(0, 90)}: ${String((err as Error)?.message ?? err)}`)
          await new Promise((r) => setTimeout(r, 500 + i * 700))
        }
      }
      return null
    }
    let res = await attempt(target)
    if (!res) {
      // 缩放路径可能没被反代支持：退回原图路径再试一次（宁可慢一点也要有图）
      const plain = unresizedImageUrl(target)
      if (plain !== target) {
        log.append('info', 'img', `缩放路径不可用，改取原图: ${plain.slice(0, 90)}`)
        res = await attempt(plain)
      }
    }
    if (!res) return new Response('upstream error', { status: 502 })
    let type = res.headers.get('content-type') ?? 'image/jpeg'
    if (!type.startsWith('image/')) type = 'image/jpeg'
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_IMAGE_BYTES) return new Response('too large', { status: 502 })
    try {
      writeFileSync(cachePath, buf)
    } catch {
      /* 缓存失败不影响显示 */
    }
    return new Response(new Uint8Array(buf) as unknown as ReadableStream, {
      headers: { 'Content-Type': type, 'Cache-Control': 'max-age=86400' }
    })
  })().finally(() => {
    inflight.delete(target)
  })
  inflight.set(target, p)
  return p
}

// ---------------- 本地媒体扫描 ----------------

function subLabel(name: string): string {
  const n = name.toLowerCase()
  if (/(chs|sc|简|gb|zh-cn)/.test(n)) return '简体'
  if (/(cht|tc|繁|big5)/.test(n)) return '繁体'
  if (/(jpn|jp|日)/.test(n)) return '日文'
  return '字幕'
}

function makeSubFile(path: string, name: string): LocalSubFile {
  const ext = extname(name).toLowerCase()
  return {
    path,
    name,
    label: subLabel(name),
    type: (ext.slice(1) as LocalSubFile['type']) || 'srt'
  }
}

/** 递归扫描视频文件与同名字幕（方案 5.2；aria2 多文件种子会在番剧文件夹内再建子目录） */
export function listVideos(folder: string): LocalVideoFile[] {
  // 用户明确打开过的文件夹 → 放行其内部文件通过自定义协议播放
  allowMediaRoot(folder)
  const videos: LocalVideoFile[] = []
  const subs: LocalSubFile[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (err) {
      log.append('warn', 'media', `读取目录失败 (${dir}): ${String(err)}`)
      return
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === '__MACOSX') continue
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!stat.isFile()) continue
      const ext = extname(name).toLowerCase()
      if (VIDEO_EXTS.has(ext)) {
        // 跳过未下载完成 / 无效的空文件：aria2 会先建 0 字节占位文件，
        // 若把它列进播放列表，播放器会拿到无法解码的文件（表现为黑屏无反应）。
        if (stat.size < 1024) continue
        if (name.endsWith('.part') || name.endsWith('.aria2') || name.endsWith('.!qb')) continue
        videos.push({ path: full, name, episode: parseEpisode(name), size: stat.size, subs: [] })
      } else if (SUB_EXTS.has(ext)) {
        subs.push(makeSubFile(full, name))
      }
    }
  }

  walk(folder, 0)

  // 字幕匹配：同目录同文件名（去扩展名）优先，其次同目录任意字幕
  for (const v of videos) {
    const vDir = dirname(v.path)
    const vBase = basename(v.path, extname(v.path)).toLowerCase()
    const sameDir = subs.filter((s) => dirname(s.path) === vDir)
    const exact = sameDir.filter((s) => basename(s.path, extname(s.path)).toLowerCase() === vBase)
    if (exact.length > 0) {
      v.subs = exact
    } else if (sameDir.length > 0) {
      // 常见命名：视频名 + 语言标记（如 xxx.chs.ass）
      const loose = sameDir.filter((s) => {
        const b = basename(s.path, extname(s.path)).toLowerCase()
        return b.startsWith(vBase) || vBase.startsWith(b)
      })
      v.subs = loose.length > 0 ? loose : sameDir
    }
  }

  videos.sort((a, b) => {
    if (a.episode != null && b.episode != null) return a.episode - b.episode
    if (a.episode != null) return -1
    if (b.episode != null) return 1
    return a.name.localeCompare(b.name, 'zh')
  })
  return videos
}

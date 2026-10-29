import { app, protocol } from 'electron'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import iconv from 'iconv-lite'
import type { ImageDataUrlResult, LocalSubFile, LocalVideoFile } from '@shared/types'
import { parseEpisode } from '../lib/parse'
import { log } from '../log'
import { dataPaths } from './paths'
import { cacheRoot } from './cacheRoot'
import { BROWSER_UA, getSettings } from '../net'
import { rewriteImageUrl, unresizedImageUrl } from './bangumi'
import { imageVariantUrls } from './bangumiImageUrl'
import { onlineImageTo8443 } from './onlineDb'
import { builtInImgOrigin } from './bangumiProxy'
import { liveStream } from './transcode'
import { fallbackCoverForSubject, subjectIdFromCoverUrl } from './animeImageFallback'
import { recordTraffic } from './traffic'

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
  const p = dataPaths()
  const dirs = [
    // 用户显式设置过的目录（可能在任何盘）
    s.downloadDir,
    s.cacheDir,
    s.screenshotDir,
    /*
     * v0.2.9 最后更新：数据根改到安装目录后，**必须注册真实的默认目录**。
     * 此前这里只注册 `userData/cache` 这类写死的旧位置，而 `settings.cacheDir` 默认是空串 ——
     * 于是「默认缓存根」从未进入白名单，galgame 封面（走 sakana-img://local）被全部拒读：
     * 日志里一排 `[img] 拒绝读取白名单外的路径: <安装目录>\cache\galgame-covers\…`，
     * 表现就是「所有 galgame 封面都不显示，自定义封面也不行（同一个目录）」。
     * 现在统一以 dataPaths() 为准，避免再次出现「改了目录忘了改白名单」。
     */
    p.cache,
    p.downloads,
    p.screenshots,
    p.galgameShots,
    p.root,
    p.userData,
    // 兜底：即便 dataPaths 回退了，也要保证 userData 下的老目录仍可读
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

/**
 * 请求时的「自愈式」白名单复查（v0.3.5）。
 *
 * 解决问题：白名单是**启动时的快照**，但目录设置是**随时可改的**。
 * 用户报的真实案例：统计工具添加剧照时日志出现
 * `拒绝读取白名单外的路径: D:\动画应用\sakana\sakana.animation.screenshot\…png`，
 * 剧照整块插不进去。实测该路径本身完全合法（`resolve` 后前缀比较命中），
 * 也就是说**不是判据写错，而是那条根当时不在白名单里**：
 * `allowedRoots` 只在 `registerDefaultRoots()` / `ensureSaveDirs()` 这两个启动时机被填充过，
 * 一旦「设置里的目录」与「启动那一刻读到的目录」不一致（改过设置、换过数据根、外置盘晚挂载…），
 * 该目录下所有图片都会 403，而界面上只表现为「一片空白 / 插不进去」。
 *
 * 这里在**每次请求**都拿当前设置里的目录再补登一次（`allowMediaRoot` 只是 Set.add，代价可忽略），
 * 然后再判一次。命中时会记一条 info 日志，方便下次定位「到底是哪一步漏了注册」。
 *
 * 注意：**只覆盖应用自己管理的那些目录**，不是放宽安全边界 ——
 * 用户随便挑的任意路径（比如桌面上的图）依旧读不到，
 * 想让某张图可用仍然要走 `showcase.importImages()` 复制进数据目录这条路。
 */
function ensureAllowedBySettings(target: string): boolean {
  if (isPathAllowed(target)) return true
  const s = getSettings()
  const p = dataPaths()
  const dirs = [
    s.downloadDir,
    s.screenshotDir,
    s.cacheDir,
    p.cache,
    p.downloads,
    p.screenshots,
    p.galgameShots,
    p.root,
    p.userData
  ]
  for (const d of dirs) if (d) allowMediaRoot(d)
  if (!isPathAllowed(target)) return false
  log.append('info', 'img', `白名单缺失已自愈：请求时补登了目录（${target.slice(0, 110)}）`)
  return true
}

/**
 * 这个字符串是不是**本地图片文件路径**（v0.3.5）。
 *
 * 判据（两条都试过才敢这么写）：
 * - 单字母 + 冒号开头（`E:\…` / `E:/…`）→ **就是盘符**，本地路径；
 * - 其它「协议」形状（`https://`、`sakana-img://`、`data:`、`blob:`）→ 远程/inline，交给原有链路。
 *
 * ⚠️ 这里踩过一个**静默致命**的坑，别再改回去：
 * 第一版写成 `/^[a-zA-Z][a-zA-Z0-9+.-]*:/`（"字母开头 + 可有可无的字符 + 冒号"），
 * 而 `E:` 正好满足它（`[a-zA-Z0-9+.-]*` 可以匹配 0 个字符），
 * 于是**所有 Windows 绝对路径都被当成远程地址**丢给 `fetchImageWithCache` ——
 * `new URL('E:\\…')` 解析出来的 `E:` 被 fetch 当作 scheme，报
 * 「取图失败（第 1 次）E:\\…png: fetch failed」，界面上表现为
 * 「右键加的本地图片能显示，但导出图里那一格是空白」。
 * 现在的写法要求「单字母盘符」或「2 个字符以上的协议 + ://」，两者不会互相误伤。
 */
function isLocalImagePath(p: string): boolean {
  if (!p) return false
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true
  return !/^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//.test(p) && !/^(data|blob):/i.test(p)
}

function imageCacheDir(): string {
  // V1.5.1：统一走 cacheRoot()（settings.cacheDir 优先，留空 = <数据根>/cache）。
  // 以前这里默认拼的是 userData/cache，与设置页统计/清理的目录不是同一个 —— 见 cacheRoot.ts 的说明。
  const dir = join(cacheRoot(), 'img')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 图片缓存目录（V1.5.1）：缓存数据库要按"哪些图属于哪部番"统计体积与决定保留时长，
 * 需要一个可读的目录路径。仍然走 `imageCacheDir()`（会顺带 mkdir），保证与取图路径**同一个**目录。
 */
export function imageCacheDirPath(): string {
  return imageCacheDir()
}

const inflight = new Map<string, Promise<Response>>()

/*
 * ───────── 图片跨页面复用 + 更长缓存（V1.5.3）─────────
 *
 * 用户要求：「图片跨页面复用 + 更长缓存」。
 *
 * 原来的链路只有磁盘缓存：每次翻页/切页，渲染层重新挂载 `<img>` → 重新请求 `sakana-img://` →
 * 主进程命中磁盘也要开一次文件流；而自定义协议的响应只给了 `max-age=86400`，
 * Chromium 对非 http(s) 协议的缓存策略本来就不稳定，实测常常还是每次重新取。
 *
 * 现在叠三层，从快到慢：
 *   1. **内存 LRU**（本文件）：最近看过的图片直接给字节，翻回上一页是 0 磁盘 IO；
 *   2. **磁盘缓存**（既有 `cache/img`，sha1 命名）：内存没命中时读盘并回填内存；
 *   3. **浏览器 HTTP 缓存**：响应带 30 天 `immutable` + `ETag`，并支持 `If-None-Match` → 304，
 *      这样 Chromium 自己就能跨页面复用，连 IPC 都不用发。
 *
 * 为什么上限是 96MB：一屏 20 张 400px 封面约 2~4MB，96MB 足够放下几十页；
 * 再大就变成和用户抢内存（应用本身还有 libmpv/缓存）。超过上限按最久未用淘汰。
 */
const IMAGE_CACHE_CONTROL = 'public, max-age=2592000, immutable'
const IMAGE_MEM_MAX_BYTES = 96 * 1024 * 1024
const IMAGE_MEM_MAX_ENTRIES = 1500
/**
 * 单张图进内存的上限：超过就退回文件流。
 * 常规封面只有 5~60KB，读进内存几乎无感；但原图可以到 25MB，
 * 在主进程同步读 25MB 会卡住所有窗口的 IPC —— 这种图不值得用内存换速度。
 */
const IMAGE_MEM_READ_MAX = 8 * 1024 * 1024
const imageMemory = new Map<string, { buf: Buffer; type: string; at: number }>()
let imageMemBytes = 0

function imageMemGet(key: string): { buf: Buffer; type: string } | null {
  const hit = imageMemory.get(key)
  if (!hit) return null
  // LRU：Map 的插入顺序就是"最近使用"顺序，命中后重新插到末尾
  imageMemory.delete(key)
  hit.at = Date.now()
  imageMemory.set(key, hit)
  return hit
}

function imageMemPut(key: string, buf: Buffer, type: string): void {
  if (!buf.length) return
  const prev = imageMemory.get(key)
  if (prev) {
    imageMemBytes -= prev.buf.length
    imageMemory.delete(key)
  }
  imageMemory.set(key, { buf, type, at: Date.now() })
  imageMemBytes += buf.length
  while (
    (imageMemBytes > IMAGE_MEM_MAX_BYTES || imageMemory.size > IMAGE_MEM_MAX_ENTRIES) &&
    imageMemory.size > 1
  ) {
    const oldest = imageMemory.keys().next().value as string | undefined
    if (!oldest) break
    const entry = imageMemory.get(oldest)
    if (entry) imageMemBytes -= entry.buf.length
    imageMemory.delete(oldest)
  }
}

/** 单张图片的 ETag（目标地址的 sha1 已经唯一，长度再用上，避免理论上同 hash 不同内容） */
function imageETag(hash: string, size: number): string {
  return `"${hash}-${size}"`
}

/** 大图走文件流（不占内存），但缓存头与 ETag 与内存路径一致 */
function imageStreamResponse(
  path: string,
  type: string,
  size: number,
  etag: string,
  ifNoneMatch?: string | null
): Response {
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': IMAGE_CACHE_CONTROL }
    })
  }
  return new Response(createReadStream(path) as unknown as ReadableStream, {
    headers: {
      'Content-Type': type,
      'Content-Length': String(size),
      'Cache-Control': IMAGE_CACHE_CONTROL,
      ETag: etag
    }
  })
}

/** 统一构造图片响应：长缓存 + ETag + 304 协商 */
function imageResponse(buf: Buffer, type: string, etag: string, ifNoneMatch?: string | null): Response {
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': IMAGE_CACHE_CONTROL }
    })
  }
  return new Response(new Uint8Array(buf) as unknown as ReadableStream, {
    headers: {
      'Content-Type': type,
      'Content-Length': String(buf.length),
      'Cache-Control': IMAGE_CACHE_CONTROL,
      ETag: etag
    }
  })
}

/**
 * 图片缓存瘦身（v0.3.9 体检 M6）。
 *
 * 为什么需要：`cache/img` 目录以前**只增不减** —— 番剧封面、剧照、角色图都在里面，
 * 看番越久这个目录越大（实测本机已有 1400+ 个文件），而唯一的清理方式是用户手动点「清除缓存」。
 *
 * 策略与取舍：
 *   · 只在**启动时跑一次**（由 index.ts 调用），不放进"每张图的写入路径"——那里扫目录会让加载变慢；
 *   · 超过上限（默认 1GB）时按**最后访问时间**从旧到新删，删到上限的 80% 为止（留出余量，避免每次启动都删）；
 *   · 读不到/删不掉的单个文件直接跳过，绝不影响正常加载。
 */
export function pruneImageCache(
  maxBytes = 1024 * 1024 * 1024,
  opts?: {
    /**
     * 受保护文件判定（V1.5.1）：命中就不参与"超上限按最久未用删除"。
     *
     * 谁会受保护：收藏番剧的图片（永久）、以及缓存数据库判定尚未过期的图片。
     * 用户的要求是"图片一定要缓存得久一点"，如果 1GB 上限一到就把收藏卡的封面删了，
     * 下次开收藏页会一次性重拉几十张图 —— 既难看，也正好把 API 压力顶起来。
     */
    protect?: (path: string) => boolean
  }
): { removed: number; freedBytes: number } {
  const dir = imageCacheDir()
  const entries: { path: string; size: number; atime: number }[] = []
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (!st.isFile()) continue
        // atime 在部分文件系统上不可靠（可能被挂载参数关掉），用与 mtime 的较大值兜底
        entries.push({ path: p, size: st.size, atime: Math.max(st.atimeMs || 0, st.mtimeMs || 0) })
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
  } catch {
    return { removed: 0, freedBytes: 0 }
  }
  let total = entries.reduce((n, e) => n + e.size, 0)
  if (total <= maxBytes) return { removed: 0, freedBytes: 0 }
  entries.sort((a, b) => a.atime - b.atime)
  const target = Math.floor(maxBytes * 0.8)
  let removed = 0
  let freed = 0
  for (const e of entries) {
    if (total <= target) break
    if (opts?.protect?.(e.path)) continue
    try {
      unlinkSync(e.path)
      total -= e.size
      freed += e.size
      removed++
    } catch {
      /* 删不掉就留着，下次启动再说 */
    }
  }
  if (removed > 0) {
    log.append(
      'info',
      'img',
      `图片缓存超过上限，已清理 ${removed} 个最久未使用的文件（释放约 ${Math.round(freed / 1048576)} MB）`
    )
  }
  return { removed, freedBytes: freed }
}

export function registerMediaProtocols(): void {
  registerDefaultRoots()
  protocol.handle('sakana-img', async (req) => {
    const url = new URL(req.url)
    const { kind, target } = decodeTarget(url.pathname)
    try {
      if (kind === 'local') {
        if (!target || !existsSync(target)) return new Response('not found', { status: 404 })
        if (!ensureAllowedBySettings(target)) {
          log.append('warn', 'img', `拒绝读取白名单外的路径: ${target}`)
          return new Response('forbidden', { status: 403 })
        }
        const ext = extname(target).toLowerCase()
        const type = IMAGE_EXTS[ext] ?? 'application/octet-stream'
        return new Response(createReadStream(target) as unknown as ReadableStream, {
          headers: { 'Content-Type': type, 'Cache-Control': 'max-age=86400' }
        })
      }
      return await fetchImageWithCache(target, { ifNoneMatch: req.headers.get('if-none-match') })
    } catch (err) {
      log.appendThrottled('img-proto', 'warn', 'img', `图片加载失败 (${target}): ${String(err)}`, 60_000)
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
    /*
     * V1.4：内置图片反代**必须带 Referer**（这是"番剧表封面全空"的最后一环）。
     *
     * 实测同一张图（curl）：
     *   Referer: https://bgm.tv/      → 200，15,361 字节
     *   不带 Referer                   → code=000（连接被拒/超时）
     *   Referer: https://lain.bgm.tv/ → code=000
     * 数据里确实有封面地址，只是它指向已墙的 lain.bgm.tv；我们改写到了内置图片站，
     * 如果不再补 Referer，改写后依然被挡 —— 于是"有数据也不显示"。
     * 判定用内置图片站的 origin（不写死域名，符合"地址不外露"的红线）。
     */
    const imgOrigin = builtInImgOrigin()
    if (imgOrigin) {
      try {
        if (new URL(target).origin === new URL(imgOrigin).origin) return 'https://bgm.tv/'
      } catch {
        /* ignore */
      }
    }
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
const IMG_CONCURRENCY = 6
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

/**
 * 单次图片请求超时（毫秒）：卡住的图不能一直占着并发额度。
 *
 * V1.4：20s → **8s**。真机日志证据：冷启动时出现
 *   `图片加载失败 (http://…/pic/cover/…) TimeoutError: The operation was aborted due to timeout`
 * 而缩略图本身只有 4~15KB —— 8 秒都下不来就是这条链路上那次请求废了，
 * 继续等 20 秒只会白占一个并发槽（一屏十几张时会连锁拖慢）。
 * 缩短之后失败会更快进入"改取原图/放弃"分支，整体感知更快。
 */
const IMG_TIMEOUT = 8000

async function fetchImageOnce(target: string): Promise<Response> {
  const headers: Record<string, string> = { 'User-Agent': BROWSER_UA }
  const referer = refererFor(target)
  if (referer) headers['Referer'] = referer
  const res = await fetch(target, { headers, signal: AbortSignal.timeout(IMG_TIMEOUT) })
  return res
}

/**
 * 预取首屏封面（V1.4）。
 *
 * 为什么需要它：番剧表数据一到，渲染层才开始 `sakana-img://` 一张张取图 ——
 * 冷缓存时每张 1~2 秒、并发 6，一屏十几张要好几秒，用户看到的就是"卡片图慢慢蹦出来"。
 * 这里在**数据刚拿到**时就把前 N 张丢进同一条取图队列（同一套并发闸门 + 磁盘缓存），
 * 等 React 真正渲染 `<img>` 时多数已经命中缓存，观感从"逐张加载"变成"一次性出现"。
 *
 * 只取前 18 张（一屏的量）：再多就是替用户预取他根本没滚动到的图，白费带宽。
 * 失败一律忽略 —— 预取是锦上添花，不能因为它报错影响主流程。
 */
export async function prefetchImages(urls: string[], limit = 18): Promise<void> {
  const list = urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, limit)
  if (list.length === 0) return
  await Promise.allSettled(
    list.map((u) =>
      fetchImageWithCache(u).then(
        (r) => {
          // 只关心"取到没取到"，响应体不读会占着连接，这里主动释放
          void r.arrayBuffer().catch(() => {})
          return true
        },
        () => false
      )
    )
  )
}

/**
 * V1.5.2：bangumi 图床「连续失败就降级」的熔断状态。
 *
 * 用户要求「在 bangumi 源多次取不到图片时再启用」备用图源。逐张失败才兜底虽然也能工作，
 * 但反代整体挂掉时，一屏十几张图会每张都先白等 8~16 秒才去兜底。
 * 所以这里记一个连续失败计数：连续 3 张失败 → 2 分钟内对**可识别 id 的封面**先走备用源
 * （备用源也没图时再退回主源），既不让用户看一片灰，也不会长期绕过自己的反代。
 */
let bgmImageFailStreak = 0
let bgmImageDegradedUntil = 0
function noteBgmImageFailure(): void {
  bgmImageFailStreak += 1
  if (bgmImageFailStreak >= 3) {
    bgmImageDegradedUntil = Date.now() + 120_000
    log.append('warn', 'img', 'bangumi 图床连续失败，已临时启用备用图片源（AniList / Jikan / Kitsu），2 分钟后自动重试主源')
    bgmImageFailStreak = 0
  }
}
function noteBgmImageSuccess(): void {
  bgmImageFailStreak = 0
}
function bgmImageDegraded(): boolean {
  return Date.now() < bgmImageDegradedUntil
}

/** 取一张备用源的图并按**备用地址**缓存（与主源缓存互不覆盖） */
async function serveFallbackImage(
  url: string,
  opts?: { ifNoneMatch?: string | null }
): Promise<Response | null> {
  let type = 'image/jpeg'
  try {
    const ext = (() => {
      const e = extname(new URL(url).pathname).toLowerCase()
      return IMAGE_EXTS[e] ? e : '.jpg'
    })()
    type = IMAGE_EXTS[ext] ?? 'image/jpeg'
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 24)
    const cachePath = join(imageCacheDir(), `${hash}${ext}`)
    const mem = imageMemGet(url)
    if (mem) {
      recordTraffic({ source: 'image', requests: 0, cacheHits: 1, cacheBytes: mem.buf.length })
      return imageResponse(mem.buf, mem.type, imageETag(hash, mem.buf.length), opts?.ifNoneMatch)
    }
    if (existsSync(cachePath)) {
      const size = statSync(cachePath).size
      if (size > IMAGE_MEM_READ_MAX) {
        recordTraffic({ source: 'image', requests: 0, cacheHits: 1, cacheBytes: size })
        return imageStreamResponse(cachePath, type, size, imageETag(hash, size), opts?.ifNoneMatch)
      }
      const buf = readFileSync(cachePath)
      imageMemPut(url, buf, type)
      recordTraffic({ source: 'image', requests: 0, cacheHits: 1, cacheBytes: buf.length })
      return imageResponse(buf, type, imageETag(hash, buf.length), opts?.ifNoneMatch)
    }
    const res = await withImageSlot(() => fetchImageOnce(url))
    if (!res.ok) {
      recordTraffic({ source: 'image', requests: 1, errors: 1 })
      return null
    }
    let ct = res.headers.get('content-type') ?? 'image/jpeg'
    if (!ct.startsWith('image/')) ct = type
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
      recordTraffic({ source: 'image', requests: 1, errors: 1 })
      return null
    }
    recordTraffic({ source: 'image', bytes: buf.length, requests: 1 })
    imageMemPut(url, buf, ct)
    try {
      writeFileSync(cachePath, buf)
    } catch {
      /* 缓存失败不影响显示 */
    }
    return imageResponse(buf, ct, imageETag(hash, buf.length), opts?.ifNoneMatch)
  } catch (err) {
    log.appendThrottled('img-fallback', 'warn', 'img', `备用图片源取图失败：${String((err as Error)?.message ?? err).slice(0, 90)}`, 60_000)
    recordTraffic({ source: 'image', requests: 1, errors: 1 })
    return null
  }
}

async function fetchImageWithCache(
  rawTarget: string,
  opts?: { ifNoneMatch?: string | null }
): Promise<Response> {
  // 配了自建图片反代时，官方图床地址改写到反代域名（Worker 按路径转发 + 按需缩放）
  const target = rewriteImageUrl(rawTarget)
  const hash = createHash('sha1').update(target).digest('hex').slice(0, 24)
  const ext = (() => {
    const e = extname(new URL(target).pathname).toLowerCase()
    return IMAGE_EXTS[e] ? e : '.img'
  })()
  const cachePath = join(imageCacheDir(), `${hash}${ext}`)
  /*
   * 内存 → 磁盘 → 网络。前两层在 inflight 之外处理：
   * 命中时能立刻回 304/字节，不必和正在飞的那张图共用同一个 Promise；
   * 反过来说，网络那张图仍然单飞（同一张封面并发只取一次）。
   */
  const mem = imageMemGet(target)
  if (mem) {
    recordTraffic({ source: 'image', requests: 0, cacheHits: 1, cacheBytes: mem.buf.length })
    return imageResponse(mem.buf, mem.type, imageETag(hash, mem.buf.length), opts?.ifNoneMatch)
  }
  if (existsSync(cachePath)) {
    const type = IMAGE_EXTS[ext] ?? 'image/jpeg'
    try {
      const size = statSync(cachePath).size
      if (size > IMAGE_MEM_READ_MAX) {
        recordTraffic({ source: 'image', requests: 0, cacheHits: 1, cacheBytes: size })
        return imageStreamResponse(cachePath, type, size, imageETag(hash, size), opts?.ifNoneMatch)
      }
      const buf = readFileSync(cachePath)
      if (buf.length > 0) {
        imageMemPut(target, buf, type)
        recordTraffic({ source: 'image', requests: 0, cacheHits: 1, cacheBytes: buf.length })
        return imageResponse(buf, type, imageETag(hash, buf.length), opts?.ifNoneMatch)
      }
    } catch {
      /* 读盘失败就退回网络取图，不能因为一张缓存坏掉让图不显示 */
    }
  }
  const existing = inflight.get(target)
  if (existing) return existing
  const p = (async () => {
    /*
     * V1.5.2：主源处于"连续失败"状态时，可识别 id 的封面**先**试备用源。
     * 反代整体挂掉时这能省掉每张图 8~16 秒的白等；备用源也没图就继续按原流程走主源。
     */
    const earlySubjectId = subjectIdFromCoverUrl(target)
    if (earlySubjectId && bgmImageDegraded()) {
      const fb = await fallbackCoverForSubject(earlySubjectId)
      if (fb) {
        const served = await serveFallbackImage(fb.url, opts)
        if (served) return served
      }
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
          const msg = String((err as Error)?.message ?? err)
          log.appendThrottled('img-fetch', 'warn', 'img', `取图失败（第 ${i + 1} 次）${url.slice(0, 90)}: ${msg}`, 60_000)
          /*
           * V1.4：**超时不重试**。
           * 8 秒还没拿到一张 4~15KB 的缩略图，基本就是这条请求废了（反代冷启动 / 网络抖动），
           * 立刻重试往往再等 8 秒 —— 用户看到的就是"图死活不出来还拖慢一屏"。
           * 交给下层"改取原图"兜底一次即可；5xx/429 仍然重试（那类问题重试有效）。
           */
          if (/timeout|timed out|aborted/i.test(msg)) return null
          await new Promise((r) => setTimeout(r, 500 + i * 700))
        }
      }
      return null
    }
    let res = await attempt(target)
    if (!res) {
      /*
       * V1.5.2：先按**缩放变体**降级（800 → 400），再退回原图。
       *
       * 详情页用的是 `large`（`/pic/cover/l/…`，没有 /r/ 前缀），卡片用的是 `/r/400/…`；
       * 两者缓存键不同，而 large 在部分网络下直连会被中断（实测：large 442KB 直连报
       * "stream has been aborted"，同域 /r/400 的 58KB 正常）。降级成功后字节仍按原始地址缓存，
       * 下次同一条 large 直接命中 —— 用户就不用再为"同一张封面详情页出不来"困惑了。
       */
      for (const alt of imageVariantUrls(target)) {
        if (alt === target) continue
        res = await attempt(alt)
        if (res) {
          log.appendThrottled('img-variant', 'info', 'img', `封面原尺寸取不到，已改用缩放变体（${alt.slice(0, 80)}）`, 120_000)
          break
        }
      }
      if (!res) {
        // 缩放路径可能没被反代支持：退回原图路径再试一次（宁可慢一点也要有图）
        const plain = unresizedImageUrl(target)
        if (plain !== target) {
          log.appendThrottled('img-variant', 'info', 'img', `缩放路径不可用，改取原图: ${plain.slice(0, 90)}`, 120_000)
          res = await attempt(plain)
        }
      }
      /*
       * V1.5.3：在线图床 443 失败 → 换 8443（用户给的兜底写法）。
       * 实测 `/s/<id>` 在 443 上会连接超时、8443 正常；`/r/400/...` 443 正常，所以只在失败时换。
       */
      if (!res) {
        const alt = onlineImageTo8443(target)
        if (alt !== target) {
          log.appendThrottled('img-variant', 'info', 'img', `在线图床 443 失败，改试 8443: ${alt.slice(0, 90)}`, 120_000)
          res = await attempt(alt)
        }
      }
    }
    /*
     * V1.5.2：主源（bangumi 反代）取不到时，改用备用图源。
     *
     * 只对「能从路径里认出条目 id 的封面」启用（见 animeImageFallback 的说明）：
     * 认不出 id 就不知道该去哪找这张图，硬换只会给错图。
     * 备用源也拿不到时，照旧回 502 —— 行为与以前一致，不会让图片链路卡住。
     */
    if (!res) {
      const subjectId = subjectIdFromCoverUrl(target)
      if (subjectId) {
        noteBgmImageFailure()
        const fb = await fallbackCoverForSubject(subjectId)
        if (fb) {
          const served = await serveFallbackImage(fb.url, opts)
          if (served) {
            log.appendThrottled('img-source-switch', 'info', 'img', `封面已改用 ${fb.source}（条目 #${subjectId}）`, 120_000)
            return served
          }
        }
      }
      return new Response('upstream error', { status: 502 })
    }
    noteBgmImageSuccess()
    let type = res.headers.get('content-type') ?? 'image/jpeg'
    if (!type.startsWith('image/')) type = 'image/jpeg'
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_IMAGE_BYTES) {
      recordTraffic({ source: 'image', requests: 1, errors: 1 })
      return new Response('too large', { status: 502 })
    }
    recordTraffic({ source: 'image', bytes: buf.length, requests: 1 })
    imageMemPut(target, buf, type)
    try {
      writeFileSync(cachePath, buf)
    } catch {
      /* 缓存失败不影响显示 */
    }
    return imageResponse(buf, type, imageETag(hash, buf.length), opts?.ifNoneMatch)
  })().finally(() => {
    inflight.delete(target)
  })
  inflight.set(target, p)
  return p
}

/**
 * 转 data URL 时允许的单张图片上限（v0.2.11 附加：「最XX的角色 9宫格」导出用）。
 *
 * 6MB 的源图 base64 之后约 8MB，而一次导出最多有 40 格（4×10）；
 * 不设上限时一张 25MB 的大图就能把主进程的内存顶起来（base64 还要再翻 1/3），
 * 所以宁可让这一格退回占位色块，也不让整个导出把进程拖死。
 */
const MAX_DATA_URL_BYTES = 6 * 1024 * 1024

/**
 * 把 Response 读成 Buffer。
 *
 * 为什么要单独写：`fetchImageWithCache` 有两种响应体 ——
 * - 走网络时是普通的 web ReadableStream（`arrayBuffer()` 直接可用）；
 * - **磁盘缓存命中**时 body 是 Node 可读流（sakana-img 协议的既有写法）。
 * 第二种在 Node 里通常也能被 `arrayBuffer()` 正常读取，但为了不让「第二次导出」
 * 因为响应体形态不同而全部退回占位块，这里两种都显式支持。
 */
async function readResponseBuffer(res: Response): Promise<Buffer> {
  const body = res.body as unknown as { getReader?: unknown } | null
  if (body && typeof body.getReader !== 'function') {
    const chunks: Buffer[] = []
    for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }
  return Buffer.from(await res.arrayBuffer())
}

/**
 * 把一张**原始图片地址**取回来转成 data URL（`data:image/jpeg;base64,…`）。
 *
 * 为什么需要它（渲染层不能自己画远程图）：
 * 界面里的图片都走自定义协议 `sakana-img://`（主进程代取，带 UA/Referer + 磁盘缓存）。
 * 自定义协议在渲染层看是**跨源资源**，把它 drawImage 进 canvas 会污染画布，
 * 之后 `canvas.toBlob()` 直接抛 SecurityError —— 导出整条链路就断在这里。
 * 由主进程把字节取回来转 data URL（data URL 同源、永不污染画布）才彻底绕开这个问题。
 *
 * 复用情况：取数完全走 `fetchImageWithCache`（即 sakana-img 协议那条路）——
 * 图片反代改写、磁盘缓存、UA/Referer、并发闸门、缩放路径兜底一个都不另写。
 *
 * **失败不抛异常**：任何单张失败都返回 `dataUrl: ''` + `error`，由调用方按格降级。
 */
export async function imageDataUrl(rawUrl: string): Promise<ImageDataUrlResult> {
  const raw = String(rawUrl ?? '').trim()
  const fail = (error: string): ImageDataUrlResult => ({ dataUrl: '', mime: '', bytes: 0, error })
  if (!raw) return fail('图片地址为空')
  /*
   * v0.3.5：本地文件路径（「最XX的角色」里用户右键格子添加的本地立绘）也要能转 data URL。
   *
   * 以前这里只有「远程地址 / data URL」两条路：本地路径会掉进 fetchImageWithCache，
   * 而它用 `new URL(target)` 取扩展名 —— Windows 路径 `E:\…\a.png` 解析会抛异常，
   * 表现就是「导出的图里，我自己加的那几张是空白占位块」。
   * 现在直接读盘：白名单与 sakana-img://local 完全共用一套（isPathAllowed），
   * 不会因为这条新入口让渲染层能读到任意文件。
   */
  if (isLocalImagePath(raw)) {
    if (!existsSync(raw)) return fail('本地图片不存在（可能已被移动或删除）')
    if (!ensureAllowedBySettings(raw)) {
      log.append('warn', 'img', `拒绝读取白名单外的路径: ${raw}`)
      return fail('本地图片不在允许读取的目录内')
    }
    try {
      const buf = readFileSync(raw)
      if (buf.length === 0) return fail('图片内容为空')
      if (buf.length > MAX_DATA_URL_BYTES) {
        return fail(`图片过大（${(buf.length / 1048576).toFixed(1)}MB，上限 6MB）`)
      }
      const mime = IMAGE_EXTS[extname(raw).toLowerCase()] ?? 'image/png'
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length }
    } catch (err) {
      const reason = String((err as Error)?.message ?? err)
      log.append('warn', 'img', `读取本地图片失败 (${raw}): ${reason}`)
      return fail(reason)
    }
  }
  // 已经是 data URL 就直接回传（同源，画进 canvas 不会污染）
  if (raw.startsWith('data:')) {
    const mime = /^data:([^;,]+)/.exec(raw)?.[1] ?? 'image/jpeg'
    return { dataUrl: raw, mime, bytes: raw.length }
  }
  /*
   * v0.2.14：导出取**未缩放的原图**（用户反馈「立绘太模糊」）。
   *
   * 起因：`fetchImageWithCache` 内部固定 `rewriteImageUrl(target)`，默认宽度 400 ——
   * 界面与导出一直用的是「反代缩到 400px 宽」的版本。实测同一个角色
   * medium=400x1384、large=800x2767，被压到 400px 再画进 2 倍图（格子宽 460px）
   * 等于先砍掉一半分辨率再放大回去，糊是必然的。
   *
   * `rewriteImageUrl(url, 0)` 保留原始路径、不加 `/r/<宽>/` 前缀（反代按原路径转发原图）。
   * 这里先改写一次；`fetchImageWithCache` 内部再改写时域名已不是图床域名，会原样返回、不会重复处理。
   */
  const target = rewriteImageUrl(raw, 0)
  try {
    const res = await fetchImageWithCache(target)
    if (!res.ok) return fail(`取图失败（HTTP ${res.status}）`)
    // 先看 Content-Length：大图在读进内存之前就拒掉（缓存命中的响应没有该头，下面再兜一次）
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > MAX_DATA_URL_BYTES) {
      return fail(`图片过大（${(declared / 1048576).toFixed(1)}MB，上限 6MB）`)
    }
    const buf = await readResponseBuffer(res)
    if (buf.length === 0) return fail('图片内容为空')
    if (buf.length > MAX_DATA_URL_BYTES) {
      return fail(`图片过大（${(buf.length / 1048576).toFixed(1)}MB，上限 6MB）`)
    }
    /*
     * 保留上游声明的图片类型；反代偶尔不回 content-type，这时按 jpeg 兜底
     * （bgm 图床本身就是 jpeg，声明错类型的概率极低）。
     */
    const declaredMime = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    const mime = declaredMime.startsWith('image/') ? declaredMime : 'image/jpeg'
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length }
  } catch (err) {
    const reason = String((err as Error)?.message ?? err)
    log.append('warn', 'img', `转 data URL 失败 (${target.slice(0, 90)}): ${reason}`)
    return fail(reason)
  }
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

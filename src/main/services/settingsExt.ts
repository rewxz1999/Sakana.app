import { app, BrowserWindow, dialog, nativeImage } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { CacheInfo } from '@shared/api'
import { store } from '../store'
import { dataPaths } from './paths'
import { allowMediaRoot } from './media'

// ---------------- 目录字节数 / 文件数 ----------------

function walk(dir: string, onFile: (path: string, size: number) => void): void {
  let stack = [dir]
  while (stack.length) {
    const p = stack.pop()!
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      try {
        for (const name of readdirSync(p)) stack.push(join(p, name))
      } catch {
        /* ignore */
      }
    } else {
      onFile(p, st.size)
    }
  }
}

function dirBytes(dir: string): number {
  let total = 0
  if (!existsSync(dir)) return 0
  walk(dir, (_p, size) => {
    total += size
  })
  return total
}

function dirFileCount(dir: string): number {
  let n = 0
  if (!existsSync(dir)) return 0
  walk(dir, () => {
    n++
  })
  return n
}

// ---------------- 缓存 ----------------

type CacheSettings = { cacheDir?: string }

/** 缓存根目录：settings.cacheDir 优先，留空回退**安装目录**下的 cache（v0.2.9 最后更新） */
export function cacheRoot(): string {
  const s = store.get<CacheSettings>('settings', {})
  const custom = (s.cacheDir ?? '').trim()
  return custom || dataPaths().cache
}

/** 是否使用用户自定义缓存目录（false = 默认「安装目录/cache」） */
export function cacheRootIsCustom(): boolean {
  const s = store.get<CacheSettings>('settings', {})
  return (s.cacheDir ?? '').trim().length > 0
}

/**
 * 参与缓存统计/清理的目录：
 * - <缓存根>/img：sakana-img 图片磁盘缓存
 * - <缓存根>/bangumi：日历/条目 JSON 缓存
 * - <缓存根>/galgame-covers：galgame 封面（v0.2.9 起也放进缓存根 ——
 *   它过去固定在 userData 下，于是「清了缓存但封面还在」「C 盘占用说不清」两件事同时成立）
 */
function imageCacheDirs(): string[] {
  const root = cacheRoot()
  return [join(root, 'img'), join(root, 'bangumi'), join(root, 'galgame-covers')]
}

/** galgame 封面目录（v0.2.9：跟缓存根走，不再是 userData 下的固定目录） */
export function galgameCoversDir(): string {
  const dir = join(cacheRoot(), 'galgame-covers')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getCacheBytes(): CacheInfo {
  let bytes = 0
  for (const d of imageCacheDirs()) bytes += dirBytes(d)
  return { bytes, dir: cacheRoot(), custom: cacheRootIsCustom() }
}

export function clearCache(): { bytes: number } {
  const before = getCacheBytes().bytes
  for (const d of imageCacheDirs()) {
    try {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true })
    } catch (err) {
      throw new Error(`清除缓存失败 (${d}): ${String(err)}`)
    }
    mkdirSync(d, { recursive: true })
  }
  return { bytes: before }
}

/**
 * 保存自定义缓存目录并确保目录存在（mkdir -p）。
 * dir = '' 表示恢复默认 userData/cache。
 */
export function setCacheDir(dir: string): { dir: string } {
  const next = (dir ?? '').trim()
  const current = store.get<CacheSettings>('settings', {})
  store.set('settings', { ...current, cacheDir: next })
  const resolved = cacheRoot()
  try {
    mkdirSync(resolved, { recursive: true })
    mkdirSync(join(resolved, 'img'), { recursive: true })
    mkdirSync(join(resolved, 'bangumi'), { recursive: true })
  } catch (err) {
    throw new Error(`无法创建缓存目录 ${resolved}: ${String(err)}`)
  }
  return { dir: resolved }
}

/** 清理无害临时文件（小白名单：仅 userData/temp、userData/cache-junk、系统 temp 下 sakana-*） */
export function clearJunk(): number {
  const ud = app.getPath('userData')
  const targets = [join(ud, 'temp'), join(ud, 'cache-junk')]
  try {
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith('sakana-')) targets.push(join(tmpdir(), name))
    }
  } catch {
    /* ignore */
  }
  let count = 0
  for (const t of targets) {
    try {
      if (!existsSync(t)) continue
      count += dirFileCount(t)
      rmSync(t, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  return count
}

// ---------------- 搜索页展示位（空态轮播图）图片 ----------------

/** 允许收进展示位的图片扩展名（与 sakana-img 协议能正确给 Content-Type 的格式一致） */
const SHOWCASE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

/**
 * 展示位图片的落地目录：`<安装目录>/data/userData/search-showcase`。
 *
 * 为什么必须复制一份，而不是直接用用户选的路径：
 * `sakana-img://local` 只放行 media.ts 里 `registerDefaultRoots()` 注册过的目录
 * （安装目录 / 缓存 / 截图 / 下载 / userData / temp…）。用户从「图片」「下载」之类
 * 任意位置挑的图**不在白名单里**，协议直接 403，界面上就是一块空白 ——
 * galgame 封面曾经因为同一个原因整批不显示（media.ts 里那段注释记着这次事故）。
 * 放进 userData 还有两个好处：
 * 1. 它同时被 `p.root` 和 `p.userData` 两条白名单覆盖，将来数据根再变也不会漏；
 * 2. 它**不在** clearCache 清理的三个目录（img / bangumi / galgame-covers）里，
 *    用户精心挑的图不会被一次「清除缓存」清掉。
 */
function showcaseDir(): string {
  const dir = join(dataPaths().userData, 'search-showcase')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 把用户挑选的图片收进应用目录，返回可以安全持久化的绝对路径。
 *
 * - 命名用「源路径 hash + 原扩展名」：同一张图反复添加只会有一个副本，不会越堆越多
 *   （列表去重仍由渲染层 store 负责）；
 * - 已经在展示位目录里的路径原样返回，所以「每次启动都迁移一次历史数据」也不会重复复制；
 * - 源文件不存在 / 扩展名不支持 / 复制失败时**保留原路径**返回：宁可让轮播显示
 *   「图片无法加载」的提示，也不静默把用户配置过的图从列表里删掉。
 */
export function importShowcaseImages(paths: string[]): string[] {
  const dir = showcaseDir()
  const dirPrefix = resolve(dir).toLowerCase() + sep
  const out: string[] = []
  for (const src of paths) {
    if (typeof src !== 'string' || !src) continue
    let abs = ''
    try {
      abs = resolve(src).toLowerCase()
    } catch {
      /* 路径非法，下面按失败处理 */
    }
    if (abs && abs.startsWith(dirPrefix)) {
      out.push(src)
      continue
    }
    const ext = extname(src).toLowerCase()
    let ok = false
    if (SHOWCASE_EXTS.has(ext)) {
      try {
        if (existsSync(src) && statSync(src).isFile()) {
          const key = createHash('sha1').update(abs || src).digest('hex').slice(0, 12)
          const dst = join(dir, `carousel-${key}${ext}`)
          if (!existsSync(dst)) copyFileSync(src, dst)
          out.push(dst)
          ok = true
        }
      } catch {
        /* 单张失败不影响其余图片 */
      }
    }
    if (!ok) out.push(src)
  }
  // 双保险：目录本身也注册进图片协议白名单（正常情况下 media.ts 已经覆盖了 userData）
  allowMediaRoot(dir)
  return out
}

// ---------------- 目录选择 ----------------

export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    title: '选择文件夹',
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory']
  })
  return r.canceled ? null : (r.filePaths[0] ?? null)
}

// ---------------- 导航栏背景 ----------------

const NAV_BG_MAX_BYTES = 8 * 1024 * 1024
const NAV_BG_MIN_W = 400
const NAV_BG_MAX_W = 4096
const NAV_BG_MIN_H = 200
const NAV_BG_MAX_H = 4096

/** nativeImage 读不到尺寸时的文件头解析（PNG/JPEG/GIF/WebP） */
function readImageSize(file: string): { width: number; height: number } | null {
  try {
    const buf = readFileSync(file)
    // PNG
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    // GIF
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    // JPEG
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++
          continue
        }
        const marker = buf[i + 1]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
        }
        i += 2 + buf.readUInt16BE(i + 2)
      }
      return null
    }
    // WebP
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16)
      if (fmt === 'VP8X') {
        return {
          width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
          height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
        }
      }
      if (fmt === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      }
      if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
      }
      return null
    }
    return null
  } catch {
    return null
  }
}

/** 弹文件选择 + 校验大小/尺寸 → 复制到 userData/nav-bg.<ext> → 保存 path */
export async function pickNavBgImage(): Promise<{ ok: boolean; error?: string; path?: string }> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return { ok: false, error: '窗口不存在' }
  const r = await dialog.showOpenDialog(win, {
    title: '选择导航栏背景图',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
  })
  if (r.canceled || !r.filePaths[0]) return { ok: false }
  const src = r.filePaths[0]

  try {
    const st = statSync(src)
    if (st.size > NAV_BG_MAX_BYTES) {
      return { ok: false, error: `文件大小 ${(st.size / 1024 / 1024).toFixed(1)}MB 超过 8MB 上限` }
    }
  } catch (err) {
    return { ok: false, error: `读取文件失败: ${String(err)}` }
  }

  const img = nativeImage.createFromPath(src)
  const size = img.getSize()
  const dims = size.width > 0 && size.height > 0 ? size : readImageSize(src)
  if (!dims) {
    return { ok: false, error: '无法读取图片尺寸' }
  }
  if (dims.width < NAV_BG_MIN_W || dims.width > NAV_BG_MAX_W || dims.height < NAV_BG_MIN_H || dims.height > NAV_BG_MAX_H) {
    return {
      ok: false,
      error: `图片尺寸 ${dims.width}×${dims.height} 不符合要求（需在 400×200 ~ 4096×4096 之间）`
    }
  }

  const ext = extname(src).toLowerCase() || '.png'
  const dest = join(app.getPath('userData'), `nav-bg${ext}`)
  try {
    copyFileSync(src, dest)
  } catch (err) {
    return { ok: false, error: `保存背景失败: ${String(err)}` }
  }
  store.set('navBg', { path: dest })
  return { ok: true, path: dest }
}

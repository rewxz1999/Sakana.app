import { app, BrowserWindow, dialog, nativeImage } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CacheInfo } from '@shared/api'
import { store } from '../store'

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

/** 缓存根目录：settings.cacheDir 优先，留空回退 userData/cache */
export function cacheRoot(): string {
  const s = store.get<CacheSettings>('settings', {})
  const custom = (s.cacheDir ?? '').trim()
  return custom || join(app.getPath('userData'), 'cache')
}

/** 是否使用用户自定义缓存目录（false = 默认 userData/cache） */
export function cacheRootIsCustom(): boolean {
  const s = store.get<CacheSettings>('settings', {})
  return (s.cacheDir ?? '').trim().length > 0
}

/**
 * 参与缓存统计/清理的目录：
 * - <缓存根>/img：sakana-img 图片磁盘缓存
 * - <缓存根>/bangumi：日历/条目 JSON 缓存
 * - userData/galgame-covers：galgame 封面（固定目录，不随缓存根变化）
 */
function imageCacheDirs(): string[] {
  const root = cacheRoot()
  return [join(root, 'img'), join(root, 'bangumi'), join(app.getPath('userData'), 'galgame-covers')]
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

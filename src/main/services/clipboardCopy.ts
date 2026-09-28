import { clipboard, ClipboardItem } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { log } from '../log'
import { getSettings } from '../net'

/**
 * 截图 → 系统剪贴板（v0.3.6「快速粘贴」）。
 *
 * 用户需求：「番剧截图、galgame 截图都很好用，在此基础上加上快速粘贴的功能」。
 * 写进系统剪贴板后，在任意输入框 Ctrl+V 就能贴图，**同时也会进入 Win+V 剪贴板历史**
 * （Windows 的历史记录是系统统一收的，只要写进剪贴板就会出现）。
 *
 * ## 为什么是异步的（Electron 44 的重要变化）
 *
 * Electron 44 把 `clipboard` 换成了**与 W3C 对齐的异步 API**：
 *   · 同步版的 `readImage()` / `writeImage()` **已经没有了**；
 *   · 现在只有 `writeText(text): Promise<void>` 与 `write(items: ClipboardItem[]): Promise<void>`；
 *   · `ClipboardItem` 的构造参数是 `Record<mime, string | Blob | Promise<…>>`。
 * 实测（本轮）：照老写法写 `clipboard.write({ image, text })`，TS 会报
 * 「'image' does not exist in type 'ClipboardItem[]'」/「'readImage' does not exist on type 'Clipboard'」——
 * 这不是"名字写错了"，是**API 换代**了。所以这里全程用异步 API，调用方也相应改成 await。
 *
 * ## 两个细节不是可选的
 *
 *  1. **图片与文件名文本一起写**。只写图片时，粘到「只接受文本」的地方（聊天框纯文本模式、
 *     终端）会毫无反应；只写文本又贴不了图。两个一起写，粘贴方自己挑 ——
 *     这也是 Windows 自带「截图工具」的行为。一次 `write()` 提交，两份数据是原子的。
 *  2. **失败绝不抛**：截图本身已经存盘成功了，剪贴板失败只写一条日志 ——
 *     系统剪贴板可能被别的程序占着（RDP、剪贴板管理器、UAC 提权窗口），
 *     那种情况下把「截图失败」报给用户是错的。
 */

/** 后缀 → 写进剪贴板时用的 MIME 类型（必须是浏览器认识的图片类型） */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif'
}

export interface ClipboardCopyResult {
  ok: boolean
  /** 写进剪贴板的文本（文件名），失败时为空串 */
  text: string
  file: string
  error?: string
}

/** 单张图的上限：几十 MB 的位图会让每个粘贴方都卡一下（截图通常 1~8MB） */
const MAX_BYTES = 30 * 1024 * 1024

/**
 * 把一个图片文件写进系统剪贴板。
 *
 * @param file 截图产物路径（绝对路径）
 */
export async function copyImageToClipboard(file: string): Promise<ClipboardCopyResult> {
  const path = String(file ?? '').trim()
  const fail = (error: string): ClipboardCopyResult => ({ ok: false, text: '', file: path, error })
  if (!path) return fail('文件路径为空')
  if (!existsSync(path)) return fail('文件不存在')
  const ext = extname(path).toLowerCase()
  const mime = MIME_BY_EXT[ext]
  if (!mime) return fail(`不是支持的图片格式（${ext || '无后缀'}）`)
  let buf: Buffer
  try {
    const size = statSync(path).size
    if (size > MAX_BYTES) return fail(`图片过大（${(size / 1048576).toFixed(1)}MB）`)
    buf = readFileSync(path)
  } catch (err) {
    return fail(String((err as Error)?.message ?? err))
  }
  if (buf.length === 0) return fail('图片内容为空')
  const name = basename(path)
  try {
    /*
     * 注意 `Buffer` 不是 `Blob`：`ClipboardItem` 只认 string / Blob / Bookmark。
     * Node 的 Buffer 是 Uint8Array 的子类，包一层 Blob 才是浏览器语义的二进制。
     * Blob 在 Electron 主进程里全局可用（Node 18+ 的内置实现）。
     */
    const blob = new Blob([new Uint8Array(buf)], { type: mime })
    await clipboard.write([
      new ClipboardItem({ [mime]: blob }),
      new ClipboardItem({ 'text/plain': name })
    ])
    log.append('info', 'clipboard', `截图已复制到剪贴板: ${name}（${(buf.length / 1024).toFixed(0)}KB）`)
    return { ok: true, text: name, file: path }
  } catch (err) {
    const reason = String((err as Error)?.message ?? err)
    log.append('warn', 'clipboard', `复制截图到剪贴板失败: ${reason}`)
    return fail(reason)
  }
}

/** 剪贴板当前是否有一张图（界面提示用；不改变剪贴板内容） */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    const items = await clipboard.read()
    return items.some((it) => (it.types ?? []).some((t) => t.startsWith('image/')))
  } catch {
    return false
  }
}

/** 剪贴板里的文本（自检用：确认文件名也写进去了） */
export async function clipboardText(): Promise<string> {
  try {
    return await clipboard.readText()
  } catch {
    return ''
  }
}

/**
 * 「快速粘贴」的用户开关（设置 → 播放器设置 → 截图片区）。
 *
 * 为什么做成**可关**而不是无条件复制：写剪贴板会**顶掉**用户剪贴板里原有的内容
 * （比如他刚复制的一段文字）。追番时连续截图会把剪贴板历史灌满图片，
 * 对不用这个功能的人是纯粹的副作用。所以默认开启（用户点名要的功能），
 * 但给一个明确的开关，并把「会顶掉剪贴板内容」写进设置页说明。
 */
export function screenshotClipboardEnabled(): boolean {
  return (getSettings() as { screenshotClipboard?: boolean }).screenshotClipboard !== false
}

/**
 * 截图存盘之后的统一收尾：按设置把图片写进系统剪贴板。
 *
 * 两个截图入口（播放器 `playerScreenshot`、galgame `galScreenshotNow`）都调它，
 * 保证「番剧截图」与「galgame 截图」行为完全一致。**不抛异常**（见文件头说明）。
 *
 * @returns 是否真的复制成功（供日志/自检核对）
 */
export async function copyScreenshotIfEnabled(file: string): Promise<boolean> {
  if (!screenshotClipboardEnabled()) return false
  const r = await copyImageToClipboard(file)
  return r.ok
}

/**
 * 读取一个图片文件的原始字节。
 *
 * 目前没有生产调用方 —— 但它是自检用来核对「写进剪贴板的内容与磁盘文件一致」的唯一手段，
 * 所以刻意留着（比在自检脚本里重新写一遍 fs 读取更不容易和实现漂移）。
 */
export function readImageBytes(file: string): Buffer | null {
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

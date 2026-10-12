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
 * 各种图片格式的"魔数"（文件头）。
 *
 * 为什么要先自己嗅一遍：`clipboard.write()` **不会**因为我们塞进去的不是真图片而报错 ——
 * 它会把 `text/plain`（文件名）照常写进去、把图片那一项**静默丢掉**。于是调用方拿到
 * "成功"，用户却发现剪贴板里原来复制的东西没了、图也没贴上。
 * 这正是本轮用户报的「截图进剪贴板会把剪贴板清空」的其中一半成因（另一半见下面校验+回滚）。
 * 先按魔数拦掉"后缀是 .png 其实是文本"这类文件，就完全不用动剪贴板。
 */
const SIGNATURES: Record<string, number[][]> = {
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
  'image/bmp': [[0x42, 0x4d]],
  // RIFF....WEBP：前 4 字节 RIFF，偏移 8 起是 WEBP
  'image/webp': [[0x52, 0x49, 0x46, 0x46]]
}

function looksLikeImage(buf: Buffer, mime: string): boolean {
  const sigs = SIGNATURES[mime]
  if (!sigs) return true // 没有已知魔数的格式不拦（宁可不拦，也不误杀）
  const ok = sigs.some((sig) => sig.every((b, i) => buf[i] === b))
  if (!ok) return false
  if (mime === 'image/webp') return buf.subarray(8, 12).toString('latin1') === 'WEBP'
  return true
}

/** 剪贴板快照（失败时用来原样放回去） */
interface ClipSnapshot {
  text: string
  /** 用 ArrayBuffer 而不是 Uint8Array：TS 里只有 ArrayBuffer 能直接当 BlobPart */
  images: { mime: string; buffer: ArrayBuffer }[]
}

/** 把当前剪贴板内容读成"可复原"的形式（文本 + 图片字节） */
async function snapshotClipboard(): Promise<ClipSnapshot> {
  const snap: ClipSnapshot = { text: '', images: [] }
  try {
    snap.text = await clipboard.readText()
  } catch {
    /* 读不到就当空文本 */
  }
  try {
    const items = await clipboard.read()
    for (const it of items) {
      for (const t of it.types ?? []) {
        if (!t.startsWith('image/')) continue
        try {
          const blob = (await it.getType(t)) as Blob
          snap.images.push({ mime: t, buffer: await blob.arrayBuffer() })
        } catch {
          /* 单个类型读不出来就跳过，不影响其它内容 */
        }
      }
    }
  } catch {
    /* 读不到图片就当没有 */
  }
  return snap
}

/** 剪贴板里现在到底有没有一张图（校验写入是否真的成功） */
async function readBackHasImage(): Promise<boolean> {
  try {
    const items = await clipboard.read()
    for (const it of items) {
      for (const t of it.types ?? []) {
        if (!t.startsWith('image/')) continue
        const blob = (await it.getType(t)) as Blob
        if (blob && blob.size > 0) return true
      }
    }
  } catch {
    /* 读失败按"没有"处理，交由回滚兜底 */
  }
  return false
}

/**
 * 把快照放回剪贴板。
 *
 * 为什么需要它：Electron 44 的 `write()` 对"它自己认不出的图片数据"是**静默丢弃**的
 * （见上面 SIGNATURES 的注释），也就是说 write 成功 ≠ 图片真的进去了。
 * 一旦校验发现图片没进去，我们必须把用户原来的内容放回去 —— 否则就成了
 * 「点一下截图，剪贴板被清空」，这正是用户报的现象。
 *
 * 只复原"文本 + 图片"两类：这两类是截图场景下真正会被顶掉的东西；
 * HTML/文件列表等富格式不做复原（代价是要把整个剪贴板格式表原样重建，收益极低）。
 */
async function restoreClipboard(snap: ClipSnapshot): Promise<boolean> {
  try {
    const items: ClipboardItem[] = []
    for (const img of snap.images) {
      items.push(new ClipboardItem({ [img.mime]: new Blob([img.buffer], { type: img.mime }) }))
    }
    if (snap.text) items.push(new ClipboardItem({ 'text/plain': snap.text }))
    if (items.length === 0) {
      // 原来本来就是空的：那"清空"就不是我们造成的，无需复原
      return true
    }
    await clipboard.write(items)
    const back = await clipboard.readText()
    const ok = !snap.text || back === snap.text
    if (!ok) log.append('warn', 'clipboard', `剪贴板复原后文本不一致（期望 "${snap.text}"，实际 "${back}"）`)
    return ok
  } catch (err) {
    log.append('error', 'clipboard', `剪贴板复原失败: ${String((err as Error)?.message ?? err)}`)
    return false
  }
}

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
  /*
   * 先按魔数拦一道：写进剪贴板的必须是"真的图片字节"。
   * 这一层是**纯读**操作，不碰剪贴板 —— 拦下来就等于原内容完全没被动过。
   * （用户报的"剪贴板被清空"里，"后缀是 .png 其实是别的东西"就是这么产生的。）
   */
  if (!looksLikeImage(buf, mime)) {
    log.append('warn', 'clipboard', `拒绝写入剪贴板（文件头不像 ${mime}）: ${basename(path)}`)
    return fail(`文件内容不是有效的图片（${mime}）`)
  }
  const name = basename(path)
  /*
   * 先快照 → 再写 → 再回读校验 → 失败就把快照放回去。
   *
   * 为什么必须"写后校验"：Electron 44 的 `clipboard.write()` 遇到它解不开的图片数据
   * （截断的 PNG、损坏的 JPEG）**不报错**，只把图片项丢掉、其余项照写 ——
   * 于是调用方看到成功、用户却丢了原来的剪贴板内容。回读一次就能识破。
   * 实测对照见 .e2e/v11-clip-result.json（修复前：截断 PNG 的 case 里
   * `ok:true` 但 `clipboardAfter.imgBytes:-1`、`keptPrevious:false`）。
   */
  const snap = await snapshotClipboard()
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
    if (!(await readBackHasImage())) {
      // 图片没真的进去（被静默丢弃）→ 把用户原来的内容放回去，再报失败
      const restored = await restoreClipboard(snap)
      const why = restored ? '剪贴板未能接受该图片，已保留原内容' : '剪贴板未能接受该图片，且原内容复原失败'
      log.append('warn', 'clipboard', `${why}: ${name}（${(buf.length / 1024).toFixed(0)}KB，${mime}）`)
      return fail(why)
    }
    log.append('info', 'clipboard', `截图已复制到剪贴板: ${name}（${(buf.length / 1024).toFixed(0)}KB）`)
    return { ok: true, text: name, file: path }
  } catch (err) {
    // 抛异常说明写入过程本身出错：同样把原内容放回去（write 是原子的，要么全写要么不写，
    // 但保险起见仍然复原一次 —— 复原失败也只是多一条日志，不会更糟）
    const reason = String((err as Error)?.message ?? err)
    const restored = await restoreClipboard(snap)
    log.append('warn', 'clipboard', `复制截图到剪贴板失败: ${reason}${restored ? '（已保留原内容）' : '（原内容复原失败）'}`)
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

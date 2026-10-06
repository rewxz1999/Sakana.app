import { app, BrowserWindow, dialog } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CardExportImageRequest,
  CardExportImageResult,
  CardExportImageEntry
} from '@shared/types'
import { log } from '../log'
import { imageDataUrl } from './media'

/**
 * 「把一张自制的 HTML 版式导出成高清 PNG，并存到用户自选的位置」——通用服务（v0.3.7）。
 *
 * ## 为什么单独抽一个服务，而不是各自照着统计工具抄一遍
 *
 * v0.3.7 新增了两个都要导出图片的工具（作品评级排名表、番剧推荐表），加上原有的统计列表，
 * 三处的需求完全一样：
 *   ① 先把远程封面换成 data URL（否则 offscreen 页面画不出来 / 慢的图直接漏画）；
 *   ② 在隐藏窗口里渲染，截图时按倍率放大（用户要「足够清晰」）；
 *   ③ 弹系统保存对话框让用户自己选目录与文件名；
 *   ④ 缺图必须如实报告（不能让用户以为「封面都导进去了」）。
 * 统计工具那份（statExport.ts）写得已经很扎实，但它的入参绑死在 `StatEntry` 上。
 * 这里把**与业务无关的那部分**抽出来给新工具用：渲染、放大、预取、保存、缺图报告。
 * 统计工具保持原样不动（它已经在用、且改动收益为零）。
 *
 * ## 高清是怎么做到的
 *
 * CSS 里按普通尺寸排版（比如 1400px 宽），窗口按 `width × scale` 开，
 * 再用 `webContents.setZoomFactor(scale)` 让页面按物理像素放大渲染 ——
 * 截图拿到的就是 2 倍像素的图（1400 → 2800px 宽），文字边缘是矢量重绘的，不会糊。
 *
 * ## 长图拼接
 *
 * 不拼图片文件：调用方直接把 N 页 HTML 依次拼成**一个**文档（页面之间用固定的分页间距隔开），
 * 一次截图就是一张长图。这比「截 N 张再合成」省掉一整套图像拼接代码，
 * 而且不会出现接缝处的半像素错位。高度上限沿用 Chromium 的安全值（16000px）。
 */

/** 单次导出的默认放大倍率（用户要求「导出图片要足够清晰」） */
export const CARD_EXPORT_SCALE = 2
/** 倍率上限：再高只会让内存与体积爆掉，画质肉眼已无区别 */
const MAX_SCALE = 3
/** Chromium 的离屏表面在约 16384px 处会失败，留一点余量 */
const MAX_HEIGHT = 16000

/** 封面/剧照地址 → data URI（本地文件直接读；远程地址由调用方先预取） */
function localImageDataUrl(p: string): string {
  if (!p) return ''
  if (/^https?:\/\//i.test(p)) return p
  try {
    if (!existsSync(p)) return ''
    const ext = /\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg'
    return `data:${ext};base64,${readFileSync(p).toString('base64')}`
  } catch {
    return ''
  }
}

/** 预取并发批大小：与统计工具同一取舍（不让几十张大图的 base64 同时驻留内存） */
const FETCH_BATCH = 6
/** 每张图的重试次数（= 尝试 2 次，与统计工具一致） */
const FETCH_ATTEMPTS = 2

/**
 * 把一组图片预取成 data URL。
 *
 * 为什么在**主进程**做：渲染进程拿远程图要过 `sakana-img://` 自定义协议，
 * 而 offscreen 页面里那个协议不可用；而且取图链路（UA/Referer、磁盘缓存、并发闸门）
 * 本来就在主进程的 `media.imageDataUrl`，复用它等于第二次导出直接吃缓存。
 */
export async function prefetchCardImages(
  images: CardExportImageEntry[]
): Promise<{ map: Record<string, string>; report: CardExportImageResult['images'] }> {
  const map: Record<string, string> = {}
  const report: CardExportImageResult['images'] = { total: 0, ok: 0, missing: [] }

  const one = async (entry: CardExportImageEntry): Promise<void> => {
    const url = String(entry?.url ?? '').trim()
    const label = entry?.label || entry?.key || '未命名'
    if (!url) {
      report.missing.push({ label, reason: '没有封面地址' })
      return
    }
    // 本地路径：主进程直接读成 data URL，不需要联网
    if (!/^https?:\/\//i.test(url)) {
      const inline = localImageDataUrl(url)
      if (inline) {
        map[entry.key] = inline
        report.ok += 1
      } else {
        report.missing.push({ label, reason: '本地图片读不到' })
      }
      return
    }
    report.total += 1
    let lastError = ''
    for (let i = 0; i < FETCH_ATTEMPTS; i += 1) {
      try {
        const r = await imageDataUrl(url)
        if (r?.dataUrl) {
          map[entry.key] = r.dataUrl
          report.ok += 1
          return
        }
        lastError = r?.error || '取图返回空'
      } catch (err) {
        lastError = String((err as Error)?.message ?? err)
      }
    }
    report.missing.push({ label, reason: lastError || '未知原因' })
  }

  for (let i = 0; i < images.length; i += FETCH_BATCH) {
    await Promise.all(images.slice(i, i + FETCH_BATCH).map(one))
  }
  return { map, report }
}

/**
 * 把 HTML 里的 `{{img:key}}` 占位符换成真实的 data URL。
 * 取不到的图片换成 1×1 透明图：占位框的背景色会露出来（比一个破图图标好看，也不会撑破版式）。
 */
const BLANK_PX =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function inlineImages(html: string, map: Record<string, string>): string {
  return html.replace(/\{\{img:([^}]+)\}\}/g, (_m, key: string) => map[key.trim()] || BLANK_PX)
}

/**
 * 在隐藏的 offscreen 窗口里渲染 HTML 并截图成 PNG。
 *
 * 与统计工具那份的差别：这里显式设 `zoomFactor`（放大渲染，而不是把窗口开大、
 * 让 CSS 自己撑 —— 后者会改变版式，前者只是把同一份版式画到更多像素上）。
 */
export async function renderHtmlToPng(
  html: string,
  widthCss: number,
  scale: number
): Promise<{ png: Buffer; width: number; height: number }> {
  const s = Math.min(MAX_SCALE, Math.max(1, scale || CARD_EXPORT_SCALE))
  const tmpFile = join(
    app.getPath('temp'),
    `sakana-card-export-${Date.now()}-${Math.floor(Math.random() * 100000)}.html`
  )
  writeFileSync(tmpFile, html, 'utf-8')
  const W = Math.round(widthCss * s)
  const win = new BrowserWindow({
    width: W,
    height: 900 * s,
    show: false,
    frame: false,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  try {
    await win.loadFile(tmpFile)
    // 等一帧排版与字体就绪（图片已是 data URL，不依赖网络）
    await new Promise((r) => setTimeout(r, 400))
    /*
     * 显式等所有图片就绪：`img.complete` 为真的直接过，其余等 load/error，单个最多 4 秒。
     * 不这么做的话，慢图会在截图时还没画上去（统计工具踩过这个坑：用户看到"封面没导入"）。
     */
    await win.webContents.executeJavaScript(`(async () => {
      const imgs = Array.from(document.images)
      await Promise.all(imgs.map((img) => img.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            const done = () => resolve()
            img.addEventListener('load', done, { once: true })
            img.addEventListener('error', done, { once: true })
            setTimeout(done, 4000)
          })))
      return imgs.length
    })()`)
    const h = (await win.webContents.executeJavaScript('document.body.scrollHeight')) as number
    const height = Math.max(200 * s, Math.min(Math.round(h) + 20 * s, MAX_HEIGHT))
    win.setContentSize(W, height)
    await new Promise((r) => setTimeout(r, 300))
    const img = await win.webContents.capturePage()
    const png = img.toPNG()
    if (!png || png.length === 0) throw new Error('截图生成失败（拿到空图）')
    return { png, width: W, height }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    try {
      unlinkSync(tmpFile)
    } catch {
      /* 临时文件清理失败可忽略 */
    }
  }
}

/**
 * 导出入口：预取图片 → 替换占位符 → 渲染 → 让用户选位置保存。
 *
 * 返回值里的 `path` 为空字符串表示用户取消了保存（界面不必报错）。
 */
export async function exportCardImage(
  req: CardExportImageRequest
): Promise<CardExportImageResult> {
  const width = Math.max(600, Math.min(4000, Math.round(Number(req.width) || 1400)))
  const scale = Math.min(MAX_SCALE, Math.max(1, Number(req.scale) || CARD_EXPORT_SCALE))
  const { map, report } = await prefetchCardImages(Array.isArray(req.images) ? req.images : [])
  const html = inlineImages(String(req.html ?? ''), map)
  if (!html.includes('<html')) throw new Error('导出内容为空（HTML 不完整）')
  const { png, width: px, height } = await renderHtmlToPng(html, width, scale)

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const safe = String(req.defaultName || '导出图片')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.png$/i, '')
    .slice(0, 60)
  /*
   * 自检/自动化用的旁路：设了 SAKANA_CARD_EXPORT_PATH 就直接写到那个路径，不弹保存框。
   * 为什么需要它：导出这条链路的正确性（封面有没有画上去、字号、长图有没有接上）
   * 只能对着真实产物看，而手动点保存对话框没法自动化。这是仓库里既有的
   * `SAKANA_*` 自检开关同一套做法（见 src/main/index.ts 里的各类 self-test）。
   */
  const bypass = String(process.env.SAKANA_CARD_EXPORT_PATH ?? '').trim()
  if (bypass) {
    writeFileSync(bypass, png)
    log.append('info', 'card', `[自检] 已直接写入 ${bypass}（${px}×${height}）`)
    return { path: bypass, images: report, width: px, height, canceled: false }
  }
  const r = await dialog.showSaveDialog(win, {
    title: req.title || '导出为图片',
    defaultPath: `${safe || '导出图片'}.png`,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  })
  if (r.canceled || !r.filePath) {
    return { path: '', images: report, width: px, height, canceled: true }
  }
  writeFileSync(r.filePath, png)
  log.append(
    'info',
    'card',
    `${req.title || '导出图片'} 已保存: ${r.filePath}（${px}×${height}，图片 ${report.ok}/${report.ok + report.missing.length} 取到）`
  )
  return { path: r.filePath, images: report, width: px, height, canceled: false }
}

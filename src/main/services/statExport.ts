import { app, BrowserWindow, dialog } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StatEntry, StatList, StatToolData } from '@shared/types'
import { log } from '../log'
import { store } from '../store'

/**
 * 统计列表导出为图片：
 * 在隐藏的 offscreen 窗口中渲染完整列表（全番剧名、全部评价、评分、看完时间、剧照），
 * capturePage 截图 → 用户自选保存位置写入 PNG。
 * 返回保存路径；用户取消返回空字符串。
 */

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function mimeOf(p: string): string {
  if (/\.png$/i.test(p)) return 'image/png'
  if (/\.jpe?g$/i.test(p)) return 'image/jpeg'
  if (/\.webp$/i.test(p)) return 'image/webp'
  if (/\.gif$/i.test(p)) return 'image/gif'
  if (/\.bmp$/i.test(p)) return 'image/bmp'
  return 'image/jpeg'
}

/** 封面/剧照 → data URI（本地文件读入，远程 URL 直接引用） */
function imgSrc(p: string | undefined): string {
  if (!p) return ''
  if (/^https?:\/\//i.test(p)) return p
  try {
    if (existsSync(p)) {
      return `data:${mimeOf(p)};base64,${readFileSync(p).toString('base64')}`
    }
  } catch {
    /* ignore */
  }
  return ''
}

function pad(s: unknown): string {
  return String(s ?? '—')
}

/** 导出画布缩放倍数：2 倍提高清晰度（窗口按 860*S 宽渲染，CSS 尺寸同步放大） */
const S = 2

function buildHtml(list: StatList, entries: StatEntry[]): string {
  const title = esc(list.name)
  const count = entries.length
  const date = new Date().toLocaleString('zh-CN')
  const rows = entries
    .map((e) => {
      const initial = String(e.initialReview ?? '').trim()
      const final = String(e.finalReview ?? '').trim()
      // 旧数据兜底
      const legacy = (e.reviews ?? []).map((r) => String(r ?? '').trim()).filter((r) => r)
      const reviews: { label: string; text: string }[] = []
      if (initial) reviews.push({ label: '初始评价', text: initial })
      if (final) reviews.push({ label: '完结评价', text: final })
      if (reviews.length === 0 && legacy.length > 0) {
        legacy.forEach((r, i) => reviews.push({ label: `评价${i + 1}`, text: r }))
      }
      const photos = (e.photos ?? []).map(imgSrc).filter((p) => p)
      const deviation =
        e.personalRating != null && e.bgmRating != null
          ? (e.personalRating - e.bgmRating).toFixed(1)
          : null
      const name = esc(e.nameCn || e.name)
      const nameOrig = e.nameCn && e.name && e.nameCn !== e.name ? esc(e.name) : ''
      return `
      <div class="row">
        <div class="seq">${esc(e.seq)}</div>
        <div class="main">
          <div class="name">${name}</div>
          ${nameOrig ? `<div class="name-orig">${nameOrig}</div>` : ''}
          <div class="meta">放送：${esc(pad(e.airDate))}　·　看完：${esc(pad(e.watchedAt))}</div>
          <div class="ratings">
            <span class="rate">个人评分：<b>${e.personalRating != null ? e.personalRating.toFixed(1) : '—'}</b></span>
            <span class="rate">bgm：<b>${e.bgmRating != null ? e.bgmRating.toFixed(1) : '—'}</b></span>
            ${deviation != null ? `<span class="rate dev">偏差：${Number(deviation) >= 0 ? '+' : ''}${deviation}</span>` : ''}
          </div>
          ${
            reviews.length > 0
              ? `<div class="reviews">${reviews
                  .map((r) => `<div class="review"><span class="review-label">${esc(r.label)}</span>${esc(r.text)}</div>`)
                  .join('')}</div>`
              : ''
          }
        </div>
        <div class="photos">
          ${e.cover ? `<img class="cover" src="${esc(e.cover)}" onerror="this.style.display='none'">` : ''}
          ${photos.map((p) => `<img class="photo" src="${p}">`).join('')}
        </div>
      </div>`
    })
    .join('')

  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${800 * S}px;
    background: #ffffff;
    color: #1f2a3d;
    font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
    padding: ${28 * S}px ${30 * S}px ${30 * S}px;
  }
  .head { border-bottom: ${2 * S}px solid #2f6bff; padding-bottom: ${14 * S}px; margin-bottom: ${16 * S}px; }
  .title { font-size: ${24 * S}px; font-weight: 700; }
  .sub { margin-top: ${6 * S}px; font-size: ${12 * S}px; color: #8a97ad; }
  .row {
    display: flex; gap: ${14 * S}px; align-items: flex-start;
    background: #f4f7fc; border: 1px solid #d9e3f2; border-radius: ${10 * S}px;
    padding: ${14 * S}px; margin-bottom: ${12 * S}px; page-break-inside: avoid;
  }
  .seq { flex: 0 0 ${44 * S}px; font-size: ${15 * S}px; font-weight: 700; color: #2f6bff; text-align: center; padding-top: ${2 * S}px; }
  .main { flex: 1; min-width: 0; }
  .name { font-size: ${15 * S}px; font-weight: 700; line-height: 1.5; word-break: break-all; }
  .name-orig { font-size: ${12 * S}px; color: #5a6a85; margin-top: ${2 * S}px; word-break: break-all; }
  .meta { margin-top: ${6 * S}px; font-size: ${12 * S}px; color: #8a97ad; }
  .ratings { margin-top: ${6 * S}px; font-size: ${12 * S}px; }
  .rate { color: #4a566e; margin-right: ${12 * S}px; }
  .rate b { color: #e08a00; }
  .dev { color: #8a97ad; }
  .reviews { margin-top: ${8 * S}px; }
  .review {
    font-size: ${12 * S}px; line-height: 1.7; color: #22304a;
    background: #eef3fb; border-radius: ${6 * S}px; padding: ${7 * S}px ${10 * S}px; margin-bottom: ${6 * S}px;
    word-break: break-all; white-space: pre-wrap;
  }
  .review-label { color: #2f6bff; font-weight: 700; margin-right: ${6 * S}px; }
  .photos { flex: 0 0 auto; display: flex; flex-direction: column; gap: ${6 * S}px; align-items: flex-end; }
  .cover { width: ${66 * S}px; height: ${92 * S}px; object-fit: cover; border-radius: ${6 * S}px; }
  .photo { width: ${92 * S}px; height: ${56 * S}px; object-fit: cover; border-radius: ${6 * S}px; }
  .foot { margin-top: ${18 * S}px; padding-top: ${10 * S}px; border-top: 1px solid #d9e3f2; font-size: ${11 * S}px; color: #98a4b8; text-align: center; }
</style></head>
<body>
  <div class="head">
    <div class="title">${title}</div>
    <div class="sub">共 ${count} 个条目 · 导出时间 ${esc(date)} · Sakana 统计工具</div>
  </div>
  ${rows}
  <div class="foot">Sakana · 统计列表导出</div>
</body></html>`
}

/** 在隐藏 offscreen 窗口中渲染 HTML 并截图返回 PNG Buffer（2 倍分辨率） */
async function renderStatHtml(html: string): Promise<Buffer> {
  const tmpFile = join(
    app.getPath('temp'),
    `sakana-stat-export-${Date.now()}-${Math.floor(Math.random() * 100000)}.html`
  )
  writeFileSync(tmpFile, html, 'utf-8')
  const W = 860 * S
  const w = new BrowserWindow({
    width: W,
    height: 600 * S,
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
    await w.loadFile(tmpFile)
    // 等待远程封面/字体渲染（有 onerror 兜底）
    await new Promise((r) => setTimeout(r, 1500))
    const h = (await w.webContents.executeJavaScript('document.body.scrollHeight')) as number
    // 高度上限：Chromium 离屏/GPU 表面在约 16384px 处会失败（S=2 时旧上限 14000*S=28000 过高），
    // 超长内容截断到上限，而不是让整张图导出失败。
    const height = Math.max(200 * S, Math.min(Math.round(h) + 40 * S, 16000))
    w.setContentSize(W, height)
    await new Promise((r) => setTimeout(r, 400))
    const img = await w.webContents.capturePage()
    const png = img.toPNG()
    if (!png || png.length === 0) throw new Error('截图生成失败')
    return png
  } finally {
    if (!w.isDestroyed()) w.destroy()
    try {
      unlinkSync(tmpFile)
    } catch {
      /* 临时文件清理失败可忽略 */
    }
  }
}

export async function statExportImage(listId: string): Promise<string> {
  const data = store.get<StatToolData>('statTool', { lists: [], entries: [] })
  const list = (data.lists ?? []).find((l) => l.id === listId)
  if (!list) throw new Error('列表不存在')
  const entries = (data.entries ?? [])
    .filter((e) => e.listId === listId)
    .sort((a, b) => a.seq.localeCompare(b.seq))

  const png = await renderStatHtml(buildHtml(list, entries))

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const safe = list.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  const r = await dialog.showSaveDialog(win, {
    title: '导出列表为图片',
    defaultPath: `${safe || '统计列表'}.png`,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  })
  if (r.canceled || !r.filePath) return ''
  writeFileSync(r.filePath, png)
  log.append('info', 'stat', `列表已导出为图片: ${r.filePath}`)
  return r.filePath
}

/** 自检（SAKANA_STAT_TEST=1）：注入临时列表 → 渲染截图 → 校验 PNG → 恢复数据 */
export async function statExportTest(): Promise<string> {
  const prev = store.get<StatToolData | null>('statTool', null)
  const listId = 'test-list'
  const testData: StatToolData = {
    lists: [{ id: listId, name: '自检列表', createdAt: Date.now() }],
    entries: [
      {
        id: 'e1',
        listId,
        subjectId: 1,
        seq: '202401',
        name: 'ぼっち・ざ・ろっく！',
        nameCn: '孤独摇滚！',
        cover: '',
        airDate: '2024-01-01',
        watchedAt: '2024-03-02',
        personalRating: 8.5,
        bgmRating: 8.3,
        photos: [],
        reviews: [],
        initialReview: '这是一条用于自检导出的初始评价内容，需要完整显示在图片上。',
        finalReview: '这是完结评价，导出图片必须完整包含这两段评价内容。',
        order: 1
      }
    ]
  }
  try {
    store.set('statTool', testData)
    const list = testData.lists[0]
    const entries = testData.entries.filter((e) => e.listId === listId).sort((a, b) => a.seq.localeCompare(b.seq))
    const png = await renderStatHtml(buildHtml(list, entries))
    const out = join(app.getPath('temp'), 'sakana-stat-export-test.png')
    writeFileSync(out, png)
    return out
  } finally {
    if (prev == null) store.remove('statTool')
    else store.set('statTool', prev)
    // 立即落盘恢复原数据（自检随后退出应用，防抖写入可能来不及执行）
    store.flushAll()
  }
}

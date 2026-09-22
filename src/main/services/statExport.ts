import { app, BrowserWindow, dialog } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  StatEntry,
  StatExportField,
  StatExportOptions,
  StatList,
  StatToolData
} from '@shared/types'
import { log } from '../log'
import { store } from '../store'
import { readStatData, statWatchProgressFor } from './statStore'

/**
 * 统计列表导出为图片：
 * 在隐藏的 offscreen 窗口中渲染完整列表（全番剧名、勾选的字段、剧照），
 * capturePage 截图 → 用户自选保存位置写入 PNG。
 * 返回保存路径；用户取消返回空字符串。
 *
 * v0.2 改动：
 * - 导出前由用户勾选要导出的详情字段（fields），没勾的字段连标题都不出现；
 * - 内容多时**整张画布加宽**（而不是把条目压窄/截断），剧照默认也放大一档；
 * - 行高上限沿用旧上限（约 16000px），超长内容按新宽度重新排版后再截断。
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

/** 默认勾选的字段（用户没给 fields 时的兜底 = 「条目上显示什么就导出什么」） */
export const STAT_EXPORT_DEFAULT_FIELDS: StatExportField[] = [
  'seq',
  'cover',
  'name',
  'airDate',
  'watchedAt',
  'personalRating',
  'bgmRating',
  'deviation',
  'overallReview',
  'photos'
]

/** 每个可勾选字段的中文标题（导出图上的小标签） */
const FIELD_LABEL: Record<StatExportField, string> = {
  seq: '序号',
  cover: '封面',
  name: '番剧名',
  airDate: '放送时间',
  watchedAt: '看完时间',
  genres: '类型',
  initialRating: '初始评分',
  midRating: '中期评分',
  endRating: '结束评分',
  personalRating: '个人评分',
  bgmRating: 'bangumi 评分',
  deviation: '差值',
  initialReview: '初期评价',
  midReview: '中期评价',
  endReview: '结束评价',
  overallReview: '总体评价',
  historyTier: '历史级',
  photos: '剧照',
  progress: '观看进度',
  remark: '备注'
}

/**
 * 字段分三档（决定排版位置，不是内容）：
 * - head：标题区（序号 / 封面 / 番剧名）
 * - meta：一行小字（放送时间、看完时间、类型、历史级、观看进度）
 * - rate：评分一行（初始/中期/结束/个人/bgm/差值）
 * - text：长文本段落（三段评价 / 总体评价 / 备注）
 * - photos：图（右侧一列）
 */
type FieldSlot = 'head' | 'meta' | 'rate' | 'text' | 'photos'

const FIELD_SLOT: Record<StatExportField, FieldSlot> = {
  seq: 'head',
  cover: 'head',
  name: 'head',
  airDate: 'meta',
  watchedAt: 'meta',
  genres: 'meta',
  historyTier: 'meta',
  progress: 'meta',
  initialRating: 'rate',
  midRating: 'rate',
  endRating: 'rate',
  personalRating: 'rate',
  bgmRating: 'rate',
  deviation: 'rate',
  initialReview: 'text',
  midReview: 'text',
  endReview: 'text',
  overallReview: 'text',
  remark: 'text',
  photos: 'photos'
}

/** 导出画布缩放倍数：2 倍提高清晰度（窗口按宽度*S 渲染，CSS 尺寸同步放大） */
const S = 2
/** 默认画布宽度（CSS 像素）。内容多 / 剧照多时向右加宽，见 computeWidth() */
const BASE_WIDTH = 860

/**
 * 计算画布宽度。
 *
 * 用户要求「内容过多时就算是加宽条目也要显示详情内容」：
 * 所以字段多的时候是**把整张画布加宽**，而不是把文字挤到换行/截断。
 * 加成几档就够了（文字本来就会换行，无限加宽反而不好看）：
 * - 有长文本（评价/备注）→ +420
 * - 勾了满分（4 个评分 + bgm + 差值）→ +120
 * - 有剧照 → 按剧照数量每张 +26（照片是横排的）
 * - 用户手动宽度倍数（0.6–1.6）再乘一次
 */
export function computeExportWidth(fields: StatExportField[], opts?: StatExportOptions): number {
  const has = (f: StatExportField): boolean => fields.includes(f)
  let w = BASE_WIDTH
  const textCount = (['initialReview', 'midReview', 'endReview', 'overallReview', 'remark'] as StatExportField[]).filter(
    has
  ).length
  if (textCount > 0) w += 420
  const rateCount = (
    ['initialRating', 'midRating', 'endRating', 'personalRating', 'bgmRating', 'deviation'] as StatExportField[]
  ).filter(has).length
  if (rateCount >= 4) w += 120
  if (has('photos')) w += 4 * 26
  const scale = Math.min(1.6, Math.max(0.6, opts?.widthScale ?? 1))
  return Math.round(w * scale)
}

interface RowParts {
  seq: string
  cover: string
  name: string
  nameOrig: string
  meta: { label: string; value: string }[]
  rates: { label: string; value: string; cls?: string }[]
  texts: { label: string; value: string }[]
  photos: string[]
}

function buildRow(entry: StatEntry, fields: StatExportField[]): RowParts {
  const has = (f: StatExportField): boolean => fields.includes(f)
  const name = esc(entry.nameCn || entry.name)
  const nameOrig = entry.nameCn && entry.name && entry.nameCn !== entry.name ? esc(entry.name) : ''

  const meta: { label: string; value: string }[] = []
  if (has('airDate')) meta.push({ label: '放送', value: esc(pad(entry.airDate)) })
  if (has('watchedAt')) meta.push({ label: '看完', value: esc(pad(entry.watchedAt)) })
  if (has('genres')) meta.push({ label: '类型', value: esc(entry.genres.join('、') || '—') })
  if (has('progress')) {
    const p = statWatchProgressFor(entry)
    meta.push({ label: '进度', value: esc(p.text) })
  }
  if (has('historyTier')) meta.push({ label: '历史级', value: esc(entry.historyTier || '—') })

  const rates: { label: string; value: string; cls?: string }[] = []
  const rateOf = (f: StatExportField, v: number | null): void => {
    if (!has(f)) return
    rates.push({ label: FIELD_LABEL[f], value: v != null ? v.toFixed(1) : '—' })
  }
  rateOf('initialRating', entry.initialRating)
  rateOf('midRating', entry.midRating)
  rateOf('endRating', entry.endRating)
  rateOf('personalRating', entry.personalRating)
  rateOf('bgmRating', entry.bgmRating)
  if (has('deviation')) {
    if (entry.personalRating != null && entry.bgmRating != null) {
      const dev = entry.personalRating - entry.bgmRating
      rates.push({
        label: '差值',
        value: `${dev >= 0 ? '+' : '-'}${Math.abs(dev).toFixed(1)}`,
        cls: dev >= 0 ? 'dev-plus' : 'dev-minus'
      })
    } else {
      rates.push({ label: '差值', value: '—' })
    }
  }

  const texts: { label: string; value: string }[] = []
  const textOf = (f: StatExportField, v: string): void => {
    if (!has(f)) return
    const t = String(v ?? '').trim()
    if (!t) return // 空内容不占版面：勾了但没写就不渲染
    texts.push({ label: FIELD_LABEL[f], value: esc(t) })
  }
  textOf('initialReview', entry.initialReview)
  textOf('midReview', entry.midReview)
  textOf('endReview', entry.endReview)
  textOf('overallReview', entry.overallReview)
  textOf('remark', entry.remark)

  return {
    seq: has('seq') ? esc(entry.seq) : '',
    cover: has('cover') ? esc(entry.cover) : '',
    name,
    nameOrig,
    meta,
    rates,
    texts,
    photos: has('photos') ? (entry.photos ?? []).map(imgSrc).filter(Boolean) : []
  }
}

function buildHtml(
  list: StatList,
  entries: StatEntry[],
  opts: StatExportOptions,
  width: number
): string {
  const fields = opts.fields.length > 0 ? opts.fields : STAT_EXPORT_DEFAULT_FIELDS
  const title = esc(list.name)
  const count = entries.length
  const date = new Date().toLocaleString('zh-CN')
  const photoScale = Math.min(2, Math.max(0.8, opts.photoScale ?? 1.25))
  // 剧照尺寸：基础 92×56 太"邮票"，默认放大到 1.25 倍（用户要求「剧照图片可以稍微大点」）
  const pw = Math.round(92 * photoScale)
  const ph = Math.round(56 * photoScale)
  const coverW = 66
  const coverH = 92

  const rows = entries
    .map((e) => {
      const r = buildRow(e, fields)
      const metaHtml = r.meta.length
        ? `<div class="meta">${r.meta
            .map((m) => `<span class="meta-item"><i>${esc(m.label)}</i>${m.value}</span>`)
            .join('')}</div>`
        : ''
      const rateHtml = r.rates.length
        ? `<div class="ratings">${r.rates
            .map(
              (x) =>
                `<span class="rate ${x.cls ?? ''}"><i>${esc(x.label)}</i><b>${esc(x.value)}</b></span>`
            )
            .join('')}</div>`
        : ''
      const textHtml = r.texts.length
        ? `<div class="texts">${r.texts
            .map(
              (t) =>
                `<div class="text"><span class="text-label">${esc(t.label)}</span><span class="text-body">${t.value}</span></div>`
            )
            .join('')}</div>`
        : ''
      const photosHtml = r.photos.length
        ? `<div class="photos">${r.photos
            .map((p) => `<img class="photo" src="${p}" onerror="this.style.display='none'">`)
            .join('')}</div>`
        : ''
      return `
      <div class="row">
        ${r.seq ? `<div class="seq">${r.seq}</div>` : ''}
        <div class="main">
          <div class="name">${r.name}</div>
          ${r.nameOrig ? `<div class="name-orig">${r.nameOrig}</div>` : ''}
          ${metaHtml}
          ${rateHtml}
          ${textHtml}
        </div>
        ${
          r.cover || photosHtml
            ? `<div class="side">
                 ${r.cover ? `<img class="cover" src="${r.cover}" onerror="this.style.display='none'">` : ''}
                 ${photosHtml}
               </div>`
            : ''
        }
      </div>`
    })
    .join('')

  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${width * S}px;
    background: #ffffff;
    color: #1f2a3d;
    font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
    padding: ${28 * S}px ${30 * S}px ${30 * S}px;
  }
  .head { border-bottom: ${2 * S}px solid #2f6bff; padding-bottom: ${14 * S}px; margin-bottom: ${16 * S}px; }
  .title { font-size: ${24 * S}px; font-weight: 700; }
  .sub { margin-top: ${6 * S}px; font-size: ${12 * S}px; color: #8a97ad; }
  /* 条目：横向排列，内容多时整张画布更宽（见 computeExportWidth），不截断不挤压 */
  .row {
    display: flex; gap: ${14 * S}px; align-items: flex-start;
    background: #f4f7fc; border: 1px solid #d9e3f2; border-radius: ${10 * S}px;
    padding: ${14 * S}px; margin-bottom: ${12 * S}px; page-break-inside: avoid;
  }
  .seq { flex: 0 0 ${44 * S}px; font-size: ${15 * S}px; font-weight: 700; color: #2f6bff; text-align: center; padding-top: ${2 * S}px; }
  .main { flex: 1 1 auto; min-width: 0; }
  .name { font-size: ${15 * S}px; font-weight: 700; line-height: 1.5; word-break: break-word; }
  .name-orig { font-size: ${12 * S}px; color: #5a6a85; margin-top: ${2 * S}px; word-break: break-word; }
  .meta { margin-top: ${6 * S}px; font-size: ${12 * S}px; color: #8a97ad; }
  .meta-item { margin-right: ${14 * S}px; white-space: nowrap; }
  .meta-item i { font-style: normal; color: #98a4b8; margin-right: ${4 * S}px; }
  .ratings { margin-top: ${7 * S}px; font-size: ${12 * S}px; }
  .rate {
    display: inline-block; background: #eef3fb; border-radius: ${5 * S}px;
    padding: ${3 * S}px ${8 * S}px; margin: 0 ${6 * S}px ${6 * S}px 0;
  }
  .rate i { font-style: normal; color: #6b7a94; margin-right: ${5 * S}px; }
  .rate b { color: #e08a00; }
  .dev-plus b { color: #12a150; }
  .dev-minus b { color: #d9483f; }
  .texts { margin-top: ${9 * S}px; }
  .text {
    font-size: ${12 * S}px; line-height: 1.75; color: #22304a;
    background: #eef3fb; border-radius: ${6 * S}px; padding: ${8 * S}px ${10 * S}px; margin-bottom: ${6 * S}px;
    word-break: break-word; white-space: pre-wrap;
  }
  .text-label { color: #2f6bff; font-weight: 700; margin-right: ${6 * S}px; }
  /* 右侧一列：封面 + 剧照（剧照默认放大到 1.25 倍，用户要求「稍微大点」） */
  .side { flex: 0 0 auto; display: flex; flex-direction: column; gap: ${8 * S}px; align-items: flex-end; }
  .cover { width: ${coverW * S}px; height: ${coverH * S}px; object-fit: cover; border-radius: ${6 * S}px; }
  .photos { display: flex; flex-direction: column; gap: ${6 * S}px; align-items: flex-end; }
  .photo { width: ${pw * S}px; height: ${ph * S}px; object-fit: cover; border-radius: ${6 * S}px; }
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
async function renderStatHtml(html: string, width: number): Promise<Buffer> {
  const tmpFile = join(
    app.getPath('temp'),
    `sakana-stat-export-${Date.now()}-${Math.floor(Math.random() * 100000)}.html`
  )
  writeFileSync(tmpFile, html, 'utf-8')
  const W = width * S
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
    // 高度上限：Chromium 离屏/GPU 表面在约 16384px 处会失败，超长内容截断到上限，
    // 而不是让整张图导出失败（宽度越大，同样内容的高度越小，所以加宽也有助于不触顶）。
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

export async function statExportImage(listId: string, opts?: StatExportOptions): Promise<string> {
  const data = readStatData()
  const list = (data.lists ?? []).find((l) => l.id === listId)
  if (!list) throw new Error('列表不存在')
  const entries = (data.entries ?? [])
    .filter((e) => e.listId === listId)
    .sort((a, b) => a.seq.localeCompare(b.seq))

  const options: StatExportOptions = {
    fields: Array.isArray(opts?.fields) && opts.fields.length > 0 ? opts.fields : STAT_EXPORT_DEFAULT_FIELDS,
    widthScale: opts?.widthScale,
    photoScale: opts?.photoScale
  }
  const width = computeExportWidth(options.fields, options)
  const png = await renderStatHtml(buildHtml(list, entries, options, width), width)

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const safe = list.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  const r = await dialog.showSaveDialog(win, {
    title: '导出列表为图片',
    defaultPath: `${safe || '统计列表'}.png`,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  })
  if (r.canceled || !r.filePath) return ''
  writeFileSync(r.filePath, png)
  log.append(
    'info',
    'stat',
    `列表已导出为图片: ${r.filePath}（宽 ${width}px，勾选 ${options.fields.length} 个字段）`
  )
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
        genres: ['音乐', '日常'],
        watchedAt: '2024-03-02T21:30',
        initialRating: 7.5,
        midRating: 8.5,
        endRating: 9,
        personalRating: 8.5,
        bgmRating: 8.3,
        photos: [],
        reviews: [],
        initialReview: '这是一条用于自检导出的初始评价内容，需要完整显示在图片上。',
        midReview: '中期评价：节奏稳定，作画在线。',
        endReview: '这是结束评价，导出图片必须完整包含这几段评价内容。',
        overallReview: '总体评价：值得反复观看。',
        historyTier: '历史级 8',
        remark: '备注：BD 已收。',
        finalReview: '',
        order: 1
      }
    ]
  }
  try {
    store.set('statTool', testData)
    const list = testData.lists[0]
    const entries = testData.entries.filter((e) => e.listId === listId)
    const options: StatExportOptions = { fields: Object.keys(FIELD_LABEL) as StatExportField[], photoScale: 1.25 }
    const width = computeExportWidth(options.fields, options)
    const png = await renderStatHtml(buildHtml(list, entries, options, width), width)
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

import { app, BrowserWindow, dialog } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareStatOrder } from '@shared/statSeq'
import type {
  StatEntry,
  StatExportField,
  StatExportOptions,
  StatExportTheme,
  StatList,
  StatToolData
} from '@shared/types'
import { log } from '../log'
import { store } from '../store'
import { imageDataUrl } from './media'
import { readStatData, statWatchProgressFor } from './statStore'

/**
 * 统计列表导出为图片：
 * 在隐藏的 offscreen 窗口中渲染完整列表（全番剧名、勾选的字段、剧照），
 * capturePage 截图 → 用户自选保存位置写入 PNG。
 * 返回保存路径；用户取消返回空字符串。
 *
 * v0.2 改动：
 * - 导出前由用户勾选要导出的详情字段（fields），没勾的字段连标题都不出现；
 * - 内容多时**整张画布加宽**（而不是把条目压窄/截断），剧照默认也放大一档。
 *
 * v0.3.5 改动（对着用户三条反馈）：
 * 1. 「部分番剧的封面没导入」——根因是过去把**远程封面 URL 直接塞进 offscreen 页面的
 *    `<img src>`**，只等固定 1.5 秒就开始截图：慢的那几张就静静没画上去，
 *    而且 `onerror` 把失败的图 `display:none` 掉，用户完全看不到发生了什么。
 *    现在：封面在**主进程**先用 `imageDataUrl()`（带 UA/Referer/磁盘缓存的既有取图链路）
 *    转成 data URL，**失败自动重试一次**；只重试后仍失败的才算缺图。
 *    渲染前还会显式 `await` 所有图片的 load/error，截图时不会再"漏画"。
 * 2. 「条目样式有点丑，列表条目的样式就挺好看」——条目区按 `StatToolPage.tsx` 的
 *    列表条目的排版/比例重做（左序号 + 封面 + 信息列 + 右侧评分 + 右侧评价列），
 *    配色取**当前主题**（渲染层把主题 CSS 变量传进来），所以导出图与界面同观感。
 * 3. bangumi 评分显示策略与界面一致：`开关打开 || 该条已有个人评分`（见 buildRow）。
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

/** 封面/剧照 → data URI（本地文件与 data URL 直接读入；远程 URL 由 prefetchCovers 预取后再进来） */
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

/** 默认勾选的字段（= 「条目上显示什么就导出什么」，含用户要的类型标签） */
export const STAT_EXPORT_DEFAULT_FIELDS: StatExportField[] = [
  'seq',
  'cover',
  'name',
  'airDate',
  'watchedAt',
  'genres',
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

/** 参与「评分区」的字段（顺序即导出图上的顺序，与界面列表条目一致） */
const RATE_FIELDS: StatExportField[] = [
  'initialRating',
  'midRating',
  'endRating',
  'personalRating',
  'bgmRating',
  'deviation'
]

/** 参与「右侧评价列」的字段 */
const TEXT_FIELDS: StatExportField[] = [
  'initialReview',
  'midReview',
  'endReview',
  'overallReview',
  'remark'
]

/** 评价字段 → 取哪个值（表驱动，避免一串 if 链漏掉某个字段） */
const TEXT_VALUE: Record<string, (e: StatEntry) => string> = {
  initialReview: (e) => e.initialReview,
  midReview: (e) => e.midReview,
  endReview: (e) => e.endReview,
  overallReview: (e) => e.overallReview,
  remark: (e) => e.remark
}

/**
 * 导出图的默认配色（浅色主题）。
 *
 * 正常情况下渲染层会把当前主题的 CSS 变量值传进来（`opts.theme`），
 * 这份默认值只用于「主进程自检 / 老渲染层没传 theme」的兜底，取值与 styles/main.css 的
 * `:root`（白蓝 · 浅色）保持一致。
 */
const DEFAULT_THEME: StatExportTheme = {
  bg: '#eef2f9',
  elev1: '#ffffff',
  elev2: '#e9eef8',
  border: '#d4deee',
  text: '#1c2433',
  dim: '#4a566e',
  faint: '#8b96ad',
  accent: '#2f6bff',
  accentSoft: '#e3ecff',
  ok: '#2f9e63',
  danger: '#d64545',
  warn: '#c07a1a'
}

/** 导出画布缩放倍数：2 倍提高清晰度（窗口按宽度*S 渲染，CSS 尺寸同步放大） */
const S = 2
/**
 * 画布基准宽度（CSS 像素）。
 *
 * 这个数字 = 条目本身的最小宽度 + 画布左右留白：
 * 序号 76 + 间距 18 + 封面 62 + 间距 18 + 信息列最小 260 + 间距 18 + 评分区 3 格约 216
 * + 条目内边距 32 + 画布左右留白 60 ≈ 760，取 780 留点余量。
 */
const BASE_WIDTH = 780
/** 右侧评价列宽度（与界面上「总体评价」那一栏同一比例，界面是 260px） */
const TEXT_COL_W = 280
/** 剧照横排基准尺寸（与界面 PhotoStrip 的 h-16 w-24 一致：96×64） */
const PHOTO_BASE_W = 96
const PHOTO_BASE_H = 64
/** 封面尺寸（界面列表条目是 54×74，导出图放大到 62×85 保持同一比例、更容易看清） */
const COVER_W = 62
const COVER_H = 85

/**
 * 计算画布宽度。
 *
 * 用户要求「内容过多时就算是加宽条目也要显示详情内容」：字段多的时候是**把整张画布加宽**，
 * 而不是把文字挤到换行/截断（文字本来就会换行，无限加宽反而不好看），所以：
 * - 评分格子超过 3 个 → 每多一格 +88（界面上评分区是横排，格子多了就得给它地方）；
 * - 勾了评价/备注 → +300（右侧评价列）；
 * - 勾了剧照 → 按「一行能放下 2 张」加宽（剧照是 flex-wrap 横排）；
 * - 用户手动宽度倍数（0.6–1.6）再乘一次。
 */
export function computeExportWidth(fields: StatExportField[], opts?: StatExportOptions): number {
  const has = (f: StatExportField): boolean => fields.includes(f)
  const rateCount = RATE_FIELDS.filter(has).length
  const textCount = TEXT_FIELDS.filter(has).length
  let w = BASE_WIDTH
  if (rateCount > 3) w += (rateCount - 3) * 88
  if (textCount > 0) w += TEXT_COL_W + 20
  if (has('photos')) {
    const ps = clampPhotoScale(opts?.photoScale)
    w += Math.round(PHOTO_BASE_W * ps) * 2 + 16
  }
  const scale = Math.min(1.6, Math.max(0.6, opts?.widthScale ?? 1))
  return Math.round(w * scale)
}

function clampPhotoScale(v: number | undefined): number {
  return Math.min(2, Math.max(0.8, v ?? 1.25))
}

interface RowParts {
  seq: string
  cover: string
  name: string
  nameOrig: string
  meta: { label: string; value: string }[]
  tags: string[]
  rates: { label: string; value: string; cls?: string }[]
  texts: { label: string; value: string }[]
  photos: string[]
}

/**
 * 单条 → 各部分内容。
 *
 * `covers` 是主进程预取好的「条目 id → 封面 data URL」映射；没有命中时退回原始地址
 * （远程地址在 offscreen 页面里仍可能被画出来 —— 只是不再是我们依赖的主路径）。
 */
function buildRow(entry: StatEntry, fields: StatExportField[], opts: StatExportOptions, covers: Record<string, string>): RowParts {
  const has = (f: StatExportField): boolean => fields.includes(f)
  const name = esc(entry.nameCn || entry.name)
  const nameOrig = entry.nameCn && entry.name && entry.nameCn !== entry.name ? esc(entry.name) : ''

  const meta: { label: string; value: string }[] = []
  if (has('airDate')) meta.push({ label: '放送', value: esc(pad(entry.airDate)) })
  if (has('watchedAt')) meta.push({ label: '看完', value: esc(pad(entry.watchedAt)) })
  if (has('progress')) {
    const p = statWatchProgressFor(entry)
    meta.push({ label: '进度', value: esc(p.text) })
  }
  if (has('historyTier')) meta.push({ label: '历史级', value: esc(entry.historyTier || '—') })

  const rates: { label: string; value: string; cls?: string }[] = []
  const rateOf = (f: StatExportField, v: number | null, cls?: string): void => {
    if (!has(f)) return
    rates.push({ label: FIELD_LABEL[f], value: v != null ? v.toFixed(1) : '—', cls })
  }
  /*
   * bangumi 评分显示策略（与界面**同一套规则**）：
   *   显示条件 = 工具栏开关打开 || 该条已经填了个人评分。
   * 用户原话：「条目先默认不展示 bangumi 评分」「填完个人评分后自动显示 bangumi 评分」。
   * 注意判定用的是 `personalRating != null`（不是 `> 0`），0 分也是填过。
   */
  const showBgm = opts.showBgmRating === true || entry.personalRating != null
  rateOf('initialRating', entry.initialRating)
  rateOf('midRating', entry.midRating)
  rateOf('endRating', entry.endRating)
  rateOf('personalRating', entry.personalRating, 'rate-personal')
  if (showBgm) rateOf('bgmRating', entry.bgmRating, 'rate-bgm')
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
  for (const f of TEXT_FIELDS) textOf(f, TEXT_VALUE[f](entry))

  const coverSrc = covers[entry.id] ?? (has('cover') ? imgSrc(entry.cover) : '')
  return {
    seq: has('seq') ? esc(entry.seq) : '',
    cover: coverSrc,
    name,
    nameOrig,
    meta,
    tags: has('genres') ? entry.genres.map(esc) : [],
    rates,
    texts,
    photos: has('photos') ? (entry.photos ?? []).map(imgSrc).filter(Boolean) : []
  }
}

/**
 * 生成导出 HTML（**导出可测**：主进程自检直接断言这段 HTML，
 * 不需要真的起 Electron 截图就能核对排版/字段/缺图策略）。
 */
export function buildStatExportHtml(
  list: StatList,
  entries: StatEntry[],
  opts: StatExportOptions,
  width: number,
  covers: Record<string, string>
): string {
  const fields = opts.fields.length > 0 ? opts.fields : STAT_EXPORT_DEFAULT_FIELDS
  const th: StatExportTheme = { ...DEFAULT_THEME, ...(opts.theme ?? {}) }
  const title = esc(list.name)
  const count = entries.length
  const date = new Date().toLocaleString('zh-CN')
  const photoScale = clampPhotoScale(opts.photoScale)
  const pw = Math.round(PHOTO_BASE_W * photoScale)
  const ph = Math.round(PHOTO_BASE_H * photoScale)

  const rows = entries
    .map((e) => {
      const r = buildRow(e, fields, opts, covers)
      const metaHtml = r.meta.length
        ? `<div class="meta">${r.meta
            .map((m) => `<span class="meta-item"><i>${esc(m.label)}</i>${m.value}</span>`)
            .join('')}</div>`
        : ''
      const tagsHtml = r.tags.length
        ? `<div class="tags">${r.tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>`
        : ''
      const rateHtml = r.rates.length
        ? `<div class="ratings">${r.rates
            .map((x) => `<span class="rate ${x.cls ?? ''}"><i>${esc(x.label)}</i><b>${esc(x.value)}</b></span>`)
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
        ${r.cover ? `<img class="cover" src="${r.cover}" onerror="this.style.display='none'">` : ''}
        <div class="main">
          <div class="name">${r.name}</div>
          ${r.nameOrig ? `<div class="name-orig">${r.nameOrig}</div>` : ''}
          ${metaHtml}
          ${tagsHtml}
          ${photosHtml}
        </div>
        ${rateHtml}
        ${textHtml}
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
    background: ${th.bg};
    color: ${th.text};
    font-family: 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
    padding: ${24 * S}px ${30 * S}px ${28 * S}px;
  }
  .head { border-bottom: ${2 * S}px solid ${th.accent}; padding-bottom: ${12 * S}px; margin-bottom: ${16 * S}px; }
  .title { font-size: ${22 * S}px; font-weight: 700; color: ${th.text}; }
  .sub { margin-top: ${6 * S}px; font-size: ${12 * S}px; color: ${th.faint}; }
  /*
   * 条目：与界面列表条目同一套排版 ——
   * [序号 76] [封面 62×85] [信息列 flex:1] [评分区 右对齐等宽数字] [评价列 280 左边框]
   */
  .row {
    display: flex; gap: ${18 * S}px; align-items: flex-start;
    background: ${th.elev1}; border: ${1 * S}px solid ${th.border}; border-radius: ${14 * S}px;
    padding: ${14 * S}px ${16 * S}px; margin-bottom: ${12 * S}px; page-break-inside: avoid;
  }
  .seq {
    flex: 0 0 ${74 * S}px; text-align: center; font-family: 'Consolas', 'Cascadia Mono', monospace;
    font-size: ${17 * S}px; font-weight: 700; color: ${th.accent}; padding-top: ${3 * S}px;
    font-variant-numeric: tabular-nums; word-break: break-all;
  }
  .cover { flex: 0 0 auto; width: ${COVER_W * S}px; height: ${COVER_H * S}px; object-fit: cover; border-radius: ${6 * S}px; }
  .main { flex: 1 1 auto; min-width: 0; }
  .name { font-size: ${15 * S}px; font-weight: 600; line-height: 1.45; word-break: break-word; }
  .name-orig { font-size: ${12 * S}px; color: ${th.dim}; margin-top: ${2 * S}px; word-break: break-word; }
  .meta { margin-top: ${6 * S}px; font-size: ${12 * S}px; color: ${th.dim}; }
  .meta-item { margin-right: ${14 * S}px; white-space: nowrap; }
  .meta-item i { font-style: normal; color: ${th.faint}; margin-right: ${4 * S}px; }
  .tags { display: flex; flex-wrap: wrap; gap: ${6 * S}px; margin-top: ${7 * S}px; }
  .tag {
    font-size: ${11 * S}px; color: ${th.dim}; background: ${th.elev2};
    border: ${1 * S}px solid ${th.border}; border-radius: ${999 * S}px; padding: ${2 * S}px ${9 * S}px; white-space: nowrap;
  }
  .ratings { flex: 0 0 auto; display: flex; align-items: flex-end; gap: ${18 * S}px; padding-top: ${2 * S}px; }
  .rate { display: flex; flex-direction: column; align-items: flex-end; gap: ${3 * S}px; }
  .rate i { font-style: normal; font-size: ${10 * S}px; line-height: 1; color: ${th.faint}; white-space: nowrap; }
  .rate b { font-size: ${15 * S}px; font-weight: 600; line-height: 1; color: ${th.text}; font-variant-numeric: tabular-nums; }
  .rate-person b { color: ${th.warn}; }
  .rate-bgm b { color: ${th.accent}; }
  .dev-plus b { color: ${th.ok}; }
  .dev-minus b { color: ${th.danger}; }
  .texts {
    flex: 0 0 ${TEXT_COL_W * S}px; border-left: ${1 * S}px solid ${th.border}; padding-left: ${16 * S}px;
  }
  .text { margin-bottom: ${8 * S}px; }
  .text-label { display: block; font-size: ${10 * S}px; color: ${th.faint}; margin-bottom: ${2 * S}px; }
  .text-body {
    display: block; font-size: ${11.5 * S}px; line-height: 1.7; color: ${th.dim};
    word-break: break-word; white-space: pre-wrap;
  }
  .photos { display: flex; flex-wrap: wrap; gap: ${8 * S}px; margin-top: ${9 * S}px; }
  .photo { width: ${pw * S}px; height: ${ph * S}px; object-fit: cover; border-radius: ${8 * S}px; border: ${1 * S}px solid ${th.border}; }
  .foot { margin-top: ${18 * S}px; padding-top: ${10 * S}px; border-top: ${1 * S}px solid ${th.border}; font-size: ${11 * S}px; color: ${th.faint}; text-align: center; }
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

/** 封面取图的重试次数（用户要求「失败的封面至少重试一次」= 1 次重试、共 2 次尝试） */
export const COVER_ATTEMPTS = 2
/** 封面预取的并发批大小（每批结束才进入下一批，控制峰值内存） */
const COVER_BATCH = 6

/** 一次导出里封面的取图结果（用来向用户明确报告「还有几张没取到」） */
export interface CoverFetchReport {
  /** 有封面地址、需要预取的张数 */
  total: number
  /** 预取成功的张数 */
  ok: number
  /** 重试后仍失败的（条目名 + 原因）——导出图里这些位置是空的 */
  missing: { name: string; url: string; reason: string }[]
  /** 条目本身就没有封面地址（不算失败，只在报告里区分开） */
  noCover: number
}

/**
 * 预取封面：远程地址 → data URL，**失败自动重试**。
 *
 * 为什么由主进程做、而不是让 offscreen 页面自己去拉远程图（v0.2 的做法，也就是"封面没导入"的根因）：
 * 1. 页面里的 `<img src="远程地址">` 什么时候加载完是不可控的，过去只等固定 1.5 秒，
 *    慢一点的图就永远没画上去；换成 data URL 后是"字节已经在手里"，截图前再显式等一次 `img.complete` 就稳了；
 * 2. 重试没有地方挂：`<img>` 加载失败只会触发一次 `onerror`，页面里再重试既看不见也统计不到；
 * 3. 取图链路（反代改写、UA/Referer、磁盘缓存、并发闸门）本来就在主进程（`media.imageDataUrl`），
 *    复用它等于第二次导出直接吃缓存。
 *
 * 分批（每批 COVER_BATCH 张）是为了不让几十张大图的 base64 同时驻留内存 ——
 * 与角色立绘导出（CharacterGridPage.exportPng）同一个取舍。
 *
 * `fetchOne` 可注入是为了自检：Node 里跑真实逻辑、不联网。
 */
export async function prefetchCovers(
  entries: StatEntry[],
  fetchOne: (url: string) => Promise<{ dataUrl: string; error?: string }> = imageDataUrl,
  attempts: number = COVER_ATTEMPTS
): Promise<{ map: Record<string, string>; report: CoverFetchReport }> {
  const map: Record<string, string> = {}
  const report: CoverFetchReport = { total: 0, ok: 0, missing: [], noCover: 0 }

  const fetchEntry = async (e: StatEntry): Promise<void> => {
    const url = String(e.cover ?? '').trim()
    const label = e.nameCn || e.name || e.seq
    if (!url) {
      report.noCover += 1
      return
    }
    // 本地路径 / 已经是 data URL 的：不需要联网，直接内联
    if (!/^https?:\/\//i.test(url)) {
      const inline = imgSrc(url)
      if (inline) {
        map[e.id] = inline
        report.ok += 1
      } else {
        report.missing.push({ name: label, url: url.slice(0, 120), reason: '本地封面文件不存在' })
      }
      return
    }
    report.total += 1
    let lastError = ''
    for (let i = 0; i < Math.max(1, attempts); i += 1) {
      try {
        const r = await fetchOne(url)
        if (r?.dataUrl) {
          map[e.id] = r.dataUrl
          report.ok += 1
          return
        }
        lastError = r?.error || '取图返回空'
      } catch (err) {
        lastError = String((err as Error)?.message ?? err)
      }
    }
    report.missing.push({ name: label, url: url.slice(0, 120), reason: lastError || '未知原因' })
  }

  for (let i = 0; i < entries.length; i += COVER_BATCH) {
    await Promise.all(entries.slice(i, i + COVER_BATCH).map(fetchEntry))
  }
  return { map, report }
}

/**
 * 在隐藏 offscreen 窗口中渲染 HTML 并截图返回 PNG Buffer（2 倍分辨率）。
 *
 * `covers` 已经把封面换成 data URL，所以这里只需要：
 * 等字体/布局稳定 → **显式等所有图片 load/error** → 按内容高度设窗口 → 截图。
 */
async function renderStatHtml(
  html: string,
  width: number,
  waitImages = true
): Promise<Buffer> {
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
    // 等一帧排版与字体就绪（封面/剧照已经是 data URL，不再依赖网络）
    await new Promise((r) => setTimeout(r, 600))
    if (waitImages) {
      /*
       * 显式等所有图片就绪：`img.complete` 为真的直接过，
       * 其余等 load/error，单个最多 4 秒 —— 这一步就是为了不再出现"部分封面没画上去"。
       */
      await w.webContents.executeJavaScript(`(async () => {
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
    }
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
  // 排序与界面**完全同源**（shared/statSeq.compareStatOrder：拖动出来的 order 优先）
  const entries = (data.entries ?? []).filter((e) => e.listId === listId).sort(compareStatOrder)

  const options: StatExportOptions = {
    fields: Array.isArray(opts?.fields) && opts.fields.length > 0 ? opts.fields : STAT_EXPORT_DEFAULT_FIELDS,
    widthScale: opts?.widthScale,
    photoScale: opts?.photoScale,
    showBgmRating: opts?.showBgmRating === true,
    theme: opts?.theme
  }
  const width = computeExportWidth(options.fields, options)

  // 封面先在主进程取好（带重试），再交给 offscreen 页面画 —— 这就是「封面没导入」的修复点
  const { map: covers, report } = await prefetchCovers(entries)
  const png = await renderStatHtml(buildStatExportHtml(list, entries, options, width, covers), width)

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
    `列表已导出为图片: ${r.filePath}（宽 ${width}px，勾选 ${options.fields.length} 个字段，封面 ${report.ok}/${report.total} 取到，缺 ${report.missing.length}）`
  )
  /*
   * 缺图**必须明确告诉用户**（用户原话「有时候会出现部分番剧的封面没导入」）。
   *
   * 为什么用系统消息框而不是界面 toast：导出动作在写盘之后才算结束，
   * 这时渲染层只拿到一个路径字符串，没法再传"缺了几张"；主进程直接弹框最直接，
   * 也让用户能在保存位置旁边看到具体是哪几条。
   */
  if (report.missing.length > 0) {
    const names = report.missing.slice(0, 8).map((m) => `· ${m.name}（${m.reason}）`).join('\n')
    const more = report.missing.length > 8 ? `\n…另有 ${report.missing.length - 8} 条` : ''
    await dialog.showMessageBox(win, {
      type: 'warning',
      title: '导出完成，但有封面没取到',
      message: `有 ${report.missing.length} 张封面尝试 ${COVER_ATTEMPTS} 次后仍没取到，图片里这些位置是空的。`,
      detail: `${names}${more}\n\n图片已保存到：${r.filePath}\n可以稍后重新导出（第二遍通常能命中磁盘缓存）。`,
      buttons: ['知道了']
    })
  }
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
        watchedAt: '2024-03-02',
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
    const png = await renderStatHtml(buildStatExportHtml(list, entries, options, width, {}), width)
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

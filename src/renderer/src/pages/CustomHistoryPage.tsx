import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, CalendarDays, Download, History, Info, Pin, Search, Trash2 } from 'lucide-react'
import type { SearchResultItem, SeasonItem } from '@shared/types'
import { monthsOfSeason, seasonLabel, seasonOfDate, SEASON_NAMES, type SeasonIndex } from '@shared/season'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { Badge, Button, EmptyState, Input, Modal, Select, Spinner } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import {
  airYearOf,
  coverFields,
  groupByYear,
  HISTORY_MODE_NAMES,
  itemsOfYear,
  MAX_PER_YEAR,
  mismatchMessage,
  missingYearMessage,
  seasonTextOf,
  selectableYears,
  SIMPLE_LIMIT,
  DETAIL_LIMIT,
  useCustomHistory,
  visibleItems,
  yearCheck,
  type CustomHistoryInput,
  type CustomHistoryItem,
  type CustomHistoryYearGroup,
  type HistoryMode
} from '@/stores/customHistory'

/**
 * 自建历史表（工具页入口 /tools/custom-history，独立小窗口里打开）。
 *
 * 用户要的三件事：
 *   ① **选年份 → 选番剧**：年份范围 2005–今年，选中年份后按季度（冬/春/夏/秋，约定见 @shared/season）
 *      列出该季条目，点一部就加进那一年的表；也可以**搜索添加**（放送年份对不上时自动提示，让用户选）；
 *   ② **两种版式**：简易显示（窗口垂直中间一条横向年份轴，每部只画封面 + 名字，交替摆在轴两侧）
 *      与清晰显示（窗口左侧纵向年份轴，右侧全是番剧卡片，每年最多 10 部）；
 *   ③ **导出 PNG**：导出时另选版式，canvas 手工绘制 + 2/3 倍缩放（不截屏 DOM）。
 *
 * 数据只有一份（见 stores/customHistory.ts），两种版式只是渲染方式不同；
 * 上限、年份判定、分组、季节文案全部来自那个 store 的纯函数，本页只负责画。
 */

// ------------------------------------------------------------------
// 导出：画布布局与绘制
// ------------------------------------------------------------------

/**
 * 导出用的样式常量。
 *
 * 视觉上刻意**贴着「最XX的角色 9宫格」的导出图**（浅底 + 白卡 + 圆角 + 页脚写来源与导出时间）：
 * 同一个应用里两张导出图长得完全两样，用户拼在一起发出去会很怪。
 */
const EX = {
  FONT: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif',
  /** 版心与分栏 */
  OUTER: 30,
  HEAD_H: 108,
  FOOT_H: 54,
  GAP: 18,
  /** 清晰显示里一年与一年之间的间隔 */
  BLOCK_GAP: 30,
  /** 简易显示里番剧块离横轴的距离（要躲开骑在轴上的年份胶囊：胶囊半高 15） */
  AXIS_GAP: 32,
  /** 年份胶囊/竖轴刻度的那一块高度（简易显示的内容高度里要给它留位置） */
  AXIS_H: 46,
  COVER_R: 8,
  CARD_R: 10,
  BG: '#f5f6fa',
  INK: '#23262e',
  DIM: '#8a90a0',
  FAINT: '#a6abb8',
  LINE: '#e6e8f0',
  AXIS: '#cfd4e2',
  CARD: '#ffffff',
  PLACEHOLDER: '#e9ebf2',
  ACCENT: '#4756c4',
  ACCENT_SOFT: '#eef0fe'
}

/** 导出的清晰度档位（用户要求「注意清晰度」：画布按倍数放大，导出图的实际像素就是这个倍数的宽度） */
const EXPORT_SCALES = [2, 3] as const

/**
 * 画布单边像素上限。
 * PNG 编码 + base64 取图都在主线程上跑，单边上万像素的图会让界面卡住好几秒
 * （用户看到的是「点了导出没反应」），所以宁可把倍数降一点也要保住交互。
 */
const MAX_CANVAS_SIDE = 8000

/** 一张封面要画到画布上的哪个矩形（图先经主进程转 data URL，再由 paintCovers 画进去） */
interface CoverGeo {
  /** 候选地址链（large → common → …，第一个取不到就试下一个） */
  candidates: string[]
  rect: { x: number; y: number; w: number; h: number }
  /** 圆角（简易显示的封面与清晰显示的卡片圆角不同，跟着卡片走） */
  radius: number
}

/** 简易显示的几何（画布逻辑尺寸 + 横轴位置 + 每一列的中心 x） */
interface SimpleLayout {
  w: number
  h: number
  /** 横向年份轴的 y —— 正好落在内容区的垂直中间 */
  axisY: number
  /** 每个年份列的中心 x */
  centers: number[]
  coverW: number
  coverH: number
  itemH: number
  maxSide: number
}

/** 清晰显示的几何（竖轴 x + 每个年份块的顶部 y 与行数） */
interface DetailLayout {
  w: number
  h: number
  /** 纵向年份轴的 x */
  axisX: number
  cardW: number
  cardH: number
  coverH: number
  cols: number
  blocks: { year: number; top: number; rows: number }[]
}

/** 封面按 2:3 附近的比例画（Bangumi 封面实际是 200×300 / 400×600，实测比例 1.42 上下） */
const COVER_RATIO = 1.42

/**
 * 简易显示的布局。
 *
 * 关键点：**横轴在垂直中间**这件事是算出来的，不是摆出来的 ——
 * 上下两侧各留 `sideH` 高（两者相等），年份胶囊那一块居中放在中间，
 * 所以 axisY 恒等于「内容区中点」，加多少部番剧都不会让轴跑偏。
 * 年份列宽固定，画布宽度取「内容宽」与「最小宽度 960」的较大者，
 * 于是只有一两年时整行会**居中**，不会全部挤在左边。
 */
function simpleLayout(groups: CustomHistoryYearGroup[]): SimpleLayout {
  const coverW = 108
  const coverH = Math.round(coverW * COVER_RATIO)
  const nameH = 46
  const itemH = coverH + nameH
  const colW = coverW + 48
  // 每一侧最多摆几部：简易显示每年最多 4 部 → 偶数序号在上、奇数序号在下，各最多 2 部
  const maxSide = Math.max(
    1,
    ...groups.map((g) => Math.ceil(visibleItems(g.items, 'simple').length / 2))
  )
  const sideH = maxSide * itemH + (maxSide - 1) * EX.GAP
  const contentH = sideH * 2 + EX.AXIS_H
  const contentW = Math.max(900, groups.length * colW)
  const w = contentW + EX.OUTER * 2
  const h = EX.HEAD_H + EX.OUTER + contentH + EX.OUTER + EX.FOOT_H
  const bodyTop = EX.HEAD_H + EX.OUTER
  const firstCenter = EX.OUTER + (contentW - groups.length * colW) / 2 + colW / 2
  return {
    w,
    h,
    axisY: bodyTop + sideH + EX.AXIS_H / 2,
    centers: groups.map((_, i) => firstCenter + i * colW),
    coverW,
    coverH,
    itemH,
    maxSide
  }
}

/**
 * 清晰显示的布局。
 *
 * 左侧那一条是年份竖轴（宽度固定），中间与右侧全是卡片网格；
 * 每行 5 张、每年最多 10 部 → 一行或两行，块与块之间留 BLOCK_GAP。
 * 年份块的高度各不相同（5 部只有一行），所以竖轴刻度按每个块的实际顶部往下排。
 */
function detailLayout(groups: CustomHistoryYearGroup[]): DetailLayout {
  const cardW = 136
  const coverH = Math.round(cardW * COVER_RATIO)
  const nameH = 64
  const cardH = coverH + nameH
  const cols = 5
  const axisW = 132
  const gridW = cols * cardW + (cols - 1) * EX.GAP
  const w = EX.OUTER + axisW + EX.GAP + gridW + EX.OUTER
  const bodyTop = EX.HEAD_H + EX.OUTER
  const blocks: DetailLayout['blocks'] = []
  let y = bodyTop
  for (const g of groups) {
    const count = visibleItems(g.items, 'detail').length
    const rows = Math.max(1, Math.ceil(count / cols))
    blocks.push({ year: g.year, top: y, rows })
    y += rows * cardH + (rows - 1) * EX.GAP + EX.BLOCK_GAP
  }
  // 最后一个块后面不留 BLOCK_GAP，否则页脚会离得很远
  const h = Math.max(bodyTop + 200, y - EX.BLOCK_GAP) + EX.OUTER + EX.FOOT_H
  return { w, h, axisX: EX.OUTER + axisW, cardW, cardH, coverH, cols, blocks }
}

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 单行截断：超宽就退字符加省略号（标题被硬切一半比省略号更难看） */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  const s = String(text ?? '')
  if (ctx.measureText(s).width <= maxW) return s
  let t = s
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1)
  return `${t}…`
}

/**
 * 折行（最多 maxLines 行，放不下就在最后一行加省略号）。
 * 番剧名长短差异极大（「进击的巨人」vs「魔法少女まどか☆マギカ」），
 * 单行截断会把长名字砍成两三个字，两行才够用。
 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const s = String(text ?? '').trim()
  if (!s) return []
  const lines: string[] = []
  let cur = ''
  /** 行数用满后还有字符没排 → 最后一行要加省略号 */
  let overflowed = false
  for (const ch of s) {
    if (cur.length > 0 && ctx.measureText(cur + ch).width > maxW) {
      lines.push(cur)
      cur = ch
      if (lines.length === maxLines) {
        overflowed = true
        break
      }
      continue
    }
    cur += ch
  }
  if (overflowed) {
    // cur 是放不下的那个字：把它连同省略号接在最后一行后面，再由 fitText 收到放得下为止
    lines[maxLines - 1] = fitText(ctx, `${lines[maxLines - 1]}${cur}…`, maxW)
  } else if (cur) {
    lines.push(cur)
  }
  return lines.slice(0, maxLines)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('封面解码失败'))
    img.src = src
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 返回空'))), 'image/png')
    } catch (err) {
      // 画布被污染时 toBlob 会抛 SecurityError —— 本页封面走 data URL，正常不该走到这里
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 15000)
}

/**
 * 按 cover 方式把封面画进目标矩形（等比放大到**铺满**目标框，多出来的部分居中裁掉）。
 * 与界面上的 CoverImage（object-cover）是同一套语义 —— 预览看到什么，导出图就是什么。
 */
function drawCoverCrop(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  if (!iw || !ih) return
  const s = Math.max(w / iw, h / ih)
  const dw = iw * s
  const dh = ih * s
  ctx.save()
  rrect(ctx, x, y, w, h, r)
  ctx.clip()
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
  ctx.restore()
}

/** 条目的展示名：中文名优先（与全站其它列表一致） */
function displayName(it: { nameCn: string; name: string }): string {
  return it.nameCn || it.name
}

/** 导出时这一条要试的封面地址链（老数据只有 cover 也不至于整格空白） */
function coverListOf(it: CustomHistoryItem): string[] {
  return it.covers.length > 0 ? it.covers : it.cover ? [it.cover] : []
}

/** 顶部标题栏 + 分隔线（简易/清晰共用） */
function drawHeader(
  ctx: CanvasRenderingContext2D,
  w: number,
  mode: HistoryMode,
  groups: CustomHistoryYearGroup[]
): number {
  const total = groups.reduce((s, g) => s + visibleItems(g.items, mode).length, 0)
  ctx.textAlign = 'left'
  ctx.fillStyle = EX.INK
  ctx.font = `700 30px ${EX.FONT}`
  ctx.fillText('自建历史表', EX.OUTER, 52)

  ctx.fillStyle = EX.DIM
  ctx.font = `14px ${EX.FONT}`
  /*
   * 副标题写清「这是哪种版式 + 一共几个年份多少部」：
   * 两种版式的导出图长得完全不同，用户手上同时有文件时必须一眼分得出来。
   */
  ctx.fillText(`${HISTORY_MODE_NAMES[mode]} · ${groups.length} 个年份 · 共 ${total} 部番剧`, EX.OUTER, 80)

  // 右上角胶囊：把「这一版式每年最多几部」写在图上，和界面里的上限说明是同一句话
  const pill = mode === 'simple' ? `每年展示前 ${SIMPLE_LIMIT} 部` : `每年最多 ${DETAIL_LIMIT} 部`
  ctx.font = `600 15px ${EX.FONT}`
  const pw = ctx.measureText(pill).width + 26
  ctx.fillStyle = EX.ACCENT_SOFT
  rrect(ctx, w - EX.OUTER - pw, 26, pw, 32, 8)
  ctx.fill()
  ctx.fillStyle = EX.ACCENT
  ctx.fillText(pill, w - EX.OUTER - pw + 13, 47)

  ctx.strokeStyle = EX.LINE
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(EX.OUTER, EX.HEAD_H - 10)
  ctx.lineTo(w - EX.OUTER, EX.HEAD_H - 10)
  ctx.stroke()
  return total
}

/** 页脚：数据来源 + 导出时间（来源必须照实写，图上写错来源比不写还糟） */
function drawFooter(ctx: CanvasRenderingContext2D, layout: { w: number; h: number }, mode: HistoryMode, total: number): void {
  const y = layout.h - 22
  ctx.textAlign = 'left'
  ctx.fillStyle = EX.FAINT
  ctx.font = `12px ${EX.FONT}`
  ctx.fillText(`番剧封面与数据来自 Bangumi（bgm.tv） · ${HISTORY_MODE_NAMES[mode]} · 共 ${total} 部`, EX.OUTER, y)
  const d = new Date()
  const p = (n: number): string => (n < 10 ? '0' : '') + n
  ctx.textAlign = 'right'
  ctx.fillText(`导出时间 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`, layout.w - EX.OUTER, y)
}

/**
 * 简易显示的主体：一条贯穿内容区的横向年份轴 + 每个年份一个胶囊 + 番剧交替摆在轴的上下两侧。
 * 上侧画偶数序号（0、2…）、下侧画奇数序号（1、3…），各自离轴越近序号越小 ——
 * 于是「最有代表性的第一部」永远紧贴年份，视线从轴往外读就是用户的排序。
 */
function drawSimpleBody(ctx: CanvasRenderingContext2D, groups: CustomHistoryYearGroup[], L: SimpleLayout): CoverGeo[] {
  const geo: CoverGeo[] = []

  // 横轴本体：两端各留出半条版心的空白，避免线头贴到画布边缘
  ctx.strokeStyle = EX.AXIS
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(EX.OUTER * 0.4, L.axisY)
  ctx.lineTo(L.w - EX.OUTER * 0.4, L.axisY)
  ctx.stroke()

  groups.forEach((g, gi) => {
    const cx = L.centers[gi]
    const shown = visibleItems(g.items, 'simple')

    // 年份胶囊（骑在横轴上）：先画，番剧块在它两侧、不会压到它
    ctx.font = `600 16px ${EX.FONT}`
    const label = String(g.year)
    const pw = ctx.measureText(label).width + 34
    ctx.fillStyle = EX.CARD
    rrect(ctx, cx - pw / 2, L.axisY - 15, pw, 30, 15)
    ctx.fill()
    ctx.strokeStyle = EX.ACCENT
    ctx.lineWidth = 1.5
    rrect(ctx, cx - pw / 2, L.axisY - 15, pw, 30, 15)
    ctx.stroke()
    ctx.fillStyle = EX.ACCENT
    ctx.textAlign = 'center'
    ctx.fillText(label, cx, L.axisY + 6)

    shown.forEach((it, i) => {
      const above = i % 2 === 0
      const slot = Math.floor(i / 2)
      const y = above
        ? L.axisY - EX.AXIS_GAP - slot * (L.itemH + EX.GAP) - L.itemH
        : L.axisY + EX.AXIS_GAP + slot * (L.itemH + EX.GAP)
      const x = cx - L.coverW / 2

      // 封面底块：取不到图时留它，整张导出图不会因此失败（与 9 宫格的降级做法一致）
      ctx.fillStyle = EX.PLACEHOLDER
      rrect(ctx, x, y, L.coverW, L.coverH, EX.COVER_R)
      ctx.fill()
      geo.push({ candidates: coverListOf(it), rect: { x, y, w: L.coverW, h: L.coverH }, radius: EX.COVER_R })

      // 名字（只画封面 + 名字，没有评分/集数 —— 简易显示的要求）
      ctx.textAlign = 'center'
      ctx.fillStyle = EX.INK
      ctx.font = `600 13px ${EX.FONT}`
      const lines = wrapText(ctx, displayName(it), L.coverW + 16, 2)
      lines.forEach((ln, li) => ctx.fillText(ln, cx, y + L.coverH + 20 + li * 17))
    })
  })
  return geo
}

/** 清晰显示的主体：左侧年份竖轴 + 右侧卡片网格 */
function drawDetailBody(ctx: CanvasRenderingContext2D, groups: CustomHistoryYearGroup[], L: DetailLayout): CoverGeo[] {
  const geo: CoverGeo[] = []
  const gridX = L.axisX + 30

  // 竖轴本体（贯穿所有年份块）
  ctx.strokeStyle = EX.AXIS
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(L.axisX, EX.HEAD_H + EX.OUTER - 8)
  ctx.lineTo(L.axisX, L.h - EX.OUTER - EX.FOOT_H + 8)
  ctx.stroke()

  groups.forEach((g, gi) => {
    const block = L.blocks[gi]
    if (!block) return
    const shown = visibleItems(g.items, 'detail')
    const markY = block.top + 22

    // 刻度：一个圆点 + 一小段横线，年份文字写在竖轴左侧（竖轴在窗口左侧，文字靠右对齐更整齐）
    ctx.fillStyle = EX.ACCENT
    ctx.beginPath()
    ctx.arc(L.axisX, markY, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = EX.ACCENT
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(L.axisX, markY)
    ctx.lineTo(L.axisX + 16, markY)
    ctx.stroke()

    ctx.textAlign = 'right'
    ctx.fillStyle = EX.INK
    ctx.font = `700 20px ${EX.FONT}`
    ctx.fillText(`${g.year}`, L.axisX - 18, markY + 7)
    ctx.fillStyle = EX.FAINT
    ctx.font = `12px ${EX.FONT}`
    ctx.fillText(`${shown.length} 部`, L.axisX - 18, markY + 26)

    shown.forEach((it, i) => {
      const col = i % L.cols
      const row = Math.floor(i / L.cols)
      const x = gridX + col * (L.cardW + EX.GAP)
      const y = block.top + row * (L.cardH + EX.GAP)

      // 卡片底
      ctx.save()
      ctx.shadowColor = 'rgba(24,30,55,.07)'
      ctx.shadowBlur = 8
      ctx.shadowOffsetY = 2
      ctx.fillStyle = EX.CARD
      rrect(ctx, x, y, L.cardW, L.cardH, EX.CARD_R)
      ctx.fill()
      ctx.restore()
      ctx.strokeStyle = EX.LINE
      ctx.lineWidth = 1
      rrect(ctx, x + 0.5, y + 0.5, L.cardW - 1, L.cardH - 1, EX.CARD_R)
      ctx.stroke()

      // 封面区
      ctx.fillStyle = EX.PLACEHOLDER
      rrect(ctx, x, y, L.cardW, L.coverH, EX.COVER_R)
      ctx.fill()
      geo.push({ candidates: coverListOf(it), rect: { x, y, w: L.cardW, h: L.coverH }, radius: EX.COVER_R })

      // 名字（最多两行）+ 次要信息（年份/季度 + 评分）—— 清晰显示允许带次要信息
      const cx = x + L.cardW / 2
      ctx.textAlign = 'center'
      ctx.fillStyle = EX.INK
      ctx.font = `600 13px ${EX.FONT}`
      const lines = wrapText(ctx, displayName(it), L.cardW - 16, 2)
      lines.forEach((ln, li) => ctx.fillText(ln, cx, y + L.coverH + 22 + li * 17))
      ctx.fillStyle = EX.FAINT
      ctx.font = `12px ${EX.FONT}`
      const meta = [seasonTextOf(it.airDate) || `${it.year} 年`, it.rating != null ? `★${it.rating.toFixed(1)}` : '']
        .filter((s) => s.length > 0)
        .join(' · ')
      ctx.fillText(fitText(ctx, meta, L.cardW - 16), cx, y + L.coverH + lines.length * 17 + 26)
    })
  })
  return geo
}

/**
 * 画一张导出图（底稿 + 收集封面矩形），返回画布与要贴的封面。
 * 封面**不在**这里画：底稿先出（不依赖网络，取图慢也一定能出图），
 * 再由 paintCovers 逐张贴上去。
 */
function drawSheet(
  mode: HistoryMode,
  groups: CustomHistoryYearGroup[],
  scale: number
): { canvas: HTMLCanvasElement; geo: CoverGeo[]; w: number; h: number } {
  const simple = mode === 'simple'
  const layout = simple ? simpleLayout(groups) : detailLayout(groups)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(layout.w * scale)
  canvas.height = Math.round(layout.h * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布上下文')
  ctx.scale(scale, scale)
  ctx.textBaseline = 'alphabetic'
  // 高倍缩放时插值质量决定封面锐不锐（默认 'low' 会让缩小的封面明显发虚）
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  ctx.fillStyle = EX.BG
  ctx.fillRect(0, 0, layout.w, layout.h)

  const total = drawHeader(ctx, layout.w, mode, groups)
  const geo = simple
    ? drawSimpleBody(ctx, groups, layout as SimpleLayout)
    : drawDetailBody(ctx, groups, layout as DetailLayout)
  drawFooter(ctx, layout, mode, total)
  return { canvas, geo, w: layout.w, h: layout.h }
}

/**
 * 把封面贴到画布上。
 *
 * 封面**必须**先经主进程 `imageDataUrl` 换成 data URL 再画：
 * 界面里的图是 `sakana-img://`（自定义协议 = 跨源），直接 drawImage 会污染画布，
 * 之后的 `toBlob()` 会抛 SecurityError；data URL 永不污染（与 9 宫格导出同一套做法）。
 * 分批（每批 4 张）是为了不让几十张大图同时驻留内存。
 */
async function paintCovers(ctx: CanvasRenderingContext2D, geo: CoverGeo[]): Promise<number> {
  let missing = 0
  const BATCH = 4
  for (let i = 0; i < geo.length; i += BATCH) {
    await Promise.all(
      geo.slice(i, i + BATCH).map(async (g) => {
        if (g.candidates.length === 0) {
          missing += 1
          return
        }
        for (const url of g.candidates) {
          const r = await api.bangumi.imageDataUrl(url)
          if (!r.ok || !r.data.dataUrl) continue
          try {
            const img = await loadImage(r.data.dataUrl)
            drawCoverCrop(ctx, img, g.rect.x, g.rect.y, g.rect.w, g.rect.h, g.radius)
            return
          } catch {
            // 这一档解不开就换小一档再试
          }
        }
        // 全部候选都拿不到：底稿里的占位色块留着，不因此让整张图导出失败
        missing += 1
      })
    )
  }
  return missing
}

/** 用户选了几倍就给几倍，但受单边像素上限约束（见 MAX_CANVAS_SIDE） */
function fitScale(w: number, h: number, want: number): number {
  const cap = Math.min(MAX_CANVAS_SIDE / Math.max(1, w), MAX_CANVAS_SIDE / Math.max(1, h))
  return Math.max(1, Math.min(want, Math.floor(cap * 100) / 100))
}

/** 完整导出一张图：底稿 → 贴封面 → toBlob */
async function exportSheet(
  mode: HistoryMode,
  groups: CustomHistoryYearGroup[],
  wantScale: number
): Promise<{ blob: Blob; width: number; height: number; missing: number; scale: number }> {
  const simple = mode === 'simple'
  const layout = simple ? simpleLayout(groups) : detailLayout(groups)
  const scale = fitScale(layout.w, layout.h, wantScale)
  const { canvas, geo } = drawSheet(mode, groups, scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布上下文')
  const missing = await paintCovers(ctx, geo)
  const blob = await canvasToBlob(canvas)
  return { blob, width: canvas.width, height: canvas.height, missing, scale }
}

/** 文件名：版式 + 时间（非法字符替换），一眼能看出是哪张图 */
function exportFilename(mode: HistoryMode): string {
  const d = new Date()
  const p = (n: number): string => (n < 10 ? '0' : '') + n
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
  return `自建历史表_${HISTORY_MODE_NAMES[mode]}_${stamp}.png`
}

// ------------------------------------------------------------------
// 页面
// ------------------------------------------------------------------

/** 季度番剧 / 搜索结果 → 落库需要的字段（只取渲染与导出要用的最小集合） */
function inputFromSeason(it: SeasonItem): CustomHistoryInput {
  const { cover, covers } = coverFields(it.images)
  return {
    subjectId: it.id,
    name: it.name,
    nameCn: it.name_cn,
    cover,
    covers,
    airDate: it.air_date,
    rating: it.rating?.score ?? null
  }
}

function inputFromSearch(it: SearchResultItem): CustomHistoryInput {
  const { cover, covers } = coverFields(it.images)
  return {
    subjectId: it.id,
    name: it.name,
    nameCn: it.name_cn,
    cover,
    covers,
    airDate: it.air_date,
    rating: it.rating?.score ?? null
  }
}

export function CustomHistoryPage() {
  const navigate = useNavigate()

  const items = useCustomHistory((s) => s.items)
  const loaded = useCustomHistory((s) => s.loaded)
  const load = useCustomHistory((s) => s.load)
  const addItem = useCustomHistory((s) => s.add)
  const removeItem = useCustomHistory((s) => s.remove)
  const promoteItem = useCustomHistory((s) => s.promote)
  const clearYear = useCustomHistory((s) => s.clearYear)

  useEffect(() => {
    void load()
  }, [load])

  /** 年份选项（2005 → 今年，倒序）；列表一年内不会变，只算一次 */
  const years = useMemo(() => selectableYears(), [])

  const [mode, setMode] = useState<HistoryMode>('simple')
  const [pickedYear, setPickedYear] = useState(() => new Date().getFullYear())
  const [pickedSeason, setPickedSeason] = useState<SeasonIndex>(() => seasonOfDate().season)

  const groups = useMemo(() => groupByYear(items), [items])
  const countOf = useCallback((year: number) => itemsOfYear(items, year).length, [items])
  const hasSubject = useCallback(
    (year: number, subjectId: number) => items.some((it) => it.year === year && it.subjectId === subjectId),
    [items]
  )

  // ---------------- 选年份 → 选季度 → 拉该季番剧 ----------------

  const [seasonItems, setSeasonItems] = useState<SeasonItem[]>([])
  const [seasonLoading, setSeasonLoading] = useState(false)
  const [seasonFromCache, setSeasonFromCache] = useState(false)

  useEffect(() => {
    let alive = true
    setSeasonLoading(true)
    /*
     * month 传该季度**任意一个月**即可：主进程会规范化到季度并按季度缓存 7 天
     * （见 shared/api.ts 的注释），这里取该季度的第一个月。
     */
    const month = monthsOfSeason(pickedSeason)[0]
    void api.bangumi
      .season(pickedYear, month)
      .then((r) => {
        if (!alive) return
        setSeasonLoading(false)
        if (!r.ok) {
          toast.error(r.error)
          setSeasonItems([])
          return
        }
        // 数据源整体报错时仍可能有（不完整的）条目，照常渲染并把原因说出来
        if (r.data.error) toast.warn(`季度数据源异常：${r.data.error.message}（显示的可能是不完整结果）`)
        setSeasonItems(r.data.items)
        setSeasonFromCache(r.data.fromCache === true)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setSeasonLoading(false)
        setSeasonItems([])
        toast.error(`获取季度番剧失败：${String(err)}`)
      })
    return () => {
      alive = false
    }
  }, [pickedYear, pickedSeason])

  // ---------------- 搜索添加 ----------------

  const [keyword, setKeyword] = useState('')
  const [searchItems, setSearchItems] = useState<SearchResultItem[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)

  async function runSearch(): Promise<void> {
    const k = keyword.trim()
    if (!k) {
      toast.warn('请输入关键词')
      return
    }
    setSearching(true)
    const r = await api.bangumi.search(k)
    setSearching(false)
    setSearched(true)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (r.data.error) toast.warn(`搜索异常：${r.data.error.message}`)
    setSearchItems(r.data.items)
  }

  // ---------------- 加入（含年份不一致的确认） ----------------

  /**
   * 年份对不上的确认框。
   * 用户明确要求「添加时对应的年份不对就自动提示」，所以这里**不替用户决定**：
   * 两种落点都合理（按放送年份归位 / 按自己看的年份归类），必须让他选一个。
   */
  const [pending, setPending] = useState<{ input: CustomHistoryInput; title: string; airYear: number } | null>(null)

  /** 真正落库 + 提示；季度列表、搜索、确认框三条路最后都走它 */
  const commitAdd = useCallback(
    (input: CustomHistoryInput, year: number, title: string) => {
      const r = addItem(input, year)
      if (!r.ok) {
        toast.warn(r.message)
        return
      }
      if (!r.simpleVisible) {
        /*
         * 简易显示只画前 SIMPLE_LIMIT 部（上限按两种版式的较大者存，见 store 文件头 ①），
         * 所以这件事必须说出来 —— 否则用户会觉得「加了怎么没出现」。
         */
        toast.warn(
          `已加入《${title}》，${year} 年现在有 ${r.count} 部；简易显示只画前 ${SIMPLE_LIMIT} 部，` +
            `这一部只在「清晰显示」里出现（可点封面右上角的置顶按钮把它提到前面）`
        )
      } else {
        toast.success(`已加入《${title}》，${year} 年现在有 ${r.count} 部`)
      }
    },
    [addItem]
  )

  /** 季度列表里点「加入」：条目本来就是按所选年份取的，不再问年份 */
  function addFromSeason(it: SeasonItem): void {
    commitAdd(inputFromSeason(it), pickedYear, it.name_cn || it.name)
  }

  /** 搜索结果点「加入」：放送年份和当前选中的年份不一致时先问用户 */
  function addFromSearch(it: SearchResultItem): void {
    const input = inputFromSearch(it)
    const title = it.name_cn || it.name
    const check = yearCheck(it.air_date, pickedYear)
    if (check.kind === 'missing') {
      // 缺放送日期 → 核对不了，但仍然允许加入（用户要求）
      toast.warn(`${missingYearMessage(title)}，已按当前选中的 ${pickedYear} 年加入`)
      commitAdd(input, pickedYear, title)
      return
    }
    if (check.kind === 'mismatch') {
      setPending({ input, title, airYear: check.airYear })
      return
    }
    commitAdd(input, pickedYear, title)
  }

  // ---------------- 导出 ----------------

  const [exportOpen, setExportOpen] = useState(false)
  /** 导出用哪种版式：**与屏幕上当前显示的无关**，用户每次都要在这里选 */
  const [exportMode, setExportMode] = useState<HistoryMode>('simple')
  const [exportScale, setExportScale] = useState<number>(2)
  const [exporting, setExporting] = useState(false)

  /** 导出弹窗里预告的尺寸：与真正画图用的是同一套布局函数，写多少就导出多少 */
  const exportPreview = useMemo(() => {
    if (groups.length === 0) return null
    const layout = exportMode === 'simple' ? simpleLayout(groups) : detailLayout(groups)
    const scale = fitScale(layout.w, layout.h, exportScale)
    return { w: Math.round(layout.w * scale), h: Math.round(layout.h * scale), scale }
  }, [groups, exportMode, exportScale])

  const runExport = useCallback(async () => {
    if (groups.length === 0) {
      toast.warn('还没有添加任何番剧，先在左边选年份加几部再导出')
      return
    }
    setExporting(true)
    try {
      const { blob, width, height, missing, scale } = await exportSheet(exportMode, groups, exportScale)
      downloadBlob(blob, exportFilename(exportMode))
      toast.success(
        `已导出「${HISTORY_MODE_NAMES[exportMode]}」PNG（${width}×${height}${scale < exportScale ? `，已按画布上限降到 ${scale} 倍` : ''}）` +
          (missing > 0 ? `；有 ${missing} 张封面取不到，已用占位色块代替` : '')
      )
      setExportOpen(false)
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      toast.error(`导出失败：${msg}`)
    } finally {
      setExporting(false)
    }
  }, [exportMode, exportScale, groups])

  // ---------------- 派生展示数据 ----------------

  const yearCount = countOf(pickedYear)
  const yearFull = yearCount >= MAX_PER_YEAR
  /** 简易显示里被「只画前 4 部」挡住的年份（提示条要用） */
  const overflowYears = useMemo(() => groups.filter((g) => g.items.length > SIMPLE_LIMIT), [groups])

  return (
    <div className="relative flex h-full min-h-0 flex-col px-4 py-3">
      {/* 顶部：标题 + 版式切换 + 导出 */}
      <div className="flex flex-wrap items-start gap-3">
        {api.window.isSmallWindow ? null : (
          <button
            onClick={() => navigate(-1)}
            className="mt-1 flex items-center gap-1.5 text-xs text-dim hover:text-text whitespace-nowrap"
          >
            <ArrowLeft size={14} /> 返回
          </button>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold">自建历史表</h1>
            <Badge tone="accent">工具</Badge>
          </div>
          <p className="mt-0.5 text-xs text-faint">
            选年份挑番剧（也可以搜索添加）→ 用简易 / 清晰两种版式查看 → 导出 PNG
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border p-0.5">
            {(['simple', 'detail'] as HistoryMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                title={
                  m === 'simple'
                    ? `横向年份轴在窗口中间，每个年份展示前 ${SIMPLE_LIMIT} 部（只画封面 + 名字）`
                    : `年份竖轴在窗口左侧，右侧全是番剧卡片，每个年份最多 ${DETAIL_LIMIT} 部`
                }
                className={`h-7 rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                  mode === m ? 'bg-accent text-white' : 'text-dim hover:text-text'
                }`}
              >
                {HISTORY_MODE_NAMES[m]}
              </button>
            ))}
          </div>
          <Button icon={Download} onClick={() => setExportOpen(true)}>
            导出 PNG
          </Button>
        </div>
      </div>

      {/* 简易显示的「只画前 4 部」说明：这件事必须让用户看得见（见 store 文件头 ①） */}
      {mode === 'simple' && overflowYears.length > 0 ? (
        <div className="mt-2 rounded-lg bg-accent-soft px-3 py-1.5 text-[11px] leading-relaxed text-accent">
          {overflowYears.map((g) => `${g.year} 年 ${g.items.length} 部`).join('，')}
          ：简易显示每个年份只画前 {SIMPLE_LIMIT} 部，其余在「清晰显示」里看；想换展示的那几部，
          点封面左上角的置顶按钮把它提到前面。
        </div>
      ) : null}

      <div className="mt-3 flex min-h-0 flex-1 gap-3">
        {/* ================= 左：选年份 → 选番剧 + 搜索添加 ================= */}
        <aside className="flex w-[336px] shrink-0 flex-col gap-2.5 overflow-y-auto rounded-xl border border-border bg-elev1/60 p-3">
          <div className="flex items-center gap-2">
            <CalendarDays size={15} className="shrink-0 text-accent" />
            <Select
              value={pickedYear}
              onChange={(e) => setPickedYear(Number(e.target.value))}
              className="h-8 flex-1 text-xs"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y} 年
                </option>
              ))}
            </Select>
            <Badge tone={yearFull ? 'warn' : 'neutral'}>
              {yearCount}/{MAX_PER_YEAR}
            </Badge>
          </div>

          {/* 四个季度（冬/春/夏/秋，与 @shared/season 的约定一致） */}
          <div className="flex gap-1">
            {SEASON_NAMES.map((name, i) => {
              const s = (i + 1) as SeasonIndex
              return (
                <button
                  key={name}
                  onClick={() => setPickedSeason(s)}
                  className={`h-7 flex-1 rounded-md text-xs font-medium transition-colors ${
                    pickedSeason === s ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
                  }`}
                >
                  {name}
                </button>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] text-faint">
            <span>{seasonLabel(pickedYear, pickedSeason)}</span>
            {seasonFromCache ? <span title="主进程按季度缓存了这份数据，没有联网">本地缓存</span> : null}
            {yearCount > 0 ? (
              <button
                className="text-faint underline transition-colors hover:text-danger"
                onClick={() => {
                  clearYear(pickedYear)
                  toast.info(`已清空 ${pickedYear} 年`)
                }}
              >
                清空这一年
              </button>
            ) : null}
          </div>

          {yearFull ? (
            <div className="rounded-lg bg-warn/15 px-3 py-1.5 text-[11px] leading-relaxed text-warn">
              {pickedYear} 年已经有 {MAX_PER_YEAR} 部（清晰显示的上限）。先删掉几部，或者把年份切到别的年份再加。
            </div>
          ) : null}

          {/* 该季度的番剧 */}
          {seasonLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-faint">
              <Spinner size={16} /> 正在获取 {seasonLabel(pickedYear, pickedSeason)}…
            </div>
          ) : seasonItems.length === 0 ? (
            <EmptyState icon={CalendarDays} title="这个季度没有取到条目" desc="换一个年份或季度再试；也可能是数据源临时不可用。" />
          ) : (
            <div className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto pr-1">
              {seasonItems.map((it) => {
                const added = hasSubject(pickedYear, it.id)
                return (
                  <div
                    key={it.id}
                    className="flex items-center gap-2 rounded-lg border border-border/70 bg-elev1 p-1.5"
                  >
                    <CoverImage src={coverFields(it.images).cover} className="h-12 w-9 shrink-0" rounded="rounded" />
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-[11px] font-medium leading-snug">{it.name_cn || it.name}</div>
                      <div className="mt-0.5 truncate text-[10px] text-faint">
                        {it.air_date ?? '放送时间未知'}
                        {it.rating?.score != null ? ` · ★${it.rating.score.toFixed(1)}` : ''}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={added ? 'ghost' : 'soft'}
                      disabled={added || yearFull}
                      onClick={() => addFromSeason(it)}
                    >
                      {added ? '已加' : yearFull ? '已满' : '加入'}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}

          {/* 搜索添加 */}
          <div className="mt-1 border-t border-border pt-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-dim">
              <Search size={13} /> 搜索添加
              <span className="text-[10px] font-normal text-faint">（年份对不上会先问你）</span>
            </div>
            <div className="flex gap-2">
              <Input
                value={keyword}
                placeholder="番剧名（中文 / 日文 / 英文）"
                className="h-8 flex-1 text-xs"
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch()
                }}
              />
              <Button size="sm" loading={searching} onClick={() => void runSearch()}>
                搜索
              </Button>
            </div>
            {searched && !searching && searchItems.length === 0 ? (
              <div className="mt-2 text-[11px] text-faint">没有搜到结果，换个关键词再试。</div>
            ) : null}
            {searchItems.length > 0 ? (
              <div className="mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
                {searchItems.map((it) => {
                  const added = hasSubject(pickedYear, it.id)
                  const airYear = airYearOf(it.air_date)
                  const mismatch = airYear !== null && airYear !== pickedYear
                  return (
                    <div key={it.id} className="flex items-center gap-2 rounded-lg border border-border/70 bg-elev1 p-1.5">
                      <CoverImage src={coverFields(it.images).cover} className="h-12 w-9 shrink-0" rounded="rounded" />
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 text-[11px] font-medium leading-snug">{it.name_cn || it.name}</div>
                        <div className="mt-0.5 truncate text-[10px]">
                          {it.air_date ? (
                            <span className={mismatch ? 'text-warn' : 'text-faint'}>
                              {it.air_date}
                              {mismatch ? `（${airYear} 年，与选中的年份不同）` : ''}
                            </span>
                          ) : (
                            <span className="text-faint">没有放送日期</span>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={added ? 'ghost' : 'soft'}
                        disabled={added}
                        onClick={() => addFromSearch(it)}
                      >
                        {added ? '已加' : '加入'}
                      </Button>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        </aside>

        {/* ================= 右：两种版式 ================= */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-elev1/40">
          {!loaded ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-xs text-faint">
              <Spinner size={16} /> 正在读取自建历史表…
            </div>
          ) : groups.length === 0 ? (
            <EmptyState
              icon={History}
              title="自建历史表还是空的"
              desc="在左边选一个年份，挑几部那个季度的番剧；也可以直接用搜索添加。两种显示共用同一份数据。"
            />
          ) : mode === 'simple' ? (
            <SimpleSheet groups={groups} onRemove={removeItem} onPromote={promoteItem} />
          ) : (
            <DetailSheet groups={groups} onRemove={removeItem} onPromote={promoteItem} />
          )}
        </main>
      </div>

      {/* 年份对不上的确认框（搜索结果才有） */}
      <Modal open={pending !== null} onClose={() => setPending(null)} title="放送年份不一致" width={440}>
        {pending ? (
          <>
            <p className="text-sm leading-relaxed text-dim">
              {mismatchMessage(pending.title, pending.airYear, pickedYear)}
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-faint">
              两种落点都合理：按「放送年份」归位（这张表按番剧开播的年份排），或者按「你选的年份」归类
              （比如你想按自己看的年份建表）。这里不替你决定。
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setPending(null)}>
                取消
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  commitAdd(pending.input, pickedYear, pending.title)
                  setPending(null)
                }}
              >
                仍加到 {pickedYear} 年
              </Button>
              <Button
                onClick={() => {
                  commitAdd(pending.input, pending.airYear, pending.title)
                  setPending(null)
                }}
              >
                改到 {pending.airYear} 年
              </Button>
            </div>
          </>
        ) : null}
      </Modal>

      {/* 导出：版式与清晰度都在这里选（**不**跟当前屏幕上的版式绑定） */}
      <Modal open={exportOpen} onClose={() => setExportOpen(false)} title="导出为图片" width={470}>
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 text-xs font-semibold text-dim">导出哪一种版式</div>
            <div className="flex gap-2">
              {(['simple', 'detail'] as HistoryMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setExportMode(m)}
                  className={`flex-1 rounded-xl border p-2.5 text-left transition-colors ${
                    exportMode === m ? 'border-accent bg-accent-soft' : 'border-border bg-elev1 hover:border-accent/50'
                  }`}
                >
                  <span className="block text-xs font-semibold">{HISTORY_MODE_NAMES[m]}</span>
                  <span className="mt-0.5 block text-[10px] leading-relaxed text-faint">
                    {m === 'simple'
                      ? `横向年份轴在中间，每年展示前 ${SIMPLE_LIMIT} 部（只有封面 + 名字）`
                      : `年份竖轴在左侧，卡片铺满右侧，每年最多 ${DETAIL_LIMIT} 部`}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold text-dim">清晰度（画布放大倍数）</div>
            <div className="flex gap-2">
              {EXPORT_SCALES.map((s) => (
                <button
                  key={s}
                  onClick={() => setExportScale(s)}
                  className={`h-8 flex-1 rounded-lg border text-xs font-medium transition-colors ${
                    exportScale === s ? 'border-accent bg-accent-soft text-accent' : 'border-border text-dim hover:text-text'
                  }`}
                >
                  {s} 倍{s === 2 ? '（推荐）' : '（超大图）'}
                </button>
              ))}
            </div>
            <div className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed text-faint">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>
                封面与文字都用 canvas 重画，导出图的**实际像素**就是界面尺寸乘以倍数
                {exportPreview ? `（当前选项：${exportPreview.w}×${exportPreview.h}）` : ''}，
                所以放大倍数越高越清晰、文件也越大。
              </span>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setExportOpen(false)}>
              取消
            </Button>
            <Button icon={Download} loading={exporting} onClick={() => void runExport()}>
              导出 PNG
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

/**
 * 简易显示单张卡片的高度（封面 142 + 名字最多两行 + 一点间距）。
 * 轴两侧各留多高是按它**算**出来的，而不是让内容撑开（见 SimpleSheet 的注释）。
 */
const SIMPLE_CARD_H = 176

/**
 * 简易显示：窗口垂直中间一条横向年份轴，每个年份的番剧交替摆在轴的上方与下方。
 *
 * 实现要点：整块内容是一个横向 flex，**每一列自己就是上下两半**（各占一半高度），
 * 年份胶囊放在两半之间 —— 于是「轴在垂直中间」是布局自然的结果，不管哪一列上下各摆 1 部还是 2 部，
 * 轴都不会跑偏（导出图里的算法是同一件事，见 simpleLayout）。
 *
 * 容器高度是**按最多的那一列算出来的**（不是撑开的）：如果让内容把列撑高，
 * 上下两半的高度就会被各自的内容决定，轴立刻偏到一边去 —— 这是这类"对称布局"最容易踩的坑。
 *
 * 番剧块只画**封面 + 名字**（用户要求）：不放评分、集数、放送日期。
 */
function SimpleSheet({
  groups,
  onRemove,
  onPromote
}: {
  groups: CustomHistoryYearGroup[]
  onRemove: (subjectId: number, year: number) => void
  onPromote: (subjectId: number, year: number) => void
}) {
  /** 每一侧最多摆几部（交错摆放：0、2… 在上，1、3… 在下） */
  const maxSide = Math.max(1, ...groups.map((g) => Math.ceil(visibleItems(g.items, 'simple').length / 2)))
  const sheetH = Math.max(460, maxSide * (SIMPLE_CARD_H + 10) * 2 + 30 + 44)
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="relative flex items-stretch px-4" style={{ height: sheetH }}>
        {/* 横轴本体：绝对定位在容器垂直中点，年份胶囊再盖在它上面 */}
        <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {groups.map((g) => {
          const shown = visibleItems(g.items, 'simple')
          const above = shown.filter((_, i) => i % 2 === 0)
          const below = shown.filter((_, i) => i % 2 === 1)
          return (
            <div key={g.year} className="relative flex w-[152px] shrink-0 flex-col items-center">
              {/*
                上侧：靠轴对齐（justify-end）。**倒着渲染**是为了让序号 0 紧贴横轴 ——
                与导出侧 simpleLayout 的算法（slot 0 离轴最近）保持一致，
                否则屏幕上和导出图里同一年的顺序正好相反。

                ⚠️ 这段说明必须写成「花括号包起来的块注释」：JSX 的子节点位置放**裸的**块注释
                不会被当成注释，React 会把它当**文本节点**渲染出来 ——
                用户看到的就是「简易显示里莫名多了一段注释」（v0.3.7 修）。
                （这条注释本身也踩过一次坑：注释正文里不能出现块注释的结束符，
                  否则注释会提前结束、后面的花括号就变成了非法的 JSX 字符。）
              */}
              <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-end gap-2.5 pb-3">
                {[...above].reverse().map((it) => (
                  <SimpleCard key={it.subjectId} item={it} onRemove={onRemove} onPromote={onPromote} />
                ))}
              </div>
              {/* 年份：骑在横轴上 */}
              <div className="z-10 flex h-[30px] shrink-0 items-center rounded-full border border-accent bg-elev1 px-3 text-xs font-semibold text-accent">
                {g.year}
              </div>
              {/* 下侧 */}
              <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2.5 pt-3">
                {below.map((it) => (
                  <SimpleCard key={it.subjectId} item={it} onRemove={onRemove} onPromote={onPromote} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 简易显示里的一部番剧：封面 + 名字（悬停时给出「置顶 / 删除」） */
function SimpleCard({
  item,
  onRemove,
  onPromote
}: {
  item: CustomHistoryItem
  onRemove: (subjectId: number, year: number) => void
  onPromote: (subjectId: number, year: number) => void
}) {
  return (
    <div className="flex w-full flex-col items-center">
      {/* 两个小动作挂在**封面自己**身上（不是整列），否则按钮会飘到列边缘、离封面很远 */}
      <div className="group relative h-[142px] w-[100px]">
        <CoverImage src={item.cover} className="h-full w-full" rounded="rounded-lg" />
        <CardActions item={item} onRemove={onRemove} onPromote={onPromote} />
      </div>
      <div className="mt-1 line-clamp-2 w-full px-1 text-center text-[11px] leading-tight">
        {displayName(item)}
      </div>
    </div>
  )
}

/**
 * 清晰显示：年份竖轴在窗口左侧（一条竖线 + 每个年份的刻度与年份文字），
 * 中间与右侧全是番剧卡片（封面 + 名字 + 年份/季度 + 评分）。
 */
function DetailSheet({
  groups,
  onRemove,
  onPromote
}: {
  groups: CustomHistoryYearGroup[]
  onRemove: (subjectId: number, year: number) => void
  onPromote: (subjectId: number, year: number) => void
}) {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {groups.map((g) => {
        const shown = visibleItems(g.items, 'detail')
        return (
          <div key={g.year} className="flex">
            {/* 左侧竖轴：每一行都带 border-r，竖着排下来就连成一条完整的轴 */}
            <div className="relative w-[96px] shrink-0 border-r border-border py-3 pr-3 text-right">
              <div className="sticky top-2">
                <div className="text-base font-bold">{g.year}</div>
                <div className="text-[10px] text-faint">{shown.length} 部</div>
              </div>
              {/* 刻度点 + 一小段横线，把年份和右侧卡片连起来 */}
              <div className="absolute right-0 top-[26px] flex items-center">
                <span className="h-px w-4 bg-accent" />
              </div>
              <span className="absolute -right-[4.5px] top-[23px] h-2 w-2 rounded-full bg-accent" />
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap gap-2.5 px-4 py-3">
              {shown.map((it) => (
                <DetailCard key={it.subjectId} item={it} onRemove={onRemove} onPromote={onPromote} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 清晰显示的卡片：封面 + 名字 + （年份/季度 · 评分） */
function DetailCard({
  item,
  onRemove,
  onPromote
}: {
  item: CustomHistoryItem
  onRemove: (subjectId: number, year: number) => void
  onPromote: (subjectId: number, year: number) => void
}) {
  const meta = [seasonTextOf(item.airDate) || `${item.year} 年`, item.rating != null ? `★${item.rating.toFixed(1)}` : '']
    .filter((s) => s.length > 0)
    .join(' · ')
  return (
    <div className="w-[124px]">
      <div className="group relative h-[176px] w-[124px]">
        <CoverImage src={item.cover} className="h-full w-full" rounded="rounded-lg" />
        <CardActions item={item} onRemove={onRemove} onPromote={onPromote} />
      </div>
      <div className="mt-1 line-clamp-2 text-[11px] font-medium leading-snug">{displayName(item)}</div>
      <div className="mt-0.5 truncate text-[10px] text-faint">{meta}</div>
    </div>
  )
}

/**
 * 卡片右上角的两个小动作（鼠标悬停才出现）。
 *
 * 为什么需要「置顶」：简易显示每个年份只画前 4 部，而用户要的是「自己挑最有代表性的 4 部」——
 * 顺序就是他表达这个选择的方式，没有置顶就只能靠删掉再重加来调顺序。
 */
function CardActions({
  item,
  onRemove,
  onPromote
}: {
  item: CustomHistoryItem
  onRemove: (subjectId: number, year: number) => void
  onPromote: (subjectId: number, year: number) => void
}) {
  return (
    <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <button
        title={`把《${displayName(item)}》提到 ${item.year} 年的第一位（简易显示只画前 ${SIMPLE_LIMIT} 部）`}
        onClick={() => onPromote(item.subjectId, item.year)}
        className="flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-white transition-colors hover:bg-accent"
      >
        <Pin size={12} />
      </button>
      <button
        title={`从 ${item.year} 年的自建历史表里删除`}
        onClick={() => {
          onRemove(item.subjectId, item.year)
          toast.info(`已从 ${item.year} 年移除《${displayName(item)}》`)
        }}
        className="flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-white transition-colors hover:bg-danger"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowLeftRight,
  Download,
  Eraser,
  ImageOff,
  Minus,
  Plus,
  RotateCcw,
  Search,
  X
} from 'lucide-react'
import type { CharacterItem, CoverImages, SearchResultItem } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { Badge, Button, IconButton, Input, Spinner } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'

/**
 * 最XX的角色 9宫格（工具页入口 /tools/character-grid）。
 *
 * 三件事：
 * ① 搜作品 → 拉角色（主进程 api.bangumi.characters：v0 优先 + 老接口兜底）；
 * ② 3×3 → 4×10 的格子编辑器（默认标签可改、新增格子自己写标签、清空/交换）；
 * ③ 导出 PNG：**没有「制作人」不给导出**，立绘一律经主进程转 data URL 再画。
 *
 * 远端数据（搜索/角色）全部走主进程数据源，本页只调用 api.bangumi.*，
 * 不直连任何镜像或反代地址（界面上也不出现任何反代/内网地址）。
 */

const MIN_COLS = 3
const MAX_COLS = 4
const MIN_ROWS = 3
const MAX_ROWS = 10
/** 默认 9 宫格标签（3×3 逐行填；超出的格子标签为空，必须用户自己写） */
const DEFAULT_LABELS = [
  '最喜欢',
  '最遗憾',
  '最神秘',
  '最鬼畜',
  '最可爱',
  '最智慧',
  '最不正经',
  '最神人',
  '最败犬'
]
const DEFAULT_TITLE = '最XX的角色 9宫格'
/** 持久化 key（本项目约定：渲染层本地缓存统一用 sakana- 前缀） */
const STORE_KEY = 'sakana-character-grid'
/** 当前选中的作品也单独存一份：刷新回来还能直接看到角色表（不用重新搜） */
const SUBJECT_KEY = 'sakana-character-grid-subject'

/** 格子里的角色：只保留可序列化的字段，直接进 localStorage */
interface CellChar {
  id: number
  name: string
  name_cn: string
  relation: string
  images: Partial<CoverImages> | null
  /** 角色所属作品名（导出图副标题汇总用） */
  subject: string
}

interface Cell {
  label: string
  char: CellChar | null
}

interface GridState {
  cols: number
  rows: number
  cells: Cell[][]
  title: string
  producer: string
}

interface Pos {
  r: number
  c: number
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function charName(c: { name: string; name_cn: string }): string {
  return c.name_cn || c.name || '（无名）'
}

/** 从角色图片里挑一个尺寸；缺了就按顺序往下退（老接口的 images 可能没有 common） */
function pickImage(
  images: Partial<CoverImages> | null | undefined,
  size: 'grid' | 'medium' | 'small' | 'large' = 'grid'
): string {
  if (!images) return ''
  const order: (keyof CoverImages)[] = [size, 'medium', 'large', 'grid', 'small']
  for (const k of order) {
    const v = images[k]
    if (v) return v
  }
  return ''
}

function makeCell(label: string): Cell {
  return { label, char: null }
}

function buildCells(cols: number, rows: number, from?: Cell[][]): Cell[][] {
  return Array.from({ length: rows }, (_row, r) =>
    Array.from({ length: cols }, (_col, c) => {
      const old = from?.[r]?.[c]
      // 已有格子原样保留（标签 + 角色）；新增格子标签留空，由用户自己写
      return old ? { label: old.label, char: old.char } : makeCell('')
    })
  )
}

function defaultState(): GridState {
  const cols = 3
  const rows = 3
  // 默认标签按「逐行」铺进 3×3：第 0 行是 最喜欢/最遗憾/最神秘，依此类推
  const cells: Cell[][] = Array.from({ length: rows }, (_row, r) =>
    Array.from({ length: cols }, (_col, c) => makeCell(DEFAULT_LABELS[r * cols + c] ?? ''))
  )
  return { cols, rows, cells, title: DEFAULT_TITLE, producer: '' }
}

function normalizeChar(raw: unknown): CellChar | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = String(o.name ?? '')
  const nameCn = String(o.name_cn ?? '')
  if (!name && !nameCn) return null
  return {
    id: Number(o.id ?? 0),
    name,
    name_cn: nameCn,
    relation: String(o.relation ?? ''),
    images: (o.images as Partial<CoverImages> | null) ?? null,
    subject: String(o.subject ?? '')
  }
}

/**
 * 读本地缓存。
 * 尺寸/形状对不上时（改过上限、手改过 localStorage）直接重建默认盘面，
 * 避免后面取 cells[r][c] 时空引用崩掉整页。
 */
function loadState(): GridState {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return defaultState()
    const d = JSON.parse(raw) as Partial<GridState>
    const cols = clamp(Math.trunc(Number(d.cols) || 3), MIN_COLS, MAX_COLS)
    const rows = clamp(Math.trunc(Number(d.rows) || 3), MIN_ROWS, MAX_ROWS)
    const cells = Array.isArray(d.cells) ? d.cells : null
    if (!cells || cells.length !== rows || cells.some((row) => !Array.isArray(row) || row.length !== cols)) {
      return defaultState()
    }
    return {
      cols,
      rows,
      cells: cells.map((row) => row.map((cell) => ({ label: String(cell?.label ?? ''), char: normalizeChar(cell?.char) }))),
      title: typeof d.title === 'string' && d.title.trim() ? d.title : DEFAULT_TITLE,
      producer: typeof d.producer === 'string' ? d.producer : ''
    }
  } catch {
    return defaultState()
  }
}

// ---------------- 导出：canvas 布局与绘制工具 ----------------

/*
 * 布局参数与编辑区单格比例（230:276 / aspect-[230/276]）保持一致，做到「所见即所得」。
 * S=2 是 2 倍图：文字与立绘在高 DPI 屏上不糊。
 */
const EX = {
  S: 2,
  CELL_W: 230,
  CELL_H: 276,
  PAD: 10,
  LABEL_H: 26,
  GAP: 14,
  OUTER: 26,
  HEAD_H: 96,
  FOOT_H: 46,
  IMG_R: 7,
  CARD_R: 10,
  /** 立绘纵向裁切基准，与 CSS object-position: center 20% 对应 */
  BIAS: 0.2
}
const FONT =
  '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif'

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

/** 单行截断：超宽就按测量结果退字符加省略号（长标签不能被 clip 硬切掉半截） */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  const s = String(text ?? '')
  if (ctx.measureText(s).width <= maxW) return s
  let t = s
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1)
  return `${t}…`
}

/**
 * 按 cover 方式把图画进目标矩形（调用方已用 rrect + clip 圈好位置）。
 * 注意定位：把「缩放后图片的第 (sx,sy) 点」对齐到 (dx,dy)，即整张图画在 (dx-sx, dy-sy)。
 */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  bias = EX.BIAS
): boolean {
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  if (!iw || !ih) return false
  const scale = Math.max(dw / iw, dh / ih)
  const sw = iw * scale
  const sh = ih * scale
  const sx = (sw - dw) / 2
  const sy = (sh - dh) * bias
  ctx.drawImage(img, dx - sx, dy - sy, sw, sh)
  return true
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('立绘解码失败'))
    img.src = src
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 返回空'))), 'image/png')
    } catch (err) {
      // 画布被污染时 toBlob 会抛 SecurityError —— 本页立绘走 data URL，正常不该走到这里
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

/** 文件名：带上作品名与时间（非法字符替换），一眼能看出是哪张图 */
function exportFilename(state: GridState, producer: string, subjectName: string): string {
  const d = new Date()
  const pad = (n: number): string => (n < 10 ? '0' : '') + n
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
  const clean = (s: string): string => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24)
  const parts = ['最XX的角色9宫格', clean(subjectName), clean(producer), stamp].filter((s) => s.length > 0)
  return `${parts.join('_')}.png`
}

interface CellGeo {
  char: CellChar
  rect: { x: number; y: number; w: number; h: number }
}

/** 画底稿（背景/标题/制作人/标签/名字/占位块），返回各格立绘的目标矩形 */
function drawPoster(state: GridState, producer: string): { canvas: HTMLCanvasElement; geo: CellGeo[] } {
  const { cols, rows } = state
  const W = EX.OUTER * 2 + cols * EX.CELL_W + (cols - 1) * EX.GAP
  const H = EX.HEAD_H + EX.OUTER + rows * EX.CELL_H + (rows - 1) * EX.GAP + EX.OUTER + EX.FOOT_H

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(W * EX.S)
  canvas.height = Math.round(H * EX.S)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布上下文')
  ctx.scale(EX.S, EX.S)
  ctx.textBaseline = 'alphabetic'

  ctx.fillStyle = '#f5f6fa'
  ctx.fillRect(0, 0, W, H)

  // ---- 顶部：标题 / 作品名 / 制作人 ----
  ctx.textAlign = 'left'
  ctx.fillStyle = '#23262e'
  ctx.font = `700 30px ${FONT}`
  ctx.fillText(fitText(ctx, state.title || DEFAULT_TITLE, W - EX.OUTER * 2 - 260), EX.OUTER, 50)

  // 副标题：汇总用到的作品名，让人知道角色出自哪里
  const works: string[] = []
  for (const row of state.cells) {
    for (const cell of row) {
      if (cell.char?.subject && !works.includes(cell.char.subject)) works.push(cell.char.subject)
    }
  }
  ctx.fillStyle = '#8a90a0'
  ctx.font = `14px ${FONT}`
  const sub = works.length > 0 ? `作品：${works.join(' / ')}` : '（还没有填入角色）'
  ctx.fillText(fitText(ctx, sub, W - EX.OUTER * 2 - 260), EX.OUTER, 76)

  // 制作人：右上角胶囊。导出前强制填写（见 doExport），所以这里一定有内容。
  // 名字过长时先截断，避免胶囊宽到把标题位置吃掉（画布宽度必须留得住右侧这块）。
  ctx.font = `600 16px ${FONT}`
  const who = `制作人：${fitText(ctx, producer, 260)}`
  const whoW = ctx.measureText(who).width + 26
  ctx.fillStyle = '#eef0fe'
  rrect(ctx, W - EX.OUTER - whoW, 26, whoW, 34, 8)
  ctx.fill()
  ctx.fillStyle = '#4756c4'
  ctx.fillText(who, W - EX.OUTER - whoW + 13, 49)

  ctx.strokeStyle = '#e6e8f0'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(EX.OUTER, EX.HEAD_H - 8)
  ctx.lineTo(W - EX.OUTER, EX.HEAD_H - 8)
  ctx.stroke()

  // ---- 所有格子的底/标签/名字先画完（不依赖网络，保证一定能出图） ----
  const geo: CellGeo[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = EX.OUTER + c * (EX.CELL_W + EX.GAP)
      const y = EX.HEAD_H + EX.OUTER + r * (EX.CELL_H + EX.GAP)
      const cell = state.cells[r][c]
      const pad = EX.PAD

      ctx.save()
      ctx.shadowColor = 'rgba(24,30,55,.07)'
      ctx.shadowBlur = 8
      ctx.shadowOffsetY = 2
      ctx.fillStyle = '#ffffff'
      rrect(ctx, x, y, EX.CELL_W, EX.CELL_H, EX.CARD_R)
      ctx.fill()
      ctx.restore()
      ctx.strokeStyle = '#e6e8f0'
      ctx.lineWidth = 1
      rrect(ctx, x + 0.5, y + 0.5, EX.CELL_W - 1, EX.CELL_H - 1, EX.CARD_R)
      ctx.stroke()

      // 标签胶囊（空标签也照实写出来，提醒用户这格还没写标签）
      const label = cell.label || '（未命名）'
      ctx.font = `600 13px ${FONT}`
      const labelText = fitText(ctx, label, EX.CELL_W - pad * 2 - 16)
      const lw = Math.min(EX.CELL_W - pad * 2, ctx.measureText(labelText).width + 16)
      ctx.fillStyle = cell.label ? '#eef0fe' : '#f1f2f6'
      rrect(ctx, x + pad, y + pad, lw, EX.LABEL_H, 6)
      ctx.fill()
      ctx.save()
      rrect(ctx, x + pad, y + pad, lw, EX.LABEL_H, 6)
      ctx.clip()
      ctx.fillStyle = cell.label ? '#4756c4' : '#a6abb8'
      ctx.textAlign = 'left'
      ctx.fillText(labelText, x + pad + 8, y + pad + 18)
      ctx.restore()

      // 立绘占位块（有图时盖在上面）
      const imgY = y + pad + EX.LABEL_H + 8
      const imgW = EX.CELL_W - pad * 2
      const nameBlock = 46
      const imgH = EX.CELL_H - (pad + EX.LABEL_H + 8) - 8 - nameBlock - pad
      const rect = { x: x + pad, y: imgY, w: imgW, h: imgH }
      ctx.fillStyle = '#f3f4f8'
      rrect(ctx, rect.x, rect.y, rect.w, rect.h, EX.IMG_R)
      ctx.fill()
      if (cell.char) geo.push({ char: cell.char, rect })

      // 角色名 + 关系
      const cx = x + EX.CELL_W / 2
      const nameTop = imgY + imgH + 8
      ctx.textAlign = 'center'
      if (cell.char) {
        const n1 = charName(cell.char)
        const n2 = cell.char.name && cell.char.name_cn && cell.char.name_cn !== cell.char.name ? cell.char.name : ''
        ctx.fillStyle = '#23262e'
        ctx.font = `600 15px ${FONT}`
        ctx.fillText(fitText(ctx, n1, imgW), cx, nameTop + 18)
        if (n2) {
          ctx.fillStyle = '#9aa1b1'
          ctx.font = `12px ${FONT}`
          ctx.fillText(fitText(ctx, n2, imgW), cx, nameTop + 36)
        }
      } else {
        ctx.fillStyle = '#c3c8d6'
        ctx.font = `13px ${FONT}`
        ctx.fillText('（空）', cx, nameTop + 18)
      }

      // 右下角序号，方便对着屏幕找格子
      ctx.textAlign = 'right'
      ctx.fillStyle = '#dfe2ec'
      ctx.font = `10px ${FONT}`
      ctx.fillText(String(r * cols + c + 1), x + EX.CELL_W - 7, y + EX.CELL_H - 6)
    }
  }

  // ---- 底部：数据来源与导出时间 ----
  ctx.textAlign = 'left'
  ctx.fillStyle = '#9aa1b1'
  ctx.font = `12px ${FONT}`
  ctx.fillText('角色立绘与资料来自 Bangumi（bgm.tv）', EX.OUTER, H - 24)
  const d = new Date()
  ctx.textAlign = 'right'
  ctx.fillText(`导出时间 ${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, W - EX.OUTER, H - 24)

  return { canvas, geo }
}

/**
 * 导出用的立绘候选地址（依次尝试）。
 *
 * 首选 `large`（最清晰），但角色立绘里有少数原图极大（实测有 800×2767 的），
 * 主进程对单张超过 6MB 的图会直接拒绝（避免 base64 撑爆内存），
 * 所以这里准备一条降级链：large → medium（反代的 /r/400/ 缩放版）→ grid → small，
 * 任一张成功就画上去，全都不行才退回占位色块。
 */
function imageCandidates(images: Partial<CoverImages> | null | undefined): string[] {
  if (!images) return []
  const list = (['large', 'medium', 'grid', 'small'] as const)
    .map((k) => images[k])
    .filter((u): u is string => Boolean(u))
  return [...new Set(list)]
}

/**
 * 导出整张 PNG。
 *
 * 立绘**必须**先经主进程 `imageDataUrl` 换成 data URL 再画：
 * 界面里的图是 `sakana-img://`（自定义协议 = 跨源），直接 drawImage 会污染画布，
 * 之后的 `toBlob()` 会抛 SecurityError；data URL 永不污染。
 * 所有立绘 `await` 画完之后才 `toBlob()`，避免「导出图缺图」。
 * 分批（每批 4 张）是为了不让几十张大图同时驻留内存（4×10 最多 40 格）。
 */
async function exportPng(state: GridState, producer: string): Promise<{ blob: Blob; missing: number; width: number; height: number }> {
  const { canvas, geo } = drawPoster(state, producer)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布上下文')

  let missing = 0
  const BATCH = 4
  for (let i = 0; i < geo.length; i += BATCH) {
    const slice = geo.slice(i, i + BATCH)
    await Promise.all(
      slice.map(async (g) => {
        const urls = imageCandidates(g.char.images)
        if (urls.length === 0) {
          missing += 1
          return
        }
        for (const url of urls) {
          const r = await api.bangumi.imageDataUrl(url)
          if (!r.ok || !r.data.dataUrl) continue
          try {
            const img = await loadImage(r.data.dataUrl)
            ctx.save()
            rrect(ctx, g.rect.x, g.rect.y, g.rect.w, g.rect.h, EX.IMG_R)
            ctx.clip()
            drawCover(ctx, img, g.rect.x, g.rect.y, g.rect.w, g.rect.h)
            ctx.restore()
            return
          } catch {
            // 这一张解不开就试下一张尺寸
          }
        }
        // 全部候选都拿不到：底稿的占位色块留着，不因此让整张图导出失败
        missing += 1
      })
    )
  }

  const blob = await canvasToBlob(canvas)
  return { blob, missing, width: canvas.width, height: canvas.height }
}

// ---------------- 页面 ----------------

export function CharacterGridPage() {
  const navigate = useNavigate()
  const [state, setState] = useState<GridState>(() => loadState())
  const { cols, rows, cells } = state

  // 作品搜索
  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [subjects, setSubjects] = useState<SearchResultItem[]>([])
  const [subject, setSubject] = useState<SearchResultItem | null>(null)

  // 角色
  const [chars, setChars] = useState<CharacterItem[]>([])
  const [loadingChars, setLoadingChars] = useState(false)
  const [charSource, setCharSource] = useState<{ source: 'v0' | 'legacy'; stale?: boolean } | null>(null)

  // 编辑态
  const [target, setTarget] = useState<Pos>({ r: 0, c: 0 })
  const [swapFrom, setSwapFrom] = useState<Pos | null>(null)
  const [editing, setEditing] = useState<Pos | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [producerError, setProducerError] = useState(false)
  const [exporting, setExporting] = useState(false)
  const producerRef = useRef<HTMLInputElement>(null)

  /** 每次改动都落 localStorage：刷新不丢（尺寸自检在 loadState 里做） */
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state))
    } catch {
      /* 存储被禁用/写满时忽略，不影响当前会话使用 */
    }
  }, [state])

  const subjectLabel = subject ? subject.name_cn || subject.name : ''

  const updateCell = useCallback((r: number, c: number, patch: Partial<Cell>) => {
    setState((s) => ({
      ...s,
      cells: s.cells.map((row, ri) => row.map((cell, ci) => (ri === r && ci === c ? { ...cell, ...patch } : cell)))
    }))
  }, [])

  /** 交换两格里的角色（标签留在原地：标签是「这一格问什么」，角色是「答案」） */
  const swapChars = useCallback((a: Pos, b: Pos) => {
    setState((s) => {
      const next = s.cells.map((row) => row.map((cell) => ({ ...cell })))
      const ca = next[a.r][a.c].char
      next[a.r][a.c].char = next[b.r][b.c].char
      next[b.r][b.c].char = ca
      return { ...s, cells: next }
    })
  }, [])

  const resize = useCallback(
    (nextCols: number, nextRows: number) => {
      const c = clamp(nextCols, MIN_COLS, MAX_COLS)
      const r = clamp(nextRows, MIN_ROWS, MAX_ROWS)
      if (c === cols && r === rows) return
      let dropped = 0
      for (let ri = r; ri < rows; ri++) for (const cell of cells[ri] ?? []) if (cell.char || cell.label) dropped += 1
      for (const row of cells) for (let ci = c; ci < cols; ci++) if (row[ci]?.char || row[ci]?.label) dropped += 1
      setState((s) => ({ ...s, cols: c, rows: r, cells: buildCells(c, r, s.cells) }))
      setTarget((t) => ({ r: Math.min(t.r, r - 1), c: Math.min(t.c, c - 1) }))
      setSwapFrom(null)
      if (dropped > 0) toast.info(`缩小后丢弃了 ${dropped} 个越界格子（含其中的角色）`)
    },
    [cols, rows, cells]
  )

  const onCellClick = useCallback(
    (r: number, c: number) => {
      if (swapFrom) {
        if (swapFrom.r === r && swapFrom.c === c) {
          setSwapFrom(null)
          return
        }
        swapChars(swapFrom, { r, c })
        setSwapFrom(null)
        toast.success('已交换两格的角色')
        return
      }
      setTarget({ r, c })
    },
    [swapFrom, swapChars]
  )

  const startEditLabel = useCallback((p: Pos, current: string) => {
    setEditing(p)
    setLabelDraft(current)
  }, [])

  const commitLabel = useCallback(() => {
    if (!editing) return
    updateCell(editing.r, editing.c, { label: labelDraft.trim() })
    setEditing(null)
  }, [editing, labelDraft, updateCell])

  const doSearch = useCallback(async () => {
    const kw = keyword.trim()
    if (!kw) {
      toast.info('请先输入作品名')
      return
    }
    setSearching(true)
    const r = await api.bangumi.search(kw)
    setSearching(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    setSubjects(r.data.items)
    if (r.data.items.length === 0) {
      if (r.data.error) toast.error(r.data.error.message)
      else toast.info('没有搜到作品，换个关键词试试')
    }
  }, [keyword])

  const selectSubject = useCallback(async (item: SearchResultItem) => {
    setSubject(item)
    setChars([])
    setCharSource(null)
    try {
      localStorage.setItem(SUBJECT_KEY, JSON.stringify(item))
    } catch {
      /* 存储不可用时忽略：只是刷新后要重新搜一次 */
    }
    setLoadingChars(true)
    const r = await api.bangumi.characters(item.id)
    setLoadingChars(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    setChars(r.data.items)
    setCharSource({ source: r.data.source, stale: r.data.stale })
    if (r.data.items.length === 0) {
      if (r.data.error) toast.error(r.data.error.message)
      else toast.info('这部作品没有取到角色数据')
    }
    if (r.data.source === 'legacy') toast.info('角色来自老接口兜底，数量可能少于完整角色表')
  }, [])

  /** 恢复上次选中的作品（selectSubject 是稳定引用，这里只跑一次） */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SUBJECT_KEY)
      if (!raw) return
      const item = JSON.parse(raw) as SearchResultItem
      if (item && typeof item.id === 'number' && item.id > 0) void selectSubject(item)
    } catch {
      /* 缓存损坏就当作没有选中作品 */
    }
  }, [selectSubject])

  const placeCharacter = useCallback(
    (ch: CharacterItem) => {
      const { r, c } = target
      updateCell(r, c, {
        char: {
          id: ch.id,
          name: ch.name,
          name_cn: ch.name_cn,
          relation: ch.relation,
          images: ch.images,
          subject: subjectLabel
        }
      })
      toast.success(`已放入第 ${r * cols + c + 1} 格：${charName(ch)}`)
    },
    [target, updateCell, cols, subjectLabel]
  )

  const clearAllChars = useCallback(() => {
    setState((s) => ({ ...s, cells: s.cells.map((row) => row.map((cell) => ({ ...cell, char: null }))) }))
    toast.info('已清空所有格子里的角色（标签保留）')
  }, [])

  const resetLabels = useCallback(() => {
    setState((s) => ({
      ...s,
      cells: s.cells.map((row, r) =>
        row.map((cell, c) => ({ ...cell, label: r * s.cols + c < DEFAULT_LABELS.length ? DEFAULT_LABELS[r * s.cols + c] : '' }))
      )
    }))
    toast.info('标签已重置为默认（超出的格子标签留空）')
  }, [])

  /**
   * 导出：**没填制作人就直接不导出**（提示 + 输入框标红 + 焦点回到输入框）。
   * 这是硬性要求：导出图上必须有制作人，否则这张图等于没有署名。
   */
  const doExport = useCallback(async () => {
    const who = state.producer.trim()
    if (!who) {
      setProducerError(true)
      producerRef.current?.focus()
      toast.error('导出已取消：请先填写「制作人」')
      return
    }
    setProducerError(false)
    setExporting(true)
    try {
      const { blob, missing, width, height } = await exportPng(state, who)
      downloadBlob(blob, exportFilename(state, who, subjectLabel))
      toast.success(
        missing > 0
          ? `已导出 PNG（${width}×${height}）；有 ${missing} 张立绘取不到，已用占位色块代替`
          : `已导出 PNG（${width}×${height}），制作人已写在图上`
      )
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      toast.error(`导出失败：${msg}`)
    } finally {
      setExporting(false)
    }
  }, [state, subjectLabel])

  const untagged = useMemo(
    () => cells.flat().filter((cell) => !cell.label).length,
    [cells]
  )

  return (
    <div className="relative h-full overflow-y-auto px-4 py-3">
      {/* 顶部：标题 + 制作人 + 导出 */}
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
            <h1 className="text-lg font-bold">最XX的角色 9宫格</h1>
            <Badge tone="accent">工具</Badge>
          </div>
          <p className="mt-0.5 text-xs text-faint">
            搜作品 → 点角色装进选中的格子 → 填「制作人」后导出 PNG（数据来自 Bangumi）
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Input
            ref={producerRef}
            value={state.producer}
            placeholder="制作人（导出必填）"
            className={`h-9 w-48 ${producerError ? 'border-danger focus:border-danger' : ''}`}
            onChange={(e) => {
              const v = e.target.value
              setState((s) => ({ ...s, producer: v }))
              if (v.trim()) setProducerError(false)
            }}
          />
          <Button icon={Download} loading={exporting} onClick={() => void doExport()}>
            导出 PNG
          </Button>
        </div>
      </div>
      {producerError ? (
        <div className="mt-2 rounded-lg bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          导出前必须先填写「制作人」——这个名字会写在导出图右上角。
        </div>
      ) : null}

      <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-start">
        {/* ================= 左：作品搜索 + 角色选择 ================= */}
        <section className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-elev1/60 p-3 lg:w-[360px] lg:shrink-0">
          <div className="flex items-center gap-2">
            <Input
              value={keyword}
              placeholder="搜索作品名（中文 / 日文 / 英文）"
              className="h-9 flex-1"
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSearch()
              }}
            />
            <Button icon={Search} loading={searching} onClick={() => void doSearch()}>
              搜索
            </Button>
          </div>

          {/* 作品结果 */}
          {subjects.length > 0 ? (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
              {subjects.map((it) => (
                <button
                  key={it.id}
                  onClick={() => void selectSubject(it)}
                  className={`flex w-full items-center gap-2 border-b border-border/60 px-2 py-1.5 text-left transition-colors last:border-b-0 hover:bg-elev2 ${
                    subject?.id === it.id ? 'bg-accent-soft' : ''
                  }`}
                >
                  <CoverImage src={pickImage(it.images, 'grid')} className="h-12 w-9 shrink-0" rounded="rounded" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{it.name_cn || it.name}</span>
                    <span className="block truncate text-[10px] text-faint">
                      {it.name_cn && it.name ? it.name : ''} {it.air_date ? it.air_date.slice(0, 4) : ''}
                      {it.rating?.score ? ` ★${it.rating.score}` : ''}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {/* 角色列表 */}
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-semibold text-dim">
              {subject ? `角色：${subjectLabel}` : '先选一部作品'}
            </span>
            {loadingChars ? <Spinner size={14} /> : null}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {charSource ? (
                <>
                  <Badge tone={charSource.source === 'v0' ? 'accent' : 'warn'}>
                    {charSource.source === 'v0' ? '来源：v0 角色接口' : '来源：老接口兜底'}
                  </Badge>
                  {charSource.stale ? <Badge tone="neutral">缓存</Badge> : null}
                </>
              ) : null}
            </span>
          </div>
          {charSource?.source === 'legacy' ? (
            <p className="text-[10px] leading-relaxed text-warn">
              这部作品的角色走的是老接口兜底，角色数可能少于完整角色表（v0 接口当前不可用）。
            </p>
          ) : null}

          {chars.length > 0 ? (
            <div className="max-h-[420px] overflow-y-auto">
              <div className="grid grid-cols-3 gap-2">
                {chars.map((ch) => (
                  <button
                    key={ch.id}
                    title={ch.name}
                    onClick={() => placeCharacter(ch)}
                    className="flex flex-col items-center gap-1 rounded-lg border border-border bg-elev1 p-1.5 transition-colors hover:border-accent"
                  >
                    <CoverImage src={pickImage(ch.images, 'grid')} className="h-20 w-full" rounded="rounded-md" />
                    <span className="w-full truncate text-[11px]">{charName(ch)}</span>
                    <span className="w-full truncate text-[10px] text-faint">{ch.relation || '—'}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-faint">
              {loadingChars ? '正在取角色…' : '选中作品后这里会列出角色，点角色即可装进当前选中的格子'}
            </div>
          )}
        </section>

        {/* ================= 右：九宫格编辑器 ================= */}
        <section className="min-w-0 flex-1 rounded-xl border border-border bg-elev1/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={state.title}
              className="h-8 w-56 text-xs"
              title="导出图顶部的标题"
              onChange={(e) => setState((s) => ({ ...s, title: e.target.value }))}
            />

            {/* 列 / 行：3~4 列 × 3~10 行 */}
            <span className="ml-1 flex items-center gap-1 text-xs text-dim">
              列
              <IconButton title="减少列" onClick={() => resize(cols - 1, rows)} disabled={cols <= MIN_COLS}>
                <Minus size={14} />
              </IconButton>
              <span className="w-4 text-center font-semibold">{cols}</span>
              <IconButton title="增加列" onClick={() => resize(cols + 1, rows)} disabled={cols >= MAX_COLS}>
                <Plus size={14} />
              </IconButton>
            </span>
            <span className="flex items-center gap-1 text-xs text-dim">
              行
              <IconButton title="减少行" onClick={() => resize(cols, rows - 1)} disabled={rows <= MIN_ROWS}>
                <Minus size={14} />
              </IconButton>
              <span className="w-4 text-center font-semibold">{rows}</span>
              <IconButton title="增加行" onClick={() => resize(cols, rows + 1)} disabled={rows >= MAX_ROWS}>
                <Plus size={14} />
              </IconButton>
            </span>
            <span className="text-[10px] text-faint">共 {cols * rows} 格（上限 4×10 = 40 格）</span>

            <span className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant={swapFrom ? 'primary' : 'outline'}
                icon={ArrowLeftRight}
                onClick={() => {
                  setSwapFrom(swapFrom ? null : target)
                  toast.info(swapFrom ? '已退出交换模式' : '交换模式：先点一格，再点另一格即可互换角色')
                }}
              >
                {swapFrom ? '选择另一格…' : '交换两格'}
              </Button>
              <Button size="sm" variant="ghost" icon={Eraser} onClick={clearAllChars}>
                清空角色
              </Button>
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={resetLabels}>
                默认标签
              </Button>
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-faint">
            <span>
              当前选中第 <span className="font-semibold text-accent">{target.r * cols + target.c + 1}</span> 格 —— 点角色就装进这一格
            </span>
            <span>· 点格子左上角的标签可以就地改写（默认标签也能改）</span>
            {untagged > 0 ? <span className="text-warn">· 还有 {untagged} 格没写标签</span> : null}
            {swapFrom ? <span className="text-accent">· 交换模式已开启</span> : null}
          </div>

          {/* 格子盘面：列数用内联样式（Tailwind 无法动态生成 grid-cols-N） */}
          <div
            className="mt-3 grid gap-2"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {cells.map((row, r) =>
              row.map((cell, c) => {
                const idx = r * cols + c + 1
                const isTarget = target.r === r && target.c === c
                const isSwapFrom = swapFrom?.r === r && swapFrom?.c === c
                const isEditing = editing?.r === r && editing?.c === c
                return (
                  <div
                    key={`${r}-${c}`}
                    onClick={() => onCellClick(r, c)}
                    className={`group relative flex cursor-pointer flex-col gap-1.5 rounded-xl border bg-elev1 p-1.5 transition-colors ${
                      isSwapFrom ? 'border-warn' : isTarget ? 'border-accent' : 'border-border hover:border-accent/60'
                    }`}
                    style={{ aspectRatio: '230 / 276' }}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        value={labelDraft}
                        placeholder="写标签"
                        onChange={(e) => setLabelDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={commitLabel}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitLabel()
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        className="h-6 w-full shrink-0 rounded-md border border-accent bg-elev2 px-1.5 text-[11px] outline-none"
                      />
                    ) : (
                      <button
                        title="点击改写标签"
                        onClick={(e) => {
                          e.stopPropagation()
                          startEditLabel({ r, c }, cell.label)
                        }}
                        className={`h-6 w-full shrink-0 truncate rounded-md px-1.5 text-[11px] font-semibold transition-colors ${
                          cell.label ? 'bg-accent-soft text-accent' : 'bg-elev2 text-faint'
                        }`}
                      >
                        {cell.label || '点击写标签'}
                      </button>
                    )}

                    <div className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-elev2">
                      {cell.char ? (
                        <CoverImage
                          src={pickImage(cell.char.images, 'grid')}
                          alt={charName(cell.char)}
                          rounded="rounded-md"
                          className="h-full w-full"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-faint">
                          <ImageOff size={18} />
                        </div>
                      )}
                      <span className="absolute left-1 top-1 rounded bg-black/55 px-1 text-[9px] text-white">{idx}</span>
                      {isTarget && !swapFrom ? (
                        <span className="absolute right-1 top-1 rounded bg-accent px-1 text-[9px] text-white">当前</span>
                      ) : null}
                      {isSwapFrom ? (
                        <span className="absolute bottom-1 left-1 rounded bg-warn px-1 text-[9px] text-white">起点</span>
                      ) : null}
                      {cell.char ? (
                        <button
                          title="清空这一格"
                          onClick={(e) => {
                            e.stopPropagation()
                            updateCell(r, c, { char: null })
                          }}
                          /* 选中格的「清空」常显，其余格子悬停时才出现：既不挡画面又能马上找到 */
                          className={`absolute bottom-1 right-1 rounded bg-black/55 p-0.5 text-white transition-opacity ${
                            isTarget && !swapFrom ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                          }`}
                        >
                          <X size={12} />
                        </button>
                      ) : null}
                    </div>

                    <div className="h-8 shrink-0 text-center">
                      {cell.char ? (
                        <>
                          <div className="truncate text-[11px] font-medium">{charName(cell.char)}</div>
                          <div className="truncate text-[10px] text-faint">
                            {cell.char.relation || cell.char.subject || '—'}
                          </div>
                        </>
                      ) : (
                        <div className="text-[10px] text-faint">（空）</div>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          <p className="mt-3 text-[10px] leading-relaxed text-faint">
            导出为 2 倍图 PNG，单格画「标签 + 立绘（cover 裁切）+ 名字」，右上角写制作人；
            立绘由主进程取回并转成 data URL 后再画进画布（避免自定义协议污染画布导致导出失败）。
            盘面与标签、制作人会存到本地，刷新不丢。
          </p>
        </section>
      </div>
    </div>
  )
}

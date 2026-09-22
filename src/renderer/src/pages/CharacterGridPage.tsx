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
import { imgUrl } from '@/lib/format'
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
/**
 * 当前选中的**数据源**（v0.3.2 抽出常量）。
 *
 * 过去这个 key 是直接写在 useState 初始化里的字符串字面量：读一处、写一处，
 * 拼错任何一处都会静默退回默认值，而「切换不生效」正是这次要修的问题之一，
 * 所以收敛成一个常量，读写都只能用它。
 */
const SOURCE_KEY = 'sakana-character-grid-source'

/**
 * 可选的两个角色数据源。
 * - `jikan`：MyAnimeList（经 Jikan）—— 立绘是 MAL 原图，画质优先，默认；
 * - `bangumi`：原来的 Bangumi（v0 优先 + 老接口兜底）—— 中文名更准，图偏小。
 */
type CharSrc = 'jikan' | 'bangumi'

/**
 * 实际**拿到数据**的来源：Jikan 取不到会回落 Bangumi，界面必须如实说明是哪一个。
 *
 * v0.3.2：`jikan` 这一档再细分「谁给的」—— 实测 Jikan 的搜索/角色端点会整片 504
 * （它自己连不上 MAL 上游），此时主进程会改走 AniList。数据来源必须按**实际**写，
 * 否则用户看到的「来源：Jikan/MAL」是假的（上一版就是这么错的）。
 */
type ResolvedKind = 'jikan' | 'jikan-anilist' | 'v0' | 'legacy'

interface ResolvedSource {
  kind: ResolvedKind
  /** 命中的是过期缓存（数据可用，后台在刷新） */
  stale?: boolean
  /** 走 Jikan 时命中的 MAL 条目（回落 Bangumi 后仍保留，用来解释为什么回落） */
  jikan?: { malId: number; animeTitle: string; asked: string }
  /** 回落原因：只在 Jikan 没取到时出现，界面上**常驻**提示（不能只发一个会消失的 toast） */
  fallback?: string
  /** 本次拿到的角色数 */
  count: number
}

/** 来源的中文名：徽章、导出图页脚、说明文字统一用它，避免一处说 Jikan 一处说 Bangumi */
function resolvedLabel(kind: ResolvedKind): string {
  if (kind === 'jikan') return 'Jikan（MyAnimeList）'
  if (kind === 'jikan-anilist') return 'AniList（Jikan 端点不可用时的备用源）'
  if (kind === 'legacy') return 'Bangumi 老接口兜底'
  return 'Bangumi v0 接口'
}

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
  /** 立绘填充方式（跟着盘面一起落 localStorage，切过一次之后刷新仍然是这个选择） */
  fit: FitMode
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

/**
 * 从角色图片里挑一个尺寸；缺了就按顺序往下退（老接口的 images 可能没有 common）。
 *
 * ⚠️ v0.3.3 修过一次**取图取小了**的问题：
 * 以前这个函数的兜底顺序写死成 `[size, medium, large, grid, small]`，而三处调用都传 `'grid'` ——
 * 于是**格子里画的是 75×75 的缩略图**（Bangumi 的 grid 档实测就是 75×75，2KB），
 * 再被 drawCover 放大到 276×268 设备像素（≈3.7 倍），立绘糊得不成样子。
 * 用户拿 bgm.tv 的角色页做对比（那页用的是原图）才发现 —— 现在改成：
 *   · 格子与导出：`large`（反代给的**就是原图**，实测 CLANNAD 角色 2434×3466 / 454KB）
 *   · 选择列表：`small`（100×142，列表项只有 48px 宽，够了且省流量）
 *   · 已选角色条：`medium`（400×570，条上要看得清脸）
 * 并且兜底顺序改成「优先更大的档」，宁可用大图也别用糊图。
 */
const PICK_ORDER: Record<'grid' | 'small' | 'medium' | 'large', (keyof CoverImages)[]> = {
  large: ['large', 'medium', 'small', 'grid'],
  medium: ['medium', 'large', 'small', 'grid'],
  small: ['small', 'medium', 'large', 'grid'],
  grid: ['grid', 'small', 'medium', 'large']
}

function pickImage(
  images: Partial<CoverImages> | null | undefined,
  size: 'grid' | 'medium' | 'small' | 'large' = 'large'
): string {
  if (!images) return ''
  const order = PICK_ORDER[size] ?? PICK_ORDER.large
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
  return { cols, rows, cells, title: DEFAULT_TITLE, producer: '', fit: 'contain' }
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
      producer: typeof d.producer === 'string' ? d.producer : '',
      /*
       * 旧缓存里没有 fit 字段 —— **一律按「完整显示」处理**。
       * 这正是这次要修的问题：老盘面用的是 cover（立绘被裁），
       * 若把「缺字段」当成 cover，老用户刷新后仍然看不到完整立绘，「默认改成完整显示」就是空话。
       * 只有用户显式切过「铺满裁剪」（存了 'cover'）才保留。
       */
      fit: d.fit === 'cover' ? 'cover' : 'contain'
    }
  } catch {
    return defaultState()
  }
}

// ---------------- 导出：canvas 布局与绘制工具 ----------------

/*
 * 布局参数。S=2 是 2 倍图：文字在高 DPI 屏上不糊。
 *
 * v0.3.2（用户反馈「9 格的时候适当减小格子大小」+「立绘还是不够清晰」）：
 * 9 宫格单格改成**明显小一圈**（230×276 → 156×224），原因有两个，缺一个都不成立：
 *   ① 3×3 只有 9 格，用 4 列那套尺寸整张图会大而无当、四周一堆空白；
 *   ② 导出格子越小，立绘被**放大**的倍数就越小 —— 实测 MAL 立绘多为 225×350，
 *      2 倍图下旧格子要给立绘 360 设备像素宽（放大 1.6 倍 → 糊），新格子只要 276（放大 1.22 倍）。
 *      「减小格子」和「更清晰」在这里是同一件事，不是两个互相抵消的目标。
 * 其它行列组合（列 4 / 行 > 3）仍用原尺寸，保证 4×10 时每格的字还看得清。
 */
const EX = {
  S: 2,
  /**
   * 常规单格（列数 4 或行数 > 3 时使用）。
   *
   * 已知遗留（本次**故意不动**，写在这里免得下次又摸不着头脑）：
   * 按 MAL 立绘 225×350、2 倍图算，这个尺寸下立绘要被放大到 420 设备像素宽 ≈ **1.87 倍**，
   * 比 9 宫格还糊。之所以先不动：4 列最多 40 格（4×10），格子再小字就看不清了，
   * 而且用户这次只对 9 格提了要求。真要一起优化，把这里降到 158×190 左右即可
   * （算出 1.23 倍上下），代价是 4 列的导出宽度从 2028 掉到约 1400。
   */
  CELL_W: 230,
  CELL_H: 276,
  /** 9 宫格单格：比常规小一圈（面积约为原来的 55%），立绘放大倍数同时降下来 */
  NINE_W: 156,
  NINE_H: 224,
  /** 9 宫格更紧凑的内边距/标签高/名字块高（格子小了，这几项也必须跟着收，否则立绘框被挤没） */
  NINE_PAD: 9,
  NINE_LABEL_H: 22,
  NINE_NAME_H: 34,
  PAD: 10,
  LABEL_H: 26,
  /** 名字区高度（角色名 + 关系两行） */
  NAME_H: 46,
  /** 标签行与立绘框之间、立绘框与名字区之间的留白 */
  IMG_GAP: 8,
  GAP: 14,
  OUTER: 26,
  HEAD_H: 96,
  FOOT_H: 46,
  IMG_R: 7,
  CARD_R: 10,
  /** 立绘纵向裁切基准，与 CSS object-position: center 20% 对应 */
  BIAS: 0.2,
  /*
   * 「完整显示」（contain）模式的背景层参数（v0.3.4）。
   *
   * 为什么要有背景层：格子的图区是高 134、宽 138 的近正方形，而 Bangumi 的立绘是竖长图
   * （实测 CLANNAD 古河渚 large 档 2434×3466 ≈ 1:1.42）。要让整张立绘可见，只能按**高度**贴合，
   * 于是两侧必然空出很大一块（94 宽的图放进 138 宽的框，两侧各空 22）。空着就是两块死白，
   * 所以用**同一张立绘**的 cover 版模糊 + 压暗铺在底下填满，主体仍然尽量大。
   *
   * ⚠️ 这个 filter 字符串是**预览与导出共用**的：canvas 侧赋给 `ctx.filter`，
   * 预览侧直接写进 CSS 的 `filter` —— 两边观感一致靠的是同一份参数，而不是两边各调一个数字。
   */
  BACKDROP_FILTER: 'blur(10px) brightness(.55)',
  /**
   * 背景层向外扩出的逻辑像素（模糊会把边缘的颜色抹淡，扩出 2×模糊半径才不会在四周泛出亮边）。
   * 预览侧用 `inset: -BACKDROP_PAD` 达成同一件事（外层 overflow-hidden 负责裁回圆角内）。
   */
  BACKDROP_PAD: 20
}

/**
 * 立绘在格子图区里的填充方式（v0.3.4 新增）。
 *
 * - `contain`：**完整显示**（默认）—— 整张立绘等比缩到框内、不裁切，空白用模糊压暗的同图填满；
 * - `cover`：铺满裁剪 —— 旧的 object-cover 行为，按短边铺满后裁掉超出部分（竖长立绘会被切掉上下）。
 */
type FitMode = 'contain' | 'cover'

/** 一套布局的全部尺寸（导出画布与编辑区预览共用，保证「所见即所得」） */
interface GridMetrics {
  cols: number
  rows: number
  /** 是否 9 宫格（3×3）—— 9 宫格走收紧后的单格尺寸 */
  nine: boolean
  cellW: number
  cellH: number
  pad: number
  labelH: number
  nameH: number
  /** 画布逻辑尺寸（乘 EX.S 才是导出像素） */
  w: number
  h: number
  /** 立绘框逻辑尺寸（单格扣掉内边距、标签行、名字区之后剩下的矩形） */
  imgW: number
  imgH: number
}

/**
 * 由行列数算出这一套布局的所有尺寸。
 *
 * 为什么抽成函数：过去是在 drawPoster 里**改写模块级 EX**（`EX.CELL_W = nine ? …`），
 * 于是「界面上的格子多大」和「导出图的格子多大」是两套各写一份的数字，
 * 单格比例在 JSX 里还硬编码着 230/276 —— 改了导出、界面纹丝不动，
 * 用户自然会觉得「改了没生效」。现在界面与导出都从这里取值。
 */
function gridMetrics(cols: number, rows: number): GridMetrics {
  const nine = cols === 3 && rows === 3
  const cellW = nine ? EX.NINE_W : EX.CELL_W
  const cellH = nine ? EX.NINE_H : EX.CELL_H
  const pad = nine ? EX.NINE_PAD : EX.PAD
  const labelH = nine ? EX.NINE_LABEL_H : EX.LABEL_H
  const nameH = nine ? EX.NINE_NAME_H : EX.NAME_H
  const w = EX.OUTER * 2 + cols * cellW + (cols - 1) * EX.GAP
  const h = EX.HEAD_H + EX.OUTER + rows * cellH + (rows - 1) * EX.GAP + EX.OUTER + EX.FOOT_H
  const imgW = cellW - pad * 2
  const imgH = cellH - (pad + labelH + EX.IMG_GAP) - EX.IMG_GAP - nameH - pad
  return { cols, rows, nine, cellW, cellH, pad, labelH, nameH, w, h, imgW, imgH }
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
  bias = EX.BIAS,
  /** 当前画布的缩放倍数（drawPoster 里做过 ctx.scale(EX.S, EX.S)） */
  canvasScale = EX.S
): boolean {
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  if (!iw || !ih) return false
  /*
   * 「小图不放大」的判定**必须换算到设备像素**。
   *
   * v0.2.17 加这条守卫时的意图是对的（源图比目标框小就别拉大，宁可留白），
   * 但拿的是逻辑像素：`Math.min(dw / iw, dh / ih)`。而画布已经 `ctx.scale(2, 2)`，
   * 传进来的 dw/dh 是逻辑像素，真实目标是 **dw*S × dh*S 设备像素**。
   *
   * 于是出现两个错：
   *   ① 该拦的没拦住 —— 实测 MAL 立绘 225×350、9 宫格立绘框 180×132（逻辑）时，
   *      算出 min(0.8, 0.377)=0.377 不满足 >1，直接走 cover：设备像素要 360 宽，
   *      等于把 225px 的图放大 1.6 倍，插值再好也是糊的（用户报的「不清晰」）；
   *   ② 真拦下来时更糟 —— 分支里按 `iw/dh`（逻辑）画，2 倍图上仍是放大 2 倍。
   * 现在统一在设备像素上判断，分支里再把「源图设备像素」换算回逻辑单位（/S）画，
   * 这样 1:1 就是真的 1:1。
   */
  const fit = Math.min((dw * canvasScale) / iw, (dh * canvasScale) / ih)
  if (fit > 1) {
    // 源图连目标框都填不满：按设备像素 1:1 居中画（宁可留白，也不放大糊掉）
    const lw = iw / canvasScale
    const lh = ih / canvasScale
    ctx.drawImage(img, dx + (dw - lw) / 2, dy + (dh - lh) / 2, lw, lh)
    return true
  }
  const scale = Math.max(dw / iw, dh / ih)
  const sw = iw * scale
  const sh = ih * scale
  const sx = (sw - dw) / 2
  const sy = (sh - dh) * bias
  ctx.drawImage(img, dx - sx, dy - sy, sw, sh)
  return true
}

/**
 * 按 contain 方式把图画进目标矩形（object-fit: contain 语义，调用方已 rrect + clip）。
 *
 * v0.3.4 新增，解决的问题是用户报的「立绘展示不完全」：
 * 图区是 138×134 的近正方形，而立绘是竖长图（古河渚 2434×3466），
 * cover 只能保住 68%（见 drawCover），上下三分之一被裁掉 —— 用户看到的就是「只显示中段」。
 * contain 按**短边**（这里是宽度 138/2434 与高度 134/3466 里更小的那个）缩放：
 * 整张立绘 100% 落在框里，高度贴满 134，两侧各空出约 22 —— 那 22 由 drawBackdrop 填。
 *
 * 注意这里**刻意不做** drawCover 那条「小图不放大」的 1:1 保护：
 * 预览走的是 CSS `object-fit: contain`，而 CSS 的 contain 对小于框的图是会放大的；
 * 画布若自作主张留白，预览与导出就是两套样子 —— 这条一致性比「不放大」更重要
 * （何况取图档位已经统一走 large 原图，源图比框小的情况只会在个别只有 grid 档的老角色上出现）。
 */
function drawContain(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number
): boolean {
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  if (!iw || !ih) return false
  const scale = Math.min(dw / iw, dh / ih)
  const w = iw * scale
  const h = ih * scale
  ctx.drawImage(img, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h)
  return true
}

/**
 * contain 模式的背景层：**同一张**立绘按 cover 铺满（并向外扩 BACKDROP_PAD），再模糊 + 压暗。
 * 作用只有一个：把 contain 让出来的空白填掉，让竖长立绘两侧不是两块死白，不至于难看。
 *
 * 两个细节：
 * ① 先扩边再模糊。blur 会把矩形边缘的颜色抹淡，直接贴着目标框画会在四周泛出一圈亮边
 *    （预览侧对标的是 `inset: -BACKDROP_PAD` + 外层 overflow-hidden，同一个道理）；
 * ② 这里用 0.5 的居中偏移，不套 drawCover 的 BIAS=0.2：它只是底噪，居中取景最自然。
 * 另外它不做「小图不放大」保护 —— 背景糊一点无所谓，铺不满反而会露出一块底板。
 */
function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number
): boolean {
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  if (!iw || !ih) return false
  const b = EX.BACKDROP_PAD
  const bx = dx - b
  const by = dy - b
  const bw = dw + b * 2
  const bh = dh + b * 2
  const scale = Math.max(bw / iw, bh / ih)
  const w = iw * scale
  const h = ih * scale
  // filter 属于 canvas 的绘图状态，save/restore 一对把它限定在这一笔里，不影响后续绘制
  ctx.save()
  ctx.filter = EX.BACKDROP_FILTER
  ctx.drawImage(img, bx + (bw - w) / 2, by + (bh - h) / 2, w, h)
  ctx.restore()
  return true
}

/**
 * 按当前的填充方式画一张立绘。**导出与预览共用同一套语义**（预览是 CSS 侧的等价写法）：
 * - `cover` → 只画一层 cover（旧行为，一字未改）；
 * - `contain` → 先画模糊压暗背景层，再把整张立绘等比画在框内。
 */
function drawImageFit(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  fit: FitMode,
  canvasScale = EX.S
): boolean {
  if (fit === 'cover') return drawCover(ctx, img, dx, dy, dw, dh, EX.BIAS, canvasScale)
  drawBackdrop(ctx, img, dx, dy, dw, dh)
  return drawContain(ctx, img, dx, dy, dw, dh)
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
function drawPoster(
  state: GridState,
  producer: string,
  /** 实际拿到数据的数据源：写在导出图页脚（用 Jikan 时不能还写着「来自 Bangumi」） */
  sourceKind: ResolvedKind
): { canvas: HTMLCanvasElement; geo: CellGeo[] } {
  const m = gridMetrics(state.cols, state.rows)
  const { cols, rows } = m
  const W = m.w
  const H = m.h

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(W * EX.S)
  canvas.height = Math.round(H * EX.S)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布上下文')
  ctx.scale(EX.S, EX.S)
  ctx.textBaseline = 'alphabetic'
  /*
   * 图像重采样质量（v0.2.14，用户反馈「立绘太模糊」）：
   * canvas 默认 'low' 是速度优先的近似实现，立绘缩到格子尺寸（少数小图还要放大）时边缘发虚。
   * 设为 'high' 用更好的插值核，同分辨率下观感明显更锐；导出只多几十毫秒。
   * 注意：它只影响**缩放时的插值**，救不了「本来就不够大的源图被硬放大」——
   * 那件事由 drawCover 的 1:1 判定与收紧后的 9 宫格尺寸负责。
   */
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

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
      const x = EX.OUTER + c * (m.cellW + EX.GAP)
      const y = EX.HEAD_H + EX.OUTER + r * (m.cellH + EX.GAP)
      const cell = state.cells[r][c]
      const pad = m.pad

      ctx.save()
      ctx.shadowColor = 'rgba(24,30,55,.07)'
      ctx.shadowBlur = 8
      ctx.shadowOffsetY = 2
      ctx.fillStyle = '#ffffff'
      rrect(ctx, x, y, m.cellW, m.cellH, EX.CARD_R)
      ctx.fill()
      ctx.restore()
      ctx.strokeStyle = '#e6e8f0'
      ctx.lineWidth = 1
      rrect(ctx, x + 0.5, y + 0.5, m.cellW - 1, m.cellH - 1, EX.CARD_R)
      ctx.stroke()

      // 标签胶囊（空标签也照实写出来，提醒用户这格还没写标签）
      const label = cell.label || '（未命名）'
      // 9 宫格的字号也跟着收一点，否则小格子里标签会把立绘框挤没
      const labelFont = m.nine ? 12 : 13
      ctx.font = `600 ${labelFont}px ${FONT}`
      const labelText = fitText(ctx, label, m.cellW - pad * 2 - 16)
      const lw = Math.min(m.cellW - pad * 2, ctx.measureText(labelText).width + 16)
      ctx.fillStyle = cell.label ? '#eef0fe' : '#f1f2f6'
      rrect(ctx, x + pad, y + pad, lw, m.labelH, 6)
      ctx.fill()
      ctx.save()
      rrect(ctx, x + pad, y + pad, lw, m.labelH, 6)
      ctx.clip()
      ctx.fillStyle = cell.label ? '#4756c4' : '#a6abb8'
      ctx.textAlign = 'left'
      ctx.fillText(labelText, x + pad + 8, y + pad + (m.nine ? 15 : 18))
      ctx.restore()

      // 立绘占位块（有图时盖在上面）。矩形尺寸统一由 gridMetrics 给出，
      // 与编辑区预览用的是同一套数字（过去这里另写一份 nameBlock=46，改了一处另一处不会跟着变）
      const imgY = y + pad + m.labelH + EX.IMG_GAP
      const rect = { x: x + pad, y: imgY, w: m.imgW, h: m.imgH }
      ctx.fillStyle = '#f3f4f8'
      rrect(ctx, rect.x, rect.y, rect.w, rect.h, EX.IMG_R)
      ctx.fill()
      if (cell.char) geo.push({ char: cell.char, rect })

      // 角色名 + 关系
      const cx = x + m.cellW / 2
      const nameTop = imgY + m.imgH + EX.IMG_GAP
      ctx.textAlign = 'center'
      if (cell.char) {
        const n1 = charName(cell.char)
        const n2 = cell.char.name && cell.char.name_cn && cell.char.name_cn !== cell.char.name ? cell.char.name : ''
        ctx.fillStyle = '#23262e'
        ctx.font = `600 ${m.nine ? 14 : 15}px ${FONT}`
        ctx.fillText(fitText(ctx, n1, m.imgW), cx, nameTop + (m.nine ? 15 : 18))
        if (n2) {
          ctx.fillStyle = '#9aa1b1'
          ctx.font = `${m.nine ? 11 : 12}px ${FONT}`
          ctx.fillText(fitText(ctx, n2, m.imgW), cx, nameTop + (m.nine ? 30 : 36))
        }
      } else {
        ctx.fillStyle = '#c3c8d6'
        ctx.font = `${m.nine ? 12 : 13}px ${FONT}`
        ctx.fillText('（空）', cx, nameTop + (m.nine ? 15 : 18))
      }

      // 右下角序号，方便对着屏幕找格子
      ctx.textAlign = 'right'
      ctx.fillStyle = '#dfe2ec'
      ctx.font = `10px ${FONT}`
      ctx.fillText(String(r * cols + c + 1), x + m.cellW - 7, y + m.cellH - 6)
    }
  }

  // ---- 底部：数据来源与导出时间 ----
  ctx.textAlign = 'left'
  ctx.fillStyle = '#9aa1b1'
  ctx.font = `12px ${FONT}`
  /*
   * 页脚必须写**实际用到的**数据源：v0.3.2 之前这里硬编码「来自 Bangumi（bgm.tv）」，
   * 换成 Jikan 之后导出图上仍然写着 Bangumi —— 图上写错来源比不写还糟。
   * 回落时（Jikan 没取到，实际用 Bangumi）也照实写 Bangumi。
   */
  const footer =
    sourceKind === 'jikan'
      ? '角色立绘与资料来自 Jikan / MyAnimeList（cdn.myanimelist.net）'
      : sourceKind === 'jikan-anilist'
        ? '角色立绘与资料来自 AniList（s4.anilist.co）· Jikan 端点不可用时的备用源'
        : `角色立绘与资料来自 Bangumi（bgm.tv）· ${resolvedLabel(sourceKind)}`
  ctx.fillText(footer, EX.OUTER, H - 24)
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
async function exportPng(
  state: GridState,
  producer: string,
  sourceKind: ResolvedKind
): Promise<{ blob: Blob; missing: number; width: number; height: number }> {
  const { canvas, geo } = drawPoster(state, producer, sourceKind)
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
            /*
             * 立绘画法由 state.fit 决定（默认「完整显示」）。
             * 这里**必须**和界面预览用同一套语义：预览是 CSS 侧（object-contain! / object-cover + 背景层），
             * 画布是这一行 —— 两边一旦分叉，用户就会遇到「预览看得到全身、导出却被裁掉」。
             */
            drawImageFit(ctx, img, g.rect.x, g.rect.y, g.rect.w, g.rect.h, state.fit)
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
  const fit = state.fit

  /**
   * 切换立绘填充方式（完整显示 / 铺满裁剪）。
   *
   * 为什么要做一个开关而不是直接改掉：用户报的是「立绘展示不完全」，
   * 所以**默认**必须改成「完整显示」；但 cover（铺满裁剪）本身不是 bug ——
   * 它让格子更满、更像一张海报，有人就是喜欢那种。删掉它等于用一个新毛病换掉旧毛病，
   * 所以做成两档可切，并且预览与导出都读 state.fit 这一份值（切换后两边同时变）。
   */
  const setFit = useCallback((v: FitMode): void => {
    setState((s) => (s.fit === v ? s : { ...s, fit: v }))
  }, [])

  // 作品搜索
  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [subjects, setSubjects] = useState<SearchResultItem[]>([])
  const [subject, setSubject] = useState<SearchResultItem | null>(null)

  // 角色
  const [chars, setChars] = useState<CharacterItem[]>([])
  const [loadingChars, setLoadingChars] = useState(false)
  /**
   * 当前选中的**数据源**（用户选择的那个，不是实际拿到的那个）。
   * v0.3.0 就有这个 state 了，但界面上**一个控件都没有**：pickSource 是死代码，
   * 用户既看不到当前用的是什么、也切不过去 —— 这是「切换数据源没生效」的第一层原因。
   */
  const [charSrc, setCharSrc] = useState<CharSrc>(() => {
    try {
      /*
       * v0.3.3：默认改成 **Bangumi**、Jikan 作为备选。
       *
       * 理由（实测，与最初引入 Jikan 时的假设相反）：反代给的 Bangumi 角色图 `large` 档
       * **就是原图**（CLANNAD 角色 2434×3466 / 454KB，与 bgm.tv 角色页看到的是同一张），
       * 而 MAL/Jikan 的角色立绘只有 225×350。以前觉得 Bangumi 糊，是因为我们取的是
       * **grid 缩略图（75×75）**，而不是原图；取图档位修好之后 Bangumi 明显更清晰。
       * 用户显式选过 Jikan 的话仍然尊重（localStorage 里存了 'jikan'）。
       */
      return localStorage.getItem(SOURCE_KEY) === 'jikan' ? 'jikan' : 'bangumi'
    } catch {
      return 'bangumi'
    }
  })
  /** 实际拿到数据的来源 + 回落原因（界面常驻显示，不靠会消失的 toast） */
  const [resolved, setResolved] = useState<ResolvedSource | null>(null)

  // 编辑态
  const [target, setTarget] = useState<Pos>({ r: 0, c: 0 })
  const [swapFrom, setSwapFrom] = useState<Pos | null>(null)
  const [editing, setEditing] = useState<Pos | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [producerError, setProducerError] = useState(false)
  const [exporting, setExporting] = useState(false)
  const producerRef = useRef<HTMLInputElement>(null)
  /** 上次选中的作品只恢复一次（见下面的 useEffect：selectSubject 的引用会随数据源变，不能进依赖数组） */
  const restoredRef = useRef(false)

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

  /**
   * 按当前数据源取角色。
   *
   * v0.3.3 起**默认用 Bangumi**、Jikan 作为备选（用户实测反馈）：
   * 反代给的 Bangumi 角色图 `large` 档**就是原图**（实测 CLANNAD 角色 2434×3466 / 454KB，
   * 与 bgm.tv 角色页看到的是同一张），而 Jikan/MAL 的角色立绘只有 225×350；MAL 那档反而更小。
   * 所以「为了立绘清晰度」应该选 Bangumi —— 这跟最初引入 Jikan 时的假设正好相反，
   * 原因是我们以前取的是 Bangumi 的 **grid（75×75）** 缩略图，而不是原图（见 pickImage 的注释）。
   *
   * 两个方向的取法与回落都保留：
   * - `bangumi`：v0 角色接口 → 老接口兜底；**全失败/为空时**自动改用 Jikan（并常驻说明原因）；
   * - `jikan`：Jikan（MAL，必要时 AniList）→ 失败时回落到 Bangumi。
   */
  const loadChars = useCallback(async (item: SearchResultItem, src: CharSrc) => {
    setLoadingChars(true)

    /** Jikan 那一路：成功则落地并返回 true，失败时把原因写进 note 并返回 false */
    const tryJikan = async (note: { text: string }): Promise<boolean> => {
      /*
       * 两种标题各试一次（相同就只试一次）：中文名优先，因为用户是在中文界面里选的条目，
       * 但 MAL 上多数条目只有日文原名，所以中文名没结果时必须再拿原名试一次。
       */
      const titles = [item.name_cn, item.name].map((s) => String(s ?? '').trim()).filter(Boolean)
      const tries = [...new Set(titles)].slice(0, 2)
      for (const title of tries) {
        const r = await api.bangumi.charactersJikan(title)
        if (!r.ok) {
          note.text = `Jikan 接口调用失败：${r.error}`
          continue
        }
        if (r.data.items.length === 0) {
          // malId=0 说明连 MAL 条目都没匹配上；reason 是主进程给的具体原因（Jikan 504 / AniList 无匹配…）
          note.text =
            r.data.reason ||
            (r.data.malId > 0
              ? `匹配到《${r.data.animeTitle}》(MAL #${r.data.malId})，但没有返回角色`
              : `没匹配到「${title}」对应的 MAL 条目（搜索接口不可用或标题对不上）`)
          continue
        }
        const items: CharacterItem[] = r.data.items.map((c) => ({
          id: c.id,
          name: c.name,
          name_cn: c.name_cn,
          relation: c.relation,
          // 只给一张原图，四个档位都指向它（pickImage 取哪一档都是原图）
          images: c.images as CoverImages | null
        }))
        // 立绘到底来自 MAL 还是 AniList，按主进程如实回报的字段决定（不能一律写 Jikan）
        const fromAniList = r.data.imageSource === 'anilist' || r.data.via === 'anilist'
        setChars(items)
        setResolved({
          kind: fromAniList ? 'jikan-anilist' : 'jikan',
          jikan: { malId: r.data.malId, animeTitle: r.data.animeTitle, asked: title },
          count: items.length
        })
        toast.success(
          fromAniList
            ? `已取到 ${items.length} 位角色（Jikan 端点不可用，改走 AniList 取图）`
            : `已用 Jikan 取到 ${items.length} 位角色（MAL #${r.data.malId}）`
        )
        return true
      }
      return false
    }

    /** Bangumi 那一路：成功则落地并返回 true（含「取到了但一个角色都没有」这种空结果） */
    const tryBangumi = async (): Promise<boolean> => {
      const r = await api.bangumi.characters(item.id)
      if (!r.ok) {
        toast.error(r.error)
        return true // 接口层面的失败已经报过错了，不再去试另一个源（否则提示会打架）
      }
      setChars(r.data.items)
      setResolved({ kind: r.data.source, stale: r.data.stale, count: r.data.items.length })
      if (r.data.items.length === 0) {
        if (r.data.error) toast.error(r.data.error.message)
        else toast.info('这部作品没有取到角色数据')
        return false // 空结果 → 允许调用方（Bangumi 优先时）再试 Jikan
      }
      if (r.data.source === 'legacy') toast.info('角色来自老接口兜底，数量可能少于完整角色表')
      return true
    }

    if (src === 'jikan') {
      const note = { text: '' }
      const ok = await tryJikan(note)
      setLoadingChars(false)
      if (ok) return
      // Jikan 没拿到：回落到 Bangumi，并把原因常驻留在界面上
      toast.warn('Jikan 没取到角色，已回落到 Bangumi')
      const r = await api.bangumi.characters(item.id)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      setChars(r.data.items)
      setResolved({
        kind: r.data.source,
        stale: r.data.stale,
        count: r.data.items.length,
        fallback: note.text || `Jikan 没取到「${item.name_cn || item.name}」的角色`
      })
      if (r.data.source === 'legacy') toast.info('角色来自老接口兜底，数量可能少于完整角色表')
      return
    }

    // 默认路径：Bangumi 优先
    const ok = await tryBangumi()
    setLoadingChars(false)
    if (ok) return
    // Bangumi 没有角色：再用 Jikan 兜一次（用户明确要求 Jikan 作为备选）
    const note = { text: '' }
    const jikanOk = await tryJikan(note)
    if (!jikanOk) {
      setResolved({ kind: 'v0', count: 0, fallback: note.text || 'Bangumi 与 Jikan 都没有取到角色' })
    } else {
      toast.info('Bangumi 没有角色数据，已改用 Jikan（MAL）')
    }
  }, [])

  const selectSubject = useCallback(
    async (item: SearchResultItem) => {
      setSubject(item)
      setChars([])
      setResolved(null)
      try {
        localStorage.setItem(SUBJECT_KEY, JSON.stringify(item))
      } catch {
        /* 存储不可用时忽略：只是刷新后要重新搜一次 */
      }
      await loadChars(item, charSrc)
    },
    [charSrc, loadChars]
  )

  /** 切换数据源：立刻落盘 + 立刻按新源重拉当前作品（用户要能马上就看出差别） */
  const pickSource = useCallback(
    (v: CharSrc): void => {
      if (v === charSrc) return
      setCharSrc(v)
      try {
        localStorage.setItem(SOURCE_KEY, v)
      } catch {
        /* 存储不可用时忽略 */
      }
      toast.info(v === 'jikan' ? '数据源已切到 Jikan（MAL，立绘 225×350）' : '数据源已切到 Bangumi（立绘为原图，更清晰）')
      if (subject) void loadChars(subject, v)
    },
    [charSrc, subject, loadChars]
  )

  /*
   * 恢复上次选中的作品。
   *
   * 注意依赖数组里**不能**放 selectSubject：它的引用随 charSrc 变化，
   * 换数据源时会重新触发这个 effect → 又按 SUBJECT_KEY 重选一次作品 →
   * 加上 pickSource 自己那次重拉，同一次切换会打两遍 Jikan（白吃配额、还会弹两次 toast）。
   * 所以用 ref 保证「只在挂载时恢复一次」；换源的重拉由 pickSource 负责。
   */
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    try {
      const raw = localStorage.getItem(SUBJECT_KEY)
      if (!raw) return
      const item = JSON.parse(raw) as SearchResultItem
      if (item && typeof item.id === 'number' && item.id > 0) void selectSubject(item)
    } catch {
      /* 缓存损坏就当作没有选中作品 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      // 页脚要写实际用到的数据源：把当前来源传进去（没取到过就按用户选的标）
      const kind: ResolvedKind = resolved?.kind ?? (charSrc === 'jikan' ? 'jikan' : 'v0')
      const { blob, missing, width, height } = await exportPng(state, who, kind)
      downloadBlob(blob, exportFilename(state, who, subjectLabel))
      /*
       * 导出成功的提示里带上**实际来源与画布尺寸**：
       * 用户这次的两个诉求（数据源 / 9 格尺寸）都能在这一行里被直接确认，
       * 不必再去猜「到底生效了没有」。
       */
      toast.success(
        `已导出 PNG（${width}×${height}，来源：${resolvedLabel(kind)}）` +
          (missing > 0 ? `；有 ${missing} 张立绘取不到，已用占位色块代替` : '')
      )
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      toast.error(`导出失败：${msg}`)
    } finally {
      setExporting(false)
    }
  }, [state, subjectLabel, resolved, charSrc])

  const untagged = useMemo(
    () => cells.flat().filter((cell) => !cell.label).length,
    [cells]
  )

  /*
   * 导出尺寸与单格立绘框尺寸（界面上的「导出 1096×1788」提示用它）。
   * 数字全部来自 gridMetrics —— 和真正画图时用的是同一个函数，
   * 所以界面上写的尺寸就是导出图的尺寸，不会出现「写着 200 实际画 230」。
   */
  const metrics = useMemo(() => gridMetrics(cols, rows), [cols, rows])
  /** 编辑区预览的单格宽度：给个上限，否则 3×3 在宽窗口里每格能有 300px，立绘被拉糊 */
  const previewW = metrics.nine ? 152 : 120

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
            搜作品 → 点角色装进选中的格子 → 填「制作人」后导出 PNG（角色数据源可在左侧切换：
            Jikan / Bangumi）
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
                  <CoverImage src={pickImage(it.images, 'small')} className="h-12 w-9 shrink-0" rounded="rounded" />
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

          {/*
            ===== 角色数据源 =====
            v0.3.2：**这是本次补上的可见控件**。v0.3.0 只有 charSrc 这个 state 和一个
            （从未被任何控件调用的）pickSource 函数 —— 用户既看不到当前用的是什么，
            也没有任何办法切过去，「切换数据源」自然「没生效」。
            现在：选中态高亮、写在控件上、下面一行常驻说明当前用的是哪一个。
          */}
          <div className="rounded-lg border border-border bg-elev2/50 p-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-dim">角色数据源</span>
              <div className="ml-auto flex rounded-lg border border-border bg-elev1 p-0.5">
                {(
                  [
                    ['jikan', 'Jikan', 'MyAnimeList 原图，立绘更清晰（默认）'],
                    ['bangumi', 'Bangumi', '中文名更准，但立绘偏小']
                  ] as const
                ).map(([v, label, hint]) => (
                  <button
                    key={v}
                    type="button"
                    title={hint}
                    onClick={() => pickSource(v)}
                    className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                      charSrc === v ? 'bg-accent text-white' : 'text-dim hover:text-text'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-faint">
              {charSrc === 'jikan'
                ? '当前：Jikan（MyAnimeList）—— 角色立绘只有 225×350，比 Bangumi 的原图小；取不到角色时自动回落 Bangumi，并在下面写明原因。'
                : '当前：Bangumi —— 立绘取的是**原图**（实测 CLANNAD 角色 2434×3466，与 bgm.tv 角色页同一张），导出不会被放大糊掉；没有角色数据时自动改用 Jikan。'}
            </p>
          </div>

          {/* 角色列表 */}
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-semibold text-dim">
              {subject ? `角色：${subjectLabel}` : '先选一部作品'}
            </span>
            {loadingChars ? <Spinner size={14} /> : null}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {resolved ? (
                <>
                  {/* 徽章写的是**实际取到数据的那一个**（用 Jikan 成功时不再显示成 v0） */}
                  <Badge tone={resolved.kind === 'jikan' ? 'accent' : resolved.kind === 'v0' ? 'neutral' : 'warn'}>
                    {resolvedLabel(resolved.kind)}
                  </Badge>
                  {resolved.stale ? <Badge tone="neutral">缓存</Badge> : null}
                </>
              ) : loadingChars ? (
                <Badge tone="neutral">取角色中…</Badge>
              ) : null}
            </span>
          </div>

          {/* 走 Jikan 成功时：把命中的 MAL 条目写出来，用户能确认「确实是 Jikan 给的」 */}
          {resolved?.kind === 'jikan' && resolved.jikan ? (
            <p className="text-[10px] leading-relaxed text-accent">
              已命中 MAL《{resolved.jikan.animeTitle}》(#{resolved.jikan.malId})，共 {resolved.count} 位角色，
              立绘为 MAL 原图。
            </p>
          ) : null}

          {/* 回落提示：**常驻**在这里，不靠几秒就消失的 toast —— 不写清楚，用户只会以为「Jikan 没生效」 */}
          {resolved?.fallback ? (
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-2 py-1.5">
              <p className="text-[10px] leading-relaxed text-warn">
                Jikan 没取到角色，本次列表用的是「{resolvedLabel(resolved.kind)}」。原因：{resolved.fallback}
              </p>
              {subject ? (
                <button
                  type="button"
                  onClick={() => void loadChars(subject, 'jikan')}
                  className="mt-1 text-[10px] font-semibold text-accent hover:underline"
                >
                  重试 Jikan
                </button>
              ) : null}
            </div>
          ) : null}
          {resolved?.kind === 'legacy' ? (
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
                    <CoverImage src={pickImage(ch.images, 'medium')} className="h-20 w-full" rounded="rounded-md" />
                    <span className="w-full truncate text-[11px]">{charName(ch)}</span>
                    <span className="w-full truncate text-[10px] text-faint">{ch.relation || '—'}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-faint">
              {loadingChars
                ? `正在从 ${charSrc === 'jikan' ? 'Jikan（MyAnimeList）' : 'Bangumi'} 取角色…`
                : subject
                  ? '这部作品暂时没有取到角色，可以换一部作品或切换数据源试试'
                  : '选中作品后这里会列出角色，点角色即可装进当前选中的格子'}
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
            {/*
              导出尺寸写在这里：9 格会收紧单格，用户过去完全看不到这件事 ——
              改的只是导出画布，界面纹丝不动，于是「改了没生效」。
              数字由 gridMetrics 直接算出，与真正画图用的是同一份尺寸。
            */}
            <span className="text-[10px] text-faint">
              · 导出 {metrics.w * EX.S}×{metrics.h * EX.S}
              {metrics.nine ? `（9 格单格 ${metrics.cellW}×${metrics.cellH}，已收紧）` : `（单格 ${metrics.cellW}×${metrics.cellH}）`}
            </span>

            {/*
              立绘填充方式（v0.3.4 新增，默认「完整显示」）。
              默认值的理由就是用户的诉求本身：图区 138×134 近正方形、立绘 2434×3466 竖长，
              cover 只能保住 68% 的高度，上下被裁掉三分之一 —— 用户看到的「展示不完全」正是它。
              「铺满裁剪」作为旧行为保留（有人就想要铺满的观感），切换后预览与导出同时生效。
            */}
            <span className="flex items-center gap-1 text-[11px] text-dim">
              立绘
              <span className="flex rounded-lg border border-border bg-elev1 p-0.5">
                {(
                  [
                    [
                      'contain',
                      '完整显示',
                      '整张立绘等比缩进图区、不裁切；两侧空白用同一张立绘的模糊压暗版填满（默认）'
                    ],
                    ['cover', '铺满裁剪', '按短边铺满图区再裁掉超出部分（旧行为）：格子更满，但竖长立绘会被切掉上下']
                  ] as const
                ).map(([v, label, hint]) => (
                  <button
                    key={v}
                    type="button"
                    title={hint}
                    onClick={() => setFit(v)}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                      fit === v ? 'bg-accent text-white' : 'text-dim hover:text-text'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </span>

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

          {/*
            格子盘面。
            列宽不再用 1fr：宽窗口里 3 列会各自撑到 300px 上下，而 MAL 立绘只有 225px 宽 ——
            预览里立绘被硬拉大 2 倍多，用户看到的就是「立绘不清晰」。
            现在按行列给一个单格宽度上限（9 宫格更小），并把单格比例换成**导出用的真实比例**，
            预览和导出终于对得上（过去这里硬编码 230/276，9 宫格导出改成 200/240 后两者就不一致了）。
          */}
          <div
            className="mt-3 grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${cols}, ${previewW}px)`,
              justifyContent: 'center'
            }}
          >
            {cells.map((row, r) =>
              row.map((cell, c) => {
                const idx = r * cols + c + 1
                const isTarget = target.r === r && target.c === c
                const isSwapFrom = swapFrom?.r === r && swapFrom?.c === c
                const isEditing = editing?.r === r && editing?.c === c
                /** 这一格要画的立绘地址（与导出同一档：large 原图） */
                const art = cell.char ? pickImage(cell.char.images, 'large') : ''
                return (
                  <div
                    key={`${r}-${c}`}
                    onClick={() => onCellClick(r, c)}
                    className={`group relative flex cursor-pointer flex-col gap-1.5 rounded-xl border bg-elev1 p-1.5 transition-colors ${
                      isSwapFrom ? 'border-warn' : isTarget ? 'border-accent' : 'border-border hover:border-accent/60'
                    }`}
                    style={{ aspectRatio: `${metrics.cellW} / ${metrics.cellH}` }}
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
                        <>
                          {/*
                            完整显示时的底：**同一张**立绘 cover 铺满 + 模糊压暗，把 contain 让出来的空白填掉。
                            参数（EX.BACKDROP_FILTER / BACKDROP_PAD）与导出画布里的 drawBackdrop 是同一份，
                            连「向外扩一圈再模糊」这个细节都一样：不扩，模糊的羽化边会在四边泛出一圈亮边。
                            切到「铺满裁剪」时这一层不画 —— 那时立绘自己就把图区填满了。
                          */}
                          {fit === 'contain' && art ? (
                            <div
                              aria-hidden
                              className="absolute"
                              style={{
                                inset: -EX.BACKDROP_PAD,
                                backgroundImage: `url("${imgUrl(art)}")`,
                                backgroundSize: 'cover',
                                backgroundPosition: 'center',
                                filter: EX.BACKDROP_FILTER
                              }}
                            />
                          ) : null}
                          {/*
                            前景立绘。
                            ⚠️ `object-contain!` 的这个 `!` 不能省：CoverImage 是共用组件（本轮不动它），
                            它的 className 里写死了 `object-cover`，而构建产物中 `.object-contain`
                            排在 `.object-cover` **之前**（同特异性 → 后者胜），所以只写 `object-contain`
                            会被静默吃掉、仍然按 cover 裁切。`!` 是 tailwindcss@4 的 important 修饰符
                            （写在类名末尾），用它把 object-fit 可靠地压成 contain。
                          */}
                          <CoverImage
                            src={art}
                            alt={charName(cell.char)}
                            rounded="rounded-md"
                            className={`relative h-full w-full ${fit === 'contain' ? 'object-contain!' : ''}`}
                          />
                        </>
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
            导出为 2 倍图 PNG，单格画「标签 + 立绘 + 名字」，右上角写制作人，页脚写实际用到的数据源；
            立绘由主进程取回并转成 data URL 后再画进画布（避免自定义协议污染画布导致导出失败）。
            立绘默认按**完整显示**画：整张等比缩进图区不裁切（竖长立绘按高度贴合、两侧空白用同一张立绘的
            模糊压暗版填满），想看铺满的效果可以切「立绘：铺满裁剪」，两档都由预览与导出共用同一套几何与绘制函数。
            画布开着高质量重采样，并且**源图比目标框小时按 1:1 设备像素居中绘制、不放大**
            （放大只会更糊；注意这一条只作用于「铺满裁剪」，完整显示必须和 CSS 的 object-fit: contain 一致）。
            9 宫格的单格也特意收紧，格子越小立绘被放大的倍数越小，越清晰。
            盘面与标签、制作人、数据源、立绘填充方式都会存到本地，刷新不丢。
          </p>
        </section>
      </div>
    </div>
  )
}

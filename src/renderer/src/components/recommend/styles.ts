import type { CSSProperties } from 'react'
import type { ModuleKind, ModuleRect, RecommendBackground } from '@/stores/recommendTable'
import { DEFAULT_MODULES, MODULE_KINDS } from '@/stores/recommendTable'

/**
 * 「番剧推荐表」的**版式常量 + 样式生成器** —— 界面预览与导出图共用同一份。
 *
 * ## 为什么这个文件必须存在
 *
 * 用户的要求是「编辑界面的版式必须和导出图一致（所见即所得）」，而这两边是**两套渲染器**：
 *   · `RecommendPageCard.tsx` —— React + 行内样式，画在窗口里；
 *   · `exportHtml.ts` —— 拼成 HTML 字符串 + 内联 CSS，交给主进程离屏渲染成 PNG。
 * 所以这里定的规矩是：**样式只有一份**。每个函数返回一个「CSS 声明表」
 * （`{ position: 'absolute', left: '24px', … }`，值一律字符串），然后：
 *   · 预览用 `asReactStyle(rec)` 直接塞给 React 的 `style`（React 接受这类键值）；
 *   · 导出用 `cssText(rec)` 拼成 `style="…"`（把 camelCase 转成 kebab-case）。
 * 于是「预览这里是 24px、导出就是 24px」是**代码结构**保证的，不靠人记得同步改两处 ——
 * v0.3.8 的模块、背景图区、交融渐变全要两边一致，这是唯一还能守住一致性的写法。
 *
 * ## 页面坐标系（v0.3.8 第三轮）
 *
 * 一页 = 一块 **1200 宽**的画布（高度见 `frameOf`），它被切成两块：
 *   · **图区**（只有设了图片背景才有）与**内容区**（模块都画在这里），比例固定 1.5 : 1；
 *   · 模块位置**不能自定义**（用户方向调整后取消了自由拖动），一律由 `moduleRectsOf(frame)` 现算 ——
 *     所以"界面看到的就是导出的"这件事不再依赖两份坐标同步，只依赖这一个函数。
 *   · 预览把整块画布用 CSS `transform: scale()` 缩小（只影响屏幕，不影响导出像素）。
 *
 * ## 背景的层（从下到上）
 *
 *   1. 页面**底色**：纯色 / 渐变，或图片背景时的白色（图只画在图区里）；
 *   2. **图区**那一层图片（`cover` 裁剪，可模糊；模糊时向外多铺一点以免露出底色边）；
 *   3. **交融渐变**：贴着图区靠内容区的一侧，从透明渐隐到页面底色 —— 图与内容区之间没有硬边。
 *
 * ⚠️ 模块**没有白底**（v0.3.8 第三轮去掉的）：文字直接落在页面上，
 * 可读性由 `TEXT_SHADOW` 的白色晕圈负责（白底上完全看不出来，深色/照片背景上把字勾出来）。
 *
 * ## 配色为什么写死浅色
 *
 * 导出图是给分享用的，必须不跟随应用主题。预览也用同一套浅色，好处是「看到的就是导出的」。
 */

/** 版式几何常量（px） */
export const RL = {
  /** 页面宽度 = 导出图片的最大宽度（用户要求：不要再按内容收窄） */
  width: 1200,
  /** 默认页面高度（**没有图片背景**时）＝整页都是内容区，就用这套 1200×920 */
  baseHeight: 920,
  /** 页面高度下限 */
  minHeight: 400,
  /** 页面高度上限：离屏截图有高度上限，所以页面不能无限高 */
  maxHeight: 3200,
  /** 页面边框 */
  borderW: 1,
  /** 页面圆角 */
  radius: 18,
  /** 代码里不再有模块白板（v0.3.8 第二轮去掉），但封面/剧照仍然要圆角 */
  photoRadius: 10,
  /** 头部：番剧名 / 原名 / 推荐人署名 */
  titleSize: 34,
  titleLine: 42,
  subSize: 16,
  subLine: 24,
  recSize: 15,
  /** 信息行（评分 / 指数 / 时间 / 标签） */
  labelSize: 15,
  labelW: 92,
  valueSize: 19,
  rowH: 26,
  rowGap: 12,
  /** 推荐指数星号 */
  starSize: 24,
  /** 小节标题（「推荐理由」「剧照」）占的高度：22 行高 + 8 下边距 */
  secTitleSize: 15,
  secH: 30,
  /** 推荐理由正文 */
  reasonSize: 18,
  reasonLine: 31,
  /** 剧照：**整页版式**下的单元格高（宽按 148:92 的比例），间距 12 */
  photoH: 92,
  photoAspect: 148 / 92,
  photoGap: 12,
  /** 页脚 */
  footSize: 13,
  /** 预览区四周的底色留白（导出那边横向不留白，见 bodyPadV） */
  sheetPad: 18,
  /** 导出图 body 的上下留白（横向必须是 0，否则正好铺满宽度的页面会被裁） */
  bodyPadV: 24,
  /** 长图里两页之间的分页间距 */
  splitH: 46
} as const

/**
 * **图区 : 内容区 = 1.5 : 1**（用户明确要求的比例）。
 *
 * 由此推出图区占整体宽（或高）的比例 = 1.5 / (1.5 + 1) = 0.6，即 IMAGE_BAND_FRACTION。
 * 1200 宽的页面在左/右图时：图区 720、内容区 480；上图时按高度切同样的比例（图区占 60% 高）。
 * 比例写在常量里、界面与导出都从这里算，所以不存在"预览和导出比例不一样"。
 */
export const IMAGE_CONTENT_RATIO = 1.5
/** 图区占整页宽（左/右）或高（上）的比例 = 0.6 */
export const IMAGE_BAND_FRACTION = IMAGE_CONTENT_RATIO / (IMAGE_CONTENT_RATIO + 1)

/**
 * 交融渐变的宽度（px）：图区靠内容区的那一侧，用这么宽一条从"透明"渐隐到**页面底色**，
 * 让图与内容区之间没有硬边（用户要求「纯色渐变交融」）。
 * 这条渐变完全在图区内部，结束位置正好是边界线 —— 所以边界处的颜色与内容区底色**严格相等**，
 * 不会出现任何接缝；也正因为如此，它取代了上一版那个"叠加渐变层"控件
 * （两套相似旋钮合并成一套，见 BackgroundDialog 的说明）。
 */
export const BLEND_FEATHER = 150

/**
 * 左侧/右侧图版式下，内容区那一列的纵向排布（内容区宽 480）。
 *
 * 一列只有 480 宽，原来那套"左封面 + 右信息"的两栏排法塞不下，所以改成**纵向堆叠**：
 * 标题 → 封面（居中）→ 评分 → 指数 → 时间标签 → 理由 → 剧照 → 页脚。
 * 数字是每块的高度（px），`SIDE_CONTENT_H` 是这一列需要的总高（含间距与上下留白），
 * 页面高度至少要这么高，内容才不会被切掉（见 frameOf）。
 */
export const SIDE_STACK = {
  pad: 24,
  gap: 14,
  title: 128,
  cover: 426,
  ratings: 78,
  level: 40,
  meta: 116,
  reason: 250,
  photos: 170,
  foot: 30,
  /** 剧照单元格高度：480 宽的一列里一行放 3 张（3×104 + 2×12 = 336 ≤ 432） */
  photoCellH: 64
} as const

/** 侧栏版式下内容区需要的总高度（由上面的常量算出来，别手写数字） */
export const SIDE_CONTENT_H =
  SIDE_STACK.pad * 2 +
  SIDE_STACK.title +
  SIDE_STACK.cover +
  SIDE_STACK.ratings +
  SIDE_STACK.level +
  SIDE_STACK.meta +
  SIDE_STACK.reason +
  SIDE_STACK.photos +
  SIDE_STACK.foot +
  SIDE_STACK.gap * 7

/**
 * 文字描边（v0.3.8 第二轮：模块**不再有白底**，靠它保证可读性）。
 *
 * 为什么是"白色晕圈"而不是深色投影：白色晕圈在**白底页面上完全看不出来**（默认版式外观不变），
 * 而深色/照片背景上它能立刻把深色文字勾出来 —— 一种写法同时满足两种场景。
 * 界面与导出同源：这个常量被所有文字样式引用（titleTextStyle / infoValueStyle / reasonTextStyle …）。
 */
export const TEXT_SHADOW = '0 0 3px rgba(255, 255, 255, 0.95), 0 0 9px rgba(255, 255, 255, 0.8)'

/** 导出图配色（固定浅色，见文件头） */
export const RC = {
  sheet: '#f3f4f6',
  card: '#ffffff',
  border: '#e6e8eb',
  text: '#111827',
  dim: '#4b5563',
  faint: '#9ca3af',
  accent: '#e0577f',
  accentSoft: '#fdeaf1',
  star: '#f59e0b',
  starEmpty: '#d1d5db',
  chipBg: '#f4f5f7',
  /** 封面/剧照取不到时的占位底色 */
  imageBg: '#eceef1'
} as const

/** 字体栈：离屏窗口不加载外部资源，只能用系统字体；两边用同一串，换行位置才会一致 */
export const FONT =
  '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Segoe UI", system-ui, sans-serif'

// ------------------------------------------------------------------
// 样式表：一份定义、两个渲染器
// ------------------------------------------------------------------

/** 一条 CSS 声明（键用 camelCase，与 React 一致；导出时转 kebab-case） */
export type StyleRecord = Record<string, string>

/** 预览用：直接交给 React 的 style。值都是合法的 CSS 字符串，所以这个断言是安全的 */
export function asReactStyle(rec: StyleRecord): CSSProperties {
  return rec as unknown as CSSProperties
}

/** 导出用：拼进 `style="…"`。camelCase → kebab-case */
export function cssText(rec: StyleRecord): string {
  return Object.entries(rec)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${v}`)
    .join('; ')
}

/**
 * 合并两条样式（后面的覆盖前面的）。
 *
 * 用途是「在基础样式上叠一层」：例如空推荐理由既要有正文的字号行高，又要换成淡色 ——
 * 预览那边写 `{...base, ...dim}` 很容易，但导出那边是字符串，得有个统一做法；
 * 这里给一个函数，两边都调它，行为才一致。
 */
export function blend(base: StyleRecord, over: StyleRecord): StyleRecord {
  return { ...base, ...over }
}

// ------------------------------------------------------------------
// 文本口径（界面上显示的文案 = 导出图上的文案）
// ------------------------------------------------------------------

/** 展示用番剧名：中文名优先，没有才用原名 */
export function displayName(p: { nameCn: string; name: string }): string {
  const cn = p.nameCn.trim()
  if (cn) return cn
  return p.name.trim() || '未命名'
}

/** 副标题（原名）：与展示名相同或为空时返回空串（不重复画一遍同样的字） */
export function subName(p: { nameCn: string; name: string }): string {
  const raw = p.name.trim()
  if (!raw) return ''
  return raw === displayName(p) ? '' : raw
}

/**
 * 「x / 10」形式的评分。
 * `emptyText` 由调用方给：bangumi 评分取不到是「我们没拿到」（—），
 * 推荐人评分没填是「用户还没打分」（未评分）。
 */
export function scoreText(v: number | null, emptyText = '—'): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)} / 10` : emptyText
}

/** 播出时间文案（取不到时说实话） */
export function airDateText(v: string | null): string {
  return v && v.trim() ? v.trim() : '未知'
}

/** 类型标签最多画几个（放不下就换成「+N」） */
export const MAX_GENRE_CHIPS = 6

export function genreChips(genres: string[]): { list: string[]; rest: number } {
  const list = genres.slice(0, MAX_GENRE_CHIPS)
  return { list, rest: Math.max(0, genres.length - list.length) }
}

/** 推荐指数：5 个星位里亮几个 */
export function levelParts(level: number): { on: number; off: number } {
  const on = Math.min(5, Math.max(0, Math.round(level)))
  return { on, off: 5 - on }
}

/** 页脚页码文案：`第 1 / 3 页`（只导当前页时显示的也是它在整张表里的真实页码） */
export function pageNoText(index: number, total: number): string {
  return `第 ${Math.max(1, index)} / ${Math.max(1, total)} 页`
}

// ------------------------------------------------------------------
// 颜色与渐变
// ------------------------------------------------------------------

/** `#rrggbb` → `{r,g,b}`；非法给白色（渲染层不抛错，最多颜色不对） */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const s = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : 'ffffff'
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16)
  }
}

/** 色值 + 不透明度 → `rgba(...)`；alpha 为 1 时直接用十六进制（更好读） */
export function colorWithAlpha(hex: string, alpha: number): string {
  if (alpha >= 1) return hex
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`
}

/** 一个渐变层的 CSS 值（色标按位置排序，位置小的在前） */
export function gradientCss(layer: {
  angle: number
  stops: { color: string; pos: number; alpha: number }[]
}): string {
  const stops = [...layer.stops]
    .sort((a, b) => a.pos - b.pos)
    .map((s) => `${colorWithAlpha(s.color, s.alpha)} ${s.pos}%`)
    .join(', ')
  return `linear-gradient(${layer.angle}deg, ${stops})`
}

/** 背景层的模糊半径（px） */
export function blurOf(bg: RecommendBackground | undefined): number {
  return bg && Number.isFinite(bg.blur) ? Math.max(0, bg.blur) : 0
}

// ------------------------------------------------------------------
// 页面框：图区 + 内容区（v0.3.8 第三轮）
// ------------------------------------------------------------------

/** 页面被切成两块：图区（背景图）与内容区（模块）。没有图片背景时图区为空、内容区 = 整页。 */
export interface PageFrame {
  width: number
  height: number
  /** 图片位置；none = 没有图片背景 */
  pos: 'none' | 'left' | 'right' | 'top'
  /** 内容区（模块都在这里面） */
  contentX: number
  contentY: number
  contentW: number
  contentH: number
  /** 图区（pos === 'none' 时不用画） */
  imageX: number
  imageY: number
  imageW: number
  imageH: number
  /** 剧照单元格高度：整页版式 92，侧栏版式 64（见 SIDE_STACK.photoCellH） */
  photoCellH: number
  /** 内容区是不是"侧栏一列"（左/右图）——决定模块是纵向堆叠还是原来的两栏排法 */
  side: boolean
}

function clampNum(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/**
 * 算出一页的框：总尺寸、图区、内容区，以及页面高度。
 *
 * ## 比例与高度的公式（这是本轮的核心，界面与导出都只用这一个函数）
 *
 *   · **图区 : 内容区 = 1.5 : 1**（常量 `IMAGE_CONTENT_RATIO`）：
 *     - 左/右图：整体宽度按比例切 → 图区 `round(1200 × 0.6) = 720`，内容区 `480`；
 *     - 上图：整体**高度**按同样比例切 → 图区高 `round(H × 0.6)`，内容区 `H − 图区高 = 0.4H`。
 *   · **上图**的内容区仍是 1200 宽（用整页那套模块摆放），因此必须放得下它需要的 920：
 *     `0.4H ≥ 920` → `H ≥ 2300`。所以 `H = clamp(max(2300, 原图比例算出的高度), …)`。
 *   · **左/右图**的内容区是 480 宽的一列，改用纵向堆叠（`SIDE_STACK`），
 *     它需要 `SIDE_CONTENT_H` 这么高 → `H = clamp(max(SIDE_CONTENT_H, 原图比例算出的高度), …)`。
 *     「原图比例算出的高度」沿用上一轮的规则：`round(1200 × 图高 / 图宽)`，
 *     所以竖图仍然会让页面变高（图区跟着变高，而不是把图挤扁）。
 *   · 高度一律夹在 `[baseHeight, maxHeight]`：太矮内容会被切、太高会撞离屏截图的上限。
 *
 * 比例在两种切法里都是**精确**的：左/右按宽度 720:480 = 1.5，上图按高度 0.6H:0.4H = 1.5。
 */
export function frameOf(page: { background?: RecommendBackground }): PageFrame {
  const bg = page.background
  const W = RL.width
  const isImage = !!bg && bg.kind === 'image'
  const pos: PageFrame['pos'] = isImage ? bg.imagePos : 'none'

  if (!isImage) {
    return {
      width: W,
      height: RL.baseHeight,
      pos: 'none',
      contentX: 0,
      contentY: 0,
      contentW: W,
      contentH: RL.baseHeight,
      imageX: 0,
      imageY: 0,
      imageW: 0,
      imageH: 0,
      photoCellH: RL.photoH,
      side: false
    }
  }

  // 原图比例推出的页面高度（沿用上一轮规则的同一套公式）
  const ratioH =
    bg.imgW > 0 && bg.imgH > 0 ? Math.round((W * bg.imgH) / bg.imgW) : 0

  if (pos === 'top') {
    // 内容区 = 0.4H 且要放下 920 → H 至少 920/0.4 = 2300
    const minH = Math.ceil(RL.baseHeight / (1 - IMAGE_BAND_FRACTION))
    const height = Math.round(clampNum(Math.max(minH, ratioH), RL.baseHeight, RL.maxHeight))
    const imageH = Math.round(height * IMAGE_BAND_FRACTION)
    return {
      width: W,
      height,
      pos,
      contentX: 0,
      contentY: imageH,
      contentW: W,
      contentH: height - imageH,
      imageX: 0,
      imageY: 0,
      imageW: W,
      imageH,
      photoCellH: RL.photoH,
      side: false
    }
  }

  const imageW = Math.round(W * IMAGE_BAND_FRACTION)
  const contentW = W - imageW
  const height = Math.round(clampNum(Math.max(SIDE_CONTENT_H, ratioH), RL.baseHeight, RL.maxHeight))
  const imageX = pos === 'left' ? 0 : contentW
  const contentX = pos === 'left' ? imageW : 0
  return {
    width: W,
    height,
    pos,
    contentX,
    contentY: 0,
    contentW,
    contentH: height,
    imageX,
    imageY: 0,
    imageW,
    imageH: height,
    photoCellH: SIDE_STACK.photoCellH,
    side: true
  }
}

/** 一页的画布高度（= frameOf 的高度；保留这个函数名是因为弹窗与导出都在用它） */
export function pageHeightOf(page: { background?: RecommendBackground }): number {
  return frameOf(page).height
}

/**
 * 一页里 8 个模块的矩形（px，页面坐标系）。
 *
 * 两种排法：
 *   · **整页版式**（无图 / 上图）：用 store 的 `DEFAULT_MODULES`（1200×920 那套），
 *     上图时整体下移一个图区高度；换成 480 宽的侧栏会把两栏挤坏，所以不缩排。
 *   · **侧栏版式**（左/右图）：内容区 480 宽，改成纵向堆叠一列
 *     （标题 → 封面居中 → 评分 → 指数 → 时间标签 → 理由 → 剧照 → 页脚），
 *     每块高度取自 `SIDE_STACK`，封面与剧照按更小的尺寸（剧照一行 3 张）。
 *
 * 用户不能改位置（v0.3.8 第三轮取消了自定义移动），所以这份矩形**两边现算同一份**，
 * 界面与导出不可能不一致。
 */
export function moduleRectsOf(frame: PageFrame): Record<ModuleKind, ModuleRect> {
  const out = {} as Record<ModuleKind, ModuleRect>
  if (!frame.side) {
    for (const id of MODULE_KINDS) {
      const r = DEFAULT_MODULES[id]
      out[id] = { x: r.x + frame.contentX, y: r.y + frame.contentY, w: r.w, h: r.h }
    }
    return out
  }
  const pad = SIDE_STACK.pad
  const x = frame.contentX + pad
  const w = frame.contentW - pad * 2
  let y = frame.contentY + pad
  const put = (id: ModuleKind, h: number, xOverride = x, wOverride = w): void => {
    out[id] = { x: xOverride, y, w: wOverride, h }
    y += h + SIDE_STACK.gap
  }
  put('title', SIDE_STACK.title)
  // 封面按原始尺寸居中（300×426：480 宽的一列放得下）
  const coverW = DEFAULT_MODULES.cover.w
  put('cover', DEFAULT_MODULES.cover.h, frame.contentX + Math.round((frame.contentW - coverW) / 2), coverW)
  put('ratings', SIDE_STACK.ratings)
  put('level', SIDE_STACK.level)
  put('meta', SIDE_STACK.meta)
  put('reason', SIDE_STACK.reason)
  put('photos', SIDE_STACK.photos)
  put('foot', SIDE_STACK.foot)
  return out
}

// ------------------------------------------------------------------
// 页面与模块样式
// ------------------------------------------------------------------

/**
 * 页面**底色**。
 *
 * 图片背景时底色是**白**：图只画在图区里（v0.3.8 第三轮起不再铺满整页），
 * 内容区就落在这层底色上 —— 交融渐变也是渐隐到这个颜色，所以它必须与 `blendStyle` 里的取色一致。
 */
export function pageBackgroundCss(bg: RecommendBackground | undefined): string {
  if (!bg) return RC.card
  if (bg.kind === 'color') return bg.color
  if (bg.kind === 'gradient') return gradientCss({ angle: bg.angle, stops: bg.stops })
  return RC.card
}

/** 页面外框：背景层与所有模块的定位上下文 */
export function pageStyle(frame: PageFrame): StyleRecord {
  return {
    position: 'relative',
    boxSizing: 'border-box',
    width: `${frame.width}px`,
    height: `${frame.height}px`,
    background: RC.card,
    border: `${RL.borderW}px solid ${RC.border}`,
    borderRadius: `${RL.radius}px`,
    overflow: 'hidden',
    fontFamily: FONT,
    color: RC.text,
    /*
     * 文字描边**只在这一处设**：`text-shadow` 是继承属性，子元素（标题 / 信息行 / 理由 / 页脚…）
     * 会自动带上，所以不必在每个文字样式里各写一遍 —— 这正是"模块没有白底之后靠一层白晕
     * 保证可读性"最省事、也最不容易漏的做法（漏一处就有一块字看不清）。
     * 图片类元素（封面、剧照）不是文字，不受影响。
     */
    textShadow: TEXT_SHADOW
  }
}

/** 图区外层：负责裁剪（模糊时不会糊出边界） */
export function imageBandWrapStyle(frame: PageFrame): StyleRecord | null {
  if (frame.pos === 'none') return null
  return {
    position: 'absolute',
    left: `${frame.imageX}px`,
    top: `${frame.imageY}px`,
    width: `${frame.imageW}px`,
    height: `${frame.imageH}px`,
    overflow: 'hidden',
    zIndex: '0'
  }
}

/**
 * 图区里的图片层。
 *
 * 模糊时向外多铺 `blur + 6` px：CSS 的 blur 会把图层边缘一起糊掉，
 * 不往外铺就会在四周露出一圈底色（看起来像"白边"）。外层已经 `overflow: hidden`，多铺也不会溢出图区。
 */
export function imageBandImageStyle(
  frame: PageFrame,
  bg: RecommendBackground | undefined,
  resolveImage: (path: string) => string
): StyleRecord {
  const b = blurOf(bg)
  const grow = b > 0 ? b + 6 : 0
  return {
    position: 'absolute',
    left: `${-grow}px`,
    top: `${-grow}px`,
    width: `${frame.imageW + grow * 2}px`,
    height: `${frame.imageH + grow * 2}px`,
    background: bg && bg.kind === 'image' ? `${resolveImage(bg.path)} center/cover no-repeat` : RC.imageBg,
    filter: b > 0 ? `blur(${b}px)` : 'none'
  }
}

/**
 * **交融渐变**：贴在图区靠内容区的那一侧，从透明渐隐到页面底色（白）。
 *
 * 这条渐变整条都在图区内部、结束位置正好落在边界线上，所以边界处的颜色与内容区底色严格相等
 * —— 没有硬边、也没有接缝（用户要求的"纯色渐变交融"）。
 * 它取代了上一版那个"叠加渐变层"控件：功能重叠，两套相似旋钮不如一套自动生效的。
 */
export function blendStyle(frame: PageFrame): StyleRecord {
  const f = BLEND_FEATHER
  const base = RC.card
  const from = `rgba(255, 255, 255, 0)`
  if (frame.pos === 'left') {
    return {
      position: 'absolute',
      left: `${frame.imageX + frame.imageW - f}px`,
      top: '0',
      width: `${f}px`,
      height: `${frame.height}px`,
      background: `linear-gradient(to right, ${from} 0%, ${base} 100%)`,
      zIndex: '1'
    }
  }
  if (frame.pos === 'right') {
    return {
      position: 'absolute',
      left: `${frame.imageX}px`,
      top: '0',
      width: `${f}px`,
      height: `${frame.height}px`,
      background: `linear-gradient(to right, ${base} 0%, ${from} 100%)`,
      zIndex: '1'
    }
  }
  return {
    position: 'absolute',
    left: '0',
    top: `${frame.imageY + frame.imageH - f}px`,
    width: `${frame.width}px`,
    height: `${f}px`,
    background: `linear-gradient(to bottom, ${from} 0%, ${base} 100%)`,
    zIndex: '1'
  }
}

/**
 * 模块外框：绝对定位到版式算出来的矩形上。
 *
 * v0.3.8 第三轮起**没有白板**（用户要求去掉模块自带的底），所以这里只有位置与裁剪；
 * 文字的可读性交给 `TEXT_SHADOW` 的白色晕圈。
 * z 用 MODULE_KINDS 的顺序（2 起，给背景层 0 与交融层 1 让位），后画的盖住先画的。
 */
export function moduleBoxStyle(rect: ModuleRect, order: number): StyleRecord {
  return {
    position: 'absolute',
    boxSizing: 'border-box',
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.w}px`,
    height: `${rect.h}px`,
    zIndex: String(order + 2),
    // 内容超出模块就裁掉：版式是固定的，宁可裁掉也不让它盖住别的模块
    overflow: 'hidden'
  }
}

/** 模块内的正文区（通用列布局） */
export function moduleInnerStyle(gap: number): StyleRecord {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: `${gap}px`,
    width: '100%',
    height: '100%'
  }
}

/** 一行信息（标签 + 值） */
export function infoRowStyle(): StyleRecord {
  return { display: 'flex', alignItems: 'flex-start', gap: '10px' }
}

export function infoLabelStyle(): StyleRecord {
  return {
    width: `${RL.labelW}px`,
    flexShrink: '0',
    fontSize: `${RL.labelSize}px`,
    lineHeight: `${RL.rowH}px`,
    color: RC.faint
  }
}

export function infoValueStyle(): StyleRecord {
  return {
    flex: '1',
    minWidth: '0',
    fontSize: `${RL.valueSize}px`,
    lineHeight: `${RL.rowH}px`,
    color: RC.text
  }
}

/** 标题模块：番剧名 */
export function titleTextStyle(): StyleRecord {
  return {
    fontSize: `${RL.titleSize}px`,
    lineHeight: `${RL.titleLine}px`,
    fontWeight: '700',
    color: RC.text,
    margin: '0',
    wordBreak: 'break-word'
  }
}

/** 原名 */
export function subTextStyle(): StyleRecord {
  return {
    fontSize: `${RL.subSize}px`,
    lineHeight: `${RL.subLine}px`,
    color: RC.faint,
    marginTop: '2px',
    wordBreak: 'break-word'
  }
}

/** 推荐人署名（标题下方那一行） */
export function recTextStyle(): StyleRecord {
  return {
    fontSize: `${RL.recSize}px`,
    lineHeight: `${RL.subLine}px`,
    color: RC.accent,
    marginTop: '4px'
  }
}

/** 小节标题（推荐理由 / 剧照） */
export function secTitleStyle(): StyleRecord {
  return {
    fontSize: `${RL.secTitleSize}px`,
    lineHeight: '22px',
    fontWeight: '700',
    color: RC.accent,
    marginBottom: '8px'
  }
}

/** 推荐理由正文 */
export function reasonTextStyle(): StyleRecord {
  return {
    fontSize: `${RL.reasonSize}px`,
    lineHeight: `${RL.reasonLine}px`,
    color: RC.text,
    // 用户按回车分段要保留（推荐理由常写成几段）
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: '0'
  }
}

/** 淡色占位文案（「暂无标签」） */
export function dimTextStyle(): StyleRecord {
  return { fontSize: `${RL.valueSize}px`, lineHeight: `${RL.rowH}px`, color: RC.faint }
}

/** 空理由 / 空剧照提示 */
export function emptyHintStyle(): StyleRecord {
  return { fontSize: `${RL.reasonSize}px`, lineHeight: `${RL.rowH}px`, color: RC.faint }
}

/** 评分数字（加粗一点，在信息行里跳出来） */
export function scoreTextStyle(): StyleRecord {
  return { fontWeight: '700' }
}

/** 星星：亮 / 暗两段 */
export function starStyle(filled: boolean): StyleRecord {
  return {
    fontSize: `${RL.starSize}px`,
    lineHeight: `${RL.rowH}px`,
    color: filled ? RC.star : RC.starEmpty,
    letterSpacing: '2px'
  }
}

/** 类型标签的小胶囊（rest=true 是那个「+N」） */
export function chipStyle(rest: boolean): StyleRecord {
  return {
    display: 'inline-block',
    padding: '3px 12px',
    marginRight: '8px',
    marginBottom: '6px',
    borderRadius: '999px',
    background: rest ? RC.accentSoft : RC.chipBg,
    color: rest ? RC.accent : RC.dim,
    fontSize: `${15}px`,
    lineHeight: '20px'
  }
}

/** 封面图：铺满模块（cover 裁剪，不拉伸） */
export function coverImageStyle(): StyleRecord {
  return {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
    borderRadius: `${RL.photoRadius}px`,
    background: RC.imageBg
  }
}

/** 剧照行的容器（一行放不下就换行） */
export function photoRowStyle(): StyleRecord {
  return { display: 'flex', flexWrap: 'wrap', gap: `${RL.photoGap}px` }
}

export function photoBoxStyle(w: number, h: number): StyleRecord {
  return {
    width: `${w}px`,
    height: `${h}px`,
    flexShrink: '0',
    borderRadius: '10px',
    overflow: 'hidden',
    background: RC.imageBg
  }
}

export function photoImgStyle(): StyleRecord {
  return { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
}

/** 页脚（左右两端） */
export function footRowStyle(): StyleRecord {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    fontSize: `${RL.footSize}px`,
    lineHeight: '20px',
    color: RC.faint
  }
}

/**
 * 剧照单元格尺寸。
 *
 * 高度取「模块能放下的高度」与「版式给的单元格高度」里更小的那个：
 *   · 整页版式 92（一行 5 张刚好铺满 804 宽），侧栏版式 64（480 宽的一列一行 3 张）；
 *   · 宽度按固定的 148:92 比例算，所以不论哪种版式，剧照都不会被拉变形；
 *   · 一行放不下会自动换行（`flexWrap`），放不下的行由模块的 `overflow: hidden` 裁掉。
 */
export function photoCellSize(m: { h: number }, frame: PageFrame): { w: number; h: number } {
  const avail = m.h - RL.secH
  const h = Math.max(20, Math.min(frame.photoCellH, avail))
  return { w: Math.round(h * RL.photoAspect), h }
}


/** 预览区底色（页面外的灰底 + 留白） */
export const sheetStyle: CSSProperties = {
  background: RC.sheet,
  padding: RL.sheetPad
}

/** 一页的背景状态文案（右键菜单、模块面板里显示当前状态） */
export function backgroundKindText(bg: RecommendBackground | undefined): string {
  if (!bg) return '无'
  const base = bg.kind === 'color' ? '纯色' : bg.kind === 'gradient' ? '渐变' : '图片'
  const extra: string[] = []
  if (bg.kind === 'image') {
    extra.push(bg.imagePos === 'left' ? '左侧图区' : bg.imagePos === 'right' ? '右侧图区' : '上方图区')
  }
  if (blurOf(bg) > 0) extra.push(`模糊 ${blurOf(bg)}px`)
  return extra.length > 0 ? `${base}（${extra.join(' · ')}）` : base
}


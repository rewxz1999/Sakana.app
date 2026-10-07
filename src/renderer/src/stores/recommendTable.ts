import { create } from 'zustand'
import type { CoverImages, FavoriteItem, Rating, SearchResultItem, SeasonItem } from '@shared/types'
import { api } from '@/lib/api'
import { coverFields } from '@/stores/customHistory'

/**
 * 「番剧推荐表」数据层（工具页入口 `/tools/recommend-table`，v0.3.7 用户需求）。
 *
 * 用户要的东西：自建一张推荐表（表名自定义）→ 搜索或从**当季番剧**里挑作品，
 * **一页一部**翻页阅览 → 导出成图片（只导当前页，或把多页拼成一张长图，长图最多 5 页）。
 * 每页上要有：封面、番剧名、bangumi 评分、推荐人评分、推荐指数（1–5 星）、播出时间、类型标签、
 * 推荐理由（≤300 字）与剧照；右键当前页可改后四项里的评分 / 指数 / 理由 / 剧照。
 *
 * ============================ 几个刻意的取舍（以后要改先看这段） ============================
 *
 * ① **持久化：挂载时整份读 → 收窄 → 每次改动整份写回**，命名空间 `sakana-recommend`。
 *    与 `stores/customHistory.ts` 同一套做法（本项目的本地工具数据都是这个模式）：
 *    数据量小（一张表几十页）、单窗口写入，不需要主进程当唯一写入方；
 *    代价是「两个窗口同时编辑会互相覆盖」，但推荐表本来就是一个人慢慢编的东西。
 *    落盘结构 `{ tables, recommender, panelHidden }` 是**对象**而不是裸数组：
 *    以后要加「导出偏好」之类的全局字段时不用再迁移一次磁盘格式。
 *
 * ② **一页 = 一部番剧，页序 = 数组顺序**（没有额外的 order 字段）。
 *    翻页、导出页码、长图拼接顺序全部只看数组下标 —— 三个地方各记一份顺序迟早会不一致。
 *
 * ③ **封面存两个字段**（`cover` 给界面、`covers` 给导出），沿用自建历史表的取舍：
 *    界面用 common 档（约 200×300，列表/预览加载快），导出用 large 优先的候选链
 *    （导出图按 2–3 倍放大，拿小图会被放糊）。这里直接复用 `coverFields()`，
 *    免得两套档位规则各写一遍以后漂移。
 *
 * ④ **推荐指数默认 3（不是 5）**：新加的一页还没有被推荐过，默认给满分等于替用户表态；
 *    3 是中间值，页面上会显示成三星，用户右键改一下就行（见 DEFAULT_LEVEL）。
 *
 * ⑤ **类型标签与播出时间在「加入」后异步补齐**：搜索结果与季度列表都**不返回 tags**
 *    （只有详情接口 `api.bangumi.subject()` 有），所以加进来时先存空数组，
 *    再发一次详情请求回填（`backfill`）。离线时这一页就先没有标签，
 *    页面上（右键菜单）随时可以再补一次，不会假装「这部番没有类型」。
 *    从**收藏**加进来的不需要补（收藏条目自带 genres / rating / airDate），见 pageInputFromFavorite。
 *
 * ⑥ **背景按页存**（v0.3.7 追加需求 3）：一页一部番剧，每部的色调不同；
 *    整表统一的诉求由 `applyBackground()`（「应用到所有页」按钮）覆盖，反过来补不上。
 *    背景是纯装饰，收窄时非法一律回成白底（见 normalizeBackground）。
 *
 * ⑦ **左侧面板的收起状态是偏好**：存进同一份数据（`panelHidden`），
 *    用户收起它是为了让推荐卡占满窗口，重启后还该是收起的。
 */

/** 持久化命名空间（用户指定） */
export const RECOMMEND_STORE_KEY = 'sakana-recommend'

/**
 * 推荐理由字数上限。
 *
 * 界面输入限制、落盘收窄、导出前的校验都用这一个数字：
 * 版式给理由留的高度是固定的（见 components/recommend/styles.ts），超过 300 字就会把卡片撑变形，
 * 所以「拦住」必须发生在**输入**和**落盘**两处，而不是等导出时再截断（那样用户看到的是残缺的理由）。
 */
export const REASON_MAX = 300

/**
 * 每页剧照上限。
 *
 * 与版式绑死：剧照一行 5 张（5×148 + 4×12 = 788）刚好放得下右列的**最大**宽度（804），
 * 第 6 张就要换行、卡片高度随之变化 —— 而长图是按「每页等高」拼的，
 * 所以上限写在这里，由界面和导出共用（右列宽度按内容自适应，见 styles.ts 的 rightWidthOf）。
 */
export const MAX_PHOTOS = 5

/**
 * 长图最多拼接的页数（用户明确要求「最多 5 个页面」）。
 *
 * 上限不是随便定的：一页约 830 CSS px 高，5 页 + 分页间距 ≈ 4300，
 * 按 3 倍导出 ≈ 12900 px，还在 Chromium 离屏截图的安全高度（16000）之内；
 * 再多就会撞上 MAX_HEIGHT 被截断，那比直接拦住更糟。
 */
export const MAX_LONG_PAGES = 5

/** 新加一页时的推荐指数默认值（见文件头 ④） */
export const DEFAULT_LEVEL = 3

/** 类型标签最多保留/展示的个数（详情接口的 tags 按热度排，取前若干个） */
export const MAX_GENRES = 8

// ------------------------------------------------------------------
// 页面背景（v0.3.7 追加需求 3）
// ------------------------------------------------------------------

/**
 * 一页的背景（v0.3.7 引入，v0.3.8 扩成**扁平结构**）。
 *
 * 三种形态（`kind`）：
 * - `color`：纯色，用 `color`；
 * - `gradient`：线性渐变，用 `angle` + `stops`；
 * - `image`：本地图片（经 `api.showcase.importImages` 复制进应用数据目录），用 `path`；
 *   并额外记 `imgW/imgH`（**原图像素尺寸**）—— 用户要求「设了背景图就让页面大小等于背景图大小」，
 *   而离屏导出窗口不会自己去量一张图，所以尺寸必须在选图那一刻量好存下来（见 BackgroundDialog）。
 *
 * `undefined` = 不加背景，就是原来的白底。
 *
 * 两个全局可调项（v0.3.8 追加，三种背景通吃）：
 * - `blur`：背景模糊（px，0 = 不模糊）——**只模糊背景层**，内容完全不受影响；
 * - `overlay`：叠在背景之上、内容之下的**渐变层**（角度 + 色标，色标带 alpha），
 *   用来压暗 / 染色，让白板上的字在任何背景上都清楚。
 *
 * 为什么是扁平结构（三个 kind 共用一套字段）而不是判别联合：
 * 收窄、打补丁、弹窗草稿、渲染都要处理「部分字段」，判别联合在每一处都得写分支；
 * 扁平结构由 `normalizeBackground` 统一补默认值，读的地方只认字段不认 kind，出错面小得多。
 *
 * 为什么**按页**存而不是按表统一：一页就是一部番剧的推荐卡，
 * 每部的色调/截图风格不一样（治愈番配暖色、悬疑番配深色），按页存才能真正用起来；
 * 而「整张表统一」这种需求用一个「应用到所有页」按钮就等价实现了（见 applyBackground），
 * 反过来（存表级、想给某一页单独换）就没法用按钮补上。
 */
export interface RecommendBackground {
  kind: 'color' | 'gradient' | 'image'
  /** kind=color：背景色 */
  color: string
  /** kind=gradient：渐变角度（0–360） */
  angle: number
  /** kind=gradient：渐变色标（2–4 个） */
  stops: GradientStop[]
  /** kind=image：图片路径（应用数据目录内的绝对路径） */
  path: string
  /** kind=image：原图宽（0 = 未知，此时页面沿用默认高度） */
  imgW: number
  /** kind=image：原图高 */
  imgH: number
  /**
   * kind=image：背景图放在页面的哪一侧（左 / 右 / 上）。
   * v0.3.8 第二轮起，图片**不再铺满整页**，而是只占页面的一部分（图区）：
   * 图区与内容区的比例固定 1.5 : 1（见 styles.ts 的 IMAGE_CONTENT_RATIO），
   * 图区靠内容区的那一侧用一条渐隐到页面底色的交融渐变接上（没有硬边）。
   */
  imagePos: ImagePos
  /** 背景模糊 px（0–40）；只作用于图区那一层 */
  blur: number
}

/** 背景图的位置：左 / 右 / 上（用户只提了这三个，没有"下"） */
export type ImagePos = 'left' | 'right' | 'top'

/** 位置选项（界面与校验共用一份） */
export const IMAGE_POS_NAMES: { key: ImagePos; label: string }[] = [
  { key: 'left', label: '左侧' },
  { key: 'right', label: '右侧' },
  { key: 'top', label: '上方' }
]

/** 渐变色标：色值 + 位置（0–100%）+ 不透明度（0–1） */
export interface GradientStop {
  color: string
  pos: number
  alpha: number
}

/** 一个渐变层（背景渐变用） */
export interface GradientLayer {
  angle: number
  stops: GradientStop[]
}

/** 渐变色的色标数量范围：1 个不成渐变，超过 4 个在弹窗的预览条上也没法调 */
export const MIN_GRADIENT_STOPS = 2
export const MAX_GRADIENT_STOPS = 4

/** 背景模糊上限（px）：再高整张背景就糊成一团纯色，而且离屏渲染明显变慢 */
export const MAX_BLUR = 40

/** 纯色背景的预设（界面上的色板；用户也可以自己调色或填十六进制） */
export const BG_PRESET_COLORS: { name: string; color: string }[] = [
  { name: '白', color: '#ffffff' },
  { name: '米白', color: '#faf6ef' },
  { name: '樱粉', color: '#fbe4ec' },
  { name: '雾蓝', color: '#e3ecf8' },
  { name: '薄荷', color: '#e2f2e8' },
  { name: '奶油黄', color: '#fbf1d9' },
  { name: '藕荷', color: '#ece4f6' },
  { name: '石墨', color: '#3a3f47' }
]

/** 渐变的预设（起手就有个能看的东西，用户再自己调角度与色标） */
export const BG_PRESET_GRADIENTS: { name: string; layer: GradientLayer }[] = [
  { name: '樱', layer: { angle: 135, stops: [{ color: '#fde7ef', pos: 0, alpha: 1 }, { color: '#e8f0fb', pos: 100, alpha: 1 }] } },
  { name: '黄昏', layer: { angle: 160, stops: [{ color: '#ffe8cc', pos: 0, alpha: 1 }, { color: '#f6c6d0', pos: 100, alpha: 1 }] } },
  { name: '深海', layer: { angle: 135, stops: [{ color: '#dfeaf7', pos: 0, alpha: 1 }, { color: '#c9d8ea', pos: 100, alpha: 1 }] } },
  { name: '抹茶', layer: { angle: 120, stops: [{ color: '#eaf5e2', pos: 0, alpha: 1 }, { color: '#d7ead0', pos: 100, alpha: 1 }] } },
  { name: '暮色', layer: { angle: 150, stops: [{ color: '#4b4f63', pos: 0, alpha: 1 }, { color: '#8e7d9a', pos: 100, alpha: 1 }] } }
]

/**
 * 叠加渐变层的预设（盖在图片/纯色背景之上）。
 *
 * ⚠️ v0.3.8 第二轮**已停用**：图片背景改成"图区 + 交融渐变"之后，
 * 「图区靠内容区那一侧渐隐到页面底色」这条渐变已经由渲染层按位置自动画好（见 styles.ts 的
 * `blendStyle`），再给用户一个"叠加渐变"控件就是两套相似的旋钮。
 * 常量先留着（其它地方若还引用不至于崩），但界面上不再提供入口。
 */
export const BG_PRESET_OVERLAYS: { name: string; layer: GradientLayer }[] = [
  {
    name: '底部压暗',
    layer: { angle: 180, stops: [{ color: '#000000', pos: 0, alpha: 0 }, { color: '#000000', pos: 100, alpha: 0.55 }] }
  },
  {
    name: '顶部压暗',
    layer: { angle: 0, stops: [{ color: '#000000', pos: 0, alpha: 0.5 }, { color: '#000000', pos: 100, alpha: 0 }] }
  },
  {
    name: '白纱提亮',
    layer: { angle: 135, stops: [{ color: '#ffffff', pos: 0, alpha: 0.55 }, { color: '#ffffff', pos: 100, alpha: 0.15 }] }
  },
  {
    name: '粉色染色',
    layer: { angle: 135, stops: [{ color: '#e0577f', pos: 0, alpha: 0.35 }, { color: '#ffffff', pos: 100, alpha: 0.1 }] }
  }
]

/** `#rgb` / `#rrggbb` / `#rrggbbaa` → `#rrggbb`；非法返回空串（不猜颜色） */
export function normalizeHexColor(v: unknown): string {
  if (typeof v !== 'string') return ''
  const s = v.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7)
  return ''
}

/** 0–1 的不透明度（叠加层用）；非法值给 1（完全不透明） */
export function clampAlpha(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  return Math.min(1, Math.max(0, Math.round(v * 100) / 100))
}

/** 色标收窄：去非法、限个数、位置夹到 0–100（排序交给渲染那边的 CSS，它自己会按顺序画） */
export function normalizeStops(raw: unknown, max = MAX_GRADIENT_STOPS): GradientStop[] {
  const list = Array.isArray(raw) ? raw : []
  const out: GradientStop[] = []
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const color = normalizeHexColor(o.color)
    if (!color) continue
    const pos =
      typeof o.pos === 'number' && Number.isFinite(o.pos) ? Math.min(100, Math.max(0, Math.round(o.pos))) : 0
    out.push({ color, pos, alpha: clampAlpha(o.alpha) })
    if (out.length >= max) break
  }
  return out
}

/** 一个渐变层（背景渐变 / 叠加渐变）收窄：色标不足 2 个算非法 → null */
export function normalizeLayer(raw: unknown): GradientLayer | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const stops = normalizeStops(o.stops)
  if (stops.length < MIN_GRADIENT_STOPS) return null
  const angle =
    typeof o.angle === 'number' && Number.isFinite(o.angle) ? ((Math.round(o.angle) % 360) + 360) % 360 : 135
  return { angle, stops }
}

/**
 * 背景收窄。
 *
 * 非法一律回成 `undefined`（= 白底），而不是"尽量修一下"：
 * 背景是纯装饰，猜错只是难看；但如果把一段非法字符串塞进 CSS 的 `background` 里，
 * 整张卡片都会画不出来 —— 那种失败比难看严重得多。
 */
export function normalizeBackground(raw: unknown): RecommendBackground | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const kind = r.kind === 'color' || r.kind === 'gradient' || r.kind === 'image' ? r.kind : null
  if (!kind) return undefined
  const blurRaw = typeof r.blur === 'number' && Number.isFinite(r.blur) ? Math.round(r.blur) : 0
  const blur = Math.min(MAX_BLUR, Math.max(0, blurRaw))
  // 图片位置：老数据（第一轮做的背景）没有这个字段 → 默认「左侧」
  const imagePos: ImagePos =
    r.imagePos === 'right' || r.imagePos === 'top' || r.imagePos === 'left' ? r.imagePos : 'left'
  /*
   * 注意：第一轮存过的 `overlay`（叠加渐变层）在这里被**有意丢弃** ——
   * 它的作用已经由「图区 → 内容区」的交融渐变承担（见文件头的说明与 styles.ts 的 blendStyle）。
   * 留着字段但不渲染会让数据里塞着一份永远不生效的配置，更容易让人误会"设置了没反应"。
   */
  if (kind === 'color') {
    const color = normalizeHexColor(r.color)
    return color
      ? { kind, color, angle: 135, stops: [], path: '', imgW: 0, imgH: 0, imagePos, blur }
      : undefined
  }
  if (kind === 'image') {
    const path = typeof r.path === 'string' ? r.path.trim() : ''
    // 图片背景必须有路径：空路径会让导出图变成一块灰底，不如直接回成白底
    if (!path) return undefined
    const imgW = typeof r.imgW === 'number' && Number.isFinite(r.imgW) && r.imgW > 0 ? Math.round(r.imgW) : 0
    const imgH = typeof r.imgH === 'number' && Number.isFinite(r.imgH) && r.imgH > 0 ? Math.round(r.imgH) : 0
    return { kind, color: '#ffffff', angle: 135, stops: [], path, imgW, imgH, imagePos, blur }
  }
  const layer = normalizeLayer({ angle: r.angle, stops: r.stops })
  if (!layer) return undefined
  return {
    kind: 'gradient',
    color: '#ffffff',
    angle: layer.angle,
    stops: layer.stops,
    path: '',
    imgW: 0,
    imgH: 0,
    imagePos,
    blur
  }
}

// ------------------------------------------------------------------
// 模块（v0.3.8：用户方向调整后**只保留显示 / 隐藏**）
// ------------------------------------------------------------------

/**
 * 页面上的模块。用户点名要做成模块的是「封面 / 评分 / 推荐指数 / 推荐理由 / 剧照」，
 * 这里把它们拆成 5 个，再补上**番剧名（标题）**、**播出时间与标签**、**页脚**：
 * 标题是页面上最大的信息，页脚（表名 + 页码）同理；拆出来也正好支持用户举的例子
 * 「只导封面 + 评分 + 理由」。
 */
export type ModuleKind =
  | 'title'
  | 'cover'
  | 'ratings'
  | 'level'
  | 'meta'
  | 'reason'
  | 'photos'
  | 'foot'

/** 模块的中文名（界面列表、导出勾选、弹窗共用一份） */
export const MODULE_NAMES: Record<ModuleKind, string> = {
  title: '番剧名',
  cover: '封面',
  ratings: '评分',
  level: '推荐指数',
  meta: '播出时间与标签',
  reason: '推荐理由',
  photos: '剧照',
  foot: '页脚（表名 / 页码）'
}

/** 模块顺序 = 界面列表顺序 = 绘制顺序（同一层的模块按这个顺序画，后面的盖前面的） */
export const MODULE_KINDS: ModuleKind[] = [
  'title',
  'cover',
  'ratings',
  'level',
  'meta',
  'reason',
  'photos',
  'foot'
]

/** 一个模块的位置与尺寸（**只由版式算出来**，用户不可改；见 styles.ts 的 moduleRectsOf） */
export interface ModuleRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 一个模块在一页上的状态。
 *
 * v0.3.8 第二轮（用户方向调整）之后**只剩显示 / 隐藏**：
 * 原来那套 `x/y/w/h/z/scale`（自由拖动 + 缩放）已经整条撤掉，位置一律由版式决定。
 * 好处是"界面看到的就是导出的"这件事再也不依赖两份坐标同步 —— 两边都从
 * `styles.moduleRectsOf(frame)` 现算同一份矩形。
 */
export interface ModuleLayout {
  id: ModuleKind
  visible: boolean
}

/**
 * **默认摆放**（px，坐标系是 1200 × 920 的"整页无图"版式）。
 *
 * 这些数字就是改造前那套固定版式的内容坐标：页边距 34、封面 300×426、
 * 右列从 360 起宽 804、信息行 26 高 + 12 间距、理由区 30 + 244、剧照 30 + 92、页脚贴底。
 * 因为模块**不再有自己的白板**（v0.3.8 第二轮去掉的），矩形直接就是内容框 ——
 * 所以这里不再需要"内容坐标 − 白板内边距"的换算。
 *
 * 有图片背景时（图区 + 内容区）模块会按 `styles.moduleRectsOf` 在内容区里重排：
 *   · 上图：内容区仍是 1200 宽 → 用这份摆放，整体下移一个图区高度；
 *   · 左/右图：内容区只有 480 宽 → 改为纵向一列（见 styles.ts 的 SIDE_STACK）。
 *
 * ⚠️ 不要随手改这里的数字：默认版式是所有人的共同起点。
 */
export const DEFAULT_MODULES: Record<ModuleKind, ModuleRect> = {
  title: { x: 34, y: 34, w: 1132, h: 96 },
  cover: { x: 34, y: 166, w: 300, h: 426 },
  ratings: { x: 360, y: 166, w: 804, h: 78 },
  level: { x: 360, y: 256, w: 804, h: 40 },
  meta: { x: 360, y: 308, w: 804, h: 116 },
  reason: { x: 360, y: 436, w: 804, h: 274 },
  photos: { x: 360, y: 722, w: 804, h: 122 },
  foot: { x: 34, y: 858, w: 1132, h: 30 }
}

/**
 * 布局收窄：**只留下 `id` 与 `visible`**，坐标一类字段一律丢掉。
 *
 * ## 老数据兼容的做法（二选一里选了"丢掉坐标"）
 *
 * 上一版允许用户自由拖动模块，磁盘上已经存在带 `x/y/w/h/z/scale` 的布局。
 * 两种兼容方式：① 留着字段但渲染时无视；② 收窄时直接丢掉。
 * 这里选 **②**，理由是：留着不生效的坐标会让人误以为"拖动还在、只是没显示"，
 * 以后维护者也可能不小心又把它们接回渲染（`resolveModules` 那种"以为是缺失就补默认"的坑刚踩过）。
 * 丢掉之后数据里只剩下真正生效的东西（显隐），语义干净；而**用户自定义过的位置本来就要清掉**
 * （这次方向调整就是"取消自定义移动模块"），所以丢掉也不算信息损失。
 */
export function normalizeModules(raw: unknown): ModuleLayout[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<ModuleKind>()
  const out: ModuleLayout[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = MODULE_KINDS.includes(o.id as ModuleKind) ? (o.id as ModuleKind) : null
    if (!id || seen.has(id)) continue
    seen.add(id)
    // visible 缺省 = 显示（只有显式 false 才算隐藏；老数据里可能根本没有这个字段）
    out.push({ id, visible: o.visible !== false })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 把一页的模块补成**完整**的 8 项（缺的当"没动过"）。
 *
 * ## 「显式隐藏」与「没这一项」是两件完全不同的事（上一轮修 bug 的关键，别退化）
 *
 *   · `page.layout` 里**有**这一项且 `visible === false` → 用户**主动隐藏**了它，原样返回；
 *   · `page.layout` 里**没有**这一项 → 从没动过它，才用默认（显示）。
 * 判据写成 `stored.has(id)`（看**存在性**），不能拿 `stored.get(id)` 的真假判断
 * —— 把"存在的对象"当假值处理，隐藏就会失效。
 *
 * 位置不再来自数据（用户不能自定义移动了）：要画在哪由 `styles.moduleRectsOf(frame)` 算，
 * 这里只回答"这一页哪些模块开着"。
 */
export function resolveModules(page: { layout?: ModuleLayout[] }): ModuleLayout[] {
  const stored = new Map<ModuleKind, ModuleLayout>()
  for (const m of page.layout ?? []) stored.set(m.id, m)
  return MODULE_KINDS.map((id) => {
    const saved = stored.get(id)
    if (stored.has(id) && saved) return saved
    return { id, visible: true }
  })
}

/**
 * 一页上**真正要画出来**的模块：补全 → 丢掉隐藏的（可再按导出勾选过滤）。
 *
 * ⚠️ 这是**界面预览与导出图唯一的取模块入口**（`RecommendPageCard` 与 `exportHtml` 都只调它）。
 * 加它就是因为踩过一次坑：两个渲染器各自写一遍，导出那边记得 `.filter(m => m.visible)`、
 * 卡片那边忘了 —— 于是「模块隐藏了，预览里还在显示」。
 *
 * `only` 是**导出弹窗**勾选的白名单（不传 / 空 = 全都画）。
 * 它只能**进一步**减少模块：页面自己隐藏的模块，即使被勾上也画不出来（两者取交集）。
 */
export function renderModules(
  page: { layout?: ModuleLayout[] },
  only?: ModuleKind[] | null
): ModuleLayout[] {
  const allow = only && only.length > 0 ? new Set(only) : null
  return resolveModules(page)
    .filter((m) => m.visible)
    .filter((m) => !allow || allow.has(m.id))
}

/** 推荐表里的一页 = 一部番剧的推荐数据 */
export interface RecommendPage {
  /**
   * 页面自己的 id。
   * 为什么不拿 subjectId 当键：编辑面板、右键菜单、删除都要一个稳定标识，
   * 而 subjectId 是**番剧**的身份（同表内虽然去重，但页面级操作不该依赖它）。
   */
  id: string
  subjectId: number
  /** 原名（日文 / 罗马字） */
  name: string
  /** 中文名（可能为空，展示时取 nameCn || name） */
  nameCn: string
  /** 界面显示用的封面（common 档，见文件头 ③） */
  cover: string
  /** 导出用的封面候选链（large 优先，逐档降级；`cover` 一定在其中） */
  covers: string[]
  /** bangumi 评分（0–10，接口给的原值；取不到为 null） */
  bgmRating: number | null
  /** 推荐人评分（0–10，允许一位小数；null = 还没打分） */
  myRating: number | null
  /** 推荐指数 1–5 星（整数） */
  recommendLevel: number
  /** 播出时间（YYYY-MM-DD，取不到为 null） */
  airDate: string | null
  /** 类型标签（详情接口的 tags，见文件头 ⑤） */
  genres: string[]
  /** 推荐理由（≤ REASON_MAX 字） */
  reason: string
  /** 剧照：**应用数据目录内的绝对路径**（经 api.showcase.importImages 复制进来，见下面的说明） */
  photos: string[]
  /** 这一页的背景（undefined = 白底；按页保存的原因见 RecommendBackground 的注释） */
  background?: RecommendBackground
  /**
   * 这一页的模块布局（v0.3.8）。
   *
   * `undefined` / 缺模块 = **默认摆放**（见 resolveModules）：老数据（v0.3.7 存的表）
   * 没有这个字段，读出来照样是那套固定版式，不会崩也不会变形。
   * 只有用户真的拖过或改过的模块才会出现在这里。
   */
  layout?: ModuleLayout[]
}

/** 一张推荐表 */
export interface RecommendTable {
  id: string
  /** 表名（用户自定义；界面与导出图的页脚都用它） */
  name: string
  pages: RecommendPage[]
  createdAt: number
}

/** 落盘结构（见文件头 ① ） */
export interface RecommendStoreData {
  tables: RecommendTable[]
  /**
   * 导出图上的「推荐人」署名。
   *
   * 为什么不放在每张表里：署名是**这个人**的属性（同一台机器上的表基本都是同一个人做的），
   * 每张表各记一份的结果是换个表就要重打一遍名字。用户说了「导出前填写」，所以它也不进页面数据。
   */
  recommender: string
  /**
   * 左侧「添加作品」面板是否收起来了（v0.3.7 追加需求 2：用户可以隐藏它）。
   *
   * 为什么存在这里而不是某个组件的 useState：用户把它收起来是为了把窗口让给推荐卡，
   * 换个表、重启应用都还应该保持收起 —— 这是个**偏好**，不是临时界面状态。
   */
  panelHidden?: boolean
}

/** 新增一页的输入（评分 / 指数 / 理由 / 剧照是加入之后才编的，这里不给） */
export interface RecommendPageInput {
  subjectId: number
  name: string
  nameCn: string
  cover: string
  covers: string[]
  bgmRating: number | null
  airDate: string | null
  genres: string[]
}

/** 右键编辑面板可以改的字段白名单（别的一律不让从渲染层改） */
export type RecommendPagePatch = Partial<
  Pick<
    RecommendPage,
    'myRating' | 'recommendLevel' | 'reason' | 'photos' | 'genres' | 'airDate' | 'background' | 'layout'
  >
>

/** 新增结果：失败时给出**可直接显示的中文原因**，页面不再自己拼规则 */
export type AddPageResult =
  | { ok: true; index: number; total: number }
  | { ok: false; message: string }

/** 批量新增结果（从收藏一次加多部时用；`skipped` 是已经在表里、被跳过的番剧名） */
export interface AddPagesResult {
  added: number
  skipped: string[]
  total: number
}

// ------------------------------------------------------------------
// 收窄（磁盘上的脏数据 → 合法数据）
// ------------------------------------------------------------------

/**
 * 评分收窄：0–10，保留一位小数；非法值一律 null。
 *
 * 为什么不给默认分：编一个「看起来合理」的分数会让导出图上是**假数据**，
 * 而「未评分」是用户可以自己看出来的状态（界面上显示「未评分」/「—」）。
 */
export function clampRating(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(10, Math.max(0, Math.round(v * 10) / 10))
}

/** 推荐指数收窄：1–5 的整数（非法值给默认值，见文件头 ④） */
export function clampLevel(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_LEVEL
  return Math.min(5, Math.max(1, Math.round(v)))
}

/** 推荐理由收窄：非字符串当空串；超长直接截断（老版本可能写进来过长文本） */
export function clampReason(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, REASON_MAX) : ''
}

/** 字符串数组收窄（去空、去重、限个数）；照片与标签共用 */
export function toStringList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const s = x.trim()
    if (!s || out.includes(s)) continue
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

/**
 * 把磁盘上的一条页面收窄成合法数据。
 *
 * 为什么宁可丢一条也不猜：一条页面上的名字、封面、标签全是「番剧的身份」，
 * 猜错的结果是推荐表里出现一部不存在的番剧 —— 比少一页难排查得多。
 * subjectId 必须为正整数（详情/补齐标签都要用它）。
 */
export function normalizePage(raw: unknown, index: number): RecommendPage | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const subjectId =
    typeof r.subjectId === 'number' && Number.isFinite(r.subjectId) ? Math.trunc(r.subjectId) : NaN
  if (!Number.isFinite(subjectId) || subjectId <= 0) return null
  const name = typeof r.name === 'string' ? r.name : ''
  const nameCn = typeof r.nameCn === 'string' ? r.nameCn : ''
  if (!name.trim() && !nameCn.trim()) return null
  const cover = typeof r.cover === 'string' ? r.cover : ''
  const covers = toStringList(r.covers, 5)
  return {
    // 老数据（或手工改过的盘）可能没有 id：按「番剧 id + 数组下标」生成，稳定且不重复
    id: typeof r.id === 'string' && r.id ? r.id : `p-${subjectId}-${index}`,
    subjectId,
    name,
    nameCn,
    cover,
    // 候选链缺失时退化成 [cover]：导出最少还有一张能画，不至于整块空白
    covers: covers.length > 0 ? covers : cover ? [cover] : [],
    bgmRating: clampRating(r.bgmRating),
    myRating: clampRating(r.myRating),
    recommendLevel: clampLevel(r.recommendLevel),
    airDate: typeof r.airDate === 'string' && r.airDate ? r.airDate : null,
    genres: toStringList(r.genres, MAX_GENRES),
    reason: clampReason(r.reason),
    photos: toStringList(r.photos, MAX_PHOTOS),
    // 背景非法就当没设过（白底），见 normalizeBackground 的说明
    background: normalizeBackground(r.background),
    // 布局：只有合法的条目会留下，缺的模块渲染时补默认摆放（见 resolveModules）
    layout: normalizeModules(r.layout)
  }
}

/** 一张表收窄：逐页过滤 + 同一部番剧只留第一次出现的那页（重复页在翻页时看着像 bug） */
export function normalizeTable(raw: unknown, index: number): RecommendTable | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const pagesRaw = Array.isArray(r.pages) ? r.pages : []
  const seen = new Set<number>()
  const pages: RecommendPage[] = []
  pagesRaw.forEach((p, i) => {
    const page = normalizePage(p, i)
    if (!page || seen.has(page.subjectId)) return
    seen.add(page.subjectId)
    pages.push(page)
  })
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `推荐表 ${index + 1}`
  const createdAt =
    typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : Date.now()
  return {
    id: typeof r.id === 'string' && r.id ? r.id : `t-${index}-${createdAt}`,
    name,
    pages,
    createdAt
  }
}

/**
 * 整份数据收窄。
 *
 * 兼容两种磁盘形态：`{ tables, recommender }`（现在写的）与**裸数组**。
 * 裸数组是防御性的：这份数据在磁盘上是一个 JSON，用户/别的工具完全可能把它改成一个表数组，
 * 而「读不出来就当作空」意味着用户的推荐表**全部消失**且没有任何提示 —— 代价太大，
 * 多写三行兼容比事后帮用户找回数据划算。
 */
export function normalizeStore(raw: unknown): RecommendStoreData {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  const listRaw = Array.isArray(raw) ? raw : obj && Array.isArray(obj.tables) ? obj.tables : []
  const tables: RecommendTable[] = []
  const usedIds = new Set<string>()
  listRaw.forEach((t, i) => {
    const table = normalizeTable(t, i)
    if (!table || usedIds.has(table.id)) return
    usedIds.add(table.id)
    tables.push(table)
  })
  const recommender = obj && typeof obj.recommender === 'string' ? obj.recommender : ''
  const panelHidden = obj?.panelHidden === true
  return { tables, recommender, panelHidden }
}

// ------------------------------------------------------------------
// 从接口条目构造一页
// ------------------------------------------------------------------

/** 搜索结果与季度条目在「加进来要用到的字段」上形状一致，抽成一个结构，两条路共用一个构造器 */
type SubjectLike = {
  id: number
  name: string
  name_cn: string
  images: CoverImages | null
  rating: Rating | null
  air_date: string | null
}

/**
 * 条目 → 落库输入。
 *
 * 复用 `coverFields()`（自建历史表那份）：它给出的 `covers` 是 large 优先的候选链，
 * 正是导出要的（见文件头 ③）。
 * 注意 `genres` 只能给空数组：**搜索结果与季度列表都不返回 tags**（只有详情接口有），
 * 所以类型标签一律靠加进来之后的 `backfill` 补（见文件头 ⑤）。
 */
export function pageInputFrom(it: SubjectLike): RecommendPageInput {
  const { cover, covers } = coverFields(it.images)
  return {
    subjectId: Math.trunc(it.id),
    name: it.name ?? '',
    nameCn: it.name_cn ?? '',
    cover,
    covers,
    bgmRating: typeof it.rating?.score === 'number' ? it.rating.score : null,
    airDate: typeof it.air_date === 'string' && it.air_date ? it.air_date : null,
    genres: []
  }
}

/** 季度条目 → 输入（名字不同的一个入口，读起来更清楚） */
export function pageInputFromSeason(it: SeasonItem): RecommendPageInput {
  return pageInputFrom(it)
}

/** 搜索结果 → 输入 */
export function pageInputFromSearch(it: SearchResultItem): RecommendPageInput {
  return pageInputFrom(it)
}

/**
 * 收藏条目 → 输入（v0.3.7 追加需求 2：支持从收藏添加）。
 *
 * 收藏条目（`FavoriteItem`）自带 `cover` 大图、`rating`、`airDate` 与 `genres`，
 * 所以这条路**不需要**再补详情：直接就能画出一张完整的卡（比搜索/当季那条路更省一次请求）。
 * `covers` 只给一项 `[cover]`：收藏里存的就是大图地址，没有多档候选链可降级。
 */
export function pageInputFromFavorite(fav: FavoriteItem): RecommendPageInput {
  const cover = typeof fav.cover === 'string' ? fav.cover : ''
  return {
    subjectId: Math.trunc(fav.subjectId),
    name: fav.name ?? '',
    nameCn: fav.nameCn ?? '',
    cover,
    covers: cover ? [cover] : [],
    bgmRating: typeof fav.rating === 'number' ? fav.rating : null,
    airDate: typeof fav.airDate === 'string' && fav.airDate ? fav.airDate : null,
    genres: toStringList(fav.genres, MAX_GENRES)
  }
}

// ------------------------------------------------------------------
// store
// ------------------------------------------------------------------

interface RecommendState extends RecommendStoreData {
  /** 是否已经从磁盘读过一次（页面据此决定要不要显示加载态） */
  loaded: boolean
  load: () => Promise<void>
  /** 新建一张表并返回它（表名空白时给一个兜底名，界面那边也会挡住空名字） */
  createTable: (name: string) => RecommendTable
  renameTable: (tableId: string, name: string) => void
  removeTable: (tableId: string) => void
  /** 设置导出图上的「推荐人」署名（工具栏与导出弹窗共用同一个值） */
  setRecommender: (value: string) => void
  /** 收起 / 展开左侧「添加作品」面板（偏好，落盘记住） */
  setPanelHidden: (hidden: boolean) => void
  addPage: (tableId: string, input: RecommendPageInput) => AddPageResult
  /** 一次加多部（从收藏多选时用）：只写一次盘，返回加了几部、跳过了哪几部 */
  addPages: (tableId: string, inputs: RecommendPageInput[]) => AddPagesResult
  updatePage: (tableId: string, pageId: string, patch: RecommendPagePatch) => void
  removePage: (tableId: string, pageId: string) => void
  /**
   * 显示 / 隐藏一个模块（v0.3.8 第二轮之后，模块**只剩这一个可调项**）。
   *
   * 实现上先 `resolveModules` 把整页补全再改这一项：用户第一次关某一块时，
   * 另外 7 块还没进过 layout，补全后整体写回 —— 落盘的就是一份完整的显隐表。
   */
  setModuleVisible: (tableId: string, pageId: string, moduleId: ModuleKind, visible: boolean) => void
  /** 全部显示（= 清掉 layout，回到默认） */
  resetModules: (tableId: string, pageId: string) => void
  /** 把同一个背景应用到这张表的**所有页**（右键菜单里的背景弹窗用；null = 全部恢复白底） */
  applyBackground: (tableId: string, background: RecommendBackground | null) => number
  /** 用 bangumi 详情补齐缺少类型标签 / 播出时间的页，返回补齐的页数 */
  backfill: (tableId: string) => Promise<number>
}

/** 生成一个本进程内唯一的 id（时间戳 + 自增，够用且不依赖 crypto） */
let idSeq = 0
function newId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${idSeq.toString(36)}`
}

export const useRecommendTable = create<RecommendState>((set, get) => {
  /**
   * 整份写回。
   *
   * 刻意**不 await**（与 customHistory 一致）：写盘失败（磁盘满 / 权限）时不该把界面卡住，
   * 更不该回滚用户刚做的编辑 —— 数据还在内存里，用户最多是这次没存上。
   */
  const persist = (): void => {
    const { tables, recommender, panelHidden } = get()
    void api.store.set(RECOMMEND_STORE_KEY, {
      tables,
      recommender,
      panelHidden
    } satisfies RecommendStoreData)
  }

  /** 改某张表（找不到就原样返回，避免把不存在的 id 悄悄插进来） */
  const patchTable = (
    tableId: string,
    fn: (t: RecommendTable) => RecommendTable
  ): RecommendTable[] => get().tables.map((t) => (t.id === tableId ? fn(t) : t))

  return {
    tables: [],
    recommender: '',
    panelHidden: false,
    loaded: false,

    load: async () => {
      const r = await api.store.get(RECOMMEND_STORE_KEY)
      set({
        ...(r.ok ? normalizeStore(r.data) : { tables: [], recommender: '', panelHidden: false }),
        loaded: true
      })
    },

    createTable: (name) => {
      const table: RecommendTable = {
        id: newId('t'),
        name: name.trim() || '未命名推荐表',
        pages: [],
        createdAt: Date.now()
      }
      set({ tables: [...get().tables, table] })
      persist()
      return table
    },

    renameTable: (tableId, name) => {
      const next = name.trim()
      // 空名字直接忽略：表名会印在导出的页脚上，空着等于导出一张没有出处的图
      if (!next) return
      set({ tables: patchTable(tableId, (t) => ({ ...t, name: next })) })
      persist()
    },

    removeTable: (tableId) => {
      const next = get().tables.filter((t) => t.id !== tableId)
      if (next.length === get().tables.length) return
      set({ tables: next })
      persist()
    },

    setRecommender: (value) => {
      set({ recommender: value })
      persist()
    },

    setPanelHidden: (hidden) => {
      set({ panelHidden: hidden })
      persist()
    },

    addPage: (tableId, input) => {
      const table = get().tables.find((t) => t.id === tableId)
      if (!table) return { ok: false, message: '这张推荐表已经不在了（可能刚被删掉）' }
      if (table.pages.some((p) => p.subjectId === input.subjectId)) {
        const title = input.nameCn || input.name
        return { ok: false, message: `《${title}》已经在这张表里了` }
      }
      const page: RecommendPage = {
        id: newId('p'),
        subjectId: input.subjectId,
        name: input.name,
        nameCn: input.nameCn,
        cover: input.cover,
        covers: input.covers.length > 0 ? input.covers : input.cover ? [input.cover] : [],
        bgmRating: clampRating(input.bgmRating),
        myRating: null,
        recommendLevel: DEFAULT_LEVEL,
        airDate: input.airDate,
        genres: toStringList(input.genres, MAX_GENRES),
        reason: '',
        photos: []
      }
      const nextPages = [...table.pages, page]
      set({ tables: patchTable(tableId, (t) => ({ ...t, pages: nextPages })) })
      persist()
      return { ok: true, index: nextPages.length - 1, total: nextPages.length }
    },

    addPages: (tableId, inputs) => {
      const table = get().tables.find((t) => t.id === tableId)
      if (!table) return { added: 0, skipped: [], total: 0 }
      /*
       * 一次写盘加多部（从收藏多选时用）。
       *
       * 为什么不让页面循环调 addPage：那是 N 次「改内存 + 整份写盘」，
       * 而且每次返回的 index 都会被后一次覆盖 —— 界面还得自己算最后一页在哪。
       * 这里在**一份快照**上依次判重、依次追加，顺序就是用户勾选的顺序（收藏里的顺序）。
       */
      const seen = new Set(table.pages.map((p) => p.subjectId))
      const pages = [...table.pages]
      const skipped: string[] = []
      for (const input of inputs) {
        const title = input.nameCn || input.name || '未命名'
        if (seen.has(input.subjectId)) {
          skipped.push(title)
          continue
        }
        seen.add(input.subjectId)
        pages.push({
          id: newId('p'),
          subjectId: input.subjectId,
          name: input.name,
          nameCn: input.nameCn,
          cover: input.cover,
          covers: input.covers.length > 0 ? input.covers : input.cover ? [input.cover] : [],
          bgmRating: clampRating(input.bgmRating),
          myRating: null,
          recommendLevel: DEFAULT_LEVEL,
          airDate: input.airDate,
          genres: toStringList(input.genres, MAX_GENRES),
          reason: '',
          photos: []
        })
      }
      const added = pages.length - table.pages.length
      if (added > 0) {
        set({ tables: patchTable(tableId, (t) => ({ ...t, pages })) })
        persist()
      }
      return { added, skipped, total: pages.length }
    },

    updatePage: (tableId, pageId, patch) => {
      const table = get().tables.find((t) => t.id === tableId)
      if (!table || !table.pages.some((p) => p.id === pageId)) return
      set({
        tables: patchTable(tableId, (t) => ({
          ...t,
          pages: t.pages.map((p) => {
            if (p.id !== pageId) return p
            /*
             * 逐字段收窄而不是直接展开 patch：
             * 面板是异步保存的（保存那一刻用户可能已经改了别的），这里保证**任何来源**的补丁
             * 都过一遍同样的夹取规则 —— 落盘的数据永远是合法的。
             */
            const next: RecommendPage = { ...p }
            if ('myRating' in patch) next.myRating = clampRating(patch.myRating)
            if ('recommendLevel' in patch) next.recommendLevel = clampLevel(patch.recommendLevel)
            if ('reason' in patch) next.reason = clampReason(patch.reason)
            if ('photos' in patch) next.photos = toStringList(patch.photos, MAX_PHOTOS)
            if ('genres' in patch) next.genres = toStringList(patch.genres, MAX_GENRES)
            if ('airDate' in patch) {
              next.airDate = typeof patch.airDate === 'string' && patch.airDate ? patch.airDate : null
            }
            // background 允许为 null/undefined（= 清掉背景回白底），所以这里先收窄再赋值
            if ('background' in patch) next.background = normalizeBackground(patch.background)
            // layout 同理：undefined = 整页回默认摆放
            if ('layout' in patch) next.layout = normalizeModules(patch.layout)
            return next
          })
        }))
      })
      persist()
    },

    removePage: (tableId, pageId) => {
      const table = get().tables.find((t) => t.id === tableId)
      if (!table || !table.pages.some((p) => p.id === pageId)) return
      set({
        tables: patchTable(tableId, (t) => ({ ...t, pages: t.pages.filter((p) => p.id !== pageId) }))
      })
      persist()
    },

    setModuleVisible: (tableId, pageId, moduleId, visible) => {
      const table = get().tables.find((t) => t.id === tableId)
      const page = table?.pages.find((p) => p.id === pageId)
      if (!table || !page) return
      // 先补全再改一项：用户第一次关某一块时，其余 7 块还没进过 layout
      const next: ModuleLayout[] = resolveModules(page).map((m) =>
        m.id === moduleId ? { id: m.id, visible } : m
      )
      /*
       * 全部显示时写成 `undefined`（= "从没动过"）而不是一份全是 visible:true 的数组：
       * 这样默认状态永远干净，也不会因为多了一层记录而影响以后改默认行为。
       */
      const allVisible = next.every((m) => m.visible)
      set({
        tables: patchTable(tableId, (t) => ({
          ...t,
          pages: t.pages.map((p) => (p.id === pageId ? { ...p, layout: allVisible ? undefined : next } : p))
        }))
      })
      persist()
    },

    resetModules: (tableId, pageId) => {
      const table = get().tables.find((t) => t.id === tableId)
      if (!table || !table.pages.some((p) => p.id === pageId)) return
      set({
        tables: patchTable(tableId, (t) => ({
          ...t,
          pages: t.pages.map((p) => (p.id === pageId ? { ...p, layout: undefined } : p))
        }))
      })
      persist()
    },

    applyBackground: (tableId, background) => {
      const table = get().tables.find((t) => t.id === tableId)
      if (!table) return 0
      const bg = background === null ? undefined : normalizeBackground(background)
      /*
       * 「应用到所有页」：背景是**按页**存的（见 RecommendBackground 的注释），
       * 整表统一的诉求用这个按钮实现 —— 一次写完并返回改了几页，界面据此提示。
       */
      const next = table.pages.map((p) => ({ ...p, background: bg }))
      set({ tables: patchTable(tableId, (t) => ({ ...t, pages: next })) })
      persist()
      return next.length
    },

    backfill: async (tableId) => {
      const table = get().tables.find((t) => t.id === tableId)
      if (!table) return 0
      // 只补「缺标签」或「缺播出时间」的页：已经全的页再请求一次纯属浪费（详情接口有缓存也一样）
      const todo = table.pages.filter((p) => p.genres.length === 0 || !p.airDate)
      if (todo.length === 0) return 0
      let patched = 0
      for (const page of todo) {
        /*
         * 逐页串行：一是详情接口在主进程有自己的缓存与重试，串行能让「第一页命中缓存、
         * 后面几页慢慢来」的顺序更可预期；二是并发几十个请求在离线时会一起超时，
         * 用户看到的就是「点了没反应」。表里页数是个位到几十，串行完全够快。
         */
        const r = await api.bangumi.subject(page.subjectId)
        if (!r.ok || !r.data.data) continue
        const d = r.data.data
        // tags 按热度（count）从高到低取前 MAX_GENRES 个：界面只画得下 6 个，导出图同样只画 6 个
        const tags = [...d.tags]
          .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
          .map((t) => t.name)
          .filter((n) => n && n.length > 0)
        const genres = toStringList(tags, MAX_GENRES)
        const airDate = d.air_date ?? page.airDate
        const changed = (genres.length > 0 && page.genres.length === 0) || airDate !== page.airDate
        if (!changed) continue
        set({
          tables: patchTable(tableId, (t) => ({
            ...t,
            pages: t.pages.map((p) =>
              p.id === page.id
                ? { ...p, genres: p.genres.length > 0 ? p.genres : genres, airDate }
                : p
            )
          }))
        })
        patched += 1
        /*
         * 每补一页就落盘，而不是等整个循环结束再写一次。
         * 理由是补页是**逐页联网**的过程：表里二十页、网又慢时用户会中途关掉页面，
         * 只写最后一次的话前面已经补好的十几页会全部丢掉（而它们已经在界面上显示出来了）。
         */
        persist()
      }
      return patched
    }
  }
})

import type { CSSProperties } from 'react'
import type { RecommendBackground, RecommendPage } from '@/stores/recommendTable'
import { MAX_PHOTOS } from '@/stores/recommendTable'

/**
 * 「番剧推荐表」的**版式常量**与配色 —— 界面预览与导出图共用同一份。
 *
 * ## 为什么这个文件必须存在
 *
 * 用户的要求是「编辑界面的版式必须和导出图一致（所见即所得）」，而这两边是**两套渲染器**：
 *   · `RecommendPageCard.tsx` —— React + 行内样式，画在窗口里；
 *   · `exportHtml.ts` —— 拼成 HTML 字符串 + 内联 CSS，交给主进程离屏渲染成 PNG。
 * 如果两边的尺寸各写一遍，只要有人改了其中一边的一处间距，「所见即所得」立刻失效，
 * 而且失效方式很隐蔽（导出图看着没问题，只是和预览差几像素 —— 没人会发现）。
 * 所以：**所有尺寸/字号/间距/颜色只在这里定义一次**，两个渲染器都从这里取。
 *
 * ## 两层结构（v0.3.7 追加需求 3 之后）
 *
 * 卡片 = **背景层**（card）+ **内容板**（panel）：
 *   · 背景层承担用户设置的纯色 / 渐变 / 图片，四周留 RL.frame 宽的一圈当作「边框」；
 *   · 内容板是半透明白色，所有文字画在它上面。
 * 为什么要这层白板而不是把字直接画在背景上：用户能选深色纯色、深色渐变或一张照片，
 * 深色背景 + 深色文字会直接不可读。半透明白板（纯色 0.78 / 图片渐变 0.86）既让背景透出来，
 * 又保证任何背景下文字都清楚 —— 这是「允许任选背景」的前提下最稳的做法；
 * 代价是选深色背景时整体会偏灰，白板不透明度就是这个的旋钮（见 RL.panelAlpha*）。
 * 默认（没设背景）时白板是**不透明纯白**，所以外观与没有背景功能时**完全一样**。
 *
 * ## 宽度是怎么算的（v0.3.7 追加需求 4：导出长图右侧不留大片空白）
 *
 * 版式宽度不是写死的 1200，而是**按内容收**（见 `cardWidthOf`）：
 *   · 右列宽度取「信息行 / 类型标签 / 剧照一行 / 推荐理由最长一行」四者的最大需求，夹在 [rightMin, rightMax]；
 *   · 卡片宽度 = 封面 + 间距 + 右列 + 两层内边距。
 * 这样「两张剧照 + 三行短理由」的一页会收成约 1000 宽，而不是硬画在 1200 的板上、
 * 右边留一大块白。**上限仍是 RL.width（1200）**，所以内容最多的那一页（5 张剧照 + 300 字理由）
 * 与改造前一样宽 —— 已有的表不会突然变形。
 * 长图里页与页必须**同宽**（否则右边缘参差、分隔线也长短不一），所以整份文档取各页的最大值，
 * 每页再按这个宽度重算右列 —— 见 `cardWidthOfAll` 与 exportHtml 的 buildExportDocument。
 *
 * ## 配色为什么写死浅色
 *
 * 导出图是给分享用的，必须不跟随应用主题（用户在深色主题下导出的图拿去发，别人看的还是白底黑字）。
 * 预览也用同一套浅色，好处是「看到的就是导出的」；代价是深色主题下预览是一块白纸 ——
 * 这是刻意的取舍：宁可看着亮一点，也不要预览深色、导出浅色这种「图和预览不一样」的惊吓。
 */

/** 版式几何常量（px） */
export const RL = {
  /** 版式宽度**上限**：内容自适应后的实际宽度 ≤ 它（见 cardWidthOf） */
  width: 1200,
  /** 版式宽度**下限**：再窄封面就顶到边了（封面 300 + 最小右列 + 两层内边距 ≈ 876） */
  minWidth: 880,
  /** 卡片边框宽度（右列宽度的公式里必须减掉它，否则内容会溢出 2px） */
  borderW: 1,
  /** 背景层的四周留白：用户设的背景在这一圈露出来（相当于卡片的"边框"） */
  frame: 14,
  /** 内容板的内边距（frame + pad = 34，与「只有一层内边距」的旧版完全一致 → 内容几何没变） */
  pad: 20,
  /** 卡片圆角 */
  radius: 18,
  /** 内容板圆角 */
  panelRadius: 12,
  /** 内容板在**有背景**时的不透明度（白板压住背景，保证文字可读；见文件头） */
  panelAlphaColor: 0.78,
  panelAlphaImage: 0.86,
  /** 封面列与右列的间距 */
  gap: 26,
  /**
   * 预览区四周的底色留白。
   *
   * 导出那边横向不能留白（见 bodyPadV），所以这两个数字**不相等** ——
   * 差别只在卡片外面那一圈灰边，卡片本身（宽度、内边距、每一段的高）完全一致。
   */
  sheetPad: 18,
  /**
   * 导出图 body 的**上下**留白。
   *
   * 只有竖向没有横向：离屏窗口的 CSS 视口宽度正好等于版式宽（主进程按 width 开窗口），
   * body 一旦有左右 padding，正好占满宽度的卡片就会溢出被裁。左右留白因此为 0，
   * 卡片自己铺满 —— 靠圆角和灰底就能看出边界。
   */
  bodyPadV: 24,
  /** 封面尺寸 */
  coverW: 300,
  coverH: 426,
  /** 右列宽度的取值范围（按内容自适应，见文件头） */
  rightMin: 480,
  rightMax: 804,
  /** 推荐理由那一列需要的宽度范围：太窄会折成很多行、太宽会留白 */
  reasonMinW: 360,
  reasonMaxW: 804,
  /** 头部：番剧名 / 原名 / 推荐人署名 */
  titleSize: 34,
  titleLine: 42,
  subSize: 16,
  recSize: 15,
  /** 信息区（评分 / 指数 / 时间 / 标签） */
  labelSize: 15,
  labelW: 92,
  valueSize: 19,
  rowGap: 12,
  /** 推荐指数星号 */
  starSize: 24,
  /** 推荐理由 */
  secTitleSize: 15,
  reasonSize: 18,
  reasonLine: 31,
  reasonMinH: 208,
  /** 剧照 */
  photoW: 148,
  photoH: 92,
  photoGap: 12,
  /** 页脚（表名 + 页码） */
  footSize: 13,
  /** 长图里两页之间的分页间距（页面之间用它 + 一条虚线分隔线隔开） */
  splitH: 46
} as const

/** 导出图配色（固定浅色，见文件头） */
export const RC = {
  /** 版式外的底色（导出图整张的底） */
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
  /** 封面/剧照取不到时露出的占位底色 */
  imageBg: '#eceef1'
} as const

/**
 * 字体栈：导出用的离屏窗口**不加载任何外部资源**，所以不能用应用自己的字体文件，
 * 只能用系统字体。这里挑的是 Windows / macOS 上中文显示都不难看的组合
 * （微软雅黑 / 苹方 / 冬青黑），预览也用同一串 —— 否则同一段字在两边的换行位置会不同。
 */
export const FONT =
  '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Segoe UI", system-ui, sans-serif'

// ------------------------------------------------------------------
// 文本口径（界面上显示的文案 = 导出图上的文案）
// ------------------------------------------------------------------

/** 展示用番剧名：中文名优先，没有才用原名（两边一致的唯一口径） */
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
 *
 * `emptyText` 由调用方给：bangumi 评分取不到是「我们没拿到」（—），
 * 推荐人评分没填是「用户还没打分」（未评分）—— 两件事在图上要能区分开。
 *
 * 为什么把「/ 10」也拼进来，而不是在两边各写一个单位 span：
 * 没有评分时那样会画成「— / 10」（一个悬空的单位），要在两个渲染器里各加一次条件判断；
 * 拼在一起就只有一种输出，两边不可能不一致。
 */
export function scoreText(v: number | null, emptyText = '—'): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)} / 10` : emptyText
}

/** 播出时间文案（取不到时说实话，不画一个空行） */
export function airDateText(v: string | null): string {
  return v && v.trim() ? v.trim() : '未知'
}

/**
 * 类型标签：最多画 6 个（右列宽度放得下），多出来的用「+N」表示。
 * 上限写在这里而不是数据层：数据层要保留全部标签（用户可能换版式），
 * 而版面画得下几个是**版式**的事。
 */
export const MAX_GENRE_CHIPS = 6

export function genreChips(genres: string[]): { list: string[]; rest: number } {
  const list = genres.slice(0, MAX_GENRE_CHIPS)
  return { list, rest: Math.max(0, genres.length - list.length) }
}

/** 推荐指数：5 个星位里亮几个（1–5），空位用 ☆ 的浅灰画 */
export function levelParts(level: number): { on: number; off: number } {
  const on = Math.min(5, Math.max(0, Math.round(level)))
  return { on, off: 5 - on }
}

/** 页脚页码文案：`第 1 / 3 页`（只导当前页时显示的也是它在整张表里的真实页码） */
export function pageNoText(index: number, total: number): string {
  return `第 ${Math.max(1, index)} / ${Math.max(1, total)} 页`
}

// ------------------------------------------------------------------
// 文字宽度估算（决定版式宽度，见文件头）
// ------------------------------------------------------------------

/**
 * 这个字符是不是「全角」宽度。
 *
 * 只为了估宽度，不追求 Unicode 全覆盖：中日韩、全角标点、Emoji 按 1 个字宽，
 * 其余（拉丁字母/数字/半角符号）按 0.56 个字宽 —— 估偏了也只是版式宽一点或窄一点。
 */
function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x1f300
  )
}

/** 估算一段文字的显示宽度（px） */
export function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) w += isWideChar(ch.codePointAt(0) ?? 0) ? fontSize : fontSize * 0.56
  return w
}

/** 估算「按宽度换行后会有几行」（理由占多高、卡片多宽都要用它） */
export function estimateWrappedLines(text: string, width: number, fontSize: number): number {
  if (width <= 0) return 1
  let lines = 0
  for (const raw of text.split('\n')) {
    lines += Math.max(1, Math.ceil(estimateTextWidth(raw, fontSize) / width))
  }
  return Math.max(1, lines)
}

/** 文本里最长一行的宽度（推荐理由的"自然宽度"就是它） */
function longestLineWidth(text: string, fontSize: number): number {
  let w = 0
  for (const line of text.split('\n')) w = Math.max(w, estimateTextWidth(line, fontSize))
  return w
}

// ------------------------------------------------------------------
// 宽度自适应（v0.3.7 追加需求 4）
// ------------------------------------------------------------------

/** 卡片上「除内容之外」的固定宽度：边框 + 背景层留白 + 内容板内边距 */
export function cardChromeWidth(): number {
  return RL.borderW * 2 + RL.frame * 2 + RL.pad * 2
}

/** 给定卡片宽度时的右列宽度（**渲染时必须用它**，而不是 rightWidthOf 的估算值，否则会溢出） */
export function rightWidthFor(cardWidth: number): number {
  return cardWidth - cardChromeWidth() - RL.coverW - RL.gap
}

/** 类型标签占的宽度（一行 6 个胶囊；真放不下时浏览器会换行，这里只是"希望多宽"） */
function chipsWidth(genres: string[]): number {
  const { list } = genreChips(genres)
  if (list.length === 0) return 0
  return list.reduce((w, g) => w + estimateTextWidth(g, 15) + 24 + 8, 0)
}

/**
 * 一页「右列需要多宽」：信息行 / 类型标签 / 剧照一行 / 推荐理由最长一行，四者取最大。
 *
 * 这是「收紧宽度但不压内容」的关键：宽度只由**真的会被画出来的东西**决定，
 * 而不是一律给 804。剧照那一项是硬的（一张 148，放不下就掉行），
 * 理由那一项取「最长一行的自然宽度」并夹在 [reasonMinW, reasonMaxW] ——
 * 用户把理由分成三段写时，卡片就会收窄到最长那段需要的宽度。
 */
export function rightWidthOf(page: RecommendPage): number {
  const infoNeed =
    RL.labelW +
    10 +
    Math.max(
      estimateTextWidth(scoreText(page.bgmRating), RL.valueSize),
      estimateTextWidth(scoreText(page.myRating, '未评分'), RL.valueSize),
      5 * RL.starSize + 10, // 推荐指数那一行是 5 个星号
      estimateTextWidth(airDateText(page.airDate), RL.valueSize)
    )
  const photos = Math.min(page.photos.length, MAX_PHOTOS)
  const photosNeed = photos > 0 ? photos * RL.photoW + (photos - 1) * RL.photoGap : 0
  const reasonNeed = Math.min(
    RL.reasonMaxW,
    Math.max(RL.reasonMinW, longestLineWidth(page.reason, RL.reasonSize))
  )
  const need = Math.max(infoNeed, chipsWidth(page.genres), photosNeed, reasonNeed)
  return Math.min(RL.rightMax, Math.max(RL.rightMin, Math.round(need)))
}

/** 一页实际会用到的卡片宽度（夹在 [minWidth, width]；导出请求的 width 就是它） */
export function cardWidthOf(page: RecommendPage): number {
  const need = cardChromeWidth() + RL.coverW + RL.gap + rightWidthOf(page)
  return Math.min(RL.width, Math.max(RL.minWidth, Math.round(need)))
}

/**
 * 一组页（长图）共用的卡片宽度：取各页需要宽度的**最大值**。
 *
 * 为什么必须统一：长图是**一个**文档里堆 N 张卡片，宽度不一致会让右边缘参差、
 * 分页虚线也长短不一；封面列也会对不齐，整张图看起来是歪的。
 * 取最大值意味着内容最"宽"的那一页决定整体宽度，其余页的右列会宽一些（文字多折几行就填满了）。
 * 空数组时给满宽：这时还没有内容可看，用满宽预览更像"一张空卡"。
 */
export function cardWidthOfAll(pages: RecommendPage[]): number {
  if (pages.length === 0) return RL.width
  let w: number = RL.minWidth
  for (const p of pages) w = Math.max(w, cardWidthOf(p))
  return w
}

// ------------------------------------------------------------------
// 背景（v0.3.7 追加需求 3）
// ------------------------------------------------------------------

/** 线性渐变的 CSS 值（色标按位置排序；CSS 本身不要求有序，但排一下更好读） */
export function linearGradientCss(bg: {
  angle: number
  stops: { color: string; pos: number }[]
}): string {
  const stops = [...bg.stops]
    .sort((a, b) => a.pos - b.pos)
    .map((s) => `${s.color} ${s.pos}%`)
    .join(', ')
  return `linear-gradient(${bg.angle}deg, ${stops})`
}

/**
 * 背景的 CSS 值（可直接塞进 `background:`）。
 *
 * 图片必须由调用方通过 `resolveImage` 给出地址：
 *   · 界面预览传 `localImgUrl(path)`（走 sakana-img 协议，白名单内的路径才读得到）；
 *   · 导出传 `{{img:bgN}}`（主进程会预取并替换成 data URL）。
 * 两边用的是**同一个函数**，所以背景图的构图（居中裁剪 cover）在预览与导出图里完全一致。
 */
export function backgroundCss(
  bg: RecommendBackground | undefined,
  resolveImage: (path: string) => string
): string {
  if (!bg) return RC.card
  if (bg.kind === 'color') return bg.color
  if (bg.kind === 'image') return `${resolveImage(bg.path)} center/cover no-repeat`
  return linearGradientCss(bg)
}

/**
 * 内容板的底色：没有背景时是**不透明纯白**（外观和没有背景功能时一模一样），
 * 有背景时是半透明白（让背景透出来，同时保住文字可读性，见文件头）。
 */
export function panelBackgroundOf(bg: RecommendBackground | undefined): string {
  if (!bg) return RC.card
  const alpha = bg.kind === 'color' ? RL.panelAlphaColor : RL.panelAlphaImage
  return `rgba(255, 255, 255, ${alpha})`
}

// ------------------------------------------------------------------
// 界面预览用的行内样式（React）
// ------------------------------------------------------------------

/** 预览外层：底色 + 四周留白（导出图那边用的是 body 的背景与 bodyPadV，见上面的说明） */
export const sheetStyle: CSSProperties = {
  background: RC.sheet,
  padding: RL.sheetPad
}

/**
 * 卡片本体（背景层）。
 *
 * `boxSizing: 'border-box'` 是**必须**的：宽度是按内容算出来的，如果按 content-box 计，
 * 加上左右内边距与背景层留白会多出一圈 —— 而导出的 CSS 里我同样写了 border-box，
 * 两边任一处漏掉这个属性就会差几十像素（而且只在有 padding 时才看得出来）。
 */
export function cardStyleOf(
  cardWidth: number,
  bg: RecommendBackground | undefined,
  resolveImage: (path: string) => string
): CSSProperties {
  return {
    boxSizing: 'border-box',
    width: cardWidth,
    background: backgroundCss(bg, resolveImage),
    border: `${RL.borderW}px solid ${RC.border}`,
    borderRadius: RL.radius,
    padding: RL.frame,
    color: RC.text,
    fontFamily: FONT,
    // 卡片自己不做滚动：翻页看的是整页内容，内部滚动会让长图导出没法照搬
    overflow: 'visible'
  }
}

/** 内容板：所有文字都画在它上面（半透明白，见文件头） */
export function panelStyleOf(bg: RecommendBackground | undefined): CSSProperties {
  return {
    background: panelBackgroundOf(bg),
    borderRadius: RL.panelRadius,
    padding: RL.pad,
    boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)'
  }
}

export const headStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  borderBottom: `1px solid ${RC.border}`,
  paddingBottom: 16,
  marginBottom: 22
}

export const titleStyle: CSSProperties = {
  fontSize: RL.titleSize,
  lineHeight: `${RL.titleLine}px`,
  fontWeight: 700,
  color: RC.text,
  margin: 0,
  wordBreak: 'break-word'
}

export const subTitleStyle: CSSProperties = {
  fontSize: RL.subSize,
  lineHeight: '22px',
  color: RC.faint,
  marginTop: 2,
  wordBreak: 'break-word'
}

/** 推荐人署名：**标题下方**的独立一行（用户要求「标题下方留推荐人署名位」），没填就不画 */
export const recStyle: CSSProperties = {
  fontSize: RL.recSize,
  lineHeight: '22px',
  color: RC.accent,
  marginTop: 6
}

export const bodyStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: RL.gap
}

export const coverBoxStyle: CSSProperties = {
  width: RL.coverW,
  height: RL.coverH,
  flexShrink: 0,
  borderRadius: 12,
  overflow: 'hidden',
  background: RC.imageBg,
  border: `1px solid ${RC.border}`
}

/**
 * 右列样式。
 *
 * `flexShrink: 0` 是防「差一像素」的：封面那侧已经写了 flex-shrink: 0，
 * 如果右列还能被压缩，浮点宽度误差会让它少一两个像素 —— 表现是标签/理由的折行位置
 * 和导出图不一样（这种差异用户只会觉得"看着有点不对"）。锁死不缩才两边一致。
 */
export function rightStyleOf(cardWidth: number): CSSProperties {
  return {
    width: rightWidthFor(cardWidth),
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 18
  }
}

export const infoRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  marginBottom: RL.rowGap
}

export const infoLabelStyle: CSSProperties = {
  width: RL.labelW,
  flexShrink: 0,
  fontSize: RL.labelSize,
  lineHeight: '26px',
  color: RC.faint
}

export const infoValueStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: RL.valueSize,
  lineHeight: '26px',
  color: RC.text
}

export const starOnStyle: CSSProperties = {
  fontSize: RL.starSize,
  lineHeight: '26px',
  color: RC.star,
  letterSpacing: 2
}

export const starOffStyle: CSSProperties = {
  fontSize: RL.starSize,
  lineHeight: '26px',
  color: RC.starEmpty,
  letterSpacing: 2
}

/** 取值数字：加粗一点，让评分在信息行里跳出来 */
export const scoreStyle: CSSProperties = {
  fontWeight: 700
}

/** 没有值时用的淡色文案（「暂无标签」「还没有写推荐理由」） */
export const dimStyle: CSSProperties = {
  color: RC.faint
}

/** 类型标签的小胶囊 */
export function chipStyle(): CSSProperties {
  return {
    display: 'inline-block',
    padding: '3px 12px',
    marginRight: 8,
    marginBottom: 6,
    borderRadius: 999,
    background: RC.chipBg,
    color: RC.dim,
    fontSize: 15,
    lineHeight: '20px'
  }
}

/** 标签放不下时那个「+N」胶囊：换成强调色，和真标签区分开（与导出 CSS 的 .chip-rest 一致） */
export function chipRestStyle(): CSSProperties {
  return { ...chipStyle(), background: RC.accentSoft, color: RC.accent }
}

export const secTitleStyle: CSSProperties = {
  fontSize: RL.secTitleSize,
  lineHeight: '22px',
  fontWeight: 700,
  color: RC.accent,
  marginBottom: 8
}

export const reasonStyle: CSSProperties = {
  fontSize: RL.reasonSize,
  lineHeight: `${RL.reasonLine}px`,
  color: RC.text,
  // 用户按回车分段是要保留的（推荐理由常写成几段），所以保留换行与连续空格
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  minHeight: RL.reasonMinH,
  margin: 0
}

export const photoRowStyle: CSSProperties = {
  display: 'flex',
  gap: RL.photoGap,
  flexWrap: 'nowrap'
}

export function photoBoxStyle(): CSSProperties {
  return {
    width: RL.photoW,
    height: RL.photoH,
    flexShrink: 0,
    borderRadius: 10,
    overflow: 'hidden',
    background: RC.imageBg,
    border: `1px solid ${RC.border}`
  }
}

export const photoEmptyStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: '24px',
  color: RC.faint
}

export const footStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  borderTop: `1px solid ${RC.border}`,
  marginTop: 22,
  paddingTop: 12,
  fontSize: RL.footSize,
  lineHeight: '20px',
  color: RC.faint
}

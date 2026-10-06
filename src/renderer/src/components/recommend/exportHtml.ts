import type { CardExportImageEntry } from '@shared/types'
import type { RecommendPage } from '@/stores/recommendTable'
import { MAX_PHOTOS } from '@/stores/recommendTable'
import {
  RC,
  RL,
  FONT,
  backgroundCss,
  cardChromeWidth,
  cardWidthOfAll,
  displayName,
  subName,
  scoreText,
  airDateText,
  genreChips,
  levelParts,
  pageNoText,
  panelBackgroundOf,
  rightWidthFor,
  estimateWrappedLines
} from './styles'

/**
 * 「番剧推荐表」导出图的 HTML 生成。
 *
 * ## 这个文件与 RecommendPageCard.tsx 的关系（最重要的一段）
 *
 * 两处画的是**同一张卡**：那边的 React 版是屏幕上看到的，这里的字符串版是导出用的。
 * 尺寸/字号/间距/颜色全部取自 `styles.ts` 的同一批常量，结构也逐层对应 ——
 * 改卡片结构时**两个文件必须一起改**（这是「所见即所得」的代价，也是唯一的代价；
 * 收益是不用为了导出再实现一套布局）。
 *
 * ## 为什么是「一个文档 + 图片占位符」，而不是自己拼多张图
 *
 * 主进程的 `exportCardImage` 会：预取图片 → 把 `{{img:key}}` 换成 data URL →
 * 在离屏窗口里按 width × scale 渲染 → 截图 → 弹保存框。所以长图**不需要**我们合成图片：
 * 把 N 页的版式依次放进**同一个文档**（页面之间用固定间距 + 虚线分隔线隔开）一次导出即可。
 * 这样也避免了自己拼图时接缝处的半像素错位。
 *
 * ## 宽度按内容收紧（v0.3.7 追加需求 4）
 *
 * 文档宽度**不是**写死的 1200，而是 `cardWidthOfAll(pages)`（各页需要宽度的最大值，见 styles.ts）。
 * 返回的 `width` 要原样交给 `api.tools.exportCardImage({ width })` —— 主进程就是按它开离屏窗口的，
 * 所以「卡片多宽，图就多宽」，右边不会剩一块空白。
 * ⚠️ `.page { width: … }` 必须**正好等于**这个宽度且 body 左右不留 padding，
 * 否则要么卡片被裁、要么右边多出灰边（那正是用户不要的空白）。
 *
 * ## 背景（v0.3.7 追加需求 3）
 *
 * 每页的背景画在 `.page` 上（`background: …`），内容再画在 `.panel`（半透明白板）上。
 * 背景图走**已有的** `{{img:key}}` 预取机制：key 用 `bg{slot}`，与封面/剧照同一条流水线，
 * 所以长图里每页各自的背景都能带出来。
 *
 * ## 离屏窗口的硬约束（踩过的坑都写在这里）
 *
 * 1. **不加载任何外部资源**：字体只能用系统字体栈，图标只能用字符（★/☆），
 *    不能用应用里的 CSS 变量（离屏窗口没有应用的样式表）。
 * 2. **不能有横向留白**：离屏窗口的 CSS 视口宽度正好等于 width，
 *    body 只要加了左右 padding，正好铺满的卡片就会溢出被裁 —— 所以左右 padding 是 0，
 *    卡片自己铺满宽度，靠圆角 + 灰底露出四个角。
 * 3. **卡片边框要算进宽度**：卡片是 `border-box`，右列宽度公式里减掉了边框与两层内边距，
 *    否则内容会溢出（而这种溢出只会让右边一点点被裁，肉眼很难发现）。
 */

/** 图片占位符：主进程按这个格式替换成 data URL */
function imgTag(key: string): string {
  return `{{img:${key}}}`
}

/**
 * HTML 转义。
 *
 * 番剧名、类型标签、推荐理由都是用户/接口来的文本，里面完全可能出现 `<`、`&`、`"`。
 * 不转义的话轻则版式错乱（`<` 之后整段被当成标签吃掉），重则注入一段 HTML 到导出图里。
 * `'` 也一起转：属性值用的是双引号，但转掉更省心。
 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 一行信息：左侧标签固定宽度，右侧内容自适应（与界面上 infoRowStyle 一一对应） */
function infoRow(label: string, valueHtml: string): string {
  return `<div class="row"><span class="lb">${esc(label)}</span><span class="vl">${valueHtml}</span></div>`
}

/** 推荐指数：亮星 + 暗星两段，颜色不同（和界面用同一套 levelParts） */
function starHtml(level: number): string {
  const { on, off } = levelParts(level)
  return `<span class="st-on">${'★'.repeat(on)}</span><span class="st-off">${'☆'.repeat(off)}</span>`
}

/** 类型标签：最多 6 个胶囊（与界面同一口径），多出来的用「+N」 */
function genresHtml(genres: string[]): string {
  if (genres.length === 0) return '<span class="vl-dim">暂无标签</span>'
  const { list, rest } = genreChips(genres)
  const chips = list.map((g) => `<span class="chip">${esc(g)}</span>`).join('')
  return chips + (rest > 0 ? `<span class="chip chip-rest">+${rest}</span>` : '')
}

/** 导出一页要用的输入 */
export interface RecommendExportOptions {
  /** 要导出的页（长图时是多页，顺序即拼接顺序） */
  pages: RecommendPage[]
  /** 每页在**整张表**里的页码（1 起）：只导当前页时页脚显示的是它的真实页码，不是 1 */
  pageNos: number[]
  /** 整张表的总页数（页脚「第 x / y 页」的分母） */
  pageCount: number
  /** 表名（页脚左侧） */
  tableName: string
  /** 推荐人署名（空串 = 不画这一行） */
  recommender: string
}

export interface RecommendExportDocument {
  /** 完整 HTML 文档（含 <style>） */
  html: string
  /** 要交给主进程预取的图片清单（封面 + 剧照 + 背景图） */
  images: CardExportImageEntry[]
  /** 版式宽度（按内容收紧后的）：**必须**原样传给 api.tools.exportCardImage 的 width */
  width: number
}

/**
 * 单页高度的**估算**（导出弹窗拿它预告图片尺寸）。
 *
 * 为什么是估算而不是精确值：精确高度要等浏览器排版完才知道，而弹窗是在导出**之前**显示的。
 * 这里按「版式常量 + 每段的固定高度」逐段加起来，和真实高度差在一两行文字以内
 * （卡片里所有区块的高度都是固定的：信息 5 行、理由最小高度、剧照一行），
 * 所以显示成「约 2400 × 7800」是有意义的 —— 用户能据此判断会不会太大。
 *
 * `cardWidth` 决定推荐理由一行的容量（宽度收紧后理由会多折几行），所以必须传进来。
 */
export function estimatePageHeight(
  page: RecommendPage,
  recommender = '',
  cardWidth = cardWidthOfAll([page])
): number {
  const rightW = rightWidthFor(cardWidth)
  const nameLen = displayName(page).length
  // 34px 字号 → 一行约 floor(内容宽 / 34) 个汉字；标题最多两行（再长会由 word-break 折下去）
  const titlePerLine = Math.max(8, Math.floor((cardWidth - cardChromeWidth()) / RL.titleSize))
  const titleLines = Math.min(2, Math.max(1, Math.ceil(nameLen / titlePerLine)))
  const head =
    titleLines * RL.titleLine +
    (subName(page) ? 24 : 0) + // 原名行：2px 间距 + 22px 行高
    (recommender.trim() ? 28 : 0) + // 推荐人署名行：6px 间距 + 22px 行高
    16 + // 头部下边框之上留的内边距
    22 + // 头部与正文之间的外边距
    RL.borderW * 2
  const info = 5 * (26 + RL.rowGap)
  const reasonLines = estimateWrappedLines(page.reason, rightW, RL.reasonSize)
  const reason = 22 + 8 + Math.max(RL.reasonMinH, reasonLines * RL.reasonLine)
  const photos = 22 + 8 + (page.photos.length > 0 ? RL.photoH : 24)
  const right = info + 18 + reason + 18 + photos
  const body = Math.max(RL.coverH, right)
  const foot = 22 + 12 + 20
  const panel = RL.pad * 2 + head + body + foot
  return Math.round(RL.frame * 2 + RL.borderW * 2 + panel)
}

/**
 * 整张导出图的高度估算（含页面之间的分页间距与上下留白）。
 * 上下的留白与导出 CSS 里的 body padding 用同一个常量（见 styles.ts 的 bodyPadV）。
 */
export function estimateExportHeight(pages: RecommendPage[], recommender = ''): number {
  if (pages.length === 0) return 0
  const cardWidth = cardWidthOfAll(pages)
  const sum = pages.reduce((acc, p) => acc + estimatePageHeight(p, recommender, cardWidth), 0)
  return Math.round(sum + RL.splitH * (pages.length - 1) + RL.bodyPadV * 2)
}

/**
 * 单页卡片 HTML（slot 从 1 起：占位符的 key 按**导出序号**编，不按全表页码，避免重号）。
 *
 * 结构：`.page`（背景层：用户设的纯色/渐变/图片）> `.panel`（半透明白板）> 头部 + 正文 + 页脚。
 * 与 `RecommendPageCard.tsx` 的 JSX 逐层对应，改这里要同步改那边。
 */
function pageHtml(
  page: RecommendPage,
  slot: number,
  pageNo: number,
  total: number,
  tableName: string,
  recommender: string
): string {
  const title = displayName(page)
  const sub = subName(page)
  const photos = page.photos.slice(0, MAX_PHOTOS)
  const photoHtml =
    photos.length === 0
      ? '<span class="pempty">还没有剧照</span>'
      : photos
          .map(
            (_p, i) =>
              `<span class="pbox"><img class="pimg" src="${imgTag(`ph${slot}_${i + 1}`)}" alt="剧照"></span>`
          )
          .join('')
  /*
   * 背景：没有背景时就是纯白（与改造前完全一样）；图片背景用 bg{slot} 占位符走预取。
   *
   * ⚠️ CSS 里的 url() **必须用单引号**：这一整串是塞进 HTML 属性 `style="…"` 的，
   * 里面再出现双引号会把属性提前截断（浏览器会把它解析成半截 style + 一堆垃圾属性）。
   */
  const bg = backgroundCss(page.background, () => `url('${imgTag(`bg${slot}`)}')`)

  return `<section class="page" style="background: ${bg}">
  <div class="panel" style="background: ${panelBackgroundOf(page.background)}">
    <div class="head">
      <div class="head-left">
        <h1 class="name">${esc(title)}</h1>
        ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
        ${recommender.trim() ? `<div class="rec">推荐人：${esc(recommender.trim())}</div>` : ''}
      </div>
    </div>
    <div class="body">
      <div class="cover"><img class="cover-img" src="${imgTag(`cov${slot}`)}" alt="封面"></div>
      <div class="right">
        <div class="info">
          ${infoRow('bangumi 评分', `<span class="score">${esc(scoreText(page.bgmRating))}</span>`)}
          ${infoRow('推荐人评分', `<span class="score">${esc(scoreText(page.myRating, '未评分'))}</span>`)}
          ${infoRow('推荐指数', starHtml(page.recommendLevel))}
          ${infoRow('播出时间', `<span>${esc(airDateText(page.airDate))}</span>`)}
          ${infoRow('类型标签', genresHtml(page.genres))}
        </div>
        <div class="reason">
          <div class="sec">推荐理由</div>
          <p class="txt">${esc(page.reason) || '<span class="vl-dim">还没有写推荐理由</span>'}</p>
        </div>
        <div class="photos">
          <div class="sec">剧照</div>
          <div class="prow">${photoHtml}</div>
        </div>
      </div>
    </div>
    <div class="foot"><span>${esc(tableName)}</span><span>${esc(pageNoText(pageNo, total))}</span></div>
  </div>
</section>`
}

/**
 * 生成导出文档 + 图片清单 + 版式宽度。
 *
 * 单页与长图走**同一个**函数：差别只在传进来几页（用户选「只导出当前页」就传一页），
 * 这样单页导出的版式不会和长图里的某一段出现细微差别。
 */
export function buildExportDocument(opts: RecommendExportOptions): RecommendExportDocument {
  const { pages, pageNos, pageCount, tableName, recommender } = opts
  const images: CardExportImageEntry[] = []
  const blocks: string[] = []
  // 宽度：各页需要宽度的最大值（长图里页与页必须同宽，见 styles.ts 的 cardWidthOfAll）
  const width = cardWidthOfAll(pages)

  pages.forEach((page, i) => {
    const slot = i + 1
    /*
     * 封面用候选链的第一档（large 优先，见 store 文件头 ③）；
     * 链为空时**也要**交一条空地址进去 —— 主进程会把它记进 missing 并告诉用户
     * 「这一页没有封面地址」，比在图上悄悄留一块灰底要诚实。
     */
    images.push({
      key: `cov${slot}`,
      url: page.covers[0] ?? page.cover ?? '',
      label: `${displayName(page)} 封面`
    })
    page.photos.slice(0, MAX_PHOTOS).forEach((p, j) => {
      images.push({ key: `ph${slot}_${j + 1}`, url: p, label: `${displayName(page)} 剧照 ${j + 1}` })
    })
    // 背景图同样交给主进程预取（本地路径由主进程直接读盘 → data URL）
    if (page.background?.kind === 'image') {
      images.push({ key: `bg${slot}`, url: page.background.path, label: `${displayName(page)} 背景图` })
    }
    blocks.push(pageHtml(page, slot, pageNos[i] ?? i + 1, pageCount, tableName, recommender))
  })

  // 分页分隔：固定高度的虚线，比「只留空白」更容易看出这是两页（长图发给别人时尤其重要）
  const split =
    '<div class="split"><span class="sline"></span><span class="scut">✂</span><span class="sline"></span></div>'
  const body = blocks.join(split)

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(tableName)}</title>
<style>
${exportCss(width)}
</style>
</head>
<body>
${body}
</body>
</html>`

  return { html, images, width }
}

/**
 * 导出用的 CSS。
 *
 * 这里的每个数字都来自 `styles.ts`（界面预览用的是同一批常量的行内样式版本）——
 * 这是「界面与导出图一致」的技术保证，不是巧合。改尺寸请改 styles.ts。
 *
 * `width` 是按内容收紧后的版式宽度（`buildExportDocument` 算出来并交给主进程的那一个）：
 * 它同时决定 `.page` 的宽度与右列宽度，**必须**是同一个值，否则右侧会多出空白（用户明确不要）。
 */
function exportCss(width: number): string {
  const rightW = rightWidthFor(width)
  return `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: ${RC.sheet};
  /* 竖向留白让圆角能露出底色；**左右必须是 0**，否则铺满宽度的卡片会被裁（见文件头 2） */
  padding: ${RL.bodyPadV}px 0;
  font-family: ${FONT};
  color: ${RC.text};
}
.page {
  /* 铺满视口宽度：宽度就是导出请求里的 width（内容自适应算出来的） */
  width: ${width}px;
  /* 背景由每页的行内 style 给（纯色/渐变/图片），这里是兜底的白 */
  background: ${RC.card};
  border: ${RL.borderW}px solid ${RC.border};
  border-radius: ${RL.radius}px;
  padding: ${RL.frame}px;
}
.panel {
  border-radius: ${RL.panelRadius}px;
  /* 底色由每页的行内 style 给（没背景 = 不透明纯白，有背景 = 半透明白） */
  padding: ${RL.pad}px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05);
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid ${RC.border};
  padding-bottom: 16px;
  margin-bottom: 22px;
}
.head-left { min-width: 0; }
.name {
  font-size: ${RL.titleSize}px;
  line-height: ${RL.titleLine}px;
  font-weight: 700;
  color: ${RC.text};
  margin: 0;
  word-break: break-word;
}
.sub { font-size: ${RL.subSize}px; line-height: 22px; color: ${RC.faint}; margin-top: 2px; word-break: break-word; }
.rec { font-size: ${RL.recSize}px; line-height: 22px; color: ${RC.accent}; margin-top: 6px; }
.body { display: flex; align-items: flex-start; gap: ${RL.gap}px; }
.cover {
  width: ${RL.coverW}px;
  height: ${RL.coverH}px;
  flex-shrink: 0;
  border-radius: 12px;
  overflow: hidden;
  background: ${RC.imageBg};
  border: 1px solid ${RC.border};
}
.cover-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.right { width: ${rightW}px; flex-shrink: 0; display: flex; flex-direction: column; gap: 18px; }
.row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: ${RL.rowGap}px; }
.lb { width: ${RL.labelW}px; flex-shrink: 0; font-size: ${RL.labelSize}px; line-height: 26px; color: ${RC.faint}; }
.vl { flex: 1; min-width: 0; font-size: ${RL.valueSize}px; line-height: 26px; color: ${RC.text}; }
.vl-dim { color: ${RC.faint}; }
.score { font-weight: 700; }
.st-on { font-size: ${RL.starSize}px; line-height: 26px; color: ${RC.star}; letter-spacing: 2px; }
.st-off { font-size: ${RL.starSize}px; line-height: 26px; color: ${RC.starEmpty}; letter-spacing: 2px; }
.chip {
  display: inline-block;
  padding: 3px 12px;
  margin-right: 8px;
  margin-bottom: 6px;
  border-radius: 999px;
  background: ${RC.chipBg};
  color: ${RC.dim};
  font-size: 15px;
  line-height: 20px;
}
.chip-rest { background: ${RC.accentSoft}; color: ${RC.accent}; }
.sec { font-size: ${RL.secTitleSize}px; line-height: 22px; font-weight: 700; color: ${RC.accent}; margin-bottom: 8px; }
.txt {
  font-size: ${RL.reasonSize}px;
  line-height: ${RL.reasonLine}px;
  color: ${RC.text};
  /* 用户按回车分段要保留（与界面 reasonStyle 的 pre-wrap 一致） */
  white-space: pre-wrap;
  word-break: break-word;
  min-height: ${RL.reasonMinH}px;
  margin: 0;
}
.prow { display: flex; gap: ${RL.photoGap}px; }
.pbox {
  width: ${RL.photoW}px;
  height: ${RL.photoH}px;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
  background: ${RC.imageBg};
  border: 1px solid ${RC.border};
}
.pimg { width: 100%; height: 100%; object-fit: cover; display: block; }
.pempty { font-size: 15px; line-height: 24px; color: ${RC.faint}; }
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid ${RC.border};
  margin-top: 22px;
  padding-top: 12px;
  font-size: ${RL.footSize}px;
  line-height: 20px;
  color: ${RC.faint};
}
/* 页面之间的分页分隔：固定高度 + 虚线（长图里一眼能看出页与页的边界） */
.split { display: flex; align-items: center; gap: 10px; height: ${RL.splitH}px; padding: 0 ${RL.frame}px; }
.sline { flex: 1; border-top: 2px dashed #cbd5e1; }
.scut { font-size: 13px; color: ${RC.faint}; }
`.trim()
}

import type { CardExportImageEntry } from '@shared/types'
import type { ModuleKind, ModuleLayout, ModuleRect, RecommendPage } from '@/stores/recommendTable'
import { MAX_PHOTOS, MODULE_KINDS, renderModules } from '@/stores/recommendTable'
import {
  FONT,
  type PageFrame,
  RC,
  RL,
  airDateText,
  blendStyle,
  chipStyle,
  coverImageStyle,
  cssText,
  dimTextStyle,
  displayName,
  emptyHintStyle,
  footRowStyle,
  frameOf,
  genreChips,
  imageBandImageStyle,
  imageBandWrapStyle,
  infoLabelStyle,
  infoRowStyle,
  infoValueStyle,
  levelParts,
  moduleBoxStyle,
  moduleRectsOf,
  pageBackgroundCss,
  pageNoText,
  pageStyle,
  photoBoxStyle,
  photoCellSize,
  photoImgStyle,
  photoRowStyle,
  reasonTextStyle,
  recTextStyle,
  scoreText,
  scoreTextStyle,
  secTitleStyle,
  starStyle,
  subName,
  subTextStyle,
  titleTextStyle
} from './styles'

/**
 * 「番剧推荐表」导出图的 HTML 生成。
 *
 * ## 与 RecommendPageCard.tsx 的关系（最重要的一段）
 *
 * 两处画的是**同一页**：那边的 React 版是屏幕上看到的，这里的字符串版是导出用的。
 * 所有尺寸、位置、颜色都来自 `styles.ts` 的同一批样式函数（`StyleRecord` → 这里用 `cssText()`），
 * 结构也逐层对应 —— 改结构时两个文件要一起改；而**改尺寸只需要改 styles.ts**。
 *
 * ## 页面 = 一块画布（v0.3.8）
 *
 * `.page` 的宽高完全由 `pageStyle(pageHeight)` 决定（宽 1200、高由背景图比例算出），
 * 里面有：背景层（可模糊）→ 叠加渐变层（可选）→ 各模块（绝对定位）。
 * 因为页面宽度固定 1200，**导出图片的宽度就是 1200 × 倍率**，不会比页面更宽（用户要求 4）。
 *
 * ## 为什么是「一个文档 + 图片占位符」
 *
 * 主进程的 `exportCardImage` 会：预取图片 → 把 `{{img:key}}` 换成 data URL →
 * 在离屏窗口里按 width × scale 渲染 → 截图 → 弹保存框。所以长图**不需要**我们合成图片：
 * 把 N 页依次放进**同一个文档**（页间用固定间距 + 虚线分隔线隔开）一次导出即可。
 *
 * ## 离屏窗口的硬约束
 *
 * 1. **不加载任何外部资源**：字体只能用系统字体栈、图标只能用字符（★/☆）、不能用应用里的 CSS 变量；
 * 2. **不能有横向留白**：body 加了左右 padding 就会把正好铺满宽度的页面裁掉；
 * 3. **行内 style 里不能出现双引号**：`style="…"` 用双引号包裹，所以 CSS 里的 `url()` 必须用单引号。
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
 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 行内样式属性（自动带上 style="…"） */
function styleAttr(rec: Record<string, string>): string {
  return ` style="${cssText(rec)}"`
}

/** 一行信息：左侧标签固定宽度，右侧内容自适应 */
function infoRow(label: string, valueHtml: string): string {
  return `<div${styleAttr(infoRowStyle())}><span${styleAttr(
    infoLabelStyle()
  )}>${esc(label)}</span><span${styleAttr(infoValueStyle())}>${valueHtml}</span></div>`
}

/** 推荐指数：亮星 + 暗星两段（和界面用同一套 levelParts） */
function starHtml(level: number): string {
  const { on, off } = levelParts(level)
  return (
    `<span${styleAttr(starStyle(true))}>${'★'.repeat(on)}</span>` +
    `<span${styleAttr(starStyle(false))}>${'☆'.repeat(off)}</span>`
  )
}

/** 类型标签：最多 6 个胶囊，多出来的用「+N」 */
function genresHtml(genres: string[]): string {
  if (genres.length === 0) return `<span${styleAttr(dimTextStyle())}>暂无标签</span>`
  const { list, rest } = genreChips(genres)
  const chips = list.map((g) => `<span${styleAttr(chipStyle(false))}>${esc(g)}</span>`).join('')
  return chips + (rest > 0 ? `<span${styleAttr(chipStyle(true))}>+${rest}</span>` : '')
}

/** 模块的内容（导出侧），与 RecommendPageCard 的 renderModule 一一对应 */
function moduleBody(
  m: ModuleLayout,
  rect: ModuleRect,
  page: RecommendPage,
  frame: PageFrame,
  ctx: { pageNo: number; pageCount: number; tableName: string; recommender: string; slot: number }
): string {
  switch (m.id) {
    case 'cover':
      return `<img${styleAttr(coverImageStyle())} src="${imgTag(`cov${ctx.slot}`)}" alt="封面">`
    case 'title': {
      const sub = subName(page)
      const rec = ctx.recommender.trim()
      return (
        `<h1${styleAttr(titleTextStyle())}>${esc(displayName(page))}</h1>` +
        (sub ? `<div${styleAttr(subTextStyle())}>${esc(sub)}</div>` : '') +
        (rec ? `<div${styleAttr(recTextStyle())}>推荐人：${esc(rec)}</div>` : '')
      )
    }
    case 'ratings':
      return (
        infoRow(
          'bangumi 评分',
          `<span${styleAttr(scoreTextStyle())}>${esc(scoreText(page.bgmRating))}</span>`
        ) +
        infoRow(
          '推荐人评分',
          `<span${styleAttr(scoreTextStyle())}>${esc(scoreText(page.myRating, '未评分'))}</span>`
        )
      )
    case 'level':
      return infoRow('推荐指数', starHtml(page.recommendLevel))
    case 'meta':
      return (
        infoRow('播出时间', `<span>${esc(airDateText(page.airDate))}</span>`) +
        infoRow('类型标签', genresHtml(page.genres))
      )
    case 'reason':
      return (
        `<div${styleAttr(secTitleStyle())}>推荐理由</div>` +
        `<p${styleAttr(reasonTextStyle())}>${
          esc(page.reason) || `<span${styleAttr(emptyHintStyle())}>还没有写推荐理由</span>`
        }</p>`
      )
    case 'photos': {
      const photos = page.photos.slice(0, MAX_PHOTOS)
      const cell = photoCellSize(rect, frame)
      const boxes =
        photos.length === 0
          ? `<span${styleAttr(emptyHintStyle())}>还没有剧照</span>`
          : photos
              .map(
                (_p, i) =>
                  `<span${styleAttr(photoBoxStyle(cell.w, cell.h))}><img${styleAttr(
                    photoImgStyle()
                  )} src="${imgTag(`ph${ctx.slot}_${i + 1}`)}" alt="剧照"></span>`
              )
              .join('')
      return `<div${styleAttr(secTitleStyle())}>剧照</div><div${styleAttr(photoRowStyle())}>${boxes}</div>`
    }
    case 'foot':
      return (
        `<div${styleAttr(footRowStyle())}><span>${esc(ctx.tableName)}</span>` +
        `<span>${esc(pageNoText(ctx.pageNo, ctx.pageCount))}</span></div>`
      )
    default:
      return ''
  }
}

/** 一个模块的完整 HTML：绝对定位到版式算出来的矩形（**没有白板**，文字靠页面级 text-shadow） */
function moduleHtml(
  m: ModuleLayout,
  rect: ModuleRect,
  order: number,
  page: RecommendPage,
  frame: PageFrame,
  ctx: { pageNo: number; pageCount: number; tableName: string; recommender: string; slot: number }
): string {
  // 模块**没有白板**：内容直接落在页面上（可读性靠页面级 text-shadow，见 styles.pageStyle）
  const body = moduleBody(m, rect, page, frame, ctx)
  return `<div${styleAttr(moduleBoxStyle(rect, order))} data-module="${m.id}">${body}</div>`
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
  /**
   * 这次只导出哪些模块（undefined / 空数组 = 全都导）。
   * 注意：页面自己隐藏的模块（`visible: false`）**永远不导**，不受这里影响。
   */
  modules?: ModuleKind[]
}

export interface RecommendExportDocument {
  html: string
  /** 要交给主进程预取的图片清单（封面 + 剧照 + 背景图） */
  images: CardExportImageEntry[]
  /** 版式宽度 = 页面宽度（用户要求「导出图最大宽度 = 推荐页宽度」） */
  width: number
  /** 版式高度（各页高度 + 分页间距 + 上下留白）——弹窗预告尺寸与它一致 */
  height: number
}

/** 单页 HTML（slot 从 1 起：占位符的 key 按**导出序号**编，不按全表页码，避免重号） */
function pageHtml(
  page: RecommendPage,
  slot: number,
  pageNo: number,
  total: number,
  tableName: string,
  recommender: string,
  modules: ModuleKind[] | null
): string {
  const frame = frameOf(page)
  const rects = moduleRectsOf(frame)
  /*
   * 要画的模块**一律走 renderModules**（补全 → 丢掉隐藏的 → 再按导出勾选过滤）。
   * 它与界面预览用的是**同一个函数**：以前两边各写一遍，卡片那边漏了 filter(visible)，
   * 于是「模块隐藏了、预览里还在显示」（v0.3.8 的 bug）。现在两边只有一份口径。
   */
  const list = renderModules(page, modules)
  const ctx = { pageNo, pageCount: total, tableName, recommender, slot }

  /*
   * 背景：页面底色（纯色/渐变，或图片背景时的白）→ 图区里的图片层 → 交融渐变 → 模块。
   * 图区只占页面的一部分（比例见 styles 的 IMAGE_CONTENT_RATIO），图用 cover 裁剪；
   * 交融渐变贴在图区靠内容区那一侧、渐隐到页面底色，所以两者之间没有硬边。
   */
  const bandWrap = imageBandWrapStyle(frame)
  const bandLayer = bandWrap
    ? `<div${styleAttr(bandWrap)}><div style="${cssText(
        imageBandImageStyle(frame, page.background, () => `url('${imgTag(`bg${slot}`)}')`)
      )}"></div></div>`
    : ''
  const blendLayer = frame.pos === 'none' ? '' : `<div${styleAttr(blendStyle(frame))}></div>`
  const body = list
    .map((m) => moduleHtml(m, rects[m.id], MODULE_KINDS.indexOf(m.id), page, frame, ctx))
    .join('\n')

  return `<section${styleAttr({
    ...pageStyle(frame),
    background: pageBackgroundCss(page.background)
  })}>
${bandLayer}${blendLayer}
${body}
</section>`
}

/**
 * 生成导出文档 + 图片清单 + 尺寸。
 *
 * 单页与长图走**同一个**函数：差别只在传进来几页（用户选「只导出当前页」就传一页）。
 */
export function buildExportDocument(opts: RecommendExportOptions): RecommendExportDocument {
  const { pages, pageNos, pageCount, tableName, recommender, modules } = opts
  const images: CardExportImageEntry[] = []
  const blocks: string[] = []

  pages.forEach((page, i) => {
    const slot = i + 1
    /*
     * 这一页**实际会画出来**的模块（页面隐藏的已经不在里面了）。
     * 图片预取必须按它来判：隐藏的模块不该产生网络请求，更不该报"缺图"——
     * 用户明明把封面关掉了，导出却弹一句「封面没取到」是很荒唐的。
     */
    const drawn = renderModules(page, modules)
    const willDraw = (id: ModuleKind): boolean => drawn.some((m) => m.id === id)

    if (willDraw('cover')) {
      images.push({
        key: `cov${slot}`,
        // 候选链为空时也交一条空地址：主进程会记进 missing 并如实告诉用户
        url: page.covers[0] ?? page.cover ?? '',
        label: `${displayName(page)} 封面`
      })
    }
    if (willDraw('photos')) {
      page.photos.slice(0, MAX_PHOTOS).forEach((p, j) => {
        images.push({ key: `ph${slot}_${j + 1}`, url: p, label: `${displayName(page)} 剧照 ${j + 1}` })
      })
    }
    // 背景属于页面（不属于某个模块），所以只要这页在导出里，背景图就要预取
    if (page.background?.kind === 'image') {
      images.push({ key: `bg${slot}`, url: page.background.path, label: `${displayName(page)} 背景图` })
    }
    blocks.push(
      pageHtml(page, slot, pageNos[i] ?? i + 1, pageCount, tableName, recommender, modules ?? null)
    )
  })

  // 分页分隔：固定高度的虚线，比「只留空白」更容易看出这是两页（长图发给别人时尤其重要）
  const split =
    '<div class="split"><span class="sline"></span><span class="scut">✂</span><span class="sline"></span></div>'
  const body = blocks.join(split)
  const height =
    pages.reduce((sum, p) => sum + frameOf(p).height, 0) + RL.splitH * Math.max(0, pages.length - 1)

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(tableName)}</title>
<style>
${exportCss()}
</style>
</head>
<body>
${body}
</body>
</html>`

  return { html, images, width: RL.width, height: height + RL.bodyPadV * 2 }
}

/**
 * 导出用的 CSS：只剩**文档级**的几条。
 * 页面与模块的样式全在行内（与预览共用 `styles.ts`），所以这里不需要跟着改尺寸。
 */
function exportCss(): string {
  return `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: ${RC.sheet};
  /* 竖向留白让圆角露出底色；**左右必须是 0**，否则铺满宽度的页面会被裁（见文件头 2） */
  padding: ${RL.bodyPadV}px 0;
  font-family: ${FONT};
  color: ${RC.text};
}
img { display: block; }
h1, p { margin: 0; }
.split { display: flex; align-items: center; gap: 10px; height: ${RL.splitH}px; padding: 0 24px; }
.sline { flex: 1; border-top: 2px dashed #cbd5e1; }
.scut { font-size: 13px; color: ${RC.faint}; }
`.trim()
}

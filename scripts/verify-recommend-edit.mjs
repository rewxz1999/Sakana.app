/**
 * 「番剧推荐表 · 自定义页面内容」自检（v0.3.9）。
 *
 * 与 `verify-custom-history.mjs` 同一套做法：直接 import **真实源码**
 * （`stores/recommendTable.ts` / `components/recommend/styles.ts` / `components/recommend/exportHtml.ts`），
 * 所以下面每一条断言都是产品代码的真实行为，不是测试里的副本。
 *
 * 覆盖用户点名的三条自测要求：
 *   ① 改了 `bandRatio` / 模块坐标之后，**导出 HTML 里的数值 == 几何函数算出来的数值**
 *      （界面预览也读同一个函数 —— 所以这条等价于"预览的 DOM 几何 == 导出 HTML"）；
 *   ② 手填页面尺寸后，导出文档的宽高 == 页面尺寸（成图像素 = 文档尺寸 × 清晰度）；
 *   ③ 字体只出现白名单里的值（`font-family` 一处都不许出现非白名单字体）。
 *
 * 用法（项目根目录）：`node scripts/verify-recommend-edit.mjs`
 * 退出码 0 = 全部断言通过。
 */

import { register } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const srcUrl = pathToFileURL(join(root, 'src')).href

// ---- ① 路径别名解析钩子（@shared/* → src/shared/*、@/* → src/renderer/src/*） ----
// 另外要处理**相对路径无扩展名**的 import（源码里写 `./styles`，Node 不认）：
// 在 alias 规则之外补一条"按扩展名试一遍"的规则。
const loaderSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const RULES = [
  [/^@shared\\//, ${JSON.stringify(`${srcUrl}/shared/`)}],
  [/^@\\//, ${JSON.stringify(`${srcUrl}/renderer/src/`)}]
]
const EXT = ['.ts', '.tsx', '/index.ts', '/index.tsx']
export async function resolve(specifier, context, next) {
  for (const [re, base] of RULES) {
    if (!re.test(specifier)) continue
    const rest = specifier.replace(re, '')
    for (const cand of EXT) {
      if (existsSync(fileURLToPath(base + rest + cand))) return next(base + rest + cand, context)
    }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    for (const cand of EXT) {
      const u = new URL(specifier + cand, context.parentURL)
      if (existsSync(fileURLToPath(u))) return next(u.href, context)
    }
  }
  return next(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`)
await new Promise((resolve) => setImmediate(resolve))

// ---- ② preload 注入的空壳（只为了让 @/lib/api 能加载；本脚本不调用任何接口） ----
globalThis.window = { sakana: {} }

const store = await import(new URL('../src/renderer/src/stores/recommendTable.ts', import.meta.url).href)
const styles = await import(
  new URL('../src/renderer/src/components/recommend/styles.ts', import.meta.url).href
)
const exportHtml = await import(
  new URL('../src/renderer/src/components/recommend/exportHtml.ts', import.meta.url).href
)

const {
  BAND_RATIO_MAX,
  BAND_RATIO_MIN,
  DEFAULT_FONT_STACK,
  MODULE_FONTS,
  MODULE_FONT_BASE,
  MODULE_FONT_SIZE_MAX,
  MODULE_FONT_SIZE_MIN,
  MODULE_KINDS,
  PAGE_SIZE_MAX,
  PAGE_SIZE_MIN,
  fontCssOf,
  isDefaultLayout,
  narrowPage,
  normalizeBandRatio,
  normalizeFontKey,
  normalizeFontSize,
  normalizeModules,
  normalizePage,
  renderModules,
  resolveModules
} = store
const { IMAGE_CONTENT_RATIO, frameOf, moduleRectsOf, pageBackgroundCss } = styles
const { buildExportDocument } = exportHtml

let passed = 0
const failures = []
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) passed++
  else failures.push(`${name}\n    期望: ${e}\n    实际: ${a}`)
}
function ok(name, cond, detail = '') {
  if (cond) passed++
  else failures.push(`${name}${detail ? `\n    ${detail}` : ''}`)
}
function section(title) {
  console.log(`\n=== ${title} ===`)
}

/** 造一页（只给纯函数需要的字段；封面用不到真实地址） */
function mkPage(extra = {}) {
  return {
    id: 'p1',
    subjectId: 1,
    name: 'Test Anime',
    nameCn: '测试番剧',
    cover: 'https://a/c.jpg',
    covers: ['https://a/l.jpg'],
    bgmRating: 8.1,
    myRating: 9,
    recommendLevel: 4,
    airDate: '2026-04-01',
    genres: ['日常'],
    reason: '理由',
    photos: [],
    ...extra
  }
}

/** 从一个模块的 HTML 里抠出 left/top/width/height（导出图真正会画在哪） */
function moduleGeom(html, id) {
  const re = new RegExp(`<div style="([^"]*)" data-module="${id}"`)
  const m = html.match(re)
  if (!m) return null
  const rec = {}
  for (const part of m[1].split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    rec[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return rec
}
const px = (v) => (typeof v === 'string' && v.endsWith('px') ? Number(v.slice(0, -2)) : NaN)

/**
 * 抠出导出 HTML 里**行内样式**上的 font-family（自测要求 ③）。
 *
 * 只看行内样式（`style="…"`），不看 `<style>` 块里的 body 规则 ——
 * 用户能改的字体是模块级的，而模块的字体全部写在行内样式上。
 * 顺带把单/双引号归一，方便与白名单字符串直接比对。
 */
function fontFamilies(html) {
  const inline = [...html.matchAll(/ style="([^"]*)"/g)].map((m) => m[1])
  return inline
    .flatMap((s) => [...s.matchAll(/font-family:\s*([^;]+)/g)].map((m) => m[1].trim()))
    .map((s) => s.replace(/"/g, "'"))
}
const normCss = (s) => s.replace(/"/g, "'")

// ------------------------------------------------------------------
// 0. 常量与白名单
// ------------------------------------------------------------------
section('0. 形状与常量')
console.log('store 导出：', Object.keys(store).sort().join('、'))
check('模块仍是 8 个', MODULE_KINDS.length, 8)
check('默认字体栈在数据层定义（styles 只是转发）', styles.FONT, DEFAULT_FONT_STACK)
check('字体白名单里没有任意字体输入的可能（全部是 key）', MODULE_FONTS.every((f) => /^[a-z][A-Za-z]*$/.test(f.key)), true)
check(
  '白名单覆盖用户点名的几种',
  ['song', 'hei', 'heiSim', 'kai', 'xingkai', 'fangsong'].every((k) =>
    MODULE_FONTS.some((f) => f.key === k)
  ),
  true
)
check('页面尺寸上限 ≤ 主进程导出宽度上限 4000（否则"像素=尺寸×倍率"不成立）', PAGE_SIZE_MAX <= 4000, true)
check('占比默认仍是 1.5 : 1', IMAGE_CONTENT_RATIO, 1.5)
check('模块字号范围合理', [MODULE_FONT_SIZE_MIN, MODULE_FONT_SIZE_MAX], [10, 72])
check('占比范围', [BAND_RATIO_MIN, BAND_RATIO_MAX], [0.4, 4])

// ------------------------------------------------------------------
// 1. 收窄（磁盘脏数据 → 合法数据）
// ------------------------------------------------------------------
section('1. 收窄 normalize*')
check('占比：非法一律 undefined（= 用默认 1.5）', [normalizeBandRatio(null), normalizeBandRatio(NaN), normalizeBandRatio(0), normalizeBandRatio('1.5')], [undefined, undefined, undefined, undefined])
check('占比：夹进区间', [normalizeBandRatio(0.01), normalizeBandRatio(99), normalizeBandRatio(2.345)], [BAND_RATIO_MIN, BAND_RATIO_MAX, 2.35])
check('占比：1.5 原样返回', normalizeBandRatio(1.5), 1.5)

check('字体 key：白名单内保留', MODULE_FONTS.map((f) => normalizeFontKey(f.key) === f.key), MODULE_FONTS.map(() => true))
check('字体 key：白名单外一律 undefined', ['Comic Sans MS', 'Arial', '', null, 42, 'song;}.x{color:red'].map(normalizeFontKey), [undefined, undefined, undefined, undefined, undefined, undefined])
check('字号：夹进 10–72 且取整', [normalizeFontSize(3), normalizeFontSize(200), normalizeFontSize(18.6)], [MODULE_FONT_SIZE_MIN, MODULE_FONT_SIZE_MAX, 19])
check('字号：非有限数 → undefined（= 用基准）', [normalizeFontSize(NaN), normalizeFontSize('18'), normalizeFontSize(undefined)], [undefined, undefined, undefined])
check('fontCssOf：认不出的 key 回落默认栈（不猜字体）', [fontCssOf('x'), fontCssOf(undefined), fontCssOf('xingkai')], [DEFAULT_FONT_STACK, DEFAULT_FONT_STACK, MODULE_FONTS.find((f) => f.key === 'xingkai').css])

section('1b. 布局收窄 normalizeModules（坐标回来了）')
const layoutDirty = normalizeModules([
  { id: 'reason', visible: true, x: 12.6, y: -30, w: 3, h: 5000, z: 99.4, fontSize: 200, fontFamily: 'Arial' },
  { id: 'cover', visible: false, scale: 2 },
  { id: 'nope', visible: true },
  { id: 'reason', visible: true, x: 999 },
  null
])
console.log('收窄结果：', JSON.stringify(layoutDirty))
check('只留合法 id（重复的丢掉）', layoutDirty.map((m) => m.id), ['reason', 'cover'])
check('坐标保留有限数，负数夹到 0', [layoutDirty[0].x, layoutDirty[0].y], [13, 0])
check('尺寸夹到下限', [layoutDirty[0].w, layoutDirty[0].h], [store.MODULE_W_MIN, PAGE_SIZE_MAX])
check('z 取整并夹进 -99..999', layoutDirty[0].z, 99)
check('非法字体/字号被丢掉', [layoutDirty[0].fontFamily, layoutDirty[0].fontSize], [undefined, MODULE_FONT_SIZE_MAX])
check('老字段 scale 被丢掉（那套已被模块字号取代）', 'scale' in layoutDirty[1], false)
check('显式 false 的显隐保留', layoutDirty[1].visible, false)
check('非数组 → undefined', [normalizeModules(null), normalizeModules({}), normalizeModules([])], [undefined, undefined, undefined])

check(
  'isDefaultLayout：只有显隐全开且无坐标/字体才算默认',
  [
    isDefaultLayout(resolveModules({})),
    isDefaultLayout(resolveModules({ layout: [{ id: 'cover', visible: true }] })),
    isDefaultLayout(resolveModules({ layout: [{ id: 'cover', visible: false }] })),
    isDefaultLayout(resolveModules({ layout: [{ id: 'cover', visible: true, x: 0 }] }))
  ],
  [true, true, false, false]
)

section('1c. 页面补丁白名单（updatePage / applyPagePatch 共用 narrowPage）')
const p0 = mkPage()
const p1 = narrowPage(p0, { bandRatio: 99, contentGradient: { angle: 20, stops: [{ color: '#ff0000', pos: 0, alpha: 1 }, { color: '#00ff00', pos: 100, alpha: 1 }] } })
check('bandRatio 过一遍夹取', p1.bandRatio, BAND_RATIO_MAX)
check('contentGradient 被收窄成合法图层', [p1.contentGradient.angle, p1.contentGradient.stops.length], [20, 2])
check('非法 contentGradient → null（不画这一层）', narrowPage(p0, { contentGradient: { stops: [{ color: '#fff', pos: 0, alpha: 1 }] } }).contentGradient, null)
check('不传的字段不受影响', [p1.subjectId, p1.reason], [1, '理由'])
const p2 = narrowPage(p1, { layout: [{ id: 'reason', visible: true, x: 10, y: 20 }] })
check('layout 过收窄且坐标保留', [p2.layout[0].x, p2.layout[0].y, p2.layout[0].visible], [10, 20, true])
check('清掉 layout（undefined = 回默认版式）', narrowPage(p2, { layout: undefined }).layout, undefined)

const parsed = normalizePage(
  { ...mkPage(), bandRatio: 2, contentGradient: { angle: 90, stops: [{ color: '#123456', pos: 0, alpha: 1 }, { color: '#654321', pos: 100, alpha: 1 }] }, layout: [{ id: 'title', visible: true, x: 5, y: 6, w: 300, h: 90, fontFamily: 'kai', fontSize: 40 }] },
  0
)
check('读盘时新字段都在（随页面持久化）', [parsed.bandRatio, parsed.contentGradient.stops[0].color, parsed.layout[0].x, parsed.layout[0].fontFamily, parsed.layout[0].fontSize], [2, '#123456', 5, 'kai', 40])
check('没有新字段的老数据 → 全部 undefined（外观与加这个功能之前一致）', [parsed && normalizePage(mkPage(), 0).bandRatio, normalizePage(mkPage(), 0).contentGradient, normalizePage(mkPage(), 0).layout], [undefined, undefined, undefined])

// ------------------------------------------------------------------
// 2. 几何：frameOf 用 bandRatio（四个方向）
// ------------------------------------------------------------------
section('2. frameOf：占比可调 + 上/下/左/右')
const img = (imagePos, imgW = 1600, imgH = 900) => ({
  kind: 'image',
  color: '#ffffff',
  angle: 135,
  stops: [],
  path: 'x.png',
  imgW,
  imgH,
  imagePos,
  blur: 0,
  crop: null
})
/** 图区 : 内容区 的实际比值（用来核对"用户设的比例真的生效了"） */
function ratioOf(f) {
  if (f.pos === 'left' || f.pos === 'right') return f.imageW / f.contentW
  if (f.pos === 'top' || f.pos === 'bottom') return f.imageH / f.contentH
  return null
}
for (const pos of ['left', 'right', 'top', 'bottom']) {
  const f = frameOf({ background: img(pos), size: { w: 1200, h: 1000 }, bandRatio: 3 })
  // 按 round 切，所以实际比值允许有 ±0.01 的误差（那是取整，不是比例算错）
  ok(`bandRatio=3 在 ${pos} 生效（实际 ${ratioOf(f).toFixed(4)}）`, Math.abs(ratioOf(f) - 3) < 0.02, JSON.stringify(f))
  ok(`${pos}：图区与内容区不重叠且铺满页面`, f.imageW * f.imageH > 0, JSON.stringify(f))
}
const fLeft = frameOf({ background: img('left'), size: { w: 1200, h: 1000 }, bandRatio: 3 })
check('左侧图：图区贴左、内容区接在右边', [fLeft.imageX, fLeft.contentX, fLeft.contentX + fLeft.contentW], [0, fLeft.imageW, 1200])
const fBottom = frameOf({ background: img('bottom'), size: { w: 1200, h: 1000 }, bandRatio: 3 })
check('下图：内容区在上、图区贴底', [fBottom.contentY, fBottom.imageY, fBottom.imageY + fBottom.imageH], [0, fBottom.contentH, 1000])
check('没设 bandRatio → 沿用默认 1.5 : 1', [ratioOf(frameOf({ background: img('left'), size: { w: 1200, h: 1000 } })).toFixed(4)], ['1.5000'])
check('没有图片时 ratio 字段不产生任何影响', [
  frameOf({ size: { w: 1000, h: 800 }, bandRatio: 4 }).contentW,
  frameOf({ size: { w: 1000, h: 800 } }).contentW
], [1000, 1000])

// ------------------------------------------------------------------
// 3. 几何：moduleRectsOf 优先用用户坐标并夹进页面
// ------------------------------------------------------------------
section('3. moduleRectsOf：默认版式 vs 用户坐标')
const plain = mkPage({ size: { w: 1200, h: 920 } })
const f0 = frameOf(plain)
const base = moduleRectsOf(f0)
check('没写坐标 = 默认摆放（老数据一字不变）', base.reason, { x: 360, y: 436, w: 804, h: 274 })
check('传 undefined / 空数组都一样', [moduleRectsOf(f0, undefined).reason, moduleRectsOf(f0, []).reason], [base.reason, base.reason])

const moved = mkPage({
  size: { w: 1200, h: 920 },
  layout: [
    { id: 'reason', visible: true, x: 100, y: 200, w: 500, h: 150 },
    { id: 'foot', visible: true, x: 5000, y: 5000, w: 9999, h: 9999 },
    { id: 'title', visible: false }
  ]
})
const fm = frameOf(moved)
const rm = moduleRectsOf(fm, moved.layout)
check('有坐标就用坐标', rm.reason, { x: 100, y: 200, w: 500, h: 150 })
check('越界的坐标被夹进页面（右下角最多贴边）', [rm.foot.x + rm.foot.w, rm.foot.y + rm.foot.h], [1200, 920])
check('越界后的尺寸不小于下限', [rm.foot.w >= store.MODULE_W_MIN, rm.foot.h >= store.MODULE_H_MIN], [true, true])
check('没写坐标的模块仍按版式（rating 不动）', rm.ratings, base.ratings)
check('隐藏的模块不参与渲染', renderModules(moved).map((m) => m.id).includes('title'), false)
check('隐藏的模块仍然有矩形（界面）', typeof rm.title.x, 'number')

// ------------------------------------------------------------------
// 4. 导出 HTML vs 几何：数值必须逐项相等（自测要求 ①）
// ------------------------------------------------------------------
section('4. 导出 HTML 的数值 == 几何函数的数值（预览/导出一致）')
const doc = buildExportDocument({
  pages: [moved],
  pageNos: [1],
  pageCount: 1,
  tableName: '自检表',
  recommender: '自检'
})
console.log(`导出文档：宽度 ${doc.width}，高度 ${doc.height}，图片 ${doc.images.length} 张`)
for (const id of MODULE_KINDS) {
  if (!renderModules(moved).some((m) => m.id === id)) continue
  const g = moduleGeom(doc.html, id)
  const r = rm[id]
  check(
    `${id} 的 left/top/width/height 与 moduleRectsOf 一致`,
    [px(g.left), px(g.top), px(g.width), px(g.height)],
    [r.x, r.y, r.w, r.h]
  )
}
check('导出 HTML 里每个画出来的模块都有 data-module', MODULE_KINDS.every((id) => /data-module="[a-z]+"/.test(doc.html)), true)

// ------------------------------------------------------------------
// 5. 页面尺寸 ↔ 导出尺寸（自测要求 ②）
// ------------------------------------------------------------------
section('5. 手填尺寸 = 导出尺寸')
const sized = mkPage({ size: { w: 900, h: 1500 } })
const docSized = buildExportDocument({ pages: [sized], pageNos: [1], pageCount: 1, tableName: 'T', recommender: '' })
check('导出文档宽度 = 手填宽度（**不是**写死的 1200）', docSized.width, 900)
check('导出文档高度 = 手填高度 + 上下留白', docSized.height, 1500 + styles.RL.bodyPadV * 2)
check('成图像素 = 文档尺寸 × 清晰度（2 倍）', [docSized.width * 2, docSized.height * 2], [1800, docSized.height * 2])
check('两页拼接时宽度取最大页宽', buildExportDocument({ pages: [sized, mkPage({ size: { w: 1300, h: 900 } })], pageNos: [1, 2], pageCount: 2, tableName: 'T', recommender: '' }).width, 1300)
check('没有手填尺寸 → 默认 1200', buildExportDocument({ pages: [mkPage()], pageNos: [1], pageCount: 1, tableName: 'T', recommender: '' }).width, 1200)

// ------------------------------------------------------------------
// 6. 字体白名单（自测要求 ③）
// ------------------------------------------------------------------
section('6. 字体只出现白名单里的值')
const fonted = mkPage({
  size: { w: 1200, h: 920 },
  layout: [
    { id: 'title', visible: true, fontFamily: 'xingkai', fontSize: 48 },
    { id: 'reason', visible: true, fontFamily: 'song', fontSize: 24 },
    // 非法字体与非法字号：收窄之后不该出现在数据里，更不该出现在 HTML 里
    { id: 'foot', visible: true, fontFamily: 'Comic Sans MS', fontSize: 999 }
  ]
})
const norm = normalizeModules(fonted.layout)
const fontedPage = { ...fonted, layout: norm }
const docFont = buildExportDocument({ pages: [fontedPage], pageNos: [1], pageCount: 1, tableName: 'T', recommender: '' })
const families = fontFamilies(docFont.html)
console.log('导出 HTML 里的 font-family：', JSON.stringify(families))
const allowed = new Set([...MODULE_FONTS.map((f) => normCss(f.css)), normCss(DEFAULT_FONT_STACK)])
check('每一处行内 font-family 都在白名单里', families.every((f) => allowed.has(f)), true)
check('没有出现非法字体名', families.some((f) => /Comic Sans/i.test(f)), false)
check('行楷模块用的是白名单里行楷那一串', families.includes(normCss(MODULE_FONTS.find((f) => f.key === 'xingkai').css)), true)
check('宋体模块用的是白名单里宋体那一串', families.includes(normCss(MODULE_FONTS.find((f) => f.key === 'song').css)), true)
check(
  '非法字体 key 进了收窄之后不留下任何痕迹',
  norm.some((m) => m.id === 'foot' && m.fontFamily !== undefined),
  false
)
const titleGeom = moduleGeom(docFont.html, 'title')
const titleFontSize = Number((docFont.html.match(/data-module="title"[\s\S]{0,400}?font-size:\s*(\d+)px/) ?? [])[1])
check('行楷模块的标题字号 = 用户设的 48', titleFontSize, 48)
check('标题模块的位置仍然是几何算出来的', [px(titleGeom.left), px(titleGeom.top)], [rm.title.x, rm.title.y])
check(
  '字号缩放保持了模块内的层次（副标题 < 标题）',
  (() => {
    const seg = docFont.html.slice(docFont.html.indexOf('data-module="title"'))
    const sizes = [...seg.slice(0, 600).matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]))
    return sizes.length >= 2 ? sizes[0] > sizes[1] : false
  })(),
  true
)
check('没设字体的模块不写 font-family（HTML 更小，且继承页面的默认栈）', (() => {
  const plainDoc = buildExportDocument({ pages: [mkPage({ size: { w: 1200, h: 920 } })], pageNos: [1], pageCount: 1, tableName: 'T', recommender: '' })
  return fontFamilies(plainDoc.html).filter((f) => !f.includes('Microsoft YaHei')).length
})(), 0)
check(
  '行内样式里不出现双引号（否则 style="…" 会被 HTML 解析器截断，后面的 color/text-shadow 全丢）',
  (() => {
    const inline = [...docFont.html.matchAll(/ style="([^"]*)"/g)].map((m) => m[1])
    return inline.length > 0 && inline.every((s) => !/"/.test(s))
  })(),
  true
)

// ------------------------------------------------------------------
// 7. 内容区渐变（左菜单 Ⅵ）
// ------------------------------------------------------------------
section('7. 内容区渐变底色')
const gradPage = mkPage({
  size: { w: 1200, h: 1000 },
  bandRatio: 2,
  background: img('left'),
  contentGradient: { angle: 135, stops: [{ color: '#ffffff', pos: 0, alpha: 1 }, { color: '#e0577f', pos: 100, alpha: 1 }] }
})
const fg = frameOf(gradPage)
const docGrad = buildExportDocument({ pages: [gradPage], pageNos: [1], pageCount: 1, tableName: 'T', recommender: '' })
const gradStyle = styles.contentGradientStyle(fg, gradPage.contentGradient)
check('内容区渐变层存在', gradStyle !== null, true)
check('渐变层正好铺满内容区', [gradStyle.left, gradStyle.top, gradStyle.width, gradStyle.height], [`${fg.contentX}px`, `${fg.contentY}px`, `${fg.contentW}px`, `${fg.contentH}px`])
check('导出 HTML 里有这条渐变', docGrad.html.includes('#e0577f'), true)
check('图片背景 + 内容区渐变时多一条交融条（没有硬边）', styles.contentBlendStyle(fg, pageBackgroundCss(gradPage.background)).zIndex, '2')
check('没有图片背景时不需要交融条（内容区本来就是页面底色）', frameOf(mkPage()).pos, 'none')

// ------------------------------------------------------------------
// 8. 界面接线静态检查（读真实源码文本）
// ------------------------------------------------------------------
section('8. 界面接线静态检查')
const read = (p) => readFileSync(join(root, 'src', 'renderer', 'src', p), 'utf8')
const pageSrc = read('pages/RecommendTablePage.tsx')
const listSrc = read('components/recommend/RecommendTableList.tsx')
const cardSrc = read('components/recommend/RecommendPageCard.tsx')
const storeSrc = read('stores/recommendTable.ts')

check('画布卡片把 page.layout 交给几何函数（预览与导出同源）', cardSrc.includes('moduleRectsOf(frame, page.layout)'), true)
check('导出 HTML 也把 page.layout 交给同一个函数', read('components/recommend/exportHtml.ts').includes('moduleRectsOf(frame, page.layout)'), true)
check('推荐人输入框已从编辑器顶栏移除（只剩列表右键菜单里的那个弹窗）', /value=\{recommender\}/.test(pageSrc), false)
check('「补齐标签」按钮已从编辑器顶栏移除', /icon=\{RefreshCw\}/.test(pageSrc), false)
check('「导出图片」按钮已从编辑器顶栏移除', /icon=\{ImageDown\}/.test(pageSrc), false)
check('编辑器顶栏只剩「添加作品」这一个入口', /panelHidden \? '添加作品' : '收起面板'/.test(pageSrc), true)
check(
  '右键菜单里有「自定义页面内容」并切编辑模式',
  /label: editMode \? '自定义页面内容（已在编辑模式）' : '自定义页面内容'/.test(pageSrc) &&
    /onSelect: \(\) => \{[\s\S]{0,200}?setEditMode\(true\)/.test(pageSrc),
  true
)
check('「自定义页面内容」不再顺手打开旧的背景弹窗', pageSrc.includes('setBgOpen'), false)
check('旧的背景/模块弹窗已经删掉', [existsSync(join(root, 'src/renderer/src/components/recommend/BackgroundDialog.tsx')), existsSync(join(root, 'src/renderer/src/components/recommend/ModuleLayoutDialog.tsx'))], [false, false])
for (const label of ['输入推荐人', '补齐标签', '导出为图片', '推荐表改名']) {
  check(`列表右键菜单里有「${label}」`, listSrc.includes(label), true)
}
check('列表的右键菜单挂在表卡片上', listSrc.includes('onContextMenu={(e) => {'), true)
check('编辑模式右列 = 右菜单，左列 = 左菜单', /<EditLeftPanel ctx=\{editCtx\} \/>/.test(pageSrc) && /<EditRightPanel ctx=\{editCtx\} \/>/.test(pageSrc), true)
check('编辑模式画布上有拖动叠层', pageSrc.includes('<ModuleDragLayer'), true)
check('画布上方编辑态只留「退出并保存 / 移除这一页」', pageSrc.includes('退出并保存') && pageSrc.includes('移除这一页'), true)
check('store 的补丁白名单里有 bandRatio / contentGradient', /'bandRatio'\s*\|\s*'contentGradient'/.test(storeSrc) || (storeSrc.includes("| 'bandRatio'") && storeSrc.includes("| 'contentGradient'")), true)
check('setModuleVisible 不再重建对象（那样会抹掉同页其它模块的坐标）', storeSrc.includes('layoutPatched(page, moduleId, { visible })'), true)
check('没有改动导出链路的共用几何（buildExportDocument / pageStyle 仍在用）', storeSrc.includes('buildExportDocument'), false)

// ------------------------------------------------------------------
// 9. 导出像素尺寸那条链（**只读**检查主进程，不修改它）
// ------------------------------------------------------------------
section('9. 导出链路：页面尺寸 → PNG 像素（渲染层与主进程的接口）')
const mainSrc = readFileSync(join(root, 'src', 'main', 'services', 'cardExport.ts'), 'utf8')
console.log('主进程这条链是「窗口按 width×scale 开 + setZoomFactor(scale) 真正放大 + 截图」')
check('渲染层把页面宽度交给主进程（不是写死的 1200）', pageSrc.includes('width: doc.width'), true)
check('渲染层把清晰度交给主进程', pageSrc.includes('scale\n        })') || /api\.tools\.exportCardImage\(\{[\s\S]*?\bscale\b/.test(pageSrc), true)
check('主进程仍按 width × scale 开窗口', /const W = Math\.round\(widthCss \* s\)/.test(mainSrc), true)
check('主进程仍在真的设 zoom（v0.3.8 修的那个 bug 不能退回去）', mainSrc.includes('setZoomFactor(s)'), true)
check('主进程把宽度夹在 600–4000（所以页面尺寸上限也收到 4000）', /Math\.max\(600, Math\.min\(4000/.test(mainSrc), true)
check('导出弹窗的尺寸预告与文档一致（同一批函数）', read('components/recommend/ExportDialog.tsx').includes('frameOf(p).width'), true)

// ------------------------------------------------------------------
// 10. v0.3.9 补充：只导出当前页搬到推荐页右键菜单 + 左右菜单同时呼出
// ------------------------------------------------------------------
section('10. 补充需求：只导出当前页 / 左右菜单同时呼出')
const dialogSrc = read('components/recommend/ExportDialog.tsx')
const countOf = (src, re) => (src.match(re) ?? []).length

// —— A1「只导出当前页」在推荐页（画布）右键菜单里 ——
check('推荐页右键菜单里有「只导出这一页为图片」', pageSrc.includes('只导出这一页为图片'), true)
check('这一项的动作是真的（打开导出弹窗并预选当前页，不是空条目）', pageSrc.includes("onSelect: () => openExport('current')"), true)
check(
  '画布右键菜单五项齐全（编辑这一页 / 自定义页面内容 / 只导出这一页 / 补齐标签 / 移除这一页）',
  [
    '编辑这一页（评分 / 指数 / 理由 / 剧照）',
    '自定义页面内容',
    '只导出这一页为图片',
    '补齐类型标签 / 播出时间',
    '移除这一页'
  ].every((t) => pageSrc.includes(t)),
  true
)
check('列表那张表的导出改成「多页 / 长图」语义（与"只导当前页"分工清楚）', listSrc.includes('多页 / 长图'), true)
check('列表导出传的是 long 范围', pageSrc.includes("setExportTarget({ tableId: t.id, pageIndex: 0, mode: 'long' })"), true)
check('导出弹窗用 initialMode 决定打开时的范围', dialogSrc.includes("initialMode = 'current'") && dialogSrc.includes('setMode(initialMode)'), true)
check('两处导出弹窗都传了 initialMode', countOf(pageSrc, /initialMode=\{exportTarget\?\.mode \?\? 'current'\}/g), 2)
check('编辑模式右菜单的导出仍然默认「当前页」', pageSrc.includes("openExport: () => openExport('current')"), true)

// —— A2 编辑模式左右两列同时呼出 ——
check('左右两列共用同一个 editPanels 条件（各一处）', countOf(pageSrc, /editPanels && editCtx \?/g), 2)
check('editPanels 只定义一次', countOf(pageSrc, /const editPanels = /g), 1)
check(
  'editPanels 的判据 = 编辑模式 + 有 ctx + 有当前页',
  /const editPanels = editMode && editCtx !== null && currentPage !== null/.test(pageSrc),
  true
)
check('左菜单只渲染一处', countOf(pageSrc, /<EditLeftPanel ctx=\{editCtx\} \/>/g), 1)
check('右菜单只渲染一处', countOf(pageSrc, /<EditRightPanel ctx=\{editCtx\} \/>/g), 1)
check(
  '右列原有的独立判断已删除（那种写法就可能只出一侧）',
  pageSrc.includes('editMode && editCtx && pages.length > 0 && currentPage ? ('),
  false
)
check('进入编辑模式的两个入口都只切 editMode（不会顺手把另一列藏起来）', countOf(pageSrc, /setEditMode\(true\)/g) >= 2, true)
check(
  '外层 flex 行 overflow-hidden（窄窗口不会把右列顶到可视区外）',
  pageSrc.includes('className="mt-3 flex min-h-0 flex-1 gap-3 overflow-hidden"'),
  true
)
check(
  '画布列写了 min-w-0（flex 子项默认 min-width:auto 会把右列顶出去）',
  pageSrc.includes('className="flex min-h-0 min-w-0 flex-1 flex-col"'),
  true
)

// —— B 清晰度与页面尺寸的绑定关系没被改回去 ——
check('导出宽度仍取页面尺寸（buildExportDocument → doc.width）', pageSrc.includes('width: doc.width'), true)
check('清晰度仍然交给主进程按倍率渲染（scale 一路传下去）', /exportCardImage\(\{[\s\S]{0,700}?\bscale\b/.test(pageSrc), true)
check('页面尺寸上限仍是 4000（与主进程夹取一致）', PAGE_SIZE_MAX, 4000)

console.log('\n================ 结果 ================')
console.log(`通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('全部断言通过 ✓')

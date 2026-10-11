/**
 * 「预览的 DOM 几何 == 导出 HTML 的数值」自检（v0.3.9）—— 用**真实组件**渲染出来的 DOM。
 *
 * ## 为什么不用 Electron 里的 DOM 探针
 *
 * 仓库本来有 `SAKANA_DOM_PROBE`（在真实窗口里查 DOM）与 `SAKANA_CARD_EXPORT_PATH`（导出到固定路径），
 * 但在**当前这台机器的沙箱里跑不了**：`electron-vite build` 需要 esbuild 起一个子进程服务，
 * 而这个环境禁止带管道的子进程（`node -e "require('child_process').spawn(x,[],{stdio:['pipe','pipe','pipe']})"`
 * 直接抛 `EPERM`，esbuild 的 `ensureServiceIsRunning` 就是这么起的）。
 * 于是这里换一条**同样真实、但不需要起进程**的路：把渲染层源码用 `tsc` 编成 JS
 * （`tsc` 是纯 JS、不 spawn），再在 Node 里用 `react-dom/server` 把**真正的**
 * `RecommendPageCard` 渲染成 HTML —— 拿到的就是预览那一份 DOM 的等价物。
 *
 * 于是这一条断言是真的跨渲染器比对：
 *   · 左边 = React 组件（`RecommendPageCard` → `styles.moduleBoxStyle`）渲染出来的行内样式；
 *   · 右边 = 导出用的字符串渲染器（`exportHtml.buildExportDocument`）拼出来的 HTML 里的行内样式。
 * 两者只有数值**逐项相等**，"所见即所得"才成立。
 *
 * ## 前置（本脚本不自己跑 tsc：spawn 在这个环境里被禁）
 *
 *   npx tsc -p .e2e/tsconfig.recommend-ssr.json
 *   node scripts/verify-recommend-preview-dom.mjs
 */
import { register } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const compiled = pathToFileURL(join(root, '.e2e', '.compiled')).href

if (!existsSync(join(root, '.e2e', '.compiled', 'renderer', 'src', 'components', 'recommend', 'RecommendPageCard.js'))) {
  console.error('缺少编译产物 .e2e/.compiled —— 先跑：npx tsc -p .e2e/tsconfig.recommend-ssr.json')
  process.exit(2)
}

// 编译产物里保留着源码写的路径别名，所以这里要把它们指到编译目录
const srcPrefix = pathToFileURL(join(root, 'src')).href + '/'
const loaderSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const RULES = [
  [/^@shared\\//, ${JSON.stringify(`${compiled}/shared/`)}],
  [/^@\\//, ${JSON.stringify(`${compiled}/renderer/src/`)}]
]
const EXT = ['.js', '/index.js']
const COMPILED = ${JSON.stringify(compiled + '/')}
const SRC = ${JSON.stringify(srcPrefix)}
export async function resolve(specifier, context, next) {
  for (const [re, base] of RULES) {
    if (!re.test(specifier)) continue
    const rest = specifier.replace(re, '')
    for (const cand of EXT) if (existsSync(fileURLToPath(base + rest + cand))) return next(base + rest + cand, context)
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    for (const cand of EXT) {
      const u = new URL(specifier + cand, context.parentURL)
      if (existsSync(fileURLToPath(u))) return next(u.href, context)
    }
    /*
     * 非 JS 资源（例如 shared/builtinRules.ts 里 import 的 resources/rules/*.json）
     * 编译时不会被复制到 .compiled 下，所以这里把父路径从"编译目录"换回"源码目录"再解析一次。
     * 换不回去就交给 Node 自己报错（不要静默吞掉）。
     */
    const altParent = context.parentURL.startsWith(COMPILED)
      ? SRC + context.parentURL.slice(COMPILED.length)
      : null
    if (altParent) {
      try {
        const u = new URL(specifier, altParent)
        if (existsSync(fileURLToPath(u))) return next(u.href, context)
      } catch {
        /* 交给默认解析 */
      }
    }
  }
  return next(specifier, context)
}
/*
 * 内置播放规则（resources/rules/*.json）与推荐表这个工具毫无关系，而 Node 的 ESM 读 JSON 还要
 * import attributes（tsc 不会给补上）。这里把它换成空对象：既让模块图能加载，
 * 又**不影响**被验证的推荐表代码（那些模块不读规则内容）。
 */
export async function load(url, context, next) {
  if (/\\/resources\\/rules\\/[^/]+\\.json$/.test(url)) {
    return { format: 'module', shortCircuit: true, source: 'export default {}' }
  }
  return next(url, context)
}
`
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`)
await new Promise((resolve) => setImmediate(resolve))

// preload 注入的空壳：@/lib/api 在模块加载时就读 window.sakana
/*
 * ⚠️ 这个 window 必须**够像浏览器**：framer-motion（ui.tsx 的 Button / Switch）在
 * `typeof window !== 'undefined'` 时会去挂事件监听与 ResizeObserver。
 * 只给 `{ sakana: {} }` 的话它会在渲染 `motion.span layout` 时抛
 * `target.addEventListener is not a function`。所以这里补上最小的一套事件接口
 * —— 只影响"能不能渲染"，不影响任何被断言的几何数值。
 */
const noop = () => {}
globalThis.window = {
  sakana: {},
  addEventListener: noop,
  removeEventListener: noop,
  dispatchEvent: () => false,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: noop,
  innerWidth: 1440,
  innerHeight: 900,
  devicePixelRatio: 1,
  getComputedStyle: () => ({ getPropertyValue: () => '', transform: 'none' })
}
globalThis.document = {
  addEventListener: noop,
  removeEventListener: noop,
  documentElement: { addEventListener: noop, removeEventListener: noop, style: {} },
  body: { addEventListener: noop, removeEventListener: noop, style: {} },
  createElement: () => ({ style: {}, addEventListener: noop, removeEventListener: noop, setAttribute: noop }),
  querySelector: () => null,
  querySelectorAll: () => []
}
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const React = (await import('react')).default
const { renderToStaticMarkup } = await import('react-dom/server')
const cardMod = await import(new URL('../.e2e/.compiled/renderer/src/components/recommend/RecommendPageCard.js', import.meta.url).href)
const styles = await import(new URL('../.e2e/.compiled/renderer/src/components/recommend/styles.js', import.meta.url).href)
const exportHtml = await import(new URL('../.e2e/.compiled/renderer/src/components/recommend/exportHtml.js', import.meta.url).href)
const storeMod = await import(new URL('../.e2e/.compiled/renderer/src/stores/recommendTable.js', import.meta.url).href)

const { RecommendPageCard } = cardMod
const { frameOf, moduleRectsOf } = styles
const { buildExportDocument } = exportHtml
const { MODULE_KINDS, renderModules } = storeMod

let passed = 0
const failures = []
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) passed++
  else failures.push(`${name}\n    期望: ${e}\n    实际: ${a}`)
}
function section(title) {
  console.log(`\n=== ${title} ===`)
}

/** `style="a: 1px; b: 2px"` → `{a:'1px', b:'2px'}`；键统一成 camelCase（React 与 cssText 都是 kebab 写法） */
function parseStyle(attr) {
  const out = {}
  for (const part of String(attr).split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const k = part.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    out[k] = part.slice(i + 1).trim().replace(/&quot;/g, "'")
  }
  return out
}

/**
 * 把一段 HTML 里所有标签的属性与行内样式解析出来。
 *
 * 为什么要这么"宽"的解析：React 与 `cssText` 两边的写法不同 ——
 *   · React 渲染成 `style="left:80px;top:60px"`（冒号后**没有空格**，属性顺序按对象键序）；
 *   · `cssText` 拼成 `style="left: 80px; top: 60px"`（冒号后有空格）。
 * 而且 `data-module` 是独立属性、**排在 style 之后**，所以"从 data-module 往后切 600 字"
 * 那种偷懒的取法两边都会取错。这里统一按元素解析，写法差异就不影响断言了。
 */
function elements(html) {
  const out = []
  for (const m of html.matchAll(/<([a-zA-Z]+)([^>]*)>/g)) {
    const attrs = m[2]
    const s = /style="([^"]*)"/.exec(attrs)
    /*
     * ⚠️ 必须先解 HTML 实体再按 `;` 拆声明：React 把字体名里的双引号转义成 `&quot;`，
     * 而 `&quot;` **自带一个分号** —— 先拆的话它会被拆成 `&quot` + `Microsoft YaHei&quot` 两段，
     * 断言就会拿到一堆碎片（这个坑真的踩了一次，写在这里免得以后再踩）。
     */
    out.push({
      tag: m[1],
      attrs,
      style: s ? parseStyle(s[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')) : {}
    })
  }
  return out
}
/** marker = 'module' / 'edit-handle'：取所有带 `data-<marker>="id"` 的元素，按 id 归位 */
function styleOfElement(html, marker) {
  const out = {}
  for (const el of elements(html)) {
    const m = new RegExp(`data-${marker}="([a-z]+)"`).exec(el.attrs)
    if (m) out[m[1]] = el.style
  }
  return out
}
const px = (v) => (typeof v === 'string' && v.endsWith('px') ? Number(v.slice(0, -2)) : NaN)
const geom = (rec) => ({ left: px(rec.left), top: px(rec.top), width: px(rec.width), height: px(rec.height) })

/** 造一页（字段齐全，才画得出所有模块） */
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
    genres: ['日常', '治愈'],
    reason: '第一段理由。\n第二段理由。',
    photos: ['https://a/p1.jpg', 'https://a/p2.jpg'],
    ...extra
  }
}

const img = { kind: 'image', color: '#ffffff', angle: 135, stops: [], path: 'E:\\x.png', imgW: 1600, imgH: 1600, imagePos: 'left', blur: 0, crop: null }

// ------------------------------------------------------------------
// 1. 编辑过的页：预览（React）与导出（HTML）逐项相等
// ------------------------------------------------------------------
section('1. 编辑过的页：预览 DOM 几何 == 导出 HTML 数值')
const edited = mkPage({
  background: img,
  bandRatio: 2,
  size: { w: 1400, h: 1100 },
  layout: [
    { id: 'title', visible: true, x: 80, y: 60, w: 600, h: 120, fontSize: 52, fontFamily: 'xingkai' },
    { id: 'cover', visible: true, x: 1000, y: 140, w: 300, h: 426 },
    { id: 'reason', visible: true, x: 120, y: 420, w: 700, h: 300, fontSize: 24, fontFamily: 'song' },
    { id: 'foot', visible: true, x: 80, y: 1020, w: 1240, h: 40 }
  ],
  contentGradient: { angle: 135, stops: [{ color: '#ffffff', pos: 0, alpha: 1 }, { color: '#e3ecf8', pos: 100, alpha: 1 }] }
})

const previewHtml = renderToStaticMarkup(
  React.createElement(RecommendPageCard, {
    page: edited,
    pageNo: 1,
    pageCount: 2,
    tableName: '自检表',
    recommender: '自检'
  })
)
const doc = buildExportDocument({
  pages: [edited],
  pageNos: [1],
  pageCount: 2,
  tableName: '自检表',
  recommender: '自检'
})

const previewModules = styleOfElement(previewHtml, 'module')
const exportModules = styleOfElement(doc.html, 'module')
const rects = moduleRectsOf(frameOf(edited), edited.layout)
const drawn = renderModules(edited).map((m) => m.id)

console.log('预览里画出来的模块：', Object.keys(previewModules).join('、'))
console.log('导出里画出来的模块：', Object.keys(exportModules).join('、'))
check('两边画出来的模块集合一致', Object.keys(previewModules).sort(), Object.keys(exportModules).sort())
check('两边画出来的模块 = 页面没隐藏的那些', Object.keys(previewModules).sort(), [...drawn].sort())

for (const id of MODULE_KINDS) {
  if (!drawn.includes(id)) continue
  const p = geom(previewModules[id])
  const e = geom(exportModules[id])
  const r = rects[id]
  check(`${id}：预览 == 导出`, p, e)
  check(`${id}：两边都等于几何函数算出来的矩形`, [p, e], [
    { left: r.x, top: r.y, width: r.w, height: r.h },
    { left: r.x, top: r.y, width: r.w, height: r.h }
  ])
}

// 页面本身与图区也要一致（页面尺寸 = 导出窗口尺寸的前提）
const pageElOf = (html) => elements(html).find((e) => e.style.boxSizing === 'border-box' && e.style.borderRadius)?.style ?? {}
const previewPageStyle = pageElOf(previewHtml)
const exportPageStyle = pageElOf(doc.html)
console.log('预览页面根 style：', JSON.stringify(previewPageStyle).slice(0, 320))
check('预览的页面宽 == 导出 section 的宽 == 手填的 1400', [
  previewPageStyle.width,
  exportPageStyle.width
], ['1400px', '1400px'])
check('预览的页面高 == 导出 section 的高 == 手填的 1100', [
  previewPageStyle.height,
  exportPageStyle.height
], ['1100px', '1100px'])
check('两边的文字描边都在（可读性靠它，丢了导出图上的字就糊了）', [
  typeof previewPageStyle.textShadow === 'string',
  typeof exportPageStyle.textShadow === 'string'
], [true, true])
check('两边的字体栈都在', [
  /Microsoft YaHei/.test(previewPageStyle.fontFamily || ''),
  /Microsoft YaHei/.test(exportPageStyle.fontFamily || '')
], [true, true])
check('两边写的是同一个字体栈（预览用双引号、导出换单引号，渲染结果一样）', [
  String(previewPageStyle.fontFamily || '').replace(/"/g, "'"),
  String(exportPageStyle.fontFamily || '')
], [
  String(previewPageStyle.fontFamily || '').replace(/"/g, "'"),
  String(previewPageStyle.fontFamily || '').replace(/"/g, "'")
])
check('导出侧确实把双引号换成了单引号（否则 style="…" 会被 HTML 截断）', /'Microsoft YaHei'/.test(exportPageStyle.fontFamily || ''), true)

// 模块字体/字号：两边必须一样。取那个模块元素自己的完整标签（style 在前面，别从 data-module 往后切）
const moduleFont = (html, id) => {
  const el = elements(html).find((e) => e.attrs.includes(`data-module="${id}"`))
  if (!el) return null
  const seg = html.slice(html.indexOf(`data-module="${id}"`)).slice(0, 900)
  return {
    family: el.style.fontFamily ?? null,
    sizes: [...seg.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => m[1])
  }
}
const pt = moduleFont(previewHtml, 'title')
const et = moduleFont(doc.html, 'title')
// 引号写法不同（React 直接写双引号；导出侧为了让 style="…" 不被截断换成单引号）——渲染结果一样，比较前归一
const q = (s) => String(s).replace(/"/g, "'")
const XINGKAI = "'STXingkai', 'KaiTi', 'STKaiti', cursive"
check('标题模块的字体两边一致（行楷）', [q(pt.family), q(et.family)], [XINGKAI, XINGKAI])
check('标题模块的字号两边一致', pt.sizes[0], et.sizes[0])
check('标题字号确实是 52（不是版式默认的 34）', pt.sizes[0], '52')
const pt2 = moduleFont(previewHtml, 'reason')
const et2 = moduleFont(doc.html, 'reason')
const SONGTI = "'SimSun', 'Songti SC', 'STSong', serif"
check('理由模块的字体两边一致（宋体）', [q(pt2.family), q(et2.family)], [SONGTI, SONGTI])

// 内容区渐变：两边都要有，且铺满内容区
const f = frameOf(edited)
/** 渐变层：铺在内容区上、方向 135deg 的那一块（色标 alpha=1 时 gradientCss 用十六进制） */
const gradOf = (html) =>
  elements(html).find(
    (e) => /linear-gradient\(135deg/.test(e.style.background || '') && px(e.style.width) === f.contentW
  )?.style ?? null
const gradPreview = gradOf(previewHtml)
const gradExport = gradOf(doc.html)
check('预览里有内容区渐变，且正好铺满内容区', [
  gradPreview !== null,
  px(gradPreview?.left),
  px(gradPreview?.top),
  px(gradPreview?.height)
], [true, f.contentX, f.contentY, f.contentH])
check('导出里有同一条渐变（同样的位置与尺寸）', [
  gradExport !== null,
  px(gradExport?.left),
  px(gradExport?.top),
  px(gradExport?.height)
], [true, f.contentX, f.contentY, f.contentH])
check('渐变色标是白 → 雾蓝', /#ffffff 0%/.test(gradPreview?.background || ''), true)

// 图区（图片位置 / 占比真的生效）
const bandOf = (html) => elements(html).find((e) => e.style.overflow === 'hidden' && e.style.zIndex === '0')?.style ?? null
const bandPreview = bandOf(previewHtml)
const bandExport = bandOf(doc.html)
const wantBandW = Math.round(1400 * (2 / 3))
check('预览里图区是左侧那条（bandRatio=2 → 宽 = 1400 × 2/3、高 = 页面高）', [
  px(bandPreview?.width),
  px(bandPreview?.height),
  px(bandPreview?.left)
], [wantBandW, 1100, 0])
check('导出里的图区完全一致', [px(bandExport?.width), px(bandExport?.height), px(bandExport?.left)], [
  wantBandW,
  1100,
  0
])
check('导出文档宽度 == 手填页面宽度', doc.width, 1400)

// ------------------------------------------------------------------
// 2. 没动过的页：两边的数值仍是那套默认版式（老数据外观不变）
// ------------------------------------------------------------------
section('2. 没编辑过的页：默认版式两边一致')
const plain = mkPage({ size: { w: 1200, h: 920 } })
const previewPlain = renderToStaticMarkup(
  React.createElement(RecommendPageCard, { page: plain, pageNo: 1, pageCount: 1, tableName: 'T', recommender: '' })
)
const docPlain = buildExportDocument({ pages: [plain], pageNos: [1], pageCount: 1, tableName: 'T', recommender: '' })
const pPlain = styleOfElement(previewPlain, 'module')
const ePlain = styleOfElement(docPlain.html, 'module')
check('默认版式：reason 的位置与老版式一致（x360 y436 804×274）', [geom(pPlain.reason), geom(ePlain.reason)], [
  { left: 360, top: 436, width: 804, height: 274 },
  { left: 360, top: 436, width: 804, height: 274 }
])
check('默认版式：标题字号仍是 34（没有被"模块字号"改动过）', [
  (/data-module="title"[\s\S]{0,600}?font-size:\s*([0-9.]+)px/.exec(previewPlain) ?? [])[1],
  (/data-module="title"[\s\S]{0,600}?font-size:\s*([0-9.]+)px/.exec(docPlain.html) ?? [])[1]
], ['34', '34'])
check('默认版式：不写 font-family（继承页面的默认栈）', [
  /data-module="title"[\s\S]{0,600}?font-family/.test(previewPlain),
  /data-module="title"[\s\S]{0,600}?font-family/.test(docPlain.html)
], [false, false])
check('没有内容区渐变时不画那一层', /linear-gradient\(13/.test(previewPlain), false)

// ------------------------------------------------------------------
// 3. 隐藏的模块两边都不画
// ------------------------------------------------------------------
section('3. 隐藏模块两边都不画')
const hidden = mkPage({
  size: { w: 1200, h: 920 },
  layout: [
    { id: 'title', visible: true, x: 10, y: 10, w: 500, h: 90 },
    { id: 'photos', visible: false }
  ]
})
const previewHidden = renderToStaticMarkup(
  React.createElement(RecommendPageCard, { page: hidden, pageNo: 1, pageCount: 1, tableName: 'T', recommender: '' })
)
const docHidden = buildExportDocument({ pages: [hidden], pageNos: [1], pageCount: 1, tableName: 'T', recommender: '' })
check('预览里没有 photos', /data-module="photos"/.test(previewHidden), false)
check('导出里没有 photos', /data-module="photos"/.test(docHidden.html), false)
check('两边都还画着 title（且用自定义坐标 10,10 500×90）', [
  geom(styleOfElement(previewHidden, 'module').title),
  geom(styleOfElement(docHidden.html, 'module').title)
], [
  { left: 10, top: 10, width: 500, height: 90 },
  { left: 10, top: 10, width: 500, height: 90 }
])
check('隐藏的模块不会被预取图片（否则导出会报"封面/剧照没取到"）', docHidden.images.filter((i) => i.key.startsWith('ph')).length, 0)

// ------------------------------------------------------------------
// 4. 编辑模式的两列菜单：真的渲染得出来（v0.3.9 补充：左右同时呼出）
// ------------------------------------------------------------------
section('4. 编辑模式左右菜单同时呼出（真实组件渲染）')
const panelMod = await import(new URL('../.e2e/.compiled/renderer/src/components/recommend/EditLeftPanel.js', import.meta.url).href)
const panelRight = await import(new URL('../.e2e/.compiled/renderer/src/components/recommend/EditRightPanel.js', import.meta.url).href)

/*
 * 造一个**真实的 EditCtx**（字段与 RecommendTablePage 里构造的那份一一对应）。
 * 这里刻意不复用页面组件：页面用 useState 管 editMode，SSR 没法点按钮；
 * 但"两列同时在不在"由页面里那个共用的 `editPanels` 决定（静态断言见
 * scripts/verify-recommend-edit.mjs 的第 8 节），而"两列各自能不能画出菜单"由这里证明。
 */
const panelPage = mkPage({
  background: img,
  bandRatio: 2,
  size: { w: 1200, h: 920 },
  layout: [{ id: 'reason', visible: true, x: 40, y: 40, w: 700, h: 300, fontSize: 22, fontFamily: 'song' }],
  contentGradient: { angle: 135, stops: [{ color: '#ffffff', pos: 0, alpha: 1 }, { color: '#e3ecf8', pos: 100, alpha: 1 }] }
})
const panelFrame = frameOf(panelPage)
const panelCtx = {
  table: { id: 't1', name: '自检表', pages: [panelPage], createdAt: 0 },
  page: panelPage,
  frame: panelFrame,
  rects: moduleRectsOf(panelFrame, panelPage.layout),
  selected: 'reason',
  setSelected: () => {},
  patch: () => {},
  patchAll: () => {},
  setModuleVisible: () => {},
  setModuleRect: () => {},
  setModuleFont: () => {},
  resetRects: () => {},
  resetModules: () => {},
  openExport: () => {},
  exporting: false
}
const leftHtml = renderToStaticMarkup(React.createElement(panelMod.EditLeftPanel, { ctx: panelCtx }))
const rightHtml = renderToStaticMarkup(React.createElement(panelRight.EditRightPanel, { ctx: panelCtx }))
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

const LEFT_ITEMS = [
  'Ⅰ 版面图片',
  'Ⅱ 展示哪些模块',
  'Ⅲ 模块大小',
  'Ⅳ 图区与内容区的占比',
  'Ⅴ 版面图片的展示区域',
  'Ⅵ 内容区渐变背景',
  'Ⅶ 模块排版位置'
]
const RIGHT_ITEMS = ['Ⅰ 推荐页面大小', 'Ⅱ 导出为图片', 'Ⅲ 模块字体与字号']
for (const t of LEFT_ITEMS) check(`左菜单渲染出「${t}」`, text(leftHtml).includes(t), true)
for (const t of RIGHT_ITEMS) check(`右菜单渲染出「${t}」`, text(rightHtml).includes(t), true)
check('左菜单 Ⅰ 是展开的（能看到四个方向的按钮与换图入口，不是空壳）', [
  text(leftHtml).includes('换一张'),
  ['上方', '下方', '左侧', '右侧'].every((t) => text(leftHtml).includes(t))
], [true, true])
check('右菜单 Ⅱ 里的导出按钮真的在（点了会打开导出弹窗）', /导出为图片/.test(text(rightHtml)), true)
check('两块面板都有实际内容（不是「暂不支持」占位）', [leftHtml.length > 1500, rightHtml.length > 1200], [true, true])
check('有版面图片时 Ⅳ 的滑杆是可用的（不是"暂不生效"占位）', text(leftHtml).includes('暂不生效'), false)
check('没选中模块时 Ⅲ 给出的是说明而不是假控件', (() => {
  const html = renderToStaticMarkup(
    React.createElement(panelRight.EditRightPanel, { ctx: { ...panelCtx, selected: null } })
  )
  return text(html).includes('还没有选中模块') && !/type="range"/.test(html)
})(), true)

console.log('\n================ 结果 ================')
console.log(`通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f2 of failures) console.log(`  ✗ ${f2}`)
  process.exit(1)
}
console.log('预览（React 真实组件）与导出（HTML 字符串）的几何数值逐项一致 ✓')

/**
 * 自建历史表自检（纯逻辑 + 界面接线静态检查）。
 *
 * 直接 import **真实源码** src/renderer/src/stores/customHistory.ts（Node 24 自带 TS 类型擦除，
 * 不需要先编译），所以下面的输入→输出就是产品代码的真实行为，不是测试里的副本；
 * 季节口径也从真实源码 src/shared/season.ts 取 `SEASON_NAMES` / `seasonIndexOfMonth` 对照，
 * 年份口径与渲染层真实源码 src/renderer/src/lib/format.ts 的 `yearOf` 对照。
 *
 * 这个文件比别的 verify 脚本多了一层准备，因为它是**渲染层**的模块：
 *   ① TS 源码里写的是 `@shared/season` / `@/lib/api` 这类路径别名（平时由打包器解析），
 *      Node 不认 —— 所以先注册一个解析钩子把它们映射回真实文件；
 *   ② `@/lib/api` 在模块加载时就读 `window.sakana`（页面里由 preload 注入），
 *      Node 里没有 window —— 所以给一个空壳，本脚本只跑纯函数、不会真的发 IPC。
 *
 * 用法（项目根目录）：
 *   node scripts/verify-custom-history.mjs
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
const loaderSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const RULES = [
  [/^@shared\\//, ${JSON.stringify(`${srcUrl}/shared/`)}],
  [/^@\\//, ${JSON.stringify(`${srcUrl}/renderer/src/`)}]
]
export async function resolve(specifier, context, next) {
  for (const [re, base] of RULES) {
    if (!re.test(specifier)) continue
    const rest = specifier.replace(re, '')
    for (const cand of [rest + '.ts', rest + '.tsx', rest + '/index.ts', rest + '/index.tsx']) {
      if (existsSync(fileURLToPath(base + cand))) return next(base + cand, context)
    }
  }
  return next(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`)
// register() 的注册是异步生效的，等一轮事件循环再 import，保证下面走的就是这套规则
await new Promise((resolve) => setImmediate(resolve))

// ---- ② preload 注入的空壳（只为了让 @/lib/api 能加载；本脚本不调用任何接口） ----
globalThis.window = { sakana: {} }

const store = await import(new URL('../src/renderer/src/stores/customHistory.ts', import.meta.url).href)
const {
  CUSTOM_HISTORY_KEY,
  SIMPLE_LIMIT,
  DETAIL_LIMIT,
  MAX_PER_YEAR,
  MIN_YEAR,
  HISTORY_MODE_NAMES,
  modeLimit,
  airYearOf,
  yearCheck,
  mismatchMessage,
  missingYearMessage,
  selectableYears,
  seasonTextOf,
  coverFields,
  normalizeHistoryItem,
  normalizeHistory,
  itemsOfYear,
  groupByYear,
  visibleItems,
  canAdd
} = store

// 真实源码里的季节约定与年份判据（页面用的就是它们，用来核对本模块没有另写一套）
const { SEASON_NAMES, seasonIndexOfMonth, monthsOfSeason } = await import(
  new URL('../src/shared/season.ts', import.meta.url).href
)
const { yearOf } = await import(new URL('../src/renderer/src/lib/format.ts', import.meta.url).href)

let passed = 0
const failures = []
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
  } else {
    failures.push(`${name}\n    期望: ${e}\n    实际: ${a}`)
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`)
}

/** 造一条自建历史表条目（只给纯函数需要的字段） */
function mk(subjectId, year, airDate = `${year}-04-03`, addedAt = subjectId, extra = {}) {
  const name = `番剧${subjectId}`
  return {
    subjectId,
    name,
    nameCn: name,
    cover: `https://lain.bgm.tv/pic/cover/c/${subjectId}.jpg`,
    covers: [`https://lain.bgm.tv/pic/cover/l/${subjectId}.jpg`],
    airDate,
    rating: null,
    year,
    addedAt,
    ...extra
  }
}

// ------------------------------------------------------------------
// 0. 模块与常量
// ------------------------------------------------------------------
section('0. 模块加载与上限常量')
console.log('导出的纯函数：', Object.keys(store).sort().join('、'))
check('关键纯函数都在', ['airYearOf', 'groupByYear', 'canAdd', 'yearCheck', 'coverFields', 'visibleItems'].every((k) => typeof store[k] === 'function'), true)
check('上限：简易 4 / 清晰 10', [SIMPLE_LIMIT, DETAIL_LIMIT], [4, 10])
// ★ 核心取舍：存 10 部（取两种版式的较大者），简易显示只画前 4 部
check('存储上限 = 两种版式的较大者', MAX_PER_YEAR, Math.max(SIMPLE_LIMIT, DETAIL_LIMIT))
check('版式对应的上限', [modeLimit('simple'), modeLimit('detail')], [4, 10])
check('版式名', [HISTORY_MODE_NAMES.simple, HISTORY_MODE_NAMES.detail], ['简易显示', '清晰显示'])
check('持久化键用的是 sakana- 前缀', CUSTOM_HISTORY_KEY.startsWith('sakana-'), true)
check('年份下界 2005（与项目其它年份选择器一致）', MIN_YEAR, 2005)
check('能读到渲染层的 yearOf（年份口径对照用）', typeof yearOf === 'function', true)

// ------------------------------------------------------------------
// 1. 年份选择范围
// ------------------------------------------------------------------
section('1. 年份选择范围（2005 → 今年）')
const years2026 = selectableYears(new Date(2026, 7, 7))
console.log(`2026 年时的年份选项：共 ${years2026.length} 项，${years2026.slice(0, 3).join('、')} … ${years2026.at(-1)}`)
check('第一项是今年', years2026[0], 2026)
check('最后一项是 2005', years2026.at(-1), MIN_YEAR)
check('项数 = 今年 - 2005 + 1', years2026.length, 2026 - 2005 + 1)
check('倒序排列（新→旧）', years2026.every((y, i) => i === 0 || years2026[i - 1] - y === 1), true)
check('换一年也对（2020）', [selectableYears(new Date(2020, 0, 1))[0], selectableYears(new Date(2020, 0, 1)).at(-1)], [2020, 2005])
// 系统年份早于 2005（不可能，但公式不能因此产生空列表或负数项）
check('年份早于 2005 时至少给出 [2005]', selectableYears(new Date(1999, 0, 1)), [2005])

// ------------------------------------------------------------------
// 2. 放送年份判定（搜索添加的「年份不对就提示」全靠它）
// ------------------------------------------------------------------
section('2. 放送年份判定 airYearOf / yearCheck')
const YEAR_CASES = [
  ['2021-04-03', 2021],
  ['2019-07-05', 2019],
  ['2005-01-01', 2005],
  ['2026-12-31', 2026],
  ['2021', 2021], // 只有年份：当作该年（Bangumi 偶有这种值）
  ['2021-13-01', 2021] // 月份脏但年份可信：与 yearOf 同判据
]
for (const [raw, want] of YEAR_CASES) {
  check(`airYearOf(${JSON.stringify(raw)})`, airYearOf(raw), want)
  // 与全站年份口径（yearOf）逐条对照：正常日期两边必须一致，不能各算一套
  check(`airYearOf 与 yearOf 一致（${raw}）`, airYearOf(raw), yearOf(raw))
}
check('首尾空格被容忍（这一步 yearOf 会算错：它直接切前 4 位）', [airYearOf('  2021-04-03'), yearOf('  2021-04-03')], [2021, 20])
const DIRTY = [null, undefined, '', '   ', 'abcd-ef-gh', '07-05', '999-07-01', '0000-07-01', '1899-12-31', '2101-01-01', 0, 123, NaN, true, {}, [], { air_date: '2021-04-03' }]
for (const raw of DIRTY) check(`脏值 ${JSON.stringify(raw) ?? String(raw)} → 取不到年份`, airYearOf(raw), null)
check('yearOf 会把 999-07-01 读成 999，本模块刻意不认（差别写在这里）', [yearOf('999-07-01'), airYearOf('999-07-01')], [999, null])

check('同一年的放送日期 → match', yearCheck('2021-04-03', 2021), { kind: 'match', airYear: 2021 })
check('不同年 → mismatch（带上它自己的年份）', yearCheck('2019-07-05', 2021), { kind: 'mismatch', airYear: 2019 })
check('缺放送日期 → missing（不是 mismatch）', yearCheck(null, 2021), { kind: 'missing', airYear: null })
check('脏放送日期 → missing', yearCheck('abcd-ef-gh', 2021), { kind: 'missing', airYear: null })
check('年份可信、月份脏 → 仍按该年核对（与收藏页的年份口径一致）', yearCheck('2021-13', 2021), { kind: 'match', airYear: 2021 })
check('目标年份是小数也按整数比', yearCheck('2021-04-03', 2021.9), { kind: 'match', airYear: 2021 })
check(
  '不一致时的提示文案（用户原话的格式）',
  mismatchMessage('进击的巨人', 2019, 2021),
  '《进击的巨人》是 2019 年的番剧，当前选中的是 2021 年'
)
check('没有放送日期时的提示', missingYearMessage('某番'), '《某番》没有放送日期，无法核对年份')

// ------------------------------------------------------------------
// 3. 季节文案（必须来自 @shared/season，不能自己写死月份区间）
// ------------------------------------------------------------------
section('3. 季节文案 seasonTextOf（与 @shared/season 对照）')
console.log(`季节约定：1–3 月 = ${SEASON_NAMES[0]}、4–6 月 = ${SEASON_NAMES[1]}、7–9 月 = ${SEASON_NAMES[2]}、10–12 月 = ${SEASON_NAMES[3]}`)
for (let m = 1; m <= 12; m += 1) {
  const raw = `2021-${String(m).padStart(2, '0')}-01`
  const want = `2021 年${SEASON_NAMES[seasonIndexOfMonth(m) - 1]}`
  check(`${m} 月的季节文案`, seasonTextOf(raw), want)
}
check('跨月边界：3/4 月分属冬与春', [seasonTextOf('2021-03-31'), seasonTextOf('2021-04-01')], ['2021 年冬', '2021 年春'])
check('跨月边界：6/7 月分属春与夏', [seasonTextOf('2021-06-30'), seasonTextOf('2021-07-01')], ['2021 年春', '2021 年夏'])
check('跨月边界：9/10 月分属夏与秋', [seasonTextOf('2021-09-30'), seasonTextOf('2021-10-01')], ['2021 年夏', '2021 年秋'])
check('只有年份 → 没有季节文案', seasonTextOf('2021'), '')
check('缺放送日期 → 没有季节文案', seasonTextOf(null), '')
check('脏放送日期 → 没有季节文案', [seasonTextOf('2021-13-01'), seasonTextOf('abcd'), seasonTextOf(123)], ['', '', ''])
// 界面上选季度取数用的月份：必须落在该季度的三个月内（主进程按季度规范化并缓存）
for (let s = 1; s <= 4; s += 1) {
  const month = monthsOfSeason(s)[0]
  check(`第 ${s} 季（${SEASON_NAMES[s - 1]}）取数用的月份落在本季度内`, seasonIndexOfMonth(month), s)
}

// ------------------------------------------------------------------
// 4. 上限校验（添加时就拦住，不静默丢弃）
// ------------------------------------------------------------------
section('4. 上限与重复校验 canAdd')
const empty = []
check('空年份加第一条 → 允许，且画得进简易显示', canAdd(empty, 2021, 1), { ok: true, year: 2021, count: 1, simpleVisible: true })

const three = [1, 2, 3].map((id) => mk(id, 2021))
// count 的含义是「加进去之后这一年有几部」，也就是界面提示里那个数
check('第 4 条：允许，而且画得进简易显示', canAdd(three, 2021, 4), { ok: true, year: 2021, count: 4, simpleVisible: true })
const four = [1, 2, 3, 4].map((id) => mk(id, 2021))
check('第 5 条：允许，但简易显示已经画不出来了（simpleVisible=false）', canAdd(four, 2021, 5), {
  ok: true,
  year: 2021,
  count: 5,
  simpleVisible: false
})

const ten = Array.from({ length: 10 }, (_, i) => mk(i + 1, 2021))
const fullResult = canAdd(ten, 2021, 99)
check('第 11 条：拒绝', fullResult.ok, false)
check('拒绝原因 = 上限', fullResult.kind, 'limit')
check('上限提示里写清是 10 部与怎么解决', fullResult.message.includes('10') && fullResult.message.includes('清晰显示'), true)
console.log('上限提示：', fullResult.message)

const dup = canAdd(four, 2021, 3)
check('同一年里的同一部番 → 拒绝（重复）', [dup.ok, dup.kind], [false, 'duplicate'])
check('重复提示里带上年份', dup.message.includes('2021'), true)
console.log('重复提示：', dup.message)
check('同 id 换一年不算重复', canAdd(four, 2022, 3).ok, true)
// 上限只按「该年份」算，别的年份满不满互不影响
check('2021 满不影响 2022', [canAdd(ten, 2021, 50).ok, canAdd(ten, 2022, 50).ok], [false, true])
check('年份传小数也按整数算', canAdd(four, 2021.9, 42).ok, true)
check('重复/上限判定都不会改原数组', [four.length, ten.length], [4, 10])

// ------------------------------------------------------------------
// 5. 分组与展示条数
// ------------------------------------------------------------------
section('5. 分组 groupByYear / itemsOfYear / visibleItems')
const mixed = [
  mk(1, 2021, '2021-04-03', 30),
  mk(2, 2019, '2019-07-05', 20),
  mk(3, 2021, '2021-04-10', 10), // addedAt 更早 → 排在 1 前面
  mk(4, 2005, '2005-01-01', 40),
  mk(5, 2021, '2021-10-01', 50)
]
const grouped = groupByYear(mixed)
console.log('分组：', grouped.map((g) => `${g.year} 年 ×${g.items.length}`).join('，'))
check('年份升序（早 → 晚，这是一条明确取舍）', grouped.map((g) => g.year), [2005, 2019, 2021])
check('只保留有内容的年份（不画 2005–今年的空年份）', grouped.length, 3)
check('组内按加入时间升序', grouped.find((g) => g.year === 2021).items.map((it) => it.subjectId), [3, 1, 5])
check('组内条目数之和 = 输入条数（不丢条目）', grouped.reduce((s, g) => s + g.items.length, 0), mixed.length)
check('空输入不崩', [groupByYear([]), itemsOfYear([], 2021)], [[], []])
check('itemsOfYear 同样按加入顺序且不修改原数组', [itemsOfYear(mixed, 2021).map((it) => it.subjectId), mixed.length], [[3, 1, 5], 5])

const yearWith6 = [1, 2, 3, 4, 5, 6].map((id) => mk(id, 2021))
check('简易显示只画前 4 部', visibleItems(yearWith6, 'simple').map((it) => it.subjectId), [1, 2, 3, 4])
check('清晰显示画到 10 部', visibleItems(yearWith6, 'detail').map((it) => it.subjectId), [1, 2, 3, 4, 5, 6])
const yearWith12 = Array.from({ length: 12 }, (_, i) => mk(i + 1, 2021))
check('即使磁盘上超过 10 部，清晰显示也只画 10 部', visibleItems(yearWith12, 'detail').length, DETAIL_LIMIT)
check('visibleItems 不改原数组', yearWith6.length, 6)

// ------------------------------------------------------------------
// 6. 磁盘数据收窄
// ------------------------------------------------------------------
section('6. 磁盘数据收窄 normalizeHistory')
check('非数组 → 空', [normalizeHistory(null), normalizeHistory({}), normalizeHistory('x'), normalizeHistory(undefined)], [[], [], [], []])
const dirty = [
  null,
  undefined,
  'x',
  42,
  {},
  { subjectId: 0, year: 2021, name: '零号' },
  { subjectId: -3, year: 2021, name: '负数' },
  { subjectId: 7, year: 1999, name: '太早' },
  { subjectId: 8, year: 3000, name: '太晚' },
  { subjectId: 9, year: '2021', name: '年份是字符串' },
  { subjectId: 10, year: 2021, name: '', nameCn: '' },
  mk(11, 2021)
]
const kept = normalizeHistory(dirty)
check('脏数据全部丢掉，只留合法的那条', kept.map((it) => it.subjectId), [11])
const weird = normalizeHistory([
  {
    subjectId: 21.7,
    year: 2020.9,
    name: '原名',
    nameCn: '',
    cover: 'https://a/c.jpg',
    airDate: '',
    rating: '9.1',
    addedAt: 'x'
  }
])
check('subjectId / year 截成整数', [weird[0].subjectId, weird[0].year], [21, 2020])
check('空放送日期 → null', weird[0].airDate, null)
check('非数字评分 → null', weird[0].rating, null)
check('缺 addedAt → 0（顺序仍然稳定）', weird[0].addedAt, 0)
check('缺 covers → 退化成 [cover]（导出至少还有一张能画）', weird[0].covers, ['https://a/c.jpg'])
check('完全没有封面也不崩', normalizeHistoryItem({ subjectId: 1, year: 2021, name: 'x' }).covers, [])
check('非法条目返回 null', normalizeHistoryItem({ subjectId: 1, year: 2021 }), null)

const dupes = normalizeHistory([mk(1, 2021), mk(1, 2021), mk(1, 2022)])
check('同一年里的同一部只留一条，不同年份各算一条', dupes.map((it) => `${it.year}:${it.subjectId}`), ['2021:1', '2022:1'])
const over = normalizeHistory(Array.from({ length: 14 }, (_, i) => mk(i + 1, 2021)))
check('读盘时把超限的年份截到 10 部', over.length, MAX_PER_YEAR)
check('截断保留的是最先加入的那些', over.map((it) => it.subjectId), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

// ------------------------------------------------------------------
// 7. 封面档位
// ------------------------------------------------------------------
section('7. 封面档位 coverFields')
const all = {
  common: 'https://a/common.jpg',
  large: 'https://a/large.jpg',
  medium: 'https://a/medium.jpg',
  small: 'https://a/small.jpg',
  grid: 'https://a/grid.jpg'
}
const cf = coverFields(all)
console.log('界面用：', cf.cover, '｜ 导出候选链：', cf.covers.join(' → '))
check('界面用 common（小、快）', cf.cover, all.common)
check('导出候选链 large 优先（要清晰）', cf.covers[0], all.large)
check('候选链里含界面用的那一档（取不到时能降级）', cf.covers.includes(cf.cover), true)
check('候选链逐档降级且不重复', [new Set(cf.covers).size, cf.covers.length], [5, 5])
check('只有 small 一档时两边都用它', coverFields({ small: all.small, common: '', large: '', medium: '', grid: '' }), {
  cover: all.small,
  covers: [all.small]
})
check('没有 images → 空', [coverFields(null), coverFields(undefined)], [
  { cover: '', covers: [] },
  { cover: '', covers: [] }
])
check('空串档位被跳过', coverFields({ common: '', large: all.large, medium: '', small: '', grid: '' }).cover, all.large)
check('多档位同 URL 会去重', coverFields({ common: 'https://a/x.jpg', large: 'https://a/x.jpg', medium: '', small: '', grid: '' }).covers, ['https://a/x.jpg'])

// ------------------------------------------------------------------
// 8. 真实数据（如果这台机器上已经存过自建历史表）
// ------------------------------------------------------------------
section('8. 真实磁盘数据（没有就跳过）')
const realPath = join(root, 'data', 'userData', 'data', `${CUSTOM_HISTORY_KEY}.json`)
if (existsSync(realPath)) {
  const raw = JSON.parse(readFileSync(realPath, 'utf8'))
  const items = normalizeHistory(raw)
  const g = groupByYear(items)
  console.log(`读取真实自建历史表：${items.length} 条（${realPath}）`)
  console.log('分组：', g.map((x) => `${x.year} 年 ×${x.items.length}`).join('，') || '（空）')
  check('真实数据每条都归进了某个年份', g.reduce((s, x) => s + x.items.length, 0), items.length)
  check('真实数据没有年份超过存储上限', g.every((x) => x.items.length <= MAX_PER_YEAR), true)
  // ⚠️ 真实数据会变，所以只断言**不随数据变化的性质**（不写死具体年份/条数）
  check('真实数据里没有重复条目', new Set(items.map((it) => `${it.year}:${it.subjectId}`)).size, items.length)
  check('真实数据年份都在可选范围内', items.every((it) => it.year >= MIN_YEAR), true)
} else {
  console.log(`还没有存过自建历史表（${realPath} 不存在），跳过这一节`)
}

// ------------------------------------------------------------------
// 9. 界面接线静态检查（读真实源码文本）
// ------------------------------------------------------------------
section('9. 界面接线静态检查')
const pageSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'pages', 'CustomHistoryPage.tsx'), 'utf8')
const storeSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'stores', 'customHistory.ts'), 'utf8')
const appSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
const toolsSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'pages', 'ToolsPage.tsx'), 'utf8')

check('页面里加了路由', appSrc.includes('<Route path="/tools/custom-history"'), true)
check('小窗口标题映射里有一份', appSrc.includes("'/tools/custom-history': '自建历史表'"), true)
check('工具页卡片用内置样式并列在统计/9宫格之后', toolsSrc.includes('BUILTIN_CUSTOM_HISTORY_TOOL'), true)
check('卡片点开的是小窗口 + 指定尺寸', toolsSrc.includes('openSmall(BUILTIN_CUSTOM_HISTORY_TOOL.hash') && toolsSrc.includes('width: 1320'), true)
check('卡片名与标题一致', toolsSrc.includes("name: '自建历史表'"), true)

check('两种版式都在（界面切换 + 导出选择各一处）', (pageSrc.match(/\['simple', 'detail'\] as HistoryMode\[\]/g) ?? []).length >= 2, true)
check('导出清晰度档位是 2 倍 / 3 倍', pageSrc.includes('EXPORT_SCALES = [2, 3]'), true)
check('导出用 canvas 手工绘制（不是截屏 DOM）', [pageSrc.includes('createElement(\'canvas\')'), /html2canvas|desktopCapturer|toDataURL\(/.test(pageSrc)], [true, false])
check('封面画进 canvas 之前先换成 data URL（否则画布被污染、toBlob 会失败）', pageSrc.includes('api.bangumi.imageDataUrl('), true)
check('改到它自己的年份之前会问用户（不一致 → 弹确认框）', pageSrc.includes('yearCheck(') && pageSrc.includes("check.kind === 'mismatch'") && pageSrc.includes('mismatchMessage('), true)
check('缺放送日期时照实提示但仍允许加入', pageSrc.includes('missingYearMessage('), true)
check('季度数据走 api.bangumi.season（月份按 shared/season 算）', pageSrc.includes('.season(pickedYear, month)') && pageSrc.includes('monthsOfSeason(pickedSeason)'), true)
check('搜索添加走 api.bangumi.search', pageSrc.includes('api.bangumi.search('), true)
check('简易显示的横轴在垂直中间（轴心 = 上下两半相等的中点）', pageSrc.includes('axisY: bodyTop + sideH + EX.AXIS_H / 2'), true)
check('简易显示交错摆在横轴两侧（偶数在上、奇数在下）', pageSrc.includes('% 2 === 0') && pageSrc.includes('% 2 === 1'), true)
check('清晰显示的竖轴在左侧（轴 x = 版心 + 轴宽）', pageSrc.includes('axisX: EX.OUTER + axisW'), true)
check('页面不自己写持久化（落盘只在 store 里做）', pageSrc.includes('CUSTOM_HISTORY_KEY'), false)
check('store 用通用存储读写', storeSrc.includes('api.store.get(CUSTOM_HISTORY_KEY)') && storeSrc.includes('api.store.set(CUSTOM_HISTORY_KEY'), true)
check('页面不在导出时截当前屏幕（当前显示哪种版式 ≠ 导出哪种）', pageSrc.includes('exportMode') && !pageSrc.includes('exportMode: mode'), true)
// 简易显示的卡片只画封面 + 名字：卡片组件里不能出现评分/年份/集数
const simpleCardSrc = pageSrc.slice(pageSrc.indexOf('function SimpleCard'), pageSrc.indexOf('function DetailSheet'))
check('简易显示的卡片只有封面与名字（没有评分）', [simpleCardSrc.includes('rating'), simpleCardSrc.includes('★')], [false, false])
check('清晰显示的卡片带次级信息（年份/季度 + 评分）', pageSrc.includes("seasonTextOf(item.airDate)") && pageSrc.includes('★${item.rating'), true)

console.log('\n================ 结果 ================')
console.log(`通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('全部断言通过 ✓')

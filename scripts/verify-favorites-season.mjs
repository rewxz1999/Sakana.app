/**
 * 收藏页季度归属自检（纯逻辑）。
 *
 * 直接 import **真实源码** src/shared/favoritesSeason.ts（Node 24 自带 TS 类型擦除，
 * 不需要先编译），所以下面的输入→输出就是产品代码的真实行为，不是测试里的副本；
 * 年份口径也从渲染层真实源码 src/renderer/src/lib/format.ts 里取 `yearOf`，
 * 保证「某年某季度多少部」这个数字是按页面上同一套年份判据算出来的。
 *
 * 用法（项目根目录）：
 *   node scripts/verify-favorites-season.mjs
 * 退出码 0 = 全部断言通过。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const season = await import(new URL('../src/shared/favoritesSeason.ts', import.meta.url).href)
const {
  FAVORITE_SEASON_NAMES,
  FAVORITE_SEASON_BUCKETS,
  UNKNOWN_MONTH_KEY,
  UNKNOWN_MONTH_LABEL,
  favoritesSeasonBucket,
  favoritesSeasonKey,
  favoriteSeasonOfMonth,
  parseAirDate,
  groupFavoritesBySeason,
  countFavoritesBySeason
} = season

// 页面上的年份判据（真源码，不是这里重写的副本）
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

// ------------------------------------------------------------------
// 0. 季度常量
// ------------------------------------------------------------------
section('0. 季度常量与顺序')
console.log('季度顺序：', FAVORITE_SEASON_NAMES.join(' → '))
check('四个季度名（冬/春/夏/秋）', [...FAVORITE_SEASON_NAMES], ['冬季', '春季', '夏季', '秋季'])
check('固定季度分组键', FAVORITE_SEASON_BUCKETS.map((b) => b.key), ['season:1', 'season:2', 'season:3', 'season:4'])
check('固定季度分组显示名', FAVORITE_SEASON_BUCKETS.map((b) => b.label), ['冬季', '春季', '夏季', '秋季'])
check('固定季度分组 order 递增', FAVORITE_SEASON_BUCKETS.map((b) => b.order), [1, 2, 3, 4])

// ------------------------------------------------------------------
// 0.5 与取数用的季节约定必须逐月一致（这是 v0.3.7 那次改错的直接防线）
// ------------------------------------------------------------------
section('0.5 与 @shared/season.ts 的月份→季度判定逐月比对')
const seasonCanon = await import(new URL('../src/shared/season.ts', import.meta.url).href)
const mismatch = []
for (let m = 1; m <= 12; m++) {
  if (favoriteSeasonOfMonth(m) !== seasonCanon.seasonIndexOfMonth(m)) {
    mismatch.push(`month=${m}: 收藏页=${favoriteSeasonOfMonth(m)} 取数=${seasonCanon.seasonIndexOfMonth(m)}`)
  }
}
console.log(`1..12 月逐月比对：${mismatch.length === 0 ? '完全一致' : mismatch.join('；')}`)
check('两份约定的月份→季度判定完全一致', mismatch, [])
// 季度名允许长短两种写法（收藏页显示「冬季」，番剧表显示「冬」），但**首字必须一致且同序**
check('季度名首字与取数侧一致、顺序相同', [...FAVORITE_SEASON_NAMES].map((n) => n[0]).join(''), seasonCanon.SEASON_NAMES.join(''))

// ------------------------------------------------------------------
// 1. 12 个月 → 季度（完整日期；1–3 冬、4–6 春、7–9 夏、10–12 秋，年内不跨年）
// ------------------------------------------------------------------
section('1. 12 个月分别归到哪个季度（都带「日」，即判据 ①）')
const MONTH_CASES = [
  // 月份, 期望季度名, 期望季度键, 期望季度所属年（相对 2026）
  [1, '冬季', 'season:1', 2026],
  [2, '冬季', 'season:1', 2026],
  [3, '冬季', 'season:1', 2026],
  [4, '春季', 'season:2', 2026],
  [5, '春季', 'season:2', 2026],
  [6, '春季', 'season:2', 2026],
  [7, '夏季', 'season:3', 2026],
  [8, '夏季', 'season:3', 2026],
  [9, '夏季', 'season:3', 2026],
  [10, '秋季', 'season:4', 2026],
  [11, '秋季', 'season:4', 2026],
  [12, '秋季', 'season:4', 2026]
]
console.log('| 开播日期 | 月份 | 归属分组 | 季度所属年 |')
console.log('| --- | --- | --- | --- |')
for (const [month, label, key, seasonYear] of MONTH_CASES) {
  const raw = `2026-${String(month).padStart(2, '0')}-15`
  const bucket = favoritesSeasonBucket(raw)
  console.log(`| ${raw} | ${month} | ${bucket.label}（${bucket.key}） | ${bucket.seasonYear ?? '—'} |`)
  check(`2026-${month} 的季度名`, bucket.label, label)
  check(`2026-${month} 的季度键`, bucket.key, key)
  check(`2026-${month} 的季度所属年`, bucket.seasonYear, seasonYear)
  check(`2026-${month} 归类为季度组`, bucket.kind, 'season')
  // 季度组的 month 恒为 null（一季跨三个月）；单条收藏的月份用 parseAirDate 取，这里也验一遍
  check(`2026-${month} 的季度组不带月份字段（月份只属于月份组）`, bucket.month, null)
  check(`2026-${month} 的日期仍能解析出月份`, parseAirDate(raw)?.month, month)
  check(`2026-${month} 与 favoriteSeasonOfMonth 一致`, bucket.season, favoriteSeasonOfMonth(month))
}
check('1 月的番属于**当年**冬季（v0.3.7 起不再回退一年）', [favoritesSeasonBucket('2026-01-05').seasonYear, favoritesSeasonBucket('2026-02-28').seasonYear], [2026, 2026])
check('12 月算当年秋季', [favoritesSeasonBucket('2026-12-31').label, favoritesSeasonBucket('2026-12-31').seasonYear], ['秋季', 2026])
check('跨年验证：2027-01-01 → 2027 年冬季', [favoritesSeasonBucket('2027-01-01').label, favoritesSeasonBucket('2027-01-01').seasonYear], ['冬季', 2027])
// 换一年再验一遍，确认不是把 2026 写死了
check('2024-04-01 → 2024 年春季', [favoritesSeasonBucket('2024-04-01').label, favoritesSeasonBucket('2024-04-01').seasonYear], ['春季', 2024])
// 其它可解析写法（7 月 = 夏季 = season:3）
check('斜杠写法 2026/07/05', [favoritesSeasonKey('2026/07/05'), favoritesSeasonBucket('2026/07/05').label], ['season:3', '夏季'])
check('点号写法 2026.07.05', favoritesSeasonKey('2026.07.05'), 'season:3')
check('中文写法 2026年7月5日', favoritesSeasonKey('2026年7月5日'), 'season:3')
check('ISO 带时间 2026-07-05T12:00:00+09:00', favoritesSeasonKey('2026-07-05T12:00:00+09:00'), 'season:3')
check('个位数月份 2026-7-5', favoritesSeasonKey('2026-7-5'), 'season:3')
check('首尾空格被忽略', favoritesSeasonKey('  2026-07-05  '), 'season:3')

// ------------------------------------------------------------------
// 2. 只有年月 → 不判季度，按月份分组（判据 ②）
// ------------------------------------------------------------------
section('2. 只有年月 → 按月份分组（判据 ②）')
const MONTH_ONLY = [
  ['2026-07', '7月', 'month:7', 7],
  ['2026-7', '7月', 'month:7', 7],
  ['2026/07', '7月', 'month:7', 7],
  ['2026.07', '7月', 'month:7', 7],
  ['2026年7月', '7月', 'month:7', 7],
  ['2026-01', '1月', 'month:1', 1],
  ['2026-12', '12月', 'month:12', 12]
]
console.log('| 开播日期 | 归属分组 | 分组键 |')
console.log('| --- | --- | --- |')
for (const [raw, label, key, month] of MONTH_ONLY) {
  const bucket = favoritesSeasonBucket(raw)
  console.log(`| ${raw} | ${bucket.label} | ${bucket.key} |`)
  check(`${raw} 归到月份组`, bucket.key, key)
  check(`${raw} 显示名`, bucket.label, label)
  check(`${raw} 是月份组而非季度组`, bucket.kind, 'month')
  check(`${raw} 月份值`, bucket.month, month)
  check(`${raw} 没有季度/季度年`, [bucket.season, bucket.seasonYear], [null, null])
}
check('只有年月时 parseAirDate 的 day 为 null', parseAirDate('2026-07')?.day, null)
check('月份组排在四个季度之后', favoritesSeasonBucket('2026-07').order > favoritesSeasonBucket('2026-12-01').order, true)

// ------------------------------------------------------------------
// 3. 缺失 / 脏数据 → 未知月份，且绝不抛异常（判据 ③）
// ------------------------------------------------------------------
section('3. 缺失与脏数据 → 未知月份（判据 ③，不允许崩）')
const DIRTY = [
  null,
  undefined,
  '',
  '   ',
  '\t\n',
  '2026',
  '2026年',
  '不知道',
  'abcd-ef-gh',
  '2026-13-01',
  '2026-13',
  '2026-00-10',
  '0000-07-01',
  '999-07-01',
  '1899-12-31',
  '2101-01-01',
  '07-05',
  '20260705',
  0,
  123,
  NaN,
  true,
  false,
  {},
  [],
  ['2026-07-05'],
  { airDate: '2026-07-05' }
]
let crashes = 0
const dirtyResults = []
for (const raw of DIRTY) {
  let got
  try {
    const bucket = favoritesSeasonBucket(raw)
    got = bucket.key
    // 顺便确认返回结构完整（界面直接读 label/order，缺字段会渲染出空白）
    if (typeof bucket.label !== 'string' || typeof bucket.hint !== 'string' || typeof bucket.order !== 'number') {
      throw new Error('返回结构不完整')
    }
  } catch (err) {
    crashes++
    got = `抛异常：${String(err)}`
  }
  dirtyResults.push([JSON.stringify(raw) ?? String(raw), got])
  check(`脏数据 ${JSON.stringify(raw) ?? String(raw)} → 未知月份`, got, UNKNOWN_MONTH_KEY)
}
console.log('| 输入 | 结果 |')
console.log('| --- | --- |')
for (const [raw, got] of dirtyResults) console.log(`| ${raw} | ${got} |`)
check('脏数据一条都没抛异常', crashes, 0)
check('未知月份的分组名', favoritesSeasonBucket(null).label, UNKNOWN_MONTH_LABEL)
check('未知月份排在最后（order 最大）', [favoritesSeasonBucket(null).order, favoritesSeasonBucket('2026-07').order, favoritesSeasonBucket('2026-12-01').order], [100, 17, 4])
check('parseAirDate 对非字符串返回 null', [parseAirDate(0), parseAirDate({}), parseAirDate(['2026-07-05']), parseAirDate(true)], [null, null, null, null])
// 「日」脏但年月可信：只丢日、不整条打成未知（按月份分组），这是刻意的降级
check('日非法（2026-07-32）→ 丢日、按月份分组', favoritesSeasonBucket('2026-07-32').key, 'month:7')
check('日为 0（2026-07-00）→ 丢日、按月份分组', favoritesSeasonBucket('2026-07-00').key, 'month:7')

// ------------------------------------------------------------------
// 4. 分组计数：某年某季度的收藏数
// ------------------------------------------------------------------
section('4. 分组与计数（含「某年某季度」）')

/** 造一批收藏：只用到 airDate（判据只看它） */
function fav(subjectId, airDate, name = `番剧${subjectId}`) {
  return { subjectId, name, nameCn: name, airDate }
}

const FAKES = [
  // 2026 年：冬 2 部（1/2 月）、春 2 部、夏 3 部、秋 2 部（10/12 月）
  fav(1, '2026-04-03'),
  fav(2, '2026-05-20'),
  fav(3, '2026-07-07'),
  fav(4, '2026-07-07'),
  fav(5, '2026-08-01'),
  fav(6, '2026-10-11'),
  fav(7, '2026-12-25'),
  // 2026 年 1、2 月播出 → 就是 2026 年冬季（v0.3.7 起不再回退到上一年）
  fav(8, '2026-01-09'),
  fav(9, '2026-02-14'),
  // 2025 年
  fav(10, '2025-07-04'),
  fav(11, '2025-10-02'),
  // 只有年月 / 脏数据
  fav(12, '2026-07'),
  fav(13, '2026-11'),
  fav(14, ''),
  fav(15, null),
  fav(16, '2026-13-01')
]

const byKey = countFavoritesBySeason(FAKES)
console.log('全部分组计数：', JSON.stringify(byKey))
check('总数守恒（每条都归了组，没有丢）', Object.values(byKey).reduce((s, n) => s + n, 0), FAKES.length)
check('冬季总数（2026-01 + 2026-02 = 2）', byKey['season:1'], 2)
check('春季总数（2026-04/05 共 2 部）', byKey['season:2'], 2)
check('夏季总数（2026 年 3 部 + 2025 年 1 部 = 4）', byKey['season:3'], 4)
check('秋季总数（2026-10 + 2026-12 + 2025-10 = 3）', byKey['season:4'], 3)
check('7 月分组（2026-07 只有年月 1 部）', byKey['month:7'], 1)
check('11 月分组（2026-11 只有年月 1 部）', byKey['month:11'], 1)
check('未知月份（空串 / null / 2026-13-01 共 3 部）', byKey[UNKNOWN_MONTH_KEY], 3)
check('没有凭空多出来的分组键', Object.keys(byKey).sort(), ['month:11', 'month:7', 'month:unknown', 'season:1', 'season:2', 'season:3', 'season:4'])

// 年份判据与页面一致（yearOf 来自渲染层真源码）
const YEAR = 2026
const in2026 = FAKES.filter((f) => yearOf(f.airDate) === YEAR)
// 注意：年份判据只看「前 4 位」（yearOf），所以 '2026-13-01' 这种脏日期也算 2026 年（但它的季度归属是未知月份）
check(`2026 年的收藏数（yearOf 判据）`, in2026.length, 12)
check('2026 年 + 夏季 = 3 部', countFavoritesBySeason(in2026)['season:3'], 3)
check('2026 年 + 春季 = 2 部', countFavoritesBySeason(in2026)['season:2'], 2)
check('2026 年 + 秋季 = 2 部（10、12 月）', countFavoritesBySeason(in2026)['season:4'], 2)
check('2026 年 + 冬季 = 2 部（1、2 月，按播出年归到 2026 这组）', countFavoritesBySeason(in2026)['season:1'], 2)
check('2026 年 + 7 月（只有年月）= 1 部', countFavoritesBySeason(in2026)['month:7'], 1)
check('2026 年 + 11 月（只有年月）= 1 部', countFavoritesBySeason(in2026)['month:11'], 1)
check('2026 年 + 未知月份 = 1 部（脏日期 2026-13-01）', countFavoritesBySeason(in2026)[UNKNOWN_MONTH_KEY], 1)
check('2026 年各季度/月份相加 = 该年总数', Object.values(countFavoritesBySeason(in2026)).reduce((s, n) => s + n, 0), in2026.length)

// 分组结果（界面用的就是它：分组 + 组内条目 + 条数）
const grouped = groupFavoritesBySeason(FAKES)
console.log('分组顺序与条数：', grouped.map((g) => `${g.bucket.label}×${g.count}`).join('，'))
check('分组顺序：冬 → 春 → 夏 → 秋 → 月份 → 未知月份', grouped.map((g) => g.bucket.key), ['season:1', 'season:2', 'season:3', 'season:4', 'month:7', 'month:11', UNKNOWN_MONTH_KEY])
check('每组的 count 等于 items.length', grouped.every((g) => g.count === g.items.length), true)
check('组内条目数之和 = 输入条数', grouped.reduce((s, g) => s + g.items.length, 0), FAKES.length)
check('grouped 与 countFavoritesBySeason 口径一致', grouped.every((g) => byKey[g.bucket.key] === g.count), true)
check('空输入不崩（返回空分组）', [groupFavoritesBySeason([]).length, countFavoritesBySeason([])], [0, {}])
check('入参里有 undefined 也不崩', groupFavoritesBySeason([undefined, fav(99, '2026-07-07')]).map((g) => g.count), [1, 1])

// ------------------------------------------------------------------
// 5. 真实收藏数据（data/userData/data/favorites.json）跑一遍
// ------------------------------------------------------------------
section('5. 真实收藏数据')
const favPath = join(root, 'data', 'userData', 'data', 'favorites.json')
let realItems = []
try {
  const raw = JSON.parse(readFileSync(favPath, 'utf8'))
  realItems = Array.isArray(raw) ? raw : []
  console.log(`读取真实收藏：${realItems.length} 条（${favPath}）`)
} catch (err) {
  console.log(`读不到真实收藏（${String(err)}），跳过这一节`)
}
if (realItems.length > 0) {
  const realGroups = groupFavoritesBySeason(realItems)
  console.log('| 开播日期 | 收藏 | 归属分组 |')
  console.log('| --- | --- | --- |')
  const seen = new Set()
  for (const it of realItems) {
    if (seen.has(it.subjectId)) continue
    seen.add(it.subjectId)
    const b = favoritesSeasonBucket(it.airDate)
    console.log(`| ${it.airDate ?? '(空)'} | ${it.nameCn || it.name} | ${b.label}（${b.key}） |`)
  }
  console.log('分组统计：', realGroups.map((g) => `${g.bucket.label} ${g.count}`).join('，'))
  check('真实数据每条都归了组', realGroups.reduce((s, g) => s + g.count, 0), realItems.length)
  check('真实数据没有落到未知月份（当前这份都在 7 月）', countFavoritesBySeason(realItems)[UNKNOWN_MONTH_KEY] ?? 0, 0)
  const real2026 = realItems.filter((f) => yearOf(f.airDate) === 2026)
  const bySeason2026 = countFavoritesBySeason(real2026)
  console.log(`其中 2026 年 ${real2026.length} 部 → 分布 ${JSON.stringify(bySeason2026)}`)
  /*
   * ⚠️ 这里**不能**断言「2026 年的都在夏季」。
   * 第一版就是这么写的，跑通只是因为当时的收藏恰好全是 7 月番；
   * 用户后来加了一部 1 月番（超辉夜姬）之后这条断言立刻变成假失败（209 项通过、就它挂）。
   * 真实数据会变，断言必须只依赖**不随数据变化的性质**：
   *   ① 每一条都被归进了某个分组（不丢条目）；
   *   ② 分组键合法（season:1..4 / month:N / unknown）；
   *   ③ 冬季分组里的月份只能是 1、2、3（v0.3.7 后的划分）。
   */
  check('真实数据 2026 年的每一条都归了组', Object.values(bySeason2026).reduce((a, b) => a + b, 0), real2026.length)
  const validKeys = Object.keys(bySeason2026).every((k) => /^season:[1-4]$/.test(k) || /^month:(\d{1,2}|unknown)$/.test(k))
  check('真实数据分组键合法', validKeys, true)
  const winterMonths = real2026
    .filter((f) => favoritesSeasonBucket(f.airDate).key === 'season:1')
    .map((f) => Number(String(f.airDate ?? '').slice(5, 7)))
  check(
    '冬季分组只可能来自 1/2/3 月',
    winterMonths.every((m) => m === 1 || m === 2 || m === 3),
    true
  )
  check('existsSync 与读取结果一致（文件确实存在）', existsSync(favPath), true)
}

// ------------------------------------------------------------------
// 6. 界面接线静态检查（读 FavoritesPage 源码，确认按钮真的搬进了右键菜单）
// ------------------------------------------------------------------
section('6. 界面接线静态检查（读 FavoritesPage 源码）')
{
  const pageSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'pages', 'FavoritesPage.tsx'), 'utf8')
  check('卡片上不再传 onFav（取消收藏按钮已移出卡片表面）', /onFav=/.test(pageSrc), false)
  check('卡片上不再传 onConcern（重点关心按钮已移出卡片表面）', /onConcern=/.test(pageSrc), false)
  check('卡片上挂了右键菜单', /onContextMenu=\{\(e\) => openCardMenu\(e, f\)\}/.test(pageSrc), true)
  check('右键菜单里有「查看详情」', pageSrc.includes("label: '查看详情'"), true)
  check('右键菜单里有「本地播放」', pageSrc.includes("label: '本地播放'"), true)
  check('右键菜单里有「重点关心 / 取消重点关心」', pageSrc.includes("label: concerned ? '取消重点关心' : '重点关心'"), true)
  check('右键菜单里有「标记为已看完 / 取消已看完」', pageSrc.includes("label: completed ? '取消已看完' : '标记为已看完'"), true)
  check('右键菜单里有「取消收藏」', pageSrc.includes("label: '取消收藏'"), true)
  check('取消了卡片上的收藏状态按钮后仍保留状态角标', pageSrc.includes('重点'), true)
  check('旧的右侧「重点关心」区块已整体移除', pageSrc.includes('concernItems'), false)
  check('季度栏用的是四个固定季度分组', pageSrc.includes('FAVORITE_SEASON_BUCKETS'), true)
  check('季度筛选与年份筛选同时生效（两套筛选都进了列表过滤）', [pageSrc.includes('pickedYear === null'), pageSrc.includes('pickedSeason === null')], [true, true])
  check('切换年份时把季度重置为「全部」', pageSrc.includes('setPickedSeason(null)'), true)
  check('复用现成的通用右键菜单组件', pageSrc.includes("from '@/components/stat/ContextMenu'"), true)
}

// ------------------------------------------------------------------
console.log('\n================ 结果 ================')
console.log(`通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('全部断言通过 ✓')

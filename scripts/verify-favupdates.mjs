/**
 * 仪表盘「收藏番剧更新」判定自检（v0.3.9，纯逻辑 + 真实数据）。
 *
 * 直接 import **真实源码** src/renderer/src/lib/favUpdates.ts（Node 24 自带 TS 类型擦除，
 * 不需要先编译），所以下面的输入→输出就是产品代码的真实行为，不是这里的副本。
 *
 * 三节：
 *   1. 口径断言（构造数据）：更新集数、消失条件、「最新一集」的算法、脏数据不崩；
 *   2. 真实数据：读 data/userData/data 里的收藏 / 观看历史 / 观看进度，
 *      并按**应用同一份数据源**（settings.json 的 dataSources.main + /v0/episodes?type=0）
 *      现取每个收藏的 aired，跑一遍真实判定（离线时自动跳过这一节）；
 *   3. 界面接线静态检查：读 DashboardPage.tsx，确认两个板块的点击行为与工单一致。
 *
 * 用法（项目根目录）：
 *   node scripts/verify-favupdates.mjs
 * 退出码 0 = 全部断言通过。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const lib = await import(new URL('../src/renderer/src/lib/favUpdates.ts', import.meta.url).href)
const {
  FAV_UPDATE_MIN_WATCHED,
  buildFavUpdateRows,
  buildWatchedEpisodeMap,
  currentSeasonFavorites,
  episodeFromWatchedKey,
  isInCurrentSeason,
  localDateString,
  shouldFetchEpisodeProgress
} = lib

/*
 * 本季判据的真源码：收藏页那一份（1-3 冬 / 4-6 春 / 7-9 夏 / 10-12 秋，另有
 * verify-favorites-season.mjs 守着它与 @shared/season.ts 逐月一致）。
 * 仪表盘把同一个函数注入 lib，所以「本季」与收藏页季度栏的分组必然是同一套划分。
 */
const { favoritesSeasonBucket } = await import(new URL('../src/shared/favoritesSeason.ts', import.meta.url).href)

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

const TODAY = '2026-10-08'

/** 造收藏（只用到判定涉及的字段） */
function fav(subjectId, extra = {}) {
  return {
    subjectId,
    name: `原名${subjectId}`,
    nameCn: `番剧${subjectId}`,
    cover: '',
    rating: null,
    airDate: '2026-07-01',
    genres: [],
    addedAt: 0,
    ...extra
  }
}
/** 造分集进度 */
function prog(aired, extra = {}) {
  return {
    aired,
    total: extra.total ?? aired,
    lastAirDate: extra.lastAirDate ?? '2026-09-01',
    nextAirDate: extra.nextAirDate ?? null,
    finished: extra.finished ?? false
  }
}

// ------------------------------------------------------------------
section('0. 基础口径：默认最低已看集数、本地日期')
check('默认 FAV_UPDATE_MIN_WATCHED = 0（严格按用户规则：没看过最新一集就算更新）', FAV_UPDATE_MIN_WATCHED, 0)
check('已看集数为 0 时也算有更新（默认口径下不会因「没开始看」被丢掉）', buildFavUpdateRows({
  favorites: [fav(1)],
  progressBySubject: new Map([[1, prog(3)]]),
  watchedMap: new Map()
}).length, 1)
check('localDateString 是本地日历 YYYY-MM-DD（不随 UTC 漂移）', localDateString(new Date(2026, 0, 5, 0, 30)), '2026-01-05')
check('localDateString 补零', localDateString(new Date(2026, 8, 9, 23, 59)), '2026-09-09')

// ------------------------------------------------------------------
section('0.5 本季筛选（工单：只统计当前季度的收藏，老番不再计入）')
// 判据用的是收藏页那一份真源码（favoritesSeasonBucket），这里逐条比对它的季度组键
check('2026-10 属于秋季组 season:4', favoritesSeasonBucket('2026-10-05').key, 'season:4')
check('今天 2026-10-08 也在秋季组（同一函数算出来的今天是哪一季）', favoritesSeasonBucket(TODAY).key, 'season:4')
const SEASON_CASES = [
  ['2026-10-01', true, '本季首日（10 月 = 秋）'],
  ['2026-12-31', true, '本季最后一天（12 月 = 秋）'],
  ['2026-09-30', false, '上一季（9 月 = 夏）'],
  ['2026-07-07', false, '同年的夏番（真实收藏里的 7 月番）'],
  ['2026-01-22', false, '同年冬番（超辉夜姬那类）'],
  ['2025-10-05', false, '去年秋季（跨年不给过）'],
  ['2008-03-20', false, 'CLANNAD 这类老番'],
  ['2021-03-21', false, '无职转生这类老番'],
  ['2027-01-05', false, '明年的番（还没到那一季）'],
  ['2026-10', false, '只有年月（收藏页按「10月」分组、不判季度）'],
  ['2026-10-32', false, '日脏（只丢日 → 只有年月 → 不判季度）'],
  ['', false, '空串'],
  [null, false, 'null'],
  [undefined, false, 'undefined'],
  ['不知道', false, '无法解析'],
  [20261005, false, '非字符串']
]
for (const [airDate, expected, why] of SEASON_CASES) {
  check(`${why}：${JSON.stringify(airDate)} → ${expected ? '本季' : '非本季'}`, isInCurrentSeason(airDate, TODAY, favoritesSeasonBucket), expected)
}
// 换一个「今天」，确认不是把 10 月写死了
check('今天是 2027-01-15（冬）时，2027-02-01 算本季', isInCurrentSeason('2027-02-01', '2027-01-15', favoritesSeasonBucket), true)
check('今天是 2027-01-15（冬）时，2027-04-01 不算本季', isInCurrentSeason('2027-04-01', '2027-01-15', favoritesSeasonBucket), false)
check('今天是 2027-01-15 时，2026-10-05 不算本季（跨年）', isInCurrentSeason('2026-10-05', '2027-01-15', favoritesSeasonBucket), false)
// 列表版：只留本季，且不改变原顺序、不动入参
const MIXED = [fav(1, { airDate: '2026-10-05' }), fav(2, { airDate: '2026-07-07' }), fav(3, { airDate: '2026-11-11' }), fav(4, { airDate: null })]
const MIXED_BEFORE = JSON.stringify(MIXED)
check('本季收藏筛选结果', currentSeasonFavorites(MIXED, TODAY, favoritesSeasonBucket).map((f) => f.subjectId), [1, 3])
check('筛选不修改入参', JSON.stringify(MIXED), MIXED_BEFORE)
check('空收藏不崩', currentSeasonFavorites([], TODAY, favoritesSeasonBucket), [])
check('收藏列表里有 undefined 也不崩', currentSeasonFavorites([undefined, fav(9, { airDate: '2026-10-09' })], TODAY, favoritesSeasonBucket).length, 1)
// 筛选 + 更新判定串起来：老番（非本季）即使有更新也不进列表
check(
  '非本季的老番即使 aired 很大也不出现在结果里',
  buildFavUpdateRows({
    favorites: currentSeasonFavorites([fav(5, { airDate: '2008-03-20' })], TODAY, favoritesSeasonBucket),
    progressBySubject: new Map([[5, prog(22)]]),
    watchedMap: new Map()
  }).length,
  0
)

// ------------------------------------------------------------------
section('1. 一条观看记录 → 已看到第几集（集号口径）')
// 进度里 watched 的键是 `${线路}:${集序号}`，线路只是镜像线路，所以只看集序号
check('watched 键 0:11 → 第 12 集', episodeFromWatchedKey('0:11'), 12)
check('watched 键 2:0 → 第 1 集', episodeFromWatchedKey('2:0'), 1)
check('脏键（没有冒号）→ null', episodeFromWatchedKey('garbage'), null)
check('脏键（集序号非数字）→ null', episodeFromWatchedKey('0:abc'), null)
check('脏键（负集序号）→ null', episodeFromWatchedKey('0:-3'), null)

const WATCHED_OK = buildWatchedEpisodeMap(
  [fav(100)],
  [
    // 本地播放：文件名解析出的集号（主进程 parseEpisode）
    { id: 'h1', subjectId: 100, title: '番剧100', episode: 9, source: 'local', watchedAt: 1, hour: 1, durationSec: 0 },
    // 在线播放写进历史的 episode 恒为 null —— 必须不足以提供集号
    { id: 'h2', subjectId: 100, title: '番剧100', episode: null, source: 'online', watchedAt: 2, hour: 1, durationSec: 0 }
  ],
  [
    // 当前进度在第 3 集，但历史上看过第 12 集（watched 里攒着）→ 取最大 12
    {
      id: 'default-age::x', subjectId: 100, title: '番剧100', source: 'online',
      groupIndex: 0, episodeIndex: 2, watched: ['0:2', '1:11'], positionSec: 10, durationSec: 100, updatedAt: 3
    }
  ]
)
check('历史集号与进度 watched 取最大（12，而不是当前的第 3 集）', WATCHED_OK.get(100), 12)
check('本地历史贡献的集号（9）也进 map', WATCHED_OK.get(100) >= 9, true)

const WATCHED_TITLE_ONLY = buildWatchedEpisodeMap(
  [fav(200)],
  [{ id: 'h', subjectId: undefined, title: '番剧200', episode: 4, source: 'local', watchedAt: 1, hour: 1, durationSec: 0 }],
  []
)
check('没有 subjectId 时按标题兜底匹配收藏', WATCHED_TITLE_ONLY.get(200), 4)

const WATCHED_NO_MATCH = buildWatchedEpisodeMap(
  [fav(300)],
  [{ id: 'h', subjectId: 301, title: '别的番', episode: 7, source: 'local', watchedAt: 1, hour: 1, durationSec: 0 }],
  []
)
check('别的番剧的观看记录不会算到这部头上', WATCHED_NO_MATCH.get(300), undefined)

let crashed = 0
try {
  const dirty = buildWatchedEpisodeMap(
    [fav(400)],
    [{ id: 'h', subjectId: 400, title: '番剧400', episode: 0, source: 'local', watchedAt: 1, hour: 1, durationSec: 0 }],
    [
      // 脏进度：episodeIndex 缺失 / watched 是脏键 / watched 为 undefined
      { id: 'd1', subjectId: 400, title: '番剧400', source: 'online', groupIndex: 0, episodeIndex: undefined, positionSec: 0, durationSec: 0, updatedAt: 1 },
      { id: 'd2', subjectId: 400, title: '番剧400', source: 'online', groupIndex: 0, episodeIndex: -5, watched: ['', 'x:y', '0:2'], positionSec: 0, durationSec: 0, updatedAt: 1 }
    ]
  )
  check('脏数据下只保留合法集号（0:2 → 第 3 集）', dirty.get(400), 3)
} catch (err) {
  crashed++
  console.log('  脏数据抛异常：', String(err))
}
check('脏数据一条都没抛异常', crashed, 0)

// ------------------------------------------------------------------
section('2. 更新集数与「消失条件」')
const FAVS = [fav(1), fav(2), fav(3), fav(4), fav(5)]
const PROGRESS = new Map([
  [1, prog(12, { lastAirDate: '2026-09-20' })], // 已看 10 → 新 2 集
  [2, prog(12, { lastAirDate: '2026-09-27' })], // 已看 12 → 消失（看过最新一集）
  [3, prog(5, { lastAirDate: '2026-08-01' })], // 已看 6（超过 aired）→ 消失
  [4, prog(0)], // aired = 0（还没播/没有分集数据）→ 不出现
  [5, null] // 取不到进度 → 不出现（宁可不提示，也不编造集数）
])
const WATCHED = new Map([
  [1, 10],
  [2, 12],
  [3, 6]
])
const ROWS = buildFavUpdateRows({ favorites: FAVS, progressBySubject: PROGRESS, watchedMap: WATCHED })
check('只有第 1 部有更新', ROWS.map((r) => r.subjectId), [1])
check('更新了几集 = aired − watched', ROWS[0].updateCount, 2)
check('行里带已更新到第几集', ROWS[0].aired, 12)
check('行里带你已看到第几集', ROWS[0].watched, 10)
check('行里带标题（优先中文名）', ROWS[0].title, '番剧1')
check('取不到进度(null) 的番剧不出现', ROWS.some((r) => r.subjectId === 5), false)
check('aired=0 的番剧不出现', ROWS.some((r) => r.subjectId === 4), false)
check('看过最新一集 → 该条消失', ROWS.some((r) => r.subjectId === 2), false)
check('已看集数超过已播集数 → 该条消失', ROWS.some((r) => r.subjectId === 3), false)
check('没有更新的番剧一律不出现（无假数据）', ROWS.length, 1)

// 「最新一集」就是第 aired 集：watched = aired - 1 时仍在，watched = aired 时消失
for (const aired of [1, 3, 12, 24]) {
  const base = { favorites: [fav(9)], progressBySubject: new Map([[9, prog(aired)]]) }
  const before = buildFavUpdateRows({ ...base, watchedMap: new Map([[9, aired - 1]]) })
  const at = buildFavUpdateRows({ ...base, watchedMap: new Map([[9, aired]]) })
  check(`aired=${aired}：看过第 ${aired - 1} 集仍提示（新 1 集）`, [before.length, before[0]?.updateCount], [1, 1])
  check(`aired=${aired}：看过第 ${aired} 集（最新一集）→ 消失`, at.length, 0)
}

// 排序：最近更新完的排前面，其次攒得多的排前面
const SORTED = buildFavUpdateRows({
  favorites: [fav(21), fav(22), fav(23)],
  progressBySubject: new Map([
    [21, prog(10, { lastAirDate: '2026-09-01' })],
    [22, prog(10, { lastAirDate: '2026-10-01' })],
    [23, prog(10, { lastAirDate: '2026-10-01' })]
  ]),
  watchedMap: new Map([
    [21, 1],
    [22, 9],
    [23, 1]
  ])
})
check('按最后放送日倒序，同日按更新集数倒序', SORTED.map((r) => r.subjectId), [23, 22, 21])
check('排序结果里每行的 updateCount 都 > 0', ROWS.every((r) => r.updateCount > 0), true)
check('空收藏不崩', buildFavUpdateRows({ favorites: [], progressBySubject: new Map(), watchedMap: new Map() }), [])
check(
  'FAV_UPDATE_MIN_WATCHED=1 时未开始看的番剧被排除（可切换的口径）',
  buildFavUpdateRows({
    favorites: [fav(1), fav(2)],
    progressBySubject: new Map([[1, prog(5)], [2, prog(5)]]),
    watchedMap: new Map([[2, 1]]),
    minWatched: 1
  }).map((r) => r.subjectId),
  [2]
)

// ------------------------------------------------------------------
section('3. 该不该为这部收藏去查分集进度（纯优化，不影响判定）')
check('正常在播番 → 要查', shouldFetchEpisodeProgress(fav(1), new Map(), TODAY), true)
check('手动标记已看完 → 不查', shouldFetchEpisodeProgress(fav(1, { watchedAt: 1 }), new Map(), TODAY), false)
check('还没开播（今天之后）→ 不查', shouldFetchEpisodeProgress(fav(1, { airDate: '2026-11-01' }), new Map(), TODAY), false)
check('今天开播 → 要查', shouldFetchEpisodeProgress(fav(1, { airDate: TODAY }), new Map(), TODAY), true)
check('已看集数 ≥ 计划集数 → 不查', shouldFetchEpisodeProgress(fav(1, { eps: 12 }), new Map([[1, 12]]), TODAY), false)
check('已看集数 < 计划集数 → 要查', shouldFetchEpisodeProgress(fav(1, { eps: 12 }), new Map([[1, 3]]), TODAY), true)
check('计划集数未知时不能据此跳过', shouldFetchEpisodeProgress(fav(1, { eps: null }), new Map([[1, 999]]), TODAY), true)

// ------------------------------------------------------------------
section('4. 真实数据 + 真实分集接口（同一个 dataSources.main）')
const dataDir = join(root, 'data', 'userData', 'data')
function readJson(name) {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, name), 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}
const realFavorites = readJson('favorites.json')
const realHistory = readJson('watchHistory.json')
const realProgress = readJson('watchProgress.json')
console.log(`收藏 ${realFavorites.length} 部 · 观看历史 ${realHistory.length} 条 · 观看进度 ${realProgress.length} 条`)

const realWatched = buildWatchedEpisodeMap(realFavorites, realHistory, realProgress)
console.log('已看到第几集（按收藏）：', realFavorites.map((f) => `${f.subjectId}:${realWatched.get(f.subjectId) ?? 0}`).join('，'))
check('真实收藏都能算出已看集数（无数据时为 0，不抛异常）', realFavorites.every((f) => Number.isFinite(realWatched.get(f.subjectId) ?? 0)), true)

let base = ''
try {
  const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
  base = String(settings?.dataSources?.main ?? '').replace(/\/+$/, '')
} catch {
  base = ''
}
let realAired = new Map()
let fetched = 0
if (base) {
  const today = localDateString()
  const ids = realFavorites.map((f) => f.subjectId).filter((id) => Number.isFinite(id) && id > 0)
  let cursor = 0
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++]
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 8000)
        const r = await fetch(`${base}/v0/episodes?subject_id=${id}&type=0&limit=100`, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Sakana/0.3.9 (verify-favupdates)' }
        })
        clearTimeout(timer)
        const j = await r.json()
        const list = Array.isArray(j?.data) ? j.data : []
        const dates = list.map((e) => String(e?.airdate ?? '').trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
        if (dates.length === 0) continue
        const aired = dates.filter((d) => d <= today)
        realAired.set(id, {
          aired: aired.length,
          total: list.length,
          lastAirDate: aired.length > 0 ? aired[aired.length - 1] : null,
          nextAirDate: dates.find((d) => d > today) ?? null,
          finished: aired.length >= list.length
        })
        fetched++
      } catch {
        /* 单个取不到就当没有数据，与主进程 episodeProgress 的降级一致 */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker))
  console.log(`分集接口取到 ${fetched}/${ids.length} 部（数据源 ${base}，今天 ${today}）`)
} else {
  console.log('settings.json 里没有 dataSources.main，跳过真实取数')
}

if (fetched > 0) {
  // 工单要求：只统计本季收藏 —— 真实数据里 2026-07 的番在 10 月已经不算本季
  const realToday = localDateString()
  const realSeasonFavorites = currentSeasonFavorites(realFavorites, realToday, favoritesSeasonBucket)
  console.log(
    `今天是 ${realToday}（${favoritesSeasonBucket(realToday).label}）：本季收藏 ${realSeasonFavorites.length}/${realFavorites.length} 部` +
      `（非本季：${realFavorites.filter((f) => !realSeasonFavorites.includes(f)).map((f) => f.nameCn || f.name).join('，') || '无'}）`
  )
  const realRows = buildFavUpdateRows({ favorites: realSeasonFavorites, progressBySubject: realAired, watchedMap: realWatched })
  console.log('\n| 收藏番剧 | 开播 | 是否本季 | 更新至 | 你已看到 | 新几集 | 最后放送日 | 计入更新 |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const f of realFavorites) {
    const p = realAired.get(f.subjectId)
    const w = realWatched.get(f.subjectId) ?? 0
    const season = realSeasonFavorites.includes(f)
    const inRows = realRows.some((r) => r.subjectId === f.subjectId)
    console.log(
      `| ${f.nameCn || f.name} | ${f.airDate ?? '—'} | ${season ? '✓' : ''} | ${p ? `第 ${p.aired} 集` : '（无数据）'} | ` +
        `${w > 0 ? `第 ${w} 集` : '未观看'} | ${p ? Math.max(0, p.aired - w) : '—'} | ${p?.lastAirDate ?? '—'} | ${inRows ? '✓' : ''} |`
    )
  }
  console.log(`\n真实数据下「有更新」${realRows.length} 部：${realRows.map((r) => `${r.title}(新 ${r.updateCount} 集)`).join('，') || '（无）'}`)
  // 只断言不随数据变化的性质（真实收藏会变，硬编码部数会变成假失败）
  check('每行都满足 watched < aired 且 updateCount = aired − watched', realRows.every((r) => r.watched < r.aired && r.updateCount === r.aired - r.watched && r.updateCount > 0), true)
  check('已看过最新一集的收藏不会出现在结果里', realSeasonFavorites.every((f) => {
    const p = realAired.get(f.subjectId)
    const w = realWatched.get(f.subjectId) ?? 0
    if (!p || p.aired <= 0 || w < p.aired) return true
    return !realRows.some((r) => r.subjectId === f.subjectId)
  }), true)
  check('结果按最后放送日倒序（不随时间倒退）', realRows.every((r, i) => i === 0 || (realRows[i - 1].lastAirDate ?? '') >= (r.lastAirDate ?? '')), true)
  check('结果里的每部都来自收藏列表（不凭空多出条目）', realRows.every((r) => realFavorites.some((f) => f.subjectId === r.subjectId)), true)
  check('结果里的每部都是**本季**收藏（老番不再混进来，工单的核心要求）', realRows.every((r) => realSeasonFavorites.some((f) => f.subjectId === r.subjectId)), true)
  check('非本季的收藏一定不在结果里', realFavorites.filter((f) => !realSeasonFavorites.includes(f)).every((f) => !realRows.some((r) => r.subjectId === f.subjectId)), true)
}

// ------------------------------------------------------------------
section('5. 界面接线静态检查（读 DashboardPage.tsx）')
{
  const pageSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'pages', 'DashboardPage.tsx'), 'utf8')
  check('订阅番剧更新板块点击直接跳订阅页', /onClick=\{\(\) => navigate\('\/subs'\)\}/.test(pageSrc), true)
  check('不再内联展开订阅名列表（用户要求「不要再展开」）', pageSrc.includes('subUpdateCount > 0 ? (\n            <div className="mt-3 flex flex-wrap gap-1.5">'), false)
  check('收藏番剧更新板块点击打开弹窗', /onClick=\{\(\) => setFavModalOpen\(true\)\}/.test(pageSrc), true)
  check('弹窗标题给出「有更新几部」', pageSrc.includes('有更新 ${favUpdateRows.length} 部'), true)
  check('弹窗每行显示「新 N 集」', pageSrc.includes('新 {row.updateCount} 集'), true)
  check('弹窗每行可进入番剧详情页', /navigate\(`\/subject\/\$\{row\.subjectId\}`\)/.test(pageSrc), true)
  check('判定口径全部来自 lib/favUpdates（页面不自己算）', pageSrc.includes("from '@/lib/favUpdates'") && pageSrc.includes('buildFavUpdateRows('), true)
  check('没有更新时有明确空态', pageSrc.includes("title={favError ? '检测失败' : '暂无更新'}"), true)
  check('旧的 favSubUpdateCount（订阅口径冒充收藏更新）已移除', pageSrc.includes('favSubUpdateCount'), false)
  check('取数用的是与详情页同一份分集接口', pageSrc.includes('api.bangumi.episodeProgress('), true)
  // v0.3.9 后续工单：① 只统计本季收藏 ② 板块不再放口径说明文字
  check('本季筛选用的是收藏页那份判据（@shared/favoritesSeason）', pageSrc.includes("from '@shared/favoritesSeason'") && pageSrc.includes('currentSeasonFavorites('), true)
  check('取数与判定都只喂本季收藏', pageSrc.includes('seasonFavorites.filter(') && pageSrc.includes('favorites: seasonFavorites'), true)
  check('板块已移除口径说明段（下半部分那段解释文字）', pageSrc.includes('收藏更新按 Bangumi 分集数据判定'), false)
  check('板块不再有「有 N 部有更新，点击查看」这类提示文案', pageSrc.includes('部有更新，点击查看'), false)
  check('板块不再有「点击前往订阅页」这类提示文案', pageSrc.includes('点击前往订阅页'), false)
  check('保留必要的状态字（暂无更新 / 正在检测…）', pageSrc.includes('暂无更新') && pageSrc.includes('正在检测…'), true)
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

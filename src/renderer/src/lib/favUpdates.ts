/**
 * 仪表盘「收藏番剧更新」的判定口径（v0.3.9，用户工单）。
 *
 * 用户原话：
 *   「只要检测到 bangumi 提供的番剧信息中（和番剧详情页的数据一样）有我们收藏的番剧更新
 *     就显示有更新几部……如果用户对该番剧最新一集有观看记录则更新记录消失。」
 *
 * v0.3.9 补充（同一轮工单的后续要求）：
 *   「只统计**当前季度**的收藏番剧」—— 上一版把 CLANNAD、无职转生这类老番也算进去了，
 *   用户明确说不对。所以现在先按开播日期筛出「本季（当季）」的收藏，再做下面的更新判定。
 *   季度判据**不是这里另写一套**，用的就是收藏页那一份（`@shared/favoritesSeason`），
 *   见 `isInCurrentSeason` 的注入说明。
 *
 * 为什么把判定单独放在这里（而不是写在页面里）：
 *   1. 口径必须和番剧详情页**同一份数据**——详情页读的是 `api.bangumi.episodeProgress(id)`
 *      （主进程 `/v0/episodes?subject_id=…&type=0`，数 airdate ≤ 今天的集数，6 小时 TTL 缓存），
 *      这里只做「拿到的 aired 与用户已看集数怎么比」，绝不自己按「开播日 + 每周一集」去猜；
 *   2. 纯函数、不依赖 React/DOM，可以直接被 `scripts/verify-favupdates.mjs` import 真实源码跑断言，
 *      口径（尤其「最新一集」怎么算）能被逐条验证，而不是只在界面上肉眼看。
 *
 * ── 「更新」与「消失」的完整口径 ────────────────────────────────────────────
 *   aired        = Bangumi 分集接口里 airdate ≤ 今天 的集数（详情页「更新至 第 N 集」的同一个数字）
 *   watched      = 用户对该番剧**已看到的最高集号**（下面 buildWatchedEpisodeMap 说明来源）
 *   更新集数      = aired − watched     （> 0 才出现在列表里）
 *   消失条件      = watched ≥ aired，即「对该番剧最新一集（第 aired 集）有观看记录」
 *   —— 这两条是同一个条件的两种说法：看过最新一集 → aired − watched ≤ 0 → 自动从列表消失，
 *      不需要额外「已读」状态，用户下次播放到最新一集后再进仪表盘，那一条就不见了。
 */

import type {
  EpisodeProgress,
  FavoriteItem,
  WatchHistoryItem,
  WatchProgressItem
} from '@shared/types'

/**
 * 出现在「收藏番剧更新」里的最低已看集数。
 *
 * 0 = 严格按用户给的规则：**只要没看过最新一集**就算有更新，因此从未看过的老番也会出现
 *     （它确实「有已播出但你没看的集数」）。这是默认值。
 * 1 = 只提示「已经在追」的番剧（看过至少一集），没开始看的收藏不打扰。
 * 两种都是合理产品选择，改这一个数字即可切换；判定与界面文案都会跟着走。
 */
export const FAV_UPDATE_MIN_WATCHED = 0

/** 一部收藏番剧的更新行（列表/弹窗直接渲染这个结构） */
export interface FavUpdateRow {
  subjectId: number
  title: string
  cover: string
  /** 已放送到第几集（详情页同源数据） */
  aired: number
  /** 用户已看到第几集（0 = 没有任何观看记录） */
  watched: number
  /** 已播出但用户还没看的集数，即界面上「新 N 集」 */
  updateCount: number
  /** 已放送的最后一集日期（YYYY-MM-DD），用于排序 */
  lastAirDate: string | null
  /** 下一集放送日期（今天之后最近的一集），界面上「下集 MM-DD」 */
  nextAirDate: string | null
}

/**
 * 本地日历的 YYYY-MM-DD。
 *
 * 为什么不用 toISOString()：主进程判定 aired 时用的是本地日期（接口给的 airdate 就是本地日历上的
 * 放送日），用 UTC 会在 UTC+8 的凌晨把「今天该播的那一集」算成还没播，两端口径就错开一集。
 */
export function localDateString(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 收藏页季度判据的**结构子集**（只取判定「本季」需要的三个字段）。
 *
 * 只要求结构而不是 import `@shared/favoritesSeason` 的类型：本文件必须能被 node 自检脚本
 * 直接 import（`@shared/*` 别名在 node 里解析不了），所以这里不写任何运行时 import。
 */
export interface SeasonBucketLike {
  /** 'season' = 判出了季度（1-3 冬 / 4-6 春 / 7-9 夏 / 10-12 秋）；'month' = 只有年月或未知，未判季度 */
  kind: 'season' | 'month'
  /** 季度序号 1..4（冬/春/夏/秋）；未判季度时为 null */
  season: number | null
  /** 季度所属年份（就是开播年份，v0.3.7 起不再跨年回退）；未判季度时为 null */
  seasonYear: number | null
}

/**
 * 该开播日期是否属于**今天所在的季度**（工单：「只统计当前季度的收藏番剧」）。
 *
 * 季度判据**不在这里实现**：由调用方把收藏页那一份真源码注入进来
 * （渲染层传 `@shared/favoritesSeason` 的 `favoritesSeasonBucket`，自检脚本也注入同一个真源码），
 * 这样「本季」与收藏页左侧季度栏的分组**必然一致**，不会出现两套划分。
 * 连「今天属于哪一季」也用同一个函数算（把今天的日期丢进去），不另写月份→季度的映射。
 *
 * 只有年月（`2026-10`）或日期脏的条目**不算本季**：收藏页对这类条目的既定口径是
 * 「不判季度、按月份如实展示」（见 favoritesSeason.ts 判据 ② 的说明：无法确认它落在哪一季的
 * 播出周期里，可能是季末补档），这里沿用同一条口径，免得出现「收藏页在「10月」组里、
 * 仪表盘却把它算进秋季」这种自相矛盾的显示。
 */
export function isInCurrentSeason(
  airDate: unknown,
  today: string,
  bucketOf: (raw: unknown) => SeasonBucketLike
): boolean {
  const cur = bucketOf(today)
  if (cur.kind !== 'season' || cur.season == null || cur.seasonYear == null) return false
  const b = bucketOf(airDate)
  if (b.kind !== 'season' || b.season == null || b.seasonYear == null) return false
  return b.season === cur.season && b.seasonYear === cur.seasonYear
}

/** 本季收藏（`isInCurrentSeason` 的列表版，供页面直接用） */
export function currentSeasonFavorites<T extends { airDate?: string | null }>(
  favorites: readonly T[],
  today: string,
  bucketOf: (raw: unknown) => SeasonBucketLike
): T[] {
  return (favorites ?? []).filter((f) => isInCurrentSeason(f?.airDate, today, bucketOf))
}

/**
 * 观看进度里 `watched` 集合的键是 `${线路序号}:${集序号}`（见 stores/watchProgress.ts 的 epKey）。
 * 线路只是同一集的镜像线路（第 0/1/2 线路的第 3 集都是第 3 集），所以只取集序号 + 1 = 第几集。
 */
export function episodeFromWatchedKey(key: string): number | null {
  const at = key.lastIndexOf(':')
  if (at < 0) return null
  const idx = Number(key.slice(at + 1))
  if (!Number.isFinite(idx) || idx < 0) return null
  return Math.trunc(idx) + 1
}

/**
 * 「用户已看到第几集」——键是 subjectId，值是最高集号。
 *
 * 数据源（两张表都要看，缺一张就会漏判）：
 *   ① watchProgress（v0.2.4 起）：在线播放记的是播放列表里的集序号 `episodeIndex`（0 起，+1 才是第几集），
 *      另外 `watched[]` 里攒着该番剧**历史看过的每一集**（换集/换线路都会往里加），所以要把两者都取最大，
 *      否则「看过第 12 集、后来点开第 3 集」会被误判成只看到第 3 集；
 *   ② watchHistory（更早版本就在用）：本地播放写的是文件名解析出的集号（主进程 parseEpisode），
 *      同样 1 起算。注意**在线播放写进历史的 episode 恒为 null**（PlayerPage 只对本地模式记集号），
 *      所以只看 watchHistory 会把「在线追番」全部漏掉 —— 这就是必须同时读 watchProgress 的原因。
 *
 * 匹配优先级：subjectId（可靠）→ 标题（站点标题/订阅名与收藏里的 nameCn 常常一致，但不保证，
 * 所以只作为没有 subjectId 时的兜底）。
 *
 * ⚠️ 集号口径：上面两处的集号都是「第几集」的 1 起算值，和 aired 同轴。规则站点的剧集列表若把
 * 特别篇排在正片之前，两者的第 N 集会错位一集——这种情况下界面上会显示成「你已看 N-1 集」，
 * 属于数据源本身的口径差异，不做偏移猜测（猜了反而会在正常站点上出错）。
 */
export function buildWatchedEpisodeMap(
  favorites: FavoriteItem[],
  history: WatchHistoryItem[],
  progress: WatchProgressItem[]
): Map<number, number> {
  const byId = new Map<number, number>()
  const bump = (id: number, ep: number | null | undefined): void => {
    if (ep == null || !Number.isFinite(ep) || ep <= 0) return
    const ep0 = Math.trunc(ep)
    if (ep0 > (byId.get(id) ?? 0)) byId.set(id, ep0)
  }
  const byTitle = new Map<string, number>()
  for (const f of favorites) {
    if (f.nameCn) byTitle.set(f.nameCn.trim(), f.subjectId)
    if (f.name) byTitle.set(f.name.trim(), f.subjectId)
  }
  const resolve = (subjectId: number | undefined, title: string | undefined): number | null => {
    if (subjectId != null && Number.isFinite(subjectId)) return subjectId
    const key = (title ?? '').trim()
    return key ? (byTitle.get(key) ?? null) : null
  }

  for (const p of progress) {
    const id = resolve(p.subjectId, p.title)
    if (id == null) continue
    bump(id, p.episodeIndex + 1)
    for (const key of p.watched ?? []) bump(id, episodeFromWatchedKey(key))
  }
  for (const h of history) {
    const id = resolve(h.subjectId, h.title)
    if (id == null) continue
    bump(id, h.episode)
  }
  return byId
}

/**
 * 是否需要为这部收藏去查分集进度（**纯性能优化，不影响判定结果**）。
 *
 * 仪表盘一进来就要为所有收藏查一遍 aired，主进程虽然 6 小时缓存，但几百部收藏仍会打几百次请求，
 * 所以把「查了也必然没有更新」的三种情况先排除：
 *   ① 手动标记过「已看完」→ 不会再提示更新；
 *   ② 还没开播（air_date 在今天之后）→ aired 必然为 0；
 *   ③ 已看集数 ≥ 计划集数（fav.eps，详情页的「全 N 集」）→ 已播集数不可能超过计划集数，
 *      所以一定没有更新（注意这是**单向前提**：eps 未知时不能据此跳过）。
 */
export function shouldFetchEpisodeProgress(
  fav: FavoriteItem,
  watchedMap: Map<number, number>,
  today: string,
  minWatched: number = FAV_UPDATE_MIN_WATCHED
): boolean {
  if (fav.watchedAt != null) return false
  const airDate = (fav.airDate ?? '').slice(0, 10)
  if (airDate && airDate > today) return false
  const watched = watchedMap.get(fav.subjectId) ?? 0
  if (watched < minWatched) return false
  const eps = fav.eps ?? 0
  if (eps > 0 && watched >= eps) return false
  return true
}

/**
 * 组装「有更新的收藏番剧」列表。
 *
 * @param progressBySubject 主进程分集接口的返回（subjectId → EpisodeProgress | null；null = 取不到）
 * @returns 按「最近更新完的排前面、其次攒得多的排前面」排序；没有更新的番剧不出现在结果里
 */
export function buildFavUpdateRows(input: {
  favorites: FavoriteItem[]
  progressBySubject: ReadonlyMap<number, EpisodeProgress | null>
  watchedMap: Map<number, number>
  minWatched?: number
}): FavUpdateRow[] {
  const { favorites, progressBySubject, watchedMap } = input
  const minWatched = input.minWatched ?? FAV_UPDATE_MIN_WATCHED
  const rows: FavUpdateRow[] = []
  for (const fav of favorites) {
    const p = progressBySubject.get(fav.subjectId)
    // 取不到进度（网络失败/非 bangumi 条目）时按「无更新」处理：宁可不提示，也不编造集数
    if (!p || p.aired <= 0) continue
    const watched = watchedMap.get(fav.subjectId) ?? 0
    if (watched < minWatched) continue
    const updateCount = p.aired - watched
    /*
     * 消失条件（用户明确要求）：watched ≥ aired = 「对该番剧最新一集有观看记录」。
     * 这里不去过滤「已完结」的番剧：用户给的是唯一一条消失规则，而一部刚完结、你还差两集没看的番
     * 恰恰是最需要提示的（它同样满足「没看过最新一集」）。想只看在追的番，把 FAV_UPDATE_MIN_WATCHED 改成 1。
     */
    if (updateCount <= 0) continue
    rows.push({
      subjectId: fav.subjectId,
      title: fav.nameCn || fav.name,
      cover: fav.cover,
      aired: p.aired,
      watched,
      updateCount,
      lastAirDate: p.lastAirDate,
      nextAirDate: p.nextAirDate
    })
  }
  return rows.sort(
    (a, b) =>
      (b.lastAirDate ?? '').localeCompare(a.lastAirDate ?? '') ||
      b.updateCount - a.updateCount ||
      a.title.localeCompare(b.title, 'zh-Hans-CN')
  )
}

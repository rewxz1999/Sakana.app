// ============================================================
// 收藏页「季度导航」的季度/月份归属判据（纯函数，渲染层与自检脚本共用）
// ============================================================
//
// 为什么单独放一个 shared 纯函数文件：
// 1. 收藏页要按「年 → 季度」二级分组并显示每组条数，判据只能有一份，否则数字与列表会漂移；
// 2. 不依赖 React / DOM，`scripts/verify-favorites-season.mjs` 能直接 import **真实源码**跑断言
//    （Node 24 自带 TS 类型擦除），自检结果就是产品代码的真实行为；
// 3. 本文件**刻意不 import** `@shared/season`（保持零依赖，脚本才能直接跑），
//    但两套约定现在**完全一致**：1–3 月 = 冬、4–6 = 春、7–9 = 夏、10–12 = 秋。
//    自检脚本会同时 import 两个文件并断言它们对 1..12 月的判定逐月相同 ——
//    将来谁改歪了，脚本立刻红。
//
// ------------------------------------------------------------------
// ⚠️ v0.3.7 修正（用户指出的错误划分）
// ------------------------------------------------------------------
// 上一版用的是「整体后移一个月」的划分（3/4/5 = 春、6/7/8 = 夏、9/10/11 = 秋、12/1/2 = 冬），
// 还把 1、2 月的番剧算到**上一年**的冬季。用户明确纠正：
//
//     1-3 月为冬季新番，4-6 月为春季新番，7-9 月为夏季新番，10-12 月为秋季新番
//
// 所以现在就是标准的日式四半期，且**不再有跨年回退**：
// 2026-01-10 播出的番剧属于「2026 年冬季」，不是 2025 年冬季。
// 季度顺序也随之一并改成**自然年内的先后顺序**：冬 → 春 → 夏 → 秋
// （原来是 春→夏→秋→冬，在新划分下会让「1 月的番」排到「12 月的番」后面，看着像排错了）。
//
// ------------------------------------------------------------------
// 归属判据（按顺序判定，任一步失败就往下走，绝不抛异常）
// ------------------------------------------------------------------
//  ① 解析出「年 + 月 + 日」三者 → 按月份定季度（表见上）；
//  ② 只解析出「年 + 月」、没有「日」 → **不判季度**，按月份分组（如「7月」）。
//     用户要求：「只有年月、日期缺失、落在季度边界之外的，一律按月份分组显示」——
//     只有年月时无法确认它落在哪一季的播出周期里（可能是季末补档），所以宁可按月份如实展示，
//     也不硬塞进某一季（塞错了用户会以为收藏归类错了）。
//     如果你更希望「2026-07」直接算夏季，把下面 day === null 那个分支删掉即可，其余不用动。
//  ③ 连月份都解析不出来（字段缺失 / 空串 / 非法日期） → 归「未知月份」。
//  脏数据判据：年份必须在 1900..2100、月份必须在 1..12，否则一律当解析不出——
//  脏年份会算出一个「看着像真的」的假季度（例如 "0000-07" 算成 0 年夏季），比不判季度更糟。

/** 季度序号（与 `@shared/season.ts` 一致）：1=冬季 2=春季 3=夏季 4=秋季 */
export type FavoriteSeasonIndex = 1 | 2 | 3 | 4

/** 季度显示名（下标 = 季度序号 - 1） */
export const FAVORITE_SEASON_NAMES: readonly string[] = ['冬季', '春季', '夏季', '秋季']

/** 每个季度覆盖的月份（用于显示提示文案，判据本体在 favoriteSeasonOfMonth） */
const SEASON_MONTHS: Record<FavoriteSeasonIndex, readonly number[]> = {
  1: [1, 2, 3],
  2: [4, 5, 6],
  3: [7, 8, 9],
  4: [10, 11, 12]
}

/** 年份合理范围：超出即视为脏数据（见文件头说明） */
const MIN_YEAR = 1900
const MAX_YEAR = 2100

/** 排序权重：季度占 1–4（冬→春→夏→秋），月份分组排在季度之后，未知月份永远最后 */
const MONTH_ORDER_BASE = 10
const UNKNOWN_MONTH_ORDER = 100

/** 「未知月份」的固定键与文案（界面与自检脚本共用同一份字面量，避免两边写死不一致） */
export const UNKNOWN_MONTH_KEY = 'month:unknown'
export const UNKNOWN_MONTH_LABEL = '未知月份'

/** 解析结果：`day === null` = 只有年月（判据 ②） */
export interface AirDateParts {
  year: number
  month: number
  day: number | null
}

/**
 * 从开播日期字符串里解析出年 / 月 / 日。
 *
 * 支持 Bangumi 历史上出现过的几种写法：
 * `2026-07-05`、`2026-7-5`、`2026/07/05`、`2026.07.05`、`2026年7月5日`、
 * 以及带时间的 ISO（`2026-07-05T12:00:00+09:00`，只取前面的日期部分）。
 * 解析不出（含脏数据）返回 null —— 调用方据此回落到「月份分组 / 未知月份」。
 */
export function parseAirDate(raw: unknown): AirDateParts | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (s.length === 0) return null
  // 年必须 4 位；分隔符允许 - / . 年；「日」可有可无（没有就是只有年月）
  const m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2}))?/.exec(s)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) return null
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  if (m[3] === undefined) return { year, month, day: null }
  const day = Number(m[3])
  // 「日」不合法（0 / 32 / 99）时只丢掉「日」，年月仍然可信 → 落到判据 ②（按月份分组），
  // 而不是把整条记录打成未知：这样脏的只是日，不该把年月一起丢掉。
  if (!Number.isInteger(day) || day < 1 || day > 31) return { year, month, day: null }
  return { year, month, day }
}

/**
 * 月份 → 季度序号。1–3 冬、4–6 春、7–9 夏、10–12 秋（三个月一季，与 `@shared/season.ts` 相同）。
 * ⚠️ 只适用于**已校验过的**月份（1..12）；非法月份会被夹到边界，调用前请先过 parseAirDate。
 */
export function favoriteSeasonOfMonth(month: number): FavoriteSeasonIndex {
  const m = Math.min(12, Math.max(1, Math.trunc(month) || 1))
  return (Math.floor((m - 1) / 3) + 1) as FavoriteSeasonIndex
}

/**
 * 一个分组（季度组或月份组）。
 *
 * `key` 是稳定标识：界面选中的筛选项、Map 的分组键都用它，别用 label（label 会改文案）。
 * ⚠️ 字段描述的是**这一组**，不是单条收藏：所以季度组不带 month（一季跨三个月，写哪个月都是错的），
 * 单条收藏的月份用 parseAirDate 取。
 */
export interface FavoritesSeasonBucket {
  /** 季度组：`season:1`..`season:4`；月份组：`month:7` / `month:unknown` */
  key: string
  /** 界面显示名：冬季 / 7月 / 未知月份 */
  label: string
  kind: 'season' | 'month'
  /** 排序权重（小 → 大）：冬 1 春 2 夏 3 秋 4，月份组 10+月，未知月份 100 */
  order: number
  /** 季度序号（月份组为 null） */
  season: FavoriteSeasonIndex | null
  /** 月份组的月份（1..12）；季度组与未知月份都为 null——要单条收藏的月份请用 parseAirDate 取 */
  month: number | null
  /** 季度**所属年份**（月份组为 null）：就是开播日期的年份，不再跨年回退 */
  seasonYear: number | null
  /** 悬停提示：把判据说清楚，用户不用猜「为什么这条在这一组」 */
  hint: string
}

/** 构造一个季度分组（`FAVORITE_SEASON_BUCKETS` 与逐条归属共用，保证文案一致） */
export function seasonBucketOf(season: FavoriteSeasonIndex, seasonYear: number | null = null): FavoritesSeasonBucket {
  const label = FAVORITE_SEASON_NAMES[season - 1] ?? '未知季'
  const months = SEASON_MONTHS[season].join('/')
  return {
    key: `season:${season}`,
    label,
    kind: 'season',
    order: season,
    season,
    month: null,
    seasonYear,
    hint:
      seasonYear === null
        ? `${label}（${months} 月播出）`
        : `${seasonYear} 年${label}（${months} 月播出）`
  }
}

/** 四个季度分组，恒定存在（顺序 = 冬 → 春 → 夏 → 秋）：季度栏即使某季为 0 也要显示出来 */
export const FAVORITE_SEASON_BUCKETS: readonly FavoritesSeasonBucket[] = (
  [1, 2, 3, 4] as FavoriteSeasonIndex[]
).map((s) => seasonBucketOf(s))

/**
 * 单条收藏的归属（判据本体，见文件头三步）。
 * 入参类型故意放宽成 `unknown`：airDate 可能来自老数据 / 导入数据，什么都可能传进来，这里不崩。
 */
export function favoritesSeasonBucket(raw: unknown): FavoritesSeasonBucket {
  const parts = parseAirDate(raw)
  if (!parts) {
    return {
      key: UNKNOWN_MONTH_KEY,
      label: UNKNOWN_MONTH_LABEL,
      kind: 'month',
      order: UNKNOWN_MONTH_ORDER,
      season: null,
      month: null,
      seasonYear: null,
      hint: '开播日期缺失或无法解析，无法判断属于哪一季'
    }
  }
  if (parts.day === null) {
    return {
      key: `month:${parts.month}`,
      label: `${parts.month}月`,
      kind: 'month',
      order: MONTH_ORDER_BASE + parts.month,
      season: null,
      month: parts.month,
      seasonYear: null,
      hint: `${parts.year} 年 ${parts.month} 月（只有年月，无法确认落在哪一季的播出周期）`
    }
  }
  // 新划分下「年 + 月」直接定季度，年份就是开播年份 —— 1 月的番属于**当年**冬季
  return seasonBucketOf(favoriteSeasonOfMonth(parts.month), parts.year)
}

/** 只要分组键时的快捷入口（筛选比较用，界面别拿它当显示名） */
export function favoritesSeasonKey(raw: unknown): string {
  return favoritesSeasonBucket(raw).key
}

/** 按开播日期做季度归属所需的最小结构（不 import @shared/types，自检脚本才能在 Node 里直接跑） */
export interface AirDateCarrier {
  airDate?: string | null
}

export interface FavoritesSeasonGroup<T> {
  bucket: FavoritesSeasonBucket
  items: T[]
  count: number
}

/**
 * 分组 + 计数（只返回**非空**的分组，按季度顺序 → 月份顺序 → 未知月份排序）。
 * 界面拿它做季度栏的月份分组与「该季多少部」的数字，保证数字就是这一组的条数。
 */
export function groupFavoritesBySeason<T extends AirDateCarrier>(items: readonly T[]): FavoritesSeasonGroup<T>[] {
  const map = new Map<string, FavoritesSeasonGroup<T>>()
  for (const item of items ?? []) {
    const bucket = favoritesSeasonBucket(item?.airDate)
    const found = map.get(bucket.key)
    if (found) {
      found.items.push(item)
      found.count++
      continue
    }
    map.set(bucket.key, { bucket, items: [item], count: 1 })
  }
  return [...map.values()].sort((a, b) => a.bucket.order - b.bucket.order)
}

/** 每个分组键 → 条数（`{ 'season:2': 3, 'month:7': 1, ... }`，只含非空分组） */
export function countFavoritesBySeason<T extends AirDateCarrier>(items: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items ?? []) {
    const key = favoritesSeasonKey(item?.airDate)
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

import type {
  CalendarDay,
  CalendarItem,
  CoverImages,
  Rating,
  SearchResultItem,
  SeasonItem,
  SubjectDetail,
  WeekdayInfo
} from '@shared/types'
import type { JikanAnime } from './jikan'

/**
 * MAL（经 Jikan / AniList）数据 → 本应用数据类型的**唯一映射处**（v0.3.2 新增）。
 *
 * 为什么单独一个文件：兜底链路（搜索 / 番剧表 / 季度列表 / 详情）四处都要做同一件事，
 * 而字段语义两边并不一样（下面每处都写了取舍）。放在这里可以保证：
 *   ① 一处改、四处生效；② 输出**严格符合** `@shared/types` 里的既有类型（不改类型定义）；
 *   ③ 主数据源恢复后，兜底代码可以整块丢掉而不牵连别处。
 *
 * ⚠️ 本文件只做「数据形状」的翻译，**不发任何网络请求**（请求都在 jikan.ts 里统一节流）。
 */

/**
 * 兜底数据的 id 约定：**负 id = `-MAL id`**。
 *
 * 为什么不用正数：本应用里 `id` 是 **Bangumi 条目 id**，MAL id 是完全不同的另一套编号。
 * 若把 MAL id（如 52991）当正数塞进 `SearchResultItem.id` / `CalendarItem.id`：
 *   · 界面点进详情 → 请求 `bangumi.subject(52991)` → 拿到的是**另一部番**（编号撞车）；
 *   · 收藏 / 订阅 / 统计工具会把这个 id 当成 Bangumi 条目存下来，反代恢复后全部指向错的作品。
 * 用负数则有两个好处：
 *   ① 一眼可辨（Bangumi 条目 id 恒为正），任何地方看到负数就知道「这条来自 Jikan 兜底」；
 *   ② `bangumi.subject(id < 0)` 能识别出来并直接走 Jikan 详情（见 bangumi.ts），
 *      所以点开兜底列表里的卡片仍然能进到**正确**的那部番的详情页。
 */
export function jikanFallbackId(malId: number): number {
  const id = Math.trunc(Number(malId) || 0)
  return id > 0 ? -id : 0
}

/** 负 id → MAL id；给的不是兜底 id（正数/0）时返回 null */
export function malIdFromFallbackId(id: number): number | null {
  const n = Math.trunc(Number(id) || 0)
  return n < 0 ? -n : null
}

/**
 * 星期表：`id` 用**本应用的约定 1=周一 … 7=周日**（`@shared/types` 的 WeekdayInfo，
 * 渲染层 `weekdayDate()` 直接拿 `id - 1` 去加天数，所以这个编号不能错）。
 *
 * `en/cn/ja` 三列**照抄主数据源（自建反代 `/calendar`）返回的写法**（实测：
 * `{"en":"Mon","cn":"星期一","ja":"月曜日","id":1}`），这样兜底数据与正常数据在界面上完全一致，
 * 不会出现「反代时显示星期一、兜底时显示周一」这种别扭的差异。
 *
 * ⚠️ 注意 MAL/Jikan 的 `broadcast.day` 是英文名，Jikan 的 /seasons 接口在自家示例里
 * 还用过 `weekday` 0..6（0=周日）—— 那是**另一套编号**，不要混用。
 */
export const WEEKDAYS: WeekdayInfo[] = [
  { id: 1, cn: '星期一', en: 'Mon', ja: '月曜日' },
  { id: 2, cn: '星期二', en: 'Tue', ja: '火曜日' },
  { id: 3, cn: '星期三', en: 'Wed', ja: '水曜日' },
  { id: 4, cn: '星期四', en: 'Thu', ja: '木曜日' },
  { id: 5, cn: '星期五', en: 'Fri', ja: '金曜日' },
  { id: 6, cn: '星期六', en: 'Sat', ja: '土曜日' },
  { id: 7, cn: '星期日', en: 'Sun', ja: '日曜日' }
]

const MAL_DAY_TO_ID: Record<string, number> = {
  mondays: 1,
  tuesdays: 2,
  wednesdays: 3,
  thursdays: 4,
  fridays: 5,
  saturdays: 6,
  sundays: 7
}

/** 兜底里推不出放送星期时统一放进**周日**（见 jikanToCalendarDays 的说明） */
export const FALLBACK_WEEKDAY_ID = 7

/**
 * MAL 的 `broadcast.day`（`Fridays`）→ 本应用 weekday.id（1=周一…7=周日）。
 * 推不出来（MAL 没给 / 值不认识）返回 null，由调用方决定兜到哪一天。
 */
export function malBroadcastDayToWeekdayId(day: string | null | undefined): number | null {
  const key = String(day ?? '').trim().toLowerCase()
  if (!key) return null
  return MAL_DAY_TO_ID[key] ?? null
}

/**
 * AniList 的 `nextAiringEpisode.airingAt`（Unix 秒，UTC）→ 本应用 weekday.id。
 *
 * 为什么要 +9 小时：`airingAt` 是 UTC 时刻，而「放送星期」是**日本电视台**的星期，
 * 直接按 UTC（或本地时区）取星期会把周日深夜的番算到周六，整周的排布就错了。
 * 日本没有夏令时，固定 +9 即可（比查时区库简单且不会错）。
 */
export function anilistAiringAtToWeekdayId(airingAtSec: number | null | undefined): number | null {
  const sec = Number(airingAtSec)
  if (!Number.isFinite(sec) || sec <= 0) return null
  const jst = new Date((sec + 9 * 3600) * 1000)
  const dow = jst.getUTCDay() // 0=周日 … 6=周六
  return dow === 0 ? 7 : dow
}

/**
 * 兜底条目「现在是否在播」。
 *
 * Jikan 给 `airing: boolean`，AniList 给 `status: 'RELEASING'`，两边都要认；
 * 番剧表只列在播的（和 v0.3.0 的 jikanCurrentSeason 过滤口径一致）。
 */
export function isAiringNow(a: JikanAnime): boolean {
  if (a.airing === true) return true
  const s = String(a.status ?? '')
  return s === 'RELEASING' || s === 'Currently Airing'
}

/**
 * 立绘/封面 → `CoverImages`（五个字段都必填，缺一个都不行）。
 *
 * 取舍：MAL 与 AniList 都**只有一档原图**（MAL 的 `image_url` 即原图，AniList 的
 * `coverImage.large` ≈ 460x650），不像 Bangumi 分 s/g/m/l 四档。
 * 所以四个位都指向同一张图 —— 渲染层按 `grid/small` 取时会下载原图，
 * 但应用内的图片缓存按 URL 去重（见 media.ts 的图片协议），不会重复下载，只是首屏字节多一点。
 * 用户要这个数据源的初衷就是「图更清晰」，这里**不做降采样**（宁可大，不要糊）。
 */
export function toCoverImages(a: JikanAnime): CoverImages | null {
  const url = a.images || a.imageMedium || a.imageSmall
  if (!url) return null
  return { common: url, large: url, medium: url, small: url, grid: url }
}

/**
 * 评分 → `Rating`。
 *
 * 取舍：`score` 直接用（MAL 与 AniList 都是 10 分制，AniList 的 100 分制已在 jikan.ts 里除以 10）；
 * `total` 的语义两边不同 —— Bangumi 是「打分数」，MAL 是 `scored_by`（打分人数），
 * AniList 没有打分数、只有 `popularity`（收藏人数）。这里按 `scored_by → popularity → 0` 取，
 * 数量级与 Bangumi 一致（都是「多少人参与」），界面上的展示不会失真。
 */
export function toRating(a: JikanAnime): Rating | null {
  if (a.score == null || !Number.isFinite(Number(a.score))) return null
  return {
    score: Number(a.score),
    total: Number(a.scoredBy ?? 0),
    rank: a.rank != null ? Number(a.rank) : undefined
  }
}

/**
 * 放送日期。
 *
 * 只认 ISO 形式的 `airedFrom`（`2023-09-29T00:00:00+00:00` → `2023-09-29`）：
 * 渲染层会直接 `air_date.slice(0, 10)`（番剧表片尾「开播 xxx」），
 * 而 MAL 的 `aired.string`（`Sep 29, 2023 to Mar 22, 2024`）切出来是乱码一样的半截字符串 ——
 * 宁可给 null（界面不显示开播日），也不要显示错的日期。
 */
export function toAirDate(a: JikanAnime): string | null {
  const iso = String(a.airedFrom ?? '')
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return null
  return iso.slice(0, 10)
}

/** 简介：MAL/AniList 的简介里可能带 `<i>` 之类的内联标签，渲染层是纯文本，这里先剥干净 */
function cleanSummary(raw: string | null | undefined): string {
  const s = String(raw ?? '')
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 类型标签（`genres`）—— MAL/AniList 的主题与人群标签也一并带上，界面上不区分 */
function genresOf(a: JikanAnime): string[] {
  return Array.from(new Set((a.genres ?? []).map((g) => String(g).trim()).filter((g) => g.length > 0)))
}

/**
 * 兜底元数据：v0.3.2 起附加在 `SearchResult` / `CalendarResult` / `SeasonResult` / `SubjectResult` 上。
 *
 * 为什么要有：用户的要求是「让调用方能知道这次是兜底数据」，而这四个类型定义在
 * `@shared/types` 里（本轮不许改）。所以先在主进程侧**运行时**多挂一个字段，
 * 渲染层等类型补上 `dataSource?: JikanFallbackMeta` 后即可直接读：
 *   · 字段缺失 / `source === 'bangumi'` → 主数据源（反代/镜像）；
 *   · `source === 'jikan'` → 本次是兜底数据，界面上要照实提示（例如番剧表底栏加「Jikan 兜底」角标）。
 */
export interface JikanFallbackMeta {
  source: 'bangumi' | 'jikan'
  /** 兜底时用到的端点（按尝试顺序，AniList 的写成 `anilist:...`），排障时一眼看出走的哪条路 */
  endpoints?: string[]
  /** 兜底取数总耗时（毫秒） */
  ms?: number
  /** 兜底成功时为空；失败时是最后的原因（504 / 限流 / 无匹配…） */
  reason?: string
}

/** 给返回对象追加兜底元数据（不改原对象，返回新对象） */
export function withJikanFallback<T extends object>(value: T, meta: JikanFallbackMeta): T & { dataSource: JikanFallbackMeta } {
  return { ...value, dataSource: meta }
}

// ---------------- 各类型的具体映射 ----------------

/** MAL/AniList 条目 → 搜索结果条目（搜索兜底用） */
export function jikanToSearchItem(a: JikanAnime): SearchResultItem {
  return {
    id: jikanFallbackId(a.malId),
    name: a.title,
    // name_cn 允许为空串（Bangumi 的搜索结果也常为空），界面优先显示 name_cn、空了就用 name
    name_cn: a.titleCn,
    images: toCoverImages(a),
    rating: toRating(a),
    air_date: toAirDate(a),
    summary: cleanSummary(a.synopsis)
  }
}

/** MAL/AniList 条目 → 番剧表条目（番剧表兜底用；weekday 由调用方按放送信息给出） */
export function jikanToCalendarItem(a: JikanAnime): CalendarItem {
  return {
    id: jikanFallbackId(a.malId),
    name: a.title,
    name_cn: a.titleCn,
    images: toCoverImages(a),
    rating: toRating(a),
    air_date: toAirDate(a),
    genres: genresOf(a),
    rank: a.rank != null ? Number(a.rank) : undefined
  }
}

/**
 * MAL/AniList 条目 → 番剧表（按星期几分组）。
 *
 * 放送星期的三个来源，按可靠度排序：
 *   ① AniList 的 `nextAiringEpisode.airingAt`（Unix 秒）→ 换算成 JST 星期，**最准**；
 *   ② MAL 的 `broadcast.day`（`Fridays`）；
 *   ③ 都没有 → **放进周日**。
 *
 * 为什么全塞周日而不是「塞进今天」或「另开一个未知分组」：
 *   · `CalendarDay[]` 的结构是固定的 7 天（渲染层按 1..7 找 `weekday.id`，找不到就空），
 *     多出来的分组会被直接丢掉，等于数据消失；
 *   · 塞「今天」会让人误以为它今天更新；
 *   · 周日是习惯上「一周的收尾/无固定档期」的位置，界面文案不会撒谎（用户点开周日能看到它们）。
 *   取舍写在这里，界面上若要把它们标出来，可以按 `dataSource.source === 'jikan'` 加提示。
 */
export function jikanToCalendarDays(items: JikanAnime[]): CalendarDay[] {
  const buckets = new Map<number, CalendarItem[]>()
  for (const w of WEEKDAYS) buckets.set(w.id, [])
  for (const a of items) {
    const id =
      anilistAiringAtToWeekdayId(a.nextAiringAtSec) ??
      malBroadcastDayToWeekdayId(a.broadcastDay) ??
      FALLBACK_WEEKDAY_ID
    buckets.get(id)?.push(jikanToCalendarItem(a))
  }
  // 顺序固定为周一…周日（与渲染层的 1..7 编号一致），空的那天也给出去，界面按「当日暂无番剧」渲染
  return WEEKDAYS.map((weekday) => ({ weekday, items: buckets.get(weekday.id) ?? [] }))
}

/**
 * MAL/AniList 条目 → 季度列表条目。
 *
 * `platform` 直接用 MAL/AniList 的 `type`/`format`（TV / OVA / ONA / Movie / Special…），
 * 取值与 Bangumi v0 的 `platform` 高度重合（界面上是纯展示，不做逻辑判断）。
 */
export function jikanToSeasonItem(a: JikanAnime): SeasonItem {
  return {
    id: jikanFallbackId(a.malId),
    name: a.title,
    name_cn: a.titleCn,
    images: toCoverImages(a),
    rating: toRating(a),
    air_date: toAirDate(a),
    platform: a.type ? String(a.type) : undefined
  }
}

/**
 * MAL/AniList 条目 → 条目详情。
 *
 * 取舍：
 *   · `tags`：Bangumi 的 tags 带 `count`（多少人打了这个标签），MAL/AniList 没有 → `count` 留 undefined；
 *   · `infobox`：用 MAL/AniList 能提供的结构化信息凑出「详细信息」区（类型/集数/放送星期/评分人数/MAL 链接），
 *     不编造「制作公司」「监督」这类我们没有把握的字段；
 *   · `summary`：剥掉内联标签的简介原文（可能不是中文，MAL 的简介本来就只有英文）。
 */
export function jikanToSubjectDetail(a: JikanAnime): SubjectDetail {
  const info: { key: string; value: string }[] = []
  if (a.type) info.push({ key: '类型', value: String(a.type) })
  if (a.episodes != null) info.push({ key: '集数', value: String(a.episodes) })
  if (a.aired) info.push({ key: '放送期间', value: String(a.aired) })
  if (a.broadcastDay) {
    info.push({
      key: '放送星期',
      value: `${a.broadcastDay}${a.broadcastTime ? ` ${a.broadcastTime}（JST）` : ''}`
    })
  }
  if (a.scoredBy != null) info.push({ key: '评分人数', value: String(a.scoredBy) })
  if (a.status) info.push({ key: '状态', value: String(a.status) })
  info.push({ key: '数据来源', value: `MyAnimeList #${a.malId}（经 Jikan/AniList 兜底，非 Bangumi 条目）` })
  return {
    id: jikanFallbackId(a.malId),
    name: a.title,
    name_cn: a.titleCn,
    summary: cleanSummary(a.synopsis),
    air_date: toAirDate(a),
    images: toCoverImages(a),
    rating: toRating(a),
    tags: genresOf(a).map((name) => ({ name })),
    infobox: info,
    eps: a.episodes != null ? Number(a.episodes) : undefined,
    platform: a.type ? String(a.type) : undefined,
    totalEpisodes: a.episodes != null ? Number(a.episodes) : undefined
  }
}

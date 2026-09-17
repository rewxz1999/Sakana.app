// 番剧表「显示范围」筛选（对齐 Kazumi 的 lib/pages/timeline/timeline_options.dart 的三个开关）
//
// 三个开关相互独立、同时生效（AND），默认全关 = 全部显示。
//
// 本应用没有 Kazumi 那套「想看/在看/看过/抛弃」收藏类型，只有「收藏 + 已看完」两种信号，
// 因此这里的状态判定按可用数据映射：
// - watched 已看完：手动标记过 watchedAt，或观看记录覆盖全部集数（直接复用 store 的 isCompleted）
// - watching 在看：已收藏但尚未看完（Kazumi 的「在看」在收藏里就是这个含义）
// - dropped 抛弃：收藏记录上**没有**这个状态；只有外部导入/历史数据带了 droppedAt / listStatus
//   标记时才命中。所以「隐藏已抛弃的番剧」在纯本应用数据下不会隐藏任何条目，界面上有对应说明。

import type { FavoriteItem, ScheduleDisplayFilters, WatchHistoryItem } from '@shared/types'
import { isCompleted } from '@/stores/library'

export type WatchState = 'watched' | 'watching' | 'dropped' | 'none'

export const DEFAULT_SCHEDULE_FILTERS: ScheduleDisplayFilters = {
  hideWatched: false,
  hideDropped: false,
  onlyWatching: false
}

/** 补默认值：旧设置文件没有 scheduleFilters，或只存了其中一部分键 */
export function resolveScheduleFilters(
  raw?: Partial<ScheduleDisplayFilters> | null
): ScheduleDisplayFilters {
  return { ...DEFAULT_SCHEDULE_FILTERS, ...(raw ?? {}) }
}

/** 条目当前的观看状态（subjectId = bangumi 条目 id） */
export function watchStateOf(
  subjectId: number,
  favorites: FavoriteItem[],
  history: WatchHistoryItem[]
): WatchState {
  const fav = favorites.find((f) => f.subjectId === subjectId)
  if (!fav) return 'none'
  if (isCompleted(fav, history)) return 'watched'
  if (isDropped(fav)) return 'dropped'
  return 'watching'
}

/** 「抛弃」标记：本应用不写入该字段，只兼容外部/历史数据 */
function isDropped(fav: FavoriteItem): boolean {
  const extra = fav as FavoriteItem & { droppedAt?: number | null; listStatus?: string | null }
  if (extra.droppedAt) return true
  return extra.listStatus === 'dropped' || extra.listStatus === 'abandoned'
}

/** 该状态的条目是否应当显示（三开关全关时恒为 true） */
export function passesDisplayFilters(state: WatchState, f: ScheduleDisplayFilters): boolean {
  if (f.onlyWatching && state !== 'watching') return false
  if (f.hideWatched && state === 'watched') return false
  if (f.hideDropped && state === 'dropped') return false
  return true
}

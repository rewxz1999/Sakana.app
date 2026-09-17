// ============================================================
// 新番季（季度）约定的**唯一定义处**（主进程 / 渲染层共用）
// ============================================================

/**
 * ⚠️ 季节划分约定（用户指定，与 Bangumi「1 月 = 冬番」一致）：
 *
 *   1–3 月 = 冬 · 4–6 月 = 春 · 7–9 月 = 夏 · 10–12 月 = 秋
 *   顺序 冬 → 春 → 夏 → 秋（即日式 1 / 4 / 7 / 10 月クール的常见中文译法）
 *
 * 所以「月份 → 季度序号」就是 `floor((month - 1) / 3)`，序号 1..4 依次对应 冬/春/夏/秋。
 *
 * 主进程按季度取数并缓存（缓存键 `season-<年>-<季度序号>`），
 * 渲染层按同一套约定渲染「2026年 春季新番」与「预览2026年春」。
 * 两端共用本文件，避免**季节文案**与**实际取数月份范围**漂移。
 */
export const SEASON_NAMES = ['冬', '春', '夏', '秋'] as const

/** 季度序号（1..4，依次 冬/春/夏/秋） */
export type SeasonIndex = 1 | 2 | 3 | 4

/** 月份（1..12）→ 季度序号（1..4） */
export function seasonIndexOfMonth(month: number): SeasonIndex {
  const m = Math.min(12, Math.max(1, Math.trunc(month) || 1))
  return (Math.floor((m - 1) / 3) + 1) as SeasonIndex
}

/** 季度序号 → 该季度的三个月份（升序），如 春 → [4, 5, 6] */
export function monthsOfSeason(season: number): number[] {
  const s = Math.min(4, Math.max(1, Math.trunc(season) || 1))
  const first = (s - 1) * 3 + 1
  return [first, first + 1, first + 2]
}

/** 某个时刻属于哪一季 */
export function seasonOfDate(d: Date = new Date()): { year: number; season: SeasonIndex } {
  return { year: d.getFullYear(), season: seasonIndexOfMonth(d.getMonth() + 1) }
}

/**
 * 绝对季序：把「年 + 季度」压成一个可比较、可加减的整数。
 * 例：2026 年 春（季度序号 2）→ 2026 * 4 + 1 = 8105，下一个季度就是 8106。
 */
export function absoluteSeasonIndex(year: number, season: number): number {
  const s = Math.min(4, Math.max(1, Math.trunc(season) || 1))
  return Math.trunc(year) * 4 + (s - 1)
}

/** 绝对季序 → { 年, 季度序号 }（绝对季序为负或被篡改时也不会得到非法月份） */
export function fromAbsoluteSeasonIndex(abs: number): { year: number; season: SeasonIndex } {
  const a = Math.trunc(abs)
  const year = Math.floor(a / 4)
  return { year, season: ((a - year * 4) + 1) as SeasonIndex }
}

/** 绝对季序偏移若干季 */
export function shiftAbsoluteSeasonIndex(abs: number, delta: number): number {
  return Math.trunc(abs) + Math.trunc(delta)
}

/** 顶部/弹窗标题用的完整文案：`2026年 春季新番` */
export function seasonLabel(year: number, season: number): string {
  const s = Math.min(4, Math.max(1, Math.trunc(season) || 1))
  return `${Math.trunc(year)}年 ${SEASON_NAMES[s - 1]}季新番`
}

/** 按钮用的短文案：`2026年春` */
export function seasonShortLabel(year: number, season: number): string {
  const s = Math.min(4, Math.max(1, Math.trunc(season) || 1))
  return `${Math.trunc(year)}年${SEASON_NAMES[s - 1]}`
}

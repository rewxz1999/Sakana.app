import { create } from 'zustand'
import type { CalendarDay, SourceError } from '@shared/types'
import { api } from '@/lib/api'

interface ScheduleState {
  days: CalendarDay[]
  loading: boolean
  error: SourceError | null
  fetchedAt: number | null
  fromCache: boolean
  stale: boolean
  selectedDay: number // 1-7
  weekOffset: number
  ratings: Record<number, { score: number | null; total: number }>
  load: (force?: boolean) => Promise<void>
  loadRatings: (ids: number[]) => Promise<void>
  selectDay: (day: number) => void
  shiftWeek: (delta: number) => void
}

export const useSchedule = create<ScheduleState>((set, get) => ({
  days: [],
  loading: false,
  error: null,
  fetchedAt: null,
  fromCache: false,
  stale: false,
  ratings: {},
  selectedDay: (() => {
    const d = new Date().getDay()
    return d === 0 ? 7 : d
  })(),
  weekOffset: 0,
  load: async (force = false) => {
    if (get().loading) return
    set({ loading: true })
    const r = await api.bangumi.calendar(force)
    if (r.ok) {
      set({
        days: r.data.days,
        error: r.data.error ?? null,
        fetchedAt: r.data.fetchedAt,
        fromCache: r.data.fromCache,
        stale: !!r.data.stale,
        loading: false
      })
      /*
       * 只补「没有评分」的条目（v0.2.7）。
       *
       * 过去这里把整周 111 个 id 全部丢给评分补全 → 主进程会对每个 id 单独请求一次条目接口。
       * 换了自建反代之后，这一波并发会把反代打到 503，表现就是「很多番剧详情加载不出来」。
       * 而放送数据本身**已经带评分**（反代返回的 104/111 条都带 score），根本不需要补。
       */
      const missingIds = r.data.days
        .flatMap((d) => d.items)
        .filter((i) => !i.rating || i.rating.score == null)
        .map((i) => i.id)
      if (missingIds.length > 0) void get().loadRatings(missingIds)
    } else {
      set({
        error: { kind: 'NETWORK', message: r.error, tried: [] },
        loading: false
      })
    }
  },
  selectDay: (day) => set({ selectedDay: day }),
  loadRatings: async (ids) => {
    const { ratings } = get()
    const missing = ids.filter((id) => !(id in ratings))
    if (missing.length === 0) return
    const r = await api.bangumi.ratings(missing)
    if (r.ok) {
      set((s) => ({ ratings: { ...s.ratings, ...r.data } }))
    }
  },
  shiftWeek: (delta) => set((s) => ({ weekOffset: Math.max(-4, Math.min(4, s.weekOffset + delta)) }))
}))

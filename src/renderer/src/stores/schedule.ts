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
      // 一次性预取整周评分：切换星期时不再发起请求，UI 切换更流畅
      const allIds = r.data.days.flatMap((d) => d.items.map((i) => i.id))
      if (allIds.length > 0) void get().loadRatings(allIds)
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

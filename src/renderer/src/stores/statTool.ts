import { create } from 'zustand'
import type { FavoriteItem, StatEntry, StatList, StatToolData } from '@shared/types'
import { api } from '@/lib/api'

const EMPTY: StatToolData = { lists: [], entries: [] }

/** 放送年份：取 airDate 前 4 位，未知用 '0000'（用于 seq 分组） */
function yearOf(airDate: string | null): string {
  return airDate?.slice(0, 4) ?? '0000'
}

/** 收藏条目上可能存在手动标记的看完时间（watchedAt，字符串或时间戳） */
function favWatchedAt(f: FavoriteItem): string | null {
  const v = (f as FavoriteItem & { watchedAt?: unknown }).watchedAt
  if (v == null) return null
  if (typeof v === 'number') {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) {
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${d.getFullYear()}-${m}-${day}`
    }
    return null
  }
  const s = String(v).trim()
  return s !== '' ? s : null
}

interface StatToolState {
  data: StatToolData | null
  loaded: boolean
  selectedListId: string | null
  load: () => Promise<void>
  persist: (next: StatToolData) => void
  selectList: (id: string) => void
  createList: (name: string) => void
  deleteList: (id: string) => void
  addEntry: (listId: string, favorite: FavoriteItem) => boolean
  updateEntry: (id: string, patch: Partial<StatEntry>) => void
  removeEntry: (id: string) => void
}

export const useStatTool = create<StatToolState>((set, get) => ({
  data: null,
  loaded: false,
  selectedListId: null,
  load: async () => {
    const r = await api.store.get('statTool')
    let data: StatToolData = EMPTY
    if (r.ok && r.data && typeof r.data === 'object') {
      const d = r.data as Partial<StatToolData>
      data = {
        lists: Array.isArray(d.lists) ? (d.lists as StatList[]) : [],
        // 旧版 reviews[0/1] 迁移为 initialReview / finalReview
        entries: (Array.isArray(d.entries) ? (d.entries as StatEntry[]) : []).map((e) => ({
          ...e,
          initialReview: e.initialReview ?? e.reviews?.[0] ?? '',
          finalReview: e.finalReview ?? e.reviews?.[1] ?? ''
        }))
      }
    }
    set({ data, loaded: true, selectedListId: data.lists[0]?.id ?? null })
  },
  persist: (next) => {
    set({ data: next })
    void api.store.set('statTool', next)
  },
  selectList: (id) => set({ selectedListId: id }),
  createList: (name) => {
    const { data } = get()
    if (!data) return
    const list: StatList = {
      id: crypto.randomUUID(),
      name: name.trim() || '未命名列表',
      createdAt: Date.now()
    }
    get().persist({ ...data, lists: [...data.lists, list] })
    set({ selectedListId: list.id })
  },
  deleteList: (id) => {
    const { data, selectedListId } = get()
    if (!data) return
    const next: StatToolData = {
      lists: data.lists.filter((l) => l.id !== id),
      entries: data.entries.filter((e) => e.listId !== id)
    }
    get().persist(next)
    if (selectedListId === id) set({ selectedListId: next.lists[0]?.id ?? null })
  },
  addEntry: (listId, favorite) => {
    const { data } = get()
    if (!data) return false
    // 同一列表内去重
    if (data.entries.some((e) => e.listId === listId && e.subjectId === favorite.subjectId)) {
      return false
    }
    const year = yearOf(favorite.airDate)
    const order =
      data.entries
        .filter((e) => e.listId === listId && yearOf(e.airDate) === year)
        .reduce((m, e) => Math.max(m, e.order), 0) + 1
    const entry: StatEntry = {
      id: crypto.randomUUID(),
      listId,
      subjectId: favorite.subjectId,
      seq: `${year}${String(order).padStart(2, '0')}`,
      name: favorite.name,
      nameCn: favorite.nameCn,
      cover: favorite.cover,
      airDate: favorite.airDate,
      watchedAt: favWatchedAt(favorite),
      personalRating: null,
      bgmRating: favorite.rating,
      photos: [],
      reviews: [],
      initialReview: '',
      finalReview: '',
      order
    }
    get().persist({ ...data, entries: [...data.entries, entry] })
    return true
  },
  updateEntry: (id, patch) => {
    const { data } = get()
    if (!data) return
    const next = {
      ...data,
      entries: data.entries.map((e) => (e.id === id ? { ...e, ...patch } : e))
    }
    get().persist(next)
  },
  removeEntry: (id) => {
    const { data } = get()
    if (!data) return
    get().persist({ ...data, entries: data.entries.filter((e) => e.id !== id) })
  }
}))

import { create } from 'zustand'
import type {
  FavoriteItem,
  SubHistoryItem,
  WatchHistoryItem
} from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'

export type FavoriteSubjectInput = {
  id: number
  name: string
  name_cn: string
  images: { large: string } | null
  rating: { score: number | null } | null
  air_date: string | null
  genres?: string[]
}

export function toFavorite(subject: FavoriteSubjectInput): FavoriteItem {
  return {
    subjectId: subject.id,
    name: subject.name,
    nameCn: subject.name_cn || subject.name,
    cover: subject.images?.large ?? '',
    rating: subject.rating?.score ?? null,
    airDate: subject.air_date ?? null,
    genres: subject.genres ?? [],
    addedAt: Date.now()
  }
}

export function isFavorite(favorites: FavoriteItem[], id: number): boolean {
  return favorites.some((f) => f.subjectId === id)
}

interface LibraryState {
  favorites: FavoriteItem[]
  keyConcerns: number[]
  watchHistory: WatchHistoryItem[]
  subHistory: SubHistoryItem[]
  loaded: boolean
  enriched: boolean // 本会话是否已做过详情补全
  load: () => Promise<void>
  toggleFavorite: (subject: FavoriteSubjectInput) => void
  removeFavorite: (subjectId: number) => void
  toggleKeyConcern: (subjectId: number) => void
  removeKeyConcern: (subjectId: number) => void
  addWatch: (entry: Omit<WatchHistoryItem, 'id'>) => void
  addSubHistory: (kind: SubHistoryItem['kind'], title: string, detail: string) => void
  toggleWatched: (subjectId: number) => void
  setWatchedAt: (subjectId: number, watchedAt: number | null) => void
  enrichFavorites: () => Promise<void>
  /** v0.3.7：只刷新收藏条目的评分/评分人数（评分每天在动，收藏卡上的分数不能一年不动） */
  refreshFavoriteRatings: () => Promise<void>
}

/** 已看完判定：手动标记过，或观看记录覆盖全部集数 */
export function isCompleted(fav: FavoriteItem, history: WatchHistoryItem[]): boolean {
  if (fav.watchedAt) return true
  if (fav.eps && fav.eps > 0) {
    const eps = new Set<number>()
    for (const h of history) {
      if (h.subjectId === fav.subjectId && h.episode != null) eps.add(h.episode)
    }
    return eps.size >= fav.eps
  }
  return false
}

export const useLibrary = create<LibraryState>((set, get) => ({
  favorites: [],
  keyConcerns: [],
  watchHistory: [],
  subHistory: [],
  loaded: false,
  enriched: false,
  load: async () => {
    const [f, k, w, s] = await Promise.all([
      api.store.get('favorites'),
      api.store.get('keyConcerns'),
      api.store.get('watchHistory'),
      api.store.get('subHistory')
    ])
    set({
      favorites: f.ok && Array.isArray(f.data) ? (f.data as FavoriteItem[]) : [],
      keyConcerns: k.ok && Array.isArray(k.data) ? (k.data as number[]) : [],
      watchHistory: w.ok && Array.isArray(w.data) ? (w.data as WatchHistoryItem[]) : [],
      subHistory: s.ok && Array.isArray(s.data) ? (s.data as SubHistoryItem[]) : [],
      loaded: true
    })
    // 后台补全缺失的放送年份/类型/评分/集数（修复「当年番剧被判为未知年份」）
    void get().enrichFavorites()
  },
  enrichFavorites: async () => {
    if (get().enriched) return
    set({ enriched: true })
    const favorites = get().favorites
    /*
     * 先把评分这条**独立**的活干完（v0.3.7）：它面对所有收藏，不受下面「只补缺字段」的限制。
     * 放在前面是因为它更便宜（主进程 6 小时缓存，通常一次网络都不发）。
     */
    void get().refreshFavoriteRatings()
    const missing = favorites.filter((f) => !f.airDate || f.eps == null)
    if (missing.length === 0) return
    const update = async (fav: FavoriteItem): Promise<void> => {
      const r = await api.bangumi.subject(fav.subjectId)
      if (!r.ok || !r.data.data) return
      const d = r.data.data
      const next = { ...fav }
      if (!next.airDate && d.air_date) next.airDate = d.air_date
      if (next.rating == null && d.rating?.score) next.rating = d.rating.score
      if (next.genres.length === 0 && d.tags.length > 0) next.genres = d.tags.slice(0, 8).map((t) => t.name)
      if (next.eps == null) next.eps = d.eps ?? null
      const list = get().favorites.map((x) => (x.subjectId === fav.subjectId ? next : x))
      set({ favorites: list })
      void api.store.set('favorites', list)
    }
    // 并发 3，仅补全缺失条目
    let i = 0
    const workers = Array.from({ length: Math.min(3, missing.length) }, async () => {
      while (i < missing.length) {
        const fav = missing[i++]
        try {
          await update(fav)
        } catch {
          /* 忽略单条失败 */
        }
      }
    })
    await Promise.all(workers)
  },
  /**
   * 只刷新收藏条目的评分（v0.3.7）。
   *
   * 为什么单独做一件事：原来的补全逻辑只处理「缺字段」的条目
   * （`next.rating == null` 才写入），于是一条**已经有评分**的收藏永远不会再更新 ——
   * 用户看着收藏列表里半年前的分数，就是「评分更新不及时」。
   * 这里走 `api.bangumi.ratings`（主进程 6 小时 TTL，命中缓存时零请求），
   * 只有在分数真的变了才写回 store，避免无意义的状态刷新与写盘。
   */
  refreshFavoriteRatings: async () => {
    const favorites = get().favorites
    const ids = favorites.map((f) => f.subjectId).filter((id) => id > 0)
    if (ids.length === 0) return
    const r = await api.bangumi.ratings(ids)
    if (!r.ok) return
    const byId = r.data
    let changed = false
    const next = favorites.map((f) => {
      const score = byId[f.subjectId]?.score
      if (score == null || score === f.rating) return f
      changed = true
      return { ...f, rating: score }
    })
    if (!changed) return
    set({ favorites: next })
    void api.store.set('favorites', next)
  },
  toggleFavorite: (subject) => {
    const { favorites } = get()
    /*
     * v0.3.2：备用数据源（Jikan/AniList 兜底）的条目 id 是**负数**（= -MAL id）。
     * 收藏它只会存下一条反代恢复后对不上的记录（id 正负两套体系），
     * 所以这里直接拦住并说清原因，而不是让用户攒下一堆莫名其妙的收藏。
     */
    if (subject.id < 0) {
      toast.warn('这条来自备用数据源（Jikan / AniList 兜底），等数据源恢复后再收藏')
      return
    }
    const exists = isFavorite(favorites, subject.id)
    let next: FavoriteItem[]
    if (exists) {
      next = favorites.filter((f) => f.subjectId !== subject.id)
      void api.store.set('favorites', next)
      set({ favorites: next })
    } else {
      next = [...favorites, toFavorite(subject)]
      void api.store.set('favorites', next)
      set({ favorites: next })
    }
  },
  removeFavorite: (subjectId) => {
    const next = get().favorites.filter((f) => f.subjectId !== subjectId)
    set({ favorites: next })
    void api.store.set('favorites', next)
  },
  toggleKeyConcern: (subjectId) => {
    const { keyConcerns } = get()
    const next = keyConcerns.includes(subjectId)
      ? keyConcerns.filter((id) => id !== subjectId)
      : [...keyConcerns, subjectId]
    set({ keyConcerns: next })
    void api.store.set('keyConcerns', next)
  },
  removeKeyConcern: (subjectId) => {
    const next = get().keyConcerns.filter((id) => id !== subjectId)
    set({ keyConcerns: next })
    void api.store.set('keyConcerns', next)
  },
  addWatch: (entry) => {
    const next = [
      { ...entry, id: crypto.randomUUID() },
      ...get().watchHistory
    ].slice(0, 1000)
    set({ watchHistory: next })
    void api.store.set('watchHistory', next)
  },
  addSubHistory: (kind, title, detail) => {
    const next = [
      { id: crypto.randomUUID(), kind, title, detail, at: Date.now() },
      ...get().subHistory
    ].slice(0, 500)
    set({ subHistory: next })
    void api.store.set('subHistory', next)
  },
  toggleWatched: (subjectId) => {
    const favorites = get().favorites
    const fav = favorites.find((f) => f.subjectId === subjectId)
    if (!fav) return
    const next = favorites.map((f) =>
      f.subjectId === subjectId ? { ...f, watchedAt: f.watchedAt ? null : Date.now() } : f
    )
    set({ favorites: next })
    void api.store.set('favorites', next)
  },
  setWatchedAt: (subjectId, watchedAt) => {
    const next = get().favorites.map((f) =>
      f.subjectId === subjectId ? { ...f, watchedAt } : f
    )
    set({ favorites: next })
    void api.store.set('favorites', next)
  }
}))

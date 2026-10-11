import { create } from 'zustand'
import type {
  FavoriteItem,
  SubHistoryItem,
  WatchHistoryItem,
  WatchProgressItem
} from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { useWatchProgress } from '@/stores/watchProgress'

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
  /**
   * 「每个条目看过哪些集」的长期聚合（v0.3.9 体检 H4/M7）。
   *
   * 为什么要单独存一份：`isCompleted()` 以前只看 `watchHistory`，而历史是**流水**且只有 1000 条上限
   * （手机端同步合并回来的记录也算在里面）。重度用户看过几百集之后，最早的记录会被挤掉，
   * 于是「已看完」的番会**自己变回未看完** —— 收藏页徽标、番剧表的"只看在看"筛选跟着一起乱。
   * 这里按 subjectId 聚合集号、不受流水条数限制；`watchHistory` 仍然只当"最近观看"用。
   */
  watchedEps: Record<number, number[]>
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

/**
 * 已看完判定：手动标记过，或观看记录覆盖全部集数。
 *
 * ⚠️ v0.3.9：集号来源 = `watchHistory`（当前这份，参数传入）**并上**持久化的聚合 `watchedEps`。
 * 只看前者会在历史被截断（上限 1000 条）后把"已看完"判成"没看完"；
 * 后者是长期聚合，二者取并集即可，代价只是多一次对象查表。
 * 直接读 store 而不改签名，是为了不动四个调用点（它们都已经订阅了 watchHistory，
 * 而聚合与历史在 `addWatch` 里是同步更新的，所以重渲染时机不会有问题）。
 */
export function isCompleted(fav: FavoriteItem, history: WatchHistoryItem[]): boolean {
  if (fav.watchedAt) return true
  if (fav.eps && fav.eps > 0) {
    const eps = new Set<number>()
    for (const h of history) {
      if (h.subjectId === fav.subjectId && h.episode != null) eps.add(h.episode)
    }
    // 并上长期聚合（见 watchedEps 的说明）：历史被截断也不会丢掉"看过哪些集"
    for (const ep of useLibrary.getState().watchedEps[fav.subjectId] ?? []) eps.add(ep)
    /*
     * 再并上**当前**的观看进度（v0.3.9 体检 H4/M7 的关键一步）：
     * 在线播放写进 watchHistory 的 episode 恒为 null，真正的集号在 watchProgress 里
     * （`watched: ["0:0"]`）。以前"已看完"只看历史 → 在线看的番**永远判不出已看完**；
     * 而卡片上"观看到第 N 集"用的是 watchProgress → 同一张卡上两个结论互相打脸。
     */
    for (const ep of watchedEpsFromProgress(fav.subjectId)) eps.add(ep)
    return eps.size >= fav.eps
  }
  return false
}

/**
 * 从观看历史流水 + 观看进度推出「每个条目看过哪些集」（v0.3.9 体检 H4 的首次迁移用）。
 * 只在本地没有聚合数据时跑一次；之后由 `addWatch` 与 `isCompleted` 的实时读取继续兜着。
 *
 * ⚠️ 两个来源都要用：`watchHistory` 里**在线播放的 episode 恒为 null**（只有本地播放才写集号），
 * 真正带集号的是 `watchProgress`（`watched: ["0:0"]`，键为 `组:集序号`，对外集号 = 序号 + 1）。
 */
function deriveWatchedEps(
  history: WatchHistoryItem[],
  progress: WatchProgressItem[]
): Record<number, number[]> {
  const map: Record<number, number[]> = {}
  const add = (sid: number, ep: number): void => {
    const list = map[sid] ?? (map[sid] = [])
    if (!list.includes(ep)) list.push(ep)
  }
  for (const h of history) {
    if (h.subjectId == null || h.episode == null) continue
    add(h.subjectId, h.episode)
  }
  for (const p of progress) {
    if (p.subjectId == null) continue
    for (const ep of episodesOfProgress(p)) add(p.subjectId, ep)
  }
  for (const key of Object.keys(map)) map[Number(key)].sort((a, b) => a - b)
  return map
}

/** 一条进度记录里"看过哪些集"（`watched` 的键是 `组:集序号`，对外集号从 1 起算） */
function episodesOfProgress(p: WatchProgressItem): number[] {
  const out: number[] = []
  for (const key of p.watched ?? []) {
    const idx = Number(String(key).split(':')[1])
    if (Number.isFinite(idx)) out.push(idx + 1)
  }
  return out
}

/** 从当前进度库里取某个条目"看过哪些集"（进度库本身有 300 条上限，所以只当实时来源之一） */
function watchedEpsFromProgress(subjectId: number): number[] {
  const out: number[] = []
  for (const p of useWatchProgress.getState().items) {
    if (p.subjectId !== subjectId) continue
    out.push(...episodesOfProgress(p))
  }
  return out
}

/**
 * 是否已经订阅过"库数据被主进程改过"的通知（v0.3.8）。
 * 放在模块作用域而不是 store 里：它是**进程级只订阅一次**的副作用，不是界面状态。
 */
let storeSubscribed = false

export const useLibrary = create<LibraryState>((set, get) => ({
  favorites: [],
  keyConcerns: [],
  watchHistory: [],
  subHistory: [],
  watchedEps: {},
  loaded: false,
  enriched: false,
  load: async () => {
    /*
     * v0.3.8：主进程（手机端把观看历史推回来时）会广播一次 ev:library，这里必须跟着重新读。
     *
     * 为什么非读不可：这份 watchHistory 是**整份缓存在渲染层、整份写回磁盘**的
     * （见下面 addWatch → api.store.set('watchHistory', next)）。主进程那边合并进来的手机端记录
     * 如果不同步到这份缓存，用户下一次在本机看番时就会用旧数组把它整段覆盖掉 ——
     * 表现是"手机同步过来的历史过一会儿自己没了"。
     *
     * 用模块级标志保证只订阅一次：load() 在启动流程里可能被调用多次（严格模式/热更新）。
     */
    if (!storeSubscribed) {
      storeSubscribed = true
      api.store.onChanged(() => void get().load())
    }
    const [f, k, w, s, we, wp] = await Promise.all([
      api.store.get('favorites'),
      api.store.get('keyConcerns'),
      api.store.get('watchHistory'),
      api.store.get('subHistory'),
      api.store.get('watchedEps'),
      // 迁移要用它里面的真实集号（在线播放的历史里 episode 是 null，见 deriveWatchedEps）
      api.store.get('watchProgress')
    ])
    const history = w.ok && Array.isArray(w.data) ? (w.data as WatchHistoryItem[]) : []
    const progress = wp.ok && Array.isArray(wp.data) ? (wp.data as WatchProgressItem[]) : []
    /*
     * 聚合的读取与迁移（v0.3.9 体检 H4）：老用户盘上没有 watchedEps，就用**历史 + 观看进度**推一份出来
     * （在线播放的集号只在进度里，所以两个来源都要），之后由 addWatch 持续累加。
     */
    const storedEps = we.ok && we.data && typeof we.data === 'object' ? (we.data as Record<number, number[]>) : null
    const watchedEps =
      storedEps && Object.keys(storedEps).length > 0 ? storedEps : deriveWatchedEps(history, progress)
    if (!storedEps || Object.keys(storedEps).length === 0) void api.store.set('watchedEps', watchedEps)
    set({
      favorites: f.ok && Array.isArray(f.data) ? (f.data as FavoriteItem[]) : [],
      keyConcerns: k.ok && Array.isArray(k.data) ? (k.data as number[]) : [],
      watchHistory: history,
      subHistory: s.ok && Array.isArray(s.data) ? (s.data as SubHistoryItem[]) : [],
      watchedEps,
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
    /*
     * 同步更新"看过哪些集"的长期聚合（v0.3.9 体检 H4）。
     * 为什么和流水一起写：历史会在 1000 条处截断，聚合不能跟着丢；
     * 只在有 subjectId 与集号时记（本地文件、没有条目归属的记录记了也没用）。
     */
    const sid = entry.subjectId
    if (sid != null && entry.episode != null) {
      const cur = get().watchedEps[sid] ?? []
      if (!cur.includes(entry.episode)) {
        const merged = { ...get().watchedEps, [sid]: [...cur, entry.episode].sort((a, b) => a - b) }
        set({ watchedEps: merged })
        void api.store.set('watchedEps', merged)
      }
    }
  },
  addSubHistory: (kind, title, detail) => {
    /*
     * ⚠️ 必须先读一次磁盘再合并（v0.3.9 体检 H2）。
     *
     * `subHistory` 有**两个写入方**：主进程（订阅 / 订阅并下载这些动作，见 ipc.ts 的 addSubHistory）
     * 与渲染层（取消订阅 / 确认下载走这里）。渲染层以前拿"本窗口启动那份快照"整份回写，
     * 于是「先订阅（主进程写一条）→ 不重启就取消订阅（渲染层用旧快照覆盖）」会把刚记的那条吃掉，
     * 表现是订阅历史时多时少、缺条目。
     * 读-合并-写把丢失概率压到极低；彻底的做法是把 subHistory 也收归主进程单写（记为后续项）。
     */
    const entry = { id: crypto.randomUUID(), kind, title, detail, at: Date.now() }
    const optimistic = [entry, ...get().subHistory].slice(0, 500)
    set({ subHistory: optimistic })
    void api.store.get('subHistory').then((cur) => {
      const base = cur.ok && Array.isArray(cur.data) ? (cur.data as SubHistoryItem[]) : get().subHistory
      const next = [entry, ...base.filter((x) => x.id !== entry.id)].slice(0, 500)
      set({ subHistory: next })
      void api.store.set('subHistory', next)
    })
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

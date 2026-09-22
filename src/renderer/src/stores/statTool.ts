import { create } from 'zustand'
import type {
  FavoriteItem,
  SeasonItem,
  StatAction,
  StatAddItem,
  StatEntry,
  StatEntryPatch,
  StatToolData
} from '@shared/types'
import { seasonOfDate } from '@shared/season'
import { api } from '@/lib/api'

/**
 * 统计工具 store（v0.2）。
 *
 * 写入路径彻底改了：渲染层**不再**把整个数组写回 store（多窗口会互相覆盖），
 * 改为发一个 `StatAction` 给主进程，主进程读-改-写后广播 `ev:stat`。
 * 这里只保留「本地乐观更新 + 等广播确认」：
 * - 乐观：动作发出后立刻按动作内容改本地状态，界面不卡顿；
 * - 收敛：主进程回传/广播的数据只在 `revision >= 已确认的 revision` 时采纳，
 *   连按两次置顶之类的乱序广播不会把界面打回旧状态。
 */

const EMPTY: StatToolData = { lists: [], entries: [], revision: 0 }

/**
 * 把主进程返回的数据收窄成本地形态。
 *
 * 注意这里是**显式补齐**而不是直接用返回值：跨 IPC 的对象是结构化克隆的结果，
 * 字段缺失（老版本主进程 / 极端情况下）会让界面读到 undefined 后崩在 `.length` 上。
 */
function normalizeIncoming(raw: StatToolData | null | undefined): StatToolData {
  if (!raw) return EMPTY
  return {
    lists: Array.isArray(raw.lists) ? raw.lists : [],
    entries: (Array.isArray(raw.entries) ? raw.entries : []).map((e) => ({
      ...e,
      genres: Array.isArray(e.genres) ? e.genres : [],
      photos: Array.isArray(e.photos) ? e.photos : [],
      reviews: Array.isArray(e.reviews) ? e.reviews : []
    })),
    revision: Number(raw.revision ?? 0) || 0
  }
}

/** 已确认（主进程回传或广播）的最大修订号 */
let ackRevision = -1
/** 广播只订阅一次（load 可能被多个页面重复调用，重复订阅会让回调叠加） */
let subscribed = false

interface StatToolState {
  data: StatToolData
  loaded: boolean
  /** 置顶列表浮动在最前；同置顶状态内按创建时间升序 */
  selectedListId: string | null
  load: () => Promise<void>
  /** 内部：采纳主进程数据（只有更新的 revision 才会生效） */
  accept: (next: StatToolData) => void
  selectList: (id: string | null) => void
  createList: (name: string, makeCurrent?: boolean) => Promise<string | null>
  renameList: (id: string, name: string) => void
  deleteList: (id: string) => void
  setPinned: (id: string, pinned: boolean) => void
  resort: (listId: string) => void
  /** 批量添加，返回真正新增的条数（重复的会被主进程忽略） */
  addEntries: (listId: string, items: StatAddItem[]) => Promise<number>
  updateEntry: (id: string, patch: StatEntryPatch) => void
  removeEntry: (id: string) => void
  listEntries: (listId: string) => StatEntry[]
}

/** 收藏条目 → 添加项（看完时间：手动标记过就带上，值转成本地时间字符串） */
export function favoriteToAddItem(f: FavoriteItem): StatAddItem {
  return {
    subjectId: f.subjectId,
    name: f.name,
    nameCn: f.nameCn,
    cover: f.cover,
    airDate: f.airDate,
    rating: f.rating,
    genres: f.genres,
    watchedAt: tsToLocalInput(f.watchedAt)
  }
}

/** bangumi 条目（当季 / 搜索）→ 添加项：两者字段形状一致，用同一个映射，避免两处走样 */
export function bgmItemToAddItem(it: SeasonItem): StatAddItem {
  return {
    subjectId: it.id,
    name: it.name,
    nameCn: it.name_cn || it.name,
    cover: it.images?.large ?? it.images?.common ?? '',
    airDate: it.air_date,
    rating: it.rating?.score ?? null
  }
}

// ---------------- 当季候选的渲染层记忆（v0.3.2） ----------------

/**
 * 为什么要在渲染层再记忆一层。
 *
 * 主进程其实已经有季度条目的磁盘缓存（`main/services/bangumi.ts` 的 `season()`，
 * 缓存键 `season-<年>-<季度序号>`，TTL 7 天 —— 一个季度的条目几乎不变）。
 * 但渲染层过去是「每次切到当季页签都发一次 IPC、并且先显示转圈」：
 * 缓存命中也要等一次往返 + 读盘，缓存过期就是几秒的联网等待，用户点一下就要看转圈。
 *
 * 用户的要求是「添加番剧条目时，从本地缓存的当季番剧数据进行添加，这样加载更快」，
 * 所以这里把已经拿到的候选直接记在渲染层：同一个会话里再切回同一季**一次请求都不发**，
 * 同步就把候选渲染出来。主进程的 TTL 仍然是数据的最终判据 ——
 * 记忆超过 SEASON_MEMO_FRESH_MS 时界面先照旧渲染，再后台静默刷新（见下方 fetchSeasonAddItems）。
 */
const SEASON_MEMO_FRESH_MS = 6 * 3600 * 1000

/** 一次当季取数的结果（含主进程是否命中它自己的磁盘缓存） */
export interface SeasonAddSnapshot {
  items: StatAddItem[]
  fetchedAt: number
  /** 主进程回传的 fromCache（true = 主进程磁盘缓存命中，没有联网） */
  fromMainCache: boolean
  /** IPC 本身失败（通道异常）—— 界面按错误提示处理 */
  ipcError?: string
  /** 数据源报错、但拿到了（可能不完整的）条目 —— 界面按警告提示处理 */
  sourceError?: string
}

/** key = 年 + 季度序号（1=冬 … 4=秋），与主进程的缓存键同一个维度 */
const seasonMemo = new Map<string, SeasonAddSnapshot>()
/** 同一个 key 的请求合并：预热与弹窗同时要数据时只发一次 */
const seasonInFlight = new Map<string, Promise<SeasonAddSnapshot>>()

export function seasonMemoKey(year: number, season: number): string {
  return `${year}-${season}`
}

/** 命中渲染层记忆就返回（**不发任何请求**）；没命中返回 null */
export function peekSeasonAddItems(year: number, season: number): SeasonAddSnapshot | null {
  return seasonMemo.get(seasonMemoKey(year, season)) ?? null
}

/** 记忆是否还够新鲜（够新鲜就完全不请求；过期则先渲染再后台刷新） */
export function seasonSnapshotIsFresh(snap: SeasonAddSnapshot, now = Date.now()): boolean {
  return now - snap.fetchedAt < SEASON_MEMO_FRESH_MS
}

/**
 * 取某个季度的候选（命中记忆/在途请求就直接复用）。
 *
 * 注意第三个参数**不传 force**：主进程自己的 TTL（7 天）才是「要不要联网」的判据，
 * 渲染层这一层只是把「同一会话里重复打开」的往返省掉 —— 该刷新的时候由主进程决定，
 * 这样既不会重复联网，也不会让用户看到过期数据。
 */
export function fetchSeasonAddItems(year: number, season: number): Promise<SeasonAddSnapshot> {
  const key = seasonMemoKey(year, season)
  const inFlight = seasonInFlight.get(key)
  if (inFlight) return inFlight

  const task = api.bangumi
    .season(year, season * 3)
    .then((r): SeasonAddSnapshot => {
      if (!r.ok) return { items: [], fetchedAt: Date.now(), fromMainCache: false, ipcError: r.error }
      const snap: SeasonAddSnapshot = {
        items: r.data.items.map(bgmItemToAddItem),
        fetchedAt: Date.now(),
        fromMainCache: r.data.fromCache === true,
        sourceError: r.data.error?.message
      }
      // 数据源整体失败（没有任何条目）时不写记忆：下次打开应该重新试一次网络
      if (snap.items.length > 0 || !snap.sourceError) seasonMemo.set(key, snap)
      return snap
    })
    .catch((err): SeasonAddSnapshot => ({
      items: [],
      fetchedAt: Date.now(),
      fromMainCache: false,
      ipcError: String(err)
    }))
    .finally(() => {
      seasonInFlight.delete(key)
    })

  seasonInFlight.set(key, task)
  return task
}

/**
 * 预热：进入统计页时悄悄把「当前季度」放进记忆，等用户真的点开
 * 「添加番剧 → 当季番剧」时就是直接出数据。
 *
 * 代价说明：记忆够新鲜时这里**什么都不做**（0 请求）；否则发一次 IPC，
 * 而主进程绝大多数情况下命中 7 天磁盘缓存（只是读盘），所以预热几乎不产生联网。
 * 失败静默忽略 —— 它只是加速，真正打开弹窗时还有一次正式的取数与错误提示。
 */
export function warmSeasonAddItems(now: Date = new Date()): void {
  const s = seasonOfDate(now)
  const hit = peekSeasonAddItems(s.year, s.season)
  if (hit && seasonSnapshotIsFresh(hit)) return
  void fetchSeasonAddItems(s.year, s.season).catch(() => {
    /* 预热失败不影响任何交互 */
  })
}

/**
 * 置顶优先 → 其余按创建时间。
 *
 * 放在模块级而不是 store 方法里：页面要用它做 selector 的派生值，
 * zustand 的 selector 里每次新建数组会导致无限重渲染，所以由页面用 useMemo 调它。
 */
export function orderedListsOf(data: StatToolData): StatToolData['lists'] {
  return [...data.lists].sort((a, b) => {
    const pa = a.pinned ? 0 : 1
    const pb = b.pinned ? 0 : 1
    if (pa !== pb) return pa - pb
    return a.createdAt - b.createdAt
  })
}

/** 时间戳 → `<input type="datetime-local">` 的值（本地时间，YYYY-MM-DDTHH:mm） */
export function tsToLocalInput(ts: number | null | undefined): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `<input type="datetime-local">` 的值 → 时间戳（无效返回 null） */
export function localInputToTs(v: string | null | undefined): number | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

export const useStatTool = create<StatToolState>((set, get) => ({
  data: EMPTY,
  loaded: false,
  selectedListId: null,

  load: async () => {
    const r = await api.stat.get()
    const data = normalizeIncoming(r.ok ? r.data : null)
    ackRevision = Number(data.revision ?? 0)
    const lists = orderedListsOf(data)
    set({
      data,
      loaded: true,
      // 首次加载选中第一个列表；已经有选中项且仍存在时保持不变
      selectedListId:
        get().selectedListId && lists.some((l) => l.id === get().selectedListId)
          ? get().selectedListId
          : (lists[0]?.id ?? null)
    })
    // 主进程改完会广播（多窗口同步）；只订阅一次
    if (!subscribed) {
      subscribed = true
      api.stat.onChanged((next) => get().accept(next))
    }
  },

  accept: (next) => {
    if (!next) return
    const incoming = normalizeIncoming(next)
    const rev = Number(incoming.revision ?? 0)
    if (rev < ackRevision) return
    ackRevision = rev
    set((s) => ({
      data: incoming,
      // 选中的列表被别人删掉时回退到第一个
      selectedListId:
        s.selectedListId && incoming.lists.some((l) => l.id === s.selectedListId)
          ? s.selectedListId
          : (incoming.lists[0]?.id ?? null)
    }))
  },

  selectList: (id) => set({ selectedListId: id }),

  createList: async (name, makeCurrent = true) => {
    const before = new Set(get().data.lists.map((l) => l.id))
    const r = await api.stat.apply({ kind: 'createList', name })
    if (!r.ok) return null
    const created = r.data.lists.find((l) => !before.has(l.id)) ?? null
    get().accept(r.data)
    if (created && makeCurrent) set({ selectedListId: created.id })
    return created?.id ?? null
  },

  renameList: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    // 乐观更新：列表名是高频轻量改动，不必等广播
    set((s) => ({ data: { ...s.data, lists: s.data.lists.map((l) => (l.id === id ? { ...l, name: trimmed } : l)) } }))
    void api.stat.apply({ kind: 'renameList', listId: id, name: trimmed })
  },

  deleteList: (id) => {
    set((s) => {
      const lists = s.data.lists.filter((l) => l.id !== id)
      return {
        data: { ...s.data, lists, entries: s.data.entries.filter((e) => e.listId !== id) },
        selectedListId: s.selectedListId === id ? (lists[0]?.id ?? null) : s.selectedListId
      }
    })
    void api.stat.apply({ kind: 'deleteList', listId: id })
  },

  setPinned: (id, pinned) => {
    set((s) => ({
      data: { ...s.data, lists: s.data.lists.map((l) => (l.id === id ? { ...l, pinned } : l)) }
    }))
    void api.stat.apply({ kind: 'setPinned', listId: id, pinned })
  },

  resort: (listId) => {
    void api.stat.apply({ kind: 'resort', listId }).then((r) => {
      if (r.ok) get().accept(r.data)
    })
  },

  addEntries: async (listId, items) => {
    if (items.length === 0) return 0
    const before = new Set(get().data.entries.filter((e) => e.listId === listId).map((e) => e.id))
    const r = await api.stat.apply({ kind: 'addEntries', listId, items })
    if (!r.ok) return 0
    get().accept(r.data)
    return r.data.entries.filter((e) => e.listId === listId && !before.has(e.id)).length
  },

  updateEntry: (id, patch) => {
    // 乐观更新（详情窗口失焦 / 改日期都要立刻反映），主进程回传的 revision 更高时覆盖
    set((s) => ({
      data: {
        ...s.data,
        entries: s.data.entries.map((e) => (e.id === id ? { ...e, ...patch } : e))
      }
    }))
    const action: StatAction = { kind: 'updateEntry', entryId: id, patch }
    void api.stat.apply(action).then((r) => {
      if (r.ok) get().accept(r.data)
    })
  },

  removeEntry: (id) => {
    set((s) => ({ data: { ...s.data, entries: s.data.entries.filter((e) => e.id !== id) } }))
    void api.stat.apply({ kind: 'removeEntry', entryId: id })
  },

  listEntries: (listId) => get().data.entries.filter((e) => e.listId === listId)
}))

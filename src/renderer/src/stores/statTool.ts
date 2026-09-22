import { create } from 'zustand'
import type {
  FavoriteItem,
  StatAction,
  StatAddItem,
  StatEntry,
  StatEntryPatch,
  StatToolData
} from '@shared/types'
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

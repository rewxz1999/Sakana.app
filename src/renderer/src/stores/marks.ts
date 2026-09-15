import { create } from 'zustand'
import type { MarkItem, MarkList, SearchHistoryItem } from '@shared/types'
import { api } from '@/lib/api'

/** 搜索历史保留上限（产品要求 50 条） */
export const HISTORY_LIMIT = 50

/**
 * 搜索页底部展示位（轮播图）的持久化键。
 * 值为图片**绝对路径**数组，交给 sakana-img 协议加载；键名由产品方指定。
 */
export const SHOWCASE_KEY = 'searchShowcase'

/**
 * 持久化数据来自磁盘（旧版本、手工改动、写入中断都可能出现脏值），
 * 逐项收窄成 string[]，避免把非法值喂给图片协议。
 */
function toPathList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

/** 标记一条番剧所需的最小字段：搜索结果里即可拿全，无需再请求详情 */
export interface MarkSubjectInput {
  subjectId: number
  title: string
  cover: string
}

interface MarksState {
  lists: MarkList[]
  items: MarkItem[]
  history: SearchHistoryItem[]
  /** 搜索页底部展示位的图片路径（轮播），与列表/条目共用一次 load() */
  showcase: string[]
  loaded: boolean
  load: () => Promise<void>
  createList: (name?: string) => MarkList
  renameList: (id: string, name: string) => void
  removeList: (id: string) => void
  addMark: (listId: string, subject: MarkSubjectInput) => void
  removeMark: (id: string) => void
  isMarked: (listId: string, subjectId: number) => boolean
  pushHistory: (kw: string) => void
  clearHistory: () => void
  /** 追加展示图片，返回真正新增的张数（已存在的会被忽略） */
  addShowcase: (paths: string[]) => number
  removeShowcase: (path: string) => void
  clearShowcase: () => void
}

/**
 * 默认书签名「书签 N」：取现有同名序号的**最大值 +1**。
 * 若按书签数量命名，删掉中间某个书签后就会与既有名字重复，导致用户无法区分。
 * 同时兼容 v0.2.5 的旧前缀「标记列表 N」（当时的「标记区域」）：老数据升级后序号不倒退、不重名。
 */
export function defaultListName(lists: MarkList[]): string {
  const used = new Set(lists.map((l) => l.name))
  let n = 1
  for (const l of lists) {
    const m = /^(?:书签|标记列表)\s*(\d+)$/.exec(l.name)
    if (m) n = Math.max(n, Number(m[1]) + 1)
  }
  while (used.has(`书签 ${n}`)) n += 1
  return `书签 ${n}`
}

export const useMarks = create<MarksState>((set, get) => ({
  lists: [],
  items: [],
  history: [],
  showcase: [],
  loaded: false,
  load: async () => {
    const [l, i, h, s] = await Promise.all([
      api.store.get('markLists'),
      api.store.get('markItems'),
      api.store.get('searchHistory'),
      api.store.get(SHOWCASE_KEY)
    ])
    set({
      lists: l.ok && Array.isArray(l.data) ? (l.data as MarkList[]) : [],
      items: i.ok && Array.isArray(i.data) ? (i.data as MarkItem[]) : [],
      history: h.ok && Array.isArray(h.data) ? (h.data as SearchHistoryItem[]) : [],
      showcase: s.ok ? toPathList(s.data) : [],
      loaded: true
    })
  },
  createList: (name) => {
    const list: MarkList = {
      id: crypto.randomUUID(),
      name: name?.trim() || defaultListName(get().lists),
      createdAt: Date.now()
    }
    const next = [...get().lists, list]
    set({ lists: next })
    void api.store.set('markLists', next)
    return list
  },
  renameList: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const next = get().lists.map((l) => (l.id === id ? { ...l, name: trimmed } : l))
    set({ lists: next })
    void api.store.set('markLists', next)
  },
  // 列表与条目一起删：条目失去归属后不可能再被任何 UI 看到，留着只会变成脏数据
  removeList: (id) => {
    const lists = get().lists.filter((l) => l.id !== id)
    const items = get().items.filter((it) => it.listId !== id)
    set({ lists, items })
    void api.store.set('markLists', lists)
    void api.store.set('markItems', items)
  },
  addMark: (listId, subject) => {
    if (get().isMarked(listId, subject.subjectId)) return
    const item: MarkItem = {
      id: crypto.randomUUID(),
      listId,
      subjectId: subject.subjectId,
      title: subject.title,
      cover: subject.cover,
      link: String(subject.subjectId), // 详情页路由参数：/subject/:id
      addedAt: Date.now()
    }
    const next = [...get().items, item]
    set({ items: next })
    void api.store.set('markItems', next)
  },
  removeMark: (id) => {
    const next = get().items.filter((it) => it.id !== id)
    set({ items: next })
    void api.store.set('markItems', next)
  },
  isMarked: (listId, subjectId) =>
    get().items.some((it) => it.listId === listId && it.subjectId === subjectId),
  // 重复关键词只保留最新一条并置顶，避免历史里堆满同一个词
  pushHistory: (kw) => {
    const q = kw.trim()
    if (!q) return
    const next = [
      { kw: q, at: Date.now() },
      ...get().history.filter((h) => h.kw !== q)
    ].slice(0, HISTORY_LIMIT)
    set({ history: next })
    void api.store.set('searchHistory', next)
  },
  clearHistory: () => {
    set({ history: [] })
    void api.store.set('searchHistory', [])
  },
  // 同一张图重复加入只会让轮播停在同图上，因此按路径去重并返回真实新增数，让页面能给出准确提示
  addShowcase: (paths) => {
    const before = get().showcase
    const seen = new Set(before)
    const next = [...before]
    for (const p of paths) {
      if (typeof p !== 'string' || p.length === 0 || seen.has(p)) continue
      seen.add(p)
      next.push(p)
    }
    const added = next.length - before.length
    if (added === 0) return 0
    set({ showcase: next })
    void api.store.set(SHOWCASE_KEY, next)
    return added
  },
  removeShowcase: (path) => {
    const next = get().showcase.filter((p) => p !== path)
    set({ showcase: next })
    void api.store.set(SHOWCASE_KEY, next)
  },
  // 只清展示列表，不动磁盘上的图片文件
  clearShowcase: () => {
    set({ showcase: [] })
    void api.store.set(SHOWCASE_KEY, [])
  }
}))

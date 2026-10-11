import { create } from 'zustand'
import type { MarkItem, MarkList, SearchHistoryItem } from '@shared/types'
import { api } from '@/lib/api'

/** 搜索历史保留上限（产品要求 50 条） */
export const HISTORY_LIMIT = 50

/*
 * v0.3.9：搜索页那块「用户自己上传图片的自定义轮播展示位」已按用户要求整块删除，
 * 所以本 store 里的 `showcase` 状态、`addShowcase/removeShowcase/clearShowcase`、
 * `SHOWCASE_KEY`、`toPathList` 与 `migrateShowcase` 一并删掉了（不留死代码）。
 *
 * 两个**故意保留**的东西，说明原因：
 *   1. 磁盘上历史遗留的 `searchShowcase` 键没有主动清除 —— 它只是没人再读了；
 *      删数据是不可逆操作，而用户重装/回退旧版本时那份列表还能救回来。
 *   2. `api.showcase.importImages()` 这条 IPC 也不能删：它现在被
 *      「最XX的角色 9宫格」（CharacterGridPage）与「推荐表」（stores/recommendTable、
 *      components/recommend/*）用着，只是搜索页不再读它了。
 */

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
  loaded: boolean
  load: () => Promise<void>
  createList: (name?: string, keyword?: string) => MarkList
  renameList: (id: string, name: string) => void
  removeList: (id: string) => void
  addMark: (listId: string, subject: MarkSubjectInput) => void
  removeMark: (id: string) => void
  isMarked: (listId: string, subjectId: number) => boolean
  pushHistory: (kw: string) => void
  clearHistory: () => void
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
  loaded: false,
  load: async () => {
    // v0.3.9：不再读 `searchShowcase`（自定义轮播展示位已删除），所以这里只剩三个键
    const [l, i, h] = await Promise.all([
      api.store.get('markLists'),
      api.store.get('markItems'),
      api.store.get('searchHistory')
    ])
    set({
      lists: l.ok && Array.isArray(l.data) ? (l.data as MarkList[]) : [],
      items: i.ok && Array.isArray(i.data) ? (i.data as MarkItem[]) : [],
      history: h.ok && Array.isArray(h.data) ? (h.data as SearchHistoryItem[]) : [],
      loaded: true
    })
  },
  /**
   * 新建书签。
   * keyword = 创建时搜索框里的关键词：搜索页书签弹窗的「重新搜索」靠它重跑一次搜索
   * （老书签没有这个字段，页面会退化成用条目标题去搜）。
   */
  createList: (name, keyword) => {
    const kw = keyword?.trim()
    const list: MarkList = {
      id: crypto.randomUUID(),
      name: name?.trim() || defaultListName(get().lists),
      createdAt: Date.now(),
      ...(kw ? { keyword: kw } : {})
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
  }
}))

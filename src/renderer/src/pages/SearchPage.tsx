import { useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import {
  Bookmark,
  BookmarkCheck,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  GripVertical,
  History,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  X
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { MarkItem, MarkList, SearchResultItem } from '@shared/types'
import { api } from '@/lib/api'
import { yearOf } from '@/lib/format'
import { HISTORY_LIMIT, defaultListName, useMarks } from '@/stores/marks'
import { toast, useSettings } from '@/stores/app'
import {
  Badge,
  Button,
  ConfirmModal,
  EmptyState,
  IconButton,
  Input,
  Modal,
  Spinner
} from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import { ImageCarousel } from '@/components/ImageCarousel'

/** 拖拽载荷 MIME：只带最小字段，避免把整个搜索结果对象（含长 summary）塞进 dataTransfer */
const DRAG_MIME = 'application/x-sakana-subject'

/**
 * 是否小型配置窗口：由主进程启动参数（--sakana-small）在 preload 里决定，
 * 本次进程生命周期内不会变化，所以模块加载时读一次即可，
 * 不必在每次渲染里穿透 bridge 对象取值。
 */
const SMALL = api.window.isSmallWindow

/**
 * 内容列表底部留白：底部展示位（轮播）是浮在内容之上的绝对定位元素，
 * 不留白就会出现「滚到底也看不到最后一条」的情况。
 */
const LIST_BOTTOM_PAD = 'pb-40'

/**
 * 书签条离窗口右边缘的距离：至少要越过 8px 的系统滚动条（main.css 里的 ::-webkit-scrollbar），
 * 否则把手会盖住滚动条、拖不动它。剩下的宽度即「悬浮长条卡片」的悬浮感。
 */
const STRIP_INSET = 'pr-[10px]'

/**
 * 结果区右侧留白（收起态）：书签条收起时只占右边缘 10px 内缩 + 36px 的把手，
 * 留出 52px 让卡片永远不被把手压住；这里用固定值而不是动画，
 * 避免悬停抽出的瞬间整列卡片跟着逐帧重排。
 */
const GUTTER = 'pr-[52px]'

/**
 * 结果区右侧留白（固定展开态）：把手 36 + 抽出的列表 212 + 内缩与余量。
 * 只有「点过把手 / 开着书签弹窗」这种稳定状态才加宽 ——
 * 悬停抽出的列表是临时浮层（带不透明底色），不做 reflow。
 */
const GUTTER_OPEN = 'pr-[268px]'

/** 书签条一次最多铺出的行数：再多就折进「+N」，长条卡片不会被撑成一面墙 */
const STRIP_ROWS = 8

/** 书签弹窗里的条目预览条数（其余的用「还有 N 条」带过，点「查看条目」看全部） */
const POPOVER_ROWS = 3

/** 底部展示位（轮播）贴着书签条左侧落位，别和把手/抽出的列表叠在一起 */
const CAROUSEL_RIGHT = 'right-[56px]'
const CAROUSEL_RIGHT_OPEN = 'right-[276px]'

/** 主区域视图：搜索结果为默认视图，点书签后切到该书签的条目视图（不再用弹窗承载） */
type MainView = 'search' | 'bookmark'

interface DragSubject {
  subjectId: number
  title: string
  cover: string
}

function toDragSubject(item: SearchResultItem): DragSubject {
  return {
    subjectId: item.id,
    title: item.name_cn || item.name,
    cover: item.images?.large ?? item.images?.common ?? ''
  }
}

/** dataTransfer 只能拿到字符串，且可能被外部拖入的任意数据污染，必须收窄 */
function isDragSubject(v: unknown): v is DragSubject {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.subjectId === 'number' && typeof o.title === 'string' && typeof o.cover === 'string'
}

/** 条目按标记日期分组（同一天归为一组，日期倒序）；入参需已按 addedAt 倒序 */
function groupByDate(sortedDesc: MarkItem[]): [string, MarkItem[]][] {
  const map = new Map<string, MarkItem[]>()
  for (const it of sortedDesc) {
    const key = dayjs(it.addedAt).format('YYYY-MM-DD')
    const arr = map.get(key)
    if (arr) arr.push(it)
    else map.set(key, [it])
  }
  return [...map.entries()]
}

// ---------------- 「返回搜索结果」用的会话快照 ----------------

/**
 * 搜索页挂在 hash 路由上（App.tsx 里 Routes 的 key 就是 location.pathname），
 * 点结果进 /subject/:id 会让它**整个卸载**；从详情页返回时（SubjectDetailPage 的返回是
 * navigate(-1)）拿到的是一份全新的组件状态 —— 用户刚搜出来的一屏结果就没了。
 *
 * 做法：离开搜索页去详情页的那一刻，把「关键词 + 结果 + 视图状态」写进 sessionStorage；
 * 回到搜索页的首次渲染同步读回来（读在 useState 初始化里，所以不会先闪一下空态再刷出结果），
 * 挂载后的 effect 立刻删掉快照 —— 「一次离页只恢复一次」，
 * 之后从侧边栏再进搜索页（并不是为了返回详情页）就是干净的一页。
 */
const RESTORE_KEY = 'sakana.searchRestore'

interface SearchSnapshot {
  query: string
  results: SearchResultItem[]
  searched: boolean
  searchError: string
  view: MainView
  /** 当前书签（书签视图 / 拖拽落点），让返回后「看的是哪本书签」也一致 */
  currentListId: string | null
  /** 书签条是否被点开固定住 */
  pinned: boolean
}

/** 结果项收窄：sessionStorage 里可能是旧版本写的残缺数据，缺字段会让卡片渲染直接炸 */
function isSearchResultItem(v: unknown): v is SearchResultItem {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.id === 'number' && typeof o.name === 'string'
}

/** 读快照：只读不删（StrictMode 下 useState 的初始化函数会被调用两次，必须是纯的） */
function readSnapshot(): SearchSnapshot | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(RESTORE_KEY)
  } catch {
    return null // 存储不可用时退化成「返回后不恢复」，不影响搜索本身
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  if (typeof o.query !== 'string' || !Array.isArray(o.results)) return null
  return {
    query: o.query,
    results: o.results.filter(isSearchResultItem),
    searched: o.searched === true,
    searchError: typeof o.searchError === 'string' ? o.searchError : '',
    view: o.view === 'bookmark' ? 'bookmark' : 'search',
    currentListId: typeof o.currentListId === 'string' ? o.currentListId : null,
    pinned: o.pinned === true
  }
}

function writeSnapshot(s: SearchSnapshot): void {
  try {
    sessionStorage.setItem(RESTORE_KEY, JSON.stringify(s))
  } catch {
    /* 写不进去就算了：大不了返回后不恢复，不能因此打断导航 */
  }
}

function clearSnapshot(): void {
  try {
    sessionStorage.removeItem(RESTORE_KEY)
  } catch {
    /* 同上 */
  }
}

export function SearchPage() {
  const navigate = useNavigate()
  /**
   * 空态轮播图的切换间隔（秒）：存在 settings 里（searchCarouselSec），随设置一起持久化，
   * 老设置文件没有这个键时由 ImageCarousel 按默认 6 秒兜底。
   */
  const carouselSec = useSettings((s) => s.settings.searchCarouselSec)
  const saveSettings = useSettings((s) => s.save)
  const {
    lists,
    items,
    history,
    showcase,
    loaded,
    load,
    createList,
    renameList,
    removeList,
    addMark,
    removeMark,
    isMarked,
    pushHistory,
    clearHistory,
    addShowcase,
    removeShowcase,
    clearShowcase
  } = useMarks()

  // 返回搜索页（从详情页 navigate(-1) 回来）时恢复上次的一屏结果；只读一次，不吃二次渲染
  const [restored] = useState(readSnapshot)

  const [query, setQuery] = useState(restored?.query ?? '')
  const [results, setResults] = useState<SearchResultItem[]>(restored?.results ?? [])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(restored?.searchError ?? '')
  const [searched, setSearched] = useState(restored?.searched ?? false)

  /** 主区域当前展示什么：搜索结果，还是某个书签的条目 */
  const [view, setView] = useState<MainView>(restored?.view ?? 'search')

  /** 当前书签 = 拖拽落点 + 书签视图正在展示的那一本 */
  const [currentListId, setCurrentListId] = useState<string | null>(restored?.currentListId ?? null)

  /** 书签条：hovered 悬停抽出、pinned 点击固定、dragSubject 拖拽中强制抽出 */
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(restored?.pinned ?? false)
  /** 弹窗里的书签：非空时书签条保持抽出（否则鼠标一离开弹窗就跟着收起来了） */
  const [activeListId, setActiveListId] = useState<string | null>(null)
  /** 书签多于 STRIP_ROWS 时是否铺全（默认只铺前几行 + 「+N」） */
  const [showAllMarks, setShowAllMarks] = useState(false)
  const stripRef = useRef<HTMLDivElement | null>(null)

  /*
   * 搜索历史下拉面板（v0.2.12，用户要求「搜索历史需要改成下拉式标签页」）。
   *
   * 旧做法是一条常驻横条，永远占着顶部一行高度；词多了还要横向滚动。
   * 现在收进搜索框左侧的下拉按钮里，面板内用标签页分区：
   * 「搜索历史」= 最近搜过的关键词，「书签」= 每个书签当初用的关键词（点一下重搜）。
   * 两个标签页都是「点了就重搜」，所以合在一个下拉里最顺手。
   */
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyTab, setHistoryTab] = useState<'history' | 'marks'>('history')
  const historyPanelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!historyOpen) return
    // 点击面板/按钮之外、或按 Esc 都收起；拖拽等其它交互不受影响
    const onDown = (e: MouseEvent): void => {
      if (historyPanelRef.current && !historyPanelRef.current.contains(e.target as Node)) setHistoryOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setHistoryOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [historyOpen])

  const [dragSubject, setDragSubject] = useState<DragSubject | null>(null)
  const [draggingOver, setDraggingOver] = useState(false)
  /** 正被拖拽悬停的那一本：行级高亮，比整条高亮更能说清「会落到哪」 */
  const [dragOverListId, setDragOverListId] = useState<string | null>(null)

  // 快速标记弹窗：内容与开关分开存，关闭动画播放期间弹窗内不会闪烁成空白
  const [pickFor, setPickFor] = useState<SearchResultItem | null>(null)
  const [pickOpen, setPickOpen] = useState(false)
  const [newListName, setNewListName] = useState('')

  // 添加 / 重命名书签共用同一个弹窗：两者都只是「给一个名字」，没必要做两套 UI
  const [editOpen, setEditOpen] = useState(false)
  const [editMode, setEditMode] = useState<'create' | 'rename'>('create')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  // 删除书签确认：待删对象与开关分开存，退出动画期间弹窗内容不会闪成空白
  const [pendingDelete, setPendingDelete] = useState<{
    id: string
    name: string
    count: number
  } | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // 快照消费：挂载后立刻删掉，保证「返回详情页」只恢复一次（StrictMode 下重复执行也无害）
  useEffect(() => {
    clearSnapshot()
  }, [])

  // 当前书签：被删除或首次加载后自动落到第一个，保证「拖拽落点」始终存在
  const currentList = useMemo(
    () => lists.find((l) => l.id === currentListId) ?? lists[0] ?? null,
    [lists, currentListId]
  )

  useEffect(() => {
    // 书签还没从磁盘载入完：此时 lists 为空只代表「还没加载」，不能把恢复出来的当前书签清掉
    if (!loaded) return
    if (lists.length === 0) {
      if (currentListId !== null) setCurrentListId(null)
      return
    }
    if (!lists.some((l) => l.id === currentListId)) setCurrentListId(lists[0].id)
  }, [loaded, lists, currentListId])

  /**
   * 主区域条目列表按当前书签实时推导：增删条目、重命名都会立刻反映，
   * 而不是打开时的快照（v0.2.6 弹窗时代就是这么做的，这里保留同一份数据来源）。
   */
  const currentGroups = useMemo(() => {
    if (!currentList) return [] as [string, MarkItem[]][]
    const sorted = items
      .filter((it) => it.listId === currentList.id)
      .sort((a, b) => b.addedAt - a.addedAt)
    return groupByDate(sorted)
  }, [items, currentList])
  const currentCount = useMemo(
    () => currentGroups.reduce((n, [, arr]) => n + arr.length, 0),
    [currentGroups]
  )

  /** 弹窗对应的书签（被删除后自动消失，不留一个空弹窗） */
  const activeMark = useMemo(
    () => lists.find((l) => l.id === activeListId) ?? null,
    [lists, activeListId]
  )
  /** 弹窗里的条目（新→旧） */
  const activeItems = useMemo(
    () =>
      activeMark
        ? items.filter((it) => it.listId === activeMark.id).sort((a, b) => b.addedAt - a.addedAt)
        : [],
    [items, activeMark]
  )

  const doSearch = async (kw: string): Promise<void> => {
    const q = kw.trim()
    if (!q) {
      setResults([])
      setSearched(false)
      return
    }
    setQuery(q)
    setSearching(true)
    setSearched(true)
    // 用户敲了关键词就是想看结果：把主区域从「书签条目」切回搜索结果视图
    setView('search')
    // 先在输入时就记入历史：即使数据源全挂，用户也不该丢掉刚敲的关键词
    pushHistory(q)
    const r = await api.bangumi.search(q)
    setSearching(false)
    if (r.ok) {
      setResults(r.data.items)
      // 数据源返回了「全部不可达」之类的说明（例如自建反代挂了）时，
      // 把原因留在页面上，方便用户照着文案去「数据源配置」里切换（v0.2.7）
      setSearchError(r.data.error ? r.data.error.message : '')
    } else {
      setResults([])
      setSearchError(r.error)
      toast.error(r.error)
    }
  }

  /**
   * 打开番剧详情页。
   * 先落一份会话快照再跳 —— 详情页的「返回」是 navigate(-1)，回来时搜索页是全新挂载的，
   * 没有这份快照就会丢掉刚搜出来的一屏结果。
   */
  const openSubject = (id: string): void => {
    writeSnapshot({ query, results, searched, searchError, view, currentListId, pinned })
    navigate(`/subject/${id}`, { state: { from: 'search' } })
  }

  const openItem = (item: MarkItem): void => {
    const id = item.link || (item.subjectId != null ? String(item.subjectId) : '')
    if (!id) return
    openSubject(id)
  }

  /** 加入 / 移出某个书签（快速标记弹窗行点击用） */
  const toggleInList = (listId: string, subject: DragSubject): void => {
    const name = lists.find((l) => l.id === listId)?.name ?? ''
    const existing = items.find((it) => it.listId === listId && it.subjectId === subject.subjectId)
    if (existing) {
      removeMark(existing.id)
      toast.info(`已从「${name}」移除`)
      return
    }
    addMark(listId, subject)
    setCurrentListId(listId) // 顺手切到目标书签，用户能立刻看到刚标记的条目
    toast.success(`已加入「${name}」`)
  }

  /** 拖到书签条空白处：进当前书签；没有书签时先建一个，否则拖拽会因为「无目标」而变成一次无效操作 */
  const dropIntoCurrent = (subject: DragSubject): void => {
    const target = currentList
    if (!target) {
      const created = createList(undefined, query.trim() || undefined)
      setCurrentListId(created.id)
      addMark(created.id, subject)
      toast.success(`已新建书签「${created.name}」并标记`)
      return
    }
    if (isMarked(target.id, subject.subjectId)) {
      toast.info(`已在「${target.name}」中`)
      return
    }
    addMark(target.id, subject)
    toast.success(`已加入「${target.name}」`)
  }

  /** 从 dataTransfer / 内存里取出被拖的番剧：外部拖入的脏数据一律丢弃 */
  const readDrag = (e: React.DragEvent): DragSubject | null => {
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (isDragSubject(parsed)) return parsed
      } catch {
        /* 载荷非法时退回内存中的拖拽源 */
      }
    }
    return dragSubject
  }

  /** 拖拽收尾：拖拽态、悬停高亮一起清，避免拖完留下一个假的落点高亮 */
  const resetDrag = (): void => {
    setDragSubject(null)
    setDraggingOver(false)
    setDragOverListId(null)
  }

  /** 拖到某一本具体书签的行上：直接进那一本（比「先选中再拖」少一步） */
  const dropOnList = (e: React.DragEvent, listId: string): void => {
    e.preventDefault()
    e.stopPropagation() // 行内已经处理过，别再冒泡给整条书签条重复加一次
    const subject = readDrag(e)
    resetDrag()
    if (!subject) return
    const target = lists.find((l) => l.id === listId)
    if (!target) return
    setCurrentListId(listId)
    if (isMarked(listId, subject.subjectId)) {
      toast.info(`已在「${target.name}」中`)
      return
    }
    addMark(listId, subject)
    toast.success(`已加入「${target.name}」`)
  }

  /** 拖到书签条本身（含收起状态的把手）上：进当前书签 */
  const dropOnStrip = (e: React.DragEvent): void => {
    e.preventDefault()
    const subject = readDrag(e)
    resetDrag()
    if (!subject) return
    dropIntoCurrent(subject)
  }

  // ---------------- 书签：添加 / 重命名 / 删除 ----------------

  const openCreate = (): void => {
    setEditMode('create')
    setEditId(null)
    setEditName('')
    setEditOpen(true)
  }

  const openRename = (id: string, name: string): void => {
    setEditMode('rename')
    setEditId(id)
    setEditName(name)
    setEditOpen(true)
  }

  const submitEdit = (): void => {
    const name = editName.trim()
    if (editMode === 'create') {
      // 留空则用默认名「书签 N」：用户点了「添加书签」就是想立刻得到一本书签
      // 顺手把搜索框里的关键词记进书签，「重新搜索」才有东西可重跑
      const created = createList(name, query.trim() || undefined)
      setEditOpen(false)
      setCurrentListId(created.id)
      toast.success(`已添加书签「${created.name}」`)
      return
    }
    const id = editId
    if (!id) {
      setEditOpen(false)
      return
    }
    // 重命名清空成空白会让书签在列表里变成一条无法辨认的空行，直接拦下并保留弹窗
    if (!name) {
      toast.warn('书签名不能为空')
      return
    }
    const before = lists.find((l) => l.id === id)?.name
    setEditOpen(false)
    if (name === before) return
    renameList(id, name)
    toast.success('已重命名书签')
  }

  const confirmRemoveList = (id: string, name: string, count: number): void => {
    setPendingDelete({ id, name, count })
    setDeleteOpen(true)
  }

  /** 快速标记弹窗里「新建并标记」 */
  const createAndMark = (): void => {
    const target = pickFor
    const created = createList(newListName, query.trim() || undefined)
    setNewListName('')
    setCurrentListId(created.id)
    if (!target) {
      toast.success(`已添加书签「${created.name}」`)
      return
    }
    addMark(created.id, toDragSubject(target))
    toast.success(`已加入「${created.name}」`)
  }

  const handleClear = (): void => {
    setQuery('')
    setResults([])
    setSearched(false)
  }

  // ---------------- 书签条（右侧悬浮长条卡片） ----------------

  /** 把书签条整块收起来：弹窗、固定、悬停三个开关一起复位 */
  const collapseStrip = (): void => {
    setActiveListId(null)
    setPinned(false)
    setHovered(false)
  }

  /**
   * 把手点击：展开 → 收起；收起 → 固定展开。
   * hover 也会抽出，但那种展开是「临时」的，点一下按可见状态收起才符合直觉。
   */
  const toggleStrip = (): void => {
    if (hovered || pinned || activeMark) {
      collapseStrip()
      return
    }
    setPinned(true)
  }

  /** 点书签行：打开 / 关闭它的详情弹窗，同时把「当前书签」切到它 */
  const pickList = (id: string): void => {
    setCurrentListId(id)
    setActiveListId((prev) => (prev === id ? null : id))
  }

  /** 查看条目：主区域切到该书签的条目视图（沿用旧左侧书签列的点击行为） */
  const viewItems = (id: string): void => {
    setCurrentListId(id)
    setView('bookmark')
    collapseStrip()
  }

  /**
   * 书签记着的搜索关键词。
   * v0.2.9 起「添加书签」会把当时的搜索框内容一起存进书签；老数据没有该字段，
   * 退化成「用最新一条条目的标题再搜一次」，总比给一个点了没反应的按钮好。
   */
  const keywordOf = (list: MarkList): string => {
    const kw = list.keyword?.trim()
    if (kw) return kw
    const newest = items
      .filter((it) => it.listId === list.id)
      .sort((a, b) => b.addedAt - a.addedAt)[0]
    return newest?.title?.trim() ?? ''
  }

  const activeKeyword = activeMark ? keywordOf(activeMark) : ''

  /** 重新搜索：重跑书签记录的关键词，行为和点搜索历史里的关键词完全一致 */
  const research = (list: MarkList): void => {
    const kw = keywordOf(list)
    if (!kw) {
      toast.warn('这本书签既没有关键词也没有条目，无法重新搜索')
      return
    }
    collapseStrip() // 弹窗盖着结果区就没法看新结果了
    void doSearch(kw)
  }

  // 抽出的条件：悬停 / 点过把手 / 有弹窗 / 正在拖拽（拖拽时必须看得见每一行才能选落点）
  const stripOpen = hovered || pinned || activeMark !== null || dragSubject !== null
  /**
   * 「固定展开」才算占位：悬停抽出的是临时浮层（不透明底色 + 阴影），
   * 只有这两种稳定状态才让结果区让出宽度，避免鼠标扫过右边缘时整列卡片反复重排。
   */
  const stripDocked = pinned || activeMark !== null

  // 点到书签条以外就收起（只监听 mousedown 且不 preventDefault，不影响文本选择）
  useEffect(() => {
    if (!pinned && activeMark === null) return
    const onDown = (e: MouseEvent): void => {
      if (stripRef.current?.contains(e.target as Node)) return
      setPinned(false)
      setActiveListId(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pinned, activeMark])

  // ---------------- 底部展示位（轮播） ----------------

  /** 上传展示图片：对话框返回绝对路径数组，为空表示用户取消 */
  const uploadShowcase = async (): Promise<void> => {
    const r = await api.dialog.pickImages()
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (r.data.length === 0) return // 用户取消，不打扰
    /*
     * 白名单坑（必须过主进程复制一份）：
     * 图片都走 `sakana-img://local/<base64url>` 加载，而这个协议只读 media.ts
     * registerDefaultRoots() 注册过的目录。用户从「图片」文件夹挑的图不在白名单里，
     * 协议直接 403 —— 界面上就是一片空白（galgame 封面曾因同一个原因整批不显示）。
     * 主进程把图收进 <userData>/search-showcase 后返回新路径，存的就是白名单内的路径，
     * 重启后仍然能显示。
     */
    const imp = await api.showcase.importImages(r.data)
    if (!imp.ok) toast.warn(`图片未能收进应用目录（${imp.error}），可能显示不出来`)
    const paths = imp.ok ? imp.data : r.data
    // 去重交给 store：同一张图重复加入只会让轮播停在同图上
    const added = addShowcase(paths)
    if (added === 0) toast.info('所选图片已在展示列表中')
    else toast.success(`已添加 ${added} 张展示图片`)
  }

  const markedCountOf = (listId: string): number => items.filter((it) => it.listId === listId).length

  // 主区域是否有需要避让底部展示位的内容
  const hasListContent = view === 'bookmark' ? currentCount > 0 : results.length > 0

  /**
   * 「空态」判定：搜索视图 + 没有任何结果 + 不在搜索中。
   * 只有这种时候整片区域是空的，才把轮播图当**主内容**铺上去（用户的诉求就是「空荡」时填空）。
   * 有结果时它退回到原来那个右下角悬浮小窗，绝不挤占列表（`hasListContent` 时的 pb-40 也是原逻辑）。
   */
  const emptyShowcaseOpen = view === 'search' && !hasListContent && !searching

  /**
   * 空态轮播展示位：文案下面撑满剩余高度的一块大轮播图。
   * 外层 `flex-1`（父容器是 `flex min-h-full flex-col`，见下面的空态分支）让它吃掉文案之外的空白，
   * `min-h-[200px]` 保证窗口再矮也有一块像样的图，不够高时跟着滚动区正常滚动。
   */
  const emptyShowcase = (
    <div className="mt-4 min-h-[200px] flex-1">
      <ImageCarousel
        images={showcase}
        onUpload={() => void uploadShowcase()}
        onDeleteCurrent={(path) => {
          removeShowcase(path)
          toast.info('已删除当前展示图片')
        }}
        onClearAll={() => {
          clearShowcase()
          toast.info('已清空展示图片')
        }}
        intervalSec={carouselSec}
        onIntervalChange={(sec) => saveSettings({ searchCarouselSec: sec })}
        showcase
        className="h-full w-full"
      />
    </div>
  )

  /** 书签条列表里实际铺出的行（超过上限的部分折进「+N」） */
  const stripLists = showAllMarks ? lists : lists.slice(0, STRIP_ROWS)

  return (
    <div className="flex h-full flex-col">
      {/* 顶部搜索框（回车或点击右侧按钮触发）+ 右上角「添加书签」 */}
      <div className="border-b border-border bg-elev1/70 px-4 py-3 backdrop-blur sm:px-5">
        <div className="flex items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <div className="relative mx-auto max-w-xl">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doSearch(query)
                  if (e.key === 'Escape') setHistoryOpen(false)
                }}
                placeholder="搜索番剧，回车开始搜索；结果可拖到右侧书签条…"
                className="h-10 w-full rounded-xl border border-border bg-elev1 pl-11 pr-24 text-sm outline-none transition-colors placeholder:text-faint focus:border-accent"
              />
              {/*
                搜索历史下拉触发器（v0.2.12）：放在搜索框左侧内部，不再单独占一整行。
                面板里分「搜索历史 / 书签」两个标签页，点任一条都是重跑搜索。

                v0.3.0 修（用户反馈「搜索图标会遮住下拉表，点历史标签无响应」）：
                真因是 outside-click 的那只 ref 挂在了**这个触发按钮**上，
                于是点击面板内部（历史标签本身）会被判定成「点了外部」→ 先关面板再派发点击 →
                标签看起来完全没反应。现在 ref 挂在**包住触发按钮与面板的容器**上，
                并把面板的层级提高到 z-50，保证它在搜索图标之上。
              */}
              <div ref={historyPanelRef} className="contents">
                <button
                  title="搜索历史与书签"
                  onClick={() => setHistoryOpen((v) => !v)}
                  className={`absolute left-1.5 top-1/2 z-20 flex h-7 -translate-y-1/2 items-center gap-0.5 rounded-lg px-1.5 text-faint transition-colors hover:bg-elev2 hover:text-text ${
                    historyOpen ? 'bg-accent-soft text-accent' : ''
                  }`}
                >
                  <History size={14} />
                  <ChevronDown size={12} className={`transition-transform ${historyOpen ? 'rotate-180' : ''}`} />
                </button>
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                {query ? (
                  <button
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-faint hover:text-text"
                    title="清空"
                    onClick={handleClear}
                  >
                    <X size={14} />
                  </button>
                ) : null}
                <button
                  className="flex h-8 w-12 items-center justify-center rounded-lg bg-accent-soft text-accent hover:bg-accent/20 whitespace-nowrap"
                  title="搜索"
                  onClick={() => void doSearch(query)}
                >
                  {searching ? <Spinner size={14} /> : <Search size={14} />}
                </button>
              </div>

              {/* 下拉面板：标签页 = 搜索历史 / 书签 */}
              {historyOpen ? (
                <div
                  className="absolute left-0 right-0 top-12 z-30 overflow-hidden rounded-xl border border-border bg-elev1 shadow-xl"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-1 border-b border-border bg-elev2/60 px-2 pt-2">
                    {(
                      [
                        { id: 'history' as const, label: '搜索历史', count: history.length },
                        { id: 'marks' as const, label: '书签', count: lists.length }
                      ]
                    ).map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setHistoryTab(t.id)}
                        className={`rounded-t-lg px-3 py-1.5 text-xs transition-colors whitespace-nowrap ${
                          historyTab === t.id
                            ? 'bg-elev1 font-medium text-accent'
                            : 'text-faint hover:text-text'
                        }`}
                      >
                        {t.label}
                        <span className="ml-1 tabular-nums text-[10px] text-faint">{t.count}</span>
                      </button>
                    ))}
                  </div>

                  <div className="max-h-64 overflow-y-auto p-2">
                    {historyTab === 'history' ? (
                      history.length === 0 ? (
                        <div className="px-2 py-6 text-center text-[11px] text-faint">
                          暂无搜索记录（上限 {HISTORY_LIMIT} 条）
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {history.map((h) => (
                            <button
                              key={`${h.kw}-${h.at}`}
                              title={`${h.kw}\n${dayjs(h.at).format('YYYY-MM-DD HH:mm')}`}
                              onClick={() => {
                                setHistoryOpen(false)
                                void doSearch(h.kw)
                              }}
                              className="max-w-full truncate rounded-full border border-border bg-elev2 px-2.5 py-1 text-[11px] text-dim transition-colors hover:border-accent hover:text-accent"
                            >
                              {h.kw}
                            </button>
                          ))}
                        </div>
                      )
                    ) : lists.length === 0 ? (
                      <div className="px-2 py-6 text-center text-[11px] text-faint">还没有书签</div>
                    ) : (
                      <ul className="flex flex-col">
                        {lists.map((l) => {
                          const kw = (l.keyword ?? '').trim()
                          const count = markedCountOf(l.id)
                          return (
                            <li key={l.id}>
                              <button
                                onClick={() => {
                                  setHistoryOpen(false)
                                  // 有当初的关键词就重搜；没有（老数据）就直接打开这本书签
                                  if (kw) void doSearch(kw)
                                  else {
                                    setView('bookmark')
                                    setCurrentListId(l.id)
                                  }
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elev2"
                              >
                                <Bookmark size={12} className="shrink-0 text-accent" />
                                <span className="min-w-0 flex-1 truncate text-xs">{l.name}</span>
                                <span className="min-w-0 flex-1 truncate text-[11px] text-faint">
                                  {kw || '（未记录关键词）'}
                                </span>
                                <span className="shrink-0 text-[11px] text-faint tabular-nums">{count} 条</span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>

                  {/* 底部：数量 + 清空（只有历史页需要） */}
                  <div className="flex items-center justify-between gap-2 border-t border-border bg-elev2/40 px-3 py-1.5">
                    <span className="text-[10px] text-faint">
                      {historyTab === 'history' ? `${history.length}/${HISTORY_LIMIT} 条记录` : `${lists.length} 本书签`}
                    </span>
                    {historyTab === 'history' && history.length > 0 ? (
                      <button
                        className="flex items-center gap-1 text-[11px] text-faint transition-colors hover:text-danger"
                        onClick={() => {
                          clearHistory()
                          toast.info('已清空搜索历史')
                        }}
                      >
                        <Trash2 size={12} /> 清空历史
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              </div>
            </div>
          </div>
          <Button icon={BookmarkPlus} className="shrink-0" onClick={openCreate}>
            添加书签
          </Button>
        </div>
      </div>

      {/*
        搜索历史曾经是这里的一条常驻横条；v0.2.12 起收进搜索框左侧的**下拉式标签页**
        （见上方输入框内的按钮与面板）—— 用户要求「搜索历史需要改成下拉式标签页」，
        顺带把顶部这一整行高度还给搜索结果。
      */}

      {/*
        主体：结果占满整宽，书签做成贴着右边缘的悬浮长条卡片。
        （旧的左侧书签列已删除：它常驻 150~190px，小窗口下把结果行挤得没法看。）
      */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          className={`h-full overflow-y-auto overflow-x-hidden py-4 pl-3 sm:pl-5 ${
            stripDocked ? GUTTER_OPEN : GUTTER
          } ${hasListContent ? LIST_BOTTOM_PAD : ''}`}
        >
          {view === 'bookmark' ? (
            currentList ? (
              <div>
                {/* 书签内容视图标题：书名 + 条目数 + 返回搜索结果 */}
                <div className="mb-3 flex min-w-0 items-center gap-2">
                  <span className="line-clamp-1 min-w-0 text-sm font-semibold">
                    {currentList.name}
                  </span>
                  <span className="shrink-0 text-xs text-faint tabular-nums">{currentCount} 条</span>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={ChevronLeft}
                    className="ml-auto shrink-0"
                    onClick={() => setView('search')}
                  >
                    返回搜索
                  </Button>
                </div>

                {currentGroups.length === 0 ? (
                  <div className="py-12 text-center text-[11px] leading-relaxed text-faint">
                    「{currentList.name}」还没有条目
                    <br />
                    把搜索结果拖到右侧书签条上，或点结果行右侧的书签按钮
                  </div>
                ) : (
                  <div className="space-y-4">
                    {currentGroups.map(([date, groupItems]) => (
                      <div key={date}>
                        <div className="mb-2 flex items-center gap-2">
                          <span className="text-[11px] font-medium text-dim tabular-nums">
                            {date}
                          </span>
                          <span className="text-[10px] text-faint">{groupItems.length} 条</span>
                        </div>
                        <div className="space-y-1.5">
                          {groupItems.map((it) => (
                            <div
                              key={it.id}
                              onClick={() => openItem(it)}
                              className="group flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-elev1 p-2 transition-colors hover:border-accent"
                            >
                              <CoverImage
                                src={it.cover}
                                className="h-14 w-10 shrink-0 rounded-md"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="line-clamp-2 text-xs font-medium leading-snug">
                                  {it.title}
                                </div>
                                <div className="text-[10px] text-faint tabular-nums">
                                  {dayjs(it.addedAt).format('HH:mm')}
                                </div>
                              </div>
                              <IconButton
                                title="移除该条目"
                                className="shrink-0 hover:!text-danger"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  removeMark(it.id)
                                  toast.info('已移除该条目')
                                }}
                              >
                                <X size={13} />
                              </IconButton>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null
          ) : searching && results.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-14 text-xs text-faint">
              <Spinner size={16} /> 正在搜索…
            </div>
          ) : results.length > 0 ? (
            <div>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold">搜索结果</span>
                <span className="text-xs text-faint">{results.length} 部</span>
              </div>
              <div className="flex flex-col gap-2">
                {results.map((item) => {
                  const subject = toDragSubject(item)
                  const marked = currentList ? isMarked(currentList.id, item.id) : false
                  const year = yearOf(item.air_date)
                  return (
                    <div
                      key={item.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'copy'
                        e.dataTransfer.setData(DRAG_MIME, JSON.stringify(subject))
                        e.dataTransfer.setData('text/plain', subject.title)
                        setDragSubject(subject)
                      }}
                      onDragEnd={resetDrag}
                      onClick={() => openSubject(String(item.id))}
                      className="group flex cursor-grab items-center gap-3 rounded-xl border border-border bg-elev1 p-2.5 transition-colors hover:border-accent active:cursor-grabbing"
                    >
                      <GripVertical
                        size={13}
                        className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100"
                      />
                      <CoverImage
                        src={item.images?.large ?? item.images?.common ?? null}
                        className="h-16 w-12 shrink-0 rounded-md"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-1 text-sm font-medium">
                          {item.name_cn || item.name}
                        </div>
                        {item.name_cn && item.name !== item.name_cn ? (
                          <div className="line-clamp-1 text-xs text-faint">{item.name}</div>
                        ) : null}
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                          {item.rating?.score ? (
                            <span className="flex items-center gap-0.5 text-warn">
                              <Star size={10} fill="currentColor" /> {item.rating.score.toFixed(1)}
                            </span>
                          ) : (
                            <span>暂无评分</span>
                          )}
                          <span>{year ? `${year} 年` : '年份未知'}</span>
                        </div>
                      </div>
                      <IconButton
                        title={
                          marked
                            ? `已在「${currentList?.name ?? ''}」中，点击管理`
                            : '加入书签'
                        }
                        active={marked}
                        className="shrink-0"
                        onClick={(e) => {
                          e.stopPropagation()
                          setPickFor(item)
                          setPickOpen(true)
                        }}
                      >
                        <Bookmark size={14} fill={marked ? 'currentColor' : 'none'} />
                      </IconButton>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            /*
              空态（初次进入 / 没搜到结果）：原来只有一段居中的文案，整页看着很空。
              现在下面接一块轮播展示位（用户可自定义图片与切换间隔），把空白填满。
              文案区不缩小、滚动/拖拽等行为都不变 —— 展示位只是补在文案下方。
            */
            <div className="flex min-h-full flex-col">
              {searched ? (
                <EmptyState
                  icon={Search}
                  title="没有搜索到结果"
                  desc={
                    searchError
                      ? `${searchError}\n可点下方按钮检查/切换数据源`
                      : '换个关键词试试；若一直失败，可到设置里检查数据源是否可用'
                  }
                />
              ) : (
                <EmptyState
                  icon={Search}
                  title="搜索番剧"
                  desc="输入关键词后回车开始搜索，结果可直接拖到右侧书签条；点书签条上的书签可查看详情、重新搜索或管理条目"
                />
              )}
              {emptyShowcase}
            </div>
          )}
        </div>

        {/*
          底部展示位：自制小广告窗，定时轮播 + 右键菜单管理（小窗口下缩一档，别把结果列表挤没）。
          空态时改由上面的「emptyShowcase」以主内容形态呈现（同一份图片列表、同一份间隔设置），
          这里就不再渲染，避免同屏出现两个轮播。
        */}
        {emptyShowcaseOpen ? null : (
          <ImageCarousel
            images={showcase}
            onUpload={() => void uploadShowcase()}
            onDeleteCurrent={(path) => {
              removeShowcase(path)
              toast.info('已删除当前展示图片')
            }}
            onClearAll={() => {
              clearShowcase()
              toast.info('已清空展示图片')
            }}
            intervalSec={carouselSec}
            className={
              SMALL
                ? `absolute bottom-3 h-[96px] w-[200px] ${stripDocked ? CAROUSEL_RIGHT_OPEN : CAROUSEL_RIGHT}`
                : `absolute bottom-4 h-[110px] w-[240px] sm:h-[124px] sm:w-[320px] ${stripDocked ? CAROUSEL_RIGHT_OPEN : CAROUSEL_RIGHT}`
            }
          />
        )}

        {/*
          书签条：贴在结果区右侧的悬浮长条卡片。
          - 常驻：一条 36px 的细把手（图标 + 竖排「书签」+ 数量），保证「有书签」这件事永远看得见；
          - 抽出：hover / 点把手固定 / 拖拽中 三种情况展开；
          - 外层 pointer-events-none：只有把手和抽出的面板吃鼠标事件，
            收起时把手以外的空白不会挡住卡片的点击（右侧还留了滚动条的 10px 内缩）。
        */}
        <aside
          ref={stripRef}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onDragOver={(e) => {
            if (!dragSubject) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            if (!draggingOver) setDraggingOver(true)
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            setDraggingOver(false)
            setDragOverListId(null)
          }}
          onDrop={dropOnStrip}
          className={`pointer-events-none absolute inset-y-0 right-0 z-30 flex items-stretch justify-end py-3 ${STRIP_INSET}`}
        >
          {/* 书签详情弹窗：贴在抽出的列表左边，点书签行打开 */}
          {activeMark ? (
            <div className="pointer-events-auto mr-2 max-h-full w-[264px] shrink-0 self-start overflow-y-auto rounded-xl border border-border bg-elev1/95 p-3 shadow-2xl backdrop-blur">
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-[13px] font-semibold">{activeMark.name}</div>
                  <div className="mt-0.5 text-[10px] text-faint tabular-nums">
                    {activeItems.length} 条 · 创建于{' '}
                    {dayjs(activeMark.createdAt).format('YYYY-MM-DD')}
                  </div>
                </div>
                <IconButton title="关闭" onClick={() => setActiveListId(null)}>
                  <X size={13} />
                </IconButton>
              </div>

              {/* 关键词：创建书签时搜索框里的词，点它即可重跑一次搜索 */}
              <div className="mt-2">
                <div className="text-[10px] text-faint">搜索关键词</div>
                {activeKeyword ? (
                  <button
                    type="button"
                    title={`重新搜索「${activeKeyword}」`}
                    onClick={() => research(activeMark)}
                    className="mt-1 flex max-w-full items-center gap-1 rounded-lg bg-elev2 px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent-soft"
                  >
                    <Search size={11} className="shrink-0" />
                    <span className="truncate">{activeKeyword}</span>
                  </button>
                ) : (
                  <div className="mt-1 text-[11px] leading-relaxed text-faint">
                    这本书签没有记录关键词，也没有条目可以拿来重搜
                  </div>
                )}
              </div>

              {/* 条目预览：点条目直接进详情页（沿用旧书签列里条目行的行为） */}
              <div className="mt-2.5 space-y-1">
                {activeItems.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-2 py-2 text-[11px] leading-relaxed text-faint">
                    还没有条目：把搜索结果拖到书签条上即可加入
                  </div>
                ) : (
                  activeItems.slice(0, POPOVER_ROWS).map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => openItem(it)}
                      className="flex w-full items-center gap-2 rounded-lg border border-border bg-elev1 p-1.5 text-left transition-colors hover:border-accent"
                    >
                      <CoverImage src={it.cover} className="h-10 w-7 shrink-0 rounded" />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-[11px] leading-snug">{it.title}</span>
                        <span className="block text-[10px] text-faint tabular-nums">
                          {dayjs(it.addedAt).format('MM-DD HH:mm')}
                        </span>
                      </span>
                    </button>
                  ))
                )}
                {activeItems.length > POPOVER_ROWS ? (
                  <div className="px-1 text-[10px] text-faint">
                    还有 {activeItems.length - POPOVER_ROWS} 条，点「查看条目」看全部
                  </div>
                ) : null}
              </div>

              {/* 操作：旧左侧书签列的三种行为（查看 / 重命名 / 删除）+ 按关键词重搜 */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
                <Button
                  size="sm"
                  variant="soft"
                  icon={Search}
                  disabled={!activeKeyword}
                  title={activeKeyword ? `重新搜索「${activeKeyword}」` : '该书签没有可重搜的关键词'}
                  onClick={() => research(activeMark)}
                >
                  重新搜索
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={ChevronLeft}
                  onClick={() => viewItems(activeMark.id)}
                >
                  查看条目
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Pencil}
                  onClick={() => openRename(activeMark.id, activeMark.name)}
                >
                  重命名
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={Trash2}
                  onClick={() =>
                    confirmRemoveList(activeMark.id, activeMark.name, activeItems.length)
                  }
                >
                  删除
                </Button>
              </div>
            </div>
          ) : null}

          {/*
            抽出的书签列表：宽度 0 → 212px；内层用固定宽度，
            抽出的补间过程中文字不会跟着逐帧重排。
            与把手之间不留间距 —— 留了的话鼠标从把手移向面板时会经过一个
            指针落在「条外」的空隙，hover 会被判成离开而中途收起。
          */}
          <div
            className={`pointer-events-auto flex max-h-full overflow-hidden rounded-l-2xl border border-r-0 bg-elev1/95 shadow-xl backdrop-blur transition-[width] duration-200 ${
              stripOpen ? 'w-[212px] border-border' : 'w-0 border-transparent'
            } ${draggingOver ? 'ring-2 ring-inset ring-accent' : ''}`}
          >
            <div className="flex h-full w-[212px] flex-col">
              {/* 条头：名称 + 数量 + 添加（记为当前搜索框里的关键词） */}
              <div className="flex shrink-0 items-center gap-1 border-b border-border px-2.5 py-2">
                <Bookmark size={13} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">书签</span>
                <span className="shrink-0 text-[11px] text-faint tabular-nums">
                  {lists.length}
                </span>
                <IconButton title="添加书签（记为当前关键词）" onClick={openCreate}>
                  <Plus size={14} />
                </IconButton>
              </div>

              {/* 滑动列表：超过 STRIP_ROWS 先只铺这些，剩下的折进「+N」 */}
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden p-1.5">
                {stripLists.map((l) => {
                  const active = currentList?.id === l.id
                  const count = markedCountOf(l.id)
                  const kw = l.keyword?.trim()
                  return (
                    <div
                      key={l.id}
                      onDragOver={(e) => {
                        if (!dragSubject) return
                        e.preventDefault()
                        e.stopPropagation() // 行内自己处理，不再让整条书签条也高亮
                        e.dataTransfer.dropEffect = 'copy'
                        if (dragOverListId !== l.id) setDragOverListId(l.id)
                      }}
                      onDragLeave={(e) => {
                        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                        setDragOverListId((prev) => (prev === l.id ? null : prev))
                      }}
                      onDrop={(e) => dropOnList(e, l.id)}
                      className={`relative rounded-lg border transition-colors ${
                        active ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-elev2'
                      } ${dragOverListId === l.id ? 'ring-2 ring-inset ring-accent' : ''}`}
                    >
                      <button
                        type="button"
                        className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left"
                        title={`查看「${l.name}」的详情与条目${kw ? ` · 关键词 ${kw}` : ''}`}
                        onClick={() => pickList(l.id)}
                      >
                        {active ? (
                          <BookmarkCheck size={13} className="shrink-0 text-accent" />
                        ) : (
                          <Bookmark size={13} className="shrink-0 text-faint" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block truncate text-xs font-medium ${active ? 'text-accent' : ''}`}
                          >
                            {l.name}
                          </span>
                          <span className="block truncate text-[10px] text-faint tabular-nums">
                            {count} 条
                            {kw ? ` · ${kw}` : ''}
                          </span>
                        </span>
                      </button>
                    </div>
                  )
                })}

                {lists.length > STRIP_ROWS ? (
                  <button
                    type="button"
                    onClick={() => setShowAllMarks((v) => !v)}
                    className="w-full rounded-lg px-2 py-1.5 text-[11px] text-faint transition-colors hover:bg-elev2 hover:text-accent whitespace-nowrap"
                  >
                    {showAllMarks ? '收起' : `+${lists.length - STRIP_ROWS} 个书签`}
                  </button>
                ) : null}

                {lists.length === 0 ? (
                  // 条只有 212px 宽，EmptyState 的大图标 + 长文案会撑破条宽，这里用紧凑版空态
                  <div className="px-2 py-6 text-center">
                    <Bookmark size={18} className="mx-auto text-faint" />
                    <div className="mt-2 text-[11px] leading-relaxed text-faint">还没有书签</div>
                    <Button
                      variant="soft"
                      size="sm"
                      icon={BookmarkPlus}
                      className="mt-2"
                      onClick={openCreate}
                    >
                      添加
                    </Button>
                  </div>
                ) : null}
              </div>

              {/* 底部提示：拖拽进行中换成落点说明，平时说明「拖到这里」的用法 */}
              <div
                className={`shrink-0 border-t border-border px-2.5 py-1.5 text-[10px] leading-snug ${
                  dragSubject ? 'bg-accent-soft text-accent' : 'text-faint'
                }`}
              >
                <span className="line-clamp-2">
                  {dragSubject
                    ? `松手把《${dragSubject.title}》加入所停的那一行；停在空白处则加入「${currentList?.name ?? '新建书签'}」`
                    : '把搜索结果拖到书签条上即可加入'}
                </span>
              </div>
            </div>
          </div>

          {/* 把手：常驻可见的发现入口，点一下固定展开 / 收起 */}
          <button
            type="button"
            title={stripOpen ? '收起书签条' : '展开书签条（也可把搜索结果拖到这里）'}
            onClick={toggleStrip}
            className={`pointer-events-auto flex w-9 shrink-0 flex-col items-center gap-2 rounded-lg border bg-elev1/95 py-2.5 shadow-lg backdrop-blur transition-colors ${
              stripOpen
                ? 'border-accent text-accent'
                : 'border-border text-dim hover:border-accent hover:text-accent'
            } ${draggingOver ? 'ring-2 ring-inset ring-accent' : ''}`}
          >
            <Bookmark size={13} className="shrink-0" />
            {/* 把手只有 36px 宽，横排的「书签」会被截断，用 writing-mode 竖排 */}
            <span
              className="text-[11px] font-medium tracking-widest"
              style={{ writingMode: 'vertical-rl' }}
            >
              书签
            </span>
            <span className="shrink-0 text-[10px] tabular-nums">{lists.length}</span>
          </button>
        </aside>
      </div>

      {/* 添加 / 重命名书签：都能在这里改名字，回车即确认 */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={editMode === 'create' ? '添加书签' : '重命名书签'}
        width={420}
      >
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-[11px] text-faint">书签名称</div>
            <Input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitEdit()
              }}
              placeholder={`留空则自动命名为「${defaultListName(lists)}」`}
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <Button variant="ghost" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button icon={editMode === 'create' ? Plus : Check} onClick={submitEdit}>
              {editMode === 'create' ? '创建书签' : '保存'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* 快速标记弹窗：从结果卡片书签按钮进入，可勾选多个书签 */}
      <Modal open={pickOpen} onClose={() => setPickOpen(false)} title="加入书签" width={460}>
        {pickFor ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-elev2/50 p-2.5">
              <CoverImage
                src={pickFor.images?.large ?? pickFor.images?.common ?? null}
                className="h-14 w-10 shrink-0 rounded-md"
              />
              <div className="min-w-0">
                <div className="line-clamp-1 text-sm font-medium">
                  {pickFor.name_cn || pickFor.name}
                </div>
                {pickFor.name_cn && pickFor.name !== pickFor.name_cn ? (
                  <div className="line-clamp-1 text-[11px] text-faint">{pickFor.name}</div>
                ) : null}
              </div>
            </div>

            <div className="space-y-1.5">
              {lists.length === 0 ? (
                <div className="py-6 text-center text-[11px] text-faint">
                  还没有书签，在下方新建一个即可直接标记
                </div>
              ) : null}
              {lists.map((l) => {
                const existing = items.find(
                  (it) => it.listId === l.id && it.subjectId === pickFor.id
                )
                return (
                  <button
                    key={l.id}
                    onClick={() => toggleInList(l.id, toDragSubject(pickFor))}
                    className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                      existing
                        ? 'border-accent bg-accent-soft'
                        : 'border-border bg-elev1 hover:border-accent'
                    }`}
                  >
                    {existing ? (
                      <BookmarkCheck size={14} className="shrink-0 text-accent" />
                    ) : (
                      <Bookmark size={14} className="shrink-0 text-faint" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-1 text-xs font-medium">{l.name}</div>
                      <div className="text-[10px] text-faint tabular-nums">
                        {markedCountOf(l.id)} 条
                      </div>
                    </div>
                    <Badge tone={existing ? 'accent' : 'neutral'}>
                      {existing ? '已标记' : '加入'}
                    </Badge>
                  </button>
                )
              })}
            </div>

            <div className="flex items-center gap-2 border-t border-border pt-4">
              <Input
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createAndMark()
                }}
                placeholder="新书签名称（留空自动命名）"
              />
              <Button icon={Plus} className="shrink-0" onClick={createAndMark}>
                新建并标记
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* 删除书签：连同该书签下的条目一起删，二次确认后才执行 */}
      <ConfirmModal
        open={deleteOpen}
        title="删除书签"
        danger
        confirmText="删除"
        message={
          pendingDelete ? (
            <>
              确定删除书签「{pendingDelete.name}」？其中的 {pendingDelete.count} 条条目会一并删除，
              且无法恢复。
            </>
          ) : null
        }
        onConfirm={() => {
          if (!pendingDelete) return
          removeList(pendingDelete.id)
          // 弹窗正开着这本书签时一起关掉，否则会留下一个指向已删书签的空弹窗
          if (activeListId === pendingDelete.id) setActiveListId(null)
          // 主区域正在展示这个书签时，内容已经不存在了：切回搜索结果，避免留下一块空白视图
          if (view === 'bookmark' && currentList?.id === pendingDelete.id) setView('search')
          toast.info(`已删除「${pendingDelete.name}」`)
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  )
}

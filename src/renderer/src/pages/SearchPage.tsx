import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import {
  Bookmark,
  BookmarkCheck,
  BookmarkPlus,
  Check,
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
import type { MarkItem, SearchResultItem } from '@shared/types'
import { api } from '@/lib/api'
import { yearOf } from '@/lib/format'
import { HISTORY_LIMIT, defaultListName, useMarks } from '@/stores/marks'
import { toast } from '@/stores/app'
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
 * 左侧书签列宽度：始终是「竖列」形态，只随窗口大小收窄。
 * 小窗口（约 760×560）下若继续用 190px，主区域只剩 ~570px，
 * 搜索结果行会变得拥挤，所以收窄到 150px；两档都不低于 140px，
 * 保证「名称 + 条目数」仍能读出来。
 */
const COLUMN_WIDTH = SMALL ? 'w-[150px]' : 'w-[190px]'

/**
 * 内容列表底部留白：底部展示位（轮播）是浮在内容之上的绝对定位元素，
 * 不留白就会出现「滚到底也看不到最后一条」的情况。
 */
const LIST_BOTTOM_PAD = 'pb-40'

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

export function SearchPage() {
  const navigate = useNavigate()
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

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searched, setSearched] = useState(false)

  /** 主区域当前展示什么：搜索结果，还是某个书签的条目 */
  const [view, setView] = useState<MainView>('search')

  /** 当前书签 = 拖拽落点 + 主区域正在展示的书签（点书签时两者一起切，用户不会看到"高亮的"和"看到的"不是一本） */
  const [currentListId, setCurrentListId] = useState<string | null>(null)
  const [dragSubject, setDragSubject] = useState<DragSubject | null>(null)
  const [dragOver, setDragOver] = useState(false)

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

  // 当前书签：被删除或首次加载后自动落到第一个，保证「拖拽目标」始终存在
  const currentList = useMemo(
    () => lists.find((l) => l.id === currentListId) ?? lists[0] ?? null,
    [lists, currentListId]
  )

  useEffect(() => {
    if (lists.length === 0) {
      if (currentListId !== null) setCurrentListId(null)
      return
    }
    if (!lists.some((l) => l.id === currentListId)) setCurrentListId(lists[0].id)
  }, [lists, currentListId])

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

  const openItem = (item: MarkItem): void => {
    const id = item.link || (item.subjectId != null ? String(item.subjectId) : '')
    if (!id) return
    // 带上来源标记：详情页据此把「返回」变成回到搜索列表（v0.2.4 导航链）
    navigate(`/subject/${id}`, { state: { from: 'search' } })
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

  /** 拖拽落点：没有书签时先建一个，否则拖拽会因为「无目标」而变成一次无效操作 */
  const dropIntoCurrent = (subject: DragSubject): void => {
    const target = currentList
    if (!target) {
      const created = createList()
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

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    setDragSubject(null)
    let subject: DragSubject | null = dragSubject
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (isDragSubject(parsed)) subject = parsed
      } catch {
        /* 载荷非法时退回内存中的拖拽源 */
      }
    }
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
      const created = createList(name)
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

  /**
   * 点击书签：选中它（同时成为拖拽落点），并把主区域切到「书签条目」视图。
   * v0.2.7 起不再弹出 Modal —— 弹窗会盖住搜索结果，而这里的条目本来就更适合占满主区域。
   */
  const openBookmark = (id: string): void => {
    setCurrentListId(id)
    setView('bookmark')
  }

  const confirmRemoveList = (id: string, name: string, count: number): void => {
    setPendingDelete({ id, name, count })
    setDeleteOpen(true)
  }

  /** 快速标记弹窗里「新建并标记」 */
  const createAndMark = (): void => {
    const target = pickFor
    const created = createList(newListName)
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

  // ---------------- 底部展示位（轮播） ----------------

  /** 上传展示图片：对话框返回绝对路径数组，为空表示用户取消 */
  const uploadShowcase = async (): Promise<void> => {
    const r = await api.dialog.pickImages()
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (r.data.length === 0) return // 用户取消，不打扰
    // 去重交给 store：同一张图重复加入只会让轮播停在同图上
    const added = addShowcase(r.data)
    if (added === 0) toast.info('所选图片已在展示列表中')
    else toast.success(`已添加 ${added} 张展示图片`)
  }

  const markedCountOf = (listId: string): number => items.filter((it) => it.listId === listId).length

  // 主区域是否有需要避让底部展示位的内容
  const hasListContent =
    view === 'bookmark' ? currentCount > 0 : results.length > 0

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
                }}
                placeholder="搜索番剧，回车开始搜索；结果可拖到左侧书签…"
                className="h-10 w-full rounded-xl border border-border bg-elev1 pl-4 pr-24 text-sm outline-none transition-colors placeholder:text-faint focus:border-accent"
              />
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
                  className="flex h-8 w-12 items-center justify-center rounded-lg bg-accent-soft text-accent hover:bg-accent/20"
                  title="搜索"
                  onClick={() => void doSearch(query)}
                >
                  {searching ? <Spinner size={14} /> : <Search size={14} />}
                </button>
              </div>
            </div>
          </div>
          <Button icon={BookmarkPlus} className="shrink-0" onClick={openCreate}>
            添加书签
          </Button>
        </div>
      </div>

      {/* 搜索历史：始终显示在结果上方，点击即重新搜索 */}
      <div className="flex items-center gap-2 border-b border-border bg-elev1/40 px-4 py-2 sm:px-5">
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-faint">
          <History size={12} /> 搜索历史
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {history.map((h) => (
            <button
              key={`${h.kw}-${h.at}`}
              title={dayjs(h.at).format('YYYY-MM-DD HH:mm')}
              onClick={() => void doSearch(h.kw)}
              className="shrink-0 rounded-full border border-border bg-elev1 px-2.5 py-1 text-[11px] text-dim transition-colors hover:border-accent hover:text-accent"
            >
              {h.kw}
            </button>
          ))}
          {history.length === 0 ? <span className="text-[11px] text-faint">暂无记录</span> : null}
        </div>
        <span className="shrink-0 text-[11px] text-faint tabular-nums">
          {history.length}/{HISTORY_LIMIT}
        </span>
        {history.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            icon={Trash2}
            className="shrink-0"
            onClick={() => {
              clearHistory()
              toast.info('已清空搜索历史')
            }}
          >
            清空历史
          </Button>
        ) : null}
      </div>

      {/* 主体：左侧书签竖列（固定宽度、独立滚动）+ 右侧主区域（搜索 / 书签内容二选一） */}
      <div className="flex min-h-0 flex-1">
        {/*
          书签列：整列都是拖拽落点，落点 = 当前选中的书签。
          这里**不**用任何 lg:/sm: 断点切换方向 —— 产品要求小窗口下也保持「左侧竖列」，
          一旦退化成底部横排，窄窗口里书签会挤成一排看不清的标签。
        */}
        <aside
          onDragOver={(e) => {
            if (!dragSubject) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            if (!dragOver) setDragOver(true)
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            setDragOver(false)
          }}
          onDrop={onDrop}
          className={`flex ${COLUMN_WIDTH} min-h-0 shrink-0 flex-col border-r border-border bg-elev1/50 transition-shadow ${
            dragOver ? 'ring-2 ring-inset ring-accent' : ''
          }`}
        >
          <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border px-2 py-2">
            <span className="flex min-w-0 items-center gap-1 text-xs font-semibold">
              <Bookmark size={13} className="shrink-0 text-accent" />
              <span className="truncate">书签</span>
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              <span className="text-[11px] text-faint tabular-nums">{lists.length}</span>
              <IconButton title="添加书签" onClick={openCreate}>
                <Plus size={14} />
              </IconButton>
            </div>
          </div>

          {/* 滑动列表：书签多到超出列高时在这里滚动，列头与落点提示始终留在视口内 */}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden p-1.5">
            {lists.map((l) => {
              const active = currentList?.id === l.id
              const count = markedCountOf(l.id)
              return (
                <div
                  key={l.id}
                  className={`group relative rounded-lg border transition-colors ${
                    active ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-elev2'
                  }`}
                >
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left"
                    title={`查看「${l.name}」中的条目 · 创建于 ${dayjs(l.createdAt).format('YYYY-MM-DD')}`}
                    onClick={() => openBookmark(l.id)}
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
                      <span className="block text-[10px] text-faint tabular-nums">{count} 条</span>
                    </span>
                  </button>

                  {/*
                    重命名 / 删除：窄列里常驻两个按钮会把书名挤没，
                    所以做成悬停浮现的浮层（focus-within 让键盘 Tab 也能用），
                    浮层带不透明底色，盖住的是名称尾部而不是叠加出重影。
                  */}
                  <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-lg bg-elev1/95 px-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <IconButton
                      title="重命名书签"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation()
                        openRename(l.id, l.name)
                      }}
                    >
                      <Pencil size={12} />
                    </IconButton>
                    <IconButton
                      title="删除书签"
                      // ! 前缀是有意的：IconButton 基类带了 hover:text-text，不加 important 覆盖不掉
                      className="h-7 w-7 hover:!text-danger"
                      onClick={(e) => {
                        e.stopPropagation()
                        confirmRemoveList(l.id, l.name, count)
                      }}
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  </div>
                </div>
              )
            })}

            {lists.length === 0 ? (
              // 列只有 150~190px 宽，EmptyState 的大图标 + 长文案会撑破列宽，这里用紧凑版空态
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

          {/* 底部提示：拖拽进行中换成落点说明，平时说明当前落点是哪个书签 */}
          <div
            className={`shrink-0 border-t border-border px-2 py-1.5 text-[10px] leading-snug ${
              dragSubject ? 'bg-accent-soft text-accent' : 'text-faint'
            }`}
          >
            <span className="line-clamp-2">
              {dragSubject
                ? `松手加入「${currentList?.name ?? '新建书签'}」`
                : `落点：${currentList?.name ?? '—'}`}
            </span>
          </div>
        </aside>

        {/* 主区域：相对定位，绝对定位的底部展示位（轮播）挂在这里 */}
        <div className="relative min-w-0 min-h-0 flex-1 overflow-hidden">
          <div
            className={`h-full overflow-y-auto overflow-x-hidden px-3 py-4 sm:px-5 ${
              hasListContent ? LIST_BOTTOM_PAD : ''
            }`}
          >
            {view === 'bookmark' ? (
              currentList ? (
                <div>
                  {/* 书签内容视图标题：书名 + 条目数 + 返回搜索结果 */}
                  <div className="mb-3 flex min-w-0 items-center gap-2">
                    <span className="line-clamp-1 min-w-0 text-sm font-semibold">
                      {currentList.name}
                    </span>
                    <span className="shrink-0 text-xs text-faint tabular-nums">
                      {currentCount} 条
                    </span>
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
                      把左侧搜索结果拖到书签列，或点结果行右侧的书签按钮
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
                        onDragEnd={() => {
                          setDragSubject(null)
                          setDragOver(false)
                        }}
                        onClick={() =>
                          navigate(`/subject/${item.id}`, { state: { from: 'search' } })
                        }
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
            ) : searched ? (
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
                desc="输入关键词后回车开始搜索，结果可直接拖到左侧书签列；点击书签即在此处查看其中的条目"
              />
            )}
          </div>

          {/* 底部展示位：自制小广告窗，定时轮播 + 右键菜单管理（小窗口下缩一档，别把结果列表挤没） */}
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
            className={
              SMALL
                ? 'absolute bottom-3 right-3 h-[96px] w-[200px]'
                : 'absolute bottom-4 right-4 h-[110px] w-[240px] sm:h-[124px] sm:w-[320px]'
            }
          />
        </div>
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
          <div className="flex justify-end gap-2 border-t border-border pt-4">
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
          // 主区域正在展示这个书签时，内容已经不存在了：切回搜索结果，避免留下一块空白视图
          if (view === 'bookmark' && currentList?.id === pendingDelete.id) setView('search')
          toast.info(`已删除「${pendingDelete.name}」`)
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  )
}

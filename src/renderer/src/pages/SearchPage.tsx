import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import {
  Bookmark,
  BookmarkCheck,
  BookmarkPlus,
  Check,
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
  const [searched, setSearched] = useState(false)

  /** 当前书签 = 拖拽落点；点击任一书签也会把它设为当前 */
  const [currentListId, setCurrentListId] = useState<string | null>(null)
  const [dragSubject, setDragSubject] = useState<DragSubject | null>(null)
  const [dragOver, setDragOver] = useState(false)

  // 快速标记弹窗：内容与开关分开存，关闭动画播放期间弹窗内不会闪烁成空白
  const [pickFor, setPickFor] = useState<SearchResultItem | null>(null)
  const [pickOpen, setPickOpen] = useState(false)
  const [newListName, setNewListName] = useState('')

  // 书签弹窗（点击书签后弹出其中的条目列表）；同样把内容与开关分开存
  const [detailListId, setDetailListId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

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

  // 弹窗里展示的书签按 id 实时推导：条目增删、改名都会立刻反映，而不是打开时的快照
  const detailList: MarkList | null = useMemo(
    () => lists.find((l) => l.id === detailListId) ?? null,
    [lists, detailListId]
  )
  const detailGroups = useMemo(() => {
    if (!detailList) return [] as [string, MarkItem[]][]
    const sorted = items
      .filter((it) => it.listId === detailList.id)
      .sort((a, b) => b.addedAt - a.addedAt)
    return groupByDate(sorted)
  }, [items, detailList])
  const detailCount = useMemo(
    () => detailGroups.reduce((n, [, arr]) => n + arr.length, 0),
    [detailGroups]
  )

  const doSearch = async (kw: string) => {
    const q = kw.trim()
    if (!q) {
      setResults([])
      setSearched(false)
      return
    }
    setQuery(q)
    setSearching(true)
    setSearched(true)
    // 先在输入时就记入历史：即使数据源全挂，用户也不该丢掉刚敲的关键词
    pushHistory(q)
    const r = await api.bangumi.search(q)
    setSearching(false)
    if (r.ok) setResults(r.data.items)
    else {
      setResults([])
      toast.error(r.error)
    }
  }

  const openItem = (item: MarkItem): void => {
    const id = item.link || (item.subjectId != null ? String(item.subjectId) : '')
    if (!id) return
    // 带上来源标记：详情页据此把「返回」变成回到搜索列表（v0.2.4 导航链）
    navigate(`/subject/${id}`, { state: { from: 'search' } })
  }

  /** 加入 / 移出某个书签（书签弹窗行点击与快速标记弹窗共用） */
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

  /** 点击书签：既把它设为拖拽落点，又弹出其中的条目列表 */
  const openBookmark = (id: string): void => {
    setCurrentListId(id)
    setDetailListId(id)
    setDetailOpen(true)
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

  return (
    <div className="flex h-full flex-col">
      {/* 顶部搜索框（回车或点击右侧按钮触发）+ 右上角「添加书签」 */}
      <div className="border-b border-border bg-elev1/70 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <div className="relative mx-auto max-w-xl">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doSearch(query)
                }}
                placeholder="搜索番剧，回车开始搜索；结果可拖到右侧书签…"
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
      <div className="flex items-center gap-2 border-b border-border bg-elev1/40 px-5 py-2">
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

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* 搜索结果：相对定位，右下角承载底部展示位（轮播） */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            className={`h-full overflow-y-auto px-5 py-4 ${
              results.length > 0 ? 'pb-40' : ''
            }`}
          >
            {searching && results.length === 0 ? (
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
                desc="换个关键词试试；若一直失败，可到设置里检查数据源是否可用"
              />
            ) : (
              <EmptyState
                icon={Search}
                title="搜索番剧"
                desc="输入关键词后回车开始搜索，结果可直接拖到右侧书签；点击书签可查看其中的条目"
              />
            )}
          </div>

          {/* 底部展示位：自制小广告窗，定时轮播 + 右键菜单管理 */}
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
            className="absolute bottom-4 right-4 h-[110px] w-[240px] sm:h-[124px] sm:w-[320px]"
          />
        </div>

        {/* 书签栏：宽屏在右侧，窄屏落到下方；整块都是拖拽落点 */}
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
          className={`flex max-h-[50%] min-h-0 w-full shrink-0 flex-col border-t border-border bg-elev1/50 transition-shadow lg:max-h-none lg:w-72 lg:border-l lg:border-t-0 ${
            dragOver ? 'ring-2 ring-inset ring-accent' : ''
          }`}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <Bookmark size={14} className="text-accent" /> 书签
            </span>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-faint tabular-nums">
                {lists.length} 个 · {items.length} 条
              </span>
              <IconButton title="添加书签" onClick={openCreate}>
                <Plus size={14} />
              </IconButton>
            </div>
          </div>

          {/* 书签列表：一个条目代表一个书签，点击即弹出其中的条目列表 */}
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {lists.map((l) => {
              const active = currentList?.id === l.id
              const count = markedCountOf(l.id)
              return (
                <div
                  key={l.id}
                  className={`group flex items-center gap-1 rounded-lg border px-2 py-1.5 transition-colors ${
                    active ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-elev2'
                  }`}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={`查看「${l.name}」中的条目`}
                    onClick={() => openBookmark(l.id)}
                  >
                    {active ? (
                      <BookmarkCheck size={13} className="shrink-0 text-accent" />
                    ) : (
                      <Bookmark size={13} className="shrink-0 text-faint" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div
                        className={`line-clamp-1 text-xs font-medium ${active ? 'text-accent' : ''}`}
                      >
                        {l.name}
                      </div>
                      <div className="text-[10px] text-faint tabular-nums">
                        {count} 条 · {dayjs(l.createdAt).format('YYYY-MM-DD')}
                      </div>
                    </div>
                  </button>
                  <IconButton
                    title="重命名书签"
                    className="shrink-0"
                    onClick={(e) => {
                      e.stopPropagation()
                      openRename(l.id, l.name)
                    }}
                  >
                    <Pencil size={12} />
                  </IconButton>
                  <IconButton
                    title="删除书签"
                    className="shrink-0 hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      confirmRemoveList(l.id, l.name, count)
                    }}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              )
            })}
            {lists.length === 0 ? (
              <EmptyState
                icon={Bookmark}
                title="还没有书签"
                desc="点右上角「添加书签」新建一个，然后把左侧搜索结果拖进来，或点结果右侧的书签按钮"
              >
                <Button variant="soft" size="sm" icon={BookmarkPlus} onClick={openCreate}>
                  添加书签
                </Button>
              </EmptyState>
            ) : null}
          </div>

          {/* 底部提示：拖拽进行中换成落点说明，平时说明当前书签是谁 */}
          {dragSubject ? (
            <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-accent-soft px-4 py-2 text-[11px] text-accent">
              <BookmarkCheck size={12} />
              拖到这里加入「{currentList?.name ?? '新建书签'}」
            </div>
          ) : (
            <div className="shrink-0 border-t border-border px-4 py-2 text-[11px] leading-relaxed text-faint">
              当前落点：{currentList?.name ?? '—'}。点击书签查看其中的条目，可重命名或删除。
            </div>
          )}
        </aside>
      </div>

      {/* 书签弹窗：点击书签后弹出该书的条目列表（按标记日期分组） */}
      <Modal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={detailList ? `书签 · ${detailList.name}` : '书签'}
        width={480}
      >
        {detailList ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-elev2/50 px-3 py-2.5">
              <div className="min-w-0">
                <div className="line-clamp-1 text-sm font-medium">{detailList.name}</div>
                <div className="text-[11px] text-faint tabular-nums">
                  {detailCount} 条 · 创建于 {dayjs(detailList.createdAt).format('YYYY-MM-DD')}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  icon={Pencil}
                  onClick={() => openRename(detailList.id, detailList.name)}
                >
                  重命名
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  icon={Trash2}
                  onClick={() => confirmRemoveList(detailList.id, detailList.name, detailCount)}
                >
                  删除
                </Button>
              </div>
            </div>

            {detailGroups.length === 0 ? (
              <div className="py-10 text-center text-[11px] leading-relaxed text-faint">
                「{detailList.name}」还没有条目
                <br />
                把左侧搜索结果拖到右侧书签栏，或点结果行右侧的书签按钮
              </div>
            ) : (
              <div className="space-y-4">
                {detailGroups.map(([date, groupItems]) => (
                  <div key={date}>
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-[11px] font-medium text-dim tabular-nums">{date}</span>
                      <span className="text-[10px] text-faint">{groupItems.length} 条</span>
                    </div>
                    <div className="space-y-1.5">
                      {groupItems.map((it) => (
                        <div
                          key={it.id}
                          onClick={() => openItem(it)}
                          className="group flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-elev1 p-2 transition-colors hover:border-accent"
                        >
                          <CoverImage src={it.cover} className="h-12 w-9 shrink-0 rounded-md" />
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
                            className="shrink-0 hover:text-danger"
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

            {/* 弹窗会盖住搜索结果，所以提醒用户：关闭本窗口后仍可拖拽加入 */}
            <div className="border-t border-border pt-3 text-[11px] leading-relaxed text-faint">
              点击条目进入番剧详情；关闭本窗口后可继续把搜索结果拖到右侧书签栏，落点就是「
              {detailList.name}」。
            </div>
          </div>
        ) : null}
      </Modal>

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
            <Button
              icon={editMode === 'create' ? Plus : Check}
              onClick={submitEdit}
            >
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
          // 正在查看这个书签时，弹窗里的内容已经不存在了，直接关掉避免留下空壳
          if (detailListId === pendingDelete.id) setDetailOpen(false)
          toast.info(`已删除「${pendingDelete.name}」`)
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  )
}

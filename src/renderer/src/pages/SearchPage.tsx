import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import {
  Bookmark,
  BookmarkCheck,
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
import { HISTORY_LIMIT, useMarks } from '@/stores/marks'
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

export function SearchPage() {
  const navigate = useNavigate()
  const {
    lists,
    items,
    history,
    loaded,
    load,
    createList,
    renameList,
    removeList,
    addMark,
    removeMark,
    isMarked,
    pushHistory,
    clearHistory
  } = useMarks()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)

  const [currentListId, setCurrentListId] = useState<string | null>(null)
  const [dragSubject, setDragSubject] = useState<DragSubject | null>(null)
  const [dragOver, setDragOver] = useState(false)

  // 标记弹窗：内容与开关分开存，关闭动画播放期间弹窗内不会闪烁成空白
  const [pickFor, setPickFor] = useState<SearchResultItem | null>(null)
  const [pickOpen, setPickOpen] = useState(false)
  const [newListName, setNewListName] = useState('')

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 删除列表确认：待删对象与开关分开存，退出动画期间弹窗内容不会闪成空白
  const [pendingDelete, setPendingDelete] = useState<{
    id: string
    name: string
    count: number
  } | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // 当前选中列表：列表被删除或首次加载后自动落到第一个，保证「标记目标」始终存在
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
    navigate(`/subject/${id}`)
  }

  /** 加入 / 移出某个列表（列表行点击与标记弹窗共用） */
  const toggleInList = (listId: string, subject: DragSubject): void => {
    const name = lists.find((l) => l.id === listId)?.name ?? ''
    const existing = items.find((it) => it.listId === listId && it.subjectId === subject.subjectId)
    if (existing) {
      removeMark(existing.id)
      toast.info(`已从「${name}」移除`)
      return
    }
    addMark(listId, subject)
    setCurrentListId(listId) // 顺手切到目标列表，用户能立刻看到刚标记的条目
    toast.success(`已加入「${name}」`)
  }

  /** 拖拽落点：没有列表时先建一个，否则拖拽会因为「无目标」而变成一次无效操作 */
  const dropIntoCurrent = (subject: DragSubject): void => {
    const target = currentList
    if (!target) {
      const created = createList()
      setCurrentListId(created.id)
      addMark(created.id, subject)
      toast.success(`已新建「${created.name}」并标记`)
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

  const handleCreateList = (): void => {
    const created = createList()
    setCurrentListId(created.id)
    toast.success(`已新建「${created.name}」`)
  }

  const createAndMark = (): void => {
    const target = pickFor
    const created = createList(newListName)
    setNewListName('')
    setCurrentListId(created.id)
    if (!target) {
      toast.success(`已新建「${created.name}」`)
      return
    }
    addMark(created.id, toDragSubject(target))
    toast.success(`已加入「${created.name}」`)
  }

  const startRename = (id: string, name: string): void => {
    setRenamingId(id)
    setRenameValue(name)
  }

  const commitRename = (): void => {
    const id = renamingId
    if (!id) return
    const name = renameValue.trim()
    setRenamingId(null)
    const before = lists.find((l) => l.id === id)?.name
    if (!name || name === before) return
    renameList(id, name)
    toast.success('已重命名')
  }

  const confirmRemoveList = (id: string, name: string, count: number): void => {
    setPendingDelete({ id, name, count })
    setDeleteOpen(true)
  }

  const handleClear = (): void => {
    setQuery('')
    setResults([])
    setSearched(false)
  }

  // 条目按标记日期分组（同一天归到一组，日期倒序）
  const groups = useMemo(() => {
    if (!currentList) return [] as [string, MarkItem[]][]
    const map = new Map<string, MarkItem[]>()
    const sorted = items
      .filter((it) => it.listId === currentList.id)
      .sort((a, b) => b.addedAt - a.addedAt)
    for (const it of sorted) {
      const key = dayjs(it.addedAt).format('YYYY-MM-DD')
      const arr = map.get(key)
      if (arr) arr.push(it)
      else map.set(key, [it])
    }
    return [...map.entries()]
  }, [items, currentList])

  const markedCountOf = (listId: string): number => items.filter((it) => it.listId === listId).length

  return (
    <div className="flex h-full flex-col">
      {/* 顶部搜索框（回车或点击右侧按钮触发） */}
      <div className="border-b border-border bg-elev1/70 px-5 py-3 backdrop-blur">
        <div className="relative mx-auto max-w-xl">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doSearch(query)
            }}
            placeholder="搜索番剧，回车开始搜索；结果可拖到右侧标记区域…"
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
        {/* 搜索结果 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
                      onClick={() => navigate(`/subject/${item.id}`)}
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
                        <div className="line-clamp-1 text-sm font-medium">{item.name_cn || item.name}</div>
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
                            : '加入标记列表'
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
              desc="输入关键词后回车开始搜索，结果可直接拖到右侧标记区域；标记过的番剧会按列表分组保存"
            />
          )}
        </div>

        {/* 标记区域：宽屏在右侧，窄屏落到下方；整块都是拖拽落点 */}
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
              <Bookmark size={14} className="text-accent" /> 标记区域
            </span>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-faint tabular-nums">共 {items.length} 条</span>
              <IconButton title="新建标记列表" onClick={handleCreateList}>
                <Plus size={14} />
              </IconButton>
            </div>
          </div>

          {/* 列表选择：选中的列表接收拖拽落点 */}
          <div className="max-h-44 shrink-0 space-y-1 overflow-y-auto border-b border-border p-2">
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
                  {renamingId === l.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      className="h-7 min-w-0 flex-1 rounded-md border border-accent bg-elev1 px-2 text-xs outline-none"
                    />
                  ) : (
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setCurrentListId(l.id)}
                      onDoubleClick={() => startRename(l.id, l.name)}
                    >
                      <div
                        className={`line-clamp-1 text-xs font-medium ${active ? 'text-accent' : ''}`}
                      >
                        {l.name}
                      </div>
                      <div className="text-[10px] text-faint tabular-nums">
                        {dayjs(l.createdAt).format('YYYY-MM-DD')} · {count} 条
                      </div>
                    </button>
                  )}
                  <IconButton
                    title="重命名"
                    className="shrink-0"
                    onClick={(e) => {
                      e.stopPropagation()
                      startRename(l.id, l.name)
                    }}
                  >
                    <Pencil size={12} />
                  </IconButton>
                  <IconButton
                    title="删除列表"
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
              <div className="px-2 py-3 text-[11px] text-faint">
                还没有标记列表，点击右上角 + 新建
              </div>
            ) : null}
          </div>

          {/* 当前列表条目：按标记日期分组 */}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {lists.length === 0 ? (
              <EmptyState
                icon={Bookmark}
                title="还没有标记列表"
                desc="新建一个列表，然后把搜索结果拖进来，或点结果右侧的书签按钮"
              >
                <Button variant="soft" size="sm" icon={Plus} onClick={handleCreateList}>
                  新建标记列表
                </Button>
              </EmptyState>
            ) : groups.length === 0 ? (
              <div className="py-10 text-center text-[11px] leading-relaxed text-faint">
                「{currentList?.name}」还没有条目
                <br />
                把左侧搜索结果拖到这里即可标记
              </div>
            ) : (
              <div className="space-y-4">
                {groups.map(([date, groupItems]) => (
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
                          <div className="line-clamp-2 min-w-0 flex-1 text-xs font-medium leading-snug">
                            {it.title}
                          </div>
                          <button
                            className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                            title="移除该标记"
                            onClick={(e) => {
                              e.stopPropagation()
                              removeMark(it.id)
                            }}
                          >
                            <X size={13} className="text-faint hover:text-danger" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 拖拽进行中的落点提示 */}
          {dragSubject ? (
            <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-accent-soft px-4 py-2 text-[11px] text-accent">
              <BookmarkCheck size={12} />
              拖到这里加入「{currentList?.name ?? '新建列表'}」
            </div>
          ) : null}
        </aside>
      </div>

      {/* 标记弹窗：从结果卡片书签按钮进入，可勾选多个列表 */}
      <Modal open={pickOpen} onClose={() => setPickOpen(false)} title="加入标记列表" width={460}>
        {pickFor ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-elev2/50 p-2.5">
              <CoverImage
                src={pickFor.images?.large ?? pickFor.images?.common ?? null}
                className="h-14 w-10 shrink-0 rounded-md"
              />
              <div className="min-w-0">
                <div className="line-clamp-1 text-sm font-medium">{pickFor.name_cn || pickFor.name}</div>
                {pickFor.name_cn && pickFor.name !== pickFor.name_cn ? (
                  <div className="line-clamp-1 text-[11px] text-faint">{pickFor.name}</div>
                ) : null}
              </div>
            </div>

            <div className="space-y-1.5">
              {lists.length === 0 ? (
                <div className="py-6 text-center text-[11px] text-faint">
                  还没有标记列表，在下方新建一个即可直接标记
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
                      existing ? 'border-accent bg-accent-soft' : 'border-border bg-elev1 hover:border-accent'
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
                    <Badge tone={existing ? 'accent' : 'neutral'}>{existing ? '已标记' : '加入'}</Badge>
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
                placeholder="新建列表名称（留空自动命名）"
              />
              <Button icon={Plus} className="shrink-0" onClick={createAndMark}>
                新建并标记
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* 删除列表：连同该列表下的条目一起删，二次确认后才执行 */}
      <ConfirmModal
        open={deleteOpen}
        title="删除标记列表"
        danger
        confirmText="删除"
        message={
          pendingDelete ? (
            <>
              确定删除「{pendingDelete.name}」？该列表下的 {pendingDelete.count} 条标记会一并删除，
              且无法恢复。
            </>
          ) : null
        }
        onConfirm={() => {
          if (!pendingDelete) return
          removeList(pendingDelete.id)
          toast.info(`已删除「${pendingDelete.name}」`)
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  )
}

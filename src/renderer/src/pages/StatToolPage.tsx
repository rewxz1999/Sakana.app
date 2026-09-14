import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ImageDown, ListVideo, MessageSquare, Plus, Search, Star, Trash2, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { FavoriteItem, StatEntry } from '@shared/types'
import { api } from '@/lib/api'
import { localImgUrl } from '@/lib/format'
import { useLibrary } from '@/stores/library'
import { useStatTool } from '@/stores/statTool'
import { toast } from '@/stores/app'
import { CoverImage } from '@/components/CoverImage'
import { Badge, Button, ConfirmModal, EmptyState, Input, Modal, Spinner } from '@/components/ui'

// ---------------- 行内编辑：看完时间 ----------------

function WatchedAtEditor({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value ?? '')

  function commit() {
    setEditing(false)
    const t = text.trim()
    const next = t ? t : null
    if (next !== value) onSave(next)
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setText(value ?? '')
            setEditing(false)
          }
        }}
        placeholder="YYYY-MM-DD"
        className="h-7 w-full rounded-md border border-accent bg-elev1 px-2 text-xs outline-none placeholder:text-faint"
      />
    )
  }
  return (
    <button
      onClick={() => {
        setText(value ?? '')
        setEditing(true)
      }}
      title="点击编辑看完时间"
      className={`h-7 w-full rounded-md px-2 text-left text-xs transition-colors hover:bg-elev2 ${
        value ? 'text-text' : 'text-faint'
      }`}
    >
      {value ?? '点击填写'}
    </button>
  )
}

// ---------------- 个人评分输入 ----------------

function RatingInput({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const [text, setText] = useState(value == null ? '' : value.toFixed(1))

  useEffect(() => {
    setText(value == null ? '' : value.toFixed(1))
  }, [value])

  function commit() {
    const t = text.trim()
    if (!t) {
      if (value != null) onSave(null)
      return
    }
    const n = Number(t)
    if (Number.isNaN(n)) {
      setText(value == null ? '' : value.toFixed(1))
      return
    }
    const clamped = Math.min(10, Math.max(0, n))
    const rounded = Math.round(clamped * 10) / 10
    setText(rounded.toFixed(1))
    if (rounded !== value) onSave(rounded)
  }

  return (
    <input
      type="number"
      min={0}
      max={10}
      step={0.1}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
      }}
      placeholder="—"
      className="h-7 w-14 rounded-md border border-border bg-elev1 px-2 text-xs tabular-nums outline-none transition-colors placeholder:text-faint focus:border-accent"
    />
  )
}

// ---------------- 评价文本域（下拉框内编辑，失焦保存） ----------------

function ReviewTextarea({
  value,
  placeholder,
  onSave
}: {
  value: string
  placeholder: string
  onSave: (v: string) => void
}) {
  const [text, setText] = useState(value)

  useEffect(() => setText(value), [value])

  return (
    <textarea
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== value) onSave(text)
      }}
      rows={3}
      className="mb-2 w-full resize-none rounded-md border border-border bg-elev2 px-2 py-1.5 text-xs leading-relaxed text-text outline-none transition-colors placeholder:text-faint focus:border-accent"
    />
  )
}

// ---------------- 条目卡片 ----------------

function EntryCard({ entry, onDelete }: { entry: StatEntry; onDelete: () => void }) {
  const updateEntry = useStatTool((s) => s.updateEntry)
  const [reviewOpen, setReviewOpen] = useState(false)

  const deviation =
    entry.personalRating != null && entry.bgmRating != null
      ? entry.personalRating - entry.bgmRating
      : null

  const reviewCount = [entry.initialReview, entry.finalReview].filter((r) => (r ?? '').trim() !== '').length

  async function pickPhotos() {
    const r = await api.dialog.pickImages()
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    const remaining = 3 - entry.photos.length
    if (remaining <= 0) return
    updateEntry(entry.id, { photos: [...entry.photos, ...r.data.slice(0, remaining)] })
  }

  const photoSlots = Array.from({ length: 3 }, (_, i) => entry.photos[i] ?? null)

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-elev1 p-3">
      {/* 序号 */}
      <span className="w-14 shrink-0 text-center font-mono text-base font-bold tabular-nums text-accent">
        {entry.seq}
      </span>

      {/* 封面 */}
      <CoverImage src={entry.cover} className="h-16 w-12 shrink-0 rounded-md" />

      {/* 名称（完整显示，不截断） + 放送时间 */}
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm font-semibold leading-snug">{entry.nameCn || entry.name}</div>
        {entry.nameCn && entry.name && entry.nameCn !== entry.name ? (
          <div className="mt-0.5 break-words text-[11px] leading-snug text-dim">{entry.name}</div>
        ) : null}
        <div className="mt-0.5 text-[11px] text-faint">{entry.airDate ?? '放送时间未知'}</div>
      </div>

      {/* 看完时间 */}
      <div className="w-24 shrink-0">
        <div className="mb-1 text-[10px] text-faint">看完时间</div>
        <WatchedAtEditor value={entry.watchedAt} onSave={(v) => updateEntry(entry.id, { watchedAt: v })} />
      </div>

      {/* 评分 */}
      <div className="w-36 shrink-0 space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-faint">评分</span>
          <RatingInput value={entry.personalRating} onSave={(v) => updateEntry(entry.id, { personalRating: v })} />
        </div>
        <div className="flex items-center gap-1 text-[11px] text-dim">
          <Star size={10} className="text-warn" fill="currentColor" />
          bgm {entry.bgmRating != null ? entry.bgmRating.toFixed(1) : '暂无'}
        </div>
        <div className="text-[11px]">
          偏差{' '}
          {entry.bgmRating == null ? (
            <span className="text-faint">暂无</span>
          ) : deviation != null ? (
            <span className={deviation >= 0 ? 'text-ok' : 'text-danger'}>
              {deviation >= 0 ? '+' : '-'}
              {Math.abs(deviation).toFixed(1)}
            </span>
          ) : (
            <span className="text-faint">—</span>
          )}
        </div>
      </div>

      {/* 剧照 1-3 */}
      <div className="shrink-0">
        <div className="mb-1 text-[10px] text-faint">剧照</div>
        <div className="flex gap-1">
          {photoSlots.map((p, i) =>
            p ? (
              <button
                key={i}
                title="点击移除剧照"
                onClick={() => updateEntry(entry.id, { photos: entry.photos.filter((_, idx) => idx !== i) })}
                className="group relative shrink-0 overflow-hidden rounded"
              >
                <img src={localImgUrl(p)} alt="剧照" className="h-12 w-20 rounded object-cover" />
                <span className="absolute inset-0 flex items-center justify-center rounded bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                  <X size={14} className="text-white" />
                </span>
              </button>
            ) : (
              <button
                key={i}
                title="添加剧照"
                onClick={() => void pickPhotos()}
                className="flex h-12 w-20 shrink-0 items-center justify-center rounded border border-dashed border-border text-faint transition-colors hover:border-accent hover:text-accent"
              >
                <Plus size={14} />
              </button>
            )
          )}
        </div>
      </div>

      {/* 评价（点击弹出小窗口撰写初始/完结评价） */}
      <div className="shrink-0">
        <div className="mb-1 text-[10px] text-faint">评价</div>
        <button
          title="点击撰写初始/完结评价"
          onClick={() => setReviewOpen(true)}
          className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors ${
            reviewCount > 0
              ? 'bg-accent-soft text-accent'
              : 'border border-dashed border-border text-faint hover:border-accent hover:text-accent'
          }`}
        >
          <MessageSquare size={12} />
          {reviewCount > 0 ? `${reviewCount} 条` : '撰写'}
        </button>
      </div>

      {/* 评价小窗口 */}
      <Modal open={reviewOpen} onClose={() => setReviewOpen(false)} title={`评价 · ${entry.nameCn || entry.name}`} width={520}>
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-xs font-semibold text-dim">初始评价</div>
            <ReviewTextarea
              value={entry.initialReview}
              placeholder="刚开始玩时的第一印象…"
              onSave={(v) => updateEntry(entry.id, { initialReview: v })}
            />
          </div>
          <div>
            <div className="mb-1.5 text-xs font-semibold text-dim">完结评价</div>
            <ReviewTextarea
              value={entry.finalReview}
              placeholder="看完之后的整体评价…"
              onSave={(v) => updateEntry(entry.id, { finalReview: v })}
            />
          </div>
          <div className="text-right text-[10px] text-faint">失焦自动保存</div>
        </div>
      </Modal>

      {/* 删除 */}
      <button
        title="删除条目"
        onClick={onDelete}
        className="shrink-0 text-faint transition-colors hover:text-danger"
      >
        <Trash2 size={15} />
      </button>
    </div>
  )
}

// ---------------- 页面 ----------------

export function StatToolPage() {
  const navigate = useNavigate()
  const data = useStatTool((s) => s.data)
  const loaded = useStatTool((s) => s.loaded)
  const selectedListId = useStatTool((s) => s.selectedListId)
  const load = useStatTool((s) => s.load)
  const selectList = useStatTool((s) => s.selectList)
  const createList = useStatTool((s) => s.createList)
  const deleteList = useStatTool((s) => s.deleteList)
  const addEntry = useStatTool((s) => s.addEntry)
  const removeEntry = useStatTool((s) => s.removeEntry)
  const favorites = useLibrary((s) => s.favorites)

  const [createOpen, setCreateOpen] = useState(false)
  const [listName, setListName] = useState('')
  const [deleteListId, setDeleteListId] = useState<string | null>(null)
  const [deleteEntryId, setDeleteEntryId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  async function exportImage() {
    if (!selectedList) return
    setExporting(true)
    const r = await api.stat.exportImage(selectedList.id)
    setExporting(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (r.data) toast.success(`图片已导出: ${r.data}`)
  }

  const lists = data?.lists ?? []
  const entries = data?.entries ?? []
  const selectedList = lists.find((l) => l.id === selectedListId) ?? null
  const listEntries = useMemo(
    () =>
      selectedList
        ? entries
            .filter((e) => e.listId === selectedList.id)
            .sort((a, b) => a.seq.localeCompare(b.seq))
        : [],
    [entries, selectedList]
  )
  const existingIds = useMemo(() => new Set(listEntries.map((e) => e.subjectId)), [listEntries])

  const kw = query.trim().toLowerCase()
  const filteredFavorites = useMemo(() => {
    if (!kw) return favorites
    return favorites.filter(
      (f) => f.nameCn.toLowerCase().includes(kw) || f.name.toLowerCase().includes(kw)
    )
  }, [favorites, kw])

  function submitCreate() {
    const name = listName.trim()
    if (!name) {
      toast.warn('请输入列表名称')
      return
    }
    createList(name)
    setListName('')
    setCreateOpen(false)
    toast.success('列表已创建')
  }

  function handleAdd(f: FavoriteItem) {
    if (!selectedList) return
    const ok = addEntry(selectedList.id, f)
    if (ok) {
      toast.success('已添加到列表')
      setAddOpen(false)
      setQuery('')
    } else {
      toast.warn('已在列表中')
    }
  }

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶部栏：标题 + 说明（小窗口的关闭按钮由标题栏提供） */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-elev1/60 px-5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ListVideo size={15} className="text-accent" /> 统计工具
          <span className="text-[11px] font-normal text-faint">按列表记录已看番剧、评分与评价，可导出为图片</span>
        </div>
        {api.window.isSmallWindow ? null : (
          <button
            title="返回上一页"
            onClick={() => navigate(-1)}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elev1 px-3 text-xs text-dim transition-colors hover:border-accent hover:text-accent"
          >
            <ArrowLeft size={13} /> 返回
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 左侧：列表区 */}
        <div className="flex w-[220px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-border bg-elev1/50 p-3">
        <Button icon={Plus} className="w-full" onClick={() => setCreateOpen(true)}>
          新建列表
        </Button>

        {lists.map((list) => {
          const count = entries.filter((e) => e.listId === list.id).length
          const active = list.id === selectedListId
          return (
            <div
              key={list.id}
              onClick={() => selectList(list.id)}
              className={`group flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 transition-colors ${
                active ? 'border-accent bg-accent-soft' : 'border-border bg-elev1 hover:border-accent/50'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{list.name}</div>
                <div className="text-[11px] text-faint">{count} 个条目</div>
              </div>
              <button
                title="删除列表"
                onClick={(e) => {
                  e.stopPropagation()
                  setDeleteListId(list.id)
                }}
                className="shrink-0 text-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            </div>
          )
        })}

        {lists.length === 0 ? (
          <div className="py-8 text-center text-[11px] leading-relaxed text-faint">还没有列表</div>
        ) : null}

        <div className="mt-auto border-t border-border pt-2 text-[11px] text-faint">
          共 {lists.length} 个列表 · {entries.length} 个条目
        </div>
      </div>

      {/* 右侧：条目区 */}
      <div className="flex-1 overflow-auto px-5 py-4">
        {!selectedList ? (
          <EmptyState
            icon={ListVideo}
            title="选择或新建一个列表"
            desc="在左侧新建统计列表，然后添加已收藏的番剧，记录看完时间、个人评分与剧照。"
          />
        ) : (
          <div>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold">{selectedList.name}</h2>
                <span className="text-[11px] text-faint">{listEntries.length} 个条目</span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  icon={ImageDown}
                  loading={exporting}
                  disabled={listEntries.length === 0}
                  onClick={() => void exportImage()}
                >
                  导出为图片
                </Button>
                <Button icon={Plus} onClick={() => setAddOpen(true)}>
                  添加番剧
                </Button>
              </div>
            </div>

            {listEntries.length > 0 ? (
              <div className="flex flex-col gap-3">
                {listEntries.map((entry) => (
                  <EntryCard key={entry.id} entry={entry} onDelete={() => setDeleteEntryId(entry.id)} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={ListVideo}
                title="这个列表还没有条目"
                desc="点击「添加番剧」从收藏中选择番剧加入统计。"
              />
            )}
          </div>
        )}
      </div>
      </div>

      {/* 新建列表弹窗 */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="新建列表" width={420}>
        <Input
          autoFocus
          value={listName}
          onChange={(e) => setListName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitCreate()
          }}
          placeholder="列表名称"
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setCreateOpen(false)}>
            取消
          </Button>
          <Button onClick={submitCreate}>创建</Button>
        </div>
      </Modal>

      {/* 删除列表确认 */}
      <ConfirmModal
        open={deleteListId != null}
        title="删除列表"
        message={
          <>
            确定删除列表「{lists.find((l) => l.id === deleteListId)?.name ?? ''}」及其所有条目？此操作不可撤销。
          </>
        }
        confirmText="删除"
        danger
        onConfirm={() => {
          if (deleteListId) deleteList(deleteListId)
        }}
        onClose={() => setDeleteListId(null)}
      />

      {/* 删除条目确认 */}
      <ConfirmModal
        open={deleteEntryId != null}
        title="删除条目"
        message="确定删除该条目？此操作不可撤销。"
        confirmText="删除"
        danger
        onConfirm={() => {
          if (deleteEntryId) removeEntry(deleteEntryId)
        }}
        onClose={() => setDeleteEntryId(null)}
      />

      {/* 添加番剧弹窗 */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="添加番剧" width={640}>
        <div className="relative mb-3">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索收藏的番剧…"
            className="h-9 w-full rounded-lg border border-border bg-elev1 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-accent"
          />
        </div>

        {filteredFavorites.length > 0 ? (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {filteredFavorites.map((f) => {
              const exists = existingIds.has(f.subjectId)
              return (
                <div
                  key={f.subjectId}
                  onClick={() => handleAdd(f)}
                  className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-elev1 p-2.5 transition-colors hover:border-accent"
                >
                  <CoverImage src={f.cover} className="h-14 w-10 shrink-0 rounded-md" />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-1 text-sm font-medium">{f.nameCn || f.name}</div>
                    <div className="mt-0.5 text-[11px] text-faint">
                      {f.airDate ?? '放送时间未知'}
                      {f.rating != null ? ` · ${f.rating.toFixed(1)} 分` : ''}
                    </div>
                  </div>
                  {exists ? <Badge tone="warn">已在列表中</Badge> : null}
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState icon={Search} title="没有匹配的收藏" desc="先在收藏页收藏番剧，或调整搜索关键词。" />
        )}
      </Modal>
    </div>
  )
}

export default StatToolPage

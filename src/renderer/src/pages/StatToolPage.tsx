import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpDown,
  Eye,
  ImageDown,
  Info,
  ListVideo,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { StatEntry, StatExportField, StatList } from '@shared/types'
import { api } from '@/lib/api'
import { orderedListsOf, useStatTool, warmSeasonAddItems } from '@/stores/statTool'
import { toast } from '@/stores/app'
import { CoverImage } from '@/components/CoverImage'
import { Button, ConfirmModal, EmptyState, Input, Modal, Spinner } from '@/components/ui'
import { ContextMenu, type ContextMenuItem } from '@/components/stat/ContextMenu'
import { StatDetailDialog } from '@/components/stat/StatDetailDialog'
import { BatchAddDialog } from '@/components/stat/BatchAddDialog'
import { DEFAULT_EXPORT_FIELDS, ExportDialog } from '@/components/stat/ExportDialog'
import { entryDeviation, shortWatchedAt } from '@/components/stat/DateTimeField'

/**
 * 统计工具页（v0.2 大改）。
 *
 * 这一版改了什么（对着用户需求逐条）：
 * 1. 条目只显示「序号 / 封面 / 番剧名 / 放送时间 / 看完时间 / 个人评分 / bangumi 评分 / 差值 / 总体评价」，
 *    分成「序号 · 封面 · 信息列 · 评分列（右对齐、等宽数字）· 总体评价列」五栏，差值按正负着色；
 * 2. 条目**右键**（或点右侧 ⋯ 按钮，键盘/触控也能用）弹出菜单：详情 / 重新排序 / 删除列表；
 * 3. 「详情」弹 StatDetailDialog（字段与可编辑性见那个文件头的对照表）；
 * 4. 「添加番剧」弹 BatchAddDialog（收藏 / 当季 / 搜索，可批量勾选、可一键全选当季）；
 * 5. 列表可置顶（右键列表或点图钉图标），置顶排序持久化在主进程；
 * 6. 导出图片先弹 ExportDialog 勾选字段。
 *
 * 数据流向：所有写操作走 `useStatTool` → 主进程 `stat:apply` → 广播 `ev:stat`，
 * 渲染层只做乐观更新与展示（见 stores/statTool.ts 的说明）。
 */

/** 评分列的一个格子 */
function RatingCell({
  label,
  value,
  tone = 'default'
}: {
  label: string
  value: string
  tone?: 'default' | 'accent' | 'ok' | 'danger' | 'warn'
}) {
  const color =
    tone === 'accent'
      ? 'text-accent'
      : tone === 'ok'
        ? 'text-ok'
        : tone === 'danger'
          ? 'text-danger'
          : tone === 'warn'
            ? 'text-warn'
            : 'text-text'
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="text-[10px] leading-none text-faint">{label}</span>
      <span className={`text-sm font-semibold leading-none tabular-nums ${color}`}>{value}</span>
    </div>
  )
}

/** 条目卡片：只放用户点名的那几个字段 */
function EntryRow({
  entry,
  onContextMenu,
  onDetail
}: {
  entry: StatEntry
  onContextMenu: (e: React.MouseEvent, entry: StatEntry) => void
  onDetail: () => void
}) {
  const dev = entryDeviation(entry)
  const watched = shortWatchedAt(entry.watchedAt)
  const overall = entry.overallReview.trim()

  return (
    <div
      onContextMenu={(e) => onContextMenu(e, entry)}
      onDoubleClick={onDetail}
      title="右键打开菜单：详情 / 重新排序 / 删除列表"
      className="flex items-center gap-4 rounded-xl border border-border bg-elev1 p-3 transition-colors hover:border-accent/40"
    >
      {/* 序号 */}
      <span className="w-16 shrink-0 text-center font-mono text-base font-bold tabular-nums text-accent">
        {entry.seq}
      </span>

      {/* 封面 */}
      <CoverImage src={entry.cover} className="h-[74px] w-[54px] shrink-0 rounded-md" />

      {/* 番剧名 + 放送时间 + 看完时间 */}
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm font-semibold leading-snug">{entry.nameCn || entry.name}</div>
        {entry.nameCn && entry.name && entry.nameCn !== entry.name ? (
          <div className="mt-0.5 break-words text-[11px] leading-snug text-dim">{entry.name}</div>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
          <span className="text-faint">
            放送 <span className="text-dim">{entry.airDate ?? '未知'}</span>
          </span>
          <span className="text-faint">
            看完 <span className={watched ? 'text-dim' : 'text-faint'}>{watched || '未填写'}</span>
          </span>
        </div>
      </div>

      {/* 评分列：个人 / 相关 / 差值 */}
      <div className="flex shrink-0 items-end gap-4">
        <RatingCell label="个人评分" value={entry.personalRating != null ? entry.personalRating.toFixed(1) : '—'} tone="warn" />
        <RatingCell label="bangumi" value={entry.bgmRating != null ? entry.bgmRating.toFixed(1) : '—'} tone="accent" />
        <RatingCell
          label="差值"
          value={dev == null ? '—' : `${dev >= 0 ? '+' : '-'}${Math.abs(dev).toFixed(1)}`}
          tone={dev == null ? 'default' : dev >= 0 ? 'ok' : 'danger'}
        />
      </div>

      {/* 总体评价 */}
      <div className="w-[260px] shrink-0 border-l border-border pl-4">
        <div className="mb-0.5 text-[10px] text-faint">总体评价</div>
        {overall ? (
          <div className="line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-dim" title={overall}>
            {overall}
          </div>
        ) : (
          <div className="text-[11px] text-faint">未填写（右键 → 详情）</div>
        )}
      </div>

      {/* 详情入口（右键菜单的可发现版本，键盘/触控也能用） */}
      <button
        type="button"
        title="条目菜单：详情 / 重新排序 / 删除列表"
        onClick={(e) => onContextMenu(e, entry)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-elev2 hover:text-accent"
      >
        <Info size={15} />
      </button>
    </div>
  )
}

/** 左栏的一个列表（含置顶图钉 / 右键菜单 / 双击改名） */
function ListItem({
  list,
  count,
  active,
  onSelect,
  onRename,
  onContextMenu
}: {
  list: StatList
  count: number
  active: boolean
  onSelect: () => void
  onRename: (name: string) => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(list.name)

  useEffect(() => setText(list.name), [list.name])

  return (
    <div
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={`group flex cursor-pointer items-center gap-1.5 rounded-lg border p-2.5 transition-colors ${
        active ? 'border-accent bg-accent-soft' : 'border-border bg-elev1 hover:border-accent/50'
      }`}
    >
      {list.pinned ? <Pin size={12} className="shrink-0 text-accent" fill="currentColor" /> : null}
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => {
              setEditing(false)
              if (text.trim() && text.trim() !== list.name) onRename(text.trim())
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                setText(list.name)
                setEditing(false)
              }
            }}
            className="h-7 px-2 text-xs"
          />
        ) : (
          <>
            <div
              className="truncate text-sm font-medium"
              title="双击改名"
              onDoubleClick={(e) => {
                e.stopPropagation()
                setEditing(true)
              }}
            >
              {list.name}
            </div>
            <div className="text-[11px] text-faint">{count} 个条目</div>
          </>
        )}
      </div>
      <button
        type="button"
        title="重命名"
        onClick={(e) => {
          e.stopPropagation()
          setEditing(true)
        }}
        className="shrink-0 text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
      >
        <Pencil size={12} />
      </button>
    </div>
  )
}

export function StatToolPage() {
  const navigate = useNavigate()
  const data = useStatTool((s) => s.data)
  const loaded = useStatTool((s) => s.loaded)
  const selectedListId = useStatTool((s) => s.selectedListId)
  const load = useStatTool((s) => s.load)
  const selectList = useStatTool((s) => s.selectList)
  const createList = useStatTool((s) => s.createList)
  const renameList = useStatTool((s) => s.renameList)
  const deleteList = useStatTool((s) => s.deleteList)
  const setPinned = useStatTool((s) => s.setPinned)
  const resort = useStatTool((s) => s.resort)
  const removeEntry = useStatTool((s) => s.removeEntry)

  const [createOpen, setCreateOpen] = useState(false)
  const [listName, setListName] = useState('')
  const [deleteListId, setDeleteListId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportFields, setExportFields] = useState<StatExportField[]>(DEFAULT_EXPORT_FIELDS)
  const [widthScale, setWidthScale] = useState(1)
  const [photoScale, setPhotoScale] = useState(1.25)

  // 右键菜单（条目 / 列表共用一套状态：谁被右键、菜单画在哪儿、菜单项是什么）
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState<StatEntry | null>(null)

  useEffect(() => {
    void load()
    /*
     * 预热「当季番剧」候选（v0.3.2）。
     *
     * 用户要求「添加番剧时从本地缓存的当季数据添加，这样加载更快」：
     * 进页面就把当前季度放进渲染层的记忆（见 stores/statTool.ts），
     * 这样点「添加番剧 → 当季番剧」是同步出数据的，连一帧转圈都没有。
     * 记忆够新鲜时这个调用什么都不做（0 请求）；否则那一次 IPC 绝大多数情况命中
     * 主进程的 7 天季度磁盘缓存（只是读盘），所以预热几乎不产生联网。
     */
    warmSeasonAddItems()
  }, [load])

  // 置顶优先（排序规则在 store 里与主进程保持一致），useMemo 避免每次渲染新建数组
  const lists = useMemo(() => orderedListsOf(data), [data])
  const entries = data.entries ?? []
  const selectedList = lists.find((l) => l.id === selectedListId) ?? null
  const listEntries = useMemo(
    () =>
      selectedList
        ? entries.filter((e) => e.listId === selectedList.id).sort((a, b) => a.seq.localeCompare(b.seq))
        : [],
    [entries, selectedList]
  )

  /**
   * 条目的右键菜单。
   *
   * 用户点名的三项（详情 / 重新排序 / 删除列表）都在，另加「删除条目」：
   * 用户说的「删除列表」在条目菜单里语义上是指「把这条从列表里删掉」，
   * 但同一句话又可能是「删掉整个列表」，所以两个都提供，各自的确认文案写清楚差别。
   */
  function openEntryMenu(e: React.MouseEvent, entry: StatEntry): void {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: 'detail',
          label: '详情',
          icon: <Eye size={13} />,
          onSelect: () => setDetailId(entry.id)
        },
        {
          key: 'resort',
          label: '重新排序',
          icon: <ArrowUpDown size={13} />,
          onSelect: () => {
            if (!selectedList) return
            resort(selectedList.id)
            toast.success('已按年份与顺序重新编号')
          }
        },
        {
          key: 'delete-entry',
          label: '删除条目',
          icon: <Trash2 size={13} />,
          danger: true,
          divider: true,
          onSelect: () => setPendingDeleteEntry(entry)
        },
        {
          key: 'delete-list',
          label: '删除列表',
          icon: <Trash2 size={13} />,
          danger: true,
          onSelect: () => {
            if (!selectedList) return
            setDeleteListId(selectedList.id)
          }
        }
      ]
    })
  }

  /** 列表的右键菜单：置顶 / 重新排序 / 重命名 / 删除 */
  function openListMenu(e: React.MouseEvent, list: StatList): void {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: 'pin',
          label: list.pinned ? '取消置顶' : '置顶列表',
          icon: list.pinned ? <PinOff size={13} /> : <Pin size={13} />,
          onSelect: () => {
            setPinned(list.id, !list.pinned)
            toast.success(list.pinned ? '已取消置顶' : '已置顶')
          }
        },
        {
          key: 'resort',
          label: '重新排序',
          icon: <ArrowUpDown size={13} />,
          onSelect: () => {
            resort(list.id)
            toast.success('已按年份与顺序重新编号')
          }
        },
        { key: 'del', label: '删除列表', icon: <Trash2 size={13} />, danger: true, divider: true, onSelect: () => setDeleteListId(list.id) }
      ]
    })
  }

  async function submitCreate(): Promise<void> {
    const name = listName.trim()
    if (!name) {
      toast.warn('请输入列表名称')
      return
    }
    const id = await createList(name)
    setListName('')
    setCreateOpen(false)
    if (id) toast.success('列表已创建')
    else toast.error('创建失败，请重试')
  }

  async function doExport(): Promise<void> {
    if (!selectedList) return
    setExporting(true)
    const r = await api.stat.exportImage(selectedList.id, { fields: exportFields, widthScale, photoScale })
    setExporting(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (r.data) {
      toast.success(`图片已导出: ${r.data}`)
      setExportOpen(false)
    }
    // 空字符串 = 用户在保存对话框里取消，什么都不提示
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
      {/* 顶部栏 */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-elev1/60 px-5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ListVideo size={15} className="text-accent" /> 统计工具
          <span className="text-[11px] font-normal text-faint">
            按列表记录已看番剧，右键条目打开菜单，可导出为图片
          </span>
        </div>
        {api.window.isSmallWindow ? null : (
          <button
            title="返回上一页"
            onClick={() => navigate(-1)}
            className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-elev1 px-3 text-xs text-dim transition-colors hover:border-accent hover:text-accent"
          >
            <ArrowLeft size={13} /> 返回
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左侧：列表区（置顶的排最前） */}
        <div className="flex w-[236px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-border bg-elev1/50 p-3">
          <Button icon={Plus} className="w-full" onClick={() => setCreateOpen(true)}>
            新建列表
          </Button>

          {lists.map((list) => (
            <ListItem
              key={list.id}
              list={list}
              count={entries.filter((e) => e.listId === list.id).length}
              active={list.id === selectedListId}
              onSelect={() => selectList(list.id)}
              onRename={(name) => renameList(list.id, name)}
              onContextMenu={(e) => openListMenu(e, list)}
            />
          ))}

          {lists.length === 0 ? (
            <div className="py-8 text-center text-[11px] leading-relaxed text-faint">
              还没有列表
              <br />
              新建一个，再把看过的番剧加进来
            </div>
          ) : null}

          <div className="mt-auto border-t border-border pt-2 text-[11px] leading-relaxed text-faint">
            共 {lists.length} 个列表 · {entries.length} 个条目
            <br />
            置顶列表会排在最前（右键列表可置顶）
          </div>
        </div>

        {/* 右侧：条目区 */}
        <div className="flex-1 overflow-auto px-5 py-4">
          {!selectedList ? (
            <EmptyState
              icon={ListVideo}
              title="选择或新建一个列表"
              desc="在左侧新建统计列表，然后添加已看过的番剧，记录评分、评价与剧照。"
            />
          ) : (
            <div>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="flex items-center gap-2 text-base font-semibold">
                    {selectedList.pinned ? <Pin size={13} className="text-accent" fill="currentColor" /> : null}
                    {selectedList.name}
                  </h2>
                  <span className="text-[11px] text-faint">
                    {listEntries.length} 个条目 · 右键条目打开菜单（详情 / 重新排序 / 删除列表）
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    icon={selectedList.pinned ? PinOff : Pin}
                    onClick={() => {
                      setPinned(selectedList.id, !selectedList.pinned)
                      toast.success(selectedList.pinned ? '已取消置顶' : '已置顶')
                    }}
                  >
                    {selectedList.pinned ? '取消置顶' : '置顶列表'}
                  </Button>
                  <Button
                    variant="outline"
                    icon={ArrowUpDown}
                    disabled={listEntries.length === 0}
                    onClick={() => {
                      resort(selectedList.id)
                      toast.success('已按年份与顺序重新编号')
                    }}
                  >
                    重新排序
                  </Button>
                  <Button
                    variant="outline"
                    icon={ImageDown}
                    disabled={listEntries.length === 0}
                    onClick={() => setExportOpen(true)}
                  >
                    导出为图片
                  </Button>
                  <Button icon={Plus} onClick={() => setAddOpen(true)}>
                    添加番剧
                  </Button>
                </div>
              </div>

              {listEntries.length > 0 ? (
                <div className="flex flex-col gap-2.5">
                  {listEntries.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      onContextMenu={openEntryMenu}
                      onDetail={() => setDetailId(entry.id)}
                    />
                  ))}
                  <div className="pt-1 text-center text-[11px] text-faint">
                    共 {listEntries.length} 条 · 个人评分均值{' '}
                    {avgRating(listEntries) ?? '—'} · bgm 均值 {avgBgm(listEntries) ?? '—'}
                  </div>
                </div>
              ) : (
                <EmptyState
                  icon={ListVideo}
                  title="这个列表还没有条目"
                  desc="点右上角「添加番剧」从收藏里批量挑，或用「当季番剧」一键加一整季。"
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* 条目/列表右键菜单 */}
      <ContextMenu
        open={menu != null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu?.items ?? []}
        onClose={() => setMenu(null)}
      />

      {/* 新建列表 */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="新建列表" width={420}>
        <Input
          autoFocus
          value={listName}
          onChange={(e) => setListName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitCreate()
          }}
          placeholder="列表名称（如 2024 年补番）"
        />
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setCreateOpen(false)}>
            取消
          </Button>
          <Button onClick={() => void submitCreate()}>创建</Button>
        </div>
      </Modal>

      {/* 删除列表确认（只删列表条目，不动收藏 / 观看记录 / 截图） */}
      <ConfirmModal
        open={deleteListId != null}
        title="删除列表"
        message={
          <>
            确定删除列表「{lists.find((l) => l.id === deleteListId)?.name ?? ''}」及其
            {entries.filter((e) => e.listId === deleteListId).length} 个条目？
            <br />
            只删除这个统计列表里的条目，**不会**影响收藏、订阅、观看记录和截图文件。
          </>
        }
        confirmText="删除"
        danger
        onConfirm={() => {
          if (deleteListId) {
            deleteList(deleteListId)
            toast.success('列表已删除')
          }
        }}
        onClose={() => setDeleteListId(null)}
      />

      {/* 删除单条确认（同样只删列表条目） */}
      <ConfirmModal
        open={pendingDeleteEntry != null}
        title="删除条目"
        message={
          <>
            确定把「{pendingDeleteEntry?.nameCn || pendingDeleteEntry?.name}」从列表里删掉？
            <br />
            只删这条列表条目，收藏 / 观看记录 / 截图文件都保留。
          </>
        }
        confirmText="删除"
        danger
        onConfirm={() => {
          if (pendingDeleteEntry) {
            removeEntry(pendingDeleteEntry.id)
            toast.success('已从列表移除')
          }
        }}
        onClose={() => setPendingDeleteEntry(null)}
      />

      {/* 批量添加 */}
      <BatchAddDialog open={addOpen} listId={selectedListId} onClose={() => setAddOpen(false)} />

      {/* 导出勾选 */}
      <ExportDialog
        open={exportOpen}
        entryCount={listEntries.length}
        fields={exportFields}
        onFieldsChange={setExportFields}
        widthScale={widthScale}
        onWidthScaleChange={setWidthScale}
        photoScale={photoScale}
        onPhotoScaleChange={setPhotoScale}
        exporting={exporting}
        onExport={() => void doExport()}
        onClose={() => setExportOpen(false)}
        sample={listEntries[0] ?? null}
      />

      {/* 详情窗口 */}
      <StatDetailDialog entryId={detailId} onClose={() => setDetailId(null)} />
    </div>
  )
}

/** 个人评分均值（保留一位小数，没有评分返回 null） */
function avgRating(entries: StatEntry[]): string | null {
  const vals = entries.map((e) => e.personalRating).filter((v): v is number => v != null)
  if (vals.length === 0) return null
  return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)
}

/** bangumi 评分均值 */
function avgBgm(entries: StatEntry[]): string | null {
  const vals = entries.map((e) => e.bgmRating).filter((v): v is number => v != null)
  if (vals.length === 0) return null
  return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)
}

export default StatToolPage

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpDown,
  Eye,
  EyeOff,
  GripVertical,
  Hash,
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
import type { StatEntry, StatExportField, StatExportTheme, StatList } from '@shared/types'
import { compareStatOrder, validateSeqRule } from '@shared/statSeq'
import { api } from '@/lib/api'
import { orderedListsOf, useStatTool, warmSeasonAddItems } from '@/stores/statTool'
import { toast } from '@/stores/app'
import { CoverImage } from '@/components/CoverImage'
import { Button, ConfirmModal, EmptyState, Input, Modal, Spinner } from '@/components/ui'
import { ContextMenu, type ContextMenuItem } from '@/components/stat/ContextMenu'
import { StatDetailDialog } from '@/components/stat/StatDetailDialog'
import { BatchAddDialog } from '@/components/stat/BatchAddDialog'
import { DEFAULT_EXPORT_FIELDS, ExportDialog } from '@/components/stat/ExportDialog'
import { SeqRuleField } from '@/components/stat/SeqRuleField'
import { entryDeviation, shortWatchedAt } from '@/components/stat/DateTimeField'

/**
 * 统计工具页（v0.2 大改，v0.3.5 续改）。
 *
 * v0.3.5 对着用户 6 条反馈改了什么：
 * 1. **类型标签**：条目行新增标签行（数据来自 bangumi 详情接口的 tags，缺失时进页面自动回填，
 *    见 stores/statTool.ts 的 backfillTags）—— 过去标签虽然写进了条目、列表上却没画出来；
 * 2. **看完时间**：只显示到天（`YYYY-MM-DD`），添加条目时自动从「详情页那份已看完时间」带出；
 * 3. **序号规则**：新建列表 / 列表设置 / 添加番剧三处都能设模板，校验与续号逻辑见 shared/statSeq.ts；
 * 4. **拖动排序**：条目行可拖动（HTML5 DnD，无新依赖），只改顺序不改编号，顺序落盘；
 * 5. **导出图**：条目样式按本文件的列表条目重做 + 封面预取重试（见 statExport.ts）；
 * 6. **bangumi 评分**：默认不显示，工具栏一个开关控制；**填了个人评分的条目自动显示**。
 *
 * 数据流向：所有写操作走 `useStatTool` → 主进程 `stat:apply` → 广播 `ev:stat`，
 * 渲染层只做乐观更新与展示（见 stores/statTool.ts 的说明）。
 */

/** bangumi 评分开关的本地记忆（放 localStorage：只是显示偏好，不值得进设置文件走一次 IPC） */
const SHOW_BGM_KEY = 'sakana.stat.showBgm'

function readShowBgm(): boolean {
  try {
    return localStorage.getItem(SHOW_BGM_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 读当前主题的配色给导出图用。
 *
 * 导出图由主进程在另一个 offscreen 窗口里画，读不到渲染层的主题变量；
 * 而用户明确要求「导出图的条目样式和列表一个观感」，所以这里把当前主题的
 * CSS 变量值原样传给主进程（见 shared/types.ts 的 StatExportTheme）。
 */
function readExportTheme(): StatExportTheme {
  const fallback: StatExportTheme = {
    bg: '#eef2f9',
    elev1: '#ffffff',
    elev2: '#e9eef8',
    border: '#d4deee',
    text: '#1c2433',
    dim: '#4a566e',
    faint: '#8b96ad',
    accent: '#2f6bff',
    accentSoft: '#e3ecff',
    ok: '#2f9e63',
    danger: '#d64545',
    warn: '#c07a1a'
  }
  try {
    const cs = getComputedStyle(document.documentElement)
    const get = (name: keyof StatExportTheme, cssVar: string): string =>
      cs.getPropertyValue(cssVar).trim() || fallback[name]
    return {
      bg: get('bg', '--bg'),
      elev1: get('elev1', '--elev1'),
      elev2: get('elev2', '--elev2'),
      border: get('border', '--border'),
      text: get('text', '--text'),
      dim: get('dim', '--dim'),
      faint: get('faint', '--faint'),
      accent: get('accent', '--accent'),
      accentSoft: get('accentSoft', '--accent-soft'),
      ok: get('ok', '--ok'),
      danger: get('danger', '--danger'),
      warn: get('warn', '--warn')
    }
  } catch {
    return fallback
  }
}

/** 评分列的一个格子 */
function RatingCell({
  label,
  value,
  tone = 'default',
  attrs
}: {
  label: string
  value: string
  tone?: 'default' | 'accent' | 'ok' | 'danger' | 'warn'
  attrs?: Record<string, string>
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
    <div className="flex flex-col items-end gap-0.5" {...attrs}>
      <span className="text-[10px] leading-none text-faint">{label}</span>
      <span className={`text-sm font-semibold leading-none tabular-nums ${color}`}>{value}</span>
    </div>
  )
}

/** 条目卡片上的类型标签（最多显示 6 个，多的折成 +N） */
const TAGS_SHOWN = 6

function EntryTags({ tags }: { tags: string[] }) {
  if (tags.length === 0) {
    return (
      <div className="mt-1 text-[10px] text-faint" data-stat-tags="empty">
        类型标签读取中…（添加时会自动带出，稍后也会自己补上）
      </div>
    )
  }
  const shown = tags.slice(0, TAGS_SHOWN)
  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1"
      data-stat-tags="filled"
      data-stat-tag-count={String(tags.length)}
    >
      {shown.map((t) => (
        <span
          key={t}
          className="rounded-full border border-border bg-elev2 px-2 py-0.5 text-[10px] leading-tight text-dim"
        >
          {t}
        </span>
      ))}
      {tags.length > shown.length ? (
        <span className="text-[10px] text-faint" title={tags.join('、')}>
          +{tags.length - shown.length}
        </span>
      ) : null}
    </div>
  )
}

/** 条目卡片：只放用户点名的那几个字段 */
function EntryRow({
  entry,
  showBgm,
  dragging,
  dropBefore,
  onContextMenu,
  onDetail,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: {
  entry: StatEntry
  showBgm: boolean
  dragging: boolean
  dropBefore: boolean
  onContextMenu: (e: React.MouseEvent, entry: StatEntry) => void
  onDetail: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}) {
  const dev = entryDeviation(entry)
  const watched = shortWatchedAt(entry.watchedAt)
  const overall = entry.overallReview.trim()
  // bangumi 评分显示规则：开关打开 **或** 该条已填个人评分（用户要求「填完个人评分后自动显示」）
  const bgmVisible = showBgm || entry.personalRating != null

  return (
    <div
      data-stat-entry={entry.id}
      data-stat-seq={entry.seq}
      data-stat-order={String(entry.order)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        // Firefox 需要 setData 才会真的开始拖拽；顺带把 id 放进 DataTransfer，
        // 让投放方能确认拖的是哪一条（只允许同列表内排序）
        e.dataTransfer.setData('text/plain', entry.id)
        onDragStart()
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onContextMenu={(e) => onContextMenu(e, entry)}
      onDoubleClick={onDetail}
      title="拖动左侧手柄可排序 · 右键打开菜单（详情 / 重新排序 / 删除）"
      className={`flex items-center gap-4 rounded-xl border bg-elev1 p-3 transition-colors hover:border-accent/40 ${
        dragging ? 'border-accent/60 opacity-50' : dropBefore ? 'border-accent border-dashed' : 'border-border'
      }`}
    >
      {/* 拖动手柄（整行可拖，手柄只是"这里能拖"的可发现标识） */}
      <span
        data-stat-drag-handle=""
        title="拖动排序"
        className="-ml-1 shrink-0 cursor-grab text-faint active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </span>

      {/* 序号 */}
      <span className="w-16 shrink-0 text-center font-mono text-base font-bold tabular-nums text-accent">
        {entry.seq}
      </span>

      {/* 封面 */}
      <CoverImage src={entry.cover} className="h-[74px] w-[54px] shrink-0 rounded-md" />

      {/* 番剧名 + 放送时间 + 看完时间 + 类型标签 */}
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
        <EntryTags tags={entry.genres} />
      </div>

      {/* 评分列：个人 / bangumi / 差值 */}
      <div className="flex shrink-0 items-end gap-4">
        <RatingCell
          label="个人评分"
          value={entry.personalRating != null ? entry.personalRating.toFixed(1) : '—'}
          tone="warn"
        />
        {bgmVisible ? (
          <RatingCell
            label="bangumi"
            value={entry.bgmRating != null ? entry.bgmRating.toFixed(1) : '—'}
            tone="accent"
            attrs={{ 'data-stat-bgm': entry.bgmRating != null ? entry.bgmRating.toFixed(1) : '' }}
          />
        ) : null}
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
          <div
            className="line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-dim"
            title={overall}
          >
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
            <div className="text-[11px] text-faint">
              {count} 个条目
              {list.seqRule ? <span title={`序号规则：${list.seqRule}`}> · {list.seqRule}</span> : null}
            </div>
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
  const setSeqRule = useStatTool((s) => s.setSeqRule)
  const resort = useStatTool((s) => s.resort)
  const reorderEntries = useStatTool((s) => s.reorderEntries)
  const removeEntry = useStatTool((s) => s.removeEntry)
  const backfillTags = useStatTool((s) => s.backfillTags)

  const [createOpen, setCreateOpen] = useState(false)
  const [listName, setListName] = useState('')
  const [listRule, setListRule] = useState('')
  const [deleteListId, setDeleteListId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportFields, setExportFields] = useState<StatExportField[]>(DEFAULT_EXPORT_FIELDS)
  const [widthScale, setWidthScale] = useState(1)
  const [photoScale, setPhotoScale] = useState(1.25)
  /** 序号规则弹窗：正在编辑哪个列表（null = 关闭） */
  const [ruleListId, setRuleListId] = useState<string | null>(null)
  const [ruleDraft, setRuleDraft] = useState('')
  /** bangumi 评分开关（默认关；填了个人评分的条目不受它影响） */
  const [showBgm, setShowBgm] = useState(readShowBgm)

  // 拖动排序：拖的是谁、当前悬停在哪一行之前
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null)

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
  /*
   * 列表内顺序 = `order`（拖动排序/加入顺序的落盘结果），`seq` 只作次键。
   * 不能再按 seq 排：拖动只改顺序不改编号，按 seq 排会让拖动"看起来没生效"。
   * 排序比较器与主进程导出图共用 shared/statSeq.compareStatOrder，保证两处同序。
   */
  const listEntries = useMemo(
    () => (selectedList ? entries.filter((e) => e.listId === selectedList.id).sort(compareStatOrder) : []),
    [entries, selectedList]
  )

  /**
   * 类型标签回填：给这个列表里「有 subjectId 但还没有标签」的条目补一次详情标签。
   *
   * 只有「从收藏添加」会自带标签（收藏条目有 genres），当季/搜索两个入口拿不到，
   * 所以老条目和当季加进来的条目都会是空的 —— 这里补上，落盘后不再请求。
   */
  useEffect(() => {
    if (!selectedList || listEntries.length === 0) return
    if (!listEntries.some((e) => e.subjectId > 0 && e.genres.length === 0)) return
    void backfillTags(selectedList.id)
  }, [selectedList, listEntries, backfillTags])

  /** 打开某个列表的序号规则弹窗 */
  function openRuleDialog(list: StatList): void {
    setRuleListId(list.id)
    setRuleDraft(list.seqRule ?? '')
  }

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

  /** 列表的右键菜单：置顶 / 序号规则 / 重新排序 / 删除 */
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
          key: 'seqrule',
          label: '序号规则…',
          icon: <Hash size={13} />,
          onSelect: () => openRuleDialog(list)
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
        {
          key: 'del',
          label: '删除列表',
          icon: <Trash2 size={13} />,
          danger: true,
          divider: true,
          onSelect: () => setDeleteListId(list.id)
        }
      ]
    })
  }

  async function submitCreate(): Promise<void> {
    const name = listName.trim()
    if (!name) {
      toast.warn('请输入列表名称')
      return
    }
    const check = validateSeqRule(listRule)
    if (!check.ok) {
      toast.error(`序号规则不合法：${check.reason}`)
      return
    }
    const id = await createList(name, true, check.rule)
    setListName('')
    setListRule('')
    setCreateOpen(false)
    if (id) toast.success(check.rule ? `列表已创建（序号规则 ${check.rule}）` : '列表已创建')
    else toast.error('创建失败，请重试')
  }

  async function submitRule(): Promise<void> {
    if (!ruleListId) return
    const check = validateSeqRule(ruleDraft)
    if (!check.ok) {
      toast.error(`序号规则不合法：${check.reason}`)
      return
    }
    const ok = await setSeqRule(ruleListId, check.rule)
    setRuleListId(null)
    if (!ok) {
      toast.error('序号规则保存失败，请重试')
      return
    }
    toast.success(
      check.rule
        ? `序号规则已设为 ${check.rule}（下一条按当前最大号 +1）`
        : '已恢复默认编序（放送年份 + 01、02…）'
    )
  }

  /** 拖动中悬停到某一行：把这一行标成插入点 */
  const handleDragOverRow = useCallback(
    (id: string) => (e: React.DragEvent) => {
      if (!dragId || dragId === id) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropBeforeId(id)
    },
    [dragId]
  )

  /** 松开：把拖动项插到悬停行之前，然后整列表写回顺序 */
  const handleDropRow = useCallback(
    (targetId: string) => (e: React.DragEvent) => {
      e.preventDefault()
      const src = dragId
      setDragId(null)
      setDropBeforeId(null)
      if (!src || !selectedList || src === targetId) return
      const ids = listEntries.map((x) => x.id)
      const rest = ids.filter((x) => x !== src)
      const at = rest.indexOf(targetId)
      rest.splice(at < 0 ? rest.length : at, 0, src)
      if (rest.join('|') === ids.join('|')) return
      reorderEntries(selectedList.id, rest)
      toast.success('顺序已保存')
    },
    [dragId, selectedList, listEntries, reorderEntries]
  )

  /** 拖到列表末尾（最后一行下方那块投放区） */
  const handleDropEnd = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const src = dragId
      setDragId(null)
      setDropBeforeId(null)
      if (!src || !selectedList) return
      const ids = listEntries.map((x) => x.id)
      const rest = ids.filter((x) => x !== src)
      rest.push(src)
      if (rest.join('|') === ids.join('|')) return
      reorderEntries(selectedList.id, rest)
      toast.success('顺序已保存')
    },
    [dragId, selectedList, listEntries, reorderEntries]
  )

  async function doExport(): Promise<void> {
    if (!selectedList) return
    setExporting(true)
    const r = await api.stat.exportImage(selectedList.id, {
      fields: exportFields,
      widthScale,
      photoScale,
      // 与界面同一套规则：开关关闭时，只有填了个人评分的条目会带上 bgm 评分
      showBgmRating: showBgm,
      // 导出图配色 = 当前主题（用户要求「和界面列表条目一个观感」）
      theme: readExportTheme()
    })
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
            按列表记录已看番剧，拖动条目可排序，右键条目打开菜单，可导出为图片
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
                    {listEntries.length} 个条目 · 序号规则{' '}
                    {selectedList.seqRule || '默认（放送年份 + 01、02…）'} · 拖动条目可排序
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
                  <Button variant="outline" icon={Hash} onClick={() => openRuleDialog(selectedList)}>
                    序号规则
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
                  {/* bangumi 评分开关：默认关；填了个人评分的条目不受影响，始终显示 */}
                  <span data-stat-bgm-toggle={showBgm ? 'on' : 'off'}>
                    <Button
                      variant={showBgm ? 'soft' : 'outline'}
                      icon={showBgm ? Eye : EyeOff}
                      aria-pressed={showBgm}
                      title="默认不显示 bangumi 评分；填了个人评分的条目会自动显示"
                      onClick={() => {
                        const next = !showBgm
                        setShowBgm(next)
                        try {
                          localStorage.setItem(SHOW_BGM_KEY, next ? '1' : '0')
                        } catch {
                          /* 隐私模式下写不了 localStorage：开关本次会话照样生效 */
                        }
                        toast.success(
                          next ? '已显示所有条目的 bangumi 评分' : '已隐藏未评分条目的 bangumi 评分'
                        )
                      }}
                    >
                      bangumi 评分
                    </Button>
                  </span>
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
                      showBgm={showBgm}
                      dragging={dragId === entry.id}
                      dropBefore={dropBeforeId === entry.id}
                      onContextMenu={openEntryMenu}
                      onDetail={() => setDetailId(entry.id)}
                      onDragStart={() => setDragId(entry.id)}
                      onDragOver={handleDragOverRow(entry.id)}
                      onDrop={handleDropRow(entry.id)}
                      onDragEnd={() => {
                        setDragId(null)
                        setDropBeforeId(null)
                      }}
                    />
                  ))}
                  {/* 拖到末尾的投放区（拖动时才出现，避免平时多出一块空白） */}
                  {dragId ? (
                    <div
                      data-stat-drop-end=""
                      onDragOver={(e) => {
                        e.preventDefault()
                        setDropBeforeId(null)
                      }}
                      onDrop={handleDropEnd}
                      className="rounded-xl border border-dashed border-accent/60 py-3 text-center text-[11px] text-accent"
                    >
                      拖到这里 = 放到最后
                    </div>
                  ) : null}
                  <div className="pt-1 text-center text-[11px] text-faint">
                    共 {listEntries.length} 条 · 个人评分均值 {avgRating(listEntries) ?? '—'}
                    {showBgm ? ` · bgm 均值 ${avgBgm(listEntries) ?? '—'}` : ''}
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

      {/* 新建列表（可顺带设序号规则） */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="新建列表" width={460}>
        <Input
          autoFocus
          value={listName}
          onChange={(e) => setListName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitCreate()
          }}
          placeholder="列表名称（如 2024 年补番）"
        />
        <SeqRuleField className="mt-3" value={listRule} onChange={setListRule} />
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setCreateOpen(false)}>
            取消
          </Button>
          <Button onClick={() => void submitCreate()}>创建</Button>
        </div>
      </Modal>

      {/* 序号规则（已有列表随时可改） */}
      <Modal open={ruleListId != null} onClose={() => setRuleListId(null)} title="序号规则" width={460}>
        <div className="mb-3 text-[11px] leading-relaxed text-faint">
          规则里的数字部分就是**起始号**：第一条用规则本身，之后按列表里已有的最大号 +1。
          <br />
          纯数字最多 8 位（`20260701` → `20260702`）；字母前缀只能放在最前面（`A0701` → `A0702`）。
          留空 = 默认「放送年份 + 01、02、03…」。
        </div>
        <SeqRuleField value={ruleDraft} onChange={setRuleDraft} />
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setRuleListId(null)}>
            取消
          </Button>
          <Button onClick={() => void submitRule()}>保存</Button>
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
        showBgmRating={showBgm}
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

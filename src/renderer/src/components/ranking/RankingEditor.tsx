import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, Hash, ImageDown, Layers, Pencil, Trash2 } from 'lucide-react'
import { Button, ConfirmModal, Input, Modal } from '@/components/ui'
import { ContextMenu, type ContextMenuItem } from '@/components/stat/ContextMenu'
import { TierBoard, type DropTarget } from '@/components/ranking/TierBoard'
import { PoolPanel, PoolRail } from '@/components/ranking/PoolPanel'
import { ExportRankingDialog } from '@/components/ranking/ExportRankingDialog'
import { TableSetupDialog } from '@/components/ranking/TableSetupDialog'
import { WorkSearchModal } from '@/components/ranking/WorkSearchModal'
import { toast } from '@/stores/app'
import {
  BACKGROUND_PRESETS,
  MAX_POOLS,
  displayName,
  usedWorkIds,
  useRankingTable,
  type RankingPool,
  type RankingTable,
  type RankingWork,
  type RankingSlot,
  type TierDef
} from '@/stores/rankingTable'

/**
 * 单张排名表的编辑界面：**左侧作品池（可折叠）+ 右侧排名区**。
 *
 * 这里持有几种"临时状态"，都不落盘（它们只描述"此刻的手势"，不是数据）：
 *   · `drag`：正在拖谁、从池子还是从排名区拖的；
 *   · `dropTarget`：当前悬停的落点（档本身 / 两档之间的分界线）；
 *   · `menu`：右键菜单画在哪儿、有哪些项；
 *   · `colorPickTier`：正在改哪一档的标签颜色。
 * 作品池是否折叠**是落盘的**（用户要求"状态要记住"），所以它放在 store 里（`poolVisible`）。
 *
 * 为什么把右键菜单的内容在这里拼、而不是让子组件各弹各的：
 * 「移到哪一档」「归还到哪个池子」这类动作需要同时知道表、池、条目三份数据，
 * 拆到子组件里会让每个子组件都拿到整张表，反而更容易写出不一致的状态。
 * 子组件只负责「长什么样 + 通知我点了什么」。
 */

export function RankingEditor({ table, onBack }: { table: RankingTable; onBack: () => void }) {
  const renameTable = useRankingTable((s) => s.renameTable)
  const setTiersAction = useRankingTable((s) => s.setTiers)
  const setTierColor = useRankingTable((s) => s.setTierColor)
  const setBackground = useRankingTable((s) => s.setBackground)
  const addPoolAction = useRankingTable((s) => s.addPool)
  const renamePool = useRankingTable((s) => s.renamePool)
  const removePool = useRankingTable((s) => s.removePool)
  const addWorks = useRankingTable((s) => s.addWorks)
  const removeWorkFromPool = useRankingTable((s) => s.removeWorkFromPool)
  const placeWork = useRankingTable((s) => s.placeWork)
  const moveRanked = useRankingTable((s) => s.moveRanked)
  const removeRanked = useRankingTable((s) => s.removeRanked)
  const clearRanked = useRankingTable((s) => s.clearRanked)
  const poolVisible = useRankingTable((s) => s.poolVisible)
  const setPoolVisible = useRankingTable((s) => s.setPoolVisible)

  const [activePoolId, setActivePoolId] = useState<string | null>(table.pools[0]?.id ?? null)
  const [drag, setDrag] = useState<{ workId: string; poolId: string | null } | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const [colorPickTier, setColorPickTier] = useState<number | null>(null)

  const [setupOpen, setSetupOpen] = useState(false)
  const [pendingSetup, setPendingSetup] = useState<{ name: string; tiers: TierDef[]; moved: number } | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [poolDialog, setPoolDialog] = useState<{ mode: 'create' | 'rename'; poolId?: string } | null>(null)
  const [poolName, setPoolName] = useState('')
  const [confirmRemovePool, setConfirmRemovePool] = useState<RankingPool | null>(null)

  const existingIds = useMemo(() => usedWorkIds(table), [table])

  // 池子被删 / 表切换后，选中的池子可能已经不存在：自动落到第一个，避免面板空着没人知道为什么
  useEffect(() => {
    if (table.pools.length === 0) {
      setActivePoolId(null)
      return
    }
    if (!table.pools.some((p) => p.id === activePoolId)) setActivePoolId(table.pools[0].id)
  }, [table.pools, activePoolId])

  /** 松手：把拖动项放进目标槽位（锚点为 null = 追加到该槽末尾） */
  function handleDropWork(slot: RankingSlot, anchorId: string | null): void {
    const current = drag
    setDrag(null)
    setDropTarget(null)
    if (!current) return
    if (current.poolId) placeWork(table.id, current.poolId, current.workId, slot, anchorId)
    else moveRanked(table.id, current.workId, slot, anchorId)
    if (slot.straddle) {
      toast.success(
        `已骑缝：同时计入「${table.tiers[slot.tierIndex]?.name}」和「${table.tiers[slot.tierIndex + 1]?.name}」`
      )
    }
  }

  function endDrag(): void {
    setDrag(null)
    setDropTarget(null)
  }

  /** 把某个作品挪到指定槽位（右键菜单里的「移到…」，与拖动等价） */
  function moveToSlot(workId: string, slot: RankingSlot): void {
    moveRanked(table.id, workId, slot, null)
    const upper = table.tiers[slot.tierIndex]?.name ?? ''
    const lower = table.tiers[slot.tierIndex + 1]?.name ?? ''
    toast.success(slot.straddle ? `已骑缝：同时计入「${upper}」和「${lower}」` : `已移到「${upper}」`)
  }

  /** 排名区条目的右键菜单（用户明确要求「右键排名区域的作品可以移除」） */
  function openRankedMenu(e: React.MouseEvent, workId: string): void {
    e.preventDefault()
    e.stopPropagation()
    const work = table.items.find((it) => it.work.id === workId)?.work
    const tierItems: ContextMenuItem[] = table.tiers.map((tier, i) => ({
      key: `tier-${i}`,
      label: `移到「${tier.name}」`,
      onSelect: () => moveToSlot(workId, { tierIndex: i, straddle: false }),
      divider: i === 0
    }))
    // 骑缝位（两档的分界线）也放进菜单：不想拖拽的用户要能同样精确地表达"同时计入上下两档"
    for (let i = 0; i < table.tiers.length - 1; i += 1) {
      tierItems.push({
        key: `straddle-${i}`,
        label: `骑缝：同时计入「${table.tiers[i].name}」+「${table.tiers[i + 1].name}」`,
        onSelect: () => moveToSlot(workId, { tierIndex: i, straddle: true }),
        divider: i === 0
      })
    }
    const items: ContextMenuItem[] = [
      {
        key: 'remove',
        label: '从排名区移除',
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => {
          const back = removeRanked(table.id, workId)
          toast.success(
            back === 'pool'
              ? `已把「${work ? displayName(work) : '作品'}」移出排名区（已放回作品池）`
              : '已从排名区移除（这张表还没有作品池，作品只能丢弃）'
          )
        }
      },
      {
        key: 'move',
        label: '移到其它档 / 骑缝到分界线',
        icon: <ArrowLeft size={13} className="rotate-90" />,
        divider: true,
        onSelect: () => setMenu({ x: e.clientX, y: e.clientY, items: tierItems })
      }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  /** 池子里作品的右键菜单 */
  function openPoolWorkMenu(e: React.MouseEvent, pool: RankingPool, work: RankingWork): void {
    e.preventDefault()
    e.stopPropagation()
    const items: ContextMenuItem[] = [
      {
        key: 'remove',
        label: '从作品池移除',
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => {
          removeWorkFromPool(table.id, pool.id, work.id)
          toast.success(`已从「${pool.name}」移除「${displayName(work)}」`)
        }
      }
    ]
    const others = table.pools.filter((p) => p.id !== pool.id)
    if (others.length > 0) {
      items.push({
        key: 'move',
        label: '移到其它作品池',
        divider: true,
        onSelect: () =>
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: others.map((p) => ({
              key: p.id,
              label: `移到「${p.name}」`,
              onSelect: () => {
                removeWorkFromPool(table.id, pool.id, work.id)
                const r = addWorks(table.id, p.id, [work])
                if (r.added === 0) toast.warn(`「${p.name}」里已经有它了`)
                else toast.success(`已移到「${p.name}」`)
              }
            }))
          })
      })
    }
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  /** 池子标签的右键菜单 */
  function openPoolMenu(e: React.MouseEvent, pool: RankingPool): void {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: 'rename',
          label: '重命名作品池',
          icon: <Pencil size={13} />,
          onSelect: () => {
            setPoolName(pool.name)
            setPoolDialog({ mode: 'rename', poolId: pool.id })
          }
        },
        {
          key: 'delete',
          label: '删除作品池',
          icon: <Trash2 size={13} />,
          danger: true,
          divider: true,
          onSelect: () => setConfirmRemovePool(pool)
        }
      ]
    })
  }

  /** 提交「表名 + 等级标签」：会挤出排名的作品先弹确认（用户得知道有几部要回池子） */
  function submitSetup(name: string, tiers: TierDef[]): void {
    const moved = table.items.filter((it) => it.tierIndex >= tiers.length).length
    if (moved > 0) {
      setPendingSetup({ name, tiers, moved })
      return
    }
    applySetup(name, tiers)
  }

  function applySetup(name: string, tiers: TierDef[]): void {
    renameTable(table.id, name)
    const moved = setTiersAction(table.id, tiers)
    toast.success(moved > 0 ? `已保存，${moved} 部作品回到了作品池` : '已保存')
  }

  function handlePickWork(work: RankingWork): void {
    if (!activePoolId) {
      toast.warn('先新建一个作品池')
      return
    }
    const r = addWorks(table.id, activePoolId, [work])
    if (r.added === 0) toast.info(`「${displayName(work)}」已经在这张表里了`)
    else toast.success(`已把「${displayName(work)}」加进作品池`)
  }

  const poolDialogPool = poolDialog?.poolId ? table.pools.find((p) => p.id === poolDialog.poolId) : null

  /** 作品池弹窗的提交（新建 / 重命名共用，靠 poolDialog.mode 区分） */
  function submitPoolDialog(): void {
    const name = poolName.trim()
    if (!name) return
    if (poolDialog?.mode === 'create') {
      const r = addPoolAction(table.id, name)
      if (!r.ok) {
        toast.warn(r.message)
        return
      }
      setActivePoolId(r.pool.id)
      toast.success(`已新建「${r.pool.name}」`)
    } else if (poolDialogPool) {
      renamePool(table.id, poolDialogPool.id, name)
      toast.success('作品池已重命名')
    } else if (poolDialog?.poolId) {
      // 池子在这一瞬间被删了（极端情况）：直接关窗，不写一个已经不存在的东西
      toast.warn('这个作品池已经不存在了')
    }
    setPoolDialog(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部栏（不写死高度：小窗口下按钮会换行，写死高度会被裁掉） */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-elev1/60 px-4 py-1.5">
        <button
          type="button"
          onClick={onBack}
          title="返回排名表列表"
          className="flex h-7 items-center gap-1 rounded-lg border border-border bg-elev1 px-2.5 text-xs text-dim transition-colors hover:border-accent hover:text-accent"
        >
          <ArrowLeft size={13} /> 列表
        </button>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-[260px] truncate text-sm font-semibold" title={table.name}>
            {table.name}
          </span>
          <button
            type="button"
            title="修改表名与等级标签"
            onClick={() => setSetupOpen(true)}
            className="text-faint transition-colors hover:text-accent"
          >
            <Pencil size={12} />
          </button>
        </div>
        <Button size="sm" variant="outline" icon={Hash} onClick={() => setSetupOpen(true)}>
          等级标签
        </Button>

        {/* 背景色：默认白色，改色只影响这张表（导出图也跟着走） */}
        <div className="flex items-center gap-1" title="表背景（默认白色；导出图与它一致）">
          {BACKGROUND_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              title={`背景：${p.label}`}
              onClick={() => setBackground(table.id, p.value)}
              className={`h-5 w-5 rounded-md border transition-transform ${
                table.background.toLowerCase() === p.value.toLowerCase()
                  ? 'border-accent ring-2 ring-accent/40'
                  : 'border-border hover:scale-110'
              }`}
              style={{ background: p.value }}
            />
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="hidden text-[11px] text-faint lg:inline">
            拖卡片进任意档；拖到两档的分界线上会骑缝（同时计入上下两档）· 右键卡片可移出
          </span>
          <Button
            size="sm"
            variant="outline"
            icon={Trash2}
            disabled={table.items.length === 0}
            onClick={() => setConfirmClear(true)}
          >
            清空排名区
          </Button>
          <Button size="sm" icon={ImageDown} disabled={table.items.length === 0} onClick={() => setExportOpen(true)}>
            导出图片
          </Button>
        </div>
      </div>

      {/* 主体：左侧作品池（可折叠）+ 右侧排名区 */}
      <div className="flex min-h-0 flex-1">
        {poolVisible ? (
          <PoolPanel
            table={table}
            activePoolId={activePoolId}
            onSelectPool={setActivePoolId}
            onCreatePool={() => {
              if (table.pools.length >= MAX_POOLS) {
                toast.warn(`最多只能建 ${MAX_POOLS} 个作品池`)
                return
              }
              setPoolName(`作品池 ${table.pools.length + 1}`)
              setPoolDialog({ mode: 'create' })
            }}
            onEditPool={(pool) => {
              setPoolName(pool.name)
              setPoolDialog({ mode: 'rename', poolId: pool.id })
            }}
            onPoolContextMenu={openPoolMenu}
            onWorkContextMenu={openPoolWorkMenu}
            onRemoveWork={(pool, work) => {
              removeWorkFromPool(table.id, pool.id, work.id)
              toast.success(`已从「${pool.name}」移除「${displayName(work)}」`)
            }}
            onOpenSearch={(keyword) => {
              setSearchKeyword(keyword)
              setSearchOpen(true)
            }}
            onCollapse={() => setPoolVisible(false)}
            draggingWorkId={drag?.workId ?? null}
            onDragStartWork={(workId, poolId) => setDrag({ workId, poolId })}
            onDragEnd={endDrag}
          />
        ) : (
          <PoolRail
            onExpand={() => setPoolVisible(true)}
            count={table.pools.reduce((n, p) => n + p.works.length, 0)}
          />
        )}

        {/* 排名区：高度由它自己量（一屏放下所有档，见 TierBoard 的自适应排版），所以不滚动 */}
        <div className="min-h-0 min-w-0 flex-1">
          <TierBoard
            table={table}
            draggingWorkId={drag?.workId ?? null}
            dropTarget={dropTarget}
            onHover={setDropTarget}
            onDropWork={handleDropWork}
            onDragStartWork={(workId) => setDrag({ workId, poolId: null })}
            onDragEnd={endDrag}
            onItemContextMenu={(e, item) => openRankedMenu(e, item.work.id)}
            colorPickTier={colorPickTier}
            onToggleColorPick={(i) => setColorPickTier((cur) => (cur === i ? null : i))}
            onPickColor={(i, color) => setTierColor(table.id, i, color)}
          />
        </div>
      </div>

      <ContextMenu open={menu !== null} x={menu?.x ?? 0} y={menu?.y ?? 0} items={menu?.items ?? []} onClose={() => setMenu(null)} />

      <TableSetupDialog
        open={setupOpen}
        mode="edit"
        initialName={table.name}
        initialTiers={table.tiers}
        onClose={() => setSetupOpen(false)}
        onSubmit={submitSetup}
      />

      <ConfirmModal
        open={pendingSetup !== null}
        title="有作品会离开排名区"
        message={`新的等级标签只有 ${pendingSetup?.tiers.length ?? 0} 档，有 ${pendingSetup?.moved ?? 0} 部作品原本排在被删掉的档里。保存后它们会回到作品池（不会丢失，可以重新摆）；骑缝作品若只剩上方那一档，会自动改成坐在那一档里。`}
        confirmText="保存"
        onConfirm={() => {
          if (pendingSetup) applySetup(pendingSetup.name, pendingSetup.tiers)
        }}
        onClose={() => setPendingSetup(null)}
      />

      <ConfirmModal
        open={confirmClear}
        title="清空排名区"
        message={`确定把 ${table.items.length} 部作品全部移出排名区吗？它们会回到各自的来源作品池，等级标签保持不变。`}
        confirmText="清空"
        danger
        onConfirm={() => {
          const n = clearRanked(table.id)
          toast.success(n > 0 ? `已清空排名区，${n} 部作品回到作品池` : '排名区已经是空的')
        }}
        onClose={() => setConfirmClear(false)}
      />

      <ConfirmModal
        open={confirmRemovePool !== null}
        title="删除作品池"
        message={`确定删除「${confirmRemovePool?.name ?? ''}」吗？池子里的 ${confirmRemovePool?.works.length ?? 0} 部候选作品会一起删掉；已经排进排名区的作品不受影响。`}
        confirmText="删除"
        danger
        onConfirm={() => {
          if (!confirmRemovePool) return
          removePool(table.id, confirmRemovePool.id)
          toast.success(`已删除「${confirmRemovePool.name}」`)
        }}
        onClose={() => setConfirmRemovePool(null)}
      />

      {/* 作品池的新建 / 重命名 */}
      <Modal
        open={poolDialog !== null}
        onClose={() => setPoolDialog(null)}
        title={poolDialog?.mode === 'create' ? '新建作品池' : '重命名作品池'}
        width={420}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-dim">
            <Layers size={13} className="text-accent" /> 池子名字
          </div>
          <Input
            value={poolName}
            autoFocus
            maxLength={20}
            placeholder="例如：今年看过的番剧"
            onChange={(e) => setPoolName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              submitPoolDialog()
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPoolDialog(null)}>
              取消
            </Button>
            <Button icon={Check} disabled={poolName.trim().length === 0} onClick={submitPoolDialog}>
              {poolDialog?.mode === 'create' ? '创建' : '保存'}
            </Button>
          </div>
        </div>
      </Modal>

      <ExportRankingDialog open={exportOpen} table={table} onClose={() => setExportOpen(false)} />

      <WorkSearchModal
        open={searchOpen}
        initialKeyword={searchKeyword}
        existingIds={existingIds}
        onPick={handlePickWork}
        onClose={() => setSearchOpen(false)}
      />
    </div>
  )
}

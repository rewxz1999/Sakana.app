import { useEffect, useMemo, useState } from 'react'
import { Anchor, ArrowLeft, Check, Hash, ImageDown, Layers, Palette, Pencil, Trash2 } from 'lucide-react'
import { Button, ConfirmModal, IconButton, Input, Modal } from '@/components/ui'
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
  TIER_COLOR_PRESETS,
  displayName,
  readableTextOn,
  usedWorkIds,
  useRankingTable,
  type RankingPool,
  type RankingTable,
  type RankingWork,
  type RankingAnchor,
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
  const setTierName = useRankingTable((s) => s.setTierName)
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
  const addAnchor = useRankingTable((s) => s.addAnchor)
  const renameAnchor = useRankingTable((s) => s.renameAnchor)
  const moveAnchor = useRankingTable((s) => s.moveAnchor)
  const removeAnchor = useRankingTable((s) => s.removeAnchor)
  const poolVisible = useRankingTable((s) => s.poolVisible)
  const setPoolVisible = useRankingTable((s) => s.setPoolVisible)

  const [activePoolId, setActivePoolId] = useState<string | null>(table.pools[0]?.id ?? null)
  /**
   * 拖动状态：拖作品（可能来自池子或排名区）或拖锚点。
   * 分成两种 kind 而不是再加一堆布尔，是因为"落点怎么解释"完全取决于拖的是什么：
   * 拖作品 = 放到档里/分界线上；拖锚点 = 把锚点移到那条分界线的哪一格。
   */
  const [drag, setDrag] = useState<
    { kind: 'work'; workId: string; poolId: string | null } | { kind: 'anchor'; anchorId: string } | null
  >(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const [colorPickTier, setColorPickTier] = useState<number | null>(null)
  /** 导出背景色的浮层是否打开 */
  const [bgPickOpen, setBgPickOpen] = useState(false)
  /** 右键标签改内容：正在编辑哪一档 + 草稿 */
  const [tierNameEdit, setTierNameEdit] = useState<{ index: number; draft: string } | null>(null)
  /** 右键标签 → 自定义颜色：正在挑哪一档的色 */
  const [tierColorEdit, setTierColorEdit] = useState<{ index: number; draft: string } | null>(null)
  /** 锚点改名弹窗（刚加完锚点也会弹一次，让用户顺手起个名字） */
  const [anchorNameEdit, setAnchorNameEdit] = useState<{ id: string; draft: string } | null>(null)

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

  /**
   * 松手：把拖动项放进目标槽位。
   * `slot.position`（骑缝落在第几格）与 `slot.anchorId`（吸附到哪个锚点）由画布按坐标算好后带上来，
   * 所以这里不再自己判断位置 —— 所见即所得（ghost 画在哪儿，作品就落在哪儿）。
   */
  function handleDropWork(slot: RankingSlot): void {
    const current = drag
    setDrag(null)
    setDropTarget(null)
    if (!current || current.kind !== 'work') return
    if (current.poolId) placeWork(table.id, current.poolId, current.workId, slot)
    else moveRanked(table.id, current.workId, slot)
    if (slot.straddle) {
      const anchor = slot.anchorId ? table.anchors.find((a) => a.id === slot.anchorId) : null
      toast.success(
        anchor
          ? `已钉在锚点「${anchor.name || '未命名'}」上（同时计入上下两档）`
          : `已骑缝：落在「${table.tiers[slot.tierIndex]?.name}」与「${table.tiers[slot.tierIndex + 1]?.name}」的分界线上`
      )
    }
  }

  /** 锚点落定：沿分界线（或换一条分界线）移动 */
  function handleDropAnchor(anchorId: string, tierIndex: number, slot: number): void {
    setDrag(null)
    setDropTarget(null)
    moveAnchor(table.id, anchorId, tierIndex, slot)
    const anchor = table.anchors.find((a) => a.id === anchorId)
    toast.success(anchor ? `锚点「${anchor.name || '未命名'}」已移动` : '锚点已移动')
  }

  function endDrag(): void {
    setDrag(null)
    setDropTarget(null)
  }

  /** 把某个作品挪到指定槽位（右键菜单里的「移到…」，与拖动等价） */
  function moveToSlot(workId: string, slot: RankingSlot): void {
    moveRanked(table.id, workId, slot)
    const upper = table.tiers[slot.tierIndex]?.name ?? ''
    const lower = table.tiers[slot.tierIndex + 1]?.name ?? ''
    toast.success(slot.straddle ? `已骑缝：落在「${upper}」与「${lower}」的分界线上` : `已移到「${upper}」`)
  }

  /** 分界线的右键菜单：在这条线上加锚点（用户要求"可以给分界线上添加锚点"） */
  function openBoundaryMenu(e: React.MouseEvent, tierIndex: number, slot: number): void {
    e.preventDefault()
    e.stopPropagation()
    const upper = table.tiers[tierIndex]?.name ?? ''
    const lower = table.tiers[tierIndex + 1]?.name ?? ''
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: 'add-anchor',
          label: `在「${upper} / ${lower}」分界线上加锚点`,
          icon: <Anchor size={13} />,
          onSelect: () => {
            const r = addAnchor(table.id, tierIndex, slot)
            if (!r.ok) {
              toast.warn(r.message)
              return
            }
            setAnchorNameEdit({ id: r.anchor.id, draft: '' })
          }
        }
      ]
    })
  }

  /** 锚点的右键菜单：改名 / 删除（删除后钉着的作品回落到普通骑缝位置，不丢作品） */
  function openAnchorMenu(e: React.MouseEvent, anchor: RankingAnchor): void {
    e.preventDefault()
    e.stopPropagation()
    const pinned = table.items.filter((it) => it.anchorId === anchor.id).length
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: 'anchor-rename',
          label: '给锚点改名…',
          icon: <Pencil size={13} />,
          onSelect: () => setAnchorNameEdit({ id: anchor.id, draft: anchor.name })
        },
        {
          key: 'anchor-delete',
          label: '删除锚点',
          icon: <Trash2 size={13} />,
          danger: true,
          divider: true,
          onSelect: () => {
            const kept = removeAnchor(table.id, anchor.id)
            toast.success(
              kept > 0
                ? `已删除锚点，${kept} 部作品回落到分界线上的原位置`
                : '已删除锚点'
            )
          }
        },
        {
          key: 'anchor-pinned',
          label: pinned > 0 ? `（这个锚点钉着 ${pinned} 部作品）` : '（这个锚点还没有作品）',
          onSelect: () => undefined
        }
      ]
    })
  }

  /** 排名区条目的右键菜单（用户明确要求「右键排名区域的作品可以移除」） */
  function openRankedMenu(e: React.MouseEvent, workId: string): void {
    e.preventDefault()
    e.stopPropagation()
    const work = table.items.find((it) => it.work.id === workId)?.work
    const item = table.items.find((it) => it.work.id === workId)
    const tierItems: ContextMenuItem[] = table.tiers.map((tier, i) => ({
      key: `tier-${i}`,
      label: `移到「${tier.name}」`,
      onSelect: () => moveToSlot(workId, { tierIndex: i, straddle: false }),
      divider: i === 0
    }))
    // 分界线也放进菜单：不想拖拽的用户要能同样精确地表达"落在分界线上"
    for (let i = 0; i < table.tiers.length - 1; i += 1) {
      tierItems.push({
        key: `straddle-${i}`,
        label: `骑缝：落在「${table.tiers[i].name}」/「${table.tiers[i + 1].name}」分界线`,
        onSelect: () => moveToSlot(workId, { tierIndex: i, straddle: true, position: item?.slot ?? 0 }),
        divider: i === 0
      })
    }
    // 钉到锚点：只在同一条分界线上有锚点时给（跨分界线挪锚点没有意义，位置会差很远）
    const anchorsHere = item?.straddle ? table.anchors.filter((a) => a.tierIndex === item.tierIndex) : []
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
    if (anchorsHere.length > 0 && item) {
      items.push({
        key: 'pin',
        label: '钉到锚点',
        icon: <Anchor size={13} />,
        divider: true,
        onSelect: () =>
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              ...anchorsHere.map((a) => ({
                key: `pin-${a.id}`,
                label: `${item.anchorId === a.id ? '✓ ' : ''}${a.name || '未命名'}（第 ${a.slot + 1} 格）`,
                onSelect: () => {
                  moveRanked(table.id, workId, {
                    tierIndex: item.tierIndex,
                    straddle: true,
                    position: a.slot,
                    anchorId: a.id
                  })
                  toast.success(`已钉在锚点「${a.name || '未命名'}」上`)
                }
              })),
              ...(item.anchorId
                ? [
                    {
                      key: 'unpin',
                      label: '解除锚点（留在分界线原位）',
                      divider: true,
                      onSelect: () => {
                        moveRanked(table.id, workId, {
                          tierIndex: item.tierIndex,
                          straddle: true,
                          position: item.slot
                        })
                        toast.success('已解除锚点，作品留在分界线上的原位置')
                      }
                    }
                  ]
                : [])
            ]
          })
      })
    }
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  /**
   * 等级标签的右键菜单（用户明确要求：**右键标签就能改内容与颜色**）。
   *
   * 颜色做二级菜单（色点直接就是选项，选完即改），"自定义颜色…"再开一个小弹窗用系统取色器；
   * 标签右上角的小色板入口保留（两条路都能走，右键是用户点名要的那条）。
   */
  function openTierMenu(e: React.MouseEvent, tierIndex: number): void {
    e.preventDefault()
    e.stopPropagation()
    const tier = table.tiers[tierIndex]
    if (!tier) return
    const colorItems: ContextMenuItem[] = TIER_COLOR_PRESETS.map((c) => ({
      key: `tier-color-${c}`,
      label: c.toLowerCase() === tier.color.toLowerCase() ? `${c}（当前）` : c,
      icon: (
        <span
          className="inline-block h-3 w-3 shrink-0 rounded-sm border border-border"
          style={{ background: c }}
        />
      ),
      onSelect: () => {
        setTierColor(table.id, tierIndex, c)
        toast.success(`「${tier.name}」的颜色已更新`)
      }
    }))
    colorItems.push({
      key: 'tier-color-custom',
      label: '自定义颜色…',
      divider: true,
      onSelect: () => setTierColorEdit({ index: tierIndex, draft: tier.color })
    })
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: 'tier-name',
          label: '改标签内容…',
          icon: <Pencil size={13} />,
          onSelect: () => setTierNameEdit({ index: tierIndex, draft: tier.name })
        },
        {
          key: 'tier-color',
          label: '改标签颜色',
          icon: <Palette size={13} />,
          onSelect: () => setMenu({ x: e.clientX, y: e.clientY, items: colorItems })
        }
      ]
    })
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

  /** 提交标签改名（重名/空名由 store 拒绝，这里把原因如实告诉用户） */
  function submitTierName(): void {
    if (!tierNameEdit) return
    const r = setTierName(table.id, tierNameEdit.index, tierNameEdit.draft)
    if (!r.ok) {
      toast.warn(r.message)
      return
    }
    toast.success('标签已更新')
    setTierNameEdit(null)
  }

  /** 提交标签自定义颜色 */
  function submitTierColor(): void {
    if (!tierColorEdit) return
    setTierColor(table.id, tierColorEdit.index, tierColorEdit.draft)
    toast.success('标签颜色已更新')
    setTierColorEdit(null)
  }

  /** 提交锚点名字（空名字允许 = 界面显示「未命名」；已经建好的锚点不需要再删） */
  function submitAnchorName(): void {
    if (!anchorNameEdit) return
    const draft = anchorNameEdit.draft.trim()
    if (draft.length === 0) {
      setAnchorNameEdit(null)
      return
    }
    const r = renameAnchor(table.id, anchorNameEdit.id, draft)
    if (!r.ok) {
      toast.warn(r.message)
      return
    }
    toast.success('锚点名字已更新')
    setAnchorNameEdit(null)
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
      {/* 顶部栏（不写死高度：小窗口下按钮会换行，写死高度会被裁掉）；
          按钮统一用 @/components/ui 的 Button / IconButton，与应用其它页面一致 */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-elev1/60 px-4 py-1.5">
        <Button size="sm" variant="outline" icon={ArrowLeft} onClick={onBack}>
          列表
        </Button>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-[260px] truncate text-sm font-semibold" title={table.name}>
            {table.name}
          </span>
          <IconButton title="修改表名与等级标签" onClick={() => setSetupOpen(true)}>
            <Pencil size={12} />
          </IconButton>
        </div>
        <Button size="sm" variant="outline" icon={Hash} onClick={() => setSetupOpen(true)}>
          等级标签
        </Button>

        {/* 导出背景：决定导出图片的底色（界面本身跟随应用主题，不再用这张表的背景色画） */}
        <div className="relative">
          <Button
            size="sm"
            variant={bgPickOpen ? 'soft' : 'outline'}
            icon={Palette}
            title="导出图片的背景色（默认白色；只影响导出图）"
            onClick={() => setBgPickOpen((v) => !v)}
          >
            导出背景
          </Button>
          {bgPickOpen ? (
            <div className="absolute left-0 top-full z-40 mt-1 w-[188px] rounded-xl border border-border bg-elev1 p-2 shadow-2xl">
              <div className="mb-1 text-[10px] text-faint">导出图片的背景色</div>
              <div className="grid grid-cols-5 gap-1">
                {BACKGROUND_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    title={p.label}
                    onClick={() => {
                      setBackground(table.id, p.value)
                      setBgPickOpen(false)
                    }}
                    className={`h-6 w-6 rounded-md border transition-transform hover:scale-110 ${
                      table.background.toLowerCase() === p.value.toLowerCase()
                        ? 'border-accent ring-2 ring-accent/40'
                        : 'border-border'
                    }`}
                    style={{ background: p.value }}
                  />
                ))}
              </div>
              <div className="mt-1.5 text-[10px] leading-relaxed text-faint">
                界面按应用主题绘制，这个底色只写进导出图片。
              </div>
            </div>
          ) : null}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="hidden text-[11px] text-faint lg:inline">
            拖卡片进任意一档（整行都能放）；拖到两档分界线上会骑缝 · 右键卡片或标签打开菜单
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
            draggingWorkId={drag?.kind === 'work' ? drag.workId : null}
            onDragStartWork={(workId, poolId) => setDrag({ kind: 'work', workId, poolId })}
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
            draggingWorkId={drag?.kind === 'work' ? drag.workId : null}
            draggingAnchorId={drag?.kind === 'anchor' ? drag.anchorId : null}
            dropTarget={dropTarget}
            onHover={setDropTarget}
            onDropWork={handleDropWork}
            onDropAnchor={handleDropAnchor}
            onDragStartWork={(workId) => setDrag({ kind: 'work', workId, poolId: null })}
            onDragStartAnchor={(anchorId) => setDrag({ kind: 'anchor', anchorId })}
            onDragEnd={endDrag}
            onItemContextMenu={(e, item) => openRankedMenu(e, item.work.id)}
            onTierContextMenu={openTierMenu}
            onAnchorContextMenu={openAnchorMenu}
            onBoundaryContextMenu={openBoundaryMenu}
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

      {/* 锚点改名（刚加完锚点会主动弹一次：用户要求锚点"能有名字"） */}
      <Modal open={anchorNameEdit !== null} onClose={() => setAnchorNameEdit(null)} title="锚点名字" width={420}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-dim">
            <Anchor size={13} className="text-accent" /> 给这个锚点起个名字
          </div>
          <Input
            value={anchorNameEdit?.draft ?? ''}
            autoFocus
            maxLength={16}
            placeholder="例如：神作线 / 本命 / 待定"
            onChange={(e) => setAnchorNameEdit((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAnchorName()
            }}
          />
          <div className="text-[11px] leading-relaxed text-faint">
            留空也可以（界面会显示「未命名」）。锚点用来把作品钉在分界线的固定位置，
            拖动锚点会带着它上面的作品一起移动。
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAnchorNameEdit(null)}>
              取消
            </Button>
            <Button icon={Check} onClick={submitAnchorName}>
              保存
            </Button>
          </div>
        </div>
      </Modal>

      {/* 右键标签 → 改标签内容 */}
      <Modal open={tierNameEdit !== null} onClose={() => setTierNameEdit(null)} title="改标签内容" width={420}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-dim">
            <Pencil size={13} className="text-accent" /> 第 {(tierNameEdit?.index ?? 0) + 1} 档的标签
          </div>
          <Input
            value={tierNameEdit?.draft ?? ''}
            autoFocus
            maxLength={12}
            placeholder="例如：人上人"
            onChange={(e) => setTierNameEdit((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitTierName()
            }}
          />
          <div className="text-[11px] text-faint">改名不会影响这一档里已经排好的作品。</div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setTierNameEdit(null)}>
              取消
            </Button>
            <Button icon={Check} disabled={(tierNameEdit?.draft ?? '').trim().length === 0} onClick={submitTierName}>
              保存
            </Button>
          </div>
        </div>
      </Modal>

      {/* 右键标签 → 自定义颜色 */}
      <Modal open={tierColorEdit !== null} onClose={() => setTierColorEdit(null)} title="自定义标签颜色" width={420}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={tierColorEdit?.draft ?? '#ffffff'}
              onChange={(e) => setTierColorEdit((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
              className="h-9 w-16 cursor-pointer rounded-lg border border-border bg-elev1 p-1"
            />
            <Input
              value={tierColorEdit?.draft ?? ''}
              maxLength={7}
              onChange={(e) => setTierColorEdit((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
              className="w-[140px] font-mono"
            />
            <span
              className="flex h-9 flex-1 items-center justify-center rounded-lg border text-sm font-bold"
              style={{
                background: tierColorEdit?.draft ?? '#ffffff',
                color: readableTextOn(tierColorEdit?.draft ?? '#ffffff'),
                borderColor: 'rgba(0,0,0,0.14)'
              }}
            >
              {table.tiers[tierColorEdit?.index ?? 0]?.name ?? ''}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {TIER_COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => setTierColorEdit((cur) => (cur ? { ...cur, draft: c } : cur))}
                className="h-6 w-6 rounded-md border border-border transition-transform hover:scale-110"
                style={{ background: c }}
              />
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setTierColorEdit(null)}>
              取消
            </Button>
            <Button icon={Check} onClick={submitTierColor}>
              保存
            </Button>
          </div>
        </div>
      </Modal>

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

import { useEffect, useState } from 'react'
import { Trophy, ImageDown, Layers, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button, ConfirmModal, EmptyState, Input, Modal, Spinner } from '@/components/ui'
import { ContextMenu, type ContextMenuItem } from '@/components/stat/ContextMenu'
import { RankingEditor } from '@/components/ranking/RankingEditor'
import { TableSetupDialog } from '@/components/ranking/TableSetupDialog'
import { toast } from '@/stores/app'
import { DEFAULT_TIERS, tierNames, useRankingTable, type RankingTable } from '@/stores/rankingTable'

/**
 * 「作品评级排名表」（工具页入口 /tools/ranking）。
 *
 * 这个工具做两件事：
 *   ① **多张表的列表**：新建 / 打开 / 重命名 / 删除（用户要求支持多张）；
 *   ② **单张表的编辑界面**：左侧是自建作品池（可折叠、状态记住），右侧是排名区
 *      —— 等级标签在左并带自定义颜色，作品从池子里拖进任意档；
 *      拖到两档之间的分界线上会**骑缝**（中心挂在线上、上下两档各占一位）。
 *      排名区按档数自适应压缩，一屏完整放下最多 10 档（不出现滚动）。排完可导出高清图片。
 *
 * 两级视图用组件内部状态切换（而不是各自一个路由）：
 * 列表与编辑界面共享同一份 store 数据、同一个「当前打开的表」概念，
 * 拆成两个路由就要处理「直接打开 /tools/ranking/:id 时表还没从磁盘读出来」的空窗，
 * 收益（URL 可分享）在这个桌面工具里几乎为零。
 *
 * 数据落盘见 stores/rankingTable.ts 的说明（表数据 `sakana-ranking`、界面偏好 `sakana-ranking-ui`，都整份写回）。
 */
export function RankingTablePage() {
  const tables = useRankingTable((s) => s.tables)
  const loaded = useRankingTable((s) => s.loaded)
  const load = useRankingTable((s) => s.load)
  const createTable = useRankingTable((s) => s.createTable)
  const deleteTable = useRankingTable((s) => s.deleteTable)
  const renameTable = useRankingTable((s) => s.renameTable)

  /** 当前正在编辑哪张表（null = 停在列表页） */
  const [openId, setOpenId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<RankingTable | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<RankingTable | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const opened = openId ? (tables.find((t) => t.id === openId) ?? null) : null
  // 表被删掉（或另一个窗口删掉了它）时自动退回列表，避免停在一个不存在的表的编辑界面上
  useEffect(() => {
    if (openId && loaded && !tables.some((t) => t.id === openId)) setOpenId(null)
  }, [openId, loaded, tables])

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    )
  }

  if (opened) {
    return <RankingEditor table={opened} onBack={() => setOpenId(null)} />
  }

  function openTableMenu(e: React.MouseEvent, table: RankingTable): void {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: 'open',
          label: '打开',
          icon: <Layers size={13} />,
          onSelect: () => setOpenId(table.id)
        },
        {
          key: 'rename',
          label: '重命名',
          icon: <Pencil size={13} />,
          divider: true,
          onSelect: () => {
            setRenameDraft(table.name)
            setRenameTarget(table)
          }
        },
        {
          key: 'delete',
          label: '删除这张表',
          icon: <Trash2 size={13} />,
          danger: true,
          onSelect: () => setDeleteTarget(table)
        }
      ]
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-elev1/60 px-5">
        <Trophy size={15} className="text-accent" />
        <span className="text-sm font-semibold">作品评级排名表</span>
        <span className="text-[11px] text-faint">
          给作品分等级排位：等级标签在左、作品在中间、作品池在底部，排完可导出成高清图片
        </span>
        <div className="ml-auto">
          <Button icon={Plus} onClick={() => setCreateOpen(true)}>
            新建排名表
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {tables.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title="还没有排名表"
            desc="新建一张表：填表名 → 选一套默认等级标签（夯/顶级/人上人… 或 T0–T4、S–D），也可以自己写一套；然后建作品池、从收藏 / 书签 / galgame 导入作品并拖进等级里排位。"
          >
            <Button icon={Plus} onClick={() => setCreateOpen(true)}>
              新建排名表
            </Button>
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-2">
            {tables.map((table) => (
              <div
                key={table.id}
                role="button"
                tabIndex={0}
                onClick={() => setOpenId(table.id)}
                onContextMenu={(e) => openTableMenu(e, table)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setOpenId(table.id)
                }}
                title="点击打开 · 右键打开菜单"
                className="flex cursor-pointer items-center gap-4 rounded-xl border border-border bg-elev1 p-3 transition-colors hover:border-accent/50"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
                  <ImageDown size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-1 text-sm font-semibold">{table.name}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                    {/* 等级标签的色点：列表上一眼就能认出是哪套模板 / 自己配的什么色 */}
                    <span className="flex shrink-0 items-center gap-0.5">
                      {table.tiers.map((tier, i) => (
                        <span
                          key={`${tier.name}-${i}`}
                          className="h-2.5 w-2.5 rounded-sm border border-black/10"
                          style={{ background: tier.color }}
                          title={`${tier.name}：${tier.color}`}
                        />
                      ))}
                    </span>
                    <span className="line-clamp-1">
                      {tierNames(table.tiers).join(' > ')} · 排名区 {table.items.length} 部 · 作品池{' '}
                      {table.pools.length} 个（共 {table.pools.reduce((n, p) => n + p.works.length, 0)} 部候选）
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    icon={Pencil}
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenameDraft(table.name)
                      setRenameTarget(table)
                    }}
                  >
                    重命名
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={Trash2}
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteTarget(table)
                    }}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
            <div className="mt-1 text-[11px] leading-relaxed text-faint">
              共 {tables.length} 张表。每张表的等级标签与作品互相独立；表数据存在本机（sakana-ranking）。
            </div>
          </div>
        )}
      </div>

      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu?.items ?? []}
        onClose={() => setMenu(null)}
      />

      {/* 新建：表名 + 等级标签一次做完（见 TableSetupDialog 的说明） */}
      <TableSetupDialog
        open={createOpen}
        mode="create"
        initialName=""
        initialTiers={DEFAULT_TIERS}
        onClose={() => setCreateOpen(false)}
        onSubmit={(name, tiers) => {
          const table = createTable(name, tiers)
          setOpenId(table.id)
          toast.success(`已创建「${table.name}」，先建一个作品池吧`)
        }}
      />

      <Modal open={renameTarget !== null} onClose={() => setRenameTarget(null)} title="重命名排名表" width={420}>
        <div className="flex flex-col gap-3">
          <Input
            value={renameDraft}
            autoFocus
            maxLength={40}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameTarget && renameDraft.trim()) {
                renameTable(renameTarget.id, renameDraft)
                toast.success('表名已更新')
                setRenameTarget(null)
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button
              disabled={renameDraft.trim().length === 0}
              onClick={() => {
                if (!renameTarget) return
                renameTable(renameTarget.id, renameDraft)
                toast.success('表名已更新')
                setRenameTarget(null)
              }}
            >
              保存
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={deleteTarget !== null}
        title="删除排名表"
        message={`确定删除「${deleteTarget?.name ?? ''}」吗？表里的 ${deleteTarget?.items.length ?? 0} 部排名作品与 ${deleteTarget?.pools.length ?? 0} 个作品池会一起删掉，且无法恢复。`}
        confirmText="删除"
        danger
        onConfirm={() => {
          if (!deleteTarget) return
          deleteTable(deleteTarget.id)
          toast.success(`已删除「${deleteTarget.name}」`)
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  )
}

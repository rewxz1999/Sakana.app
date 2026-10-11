import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ImageDown, Pencil, Plus, RefreshCw, Star, Trash2, UserRound } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { MAX_LONG_PAGES, type RecommendTable } from '@/stores/recommendTable'
import { Badge, Button, ConfirmModal, EmptyState, Input, Modal } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import { ContextMenu, type ContextMenuItem } from '@/components/stat/ContextMenu'
import { displayName } from './styles'

/**
 * 「番剧推荐表」的**列表视图**（外面那张表，v0.3.9 从页面里拆出来）。
 *
 * ## 为什么把四个按钮搬到这里
 *
 * 用户原话：「原先顶部的 输入推荐人、补齐标签、导出为图片、推荐表改名 等按钮
 * **全部移动到外面的表上的右键菜单**中，仅保留 添加作品」。
 * 这四件事的共同点是**作用于整张表**（署名、批量补标签、导出、表名），
 * 放在"表"这一层的右键菜单里比放在某个页面编辑器里更合理 —— 站在列表上就能做。
 *
 * ## 右键菜单与卡片上的按钮是**两套入口，不是二选一**
 *
 * 卡片上的「重命名 / 删除」按钮留着（它们本来就是这一层的东西，用户已经习惯），
 * 右键菜单只是把四个"整表操作"补齐。一个入口只在一个地方出现（避免点哪个才对的分歧），
 * 但同一件事不在菜单里重复一遍 —— 只有删除在两边都有，因为那是卡片上最常用的动作。
 */
export function RecommendTableList({
  tables,
  recommender,
  backfilling,
  onOpen,
  onCreate,
  onRename,
  onRemove,
  onOpenRecommender,
  onBackfill,
  onExportTable
}: {
  tables: RecommendTable[]
  /** 当前署名（右键菜单里显示它的值，让用户知道现在署名是什么） */
  recommender: string
  /** 补齐标签进行中（同一个按钮要显示 loading，避免用户以为没反应又点一次） */
  backfilling: boolean
  onOpen: (tableId: string) => void
  onCreate: (name: string) => void
  onRename: (tableId: string, name: string) => void
  onRemove: (tableId: string) => void
  onOpenRecommender: () => void
  onBackfill: (tableId: string) => void
  onExportTable: (table: RecommendTable) => void
}) {
  const [newName, setNewName] = useState('')
  const navigate = useNavigate()
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  /** 待确认删除的表（删除是不可撤销的：整张表连同每一页的推荐理由/剧照一起没） */
  const [pendingDelete, setPendingDelete] = useState<RecommendTable | null>(null)
  /** 右键菜单（作用对象是**某一张表**，不是"当前打开的表"） */
  const [menu, setMenu] = useState<{ x: number; y: number; tableId: string } | null>(null)
  const menuTable = useMemo(
    () => (menu ? tables.find((t) => t.id === menu.tableId) ?? null : null),
    [menu, tables]
  )

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const t = menuTable
    if (!menu || !t) return []
    return [
      {
        key: 'open',
        label: '打开这张表',
        icon: <Star size={13} />,
        onSelect: () => onOpen(t.id)
      },
      {
        // 署名是**整张表**的东西（印在每一页的番剧名下方、以及导出图里），所以在这里填
        key: 'recommender',
        label: recommender.trim() ? `输入推荐人（当前：${recommender}）` : '输入推荐人（导出署名）',
        icon: <UserRound size={13} />,
        onSelect: () => onOpenRecommender()
      },
      {
        key: 'backfill',
        label: backfilling ? '补齐标签（进行中…）' : '补齐标签 / 播出时间',
        icon: <RefreshCw size={13} />,
        onSelect: () => onBackfill(t.id)
      },
      {
        /*
         * v0.3.9 补充：用户要求把「只导出当前页」搬到**推荐页自己的右键菜单**里，
         * 所以这里保留的是"整张表"那一半语义 —— 打开就是**多页 / 长图**范围（可勾页，最多 5 页）。
         * 两个入口是同一个弹窗，只差默认范围（见 ExportDialog 的 initialMode）；
         * 弹窗里仍能自由切换范围，能力一点没少，只是"从哪进来先看到什么"更清楚了。
         */
        key: 'export',
        label: '导出为图片（多页 / 长图，清晰度 2 / 3 倍）',
        icon: <ImageDown size={13} />,
        onSelect: () => onExportTable(t)
      },
      {
        key: 'rename',
        label: '推荐表改名',
        icon: <Pencil size={13} />,
        onSelect: () => setRenaming({ id: t.id, name: t.name })
      },
      {
        key: 'delete',
        label: '删除这张推荐表',
        icon: <Trash2 size={13} />,
        danger: true,
        divider: true,
        onSelect: () => setPendingDelete(t)
      }
    ]
  }, [menu, menuTable, recommender, backfilling, onOpen, onOpenRecommender, onBackfill, onExportTable])

  const create = (): void => {
    if (!newName.trim()) {
      toast.warn('先给这张推荐表起个名字')
      return
    }
    onCreate(newName)
    setNewName('')
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      {!api.window.isSmallWindow ? (
        <button
          onClick={() => navigate(-1)}
          className="mb-2 flex items-center gap-1.5 text-xs text-dim transition-colors hover:text-text"
        >
          <ArrowLeft size={14} /> 返回
        </button>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold">番剧推荐表</h1>
            <Badge tone="accent">工具</Badge>
          </div>
          <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-faint">
            建一张自己的推荐表（表名自定）→ 搜索或从当季番剧里挑作品（一页一部）→ 翻页阅览每页的推荐卡 →
            导出成图片（只导当前页，或把最多 {MAX_LONG_PAGES} 页拼成一张长图）。
            <br />
            <span className="text-dim">
              在下面的表上**右键**可以进行：输入推荐人 / 补齐标签 / 导出为图片 / 推荐表改名。
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={newName}
            placeholder="推荐表名字，例如 2026 春番推荐"
            className="w-56"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
            }}
          />
          <Button icon={Plus} onClick={create}>
            新建推荐表
          </Button>
        </div>
      </div>

      {tables.length === 0 ? (
        <EmptyState
          icon={Star}
          title="还没有推荐表"
          desc="在上面输入一个表名（例如「2026 春番推荐」）点「新建推荐表」。建好后，左边搜索或选当季番剧加作品，一页放一部。"
        />
      ) : (
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {tables.map((t) => (
            <div
              key={t.id}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, tableId: t.id })
              }}
              className="flex flex-col gap-3 rounded-xl border border-border bg-elev1 p-3.5 transition-colors hover:border-accent/60"
            >
              <div className="flex items-start justify-between gap-2">
                <button onClick={() => onOpen(t.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-semibold">{t.name}</div>
                  <div className="mt-0.5 text-[11px] text-faint">
                    {t.pages.length} 页 · 建于 {new Date(t.createdAt).toLocaleDateString()}
                  </div>
                </button>
                <Button size="sm" variant="soft" onClick={() => onOpen(t.id)}>
                  打开
                </Button>
              </div>
              {/* 表头缩略图：一眼看出这张表里是哪几部番（前 4 张 + 其余张数） */}
              <div className="flex gap-1.5">
                {t.pages.slice(0, 4).map((p) => (
                  <CoverImage
                    key={p.id}
                    src={p.cover}
                    alt={displayName(p)}
                    className="h-16 w-11"
                    rounded="rounded-md"
                  />
                ))}
                {t.pages.length === 0 ? (
                  <div className="flex h-16 flex-1 items-center justify-center rounded-md border border-dashed border-border text-[10px] text-faint">
                    还是一张空表
                  </div>
                ) : null}
                {t.pages.length > 4 ? (
                  <div className="flex h-16 w-11 items-center justify-center rounded-md bg-elev2 text-[11px] text-faint">
                    +{t.pages.length - 4}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRenaming({ id: t.id, name: t.name })}>
                  重命名
                </Button>
                <Button size="sm" variant="danger" icon={Trash2} onClick={() => setPendingDelete(t)}>
                  删除
                </Button>
                {/* 其余四项（推荐人 / 补齐标签 / 导出 / 改名）在这个卡片的**右键菜单**里，见文件头 */}
                <span className="text-[10px] text-faint">右键这张表还有更多</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <ContextMenu
        open={menu != null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />

      {/* 重命名 */}
      <Modal open={renaming != null} onClose={() => setRenaming(null)} title="重命名推荐表" width={420}>
        <Input
          value={renaming?.name ?? ''}
          onChange={(e) => setRenaming((cur) => (cur ? { ...cur, name: e.target.value } : cur))}
        />
        <div className="mt-2 text-[10px] leading-relaxed text-faint">
          表名会印在导出图的页脚上，方便别人知道这是哪一张表。
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRenaming(null)}>
            取消
          </Button>
          <Button
            disabled={!renaming?.name.trim()}
            onClick={() => {
              if (!renaming) return
              onRename(renaming.id, renaming.name)
              setRenaming(null)
              toast.success('已重命名')
            }}
          >
            保存
          </Button>
        </div>
      </Modal>

      <ConfirmModal
        open={pendingDelete != null}
        title="删除这张推荐表？"
        danger
        confirmText="删除"
        message={
          <>
            将删除「{pendingDelete?.name}」以及里面的 {pendingDelete?.pages.length ?? 0} 页推荐内容
            （评分、推荐指数、推荐理由、剧照）。<br />
            这个操作不能撤销。
          </>
        }
        onConfirm={() => {
          if (pendingDelete) {
            onRemove(pendingDelete.id)
            toast.success('已删除')
          }
        }}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  )
}

import { useState } from 'react'
import { ChevronsLeft, FolderPlus, Gamepad2, Layers, Plus, Search, Star, Upload } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { WorkCard } from '@/components/ranking/WorkCard'
import { api } from '@/lib/api'
import { useLibrary } from '@/stores/library'
import { useMarks } from '@/stores/marks'
import { toast } from '@/stores/app'
import {
  MAX_POOLS,
  bangumiWork,
  galgameWork,
  markWork,
  useRankingTable,
  type AddWorksResult,
  type RankingPool,
  type RankingTable,
  type RankingWork
} from '@/stores/rankingTable'

/**
 * 左侧作品池面板（用户要求「作品池移到左侧」+「可隐藏 / 可显示」）。
 *
 * 三个导入入口（收藏 / 书签 / 已导入的 galgame）与「搜索添加」都在这里，
 * 因为它们最终都落到同一件事上：把一批 `RankingWork` 交给 `addWorks`（它负责去重并只写一次盘）。
 * 把这四种来源的差异做成「先各自转成 RankingWork 数组」，下面的逻辑就只有一条路径。
 *
 * 为什么是纵向窄栏而不是以前的底部横条：移到左边之后排名区拿到了整条高度
 * （一屏放下所有档，见 TierBoard 的自适应排版），池子自己纵向滚动，两者互不抢空间。
 * 折叠开关只把面板收成一条细栏（不整块消失）：用户得能一眼看见"它去哪儿了、怎么弄回来"。
 */

/** 导入来源（界面按钮与提示文案共用一份，避免两处叫法不一致） */
type ImportKind = 'favorites' | 'marks' | 'gal'

const IMPORT_LABELS: Record<ImportKind, string> = {
  favorites: '收藏',
  marks: '书签',
  gal: 'galgame 库'
}

export function PoolPanel({
  table,
  activePoolId,
  onSelectPool,
  onCreatePool,
  onEditPool,
  onPoolContextMenu,
  onWorkContextMenu,
  onRemoveWork,
  onOpenSearch,
  onCollapse,
  draggingWorkId,
  onDragStartWork,
  onDragEnd
}: {
  table: RankingTable
  activePoolId: string | null
  onSelectPool: (poolId: string) => void
  onCreatePool: () => void
  onEditPool: (pool: RankingPool) => void
  onPoolContextMenu: (e: React.MouseEvent, pool: RankingPool) => void
  onWorkContextMenu: (e: React.MouseEvent, pool: RankingPool, work: RankingWork) => void
  /** 卡片右上角的「×」（比右键更可发现；两者都调同一个动作） */
  onRemoveWork: (pool: RankingPool, work: RankingWork) => void
  /** 打开搜索添加弹窗（带上输入框里的关键词） */
  onOpenSearch: (keyword: string) => void
  /** 收起作品池（排名区随之变宽） */
  onCollapse: () => void
  draggingWorkId: string | null
  onDragStartWork: (workId: string, poolId: string) => void
  onDragEnd: () => void
}) {
  const [keyword, setKeyword] = useState('')
  const [importing, setImporting] = useState<ImportKind | null>(null)
  const addWorks = useRankingTable((s) => s.addWorks)
  const activePool = table.pools.find((p) => p.id === activePoolId) ?? null

  /** 导入结果统一在这里报（用户必须知道「加了几部、跳过了几部」，不能静默少几条） */
  function report(result: AddWorksResult, label: string): void {
    if (result.added === 0 && result.skipped === 0) {
      toast.info(`${label}里没有可导入的作品`)
      return
    }
    if (result.added === 0) {
      toast.info(`${label}里的 ${result.skipped} 部都已经在这张表里了`)
      return
    }
    toast.success(
      `已从${label}导入 ${result.added} 部${result.skipped > 0 ? `，跳过 ${result.skipped} 部（已经在表里）` : ''}`
    )
  }

  async function runImport(kind: ImportKind): Promise<void> {
    if (!activePoolId) {
      toast.warn('先新建一个作品池，再导入作品')
      return
    }
    setImporting(kind)
    try {
      let works: RankingWork[] = []
      if (kind === 'favorites') {
        if (!useLibrary.getState().loaded) await useLibrary.getState().load()
        works = useLibrary.getState().favorites.map((f) =>
          bangumiWork({
            subjectId: f.subjectId,
            name: f.name,
            nameCn: f.nameCn,
            cover: f.cover,
            rating: f.rating
          })
        )
      } else if (kind === 'marks') {
        if (!useMarks.getState().loaded) await useMarks.getState().load()
        works = useMarks.getState().items.map((m) =>
          markWork({ subjectId: m.subjectId, title: m.title, cover: m.cover })
        )
      } else {
        const r = await api.gal.list()
        if (!r.ok) {
          toast.error(r.error)
          return
        }
        works = r.data.map(galgameWork)
      }
      report(addWorks(table.id, activePoolId, works), IMPORT_LABELS[kind])
    } finally {
      setImporting(null)
    }
  }

  return (
    <aside className="flex h-full w-[252px] shrink-0 flex-col border-r border-border bg-elev1/60">
      {/* 顶栏：标题 + 折叠 */}
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <Layers size={13} className="text-accent" />
        <span className="text-xs font-semibold">作品池</span>
        <span className="text-[10px] text-faint">
          {table.pools.length}/{MAX_POOLS}
        </span>
        <button
          type="button"
          title="收起作品池（排名区会变宽）"
          onClick={onCollapse}
          className="ml-auto rounded p-1 text-faint transition-colors hover:bg-elev2 hover:text-text"
        >
          <ChevronsLeft size={14} />
        </button>
      </div>

      {/* 池子列表（纵向） */}
      <div className="flex shrink-0 flex-col gap-1 px-2 py-2">
        {table.pools.map((pool) => (
          <button
            key={pool.id}
            type="button"
            onClick={() => onSelectPool(pool.id)}
            onDoubleClick={() => onEditPool(pool)}
            onContextMenu={(e) => onPoolContextMenu(e, pool)}
            title="双击改名 · 右键打开菜单"
            className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors ${
              pool.id === activePoolId
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border bg-elev1 text-dim hover:text-text'
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{pool.name}</span>
            <span className="shrink-0 text-[10px] text-faint">{pool.works.length}</span>
          </button>
        ))}
        <Button
          size="sm"
          variant="outline"
          icon={FolderPlus}
          className="w-full"
          disabled={table.pools.length >= MAX_POOLS}
          title={table.pools.length >= MAX_POOLS ? `最多 ${MAX_POOLS} 个作品池` : '新建一个作品池'}
          onClick={onCreatePool}
        >
          新建池（{table.pools.length}/{MAX_POOLS}）
        </Button>
      </div>

      {/* 导入入口 */}
      <div className="flex shrink-0 flex-col gap-1 px-2 pb-2">
        <Button
          size="sm"
          variant="soft"
          icon={Star}
          className="w-full"
          loading={importing === 'favorites'}
          onClick={() => void runImport('favorites')}
        >
          导入收藏
        </Button>
        <Button
          size="sm"
          variant="soft"
          icon={Upload}
          className="w-full"
          loading={importing === 'marks'}
          onClick={() => void runImport('marks')}
        >
          导入书签
        </Button>
        <Button
          size="sm"
          variant="soft"
          icon={Gamepad2}
          className="w-full"
          loading={importing === 'gal'}
          onClick={() => void runImport('gal')}
        >
          导入 galgame
        </Button>
      </div>

      {/* 搜索（番剧 / galgame / 手动添加都在弹窗里，见 WorkSearchModal） */}
      <div className="flex shrink-0 flex-col gap-1 border-t border-border px-2 py-2">
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onOpenSearch(keyword.trim())
          }}
          placeholder="搜索番剧 / galgame"
          className="h-8 text-xs"
        />
        <Button
          size="sm"
          icon={Search}
          className="w-full"
          disabled={!activePoolId}
          onClick={() => onOpenSearch(keyword.trim())}
        >
          搜索添加到池子
        </Button>
      </div>

      {/* 池子里的作品（纵向滚动；卡片可拖到右侧等级里） */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {table.pools.length === 0 ? (
          <div className="mt-1 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-center">
            <div className="text-xs font-medium">先建一个作品池，再从收藏导入作品</div>
            <div className="text-[11px] leading-relaxed text-faint">
              池子存放候选作品（最多 {MAX_POOLS} 个）：可以导入收藏 / 书签 / galgame 库，也可以搜索添加。
            </div>
            <Button size="sm" icon={Plus} onClick={onCreatePool}>
              新建作品池
            </Button>
          </div>
        ) : !activePool ? (
          <div className="py-6 text-center text-xs text-faint">选择一个作品池</div>
        ) : activePool.works.length === 0 ? (
          <div className="py-6 text-center text-[11px] leading-relaxed text-faint">
            「{activePool.name}」还空着
            <br />
            用上面的导入按钮，或搜索添加作品
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {activePool.works.map((work) => (
              <WorkCard
                key={work.id}
                work={work}
                size="pool"
                draggable
                dragging={draggingWorkId === work.id}
                removable
                onDragStart={(id) => onDragStartWork(id, activePool.id)}
                onDragEnd={onDragEnd}
                onRemove={() => onRemoveWork(activePool, work)}
                onContextMenu={(e) => onWorkContextMenu(e, activePool, work)}
                extraTitle="拖到右侧等级里参与排名 · 右键打开菜单"
              />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-1.5 text-[10px] leading-relaxed text-faint">
        拖卡片到右侧等级里排位；拖到两档分界线上会骑缝（同时计入上下两档）
      </div>
    </aside>
  )
}

/** 折叠后的细栏：只留一个展开按钮（不整块消失，用户才知道怎么找回来） */
export function PoolRail({ onExpand, count }: { onExpand: () => void; count: number }) {
  return (
    <div className="flex h-full w-9 shrink-0 flex-col items-center gap-2 border-r border-border bg-elev1/60 py-2">
      <button
        type="button"
        title="展开作品池"
        onClick={onExpand}
        className="rounded p-1 text-faint transition-colors hover:bg-elev2 hover:text-accent"
      >
        <Layers size={14} />
      </button>
      <span className="text-[10px] text-faint">{count}</span>
      <span className="mt-1 select-none text-[11px] tracking-widest text-faint" style={{ writingMode: 'vertical-rl' }}>
        作品池已收起
      </span>
    </div>
  )
}

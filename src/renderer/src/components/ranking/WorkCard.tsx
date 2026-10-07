import { useState } from 'react'
import { GripVertical, X } from 'lucide-react'
import { CoverImage } from '@/components/CoverImage'
import { IconButton } from '@/components/ui'
import { SOURCE_LABELS, displayName, type RankingWork } from '@/stores/rankingTable'

/**
 * 排名表里的一张作品卡：**上封面 + 下名字**。
 *
 * ============================ 样式：照抄应用自己的卡片语言 ============================
 * 用户反馈「排名区域 ui 还是太丑了，就像我们应用主界面 ui 一样来布置就行」，所以这里不再自己造配色，
 * 全部用应用既有的设计令牌与写法（参考 StatToolPage 的条目卡、AnimeCard、ui.tsx）：
 *   · 卡片 = `rounded-lg border bg-elev2 p-1`，hover `border-accent` + `bg-accent-soft`（与应用里"可点/可选"的约定一致）；
 *   · 拖动中 `border-accent/60 opacity-50`，与 StatToolPage 的条目完全一致；
 *   · "这里能拖"用 AnimeCard 那种浮层小图标（`GripVertical` + 半透明黑底）提示，而不是额外的文字；
 *   · 名字 `line-clamp-1/2 leading-snug`，完整名字放 `title`。
 *
 * 尺寸仍然是**数字参数**（排名区按可用高度反算，见 TierBoard 的 layoutFor）：
 * Tailwind 的动态类名（`h-[${n}px]`）不会被 JIT 收集，所以这类尺寸一律走行内 style。
 * `WORK_CARD_CHROME` 是"卡片比封面大出来的一圈"（边框 1px×2 + 内边距 4px×2），
 * 排名区的行宽计算要用它（见 TierBoard），所以在这里定义一次、别处引用。
 *
 * 卡片**不挂 onDragOver / onDrop**：投放判定统一由排名区容器按坐标做（见 TierBoard），
 * 卡片只负责"能拖"和把事件冒泡上去。
 */

/** 卡片相对封面的额外尺寸：左右/上下各 4px 内边距 + 1px 边框（横竖都按这个数算） */
export const WORK_CARD_CHROME = 10

/** 由运行时算出来的卡片尺寸（排名区按可用高度自适应，见 TierBoard） */
export interface WorkCardMetrics {
  /** 封面宽 */
  w: number
  /** 封面高 */
  h: number
  /** 名字最多几行 */
  lines: 1 | 2
  /** 名字字号（像素） */
  font: number
}

/** 左侧作品池里用的固定尺寸（池子宽度固定，不需要自适应） */
const POOL_METRICS: WorkCardMetrics = { w: 66, h: 88, lines: 2, font: 10 }
/** 搜索结果弹窗里的小图 */
const TINY_METRICS: WorkCardMetrics = { w: 52, h: 70, lines: 2, font: 10 }

export type WorkCardSize = 'pool' | 'tiny' | WorkCardMetrics

function metricsOf(size: WorkCardSize): WorkCardMetrics {
  if (size === 'pool') return POOL_METRICS
  if (size === 'tiny') return TINY_METRICS
  return size
}

export function WorkCard({
  work,
  size = 'pool',
  draggable = false,
  dragging = false,
  removable = false,
  showGrip = true,
  highlight = false,
  cornerBadge,
  onDragStart,
  onDragEnd,
  onClick,
  onRemove,
  onContextMenu,
  extraTitle
}: {
  work: RankingWork
  size?: WorkCardSize
  draggable?: boolean
  /** 正被拖动的那一张（虚化显示，与统计工具同一个观感） */
  dragging?: boolean
  /** 卡角显示一个「×」（作品池里用来快速移除；排名区的移除走右键菜单） */
  removable?: boolean
  /** hover 时在封面左上角显示"可拖"手柄（与 StatToolPage 的可发现性一致） */
  showGrip?: boolean
  /** 强制高亮（骑缝卡片这类需要"被指到"的场合） */
  highlight?: boolean
  /**
   * 贴在封面左下角的小角标（骑缝作品用）。
   * 做成"压在封面上的角标"而不是"卡片下面再加一行"：这样卡片高度不变，
   * 骑缝条的高度就等于卡片高度，卡片能在两档之间精确居中（见 TierBoard / boardGeometry）。
   */
  cornerBadge?: React.ReactNode
  onDragStart?: (workId: string) => void
  onDragEnd?: () => void
  onClick?: () => void
  onRemove?: () => void
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void
  extraTitle?: string
}) {
  const m = metricsOf(size)
  const [hover, setHover] = useState(false)
  const name = displayName(work)
  const tip = `${name}${work.nameAlt ? `（${work.nameAlt}）` : ''}\n来源：${SOURCE_LABELS[work.source]}${
    work.rating != null ? `\nbangumi 评分：${work.rating.toFixed(1)}` : ''
  }${extraTitle ? `\n${extraTitle}` : ''}`

  return (
    <div
      draggable={draggable}
      onDragStart={
        draggable
          ? (e): void => {
              e.dataTransfer.effectAllowed = 'move'
              // Firefox 必须 setData 才会真的开始拖拽；顺带把 id 放进 DataTransfer，
              // 让投放方能确认拖的是哪一件（与统计工具条目卡同一个写法）
              e.dataTransfer.setData('text/plain', work.id)
              onDragStart?.(work.id)
            }
          : undefined
      }
      onDragEnd={onDragEnd}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={tip}
      style={{ width: m.w + WORK_CARD_CHROME }}
      className={`group relative shrink-0 rounded-lg border bg-elev2 p-1 transition-colors ${
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      } ${
        dragging
          ? 'border-accent/60 opacity-50'
          : // hover 用纯 CSS（与 StatToolPage 的 `hover:border-accent/40` 同一套约定），
            // JS 的 hover 状态只用来决定"能不能拖"那个小手柄显不显示
            highlight
            ? 'border-accent bg-accent-soft'
            : 'border-border hover:border-accent hover:bg-accent-soft'
      }`}
    >
      <div className="relative">
        {/* CoverImage 只接收 className，尺寸用外层固定盒子 + h-full/w-full 传下去 */}
        <div style={{ width: m.w, height: m.h }} className="overflow-hidden rounded-md">
          <CoverImage src={work.cover} alt={name} className="h-full w-full" rounded="rounded-md" />
        </div>
        {/* "这里能拖"的手柄（浮层小图标，与 AnimeCard 的角标同一个做法） */}
        {draggable && showGrip && hover && !dragging ? (
          <span className="pointer-events-none absolute left-0.5 top-0.5 rounded-md bg-black/40 p-0.5 text-white backdrop-blur-sm">
            <GripVertical size={11} />
          </span>
        ) : null}
        {/* 角标（骑缝）：压在封面左下角，不占卡片高度 */}
        {cornerBadge ? <span className="pointer-events-none absolute bottom-0.5 left-0.5">{cornerBadge}</span> : null}
        {removable && hover && onRemove ? (
          <IconButton
            title="从作品池移除"
            className="absolute -right-1 -top-1 h-5 w-5 bg-danger text-white hover:bg-danger/90 hover:text-white"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            <X size={11} />
          </IconButton>
        ) : null}
      </div>
      {/* 名字：按可用高度决定一行还是两行（见文件头），完整名在 title 里 */}
      <div
        style={{ fontSize: m.font, lineHeight: 1.3, WebkitLineClamp: m.lines }}
        className={m.lines === 1 ? 'mt-1 line-clamp-1 px-0.5' : 'mt-1 line-clamp-2 px-0.5'}
      >
        {name}
      </div>
      {/* 这里刻意什么都不再放：来源角标（番剧/galgame/手动）按用户要求去掉了（占位置），
          来源信息在 title 提示里；骑缝说明由父组件按需画在卡片下方 */}
    </div>
  )
}

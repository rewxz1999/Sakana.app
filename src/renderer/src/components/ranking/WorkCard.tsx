import { useState } from 'react'
import { X } from 'lucide-react'
import { CoverImage } from '@/components/CoverImage'
import { SOURCE_LABELS, displayName, type RankingWork } from '@/stores/rankingTable'

/**
 * 排名表里的一张作品卡：**上封面 + 下名字**（用户明确要求的展示形式）。
 *
 * 为什么卡片自己处理 `draggable` 而不用拖拽库：
 * 项目里没有引第三方拖拽库（也不允许为此加依赖），而「从作品池拖到排名档」这种同窗口内的移动，
 * 原生 HTML5 drag 的 draggable + dataTransfer 已经够用，还能沿用统计工具那一套写法（拖拽中虚化、落点高亮）。
 *
 * 尺寸为什么是**数字参数**而不是几套 Tailwind 预设：
 * 排名区要在一屏里完整放下最多 10 档（用户要求「不要滚动才能看完」），
 * 每张卡的高度只能**按可用高度反算**（见 TierBoard 的 layoutFor），是运行时数值。
 * Tailwind 的动态类名（`h-[${n}px]`）不会被 JIT 收集，所以这类尺寸一律走行内 style。
 *
 * 颜色一律**继承父容器**（不写死）：同一张卡在左侧作品池里要跟随应用主题的浅色文字，
 * 在白色画布上要是深色文字 —— 写死任何一边都会让另一边看不见。
 *
 * 名字用 `line-clamp` 截断而不是撑开卡片：一张表里可能几十张卡，
 * 名字长短不一会让每档高度参差、整张表看起来是散的；截断后所有卡等高，版面才"格式规范"。
 * 完整名字放在 `title` 里，鼠标悬停仍能看到。
 */

/** 由运行时算出来的卡片尺寸（排名区按档数自适应，见 TierBoard） */
export interface WorkCardMetrics {
  /** 封面宽（= 卡片宽） */
  w: number
  /** 封面高 */
  h: number
  /** 名字最多几行 */
  lines: 1 | 2
  /** 名字字号（像素） */
  font: number
  /** 是否显示来源角标（卡片太矮时藏起来，把高度让给名字） */
  showSource: boolean
}

/** 左侧作品池里用的固定尺寸（池子宽度固定，不需要自适应） */
const POOL_METRICS: WorkCardMetrics = { w: 70, h: 96, lines: 2, font: 10, showSource: true }
/** 搜索结果弹窗里的小图 */
const TINY_METRICS: WorkCardMetrics = { w: 52, h: 70, lines: 2, font: 10, showSource: false }

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
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
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
  onDragStart?: (workId: string) => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void
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
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={tip}
      style={{ width: m.w }}
      className={`group relative shrink-0 select-none ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${
        dragging ? 'opacity-40' : ''
      }`}
    >
      <div className="relative">
        {/* CoverImage 只接收 className，尺寸用外层固定盒子 + h-full/w-full 传下去 */}
        <div style={{ width: m.w, height: m.h }} className="overflow-hidden rounded-md">
          <CoverImage src={work.cover} alt={name} className="h-full w-full" rounded="rounded-md" />
        </div>
        {removable && hover && onRemove ? (
          <button
            type="button"
            title="从作品池移除"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-white shadow"
          >
            <X size={10} />
          </button>
        ) : null}
      </div>
      {/* 名字：按可用高度决定一行还是两行（见文件头），完整名在 title 里 */}
      <div
        style={{ fontSize: m.font, lineHeight: 1.25, WebkitLineClamp: m.lines }}
        className={m.lines === 1 ? 'mt-0.5 line-clamp-1' : 'mt-0.5 line-clamp-2'}
        title={name}
      >
        {name}
      </div>
      {/* 来源小角标：三种来源（番剧 / galgame / 手动）在列表里要能一眼区分；颜色随父容器 */}
      {m.showSource ? (
        <span
          style={{ fontSize: Math.max(8, m.font - 1) }}
          className="mt-0.5 inline-block rounded-full border border-current px-1 leading-tight opacity-55"
        >
          {SOURCE_LABELS[work.source]}
        </span>
      ) : null}
    </div>
  )
}

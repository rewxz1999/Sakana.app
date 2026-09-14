import { Heart, Star } from 'lucide-react'
import { Badge, IconButton } from './ui'
import { CoverImage } from './CoverImage'
import type { ReactNode } from 'react'

export interface CardItemData {
  id: number
  name: string
  nameCn: string
  cover: string | null | undefined
  rating: number | null
  airDate?: string | null
}

/** 番剧卡片（方案 3.1：封面 + 评分 + 名称，右上角收藏按钮，浮动悬停效果）
 *  悬停动效用纯 CSS 过渡（GPU 合成），避免大量卡片时的帧动画卡顿 */
export function AnimeCard({
  item,
  fav = false,
  onFav,
  concern = false,
  onConcern,
  onClick,
  badge,
  footer
}: {
  item: CardItemData
  fav?: boolean
  onFav?: () => void
  concern?: boolean
  onConcern?: () => void
  onClick?: () => void
  badge?: ReactNode
  footer?: ReactNode
}) {
  return (
    <div
      onClick={onClick}
      className="group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-elev1 shadow-sm transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:scale-[1.02] hover:shadow-lg hover:shadow-black/10 will-change-transform"
    >
      <div className="relative aspect-[3/4] overflow-hidden">
        <CoverImage src={item.cover} alt={item.nameCn || item.name} className="h-full w-full transition-transform duration-500 group-hover:scale-105" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/55 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
        <div className="absolute left-1.5 top-1.5">{badge}</div>
        <div className="absolute right-1.5 top-1.5 flex flex-col gap-1 opacity-100">
          {onConcern ? (
            <IconButton
              title={concern ? '取消重点关心' : '重点关心'}
              active={concern}
              className="h-7 w-7 bg-black/35 text-white backdrop-blur-sm hover:bg-black/55 hover:text-white"
              onClick={(e) => {
                e.stopPropagation()
                onConcern()
              }}
            >
              <Star size={13} fill={concern ? 'currentColor' : 'none'} />
            </IconButton>
          ) : null}
          {onFav ? (
            <IconButton
              title={fav ? '取消收藏' : '收藏'}
              active={fav}
              className={`h-7 w-7 bg-black/35 text-white backdrop-blur-sm hover:bg-black/55 hover:text-white ${fav ? '!text-accent' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                onFav()
              }}
            >
              <Heart size={13} fill={fav ? 'currentColor' : 'none'} />
            </IconButton>
          ) : null}
        </div>
        {item.rating != null && item.rating > 0 ? (
          <div className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded-md bg-black/50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-300 backdrop-blur-sm">
            <Star size={10} fill="currentColor" />
            {item.rating.toFixed(1)}
          </div>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-1 px-2.5 py-2">
        <div className="line-clamp-2 text-[13px] font-medium leading-snug" title={item.nameCn || item.name}>
          {item.nameCn || item.name || '未知番剧'}
        </div>
        {footer ? <div className="text-[11px] text-faint">{footer}</div> : null}
      </div>
    </div>
  )
}

export function RatingBadge({ score }: { score: number | null }) {
  if (score == null || score <= 0) return <Badge>暂无评分</Badge>
  return (
    <Badge tone="warn">
      <Star size={10} fill="currentColor" /> {score.toFixed(1)}
    </Badge>
  )
}

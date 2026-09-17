import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { CircleCheck, Heart, Search, Star, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { FavoriteItem } from '@shared/types'
import { yearOf } from '@/lib/format'
import { FAVORITE_SORTS, matchesFavoriteQuery, sortFavorites, type FavoriteSort } from '@/lib/favoriteQuery'
import { isCompleted, useLibrary } from '@/stores/library'
import { progressSummary, useWatchProgress } from '@/stores/watchProgress'
import { toast } from '@/stores/app'
import { AnimeCard } from '@/components/AnimeCard'
import { EmptyState } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'

export function FavoritesPage() {
  const navigate = useNavigate()
  const { favorites, keyConcerns, watchHistory, removeFavorite, toggleKeyConcern, removeKeyConcern } = useLibrary()
  // 观看进度（v0.2.4）：搜索已迁出本页，收藏卡片底部改为展示「观看到第几集」
  const { items: progressItems, loaded: progressLoaded, load: loadProgress } = useWatchProgress()
  const [activeYear, setActiveYear] = useState<number | null>(null)
  // 排序 + 关键词筛选（对齐 Kazumi 的收藏库查询）：排序默认「最近变更」= 保持原有顺序
  const [sort, setSort] = useState<FavoriteSort>('recent')
  const [query, setQuery] = useState('')
  const centerRef = useRef<HTMLDivElement>(null)
  const groupRefs = useRef(new Map<number, HTMLDivElement>())
  /** 左侧年份竖条（按住上下拖 = 快速定位；年份多时它自己可滚动） */
  const railRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  // 进页面时加载一次观看进度（store 内已 loaded 则不重复请求主进程）
  useEffect(() => {
    if (!progressLoaded) void loadProgress()
  }, [progressLoaded, loadProgress])

  // 关键词筛选（多词 AND，匹配中文名/原名/别名）→ 再排序；两者都不改变年份分组的构成方式
  const visible = useMemo(() => {
    const q = query.trim()
    const hit = q ? favorites.filter((f) => matchesFavoriteQuery(f, q)) : favorites
    return sortFavorites(hit, sort)
  }, [favorites, query, sort])

  // 年份分组（方案 3.4：按播出年份分组；筛选/排序后重新分组，年份竖条随之只显示有结果的年份）
  const groups = useMemo(() => {
    const map = new Map<number, typeof favorites>()
    for (const f of visible) {
      const y = yearOf(f.airDate)
      const key = y ?? 0
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(f)
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0])
  }, [visible])

  const years = useMemo(() => groups.map(([y]) => y), [groups])

  /**
   * 收藏卡片底部文案（替代原来的类型标签）：
   * 1. 已看完（手动标记过，或观看记录覆盖全部集数）→「已看完」
   * 2. 有观看进度记录（在线/本地播放都会写入 watchProgress）→「观看到第 N 集」
   * 3. 既没标记也没记录 →「尚未观看」
   */
  const progressFooter = (fav: FavoriteItem): ReactNode => {
    if (isCompleted(fav, watchHistory)) {
      return (
        <span className="inline-flex items-center gap-1 text-ok">
          <CircleCheck size={11} /> 已看完
        </span>
      )
    }
    const sum = progressSummary(progressItems, { subjectId: fav.subjectId, title: fav.nameCn || fav.name })
    if (sum.lastEpisode != null) return `观看到第 ${sum.lastEpisode} 集`
    return '尚未观看'
  }

  const onCenterScroll = () => {
    const el = centerRef.current
    if (!el || years.length === 0) return
    let current: number | null = null
    for (const y of years) {
      const node = groupRefs.current.get(y)
      if (node && node.offsetTop <= el.scrollTop + 90) current = y
    }
    setActiveYear(current)
  }

  const scrollToYear = (y: number) => {
    const node = groupRefs.current.get(y)
    if (node && centerRef.current) {
      centerRef.current.scrollTo({ top: node.offsetTop - 8, behavior: 'smooth' })
    }
    // 点击即高亮，不必等列表滚动事件回传（竖条在极短列表下可能收不到滚动）
    setActiveYear(y)
  }

  // 年份竖条拖动定位（方案 3.4）：按下/拖动按纵向比例直接映射到列表滚动位置
  const railScrollTo = (e: React.PointerEvent): void => {
    const rail = railRef.current
    const center = centerRef.current
    if (!rail || !center) return
    const rect = rail.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)))
    center.scrollTop = ratio * (center.scrollHeight - center.clientHeight)
  }
  const onRailPointerDown = (e: React.PointerEvent): void => {
    dragging.current = true
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    railScrollTo(e)
  }
  const onRailPointerMove = (e: React.PointerEvent): void => {
    if (dragging.current) railScrollTo(e)
  }
  const onRailPointerUp = (): void => {
    dragging.current = false
  }

  const concernItems = keyConcerns
    .map((id) => favorites.find((f) => f.subjectId === id))
    .filter((f): f is NonNullable<typeof f> => !!f)

  return (
    <div className="flex h-full min-h-0">
      {/*
        年份切换回到左侧竖条（用户要求：顶部不要再加导航栏遮挡内容）。
        竖条是 flex 子项、占自己的 48px，不绝对定位，所以永远不会压住右边的列表；
        年份多到排不下时竖条自己内部滚动，列表与右侧「重点关心」各自保持原有滚动。
      */}
      <div className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-elev1/50 py-3">
        <div
          ref={railRef}
          className="relative flex min-h-0 flex-1 cursor-grab touch-none flex-col items-center gap-2.5 overflow-y-auto px-1 active:cursor-grabbing [scrollbar-width:none]"
          onPointerDown={onRailPointerDown}
          onPointerMove={onRailPointerMove}
          onPointerUp={onRailPointerUp}
          onPointerCancel={onRailPointerUp}
        >
          {groups.map(([year, items]) => (
            <button
              key={year}
              onClick={() => scrollToYear(year)}
              title={year === 0 ? '年份未知' : `${year} 年`}
              className={`shrink-0 rounded-md px-1.5 py-1 text-center text-[11px] leading-tight tabular-nums transition-colors ${
                activeYear === year ? 'bg-accent-soft font-semibold text-accent' : 'text-faint hover:text-dim'
              }`}
            >
              <span className="block">{year === 0 ? '未知' : year}</span>
              <span className="block text-[9px]">{items.length}</span>
            </button>
          ))}
          {years.length === 0 ? <span className="text-[11px] text-faint">—</span> : null}
        </div>
      </div>

      {/* 中部：排序/筛选栏 + 收藏列表（栏固定在上方，列表自己滚动） */}
      <div className="flex min-w-0 flex-1 flex-col">
        {favorites.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-5 py-2">
            <span className="mr-0.5 whitespace-nowrap text-[11px] text-faint">排序</span>
            {FAVORITE_SORTS.map((m) => (
              <button
                key={m.id}
                title={m.title}
                onClick={() => setSort(m.id)}
                className={`rounded-lg border px-2 py-1 text-[11px] transition-colors whitespace-nowrap ${
                  sort === m.id ? 'border-accent bg-accent-soft text-accent' : 'border-border text-dim hover:border-accent/50'
                }`}
              >
                {m.label}
              </button>
            ))}
            {/* 空格分隔的关键词，全部命中才显示（AND） */}
            <div className="relative ml-auto w-40 shrink-0">
              <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="筛选：空格分隔多个关键词"
                className="h-7 w-full rounded-lg border border-border bg-elev1 pl-7 pr-2 text-[11px] outline-none transition-colors placeholder:text-faint focus:border-accent"
              />
            </div>
          </div>
        ) : null}

        {/* relative：让年份节点的 offsetTop 相对本滚动容器，排序/筛选栏出现时定位不受影响 */}
        <div
          ref={centerRef}
          onScroll={onCenterScroll}
          className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
          {groups.length > 0 ? (
            <div className="space-y-7">
              {groups.map(([year, items]) => (
                <div key={year} ref={(el) => { if (el) groupRefs.current.set(year, el); else groupRefs.current.delete(year) }}>
                  <div className="mb-3 flex items-center gap-2">
                    <h2 className="text-lg font-bold">{year === 0 ? '年份未知' : year}</h2>
                    <span className="text-xs text-faint">{items.length} 部</span>
                  </div>
                  <motion.div layout className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                    {items.map((f) => (
                      <AnimeCard
                        key={f.subjectId}
                        item={{ id: f.subjectId, name: f.name, nameCn: f.nameCn, cover: f.cover, rating: f.rating, airDate: f.airDate }}
                        fav
                        concern={keyConcerns.includes(f.subjectId)}
                        onConcern={() => {
                          toggleKeyConcern(f.subjectId)
                          toast.success(keyConcerns.includes(f.subjectId) ? '已取消重点关心' : '已加入重点关心')
                        }}
                        onFav={() => {
                          removeFavorite(f.subjectId)
                          toast.info('已取消收藏')
                        }}
                        onClick={() => navigate(`/subject/${f.subjectId}`)}
                        footer={progressFooter(f)}
                      />
                    ))}
                  </motion.div>
                </div>
              ))}
            </div>
          ) : favorites.length > 0 ? (
            /* 有收藏但被关键词筛空：给一句提示 + 一键清除，而不是留白 */
            <div className="flex flex-col items-center gap-2.5 py-16 text-center">
              <p className="text-sm text-dim">没有匹配的收藏</p>
              <button
                onClick={() => {
                  setQuery('')
                  setSort('recent')
                }}
                className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-dim transition-colors hover:border-accent hover:text-accent whitespace-nowrap"
              >
                清除筛选
              </button>
            </div>
          ) : (
            <EmptyState
              icon={Heart}
              title="还没有收藏任何番剧"
              desc="在番剧表卡片右上角点击 ♥ 快捷收藏，或到「搜索」页搜索后收藏"
            />
          )}
        </div>
      </div>

      {/* 右侧：重点关心列表（方案 3.4） */}
      <div className="flex w-64 shrink-0 flex-col border-l border-border bg-elev1/50">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <Star size={14} className="text-accent" fill="currentColor" /> 重点关心
          </span>
          <span className="text-[11px] text-faint">{concernItems.length} 部</span>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {concernItems.map((f) => (
            <motion.div
              key={f.subjectId}
              layout
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              className="group flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-elev1 p-2 transition-colors hover:border-accent"
              onClick={() => navigate(`/subject/${f.subjectId}`)}
            >
              <CoverImage src={f.cover} className="h-12 w-9 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-xs font-medium leading-snug">{f.nameCn || f.name}</div>
                {f.rating ? <div className="text-[10px] text-warn">★ {f.rating.toFixed(1)}</div> : null}
              </div>
              <button
                className="opacity-0 transition-opacity group-hover:opacity-100"
                title="移出重点关心"
                onClick={(e) => {
                  e.stopPropagation()
                  removeKeyConcern(f.subjectId)
                }}
              >
                <X size={13} className="text-faint hover:text-danger" />
              </button>
            </motion.div>
          ))}
          {concernItems.length === 0 ? (
            <div className="py-8 text-center text-[11px] leading-relaxed text-faint">
              点击收藏卡片右上角的
              <Star size={10} className="mx-0.5 inline" />
              按钮，
              <br />
              将番剧加入重点关心
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

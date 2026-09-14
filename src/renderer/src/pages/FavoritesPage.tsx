import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { CircleCheck, Heart, Search, Star, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { FavoriteItem } from '@shared/types'
import { yearOf } from '@/lib/format'
import { isCompleted, useLibrary } from '@/stores/library'
import { progressSummary, useWatchProgress } from '@/stores/watchProgress'
import { toast } from '@/stores/app'
import { AnimeCard } from '@/components/AnimeCard'
import { Button, EmptyState } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'

export function FavoritesPage() {
  const navigate = useNavigate()
  const { favorites, keyConcerns, watchHistory, removeFavorite, toggleKeyConcern, removeKeyConcern } = useLibrary()
  // 观看进度（v0.2.4）：搜索已迁出本页，收藏卡片底部改为展示「观看到第几集」
  const { items: progressItems, loaded: progressLoaded, load: loadProgress } = useWatchProgress()
  const [activeYear, setActiveYear] = useState<number | null>(null)
  const centerRef = useRef<HTMLDivElement>(null)
  const groupRefs = useRef(new Map<number, HTMLDivElement>())
  const railRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  // 进页面时加载一次观看进度（store 内已 loaded 则不重复请求主进程）
  useEffect(() => {
    if (!progressLoaded) void loadProgress()
  }, [progressLoaded, loadProgress])

  // 年份分组（方案 3.4：按播出年份分组）
  const groups = useMemo(() => {
    const map = new Map<number, typeof favorites>()
    for (const f of favorites) {
      const y = yearOf(f.airDate)
      const key = y ?? 0
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(f)
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0])
  }, [favorites])

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
  }

  // 垂直年份条拖动（方案 3.4：拖动快速定位）
  const onRailPointerDown = (e: React.PointerEvent) => {
    dragging.current = true
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    railScrollTo(e)
  }
  const onRailPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return
    railScrollTo(e)
  }
  const onRailPointerUp = () => {
    dragging.current = false
  }
  const railScrollTo = (e: React.PointerEvent) => {
    const rail = railRef.current
    const center = centerRef.current
    if (!rail || !center) return
    const rect = rail.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    center.scrollTop = ratio * (center.scrollHeight - center.clientHeight)
  }

  const concernItems = keyConcerns
    .map((id) => favorites.find((f) => f.subjectId === id))
    .filter((f): f is NonNullable<typeof f> => !!f)

  return (
    <div className="flex h-full flex-col">
      {/* 顶部：搜索框已迁入独立搜索页（/search），本页只保留一个入口，避免两处维护同一套搜索逻辑 */}
      <div className="border-b border-border bg-elev1/70 px-5 py-2.5 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <span className="text-[11px] leading-relaxed text-faint">
            搜索已移至侧边栏的「搜索」页；这里只展示你收藏的番剧与观看进度，卡片底部显示观看到第几集。
          </span>
          <Button size="sm" variant="soft" icon={Search} onClick={() => navigate('/search')}>
            前往搜索
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左侧：垂直年份条 */}
        <div className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-elev1/50 py-3">
          <div
            ref={railRef}
            className="relative flex flex-1 cursor-grab touch-none flex-col items-center gap-2 active:cursor-grabbing"
            onPointerDown={onRailPointerDown}
            onPointerMove={onRailPointerMove}
            onPointerUp={onRailPointerUp}
          >
            {years.map((y) => (
              <button
                key={y}
                onClick={() => scrollToYear(y)}
                className={`text-[11px] tabular-nums transition-colors ${
                  activeYear === y ? 'font-semibold text-accent' : 'text-faint hover:text-dim'
                }`}
              >
                {y === 0 ? '未知' : y}
              </button>
            ))}
            {years.length === 0 ? <span className="text-[11px] text-faint">—</span> : null}
          </div>
        </div>

        {/* 中部：收藏列表 */}
        <div ref={centerRef} onScroll={onCenterScroll} className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {groups.length > 0 ? (
            <div className="space-y-7">
              {groups.map(([year, items]) => (
                <div key={year} ref={(el) => { if (el) groupRefs.current.set(year, el) }}>
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
          ) : (
            <EmptyState
              icon={Heart}
              title="还没有收藏任何番剧"
              desc="在番剧表卡片右上角点击 ♥ 快捷收藏，或到「搜索」页搜索后收藏"
            />
          )}
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
    </div>
  )
}

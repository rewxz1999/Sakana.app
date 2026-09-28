import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { CircleCheck, CircleX, Eye, FolderOpen, Heart, HeartOff, Search, Star, StarOff } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { FavoriteItem } from '@shared/types'
import { FAVORITE_SEASON_BUCKETS, favoritesSeasonKey, groupFavoritesBySeason } from '@shared/favoritesSeason'
import { yearOf } from '@/lib/format'
import { FAVORITE_SORTS, matchesFavoriteQuery, sortFavorites, type FavoriteSort } from '@/lib/favoriteQuery'
import { isCompleted, useLibrary } from '@/stores/library'
import { progressSummary, useWatchProgress } from '@/stores/watchProgress'
import { toast } from '@/stores/app'
import { AnimeCard } from '@/components/AnimeCard'
import { EmptyState } from '@/components/ui'
import { ContextMenu, type ContextMenuItem } from '@/components/stat/ContextMenu'
import { resolveLocalPlay } from '@/lib/localPlay'

/** 年份归属键：与左侧年份条一致（日期解析不出年份 → 0 = 未知年份）；0 只用于分组，不参与显示 */
function yearKeyOf(f: FavoriteItem): number {
  return yearOf(f.airDate) ?? 0
}

export function FavoritesPage() {
  const navigate = useNavigate()
  const { favorites, keyConcerns, watchHistory, removeFavorite, toggleKeyConcern, toggleWatched } = useLibrary()
  // 观看进度（v0.2.4）：搜索已迁出本页，收藏卡片底部改为展示「观看到第几集」
  const { items: progressItems, loaded: progressLoaded, load: loadProgress } = useWatchProgress()
  /** 滚动位置对应的年份（只在没选年份时用于高亮，不参与筛选） */
  const [activeYear, setActiveYear] = useState<number | null>(null)
  /** 年份筛选（null = 全部年份）：点左侧年份条切换 */
  const [pickedYear, setPickedYear] = useState<number | null>(null)
  /** 季度/月份筛选（存的是分组键，null = 全部季度）：点季度条切换 */
  const [pickedSeason, setPickedSeason] = useState<string | null>(null)
  /** 「重点关心」标签：true = 只看重点关心（替代原来右侧那一栏） */
  const [onlyConcern, setOnlyConcern] = useState(false)
  // 排序 + 关键词筛选（对齐 Kazumi 的收藏库查询）：排序默认「最近变更」= 保持原有顺序
  const [sort, setSort] = useState<FavoriteSort>('recent')
  const [query, setQuery] = useState('')
  /** 卡片右键菜单（原来卡片表面上的按钮都搬到了这里） */
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const centerRef = useRef<HTMLDivElement>(null)
  const groupRefs = useRef(new Map<number, HTMLDivElement>())
  /** 左侧年份竖条（按住上下拖 = 快速定位；年份多时它自己可滚动） */
  const railRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  /** 拖动起点与「拖过了」标记：拖过就不算点击，否则拖一下就把列表筛成那一年了（见 pickYear） */
  const dragStartY = useRef(0)
  const suppressClick = useRef(false)

  // 进页面时加载一次观看进度（store 内已 loaded 则不重复请求主进程）
  useEffect(() => {
    if (!progressLoaded) void loadProgress()
  }, [progressLoaded, loadProgress])

  const concernSet = useMemo(() => new Set(keyConcerns), [keyConcerns])

  /**
   * 筛选分四层，每层只加一个条件，**「分面计数」= 少加一层的那次筛选**：
   *   关键词 → 年份 → 季度/月份 → 重点关心
   *
   * 为什么这么算数字：用户要求「数量统计要基于当前已有的筛选状态如实显示，不要显示一个跟列表对不上的数字」。
   * 按这个口径，每个按钮上的数字 = 点下去列表里会出现多少部：
   *   年份条数字 = 关键词 ∩ 季度 ∩ 重点关心；        点它 → 得到这一年
   *   季度条数字 = 关键词 ∩ 年份 ∩ 重点关心；        点它 → 得到这一季
   *   重点关心标签数字 = 关键词 ∩ 年份 ∩ 季度 ∩ 重点关心
   * 反例：按「全部收藏」算数字，一筛选就对不上列表，用户会以为丢了数据。
   */
  const keywordPool = useMemo(() => {
    const q = query.trim()
    return q ? favorites.filter((f) => matchesFavoriteQuery(f, q)) : favorites
  }, [favorites, query])

  /** 年份条的数据源（不含年份筛选本身，否则选了 2026 之后别的年份就在条上消失了） */
  const yearRailPool = useMemo(
    () =>
      keywordPool.filter(
        (f) =>
          (pickedSeason === null || favoritesSeasonKey(f.airDate) === pickedSeason) &&
          (!onlyConcern || concernSet.has(f.subjectId))
      ),
    [keywordPool, pickedSeason, onlyConcern, concernSet]
  )

  /** 季度条的数据源（按所选年份收敛：用户要的就是「每年的番按季度分」） */
  const seasonRailPool = useMemo(
    () =>
      keywordPool.filter(
        (f) => (pickedYear === null || yearKeyOf(f) === pickedYear) && (!onlyConcern || concernSet.has(f.subjectId))
      ),
    [keywordPool, pickedYear, onlyConcern, concernSet]
  )

  /** 「重点关心」标签上的数字（= 点开后列表的条数） */
  const concernCount = useMemo(
    () =>
      keywordPool.filter(
        (f) =>
          (pickedYear === null || yearKeyOf(f) === pickedYear) &&
          (pickedSeason === null || favoritesSeasonKey(f.airDate) === pickedSeason) &&
          concernSet.has(f.subjectId)
      ).length,
    [keywordPool, pickedYear, pickedSeason, concernSet]
  )

  // 关键词筛选（多词 AND，匹配中文名/原名/别名）+ 年份 + 季度 + 重点关心 → 再排序
  const visible = useMemo(
    () =>
      sortFavorites(
        keywordPool.filter(
          (f) =>
            (pickedYear === null || yearKeyOf(f) === pickedYear) &&
            (pickedSeason === null || favoritesSeasonKey(f.airDate) === pickedSeason) &&
            (!onlyConcern || concernSet.has(f.subjectId))
        ),
        sort
      ),
    [keywordPool, pickedYear, pickedSeason, onlyConcern, concernSet, sort]
  )

  /** 年份条：有结果的年份才显示（沿用原行为），数字口径见上面四个池子的说明 */
  const yearRail = useMemo(() => {
    const map = new Map<number, number>()
    for (const f of yearRailPool) {
      const y = yearKeyOf(f)
      map.set(y, (map.get(y) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0])
  }, [yearRailPool])

  /**
   * 季度条：四个季度**恒定显示**（用户要求「按春季/夏季/秋季/冬季分成四组，每组后面显示收藏了多少部」，
   * 这一季一部都没有时也要看得见那个 0，否则用户不知道是「没有」还是「功能没做」）；
   * 「季度之外」的月份分组只在真有这种条目时出现，否则「7月 / 未知月份」会白占位置。
   */
  const seasonRail = useMemo(() => {
    const groups = groupFavoritesBySeason(seasonRailPool)
    const counts = new Map(groups.map((g) => [g.bucket.key, g.count]))
    return [
      ...FAVORITE_SEASON_BUCKETS.map((bucket) => ({ bucket, count: counts.get(bucket.key) ?? 0 })),
      ...groups.filter((g) => g.bucket.kind === 'month').map((g) => ({ bucket: g.bucket, count: g.count }))
    ]
  }, [seasonRailPool])

  // 年份分组（方案 3.4：按播出年份分组；筛选/排序后重新分组，年份竖条随之只显示有结果的年份）
  const groups = useMemo(() => {
    const map = new Map<number, typeof favorites>()
    for (const f of visible) {
      const key = yearKeyOf(f)
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

  /**
   * 点年份条 = 选中这一年（再点一次回到全部年份）。
   *
   * 原来是「滚到那一年」，现在改成筛选：带上年份筛选之后列表里只剩这一年，
   * 定位自然就是列表顶部，所以顺带把滚动位置归零——否则会停在上一次的滚动位置上，看起来像「筛出来是空的」。
   * 另外，年份一换可选季度就换了一批（用户要求：切换年份时季度选择重置到「全部」）。
   */
  const pickYear = (y: number): void => {
    setPickedYear((prev) => (prev === y ? null : y))
    setPickedSeason(null)
    centerRef.current?.scrollTo({ top: 0 })
  }

  /** 点季度条 = 只看这一季/这个月（再点一次回到全部季度）；月份分组与季度共用一套选中逻辑 */
  const pickSeason = (key: string): void => {
    setPickedSeason((prev) => (prev === key ? null : key))
    centerRef.current?.scrollTo({ top: 0 })
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
    dragStartY.current = e.clientY
    // 每次按下先清掉「拖过」标记：否则上一次拖动释放到按钮外面时留下的标记会吞掉下一次真正的点击
    suppressClick.current = false
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    railScrollTo(e)
  }
  const onRailPointerMove = (e: React.PointerEvent): void => {
    if (!dragging.current) return
    // 超过 4px 就算「在拖动，不是点击」——年份条现在同时是筛选按钮，拖着找年份时不该顺手把列表筛掉
    if (Math.abs(e.clientY - dragStartY.current) > 4) suppressClick.current = true
    railScrollTo(e)
  }
  const onRailPointerUp = (): void => {
    dragging.current = false
  }

  /**
   * 本地播放：目录由主进程自动推导（下载任务记录 → 订阅记录 → 下载根目录 + 番剧名），
   * 拿不到就如实说原因（见 lib/localPlay）。卡片上原本没有这个按钮，是这次随右键菜单补上的。
   */
  const playLocal = async (f: FavoriteItem): Promise<void> => {
    const title = f.nameCn || f.name || '本地播放'
    const r = await resolveLocalPlay({ subjectId: f.subjectId, animeTitle: title })
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    navigate('/player', { state: { mode: 'local', title, folder: r.dir, subjectId: f.subjectId } })
  }

  /**
   * 收藏卡的右键菜单：卡片表面上的操作（重点关心标记 / 取消收藏）全部搬到这里。
   *
   * 为什么卡片上不再有按钮：AnimeCard 只在**拿到** onFav / onConcern 回调时才渲染右上角那两个按钮，
   * 这里不传这两个回调就等于把按钮从卡片表面移除（不需要动 AnimeCard 本身，也不影响别的页面用同一张卡片）。
   * 状态仍然要看得见：卡片左上角保留一个不可点的「重点」角标，操作走右键。
   *
   * 菜单项 = 原卡片能力 + 用户点名的相关项，一个都不少：
   * 查看详情（原卡片左键点击）/ 本地播放 / 重点关心（原卡片星标）/ 标记已看完（卡片底部本来就显示「已看完」，
   * 顺手把标记能力放到同一处，省得为了标记再进详情页）/ 取消收藏（原卡片心形按钮）。
   */
  function openCardMenu(e: React.MouseEvent, f: FavoriteItem): void {
    e.preventDefault()
    e.stopPropagation()
    const concerned = concernSet.has(f.subjectId)
    const completed = isCompleted(f, watchHistory)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: 'detail',
          label: '查看详情',
          icon: <Eye size={13} />,
          onSelect: () => navigate(`/subject/${f.subjectId}`)
        },
        {
          key: 'local',
          label: '本地播放',
          icon: <FolderOpen size={13} />,
          onSelect: () => void playLocal(f)
        },
        {
          key: 'concern',
          label: concerned ? '取消重点关心' : '重点关心',
          icon: concerned ? <StarOff size={13} /> : <Star size={13} />,
          divider: true,
          onSelect: () => {
            toggleKeyConcern(f.subjectId)
            toast.success(concerned ? '已取消重点关心' : '已加入重点关心')
          }
        },
        {
          key: 'watched',
          label: completed ? '取消已看完' : '标记为已看完',
          icon: completed ? <CircleX size={13} /> : <CircleCheck size={13} />,
          onSelect: () => {
            toggleWatched(f.subjectId)
            toast.success(completed ? '已取消已看完标记' : '已标记为看完')
          }
        },
        {
          key: 'unfav',
          label: '取消收藏',
          icon: <HeartOff size={13} />,
          danger: true,
          divider: true,
          onSelect: () => {
            removeFavorite(f.subjectId)
            toast.info('已取消收藏')
          }
        }
      ]
    })
  }

  return (
    <div className="flex h-full min-h-0">
      {/*
        左侧两条竖导航（年份切换回到左侧竖条，用户要求：顶部不要再加导航栏遮挡内容）：
        · 年份条：选年份（再点一次回到全部年份），按住上下拖仍可快速定位列表；
        · 季度条：和年份条并排放在它右侧，把所选年份的收藏分成 春季/夏季/秋季/冬季 四组，
          并显示每组的收藏数；四季之外（只有年月 / 日期缺失）按月份分组显示。
        两条都是 flex 子项、各占自己的宽度，不绝对定位，所以永远不会压住右边的列表；
        条目太多时各自内部滚动，中间列表保持原有滚动。
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
          {yearRail.map(([year, count]) => {
            // 选了年份就高亮选中的那一年；没选时沿用原来的「跟着滚动位置高亮」
            const active = pickedYear === null ? activeYear === year : pickedYear === year
            return (
              <button
                key={year}
                onClick={() => {
                  // 拖动过就不当点击（见 onRailPointerMove）
                  if (suppressClick.current) {
                    suppressClick.current = false
                    return
                  }
                  pickYear(year)
                }}
                title={
                  year === 0
                    ? `年份未知 · ${count} 部${pickedYear === 0 ? '（再点一次显示全部）' : '（点击只看这些）'}`
                    : `${year} 年 · ${count} 部${pickedYear === year ? '（再点一次显示全部）' : '（点击只看这一年）'}`
                }
                className={`shrink-0 rounded-md px-1.5 py-1 text-center text-[11px] leading-tight tabular-nums transition-colors ${
                  active ? 'bg-accent-soft font-semibold text-accent' : 'text-faint hover:text-dim'
                }`}
              >
                <span className="block">{year === 0 ? '未知' : year}</span>
                <span className="block text-[9px]">{count}</span>
              </button>
            )
          })}
          {yearRail.length === 0 ? <span className="text-[11px] text-faint">—</span> : null}
        </div>
      </div>

      {/* 季度条（年份条右侧）：数字口径 = 所选年份下、已应用其它筛选后的条数，点下去就是这些 */}
      <div className="flex w-14 shrink-0 flex-col items-center border-r border-border bg-elev1/50 py-3">
        <span
          className="mb-1.5 text-[9px] leading-none text-faint"
          title={
            pickedYear === null
              ? '下面是全部年份的收藏按季度/月份分组；点年份条可以只看某一年'
              : `下面是 ${pickedYear === 0 ? '年份未知' : `${pickedYear} 年`}的收藏按季度/月份分组`
          }
        >
          {pickedYear === null ? '全部' : pickedYear === 0 ? '未知' : pickedYear}
        </span>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-1 [scrollbar-width:none]">
          {seasonRail.map(({ bucket, count }) => {
            const active = pickedSeason === bucket.key
            const empty = count === 0
            return (
              <button
                key={bucket.key}
                disabled={empty}
                onClick={() => pickSeason(bucket.key)}
                title={
                  empty
                    ? `${bucket.hint} · 当前没有收藏`
                    : `${bucket.hint} · ${count} 部${active ? '（再点一次显示全部季度）' : '（点击只看这一组）'}`
                }
                className={`w-full shrink-0 rounded-md px-1 py-1 text-center text-[11px] leading-tight tabular-nums transition-colors ${
                  active
                    ? 'bg-accent-soft font-semibold text-accent'
                    : empty
                      ? 'cursor-default text-faint opacity-50'
                      : 'text-faint hover:text-dim'
                }`}
              >
                <span className="block">{bucket.label}</span>
                <span className="block text-[9px]">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 中部：重点关心标签 + 排序/筛选栏 + 收藏列表（栏固定在上方，列表自己滚动） */}
      <div className="flex min-w-0 flex-1 flex-col">
        {favorites.length > 0 ? (
          <>
            {/*
              「重点关心」标签（本次改造：右侧那一栏重点关心列表被移除，浓缩成排序控件**上方**的这个标签，
              用户要求「移除右侧重点关心，在排序上面增加重点关心标签」）。
              点一下只看重点关心（标签变强调色），再点一下看全部；数字是点下去会看到的条数，不会和列表对不上。
            */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-1.5">
              <button
                onClick={() => setOnlyConcern((v) => !v)}
                title={onlyConcern ? '正在只看重点关心，点击显示全部收藏' : '点亮只看重点关心的收藏'}
                className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors whitespace-nowrap ${
                  onlyConcern ? 'border-accent bg-accent-soft text-accent' : 'border-border text-dim hover:border-accent/50'
                }`}
              >
                <Star size={12} fill={onlyConcern ? 'currentColor' : 'none'} />
                重点关心
                <span className="tabular-nums text-faint">{concernCount}</span>
              </button>
              {onlyConcern ? (
                <button
                  onClick={() => setOnlyConcern(false)}
                  className="text-[11px] text-faint transition-colors hover:text-accent whitespace-nowrap"
                >
                  看全部
                </button>
              ) : (
                <span className="text-[11px] text-faint">点击只看重点关心的收藏</span>
              )}
            </div>

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
          </>
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
                      <div key={f.subjectId} onContextMenu={(e) => openCardMenu(e, f)}>
                        {/*
                          不传 onFav / onConcern：AnimeCard 只在拿到回调时才画右上角那两个按钮，
                          所以卡片表面上的「重点关心」「取消收藏」自然消失，操作改由卡片右键菜单承担。
                          左上角的悬浮角标是**不可点**的状态提示（哪几部在重点关心里）。
                        */}
                        <AnimeCard
                          item={{ id: f.subjectId, name: f.name, nameCn: f.nameCn, cover: f.cover, rating: f.rating, airDate: f.airDate }}
                          badge={
                            concernSet.has(f.subjectId) ? (
                              <span
                                title="已加入重点关心（右键卡片可取消）"
                                className="inline-flex items-center gap-0.5 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold text-accent backdrop-blur-sm"
                              >
                                <Star size={9} fill="currentColor" /> 重点
                              </span>
                            ) : undefined
                          }
                          onClick={() => navigate(`/subject/${f.subjectId}`)}
                          footer={progressFooter(f)}
                        />
                      </div>
                    ))}
                  </motion.div>
                </div>
              ))}
            </div>
          ) : favorites.length > 0 ? (
            /* 有收藏但被筛空：给一句提示 + 一键清除，而不是留白 */
            <div className="flex flex-col items-center gap-2.5 py-16 text-center">
              <p className="text-sm text-dim">没有匹配的收藏</p>
              <button
                onClick={() => {
                  // 「清除筛选」要连年份/季度/重点关心一起清，否则用户按了还是一片空白，会以为按键没生效
                  setQuery('')
                  setSort('recent')
                  setPickedYear(null)
                  setPickedSeason(null)
                  setOnlyConcern(false)
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

      {/* 卡片右键菜单（portal 到 body，会自动翻转避让边缘；点外面/Esc/滚动都关，见 ContextMenu） */}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu?.items ?? []}
        onClose={() => setMenu(null)}
      />
    </div>
  )
}

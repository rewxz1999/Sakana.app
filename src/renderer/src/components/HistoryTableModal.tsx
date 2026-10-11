import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, History, Layers, ShieldOff, Star } from 'lucide-react'
import type { SeasonItem } from '@shared/types'
import { SEASON_NAMES, monthsOfSeason, seasonIndexOfMonth, seasonShortLabel } from '@shared/season'
import { blockReason } from '@shared/scheduleBlock'
import { api } from '@/lib/api'
import { CoverImage } from '@/components/CoverImage'
import { Button, Modal, Spinner } from '@/components/ui'
import { useScheduleBlock, useScheduleTags } from '@/stores/schedule'

/**
 * 番剧表「历史表」弹窗（v0.3.7 起，v0.3.9 改成「年份 + 季节 + 按需加载」）。
 *
 * 用户需求原文（v0.3.7）：
 *   「番剧表右上方有一块时间区域，显示番剧表日期和当前季度，点击这一块时间区域后进入历史表弹窗。
 *     历史表：上方有一条横轴，以年份划分，通过滑动横轴来切换年份。每个年份下面则展示该年份下
 *     有哪些番剧（按季度划分）（使用 bangumi 数据）。为了防止出现 bug，只有滑动横轴停下后才开始
 *     加载当年份番剧。（横轴只支持到 2005，再往前不支持）历史表已经加载的数据也缓存在本地，
 *     以免重复加载。历史表也遵守番剧表屏蔽、黑名单规则。」
 *
 * 用户需求原文（v0.3.9 本轮）：
 *   ①「对于已经缓存在本地的图片就不需要重新从数据源加载了」
 *   ②「当用户切换年份后，点击加载该年份番剧图片后再进行加载（因为数据量和图片太多）」
 *   ③「切换年份后再增加一个切换季节来显示番剧，方便查找番剧」
 *
 * ## 几个关键实现决定
 *
 * ① **年份横轴 = 一条可拖动的滑块**，不是一排按钮。
 *    选中哪一年由**滚动位置**决定：`scrollLeft / 步长`（步长 = 卡宽 + 间隙），
 *    所以左右两侧留了 `50% - 半张卡` 的内边距，让首尾年份也能真正停在正中间。
 *    滚轮（纵→横）、按住拖动、点年份卡三种方式都能移动它。
 *
 * ② **只有「停下」才提交年份**（v0.3.7 用户明确要求，防 bug）：
 *    滚动过程中只更新「待选年份」的高亮，并不断重置一个 260ms 的计时器；
 *    计时器真正触发时才把待选年份提交为选中年份。这样「一路拖过去」只会停在最后那一年，
 *    不会把沿途每一年都走一遍。停下后还会把最近的年份卡平滑吸附到正中。
 *
 * ③ **v0.3.9：切换年份后不再自动取数，必须点「加载」**（本轮用户要求 ②）。
 *    原因就是用户说的「数据量和图片太多」：一整年 = 4 季 × 每季 3 个月 = **12 个请求**，
 *    外加几百张封面。以前滑一下轴（或只是打开弹窗）就会触发这一整套 ——
 *    在用户的个人反代（主进程 `MAX_PROXY_CONCURRENCY = 2` 就是为它设的）上这属于白打。
 *    现在的落点：
 *      · 滚动/点击年份轴 → 只切年份与高亮，**一个请求都不发**；
 *      · 季节标签只做**筛选**，也不发请求；
 *      · 只有点「加载 …」才真正取数，且**只取当前筛选范围内的季度**
 *        （选了「夏」就只拉夏这一季 = 3 个请求，而不是整年的 12 个）。
 *    加载中有明确的进度（`正在加载 k/n 季…` + 每一季自己的「正在读取」），不会点了没反应。
 *
 * ④ **封面走已有的本地图片缓存**（本轮用户要求 ①：「已经缓存在本地的图片就不需要重新从数据源加载」）。
 *    这里的封面全部是 `<CoverImage>` → `sakana-img://fetch/<base64 的原始地址>` → 主进程
 *    `media.ts` 的 `fetchImageWithCache()`，它**按「改写后的图片地址」的 sha1 落盘到
 *    `<缓存根>/img/<hash>.<ext>`**：命中就直接把磁盘上的字节读回来、**一个字节都不再去数据源**；
 *    没命中才去取，取回后写盘，此后一直命中（只有「设置 → 清除缓存」会清掉）。
 *    所以**不新造一套图片缓存**，也不自己在渲染层拼缓存路径 —— 复用既有那套就是正确答案。
 *    本轮在这个弹窗里为它做的配合只有一条：**不主动去拉用户没要求加载的年份**（见 ③），
 *    于是「没点过加载的年份」连一次封面请求都不会产生。
 *
 * ⑤ **本会话的二级去重**：`loadedRef` 记住「这个会话里已经取过的 年:季度」，
 *    来回切年份、切季节、关掉再打开都不会重复发 IPC；
 *    真正重启应用后命中的是主进程的季度磁盘缓存（7 天，键 `season-<年>-<季度>`），同样不联网。
 *
 * ⑥ **屏蔽规则**：与「随机推荐」同一套做法（见 RecommendRail 的说明）——
 *    `blockReason` + `useScheduleBlock` 立刻生效的是黑名单与不含标签的规则；
 *    需要标签的规则要等该条目的标签进了 `useScheduleTags` 缓存才生效
 *    （历史表动辄几百条，为它逐条拉详情会把反代打挂，所以不主动补标签）。
 */

/** 最早支持的年份：用户明确「只支持到 2005，再往前不支持」 */
export const EARLIEST_YEAR = 2005

/** 年份卡尺寸：步长 = 卡宽 + 间隙。⚠️ 间隙**只由容器的 `gap-1.5`（6px）提供** */
const CHIP_W = 84
const CHIP_GAP = 6
const CHIP_STEP = CHIP_W + CHIP_GAP

/** 滑动停下多久算「停下」：太短会在惯性滑动中被触发，太长会显得迟钝 */
const SETTLE_MS = 260

/** 季节筛选里的「全部」：值的类型就是季度序号 1..4，用 0 表示不筛 */
export const ALL_SEASONS = 0

/** 一年里的四个季度（按季节序号），当前年份会把当前季度提到最前 */
export function seasonOrderFor(year: number, now = new Date()): number[] {
  const all = [1, 2, 3, 4]
  if (now.getFullYear() !== year) return all
  const cur = seasonIndexOfMonth(now.getMonth() + 1)
  return [cur, ...all.filter((s) => s !== cur)]
}

/**
 * 季节筛选 → 实际要显示/加载的季度列表（本轮要求 ③ 的第二级筛选）。
 * `filter = 0`（全部）→ 四季；`filter = 1..4` → 只有那一季。非法值一律当「全部」。
 */
export function seasonsForFilter(filter: number): number[] {
  return filter >= 1 && filter <= 4 ? [Math.trunc(filter)] : [1, 2, 3, 4]
}

/**
 * 本次「加载」按什么顺序取季度（**纯函数**，自检脚本直接跑它）。
 * 复用 `seasonOrderFor`：当前年份先取当前季度（用户最可能想看的就是它），
 * 其余年份按 冬→春→夏→秋；再用季节筛选把不在范围内的剔掉。
 */
export function loadOrderFor(year: number, filter: number, now = new Date()): number[] {
  const scope = new Set(seasonsForFilter(filter))
  return seasonOrderFor(year, now).filter((s) => scope.has(s))
}

/**
 * 当前筛选下**还差哪些季度没取到**（已加载的、正在飞的都排除）——
 * 「点『加载』之后只补缺的那几季」这条规则的落点（新一轮点击不会重复请求已经在路上的季度）。
 */
export function missingSeasons(
  year: number,
  filter: number,
  loaded: ReadonlySet<string>,
  inflight: ReadonlySet<string>
): number[] {
  return seasonsForFilter(filter).filter((s) => {
    const key = `${year}:${s}`
    return !loaded.has(key) && !inflight.has(key)
  })
}

/**
 * 滚动位置 → 年份卡下标（**纯函数**，自检脚本 `scripts/verify-history-table.mjs` 直接跑它）。
 *
 * 横轴能成立的前提是「步长」在 CSS 与 JS 两侧**完全一致**：
 * 容器 `gap-1.5`（6px）+ 卡宽 84px = 90px，而卡上**不能**再加 margin ——
 * v0.3.7 第一版两处都写了间隙，真实步长变成 96px，于是「停下后吸附」把轴又拽回了原处
 * （现象：拖到 2025 却看到抬头仍写着 2026）。这类错不会报错，只会让交互悄悄失灵，
 * 所以这里把算法抽出来单独断言。
 */
export function axisIndexAtScroll(scrollLeft: number, yearCount: number): number {
  if (!Number.isFinite(scrollLeft) || yearCount <= 0) return 0
  return Math.min(yearCount - 1, Math.max(0, Math.round(scrollLeft / CHIP_STEP)))
}

type YearData = Partial<Record<number, SeasonItem[]>>

export function HistoryTableModal({
  open,
  onClose,
  initialYear,
  onOpenSubject
}: {
  open: boolean
  onClose: () => void
  /** 打开时停在哪一年（不传 = 今年） */
  initialYear?: number
  /** 点某一部番剧：交由调用方跳转（并自行决定要不要关弹窗） */
  onOpenSubject: (id: number) => void
}) {
  const thisYear = new Date().getFullYear()
  /** 年份轴：2005 → 今年。不做未来年份（下一季的番剧在这一年的「秋」里，仍然看得到） */
  const years = useMemo(() => {
    const out: number[] = []
    for (let y = EARLIEST_YEAR; y <= thisYear; y++) out.push(y)
    return out
  }, [thisYear])

  const clampYear = useCallback(
    (y: number): number => Math.min(thisYear, Math.max(EARLIEST_YEAR, Math.trunc(y) || thisYear)),
    [thisYear]
  )

  const [year, setYear] = useState(() => clampYear(initialYear ?? thisYear))
  /** 滚动中「将要选中」的年份：只影响高亮，不影响任何取数 */
  const [pendingYear, setPendingYear] = useState(year)
  /** 季节筛选：ALL_SEASONS = 全部，1..4 = 冬/春/夏/秋（唯一取值/显示口径见 seasonsForFilter） */
  const [seasonFilter, setSeasonFilter] = useState<number>(ALL_SEASONS)
  const [data, setData] = useState<Record<number, YearData>>({})
  const [loadingKeys, setLoadingKeys] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})

  const axisRef = useRef<HTMLDivElement>(null)
  const settleTimer = useRef<number | null>(null)
  const dragRef = useRef<{ x: number; left: number; moved: boolean } | null>(null)
  /** 本会话已取到的 `年:季度`（避免来回切年份/季节重复请求） */
  const loadedRef = useRef<Set<string>>(new Set())
  const inflightRef = useRef<Set<string>>(new Set())

  // ---------------- 屏蔽规则（与番剧表 / 随机推荐同一套判据） ----------------
  const blockCfg = useScheduleBlock((s) => s.cfg)
  const blockLoaded = useScheduleBlock((s) => s.loaded)
  const loadBlock = useScheduleBlock((s) => s.load)
  const tagMap = useScheduleTags((s) => s.tags)
  useEffect(() => {
    if (open && !blockLoaded) void loadBlock()
  }, [open, blockLoaded, loadBlock])

  // ---------------- 取数（只由「加载」按钮触发） ----------------

  /** 取某个季度（命中 `loadedRef` / `inflightRef` 的直接跳过） */
  const loadSeason = useCallback((y: number, s: number): void => {
    const key = `${y}:${s}`
    if (loadedRef.current.has(key) || inflightRef.current.has(key)) return
    inflightRef.current.add(key)
    setLoadingKeys((m) => ({ ...m, [key]: true }))
    void api.bangumi
      .season(y, monthsOfSeason(s)[0])
      .then((r) => {
        if (r.ok) {
          loadedRef.current.add(key)
          setData((d) => ({ ...d, [y]: { ...(d[y] ?? {}), [s]: r.data.items } }))
        } else {
          setErrors((e) => ({ ...e, [y]: r.error }))
        }
      })
      .finally(() => {
        inflightRef.current.delete(key)
        setLoadingKeys((m) => {
          if (!(key in m)) return m
          const next = { ...m }
          delete next[key]
          return next
        })
      })
  }, [])

  /**
   * 点「加载」：按 `loadOrderFor` 的顺序，把当前**季节筛选范围内**还缺的季度都发出去。
   * 四季并行发、各自到达各自渲染（主进程的并发闸门会自己排队），
   * 串行只会让用户盯着一个转圈更久。
   */
  const loadScope = useCallback((): void => {
    for (const s of loadOrderFor(year, seasonFilter)) loadSeason(year, s)
  }, [year, seasonFilter, loadSeason])

  // 打开时把选中年份（以及横轴位置）复位
  useEffect(() => {
    if (!open) return
    const y = clampYear(initialYear ?? thisYear)
    setYear(y)
    setPendingYear(y)
    // 等弹窗渲染出来再定位（弹窗是条件渲染的，首帧还没有滚动容器）
    const t = window.setTimeout(() => scrollToYear(y, false), 30)
    return () => window.clearTimeout(t)
  }, [open, initialYear, thisYear, clampYear])

  useEffect(() => {
    setPendingYear(year)
  }, [year])

  // ---------------- 横轴：定位 / 滚动 / 拖动 ----------------
  const scrollToYear = useCallback(
    (y: number, smooth: boolean) => {
      const el = axisRef.current
      if (!el) return
      const i = years.indexOf(y)
      if (i < 0) return
      el.scrollTo({ left: i * CHIP_STEP, behavior: smooth ? 'smooth' : 'auto' })
    },
    [years]
  )

  /** 当前滚动位置「最接近」哪一年 */
  const yearAtScroll = useCallback((): number => {
    const el = axisRef.current
    if (!el) return year
    return years[axisIndexAtScroll(el.scrollLeft, years.length)] ?? year
  }, [years, year])

  const onAxisScroll = useCallback(() => {
    const el = axisRef.current
    if (!el) return
    setPendingYear(yearAtScroll())
    /*
     * 关键：滚动中**只**重置计时器，不提交年份 —— 提交才会（由用户）决定要不要加载。
     * 惯性滑动会连续触发十几二十次 scroll，全部落在同一个计时器上。
     */
    if (settleTimer.current) window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      const y = yearAtScroll()
      setYear(y)
      // 停稳后吸附到最近的年份卡：否则会停在两张卡中间，用户看不出选的是哪年
      scrollToYear(y, true)
    }, SETTLE_MS)
  }, [yearAtScroll, scrollToYear])

  useEffect(
    () => () => {
      if (settleTimer.current) window.clearTimeout(settleTimer.current)
    },
    []
  )

  /**
   * 滚轮：竖向滚轮转成横轴滚动。
   * 必须用**原生非 passive** 监听器：React 的 onWheel 在根节点上是 passive 的，
   * 里面 preventDefault() 会被忽略并告警，结果「滚轮滚了页面、横轴不动」。
   */
  useEffect(() => {
    const el = axisRef.current
    if (!el || !open) return
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [open])

  /** 按住拖动（鼠标也能「滑」这条轴，而不是只能滚轮或拖滚动条） */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = axisRef.current
    if (!el || e.button !== 0) return
    dragRef.current = { x: e.clientX, left: el.scrollLeft, moved: false }
    el.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = axisRef.current
    const d = dragRef.current
    if (!el || !d) return
    const dx = e.clientX - d.x
    if (Math.abs(dx) > 4) d.moved = true
    el.scrollLeft = d.left - dx
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    axisRef.current?.releasePointerCapture?.(e.pointerId)
    // 延后清空：click 在 pointerup 之后才派发，要让它还能读到 moved
    window.setTimeout(() => {
      dragRef.current = null
    }, 0)
  }

  /** 点年份卡：立刻选中（并平滑居中）——这是「精确跳转」，不走 260ms 的停下判定 */
  const pickYear = (y: number): void => {
    if (dragRef.current?.moved) return
    if (settleTimer.current) window.clearTimeout(settleTimer.current)
    setYear(y)
    setPendingYear(y)
    scrollToYear(y, true)
  }

  // ---------------- 渲染数据 ----------------
  const yearData = data[year] ?? {}
  const error = errors[year] ?? ''
  const scope = seasonsForFilter(seasonFilter)

  /** 季节筛选范围 + 屏蔽规则 → 每一季实际要显示的条目 */
  const seasons = useMemo(() => {
    return scope.map((s) => {
      const items = yearData[s] ?? []
      const shown: SeasonItem[] = []
      let hidden = 0
      for (const it of items) {
        const tags = tagMap[it.id]
        if (blockReason({ id: it.id }, tags && tags.length > 0 ? tags : null, blockCfg)) hidden++
        else shown.push(it)
      }
      return { season: s, items: shown, hidden, total: items.length, arrived: yearData[s] !== undefined }
    })
  }, [scope, yearData, blockCfg, tagMap])

  /** 本筛选范围内已到位的季度数 / 是否还有季度在飞 */
  const scopeArrived = seasons.filter((s) => s.arrived).length
  const scopeLoading = scope.some((s) => !!loadingKeys[`${year}:${s}`])
  const scopeDone = scopeArrived === scope.length
  /** 还没取到的季度（点「加载」时真正会发出去的那些） */
  const scopeMissing = missingSeasons(year, seasonFilter, loadedRef.current, inflightRef.current)
  const shownTotal = seasons.reduce((n, s) => n + s.items.length, 0)
  const hiddenTotal = seasons.reduce((n, s) => n + s.hidden, 0)

  /** 按钮/状态文案里的范围描述：四季全加载 vs 某一季 */
  const scopeLabel =
    seasonFilter >= 1 ? `${seasonShortLabel(year, seasonFilter)}（1 季）` : `${year} 年（四季）`

  return (
    <Modal open={open} onClose={onClose} width={1160} title={
      <span className="flex items-center gap-2">
        <History size={15} className="text-accent" /> 历史表
        <span className="text-[11px] font-normal text-faint">
          {EARLIEST_YEAR} 年起的每一年都有哪些番剧（滑动年份轴选年份，再按季节筛）
        </span>
      </span>
    }>
      <div className="flex flex-col gap-3">
        {/*
          年份横轴。左右内边距 = 50% - 半张卡，这样第一张和最后一张卡也能停在正中间，
          「选中的年份」永远在轴心，视觉锚点稳定。
        */}
        <div
          ref={axisRef}
          onScroll={onAxisScroll}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="flex cursor-grab items-center gap-1.5 overflow-x-auto overscroll-x-contain rounded-xl border border-border bg-elev2/60 py-2.5 select-none active:cursor-grabbing [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ paddingLeft: `calc(50% - ${CHIP_W / 2}px)`, paddingRight: `calc(50% - ${CHIP_W / 2}px)` }}
        >
          {years.map((y) => {
            const active = y === year
            const pending = y === pendingYear
            return (
              <button
                key={y}
                type="button"
                onClick={() => pickYear(y)}
                style={{ width: CHIP_W }}
                className={`shrink-0 rounded-lg py-1.5 text-center text-[13px] leading-tight transition-colors ${
                  active
                    ? 'bg-accent font-semibold text-white'
                    : pending
                      ? 'bg-accent-soft text-accent'
                      : 'text-dim hover:bg-elev2'
                }`}
              >
                {y}
              </button>
            )
          })}
        </div>

        {/* 当前年份抬头：数据量、隐藏数、加载状态 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
          <span className="text-sm font-semibold">{year} 年</span>
          {scopeArrived > 0 ? (
            <span className="text-[11px] text-faint">
              共 {shownTotal} 部
              {scopeDone ? '' : `（已加载 ${scopeArrived}/${scope.length} 季）`}
            </span>
          ) : null}
          {scopeLoading ? (
            <span className="flex items-center gap-1 text-[11px] text-faint">
              <Spinner /> 正在读取数据…
            </span>
          ) : null}
          {hiddenTotal > 0 ? (
            <span className="flex items-center gap-1 text-[10px] text-faint" title="按番剧表设置与黑名单隐藏">
              <ShieldOff size={11} /> 已隐藏 {hiddenTotal} 部
            </span>
          ) : null}
          <span className="ml-auto text-[10px] text-faint">{EARLIEST_YEAR} 年以前的数据不支持</span>
        </div>

        {/*
          第二级筛选 + 按需加载（本轮用户要求 ②③ 的落点）。
          季节标签只**筛选**、不发请求；真正取数只发生在点右边的「加载」时，
          而且只取当前筛选范围内的季度（选「夏」= 3 个请求，而不是整年的 12 个）。
          加载完成后按钮**消失、换成一行状态文字** —— 不留一个点了没反应的"假按钮"。
        */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-elev2/40 px-3 py-2">
          <Layers size={13} className="shrink-0 text-accent" />
          <span className="shrink-0 text-[11px] text-dim">季节</span>
          {[ALL_SEASONS, 1, 2, 3, 4].map((s) => {
            const active = seasonFilter === s
            const arrived = s === ALL_SEASONS ? scopeDone : yearData[s] !== undefined
            const busy = s === ALL_SEASONS ? scopeLoading : !!loadingKeys[`${year}:${s}`]
            const count = s === ALL_SEASONS ? undefined : yearData[s]?.length
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSeasonFilter(s)}
                title={
                  s === ALL_SEASONS
                    ? '四季都显示（加载时按四季取数）'
                    : `只看 ${seasonShortLabel(year, s)}（加载时只取这一季）`
                }
                className={`flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors ${
                  active ? 'bg-accent-soft font-medium text-accent' : 'text-dim hover:bg-elev2'
                }`}
              >
                {s === ALL_SEASONS ? '全部' : `${SEASON_NAMES[s - 1]}季`}
                {/* 状态点：已加载=实心、读取中=转圈、未加载=空心 —— 一眼看出哪一季有数据 */}
                {busy ? (
                  <Spinner size={9} />
                ) : (
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      arrived ? 'bg-ok' : 'border border-faint'
                    }`}
                  />
                )}
                {count !== undefined ? (
                  <span className="tabular-nums text-faint">{count}</span>
                ) : null}
              </button>
            )
          })}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {scopeLoading ? (
              <span className="flex items-center gap-1.5 text-[11px] text-faint">
                <Download size={12} className="animate-pulse" />
                正在加载 {scopeArrived}/{scope.length} 季…
              </span>
            ) : scopeDone ? (
              <span className="flex items-center gap-1.5 text-[11px] text-ok">
                <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                已加载 {scopeLabel}
              </span>
            ) : (
              <>
                <span className="text-[10px] leading-relaxed text-faint">
                  按需加载：点了才会取这一{seasonFilter >= 1 ? '季' : '年的四季'}的条目与封面
                  {scopeArrived > 0 ? `（还差 ${scopeMissing.length} 季）` : ''}
                </span>
                <Button size="sm" icon={Download} onClick={loadScope}>
                  加载 {scopeLabel}
                </Button>
              </>
            )}
          </div>
        </div>

        {error ? (
          <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
            该年份数据读取失败：{error}
          </div>
        ) : null}

        {/* 季节筛选范围内的季度：各自到达各自渲染，先到的不等后到的 */}
        {seasons.map((bucket) => {
          const s = bucket.season
          const key = `${year}:${s}`
          const loading = !!loadingKeys[key]
          return (
            <section key={s} className="rounded-xl border border-border bg-elev1/70 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[13px] font-semibold text-accent">{SEASON_NAMES[s - 1]}季</span>
                <span className="text-[11px] text-faint">
                  {bucket.arrived
                    ? `${bucket.items.length} 部`
                    : loading
                      ? '读取中…'
                      : '未加载'}
                </span>
                {bucket.hidden > 0 ? (
                  <span className="flex items-center gap-1 text-[10px] text-faint">
                    <ShieldOff size={10} /> 隐藏 {bucket.hidden}
                  </span>
                ) : null}
                <span className="ml-auto text-[10px] text-faint">{seasonShortLabel(year, s)}</span>
              </div>
              {loading && !bucket.arrived ? (
                <div className="flex items-center gap-2 py-3 text-[11px] text-faint">
                  <Spinner /> 正在读取 {seasonShortLabel(year, s)}…
                </div>
              ) : !bucket.arrived ? (
                /* 没点过加载 ≠ 这一季没有番剧：这里必须说清是「未加载」，不能显示成空列表 */
                <div className="flex flex-wrap items-center gap-2 py-3 text-[11px] text-faint">
                  <span>这一季还没有加载（按需加载，避免一次拉几百张封面）</span>
                  <button
                    type="button"
                    onClick={() => loadSeason(year, s)}
                    className="text-accent transition-colors hover:underline"
                  >
                    只加载 {seasonShortLabel(year, s)}
                  </button>
                </div>
              ) : bucket.items.length === 0 ? (
                <div className="py-3 text-[11px] text-faint">这一季没有可显示的番剧</div>
              ) : (
                <div className="grid grid-cols-3 gap-x-2 gap-y-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
                  {bucket.items.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => onOpenSubject(it.id)}
                      title={it.name_cn || it.name}
                      className="group flex min-w-0 flex-col gap-1 text-left"
                    >
                      <CoverImage
                        src={it.images?.large ?? it.images?.common ?? null}
                        className="aspect-[3/4] w-full rounded-md border border-border/60"
                      />
                      <span className="line-clamp-2 text-[11px] leading-tight text-dim transition-colors group-hover:text-accent">
                        {it.name_cn || it.name}
                      </span>
                      {it.rating?.score ? (
                        <span className="flex items-center gap-0.5 text-[10px] text-faint tabular-nums">
                          <Star size={9} /> {it.rating.score.toFixed(1)}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </Modal>
  )
}

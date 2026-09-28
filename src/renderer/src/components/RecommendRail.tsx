import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  CalendarRange,
  Dices,
  Flame,
  RefreshCw,
  ShieldOff,
  Sparkles,
  Star,
  Users,
  type LucideIcon
} from 'lucide-react'
import {
  RECOMMEND_EMPTY_TEXT,
  RECOMMEND_PICK,
  type CalendarItem,
  type RecommendGroup,
  type RecommendGroupKey,
  type RecommendItem,
  type SeasonItem
} from '@shared/types'
import { seasonOfDate, seasonShortLabel } from '@shared/season'
import { blockReason } from '@shared/scheduleBlock'
import { api } from '@/lib/api'
import { localImgUrl, yearOf } from '@/lib/format'
import { useScheduleBlock, useScheduleTags } from '@/stores/schedule'
import { Spinner } from '@/components/ui'

/*
 * ============================================================================
 * 搜索页空态：随机推荐番剧
 * ============================================================================
 *
 * 【布局（v0.3.6 按用户反馈重做）】
 * 「热门推荐在右边依次是高分、冷门、当季」—— 四组**横向**排列成一排，组内条目**竖向**排列；
 * 不显示封面，只显示「名字 + 评分人数」，点名字直接跳详情（用户原话：
 * 「直接用名字点击快捷跳转」「减少空间占用」）。
 * 卡片里带封面时每行要 90px 高，四组竖向排就是四屏；现在每行只有 22px 左右，一屏放得下。
 *
 * 【候选池：全站随机抽样（v0.3.6 重做）】
 * 老实现只用「当年各季度 + 每日放送」组池子，于是高分只有 3 部、冷门 8 部，
 * 经常出现「真的没有了」。用户明确指出这不该这么少 —— 这是**全站**数据，应当随机抽检。
 *
 * 现在改成：**随机抽 5 个年份 × 各季度**去问 `/v0/subjects?type=2&year=&month=&sort=rank`。
 * 实测（`.e2e/probe-recommend-pool.mjs`，2026-09）：
 *   · 19 个请求 → 去重后 **1096 部**候选，**rating 覆盖率 100%**（每一条都带 total/score）；
 *   · 高分（score>8.0）**30 部**、冷门（score>7.5 且 total<1000）**15 部** —— 都够 5 部且余量充足；
 *   · 每次进页面随机换年份，所以「随机抽检」是真的（不是固定那几部）。
 *
 * 为什么用「年份 × 季度」而不是「按 rank 翻页取全站」：主进程的 `season()` 按季度缓存 7 天，
 * 同一个季度不会重复打反代；而翻页取全站是几十个请求且完全不缓存。
 * 5 个年份里**当年固定包含**（保证「热门推荐 = 当年份」有数据），其余 4 个随机。
 *
 * 【请求成本】冷缓存 19 个请求 / 主进程并发闸门 2 → 十来秒；但**每季度缓存 7 天**，
 * 同一周内再进搜索页只打没采过的年份。用户「换一批」只重洗不联网（见 reshuffle）。
 */

/** 候选池在内存里留多久：5 分钟内再进搜索页直接用同一批候选（只重新随机），不再打反代 */
const POOL_TTL = 5 * 60 * 1000

/** 采样几个年份（当年必含 + 其余随机） */
const SAMPLE_YEARS = 5

/** 模块级池子缓存：StrictMode 下 effect 会跑两次、返回详情页也会重新挂载，靠它避免重复取数 */
let poolCache: { at: number; key: string; pools: Pools } | null = null

interface Pools {
  /** `<年>-<季度>`：跨天/跨季后自动作废，不会把上一季的推荐当成当季 */
  key: string
  /** 采样年份的全部条目（用于高分/冷门：全站抽样） */
  sample: RecommendItem[]
  /** 当年各季度条目（用于热门：产品口径里的「当年份」） */
  year: RecommendItem[]
  /** 当前季度条目 ∪ 每日放送（用于当季推荐） */
  season: RecommendItem[]
}

// ---------------- 归一化：三种条目 → 一种形状 ----------------

/** 评分：0 / 缺失一律折成 null，界面据此显示「暂无评分」而不是「0.0」 */
function toScore(rating: { score?: number | null } | null | undefined): number | null {
  const s = Number(rating?.score ?? 0)
  return Number.isFinite(s) && s > 0 ? s : null
}

/** 评分人数：缺失/非法一律折成 0（0 的条目永远不会被任何一条判据选中） */
function toTotal(rating: { total?: number } | null | undefined): number {
  const n = Number(rating?.total ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 季度检索条目（SeasonItem）→ 推荐条目。注意放送日期字段在 v0 里叫 date，主进程已归一化成 air_date */
function fromSeason(it: SeasonItem): RecommendItem {
  return {
    id: it.id,
    name: it.name,
    nameCn: it.name_cn,
    images: it.images,
    score: toScore(it.rating),
    total: toTotal(it.rating),
    airDate: it.air_date
  }
}

/** 每日放送条目（CalendarItem）→ 推荐条目 */
function fromCalendar(it: CalendarItem): RecommendItem {
  return {
    id: it.id,
    name: it.name,
    nameCn: it.name_cn,
    images: it.images,
    score: toScore(it.rating),
    total: toTotal(it.rating),
    airDate: it.air_date
  }
}

/**
 * 放送年份是否就是当年。
 * 日期缺失时**排除**：「热门推荐」的判据里「当年份」是硬条件，
 * 拿不到放送年份的条目（多半还没定档）没有依据算作当年。
 */
function inYear(it: RecommendItem, year: number): boolean {
  return yearOf(it.airDate) === year
}

/**
 * 按 id 去重（不同年份/季度之间、季度与每日放送之间都会有重复条目）。
 *
 * ⚠️ 只丢掉 **id 非法**（0 / NaN）的条目，**不能丢掉负数 id**：
 * 主数据源全挂时列表会走 Jikan/AniList 兜底，那批条目的 id 是 `-MAL id`（见 jikanMap 的约定），
 * 详情页有专门的分流能打开它们；按「id <= 0 就丢」处理会让兜底场景下推荐区整个变空。
 */
function dedupe(list: RecommendItem[]): RecommendItem[] {
  const map = new Map<number, RecommendItem>()
  for (const it of list) {
    if (!it || !Number.isFinite(it.id) || it.id === 0) continue
    const prev = map.get(it.id)
    // 同一条目两处都有时，保留「有评分人数」的那一份，避免把好数据换成空数据
    if (!prev || (prev.total === 0 && it.total > 0)) map.set(it.id, it)
  }
  return [...map.values()]
}

/** Fisher-Yates 洗牌后取前 n：保证同一组每次进页面挑出来的不是同 5 部 */
function pickRandom(list: RecommendItem[], n: number): RecommendItem[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, n)
}

/** 四条判据：key/title 与产品口径一一对应，pool 指名这条判据在哪个池子里筛 */
interface RuleDef {
  key: RecommendGroupKey
  title: string
  rule: string
  pool: (pools: Pools) => RecommendItem[]
  pass: (it: RecommendItem) => boolean
}

function ruleDefs(year: number, season: number): RuleDef[] {
  const label = seasonShortLabel(year, season)
  const yearPool = (p: Pools): RecommendItem[] => dedupe(p.year)
  // 高分/冷门走**全站抽样池**（v0.3.6：不再只限当年/当季，那正是候选太少的原因）
  const samplePool = (p: Pools): RecommendItem[] => dedupe([...p.sample, ...p.year, ...p.season])
  const seasonPool = (p: Pools): RecommendItem[] => dedupe(p.season)
  return [
    {
      key: 'hot',
      title: '热门推荐',
      rule: `${year} 年放送 · 评分人数 > 3000`,
      pool: yearPool,
      pass: (it) => it.total > 3000
    },
    {
      key: 'top',
      title: '高分推荐',
      rule: '全站 · bangumi 评分 > 8.0',
      pool: samplePool,
      pass: (it) => (it.score ?? 0) > 8
    },
    {
      key: 'hidden',
      title: '冷门推荐',
      rule: '全站 · 评分 > 7.5 且评分人数 < 1000',
      pool: samplePool,
      pass: (it) => (it.score ?? 0) > 7.5 && it.total > 0 && it.total < 1000
    },
    {
      key: 'season',
      title: '当季推荐',
      rule: `${label} · 评分人数 > 1500`,
      pool: seasonPool,
      pass: (it) => it.total > 1500
    }
  ]
}

/** 已挑出的那 5 部 + 当时候选集的指纹（见 groupsOf 的"别让列表在加载途中反复换脸"） */
interface PickCache {
  [key: string]: { sig: string; items: RecommendItem[] }
}

/**
 * 池子 → 四个分组。
 *
 * `prev` / `force` 处理的是「渐进式取数」带来的副作用：每到一个来源就重算一版，
 * 如果每次都重新随机，已经显示完整的组会在十几秒内**反复换脸**（用户会以为界面坏了）。
 * 所以这里给每组记一个候选集指纹（候选 id 排序后拼串）：
 * 指纹没变（这一组的候选没受新数据影响）就沿用上次挑的那 5 部；变了才重新随机。
 * 「换一批」走 force = true，强制重挑。
 */
function groupsOf(
  pools: Pools,
  year: number,
  season: number,
  prev: PickCache,
  force = false
): { groups: RecommendGroup[]; next: PickCache } {
  const next: PickCache = {}
  const groups = ruleDefs(year, season).map((d) => {
    const hits = d.pool(pools).filter(d.pass)
    // 指纹按 id **排序后**拼串：池子是分几次拼起来的，到达顺序每次都可能不同，
    // 不排序的话「候选集没变、只是顺序变了」也会被判成变了、白白重洗一次
    const sig = hits
      .map((it) => it.id)
      .sort((a, b) => a - b)
      .join(',')
    const old = prev[d.key]
    const items =
      !force && old && old.sig === sig && old.items.length > 0
        ? old.items
        : pickRandom(hits, RECOMMEND_PICK)
    next[d.key] = { sig, items }
    return {
      key: d.key,
      title: d.title,
      rule: d.rule,
      candidates: hits.length,
      items
    }
  })
  return { groups, next }
}

// ---------------- 取数 ----------------

/** 抽哪几个年份：当年必含（热门推荐的口径），其余从 2005..今年-1 随机 */
function sampleYears(): number[] {
  const now = new Date().getFullYear()
  const set = new Set<number>([now])
  let guard = 0
  while (set.size < SAMPLE_YEARS && guard < 200) {
    guard += 1
    set.add(2005 + Math.floor(Math.random() * (now - 2005)))
  }
  return [...set].sort((a, b) => b - a)
}

/**
 * 渐进式取候选池：每有一个来源到位就重算一版推荐。
 *
 * 为什么要渐进：全站抽样有十几个请求、主进程还有并发闸门（同时最多 2 个在飞），
 * 冷缓存下全部拉完要十几秒。等全部到位再渲染 = 用户对着空页等十几秒；
 * 分开渲染则每日放送（1 个请求）先到，用户几秒内就能看到当季推荐。
 */
function useRecommendations(): {
  groups: RecommendGroup[]
  loading: boolean
  error: string
  reshuffle: () => void
} {
  const [groups, setGroups] = useState<RecommendGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const poolsRef = useRef<Pools | null>(null)
  /** 上一次挑出来的条目：让渐进式取数过程中已经完整的组保持稳定（见 groupsOf） */
  const picksRef = useRef<PickCache>({})
  const cancelled = useRef(false)
  const inflight = useRef(false)

  const publish = useCallback((stillLoading: boolean, failure: string, force = false): void => {
    if (cancelled.current) return
    const { year, season } = seasonOfDate()
    const pools = poolsRef.current
    if (pools) {
      const built = groupsOf(pools, year, season, picksRef.current, force)
      picksRef.current = built.next
      setGroups(built.groups)
    } else {
      setGroups([])
    }
    setLoading(stillLoading)
    setError(stillLoading ? '' : failure)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    if (inflight.current) return
    inflight.current = true
    const { year, season } = seasonOfDate()
    const key = `${year}-${season}`
    const pools: Pools = { key, sample: [], year: [], season: [] }
    poolsRef.current = pools
    let failure = ''

    const jobs: Promise<void>[] = []

    // ① 每日放送：1 个请求、主进程 30 分钟缓存，通常最先到位
    jobs.push(
      api.bangumi
        .calendar()
        .then((r) => {
          if (!r.ok) {
            failure = failure || r.error
            return
          }
          if (r.data.error) failure = failure || r.data.error.message
          for (const day of r.data.days ?? []) {
            for (const it of day.items ?? []) pools.season.push(fromCalendar(it))
          }
          publish(true, '')
        })
        .catch((err: unknown) => {
          failure = failure || String((err as Error)?.message ?? err)
        })
    )

    // ② 采样年份 × 各季度：season() 内部拉该季度三个月份、主进程按季度缓存 7 天
    const years = sampleYears()
    const nowMonth = new Date().getMonth() + 1
    const nowYear = new Date().getFullYear()
    for (const y of years) {
      // 当年的未来季度必然是空的，不去白打请求
      const quarters = y === nowYear ? Array.from({ length: season }, (_, i) => i + 1) : [1, 2, 3, 4]
      for (const q of quarters) {
        // 防御：当年当季之后的月份还没到（seasonOfDate 已保证，这里再夹一次）
        if (y === nowYear && (q - 1) * 3 + 1 > nowMonth) continue
        jobs.push(
          api.bangumi
            .season(y, (q - 1) * 3 + 1)
            .then((r) => {
              if (!r.ok) {
                failure = failure || r.error
                return
              }
              if (r.data.error) failure = failure || r.data.error.message
              const items = (r.data.items ?? []).map(fromSeason)
              pools.sample.push(...items)
              // 当年份的单独留一份（热门推荐的口径是「当年」）
              if (y === year) pools.year.push(...items.filter((it) => inYear(it, year)))
              // 当季那几个月的条目单独留一份给「当季推荐」（当季池还要并上每日放送）
              if (y === year && q === season) pools.season.push(...items.filter((it) => inYear(it, year)))
              publish(true, '')
            })
            .catch((err: unknown) => {
              failure = failure || String((err as Error)?.message ?? err)
            })
        )
      }
    }

    await Promise.allSettled(jobs)

    const usable = pools.sample.length + pools.year.length + pools.season.length
    if (cancelled.current) {
      inflight.current = false
      return
    }
    if (usable > 0) {
      poolCache = { at: Date.now(), key, pools }
      publish(false, '')
    } else {
      // 一个条目都没取到（数据源全挂）：给一句人话 + 重试入口，其余界面不受影响
      poolsRef.current = null
      publish(false, failure || '推荐数据暂时取不到（数据源不可用）')
    }
    inflight.current = false
  }, [publish])

  useEffect(() => {
    cancelled.current = false
    const { year, season } = seasonOfDate()
    const key = `${year}-${season}`
    const cached = poolCache
    if (cached && cached.key === key && Date.now() - cached.at < POOL_TTL) {
      // 缓存命中：直接随机一版（用户要的是「每次进来都不一样」，而不是每次都联网）
      poolsRef.current = cached.pools
      publish(false, '')
      return () => {
        cancelled.current = true
      }
    }
    void load()
    return () => {
      cancelled.current = true
    }
  }, [load, publish])

  /**
   * 换一批：有池子就只重洗（0 请求，force 强制重新随机），
   * 没池子（上次一个条目都没取到）才重新走一遍取数。
   */
  const reshuffle = useCallback((): void => {
    if (poolsRef.current) publish(false, '', true)
    else void load()
  }, [load, publish])

  return { groups, loading, error, reshuffle }
}

// ---------------- 组件 ----------------

/** 分组图标：只影响观感，与判据无关，所以留在界面层而不是塞进 RecommendGroup */
const GROUP_ICONS: Record<RecommendGroupKey, LucideIcon> = {
  hot: Flame,
  top: Star,
  hidden: Sparkles,
  season: CalendarRange
}

/**
 * 一个推荐分组：标题 + 判据 + 竖排名字列表。
 *
 * v0.3.6 去掉了封面：用户明确要求「不显示封面，只显示名字 + 评分人数」。
 * 顺带解决了一个性能问题 —— 一屏 20 张封面会同时触发 sakana-img 请求，
 * 而名字列表是纯文本，进页面就能看。
 */
function GroupColumn({
  group,
  loading,
  onOpen
}: {
  group: RecommendGroup
  loading: boolean
  onOpen: (id: string) => void
}) {
  const Icon = GROUP_ICONS[group.key]
  /*
   * 「真的没有了」只在**取数明确结束**且候选确实不足 5 部时才显示。
   * 池子还在路上（loading 且一个候选都没有）时说这句话是假信息 ——
   * 用户会以为这个分组天生只有这么几部。
   */
  const waiting = loading && group.candidates === 0
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-border bg-elev1 p-2.5" data-recommend-group={group.key}>
      <div className="flex items-center gap-1.5">
        <Icon size={13} className="shrink-0 text-accent" />
        <span className="truncate text-xs font-semibold">{group.title}</span>
        {loading ? null : (
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-faint">{group.candidates}</span>
        )}
      </div>
      <div className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-faint">{group.rule}</div>

      <div className="mt-1.5 flex flex-col gap-0.5">
        {group.items.map((it) => (
          <button
            key={it.id}
            type="button"
            title={`${it.nameCn || it.name}${it.nameCn && it.name !== it.nameCn ? `\n${it.name}` : ''}${
              it.score ? `\n评分 ${it.score.toFixed(1)}` : '\n暂无评分'
            }`}
            onClick={() => onOpen(String(it.id))}
            className="group flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent-soft"
          >
            {/* 名字是唯一可点内容，占满剩余宽度；评分人数右对齐固定宽度，多行时纵向对齐 */}
            <span className="min-w-0 flex-1 truncate text-[11px] leading-4 text-text group-hover:text-accent">
              {it.nameCn || it.name}
            </span>
            <span
              className="flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-faint"
              title={`${it.total} 人评分`}
            >
              <Users size={9} />
              {it.total >= 10000 ? `${(it.total / 10000).toFixed(1)}万` : it.total}
            </span>
          </button>
        ))}

        {group.items.length < RECOMMEND_PICK ? (
          waiting ? (
            <div className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1.5 text-[10px] text-faint">
              <Spinner size={10} /> 正在挑选…
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border px-2 py-1.5 text-center text-[10px] text-faint">
              {RECOMMEND_EMPTY_TEXT}
            </div>
          )
        ) : null}
      </div>
    </section>
  )
}

/**
 * 搜索页空态里的随机推荐区。
 *
 * 布局：四组**横向**排成一排（热门 → 高分 → 冷门 → 当季），组内条目竖向。
 * 窄窗口放不下四列时自动折成两列（`sm:grid-cols-2 xl:grid-cols-4`）——
 * 硬撑四列会把名字挤成三四个字加省略号，反而看不出是哪部番。
 *
 * `onOpen` 由页面传入（页面的跳转要先落一份会话快照，见 SearchPage 的 openSubject），
 * 本组件只负责「点哪一条」。
 */
export function RecommendRail({
  onOpen,
  className = ''
}: {
  onOpen: (id: string) => void
  className?: string
}) {
  const { groups, loading, error, reshuffle } = useRecommendations()

  /*
   * 推荐也要遵守番剧表屏蔽规则与黑名单（v0.3.6 用户要求）。
   *
   * 复用番剧表那套：`useScheduleBlock` 拿配置、`blockReason` 判命中。
   * ⚠️ 标签是**懒加载**的：番剧表接口不带标签，必须逐条 `api.bangumi.subject(id)` 补详情。
   * 推荐区一屏最多 20 条，但标签请求要走主进程并发闸门（2），全补一轮要十几秒 ——
   * 所以这里**先只补黑名单**（不需要标签、立刻生效），标签命中留给用户真正去番剧表时再补。
   * 好处是「黑名单」这个用户主动拉黑的强意图可以马上在推荐区生效，
   * 而不是等十几秒的标签队列 —— 那期间用户已经看到不该看到的番了。
   */
  const blockCfg = useScheduleBlock((s) => s.cfg)
  const tagMap = useScheduleTags((s) => s.tags)
  const blocked = useMemo(() => {
    const set = new Set<number>()
    for (const g of groups) {
      for (const it of g.items) {
        if (blockReason({ id: it.id }, null, blockCfg)) set.add(it.id)
      }
    }
    return set
  }, [groups, blockCfg])

  // 标签到位的条目再筛一次（黑名单之外的标签命中，等番剧表那边把标签缓存起来后自然生效）
  const tagBlocked = useMemo(() => {
    const set = new Set<number>()
    for (const g of groups) {
      for (const it of g.items) {
        const tags = tagMap[it.id]
        if (tags && tags.length > 0 && blockReason({ id: it.id }, tags, blockCfg)) set.add(it.id)
      }
    }
    return set
  }, [groups, blockCfg, tagMap])

  const hide = useMemo(() => new Set([...blocked, ...tagBlocked]), [blocked, tagBlocked])

  const shown = useMemo(
    () =>
      groups.map((g) => {
        const items = g.items.filter((it) => !hide.has(it.id))
        return { ...g, items, hidden: g.items.length - items.length }
      }),
    [groups, hide]
  )

  const nothingYet = shown.every((g) => g.items.length === 0)
  const hiddenTotal = shown.reduce((n, g) => n + g.hidden, 0)

  return (
    <div className={`mt-4 space-y-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Dices size={15} className="shrink-0 text-accent" />
        <span className="text-sm font-semibold">随机推荐</span>
        <span className="text-[11px] text-faint">每次进搜索页随机抽一批（全站抽样）</span>
        {hiddenTotal > 0 ? (
          <span className="flex items-center gap-1 text-[10px] text-faint" title="按番剧表设置与黑名单隐藏">
            <ShieldOff size={11} /> 已隐藏 {hiddenTotal} 部
          </span>
        ) : null}
        <button
          type="button"
          onClick={reshuffle}
          disabled={loading && nothingYet}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-faint transition-colors hover:bg-elev2 hover:text-accent disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading && nothingYet ? 'animate-spin' : ''} /> 换一批
        </button>
      </div>

      {loading && nothingYet ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-faint">
          <Spinner size={16} /> 正在挑选推荐…
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-elev2/60 px-3 py-2 text-[11px] leading-relaxed text-dim">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={reshuffle} className="shrink-0 text-accent transition-colors hover:underline">
            重试
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {shown.map((g) => (
          <GroupColumn key={g.key} group={g} loading={loading} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}

// ---------------- 空态最底部的大肥鱼轮播 ----------------

/**
 * 大肥鱼图片来源（**路径来自用户配置**，所以必须写在代码里）。
 *
 * ⚠️ 这些文件在用户在 D 盘的表情包目录下，**不在仓库里、也不在图片协议白名单里**，
 * 因此渲染层不能直接用 file:// 或裸路径引用（sakana-img://local 只放行
 * media.ts registerDefaultRoots() 注册过的目录，D:\ME 不在其中 → 直接引用必然 403）。
 * 文件缺失 / 复制失败时**静默隐藏整块图区**，其余推荐内容照常显示（见下方 alive 的判空）。
 */
const FISH_SOURCES = [
  'D:\\ME\\表情包\\deepseek大肥鱼.png',
  'D:\\ME\\表情包\\deepseek大肥鱼表情1.gif',
  'D:\\ME\\表情包\\deepseek大肥鱼表情2.gif',
  'D:\\ME\\表情包\\deepseek大肥鱼表情3.gif',
  'D:\\ME\\表情包\\deepseek大肥鱼表情4.gif'
]

/** 图片来源标注（用户指定文案） */
const FISH_SOURCE_NOTE = '图片来源：蓝色大肥鱼.com'

/**
 * 落盘缓存的键：存的是**复制进应用目录后的白名单路径**，不是 D:\ME 的原始路径。
 * 与 stores/marks.ts 的 migrateShowcase 同一个思路（那边是轮播图的历史迁移）。
 */
const FISH_CACHE_KEY = 'sakana.recommendFish'

/** 缓存有效期：24 小时内不再重复调用 importImages（复制本身是幂等的，纯粹省一次 IPC） */
const FISH_CACHE_TTL = 24 * 3600 * 1000

/** 轮播间隔与淡入淡出时长（用户要求「轮流切换展示」，3~4 秒一张） */
const FISH_ROTATE_MS = 3500
const FISH_FADE_S = 0.6

/** 读缓存：任何异常/过期都当成「没有缓存」，下次进入重新复制一次，不影响渲染 */
function readFishCache(): string[] {
  try {
    const raw = localStorage.getItem(FISH_CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { at?: unknown; paths?: unknown }
    if (typeof parsed?.at !== 'number' || Date.now() - parsed.at > FISH_CACHE_TTL) return []
    return Array.isArray(parsed.paths)
      ? parsed.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []
  } catch {
    return []
  }
}

/**
 * 把这些图收进应用数据目录，返回**白名单内**的新路径。
 *
 * 走的是路线 1（`api.showcase.importImages` 复制进 `<userData>/search-showcase`，再用 localImgUrl 显示）：
 * 复制后路径在 media.ts 白名单里，图片协议能正常读，重启也不会失效。
 * **不走路线 2**（`api.dialog.pickImages()` 让用户自己选）：那会在空态里弹一个文件选择框，
 * 直接打断「一进页面就有内容」的体验，而这几张图本来就是用户指定好的。
 *
 * 主进程对**复制失败**的处理是「原样返回源路径」（见 settingsExt.importShowcaseImages 的注释），
 * 那种路径就是白名单外的 D:\ME 地址、显示必然 403 —— 所以这里把它们滤掉，
 * 只留下真正复制成功的（路径 ≠ 源路径）。
 */
async function importFish(): Promise<string[]> {
  const r = await api.showcase.importImages(FISH_SOURCES)
  if (!r.ok) return []
  const src = new Set(FISH_SOURCES)
  return r.data.filter((p) => typeof p === 'string' && p.length > 0 && !src.has(p))
}

/**
 * 空置区域最底部的大肥鱼图：轮流切换 + 淡入淡出，旁边标注来源。
 *
 * ## 「按图片大小来优化样式」（v0.3.6 用户反馈）
 *
 * 老实现是「固定 140px 高的框 + `object-contain`」：这些表情包有方形也有宽扁的，
 * contain 之后横向留一大块空白、图本身很小（用户看到的就是"图挤在中间"）。
 * 现在做三件事：
 *   ① **按每张图的实际宽高比**给它算一个合适的显示高度（方图给 180、宽图给 120，图越大越显眼），
 *      用 CSS 的 `aspect-ratio` 表达，不再用一个死高度；
 *   ② 一次只显示**一张**（用户要求"轮流切换"），所以不需要网格；
 *   ③ 框**贴合图片**（`w-fit` + 图片自己的比例），不做成整行宽 —— 宽扁的图不会再把两侧拉空。
 * 读不到尺寸时回退到 object-contain + 固定高度，行为与老版本一致（不会崩、也不会跳）。
 */
export function FishStrip({ className = '' }: { className?: string }) {
  const [images, setImages] = useState<string[]>([])
  /** 加载失败的图片：直接移出轮播，别让它在「破图」和「好图」之间来回闪 */
  const [broken, setBroken] = useState<string[]>([])
  /** 每张图的原始宽高比（w/h）；读不到就不设，走 CSS 兜底 */
  const [ratios, setRatios] = useState<Record<string, number>>({})
  const [idx, setIdx] = useState(0)

  // 首次进入复制一次并缓存结果；命中缓存就不再调 IPC
  useEffect(() => {
    let alive = true
    const cached = readFishCache()
    if (cached.length > 0) {
      setImages(cached)
      return () => {
        alive = false
      }
    }
    void (async () => {
      let paths: string[] = []
      try {
        paths = await importFish()
      } catch {
        paths = [] // IPC 失败：静默隐藏
      }
      if (!alive || paths.length === 0) return
      setImages(paths)
      try {
        localStorage.setItem(FISH_CACHE_KEY, JSON.stringify({ at: Date.now(), paths }))
      } catch {
        /* 存不下就算了：下次进来再复制一次（幂等，代价只是一次 IPC） */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const alive = useMemo(() => images.filter((p) => !broken.includes(p)), [images, broken])

  // 只有一张时不启动计时器（省掉无意义的 setState），与 ImageCarousel 的取法一致
  useEffect(() => {
    if (alive.length <= 1) return
    const timer = window.setInterval(() => setIdx((i) => i + 1), FISH_ROTATE_MS)
    return () => window.clearInterval(timer)
  }, [alive.length])

  if (alive.length === 0) return null
  const active = ((idx % alive.length) + alive.length) % alive.length
  const current = alive[active]
  const ratio = ratios[current]

  /*
   * 按比例选高度（用户要的"按图片大小优化"）：
   *   · 宽扁的图（ratio ≥ 1.6）：给 110px —— 再高就只是把两侧空白撑得更宽；
   *   · 接近方形（1.0 ≤ ratio < 1.6）：150px；
   *   · 竖长（ratio < 1.0）：180px，让它有足够高度显示细节。
   * 高度乘上比例就是宽度，所以图片区**恰好等于图片**，没有多余留白。
   */
  const height = ratio === undefined ? 150 : ratio >= 1.6 ? 110 : ratio >= 1 ? 150 : 180

  return (
    /*
     * v0.3.7：改成**竖排**（图在上、来源标注在下），让「图片本体」正好居中。
     *
     * 原来是横排（图在左、来源标注在右，`items-end gap-3`）：整行居中的结果是
     * **图片被那行标注挤到左边**（实测偏左 86px）—— 用户要的是「图片轮换区域位于底部中间」，
     * 居中的应该是图，而不是「图 + 一行字」。标注放到下面居中，图的中心就落在内容区中心上。
     */
    <div className={`flex flex-col items-center gap-1 ${className}`}>
      <div
        className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-accent-soft/40 via-elev2 to-elev3"
        style={{ height, aspectRatio: ratio ? String(ratio) : '16 / 9', maxWidth: '100%' }}
      >
        <AnimatePresence initial={false}>
          <motion.img
            key={current}
            src={localImgUrl(current)}
            alt=""
            draggable={false}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: FISH_FADE_S }}
            /* 解码完成后记下真实比例 → 上面据此调整框的宽高（只记一次，不触发重排循环） */
            onLoad={(e) => {
              const el = e.currentTarget
              if (!el.naturalWidth || !el.naturalHeight) return
              const r = el.naturalWidth / el.naturalHeight
              setRatios((prev) => (prev[current] ? prev : { ...prev, [current]: r }))
            }}
            onError={() => setBroken((b) => (b.includes(current) ? b : [...b, current]))}
            className="absolute inset-0 h-full w-full object-contain"
          />
        </AnimatePresence>
        {alive.length > 1 ? (
          <span className="pointer-events-none absolute right-1.5 top-1.5 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] tabular-nums text-white">
            {active + 1}/{alive.length}
          </span>
        ) : null}
      </div>
      <span className="text-center text-[10px] leading-relaxed text-faint">{FISH_SOURCE_NOTE}</span>
    </div>
  )
}

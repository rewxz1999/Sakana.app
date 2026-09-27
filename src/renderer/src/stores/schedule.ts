import { create } from 'zustand'
import type { CalendarDay, SourceError } from '@shared/types'
import {
  DEFAULT_SCHEDULE_BLOCK,
  fetchTagsThrottled,
  resolveBlockConfig,
  type ScheduleBlockConfig
} from '@shared/scheduleBlock'
import { api } from '@/lib/api'

interface ScheduleState {
  days: CalendarDay[]
  loading: boolean
  error: SourceError | null
  fetchedAt: number | null
  fromCache: boolean
  stale: boolean
  /**
   * v0.3.2：本次番剧表是不是**备用数据源（Jikan/AniList）兜底**来的。
   *
   * 兜底只在主数据源（反代 + 镜像）全挂时触发，且覆盖面比主源小
   * （AniList 的季度模型只给「当季在播」）—— 所以界面上要如实标出来，
   * 否则用户会以为「番剧莫名其妙变少了」。
   */
  fallbackSource: 'jikan' | null
  selectedDay: number // 1-7
  weekOffset: number
  ratings: Record<number, { score: number | null; total: number }>
  load: (force?: boolean) => Promise<void>
  loadRatings: (ids: number[]) => Promise<void>
  selectDay: (day: number) => void
  shiftWeek: (delta: number) => void
}

export const useSchedule = create<ScheduleState>((set, get) => ({
  days: [],
  loading: false,
  error: null,
  fetchedAt: null,
  fromCache: false,
  stale: false,
  fallbackSource: null,
  ratings: {},
  selectedDay: (() => {
    const d = new Date().getDay()
    return d === 0 ? 7 : d
  })(),
  weekOffset: 0,
  load: async (force = false) => {
    if (get().loading) return
    set({ loading: true })
    const r = await api.bangumi.calendar(force)
    if (r.ok) {
      set({
        days: r.data.days,
        error: r.data.error ?? null,
        fetchedAt: r.data.fetchedAt,
        fromCache: r.data.fromCache,
        stale: !!r.data.stale,
        // 主进程只在「走了兜底」时才挂 dataSource，缺失即代表主数据源数据
        fallbackSource: r.data.dataSource?.source === 'jikan' ? 'jikan' : null,
        loading: false
      })
      /*
       * 只补「没有评分」的条目（v0.2.7）。
       *
       * 过去这里把整周 111 个 id 全部丢给评分补全 → 主进程会对每个 id 单独请求一次条目接口。
       * 换了自建反代之后，这一波并发会把反代打到 503，表现就是「很多番剧详情加载不出来」。
       * 而放送数据本身**已经带评分**（反代返回的 104/111 条都带 score），根本不需要补。
       */
      const missingIds = r.data.days
        .flatMap((d) => d.items)
        .filter((i) => !i.rating || i.rating.score == null)
        .map((i) => i.id)
      if (missingIds.length > 0) void get().loadRatings(missingIds)
    } else {
      set({
        error: { kind: 'NETWORK', message: r.error, tried: [] },
        loading: false
      })
    }
  },
  selectDay: (day) => set({ selectedDay: day }),
  loadRatings: async (ids) => {
    const { ratings } = get()
    const missing = ids.filter((id) => !(id in ratings))
    if (missing.length === 0) return
    const r = await api.bangumi.ratings(missing)
    if (r.ok) {
      set((s) => ({ ratings: { ...s.ratings, ...r.data } }))
    }
  },
  shiftWeek: (delta) => set((s) => ({ weekOffset: Math.max(-4, Math.min(4, s.weekOffset + delta)) }))
}))

// ============================================================
// 番剧表「分级标签屏蔽 + 黑名单」配置
// ============================================================
//
// 为什么不放进 AppSettings（shared/types.ts）：屏蔽只作用于番剧表这一个页面，
// 塞进全局设置会让 settings.json 越来越重，也会被「导出/导入设置」顺带带走。
// 这里用**独立的 store 键** `scheduleBlock` 读写，读不到（老版本从没写过）就用默认值
// （默认只开一级屏蔽，见 shared/scheduleBlock.ts 的 DEFAULT_SCHEDULE_BLOCK）。

const SCHEDULE_BLOCK_KEY = 'scheduleBlock'

interface ScheduleBlockState {
  cfg: ScheduleBlockConfig
  loaded: boolean
  load: () => Promise<void>
  save: (patch: Partial<ScheduleBlockConfig>) => void
  toggleBlacklist: (id: number) => void
}

export const useScheduleBlock = create<ScheduleBlockState>((set, get) => ({
  cfg: { ...DEFAULT_SCHEDULE_BLOCK },
  loaded: false,
  load: async () => {
    const r = await api.store.get(SCHEDULE_BLOCK_KEY)
    // 没写过这个键时主进程返回 null → resolveBlockConfig 回落到默认值
    set({ cfg: resolveBlockConfig(r.ok ? r.data : null), loaded: true })
  },
  save: (patch) => {
    const next = resolveBlockConfig({ ...get().cfg, ...patch })
    set({ cfg: next })
    void api.store.set(SCHEDULE_BLOCK_KEY, next)
  },
  toggleBlacklist: (id) => {
    const cur = get().cfg
    const has = cur.blacklist.includes(id)
    get().save({
      blacklist: has ? cur.blacklist.filter((x) => x !== id) : [...cur.blacklist, id]
    })
  }
}))

// ============================================================
// 番剧表条目的标签缓存（供标签屏蔽使用）
// ============================================================
//
// 为什么必须在渲染层做这层缓存：
// 番剧表的 CalendarItem 里**没有可用标签**（genres 实测恒为空、platform 只有 TV/WEB），
// 要屏蔽就只能逐条查番剧详情拿 tags。111 条一次性并发会把自建反代打到 503
// （项目历史上已经踩过一次，见上面 loadRatings 的注释），所以这里：
// - 只补**当前这一周**番剧表里的条目（不补全站、不补搜索结果）；
// - 并发 2 + 每条之间 sleep 150ms（见 shared/scheduleBlock 的 fetchTagsThrottled）；
// - 内存 + localStorage 双缓存，7 天过期，刷新页面/重启应用都不重复取；
// - **拿不到标签的条目一律不屏蔽**（宁可不屏蔽也不能误杀），失败与「因连续失败中止」的 id
//   都记进 failed，界面据此显示「N 部未取到标签（不屏蔽）」；
// - 开关全关时调用方根本不会调用 ensureTags（判据是 shared 的 shouldLoadTags），
//   所以「不影响搜索结果」在流量层面也是成立的。

const TAG_CACHE_KEY = 'sakana.scheduleTags.v1'
/** 缓存有效期：7 天（新番开播/补标签的节奏远达不到每天一次，7 天足够新） */
const TAG_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 落盘时超过这个时间的条目直接删掉（只清不发请求） */
const TAG_PRUNE_MS = 30 * 24 * 60 * 60 * 1000
/** 落盘节流：一次补 111 条会触发 111 次结果回调，攒一下再写 localStorage */
const TAG_PERSIST_DEBOUNCE_MS = 800

interface TagCacheEntry {
  /** 标签名数组 */
  t: string[]
  /** 写入时间戳 */
  at: number
}

interface TagCacheFile {
  v: number
  entries: Record<string, TagCacheEntry>
}

/**
 * 读 localStorage 里的标签缓存。
 * 解析失败/被禁用（隐私模式、配额满）时一律当成空缓存：只是重新取一次，功能不受影响。
 */
function readTagCacheFromDisk(): Record<string, TagCacheEntry> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(TAG_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<TagCacheFile> | null
    const entries = parsed && typeof parsed === 'object' && parsed.entries ? parsed.entries : {}
    const now = Date.now()
    const out: Record<string, TagCacheEntry> = {}
    for (const [key, value] of Object.entries(entries)) {
      if (!value || !Array.isArray(value.t) || typeof value.at !== 'number') continue
      if (now - value.at > TAG_PRUNE_MS) continue
      out[key] = { t: value.t.map((x) => String(x)), at: value.at }
    }
    return out
  } catch {
    return {}
  }
}

/** 落盘用的全量映射（含已过期但未超过 TAG_PRUNE_MS 的条目，下次进来还能当「过期缓存」用） */
let tagDisk: Record<string, TagCacheEntry> = readTagCacheFromDisk()
let tagPersistTimer: ReturnType<typeof setTimeout> | null = null

function persistTagCache(): void {
  if (typeof localStorage === 'undefined') return
  if (tagPersistTimer) clearTimeout(tagPersistTimer)
  tagPersistTimer = setTimeout(() => {
    tagPersistTimer = null
    try {
      const now = Date.now()
      const entries: Record<string, TagCacheEntry> = {}
      for (const [key, value] of Object.entries(tagDisk)) {
        if (now - value.at > TAG_PRUNE_MS) continue
        entries[key] = value
      }
      tagDisk = entries
      const file: TagCacheFile = { v: 1, entries }
      localStorage.setItem(TAG_CACHE_KEY, JSON.stringify(file))
    } catch {
      // 配额满或被禁用：本次会话的内存缓存照常工作，只是重启后会重新取
    }
  }, TAG_PERSIST_DEBOUNCE_MS)
}

/** 启动时把 7 天内的缓存灌进内存（过期的不灌，但保留在 tagDisk 里等待被覆盖/清理） */
function freshTagsFromDisk(): Record<number, string[]> {
  const now = Date.now()
  const out: Record<number, string[]> = {}
  for (const [key, value] of Object.entries(tagDisk)) {
    if (now - value.at > TAG_TTL_MS) continue
    const id = Number(key)
    if (!Number.isFinite(id)) continue
    out[id] = value.t
  }
  return out
}

/**
 * 全局单队列：多个调用方（番剧表页 / 设置页）同时要标签时，全部并入同一条队列，
 * 保证「同时在途请求 ≤ 2」这个约束在任何情况下都成立（每条队列各自并发就会翻倍）。
 */
const tagPending: number[] = []
const tagInFlight = new Set<number>()
let tagQueueRunning = false

interface ScheduleTagState {
  /** 条目 id → 标签名（**键不存在 = 还没拿到 → 不屏蔽**） */
  tags: Record<number, string[]>
  /** 本次会话取不到标签的 id（不重试、不屏蔽） */
  failed: number[]
  /** 队列是否还在跑（界面显示进度用） */
  fetching: boolean
  /** 请求补齐这些条目的标签（已在缓存/已失败/已在队列里的会被自动跳过） */
  ensureTags: (ids: number[]) => void
}

export const useScheduleTags = create<ScheduleTagState>((set, get) => {
  /**
   * 取一条番剧详情的标签名。
   * 失败、详情为空、tags 为空数组都返回 null —— 调用方据此把该条目记入 failed 并**不屏蔽**它。
   */
  const fetchOne = async (id: number): Promise<string[] | null> => {
    const r = await api.bangumi.subject(id)
    if (!r.ok) return null
    const detail = r.data.data
    if (!detail) return null
    const names = (detail.tags ?? []).map((t) => String(t?.name ?? '').trim()).filter(Boolean)
    return names.length > 0 ? names : null
  }

  const drainQueue = async (): Promise<void> => {
    if (tagQueueRunning) return
    tagQueueRunning = true
    set({ fetching: true })
    try {
      while (tagPending.length > 0) {
        const batch = tagPending.splice(0, tagPending.length)
        await fetchTagsThrottled<string[]>(batch, fetchOne, {
          onResult: (id, value) => {
            tagInFlight.delete(id)
            if (value) {
              tagDisk[String(id)] = { t: value, at: Date.now() }
              persistTagCache()
              set((s) => ({ tags: { ...s.tags, [id]: value } }))
            } else {
              set((s) => (s.failed.includes(id) ? s : { failed: [...s.failed, id] }))
            }
          }
        })
      }
    } finally {
      tagQueueRunning = false
      set({ fetching: false })
    }
  }

  return {
    tags: freshTagsFromDisk(),
    failed: [],
    fetching: false,
    ensureTags: (ids) => {
      const { tags, failed } = get()
      let added = false
      for (const id of ids) {
        if (!Number.isFinite(id)) continue
        if (id in tags) continue // 已有缓存
        if (failed.includes(id)) continue // 本次会话已失败过：不重试，也不屏蔽
        if (tagInFlight.has(id) || tagPending.includes(id)) continue
        tagPending.push(id)
        tagInFlight.add(id)
        added = true
      }
      if (added) void drainQueue()
    }
  }
})

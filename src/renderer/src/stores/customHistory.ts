import { create } from 'zustand'
import type { CoverImages } from '@shared/types'
import { seasonIndexOfMonth, SEASON_NAMES } from '@shared/season'
import { api } from '@/lib/api'

/**
 * 自建历史表（工具页入口 /tools/custom-history）。
 *
 * 用户要的东西：把「自己挑的番剧」按年份摆成一张表，两种版式——
 *   · **简易显示**：窗口垂直中间一条**横向年份轴**，每个年份挑 1–4 部，交替摆在轴的上方 / 下方，
 *     每部只画**封面 + 名字**（不放评分、集数等任何次要信息）；
 *   · **清晰显示**：窗口**左侧**一条**纵向年份轴**，右侧（中间 + 右侧区域）全是番剧卡片
 *     （封面 + 名字 + 年份/季度 + 评分），每个年份最多 10 部。
 * 两种版式共用同一份数据（同一年就是同一批番剧），只是渲染方式不同，并且都能导出成图片。
 *
 * ============================ 几个刻意的取舍（写在这里，以后要改先看这段） ============================
 *
 * ① **上限按两种版式的较大者（10）限制存储，简易显示只画前 4 部。**
 *    两种版式共用一份数据，如果按简易显示的 4 部去卡存储，
 *    用户在清晰显示里就永远加不进第 5 部 —— 那等于让「清晰显示」的 10 部上限失效。
 *    反过来「存 10 部、简易只画前 4 部」的代价是：简易显示看不到全部内容，
 *    所以页面必须**明说**这件事（超过 4 部时给出提示条），并且提供「置顶」让用户
 *    把想展示的那几部挑到前面 —— 毕竟用户的原话是「挑每个年份**最有代表性的** 1-4 部」，
 *    顺序本身就是选择的一部分。
 *
 * ② **年份按「从早到晚」升序排列**（简易显示从左到右、清晰显示从上到下都是这个方向）。
 *    年份轴是一条时间轴，用户是在「用年份讲一段历史」，正向阅读更顺；
 *    ⚠️ 收藏页的年份栏是**倒序**（新→旧，见 FavoritesPage 的 `sort((a, b) => b[0] - a[0])`），
 *    这里刻意不同。要统一的话只需改 `groupByYear` 里那一处比较方向。
 *
 * ③ **用户归到的年份 ≠ 放送年份。** 搜索添加时，如果这部番的放送年份和当前选中的年份不一致，
 *    页面会问用户「改到它自己的年份」还是「仍加到当前年份」，所以条目上存的是 `year`（用户的选择），
 *    放送日期另存 `airDate`。展示、分组、上限一律只看 `year`。
 *
 * 本文件的纯函数（分组 / 上限 / 年份判定 / 季节文案）**不依赖 React 与 DOM**，
 * 由 scripts/verify-custom-history.mjs 直接 import 真实源码跑断言。
 */

/** 持久化键（本项目约定：渲染层本地缓存统一用 sakana- 前缀） */
export const CUSTOM_HISTORY_KEY = 'sakana-custom-history'

/** 简易显示每个年份展示的番剧数上限（用户挑「最有代表性的」1–4 部） */
export const SIMPLE_LIMIT = 4

/** 清晰显示每个年份的卡片上限 */
export const DETAIL_LIMIT = 10

/**
 * 实际落盘的上限 = 两种版式的较大者。
 * 见文件头 ① 的说明：存 10 部，简易显示只画前 `SIMPLE_LIMIT` 部。
 */
export const MAX_PER_YEAR = DETAIL_LIMIT

/**
 * 年份选择的下界。
 * 与 RecommendRail 里「其余年份从 2005..今年-1 随机」用的是同一个下界，
 * 本项目的年份选择器都从这里起步（2005 年之前 Bangumi 的季度数据覆盖也很差）。
 */
export const MIN_YEAR = 2005

/** 放送年份的合理上界：超过它的一定是脏日期（例如把 20261 截成 4 位的那种） */
export const MAX_YEAR = 2100

/** 两种版式（导出弹窗里也用它当选项） */
export type HistoryMode = 'simple' | 'detail'

/** 版式名：界面按钮、导出弹窗、导出图标题共用一份，避免一处叫「简易」一处叫「简洁」 */
export const HISTORY_MODE_NAMES: Record<HistoryMode, string> = {
  simple: '简易显示',
  detail: '清晰显示'
}

/** 版式对应的每年上限（简易 4 / 清晰 10） */
export function modeLimit(mode: HistoryMode): number {
  return mode === 'simple' ? SIMPLE_LIMIT : DETAIL_LIMIT
}

/**
 * 自建历史表里的一条番剧。
 *
 * 只存渲染要用的最小字段（封面直链 + 名字 + 放送日期 + 评分），不存整个 SubjectDetail：
 * 这份数据要落盘，存大对象以后改字段就会带来一堆历史数据的兼容问题。
 */
export interface CustomHistoryItem {
  subjectId: number
  /** 原名（日文/英文） */
  name: string
  /** 中文名（可能为空，界面取 `nameCn || name`） */
  nameCn: string
  /** 界面用的封面地址（common 档，见 coverFields） */
  cover: string
  /** 导出用的封面候选链（large 优先，逐档降级；`cover` 一定在其中） */
  covers: string[]
  /** 放送日期，可能缺失（缺失时无法核对年份，见 yearCheck） */
  airDate: string | null
  rating: number | null
  /** **用户把它归到哪一年**（搜索添加时可能不等于放送年，见文件头 ③） */
  year: number
  /** 加入时间：同一年的展示顺序就按它（早加入的在前） */
  addedAt: number
}

/** 新增一条时的输入（`addedAt` 由 store 补） */
export interface CustomHistoryInput {
  subjectId: number
  name: string
  nameCn: string
  cover: string
  covers: string[]
  airDate: string | null
  rating: number | null
}

/** 一个年份分组（`items` 已按加入顺序排好） */
export interface CustomHistoryYearGroup {
  year: number
  items: CustomHistoryItem[]
}

/**
 * 新增结果。
 * `simpleVisible` = 这条在**简易显示**里画不画得出来（前 4 部才画）——
 * 页面据此决定要不要提示「它只在清晰显示里出现」。
 */
export type AddResult =
  | { ok: true; year: number; count: number; simpleVisible: boolean }
  | { ok: false; kind: 'limit' | 'duplicate'; message: string }

/** 放送年份与目标年份的关系（搜索添加时用它决定要不要弹确认框） */
export type YearCheck =
  | { kind: 'match'; airYear: number }
  | { kind: 'missing'; airYear: null }
  | { kind: 'mismatch'; airYear: number }

// ------------------------------------------------------------------
// 纯函数：年份与季节
// ------------------------------------------------------------------

/**
 * 从放送日期里取年份。
 *
 * 判据与 `lib/format.ts` 的 `yearOf` 同源（都只看**前 4 位数字**，所以 '2026-13-01'
 * 这种脏日期照样算 2026 年，与收藏页/番剧页的年份口径一致）；额外多做两件事：
 *   · 必须真的是 4 位数字（`yearOf('999-07-01')` 会得到 999，那明显不是年份）；
 *   · 必须落在 1900–2100 内，超出的当「没有年份」处理。
 * 返回 null 表示**取不到年份**（缺字段 / 脏值），界面按「无法核对」处理，不是「不一致」。
 */
export function airYearOf(airDate: unknown): number | null {
  if (typeof airDate !== 'string') return null
  const m = /^\s*(\d{4})/.exec(airDate)
  if (!m) return null
  const y = Number(m[1])
  if (!Number.isFinite(y) || y < 1900 || y > MAX_YEAR) return null
  return y
}

/** 放送年份 vs 目标年份：一致 / 取不到 / 不一致 */
export function yearCheck(airDate: unknown, targetYear: number): YearCheck {
  const airYear = airYearOf(airDate)
  if (airYear === null) return { kind: 'missing', airYear: null }
  return airYear === Math.trunc(targetYear) ? { kind: 'match', airYear } : { kind: 'mismatch', airYear }
}

/** 年份不一致时的提示（用户明确要求「添加时对应的年份不对就自动提示」） */
export function mismatchMessage(title: string, airYear: number, targetYear: number): string {
  return `《${title}》是 ${airYear} 年的番剧，当前选中的是 ${targetYear} 年`
}

/** 没有放送日期时的提示：核对不了年份，但仍然允许加入 */
export function missingYearMessage(title: string): string {
  return `《${title}》没有放送日期，无法核对年份`
}

/**
 * 年份选择器的选项：**从今年倒着排到 2005**（新→旧）。
 * 用户绝大多数时候在补最近几年的表，倒序能把常用年份放在列表最上面。
 */
export function selectableYears(now: Date = new Date()): number[] {
  const last = Math.max(MIN_YEAR, Math.trunc(now.getFullYear()))
  const out: number[] = []
  for (let y = last; y >= MIN_YEAR; y -= 1) out.push(y)
  return out
}

/**
 * 某条番剧的季节文案（`2021 年春`），与项目统一的季节约定一致：
 * 1–3 月 = 冬、4–6 月 = 春、7–9 月 = 夏、10–12 月 = 秋（见 @shared/season）。
 * 取不到月份时返回空串（清晰显示的卡片上就不显示这一段）。
 */
export function seasonTextOf(airDate: unknown): string {
  if (typeof airDate !== 'string') return ''
  const y = airYearOf(airDate)
  const m = /^\s*\d{4}-(\d{1,2})/.exec(airDate)
  if (y === null || !m) return ''
  const month = Number(m[1])
  if (!Number.isFinite(month) || month < 1 || month > 12) return ''
  return `${y} 年${SEASON_NAMES[seasonIndexOfMonth(month) - 1]}`
}

// ------------------------------------------------------------------
// 纯函数：封面档位
// ------------------------------------------------------------------

/** 界面列表/卡片用的封面档位顺序：common 在最前（约 200×300，列表里只有一百多像素宽，加载快最重要） */
const DISPLAY_COVER_ORDER: (keyof CoverImages)[] = ['common', 'medium', 'large', 'small', 'grid']

/** 导出用的封面档位顺序：large 在最前（反代给的就是原图），取不到再逐档降级 */
const EXPORT_COVER_ORDER: (keyof CoverImages)[] = ['large', 'common', 'medium', 'small', 'grid']

/**
 * 由接口的 images 得到要落盘的两个封面字段。
 *
 * 为什么**存两个**而不是一个：
 *   · `cover` 要给界面列表/卡片用 —— common 档（约 200×300）够清楚又加载快，
 *     列表里一屏可能就是几十张图，全用原图会明显变慢；
 *   · `covers` 是**导出用的候选链**，large 优先（反代给的就是原图）。
 *     导出图按 2–3 倍缩放画，拿 common 去画会被放大到发糊 —— 这正是用户强调的「注意清晰度」；
 *     留一串候选是因为单张图取不到时主进程会回空 dataUrl，那时要能自动换小一档再试。
 * 只存一个字段的话，必然要在「界面快」和「导出清」之间二选一，两边都得将就。
 */
export function coverFields(images: CoverImages | null | undefined): { cover: string; covers: string[] } {
  const covers = coverCandidates(images, EXPORT_COVER_ORDER)
  return { cover: coverCandidates(images, DISPLAY_COVER_ORDER)[0] ?? covers[0] ?? '', covers }
}

/** 按给定档位顺序取出所有非空地址（去重，保持顺序） */
function coverCandidates(
  images: CoverImages | null | undefined,
  order: (keyof CoverImages)[]
): string[] {
  if (!images) return []
  const out: string[] = []
  for (const key of order) {
    const v = images[key]
    if (typeof v === 'string' && v.length > 0 && !out.includes(v)) out.push(v)
  }
  return out
}

// ------------------------------------------------------------------
// 纯函数：收窄 / 分组 / 上限
// ------------------------------------------------------------------

/**
 * 把磁盘上的一条数据收窄成合法条目。
 *
 * 为什么必须收窄：这份数据由用户反复增删、跨版本读写，磁盘上什么都可能有
 * （缺字段、年份是字符串、subjectId 是 0、封面是 null…）。
 * 非法条目一律**丢掉**而不是猜一个默认值 —— 猜出来的年份会让番剧出现在错误的年份轴上，
 * 比少一条更难排查。subjectId 必须为正整数（详情页路由用它）。
 */
export function normalizeHistoryItem(raw: unknown): CustomHistoryItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const subjectId = typeof r.subjectId === 'number' && Number.isFinite(r.subjectId) ? Math.trunc(r.subjectId) : NaN
  const year = typeof r.year === 'number' && Number.isFinite(r.year) ? Math.trunc(r.year) : NaN
  if (!Number.isFinite(subjectId) || subjectId <= 0) return null
  if (!Number.isFinite(year) || year < MIN_YEAR || year > MAX_YEAR) return null
  const name = typeof r.name === 'string' ? r.name : ''
  const nameCn = typeof r.nameCn === 'string' ? r.nameCn : ''
  if (name.length === 0 && nameCn.length === 0) return null
  const addedAt = typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) ? r.addedAt : 0
  const rating = typeof r.rating === 'number' && Number.isFinite(r.rating) ? r.rating : null
  const cover = typeof r.cover === 'string' ? r.cover : ''
  // 候选链缺失（或老数据只有一个 cover）时退化成 [cover]：导出最少还有一张能画，不至于整格空白
  const covers = Array.isArray(r.covers) ? r.covers.filter((u): u is string => typeof u === 'string' && u.length > 0) : []
  return {
    subjectId,
    name,
    nameCn,
    cover,
    covers: covers.length > 0 ? covers : cover.length > 0 ? [cover] : [],
    airDate: typeof r.airDate === 'string' && r.airDate.length > 0 ? r.airDate : null,
    rating,
    year,
    addedAt
  }
}

/**
 * 整份数据收窄：逐条过滤 + 去掉重复（同一年里的同一部番只留最先加入的那条）+ 每年截到上限。
 * 上限也要在**读盘时**再卡一次：老版本或其他途径写进来的超限数据不能直接把界面撑坏。
 */
export function normalizeHistory(raw: unknown): CustomHistoryItem[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const perYear = new Map<number, number>()
  const out: CustomHistoryItem[] = []
  for (const row of raw) {
    const item = normalizeHistoryItem(row)
    if (!item) continue
    const key = `${item.year}:${item.subjectId}`
    if (seen.has(key)) continue
    const used = perYear.get(item.year) ?? 0
    if (used >= MAX_PER_YEAR) continue
    seen.add(key)
    perYear.set(item.year, used + 1)
    out.push(item)
  }
  return out
}

/** 某一年里的条目（已按加入顺序） */
export function itemsOfYear(items: CustomHistoryItem[], year: number): CustomHistoryItem[] {
  const y = Math.trunc(year)
  return items.filter((it) => it.year === y).sort(compareItems)
}

/** 同一年的展示顺序：加入时间早的在前，时间相同按 id 兜底（保证顺序稳定、可复现） */
function compareItems(a: CustomHistoryItem, b: CustomHistoryItem): number {
  if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt
  return a.subjectId - b.subjectId
}

/**
 * 分组：只保留**有内容的年份**，按年份**升序**（早→晚，见文件头 ②）。
 *
 * 为什么不把 2005–今年 的空年份也画上：那会把横轴拉成二十多列空列、
 * 竖轴上半屏都是「（空）」，用户真正要看的那几年反而被挤到边上。
 * 想补哪一年，左侧选年份添加即可，加完那一年自然就出现在轴上。
 */
export function groupByYear(items: CustomHistoryItem[]): CustomHistoryYearGroup[] {
  const map = new Map<number, CustomHistoryItem[]>()
  for (const it of items) {
    const list = map.get(it.year)
    if (list) list.push(it)
    else map.set(it.year, [it])
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, list]) => ({ year, items: [...list].sort(compareItems) }))
}

/** 某个年份在某种版式下**实际画出来**的番剧（简易显示只取前 4 部，见文件头 ①） */
export function visibleItems(items: CustomHistoryItem[], mode: HistoryMode): CustomHistoryItem[] {
  return items.slice(0, modeLimit(mode))
}

/**
 * 能不能把这部番加到该年份：返回带**可读文案**的结果，页面直接把它交给 toast，
 * 不在页面里再拼一遍规则（上限改了只要改这里）。
 */
export function canAdd(items: CustomHistoryItem[], year: number, subjectId: number): AddResult {
  const y = Math.trunc(year)
  const list = itemsOfYear(items, y)
  if (list.some((it) => it.subjectId === subjectId)) {
    return { ok: false, kind: 'duplicate', message: `这部番已经在 ${y} 年的自建历史表里了` }
  }
  if (list.length >= MAX_PER_YEAR) {
    return {
      ok: false,
      kind: 'limit',
      message: `${y} 年已经有 ${MAX_PER_YEAR} 部了（清晰显示的上限），先删掉几部再加`
    }
  }
  return { ok: true, year: y, count: list.length + 1, simpleVisible: list.length < SIMPLE_LIMIT }
}

// ------------------------------------------------------------------
// store
// ------------------------------------------------------------------

interface CustomHistoryState {
  items: CustomHistoryItem[]
  /** 是否已经从磁盘读过一次（页面据此决定要不要显示加载态） */
  loaded: boolean
  load: () => Promise<void>
  /** 把一部番加到某一年（`year` 由页面决定：搜索添加时可能是「它自己的年份」） */
  add: (input: CustomHistoryInput, year: number) => AddResult
  /** 删掉某一年里的某一条 */
  remove: (subjectId: number, year: number) => void
  /**
   * 置顶：把这一条移到该年份的第一位。
   * 简易显示只画前 4 部，所以「哪些算最有代表性」靠顺序表达（见文件头 ①）。
   */
  promote: (subjectId: number, year: number) => void
  /** 清空某一年 */
  clearYear: (year: number) => void
}

export const useCustomHistory = create<CustomHistoryState>((set, get) => ({
  items: [],
  loaded: false,
  load: async () => {
    const r = await api.store.get(CUSTOM_HISTORY_KEY)
    set({ items: r.ok ? normalizeHistory(r.data) : [], loaded: true })
  },
  add: (input, year) => {
    const check = canAdd(get().items, year, input.subjectId)
    // 上限 / 重复一律在这里拦住，不写盘（页面按 kind 给提示，不静默丢弃）
    if (!check.ok) return check
    // addedAt 递增一点点：同一毫秒内连点两次也不会让顺序变成不确定的
    const lastAt = get().items.reduce((max, it) => Math.max(max, it.addedAt), 0)
    const addedAt = Math.max(Date.now(), lastAt + 1)
    const item: CustomHistoryItem = { ...input, subjectId: Math.trunc(input.subjectId), year: check.year, addedAt }
    const next = [...get().items, item]
    set({ items: next })
    void api.store.set(CUSTOM_HISTORY_KEY, next)
    return check
  },
  remove: (subjectId, year) => {
    const y = Math.trunc(year)
    const next = get().items.filter((it) => !(it.subjectId === subjectId && it.year === y))
    if (next.length === get().items.length) return
    set({ items: next })
    void api.store.set(CUSTOM_HISTORY_KEY, next)
  },
  promote: (subjectId, year) => {
    const y = Math.trunc(year)
    const list = itemsOfYear(get().items, y)
    const me = list.find((it) => it.subjectId === subjectId)
    if (!me || list[0]?.subjectId === subjectId) return
    // 时间戳统一往前挪一格：其余条目的相对顺序不变，只有这一条跑到最前
    const oldest = list[0].addedAt
    const moved: CustomHistoryItem = { ...me, addedAt: oldest - 1 }
    const next = get().items.map((it) => (it.subjectId === subjectId && it.year === y ? moved : it))
    set({ items: next })
    void api.store.set(CUSTOM_HISTORY_KEY, next)
  },
  clearYear: (year) => {
    const y = Math.trunc(year)
    const next = get().items.filter((it) => it.year !== y)
    if (next.length === get().items.length) return
    set({ items: next })
    void api.store.set(CUSTOM_HISTORY_KEY, next)
  }
}))

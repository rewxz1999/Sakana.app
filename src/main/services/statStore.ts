import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CH } from '@shared/channels'
import {
  compareStatOrder,
  defaultSeqOf,
  nextSeq as nextSeqByRule,
  validateSeqRule,
  yearOfAirDate
} from '@shared/statSeq'
import type {
  StatAction,
  StatAddItem,
  StatEntry,
  StatEntryPatch,
  StatList,
  StatToolData,
  StatWatchProgress,
  WatchHistoryItem,
  WatchProgressItem
} from '@shared/types'
import { log } from '../log'
import { store } from '../store'
import { saveDirsInfo } from './saveDirs'

/**
 * 统计工具数据的**唯一写入方**（主进程）。
 *
 * 为什么必须这样（与 subsStore 同一套理由）：渲染层过去各自持有「打开页面时的快照」，
 * 改完把整个数组写回 JSON —— 主窗口与小窗口同时开着统计页时必然互相覆盖（丢失更新）。
 * 现在：渲染层只发一个 `StatAction`，读-改-写在主进程内存里串行完成，
 * 写盘后 `broadcastStat()` 把最新数据推给所有窗口，渲染层只做展示。
 *
 * 兼容：老的 `store:set('statTool', …)` 通道仍在（其它代码路径可能用到），
 * 但统计页自己不再走它。
 */

const NS = 'statTool'
const MAX_PHOTOS = 5
/** 条目上保留的类型标签数量上限（详情接口有 30 个 tag，全存进条目太重，界面也显示不下） */
const MAX_GENRES = 12
/** 类型标签单个名字的最大长度（防止有人把整段简介塞进来当标签） */
const MAX_GENRE_LEN = 24
const EMPTY: StatToolData = { lists: [], entries: [], revision: 0 }

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  if (Number.isNaN(n)) return null
  return Math.round(Math.min(10, Math.max(0, n)) * 10) / 10
}

/** 本地时区下的 `YYYY-MM-DD` */
function localDayOf(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 毫秒时间戳 → `YYYY-MM-DD`（本地时区） */
export function tsToDay(ts: number | null | undefined): string | null {
  if (!ts || !Number.isFinite(ts)) return null
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : localDayOf(d)
}

/**
 * 看完时间归一化：**只到天**（用户要求「不用精确到分秒」）。
 *
 * 兼容三种历史形态，全部收敛成 `YYYY-MM-DD`：
 * - `YYYY-MM-DD`（新形态）→ 原样返回；
 * - `YYYY-MM-DDTHH:mm`（v0.2 的本地时间形态，没有时区）→ 直接取日期部分，
 *   不走 `new Date()`：它对「本地时间字符串」的解析在各环境下不一致，取字符串前 10 位最稳；
 * - 带时区的 ISO（`…Z` / `+08:00`）+ 数字时间戳 → 先解析成时间点再按**本地时区**取日期，
 *   否则「晚上 8 点看的番」会被算成前一天/后一天。
 */
export function dayOnly(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'number') return tsToDay(v)
  const s = String(v).trim()
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m && !/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return `${m[1]}-${m[2]}-${m[3]}`
  const ms = Date.parse(s)
  if (Number.isNaN(ms)) return m ? `${m[1]}-${m[2]}-${m[3]}` : null
  return tsToDay(ms)
}

/** 类型标签归一化：去空、去重、限长、限量（详情接口按热度给出，顺序保留） */
export function normalizeGenres(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of v) {
    const g = String(raw ?? '').trim().slice(0, MAX_GENRE_LEN)
    if (!g || seen.has(g)) continue
    seen.add(g)
    out.push(g)
    if (out.length >= MAX_GENRES) break
  }
  return out
}

/**
 * 读取并**规范化**统计数据。
 *
 * 规范化做两件事，缺一不可：
 * 1. 补齐 v0.1 缺失的字段（老数据没有 genres / midReview / historyTier…，
 *    不补的话渲染层到处要写 `?? ''`，导出模板也要各自兜底）；
 * 2. 迁移旧评价：`reviews[0] → initialReview`、`reviews[1] → endReview`
 *    （渲染层原来的迁移逻辑在加载时做，现在收敛到主进程一处）。
 */
function normalizeEntry(raw: Partial<StatEntry> & { id?: string }): StatEntry {
  const legacy = Array.isArray(raw.reviews) ? raw.reviews.map((r) => String(r ?? '')) : []
  /**
   * 迁移旧评价时**必须把空串也当成"没有值"**。
   *
   * v0.1 的条目一定带 `initialReview: ''` / `finalReview: ''` 这两个字段（是旧版本的默认值），
   * 如果写成 `raw.initialReview ?? legacy[0]`，空串会把 `reviews[0]` 挡住 ——
   * 老用户升级后所有评价都会凭空消失。所以这里用"取第一个非空值"的语义。
   */
  const pick = (...candidates: (string | undefined)[]): string =>
    candidates.find((c) => typeof c === 'string' && c.trim() !== '') ?? ''
  const initialReview = pick(raw.initialReview, legacy[0])
  // v0.1 的 finalReview 是「完结评价」，语义上并入结束评价（中期那份空着）；
  // 老数据只有一条评价时（reviews 长度为 1），也把它当作结束评价显示，总比空着强。
  const endReview = pick(raw.endReview, raw.finalReview, legacy[1], legacy[0])
  return {
    id: String(raw.id ?? ''),
    listId: String(raw.listId ?? ''),
    subjectId: Number(raw.subjectId ?? 0),
    seq: String(raw.seq ?? ''),
    name: String(raw.name ?? ''),
    nameCn: String(raw.nameCn ?? ''),
    cover: String(raw.cover ?? ''),
    airDate: raw.airDate ? String(raw.airDate) : null,
    genres: normalizeGenres(raw.genres),
    // 看完时间一律归一化成「天」：老数据的 `…T21:04` 也在这里被抹掉时分
    watchedAt: dayOnly(raw.watchedAt),
    initialRating: numOrNull(raw.initialRating),
    midRating: numOrNull(raw.midRating),
    endRating: numOrNull(raw.endRating),
    personalRating: numOrNull(raw.personalRating),
    bgmRating: numOrNull(raw.bgmRating),
    initialReview,
    midReview: String(raw.midReview ?? ''),
    endReview,
    overallReview: String(raw.overallReview ?? ''),
    historyTier: String(raw.historyTier ?? ''),
    photos: Array.isArray(raw.photos)
      ? raw.photos.map((p) => String(p)).filter(Boolean).slice(0, MAX_PHOTOS)
      : [],
    remark: String(raw.remark ?? ''),
    reviews: legacy,
    finalReview: String(raw.finalReview ?? ''),
    order: Number(raw.order ?? 0) || 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined
  }
}

export function readStatData(): StatToolData {
  const raw = store.get<Partial<StatToolData>>(NS, EMPTY)
  const lists: StatList[] = (Array.isArray(raw.lists) ? raw.lists : []).map((l) => ({
    id: String(l?.id ?? ''),
    name: String(l?.name ?? '未命名列表'),
    createdAt: Number(l?.createdAt ?? Date.now()) || Date.now(),
    // 注意用 `=== true` 而不是 `!!`：store.get 会用 fallback 做一次浅合并，
    // 这里把非法值（字符串、数字）一律收敛成 false，避免 UI 上出现"半个置顶"
    pinned: l?.pinned === true,
    /*
     * 序号规则：磁盘上可能是旧版本写坏的值（手工编辑 JSON / 早期没有校验），
     * 这里统一按 shared/statSeq.ts 校验一遍，不合法的直接当"没有规则"（= 默认编序），
     * 否则一个非法规则会让这个列表**再也加不进条目**（nextSeq 一直报错）。
     */
    seqRule: (() => {
      const c = validateSeqRule(l?.seqRule)
      return c.ok ? c.rule : ''
    })()
  }))
  const entries = (Array.isArray(raw.entries) ? raw.entries : []).map(normalizeEntry)
  return { lists, entries, revision: Number(raw.revision ?? 0) || 0 }
}

function writeStatData(next: StatToolData): StatToolData {
  const data: StatToolData = { ...next, revision: (next.revision ?? 0) + 1 }
  store.set(NS, data)
  return data
}

/** 把最新统计数据推给所有窗口（主窗口 / 小窗口 / 托盘面板） */
export function broadcastStat(): void {
  const payload = readStatData()
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      w.webContents.send(CH.evStat, payload)
    } catch {
      /* 窗口正在销毁时忽略 */
    }
  }
}

/** 放送年份：取 airDate 前 4 位，取不到用当前年份（见 shared/statSeq.ts 的 yearOfAirDate） */
function yearOf(airDate: string | null | undefined): string {
  return yearOfAirDate(airDate)
}

/** 渲染层传来的 patch 只认白名单字段，避免把 listId / id 之类的字段改坏 */
function sanitizePatch(patch: StatEntryPatch): StatEntryPatch {
  const out: StatEntryPatch = {}
  const ratings: (keyof StatEntryPatch)[] = [
    'initialRating',
    'midRating',
    'endRating',
    'personalRating',
    'bgmRating'
  ]
  for (const k of ratings) {
    if (k in patch) (out as Record<string, unknown>)[k] = numOrNull(patch[k])
  }
  const texts: (keyof StatEntryPatch)[] = [
    'initialReview',
    'midReview',
    'endReview',
    'overallReview',
    'historyTier',
    'remark'
  ]
  for (const k of texts) {
    if (k in patch) (out as Record<string, unknown>)[k] = String(patch[k] ?? '')
  }
  // 看完时间：无论渲染层传什么（datetime-local 老值 / ISO）都归一到「天」
  if ('watchedAt' in patch) out.watchedAt = dayOnly(patch.watchedAt)
  if ('genres' in patch) out.genres = normalizeGenres(patch.genres)
  if ('seq' in patch) out.seq = String(patch.seq ?? '')
  if ('order' in patch) out.order = Number(patch.order ?? 0) || 0
  // 剧照：去空去重 + 截断到上限（渲染层的上限是 UI 约束，这里是底线）
  if ('photos' in patch) {
    const seen = new Set<string>()
    out.photos = (Array.isArray(patch.photos) ? patch.photos : [])
      .map((p) => String(p ?? ''))
      .filter((p) => {
        if (!p || seen.has(p)) return false
        seen.add(p)
        return true
      })
      .slice(0, MAX_PHOTOS)
  }
  return out
}

/**
 * 拖动排序：只改 `order`（1 起），**不动 seq**。
 *
 * 为什么拖动不改编号：`seq` 是用户自己定的编号（可能是 `A0701` 这种归档号），
 * 拖一下就把编号重排一遍会很意外；要按新顺序重编号有单独的「重新排序」按钮。
 */
function applyEntryOrder(entries: StatEntry[], listId: string, entryIds: string[]): StatEntry[] {
  const inList = entries.filter((e) => e.listId === listId)
  const pos = new Map(entryIds.map((id, i) => [id, i]))
  // 没被提到的条目接在后面（按原 order/seq），保持确定顺序
  const ordered = [...inList].sort((a, b) => {
    const pa = pos.has(a.id) ? (pos.get(a.id) as number) : Number.MAX_SAFE_INTEGER
    const pb = pos.has(b.id) ? (pos.get(b.id) as number) : Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return compareStatOrder(a, b)
  })
  const patched = new Map<string, number>()
  ordered.forEach((e, i) => patched.set(e.id, i + 1))
  return entries.map((e) => {
    const o = patched.get(e.id)
    return o == null || o === e.order ? e : { ...e, order: o, updatedAt: Date.now() }
  })
}

/**
 * 「重新排序」：按放送年份 + 当前顺序整表重排，并按列表的序号规则**重编号**。
 *
 * 默认规则（未设 seqRule）时保持 v0.2 的行为：同一年份内 01、02…；
 * 设了自定义规则时按规则续号（第一条用规则本身，之后 +1，见 shared/statSeq.ts）。
 * 规则溢出（数字部分超 8 位）等异常直接回落到默认编序并记日志 —— 宁可编号变回年份式，
 * 也不能让「重新排序」整个失败或者写出重号。
 */
function resortList(entries: StatEntry[], list: StatList | undefined): StatEntry[] {
  const listId = list?.id ?? ''
  const rule = list?.seqRule ?? ''
  const inList = entries.filter((e) => e.listId === listId)
  const ordered = [...inList].sort((a, b) => {
    const ya = yearOf(a.airDate)
    const yb = yearOf(b.airDate)
    if (ya !== yb) return ya.localeCompare(yb)
    return compareStatOrder(a, b)
  })
  const seqs: string[] = []
  const patched = new Map<string, { seq: string; order: number }>()
  ordered.forEach((e, i) => {
    const r = nextSeqByRule(rule, seqs, { year: yearOf(e.airDate) })
    const seq = r.ok ? r.seq : defaultSeqOf(yearOf(e.airDate), i + 1)
    if (!r.ok) log.append('warn', 'stat', `重新排序时序号规则失效（${r.reason}），已回落到默认编序`)
    seqs.push(seq)
    patched.set(e.id, { seq, order: i + 1 })
  })
  return entries.map((e) => {
    const p = patched.get(e.id)
    return p ? { ...e, seq: p.seq, order: p.order, updatedAt: Date.now() } : e
  })
}

/**
 * 新条目的 `seq` / `order`。
 *
 * - `seq`：按列表的序号规则续号（没规则 = 年份 + 顺序号）；
 * - `order`：列表内当前最大顺序 + 1（**整列**取最大，不按年份）——
 *   界面与导出图按 `order` 排序，新加的条目就应该落在最末尾。
 */
function nextSeqForList(
  entries: StatEntry[],
  list: StatList,
  airDate: string | null
): { seq: string; order: number } {
  const inList = entries.filter((e) => e.listId === list.id)
  const order = inList.reduce((m, e) => Math.max(m, Number(e.order) || 0), 0) + 1
  const r = nextSeqByRule(list.seqRule ?? '', inList.map((e) => e.seq), { year: yearOf(airDate) })
  if (r.ok) return { seq: r.seq, order }
  log.append('warn', 'stat', `序号规则不可用（${r.reason}），本条使用默认编序`)
  return { seq: defaultSeqOf(yearOf(airDate), order), order }
}

/**
 * 自动带出「已看完时间」（只到天）。
 *
 * 数据源结论（对着磁盘上的真实数据核对过，见本轮报告）：
 * - `favorites.json` 的 `watchedAt` 是**用户在番剧详情页手动标记/修改**的看完时间（毫秒时间戳），
 *   也是详情页「已看完」徽标的数据来源 —— 最可信，优先用；
 * - 详情接口（`subject3-*.json`）本身**没有**收藏/完成时间字段（实测 data 里只有
 *   id/name/name_cn/summary/air_date/images/rating/tags/infobox/eps/volumes/platform/totalEpisodes），
 *   所以「详情页的已看完时间」只能来自收藏那份手动标记；
 * - 用户没手动标记时，用详情页同一套自动判定：收藏的 `eps`（总集数）已知，
 *   且 `watchHistory` 覆盖的集数 ≥ 总集数 → 取最后一条观看记录的时间；
 * - **故意不用**「只要看过就用最后观看时间当看完时间」：那会给没看完的番也写上看完日期。
 *   想要这种情况的数据可以在详情窗口点「从观看记录带入」（显式操作）。
 */
export function statAutoWatchedAt(
  subjectId: number,
  name: string,
  nameCn: string
): string | null {
  const favorites = store.get<
    { subjectId: number; name?: string; nameCn?: string; eps?: number | null; watchedAt?: number | null }[]
  >('favorites', [])
  const history = store.get<WatchHistoryItem[]>('watchHistory', [])
  const fav = favorites.find((f) =>
    subjectId > 0 ? f.subjectId === subjectId : f.name === name || f.nameCn === nameCn
  )
  const manual = tsToDay(fav?.watchedAt ?? null)
  if (manual) return manual
  const eps = typeof fav?.eps === 'number' && fav.eps > 0 ? fav.eps : null
  if (!eps || !fav) return null
  const seen = new Set<number>()
  let last = 0
  for (const h of history) {
    if (h.subjectId !== subjectId) continue
    if (h.episode != null) seen.add(h.episode)
    last = Math.max(last, Number(h.watchedAt) || 0)
  }
  if (seen.size < eps) return null
  return tsToDay(last)
}

/**
 * 应用一个写操作。返回写入后的全量数据（渲染层用它立刻收敛本地状态），
 * 同时广播给所有窗口。
 */
export function applyStatAction(action: StatAction): StatToolData {
  const data = readStatData()
  let lists = data.lists
  let entries = data.entries

  switch (action.kind) {
    case 'createList': {
      const ruleCheck = validateSeqRule(action.seqRule)
      const list: StatList = {
        id: randomUUID(),
        name: action.name.trim() || '未命名列表',
        createdAt: Date.now(),
        seqRule: ruleCheck.ok ? ruleCheck.rule : ''
      }
      if (!ruleCheck.ok) log.append('warn', 'stat', `新建列表时序号规则被拒绝（${ruleCheck.reason}），已按默认编序`)
      lists = [...lists, list]
      break
    }
    case 'setSeqRule': {
      const target = lists.find((l) => l.id === action.listId)
      if (!target) break
      const check = validateSeqRule(action.seqRule)
      if (!check.ok) {
        // 非法规则一律不落盘：界面上已经拦过一次，这里是底线（避免列表永远加不进条目）
        log.append('warn', 'stat', `序号规则被拒绝（${check.reason}）：${String(action.seqRule ?? '').slice(0, 40)}`)
        break
      }
      lists = lists.map((l) => (l.id === action.listId ? { ...l, seqRule: check.rule } : l))
      // 规则本身当作起始号：如果这个列表还是空的，什么都没发生；有条目时后续按最大值续号
      log.append('info', 'stat', `列表序号规则已更新：${check.rule || '（默认：年份 + 01、02…）'}`)
      break
    }
    case 'renameList': {
      const name = action.name.trim()
      if (!name) break
      lists = lists.map((l) => (l.id === action.listId ? { ...l, name } : l))
      break
    }
    case 'deleteList': {
      // 只删「列表条目」，不动收藏 / 订阅 / 观看记录 / 截图文件
      lists = lists.filter((l) => l.id !== action.listId)
      entries = entries.filter((e) => e.listId !== action.listId)
      break
    }
    case 'setPinned': {
      lists = lists.map((l) => (l.id === action.listId ? { ...l, pinned: action.pinned } : l))
      break
    }
    case 'resort': {
      // 给了 entryIds = 拖动排序（只写 order）；没给 = 整表按年份重排 + 重编号
      if (action.entryIds && action.entryIds.length > 0) {
        entries = applyEntryOrder(entries, action.listId, action.entryIds)
      } else {
        entries = resortList(entries, lists.find((l) => l.id === action.listId))
      }
      break
    }
    case 'addEntries': {
      const listId = action.listId
      const list = lists.find((l) => l.id === listId)
      if (!list) break
      const added: StatEntry[] = []
      // 展开成数组后逐个判重：同一批里重复的也只会加一次
      for (const it of action.items ?? []) {
        const item: StatAddItem = it
        if (!item) continue
        const dup = [...entries, ...added].some(
          (e) =>
            e.listId === listId &&
            (Number(item.subjectId) > 0
              ? e.subjectId === Number(item.subjectId)
              : e.name === item.name && e.nameCn === item.nameCn)
        )
        if (dup) continue
        const { seq, order } = nextSeqForList([...entries, ...added], list, item.airDate)
        /*
         * 看完时间：用户/收藏已经给了就用那份（归一到天），否则按番剧详情页同一套判定自动带出。
         * 注意**不会覆盖**已有条目的值 —— 这里只处理新加入的条目，详情窗口的手动修改永远优先。
         */
        const watched = dayOnly(item.watchedAt) ?? statAutoWatchedAt(Number(item.subjectId) || 0, item.name ?? '', item.nameCn ?? '')
        added.push({
          id: randomUUID(),
          listId,
          subjectId: Number(item.subjectId) || 0,
          seq,
          name: String(item.name ?? ''),
          nameCn: String(item.nameCn ?? ''),
          cover: String(item.cover ?? ''),
          airDate: item.airDate ? String(item.airDate) : null,
          genres: normalizeGenres(item.genres),
          watchedAt: watched,
          initialRating: null,
          midRating: null,
          endRating: null,
          personalRating: null,
          bgmRating: numOrNull(item.rating),
          initialReview: '',
          midReview: '',
          endReview: '',
          overallReview: '',
          historyTier: '',
          photos: [],
          remark: '',
          reviews: [],
          finalReview: '',
          order,
          updatedAt: Date.now()
        })
      }
      entries = [...entries, ...added]
      break
    }
    case 'updateEntry': {
      const patch = sanitizePatch(action.patch ?? {})
      entries = entries.map((e) => (e.id === action.entryId ? { ...e, ...patch, updatedAt: Date.now() } : e))
      break
    }
    case 'removeEntry': {
      // 只删这条列表条目：收藏 / 观看记录 / 截图文件都不动
      entries = entries.filter((e) => e.id !== action.entryId)
      break
    }
    default:
      break
  }

  const next = writeStatData({ lists, entries, revision: data.revision })
  if (action.kind !== 'updateEntry') {
    log.append('info', 'stat', `统计工具变更：${action.kind}`)
  }
  broadcastStat()
  return next
}

/**
 * 详情窗口的观看进度。
 *
 * 数据来源（按优先级合并）：
 * - `watchProgress`：按 subjectId（或标题兜底）命中，`watched` 数组长度 = 已看集数；
 * - `watchHistory`：没有 progress 记录时用去重集数兜底（同一集看多次只算一集）；
 * - 收藏条目上的 `watchedAt`：**手动标记看完 = 已看完**（用户原话「被标记看完的就是已看完」）；
 * - 统计条目自己填了看完时间，同样算已看完。
 */
export function statWatchProgressFor(entry: StatEntry): StatWatchProgress {
  const progress = store.get<WatchProgressItem[]>('watchProgress', [])
  const history = store.get<WatchHistoryItem[]>('watchHistory', [])
  const favorites = store.get<{ subjectId: number; eps?: number | null; watchedAt?: number | null }[]>(
    'favorites',
    []
  )
  const fav = favorites.find((f) => f.subjectId === entry.subjectId)

  const byId = entry.subjectId > 0 ? progress.find((p) => p.subjectId === entry.subjectId) : undefined
  const byTitle = progress.find(
    (p) => !!p.title && (p.title === entry.name || p.title === entry.nameCn)
  )
  const hit = byId ?? byTitle

  let watchedEpisodes = hit?.watched?.length ?? 0
  if (watchedEpisodes === 0 && entry.subjectId > 0) {
    const eps = new Set<number>()
    for (const h of history) {
      if (h.subjectId === entry.subjectId && h.episode != null) eps.add(h.episode)
    }
    watchedEpisodes = eps.size
  }

  const totalEpisodes = typeof fav?.eps === 'number' && fav.eps > 0 ? fav.eps : null
  const flagged = !!fav?.watchedAt || !!entry.watchedAt
  const completed = flagged || (totalEpisodes != null && watchedEpisodes >= totalEpisodes)

  const histLast = history
    .filter((h) => (entry.subjectId > 0 ? h.subjectId === entry.subjectId : h.title === entry.name))
    .reduce((m, h) => Math.max(m, h.watchedAt), 0)
  const lastWatchedAt = Math.max(hit?.updatedAt ?? 0, histLast, fav?.watchedAt ?? 0) || null

  const parts: string[] = []
  if (totalEpisodes != null) parts.push(`已看 ${watchedEpisodes}/${totalEpisodes} 集`)
  else parts.push(`已看 ${watchedEpisodes} 集`)
  if (completed) parts.push(flagged && watchedEpisodes === 0 ? '已看完（手动标记）' : '已看完')
  return { watchedEpisodes, totalEpisodes, completed, lastWatchedAt, text: parts.join(' · ') }
}

/** 番剧截图目录：`<截图目录>/<番剧名>图片`（与播放器截图命名规则一致，见 ipc.ts） */
export function statShotPaths(entry: Pick<StatEntry, 'name' | 'nameCn'>): { root: string; dir: string } {
  const { screenshotDir } = saveDirsInfo()
  const title = (entry.nameCn || entry.name || '').trim()
  // 与 ipc.ts 的 snapshotPath 用同一套非法字符替换，否则目录名对不上
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  return { root: screenshotDir, dir: safe ? join(screenshotDir, `${safe}图片`) : screenshotDir }
}

import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CH } from '@shared/channels'
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
const EMPTY: StatToolData = { lists: [], entries: [], revision: 0 }

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  if (Number.isNaN(n)) return null
  return Math.round(Math.min(10, Math.max(0, n)) * 10) / 10
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
    genres: Array.isArray(raw.genres) ? raw.genres.map((g) => String(g)) : [],
    watchedAt: raw.watchedAt ? String(raw.watchedAt) : null,
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
    pinned: l?.pinned === true
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

/** 放送年份：取 airDate 前 4 位，未知用 '0000'（与 v0.1 的 seq 规则一致，老序号不变） */
function yearOf(airDate: string | null | undefined): string {
  return airDate?.slice(0, 4) || '0000'
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
  if ('watchedAt' in patch) out.watchedAt = patch.watchedAt ? String(patch.watchedAt) : null
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

/** 重排某列表：按年份分组，组内 01、02…（seq = 年份 + 两位顺序） */
function resortList(entries: StatEntry[], listId: string, entryIds?: string[]): StatEntry[] {
  const inList = entries.filter((e) => e.listId === listId)
  let ordered: StatEntry[]
  if (entryIds && entryIds.length > 0) {
    // 指定顺序：按 id 顺序排，未提到的条目接在后面（按原 order）
    const pos = new Map(entryIds.map((id, i) => [id, i]))
    ordered = [...inList].sort((a, b) => {
      const pa = pos.has(a.id) ? (pos.get(a.id) as number) : Number.MAX_SAFE_INTEGER
      const pb = pos.has(b.id) ? (pos.get(b.id) as number) : Number.MAX_SAFE_INTEGER
      if (pa !== pb) return pa - pb
      return a.order - b.order
    })
  } else {
    ordered = [...inList].sort((a, b) => {
      const ya = yearOf(a.airDate)
      const yb = yearOf(b.airDate)
      if (ya !== yb) return ya.localeCompare(yb)
      return a.order - b.order
    })
  }
  const counters = new Map<string, number>()
  const patched = new Map<string, { seq: string; order: number }>()
  for (const e of ordered) {
    const y = yearOf(e.airDate)
    const n = (counters.get(y) ?? 0) + 1
    counters.set(y, n)
    patched.set(e.id, { seq: `${y}${String(n).padStart(2, '0')}`, order: n })
  }
  return entries.map((e) => {
    const p = patched.get(e.id)
    return p ? { ...e, seq: p.seq, order: p.order, updatedAt: Date.now() } : e
  })
}

/** 新条目的 seq/order：该年份内已有条目的最大顺序 + 1 */
function nextSeq(
  entries: StatEntry[],
  listId: string,
  airDate: string | null
): { seq: string; order: number } {
  const year = yearOf(airDate)
  const max = entries
    .filter((e) => e.listId === listId && yearOf(e.airDate) === year)
    .reduce((m, e) => Math.max(m, e.order), 0)
  const order = max + 1
  return { seq: `${year}${String(order).padStart(2, '0')}`, order }
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
      const list: StatList = {
        id: randomUUID(),
        name: action.name.trim() || '未命名列表',
        createdAt: Date.now()
      }
      lists = [...lists, list]
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
      entries = resortList(entries, action.listId, action.entryIds)
      break
    }
    case 'addEntries': {
      const listId = action.listId
      if (!lists.some((l) => l.id === listId)) break
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
        const { seq, order } = nextSeq([...entries, ...added], listId, item.airDate)
        added.push({
          id: randomUUID(),
          listId,
          subjectId: Number(item.subjectId) || 0,
          seq,
          name: String(item.name ?? ''),
          nameCn: String(item.nameCn ?? ''),
          cover: String(item.cover ?? ''),
          airDate: item.airDate ? String(item.airDate) : null,
          genres: Array.isArray(item.genres) ? item.genres.map((g) => String(g)) : [],
          watchedAt: item.watchedAt ? String(item.watchedAt) : null,
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

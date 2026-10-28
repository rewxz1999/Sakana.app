import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { CacheDbPruneResult, CacheDbStats } from '@shared/api'
import {
  CACHE_IMAGE_TTL,
  CACHE_TTL,
  DAY_MS,
  isExpired,
  tierOf,
  type CacheDbEntrySummary,
  type CacheTier
} from '@shared/cachePolicy'
import { blockReason, resolveBlockConfig } from '@shared/scheduleBlock'
import { absoluteSeasonIndex, seasonIndexOfMonth, seasonOfDate } from '@shared/season'
import { log } from '../log'
import { store } from '../store'
import { cacheRoot } from './cacheRoot'

/**
 * 本地缓存数据库（V1.5.1）。
 *
 * ## 它解决什么问题
 *
 * 之前「缓存」只是散落在磁盘上的 JSON：谁知道某部番的详情还有没有、是哪天加载的、属于收藏还是
 * 番剧表？没人知道。于是只能整体保留或整体清空 —— 用户的要求（收藏永久、当季一个季度、
 * 历史表 15 天、其它 7 天、图片留得更久）**没有办法执行**。
 *
 * 这里维护一份**索引**（`<缓存根>/cache-db/index.json`），为每个条目记三件事：
 *   1. 磁盘上有哪些文件（`subject3-<id>.json` / `rating-<id>.json` / `chars-<id>.json` / `episodes-<id>.json`）；
 *   2. 最近一次**真的被加载/读到**的时间（保留计时的唯一基准）；
 *   3. 它出现在哪些表里（当季番剧表 / 历史表）——决定它属于哪一档保留策略。
 * 图片不进索引：文件名就是 sha1(最终请求地址)，用条目的封面地址**反推**文件名即可（见 bangumiImageUrl）。
 *
 * ## 为什么"复用"是首要目标
 *
 * 用户反复强调：减少 API 压力的首要方针是增加数据复用。所以清理只删**真的过期**的东西：
 *   · 收藏的条目/图片永久保留；
 *   · 图片比信息多留一截（重取代价最大）；
 *   · 同一张图被多个条目引用时，任一未过期就不删；
 *   · 被屏蔽/拉黑的条目直接停止加载（连缓存都不再回源）。
 *
 * ## 与 store 的关系
 *
 * 收藏、黑名单、屏蔽规则都在 `store` 里（渲染层会改），本模块**每次判定时现读**，
 * 不自己存一份副本 —— 否则用户取消收藏后索引还认为它是收藏，图片就永远删不掉。
 */

// ---------------- 常量与类型 ----------------

/** 索引文件名（放在缓存根下，跟图片/条目缓存同级，方便整体搬走/清理） */
const DB_DIR = 'cache-db'
const DB_FILE = 'index.json'
/** 索引版本：结构变化时递增，读到旧版本直接重建（索引是派生数据，丢了只会多留缓存，不会丢用户数据） */
const DB_VERSION = 1
/** 两次自动清理的最小间隔（启动时一次 + 运行中最多每 6 小时一次） */
const PRUNE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 写索引的防抖：详情页会连续写/读好几个键，没必要每次都落盘 */
const SAVE_DEBOUNCE_MS = 1200

/** 条目缓存文件命名规则（bangumi.ts 里的缓存键 + `.json`） */
const SUBJECT_FILE_RE = /^(subject3|rating|episodes|chars)-(\d+)\.json$/
/** 缓存键（不含 .json）同样规则，供 readCache/writeCache 直接判定 */
const SUBJECT_KEY_RE = /^(subject3|rating|episodes|chars)-(\d+)$/

/** 历史表的成员资格保留多久（超过这个时间的历史表数据本身也该重拉了，成员资格没有意义） */
const MEMBERSHIP_MAX_AGE_MS = 180 * DAY_MS

/** 列表类缓存的保留时长（不是"番剧信息"，只是列表 JSON） */
const LIST_TTL = {
  /** 搜索结果：7 天（搜索是临时行为，留一周足够复用） */
  search: 7 * DAY_MS,
  /** Jikan 兜底：7 天 */
  jikan: 7 * DAY_MS,
  /** 日历：90 天（每次启动都会尝试刷新，留一份主要是为了离线/断网时仍然能打开番剧表） */
  calendar: 90 * DAY_MS,
  /** 当季季度列表：120 天（比季长一点，避免季末最后一两天失效） */
  seasonCurrent: 120 * DAY_MS,
  /** 历史季度列表：30 天（历史表按需加载，不长期囤） */
  seasonPast: 30 * DAY_MS
}

/**
 * 一条条目记录。
 *
 * `files` 只记文件名（不记绝对路径）：缓存根目录可以被用户改，
 * 记绝对路径的话改一次目录就全部失效，文件名则跟着目录走。
 */
interface SubjectRecord {
  id: number
  /** 中文名 / 原名（只用于设置页列表，拿不到就显示 #id） */
  title?: string
  /** 原始封面地址（未改写；用于反推图片缓存文件名） */
  cover?: string
  /** 其它已知图片（角色立绘等，同样用于图片保留判定） */
  images?: string[]
  /** 磁盘上的条目 JSON 文件名 */
  files: string[]
  /** 最近一次真的被加载/读到的时间 */
  lastAt: number
  /** 它在**当季**番剧表里被记录时的季度（绝对季度序号），过季后自动按历史表口径算 */
  seasonAbs?: number
  /** 被屏蔽/拉黑的原因；非空 = 停止加载（不再回源，也不再返回缓存） */
  blockedReason?: string
  /** 命中屏蔽时的标签快照：用户改规则后可以重新判定（不必永久封死） */
  blockedTags?: string[]
}

interface DbFile {
  version: number
  /** 条目索引（含"只在当季表里出现过、还没加载详情"的条目，用于保护它们的封面图） */
  subjects: Record<string, SubjectRecord>
  /** 历史表成员资格：id → 最近一次出现在历史表的时间（只为判定 15 天档位） */
  historyIds: Record<string, number>
  updatedAt: number
  lastPruneAt: number | null
}

// ---------------- 状态 ----------------

let db: DbFile | null = null
let dbPathCache = ''
let saveTimer: NodeJS.Timeout | null = null
let pruning = false
/** 「原始图片地址 → 缓存文件名 hash」的解析器，由 bangumi.init() 注入（见 setImageNameResolver） */
let imageNameResolver: ((url: string) => string[]) | null = null
/** 「超上限时按最久未用删除图片」的实现，由 index.ts 注入（避免 cacheDb ↔ media 循环依赖） */
let imagePruner:
  | ((maxBytes: number | undefined, opts: { protect: (path: string) => boolean }) => {
      removed: number
      freedBytes: number
    })
  | null = null

export function setImageNameResolver(fn: ((url: string) => string[]) | null): void {
  imageNameResolver = fn
}

export function setImagePruner(fn: typeof imagePruner): void {
  imagePruner = fn
}

/** 索引文件路径（缓存根变了会自动切目录） */
function dbPath(): string {
  const path = join(cacheRoot(), DB_DIR, DB_FILE)
  if (path !== dbPathCache) {
    dbPathCache = path
    // 目录换了 = 换了另一套索引，内存里那份必须丢掉，否则会把旧目录的记录写进新文件
    db = null
  }
  return path
}

function emptyDb(): DbFile {
  return { version: DB_VERSION, subjects: {}, historyIds: {}, updatedAt: Date.now(), lastPruneAt: null }
}

/** 读索引（只在首次访问/换目录时真的读盘；损坏时重建，绝不抛异常拖住启动） */
function load(): DbFile {
  if (db) return db
  const file = dbPath()
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as DbFile
      if (parsed && parsed.version === DB_VERSION && parsed.subjects && typeof parsed.subjects === 'object') {
        db = {
          version: DB_VERSION,
          subjects: parsed.subjects,
          historyIds: parsed.historyIds && typeof parsed.historyIds === 'object' ? parsed.historyIds : {},
          updatedAt: Number(parsed.updatedAt) || Date.now(),
          lastPruneAt: typeof parsed.lastPruneAt === 'number' ? parsed.lastPruneAt : null
        }
        return db
      }
      log.append('info', 'cache-db', '缓存索引版本不匹配，按新格式重建（旧缓存会在下次清理时按策略处理）')
    }
  } catch (err) {
    log.append('warn', 'cache-db', `读取缓存索引失败，重建：${String((err as Error)?.message ?? err)}`)
  }
  db = emptyDb()
  return db
}

/** 立即落盘（tmp + rename 原子替换：进程被杀时不会留下半个 JSON） */
function saveNow(): void {
  if (!db) return
  const file = dbPath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    db.updatedAt = Date.now()
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(db), 'utf-8')
    renameSync(tmp, file)
  } catch (err) {
    log.append('warn', 'cache-db', `写缓存索引失败：${String((err as Error)?.message ?? err)}`)
  }
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveNow()
  }, SAVE_DEBOUNCE_MS)
  saveTimer.unref?.()
}

/** 退出时调用（store.flushAll 不会管到这里） */
export function flushCacheDb(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  saveNow()
}

// ---------------- 目录与文件 ----------------

function bangumiDir(): string {
  return join(cacheRoot(), 'bangumi')
}

function imageDir(): string {
  return join(cacheRoot(), 'img')
}

/** 一个文件名的字节数（读不到返回 0） */
function sizeOf(path: string): number {
  try {
    const st = statSync(path)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

/** 删除一个条目缓存文件（只允许动 bangumi 目录下、且名字符合条目文件规则的文件） */
function removeSubjectFile(name: string): boolean {
  if (!SUBJECT_FILE_RE.test(name)) return false
  const full = join(bangumiDir(), name)
  try {
    unlinkSync(full)
    return true
  } catch {
    return false
  }
}

// ---------------- 记录（记账入口） ----------------

function recordOf(id: number): SubjectRecord {
  const file = load()
  const key = String(id)
  let rec = file.subjects[key]
  if (!rec) {
    rec = { id, files: [], lastAt: 0 }
    file.subjects[key] = rec
  }
  return rec
}

/** 从任意数据里抽条目标题与图片地址（详情 / 角色 / 列表项的形状不同，统一按"找得到就用"处理） */
function absorbMeta(rec: SubjectRecord, data: unknown): void {
  if (!data || typeof data !== 'object') return
  const seen = new Set<string>(rec.images ?? [])
  const pushImage = (url: unknown): void => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    if (seen.has(url)) return
    // 上限只是防止异常数据把索引撑爆；正常条目（1 封面 + 20 角色）远小于它
    if (seen.size >= 120) return
    seen.add(url)
    if (!rec.cover) rec.cover = url
  }
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 5) return
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 200)) walk(item, depth + 1)
      return
    }
    const obj = node as Record<string, unknown>
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'name' || key === 'name_cn') {
        if (typeof value === 'string' && value.trim() && !rec.title) rec.title = value.trim()
        continue
      }
      if (key === 'images') {
        if (typeof value === 'string') pushImage(value)
        else if (value && typeof value === 'object') {
          const img = value as Record<string, unknown>
          // 优先 large（卡片/详情用的就是它），其余作为已知图片一起保护
          pushImage(img.large ?? img.common ?? img.medium ?? img.small)
          pushImage(img.common)
          pushImage(img.medium)
          pushImage(img.small)
        }
        continue
      }
      if (key === 'image' || key === 'avatar') {
        if (typeof value === 'string') pushImage(value)
        continue
      }
      if (typeof value === 'object') walk(value, depth + 1)
    }
  }
  walk(data, 0)
  if (seen.size > 0) rec.images = [...seen]
}

/**
 * 记账：某个条目缓存键**被写入或被读到**。
 *
 * 由 bangumi.ts 的 readCache / writeCache 统一调用 —— 这两处是"番剧信息真的被加载/复用"的
 * 唯一入口（详情、评分、集数、角色都从这里过），把钩子挂在这里就不可能漏记。
 *
 * 注意：只有**真的存在文件**的键才该调用（readCache 在命中后调用），
 * 否则一次未命中的读取会把无数个"从未缓存过"的条目记进索引。
 */
export function noteCacheFile(key: string, data?: unknown): void {
  const m = SUBJECT_KEY_RE.exec(key)
  if (!m) return
  const id = Number(m[2])
  if (!Number.isFinite(id) || id <= 0) return
  const rec = recordOf(id)
  const name = `${key}.json`
  if (!rec.files.includes(name)) rec.files.push(name)
  rec.lastAt = Date.now()
  if (data !== undefined) absorbMeta(rec, data)
  scheduleSave()
}

/** 当前季度（绝对季度序号，season.ts 的口径） */
function currentSeasonAbs(): number {
  const now = seasonOfDate()
  return absoluteSeasonIndex(now.year, now.season)
}

/**
 * 记账：**当季番剧表 / 日历**里出现的条目（用户语言里的「当季新番表」）。
 *
 * 为什么列表项也要记：番剧表的封面在列表里就已经加载了（用户的爱番卡片），
 * 这些封面图必须跟着"当季"档位一起保护（一个季度），否则下次清理会把它们当无主图片删掉，
 * 下次进番剧表又要重下一整屏的图 —— 正是用户要求"图片留久一点"的原因。
 */
export function recordListSubjects(
  items: readonly { id?: unknown; name?: unknown; name_cn?: unknown; images?: unknown }[],
  kind: 'current' | 'history'
): void {
  const now = Date.now()
  const file = load()
  const abs = currentSeasonAbs()
  let changed = false
  for (const item of items) {
    const id = Number(item.id)
    if (!Number.isFinite(id) || id <= 0) continue
    if (kind === 'history') {
      // 历史表：只记"它出现在历史表里"，**不创建**记录 —— 历史表动辄几千条，
      // 逐条建索引会把索引文件撑到几 MB，而它们并没有缓存任何信息。
      if (!file.historyIds[String(id)]) {
        file.historyIds[String(id)] = now
        changed = true
      }
      /*
       * 已经有记录的条目：历史表里也会**显示它的封面**，算"被加载过"，
       * 所以刷新 lastAt（否则刚翻完历史表、下次清理就把这些封面当过期图删了）。
       */
      const rec = file.subjects[String(id)]
      if (rec && (!rec.lastAt || now - rec.lastAt > 3600_000)) {
        rec.lastAt = now
        changed = true
      }
      continue
    }
    const rec = recordOf(id)
    rec.seasonAbs = abs
    // 当季表里出现 = 封面已经加载过（用户口径），保留计时从现在开始
    rec.lastAt = now
    if (!rec.title) {
      const t = String(item.name_cn ?? '').trim() || String(item.name ?? '').trim()
      if (t) rec.title = t
    }
    if (!rec.cover && item.images && typeof item.images === 'object') {
      const img = item.images as Record<string, unknown>
      const url = img.large ?? img.common ?? img.medium ?? img.small
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) rec.cover = url
      if (rec.cover) {
        const seen = new Set<string>(rec.images ?? [])
        seen.add(rec.cover)
        rec.images = [...seen]
      }
    }
    changed = true
  }
  if (changed) scheduleSave()
}

/**
 * 记账：某个季度列表被加载（历史表 / 季度页共用）。
 *
 * 当季 → 条目进"当季"档；往季 → 只登记历史表成员资格（15 天档）。
 * 由 bangumi.season() 在拿到数据（含缓存命中）后调用。
 */
export function recordSeasonItems(
  year: number,
  month: number,
  items: readonly { id?: unknown }[],
  opts?: { current?: boolean }
): void {
  if (!Number.isFinite(year) || !Number.isFinite(month)) return
  const season = seasonIndexOfMonth(month)
  const abs = absoluteSeasonIndex(year, season)
  const current = opts?.current ?? abs === currentSeasonAbs()
  if (!current) {
    recordListSubjects(items, 'history')
    return
  }
  recordListSubjects(items, 'current')
}

// ---------------- 屏蔽 / 黑名单 ----------------

function blockConfig(): ReturnType<typeof resolveBlockConfig> {
  return resolveBlockConfig(store.get('scheduleBlock', {}))
}

/** 该条目是否被屏蔽/拉黑（命中 → 停止加载） */
export function isSubjectBlocked(id: number): boolean {
  const cfg = blockConfig()
  if (cfg.blacklist.includes(id)) return true
  return Boolean(load().subjects[String(id)]?.blockedReason)
}

/** 屏蔽原因（界面提示用；未屏蔽返回 null） */
export function subjectBlockReason(id: number): string | null {
  const cfg = blockConfig()
  if (cfg.blacklist.includes(id)) return '黑名单'
  return load().subjects[String(id)]?.blockedReason ?? null
}

/**
 * 记下"这个条目命中了屏蔽规则"，并**清掉它的缓存信息**。
 *
 * 用户要求「一旦有番剧被屏蔽、被拉黑，该番剧的信息就停止加载」：
 * 停止加载分两步 —— 已有的信息删掉（不再被复用），后续请求在入口处直接拒绝（不再回源）。
 * 标签快照一起存下来，用户放宽规则后能自动恢复（见 prune 里的重新判定）。
 */
export function noteSubjectTags(id: number, tags: readonly string[] | null | undefined): void {
  if (!tags || tags.length === 0) return
  const reason = blockReason({ id }, tags, blockConfig())
  if (!reason) return
  const rec = recordOf(id)
  rec.blockedReason = reason
  rec.blockedTags = [...tags]
  purgeInfo(id, `命中屏蔽规则（${reason}）`)
  scheduleSave()
  log.append('info', 'cache-db', `条目#${id} 命中屏蔽规则（${reason}），已停止加载并清理其缓存信息`)
}

/** 清掉条目的缓存信息（保留记录本身：作者/标题还用于设置页展示与图片保护） */
function purgeInfo(id: number, why: string): number {
  const rec = load().subjects[String(id)]
  if (!rec || rec.files.length === 0) return 0
  let removed = 0
  for (const name of [...rec.files]) {
    if (removeSubjectFile(name)) removed++
  }
  rec.files = []
  if (removed > 0) log.append('info', 'cache-db', `清理条目#${id} 的缓存信息 ${removed} 个文件（${why}）`)
  return removed
}

// ---------------- 档位与过期判定 ----------------

/** 当前收藏 id 集合（现读 store，保证"取消收藏"立刻生效） */
function favoriteIds(): Set<number> {
  const list = store.get<{ subjectId?: unknown }[]>('favorites', [])
  const out = new Set<number>()
  for (const item of Array.isArray(list) ? list : []) {
    const id = Number(item?.subjectId)
    if (Number.isFinite(id) && id > 0) out.add(id)
  }
  return out
}

/**
 * 把收藏卡片上的封面地址同步进索引（V1.5.1）。
 *
 * 为什么需要：收藏的图片是"永久保留"的，而图片保护靠封面地址反推缓存文件名。
 * 一部番可能**从未进过番剧表/历史表**（比如搜索出来后直接收藏），这时索引里没有它的封面，
 * 它的封面就会被当成"无主图片"，只能靠 1GB 上限的 LRU 兜着 —— 上限一到先删最久未用的，
 * 用户翻收藏就会看到一片灰块，还要重新下载一整套封面。
 * 收藏列表本身就有 cover 字段，同步过来是零成本。
 */
function applyFavoriteMeta(): void {
  const list = store.get<{ subjectId?: unknown; cover?: unknown; nameCn?: unknown; name?: unknown }[]>('favorites', [])
  let changed = false
  for (const item of Array.isArray(list) ? list : []) {
    const id = Number(item?.subjectId)
    if (!Number.isFinite(id) || id <= 0) continue
    const rec = recordOf(id)
    const cover = typeof item.cover === 'string' ? item.cover : ''
    if (cover && rec.cover !== cover) {
      rec.cover = cover
      changed = true
    }
    if (cover) {
      const seen = new Set<string>(rec.images ?? [])
      if (!seen.has(cover)) {
        seen.add(cover)
        rec.images = [...seen]
        changed = true
      }
    }
    if (!rec.title) {
      const title = String(item.nameCn ?? '').trim() || String(item.name ?? '').trim()
      if (title) {
        rec.title = title
        changed = true
      }
    }
  }
  if (changed) scheduleSave()
}

/** 某条记录属于哪一档（收藏 > 当季 > 历史表 > 其它近期） */
function tierOfRecord(rec: SubjectRecord, favorites: Set<number>, curAbs: number): CacheTier {
  const file = load()
  const inHistory = Boolean(file.historyIds[String(rec.id)])
  return tierOf({
    favorite: favorites.has(rec.id),
    // seasonAbs 等于"当前季度"才算当季；过季自动降级为历史表口径（用户要的"过季后自动清理"）
    inCurrentSeason: rec.seasonAbs === curAbs,
    inHistory
  })
}

// ---------------- 图片 ----------------

/** 条目可能用到的图片缓存文件名 stem 集合 */
function imageStemsOf(rec: SubjectRecord): Set<string> {
  const out = new Set<string>()
  if (!imageNameResolver) return out
  const urls = new Set<string>()
  if (rec.cover) urls.add(rec.cover)
  for (const url of rec.images ?? []) urls.add(url)
  for (const url of urls) {
    try {
      for (const stem of imageNameResolver(url)) out.add(stem)
    } catch {
      /* 单个地址解析失败不影响其它图片 */
    }
  }
  return out
}

/** 磁盘上的图片文件：stem → 文件信息 */
function scanImages(): Map<string, { name: string; bytes: number; at: number }> {
  const map = new Map<string, { name: string; bytes: number; at: number }>()
  let names: string[] = []
  try {
    names = readdirSync(imageDir())
  } catch {
    return map
  }
  for (const name of names) {
    if (!/^\.[a-z0-9]+$/i.test(name.slice(24))) continue
    const full = join(imageDir(), name)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      map.set(name.slice(0, 24), {
        name,
        bytes: st.size,
        at: Math.max(st.atimeMs || 0, st.mtimeMs || 0)
      })
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  return map
}

// ---------------- 清理 ----------------

export interface CacheDbPruneOptions {
  /** 手动清理（忽略 6 小时间隔，也不看"上次清理时间"） */
  force?: boolean
}

/**
 * 按保留策略清理。
 *
 * 顺序刻意是「先判定、再删文件、最后删记录」：
 *   · 记录先留着，图片保护集合才能算出来（图片比信息留得久）；
 *   · 图片最后删，且要确认没有别的未过期条目也在用同一张图。
 */
export function pruneCacheDb(opts?: CacheDbPruneOptions): CacheDbPruneResult {
  const empty: CacheDbPruneResult = { subjects: 0, images: 0, lists: 0, freedBytes: 0 }
  if (pruning) return empty
  pruning = true
  try {
    const file = load()
    const now = Date.now()
    if (!opts?.force && file.lastPruneAt && now - file.lastPruneAt < PRUNE_MIN_INTERVAL_MS) {
      return empty
    }
    // 收藏卡片自带的封面/标题先同步进来：收藏的图片要永久保留，靠的就是这份映射
    applyFavoriteMeta()
    const favorites = favoriteIds()
    const curAbs = currentSeasonAbs()
    const cfg = blockConfig()

    // 1) 黑名单/屏蔽规则可能被用户改了：按快照重新判定，规则放宽就恢复加载
    for (const rec of Object.values(file.subjects)) {
      if (!rec.blockedReason) continue
      if (cfg.blacklist.includes(rec.id)) continue
      if (rec.blockedTags && rec.blockedTags.length > 0) {
        const still = blockReason({ id: rec.id }, rec.blockedTags, cfg)
        if (still) continue
        rec.blockedReason = undefined
        rec.blockedTags = undefined
        log.append('info', 'cache-db', `条目#${rec.id} 不再命中屏蔽规则，恢复加载`)
      }
    }

    // 2) 条目信息：过期的删文件（图片按另一张时间表，先不动）
    let infoRemoved = 0
    for (const rec of Object.values(file.subjects)) {
      if (favorites.has(rec.id)) continue
      if (rec.files.length === 0) continue
      if (rec.blockedReason) {
        // 被屏蔽的一律不留（停止加载 = 连缓存也不再复用）
        purgeInfo(rec.id, '被屏蔽/拉黑')
        infoRemoved++
        continue
      }
      const tier = tierOfRecord(rec, favorites, curAbs)
      if (isExpired(tier, rec.lastAt, now, CACHE_TTL)) {
        purgeInfo(rec.id, `${tier}档位超过保留期`)
        infoRemoved++
      }
    }

    // 3) 图片：先算出"还有谁在用"，再删过期的
    const liveStems = new Set<string>()
    const expiredStems = new Set<string>()
    for (const rec of Object.values(file.subjects)) {
      const tier = tierOfRecord(rec, favorites, curAbs)
      const stems = imageStemsOf(rec)
      if (stems.size === 0) continue
      if (!isExpired(tier, rec.lastAt, now, CACHE_IMAGE_TTL)) {
        for (const s of stems) liveStems.add(s)
      } else {
        for (const s of stems) expiredStems.add(s)
      }
    }
    const imagesOnDisk = scanImages()
    let imageRemoved = 0
    let freed = 0
    for (const stem of expiredStems) {
      if (liveStems.has(stem)) continue
      const hit = imagesOnDisk.get(stem)
      if (!hit) continue
      try {
        unlinkSync(join(imageDir(), hit.name))
        imagesOnDisk.delete(stem)
        imageRemoved++
        freed += hit.bytes
      } catch {
        /* 删不掉就留着，下次再说 */
      }
    }

    // 4) 记录本身：信息与图片都没了、也不是收藏/当季 → 从索引里移除（索引也要瘦身）
    for (const [key, rec] of Object.entries(file.subjects)) {
      const stems = imageStemsOf(rec)
      const hasProtectedImage = [...stems].some((s) => imagesOnDisk.has(s))
      const isFav = favorites.has(rec.id)
      // 当季表里的条目要留着（它们的封面还在用、也还要决定"过季后降级"）；过季后允许回收
      const isCurrentSeason = rec.seasonAbs !== undefined && rec.seasonAbs === curAbs
      if (rec.files.length === 0 && !hasProtectedImage && !isFav && !isCurrentSeason) {
        delete file.subjects[key]
      }
    }

    // 5) 历史表成员资格：太老的没有意义（对应的季度列表本身也会被清掉）
    for (const [key, at] of Object.entries(file.historyIds)) {
      if (!Number.isFinite(at) || now - at > MEMBERSHIP_MAX_AGE_MS) delete file.historyIds[key]
    }

    // 6) 列表类缓存
    const lists = pruneListCaches(now, curAbs)

    file.lastPruneAt = now
    saveNow()
    const result: CacheDbPruneResult = {
      subjects: infoRemoved,
      images: imageRemoved,
      lists: lists.removed,
      freedBytes: freed + lists.freedBytes
    }
    if (result.subjects > 0 || result.images > 0 || result.lists > 0) {
      log.append(
        'info',
        'cache-db',
        `缓存清理完成：条目信息 ${result.subjects} 项、图片 ${result.images} 张、列表 ${result.lists} 个，释放约 ${(
          result.freedBytes / 1048576
        ).toFixed(1)} MB`
      )
    }
    return result
  } catch (err) {
    log.append('warn', 'cache-db', `缓存清理失败（不影响使用）：${String((err as Error)?.message ?? err)}`)
    return empty
  } finally {
    pruning = false
  }
}

/**
 * 列表类缓存清理（搜索 / Jikan / 日历 / 季度）。
 *
 * 用文件 mtime 判定，不需要索引：这些文件是"整份可重取"的列表，
 * 丢了最多多一次请求，不影响任何离线已有数据。
 */
function pruneListCaches(now: number, curAbs: number): { removed: number; freedBytes: number } {
  let names: string[] = []
  try {
    names = readdirSync(bangumiDir())
  } catch {
    return { removed: 0, freedBytes: 0 }
  }
  let removed = 0
  let freed = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    if (SUBJECT_FILE_RE.test(name)) continue
    const key = name.slice(0, -5)
    let ttl: number
    if (key.startsWith('search-')) ttl = LIST_TTL.search
    else if (key.startsWith('jikan-')) ttl = LIST_TTL.jikan
    else if (key === 'calendar') ttl = LIST_TTL.calendar
    else if (key.startsWith('season-month-') || key.startsWith('season-')) {
      // season-<年>-<季> / season-month-<年>-<月>：当季多留，往季按历史表口径
      const y = Number(/(\d{4})/.exec(key)?.[1])
      const m = /-(\d+)$/.exec(key)?.[1]
      const abs = Number.isFinite(y) ? absoluteSeasonIndex(y, seasonIndexOfMonth(Number(m))) : -1
      ttl = abs === curAbs ? LIST_TTL.seasonCurrent : LIST_TTL.seasonPast
    } else {
      continue
    }
    const full = join(bangumiDir(), name)
    let at = 0
    let size = 0
    try {
      const st = statSync(full)
      at = st.mtimeMs
      size = st.size
    } catch {
      continue
    }
    if (now - at <= ttl) continue
    try {
      unlinkSync(full)
      removed++
      freed += size
    } catch {
      /* 删不掉就留着 */
    }
  }
  return { removed, freedBytes: freed }
}

/** 超上限时按最久未用瘦身（保护：收藏 + 未过期的图片） */
function pruneImagesOverCap(maxBytes: number): { removed: number; freedBytes: number } {
  if (!imagePruner) return { removed: 0, freedBytes: 0 }
  const file = load()
  const favorites = favoriteIds()
  const curAbs = currentSeasonAbs()
  const now = Date.now()
  const protect = new Set<string>()
  for (const rec of Object.values(file.subjects)) {
    const tier = tierOfRecord(rec, favorites, curAbs)
    if (isExpired(tier, rec.lastAt, now, CACHE_IMAGE_TTL)) continue
    for (const stem of imageStemsOf(rec)) protect.add(stem)
  }
  const imagesOnDisk = scanImages()
  const protectedNames = new Set<string>()
  for (const stem of protect) {
    const hit = imagesOnDisk.get(stem)
    if (hit) protectedNames.add(hit.name)
  }
  return imagePruner(maxBytes, { protect: (path) => protectedNames.has(basename(path)) })
}

// ---------------- 统计 ----------------

/**
 * 占用统计（设置页「本地缓存数据库」）。
 *
 * 分三类显示，与用户的说法一一对应：
 *   · 图片 —— `cache/img`
 *   · 番剧信息 —— 条目详情/角色/评分/集数 JSON
 *   · 番剧缓存 —— 番剧表/季度/搜索等列表 JSON + 索引本身
 */
export function cacheDbStats(): CacheDbStats {
  const file = load()
  // 收藏可能在本次清理之后才新增：统计前同步一次，才能把"收藏永久保留"的图片算进来
  applyFavoriteMeta()
  const now = Date.now()
  const favorites = favoriteIds()
  const curAbs = currentSeasonAbs()
  const imagesOnDisk = scanImages()

  let imagesBytes = 0
  for (const info of imagesOnDisk.values()) imagesBytes += info.bytes

  let infoBytes = 0
  let infoFiles = 0
  let infoSubjects = 0
  let listsBytes = 0
  let listsFiles = 0
  try {
    for (const name of readdirSync(bangumiDir())) {
      if (!name.endsWith('.json')) continue
      const bytes = sizeOf(join(bangumiDir(), name))
      if (SUBJECT_FILE_RE.test(name)) {
        infoBytes += bytes
        infoFiles++
        if (/^subject3-/.test(name)) infoSubjects++
      } else {
        listsBytes += bytes
        listsFiles++
      }
    }
  } catch {
    /* 目录还不存在：全部按 0 算 */
  }

  const indexBytes = sizeOf(dbPath())

  let expired = 0
  let favCount = 0
  let blocked = 0
  for (const rec of Object.values(file.subjects)) {
    const tier = tierOfRecord(rec, favorites, curAbs)
    if (tier === 'favorite') favCount++
    if (rec.blockedReason) blocked++
    if (rec.files.length > 0 && isExpired(tier, rec.lastAt, now, CACHE_TTL)) expired++
  }

  return {
    root: cacheRoot(),
    images: { bytes: imagesBytes, files: imagesOnDisk.size },
    info: { bytes: infoBytes, files: infoFiles, subjects: infoSubjects },
    lists: { bytes: listsBytes, files: listsFiles },
    index: { bytes: indexBytes },
    total: imagesBytes + infoBytes + listsBytes + indexBytes,
    favorites: favCount,
    blocked,
    expiredSubjects: expired,
    lastPruneAt: file.lastPruneAt
  }
}

/** 设置页列表上的「移除」等场景要读条目的标题/封面（只读，不触发清理） */
export function subjectMetaOf(id: number): { title: string; cover: string } | null {
  const rec = load().subjects[String(id)]
  if (!rec) return null
  return { title: rec.title ?? '', cover: rec.cover ?? '' }
}

/** 最近加载过的条目（设置页列表；按最近访问时间倒序） */
export function cacheDbEntries(limit = 30): CacheDbEntrySummary[] {
  const file = load()
  applyFavoriteMeta()
  const favorites = favoriteIds()
  const curAbs = currentSeasonAbs()
  const imagesOnDisk = scanImages()
  const rows: CacheDbEntrySummary[] = []
  for (const rec of Object.values(file.subjects)) {
    if (rec.files.length === 0 && !rec.cover) continue
    const tier = tierOfRecord(rec, favorites, curAbs)
    let infoBytes = 0
    for (const name of rec.files) infoBytes += sizeOf(join(bangumiDir(), name))
    let imageBytes = 0
    for (const stem of imageStemsOf(rec)) imageBytes += imagesOnDisk.get(stem)?.bytes ?? 0
    rows.push({
      id: rec.id,
      title: rec.title ?? `#${rec.id}`,
      cover: rec.cover ?? '',
      tier,
      infoBytes,
      imageBytes,
      lastAccessAt: rec.lastAt,
      infoRemoved: rec.files.length === 0
    })
  }
  rows.sort((a, b) => b.lastAccessAt - a.lastAccessAt)
  return rows.slice(0, Math.max(1, Math.min(200, limit)))
}

// ---------------- 生命周期 ----------------

/**
 * 启动初始化：读索引 → 收养磁盘上已有的条目缓存 → 跑一次清理。
 *
 * 「收养」是升级用户的关键一步：索引是新的，但磁盘上已经躺着几百个条目 JSON
 * （本机实测 842MB 图片 + 几百个 JSON）。不收养的话这些缓存会永远"不属于任何人"，
 * 既统计不到、也清不掉 —— 等于把用户已有的数据一笔勾销。
 */
export function initCacheDb(): void {
  load()
  const now = Date.now()
  let adopted = 0
  try {
    for (const name of readdirSync(bangumiDir())) {
      const m = SUBJECT_FILE_RE.exec(name)
      if (!m) continue
      const id = Number(m[2])
      const rec = recordOf(id)
      if (!rec.files.includes(name)) {
        rec.files.push(name)
        adopted++
      }
      // lastAt 缺失时用文件 mtime 兜底：老缓存没有访问时间，mtime 是最接近的真相
      if (!rec.lastAt) {
        try {
          rec.lastAt = statSync(join(bangumiDir(), name)).mtimeMs
        } catch {
          rec.lastAt = now
        }
      }
    }
  } catch {
    /* 目录不存在就是全新安装 */
  }
  if (adopted > 0) {
    log.append('info', 'cache-db', `缓存数据库已接管 ${adopted} 个已有条目缓存文件`)
    saveNow()
  }
  // 启动时跑一次清理（不强制：6 小时内已经清理过就跳过，避免频繁开关应用时反复扫盘）
  const result = pruneCacheDb()
  const stats = cacheDbStats()
  log.append(
    'info',
    'cache-db',
    `本地缓存数据库就绪：图片 ${(stats.images.bytes / 1048576).toFixed(1)} MB / ${stats.images.files} 张，` +
      `番剧信息 ${(stats.info.bytes / 1048576).toFixed(1)} MB / ${stats.info.subjects} 部，` +
      `列表 ${(stats.lists.bytes / 1048576).toFixed(1)} MB` +
      (result.subjects || result.images || result.lists
        ? `；本次清理 ${result.subjects} 项信息 / ${result.images} 张图 / ${result.lists} 个列表`
        : '；本次无需清理')
  )
}

/**
 * 收藏/黑名单被改动后的轻量响应。
 *
 * 不做立即清理（用户可能只是连点了几下收藏），只标脏并安排一次延后清理：
 * 「取消收藏的也自动清理」最终仍由 prune 执行，这里只保证不会等 6 小时。
 */
let libraryChangeTimer: NodeJS.Timeout | null = null
export function noteLibraryChanged(ns: string): void {
  if (ns !== 'favorites' && ns !== 'scheduleBlock') return
  if (libraryChangeTimer) return
  libraryChangeTimer = setTimeout(() => {
    libraryChangeTimer = null
    pruneCacheDb({ force: true })
  }, 20_000)
  libraryChangeTimer.unref?.()
}

/** 手动「立即清理」按钮：强制跑一次（忽略时间间隔；`maxBytes` 只给自检脚本覆盖图片上限用） */
export function pruneCacheDbNow(maxBytes?: number): CacheDbPruneResult {
  const r = pruneCacheDb({ force: true })
  const cap = Number.isFinite(maxBytes) && (maxBytes as number) > 0 ? (maxBytes as number) : 1024 * 1024 * 1024
  pruneImagesOverCap(cap)
  return r
}

/** 忘掉某个条目（设置页列表上的「移除」）：删信息 + 删图片 + 删索引记录 */
export function forgetSubject(id: number): { info: number; images: number } {
  const file = load()
  const rec = file.subjects[String(id)]
  if (!rec) return { info: 0, images: 0 }
  const info = purgeInfo(id, '用户手动移除')
  let images = 0
  const stems = imageStemsOf(rec)
  if (stems.size > 0) {
    const onDisk = scanImages()
    for (const stem of stems) {
      const hit = onDisk.get(stem)
      if (!hit) continue
      try {
        unlinkSync(join(imageDir(), hit.name))
        images++
      } catch {
        /* 删不掉就留着 */
      }
    }
  }
  delete file.subjects[String(id)]
  delete file.historyIds[String(id)]
  saveNow()
  return { info, images }
}

/** 「清除本地缓存数据」：索引也一起清掉（否则记录还在、文件没了，统计会显示一堆幽灵条目） */
export function resetCacheDb(): void {
  db = emptyDb()
  saveNow()
}

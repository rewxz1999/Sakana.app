import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import axios from 'axios'
import type {
  DanmakuComment,
  DanmakuMatch,
  DanmakuOrigin,
  DanmakuSourceRunInfo
} from '@shared/types'
import { resolveDanmakuSettings } from '@shared/types'
import { log } from '../log'
import { buildProxyAgents, getSettings } from '../net'
import { readCachedSource, writeCachedSource } from './danmakuCache'
import { integrateDanmaku, type DanmakuBatch } from './danmakuIntegrator'
import { progressBegin, progressDone, progressFail, progressStep } from './danmakuProgress'
import { enabledFetchers } from './danmaku/index'
import { noteNetworkFetch, readCachedBatches, runEnabledSources } from './danmakuSourceRunner'

/**
 * 弹幕接口（v0.2.8 正式接入）：对接弹弹play 的 v2 接口。
 *
 * ## 为什么可以直接用
 * 本应用走的是**已经配好 AppId 的反代**，签名由反代侧完成，客户端不需要带
 * `X-AppId / X-Timestamp / X-Signature`。仍保留「自己填 AppId/AppSecret」的老路径：
 * 只有当设置里同时填了这两项时才会附带签名头（那时用的是官方地址）。
 * 地址本身**不在界面上显示**（用户要求），只由这里的默认值 + 可选覆盖决定。
 *
 * ## 接口形态（实测）
 * - `GET /api/v2/search/episodes?anime=<番剧名>` → `{ animes:[{ animeId, animeTitle, episodes:[{ episodeId, episodeTitle }] }] }`
 * - `GET /api/v2/comment/<episodeId>?withRelated=true` → `{ count, comments:[{ cid, p:"时间,模式,颜色,uid", m:"文本" }] }`
 *   其中 `p` 的时间单位是**秒**，模式 1=滚动 4=底部 5=顶部（其它值按滚动处理）。
 */

/** 默认弹幕接口（已配置 AppId 的反代；界面不展示） */
const DEFAULT_BASE = 'https://danmu-api.sankana-bangumi.de5.net/87654321'
/** 官方地址：仅在用户自己填了 AppId/AppSecret 时使用 */
const OFFICIAL_BASE = 'https://api.dandanplay.net'

const TTL_SEARCH = 24 * 3600 * 1000
const TTL_COMMENTS = 7 * 24 * 3600 * 1000
/** 同一集最多合并多少个来源（弹幕库同一集常有 youku/bilibili/tencent 等多份） */
const MERGE_SOURCES = 3
/** 合并时最多等多久（毫秒）：超时先用已到的来源，慢的来源继续在后台写缓存 */
const MERGE_DEADLINE_MS = 7000
/** 合并后的弹幕条数上限：避免单集几万条撑爆 IPC 与渲染 */
const MAX_COMMENTS = 8000

interface DanmakuKeys {
  appId: string
  appSecret: string
}

function keys(): DanmakuKeys {
  const s = getSettings() as unknown as { danmakuAppId?: string; danmakuAppSecret?: string }
  return { appId: s.danmakuAppId?.trim() ?? '', appSecret: s.danmakuAppSecret?.trim() ?? '' }
}

function signed(): boolean {
  const k = keys()
  return Boolean(k.appId && k.appSecret)
}

function baseUrl(): string {
  const s = getSettings() as unknown as { danmakuApiBase?: string }
  const custom = s.danmakuApiBase?.trim().replace(/\/+$/, '')
  if (custom) return custom
  return signed() ? OFFICIAL_BASE : DEFAULT_BASE
}

/**
 * 当前弹幕接口地址（v0.2.9：给 uosc_danmaku 插件用同一套数据源）。
 * 单独导出是为了让 mpv 那边**不要**再抄一份逻辑 —— 自定义地址、官方地址、反代地址
 * 三者的优先级只在这里定义。
 */
export function danmakuApiBase(): string {
  return baseUrl()
}

function authHeaders(path: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (!signed()) return headers
  const { appId, appSecret } = keys()
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const raw = `${appId}${timestamp}${path}${appSecret}`
  headers['X-AppId'] = appId
  headers['X-Timestamp'] = timestamp
  headers['X-Signature'] = createHash('sha256').update(raw).digest('base64')
  // 版本号统一从 app.getVersion() 取（v0.3.9 体检 L5：以前写死 0.2.8，与 UA 里的版本对不上）
  headers['X-AppVersion'] = app.getVersion()
  return headers
}

async function get<T>(path: string, timeoutMs = 12000): Promise<T> {
  const url = `${baseUrl()}${path}`
  /*
   * 弹幕接口会**限流**（实测并发几个请求就出现 429）。
   * 429 / 5xx 属于一过性错误，隔一会儿重试；其它错误直接抛。
   */
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get<T>(url, {
        timeout: timeoutMs,
        headers: authHeaders(path),
        ...buildProxyAgents(getSettings().proxy)
      })
      return res.data
    } catch (err) {
      lastErr = err
      const status = (err as { response?: { status?: number } })?.response?.status ?? 0
      if (status === 429 || status >= 500) {
        await new Promise((r) => setTimeout(r, 500 + attempt * 700))
        continue
      }
      throw err
    }
  }
  throw lastErr ?? new Error('弹幕接口请求失败')
}

// ---------------- 磁盘缓存 ----------------

function cacheDir(): string {
  const custom = getSettings().cacheDir?.trim()
  const dir = join(custom || join(app.getPath('userData'), 'cache'), 'danmaku')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 写入时报错即可 */
  }
  return dir
}

function readCache<T>(key: string, ttl: number): T | null {
  let file = ''
  try {
    file = join(cacheDir(), `${createHash('sha1').update(key).digest('hex').slice(0, 20)}.json`)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { at: number; data: T }
    /*
     * 过期就**顺手删掉**（v0.3.9 体检 M6）。
     * 以前这里只 `return null`，文件永远留在盘上：看完一季番会攒下成百上千个再也用不到的 JSON，
     * 而缓存目录只增不减（用户不手动清就一直长）。删掉是安全的——过期数据本来就要重新拉。
     */
    if (!parsed?.at || Date.now() - parsed.at > ttl) {
      try {
        unlinkSync(file)
      } catch {
        /* 删不掉（被占用等）不影响使用 */
      }
      return null
    }
    return parsed.data
  } catch {
    return null
  }
}

function writeCache<T>(key: string, data: T): void {
  try {
    const f = join(cacheDir(), `${createHash('sha1').update(key).digest('hex').slice(0, 20)}.json`)
    writeFileSync(f, JSON.stringify({ at: Date.now(), data }), 'utf-8')
  } catch {
    /* 缓存失败不影响使用 */
  }
}

// ---------------- 标题 / 集数匹配 ----------------

/**
 * 归一化番剧名用于比较：去掉括号补充说明、年份、来源后缀、标点与空白，
 * 全角字符转半角。实测弹幕库里的标题形如
 * 「败犬女主太多了！(2024)【动画】from renren」，而应用里的标题是「败犬女主太多了！」。
 */
function normalizeTitle(raw: string): string {
  let s = String(raw ?? '')
  // 全角 → 半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  s = s.replace(/\u3000/g, ' ')
  // 括号内容（中英日）
  s = s.replace(/[（(【\[{][^）)】\]}]*[）)】\]}]/g, '')
  // 来源后缀
  s = s.replace(/\bfrom\b.*$/i, '')
  // 年份
  s = s.replace(/\b(19|20)\d{2}\b/g, '')
  // 季/部等后缀标点
  s = s.replace(/[!！?？~～·・:：,，.。'"“”\-—_/\\|]/g, '')
  return s.replace(/\s+/g, '').toLowerCase()
}

/** 从剧集标题里解析集数：「【renren】 第01集」「EP01」「[01]」「_01」「- 12」 */
export function episodeNumberFromTitle(raw: string): number | null {
  const s = String(raw ?? '')
  const patterns = [
    /第\s*(\d{1,4})\s*[集话話回期彈弹]/,
    /(?:^|[^a-z])(?:ep|episode)\s*\.?\s*(\d{1,4})/i,
    /\[(\d{1,4})\]/,
    // 「葬送的芙莉莲_01」「番剧 - 12」「(5)」这类
    /[_\-–—\s(](\d{1,4})(?:v\d)?\s*(?:$|\.|\[|\(|】|\))/,
    /(\d{1,4})\s*$/
  ]
  for (const re of patterns) {
    const m = re.exec(s)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      if (Number.isFinite(n) && n > 0 && n < 2000) return n
    }
  }
  return null
}

const CN_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
}
const ROMAN_NUM: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10
}

/** 中文/罗马数字转阿拉伯数字（只处理常见写法：二 / 十二 / 二十 / Ⅱ） */
function toNumber(raw: string): number | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (/^\d{1,2}$/.test(s)) return Number.parseInt(s, 10)
  if (ROMAN_NUM[s.toLowerCase()]) return ROMAN_NUM[s.toLowerCase()]
  if (/^[一二两三四五六七八九十]+$/.test(s)) {
    if (s.length === 1) return CN_NUM[s] ?? null
    if (s.startsWith('十')) return 10 + (CN_NUM[s[1]] ?? 0)
    if (s.endsWith('十')) return (CN_NUM[s[0]] ?? 0) * 10
    if (s.includes('十')) {
      const [a, , b] = s.split('')
      return (CN_NUM[a] ?? 0) * 10 + (CN_NUM[b] ?? 0)
    }
  }
  return null
}

/**
 * 从标题里解析「第几季」（v0.2.8 附加四）。
 *
 * 为什么要这个：弹幕库同一部番常按季分开收录，而「番剧名 → 别名 → 简化标题」的降级链
 * 很容易命中**别的季** —— 用户反馈「每一集弹幕都不对、感觉把不同集数搞混了」，
 * 主要就是「第 1 季的条目被用在了第 2/3 季的播放上」。
 * 没有季标记时一律按第 1 季处理（绝大多数单季番就是如此）。
 *
 * 支持：第N季 / 第N期 / 第N部 / 第Nクール / Season N / S02 / 2nd Season / Part N / Ⅱ Ⅲ Ⅳ
 * 注意：`普通话版`、`国配`、`中配` 是同一季的配音版本，不算不同季。
 */
export function seasonOfTitle(raw: string): number {
  const s = String(raw ?? '')
  const patterns = [
    /第\s*([0-9一二两三四五六七八九十]{1,3})\s*[季期部クール]/,
    /(?:season|s)\s*\.?\s*([0-9]{1,2})(?![0-9])/i,
    /([0-9]{1,2})\s*(?:st|nd|rd|th)\s*season/i,
    /part\s*\.?\s*([0-9]{1,2})/i,
    /(?:^|[^a-z0-9])((?:i{1,3}|iv|vi{0,3}|ix|x))(?:[^a-z0-9]|$)/i
  ]
  for (const re of patterns) {
    const m = re.exec(s)
    if (!m) continue
    const n = toNumber(m[1])
    if (n && n >= 1 && n <= 20) return n
  }
  return 1
}

/** 标题里是否**明确**写了季数（用于区分「明确第 1 季」与「完全没写季」） */
export function hasSeasonMark(title: string): boolean {
  return /第\s*[0-9一二两三四五六七八九十]{1,3}\s*[季期クール]|season\s*\.?\s*[0-9]{1,2}|[0-9]{1,2}\s*(?:st|nd|rd|th)\s*season|part\s*\.?\s*[0-9]{1,2}/i.test(
    String(title ?? '')
  )
}

interface SearchAnime {
  animeId: number
  animeTitle: string
  type?: string
  typeDescription?: string
  episodes?: { episodeId: number; episodeTitle: string }[]
  imageUrl?: string
}

const MOVIE_RE = /剧场版|劇場版|电影|電影|total\s*eclipse|总集篇|總集篇|movie|特别篇|特別篇/i

/**
 * 相似度打分：完全一致 > 包含 > 关键词重合，并按「集数是否对得上」做加权。
 *
 * v0.2.8 实测发现的两个坑：
 * - 「孤独摇滚(上)」这类**剧场版**标题归一化后与 TV 版同名，只按标题相似度会选错 →
 *   请求的不是第 1 集时，对「电影/剧场版/只有 1 集」的候选降权；
 * - 弹幕库同一部番有多个来源（bilibili / youku / tencent），集数编排各不相同 →
 *   对「确实存在该集数」的候选加权，优先选能对上集数的来源。
 */
function scoreAnime(title: string, anime: SearchAnime, wantEp = 1): number {
  const q = normalizeTitle(title)
  const t = normalizeTitle(anime.animeTitle)
  if (!q || !t) return 0
  let score = 0
  if (q === t) score = 100
  else if (t.includes(q) || q.includes(t)) score = 60
  else {
    // 关键词重合（按 2-gram 粗略估计，中日文都适用）
    const grams = (s: string): Set<string> => {
      const out = new Set<string>()
      for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
      return out
    }
    const a = grams(q)
    const b = grams(t)
    if (a.size === 0 || b.size === 0) return 0
    let hit = 0
    for (const g of a) if (b.has(g)) hit++
    score = Math.round((hit / a.size) * 50)
  }
  const eps = anime.episodes ?? []
  const hasWanted = eps.some((e) => episodeNumberFromTitle(e.episodeTitle) === wantEp)
  if (hasWanted) score += 25
  if (wantEp > 1) {
    const looksMovie =
      MOVIE_RE.test(anime.animeTitle) ||
      MOVIE_RE.test(anime.typeDescription ?? '') ||
      MOVIE_RE.test(anime.type ?? '')
    if (looksMovie) score -= 45
    if (eps.length <= 1) score -= 25
  }
  return score
}

/**
 * 缓存版本前缀（v0.2.8 附加）。
 * 用户更换了弹幕源（同域名不同路径）—— 加个前缀让旧源落盘的数据不再被命中，
 * 避免「换了源却还是老数据」的困惑。加前缀只影响一次性重新拉取。
 */
const CACHE_V = 'v2'

async function searchEpisodes(title: string, useCache = true): Promise<SearchAnime[]> {
  const cacheKey = `search:${CACHE_V}:${title}`
  if (useCache) {
    const cached = readCache<SearchAnime[]>(cacheKey, TTL_SEARCH)
    if (cached) return cached
  }
  const path = `/api/v2/search/episodes?anime=${encodeURIComponent(title)}`
  const data = await get<{ success?: boolean; animes?: SearchAnime[] }>(path)
  const list = Array.isArray(data?.animes) ? data.animes : []
  if (useCache && list.length > 0) writeCache(cacheKey, list)
  return list
}

/**
 * 从**番剧级**搜索结果里取这部番的别名（用于「别名检测弹幕」）。
 *
 * 实测 `/api/v2/search/anime?keyword=…` 会返回 `aliases`（例如
 * 「败犬女主太多了！」→ `["負けヒロインが多すぎる！"]`），
 * 而 `/search/episodes` 不返回别名 —— 所以别名检测要多走这一个接口。
 * 番剧库（Bangumi）那边的别名由渲染层一并传进来（`opts.aliases`）。
 */
async function searchAnimeAliases(title: string): Promise<string[]> {
  const cacheKey = `aliases:${CACHE_V}:${title}`
  const cached = readCache<string[]>(cacheKey, TTL_SEARCH)
  if (cached) return cached
  try {
    const path = `/api/v2/search/anime?keyword=${encodeURIComponent(title)}`
    const data = await get<{ animes?: { animeTitle?: string; aliases?: string[] }[] }>(path)
    const out: string[] = []
    for (const a of data?.animes ?? []) {
      for (const al of a.aliases ?? []) {
        const s = String(al ?? '').trim()
        if (s && !out.includes(s)) out.push(s)
      }
    }
    if (out.length > 0) writeCache(cacheKey, out)
    return out
  } catch (err) {
    log.append('warn', 'danmaku', `别名查询失败: ${String((err as Error)?.message ?? err)}`)
    return []
  }
}

/**
 * 按「番剧名 + 集数」匹配弹幕库条目（v0.2.8 重做）。
 *
 * 与旧实现的关键差别：**按集数挑剧集，而不是永远取 `episodes[0]`**。
 * 旧实现无论请求第几集都返回第 1 集 —— 那样「切到第 5 集」也会放第 1 集的弹幕。
 */
export async function matchDanmaku(title: string, episode: number): Promise<DanmakuMatch | null> {
  const kw = String(title ?? '').trim()
  if (!kw) return null
  try {
    const animes = await searchEpisodes(kw)
    if (animes.length === 0) {
      log.append('info', 'danmaku', `弹幕库没有搜索结果（${kw}）`)
      return null
    }
    const ranked = animes
      .map((a) => ({ a, score: scoreAnime(kw, a, episode > 0 ? episode : 1) }))
      .sort((x, y) => y.score - x.score)
    // 季数闸门（v0.2.8 附加四）：match 只作辅助接口，同样不允许跨季命中
    const wantSeasonMatch = seasonOfTitle(kw)
    const best = ranked.find((x) => seasonOfTitle(x.a.animeTitle) === wantSeasonMatch) ?? ranked[0]
    const wantEp = Number(episode) > 0 ? Number(episode) : 1
    const pickEpisode = (a: SearchAnime): { episodeId: number; episodeTitle: string } | null => {
      const eps = a.episodes ?? []
      if (eps.length === 0) return null
      // 严格按集数解析（避免编号不从 1 开始时取错集）
      const parsed = eps
        .map((e) => ({ e, n: episodeNumberFromTitle(e.episodeTitle) }))
        .filter((x): x is { e: { episodeId: number; episodeTitle: string }; n: number } => x.n !== null)
      if (parsed.length > 0) return parsed.find((x) => x.n === wantEp)?.e ?? null
      return wantEp <= eps.length ? eps[wantEp - 1] : null
    }
    const ep = pickEpisode(best.a)
    if (!ep) {
      log.append('info', 'danmaku', `弹幕库条目没有可用剧集（${best.a.animeTitle}）`)
      return null
    }
    log.append(
      'info',
      'danmaku',
      `弹幕匹配：${kw} 第${wantEp}集 → ${best.a.animeTitle} / ${ep.episodeTitle}（相似度 ${best.score}）`
    )
    return {
      animeId: best.a.animeId,
      episodeId: ep.episodeId,
      animeTitle: best.a.animeTitle,
      episodeTitle: ep.episodeTitle
    }
  } catch (err) {
    log.append('warn', 'danmaku', `弹幕匹配失败: ${String((err as Error)?.message ?? err)}`)
    throw err
  }
}

/** 拉取某一集的弹幕并解析成统一结构（带 7 天磁盘缓存） */
export async function fetchDanmaku(episodeId: number, useCache = true): Promise<DanmakuComment[]> {
  if (!episodeId) return []
  const cacheKey = `comments:${CACHE_V}:${episodeId}`
  if (useCache) {
    const cached = readCache<DanmakuComment[]>(cacheKey, TTL_COMMENTS)
    if (cached) return cached
  }
  const path = `/api/v2/comment/${episodeId}?withRelated=true&chConvert=0`
  const data = await get<{ comments?: { p?: string; m?: string }[] }>(path, 20000)
  const list = Array.isArray(data?.comments) ? data.comments : []
  const out: DanmakuComment[] = []
  for (const c of list) {
    if (!c?.m) continue
    // p = "出现时间,模式,颜色,用户ID"（时间单位秒，颜色为十进制 RGB）
    const p = String(c.p ?? '').split(',')
    const time = Number.parseFloat(p[0] ?? '0')
    if (!Number.isFinite(time) || time < 0) continue
    const mode = Number.parseInt(p[1] ?? '1', 10)
    const colorDec = Number.parseInt(p[2] ?? '16777215', 10)
    const modeNorm = mode === 4 ? 4 : mode === 5 ? 5 : 1
    out.push({
      time,
      text: c.m,
      mode: modeNorm,
      color: `#${(Number.isFinite(colorDec) ? colorDec : 0xffffff).toString(16).padStart(6, '0')}`
    })
  }
  out.sort((a, b) => a.time - b.time)
  log.append('info', 'danmaku', `拉取弹幕 ${out.length} 条（episodeId=${episodeId}）`)
  if (out.length > 0) writeCache(cacheKey, out)
  return out
}

export interface DanmakuLoadResult extends DanmakuMatch {
  count: number
  comments: DanmakuComment[]
  /** 命中的是本地缓存（未再请求接口） */
  fromCache: boolean
  /** 这次是用哪个关键词匹配上的（别名检测命中时不是原始番剧名） */
  matchedBy?: string
  /** 是否用到了别名（别名检测） */
  aliasUsed?: boolean
  /**
   * v1.1：这批弹幕是哪来的（内置弹弹play / 本地弹幕库 / 某个数据源）。
   *
   * 注意这里与 `@shared/types` 的同名接口是**两份声明**（主进程这份是历史遗留，字段一直
   * 与 shared 保持同步）；渲染层看到的始终是 shared 那份，所以新增字段两边都要加，
   * 否则 tsc 会在主进程这侧的赋值处报「Object literal may only specify known properties」。
   */
  origin?: DanmakuOrigin
  /** v1.1.2：数据源那一路还在跑（渲染层拿到后会再调一次 `sourcesOnly` 合并上来） */
  sourcesPending?: boolean
  /** v1.1.2：本次返回的只有数据源那一批（第二段） */
  sourcesOnly?: boolean
  /** V1.2：这一批由哪些源组成（每个源的原始条数/是否缓存） */
  sources?: DanmakuSourceRunInfo[]
}

export interface DanmakuLoadOptions {
  /** 额外候选关键词（番剧库里的别名 / 原名 / 中文名，由渲染层提供） */
  aliases?: string[]
  /** 别名检测模式：额外找弹幕库自己的别名，并放宽到更多候选条目 */
  aliasMode?: boolean
  /**
   * V1.2：用户手动输入的别名搜索词（播放器「输入别名搜索弹幕」）。
   * 有它时各源优先用它搜索，但缓存仍按原番剧名落盘（同一部番不该缓存成两份）。
   */
  keyword?: string
  /** V1.2：番剧库条目 id（巴哈取日文原名用；没有就按标题反查一次） */
  subjectId?: number
  /** V1.2：绕过本地缓存重新请求（「重新检测弹幕」） */
  force?: boolean
  /**
   * 只要数据源那一路（V1.1.2「两段式加载」的第二段）。
   *
   * 为什么要有它：用户要求「播放器播放之前必须要调用弹幕数据源获取弹幕」，
   * 同时又说「拉取弹幕数据源还是不够快」。这两个要求只能靠**分两段**同时满足：
   *   第一段（快）——本地库/内置库，通常几百毫秒，先让弹幕上屏；
   *   第二段（慢）——已启用的数据源，回来之后**合并**进画面上那一批（见 PlayerPage 的调用处）。
   * 传了这个就跳过本地库与内置，只跑数据源。
   */
  sourcesOnly?: boolean
  /** 这次调用是谁发起的（写进「获取记录」，界面上能分清自动加载与手动测试） */
  trigger?: 'play' | 'test' | 'manual'
}

/** 别名是否有检索价值：太短/太泛的别名会把无关条目搜出来（实测「再见」命中了一部 2018 电视剧） */
function aliasWorthTrying(alias: string, title: string): boolean {
  const a = alias.trim()
  if (!a) return false
  const hasCjk = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(a)
  if (hasCjk ? a.length < 3 : a.length < 5) return false
  if (normalizeTitle(a) === normalizeTitle(title)) return false
  return true
}

/**
 * 一步到位：番剧名 + 集数 → 弹幕列表（v0.2.8 播放器用这个）。
 *
 * 匹配不到时返回 `null`（界面显示「未找到弹幕」而不是报错）。
 *
 * ## 提速要点（v0.2.8 附加）
 * 之前是「番剧名 + 所有别名」一起去搜，实测《无职转生 第三季》第 11 集要搜 5 个关键词、
 * **串行**发 5 次请求再拉弹幕，整条链要 28 秒（用户反馈「弹幕获取太慢」）。
 * 现在分两轮：
 * 1. **只用番剧名**搜一次，命中就立刻拉弹幕（正常情况 = 1 次搜索 + 1 次弹幕请求）；
 * 2. 第 1 轮拿不到弹幕时才用别名（并行搜，且过滤掉过短/过泛的别名）。
 * `opts.aliasMode`（「别名检测弹幕」）直接跳过第 1 轮，两轮关键词一起用。
 */
export async function loadDanmaku(
  title: string,
  episode: number,
  opts: DanmakuLoadOptions = {}
): Promise<DanmakuLoadResult | null> {
  /*
   * 单飞去重：同一「番剧名 + 集数」的并发加载只跑一轮。
   * 实测播放页挂载 + 预取会几乎同时发起两次相同请求（日志里能看到两条一样的「拉取弹幕 N 条」），
   * 既浪费接口配额也拖慢出弹幕。
   */
  const flightKey = [
    title,
    episode,
    opts.aliasMode ? 'alias' : 'plain',
    opts.sourcesOnly ? 'sources' : 'full',
    opts.force ? 'force' : 'cache',
    opts.keyword ?? '',
    opts.subjectId ?? ''
  ].join('|')
  const running = inflightLoad.get(flightKey)
  if (running) return await running
  const task = loadWithSources(title, episode, opts).finally(() => {
    inflightLoad.delete(flightKey)
  })
  inflightLoad.set(flightKey, task)
  return await task
}

/**
 * v1.1：在「内置弹弹play」之外，接上**本地弹幕库**与**数据源集合器**。
 *
 * 顺序（用户要求「已有源仍作为默认源，启用的数据源按优先级依次尝试」）：
 *   1. **本地弹幕库**：以前从数据源下载下来的弹幕，离线立刻命中，不发任何请求；
 *   2. **内置弹弹play**：原有的整条链（严格季集闸门 + 多来源合并 + 缓存）**一行没改**；
 *   3. **已启用的数据源**（按 priority）：巴哈姆特 / 弹幕盒子 / 直链，
 *      拿到之后**顺手存进本地弹幕库**，下次播放直接命中第 1 步。
 *
 * 为什么包在外层而不是改进 `loadDanmakuInner`：那里面是 v0.2.8 好不容易调稳的季集判定与
 * 合并逻辑，动它的风险远大于收益；外层包装能做到「内置源行为完全不变」。
 */
/**
 * 「数据源那一路最多等多久」——见 loadWithSources 里的说明（V1.1.1）。
 * 8 秒是权衡：内置库通常几百毫秒就回来了，弹幕盒子那种要下整包索引的源十几秒都有可能，
 * 不能让最慢的源决定弹幕什么时候出现。
 */
const SOURCES_WAIT_MS = 8000

/**
 * V1.2：内置弹弹play 在缓存里的来源名。
 * 它也是"第三层缓存"的一员：命中它就不再请求内置接口（第二次进同一集网络请求为 0 的关键）。
 */
const BUILTIN_SOURCE_NAME = '内置弹弹play'

/** 把集成结果包装成渲染层用的 DanmakuLoadResult（多个入口共用，字段口径只在这里定义） */
function resultOfIntegration(
  integ: ReturnType<typeof integrateDanmaku>,
  input: { title: string; episode: number; matchedBy?: string; aliasUsed?: boolean },
  extra: Partial<DanmakuLoadResult> = {}
): DanmakuLoadResult | null {
  if (integ.comments.length === 0) return null
  return {
    animeId: 0,
    episodeId: 0,
    animeTitle: input.title,
    episodeTitle: `第${input.episode}集`,
    count: integ.count,
    comments: integ.comments,
    fromCache: integ.fromCache,
    matchedBy: input.matchedBy ?? input.title,
    aliasUsed: input.aliasUsed === true,
    origin: integ.primary ?? undefined,
    sources: integ.sources,
    ...extra
  }
}

/**
 * 第二段：等待「补全任务」（内置 + 已启用的数据源）。
 *
 * V1.2 起第二段**不再自己起一条链**：第一段已经用 `startSupplement` 把任务发起了，
 * 这里直接 await 同一个 Promise（键相同 → 不会重复请求）。这样"数据源一定会被调用"
 * 是结构上的保证，而不是靠渲染层是否记得再调一次。
 *
 * 返回值只用于**合并**：渲染层拿到后与原弹幕按「时间+正文」去重，不会替换。
 */
async function loadSourcesOnly(
  kw: string,
  episode: number,
  opts: DanmakuLoadOptions
): Promise<DanmakuLoadResult | null> {
  if (getSettings().danmaku?.autoSources === false) return null
  const trigger = opts.trigger ?? 'play'
  const job = startSupplement(kw, episode, opts, true)
  if (!job) return null
  const r = await job.catch(() => null)
  if (!r || r.batches.length === 0) return null
  const integ = integrateDanmaku(r.batches, { toleranceMs: toleranceMsOfSettings() })
  return resultOfIntegration(integ, { title: kw, episode, matchedBy: opts.keyword || kw }, { sourcesOnly: true })
}

/** 当前设置里的去重容差（「弹幕误差」） */
function toleranceMsOfSettings(): number {
  return resolveDanmakuSettings(getSettings().danmaku).errorToleranceMs ?? 100
}


async function loadWithSources(
  title: string,
  episode: number,
  opts: DanmakuLoadOptions = {}
): Promise<DanmakuLoadResult | null> {
  const kw = String(title ?? '').trim()
  if (!kw) return null

  /*
   * 第二段（`sourcesOnly`）必须**排在缓存前面**。
   *
   * 踩过一次：原来这段写在本地库之后，于是"第二段"直接命中了本地库、把整份缓存又返回了一遍 ——
   * 表面上条数对得上（看起来像成功了），实际上**数据源一次都没被问到**，
   * 获取记录里也是空的。用户要的正是"数据源必须真的被调用"，所以这里必须先分流。
   */
  if (opts.sourcesOnly) return await loadSourcesOnly(kw, episode, opts)

  progressBegin(kw, episode)
  const settings = resolveDanmakuSettings(getSettings().danmaku)
  const autoSources = settings.autoSources !== false
  const toleranceMs = settings.errorToleranceMs ?? 100
  const force = opts.force === true
  // 关掉自动源时，缓存/补全都只针对内置库（用户明确不想发源请求）
  const bindings = autoSources ? enabledFetchers() : []

  // 1) 本地缓存：每个启用的源各查各的（文件名带源名，互不混淆）+ 内置那一份
  const cachedExternal = force
    ? { batches: [] as DanmakuBatch[], missing: bindings }
    : readCachedBatches(kw, episode, bindings)
  const builtinCached = force ? null : readCachedSource(kw, episode, BUILTIN_SOURCE_NAME)
  const cachedBatches: DanmakuBatch[] = [...cachedExternal.batches]
  if (builtinCached) {
    progressDone('builtin', BUILTIN_SOURCE_NAME, 1, 1, `本地缓存命中（${builtinCached.comments.length} 条，未发网络请求）`)
    cachedBatches.push({
      sourceId: 'builtin',
      sourceName: BUILTIN_SOURCE_NAME,
      comments: builtinCached.comments,
      fromCache: true,
      detail: `本地缓存 ${builtinCached.relPath}（未发网络请求）`,
      entryName: builtinCached.item.title,
      kind: 'builtin'
    })
  }
  const allCached = cachedExternal.missing.length === 0 && Boolean(builtinCached)

  /*
   * 2) 有缓存 → 立刻返回（用户要求「当前集有本地缓存就直接用，不重新加载」）。
   *
   * 后台任务只补**缺的那部分**：缓存已经齐全时连任务都不发，第二次进同一集网络请求为 0。
   * 还有缺失时发一条 `sourcesPending`，渲染层按两段式去取第二段（外部行为保持不变）。
   */
  if (cachedBatches.length > 0) {
    const missingNames = cachedExternal.missing.map((b) => b.name)
    /*
     * 已经有任意缓存时**不再为了内置库发网络请求**：
     * 用户要的是"当前集有本地缓存就直接用，不重新加载"。内置库上一轮没取到就让它留在缺省，
     * 不能因为"内置还没缓存"就让第二次进同一集又发一次请求（那正好违背用户点名的证据）。
     * 只有"一点缓存都没有"的首轮才同时跑内置与数据源。
     */
    const needBuiltin = !builtinCached && cachedExternal.batches.length === 0
    const job =
      allCached || (missingNames.length === 0 && !needBuiltin)
        ? null
        : startSupplement(kw, episode, opts, autoSources, missingNames, needBuiltin)
    const integ = integrateDanmaku(cachedBatches, { toleranceMs })
    return resultOfIntegration(
      integ,
      {
        title: kw,
        episode,
        matchedBy: opts.keyword || kw,
        aliasUsed: Boolean(opts.keyword && normalizeTitle(opts.keyword) !== normalizeTitle(kw))
      },
      // fromCache 说的是"这一批是不是全来自缓存"，不是"所有源都缓存了没"：
      // 有源缺缓存时这批仍是缓存（同时 sourcesPending=true，第二段会补）
      { sourcesPending: Boolean(job), fromCache: integ.fromCache }
    )
  }

  /*
   * 3) 一点缓存都没有：必须等（用户要求「除非从数据源获取不到」）。
   *    内置与数据源是并行的，谁先回来都算数；全部失败才返回 null。
   */
  const job = startSupplement(
    kw,
    episode,
    opts,
    autoSources,
    cachedExternal.missing.map((b) => b.name),
    true
  )
  if (!job) {
    log.append('info', 'danmaku', '没有启用的数据源，也没有内置缓存')
    return null
  }
  const r = await job.catch(() => null)
  if (!r || r.batches.length === 0) {
    log.append('info', 'danmaku', `内置与数据源都没有取到弹幕${r?.errors?.length ? `（${r.errors.slice(0, 3).join('；')}）` : ''}`)
    return null
  }
  const integ = integrateDanmaku(r.batches, { toleranceMs })
  return resultOfIntegration(
    integ,
    {
      title: kw,
      episode,
      matchedBy: opts.keyword || kw,
      aliasUsed: Boolean(opts.keyword && normalizeTitle(opts.keyword) !== normalizeTitle(kw))
    },
    { sourcesPending: false }
  )
}

/**
 * 「补全任务」：并行跑内置弹弹play 与已启用的获取器。
 *
 * V1.2 把"内置"也收进任务里，是为了让**任何**缺失都能在第二段补上：
 *   · 只有外部源缓存、内置没缓存时，第二段仍会把内置那份补进来；
 *   · 只有内置缓存、外部源没缓存时，第二段补外部源；
 *   · 两边都有缓存时第一段直接返回，任务根本不会创建（网络请求为 0）。
 *
 * 第一段与第二段共用同一个 Promise（键 = 标题+集+别名+关键词+是否强制），
 * 所以"数据源一定会被调用"不依赖渲染层是否记得再问一次。
 */
interface SupplementResult {
  batches: DanmakuBatch[]
  errors: string[]
}

const inflightSupplement = new Map<string, Promise<SupplementResult>>()

function supplementKey(kw: string, episode: number, opts: DanmakuLoadOptions, includeSources: boolean): string {
  return [
    kw,
    episode,
    opts.aliases?.join(',') ?? '',
    opts.keyword ?? '',
    opts.subjectId ?? '',
    opts.force ? 'force' : 'cache',
    includeSources ? 'sources' : 'builtin-only'
  ].join('|')
}

function startSupplement(
  kw: string,
  episode: number,
  opts: DanmakuLoadOptions,
  includeSources: boolean,
  missingNames: string[] = [],
  includeBuiltin = true
): Promise<SupplementResult> | null {
  const key = supplementKey(kw, episode, opts, includeSources)
  const cur = inflightSupplement.get(key)
  if (cur) return cur
  const p = runSupplement(kw, episode, opts, includeSources, missingNames, includeBuiltin).finally(() => {
    // 结果保留 60 秒：第二段通常几秒内就来取，过期后重跑也不会拿到旧数据
    setTimeout(() => inflightSupplement.delete(key), 60000)
  })
  inflightSupplement.set(key, p)
  return p
}

/**
 * 内置库最多等多久（毫秒）。
 *
 * 为什么不让它拖住数据源：内置弹弹play 在反代不可用时单次搜索能超时 12~24 秒，
 * 而巴哈 2~3 秒就能回。如果第二段必须等内置跑完，用户看到的"数据源弹幕"会被拖到几十秒后。
 * 超时后内置继续在后台跑（跑完仍会写缓存，下次播放直接命中），本次结果先用已到的源。
 */
const BUILTIN_WAIT_MS = 6000

/**
 * 数据源那一路最多等多久（毫秒）。
 *
 * 用户的原话是「拉取弹幕数据源还是不够快」。实测（真机日志）第一段冷启动要 17.7 秒，
 * 根因就是下面 `await externalP` **完全没有上限** —— 内置那一路有 `BUILTIN_WAIT_MS` 兜着，
 * 数据源这一路却要等所有源**全跑完**才返回（弹幕盒子要整包下索引，慢起来十几秒）。
 *
 * 所以这里也给一个上限：到点先用已经拿到的批次返回，没跑完的源继续在后台跑，
 * 跑完照旧写缓存，下次进同一集直接命中 —— 与内置那一路的处理保持一致。
 * 这不违背"播放前必须调用数据源"：请求在任务开始时就发出了，这里限制的只是**等它多久**。
 */
const EXTERNAL_WAIT_MS = 8000

async function runSupplement(
  kw: string,
  episode: number,
  opts: DanmakuLoadOptions,
  includeSources: boolean,
  missingNames: string[],
  includeBuiltin: boolean
): Promise<SupplementResult> {
  const errors: string[] = []
  const builtinP = includeBuiltin
    ? loadBuiltinBatch(kw, episode, opts).catch((err): null => {
        errors.push(`内置弹弹play：${String((err as Error)?.message ?? err)}`)
        return null
      })
    : Promise.resolve(null)
  const externalP = (
    includeSources
      ? runEnabledSources({
          title: kw,
          episode,
          aliases: opts.aliases ?? [],
          keyword: opts.keyword,
          subjectId: opts.subjectId,
          force: opts.force,
          missingSourceNames: missingNames,
          trigger: opts.trigger ?? 'play'
        })
      : Promise.resolve({ batches: [] as DanmakuBatch[], errors: [] as string[], cacheHits: 0 })
  ).catch((err) => {
    errors.push(`数据源：${String((err as Error)?.message ?? err)}`)
    return { batches: [] as DanmakuBatch[], errors: [] as string[], cacheHits: 0 }
  })

  const external = await Promise.race([
    externalP,
    new Promise<{ batches: DanmakuBatch[]; errors: string[]; cacheHits: number }>((resolve) =>
      setTimeout(
        () =>
          resolve({
            batches: [] as DanmakuBatch[],
            errors: [`数据源超过 ${EXTERNAL_WAIT_MS / 1000} 秒还没全回，本次先用已到的（后台继续跑并写缓存）`],
            cacheHits: 0
          }),
        EXTERNAL_WAIT_MS
      )
    )
  ])
  // 内置最多等 BUILTIN_WAIT_MS；超时后它继续在后台跑（结果仍会落缓存）
  const builtin = await Promise.race([
    builtinP,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), BUILTIN_WAIT_MS))
  ])
  const batches: DanmakuBatch[] = []
  if (builtin) batches.push(builtin)
  batches.push(...external.batches)
  errors.push(...external.errors)
  return { batches, errors }
}

/**
 * 内置弹弹play 这一批：先查缓存，没有再走原来的完整匹配链（季集闸门 + 同集多来源合并）。
 * 命中缓存时也发一条「已完成」进度，详情面板能看到"第 1/1 步：本地缓存"。
 */
async function loadBuiltinBatch(
  kw: string,
  episode: number,
  opts: DanmakuLoadOptions
): Promise<DanmakuBatch | null> {
  if (opts.force !== true) {
    const hit = readCachedSource(kw, episode, BUILTIN_SOURCE_NAME)
    if (hit) {
      progressDone('builtin', BUILTIN_SOURCE_NAME, 1, 1, `内置弹弹play 命中本地缓存（${hit.comments.length} 条）`)
      return {
        sourceId: 'builtin',
        sourceName: BUILTIN_SOURCE_NAME,
        comments: hit.comments,
        fromCache: true,
        detail: `本地缓存 ${hit.relPath}（未发网络请求）`,
        entryName: hit.item.title,
        kind: 'builtin'
      }
    }
  }
  progressStep('builtin', BUILTIN_SOURCE_NAME, 1, 2, '正在匹配内置弹弹play 弹幕库…')
  noteNetworkFetch()
  let r: DanmakuLoadResult | null
  try {
    r = await loadDanmakuInner(kw, episode, opts)
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    progressFail('builtin', BUILTIN_SOURCE_NAME, 1, 2, '内置弹弹play 取弹幕失败', msg)
    throw err
  }
  if (!r || r.comments.length === 0) {
    progressFail('builtin', BUILTIN_SOURCE_NAME, 2, 2, '内置弹弹play 没有匹配到弹幕', '该番剧/集在弹弹play 弹幕库里没有条目')
    return null
  }
  progressStep('builtin', BUILTIN_SOURCE_NAME, 2, 2, `正在写入内置弹幕缓存（${r.comments.length} 条）…`)
  const saved = writeCachedSource({
    title: kw,
    episode,
    sourceId: 'builtin',
    sourceName: BUILTIN_SOURCE_NAME,
    origin: `${r.animeTitle} · ${r.episodeTitle}`,
    comments: r.comments
  })
  progressDone('builtin', BUILTIN_SOURCE_NAME, 2, 2, `内置弹弹play 取到 ${r.comments.length} 条`)
  return {
    sourceId: 'builtin',
    sourceName: BUILTIN_SOURCE_NAME,
    comments: r.comments,
    fromCache: false,
    detail: `${r.animeTitle} · ${r.episodeTitle}${saved ? ` → ${saved.file.replace(/\\/g, '/')}` : ''}`,
    entryName: r.animeTitle,
    kind: 'builtin'
  }
}

async function loadDanmakuInner(
  title: string,
  episode: number,
  opts: DanmakuLoadOptions = {}
): Promise<DanmakuLoadResult | null> {
  const kw = String(title ?? '').trim()
  if (!kw) return null
  /*
   * 注意顺序（v0.2.8 修）：`wantEp` 必须**先声明**再用 ——
   * 排序时就要用它做「该条目有没有这一集」的加权，
   * 写成「先排序、后声明」会直接抛 `ReferenceError: Cannot access 'wantEp' before initialization`，
   * 表现是每次调用都返回失败、界面永久显示「未找到弹幕」。
   */
  const wantEp = Number(episode) > 0 ? Number(episode) : 1
  /** 当前播放的是第几季（从番剧名解析；没写季标记就是第 1 季）—— 严格筛选用 */
  const wantSeason = seasonOfTitle(kw)

  /** 搜索若干关键词（并行 + 各自缓存），合并候选：同一 animeId 取最高分并记住来源关键词 */
  const collect = async (queries: string[]): Promise<{ a: SearchAnime; score: number; by: string }[]> => {
    const results = await Promise.all(
      queries.map(async (q) => {
        try {
          return { q, list: await searchEpisodes(q, opts.force !== true) }
        } catch (err) {
          log.append('warn', 'danmaku', `弹幕搜索失败（${q}）: ${String((err as Error)?.message ?? err)}`)
          return { q, list: [] as SearchAnime[] }
        }
      })
    )
    const merged = new Map<number, { a: SearchAnime; score: number; by: string }>()
    for (const { q, list } of results) {
      for (const a of list) {
        // 打分以原始番剧名为准；别名带来的候选额外用该别名兜一次底
        const score = Math.max(scoreAnime(kw, a, wantEp), scoreAnime(q, a, wantEp) - 5)
        const prev = merged.get(a.animeId)
        if (!prev || score > prev.score) merged.set(a.animeId, { a, score, by: q })
      }
    }
    return [...merged.values()].sort((x, y) => y.score - x.score)
  }

  /**
   * 收集该集的候选来源并**合并弹幕**（v0.2.8 附加三）。
   *
   * 为什么必须合并：弹幕库同一集往往有多个来源条目，条数差得非常多 ——
   * 实测《葬送的芙莉莲》第 1 集：youku 1838 条、**bilibili 6619 条**、tencent 1638 条。
   * 过去只取「评分最高」的那一个，于是永远只看到其中一份（用户反馈「弹幕数量太少」）。
   * 现在按排名取前 `MERGE_SOURCES` 个**不同 episodeId** 的来源并行拉取，
   * 按「出现时间 + 文本」去重合并，得到该集能拿到的全集。
   *
   * 去重键用 `时间(0.1 秒精度)+文本`：不同来源的同一条弹幕时间会有零点几秒偏差，
   * 完全按精确时间会去不掉重复。
   */
  const takeBest = async (
    ranked: { a: SearchAnime; score: number; by: string }[],
    limit: number,
    aliasRound: boolean
  ): Promise<DanmakuLoadResult | null> => {
    const targets: { a: SearchAnime; ep: { episodeId: number; episodeTitle: string }; by: string }[] = []
    const seenEp = new Set<number>()
    /*
     * 严格的「季 + 集」闸门（v0.2.8 附加四，用户要求）。
     *
     * 用户反馈「每一集弹幕都不对，感觉把不同集数搞混了」—— 根因是降级链（番剧名 → 别名 → 简化标题）
     * 会命中**别的季**的条目（例如第 2/3 季的播放用了第 1 季的弹幕），
     * 以及「按序号取第 N 集」这种在编号不从 1 开始、或把两季合并编号的条目上会取错集。
     *
     * 现在：
     * 1. 条目季数必须等于当前播放的季数（从标题解析，两边都没写就是第 1 季）；
     * 2. 必须能在该条目里**按集数解析出同一集**（`第N集/第N话/EP N/[N]/_NN`）才采用；
     *    只有整条条目的剧集名都解析不出集数时，才退回按序号取（并记日志）。
     * 宁可显示「未找到弹幕」，也不放别的季/别的集的弹幕进来。
     */
    const skipped: string[] = []
    for (const { a, by, score } of ranked.slice(0, limit)) {
      // 别名轮里，分数太低的候选取信度不足（容易命中同名无关条目），直接跳过
      if (aliasRound && score < 40) continue
      if (seasonOfTitle(a.animeTitle) !== wantSeason) {
        skipped.push(`季数不符「${a.animeTitle.slice(0, 24)}」(第${seasonOfTitle(a.animeTitle)}季)`)
        continue
      }
      const eps = a.episodes ?? []
      if (eps.length === 0) continue
      const parsed = eps
        .map((e) => ({ e, n: episodeNumberFromTitle(e.episodeTitle) }))
        .filter((x): x is { e: { episodeId: number; episodeTitle: string }; n: number } => x.n !== null)
      let ep: { episodeId: number; episodeTitle: string } | undefined
      if (parsed.length > 0) {
        ep = parsed.find((x) => x.n === wantEp)?.e
        if (!ep) {
          skipped.push(`「${a.animeTitle.slice(0, 20)}」没有第 ${wantEp} 集（共 ${eps.length} 集）`)
          continue
        }
      } else {
        // 整条条目都解析不出集数（罕见）：按序号取，并在日志里标明
        ep = wantEp <= eps.length ? eps[wantEp - 1] : undefined
        if (!ep) continue
        log.append(
          'warn',
          'danmaku',
          `该来源剧集名解析不出集数，按序号取第 ${wantEp} 集：${a.animeTitle.slice(0, 30)}`
        )
      }
      if (seenEp.has(ep.episodeId)) continue
      seenEp.add(ep.episodeId)
      targets.push({ a, ep, by })
      if (targets.length >= MERGE_SOURCES) break
    }
    if (skipped.length > 0) {
      log.append('info', 'danmaku', `严格筛选：第${wantSeason}季第${wantEp}集，排除 ${skipped.length} 个候选（${skipped.slice(0, 3).join('；')}）`)
    }
    if (targets.length === 0) return null

    // 第一个来源是否为缓存命中（用于 fromCache 展示；force 时不看缓存）
    const primaryCached = opts.force !== true && Boolean(
      readCache<DanmakuComment[]>(`comments:${CACHE_V}:${targets[0].ep.episodeId}`, TTL_COMMENTS)
    )

    const settled = await Promise.allSettled(
      targets.map(async (t) => {
        /*
         * 软截止：最多等 MERGE_DEADLINE_MS，超时就先用已到的来源（没等到的继续在后台跑、
         * 结果仍会写进缓存，下次打开或预取就能用上）。
         * 不加这个的话，只要有一个来源很慢（实测 youku 有时要 8 秒以上），
         * 合并就会把首次出弹幕的时间拖到十几秒。
         */
        return await Promise.race([
          fetchDanmaku(t.ep.episodeId, opts.force !== true),
          new Promise<DanmakuComment[]>((resolve) => setTimeout(() => resolve([]), MERGE_DEADLINE_MS))
        ])
      })
    )
    const parts: { title: string; count: number; comments: DanmakuComment[] }[] = []
    settled.forEach((res, i) => {
      const t = targets[i]
      if (res.status === 'fulfilled' && res.value.length > 0) {
        parts.push({ title: t.ep.episodeTitle, count: res.value.length, comments: res.value })
      } else if (res.status === 'rejected') {
        log.append(
          'warn',
          'danmaku',
          `弹幕拉取失败（episodeId=${t.ep.episodeId}）: ${String((res.reason as Error)?.message ?? res.reason)}`
        )
      }
    })
    if (parts.length === 0) return null

    /*
     * 合并去重（V1.2：改走唯一的集成器入口）。
     * 同一集在弹幕库里常有 youku/bilibili/tencent 多份，条数差很多；这里仍按
     * 「时间 + 正文」去重后按时间排序 —— 与播放器看到的最终时间轴是同一套算法。
     */
    const integrated = integrateDanmaku(
      parts.map((p) => ({
        sourceId: 'builtin',
        sourceName: '内置弹弹play',
        comments: p.comments,
        detail: p.title,
        kind: 'builtin' as const
      })),
      { maxComments: MAX_COMMENTS, toleranceMs: toleranceMsOfSettings() }
    )
    const comments = integrated.comments
    const primary = targets[0]
    const aliasUsed = normalizeTitle(primary.by) !== normalizeTitle(kw)
    if (aliasUsed) log.append('info', 'danmaku', `别名命中：用「${primary.by}」匹配到 ${primary.a.animeTitle}`)
    log.append(
      'info',
      'danmaku',
      `弹幕合并 ${parts.length} 个来源（${parts.map((p) => `${p.title.split('】').pop() ?? p.title}:${p.count}`).join(' + ')}）` +
        ` → 去重后 ${comments.length} 条`
    )
    return {
      animeId: primary.a.animeId,
      episodeId: primary.ep.episodeId,
      animeTitle: primary.a.animeTitle,
      episodeTitle: primary.ep.episodeTitle,
      count: comments.length,
      comments,
      fromCache: primaryCached,
      matchedBy: primary.by,
      aliasUsed
    }
  }
  const takeFirst = takeBest

  const providedAliases = (opts.aliases ?? []).filter((a) => aliasWorthTrying(a, kw))

  // 第 1 轮：只用番剧名（最快；别名模式下跳过，因为用户明确要按别名找一遍）
  if (!opts.aliasMode) {
    const t0 = Date.now()
    const ranked = await collect([kw])
    const hit = await takeFirst(ranked, 3, false)
    if (hit) {
      log.append('info', 'danmaku', `弹幕命中（按番剧名，用时 ${Date.now() - t0}ms，共 ${hit.count} 条）`)
      return hit
    }
  }

  // 第 2 轮：别名（渲染层给的番剧库别名 + 别名模式下弹幕库自己的别名），并行搜
  const queries: string[] = [...providedAliases]
  if (opts.aliasMode) {
    for (const a of await searchAnimeAliases(kw)) {
      if (aliasWorthTrying(a, kw) && !queries.includes(a)) queries.push(a)
    }
  }
  if (queries.length > 0) {
    log.append('info', 'danmaku', `按别名再搜一轮（${queries.length} 个关键词）：${queries.slice(0, 4).join(' / ')}`)
    const rankedAlias = await collect([kw, ...queries])
    const hit = await takeFirst(rankedAlias, opts.aliasMode ? 6 : 3, true)
    if (hit) return hit
  }

  /*
   * 第 3 轮：把「装饰性部分」去掉再搜一次。
   * 实测不少条目的应用标题带了副标题/括号补充（`无职转生 第三季 ～到了异世界就拿出真本事～`），
   * 弹幕库里只按主标题收录，直接搜会 0 条。
   * 注意**不动**季数标记：把第 3 季匹配到第 2 季的弹幕是错的（内容对不上），宁可显示未找到。
   */
  const simplified = simplifyTitle(kw)
  if (simplified && !queries.includes(simplified)) {
    log.append('info', 'danmaku', `按简化标题再搜一轮：${simplified}`)
    const rankedSimp = await collect([simplified])
    const hit = await takeFirst(rankedSimp, 3, true)
    if (hit) return hit
  }
  log.append('info', 'danmaku', `弹幕库没有可用条目（${kw} 第${wantEp}集）`)
  return null
}

/**
 * 去掉「装饰性部分」**与季标记**，只用于第 3 轮的**搜索**（季数正确性由严格闸门把关）。
 *
 * 例：`葬送的芙莉莲 第二季 ～到了异世界…～` → `葬送的芙莉莲`
 * （弹幕库里第 2 季的条目可能写成别的标题，去掉季标记更容易把它搜出来；
 *   万一搜出来的是第 1 季的条目，`takeBest` 的季数闸门会把它排除，不会串季。）
 */
function simplifyTitle(title: string): string | null {
  let s = String(title ?? '')
  s = s.replace(/[～~][^～~]{1,60}[～~]/g, ' ')
  s = s.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ' ')
  s = s.replace(/\bfrom\b.*$/i, '')
  if (hasSeasonMark(s)) {
    s = s
      .replace(/第\s*[0-9一二两三四五六七八九十]{1,3}\s*[季期部クール]/g, ' ')
      .replace(/(?:season|s)\s*\.?\s*[0-9]{1,2}(?![0-9])/gi, ' ')
      .replace(/[0-9]{1,2}\s*(?:st|nd|rd|th)\s*season/gi, ' ')
      .replace(/part\s*\.?\s*[0-9]{1,2}/gi, ' ')
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s && s !== title.trim() ? s : null
}

/** 正在进行的弹幕加载（同一「番剧名+集数」并发只发一轮请求） */
const inflightLoad = new Map<string, Promise<DanmakuLoadResult | null>>()

/* ─────────────────── 弹幕出口：交给 mpv 的 uosc_danmaku 插件（v0.2.9） ─────────────────── */

/** XML 文本转义（弹幕内容里出现 `&`、`<`、`>` 的概率不低，不转义会让插件解析出错） */
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 把弹幕写成 B 站格式的 XML，供 mpv 的 uosc_danmaku 插件作为**本地弹幕源**加载。
 *
 * 为什么走这条路而不是让插件自己去请求：
 * 应用侧已经做完了「严格第几季+第几集」判定与同集多来源合并（弹幕更全、不会串集），
 * 直接复用这份数据，两个渲染器（内置画布 / mpv 插件）看到的才是**同一份弹幕**。
 *
 * 格式（插件 `parse_xml_danmaku` 的解析规则，实测要求前 4 个字段都能被 tonumber 解析）：
 * `<d p="时间秒,模式(1滚动/4底部/5顶部),字号,颜色十进制">文本</d>`
 */
export function writeDanmakuXml(comments: DanmakuComment[], key: string): string {
  const dir = join(app.getPath('userData'), 'tmp', 'danmaku')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录已存在或不可写，下面写文件时会失败并返回空串 */
  }
  const file = join(dir, `uosc-${createHash('md5').update(key).digest('hex').slice(0, 12)}.xml`)
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<i>']
  for (const c of comments) {
    const mode = c.mode === 4 || c.mode === 5 ? c.mode : 1
    // 应用内的颜色是 `#rrggbb` 字符串，XML 里要十进制 RGB
    const parsed = Number.parseInt(String(c.color ?? '').replace('#', ''), 16)
    const color = Number.isFinite(parsed) ? Math.max(0, Math.min(0xffffff, parsed)) : 0xffffff
    lines.push(
      `<d p="${c.time.toFixed(2)},${mode},25,${color},0,0,0,0">${xmlEscape(String(c.text ?? '').replace(/[\u0000-\u001f]/g, ''))}</d>`
    )
  }
  lines.push('</i>')
  try {
    writeFileSync(file, lines.join('\n'), 'utf8')
    return file
  } catch (err) {
    log.append('warn', 'danmaku', `写弹幕 XML 失败: ${String((err as Error)?.message ?? err)}`)
    return ''
  }
}

/**
 * 预取弹幕（v0.2.8 附加：从规则页进入播放、以及切集时提前把弹幕准备好）。
 *
 * 与 `loadDanmaku` 共用同一套缓存与单飞：播放器真正要弹幕时通常已经命中缓存，几乎零等待。
 */
export async function prefetchDanmaku(
  title: string,
  episode: number,
  opts: DanmakuLoadOptions = {}
): Promise<{ ok: boolean; count: number; cached: boolean }> {
  const r = await loadDanmaku(title, episode, opts)
  return { ok: Boolean(r), count: r?.count ?? 0, cached: r?.fromCache ?? false }
}

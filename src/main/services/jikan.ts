import axios, { type AxiosRequestConfig } from 'axios'
import { log } from '../log'
import { buildProxyAgents, getSettings } from '../net'

/**
 * Jikan API（MyAnimeList 非官方接口，v0.3.0 新增；v0.3.2 大修）。
 *
 * 用途（用户要求）：
 *   ① 「最XX的角色 9宫格」的**角色立绘数据源**可切换成 Jikan —— 为了更清晰的立绘
 *      （Bangumi 的角色图不少只有 250x300，而 MAL 那边常是 350x500 以上的原图）；
 *   ② 作为**高优先级备用数据源**：反代地址失效时，搜索/番剧表/季度列表从 Jikan 拿。
 *
 * 接口与限制（官方文档 https://docs.api.jikan.moe/）：
 *   · 所有请求都以 `https://api.jikan.moe/v4` 开头；
 *   · 速率限制 **3 次/秒、60 次/分钟** —— 超了会返回 429 甚至临时封禁，
 *     所以这里做了一个**滑动窗口节流器 + 串行队列**，所有请求都必须经过它。
 *
 * v0.3.2 的三处关键事实（都是**实测**出来的，见 .e2e/probe-jikan-raw*.log）：
 *   ① `GET /anime?q=`、`GET /seasons/now`、`GET /anime/{id}`、`GET /anime/{id}/characters`
 *      当前**大面积返回 504**（响应体是 `Jikan failed to connect to MyAnimeList`，
 *      即 Jikan 自己连不上 MAL 上游，不是我们被封）；只有 `GET /anime/{id}/full` 实测 200。
 *      所以：按标题定位条目**不能**只靠 `/anime?q=`，必须有一条不依赖它的路（见下面的 AniList）；
 *      取详情优先 `/full`（同一个 `data` 结构 + 更多字段）。
 *   ② 因此所有包装函数都**必须能说出失败原因**（`reason`），不能再静默返回空数组 ——
 *      否则界面只能显示「Jikan 没取到」，用户永远不知道到底是限流、上游挂还是标题没匹配上。
 *   ③ 详细端点一挂，「标题 → MAL id → 角色」这条链整条断，所以角色也有了 AniList 兜底
 *      （AniList 的 GraphQL 公开、无需 key，实测 200）。
 *
 * 为什么自己写节流而不是装库：需求就两条硬限制，自己写 30 行更可控，也少一个依赖。
 *
 * ⚠️ 走用户代理设置：MAL / Jikan 在国内通常直连不通，必须和 bangumi 一样应用设置里的代理
 * （`buildProxyAgents(getSettings().proxy)`，与应用其它 HTTP 出口保持一致）；关着代理时是空对象。
 */

const JIKAN_BASE = 'https://api.jikan.moe/v4'
const UA = 'Sakana/0.3.0 (https://github.com/rewxz1999/Sakana.app)'

/** 每秒最多 3 次 */
const PER_SECOND = 3
/** 每分钟最多 60 次 */
const PER_MINUTE = 60
/** 默认超时：Jikan 正常情况下响应很快（实测 300~600ms），15 秒只留给上游真的卡住时 */
const DEFAULT_TIMEOUT = 15000
/**
 * 429 退避的上限（毫秒）。
 *
 * 为什么要有上限：实测 Jikan 的 429 会带 `retry-after: 60`，而退避是**全局**的
 * （见 backoffUntil），照单全收会让「反代挂了 → 兜底」这条链在界面上干等一分钟。
 * 15 秒足够让瞬时超额滑过去；真超了会再吃一次 429、再退避一次，
 * 而窗口计数（3/秒、60/分钟）本身还在，不会因此打出超额请求。
 */
const MAX_BACKOFF_MS = 15000

/** 最近请求时间戳（毫秒），用于滑动窗口判断 */
const stamps: number[] = []
/** 串行队列：节流之后仍然要保证「排队等待」而不是并发抢跑 */
let queue: Promise<unknown> = Promise.resolve()
/**
 * 429 之后的全员退避截止时间（毫秒时间戳）。
 *
 * 为什么要做成**共享状态**而不是「谁被限流谁自己 sleep」：
 * 被限流说明窗口已经满了，此时后面排队的请求如果照样发出去，只会一个接一个再吃 429，
 * 把重试配额也浪费掉。共享一个截止时间 = 所有请求一起让步。
 */
let backoffUntil = 0
/** 真正发出去的 HTTP 请求次数（含 429 重试）。用来证明「主数据源正常时一次 Jikan 请求都没发」 */
let requestCount = 0

/**
 * 一次 HTTP 尝试的诊断记录（只留最近若干条）。
 *
 * 为什么要有：旧实现把所有失败折叠成 `null`，出问题时只能看到「没有数据」，
 * 分不清是 429 限流、504 上游挂、还是标题根本没匹配上 —— 用户报「Jikan 没生效」时无从下手。
 */
export interface JikanAttempt {
  path: string
  /** HTTP 状态码；网络层就失败（超时/断连）时为 null */
  status: number | null
  ms: number
  at: number
  ok: boolean
  error?: string
}
const ATTEMPT_KEEP = 20
const recentAttempts: JikanAttempt[] = []
let lastFailure: { path: string; status: number | null; message: string; at: number } | null = null

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 记一条尝试记录（只留最近 ATTEMPT_KEEP 条，避免长期运行下内存缓慢增长） */
function recordAttempt(a: JikanAttempt): void {
  recentAttempts.push(a)
  if (recentAttempts.length > ATTEMPT_KEEP) recentAttempts.splice(0, recentAttempts.length - ATTEMPT_KEEP)
  if (!a.ok) {
    lastFailure = { path: a.path, status: a.status, message: a.error ?? `HTTP ${a.status}`, at: a.at }
  }
}

/** 429 退避：等到全局退避窗口结束（不在退避中就直接返回） */
async function waitBackoff(): Promise<void> {
  for (;;) {
    const remain = backoffUntil - Date.now()
    if (remain <= 0) return
    await sleep(remain + 20)
  }
}

/**
 * 等到允许再发下一次请求（滑动窗口：同时满足 1 秒 3 次与 60 秒 60 次）。
 *
 * 不变式（旧实现也满足，这里写清楚以免以后改坏）：发出去之前窗口内的计数 ≤ 2，
 * 于是「任意 1 秒窗口内最多 3 次」「任意 60 秒窗口内最多 60 次」对**每一次发送**都成立。
 * 计数在**发送之前**记账（不是收到响应之后），所以失败/超时的请求同样占用配额 —— 保守但安全。
 *
 * v0.3.2 修的两处漏洞：
 *   ① 429 重试过去是**直接 axios.get，绕过了这里** —— 多出来的那次请求不计入窗口，
 *      连续被限流时窗口会悄悄超出（1 秒里实际发 4~6 次）。现在重试必须先重新排队拿名额。
 *   ② 429 之后没有全局退避，排队的请求会立刻接着撞上去；现在用共享的 backoffUntil 一起让步。
 */
async function waitForSlot(): Promise<void> {
  for (;;) {
    const now = Date.now()
    // 丢掉过期的时间戳（stamps 只保留最近 60 秒）
    while (stamps.length > 0 && now - stamps[0] > 60_000) stamps.shift()
    const inSecond = stamps.filter((t) => now - t < 1000)
    if (inSecond.length >= PER_SECOND) {
      // 等到最早的那次请求满 1 秒
      await sleep(1000 - (now - inSecond[0]) + 20)
      continue
    }
    if (stamps.length >= PER_MINUTE) {
      // 一分钟窗口满了：等到最老的一次滑出窗口
      await sleep(60_000 - (now - stamps[0]) + 50)
      continue
    }
    stamps.push(now)
    return
  }
}

/** 单次 HTTP 发送（不含节流/重试）：**自己判状态码**，这样 504/429 都能如实记录下来 */
async function sendJson<T>(
  path: string,
  timeout: number
): Promise<{
  ok: boolean
  data?: T
  status: number | null
  retryAfterMs: number
  message: string
  /** 发出时刻（毫秒时间戳）——诊断记录用它，才能算出「两次请求隔了多久」 */
  at: number
  ms: number
}> {
  const t0 = Date.now()
  requestCount += 1
  try {
    const res = await axios.get<T>(`${JIKAN_BASE}${path}`, {
      timeout,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      // 不让 axios 对 4xx/5xx 抛异常：我们要拿到 504/429 的原始状态码与 Jikan 的错误文案
      validateStatus: () => true,
      ...buildProxyAgents(getSettings().proxy)
    })
    const retryAfter = Number(res.headers?.['retry-after'])
    return {
      ok: res.status >= 200 && res.status < 300,
      data: res.data,
      status: res.status,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0,
      message: res.status >= 200 && res.status < 300 ? '' : extractJikanError(res.data, res.status),
      at: t0,
      ms: Date.now() - t0
    }
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return {
      ok: false,
      status: null,
      retryAfterMs: 0,
      message: `${e?.code ? e.code + ' ' : ''}${e?.message ?? String(err)}`,
      at: t0,
      ms: Date.now() - t0
    }
  }
}

/**
 * 把 Jikan 的错误响应体压成一句人能看懂的话。
 * Jikan 的 504 长这样：`{"status":504,"type":"BadResponseException","message":"Jikan failed to connect to MyAnimeList…"}`
 * —— 这条 message 直接说明了「是上游 MAL 挂了，不是我们被封」，排障时非常关键。
 */
function extractJikanError(body: unknown, status: number): string {
  const m = (body as { message?: unknown } | null)?.message
  if (typeof m === 'string' && m.trim()) return `HTTP ${status}：${m.trim()}`
  return `HTTP ${status}`
}

interface RequestOpts {
  timeout?: number
  /**
   * 失败后是否**重试一次**（默认开）。只对这两类失败重试：
   *   · 429 限流：等窗口滑过就好，值得重试；
   *   · 网络层错误（超时 / ECONNRESET，此时 `status === null`）：一过性的，重试常常就好了
   *     （实测 AniList 会偶发 `ECONNRESET aborted`，重试即成功）。
   *
   * 为什么 5xx **不**自动重试：实测 504 是「Jikan 连不上 MAL 上游」，
   * 这类故障在一秒内重试不可能好，而每次重试都要占 60 次/分钟里的一格 —— 白烧配额。
   */
  retryTransient?: boolean
}

/** 一次请求的最终结果：**带失败原因**，调用方据此给界面一个能解释的说法 */
export interface JikanFetchResult<T> {
  ok: boolean
  data?: T
  status: number | null
  /** 失败原因（成功时为空串） */
  reason: string
  ms: number
}

/**
 * 统一的 GET（带节流、超时与 429 退避重试）。
 *
 * 与旧实现的区别：返回的是**结构化结果**而不是 `T | null`，
 * 让上层能区分「接口通了但没有数据」和「接口本身就是坏的」。
 */
async function request<T>(path: string, opts: RequestOpts = {}): Promise<JikanFetchResult<T>> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const retryTransient = opts.retryTransient !== false
  const run = async (): Promise<JikanFetchResult<T>> => {
    const started = Date.now()
    // 先让全局退避过去，再去抢节流名额（反过来会白白占掉一个名额）
    await waitBackoff()
    await waitForSlot()
    let r = await sendJson<T>(path, timeout)
    recordAttempt({ path, status: r.status, ms: r.ms, at: r.at, ok: r.ok, error: r.ok ? undefined : r.message })

    // 429（限流）与网络层错误（status === null）都值得重试一次；5xx 不重试，理由见 RequestOpts
    const rateLimited = r.status === 429
    const netFailed = r.status === null
    if (!r.ok && retryTransient && (rateLimited || netFailed)) {
      const wanted = rateLimited ? Math.max(2000, r.retryAfterMs) : 1200
      const wait = Math.min(MAX_BACKOFF_MS, wanted)
      backoffUntil = Math.max(backoffUntil, Date.now() + wait)
      log.append(
        'warn',
        'jikan',
        rateLimited
          ? `被限流（429），全局退避 ${wait}ms 后重试：${path}${wanted > wait ? `（Jikan 要求 ${wanted}ms，这里封顶 ${MAX_BACKOFF_MS}ms）` : ''}`
          : `网络异常（${r.message}），${wait}ms 后重试一次：${path}`
      )
      await waitBackoff()
      // ★ 重试必须重新排队拿名额（旧实现是直接 fetch，绕开了滑动窗口的计数）
      await waitForSlot()
      r = await sendJson<T>(path, timeout)
      recordAttempt({ path, status: r.status, ms: r.ms, at: r.at, ok: r.ok, error: r.ok ? undefined : r.message })
      if (!r.ok) log.append('warn', 'jikan', `重试仍失败：${r.message}（${path}）`)
    }

    if (!r.ok) {
      log.append('warn', 'jikan', `请求失败 ${path}：${r.message}（${Date.now() - started}ms）`)
    }
    return { ok: r.ok, data: r.data, status: r.status, reason: r.ok ? '' : r.message, ms: r.ms }
  }
  // 串到队列尾部：保证调用顺序 = 实际发送顺序，节流窗口才准
  const task = queue.then(run, run)
  queue = task.catch(() => undefined)
  return task
}

// ---------------- 公开类型 ----------------

export interface JikanCharacter {
  id: number
  name: string
  nameCn: string
  relation: string
  images: { large: string; medium: string; small: string; grid: string } | null
  favorites?: number
}

/**
 * 一部番（MAL 视角）在应用里用到的最小字段集。
 *
 * ⚠️ `malId/title/titleCn/images/score/aired` 是 v0.3.0 就有的字段，**签名不许动**
 * （「最XX的角色」工具与 ipc 都在用）；下面带 `?` 的是 v0.3.2 为兜底链路补的，
 * 都可选，老调用方不受影响。
 */
export interface JikanAnime {
  malId: number
  title: string
  titleCn: string
  images: string | null
  score: number | null
  aired: string | null
  /** 以下为 v0.3.2 新增（可选） */
  titleEnglish?: string | null
  titleJapanese?: string | null
  /** jpg 常规图（比 large 小一档，卡片用） */
  imageMedium?: string | null
  imageSmall?: string | null
  /** webp 版（体积更小；MAL 只有 image_url 一档） */
  imageWebp?: string | null
  episodes?: number | null
  /** TV / ONA / Movie / Special…（映射到 SeasonItem.platform 用） */
  type?: string | null
  status?: string | null
  synopsis?: string | null
  genres?: string[]
  rank?: number | null
  /** 打分人数（映射到 Rating.total 用：MAL 用 scored_by，Bangumi 用 rating.total） */
  scoredBy?: number | null
  members?: number | null
  /** 放送开始日（ISO，形如 `2023-09-29T00:00:00+00:00`），映射成 `YYYY-MM-DD` */
  airedFrom?: string | null
  /** 放送星期（MAL 的英文原样：`Fridays`），没有播出信息时为 null */
  broadcastDay?: string | null
  /** 放送时刻（`23:00`，JST） */
  broadcastTime?: string | null
  airing?: boolean | null
  year?: number | null
  /** MAL 的季节名（winter/spring/summer/fall） */
  seasonName?: string | null
  /**
   * 下一集开播的 Unix 时间戳（**秒**，UTC）。
   *
   * 只有 AniList 会给（MAL 给的是 `broadcast.day` 这种英文星期名）。
   * 兜底的番剧表要按星期几分组，而 AniList 这条时间戳是最可靠的来源：
   * 把它 +9 小时换算成 JST 再取星期，就是日本电视台的实际放送星期。
   */
  nextAiringAtSec?: number | null
}

/** 列表型接口的返回：带上「用了哪个端点 / 失败原因 / 耗时」，方便上层写日志与给界面解释 */
export interface JikanListResult {
  items: JikanAnime[]
  endpoint: string
  ms: number
  /** 失败原因（成功时为空串；「接口通了但没有数据」时也是空串） */
  reason: string
}

/** 单条查询的返回：同上 */
export interface JikanOneResult {
  item: JikanAnime | null
  endpoint: string
  ms: number
  reason: string
}

interface MalAnimeRaw {
  mal_id?: number
  title?: string
  title_english?: string | null
  title_japanese?: string | null
  title_synonyms?: string[]
  titles?: { type?: string; title?: string }[]
  images?: {
    jpg?: { image_url?: string; small_image_url?: string; large_image_url?: string }
    webp?: { image_url?: string; small_image_url?: string; large_image_url?: string }
  }
  score?: number | null
  scored_by?: number | null
  rank?: number | null
  members?: number | null
  episodes?: number | null
  type?: string | null
  status?: string | null
  airing?: boolean
  aired?: { from?: string | null; to?: string | null; string?: string | null }
  broadcast?: { day?: string | null; time?: string | null; string?: string | null }
  season?: string | null
  year?: number | null
  synopsis?: string | null
  genres?: { name?: string }[]
  themes?: { name?: string }[]
  demographics?: { name?: string }[]
}

/**
 * MAL 的 `anime` 对象 → 应用内部类型。
 *
 * 中文名为什么这样取：MAL 本身没有中文标题，但 Jikan 的 `titles[]` 偶尔带有
 * `type: 'Chinese'` 的条目（社区补的）；取不到就退回英文名再退回原名，
 * 保证 `titleCn` **永远不为空**（渲染层直接显示它，空串会露出空白标题）。
 */
function normalizeMalAnime(raw: MalAnimeRaw | null | undefined): JikanAnime | null {
  const malId = Number(raw?.mal_id ?? 0)
  if (!malId) return null
  const title = String(raw?.title ?? '')
  const jpg = raw?.images?.jpg
  const webp = raw?.images?.webp
  const genres = [...(raw?.genres ?? []), ...(raw?.themes ?? []), ...(raw?.demographics ?? [])]
    .map((g) => String(g?.name ?? '').trim())
    .filter((s) => s.length > 0)
  return {
    malId,
    title,
    titleCn:
      String(raw?.titles?.find((t) => t.type === 'Chinese')?.title ?? raw?.title_english ?? title),
    images: jpg?.large_image_url ?? jpg?.image_url ?? webp?.large_image_url ?? webp?.image_url ?? null,
    score: raw?.score != null ? Number(raw.score) : null,
    aired: raw?.aired?.string ?? null,
    titleEnglish: raw?.title_english ?? null,
    titleJapanese: raw?.title_japanese ?? null,
    imageMedium: jpg?.image_url ?? webp?.image_url ?? null,
    imageSmall: jpg?.small_image_url ?? webp?.small_image_url ?? null,
    imageWebp: webp?.large_image_url ?? webp?.image_url ?? null,
    episodes: raw?.episodes != null ? Number(raw.episodes) : null,
    type: raw?.type ?? null,
    status: raw?.status ?? null,
    synopsis: raw?.synopsis ?? null,
    genres,
    rank: raw?.rank != null ? Number(raw.rank) : null,
    scoredBy: raw?.scored_by != null ? Number(raw.scored_by) : null,
    members: raw?.members != null ? Number(raw.members) : null,
    airedFrom: raw?.aired?.from ?? null,
    broadcastDay: raw?.broadcast?.day ?? null,
    broadcastTime: raw?.broadcast?.time ?? null,
    airing: raw?.airing ?? null,
    year: raw?.year != null ? Number(raw.year) : null,
    seasonName: raw?.season ?? null
  }
}

const pickMalList = (body: unknown): MalAnimeRaw[] => {
  const list = (body as { data?: unknown } | null)?.data
  return Array.isArray(list) ? (list as MalAnimeRaw[]) : []
}

// ---------------- Jikan 公开包装函数 ----------------

/** 按关键词搜番剧（备用数据源 / 角色立绘入口都用它拿 MAL id） */
export async function jikanSearchAnime(keyword: string, limit = 5): Promise<JikanAnime[]> {
  const r = await jikanAnimeSearch(keyword, limit)
  return r.items
}

/** 同上，但**带失败原因**：兜底链路要能把「504 上游挂」和「搜不到」区分开 */
export async function jikanAnimeSearch(keyword: string, limit = 5): Promise<JikanListResult> {
  const kw = String(keyword ?? '').trim()
  const endpoint = `/anime?q=${encodeURIComponent(kw)}&limit=${limit}&sfw`
  if (!kw) return { items: [], endpoint: '', ms: 0, reason: '关键词为空' }
  const r = await request<unknown>(endpoint)
  return {
    items: pickMalList(r.data).map((a) => normalizeMalAnime(a)).filter((a): a is JikanAnime => a !== null),
    endpoint,
    ms: r.ms,
    reason: r.reason
  }
}

/** 单条详情：**优先 `/full`**（实测 `/anime/{id}` 大面积 504，而 `/full` 是 200，见文件头） */
export async function jikanAnimeById(malId: number, timeout?: number): Promise<JikanOneResult> {
  const id = Math.trunc(Number(malId))
  if (!id || id <= 0) return { item: null, endpoint: '', ms: 0, reason: 'MAL id 无效' }
  const full = `/anime/${id}/full`
  const first = await request<{ data?: MalAnimeRaw }>(full, timeout ? { timeout } : {})
  const hit = first.ok ? normalizeMalAnime(first.data?.data) : null
  if (hit) return { item: hit, endpoint: full, ms: first.ms, reason: '' }
  // /full 失败 → 退回普通详情端点（多花一格配额，但只在 /full 真的坏了时才会走到）
  const plain = `/anime/${id}`
  const second = await request<{ data?: MalAnimeRaw }>(plain, timeout ? { timeout } : {})
  const hit2 = second.ok ? normalizeMalAnime(second.data?.data) : null
  if (hit2) return { item: hit2, endpoint: plain, ms: first.ms + second.ms, reason: '' }
  return {
    item: null,
    endpoint: full,
    ms: first.ms + second.ms,
    reason: second.reason || first.reason || '详情接口不可用'
  }
}

interface MalCharactersRaw {
  data?: {
    character?: {
      mal_id?: number
      name?: string
      name_kanji?: string
      images?: { jpg?: { image_url?: string }; webp?: { image_url?: string } }
      favorites?: number
    }
    role?: string
  }[]
}

/**
 * 取某部番（MAL id）的登场角色。
 *
 * 图片说明：MAL 的 `image_url` 就是**原图**（不像 Bangumi 分 s/g/m/l 四档），
 * 实测常见 225x350，也有更大的；这正是用户想换到 Jikan 的原因 —— 立绘更清晰。
 * 这里把四个档位都填同一个原图地址，因为渲染层按 `large/medium/small/grid` 取值，
 * 都指向原图即可（本地缓存会按 URL 去重，不会重复下载）。
 *
 * ⚠️ 该端点在实测中**大面积 504**（见文件头）；取不到时返回空数组（保持 v0.3.0 签名），
 * 需要失败原因的调用方请用 `jikanCharactersDetailed()`。
 */
export async function jikanCharacters(malId: number): Promise<JikanCharacter[]> {
  const r = await jikanCharactersDetailed(malId)
  return r.items
}

export interface JikanCharactersResult {
  items: JikanCharacter[]
  endpoint: string
  ms: number
  reason: string
}

/** 同上，但带失败原因（`/anime/{id}/characters` 挂掉时 reason 里会有 504 的原文） */
export async function jikanCharactersDetailed(malId: number): Promise<JikanCharactersResult> {
  const id = Math.trunc(Number(malId))
  const endpoint = `/anime/${id}/characters`
  if (!id || id <= 0) return { items: [], endpoint: '', ms: 0, reason: 'MAL id 无效' }
  const r = await request<MalCharactersRaw>(endpoint)
  if (!r.ok) return { items: [], endpoint, ms: r.ms, reason: r.reason }
  const list = r.data?.data ?? []
  const items = list
    .map((row) => {
      const c = row.character ?? {}
      const url = c.images?.jpg?.image_url ?? c.images?.webp?.image_url ?? null
      return {
        id: Number(c.mal_id ?? 0),
        name: String(c.name ?? ''),
        nameCn: String(c.name_kanji ?? ''),
        relation: String(row.role ?? ''),
        images: url ? { large: url, medium: url, small: url, grid: url } : null,
        favorites: c.favorites != null ? Number(c.favorites) : undefined
      }
    })
    .filter((c) => c.id > 0)
  return { items, endpoint, ms: r.ms, reason: '' }
}

/** MAL 季节名（Jikan 的 URL 片段）—— 顺序必须与 `@shared/season` 的 1..4（冬春夏秋）一致 */
export const MAL_SEASON_NAMES = ['winter', 'spring', 'summer', 'fall'] as const

/**
 * 当季新番（`/seasons/now`）。
 *
 * ⚠️ 这个端点实测也是 504 的重灾区，所以调用方（bangumi 的番剧表兜底）必须准备后备端点。
 */
export async function jikanSeasonNow(limit = 25): Promise<JikanListResult> {
  const endpoint = `/seasons/now?limit=${limit}&sfw`
  const r = await request<unknown>(endpoint)
  return {
    items: pickMalList(r.data).map((a) => normalizeMalAnime(a)).filter((a): a is JikanAnime => a !== null),
    endpoint,
    ms: r.ms,
    reason: r.reason
  }
}

/**
 * 指定年份/季度（`/seasons/{year}/{season}`）。
 *
 * `seasonNo` 用**本应用的季度序号**（1=冬 2=春 3=夏 4=秋，见 `@shared/season`），
 * 内部再翻成 MAL 的英文名 —— 直接把 1..4 当 winter..fall 是常见的 off-by-one，
 * 所以这里显式做一次转换并放在唯一的映射表里。
 */
export async function jikanSeason(year: number, seasonNo: number, limit = 50): Promise<JikanListResult> {
  const y = Math.trunc(Number(year)) || new Date().getFullYear()
  const s = Math.min(4, Math.max(1, Math.trunc(Number(seasonNo)) || 1))
  const endpoint = `/seasons/${y}/${MAL_SEASON_NAMES[s - 1]}?limit=${limit}&sfw`
  const r = await request<unknown>(endpoint)
  return {
    items: pickMalList(r.data).map((a) => normalizeMalAnime(a)).filter((a): a is JikanAnime => a !== null),
    endpoint,
    ms: r.ms,
    reason: r.reason
  }
}

/**
 * 「正在播出 + 人气」榜（`/top/anime?filter=airing`）。
 *
 * 为什么需要它：番剧表兜底首选 `/seasons/now`，而上游一挂它和上面几个一起 504；
 * 多一条不同实现的端点就多一次机会（实测也是 504，但接口形态不同、恢复时间常常也不同，
 * 留着它成本只有一格配额）。
 */
export async function jikanTopAiring(limit = 25): Promise<JikanListResult> {
  const endpoint = `/top/anime?filter=airing&limit=${limit}&sfw`
  const r = await request<unknown>(endpoint)
  return {
    items: pickMalList(r.data).map((a) => normalizeMalAnime(a)).filter((a): a is JikanAnime => a !== null),
    endpoint,
    ms: r.ms,
    reason: r.reason
  }
}

/**
 * 反代/镜像都拿不到番剧表时的兜底：当季新番（Jikan seasons/now）。
 *
 * ⚠️ 返回的 `weekday` 是 **0=周日 … 6=周六**（v0.3.0 就是这个约定，签名不许改）。
 * 注意它与 `@shared/types` 里 `WeekdayInfo.id`（1=周一 … 7=周日）**不是**同一套编号，
 * 映射到 `CalendarDay` 时必须走 jikanMap.ts 的转换，别把 0 直接塞进去。
 */
export async function jikanCurrentSeason(): Promise<
  { title: string; titleCn: string; image: string | null; score: number | null; weekday: number | null }[]
> {
  const weekdays: Record<string, number> = {
    Mondays: 1,
    Tuesdays: 2,
    Wednesdays: 3,
    Thursdays: 4,
    Fridays: 5,
    Saturdays: 6,
    Sundays: 0
  }
  const r = await jikanSeasonNow(25)
  return r.items
    .filter((a) => a.airing !== false)
    .map((a) => ({
      title: a.title,
      titleCn: a.titleCn,
      image: a.images,
      score: a.score,
      weekday: a.broadcastDay != null ? (weekdays[a.broadcastDay] ?? null) : null
    }))
}

// ---------------- AniList（标题 → MAL id 的备用解析路径） ----------------

/**
 * 为什么需要 AniList：
 * `/anime?q=` 实测返回 504（Jikan 连不上 MAL 上游），而「标题 → MAL id」是
 * 角色工具与整个兜底链路的第一步 —— 只靠 Jikan 搜索的话，它一挂整条链就断。
 * AniList 的 GraphQL 是公开的（无需 API key），且响应里带 `idMal`（就是 MAL id）。
 *
 * 节流：AniList 2024 年起把限额收紧到 30 次/分钟（此前 90）；这里**独立于 Jikan** 排队，
 * 并保证两次请求至少间隔 700ms（约 85 次/分钟的上限里留了余量）。
 * 为什么不共用 Jikan 的窗口：两家是不同服务、不同配额，混在一个窗口里只会让两边都变慢。
 */
const ANILIST_URL = 'https://graphql.anilist.co'
const ANILIST_MIN_GAP = 700
/**
 * AniList 单次请求超时。
 *
 * 为什么不是更长：它是兜底链路的**最后一环**，而反代挂掉时用户就在等这个界面。
 * 实测同一台机器上 AniList 时快时慢（0.5~8.5 秒，偶尔整条超时），
 * 超时后我们还会重试一次 —— 超时给得越长，「超时 + 重试」就越可能把兜底拖到半分钟。
 * 12 秒足够覆盖正常与偏慢的响应，同时把最坏情况压住。
 */
const ANILIST_TIMEOUT = 12000
let anilistQueue: Promise<unknown> = Promise.resolve()
let anilistLastAt = 0
let anilistBackoffUntil = 0
let anilistCount = 0

interface AniListMedia {
  id?: number
  idMal?: number | null
  title?: { romaji?: string; native?: string; english?: string }
  synonyms?: string[]
  coverImage?: { extraLarge?: string; large?: string; medium?: string }
  averageScore?: number | null
  popularity?: number | null
  startDate?: { year?: number | null; month?: number | null; day?: number | null }
  description?: string | null
  genres?: string[]
  format?: string | null
  episodes?: number | null
  status?: string | null
  nextAiringEpisode?: { episode?: number | null; airingAt?: number | null } | null
  characters?: {
    edges?: {
      role?: string
      node?: {
        id?: number
        name?: { full?: string; native?: string }
        image?: { large?: string; medium?: string }
        favourites?: number | null
      }
    }[]
  }
}

interface AniListResult<T> {
  ok: boolean
  data?: T
  status: number | null
  reason: string
  ms: number
}

/** 串行的 AniList GraphQL 请求（含最小间隔、429 退避重试一次） */
async function anilistRequest<T>(
  query: string,
  variables: Record<string, unknown>,
  timeout = ANILIST_TIMEOUT
): Promise<AniListResult<T>> {
  const run = async (): Promise<AniListResult<T>> => {
    const t0 = Date.now()
    const send = async (): Promise<{ ok: boolean; data?: T; status: number | null; message: string }> => {
      const gap = ANILIST_MIN_GAP - (Date.now() - anilistLastAt)
      if (gap > 0) await sleep(gap)
      anilistLastAt = Date.now()
      anilistCount += 1
      try {
        const res = await axios.post(
          ANILIST_URL,
          { query, variables },
          {
            timeout,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
            validateStatus: () => true,
            ...buildProxyAgents(getSettings().proxy)
          }
        )
        if (res.status >= 200 && res.status < 300) return { ok: true, data: res.data as T, status: res.status, message: '' }
        const errs = (res.data as { errors?: { message?: string }[] } | null)?.errors
        const detail = Array.isArray(errs) && errs[0]?.message ? errs[0].message : ''
        return { ok: false, status: res.status, message: `HTTP ${res.status}${detail ? `：${detail}` : ''}` }
      } catch (err) {
        const e = err as { code?: string; message?: string }
        return { ok: false, status: null, message: `${e?.code ? e.code + ' ' : ''}${e?.message ?? String(err)}` }
      }
    }
    let r = await send()
    /*
     * 失败重试一次：429（限流）与网络层错误（status === null，如实测偶发的 `ECONNRESET aborted`）。
     * 为什么网络错误也要重试：AniList 是兜底链路的最后一环，一次偶发断连就会让
     * 「反代挂了 + Jikan 也 504 + AniList 恰好断连」三条同时失败，用户看到的是空列表 ——
     * 而重试几乎总能成功（实测同一条查询重试即通过）。
     */
    const netFailed = r.status === null
    if (!r.ok && (r.status === 429 || netFailed)) {
      const wait = r.status === 429 ? 3000 : 1200
      anilistBackoffUntil = Math.max(anilistBackoffUntil, Date.now() + wait)
      log.append('warn', 'anilist', r.status === 429 ? '被限流（429），退避 3 秒后重试' : `网络异常（${r.message}），${wait}ms 后重试一次`)
      const remain = anilistBackoffUntil - Date.now()
      if (remain > 0) await sleep(remain)
      r = await send()
    }
    if (!r.ok) log.append('warn', 'anilist', `GraphQL 请求失败：${r.message}（${Date.now() - t0}ms）`)
    return { ok: r.ok, data: r.data, status: r.status, reason: r.ok ? '' : r.message, ms: Date.now() - t0 }
  }
  const task = anilistQueue.then(run, run)
  anilistQueue = task.catch(() => undefined)
  return task
}

const ANILIST_SEARCH_QUERY = `query ($s: String, $n: Int) {
  Page(perPage: $n) {
    media(search: $s, type: ANIME, sort: SEARCH_MATCH) {
      id
      idMal
      title { romaji native english }
      synonyms
      coverImage { extraLarge large medium }
      averageScore
      popularity
      startDate { year month day }
      description(asHtml: false)
      genres
      format
      episodes
      status
      nextAiringEpisode { episode airingAt }
    }
  }
}`

/** 把 GraphQL 的 Page.media 压成内部结构（字段名对齐 MAL，后面共用一套映射） */
function aniListToJikanAnime(m: AniListMedia): JikanAnime | null {
  const malId = Number(m.idMal ?? 0)
  if (!malId) return null
  const romaji = String(m.title?.romaji ?? '')
  const native = String(m.title?.native ?? '')
  const english = String(m.title?.english ?? '')
  const start = m.startDate ?? {}
  const pad = (v: number | null | undefined): string => String(v ?? 0).padStart(2, '0')
  const airedFrom =
    start.year && start.month
      ? `${start.year}-${pad(start.month)}-${pad(start.day ?? 1)}`
      : start.year
        ? `${start.year}-01-01`
        : null
  return {
    malId,
    title: romaji || native || english,
    // AniList 没有中文标题：优先英文（界面上比罗马音好认），再退回原名
    titleCn: english || romaji || native,
    images: m.coverImage?.extraLarge ?? m.coverImage?.large ?? m.coverImage?.medium ?? null,
    imageMedium: m.coverImage?.large ?? m.coverImage?.medium ?? null,
    imageSmall: m.coverImage?.medium ?? null,
    // AniList 的 averageScore 是 100 分制，MAL 是 10 分制 → 除以 10（保留一位小数）
    score: m.averageScore != null ? Math.round(Number(m.averageScore)) / 10 : null,
    aired: airedFrom,
    titleEnglish: english || null,
    titleJapanese: native || null,
    episodes: m.episodes ?? null,
    type: m.format ?? null,
    status: m.status ?? null,
    synopsis: m.description ?? null,
    genres: Array.isArray(m.genres) ? m.genres.map((g) => String(g)) : [],
    scoredBy: m.popularity != null ? Number(m.popularity) : null,
    airedFrom,
    nextAiringAtSec: m.nextAiringEpisode?.airingAt != null ? Number(m.nextAiringEpisode.airingAt) : null,
    airing: m.status === 'RELEASING' ? true : m.status === 'FINISHED' ? false : null
  }
}

/**
 * AniList 搜索（返回带 `idMal` 的候选）。
 *
 * AniList 的 `search` 对中文标题**支持不稳定**（实测「无职转生」命中，
 * 「二十世纪电气目录」直接 404 Not Found），所以调用方要准备多个标题变体，
 * 见 `resolveMalIdByTitle`。
 */
export async function anilistSearchAnime(
  keyword: string,
  perPage = 8
): Promise<{ items: JikanAnime[]; reason: string; ms: number }> {
  const kw = String(keyword ?? '').trim()
  if (!kw) return { items: [], reason: '关键词为空', ms: 0 }
  const r = await anilistRequest<{ data?: { Page?: { media?: AniListMedia[] } } }>(ANILIST_SEARCH_QUERY, {
    s: kw,
    n: perPage
  })
  if (!r.ok) return { items: [], reason: r.reason, ms: r.ms }
  const media = r.data?.data?.Page?.media ?? []
  const items = media.map((m) => aniListToJikanAnime(m)).filter((a): a is JikanAnime => a !== null)
  return { items, reason: '', ms: r.ms }
}

const ANILIST_SEASON_QUERY = `query ($season: MediaSeason, $year: Int, $n: Int) {
  Page(perPage: $n) {
    media(season: $season, seasonYear: $year, type: ANIME, sort: POPULARITY_DESC) {
      id
      idMal
      title { romaji native english }
      synonyms
      coverImage { extraLarge large medium }
      averageScore
      popularity
      startDate { year month day }
      description(asHtml: false)
      genres
      format
      episodes
      status
      nextAiringEpisode { episode airingAt }
    }
  }
}`

/** AniList 的季节枚举：**顺序与我们 1..4（冬春夏秋）一致**，所以直接按下标取 */
const ANILIST_SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const

/**
 * 按「年 + 季度」从 AniList 取番剧（Jikan `/seasons/{y}/{s}` 实测 504 时的最终兜底）。
 *
 * 为什么兜底链路里要塞一条 AniList：用户要的是「反代挂了也能看到当季/某季的番剧表」，
 * 而 Jikan 的季节端点现在整条 504 —— 只挂 Jikan 的话这个功能等于没做。
 * AniList 的季节检索（`season` + `seasonYear`）实测 200，字段也够映射出卡片（名称/封面/评分/放送日/类型）。
 *
 * `seasonNo` 用本应用的序号（1=冬 … 4=秋）；越界会被夹到 1..4，避免拼出非法枚举值。
 */
export async function anilistSeasonAnime(
  year: number,
  seasonNo: number,
  perPage = 25
): Promise<{ items: JikanAnime[]; reason: string; ms: number; endpoint: string }> {
  const y = Math.trunc(Number(year)) || new Date().getFullYear()
  const s = Math.min(4, Math.max(1, Math.trunc(Number(seasonNo)) || 1))
  const season = ANILIST_SEASONS[s - 1]
  const endpoint = `anilist:Page.media(season=${season},seasonYear=${y})`
  const r = await anilistRequest<{ data?: { Page?: { media?: AniListMedia[] } } }>(ANILIST_SEASON_QUERY, {
    season,
    year: y,
    n: perPage
  })
  if (!r.ok) return { items: [], reason: r.reason, ms: r.ms, endpoint }
  const media = r.data?.data?.Page?.media ?? []
  const items = media.map((m) => aniListToJikanAnime(m)).filter((a): a is JikanAnime => a !== null)
  return { items, reason: '', ms: r.ms, endpoint }
}

const ANILIST_CHARACTERS_QUERY = `query ($idMal: Int, $n: Int) {
  Media(idMal: $idMal, type: ANIME) {
    id
    idMal
    characters(perPage: $n) {
      edges {
        role
        node {
          id
          name { full native }
          image { large medium }
          favourites
        }
      }
    }
  }
}`

/**
 * AniList 的角色表（**Jikan 角色端点 504 时的最后一条路**）。
 *
 * 用户要这个数据源的核心诉求是「立绘更清晰」，而 Jikan 的角色段实测是 504 重灾区；
 * AniList 各存了一份角色立绘（s4.anilist.co，实测常见 230x345），
 * 画质与 MAL 原图同级，比「什么都拿不到」强得多。
 *
 * ⚠️ 这是**换了图床**：数据来自 AniList 而不是 MyAnimeList，
 * 所以返回结果里带 `source: 'anilist'`，界面要照实标注（不要写成 Jikan/MAL）。
 */
export async function anilistCharactersByMalId(
  malId: number,
  perPage = 25
): Promise<{ items: JikanCharacter[]; reason: string; ms: number; source: 'anilist' }> {
  const id = Math.trunc(Number(malId))
  if (!id || id <= 0) return { items: [], reason: 'MAL id 无效', ms: 0, source: 'anilist' }
  const r = await anilistRequest<{ data?: { Media?: AniListMedia } }>(ANILIST_CHARACTERS_QUERY, {
    idMal: id,
    n: perPage
  })
  if (!r.ok) return { items: [], reason: r.reason, ms: r.ms, source: 'anilist' }
  const edges = r.data?.data?.Media?.characters?.edges ?? []
  const items = edges
    .map((e) => {
      const node = e.node ?? {}
      const url = node.image?.large ?? node.image?.medium ?? null
      return {
        id: Number(node.id ?? 0),
        name: String(node.name?.full ?? ''),
        // AniList 的 native 是日文原名，对应 MAL 那边我们放在 nameCn 的 name_kanji
        nameCn: String(node.name?.native ?? ''),
        // 角色关系：AniList 给 MAIN/SUPPORTING/BACKGROUND，与 MAL 的 Main/Supporting 同义，保留原样
        relation: String(e.role ?? ''),
        images: url ? { large: url, medium: url, small: url, grid: url } : null,
        favorites: node.favourites != null ? Number(node.favourites) : undefined
      }
    })
    .filter((c) => c.id > 0 && c.name.length > 0)
  return { items, reason: '', ms: r.ms, source: 'anilist' }
}

/** 去掉空格/标点并转小写：判断「搜到的条目就是我们要的那部」用 */
const normalizeTitle = (s: string): string =>
  (s || '')
    .replace(/[\s!！?？~～〜・:：,，.。、'’"“”\-–—_\/\\（）()【】\[\]]+/g, '')
    .toLowerCase()

/** 标题变体：中文标题在两家搜索里的匹配规则不同，挨个试（最多 3 个，避免白烧配额） */
function titleVariants(title: string): string[] {
  const raw = String(title ?? '').trim()
  if (!raw) return []
  const out: string[] = [raw]
  const push = (v: string): void => {
    const s = v.replace(/\s+/g, ' ').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  push(raw.replace(/[!！?？~～〜・:：,，.。、'’"“”\-–—_\/\\]+/g, ' '))
  // 常见后缀：`第二季`/`Season 2`/`(2026)` 之类的尾巴去掉，AniList 对纯标题更敏感
  push(raw.replace(/[（(【\[].*?[）)】\]]/g, ' ').replace(/(第[一二三四五六七八九十0-9]+季|Season\s*\d+)/gi, ' '))
  return out.slice(0, 3)
}

/** 在候选里挑「最像」的那一条：先看标题完全相等，再看包含关系，最后退回第一条 */
function pickBestMatch(list: JikanAnime[], title: string): JikanAnime | null {
  if (list.length === 0) return null
  const want = normalizeTitle(title)
  const exact = list.find((a) =>
    [a.title, a.titleCn, a.titleEnglish, a.titleJapanese].some((t) => t && normalizeTitle(String(t)) === want)
  )
  if (exact) return exact
  const partial = list.find((a) =>
    [a.title, a.titleCn, a.titleEnglish, a.titleJapanese].some((t) => {
      const n = normalizeTitle(String(t ?? ''))
      return n.length > 0 && (n.includes(want) || want.includes(n))
    })
  )
  return partial ?? list[0]
}

/**
 * 把 Jikan 详情（`/anime/{id}/full`）里的字段合并进一条已有的条目（可能来自 AniList）。
 *
 * 为什么要合并而不是直接替换：AniList 与 MAL 各有各的强项 ——
 * AniList 有 `nextAiringEpisode`（推算放送星期最准）、封面分辨率更高；
 * MAL 有中文标题（`titles` 里的 Chinese）与 MAL 自己的评分。
 * 合并时**以 base 为主、detail 只补有值的字段**，这样任何一边缺字段都不会把已有信息抹掉。
 */
export function mergeJikanAnime(base: JikanAnime, detail: JikanAnime): JikanAnime {
  return {
    ...base,
    // MAL 有中文名时优先用 MAL 的（AniList 没有中文名，只能退回英文/罗马音）
    titleCn: detail.titleCn || base.titleCn,
    titleEnglish: detail.titleEnglish ?? base.titleEnglish,
    titleJapanese: detail.titleJapanese ?? base.titleJapanese,
    score: detail.score ?? base.score,
    genres: detail.genres?.length ? detail.genres : base.genres,
    synopsis: detail.synopsis ?? base.synopsis,
    episodes: detail.episodes ?? base.episodes,
    broadcastDay: detail.broadcastDay ?? base.broadcastDay,
    broadcastTime: detail.broadcastTime ?? base.broadcastTime,
    airedFrom: detail.airedFrom ?? base.airedFrom,
    aired: detail.aired ?? base.aired,
    airing: detail.airing ?? base.airing,
    status: detail.status ?? base.status,
    type: detail.type ?? base.type,
    // 封面/立绘以 AniList 的为准（extraLarge 比 MAL 的 large 更大，用户要的就是清晰度）
    images: base.images ?? detail.images,
    imageMedium: base.imageMedium ?? detail.imageMedium,
    imageSmall: base.imageSmall ?? detail.imageSmall,
    scoredBy: detail.scoredBy ?? base.scoredBy,
    rank: detail.rank ?? base.rank,
    members: detail.members ?? base.members,
    nextAiringAtSec: base.nextAiringAtSec ?? detail.nextAiringAtSec
  }
}

/**
 * 标题 → MAL 条目（**不依赖 `/anime?q=` 的解析路径**）。
 *
 * 尝试顺序（每一步的失败原因都会累积到 `reason` 里给界面看）：
 *   ① Jikan `/anime?q=`：能用就用它（它就是 MAL 自己的数据，中文标题命中率最好）；
 *   ② AniList GraphQL（`idMal`）：`/anime?q=` 挂掉时的主力路径；
 *   ③ 若 AniList 命中，再用 Jikan `/anime/{id}/full` 补一次细节
 *      —— 主要为了拿到 MAL 的中文标题与 MAL 自己的评分（AniList 没有中文名）。
 */
export async function resolveMalIdByTitle(title: string): Promise<{
  anime: JikanAnime | null
  via: 'jikan' | 'anilist' | 'none'
  reason: string
}> {
  const asked = String(title ?? '').trim()
  if (!asked) return { anime: null, via: 'none', reason: '标题为空' }
  const failures: string[] = []

  // ① Jikan 搜索
  const search = await jikanAnimeSearch(asked, 5)
  if (search.items.length > 0) {
    const hit = pickBestMatch(search.items, asked)
    if (hit) return { anime: hit, via: 'jikan', reason: '' }
  }
  if (search.reason) failures.push(`Jikan ${search.endpoint}：${search.reason}`)
  else failures.push(`Jikan ${search.endpoint}：没有匹配「${asked}」的条目`)

  // ② AniList 搜索（多个标题变体，命中就停）
  const anilistFailures: string[] = []
  for (const variant of titleVariants(asked)) {
    const a = await anilistSearchAnime(variant, 8)
    if (a.items.length > 0) {
      const hit = pickBestMatch(a.items, asked) ?? a.items[0]
      // ③ 用 Jikan 详情补细节（拿 MAL 中文标题/评分）；失败也不影响主结果
      const detail = await jikanAnimeById(hit.malId)
      const merged: JikanAnime = detail.item ? mergeJikanAnime(hit, detail.item) : hit
      log.append(
        'info',
        'jikan',
        `标签解析：「${asked}」→ AniList 命中 MAL #${merged.malId}《${merged.titleCn}》${detail.item ? '（已用 Jikan /full 补细节）' : `（Jikan 详情未取到：${detail.reason}）`}`
      )
      return { anime: merged, via: 'anilist', reason: '' }
    }
    anilistFailures.push(`AniList「${variant}」：${a.reason || '无匹配'}`)
  }
  failures.push(...anilistFailures)
  return { anime: null, via: 'none', reason: failures.join('；') }
}

/**
 * 按番剧标题取角色（v0.3.0 工具用）：先解析到 MAL 条目，再取角色。
 *
 * 为什么要「按标题」而不是按 id：我们的条目 id 是 **Bangumi** 的，Jikan 认的是 MAL id，
 * 两边的 id 体系不通；但标题能对上，所以用标题做桥梁。
 *
 * v0.3.2 扩展（**保持 `characters` 字段名不变**，老调用方不受影响）：
 *   · `reason`：两条路都失败时给出**具体原因**（504 / 无匹配 / 限流），不再静默返回空数组；
 *   · `items`：与 `characters` 同引用的别名（部分调用方按 items 取名）；
 *   · `via`：这条数据实际是谁给的（`jikan` = MAL，`anilist` = AniList 兜底）；
 *   · `imageSource`：立绘图床，界面上要照实标注（用户很在意「到底是谁给的图」）。
 */
export async function jikanCharactersByTitle(title: string): Promise<{
  anime: JikanAnime | null
  characters: JikanCharacter[]
  items: JikanCharacter[]
  via: 'jikan' | 'anilist' | 'none'
  imageSource: 'myanimelist' | 'anilist' | null
  reason?: string
}> {
  const asked = String(title ?? '').trim()
  if (!asked) {
    return { anime: null, characters: [], items: [], via: 'none', imageSource: null, reason: '标题为空' }
  }
  const resolved = await resolveMalIdByTitle(asked)
  if (!resolved.anime) {
    log.append('warn', 'jikan', `角色数据源 Jikan：没能把「${asked}」解析到 MAL 条目 —— ${resolved.reason}`)
    return { anime: null, characters: [], items: [], via: 'none', imageSource: null, reason: resolved.reason }
  }
  const chars = await jikanCharactersDetailed(resolved.anime.malId)
  if (chars.items.length > 0) {
    log.append(
      'info',
      'jikan',
      `角色数据源 Jikan：${asked} → ${resolved.anime.title}（MAL #${resolved.anime.malId}）${chars.items.length} 位角色（${chars.ms}ms）`
    )
    return {
      anime: resolved.anime,
      characters: chars.items,
      items: chars.items,
      via: resolved.via === 'anilist' ? 'anilist' : 'jikan',
      imageSource: 'myanimelist'
    }
  }
  // Jikan 角色端点挂了（实测 504 重灾区）→ 最后一条路：AniList 的角色表
  const alt = await anilistCharactersByMalId(resolved.anime.malId)
  if (alt.items.length > 0) {
    log.append(
      'warn',
      'jikan',
      `Jikan 角色接口不可用（${chars.reason || '返回为空'}），已改用 AniList 取 ${alt.items.length} 位角色（MAL #${resolved.anime.malId}，注意图床是 AniList）`
    )
    return {
      anime: resolved.anime,
      characters: alt.items,
      items: alt.items,
      via: 'anilist',
      imageSource: 'anilist',
      reason: `Jikan 角色接口不可用（${chars.reason || '返回为空'}），本次角色与立绘改由 AniList 提供`
    }
  }
  const reason = `已解析到 MAL #${resolved.anime.malId}《${resolved.anime.titleCn}》，但角色取不到：Jikan ${chars.endpoint} → ${chars.reason || '返回为空'}；AniList → ${alt.reason || '返回为空'}`
  log.append('warn', 'jikan', `角色数据源 Jikan 失败：${asked} —— ${reason}`)
  return {
    anime: resolved.anime,
    characters: [],
    items: [],
    via: resolved.via === 'anilist' ? 'anilist' : 'jikan',
    imageSource: null,
    reason
  }
}

/**
 * 当前是否正在 429 退避，以及还要等多久（毫秒；不在退避中为 0）。
 *
 * 给**兜底链路**用：反代挂掉时，如果 Jikan 正在限流退避，
 * 「先等退避、再发 Jikan、失败了才轮到 AniList」会让界面卡十几秒 ——
 * 这种情况下直接跳过 Jikan 那一档、立刻用 AniList 更合理（反正服务端已经说了「别来」）。
 */
export function jikanBackoffRemainMs(): number {
  return Math.max(0, backoffUntil - Date.now())
}

/**
 * 自检用：当前节流窗口状态。
 *
 * v0.3.2 扩展（**保持 `lastMinute` 字段不变**，向后兼容）：
 *   · `lastSecond`：最近 1 秒的请求数（验证 3 次/秒）；
 *   · `totalRequests`：本进程真正发出去的请求数（证明「主数据源正常时 Jikan 一次都没发」）；
 *   · `inBackoff` / `backoffRemainMs`：是否正在 429 退避；
 *   · `lastError` / `recent`：最后一次失败与最近若干次尝试（带原始状态码），
 *     用户报「Jikan 没生效」时，看这里就能分清是 504 上游挂、429 限流还是标题没匹配上。
 */
export function jikanThrottleState(): {
  lastMinute: number
  lastSecond: number
  totalRequests: number
  inBackoff: boolean
  backoffRemainMs: number
  lastError: { path: string; status: number | null; message: string; at: number } | null
  recent: JikanAttempt[]
  limits: { perSecond: number; perMinute: number }
  anilist: { requests: number; inBackoff: boolean }
} {
  const now = Date.now()
  return {
    lastMinute: stamps.filter((t) => now - t < 60_000).length,
    lastSecond: stamps.filter((t) => now - t < 1000).length,
    totalRequests: requestCount,
    inBackoff: backoffUntil > now,
    backoffRemainMs: Math.max(0, backoffUntil - now),
    lastError: lastFailure,
    recent: recentAttempts.map((a) => ({ ...a })),
    limits: { perSecond: PER_SECOND, perMinute: PER_MINUTE },
    anilist: { requests: anilistCount, inBackoff: anilistBackoffUntil > now }
  }
}

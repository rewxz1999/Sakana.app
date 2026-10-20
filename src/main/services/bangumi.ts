import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import type {
  CachedSubjectResult,
  CalendarDay,
  CalendarResult,
  CharacterItem,
  CharactersResult,
  CoverImages,
  EpisodeProgress,
  MirrorTestResult,
  Rating,
  RatingResult,
  SearchResult,
  SearchResultItem,
  SeasonItem,
  SeasonResult,
  SourceError,
  SubjectDetail,
  SubjectResult
} from '@shared/types'
import { monthsOfSeason, seasonIndexOfMonth, seasonOfDate } from '@shared/season'
import { log } from '../log'
import { beginNetTrace, type NetPriority } from '../net-priority'
import { BROWSER_UA, buildProxyAgents, chromiumGetText, getSettings, streamGetText } from '../net'
import { store } from '../store'
import {
  authHeadersFor,
  beginEndpointRequest,
  builtInImgOrigin,
  endpointLabelOf,
  isBuiltInBangumiApi,
  isBuiltInBangumiHost,
  orderBangumiEndpoints,
  resolveBangumiEndpoints
} from './bangumiProxy'
import { parseCalendar, parseRatingOnly, parseSearchPage, parseSubjectPage } from './bangumiHtml'
import {
  anilistSearchAnime,
  anilistSeasonAnime,
  jikanAnimeById,
  jikanAnimeSearch,
  jikanBackoffRemainMs,
  jikanSeason,
  jikanSeasonNow,
  jikanTopAiring,
  mergeJikanAnime,
  type JikanAnime
} from './jikan'
import {
  isAiringNow,
  jikanToCalendarDays,
  jikanToSearchItem,
  jikanToSeasonItem,
  jikanToSubjectDetail,
  malIdFromFallbackId,
  withJikanFallback,
  type JikanFallbackMeta
} from './jikanMap'
import { offscreenGet } from './offscreenFetch'

const TTL_CALENDAR = 30 * 60 * 1000

/**
 * 端点隔离表（V1.5.1）：baseUrl → 解禁时间戳。
 *
 * 只用于**确定性错误**（例如某个 Worker 对所有路径返回 404 —— 配置问题），
 * 不用来惩罚超时/抖动：那类问题靠"在途最少优先"的调度自动绕开，
 * 一旦隔离反而会把好端点也误伤。
 */
const endpointQuarantine = new Map<string, number>()

/**
 * 预热番剧表首屏封面（V1.4）。
 *
 * 为什么放在这里：用户抱怨"图片加载很慢"，实测**图片本身并不慢**（热缓存 10 张 110ms），
 * 慢的是"数据到了之后才一张张去取"这段。数据一拿到就先取前 18 张丢进取图队列，
 * 渲染层再要时基本都命中磁盘缓存，观感从"逐张蹦"变成"一起出来"。
 *
 * 用动态 import 避免 bangumi ↔ media 的循环依赖（media.ts 静态引用本文件）。
 * 失败静默：预取只是优化，不能因为它的异常影响番剧表返回。
 */
function prefetchCovers(days: CalendarDay[]): void {
  void (async () => {
    try {
      const urls: string[] = []
      for (const day of days) {
        for (const item of day.items ?? []) {
          const u = item.images?.common ?? item.images?.large ?? item.images?.medium
          if (u) urls.push(u)
          if (urls.length >= 18) break
        }
        if (urls.length >= 18) break
      }
      if (urls.length === 0) return
      const { prefetchImages } = await import('./media')
      await prefetchImages(urls, 18)
    } catch {
      /* 预取失败不影响主流程 */
    }
  })()
}

/*
 * 详情缓存（v0.2.7 附加：7 天 → 30 天）。
 *
 * 自建反代是个人的 Worker 服务，条目详情（infobox / 标签 / 制作信息）属于**几乎不变**的数据，
 * 真正的压力来自「同一部番反复打开详情页 + 播放器详情面板再次请求」。
 * 延长缓存是最省反代、又完全不削减详情的办法：数据仍是完整的 v0 详情，
 * 只是不再频繁往返；用户手动「刷新」时走的是下面的 stale-while-revalidate。
 */
const TTL_SUBJECT = 30 * 24 * 3600 * 1000
const TTL_SEARCH = 30 * 60 * 1000
/**
 * 评分缓存（番剧表「补评分」用）。
 *
 * ⚠️ v0.3.7 修正：原来是 **30 天**，用户实测报「一些番剧的评分和 bangumi 原站有出入」——
 * 取证结果（`.e2e/probe-rating-stale.mjs`）：本地 12 份评分缓存里 **9 份已经和反代当前值不同**，
 * 缓存年龄约 266 小时（11 天），例如同一部番缓存里是 5.3、当时是 4.9。
 * 正在放送的番剧评分**每天都在动**，30 天对这类数据等于「永久钉住」。
 *
 * 现在改成 6 小时：一天最多 4 次，仍远低于「每次打开番剧表都请求」的压力，
 * 又能保证用户看到的分数与站点最多差半天。
 * （番剧表的卡片显示也一并改成**优先用日历自带的新评分**，见 SchedulePage —— 双保险。）
 */
const TTL_RATING = 6 * 3600 * 1000
/**
 * 分集进度缓存（「更新到第几集」）。
 *
 * 集数一周才动一次，理论上可以缓存很久；但用户点进详情页时最想看到的就是
 * **刚刚更新的那一集**，所以取 6 小时这个「半天内必然刷新一次」的值，
 * 一个条目一天最多 4 次请求，相对反代的其它请求量可以忽略。
 */
const TTL_EPISODES = 6 * 3600 * 1000
/**
 * 季度条目缓存（v0.2.9 附加）。
 *
 * 一个季度的条目（名称/封面/放送日/评分）是**几乎不变**的数据，
 * 而这个接口一次要打三个月份（见 season()），是反代上最贵的查询之一。
 * 7 天足以覆盖「当季新番陆续追加」的节奏，同时让「关掉弹窗再打开」完全不联网。
 */
const TTL_SEASON = 7 * 24 * 3600 * 1000
/**
 * 角色表缓存（「最XX的角色 9宫格」工具，v0.2.11 附加）。
 *
 * 一个条目的角色表（名字/立绘/关系）和详情一样属于**几乎不变**的数据，
 * 而九宫格工具会反复切作品、来回看角色，走 30 天缓存能省掉大量反代往返
 * （反代是个人的 Worker，能少打一次就少打一次）。
 */
const TTL_CHARACTERS = 30 * 24 * 3600 * 1000
/**
 * 每个月份的取数上限。
 *
 * 实测反代支持 `limit=100`：2026 年 4 月（新番最多的一个月）`total=75`，
 * 一页就能取全；余下月份都在 10 条量级。超过 100 条的月份现实中不存在，
 * 因此这里不做分页，只取一页（真出现时也只会少几条尾巴，不会报错）。
 */
const SEASON_PAGE_LIMIT = 100
/**
 * V1.4：12s → **22s**。
 *
 * 12 秒是按"反代首包 1~8 秒"定的，但换成**内置双反代**之后实测（子代理在同一台机器上各打 3 次
 * `/v0/subjects/26803`）：api-1 = 13.1s / 12.2s / 超时，api-2 = 超时 / 38.0s / 1.2s。
 * 也就是说 12 秒会把**一部分本来能成功的请求**判死 —— 真机日志里能直接看到
 * `/calendar 失败 0.0KB 12022ms`、`/v0/subjects/… 失败 12010ms` 这种"刚好卡在 12 秒"的行。
 * 22 秒覆盖到实测的 13~20 秒档；超过 22 秒基本就是端点挂了，交给上层的换端点重试。
 */
const REQUEST_TIMEOUT = 22000
/**
 * 统一请求超时（分级取消后）。
 *
 * 以前 S=8s / A=20s / B=12s，跟着"级别"走；现在分级已废弃，所有 bangumi 请求同一条 FIFO 队列，
 * 超时也必须只有一套，否则等于换个地方继续分级。取 12 秒的理由：
 *   · 详情/日历/季度检索都走反代，实测成功请求的首包在 1~8 秒，12 秒足够覆盖正常慢请求；
 *   · 失败时尽快把错误交给上层（上层还有一次短退避重试），比"等 20 秒再失败"体验好；
 *   · 与搜索/分集等接口原本的 REQUEST_TIMEOUT 一致，不再出现"同一反代两套超时"。
 */
const BANGUMI_TIMEOUT = REQUEST_TIMEOUT

/**
 * Jikan 兜底的缓存（v0.3.2 新增）。
 *
 * ⚠️ **兜底数据绝不写进上面那些 bangumi 缓存键**（`calendar` / `search-*` / `season-*` / `subject*`）。
 *
 * 为什么必须分开：主缓存是「反代恢复后照旧可用」的那一份。如果把 Jikan 的数据写进 `calendar`，
 * 反代恢复之后进程读到的仍是 MAL 的番剧表（30 分钟 TTL 内都翻不了身），
 * 界面上还会以为这是 Bangumi 的数据 —— 表现为「反代明明好了，番剧表还是不对」。
 * 所以兜底走**独立的 `jikan-*` 键**，而且只有「主数据源全挂」时才会被读到：
 * 主数据源一恢复，正常路径就把自己的键覆盖回 Bangumi 数据，`jikan-*` 只是自然过期。
 *
 * TTL 的取法：番剧表/季度列表/搜索都取「短」——
 * 反代挂了是**临时状态**，用户多半几分钟内就会修好（换镜像、开代理），
 * 兜底数据只用来撑过这段时间，没必要长期留着（也避免它被误当成正式数据）。
 */
const TTL_JIKAN_CALENDAR = 15 * 60 * 1000
const TTL_JIKAN_SEASON = 6 * 3600 * 1000
const TTL_JIKAN_SEARCH = 10 * 60 * 1000
const TTL_JIKAN_SUBJECT = 30 * 24 * 3600 * 1000

/** 兜底搜索给 AniList 命中的**前几条**补一次 MAL 详情（见 jikanSearchFallback 的说明） */
const JIKAN_SEARCH_ENRICH_MAX = 3

/** 兜底取数的返回：`meta.reason` 在失败时说明「为什么没兜到」，成功时为空串 */
interface FallbackOutcome<T> {
  value: T
  meta: JikanFallbackMeta
}

/**
 * 兜底也失败时，把原因**并进原来的错误信息**。
 *
 * 为什么要并：用户拿到的是界面上的那句错误（以及日志）。如果只写「所有 bangumi 镜像均不可访问」，
 * 他无从判断「兜底到底试没试、为什么没兜到」——而这两件事决定了下一步该做什么
 * （是去换镜像，还是等 Jikan 上游恢复）。所以把兜底用过的端点与最终原因直接附在后面。
 */
/**
 * 本地日期字符串 `YYYY-MM-DD`（**不用** `toISOString()`）。
 *
 * 「更新到第几集」要拿今天的日期和每集的 `airdate` 比大小，而 `airdate` 就是
 * 放送日历上的日期（东八区的番剧「7 月 6 日播出」指的就是本地的 7 月 6 日）。
 * `toISOString()` 走 UTC：在 UTC+8 的凌晨 0–8 点会把本地「今天」算成 UTC 的昨天，
 * 于是刚播出的那一集会被判成「还没播」—— 追番的人恰恰常在这个点看更新。
 */
function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function appendFallbackFailure(error: SourceError, meta: JikanFallbackMeta): void {
  if (!meta.reason) return
  error.message = `${error.message}；Jikan 兜底也失败：${meta.reason}`
  if (meta.endpoints?.length) error.tried = [...error.tried, ...meta.endpoints]
}

/**
 * 把请求地址压成「只含路径、不含主机」的日志标签。
 *
 * 为什么不用完整 URL：红线要求日志/界面绝不出现自建反代或内部接口地址。
 * `log.append` 本身会脱敏，但多一层保险 —— 标签在进入日志系统之前就已经没有主机名了。
 * 搜索关键词可能出现在路径里，所以搜索类请求**不调用这个函数**，直接传固定标签「搜索」。
 */
function safePathLabel(url: string): string {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '') || '/'
    return p.length > 72 ? `${p.slice(0, 68)}…` : p
  } catch {
    return '请求'
  }
}

interface CacheEntry<T> {
  fetchedAt: number
  data: T
}

function makeSourceError(kind: SourceError['kind'], message: string, tried: string[]): SourceError {
  return { kind, message, tried }
}

/**
 * 把请求异常压成一句**不含地址**的原因（超时/HTTP 5xx/连接重置…）。
 *
 * 为什么单独写：错误信息会进日志、也会经 `SourceError.message` 显示在界面上。
 * axios 的 message 偶尔会带 URL，直接拼出去等于把反代地址泄露到界面；
 * 这里统一只保留可读原因，地址交给上层用 `api-1` / `api-2` 这类标签表示。
 */
function describeRequestError(err: unknown): string {
  const e = err as { code?: string; message?: string } | undefined
  if (e?.code === 'ECONNABORTED') return '超时'
  const raw = String(e?.message ?? err ?? '请求失败')
  return raw.replace(/https?:\/\/\S+/gi, '<地址已隐藏>').slice(0, 160)
}

function isApiHost(host: string): boolean {
  return host.startsWith('api.') || host.includes('api.bgm')
}

/** 已被墙的公共镜像：默认跳过（用户实测 bangumi.pro 已不可达，请求它只是白等） */
const DEAD_MIRRORS = ['bangumi.pro']

/**
 * 单飞（single-flight）：同一条逻辑请求在同一时刻只发一次。
 *
 * 实测最典型的重复请求：番剧详情页与播放器的「详情」面板会同时请求同一部番，
 * 以及切集时旧实例的收尾请求。合并后反代实际收到的请求数直接减半，而返回的数据一模一样。
 *
 * ⚠️ 改成双端点后，key 必须用**逻辑路径**而不是完整 URL：
 * 如果按 URL 去重，同一部番的两个并发调用会分别选中 api-1 / api-2，
 * 等于既没单飞、又把同一份数据向两套反代各要了一遍（正好抵消负载分担的收益）。
 */
const jsonInflight = new Map<string, Promise<unknown>>()

function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = jsonInflight.get(key) as Promise<T> | undefined
  if (existing) return existing
  const p = fn().finally(() => {
    jsonInflight.delete(key)
  })
  jsonInflight.set(key, p)
  return p
}

/** 连接被重置 / 中断（中间设备或站点限流导致），值得隔几秒重试一次 */
function isNetworkReset(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined
  const s = `${e?.code ?? ''} ${e?.message ?? ''}`
  return /ECONNRESET|ECONNABORTED|ERR_CONNECTION_RESET|socket hang up|EPIPE|ETIMEDOUT|timeout/i.test(s)
}

/**
 * 是否是 JS 机器人校验页（Anubis / Cloudflare）。
 * bangumi.vip 的校验页只有 14KB、标题是「正在确认你是不是机器人！」，
 * 直连拿到它时必须改用离屏浏览器重新打开。
 */
function looksLikeChallenge(text: string): boolean {
  if (!text) return true
  return (
    text.length < 20000 &&
    /正在确认你是不是机器人|Just a moment|challenges\.cloudflare|within\.website\/x\/cmd\/anubis|Checking your browser/i.test(
      text
    )
  )
}

/**
 * 这个地址是否是「配好的 API 反代端点」（内置双反代或用户自定义）。
 *
 * 以前是拿设置里的单个 `bangumiCustomApi` 做字符串比较；现在端点池可能有两个内置端点，
 * 所以统一问 `resolveBangumiEndpoints` —— 否则 `calendarPathFor` / `isApiMirror` 会把
 * 内置端点当成网页镜像，拼出错的 `/v0/calendar` 或按 HTML 去解析 JSON。
 */
function isCustomApiBase(mirror: string): boolean {
  const base = mirror.trim().replace(/\/+$/, '')
  if (!base) return false
  return resolveBangumiEndpoints(getSettings().bangumiCustomApi).some((ep) => ep.baseUrl === base)
}

/**
 * 该镜像应按 API（`/v0/...` JSON）还是网页（HTML）语义解析。
 *
 * 过去用 `mirror.includes('api.')` 做字符串匹配：自建反代的域名往往不含 `api.`
 * （例如 `https://bgm-proxy.xxx.workers.dev`），于是请求按 JSON 走、解析却按 HTML 走，
 * 结果必然「解析为空」—— 这是接入自建反代时最先踩到的坑。
 * 这里统一按 URL 主机名判断，并显式认下配置过的自建反代。
 */
function isApiMirror(mirror: string): boolean {
  if (isCustomApiBase(mirror)) return true
  try {
    return isApiHost(new URL(mirror).hostname)
  } catch {
    return mirror.includes('api.')
  }
}

/**
 * 搜索关键词变体（v0.2.12）。
 *
 * 起因：用户搜「little busters」搜不到，但 Bangumi 网页能搜到。
 * 除了接口本身的问题（见 `searchRace` 的注释），还有一个真实存在的匹配差异：
 * 官方条目标题是 `リトルバスターズ！` / `Little Busters!`，
 * 而搜索端对**标点、全角半角、大小写**的处理规则各不相同 ——
 * 实测老接口对 `little busters` 能命中（5 条），但对带 `!` 的写法在 v0 上更容易踩到分词问题。
 *
 * 所以这里生成一组「同一意图的写法」，按顺序重试：
 *   ① 原样；
 *   ② 去掉英文/日文标点与波浪线、合并空格（`Little Busters!` → `Little Busters`）；
 *   ③ 全角转半角 + 去掉多余的 `～`/`〜`/`・`（`無職転生 ～…～` → `無職転生`）。
 * 变体只在「上一条路没结果」时才用，正常关键词还是原样发一次，不会拖慢搜索。
 */
function searchKeywordVariants(keyword: string): string[] {
  const raw = keyword.trim()
  if (!raw) return [raw]
  const out: string[] = [raw]
  const push = (v: string): void => {
    const s = v.replace(/\s+/g, ' ').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  // ② 去标点
  push(raw.replace(/[!！?？~～〜・:：,，.。、'’"“”\-–—_/\\]+/g, ' '))
  // ③ 全角转半角后再去标点（中文全角括号、英文字母全角等）
  const half = raw.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  push(half.replace(/[!?~:,.、'"_\-/\\]+/g, ' '))
  return out.slice(0, 3)
}

/**
 * 是否是 bgm 系图床（需要改写到自建图片反代的地址）。
 *
 * v0.2.7 附加修：过去只认 `*.bgm.tv`，而**收藏/订阅里存的封面全是镜像图床**
 * （实测 12 条收藏、3 条订阅的封面都是 `https://lain.bangumi.pro/pic/cover/l/…`），
 * 这些域名不在判定里 → 从不改写 → 直连已墙的 bangumi.pro → 封面一律不显示。
 * 同一路径经图片反代取是 200 image/jpeg（实测 369KB / 500KB），所以只要认下来就能救回。
 */
function isBangumiImageHost(host: string): boolean {
  const h = host.toLowerCase()
  if (/(^|\.)bgm\.tv$/.test(h)) return true // lain.bgm.tv / bgm.tv
  if (/^lain\.bangumi\./.test(h)) return true // lain.bangumi.pro / .vip / .lol（镜像站图床）
  // 镜像站主域名的图床（少数条目直接引用主站路径）
  return /(^|\.)bangumi\.(pro|vip|lol|top|tv|fun|cc|me|one|in|site|plus)$/.test(h)
}

/**
 * 把 bgm 系图床地址改写到自建图片反代（Worker 的 IMG_HOST）。
 *
 * Worker 按**路径**转发（`/pic/cover/l/xxx.jpg`），并且支持**按需缩放**：
 * `{IMG_HOST}/r/<宽>/pic/cover/l/xxx.jpg` 会在 Worker 侧缩放到指定宽度。
 * 所以拼接时要保留反代地址自带的路径前缀（`/img`），并在路径前插入 `/r/<宽>`。
 *
 * ⚠️ v0.2.7 修：过去这里用的是 `base.origin`，把反代地址里的 `/img` 前缀丢掉了 ——
 * 于是所有 `lain.bgm.tv` 封面都请求到 `https://反代/pic/...`（404），表现为「图片加载不出来」。
 * 实测：丢掉前缀 → 404；带上 `/img` → 200 image/jpeg。
 *
 * ⚠️ v0.2.7 附加 修「番剧表 / 订阅 / 收藏的卡片经常加载不出来」：
 * 这些卡片取的是 `large` 封面，实测原图 **916KB、单张 5~9 秒**，并发一高直接劣化到几十秒；
 * 而同一张图走缩放路径 `/r/400/` 只有 **53KB、0.66 秒**（`/r/200/` 16KB）——
 * 反代本来就支持缩放，是我们没走。现在统一改写为缩放路径，卡片/详情页画质完全够用。
 */
export function rewriteImageUrl(url: string, width = 400): string {
  if (!url) return url
  const custom = (getSettings().bangumiCustomImg ?? '').trim().replace(/\/+$/, '')
  /*
   * V1.4 修「番剧表封面全空」：
   *
   * 上一版假设"新反代在 API 响应里直接返回它自己的图片域名"，于是没填自定义图片反代时**原样返回**。
   * 真机抓包推翻了这条假设：日历/番剧表的封面仍然是 `http://lain.bgm.tv/pic/cover/…`，
   * 而 lain.bgm.tv 在本机实测 **20 秒超时（code=000）** —— 封面一张都出不来。
   * 同一路径走内置图片反代是 200（原图 177KB/1.66s，`/r/400/` 缩放后 4.4KB/1.08s）。
   *
   * 所以改成：**没有自定义图片反代（或填的是内置的）时，用内置图片站兜底改写**；
   * 用户自己填了第三方图片反代就仍然优先用他的。
   */
  let base: URL | null = null
  if (custom && !isBuiltInBangumiHost(custom)) {
    try {
      base = new URL(custom)
    } catch {
      base = null
    }
  }
  if (!base) {
    const builtIn = builtInImgOrigin()
    if (!builtIn) return url
    try {
      base = new URL(builtIn)
    } catch {
      return url
    }
  }
  try {
    const u = new URL(url)
    // 只改 bgm 系图床（含镜像站图床），其它地址（含反代自己已带 /r/ 的地址）保持原样
    if (!isBangumiImageHost(u.hostname)) return url
    /*
     * 注意：这里不能再写 `const base = new URL(custom)`（会遮蔽上面算好的 base）。
     * custom 为空时 new URL('') 抛错，被 catch 吞掉后直接 return url，
     * 于是改写永远不生效，日志里仍是那个已失效的原始图床地址。
     */
    const prefix = base.pathname.replace(/\/+$/, '') // 例如 "/img"
    // 已经是缩放路径就不要重复加前缀
    const path = width <= 0 || /^\/r\/\d+\//.test(u.pathname) ? u.pathname : `/r/${width}${u.pathname}`
    return `${base.origin}${prefix}${path}${u.search}`
  } catch {
    return url
  }
}

/** 去掉缩放前缀（`/img/r/400/pic/…` → `/img/pic/…`）：缩放路径万一不可用时的兜底 */
export function unresizedImageUrl(url: string): string {
  if (!url) return url
  /*
   * 与 rewriteImageUrl 同一套基准：用户没填第三方图床时，用内置图片站判定。
   * 过去这里在 custom 为空时直接原样返回 —— 于是"缩放路径失败 → 改取原图"这条兜底
   * 在默认配置下等于没启用。
   */
  const custom = (getSettings().bangumiCustomImg ?? '').trim().replace(/\/+$/, '')
  let origin = ''
  if (custom && !isBuiltInBangumiHost(custom)) {
    try {
      origin = new URL(custom).origin
    } catch {
      origin = ''
    }
  }
  if (!origin) {
    try {
      const builtIn = builtInImgOrigin()
      origin = builtIn ? new URL(builtIn).origin : ''
    } catch {
      origin = ''
    }
  }
  if (!origin) return url
  if (!url.startsWith(origin)) return url
  return url.replace(/\/r\/\d+\//, '/')
}

/**
 * 把 bgm v0 的 infobox 压成「一定可渲染」的 `{key, value: string}` 列表。
 *
 * v0 的 `value` 有两种形态：
 * - 字符串：`{"key":"导演","value":"斎藤圭一郎"}`（多数）
 * - **对象数组**：`{"key":"别名","value":[{"v":"Frieren…"},{"v":"葬送的芙莉蓮"}]}`
 *   （实测 400602 的 41 条里有 1 条是数组，`别名`/`链接`/`放送星期` 常见）
 *
 * 过去类型标注成 `value: string` 就直接丢给 React 渲染，数组命中时 React 会抛
 * "Objects are not valid as a React child"，整张详情页白屏 ——
 * 这也是「详情加载不出来」的一种。这里统一转字符串：
 * 数组按 `、` 连接，元素取 `v`（缺省取 `k`），并去掉重复与空值。
 */
function normalizeInfobox(raw: unknown): { key: string; value: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { key: string; value: string }[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const key = String((entry as { key?: unknown }).key ?? '').trim()
    if (!key) continue
    const v = (entry as { value?: unknown }).value
    let value = ''
    if (Array.isArray(v)) {
      const parts = v
        .map((item) => {
          if (item === null || item === undefined) return ''
          if (typeof item === 'object') {
            const o = item as { v?: unknown; k?: unknown }
            return String(o.v ?? o.k ?? '').trim()
          }
          return String(item).trim()
        })
        .filter((s) => s.length > 0)
      value = Array.from(new Set(parts)).join('、')
    } else if (v !== null && v !== undefined) {
      value = String(v).trim()
    }
    if (!value) continue
    out.push({ key, value })
  }
  return out
}

/**
 * bangumi 数据源（方案 3.10：镜像降级机制）
 * - 网页镜像（bangumi.pro / bangumi.lol / bgm.tv 网页版）：浏览器 UA + HTML 解析
 *   （这些站有 Cloudflare 防护，且不提供 JSON API）
 * - API 镜像（api.bgm.tv）：v0 JSON API（主站一般需代理，见设置页）
 * - 全部镜像失败返回 ALL_DOWN，渲染层据此弹出 VPN/代理提示
 * - 结果磁盘缓存（方案 7：数据优先本地缓存）
 */
class BangumiService {
  /**
   * 条目 JSON 缓存目录：settings.cacheDir 优先（留空 = userData/cache），
   * 与「设置 → 缓存设置」中的缓存目录保持一致。
   */
  private get cacheDir(): string {
    const custom = getSettings().cacheDir?.trim()
    const dir = join(custom || join(app.getPath('userData'), 'cache'), 'bangumi')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* 目录不可写时由实际写入方报错 */
    }
    return dir
  }
  /** 本会话是否已完成一次日历联网更新（此后不再自动访问数据源，除非用户手动刷新） */
  private calendarSessionFresh = false

  init(): void {
    mkdirSync(this.cacheDir, { recursive: true })
    this.migrateMirrors()
    /*
     * 启动时把「实际会用哪种数据源」写进运行日志。
     * 只写类型与数量，**绝不写地址**：内置反代地址与 PSK 是用户要求隐藏的红线，
     * 自定义地址也不该因为排障被复制进日志。
     */
    const custom = (getSettings().bangumiCustomApi ?? '').trim()
    const usingCustom = Boolean(custom) && !isBuiltInBangumiApi(custom)
    const endpointCount = resolveBangumiEndpoints(custom).length
    log.append(
      'info',
      'bangumi',
      usingCustom
        ? '数据源：自定义 API 反代（地址已隐藏）'
        : `数据源：内置双反代 ${endpointCount} 个端点（地址已隐藏，按在途请求数分担）`
    )
  }

  /**
   * 数据源迁移（从旧版「单个反代地址写进设置」升级到「内置双端点 + 地址不落盘」）。
   *
   * 为什么必须在启动时做：
   *   · 老安装的 settings.json 里存着旧反代地址（现在属于内置端点之一）和旧图片反代地址；
   *     不清理的话，用户升级后设置文件里仍有一份明文地址，与"地址隐藏"的目标直接冲突；
   *   · 旧版还把反代地址写进了 `bangumiBase` / `dataSources.main`，界面会把它当主数据源显示；
   *   · 这些字段一旦残留在磁盘上，用户复制一份 settings.json 就等于把地址带出去了。
   *
   * 迁移规则：
   *   · `bangumiCustomApi` 若等于内置端点（旧默认值），清空 → 自动使用内置双端点；
   *   · `bangumiCustomImg` 若属于内置反代主机（旧图片地址），清空 → 图片改由 API 响应自带；
   *   · `bangumiBase` / `bangumiMirrors` / `dataSources` 里属于内置反代主机的条目全部剔除，
   *     主数据源回落到公共镜像（只作为显示/测试用的安全兜底，不参与真实取数）。
   * 只有实际发生变化时才写盘，避免每次启动都触发一次 settings 落盘。
   */
  private migrateMirrors(): void {
    try {
      const s = getSettings() as unknown as {
        bangumiBase?: string
        bangumiMirrors?: string[]
        dataSources?: { main?: string; mirrors?: string[] }
        bangumiCustomApi?: string
        bangumiCustomImg?: string
        mirrorVipMigrated?: boolean
        proxyMigrated?: boolean
        proxyMainMigrated?: boolean
      }
      const norm = (v: unknown): string => String(v ?? '').trim().replace(/\/+$/, '')
      const VIP = 'https://bangumi.vip'

      const customRaw = norm(s.bangumiCustomApi)
      // 旧默认地址就是内置端点之一：清空它，让 resolver 用内置双端点，而不是把它当"用户自定义"
      const custom = isBuiltInBangumiApi(customRaw) ? '' : customRaw
      const imgRaw = norm(s.bangumiCustomImg)
      // 旧图片地址属于内置反代主机：清空，图片 URL 以后从 API 响应里取
      const img = isBuiltInBangumiHost(imgRaw) ? '' : imgRaw

      /** 清掉内置反代/已死镜像，并保证公共镜像列表至少有一个可用项 */
      const cleanList = (list: unknown): string[] => {
        const arr = Array.isArray(list) ? list : []
        const out = arr
          .map(norm)
          .filter(Boolean)
          .filter((m) => !isBuiltInBangumiApi(m) && !isBuiltInBangumiHost(m))
          .filter((m) => !DEAD_MIRRORS.some((d) => m.includes(d)))
        if (!out.includes(VIP)) out.unshift(VIP)
        return [...new Set(out)]
      }
      const mirrors = cleanList(s.bangumiMirrors)
      const dsMirrors = cleanList(s.dataSources?.mirrors)
      const safeMain = (v: unknown): string => {
        const n = norm(v)
        /*
         * 主数据源只能落成**公共镜像列表里的一个**：
         * 自定义 API 地址单独存 `bangumiCustomApi`，不再复制进 bangumiBase / dataSources.main。
         * 否则设置文件与「当前主数据源」卡片会多出一份明文地址，违背"地址隐藏"的目标。
         */
        return n && mirrors.includes(n) ? n : mirrors[0] || VIP
      }
      const base = safeMain(s.bangumiBase)
      const dsMain = safeMain(s.dataSources?.main)

      const oldMirrors = (Array.isArray(s.bangumiMirrors) ? s.bangumiMirrors : []).map(norm)
      const oldDsMirrors = (Array.isArray(s.dataSources?.mirrors) ? s.dataSources!.mirrors! : []).map(norm)
      const changed =
        custom !== customRaw ||
        img !== imgRaw ||
        base !== norm(s.bangumiBase) ||
        dsMain !== norm(s.dataSources?.main) ||
        JSON.stringify(mirrors) !== JSON.stringify(oldMirrors) ||
        JSON.stringify(dsMirrors) !== JSON.stringify(oldDsMirrors)
      if (!changed) return

      store.set('settings', {
        ...(s as Record<string, unknown>),
        bangumiCustomApi: custom,
        bangumiCustomImg: img,
        bangumiBase: base,
        bangumiMirrors: mirrors,
        dataSources: { main: dsMain, mirrors: dsMirrors },
        // 旧迁移标记一并置位：避免任何旧代码路径再把旧默认地址写回来
        proxyMigrated: true,
        proxyMainMigrated: true,
        mirrorVipMigrated: true
      })
      log.append('info', 'bangumi', '数据源配置已迁移：内置反代地址与图片地址不再写入设置文件（地址已隐藏）')
    } catch (err) {
      log.append('warn', 'bangumi', `数据源迁移失败（忽略）: ${String((err as Error)?.message ?? err)}`)
    }
  }

  /** 公共镜像列表（**不含内置反代**：内置端点由 bangumiProxy 的端点池单独调度，地址不落设置） */
  private mirrors(): string[] {
    const s = getSettings()
    const list = Array.isArray(s.bangumiMirrors) && s.bangumiMirrors.length > 0
      ? s.bangumiMirrors
      : [s.bangumiBase || 'https://bangumi.vip']
    const normalized = list.map((m) => m.replace(/\/+$/, ''))
    /*
     * 自建反代不再混进公共镜像列表。
     *
     * 以前这里把 `bangumiCustomApi` 排第一，是为了"测试连接"时先展示反代；
     * 现在反代地址既不进设置也不进界面，继续混进来只会让测试/回退逻辑把内置端点
     * 当成普通镜像，从而绕过 PSK 与负载分担。
     */
    const publicOnly = normalized.filter((m) => !isBuiltInBangumiApi(m) && !isBuiltInBangumiHost(m))
    // bangumi.pro 已确认不可达：无条件剔除。实测启动瞬间并发请求过多时，
    // 连带把可用镜像的连接也一起被中间设备重置，少发无用请求能显著提高成功率。
    const alive = publicOnly.filter((m) => !DEAD_MIRRORS.some((d) => m.includes(d)))
    return [...new Set(alive)]
  }

  /**
   * 进程内一级缓存（v1.1.4 性能改造）。
   *
   * 为什么需要：详情/日历/季度/评分全是「磁盘 JSON + 每次 JSON.parse」。
   * 单个文件不大（详情约 8KB、日历 68KB），但番剧表一屏要读评分 ×N、
   * 标签屏蔽打开时还要逐条读详情 —— 反复解析同一份 JSON 纯属浪费，
   * 而用户抱怨的正是「读取慢」。这里按 (mtime, size) 判断文件是否被别的进程改过，
   * 命中时**直接复用已解析对象**，把「读磁盘 + 解析」降到一次 Map 查找（约 0.01ms）。
   *
   * 为什么可以复用同一份对象而不每次深拷贝：本项目里缓存条目一律**只读**
   * （所有写路径都是 read → 生成新对象 → writeCache），IPC 返回时 structuredClone 由 Electron 完成。
   * 唯一需要小心的是「读到对象后原地改字段」，本文件里没有这种写法（mergeFreshRating 用展开生成新对象）。
   */
  private l1 = new Map<string, { mtimeMs: number; size: number; entry: CacheEntry<unknown> }>()

  /**
   * 已经打过「命中缓存」日志的键。
   * 为什么要去重：详情页一次打开会读多条缓存，评分补齐还会重复读同一键；
   * 每次都 `log.append` 会写 store + console，实测反而把「读取快」的优势吃掉（50 次读约 1ms 全花在日志上）。
   * 这里每个键只在**本进程第一次**说明一次，命中率照样可查，热路径保持无日志。
   */
  private cacheLogged = new Set<string>()

  /** 当前 L1 对应的缓存目录：设置里改缓存目录时整层作废，避免新旧目录同名键串数据 */
  private l1Dir = ''

  /** 清空进程内缓存（「设置 → 清理缓存」/切换缓存目录时调用，见 ipc 的 cacheClear） */
  clearMemoryCache(): void {
    this.l1.clear()
    this.cacheLogged.clear()
    this.l1Dir = ''
  }

  /** 目录切换检测：只在 getter 结果变化时清空，正常热路径只有一次字符串比较 */
  private ensureL1Dir(): void {
    const dir = this.cacheDir
    if (dir !== this.l1Dir) {
      this.l1.clear()
      this.cacheLogged.clear()
      this.l1Dir = dir
    }
  }

  /**
   * 读缓存并统计耗时。
   * `label` 只用于日志（不含地址），`t0` 由调用方传入时能把「服务层整体读取耗时」算进去。
   */
  private readCache<T>(key: string): CacheEntry<T> | null {
    this.ensureL1Dir()
    /*
     * L1 命中直接返回，**不再 stat**（v1.1.4）。
     * 为什么可以信任内存：缓存目录归本应用独占（单实例锁），所有写路径都会同步更新 L1，
     * 「清缓存」也会调用 clearMemoryCache()；之前每次 stat 是为了防外部改动，
     * 但实测 stat 本身就要 ~0.05ms，把「读缓存快」的优势吃掉了一半。
     */
    const hit = this.l1.get(key)
    if (hit) return hit.entry as CacheEntry<T>
    const f = join(this.cacheDir, `${key}.json`)
    try {
      const st = statSync(f)
      const entry = JSON.parse(readFileSync(f, 'utf-8')) as CacheEntry<T>
      this.l1.set(key, { mtimeMs: st.mtimeMs, size: st.size, entry: entry as CacheEntry<unknown> })
      return entry
    } catch {
      return null
    }
  }

  private writeCache<T>(key: string, data: T): void {
    if (!this.cacheDir) return
    try {
      const f = join(this.cacheDir, `${key}.json`)
      const entry: CacheEntry<T> = { fetchedAt: Date.now(), data }
      writeFileSync(f, JSON.stringify(entry), 'utf-8')
      // 写盘后同步一级缓存：否则紧接着的读取还要再解析一遍刚写下去的内容
      try {
        const st = statSync(f)
        this.l1.set(key, { mtimeMs: st.mtimeMs, size: st.size, entry: entry as CacheEntry<unknown> })
      } catch {
        /* 文件状态拿不到时让下次读取走磁盘 */
      }
    } catch (err) {
      log.append('warn', 'bangumi', `写缓存失败: ${String(err)}`)
    }
  }

  /**
   * 自建反代的「每日放送」路径与官方不同（v0.2.7）。
   *
   * 实测用户的 Cloudflare Worker 反代：
   * - `GET  {反代}/calendar`              → 直接返回本应用需要的 7 天 JSON（与官方 v0 结构一致）
   * - `GET  {反代}/v0/calendar`           → 404
   * - `GET  {反代}/v0/subjects/:id`       → 200（与官方一致）
   * - `POST {反代}/v0/search/subjects`    → 200（**搜索是 POST**，GET 会 404）
   * 所以这里给「自建反代」单独一套放送路径，其余接口沿用官方 v0 路径。
   */
  private calendarPathFor(mirror: string, paths: { api: string; web: string; customApi?: string }): string {
    if (isCustomApiBase(mirror)) return paths.customApi ?? paths.web
    return isApiHost(new URL(mirror).hostname) ? paths.api : paths.web
  }

  /**
   * 取一个镜像的响应。
   *
   * v0.2.5 起网页镜像有两条路：
   * - 先 axios 直连（快，适合没有前置校验的站点）；
   * - 若拿到的是机器人校验页（bangumi.vip 用的 Anubis PoW 页只有 14KB 且标题是
   *   「正在确认你是不是机器人！」），改用**离屏真实浏览器**重新打开该地址 ——
   *   导航会自动完成校验并返回真正的服务端渲染 HTML。
   *
   * 自建反代改造：这里顺带做两件事 ——
   *   1. 对内置反代注入 `X-API-Key`（通过 `authHeadersFor`，密钥不进日志/异常）；
   *   2. 用 `beginEndpointRequest` 记录端点当前在途数，供 `orderBangumiEndpoints` 做负载分担。
   *      包在整个 fetchMirror 外层（而不是单次 axios）是因为重试/Chromium 兜底期间
   *      这个端点仍然是"忙"的，提前释放会让调度器误以为它空闲。
   */
  private async fetchMirror(
    url: string,
    isApi: boolean,
    meta: { priority?: NetPriority; tag?: string } = {}
  ): Promise<string> {
    const release = beginEndpointRequest(url)
    try {
      return await this.fetchMirrorUnlocked(url, isApi, meta)
    } finally {
      release()
    }
  }

  private async fetchMirrorUnlocked(
    url: string,
    isApi: boolean,
    meta: { priority?: NetPriority; tag?: string } = {}
  ): Promise<string> {
    /*
     * 请求级计时：记录「接口 / 状态 / 大小 / 耗时 / 总并发」。
     * 标签只取 pathname，不含主机名 —— 红线要求日志里不出现反代地址（log.append 还会再脱敏一次）。
     * `level` 仅为了不改旧调用点保留，分级已废弃（见 net-priority）。
     */
    const level: NetPriority = meta.priority ?? 'A'
    const label = meta.tag ?? safePathLabel(url)
    const traced = async <T>(fn: () => Promise<T>, bytesOf: (v: T) => number): Promise<T> => {
      const done = beginNetTrace(level, label)
      try {
        const v = await fn()
        done(200, bytesOf(v))
        return v
      } catch (err) {
        done('error')
        throw err
      }
    }
    const axiosOnce = async (): Promise<string> => {
      /*
       * V1.5：**空闲收尾**（这是"番剧表要等 50 秒"的真正原因）。
       *
       * 真机实测（curl -w 打两个反代，各 3 次）：
       *   ttfb(首字节) = 3.6~9.9 秒      ← 数据其实很快就来了
       *   total        = **恰好等于我设的超时上限**（40s），size 6.8KB/15KB/173KB 都有
       * 也就是说：**响应体到齐后连接不结束**（和 Tucao 一模一样的老毛病）。
       * 我们按"整响应结束"判定，于是每个请求都要耗满 BANGUMI_TIMEOUT（22s），
       * 再叠加重试与排队（真机日志：在途 29、排队 21），一屏番剧表就能拖到几分钟。
       *
       * 修法：流式接收 + 收到首个数据块后 3 秒无新数据就当作响应完整。
       * 只影响"响应不结束"的情形：正常结束的响应会走同一条 resolve 路径，行为不变。
       */
      return await streamGetText(url, {
        // 不传 timeoutMs：用 streamGetText 的 35s 硬上限（季度响应能到 300KB+，22s 会误杀）
        headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', ...authHeadersFor(url) },
        netTag: label,
        agents: buildProxyAgents(getSettings().proxy),
        /*
         * bangumi 的接口全部是 JSON：空闲收尾前必须先确认能解析，
         * 否则会把 80KB 的 `/calendar` 截断成半截 JSON（真机日志：Unterminated string / Bad Unicode escape）。
         */
        requireJson: true
      })
    }

    let text: string | null = null
    let directError: unknown = null
    try {
      text = await traced(axiosOnce, (v) => Buffer.byteLength(v, 'utf-8'))
    } catch (err) {
      directError = err
    }
    /*
     * 重试两次：自建反代在并发下会瞬时返回 5xx / 429，或者连接被中间设备重置。
     * 这些都是一过性的，隔一会儿再来通常就通了。退避 1.2s → 3s。
     *
     * 总预算固定 30 秒（以前按 S/A/B 给 60/30/20 秒——分级取消后统一）。
     * 预算用完就不再重试：「一次成功」优先于「无限重试」。
     */
    const retryDeadline = Date.now() + 30_000
    for (const backoff of [1200, 3000]) {
      if (text) break
      if (Date.now() + backoff >= retryDeadline) break
      const msg = String((directError as { message?: string })?.message ?? directError ?? '')
      /*
       * **超时不重试**：反代慢到超时说明对端就是在慢慢排队；再重试只会让用户多等一个超时。
       * 超时直接失败、交给界面显示骨架/缓存；连接被重置这类一过性问题仍然重试。
       */
      const code = String((directError as { code?: string })?.code ?? '')
      const timedOut = code === 'ECONNABORTED' || /timeout of \d+ms exceeded/i.test(msg)
      const retryable = !timedOut && (isNetworkReset(directError) || /\b(5\d\d|429)\b/.test(msg))
      if (!retryable) break
      log.append('info', 'bangumi', `请求失败将重试（${msg.slice(0, 60)}）: ${label}`)
      await new Promise((r) => setTimeout(r, backoff))
      try {
        text = await traced(axiosOnce, (v) => Buffer.byteLength(v, 'utf-8'))
        directError = null
      } catch (err) {
        directError = err
      }
    }
    if (text && !looksLikeChallenge(text)) return text

    // API 源在浏览器里打开只会看到 JSON 文本，没有校验问题也用不着绕；这里只救网页镜像
    if (isApi) {
      if (text) return text
      /*
       * V1.2.2：node 这条路失败时，**换 Chromium 的网络栈再试一次**。
       *
       * 依据是用户的原话与实测：「反代地址在浏览器里是可用的」，而 node 这边同一时刻
       * 连续超时/被重置（curl 三次里两次失败）。差别在客户端：Chromium 走 HTTP/2、
       * 有自己的 TLS 指纹与连接池，这类中间设备对它的处理不同。走同一条链路、同一个证书校验，
       * 只是换一个 HTTP 实现 —— 不改服务端、不需要用户开代理。
       * 注意这里也必须带 `X-API-Key`，否则内置反代会直接 403。
       */
      try {
        const viaChromium = await traced(
          () => chromiumGetText(url, 20_000, { 'User-Agent': BROWSER_UA, ...authHeadersFor(url) }),
          (v) => Buffer.byteLength(v, 'utf-8')
        )
        if (viaChromium && !looksLikeChallenge(viaChromium)) {
          log.append('info', 'bangumi', `node 请求失败，改用 Chromium 网络栈取到数据: ${label}`)
          return viaChromium
        }
      } catch (err) {
        log.append(
          'warn',
          'bangumi',
          `Chromium 网络栈也失败（${String((err as Error)?.message ?? err).slice(0, 60)}）: ${label}`
        )
      }
      throw directError ?? new Error('请求失败')
    }
    // 网页镜像：交给离屏浏览器（会自动完成机器人校验，应用内实测约 14 秒）
    const viaBrowser = await traced(
      () => offscreenGet(url, { waitMs: 30000 }),
      (v) => Buffer.byteLength(v, 'utf-8')
    )
    return viaBrowser
  }

  /**
   * 并行尝试所有镜像，返回第一个成功响应。
   * api 镜像走 JSON 路径，网页镜像走 HTML 路径。
   */
  private async requestBest(
    paths: {
      api: string
      web: string
      /** 自建反代专用的路径（缺省时用 api 路径） */
      customApi?: string
    },
    meta: { priority?: NetPriority; tag?: string } = {}
  ): Promise<{ text: string; mirror: string }> {
    /*
     * 自建反代端点池（默认两个内置端点，**平级**）。
     *
     * 调度策略：`orderBangumiEndpoints()` 按「当前在途请求数最少者优先」排序，负载相同则轮询。
     * 为什么不是纯轮询：两套反代虽然共用上游，但各自的冷启动/限流状态不同；纯轮询会把
     * 新请求继续送给正卡住的那一个，而"最少在途"会自然把请求推向空闲侧 ——
     * 这就是用户要的"谁忙不过来就帮谁"。相同负载时轮询，避免空闲时永远先打 api-1、api-2 闲置。
     *
     * 失败自动切下一个端点：两套 API 平级，其中一个 5xx/超时不该让整页失败。
     * 单飞的 key 用**逻辑路径**（不含端点）：同一部番的并发调用只发一次，
     * 否则两个并发调用会分别选中两个端点，等于既没单飞、又把同一份数据要了两遍。
     */
    const endpoints = resolveBangumiEndpoints(getSettings().bangumiCustomApi)
    if (endpoints.length > 0) {
      const logicalKey = `bgm:${paths.customApi ?? paths.api}`
      try {
        return await singleFlight(logicalKey, async () => {
          const errors: string[] = []
          for (const ep of orderBangumiEndpoints(getSettings().bangumiCustomApi)) {
            /*
             * V1.5.1：**404 端点临时隔离**。
             *
             * 真机现场：用户新部署的 Worker A 对**所有路径**都返回 404（`Not Found` 9 字节，
             * curl `/calendar`、`/v0/subjects`、`/v0/subjects/390200` 全 404），
             * 而 Worker B 正常。此时每个请求仍会先打 A、拿 404、再切 B ——
             * 白白多一次往返，季度检索（3 个月 × 多次）就被这些往返拖到 60 秒以上。
             * 404 是**确定性错误**（不是抖动），10 分钟内不再尝试它是安全的；
             * 用户改好 Worker 后最多等 10 分钟自动恢复，或重启应用立即恢复。
             */
            const until = endpointQuarantine.get(ep.baseUrl) ?? 0
            if (until > Date.now()) continue
            const path = this.calendarPathFor(ep.baseUrl, paths)
            const url = `${ep.baseUrl}${path}`
            try {
              const text = await this.fetchMirror(url, true, meta)
              return { text, mirror: ep.baseUrl }
            } catch (err) {
              const reason = describeRequestError(err)
              errors.push(`${ep.label}: ${reason}`)
              if (/HTTP 404|status code 404/i.test(reason)) {
                endpointQuarantine.set(ep.baseUrl, Date.now() + 10 * 60 * 1000)
                log.append('warn', 'bangumi', `${ep.label} 返回 404（端点配置异常），已隔离 10 分钟不再尝试`)
              }
              log.append(
                'warn',
                'bangumi',
                `${ep.label} 请求失败（${reason.slice(0, 80)}），按负载策略尝试下一个端点: ${meta.tag ?? safePathLabel(url)}`
              )
            }
          }
          throw makeSourceError(
            'ALL_DOWN',
            `所有自建反代端点均不可用（${errors.map((item) => item.split(':')[0]).join(' / ')}）。请稍后重试，或到「设置 → 数据源配置」检查 API 地址`,
            errors
          )
        })
      } catch (err) {
        if (err && typeof err === 'object' && 'kind' in err) throw err
        const reason = describeRequestError(err)
        log.append('error', 'bangumi', `自建反代不可用: ${reason}`)
        throw makeSourceError(
          'ALL_DOWN',
          `自建反代不可用（${reason}）。请到「设置 → 数据源配置」检查 API 地址，或稍后重试`,
          [`自定义反代: ${reason}`]
        )
      }
    }
    /*
     * 兜底：只有内置端点常量损坏（正常构建不会发生）才会走到这里。
     * 保留原来的公共镜像竞速，避免"一个常量坏了整个番剧模块不可用"。
     */
    const mirrors = this.mirrors()
    if (mirrors.length === 0) {
      throw makeSourceError('ALL_DOWN', '没有可用的 bangumi 数据源（内置端点与公共镜像均为空）', [])
    }
    const attempts = mirrors.map(async (mirror, index) => {
      let url: string
      let isApi = false
      try {
        const u = new URL(mirror)
        // 自建反代虽然域名可能不含 api.，但它代理的就是 API 主机 → 走 JSON 路径
        isApi = isApiHost(u.hostname) || isCustomApiBase(mirror)
        url = isApi ? `${mirror}${this.calendarPathFor(mirror, paths)}` : `${mirror}${paths.web}`
      } catch {
        url = `${mirror}${paths.web}`
      }
      try {
        return { text: await this.fetchMirror(url, isApi, meta), mirror }
      } catch (err) {
        // 错误只用序号标识镜像，不把地址拼进去（SourceError 最终会显示到界面）
        throw new Error(`镜像站 ${index + 1}: ${describeRequestError(err)}`)
      }
    })
    /*
     * 真正的竞速：**第一个成功就立刻返回**，不等其余镜像。
     * 过去用 Promise.allSettled，会被最慢的那条路拖住 ——
     * 网页镜像要走离屏浏览器过机器人校验（应用内实测 ~14 秒），
     * 于是「最快镜像 1 秒拿到数据」也会被拖到 14 秒后才用上，
     * 表现就是番剧表迟迟不出来、甚至超时。
     */
    return await new Promise<{ text: string; mirror: string }>((resolve, reject) => {
      let pending = attempts.length
      const errors: string[] = []
      for (const p of attempts) {
        p.then((v) => resolve(v)).catch((err) => {
          errors.push(String((err as Error)?.message ?? err))
          pending -= 1
          if (pending === 0) {
            reject(makeSourceError('ALL_DOWN', `所有 bangumi 镜像均不可访问`, errors))
          }
        })
      }
    })
  }

  // ---------------- Jikan 兜底（v0.3.2） ----------------

  /**
   * 兜底搜索：主数据源（自建反代 / 全部镜像）**全部失败**后才调用。
   *
   * 尝试顺序（每一步失败都记进 reason，最终写进日志与 `dataSource.reason`）：
   *   ① Jikan `/anime?q=`：它就是 MAL 自己的搜索，中文标题命中率最好；
   *      但实测当前大面积 504（Jikan 连不上 MAL 上游），所以必须有下一条；
   *   ② AniList GraphQL 搜索（带 `idMal`）：兜底的主力；
   *   ③ 用 Jikan `/anime/{id}/full` 给**前 3 条**补细节（拿 MAL 的中文标题）。
   *
   * 为什么只给前 3 条补：`/anime/{id}` 每调用一次就占 60 次/分钟里的一格，
   * 24 条全补会把一次兜底搜索的配额吃光（后面的翻页/别的兜底就没配额了）。
   * 而 AniList 自己的响应里已经有名称/封面/评分/放送日/简介，**列表本身不缺字段**，
   * 补细节的唯一价值是 MAL 偶尔带的中文标题，所以只对最可能被点开的前几条做。
   *
   * ⚠️ 兜底结果**不写主缓存键**（`search-*`），只写 `jikan-search-*`（见文件上方 TTL 注释）。
   */
  private async jikanSearchFallback(keyword: string): Promise<FallbackOutcome<SearchResultItem[]>> {
    const t0 = Date.now()
    const endpoints: string[] = []
    const reasons: string[] = []
    const kw = String(keyword ?? '').trim()
    const cacheKey = `jikan-search-${createHash('md5').update(kw).digest('hex')}`
    const cached = this.readCache<SearchResultItem[]>(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < TTL_JIKAN_SEARCH) {
      log.append('info', 'bangumi', `搜索兜底：命中 Jikan 兜底缓存（${cached.data.length} 条，键 ${cacheKey}）`)
      return { value: cached.data, meta: { source: 'jikan', endpoints: [`cache:${cacheKey}`], ms: 0 } }
    }

    // ① Jikan /anime?q=
    if (jikanBackoffRemainMs() > 2000) {
      /*
       * Jikan 正在 429 退避：**跳过这一档**，直接去 AniList。
       * 为什么要跳过而不是等：退避是全局的（最长 15 秒），
       * 而兜底本身就是为了「界面还能用」——让用户盯着转圈等十几秒再去问 AniList 是本末倒置。
       * 服务端已经明确说了「别来」，我们不发请求也是遵守限流的一部分。
       */
      const secs = Math.round(jikanBackoffRemainMs() / 1000)
      reasons.push(`Jikan 正在限流退避（剩余约 ${secs}s），本次跳过 Jikan 搜索`)
      log.append('warn', 'bangumi', `搜索兜底：Jikan 正在限流退避（剩余约 ${secs}s），跳过 Jikan 直接用 AniList（关键词「${kw}」）`)
    } else {
      const viaJikan = await jikanAnimeSearch(kw, 24)
      endpoints.push(viaJikan.endpoint)
      if (viaJikan.items.length > 0) {
        const items = viaJikan.items.map((a) => jikanToSearchItem(a))
        this.writeCache(cacheKey, items)
        const ms = Date.now() - t0
        log.append(
          'info',
          'bangumi',
          `搜索兜底成功：Jikan ${viaJikan.endpoint} → ${items.length} 条，耗时 ${ms}ms（关键词「${kw}」）`
        )
        return { value: items, meta: { source: 'jikan', endpoints, ms } }
      }
      reasons.push(`Jikan ${viaJikan.endpoint} → ${viaJikan.reason || '没有匹配结果'}`)
    }

    // ② AniList 搜索
    const viaAniList = await anilistSearchAnime(kw, 24)
    endpoints.push(`anilist:Page.media(search=${kw})`)
    if (viaAniList.items.length === 0) {
      reasons.push(`anilist:Page.media(search=${kw}) → ${viaAniList.reason || '没有匹配结果'}`)
      const ms = Date.now() - t0
      const reason = reasons.join('；')
      log.append('warn', 'bangumi', `搜索兜底失败：${reason}（耗时 ${ms}ms）`)
      return { value: [], meta: { source: 'jikan', endpoints, ms, reason } }
    }
    // ③ 前几条用 Jikan /full 补一次细节（拿 MAL 的中文标题）；失败不影响列表
    const enriched: JikanAnime[] = [...viaAniList.items]
    if (jikanBackoffRemainMs() <= 2000) {
      for (let i = 0; i < Math.min(JIKAN_SEARCH_ENRICH_MAX, enriched.length); i++) {
        const detail = await jikanAnimeById(enriched[i].malId)
        if (detail.item) enriched[i] = mergeJikanAnime(enriched[i], detail.item)
      }
    }
    const items = enriched.map((a) => jikanToSearchItem(a))
    this.writeCache(cacheKey, items)
    const ms = Date.now() - t0
    log.append(
      'info',
      'bangumi',
      `搜索兜底成功：anilist → ${items.length} 条（前 ${Math.min(JIKAN_SEARCH_ENRICH_MAX, enriched.length)} 条尝试用 Jikan 补过细节），耗时 ${ms}ms（关键词「${kw}」）`
    )
    return { value: items, meta: { source: 'jikan', endpoints, ms } }
  }

  /**
   * 兜底番剧表（每周放送）：主数据源全部失败后才调用。
   *
   * 端点顺序：Jikan `/seasons/now` → Jikan `/top/anime?filter=airing` → AniList 当季。
   *
   * 为什么最后要挂 AniList：用户要的是「反代挂了也能看到番剧表」，
   * 而 Jikan 的两个季节/榜单端点实测**都是 504**，只挂 Jikan 等于这个功能不存在。
   * AniList 的季节检索实测 200，且带 `nextAiringEpisode.airingAt` ——
   * 把这条时间戳换算成 JST 星期，正好补上「Jikan 不给星期几」这个最大缺口
   * （见 jikanMap.jikanToCalendarDays 的三级取舍）。
   */
  private async jikanCalendarFallback(): Promise<FallbackOutcome<CalendarDay[]>> {
    const t0 = Date.now()
    const endpoints: string[] = []
    const reasons: string[] = []
    const cached = this.readCache<CalendarDay[]>('jikan-calendar')
    if (cached && Date.now() - cached.fetchedAt < TTL_JIKAN_CALENDAR) {
      const count = cached.data.reduce((n, d) => n + d.items.length, 0)
      log.append('info', 'bangumi', `番剧表兜底：命中 Jikan 兜底缓存（${count} 条，键 jikan-calendar）`)
      return { value: cached.data, meta: { source: 'jikan', endpoints: ['cache:jikan-calendar'], ms: 0 } }
    }

    let items: JikanAnime[] = []
    // Jikan 正在 429 退避时跳过两个 Jikan 端点（理由同 jikanSearchFallback 里的说明）
    const skipJikan = jikanBackoffRemainMs() > 2000
    if (skipJikan) {
      const secs = Math.round(jikanBackoffRemainMs() / 1000)
      reasons.push(`Jikan 正在限流退避（剩余约 ${secs}s），本次跳过 Jikan 的季节/榜单端点`)
      log.append('warn', 'bangumi', `番剧表兜底：Jikan 正在限流退避（剩余约 ${secs}s），直接走 AniList`)
    } else {
      const seasonsNow = await jikanSeasonNow(25)
      endpoints.push(seasonsNow.endpoint)
      items = seasonsNow.items.filter((a) => isAiringNow(a))
      if (items.length === 0) reasons.push(`Jikan ${seasonsNow.endpoint} → ${seasonsNow.reason || '没有在播条目'}`)
    }

    if (items.length === 0 && !skipJikan) {
      const top = await jikanTopAiring(25)
      endpoints.push(top.endpoint)
      items = top.items.filter((a) => isAiringNow(a))
      if (items.length === 0) reasons.push(`Jikan ${top.endpoint} → ${top.reason || '没有在播条目'}`)
    }

    if (items.length === 0) {
      const { year, season } = seasonOfDate()
      const alt = await anilistSeasonAnime(year, season, 25)
      endpoints.push(alt.endpoint)
      items = alt.items.filter((a) => isAiringNow(a))
      if (items.length === 0) reasons.push(`${alt.endpoint} → ${alt.reason || '没有在播条目'}`)
    }

    if (items.length === 0) {
      const ms = Date.now() - t0
      const reason = reasons.join('；') || '兜底数据源没有可用端点'
      log.append('warn', 'bangumi', `番剧表兜底失败：${reason}（耗时 ${ms}ms）`)
      return { value: [], meta: { source: 'jikan', endpoints, ms, reason } }
    }

    const days = jikanToCalendarDays(items)
    this.writeCache('jikan-calendar', days)
    const count = days.reduce((n, d) => n + d.items.length, 0)
    const ms = Date.now() - t0
    log.append(
      'info',
      'bangumi',
      `番剧表兜底成功：${endpoints[endpoints.length - 1]} → ${count} 条（按星期分组，耗时 ${ms}ms；端点链 ${endpoints.join(' → ')}）`
    )
    return { value: days, meta: { source: 'jikan', endpoints, ms } }
  }

  /**
   * 兜底季度列表：主数据源全部失败后才调用。
   * 端点顺序：Jikan `/seasons/{year}/{season}` → AniList `season + seasonYear`。
   *
   * 同样绝不写主缓存键 `season-<年>-<季度>`（否则反代恢复后仍显示 MAL 的条目）。
   */
  private async jikanSeasonFallback(year: number, season: number): Promise<FallbackOutcome<SeasonItem[]>> {
    const t0 = Date.now()
    const endpoints: string[] = []
    const reasons: string[] = []
    const cacheKey = `jikan-season-${year}-${season}`
    const cached = this.readCache<SeasonItem[]>(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < TTL_JIKAN_SEASON) {
      log.append('info', 'bangumi', `季度兜底：命中 Jikan 兜底缓存（${cached.data.length} 条，键 ${cacheKey}）`)
      return { value: cached.data, meta: { source: 'jikan', endpoints: [`cache:${cacheKey}`], ms: 0 } }
    }

    let items: JikanAnime[] = []
    // Jikan 正在 429 退避时跳过这一档（理由见 jikanSearchFallback 里的说明）
    if (jikanBackoffRemainMs() > 2000) {
      const secs = Math.round(jikanBackoffRemainMs() / 1000)
      reasons.push(`Jikan 正在限流退避（剩余约 ${secs}s），本次跳过 /seasons/{year}/{season}`)
      log.append('warn', 'bangumi', `季度兜底（${year}-Q${season}）：Jikan 正在限流退避（剩余约 ${secs}s），直接走 AniList`)
    } else {
      const viaJikan = await jikanSeason(year, season, 50)
      endpoints.push(viaJikan.endpoint)
      items = viaJikan.items
      if (items.length === 0) reasons.push(`Jikan ${viaJikan.endpoint} → ${viaJikan.reason || '返回为空'}`)
    }

    if (items.length === 0) {
      const alt = await anilistSeasonAnime(year, season, 25)
      endpoints.push(alt.endpoint)
      items = alt.items
      if (items.length === 0) reasons.push(`${alt.endpoint} → ${alt.reason || '返回为空'}`)
    }

    if (items.length === 0) {
      const ms = Date.now() - t0
      const reason = reasons.join('；') || '兜底数据源没有可用端点'
      log.append('warn', 'bangumi', `季度兜底失败（${year}-Q${season}）：${reason}（耗时 ${ms}ms）`)
      return { value: [], meta: { source: 'jikan', endpoints, ms, reason } }
    }

    const mapped = items.map((a) => jikanToSeasonItem(a))
    this.writeCache(cacheKey, mapped)
    const ms = Date.now() - t0
    log.append(
      'info',
      'bangumi',
      `季度兜底成功（${year}-Q${season}）：${endpoints[endpoints.length - 1]} → ${mapped.length} 条，耗时 ${ms}ms`
    )
    return { value: mapped, meta: { source: 'jikan', endpoints, ms } }
  }

  /**
   * 兜底条目详情：**只在 id 为负数（即 MAL 兜底 id）时才会走到**，见 jikanMap.jikanFallbackId。
   *
   * 为什么值得做：兜底番剧表/搜索/季度列表里的卡片带的是 `-MAL id`，
   * 用户点进去如果不处理就只会看到一个「条目不存在」的错误页 —— 那兜底就等于半残。
   * 这里用 `/anime/{id}/full` 把 MAL 详情映射成同一套 `SubjectDetail`，
   * 页面能正常渲染（标题/封面/评分/简介/类型标签/详细信息）。
   * 正常条目（正数 id）完全不走这条路，主数据源的行为一行没变。
   */
  private async subjectByMalId(malId: number): Promise<SubjectResult> {
    const key = `jikan-subject-${malId}`
    const cache = this.readCache<SubjectDetail>(key)
    if (cache && Date.now() - cache.fetchedAt < TTL_JIKAN_SUBJECT) {
      return withJikanFallback(
        { fromCache: true, data: cache.data },
        { source: 'jikan', endpoints: [`cache:${key}`], ms: 0 }
      )
    }
    const t0 = Date.now()
    const r = await jikanAnimeById(malId)
    const ms = Date.now() - t0
    if (!r.item) {
      const reason = r.reason || 'Jikan 详情接口不可用'
      log.append('warn', 'bangumi', `详情兜底失败（MAL #${malId}）：${r.endpoint} → ${reason}（耗时 ${ms}ms）`)
      return {
        fromCache: false,
        data: null,
        error: makeSourceError('ALL_DOWN', `Jikan 兜底详情不可用（${reason}）`, [`${r.endpoint}: ${reason}`])
      }
    }
    const data = jikanToSubjectDetail(r.item)
    this.writeCache(key, data)
    log.append('info', 'bangumi', `详情兜底成功：Jikan ${r.endpoint} → 《${data.name_cn || data.name}》（MAL #${malId}，耗时 ${ms}ms）`)
    return withJikanFallback({ fromCache: false, data }, { source: 'jikan', endpoints: [r.endpoint], ms })
  }

  /** 日历后台刷新完成后的监听（渲染层据此更新番剧表，不需要用户手动刷新） */
  private calendarListeners = new Set<(r: CalendarResult) => void>()

  /** 注册「番剧表在后台更新好了」的监听；返回取消函数（IPC 层转发给所有窗口） */
  onCalendarUpdated(cb: (r: CalendarResult) => void): () => void {
    this.calendarListeners.add(cb)
    return () => this.calendarListeners.delete(cb)
  }

  private emitCalendar(r: CalendarResult): void {
    for (const cb of this.calendarListeners) {
      try {
        cb(r)
      } catch {
        /* 单个监听器异常不影响其它窗口 */
      }
    }
  }

  /** 后台刷新是否在飞（避免「启动 6 秒后的自动刷新」与「渲染层首屏加载」各打一次） */
  private calendarRefreshing = false

  /** 真正的一次日历取数 + 解析（前台/后台共用，行为完全一致） */
  private async fetchCalendarFromSource(): Promise<CalendarDay[]> {
    const { text, mirror } = await this.requestBest(
      {
        api: '/v0/calendar',
        web: '/calendar',
        // 自建反代的每日放送在 /calendar，且直接返回本应用需要的 7 天 JSON
        customApi: '/calendar'
      },
      { priority: 'S', tag: '/calendar' }
    )
    if (isApiMirror(mirror)) {
      const parsed = JSON.parse(text) as unknown
      if (!Array.isArray(parsed)) throw new Error('日历 JSON 格式异常')
      return parsed as CalendarDay[]
    }
    const days = parseCalendar(text)
    if (days.length === 0) throw new Error('日历页解析为空')
    return days
  }

  /**
   * 后台刷新番剧表（v1.1.4 核心改动）。
   *
   * 用户报「番剧表用一般带宽很难加载完」，实测真因不是数据量（日历 JSON 只有 68KB），
   * 而是**启动时拿不到网络就什么都不显示**：旧逻辑即使磁盘上有 68KB 缓存，
   * 也要先联网（本次实测这台机器上，缓存命中的番剧表首屏整整等了 142 秒：
   * 主源 3 次超时 + Jikan/AniList 兜底全部超时之后，才把缓存还给界面）。
   * 现在改为 stale-while-revalidate：缓存立即返回，刷新在后台做，成功了再推事件给界面。
   */
  private refreshCalendarInBackground(): void {
    if (this.calendarRefreshing) return
    this.calendarRefreshing = true
    const t0 = Date.now()
    void (async () => {
      try {
        const days = await this.fetchCalendarFromSource()
        this.writeCache('calendar', days)
        this.calendarSessionFresh = true
        const count = days.reduce((n, d) => n + d.items.length, 0)
        log.append('info', 'bangumi', `番剧表后台更新完成：${count} 部，用时 ${Date.now() - t0}ms`)
        this.emitCalendar({ fromCache: false, fetchedAt: Date.now(), days })
      } catch (err) {
        /*
         * 后台刷新失败**不打扰用户**：缓存照常显示，下次启动/手动刷新再试。
         * 这里也**不走 Jikan 兜底** —— 兜底是「主数据源全挂且用户没有可用数据」时的救援，
         * 而后台刷新失败时用户手上已经有一份可看的番剧表，再打一轮兜底只会白耗流量。
         */
        log.append(
          'warn',
          'bangumi',
          `番剧表后台更新失败（继续用缓存）：${String((err as Error)?.message ?? err)}`
        )
        /*
         * 失败也要推一次（refreshing:false）：
         * 否则界面上那行「正在后台更新」会永远转下去（用户会以为卡死）。
         * 带 error 让番剧表如实显示「数据源不可达，当前显示缓存」。
         */
        const cached = this.readCache<CalendarDay[]>('calendar')
        if (cached) {
          this.emitCalendar({
            fromCache: true,
            refreshing: false,
            stale: true,
            fetchedAt: cached.fetchedAt,
            days: cached.data,
            error:
              err && typeof err === 'object' && 'kind' in err
                ? (err as SourceError)
                : makeSourceError('NETWORK', String((err as Error)?.message ?? err), [])
          })
        }
      } finally {
        this.calendarRefreshing = false
      }
    })()
  }

  /**
   * 取番剧表。
   *
   * V1.2.3（用户要求）：**只在"打开番剧表"和"主动点刷新"时才联网**，其余调用一律吃缓存。
   *
   * 为什么要加 `allowRefresh`：原来只要缓存存在且本会话还没刷过，任何一次 `calendar()`
   * （包括首页推荐、收藏页等并不需要最新番剧表的地方）都会在后台打一次 `/calendar` ——
   * 实测这个请求在这台机器上要 **38 秒**，而它是反代上最贵的查询之一。
   * 用户在搜索变慢时给出的判断就是"又在实时加载番剧表，占流量"。
   * 现在默认**不刷新**（`allowRefresh` 缺省 false），只有番剧表页挂载与手动刷新会传 true。
   */
  async calendar(force = false, opts: { allowRefresh?: boolean } = {}): Promise<CalendarResult> {
    const readT0 = performance.now()
    const cache = this.readCache<CalendarDay[]>('calendar')
    const readMs = performance.now() - readT0
    if (cache) {
      if (!this.cacheLogged.has('calendar')) {
        this.cacheLogged.add('calendar')
        log.append(
          'info',
          'bangumi',
          `日历缓存命中（读取 ${readMs.toFixed(2)}ms，缓存年龄 ${((Date.now() - cache.fetchedAt) / 3600000).toFixed(1)}h，${cache.data.reduce((n, d) => n + d.items.length, 0)} 部）`
        )
      }
    } else {
      log.append('info', 'bangumi', `日历缓存未命中（读取 ${readMs.toFixed(2)}ms）`)
    }
    /*
     * v1.1.4：**有缓存就立刻返回**（无论是否过期），刷新放后台。
     * 手动刷新（force）仍然前台等网络 —— 用户点了「刷新」就是要看到新数据/失败提示。
     */
    if (!force && cache) {
      const refreshing = !this.calendarSessionFresh && opts.allowRefresh === true
      if (refreshing) this.refreshCalendarInBackground()
      // V1.4：命中缓存也顺手预热首屏封面（多数时候缓存里已有图，这一步几乎零成本）
      void prefetchCovers(cache.data)
      return { fromCache: true, refreshing, fetchedAt: cache.fetchedAt, days: cache.data }
    }
    /*
     * V1.5：**手动刷新也走"先给缓存、后台更新"**。
     *
     * 真机实测：`/calendar` 即使 Worker 加了 KV，冷启动仍要 24~90 秒（上游要聚合 7 天）；
     * 而客户端在这段时间里一直转圈，用户以为卡死。番剧表本来就有 30 分钟缓存，
     * "先看到旧的、几秒后自动变成新的"远好于"干等一分半"。
     * 新数据到了会通过 `emitCalendar` 推给界面（番剧表页已订阅），用户无需再点一次。
     */
    if (force && cache && opts.allowRefresh !== false) {
      log.append('info', 'bangumi', '手动刷新：先返回缓存，后台更新完成后自动推送')
      this.refreshCalendarInBackground()
      void prefetchCovers(cache.data)
      return { fromCache: true, refreshing: true, fetchedAt: cache.fetchedAt, days: cache.data }
    }
    try {
      const days = await this.fetchCalendarFromSource()
      this.writeCache('calendar', days)
      this.calendarSessionFresh = true
      // V1.4：数据一到就开始预热首屏封面，等渲染层要图时多数已命中磁盘缓存
      void prefetchCovers(days)
      return { fromCache: false, fetchedAt: Date.now(), days }
    } catch (err) {
      const error: SourceError =
        err && typeof err === 'object' && 'kind' in err
          ? (err as SourceError)
          : makeSourceError('NETWORK', String(err), [])
      log.append('error', 'bangumi', `获取番剧表失败: ${error.message}${error.tried.length ? `（${error.tried.join('; ')}）` : ''}`)
      /*
       * v0.3.2：主数据源全挂 → Jikan 兜底番剧表（带独立的 `jikan-calendar` 缓存，绝不写 `calendar` 键）。
       * 兜底也给不出数据时，才按原来的行为退回过期缓存（带 stale 标记）/ 返回错误。
       */
      const fb = await this.jikanCalendarFallback()
      if (fb.value.length > 0) {
        /*
         * ⚠️ 这里**故意不设置 `calendarSessionFresh`**：
         * 那个标记是「本会话已经联网更新过、之后不再自动请求」的闸门。
         * 兜底成功不等于主数据源恢复 —— 如果在这里置位，用户这一整个会话都不会再去试反代，
         * 反代修好了（换镜像/开代理）也得重启应用才生效。
         * 不置位 + `jikan-calendar` 15 分钟缓存 = 「反代一恢复就能自动切回真实数据」，
         * 同时兜底本身也不会被反复请求（缓存兜着）。
         */
        return withJikanFallback({ fromCache: false, fetchedAt: Date.now(), days: fb.value }, fb.meta)
      }
      appendFallbackFailure(error, fb.meta)
      if (cache) {
        return { fromCache: true, stale: true, fetchedAt: cache.fetchedAt, days: cache.data, error }
      }
      return { fromCache: false, fetchedAt: null, days: [], error }
    }
  }

  /**
   * 取某个季度的番剧列表（v0.2.9 附加：「预览 20xx年春」弹窗）。
   *
   * 数据源用的是官方 v0 的条目检索：`GET /v0/subjects?type=2&year=<y>&month=<m>&sort=rank&limit=100`。
   * 它按「放送月份（air_date 的月份）」过滤，所以**一个季度 = 三个月份合并 + 按 id 去重**；
   * 月份与季度的对应关系（1–3 月 冬 / 4–6 月 春 / 7–9 月 夏 / 10–12 月 秋）统一放在
   * `@shared/season` 里，主进程与渲染层共用，避免「文案说春季、实际查的是 1 月」。
   *
   * 实测自建反代：
   * - `?type=2&year=2026&month=4&sort=rank&limit=100` → 200，`total=75`，一页取全（4.4s，首次）
   * - 只给 `month` 不给 `year` → `total=3062`（历年所有 4 月番），所以 year 必传
   * - 返回体是 `{data, total, limit, offset}`，条目里放送日期字段是 `date`
   *   （不是放送接口的 `air_date`），封面已被反代改写成 `/img/r/400/…` 的缩放地址。
   *
   * month 允许传该季度里的任意一个月，内部会规范化到季度（缓存键也只认季度）。
   */
  async season(year: number, month: number, force = false, priority: NetPriority = 'S'): Promise<SeasonResult> {
    const y = Math.trunc(year) || new Date().getFullYear()
    const season = seasonIndexOfMonth(month)
    const key = `season-${y}-${season}`
    const readT0 = performance.now()
    const cache = this.readCache<SeasonItem[]>(key)
    if (!this.cacheLogged.has(key)) {
      this.cacheLogged.add(key)
      log.append(
        'info',
        'bangumi',
        `季度 ${y}-Q${season} ${cache ? `命中磁盘缓存（读取 ${(performance.now() - readT0).toFixed(2)}ms，${cache.data.length} 条，年龄 ${((Date.now() - cache.fetchedAt) / 3600000).toFixed(1)}h）` : `无缓存（读取 ${(performance.now() - readT0).toFixed(2)}ms），需联网`}`
      )
    }
    if (!force && cache && Date.now() - cache.fetchedAt < TTL_SEASON) {
      return { year: y, season, fromCache: true, fetchedAt: cache.fetchedAt, items: cache.data }
    }
    /*
     * v1.1.4：过期缓存 / 月份级缓存也**立即返回**，刷新放后台。
     * 过去这里会等三个月份全部回来（每月份还可能 rank→date 串两次请求），
     * 一般带宽下经常要几十秒甚至超时，界面就一直停在骨架屏 —— 这就是「番剧表加载不完」。
     * 现在只要有「任意月份」的缓存就先拼出一份可看的列表（partial），其余月份后台补。
     */
    if (!force) {
      if (cache) {
        this.refreshSeasonInBackground(y, season, key, priority)
        return { year: y, season, fromCache: true, stale: true, fetchedAt: cache.fetchedAt, items: cache.data }
      }
      const monthCached = this.cachedSeasonMonths(y, season)
      if (monthCached.items.length > 0) {
        this.refreshSeasonInBackground(y, season, key, priority)
        return {
          year: y,
          season,
          fromCache: true,
          partial: true,
          fetchedAt: monthCached.fetchedAt,
          items: monthCached.items
        }
      }
    }
    try {
      const { items, complete } = await this.fetchSeason(y, season, force, priority)
      /*
       * v0.3.7：**空结果不写缓存**（这一季还没登记，写进去 7 天内都不会再问）。
       * v1.1.4：**不完整的季度也不写整季缓存** —— 三个月里只成功一个月时，
       * 过去会把残缺列表冻 7 天（用户看到的番剧表莫名少一大半）。
       * 月份级缓存已经在 fetchSeasonMonth 里各自写好，完整时才合并落整季键。
       */
      if (complete && items.length > 0) this.writeCache(key, items)
      return {
        year: y,
        season,
        fromCache: false,
        partial: complete ? undefined : true,
        fetchedAt: Date.now(),
        items
      }
    } catch (err) {
      const error: SourceError =
        err && typeof err === 'object' && 'kind' in err
          ? (err as SourceError)
          : makeSourceError('NETWORK', String(err), [])
      log.append('warn', 'bangumi', `获取季度番剧失败 (${y}-Q${season}): ${error.message}`)
      /*
       * v0.3.2：主数据源全挂 → Jikan 兜底季度列表（独立键 `jikan-season-<年>-<季度>`）。
       * 兜底失败才退回过期缓存（季度条目几乎不变，宁可给旧数据也不要空弹窗）。
       */
      const fb = await this.jikanSeasonFallback(y, season)
      if (fb.value.length > 0) {
        return withJikanFallback({ year: y, season, fromCache: false, fetchedAt: Date.now(), items: fb.value }, fb.meta)
      }
      appendFallbackFailure(error, fb.meta)
      if (cache) {
        return { year: y, season, fromCache: true, stale: true, fetchedAt: cache.fetchedAt, items: cache.data, error }
      }
      return { year: y, season, fromCache: false, fetchedAt: null, items: [], error }
    }
  }

  /**
   * 拉取一个季度的三个月份并合并去重（v1.1.4 改为返回「是否完整」）。
   *
   * 三个月并行发（全局并发上限 8，正好让三个月同时飞，
   * 不必再像旧实现那样排成两批）；**只要有一个月成功就返回该月的数据** ——
   * 某个月偶发 5xx 时用户看到的是「少了几条、但列表照常可用」，而不是整块不可用。
   * `complete = false` 时**不写整季缓存**（见 season() 的说明），月份级缓存各自已经写好。
   */
  private async fetchSeason(
    year: number,
    season: number,
    force = false,
    priority: NetPriority = 'S'
  ): Promise<{ items: SeasonItem[]; complete: boolean }> {
    const months = monthsOfSeason(season)
    const settled = await Promise.allSettled(months.map((m) => this.fetchSeasonMonth(year, m, force, priority)))
    const lists = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    if (lists.length === 0) {
      const first = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      throw first?.reason ?? new Error('季度取数失败')
    }
    return {
      items: this.mergeSeasonItems(lists),
      // 三个月都有结果才算完整；空数组也算「成功但没数据」（该月确实没番）
      complete: settled.every((r) => r.status === 'fulfilled')
    }
  }

  /** 合并多个月的条目：保持接口顺序（热度/排名靠前的在前），仅按 id 去重 */
  private mergeSeasonItems(lists: SeasonItem[][]): SeasonItem[] {
    const seen = new Set<number>()
    const items: SeasonItem[] = []
    for (const list of lists) {
      for (const item of list) {
        if (item.id <= 0 || seen.has(item.id)) continue
        seen.add(item.id)
        items.push(item)
      }
    }
    return items
  }

  /** 从「月份级缓存」拼出一份列表（只取仍在 TTL 内的；拼不出来时返回空） */
  private cachedSeasonMonths(year: number, season: number): { items: SeasonItem[]; fetchedAt: number } {
    const lists: SeasonItem[][] = []
    let newest = 0
    for (const m of monthsOfSeason(season)) {
      const c = this.readCache<SeasonItem[]>(`season-month-${year}-${m}`)
      if (!c || Date.now() - c.fetchedAt >= TTL_SEASON) continue
      lists.push(c.data)
      newest = Math.max(newest, c.fetchedAt)
    }
    return { items: this.mergeSeasonItems(lists), fetchedAt: newest || Date.now() }
  }

  /** 正在后台刷新的季度（键 = 年-季），避免历史表连点/StrictMode 双跑时重复请求 */
  private seasonRefreshing = new Set<string>()

  private refreshSeasonInBackground(
    year: number,
    season: number,
    key: string,
    priority: NetPriority = 'S'
  ): void {
    const tag = `${year}-${season}`
    if (this.seasonRefreshing.has(tag)) return
    this.seasonRefreshing.add(tag)
    void this.fetchSeason(year, season, false, priority)
      .then(({ items, complete }) => {
        // 只有完整结果才覆盖整季缓存；不完整时月份缓存已经各自更新，下次再拼
        if (complete && items.length > 0) this.writeCache(key, items)
      })
      .catch((err) =>
        log.append('warn', 'bangumi', `季度后台刷新失败（${tag}，继续用缓存）: ${String((err as Error)?.message ?? err)}`)
      )
      .finally(() => this.seasonRefreshing.delete(tag))
  }

  /**
   * 取某个季度的单个月份（`/v0/subjects?type=2&year=&month=&sort=…`）。
   *
   * v1.1.4：加**月份级缓存**。为什么按月份而不是只按季度：
   * 一个季度要打三个月份的请求，反代一慢就很容易只成功一两个；
   * 只缓存整季的话，一次超时就让「已经拿到的两个月」全部作废，下次从零开始 ——
   * 这正是用户看到的「番剧表怎么都加载不完」。月份缓存让每次成功都能沉淀，
   * 下次打开先拼出已有的两个月（秒开），第三个后台补。
   */
  private async fetchSeasonMonth(
    year: number,
    month: number,
    force = false,
    priority: NetPriority = 'S'
  ): Promise<SeasonItem[]> {
    const key = `season-month-${year}-${month}`
    if (!force) {
      const cached = this.readCache<SeasonItem[]>(key)
      if (cached && Date.now() - cached.fetchedAt < TTL_SEASON) return cached.data
    }
    /*
     * v0.3.7 修复（用户报「马上就要进入秋季了，10 月的番剧数据完全没有」）：
     *
     * 以前固定用 `sort=rank`。取证（`.e2e/probe-season-sort.mjs`）：
     *   · 2026-10（还没开播）→ `sort=rank` **total=0**，而 `sort=date` → total=108；
     *   · 2025-10（已播完）→ `sort=rank` 73 条，不带 sort 却有 148 条。
     * 也就是说 `sort=rank` **只返回「已经有人打分、进了排行榜」的条目**，
     * 未开播 / 冷门的新番会被整批丢掉 —— 新一季的番剧表因此空空如也。
     *
     * 所以按放送日期的 `sort=date` 兜底：rank 拿不到东西时再问一次，
     * 拿到的是「这一季登记在案的全部条目」（含未开播的）。
     * 反过来不直接用 date 是因为 rank 的排序对**已播完**的季度更有用（热度高的在前）。
     */
    const byRank = await this.fetchSeasonMonthSorted(year, month, 'rank', priority)
    let items = byRank
    if (items.length === 0) {
      items = await this.fetchSeasonMonthSorted(year, month, 'date', priority)
      if (items.length > 0) {
        log.append(
          'info',
          'bangumi',
          `季度检索 ${year}-${month} 用 sort=rank 取不到条目（多半是还没开播），已改用 sort=date 取到 ${items.length} 条`
        )
      }
    }
    // 空结果不写缓存（该月还没登记条目时，下周再来问）
    if (items.length > 0) this.writeCache(key, items)
    return items
  }

  /** 季度检索的单次请求（sort 由调用方决定，见 fetchSeasonMonth 的说明） */
  private async fetchSeasonMonthSorted(
    year: number,
    month: number,
    sort: 'rank' | 'date',
    priority: NetPriority = 'S'
  ): Promise<SeasonItem[]> {
    const path = `/v0/subjects?type=2&year=${year}&month=${month}&sort=${sort}&limit=${SEASON_PAGE_LIMIT}`
    /*
     * 季度检索曾经被显式提到 S 级，原因是它排在 B 队列时会被后台评分请求挤到超时。
     * 现在 S/A/B 已整体取消（所有请求同一条 FIFO，只受全局并发 8 限制），
     * 这里不再需要"强行提级"；`priority` 参数保留只是为了不改调用方签名。
     */

    /*
     * 三个路径都给同一个地址：季度检索只有 v0 JSON 接口有（官方网页版的 /anime/browser
     * 是另一套 HTML，解析成本高且公共镜像已基本不可达）。
     * 配了自建反代时 requestBest 只会用反代；若用户把数据源切回纯网页镜像，
     * 这里会拿到 HTML —— 下面 isApiMirror 判定后直接报错，界面显示「该季度数据暂不可用」，
     * 而不是把 HTML 当 JSON 解析崩掉。
     */
    const { text, mirror } = await this.requestBest(
      { api: path, web: path, customApi: path },
      { priority, tag: '/v0/subjects(季度)' }
    )
    if (!isApiMirror(mirror)) {
      throw makeSourceError('PARSE', '当前数据源不支持季度接口（需要用 API 型数据源，如自建反代）', [endpointLabelOf(mirror)])
    }
    const parsed = JSON.parse(text) as { data?: Record<string, unknown>[] }
    const list = Array.isArray(parsed?.data) ? parsed.data : []
    return list.map((raw) => this.normalizeSeasonItem(raw))
  }

  private normalizeSeasonItem(raw: Record<string, unknown>): SeasonItem {
    // 与 normalizeSubject 同样的坑：v0 的放送日期字段是 `date`，两种命名都读
    const airDate = raw.air_date ?? raw.date
    return {
      id: Number(raw.id ?? 0),
      name: String(raw.name ?? ''),
      name_cn: String(raw.name_cn ?? ''),
      images: (raw.images as CoverImages | null) ?? null,
      rating: (raw.rating as Rating | null) ?? null,
      air_date: airDate ? String(airDate) : null,
      platform: raw.platform ? String(raw.platform) : undefined
    }
  }

  async subject(id: number, priority: NetPriority = 'S'): Promise<SubjectResult> {
    /*
     * v0.3.2：**负数 id = Jikan 兜底条目**（`-MAL id`，见 jikanMap.jikanFallbackId）。
     *
     * 兜底番剧表/搜索/季度列表里的卡片带的都是这种 id，点进详情页时从这里分流到 MAL 详情，
     * 于是「反代挂了 → 兜底列表 → 点开某一部」这条链是通的（而不是一个「条目不存在」的错误页）。
     * 正数 id（正常的 Bangumi 条目）完全不走这条路，主链路行为一行没变。
     */
    const fallbackMalId = malIdFromFallbackId(id)
    if (fallbackMalId) return await this.subjectByMalId(fallbackMalId)
    /*
     * v0.2.7：缓存键加版本后缀 —— 详情映射补了 date/platform/total_episodes，
     * 沿用旧键会让用户一直看到「缺上映日期」的历史缓存。
     * 现在再进一位到 subject3-：自建反代此前命中旧版 API 形态（无 infobox/tags/platform），
     * 已经落盘的那些残缺详情必须在升级后立刻失效，否则用户仍会看到「详细信息为空」。
     */
    const key = `subject3-${id}`
    const readT0 = performance.now()
    const cache = this.readCache<SubjectDetail>(key)
    if (!this.cacheLogged.has(key)) {
      this.cacheLogged.add(key)
      log.append(
        'info',
        'bangumi',
        `详情#${id} ${cache ? `命中磁盘缓存（读取 ${(performance.now() - readT0).toFixed(2)}ms，年龄 ${((Date.now() - cache.fetchedAt) / 86400000).toFixed(1)} 天）` : `无缓存（读取 ${(performance.now() - readT0).toFixed(2)}ms），需联网`}`
      )
    }
    if (cache) {
      /*
       * v1.1.4：**缓存命中一律立即返回，不再等评分**。
       *
       * 以前这里会 await `mergeFreshRating`：评分缓存过期时最多再等 1.5 秒，
       * 于是「明明有 30 天缓存」的详情页也要卡 1.5 秒才画出来（用户感知就是"详情页慢"）。
       * 现在正文立刻返回，评分由详情页单独调用 `rating()` 刷新（不阻塞任何板块）；
       * 过期正文则后台静默重取（单飞去重），抓到的完整详情下次进页面就是新的。
       */
      const expired = Date.now() - cache.fetchedAt >= TTL_SUBJECT
      if (expired) this.refreshSubjectInBackground(id, key, priority)
      return {
        fromCache: true,
        stale: expired || undefined,
        data: this.applyCachedRating(id, cache.data)
      }
    }
    try {
      const detail = await this.fetchSubject(id, priority)
      this.writeCache(key, detail)
      // 刚拿到的详情里就带着评分：顺手写进 6 小时那份缓存，避免下次再为评分多打一次请求
      this.noteRating(id, detail.rating)
      return { fromCache: false, data: detail }
    } catch (err) {
      const error: SourceError =
        err && typeof err === 'object' && 'kind' in err
          ? (err as SourceError)
          : makeSourceError('NETWORK', String(err), [])
      log.append('warn', 'bangumi', `获取详情失败 (#${id}): ${error.message}`)
      return { fromCache: false, data: null, error }
    }
  }

  /**
   * 只读缓存、**绝不联网**的详情快照（v1.1.4，详情页首屏用）。
   *
   * 这是「先到先显示」的第一步：详情页挂载后先调它，有缓存就能在毫秒级把
   * 标题/封面/简介/评分画出来，再让完整详情、角色、分集各自去取自己的板块。
   * 没有缓存时返回 null，页面显示骨架屏，**不与网络请求耦合**。
   */
  subjectCached(id: number): CachedSubjectResult {
    if (malIdFromFallbackId(id)) {
      const mal = malIdFromFallbackId(id)!
      const c = this.readCache<SubjectDetail>(`jikan-subject-${mal}`)
      return { data: c?.data ?? null, fetchedAt: c?.fetchedAt ?? null }
    }
    const cache = this.readCache<SubjectDetail>(`subject3-${id}`)
    if (!cache) return { data: null, fetchedAt: null }
    return { data: this.applyCachedRating(id, cache.data), fetchedAt: cache.fetchedAt }
  }

  /** 正在后台刷新的详情 id（防止同一部番被重复刷新：单飞在 `requestBest` 内部还兜了一层） */
  private subjectRefreshing = new Set<number>()

  private refreshSubjectInBackground(id: number, key: string, priority: NetPriority = 'S'): void {
    if (this.subjectRefreshing.has(id)) return
    this.subjectRefreshing.add(id)
    void this.fetchSubject(id, priority)
      .then((fresh) => {
        this.writeCache(key, fresh)
        this.noteRating(id, fresh.rating)
      })
      .catch((err) => log.append('warn', 'bangumi', `后台刷新详情失败 (#${id})，继续用缓存: ${String(err)}`))
      .finally(() => this.subjectRefreshing.delete(id))
  }

  /** 把 `rating-{id}` 缓存（6 小时那份）覆盖到详情副本上；纯内存操作，不联网 */
  private applyCachedRating(id: number, detail: SubjectDetail): SubjectDetail {
    if (id <= 0) return detail
    const cached = this.readCache<{ score: number | null; total: number }>(`rating-${id}`)
    if (!cached?.data) return detail
    const { score, total } = cached.data
    if (score == null && !total) return detail
    return {
      ...detail,
      rating: { score: score ?? detail.rating?.score ?? null, total, rank: detail.rating?.rank }
    }
  }

  /**
   * 评分板块（v1.1.4）：**先给缓存值，再按需刷新**，绝不阻塞详情正文。
   *
   * `refresh = false`（页面首帧）：命中 6 小时缓存就直接返回，未命中也不发请求 ——
   *   此时页面先用详情自带评分，等 `refresh = true` 的那次回来再更新。
   * `refresh = true`（首帧之后在后台跑）：强制联网重取一次，失败就退回缓存值。
   */
  async rating(id: number, refresh = false): Promise<RatingResult> {
    const sid = Math.trunc(Number(id))
    if (!Number.isFinite(sid) || sid <= 0) {
      return { score: null, total: 0, fetchedAt: null, fromCache: false }
    }
    const key = `rating-${sid}`
    const cache = this.readCache<{ score: number | null; total: number }>(key)
    /*
     * 首帧（refresh = false）**绝不联网**：有缓存给缓存，没缓存返回空值。
     * 只有页面在首帧之后显式调用 `rating(id, true)` 时才发请求 ——
     * 否则详情页打开时会被一次 30 秒级的评分请求拖住（这正是「详情页慢」的老问题）。
     */
    if (!refresh) {
      if (cache) {
        return { score: cache.data.score, total: cache.data.total, fetchedAt: cache.fetchedAt, fromCache: true }
      }
      return { score: null, total: 0, fetchedAt: null, fromCache: false }
    }
    try {
      const data = await this.fetchRating(sid, 'S')
      this.writeCache(key, data)
      return { score: data.score, total: data.total, fetchedAt: Date.now(), fromCache: false }
    } catch (err) {
      const error: SourceError =
        err && typeof err === 'object' && 'kind' in err
          ? (err as SourceError)
          : makeSourceError('NETWORK', String((err as Error)?.message ?? err), [])
      if (cache) {
        return { score: cache.data.score, total: cache.data.total, fetchedAt: cache.fetchedAt, fromCache: true, error }
      }
      return { score: null, total: 0, fetchedAt: null, fromCache: false, error }
    }
  }

  /**
   * 把一份详情里的评分同步进 `rating-{id}` 缓存（6 小时 TTL 的那一份）。
   *
   * 为什么两个缓存要互相写：详情接口本来就带评分，直接落进评分缓存就等于白拿一次刷新；
   * 不写的话，详情 30 天内不再联网、评分却仍是启动时那份，两处显示会长期不一致。
   */
  private noteRating(id: number, rating: Rating | null | undefined): void {
    if (id <= 0 || !rating) return
    const score = typeof rating.score === 'number' && rating.score > 0 ? rating.score : null
    if (score == null && !rating.total) return
    this.writeCache(`rating-${id}`, { score, total: Number(rating.total ?? 0) })
  }

  /** 只取一部番剧的评分（评分的单条实现，ratings() 的批量循环与 mergeFreshRating 共用一份口径） */
  private async fetchRating(id: number, priority: NetPriority = 'S'): Promise<{ score: number | null; total: number }> {
    const { text, mirror } = await this.requestBest(
      {
        api: `/v0/subjects/${id}`,
        web: `/subject/${id}`,
        // 同 subject()：自建反代必须走 /v0/，否则拿到的是缺字段的旧版 API 形态
        customApi: `/v0/subjects/${id}`
      },
      { priority, tag: `/v0/subjects/${id}(评分)` }
    )
    if (!isApiMirror(mirror)) return parseRatingOnly(text)
    const s = JSON.parse(text) as { rating?: { score?: number; total?: number } }
    const score = Number(s.rating?.score ?? 0)
    return { score: score > 0 ? score : null, total: Number(s.rating?.total ?? 0) }
  }

  /** 拉取并归一化一部番剧的完整详情（v0 走 JSON，网页镜像走 HTML 解析） */
  private async fetchSubject(id: number, priority: NetPriority = 'S'): Promise<SubjectDetail> {
    const { text, mirror } = await this.requestBest(
      {
        api: `/v0/subjects/${id}`,
        web: `/subject/${id}`,
        /*
         * v0.2.7 关键修复：自建反代的详情必须显式走 `/v0/subjects/:id`。
         *
         * 此前这里没传 customApi，`calendarPathFor` 便回退到网页路径 `/subject/:id` ——
         * 反代在该路径上返回的是**旧版 API 形态**（`{id,url,type,name,air_date,eps,rating}`，
         * 实测 2192B），它天生没有 infobox / tags / platform / total_episodes。
         * 于是 JSON 解析成功、页面看着「有数据」（标题、评分、日期、集数都在），
         * 但「详细信息 / 类型标签 / 制作信息 / 监督 / 上映日期」整块消失 ——
         * 用户反馈的「用反代很多番剧详情加载不出来」正是这个原因（不是反代缺数据）。
         * 带 /v0/ 前缀时同一反代返回 5368B 完整 v0 数据（infobox 41 条、tags 30 个）。
         */
        customApi: `/v0/subjects/${id}`
      },
      { priority, tag: `/v0/subjects/${id}` }
    )
    const detail: SubjectDetail | null = isApiMirror(mirror)
      ? this.normalizeSubject(JSON.parse(text) as Record<string, unknown>)
      : parseSubjectPage(text, id)
    if (!detail) throw new Error('详情页解析失败')
    return detail
  }

  async search(keyword: string): Promise<SearchResult> {
    const key = `search-${createHash('md5').update(keyword).digest('hex')}`
    const cache = this.readCache<SearchResultItem[]>(key)
    if (cache && Date.now() - cache.fetchedAt < TTL_SEARCH) {
      return { items: cache.data }
    }
    try {
      /*
       * v0.2.7：API 源必须用 **POST** 搜索。
       * 官方 v0 与自建反代的搜索接口都是 `POST /v0/search/subjects?limit=N`，
       * body 为 `{"keyword":"..."}`；此前这里写成 GET（`/v0/search/subjects/关键词?limit=24`），
       * 对 API 源一律 404 —— 也就是说「API 镜像搜索从来没成功过」，
       * 一旦主数据源换成 API 型反代，搜索就会整体失效。
       */
      const items = await this.searchRace(keyword)
      this.writeCache(key, items)
      return { items }
      } catch (err) {
        const error: SourceError =
          err && typeof err === 'object' && 'kind' in err
            ? (err as SourceError)
            : makeSourceError('NETWORK', String(err), [])
        log.append('warn', 'bangumi', `搜索失败 (${keyword}): ${error.message}`)
        /*
         * v0.3.2：主数据源全挂 → **Jikan 兜底**（用户的明确要求：反代失效时优先用它）。
         *
         * 顺序：先兜底取数，再退回过期缓存 ——
         * 反代挂掉时缓存里的旧搜索结果最多是 30 分钟前的，而兜底能给出「现在搜得到的东西」；
         * 两者都拿不到才把错误抛给界面（维持原来的行为）。
         * 兜底结果**不写 `search-*` 主缓存**（见文件上方的 TTL 注释）。
         */
        const fb = await this.jikanSearchFallback(keyword)
        if (fb.value.length > 0) {
          return withJikanFallback({ items: fb.value }, fb.meta)
        }
        appendFallbackFailure(error, fb.meta)
        if (cache) return { items: cache.data }
        return { items: [], error }
      }
  }

  /**
   * 补全番剧评分（日历页不含评分，从详情页提取，6 小时缓存，并发 2）。
   *
   * v0.3.7 追加：`force = true` 时**忽略缓存**，把传进来的 id 全部重新拉一遍。
   * 用户的「刷新」按钮应当真的刷新到评分，而不是读一份最多 6 小时前的缓存
   * （番剧表的刷新以前只刷放送数据，评分还是会话内内存缓存里的旧值）。
   */
  async ratings(
    ids: number[],
    force = false
  ): Promise<Record<number, { score: number | null; total: number }>> {
    const out: Record<number, { score: number | null; total: number }> = {}
    const missing: number[] = []
    for (const id of [...new Set(ids)]) {
      /*
       * v0.3.2：**跳过 Jikan 兜底条目**（负数 id）。
       * 它们的评分兜底时就已经从 MAL/AniList 带回来了（见 jikanMap.toRating），
       * 而拿负数 id 去问 bangumi 反代必然是 404 —— 白打一次请求，还可能把 404 结果写进 `rating-*` 缓存。
       * 返回里不给这一项，渲染层会自动退回 `item.rating.score`（`ratings[id]?.score ?? item.rating?.score`）。
       */
      if (id <= 0) continue
      const cache = this.readCache<{ score: number | null; total: number }>(`rating-${id}`)
      if (!force && cache && Date.now() - cache.fetchedAt < TTL_RATING) {
        out[id] = cache.data
      } else {
        missing.push(id)
      }
    }
    let i = 0
    /*
     * 并发从 4 降到 2、并在每个请求之间留一点间隔（v0.2.7）。
     * 自建反代通常是个人的 Worker/NestJS 服务，扛不住「一次几十上百个并发」——
     * 实测会把后续请求打成 503，表现就是「很多番剧详情加载不出来」。
     * 另外渲染层现在只对「没有评分」的条目请求补全（放送数据本身多半带评分），
     * 正常情况下这里根本不会被调用。
     */
    const workers = Array.from({ length: Math.min(2, missing.length) }, async () => {
      while (i < missing.length) {
        const id = missing[i++]
        await new Promise((r) => setTimeout(r, 120))
        try {
          /*
           * 这里保留 2 并发 + 120ms 间隔，**不是分级**：分级已取消，所有请求同等排队。
           * 这个限制是反代侧的自我保护 —— 一次几十上百个评分请求会把个人 Worker 打成 503，
           * 而评分只是后台补齐，没必要占满全局并发额度。
           */
          const data = await this.fetchRating(id)
          this.writeCache(`rating-${id}`, data)
          out[id] = data
        } catch {
          out[id] = { score: null, total: 0 }
        }
      }
    })
    await Promise.all(workers)
    return out
  }

  /**
   * 「更新到第几集」（v0.3.7，用户要求加在番剧表详情页）。
   *
   * 为什么要单独请求分集接口，而不是用详情里的 `eps` 或「开播日 + 每周一集」去算：
   *   · 详情接口的 `eps` / `total_episodes` 是**计划集数**（12、24…），跟「播到第几集」无关；
   *   · 按开播日期每 7 天推一集，遇到停播、连播两集、分割放送（第 2 季隔一季再播）、
   *     中途改档就会算错 —— 追番时这个数字错了比没有还糟。
   * `/v0/episodes?subject_id=…&type=0` 每一集都带 `airdate`，直接数「airdate <= 今天」的条数就是真值
   * （type=0 = 本篇，排除 OP/ED/SP 这些特别篇）。
   *
   * 实测（`.e2e/probe-episodes.mjs`）：反代的这个端点可用，一部 12 集的番约 300ms、返回 12 条。
   * 缓存 6 小时：集数一周才动一次，短缓存只是为了让「刚更新完的那一集」尽快出现。
   */
  async episodeProgress(id: number, priority: NetPriority = 'S'): Promise<EpisodeProgress | null> {
    const sid = Math.trunc(Number(id))
    // 负数 id = Jikan/AniList 兜底条目，bangumi 这边必然 404，直接不给（界面据此隐藏这一行）
    if (!Number.isFinite(sid) || sid <= 0) return null
    const key = `episodes-${sid}`
    const cache = this.readCache<EpisodeProgress>(key)
    if (cache && Date.now() - cache.fetchedAt < TTL_EPISODES) return cache.data
    try {
      const path = `/v0/episodes?subject_id=${sid}&type=0&limit=100`
      const { text, mirror } = await this.requestBest(
        { api: path, web: path, customApi: path },
        { priority, tag: '/v0/episodes' }
      )
      if (!isApiMirror(mirror)) return cache?.data ?? null
      const parsed = JSON.parse(text) as { data?: Record<string, unknown>[] }
      const list = Array.isArray(parsed?.data) ? parsed.data : []
      const dates = list
        .map((e) => String(e?.airdate ?? '').trim())
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
      if (dates.length === 0) return null
      // 用**本地日期**比：接口给的 airdate 就是本地日历上的放送日，
      // 用 toISOString() 会在 UTC+8 的凌晨把「今天该播的那一集」算成还没播。
      const today = localDateString()
      const aired = dates.filter((d) => d <= today)
      const upcoming = dates.filter((d) => d > today)
      const data: EpisodeProgress = {
        aired: aired.length,
        total: list.length,
        lastAirDate: aired.length > 0 ? aired[aired.length - 1] : null,
        nextAirDate: upcoming.length > 0 ? upcoming[0] : null,
        finished: list.length > 0 && aired.length >= list.length
      }
      this.writeCache(key, data)
      return data
    } catch (err) {
      log.append('warn', 'bangumi', `获取分集进度失败（id=${sid}）：${String((err as Error)?.message ?? err)}`)
      // 取不到就退回过期缓存：集数进度旧一点，也比整行消失强
      return cache?.data ?? null
    }
  }

  async testMirrors(): Promise<MirrorTestResult[]> {
    /*
     * 测试连接要覆盖**真实会用的端点**：内置双反代排前面，公共镜像排后面。
     * 返回给渲染层的 `url` 字段故意只放安全标签（`内置反代 api-1` / `镜像站 1`），
     * 不放真实地址 —— 设置页会把结果直接显示出来，红线要求地址不能出现在界面。
     */
    const endpoints = resolveBangumiEndpoints(getSettings().bangumiCustomApi)
    const targets: { label: string; base: string; isApi: boolean }[] = endpoints.map((ep) => ({
      label: ep.id.startsWith('custom-') ? ep.label : `内置反代 ${ep.label}`,
      base: ep.baseUrl,
      isApi: true
    }))
    this.mirrors().forEach((mirror, index) => {
      targets.push({ label: `镜像站 ${index + 1}`, base: mirror, isApi: isApiMirror(mirror) })
    })
    return await Promise.all(
      targets.map(async (target): Promise<MirrorTestResult> => {
        const start = Date.now()
        /*
         * 自建反代的日历在 `/calendar`（`/v0/calendar` 是 404）；公共 API 镜像走 `/v0/calendar`，
         * 网页镜像走 `/calendar`。与真实取数共用 calendarPathFor，避免测试与实际两套口径。
         */
        const path = target.isApi
          ? this.calendarPathFor(target.base, { api: '/v0/calendar', web: '/calendar', customApi: '/calendar' })
          : '/calendar'
        const url = `${target.base}${path}`
        try {
          /*
           * 走与真实取数完全相同的路径（含「被机器人校验时改用离屏浏览器」），
           * 否则 bangumi.vip 这类站点在测试里会被判失败 —— 明明应用能正常用它。
           */
          const text = await this.fetchMirror(url, target.isApi)
          const ok = target.isApi ? text.trim().startsWith('[') : text.includes('coverList')
          return {
            url: target.label,
            ok,
            ms: Date.now() - start,
            error: ok ? undefined : '响应格式不符（可能需要校验或该地址不是番组计划镜像）'
          }
        } catch (err) {
          return { url: target.label, ok: false, ms: Date.now() - start, error: describeRequestError(err) }
        }
      })
    )
  }

  /**
   * 搜索竞速（v0.2.7）：API 源走 POST JSON，网页镜像走 GET 搜索页，
   * 与 requestBest 一样「第一个成功就返回」。
   *
   * v0.2.12 大修：用户反馈「有些番剧搜不到，例如 little busters，但 bangumi 网页上能搜到」。
   * 实测（`node .e2e/probe-search.js`）真因不是关键词，而是**自建反代的 v0 搜索整条 502**：
   *   · `POST /v0/search/subjects`（带不带 body / 带不带 responseGroup / 换成 GET / 加 Origin+Referer）
   *     → 全部 502 Bad Gateway；
   *   · 同一个反代的 `GET /v0/subjects/400602` → 200（所以不是反代挂了，是搜索那一段的上游挂了）；
   *   · 老的 `GET /search/subject/{关键词}?type=2&responseGroup=large` → 200，字段齐全
   *     （id/name/name_cn/images/rating/eps/air_date/rank），中文关键词也正常。
   * 也就是说：只要主数据源是 API 型反代，搜索功能整体是坏的，用户看到的「有些搜不到」只是
   * 部分关键词命中了缓存或恰好赶上上游可用。修法就是给 v0 加上**老接口兜底** +
   * **关键词变体重试**（去标点/合并空格），任一条路拿到结果就返回，并把「哪条路命中」写进日志，
   * 以后再出问题一眼能看出是接口变了还是关键词的问题。
   */
  private async searchRace(keyword: string): Promise<SearchResultItem[]> {
    /** 网页镜像：直接抓搜索页 HTML */
    const viaMirror = async (mirror: string, kw: string): Promise<SearchResultItem[]> => {
      const text = await this.fetchMirror(
        `${mirror}/subject_search/${encodeURIComponent(kw)}?cat=2`,
        false,
        /*
         * 搜索曾经从 B 提到 S，因为排队会让"敲下回车"变成超时失败。
         * 现在分级已整体取消：搜索与其他请求同一条 FIFO，只受全局并发 8 限制，
         * 不再需要"提级"这个动作；`priority` 参数仅为兼容保留。
         */
        { priority: 'S', tag: '搜索(网页)' }
      )
      return parseSearchPage(text)
    }

    /**
     * 一个数据源上的完整尝试链：v0 → 老接口，每个接口再按关键词变体各试一次。
     * 只有「全部接口都抛错」才算失败；「接口通了但没结果」返回空数组（由上层继续试别的源）。
     *
     * 日志里只写 `api-1` / `api-2` 这类**安全标签**，不写 base 地址（红线）。
     */
    const viaBase = async (base: string, isApi: boolean, kw: string): Promise<SearchResultItem[]> => {
      const label = isBuiltInBangumiApi(base) ? endpointLabelOf(base) : '镜像站'
      if (!isApi) return await viaMirror(base, kw)
      let firstError: unknown = null
      for (const variant of searchKeywordVariants(kw)) {
        try {
          const items = await this.searchViaV0(base, variant)
          if (items.length > 0) {
            log.append('info', 'bangumi', `搜索命中：v0「${variant}」→ ${items.length} 条（${label}）`)
            return items
          }
        } catch (err) {
          firstError = firstError ?? err
          log.append('warn', 'bangumi', `v0 搜索失败「${variant}」（${label}）：${describeRequestError(err)}`)
        }
        try {
          const items = await this.searchViaLegacy(base, variant)
          if (items.length > 0) {
            log.append('info', 'bangumi', `搜索命中：老接口「${variant}」→ ${items.length} 条（${label}）`)
            return items
          }
        } catch (err) {
          firstError = firstError ?? err
          log.append('warn', 'bangumi', `老接口搜索失败「${variant}」（${label}）：${describeRequestError(err)}`)
        }
      }
      if (firstError) throw firstError
      return []
    }

    /*
     * 与 requestBest 同一套端点池与调度：按在途数排序，失败自动切另一个。
     * 搜索是用户敲下回车就在等的交互，单端点失败时直接换边，不把错误立刻抛给界面。
     */
    const endpoints = resolveBangumiEndpoints(getSettings().bangumiCustomApi)
    if (endpoints.length > 0) {
      const errors: string[] = []
      for (const ep of orderBangumiEndpoints(getSettings().bangumiCustomApi)) {
        try {
          const items = await viaBase(ep.baseUrl, true, keyword)
          // 接口通了但确实没结果：这是真实结果，不再拿同一关键词去另一套反代重复问一遍
          return items
        } catch (err) {
          const reason = describeRequestError(err)
          errors.push(`${ep.label}: ${reason}`)
          log.append('warn', 'bangumi', `自建反代搜索失败（${ep.label}）：${reason.slice(0, 80)}，尝试下一个端点`)
        }
      }
      const summary = errors.map((item) => item.split(':')[0]).join(' / ')
      log.append('error', 'bangumi', `所有自建反代端点搜索均失败: ${summary}`)
      throw makeSourceError(
        'ALL_DOWN',
        `自建反代搜索不可用（${summary}）。请稍后重试，或到「设置 → 数据源配置」检查 API 地址`,
        errors
      )
    }
    const mirrors = this.mirrors()
    if (mirrors.length === 0) {
      throw makeSourceError('ALL_DOWN', '没有可用的 bangumi 数据源搜索端点', [])
    }
    const attempts = mirrors.map(async (mirror) => await viaBase(mirror, isApiMirror(mirror), keyword))
    return await new Promise<SearchResultItem[]>((resolve, reject) => {
      let pending = attempts.length
      const errors: string[] = []
      for (const p of attempts) {
        p.then((v) => resolve(v)).catch((err) => {
          errors.push(String((err as Error)?.message ?? err))
          pending -= 1
          if (pending === 0) {
            reject(makeSourceError('ALL_DOWN', '所有 bangumi 数据源搜索均失败', errors))
          }
        })
      }
    })
  }

  /** v0 搜索：POST + JSON body（带 type=2 过滤，免得把游戏/书籍也搜出来） */
  private async searchViaV0(base: string, keyword: string): Promise<SearchResultItem[]> {
    const url = `${base}/v0/search/subjects?limit=24&responseGroup=small`
    const done = beginNetTrace('A', '搜索(v0)')
    const release = beginEndpointRequest(url)
    let res
    try {
      res = await axios.post(
        url,
        { keyword, filter: { type: [2] } },
        {
          timeout: REQUEST_TIMEOUT,
          headers: {
            'User-Agent': BROWSER_UA,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...authHeadersFor(url)
          },
          // netTag 仅用于日志；netPriority 已废弃，不再传
          netTag: '搜索(v0)',
          ...buildProxyAgents(getSettings().proxy)
        }
      )
      done(res.status, JSON.stringify(res.data ?? null).length)
    } catch (err) {
      done('error')
      throw err
    } finally {
      release()
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    const list = (res.data as { data?: Record<string, unknown>[] })?.data ?? []
    return list.map((raw) => this.normalizeItem(raw))
  }

  /**
   * 老接口搜索：`GET /search/subject/{关键词}?type=2&responseGroup=large`。
   *
   * 字段与 v0 不完全同名（都叫 name/name_cn/images/rating，日期是 air_date），
   * 所以走同一个 `normalizeItem`。返回的图片是 `http://lain.bgm.tv/...`，
   * 交给 `rewriteImageUrl` 在取图时改写到自建图片反代即可（`media.ts` 已统一处理）。
   */
  private async searchViaLegacy(base: string, keyword: string): Promise<SearchResultItem[]> {
    const url = `${base}/search/subject/${encodeURIComponent(keyword)}?type=2&responseGroup=large`
    const done = beginNetTrace('A', '搜索(老接口)')
    const release = beginEndpointRequest(url)
    let res
    try {
      res = await axios.get(url, {
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', ...authHeadersFor(url) },
        // netTag 仅用于日志；netPriority 已废弃，不再传
        netTag: '搜索(老接口)',
        ...buildProxyAgents(getSettings().proxy)
      })
      done(res.status, JSON.stringify(res.data ?? null).length)
    } catch (err) {
      done('error')
      throw err
    } finally {
      release()
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    const body = res.data as { list?: Record<string, unknown>[] } | Record<string, unknown>[]
    const list = Array.isArray(body) ? body : (body?.list ?? [])
    return list
      .filter((it) => it?.type == null || Number(it.type) === 2) // 只要动画条目（老接口偶尔会混进书籍/游戏）
      .map((raw) => this.normalizeItem(raw))
  }

  private normalizeItem(raw: Record<string, unknown>): SearchResultItem {
    return {
      id: Number(raw.id ?? 0),
      name: String(raw.name ?? ''),
      name_cn: String(raw.name_cn ?? ''),
      images: (raw.images as SearchResultItem['images']) ?? null,
      rating: (raw.rating as SearchResultItem['rating']) ?? null,
      air_date: raw.air_date ? String(raw.air_date) : null,
      summary: String(raw.summary ?? '')
    }
  }

  private normalizeSubject(raw: Record<string, unknown>): SubjectDetail {
    /*
     * v0.2.7 修：v0 接口的放送日期字段名是 `date`，不是 `air_date`。
     * 过去只读 `air_date`，于是「API 型数据源」的条目详情一律没有上映日期
     * （用户反馈「上映日期等信息加载不出来」）。两者都读，兼容两种命名。
     */
    const airDate = raw.air_date ?? raw.date
    return {
      id: Number(raw.id ?? 0),
      name: String(raw.name ?? ''),
      name_cn: String(raw.name_cn ?? ''),
      summary: String(raw.summary ?? ''),
      air_date: airDate ? String(airDate) : null,
      images: (raw.images as SubjectDetail['images']) ?? null,
      rating: (raw.rating as SubjectDetail['rating']) ?? null,
      tags: Array.isArray(raw.tags)
        ? (raw.tags as { name?: unknown; count?: unknown }[])
            .map((t) => ({ name: String(t?.name ?? ''), count: t?.count != null ? Number(t.count) : undefined }))
            .filter((t) => t.name.length > 0)
        : [],
      // v0 的 infobox value 可能是字符串或对象数组，必须压平后再交给渲染层
      infobox: normalizeInfobox(raw.infobox),
      eps: raw.eps != null ? Number(raw.eps) : undefined,
      volumes: raw.volumes != null ? Number(raw.volumes) : undefined,
      platform: raw.platform ? String(raw.platform) : undefined,
      totalEpisodes: raw.total_episodes != null ? Number(raw.total_episodes) : undefined
    }
  }

  // ---------------- 角色列表（「最XX的角色 9宫格」工具，v0.2.11 附加） ----------------

  /**
   * 取一个条目的角色列表。
   *
   * 两条路，都遵循「自建反代优先 → 老接口兜底」：
   *   ① 首选 `GET {base}/v0/subjects/{id}/characters`
   *      → `[{id,name,relation,images:{grid,small,medium,large}}]`（字段最全）
   *   ② 兜底 `GET {base}/subject/{id}?responseGroup=large` → `crt` 数组
   *      （`id/name/role_name/images`）
   *
   * 为什么要兜底：实测自建反代的 v0 **搜索**整条 502（见 `searchRace` 的注释），
   * v0 的角色段与搜索同属上游容易挂的部分，而老接口在同一反代上是 200；
   * 另外部分条目 v0 角色段会返回空数组，这时也必须交给老接口再试一次。
   *
   * ⚠️ 老接口给的**角色数可能比 v0 少**（实测它只列主要角色），
   * 所以结果里带 `source`，界面照实标注「数据来自哪条路」，避免用户误以为网站缺数据。
   */
  async characters(subjectId: number): Promise<CharactersResult> {
    const id = Math.trunc(Number(subjectId))
    if (!id || id <= 0) {
      return {
        subjectId: id,
        items: [],
        source: 'v0',
        fromCache: false,
        error: makeSourceError('PARSE', '条目 id 无效', [])
      }
    }
    const key = `chars-${id}`
    const cache = this.readCache<{ items: CharacterItem[]; source: CharactersResult['source'] }>(key)
    if (cache && Date.now() - cache.fetchedAt < TTL_CHARACTERS) {
      return { subjectId: id, items: cache.data.items, source: cache.data.source, fromCache: true }
    }
    try {
      const fresh = await this.fetchCharacters(id)
      this.writeCache(key, fresh)
      return { subjectId: id, items: fresh.items, source: fresh.source, fromCache: false }
    } catch (err) {
      const error: SourceError =
        err && typeof err === 'object' && 'kind' in err
          ? (err as SourceError)
          : makeSourceError('NETWORK', String((err as Error)?.message ?? err), [])
      log.append('warn', 'bangumi', `获取角色列表失败 (#${id}): ${error.message}`)
      // 角色表几乎不变：过期缓存照样能用，宁可给旧数据也不要空列表
      if (cache) {
        return {
          subjectId: id,
          items: cache.data.items,
          source: cache.data.source,
          fromCache: true,
          stale: true,
          error
        }
      }
      return { subjectId: id, items: [], source: 'v0', fromCache: false, error }
    }
  }

  /**
   * 角色取数的完整尝试链：v0 → 老接口。
   *
   * 写法与 `searchRace` 里的 `viaBase` 一致（同一个数据源上把接口挨个试完再罢休），
   * 只有**全部接口都失败**才算失败；「接口通了但没有角色」也会继续走下一步。
   */
  private async fetchCharacters(id: number): Promise<{ items: CharacterItem[]; source: CharactersResult['source'] }> {
    let firstError: unknown = null
    try {
      /*
       * v0 角色接口：与详情一致，必须显式带 `/v0/` 前缀 ——
       * 自建反代在去掉前缀的路径上返回的是旧版 API 形态（没有 characters 段）。
       */
      const { text, mirror } = await this.requestBest(
        {
          api: `/v0/subjects/${id}/characters`,
          web: `/v0/subjects/${id}/characters`,
          customApi: `/v0/subjects/${id}/characters`
        },
        { priority: 'S', tag: `/v0/subjects/${id}/characters` }
      )
      if (!isApiMirror(mirror)) throw new Error(`${endpointLabelOf(mirror)}: 网页镜像不提供 v0 角色接口`)
      const items = this.normalizeCharactersV0(JSON.parse(text) as unknown)
      if (items.length > 0) return { items, source: 'v0' }
      firstError = new Error('v0 角色接口返回为空')
    } catch (err) {
      firstError = err
    }
    log.append(
      'warn',
      'bangumi',
      `v0 角色接口不可用 (#${id})，改用老接口兜底：${String((firstError as Error)?.message ?? firstError)}`
    )
    try {
      const items = await this.charactersLegacy(id)
      if (items.length > 0) {
        log.append('info', 'bangumi', `角色命中：老接口 (#${id}) → ${items.length} 位（可能少于 v0）`)
        return { items, source: 'legacy' }
      }
      firstError = firstError ?? new Error('老接口未返回角色')
    } catch (err) {
      firstError = firstError ?? err
    }
    throw firstError
  }

  /**
   * 老接口角色兜底：`GET {base}/subject/{id}?responseGroup=large` 的 `crt` 数组。
   *
   * 写法与 `requestBest` 一致：内置双端点按在途数排序，失败自动切另一个；
   * 没配端点（只可能是常量损坏）才退回公共 API 镜像竞速。
   * 只对 API 型数据源发起：网页镜像的同一个地址返回的是 HTML 页面，里面没有结构化角色列表。
   */
  private async charactersLegacy(id: number): Promise<CharacterItem[]> {
    const endpoints = resolveBangumiEndpoints(getSettings().bangumiCustomApi)
    if (endpoints.length > 0) {
      const errors: string[] = []
      for (const ep of orderBangumiEndpoints(getSettings().bangumiCustomApi)) {
        const url = `${ep.baseUrl}/subject/${id}?responseGroup=large`
        try {
          const text = await this.fetchMirror(url, true)
          const items = this.normalizeCharactersLegacy(JSON.parse(text) as unknown)
          if (items.length === 0) throw new Error('响应里没有 crt 角色数组')
          return items
        } catch (err) {
          const reason = describeRequestError(err)
          errors.push(`${ep.label}: ${reason}`)
          log.append('warn', 'bangumi', `老接口角色失败（${ep.label}）：${reason.slice(0, 80)}，尝试下一个端点`)
        }
      }
      throw makeSourceError('ALL_DOWN', '所有自建反代端点都没有取到角色列表', errors)
    }
    const bases = this.mirrors().filter((m) => isApiMirror(m))
    if (bases.length === 0) {
      throw makeSourceError('PARSE', '当前数据源不支持角色接口（需要用 API 型数据源，如自建反代）', [])
    }
    const attempts = bases.map(async (base, index): Promise<CharacterItem[]> => {
      const url = `${base}/subject/${id}?responseGroup=large`
      try {
        const text = await this.fetchMirror(url, true)
        const items = this.normalizeCharactersLegacy(JSON.parse(text) as unknown)
        if (items.length === 0) throw new Error('响应里没有 crt 角色数组')
        return items
      } catch (err) {
        throw new Error(`镜像站 ${index + 1}: ${describeRequestError(err)}`)
      }
    })
    return await new Promise<CharacterItem[]>((resolve, reject) => {
      let pending = attempts.length
      const errors: string[] = []
      for (const p of attempts) {
        p.then((v) => resolve(v)).catch((err) => {
          errors.push(String((err as Error)?.message ?? err))
          pending -= 1
          if (pending === 0) reject(makeSourceError('ALL_DOWN', '所有 API 数据源都没有取到角色列表', errors))
        })
      }
    })
  }

  /** v0 角色接口：`[{id,name,relation,images}]`（不带中文名，`name_cn` 一律为空串） */
  private normalizeCharactersV0(raw: unknown): CharacterItem[] {
    if (!Array.isArray(raw)) return []
    return raw
      .map((it) => {
        const o = (it ?? {}) as Record<string, unknown>
        return {
          id: Number(o.id ?? 0),
          name: String(o.name ?? ''),
          name_cn: String(o.name_cn ?? ''),
          relation: String(o.relation ?? ''),
          images: (o.images as CoverImages | null) ?? null
        }
      })
      .filter((c) => c.id > 0 || c.name.length > 0)
  }

  /**
   * 老接口（`responseGroup=large`）的角色数组 `crt`。
   *
   * 字段名与 v0 不同：关系叫 `role_name`（不是 `relation`），中文名偶尔出现在 `name_cn`；
   * 立绘地址是 `http://lain.bgm.tv/...` 这种 http 链接 —— 交给 `rewriteImageUrl`
   * 在取图时改写到自建图片反代（`media.ts` 已统一处理），这里保持原样返回。
   */
  private normalizeCharactersLegacy(raw: unknown): CharacterItem[] {
    const list = Array.isArray(raw) ? raw : ((raw as { crt?: unknown } | null)?.crt ?? [])
    if (!Array.isArray(list)) return []
    return list
      .map((it) => {
        const o = (it ?? {}) as Record<string, unknown>
        return {
          id: Number(o.id ?? 0),
          name: String(o.name ?? ''),
          name_cn: String(o.name_cn ?? ''),
          relation: String(o.role_name ?? o.relation ?? ''),
          images: (o.images as CoverImages | null) ?? null
        }
      })
      .filter((c) => c.id > 0 || c.name.length > 0)
  }
}

export const bangumi = new BangumiService()

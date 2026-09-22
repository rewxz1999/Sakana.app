import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import type {
  CalendarDay,
  CalendarResult,
  CharacterItem,
  CharactersResult,
  CoverImages,
  MirrorTestResult,
  Rating,
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
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import { store } from '../store'
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
const TTL_RATING = 30 * 24 * 3600 * 1000
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
const REQUEST_TIMEOUT = 12000
/**
 * 自建反代的并发闸门（v0.2.7 附加）。
 *
 * 反代通常是单个 Worker，实测并发一高就返回 5xx/429，而 5xx 会让整页「详情加载不出来」——
 * 用户的要求是「减少压力但不削减详情」，所以这里只限并发、不砍字段、不加降级。
 */
const MAX_PROXY_CONCURRENCY = 2
let proxyInFlight = 0
const proxyQueue: (() => void)[] = []

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
function appendFallbackFailure(error: SourceError, meta: JikanFallbackMeta): void {
  if (!meta.reason) return
  error.message = `${error.message}；Jikan 兜底也失败：${meta.reason}`
  if (meta.endpoints?.length) error.tried = [...error.tried, ...meta.endpoints]
}

interface CacheEntry<T> {
  fetchedAt: number
  data: T
}

function makeSourceError(kind: SourceError['kind'], message: string, tried: string[]): SourceError {
  return { kind, message, tried }
}

function isApiHost(host: string): boolean {
  return host.startsWith('api.') || host.includes('api.bgm')
}

/** 已被墙的公共镜像：默认跳过（用户实测 bangumi.pro 已不可达，请求它只是白等） */
const DEAD_MIRRORS = ['bangumi.pro']

/**
 * 并发闸门：同一时刻最多 N 个请求在飞，其余排队。
 * 只用于自建反代（公共镜像本来就允许并行竞速，且它们的压力与我们无关）。
 */
async function withProxySlot<T>(fn: () => Promise<T>): Promise<T> {
  if (proxyInFlight >= MAX_PROXY_CONCURRENCY) {
    await new Promise<void>((resolve) => proxyQueue.push(resolve))
  }
  proxyInFlight += 1
  try {
    return await fn()
  } finally {
    proxyInFlight -= 1
    const next = proxyQueue.shift()
    if (next) next()
  }
}

/**
 * 单飞（single-flight）：完全相同的 URL 在同一时刻只发一次请求。
 *
 * 实测最典型的重复请求：番剧详情页与播放器的「详情」面板会同时请求同一部番，
 * 以及切集时旧实例的收尾请求。合并后反代实际收到的请求数直接减半，而返回的数据一模一样
 * （不削减详情）。
 */
const jsonInflight = new Map<string, Promise<string>>()

function singleFlight(key: string, fn: () => Promise<string>): Promise<string> {
  const existing = jsonInflight.get(key)
  if (existing) return existing
  const p: Promise<string> = fn().finally(() => {
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
 * 自建反代（Cloudflare Worker）：配置过的自定义 API 地址一律按 API 语义请求
 * （`/v0/...` 路径），不要求域名必须以 `api.` 开头 —— Workers 域名/自定义域名常常不是。
 */
function isCustomApiBase(mirror: string): boolean {
  const custom = (getSettings().bangumiCustomApi ?? '').trim().replace(/\/+$/, '')
  return Boolean(custom) && mirror.replace(/\/+$/, '') === custom
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
  const custom = (getSettings().bangumiCustomImg ?? '').trim().replace(/\/+$/, '')
  if (!custom || !url) return url
  try {
    const u = new URL(url)
    // 只改 bgm 系图床（含镜像站图床），其它地址（含反代自己已带 /r/ 的地址）保持原样
    if (!isBangumiImageHost(u.hostname)) return url
    const base = new URL(custom)
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
  const custom = (getSettings().bangumiCustomImg ?? '').trim().replace(/\/+$/, '')
  if (!custom || !url) return url
  try {
    const base = new URL(custom)
    if (!url.startsWith(base.origin)) return url
    return url.replace(/\/r\/\d+\//, '/')
  } catch {
    return url
  }
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
     * 启动时把「实际会用哪个数据源」写进运行日志。
     * 排查「明明配了反代却还在用镜像」这类问题时，一眼就能看出运行时读到的是什么。
     */
    const custom = (getSettings().bangumiCustomApi ?? '').trim()
    log.append(
      'info',
      'bangumi',
      custom
        ? `数据源：仅使用自建反代 ${custom}`
        : `数据源：公共镜像 ${this.mirrors().join(', ') || '(空)'}`
    )
  }

  /**
   * 一次性迁移：把 bangumi.vip 提到镜像列表首位。
   *
   * 老安装的 settings.json 里存着 `bangumi.pro`（已不可达），
   * 如果只改 DEFAULT_SETTINGS，已装用户永远拿不到新镜像 —— 表现为「番剧表一直空白」。
   * 用户自己填过的自建反代/自定义镜像保持不动，只是把可用镜像补到最前面。
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
      /*
       * v0.2.7：把自建反代设为默认主数据源（用户已部署 Cloudflare Worker）。
       * 用户自己填过自定义反代就不覆盖，只补默认值。
       */
      const PROXY_API = 'https://sankana-bangumi.de5.net/api'
      const PROXY_IMG = 'https://sankana-bangumi.de5.net/img'
      if (!s.proxyMigrated && !(s.bangumiCustomApi ?? '').trim()) {
        store.set('settings', {
          ...(s as Record<string, unknown>),
          bangumiCustomApi: PROXY_API,
          bangumiCustomImg: PROXY_IMG,
          proxyMigrated: true
        })
        log.append('info', 'bangumi', `已启用自建反代作为默认主数据源：${PROXY_API}`)
        // 重新读一次：下面的镜像迁移基于最新设置
        Object.assign(s, { bangumiCustomApi: PROXY_API, proxyMigrated: true })
      }
      /*
       * v0.2.7：把「当前主数据源」的显示与实际取数对齐。
       *
       * 配了反代之后，日历/详情/搜索一律只走反代（`requestBest` 提前返回），
       * 但 `dataSources.main` / `bangumiBase` 还停在 bangumi.vip，
       * 于是「关于」「数据源配置」「番剧表底栏」都显示成公共镜像 ——
       * 排查数据源问题时会被这行字直接带偏。
       * 这里把主数据源改成反代地址，但**保留**镜像列表，用户清空反代即可切回。
       * 单独一个标记位，已装用户也能补上这次迁移（上面的 proxyMigrated 不会再执行）。
       */
      const customNow = (s.bangumiCustomApi ?? '').trim().replace(/\/+$/, '')
      if (customNow && !s.proxyMainMigrated) {
        store.set('settings', {
          ...(s as Record<string, unknown>),
          bangumiBase: customNow,
          dataSources: {
            main: customNow,
            mirrors: s.dataSources?.mirrors ?? s.bangumiMirrors ?? []
          },
          proxyMainMigrated: true
        })
        Object.assign(s, { bangumiBase: customNow, proxyMainMigrated: true })
        log.append('info', 'bangumi', `主数据源显示已改为自建反代：${customNow}`)
      }
      if (s.mirrorVipMigrated) return
      const VIP = 'https://bangumi.vip'
      const list = Array.isArray(s.bangumiMirrors) && s.bangumiMirrors.length > 0 ? s.bangumiMirrors : []
      if (!list.includes(VIP)) {
        const next = [VIP, ...list.filter((m) => m && m !== VIP)]
        store.set('settings', {
          ...(s as Record<string, unknown>),
          bangumiMirrors: next,
          bangumiBase: s.bangumiBase && s.bangumiBase.includes('bangumi.pro') ? VIP : s.bangumiBase || VIP,
          dataSources: {
            main:
              s.dataSources?.main && s.dataSources.main.includes('bangumi.pro')
                ? VIP
                : s.dataSources?.main || VIP,
            mirrors: next
          },
          mirrorVipMigrated: true
        })
        log.append('info', 'bangumi', `已把镜像 ${VIP} 加入数据源列表（原列表：${list.join(', ') || '空'}）`)
      } else {
        store.set('settings', { ...(s as Record<string, unknown>), mirrorVipMigrated: true })
      }
    } catch (err) {
      log.append('warn', 'bangumi', `镜像迁移失败（忽略）: ${String((err as Error)?.message ?? err)}`)
    }
  }

  private mirrors(): string[] {
    const s = getSettings()
    const custom = (s.bangumiCustomApi ?? '').trim().replace(/\/+$/, '')
    const list = Array.isArray(s.bangumiMirrors) && s.bangumiMirrors.length > 0
      ? s.bangumiMirrors
      : [s.bangumiBase || 'https://bangumi.pro']
    const normalized = list.map((m) => m.replace(/\/+$/, ''))
    /*
     * 自建反代排第一。
     *
     * ⚠️ v0.2.7 起这只影响「测试连接」时的展示顺序：`requestBest` 在配了反代时
     * 会直接返回、根本不会走到这里的竞速，所以反代与公共镜像不再并存竞速
     * （用户要求：只用自己的反代，加载不出来就提示手动切换）。
     */
    const all = custom ? [custom, ...normalized] : normalized
    // bangumi.pro 已确认不可达：无条件剔除。实测启动瞬间并发请求过多时，
    // 连带把可用镜像的连接也一起被中间设备重置，少发无用请求能显著提高成功率。
    const alive = all.filter((m) => !DEAD_MIRRORS.some((d) => m.includes(d)))
    return [...new Set(alive)]
  }

  private readCache<T>(key: string): CacheEntry<T> | null {
    if (!this.cacheDir) return null
    try {
      const f = join(this.cacheDir, `${key}.json`)
      if (!existsSync(f)) return null
      return JSON.parse(readFileSync(f, 'utf-8')) as CacheEntry<T>
    } catch {
      return null
    }
  }

  private writeCache<T>(key: string, data: T): void {
    if (!this.cacheDir) return
    try {
      const f = join(this.cacheDir, `${key}.json`)
      writeFileSync(f, JSON.stringify({ fetchedAt: Date.now(), data }), 'utf-8')
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
   */
  private async fetchMirror(url: string, isApi: boolean): Promise<string> {
    const axiosOnce = async (): Promise<string> => {
      const res = await axios.get(url, {
        timeout: REQUEST_TIMEOUT,
        responseType: 'text',
        headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' },
        ...buildProxyAgents(getSettings().proxy)
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      return res.data as string
    }

    let text: string | null = null
    let directError: unknown = null
    try {
      text = await axiosOnce()
    } catch (err) {
      directError = err
    }
    /*
     * 重试两次（v0.2.7）：自建反代在并发下会瞬时返回 5xx / 429，
     * 或者连接被中间设备重置。这些都是一过性的，隔一会儿再来通常就通了 ——
     * 直接报错给用户会表现为「很多番剧详情加载不出来」。退避 1.2s → 3s。
     */
    for (const backoff of [1200, 3000]) {
      if (text) break
      const msg = String((directError as { message?: string })?.message ?? directError ?? '')
      const retryable = isNetworkReset(directError) || /\b(5\d\d|429)\b/.test(msg)
      if (!retryable) break
      log.append('info', 'bangumi', `请求失败将重试（${msg.slice(0, 60)}）: ${url.slice(0, 80)}`)
      await new Promise((r) => setTimeout(r, backoff))
      try {
        text = await axiosOnce()
        directError = null
      } catch (err) {
        directError = err
      }
    }
    if (text && !looksLikeChallenge(text)) return text

    // API 源在浏览器里打开只会看到 JSON 文本，没有校验问题也用不着绕；这里只救网页镜像
    if (isApi) {
      if (text) return text
      throw directError ?? new Error('请求失败')
    }
    // 网页镜像：交给离屏浏览器（会自动完成机器人校验，应用内实测约 14 秒）
    const viaBrowser = await offscreenGet(url, { waitMs: 30000 })
    return viaBrowser
  }

  /**
   * 并行尝试所有镜像，返回第一个成功响应。
   * api 镜像走 JSON 路径，网页镜像走 HTML 路径。
   */
  private async requestBest(paths: {
    api: string
    web: string
    /** 自建反代专用的路径（缺省时用 api 路径） */
    customApi?: string
  }): Promise<{ text: string; mirror: string }> {
    /*
     * v0.2.7：配了自建反代就**只用它**（用户要求：反代加载不出来时提示手动切换镜像，而不是自动回退）。
     *
     * 之前把反代和公共镜像放在一起竞速，结果反代经常输给「已经预热好的网页镜像」
     * （实测 bangumi.vip 命中缓存只要 26ms，反代首包要几百毫秒~3 秒），
     * 于是「设为默认主数据源」形同虚设；后来改成优先-回退，但仍然会在用户不知情的情况下换源。
     * 现在改为：有反代就用反代，失败直接把错误抛给界面（错误文案里写明去「设置 → 数据源配置」手动切换）。
     */
    const custom = (getSettings().bangumiCustomApi ?? '').trim().replace(/\/+$/, '')
    if (custom) {
      const url = `${custom}${this.calendarPathFor(custom, paths)}`
      try {
        /*
         * 单飞 + 并发闸门（v0.2.7 附加）：不改变取到的数据，只减少反代实际收到的请求数。
         * URL 相同的并发调用合并成一次；同时最多 2 个请求在飞，避免把个人 Worker 打成 5xx。
         */
        const text = await singleFlight(url, () => withProxySlot(() => this.fetchMirror(url, true)))
        return { text, mirror: custom }
      } catch (err) {
        const e = err as { code?: string; message?: string }
        const reason = e?.code === 'ECONNABORTED' ? '超时' : (e?.message ?? String(err))
        log.append('error', 'bangumi', `自建反代不可用: ${reason}`)
        throw makeSourceError(
          'ALL_DOWN',
          `自建反代不可用（${reason}）。请到「设置 → 数据源配置」检查反代地址，或手动切换到其它镜像站`,
          [`${custom}: ${reason}`]
        )
      }
    }
    const attempts = this.mirrors().map(async (mirror) => {
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
        return { text: await this.fetchMirror(url, isApi), mirror }
      } catch (err) {
        const e = err as { code?: string; message?: string }
        const reason = e?.code === 'ECONNABORTED' ? '超时' : (e?.message ?? String(err))
        throw new Error(`${mirror}: ${reason}`)
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

  async calendar(force = false): Promise<CalendarResult> {
    const cache = this.readCache<CalendarDay[]>('calendar')
    // 会话内只请求一次：应用打开后首次加载联网更新，之后一律直接使用本地数据（除非用户手动刷新）
    if (!force) {
      if (this.calendarSessionFresh && cache) {
        return { fromCache: true, fetchedAt: cache.fetchedAt, days: cache.data }
      }
      // 本会话尚未更新过：联网一次，成功即标记会话新鲜；失败回退缓存（带 stale 标记）
    }
    try {
      const { text, mirror } = await this.requestBest({
        api: '/v0/calendar',
        web: '/calendar',
        // 自建反代的每日放送在 /calendar，且直接返回本应用需要的 7 天 JSON
        customApi: '/calendar'
      })
      let days: CalendarDay[]
      if (isApiMirror(mirror)) {
        const parsed = JSON.parse(text) as unknown
        if (!Array.isArray(parsed)) throw new Error('日历 JSON 格式异常')
        days = parsed as CalendarDay[]
      } else {
        days = parseCalendar(text)
        if (days.length === 0) throw new Error('日历页解析为空')
      }
      this.writeCache('calendar', days)
      this.calendarSessionFresh = true
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
   * 实测反代（sankana-bangumi.de5.net/api）：
   * - `?type=2&year=2026&month=4&sort=rank&limit=100` → 200，`total=75`，一页取全（4.4s，首次）
   * - 只给 `month` 不给 `year` → `total=3062`（历年所有 4 月番），所以 year 必传
   * - 返回体是 `{data, total, limit, offset}`，条目里放送日期字段是 `date`
   *   （不是放送接口的 `air_date`），封面已被反代改写成 `/img/r/400/…` 的缩放地址。
   *
   * month 允许传该季度里的任意一个月，内部会规范化到季度（缓存键也只认季度）。
   */
  async season(year: number, month: number, force = false): Promise<SeasonResult> {
    const y = Math.trunc(year) || new Date().getFullYear()
    const season = seasonIndexOfMonth(month)
    const key = `season-${y}-${season}`
    const cache = this.readCache<SeasonItem[]>(key)
    if (!force && cache && Date.now() - cache.fetchedAt < TTL_SEASON) {
      return { year: y, season, fromCache: true, fetchedAt: cache.fetchedAt, items: cache.data }
    }
    try {
      const items = await this.fetchSeason(y, season)
      this.writeCache(key, items)
      return { year: y, season, fromCache: false, fetchedAt: Date.now(), items }
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
   * 拉取一个季度的三个月份并合并去重。
   *
   * 三个月并行发（`requestBest` 内部的并发闸门会把实际并发压到 2，不会打爆个人反代）；
   * **只要有一个月成功就返回该月的数据** —— 某个月偶发 5xx 时，
   * 用户看到的是「少了几条、但列表照常可用」，而不是整块「该季度数据暂不可用」。
   */
  private async fetchSeason(year: number, season: number): Promise<SeasonItem[]> {
    const months = monthsOfSeason(season)
    const settled = await Promise.allSettled(months.map((m) => this.fetchSeasonMonth(year, m)))
    const lists = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    if (lists.length === 0) {
      const first = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      throw first?.reason ?? new Error('季度取数失败')
    }
    const seen = new Set<number>()
    const items: SeasonItem[] = []
    // 保持接口给的顺序（sort=rank：热度/排名靠前的在前），仅按 id 去重
    for (const list of lists) {
      for (const item of list) {
        if (item.id <= 0 || seen.has(item.id)) continue
        seen.add(item.id)
        items.push(item)
      }
    }
    return items
  }

  /** 取某个季度的单个月份（`/v0/subjects?type=2&year=&month=&sort=rank`） */
  private async fetchSeasonMonth(year: number, month: number): Promise<SeasonItem[]> {
    const path = `/v0/subjects?type=2&year=${year}&month=${month}&sort=rank&limit=${SEASON_PAGE_LIMIT}`
    /*
     * 三个路径都给同一个地址：季度检索只有 v0 JSON 接口有（官方网页版的 /anime/browser
     * 是另一套 HTML，解析成本高且公共镜像已基本不可达）。
     * 配了自建反代时 requestBest 只会用反代；若用户把数据源切回纯网页镜像，
     * 这里会拿到 HTML —— 下面 isApiMirror 判定后直接报错，界面显示「该季度数据暂不可用」，
     * 而不是把 HTML 当 JSON 解析崩掉。
     */
    const { text, mirror } = await this.requestBest({ api: path, web: path, customApi: path })
    if (!isApiMirror(mirror)) {
      throw makeSourceError('PARSE', '当前数据源不支持季度接口（需要用 API 型数据源，如自建反代）', [mirror])
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

  async subject(id: number): Promise<SubjectResult> {
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
    const cache = this.readCache<SubjectDetail>(key)
    if (cache && Date.now() - cache.fetchedAt < TTL_SUBJECT) {
      return { fromCache: true, data: cache.data }
    }
    /*
     * v0.2.7 附加：过期缓存**先照常返回全部详情**，刷新放到后台静默做。
     *
     * 这样「打开详情页」永远不会因为反代慢/瞬时 5xx 而变成「信息加载不出来」——
     * 用户看到的仍是完整详情（infobox/标签/制作信息一个都不少），
     * 反代只在后台被请求一次（单飞去重），压力显著下降。
     */
    if (cache) {
      void this.fetchSubject(id)
        .then((fresh) => this.writeCache(key, fresh))
        .catch((err) => log.append('warn', 'bangumi', `后台刷新详情失败 (#${id})，继续用缓存: ${String(err)}`))
      return { fromCache: true, stale: true, data: cache.data }
    }
    try {
      const detail = await this.fetchSubject(id)
      this.writeCache(key, detail)
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

  /** 拉取并归一化一部番剧的完整详情（v0 走 JSON，网页镜像走 HTML 解析） */
  private async fetchSubject(id: number): Promise<SubjectDetail> {
    const { text, mirror } = await this.requestBest({
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
    })
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

  /** 补全番剧评分（日历页不含评分，从详情页提取，7 天缓存，并发 4） */
  async ratings(ids: number[]): Promise<Record<number, { score: number | null; total: number }>> {
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
      if (cache && Date.now() - cache.fetchedAt < TTL_RATING) {
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
          const { text, mirror } = await this.requestBest({
            api: `/v0/subjects/${id}`,
            web: `/subject/${id}`,
            // 同 subject()：自建反代必须走 /v0/，否则拿到的是缺字段的旧版 API 形态
            customApi: `/v0/subjects/${id}`
          })
          const data = isApiMirror(mirror)
            ? (() => {
                const s = JSON.parse(text) as { rating?: { score?: number; total?: number } }
                const score = Number(s.rating?.score ?? 0)
                return { score: score > 0 ? score : null, total: Number(s.rating?.total ?? 0) }
              })()
            : parseRatingOnly(text)
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

  async testMirrors(): Promise<MirrorTestResult[]> {
    return await Promise.all(
      this.mirrors().map(async (mirror): Promise<MirrorTestResult> => {
        const start = Date.now()
        let url: string
        let isApi = false
        try {
          const u = new URL(mirror)
          isApi = isApiHost(u.hostname) || isCustomApiBase(mirror)
          /*
           * v0.2.7 修：自建反代的日历在 `/calendar`（`/v0/calendar` 是 404）。
           * 过去这里对 API 型地址一律拼 `/v0/calendar`，于是「测试连接」把
           * 明明能用的自建反代报成失败。改走与真实取数一致的 calendarPathFor。
           */
          url = isApi
            ? `${mirror}${this.calendarPathFor(mirror, { api: '/v0/calendar', web: '/calendar', customApi: '/calendar' })}`
            : `${mirror}/calendar`
        } catch {
          url = `${mirror}/calendar`
        }
        try {
          /*
           * 走与真实取数完全相同的路径（含「被机器人校验时改用离屏浏览器」），
           * 否则 bangumi.vip 这类站点在测试里会被判失败 —— 明明应用能正常用它。
           */
          const text = await this.fetchMirror(url, isApi)
          const ok = isApi ? text.trim().startsWith('[') : text.includes('coverList')
          return { url: mirror, ok, ms: Date.now() - start, error: ok ? undefined : '响应格式不符（可能需要校验或该地址不是番组计划镜像）' }
        } catch (err) {
          const e = err as { message?: string }
          return { url: mirror, ok: false, ms: Date.now() - start, error: e?.message ?? String(err) }
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
      const text = await this.fetchMirror(`${mirror}/subject_search/${encodeURIComponent(kw)}?cat=2`, false)
      return parseSearchPage(text)
    }

    /**
     * 一个数据源上的完整尝试链：v0 → 老接口，每个接口再按关键词变体各试一次。
     * 只有「全部接口都抛错」才算失败；「接口通了但没结果」返回空数组（由上层继续试别的源）。
     */
    const viaBase = async (base: string, isApi: boolean, kw: string): Promise<SearchResultItem[]> => {
      if (!isApi) return await viaMirror(base, kw)
      let firstError: unknown = null
      for (const variant of searchKeywordVariants(kw)) {
        try {
          const items = await this.searchViaV0(base, variant)
          if (items.length > 0) {
            log.append('info', 'bangumi', `搜索命中：v0「${variant}」→ ${items.length} 条（${base}）`)
            return items
          }
        } catch (err) {
          firstError = firstError ?? err
          log.append('warn', 'bangumi', `v0 搜索失败「${variant}」（${base}）：${String((err as Error)?.message ?? err)}`)
        }
        try {
          const items = await this.searchViaLegacy(base, variant)
          if (items.length > 0) {
            log.append('info', 'bangumi', `搜索命中：老接口「${variant}」→ ${items.length} 条（${base}）`)
            return items
          }
        } catch (err) {
          firstError = firstError ?? err
          log.append('warn', 'bangumi', `老接口搜索失败「${variant}」（${base}）：${String((err as Error)?.message ?? err)}`)
        }
      }
      if (firstError) throw firstError
      return []
    }

    // 与 requestBest 一致：配了自建反代就只用它，失败直接提示用户手动切换镜像（不再自动回退）
    const custom = (getSettings().bangumiCustomApi ?? '').trim().replace(/\/+$/, '')
    if (custom) {
      try {
        return await viaBase(custom, true, keyword)
      } catch (err) {
        const reason = String((err as Error)?.message ?? err)
        log.append('error', 'bangumi', `自建反代搜索失败: ${reason}`)
        throw makeSourceError(
          'ALL_DOWN',
          `自建反代搜索不可用（${reason}）。请到「设置 → 数据源配置」检查反代地址，或手动切换到其它镜像站`,
          [`${custom}: ${reason}`]
        )
      }
    }
    const attempts = this.mirrors().map(async (mirror) => await viaBase(mirror, isApiMirror(mirror), keyword))
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
    const res = await axios.post(
      `${base}/v0/search/subjects?limit=24&responseGroup=small`,
      { keyword, filter: { type: [2] } },
      {
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': BROWSER_UA, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...buildProxyAgents(getSettings().proxy)
      }
    )
    if (res.status !== 200) throw new Error(`${base}: HTTP ${res.status}`)
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
    const res = await axios.get(
      `${base}/search/subject/${encodeURIComponent(keyword)}?type=2&responseGroup=large`,
      {
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
        ...buildProxyAgents(getSettings().proxy)
      }
    )
    if (res.status !== 200) throw new Error(`${base}: HTTP ${res.status}`)
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
      const { text, mirror } = await this.requestBest({
        api: `/v0/subjects/${id}/characters`,
        web: `/v0/subjects/${id}/characters`,
        customApi: `/v0/subjects/${id}/characters`
      })
      if (!isApiMirror(mirror)) throw new Error(`${mirror}: 网页镜像不提供 v0 角色接口`)
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
   * 竞速/兜底写法复用 `requestBest` 的策略：
   * - 配了自建反代就**只用反代**（失败把错误抛给界面，由用户去「设置 → 数据源配置」切换，
   *   不在用户不知情的情况下偷偷换源）；
   * - 没配反代时所有 API 型镜像并行发，第一个成功就立刻返回，不等其余。
   * 只对 API 型数据源发起：网页镜像的同一个地址返回的是 HTML 页面，里面没有结构化角色列表。
   */
  private async charactersLegacy(id: number): Promise<CharacterItem[]> {
    const custom = (getSettings().bangumiCustomApi ?? '').trim().replace(/\/+$/, '')
    const bases = (custom ? [custom] : this.mirrors()).filter((m) => isApiMirror(m))
    if (bases.length === 0) {
      throw makeSourceError('PARSE', '当前数据源不支持角色接口（需要用 API 型数据源，如自建反代）', [])
    }
    const attempts = bases.map(async (base): Promise<CharacterItem[]> => {
      const url = `${base}/subject/${id}?responseGroup=large`
      try {
        const text = await this.fetchMirror(url, true)
        const items = this.normalizeCharactersLegacy(JSON.parse(text) as unknown)
        if (items.length === 0) throw new Error('响应里没有 crt 角色数组')
        return items
      } catch (err) {
        throw new Error(`${base}: ${String((err as Error)?.message ?? err)}`)
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

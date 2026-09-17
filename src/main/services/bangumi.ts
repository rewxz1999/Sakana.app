import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import type {
  CalendarDay,
  CalendarResult,
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
import { monthsOfSeason, seasonIndexOfMonth } from '@shared/season'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import { store } from '../store'
import { parseCalendar, parseRatingOnly, parseSearchPage, parseSubjectPage } from './bangumiHtml'
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
      // 过期缓存照样可用：季度条目几乎不变，宁可给旧数据也不要空弹窗
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
      if (cache) return { items: cache.data }
      return { items: [], error }
    }
  }

  /** 补全番剧评分（日历页不含评分，从详情页提取，7 天缓存，并发 4） */
  async ratings(ids: number[]): Promise<Record<number, { score: number | null; total: number }>> {
    const out: Record<number, { score: number | null; total: number }> = {}
    const missing: number[] = []
    for (const id of [...new Set(ids)]) {
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
   */
  private async searchRace(keyword: string): Promise<SearchResultItem[]> {
    const enc = encodeURIComponent(keyword)
    /** API 源搜索：v0 与自建反代都要求 POST + JSON body */
    const viaApi = async (base: string): Promise<SearchResultItem[]> => {
      const res = await axios.post(
        `${base}/v0/search/subjects?limit=24&responseGroup=small`,
        { keyword },
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
    // 与 requestBest 一致：配了自建反代就只用它，失败直接提示用户手动切换镜像（不再自动回退）
    const custom = (getSettings().bangumiCustomApi ?? '').trim().replace(/\/+$/, '')
    if (custom) {
      try {
        return await viaApi(custom)
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
    const attempts = this.mirrors().map(async (mirror) => {
      const isApi = isApiMirror(mirror)
      if (isApi) return await viaApi(mirror)
      const text = await this.fetchMirror(`${mirror}/subject_search/${enc}?cat=2`, false)
      return parseSearchPage(text)
    })
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
}

export const bangumi = new BangumiService()

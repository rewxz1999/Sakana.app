import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import type {
  CalendarDay,
  CalendarResult,
  MirrorTestResult,
  SearchResult,
  SearchResultItem,
  SourceError,
  SubjectDetail,
  SubjectResult
} from '@shared/types'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import { store } from '../store'
import { parseCalendar, parseRatingOnly, parseSearchPage, parseSubjectPage } from './bangumiHtml'
import { offscreenGet } from './offscreenFetch'

const TTL_CALENDAR = 30 * 60 * 1000
const TTL_SUBJECT = 7 * 24 * 3600 * 1000
const TTL_SEARCH = 30 * 60 * 1000
const TTL_RATING = 7 * 24 * 3600 * 1000
const REQUEST_TIMEOUT = 12000

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
 * 把官方图床地址改写到自建图片反代（Worker 的 IMG_HOST）。
 * Worker 按**路径**转发（`/pic/cover/l/xxx.jpg`），所以只替换 origin，路径保留。
 */
export function rewriteImageUrl(url: string): string {
  const custom = getSettings().bangumiCustomImg?.trim().replace(/\/+$/, '')
  if (!custom || !url) return url
  try {
    const u = new URL(url)
    // 只改官方图床（lain.bgm.tv / bgm.tv 系），其它第三方图床保持原样
    if (!/(^|\.)bgm\.tv$/i.test(u.hostname)) return url
    const base = new URL(custom)
    return `${base.origin}${u.pathname}${u.search}`
  } catch {
    return url
  }
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
        anibaseVipMigrated?: boolean
      }
      if (s.anibaseVipMigrated) return
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
          anibaseVipMigrated: true
        })
        log.append('info', 'bangumi', `已把镜像 ${VIP} 加入数据源列表（原列表：${list.join(', ') || '空'}）`)
      } else {
        store.set('settings', { ...(s as Record<string, unknown>), anibaseVipMigrated: true })
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
    // 自建反代永远排第一（并行请求里它最快，且是唯一可控的通道）
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
    // 连接被重置时先缓一下重试一次：实测启动瞬间并发请求过多会被中间设备重置，
    // 隔几秒再来一次通常就通了（比直接把整个数据源判死更符合真实情况）
    if (!text && isNetworkReset(directError)) {
      await new Promise((r) => setTimeout(r, 3000))
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
  private async requestBest(paths: { api: string; web: string }): Promise<{ text: string; mirror: string }> {
    const attempts = this.mirrors().map(async (mirror) => {
      let url: string
      let isApi = false
      try {
        const u = new URL(mirror)
        // 自建反代虽然域名可能不含 api.，但它代理的就是 API 主机 → 走 /v0 JSON 路径
        isApi = isApiHost(u.hostname) || isCustomApiBase(mirror)
        url = isApi ? `${mirror}${paths.api}` : `${mirror}${paths.web}`
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
      const { text, mirror } = await this.requestBest({ api: '/v0/calendar', web: '/calendar' })
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

  async subject(id: number): Promise<SubjectResult> {
    const key = `subject-${id}`
    const cache = this.readCache<SubjectDetail>(key)
    if (cache && Date.now() - cache.fetchedAt < TTL_SUBJECT) {
      return { fromCache: true, data: cache.data }
    }
    try {
      const { text, mirror } = await this.requestBest({
        api: `/v0/subjects/${id}`,
        web: `/subject/${id}`
      })
      let detail: SubjectDetail | null
      if (isApiMirror(mirror)) {
        detail = this.normalizeSubject(JSON.parse(text) as Record<string, unknown>)
      } else {
        detail = parseSubjectPage(text, id)
      }
      if (!detail) throw new Error('详情页解析失败')
      this.writeCache(key, detail)
      return { fromCache: false, data: detail }
    } catch (err) {
      const error: SourceError =
        err && typeof err === 'object' && 'kind' in err
          ? (err as SourceError)
          : makeSourceError('NETWORK', String(err), [])
      log.append('warn', 'bangumi', `获取详情失败 (#${id}): ${error.message}`)
      if (cache) return { fromCache: true, data: cache.data }
      return { fromCache: false, data: null, error }
    }
  }

  async search(keyword: string): Promise<SearchResult> {
    const key = `search-${createHash('md5').update(keyword).digest('hex')}`
    const cache = this.readCache<SearchResultItem[]>(key)
    if (cache && Date.now() - cache.fetchedAt < TTL_SEARCH) {
      return { items: cache.data }
    }
    try {
      const { text, mirror } = await this.requestBest({
        api: `/v0/search/subjects/${encodeURIComponent(keyword)}?limit=24&responseGroup=small`,
        web: `/subject_search/${encodeURIComponent(keyword)}?cat=2`
      })
      let items: SearchResultItem[]
      if (isApiMirror(mirror)) {
        const list = (JSON.parse(text) as { data?: Record<string, unknown>[] })?.data ?? []
        items = list.map((raw) => this.normalizeItem(raw))
      } else {
        items = parseSearchPage(text)
      }
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
    const workers = Array.from({ length: Math.min(4, missing.length) }, async () => {
      while (i < missing.length) {
        const id = missing[i++]
        try {
          const { text, mirror } = await this.requestBest({
            api: `/v0/subjects/${id}`,
            web: `/subject/${id}`
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
          url = isApi ? `${mirror}/v0/calendar` : `${mirror}/calendar`
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
    return {
      id: Number(raw.id ?? 0),
      name: String(raw.name ?? ''),
      name_cn: String(raw.name_cn ?? ''),
      summary: String(raw.summary ?? ''),
      air_date: raw.air_date ? String(raw.air_date) : null,
      images: (raw.images as SubjectDetail['images']) ?? null,
      rating: (raw.rating as SubjectDetail['rating']) ?? null,
      tags: Array.isArray(raw.tags) ? (raw.tags as { name: string; count?: number }[]) : [],
      infobox: Array.isArray(raw.infobox) ? (raw.infobox as { key: string; value: string }[]) : [],
      eps: raw.eps != null ? Number(raw.eps) : undefined,
      volumes: raw.volumes != null ? Number(raw.volumes) : undefined
    }
  }
}

export const bangumi = new BangumiService()

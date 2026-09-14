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
import { parseCalendar, parseRatingOnly, parseSearchPage, parseSubjectPage } from './bangumiHtml'

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
  }

  private mirrors(): string[] {
    const s = getSettings()
    const list = Array.isArray(s.bangumiMirrors) && s.bangumiMirrors.length > 0
      ? s.bangumiMirrors
      : [s.bangumiBase || 'https://bangumi.pro']
    return [...new Set(list.map((m) => m.replace(/\/+$/, '')))]
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
   * 并行尝试所有镜像，返回第一个成功响应。
   * api 镜像走 JSON 路径，网页镜像走 HTML 路径。
   */
  private async requestBest(paths: { api: string; web: string }): Promise<{ text: string; mirror: string }> {
    const attempts = this.mirrors().map(async (mirror) => {
      let url: string
      try {
        const u = new URL(mirror)
        url = isApiHost(u.hostname) ? `${mirror}${paths.api}` : `${mirror}${paths.web}`
      } catch {
        url = `${mirror}${paths.web}`
      }
      try {
        const res = await axios.get(url, {
          timeout: REQUEST_TIMEOUT,
          responseType: 'text',
          headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' },
          ...buildProxyAgents(getSettings().proxy)
        })
        if (res.status === 200) return { text: res.data as string, mirror }
        throw new Error(`HTTP ${res.status}`)
      } catch (err) {
        const e = err as { code?: string; message?: string }
        const reason = e?.code === 'ECONNABORTED' ? '超时' : (e?.message ?? String(err))
        throw new Error(`${mirror}: ${reason}`)
      }
    })
    const settled = await Promise.allSettled(attempts)
    const success = settled.find((r) => r.status === 'fulfilled')
    if (success && success.status === 'fulfilled') return success.value
    const tried = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason?.message ?? r.reason))
    throw makeSourceError('ALL_DOWN', `所有 bangumi 镜像均不可访问`, tried)
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
      if (mirror.includes('api.')) {
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
      if (mirror.includes('api.')) {
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
      if (mirror.includes('api.')) {
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
          const data = mirror.includes('api.')
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
        try {
          const u = new URL(mirror)
          url = isApiHost(u.hostname) ? `${mirror}/v0/calendar` : `${mirror}/calendar`
        } catch {
          url = `${mirror}/calendar`
        }
        try {
          const res = await axios.get(url, {
            timeout: 8000,
            responseType: 'text',
            headers: { 'User-Agent': BROWSER_UA },
            ...buildProxyAgents(getSettings().proxy)
          })
          let ok = false
          if (res.status === 200) {
            const text = res.data as string
            ok = url.includes('api.') ? text.trim().startsWith('[') : text.includes('coverList')
          }
          return { url: mirror, ok, ms: Date.now() - start, error: ok ? undefined : `HTTP ${res.status} 或响应格式不符` }
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

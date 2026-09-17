import axios from 'axios'
import { XMLParser } from 'fast-xml-parser'
import type { DownloadTask, MikanItem, MikanSearchResult, SubUpdateCheck, Subscription } from '@shared/types'
import { parseEpisode, parseGroup, parseResolution, humanSize } from '../lib/parse'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import { store } from '../store'

/** 蜜柑计划（方案 4.1：订阅数据源，RSS） */
export const MIKAN_BASE = 'https://mikanani.kas.pub'

interface RssRawItem {
  /**
   * RSS 的 <guid isPermaLink="false">xxx</guid>。
   *
   * 坑：本文件的 XMLParser 配了 `ignoreAttributes: false`，fast-xml-parser 会把**带属性的节点**
   * 解析成对象 `{ '#text': 'xxx', '@_isPermaLink': 'false' }`，
   * 于是 `String(raw.guid)` 得到的是 `"[object Object]"` —— 整份 RSS 里每一条都一模一样。
   * 这个字符串同时是「确认下载」列表的 React key 与勾选集合的键，
   * 撞车后表现为「勾一条全被勾上」以及「下载所选 1 项」却下载了全部，所以必须取 #text。
   */
  guid?: unknown
  title?: string
  link?: unknown
  pubDate?: string
  /** 蜜柑的发布日期挂在 <torrent><pubDate> 上（顶层没有 pubDate） */
  torrent?: { pubDate?: unknown }
  enclosure?: { '@_url'?: string; '@_length'?: string | number }
}

/** 取 XML 节点文本：兼容 fast-xml-parser 把带属性节点解析成对象的情况 */
function nodeText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    const t = (v as Record<string, unknown>)['#text']
    if (typeof t === 'string') return t.trim()
    if (typeof t === 'number') return String(t)
  }
  return ''
}

/**
 * 字幕组归一化与匹配规则放在 shared 里：主进程的过滤与「确认下载」弹窗的兜底过滤
 * 必须用同一份规则（见 shared/subgroup.ts 的说明）。
 */
import { matchesSubGroup } from '@shared/subgroup'

export { matchesSubGroup, normGroup } from '@shared/subgroup'

class MikanService {
  async search(keyword: string): Promise<MikanSearchResult> {
    try {
      const url = `${MIKAN_BASE}/RSS/Search?searchstr=${encodeURIComponent(keyword)}`
      const res = await axios.get(url, {
        timeout: 15000,
        responseType: 'text',
        headers: { 'User-Agent': BROWSER_UA },
        ...buildProxyAgents(getSettings().proxy)
      })
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
      const doc = parser.parse(res.data as string) as {
        rss?: { channel?: { item?: RssRawItem[] | RssRawItem } }
      }
      const rawItems = doc?.rss?.channel?.item ?? []
      const list: RssRawItem[] = Array.isArray(rawItems) ? rawItems : [rawItems]
      const seen = new Set<string>()
      const items: MikanItem[] = []
      for (const raw of list) {
        const title = String(raw.title ?? '')
        if (!title) continue
        const base = nodeText(raw.guid) || nodeText(raw.link) || title
        // guid 必须全局唯一：它既是列表行标识也是勾选键，重复就会出现「勾一条全勾上」
        let guid = base
        for (let n = 2; seen.has(guid); n++) guid = `${base}#${n}`
        seen.add(guid)
        items.push({
          guid,
          title,
          link: nodeText(raw.link),
          torrentUrl: raw.enclosure?.['@_url'] ? String(raw.enclosure['@_url']) : null,
          magnet: null,
          size: humanSize(Number(raw.enclosure?.['@_length'] ?? 0)),
          // 发布日期在 <torrent><pubDate> 里；过去只读顶层 raw.pubDate 拿到的一直是空串，
          // 于是「本集发布日期」永远空白、按日期判断新资源的过滤也形同虚设
          pubDate: nodeText(raw.pubDate) || nodeText(raw.torrent?.pubDate),
          group: parseGroup(title),
          episode: parseEpisode(title),
          resolution: parseResolution(title)
        })
      }
      return { items }
    } catch (err) {
      const e = err as { message?: string }
      const msg = e?.message ?? String(err)
      log.append('error', 'mikan', `搜索失败 (${keyword}): ${msg}`)
      return { items: [], error: msg }
    }
  }

  /** 检测单个订阅的新资源（方案 4.2：仅检测，需用户确认后下载；已存在下载任务的资源不再提示） */
  async checkSub(sub: Subscription): Promise<SubUpdateCheck> {
    const result = await this.search(sub.mikanKeyword)
    const downloads = store.get<DownloadTask[]>('downloads', [])
    // 该资源是否已被处理过（存在非错误状态的下载任务）
    const handled = (item: MikanItem): boolean =>
      downloads.some(
        (d) =>
          d.status !== 'error' &&
          ((item.torrentUrl && d.torrentUrl === item.torrentUrl) ||
            (d.name && d.name === item.title) ||
            (d.subscriptionId === sub.id &&
              item.episode != null &&
              d.episode === item.episode &&
              d.group === item.group))
      )
    const newItems = result.items
      .filter((item) => {
        // 只留订阅选定字幕组的资源（归一化比较；解析不出字幕组的一律不要，见 matchesSubGroup）
        if (!matchesSubGroup(sub.group, item.group)) return false
        if (handled(item)) return false
        if (!sub.lastPubDate) return true
        const itemTime = new Date(item.pubDate).getTime()
        const lastTime = new Date(sub.lastPubDate).getTime()
        return !Number.isNaN(itemTime) && itemTime > lastTime
      })
      .map((item) => ({ ...item, isNew: true }))
    return { subId: sub.id, newItems, checkedAt: Date.now() }
  }

  /** 应用启动时自动检测全部订阅（方案 4.2） */
  async checkAllSubscriptions(): Promise<SubUpdateCheck[]> {
    const subs = store.get<Subscription[]>('subscriptions', [])
    if (subs.length === 0) return []
    log.append('info', 'mikan', `启动更新检测：${subs.length} 个订阅`)
    const updates: SubUpdateCheck[] = []
    // 并发限制 2，避免请求过快
    for (let i = 0; i < subs.length; i += 2) {
      const batch = subs.slice(i, i + 2)
      const results = await Promise.all(
        batch.map(async (sub) => {
          try {
            return await this.checkSub(sub)
          } catch (err) {
            log.append('warn', 'mikan', `检测订阅失败 (${sub.nameCn}): ${String(err)}`)
            return { subId: sub.id, newItems: [], checkedAt: Date.now() }
          }
        })
      )
      for (const u of results) {
        if (u.newItems.length > 0) updates.push(u)
      }
    }
    const map = new Map(updates.map((u) => [u.subId, u]))
    const next = subs.map((sub) => {
      const u = map.get(sub.id)
      if (u) return { ...sub, status: 'waiting' as const }
      // 之前标记 waiting 但本次已无新资源（已下载/已确认）→ 复位
      if (sub.status === 'waiting') return { ...sub, status: 'complete' as const }
      return sub
    })
    if (JSON.stringify(next) !== JSON.stringify(subs)) store.set('subscriptions', next)
    if (updates.length > 0) {
      log.append('info', 'mikan', `发现 ${updates.length} 个订阅有资源更新，等待用户确认`)
    }
    return updates
  }
}

export const mikan = new MikanService()

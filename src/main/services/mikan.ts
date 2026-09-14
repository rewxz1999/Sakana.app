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
  guid?: string
  title?: string
  link?: string
  pubDate?: string
  enclosure?: { '@_url'?: string; '@_length'?: string | number }
}

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
      const items: MikanItem[] = list
        .map((raw): MikanItem => {
          const title = String(raw.title ?? '')
          const torrentUrl = raw.enclosure?.['@_url'] ? String(raw.enclosure['@_url']) : null
          return {
            guid: String(raw.guid ?? raw.link ?? title),
            title,
            link: String(raw.link ?? ''),
            torrentUrl,
            magnet: null,
            size: humanSize(Number(raw.enclosure?.['@_length'] ?? 0)),
            pubDate: String(raw.pubDate ?? ''),
            group: parseGroup(title),
            episode: parseEpisode(title),
            resolution: parseResolution(title)
          }
        })
        .filter((i) => i.title)
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
        if (sub.group && item.group && item.group !== sub.group) return false
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

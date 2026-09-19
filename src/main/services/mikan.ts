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
import {
  baseSearchKeyword,
  parseTitleSeason,
  sameBase,
  sameSeason,
  seasonLabel,
  type TitleKind,
  // parseTitleSeason 的返回类型：过滤链内部要给它起名（strict 模式下的 parsed 数组）
  type TitleSeasonInfo as TitleParse
} from '@shared/titleSeason'

export { matchesSubGroup, normGroup } from '@shared/subgroup'

/**
 * 订阅更新检测的搜索词候选：**原关键词 + 从 nameCn/name 派生的基名**，去重后最多 3 个。
 *
 * 为什么不能只用 sub.mikanKeyword：它等于 `nameCn || name`，也就是 Bangumi 上的完整番剧名
 * （《从零开始的异世界生活 第四季》《无职转生～到了异世界就拿出真本事～》）。
 * 实测（.e2e/test-sub-match.js，真实拉 RSS）蜜柑的搜索有两个要命的性质：
 *   ① **对标点敏感**：《孤独摇滚！》的全角「！」只搜到 100 条、里面一条千夏字幕组的都没有；
 *      换成半角「!」搜到 47 条、其中 41 条就是千夏字幕组的（他们标题里写的是半角 `!`）。
 *   ② **单次结果有上限（实测 100 条）且按时间倒序**：换个写法就能翻出被上限截掉的条目。
 * 所以这里故意让「原关键词（原始标点）」和「派生基名（NFKC 折叠过标点）」**同时存在**：
 * 去重只按「去空白 + 小写」比较，全角/半角不同写法不会被合并掉，等于一次订阅查多个写法。
 *
 * 派生基名还负责去掉季数后缀（《…第四季》→《…》），并且会把 name 换成日文名 ——
 * 「中文名 ↔ 日文名/罗马音」的对应完全交给蜜柑自己的搜索，
 * 本地只做同语言字符串比较（见 shared/titleSeason.sameBase 的注释）。
 */
function keywordCandidates(sub: Subscription): string[] {
  const raw = [
    sub.mikanKeyword,
    baseSearchKeyword(sub.nameCn || ''),
    baseSearchKeyword(sub.name || '')
  ]
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of raw) {
    const s = String(k ?? '').trim()
    if (!s) continue
    const key = s.replace(/\s+/g, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= 3) break
  }
  return out
}

/** 订阅条目自身的类型（用于判断「订阅本身就是电影/OVA」） */
function subKindOf(cn: TitleKind, name: TitleKind): TitleKind {
  return cn !== 'unknown' ? cn : name
}

/**
 * 资源是否比「上次检测到的发布日期」更新（v0.2.16 抽出为独立函数，严格/宽松两条路共用）。
 *
 * 注意 pubDate 解析失败时**算通过**（返回 true）：蜜柑的 pubDate 偶尔缺失或格式特殊，
 * 若把「解析不出时间」当成「不够新」，用户会看到订阅明明有资源却一个都不提示 ——
 * 这正是「什么资源都订阅不到」的一种成因，所以这里宁可放过。
 */
function isNewerThanLast(item: MikanItem, lastPubDate?: string | null): boolean {
  if (!lastPubDate) return true
  const itemTime = new Date(item.pubDate).getTime()
  if (Number.isNaN(itemTime)) return true
  const lastTime = new Date(lastPubDate).getTime()
  if (Number.isNaN(lastTime)) return true
  return itemTime > lastTime
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

  /**
   * 检测单个订阅的新资源（方案 4.2：仅检测，需用户确认后下载；已存在下载任务的资源不再提示）
   *
   * 匹配规则（按用户要求重写）：**同一字幕组 + 同一番剧（基名一致）+ 同一季** 的、
   * 带集数或属于 OVA/剧场版/特别篇的资源才算这个订阅的资源。
   *
   * 过滤顺序：
   *   ① 字幕组一致（matchesSubGroup，保持原样）
   *   ② 基名一致（shared/titleSeason.sameBase）
   *   ③ 同季（shared/titleSeason.sameSeason）
   *   ④ 有集数，或 OVA/剧场版/特别篇；订阅本身是电影/OVA、或基名一致的条目里压根没有带集数的
   *      （例如纯 OVA《库特wafter》）时，允许没有集数的条目
   *   ⑤ 原有逻辑不变：已处理过的不算、pubDate 不晚于 lastPubDate 的不算，结果带 isNew
   *
   * 签名与返回结构（SubUpdateCheck）保持原样，IPC / 类型 / UI 都不用动。
   */
  async checkSub(sub: Subscription): Promise<SubUpdateCheck> {
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

    const label = sub.nameCn || sub.name || sub.mikanKeyword
    const keywords = keywordCandidates(sub)

    // ---------- 搜索阶段（v0.2.16 重写）----------
    /*
     * 用户实测「什么资源都订阅不到」，日志是：
     *   候选 38 条 → 同字幕组 0 → 基名一致 0 → 命中 0
     * 而用真 RSS 一探就明白：主关键词（订阅的完整标题）能搜到 **100 条**、里面正有该字幕组的资源；
     * 另外两个派生关键词只搜到 36 + 2 条，且全是别的字幕组 —— **36+2 正好等于日志里的 38**。
     * 也就是说：**主关键词那次搜索在应用里失败了，而合并逻辑一声不吭地用剩下两个无关关键词继续跑**，
     * 于是字幕组过滤全灭。旧代码只搜一个关键词，失败会明确报错；多关键词合并把这个失败掩盖了。
     *
     * 所以这一版：① 每次搜索失败都重试一次并写日志（不再静默降级）；
     * ② 严格规则筛出 0 条时，追加「按字幕组名搜索」的候选再来一遍；
     * ③ 仍然 0 条就放宽成「只按字幕组」（旧行为）并标出来 ——
     *    宁可多给几条，也绝不出现「订阅了一个都搜不到」这种把功能整个关掉的失败模式。
     */
    const merged = new Map<string, MikanItem>()
    const addItems = (items: MikanItem[]): void => {
      for (const item of items) {
        // 按 guid 合并去重（guid 就是蜜柑的种子 id）；torrentUrl 兜一层底：同响应里的重复 guid
        // 会被 search() 加上 `#2` 后缀，跨响应时同一资源可能带不同后缀
        const key = item.torrentUrl ? `t:${item.torrentUrl}` : `g:${item.guid}`
        if (!merged.has(key)) merged.set(key, item)
      }
    }
    const searchLog: string[] = []
    const searchInto = async (kw: string): Promise<void> => {
      let res = await this.search(kw)
      if (res.error) {
        // 首次失败最常见的原因是瞬时网络/上游抖动 —— 直接放弃会让「候选」悄悄少掉一整批
        log.append('warn', 'mikan', `订阅《${label}》搜索失败「${kw}」，2 秒后重试一次：${res.error}`)
        await new Promise((r) => setTimeout(r, 2000))
        res = await this.search(kw)
        if (res.error) log.append('warn', 'mikan', `订阅《${label}》搜索仍然失败「${kw}」：${res.error}`)
      }
      searchLog.push(`${kw}=${res.items.length}${res.error ? '(失败)' : ''}`)
      addItems(res.items)
    }
    for (const kw of keywords) await searchInto(kw)

    // ---------- 过滤阶段 ----------
    const cnInfo = parseTitleSeason(sub.nameCn || '')
    const nameInfo = parseTitleSeason(sub.name || '')
    const subBase = cnInfo.base || nameInfo.base
    // 季数以中文名优先：nameCn 认不出季数时才退回日文名（两个名字来自同一个 Bangumi 条目）
    const subSeason = cnInfo.season ?? nameInfo.season
    const subKind = subKindOf(cnInfo.kind, nameInfo.kind)
    const noneHasEpisodeOf = (candidates: { item: MikanItem; info: TitleParse }[]): boolean =>
      candidates.length > 0 && candidates.every((p) => p.item.episode == null)
    const subIsMovieLike = subKind === 'movie' || subKind === 'ova'

    /**
     * 过滤链。`mode='strict'` 是用户要的「同字幕组 + 同基名 + 同季 + 有集数/OVA」；
     * `mode='loose'` 只保留字幕组（等价于旧版本的行为），作为兜底。
     */
    const applyFilters = (
      candidates: MikanItem[],
      mode: 'strict' | 'loose'
    ): {
      newItems: MikanItem[]
      stats: string
    } => {
      // ① 字幕组（订阅指定了字幕组时，解析不出字幕组的资源一律不要）
      const byGroup = candidates.filter((item) => matchesSubGroup(sub.group, item.group))
      if (mode === 'loose') {
        const out = byGroup.filter((item) => !handled(item) && isNewerThanLast(item, sub.lastPubDate))
        return {
          newItems: out.map((item) => ({ ...item, isNew: true })),
          stats: `候选 ${candidates.length} → 同字幕组 ${byGroup.length} → 命中 ${out.length}（宽松模式：只看字幕组）`
        }
      }

      const parsed = byGroup.map((item) => ({ item, info: parseTitleSeason(item.title) }))
      // ② 基名一致。跨语言的边界就在这里：同一部番剧的中文名/日文名互不包含，
      //    能匹配上是因为搜索阶段把两边的名字都搜了一遍；本地不做（也做不了）跨语言匹配。
      const baseMatched = parsed.filter((p) => sameBase(subBase, p.info.base))
      const baseSamples = parsed
        .filter((p) => !sameBase(subBase, p.info.base))
        .slice(0, 3)
        .map((p) => `${p.info.base || '(空)'} ← ${p.item.title}`)
      const allowNoEpisode = subIsMovieLike || noneHasEpisodeOf(baseMatched)

      const newItems: MikanItem[] = []
      let seasonRejected = 0
      let episodeRejected = 0
      let oldRejected = 0
      const seasonSamples: string[] = []
      for (const p of baseMatched) {
        const { item, info } = p
        // ③ 同季（movie/ova 没有季概念，见 sameSeason）
        if (!sameSeason(subSeason, info.season, info.kind)) {
          seasonRejected++
          if (seasonSamples.length < 3) seasonSamples.push(`${seasonLabel(info.season)} ← ${item.title}`)
          continue
        }
        // ④ 有集数，或本身就是 OVA/剧场版/特别篇，或订阅侧允许没有集数的条目
        const specialKind = info.kind === 'movie' || info.kind === 'ova' || info.kind === 'special'
        if (item.episode == null && !specialKind && !allowNoEpisode) {
          episodeRejected++
          continue
        }
        // ⑤ 已处理过的不算、不比 lastPubDate 新不算
        if (handled(item)) continue
        if (!isNewerThanLast(item, sub.lastPubDate)) {
          oldRejected++
          continue
        }
        newItems.push({ ...item, isNew: true })
      }
      const stats =
        `候选 ${candidates.length} → 同字幕组 ${byGroup.length} → 基名一致 ${baseMatched.length} → 命中 ${newItems.length}` +
        `（判掉：基名 ${parsed.length - baseMatched.length}、季数 ${seasonRejected}、无集数 ${episodeRejected}、早于上次 ${oldRejected}）` +
        (seasonSamples.length ? `；季数不符示例：${seasonSamples.join(' | ')}` : '') +
        (!baseMatched.length && baseSamples.length ? `；基名不符示例：${baseSamples.join(' | ')}` : '')
      return { newItems, stats }
    }

    let result = applyFilters([...merged.values()], 'strict')
    let mode: 'strict' | 'group-search' | 'loose' = 'strict'

    // ② 严格规则一条没命中 → 再用**字幕组名**搜一遍（同一个番剧在标题里换了名字时，只有这条路能捞到）
    if (result.newItems.length === 0 && sub.group) {
      const before = merged.size
      await searchInto(sub.group)
      if (merged.size > before) {
        const retry = applyFilters([...merged.values()], 'strict')
        if (retry.newItems.length > 0) {
          mode = 'group-search'
          result = retry
        }
      }
    }

    // ③ 还是 0 条 → 放宽成「只按字幕组」（旧行为）。宁可多给几条，也不能让订阅功能整个失效。
    if (result.newItems.length === 0 && sub.group) {
      const loose = applyFilters([...merged.values()], 'loose')
      if (loose.newItems.length > 0) {
        mode = 'loose'
        result = loose
      }
    }

    /*
     * 只在「有问题」时写日志：有判掉、一条基名都没匹配上、或者用了兜底路径、或有搜索失败。
     * 干净的检测不写，避免每次启动刷一屏。
     */
    const keywordFailed = searchLog.some((s) => s.includes('(失败)'))
    if (mode !== 'strict' || keywordFailed || result.newItems.length === 0) {
      log.append(
        'info',
        'mikan',
        `订阅《${label}》${seasonLabel(subSeason)}；搜索 ${searchLog.join(' / ') || '(无关键词)'}；${result.stats}` +
          (mode === 'strict' ? '' : `；**使用了兜底路径：${mode}**`)
      )
    }
    return { subId: sub.id, newItems: result.newItems, checkedAt: Date.now() }
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

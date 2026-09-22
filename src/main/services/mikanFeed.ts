// 蜜柑「按番剧 + 字幕组」的官方订阅 RSS（`RSS/Bangumi?bangumiId=…&subgroupid=…`）解析
//
// 为什么要有这个文件（用户的原始要求：「直接抄蜜柑的 RSS 订阅规则，现在的订阅规则老是失误」）：
// 旧链路是「拿番剧名去搜蜜柑的搜索 RSS → 再用我们自己的标题/字幕组判据挑出该番该组的条目」。
// 那条链会把两件事同时押在**我们自己的字符串判据**上：① 这份资源属于哪部番；② 属于哪个字幕组。
// 实测这两条都会出错（`.e2e/.probe/*` 里的真实响应）：
//   · 搜索 RSS 单次上限 100 条且按时间倒序 —— 换个写法才能翻出被截掉的条目；
//   · 标题判据（base 一致 / 含订阅名片段）会漏掉「换个语言写番剧名」的资源，也会漏掉短番剧名；
//   · 判据放宽又会把该字幕组**别的番**收进来（「订阅到不相关的番」）。
// 蜜柑自己的订阅页（番剧页每个字幕组旁边那个 RSS 图标）给出的地址，
// 是**蜜柑在服务端就按番剧 ID + 字幕组 ID 筛好**的 feed —— 这两件事都不再需要本地判据。
// 于是本地只保留「这确实是该番该组」的**解析**工作，判据变成蜜柑自己的番剧/字幕组条目。
//
// 实测结论（2026-09，mikanani.kas.pub，见报告）：
//   · `RSS/Bangumi?bangumiId=4011&subgroupid=364` → 200 / 11 条，**全部**是该番该组；
//   · 省略 `subgroupid` → 该番**所有**字幕组的条目（4011 实测 104 条，仍有 100 条上限）；
//   · `bangumiId` 或 `subgroupid` 不存在 → **HTTP 200 + 0 条**（不是 404！所以「0 条」必须
//     当成正常结果而不是错误，否则会把「这是老番还没更新」误报成「解析失败」）；
//   · 条目字段与搜索 RSS 完全一致：guid / title / link / torrent/pubDate / enclosure@url|@length。
//
// 入口解析只有「搜索页 HTML → 番剧页 HTML」两步，不依赖蜜柑的私有 JSON 接口：
//   ① `GET /Home/Search?searchstr=<番剧名>` 的结果卡片里直接带 `/Home/Bangumi/<id>`；
//   ② `GET /Home/Bangumi/<id>` 里每个字幕组是一个
//      `<div class="subgroup-text" id="<subgroupId>">`，其内第一个
//      `/Home/PublishGroup/<组ID>` 链接的文本就是字幕组名。

import axios from 'axios'
import type { Subscription } from '@shared/types'
import { XMLParser } from 'fast-xml-parser'
import { parseEpisode, parseGroup, parseResolution, humanSize } from '../lib/parse'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getFeedBase, getSettings, setFeedBase } from '../net'
import { matchesSubGroup, normGroup } from '@shared/subgroup'
import { baseSearchKeyword, parseTitleSeason, sameBase } from '@shared/titleSeason'

export interface FeedItem {
  guid: string
  title: string
  link: string
  torrentUrl: string | null
  pubDate: string
  group: string | null
  episode: number | null
  resolution: string | null
  size: string
}

/** 一次检测里的请求计数器：用于日志写清「解析花了几个请求 / 第二次检测有没有重新解析」 */
export interface FeedTrace {
  requests: number
  /** 每个请求的一行说明，直接拼进订阅检测日志 */
  lines: string[]
}

export function newFeedTrace(): FeedTrace {
  return { requests: 0, lines: [] }
}

/** 解析结果：命中缓存时 `fromCache` = true，日志据此证明「第二次检测没有重新解析」 */
export interface ResolvedSubFeed {
  bangumiId: number | null
  subgroupId: number | null
  /** bangumiId / subgroupId 是否来自订阅记录里的缓存（本次没有重新请求搜索页/番剧页） */
  fromCache: boolean
  /** 为什么没解析出来（写进日志用），解析成功时为空串 */
  reason: string
}

// ---------------------------------------------------------------------------
// 基础 HTTP / 文本工具
// ---------------------------------------------------------------------------

function getText(url: string): Promise<string> {
  return axios
    .get(url, {
      timeout: 15000,
      responseType: 'text',
      headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' },
      ...buildProxyAgents(getSettings().proxy)
    })
    .then((res) => String(res.data ?? ''))
}

/**
 * HTML 实体解码。
 *
 * 蜜柑的番剧页把中文名/字幕组名写成**数字实体**（实测 `&#x4E91;&#x5149;&#x5B57;&#x5E55;&#x7EC4;`
 * 就是「云光字幕组」），不解码的话字幕组名会变成一串 `&#x…;`，永远匹配不上订阅里记的名字。
 */
function decodeEntities(text: string): string {
  return String(text ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _m
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = parseInt(dec, 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _m
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&') // 必须最后做，否则 `&amp;lt;` 会被二次解码成 `<`
}

/** 去标签 + 实体解码 + 压空白（字幕组名要从 `&#x…;` 还原成可读文本） */
function stripTags(html: string): string {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** 归一化比较用文本：NFKC（全角→半角）+ 去空白 + 小写 */
function normKey(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * 字幕组名比较：归一化后**互相双向包含**算命中，并且要求较短的一方 ≥ 3 个字符。
 *
 * 为什么不是 `matchesSubGroup` 那种严格相等：番剧页上的字幕组名与资源标题里的 `[组名]`
 * 是**两个不同来源**，实测确实会不一致 ——
 *   · `bangumiId=4011&subgroupid=370`：番剧页写「LoliHouse」，而条目标题前缀是
 *     `[喵萌奶茶屋&LoliHouse]`（同一组合并署名的两种写法）；
 *   · `bangumiId=3995&subgroupid=45`：番剧页那条**根本没有组名**（生肉/不明字幕），
 *     条目前缀却是 `[爱恋字幕社]`。
 * 严格相等在这两处都会让「番对了、组也对」的订阅整批丢掉 —— 正是用户抱怨的
 * 「有时候订阅不到」。所以解析阶段用宽松包含匹配；**严格的 `matchesSubGroup`
 * 仍然保留在回落链路里当硬门槛**（见 mikan.ts 的注释）。
 * 较短一方 ≥ 3 个字符是为了避免「ANi」这类超短名靠包含关系乱配。
 */
export function sameSubGroupName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normGroup(a)
  const y = normGroup(b)
  if (!x || !y) return false
  if (x === y) return true
  const shorter = x.length <= y.length ? x : y
  if (shorter.length < 3) return false
  return x.includes(y) || y.includes(x)
}

// ---------------------------------------------------------------------------
// ① RSS 解析（与 mikan.search 共用同一套字段语义）
// ---------------------------------------------------------------------------

interface RssRawItem {
  /**
   * `<guid isPermaLink="false">…</guid>`。
   *
   * 坑（mikan.ts 里踩过、这里必须一并处理）：XMLParser 配了 `ignoreAttributes: false`，
   * 带属性的节点会被解析成对象 `{ '#text': 'xxx', '@_isPermaLink': 'false' }`，
   * `String(raw.guid)` 会得到 `"[object Object]"` —— 每一条都一样。
   */
  guid?: unknown
  title?: unknown
  link?: unknown
  pubDate?: unknown
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

/** 解析任意一份蜜柑 RSS（官方订阅 feed 与搜索 feed 结构完全一致） */
export function parseFeed(xml: string): FeedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const doc = parser.parse(String(xml ?? '')) as {
    rss?: { channel?: { item?: RssRawItem[] | RssRawItem } }
  }
  const rawItems = doc?.rss?.channel?.item ?? []
  const list: RssRawItem[] = Array.isArray(rawItems) ? rawItems : [rawItems]
  const seen = new Set<string>()
  const items: FeedItem[] = []
  for (const raw of list) {
    const title = String(nodeText(raw.title))
    if (!title) continue
    const base = nodeText(raw.guid) || nodeText(raw.link) || title
    // guid 必须唯一：它既是列表行标识也是勾选键，重复就会出现「勾一条全勾上」
    let guid = base
    for (let n = 2; seen.has(guid); n++) guid = `${base}#${n}`
    seen.add(guid)
    items.push({
      guid,
      title,
      link: nodeText(raw.link),
      torrentUrl: raw.enclosure?.['@_url'] ? String(raw.enclosure['@_url']) : null,
      // 发布日期挂在 `<torrent><pubDate>` 上（顶层没有 pubDate）
      pubDate: nodeText(raw.pubDate) || nodeText(raw.torrent?.pubDate),
      group: parseGroup(title),
      episode: parseEpisode(title),
      resolution: parseResolution(title),
      size: humanSize(Number(raw.enclosure?.['@_length'] ?? 0))
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// ② 番剧标题 → bangumiId（搜索页 HTML）
// ---------------------------------------------------------------------------

export interface BangumiCard {
  id: number
  /** 搜索结果卡片上显示的番剧名（已实体解码） */
  title: string
}

/**
 * 从 `Home/Search?searchstr=…` 的 HTML 里取番剧卡片。
 *
 * 只认 `<a href="/Home/Bangumi/<数字>">` 这种锚点：实测该页面里 `an-text` 这个类
 * 在别处也出现（顶部「主页」链接等），但它不在 `Home/Bangumi` 锚点内，
 * 所以「按锚点取、再从锚点内部取 title」不会被顶栏蹭到。
 */
export function parseBangumiCards(html: string): BangumiCard[] {
  const out: BangumiCard[] = []
  const re = /<a\b[^>]*href="\/Home\/Bangumi\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(String(html ?? ''))) !== null) {
    const id = parseInt(m[1], 10)
    if (!Number.isFinite(id)) continue
    const title = decodeEntities((m[2].match(/title="([^"]*)"/) ?? [])[1] ?? '')
    out.push({ id, title: title.trim() })
  }
  return out
}

/** 订阅的「本名」归一化集合（与番剧卡片标题比较用） */
function identityKeys(sub: Subscription): string[] {
  return [sub.nameCn, sub.name, sub.mikanKeyword, baseSearchKeyword(sub.nameCn || ''), baseSearchKeyword(sub.name || '')]
    .map((x) => normKey(x || ''))
    .filter(Boolean)
}

/**
 * 从一批番剧卡片里挑出「就是这部番」的那一张。
 *
 * 判据按强度递减，命中即返回（因此不会出现「分数相同随便挑一个」的随机性）：
 *   ① 归一化后**完全相等** —— 订阅名就是蜜柑上的番剧名（最可靠，实测两条真实订阅都走这条）；
 *   ② 基名一致（`sameBase`，能容忍副标题/季数写法差异）；
 *   ③ 卡片名与订阅名的归一化形态**互相包含**（跨语言时通常只有一半能对上）。
 *
 * 一条都没命中就返回 null → 调用方回落到关键词搜索链路。
 * 为什么宁可返回 null：猜错一条 bangumiId 的代价是「整个订阅指向另一部番」，
 * 比「这次走回落链路（旧行为）」严重得多。
 */
export function pickBangumiCard(cards: BangumiCard[], sub: Subscription): BangumiCard | null {
  if (cards.length === 0) return null
  const keys = identityKeys(sub)
  const subBase = parseTitleSeason(sub.nameCn || sub.name || '').base
  const contains = (a: string, b: string): boolean =>
    a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))
  for (const c of cards) {
    const title = normKey(c.title)
    if (title && keys.includes(title)) return c
  }
  for (const c of cards) {
    const base = parseTitleSeason(c.title).base
    if (subBase && sameBase(subBase, base)) return c
  }
  for (const c of cards) {
    const title = normKey(c.title)
    if (title && keys.some((k) => contains(k, title))) return c
  }
  return null
}

// ---------------------------------------------------------------------------
// ③ 番剧页 HTML → 字幕组名 → subgroupId
// ---------------------------------------------------------------------------

export interface SubGroupEntry {
  id: number
  /** 番剧页上显示的字幕组名（已实体解码）。可能是空串（蜜柑里存在无名条目，如生肉） */
  name: string
}

/**
 * 从 `Home/Bangumi/<id>` 的 HTML 里取「字幕组名 → subgroupId」对照表。
 *
 * 页面结构（实测原样）：
 *   `<div class="subgroup-scroll-top-364"></div>`
 *   `<div class="subgroup-text" id="364">`
 *       `<a href="/Home/PublishGroup/217" …>云光字幕组</a>`
 *       `<a href="/RSS/Bangumi?bangumiId=4011&subgroupid=364" class="mikan-rss">…</a>`
 *       `<div id="subscription-popover-4011-364" …>`  ← 注意这里开始有嵌套 div
 *   `</div>`
 * 所以**不能**用「取到第一个 `</div>`」来截断（嵌套的 popover div 会让它提前结束，
 * 实测第一版就这么写的，结果一个组都取不到）—— 这里取到**下一个 `<div` 之前**为止。
 */
export function parseSubGroups(html: string): SubGroupEntry[] {
  const out: SubGroupEntry[] = []
  const src = String(html ?? '')
  const re = /<div class="subgroup-text" id="(\d+)">([\s\S]*?)(?=<div\b)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const id = parseInt(m[1], 10)
    if (!Number.isFinite(id)) continue
    const name = [...m[2].matchAll(/<a\b[^>]*href="\/Home\/PublishGroup\/\d+"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((a) => stripTags(a[1]))
      .filter(Boolean)
      .join(' & ')
    out.push({ id, name })
  }
  return out
}

/** 在字幕组对照表里找订阅选定的那个组（宽松包含匹配，见 sameSubGroupName） */
export function pickSubGroupEntry(entries: SubGroupEntry[], group: string | null | undefined): SubGroupEntry | null {
  if (!group) return null
  const exact = entries.find((e) => normGroup(e.name) === normGroup(group))
  if (exact) return exact
  return entries.find((e) => sameSubGroupName(e.name, group)) ?? null
}

// ---------------------------------------------------------------------------
// ④ 对外：解析 + 拉取
// ---------------------------------------------------------------------------

/**
 * 基础域名：与 mikan.ts 共用 net.ts 里那一份（蜜柑主站 mikanani.me 在国内不可直连）。
 * mikan.ts 在模块初始化时调用 setFeedBase 对齐，避免两处各写一份而漂移。
 * 注意：读的时候要**实时**取（见下面的 bangumiRssUrl），不能在模块初始化时抄成一个常量 ——
 * 否则那个拷贝会与 net.ts 里的live 值脱钩（探针里就用这一点单独打断官方订阅 RSS）。
 */
export { setFeedBase, getFeedBase }

const BANGUMI_RSS = (bangumiId: number, subgroupId?: number | null): string =>
  `${getFeedBase()}/RSS/Bangumi?bangumiId=${bangumiId}` + (subgroupId ? `&subgroupid=${subgroupId}` : '')

export function buildBangumiRssUrl(bangumiId: number, subgroupId?: number | null): string {
  return BANGUMI_RSS(bangumiId, subgroupId)
}

/**
 * 解析一个订阅的 bangumiId / subgroupId。
 *
 * 请求数（实测）：
 *   · 命中订阅记录里的缓存 → **0 个请求**（这是「第二次检测不再重新解析」的实现）；
 *   · 未缓存但只需要番剧页确认组（已有 bangumiId 缓存）→ 1 个请求；
 *   · 首次解析 → 2 个请求（搜索页 + 番剧页）；第一个搜索词搜不到卡片时多试下一个词，
 *     每个多试的词多 1 个请求（最多 3 个词）。
 *
 * 失败模式（都会返回 bangumiId=null，由调用方回落到关键词搜索链路）：
 *   · 搜索页没有 `Home/Bangumi` 卡片（蜜柑上还没有这部番 / 名字差异太大）→ 2 个请求都没发生；
 *   · 卡片有但一条都过不了 `pickBangumiCard` 的判据（怕串番，宁可回落）；
 *   · 番剧页取不到（网络抖动）→ 已拿到的 bangumiId 仍会返回，只是 subgroupId 为空；
 *   · 番剧页里没有该字幕组（**这是正常结果**：该组没做这部番）→ 返回 bangumiId + subgroupId=null，
 *     调用方据此直接判「0 条」，不再去搜关键词（避免又串回一堆无关资源）。
 */
export async function resolveSubFeed(sub: Subscription, trace: FeedTrace): Promise<ResolvedSubFeed> {
  const cachedBangumi = typeof sub.mikanBangumiId === 'number' ? sub.mikanBangumiId : null
  const cachedGroup = typeof sub.mikanSubgroupId === 'number' ? sub.mikanSubgroupId : null
  // 组名是缓存的键：订阅换字幕组时必须重新解析，否则会继续用旧组的 id
  const groupUnchanged = cachedBangumi != null && normGroup(sub.group) === normGroup(sub.cachedGroupName)

  if (cachedBangumi != null && (groupUnchanged || !sub.group)) {
    // 有 bangumiId 缓存，且（没指定字幕组 或 组名没变）→ 不重新请求任何页面
    if (!sub.group || cachedGroup != null) {
      return { bangumiId: cachedBangumi, subgroupId: cachedGroup, fromCache: true, reason: '' }
    }
    // 指定了组但没缓存组 id（上次只解析到番剧）→ 只补一次番剧页
    //
    // 为什么**不**把「该组没有这部番」这个否定结果也缓存下来（那样第二次就是 0 请求了）：
    // 字幕组随时可能开始做这部番，缓存否定结果会让它**永远**发现不了（蜜柑那边新增条目我们不知道）。
    // 代价是多打一次番剧页（实测约 1.2s）—— 只在「订阅了一个该番没有的组」这种少见情形下发生，
    // 且这条路径本来就会返回 0 条，多一个请求比「永远订阅不上」划算。
    try {
      const html = await requestText(`${getFeedBase()}/Home/Bangumi/${cachedBangumi}`, trace, `番剧页 ${cachedBangumi}`)
      const entries = parseSubGroups(html)
      const hit = pickSubGroupEntry(entries, sub.group)
      if (hit) return { bangumiId: cachedBangumi, subgroupId: hit.id, fromCache: true, reason: '' }
      return {
        bangumiId: cachedBangumi,
        subgroupId: null,
        fromCache: true,
        reason: `番剧页 ${cachedBangumi} 的 ${entries.length} 个字幕组里没有「${sub.group}」（该组没做这部番）`
      }
    } catch (err) {
      return { bangumiId: cachedBangumi, subgroupId: null, fromCache: true, reason: `番剧页取不到：${errText(err)}` }
    }
  }

  // ---- 首次解析：搜索页 → 番剧页 ----
  /*
   * 搜索词候选：订阅的 mikanKeyword + 中日文派生基名。
   *
   * 为什么不止一个词：mikanKeyword 是 Bangumi 上的完整番剧名（含「第三季」这类季数后缀、
   * 全角标点），而蜜柑的搜索页对标点敏感 —— 拿完整的名字搜**有时搜不到番剧卡片**，
   * 派生基名（去掉季数、NFKC 折叠标点）反而能搜到。这与回落链路里
   * mikan.ts 的 keywordCandidates 是同一个理由（那边也用多个词，注释更详细）。
   *
   * 成本控制：**逐个试、命中即停**，所以常见情况（第一个词就命中）仍然只有 2 个请求；
   * 只有第一个词搜不到卡片时才多花 1 个请求，最多 3 个词。
   */
  const keywords = [
    ...new Set(
      [
        sub.mikanKeyword,
        baseSearchKeyword(sub.nameCn || ''),
        baseSearchKeyword(sub.name || '')
      ]
        .map((k) => String(k ?? '').trim())
        .filter(Boolean)
    )
  ]
  if (keywords.length === 0) return { bangumiId: null, subgroupId: null, fromCache: false, reason: '订阅没有可用的番剧名' }

  let card: BangumiCard | null = null
  const tried: string[] = []
  let lastReason = ''
  let lastError = ''
  for (const keyword of keywords) {
    let cards: BangumiCard[]
    try {
      const html = await requestText(
        `${getFeedBase()}/Home/Search?searchstr=${encodeURIComponent(keyword)}`,
        trace,
        `搜索页「${keyword}」`
      )
      cards = parseBangumiCards(html)
    } catch (err) {
      lastError = `搜索页取不到：${errText(err)}`
      tried.push(`${keyword}(失败)`)
      continue
    }
    tried.push(`${keyword}=${cards.length}张卡片`)
    const picked = pickBangumiCard(cards, sub)
    if (picked) {
      card = picked
      break
    }
    lastReason =
      cards.length === 0
        ? `搜索页没有番剧卡片`
        : `搜索页 ${cards.length} 个卡片都对不上订阅名（${cards
            .slice(0, 3)
            .map((c) => `#${c.id}"${c.title}"`)
            .join('、')}）`
  }
  if (!card) {
    return {
      bangumiId: null,
      subgroupId: null,
      fromCache: false,
      reason: `${lastReason || lastError || '搜索页没有可用卡片'}；搜索词逐个试过：${tried.join(' / ')}`
    }
  }
  const bangumiId = card.id
  if (!sub.group) return { bangumiId, subgroupId: null, fromCache: false, reason: '' } // 没指定组：整部番的 feed
  try {
    const html = await requestText(`${getFeedBase()}/Home/Bangumi/${bangumiId}`, trace, `番剧页 ${bangumiId}`)
    const entries = parseSubGroups(html)
    const hit = pickSubGroupEntry(entries, sub.group)
    if (hit) return { bangumiId, subgroupId: hit.id, fromCache: false, reason: '' }
    return {
      bangumiId,
      subgroupId: null,
      fromCache: false,
      reason: `番剧页 ${bangumiId}（"${card.title}"）的 ${entries.length} 个字幕组里没有「${sub.group}」（该组没做这部番）`
    }
  } catch (err) {
    return { bangumiId, subgroupId: null, fromCache: false, reason: `番剧页取不到：${errText(err)}` }
  }
}

/**
 * 拉取官方订阅 feed。
 *
 * `subgroupId` 为空时退回「整部番」的 feed（蜜柑会把该番所有字幕组的条目一起给），
 * 这时调用方仍要自己按字幕组过滤（与旧行为一致，不会更宽松）。
 *
 * 注意「0 条」不是错误：实测 `bangumiId` / `subgroupid` 不存在时蜜柑返回 **HTTP 200 + 0 条**，
 * 所以这里只把**请求失败**当成错误。
 */
export async function fetchOfficialFeed(
  bangumiId: number,
  subgroupId: number | null | undefined,
  trace: FeedTrace
): Promise<{ items: FeedItem[]; error?: string }> {
  const url = BANGUMI_RSS(bangumiId, subgroupId)
  try {
    const xml = await requestText(url, trace, `订阅RSS bangumiId=${bangumiId}${subgroupId ? `&subgroupid=${subgroupId}` : ''}`)
    return { items: parseFeed(xml) }
  } catch (err) {
    return { items: [], error: errText(err) }
  }
}

// ---------------------------------------------------------------------------
// 内部：带计数的请求
// ---------------------------------------------------------------------------

async function requestText(url: string, trace: FeedTrace, what: string): Promise<string> {
  trace.requests++
  const t0 = Date.now()
  try {
    const text = await getText(url)
    trace.lines.push(`${what}=${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return text
  } catch (err) {
    trace.lines.push(`${what}=失败(${errText(err)})`)
    log.append('warn', 'mikan', `订阅入口解析失败「${what}」：${errText(err)}`)
    throw err
  }
}

function errText(err: unknown): string {
  const e = err as { message?: string }
  return e?.message ?? String(err)
}

import axios, { type AxiosRequestConfig } from 'axios'
import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { JSONPath } from 'jsonpath-plus'
import xhtml from 'xpath-html'
import type {
  LocalRuleEntry,
  LocalRuleReason,
  PlayRule,
  RuleEpisode,
  RuleEpisodeGroup,
  RuleEpisodesDef,
  RuleEpisodesResult,
  RuleOrigin,
  RulePlayResult,
  RuleSearchDef,
  RuleSearchEntry,
  RuleSearchResult,
  RulesRepoMeta
} from '@shared/types'
import { DEFAULT_RULES, emptyRule } from '@shared/types'
import {
  REMOVED_RULE_IDS,
  RETIRED_RULES,
  RULE_LIBRARY_REVISION,
  RULE_LIBRARY_SEEDS,
  RULE_NOTES,
  RULE_SPEED_MS
} from '@shared/builtinRules'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, chromiumGetText, getSettings } from '../net'
import { store } from '../store'
import { bahamutEpisodes, bahamutPlay, bahamutSearch } from './bahamut'
import { normalizeEpisodeGroups } from './episodeNormalize'
import { episodesViaWebview, searchViaWebview } from './ruleSearchWebview'

/**
 * 播放规则引擎（Kazumi 同款技术栈）
 * - XPath 规则：xpath-html（parse5 → xmlserializer → xmldom → xpath）
 * - API 规则：JSON + JSONPath（jsonpath-plus）
 * - 占位符：@keyword / @source / 响应变量 @slug 等 / @roadIndex / @episodeIndex
 */

function getRule(ruleId: string): PlayRule | null {
  const rules = store.get<PlayRule[]>('rules', [])
  const rule = rules.find((r) => r.id === ruleId) ?? null
  // 兜底：即使存储里仍是旧 XPath，取用时也套用站点改版修正
  return rule ? applyRuleFix(rule) : null
}

function fillTemplate(s: string, vars: Record<string, string>): string {
  return s.replace(/@(\w+)/g, (_, k: string) => vars[k] ?? `@${k}`)
}

function parseJsonObject(s: string): Record<string, unknown> {
  if (!s || !s.trim()) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * 相对条目的 XPath：把「以文档为根」的写法改成「以条目节点为根」。
 * - `//a/b`  → `.//a/b`
 * - `/self::*[@class='x']/following-sibling::a` → `./self::*[...]/following-sibling::a`
 *   （ezdmw 这类站点大量使用 `/self::*[...]` 链式写法；若原样求值会被当成绝对路径，
 *     结果恒为空 —— 表现为「搜到番剧但解析不到剧集」）
 * - 其它（含 `./`、`@`、`text()`）原样返回
 */
function itemXPath(p: string): string {
  const t = p.trim()
  if (!t) return t
  // 联合表达式（`A | B | C`）：每个分支都要独立处理，否则只有第一个分支会被转成
  // 相对路径，其余仍是绝对路径、相对条目求值时恒为空（ezdmw 的选集规则正是这种写法）
  if (t.includes('|')) return splitUnion(t).map((s) => itemXPath(s)).join(' | ')
  if (t.startsWith('//')) return `.${t}`
  if (t.startsWith('/') && !t.startsWith('./') && !t.startsWith('/..')) return `.${t}`
  return t
}

/** 按 `|` 拆分 XPath 联合表达式（忽略引号内的 `|`） */
function splitUnion(expr: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote = ''
  for (const ch of expr) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '|') {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts
}

/**
 * 把条目/剧集链接解析成绝对地址。
 *
 * v0.3.5：多一步「同站 http→https 升级」。
 * 起因是 AGE：它的搜索结果与详情页里的剧集链接都是 **HTTP 绝对地址**
 * （`http://www.agedm.io/play/20260029/1/1`），而站点本身只提供 https 服务 ——
 * 实测 `http://www.agedm.io/...:80` 直连是 **ETIMEDOUT**（不是 301），
 * 浏览器之所以没事是因为 Chrome 会自己升级 https 并缓存跳转。
 * 结果就是「搜索能搜到、名字也有了，但一点播放/选集就超时」。
 *
 * 升级条件卡得很死：**只有**「link 是 http、base 是 https、且 host 相同」才换协议，
 * 不会把站点故意提供的另一个 http 域名（有些站的真源就在 http 上）改坏。
 */
export function resolveUrl(base: string, link: string): string {
  try {
    const u = new URL(link, base)
    try {
      const b = new URL(base)
      if (u.protocol === 'http:' && b.protocol === 'https:' && u.host === b.host) {
        u.protocol = 'https:'
      }
    } catch {
      /* base 不是合法 URL 就只做普通解析 */
    }
    return u.toString()
  } catch {
    return link
  }
}

/** jsonpath-plus 包装 */
function jpath<T = unknown>(path: string, json: unknown): T {
  return JSONPath({ path, json: json as object, wrap: false }) as T
}

// ---------------- XPath（xpath-html 栈：parse5 → xmlserializer → xmldom → xpath） ----------------

interface XDocWrapper {
  document: unknown
  findElements(expression: string): HNode[]
  findElement(expression: string): HNode | undefined
  select(expression: string, node?: unknown, single?: boolean): unknown[] | unknown
}

// xmldom 节点结构
interface HNode {
  nodeType?: number
  nodeName?: string
  tagName?: string
  nodeValue?: string
  childNodes?: HNode[]
  getAttribute?: (name: string) => string | null
}

const toDocCache = new WeakMap<object, XDocWrapper>()

/**
 * HTML → 可查 XPath 的文档对象。
 *
 * V1.3.8：**整页解析出空树时，退到 `<body` 之后重新解析**。
 *
 * 真机证据（Tucao 的搜索页，32KB、含 `class="list"`、5 个 `/play/` 链接）：
 *   · `xpath-html.fromPageSource(整页)` → `//div` 都是 **0**，等于整棵树是空的；
 *   · 把 `<head>` 之前的部分切掉、从 `<body` 开始解析 → `//div` 有 54 个，`//a[@class="t"]` 命中 2 个。
 * 也就是说这个站的头部（XHTML DOCTYPE + 一堆内联脚本）会让解析器产出空树，
 * 表现为「搜索 0 条」，而数据其实就在 HTML 里。这里是通用兜底：只在**整页解析出 0 个元素**时才重试，
 * 正常站点完全不受影响。
 */
function toDoc(text: string): XDocWrapper {
  const first = xhtml.fromPageSource(text) as unknown as XDocWrapper & {
    findElements: (expr: string) => unknown[]
  }
  try {
    if (first.findElements('//*').length > 0) return first
  } catch {
    /* 查询失败也走兜底 */
  }
  const bodyAt = text.search(/<body[\s>]/i)
  if (bodyAt <= 0) return first
  try {
    const second = xhtml.fromPageSource(text.slice(bodyAt)) as unknown as XDocWrapper
    return second
  } catch {
    return first
  }
}

/** 给 XPath 的每个标签名加 x: 命名空间前缀（与 xpath-html 内部一致；跳过 @ 属性与已带前缀的节点） */
function enhance(expr: string): string {
  return (
    expr
      .replace(/(^|[/.|])([a-zA-Z][a-zA-Z0-9_-]*)(?=\s*\[|$|\/)/g, (m, p1: string, p2: string) =>
        p2 === 'x' ? m : `${p1}x:${p2}`
      )
      // 轴步里的标签名也要加前缀：`following-sibling::a` 若保持无命名空间，
      // 而文档元素都在 x: 命名空间下 → 求值恒为空（ezdmw 选集规则依赖这一点）
      .replace(/(::)([a-zA-Z][a-zA-Z0-9_-]*)/g, (_m, p1: string, p2: string) =>
        p2 === 'x' ? `${p1}${p2}` : `${p1}x:${p2}`
      )
  )
}

function evalNodes(doc: XDocWrapper, xpathStr: string, ctx?: HNode): HNode[] {
  if (!xpathStr || !xpathStr.trim() || xpathStr.trim() === '//') return []
  try {
    if (!ctx) {
      // 全文档：用 findElements（内部已处理命名空间）
      return doc.findElements(xpathStr)
    }
    // 相对条目：手动加命名空间后以条目为上下文求值
    const raw = doc.select(enhance(xpathStr), ctx, false)
    return Array.isArray(raw) ? (raw as HNode[]) : raw ? [raw as HNode] : []
  } catch (err) {
    log.append('warn', 'rules', `XPath 求值失败 (${xpathStr}): ${String(err)}`)
    return []
  }
}

function nodeText(node: HNode | null | undefined): string {
  let out = ''
  const walk = (n: HNode | null | undefined): void => {
    if (!n) return
    if (n.nodeType === 3) {
      out += n.nodeValue ?? ''
      return
    }
    // xmldom 的 childNodes 是 NodeList，不是数组
    const kids = n.childNodes as HNode[] | null | undefined
    if (kids && typeof kids.length === 'number') {
      for (let i = 0; i < kids.length; i++) walk(kids[i])
    }
  }
  walk(node)
  return out.replace(/\s+/g, ' ').trim()
}

function nodeAttr(node: HNode | null | undefined, name: string): string {
  return node?.getAttribute?.(name) ?? ''
}

function evalText(doc: XDocWrapper, xpathStr: string, ctx?: HNode): string {
  const nodes = evalNodes(doc, xpathStr, ctx)
  return nodes.length ? nodeText(nodes[0]) : ''
}

function evalHref(doc: XDocWrapper, xpathStr: string, ctx?: HNode): string {
  const nodes = evalNodes(doc, xpathStr, ctx)
  if (!nodes.length) return ''
  const el = nodes[0]
  const href = nodeAttr(el, 'href')
  if (href) return href
  const kids = el.childNodes as HNode[] | null | undefined
  if (kids && typeof kids.length === 'number') {
    for (let i = 0; i < kids.length; i++) {
      const a = kids[i]
      if (a && a.nodeType === 1 && a.nodeName === 'a') {
        const h = nodeAttr(a, 'href')
        if (h) return h
      }
    }
  }
  return ''
}

/** 直接子节点中找指定标签 */
function findDirectChild(node: HNode | null | undefined, tag: string): HNode | null {
  const kids = node?.childNodes as HNode[] | null | undefined
  if (kids && typeof kids.length === 'number') {
    for (let i = 0; i < kids.length; i++) {
      if (kids[i]?.nodeType === 1 && kids[i].nodeName === tag) return kids[i]
    }
  }
  return null
}

/** 提取条目名称：文本 → title → alt → img 子元素的 alt → 条目自身文本 */
function extractName(doc: XDocWrapper, xpathStr: string, node: HNode): string {
  const el = evalNodes(doc, xpathStr, node)[0] ?? node
  let name = nodeText(el)
  if (!name) name = nodeAttr(el, 'title')
  if (!name) name = nodeAttr(el, 'alt')
  if (!name) {
    const img = el.nodeName === 'img' ? el : findDirectChild(el, 'img')
    name = nodeAttr(img, 'alt')
  }
  if (!name) name = nodeText(node).slice(0, 40)
  return name
}

// ---------------- HTTP ----------------

/**
 * AGE 这类站点的 301 会指回 **http://**（同域），而站点只开 https。
 *
 * 现象（v1.1 实测）：`https://www.agedm.io/search?...` 大约每三四次里有两次返回 301 →
 * `http://www.agedm.io/...`，node 直连 :80 是 **ETIMEDOUT**（浏览器没事，因为 Chrome
 * 自己会把同域 http 升级成 https 并缓存跳转）。
 * 以前搜索/选集全靠 axios 直连，于是表现为「AGE 时好时坏」。
 * 这里在 axios 的跳转钩子上做**范围极窄**的升级：只有「原地址 https + 目标同 host + http」
 * 才换成 https；指向别的 http 域名的跳转一律原样跟随（有些站的真源确实在 http 上）。
 */
function upgradeRedirectProtocol(
  options: { protocol?: string; hostname?: string; port?: number | string; href?: string },
  original: { protocol: string; host: string }
): void {
  if (original.protocol !== 'https:') return
  const proto = String(options.protocol ?? '')
  if (proto !== 'http:') return
  const host = String(options.hostname ?? '')
  if (!host || !sameSite(host, original.host)) return
  options.protocol = 'https:'
  options.port = 443
  // node 的 http 客户端会用 href 覆盖其它字段，所以这里必须一起改
  if (typeof options.href === 'string') {
    options.href = options.href.replace(/^http:\/\//i, 'https://')
  }
}

/**
 * 同站判定：忽略开头的 `www.`。
 *
 * 为什么不能只比全等：AGE 的 301 目标就是 **`agedm.io`**（不带 www），
 * 而原地址是 `www.agedm.io` —— 全等比较会让升级失效，请求照样打到 http:80 然后超时。
 */
function sameSite(a: string, b: string): boolean {
  const norm = (h: string): string => h.toLowerCase().replace(/^www\./, '')
  return norm(a) === norm(b)
}

/**
 * 统一的「跟随跳转时升级 http→https」钩子（见 upgradeRedirectProtocol 的说明）。
 * 抽出来是因为搜索、选集、预嗅探三处都走 axios，口径必须一致。
 */
function beforeRedirectFor(url: string): (options: Record<string, unknown>) => void {
  let original = { protocol: 'https:', host: '' }
  try {
    const u = new URL(url)
    original = { protocol: u.protocol, host: u.hostname }
  } catch {
    /* URL 不合法就不做升级 */
  }
  return (options: Record<string, unknown>) => {
    upgradeRedirectProtocol(
      options as { protocol?: string; hostname?: string; port?: number | string; href?: string },
      original
    )
  }
}

/**
 * 上面那个跳转钩子的对外别名。
 * 播放页直出解析（ruleProbe）也要同一套「同站 http→https」口径，
 * 但它是另一个模块，直接 import 这个别名即可（避免两处各写一份、口径漂移）。
 */
export const sameSiteRedirectUpgrade = beforeRedirectFor

/**
 * 把「同站的 http 绝对地址」升级成 https（v1.7）。
 *
 * 和 resolveUrl 的区别：这个只做协议升级、**不改解析基准**，给「已经拿到绝对地址、
 * 但那条地址可能是 http」的调用点用（播放页直出解析、候选探测）。
 * AGE 的搜索页里给出的详情/播放链接本身就是 `http://www.agedm.io/...`，
 * 而它的 :80 是**黑洞**（实测直连 ETIMEDOUT，21 秒都不回），60 秒超时就是这么来的；
 * 所以只要「原地址是同站 https」，就一定要在发请求前把协议换掉，而不是等 301 再补救
 * （301 也可能指向 http，见 upgradeRedirectProtocol）。
 */
export function upgradeSameSite(url: string, base?: string): string {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:') return url
    let b: URL | null = null
    try {
      b = new URL(base || url)
    } catch {
      b = null
    }
    if (!b || b.protocol !== 'https:') return url
    if (!sameSite(u.hostname, b.hostname)) return url
    u.protocol = 'https:'
    if (u.port === '80') u.port = ''
    return u.toString()
  } catch {
    return url
  }
}

/**
 * 哪些错误值得「换一条连接重发」（v1.7）。
 *
 * 只认**连接级**故障：TCP 被重置/被掐、连接超时、DNS 临时失败。
 * 4xx/5xx、验证页、解析失败一律不算 —— 那些重发也没用，只会把站点的限流打得更狠
 * （AGE 这类站点的速率限制本来就紧，多余请求会让它把整台机器拉黑更久）。
 */
export function isTransientNetError(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  const code = String(e?.code ?? '')
  const msg = String(e?.message ?? '')
  if (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH'
  ) {
    return true
  }
  return /socket hang up|timeout of \d+ms exceeded|aborted|network error|connection (?:reset|aborted|closed)/i.test(
    msg
  )
}

/** 重试用的「一次性连接」：不复用 keep-alive 池（被掐掉的死 socket 还在池里，复用等于白重试） */
const freshHttpsAgent = new https.Agent({ keepAlive: false })
const freshHttpAgent = new http.Agent({ keepAlive: false })

/**
 * 「换一条新连接」的 axios 片段（重试用，也给播放页直出解析复用）。
 *
 * 走代理时连接由代理持有，换不换 agent 由代理决定，这里保持与原请求一致。
 */
export function freshConnectionAgents(): Partial<AxiosRequestConfig> {
  const proxy = getSettings().proxy
  if (proxy?.enabled && proxy.host) return buildProxyAgents(proxy)
  return { httpAgent: freshHttpAgent, httpsAgent: freshHttpsAgent }
}

/**
 * 像浏览器一样的请求头（v1.7）。
 *
 * 为什么需要：规则引擎过去的请求头只有 `User-Agent`，没有 `Referer` / `Accept` / `Accept-Language`。
 * 真实浏览器访问一个站点的每个子页面都会带这三样，而 AGE 这类带 WAF 的站点对
 * 「裸请求」明显更严（实测同一时刻带/不带 Referer 的被重置概率不同）。
 * 这里只补**站点自己的 origin** 作 Referer —— 不外泄任何其它地址，也不会把规则里
 * 显式写死的 headers 覆盖掉（调用方后写的优先）。
 */
export function browserLikeHeaders(url: string): Record<string, string> {
  let origin = ''
  try {
    origin = new URL(url).origin + '/'
  } catch {
    origin = ''
  }
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...(origin ? { Referer: origin } : {})
  }
}

/** 重试间隔（第 n 次重发前等多久）：第一次很快就试，第二次给站点一点喘息 */
const RETRY_DELAYS_MS = [350, 900]
/** 重试总预算：超过就认失败。与「单请求 30s + 三次」相称，又不至于让一次搜索挂两分钟 */
const RETRY_BUDGET_MS = 40_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 对连接级故障重发（语义见文件上方 isTransientNetError / 常量处的说明）。
 *
 * `send(fresh)` 的入参表示「这次要不要换新连接」：第一次 false（沿用应用统一的
 * keep-alive/代理配置），重试一律 true。
 * 日志只记站点名与错误类型，**不记 URL**（内部接口地址不进日志是红线）。
 */
/**
 * 日志里只写"主机 + 路径"（不写 query）：红线是**不要在日志/界面里出现内部接口地址**，
 * 而规则站点的 url 带 keyword 之类的查询串也没必要留。
 */
function shortUrlForLog(u: string): string {
  try {
    const p = new URL(u)
    return `${p.host}${p.pathname}`.slice(0, 120)
  } catch {
    return '(无法解析的地址)'
  }
}

export async function withNetRetry<T>(
  label: string,
  send: (fresh: boolean) => Promise<T>
): Promise<T> {
  const started = Date.now()
  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await send(attempt > 0)
    } catch (err) {
      lastErr = err
      const left = RETRY_BUDGET_MS - (Date.now() - started)
      const wait = RETRY_DELAYS_MS[attempt]
      if (!isTransientNetError(err) || wait === undefined || left < wait + 1_000) break
      const short = String((err as { message?: string })?.message ?? err).slice(0, 60)
      log.append(
        'warn',
        'rules',
        `${label} 连接被重置/超时（${short}），${wait}ms 后换新连接重发（第 ${attempt + 1} 次重试）`
      )
      await sleep(wait)
    }
  }
  throw lastErr
}

/*
 * ───────── 站点冷却（v1.7）─────────
 *
 * 真机 + 实测：AGE 被短时间连打之后会**直接掐连接**（ECONNRESET，0.7~1 秒就失败），
 * 而且这个状态是「打一次续一次」——实测冷却期里每 45 秒打一次，要 2~3 分钟才恢复；
 * 一旦继续连发（批量预嗅探、网页视图兜底、用户连点），整段就一直是失败（实测 27/30）。
 *
 * 所以这里做一个**很窄**的熔断：同一主机连续 2 次连接级失败 → 该主机静默 20 秒，
 * 期间不再发请求，而是立刻返回一句可读的错误。它换不回"站点没被限流"，
 * 但能保证：① 不再给它加码（加压只会延长冷却）；② 用户看到的是「稍后再试」而不是
 * 「这条规则里没有这部番剧」；③ 其它站点完全不受影响（按主机隔离）。
 */
const hostStrikes = new Map<string, { strikes: number; until: number }>()
const COOL_DOWN_MS = 20_000
const COOL_DOWN_STRIKES = 2

/** 冷却中的错误码：调用方据此区分「站点限流」与「真的没结果」 */
export const COOL_DOWN_CODE = 'SAKANA_SITE_COOL_DOWN'

function hostKey(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 冷却中就直接失败（不产生任何网络请求） */
function assertNotCoolingDown(url: string): void {
  const host = hostKey(url)
  if (!host) return
  const st = hostStrikes.get(host)
  if (!st || st.until <= Date.now()) return
  const left = Math.ceil((st.until - Date.now()) / 1000)
  const err = new Error(`站点连接被连续重置（疑似限流），已暂停对该站点的请求 ${left} 秒后再试`)
  ;(err as { code?: string }).code = COOL_DOWN_CODE
  throw err
}

/** 记录一次请求结果：连续失败达阈值就对该主机开冷却；成功则清零 */
function noteNetResult(url: string, ok: boolean): void {
  const host = hostKey(url)
  if (!host) return
  if (ok) {
    hostStrikes.delete(host)
    return
  }
  const st = hostStrikes.get(host) ?? { strikes: 0, until: 0 }
  st.strikes += 1
  if (st.strikes >= COOL_DOWN_STRIKES && st.until <= Date.now()) {
    st.until = Date.now() + COOL_DOWN_MS
    st.strikes = 0
    log.append(
      'warn',
      'rules',
      `站点连续 ${COOL_DOWN_STRIKES} 次连接被重置，暂停请求 ${COOL_DOWN_MS / 1000} 秒（避免把站点限流打成更长的封禁）`
    )
  }
  hostStrikes.set(host, st)
}

/**
 * 规则页面的**短缓存**（v1.7，只缓存 GET）。
 *
 * 为什么需要：同一次「点开一部番」会**重复抓同一张页面**——
 *   ① 批量预嗅探（ruleProbeBatch）对每条规则各跑一遍 搜索→详情→播放页；
 *   ② 用户自己点进播放页时，规则引擎又跑一遍同样的搜索与详情；
 *   ③ 选集失败重试 / 用户重开一次，再来一遍。
 * 对 AGE 这种**按请求速率掐连接**的站点，重复抓同一张页面是纯粹的加压：
 * 实测几秒内连打 3~4 次就会开始 ECONNRESET，而整轮播放因此失败。
 * 缓存 20 秒足够覆盖"预嗅探 + 用户点击"这段重叠窗口，又短到不会把
 * 站点刚改版这种变化藏起来（选集列表在 20 秒内不可能变）。
 */
const HTML_CACHE_TTL_MS = 20_000
const HTML_CACHE_MAX = 40
const htmlCache = new Map<string, { at: number; text: string }>()

function cacheKey(url: string, method: string): string {
  return `${method} ${url}`
}

function readHtmlCache(key: string): string | null {
  const hit = htmlCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > HTML_CACHE_TTL_MS) {
    htmlCache.delete(key)
    return null
  }
  return hit.text
}

function writeHtmlCache(key: string, text: string): void {
  htmlCache.delete(key)
  htmlCache.set(key, { at: Date.now(), text })
  while (htmlCache.size > HTML_CACHE_MAX) {
    const oldest = htmlCache.keys().next().value as string | undefined
    if (!oldest) break
    htmlCache.delete(oldest)
  }
}

/** 清掉规则页面缓存（测试/改规则后重跑用） */
export function clearRuleHtmlCache(): void {
  htmlCache.clear()
}

async function httpRequest(
  url: string,
  method: 'GET' | 'POST',
  headersJson: string,
  queryJson: string,
  bodyType: string
): Promise<string> {
  const headers = {
    ...browserLikeHeaders(url),
    ...(parseJsonObject(headersJson) as Record<string, string>)
  }
  const query = parseJsonObject(queryJson)
  const send = async (fresh: boolean): Promise<string> => {
    assertNotCoolingDown(url)
    try {
      const text = await sendOnce(url, method, headers, query, bodyType, fresh)
      noteNetResult(url, true)
      return text
    } catch (err) {
      // 冷却错误本身不算「一次失败」，否则会自己延长自己的冷却
      if ((err as { code?: string })?.code !== COOL_DOWN_CODE) noteNetResult(url, false)
      throw err
    }
  }
  /*
   * 只对「无查询参数拼装」的 GET 做缓存：POST/带 query 的请求语义上更接近"查询"，
   * 缓存它们容易在改关键词后拿到上一条结果。
   */
  const key = Object.keys(query).length === 0 && method === 'GET' ? cacheKey(url, method) : ''
  if (key) {
    const hit = readHtmlCache(key)
    if (hit !== null) return hit
  }
  /*
   * 为什么在 httpRequest 这一层重试而不是在 ruleSearch/ruleEpisodes 里：
   * 规则站点的每一次抓取（搜索页、详情页、API）都是同一条网络路径，
   * 口径放在最底层，所有规则、所有步骤自动一致，不会漏掉某一处。
   */
  /*
   * V1.3.6：node 这条路彻底失败时，**换 Chromium 网络栈再取一次**。
   *
   * 真机证据：Tucao 的搜索页在应用里 20 秒超时，而它的 HTML 我用 curl 是能拿到的
   * （浏览器头 + Referer）——说明不是页面不存在，而是 node 的请求在这类老站/反爬前面
   * 更容易被拖死或直接不给响应。同样的兜底我们已经在 bangumi 上验证过（把 8 秒超时的
   * `/calendar` 救回来过），这里把它复用到规则页面上：**只在 node 失败后才走**，
   * 正常路径的耗时不受影响。
   */
  let text: string
  try {
    text = await withNetRetry(`规则站点请求`, send)
  } catch (err) {
    const short = String((err as { message?: string })?.message ?? err).slice(0, 60)
    try {
      const viaChromium = await chromiumGetText(url, 20_000, headers)
      if (viaChromium && viaChromium.length > 0) {
        log.append('info', 'rules', `node 取页失败（${short}），改用 Chromium 网络栈成功：${shortUrlForLog(url)}`)
        noteNetResult(url, true)
        if (key) writeHtmlCache(key, viaChromium)
        return viaChromium
      }
    } catch (err2) {
      log.append(
        'warn',
        'rules',
        `node 与 Chromium 都没取到页面（${short} / ${String((err2 as { message?: string })?.message ?? err2).slice(0, 50)}）：${shortUrlForLog(url)}`
      )
    }
    throw err
  }
  if (key) writeHtmlCache(key, text)
  return text
}

/** 真正发一次请求（拆出来只为了让上面那层能统一记成功/失败） */
async function sendOnce(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  query: Record<string, unknown>,
  bodyType: string,
  fresh: boolean
): Promise<string> {
  const common = {
    timeout: 30000,
    responseType: 'text' as const,
    headers: { 'User-Agent': BROWSER_UA, ...headers },
    // AGE 偶发的 301→http:80 会 ETIMEDOUT（见 upgradeRedirectProtocol）
    beforeRedirect: beforeRedirectFor(url),
    ...(fresh ? freshConnectionAgents() : buildProxyAgents(getSettings().proxy))
  }
  if (method === 'POST') {
    if (bodyType === 'json') {
      const res = await axios.post(url, query, {
        ...common,
        headers: { ...common.headers, 'Content-Type': 'application/json' }
      })
      return String(res.data ?? '')
    }
    if (bodyType === 'form') {
      const form = new URLSearchParams(
        Object.entries(query).map(([k, v]) => [k, String(v)])
      ).toString()
      const res = await axios.post(url, form, {
        ...common,
        headers: { ...common.headers, 'Content-Type': 'application/x-www-form-urlencoded' }
      })
      return String(res.data ?? '')
    }
    const res = await axios.post(url, query, common)
    return String(res.data ?? '')
  }
  // GET：query 参数拼到 URL
  let finalUrl = url
  if (Object.keys(query).length) {
    const u = new URL(url)
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v))
    finalUrl = u.toString()
  }
  /*
   * V1.3.7：**空闲收尾**，但**只对白名单主机生效**。
   *
   * 真机实测：Tucao 的搜索页首字节 2.2~10.5 秒就到了、正文 32KB 也齐了，
   * 但 `curl -w` 的 `total` 永远等于超时上限 —— 服务器把连接挂着**不结束响应**
   * （keep-alive 且不带 Content-Length）。我们按"响应结束"判定，于是一直等到超时。
   *
   * ⚠️ 第一版做成了全局 GET 生效，结果日志里刷出一堆
   *   `流式接收失败，退回整响应模式：Request failed with status code 404 / read ECONNRESET / socket hang up`
   * 那些是**请求本身失败**（对方 404 / 掐连接），流式根本轮不到生效，还污染了其它规则的日志。
   * 所以现在收窄成按主机白名单：只有明确知道"响应不结束"的站点才走这条路，其它规则行为完全不变。
   */
  let idleCutoff = false
  try {
    idleCutoff = IDLE_CUTOFF_HOSTS.has(new URL(finalUrl).hostname.toLowerCase())
  } catch {
    idleCutoff = false
  }
  if (idleCutoff) {
    try {
      /*
       * ⚠️ 必须显式 `Accept-Encoding: identity`。
       *
       * axios 只在 responseType 为 text/json 时自动解压；**stream 模式不会**。
       * 默认请求头带 `Accept-Encoding: gzip`，服务器就回 gzip，于是我们拿到的是**压缩后的字节流**，
       * 转成字符串就是乱码，XPath 一条也匹配不到 —— 表现为"HTTP 成功但 0 条"，
       * 然后退回网页视图兜底（那一步要 100 多秒），用户看到的就是"搜不到"。
       * 这是本流程里唯一一处"拿到数据却解析不出"的坑，写在这里免得以后再踩。
       */
      return await getWithIdleCutoff(finalUrl, {
        ...common,
        responseType: 'stream',
        headers: { ...common.headers, 'Accept-Encoding': 'identity' }
      })
    } catch (err) {
      log.append('warn', 'rules', `流式接收失败，退回整响应模式：${String((err as Error)?.message ?? err).slice(0, 60)}`)
    }
  }
  const res = await axios.get(finalUrl, common)
  return String(res.data ?? '')
}

/**
 * 「响应不结束」的站点白名单（V1.3.7）。
 * 只有实测确认过"正文到齐但连接不收尾"的站才放进来，避免全局改变所有规则的请求行为。
 */
const IDLE_CUTOFF_HOSTS = new Set(['www.tucao.my', 'tucao.my'])

/** 首字节后多久没有新数据就认为响应完整（毫秒）。见 sendOnce 里的说明。 */
const STREAM_IDLE_MS = 3000
/** 流式接收的硬上限：再慢也不能让一次搜索挂满整轮（毫秒） */
const STREAM_HARD_MS = 25_000

/**
 * 流式 GET：**内容完整就收尾**，不依赖连接关闭。
 *
 * 这是为了 Tucao 这类"body 到齐但连接不结束"的老站。两个判定条件一起用：
 *   ① 已收到 `</html>`（整页 HTML 齐了）→ 再等 STREAM_IDLE_MS 无新数据就返回；
 *   ② 没等到 `</html>` 就只能靠空闲判定 —— 所以空闲窗口取 **3 秒**（1.5 秒太激进：
 *      服务端两次 flush 之间常有 2 秒空档，过早收尾会把结果区截掉，表现为"搜索 0 条"）。
 *
 * 真机教训：最初写 1.5 秒空闲，结果 HTTP 这条路"成功但 0 条"，
 * 于是又退到网页视图兜底，整个搜索花了 **155 秒**才出 1 条 —— 用户感知就是"搜不到"。
 */
async function getWithIdleCutoff(
  url: string,
  config: Record<string, unknown>
): Promise<string> {
  const res = await axios.get(url, config as never)
  const stream = res.data as NodeJS.ReadableStream & { destroy?: () => void }
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let idle: NodeJS.Timeout | null = null
    let done = false
    const finish = (err?: Error): void => {
      if (done) return
      done = true
      if (idle) clearTimeout(idle)
      clearTimeout(hard)
      try {
        stream.destroy?.()
      } catch {
        /* ignore */
      }
      if (err) reject(err)
      else resolve(Buffer.concat(chunks).toString('utf-8'))
    }
    const hard = setTimeout(() => finish(new Error(`流式接收超过 ${STREAM_HARD_MS / 1000}s`)), STREAM_HARD_MS)
    const bumpIdle = (): void => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => finish(), STREAM_IDLE_MS)
    }
    stream.on('data', (c: Buffer) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      bumpIdle()
    })
    stream.on('end', () => finish())
    stream.on('error', (e: Error) => finish(e))
  })
}

// ---------------- 搜索 ----------------

/**
 * 规则的搜索地址（人机验证窗口直接打开它，v0.3.7）。
 *
 * 为什么让用户验证时不是打开站点首页、而是打开**这条规则的搜索地址**：
 * 用户过完验证就地看到《番剧名》的搜索结果，验证完直接就能点进去 ——
 * 打开首页的话用户还要自己在站点里搜一次，多一步且容易搜错。
 */
export function ruleSearchUrl(ruleId: string, keyword: string): string | null {
  const rule = getRule(ruleId)
  if (!rule) return null
  /*
   * 库驱动规则（巴哈姆特）没有"搜索结果页"这种东西：它的 search.url 是 JSON 接口，
   * 把接口地址塞给验证窗口只会给用户看一坨 JSON。给它站点首页即可。
   */
  if (rule.engine === 'bahamut') return rule.baseUrl
  try {
    return fillTemplate(rule.search.url, { keyword })
  } catch {
    return null
  }
}

/** 规则名（界面提示用；找不到返回空串） */
export function ruleName(ruleId: string): string {
  return getRule(ruleId)?.name ?? ''
}

/**
 * 这页是不是「验证墙」而不是搜索结果（v0.3.7）。
 *
 * 为什么必须按**内容**判断：实测 dalvdm（`sbdl.cc`）、mutefun（`2kdm.com`）、LMM（`lmm85.com`）
 * 以及樱之空（`skr.skrcc.cc:666`）都会把验证页以 **HTTP 200** 返回 ——
 * axios 不抛错、XPath 解析出 0 条，于是过去只会得到一句「搜索无结果」，
 * 用户以为"这条线路没有这部番"，其实是站点要求先过人机验证。
 * 这几家的页面标题/正文里带着下面这些词，据此把它们和"真的没有这部番"区分开。
 */
export function looksLikeVerificationWall(text: string): boolean {
  if (!text) return false
  const head = text.slice(0, 4000)
  return /系统安全验证|身份验证|人机验证|安全验证|请完成验证|验证码|访问验证|Just a moment|Attention Required|cf-browser-verification|Checking your browser/i.test(
    head
  )
}

/** 验证墙的统一说法：界面据此显示「需人机验证」并给出验证入口 */
export const VERIFY_WALL_MESSAGE = '需要人机验证：站点要求先通过验证（在播放源列表里点这条线路即可弹窗验证）'

/**
 * 连接级失败（被站点掐连接 / 站点冷却中）的统一说法（v1.7）。
 *
 * 为什么必须和「没有这部番」「解析失败」区分开：
 * 这三种情况的用户动作完全不同 —— 前者是「等一会儿再点」，中间是「换别的线路」，
 * 而 AGE 的间歇性 RST 过去只会显示一句 `socket hang up`，
 * 用户既不知道是站点的问题，也不知道再点一次有没有用。
 */
export const NET_FAIL_MESSAGE = '与站点的连接被重置（站点限流/网络中断），稍等再试一次'


export async function ruleSearch(
  ruleId: string,
  keyword: string,
  /**
   * 可选：番剧条目 id（v1.1）。
   *
   * 为什么搜索需要它：巴哈姆特只认繁体/日文名，而界面传下来的是**中文名**。
   * 我们的 bangumi 数据源里 `subject(id).name` 就是日文原名，所以库驱动规则
   * 需要拿到条目 id 才能换一个能搜到的词（见 services/bahamut.ts 的 bahamutSearchTerm）。
   * XPath/API 规则完全忽略这个参数，行为一行没变。
   */
  subjectId?: number
): Promise<RuleSearchResult> {
  const rule = getRule(ruleId)
  if (!rule) return { items: [], error: '规则不存在' }
  /*
   * ★ 库驱动分支（v1.1）★
   * 巴哈姆特不是 XPath 能描述的东西（见 shared/bahamutRule.ts），
   * 所以在这里**提前返回**，下面那套 XPath/JSONPath 引擎一行都不碰。
   */
  if (rule.engine === 'bahamut') {
    const r = await bahamutSearch(keyword, subjectId)
    return { items: r.items, error: r.error }
  }
  const def = rule.search
  try {
    const url = fillTemplate(def.url, { keyword })
    // 查询参数 / 请求头中的 @keyword 占位同样需要替换
    const query = fillTemplate(def.query, { keyword })
    const headers = fillTemplate(def.headers, { keyword })
    /*
     * V1.3.8：`useChromium` 的规则走真实浏览器会话取搜索页。
     *
     * Tucao 对"没有浏览器会话"的请求返回 15KB 残缺页（实测同一时刻 curl 带 UA/Referer
     * 能拿到 32KB 结果页，应用里却经常拿到残缺页）。Chromium 会话会保存 Cookie，
     * 路径与用户手动打开浏览器一致。失败仍退回 httpRequest，不会让搜索彻底不可用。
     */
    let text: string
    if (def.useChromium) {
      try {
        text = await chromiumGetText(url, 25_000, {
          'User-Agent': BROWSER_UA,
          Referer: rule.baseUrl ?? '',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        })
        log.append('info', 'rules', `搜索页走 Chromium 会话（${rule.name}）：${shortUrlForLog(url)} → ${text.length} 字节`)
      } catch (err) {
        log.append(
          'warn',
          'rules',
          `Chromium 会话取搜索页失败（${rule.name}），退回 HTTP：${String((err as Error)?.message ?? err).slice(0, 60)}`
        )
        text = await httpRequest(url, def.method, headers, query, def.bodyType)
      }
    } else {
      text = await httpRequest(url, def.method, headers, query, def.bodyType)
    }
    /*
     * V1.3.8：0 条时把"拿到的到底是什么"写进日志。
     *
     * 真机排查 Tucao 时最耗时的一步就是分不清「没拿到 HTML」「拿到了是乱码」「XPath 不匹配」——
     * 三者在界面上都表现为"搜索不到"。这里在三者之间给出一个可判读的证据：
     * 字节数 = 0 → 没拿到；含 `class="list"` = false → 拿到的不是结果页（拦截页/空壳）；
     * 都正常但条数 0 → XPath 不匹配。
     */
    const items: RuleSearchEntry[] = []
    if (def.type === 'xpath') {
      const doc = toDoc(text)
      const nodes = evalNodes(doc, def.listXPath)
      if (nodes.length === 0) {
        log.append(
          'warn',
          'rules',
          `搜索解析 0 条（${rule.name}）：HTML ${text.length} 字节，含 class="list"=${text.includes('class="list"')}，` +
            `/play/ 链接 ${(text.match(/\/play\/[a-z0-9]+\//g) || []).length} 个，listXPath=${def.listXPath}`
        )
      }
      for (const node of nodes) {
        const name = extractName(doc, itemXPath(def.itemNameXPath || def.itemLinkXPath), node)
        const link = evalHref(doc, itemXPath(def.itemLinkXPath), node)
        if (!link) continue
        items.push({ name, link, source: link })
      }
    } else {
      const json = JSON.parse(text)
      const raw = jpath<unknown[]>(def.listJsonPath, json)
      for (const item of Array.isArray(raw) ? raw : []) {
        const rel = (p: string): unknown =>
          p && p.trim() ? jpath(p, item) : undefined
        const name = String(rel(def.itemNameJsonPath) ?? (item as { name?: string })?.name ?? '')
        const source = String(rel(def.itemSourceJsonPath) ?? '')
        /*
         * api 型搜索的条目 link（v0.3.9）：
         * 有些站点的搜索补全接口只给 id、不给详情页地址（aafun 用的
         * /index.php/ajax/suggest 就是这样），而选集要读详情页 HTML。
         * 过去 link 恒为空串，选集侧只能拿 id 去拼 URL，拼出来是 `https://站点/3291` —— 必然失败。
         * 规则里给了 itemLinkTemplate 就用 @source 拼出真实详情页地址（如 /anime/@source.html）。
         */
        const link = def.itemLinkTemplate
          ? fillTemplate(def.itemLinkTemplate, { source, keyword })
          : ''
        items.push({ name, link, source })
      }
    }
    // 纯 HTTP 抓不到（结果由 JS 渲染的站点，或站点偶发返回"加载中/安全验证"拦截页）
    // → 先重试一次 HTTP，再用真实浏览器窗口在页面内搜索
    let sawWall = looksLikeVerificationWall(text)
    if (items.length === 0) {
      await new Promise((r) => setTimeout(r, 800))
      try {
        const retryText = await httpRequest(url, def.method, headers, query, def.bodyType)
        sawWall = sawWall || looksLikeVerificationWall(retryText)
        const doc2 = toDoc(retryText)
        for (const node of evalNodes(doc2, def.listXPath)) {
          const name = extractName(doc2, itemXPath(def.itemNameXPath || def.itemLinkXPath), node)
          const link = evalHref(doc2, itemXPath(def.itemLinkXPath), node)
          if (link) items.push({ name, link, source: link })
        }
        if (items.length > 0) {
          log.append('info', 'rules', `搜索重试命中 ${items.length} 条（${rule.name}）`)
          return { items }
        }
      } catch {
        /* 重试失败则继续走网页内搜索 */
      }
      const viaWebview = await searchViaWebview(rule, keyword)
      if (viaWebview.length > 0) return { items: viaWebview }
    }
    /*
     * 站点给的是验证页而不是搜索结果（HTTP 200 的"软"拦截）：
     * 这时必须如实说是**验证问题**，而不是让用户以为这条线路里没有这部番（v0.3.7）。
     * 界面据此显示「需人机验证」并给出"点这条线路去弹窗验证"的出口。
     */
    if (items.length === 0 && sawWall) {
      log.append('warn', 'rules', `搜索被站点的验证页挡住（${rule.name}），需要用户在人机验证窗口里过一次`)
      return { items: [], error: VERIFY_WALL_MESSAGE }
    }
    return { items }
  } catch (err) {
    const e = err as { message?: string; code?: string }
    const msg = `搜索失败 (${rule.name}): ${e?.message ?? String(err)}`
    log.append('warn', 'rules', msg)
    /*
     * ★ 连接级失败（连接被重置 / 站点冷却中）**不**开网页视图兜底（v1.7）★
     *
     * 为什么：网页内搜索会真的开一个浏览器窗口去加载同一个站点的同一个页面 ——
     * 对「站点正在掐连接」这种状态来说，这等于在冷却期里再补 1~3 次请求，
     * 实测只会把限流窗口拖得更长（每打一次续一次）。
     * 这类失败的正确处置是「停手 + 如实告诉用户稍后再试」，而不是换个方式继续打。
     * 真正的「内容级拦截」（403 / 验证页 / 纯 JS 渲染）仍然走下面的网页视图兜底。
     */
    if (
      e?.code === COOL_DOWN_CODE ||
      (isTransientNetError(err) && !/timeout|timed out|超时/i.test(String(e?.message ?? err)))
    ) {
      log.append('warn', 'rules', `连接级失败，跳过网页视图兜底（${rule.name}），避免加压延长站点限流`)
      return { items: [], error: `${NET_FAIL_MESSAGE}（${rule.name}）` }
    }
    /*
     * V1.3.6：**超时不再跳过网页视图兜底**。
     *
     * 真机证据：Tucao 的搜索在 axios 里 20 秒超时，日志写「搜索超时（20s 内站点没有响应）」，
     * 而它的搜索页我用浏览器能打开 —— 这类站把"非浏览器请求"拖着不回，而不是掐连接。
     * 上面的"跳过兜底"是为了不给**正在限流的站点**加压（连接被重置那种），
     * 而"超时"恰恰是最该换真实浏览器再试一次的情形：真实窗口有 Cookie/JS，页面正常渲染。
     */
    /*
     * ★ 纯 HTTP 被站点挡下（403 / 人机验证页）时，仍然用真实浏览器窗口再试一次（v0.3.7）★
     *
     * 实测：樱之空（`skr.skrcc.cc:666`）的搜索接口现在直接返回 403，页面正文是「人机验证」——
     * axios 抛错后旧代码立刻把这次搜索判为失败返回，**根本没走到**网页内搜索那条路
     * （那条路只在「HTTP 成功但解析出 0 条」时才走）。
     *
     * 而网页内搜索用的是真实浏览器窗口：Cookie、JS、人机验证的后续跳转都会正常发生，
     * 用户在窗口里过一次验证之后，这条规则就又能用了 —— 这正是这条路存在的意义。
     */
    try {
      const viaWebview = await searchViaWebview(rule, keyword)
      if (viaWebview.length > 0) {
        log.append('info', 'rules', `HTTP 被拦后改用网页内搜索，命中 ${viaWebview.length} 条（${rule.name}）`)
        return { items: viaWebview }
      }
    } catch (err2) {
      log.append(
        'warn',
        'rules',
        `网页内搜索也失败（${rule.name}）: ${String((err2 as Error)?.message ?? err2).slice(0, 140)}`
      )
    }
    /*
     * 403 这类"硬"拦截同样归到"需要人机验证"上（v0.3.7）：
     * 只报「Request failed with status code 403」用户完全无从下手，
     * 而这两个问题的解法是同一个 —— 让用户在验证窗口里自己过一次。
     */
    if (/403|forbidden|人机验证|安全验证/i.test(msg)) {
      return { items: [], error: VERIFY_WALL_MESSAGE }
    }
    return { items: [], error: msg }
  }
}

// ---------------- 选集 ----------------

export async function ruleEpisodes(
  ruleId: string,
  entry: RuleSearchEntry
): Promise<RuleEpisodesResult> {
  const res = await ruleEpisodesRaw(ruleId, entry)
  // v0.2.4：线路名规范化 + 「多条线路挤在一个列表里」的拆分（纯本地处理，不重新跑规则）
  return { ...res, groups: normalizeEpisodeGroups(res.groups) }
}

async function ruleEpisodesRaw(
  ruleId: string,
  entry: RuleSearchEntry
): Promise<RuleEpisodesResult> {
  const rule = getRule(ruleId)
  if (!rule) return { groups: [], vars: {}, error: '规则不存在' }
  // 库驱动分支：巴哈姆特按「日语版/剧场版/OVA/中配」四个卷分组（见 services/bahamut.ts）
  if (rule.engine === 'bahamut') return await bahamutEpisodes(entry)
  const def = rule.episodes
  try {
    const groups: RuleEpisodeGroup[] = []
    let vars: Record<string, string> = {}
    if (def.type === 'xpath') {
      const url = resolveUrl(rule.baseUrl, entry.link || entry.source)
      /*
       * V1.3.9：**选集页也要能用浏览器会话取**。
       *
       * 真机证据（Tucao）：搜索已经靠 `useChromium` 修好了（32KB 完整页），
       * 但选集这一步仍走 axios —— 播放页对裸请求同样只给残缺页（连 `#player_code` 都没有），
       * 于是"搜索 1 条、选集 0 集"，再掉进网页视图兜底，一次要 180 秒。
       * 规则里开了 `useChromium` 时，播放页也走 Chromium 会话；失败再退回 HTTP。
       */
      let text: string
      if (def.useChromium) {
        try {
          text = await chromiumGetText(url, 25_000, {
            'User-Agent': BROWSER_UA,
            Referer: rule.baseUrl ?? '',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          })
          log.append('info', 'rules', `选集页走 Chromium 会话（${rule.name}）：${shortUrlForLog(url)} → ${text.length} 字节`)
        } catch (err) {
          log.append(
            'warn',
            'rules',
            `Chromium 会话取选集页失败（${rule.name}），退回 HTTP：${String((err as Error)?.message ?? err).slice(0, 60)}`
          )
          text = await httpRequest(url, 'GET', '{}', '{}', '')
        }
      } else {
        text = await httpRequest(url, 'GET', '{}', '{}', '')
      }
      const doc = toDoc(text)
      const linesXPath = def.linesXPath.trim()
      const mkEp = (a: HNode): RuleEpisode => ({
        name: nodeText(a),
        link: nodeAttr(a, 'href')
      })
      /*
       * V1.3.6：**整段文本切分**（Tucao 这类老 PHP 站必需）。
       *
       * 这类站把整部番的集数塞进**一个**元素的文本里，用分隔符拼接，例如 Tucao：
       *   <ul id="player_code"><li>type=video&file=https://…01.mp4|01**type=video&file=…02.mp4|02</li></ul>
       * 它们不是"一个元素一集"，XPath 数元素的方法只能得到 1 集（实际有 12 集）。
       * 规则里用两个新字段描述这种结构：
       *   episodesSplit  = 段间分隔符（如 `**`）
       *   episodesField  = 段内取值模板（`file` = 取 `file=` 之后到 `|` 之前；`all` = 整段当地址）
       * 集名取 `|` 后面的编号。
       */
      const splitDelim = String((def as { episodesSplit?: string }).episodesSplit ?? '').trim()
      if (splitDelim) {
        const srcNodes = evalNodes(doc, def.episodesXPath)
        const blob = srcNodes.map((n) => nodeText(n)).join(splitDelim)
        const field = String((def as { episodesField?: string }).episodesField ?? 'file').trim()
        const eps: RuleEpisode[] = []
        for (const part of blob.split(splitDelim)) {
          const seg = part.trim()
          if (!seg) continue
          const bar = seg.lastIndexOf('|')
          const label = bar >= 0 ? seg.slice(bar + 1).trim() : ''
          const body = bar >= 0 ? seg.slice(0, bar) : seg
          let link = ''
          if (field === 'all') link = body
          else {
            const m = body.match(new RegExp(`(?:^|[&?])${field}=([^&]+)`))
            link = m ? m[1] : ''
          }
          if (!link) continue
          eps.push({ name: label || `第 ${eps.length + 1} 集`, link })
        }
        if (eps.length > 0) groups.push({ lineName: null, episodes: eps })
      } else if (!linesXPath || linesXPath === '//') {
        const eps = evalNodes(doc, def.episodesXPath)
        groups.push({ lineName: null, episodes: eps.map(mkEp) })
      } else {
        const lines = evalNodes(doc, linesXPath)
        lines.forEach((line, i) => {
          // {n} 占位：把第 n 条线路的剧集容器写成绝对 XPath
          // （用于线路名标签与剧集盒子是兄弟节点的站点，例如 MacCMS + sakura 模板）
          const raw = String(def.episodesXPath ?? '')
          const usesIndex = raw.includes('{n}')
          const expr = usesIndex ? raw.replace(/\{n\}/g, String(i + 1)) : itemXPath(raw)
          const eps = usesIndex ? evalNodes(doc, expr) : evalNodes(doc, expr, line)
          const nameXPath = String(def.lineNameXPath ?? '').trim()
          let lineName = ''
          if (nameXPath) {
            try {
              if (nameXPath.startsWith('@')) lineName = nodeAttr(line, nameXPath.slice(1))
              else lineName = nodeText(evalNodes(doc, itemXPath(nameXPath), line)[0] as HNode)
            } catch {
              lineName = ''
            }
          }
          groups.push({
            lineName: (lineName || nodeText(line)).slice(0, 24) || `线路 ${i + 1}`,
            episodes: eps.map(mkEp)
          })
        })
      }
      // 服务端 HTML 里没有剧集 → 该站的选集列表多半由 JS 渲染，改用真实浏览器解析
      // （先剔除空线路：ezdmw 的首个 line_button 是隐藏占位符，留着会让 UI 出现一条空线路，
      //   也会让「取第一条线路」的调用误判为「未解析到剧集」）
      const nonEmpty = groups.filter((g) => g.episodes.length > 0)
      const effective = nonEmpty.length > 0 ? nonEmpty : groups
      const totalFromHttp = effective.reduce((n, g) => n + g.episodes.length, 0)
      if (totalFromHttp === 0) {
        log.append('info', 'rules', `HTTP 未解析到剧集，改用网页渲染解析（${rule.name}）`)
        const viaWebview = await episodesViaWebview(rule, entry)
        if (viaWebview.length > 0) return { groups: viaWebview, vars }
      } else {
        return { groups: effective, vars }
      }
    } else {
      const source = entry.source || entry.link
      const url = fillTemplate(def.url, { source })
      const query = fillTemplate(def.query, { source })
      const headers = fillTemplate(def.headers, { source })
      const text = await httpRequest(url, def.method, headers, query, def.bodyType)
      const json = JSON.parse(text)
      vars = Object.fromEntries(
        Object.entries(def.vars ?? {}).map(([k, p]) => [k, String(jpath(p, json) ?? '')])
      )
      const linesPath = (def.linesJsonPath ?? '').trim()
      const mkEpisode = (e: unknown): RuleEpisode => {
        const name = def.episodeNameJsonPath?.trim()
          ? String(jpath(def.episodeNameJsonPath, e) ?? '')
          : String((e as { name?: string })?.name ?? '')
        // 每集自带的自定义字段（如 sorani 的 episodeOrder）塞进 link，
        // 供 playUrlTemplate 的 @episodeUrl 使用
        const link = def.episodeUrlPath?.trim()
          ? String(jpath(def.episodeUrlPath, e) ?? '')
          : ''
        return { name, link }
      }
      if (!linesPath) {
        const eps = jpath<unknown[]>(def.episodesJsonPath, json)
        groups.push({
          lineName: null,
          episodes: (Array.isArray(eps) ? eps : []).map(mkEpisode)
        })
      } else {
        const rawLines = jpath<unknown>(linesPath, json)
        /*
         * Kazumi 的 format:"nested"（如 sorani）里 roadsPath 直接指向**单个对象**，
         * 剧集列表就在这个对象里；我们的实现过去只认"线路数组"，
         * 于是 nested 型规则永远解析不到剧集。这里把单个对象当作一条线路。
         */
        const lines: unknown[] = Array.isArray(rawLines)
          ? rawLines
          : rawLines && typeof rawLines === 'object'
            ? [rawLines]
            : []
        if (lines.length === 0) {
          const eps = jpath<unknown[]>(def.episodesJsonPath, json)
          groups.push({ lineName: null, episodes: (Array.isArray(eps) ? eps : []).map(mkEpisode) })
        }
        lines.forEach((line, i) => {
          const lineName = def.lineNameJsonPath?.trim()
            ? String(jpath(def.lineNameJsonPath, line) ?? `线路 ${i + 1}`)
            : `线路 ${i + 1}`
          const eps = jpath<unknown[]>(def.episodesJsonPath, line)
          groups.push({
            lineName,
            episodes: (Array.isArray(eps) ? eps : []).map(mkEpisode)
          })
        })
      }
    }
    return { groups, vars }
  } catch (err) {
    const e = err as { message?: string; code?: string }
    const msg = `选集解析失败 (${rule.name}): ${e?.message ?? String(err)}`
    log.append('warn', 'rules', msg)
    /*
     * 连接级失败给一句用户能照做的说法（v1.7）：
     * 「选集解析失败 (AGE): socket hang up」过去会被界面当成"这条线路坏了"，
     * 而实际上详情页一秒后重试就能打开（站点限流）。网页视图兜底在这里同样不加了 ——
     * 理由与 ruleSearch 里那段相同：冷却期里换浏览器窗口去打开同一个站点只会延长限流。
     */
    if (e?.code === COOL_DOWN_CODE || isTransientNetError(err)) {
      return { groups: [], vars: {}, error: `${NET_FAIL_MESSAGE}（${rule.name}）` }
    }
    return { groups: [], vars: {}, error: msg }
  }
}
// ---------------- 播放地址 ----------------

export async function rulePlay(
  ruleId: string,
  entry: RuleSearchEntry,
  lineIndex: number,
  episodeIndex: number,
  episodeLink: string,
  vars: Record<string, string>
): Promise<RulePlayResult> {
  const rule = getRule(ruleId)
  if (!rule) throw new Error('规则不存在')
  // 库驱动分支：巴哈姆特返回**官方观看页**（直链由站点播放器持有，见 bahamut.ts 的说明）
  if (rule.engine === 'bahamut') return bahamutPlay(episodeLink)
  const def = rule.episodes
  if (def.type === 'xpath') {
    const url = resolveUrl(rule.baseUrl, episodeLink || entry.link || entry.source)
    return { url, referer: rule.baseUrl }
  }
  const v = {
    ...vars,
    // api 规则的播放地址模板可用 @source（搜索条目 id）与 @episodeUrl（每集自定义字段）
    source: entry.source || entry.link || '',
    episodeUrl: episodeLink || vars.episodeUrl || '',
    roadIndex: String(lineIndex),
    episodeIndex: String(episodeIndex)
  }
  const url = fillTemplate(def.playUrlTemplate, v)
  const qs = Object.entries(def.playQuery ?? {})
    .map(([k, val]) => `${encodeURIComponent(k)}=${encodeURIComponent(fillTemplate(String(val), v))}`)
    .join('&')
  return { url: qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url, referer: rule.baseUrl }
}

// ---------------- 规则本地库（v0.3.9） ----------------

/**
 * 本地库（store 命名空间 `rulesLocal`）。
 *
 * 用户原话：「所有有问题的规则你都可以修改，修改到跑通，另外规则设置中新增本地库，
 * 修改过的规则全部放在本地库中（任何修改都是），当从 git 规则库中导入的规则或者
 * 从 git 规则库中更新的规则跑不通时，我们还有本地库可以替换使用。」
 *
 * 为什么必须是**独立的 store 命名空间**：`rules` 会被「从仓库导入 / 启动自动更新」整条覆盖，
 * 本地库如果混在 rules 里就会被一起冲掉 —— 那正好失去"仓库版本跑不通时还能退回本地版本"的意义。
 */
const LOCAL_NS = 'rulesLocal'
/** 同一条规则最多留几个版本（按时间倒序保留）：够回溯"上一版/上上版"，又不会无限膨胀 */
const LOCAL_MAX_PER_RULE = 8
/** 本地库总条数上限：超了就丢最旧的（本地库是"最近能用的几版"，不是归档系统） */
const LOCAL_MAX_TOTAL = 400

/**
 * 规则**内容**哈希：只算会影响"能不能跑通"的字段（名字/版本/地址/搜索/选集定义）。
 *
 * 为什么不直接 JSON.stringify(rule)：
 *  ① enabled、createdAt、origin 这些是"状态"不是"内容"，用户只是开关一下规则，
 *     不该因此多出一条"新版本"（否则本地库会被开关操作灌满）；
 *  ② 字段顺序不稳定时字符串比较会误判为"变了"。
 */
function ruleContentHash(rule: PlayRule): string {
  const basis = JSON.stringify({
    name: rule.name,
    version: rule.version,
    baseUrl: rule.baseUrl,
    search: rule.search,
    episodes: rule.episodes
  })
  return createHash('sha1').update(basis).digest('hex').slice(0, 12)
}

/** 读本地库（读取一律返回副本，直接改数组不会污染 store 缓存） */
export function listLocalRules(): LocalRuleEntry[] {
  const list = store.get<LocalRuleEntry[]>(LOCAL_NS, [])
  return Array.isArray(list) ? list : []
}

/**
 * 把一条规则的快照存进本地库（按 `ruleId#内容哈希` 去重）。
 *
 * 为什么入库的是**当前内容**而不是"上一版"：用户要的语义是"修改到跑通的版本要留在本地库里，
 * 仓库版跑不通时用它替换回去"。所以每次内容变化都把**新版**记一份；被覆盖掉的旧版同样留档
 * （`before-change` / `repo-import`），这样任一历史版本都还能找回。
 */
export function archiveRuleSnapshot(
  rule: PlayRule,
  reason: LocalRuleReason,
  origin?: RuleOrigin
): LocalRuleEntry | null {
  if (!rule?.id || !rule.name) return null
  try {
    const hash = ruleContentHash(rule)
    const id = `${rule.id}#${hash}`
    const list = listLocalRules()
    if (list.some((e) => e.id === id)) return null // 同一内容不重复入库
    const entry: LocalRuleEntry = {
      id,
      ruleId: rule.id,
      name: rule.name,
      version: rule.version,
      // 快照本体去掉 origin/localAppliedAt 这类"当前状态"字段：它描述的是当时的内容，
      // 来源由 entry.origin 单独记，替换回去时再按需重新打标。
      rule: { ...rule, origin: undefined },
      savedAt: Date.now(),
      reason,
      origin: origin ?? rule.origin ?? guessOrigin(rule),
      hash
    }
    list.push(entry)
    // 逐条规则裁剪 + 总量裁剪（都是保留最新的那几版）
    const trimmed = trimLocalRules(list)
    store.set(LOCAL_NS, trimmed)
    log.append('info', 'rules', `本地库已留档：${rule.name} v${rule.version}（${reason}）`)
    return entry
  } catch (err) {
    // 留档失败不能影响规则本身的使用：只记一条日志
    log.append('warn', 'rules', `本地库留档失败（${rule.name}）: ${String(err)}`)
    return null
  }
}

/** 老数据没有 origin 字段时的兜底推断（id 前缀是历史约定） */
function guessOrigin(rule: PlayRule): RuleOrigin {
  if (rule.origin) return rule.origin
  if (rule.id.startsWith('default-')) return 'builtin'
  if (rule.id.startsWith('repo-')) return 'repo'
  return 'local'
}

/** 裁剪本地库：每条规则最多 LOCAL_MAX_PER_RULE 版、总条数不超过 LOCAL_MAX_TOTAL（保留最新的） */
function trimLocalRules(list: LocalRuleEntry[]): LocalRuleEntry[] {
  const byRule = new Map<string, LocalRuleEntry[]>()
  for (const e of list) {
    const arr = byRule.get(e.ruleId) ?? []
    arr.push(e)
    byRule.set(e.ruleId, arr)
  }
  const kept: LocalRuleEntry[] = []
  for (const arr of byRule.values()) {
    arr.sort((a, b) => b.savedAt - a.savedAt)
    kept.push(...arr.slice(0, LOCAL_MAX_PER_RULE))
  }
  kept.sort((a, b) => b.savedAt - a.savedAt)
  return kept.slice(0, LOCAL_MAX_TOTAL).sort((a, b) => a.savedAt - b.savedAt)
}

/**
 * 规则数组发生整体替换时（导入/覆盖/删除/用户保存）逐条对比，把"变了的、被删的、新增的"都留档。
 *
 * 为什么要对比而不是无脑全量入库：
 *  ① 每次启动都会重写 rules（内置刷新/修正），无脑入库会让本地库每次启动多出一堆一模一样的条目；
 *  ② "任何修改都留一份"指的是**内容真的变了**的那些，靠内容哈希去重正好表达这个语义。
 */
export function archiveRuleChanges(
  prev: PlayRule[],
  next: PlayRule[],
  reason: LocalRuleReason,
  nextReason: LocalRuleReason = 'after-change',
  /**
   * 可选：按规则决定"新版"的入库原因。
   * 为什么需要它：一次写入里可能混着两类东西 —— 内置规则（应用托管、最可靠的那一版）
   * 与用户/仓库规则。用同一个原因会让内置版在本地库里显示成"修改后的版本"，
   * 用户就看不出"这条是随应用分发的兜底版本"，也就不知道该不该拿它去替换。
   */
  nextReasonOf?: (rule: PlayRule) => LocalRuleReason
): number {
  let saved = 0
  const prevByHash = new Map<string, PlayRule>()
  const prevById = new Map<string, PlayRule>()
  for (const r of prev) {
    if (!r?.id) continue
    prevByHash.set(`${r.id}#${ruleContentHash(r)}`, r)
    prevById.set(r.id, r)
  }
  for (const r of next) {
    if (!r?.id) continue
    const same = prevByHash.has(`${r.id}#${ruleContentHash(r)}`)
    if (same) continue // 内容没变，不入库
    const before = prevById.get(r.id)
    // 被改掉的那一版先留档，再存新版（顺序不影响结果，只是日志更好读）
    if (before) if (archiveRuleSnapshot(before, reason)) saved++
    if (archiveRuleSnapshot(r, nextReasonOf ? nextReasonOf(r) : nextReason)) saved++
  }
  // 被删掉的规则：留档后用户还能找回来
  const nextIds = new Set(next.map((r) => r?.id).filter(Boolean))
  for (const r of prev) {
    if (!r?.id || nextIds.has(r.id)) continue
    if (archiveRuleSnapshot(r, 'removed')) saved++
  }
  return saved
}

/** 内置规则随应用更新（保留用户自定义规则，仅刷新 default- 前缀的内置规则） */
export function ensureDefaultRules(): void {
  const rules = store.get<PlayRule[]>('rules', [])
  /*
   * 内置规则（default- 前缀）由应用托管：每次启动都按内置定义刷新，保证
   * ① 用户点名要内置的 AGE / sorani / aafun 一定存在；
   * ② 内置内容随应用升级而更新（用户不用手动"恢复默认"）。
   * 用户自己加的、以及从仓库导入的规则（repo- / 其它 id）一律原样保留、顺序不动。
   *
   * ⚠️ RETIRED_RULES 里的内置规则**每次启动都保持停用**：它们四部番全败（见 shared 的说明），
   * 如果这里统一强制 enabled:true，用户下次启动就会看到一条"看起来能播、其实播不出"的线路。
   * 用户仍可在规则页手动打开（只是下次启动会回到停用，直到我们发布修复版）。
   */
  const builtin = DEFAULT_RULES.map((r) => ({ ...r, enabled: RETIRED_RULES[r.id] ? false : true }))
  const custom = rules.filter((r) => !r.id.startsWith('default-'))
  /*
   * 巴哈姆特规则已按用户要求**删除**（原话：「巴哈姆特用于弹幕源就够了」）。
   *
   * 为什么连"播种"代码一起删掉：v1.1 时它是「只播种一次」的普通规则（local-bahamut），
   * 靠 `bahamutRuleSeeded` 保证用户删掉后不再出现。但那一层保险只防"用户手动删"，
   * 防不了"应用又给装回来"—— 只要播种逻辑还在，新装/换机/清数据后它就会重新出现在
   * 播放源列表里，而它只对台湾网络开放、播放链路也天然不完整，用户已经不想要这条线路了。
   * 现在改为：**应用不再播这条种**，历史数据里的 local-bahamut 也一并从 store 与本地库清掉
   * （弹幕侧的 bahamut 模块不受影响：那条链路走 danmakuSources，与播放规则无关）。
   */
  // 内置排最前（ensureDefaultRules 的合并顺序，不是界面顺序）：
  // 界面与嗅探顺序一律由 shared 的 sortRulesBySpeed 按实测耗时决定，与存储顺序无关。
  const next = [...builtin, ...custom]
  if (JSON.stringify(next) !== JSON.stringify(rules)) {
    // 被覆盖掉的旧内容先留档到本地库，再写新的（"任何修改都留一份"）；
    // 内置规则标记成 'builtin'：它在本地库里就是"随应用分发、最可靠的那一版"
    const saved = archiveRuleChanges(rules, next, 'before-change', 'after-change', (r) =>
      r.id.startsWith('default-') ? 'builtin' : 'after-change'
    )
    store.set('rules', next)
    log.append(
      'info',
      'rules',
      `内置播放规则已更新（${builtin.length} 条：${builtin.map((r) => r.name).join('、')}）` +
        (saved > 0 ? `，旧版本已留档 ${saved} 条到本地库` : '')
    )
  }
  seedLocalLibraryFromRules()
  repairStoredRules()
  migrateRuleLibrary()
}

/**
 * 规则库整理（v1.4.0，用户要求）—— **一次性迁移 + 每次校正测速值**。
 *
 * 用户原话（整理诉求）：
 *   · 删掉本地库里重复的 sorani；
 *   · 删除巴哈姆特规则（「巴哈姆特用于弹幕源就够了」）；
 *   · 其余规则去重整理（同一 ruleId 只留最新一条）；
 *   · 新增 E站（ezdmw）与 AniWatch，并在四部番上实测，可用才留、全败就标"暂不可用"并停用；
 *   · 去掉"置顶三条"、按实测的决定性耗时排序（嗅探顺序也跟着这个）。
 *
 * 为什么做成**启动迁移**而不是改一次 JSON 文件：
 *   ① 规则数据在 `<安装目录>/data/userData/data/`，不在构建产物里 —— 改代码不会自动生效，
 *      而用户升级/换机/清数据后最需要的恰恰是"自动整理一遍"；
 *   ② 本地库条目的 id 是 `规则id#内容哈希`（见 ruleContentHash），手改 JSON 极容易写错哈希，
 *      写错之后界面永远判定"当前规则不是这份快照"，替换按钮就废了；
 *   ③ 迁移带版本号（RULE_LIBRARY_REVISION），只跑一次，重复启动不会反复改动用户数据。
 *
 * 为什么测速值**每次启动都写**：
 *   它只是排序键，而且会被"仓库自动更新"整条覆盖（rulesRepoImport 会用远端内容重建规则对象）。
 *   每次启动补一次，成本是几十次对象赋值，换来的是排序永远与 shared 里的实测值一致。
 */
function migrateRuleLibrary(): void {
  const rules = store.get<PlayRule[]>('rules', [])
  const rev = store.get<number>('rulesLibraryRevision', 0)
  let next = rules

  if (rev < RULE_LIBRARY_REVISION) {
    const ids = new Set(REMOVED_RULE_IDS)
    const beforeIds = new Set(next.map((r) => r.id))
    next = next.filter((r) => !ids.has(r.id))
    const removedCount = beforeIds.size - new Set(next.map((r) => r.id)).size
    /*
     * 同 ruleId 只留最新一条：'rules' 里本来不该有重复 id，但历史导入/手改产生过，
     * 这里按"内容哈希最新"兜底（保存顺序即最近写入顺序）。
     */
    const seen = new Set<string>()
    const deduped: PlayRule[] = []
    for (const r of [...next].reverse()) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      deduped.push(r)
    }
    next = deduped.reverse()
    // 两条新规则：按 id upsert（存在则**保留用户的启用状态/创建时间**，只换内容）
    for (const seed of RULE_LIBRARY_SEEDS) {
      const i = next.findIndex((r) => r.id === seed.id)
      if (i >= 0) {
        next[i] = { ...seed, enabled: next[i].enabled, createdAt: next[i].createdAt || seed.createdAt }
      } else {
        next.push({ ...seed })
      }
    }
    // 全败规则一次性停用；"需人机验证"的只写说明，保持启用
    next = next.map((r) => {
      const retired = RETIRED_RULES[r.id]
      const note = RULE_NOTES[r.id]
      if (!retired && !note) return r
      return {
        ...r,
        ...(retired ? { enabled: false, playbackNote: retired } : {}),
        ...(note ? { playbackNote: note } : {})
      }
    })
    const addedCount = next.filter((r) => !beforeIds.has(r.id)).length
    log.append(
      'info',
      'rules',
      `规则库整理：删除 ${removedCount} 条（${REMOVED_RULE_IDS.join('、')}）、新增 ${addedCount} 条、` +
        `停用 ${Object.keys(RETIRED_RULES).length} 条四部番全败的线路`
    )
  }

  // 每次启动校正测速值（见上面的说明）：只影响排序，不碰内容/启用状态
  let speedChanged = false
  next = next.map((r) => {
    const ms = RULE_SPEED_MS[r.id]
    if (ms === undefined || r.speedMs === ms) return r
    speedChanged = true
    return { ...r, speedMs: ms }
  })
  if (speedChanged || JSON.stringify(next) !== JSON.stringify(rules)) store.set('rules', next)

  if (rev < RULE_LIBRARY_REVISION) {
    dedupeLocalLibrary()
    store.set('rulesLibraryRevision', RULE_LIBRARY_REVISION)
  }
}

/**
 * 本地库整理：同一 ruleId 只留**最新一条**快照（用户要求），并清掉已删除规则的历史。
 *
 * 为什么"只留最新"而不是继续保留 8 版：
 *   本地库的意义是"仓库版跑不通时有一份能用的替换版本"。规则刚跑通的那一版就是最新的，
 *   更老的版本在站点改版后几乎不会再能播，留着只会让本地库列表变成一长串同名条目
 *   （用户看到的就是"重复的 sorani"这类问题本身）。
 *   代价是失去"退回上上版"的能力 —— 这一点已在报告里写明，需要时再手工导出。
 */
function dedupeLocalLibrary(): void {
  const local = listLocalRules()
  const gone = new Set(REMOVED_RULE_IDS)
  const newest = new Map<string, LocalRuleEntry>()
  for (const e of local) {
    if (gone.has(e.ruleId)) continue
    const cur = newest.get(e.ruleId)
    if (!cur || e.savedAt > cur.savedAt) newest.set(e.ruleId, e)
  }
  const kept = [...newest.values()].sort((a, b) => a.savedAt - b.savedAt)
  store.set(LOCAL_NS, trimLocalRules(kept))
  log.append(
    'info',
    'rules',
    `本地库已整理：${local.length} 条 → ${kept.length} 条（同一规则只留最新版，已删除规则的历史一并清掉）`
  )
  // 两条新规则各留一份快照，保证"仓库版跑不通时能替换回这一版"
  for (const seed of RULE_LIBRARY_SEEDS) {
    archiveRuleSnapshot(seed, 'first-seen', seed.origin)
  }
}

/**
 * 把"当前正在生效"的规则各留一份到本地库（启动时跑一次）。
 *
 * 为什么要有这一步：本地库要能在仓库版本跑不通时顶上去，就必须**在出问题之前**已经存有能跑通的版本。
 * 只靠"改动时才留档"的话，用户从没改过的内置规则在本地库里是空的，
 * 而它恰恰是最可能被仓库更新覆盖掉的（覆盖后旧版就找不回来了）。
 */
function seedLocalLibraryFromRules(): void {
  for (const r of store.get<PlayRule[]>('rules', [])) {
    archiveRuleSnapshot(r, r.id.startsWith('default-') ? 'builtin' : 'first-seen')
  }
}

/**
 * 站点改版修正表：上游规则（仓库/内置）的 XPath 会随站点改版失效，
 * 这里按 baseURL 定点修复，比等待上游更新更快。
 * 每次启动都会应用，保证重新导入仓库规则后修正依然生效。
 */
const RULE_FIXES: {
  match: RegExp
  version?: string
  search?: Partial<RuleSearchDef>
  episodes?: Partial<RuleEpisodesDef>
}[] = [
  {
    // 黑猫动漫 baimao：搜索结果为 .vlist/.item 列表，剧集按 .movurl 线路 + li/a
    match: /baimaodm\.com/i,
    version: '1.0.1-fix',
    search: {
      listXPath: '//div[contains(@class,"lpic")]/ul/li',
      itemNameXPath: './/h2/a',
      itemLinkXPath: './/h2/a'
    },
    episodes: {
      linesXPath: '//div[contains(@class,"movurl")]',
      episodesXPath: './/li/a'
    }
  },
  {
    /*
     * 萌甸 EZDMW（www.ezdmw.org / m.ezdmw.org）。
     *
     * 历史问题（v0.3.9）：线路 XPath 里的 `//section[@class='anthology'][1]`
     * 在 XPath 1.0 里是「父节点下的第一个 section」而非「结果集第一个」，
     * 命中的是另一处 section → 线路恒为 0 条。改按线路按钮类名直取。
     * 剧集表达式是行内 `self::/following-sibling::` 轴写法，由 itemXPath/enhance 负责转义。
     *
     * v1.4 起规则本体重写（见 data 里的 repo-ezdmw：站点根换成桌面版 www，
     * 搜索/选集 XPath 全部实测过），这条修正仍然保留 —— 因为从仓库重新导入时
     * 拿到的还是 1.2 的旧定义，修正表要能把它拉回可用状态。
     * 版本号跟着规则一起抬到 1.4：不抬的话 applyRuleFix 会把新规则**改回 1.3-fix**，
     * 启动自动更新就会误判「仓库版 1.2 比本地新」而反复覆盖。
     */
    match: /ezdmw\.org/i,
    version: '1.4',
    episodes: {
      linesXPath: '//div[contains(@class,"line_button")]'
    }
  },
  {
    /*
     * 樱之空（skr.skrcc.cc:666）—— v0.3.9 实测「搜索有结果、线路 7 条，但剧集恒为 0」。
     *
     * 根因：站点把剧集容器的类名改掉了，老的
     *   `(//div[contains(@class,"play_list_box")])[{n}]//div[@id="playlistbox"]/ul/li/a`
     * 第一段就命中 0 个节点，整条表达式因此恒为空（线路倒是还在，因为 #NumTab 没变）。
     * 实测新结构：页面里仍有 **7 个 `div#playlistbox`**（每线路一个），
     * 且顺序与 #NumTab 的标签一一对应 —— 于是直接用「第 n 个 #playlistbox」配对
     * （{n} 占位由 ruleEpisodesRaw 支持），实测 7 条线路各 14 集。
     * 用 `ul/li/a` 而不是 `//a`：后者会把「展开/收起」这类非剧集链接也算进来（实测多 1 条）。
     */
    match: /skrcc\.cc/i,
    version: '1.1-fix',
    episodes: {
      linesXPath: '//div[@id="NumTab"]/a',
      lineNameXPath: '@alt',
      episodesXPath: '(//div[@id="playlistbox"])[{n}]/ul/li/a'
    }
  },
  {
    /*
     * MXdm（dcc3.com）—— v0.3.9 实测「搜索 11 条、剧集 0」。
     *
     * 根因：详情页把线路容器换成了 `ul.list6`（老的 `//div[@class='playlist']/div[@class='row']/ul`
     * 命中 0）。实测新结构 `ul.list6` 两段 = 两条线路，每条 14 集，
     * 剧集链接形如 /play/<id>-<线路>-<集>/ —— 用 `.//li/a`（相对线路）即可。
     */
    match: /dcc3\.com/i,
    version: '2.5-fix',
    episodes: {
      linesXPath: '//ul[contains(@class,"list6")]',
      episodesXPath: './/li/a'
    }
  },
  {
    /*
     * 月之祠（moonci.com）—— v0.3.9 实测「搜索 0 条」（aafun 与仓库里的 moonci 是同站同名规则）。
     *
     * 根因与 aafun 完全一样：站点 HTML 搜索页走的是它自己的全文索引，
     * 整串标题经常命中不了（实测「久留美」0 条），而站点的搜索补全接口是 SQL LIKE、能命中。
     * 所以这条修正把**搜索改到 ajax/suggest**，并用 itemLinkTemplate 由 id 拼详情页地址
     * （该接口只给 id）；剧集侧顺带改成 aafun 那套已验证可用的单线路写法
     * （老的 `hl-play-source` 容器在当前页面已为 0）。
     *
     * ⚠️ 特意**不写 version**：这条 baseURL 会同时命中内置 aafun（版本 1.3-fix），
     * 写死一个版本号会把 aafun 的版本压低，反而让启动自动更新判定"仓库版 1.2 更新"
     * 而把修好的内置版覆盖回去 —— 这正是要避免的。
     */
    match: /moonci\.com/i,
    search: {
      type: 'api',
      method: 'GET',
      url: 'https://www.moonci.com/index.php/ajax/suggest?mid=1&wd=@keyword&limit=20',
      query: '{}',
      listJsonPath: '$.list[*]',
      itemNameJsonPath: '$.name',
      itemSourceJsonPath: '$.id',
      itemLinkTemplate: 'https://www.moonci.com/anime/@source.html'
    },
    episodes: {
      linesXPath: '',
      episodesXPath: '//ul[contains(@class,"hl-plays-list")]/li/a'
    }
  }
]

/** 对单条规则应用修正（导出供搜索/选集流程即时使用） */
export function applyRuleFix(rule: PlayRule): PlayRule {
  for (const fix of RULE_FIXES) {
    if (!fix.match.test(rule.baseUrl)) continue
    return {
      ...rule,
      version: fix.version ?? rule.version,
      search: { ...rule.search, ...(fix.search ?? {}) },
      episodes: { ...rule.episodes, ...(fix.episodes ?? {}) }
    }
  }
  return rule
}

/** 启动时把修正写回存储（UI 与播放同时生效），并记录改动 */
function repairStoredRules(): void {
  const rules = store.get<PlayRule[]>('rules', [])
  let changed = 0
  const next = rules.map((r) => {
    const fixed = applyRuleFix(r)
    if (fixed !== r && JSON.stringify(fixed) !== JSON.stringify(r)) changed++
    return fixed
  })
  if (changed > 0) {
    // 修正表改写的也是"规则内容"，同样要留一份到本地库（用户要的是"任何修改都留档"）
    archiveRuleChanges(rules, next, 'before-change', 'auto-fix')
    store.set('rules', next)
    log.append('info', 'rules', `已应用 ${changed} 条站点改版修正`)
  }
}

// ---------------- Kazumi 规则仓库（镜像优先） ----------------

/**
 * KazumiRules 规则仓库镜像。
 *
 * 实测（2025 本地验证）：
 * - raw.gitcode.com 已不再返回 raw 文件（返回 HTML），必须排最后并靠 JSON 校验挡掉；
 * - raw.githubusercontent.com 在大陆网络常被墙；
 * - jsDelivr 三个 CDN 与 ghproxy.net / gh-proxy.com 均可稳定取到 index.json。
 * 因此按"国内可达性"排序，并且并发竞速取第一个成功的结果（避免逐个 15 秒超时）。
 */
const REPO_BASES: { name: string; base: string }[] = [
  { name: 'jsDelivr', base: 'https://cdn.jsdelivr.net/gh/Predidit/KazumiRules@main' },
  { name: 'jsDelivr-Fastly', base: 'https://fastly.jsdelivr.net/gh/Predidit/KazumiRules@main' },
  { name: 'ghproxy', base: 'https://ghproxy.net/https://raw.githubusercontent.com/Predidit/KazumiRules/main' },
  { name: 'gh-proxy', base: 'https://gh-proxy.com/https://raw.githubusercontent.com/Predidit/KazumiRules/main' },
  { name: 'jsDelivr-Gcore', base: 'https://gcore.jsdelivr.net/gh/Predidit/KazumiRules@main' },
  { name: 'GitHub', base: 'https://raw.githubusercontent.com/Predidit/KazumiRules/main' },
  { name: 'gitcode', base: 'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/main' }
]

/** 上次成功的镜像：后续取规则文件优先用它，避免重复竞速 */
let preferredRepoBase: string | null = null

async function fetchRepoFile(base: string, file: string, timeout = 12000): Promise<string | null> {
  const res = await axios.get(`${base}/${file}`, {
    timeout,
    responseType: 'text',
    headers: { 'User-Agent': BROWSER_UA },
    ...buildProxyAgents(getSettings().proxy)
  })
  const text = String(res.data ?? '')
  if (res.status !== 200) return null
  const body = text.trim()
  // 关键：镜像可能返回 HTML 错误页，必须校验确实是 JSON 才认
  if (!body.startsWith('{') && !body.startsWith('[')) return null
  return body
}

interface KazumiRuleIndexItem {
  name: string
  version: string
  author?: string
  lastUpdate?: number
}

interface KazumiRule {
  api?: string
  type?: string
  name?: string
  version?: string
  baseURL?: string
  searchURL?: string
  searchList?: string
  searchName?: string
  searchResult?: string
  searchHeaders?: Record<string, string>
  searchData?: Record<string, unknown>
  searchMethod?: string
  searchResponse?: string
  searchJsonList?: string
  searchJsonName?: string
  searchJsonResult?: string
  chapterRoads?: string
  chapterResult?: string
  chapterJsonRoads?: string
  chapterJsonResult?: string
  /** api 模式（searchMode/chapterMode = "api"）：搜索与选集走 JSON 接口 */
  searchMode?: string
  chapterMode?: string
  searchApiConfig?: {
    request?: { method?: string; url?: string; headers?: Record<string, string>; query?: Record<string, unknown> }
    listPath?: string
    namePath?: string
    sourcePath?: string
  }
  chapterApiConfig?: {
    request?: { method?: string; url?: string; headers?: Record<string, string>; query?: Record<string, unknown> }
    format?: string
    roadsPath?: string
    roadNamePath?: string
    episodesPath?: string
    episodeNamePath?: string
    episodeUrlPath?: string
    episodePage?: { url?: string; query?: Record<string, string> }
  }
}

/** 取单条规则文本：优先上次成功的镜像，其余并发竞速 */
async function fetchRuleText(name: string): Promise<string | null> {
  const file = `${encodeURIComponent(name)}.json`
  if (preferredRepoBase) {
    try {
      const t = await fetchRepoFile(preferredRepoBase, file, 8000)
      if (t) return t
    } catch {
      preferredRepoBase = null
    }
  }
  const others = REPO_BASES.map((r) => r.base).filter((b) => b !== preferredRepoBase)
  const results = await Promise.all(
    others.map(async (base) => {
      try {
        const t = await fetchRepoFile(base, file, 10000)
        return t ? { base, text: t } : null
      } catch {
        return null
      }
    })
  )
  const hit = results.find((r) => r !== null)
  if (hit) {
    preferredRepoBase = hit.base
    return hit.text
  }
  return null
}

/** 规则仓库索引：并发竞速所有镜像，取第一个合法的 JSON 数组 */
export async function rulesRepoIndex(): Promise<KazumiRuleIndexItem[]> {
  const results = await Promise.all(
    REPO_BASES.map(async (r) => {
      try {
        const text = await fetchRepoFile(r.base, 'index.json')
        if (!text) return null
        const data = JSON.parse(text) as KazumiRuleIndexItem[]
        if (!Array.isArray(data) || data.length === 0) return null
        return { name: r.name, base: r.base, data }
      } catch {
        return null
      }
    })
  )
  const hit = results.find((r) => r !== null)
  if (hit) {
    preferredRepoBase = hit.base
    log.append('info', 'rules', `规则仓库索引来自 ${hit.name}（${hit.data.length} 条）`)
    return hit.data
  }
  log.append('error', 'rules', '所有规则仓库镜像均不可用（已尝试 jsDelivr / ghproxy / GitHub / gitcode）')
  throw new Error(
    '无法获取 Kazumi 规则仓库索引：所有镜像均不可用（jsDelivr、ghproxy、GitHub、gitcode）。请检查网络或代理设置。'
  )
}

/** Kazumi 规则 → 本地 PlayRule Schema */
function convertKazumiRule(raw: KazumiRule): PlayRule {
  const searchApi = raw.searchApiConfig
  const chapterApi = raw.chapterApiConfig
  const isApi = !!raw.searchJsonList || raw.searchMode === 'api' || !!searchApi
  const rule = emptyRule()
  rule.name = raw.name ?? '未命名规则'
  rule.version = raw.version ?? '1.0'
  rule.baseUrl = raw.baseURL ?? ''
  rule.search.type = isApi ? 'api' : 'xpath'
  rule.search.method = raw.searchMethod === 'POST' ? 'POST' : 'GET'
  rule.search.url = raw.searchURL ?? ''
  rule.search.headers = raw.searchHeaders ? JSON.stringify(raw.searchHeaders) : '{}'
  rule.search.query = raw.searchData ? JSON.stringify(raw.searchData) : '{}'
  rule.search.listXPath = raw.searchList ?? ''
  rule.search.itemNameXPath = raw.searchName ?? ''
  rule.search.itemLinkXPath = raw.searchResult ?? ''
  rule.search.listJsonPath = raw.searchJsonList ?? ''
  rule.search.itemNameJsonPath = raw.searchJsonName ?? ''
  rule.search.itemSourceJsonPath = raw.searchJsonResult ?? ''

  /*
   * Kazumi 的 api 模式（searchMode/chapterMode = "api"）：搜索与选集都走 JSON 接口。
   * 例如 sorani 的定义在 searchApiConfig / chapterApiConfig 里，过去转换器不认这些字段，
   * 会转出一条空规则（搜索直接报 Invalid URL）。
   */
  if (searchApi) {
    rule.search.type = 'api'
    rule.search.method = searchApi.request?.method === 'POST' ? 'POST' : 'GET'
    rule.search.url = searchApi.request?.url ?? rule.search.url
    rule.search.query = JSON.stringify(searchApi.request?.query ?? {})
    if (searchApi.request?.headers) rule.search.headers = JSON.stringify(searchApi.request.headers)
    rule.search.listJsonPath = searchApi.listPath ?? ''
    rule.search.itemNameJsonPath = searchApi.namePath ?? ''
    rule.search.itemSourceJsonPath = searchApi.sourcePath ?? ''
  }

  if (chapterApi) {
    rule.episodes.type = 'api'
    rule.episodes.method = chapterApi.request?.method === 'POST' ? 'POST' : 'GET'
    rule.episodes.url = chapterApi.request?.url ?? ''
    if (chapterApi.request?.query) rule.episodes.query = JSON.stringify(chapterApi.request.query)
    if (chapterApi.request?.headers) rule.episodes.headers = JSON.stringify(chapterApi.request.headers)
    rule.episodes.linesJsonPath = chapterApi.roadsPath ?? ''
    rule.episodes.lineNameJsonPath = chapterApi.roadNamePath ?? ''
    rule.episodes.episodesJsonPath = chapterApi.episodesPath ?? ''
    rule.episodes.episodeNameJsonPath = chapterApi.episodeNamePath ?? ''
    // 播放页地址模板：@source（搜索条目的 id）与 @episodeUrl（每集的自定义字段）
    if (chapterApi.episodePage?.url) {
      rule.episodes.playUrlTemplate = chapterApi.episodePage.url
      rule.episodes.playQuery = chapterApi.episodePage.query ?? {}
    }
    if (chapterApi.episodeUrlPath) {
      // 每集自带字段（如 episodeOrder）：既做播放模板的 @episodeUrl，也保留在 vars 里
      rule.episodes.episodeUrlPath = chapterApi.episodeUrlPath
      rule.episodes.vars = { ...(rule.episodes.vars ?? {}), episodeUrl: chapterApi.episodeUrlPath }
    }
    return rule
  }

  // 选集：统一按 XPath 处理（Kazumi 规则中的章节路径均为 XPath；API 型规则若提供 JSON 路径则用之）
  const useJsonEpisodes = !!raw.chapterJsonResult || !!raw.chapterJsonRoads
  rule.episodes.type = useJsonEpisodes ? 'api' : 'xpath'
  rule.episodes.linesXPath = raw.chapterRoads ?? ''
  rule.episodes.episodesXPath = raw.chapterResult ?? ''
  rule.episodes.linesJsonPath = raw.chapterJsonRoads ?? ''
  rule.episodes.episodesJsonPath = raw.chapterJsonResult ?? ''
  return rule
}

export async function rulesRepoImport(names: string[]): Promise<{ imported: number; failed: string[] }> {
  const rules = store.get<PlayRule[]>('rules', [])
  const byName = new Map(rules.map((r) => [r.name, r]))
  let imported = 0
  const failed: string[] = []
  for (const name of names) {
    try {
      const text = await fetchRuleText(name)
      if (!text) {
        failed.push(name)
        continue
      }
      const raw = JSON.parse(text) as KazumiRule
      const rule = convertKazumiRule(raw)
      const existing = byName.get(rule.name)
      const finalRule: PlayRule = existing
        ? {
            ...rule,
            id: existing.id,
            enabled: existing.enabled,
            createdAt: existing.createdAt,
            // 来源如实标成"仓库版"：界面据此显示"当前用的是 git 版还是本地版"（v0.3.9）
            origin: 'repo'
          }
        : { ...rule, id: `repo-${rule.name.toLowerCase()}`, createdAt: Date.now(), origin: 'repo' }
      /*
       * 刚导入的规则也要带测速值，否则它在本会话里会一直排到最后
       * （迁移只在启动时补；用户点"从仓库导入"之后就会看到顺序突然变了）。
       */
      finalRule.speedMs = RULE_SPEED_MS[finalRule.id] ?? RULE_SPEED_MS[finalRule.name.toLowerCase()]
      if (existing) {
        /*
         * 覆盖前先把**被覆盖的那一版**留档到本地库（v0.3.9）：
         * 用户要求"从 git 规则库导入/更新的规则跑不通时，还有本地库可以替换使用"，
         * 那么被覆盖掉的这一版就必须先存下来 —— 否则覆盖之后原来的能跑版本就永久消失了。
         */
        archiveRuleSnapshot(existing, 'repo-import', guessOrigin(existing))
        const idx = rules.findIndex((r) => r.id === existing.id)
        rules[idx] = finalRule
      } else {
        rules.push(finalRule)
        byName.set(rule.name, finalRule)
      }
      imported++
    } catch (err) {
      log.append('warn', 'rules', `导入规则失败 (${name}): ${String(err)}`)
      failed.push(name)
    }
  }
  store.set('rules', rules)
  log.append('info', 'rules', `规则仓库导入完成：${imported} 条成功，${failed.length} 条失败`)
  // 导入后的新内容同样进本地库（用户"任何修改都留一份"，且下次被覆盖时它就是"上一版"）
  for (const name of names) {
    const r = rules.find((x) => x.name === name)
    if (r) archiveRuleSnapshot(r, 'repo-import', 'repo')
  }
  return { imported, failed }
}

// ---------------- 启动时自动检测规则仓库更新 ----------------

/**
 * 规则版本比较（仓库里的 version 是 `1.0` / `1.4` / `2.3` 这类点分数字，
 * 也可能出现 `1.0.1-fix` 这种**本地位**——见 RULE_FIXES 的 version 字段）。
 *
 * 逐段比较：纯数字段按数值比大小（避免 '10' < '9' 这种字典序错误），
 * 非数字段按字典序；段数不足的一侧按 '0' 补，因此 `1.0` 与 `1.0.0` 视为相同版本。
 * 返回 <0：a 比 b 旧；0：相同；>0：a 比 b 新。
 */
function compareRuleVersion(a: string, b: string): number {
  const toSeg = (v: string): string[] =>
    String(v ?? '')
      .trim()
      .split(/[.\-_+]/)
      .filter((s) => s !== '')
  const x = toSeg(a)
  const y = toSeg(b)
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const p = x[i] ?? '0'
    const q = y[i] ?? '0'
    const pNum = /^\d+$/.test(p)
    const qNum = /^\d+$/.test(q)
    if (pNum && qNum) {
      const d = Number(p) - Number(q)
      if (d !== 0) return d < 0 ? -1 : 1
      continue
    }
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/**
 * 启动时自动检测规则仓库是否有更新，并把「本地没有的」与「远端版本更高的」导入。
 *
 * 为什么按版本比对、而不是每次启动无脑重导一遍：
 *  导入是按**规则名**整体覆盖的（见 rulesRepoImport），而用户完全可能在导入后手工微调过某条规则
 *  （站点改版时这是最常用的应急手段：改一个 XPath 就能继续用）。若每次启动都无条件重导，
 *  这些手改会被静默冲掉 —— 用户只会看到「昨天改好的规则今天又坏了」。所以本地版本 ≥ 远端即视为
 *  「没有更新」直接跳过；只有远端真的更高（或本地根本没有这条）才落盘。
 *
 * 为什么失败必须静默（只写日志 + 状态，不弹框、不抛给调用方）：
 *  它是**启动路径上的后台任务**，而镜像/网络不可用是常态（大陆网络下 GitHub 直连常年不通，
 *  jsDelivr 也会偶发超时）。这不是用户刚刚触发的操作失败，没有任何需要用户决策的信息，
 *  弹错误框只会让「打开应用」变成一件会被打断的事。因此：全镜像失败 → 状态记 'failed'、写一条 warn 日志，
 *  然后正常返回（调用方是 setTimeout，抛出去就会变成没人接的 unhandledRejection）。
 *
 * 另注：内置规则（default- 前缀）由 ensureDefaultRules() 在每次启动时按内置定义恢复，
 * 因此对内置规则名的导入是「本会话生效、下次启动先被恢复再按版本重新判定」——
 * 版本门禁保证了只有仓库真的更高时才会付这一次网络与写盘成本。
 */
export async function rulesRepoAutoUpdate(): Promise<RulesRepoMeta> {
  const meta: RulesRepoMeta = {
    lastCheckAt: Date.now(),
    lastResult: 'failed',
    updated: [],
    failed: [],
    remoteTotal: 0
  }
  try {
    // 全镜像都取不到时 rulesRepoIndex() 会 throw，由下面的 catch 兜住
    const index = await rulesRepoIndex()
    meta.remoteTotal = index.length

    const local = store.get<PlayRule[]>('rules', [])
    /*
     * 本地匹配口径与 rulesRepoImport 保持一致（先按 id `repo-<小写name>`，再退回按名称），
     * 否则「用户改过 id 但名字相同」的规则会被当成"本地没有"，导入后又多出一条同名规则。
     */
    const findLocal = (name: string): PlayRule | undefined => {
      const id = `repo-${name.toLowerCase()}`
      return (
        local.find((r) => r.id === id) ??
        local.find((r) => r.name.toLowerCase() === name.toLowerCase())
      )
    }

    const pending: string[] = []
    for (const item of index) {
      if (!item?.name) continue
      const mine = findLocal(item.name)
      // 本地没有 → 新规则，导入
      if (!mine) {
        pending.push(item.name)
        continue
      }
      // 本地版本不低于远端 → 无更新，跳过（保护用户手改）
      if (compareRuleVersion(mine.version, item.version) >= 0) continue
      pending.push(item.name)
    }

    if (pending.length === 0) {
      meta.lastResult = 'latest'
      log.append(
        'info',
        'rules',
        `规则仓库自动检测：已是最新（远端 ${index.length} 条 / 本地 ${local.length} 条，无更新）`
      )
    } else {
      // rulesRepoImport 对每条规则单独 try/catch：某条拉取或解析失败只会进 failed，不影响其它条
      const r = await rulesRepoImport(pending)
      meta.failed = r.failed
      meta.updated = pending.filter((n) => !r.failed.includes(n))
      meta.lastResult = meta.updated.length > 0 ? 'updated' : 'failed'
      log.append(
        meta.updated.length > 0 ? 'info' : 'warn',
        'rules',
        `规则仓库自动检测：检出 ${pending.length} 条需更新（远端 ${index.length} 条）` +
          `，已更新 ${meta.updated.length} 条${meta.updated.length ? `（${meta.updated.join('、')}）` : ''}` +
          `，失败 ${meta.failed.length} 条${meta.failed.length ? `（${meta.failed.join('、')}）` : ''}`
      )
    }
  } catch (err) {
    // 静默降级：仅写日志与状态，绝不弹框、绝不影响启动
    meta.lastResult = 'failed'
    log.append('warn', 'rules', `规则仓库自动检测失败（已静默跳过，不影响启动）: ${String(err)}`)
  }
  // 状态落 store，规则页通过 api.store.get('rulesRepoMeta') 读取展示
  store.set('rulesRepoMeta', meta)
  return meta
}

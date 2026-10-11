import axios from 'axios'
import { createHash } from 'node:crypto'
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
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import { store } from '../store'
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

function toDoc(text: string): XDocWrapper {
  return xhtml.fromPageSource(text) as unknown as XDocWrapper
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

async function httpRequest(
  url: string,
  method: 'GET' | 'POST',
  headersJson: string,
  queryJson: string,
  bodyType: string
): Promise<string> {
  const headers = parseJsonObject(headersJson) as Record<string, string>
  const query = parseJsonObject(queryJson)
  const common = {
    timeout: 30000,
    responseType: 'text' as const,
    headers: { 'User-Agent': BROWSER_UA, ...headers },
    ...buildProxyAgents(getSettings().proxy)
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
  const res = await axios.get(finalUrl, common)
  return String(res.data ?? '')
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


export async function ruleSearch(ruleId: string, keyword: string): Promise<RuleSearchResult> {
  const rule = getRule(ruleId)
  if (!rule) return { items: [], error: '规则不存在' }
  const def = rule.search
  try {
    const url = fillTemplate(def.url, { keyword })
    // 查询参数 / 请求头中的 @keyword 占位同样需要替换
    const query = fillTemplate(def.query, { keyword })
    const headers = fillTemplate(def.headers, { keyword })
    const text = await httpRequest(url, def.method, headers, query, def.bodyType)
    const items: RuleSearchEntry[] = []
    if (def.type === 'xpath') {
      const doc = toDoc(text)
      const nodes = evalNodes(doc, def.listXPath)
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
    const e = err as { message?: string }
    const msg = `搜索失败 (${rule.name}): ${e?.message ?? String(err)}`
    log.append('warn', 'rules', msg)
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
  const def = rule.episodes
  try {
    const groups: RuleEpisodeGroup[] = []
    let vars: Record<string, string> = {}
    if (def.type === 'xpath') {
      const url = resolveUrl(rule.baseUrl, entry.link || entry.source)
      const text = await httpRequest(url, 'GET', '{}', '{}', '')
      const doc = toDoc(text)
      const linesXPath = def.linesXPath.trim()
      const mkEp = (a: HNode): RuleEpisode => ({
        name: nodeText(a),
        link: nodeAttr(a, 'href')
      })
      if (!linesXPath || linesXPath === '//') {
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
    const e = err as { message?: string }
    const msg = `选集解析失败 (${rule.name}): ${e?.message ?? String(err)}`
    log.append('warn', 'rules', msg)
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
   * ① 用户点名要内置的 AGE / sorani / aafun 一定存在且**启用**；
   * ② 内置内容随应用升级而更新（用户不用手动"恢复默认"）。
   * 用户自己加的、以及从仓库导入的规则（repo- / 其它 id）一律原样保留、顺序不动。
   */
  const builtin = DEFAULT_RULES.map((r) => ({ ...r, enabled: true }))
  const custom = rules.filter((r) => !r.id.startsWith('default-'))
  // 内置排最前：列表与搜索结果里这三条先出现（PINNED_RULES 也把它们置顶，两处一致）
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
    // 萌甸 EZDMW（m.ezdmw.org）：线路 XPath 里的 `//section[@class='anthology'][1]`
    // 在 XPath 1.0 里是「父节点下的第一个 section」而非「结果集第一个」，
    // 命中的是另一处 section → 线路恒为 0 条。改按线路按钮类名直取。
    // 剧集表达式是行内 `self::/following-sibling::` 轴写法，由 itemXPath/enhance 负责转义。
    match: /ezdmw\.org/i,
    version: '1.3-fix',
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

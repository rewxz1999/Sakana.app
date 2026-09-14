import axios from 'axios'
import { JSONPath } from 'jsonpath-plus'
import xhtml from 'xpath-html'
import type {
  PlayRule,
  RuleEpisode,
  RuleEpisodeGroup,
  RuleEpisodesDef,
  RuleEpisodesResult,
  RulePlayResult,
  RuleSearchDef,
  RuleSearchEntry,
  RuleSearchResult
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

export function resolveUrl(base: string, link: string): string {
  try {
    return new URL(link, base).toString()
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
        items.push({ name, link: '', source })
      }
    }
    // 纯 HTTP 抓不到（结果由 JS 渲染的站点，或站点偶发返回"加载中/安全验证"拦截页）
    // → 先重试一次 HTTP，再用真实浏览器窗口在页面内搜索
    if (items.length === 0) {
      await new Promise((r) => setTimeout(r, 800))
      try {
        const retryText = await httpRequest(url, def.method, headers, query, def.bodyType)
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
    return { items }
  } catch (err) {
    const e = err as { message?: string }
    const msg = `搜索失败 (${rule.name}): ${e?.message ?? String(err)}`
    log.append('warn', 'rules', msg)
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
    return { url }
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
  return { url: qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url }
}

/** 内置默认规则随应用更新（保留用户自定义规则，仅刷新 default- 前缀的内置规则） */
export function ensureDefaultRules(): void {
  const rules = store.get<PlayRule[]>('rules', [])
  const custom = rules.filter((r) => !r.id.startsWith('default-'))
  const next = [...custom, ...DEFAULT_RULES]
  if (JSON.stringify(next) !== JSON.stringify(rules)) {
    store.set('rules', next)
    log.append('info', 'rules', `内置播放规则已更新（${DEFAULT_RULES.length} 条）`)
  }
  repairStoredRules()
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
        ? { ...rule, id: existing.id, enabled: existing.enabled, createdAt: existing.createdAt }
        : { ...rule, id: `repo-${rule.name.toLowerCase()}`, createdAt: Date.now() }
      if (existing) {
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
  return { imported, failed }
}

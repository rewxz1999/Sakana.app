import axios, { type AxiosRequestConfig } from 'axios'
import { app, net } from 'electron'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { AppSettings, PlayRule, ProxyConfig } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { netQueue, type NetPriority } from './net-priority'
import { store } from './store'

/*
 * ───────── V1.1.1：证书错误兜底（用户报「AGE 突然搜不到番剧」的真因）─────────
 *
 * 现象：`[rules] 搜索失败 (AGE): unable to get local issuer certificate`，
 * 而同一时刻用系统自带的 curl 访问同一个地址是 **HTTP 200**。差异不在站点，在**信任库**：
 *   · curl / Chromium 用 **Windows 证书库** —— 用户开着带 MITM 的代理/VPN 时，
 *     站点证书由它的根证书签发，那张根证书已经装进系统库，所以它们照常访问；
 *   · node（axios 走的就是它）只认自己**内置的 CA 包**，系统库里多出来的根它一个都不认，
 *     于是同一个请求直接失败。规则引擎全在 node 这一侧，用户看到的就是"规则跑坏了"。
 *
 * 处理方式：**不关证书校验**（`rejectUnauthorized: false` 是把安全换成方便，不做），
 * 而是换一条**本来就信任系统证书的网络栈**（Electron 的 `net.fetch`，即 Chromium）把这次请求重试一次。
 * 只在这类证书错误上兜底，其它错误原样抛出，行为与以前完全一致。
 */
function isCertError(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? '')
  const msg = String((err as { message?: string })?.message ?? '')
  return (
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'CERT_SIGNATURE_FAILURE' ||
    /unable to (get|verify) (local issuer|leaf) certificate|self[- ]signed certificate/i.test(msg)
  )
}

let certFallbackInstalled = false

/** 注册全局兜底（幂等；在 net.ts 被 import 时装上即可，真正执行要等 app ready） */
export function installCertFallback(): void {
  if (certFallbackInstalled) return
  certFallbackInstalled = true
  axios.interceptors.response.use(undefined, async (err) => {
    const cfg = (err as { config?: AxiosRequestConfig & { params?: unknown } })?.config
    if (!cfg || !isCertError(err)) throw err
    try {
      // 把 axios 的 config 还原成一个真实 URL（params 要拼回去，否则搜索关键词会丢）
      const url = axios.getUri({ ...cfg, params: cfg.params as never })
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries((cfg.headers ?? {}) as Record<string, unknown>)) {
        if (v !== undefined && v !== null) headers[k] = String(v)
      }
      const method = String(cfg.method ?? 'get').toUpperCase()
      const body =
        cfg.data == null
          ? undefined
          : typeof cfg.data === 'string'
            ? cfg.data
            : JSON.stringify(cfg.data)
      if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json'
      }
      const r = await net.fetch(url, { method, headers, body })
      const text = await r.text()
      // 日志里只留「域名 + 路径」：查询串可能带搜索关键词等信息，没必要落盘
      console.warn(`[net] 证书不被 node 信任，改用 Chromium 网络栈重试成功：${method} ${url.split('?')[0]} → HTTP ${r.status}`)
      return { data: text, status: r.status, statusText: r.statusText, headers: {}, config: cfg, request: null }
    } catch (err2) {
      console.warn(`[net] 改用 Chromium 网络栈重试也失败：${String((err2 as Error)?.message ?? err2)}`)
      throw err
    }
  })
}

installCertFallback()

/*
 * ───────── v1.1.4：全应用分级网络（S / A / B）─────────
 *
 * 为什么挂在 axios 拦截器上：本应用真正发网络请求的模块有十几个
 * （bangumi / 规则 / 弹幕 / galgame / mikan / 更新…），逐个改调用点既容易漏，
 * 也无法形成统一的并发上限。这里在所有 axios 请求进入 adapter 之前排队，
 * 调用点只要**愿意**就可以写 `netPriority` 显式分级；没写的按 URL 自动归类：
 *   · 本机服务（qbit / aria2 / 直播中转）→ 不排队（它们不是外网带宽，排队只会卡自己的 RPC）；
 *   · 自建反代 / 公共镜像 / 规则站点 → S；其中搜索路径是 B（用户明确要求）；
 *   · Jikan / AniList / 蜜柑 / 弹幕 / galgame 等其余外网 → A。
 *
 * 注意：这里只**限流**，不改任何请求的地址、超时、重试与响应处理 ——
 * 出问题时可以单独关掉（删掉 installNetworkPriority() 调用）而不影响其余逻辑。
 */
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])$/i

/** 分类结果里带一个不含主机名的标签，日志/诊断只用它 */
interface NetTag {
  level: NetPriority
  tag: string
}

/** 从 URL 取 hostname（相对地址返回空串） */
function hostOf(url: string): string {
  try {
    return new URL(url, 'http://local').hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 只保留 pathname 的日志标签：绝不把主机名写进日志（红线） */
function pathLabel(url: string): string {
  try {
    const p = new URL(url, 'http://local').pathname.replace(/\/+$/, '') || '/'
    return p.length > 72 ? `${p.slice(0, 68)}…` : p
  } catch {
    return '请求'
  }
}

/** 设置里配置的数据源主机（自建反代 + 公共镜像）。缓存 5 秒，避免每个请求都深拷贝设置。 */
let sourceHostCache: { at: number; hosts: Set<string> } | null = null
function sourceHosts(): Set<string> {
  if (sourceHostCache && Date.now() - sourceHostCache.at < 5000) return sourceHostCache.hosts
  const s = getSettings()
  const hosts = new Set<string>()
  for (const m of [s.bangumiCustomApi, ...(s.bangumiMirrors ?? []), s.bangumiBase]) {
    const h = hostOf(String(m ?? '').trim())
    if (h) hosts.add(h)
  }
  sourceHostCache = { at: Date.now(), hosts }
  return hosts
}

/** 用户启用的规则站点主机（规则取站点资源属于 S 级）。缓存 10 秒，规则不会秒变。 */
let ruleHostCache: { at: number; hosts: Set<string> } | null = null
function ruleHosts(): Set<string> {
  if (ruleHostCache && Date.now() - ruleHostCache.at < 10000) return ruleHostCache.hosts
  const hosts = new Set<string>()
  try {
    const rules = store.get<PlayRule[]>('rules', [])
    for (const rule of Array.isArray(rules) ? rules : []) {
      if (!rule?.enabled) continue
      for (const raw of [rule.baseUrl, rule.search?.url]) {
        const h = hostOf(String(raw ?? ''))
        if (h) hosts.add(h)
      }
    }
  } catch {
    /* 规则读不出来时退化为默认 A 级，不影响请求本身 */
  }
  ruleHostCache = { at: Date.now(), hosts }
  return ruleHostCache.hosts
}

function classifyRequest(config: AxiosRequestConfig): NetTag | null {
  const url = String(config.url ?? '')
  const host = hostOf(url)
  // 本机服务不占用外网优先级额度（qbit/aria2 的轮询很频繁，混进来会把 A 级占满）
  if (host && LOCAL_HOST.test(host)) return null
  if (config.netPriority) return { level: config.netPriority, tag: config.netTag ?? pathLabel(url) }
  if (!host) return { level: 'A', tag: config.netTag ?? '请求' }
  if (sourceHosts().has(host)) {
    // 搜索/建议：用户明确划为 B 级（可以等，不该挤占番剧数据与播放资源）
    if (/\/search|subject_search/i.test(url)) return { level: 'B', tag: '搜索' }
    return { level: 'S', tag: config.netTag ?? pathLabel(url) }
  }
  if (ruleHosts().has(host)) return { level: 'S', tag: config.netTag ?? '规则站点' }
  return { level: 'A', tag: config.netTag ?? pathLabel(url) }
}

let priorityNetworkInstalled = false

/** 安装全局分级队列（幂等）。在 net.ts 被 import 时装上，第一条请求前就生效。 */
export function installNetworkPriority(): void {
  if (priorityNetworkInstalled) return
  priorityNetworkInstalled = true

  /** 请求 config → 槽位释放函数。WeakMap 让失败/取消的请求也不会漏掉（config 被回收即消失） */
  const held = new WeakMap<object, () => void>()
  const release = (config: unknown): void => {
    if (!config || typeof config !== 'object') return
    const fn = held.get(config)
    if (!fn) return
    held.delete(config)
    fn()
  }

  axios.interceptors.request.use(async (config) => {
    const meta = classifyRequest(config)
    if (!meta) return config
    // 信号透传：请求被取消时把它从排队里摘掉，别占着位置等一个已经没人要的结果
    const signal = (config.signal ?? undefined) as AbortSignal | undefined
    const fn = await netQueue.acquire(meta.level, meta.tag, signal)
    held.set(config, fn)
    return config
  })

  axios.interceptors.response.use(
    (res) => {
      release(res.config)
      return res
    },
    (err) => {
      release((err as { config?: unknown })?.config)
      return Promise.reject(err)
    }
  )
}

installNetworkPriority()

/*
 * UA 里的版本号从 `app.getVersion()` 取（v0.3.9 体检 L5）。
 * 以前这里是写死的 '0.1.0'，而同项目里 jikan 写 '0.3.0'、弹幕接口写 '0.2.8' ——
 * 三处各说各的版本，对端做统计/风控时看到的是三个"不同版本的应用"，排障时也会误导。
 */
export const UA = `Sakana/${app.getVersion()} (anime desktop client; +https://github.com/sakana)`

/** 浏览器 UA：bangumi.pro 等镜像站有 Cloudflare 防护，非浏览器 UA 会被 403 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/**
 * 蜜柑计划的基础域名（v0.3.3 从 mikan.ts 挪到这里，供 mikan.ts 与 mikanFeed.ts 共用一份）。
 *
 * 为什么要挪：官方订阅 RSS（`RSS/Bangumi?bangumiId=…&subgroupid=…`）的解析在 mikanFeed.ts、
 * 搜索 RSS 在 mikan.ts，两边各写一份域名常量迟早漂移（蜜柑主站 mikanani.me 直连不通，
 * 真要换镜像站时漏改一处就会整个订阅链路失效）。这里做成**实时读**的 getter：
 * 模块初始化时由 mikan.ts 调用一次 setFeedBase 对齐，之后所有 URL 都取当前值。
 */
let feedBase = 'https://mikanani.kas.pub'

export function setFeedBase(base: string): void {
  if (base) feedBase = String(base).replace(/\/+$/, '')
}

export function getFeedBase(): string {
  return feedBase
}

/** 读取设置（带默认值深度合并，防止旧版本设置缺字段） */
export function getSettings(): AppSettings {
  const s = store.get<Partial<AppSettings>>('settings', {})
  const proxy = { ...DEFAULT_SETTINGS.proxy, ...(s.proxy ?? {}) }
  const aria2 = { ...DEFAULT_SETTINGS.downloader.aria2, ...(s.downloader?.aria2 ?? {}) }
  const qbit = { ...DEFAULT_SETTINGS.downloader.qbit, ...(s.downloader?.qbit ?? {}) }
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    proxy,
    downloader: { ...DEFAULT_SETTINGS.downloader, ...(s.downloader ?? {}), aria2, qbit }
  }
}

/** 按代理设置构造 axios agent（http / socks5 均支持） */
export function buildProxyAgents(proxy: ProxyConfig): Partial<AxiosRequestConfig> {
  if (!proxy?.enabled || !proxy.host) return {}
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : ''
  const url = `${proxy.type}://${auth}${proxy.host}:${proxy.port}`
  try {
    const agent =
      proxy.type === 'socks5' ? new SocksProxyAgent(url) : new HttpsProxyAgent(url)
    return { httpAgent: agent, httpsAgent: agent }
  } catch (err) {
    console.error('[net] 代理配置无效:', err)
    return {}
  }
}

/**
 * 把应用代理设置应用到 Electron 会话（网页视图 / 嗅探窗口 / 图片协议都走它）。
 * 之前只有 axios 请求走代理，导致"HTTP 能取到、网页视图却 ERR_TIMED_OUT"。
 */
export function applySessionProxy(ses: Electron.Session): void {
  const proxy = getSettings().proxy
  try {
    if (proxy.enabled && proxy.host) {
      const auth =
        proxy.username && proxy.password
          ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
          : ''
      const rules =
        proxy.type === 'socks5'
          ? `socks5://${auth}${proxy.host}:${proxy.port}`
          : `${proxy.type}://${auth}${proxy.host}:${proxy.port}`
      void ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
      console.log(`[net] 会话代理已启用: ${proxy.type}://${proxy.host}:${proxy.port}`)
    } else {
      void ses.setProxy({ mode: 'direct' })
    }
  } catch (err) {
    console.error('[net] 会话代理设置失败:', err)
  }
}

export async function httpGetText(
  url: string,
  timeoutMs = 12000,
  extra: Partial<AxiosRequestConfig> = {}
): Promise<string> {
  const res = await axios.get(url, {
    timeout: timeoutMs,
    responseType: 'text',
    headers: { 'User-Agent': UA, Accept: '*/*', ...(extra.headers ?? {}) },
    ...buildProxyAgents(getSettings().proxy),
    ...extra
  })
  return res.data as string
}

export async function httpGetBuffer(
  url: string,
  timeoutMs = 30000
): Promise<Buffer> {
  const res = await axios.get(url, {
    timeout: timeoutMs,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': UA },
    ...buildProxyAgents(getSettings().proxy)
  })
  return Buffer.from(res.data as ArrayBuffer)
}

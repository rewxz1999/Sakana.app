import axios, { type AxiosRequestConfig } from 'axios'
import { app, net } from 'electron'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { AppSettings, ProxyConfig } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
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

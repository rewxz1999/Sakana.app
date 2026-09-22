import axios, { type AxiosRequestConfig } from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { AppSettings, ProxyConfig } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { store } from './store'

export const UA = 'Sakana/0.1.0 (anime desktop client; +https://github.com/sakana)'

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

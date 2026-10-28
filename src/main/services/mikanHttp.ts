import axios from 'axios'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import { log } from '../log'

/**
 * 蜜柑（mikan）请求的统一入口（V1.5.2）。
 *
 * 用户反馈：「访问蜜柑进行搜索时容易发生超时，建议也使用嗅探模块的一些策略，减少流量限制。」
 *
 * 这里把「嗅探/取流加速」里验证有效的几条策略搬过来（不涉及代理池，只做零成本的部分）：
 *   1. **请求头伪装**：补齐真实浏览器会带的 Accept / Accept-Language / Referer / Sec-Fetch-*。
 *      很多站点/CF 规则对"只有 UA 的裸请求"更严格，补齐这几个头能显著降低被降速/挑战的概率；
 *   2. **指数退避 + 抖动重试**：429 / 5xx / 连接重置才重试（2 次，0.4s / 1.2s + 随机抖动），
 *      403/404 不重试（重试也没用，只会增加请求数）；
 *   3. **单飞（single-flight）**：同一 URL 在途时只发一条请求，多个调用方共享同一个 Promise ——
 *      订阅检查会对同一部番连发多个搜索，这一条能把请求数直接砍半；
 *   4. **短 TTL 结果缓存（60 秒）**：切页/重试/开两个窗口都会重复问同一个关键词，
 *      60 秒内直接复用，不占站点配额；
 *   5. **请求前随机延迟 0–150ms**：避免同一时刻批量打出去（与"泊松分布模拟人类间隔"同一思路的小号版本）。
 *
 * 不做代理池：需要用户自备代理，而应用已有全局代理设置（`settings.proxy`，这里同样生效）。
 * 日志只写主机名与状态码，不打印完整 URL（与项目红 line 一致）。
 */

/** 结果缓存 TTL：60 秒足够覆盖"切页/重试/多窗口"的重复请求，又不会让用户看到过期列表 */
const CACHE_TTL_MS = 60_000
/** 同一 URL 的最大尝试次数（含首次） */
const MAX_ATTEMPTS = 3
/** 退避基数：第 n 次重试等 base * 2^(n-1) + 抖动 */
const BACKOFF_BASE_MS = 400
const BACKOFF_JITTER_MS = 350
/** 单次请求超时：蜜柑的搜索/番剧页都在 1s 内返回，12s 已经是很宽的上限 */
const REQUEST_TIMEOUT_MS = 12_000
/** 结果缓存上限（防止长时间运行后无限增长） */
const MAX_CACHE_ENTRIES = 80

interface CacheEntry {
  at: number
  text: string
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<string>>()

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'mikan'
  }
}

/** 主机名 + 路径开头（不含查询串）：日志里能定位是哪个接口，又不会把关键词/令牌打出来 */
function safeLabel(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return 'mikan'
  }
}

/** 是否值得重试：只有"一过性"的失败才重试，4xx（除 429/408）一律不重试 */
function shouldRetry(err: unknown, status?: number): boolean {
  if (status && status >= 400) return status === 408 || status === 429 || status >= 500
  const e = err as { code?: string; message?: string }
  const s = `${e?.code ?? ''} ${e?.message ?? ''}`
  return /ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|timeout|aborted|ERR_NETWORK|ERR_CONNECTION/i.test(
    s
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 浏览器风格请求头（伪装部分集中在这里，搜索与订阅解析共用同一份） */
function browserHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
  }
  try {
    const origin = new URL(url).origin
    headers.Referer = `${origin}/`
    headers.Origin = origin
  } catch {
    /* URL 不合法时不写 Referer/Origin */
  }
  return headers
}

/** 清理过期缓存（懒清理：每次写入时顺手看一遍） */
function pruneCache(): void {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (now - entry.at > CACHE_TTL_MS) cache.delete(key)
  }
  // 还是太多时，删最旧的（Map 的插入顺序 ≈ 时间顺序）
  while (cache.size > MAX_CACHE_ENTRIES) {
    const first = cache.keys().next().value
    if (!first) break
    cache.delete(first)
  }
}

/**
 * GET 一个蜜柑页面/RSS，返回文本。
 *
 * 失败时抛出原始错误（调用方各自决定"搜索失败返回空列表"还是"解析失败回落"），
 * 但错误信息里**不包含完整 URL**（避免关键词/地址进日志）。
 */
export async function mikanGetText(url: string, tag = 'mikan'): Promise<string> {
  // 1) 短 TTL 缓存
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at <= CACHE_TTL_MS) return hit.text
  // 2) 单飞
  const existing = inflight.get(url)
  if (existing) return existing

  const p = (async (): Promise<string> => {
    const label = safeLabel(url)
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 请求前随机延迟：避免多个候选同时打出去（同一时刻的批量请求最容易被限速）
      if (attempt > 1 || Math.random() < 0.5) {
        await sleep(Math.random() * 150)
      }
      try {
        const res = await axios.get(url, {
          timeout: REQUEST_TIMEOUT_MS,
          responseType: 'text',
          // 媒体/文本都别让 axios 自动解压成"字节数对不上"的东西；gzip 文本由服务端协商
          validateStatus: () => true,
          headers: browserHeaders(url),
          ...buildProxyAgents(getSettings().proxy)
        })
        const status = res.status
        if (status >= 200 && status < 300) {
          const text = String(res.data ?? '')
          cache.set(url, { at: Date.now(), text })
          pruneCache()
          if (attempt > 1) {
            log.append('info', tag, `${label} 第 ${attempt} 次尝试成功（HTTP ${status}）`)
          }
          return text
        }
        lastErr = new Error(`HTTP ${status}`)
        if (!shouldRetry(null, status)) break
        log.append('warn', tag, `${label} 返回 HTTP ${status}（第 ${attempt}/${MAX_ATTEMPTS} 次），准备重试`)
      } catch (err) {
        lastErr = err
        const msg = String((err as { message?: string })?.message ?? err)
        if (!shouldRetry(err)) {
          log.append('warn', tag, `${label} 请求失败且不值得重试：${msg.slice(0, 120)}`)
          break
        }
        log.append('warn', tag, `${label} 请求失败（第 ${attempt}/${MAX_ATTEMPTS} 次）：${msg.slice(0, 120)}`)
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.random() * BACKOFF_JITTER_MS)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`请求失败：${safeLabel(url)}`)
  })().finally(() => {
    inflight.delete(url)
  })

  inflight.set(url, p)
  return p
}

/** 诊断/自检用：当前缓存与在途请求数量 */
export function mikanHttpStats(): { cached: number; inflight: number } {
  return { cached: cache.size, inflight: inflight.size }
}

/** 清空缓存（切换代理/数据源后由设置页或自检调用） */
export function clearMikanHttpCache(): void {
  cache.clear()
}

/** 仅供日志/自检使用：主机名（不含地址细节） */
export function mikanHostOf(url: string): string {
  return hostOf(url)
}

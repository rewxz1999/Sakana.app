import axios, { type AxiosRequestConfig } from 'axios'
import http from 'node:http'
import https from 'node:https'
import { app, net } from 'electron'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { AppSettings, ProxyConfig } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { netQueue } from './net-priority'
import { store } from './store'
import { recordTraffic, trafficSourceOfUrl } from './services/traffic'

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
 * ───────── 全局网络并发闸门（分级已废弃）─────────
 *
 * 为什么挂在 axios 拦截器上：本应用真正发网络请求的模块有十几个
 * （bangumi / 规则 / 弹幕 / galgame / mikan / 更新…），逐个改调用点既容易漏，
 * 也无法形成统一的并发上限。这里在所有 axios 请求进入 adapter 之前排队。
 *
 * 用户已经明确取消 S/A/B 分级，所以这里**不再按 URL 判断重要性**：
 *   · 所有外网请求同一条 FIFO 队列，只受 `net-priority` 里的全局并发上限约束；
 *   · 调用点写 `netPriority` 也不会改变行为（字段仅为兼容保留）；
 *   · `netTag` 仍然有用：它是日志/诊断里**不含主机名**的接口标签；
 *   · `netBypass` 保留：播放中的媒体流不排队，这是硬隔离而不是优先级；
 *   · 本机服务（qbit / aria2 / 直播中转）不排队 —— 它们不是外网带宽，
 *     排进队列只会卡住自己的 RPC，与"谁重要"无关。
 *
 * 注意：这里只**限流**，不改任何请求的地址、超时、重试与响应处理 ——
 * 出问题时可以单独关掉（删掉 installNetworkPriority() 调用）而不影响其余逻辑。
 */
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])$/i

/** 分类结果里带一个不含主机名的标签，日志/诊断只用它 */
interface NetTag {
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

function classifyRequest(config: AxiosRequestConfig): NetTag | null {
  /*
   * 播放链路显式要求绕过队列（见 net-priority 的 netBypass 说明）。
   * 必须在所有判断之前返回：这类请求是用户正在等的那一路流，
   * 排在普通外网请求后面就可能让播放器拿到列表时已经超时。
   */
  if (config.netBypass) return null
  const url = String(config.url ?? '')
  const host = hostOf(url)
  // 本机服务不占用外网并发额度（qbit/aria2 的轮询很频繁，混进来会把额度占满）
  if (host && LOCAL_HOST.test(host)) return null
  // `netPriority` 已废弃：这里只取标签，传不传级别都不影响排队顺序
  return { tag: config.netTag ?? pathLabel(url) }
}

let networkGateInstalled = false

/** 安装全局并发闸门（幂等）。在 net.ts 被 import 时装上，第一条请求前就生效。 */
export function installNetworkPriority(): void {
  if (networkGateInstalled) return
  networkGateInstalled = true

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
    const fn = await netQueue.acquire(meta.tag, signal)
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
 * ───────── 数据源流量监控（V1.5.3）─────────
 *
 * 为什么挂在 axios 拦截器上：应用里真正出外网的模块有十几个（规则 / 蜜柑 / 弹幕 / galgame /
 * 在线源…），逐个加统计既容易漏，也无法保证"同一个口径"。这里在响应回来时按 URL 归类并记账，
 * 与并发闸门共用同一份 config，不改任何请求行为。
 *
 * 两条边界：
 *   · 本机地址（aria2 / qbit / 本地中转）不算外网流量，直接跳过；
 *   · bangumi 那条链路的字节数已经由 `beginNetTrace` 按精确值记过了（见 net-priority），
 *     这里按「分类结果是番剧数据」跳过，避免同一次请求算两遍。
 */
function bytesFromHeaders(headers: unknown): number {
  const h = headers as Record<string, unknown> | undefined
  const raw = h?.['content-length'] ?? h?.['Content-Length']
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function bytesFromBody(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf-8')
  if (Buffer.isBuffer(data)) return data.length
  if (data instanceof ArrayBuffer) return data.byteLength
  if (data && typeof data === 'object') {
    try {
      return Buffer.byteLength(JSON.stringify(data), 'utf-8')
    } catch {
      return 0
    }
  }
  return 0
}

/** 记录一次非 bangumi 的请求（bangumi 走 beginNetTrace，避免重复计数） */
function recordAxiosTraffic(url: string, bytes: number, errors = 0): void {
  const source = trafficSourceOfUrl(url)
  if (source === 'bangumi') return
  recordTraffic({ source, bytes, requests: 1, errors })
}

function installTrafficRecorder(): void {
  axios.interceptors.response.use(
    (res) => {
      const url = String(res.config?.url ?? '')
      const host = hostOf(url)
      if (!url || LOCAL_HOST.test(host)) return res
      const declared = bytesFromHeaders(res.headers)
      const stream = res.data as
        | (NodeJS.ReadableStream & { emit?: (event: string, ...args: unknown[]) => boolean })
        | undefined
      /*
       * 流式响应（播放链路的分片 / 边下边播）不能加 `data` 监听器 ——
       * 那会把流切到 flowing 模式，调用方还没读到就被吞掉。这里改写 `emit` 旁听：
       * 事件照旧发给真正的消费者，我们只顺带累加字节数。
       */
      if (stream && typeof stream.on === 'function' && typeof stream.emit === 'function') {
        let received = 0
        let done = false
        const original = stream.emit.bind(stream)
        const finish = (failed: boolean): void => {
          if (done) return
          done = true
          recordAxiosTraffic(url, received || declared, failed ? 1 : 0)
        }
        stream.emit = (event: string, ...args: unknown[]): boolean => {
          if (event === 'data' && args[0]) {
            const chunk = args[0] as { length?: number }
            received += typeof chunk.length === 'number' ? chunk.length : 0
          } else if (event === 'end' || event === 'close') {
            finish(false)
          } else if (event === 'error') {
            finish(true)
          }
          return original(event, ...args)
        }
        // 响应头里就有准确长度且调用方可能提前 destroy（不会触发 end）：先按头记账，后面不再重复
        if (declared > 0) {
          done = true
          recordAxiosTraffic(url, declared)
        }
        return res
      }
      recordAxiosTraffic(url, declared || bytesFromBody(res.data))
      return res
    },
    (err) => {
      const cfg = (err as { config?: { url?: string } })?.config
      const url = String(cfg?.url ?? '')
      const host = hostOf(url)
      if (url && !LOCAL_HOST.test(host)) recordAxiosTraffic(url, 0, 1)
      return Promise.reject(err)
    }
  )
}

installTrafficRecorder()

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

/**
 * 全局 keep-alive agent（V1.2.1）。
 *
 * 为什么必须有：真机实测自建反代的 TLS 握手 **1~8.7 秒**、首字节 5~32 秒（`curl -w` 三段计时，
 * 同一台机器三次请求里第三次连建连都挂死）。node 默认每个请求新开连接，
 * 于是**每一条** bangumi 请求都要再付一次 1~8.7 秒的握手 —— 这就是"点一下等半天"的主要来源。
 * 复用连接后，握手只在第一批请求上付一次，后续请求直接走已建立的 TLS 会话。
 *
 * 数值取舍：
 *   · keepAliveMsecs=30s：与常见的 CDN 空闲回收（60~120s）留出余量，又不至于抱着死连接不放；
 *   · maxSockets=16：S(4)+A(2)+B(3) 的上限之和是 9，留一倍余量给规则嗅探/弹幕这类直连请求；
 *   · maxFreeSockets=8：空闲连接不无限留，避免反代那边已经掐了我们还留着。
 */
const keepAliveHttps = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 16,
  maxFreeSockets: 8,
  timeout: 60_000
})
const keepAliveHttp = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 16,
  maxFreeSockets: 8
})

/** 给调用方拿一份 keep-alive agent（未启用代理时用；启用了代理则走代理 agent） */
export function buildKeepAliveAgents(): Partial<AxiosRequestConfig> {
  return { httpAgent: keepAliveHttp, httpsAgent: keepAliveHttps }
}

export interface StreamGetOptions {
  /** 整轮硬上限（毫秒） */
  timeoutMs?: number
  headers?: Record<string, string>
  /** 只用于日志统计 */
  netTag?: string
  /** buildProxyAgents() 的返回值，原样展开进 axios 配置 */
  agents?: Partial<AxiosRequestConfig>
  /**
   * 响应是 JSON：空闲收尾前先校验能否解析，解析不过就继续等（防止半截 JSON）。
   * 见 `idleFinish` 的注释（真机踩过 Truncated JSON）。
   */
  requireJson?: boolean
}

/**
 * 流式 GET 文本，**内容到齐就收尾**，不等连接关闭（V1.5）。
 *
 * 为什么必须有它：我们的两个自建反代（Cloudflare Worker）在真机上的表现是
 *   · 首字节 3.6~9.9 秒就来了；
 *   · 但 `total` 永远等于客户端设的超时上限，正文其实已经收齐（6.8KB / 15KB / 173KB 都有）。
 * 也就是**响应体不结束**（没有 Content-Length、连接不 close）。
 * axios 的 `timeout` 是按"整轮结束"算的，于是每个请求都要耗满超时，再叠加重试与排队 ——
 * 一屏番剧表能被拖到几分钟，日志里就是「HTTP 200 73.8KB 49844ms（在途 29；排队 21）」。
 *
 * 判定：收到首个数据块后 **3 秒没有新数据**即视为响应完整并返回已收内容
 * （3 秒是实测的经验值：服务端两次 flush 之间偶有 1~2 秒空档，取 1.5 秒会截断正文）。
 * 正常结束的响应仍走同一条 resolve 路径，行为不变。
 */
export async function streamGetText(url: string, opts: StreamGetOptions = {}): Promise<string> {
  /*
   * 硬上限 35s（比 BANGUMI_TIMEOUT=22s 宽）。
   *
   * 实测：季度检索的响应体可以到 326KB，数据一直在流、只是慢（每次 chunk 间隔 <3s，空闲判定不触发），
   * 22 秒会把它判死 → 触发"换端点重试"，总耗时反而变成 40~80 秒。
   * 空闲 3 秒才是"没数据了"的判据；这里的硬上限只用来兜住真正挂死的连接。
   */
  const timeoutMs = opts.timeoutMs ?? 20_000
  const idleMs = 3_000
  const res = await axios.get(url, {
    timeout: timeoutMs,
    responseType: 'stream',
    headers: opts.headers ?? {},
    ...(opts.netTag ? { netTag: opts.netTag } : {}),
    ...(opts.agents ?? {})
  } as AxiosRequestConfig)
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  const stream = res.data as NodeJS.ReadableStream & { destroy?: () => void }
  /**
   * 服务端给了 `Content-Length` 就**按字节数收尾**（V1.5.2）。
   *
   * 这是最准的判定：Worker 现在会带 Content-Length，收到够数立刻结束，
   * 不必等连接 close、也不靠"空闲 3 秒"去猜 —— 后者在 300KB 的季度响应上会误判：
   * 要么截断成半截 JSON（日志里的 Unterminated string），要么苦等到 35 秒硬上限（更慢）。
   */
  const declared = Number(res.headers['content-length'] ?? 0)
  const expectBytes = Number.isFinite(declared) && declared > 0 ? declared : 0
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
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
    const hard = setTimeout(() => finish(new Error(`流式接收超过 ${timeoutMs / 1000}s`)), timeoutMs)
    /**
     * 空闲到点时的收尾判定（V1.5.1）。
     *
     * 真机踩到的坑：`/calendar` 的响应有 80KB，服务端两次 flush 之间偶尔超过 3 秒，
     * 空闲判定就把它当成"传完了"，结果是**半截 JSON**：
     *   `Unterminated string in JSON at position 13711` / `Bad Unicode escape at position 17341`
     * 比慢更糟 —— 数据直接不可用。
     *
     * 所以：`requireJson` 时先尝试解析，**解析得过才收尾**；解析不过就继续等
     * （要么后续数据到了、要么连接 end、要么撞 35 秒硬上限）。
     * 服务端已经把 `Content-Length` 正确带上了，正常情况下 'end' 会立刻触发，走不到这里。
     */
    const idleFinish = (): void => {
      if (opts.requireJson) {
        const text = Buffer.concat(chunks).toString('utf-8')
        try {
          JSON.parse(text)
        } catch {
          // 还没收全：继续等下一个数据块或 end；不在这里收尾
          return
        }
      }
      finish()
    }
    const bump = (): void => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(idleFinish, idleMs)
    }
    stream.on('data', (c: Buffer) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
      chunks.push(buf)
      received += buf.length
      // 有了 Content-Length：收够就立刻收尾（最准，且不依赖连接关闭）
      if (expectBytes > 0 && received >= expectBytes) {
        finish()
        return
      }
      bump()
    })
    stream.on('end', () => finish())
    stream.on('error', (e: Error) => finish(e))
  })
}

/**
 * 用 **Chromium 的网络栈**取文本（V1.2.2）。
 *
 * 为什么需要它：用户实测「同一个反代地址在浏览器里打得开」，而 node 这边不断超时/被重置
 * （`curl` 三次里两次失败，TLS 握手 1~8.7 秒）。两者的差别不在服务端，而在**客户端这一侧**：
 * Chromium 用 HTTP/2 + 自己的 TLS 指纹与连接池，node 的 https 模块在这些中间设备上更容易被掐。
 * 所以当 node 这条路失败时，改走 Electron 的 `net.fetch`（就是 Chromium 的那套栈）再试一次 ——
 * 这不是"绕过安全校验"，只是换一条同样受系统证书约束的 HTTP 实现。
 *
 * @param timeoutMs 超时（毫秒）；到点用 AbortController 中断，不留悬挂请求
 */
export async function chromiumGetText(
  url: string,
  timeoutMs = 12_000,
  headers: Record<string, string> = {}
): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await net.fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { Accept: '*/*', ...headers }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    /*
     * 流量记账：Chromium 这条栈的字节数不走 axios 拦截器。
     * bangumi 的调用点外面还包着 `beginNetTrace`（那里已经有精确字节），这里跳过以免算两遍。
     */
    if (trafficSourceOfUrl(url) !== 'bangumi') {
      recordTraffic({ source: trafficSourceOfUrl(url), bytes: Buffer.byteLength(text, 'utf-8'), requests: 1 })
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 系统代理（V1.5.2 修复「danmu_api 全部超时」）。
 *
 * 现象：用户在系统里开了代理（Clash 之类），浏览器能打开 danmu_api，但应用里所有弹幕请求
 * `timeout of 12000ms exceeded`。原因不是接口慢，而是**应用默认直连**：
 * axios 走 Node HTTP，不会自动使用 Windows 的 Internet 设置；`applySessionProxy` 在
 * 「应用代理未启用」时还显式关了 Chromium 的代理。
 *
 * 这里在**应用代理未启用**时探测一次系统代理（环境变量优先，其次 Windows 注册表
 * `HKCU\...\Internet Settings` 的 ProxyEnable/ProxyServer），只用于**境外接口**
 * （见 `proxyForUrl`），国内站点仍走直连 —— 避免给所有人都套上代理。
 *
 * 缓存 5 分钟：注册表可能被代理软件随时改，但没必要每个请求都起一次 reg.exe。
 */
let sysProxyCache: { at: number; cfg: ProxyConfig | null } | null = null

export function systemProxyConfig(): ProxyConfig | null {
  const now = Date.now()
  if (sysProxyCache && now - sysProxyCache.at < 5 * 60 * 1000) return sysProxyCache.cfg
  let cfg: ProxyConfig | null = null
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  const fromEnv = (raw: string): ProxyConfig | null => {
    try {
      const u = new URL(raw.includes('://') ? raw : `http://${raw}`)
      if (!u.hostname || !u.port) return null
      return {
        enabled: true,
        type: u.protocol.startsWith('socks') ? 'socks5' : 'http',
        host: u.hostname,
        port: Number(u.port),
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || '')
      }
    } catch {
      return null
    }
  }
  if (env) cfg = fromEnv(env)
  if (!cfg && process.platform === 'win32') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      )
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)
      if (enabled) {
        const m = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(out)
        const raw = String(m?.[1] ?? '').trim()
        if (raw) {
          // 可能是 "http=host:port;https=host:port" 或单个 "host:port"
          const parts = raw.split(';')
          const https = parts.find((p) => /^https=/i.test(p))
          const http = parts.find((p) => /^http=/i.test(p)) ?? parts[0]
          const chosen = (https ?? http ?? '').replace(/^https?=/i, '').trim()
          cfg = fromEnv(chosen)
        }
      }
    } catch {
      /* 读不到注册表就当没有系统代理 */
    }
  }
  if (cfg) {
    /*
     * 把系统代理写进进程环境变量。
     *
     * 为什么必须这样做：uosc_danmaku 插件取弹幕用的是**外部 curl 子进程**
     * （`mp.command_native_async({name:'subprocess', args={'curl', ...}})`），
     * mpv 的 `--http-proxy` 对它无效；而 curl 认 `http_proxy/https_proxy`。
     * 设成环境变量后，子进程会继承 —— 插件里的自动匹配与手动搜索才能连上 danmu_api。
     * `NO_PROXY` 排除本机（本应用的缓存服务器 / 本地文件），避免自己代理自己。
     */
    const url = `http://${cfg.host}:${cfg.port}`
    for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
      if (!process.env[k]) process.env[k] = url
    }
    if (!process.env.NO_PROXY && !process.env.no_proxy) {
      process.env.NO_PROXY = '127.0.0.1,localhost,::1'
    }
    console.log(`[net] 检测到系统代理（应用代理未启用），境外接口将经它转发：${cfg.host}:${cfg.port}`)
  }
  sysProxyCache = { at: now, cfg }
  return cfg
}

/** 这些域名/后缀的请求视为「境外接口」，应用代理未启用时允许走系统代理 */
const FOREIGN_HOST_SUFFIXES = [
  '.vercel.app',
  'api.dandanplay.net',
  'graphql.anilist.co',
  'api.jikan.moe',
  'kitsu.io',
  'allanime.day',
  'allmanga.to',
  'animepahe.ru',
  'kwik.cx',
  'cdn.jsdelivr.net',
  'raw.githubusercontent.com',
  'api.github.com'
]

function isForeignHost(host: string): boolean {
  const h = host.toLowerCase()
  return FOREIGN_HOST_SUFFIXES.some((s) => (s.startsWith('.') ? h.endsWith(s) : h === s))
}

/**
 * 针对具体 URL 选代理：应用设置优先；未启用时，**只有境外接口**才用系统代理。
 * 这样 danmu_api / AniList / Jikan 能用上用户开的代理，蜜柑与国内反代仍直连。
 */
export function proxyForUrl(url: string): ProxyConfig {
  const p = getSettings().proxy
  if (p?.enabled && p.host) return p
  try {
    const host = new URL(url).hostname
    if (isForeignHost(host)) {
      const sys = systemProxyConfig()
      if (sys) return sys
    }
  } catch {
    /* URL 解析失败就按设置来 */
  }
  return p
}

/** 按代理设置构造 axios agent（http / socks5 均支持） */
export function buildProxyAgents(proxy: ProxyConfig): Partial<AxiosRequestConfig> {
  if (!proxy?.enabled || !proxy.host) return buildKeepAliveAgents()
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
    return buildKeepAliveAgents()
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
      /*
       * V1.5.2：应用代理未启用时，不再强制 direct —— 跟随**系统代理**。
       * 用户开 Clash 之类的系统代理时，Chromium 本来就会走它；显式 direct 会让网页侧
       * 与 axios 侧表现不一致（浏览器能开 danmu_api、应用里却超时）。
       */
      void ses.setProxy({ mode: 'system' })
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

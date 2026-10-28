/**
 * 自建 bangumi 反代：双端点 + 预共享密钥（PSK）的**轻度混淆**。
 *
 * ⚠️ 这里做的是**混淆，不是加密**。
 *
 * 为什么仍然要做：用户明确要求「怕被人拿到这两套 API 乱用，地址要做加密」。在 Electron 里
 * 客户端一定持有能还原地址与密钥的全部材料（请求头必须能算出来），所以任何"加密"都只能
 * 提高逆向成本，不可能真正保密 —— 拿到安装包的人总能还原。真正防滥用要靠**服务端限流/配额**，
 * 这一点必须如实写在代码里，避免以后有人把它当成安全边界。
 *
 * 具体做法（只为了不让 `strings` / 资源查看器一眼看到明文）：
 *   · 每段字符串先按字节 XOR，再 Base64；
 *   · Base64 结果再拆成几段放在不同常量里，密钥也用数字数组分开写；
 *   · 运行时在内存里拼回，地址与 PSK 从不进入设置文件、日志或界面。
 *
 * 可覆盖性：设置里的「API 地址」留空时使用下面这套内置双端点；填了地址就按用户填的来
 * （支持用空格/逗号分隔多个地址），因此用户永远可以绕开内置端点，不会被写死。
 */

/** XOR 密钥（拆成两段只是不让它看起来像一个完整常量；这不是安全性） */
const KEY_HEAD = [0x5a, 0x13, 0x7c, 0x2e, 0x91, 0x47, 0x0b, 0x68]
const KEY_TAIL = [0xa4, 0x35, 0xd2, 0x19, 0x6f, 0xc7, 0x28, 0x83]

/** 端点 1（老反代，现已加同一个 PSK）。Base64 内容由构建脚本生成，源码里没有明文域名。 */
const API_1_PARTS = ['MmcIXuJ9JEfX', 'VLxyDqlJrjhy', 'EknkKmJGwFDn', 'NwGiXKw7YxU=']
/** 端点 2（新反代，图片地址由接口响应自带，不需要客户端拼）。 */
const API_2_PARTS = ['MmcIXuJ9JEfF', 'Rbs3HKZD4jRy', 'TUzwKWwdyVzg', 'Nwu3TO0pPRNc', '9g==']
/** 两套反代共用的预共享密钥；只用于 `X-API-Key` 请求头，绝不写日志/界面。 */
const PSK_PARTS = ['PCEdF6QjM1uV', 'AeIvDKJKtA==']

/**
 * 图片反代（V1.4 补）。
 *
 * 为什么必须有这条：用户说「图片地址不用手填，API 返回里自动是图片站」，
 * 但真机抓下来**日历/番剧表返回的封面仍然是 `http://lain.bgm.tv/pic/cover/…`**，
 * 而 lain.bgm.tv 在这台机器上实测 **20 秒超时（curl code=000）** —— 于是番剧表封面全空。
 * 同一路径走图片反代是 200（实测 177KB / 1.66s；缩放路径 `/r/400/` 只有 4.4KB / 1.08s）。
 * 所以把图片站也纳入内置常量，由 bangumi.ts 的 rewriteImageUrl 在**用户没填自定义图片反代**时兜底改写。
 */
const IMG_PARTS = ['MmcIXuJ9JEfNW', 'LU3HKZD4jRyTU', 'zwKWwdyVzgNwu', '3TO0pPRNc9g==']


const XOR_KEY = [...KEY_HEAD, ...KEY_TAIL]

/**
 * 还原一段被 XOR + Base64 拆分的字符串。
 * 失败时返回空串而不是抛异常：单个常量损坏不应该让整个主进程起不来。
 */
function decodeParts(parts: readonly string[]): string {
  try {
    const raw = Buffer.from(parts.join(''), 'base64')
    for (let i = 0; i < raw.length; i++) raw[i] ^= XOR_KEY[i % XOR_KEY.length]
    return raw.toString('utf8')
  } catch {
    return ''
  }
}

interface InternalEndpoint {
  id: string
  /** 只用于日志/界面的安全标签：`api-1` / `api-2`，不含地址 */
  label: string
  baseUrl: string
  /** 预共享密钥；只有内置端点有，用户自定义的第三方地址不会拿到它 */
  apiKey: string | null
}

const BUILT_IN_ENDPOINTS: InternalEndpoint[] = (() => {
  const psk = decodeParts(PSK_PARTS)
  return [
    { id: 'api-1', label: 'api-1', baseUrl: decodeParts(API_1_PARTS), apiKey: psk },
    { id: 'api-2', label: 'api-2', baseUrl: decodeParts(API_2_PARTS), apiKey: psk }
  ].filter((ep) => /^https?:\/\//i.test(ep.baseUrl))
})()

/** 暴露给调用方的端点信息（**故意不含密钥**，调用方只能通过 authHeadersFor 拿请求头） */
export interface BangumiEndpoint {
  id: string
  label: string
  baseUrl: string
}

/** 去掉末尾斜杠；空值返回空串 */
function normalizeBase(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\/+$/, '')
}

/** `url` 是否落在 `base` 这个地址之下（用于判定「这是不是内置反代」） */
function urlUnderBase(url: string, base: string): boolean {
  const u = String(url ?? '').trim()
  const b = normalizeBase(base)
  if (!u || !b) return false
  return u === b || u.startsWith(`${b}/`) || u.startsWith(`${b}?`)
}

function hostOf(raw: unknown): string {
  try {
    return new URL(String(raw ?? '').trim()).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 这个地址是否是内置反代（设置里残留的旧默认值也认，迁移时据此清理） */
export function isBuiltInBangumiApi(raw: unknown): boolean {
  return BUILT_IN_ENDPOINTS.some((ep) => urlUnderBase(String(raw ?? ''), ep.baseUrl))
}

/**
 * 这个地址是否属于内置反代的主机（不看路径）。
 * 用途：旧设置里可能残留同一主机的图片反代地址，迁移时一并清掉，避免继续拼旧域名。
 */
export function isBuiltInBangumiHost(raw: unknown): boolean {
  const h = hostOf(raw)
  if (!h) return false
  return BUILT_IN_ENDPOINTS.some((ep) => hostOf(ep.baseUrl) === h)
}

/**
 * 数据源模式（V1.5.1）：直连官方 or 内置反代。
 *
 * 用户要求：启动时问一次"能否自行连接 bangumi 主站"，能就连官方的 API 与图片
 * （图片也走官方图床，不再经过我们的反代），不能才用内置反代。
 *
 * 为什么用模块级开关而不是给每个调用点加参数：
 * `resolveBangumiEndpoints` / `rewriteImageUrl` 有几十个调用点，逐个传参等于把
 * "用哪个数据源"这件事散到全项目；开关只有一个，启动时设一次、用户在弹窗里改一次即可，
 * 也不会出现"API 走官方、图片却还走反代"这种错配。
 *
 * 默认 false（用内置反代）：这是老用户的实际状态，升级不该悄悄改变数据源。
 */
let officialSource = false

/** 设置数据源模式：true = 直连官方（api.bgm.tv + 原始图床），false = 内置反代 */
export function setOfficialBangumiSource(on: boolean): void {
  officialSource = on
}

/** 当前是否直连官方数据源 */
export function bangumiSourceIsOfficial(): boolean {
  return officialSource
}

/** 官方 API 根地址（公开地址，不含任何反代信息/密钥） */
export const OFFICIAL_BANGUMI_API = 'https://api.bgm.tv'

/**
 * 根据设置里的「API 地址」解析本次要用的端点池。
 *
 * 分配策略在 `orderBangumiEndpoints`：**同一时刻在途请求最少者优先**，在途数相同则轮询。
 * 为什么选它而不是纯轮询：
 *   · 两个反代共用同一份上游数据，但各自的冷启动/限流状态不同；纯轮询会把请求继续送给
 *     正在卡住的那一个，而"最少在途"会自然把新请求推向空闲的一侧，这就是用户要的"谁忙不过来就帮谁"。
 *   · 在途数相同时用轮询兜底，避免空闲时永远先打 api-1、api-2 长期闲置。
 *   · 实现只有一个 Map 计数器，调用方无感；不需要健康检查、不需要额外定时器。
 */
export function resolveBangumiEndpoints(customApi?: string): BangumiEndpoint[] {
  const raw = String(customApi ?? '').trim()
  const useBuiltIn = !raw || isBuiltInBangumiApi(raw)
  if (useBuiltIn) {
    /*
     * V1.5.1：直连官方模式 → 只打 api.bgm.tv。
     * 用户自己填了自定义 API 地址时仍然优先用他的（上面 useBuiltIn 已把"填了"排除掉），
     * 所以这个开关只影响"本该用内置反代"的那批用户。
     */
    if (officialSource) return [{ id: 'official', label: '官方', baseUrl: OFFICIAL_BANGUMI_API }]
    return BUILT_IN_ENDPOINTS.map((ep) => ({ id: ep.id, label: ep.label, baseUrl: ep.baseUrl }))
  }
  // 用户自定义：允许空格/逗号分隔多个地址，方便高级用户自己再组一套双端点。
  const bases = [...new Set(raw.split(/[\s,]+/).map(normalizeBase).filter(Boolean))]
  return bases.map((baseUrl, index) => ({
    id: `custom-${index}`,
    label: bases.length > 1 ? `自定义反代 ${index + 1}` : '自定义反代',
    baseUrl
  }))
}

/** 在途请求计数（只统计内置端点；自定义端点通常是单个，不需要分流） */
const inFlight = new Map<string, number>()

/** 给一次真实请求占一个内置端点的在途名额；返回值必须且只应调用一次 */
export function beginEndpointRequest(rawUrl: unknown): () => void {
  const url = String(rawUrl ?? '')
  const ep = BUILT_IN_ENDPOINTS.find((item) => urlUnderBase(url, item.baseUrl))
  if (!ep) return () => {}
  inFlight.set(ep.id, (inFlight.get(ep.id) ?? 0) + 1)
  let released = false
  return (): void => {
    if (released) return
    released = true
    inFlight.set(ep.id, Math.max(0, (inFlight.get(ep.id) ?? 0) - 1))
  }
}

/** 轮询游标：只在"在途数相同"时使用 */
let roundRobin = 0

/** 返回按「当前在途数升序、相同则轮询」排好序的端点池 */
export function orderBangumiEndpoints(customApi?: string): BangumiEndpoint[] {
  const pool = resolveBangumiEndpoints(customApi)
  if (pool.length <= 1) return pool
  const start = roundRobin++ % pool.length
  return pool
    .map((ep, index) => ({
      ep,
      active: inFlight.get(ep.id) ?? 0,
      // 把 start 之前的端点排到后面，实现同负载下的轮询
      turn: (index - start + pool.length) % pool.length
    }))
    .sort((a, b) => a.active - b.active || a.turn - b.turn)
    .map((item) => item.ep)
}

/**
 * 该请求应带的认证头。
 *
 * 只对**内置反代**注入 PSK：用户如果填了第三方地址，密钥不能跟着发过去。
 * 旧设置里残留的默认地址（与内置地址相同）也会命中，所以升级用户不需要手动改配置。
 * 返回空对象时调用方直接展开即可，不改变原有请求头。
 */
export function authHeadersFor(rawUrl: unknown): Record<string, string> {
  const url = String(rawUrl ?? '')
  const ep = BUILT_IN_ENDPOINTS.find((item) => urlUnderBase(url, item.baseUrl))
  if (!ep?.apiKey) return {}
  return { 'X-API-Key': ep.apiKey }
}

/** 把地址换成不含主机的安全标签（错误信息/界面用） */
export function endpointLabelOf(rawUrl: unknown): string {
  const url = String(rawUrl ?? '')
  const ep = BUILT_IN_ENDPOINTS.find((item) => urlUnderBase(url, item.baseUrl))
  return ep?.label ?? '数据源'
}

/** 当前是否有可用的内置端点（只用于诊断/测试，不包含地址） */
export function builtInEndpointCount(): number {
  return BUILT_IN_ENDPOINTS.length
}

/**
 * 内置图片反代的 origin（末尾不带斜杠）；解不出来返回空串。
 *
 * 只给主进程的 `rewriteImageUrl` 用：用户没填自定义图片反代时，把 `lain.bgm.tv` 这类
 * 已被墙的封面地址改写到它上面。**不要**把这个值写进日志或界面（红线：地址不外泄）。
 */
export function builtInImgOrigin(): string {
  return decodeParts(IMG_PARTS).replace(/\/+$/, '')
}

import axios from 'axios'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings, proxyForUrl } from '../net'
import { beginNetTrace } from '../net-priority'

/**
 * 在线数据库（V1.5.3 数据源升级）。
 *
 * 用户提供的客户端约定：
 *   · API：443 优先，失败换 8443（`X-API-Key` 鉴权）；
 *   · 图片：443 优先，加载失败再换 8443（不要把所有 URL 都写死成 8443）；
 *   · 数据/图片优先从在线库取，取不到才回退旧反代，尽量减少反代压力。
 *
 * 实测（2026-10）：
 *   · `/v0/subjects/<id>` 443/8443 都 200，数据与 bangumi 结构一致；
 *   · **`/v0/calendar` 200**（7 天、113 部，结构与官方 v0 一致）；`/calendar`（没有 v0 前缀）才是 404，
 *     那是旧自建反代自己的路径习惯，在线库按官方 v0 接口实现，不提供这个别名；
 *   · 图片 `/r/400/pic/cover/l/...` 443 可用；`/s/<id>` 443 超时、8443 可用。
 *
 * 地址与密钥为什么拆段 + XOR + Base64：与 `bangumiProxy.ts` / `danmakuApiConfig.ts` 同一套规矩 ——
 * 项目硬约束是源码、日志、界面、提交信息里都不出现明文反代地址与密钥。
 * 说明白：这是**混淆不是加密**，拿到安装包的人总能还原；这里只是不让它们出现在源码/strings 里。
 */

/** XOR 密钥（拆两段只是不长得像一串完整常量；这不是安全性） */
const KEY_HEAD = [0x4d, 0x1e, 0xb7, 0x62, 0x90]
const KEY_TAIL = [0x3a, 0xcc, 0x55, 0x71, 0xe2]
const XOR_KEY = [...KEY_HEAD, ...KEY_TAIL]

/** 在线库 API 443 基址（XOR + Base64，拆三段） */
const API_PARTS = ['JWrDEuMA43oQkiQsmR', 'HxUa07ENMvf9kF5Vel', 'Z1+GPXrZEb5VvjI=']
/** 在线图床 443 基址（同上） */
const IMG_PARTS = ['JWrDEuMA43oYjyosmR', 'HxUa07ENMvf9kF5Vel', 'Z1+GPXrZEb5VvjI=']
/** 在线库 API Key（只用于 X-API-Key 请求头，不写日志/界面） */
const KEY_PARTS = ['LCiEWqAP+GxF0n161Vr1A/', 'RgFIN4LI9U9luqZxDaey+O', 'U/Fbr2FF1it60lenXP9s']

function decodeParts(parts: string[]): string {
  try {
    const raw = Buffer.from(parts.join(''), 'base64')
    for (let i = 0; i < raw.length; i++) raw[i] ^= XOR_KEY[i % XOR_KEY.length]
    return raw.toString('utf8')
  } catch {
    return ''
  }
}

export const ONLINE_API_443 = decodeParts(API_PARTS)
export const ONLINE_API_8443 = `${ONLINE_API_443}:8443`
export const ONLINE_IMG_443 = decodeParts(IMG_PARTS)
export const ONLINE_IMG_8443 = `${ONLINE_IMG_443}:8443`

const ONLINE_API_KEY = decodeParts(KEY_PARTS)

/** 请求在线库；443 失败再试 8443。失败返回 null，由调用方回退旧反代。 */
export async function onlineApiText(
  path: string,
  timeoutMs = 8000
): Promise<{ text: string; base: string } | null> {
  if (!path.startsWith('/')) return null
  for (const base of [ONLINE_API_443, ONLINE_API_8443]) {
    // 与 bangumi 的 `/calendar` 同口径记账：在线库流量算「番剧数据」，细分来源记 online
    const done = beginNetTrace('A', path, 'online')
    const url = `${base}${path}`
    try {
      const res = await axios.get(url, {
        timeout: timeoutMs,
        responseType: 'text',
        validateStatus: () => true,
        headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', 'X-API-Key': ONLINE_API_KEY },
        ...buildProxyAgents(proxyForUrl(url))
      })
      const text = String(res.data ?? '')
      done(res.status, Buffer.byteLength(text, 'utf-8'))
      if (res.status !== 200 || !text) continue
      return { text, base }
    } catch (err) {
      done('error')
      const message = String((err as Error)?.message ?? err)
      log.append(
        'info',
        'bangumi',
        `在线库接口失败（${base.includes(':8443') ? '8443' : '443'}）: ${message.slice(0, 70)}`
      )
      /*
       * 超时不再试 8443（V1.5.3）。
       * 真机日志：在线库 443 偶尔 12 秒都拿不到响应，再等一轮 8443 就是 24 秒，
       * 而旧反代通常 2~4 秒就给了同一份数据 —— 对详情页来说，"晚 20 秒才出内容"
       * 比"没走在线库"糟得多。连接被拒/同域 5xx 才值得换端口再试。
       */
      if (/timeout|timed out|aborted/i.test(message)) break
    }
  }
  return null
}

/** 图片地址换成 8443（只对在线图床；其它域名原样返回） */
export function onlineImageTo8443(url: string): string {
  const s = String(url ?? '')
  if (!ONLINE_IMG_443 || !s.startsWith(ONLINE_IMG_443)) return s
  try {
    const current = new URL(s)
    const target = new URL(ONLINE_IMG_8443)
    if (current.hostname !== target.hostname) return s
    current.port = '8443'
    return current.toString()
  } catch {
    return s
  }
}

/** 把 bgm 原始封面地址改写到在线图床（443），缩放路径沿用 /r/<宽>/ */
export function onlineCoverUrl(rawPath: string, width = 400): string {
  const p = String(rawPath ?? '').startsWith('/') ? rawPath : `/${rawPath}`
  return width > 0 && !/^\/r\/\d+\//.test(p) ? `${ONLINE_IMG_443}/r/${width}${p}` : `${ONLINE_IMG_443}${p}`
}

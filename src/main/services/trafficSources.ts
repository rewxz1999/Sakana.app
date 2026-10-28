import type { TrafficSourceId } from '@shared/types'
import { getFeedBase, getSettings } from '../net'
import { builtInImgOrigin, OFFICIAL_BANGUMI_API, resolveBangumiEndpoints } from './bangumiProxy'
import { builtInDanmuApiBase } from './danmakuApiConfig'
import { MIKAN_BASE } from './mikan'
import { ONLINE_API_443, ONLINE_API_8443, ONLINE_IMG_443, ONLINE_IMG_8443 } from './onlineDb'
import { setTrafficUrlClassifier } from './traffic'

/**
 * 把「URL → 数据源类别」的判定装进流量监控（V1.5.3）。
 *
 * 为什么单独一个文件：
 *   · `traffic.ts` 只做计数，**故意不认识任何地址** —— 它会被 net.ts / media.ts 这类底层模块引用，
 *     如果它反过来 import bangumiProxy / mikan，就会出现 net → traffic → bangumiProxy → net 的循环；
 *   · 这个文件在启动时把所有数据源的真实基址收拢一次，注册成一个纯函数给 traffic 用。
 *     界面与日志只拿到类别（`番剧数据` / `封面图片`…），不会出现域名。
 *
 * 判定用**前缀**而不是主机名相等：内置反代带路径（`…/api`）、自建 danmu_api 的基址自带令牌路径，
 * 只比 host 会把同一台主机上的不同用途混在一起。
 */

interface BaseSets {
  bangumi: string[]
  image: string[]
  mikan: string[]
  danmaku: string[]
}

let cached: BaseSets | null = null
let cachedAt = 0

function normalizeBase(raw: string): string {
  return String(raw ?? '').trim().replace(/\/+$/, '')
}

/**
 * 收集基址。
 *
 * 缓存 5 秒：设置里换数据源后最多 5 秒生效，够用又不必每个请求都读一遍设置。
 * `getSettings()` 本身只是内存读，但 `resolveBangumiEndpoints` 会做字符串处理，
 * 而图片请求是高频的（一屏十几张），不值得每张图都算一次。
 */
function bases(): BaseSets {
  const now = Date.now()
  if (cached && now - cachedAt < 5000) return cached
  const settings = getSettings()
  const bangumi = [
    OFFICIAL_BANGUMI_API,
    ...resolveBangumiEndpoints(settings.bangumiCustomApi).map((ep) => ep.baseUrl),
    ONLINE_API_443,
    ONLINE_API_8443
  ]
  const image = [builtInImgOrigin(), ONLINE_IMG_443, ONLINE_IMG_8443]
  const mikan = [MIKAN_BASE, getFeedBase()]
  // 设置里允许覆盖 danmu_api 地址（字段尚未进 AppSettings 类型，弹幕服务里也是这么读的）
  const danmakuOverride = String(
    (settings as unknown as { danmakuApiBase?: string }).danmakuApiBase ?? ''
  ).trim()
  const danmakuBase = normalizeBase(danmakuOverride) || builtInDanmuApiBase()
  const danmaku = danmakuBase ? [danmakuBase] : []
  cached = {
    bangumi: bangumi.map(normalizeBase).filter(Boolean),
    image: image.map(normalizeBase).filter(Boolean),
    mikan: mikan.map(normalizeBase).filter(Boolean),
    danmaku: danmaku.map(normalizeBase).filter(Boolean)
  }
  cachedAt = now
  return cached
}

function startsWithAny(url: string, list: string[]): boolean {
  return list.some((base) => !!base && (url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`)))
}

/** 按 URL 判断来源；判断不出来的一律归到「站点与其它」（规则页、嗅探、galgame 等） */
export function classifyTrafficUrl(raw: string): TrafficSourceId | null {
  const url = String(raw ?? '').trim()
  if (!/^https?:\/\//i.test(url)) return null
  const b = bases()
  if (startsWithAny(url, b.image)) return 'image'
  if (startsWithAny(url, b.bangumi)) return 'bangumi'
  if (startsWithAny(url, b.mikan)) return 'mikan'
  if (startsWithAny(url, b.danmaku)) return 'danmaku'
  return 'site'
}

setTrafficUrlClassifier(classifyTrafficUrl)

/** 设置变化后让下一次判定重新取基址（目前只有设置页切换数据源时会调；不调也最多 5 秒后自动生效） */
export function invalidateTrafficBases(): void {
  cached = null
  cachedAt = 0
}

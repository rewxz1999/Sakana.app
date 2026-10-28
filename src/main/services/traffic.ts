import type { TrafficBucket, TrafficSnapshot, TrafficSourceId, TrafficSourceStat } from '@shared/types'

/**
 * 数据源流量监控（V1.5.3）。
 *
 * 用户要求：「数据源流量监控 + 折线图」——能看见每个数据源用了多少流量、什么时候用的，
 * 而不是只在日志里留一行「xx KB xx ms」。
 *
 * 统计口径（为什么是这五个）：
 *   · 番剧数据：bangumi 接口（内置/自定义反代、官方直连、在线库）；
 *   · 封面图片：`sakana-img` 那条链路（命中磁盘/内存缓存的会单独记「省下」的字节）；
 *   · 蜜柑计划：搜索与订阅 feed；
 *   · 弹幕：danmu_api 的搜索/剧集/评论；
 *   · 站点与其它：规则播放页、嗅探、galgame 搜索等无法归类的第三方站点。
 *
 * 为什么不统计 BT 下载：下载走的是 child process 里的 aria2/Transmission，
 * 字节数在它们自己的统计里（下载页已经显示），主进程拦不到；这里不编造数字。
 *
 * 为什么不落盘：流量是「此刻发生了什么」的观测值，重启后看历史意义不大，
 * 而每分钟落盘一次既费磁盘也容易和真实网络对不上。本次运行的时间窗口内存足够。
 */

/** 每个折线桶的时长：30 秒 × 60 桶 = 最近 30 分钟 */
export const TRAFFIC_BUCKET_MS = 30_000
/** 保留的桶数（图表横轴长度） */
export const TRAFFIC_BUCKETS = 60

/** 来源显示名（主进程与界面共用；界面不自己写一份，避免名字漂移） */
export const TRAFFIC_SOURCE_LABEL: Record<TrafficSourceId, string> = {
  bangumi: '番剧数据',
  image: '封面图片',
  mikan: '蜜柑计划',
  danmaku: '弹幕',
  site: '站点与其它'
}

export const TRAFFIC_SOURCE_ORDER: TrafficSourceId[] = ['bangumi', 'image', 'mikan', 'danmaku', 'site']

interface Counter {
  requests: number
  bytes: number
  errors: number
  /** 命中本地缓存、没有走网络的次数与字节（图片链路才有） */
  cacheHits: number
  cacheBytes: number
}

function emptyCounter(): Counter {
  return { requests: 0, bytes: 0, errors: 0, cacheHits: 0, cacheBytes: 0 }
}

function emptyBucket(at: number): TrafficBucket {
  const bySource: Record<TrafficSourceId, number> = {
    bangumi: 0,
    image: 0,
    mikan: 0,
    danmaku: 0,
    site: 0
  }
  return { at, totalBytes: 0, totalRequests: 0, bySource }
}

const startedAt = Date.now()
const totals: Counter = emptyCounter()
const perSource = new Map<TrafficSourceId, Counter>()
const buckets: TrafficBucket[] = []

/** URL → 来源。由 trafficSources 在启动时注入（那边知道各数据源的真实地址，traffic 本身不碰地址） */
let urlClassifier: ((url: string) => TrafficSourceId | null) | null = null

export function setTrafficUrlClassifier(fn: (url: string) => TrafficSourceId | null): void {
  urlClassifier = fn
}

/** 按 URL 归类；没有注入分类器时统一归到「站点与其它」 */
export function trafficSourceOfUrl(url: string): TrafficSourceId {
  if (!urlClassifier) return 'site'
  try {
    return urlClassifier(url) ?? 'site'
  } catch {
    return 'site'
  }
}

/**
 * 把桶数组补齐到当前时刻。
 *
 * 为什么必须在**读快照时**也调用：用户停在那里不请求时图表要往左滑（出现新的空桶），
 * 否则折线会停在最后一次请求的位置，看起来像「卡住了」。
 */
function ensureBuckets(now: number): TrafficBucket {
  const currentAt = Math.floor(now / TRAFFIC_BUCKET_MS) * TRAFFIC_BUCKET_MS
  if (buckets.length === 0) {
    const b = emptyBucket(currentAt)
    buckets.push(b)
    return b
  }
  let last = buckets[buckets.length - 1]
  while (last.at < currentAt) {
    last = emptyBucket(last.at + TRAFFIC_BUCKET_MS)
    buckets.push(last)
  }
  // 只保留窗口内的：图表不需要更久的历史，也避免长时间运行后内存无限增长
  const oldest = currentAt - (TRAFFIC_BUCKETS - 1) * TRAFFIC_BUCKET_MS
  while (buckets.length > 1 && buckets[0].at < oldest) buckets.shift()
  return buckets[buckets.length - 1]
}

export interface TrafficEvent {
  /** 来源；不确定时传 URL，让分类器判断 */
  source?: TrafficSourceId
  url?: string
  /** 本次请求实际收发的字节数（收不到就传 0，请求数照记） */
  bytes?: number
  requests?: number
  errors?: number
  cacheHits?: number
  cacheBytes?: number
  at?: number
}

/**
 * 记一次网络活动。
 *
 * 允许同一事件里同时带 `bytes` 与 `cacheBytes`：图片可能一半命中缓存、一半走网络，
 * 分开记才能让用户看出「缓存到底省了多少」。
 */
export function recordTraffic(event: TrafficEvent): void {
  const source = event.source ?? trafficSourceOfUrl(event.url ?? '')
  const now = event.at ?? Date.now()
  const bytes = Math.max(0, Number(event.bytes) || 0)
  const requests = Math.max(0, Number(event.requests ?? 1))
  const errors = Math.max(0, Number(event.errors) || 0)
  const cacheHits = Math.max(0, Number(event.cacheHits) || 0)
  const cacheBytes = Math.max(0, Number(event.cacheBytes) || 0)
  if (bytes === 0 && requests === 0 && errors === 0 && cacheHits === 0 && cacheBytes === 0) return

  let src = perSource.get(source)
  if (!src) {
    src = emptyCounter()
    perSource.set(source, src)
  }
  src.requests += requests
  src.bytes += bytes
  src.errors += errors
  src.cacheHits += cacheHits
  src.cacheBytes += cacheBytes

  totals.requests += requests
  totals.bytes += bytes
  totals.errors += errors
  totals.cacheHits += cacheHits
  totals.cacheBytes += cacheBytes

  const bucket = ensureBuckets(now)
  bucket.bySource[source] = (bucket.bySource[source] ?? 0) + bytes
  bucket.totalBytes += bytes
  bucket.totalRequests += requests
}

/** 当前快照（纯内存读，渲染层可以 2 秒轮询一次） */
export function trafficSnapshot(now = Date.now()): TrafficSnapshot {
  ensureBuckets(now)
  const sources: TrafficSourceStat[] = TRAFFIC_SOURCE_ORDER.map((id) => {
    const c = perSource.get(id) ?? emptyCounter()
    return {
      id,
      label: TRAFFIC_SOURCE_LABEL[id],
      requests: c.requests,
      bytes: c.bytes,
      errors: c.errors,
      cacheHits: c.cacheHits,
      cacheBytes: c.cacheBytes
    }
  })
  return {
    startedAt,
    now,
    bucketMs: TRAFFIC_BUCKET_MS,
    windowMs: TRAFFIC_BUCKET_MS * TRAFFIC_BUCKETS,
    totals: { ...totals },
    sources,
    series: buckets.map((b) => ({ at: b.at, totalBytes: b.totalBytes, totalRequests: b.totalRequests, bySource: { ...b.bySource } }))
  }
}

/** 清空本次运行的统计（设置页按钮） */
export function resetTraffic(): void {
  totals.requests = 0
  totals.bytes = 0
  totals.errors = 0
  totals.cacheHits = 0
  totals.cacheBytes = 0
  perSource.clear()
  buckets.length = 0
  ensureBuckets(Date.now())
}

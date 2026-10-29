import axios from 'axios'
import { subjectIdFromCoverUrl } from '@shared/bangumiCover'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings, proxyForUrl } from '../net'
import { subjectMetaOf } from './cacheDb'

/** 正则本身在 @shared/bangumiCover（可脱离 Electron 断言），这里只负责"拿它去查备用源" */
export { subjectIdFromCoverUrl }

/**
 * 图片数据源兜底（V1.5.2）。
 *
 * 用户原话：「由于我们从 bangumi api 获取图片时经常被限流，所以我们将增加多个图片源，来加载图片。
 * AniList / Jikan / Kitsu … 这三个源需要在 bangumi 源（我们的反代 api）多次取不到图片时再启用。」
 *
 * ## 怎么知道"这张图属于哪部番"
 *
 * 取图链路（media.ts）手里只有一个图片 URL。好在 bangumi 的封面路径里**带条目 id**：
 * `/pic/cover/l/xx/xx/400602_o1abc.jpg` → 数字前缀就是 subject id。
 * 拿到 id 之后，标题从**缓存数据库**里取（`cacheDb.subjectMetaOf`）——
 * 那正是"这部番的详情/番剧表数据"，不额外发请求；没有标题就放弃兜底（宁可不换源，也不猜）。
 *
 * ## 启用顺序
 *
 * AniList（GraphQL，免费无 Key，封面质量最好）→ Jikan（MAL，REST）→ Kitsu。
 * 任何一个拿到图片地址就停。三个都失败时返回 null，由调用方照旧返回 502。
 *
 * ## 限流与复用
 *
 * · 同一 subject id 的查询结果缓存 30 分钟（正/负都缓存）：一集里会出现封面、角色图等多张，
 *   不能每张失败都去问三个站点；
 * · 同一 subject 的在途查询单飞；
 * · 全局并发闸门 2：兜底是"主源坏了"时的补救，不该反过来把三个源打挂。
 */

interface FallbackResult {
  url: string
  source: 'anilist' | 'jikan' | 'kitsu'
}

/** 正/负结果缓存：30 分钟内同一部番只查一次 */
const TTL_MS = 30 * 60 * 1000
const cache = new Map<number, { at: number; result: FallbackResult | null }>()
const inflight = new Map<number, Promise<FallbackResult | null>>()

/** 全局并发 2（见文件头） */
let active = 0
const queue: (() => void)[] = []
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((resolve) => queue.push(resolve))
  active++
  try {
    return await fn()
  } finally {
    active--
    const next = queue.shift()
    if (next) next()
  }
}

/**
 * 从 bangumi 封面地址里抠出 subject id（实现已移到 @shared/bangumiCover，便于自检）。
 *
 * 只认 `/pic/cover/...` 路径下的 `<id>_` 形式 —— 角色图（`/pic/crt/`）与头像不参与兜底：
 * 它们的路径里也有数字，但语义不是"这张图属于哪部番"，硬猜只会换错图。
 */

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 超时`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

async function anilistCover(title: string): Promise<FallbackResult | null> {
  const query =
    'query($s:String){Page(perPage:3){media(search:$s,type:ANIME,sort:SEARCH_MATCH){id title{romaji native} coverImage{extraLarge large}}}}'
  const res = await axios.post(
    'https://graphql.anilist.co',
    { query, variables: { s: title } },
    {
      timeout: 8000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': BROWSER_UA },
      validateStatus: () => true,
      ...buildProxyAgents(proxyForUrl('https://graphql.anilist.co'))
    }
  )
  if (res.status !== 200) return null
  const media = (res.data as { data?: { Page?: { media?: { coverImage?: { extraLarge?: string; large?: string } }[] } } })
    ?.data?.Page?.media
  const first = media?.[0]
  const url = first?.coverImage?.extraLarge || first?.coverImage?.large || ''
  return url ? { url, source: 'anilist' } : null
}

async function jikanCover(title: string): Promise<FallbackResult | null> {
  const res = await axios.get('https://api.jikan.moe/v4/anime', {
    timeout: 8000,
    params: { q: title, limit: 1 },
    headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
    validateStatus: () => true,
    ...buildProxyAgents(proxyForUrl('https://api.jikan.moe/v4/anime'))
  })
  if (res.status !== 200) return null
  const list = (res.data as { data?: { images?: { jpg?: { large_image_url?: string; image_url?: string } } }[] })?.data
  const url = list?.[0]?.images?.jpg?.large_image_url || list?.[0]?.images?.jpg?.image_url || ''
  return url ? { url, source: 'jikan' } : null
}

async function kitsuCover(title: string): Promise<FallbackResult | null> {
  const res = await axios.get('https://kitsu.io/api/edge/anime', {
    timeout: 8000,
    params: { 'filter[text]': title, 'page[limit]': 1 },
    headers: { Accept: 'application/vnd.api+json', 'User-Agent': BROWSER_UA },
    validateStatus: () => true,
    ...buildProxyAgents(proxyForUrl('https://kitsu.io/api/edge/anime'))
  })
  if (res.status !== 200) return null
  const attr = (res.data as { data?: { attributes?: { posterImage?: Record<string, string | null> } }[] })?.data?.[0]
    ?.attributes?.posterImage
  const url = attr?.original || attr?.large || attr?.medium || ''
  return url ? { url, source: 'kitsu' } : null
}

/**
 * 给某个 bangumi subject 找一张替代封面。
 * 返回 null = 三个源都没有可用图（调用方照旧报失败），不影响播放与其它图片。
 */
export async function fallbackCoverForSubject(subjectId: number): Promise<FallbackResult | null> {
  const id = Number(subjectId)
  if (!Number.isFinite(id) || id <= 0) return null
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at <= TTL_MS) return hit.result
  const running = inflight.get(id)
  if (running) return running
  const p = (async (): Promise<FallbackResult | null> => {
    const meta = subjectMetaOf(id)
    const titles = [meta?.title ?? ''].map((t) => t.trim()).filter(Boolean)
    if (titles.length === 0) {
      cache.set(id, { at: Date.now(), result: null })
      return null
    }
    const title = titles[0]
    const attempts: { name: string; fn: () => Promise<FallbackResult | null> }[] = [
      { name: 'AniList', fn: () => anilistCover(title) },
      { name: 'Jikan', fn: () => jikanCover(title) },
      { name: 'Kitsu', fn: () => kitsuCover(title) }
    ]
    for (const attempt of attempts) {
      try {
        const r = await withSlot(() => withTimeout(attempt.fn(), 9000, attempt.name))
        if (r) {
          log.appendThrottled(
            'img-fallback-hit',
            'info',
            'img',
            `bangumi 图片多次不可用，已改用 ${r.source} 的封面（条目 #${id}）`,
            120_000
          )
          cache.set(id, { at: Date.now(), result: r })
          return r
        }
      } catch (err) {
        log.appendThrottled(
          `img-fallback-fail-${attempt.name}`,
          'warn',
          'img',
          `${attempt.name} 封面兜底失败（条目 #${id}）：${String((err as Error)?.message ?? err).slice(0, 90)}`,
          60_000
        )
      }
    }
    // 负结果也缓存：避免同一部番的两三张图反复把三个源打一遍
    cache.set(id, { at: Date.now(), result: null })
    return null
  })().finally(() => inflight.delete(id))
  inflight.set(id, p)
  return p
}

/** 诊断/自检：缓存规模与在途数 */
export function imageFallbackStats(): { cached: number; inflight: number } {
  return { cached: cache.size, inflight: inflight.size }
}

import axios from 'axios'
import { log } from '../log'

/**
 * Jikan API（MyAnimeList 非官方接口，v0.3.0 新增）。
 *
 * 用途（用户要求）：
 *   ① 「最XX的角色 9宫格」的**角色立绘数据源**可切换成 Jikan —— 为了更清晰的立绘
 *      （Bangumi 的角色图不少只有 250x300，而 MAL 那边常是 350x500 以上的原图）；
 *   ② 作为**备用数据源**：反代地址失效时，番剧表等可以从 Jikan 拿到。
 *
 * 接口与限制（官方文档 https://docs.api.jikan.moe/）：
 *   · 所有请求都以 `https://api.jikan.moe/v4` 开头；
 *   · 速率限制 **3 次/秒、60 次/分钟** —— 超了会返回 429 甚至临时封禁，
 *     所以这里做了一个**令牌桶 + 滑动窗口**的节流器，所有请求都必须经过它。
 *
 * 为什么自己写节流而不是装库：需求就两条硬限制，自己写 30 行更可控，也少一个依赖。
 */

const JIKAN_BASE = 'https://api.jikan.moe/v4'
const UA = 'Sakana/0.3.0 (https://github.com/rewxz1999/Sakana.app)'

/** 每秒最多 3 次 */
const PER_SECOND = 3
/** 每分钟最多 60 次 */
const PER_MINUTE = 60

/** 最近请求时间戳（毫秒），用于滑动窗口判断 */
const stamps: number[] = []
/** 串行队列：节流之后仍然要保证「排队等待」而不是并发抢跑 */
let queue: Promise<unknown> = Promise.resolve()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 等到允许再发下一次请求（滑动窗口：同时满足 1 秒 3 次与 60 秒 60 次） */
async function waitForSlot(): Promise<void> {
  for (;;) {
    const now = Date.now()
    // 丢掉过期的时间戳
    while (stamps.length > 0 && now - stamps[0] > 60_000) stamps.shift()
    const lastSecond = stamps.filter((t) => now - t < 1000).length
    if (lastSecond >= PER_SECOND) {
      // 等到最早的那次请求满 1 秒
      const oldestInSecond = stamps.filter((t) => now - t < 1000)[0]
      await sleep(1000 - (now - oldestInSecond) + 20)
      continue
    }
    if (stamps.length >= PER_MINUTE) {
      // 一分钟窗口满了：等到最老的一次滑出窗口
      await sleep(60_000 - (now - stamps[0]) + 50)
      continue
    }
    stamps.push(now)
    return
  }
}

/** 统一的 GET（带节流、超时与一次 429 重试） */
async function get<T>(path: string, timeout = 15000): Promise<T | null> {
  const run = async (): Promise<T | null> => {
    await waitForSlot()
    try {
      const res = await axios.get<T>(`${JIKAN_BASE}${path}`, {
        timeout,
        headers: { 'User-Agent': UA, Accept: 'application/json' }
      })
      return res.data
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 429) {
        // 被限流：退避 2 秒再试一次（只重试一次，避免把窗口继续占满）
        log.append('warn', 'jikan', `被限流（429），退避 2 秒后重试：${path}`)
        await sleep(2000)
        try {
          const retry = await axios.get<T>(`${JIKAN_BASE}${path}`, {
            timeout,
            headers: { 'User-Agent': UA, Accept: 'application/json' }
          })
          return retry.data
        } catch (err2) {
          log.append('warn', 'jikan', `重试仍失败：${String((err2 as Error)?.message ?? err2)}`)
          return null
        }
      }
      log.append('warn', 'jikan', `请求失败 ${path}: ${String((err as Error)?.message ?? err)}`)
      return null
    }
  }
  // 串到队列尾部：保证调用顺序 = 实际发送顺序，节流窗口才准
  const task = queue.then(run, run)
  queue = task.catch(() => undefined)
  return task
}

export interface JikanCharacter {
  id: number
  name: string
  nameCn: string
  relation: string
  images: { large: string; medium: string; small: string; grid: string } | null
  favorites?: number
}

export interface JikanAnime {
  malId: number
  title: string
  titleCn: string
  images: string | null
  score: number | null
  aired: string | null
}

interface JikanSearchResponse {
  data?: {
    mal_id?: number
    title?: string
    title_english?: string
    titles?: { type?: string; title?: string }[]
    images?: { jpg?: { image_url?: string; large_image_url?: string } }
    score?: number
    aired?: { string?: string }
  }[]
}

/** 按关键词搜番剧（备用数据源 / 角色立绘入口都用它拿 MAL id） */
export async function jikanSearchAnime(keyword: string, limit = 5): Promise<JikanAnime[]> {
  const kw = String(keyword ?? '').trim()
  if (!kw) return []
  const data = await get<JikanSearchResponse>(`/anime?q=${encodeURIComponent(kw)}&limit=${limit}&sfw`)
  const list = data?.data ?? []
  return list.map((a) => ({
    malId: Number(a.mal_id ?? 0),
    title: String(a.title ?? ''),
    titleCn:
      String(a.titles?.find((t) => t.type === 'Chinese')?.title ?? a.title_english ?? a.title ?? ''),
    images: a.images?.jpg?.large_image_url ?? a.images?.jpg?.image_url ?? null,
    score: a.score != null ? Number(a.score) : null,
    aired: a.aired?.string ?? null
  }))
}

interface JikanCharactersResponse {
  data?: {
    character?: {
      mal_id?: number
      name?: string
      name_kanji?: string
      images?: { jpg?: { image_url?: string }; webp?: { image_url?: string } }
      favorites?: number
    }
    role?: string
  }[]
}

/**
 * 取某部番（MAL id）的登场角色。
 *
 * 图片说明：MAL 的 `image_url` 就是**原图**（不像 Bangumi 分 s/g/m/l 四档），
 * 实测常见 225x350，也有更大的；这正是用户想换到 Jikan 的原因 —— 立绘更清晰。
 * 这里把四个档位都填同一个原图地址，因为渲染层按 `large/medium/grid/small` 取值，
 * 都指向原图即可（本地缓存会按 URL 去重，不会重复下载）。
 */
export async function jikanCharacters(malId: number): Promise<JikanCharacter[]> {
  if (!malId) return []
  const data = await get<JikanCharactersResponse>(`/anime/${malId}/characters`)
  const list = data?.data ?? []
  return list
    .map((row) => {
      const c = row.character ?? {}
      const url = c.images?.jpg?.image_url ?? c.images?.webp?.image_url ?? null
      return {
        id: Number(c.mal_id ?? 0),
        name: String(c.name ?? ''),
        nameCn: String(c.name_kanji ?? ''),
        relation: String(row.role ?? ''),
        images: url ? { large: url, medium: url, small: url, grid: url } : null,
        favorites: c.favorites != null ? Number(c.favorites) : undefined
      }
    })
    .filter((c) => c.id > 0)
}

/**
 * 按番剧标题取角色（v0.3.0 工具用）：先搜到 MAL id 再取角色。
 *
 * 为什么要「按标题」而不是按 id：我们的条目 id 是 **Bangumi** 的，Jikan 认的是 MAL id，
 * 两边的 id 体系不通；但标题能对上，所以用标题做桥梁。
 * 会优先用中文名（`titles` 里的 Chinese）匹配到的条目，找不到就退回第一条。
 */
export async function jikanCharactersByTitle(title: string): Promise<{
  anime: JikanAnime | null
  characters: JikanCharacter[]
}> {
  const list = await jikanSearchAnime(title, 5)
  if (list.length === 0) return { anime: null, characters: [] }
  // 优先完全同名（去掉空格后比较），其次第一条
  const norm = (s: string): string => (s || '').replace(/\s+/g, '').toLowerCase()
  const want = norm(title)
  const hit = list.find((a) => norm(a.titleCn) === want || norm(a.title) === want) ?? list[0]
  const characters = await jikanCharacters(hit.malId)
  log.append('info', 'jikan', `角色数据源 Jikan：${title} → ${hit.title}（MAL #${hit.malId}）${characters.length} 位角色`)
  return { anime: hit, characters }
}

/** 反代/镜像都拿不到番剧表时的兜底：当季新番（Jikan seasons/now） */
export async function jikanCurrentSeason(): Promise<
  { title: string; titleCn: string; image: string | null; score: number | null; weekday: number | null }[]
> {
  interface SeasonsResponse {
    data?: {
      title?: string
      titles?: { type?: string; title?: string }[]
      images?: { jpg?: { image_url?: string; large_image_url?: string } }
      score?: number
      broadcast?: { day?: string }
      airing?: boolean
    }[]
  }
  const data = await get<SeasonsResponse>('/seasons/now?limit=25&sfw')
  const weekdays: Record<string, number> = {
    Mondays: 1,
    Tuesdays: 2,
    Wednesdays: 3,
    Thursdays: 4,
    Fridays: 5,
    Saturdays: 6,
    Sundays: 0
  }
  return (data?.data ?? [])
    .filter((a) => a.airing !== false)
    .map((a) => ({
      title: String(a.title ?? ''),
      titleCn: String(a.titles?.find((t) => t.type === 'Chinese')?.title ?? a.title ?? ''),
      image: a.images?.jpg?.large_image_url ?? a.images?.jpg?.image_url ?? null,
      score: a.score != null ? Number(a.score) : null,
      weekday: a.broadcast?.day != null ? (weekdays[a.broadcast.day] ?? null) : null
    }))
}

/** 自检用：当前节流窗口状态（最近 1 分钟内的请求数） */
export function jikanThrottleState(): { lastMinute: number } {
  const now = Date.now()
  return { lastMinute: stamps.filter((t) => now - t < 60_000).length }
}

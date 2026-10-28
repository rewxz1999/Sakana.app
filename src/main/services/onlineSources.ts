import axios from 'axios'
import type {
  AppSettings,
  OnlineEpisodeItem,
  OnlineResolveResult,
  OnlineSearchItem,
  OnlineSourceAvailability,
  OnlineSourceId,
  OnlineSourceMeta
} from '@shared/types'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings, proxyForUrl } from '../net'

/**
 * 附加「在线数据源」（V1.5.2）—— 规则嗅探之外的第二类在线源。
 *
 * 用户给了四条路径，这里按“能稳定实现的先做、需要逆向的先标记为受限”落地：
 *
 *  1. **Apple CMS（V10）采集站**：标准 `?ac=videolist/detail` JSON 接口，最稳、可配置多个站点。
 *     番剧只是它的“动漫”分类，播放地址通常是 m3u8 —— 直接交给播放器即可。
 *  2. **Consumet / aniwatch 风格 REST**：把抓取逻辑外包给一个自托管进程（用户填 base URL）。
 *     这是用户列出的“路径三”，对客户端最省心：接口变了只换服务端。
 *  3. **AnimePahe**：搜索与集数列表是标准 JSON；播放地址在 kwik 播放器里，
 *     镜像偶尔直接暴露 m3u8，这里尽力解析，失败会给出明确原因。
 *  4. **AllManga / AllAnime**：AniList 搜元数据 + AllAnime GraphQL 取剧集与 sourceUrls。
 *     ⚠️ sourceUrls 是 `--<hex>` 形式，需要一张**置换表**才能还原成真实地址；
 *     该表随上游反爬策略变动，本版本**没有**把它硬编码进去（那样只会悄悄给出错地址）。
 *     所以 AllManga 目前只提供“搜索 / 集数”，播放会明确报“解析步骤尚未实现（需上游校验）”。
 *
 * 为什么不把四条都做成“能用”：上游能力本来就不一致（需要逆向 / 需要自托管），
 * 宁可在界面上如实标注每条路径的状态，也不伪造成功。
 */

export const ONLINE_SOURCES: OnlineSourceMeta[] = [
  {
    id: 'applecms',
    name: 'Apple CMS 采集站',
    desc: '标准 V10 采集接口（?ac=videolist / ?ac=detail），m3u8 直出；在设置里填接口地址即可',
    canPlay: true,
    needsConfig: 'cms'
  },
  {
    id: 'rest',
    name: '自托管 REST（Consumet / aniwatch）',
    desc: '把抓取逻辑交给独立服务：填一个兼容 Consumet 的 base URL，客户端只做搜索/集数/取流',
    canPlay: true,
    needsConfig: 'rest'
  },
  {
    id: 'animepahe',
    name: 'AnimePahe',
    desc: '搜索与集数走公开 JSON；播放地址在 kwik 播放器里，尽力解析（可能被 Cloudflare 拦）',
    canPlay: true,
    needsConfig: 'none'
  },
  {
    id: 'allmanga',
    name: 'AllManga / AllAnime（实验）',
    desc: 'AniList 元数据 + AllAnime GraphQL；sourceUrls 用「hex + 异或」还原，上游换方案时可能失效',
    canPlay: true,
    needsConfig: 'none'
  }
]

interface OnlineSettings {
  cmsApis?: string[]
  restBase?: string
  allanimeBase?: string
}

function cfg(): OnlineSettings {
  const s = getSettings() as AppSettings & { onlineSources?: OnlineSettings }
  const o = s.onlineSources ?? {}
  return {
    cmsApis: Array.isArray(o.cmsApis) ? o.cmsApis.map((x) => String(x).trim()).filter(Boolean) : [],
    restBase: String(o.restBase ?? '').trim().replace(/\/+$/, ''),
    allanimeBase: String(o.allanimeBase ?? '').trim().replace(/\/+$/, '')
  }
}

/** 统一的浏览器头（这些源基本都有 CF/WAF，裸请求必被拒） */
function browserHeaders(referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json,text/plain,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7'
  }
  if (referer) {
    h.Referer = referer
    try {
      h.Origin = new URL(referer).origin
    } catch {
      /* ignore */
    }
  }
  return h
}

async function getJson<T>(url: string, referer?: string, timeout = 12_000): Promise<T> {
  const res = await axios.get(url, {
    timeout,
    headers: browserHeaders(referer),
    responseType: 'text',
    transformResponse: (d: unknown) => d,
    validateStatus: () => true,
    ...buildProxyAgents(proxyForUrl(url))
  })
  if (res.status >= 400) throw new Error(`${safeHost(url)} 返回 HTTP ${res.status}`)
  const text = String(res.data ?? '')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${safeHost(url)} 返回的不是 JSON（可能被拦截或接口已变更）`)
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '站点'
  }
}

/* ───────────────────────── ① Apple CMS V10 ───────────────────────── */

function cmsBase(): string {
  const list = cfg().cmsApis ?? []
  return list[0] ?? ''
}

async function cmsSearch(keyword: string): Promise<OnlineSearchItem[]> {
  const base = cmsBase()
  if (!base) throw new Error('还没有配置 Apple CMS 接口：请在「设置 → 在线数据源（测试）」里填一个采集站 api 地址')
  const url = `${base}${base.includes('?') ? '&' : '?'}ac=videolist&wd=${encodeURIComponent(keyword)}&pg=1`
  const data = await getJson<{ list?: Record<string, unknown>[] }>(url, base)
  const list = Array.isArray(data.list) ? data.list : []
  return list
    .map((it) => ({
      source: 'applecms' as const,
      id: String(it.vod_id ?? ''),
      title: String(it.vod_name ?? ''),
      year: it.vod_year ? String(it.vod_year) : undefined,
      cover: it.vod_pic ? String(it.vod_pic) : undefined,
      remark: it.vod_remarks ? String(it.vod_remarks) : undefined
    }))
    .filter((x) => x.id && x.title)
}

async function cmsEpisodes(item: OnlineSearchItem): Promise<OnlineEpisodeItem[]> {
  const base = cmsBase()
  const url = `${base}${base.includes('?') ? '&' : '?'}ac=detail&ids=${encodeURIComponent(item.id)}`
  const data = await getJson<{ list?: Record<string, unknown>[] }>(url, base)
  const one = Array.isArray(data.list) ? data.list[0] : null
  if (!one) return []
  const playUrl = String(one.vod_play_url ?? '')
  const from = String(one.vod_play_from ?? '')
  // vod_play_url 形如 `第01集$url#第02集$url`；多条线路用 $$$ 分隔、与 vod_play_from 对应
  const groups = playUrl.split('$$$')
  const froms = from.split('$$$')
  const prefer = Math.max(0, froms.findIndex((f) => /m3u8|hls|线路/i.test(f)))
  const group = groups[prefer] ?? groups[0] ?? ''
  return group
    .split('#')
    .map((seg, i) => {
      const [name, url] = seg.split('$')
      return { index: i, title: (name || `第 ${i + 1} 集`).trim(), playId: (url || '').trim() }
    })
    .filter((e) => /^https?:\/\//i.test(e.playId))
}

/* ───────────────────── ② 自托管 REST（Consumet / aniwatch） ───────────────────── */

async function restSearch(keyword: string): Promise<OnlineSearchItem[]> {
  const base = cfg().restBase
  if (!base) throw new Error('还没有配置 REST base URL：可在「设置 → 在线数据源（测试）」里填自托管的 Consumet / aniwatch 服务地址')
  const data = await getJson<unknown>(`${base}/anime/search/${encodeURIComponent(keyword)}`, base)
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { results?: unknown[] })?.results)
      ? (data as { results: unknown[] }).results
      : []
  return arr
    .map((raw) => {
      const it = raw as Record<string, unknown>
      const cover = it.image ?? (it.cover as string | undefined) ?? it.poster
      return {
        source: 'rest' as const,
        id: String(it.id ?? ''),
        title: String(it.title ?? it.name ?? ''),
        year: it.releaseDate ? String(it.releaseDate).slice(0, 4) : it.year ? String(it.year) : undefined,
        cover: cover ? String(cover) : undefined,
        remark: it.subOrDub ? String(it.subOrDub) : undefined
      }
    })
    .filter((x) => x.id && x.title)
}

async function restEpisodes(item: OnlineSearchItem): Promise<OnlineEpisodeItem[]> {
  const base = cfg().restBase
  const data = await getJson<unknown>(`${base}/anime/${encodeURIComponent(item.id)}/episodes`, base)
  const arr = Array.isArray(data) ? data : (data as { episodes?: unknown[] })?.episodes ?? []
  return arr
    .map((raw, i) => {
      const it = raw as Record<string, unknown>
      const num = Number(it.number ?? it.episode ?? i + 1)
      return {
        index: Number.isFinite(num) ? num - 1 : i,
        title: String(it.title ?? `第 ${Number.isFinite(num) ? num : i + 1} 集`),
        playId: String(it.id ?? it.episodeId ?? '')
      }
    })
    .filter((e) => e.playId)
    .sort((a, b) => a.index - b.index)
}

async function restResolve(item: OnlineSearchItem, ep: OnlineEpisodeItem): Promise<OnlineResolveResult> {
  const base = cfg().restBase
  const url = `${base}/anime/episode-srcs?id=${encodeURIComponent(ep.playId)}&server=hd-1&category=sub`
  const data = await getJson<{
    sources?: { url?: string; isM3U8?: boolean }[]
    headers?: Record<string, string>
    referer?: string
  }>(url, base)
  const src = (data.sources ?? []).find((s) => typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
  if (!src?.url) throw new Error('REST 服务没有返回可播放的 sources[].url（换一个 server 或检查服务端日志）')
  return { url: src.url, referer: data.referer ?? data.headers?.Referer, headers: data.headers }
}

/* ───────────────────────── ③ AnimePahe ───────────────────────── */

const ANIMEPAHE = 'https://animepahe.ru'

async function paheSearch(keyword: string): Promise<OnlineSearchItem[]> {
  const data = await getJson<{ data?: Record<string, unknown>[] }>(
    `${ANIMEPAHE}/api?m=search&q=${encodeURIComponent(keyword)}`,
    `${ANIMEPAHE}/`
  )
  const arr = Array.isArray(data.data) ? data.data : []
  return arr
    .map((it) => ({
      source: 'animepahe' as const,
      id: String(it.id ?? ''),
      title: String(it.title ?? ''),
      year: it.year ? String(it.year) : undefined,
      cover: it.poster ? String(it.poster) : undefined,
      remark: it.type ? String(it.type) : undefined
    }))
    .filter((x) => x.id && x.title)
}

async function paheEpisodes(item: OnlineSearchItem): Promise<OnlineEpisodeItem[]> {
  const data = await getJson<{ data?: Record<string, unknown>[] }>(
    `${ANIMEPAHE}/api?m=release&id=${encodeURIComponent(item.id)}&sort=episode_asc&page=1`,
    `${ANIMEPAHE}/anime/${item.id}`
  )
  const arr = Array.isArray(data.data) ? data.data : []
  return arr
    .map((it, i) => {
      const num = Number(it.episode ?? i + 1)
      return {
        index: Number.isFinite(num) ? num - 1 : i,
        title: `第 ${Number.isFinite(num) ? num : i + 1} 集`,
        playId: String(it.session ?? '')
      }
    })
    .filter((e) => e.playId)
    .sort((a, b) => a.index - b.index)
}

/**
 * 解析 kwik 播放页里的 m3u8。
 *
 * kwik（animepahe 的播放器域）会把地址塞进一段混淆 JS 里；不同镜像的写法不一样。
 * 这里做两件事：
 *   1. 直接在页面 HTML 里找 `*.m3u8`（部分镜像/新版本是明文）；
 *   2. 找 `source:'<url>'` / `"file":"<url>"` 这类键值。
 * 找不到就抛明确原因（"kwik 页面没有直接暴露 m3u8，可能启用了额外混淆"），
 * 而不是返回一个会让播放器黑屏的假地址。
 */
async function paheResolve(item: OnlineSearchItem, ep: OnlineEpisodeItem): Promise<OnlineResolveResult> {
  const playUrl = `${ANIMEPAHE}/play/${item.id}/${ep.playId}`
  const res = await axios.get(playUrl, {
    timeout: 15_000,
    headers: browserHeaders(`${ANIMEPAHE}/`),
    responseType: 'text',
    transformResponse: (d: unknown) => d,
    validateStatus: () => true,
    ...buildProxyAgents(proxyForUrl(playUrl))
  })
  if (res.status >= 400) throw new Error(`AnimePahe 播放页返回 HTTP ${res.status}（可能被 Cloudflare 拦截）`)
  const html = String(res.data ?? '')
  const m3u8 = /https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/i.exec(html)
  if (m3u8) return { url: m3u8[0].replace(/\\\//g, '/'), referer: `${ANIMEPAHE}/` }
  const varMatch = /(?:source|file)\s*[:=]\s*['"](https?:\/\/[^'"]+)['"]/i.exec(html)
  if (varMatch) return { url: varMatch[1].replace(/\\\//g, '/'), referer: `${ANIMEPAHE}/` }
  const kwik = /https?:\/\/kwik\.[^\s"']+\/e\/[^\s"']+/i.exec(html)
  if (kwik) {
    const k = await axios.get(kwik[0], {
      timeout: 15_000,
      headers: browserHeaders(`${ANIMEPAHE}/`),
      responseType: 'text',
      transformResponse: (d: unknown) => d,
      validateStatus: () => true,
      ...buildProxyAgents(getSettings().proxy)
    })
    const khtml = String(k.data ?? '')
    const m = /https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/i.exec(khtml)
    if (m) return { url: m[0].replace(/\\\//g, '/'), referer: 'https://kwik.cx/' }
  }
  throw new Error('AnimePahe：播放页没有直接暴露 m3u8（kwik 额外混淆/需要浏览器环境），这条路径暂时不可用')
}

/* ───────────────────── ④ AllManga / AllAnime（只完成搜索/集数） ───────────────────── */

const ALLANIME = 'https://api.allanime.day'
const ALLANIME_REFERER = 'https://allmanga.to'

async function allmangaGql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const base = cfg().allanimeBase || ALLANIME
  const url = `${base}/api?variables=${encodeURIComponent(JSON.stringify(variables))}&query=${encodeURIComponent(query)}`
  const res = await axios.get(url, {
    timeout: 15_000,
    headers: browserHeaders(ALLANIME_REFERER),
    responseType: 'text',
    transformResponse: (d: unknown) => d,
    validateStatus: () => true,
    ...buildProxyAgents(proxyForUrl(url))
  })
  if (res.status >= 400) throw new Error(`AllAnime 返回 HTTP ${res.status}（接口可能需要新的鉴权参数）`)
  const data = JSON.parse(String(res.data ?? '{}')) as { data?: T; errors?: { message?: string }[] }
  if (data.errors?.length) throw new Error(`AllAnime：${data.errors[0]?.message ?? 'GraphQL 错误'}`)
  if (!data.data) throw new Error('AllAnime 返回空数据（接口可能已变更）')
  return data.data
}

async function allmangaSearch(keyword: string): Promise<OnlineSearchItem[]> {
  const query =
    'query ($search: SearchInput, $limit: Int, $page: Int, $translationType: VaildTranslationTypeEnumType, $countryOrigin: VaildCountryOriginEnumType) { shows(search: $search, limit: $limit, page: $page, translationType: $translationType, countryOrigin: $countryOrigin) { edges { _id name englishName availableEpisodes __typename } } }'
  const data = await allmangaGql<{
    shows?: { edges?: { _id?: string; name?: string; englishName?: string; availableEpisodes?: Record<string, number> }[] }
  }>(query, {
    search: { allowAdult: false, allowUnknown: false, query: keyword },
    limit: 40,
    page: 1,
    translationType: 'sub',
    countryOrigin: 'ALL'
  })
  const edges = data.shows?.edges ?? []
  return edges
    .map((e) => ({
      source: 'allmanga' as const,
      id: String(e._id ?? ''),
      title: String(e.englishName || e.name || ''),
      remark: e.availableEpisodes?.sub ? `${e.availableEpisodes.sub} 集` : undefined
    }))
    .filter((x) => x.id && x.title)
}

async function allmangaEpisodes(item: OnlineSearchItem): Promise<OnlineEpisodeItem[]> {
  const query = 'query ($showId: String!) { show(_id: $showId) { _id availableEpisodesDetail } }'
  const data = await allmangaGql<{ show?: { availableEpisodesDetail?: Record<string, string[]> } }>(query, {
    showId: item.id
  })
  const subs = data.show?.availableEpisodesDetail?.sub ?? []
  return subs
    .map((n, i) => {
      const num = Number(n)
      return {
        index: Number.isFinite(num) ? num - 1 : i,
        title: `第 ${n} 集`,
        playId: String(n)
      }
    })
    .sort((a, b) => a.index - b.index)
}

async function allmangaResolve(item: OnlineSearchItem, ep: OnlineEpisodeItem): Promise<OnlineResolveResult> {
  const query =
    'query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) { episode(showId: $showId, translationType: $translationType, episodeString: $episodeString) { episodeString sourceUrls } }'
  const data = await allmangaGql<{ episode?: { sourceUrls?: unknown[] } }>(query, {
    showId: item.id,
    translationType: 'sub',
    episodeString: ep.playId
  })
  const raw = (data.episode?.sourceUrls ?? []).filter((u): u is string => typeof u === 'string' && u.length > 0)
  if (raw.length === 0) throw new Error('AllManga：这一集没有返回 sourceUrls（可能需要换集或接口已变更）')
  const tried: string[] = []
  for (const encoded of raw) {
    const decoded = decodeAllanimeSource(encoded)
    if (!decoded) {
      tried.push('解码失败')
      continue
    }
    try {
      const media = await allanimeMediaFrom(decoded)
      if (media) {
        log.append('info', 'online', `[AllManga]「${item.title}」第 ${ep.playId} 集已解析到媒体地址：${safeHost(media)}`)
        return { url: media, referer: ALLANIME_REFERER }
      }
      tried.push(decoded.slice(0, 60))
    } catch (err) {
      tried.push(String((err as Error)?.message ?? err).slice(0, 60))
    }
  }
  throw new Error(`AllManga：sourceUrls 解出来了但都没有可播放地址（${tried.slice(0, 3).join('；')}）`)
}

/**
 * AllAnime 的 `--<hex>` sourceUrls 解码（V1.5.2 补齐）。
 *
 * 上游方案（ani-cli 的实现）是：hex → 字节，再对每个字节与 "1234567890123456789" 的 ASCII 逐位异或。
 * 历史实现里这个循环写成了“每个字节都把整个 key 异或一遍”，等价于**单字节常量掩码**；
 * 但上游也可能换成“按位置循环取 key”。两种都可能，所以这里**两个都试**，
 * 并用结果形态（必须是 http(s) 地址或以 / 开头的站内路径）来判定哪个是对的 ——
 * 这样上游换实现时不需要我们改代码，只有两种都对不上才报错。
 */
function decodeAllanimeSource(encoded: string): string | null {
  const hex = encoded.replace(/^--/, '').trim()
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  const key = '1234567890123456789'
  const keyCodes = [...key].map((c) => c.charCodeAt(0))
  const maskAll = keyCodes.reduce((a, b) => a ^ b, 0)
  const candidates: string[] = [
    // 常量掩码（历史实现）
    Buffer.from(bytes.map((b) => b ^ maskAll)).toString('utf-8'),
    // 按位置循环取 key（更符合“密钥”的直觉）
    Buffer.from(bytes.map((b, i) => b ^ keyCodes[i % keyCodes.length])).toString('utf-8'),
    // 完全没有异或（上游若改回明文）
    Buffer.from(bytes).toString('utf-8')
  ]
  const valid = (s: string): boolean => {
    const t = s.trim()
    if (!t) return false
    if (!/^(https?:\/\/|\/)/i.test(t)) return false
    // 允许的字符集（避免把随机噪声当成地址）
    return /^[\x20-\x7e]+$/.test(t)
  }
  return candidates.map((c) => c.trim()).find(valid) ?? null
}

/** 把解码出来的站内路径/地址换成真正的媒体地址（clock 接口会再返回一层 links） */
async function allanimeMediaFrom(decoded: string): Promise<string | null> {
  const base = cfg().allanimeBase || ALLANIME
  const abs = /^https?:\/\//i.test(decoded) ? decoded : `${base.replace(/\/api$/, '')}${decoded}`
  const direct = /\.(m3u8|mp4)(\?|$)/i.exec(abs)
  if (direct) return abs
  // clock.json 会返回 {links:[{link, hls, resolutionStr}]} 或 {link:...}
  const res = await axios.get(abs, {
    timeout: 15_000,
    headers: browserHeaders(ALLANIME_REFERER),
    responseType: 'text',
    transformResponse: (d: unknown) => d,
    validateStatus: () => true,
    ...buildProxyAgents(proxyForUrl(abs))
  })
  if (res.status >= 400) return null
  const text = String(res.data ?? '')
  const hls = /"hls"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? /"link"\s*:\s*"([^"]+)"/.exec(text)?.[1]
  if (!hls) {
    const plain = /https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*/i.exec(text)
    return plain ? plain[0].replace(/\\\//g, '/') : null
  }
  return hls.replace(/\\\//g, '/')
}

/* ───────────────────────── 统一入口 ───────────────────────── */

function metaOf(source: OnlineSourceId): OnlineSourceMeta {
  return ONLINE_SOURCES.find((s) => s.id === source) ?? ONLINE_SOURCES[0]
}

export async function onlineSearch(source: OnlineSourceId, keyword: string): Promise<OnlineSearchItem[]> {
  const kw = String(keyword ?? '').trim()
  if (!kw) return []
  const t0 = Date.now()
  try {
    const list =
      source === 'applecms'
        ? await cmsSearch(kw)
        : source === 'rest'
          ? await restSearch(kw)
          : source === 'animepahe'
            ? await paheSearch(kw)
            : await allmangaSearch(kw)
    log.append('info', 'online', `[${metaOf(source).name}] 搜索「${kw}」：${list.length} 条（${Date.now() - t0}ms）`)
    return list
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 160)
    log.append('warn', 'online', `[${metaOf(source).name}] 搜索失败：${msg}`)
    throw new Error(msg)
  }
}

export async function onlineEpisodes(source: OnlineSourceId, item: OnlineSearchItem): Promise<OnlineEpisodeItem[]> {
  try {
    const list =
      source === 'applecms'
        ? await cmsEpisodes(item)
        : source === 'rest'
          ? await restEpisodes(item)
          : source === 'animepahe'
            ? await paheEpisodes(item)
            : await allmangaEpisodes(item)
    log.append('info', 'online', `[${metaOf(source).name}]「${item.title}」集数：${list.length}`)
    return list
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 160)
    log.append('warn', 'online', `[${metaOf(source).name}] 取集数失败：${msg}`)
    throw new Error(msg)
  }
}

export async function onlineResolve(
  source: OnlineSourceId,
  item: OnlineSearchItem,
  ep: OnlineEpisodeItem
): Promise<OnlineResolveResult> {
  try {
    if (source === 'applecms') {
      if (!/^https?:\/\//i.test(ep.playId)) throw new Error('Apple CMS 这一集没有可用的播放地址')
      return { url: ep.playId, referer: cmsBase() }
    }
    if (source === 'rest') return await restResolve(item, ep)
    if (source === 'animepahe') return await paheResolve(item, ep)
    return await allmangaResolve(item, ep)
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 180)
    log.append('warn', 'online', `[${metaOf(source).name}] 解析播放地址失败：${msg}`)
    throw new Error(msg)
  }
}

/** 设置页/自检用：各源当前是否具备可用条件 */
export function onlineSourceAvailability(): OnlineSourceAvailability[] {
  const c = cfg()
  return ONLINE_SOURCES.map((s) => {
    if (s.needsConfig === 'cms') {
      const apis = c.cmsApis ?? []
      return {
        id: s.id,
        name: s.name,
        ready: apis.length > 0,
        reason: apis.length > 0 ? `${apis.length} 个接口` : '未配置采集站接口'
      }
    }
    if (s.needsConfig === 'rest') {
      return { id: s.id, name: s.name, ready: !!c.restBase, reason: c.restBase ? '已配置' : '未配置 base URL' }
    }
    return { id: s.id, name: s.name, ready: true, reason: s.canPlay ? '可用' : '仅搜索/集数' }
  })
}

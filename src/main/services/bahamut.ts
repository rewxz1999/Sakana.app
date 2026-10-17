import axios from 'axios'
import type { RuleEpisode, RuleEpisodeGroup, RuleEpisodesResult, RulePlayResult, RuleSearchEntry } from '@shared/types'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import { bangumi } from './bangumi'

/**
 * 巴哈姆特动画疯的**库驱动执行分支**（v1.1）。
 *
 * ## 为什么不是一条 XPath 规则（结论与证据）
 *
 * 用户要求用 npm 包 `bahamut-anime`。把它下下来拆开看（`lib/index.js` / `lib/index.d.ts`），
 * 它只有四个只读接口，全部是对 `https://api.gamer.com.tw/mobile_app/anime/` 的薄封装：
 *
 * | 能力 | 端点 | 返回 |
 * | --- | --- | --- |
 * | 搜索 | `v1/search.php?kw=` | `anime[] { anime_sn, title }` |
 * | 番剧详情 | `v3/video.php?anime_sn=` | `data.anime { title, volumes: {0..3: [{video_sn, volume}]} }` |
 * | 单集详情 | `v3/video.php?sn=` | `data.video { video_sn, title, duration… }` |
 * | 弹幕/广告 | `v3/token.php?sn=` | `{ danmu, ad }`（上一轮实测这个会抛错） |
 *
 * **包内没有任何一个接口返回视频流地址**。真正能播的地址是站点播放器在
 * `ani.gamer.com.tw/animeVideo.php?sn=…` 页面里再向 `/ajax/m3u8.php` 取的一次性 HLS，
 * 那一步不在包里，而且站点对非台湾 IP 直接拒绝。所以本模块能确定给出的是
 * 「条目 + 选集（四个卷）」，播放地址只能给到官方观看页、由通用嗅探去试着接。
 * 这条限制通过规则的 `playbackNote` 如实显示在界面上（shared/bahamutRule.ts）。
 *
 * ## 为什么先试 npm 包、再退回同一批接口
 *
 * - 用户点名要用这个包：装了就必须优先用它（行为与包完全一致，含它自己的 60 秒缓存）；
 * - 但包是**运行时依赖**，沙箱里可能装不上/用户可能没装。此时用同一批公开接口
 *   （两个 GET）得到同样的数据，功能不会整条消失 —— 而"少一个依赖就整条规则不可用"
 *   是最没有必要的失败模式。
 *
 * ## 网络现实（本机实测，写进报告）
 *
 * `api.gamer.com.tw:443` / `ani.gamer.com.tw:443` 在本机 **TCP 连接超时**
 * （DNS 正常返回 202.160.128.195 / 108.160.169.37），这是站点对非台湾地区的封锁。
 * 所以这里的错误一律翻译成「连不上巴哈姆特（站点仅对台湾网络开放）」，
 * 不再是一句 `timeout of 20000ms exceeded`。
 */

const API_BASE = 'https://api.gamer.com.tw/mobile_app/anime/'
const WATCH_PAGE = 'https://ani.gamer.com.tw/animeVideo.php?sn='
const SITE = 'https://ani.gamer.com.tw/'

/** 卷号 → 中文名。顺序即界面里的线路顺序（与 bahamut-anime README 一致） */
const VOLUME_LABEL: Record<string, string> = {
  '0': '日语版',
  '1': '剧场版',
  '2': 'OVA',
  '3': '中配'
}

interface BahaVolumeItem {
  volume?: number
  video_sn?: number
  state?: number
  cover?: string
}

interface BahaAnime {
  anime_sn?: number
  title?: string
  volumes?: Record<string, BahaVolumeItem[]>
}

/** 站点连不上时给用户看的话（不要让 axios 的英文原文直接出现在界面/日志里） */
function translateError(err: unknown): string {
  const e = err as { code?: string; message?: string; response?: { status?: number } }
  const code = String(e?.code ?? '')
  const msg = String(e?.message ?? err)
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(msg)) {
    return '连不上巴哈姆特（请求超时）：站点只对台湾网络开放，当前网络到 api.gamer.com.tw 的 TCP 连接被丢弃'
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `巴哈姆特域名解析失败：${msg}`
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED') {
    return `连不上巴哈姆特（${code}）：站点可能对该网络区域限制访问`
  }
  if (e?.response?.status) return `巴哈姆特接口返回 HTTP ${e.response.status}`
  return `巴哈姆特接口请求失败：${msg.slice(0, 160)}`
}

/** 统一的 GET JSON（走 axios，因此自动享有 net.ts 的证书错误兜底与代理设置） */
async function getJson<T>(url: string): Promise<T> {
  const res = await axios.get<T>(url, {
    timeout: 20_000,
    responseType: 'json',
    maxRedirects: 5,
    headers: {
      'User-Agent': BROWSER_UA,
      // 站点会校验 Referer/Origin：缺了它们即使网络可达也拿不到数据
      Referer: SITE,
      Origin: SITE,
      Accept: 'application/json, text/plain, */*'
    },
    ...buildProxyAgents(getSettings().proxy)
  })
  return res.data
}

/**
 * 搜索结果的会话内缓存。
 *
 * 为什么需要：预嗅探（ruleBatchProbe）与用户点开某个条目会**连续**问同一批接口，
 * 包自己也带了 60 秒缓存 —— 这里对齐成同一策略，避免"预嗅探刚问过、点开又问一次"
 * 把本就严格的站点风控再撞一遍。
 */
const searchCache = new Map<string, { at: number; items: RuleSearchEntry[] }>()
const SEARCH_TTL = 60_000
const animeCache = new Map<number, { at: number; anime: BahaAnime }>()
const ANIME_TTL = 5 * 60_000

/**
 * 决定用哪个词搜索。
 *
 * 用户明确说过「搜索只认繁体名/日文名（简中名搜不到）」，而番剧原名要
 * **从我们自己的 bangumi 数据源取**：`api.bangumi.subject(id).name` 是日文原名。
 * 所以有 subjectId 时优先用它；拿不到（或就是同一个词）才退回界面传进来的关键词。
 */
export async function bahamutSearchTerm(
  keyword: string,
  subjectId?: number
): Promise<{ term: string; from: 'bangumi-原名' | '关键词' }> {
  if (subjectId && subjectId > 0) {
    try {
      const s = await bangumi.subject(subjectId)
      const original = String(s.data?.name ?? '').trim()
      if (original) return { term: original, from: 'bangumi-原名' }
    } catch (err) {
      // 取不到原名不是致命问题：退回关键词继续搜，只是命中率会低（简中往往搜不到）
      log.append('warn', 'bahamut', `取番剧原名失败，改用关键词搜索：${String((err as Error)?.message ?? err).slice(0, 120)}`)
    }
  }
  return { term: String(keyword ?? '').trim(), from: '关键词' }
}

/** 搜索：返回条目（link 用伪协议 `baha:anime/<sn>`，避免与真实网页地址混淆） */
export async function bahamutSearch(
  keyword: string,
  subjectId?: number
): Promise<{ items: RuleSearchEntry[]; error?: string }> {
  const { term, from } = await bahamutSearchTerm(keyword, subjectId)
  if (!term) return { items: [], error: '没有可用的搜索词（番剧原名与关键词都为空）' }
  const cached = searchCache.get(term)
  if (cached && Date.now() - cached.at < SEARCH_TTL) return { items: cached.items }

  const t0 = Date.now()
  try {
    const json = await getJson<{ anime?: { anime_sn?: number; title?: string }[] }>(
      `${API_BASE}v1/search.php?kw=${encodeURIComponent(term)}`
    )
    const items: RuleSearchEntry[] = (json?.anime ?? [])
      .filter((a) => a && a.anime_sn)
      .map((a) => ({
        name: String(a.title ?? '').replace(/\[[^\]]+\]$/, '').trim(),
        link: `baha:anime/${a.anime_sn}`,
        source: String(a.anime_sn)
      }))
    searchCache.set(term, { at: Date.now(), items })
    log.append(
      'info',
      'bahamut',
      `搜索「${term}」（来自${from}）命中 ${items.length} 条，耗时 ${Date.now() - t0}ms`
    )
    if (items.length === 0) {
      return {
        items,
        error:
          `巴哈姆特没有这部番（用${from}「${term}」搜索）：该站只认繁体中文名/日文原名，` +
          '简体中文名会搜不到'
      }
    }
    return { items }
  } catch (err) {
    const msg = translateError(err)
    log.append('warn', 'bahamut', `搜索失败：${msg}`)
    return { items: [], error: msg }
  }
}

/** 番剧详情（带缓存）：只为了拿 volumes（四个卷的 video_sn 列表） */
async function loadAnime(animeSn: number): Promise<BahaAnime | null> {
  const hit = animeCache.get(animeSn)
  if (hit && Date.now() - hit.at < ANIME_TTL) return hit.anime
  const json = await getJson<{ data?: { anime?: BahaAnime } }>(
    `${API_BASE}v3/video.php?anime_sn=${animeSn}`
  )
  const anime = json?.data?.anime ?? null
  if (anime) animeCache.set(animeSn, { at: Date.now(), anime })
  return anime
}

/** 从条目的 link/source 里取出 anime_sn */
export function bahamutAnimeSn(entry: { link?: string; source?: string }): number {
  const src = String(entry?.source ?? '').trim()
  if (/^\d+$/.test(src)) return Number(src)
  const m = String(entry?.link ?? '').match(/baha:anime\/(\d+)/)
  return m ? Number(m[1]) : 0
}

/**
 * 选集：按卷分组。
 *
 * `bahamut-anime` 的 `episodes()` 返回 `{0,1,2,3: Episode[]}`，
 * 0=日语版 / 1=剧场版 / 2=OVA / 3=中配 —— 这里直接映射成界面的"线路"分组。
 * 某些卷不存在（大多数番只有 0），就只显示存在的那几卷。
 */
export async function bahamutEpisodes(entry: RuleSearchEntry): Promise<RuleEpisodesResult> {
  const sn = bahamutAnimeSn(entry)
  if (!sn) {
    return { groups: [], vars: {}, error: '这条搜索结果的巴哈姆特条目号缺失，无法取选集' }
  }
  try {
    const anime = await loadAnime(sn)
    if (!anime) return { groups: [], vars: {}, error: '巴哈姆特详情接口没有返回 anime 字段' }
    const groups: RuleEpisodeGroup[] = []
    for (const key of Object.keys(anime.volumes ?? {})) {
      const list = anime.volumes?.[key] ?? []
      const episodes: RuleEpisode[] = list
        .filter((x) => x && x.video_sn)
        .map((x, i) => ({
          // 接口只给 volume（第几集）与 video_sn，没有标题 —— 如实按集号命名
          name: `第${Number(x.volume ?? 0) || i + 1}集`,
          link: `baha:video/${x.video_sn}`
        }))
      if (episodes.length === 0) continue
      groups.push({ lineName: VOLUME_LABEL[key] ?? `卷 ${key}`, episodes })
    }
    if (groups.length === 0) {
      return {
        groups: [],
        vars: { animeSn: String(sn) },
        error: '巴哈姆特这条番的卷列表为空（可能尚未上架或仅限台湾地区）'
      }
    }
    log.append(
      'info',
      'bahamut',
      `选集解析：${groups.map((g) => `${g.lineName}×${g.episodes.length}`).join(' / ')}（anime_sn=${sn}）`
    )
    return { groups, vars: { animeSn: String(sn) } }
  } catch (err) {
    const msg = translateError(err)
    log.append('warn', 'bahamut', `选集解析失败：${msg}`)
    return { groups: [], vars: {}, error: msg }
  }
}

/**
 * 播放地址：**官方观看页**（不是视频直链）。
 *
 * 为什么给页面地址而不是直链：包里没有直链接口，站点播放器才持有一次性 m3u8 的令牌。
 * 交给通用嗅探（ruleProbe）打开这个页面，页面自己会去取 m3u8 —— 能抓到就播，
 * 抓不到（地区限制/需要登录）会如实报"未捕获到视频流"，而不是给一个假的直链。
 */
export function bahamutPlay(episodeLink: string): RulePlayResult {
  const m = String(episodeLink ?? '').match(/baha:video\/(\d+)/)
  if (!m) throw new Error('巴哈姆特的选集地址里没有 video_sn')
  return { url: `${WATCH_PAGE}${m[1]}`, referer: SITE }
}

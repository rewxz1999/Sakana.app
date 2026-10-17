import { createRequire } from 'node:module'
import type { DanmakuComment } from '@shared/types'
import { log } from '../../log'
import { httpGetText } from '../../net'
import { bangumi } from '../bangumi'
import type { DanmakuFetcher, FetcherContext, FetcherEntry, FetcherEpisodeRef } from './types'
import { FETCH_STEPS } from './types'

/**
 * 巴哈姆特动画疯获取器（V1.2）。
 *
 * ## 用户点名要用 npm 包 `bahamut-anime`
 * 包的核心是一个 `Fetcher(base)`：`base` 默认 `https://api.gamer.com.tw/mobile_app/anime/`。
 * **本机直连官方接口不通**（站方地区限制，弹幕接口自带 geo=TW,HK），所以我们把 base 换成
 * 社区反代 `https://bahamut-api-proxy.netlify.app/mobile_app/anime/` —— 这是包的公开构造参数，
 * 不是改包代码。**搜索与取集都走包**（`BahamutAnime.search` / `new Anime(sn).episodes()`）；
 * 包的 search 不回标题，所以并发请求同一个 `v1/search.php` 拿 title/info 用于排季数
 * （原因见 `searchViaPackage` 的实测）。没安装包时搜索/取集走内置等价实现，功能不依赖一次 npm 安装。
 *
 * ## 为什么不用包里的 `episode.danmu()`
 * 实测（2026-10，本机连反代；父代理也独立复核过）：
 *   · `v3/token.php?sn=<videoSn>` 返回 `{"code":0,"message":"APP版本過舊，請更新你的APP版本"}`；
 *   · 包里 `danmu()` 的实现是 `const token = await get('v3/token.php?sn=…'); return token.danmu`，
 *     所以它拿到的是 `undefined`（不是数组），`Promise.all` 之后是一串 undefined，父代理实测直接抛错；
 *   · 同一个 videoSn 走 `anime/v1/danmu.php?videoSn=…&geo=TW,HK` 实测 **3001 条**。
 * 结论：**搜索/取集用包，弹幕不用包**。这是包依赖的 token 接口已经不可用，
 * 不是我们没用包；代码里保留包路径也保证上游修好后能直接受益（换一个方法即可）。
 *
 * ## npm 包的可用性（父代理实测）
 * `bahamut-anime@1.2.0`：
 *   · 搜索在 `new BahamutAnime().search(kw)`（`Anime.search` 不存在，别写错）；
 *   · `new Anime(sn).episodes()` 回 `{0: Episode[]}`，0/1/2/3 = 本篇/剧场版/OVA/中配；
 *   · 默认 base 是 `api.gamer.com.tw`（本机直连被墙），必须把 `Fetcher` 的 base 换成反代；
 *   · 换 base 后繁体名「敗北女角太多了！」352ms 命中 sn=113577，日文名 2100ms 命中，
 *     简体名「败犬女主太多了」→ 0 条（再次印证只认繁体/日文）。
 * 所以 `bahamutBase()` 的优先级是：**数据源里配置的 base → 默认反代常量**。
 *
 * ## 关键词必须是日文名/繁体名
 * 用户两次强调「巴哈只认繁体名/日文名，简中名搜不到」。所以关键词不是直接拿 `state.title`：
 * 先 `bangumi.subject(id).data.name`（日文原名）；没有 subjectId 就按标题反查一次；
 * 再把番剧库别名里的假名/繁体名排在前面。简体标题只在**没有其它关键词**时兜底试一次。
 */

/** 默认基址：社区反代（官方 api.gamer.com.tw 本机 TCP 不通） */
const DEFAULT_BASE = 'https://bahamut-api-proxy.netlify.app'
const UA = 'Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4'
const VOLUME_NAME: Record<string, string> = {
  '0': '本篇（日语）',
  '1': '剧场版/电影',
  '2': 'OVA/特别篇',
  '3': '中文配音'
}
/** 最多解析几个候选条目（每个条目要多打一次 video.php） */
const MAX_CANDIDATES = 4

interface BahamutSearchItem {
  animeSn: number
  title: string
  cover: string
  info: string
}

interface BahamutVolumeItem {
  video_sn?: number
  title?: string
  video_title?: string
}

/** 包里的 Episode 只暴露 sn；这里只声明用到的部分 */
interface PkgEpisode {
  sn: number
}
interface PkgAnime {
  sn: number
  /** 包允许替换 fetcher（默认是全局实例，base 指官方地址） */
  fetcher?: unknown
  title(): Promise<string>
  episodes(): Promise<Record<string, PkgEpisode[]>>
}
interface PkgModule {
  Fetcher: new (base: string) => unknown
  Anime: new (sn: number) => PkgAnime
  BahamutAnime: new (fetcher: unknown) => { search(keyword: string): Promise<PkgAnime[]> }
}

let pkgState: PkgModule | null | undefined
let pkgNoteLogged = false

/**
 * 尝试加载 `bahamut-anime`（可选依赖）。
 *
 * 为什么用 `createRequire(__filename)` 而不是顶层 `import`：
 *   1. 包没安装时不能让整个主进程启动失败（`import` 是静态的，模块解析失败就崩）；
 *   2. electron-vite 的 `externalizeDepsPlugin` 会把它留给运行时 require，打包产物里不会内联；
 *   3. 这样"装了就用、没装就等价实现"是同一份代码，不需要维护两个分支版本。
 */
function loadPackage(): PkgModule | null {
  if (pkgState !== undefined) return pkgState
  try {
    const req = createRequire(__filename)
    const mod = req('bahamut-anime') as Partial<PkgModule>
    pkgState = mod?.Fetcher && mod?.BahamutAnime ? (mod as PkgModule) : null
    if (!pkgNoteLogged) {
      pkgNoteLogged = true
      log.append('info', 'danmaku', pkgState ? 'bahamut-anime 已加载：搜索/取集走 npm 包（标题用同一接口补全）' : 'bahamut-anime 未安装：搜索/取集走同一接口的内置实现')
    }
  } catch {
    pkgState = null
    if (!pkgNoteLogged) {
      pkgNoteLogged = true
      log.append('info', 'danmaku', 'bahamut-anime 未安装：搜索/取集走同一接口的内置实现')
    }
  }
  return pkgState
}

/** 把用户填的基址规范成 `…/mobile_app/anime/`（包与内置实现共用） */
export function bahamutBase(sourceBase?: string): string {
  let base = String(sourceBase ?? '').trim() || DEFAULT_BASE
  base = base.replace(/\/+$/, '')
  if (!/\/mobile_app\/anime$/i.test(base)) base = `${base}/mobile_app/anime`
  return `${base}/`
}

/** 弹幕接口在站点根下（不在 mobile_app/anime 下） */
function bahamutDanmuUrl(videoSn: number, base: string): string {
  const root = base.replace(/\/mobile_app\/anime\/?$/i, '').replace(/\/+$/, '')
  return `${root}/anime/v1/danmu.php?videoSn=${encodeURIComponent(String(videoSn))}&geo=TW,HK`
}

async function getJson<T>(url: string, timeoutMs = 25000): Promise<T> {
  const text = await httpGetText(url, timeoutMs, { headers: { 'User-Agent': UA } })
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`巴哈接口返回的不是 JSON（前 60 字：${text.slice(0, 60)}）`)
  }
}

// ---------------- 标题匹配 ----------------

/** 归一化：全角转半角、去括号补充/年份/来源后缀/标点，用于标题比较 */
function norm(s: string): string {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/[（(【\[{][^）)】\]}]*[）)】\]}]/g, '')
    .replace(/\bfrom\b.*$/i, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[!！?？~～·・:：,，.。'"“”\-—_/\\|]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 从标题解析季数（与内置弹幕库同一套规则，只用于"别串季"） */
function seasonOf(title: string): number {
  const s = String(title ?? '')
  const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const m = /第\s*([0-9一二两三四五六七八九十]{1,3})\s*[季期部クール]/.exec(s)
  if (m) {
    const raw = m[1]
    if (/^\d+$/.test(raw)) return Number(raw)
    if (raw.length === 1) return cn[raw] ?? 1
    if (raw.startsWith('十')) return 10 + (cn[raw[1]] ?? 0)
    if (raw.endsWith('十')) return (cn[raw[0]] ?? 0) * 10
    return (cn[raw[0]] ?? 0) * 10 + (cn[raw[2]] ?? 0)
  }
  const en = /(?:season|s)\s*\.?\s*([0-9]{1,2})(?![0-9])/i.exec(s)
  if (en) return Number(en[1]) || 1
  const part = /part\s*\.?\s*([0-9]{1,2})/i.exec(s)
  if (part) return Number(part[1]) || 1
  return 1
}

const isJapanese = (s: string): boolean => /[\u3040-\u30ff]/.test(String(s ?? ''))

/**
 * 候选条目打分。日文关键词那一路**不要求标题对得上**（巴哈返回的是繁体/日文名，
 * 与简体标题相似度可能为 0，这正是"设置里能搜到、播放时没有源弹幕"的根因）；
 * 但仍要求季数一致，避免把第 2 季的弹幕放到第 1 季。
 */
function scoreCandidate(anime: BahamutSearchItem, ctx: FetcherContext, keyword: string): number {
  const wantSeason = seasonOf(ctx.title)
  if (seasonOf(anime.title) !== wantSeason && (isJapanese(keyword) || seasonOf(anime.title) > 1)) return -1
  const target = norm(ctx.title)
  const cand = norm(anime.title)
  let score = 0
  if (cand && target && cand === target) score = 100
  else if (cand && target && (cand.includes(target) || target.includes(cand))) score = 70
  else {
    const grams = (s: string): Set<string> => {
      const set = new Set<string>()
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
      return set
    }
    const a = grams(target)
    const b = grams(cand)
    let hit = 0
    for (const g of a) if (b.has(g)) hit++
    score = a.size > 0 ? Math.round((hit / a.size) * 40) : 0
  }
  // 日文关键词：巴哈自己的相关性排序更可信，给一个基础分保证候选不会被 0 分全砍掉
  if (isJapanese(keyword)) score = Math.max(score, 30)
  if (/共\s*\d+\s*集/.test(anime.info)) score += 8
  if (anime.info.includes('劇場版') || anime.info.includes('剧场版')) score -= 30
  return score
}

// ---------------- 搜索 ----------------

async function searchViaHttp(keyword: string, base: string): Promise<BahamutSearchItem[]> {
  const data = await getJson<{ anime?: { anime_sn?: number; title?: string; cover?: string; info?: string }[] }>(
    `${base}v1/search.php?kw=${encodeURIComponent(keyword)}`
  )
  return (data?.anime ?? [])
    .filter((a) => Number(a?.anime_sn) > 0)
    .map((a) => ({
      animeSn: Number(a.anime_sn),
      title: String(a.title ?? ''),
      cover: String(a.cover ?? ''),
      info: String(a.info ?? '')
    }))
}

async function episodesViaHttp(animeSn: number, base: string): Promise<{ refs: FetcherEpisodeRef[]; extra: string }> {
  const data = await getJson<{
    data?: { anime?: { volumes?: Record<string, BahamutVolumeItem[]>; total_volume?: number } }
  }>(`${base}v3/video.php?anime_sn=${animeSn}`)
  const vols = data?.data?.anime?.volumes ?? {}
  const refs: FetcherEpisodeRef[] = []
  for (const [volume, arr] of Object.entries(vols)) {
    if (!Array.isArray(arr)) continue
    arr.forEach((item, i) => {
      const sn = Number(item?.video_sn)
      if (!(sn > 0)) return
      refs.push({
        id: String(sn),
        index: i + 1,
        title: String(item?.title ?? item?.video_title ?? `第 ${i + 1} 集`),
        volume,
        volumeName: VOLUME_NAME[volume] ?? `分类 ${volume}`
      })
    })
  }
  return { refs, extra: `${refs.length} 集` }
}

/**
 * 搜索 + 取集（V1.2 实测后的最终形态）。
 *
 * ## 搜索：包的 `BahamutAnime.search()` + 同一接口的标题
 * 包的 `search()` 只回一堆 `Anime` 句柄（**没有标题**），要知道标题与季数就得对每个候选
 * 再调一次 `title()`。实测「葬送のフリーレン」回 2 条：并行取标题花了 **10.6 秒**，
 * 其中一条还超时 —— 首屏等待直接翻倍。
 * 所以这里**并行**做两件事：包的 `search()` 拿候选 animeSn（用户要求优先用包），
 * 同一个 `v1/search.php` 接口拿 title/info 用来排季数。两个请求并发，耗时取较慢的那个，
 * 不会因为标题请求而串行翻倍。
 * 取集用包（`new Anime(sn).episodes()`，包会把 base 换成我们给的反代）。
 *
 * ## 季数闸门
 * 巴哈搜索把"第二季"排在"第一季"前面是常态；先按标题/季数打分再取集，
 * 避免把第二季第 1 集的弹幕放到第一季上。
 */
async function searchViaPackage(
  keyword: string,
  base: string,
  ctx: FetcherContext
): Promise<FetcherEntry[] | null> {
  const mod = loadPackage()
  const fetcher = mod ? new mod.Fetcher(base) : null
  const client = mod && fetcher ? new mod.BahamutAnime(fetcher) : null

  // 包搜索与"带标题的同一接口"并发：包给候选 sn，标题用来排季数
  const [pkgSettled, httpSettled] = await Promise.allSettled([
    client ? client.search(encodeURIComponent(keyword)) : Promise.resolve([] as PkgAnime[]),
    searchViaHttp(keyword, base)
  ])
  if (pkgSettled.status === 'rejected') {
    log.append('warn', 'danmaku', `bahamut-anime 搜索失败，改走内置接口：${String((pkgSettled.reason as Error)?.message ?? pkgSettled.reason)}`)
  }
  const httpList = httpSettled.status === 'fulfilled' ? httpSettled.value : []
  const pkgList = pkgSettled.status === 'fulfilled' ? pkgSettled.value : []
  /*
   * 优先用包给的候选（顺序 = 包/站点的相关性），再用接口返回的标题补全；
   * 包里没有的条目也保留（例如接口多返回了一条），标题为空时仍可参与打分。
   */
  const list: BahamutSearchItem[] = pkgList.length
    ? pkgList.map((a) => {
        const hit = httpList.find((h) => h.animeSn === a.sn)
        return hit ?? { animeSn: a.sn, title: '', cover: '', info: '' }
      })
    : httpList
  if (list.length === 0) return []
  const ranked = list
    .map((a) => ({ a, score: scoreCandidate(a, ctx, keyword) }))
    .filter((x) => x.score >= 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, MAX_CANDIDATES)
  if (ranked.length === 0) {
    log.append('info', 'danmaku', `巴哈搜索「${keyword}」有 ${list.length} 条，但都不符合第 ${seasonOf(ctx.title)} 季`)
    return []
  }

  const out: FetcherEntry[] = []
  ctx.onProgress?.({ step: 2, total: FETCH_STEPS, label: '正在读取巴哈姆特的集数列表…' })
  for (const { a, score } of ranked) {
    let refs: FetcherEpisodeRef[] = []
    let how = '内置接口'
    if (mod && fetcher) {
      try {
        const anime = new mod.Anime(a.animeSn)
        anime.fetcher = fetcher
        const episodes = await anime.episodes()
        for (const [volume, arr] of Object.entries(episodes ?? {})) {
          ;(arr ?? []).forEach((ep, i) => {
            const sn = Number(ep?.sn)
            if (!(sn > 0)) return
            refs.push({
              id: String(sn),
              index: i + 1,
              title: `第 ${i + 1} 集`,
              volume,
              volumeName: VOLUME_NAME[volume] ?? `分类 ${volume}`
            })
          })
        }
        how = 'npm 包'
      } catch (err) {
        log.append('warn', 'danmaku', `bahamut-anime 取集失败，改走内置接口：${String((err as Error)?.message ?? err)}`)
      }
    }
    if (refs.length === 0) {
      try {
        refs = (await episodesViaHttp(a.animeSn, base)).refs
        how = '内置接口（包取集失败）'
      } catch (err) {
        log.append('warn', 'danmaku', `巴哈取集失败（${a.title}）：${String((err as Error)?.message ?? err)}`)
        continue
      }
    }
    if (refs.length === 0) continue
    const entry: FetcherEntry = {
      id: String(a.animeSn),
      // 标题请求失败时用关键词兜底：缓存/日志里至少能看出是哪次搜索
      title: a.title || `${keyword}（anime_sn=${a.animeSn}）`,
      keyword,
      extra: `${refs.length} 集 · ${how} · 相似度 ${score}`,
      episodes: refs,
      raw: { animeSn: a.animeSn, search: a, viaPackage: how === 'npm 包' }
    }
    out.push(entry)
    // 这一条已经能覆盖目标集就不用再为后面的候选取集（省网络往返）
    if (pickEpisode(entry, ctx.episode)) break
  }
  return out
}

// ---------------- 关键词（日文原名） ----------------

interface KeywordCacheEntry {
  at: number
  names: string[]
}
const keywordCache = new Map<string, KeywordCacheEntry>()
const KEYWORD_TTL = 6 * 3600 * 1000

/**
 * 取番剧原名（用户要求：巴哈关键词必须先拿原名）。
 *
 * 顺序：
 *   1. `bangumi.subject(subjectId).data.name` —— 日文原名，最可靠；
 *   2. 没有 subjectId：`bangumi.search(title)` 反查一次，再取 subject；
 *   3. 渲染层给的别名（番剧库详情里的「别名/日文名」）；
 *   4. 以上都没有时才用简体标题兜底（并记日志，说明可能搜不到）。
 */
export async function bahamutKeywords(ctx: FetcherContext & { subjectId?: number }): Promise<string[]> {
  const cacheKey = `${ctx.subjectId ?? ''}|${ctx.title}|${ctx.aliases.join(',')}`
  const cached = keywordCache.get(cacheKey)
  if (cached && Date.now() - cached.at < KEYWORD_TTL) return [...cached.names]

  const names: string[] = []
  const push = (s: unknown): void => {
    const t = String(s ?? '').trim()
    if (t && !names.includes(t)) names.push(t)
  }

  // 用户手动输入的别名优先（它就是要搜的词）
  if (ctx.keyword?.trim()) push(ctx.keyword.trim())
  // 渲染层已经给了日文原名时不需要再反查 Bangumi：少一次网络往返，
  // 而且本地播放/测试场景常常连不上番剧反代（反查会白白干等十几秒）。
  const hasJapaneseAlias = isJapanese(ctx.title) || ctx.aliases.some(isJapanese)

  let subjectId = Number(ctx.subjectId) > 0 ? Number(ctx.subjectId) : 0
  try {
    if (!subjectId && !hasJapaneseAlias) {
      const s = await bangumi.search(ctx.title)
      subjectId = Number(s.items?.[0]?.id) || 0
    }
    if (subjectId > 0) {
      const r = await bangumi.subject(subjectId)
      const d = r.data
      if (d) {
        push(d.name)
        push(d.name_cn)
      }
    }
  } catch (err) {
    log.append('warn', 'danmaku', `取番剧原名失败（${ctx.title}）：${String((err as Error)?.message ?? err)}`)
  }

  // 别名里的假名（日文原名）优先，其次其它与标题不同的写法（常见是繁体译名）
  for (const a of ctx.aliases) if (isJapanese(a)) push(a)
  for (const a of ctx.aliases) if (!isJapanese(a) && norm(a) !== norm(ctx.title)) push(a)
  if (ctx.source?.matchMode === 'keyword' && ctx.source.keyword?.trim()) push(ctx.source.keyword.trim())

  // 兜底：没有日文/繁体线索时，只能拿简体标题试一次（巴哈大概率搜不到，日志里说明）
  if (names.length === 0) {
    push(ctx.title)
    log.append('warn', 'danmaku', `巴哈没有日文/繁体关键词，只能用简体标题「${ctx.title}」试一次（可能搜不到）`)
  }
  keywordCache.set(cacheKey, { at: Date.now(), names: [...names] })
  return names
}

// ---------------- 取弹幕 ----------------

/**
 * `anime/v1/danmu.php` → 统一结构。
 *
 * 字段映射（实测 3001 条样本）：
 *   · `time` 是 **1/10 秒**（样本最大 14450 → 24.1 分钟，与一集长度吻合）；
 *   · `color` 已是 `#RRGGBB`；`size` 1/2 = 小/大；
 *   · `position` 0/1/2 = 滚动/顶部/底部（站点没有文档，按播放器三种样式推断）。
 */
async function fetchBahamutDanmu(videoSn: number, base: string): Promise<{ comments: DanmakuComment[]; raw: number }> {
  const data = await getJson<{
    data?: { danmu?: { text?: string; color?: string; size?: number; position?: number; time?: number }[] }
  }>(bahamutDanmuUrl(videoSn, base), 30000)
  const rows = data?.data?.danmu ?? []
  const comments: DanmakuComment[] = []
  for (const r of rows) {
    const text = String(r?.text ?? '')
    if (!text) continue
    const time = (Number(r?.time) || 0) / 10
    if (!Number.isFinite(time) || time < 0) continue
    const pos = Number(r?.position)
    const mode = pos === 1 ? 5 : pos === 2 ? 4 : 1
    const color = /^#[0-9a-f]{6}$/i.test(String(r?.color ?? '')) ? String(r.color) : '#ffffff'
    comments.push({ time, text, mode, color, size: Number(r?.size) === 2 ? 30 : 25 })
  }
  comments.sort((a, b) => a.time - b.time)
  return { comments, raw: rows.length }
}

function pickEpisode(entry: FetcherEntry, episode: number): FetcherEpisodeRef | null {
  const want = Math.max(1, Math.trunc(Number(episode) || 1))
  const main = entry.episodes.filter((e) => e.volume === '0')
  return (
    main.find((e) => e.index === want) ??
    entry.episodes.find((e) => e.volume === '3' && e.index === want) ??
    entry.episodes.find((e) => e.index === want) ??
    null
  )
}

export const bahamutFetcher: DanmakuFetcher = {
  id: 'bahamut',
  name: '巴哈姆特动画疯',
  kind: 'api',

  async search(keyword, ctx) {
    const kw = String(keyword ?? '').trim()
    if (!kw) return []
    const base = bahamutBase(ctx.source?.base)
    ctx.onProgress?.({ step: 1, total: FETCH_STEPS, label: `正在巴哈姆特搜索「${kw}」…` })

    const viaPkg = await searchViaPackage(kw, base, ctx)
    if (viaPkg) {
      return viaPkg
        .map((e) => ({ e, score: scoreCandidate({ animeSn: Number(e.id), title: e.title, cover: '', info: e.extra ?? '' }, ctx, kw) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.e)
    }

    const list = await searchViaHttp(kw, base)
    if (list.length === 0) {
      log.append('info', 'danmaku', `巴哈姆特搜索「${kw}」没有结果`)
      return []
    }
    const ranked = list
      .map((a) => ({ a, score: scoreCandidate(a, ctx, kw) }))
      .filter((x) => x.score >= 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, MAX_CANDIDATES)

    ctx.onProgress?.({ step: 2, total: FETCH_STEPS, label: `正在读取巴哈姆特的集数列表…` })
    const out: FetcherEntry[] = []
    for (const { a, score } of ranked) {
      try {
        const { refs, extra } = await episodesViaHttp(a.animeSn, base)
        if (refs.length === 0) continue
        out.push({
          id: String(a.animeSn),
          title: a.title,
          keyword: kw,
          extra: `${extra} · 相似度 ${score}`,
          episodes: refs,
          raw: { animeSn: a.animeSn, search: a }
        })
        // 已经找到能覆盖目标集的条目就不再多打请求（集数表通常第一条就是正片）
        if (pickEpisode(out[out.length - 1], ctx.episode)) break
      } catch (err) {
        log.append('warn', 'danmaku', `巴哈取集失败（${a.title}）：${String((err as Error)?.message ?? err)}`)
      }
    }
    return out
  },

  async fetchEpisode(entry, episode, ctx) {
    const base = bahamutBase(ctx.source?.base)
    const ref = pickEpisode(entry, episode)
    if (!ref) {
      throw new Error(`《${entry.title}》里没有第 ${episode} 集（共 ${entry.episodes.length} 集）`)
    }
    ctx.onProgress?.({
      step: 3,
      total: FETCH_STEPS,
      label: `正在从巴哈姆特取第 ${episode} 集弹幕…`
    })
    const r = await fetchBahamutDanmu(Number(ref.id), base)
    if (r.comments.length === 0) throw new Error(`《${entry.title}》第 ${episode} 集没有弹幕（videoSn=${ref.id}）`)
    return {
      comments: r.comments,
      detail: `《${entry.title}》第 ${ref.index} 集（${ref.volumeName ?? '本篇'}，videoSn=${ref.id}）`,
      entryName: entry.title,
      keyword: entry.keyword,
      episodeTitle: ref.title
    }
  }
}


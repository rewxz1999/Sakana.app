import axios from 'axios'
import type { DownloadTask, MikanItem, MikanSearchResult, SubUpdateCheck, Subscription } from '@shared/types'
import { parseEpisode, parseGroup, parseResolution, humanSize } from '../lib/parse'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'
import { store } from '../store'
import {
  buildBangumiRssUrl,
  fetchOfficialFeed,
  newFeedTrace,
  parseFeed,
  resolveSubFeed,
  setFeedBase,
  type FeedItem,
  type FeedTrace
} from './mikanFeed'

/** 蜜柑计划（方案 4.1：订阅数据源，RSS） */
export const MIKAN_BASE = 'https://mikanani.kas.pub'
// 官方订阅 RSS 的解析（services/mikanFeed.ts）用同一个基础域名，避免两处各写一份而漂移
setFeedBase(MIKAN_BASE)

/**
 * mikanFeed 解析出来的 feed 条目 → 应用内部使用的 MikanItem。
 *
 * 两份 feed（搜索 RSS 与官方订阅 RSS）结构一致，差异只有这里补的两个字段：
 *   · `magnet`：蜜柑 RSS 里没有磁力链接，只有 .torrent 的 enclosure，置空；
 *   · `isNew`：由调用方在「这条算本次更新」时再打上，这里不预设。
 */
function toMikanItem(it: FeedItem): MikanItem {
  return {
    guid: it.guid,
    title: it.title,
    link: it.link,
    torrentUrl: it.torrentUrl,
    magnet: null,
    size: it.size,
    pubDate: it.pubDate,
    group: it.group,
    episode: it.episode,
    resolution: it.resolution
  }
}

/**
 * 候选池来源。两种池的「身份担保」强度不同，身份判定严格度也不同，必须分开记：
 *   · name  —— 用**番剧名**（订阅的完整标题 / 派生基名 / 日文名）搜出来的结果。
 *              蜜柑的 RSS 搜索按标题匹配，所以这一池里每一条的标题都含该搜索词，
 *              「是这部番」已经被搜索本身担保 → 身份判定可以放宽到「标题含订阅名字」。
 *   · group —— 用**字幕组名**搜出来的结果（兜底）。这一池是该字幕组最近的 100 条、
 *              什么番都有 → 身份判定必须严格。
 */
type CandidatePool = 'name' | 'group'

interface Candidate {
  item: MikanItem
  pools: Set<CandidatePool>
}

/** 一趟筛选的结果（计数 + 判掉样本，供日志使用） */
interface PassResult {
  newItems: MikanItem[]
  /** 计数行：候选 N → 同字幕组 N → 是这部番 N → 命中 N（+ 判掉原因） */
  counts: string
  /** 被判为「不是这部番」的候选标题样本，用于以后排查「筛选误杀」 */
  rejectedSamples: string[]
  rejected: number
  /** 发布日期取不到/解析不出、被 isNewerThanLast 放过的条数 */
  undated: number
  /** 被判为「不是这部番」且**不属于该字幕组**的条数（只在回落链路的日志里用） */
  offGroup: number
}

/** 日志里附带的「被判为不是这部番」的候选标题条数上限 */
const REJECT_SAMPLES = 5

/**
 * 字幕组归一化与匹配规则放在 shared 里：主进程的过滤与「确认下载」弹窗的兜底过滤
 * 必须用同一份规则（见 shared/subgroup.ts 的说明）。
 */
import { matchesSubGroup } from '@shared/subgroup'
import { baseSearchKeyword, parseTitleSeason, sameBase, sameSeason, seasonLabel } from '@shared/titleSeason'

export { matchesSubGroup, normGroup } from '@shared/subgroup'

/**
 * 订阅更新检测的搜索词候选：**原关键词 + 从 nameCn/name 派生的基名**，去重后最多 3 个。
 *
 * 为什么不能只用 sub.mikanKeyword：它等于 `nameCn || name`，也就是 Bangumi 上的完整番剧名
 * （《从零开始的异世界生活 第四季》《无职转生～到了异世界就拿出真本事～》）。
 * 实测（.e2e/test-sub-match.js，真实拉 RSS）蜜柑的搜索有两个要命的性质：
 *   ① **对标点敏感**：《孤独摇滚！》的全角「！」只搜到 100 条、里面一条千夏字幕组的都没有；
 *      换成半角「!」搜到 47 条、其中 41 条就是千夏字幕组的（他们标题里写的是半角 `!`）。
 *   ② **单次结果有上限（实测 100 条）且按时间倒序**：换个写法就能翻出被上限截掉的条目。
 * 所以这里故意让「原关键词（原始标点）」和「派生基名（NFKC 折叠过标点）」**同时存在**：
 * 去重只按「去空白 + 小写」比较，全角/半角不同写法不会被合并掉，等于一次订阅查多个写法。
 *
 * 派生基名还负责去掉季数后缀（《…第四季》→《…》），并且会把 name 换成日文名 ——
 * 「中文名 ↔ 日文名/罗马音」的对应完全交给蜜柑自己的搜索，
 * 本地只做同语言字符串比较（见 shared/titleSeason.sameBase 的注释）。
 */
function keywordCandidates(sub: Subscription): string[] {
  const raw = [
    sub.mikanKeyword,
    baseSearchKeyword(sub.nameCn || ''),
    baseSearchKeyword(sub.name || '')
  ]
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of raw) {
    const s = String(k ?? '').trim()
    if (!s) continue
    const key = s.replace(/\s+/g, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= 3) break
  }
  return out
}

/** 中日文字符（含扩展 A 与兼容区）：判断「短片段是否已经足够具体」用 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * 一个「名字片段」是否已经足够具体到可以拿去判定番剧身份。
 * ≥4 个字符一律可以；短于 4 个字符时必须是中日文字
 * （两个汉字的番剧名已经足够具体；两个拉丁字符不行 —— 否则 `AIR` 会命中 `Fairytail`，
 *  shared/titleSeason.sameBase 的注释里也踩过同一个坑）。
 */
function usableNeedle(p: string): boolean {
  return p.length >= 4 || (p.length >= 2 && CJK_RE.test(p))
}

/**
 * 相关性关键词（v0.2.17 引入，本版放宽短名）：标题里出现其中任意一个，就算「这条资源写的是这部番」。
 *
 * 用于替代「基名必须一致」这条硬规则 —— 它的漏网情形太多：标题里带副标题、
 * 用日文名、用罗马音、带「第 N 部分」等写法时基名对不上，但资源明明是同一部番。
 * 这里从订阅的中文名/日文名/搜索词里取**片段**（去掉季数、季/集字样、标点与空格后
 * 按长度切分），命中任一即算相关；字幕组仍是硬门槛，所以不会串番。
 *
 * 本版修正的两处（都是「订阅不到」的直接成因）：
 *   ① **短名不再被整条丢掉**。旧代码最后一句 `filter(n => n.length >= 4)` 一刀切，
 *      《冰菓》《AIR》这类两三个字的番剧 needles 直接变空，只剩「基名完全相等」一条路：
 *      资源标题是《[组] 冰菓 Hyouka [12]》时基名算出来是 `冰菓hyouka`，与 `冰菓` 不相等，
 *      包含关系又因为「短于 4 个字符不做包含」（sameBase）被拒 → 这个订阅永远 0 条。
 *      现在改成：≥4 个字符，**或** ≥2 个字符且含中日文字（见 usableNeedle）。
 *   ② 「原样」与「去掉季数/集数」两种形态都取，并各取前 6 / 前 10 个字符，
 *      以便中文名 ↔ 日文名两边都能对上。
 */
function relevanceNeedles(sub: Subscription, subBase: string): string[] {
  const out = new Set<string>()
  const add = (p: string): void => {
    if (usableNeedle(p)) out.add(p)
  }
  const push = (raw: string | undefined | null): void => {
    const s = normCompare(raw || '')
    if (!s) return
    // 去季数/集数标识，避免把「第三季」当成关键词
    const cleaned = s
      .replace(/第[0-9一二三四五六七八九十]+[季期部クールシーズン]/g, '')
      .replace(/(season|part|s)\d+/g, '')
      .replace(/[0-9]+/g, '')
    for (const piece of [s, cleaned]) {
      add(piece)
      // 长标题再切出前 6 / 前 10 个字符的片段（跨语言时通常只有前半段能对上）
      if (piece.length >= 8) add(piece.slice(0, 6))
      if (piece.length >= 12) add(piece.slice(0, 10))
    }
  }
  push(subBase)
  push(sub.nameCn)
  push(sub.name)
  push(sub.mikanKeyword)
  return [...out]
}

/** 归一化比较用文本：NFKC + 去标点空格 + 小写（与 subgroup 的归一化同源思路） */
function normCompare(text: string): string {
  return (text || '')
    .normalize('NFKC')
    .replace(/[\s\u3000~～〜!！?？:：,，.。、'’"“”\-–—_/\\[\]【】()（）]+/g, '')
    .toLowerCase()
}

/**
 * 资源是否比「上次检测到的发布日期」更新。
 *
 * pubDate 解析失败时**算通过**（返回 true）：蜜柑 RSS 的日期挂在 `<torrent><pubDate>` 下，
 * 实测（.e2e/probe-pubdate.js）8 个关键词、530 条真实条目里，顶层 `<pubDate>` 有 0 条、
 * `<torrent><pubDate>` 有 530 条，取不到日期或解析不出的都是 **0 条** —— 这条分支平时根本不走。
 * 一旦蜜柑改了 feed 结构，把「解析不出时间」当成「不够新」会让用户看到「有资源却一条都不提示」，
 * 正是「什么资源都订阅不到」的一种成因，所以这里宁可放过。
 *
 * 「会不会因此反复提示/重复下载」的核查结论（本版）：
 *   · 平时不会：日期 100% 可解析（上面那组实测），这条分支不触发；
 *   · 真触发时也确实会「每次检测都算新」，但拦住重复提示的不是日期而是 handled()：
 *     用户在「确认下载」里点确认就会为每条生成下载任务（renderer/stores/subs.ts 的 confirmUpdate），
 *     下次检测按 title / torrentUrl 命中 handled 从而不再出现。
 *   · 唯一残留路径是用户**取消**了确认弹窗：此时这些条目下次仍会出现。
 *     这恰恰是「还有更新没处理」的正确表现，不是误判。
 *   · 为了不让它将来变成静默行为，checkSub 会把「日期无法解析的条数」写进筛选统计日志。
 */
function isNewerThanLast(item: MikanItem, lastPubDate?: string | null): boolean {
  if (!lastPubDate) return true
  const itemTime = new Date(item.pubDate).getTime()
  if (Number.isNaN(itemTime)) return true
  const lastTime = new Date(lastPubDate).getTime()
  if (Number.isNaN(lastTime)) return true
  return itemTime > lastTime
}

/**
 * 把解析出来的官方订阅入口写回订阅记录（`store` 的 `subscriptions`）。
 *
 * 为什么要落盘：`bangumiId` 要从搜索页 HTML 解析、`subgroupId` 要从番剧页 HTML 解析，
 * 首次要 2 个请求；缓存后每次检测是 **0 个解析请求**（用户要求验证的就是这一条）。
 *
 * 为什么直接改 store 而不是走 subsStore / IPC：`checkSub` 的入参是订阅对象的副本，
 * 返回值结构（SubUpdateCheck）又被 IPC 与界面依赖，不能改。这里只更新三个**新增的可选字段**，
 * 不碰任何已有字段；subsStore.mutateSubscriptions 读写的是同一份 store 数据，互不冲突。
 * 值没变化时不写盘，避免每次检测都触发一次无意义的落盘。
 */
function persistSubFeedCache(
  subId: string,
  bangumiId: number | null,
  subgroupId: number | null,
  groupName: string | null | undefined
): void {
  if (bangumiId == null) return
  const subs = store.get<Subscription[]>('subscriptions', [])
  let changed = false
  const next = subs.map((s) => {
    if (s.id !== subId) return s
    if (s.mikanBangumiId === bangumiId && s.mikanSubgroupId === subgroupId && s.cachedGroupName === (groupName ?? null)) {
      return s
    }
    changed = true
    return { ...s, mikanBangumiId: bangumiId, mikanSubgroupId: subgroupId, cachedGroupName: groupName ?? null }
  })
  if (changed) store.set('subscriptions', next)
}

class MikanService {
  async search(keyword: string): Promise<MikanSearchResult> {
    try {
      const url = `${MIKAN_BASE}/RSS/Search?searchstr=${encodeURIComponent(keyword)}`
      const res = await axios.get(url, {
        timeout: 15000,
        responseType: 'text',
        headers: { 'User-Agent': BROWSER_UA },
        ...buildProxyAgents(getSettings().proxy)
      })
      // RSS 解析统一走 mikanFeed.parseFeed：官方订阅 feed 与搜索 feed 的字段语义完全一致，
      // 两处各写一份解析必然漂移（历史上 guid 的 `[object Object]` 坑就出在这里）
      return { items: parseFeed(res.data as string).map(toMikanItem) }
    } catch (err) {
      const e = err as { message?: string }
      const msg = e?.message ?? String(err)
      log.append('error', 'mikan', `搜索失败 (${keyword}): ${msg}`)
      return { items: [], error: msg }
    }
  }

  /**
   * 检测单个订阅的新资源（方案 4.2：仅检测，需用户确认后下载；已存在下载任务的资源不再提示）
   *
   * ============ v0.3.3：优先走蜜柑自己的「按番剧 + 字幕组」订阅 RSS ============
   * 用户要求「直接抄蜜柑的 RSS 订阅规则，现在的订阅规则老是失误」。蜜柑番剧页每个字幕组旁边
   * 就有 RSS 图标，地址是 `RSS/Bangumi?bangumiId=<番剧ID>&subgroupid=<字幕组ID>` ——
   * 它由**蜜柑在服务端**按番剧与字幕组筛好，本地不再需要用标题判据去猜「这是不是这部番」。
   * 判定顺序（详细说明与实测数据见下方「路径选择」那一段的注释）：
   *   ① 订阅记录里有缓存的 bangumiId/subgroupId → 0 个解析请求，直接拼 feed 地址；
   *   ② 没有缓存 → 搜索页 HTML 取 bangumiId、番剧页 HTML 取 subgroupid，再拼地址；
   *   ③ 解析失败或官方 feed 拉不到 → **回落**到下面这条关键词搜索链路（完整保留，见下方注释）。
   * 每次检测都会写一行日志，**行首**就写明「本次走：官方订阅 RSS」还是「本次走：回落关键词搜索」。
   *
   * ============ 回落链路（原样保留）的匹配规则 ============
   * 两道硬门槛，与 v0.2.10 的差别只有第二条：
   *   ① **同一个字幕组** —— 订阅时就指定了组，串组的资源没有意义（matchesSubGroup）。
   *   ② **确实是这部番** —— 基名一致（sameBase），或标题里含订阅名字的可搜索片段（relevanceNeedles）。
   * 季数 / 集数**只参与排序**（同季优先 → 有集数优先 → 发布时间新），不作一票否决：
   *   这样「不写季数但集数延续」「整季合集」「OVA / 剧场版」不会被整批丢掉。
   * 已处理过的不算、不比 lastPubDate 新不算（与 v0.2.10 相同，结果带 isNew）。
   *
   * 为什么会走到今天这一步（v0.2.10 → 现在）：
   *   · v0.2.10 只要求「同字幕组」，番剧身份完全依赖蜜柑搜索本身的精度 —— 用户当时觉得「还算正常」。
   *   · v0.2.12 把「同季」加成硬门槛，v0.2.16 又加了「基名一致」与「有集数」，
   *     三道硬门槛叠起来就出现了「什么资源都订阅不到」。
   *   · v0.2.17 把季/集降级为排序，方向对了，但同时留了一条「宽松兜底：只看字幕组」——
   *     那一趟会把**该字幕组最近发布的所有番剧**都算成这个订阅的资源。实测（真实 RSS）：
   *     《无职转生 第三季》+ 千夏字幕组 → 候选 236 → 同字幕组 91 → **命中 91 条**，
   *     91 条全是《上伊那牡丹，醉姿如百合》之类完全无关的番剧。这就是「订阅到不相关的番」。
   *     本版把这一趟删掉：宁可这一趟给 0 条、并让日志写清是被哪一步筛掉的，
   *     也不允许任何一条「不是这部番」的资源进结果。
   *   · v0.3.3（本版）发现：这些失误的**根因**是「让本地判据去干蜜柑自己就能干的事」——
   *     搜索 RSS 有 100 条上限（换个写法才能翻出被截掉的条目），标题判据又有跨语言/短名的漏网，
   *     放宽判据就会串番、收紧就会订阅不到。改用蜜柑的订阅 RSS 后，这两个判据都不再需要。
   *
   * 签名与返回结构（SubUpdateCheck）保持原样，IPC / 类型 / UI 都不用动。
   */
  async checkSub(sub: Subscription): Promise<SubUpdateCheck> {
    const downloads = store.get<DownloadTask[]>('downloads', [])
    // 该资源是否已被处理过（存在非错误状态的下载任务）
    const handled = (item: MikanItem): boolean =>
      downloads.some(
        (d) =>
          d.status !== 'error' &&
          ((item.torrentUrl && d.torrentUrl === item.torrentUrl) ||
            (d.name && d.name === item.title) ||
            (d.subscriptionId === sub.id &&
              item.episode != null &&
              d.episode === item.episode &&
              d.group === item.group))
      )

    const label = sub.nameCn || sub.name || sub.mikanKeyword
    const keywords = keywordCandidates(sub)

    /*
     * 标题/季数解析先算出来（两条路径都要用：官方路径写日志，回落路径做判据与排序）。
     * 注意这里**必须**在下面的路由之前算好 —— 路由里的日志要写 seasonLabel(subSeason)，
     * 而 const 是块级作用域、不存在提升，放到路由后面就会踩 TDZ 直接抛异常。
     */
    const cnInfo = parseTitleSeason(sub.nameCn || '')
    const nameInfo = parseTitleSeason(sub.name || '')
    const subBase = cnInfo.base || nameInfo.base
    // 季数以中文名优先：nameCn 认不出季数时才退回日文名（两个名字来自同一个 Bangumi 条目）
    const subSeason = cnInfo.season ?? nameInfo.season

    /*
     * ===================== 回落：关键词搜索链路（原样保留）=====================
     * 走到本文件后半段（搜索 → 判据 → 排序）的前提是「官方入口拿不到 / 官方 RSS 拉不到」，
     * 两种情况的判定与日志见下面「路径选择」那一段（它在 applyFilters 定义之后、
     * 与最终日志放在一起）。这条链路的搜索、判据、排序一字未改 —— 用户明确要求保留它作兜底。
     */

    // ---------- 搜索阶段（v0.2.16 重写，本版保留）----------
    /*
     * 用户实测「什么资源都订阅不到」，日志是：
     *   候选 38 条 → 同字幕组 0 → 基名一致 0 → 命中 0
     * 而用真 RSS 一探就明白：主关键词（订阅的完整标题）能搜到 **100 条**、里面正有该字幕组的资源；
     * 另外两个派生关键词只搜到 36 + 2 条，且全是别的字幕组 —— **36+2 正好等于日志里的 38**。
     * 也就是说：**主关键词那次搜索在应用里失败了，而合并逻辑一声不吭地用剩下两个无关关键词继续跑**，
     * 于是字幕组过滤全灭。旧代码只搜一个关键词，失败会明确报错；多关键词合并把这个失败掩盖了。
     * 所以每次搜索失败都重试一次并写日志（不再静默降级）。
     *
     * 候选池分两种来源，后面的「是不是这部番」判定强度也不同：
     *   · name  —— 用**番剧名**（订阅的完整标题 / 派生基名 / 日文名）搜出来的结果。
     *              蜜柑的搜索是**按词匹配、与标点和词序无关**的（实测 .e2e/probe-search-precision.js：
     *              搜《葬送的芙莉莲》100/100 条标题含该词；搜《无职转生 第三季 ～到了异世界就拿出真本事～》
     *              81/100 条逐字含该串，剩下 19 条是同一部番把「第三季」挪到标题末尾的写法）。
     *              也就是说这一池里「是这部番」基本被搜索本身担保了
     *              → 身份判定可以放宽到「标题含订阅名字」。
     *   · group —— 用**字幕组名**搜出来的结果（兜底，只在按番剧名一条都没命中时才补）。
     *              这一池是该字幕组最近的 100 条、什么番都有 → 身份判定必须严格。
     *
     * 顺带一个实测出来的副作用（本版据此把「季数只排序」这条写进日志统计）：
     * 派生关键词会**去掉季数**，于是搜《无职转生 ~到了异世界就拿出真本事~》返回的 36 条里，
     * 只有 12 条含该串，其余是《无职转生Ⅱ》（**第二季**）。也就是说跨季资源确实会进候选池，
     * 而季数按用户要求不作硬门槛，所以「同季 N 条 / 不同季」必须在日志里看得见。
     */
    const candidates = new Map<string, Candidate>()
    const addItems = (items: MikanItem[], pool: CandidatePool): number => {
      let fresh = 0
      for (const item of items) {
        // 按 guid 合并去重（guid 就是蜜柑的种子 id）；torrentUrl 兜一层底：同响应里的重复 guid
        // 会被 search() 加上 `#2` 后缀，跨响应时同一资源可能带不同后缀
        const key = item.torrentUrl ? `t:${item.torrentUrl}` : `g:${item.guid}`
        const hit = candidates.get(key)
        if (hit) {
          hit.pools.add(pool)
          continue
        }
        candidates.set(key, { item, pools: new Set<CandidatePool>([pool]) })
        fresh++
      }
      return fresh
    }
    const searchLog: string[] = []
    const searchInto = async (kw: string, pool: CandidatePool): Promise<number> => {
      let res = await this.search(kw)
      if (res.error) {
        // 首次失败最常见的原因是瞬时网络/上游抖动 —— 直接放弃会让「候选」悄悄少掉一整批
        log.append('warn', 'mikan', `订阅《${label}》搜索失败「${kw}」，2 秒后重试一次：${res.error}`)
        await new Promise((r) => setTimeout(r, 2000))
        res = await this.search(kw)
        if (res.error) log.append('warn', 'mikan', `订阅《${label}》搜索仍然失败「${kw}」：${res.error}`)
      }
      searchLog.push(`${kw}=${res.items.length}${res.error ? '(失败)' : ''}`)
      return addItems(res.items, pool)
    }
    for (const kw of keywords) await searchInto(kw, 'name')

    // ---------- 过滤阶段 ----------
    /*
     * 与 v0.2.10（用户认为「还算正常」的那一版）逐条对齐后的差异清单：
     *   · 多要求的只有一条：**「是这部番」**（v0.2.10 完全没有这条，全靠蜜柑搜索的精度兜着）。
     *   · 少要求的：无。v0.2.12 加的「同季」、v0.2.16 加的「基名一致」「有集数」三道硬门槛
     *     都已按用户要求降级为排序偏好，不再淘汰任何条目。
     *   · 日期门槛反而更宽松：v0.2.10 里 pubDate 解析不出 = 直接丢掉，现在算通过（见 isNewerThanLast）。
     *   · 搜索从 1 个关键词增加到最多 3 个（原关键词 + 中日文派生基名），并新增
     *     「按字幕组名搜索」的第 2 趟兜底 —— 这两处只扩大候选池，最终仍要过同样的硬门槛。
     */
    /**
     * 订阅的「本名」归一化集合：用来判断「标题里就是写着这部番的名字」。
     * （《冰菓》这类短名做不出 ≥4 字符的片段，只能靠这条兜住，见 relevanceNeedles。）
     * 与 needles 用同一套「够不够具体」的标准，避免短拉丁名（`AIR`）在这里被放行。
     */
    const identities = [
      ...new Set(
        [subBase, sub.nameCn, sub.name, sub.mikanKeyword]
          .map((raw) => normCompare(raw || ''))
          .filter((s) => usableNeedle(s))
      )
    ]

    /**
     * 一趟筛选（本版把 v0.2.17 的 'loose' 去掉了，只剩 mode 用于日志措辞）。
     *
     * 硬门槛只有两道：① 同字幕组；② 是这部番（基名一致 / 含相关性片段 / 标题含订阅名字）。
     * 季数、集数一律不淘汰条目，只影响排序 —— 这是「不写季数但集数延续」「整季合集」
     * 「OVA/剧场版」不被整批丢掉的前提。
     *
     * mode='official' 是 v0.3.3 新增的官方订阅 RSS 路径，**两道判据都不做**，原因见 checkSub 顶部。
     */
    const applyFilters = (all: Candidate[], mode: 'official' | 'strict' | 'group-search'): PassResult => {
      /*
       * ① 字幕组。
       *
       * 'official' 路径不做这道过滤 —— 这正是「直接抄蜜柑的订阅规则」的核心：
       * feed 地址里带了 `subgroupid`，蜜柑已经在服务端按字幕组筛过一遍了。
       * 再叠一层**按名字**的字幕组过滤反而会误杀：实测蜜柑番剧页上的字幕组名
       * 与资源标题里的 `[组名]` 是两个来源，真的会不一致 ——
       *   · bangumiId=4011&subgroupid=370：番剧页写「LoliHouse」，条目前缀却是
       *     `[喵萌奶茶屋&LoliHouse]`（同一组合并署名），严格相等会把 12 条全丢掉；
       *   · bangumiId=3995&subgroupid=45：番剧页那条**没有组名**，条目前缀是 `[爱恋字幕社]`。
       * 所以这一层在官方路径改成「只用于**核对**（记 offGroup，写进日志）」，
       * 拦不住的前提下也绝不静默 —— 只要出现不一致就会在日志里看到。
       * 回落链路（strict / group-search）里它仍然是硬门槛，与旧版行为一字不改。
       */
      const byGroup = mode === 'official' ? all : all.filter((c) => matchesSubGroup(sub.group, c.item.group))
      const offGroup = all.length - byGroup.length

      // ② 是这部番（硬门槛；官方路径不做 —— feed 是蜜柑按 bangumiId 给的）
      const needles = relevanceNeedles(sub, subBase)
      const isOurs = (c: Candidate): boolean => {
        const t = normCompare(c.item.title)
        if (sameBase(subBase, parseTitleSeason(c.item.title).base)) return true
        if (needles.some((n) => t.includes(n))) return true
        // 「标题里就是写着订阅的番剧名」：**只在按番剧名搜出来的那一池里采信**。
        // 那一池是蜜柑按这个名字（分词语义匹配）搜出来的，标题与该名字强相关，
        // 所以短名字（《冰菓》）在这里是安全的；
        // 只按字幕组名搜出来的那一池没有这个保证，不采信（否则会把该组别的番混进来）。
        if (c.pools.has('name') && identities.some((n) => t.includes(n))) return true
        return false
      }
      const relevant: Candidate[] = []
      const rejectedSamples: string[] = []
      for (const c of byGroup) {
        if (mode === 'official' || isOurs(c)) relevant.push(c)
        else if (rejectedSamples.length < REJECT_SAMPLES) rejectedSamples.push(c.item.title)
      }
      const rejected = byGroup.length - relevant.length

      /*
       * 官方路径的「组名核对」样本：这些条目**照样算命中**（feed 已经筛选过了），
       * 只是它们的标题组名与订阅的字幕组名对不上 —— 仅用于日志，方便以后核对
       * 「蜜柑给的 feed 是不是真的只有这个组」。最多留 REJECT_SAMPLES 条，避免刷屏。
       */
      if (mode === 'official' && offGroup > 0) {
        for (const c of all) {
          if (rejectedSamples.length >= REJECT_SAMPLES) break
          if (!matchesSubGroup(sub.group, c.item.group)) rejectedSamples.push(c.item.title)
        }
      }

      // ③ 已处理过的不算、不比上次检测新不算（这两条仍是硬门槛，与 v0.2.10 相同）
      let undated = 0
      const scored = relevant
        .filter((c) => !handled(c.item))
        .filter((c) => {
          const newer = isNewerThanLast(c.item, sub.lastPubDate)
          // 日期取不到/解析不出时 isNewerThanLast 会放过；统计出来写进日志，别让它变成静默行为
          if (newer && Number.isNaN(new Date(c.item.pubDate).getTime())) undated++
          return newer
        })
        .map((c) => {
          const info = parseTitleSeason(c.item.title)
          return {
            item: c.item,
            same: sameSeason(subSeason, info.season, info.kind),
            ep: c.item.episode != null,
            at: new Date(c.item.pubDate).getTime() || 0
          }
        })
      // 同季优先、有集数优先、然后按发布时间从新到旧
      // （注意：这三条**只排序、不淘汰** —— 不同季/无集数的条目依然会被返回，只是排在后面）
      scored.sort((a, b) => {
        if (a.same !== b.same) return a.same ? -1 : 1
        if (a.ep !== b.ep) return a.ep ? -1 : 1
        return b.at - a.at
      })

      const newItems = scored.map((s) => ({ ...s.item, isNew: true }))
      const sameCount = scored.filter((s) => s.same).length
      const epCount = scored.filter((s) => s.ep).length
      return {
        newItems,
        counts:
          (mode === 'official'
            ? `官方订阅RSS条目 ${all.length} → 命中 ${newItems.length}`
            : `候选 ${all.length} → 同字幕组 ${byGroup.length} → 是这部番 ${relevant.length} → 命中 ${newItems.length}`) +
          (mode === 'official'
            ? ''
            : `（同季 ${sameCount} 条、带集数 ${epCount} 条；已按「同季→有集数→最新」排序` +
              (mode === 'group-search' ? '；本趟用的是「按字幕组名搜索」补来的候选池' : '') +
              `）`) +
          (rejected > 0 ? `；判掉「不是这部番」${rejected} 条` : '') +
          (mode === 'official' && offGroup > 0
            ? `；⚠ 其中 ${offGroup} 条的标题组名与订阅的字幕组名不一致（官方 feed 仍算它们属于该组）`
            : '') +
          (undated > 0 ? `；⚠ 发布日期取不到/解析不出的 ${undated} 条已按「有新资源」处理` : ''),
        rejectedSamples,
        rejected,
        undated,
        offGroup
      }
    }

    const passLog: string[] = []
    let result = applyFilters([...candidates.values()], 'strict')
    // 最后被评估的那一趟：日志里附带的「判掉样本」取自它 —— 它才是候选最多、
    // 最能说明「到底为什么没命中」的那一趟（例如第 2 趟把该字幕组 91 条别的番全判掉）
    let lastEval = result
    passLog.push(`第 1 趟（按番剧名搜索的候选池）：${result.counts}`)
    let mode: 'strict' | 'group-search' = 'strict'

    // 第 2 趟：按番剧名一条都没命中 → 再用**字幕组名**搜一遍补候选池
    // （同一个番剧在标题里换了名字、或者番剧名那条搜索当场失败时，只有这条路能捞到）
    // 注意：这一池只新增候选，仍然要过同一套硬门槛，所以不会把该组别的番混进来。
    if (result.newItems.length === 0 && sub.group) {
      const before = candidates.size
      await searchInto(sub.group, 'group')
      if (candidates.size > before) {
        const retry = applyFilters([...candidates.values()], 'group-search')
        lastEval = retry
        passLog.push(`第 2 趟（按字幕组名搜索补来的候选池）：${retry.counts}`)
        if (retry.newItems.length > 0) {
          mode = 'group-search'
          result = retry
        }
      } else {
        passLog.push('第 2 趟：按字幕组名搜索没有带回新的候选，跳过')
      }
    }

    /*
     * ===================== 路径选择（v0.3.3 核心改动）=====================
     *
     * 用户要求：「直接抄蜜柑的 RSS 订阅规则，现在的订阅规则老是失误」。
     * 旧链路是「搜索 RSS + 我们自己的标题/字幕组判据」，而**蜜柑自己就提供按番剧 + 字幕组的
     * 订阅地址**（番剧页每个字幕组旁边的 RSS 图标）：
     *   `RSS/Bangumi?bangumiId=<番剧ID>&subgroupid=<字幕组ID>`
     * 用这条地址，蜜柑在服务端就把「哪部番、哪个组」筛好了，本地不再需要任何判据去猜。
     *
     * 实测（.e2e/.probe，真实响应）：
     *   · bangumiId=3995&subgroupid=203 → 200 / 36 条，**全部**是《无职转生 第三季》+ 桜都字幕组；
     *   · bangumiId=4011&subgroupid=364 → 200 / 11 条，**全部**是《二十世纪电气目录》+ 云光字幕组；
     *   · id 不存在 → **200 + 0 条**（不是 404），所以「0 条」是正常结果、不是错误；
     *   · 番剧页的字幕组列表里没有该组（如 3995 里找千夏字幕组）→ 直接判 0 条，
     *     **不回落搜索**：搜索一定会搜出该组别的番，那正是「串番」的来源。
     *
     * 三条路径与外层日志的对应关系（每次检测必写一行，见本段之后）：
     *   ① 官方订阅 RSS 命中      → 「本次走：官方订阅 RSS」，请求 0~1 次（缓存后不再解析）
     *   ② 官方 RSS 拉取失败      → 「本次走：回落关键词搜索」，并写明失败原因
     *   ③ 解析不出番剧/字幕组 ID → 同上，并写明是哪一步解析不出来
     *
     * 位置说明：这一段必须放在 applyFilters 定义**之后**（要用它），而 applyFilters 又要用
     * 前面算好的 candidates / subBase / subSeason，所以顺序是「搜索 → 判据定义 → 路由」。
     * 签名与返回结构（SubUpdateCheck）保持原样，IPC / 类型 / UI 都不用动。
     */
    const trace: FeedTrace = newFeedTrace()
    const resolved = await resolveSubFeed(sub, trace)
    /** 走官方路径失败的原因：非空 = 本次检测会回落到关键词搜索（写进日志，用户要求能一眼看出走了哪条路） */
    let officialError = ''
    if (resolved.bangumiId != null) {
      // 有番剧 ID 但没有字幕组 ID，且订阅指定了字幕组 → 蜜柑明确告诉我们「该组没做这部番」。
      // 这时**不回落搜索**：搜索必然搜出该组别的番（实测《无职转生》+ 千夏字幕组会捞回 91 条
      // 《上伊那牡丹，醉姿如百合》之类完全无关的番剧），那正是用户抱怨的「订阅到不相关的番」。
      if (sub.group && resolved.subgroupId == null) {
        log.append(
          'info',
          'mikan',
          `订阅《${label}》${seasonLabel(subSeason ?? null)}；本次走：官方订阅 RSS（按设计未拉取）` +
            `；bangumiId=${resolved.bangumiId}（${resolved.fromCache ? '缓存' : '本次解析'}）` +
            `；${resolved.reason || `该字幕组「${sub.group}」没有这部番`}；→ 0 条（不回落搜索，避免捞回该组别的番）`
        )
        if (!resolved.fromCache) {
          persistSubFeedCache(sub.id, resolved.bangumiId, resolved.subgroupId, sub.group)
        }
        return { subId: sub.id, newItems: [], checkedAt: Date.now() }
      }

      const url = buildBangumiRssUrl(resolved.bangumiId, resolved.subgroupId)
      const feed = await fetchOfficialFeed(resolved.bangumiId, resolved.subgroupId, trace)
      if (!feed.error) {
        const officialPool = new Map<string, Candidate>()
        for (const it of feed.items) {
          const item = toMikanItem(it)
          const key = item.torrentUrl ? `t:${item.torrentUrl}` : `g:${item.guid}`
          if (!officialPool.has(key)) officialPool.set(key, { item, pools: new Set<CandidatePool>(['name']) })
        }
        const official = applyFilters([...officialPool.values()], 'official')
        log.append(
          'info',
          'mikan',
          `订阅《${label}》${seasonLabel(subSeason ?? null)}；本次走：官方订阅 RSS ${url}` +
            `；入口 bangumiId=${resolved.bangumiId}` +
            (resolved.subgroupId != null
              ? `&subgroupid=${resolved.subgroupId}`
              : '（未指定字幕组→用整部番的 feed，仍按字幕组过滤）') +
            `（${resolved.fromCache ? '取自订阅记录的缓存，本次未重新解析入口' : '本次解析完毕，已写回订阅记录'}）` +
            `；入口解析请求 ${trace.requests} 次${trace.lines.length ? `（${trace.lines.join('、')}）` : ''}` +
            `；${official.counts}` +
            (official.offGroup > 0 ? `；组名不一致样本：${official.rejectedSamples.join(' ｜ ')}` : '')
        )
        if (!resolved.fromCache) {
          persistSubFeedCache(sub.id, resolved.bangumiId, resolved.subgroupId, sub.group)
        }
        return { subId: sub.id, newItems: official.newItems, checkedAt: Date.now() }
      }
      officialError = `官方订阅 RSS 拉取失败（${feed.error}）`
    } else {
      officialError = `解析不出官方订阅入口：${resolved.reason || '未知原因'}`
    }
    // 解析到了番剧 id 却没能拉成 RSS → 仍然把 id 缓存下来：下次直接拼 feed 地址（少两个 HTML 请求）
    if (resolved.bangumiId != null && !resolved.fromCache) {
      persistSubFeedCache(sub.id, resolved.bangumiId, resolved.subgroupId, sub.group)
    }

    /*
     * 日志（加强可诊断性）：**每次检测都写一行**，把「走了哪条路」放在最前面
     * （用户要求：一眼能看出这次是官方订阅 RSS 还是回落搜索），再带上每一趟筛选的计数：
     *   · 走了跌落路径        → 行首直接写「本次走：回落关键词搜索」+ 原因
     *   · 搜索阶段就没结果     → 「搜索 xx=0」或「xx=0(失败)」
     *   · 有候选但被判掉了     → 「同字幕组 N」很大而「是这部番 0」
     *   · 蜜柑上根本没有这部番 → 「同字幕组 0」
     * 被判为「不是这部番」的候选标题只在**有异常**时附上前若干条（平时不刷屏）：
     * 有异常 = 用了兜底路径 / 有搜索失败 / 一条都没命中。
     */
    const keywordFailed = searchLog.some((s) => s.includes('(失败)'))
    const needDetail = mode !== 'strict' || keywordFailed || result.newItems.length === 0
    log.append(
      'info',
      'mikan',
      `订阅《${label}》${seasonLabel(subSeason)}；本次走：**回落关键词搜索**（${officialError}）` +
        `；搜索 ${searchLog.join(' / ') || '(无关键词)'}；解析请求 ${trace.requests} 次${
          trace.lines.length ? `（${trace.lines.join('、')}）` : ''
        }；` +
        passLog.join(' ｜ ') +
        (mode === 'strict' ? '' : '；**使用了兜底路径：按字幕组名搜索**') +
        (needDetail
          ? lastEval.rejectedSamples.length > 0
            ? `；最后评估那一趟被判为「不是这部番」的候选（前 ${lastEval.rejectedSamples.length} 条 / 共 ${lastEval.rejected} 条）：` +
              lastEval.rejectedSamples.join(' ｜ ')
            : `；没有被判为「不是这部番」的候选（${lastEval.rejected} 条）`
          : '')
    )
    // 走到这里说明官方 feed 没拉成；若这一次解析出了番剧/字幕组 id 仍然写回缓存，
    // 下次检测直接拼 feed 地址（少两个 HTML 请求），RSS 拉取失败时也会自然回落到这里。
    if (resolved.bangumiId != null && !resolved.fromCache) {
      persistSubFeedCache(sub.id, resolved.bangumiId, resolved.subgroupId, sub.group)
    }
    return { subId: sub.id, newItems: result.newItems, checkedAt: Date.now() }
  }

  /** 应用启动时自动检测全部订阅（方案 4.2） */
  async checkAllSubscriptions(): Promise<SubUpdateCheck[]> {
    const subs = store.get<Subscription[]>('subscriptions', [])
    if (subs.length === 0) return []
    log.append('info', 'mikan', `启动更新检测：${subs.length} 个订阅`)
    const updates: SubUpdateCheck[] = []
    // 并发限制 2，避免请求过快
    for (let i = 0; i < subs.length; i += 2) {
      const batch = subs.slice(i, i + 2)
      const results = await Promise.all(
        batch.map(async (sub) => {
          try {
            return await this.checkSub(sub)
          } catch (err) {
            log.append('warn', 'mikan', `检测订阅失败 (${sub.nameCn}): ${String(err)}`)
            return { subId: sub.id, newItems: [], checkedAt: Date.now() }
          }
        })
      )
      for (const u of results) {
        if (u.newItems.length > 0) updates.push(u)
      }
    }
    const map = new Map(updates.map((u) => [u.subId, u]))
    const next = subs.map((sub) => {
      const u = map.get(sub.id)
      if (u) return { ...sub, status: 'waiting' as const }
      // 之前标记 waiting 但本次已无新资源（已下载/已确认）→ 复位
      if (sub.status === 'waiting') return { ...sub, status: 'complete' as const }
      return sub
    })
    if (JSON.stringify(next) !== JSON.stringify(subs)) store.set('subscriptions', next)
    if (updates.length > 0) {
      log.append('info', 'mikan', `发现 ${updates.length} 个订阅有资源更新，等待用户确认`)
    }
    return updates
  }
}

export const mikan = new MikanService()

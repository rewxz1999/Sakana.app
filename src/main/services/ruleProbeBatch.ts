import { BrowserWindow } from 'electron'
import { CH } from '@shared/channels'
import type { BatchProbeUpdate } from '@shared/types'
import { log } from '../log'
import { addProbeListeners } from './probeEvents'
import {
  MEDIA_EXT_RE,
  extractStreamCandidates,
  isStreamCandidate,
  resolveFirstPlayable,
  runAutoPlayClicks
} from './ruleProbe'

/**
 * 播放源列表的「批量预嗅探」（v0.3.7，用户要求：
 * 「在选择播放源页就自动加载所有规则下是否嗅探到资源、嗅探到多少资源，并显示在规则条目上」）。
 *
 * ## 为什么不能直接用现有的两套嗅探
 *
 * `ruleProbe`（离屏隐藏窗口）与 `ruleWebview`（屏幕外可见窗口）都是**严格单例**：
 * 两者开头都会先把自己上一次的窗口关掉（`stopRuleProbe()` / `closeRuleWebview()`），
 * 而且候选数组、超时器都是模块级变量。批量探测要同时跑好几条规则，
 * 用它们的结果就是「后一条规则把前一条的窗口拆了」，而且候选互相串台。
 * 所以这里另起一套：每个任务自己的窗口 + 自己的候选数组，
 * 只复用**判定与交互那部分**（`isStreamCandidate` / `extractStreamCandidates` /
 * `runAutoPlayClicks`）——那才是真正难写、也最不该出现两份的东西。
 *
 * ## 成本控制（为什么要分两阶段）
 *
 * 一次完整嗅探要开窗口、加载播放页、等播放器自己请求流，一条规则十几秒。
 * 19 条规则全跑一遍会让「打开播放源列表」等上好几分钟。所以每条规则先走**便宜的两步**：
 *   ① 规则引擎的搜索 + 剧集（纯 HTTP，一两秒）——找不到这部番就直接结束，不必开窗口；
 *   ② 播放页 HTML 直出地址（MacCMS 系站点把真实地址写在页面里，一次 GET 就能拿到）。
 * 只有这两步都没结果，才开窗口去嗅探（贵的那一步）。实测大多数"能用"的规则在第①步就能给出结论。
 *
 * ## 与真实播放的关系
 *
 * 这里**只探测、不播放**，也不写直链缓存（缓存的语义是"用户真的播过这条流"）。
 * 探测结果只是给用户一个"这条线路有没有货"的参考，点哪条规则仍然走原来的完整流程。
 */

/** 同时探测几条规则。取 3：再多会同时开太多窗口，站点也容易把我们当成爬虫 */
const CONCURRENCY = 3
/** 搜索/剧集/播放页这类纯 HTTP 步骤的单步超时 */
const STEP_TIMEOUT_MS = 12_000
/** 开窗口嗅探的最长等待 */
const SNIFF_TIMEOUT_MS = 12_000
/** 拿到第一个候选后再多等一会儿，把同一部剧的其它候选（多码率/多分片）也收进来 */
const SNIFF_GRACE_MS = 2_500
/** 整个任务的预算：超时后剩下的规则直接标成"未探测完"，不让用户一直等 */
const JOB_BUDGET_MS = 150_000

/**
 * 「默认三规则」名单（AGE / aafun / sorani）。
 *
 * 它们**同时开始**探测：用户进「选择数据源」就是要马上知道这三条常用线路有没有货，
 * 让它们排在一个 3 并发的队列里等前一条跑完（每条十几秒）等于让用户白等。
 * 判定用「规则名小写」而不是 id：内置规则的 id 是 `default-<小写名>`，
 * 但从仓库导入/用户自建的规则可能是任意 id，名字才是用户眼里的"这条线路"。
 */
const DEFAULT_THREE = ['age', 'aafun', 'sorani']
function isDefaultThree(t: BatchProbeTarget): boolean {
  return DEFAULT_THREE.includes(String(t.name ?? '').toLowerCase())
}

/**
 * 探测结果缓存（v1.1 重做：从「整批按关键词」改成「逐规则按番剧」+ LRU + 常驻）。
 *
 * ## 为什么键是「规则id + 番剧条目」而不是「关键词 + 这一批规则」
 *
 * 旧键（`keyword | 排序后的规则 id 列表`）有两个硬伤：
 *  ① 只要规则集变一点（用户启用/停用一条规则），**整批缓存全部作废**，
 *     明明其它规则的结论没变，用户还得再等一轮十几秒的探测；
 *  ② 缓存只活 30 分钟 —— 用户看一集再回来、或者中途去看了别的番，回来又要重等。
 * 用户这次的要求是「嗅探结果只要应用没关闭就一直保留」「重新进同一个番剧/同一集不应再等」，
 * 所以改成逐规则条目：一条结果 = `规则id | 番剧（subjectId 或关键词）`，
 * 规则集变化只影响新规则，其它条目的结论继续命中。
 *
 * ## 为什么是 LRU + 容量上限（而不是无限增长）
 *
 * 一条结果里带着搜索结果列表与整季剧集（几十~几百个对象，几 KB 到几十 KB）。
 * 用户连看几十部番之后，不设上限就是几十 MB 的常驻内存 —— 这是个播放器，不是爬虫。
 * 上限 400 条 ≈ 最多几 MB，够装「几十部番 × 全部规则」；超出时丢**最久没用过**的那条
 * （用户刚看过的番永远还在，只有很久以前探过的才会被淘汰）。
 *
 * ## 为什么不过期
 *
 * 用户明确要求「只要应用没关闭就一直保留」。站点是否可用确实是"这一会儿"的事，
 * 所以界面同时保留「重新探测」（force=true）作为唯一的手动刷新出口 ——
 * 用"我们猜它可能过期了"去悄悄丢掉结果，反而会变成"刚探完又要点一次"。
 */
const PROBE_CACHE_MAX = 400
interface ProbeCacheEntry {
  at: number
  update: BatchProbeUpdate
}
const probeCache = new Map<string, ProbeCacheEntry>()

/** 番剧标识：优先条目 id（同一部番的中文名可能变），没有就用关键词 */
function subjectKeyOf(job: ActiveJob): string {
  return job.subjectId ? `s${job.subjectId}` : `k${job.keyword.trim().toLowerCase()}`
}

function cacheKeyOf(job: ActiveJob, ruleId: string): string {
  return `${ruleId}|${subjectKeyOf(job)}`
}

/** 读缓存（命中即刷新 LRU 顺序：Map 的插入顺序就是"最近使用"顺序） */
function cacheGet(job: ActiveJob, ruleId: string): BatchProbeUpdate | null {
  const key = cacheKeyOf(job, ruleId)
  const hit = probeCache.get(key)
  if (!hit) return null
  probeCache.delete(key)
  probeCache.set(key, hit)
  return hit.update
}

/** 写缓存 + 超容量淘汰最久未用的（Map 的第一个键就是它） */
function cacheSet(job: ActiveJob, ruleId: string, update: BatchProbeUpdate): void {
  const key = cacheKeyOf(job, ruleId)
  probeCache.delete(key)
  probeCache.set(key, { at: Date.now(), update })
  while (probeCache.size > PROBE_CACHE_MAX) {
    const oldest = probeCache.keys().next().value as string | undefined
    if (!oldest) break
    probeCache.delete(oldest)
  }
}

/** 自检/设置页用：缓存条目数与命中情况 */
export function probeCacheStats(): { size: number; capacity: number } {
  return { size: probeCache.size, capacity: PROBE_CACHE_MAX }
}

export interface BatchProbeTarget {
  id: string
  name: string
  baseUrl: string
}

interface ActiveJob {
  id: string
  keyword: string
  /** 番剧条目 id（库驱动规则要用它换日文原名；也是缓存键的一部分） */
  subjectId?: number
  /** 结果往这个窗口发（就是发起探测的那个窗口） */
  win: BrowserWindow
  cancelled: boolean
  budgetTimer: NodeJS.Timeout | null
}

let job: ActiveJob | null = null

function send(job: ActiveJob, update: BatchProbeUpdate): void {
  const w = job.win
  if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
    w.webContents.send(CH.evRuleBatchProbe, update)
  }
}

function update(
  job: ActiveJob,
  target: BatchProbeTarget,
  phase: BatchProbeUpdate['phase'],
  t0: number,
  patch: Partial<BatchProbeUpdate> = {}
): BatchProbeUpdate {
  const payload: BatchProbeUpdate = {
    jobId: job.id,
    ruleId: target.id,
    ruleName: target.name,
    phase,
    hit: false,
    episodes: 0,
    count: 0,
    ok: false,
    ms: Date.now() - t0,
    ...patch
  }
  send(job, payload)
  /*
   * 出结果的那一条立刻写进缓存（不等整批跑完）：
   * 用户可能中途关掉播放源列表（那会 stopBatchProbe 取消剩下规则），
   * 已经探到的结论不该跟着丢掉。缓存键是「规则 + 番剧」，与这一批跑了多少条无关。
   */
  if (phase === 'done') cacheSet(job, target.id, payload)
  return payload
}

/** 超时不抛错，只返回 null（探测这件事失败是常态，不该把整批任务掀翻） */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return await Promise.race([
    p.catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), ms))
  ])
}

/**
 * 开一个窗口去嗅探某个播放页。
 * 返回捕获到的候选地址（去重、保持发现顺序）；窗口一定会被销毁、监听一定会注销。
 */
async function sniffWindow(
  job: ActiveJob,
  url: string,
  referer: string
): Promise<{ urls: string[]; error?: string }> {
  let win: BrowserWindow
  try {
    win = new BrowserWindow({
      /*
       * 与 ruleProbe 同一个取舍：`show:false` 会让页面进入 document.hidden，
       * 多数站点因此**根本不初始化播放器**（也就永远嗅不到流）。
       * 所以是"可见窗口放在屏幕外"，不是隐藏窗口。
       */
      show: true,
      x: -4000,
      y: 0,
      width: 1280,
      height: 720,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })
  } catch (err) {
    return { urls: [], error: `嗅探窗口创建失败：${String(err).slice(0, 80)}` }
  }
  // 广告弹窗：批量探测期间不需要任何新窗口，一律拒绝（否则会满屏弹广告窗）
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  } catch {
    /* 老版本没有这个方法也不影响探测 */
  }

  const urls: string[] = []
  const wcId = win.webContents.id
  const dispose = addProbeListeners({
    onBeforeRequest: (details) => {
      // 只认自己这个窗口的请求：并发的几条规则各收各的
      if (details.webContentsId !== wcId) return
      const u = details.url
      if (!isStreamCandidate(u)) return
      if (details.resourceType === 'media' || MEDIA_EXT_RE.test(u)) {
        if (!urls.includes(u)) urls.push(u)
      }
    },
    onCompleted: (details) => {
      if (details.webContentsId !== wcId) return
      if (details.statusCode >= 400) return
      if (!isStreamCandidate(details.url) || !MEDIA_EXT_RE.test(details.url)) return
      if (!urls.includes(details.url)) urls.push(details.url)
    }
  })

  const onLoad = (): void => {
    for (const delay of [1200, 3000, 6000]) setTimeout(() => runAutoPlayClicks(win), delay)
  }
  win.webContents.on('did-finish-load', onLoad)

  try {
    await withTimeout(win.loadURL(url, referer ? { httpReferrer: referer } : undefined), SNIFF_TIMEOUT_MS)
    // 等到有候选 + 宽限期，或整体超时
    const deadline = Date.now() + SNIFF_TIMEOUT_MS
    let graceUntil = 0
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400))
      if (job.cancelled) break
      if (urls.length > 0) {
        if (graceUntil === 0) graceUntil = Date.now() + SNIFF_GRACE_MS
        if (Date.now() >= graceUntil) break
      }
    }
  } catch (err) {
    return { urls, error: `播放页加载失败：${String((err as Error)?.message ?? err).slice(0, 80)}` }
  } finally {
    dispose()
    try {
      win.webContents.removeListener('did-finish-load', onLoad)
    } catch {
      /* 无所谓 */
    }
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      /* 忽略 */
    }
  }
  return { urls }
}

/** 探测一条规则（快路 → 慢路），并逐阶段回报 */
async function probeRule(current: ActiveJob, target: BatchProbeTarget): Promise<void> {
  const t0 = Date.now()
  const { ruleSearch, ruleEpisodes, rulePlay } = await import('./rules')

  update(current, target, 'search', t0)
  const search = await withTimeout(
    ruleSearch(target.id, current.keyword, current.subjectId),
    STEP_TIMEOUT_MS
  )
  if (current.cancelled) return
  if (!search || !search.items?.length) {
    update(current, target, 'done', t0, {
      ok: true,
      items: [],
      message: search?.error ? `搜索失败：${search.error}` : '这条规则里没有这部番剧'
    })
    return
  }
  const entry = search.items[0]
  const eps = await withTimeout(ruleEpisodes(target.id, entry), STEP_TIMEOUT_MS)
  if (current.cancelled) return
  const group = eps?.groups?.[0]
  const episodeCount = eps?.groups?.reduce((n, g) => n + (g.episodes?.length ?? 0), 0) ?? 0
  /*
   * 把搜索结果与剧集一起带出去（v1.1）。
   * 「带哪一条的剧集」= 搜索结果的第一条：界面点开源时先列搜索结果，
   * 用户点第一条是最常见的路径；其它条目仍按需拉取（但搜索结果本身已经是本地的了）。
   */
  const base = { items: search.items, groups: eps?.groups ?? [], vars: eps?.vars ?? {} }
  if (!group || !group.episodes?.length) {
    update(current, target, 'done', t0, {
      hit: true,
      ok: true,
      ...base,
      message: eps?.error ? `剧集解析失败：${eps.error}` : '找到了这部番剧，但没有可用剧集'
    })
    return
  }
  const vars = eps?.vars ?? {}
  const play = await withTimeout(
    rulePlay(target.id, entry, 0, 0, group.episodes[0].link, vars),
    STEP_TIMEOUT_MS
  )
  if (current.cancelled) return
  if (!play?.url) {
    update(current, target, 'done', t0, {
      hit: true,
      episodes: episodeCount,
      ok: true,
      ...base,
      message: '拿不到播放页地址'
    })
    return
  }

  // 快路：播放页 HTML 里直接写着真实地址（MacCMS 系站点）
  const direct = await withTimeout(extractStreamCandidates(play.url, target.baseUrl), STEP_TIMEOUT_MS)
  if (current.cancelled) return
  if (direct && direct.length > 0) {
    const playable = await withTimeout(resolveFirstPlayable(direct, target.baseUrl), STEP_TIMEOUT_MS)
    if (current.cancelled) return
    update(current, target, 'done', t0, {
      hit: true,
      episodes: episodeCount,
      count: direct.length,
      url: playable?.url ?? direct[0],
      ok: true,
      ...base,
      message: `播放页直出 ${direct.length} 个候选`
    })
    return
  }

  // 慢路：开窗口嗅探
  update(current, target, 'sniff', t0, { hit: true, episodes: episodeCount, ...base })
  const sniffed = await sniffWindow(current, play.url, target.baseUrl)
  if (current.cancelled) return
  update(current, target, 'done', t0, {
    hit: true,
    episodes: episodeCount,
    count: sniffed.urls.length,
    url: sniffed.urls[0],
    ok: true,
    ...base,
    message:
      sniffed.urls.length > 0
        ? `嗅探到 ${sniffed.urls.length} 个候选`
        : sniffed.error ?? '播放页没有发出可识别的视频请求'
  })
}

/**
 * 开始一批探测。同一时刻只允许一批（再开一批会取消上一批）：
 * 这是对第三方的礼貌 —— 用户来回切番剧时不该堆出几十个探测任务。
 *
 * ## 调度（v1.1 重做）
 *
 * 1. **缓存先回放**：逐条查「规则 + 番剧」的常驻缓存，命中的立刻推给界面（标 cached），
 *    这些规则不再参与探测 —— 重新进同一部番时界面是"瞬间就有结果"的。
 * 2. **默认三规则同时开始**：AGE / aafun / sorani 是用户最常用的三条，
 *    它们同时跑（`Promise.all`，不排队），因为它们彼此独立、站点也不同。
 * 3. **其余规则排队**：按 CONCURRENCY=3 的 worker 池依次探测。
 *    为什么不给它们也开无限并发：每条慢路都会开一个真实浏览器窗口，
 *    十几条规则一起开会同时弹出十几个离屏窗口、把内存与站点风控一起点着。
 */
export function startBatchProbe(
  win: BrowserWindow,
  req: { keyword: string; rules: BatchProbeTarget[]; force?: boolean; subjectId?: number }
): { jobId: string; total: number; cached: boolean; probedAt?: number } {
  stopBatchProbe()
  const id = `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const targets = req.rules.filter((r) => r && r.id)
  const current: ActiveJob = {
    id,
    keyword: req.keyword,
    subjectId: req.subjectId,
    win,
    cancelled: false,
    budgetTimer: null
  }

  /*
   * ① 逐条回放缓存。`force`（用户点「重新探测」）时一律跳过缓存重跑。
   * 注意这里是**逐条**判断：一批里可能只有几条命中（其它是用户新启用的规则），
   * 命中的直接出结果，没命中的继续探 —— 不会因为一条没缓存就把整批重跑。
   */
  const pending: BatchProbeTarget[] = []
  let cachedCount = 0
  let latestAt = 0
  for (const t of targets) {
    const hit = req.force ? null : cacheGet(current, t.id)
    if (hit) {
      cachedCount++
      latestAt = Math.max(latestAt, hit.probedAt ?? 0)
      send(current, { ...hit, jobId: id, cached: true })
      continue
    }
    pending.push(t)
  }
  if (pending.length === 0) {
    // 整批都命中缓存：一个窗口都不开，直接结束
    log.append(
      'info',
      'rule-batch',
      `批量预嗅探全部命中常驻缓存（${cachedCount} 条，最早探测于 ${latestAt ? new Date(latestAt).toLocaleTimeString() : '未知'}）`
    )
    job = null
    return { jobId: `${id}-cached`, total: targets.length, cached: true, probedAt: latestAt || undefined }
  }
  if (cachedCount > 0) {
    log.append('info', 'rule-batch', `批量预嗅探：${cachedCount} 条直接命中缓存，剩 ${pending.length} 条要探`)
  }

  job = current
  log.append(
    'info',
    'rule-batch',
    `开始批量预嗅探「${req.keyword}」：${pending.length} 条规则` +
      `（默认三规则同时开始，其余排队）${req.force ? '（用户要求重新探测）' : ''}`
  )

  current.budgetTimer = setTimeout(() => {
    if (job !== current) return
    log.append('warn', 'rule-batch', `批量预嗅探超时（${JOB_BUDGET_MS / 1000}s），停止剩余规则`)
    stopBatchProbe()
  }, JOB_BUDGET_MS)

  /** 探一条；异常也要给出结论，否则界面永远停在「搜索中…」 */
  const runOne = async (target: BatchProbeTarget): Promise<void> => {
    if (current.cancelled || job !== current) return
    try {
      await probeRule(current, target)
    } catch (err) {
      update(current, target, 'done', Date.now(), {
        ok: false,
        message: `探测异常：${String((err as Error)?.message ?? err).slice(0, 100)}`
      })
    }
  }

  // ② 默认三规则：同时开始（只在 pending 里的那些，已命中缓存的不重复跑）
  const priority = pending.filter(isDefaultThree)
  const rest = pending.filter((t) => !isDefaultThree(t))
  if (priority.length > 0) {
    log.append('info', 'rule-batch', `默认规则并行开始：${priority.map((t) => t.name).join('、')}`)
  }

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < rest.length) {
      if (current.cancelled || job !== current) return
      await runOne(rest[cursor++])
    }
  }

  void Promise.all([
    ...priority.map((t) => runOne(t)),
    ...Array.from({ length: Math.min(CONCURRENCY, rest.length) }, worker)
  ]).then(() => {
    if (job !== current) return
    log.append('info', 'rule-batch', `批量预嗅探结束（${targets.length} 条规则，其中 ${cachedCount} 条来自缓存）`)
    stopBatchProbe()
  })

  return { jobId: id, total: targets.length, cached: false }
}

export function stopBatchProbe(): void {
  const current = job
  if (!current) return
  current.cancelled = true
  if (current.budgetTimer) clearTimeout(current.budgetTimer)
  current.budgetTimer = null
  job = null
}

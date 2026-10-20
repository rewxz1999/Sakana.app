import { BrowserWindow } from 'electron'
import { CH } from '@shared/channels'
import type { BatchProbeUpdate } from '@shared/types'
import { log } from '../log'
import { addProbeListeners } from './probeEvents'
import {
  MEDIA_EXT_RE,
  extractStreamCandidates,
  isPlayerOrDanmakuPage,
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

/**
 * 同时探测几条规则 = **严格 3 条**（用户原话：「规则嗅探我指的是 3 个一次的来嗅探」）。
 *
 * 上一版把 AGE / aafun / sorani 三条单独提出来「同时开始」，再给其余规则开 3 个 worker ——
 * 实际并发是 **6**（3 条优先 + 3 条排队），这既不是用户要的 3，也是站点压力的来源：
 * 每次探测慢路都要开一个真实浏览器窗口，6 条一起开时站点风控与 S 级网络队列会同时被顶满，
 * 后面那些规则更容易超时，看起来就是「以前能嗅到、现在没结果」。
 *
 * 所以这里只有一个池子：**所有规则**（含三条常用规则）一起按这个上限排队，没有例外。
 * 允许用环境变量覆盖（排障时想临时跑 1 条复现最稳），默认仍是 3。
 */
const DEFAULT_CONCURRENCY = 3
function probeConcurrency(): number {
  const raw = Number(process.env.SAKANA_RULE_PROBE_CONCURRENCY ?? '')
  if (Number.isFinite(raw) && raw >= 1) return Math.min(8, Math.floor(raw))
  return DEFAULT_CONCURRENCY
}
/**
 * 纯 HTTP 步骤（搜索 / 选集 / 播放页抓取）的单步超时。
 *
 * 为什么从 12s 提到 20s：axios 自己的超时是 30s，而 v1.1 新增的 S/A/B 网络队列
 * 会让「搜索」这类 S 级请求**先排队再发**。12s 的窗口在站点稍慢/队列稍忙时就会先到点，
 * 而超时的请求并不会被取消（它继续占着 S 槽直到 30s），于是越等越慢、越慢越超时。
 * 20s 既给了真实站点（实测 sorani/AGE 的详情页 0.4~12s）余量，也仍能在
 * 「站点真挂了」时及时收手去开窗口嗅探。
 */
const STEP_TIMEOUT_MS = 45_000
/** 开窗口嗅探的最长等待（15s：点击脚本在 1.2/3/6s 各跑一次，至少留两轮机会） */
const SNIFF_TIMEOUT_MS = 15_000
/** 拿到第一个候选后再多等一会儿，把同一部剧的其它候选（多码率/多分片）也收进来 */
const SNIFF_GRACE_MS = 2_500
/** 整个任务的预算：到点后**逐条**给未完成的规则发结论并停止，不让界面永远停在「搜索中」 */
const JOB_BUDGET_MS = 150_000

/* 默认三规则优先已移除：所有规则共用一个 3 并发池（见上面的 DEFAULT_CONCURRENCY） */

/**
 * 探测结果缓存：**只常驻「真的抓到流」的正结果**，负结果只短存 1 分钟。
 *
 * ## 为什么必须把负结果从常驻缓存里赶出去（v1.2.1 修的就是这条回归）
 *
 * 上一版（V1.2.0）把「这条规则没结果」也写进了同一张 LRU，而且**永不过期**。
 * 一次探测定性为负的原因很多，而且大多**是临时的**：
 *   · 搜索/选集请求刚好排在本应用 S 级网络队列里，12s 单步超时先到点（请求其实还在走）；
 *   · 站点这一会儿 5xx / 人机验证 / 限流；
 *   · 开窗口嗅探时站点播放器还没初始化完，15s 窗口先关了。
 * 这些都会被写成「这条规则里没有这部番剧」并**在该进程内永久命中** ——
 * 用户看到的现象正是「原本能嗅探到的规则，过一段时间再进就显示没有结果」。
 *
 * 所以缓存分两层：
 *   · `probeCache`（正结果：count>0 或拿到了 url）—— 用户要求「应用没关闭就一直保留」，常驻 + LRU 400；
 *   · `negativeCache`（负结果）—— 只活 `NEGATIVE_TTL_MS`（60s），不占 LRU、不参与淘汰，
 *     每次命中都会打一条明确日志（「负结果短缓存 42s，到期自动重探」），
 *     用户点「重新探测」（force）时正负两层一起清掉。
 *
 * ## 为什么键是「规则id + 番剧条目」
 *
 * 键里不放「这一批规则」，否则启用/停用任意一条规则就会让整批缓存作废；
 * 键里放 subjectId（没有就放关键词），同一部番换一集回来仍然命中。
 *
 * ## 为什么正结果不过期
 *
 * 用户明确要求「只要应用没关闭就一直保留」；站点是否可用是"这一会儿"的事，
 * 所以保留「重新探测」作为唯一手动刷新出口，不用"我们猜它过期了"去悄悄丢掉结果。
 */
const PROBE_CACHE_MAX = 400
/** 负结果只保留这么久：够挡住「同一个列表来回开关」的重复探测，又不至于让临时故障变永久结论 */
const NEGATIVE_TTL_MS = 60_000
interface ProbeCacheEntry {
  at: number
  update: BatchProbeUpdate
}
const probeCache = new Map<string, ProbeCacheEntry>()
const negativeCache = new Map<string, ProbeCacheEntry>()

/** 番剧标识：优先条目 id（同一部番的中文名可能变），没有就用关键词 */
function subjectKeyOf(job: ActiveJob): string {
  return job.subjectId ? `s${job.subjectId}` : `k${job.keyword.trim().toLowerCase()}`
}

function cacheKeyOf(job: ActiveJob, ruleId: string): string {
  return `${ruleId}|${subjectKeyOf(job)}`
}

/**
 * 「这条结果算不算正结果」——**唯一判据**：真的拿到了候选流。
 *
 * 只有「有番剧、有剧集、但抓不到流」和「没有这部番」都不算：
 * 前者对播放没有价值（点进去还是播不了），后者更是一次探测的失败态。
 * 两类都只进 60s 的负缓存，下次进列表会重新探。
 */
function hasStreamResult(u: BatchProbeUpdate): boolean {
  return !!u.ok && ((u.count ?? 0) > 0 || !!u.url)
}

/** 读正缓存（命中即刷新 LRU 顺序：Map 的插入顺序就是"最近使用"顺序） */
function cacheGet(job: ActiveJob, ruleId: string): BatchProbeUpdate | null {
  const key = cacheKeyOf(job, ruleId)
  const hit = probeCache.get(key)
  if (!hit) return null
  probeCache.delete(key)
  probeCache.set(key, hit)
  return { ...hit.update, cached: true, probedAt: hit.at }
}

/** 写正缓存 + 超容量淘汰最久未用的（Map 的第一个键就是它） */
function cacheSet(job: ActiveJob, ruleId: string, update: BatchProbeUpdate): void {
  const key = cacheKeyOf(job, ruleId)
  probeCache.delete(key)
  probeCache.set(key, { at: Date.now(), update: { ...update, probedAt: Date.now() } })
  while (probeCache.size > PROBE_CACHE_MAX) {
    const oldest = probeCache.keys().next().value as string | undefined
    if (!oldest) break
    probeCache.delete(oldest)
  }
}

/**
 * 写负缓存（短 TTL，不进 LRU）。
 * 同键的正结果**不删**：一次临时失败（限流/超时）不该抹掉上次真的抓到流的结论；
 * 用户可以继续用上次的命中信息点进去重试，60s 后本次负缓存自然过期再重探。
 */
function negativeSet(job: ActiveJob, ruleId: string, update: BatchProbeUpdate): void {
  const key = cacheKeyOf(job, ruleId)
  negativeCache.set(key, { at: Date.now(), update: { ...update, probedAt: Date.now() } })
  /*
   * 负缓存也要有上限：它不参与 LRU 淘汰，若只靠「读的时候顺手删过期」，
   * 用户连看几十部番、再也不点回去，那些条目（可能带着整季剧集）就会一直留在内存里。
   * 每次写入时清一遍到期项 + 硬上限兜底，和正缓存同样最多 400 条。
   */
  const now = Date.now()
  for (const [k, v] of negativeCache) {
    if (now - v.at > NEGATIVE_TTL_MS) negativeCache.delete(k)
  }
  while (negativeCache.size > PROBE_CACHE_MAX) {
    const oldest = negativeCache.keys().next().value as string | undefined
    if (!oldest) break
    negativeCache.delete(oldest)
  }
}

/**
 * 读负缓存：过期即删。
 *
 * ⚠️ 命中时**不刷新**时间戳：TTL 是从那次探测结束算起的 60s，
 * 到点后必须重探。如果每次命中都续命，用户每隔半分钟开关一次列表，
 * 一条临时失败的规则就会永远停在「没有结果」——那又是这次要修的回归。
 */
function negativeGet(job: ActiveJob, ruleId: string): BatchProbeUpdate | null {
  const key = cacheKeyOf(job, ruleId)
  const hit = negativeCache.get(key)
  if (!hit) return null
  const age = Date.now() - hit.at
  if (age > NEGATIVE_TTL_MS) {
    negativeCache.delete(key)
    return null
  }
  return {
    ...hit.update,
    cached: true,
    probedAt: hit.at,
    message: `${hit.update.message ?? '没有结果'}（${Math.round(age / 1000)}s 前的结论，稍后会自动重探）`
  }
}

/** 清掉某个键的正/负缓存（force=true 时用） */
function cacheDelete(job: ActiveJob, ruleId: string): void {
  const key = cacheKeyOf(job, ruleId)
  probeCache.delete(key)
  negativeCache.delete(key)
}

/** 自检/设置页用：缓存条目数与命中情况 */
export function probeCacheStats(): { size: number; capacity: number; negative: number; negativeTtlMs: number } {
  return {
    size: probeCache.size,
    capacity: PROBE_CACHE_MAX,
    negative: negativeCache.size,
    negativeTtlMs: NEGATIVE_TTL_MS
  }
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

/**
 * 把一条探测更新推给发起窗口。
 *
 * 只推**当前这一批**的更新（v1.2.1）：用户切换番剧时 `startBatchProbe` 会取消上一批，
 * 但上一批已经发出去的 HTTP 请求还要过一会儿才回来 —— 那些迟到的 update
 * 如果继续推给界面，会把新一批已经显示出来的「搜索中…」覆盖成上一部番的结论
 * （用户看到的就是「刚进来好好的，等一会儿变成没有结果」）。缓存仍然照写：
 * 旧番的结论对旧番自己有效，只是不该出现在新番的列表里。
 */
function send(j: ActiveJob, update: BatchProbeUpdate): void {
  if (j !== job) return
  const w = j.win
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
   *
   * ⚠️ 正负分流的唯一入口（v1.2.1 修回归）：**只有真的抓到候选流**才进常驻 LRU；
   * 其它「没结果 / 搜索失败 / 拿不到播放页 / 嗅探 0 条」一律只进 60s 负缓存，
   * 并且把「为什么是负」原样留在 message 里 —— 既不会永久污染缓存，也方便用户对账。
   */
  if (phase === 'done') {
    if (hasStreamResult(payload)) {
      cacheSet(job, target.id, payload)
      negativeCache.delete(cacheKeyOf(job, target.id))
    } else {
      negativeSet(job, target.id, payload)
      log.append(
        'info',
        'rule-batch',
        `负结果只短存 ${NEGATIVE_TTL_MS / 1000}s：${target.name}｜${payload.message ?? '没有结果'}`
      )
    }
  }
  return payload
}

/**
 * 单步结果：**必须能区分「超时」「明确异常」与「拿到空结果」**。
 *
 * 上一版把前三者都压成 `null`，于是「搜索请求 12s 没回来」和「站点明确没有这部番」
 * 在调用方看来一模一样，最终都写成「这条规则里没有这部番剧」并**永久缓存**。
 * 现在：
 *   · 超时 → `{ timedOut: true }`，界面文案是「搜索超时」，只进 60s 负缓存；
 *   · 明确异常 → `{ failed, error }`，界面显示真实原因（404/证书/解析失败）；
 *   · 拿到空结果 → `{ value }`，这才是「站点说没有」。
 */
type StepResult<T> = { value: T } | { timedOut: true } | { failed: true; error: string }
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<StepResult<T>> {
  return await Promise.race<StepResult<T>>([
    p.then((value) => ({ value })).catch((e: unknown) => ({
      failed: true as const,
      // 明确的异常（404/证书/解析）不是超时：必须把真实原因带给界面，不能一律说「超时」
      error: String((e as { message?: string })?.message ?? e).slice(0, 120)
    })),
    new Promise<StepResult<T>>((r) => setTimeout(() => r({ timedOut: true }), ms))
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
    /*
     * 多点几次「播放」：不只是一次性点一下（v1.2.1 补 10s）。
     *
     * 实测 AGE 的播放页本身只有一个 iframe，指向第三方解析站（WASM 启动 + 签名），
     * 真流请求经常在 6~12s 才出现。以前只有 1.2/3/6s 三次点击，12s 窗口一到就关，
     * 于是明明能出的流被判成「没有发出可识别的视频请求」。
     * 现在窗口放宽到 15s，并在 10s 再补一次点击（仍在窗口内），
     * 覆盖「解析站启动慢」这一类；不会无限重试。
     */
    for (const delay of [1200, 3000, 6000, 10_000]) setTimeout(() => runAutoPlayClicks(win), delay)
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
  const searchStep = await withTimeout(
    ruleSearch(target.id, current.keyword, current.subjectId),
    STEP_TIMEOUT_MS
  )
  if (current.cancelled) return
  /*
   * 超时 ≠ 没有这部番（v1.2.1 的关键区分）。
   * 上一版两者都报「这条规则里没有这部番剧」并写进常驻缓存 ——
   * 用户看到的「以前能嗅到、现在说没有结果」就是这么来的。
   */
  if ('timedOut' in searchStep) {
    update(current, target, 'done', t0, {
      ok: false,
      items: [],
      message: `搜索超时（${STEP_TIMEOUT_MS / 1000}s 内站点没有响应，可点「重新探测」重试）`
    })
    return
  }
  if ('failed' in searchStep) {
    update(current, target, 'done', t0, {
      ok: false,
      items: [],
      message: `搜索失败：${searchStep.error}`
    })
    return
  }
  const search = searchStep.value
  if (!search.items?.length) {
    update(current, target, 'done', t0, {
      // 站点明确没有这部番：这是一条「负结论」，只短存 60s，不进常驻缓存
      ok: !search.error,
      items: [],
      message: search.error ? `搜索失败：${search.error}` : '这条规则里没有这部番剧'
    })
    return
  }
  const entry = search.items[0]
  const epsStep = await withTimeout(ruleEpisodes(target.id, entry), STEP_TIMEOUT_MS)
  if (current.cancelled) return
  const eps = 'value' in epsStep ? epsStep.value : null
  const group = eps?.groups?.[0]
  const episodeCount = eps?.groups?.reduce((n, g) => n + (g.episodes?.length ?? 0), 0) ?? 0
  /*
   * 把搜索结果与剧集一起带出去（v1.1）。
   * 「带哪一条的剧集」= 搜索结果的第一条：界面点开源时先列搜索结果，
   * 用户点第一条是最常见的路径；其它条目仍按需拉取（但搜索结果本身已经是本地的了）。
   */
  const base = { items: search.items, groups: eps?.groups ?? [], vars: eps?.vars ?? {} }
  if ('timedOut' in epsStep) {
    update(current, target, 'done', t0, {
      hit: true,
      ok: false,
      ...base,
      message: `选集超时（${STEP_TIMEOUT_MS / 1000}s 内详情页没有响应，可重试）`
    })
    return
  }
  if ('failed' in epsStep) {
    update(current, target, 'done', t0, {
      hit: true,
      ok: false,
      ...base,
      message: `选集失败：${epsStep.error}`
    })
    return
  }
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
  const playStep = await withTimeout(
    rulePlay(target.id, entry, 0, 0, group.episodes[0].link, vars),
    STEP_TIMEOUT_MS
  )
  if (current.cancelled) return
  if ('timedOut' in playStep || 'failed' in playStep || !playStep.value?.url) {
    update(current, target, 'done', t0, {
      hit: true,
      episodes: episodeCount,
      ok: false,
      ...base,
      message: 'failed' in playStep ? `播放页解析失败：${playStep.error}` : '拿不到播放页地址'
    })
    return
  }
  const play = playStep.value

  // 快路：播放页 HTML 里直接写着真实地址（MacCMS 系站点）
  const directStep = await withTimeout(extractStreamCandidates(play.url, target.baseUrl), STEP_TIMEOUT_MS)
  if (current.cancelled) return
  /*
   * 播放页超时**不是失败**：慢路（窗口嗅探）本来就要在这个地址上再跑一次，
   * 所以这里直接落到慢路，而不是把整条规则判成「拿不到地址」。
   * （实测 sorani 的播放页在 node 侧 45~60s 才回，窗口侧会走真实浏览器、通常快得多。）
   */
  const directRaw = 'value' in directStep ? directStep.value : []
  /*
   * V1.4：过滤「播放器/弹幕页」这类假候选。
   *
   * 真机证据（E站/中二病）：播放页 HTML 里出现
   *   https://player.ezdmw.com/danmuku/?nk=…&type=1…
   * `extractStreamCandidates` 把它当成媒体地址返回，于是界面显示"1 个候选"，
   * 用户点进去必然失败。这类地址是 iframe 的**页面**，不是媒体流，一律丢掉。
   */
  const direct = directRaw.filter((u) => !isPlayerOrDanmakuPage(u))
  if (direct.length > 0) {
    const playableStep = await withTimeout(resolveFirstPlayable(direct, target.baseUrl), STEP_TIMEOUT_MS)
    if (current.cancelled) return
    const playable = 'value' in playableStep ? playableStep.value : null
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
 * ## 调度（v1.2.1：严格 3 并发，不再给任何规则开小灶）
 *
 * 1. **缓存先回放**：逐条查「规则 + 番剧」的常驻缓存（只含正结果）与 60s 负缓存，
 *    命中的立刻推给界面（标 cached），这些规则不再参与探测。
 * 2. **所有要探的规则进同一个池子**：`Math.min(3, 待探数)` 个 worker 依次取任务。
 *    AGE / aafun / sorani 也一样排队 —— 用户要的就是「3 个一次」，
 *    上一版给它们单开并行、再叠 3 个 worker，实际是 6 个，站点一忙就集体超时。
 * 3. **每次开工/收工都打印账本**：`当前在嗅探 N 个、排队 M 个`，
 *    用户拿日志就能核对「是不是真的只有 3 个在跑」，排障也不用再猜。
 */
export function startBatchProbe(
  win: BrowserWindow,
  req: { keyword: string; rules: BatchProbeTarget[]; force?: boolean; subjectId?: number }
): { jobId: string; total: number; cached: boolean; probedAt?: number } {
  stopBatchProbe()
  const id = `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const targets = req.rules.filter((r) => r && r.id)
  const concurrency = probeConcurrency()
  const current: ActiveJob = {
    id,
    keyword: req.keyword,
    subjectId: req.subjectId,
    win,
    cancelled: false,
    budgetTimer: null
  }
  /*
   * 先登记成「当前批次」再回放缓存：`send()` 只推当前批次的更新，
   * 否则下面这些 cached 事件会被自己过滤掉（见 send 的说明）。
   */
  job = current

  /*
   * ① 逐条回放缓存。`force`（用户点「重新探测」）时把该规则的正/负缓存都清掉重跑。
   * 注意这里是**逐条**判断：一批里可能只有几条命中（其它是用户新启用的规则），
   * 命中的直接出结果，没命中的继续探 —— 不会因为一条没缓存就把整批重跑。
   */
  const pending: BatchProbeTarget[] = []
  let cachedCount = 0
  let negativeCount = 0
  let latestAt = 0
  for (const t of targets) {
    if (req.force) cacheDelete(current, t.id)
    const hit = cacheGet(current, t.id)
    if (hit) {
      cachedCount++
      latestAt = Math.max(latestAt, hit.probedAt ?? 0)
      send(current, { ...hit, jobId: id, cached: true })
      continue
    }
    const neg = negativeGet(current, t.id)
    if (neg) {
      negativeCount++
      send(current, { ...neg, jobId: id, cached: true })
      log.append('info', 'rule-batch', `负结果短缓存命中（60s 内不重探）：${t.name}｜${neg.message ?? ''}`)
      continue
    }
    pending.push(t)
  }
  if (pending.length === 0) {
    // 整批都命中缓存：一个窗口都不开，直接结束
    log.append(
      'info',
      'rule-batch',
      `批量预嗅探全部命中缓存（正结果 ${cachedCount} 条、负结果 ${negativeCount} 条，最早探测于 ${
        latestAt ? new Date(latestAt).toLocaleTimeString() : '未知'
      }）`
    )
    job = null
    return { jobId: `${id}-cached`, total: targets.length, cached: true, probedAt: latestAt || undefined }
  }
  if (cachedCount > 0 || negativeCount > 0) {
    log.append(
      'info',
      'rule-batch',
      `批量预嗅探：正结果命中 ${cachedCount} 条、负结果短存命中 ${negativeCount} 条，剩 ${pending.length} 条要探`
    )
  }

  log.append(
    'info',
    'rule-batch',
    `开始批量预嗅探「${req.keyword}」：${pending.length} 条规则，并发上限 ${concurrency}` +
      `（当前在嗅探 0 个、排队 ${pending.length} 个）${req.force ? '（用户要求重新探测）' : ''}`
  )

  /** 已出结论的目标（预算到点时用来补发「未完成」，避免界面永远停在「搜索中」） */
  const done = new Set<string>()
  const jobStart = Date.now()
  let started = 0
  let active = 0

  current.budgetTimer = setTimeout(() => {
    if (job !== current) return
    log.append(
      'warn',
      'rule-batch',
      `批量预嗅探超时（${JOB_BUDGET_MS / 1000}s）：已完成 ${done.size}/${pending.length} 条，剩余规则将收到「未完成」结论`
    )
    /*
     * 必须**逐条补发 done**：上一版只是取消，没出结论的规则在界面上永远停在
     * 「搜索中…」——用户分不清是"还没探完"还是"这条规则坏了"。
     */
    for (const t of pending) {
      if (done.has(t.id)) continue
      update(current, t, 'done', jobStart, {
        ok: false,
        message: `探测未完成（整批 ${JOB_BUDGET_MS / 1000}s 预算到点，可点「重新探测」单独重试）`
      })
    }
    stopBatchProbe()
  }, JOB_BUDGET_MS)

  /** 探一条；异常也要给出结论，否则界面永远停在「搜索中…」 */
  const runOne = async (target: BatchProbeTarget): Promise<void> => {
    if (current.cancelled || job !== current) return
    started += 1
    active += 1
    const queued = Math.max(0, pending.length - started)
    log.append(
      'info',
      'rule-batch',
      `开始嗅探「${target.name}」（当前在嗅探 ${active} 个、排队 ${queued} 个）`
    )
    try {
      await probeRule(current, target)
    } catch (err) {
      update(current, target, 'done', Date.now(), {
        ok: false,
        message: `探测异常：${String((err as Error)?.message ?? err).slice(0, 100)}`
      })
    } finally {
      active = Math.max(0, active - 1)
      done.add(target.id)
      log.append(
        'info',
        'rule-batch',
        `嗅探收工「${target.name}」（当前在嗅探 ${active} 个、排队 ${Math.max(0, pending.length - started)} 个）`
      )
    }
  }

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      if (current.cancelled || job !== current) return
      await runOne(pending[cursor++])
    }
  }

  void Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker)).then(() => {
    if (job !== current) return
    log.append(
      'info',
      'rule-batch',
      `批量预嗅探结束（${targets.length} 条规则，其中正结果缓存 ${cachedCount} 条、负结果短存 ${negativeCount} 条）`
    )
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

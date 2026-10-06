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
 * 结果缓存（v0.3.7，用户要求）。
 *
 * 「一次探测十几秒、每次进播放源列表都重跑」既慢又对站点不礼貌，
 * 所以同一部番剧 + 同一批规则的结果缓存 30 分钟：
 * 再进播放源列表时直接回放上次结果（`cached: true`），只有用户点「重新探测」才真的重跑。
 *
 * 为什么是内存缓存而不是落盘：站点可用性本来就是"这一会儿"的事，
 * 跨进程重启还拿几十分钟前的结论反而会误导用户；而且这份数据没有任何持久价值。
 */
const CACHE_TTL_MS = 30 * 60 * 1000
const resultCache = new Map<string, { at: number; results: BatchProbeUpdate[] }>()

/** 缓存键：同一关键词 + 同一批规则才算同一件事（规则集变了就必须重探） */
function cacheKey(keyword: string, rules: BatchProbeTarget[]): string {
  return `${keyword.trim()}|${rules
    .map((r) => r.id)
    .slice()
    .sort()
    .join(',')}`
}

export interface BatchProbeTarget {
  id: string
  name: string
  baseUrl: string
}

interface ActiveJob {
  id: string
  keyword: string
  /** 结果往这个窗口发（就是发起探测的那个窗口） */
  win: BrowserWindow
  cancelled: boolean
  budgetTimer: NodeJS.Timeout | null
  /** 本次任务对应的缓存键：每条规则出结果时逐条写进缓存 */
  cacheKey: string
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
   * 已经探到的结论不该跟着丢掉。
   */
  if (phase === 'done') {
    const entry = resultCache.get(job.cacheKey) ?? { at: Date.now(), results: [] }
    const idx = entry.results.findIndex((r) => r.ruleId === target.id)
    if (idx >= 0) entry.results[idx] = payload
    else entry.results.push(payload)
    entry.at = Date.now()
    resultCache.set(job.cacheKey, entry)
  }
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
  const search = await withTimeout(ruleSearch(target.id, current.keyword), STEP_TIMEOUT_MS)
  if (current.cancelled) return
  if (!search || !search.items?.length) {
    update(current, target, 'done', t0, {
      ok: true,
      message: search?.error ? `搜索失败：${search.error}` : '这条规则里没有这部番剧'
    })
    return
  }
  const entry = search.items[0]
  const eps = await withTimeout(ruleEpisodes(target.id, entry), STEP_TIMEOUT_MS)
  if (current.cancelled) return
  const group = eps?.groups?.[0]
  const episodeCount = eps?.groups?.reduce((n, g) => n + (g.episodes?.length ?? 0), 0) ?? 0
  if (!group || !group.episodes?.length) {
    update(current, target, 'done', t0, {
      hit: true,
      ok: true,
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
    update(current, target, 'done', t0, { hit: true, episodes: episodeCount, ok: true, message: '拿不到播放页地址' })
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
      message: `播放页直出 ${direct.length} 个候选`
    })
    return
  }

  // 慢路：开窗口嗅探
  update(current, target, 'sniff', t0, { hit: true, episodes: episodeCount })
  const sniffed = await sniffWindow(current, play.url, target.baseUrl)
  if (current.cancelled) return
  update(current, target, 'done', t0, {
    hit: true,
    episodes: episodeCount,
    count: sniffed.urls.length,
    url: sniffed.urls[0],
    ok: true,
    message:
      sniffed.urls.length > 0
        ? `嗅探到 ${sniffed.urls.length} 个候选`
        : sniffed.error ?? '播放页没有发出可识别的视频请求'
  })
}

/**
 * 开始一批探测。同一时刻只允许一批（再开一批会取消上一批）：
 * 这是对第三方的礼貌 —— 用户来回切番剧时不该堆出几十个探测任务。
 */
export function startBatchProbe(
  win: BrowserWindow,
  req: { keyword: string; rules: BatchProbeTarget[]; force?: boolean }
): { jobId: string; total: number; cached: boolean; probedAt?: number } {
  stopBatchProbe()
  const id = `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const targets = req.rules.filter((r) => r && r.id)
  const key = cacheKey(req.keyword, targets)
  const hit = resultCache.get(key)
  /*
   * 缓存命中且用户没有要求重探：直接把上次结果回放给界面（标 cached + 探测时间），
   * 一个窗口都不开。用户想更新时点「重新探测」即可（force=true）。
   */
  if (!req.force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    const jobId = `${id}-cached`
    for (const r of hit.results) {
      const payload: BatchProbeUpdate = { ...r, jobId, cached: true, probedAt: hit.at }
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(CH.evRuleBatchProbe, payload)
      }
    }
    log.append('info', 'rule-batch', `批量预嗅探命中缓存（${hit.results.length} 条，探测于 ${new Date(hit.at).toLocaleTimeString()}）`)
    return { jobId, total: targets.length, cached: true, probedAt: hit.at }
  }

  const current: ActiveJob = { id, keyword: req.keyword, win, cancelled: false, budgetTimer: null, cacheKey: key }
  job = current
  log.append('info', 'rule-batch', `开始批量预嗅探「${req.keyword}」，规则 ${targets.length} 条${req.force ? '（用户要求重新探测）' : ''}`)

  current.budgetTimer = setTimeout(() => {
    if (job !== current) return
    log.append('warn', 'rule-batch', `批量预嗅探超时（${JOB_BUDGET_MS / 1000}s），停止剩余规则`)
    stopBatchProbe()
  }, JOB_BUDGET_MS)

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      if (current.cancelled || job !== current) return
      const target = targets[cursor++]
      try {
        await probeRule(current, target)
      } catch (err) {
        update(current, target, 'done', Date.now(), {
          ok: false,
          message: `探测异常：${String((err as Error)?.message ?? err).slice(0, 100)}`
        })
      }
    }
  }
  void Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker)).then(() => {
    if (job !== current) return
    log.append('info', 'rule-batch', `批量预嗅探结束（${targets.length} 条规则）`)
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

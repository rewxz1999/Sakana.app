import type {
  PlayFlowCacheProgress,
  PlayFlowMark,
  PlayFlowMetrics,
  PlayFlowReason,
  PlayFlowSnapshot,
  PlayFlowStage,
  PlayFlowStageKey,
  PlayFlowStageStatus
} from '@shared/types'
import { log } from '../log'
import { logPlayTimingSummary } from './playTiming'

/**
 * 播放过程进度状态机（v0.3.9）。
 *
 * 这是「过程进度显示器」的**唯一数据源**：三个阶段（找资源 / 取资源 / 注入播放器）
 * 的真实起止时间、当前正在做的事、失败原因都记在这里，
 * 再由两条既有链路读走：
 *   ① `player:stream-info`（播放状态详情面板，已在按秒轮询）→ `StreamInfo.flow`；
 *   ② 渲染层未开播时的既有轮询 → `player:flow`（纯内存读，无网络）。
 *
 * 设计上的两条硬约束（对应工单里的「不留假状态」）：
 *   · **耗时永远由时间戳算**：`elapsedMs` 在 `snapshot()` 里按 `now - startedAt` 现算，
 *     没有任何 `setInterval` 去累加计数，也没有给动画用的假进度；
 *   · **阶段只能由真正做那件事的代码推进**：规则解析写 locate、嗅探写 acquire、
 *     内核注入写 inject。没发生就是 pending，不会为了「看起来在动」而点亮。
 */

const STAGE_LABEL: Record<PlayFlowStageKey, string> = {
  locate: '找播放资源',
  acquire: '获取播放资源',
  inject: '注入播放器'
}

const STAGE_ORDER: PlayFlowStageKey[] = ['locate', 'acquire', 'inject']

/** 每个阶段最多留多少条步骤 —— 面板上要能一眼看完，也不能让长时间等待把内存堆起来 */
const MAX_STEPS = 24

/**
 * 「注入播放器」的硬超时（用户要求：15s 未起播就报「注入失败：<原因>」，不许静默停住）。
 *
 * 为什么判据放在这里而不是 mpv.ts：三阶段状态机是**唯一**的进度数据源，
 * 超时是阶段本身的属性；放在这里所有注入路径（规则/直链/本地）都受同一口径约束，
 * 也不会出现「两个定时器各自判失败、互相覆盖」。
 *
 * 15 秒的依据：正常站点首帧 1~4s（历史日志里 inject=4s/ok），15s 还没画面
 * 基本不是"再等等"，而是地址失效/编码不支持/内核没拿到数据。
 * 失败文案会带上已经收到的字节与速率，用户能直接区分"一点没动"和"在动但解不出"。
 */
const INJECT_TIMEOUT_MS = 15_000
/**
 * 注入阶段的**硬**超时（V1.3.4）。
 *
 * 用户原话：「15s 没出现画面就显示网络问题时间上太短了，显示网络问题后还要继续拉取视频资源」。
 * 所以 15 秒只作为"提示一下网络慢"的节点，**不结束整轮**；真正判失败放到 90 秒。
 * 这中间如果数据还在进来（metrics.bytes 在涨），说明继续等是对的。
 */
const INJECT_HARD_TIMEOUT_MS = 90_000
/** 本轮注入阶段开始的时间（用于算"已等 N 秒"；beginStage('inject') 时重置） */
let injectStartedAt = 0
/** 注入阶段的一次性看门狗（成功/失败/换一轮都会清掉；不参与 elapsedMs 计算） */
let injectTimer: NodeJS.Timeout | null = null

function clearInjectTimer(): void {
  if (injectTimer) clearTimeout(injectTimer)
  injectTimer = null
}

/**
 * 武装注入超时：到点仍没有首帧就给出**明确失败**（不是让界面一直转圈）。
 *
 * 只在阶段真的处于 running 时触发；`endFlow` 后 running=false，迟到的定时器什么也不做。
 * 证据优先取本轮 `metrics`（可达性探测 / 内核采样都会写它），
 * 这样失败原因里能直接写「一个字节都没收到」还是「收到 X KB 但没解出画面」。
 */
function armInjectTimer(): void {
  clearInjectTimer()
  injectTimer = setTimeout(() => {
    injectTimer = null
    if (!running) return
    const s = stageOf('inject')
    if (s.status !== 'running') return
    const m = getMetrics()
    const evidence = [
      m.bytes > 0 ? `已收 ${Math.round(m.bytes / 1024)} KB` : '一个字节都没收到',
      m.rateBps > 0 ? `速率 ${Math.round(m.rateBps / 1024)} KB/s` : '',
      m.ttfbMs !== null && m.ttfbMs !== undefined ? `首字节 ${m.ttfbMs}ms` : '',
      m.status ? `HTTP ${m.status}` : ''
    ]
      .filter(Boolean)
      .join('，')
    if (Date.now() - injectStartedAt < INJECT_HARD_TIMEOUT_MS) {
      beginStage('inject', `网络较慢，仍在加载（已等 ${Math.round((Date.now() - injectStartedAt) / 1000)} 秒，${evidence}）`)
      armInjectTimer()
      return
    }
    /*
     * 兜底硬超时（90 秒）：此时确实该判失败了。
     * 归因：一个字节都没有 = 地址/站点问题（site）；有数据但没画面 = 解码/容器问题（format）。
     */
    failStageAndEnd(
      'inject',
      `注入失败：${INJECT_HARD_TIMEOUT_MS / 1000} 秒内播放内核没有解出首帧画面（${evidence}）`,
      m.bytes > 0 ? 'format' : 'site'
    )
  }, INJECT_TIMEOUT_MS)
}

function emptyStage(key: PlayFlowStageKey): PlayFlowStage {
  return {
    key,
    label: STAGE_LABEL[key],
    status: 'pending',
    startedAt: null,
    endedAt: null,
    elapsedMs: 0,
    detail: '',
    steps: []
  }
}

function emptyMetrics(): PlayFlowMetrics {
  return { bytes: 0, rateBps: 0, ttfbMs: null }
}

let flowId = 0
let mode = ''
let title = ''
let startedAt = Date.now()
let endedAt: number | null = null
let running = false
let stages: PlayFlowStage[] = STAGE_ORDER.map(emptyStage)
let activeStage: PlayFlowStageKey | null = null
let metrics: PlayFlowMetrics = emptyMetrics()
/**
 * 「直链缓存到本地」的进度（V2.0）。
 *
 * 为什么放在状态机里、由 mediaCache 的采样器写：
 * 加载卡和流详情面板读的是同一份快照（`api.player.flow()`），
 * 缓存进度写进快照就等于**一次改动同时喂到两处**，不需要新增事件通道或额外轮询。
 * 只在真的启动了本地缓存时才有值；HLS / 关闭缓存 / 直连时为 null（不编假进度）。
 */
let cacheProgress: PlayFlowCacheProgress | null = null
let summary = ''
let reason: PlayFlowReason = 'none'
/** 已经判定过失败/超时的阶段，避免后面迟到的 step 把它重新点亮 */
const settled = new Set<PlayFlowStageKey>()

function stageOf(key: PlayFlowStageKey): PlayFlowStage {
  let s = stages.find((x) => x.key === key)
  if (!s) {
    s = emptyStage(key)
    stages = [...stages, s]
  }
  return s
}

function withStage(key: PlayFlowStageKey, patch: Partial<PlayFlowStage>): void {
  stages = stages.map((s) => (s.key === key ? { ...s, ...patch } : s))
}

/**
 * 开一轮新流程。
 *
 * 每次「进播放页 / 切集 / 换线路」都要调用：id 自增让渲染层能区分
 * 「同一轮的实时刷新」与「换了一轮」，否则上一轮的「失败」会一直挂在界面上。
 */
export function beginFlow(opts: { mode: string; title: string }): number {
  flowId += 1
  mode = opts.mode
  title = opts.title
  startedAt = Date.now()
  endedAt = null
  running = true
  stages = STAGE_ORDER.map(emptyStage)
  activeStage = null
  metrics = emptyMetrics()
  cacheProgress = null
  summary = ''
  reason = 'none'
  settled.clear()
  clearInjectTimer()
  log.append('info', 'play-flow', `▶ 开始播放流程 #${flowId}（${mode}）：${title.slice(0, 60)}`)
  return flowId
}

/** 开始一个阶段（幂等：同一阶段重复调用只更新时间基线以外的东西，不会重置已完成的阶段） */
export function beginStage(key: PlayFlowStageKey, detail = ''): void {
  if (!running) return
  const s = stageOf(key)
  if (s.status === 'ok' || settled.has(key)) return
  /*
   * V1.3.4：注入阶段开始时记下起点，15 秒的提示与 90 秒的硬超时都基于它算
   * （用 `s.startedAt` 会随着重复 beginStage 被刷新，算出来的"已等 N 秒"会倒退）。
   */
  if (key === 'inject' && injectStartedAt === 0) injectStartedAt = Date.now()
  activeStage = key
  withStage(key, {
    status: 'running',
    startedAt: s.startedAt ?? Date.now(),
    endedAt: null,
    error: undefined,
    reason: undefined,
    detail: detail || s.detail
  })
  if (detail) pushStep(key, detail)
  // 进入注入阶段就开始计时：15s 内没有首帧 → 明确报「注入失败：<原因>」
  if (key === 'inject') armInjectTimer()
}

/** 更新当前阶段的实时说明（会显示在过程进度显示器里，所以每次调用都要是「现在正在做什么」） */
export function flowDetail(key: PlayFlowStageKey, detail: string): void {
  // 一轮已经结束（成功或失败）：迟到的细节不许再改已经定稿的时间线
  if (!running) return
  const s = stageOf(key)
  if (s.status === 'ok' || settled.has(key)) return
  if (s.status === 'pending') {
    beginStage(key, detail)
    return
  }
  withStage(key, { detail })
}

/** 往某个阶段追加一条关键步骤（有时间戳，便于事后对时） */
export function pushStep(key: PlayFlowStageKey, text: string): void {
  if (!running) return
  const s = stageOf(key)
  if (settled.has(key)) return
  const steps = [...s.steps, { at: Date.now(), text }].slice(-MAX_STEPS)
  withStage(key, { steps })
}

/** 当前阶段（用于不想显式传 key 的调用方，例如底层服务只知道「现在在取资源」） */
export function currentStage(): PlayFlowStageKey | null {
  return activeStage
}

/** 在「当前阶段」追加步骤；没有活动阶段时忽略（例如本地播放的扫描） */
export function flowStepHere(text: string): void {
  const k = activeStage
  if (k) pushStep(k, text)
}

export function succeedStage(key: PlayFlowStageKey, detail?: string): void {
  // 一轮结束后迟到的成功（慢源在失败判定之后才出首帧）不再改写结论
  if (!running) return
  const s = stageOf(key)
  if (s.status === 'ok' || settled.has(key)) return
  const now = Date.now()
  withStage(key, {
    status: 'ok',
    endedAt: now,
    elapsedMs: s.startedAt ? now - s.startedAt : 0,
    detail: detail ?? s.detail,
    error: undefined,
    reason: undefined
  })
  if (activeStage === key) activeStage = null
  if (detail) pushStep(key, detail)
  if (key === 'inject') clearInjectTimer()
}

/**
 * 阶段失败。
 *
 * `reason` 是工单要求的关键：不许只说「播放失败」，要能判定是网站问题、速度过慢
 * 还是格式不支持。调用方（streamDiag）负责给出真正的判据。
 *
 * ⚠️ 这里**不结束整轮**（结束用 `failStageAndEnd`）：自检脚本会在一轮里对多条规则
 * 依次 failStage/succeedStage，如果这里顺手 endFlow，后面的断言会全部变成「未运行」。
 */
export function failStage(key: PlayFlowStageKey, error: string, stageReason: PlayFlowReason): void {
  // 已经结束的一轮不再接受迟到的失败（可达性探测/内核采样都可能比播放晚到）
  if (!running) return
  const s = stageOf(key)
  if (s.status === 'ok' || settled.has(key)) return
  const now = Date.now()
  settled.add(key)
  withStage(key, {
    status: stageReason === 'timeout' ? 'timeout' : 'failed',
    endedAt: now,
    elapsedMs: s.startedAt ? now - s.startedAt : 0,
    error,
    reason: stageReason
  })
  if (activeStage === key) activeStage = key
  reason = stageReason
  /*
   * 失败必须**立刻**成为整轮的一句话结论（v0.3.9）。
   *
   * 这里以前只写阶段、不写 summary，而 beginFlow 把 summary 初始化成了「准备开始」——
   * 于是播放失败之后状态区与详情面板上写着「准备开始」，而阶段那行才是「失败」。
   * 用户要的是「播放失败后就显示原因」，所以失败这一句必须落在这里。
   * （独立验证脚本 .tmp-flowtest/verify.ts 第一轮就抓到了这一条。）
   */
  summary = `${STAGE_LABEL[key]}失败：${error}`
  pushStep(key, `✗ ${error}`)
  log.append('warn', 'play-flow', `阶段「${STAGE_LABEL[key]}」失败(${stageReason})：${error}`)
  if (key === 'inject') clearInjectTimer()
}

/**
 * 判失败并**结束整轮**（播放链路真正的失败出口）。
 *
 * 为什么需要它：`failStage` 只点亮阶段、不改 running；如果调用方在失败后不收尾，
 * 渲染层看到的 `flow.running` 仍然是 true、`activeStage` 仍是 inject，
 * 状态药丸就会一直显示「3/3 注入播放器」——这正是用户说的「卡在最后一步」。
 * 真实播放失败（注入超时/内核 loadfile 失败）一律走这里，让整轮**有终点**：
 * running=false + summary=失败原因 + 一条结束日志。
 */
export function failStageAndEnd(key: PlayFlowStageKey, error: string, stageReason: PlayFlowReason): void {
  if (!running) return
  failStage(key, error, stageReason)
  endFlow({ ok: false, summary: error, reason: stageReason })
}

/** 归因但不结束阶段：用于「速度过慢」——它**不是**失败，播放要继续等 */
export function noteSlow(rateBps: number, detail: string): void {
  // 一轮结束后迟到的「过慢」会盖掉已经定稿的成功/失败结论，直接丢弃
  if (!running) return
  reason = 'slow'
  summary = detail
  log.append('warn', 'play-flow', `速度过慢：${detail}（${Math.round(rateBps / 1024)} KB/s）`)
}

export function setMetrics(patch: Partial<PlayFlowMetrics>): void {
  metrics = { ...metrics, ...patch }
}

export function getMetrics(): PlayFlowMetrics {
  return { ...metrics }
}

/**
 * 写入本地缓存进度（V2.0）。
 *
 * 由 `cacheFlowMeter` 每 500ms 采一次 `mediaCache` 的会话状态后调用；
 * 一轮结束后（`running=false`）仍然继续接受写入 —— 缓存还在落盘，界面上的
 * 「已缓存 x / y MB」不应该在注入阶段一结束就冻住。真正的清零发生在 `beginFlow` / `resetFlow`。
 */
export function setCacheProgress(p: PlayFlowCacheProgress | null): void {
  cacheProgress = p ? { ...p } : null
}

export function getCacheProgress(): PlayFlowCacheProgress | null {
  return cacheProgress ? { ...cacheProgress } : null
}

/** 整轮结束（成功或放弃）。注意：成功结束不覆盖已经记下的失败归因 */
export function endFlow(opts?: { ok?: boolean; summary?: string; reason?: PlayFlowReason }): void {
  if (!running) return
  running = false
  endedAt = Date.now()
  clearInjectTimer()
  if (opts?.ok) {
    reason = 'none'
    summary = opts.summary ?? '已开始播放'
  } else {
    if (opts?.summary) summary = opts.summary
    if (opts?.reason && opts.reason !== 'none') reason = opts.reason
    if (!summary) summary = '播放未成功'
  }
  const total = endedAt - startedAt
  const detail = stages
    .filter((s) => s.startedAt !== null)
    .map((s) => `${s.label}=${Math.round((s.elapsedMs || (s.endedAt ?? Date.now()) - (s.startedAt ?? 0)) / 1000)}s/${s.status}`)
    .join(' ')
  log.append(
    opts?.ok ? 'info' : 'warn',
    'play-flow',
    `${opts?.ok ? '✔' : '✘'} 播放流程 #${flowId} 结束，总耗时 ${(total / 1000).toFixed(1)}s ${detail}｜${summary}`
  )
  /*
   * v1.3 提速工单：无论成功（首帧）还是失败（15 秒看门狗），都在这里补一行**分段计时**。
   *
   * 为什么挂在这里：整轮播放只有一个终点（`endFlow`），成功/失败两条路都会走到它；
   * 用户下次说「慢」时，日志里这一行就能回答「慢在解析、嗅探、交接还是内核取流」，
   * 而不是只看到一句总耗时。没有点击时刻的播放（本地文件/托盘）不会打这行。
   */
  logPlayTimingSummary(opts?.ok ? '已出首帧' : '未出首帧')
}

/**
 * 被自检程序重置时用：把进行中的阶段标成「已重置」。
 *
 * 为什么不直接清空：用户要求「不要静默」—— 界面上要如实说明自检做了什么，
 * 所以这里把动作记进对应阶段的步骤里，而不是让阶段凭空消失。
 */
export function markReset(what: string): void {
  const k = activeStage ?? 'acquire'
  settled.add(k)
  withStage(k, { status: 'failed', endedAt: Date.now(), error: what, reason: 'internal' })
  reason = 'internal'
  pushStep(k, `↺ 自检重置：${what}`)
  clearInjectTimer()
  log.append('warn', 'play-flow', `自检重置（${STAGE_LABEL[k]}）：${what}`)
}

export function resetFlow(): void {
  flowId += 1
  mode = ''
  title = ''
  startedAt = Date.now()
  endedAt = null
  running = false
  stages = STAGE_ORDER.map(emptyStage)
  activeStage = null
  metrics = emptyMetrics()
  cacheProgress = null
  summary = ''
  reason = 'none'
  settled.clear()
  clearInjectTimer()
  // V1.3.4：新一轮必须重置注入起点，否则下一集算出来的"已等 N 秒"会带上上一集的时长
  injectStartedAt = 0
}

/** 生成一句话结论：界面上「卡在哪一步 + 为什么」就靠它 */
function buildSummary(): string {
  /*
   * 优先级：失败/超时 > 显式结论（过慢、endFlow 写的）> 正在进行的阶段 > 完成/未开始。
   *
   * 失败排在最前面是刻意的：用户要的是「播放失败后就显示原因」，
   * 一旦有阶段判失败，界面上那一句话就必须是原因本身，
   * 不能被「某个阶段还在跑」之类的描述盖住。
   */
  const bad = stages.find((s) => s.status === 'failed' || s.status === 'timeout')
  if (bad) {
    const err = bad.error ?? '原因未知'
    /*
     * 已经是「XX失败：原因」形状的文案直接用，避免出现
     * 「【注入播放器失败】注入失败：…」这种重复（v1.2.1 的注入看门狗就是这种形状）。
     */
    return /^[^：]{0,12}失败：/.test(err) ? err : `【${bad.label}失败】${err}`
  }
  if (summary) return summary
  const runningStage = stages.find((s) => s.status === 'running')
  if (runningStage) {
    return `${runningStage.label}中${runningStage.detail ? `：${runningStage.detail}` : '…'}`
  }
  if (stages.some((s) => s.startedAt !== null) && stages.every((s) => s.status === 'ok')) {
    return '三阶段全部完成'
  }
  return running ? '进行中' : '未开始'
}

/**
 * 快照。
 *
 * 正在运行的阶段不写死耗时：每次调用都按 `Date.now() - startedAt` 现算，
 * 所以渲染层每秒拉一次就能看到真实的跳秒 —— 这就是「实时更新」的实现方式，
 * 主进程侧不需要为它跑任何定时器。
 */
export function snapshot(): PlayFlowSnapshot {
  const now = Date.now()
  const stagesOut: PlayFlowStage[] = stages.map((s) => ({
    ...s,
    steps: [...s.steps],
    elapsedMs:
      s.startedAt === null ? 0 : (s.endedAt ?? (s.status === 'running' ? now : s.startedAt)) - s.startedAt
  }))
  return {
    id: flowId,
    mode,
    title,
    startedAt,
    endedAt,
    running,
    stages: stagesOut,
    activeStage,
    metrics: { ...metrics },
    cache: cacheProgress ? { ...cacheProgress } : null,
    summary: buildSummary(),
    reason
  }
}

/** 供日志/自检用：当前是否有一轮在进行 */
export function flowRunning(): boolean {
  return running
}

/**
 * 把渲染层发来的标记应用到状态机上（v0.3.9）。
 *
 * 这是渲染层与主进程之间**唯一**的阶段切换入口：渲染层知道页面流程
 * （规则搜索 → 取集 → 进播放页 → 建嗅探 → 交给内核），主进程持有状态，
 * 底层服务（ruleProbe / ruleWebview / mpv）直接往同一个状态里补细节。
 * 三边合起来才是过程进度显示器要的那条时间线。
 */
export function applyMark(mark: PlayFlowMark | null | undefined): void {
  if (!mark || typeof mark !== 'object') return
  switch (mark.kind) {
    case 'begin':
      beginFlow({ mode: String(mark.mode ?? ''), title: String(mark.title ?? '') })
      break
    case 'stage':
      beginStage(mark.stage, mark.detail ?? '')
      break
    case 'detail':
      if (mark.stage) flowDetail(mark.stage, String(mark.text ?? ''))
      else flowStepHere(String(mark.text ?? ''))
      break
    case 'step':
      if (mark.stage) pushStep(mark.stage, String(mark.text ?? ''))
      else flowStepHere(String(mark.text ?? ''))
      break
    case 'ok':
      succeedStage(mark.stage, mark.detail)
      break
    case 'fail':
      failStage(mark.stage, String(mark.error ?? ''), mark.reason ?? 'internal')
      break
    case 'done':
      endFlow({ ok: !!mark.ok, summary: mark.summary, reason: mark.reason })
      break
    case 'metrics':
      setMetrics(mark.patch ?? {})
      break
    /*
     * v0.3.9 自查补的：播放页在**没有真实播放目标**时也可能被打开（托盘、小窗口、上个会话残留），
     * 那种情况下渲染层不该开一轮流程 —— 但它已经把状态留在内存里了，
     * 所以要有一个「清掉，别显示假进度」的入口，否则状态区会一直挂着「找播放资源 进行中」。
     */
    case 'reset':
      resetFlow()
      break
    default:
      break
  }
}

/** 阶段状态一览（自检脚本断言用） */
export function stageStatuses(): Record<PlayFlowStageKey, PlayFlowStageStatus> {
  return {
    locate: stageOf('locate').status,
    acquire: stageOf('acquire').status,
    inject: stageOf('inject').status
  }
}

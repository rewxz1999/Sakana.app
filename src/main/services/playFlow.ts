import type {
  PlayFlowMark,
  PlayFlowMetrics,
  PlayFlowReason,
  PlayFlowSnapshot,
  PlayFlowStage,
  PlayFlowStageKey,
  PlayFlowStageStatus
} from '@shared/types'
import { log } from '../log'

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
  summary = ''
  reason = 'none'
  settled.clear()
  log.append('info', 'play-flow', `▶ 开始播放流程 #${flowId}（${mode}）：${title.slice(0, 60)}`)
  return flowId
}

/** 开始一个阶段（幂等：同一阶段重复调用只更新时间基线以外的东西，不会重置已完成的阶段） */
export function beginStage(key: PlayFlowStageKey, detail = ''): void {
  if (!running) return
  const s = stageOf(key)
  if (s.status === 'ok' || settled.has(key)) return
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
}

/** 更新当前阶段的实时说明（会显示在过程进度显示器里，所以每次调用都要是「现在正在做什么」） */
export function flowDetail(key: PlayFlowStageKey, detail: string): void {
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
}

/**
 * 阶段失败。
 *
 * `reason` 是工单要求的关键：不许只说「播放失败」，要能判定是网站问题、速度过慢
 * 还是格式不支持。调用方（streamDiag）负责给出真正的判据。
 */
export function failStage(key: PlayFlowStageKey, error: string, stageReason: PlayFlowReason): void {
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
}

/** 归因但不结束阶段：用于「速度过慢」——它**不是**失败，播放要继续等 */
export function noteSlow(rateBps: number, detail: string): void {
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

/** 整轮结束（成功或放弃）。注意：成功结束不覆盖已经记下的失败归因 */
export function endFlow(opts?: { ok?: boolean; summary?: string; reason?: PlayFlowReason }): void {
  if (!running) return
  running = false
  endedAt = Date.now()
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
  summary = ''
  reason = 'none'
  settled.clear()
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
  if (bad) return `【${bad.label}失败】${bad.error ?? '原因未知'}`
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

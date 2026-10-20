import { log } from '../log'
import { resetHandoff } from './playHandoff'

/**
 * 「播放规则 → 真正出画面」分段计时（v1.3 提速工单）。
 *
 * ## 为什么要有这个模块
 *
 * 用户原话是「我们原本是参考 kazumi 来做的，到实际效果远没有 kazumi 快」——
 * 这类反馈最怕的就是各说各话：我们只能回「应该不慢」，用户只能回「就是慢」。
 * 所以这里把从**点击某一集**到**画面出来**拆成四段，每段只记一个时间戳：
 *
 *   点击 → 选源（播放页地址就绪） → 嗅探命中（拿到可交给内核的直链）
 *        → loadfile（地址真的交给内核） → 首帧（内核解出第一帧）
 *
 * 四个时间戳都取自**真正做那件事的代码**（IPC / 嗅探 / mpv），不是估算；
 * 结束时只打一行，形状固定，用户复制一行日志就能定位慢在哪：
 *
 *   [play-flow] 计时 点击→选源 120ms / 选源→嗅探命中 800ms / 命中→loadfile 30ms / loadfile→首帧 900ms
 *
 * ## 为什么用模块级单例
 *
 * 一次播放只可能有一条链路（换集会重新点击、重新开始），所以不需要按 id 存多份；
 * 渲染层点击、主进程嗅探、内核各自只调用 `markPlayTiming`，谁先到谁写，写过的不会被覆盖。
 * 这样即使某一段没发生（例如本地文件没有「嗅探命中」），那一格显示 `—`，不会伪造数据。
 */

/** 四个打点的名字；顺序就是链路顺序 */
export const PLAY_TIMING_MARKS = ['选源', '命中', 'loadfile', '首帧'] as const
export type PlayTimingMark = (typeof PLAY_TIMING_MARKS)[number]

/**
 * 本地临时缓存（边下边播，v1.4）的三个打点。
 *
 * 为什么单独一组、而不是塞进上面四个点里：
 *   · 上面四点是**每次播放都有**的固定链路，本地缓存只在一部分播放里发生（HLS/失败回退没有）；
 *   · 用户要对比的是「改前直连 vs 改后缓存」时**缓存本身**的开销，
 *     所以这里量的是「建会话 → 上游首字节 → 本地可播首字节」这条新链路。
 * 三个点都只在本轮新建缓存会话时打（复用上一轮已缓存的剧集不会污染这一轮的数字）。
 */
export const CACHE_TIMING_MARKS = ['建会话', '上游首字节', '本地可播'] as const
export type CacheTimingMark = (typeof CACHE_TIMING_MARKS)[number]

/** 点击时刻（0 = 本轮没有点击，例如直接播放本地文件） */
let clickAt = 0
/** 打点时刻表：同一个点只记第一次（迟到的事件不覆盖真实时刻） */
let marks: Partial<Record<PlayTimingMark, number>> = {}
/** 本地缓存的打点（见 CACHE_TIMING_MARKS 的说明） */
let cacheMarks: Partial<Record<CacheTimingMark, number>> = {}
/** 一轮只打一行，避免成功/失败两条路各打一次 */
let logged = false
/** 这一轮是谁开的（写进日志，便于区分规则播放/本地/直链） */
let trigger = ''

/**
 * 开始一轮计时。
 *
 * 调用点在「用户点击某一集」的地方（`rules.play` 的 IPC 入口），
 * 同时清空交接候选队列：新的一集不该沿用上一集剩下的候选。
 */
export function beginPlayTiming(why = ''): void {
  clickAt = Date.now()
  marks = {}
  cacheMarks = {}
  logged = false
  trigger = why
  resetHandoff()
}

/**
 * 打一个点（幂等：同一个点只认第一次）
 */
export function markPlayTiming(name: PlayTimingMark): void {
  if (clickAt <= 0) return
  if (marks[name]) return
  marks[name] = Date.now()
  /*
   * V1.2.4：首帧**晚于**摘要行到达时，补打一行。
   *
   * 真机上就是这个现象（用户贴的日志）：
   *   17:41:09 [play-flow] 计时 … loadfile→首帧 —｜…｜未出首帧
   *   17:41:11 [mpv] 画面已出现（hasPicture=true，视频宽 1920px）
   * 也就是**画面其实出来了**，但摘要行在它之前 2 秒就已经打印并清空了计时状态，
   * 于是这一行永远显示"未出首帧" —— 看日志的人会误判成播放失败。
   * 现在只要摘要已打印、而首帧是之后才到的，就再补一行「首帧补记」，
   * 数字仍然是对的（marks 在缺首帧时不再被清空，见 logPlayTimingSummary）。
   */
  if (name === '首帧' && logged) {
    log.append('info', 'play-flow', `${playTimingLine()}｜首帧补记`)
    clickAt = 0
    marks = {}
    cacheMarks = {}
    logged = false
  }
}

/**
 * 打一个本地缓存点（幂等：同一个点只认第一次）。
 *
 * 调用方是 `services/mediaCache.ts` 里真正做那件事的代码：
 *   · 建会话：收到播放地址、临时文件建好、上游请求发出；
 *   · 上游首字节：上游响应正文的第一个字节到达本进程；
 *   · 本地可播：本机 HTTP 把第一个字节写给播放器（这一刻 mpv 才「能播」）。
 * 只有本轮点击之后创建的会话才会走到这里（见 playTimingStartedAt），
 * 所以复用上一轮缓存、或退出播放器后迟到的数据都不会把数字算错。
 */
export function markCacheTiming(name: CacheTimingMark): void {
  if (clickAt <= 0) return
  if (cacheMarks[name]) return
  cacheMarks[name] = Date.now()
}

/**
 * 本轮点击的时刻（0 = 当前没有进行中的播放计时）。
 *
 * 本地缓存用它判断「这个会话是不是本轮新建的」：只有本轮会话的打点才进这一轮的计时行，
 * 否则上一轮遗留会话的上游首字节会被算到这一轮头上。
 */
export function playTimingStartedAt(): number {
  return clickAt
}

/** 相对点击时刻的毫秒数（没发生返回 null） */
function offsetOf(name: PlayTimingMark): number | null {
  const at = marks[name]
  return at ? at - clickAt : null
}

function fmt(v: number | null): string {
  return v === null ? '—' : `${Math.max(0, Math.round(v))}ms`
}

/** 一行计时（不含前缀；`log.append` 会补上 `[play-flow]`） */
export function playTimingLine(): string {
  const seg = (from: PlayTimingMark | null, to: PlayTimingMark): string => {
    const t = marks[to]
    if (!t) return '—'
    const base = from ? marks[from] : clickAt
    if (!base) return '—'
    return fmt(t - base)
  }
  const total = offsetOf('首帧')
  /*
   * 本地缓存段（v1.4）：只有本轮真的新建过缓存会话才会出现。
   * 形状固定成 `｜本地缓存 建会话→上游首字节 X / 上游首字节→本地可播 Y`：
   * 前一段是源站 TTFB（慢源的大头），后一段才是我们这条本机链路的开销。
   * 没有缓存时整段省略 —— 老日志/直连/HLS 的计时行形状保持不变。
   */
  const cacheFrom = cacheMarks['建会话']
  const cacheUp = cacheMarks['上游首字节']
  const cacheLocal = cacheMarks['本地可播']
  let cacheSeg = ''
  if (cacheUp || cacheLocal) {
    const upstream = cacheFrom && cacheUp ? fmt(cacheUp - cacheFrom) : '—'
    const localHop = cacheUp && cacheLocal ? fmt(cacheLocal - cacheUp) : '—'
    cacheSeg = `｜本地缓存 建会话→上游首字节 ${upstream} / 上游首字节→本地可播 ${localHop}`
  }
  return (
    // 形状固定：`计时 点击→选源 … / … / loadfile→首帧 …` —— 用户复制一行就能定位，
    // 触发来源（规则播放/直链/本地）放在末尾，不打断前面四段的固定前缀。
    '计时 ' +
    `点击→选源 ${seg(null, '选源')} / ` +
    `选源→嗅探命中 ${seg('选源', '命中')} / ` +
    `命中→loadfile ${seg('命中', 'loadfile')} / ` +
    `loadfile→首帧 ${seg('loadfile', '首帧')}` +
    (total === null ? '' : `（合计 ${fmt(total)}）`) +
    cacheSeg +
    (trigger ? `｜${trigger}` : '')
  )
}

/**
 * 把这一行写进日志（一轮只写一次）。
 *
 * 为什么挂在 `playFlow.endFlow` 上而不是各自打：成功（首帧）和失败（15 秒看门狗）
 * 都必须留下同一形状的一行，否则用户报「慢」时我们只能看到成功的那一半。
 */
export function logPlayTimingSummary(why = ''): void {
  if (clickAt <= 0 || logged) return
  logged = true
  log.append('info', 'play-flow', `${playTimingLine()}${why ? `｜${why}` : ''}`)
  /*
   * V1.2.4：**首帧还没到就先不清零**。
   *
   * 上一版不管有没有首帧都清空 clickAt/marks，结果"晚到的首帧"再也没有数字可算
   * （真机日志里 09 秒打"未出首帧"、11 秒画面才出来）。
   * 现在：
   *   · 首帧已到 → 正常清零，本轮结束；
   *   · 首帧未到 → 保留现场，等 markPlayTiming('首帧') 补打一行后再清（见那边）。
   * 保留的风险是"这一轮永远不出首帧"时现场不清 —— 但下一次 beginPlayTiming() 会重置，
   * 所以最多浪费几十字节内存，不会把下一轮的数字算错。
   */
  if (marks['首帧']) {
    clickAt = 0
    marks = {}
    cacheMarks = {}
  }
}

/** 自检/脚本读现场用（不改状态） */
export function playTimingSnapshot(): {
  clickAt: number
  trigger: string
  marks: Partial<Record<PlayTimingMark, number>>
  cacheMarks: Partial<Record<CacheTimingMark, number>>
  line: string
} {
  return { clickAt, trigger, marks: { ...marks }, cacheMarks: { ...cacheMarks }, line: playTimingLine() }
}

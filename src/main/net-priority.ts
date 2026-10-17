import 'axios'
import type { NetPriority } from '@shared/types'
import { log } from './log'

export type { NetPriority }

/**
 * 分级网络策略（S / A / B）。
 *
 * 用户诉求：应用对网络的要求很大，需要按优先级分级，低优先级在高优先级忙时让路：
 *   · S：从 bangumi 数据源取番剧数据、通过规则取站点视频资源；
 *   · A：弹幕获取、galgame 数据；
 *   · B：从 bangumi 取随机推荐、搜索番剧。
 *
 * 为什么放在主进程单独一层，而不是在每个调用点自己加锁：
 *   1. 调用点有几十处（bangumi / 规则 / 弹幕 / galgame / jikan…），逐处加锁必然有人漏；
 *      漏掉的那一条恰恰可能把并发占满（番剧表就是被启动时的一堆后台请求拖死的）。
 *   2. 只有一处才能统计出「同一时刻到底有几个请求在飞」这种可验证的数字，
 *      而排障靠的就是这个数字，不是印象。
 *   3. 将来要做「多反代分工」时（用户已明确以后再做），调度器是唯一需要改的地方。
 *
 * 语义（刻意写清楚，避免以后被误解）：
 *   · 每一级有**自己的**并发上限（S=4 / A=2 / B=1），互不挤占；
 *   · 高优先级**排队**或**已占满自己额度**时，低优先级不再新开请求（让路）；
 *     高优先级只用了一部分额度时，低优先级可以并行（否则弹幕会被一次 40 秒的详情请求饿死）；
 *   · 已经在飞的请求不会被强行中断（HTTP 中途取消只会浪费已下载流量，且对端会把连接判成异常）。
 */

/*
 * 给 axios 的 config 增加两个可选字段（模块增强，不改 axios 本体）：
 *   · netPriority：调用点显式指定级别（比 URL 猜测可靠）；
 *   · netTag：日志标签（不含主机名），排障时能看出是哪个接口。
 * 没有显式指定的请求走 `net.ts` 的 URL 分类器（规则站点→S、本地服务→不进队列、其余→A）。
 */
declare module 'axios' {
  interface AxiosRequestConfig {
    netPriority?: NetPriority
    netTag?: string
  }
}

/** 每级最长排队时间：超过就失败，避免 B 级任务无限堆积、把内存和界面等待都拖长 */
const PRIORITY_MAX_WAIT_MS: Record<NetPriority, number> = {
  S: 30_000,
  A: 60_000,
  B: 120_000
}

/** 每一级同时在飞的请求上限。数值来自用户给的要求（S=4 / A=2 / B=1）。 */
const PRIORITY_CAP: Record<NetPriority, number> = { S: 4, A: 2, B: 1 }

/** 优先级从高到低。数组顺序就是 dispatch 顺序，不要改成对象遍历顺序（不可靠）。 */
const PRIORITY_ORDER: NetPriority[] = ['S', 'A', 'B']

/** 一级请求的排队项 */
interface Waiter {
  level: NetPriority
  tag: string
  enqueuedAt: number
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
  /** 排队超时定时器（见 PRIORITY_MAX_WAIT_MS） */
  timer?: ReturnType<typeof setTimeout>
}

/** 一次网络请求的可观测记录（只保留最近若干条，用于设置页/排障与性能对比） */
export interface NetTraceRecord {
  level: NetPriority
  /** 不含地址的标签：`/v0/subjects/400602`、`搜索`、`图片` 这类；**绝不写入主机名** */
  label: string
  ms: number
  status: number | 'error'
  bytes: number
  /** 在队列里等了多久（直接调的请求为 0） */
  waitMs: number
  at: number
}

/** 诊断快照（不含任何地址，可以安全地进日志/界面） */
export interface NetPrioritySnapshot {
  active: Record<NetPriority, number>
  waiting: Record<NetPriority, number>
  peak: Record<NetPriority, number>
  started: Record<NetPriority, number>
  completed: Record<NetPriority, number>
  /** 最近一次请求的排队等待时间（毫秒）；为排障提供「低优先级到底等了多久」的证据 */
  lastWaitMs: number
  maxWaitMs: number
}

const ZERO: Record<NetPriority, number> = { S: 0, A: 0, B: 0 }

class PriorityQueue {
  private active: Record<NetPriority, number> = { ...ZERO }
  private waiting: Record<NetPriority, Waiter[]> = { S: [], A: [], B: [] }
  private peak: Record<NetPriority, number> = { ...ZERO }
  private started: Record<NetPriority, number> = { ...ZERO }
  private completed: Record<NetPriority, number> = { ...ZERO }
  private maxWaitMs = 0
  private lastWaitMs = 0

  /** 取一个执行槽。返回的 release 必须且只应调用一次（内部做了幂等）。 */
  acquire(level: NetPriority, tag: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'))
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { level, tag, enqueuedAt: Date.now(), resolve, reject, signal }
      /*
       * 排队超时：网络慢的时候 B 级（随机推荐/搜索补齐）会排很多条，
       * 若某条已经没意义了还一直占着队列，后面的更没机会。
       * 超时直接失败，让调用方按「这次没取到」处理，后台任务下次再来。
       */
      waiter.timer = setTimeout(() => {
        this.removeWaiter(waiter)
        reject(new Error(`网络排队超过 ${(PRIORITY_MAX_WAIT_MS[level] / 1000) | 0}s（${level} 级）`))
      }, PRIORITY_MAX_WAIT_MS[level])
      if (signal) {
        waiter.onAbort = (): void => {
          this.removeWaiter(waiter)
          reject(new Error('aborted'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiting[level].push(waiter)
      this.pump()
    })
  }

  /** 把排队项从队列里摘掉（超时/取消共用），并清理它挂着的监听与定时器 */
  private removeWaiter(waiter: Waiter): void {
    const lane = this.waiting[waiter.level]
    const idx = lane.indexOf(waiter)
    if (idx >= 0) lane.splice(idx, 1)
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
  }

  /**
   * 派发：严格按 S → A → B。
   *
   * 「让路」的判据（v1.1.4 定稿）：
   *   · 更高一级**有人在排队**，或者**已经把自己的槽占满** → 低一级一个都不启动；
   *   · 更高一级只用了部分槽（还有余量）→ 低一级可以用自己的槽并行。
   * 这样既不会让弹幕（A）在番剧详情（S）一开就是 40 秒时完全没机会，
   * 也不会在 S 已经占满带宽时再额外塞 A/B 请求（那正是「应用对网络要求庞大」的来源）。
   */
  private pump(): void {
    for (let i = 0; i < PRIORITY_ORDER.length; i++) {
      const level = PRIORITY_ORDER[i]
      const higherBusy = PRIORITY_ORDER.slice(0, i).some(
        (l) => this.waiting[l].length > 0 || this.active[l] >= PRIORITY_CAP[l]
      )
      if (higherBusy) continue
      const lane = this.waiting[level]
      while (lane.length > 0 && this.active[level] < PRIORITY_CAP[level]) {
        const waiter = lane.shift()!
        this.start(waiter)
      }
    }
  }

  private start(waiter: Waiter): void {
    const { level } = waiter
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
    this.active[level] += 1
    this.started[level] += 1
    this.peak[level] = Math.max(this.peak[level], this.active[level])
    const waited = Date.now() - waiter.enqueuedAt
    this.lastWaitMs = waited
    this.maxWaitMs = Math.max(this.maxWaitMs, waited)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.active[level] = Math.max(0, this.active[level] - 1)
      this.completed[level] += 1
      this.pump()
    }
    waiter.resolve(release)
  }

  snapshot(): NetPrioritySnapshot {
    return {
      active: { ...this.active },
      waiting: {
        S: this.waiting.S.length,
        A: this.waiting.A.length,
        B: this.waiting.B.length
      },
      peak: { ...this.peak },
      started: { ...this.started },
      completed: { ...this.completed },
      lastWaitMs: this.lastWaitMs,
      maxWaitMs: this.maxWaitMs
    }
  }
}

export const netQueue = new PriorityQueue()

/** 带优先级执行一个异步任务（任务内部自己保证 release；这里只负责排队） */
export async function withNetPriority<T>(
  level: NetPriority,
  tag: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const release = await netQueue.acquire(level, tag, signal)
  try {
    return await fn()
  } finally {
    release()
  }
}

// ───────────────────────── 请求级计时（与队列独立） ─────────────────────────
//
// 为什么单独记：队列只说明「拿到了几个槽」，真正要回答用户的是
// 「这个接口花了多久、同时有几个请求在飞」。计时器记录的是**实际在飞**的请求数，
// 所以它给出的并发数既包含走队列的请求，也包含还没接入队列的模块（规则/弹幕等），
// 这样"改造前 vs 改造后"才是同一口径。

const traceActive: Record<NetPriority, number> = { ...ZERO }
const tracePeak: Record<NetPriority, number> = { ...ZERO }
const traceRecent: NetTraceRecord[] = []
const TRACE_KEEP = 60

/** 并发快照（实际在飞） */
export function netConcurrency(): Record<NetPriority, number> {
  return { ...traceActive }
}

/**
 * 开始一次请求计时。
 * `label` 只能是**不含主机名**的接口标识；调用方负责（日志里也还有一层 maskLogText 兜底）。
 */
export function beginNetTrace(level: NetPriority, label: string): (status: number | 'error', bytes?: number) => void {
  const at = Date.now()
  traceActive[level] += 1
  tracePeak[level] = Math.max(tracePeak[level], traceActive[level])
  let done = false
  return (status, bytes = 0): void => {
    if (done) return
    done = true
    traceActive[level] = Math.max(0, traceActive[level] - 1)
    const ms = Date.now() - at
    const rec: NetTraceRecord = { level, label, ms, status, bytes, waitMs: 0, at }
    traceRecent.push(rec)
    if (traceRecent.length > TRACE_KEEP) traceRecent.splice(0, traceRecent.length - TRACE_KEEP)
    /*
     * 单条请求日志：级别 + 接口标签 + 状态 + 大小 + 耗时 + 并发数。
     * 为什么大小也要记：反代慢的时候，先分清是"没数据"还是"数据太大"——
     * 详情页一次 7.8KB 而已，慢与体积无关，这个结论就是靠这一列得出的。
     *
     * 并发要分两个口径写清楚：
     *   · 在途 = 已经开始计时、但可能还在队列里排队的请求数（会大于实际上限）；
     *   · 执行/排队 = 全局队列的真实快照（执行数才是同一时刻真正发出的 HTTP 数量）。
     */
    const conc = netConcurrency()
    const q = netQueue.snapshot()
    log.append(
      'info',
      'net',
      `${level} ${label} ${status === 'error' ? '失败' : `HTTP ${status}`} ${(bytes / 1024).toFixed(1)}KB ${ms}ms` +
        `（在途 S${conc.S}/A${conc.A}/B${conc.B}；执行 S${q.active.S}/A${q.active.A}/B${q.active.B}；` +
        `排队 S${q.waiting.S}/A${q.waiting.A}/B${q.waiting.B}）`
    )
  }
}

/** 最近请求记录（不含地址，供诊断/测试读取） */
export function netTraceRecent(): NetTraceRecord[] {
  return traceRecent.map((r) => ({ ...r }))
}

/** 汇总快照：队列 + 实际并发，一起给诊断用 */
export function netSnapshot(): NetPrioritySnapshot & { recent: NetTraceRecord[] } {
  return { ...netQueue.snapshot(), recent: netTraceRecent() }
}

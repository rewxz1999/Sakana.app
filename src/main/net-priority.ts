import 'axios'
import type { NetPriority } from '@shared/types'
import { log } from './log'

export type { NetPriority }

/**
 * 全局网络并发闸门（**分级已废弃**）。
 *
 * 用户原话：「彻底去除之前提的 s/a/b 数据获取分级，那里需求大就自动分配需求。」
 * 所以现在**所有外网请求完全同等对待**，只保留一个全局并发上限：
 *   · 不再有 S/A/B 三条队列，也就不存在「低优先级给高优先级让路」；
 *   · 谁先到谁先执行（FIFO），不需要调用方判断自己"重不重要"；
 *   · 唯一还保留的是 `netBypass`（播放中的媒体流绕开队列），理由见下面的类型声明 ——
 *     它不是优先级，而是**避免播放链路被任何后台请求排队**的硬隔离。
 *
 * 为什么上限是 8：
 *   · 旧版三级上限加起来是 9（4+2+3），实测反代在 8 个以上并发时开始出现 5xx/重置；
 *   · 番剧表一次要并行取三个月 + 若干评分，低于 8 会让这些正常请求互相等；
 *   · 8 是"不会把反代打挂"与"不会让正常请求排长队"之间的折中值。
 *
 * 为什么还留着一个排队兜底（120s）：
 *   它不是限流，只是"别把等不到的请求永远挂在内存里"。真机上曾出现对端不返回、
 *   连接也不断的情况；没有兜底时那些请求会一直占着并发槽，后续请求全部被拖死。
 */
const MAX_CONCURRENCY = 5

/** 排队兜底上限（毫秒）：只防悬挂，不是分级限流 */
const MAX_WAIT_MS = 120_000

/*
 * 给 axios 的 config 增加三个可选字段（模块增强，不改 axios 本体）：
 *   · netPriority：**已废弃，仅为兼容旧调用点保留**，传什么值都不会改变排队行为；
 *   · netTag：日志标签（不含主机名），排障时能看出是哪个接口；
 *   · netBypass：**完全绕过全局队列**，只给「正在播放的那条媒体流」用。
 */
declare module 'axios' {
  interface AxiosRequestConfig {
    /** @deprecated 分级已废弃，仅为兼容保留；填任意值行为都相同 */
    netPriority?: NetPriority
    netTag?: string
    /**
     * 绕过全局并发队列（不是优先级，是硬隔离）。
     *
     * 为什么需要：播放链路（HLS 列表改写 / 加速器探速与分片 / 可达性取证）
     * 一旦排在普通外网请求后面，就要和弹幕、搜索、galgame 一起等；
     * 而播放器那边是**同步等 m3u8**的，排队几十秒的直接后果是
     * 「内核已接收地址、0 字节、15 秒后注入失败」—— 也就是用户报的「所有规则都卡在注入」。
     * 这几类请求不是"后台带宽"，是用户正在看的那一路，必须直达；
     * 它们本身有各自的超时与并发上限（streamBoost 自己限流），不需要再叠一层全局队列。
     */
    netBypass?: boolean
  }
}

/** 排队项（不再有 level：所有请求同一条 FIFO） */
interface Waiter {
  tag: string
  enqueuedAt: number
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
  timer?: ReturnType<typeof setTimeout>
}

/** 一次网络请求的可观测记录（只保留最近若干条，用于设置页/排障与性能对比） */
export interface NetTraceRecord {
  /** @deprecated 分级已废弃；仅保留字段以兼容旧的诊断数据格式 */
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

/**
 * 诊断快照（不含任何地址，可以安全地进日志/界面）。
 * 分级字段已删除：只有总数，避免日志里再出现 S/A/B 统计。
 */
export interface NetPrioritySnapshot {
  /** 当前真正在执行（已拿到槽）的请求数 */
  active: number
  /** 当前在排队等待的请求数 */
  waiting: number
  peak: number
  started: number
  completed: number
  /** 最近一次请求的排队等待时间（毫秒） */
  lastWaitMs: number
  maxWaitMs: number
}

class FlatQueue {
  private activeCount = 0
  private waiters: Waiter[] = []
  private peakCount = 0
  private startedCount = 0
  private completedCount = 0
  private maxWaitMs = 0
  private lastWaitMs = 0

  /** 取一个执行槽。返回的 release 必须且只应调用一次（内部做了幂等）。 */
  acquire(tag: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'))
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { tag, enqueuedAt: Date.now(), resolve, reject, signal }
      /*
       * 排队兜底：只在"对端既不返回也不断开"这种极端情况下触发。
       * 超时直接失败，让调用方按「这次没取到」处理，后台任务下次再来。
       */
      waiter.timer = setTimeout(() => {
        this.removeWaiter(waiter)
        reject(new Error(`网络排队超过 ${(MAX_WAIT_MS / 1000) | 0}s（并发已满）`))
      }, MAX_WAIT_MS)
      if (signal) {
        waiter.onAbort = (): void => {
          this.removeWaiter(waiter)
          reject(new Error('aborted'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
      this.pump()
    })
  }

  /** 把排队项从队列里摘掉（超时/取消共用），并清理它挂着的监听与定时器 */
  private removeWaiter(waiter: Waiter): void {
    const idx = this.waiters.indexOf(waiter)
    if (idx >= 0) this.waiters.splice(idx, 1)
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
  }

  /** 派发：只按到达顺序（FIFO），没有分级、没有让路 */
  private pump(): void {
    while (this.waiters.length > 0 && this.activeCount < MAX_CONCURRENCY) {
      const waiter = this.waiters.shift()!
      this.start(waiter)
    }
  }

  private start(waiter: Waiter): void {
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
    this.activeCount += 1
    this.startedCount += 1
    this.peakCount = Math.max(this.peakCount, this.activeCount)
    const waited = Date.now() - waiter.enqueuedAt
    this.lastWaitMs = waited
    this.maxWaitMs = Math.max(this.maxWaitMs, waited)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.activeCount = Math.max(0, this.activeCount - 1)
      this.completedCount += 1
      this.pump()
    }
    waiter.resolve(release)
  }

  snapshot(): NetPrioritySnapshot {
    return {
      active: this.activeCount,
      waiting: this.waiters.length,
      peak: this.peakCount,
      started: this.startedCount,
      completed: this.completedCount,
      lastWaitMs: this.lastWaitMs,
      maxWaitMs: this.maxWaitMs
    }
  }
}

export const netQueue = new FlatQueue()

/**
 * 带全局并发限制执行一个异步任务。
 * `level` 参数保留只是为了不改旧调用点；**传什么都一样**，分级已废弃。
 */
export async function withNetPriority<T>(
  _level: NetPriority,
  tag: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const release = await netQueue.acquire(tag, signal)
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

let traceActive = 0
const traceRecent: NetTraceRecord[] = []
const TRACE_KEEP = 60

/** 并发快照（实际在飞总数；分级字段已废弃） */
export function netConcurrency(): number {
  return traceActive
}

/**
 * 开始一次请求计时。
 * `label` 只能是**不含主机名**的接口标识；调用方负责（日志里也还有一层 maskLogText 兜底）。
 * 第一个参数仅为兼容旧调用点保留，**不参与日志**。
 */
export function beginNetTrace(level: NetPriority, label: string): (status: number | 'error', bytes?: number) => void {
  const at = Date.now()
  traceActive += 1
  let done = false
  return (status, bytes = 0): void => {
    if (done) return
    done = true
    traceActive = Math.max(0, traceActive - 1)
    const ms = Date.now() - at
    const rec: NetTraceRecord = { level, label, ms, status, bytes, waitMs: 0, at }
    traceRecent.push(rec)
    if (traceRecent.length > TRACE_KEEP) traceRecent.splice(0, traceRecent.length - TRACE_KEEP)
    /*
     * 单条请求日志：接口标签 + 状态 + 大小 + 耗时 + 总数。
     * 只报**总在途 / 执行 / 排队**，不再出现 S/A/B 这类分级统计（分级已废弃）。
     *
     * 并发要分两个口径写清楚：
     *   · 在途 = 已经开始计时、但可能还在队列里排队的请求数（会大于实际上限）；
     *   · 执行/排队 = 全局队列的真实快照（执行数才是同一时刻真正发出的 HTTP 数量）。
     */
    const q = netQueue.snapshot()
    log.append(
      'info',
      'net',
      `${label} ${status === 'error' ? '失败' : `HTTP ${status}`} ${(bytes / 1024).toFixed(1)}KB ${ms}ms` +
        `（在途 ${netConcurrency()}；执行 ${q.active}；排队 ${q.waiting}）`
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

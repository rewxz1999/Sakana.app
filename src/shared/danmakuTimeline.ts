import type { DanmakuComment } from './types'

/**
 * 弹幕时间轴的核心算法（V1.2 弹幕重构）。
 *
 * ## 为什么放在 shared 而不是主进程
 * 「按时间排序、去重、二分找当前时段」这三件事**主进程与渲染层各要用一次**：
 *   · 主进程的集成器要把多源合并成一条有序时间轴；
 *   · 播放器的 canvas 层每次拖动进度都要在时间轴上重新定位。
 * 两边如果各写一份，去重口径（0.1 秒 vs 100ms）或二分边界迟早会不一致 ——
 * 表现出来就是"合并后条数对不上"或"拖动后少了一条"。所以这里只放**纯函数**，
 * 不引 node/electron，两端共用同一份实现。
 */

/** 合并时默认的时间容差（毫秒）：不同源对同一句话的时间戳通常差 0.1~0.3 秒 */
export const DEFAULT_TOLERANCE_MS = 100

/**
 * 去重键：`时间（按容差取整）+ 正文`。
 *
 * 为什么不用精确时间：实测巴哈与 bilibili 对同一条弹幕会差零点几秒，精确比较一条都去不掉；
 * 为什么不用整秒：同一秒里真的会有两条不同的话（甚至同一句话刷屏），整秒取整会误杀。
 * 按容差取整是两种极端之间的折中，容差本身做成了设置项（「弹幕误差」）。
 */
export function danmakuDedupeKey(c: DanmakuComment, toleranceMs = DEFAULT_TOLERANCE_MS): string {
  const tol = Math.max(10, Math.round(Number(toleranceMs) || DEFAULT_TOLERANCE_MS))
  const ms = Math.max(0, Number(c.time) || 0) * 1000
  return `${Math.round(ms / tol)}|${String(c.text ?? '').trim()}`
}

/**
 * 多批弹幕合并成一条有序时间轴。
 *
 * 返回**新数组**，不修改入参（主进程的缓存对象会被复用，改它会污染下一次读取）。
 * 超过 `maxComments` 时保留最早的 N 条：正常一集不会到上限，真到了说明源异常，
 * 保留前面的至少能保证开头能看（截断会写进日志，不静默）。
 */
export function mergeDanmakuBatches(
  batches: readonly (readonly DanmakuComment[])[],
  opts: { toleranceMs?: number; maxComments?: number } = {}
): DanmakuComment[] {
  const tol = Math.max(10, Number(opts.toleranceMs) || DEFAULT_TOLERANCE_MS)
  const max = Math.max(1, Math.trunc(opts.maxComments ?? 8000))
  const all: DanmakuComment[] = []
  for (const batch of batches) {
    for (const c of batch ?? []) {
      if (!c || typeof c.text !== 'string' || !c.text) continue
      const t = Number(c.time)
      if (!Number.isFinite(t) || t < 0) continue
      all.push(c)
    }
  }
  // 先按时间排序，再线性扫：同一句话与**上一条被接受**的时间差在容差内就算重复。
  // 不用 `round(t/tol)` 分桶：50ms 的两条可能刚好跨桶（100ms 容差下会漏去重），
  // 用户看到的仍是"同一条弹幕出现两次"。滑动比较没有这个边界问题。
  all.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0))
  const lastByText = new Map<string, number>()
  const out: DanmakuComment[] = []
  for (const c of all) {
    const t = Number(c.time) || 0
    const text = String(c.text).trim()
    const last = lastByText.get(text)
    if (last !== undefined && t - last <= tol / 1000 + 1e-6) continue
    lastByText.set(text, t)
    out.push(c)
    if (out.length >= max) break
  }
  return out
}

/**
 * 二分：第一条 `time >= target` 的下标（0..len）。
 *
 * 为什么不用 `findIndex`：一集几千条时每次拖动都要从头扫一遍，
 * 拖动过程中一秒能触发十几次；二分是 O(log n)，几千条也只有十几次比较。
 */
export function lowerBoundByTime(list: readonly DanmakuComment[], target: number): number {
  const t = Number.isFinite(target) ? target : 0
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((Number(list[mid]?.time) || 0) < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** 当前时段在时间轴上的下标区间 `[start, end)` */
export interface DanmakuWindowRange {
  start: number
  end: number
}

/**
 * 取「当前时刻往前 `behindSec`、往后 `aheadSec`」的下标窗口。
 *
 * 播放器只渲染这个窗口里的弹幕：
 *   · 往前留 1~2 秒：滚动弹幕在开始时间之后还要在屏幕上走好几秒，必须保留；
 *   · 往后留若干秒：定时补生成时不用每帧都去全量数组里找；
 *   · 窗口本身用二分定位，所以拖动进度到任意位置都是 O(log n)，不会"越拖越卡"。
 */
export function danmakuWindowRange(
  list: readonly DanmakuComment[],
  time: number,
  behindSec = 1.5,
  aheadSec = 12
): DanmakuWindowRange {
  const t = Number.isFinite(time) ? time : 0
  return {
    start: lowerBoundByTime(list, t - Math.max(0, behindSec)),
    end: lowerBoundByTime(list, t + Math.max(0, aheadSec))
  }
}

/**
 * 「已缓存区间」的纯逻辑（V1.5.1，从 mediaCache.ts 拆出）。
 *
 * 为什么单独一个文件：Range 多连接分段让"已缓存"不再是一个单调递增的数字，而是
 * **顺序区（received）+ 若干已完成分段（ranges）** 的并集。三个判定（能不能读、
 * 读到哪、总共产了多少字节）直接决定播放器会不会读到文件里的空洞，
 * 属于"错了就花屏/卡住"的那类逻辑，必须能脱离 Electron 单独跑断言
 * （见 `.e2e/verify-v151.mjs` 的「缓存区间」一节）。
 *
 * 约定：`ranges` 里每个区间都是**闭开区间** `[start, end)`，且始终按 start 升序、
 * 相邻/重叠的段已经被合并。`received` 表示"从 0 开始连续可读到哪里"。
 * 这个不变量由 `addRangeTo` 维护，其它函数只读。
 */

export interface RangeLike {
  start: number
  end: number
}

export interface CoverageState {
  /** 从 0 起连续可读到的位置（不一定是文件里的全部数据） */
  received: number
  /** 已完整落盘的分段（升序、已合并） */
  ranges: RangeLike[]
}

/**
 * 「从 pos 起连续可读到哪里」（闭开）。
 *
 * 这是**播放器能读多少**的唯一判据：返回值之前的字节一定在磁盘上，之后的不保证。
 * 注意它**不会跨过缺口** —— 跨越缺口会让播放器读到还没下载的空洞（花屏/解码失败）。
 */
export function availableEndOf(s: CoverageState, pos: number): number {
  let end = s.received > pos ? s.received : pos
  for (const r of s.ranges) {
    if (r.end <= end) continue
    // ranges 按 start 升序：一旦这一段的起点在可用终点之后，后面都更远，直接停
    if (r.start > end) break
    end = r.end
  }
  return end
}

/** 已缓存的总字节数（顺序区 + 各分段取并集；进度条用它，而不是只看顺序区） */
export function cachedBytesOf(s: CoverageState): number {
  let total = Math.max(0, s.received)
  for (const r of s.ranges) {
    // 与顺序区重叠的段已经由 addRangeTo 合并进 received，不能重复计
    if (r.start <= s.received) continue
    total += r.end - r.start
  }
  return total
}

/**
 * 把 `[start,end)` 记为已完成并合并相邻段；与顺序区相接时推进 `received`。
 *
 * 为什么必须合并：两段相邻（例如 [0,8MB) 与 [8MB,16MB)）在物理上就是连续的，
 * 不合并的话 `availableEndOf` 虽然也能走通（它会继续看下一段），但 `ranges` 会无限膨胀，
 * 而且"顺序区"永远不前进 —— 播放器每读一块都要遍历一堆碎段。
 */
export function addRangeTo(s: CoverageState, start: number, end: number): void {
  if (!(end > start)) return
  const list = [...s.ranges, { start, end }].sort((a, b) => a.start - b.start)
  const merged: RangeLike[] = []
  for (const r of list) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ start: r.start, end: r.end })
  }
  s.ranges = merged
  // 顺序区可以顺势前进（例如 worker 把紧接着的下一段也下完了）
  for (const r of merged) {
    if (r.start > s.received) break
    if (r.end > s.received) s.received = r.end
  }
}

/** 下一个已完成分段的起点（补缺口时用来决定"补到哪为止"）；没有则 null */
export function nextRangeStart(s: CoverageState, from: number): number | null {
  for (const r of s.ranges) {
    if (r.start > from) return r.start
  }
  return null
}

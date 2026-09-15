/**
 * 播放器实例计数（v0.2.6）
 *
 * 为什么需要：播放器内切集是「重新挂载播放页」（与从番剧详情页重新进入播放页完全一致）。
 * React 在同一次提交里卸载旧实例、挂载新实例，于是会出现这种竞态：
 * 新实例已经 attach 好播放内核，旧实例的卸载清理随后才执行 —— 如果它顺手
 * `detach()` 掉内核，新一集就变成「抓到了流却怎么也播不出来」（实测遇到）。
 *
 * 这里用一个极小的计数 + 延迟判定来解决：只有「没有任何播放实例存活」时才真正 detach。
 */

let activePlayers = 0

/** 进入播放页时调用，返回离开函数 */
export function enterPlayer(): () => void {
  activePlayers += 1
  let left = false
  return () => {
    if (left) return
    left = true
    activePlayers = Math.max(0, activePlayers - 1)
  }
}

/** 当前是否还有播放页实例存活（用于判断能否安全 detach 内核） */
export function hasActivePlayer(): boolean {
  return activePlayers > 0
}

/** 延迟一小段时间后再判断是否还有实例（给新实例的挂载留出时间） */
export function whenPlayerGone(fn: () => void, delayMs = 600): void {
  setTimeout(() => {
    if (!hasActivePlayer()) fn()
  }, delayMs)
}

/**
 * 播放器实例计数（v0.2.6；v0.2.8 附加三 改为世代号判定）
 *
 * 为什么需要：播放器内切集是「重新挂载播放页」（与从番剧详情页重新进入播放页完全一致）。
 * React 卸载旧实例、挂载新实例，于是会出现这种竞态：
 * 新实例已经 attach 好播放内核，旧实例的卸载清理随后才执行 —— 如果它顺手
 * `detach()` 掉内核、或把控制栏悬浮窗销毁掉，新一集就变成「抓到了流却怎么也播不出来」，
 * 或者「控制栏不见了 / 按钮点哪都没反应」（实测两者都遇到过）。
 *
 * v0.2.6 用「延迟 600ms 后看还有没有存活实例」来判断，但 600ms 是**猜出来的时间**：
 * 新实例挂载较慢（例如同时在解析播放页、拉弹幕）时仍会踩中，表现为**切集时偶发**按钮失灵。
 * 现在改为**世代号**：每次进入播放页领取一个世代号，清理时把世代号一起带上，
 * 只有「当前世代仍等于自己」时才真的执行清理 —— 只要新实例已经进来过，旧实例的清理一律作废，
 * 不再依赖时间窗口。
 */

let activePlayers = 0
let playerEpoch = 0

export interface PlayerHandle {
  /** 本次进入播放页拿到的世代号 */
  epoch: number
  /** 离开（React 清理时调用） */
  leave: () => void
}

/** 进入播放页时调用，返回世代号与离开函数 */
export function enterPlayer(): PlayerHandle {
  activePlayers += 1
  playerEpoch += 1
  const epoch = playerEpoch
  let left = false
  return {
    epoch,
    leave: () => {
      if (left) return
      left = true
      activePlayers = Math.max(0, activePlayers - 1)
    }
  }
}

/** 当前是否还有播放页实例存活 */
export function hasActivePlayer(): boolean {
  return activePlayers > 0
}

/**
 * 延迟一小段时间后执行清理，但仅当**期间没有新的播放页实例进入**时才执行。
 *
 * @param epoch 调用方（即将离开的实例）的世代号
 */
export function whenPlayerGone(fn: () => void, epoch: number, delayMs = 600): void {
  setTimeout(() => {
    // 有新实例进来过 → 新实例会接管内核与悬浮窗，旧实例的清理必须作废
    if (playerEpoch !== epoch) return
    if (hasActivePlayer()) return
    fn()
  }, delayMs)
}

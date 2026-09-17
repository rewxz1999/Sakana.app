// 「确认下载」弹窗的勾选集合同步（纯函数：组件里调它，逻辑可单独验证）

/**
 * 依据「当前可见条目的 id」把勾选集合同步成新的一份。
 *
 * 规则：
 * - 新出现的资源（prevIds 里没有）默认勾选 —— 用户的预期是「检测到的都下」；
 * - 之前勾着的保持勾着；
 * - 用户主动取消勾选的，即使列表刷新也不重新勾上（不然取消操作会被后台刷新悄悄撤销）；
 * - 已消失的条目从集合里剔除，保证「下载所选 N 项」恒等于真正选中的可见条目数。
 *
 * 纯函数 + 不修改入参，避免在 setState 更新器里改 ref（StrictMode 下更新器可能被调用两次）。
 */
export function syncSelection(prev: Set<string>, ids: string[], prevIds: Set<string>): Set<string> {
  const next = new Set<string>()
  for (const id of ids) {
    if (prev.has(id)) next.add(id)
    else if (!prevIds.has(id)) next.add(id)
  }
  return next
}

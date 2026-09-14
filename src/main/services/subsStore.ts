import { BrowserWindow } from 'electron'
import { CH } from '@shared/channels'
import type { Subscription } from '@shared/types'
import { store } from '../store'

/**
 * 订阅数据的唯一写入入口（主进程）。
 *
 * 为什么必须这样：渲染层过去各自持有"启动时的快照"，修改后把整个数组写回 JSON，
 * 多窗口/多来源并发时必然互相覆盖（丢失更新）。现在所有变更都走这里，
 * 读-改-写都在主进程内存里串行完成，并在变更后广播给所有窗口，
 * 渲染层只做展示（顺带修掉「订阅后卡片要重启才出现」的问题）。
 */

export function listSubscriptions(): Subscription[] {
  return store.get<Subscription[]>('subscriptions', [])
}

/** 读-改-写：回调返回新数组，写盘后广播 */
export function mutateSubscriptions(fn: (list: Subscription[]) => Subscription[]): Subscription[] {
  const next = fn(listSubscriptions())
  store.set('subscriptions', next)
  broadcastSubscriptions()
  return next
}

/** 把最新订阅列表推给所有窗口（设置页/订阅页/托盘面板等） */
export function broadcastSubscriptions(): void {
  const payload = listSubscriptions()
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      w.webContents.send(CH.evSubs, payload)
    } catch {
      /* 窗口正在销毁时忽略 */
    }
  }
}

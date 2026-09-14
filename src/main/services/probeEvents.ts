import { session } from 'electron'
import { log } from '../log'

/**
 * 网络层嗅探事件的共享注册中心。
 *
 * 为什么需要：Electron 的 `webRequest` **每个事件只允许一个监听器**，
 * 后注册者会静默替换先注册者。应用里有两套嗅探实现（隐藏窗口 ruleProbe、
 * 可见网页视图 ruleWebview），过去各自往 defaultSession 上挂监听，
 * 一旦两者先后使用，先挂的那一路就再也收不到事件（表现为"换集后突然嗅探不到"，
 * 而且没有任何日志）。现在统一在这里注册一次，再按需分发给活跃的实现。
 */

type BeforeHandler = (details: { url: string; resourceType: string }) => void
type CompletedHandler = (details: { url: string; statusCode: number }) => void

const beforeHandlers = new Set<BeforeHandler>()
const completedHandlers = new Set<CompletedHandler>()
let installed = false

function install(): void {
  if (installed) return
  installed = true
  try {
    const ses = session.defaultSession
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      for (const h of [...beforeHandlers]) {
        try {
          h({
            url: String((details as { url?: string }).url ?? ''),
            resourceType: String((details as { resourceType?: string }).resourceType ?? '')
          })
        } catch (err) {
          log.append('warn', 'probe', `嗅探请求处理器异常: ${String(err)}`)
        }
      }
      callback({})
    })
    ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
      for (const h of [...completedHandlers]) {
        try {
          h(details as unknown as { url: string; statusCode: number })
        } catch (err) {
          log.append('warn', 'probe', `嗅探完成处理器异常: ${String(err)}`)
        }
      }
    })
    log.append('info', 'probe', '网络嗅探监听已注册（共享单实例）')
  } catch (err) {
    installed = false
    log.append('error', 'probe', `网络嗅探监听注册失败: ${String(err)}`)
  }
}

/** 注册一组嗅探处理器，返回注销函数（务必在停止嗅探时调用） */
export function addProbeListeners(handlers: {
  onBeforeRequest?: BeforeHandler
  onCompleted?: CompletedHandler
}): () => void {
  install()
  if (handlers.onBeforeRequest) beforeHandlers.add(handlers.onBeforeRequest)
  if (handlers.onCompleted) completedHandlers.add(handlers.onCompleted)
  return () => {
    if (handlers.onBeforeRequest) beforeHandlers.delete(handlers.onBeforeRequest)
    if (handlers.onCompleted) completedHandlers.delete(handlers.onCompleted)
  }
}

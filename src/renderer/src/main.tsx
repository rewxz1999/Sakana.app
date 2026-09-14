import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/main.css'
import { useLibrary } from './stores/library'
import { useSchedule } from './stores/schedule'
import { useSettings } from './stores/app'
import { useShortcuts } from './stores/shortcuts'
import { useSubs } from './stores/subs'
import { useTools } from './stores/tools'

/**
 * 兜底错误面板：模块初始化/异步回调里的异常不会被 React 错误边界捕获，
 * 以前会留下一个纯白的窗口（用户看到的就是"一片空白"）。
 * 这里直接把错误画进 #root，让窗口至少能说明问题并提供重载入口。
 */
function renderFatal(scope: string, err: unknown): void {
  const root = document.getElementById('root')
  if (!root) return
  const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err)
  root.innerHTML = ''
  const box = document.createElement('div')
  box.setAttribute(
    'style',
    'display:flex;height:100%;flex-direction:column;gap:10px;align-items:center;justify-content:center;padding:24px;font:12px/1.6 system-ui,sans-serif;color:#3a3a3a;background:#f7f4f8;text-align:center'
  )
  const title = document.createElement('div')
  title.textContent = `界面初始化失败（${scope}）`
  title.setAttribute('style', 'font-size:14px;font-weight:600;color:#c0392b')
  const pre = document.createElement('pre')
  pre.textContent = message.slice(0, 1200)
  pre.setAttribute(
    'style',
    'max-width:560px;max-height:240px;overflow:auto;text-align:left;background:#fff;border:1px solid #ddd;border-radius:8px;padding:10px;white-space:pre-wrap'
  )
  const btn = document.createElement('button')
  btn.textContent = '重新加载'
  btn.setAttribute(
    'style',
    'padding:6px 14px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer'
  )
  btn.onclick = (): void => window.location.reload()
  box.append(title, pre, btn)
  root.append(box)
}

window.addEventListener('error', (e) => {
  console.error('[renderer] 未捕获错误:', e.error ?? e.message)
  if (!document.getElementById('root')?.hasChildNodes()) renderFatal('window.onerror', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[renderer] 未处理的 Promise 异常:', e.reason)
})

try {
  void useSettings.getState().load()
  void useLibrary.getState().load()
  void useSchedule.getState().load()
  void useSubs.getState().load()
  void useTools.getState().load()
  void useShortcuts.getState().load()
  // 订阅下载任务实时推送 + 订阅更新事件 + 订阅列表变更广播（主进程写入后推送）
  useSubs.getState().startDownloadsLive()
  useSubs.getState().startSubUpdatesLive()
  useSubs.getState().startSubsLive()

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
} catch (err) {
  console.error('[renderer] 启动失败:', err)
  renderFatal('启动', err)
}

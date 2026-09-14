import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { CH } from '@shared/channels'
import { log } from '../log'

/**
 * 全屏控制栏悬浮窗
 *
 * 为什么需要它：libmpv / libVLC 的画面是**原生子窗口**，永远绘制在网页内容之上，
 * 所以页面里的控制栏无法叠在画面上。全屏时若要让画面铺满整屏、控制栏又能浮在画面上，
 * 只能另开一个**透明、无边框、置顶**的窗口来承载控制栏（electron-vlc-player 的
 * overlay 窗口也是同样的思路）。
 *
 * 职责边界：
 * - 本模块只负责窗口的创建/定位/显示/销毁，以及「状态下行、动作上行」的消息中转；
 * - 控制栏 UI 在渲染层（`#/overlay` 路由），动作最终转给播放页处理，避免状态分叉。
 */

let overlayWin: BrowserWindow | null = null
let ownerWin: BrowserWindow | null = null
/** 跟随主窗口尺寸/位置的监听器解绑函数（悬浮窗销毁时必须解绑，否则会泄漏监听） */
let followDisposers: (() => void)[] = []

function stopFollowing(): void {
  for (const off of followDisposers) {
    try {
      off()
    } catch {
      /* ignore */
    }
  }
  followDisposers = []
}

/**
 * 让悬浮窗跟随主窗口的移动与缩放。
 *
 * v0.2.5 起主窗口恢复自由缩放：不跟随的话，窗口拉大后悬浮窗仍是旧尺寸，
 * 控制栏按钮的实际位置与命中区域错位 —— 表现为「点了全屏按钮没反应」。
 */
function startFollowing(owner: BrowserWindow): void {
  stopFollowing()
  const sync = (): void => syncBounds()
  owner.on('resize', sync)
  owner.on('move', sync)
  owner.on('maximize', sync)
  owner.on('unmaximize', sync)
  owner.on('enter-full-screen', sync)
  owner.on('leave-full-screen', sync)
  followDisposers = [
    () => owner.off('resize', sync),
    () => owner.off('move', sync),
    () => owner.off('maximize', sync),
    () => owner.off('unmaximize', sync),
    () => owner.off('enter-full-screen', sync),
    () => owner.off('leave-full-screen', sync)
  ]
}

function rendererUrl(): string {
  return join(__dirname, '../renderer/index.html')
}

export function isOverlayOpen(): boolean {
  return !!overlayWin && !overlayWin.isDestroyed()
}

/** 展示控制栏悬浮窗（覆盖整个主窗口区域） */
export function showOverlay(owner: BrowserWindow): void {
  ownerWin = owner
  if (overlayWin && !overlayWin.isDestroyed()) {
    syncBounds()
    return
  }
  startFollowing(owner)
  const ownerBounds = owner.getBounds()
  overlayWin = new BrowserWindow({
    parent: owner,
    x: ownerBounds.x,
    y: ownerBounds.y,
    width: ownerBounds.width,
    height: ownerBounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // 不抢主窗口焦点，避免播放快捷键失效
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--sakana-overlay']
    }
  })
  // 默认点击穿透（鼠标移动仍会转发给本窗口，用于唤出控制栏）
  overlayWin.setIgnoreMouseEvents(true, { forward: true })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.on('closed', () => {
    overlayWin = null
  })
  overlayWin.webContents.on('render-process-gone', (_e, d) => {
    log.append('warn', 'overlay', `控制栏悬浮窗渲染进程结束: ${d.reason}`)
    destroyOverlay()
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void overlayWin.loadURL(`${devUrl}#/overlay`)
  else void overlayWin.loadFile(rendererUrl(), { hash: '/overlay' })
  overlayWin.once('ready-to-show', () => overlayWin?.showInactive())
  log.append('info', 'overlay', '控制栏悬浮窗已创建')
}

/** 跟随主窗口位置/尺寸（全屏切换、显示切换时调用） */
export function syncBounds(): void {
  if (!overlayWin || overlayWin.isDestroyed() || !ownerWin || ownerWin.isDestroyed()) return
  const b = ownerWin.getBounds()
  overlayWin.setBounds(b)
}

/** 关闭并销毁悬浮窗 */
export function destroyOverlay(): void {
  stopFollowing()
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy()
  }
  overlayWin = null
}

/** 是否把鼠标事件交给悬浮窗（控制栏可见时=true，可点击；隐藏时=false 点击穿透） */
export function setOverlayInteractive(interactive: boolean): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.setIgnoreMouseEvents(!interactive, { forward: true })
}

/** 播放页 → 悬浮窗：同步控制栏所需状态 */
export function pushOverlayState(state: unknown): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.webContents.send(CH.overlayState, state)
}

/** 播放页 → 悬浮窗：唤出控制栏（鼠标移动） */
export function pokeOverlay(): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.webContents.send(CH.overlayPoke)
}

/** 悬浮窗 → 播放页：控制栏动作 */
export function sendOverlayAction(action: Record<string, unknown>): void {
  if (!ownerWin || ownerWin.isDestroyed()) return
  ownerWin.webContents.send(CH.overlayAction, action)
}

export function overlayWindow(): BrowserWindow | null {
  return overlayWin && !overlayWin.isDestroyed() ? overlayWin : null
}

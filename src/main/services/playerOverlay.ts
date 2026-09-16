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
/** 前台状态轮询定时器（见 startFocusWatch） */
let focusWatchTimer: NodeJS.Timeout | null = null

function stopFocusWatch(): void {
  if (focusWatchTimer) {
    clearInterval(focusWatchTimer)
    focusWatchTimer = null
  }
}

/**
 * 前台状态看护（v0.2.8 附加五，用户定位的显示 bug）。
 *
 * 现象：播放器窗口被别的窗口盖住时，**控制栏悬浮窗仍然浮在那个窗口上面**
 * （视频是主窗口的原生子窗口，会跟着一起被盖住，而悬浮窗是 `alwaysOnTop`），
 * 于是控制栏「卡」在别人窗口的位置上、点什么都没反应；等这个状态结束后，播放器按钮全部失灵。
 *
 * 为什么不能只靠 `blur` 事件：窗口被别的应用盖住但未真正失焦、
 * 或者事件在我们的时序里被别的操作盖掉时，blur 不一定送达 —— 状态就会卡住。
 * 这里用 500ms 轮询**主动核对**「主窗口是否前台」，不前台就收起控制栏，
 * 回到前台再恢复；顺带把点击穿透状态复位，避免留下「看得见但点不动」的窗口。
 */
function startFocusWatch(owner: BrowserWindow): void {
  stopFocusWatch()
  focusWatchTimer = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed()) {
      stopFocusWatch()
      return
    }
    if (owner.isDestroyed()) {
      stopFocusWatch()
      return
    }
    const foreground = owner.isFocused() && !owner.isMinimized() && owner.isVisible()
    const shown = overlayWin.isVisible()
    if (!foreground && shown) {
      overlayWin.hide()
      setOverlayInteractive(false)
      log.append('info', 'overlay', '主窗口不在前台，控制栏已收起（避免浮在其它窗口之上）')
    } else if (foreground && !shown && !owner.isDestroyed()) {
      overlayWin.showInactive()
      log.append('info', 'overlay', '主窗口回到前台，控制栏已恢复')
    }
  }, 500)
}

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
  /**
   * 主窗口失焦 / 最小化时把悬浮窗一并藏起来。
   *
   * 悬浮窗是 `alwaysOnTop('screen-saver')` 的置顶窗口 —— 用户切到别的应用后它依然浮在最上层
   * （反馈里的「播放器退到后台了控制栏还在前台」就是它，出现次数少是因为多数时候控制栏刚好是隐藏态）。
   * 重新获得焦点 / 还原窗口时再显示。
   */
  const hideForOwner = (): void => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide()
  }
  const showForOwner = (): void => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.showInactive()
  }
  owner.on('blur', hideForOwner)
  owner.on('minimize', hideForOwner)
  owner.on('hide', hideForOwner)
  owner.on('focus', showForOwner)
  owner.on('restore', showForOwner)
  owner.on('show', showForOwner)
  owner.on('resize', sync)
  owner.on('move', sync)
  owner.on('maximize', sync)
  owner.on('unmaximize', sync)
  owner.on('enter-full-screen', sync)
  owner.on('leave-full-screen', sync)
  followDisposers = [
    () => owner.off('blur', hideForOwner),
    () => owner.off('minimize', hideForOwner),
    () => owner.off('hide', hideForOwner),
    () => owner.off('focus', showForOwner),
    () => owner.off('restore', showForOwner),
    () => owner.off('show', showForOwner),
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

/**
 * 悬浮窗「代号」（v0.2.8 附加）。
 *
 * 播放器切集是**重新挂载播放页**：旧实例卸载时会调 `overlay.hide()`（销毁悬浮窗），
 * 而新实例挂载时又调 `overlay.show()` —— 两者顺序并不固定（页面有退场动画，
 * 旧实例的卸载可能晚于新实例的 show）。一旦「迟到的 hide/destroy」落在新建的窗口上，
 * 控制栏就**整个消失**：点哪都没反应，只有 Esc（键盘）还能退出 —— 用户反馈的
 * 「播放器所有按键都失灵」就是这个。每次 show 递增代号，迟到的 hide 只对它当初看到的那一代生效。
 */
let overlayGen = 0

/** 当前悬浮窗代号：调用方在发 hide 请求时取一次，延迟执行时用它判断是否已被新窗口取代 */
export function currentOverlayGen(): number {
  return overlayGen
}

/** 展示控制栏悬浮窗（覆盖整个主窗口区域） */
export function showOverlay(owner: BrowserWindow): number {
  ownerWin = owner
  if (overlayWin && !overlayWin.isDestroyed()) {
    syncBounds()
    /*
     * v0.2.8 附加三/五：窗口还在但**被隐藏**时也要重新显示 ——
     * 但**只有主窗口在前台时才恢复**：否则控制栏又会浮到别的窗口上面（用户定位的那个 bug）。
     */
    if (!overlayWin.isVisible() && owner.isFocused() && !owner.isMinimized()) {
      overlayWin.showInactive()
      log.append('info', 'overlay', '悬浮窗此前处于隐藏状态，已重新显示')
    }
    overlayGen += 1
    return overlayGen
  }
  overlayGen += 1
  const myGen = overlayGen
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
      /*
       * v0.2.8：**必须关掉后台节流**。
       * 弹幕画在这个悬浮窗的 canvas 上、靠 requestAnimationFrame 推进，
       * 而透明置顶且不可聚焦的窗口很容易被 Chromium 判定为「后台/被遮挡」——
       * 默认的 backgroundThrottling 会把 rAF 与定时器压到几乎不触发，
       * 实测表现就是「弹幕只画了一秒就冻住、播放时间停住不再前进」（自检里帧数停在 61 不再增长）。
       */
      backgroundThrottling: false,
      additionalArguments: ['--sakana-overlay']
    }
  })
  // 默认点击穿透（鼠标移动仍会转发给本窗口，用于唤出控制栏）
  overlayWin.setIgnoreMouseEvents(true, { forward: true })
  overlayInteractive = false
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
  startFocusWatch(owner)
  log.append('info', 'overlay', `控制栏悬浮窗已创建（第 ${myGen} 代）`)
  logOverlayOwner('control bar owner')
  return myGen
}

/** 跟随主窗口位置/尺寸（全屏切换、显示切换时调用） */
export function syncBounds(): void {
  if (!overlayWin || overlayWin.isDestroyed() || !ownerWin || ownerWin.isDestroyed()) return
  const b = ownerWin.getBounds()
  overlayWin.setBounds(b)
}

/**
 * 关闭并销毁悬浮窗。
 *
 * `gen` 为调用方在发请求时看到的代号：传了就只销毁**同一代**的窗口 ——
 * 迟到的 hide（旧播放页实例卸载）不会把新实例刚建好的控制栏一起关掉，见 overlayGen 注释。
 */
export function destroyOverlay(gen?: number): void {
  if (gen !== undefined && gen !== overlayGen) return
  overlayGen += 1 // 之后到达的旧 hide 请求一律作废
  stopFollowing()
  stopFocusWatch()
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy()
  }
  overlayWin = null
}

/** 是否把鼠标事件交给悬浮窗（控制栏可见时=true，可点击；隐藏时=false 点击穿透） */
/** 当前悬浮窗是否在接收鼠标事件（点击穿透的反面）—— 自检用 */
let overlayInteractive = false

export function setOverlayInteractive(interactive: boolean): void {
  if (interactive !== overlayInteractive) {
    // 只在真正变化时记一行：点击穿透状态是「按钮没反应」的第一嫌疑，排障时需要看到它的切换
    log.append('info', 'overlay', `悬浮窗鼠标交互：${interactive ? '接收点击' : '点击穿透'}`)
  }
  overlayInteractive = interactive
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.setIgnoreMouseEvents(!interactive, { forward: true })
}

/** 自检：读当前是否可交互 */
export function isOverlayInteractive(): boolean {
  return overlayInteractive
}

/** 播放页 → 悬浮窗：同步控制栏所需状态 */
export function pushOverlayState(state: unknown): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.webContents.send(CH.overlayState, state)
}

/** 播放页 → 悬浮窗：同步选集数据（低频） */
export function pushOverlayEpisodes(payload: unknown): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.webContents.send(CH.overlayEpisodes, payload)
}

/** 播放页 → 悬浮窗：同步弹幕数据与设置（v0.2.8，换集/改设置时才推） */
export function pushOverlayDanmaku(payload: unknown): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.webContents.send(CH.overlayDanmaku, payload)
}

/** 播放页 → 悬浮窗：唤出控制栏（鼠标移动） */
export function pokeOverlay(): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.webContents.send(CH.overlayPoke)
}

/** 悬浮窗 → 播放页：控制栏动作 */
export function sendOverlayAction(action: Record<string, unknown>): void {
  if (!ownerWin || ownerWin.isDestroyed()) {
    /*
     * v0.2.8 附加：这条日志专门用来排查「点了按钮没反应」——
     * 控制栏动作是发给 owner 窗口的，owner 丢了或认错窗口，用户看到的就是全都没反应。
     */
    log.append('warn', 'overlay', `控制栏动作无法投递（owner 缺失或已销毁）: ${JSON.stringify(action).slice(0, 80)}`)
    return
  }
  ownerWin.webContents.send(CH.overlayAction, action)
}

/**
 * 排障用：记录当前 owner 窗口是谁。
 * 悬浮窗的控制栏动作是发给 owner 的 —— owner 认错窗口（例如认成刚打开的「弹幕设置」小窗口）
 * 就会出现「所有按钮都没反应」，这一行日志是判断依据。
 */
export function logOverlayOwner(tag: string): void {
  if (!ownerWin || ownerWin.isDestroyed()) {
    log.append('info', 'overlay', `${tag}：owner 缺失`)
    return
  }
  let url = ''
  try {
    url = ownerWin.webContents.getURL().split('#')[1] ?? ''
  } catch {
    /* ignore */
  }
  // 播放页地址里带着 base64 状态，日志里只留路由部分，否则一行几 KB
  const route = url.split('?')[0].slice(0, 40)
  log.append(
    'info',
    'overlay',
    `${tag}：owner=#${ownerWin.id}${route ? ` (${route})` : ''}${ownerWin.isFocused() ? ' [聚焦]' : ''}`
  )
}

export function overlayWindow(): BrowserWindow | null {
  return overlayWin && !overlayWin.isDestroyed() ? overlayWin : null
}

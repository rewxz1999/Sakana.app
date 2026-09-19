import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { CH } from '@shared/channels'
import { log } from '../log'

/**
 * 控制栏悬浮窗
 *
 * 为什么需要它：libmpv / libVLC 的画面是**原生子窗口**，永远绘制在网页内容之上，
 * 所以页面里的控制栏无法叠在画面上。全屏时若要让画面铺满整屏、控制栏又能浮在画面上，
 * 只能另开一个**透明、无边框**的窗口来承载控制栏。
 *
 * ## z 序（v0.2.9 彻底改掉，用户第三次反馈同一个现象）
 *
 * 用户的现象：把播放器放到别的应用窗口后面时，**播放器会强行占住最前面那个窗口的位置**，
 * 同时控制栏按钮全部失灵，而播放快捷键仍然有效。
 *
 * 根因（Windows 的窗口分层规则）：
 * 1. 视频是**主窗口的 WS_CHILD 子窗口**（见 native/mpv/src/addon.cc 的 CreateChildWindow），
 *    它只会跟着主窗口一起被盖住，本身不会抢全局 z 序；
 * 2. 真正抢位的是这个悬浮窗。它过去是 `alwaysOnTop('screen-saver')`（最高的置顶层），
 *    于是主窗口退到后台时，铺满整个窗口区域的悬浮窗**仍然浮在别人的窗口上面** ——
 *    看起来就是「播放器抢占最前面窗口的位置」；
 * 3. 更关键的是：`setAlwaysOnTop(false)` 走的是 `SetWindowPos(HWND_NOTOPMOST)`，
 *    它的语义是「放到**非置顶窗口的最上面**」—— 也就是说「降级」这个动作本身
 *    又把悬浮窗提到了其它应用窗口之上。所以 v0.2.8 那版「失焦就降 topmost」的修法
 *    根本没能让它退到别人窗口后面（这正是用户说「修了很多次都没解决」的原因）；
 * 4. 按钮失灵：悬浮窗默认是**点击穿透**的（`setIgnoreMouseEvents(true)`），
 *    由渲染层的「控制栏可见」心跳切成可点击。主窗口一旦不在前台，心跳状态与实际状态就会错位，
 *    于是控制栏可见却仍然穿透 —— 点下去落到别人窗口上，什么都不会发生；
 *    而快捷键由主进程的全局快捷键处理，所以照旧有效。
 *
 * 现在的做法（只有一条规则，没有看护进程）：
 * - **任何情况下都不调用 setAlwaysOnTop**。悬浮窗是主窗口的 owned window
 *   （Windows 上 owned window 始终在主窗口之上、并随主窗口一起被别的窗口盖住），
 *   主窗口退到后台时它就跟着退到后台，不可能再「抢占最前面的位置」；
 * - 显隐只跟主窗口的最小化/隐藏走，失焦不再改变显隐；
 * - 「是否接收点击」由**主进程**统一裁决：既要渲染层希望可点击（控制栏真的显示着），
 *   也要主窗口确实在前台（`owner.isFocused() && !isMinimized()`）；不满足就是点击穿透。
 *   这样「看得见却点不动」和「点到了看不见的窗口」两类问题都不可能出现。
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
 * 让悬浮窗跟随主窗口的移动、缩放与显隐。
 *
 * v0.2.5 起主窗口恢复自由缩放：不跟随的话，窗口拉大后悬浮窗仍是旧尺寸，
 * 控制栏按钮的实际位置与命中区域错位 —— 表现为「点了全屏按钮没反应」。
 *
 * v0.2.9（用户第三次反馈「播放器会强行抢占最前面窗口的位置」）——这一版把 z 序彻底理顺：
 * **不再对悬浮窗调用 setAlwaysOnTop**（见文件头注释），悬浮窗只作为主窗口的
 * owned window 跟随主窗口的 z 序；这里只处理显隐与几何跟随。
 */
function startFollowing(owner: BrowserWindow): void {
  stopFollowing()
  const sync = (): void => syncBounds()
  /** 最小化 / 隐藏（关闭到托盘）时跟着主窗口一起收起来 */
  const hideForOwner = (): void => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide()
  }
  const onForegroundChange = (): void => {
    // 主窗口被激活时 Windows 会把主窗口提到同层顶端，悬浮窗要重新插回它上方
    raiseAboveOwner()
    applyInteractive()
  }
  const showForOwner = (): void => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.showInactive()
    raiseAboveOwner()
    /*
     * v0.2.12：重新显示后立刻按当前状态重算交互。
     * `showInactive()` 不会让主窗口获得焦点，而旧的裁决逻辑要求「在前台才可点击」，
     * 于是「窗口隐藏再显示」之后控制栏一直是点击穿透状态（用户反馈的第二种失灵场景）。
     * 现在只等渲染层的心跳/下一次鼠标移动就行，但仍然在这里补一次，缩短窗口期。
     */
    applyInteractive()
  }
  owner.on('minimize', hideForOwner)
  owner.on('hide', hideForOwner)
  owner.on('restore', showForOwner)
  owner.on('show', showForOwner)
  owner.on('focus', onForegroundChange)
  owner.on('blur', onForegroundChange)
  owner.on('resize', sync)
  owner.on('move', sync)
  owner.on('maximize', sync)
  owner.on('unmaximize', sync)
  owner.on('enter-full-screen', sync)
  owner.on('leave-full-screen', sync)
  followDisposers = [
    () => owner.off('minimize', hideForOwner),
    () => owner.off('hide', hideForOwner),
    () => owner.off('restore', showForOwner),
    () => owner.off('show', showForOwner),
    () => owner.off('focus', onForegroundChange),
    () => owner.off('blur', onForegroundChange),
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

/**
 * 把悬浮窗插到主窗口**正上方**（v0.2.9 的关键一步）。
 *
 * 为什么需要它：去掉 `alwaysOnTop` 之后，控制栏不能再抢全局最前面（这正是用户要的），
 * 但主窗口被激活时 Windows 会把**主窗口**提到同层顶端，owned window 不一定跟着回去 ——
 * 实测窗口化状态下 `WindowFromPoint` 在控制栏位置命中的是主窗口的页面窗口，
 * 也就是控制栏被自己的页面盖住了（全屏时反而正常，因为那时主窗口没有页面区域压在上面）。
 *
 * `moveAbove(owner)` 在 Windows 上就是 `SetWindowPos(overlay, owner, …)`：
 * 把悬浮窗**紧贴在主窗口上方**，而不是提到「最上层」——
 * 于是主窗口在别的应用后面时，悬浮窗也跟着在后面（不抢位），
 * 主窗口在前台时悬浮窗又在主窗口之上（控制栏看得见、点得到）。
 * 这一步是「既要在自己窗口之上、又不许抢别人位置」的正解。
 */
function raiseAboveOwner(): void {
  if (!overlayWin || overlayWin.isDestroyed() || !ownerWin || ownerWin.isDestroyed()) return
  try {
    overlayWin.moveAbove(ownerWin.getMediaSourceId())
  } catch (err) {
    log.append('warn', 'overlay', `把控制栏插到主窗口上方失败: ${String((err as Error)?.message ?? err)}`)
  }
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
     * 窗口还在但**被隐藏**时重新显示。
     * v0.2.9 起不再需要「只有主窗口在前台才恢复」这个前提：悬浮窗不置顶，
     * 主窗口在后台时它本来就会被一起盖住，显示了也不会浮在别人窗口上。
     * 只排除「主窗口已最小化」——那种情况下显示没有任何意义。
     */
    if (!overlayWin.isVisible() && !owner.isMinimized()) {
      overlayWin.showInactive()
      log.append('info', 'overlay', '悬浮窗此前处于隐藏状态，已重新显示')
    }
    raiseAboveOwner()
    applyInteractive()
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
  rendererWantsInteractive = false
  overlayInteractive = false
  /*
   * 注意：这里**故意不调用 setAlwaysOnTop**（任何层级都不调用）。
   * 悬浮窗作为主窗口的 owned window 天然位于主窗口之上、且随主窗口一起被别的窗口盖住，
   * 够用且永远不会「抢占最前面的位置」；理由详见文件头注释。
   */
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
  overlayWin.once('ready-to-show', () => {
    overlayWin?.showInactive()
    raiseAboveOwner()
  })
  log.append('info', 'overlay', `控制栏悬浮窗已创建（第 ${myGen} 代，不置顶）`)
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
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy()
  }
  overlayWin = null
}

/** 是否把鼠标事件交给悬浮窗（控制栏可见时=true，可点击；隐藏时=false 点击穿透） */
/** 当前悬浮窗是否在接收鼠标事件（点击穿透的反面）—— 自检用 */
let overlayInteractive = false
/** 渲染层**希望**的交互状态（控制栏是否真的显示着） */
let rendererWantsInteractive = false

/**
 * 主进程统一裁决「悬浮窗是否接收鼠标事件」。
 *
 * ## v0.2.12：去掉「主窗口必须在前台」这个条件（用户第三次反馈按钮失灵的真凶）
 *
 * 用户的现象（这次描述得很具体）：**播放器窗口位于另一个应用窗口之下**时、
 * 以及**窗口被隐藏后再显示**时，控制栏看得见但按钮全都没反应。
 *
 * 旧规则要求 `ownerWin.isFocused()`，理由写在 v0.2.9 的注释里（怕「点到看不见的窗口」）。
 * 但 v0.2.9 之后悬浮窗已经是 owned window 且**从不 setAlwaysOnTop**，
 * 它不可能浮在别的应用窗口之上 —— 那条理由已经不成立了，而它留下一个**死锁**：
 *
 *   主窗口不在前台 → 控制栏点击穿透 → 用户点控制栏，点击落到别的窗口上
 *   → 主窗口永远拿不到焦点 → 控制栏永远不可点。
 *
 * 窗口隐藏后再显示也是同一回事：`showInactive()` 不聚焦，状态一直卡在「不可点」。
 * （渲染层其实每 1.5 秒都在重申「控制栏显示着、我要可点击」，但被这道门槛全部否掉。）
 *
 * 现在的规则只有一条：**渲染层说控制栏显示着，就接收点击**，另加两个物理前提 ——
 * 悬浮窗确实可见、主窗口没被最小化。真正被别的窗口盖住时，点击本来就到不了悬浮窗，
 * 不需要（也不应该）用焦点状态去猜。
 */
function applyInteractive(): void {
  const visible = !!overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()
  const minimized = !!ownerWin && !ownerWin.isDestroyed() && ownerWin.isMinimized()
  const next = rendererWantsInteractive && visible && !minimized
  if (next !== overlayInteractive) {
    // 只在真正变化时记一行：点击穿透状态是「按钮没反应」的第一嫌疑，排障时需要看到它的切换
    log.append(
      'info',
      'overlay',
      `悬浮窗鼠标交互：${next ? '接收点击' : '点击穿透'}` +
        (rendererWantsInteractive && !visible ? '（悬浮窗不可见）' : '') +
        (rendererWantsInteractive && visible && minimized ? '（主窗口已最小化）' : '')
    )
  }
  overlayInteractive = next
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.setIgnoreMouseEvents(!next, { forward: true })
}

export function setOverlayInteractive(interactive: boolean): void {
  rendererWantsInteractive = interactive
  applyInteractive()
}

/** 自检：读当前是否可交互 */
export function isOverlayInteractive(): boolean {
  return overlayInteractive
}

/**
 * 自检：悬浮窗当前是否处于置顶状态。
 * v0.2.9 的预期值**永远是 false** —— 一旦变成 true 就说明又有代码在抢 z 序。
 */
export function isOverlayAlwaysOnTop(): boolean {
  return !!overlayWin && !overlayWin.isDestroyed() && overlayWin.isAlwaysOnTop()
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
  /*
   * v0.2.12：控制栏来的动作**都是用户点出来的**（播放/暂停、进度、音量、选集…），
   * 此时把主窗口带到前台：一是符合 Windows 的常规行为（点后台窗口上的控件会激活它），
   * 二是让紧接着的键盘快捷键立即生效（快捷键依赖主窗口的输入焦点）。
   * 悬浮窗自己 `focusable: false`，永远不会抢焦点，这里是我们主动把焦点给 owner。
   */
  try {
    if (!ownerWin.isFocused() && !ownerWin.isMinimized()) ownerWin.focus()
  } catch {
    /* 窗口正在销毁时 focus 可能抛错，不影响动作投递 */
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

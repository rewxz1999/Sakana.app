import { BrowserWindow, app, screen } from 'electron'
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
 * - 「是否接收点击」不再按"控制栏整条可见不可见"整窗裁决，而是**按鼠标所在的区域**裁决，
 *   见下面的 v0.3.9 说明。
 *
 * ## v0.3.9：整窗切换 → 按区域命中（用户报的「点击击穿」的根治）
 *
 * 用户的现象：控制栏就在眼前，按钮点了没反应；而且有时反过来 —— 想点画面暂停/拖 mpv 的进度条，
 * 却发现「画面中间那一块点不动」。
 *
 * 根因（v0.2.x~v0.3.8 一直是这个）：悬浮窗铺满**整个**播放器窗口，而"是否接收点击"是按
 * 「控制栏显示着没有」整窗切换的。于是两种坏结果必然出现：
 *   ① 控制栏显示期间，**整窗**（含画面中部）都在吃鼠标 —— mpv 收不到任何鼠标事件，
 *      「点画面暂停」「拖动 uosc 的进度条」「鼠标移到画面中部唤出控制栏」全部失效；
 *   ② 控制栏收起/显示的那一瞬间（5 秒自动隐藏、切集、窗口隐藏再显示、切后台再回来），
 *      窗口的系统级状态与界面状态会错位几十到几百毫秒 —— 用户正好在这段时间点下去，
 *      事件就落在"看不见的网"或者干脆没人接上，表现就是「按钮看得见、点了没反应」。
 *      v0.2.8~v0.3.6 加过的「1.5 秒心跳重申」「失焦不算数」「疑似击穿提示」都是在打这个时间差，
 *      但只要是整窗切换，时间差就永远存在（心跳反而把窗口一直锁在"接收点击"上，让 ① 更严重）。
 *
 * 现在改成：**悬浮窗永远 `setIgnoreMouseEvents(true, { forward: true })`**，
 * 只在鼠标**真的落在需要点的东西上**（控制栏/面板/按钮，渲染层用 `data-sakana-hit` 标出）
 * 时才临时关掉穿透。鼠标一旦移出这些区域就立刻恢复穿透，鼠标重新落回 mpv 画面。
 *
 * 两条路径共同决定「这一帧鼠标落在哪」：
 *   · **渲染层**：`mousemove`（`forward: true` 时即使穿透也收得到）→ `elementFromPoint` 命中判定
 *     → 只有**状态变化**时才 IPC 一次（不再是每次移动都发）。延迟最低。
 *   · **主进程**（本文件）：每 `CURSOR_POLL_MS` 读一次系统光标位置，落在悬浮窗矩形内就问渲染层
 *     `window.__sakanaHitAt(x,y)`（`executeJavaScript`，不需要新开 IPC 通道）；
 *     落在矩形外则**强制**恢复穿透。这条路兜住「光标一直没动、渲染层永远收不到 mousemove」
 *     的冷启动场景（例如按 F 全屏后光标正好停在按钮位置上），也是"渲染层卡住"时的安全网。
 *
 * ## v0.3.9 第三轮：**不再用运行期判定决定"吃不吃鼠标"**（用户实测 46% 点击落空后的架构调整）
 *
 * 实测证据（`.e2e/verify-overlay-clickthrough.ps1`，真实光标）：
 *   切换式方案（悬停命中 → `setIgnoreMouseEvents(false)`）**39 次点击丢了 18 次（46%）**，
 *   未聚焦场景 5 次丢 4 次；而采样点上"可交互=true"一直是对的 —— 说明判定逻辑没错，
 *   错的是**"从穿透切到接收"本身需要时间**：一轮判定 + 一次 IPC + 一次 `setIgnoreMouseEvents`
 *   生效，在几十毫秒的窗口里点下去就穿过去了。用户移动鼠标再点击虽然间隔更长，
 *   但这个窗口永远无法收敛到零 —— 所以这条路**从原理上就走不通**，不是时序参数能补的。
 *
 * 现在把"要不要吃鼠标"从运行期决策改成**窗口形状（静态布局）**：
 *
 *   ① **UI 窗口**（本文件的 `overlayWin`）：铺满主窗口（保持 CSS 坐标不变），透明、不抢焦点，
 *      **默认就一直接收鼠标**（不再切 `setIgnoreMouseEvents`），但用 `setShape(rects)`
 *      把"真正能画、能点"的区域限制成控制栏/面板的实际矩形。
 *      Electron 文档原话：区域外"no pixels will be drawn and no mouse events will be registered…
 *      will fall through to whatever is behind the window" ——
 *      **命中判定由操作系统完成**：控制栏上的点击永远落进 Electron 窗口（零延迟、零竞态），
 *      画面上的点击永远落到下面的 mpv 子窗口，不需要判定、不需要轮询、不需要迟滞。
 *   ② **弹幕窗口**（`danmakuWin`）：同样铺满主窗口、永远 `setIgnoreMouseEvents(true, {forward:true})`，
 *      只画弹幕（与原来的视觉/透明度完全一致），一次都不切换。
 *
 * 于是 46% 的落空从原理上消失：点击能不能到控制栏，取决于**窗口区域**这个静态事实，
 * 而不取决于"这一帧的判定结果 + 状态是否已经下发"。
 *
 * 旧的运行期判定（`setOverlayHit` 那套：命中探针 / 迟滞 / 光标轮询 / 来源仲裁）**保留但降级**：
 *   · 它现在只用于**诊断**，以及 `setShape` 不可用的平台（Electron 标注 win32/linux）上的降级回退；
 *   · 在 Windows 上（本应用的目标平台）这些代码路径不会被走到 —— 不再有"切换时机"这件事。
 *
 * 职责边界：
 * - 本模块负责窗口创建/定位/显隐/形状、以及「状态下行、动作上行」的消息中转；
 * - 「哪些区域算可交互」由渲染层按 DOM 实际矩形给出（`__sakanaHitRegions()`），
 *   因为控制栏高度、面板位置只有页面自己最清楚；主进程只负责把它变成窗口形状。
 */

let overlayWin: BrowserWindow | null = null
/**
 * 重同步日志的节流表（V1.4）：key → 上次记录时间。
 * 只用来压掉"同一状态反复刷"的噪声，状态真的变化时仍然照常记（键里带了状态）。
 */
const overlayLogMarks = new Map<string, number>()
/**
 * 弹幕窗口（v0.3.9 第三轮）。
 *
 * 为什么要把弹幕单独拆一个窗口：UI 窗口用 `setShape` 限定可点区域，而 `setShape` 同时**裁剪绘制** ——
 * 铺满画面中部的弹幕会被裁掉。所以弹幕必须画在另一块"整窗铺满、永久穿透"的窗口里。
 * 它永远不接收鼠标（`setIgnoreMouseEvents(true, { forward: true })` 只设一次），
 * z 序在 UI 窗口之下、主窗口之上。
 */
let danmakuWin: BrowserWindow | null = null
let ownerWin: BrowserWindow | null = null
/** 跟随主窗口尺寸/位置的监听器解绑函数（悬浮窗销毁时必须解绑，否则会泄漏监听） */
let followDisposers: (() => void)[] = []
/**
 * 最近一次**非空**的区域（v0.3.9 第六轮）。
 *
 * 为什么必须留着它：`setShape` 会**裁剪绘制**（不只是命中）——区域一旦为空，控制栏、面板、
 * 「加载中」提示全都会被裁掉不画。用户实测 ④：「选集播放后一片黢黑、连控制栏都不见了」
 * 就是这条路：渲染层在切换/挂载那一瞬间报了一次空区域 → 我们把窗口藏了 → 控制栏消失，
 * 而画面此时还是黑的（mpv 还没出画），于是整屏全黑。
 * 所以：**永远不允许 UI 窗口同时"没有形状 + 不可见"**（见 applyRegions 的 NEVER_DEAD_STATE 注释）。
 */
let lastNonEmptyRegions: HitRegion[] = []
/** 是否正处在"退化兜底"状态（拿不到区域时用上一份/整窗），诊断与自检要看这个 */
let regionsDegraded = false
/** 退化兜底的原因（写日志/诊断用） */
let regionsDegradedReason = ''
/**
 * 形状成功下发的累计次数、以及"渲染层报来空区域"的累计次数（v0.3.9 第六轮）。
 *
 * 为什么要有计数器：用户实测 ④ 需要的是"进入播放页头 3 秒的日志时间线"——
 * 光看当前状态看不出"这 3 秒里形状被下发了几次、有没有出现过空区域"。
 * 有了计数，自检可以把每一帧的状态变化讲清楚（详见 index.ts 的 3 秒健康采样断言）。
 */
let shapeApplyCount = 0
let hollowRegionPulls = 0
/** 最近一次"渲染层报来空区域"的原因（空字符串 = 没发生过） */
let lastHollowReason = ''
/**
 * 窗口是不是**按设计**被藏起来的（uosc 接管控制栏、整块交还 mpv）。
 *
 * 为什么要单独记一个标志：`resyncOverlay` 是"把窗口弄回来"的动作，若它不看这个标志，
 * 就会把 uosc 模式下**故意藏起来**的窗口又显示出来（并且复用它手里那份旧区域）——
 * 那就把"整块交还 mpv"这件事给破坏了。所以 resync 只在"不是按设计隐藏"时才强制显示。
 */
let hiddenByDesign = false

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

/** 遍历当前活着的悬浮窗（UI + 弹幕），回调里自行判空 */
function eachOverlayWindow(fn: (win: BrowserWindow, kind: OverlayKind) => void): void {
  if (overlayWin && !overlayWin.isDestroyed()) fn(overlayWin, 'ui')
  if (danmakuWin && !danmakuWin.isDestroyed()) fn(danmakuWin, 'danmaku')
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
  /**
   * 几何跟随：窗口尺寸/位置一变，**形状也必须重算** ——
   * 形状坐标是相对窗口客户区的，窗口拉大/全屏后控制栏位置变了，旧形状就会错位
   * （表现为"控制栏上的点击点不动、画面上的点击被吃掉"）。
   */
  const sync = (): void => {
    syncBounds()
    void refreshRegions(true)
  }
  /** 最小化 / 隐藏（关闭到托盘）时跟着主窗口一起收起来 */
  const hideForOwner = (): void => {
    eachOverlayWindow((w) => w.hide())
  }
  const onForegroundChange = (): void => {
    // 主窗口被激活时 Windows 会把主窗口提到同层顶端，悬浮窗要重新插回它上方
    resyncOverlay('主窗口焦点变化')
  }
  const showForOwner = (): void => {
    /*
     * 主窗口从隐藏/托盘恢复：**必须重新同步一次**（v0.3.9 第六轮）。
     *
     * 为什么不能只 showInactive：窗口被隐藏期间渲染层可能已经换了控制栏/面板布局，
     * 而"窗口恢复显示"这件事本身不会触发任何区域上报 —— 不重下发形状就会出现
     * "窗口回来了、形状还是旧的甚至没有"（用户报的 ②：显示回来之后按钮完全没反应）。
     */
    resyncOverlay('主窗口恢复显示')
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
  if (!ownerWin || ownerWin.isDestroyed()) return
  const ownerId = ownerWin.getMediaSourceId()
  try {
    /*
     * z 序（自下而上）：主窗口 → 弹幕窗口 → UI 窗口。
     * 弹幕在控制栏之下（控制栏画在它上面），两者都在主窗口之上（且随主窗口一起被别的窗口盖住）。
     * 顺序必须显式排：两个悬浮窗都是 owned window，谁后插入谁在上。
     */
    if (danmakuWin && !danmakuWin.isDestroyed()) danmakuWin.moveAbove(ownerId)
    if (overlayWin && !overlayWin.isDestroyed()) {
      const below = danmakuWin && !danmakuWin.isDestroyed() ? danmakuWin.getMediaSourceId() : ownerId
      overlayWin.moveAbove(below)
    }
  } catch (err) {
    log.append('warn', 'overlay', `把悬浮窗插到主窗口上方失败: ${String((err as Error)?.message ?? err)}`)
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

/** 悬浮窗角色：'ui' = 控制栏/面板（限制形状、一直接收鼠标）；'danmaku' = 弹幕（整窗、永久穿透） */
type OverlayKind = 'ui' | 'danmaku'

/**
 * 创建一个悬浮窗（UI / 弹幕两种角色共用同一套窗口参数，只有"吃不吃鼠标"不同）。
 *
 * 两者都铺满主窗口：**保持 CSS 坐标与页面完全一致** —— 控制栏/面板的定位、弹幕的视频矩形
 * 都不需要做坐标换算（换成"只覆盖控制栏的小窗口"就要把整棵 UI 的坐标平移，改动面大、
 * 而且每次布局变化都要重新算）。UI 窗口靠 `setShape` 限定可点/可画区域，等价于"贴合区域的小窗口"。
 */
function createOverlayWindow(owner: BrowserWindow, kind: OverlayKind): BrowserWindow {
  const b = owner.getBounds()
  const win = new BrowserWindow({
    parent: owner,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
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
    /*
     * v0.3.9 第六轮（用户实测 ② 的建议之一）：**非活动窗口的第一次点击也要交给网页**。
     *
     * 悬浮窗是 `focusable: false` + `showInactive()`，永远不会成为前台窗口。默认情况下
     * "窗口未激活时的第一次点击"只会用来激活窗口、不投递给网页（Windows 的点击穿透激活语义），
     * 于是"窗口被别的应用压住/刚从隐藏恢复"之后的第一下点击就白点了 —— 用户报的
     * 「被压到其它应用后面之后控制栏按钮完全没反应」里就有这一条。
     * 打开 acceptFirstMouse 后，即使窗口未激活，第一次点击也会直接进入页面。
     */
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /*
       * v0.2.8：**必须关掉后台节流**。
       * 弹幕画在悬浮窗的 canvas 上、靠 requestAnimationFrame 推进，
       * 而透明置顶且不可聚焦的窗口很容易被 Chromium 判定为「后台/被遮挡」——
       * 默认的 backgroundThrottling 会把 rAF 与定时器压到几乎不触发，
       * 实测表现就是「弹幕只画了一秒就冻住、播放时间停住不再前进」。
       */
      backgroundThrottling: false,
      additionalArguments: ['--sakana-overlay']
    }
  })
  if (kind === 'danmaku') {
    // 弹幕窗口：**一次性**设为永久穿透（forward 让 hover 类事件仍可用），此后绝不切换
    win.setIgnoreMouseEvents(true, { forward: true })
  } else {
    /*
     * UI 窗口：**默认就接收鼠标**（此后绝不切换"吃不吃"），能点的范围交给 `setShape` 限定。
     *
     * ⚠️ 这里**不预置空形状**：`setShape([])` 的语义在 Electron 文档里没有明确（可能被当成"恢复整窗"），
     * 一旦理解错，这一小段时间整窗都会吃鼠标（画面上的点击就丢了）。所以：UI 窗口先**保持隐藏**，
     * 等渲染层报上第一批区域再 `setShape(区域)` + `showInactive()` —— 隐藏的窗口不可能吃鼠标，零风险。
     */
    win.setIgnoreMouseEvents(false)
  }
  win.on('closed', () => {
    if (kind === 'ui') overlayWin = null
    else danmakuWin = null
  })
  if (kind === 'ui') {
    /*
     * v0.3.6：主进程侧的鼠标活动兜底（`before-input-event` 在浏览器进程侧，不依赖渲染层响应）。
     * v0.3.9 第三轮起它只做两件事：保活 poke（让控制栏显示出来）与刷新区域缓存。
     */
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'mouseMove' || input.type === 'mouseDown' || input.type === 'mouseUp') {
        noteOverlayMouse()
        pokeOverlayFromInput()
      }
    })
  }
  win.webContents.on('render-process-gone', (_e, d) => {
    log.append('warn', 'overlay', `悬浮窗（${kind}）渲染进程结束: ${d.reason}`)
    destroyOverlay()
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const hash = `/overlay?part=${kind}`
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}#${hash}`)
  else void win.loadFile(rendererUrl(), { hash })
  win.once('ready-to-show', () => {
    /*
     * UI 窗口**不在这里显示**：它要等渲染层报上可交互区域、`setShape` 设好之后才显形
     * （见 applyRegions）—— 没有形状的"整窗接收鼠标"窗口会把画面上的点击全吃掉。
     * 弹幕窗口直接显示（它永久穿透，显示出来也不吃鼠标）。
     */
    if (kind === 'danmaku') {
      /*
       * v1.2.1：显示**之前再确认一次穿透**。
       *
       * 为什么不能只信构造时那一次 setIgnoreMouseEvents：弹幕窗口铺满整个播放器窗口、
       * 又位于 mpv 的原生子窗口之上 —— 它一旦不是穿透态，视频区域上的**所有**鼠标事件
       * （包括 uosc 控制栏的按钮）都会被它吃掉，现象与「按钮全部失灵」一模一样，却极难定位。
       * 这里幂等重申一次，代价是一次系统调用，换掉一整类静默故障。
       */
      win.setIgnoreMouseEvents(true, { forward: true })
      win.showInactive()
    }
    raiseAboveOwner()
  })
  return win
}

/** 展示控制栏悬浮窗（UI + 弹幕两块，均覆盖整个主窗口区域） */
export function showOverlay(owner: BrowserWindow): number {
  ownerWin = owner
  if (overlayWin && !overlayWin.isDestroyed()) {
    // 弹幕窗口万一没了（渲染进程崩溃/被关掉）就补一块，否则弹幕会静默消失
    if (!danmakuWin || danmakuWin.isDestroyed()) danmakuWin = createOverlayWindow(owner, 'danmaku')
    /*
     * 窗口还在时**统一走一次幂等重同步**（v0.3.9 第六轮）。
     *
     * 为什么不再只 showInactive：切集/重新进入播放页、窗口从隐藏恢复、主窗口从后台回来，
     * 这些都不会触发渲染层的区域上报 —— 只 show 不重下发形状，就会出现"窗口回来了但形状是旧的
     * 或干脆没有"（用户报的 ②：显示回来之后按钮完全没反应）。resyncOverlay 里已经包含
     * "按已知区域先重下发一次 + 异步拉最新区域 + 重新排 z 序 + 按形状确保可见"。
     */
    resyncOverlay('再次进入播放页 / 悬浮窗已存在')
    overlayGen += 1
    return overlayGen
  }
  overlayGen += 1
  const myGen = overlayGen
  startFollowing(owner)
  /*
   * 先建弹幕窗口再建 UI 窗口：`raiseAboveOwner` 会按"弹幕在下、UI 在上"排序，
   * 两个都建好后再统一排一次 z 序。
   */
  danmakuWin = createOverlayWindow(owner, 'danmaku')
  overlayWin = createOverlayWindow(owner, 'ui')
  rendererWantsInteractive = false
  overlayInteractive = false
  /*
   * v0.3.9 补充：**预置一次光标位置**（降级回退路径要用；形状模式下只影响诊断）。
   * 否则轮询的第一帧会把"刚拿到一个位置"当成"光标移动了"，把判定权无端推给主进程。
   */
  try {
    const p0 = screen.getCursorScreenPoint()
    const b0 = overlayWin.getContentBounds()
    lastCursorLocal = { x: p0.x - b0.x, y: p0.y - b0.y }
  } catch {
    lastCursorLocal = null
  }
  startCursorHitWatch()
  watchDisplayChanges()
  /*
   * 注意：这里**故意不调用 setAlwaysOnTop**（任何层级都不调用）。
   * 悬浮窗作为主窗口的 owned window 天然位于主窗口之上、且随主窗口一起被别的窗口盖住，
   * 够用且永远不会「抢占最前面的位置」；理由详见文件头注释。
   */
  raiseAboveOwner()
  /*
   * v1.2.1：把两块悬浮窗与主窗口的 HWND 一起写进日志。
   *
   * 为什么值得占一行：真机排查「点击到底落在谁身上」用的是 WindowFromPoint ——
   * 它返回的类名/句柄必须能和我们对上号（主窗口 / 弹幕窗 / UI 窗 / mpv 子窗口）。
   * 没有这行，现场只能靠猜；有了它，一条命中结果就能直接归因。
   */
  const hwndHex = (w: BrowserWindow | null): string => {
    try {
      if (!w || w.isDestroyed()) return '0x0'
      return `0x${w.getNativeWindowHandle().readUInt32LE(0).toString(16)}`
    } catch {
      return 'n/a'
    }
  }
  log.append(
    'info',
    'overlay',
    `悬浮窗已创建（第 ${myGen} 代，UI 形状模式=${shapeSupported() ? '开' : '关'}，不置顶；` +
      `主窗口=${hwndHex(owner)} 弹幕窗=${hwndHex(danmakuWin)} UI窗=${hwndHex(overlayWin)}）`
  )
  logOverlayOwner('control bar owner')
  return myGen
}

/** 跟随主窗口位置/尺寸（全屏切换、显示切换时调用）—— UI 与弹幕两块都要跟 */
export function syncBounds(): void {
  if (!ownerWin || ownerWin.isDestroyed()) return
  const b = ownerWin.getBounds()
  eachOverlayWindow((w) => w.setBounds(b))
}

/**
 * 显示器变化（分辨率/缩放/换屏）时的重同步（v0.3.9 第六轮）。
 *
 * 为什么必须听这些事件：形状坐标要按缩放系数换算（见 SHAPE_UNITS），换屏或改缩放之后旧形状会整体错位 ——
 * 表现是"控制栏上的点击点不动、画面上的点击被吃掉"。窗口尺寸变化本身有 `resize/move` 监听，
 * 但"缩放变了、窗口 DIP 尺寸没变"这种情况只有这里能发现。
 */
function watchDisplayChanges(): void {
  const onDisplay = (): void => {
    resyncOverlay('显示器/缩放变化')
  }
  try {
    screen.on('display-metrics-changed', onDisplay)
    screen.on('display-added', onDisplay)
    screen.on('display-removed', onDisplay)
    followDisposers.push(() => {
      try {
        screen.off('display-metrics-changed', onDisplay)
        screen.off('display-added', onDisplay)
        screen.off('display-removed', onDisplay)
      } catch {
        /* 应用退出中 */
      }
    })
  } catch {
    /* 极旧的 Electron 没有这些事件：忽略（resize/move 已覆盖大多数情况） */
  }
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
  stopCursorHitWatch()
  rendererWantsInteractive = false
  overlayInteractive = false
  // 兜底判定的依据全部作废：矩形缓存属于刚销毁的那一代窗口，留着会让新窗口误判
  hitSnapshot = null
  snapshotAt = 0
  lastRendererReportAt = 0
  lastCursorMovedAt = 0
  mainLastHitAt = 0
  shapeRectsKey = ''
  appliedRegions = []
  appliedShapeRects = []
  /*
   * `lastNonEmptyRegions` **故意不清空**：区域是"窗口相对坐标"，与第几代窗口无关，
   * 留着重开播放页时可以直接用上一份控制栏矩形顶一下（比"整窗形状"温和得多）；
   * 真正的清空时机是"新的区域报上来"，那时它会被覆盖。
   */
  regionsDegraded = false
  regionsDegradedReason = ''
  eachOverlayWindow((w) => w.destroy())
  overlayWin = null
  danmakuWin = null
}

// ============================================================================
// 窗口形状（v0.3.9 第三轮）：把"吃不吃鼠标"变成静态布局
// ============================================================================

/** 渲染层给出的可交互区域（CSS 像素，相对悬浮窗客户区） */
interface HitRegion {
  x: number
  y: number
  w: number
  h: number
}

/** 当前生效的区域（**CSS/DIP 单位**，渲染层报上来的原样；自检与诊断按这个单位用） */
let appliedRegions: HitRegion[] = []
/** 真正传进 `setShape` 的矩形列表（两种单位解释的并集，去重后；见 SHAPE_UNITS 实测史） */
let appliedShapeRects: HitRegion[] = []
/** `setShape` 是否真的成功调用过（自检要能区分"记下了区域"和"形状真的生效了"） */
let shapeApplied = false
/** 设置形状时用的缩放系数（诊断用） */
let shapeScaleFactor = 1
/** 上一次真正下发给 setShape 的区域签名（内容没变就不碰窗口，避免每帧一次系统调用） */
let shapeRectsKey = ''
let regionsBusy = false
let regionsFetchedAt = 0

/**
 * 本平台是否支持 `setShape`（Electron 标注 `@platform win32,linux`）。
 * 支持时"吃不吃鼠标"完全由窗口形状决定，运行期判定只用于诊断；
 * 不支持（例如 macOS）时退回旧行为（运行期切换 setIgnoreMouseEvents）。
 */
function shapeSupported(): boolean {
  return !!overlayWin && !overlayWin.isDestroyed() && typeof overlayWin.setShape === 'function'
}

/** 取某个屏幕坐标所在显示器的缩放系数（形状的单位换算要用） */
function scaleFactorAt(x: number, y: number): number {
  try {
    return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).scaleFactor || 1
  } catch {
    return 1
  }
}

/**
 * 下发给 `setShape` 的单位解释（v0.3.9 第五轮修订：**两份都下发，以实测为准**）。
 *
 * Electron 文档没写 `setShape` 矩形的单位（`Rectangle` 也没写，且标注 `@experimental`），
 * 所以这里不去猜，而是**把两种解释下的矩形都发给 OS**：`r`（DIP/CSS 原值）与 `r × 缩放`（物理像素）。
 * 哪一份生效由 OS 决定，我们的一份都不缺 —— 于是"OS 按哪种单位解释"这个未知量被消掉了。
 *
 * ## 实测史（同一台机器、200% 缩放、同一套脚本，v0.3.9 第五轮）
 *
 *   · 并集（`['dip','physical']`）：`phase 1 sent=19 windowReceived=19 notDelivered=0`
 *     —— 39 次真实点击**一次不丢**。
 *   · 只下发物理那一份（上一轮的改动）：`phase 1 sent=27 windowReceived=6 notDelivered=21`、
 *     `phase 2 sent=20 windowReceived=0 notDelivered=20`，且探针报"形状整体没生效"
 *     —— 等于形状整体落空。
 *
 * 结论：**并集是实测唯一能让 `notDelivered=0` 的形态**，已经改回来；不要在只跑过两种形态的情况下
 * 第三次猜"只留某一份"（真要判定哪一份生效，看 `.e2e/verify-overlay-clickthrough.ps1` 里
 * 那条"决定性探针"——它探测**两份解释互不重叠的那条带**，而不是"并集里有一点属于我们"）。
 *
 * 为什么"并集"在两种解释下都成立（值得记住的几何事实）：
 * 设窗口客户区在 DIP 空间的真实控制栏点是 p，则
 *   · OS 按 DIP 解释 → 覆盖点在屏幕 (原点 + N) × 缩放；并集里有 N = p，所以 p 被覆盖；
 *   · OS 按物理解释 → 覆盖点在屏幕 原点 × 缩放 + N；并集里有 N = p × 缩放，所以 p 仍被覆盖。
 * 也就是说：**只要下发 `{r, r×sf}` 两份，真实控制栏在哪种解释下都落在形状里**。
 *
 * `'dip'` / `'physical'` 仍然保留在类型里，是为了万一将来在别的机器上探针给出确定结论时，
 * 可以只改这一行；默认值永远是两份都发（保守且实测有效）。
 */
type ShapeUnit = 'dip' | 'physical'
const SHAPE_UNITS: ShapeUnit[] = ['dip', 'physical']

/**
 * 区域为空时**绝对不允许**进入的状态（v0.3.9 第六轮，用户实测 ④ 的修复）。
 *
 * ## 症状与根因
 *
 * 用户原话：「选集播放后进入播放，但是什么也不显示，一片黢黑，连播放器控制栏都不见了。」
 *
 * 根因是 `setShape` 的**裁剪是双向的**：Electron 文档说形状外的区域
 * "no pixels will be drawn and no mouse events will be registered"。也就是说区域一旦为空，
 * 控 **制栏、面板、以及「加载中」提示全都不再绘制** —— 而此时 mpv 往往还没出第一帧（正是"选集播放"
 * 之后那几秒），于是整屏全黑、连控制栏都看不见。
 *
 * ## 规则（改这块代码必须遵守）
 *
 *   · 只要播放页还活着，**任何时候都不允许 UI 窗口同时"没有形状 + 不可见"**；
 *   · 拿不到区域时：先用**上一份有效区域**，没有历史区域就用**整窗形状**，并写日志说明为什么退化；
 *   · 宁可短暂多吃鼠标（画面上的点击暂时进不了 mpv），也不能让控制栏/加载提示消失；
 *   · 只有渲染层**明确**说"应用此刻没有任何可交互元素"（uosc 接管控制栏，`allowHide`）才允许隐藏窗口 ——
 *     那是设计上的"整块交还 mpv"，不是这次要修的退化场景。
 */

/** 整窗形状（退化兜底的最后一招：至少让页面能画出来） */
function wholeWindowRegions(): HitRegion[] {
  const win = overlayWin
  if (!win || win.isDestroyed()) return []
  const b = win.getContentBounds()
  return [{ x: 0, y: 0, w: b.width, h: b.height }]
}

/** 渲染层对"为什么这次区域是空的"的自述（渲染层没提供时返回 null） */
interface RegionsDiag {
  uosc?: boolean
  ready?: boolean
  hasTopBar?: boolean
  hasBottomBar?: boolean
  hitCount?: number
  barVisible?: boolean
}

async function readRegionsDiag(): Promise<RegionsDiag | null> {
  const win = overlayWin
  if (!win || win.isDestroyed()) return null
  try {
    return (await win.webContents.executeJavaScript(
      `typeof window.__sakanaRegionsDiag === 'function' ? window.__sakanaRegionsDiag() : null`,
      true
    )) as RegionsDiag | null
  } catch {
    return null
  }
}

function describeRegionsDiag(d: RegionsDiag | null): string {
  if (!d) return '渲染层未提供原因'
  const parts: string[] = []
  if (d.uosc) parts.push('uosc 接管控制栏')
  if (d.ready === false) parts.push('页面还没就绪')
  /*
   * v1.1.4：旧控制栏已剥离，uosc 模式下 DOM 里本来就没有顶栏/底栏。
   * 这时再说「DOM 里还没有控制栏」会把正常的 uosc 隐藏误报成页面没加载完。
   */
  if (!d.uosc && d.hasTopBar === false && d.hasBottomBar === false) parts.push('DOM 里还没有控制栏')
  if (typeof d.hitCount === 'number') parts.push(`可点容器 ${d.hitCount} 个`)
  if (d.barVisible === false) parts.push('控制栏此刻处于自动收起')
  return parts.length > 0 ? parts.join('、') : '渲染层说当前没有任何可交互元素'
}

/**
 * 现在**允许**把悬浮窗显示出来吗？
 *
 * 主窗口最小化或已经隐藏（例如"关闭到托盘"）时不允许：那种情况下显示悬浮窗没有任何意义，
 * 而且会让 `hideForOwner` 刚做的隐藏被下一帧的区域拉取立刻撤销 —— 变成"主窗口在托盘里、
 * 控制栏却挂在桌面上"。
 * ⚠️ 注意：这只影响"要不要显示"，不影响"要不要下发形状"（形状该更新还是要更新）。
 */
function mayShowOverlay(): boolean {
  if (!ownerWin || ownerWin.isDestroyed()) return true
  if (ownerWin.isMinimized()) return false
  return ownerWin.isVisible()
}

/**
 * 把渲染层报上来的区域变成窗口形状。
 *
 * ## 单位问题（实测踩到的坑，如实写在这里）
 *
 * `setShape` 的矩形单位文档里没有（且标注 `@experimental`）：见 SHAPE_UNITS 的实测史。
 *
 * 另外两个必须遵守的点：
 *   · **形状里必须包含控制栏的"热区"**（即使此刻自动收起）—— 否则渲染层收不到鼠标移动，
 *     控制栏就永远唤不出来（死锁）。热区由渲染层按顶栏/底栏容器的实际矩形给出。
 *   · **形状同时也决定"画什么"** —— 所以凡是要显示的东西（含 pointer-events:none 的提示条，
 *     见渲染层的 `data-sakana-draw`）都必须出现在区域里，否则会被裁掉不画。
 */
function applyRegions(regions: HitRegion[], opts: { allowHide?: boolean; reason?: string } = {}): void {
  if (!shapeSupported()) {
    appliedRegions = regions
    return
  }
  const win = overlayWin
  if (!win || win.isDestroyed()) return
  const b = win.getContentBounds()
  const sf = scaleFactorAt(b.x, b.y)
  const minimized = !!ownerWin && !ownerWin.isDestroyed() && ownerWin.isMinimized()

  let effective = regions
  let degraded = false
  let degradeReason = ''
  if (regions.length === 0) {
    if (opts.allowHide) {
      /* 合法空区域（uosc 接管控制栏）：整块交还 mpv —— 隐藏窗口，而不是留一个空形状
         （也避开 `setShape([])` 语义不明这个坑）。 */
      appliedRegions = []
      appliedShapeRects = []
      shapeScaleFactor = sf
      regionsDegraded = false
      regionsDegradedReason = ''
      hiddenByDesign = true
      shapeRectsKey = `${SHAPE_UNITS.join('+')}|${sf}|HIDDEN|`
      if (win.isVisible()) {
        win.hide()
        log.append('info', 'overlay', '控制栏窗口形状已清空并隐藏（应用此刻没有任何可交互元素：uosc 接管/整块交给 mpv）')
      }
      return
    }
    /* 走到这里说明"区域为空"不是设计上的情况 —— 见 NEVER_DEAD_STATE 的说明，绝不隐藏。 */
    hollowRegionPulls += 1
    lastHollowReason = opts.reason ?? '未说明'
    if (lastNonEmptyRegions.length > 0) {
      effective = lastNonEmptyRegions.map((r) => ({ ...r }))
      degradeReason = `渲染层这次报的是空区域（${opts.reason ?? '未说明'}），沿用上一份有效区域 ${effective.length} 块`
    } else {
      effective = wholeWindowRegions()
      degradeReason = `渲染层还没有可交互区域（${opts.reason ?? '未说明'}）且没有历史区域，临时用整窗形状`
    }
    degraded = true
  } else {
    lastNonEmptyRegions = regions.map((r) => ({ ...r }))
  }

  const rectKey = effective.map((r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`).join(';')
  const key = `${SHAPE_UNITS.join('+')}|${sf}|${degraded ? 'D' : 'N'}|${rectKey}`
  appliedRegions = effective
  if (key === shapeRectsKey) return
  shapeRectsKey = key
  /*
   * 两种单位解释的**并集**（缩放≈1 时两份重合，去重后只剩一份）。
   * 去重键取整到像素：两份在同一位置时的重复矩形没有意义，还会让 OS 多做一次命中判定。
   */
  const rects: HitRegion[] = []
  const seen = new Set<string>()
  for (const unit of SHAPE_UNITS) {
    const scaled = unit === 'physical' && Math.abs(sf - 1) > 0.01
    for (const r of effective) {
      const q = scaled ? { x: r.x * sf, y: r.y * sf, w: r.w * sf, h: r.h * sf } : { x: r.x, y: r.y, w: r.w, h: r.h }
      const dedupe = `${Math.round(q.x)},${Math.round(q.y)},${Math.round(q.w)},${Math.round(q.h)}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      rects.push(q)
    }
  }
  try {
    win.setShape(
      rects.map((r) => ({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.max(0, Math.round(r.w)),
        height: Math.max(0, Math.round(r.h))
      }))
    )
    shapeApplied = true
    appliedShapeRects = rects
    shapeScaleFactor = sf
    shapeApplyCount += 1
    hiddenByDesign = false
    /* 形状设好了就必须可见：形状决定了"画什么"，隐藏的窗口画不出控制栏（NEVER_DEAD_STATE）。
       例外：主窗口最小化/隐藏到托盘时不允许显示（见 mayShowOverlay）。 */
    if (!win.isVisible() && !minimized && mayShowOverlay()) {
      win.showInactive()
      log.append('info', 'overlay', `控制栏窗口已显示（形状 ${rects.length} 块矩形）`)
    }
    regionsDegraded = degraded
    regionsDegradedReason = degraded ? degradeReason : ''
    log.append(
      degraded ? 'warn' : 'info',
      'overlay',
      (degraded ? `⚠️ 形状退化兜底：${degradeReason}；` : '') +
        `控制栏窗口形状已更新：${rects.length} 块矩形（CSS 区域 ${effective.length} 块 = 渲染层 ${regions.length} 块，` +
        `单位解释=${SHAPE_UNITS.join('+')}，缩放=${sf}，` +
        `示例=${JSON.stringify(rects.map((r) => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]).slice(0, 4))}）`
    )
  } catch (err) {
    shapeApplied = false
    regionsDegraded = true
    regionsDegradedReason = `setShape 抛错：${String((err as Error)?.message ?? err)}`
    log.append('warn', 'overlay', `设置窗口形状失败: ${regionsDegradedReason}`)
    /*
     * setShape 失败时**也要保证窗口可见**（NEVER_DEAD_STATE）：没有形状的窗口会整窗吃鼠标，
     * 但"控制栏彻底消失、整屏全黑"是更严重的问题 —— 用户明确要求宁可短暂多吃鼠标。
     * 这里只显示、不去猜测形状；下一次区域上报会重新尝试 setShape。
     */
    if (!win.isVisible() && !minimized && mayShowOverlay()) {
      win.showInactive()
      log.append('warn', 'overlay', '控制栏窗口在形状下发失败的情况下被强制显示（避免"控制栏消失"）')
    }
  }
}

/**
 * 幂等重同步（v0.3.9 第六轮）。
 *
 * 为什么需要它：窗口隐藏→显示、切后台→回来、重新进入播放页、显示器变化这些**都不会**触发
 * 渲染层的区域上报，于是会出现"窗口回来了，但形状/区域/层叠顺序还是上一次的"——
 * 用户报的 ②「窗口显示回来之后控制栏按钮完全没响应」就是这个。
 * 这里把"同步几何 + 重新下发形状 + 重新排 z 序 + 重新拉区域"打包成一个可反复调用的动作。
 */
export function resyncOverlay(reason: string): void {
  const win = overlayWin
  if (!win || win.isDestroyed()) return
  const canShow = mayShowOverlay()
  const minimized = !!ownerWin && !ownerWin.isDestroyed() && ownerWin.isMinimized()
  syncBounds()
  /*
   * 日志节流（V1.4）：同一类状态在短时间内重复出现时只记一条。
   *
   * 真机日志里这两行能刷满整屏 —— 主窗口焦点每变化一次就重同步一次，而 uosc 接管模式下
   * 结果永远是"按设计隐藏、区域 0 块"：
   *   [overlay] 悬浮窗重同步（再次进入播放页 / 悬浮窗已存在）：…
   *   [overlay] 悬浮窗已重同步（…）：可见=false 区域=0 块 退化=false
   * 对排障没有任何新信息，却把真正有用的行（规则/播放/错误）挤掉了。
   * 现在同样的 (reason, 可见, 区域数) 组合 30 秒内只记一次；状态真变了立刻记。
   */
  const logOnce = (msg: string, key: string): void => {
    const now = Date.now()
    const last = overlayLogMarks.get(key)
    if (last && now - last < 30_000) return
    overlayLogMarks.set(key, now)
    log.append('info', 'overlay', msg)
  }
  if (danmakuWin && !danmakuWin.isDestroyed() && !minimized && canShow) {
    /*
     * v1.2.1：每次重新显示都重申穿透（理由见 createOverlayWindow 的 ready-to-show）。
     * 弹幕窗口在 z 序上高于主窗口与 mpv 子窗口，穿透态一旦丢失，uosc 的点击就全没了。
     */
    danmakuWin.setIgnoreMouseEvents(true, { forward: true })
    danmakuWin.showInactive()
  }
  if (canShow) {
    /*
     * 先按"当前已知区域"重下发一次（立刻可用的那份），再异步拉一次最新的。
     * 顺序不能反：异步那次要等一个 IPC 往返，用户在这期间已经可能点按钮了。
     * 例外：窗口是**按设计隐藏**的（uosc 接管控制栏）——那时不要把它弄回来，
     * 只让下面的 refreshRegions 去按最新区域重新判定一次。
     */
    if (hiddenByDesign && appliedRegions.length === 0) {
      logOnce(`悬浮窗重同步（${reason}）：按设计隐藏（uosc 接管控制栏），只刷新区域（同状态 30s 内不重复）`, 'resync-hidden')
    } else {
      const known = appliedRegions.length > 0 ? appliedRegions : lastNonEmptyRegions
      if (known.length > 0) applyRegions(known, { allowHide: false })
      else applyRegions([], { allowHide: false, reason: '重同步时还没有任何区域' })
    }
  }
  raiseAboveOwner()
  applyInteractive()
  void refreshRegions(true)
  pokeHitCheck()
  /*
   * 第二行日志同样节流：键里带"可见/区域数/是否退化"，**状态真的变了立刻记**，
   * 只是重复刷同样的状态才压掉。这样排障时不会丢关键变化。
   */
  logOnce(
    `悬浮窗已重同步（${reason}）：可见=${win.isVisible()} 区域=${appliedRegions.length} 块 退化=${regionsDegraded}`,
    `resync-done|${win.isVisible()}|${appliedRegions.length}|${regionsDegraded}`
  )
}

/**
 * 拉一次渲染层的可交互区域（`__sakanaHitRegions()`），内部按 REGION_PULL_MS 节流。
 * 渲染层每次上报判定结果时都会被叫一次 —— 区域变化（控制栏显隐、面板开合）本来就会触发它的判定，
 * 所以形状能跟着同步更新，不需要新增 IPC 通道。
 */
async function refreshRegions(force = false): Promise<void> {
  const win = overlayWin
  if (!win || win.isDestroyed() || regionsBusy) return
  if (!force && Date.now() - regionsFetchedAt < REGION_PULL_MS) return
  regionsFetchedAt = Date.now()
  regionsBusy = true
  try {
    const r = (await win.webContents.executeJavaScript(
      `typeof window.__sakanaHitRegions === 'function' ? window.__sakanaHitRegions() : null`,
      true
    )) as HitRegion[] | null
    if (Array.isArray(r)) {
      if (r.length > 0) {
        applyRegions(r)
      } else {
        /*
         * 空区域必须先问清原因再决定藏不藏（第六轮）：
         *   · uosc 接管控制栏 → 设计上就该隐藏（整块交还 mpv）；
         *   · 其它任何原因 → 退化兜底，绝不隐藏（否则控制栏消失 + 形状裁剪把整屏画成黑的）。
         */
        const diag = await readRegionsDiag()
        applyRegions(r, { allowHide: diag?.uosc === true, reason: describeRegionsDiag(diag) })
      }
    } else {
      /* 渲染层还没挂载（`__sakanaHitRegions` 不存在）：也要走兜底，不能什么都不做 ——
         过去这里什么都不做，于是"窗口还没就绪 + 没有形状"就一直停在隐藏态，控制栏再也不出现。 */
      applyRegions([], { allowHide: false, reason: '渲染层还没挂载（__sakanaHitRegions 不存在）' })
    }
  } catch {
    /* 页面正在销毁/导航中：保持上一次的形状（比清空安全） */
  } finally {
    regionsBusy = false
  }
}

/**
 * 悬浮窗当前是否**真的**在接收鼠标事件（点击穿透的反面）—— 自检与日志用
 */
let overlayInteractive = false
/**
 * 判定结果：鼠标此刻是否落在可点区域上。
 *
 * v0.3.9 起这个值**只有一个来源**：渲染层的那个状态机（`__sakanaHitAt` / `setInteractive`），
 * 它同时管几何（容器级 `data-sakana-hit`）、迟滞（命中后 650ms 内不因一次 miss 就收回）与拖动锁。
 * 主进程不再自己下结论（早期版本两边各写一个标志，日志里同一秒能看到"接收点击/穿透"反复横跳 ——
 * 那正是用户实测的击穿窗口），只负责：把结论下发、按窗口矩形兜硬地板、以及把"来源 + 原因"记清楚。
 */
let rendererWantsInteractive = false
/** 自检用：最后一次状态变化是被谁带过来的（'renderer' | 'main' | 'none'） */
let lastHitSource: 'renderer' | 'main' | 'none' = 'none'
/** 自检/日志用：最后一次状态变化的原因（渲染层 zone 或主进程硬地板） */
let lastHitReason = 'none'
/**
 * 主进程刚问过渲染层命中判定的时刻。
 *
 * 为什么需要：判定结论一律由渲染层给出（见上面的说明），所以"是谁触发的"只能从时间上认 ——
 * 轮询发出 probe 之后紧接着到达的那条 IPC，就是被这次轮询触发的那次重新判定。
 * 仅用于日志里的"来源"标注（250ms 窗口），不参与任何判定。
 */
let lastProbeAt = 0
const PROBE_ATTRIBUTION_MS = 250
/** 上一次已经写进日志的"被迟滞拦住"次数（渲染层计数，只在增长时写一行） */
let lastLatchedLogged = 0
let lastLatchedLogAt = 0
/** 「被迟滞拦住」日志的最小间隔：迟滞窗口 650ms，同一窗口最多写一行，免得又被刷屏 */
const LATCH_LOG_INTERVAL_MS = 600

/**
 * 下发「是否接收鼠标事件」，并在**真的变化时**写一行日志。
 *
 * ⚠️ v0.3.9 第三轮起这条路**只在没有 `setShape` 的平台**上生效（降级回退）：
 * 形状模式下 UI 窗口默认就一直接收鼠标，能点的范围由窗口形状决定，
 * 所以这里根本不需要切换（用户实测的 46% 点击落空就是切换带来的）。
 * 保留它是为了 macOS 等平台不至于完全没有交互 —— 但那不是本应用的目标平台（构建只出 Windows）。
 */
function applyInteractive(): void {
  if (shapeSupported()) return // 形状模式：不切换"吃不吃鼠标"
  const visible = !!overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()
  const minimized = !!ownerWin && !ownerWin.isDestroyed() && ownerWin.isMinimized()
  const next = rendererWantsInteractive && visible && !minimized
  if (next !== overlayInteractive) {
    // 点击穿透状态是「按钮没反应」的第一嫌疑，排障时需要看到它的切换（含是谁、为什么）
    log.append(
      'info',
      'overlay',
      `悬浮窗鼠标交互：${next ? '接收点击' : '点击穿透'}` +
        `（来源：${lastHitSource === 'main' ? '主进程光标轮询' : '渲染层鼠标移动'}；原因：${lastHitReason}）` +
        (rendererWantsInteractive && !visible ? '（悬浮窗不可见）' : '') +
        (rendererWantsInteractive && visible && minimized ? '（主窗口已最小化）' : '')
    )
  }
  overlayInteractive = next
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.setIgnoreMouseEvents(!next, { forward: true })
}

/**
 * 渲染层（IPC）报告「鼠标此刻是否落在可点区域上」。
 *
 * 名字沿用 `setOverlayInteractive`（preload 与契约里的名字），但语义从 v0.3.9 起是
 * **渲染层那个状态机的结论**（含迟滞与拖动锁），而不是「控制栏整条显示着」。
 *
 * 与主进程兜底判定的关系（工单要求：行为确定且可解释）：
 *   · 判定权归渲染层（判定依据就是它看到的位置）→ 直接采纳；
 *   · 主进程正在接手（渲染层刚才是收不到鼠标事件的），此时来一条**迟到的"没命中"**不采纳 ——
 *     它反映的是旧位置，翻回去会让按钮点不动；但**"命中"一律采纳**（宁可短暂吃鼠标）。
 *     下一次真实光标移动会重新走一遍判定权的规则，不需要用户做任何事。
 */
export function setOverlayInteractive(interactive: boolean): void {
  /*
   * v0.3.9 第三轮：这条 IPC 现在的**主要作用**是"渲染层有话要说"的信号 ——
   * 主进程据此立刻拉一次可交互区域（控制栏显隐、面板开合都会触发渲染层的判定），
   * 于是窗口形状跟着同步更新。判定本身只在没有 setShape 的平台上决定"吃不吃鼠标"。
   */
  void refreshRegions()
  const ownedByRenderer = rendererOwnsDecision()
  lastRendererReportAt = Date.now()
  if (shapeSupported()) {
    // 形状模式：状态切换不再有意义，只记诊断（自检与日志仍能看到渲染层的判定）
    rendererWantsInteractive = interactive
    lastHitSource = 'renderer'
    lastHitReason = interactive ? '渲染层判定命中可点区域（形状模式下不影响吃不吃鼠标）' : '渲染层判定离开可点区域（形状模式下不影响吃不吃鼠标）'
    return
  }
  if (!ownedByRenderer && !interactive && overlayInteractive) {
    ignoredLateReports += 1
    if (ignoredLateReports === 1 || ignoredLateReports % 20 === 0) {
      log.append(
        'info',
        'overlay',
        `悬浮窗鼠标交互：忽略渲染层一条迟到的"没命中"（主进程正在按系统光标接手判定，累计 ${ignoredLateReports} 次）`
      )
    }
    return
  }
  rendererWantsInteractive = interactive
  // 结论本身来自渲染层；这里只区分"是被主进程轮询催出来的"还是"鼠标移动直接报上来的"
  lastHitSource = Date.now() - lastProbeAt < PROBE_ATTRIBUTION_MS ? 'main' : 'renderer'
  lastHitReason = interactive ? '渲染层判定命中可点区域' : '渲染层判定离开可点区域（超过迟滞/容差）'
  applyInteractive()
}

// ============================================================================
// 主进程侧的光标命中轮询（v0.3.9）
// ============================================================================

/**
 * 光标轮询间隔。
 *
 * 为什么是 100ms（10Hz）而不是更密：这条路只是**兜底**（冷启动时光标没动过、或渲染层卡住），
 * 跟手的判定由渲染层的 mousemove 负责（事件驱动，零延迟）。再密也只是拿渲染层主线程
 * 去换一个兜底路径的精度 —— 弹幕画布就在同一个渲染进程里，不值得。
 */
const CURSOR_POLL_MS = 100
let cursorWatchTimer: NodeJS.Timeout | null = null
/** 上一次轮询到的光标位置（悬浮窗客户区坐标，DIP） */
let lastCursorLocal: { x: number; y: number } | null = null
/** 最近一次"系统光标真的动了"的时刻（用来判断渲染层是不是收不到鼠标事件） */
let lastCursorMovedAt = 0
let hitQueryBusy = false

/**
 * 判定参数（**与渲染层 PlayerOverlayPage.tsx 的 HIT_NEAR_PX / HIT_LATCH_MS 必须一致**）。
 *
 * 为什么主进程也要有一份：窗口不在前台时渲染层可能收不到鼠标事件（见 decideFromRects 的说明），
 * 那时只能由主进程拿「系统光标位置 + 渲染层缓存的可点矩形」自己判定。两边的矩形来自同一个来源
 * （渲染层的 `__sakanaHitSnapshot()`），规则也照抄同一套，所以结论不会互相矛盾。
 */
const HIT_NEAR_PX = 24
const HIT_LATCH_MS = 650
/** 可点矩形缓存的刷新间隔（主进程兜底判定的依据；页面重排/控制栏显隐后最多滞后这么多） */
const RECT_TTL_MS = 300
/**
 * 向渲染层拉"可交互区域"（窗口形状的来源）的最小间隔。
 * 区域变化本来就伴随一次渲染层上报（控制栏显隐/面板开合都会触发判定），
 * 所以这里主要是防抖与安全网：真正决定形状的是那次上报触发的立即拉取。
 */
const REGION_PULL_MS = 80
/** 鼠标输入驱动"保活 poke"的最小间隔（避免每个 mousemove 都发一次 IPC） */
const INPUT_POKE_MS = 200

/** 渲染层上报的可点矩形快照（主进程兜底判定的原始数据） */
interface HitRectSnapshot {
  rects: { x: number; y: number; w: number; h: number; hittable: boolean }[]
  locked: boolean
  verdict: boolean
  zone: string
  /** 渲染层累计收到的 mousemove 次数（排查"渲染层到底有没有收到鼠标"的硬证据） */
  moves: number
}

/**
 * 渲染层收到的点击统计（v0.3.9 第五轮：把"点击没到"与"到了但没落在按钮上"分开）。
 *
 * `sendOverlayAction` 数的是"动作到达主进程"；而落在控制栏**热区空白处**的点击
 * （自动收起后那一帧、按钮之间的空隙）会到达窗口却没有任何动作。
 * 只数动作时这两类会混成一个数字，无法定位（上一轮 8/39 说不清就是这个原因）。
 */
interface OverlayClickStats {
  /** 渲染层收到的 pointerdown 总数（= 这一下确实落进了 Electron 窗口） */
  down: number
  /** 其中落在 `<button>` 上的（正常应与动作数 1:1） */
  onButton: number
  /** 落在可点容器上但不是按钮（热区空白 / 面板留白） */
  onHitBlank: number
  /** 落在别处（理论上不该有） */
  elsewhere: number
  /** 按按钮 title / 文本归类，用于定位"某个按钮系统性丢" */
  byTitle: Record<string, number>
}

let clickStats: OverlayClickStats | null = null

/** 拉一次渲染层的点击统计（HOLD 自检每 0.5 秒一次，成本可忽略） */
export async function refreshOverlayClickStats(): Promise<void> {
  const win = overlayWin
  if (!win || win.isDestroyed()) return
  try {
    const r = (await win.webContents.executeJavaScript(
      `(typeof window.__sakanaClickStats === 'function') ? window.__sakanaClickStats() : null`,
      true
    )) as OverlayClickStats | null
    if (r && typeof r.down === 'number') clickStats = r
  } catch {
    /* 页面正在销毁/导航中 */
  }
}

/** 自检：渲染层收到的点击统计（down = 真的落进 Electron 窗口的点击数） */
export function overlayClickStatistics(): OverlayClickStats {
  return clickStats ?? { down: 0, onButton: 0, onHitBlank: 0, elsewhere: 0, byTitle: {} }
}

let hitSnapshot: HitRectSnapshot | null = null
let snapshotAt = 0
let snapshotBusy = false
/** 渲染层最近一次上报判定结果的时刻（任何一条 setInteractive IPC 都算） */
let lastRendererReportAt = 0
/** 主进程侧迟滞窗口的起点（与渲染层同一套迟滞规则） */
let mainLastHitAt = 0
let mainLatchedBlocks = 0
let lastInputPokeAt = 0
let lastTickLogAt = 0
/** 被忽略的"迟到没命中"条数（主进程接手判定期间），只用于日志与诊断 */
let ignoredLateReports = 0

/**
 * 拉一次渲染层的可点矩形快照（用 executeJavaScript，不新增 IPC 通道；内部自我节流）。
 * 失败或页面未就绪时保留上一份缓存 —— 兜底判定宁可慢一点，也不能因为一次查询失败就失去依据。
 */
async function refreshHitSnapshot(force = false): Promise<void> {
  const win = overlayWin
  if (!win || win.isDestroyed() || snapshotBusy) return
  if (!force && Date.now() - snapshotAt < RECT_TTL_MS) return
  snapshotAt = Date.now()
  snapshotBusy = true
  try {
    const r = (await win.webContents.executeJavaScript(
      `typeof window.__sakanaHitSnapshot === 'function' ? window.__sakanaHitSnapshot() : null`,
      true
    )) as HitRectSnapshot | null
    if (r && Array.isArray(r.rects)) hitSnapshot = r
  } catch {
    /* 页面正在销毁/导航中，保留上一份缓存 */
  } finally {
    snapshotBusy = false
  }
}

/**
 * 主进程自己判定：**系统光标位置 + 渲染层缓存的可点矩形**（工单要求 2/3）。
 *
 * 为什么必须有这条兜底（这就是 4/7 FAIL 的根因）：
 *   · Electron 的类型文档对 `sendInputEvent` 写得很明确：「承载内容的 BrowserWindow 必须处于聚焦状态」；
 *     悬浮窗是 `focusable:false` + `showInactive()`，永远不会成为前台窗口 —— 自检里
 *     "主窗口失焦"（场景①）与"隐藏后再显示"（场景②）投递进去的鼠标事件根本到不了渲染层，
 *     渲染层一个结论都给不出，主进程保持穿透，用户点下去就是击穿。
 *   · 真实光标的 hover 虽然由 Chromium 转发，但那条路要经过 IPC + React：页面卡一下、或渲染进程
 *     还没挂上监听，判定就断了。用户的实际用法正是「播放器不在前台，一边看番一边操作别的窗口」。
 * 规则与渲染层完全一致（命中 / 贴边 HIT_NEAR_PX / 迟滞 HIT_LATCH_MS / 拖动锁），
 * 且只在渲染层"不吭声"时启用（见 pollCursorHit），因此两个判定源不会互相打架。
 */
/** 只算区间的纯查询（无副作用，日志/诊断用） */
function zoneFromRects(x: number, y: number): 'hit' | 'near' | 'away' | 'none' {
  const rects = (hitSnapshot?.rects ?? []).filter((r) => r.hittable)
  if (rects.length === 0) return 'none'
  if (rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) return 'hit'
  const near = rects.some(
    (r) =>
      x >= r.x - HIT_NEAR_PX &&
      x <= r.x + r.w + HIT_NEAR_PX &&
      y >= r.y - HIT_NEAR_PX &&
      y <= r.y + r.h + HIT_NEAR_PX
  )
  return near ? 'near' : 'away'
}

function decideFromRects(x: number, y: number, locked: boolean): { hit: boolean; reason: string } {
  if (locked) return { hit: true, reason: '拖动中（指针已捕获，不收回点击）' }
  const zone = zoneFromRects(x, y)
  if (zone === 'none') return { hit: false, reason: '没有可点区域缓存（页面还没就绪）' }
  const now = Date.now()
  if (zone === 'hit') {
    mainLastHitAt = now
    return { hit: true, reason: '主进程按可点矩形判定：命中' }
  }
  if (zone === 'near' && overlayInteractive && now - mainLastHitAt <= HIT_LATCH_MS) {
    mainLatchedBlocks += 1
    return { hit: true, reason: '主进程按可点矩形判定：贴着可点区（迟滞内保持）' }
  }
  return {
    hit: false,
    reason: zone === 'near' ? '主进程按可点矩形判定：贴边但迟滞已过' : '主进程按可点矩形判定：明显离开'
  }
}

/**
 * **判定权**（谁说了算）—— 只有一条规则，确定性、可解释：
 *
 *   渲染层在「最近一次真实光标移动」之后有过上报 ⇒ 判定权归渲染层（它确实看到了当前位置）；
 *   否则（光标动过、但渲染层一直没上报 —— 窗口未聚焦收不到鼠标事件、页面卡住、钩子还没挂上）
 *   ⇒ 判定权归主进程，由它按「系统光标 + 缓存的可点矩形」判定。
 *
 * 为什么必须这样定：兜底判定与渲染层判定都能写状态；如果两边都"随时可以写"，就会出现
 * 「一个说命中、另一个说没命中」的互相覆盖 —— 自检 #3 上一版 PASS、这一版 FAIL 就是这个。
 * 加上这条规则后，任何时刻只有一个来源在写状态：
 *   · 光标从未动过（自检注入的是合成事件，真实光标不动）→ 判定权一直归渲染层，主进程完全不插手；
 *   · 真实光标一动、渲染层那一瞬还没上报 → 主进程接手（正是"一边看番一边操作别的窗口"的场景）；
 *   · 渲染层一旦上报（它重新看得见鼠标）→ 判定权立刻交回。
 * RENDERER_GRACE_MS 给渲染层留出 IPC 往返 + 一帧的时间。
 */
const RENDERER_GRACE_MS = 150

function rendererOwnsDecision(): boolean {
  if (lastRendererReportAt === 0) return false // 渲染层从没上报过（页面还没就绪）
  if (lastCursorMovedAt === 0) return true // 真实光标没动过：判定依据就是渲染层看到的那个位置
  if (lastRendererReportAt >= lastCursorMovedAt) return true // 光标动过之后它有上报 → 它看得见
  return Date.now() - lastCursorMovedAt < RENDERER_GRACE_MS
}

/** 自检/诊断：主进程当前是否在接手判定（渲染层收不到鼠标事件时为 true） */
function rendererIsBlind(): boolean {
  return !rendererOwnsDecision()
}

/**
 * 鼠标输入驱动的"保活"：把控制栏唤出来 + 刷新可点矩形缓存（都按 INPUT_POKE_MS 节流）。
 *
 * 为什么放在主进程：窗口未聚焦时渲染层收不到 mousemove，它自己的 poke（显示控制栏）也就不会发生；
 * 而 `before-input-event` 这条钩子在浏览器进程侧，不依赖渲染层是否响应，于是由主进程保证
 * "鼠标压到控制栏上时控制栏就是显示着的"，兜底判定的矩形缓存也顺带保持新鲜。
 */
function pokeOverlayFromInput(): void {
  const now = Date.now()
  if (now - lastInputPokeAt < INPUT_POKE_MS) return
  lastInputPokeAt = now
  pokeOverlay()
  void refreshHitSnapshot()
}

/**
 * 渲染层命中查询的返回结构（见 probeOverlayHit）。
 * `zone` / `latched` / `msSinceHit` 来自渲染层的 `__sakanaHitDiag()`，只用于日志与诊断。
 */
interface OverlayHitProbe {
  /** 该点是否落在可点区域（拖动中恒为 true） */
  hit: boolean
  /** 渲染层是否正在拖动（指针被捕获，不能收回点击） */
  locked: boolean
  /** 渲染层的判定区间：命中 / 贴着边缘 / 明显离开 */
  zone: 'hit' | 'near' | 'away' | 'unknown'
  /** 渲染层累计"被迟滞拦住"的次数（单调递增，用于写日志） */
  latched: number
  /** 距上次命中可点区域多少毫秒（-1 = 从没命中过） */
  msSinceHit: number
}

function stopCursorHitWatch(): void {
  if (cursorWatchTimer) {
    clearInterval(cursorWatchTimer)
    cursorWatchTimer = null
  }
  lastCursorLocal = null
}

function startCursorHitWatch(): void {
  stopCursorHitWatch()
  cursorWatchTimer = setInterval(pollCursorHit, CURSOR_POLL_MS)
}

/**
 * 读系统光标位置 → 换到悬浮窗客户区坐标 → 问渲染层命中判定。
 *
 * 注意坐标单位：Electron 的 `getBounds/getContentBounds` 与 `getCursorScreenPoint` 都是 DIP，
 * 渲染层的 CSS 像素在 zoomFactor=1 时与 DIP 一一对应（悬浮窗没有缩放，见 showOverlay）。
 */
function pollCursorHit(): void {
  const win = overlayWin
  if (!win || win.isDestroyed()) return
  /*
   * v0.3.9 第三轮：**形状模式下**这里只做两件事，且**不看窗口是否可见** ——
   * UI 窗口要等第一批区域报上来才会显示（见 applyRegions），若这里先判可见性，
   * 就会出现"窗口隐藏 → 不拉区域 → 永远没有区域 → 永远不显示"的死锁。
   *   ① 定期拉一次可交互区域（安全网：万一渲染层某次上报没到）；
   *   ② 写诊断日志（谁能看清"渲染层收到几次鼠标"）。
   */
  if (shapeSupported()) {
    void refreshRegions()
    if (!win.isVisible()) return
    let p0: Electron.Point
    try {
      p0 = screen.getCursorScreenPoint()
    } catch {
      return
    }
    const b0 = win.getContentBounds()
    const local0 = { x: p0.x - b0.x, y: p0.y - b0.y }
    const moved0 = !lastCursorLocal || lastCursorLocal.x !== local0.x || lastCursorLocal.y !== local0.y
    if (moved0) lastCursorLocal = local0
    void refreshHitSnapshot()
    if (moved0) logHitTick(local0)
    return
  }
  if (!win.isVisible()) return
  let p: Electron.Point
  try {
    p = screen.getCursorScreenPoint()
  } catch {
    return
  }
  const b = win.getContentBounds()
  const local = { x: p.x - b.x, y: p.y - b.y }
  const inside = local.x >= 0 && local.y >= 0 && local.x < b.width && local.y < b.height
  const moved =
    !lastCursorLocal || lastCursorLocal.x !== local.x || lastCursorLocal.y !== local.y
  // 走到这里说明平台没有 setShape（否则上面已经 return），继续用运行期判定（降级回退）
  if (!inside) {
    /*
     * 光标已经离开悬浮窗：**立刻**恢复点击穿透 —— 这是「绝对不能整窗永久吃鼠标」的硬地板，
     * 也是迟滞规则明确允许的例外（工单：迟滞只在"还贴着控制栏"时成立，光标离开窗口不受保护）。
     * 即使渲染层卡死/没上报，也不会留下一张看不见却挡事的网（那正是用户抱怨的
     * "画面中间、进度条点不动"）。
     *
     * 唯一的例外是**正在拖动**（渲染层捕获了指针，例如拖进度条/音量，指针会短暂跑到窗口外）：
     * 这时收回点击会让拖动中途断掉，所以问一次渲染层的锁状态再决定。
     */
    lastCursorLocal = null
    if (!rendererWantsInteractive) return
    void probeOverlayHit(local.x, local.y).then((a) => {
      if (a?.locked) return
      rendererWantsInteractive = false
      lastHitSource = 'main'
      lastHitReason = '光标已离开悬浮窗'
      applyInteractive()
    })
    return
  }
  lastCursorLocal = local
  // 只有**真的动了**才算"光标移动"：首帧由 showOverlay 预置坐标，所以这里不会把静止误判成移动
  if (moved) lastCursorMovedAt = Date.now()
  // 顺手刷新可点矩形缓存（内部按 RECT_TTL_MS 自我节流）：主进程兜底判定用的就是它
  void refreshHitSnapshot()
  if (!moved) return
  /*
   * 光标在窗口内且移动了：
   *   ① 先"催"一次渲染层按真实光标重新判定（它看得见鼠标时以它为准，顺带读迟滞计数）；
   *   ② **判定权不在渲染层**时（它收不到鼠标事件：未聚焦窗口、页面卡住、钩子还没挂上），
   *      主进程按缓存矩形自己判定 —— 用户点下去必须有反应，不能赌渲染层收到事件。
   * 两条路的规则完全一致（命中 / 贴边 24px / 迟滞 650ms / 拖动锁），且由 rendererOwnsDecision
   * 保证"同一时刻只有一个来源在写状态"，不会互相覆盖。
   */
  void probeOverlayHit(local.x, local.y).then(readLatchedBlocks)
  if (rendererIsBlind()) {
    const d = decideFromRects(local.x, local.y, hitSnapshot?.locked === true)
    if (d.hit !== rendererWantsInteractive) {
      rendererWantsInteractive = d.hit
      lastHitSource = 'main'
      lastHitReason = d.reason
      applyInteractive()
    }
  }
  logHitTick(local)
}

/**
 * 诊断日志（只在 SAKANA_OVERLAY_HIT_TEST=1 时输出，每秒最多一行）。
 *
 * 为什么需要它：这次 4/7 FAIL 里最关键的信息是"渲染层到底有没有收到鼠标事件"，
 * 而只看状态变化是看不出来的。这一行把两条路各自的证据并排打出来：
 *   · rects/N  —— 渲染层给了几块可点区域（0 就说明页面还没就绪）
 *   · moves=N  —— 渲染层累计收到的 mousemove 次数（不涨 = 它根本收不到鼠标，窗口未聚焦时的典型表现）
 *   · blind    —— 主进程是否已接手判定
 */
function logHitTick(local: { x: number; y: number }): void {
  if (!process.env.SAKANA_OVERLAY_HIT_TEST) return
  const now = Date.now()
  if (now - lastTickLogAt < 1000) return
  lastTickLogAt = now
  const rects = hitSnapshot?.rects.filter((r) => r.hittable).length ?? -1
  console.log(
    `[overlay-hit] POLL 光标=(${Math.round(local.x)},${Math.round(local.y)}) 判定区间=${zoneFromRects(local.x, local.y)} ` +
      `可交互=${overlayInteractive} 来源=${lastHitSource} 原因=${lastHitReason} | ` +
      `UI窗口可见=${overlayWin?.isVisible() ?? false} 形状区域=${appliedRegions.length} 退化=${regionsDegraded} | ` +
      `渲染层: rects=${rects} moves=${hitSnapshot?.moves ?? -1} verdict=${hitSnapshot?.verdict ?? 'n/a'} ` +
      `zone=${hitSnapshot?.zone ?? 'n/a'} | 主进程兜底接手=${rendererIsBlind()}`
  )
}

/** 读渲染层的迟滞计数并按需写一行日志（同一迟滞窗口内最多一行，避免又被刷屏） */
function readLatchedBlocks(a: OverlayHitProbe | null): void {
  if (!a) return
  const grown = a.latched - lastLatchedLogged
  if (grown <= 0) return
  lastLatchedLogged = a.latched
  const now = Date.now()
  if (now - lastLatchedLogAt < LATCH_LOG_INTERVAL_MS) return
  lastLatchedLogAt = now
  log.append(
    'info',
    'overlay',
    `悬浮窗鼠标交互：保持接收点击（被迟滞拦住 ${grown} 次；当前命中区=${a.zone}，` +
      `距上次命中 ${a.msSinceHit >= 0 ? `${a.msSinceHit}ms` : '未知'}）`
  )
}

/**
 * 问渲染层「这个点算不算可点区域」。
 *
 * 用 `executeJavaScript` 而不是新开一条 IPC：渲染层只要暴露这几个查询
 *   · `window.__sakanaHitAt(x, y)` → 该点是否落在可点区域（渲染层自己那套 `data-sakana-hit` 判定，
 *      主进程与它用**同一个函数**，不存在两套判据打架的可能；它会顺带驱动一次重新判定，见下）；
 *   · `window.__sakanaHitLocked` → 是否正在拖动（指针已被捕获，不能收回点击）；
 *   · `window.__sakanaHitDiag()` → 判定区间与迟滞计数（只读，用于日志）。
 * 于是主进程按需查询即可 —— 不必往 preload / 共享契约里加东西，渲染层没挂上钩子时返回 null
 * （保持上一状态），不会报错。
 *
 * v0.3.9 补充：这一问同时会**驱动渲染层按该坐标重新判定一次**（`__sakanaHitAt` 内部读同一个状态机），
 * 所以主进程不需要、也不应该自己下结论 —— 它只负责"催"与"读诊断"。
 */
async function probeOverlayHit(
  x: number,
  y: number
): Promise<OverlayHitProbe | null> {
  const win = overlayWin
  if (!win || win.isDestroyed() || hitQueryBusy) return null
  hitQueryBusy = true
  // 记下"刚问过"：紧接着到达的那条 setInteractive 就是这个轮询催出来的（仅用于日志来源标注）
  lastProbeAt = Date.now()
  try {
    const r = (await win.webContents.executeJavaScript(
      `(function () {
         var f = window.__sakanaHitAt;
         if (typeof f !== 'function') return null;
         var hit = !!f(${Math.round(x)}, ${Math.round(y)});
         var d = typeof window.__sakanaHitDiag === 'function' ? window.__sakanaHitDiag() : null;
         return {
           hit: hit,
           locked: window.__sakanaHitLocked === true,
           zone: d && typeof d.zone === 'string' ? d.zone : 'unknown',
           latched: d && typeof d.latched === 'number' ? d.latched : 0,
           msSinceHit: d && typeof d.msSinceHit === 'number' ? d.msSinceHit : -1
         };
       })()`,
      true
    )) as OverlayHitProbe | null
    if (!r || typeof r.hit !== 'boolean') return null
    return r
  } catch {
    return null // 页面正在销毁/导航中，忽略
  } finally {
    hitQueryBusy = false
  }
}

/**
 * 悬浮窗刚显示/重新显示时催一次（此时光标可能一直没动过，渲染层收不到 mousemove）。
 *
 * v0.3.9 补充：这里同时做两件事 ——
 *   ① 强制刷新可点矩形缓存（新窗口/新布局，旧缓存不能再用）；
 *   ② 渲染层没回应（还没挂上钩子、或收不到鼠标事件）时，主进程直接按缓存矩形判一次，
 *      否则"按 F 全屏后光标正好停在按钮上、直接点"会点空（用户报过切完集按钮失灵）。
 */
function pokeHitCheck(): void {
  const win = overlayWin
  if (!win || win.isDestroyed()) return
  let local: { x: number; y: number }
  try {
    const p = screen.getCursorScreenPoint()
    const b = win.getContentBounds()
    local = { x: p.x - b.x, y: p.y - b.y }
    if (local.x < 0 || local.y < 0 || local.x >= b.width || local.y >= b.height) return
  } catch {
    return
  }
  lastCursorLocal = local
  void refreshHitSnapshot(true)
    .then(() => probeOverlayHit(local.x, local.y))
    .then((a) => {
      readLatchedBlocks(a)
      if (a && !rendererIsBlind()) return // 渲染层给了结论，主进程不插手
      const d = decideFromRects(local.x, local.y, a?.locked === true || hitSnapshot?.locked === true)
      if (d.hit === rendererWantsInteractive) return
      rendererWantsInteractive = d.hit
      lastHitSource = 'main'
      lastHitReason = d.reason
      applyInteractive()
    })
}

/**
 * 「点击击穿」侦测（v0.3.6）。
 *
 * ## 这个 bug 到底是什么（用户问的就是这个）
 *
 * 播放画面是 libmpv 的**原生子窗口**（Windows 上的 `WS_CHILD` + `CreateWindowExW`，
 * 见 `native/mpv/src/addon.cc`），它**永远绘制在网页内容之上**，z-index 对它没有任何意义。
 * 所以我们的控制栏不可能是网页里的一层 div —— 它必须是一个**独立的透明悬浮窗**
 * （`playerOverlay.ts` 就是干这个的），叠在视频之上。
 *
 * 于是就有两个窗口抢同一块屏幕区域，鼠标落下去到底进谁的口袋由 Windows 决定：
 *   · 悬浮窗**接收点击**时：用户能点按钮，但 mpv 收不到鼠标（不能拖进度、不能单击暂停）；
 *   · 悬浮窗**点击穿透**时：鼠标直达 mpv 画面，但**看不见的悬浮窗此时只是"不接收"而已** ——
 *     只要它的"接收点击"状态与实际显示的 UI 不一致，用户点下去的感觉就是
 *     **"看得见控制栏，但按了没反应"**，也就是用户说的「点击击穿」。
 *
 * 真正会发生的错位只有两类，而它们都是**时序**问题：
 *   ① 渲染层刚把控制栏显示出来 → 心跳还没送到主进程 → 那一瞬间还是穿透态。
 *      用户手快，在几十毫秒的窗口里点了一下，事件落到了 mpv 或干脆没人接。
 *   ② 渲染层把控制栏**藏了**（5 秒无操作自动隐藏），但心跳或 `setInteractive(false)`
 *      还在路上 → 悬浮窗仍然"接收点击" → 它成了一张**看不见却挡事**的网：
 *      用户想点画面暂停/拖动，全被这张网吃掉，表现同样是"按钮失灵"（但其实按钮已经没了）。
 *
 * 主进程能观测到的**硬证据**是：鼠标确实落在悬浮窗上（`mousemove` 到达悬浮窗），
 * 但随后短时间内**没有任何按钮点击回传**。这既可能是 ①（点空了），
 * 也可能是 ②（点在透明网上的空白处）。两种情况的处置建议完全一样：
 * **按 F 重新全屏一次（强制重建视频子窗口与悬浮窗的几何关系）、或按 Esc 退出播放器**。
 *
 * 所以这里做的不是"修复"（无法从主进程单方面修，因为根因是渲染层状态与窗口状态的时间差），
 * 而是**如实告诉用户 + 给出逃生手段**，并把这次事件写进日志便于复现统计。
 *
 * ## v0.3.9 补充：根因已修，这段侦测现在是"最后一道兜底"
 *
 * 上面那个"时间差"的根源是**整窗切换**：控制栏一显示，整块悬浮窗就变成接收点击的窗口，
 * 于是它的系统级状态与界面状态之间必然有几十~几百毫秒的错位窗口。v0.3.9 改成
 * **按区域命中**（鼠标真的落在按钮/面板上才接收点击，见文件头注释）之后，
 * 这个错位窗口被压到了"鼠标从按钮上移开的那一帧"，用户点空的概率可以忽略。
 * 这段侦测与自救浮层保留：它的判据（穿透态下收到 pointerdown）在穿透态下本来就不会被触发，
 * 所以正常情况下永远不会再弹 —— 一旦日志里又出现它，说明窗口叠层又出问题了。
 */
let clickThroughStreak = 0
let lastOverlayMouseAt = 0
let lastOverlayClickAt = 0
let clickThroughCb: ((payload: { count: number; at: number }) => void) | null = null
/** 控制栏动作累计条数（自检用它判断"点击真的到达了主进程"，v0.3.9） */
let overlayActionCount = 0

/** 自检：控制栏动作累计条数 */
export function overlayActionTotal(): number {
  return overlayActionCount
}

/** 自检：清零动作计数（一轮点击实验开始前调用） */
export function resetOverlayActionTotal(): void {
  overlayActionCount = 0
}

/** 渲染层订阅「疑似点击击穿」（用于弹出提示浮层） */
export function onOverlayClickThrough(cb: ((payload: { count: number; at: number }) => void) | null): void {
  clickThroughCb = cb
}

/**
 * 悬浮窗收到鼠标移动：记录时间戳，作为「用户确实在对控制栏动手」的证据。
 *
 * 两个调用来源（v0.3.6 起是两个，因为只靠渲染层上报会漏）：
 *   ① 悬浮窗渲染层每次 mousemove 上报（`overlayMissedMove`）；
 *   ② 主进程侧 `webContents` 的 `before-input-event` 里带坐标的鼠标事件（兜底，
 *      即使渲染层的上报因为页面卡住没发出来，主进程也知道鼠标来过）。
 * 自检也直接调它（`.e2e/dom-probe-036.mjs`）。
 */
export function noteOverlayMouse(): void {
  lastOverlayMouseAt = Date.now()
}

/**
 * 悬浮窗收到了鼠标移动，但用户显然是想点按钮（调用方在点击穿透态下调用这个）。
 *
 * 判定刻意保守，避免误报打扰用户：
 *   · 只在**点击穿透**（`!overlayInteractive`）时计数 —— 接收点击时不存在这个问题；
 *   · 鼠标必须在最近 1.2 秒内动过（证明用户不是在跟键盘较劲）；
 *   · 连续命中 3 次才提示（单次可能只是鼠标划过）。
 */
export function noteOverlayMissedClick(x: number, y: number): void {
  if (overlayInteractive) {
    clickThroughStreak = 0
    return
  }
  const now = Date.now()
  if (now - lastOverlayMouseAt > 1200) return
  if (now - lastOverlayClickAt < 400) return
  lastOverlayClickAt = now
  clickThroughStreak += 1
  log.append(
    'warn',
    'overlay',
    `疑似点击击穿（第 ${clickThroughStreak} 次）：鼠标在 (${x},${y}) 落在悬浮窗上，但当前是点击穿透态`
  )
  if (clickThroughStreak >= 3) {
    clickThroughStreak = 0
    clickThroughCb?.({ count: 3, at: now })
  }
}

/** 用户恢复交互（点到了按钮 / 控制栏重新显示）后清掉计数 */
export function clearOverlayMissedClicks(): void {
  clickThroughStreak = 0
}

/** 把「疑似点击击穿」的提示推给悬浮窗，由它弹自救浮层 */
export function pushOverlayClickThrough(payload: { count: number; at: number }): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  try {
    overlayWin.webContents.send(CH.overlayClickThrough, payload)
  } catch {
    /* 窗口正在销毁 */
  }
}

/** 自检：当前的穿透状态与计数器 */
export function overlayInputDiagnostics(): {
  interactive: boolean
  wants: boolean
  streak: number
  hitSource: 'renderer' | 'main' | 'none'
  /** 最后一次状态切换的原因（v0.3.9 补充：日志里也要看得到"为什么"） */
  reason: string
  /** 渲染层累计"被迟滞拦住"的次数 */
  latched: number
  /** 渲染层累计收到的 mousemove 次数（不涨 = 渲染层收不到鼠标事件） */
  rendererMoves: number
  /** 当前缓存到的可点矩形数量（0 = 页面还没就绪） */
  rects: number
  /** 主进程兜底判定是否已接手 */
  blind: boolean
  /** 主进程自己累计的迟滞保持次数 */
  latchedMain: number
  /** 形状模式：'ui-window-shape' = 用窗口形状决定吃不吃鼠标；'runtime-toggle' = 降级回退 */
  mode: 'ui-window-shape' | 'runtime-toggle'
  /** 当前生效的 CSS 可交互区域块数（形状模式的唯一依据） */
  shapeRegions: number
  /** 形状是否真的成功下发（false = setShape 没生效，吃不吃鼠标仍由运行期判定决定） */
  shapeApplied: boolean
  /** 下发形状时使用的显示器缩放系数 */
  shapeScale: number
  /** 实际传进 setShape 的矩形块数（两种单位解释的并集去重后） */
  shapeRects: number
  /** 下发时用了哪几种单位解释（v0.3.9 第五轮修订后固定为 dip+physical） */
  shapeUnits: string
  /** UI 窗口是否可见 */
  uiVisible: boolean
  /** 弹幕窗口是否可见 */
  danmakuVisible: boolean
  /** v0.3.9 第六轮：是否正处在"区域退化兜底"状态（拿不到区域时用上一份/整窗顶上） */
  shapeDegraded: boolean
  /** 退化兜底的原因（空字符串 = 没有退化） */
  shapeDegradedReason: string
} {
  return {
    // 形状模式下"可交互"是按坐标算的（system 光标落在形状里？），见 interactiveNow
    interactive: interactiveNow(),
    wants: rendererWantsInteractive,
    streak: clickThroughStreak,
    hitSource: lastHitSource,
    reason: lastHitReason,
    latched: lastLatchedLogged,
    rendererMoves: hitSnapshot?.moves ?? -1,
    rects: hitSnapshot?.rects.filter((r) => r.hittable).length ?? -1,
    blind: rendererIsBlind(),
    latchedMain: mainLatchedBlocks,
    mode: shapeSupported() ? 'ui-window-shape' : 'runtime-toggle',
    shapeRegions: appliedRegions.length,
    /** v0.3.9 第四轮：形状是否真的下发成功 + 缩放系数（单位问题的诊断依据） */
    shapeApplied,
    shapeScale: shapeScaleFactor,
    shapeRects: appliedShapeRects.length,
    shapeUnits: SHAPE_UNITS.join('+'),
    uiVisible: !!overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible(),
    danmakuVisible: !!danmakuWin && !danmakuWin.isDestroyed() && danmakuWin.isVisible(),
    shapeDegraded: regionsDegraded,
    shapeDegradedReason: regionsDegradedReason
  }
}

/**
 * 自检（v0.3.9 第六轮）：UI 窗口的"健康状态"。
 *
 * 为什么单列一个函数：用户实测 ④ 的判据就是**"任何时候都不允许 UI 窗口同时没有形状又不可见"**。
 * 自检要能在进入播放页的头几秒里反复采样这个状态，所以把它做成一个纯粹的可读查询。
 */
export function overlayUiWindowState(): {
  visible: boolean
  regions: number
  shapeRects: number
  shapeApplied: boolean
  degraded: boolean
  degradedReason: string
  healthy: boolean
  shapeApplyCount: number
  hollowRegionPulls: number
  lastHollowReason: string
} {
  const win = overlayWin
  const visible = !!win && !win.isDestroyed() && win.isVisible()
  const regions = appliedRegions.length
  const shapeRects = appliedShapeRects.length
  return {
    visible,
    regions,
    shapeRects,
    shapeApplied,
    degraded: regionsDegraded,
    degradedReason: regionsDegradedReason,
    /* "健康" = 可见且确实有形状（形状块数 > 0）——这正是"控制栏不会消失"的硬条件 */
    healthy: visible && shapeRects > 0 && shapeApplied,
    shapeApplyCount,
    hollowRegionPulls,
    lastHollowReason
  }
}

/**
 * 自检：当前生效的可交互区域（**CSS/DIP 单位**，与渲染层的 getBoundingClientRect 同源）。
 * `点是否落在这些区域里` = `这一点上的点击会不会落到 Electron 窗口` —— 由 OS 判定，没有时序问题。
 */
export function overlayShapeRegions(): HitRegion[] {
  return appliedRegions.map((r) => ({ ...r }))
}

/**
 * 自检：真正传进 `setShape` 的矩形（v0.3.9 第五轮修订：**两种单位解释的并集**）。
 *
 * 名字里不再带单位，因为现在下发的是"不赌单位"的并集（见 SHAPE_UNITS 的实测史）：
 * 真实控制栏在 DIP 与物理两种解释下都被覆盖，所以自检只应断言"按钮落在**上报的 DIP 区域**里"
 * （这等价于"无论 OS 按哪种解释，真实控制栏都在形状里"），而不是断言 OS 用了哪一种解释。
 */
export function overlayShapeRectsSent(): HitRegion[] {
  return appliedShapeRects.map((r) => ({ ...r }))
}

/** 自检：当前下发的是哪几种单位解释（诊断/日志用） */
export function overlayShapeUnits(): string[] {
  return [...SHAPE_UNITS]
}

/** 自检：`setShape` 是否真的成功调用过（false = 形状没生效，吃不吃鼠标仍由运行期判定决定） */
export function overlayShapeApplied(): boolean {
  return shapeApplied
}

/** 自检：设置形状时用的缩放系数 */
export function overlayShapeScaleFactor(): number {
  return shapeScaleFactor
}

/** 自检：某个点是否落在当前的可交互区域里（等价于"这个点上的点击归 Electron 窗口"） */
export function overlayShapeHitTest(x: number, y: number): boolean {
  return appliedRegions.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
}

/** 自检：当前的窗口形状模式（形状模式下"吃不吃鼠标"与运行期判定无关） */
export function overlayShapeMode(): 'ui-window-shape' | 'runtime-toggle' {
  return shapeSupported() ? 'ui-window-shape' : 'runtime-toggle'
}

/** 自检：弹幕窗口是否永久穿透（它是唯一"整窗铺满但永不接收鼠标"的窗口） */
export function isDanmakuWindowPassthrough(): boolean {
  return !!danmakuWin && !danmakuWin.isDestroyed()
}

/** 自检：读当前是否可交互 */
export function isOverlayInteractive(): boolean {
  return interactiveNow()
}

/**
 * 「此刻鼠标位置上的点击会不会落到悬浮窗」—— 两种架构下同一个语义。
 *
 * 形状模式：把系统光标位置丢进窗口形状里判（等价于操作系统的命中判定）；
 * 降级模式：用运行期切换出来的状态。
 *
 * 为什么要算而不是直接返回状态：形状模式下"吃不吃鼠标"是**按坐标**决定的，
 * 没有一个全局的 true/false 状态；但自检脚本（SAKANA_PLAYER_INPUT_TEST / SAKANA_UOSC_TEST）
 * 问的正是"鼠标压到控制栏上时算不算可交互" —— 用坐标算出来的答案才是它想知道的。
 */
function interactiveNow(): boolean {
  if (!shapeSupported()) return overlayInteractive
  const win = overlayWin
  if (!win || win.isDestroyed() || !win.isVisible()) return false
  try {
    const p = screen.getCursorScreenPoint()
    const b = win.getContentBounds()
    return overlayShapeHitTest(p.x - b.x, p.y - b.y)
  } catch {
    return false
  }
}

/**
 * 自检：悬浮窗当前是否处于置顶状态。
 * v0.2.9 的预期值**永远是 false** —— 一旦变成 true 就说明又有代码在抢 z 序。
 */
export function isOverlayAlwaysOnTop(): boolean {
  return !!overlayWin && !overlayWin.isDestroyed() && overlayWin.isAlwaysOnTop()
}

/**
 * 把一条消息发给所有悬浮窗（v0.3.9 第三轮拆窗口后需要）。
 * 弹幕窗口与 UI 窗口都要状态/弹幕数据；动作类只发给 UI 窗口（弹幕窗口没有任何按钮）。
 */
function broadcastOverlay(channel: string, payload?: unknown): void {
  eachOverlayWindow((w) => {
    try {
      if (payload === undefined) w.webContents.send(channel)
      else w.webContents.send(channel, payload)
    } catch {
      /* 窗口正在销毁 */
    }
  })
}

/** 播放页 → 悬浮窗：同步控制栏所需状态（弹幕窗口用它算弹幕区域，UI 窗口用它画控制栏） */
export function pushOverlayState(state: unknown): void {
  broadcastOverlay(CH.overlayState, state)
}

/** 播放页 → 悬浮窗：同步选集数据（低频，只有 UI 窗口会画选集面板） */
export function pushOverlayEpisodes(payload: unknown): void {
  broadcastOverlay(CH.overlayEpisodes, payload)
}

/** 播放页 → 悬浮窗：同步弹幕数据与设置（v0.2.8，换集/改设置时才推） */
export function pushOverlayDanmaku(payload: unknown): void {
  broadcastOverlay(CH.overlayDanmaku, payload)
}

/**
 * 播放页 → 悬浮窗：唤出控制栏（鼠标移动）。
 * 两块窗口都发：UI 窗口要显示控制栏，弹幕窗口要知道"控制栏是否显示"来算弹幕下边界
 * （它自己收不到鼠标移动 —— 弹幕窗口是永久穿透的）。
 */
export function pokeOverlay(): void {
  broadcastOverlay(CH.overlayPoke)
}

/**
 * 「点击播放器按钮没反应」侦测 + 自救提示（V1.1，用户要求）。
 *
 * 用户的原话是：「只要检测到用户点击播放器按钮无响应就弹出提示按 esc 或 F」。
 * 这里要说清楚**能检测到什么、检测不到什么**，因为这决定了它不是万能的：
 *
 * ## 两种"没反应"，只有一种能在主进程里被客观证实
 *
 *   ① **动作根本没到**：鼠标事件落在两个窗口之间（悬浮窗的透明区 / 原生视频子窗口），
 *      React 的 onPointerDown 压根没触发 → 主进程这边**一点痕迹都没有**。
 *      这种只能靠"鼠标来过但没人点"的间接证据（见上面 noteOverlayMissedClick，
 *      它在 v0.3.9 改成按区域命中后基本不会再触发）。
 *   ② **动作到了，但没生效**：动作已经进了主进程（说明点击真的被接住了），
 *      可它要求改变的那个量**没变** —— 内核卡住/没响应、窗口不配合全屏，都是这一类。
 *
 * ②是可以**硬证**的：动作本身带着"应该发生什么"，等一小会儿再读一次那个量就知道有没有发生。
 * 所以这段只做②，判据全是客观读数（mpv 属性 / 窗口全屏态），不做"猜用户是不是没点动"。
 * ①留给既有的点击击穿侦测，两者共用同一个自救浮层。
 *
 * ## 为什么放在主进程而不是渲染层
 *
 * 渲染层对 playPause / 音量 / 静音这些动作是**乐观更新**（先自己把状态改了再去调内核），
 * 于是"内核没响应"在渲染层看起来一切正常 —— 在那儿做侦测只会得到假阴性。
 * 而 uosc 控制栏（mpv 自己画的那条）的点击**不经过悬浮窗**，只有主进程同时看得到两条路，
 * 所以放在这里两边的按钮一起覆盖。
 */
const UNRESPONSIVE_MS = 1800
/** 同一个动作在这么久内只提示一次，避免用户连点几下就被弹一堆浮层 */
const RESCUE_HINT_COOLDOWN_MS = 15000

/** mpv 属性读取器（由 mpv.ts 注册；playerOverlay 不 import mpv，避免循环依赖） */
let propReader: ((name: string) => string | number | boolean | null) | null = null
export function setOverlayPropReader(fn: ((name: string) => string | number | boolean | null) | null): void {
  propReader = fn
}

/**
 * 「这个动作该改哪个量」对照表。
 *
 * 只收**客观可读**的：内核的 pause/mute/volume/speed 与窗口的全屏态。
 * 刻意**不收**这些：
 *   · 选集/详情/弹幕菜单 —— 效果是渲染层本地状态，主进程看不到；
 *   · 快进快退/拖动 —— 渲染层会乐观地把进度改掉，读到的永远是"变了"（假阴性）；
 *   · 退出播放/换集 —— 会换掉整条会话，1.8 秒后读到的是新会话，判不出对错。
 * 宁可少判几个按钮，也不要把"判不了"写成"没问题"。
 */
const EFFECT_PROBES: Record<string, { kind: 'mpv' | 'window'; name: string; label: string }> = {
  playPause: { kind: 'mpv', name: 'pause', label: '播放/暂停' },
  toggleMute: { kind: 'mpv', name: 'mute', label: '静音' },
  volumeUp: { kind: 'mpv', name: 'volume', label: '音量+' },
  volumeDown: { kind: 'mpv', name: 'volume', label: '音量-' },
  setVolume: { kind: 'mpv', name: 'volume', label: '音量' },
  setSpeed: { kind: 'mpv', name: 'speed', label: '倍速' },
  toggleFullscreen: { kind: 'window', name: 'fullscreen', label: '全屏切换' },
  exitFullscreen: { kind: 'window', name: 'fullscreen', label: '退出全屏' }
}

let effectWatchSeq = 0
let effectWatchTimer: NodeJS.Timeout | null = null
let lastRescueHintAt = 0

/** 读一个可核实的量；读不到（没会话/没注册/属性不存在）返回 null，调用方据此不判 */
function readEffectValue(probe: { kind: 'mpv' | 'window'; name: string }): string | number | boolean | null {
  if (probe.kind === 'window') {
    if (!ownerWin || ownerWin.isDestroyed()) return null
    try {
      return ownerWin.isFullScreen()
    } catch {
      return null
    }
  }
  if (!propReader) return null
  try {
    const v = propReader(probe.name)
    return v === undefined ? null : v
  } catch {
    return null
  }
}

/**
 * 控制栏动作已经进了主进程 —— 记下来，过一小会儿看它到底有没有生效；没生效就弹自救浮层。
 *
 * 两条路都要调它：悬浮窗控制栏（sendOverlayAction）与 uosc 控制栏（mpv.ts 的 250ms 泵）。
 */
export function noteControlAction(action: { type?: unknown }): void {
  const probe = EFFECT_PROBES[String(action?.type ?? '')]
  if (!probe) return
  const before = readEffectValue(probe)
  // 读不到当前值（内核没起来 / 属性不支持）→ 不判，宁可漏报也不误报
  if (before === null) return
  const my = ++effectWatchSeq
  if (effectWatchTimer) clearTimeout(effectWatchTimer)
  effectWatchTimer = setTimeout(() => {
    // 之后又点了别的按钮（或同一个按钮）→ 这一轮作废，只判最后一次
    if (my !== effectWatchSeq) return
    const after = readEffectValue(probe)
    if (after === null) return
    /*
     * 判定：数值型给一点容差（音量/倍速是浮点），其余要求严格不等。
     * 反过来说，只要**变过**就算生效 —— 不要求变成"预期的那个值"：
     * 用户的诉求是"我点了它得有点动静"，不是"它必须按我想的方向动"。
     */
    const changed =
      typeof before === 'number' && typeof after === 'number'
        ? Math.abs(after - before) > 0.01
        : after !== before
    if (changed) {
      clearOverlayMissedClicks()
      return
    }
    const now = Date.now()
    if (now - lastRescueHintAt < RESCUE_HINT_COOLDOWN_MS) return
    lastRescueHintAt = now
    log.append(
      'warn',
      'overlay',
      `控制栏动作「${probe.label}」在 ${UNRESPONSIVE_MS}ms 内没有改变 ${probe.kind === 'mpv' ? 'mpv 属性 ' : '窗口状态 '}${probe.name}` +
        `（${String(before)} → ${String(after)}），判定为"点了没反应"，弹出 Esc/F 自救提示`
    )
    // 与「疑似点击击穿」共用同一个浮层（文案里已经写了 F / Esc 两条逃生路线）。
    // 走 `clickThroughCb` 这个**统一出口**（ipc.ts 把它接到 pushOverlayClickThrough），
    // 而不是自己直接推窗口：否则任何额外订阅者（自检、将来的埋点）都会漏掉这条提示 ——
    // 自检第一版就是这么漏的（提示回调一次都没触发，看起来像"侦测没生效"）。
    const payload = { count: 1, at: now }
    if (clickThroughCb) clickThroughCb(payload)
    else pushOverlayClickThrough(payload)
  }, UNRESPONSIVE_MS)
}

/** 自检用：当前是否有一个"待核实"的动作（null = 没有） */
export function effectWatchPending(): number {
  return effectWatchTimer ? effectWatchSeq : 0
}

/** 悬浮窗 → 播放页：控制栏动作 */
export function sendOverlayAction(action: Record<string, unknown>): void {
  /*
   * v0.3.9：动作计数 + 可选逐条日志。
   *
   * 为什么要计数：验证「按钮到底有没有接住点击」只能看**动作有没有到达主进程** ——
   * 日志里能看到 count 涨、type 变，就说明这一次真实点击穿过了窗口叠层。
   * 自检脚本（.e2e/verify-overlay-clickthrough.ps1）用真实光标点 6 个按钮 + 连点 20 次，
   * 就是数这个计数。平时不开这个环境变量，避免刷日志。
   */
  overlayActionCount++
  // V1.1：动作进来了就开始盯它有没有真的生效（见 noteControlAction 的说明）
  noteControlAction(action)
  if (process.env.SAKANA_OVERLAY_HIT_TEST) {
    console.log(
      `[overlay-hit] ACTION #${overlayActionCount} type=${String(action.type)} ` +
        `形状区域=${appliedRegions.length} 模式=${shapeSupported() ? 'ui-window-shape' : 'runtime-toggle'}`
    )
  }
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

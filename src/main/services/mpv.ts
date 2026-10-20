import { app, BrowserWindow, screen } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, cpSync, watchFile, unwatchFile } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { CH } from '@shared/channels'
import type { OverlayAction } from '@shared/api'
import type { DanmakuSettings } from '@shared/types'
import { anime4kChain } from '@shared/anime4k'
import { themePalette, resolveThemeId } from '@shared/themePalette'
import { buildUoscColorLine, renderUoscConf } from '@shared/uoscTheme'
import { BROWSER_UA, getSettings } from '../net'
import { danmakuApiBase } from './danmaku'
import { beginStage, failStageAndEnd, endFlow, flowDetail, flowRunning, pushStep, setMetrics, snapshot as flowSnapshot, succeedStage } from './playFlow'
import { HANDOFF_NO_BYTES_MS, handoffSnapshot, resetHandoff, shouldSwitchCandidate, takeNextCandidate } from './playHandoff'
import { markPlayTiming } from './playTiming'
import { getStreamBoostStatus } from './streamBoost'
import { noteControlAction, setOverlayPropReader } from './playerOverlay'
import { enableWindowInput, isWindowAlive, isWindowInputEnabled, winInputStatus } from './winInput'
import { log } from '../log'
import { store } from '../store'

/**
 * libmpv 播放内核（可选，与 libVLC 并列）
 *
 * - 原生绑定：native/mpv（N-API，动态加载 libmpv-2.dll）
 * - 画面输出：在 Electron 主窗口内创建 WS_CHILD 子窗口，用 mpv 的 wid 选项交给 libmpv，
 *   因此渲染层可以沿用与 libVLC 完全相同的布局（视频区域矩形由渲染层上报）
 * - 事件：状态轮询（250ms）后按与 libVLC 相同的事件协议推送给渲染层，
 *   渲染层无需区分引擎
 */

interface MpvBounds {
  x: number
  y: number
  width: number
  height: number
}

interface MpvState {
  ready: boolean
  time: number
  length: number
  paused: boolean
  idle: boolean
  eof: boolean
  volume: number
  mute: boolean
  /**
   * v1.5：本轮媒体**是否已经真的出过画面**（由 mpvGetState 补上，不是原生插件的字段）。
   *
   * 原生插件的 `state()` 不读 `width`，而"有没有画面"必须由 `videoWidth()` 这**一个来源**
   * 统一判定（见 mpvHasPicture 的说明）。所以这个字段在 mpvGetState 里合并进来，
   * 渲染层调 `player.getState()` 拿到的就是与弹幕/控制栏门控完全一致的读数，
   * 不会出现"状态里说在播、画面上什么都没有"两套说法。
   */
  hasPicture?: boolean
  /**
   * v1.1.4：uosc 桥接脚本的现场读数（版本/按钮清单/set-button 次数）。
   * 挂在 `mpvGetState()` 上而不是另开 API：自检与排障拿到的永远是与播放状态同一刻的快照，
   * 不会出现"状态是上一秒的、按钮清单是这一秒的"这种对不上的情况。
   */
  uosc?: UoscBridgeStats
}

interface MpvNative {
  load(dllPath: string): boolean
  create(opts: {
    x: number
    y: number
    width: number
    height: number
    parentHwnd?: Buffer | number
    options?: Record<string, string>
  }): boolean
  resize(b: { x: number; y: number; width: number; height: number }): boolean
  command(args: string[]): boolean
  setProperty(name: string, value: string | number | boolean): boolean
  getProperty(name: string): unknown
  state(): MpvState
  windows(): { parentChildren: string[]; childChildren: string[] }
  windowsOf(hwnd: Buffer | number): string[]
  raise(): boolean
  ensureAttached(): boolean
  setVisible(visible: boolean): boolean
  hitTest(x: number, y: number): {
    hitClass: string
    hitHwnd: number
    isOurChild: boolean
    hitRootIsOurs: boolean
    ourChildHwnd: number
    ourChain: string[]
    hitChain: string[]
    parentChain: string[]
  }
  reparentToRenderWidget(): boolean
  destroy(): boolean
  lastError(): string
}

let native: MpvNative | null = null
let attachedWin: BrowserWindow | null = null
let ready = false
let timeTimer: NodeJS.Timeout | null = null
let lastPlaying = false
let lastLength = 0
let lastEof = false
/** 上一次同步给渲染层的音量（v0.2.18：uosc 的音量滑杆直接改 mpv 属性，必须同步回来） */
let lastVolume = -1
/**
 * 上一次轮询时画面是否已经就绪（v0.3.9）。
 *
 * 「注入播放器」阶段的完成判据是「真的有画面」（见 startTimePump 里的说明），
 * 这个标志只用来把「第一次解出视频帧」那一刻变成一次 `succeedStage`，
 * 而不是每 250ms 都调一次。
 */
let lastHadPicture = false
let currentBounds: MpvBounds | null = null
/** 视频输出窗口是否可见（探针网页视图占用同一区域时置 false） */
let surfaceVisible = true
/**
 * B 站弹幕脚本在本个 mpv 实例里是否已经加载。
 * create() 在实例已存在时只更新尺寸，没有这个标记就会把同一个脚本加载多次。
 */
let biliScriptLoaded = false
let raiseTimer: NodeJS.Timeout | null = null
let paintHandler: (() => void) | null = null
let lastRaiseAt = 0
let paintCount = 0
let raiseCount = 0
/** 每次载入新媒体后，等首帧出现再挂一次视频窗口 */
let pendingReparent = false

/** 诊断：提升/paint 统计 */
export function mpvRaiseStats(): { paint: number; raise: number } {
  return { paint: paintCount, raise: raiseCount }
}

/**
 * 重新把视频输出窗口提到 z 序顶端。
 * Chromium 每次重绘都会把自己的窗口提到上层，因此必须反复提升
 * （与 electron-vlc-player 的 raiseNativeLayer 同思路：paint 事件 + 节流）。
 */
function raiseSurface(): void {
  if (!ready || !native || !attachedWin || attachedWin.isDestroyed() || !surfaceVisible) return
  const now = Date.now()
  if (now - lastRaiseAt < 100) return
  lastRaiseAt = now
  raiseCount++
  try {
    // ensureAttached 同时处理「Chromium 重建渲染窗口导致视频窗口被连带销毁」的自愈
    native.ensureAttached()
  } catch {
    /* ignore */
  }
}

function stopRaiseWatch(): void {
  if (raiseTimer) {
    clearInterval(raiseTimer)
    raiseTimer = null
  }
  if (paintHandler && attachedWin && !attachedWin.isDestroyed()) {
    try {
      attachedWin.webContents.removeListener('paint', paintHandler)
    } catch {
      /* ignore */
    }
  }
  paintHandler = null
}

function startRaiseWatch(win: BrowserWindow): void {
  stopRaiseWatch()
  paintHandler = (): void => {
    paintCount++
    raiseSurface()
  }
  try {
    // 页面每次重绘后尝试抢回顶层（离屏渲染下才触发，作为额外机会保留）
    win.webContents.on('paint', paintHandler)
  } catch {
    /* ignore */
  }
  // 主机制：定时自愈（重建/重挂 + 提升）
  raiseTimer = setInterval(raiseSurface, 400)
}

/* ─────────────── mpv 画面窗口的鼠标输入（v1.2.1 的致命回归修复） ─────────────── */

/**
 * mpv 用 `--wid` 嵌入时创建的 VO 子窗口的类名（见 mpv 源码 `video/out/w32_common.c`）。
 * 它是我们交给 mpv 的那个 `Static` 容器的子窗口；真实画面与 uosc 的 OSD 都画在它里面。
 */
const MPV_VO_WINDOW_CLASS = 'mpv'

/** mpv 的 VO 子窗口 HWND（0 = 还没创建/还没找到） */
let inputHwnd = 0
/** 这个 HWND 是否已经确认「可接收鼠标」（false 时每秒重试一次） */
let inputHwndEnabled = false
/** 上一次检查的时刻（内部节流；已启用后 5 秒复核一次，防窗口被重建） */
let inputCheckAt = 0
/** 上一次失败原因（同一条原因只写一次日志，避免 250ms 刷屏） */
let inputLastFailure = ''

/**
 * 从窗口树里找 mpv 的 VO 子窗口 HWND。
 *
 * 为什么复用 `native.windows()` 而不是再绑一个 `FindWindowExW`：
 * 这个诊断接口本来就在每次起播后由自检/排障调用，返回的信息里已经带了 `hwnd` 与 `class`
 * （见 native/mpv/src/addon.cc 的 EnumChildProc）。直接解析它，既不用扩大 koffi 的 API 白名单，
 * 也不会多一条「两边找窗口逻辑不一致」的分叉。
 *
 * ⚠️ 注意这些字符串**不是合法 JSON**：addon.cc 里是手写 `snprintf` 拼的，
 * `style`/`ex` 写成 `0x%llx`（十六进制字面量，JSON 不支持）——拿 `JSON.parse` 会整体抛错。
 * 所以这里只用正则取 `hwnd`（十进制）与 `class` 两个字段，别改成 JSON.parse。
 *
 * 找不到是**正常**的：mpv 的 VO 窗口要到真正开始出画时才创建（`force-window=no`），
 * 所以调用方必须允许「这一轮没找到、下一秒再找」。
 */
function findMpvVoWindowHwnd(): number {
  const n = native
  if (!n) return 0
  try {
    const dump = n.windows()
    for (const list of [dump.childChildren, dump.parentChildren]) {
      for (const raw of list ?? []) {
        const cls = /"class":"([^"]*)"/.exec(raw)?.[1]
        if (cls !== MPV_VO_WINDOW_CLASS) continue
        const h = Number(/"hwnd":(\d+)/.exec(raw)?.[1])
        if (Number.isFinite(h) && h > 0) return h
      }
    }
  } catch {
    /* 内核还没就绪/正在销毁：下一轮再试 */
  }
  return 0
}

/**
 * 保证 mpv 的 VO 子窗口处于「可接收鼠标」状态。
 *
 * ═══ 为什么必须做这件事（这一轮的根因）═══
 * mpv 在 `--wid` 嵌入模式下会**主动禁用**自己的 VO 窗口（`w32_common.c` 里
 * `if (w32->parent) EnableWindow(w32->window, 0);`），设计上是要宿主App负责输入。
 * 于是这个窗口带上了 `WS_DISABLED`（实测其样式为 0x58000000 = WS_CHILD|WS_VISIBLE|WS_DISABLED），
 * 而 Windows 的命中测试**会跳过 disabled 窗口**：视频区域上的真实鼠标全部落到我们创建的
 * 外层 `Static` 容器上（那个容器没有任何输入处理），点击就被它吞掉 ——
 * uosc 永远等不到 mouse-pos 与 MBTN_LEFT，表现就是「控制栏画得出来、每个按钮都没反应」。
 *
 * 以前按钮是应用自绘的 React 控件（在 Electron 悬浮窗里），点击根本不经过 mpv，
 * 所以这个断点一直存在却不显形；这一轮控制栏整体交给 uosc，它立刻变成致命问题。
 *
 * 反过来只要把窗口重新启用，Windows 就会把鼠标消息直接投递给 mpv 自己的 WndProc：
 *   · WM_MOUSEMOVE → mouse-pos → uosc 的 hover / 附近浮现
 *   · WM_LBUTTONDOWN/UP → MBTN_LEFT → 按钮、进度条拖动
 *   · WM_MOUSEWHEEL → WHEEL_UP/DOWN → 音量/快进
 *   · WM_MOUSELEAVE → hover=false → 控制栏自动隐藏
 * 全部走 mpv 原生路径，应用不需要转发任何鼠标事件，也不会引入 IPC 延迟。
 *
 * ⚠️ 配套改动：`mpvAttach` 里给 mpv 加了 `window-dragging=no`。窗口一旦可命中，
 * mpv 自带的「左键点画面拖动窗口」分支（`SendMessage(WM_NCLBUTTONDOWN, HTCAPTION)`）也会被激活，
 * 对嵌在 Electron 里的子窗口就是「点一下画面，视频子窗口被拖走」；关掉它之后该分支不执行，
 * 点击照常交给 uosc / input.conf。
 *
 * 失败时只记日志、绝不阻断播放：最坏情况回到修复前的状态（按钮点不动），不会更糟。
 */
function ensureMpvInputWindow(force = false): void {
  if (!ready || !native) return
  const now = Date.now()
  // 已启用：5 秒复核一次（VO 窗口可能被自愈逻辑重建）；未启用：每秒重试（等 VO 窗口出现）
  if (!force && now - inputCheckAt < (inputHwndEnabled ? 5000 : 1000)) return
  inputCheckAt = now

  /*
   * ═══ v1.5 需求 ④：没有画面时**不让 mpv 的画面窗口接收鼠标** ═══
   *
   * 这是"控制栏不能在没有画面时被呼出"这条在**主进程侧**的那一半，而且是最硬的一半：
   * uosc 的控制栏画在 mpv 的 VO 子窗口里，它之所以会"鼠标移到边缘就出现"，
   * 全靠 mpv 能收到 `mouse-pos`。而 mpv 用 `--wid` 嵌入时默认把这个子窗口设成 disabled
   * （见上面那一大段说明），是**我们**在起播后把它 EnableWindow 恢复成可命中的。
   * 所以只要在首帧出现前不恢复，Windows 的命中测试就跳过这个窗口，uosc 既收不到移动
   * 也收不到点击 —— 用户把鼠标怼到屏幕边缘也不会冒出控制栏。
   *
   * 为什么用 `mpvHasPicture()` 而不是 `playing`：见 mpvHasPicture 的说明 ——
   * playing 只代表"内核在拉流"，那时多半还是一片黑；这种状态下露出控制栏正是用户报的问题。
   *
   * 不碰 uosc 的任何配置/元素：这里改的是**我们自己的**「什么时候把鼠标还给 mpv」。
   * 首帧出现时会 `inputCheckAt = 0` 立刻走一遍本函数，把窗口恢复正常（见 startTimePump），
   * 之后的复核/自愈逻辑完全不变。
   *
   * 注意两点：
   *  · 一旦启用过（同一内核实例播过一集），换集加载阶段不会**重新禁用**旧窗口 ——
   *    koffi 只绑了 EnableWindow(TRUE)，没有反向调用，这是刻意的：
   *    宁可多一秒可点击，也不引入新的窗口状态（失败方向是"能点"而不是"点不动"）；
   *  · 但 mpv 每换一次媒体都会重建 VO 子窗口（见上面 findMpvVoWindowHwnd 的说明），
   *    新窗口默认又是 disabled，而这里在首帧前不会去恢复它 ——
   *    所以绝大多数换集场景仍然被门控。真机若看到换集加载段冒出控制栏，说明这版 mpv
   *    复用了同一个 VO 窗口，届时需要补一个"禁用窗口"的绑定（不能只靠 enable）。
   */
  if (!lastHadPicture) {
    return
  }

  if (inputHwnd > 0 && !isWindowAlive(inputHwnd)) {
    // 视频子窗口被重建：旧句柄作废，重新找（新窗口默认又是 disabled）
    inputHwnd = 0
    inputHwndEnabled = false
  }
  if (inputHwnd === 0) inputHwnd = findMpvVoWindowHwnd()
  if (inputHwnd === 0) return

  if (isWindowInputEnabled(inputHwnd)) {
    if (!inputHwndEnabled) {
      inputHwndEnabled = true
      inputLastFailure = ''
      log.append('info', 'mpv', `mpv 画面窗口已可接收鼠标（hwnd=0x${inputHwnd.toString(16)}）`)
    }
    return
  }

  const r = enableWindowInput(inputHwnd)
  if (r.enabled) {
    inputHwndEnabled = true
    inputLastFailure = ''
    log.append(
      'info',
      'mpv',
      `已启用 mpv 画面窗口的鼠标输入（hwnd=0x${inputHwnd.toString(16)}）：` +
        'uosc 的底部栏/角标按钮、进度条拖动与滚轮都依赖它；不启用时点击会落到外层 Static 容器被吞掉'
    )
    return
  }

  inputHwndEnabled = false
  if (r.reason !== inputLastFailure) {
    inputLastFailure = r.reason
    log.append('warn', 'mpv', `启用 mpv 画面窗口鼠标输入失败：${r.reason}（uosc 按钮会点不动）`)
  }
}

/**
 * 诊断/自检：mpv 画面窗口的输入状态（验证「uosc 能收到鼠标」的硬证据之一）。
 *
 * `enabled=true` 只说明窗口可命中；最终仍要以真实点击是否让 uosc 响应为准
 * （用户真机验证步骤见本次修复的报告）。
 */
export function mpvInputWindowState(): {
  hwnd: number
  hwndHex: string
  enabled: boolean
  backend: { available: boolean; reason: string }
} {
  return {
    hwnd: inputHwnd,
    hwndHex: inputHwnd > 0 ? `0x${inputHwnd.toString(16)}` : '',
    enabled: inputHwndEnabled,
    backend: winInputStatus()
  }
}


/**
 * 光标监听：与 libVLC 同理，画面渲染在独立原生子窗口里，
 * 鼠标在视频区域移动时渲染层收不到 mousemove（控制栏唤不出来）；
 * 主进程轮询系统光标位置，位置变化即通知渲染层。
 */
let cursorTimer: NodeJS.Timeout | null = null
let lastCursor: { x: number; y: number } | null = null

function startCursorWatch(win: BrowserWindow): void {
  stopCursorWatch()
  lastCursor = null
  cursorTimer = setInterval(() => {
    if (!ready || win.isDestroyed()) return
    try {
      const p = screen.getCursorScreenPoint()
      if (!lastCursor || lastCursor.x !== p.x || lastCursor.y !== p.y) {
        lastCursor = { x: p.x, y: p.y }
        sendEvent(win, { type: 'cursor' })
      }
    } catch {
      /* ignore */
    }
  }, 200)
}

function stopCursorWatch(): void {
  if (cursorTimer) {
    clearInterval(cursorTimer)
    cursorTimer = null
  }
  lastCursor = null
}

function nativeModulePath(): string | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'native', 'sakana_mpv.node'),
    join(app.getAppPath(), 'native', 'mpv', 'build', 'Release', 'sakana_mpv.node')
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

function dllPath(): string | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'libmpv', 'libmpv-2.dll'),
    join(app.getAppPath(), 'resources', 'libmpv', 'libmpv-2.dll')
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

/** libmpv 是否可用（原生插件 + 运行时都在） */
export function mpvAvailable(): boolean {
  return nativeModulePath() !== null && dllPath() !== null
}

/** 兼容 player:assets 探测：libmpv 运行时（DLL）是否就绪 */
export function mpvRuntimeAvailable(): boolean {
  return dllPath() !== null
}

function loadNative(): MpvNative | null {
  if (native && ready) return native
  const modPath = nativeModulePath()
  const dll = dllPath()
  if (!modPath || !dll) return null
  try {
    // 变量路径 require：交给运行时解析（打包后位于 resources/native）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modPath) as MpvNative
    if (!mod.load(dll)) {
      log.append('error', 'mpv', `libmpv 加载失败: ${mod.lastError()}`)
      return null
    }
    native = mod
    ready = true
    /*
     * V1.1：把「读一个 mpv 属性」的能力交给 playerOverlay 的"点了没反应"侦测用。
     *
     * 为什么要这么绕（而不是让 playerOverlay 直接 import 本文件）：两个模块都要被 ipc.ts 用，
     * 而 playerOverlay 在悬浮窗生命周期里到处被调用，反过来依赖"内核是否已加载"会把
     * 那条链变得很脆。这里注册一个函数即可：内核没加载时它压根不会被注册，
     * 侦测那边读不到值就不做判断（宁可漏报也不误报）。
     */
    setOverlayPropReader((name) => {
      // 只回传标量：mpv 的节点类属性（track-list 之类）转成对象后没法用于"变没变"的比较
      const v = native?.getProperty(name)
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null
    })
    log.append('info', 'mpv', `libmpv 已加载: ${String(mod.getProperty('mpv-version') ?? '未知版本')}`)
    return mod
  } catch (err) {
    log.append('error', 'mpv', `原生插件加载失败: ${String((err as { message?: string })?.message ?? err)}`)
    return null
  }
}

function sendEvent(win: BrowserWindow | null | undefined, payload: Record<string, unknown>): void {
  const t = String(payload.type ?? '')
  if (t in eventCounts) eventCounts[t as keyof typeof eventCounts]++
  // 窗口可能已销毁/从未挂载，判空后再发，避免未处理的 Promise 拒绝
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(CH.evPlayer, payload)
  }
}

/** 自检用：各类事件发出次数（用于验证「换集后必须重新发 playing」） */
const eventCounts = { playing: 0, paused: 0, time: 0, length: 0, ended: 0, picture: 0 }

export function mpvEventCounts(): typeof eventCounts {
  return { ...eventCounts }
}

export function mpvResetEventCounts(): void {
  eventCounts.playing = 0
  eventCounts.paused = 0
  eventCounts.time = 0
  eventCounts.length = 0
  eventCounts.ended = 0
  // v1.5：画面出现事件也一起计数/清零 —— 真机排查时"到底有没有发过 hasPicture=true"看它
  eventCounts.picture = 0
}

/** CSS 像素 → 物理像素（子窗口用物理像素定位） */
function toPhysical(win: BrowserWindow, b: MpvBounds): MpvBounds {
  let factor = 1
  try {
    factor = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1
  } catch {
    factor = 1
  }
  return {
    x: Math.round(b.x * factor),
    y: Math.round(b.y * factor),
    width: Math.max(1, Math.round(b.width * factor)),
    height: Math.max(1, Math.round(b.height * factor))
  }
}

/**
 * 当前视频宽度（px），没有画面时返回 0（v0.3.9）。
 *
 * 读的是 mpv 的 `width` 属性（等价于 `video-params/w`）：它在**解码器产出第一帧之后**
 * 才有值，因此是「真的有画面」而不是「地址交出去了」的判据。
 * 读不到（未 attach / 属性不存在）一并返回 0，调用方不需要区分。
 */
function videoWidth(): number {
  const n = native
  if (!n || !ready) return 0
  try {
    const v = Number(n.getProperty('width'))
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 0
  } catch {
    return 0
  }
}

/**
 * 「画面是否真的出来了」的**唯一判据**（v1.5 需求 ①）。
 *
 * 为什么要单独一个函数、并强调"唯一来源"：
 * 渲染层过去用 `time > 0` / `engineState === 'active'` 推断"有画面"，但那两个都不是画面 —
 * attach 成功只说明窗口挂上了，`playing` 只说明内核开始拉流；地址失效、CDN 卡住、
 * 解出音频却没解出画时，它们**全是 true**，屏幕上却什么都没有。
 * 这里复用一个已经在用的真实信号：mpv 的 `width`（= `video-params/w`），
 * 只有解码器真的产出视频帧之后它才 > 0（见 `videoWidth()` 与 startTimePump 里的成功判据）。
 *
 * 语义是**本轮媒体的 sticky 值**：一旦为 true，暂停 / 缓冲 / seek 都不会变回 false
 * （否则「一暂停控制栏和弹幕就消失」），只有下一次 loadfile（`loadSource` 里）
 * 或销毁内核时才复位。渲染层与主进程的所有门控都只读这一个值，
 * 不再各自用别的字段二次推断 —— 多来源最终一定会互相打架。
 */
export function mpvHasPicture(): boolean {
  return lastHadPicture
}

/** 读一个 mpv 字符串属性（容错：内核未就绪 / 属性不存在时返回空串） */
function mpvStringProp(name: string): string {
  const n = native
  if (!n || !ready) return ''
  try {
    const v = n.getProperty(name)
    return typeof v === 'string' ? v : v == null ? '' : String(v)
  } catch {
    return ''
  }
}

/**
 * 「有声音没画面」的现场状态（v0.3.9）。
 *
 * ## 为什么必须把它做成明确状态，而不是让用户描述
 *
 * 用户的描述是「把播放资源交给播放内核时卡住，听到了几秒声音但没有任何画面」。
 * 这句话里藏着**两个完全不同的故障**，而界面当时把它们显示成了同一个「进行中」：
 *   ① 内核解出了音频、但**视频轨没解出首帧**（画面宽度恒为 0）—— 这才是「没有画面」，
 *      判据是 mpv 的 `width` 属性；
 *   ② 视频其实解出来了（width > 0），只是**原生子窗口没显示/被盖住/尺寸不对** ——
 *      那属于窗口层，得看 `mpvDiagnostics()` + `mpvHitTest`（本文件与 ipc 的 surfaceDebug）。
 * 只写「等待首帧画面…」既分不清这两类，也让用户以为播放器死了。
 *
 * 所以这里只记**真实字段**：`ms`（连续有声无画的时长，现算，不做假进度）与
 * `videoTrack`（mpv 报的视频轨编码，空 = 这个流根本没有视频轨）。
 */
interface AudioOnlyState {
  /** 音频开始出声的时刻（mpv 的 time 在前进但没有画面）；0 = 当前不处于该状态 */
  since: number
  /** 已经连续多久有声无画（ms，现算） */
  ms: number
  /** mpv 报出的视频轨编码（空串 = 没有视频轨） */
  videoTrack: string
  /** 已经给过结论就不再重复刷阶段与日志 */
  concluded: boolean
}

const audioOnly: AudioOnlyState = { since: 0, ms: 0, videoTrack: '', concluded: false }

/**
 * 连续「有声无画」多久之后给用户一个明确结论。
 *
 * 15 秒的依据：正常站点首帧在 1~4 秒内就出来了（实测见 .e2e 的 play-flow 日志「注入播放器=4s/ok」），
 * 15 秒还没画面就基本可以断定不是"再等等就好"，而是真的缺东西。
 */
const AUDIO_ONLY_CONCLUDE_MS = 15000

function resetAudioOnly(): void {
  audioOnly.since = 0
  audioOnly.ms = 0
  audioOnly.videoTrack = ''
  audioOnly.concluded = false
}

/**
 * 每 250ms 由时间泵调用：维护「有声无画」状态，拖太久就给出**可读的结论**。
 *
 * 与工单的原则一致：不造假状态、不假装成功。画面真出来了就成功（上层 succeedStage），
 * 一直没出来就到点说清楚是「流里只有音频」还是「有视频轨但解不出画面」。
 */
function trackAudioOnly(playing: boolean, hasPicture: boolean, t: number): void {
  // 暂停 / 结束不算「有声无画」；但也不清结论，用户可能正看着那条结论
  if (!playing) return
  if (hasPicture) {
    if (audioOnly.since !== 0) {
      log.append('info', 'mpv', `画面已出现：音频先行了 ${(audioOnly.ms / 1000).toFixed(1)}s 才出首帧`)
    }
    resetAudioOnly()
    return
  }
  /*
   * 内核已经"在播"但音频时间还没往前走（还在建缓冲）：这也是「没有画面」，
   * 但原因不同（还没开始解码 vs 解出了音频没解出画面），说明文字必须区分开。
   */
  if (t <= 0) {
    if (flowRunning()) flowDetail('inject', '内核已开始拉流，正在等待首帧画面…')
    return
  }
  if (audioOnly.since === 0) {
    audioOnly.since = Date.now()
    audioOnly.videoTrack = mpvStringProp('video-codec')
    log.append(
      'warn',
      'mpv',
      `已开始解码音频但没有画面（音频时间 ${t.toFixed(1)}s，视频轨=${audioOnly.videoTrack || '（内核未报出）'}）`
    )
  }
  audioOnly.ms = Date.now() - audioOnly.since
  if (audioOnly.concluded || audioOnly.ms < AUDIO_ONLY_CONCLUDE_MS) {
    // 还没到点：把「现在到底缺什么」如实写进阶段说明，界面就会显示「有声无画 3.2s」
    if (flowRunning()) {
      flowDetail(
        'inject',
        `已开始解码音频，但画面还没出来（有声无画 ${(audioOnly.ms / 1000).toFixed(1)}s）` +
          (audioOnly.videoTrack ? `，视频轨 ${audioOnly.videoTrack}` : '，内核未报出视频轨')
      )
    }
    return
  }
  audioOnly.concluded = true
  const sec = (audioOnly.ms / 1000).toFixed(0)
  const why = audioOnly.videoTrack
    ? `内核已解出音频 ${sec} 秒，但视频轨（${audioOnly.videoTrack}）没有解出画面：可能是该编码的解码器不可用，或画面窗口没能显示`
    : `内核已解出音频 ${sec} 秒，但这个流里没有视频轨（只有音频）：站点给的地址很可能不是真正的画面流`
  log.append(
    'warn',
    'mpv',
    `有声无画结论：${why}｜画面窗口=${JSON.stringify(mpvDiagnosticBounds())} 内核=${JSON.stringify(mpvDiagnostics())}`
  )
  if (flowRunning()) {
    /*
     * 归因：没有视频轨 = 站点给的地址不对（该换源）；有视频轨但解不出来 = 编码/解码器问题。
     * 两者都不是「网络慢，再等等」，所以用 failStage 给结论，而不是让它一直转圈。
     *
     * v1.2.1：改成 failStageAndEnd —— 15 秒有声无画是**已经查清**的失败，
     * 只标红不收尾会让整轮一直 running，界面就停在「注入播放器」。
     */
    failStageAndEnd('inject', why, audioOnly.videoTrack ? 'format' : 'site')
  }
}

/*
 * ───────── 内核侧网络采样（v1.1，v1.2.1 收窄职责）─────────
 *
 * 修的是用户报的那条：「将播放地址交给播放器内核后经常出现没有加载速度的显示
 * （多少 MB、多少 B 的数据流量显示），仅仅是将播放地址交给播放器内核后就没了，
 * 也没有显示失败」。
 *
 * v1.2.1 起这里**只负责采样**，不再自己判失败：
 * 上一版在「playing + time=0 + 0 字节」持续 20s 时直接 failStage('inject')，
 * 而它和「有声无画 15s」「可达性探测」「注入超时」是四个各自独立的判据 ——
 * 谁先到点谁把阶段锁死（playFlow 的 settled），后到的真实首帧再也改不回来：
 * 用户看到的就是「所有规则都卡在最后一步：将资源注入播放器」。
 *
 * 现在唯一的注入判据是 playFlow 里 15s 的注入看门狗（beginStage('inject') 时武装），
 * 它拿的正是这里写进去的 `metrics`（已收字节/速率），所以失败文案仍然有真实证据，
 * 只是**只有一个主人**。这里保留采样是为了让面板上的速度/流量在内核接管后继续跳。
 */
let netBytes = 0
let netLastSampleAt = 0
let netLastRate = 0
let netLastPushAt = 0

/**
 * 「当前这个候选」的计量基线（v1.3 乐观交接）。
 *
 * `sampleNet` 采到的 `netBytes` 是**当前文件**的已预读字节（每次 loadfile 都要
 * `resetNetSampling`，否则换源后会停在旧值上，见 loadSource 里的说明）。
 * 这里保留一个显式基线，是为了让「这个候选收到多少字节」这件事有一个统一读数，
 * 将来如果改成多连接累计也不会把语义搞混。
 */
let candidateLoadedAt = 0
let candidateBytesBase = 0
/** 本轮是否已经把「加速中转」换上去过（同一轮只换一次，避免来回切流） */
let boostSwapped = false

/** 每次 loadfile（mpvPlay）重置采样基线：换集不能把上一集的流量算进这一集 */
function resetNetSampling(): void {
  netBytes = 0
  netLastSampleAt = 0
  netLastRate = 0
  netLastPushAt = 0
}

/** 当前候选从装载到现在收到的字节数（内核自己报的流字节，不含响应头） */
function bytesSinceCandidate(): number {
  return Math.max(0, netBytes - candidateBytesBase)
}

/**
 * 采一次内核网络读数并写进播放流程的指标。
 * @param playing 内核是否在播（pump 里算出来的那个判据）
 * @param time    内核当前 time-pos（毫秒）
 */
function sampleNet(playing: boolean, time: number): void {
  const now = Date.now()
  const stats = mpvNetStats()
  if (!stats) return
  const dt = netLastSampleAt > 0 ? (now - netLastSampleAt) / 1000 : 0
  netLastSampleAt = now
  if (stats.forwardBytes > 0) {
    // 内核自己报的已预读字节：直接用它（单调递增，不需要我们积分）
    netBytes = Math.max(netBytes, stats.forwardBytes)
  } else if (dt > 0 && stats.rateBps > 0) {
    // 只有速率：按「速率 × 实际间隔」积分。标注清楚这是估算而不是内核计数
    netBytes += stats.rateBps * dt
  }
  if (stats.rateBps > 0) netLastRate = stats.rateBps
  if (!flowRunning()) return
  if (now - netLastPushAt >= 1000) {
    netLastPushAt = now
    setMetrics({
      bytes: Math.round(netBytes),
      rateBps: Math.round(netLastRate),
      source: 'engine'
    })
  }
  /*
   * 只是在**注入超时之前**把现场如实写进阶段说明（不是失败判定）：
   * 用户能在进度面板上看到「已收 X KB / 进度 0s」，而不是一句干巴巴的「等待首帧」。
   * 失败（以及失败原因）由 playFlow 的 15s 看门狗统一给出。
   */
  if (playing && time <= 0) {
    flowDetail(
      'inject',
      `内核已接收地址，正在等数据（已收 ${Math.round(netBytes / 1024)} KB，进度 0s）`
    )
  }
}

function startTimePump(win: BrowserWindow): void {  stopTimePump()
  timeTimer = setInterval(() => {
    if (!ready || !native || !attachedWin || attachedWin.isDestroyed()) return
    try {
      const st = native.state()
      /*
       * v0.2.9：弹幕插件的注入必须「文件已载入」之后，且每换一次文件都要重来一遍。
       *
       * 实测踩到的坑：缓存命中时弹幕 3ms 就回来了，而这时 mpv 还**没有 path**
       * （loadfile 是异步的）。此时把弹幕交给插件，插件会在
       * `add_source_to_history` 里写 `history[nil]` → Lua error → mpv 直接**终止该脚本**，
       * 之后所有 `script-message-to uosc_danmaku` 都变成 "Can't find script"，
       * 表现就是「第一次说成功、之后全是拒绝、画面上一辈子没有弹幕」。
       *
       * 所以这里按 path 幂等补发：path 一变就清标记，然后只要「应用侧最新给的弹幕」
       * 还没注入到当前 path，就注入一次 —— 不论弹幕先到还是流先到，最终都会对上。
       */
      const curPath = mpvCurrentPath()
      if (curPath !== lastMpvPath) {
        lastMpvPath = curPath
        injectedForPath = ''
        injectAttempts = 0
      }
      if (curPath && latestPluginDanmakuFile && injectedForPath !== curPath) {
        /*
         * v1.5 需求 ②：**画面还没出现时先不把弹幕交给插件**。
         *
         * 判据是 `mpvHasPicture()`（唯一来源：内核 `width`>0 的首帧判据，见 videoWidth 的说明）。
         * 为什么必须门控在这里而不是渲染层：弹幕是由 mpv 内部的 uosc_danmaku 画在视频画面上的，
         * 渲染层根本管不到它 —— 唯一能拦住它的地方就是「不向它注入弹幕」。
         * 首帧出现后这一支自然成立，排队中的那份弹幕会在同一秒内补发，
         * 所以用户看到的仍然是「画面出来就有弹幕」，不会丢。
         */
        if (!mpvHasPicture()) {
          if (danmakuWaitLoggedPath !== curPath) {
            danmakuWaitLoggedPath = curPath
            log.append(
              'info',
              'mpv',
              '画面还没出现（hasPicture=false）：弹幕先不注入 uosc_danmaku，等内核解出首帧后自动补发'
            )
          }
        } else if (injectAttempts < 3 && Date.now() - lastInjectAttemptAt > 2000) {
          // 失败时不要每 250ms 刷一次日志：同一文件最多重试 3 次、每次间隔 2 秒
          lastInjectAttemptAt = Date.now()
          injectAttempts += 1
          injectPluginDanmaku(latestPluginDanmakuFile)
        }
      }
      /*
       * 「是否在播」必须按媒体状态判定，不能按 paused 的边沿判定：
       * mpv 在 idle（未载入任何媒体）时 paused 同样是 false，
       * 因此换集/换流时 paused 不会变化，边沿触发就永远不再发 playing，
       * 渲染层会一直以为没开播（8 秒后误切 FFmpeg 中转 → 画面被顶掉）。
       * 这里以「已载入媒体且未暂停未结束」为准，配合 mpvPlay 重置 lastPlaying，
       * 保证每次新媒体的开播都会发一次事件，与 libVLC 的 playing 事件语义一致。
       */
      const playing = st.ready && !st.idle && !st.eof && !st.paused
      if (playing !== lastPlaying) {
        lastPlaying = playing
        sendEvent(win, { type: playing ? 'playing' : 'paused', playing })
      }
      /*
       * 首帧后立即提升一次：mpv 的视频输出窗口是在首帧/视频输出初始化时才创建的，
       * 此刻重新 SetWindowPos(HWND_TOP) 能保证它一出现就在页面之上。
       * （缺失这一步的 0.1.6 版实测为「有声音、黑屏」，已复现。）
       */
      if (playing && pendingReparent) {
        pendingReparent = false
        const settle = (): void => {
          try {
            // 备选方案（诊断用）：把视频窗口挂进页面渲染窗口内部
            if (process.env.SAKANA_MPV_PARENT_WIDGET) native?.reparentToRenderWidget()
            native?.ensureAttached()
          } catch {
            /* ignore */
          }
        }
        settle()
        setTimeout(settle, 300)
        setTimeout(settle, 1500)
      }
      /*
       * v1.2.1：uosc 的按钮要能点，前提是 mpv 的 VO 子窗口可命中。
       * 挂在同一个 250ms 泵上（内部按「未启用 1s / 已启用 5s」节流），不新增定时器；
       * VO 窗口要等起播才创建，所以这里必须允许「这轮没找到、下轮再找」。
       */
      ensureMpvInputWindow()
      if (st.length > 0 && Math.abs(st.length - lastLength) > 500) {
        lastLength = st.length
        sendEvent(win, { type: 'length', length: st.length })
      }
      if (st.eof && !lastEof) {
        lastEof = true
        sendEvent(win, { type: 'ended' })
      }
      if (!st.eof) lastEof = false
      if (playing) sendEvent(win, { type: 'time', time: st.time, length: st.length, playing: true })
      /*
       * 「注入播放器」阶段什么时候算完成（v0.3.9）。
       *
       * 判据用 **mpv 的 `width` 属性 > 0**：它来自 `video-params`，
       * 只有解码器真的解出了视频帧才会有值 —— 这正好对应用户要的
       * 「等到真的有画面/首帧」，而不是「loadfile 返回成功」（那只是把地址交出去了：
       * 地址失效 / CDN 慢的时候 loadfile 一样成功，但一辈子不会有画面）。
       * 每 250ms 只读一个属性，开销可忽略；一旦确认就置位到下一次 mpvPlay。
       */
      const picW = videoWidth()
      const hasPicture = playing && picW > 0
      /*
       * v0.3.9：先跑「有声无画」跟踪，再写成功/等待说明。
       *
       * 顺序有讲究（自检里实测踩到）：如果先写那句通用的「正在等待首帧画面…」，
       * 那么到点给出结论的那一帧，阶段说明会被这句通用文案覆盖掉 ——
       * 结论本身（summary）是对的，但详情面板上少了「有声无画 Ns」这个最关键的现场。
       */
      trackAudioOnly(playing, hasPicture, st.time ?? 0)
      // 内核侧速度/流量/失败判据（v1.1，见 sampleNet 的说明）：挂在同一个泵上，1 秒节流写指标
      sampleNet(playing, st.time ?? 0)
      /*
       * v1.3 乐观交接的执行端：当前候选 5 秒一个字节都没收到 → 换交接队列里的下一个。
       *
       * 为什么挂在 250ms 的状态泵上而不是另开定时器：`sampleNet` 刚把内核真实流量读出来，
       * 这一刻的 `netBytes` 才是做判据的最新值；另开定时器会多一层相位差，
       * 而且退出播放器时还得再管一个定时器的生命周期（历史上就是这类定时器漏清理）。
       * 已经出首帧（`hasPicture` / `lastHadPicture`）时绝不换：不能让正在看的画面回 0。
       */
      if (!hasPicture && !lastHadPicture && candidateLoadedAt > 0 && flowRunning()) {
        if (
          shouldSwitchCandidate({
            elapsedMs: Date.now() - candidateLoadedAt,
            bytesSinceCandidate: bytesSinceCandidate()
          })
        ) {
          const switched = mpvSwitchToNextCandidate()
          if (switched) sendEvent(win, { type: 'source', url: switched.url })
        }
      }
      if (hasPicture && !lastHadPicture) {
        lastHadPicture = true
        /*
         * v1.5 需求 ①：**画面出现的唯一通知**。
         *
         * 渲染层靠这一条解除弹幕层与控制栏的门控；这里只发 `hasPicture` 一个字段，
         * 不再让渲染层用 time/playing 自行推断（那些在"有声音没画面"时同样是 true）。
         * 反向（true→false）由 loadSource 在换媒体时发，见那里的说明。
         */
        sendEvent(win, { type: 'picture', hasPicture: true })
        /*
         * 首帧也是「mpv 画面窗口该恢复鼠标」的时刻（见 ensureMpvInputWindow 的门控）：
         * 把节流时间清零，让下一次 250ms 泵立刻找窗口并启用，尽量缩短
         * 「画面已经出来、但点了没反应」的那一段。
         */
        inputCheckAt = 0
        log.append(
          'info',
          'mpv',
          `画面已出现（hasPicture=true，视频宽 ${picW}px）：现在才恢复弹幕注入与控制栏鼠标输入`
        )
        // 计时：loadfile → 首帧（真实解码出第一帧的时刻，不是 loadfile 返回）
        markPlayTiming('首帧')
        succeedStage('inject', `画面已就绪（首帧已解码，视频宽 ${picW}px）`)
        /*
         * 首帧出现 = 整轮播放流程达成（v0.3.9）。
         * 在这里收尾而不是在 `playing` 事件上：`playing` 只说明内核开始拉流，
         * 地址失效/CDN 慢的时候它一样会先变 playing，但永远不会有画面。
         */
        endFlow({ ok: true, summary: `已开始播放（三阶段完成，画面 ${picW}px）` })
        /*
         * v0.3.9：首帧出现这一刻**再提升一次**原生子窗口。
         *
         * 为什么不能只靠 400ms 的定时提升：mpv 的视频输出窗口是在视频轨初始化时才真正
         * 开始出画（`mpv` 那个子窗口这时才有内容），而 Chromium 的合成层在这前后随时可能
         * 把页面提到上层。首帧是「画面必须可见」的唯一时刻，这里补一次成本极低
         * （SetWindowPos + 一次重绘），却能把「有声音没画面」里属于窗口层的那一类直接消掉。
         */
        lastRaiseAt = 0
        raiseSurface()
      }
      /*
       * 注意这里**没有** else 分支再去写「等待首帧画面…」：
       * 「有画面之前的说明文字」只有一个主人 —— 上面的 trackAudioOnly，
       * 否则两处会互相覆盖（自检里实测到过：到点给结论的那一帧被通用文案盖掉）。
       */
      /*
       * v0.2.18：音量同步。uosc 的竖排音量滑杆直接改 mpv 的 volume 属性
       * （不经过应用的 IPC），不同步的话渲染层那份 playerVolume 会一直是旧值 ——
       * 表现就是「鼠标拖过音量之后再按 ↑ 键，音量突然跳回拖之前的档位」。
       * 只在变化超过 0.5 时发，避免浮点抖动刷屏。
       */
      if (Math.abs((st.volume ?? 0) - lastVolume) >= 0.5) {
        lastVolume = st.volume ?? 0
        sendEvent(win, { type: 'volume', volume: lastVolume })
      }
      /*
       * v0.2.18：uosc 控制栏的动作回传（按钮/菜单项/快捷键）。
       * 挂在同一个 250ms 泵上：读一个字符串属性，开销可以忽略；
       * 只有桥接脚本挂上了才读（见 pollUoscCtrl）。
       */
      pollUoscCtrl(win)
      /*
       * v1.1.4：控制栏「播放状态」菜单的数据源。
       * 挂在同一个 250ms 泵上，但内部节流到 1 秒 —— 缓冲/速度/丢帧本来就是秒级变化；
       * 只在 uosc 与桥接脚本都挂上时推，避免给不存在监听者的 script-message 白花钱。
       */
      if (uoscBarLoaded && uoscCtrlLoaded) mpvPushUoscStatus()
    } catch {
      /* ignore */
    }
  }, 250)
}

function stopTimePump(): void {
  if (timeTimer) {
    clearInterval(timeTimer)
    timeTimer = null
  }
}

/** 传给 mpv 的路径统一用正斜杠（避免选项值的反斜杠转义问题；Windows 上等价） */
function slashPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * B 站弹幕脚本配置（v0.2.8 附加七）：mpv 选项 + 需要用 load-script 加载的脚本路径。
 *
 * 管线：yt-dlp 抓 danmaku 字幕 → biliass 转 ASS → `sub-add` 给 mpv。
 *
 * ⚠️ 这里**只返回 `script-opts`，不返回 `script`**：libmpv 不接受 `script` 选项，
 * 脚本必须由 `mpvAttach()` 用运行时的 `load-script` 命令加载（那边有详细说明）。
 * （老注释曾写「必须显式给 load-scripts=yes」——恰恰相反：`load-scripts` 现在是 `no`，
 *   为的是不让 mpv 自动扫描 `<config-dir>/scripts/` 把 uosc 加载两份。）
 * `script-opts` 里带上 ytdlp / biliass / tmpdir —— 其中 tmpdir 是必须的：
 * biliass 在 Windows 上需要一个可写的临时目录，否则弹幕下载会失败。
 *
 * 未启用时返回空选项（不加载任何脚本，行为与之前完全一致）。
 */
function biliDanmakuConfig(): { options: Record<string, string>; scriptPath: string } {
  const cfg = getSettings().biliDanmaku
  if (!cfg?.enabled) return { options: {}, scriptPath: '' }
  const script = slashPath((cfg.scriptPath ?? '').trim() || bundledBiliScript())
  if (!script) {
    log.append('warn', 'mpv', '启用了 B 站弹幕但找不到脚本文件（内置脚本缺失且未指定自定义脚本）')
    return { options: {}, scriptPath: '' }
  }
  const tmpdir = (cfg.tmpdir ?? '').trim() || defaultBiliTmpdir()
  try {
    mkdirSync(tmpdir, { recursive: true })
  } catch {
    /* 目录不可写时脚本会记日志说明 */
  }
  /*
   * 全部用正斜杠：mpv 的选项值是**带转义解析**的字符串，
   * Windows 反斜杠路径经 `mpv_set_option_string` 有被吃掉的风险（config 里也建议这样写），
   * 而正斜杠在 Windows 上完全等价。脚本内部再自行拼路径。
   */
  const slash = slashPath
  const scriptOpts = [
    `enabled=yes`,
    `ytdlp=${slash((cfg.ytdlpPath ?? '').trim() || 'yt-dlp')}`,
    `biliass=${slash((cfg.biliassPath ?? '').trim() || 'biliass')}`,
    `tmpdir=${slash(tmpdir)}`,
    `log=${slash(join(tmpdir, 'sakana-bdanmaku.log'))}`
  ].join(',')
  log.append('info', 'mpv', `B 站弹幕脚本已启用：${script}（tmpdir=${tmpdir}）`)
  /*
   * ⚠️ v0.2.18：这里**故意不再带 `load-scripts=yes`**。
   *
   * 它过去是多余的（libmpv 里脚本一律用运行时命令 `load-script` 按路径加载，
   * 而 `load-scripts` 只管「要不要自动扫描 <config-dir>/scripts/」），
   * 过去因为 `config=no` 连配置目录都不认，所以它一直是个空操作。
   * 现在 uosc 控制栏要求 `config=yes`（否则读不到 uosc.conf / input.conf），
   * 一旦此时还留着 `load-scripts=yes`，mpv 会在初始化时自动加载
   * `<config-dir>/scripts/uosc` 与 `uosc_danmaku`，我们再显式 load-script 一次
   * 就会得到**两份 uosc**（两套控制栏）与两份弹幕插件 —— 探针实测过这个坑。
   * 所以脚本加载顺序完全由 mpvAttach 掌握：shim → uosc_danmaku → uosc。
   *
   * 另外注意：`script` 选项同样不能用（实测 mpv_set_option_string(mpv,'script',…) 静默失败），
   * 所以真正的加载都在 mpvAttach 里用运行时命令做。
   */
  return { options: { 'script-opts': scriptOpts }, scriptPath: script }
}

/** 内置的 B 站弹幕脚本路径（打包后在 resources/mpv-scripts 下） */
export function bundledBiliScript(): string {
  return bundledScript('sakana-bdanmaku.lua')
}

/**
 * 内置的 uosc 控制栏桥接脚本（v0.2.18）。
 *
 * 它与 B 站弹幕脚本放在同一个目录（resources/mpv-scripts），
 * 会被 electron-builder 原样复制到安装目录的 `resources/mpv-scripts`。
 */
export function bundledUoscCtrlScript(): string {
  return bundledScript('sakana-uosc-ctrl.lua')
}

/** 在「打包后的 resources/mpv-scripts」与「开发态仓库 resources/mpv-scripts」里找一个脚本 */
function bundledScript(name: string): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'mpv-scripts', name),
    join(app.getAppPath(), '..', 'mpv-scripts', name),
    join(app.getAppPath(), 'resources', 'mpv-scripts', name)
  ]
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return ''
}

/**
 * thumbfast 用的**独立 mpv 可执行文件**路径（不存在时返回空串）。
 *
 * 为什么必须单独带一个 mpv.exe：
 *   我们的播放器是**内嵌 libmpv**（native/mpv + resources/libmpv/libmpv-2.dll），
 *   整个进程里没有独立的 mpv 可执行文件；而 thumbfast 生成缩略图的方式就是
 *   `spawn` 一个新的 mpv 进程去截帧（见 resources/mpv-scripts/thumbfast.lua 的 spawn()）。
 *   PATH 上没有 mpv 时它只会打印 "mpv subprocess create failed"，
 *   进度条悬停就永远没有缩略图 —— 修法只能是给它一个真实的 exe。
 *
 * 为什么按这两条路径找、不硬编码：
 *   与 bundledScript / bundledMpvConfigDir 同一条思路 —— 打包后资源在
 *   `<process.resourcesPath>`，开发态在仓库的 `resources/`：
 *   · 打包态：`<安装目录>/resources/mpv-bin/mpv.exe`
 *     （package.json 的 `build.extraResources` 把 resources/mpv-bin 复制成 mpv-bin）
 *   · 开发态：`<仓库>/resources/mpv-bin/mpv.exe`
 *   这样换机器、换安装目录都不用改代码。
 */
export function bundledMpvExe(): string {
  /*
   * V1.2.6：优先用 **纯 ASCII 路径下的副本**。
   *
   * 为什么（真机证据）：开发环境 `E:/sakana.app/resources/mpv-bin/mpv.exe` 能出图
   * （实测生成 141,000 字节的缩略图），而安装到 `D:/动画应用/…` 之后 thumbfast
   * **一次都没启动过子进程**（连它自己的 `thumbfast-status.json` 都没写出来，日志里一行都没有）。
   * 两者最大的差别就是路径里有中文：`thumbfast.lua` 把 `mpv_path` 当字节串读出来再交给
   * Windows 的进程创建 API，非 UTF-8 代码页下会被错误解码，spawn 失败且**不抛错**。
   *
   * 所以启动时把 exe 复制到 `%LOCALAPPDATA%/Sakana/mpv-bin/mpv.exe`（纯 ASCII、无空格、无中文），
   * 让 thumbfast 永远拿到一条安全的路径 —— 不管用户把应用装到哪。
   */
  const safe = asciiMpvExe();
  if (safe) return safe
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'mpv-bin', 'mpv.exe') : '',
    join(app.getAppPath(), 'resources', 'mpv-bin', 'mpv.exe')
  ]
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return ''
}

/** 本次进程内缓存的安全副本路径（避免每次调用都 stat） */
let asciiMpvExeCache: string | null = null

/**
 * 把随包的 mpv.exe 复制到 `%LOCALAPPDATA%/Sakana/mpv-bin/` 并返回那条路径。
 *
 * 失败（磁盘满 / 权限不足）时返回空串，调用方自动退回随包路径 —— 宁可维持现状，
 * 也不能因为"复制失败"让 thumbfast 完全不可用。
 * 复制是同步的（121MB 约 1~2 秒），只在**文件不存在或大小不一致**时做一次，
 * 之后每次启动都只是两次 stat。
 */
function asciiMpvExe(): string {
  if (asciiMpvExeCache !== null) return asciiMpvExeCache
  const src = [process.resourcesPath ? join(process.resourcesPath, 'mpv-bin', 'mpv.exe') : '', join(app.getAppPath(), 'resources', 'mpv-bin', 'mpv.exe')]
    .find((p) => p && existsSync(p)) ?? ''
  if (!src) {
    asciiMpvExeCache = ''
    return ''
  }
  try {
    /*
     * ⚠️ 目标目录必须是**纯 ASCII**，否则这次复制毫无意义。
     * 一开始我用了 `app.getPath('userData')`，但本机它是 `D:/动画应用/sakana/sakana.data/Sakana`
     * —— 还是有中文；而 `%LOCALAPPDATA%` 在本机是 `C:/Users/RE妄想症/...`，用户名也带中文。
     * 所以优先放 `C:/ProgramData/Sakana/mpv-bin`（系统级目录，路径天然 ASCII）；
     * 写不进去（权限受限）再退回 userData —— 那种情况下至少不比改之前更差。
     */
    const dirs = [join(process.env.ProgramData || 'C:\\ProgramData', 'Sakana', 'mpv-bin'), join(app.getPath('userData'), 'mpv-bin')]
    let dir = dirs[0]
    let dst = join(dir, 'mpv.exe')
    const usable = (d: string): boolean => {
      try {
        mkdirSync(d, { recursive: true })
        return true
      } catch {
        return false
      }
    }
    if (!usable(dir) && dirs[1]) {
      dir = dirs[1]
      dst = join(dir, 'mpv.exe')
      if (!usable(dir)) throw new Error('ProgramData 与 userData 都不可写')
    }
    // 已经存在且大小一致 → 直接用（换版本时大小几乎一定不同，足够当校验）
    if (existsSync(dst) && statSync(dst).size === statSync(src).size) {
      asciiMpvExeCache = dst
      return dst
    }
    mkdirSync(dir, { recursive: true })
    cpSync(src, dst, { force: true })
    log.append('info', 'mpv', `已把 mpv.exe 复制到纯 ASCII 路径供 thumbfast 使用：${slashPath(dst)}`)
    asciiMpvExeCache = dst
    return dst
  } catch (err) {
    log.append(
      'warn',
      'mpv',
      `复制 mpv.exe 失败，thumbfast 退回随包路径（中文路径可能导致它起不来）：${String((err as Error)?.message ?? err).slice(0, 80)}`
    )
    asciiMpvExeCache = ''
    return ''
  }
}

/** 上一次已经写进日志的路径（同一条路径只写一次；文件后来出现/消失时会重新记一行） */
let thumbfastMpvLoggedPath: string | null = null

/**
 * 缩略图输出前缀（纯 ASCII）。
 *
 * 见 thumbfast.conf 里 `thumbnail=` 的注释：真机上默认落在 `%TEMP%`，而本机
 * `%TEMP%` 里带中文用户名，thumbfast 把它交给子进程当 `--of` 时被写坏，
 * 结果就是"有请求、无内容"的白窗。这里固定成 `C:/ProgramData/Sakana/thumb/t`
 * （与 mpv.exe 副本同目录树），确保整条链路只有 ASCII。
 */
function thumbOutputBase(): string {
  const base = join(process.env.ProgramData || 'C:\\ProgramData', 'Sakana', 'thumb')
  try {
    mkdirSync(base, { recursive: true })
  } catch {
    /* 建不了目录就让 thumbfast 用默认路径，至少不比现在更差 */
    return join(app.getPath('temp'), 'thumbfast.out')
  }
  return join(base, 't')
}

/**
 * 主进程启动时确认「thumbfast 到底会 spawn 哪个 mpv」，并把结果写进日志。
 *
 * 为什么要单独一行、且由启动流程调用：
 *   真机排查 thumbfast 时，唯一能区分「没带 exe / 带错路径 / 路径对但文件坏了」的证据
 *   就是它实际拿到的路径。放在启动时而不是第一次悬停进度条时，是因为失败发生在
 *   thumbfast 的异步子进程回调里（只会打印 "subprocess create failed"），
 *   到那时再回头找「它想用哪个 exe」已经被埋掉了。
 *
 * 为什么找不到时不加载 thumbfast（见 loadUoscPlugins）：
 *   thumbfast 自己会在 mpv 画面里 show-text 一条 "ERROR! cannot create mpv subprocess"，
 *   对用户来说就是“播放器莫名弹错”。缺文件时我们宁可不要缩略图，也不弹这条错误。
 */
export function logThumbfastMpv(): string {
  const exe = bundledMpvExe()
  if (thumbfastMpvLoggedPath === exe) return exe
  thumbfastMpvLoggedPath = exe
  if (exe) {
    /*
     * 正斜杠：这个值最终会原样进 thumbfast.conf 的 mpv_path（mpv 在 Windows 上也接受正斜杠，
     * 且不会被当成转义），日志用同一种写法便于直接对照配置文件。
     */
    log.append('info', 'mpv', `thumbfast 使用的 mpv：${slashPath(exe)}`)
    /*
     * V1.2.6：**启动自检** —— 真的把这个 exe 跑一次，把退出码写进日志。
     *
     * 为什么必须做：中文路径那条假设已经被证伪（改成 C:/ProgramData 纯 ASCII 之后
     * 仍然没有 `[thumbfast] 缩略图已生成`）。现在需要一刀切开两种可能：
     *   · 自检失败 → 是我们的 exe 起不来（权限 / 杀软拦截 / 依赖缺失）；
     *   · 自检成功 → exe 没问题，问题在 thumbfast.lua 与 uosc 之间（它俩都不写我们的日志）。
     * 自检只跑 `--version`，几百毫秒，且只在路径变化时跑一次。
     */
    try {
      const r = spawnSync(exe, ['--version'], { timeout: 8000, windowsHide: true, encoding: 'utf-8' })
      const ok = r.status === 0
      log.append(
        ok ? 'info' : 'warn',
        'mpv',
        ok
          ? `thumbfast 自检通过（mpv.exe 可执行，退出码 0）：${slashPath(exe)}`
          : `thumbfast 自检失败：退出码 ${String(r.status)}，错误 ${String(r.error?.message ?? r.stderr ?? '').slice(0, 80)}`
      )
    } catch (err) {
      log.append('warn', 'mpv', `thumbfast 自检异常：${String((err as Error)?.message ?? err).slice(0, 80)}`)
    }
  } else {
    log.append(
      'warn',
      'mpv',
      'thumbfast 使用的 mpv 不存在（应为 resources/mpv-bin/mpv.exe）：' +
        '进度条悬停缩略图不可用；本次跳过 thumbfast，避免它在画面里弹出 “cannot create mpv subprocess”'
    )
  }
  return exe
}

/** B 站弹幕脚本的默认临时目录（用户没填时用它；biliass 必须有一个可写 tmpdir） */
export function defaultBiliTmpdir(): string {
  return join(app.getPath('userData'), 'tmp', 'danmaku')
}

/**
 * 告知 mpv 脚本「当前播放页地址」（v0.2.8 附加七）。
 *
 * 脚本据此判断是不是 B 站链接、并交给 yt-dlp 去取弹幕；
 * 我们播放的是**直链**，脚本自己无法反推页面，所以必须由宿主告知。
 */
export function mpvSetDanmakuSource(pageUrl: string): void {
  if (!ready || !native || !pageUrl) return
  try {
    native.command(['script-message', 'sakana-source', pageUrl])
    log.append('info', 'mpv', `已告知弹幕脚本播放页地址: ${pageUrl.slice(0, 110)}`)
  } catch (err) {
    log.append('warn', 'mpv', `告知弹幕脚本失败: ${String((err as Error)?.message ?? err)}`)
  }
}

/* ─────────────────── uosc 控制栏 + uosc_danmaku（v0.2.9 / v0.2.18） ─────────────────── */

/**
 * 内置 mpv 插件目录（uosc + uosc_danmaku）。
 *
 * v0.2.18 更正了一处旧结论：以前这里写着「设了 config-dir 也读不到
 * `<config-dir>/script-opts/*.conf`」——那其实不是 config-dir 的问题，而是
 * **libmpv 默认 `config=no`**（native/mpv/src/addon.cc 也显式设过它），
 * 此时 `mp.find_config_file()` 一律返回 nil（无窗口探针实测：
 * `find_config_file('script-opts/uosc.conf')` → nil）。
 * 现在 mpvAttach 里显式给了 `config=yes`，uosc 启动日志会打印
 * `[uosc] Opened config file script-opts/uosc.conf.`，布局与快捷键都按文件生效。
 *
 * 另外两个仍然成立、必须记住的点：
 * 1. `<config-dir>/scripts/*` 是否自动加载由 `load-scripts` 决定，libmpv 下默认是 **yes**
 *    （探针实测），所以必须显式给 `load-scripts=no`，否则脚本会被加载两份；
 * 2. 插件依旧用运行时 `load-script` 挂载 —— 这样加载顺序完全可控
 *    （uosc_danmaku 必须先于 uosc，见 loadUoscPlugins 的注释）。
 * `config-dir` 还负责另一件事：uosc 的图标字体从 `<config-dir>/fonts` 取。
 */
export function bundledMpvConfigDir(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'mpv-config'),
    join(app.getAppPath(), 'resources', 'mpv-config')
  ]
  for (const p of candidates) {
    try {
      if (p && existsSync(join(p, 'scripts', 'uosc', 'main.lua'))) return p
    } catch {
      /* ignore */
    }
  }
  return ''
}

/** 内置 uosc 插件是否可用（打包时带了 resources/mpv-config） */
export function uoscPluginAvailable(): boolean {
  return bundledMpvConfigDir() !== ''
}

/** 弹幕插件模式是否生效：用户在设置里选了 uosc 渲染，且内置插件存在 */
export function uoscDanmakuRequested(): boolean {
  return getSettings().danmaku?.renderer === 'uosc' && uoscPluginAvailable()
}

/**
 * uosc 控制栏是否接管（**v1.1.4 起是唯一控制栏**）。
 *
 * 为什么不再读 `settings.uoscControlBar`：
 *   v1.1.4 把旧的自绘控制栏整体搬到了 `playerLegacy/PlayerOverlayBar.tsx` 并停止渲染。
 *   如果这里仍然尊重 `uoscControlBar: false`（老用户或设置页手动关过），
 *   结果会是「uosc 不画 + 旧栏也不画」= 一条控制栏都没有 —— 这正是历史上
 *   反复出现过的"所有按钮失灵"的形态。所以现在只有两条路：
 *     · 内置 uosc 可用 → 由它画；
 *     · 安装目录不完整（uosc 缺失）→ 这里返回 false，日志里会写清楚为什么。
 *   设置项保留只是为了旧 settings.json 不报错（见 shared/types.ts 的字段注释）。
 *
 * 仍然要注意：`config-dir` 与这个开关**无关**，它无条件给（v0.3.6 的教训：
 * 不给 config-dir 时 input.conf 里的 ESC 等快捷键会全部失效，见 mpvAttach 的说明）。
 */
export function uoscControlBarRequested(): boolean {
  return uoscPluginAvailable()
}

/* ─────────────── uosc 配色：按应用主题生成 script-opts/uosc.conf ─────────────── */

/** 上一次生成时用的主题 id（同一主题重复进播放器不重复写盘、不重复刷日志） */
let lastUoscConfTheme = ''
/** 上一次实际生效的 config-dir（可能是安装目录，也可能是临时镜像目录） */
let runtimeUoscConfDir = ''

/** 从模板拼出完整的 uosc.conf 内容；模板读不到时返回 null（调用方保持现状） */
function buildUoscConfContent(cfgDir: string, themeId: string): string | null {
  const optsDir = join(cfgDir, 'script-opts')
  let template = ''
  try {
    template = readFileSync(join(optsDir, 'uosc.conf.base'), 'utf8')
  } catch {
    try {
      template = readFileSync(join(optsDir, 'uosc.conf'), 'utf8')
    } catch (err) {
      log.append(
        'warn',
        'mpv',
        `[uosc] 找不到 uosc.conf.base / uosc.conf，控制栏配色无法生成，将使用 uosc 默认色：${String(
          (err as Error)?.message ?? err
        )}`
      )
      return null
    }
  }
  /*
   * 颜色算法在 @shared/uoscTheme（纯函数），主进程只负责读写文件。
   * 这样自检脚本可以在 Node 里跑同一份映射，把生成后的 color= 行贴进报告，
   * 不必为了验证颜色去启动整个 Electron。
   */
  return renderUoscConf(template, themeId)
}

/**
 * 安装目录不可写时的退路：把 config-dir 需要的东西镜像到临时目录。
 *
 * 为什么只镜像 input.conf / fonts / script-opts：
 *   uosc 本体的脚本是主进程用**绝对路径** `load-script` 挂的（见 loadUoscPlugins），
 *   不需要躺在 config-dir 里；而 mpv 会从 config-dir 读 input.conf（快捷键）与
 *   fonts（uosc 图标字体），这两样必须跟着走。
 *
 * 为什么值得做：打包安装到 Program Files 时安装目录**可能**只读。没有这个镜像，
 * "按主题生成 uosc 配色"就只能放弃治疗；有了它，配色照样生效，只是换了个可写位置。
 */
function mirrorMpvConfig(cfgDir: string, confContent: string): string {
  const root = join(app.getPath('temp'), 'sakana-mpv-config')
  mkdirSync(join(root, 'script-opts'), { recursive: true })
  try {
    cpSync(join(cfgDir, 'input.conf'), join(root, 'input.conf'), { force: true })
  } catch {
    log.append('warn', 'mpv', '[uosc] 镜像 input.conf 失败：本次播放的键盘快捷键可能失效')
  }
  try {
    cpSync(join(cfgDir, 'fonts'), join(root, 'fonts'), { recursive: true, force: true })
  } catch {
    log.append('warn', 'mpv', '[uosc] 镜像字体目录失败：uosc 的图标字体可能显示成方框')
  }
  writeFileSync(join(root, 'script-opts', 'uosc.conf'), confContent, 'utf8')
  return root
}

/**
 * 把 `uosc.conf.base` 当模板、按当前主题生成真正被 uosc 读的 `uosc.conf`，
 * 并返回**本轮应该交给 mpv 的 config-dir**。
 *
 * 为什么必须生成而不能在启动参数里给颜色：
 *   `--script-opts` 是逗号分隔的 key=value，而 uosc 的 color 本身就是一个逗号列表 ——
 *   反斜杠转义也救不了（见 uosc.conf.base 头部的实测说明）。所以颜色只能落进配置文件。
 *
 * 三级退路（任何一级失败都不阻止播放）：
 *   ① 直接写安装目录（开发态/可写安装目录，正常情况下走这里）；
 *   ② 写不进去 → 镜像到系统临时目录，用镜像目录当 config-dir（Program Files 只读时走这里）；
 *   ③ 连临时目录都写不了 → 保持现有 uosc.conf（仓库预置的是落日色兜底）并记 error。
 */
function prepareUoscConf(cfgDir: string): string {
  const themeId = resolveThemeId(store.get<Record<string, unknown>>('settings', {}).theme)
  if (themeId === lastUoscConfTheme && runtimeUoscConfDir) return runtimeUoscConfDir
  const content = buildUoscConfContent(cfgDir, themeId)
  if (!content) return cfgDir
  const colorLine = `color=${buildUoscColorLine(themeId)}`
  const bundledConf = join(cfgDir, 'script-opts', 'uosc.conf')
  try {
    writeFileSync(bundledConf, content, 'utf8')
    lastUoscConfTheme = themeId
    runtimeUoscConfDir = cfgDir
    log.append('info', 'mpv', `[uosc] 控制栏配色已按主题「${themePalette(themeId).label}」生成：${colorLine}`)
    return cfgDir
  } catch (err) {
    log.append(
      'warn',
      'mpv',
      `[uosc] 安装目录不可写，尝试把 mpv 配置镜像到临时目录（原错误：${String((err as Error)?.message ?? err)}）`
    )
  }
  try {
    const mirrored = mirrorMpvConfig(cfgDir, content)
    lastUoscConfTheme = themeId
    runtimeUoscConfDir = mirrored
    log.append(
      'info',
      'mpv',
      `[uosc] 已改用临时配置目录（配色仍按主题「${themePalette(themeId).label}」生效）：${mirrored}`
    )
    return mirrored
  } catch (err) {
    /*
     * 连临时目录都写不了：不改动现有 uosc.conf，uosc 读仓库预置的落日色。
     * 把主题 id 留空，下次起播还会再试。
     */
    lastUoscConfTheme = ''
    runtimeUoscConfDir = ''
    log.append(
      'error',
      'mpv',
      `[uosc] 生成 uosc.conf 失败（安装目录与临时目录都不可写），控制栏沿用文件里现有的落日色兜底：${String(
        (err as Error)?.message ?? err
      )}`
    )
    return cfgDir
  }
}

/**
 * 给 thumbfast 写 `script-opts/thumbfast.conf`，返回「这份配置是否已可用」。
 *
 * thumbfast 的开头用 `mp.options.read_options(options, "thumbfast")` 读配置，
 * 它的选项名就是 `mpv_path`（不是 mpv-path / mpv_exe）——见 thumbfast.lua 第 13~55 行的 options 表。
 * 这里写 `mpv_path`，并按我们的播放形态额外打开 `network`；其余选项保持 thumbfast 的默认值。
 *
 * 为什么必须**运行时生成**、不能放一个静态文件进仓库：
 *   `mpv_path` 在开发态是 `<仓库>/resources/mpv-bin/mpv.exe`，打包态是
 *   `<安装目录>/resources/mpv-bin/mpv.exe`。静态文件只能写死其中一种，
 *   换一台机器 / 换安装目录就失效；这里复用 bundledMpvExe() 的同一条解析链，
 *   路径永远与当前运行环境一致。
 *
 * 为什么写到传进来的 cfgDir（而不是固定的 resources/mpv-config）：
 *   打包安装到 Program Files 时安装目录可能只读，prepareUoscConf 会把 config-dir
 *   镜像到临时目录；thumbfast 必须从**真正交给 mpv 的那个 config-dir** 读配置，
 *   否则 mpv 读不到这份文件。
 *
 * 失败时返回 false，调用方会**跳过加载 thumbfast**：这样最多是没有缩略图，
 * 不会出现 thumbfast 在自己 spawn 失败后往画面里 show-text 错误提示的情况。
 */
function prepareThumbfastConf(cfgDir: string, mpvExe: string): boolean {
  if (!cfgDir || !mpvExe) return false
  const optsDir = join(cfgDir, 'script-opts')
  const conf = join(optsDir, 'thumbfast.conf')
  /*
   * 第三方脚本的配置文件用 `#` 注释、`key=value` 一行一个。
   * 路径用正斜杠：mpv 在 Windows 上等价接受，且不会被配置解析当成转义序列。
   */
  const content = [
    '# 由 Sakana 在启动播放器时生成，下一次播放会覆盖，请勿手改。',
    '# thumbfast 通过 mp.options.read_options(options, "thumbfast") 读取本文件。',
    '# 内嵌 libmpv 进程里没有 mpv 可执行文件，thumbfast 必须 spawn 这个独立 exe 去截帧。',
    `mpv_path=${slashPath(mpvExe)}`,
    /*
     * 我们的播放地址全是网络流（直链/HLS）。thumbfast 的 `network` 默认是 false，
     * 而它在 info() 里用 `demuxer-via-network and not options.network` 直接判定 disabled ——
     * 也就是说：只给对 mpv_path、不开这一项，仍然一辈子不会生成缩略图。
     */
    'network=yes',
    /*
     * V1.2.9：把**缩略图输出路径**钉到纯 ASCII 目录。
     *
     * 真机证据：thumbfast 写出的状态文件里，缩略图路径长这样 ——
     *   `C:\Users\RE濡勬兂鐥嘰\AppData\Local\Temp\thumbfast.out19916.bgra`
     * 用户名 `RE妄想症` 已经变成了乱码（`RE濡勬兂鐥嘰`）。thumbfast 会把这个路径拼成
     * `--of=<path>` 交给子进程 mpv 去写 —— 路径坏了，子进程就写不出文件，
     * uosc 拿到的是"有请求、无内容"，于是画出一个**白色空窗**。
     * 这与用户观察完全一致：**连本地播放也没有缩略图**（跟网络流、跟临时缓存都无关）。
     *
     * 现在显式指定一个纯 ASCII 前缀（与 mpv.exe 副本同一个 ProgramData 目录），
     * 让这条链路上不再有任何非 ASCII 字符。
     */
    `thumbnail=${slashPath(thumbOutputBase())}`,
    ''
  ].join('\n')
  try {
    mkdirSync(optsDir, { recursive: true })
    let same = false
    try {
      same = readFileSync(conf, 'utf8') === content
    } catch {
      /* 第一次运行/文件被删：照常写 */
    }
    if (!same) {
      writeFileSync(conf, content, 'utf8')
      log.append('info', 'mpv', `thumbfast 配置已生成：${slashPath(conf)}（mpv_path=${slashPath(mpvExe)}）`)
    }
    return existsSync(conf)
  } catch (err) {
    log.append(
      'warn',
      'mpv',
      `thumbfast 配置生成失败，本次不加载 thumbfast（进度条缩略图不可用）：${String(
        (err as Error)?.message ?? err
      )}`
    )
    return false
  }
}

/**
 * 监听 thumbfast 写的缩略图状态文件（`<config-dir>/script-opts/thumbfast-status.json`）。
 *
 * 为什么要这条桥：libmpv 跑在我们主进程里，thumbfast 的 `mp.msg` 日志进不了应用日志；
 * 而「缩略图生成成功没有、失败原因是什么」是排查白块时唯一需要的证据。
 * Lua 侧只写缩略图临时路径 / 尺寸 / 错误码，**不写流地址**（日志红线）。
 *
 * 为什么用 watchFile 轮询而不是 fs.watch：Windows 上 fs.watch 对“文件先不存在、
 * 之后被创建”的监听并不可靠；这个文件一局只写几次，500ms 轮询足够且不会漏。
 */
let stopThumbfastStatusWatch: (() => void) | null = null
let lastThumbfastStatusKey = ''

interface ThumbfastStatus {
  ok?: boolean
  error?: string
  path?: string
  bytes?: number
  width?: number
  height?: number
}

function watchThumbfastStatus(cfgDir: string): void {
  stopThumbfastStatusWatch?.()
  lastThumbfastStatusKey = ''
  const file = join(cfgDir, 'script-opts', 'thumbfast-status.json')
  const onChange = (cur: Stats, prev: Stats): void => {
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return
    let st: ThumbfastStatus
    try {
      st = JSON.parse(readFileSync(file, 'utf8')) as ThumbfastStatus
    } catch {
      /* Lua 不是原子写：读到半截 JSON 就等下一次 stat 变化再读 */
      return
    }
    if (!st || typeof st.ok !== 'boolean') return
    if (st.ok) {
      /*
       * 按「尺寸 + 字节数」去重：悬停会在同一张图上反复 seek，每次都写状态文件，
       * 但用户只需要一行「生成了」；尺寸变了（换集/换分辨率）才再记。
       */
      const key = `ok:${st.width ?? 0}x${st.height ?? 0}:${st.bytes ?? 0}`
      if (key === lastThumbfastStatusKey) return
      lastThumbfastStatusKey = key
      log.append('info', 'mpv', `[thumbfast] 缩略图已生成 ${slashPath(st.path ?? '')} ${st.bytes ?? 0} bytes`)
    } else {
      const reason = st.error && st.error.length > 0 ? st.error : '未知原因'
      const key = `fail:${reason}`
      if (key === lastThumbfastStatusKey) return
      lastThumbfastStatusKey = key
      log.append('warn', 'mpv', `[thumbfast] 缩略图生成失败：${reason}`)
    }
  }
  watchFile(file, { interval: 500 }, onChange)
  stopThumbfastStatusWatch = () => {
    unwatchFile(file, onChange)
    stopThumbfastStatusWatch = null
  }
}

/** uosc 本体（控制栏/进度条/菜单）是否真的挂上了 */
let uoscBarLoaded = false
export function uoscControlBarActive(): boolean {
  return uoscBarLoaded && ready
}

/** uosc_danmaku（弹幕插件）是否真的挂上了；渲染层据此决定要不要画内置画布 */
let uoscDanmakuLoaded = false
export function uoscDanmakuActive(): boolean {
  return uoscDanmakuLoaded && ready
}

/** 控制栏桥接脚本（sakana-uosc-ctrl.lua）是否挂上了 —— 动作回传与状态下行都靠它 */
let uoscCtrlLoaded = false
export function uoscCtrlActive(): boolean {
  return uoscCtrlLoaded && ready
}

/* ───────────── uosc 控制栏自检：桥接脚本暴露的按钮清单 / 版本号 ───────────── */

export interface UoscBridgeStats {
  /** uosc 广播的版本（脚本收到 `script-message uosc-version` 后写入） */
  version: string
  /** 桥接脚本实际下发过的按钮名（排序后） */
  buttons: string[]
  /** `set-button` 被真正执行（不是命中内容缓存）的累计次数 */
  setCalls: number
  /** 桥接脚本存活标记（与 user-data/sakana-ctrl-ready 同值） */
  ready: string
}

/** `user-data/*` 是节点属性，mpv 转字符串时可能带 JSON 引号；这里统一剥掉 */
function readUserDataText(name: string): string {
  if (!ready || !native) return ''
  try {
    const v = native.getProperty(name)
    if (typeof v !== 'string') return ''
    const t = v.trim()
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
      try {
        const parsed = JSON.parse(t) as unknown
        if (typeof parsed === 'string') return parsed
      } catch {
        return t.slice(1, -1)
      }
    }
    return t
  } catch {
    return ''
  }
}

/**
 * 读取桥接脚本写出来的只读属性（`user-data/sakana-uosc-buttons` / `-stats`）。
 *
 * 为什么要暴露这两个属性：uosc 的按钮是 mpv 的 ASS 图层，Electron 侧看不到 DOM；
 * "控制栏到底有没有按钮"只能由脚本自己说。这里是自检与排障的唯一硬证据
 * （渲染层通过 `api.uosc.status()` 读它，日志里也会写一行）。
 */
export function uoscBridgeStats(): UoscBridgeStats {
  const buttons = readUserDataText('user-data/sakana-uosc-buttons')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const stats = readUserDataText('user-data/sakana-uosc-stats')
  const pick = (key: string): string => {
    const m = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(stats)
    return m?.[1] ?? ''
  }
  const calls = Number(pick('sets'))
  return {
    version: pick('version'),
    buttons,
    setCalls: Number.isFinite(calls) && calls > 0 ? Math.trunc(calls) : 0,
    ready: readUserDataText('user-data/sakana-ctrl-ready')
  }
}

/* ───────────── uosc 播放状态：主进程把可读的实时读数推给菜单 ───────────── */

/** 1 秒一次的状态推送（uosc 菜单打开时读的就是它；没有它菜单只能显示"暂不可用"） */
let lastUoscStatusPushAt = 0

function propNumber(name: string): number {
  if (!native) return 0
  try {
    const v = Number(native.getProperty(name))
    return Number.isFinite(v) ? v : 0
  } catch {
    return 0
  }
}

function propText(name: string): string {
  if (!native) return ''
  try {
    const v = native.getProperty(name)
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 当前播放的"给用户看"的状态快照（不含任何推测值）。
 *
 * 分两类字段：
 *   · 主进程自己知道的：线路/集、投屏、加速器、播放流程、时间；
 *   · 从 mpv 标量属性读到的：分辨率、编码、码率、缓冲、丢帧、音画同步。
 * `demuxer-cache-state` 是节点属性，原生插件只暴露 double/flag/string，
 * 读不到就留空 —— lua 菜单会自己用 `mp.get_property_native` 补上累计流量等节点字段，
 * 两边都拿不到时菜单显示"暂不可用"，**不编数字**。
 */
export interface UoscPlaybackStatus {
  at: number
  playing: boolean
  paused: boolean
  timeMs: number
  lengthMs: number
  width: number
  height: number
  videoCodec: string
  audioCodec: string
  videoBitrate: number
  audioBitrate: number
  cacheDurationSec: number
  cacheSpeedBps: number
  frameDropCount: number
  decoderDropCount: number
  avsync: number
  fileSize: number
  title: string
  subtitle: string
  statusText: string
  line: number
  lineName: string
  ep: number
  epName: string
  cast: { active: boolean; deviceId: string; deviceName: string }
  boost: { active: boolean; mode: string; kind: string; rateBps: number; bytes: number; parallel: number }
  flow: { running: boolean; summary: string; reason: string }
}

export function uoscPlaybackStatus(): UoscPlaybackStatus {
  const st = mpvGetState()
  const p = (lastUoscPayload ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const lines = Array.isArray(p.lines) ? (p.lines as { name?: string; episodes?: string[] }[]) : []
  const line = num(p.currentLine)
  const ep = num(p.currentEp)
  const lineName = str(lines[line]?.name)
  const epName = str(lines[line]?.episodes?.[ep])
  const cast = (p.cast ?? {}) as Record<string, unknown>
  const status = (p.status ?? {}) as Record<string, unknown>
  const boost = getStreamBoostStatus()
  const flow = flowSnapshot()
  return {
    at: Date.now(),
    playing: !!st?.ready && !st.idle && !st.eof && !st.paused,
    paused: !!st?.paused,
    timeMs: Math.round(st?.time ?? 0),
    lengthMs: Math.round(st?.length ?? 0),
    width: propNumber('width'),
    height: propNumber('height'),
    videoCodec: propText('video-codec'),
    audioCodec: propText('audio-codec'),
    videoBitrate: propNumber('video-bitrate'),
    audioBitrate: propNumber('audio-bitrate'),
    cacheDurationSec: propNumber('demuxer-cache-duration'),
    cacheSpeedBps: propNumber('cache-speed'),
    frameDropCount: propNumber('frame-drop-count'),
    decoderDropCount: propNumber('decoder-frame-drop-count'),
    avsync: propNumber('avsync'),
    fileSize: propNumber('file-size'),
    title: str(p.title),
    subtitle: str(p.subtitle),
    statusText: str(status.text),
    line,
    lineName,
    ep,
    epName,
    cast: {
      active: cast.active === true,
      deviceId: str(cast.deviceId),
      deviceName: str(cast.deviceName)
    },
    boost: {
      active: boost.active,
      mode: boost.mode,
      kind: boost.kind,
      rateBps: boost.rateBps,
      bytes: boost.bytes,
      parallel: boost.parallel
    },
    flow: { running: flow.running, summary: flow.summary, reason: flow.reason }
  }
}

/**
 * 把状态快照推给桥接脚本（lua 缓存它，`sakana-status` 菜单打开时直接读缓存，
 * 不需要在点击那一刻再绕一圈 IPC —— 菜单必须**立刻**出现，不能等异步往返）。
 *
 * 每秒一次：菜单里的缓冲/速度/丢帧本来就是秒级变化，再快只会白耗 IPC。
 */
export function mpvPushUoscStatus(force = false): boolean {
  if (!ready || !native || !uoscCtrlLoaded) return false
  const now = Date.now()
  if (!force && now - lastUoscStatusPushAt < 1000) return false
  lastUoscStatusPushAt = now
  try {
    return native.command(['script-message', 'sakana-playback-status', JSON.stringify(uoscPlaybackStatus())])
  } catch {
    return false
  }
}

/**
 * 等待注入的弹幕文件（应用侧最后给出的那一集）。
 *
 * 为什么不用「一次性队列」：切集时弹幕往往**先于**新流载入到达
 * （缓存命中 3ms，而 loadfile 是异步的），一次性的队列要么注入到上一集、
 * 要么新流载入后没人再补发。所以这里存「最新的一份」，由 250ms 轮询按 path 幂等补发。
 */
let latestPluginDanmakuFile = ''
/** 已经为哪个 path 注入过（换文件后清空，于是会自动为新的 path 再注入一次） */
let injectedForPath = ''
/** 上一轮轮询看到的 mpv path（用于识别换集/换文件） */
let lastMpvPath = ''
/** 当前文件的注入尝试次数与上次尝试时间（失败时限流重试，避免每 250ms 刷日志） */
let injectAttempts = 0
let lastInjectAttemptAt = 0
/**
 * 「因为还没有画面、暂时不注入」这条日志已经为哪个 path 记过。
 *
 * 为什么要有它：画面没出来时 250ms 的泵会一直走到那个分支，
 * 不记的话同一句话每 250ms 刷一行（历史上正是这样把日志刷满的）。
 * 只在换文件（path 变化）时重新允许记一次。
 */
let danmakuWaitLoggedPath = ''

/**
 * uosc + uosc_danmaku 的 script-opts。
 *
 * 键必须是「脚本名-选项」前缀形式：uosc / uosc_danmaku 都用 `mp.options.read_options(opts, <脚本名>)`
 * 读取，而它只认前缀键（裸键只有 `mp.get_opt()` 能看到）—— 这一点是实测出来的。
 *
 * 另一个实测限制：**值里不能有逗号**。`--script-opts` 是以逗号分隔的键值列表，
 * 反斜杠转义（`timeline\,controls`）也救不了，会被硬拆成两段。
 * 所以 `disable_elements` 这种逗号列表**不能**走这里，得用运行时 script-message（见 mpvAttach）。
 */
function uoscScriptOpts(): string {
  const cfgDir = bundledMpvConfigDir()
  // 数据源与内置画布完全一致（自定义地址 / 官方地址 / 反代三者的优先级只在 danmaku.ts 里定义）
  const base = danmakuApiBase()
  const d = getSettings().danmaku
  const opts: string[] = []
  // 弹幕数据源：与内置画布同一套反代（用户可自定义）
  opts.push(`uosc_danmaku-api_server=${slashPath(base)}`)
  /*
   * 关联记录（history）必须给**绝对可写路径**：
   * 插件默认是 `~~/danmaku-history.json`，而 `~~` = 配置目录 = 我们的安装目录
   * （打包后位于 Program Files 下，不可写），弹幕关联与开关状态都会存不下来。
   */
  const stateFile = join(app.getPath('userData'), 'tmp', 'danmaku', 'danmaku-history.json')
  try {
    mkdirSync(join(app.getPath('userData'), 'tmp', 'danmaku'), { recursive: true })
  } catch {
    /* 目录不可写时插件会退化成记不住状态 */
  }
  opts.push(`uosc_danmaku-history_path=${slashPath(stateFile)}`)
  if (d) {
    if (typeof d.opacity === 'number') opts.push(`uosc_danmaku-opacity=${clamp01(d.opacity)}`)
    // 内置画布的字号是 CSS px（默认 22），插件的 fontsize 是 ASS 单位（1080p 下默认 50）
    if (typeof d.fontSize === 'number') opts.push(`uosc_danmaku-fontsize=${Math.round(d.fontSize * 2.2)}`)
    if (typeof d.maxCount === 'number' && d.maxCount > 0) opts.push(`uosc_danmaku-max_screen_danmaku=${d.maxCount}`)
    if (typeof d.speedSec === 'number' && d.speedSec > 0) opts.push(`uosc_danmaku-scrolltime=${d.speedSec}`)
    if (typeof d.area === 'number') opts.push(`uosc_danmaku-displayarea=${clamp01(d.area)}`)
    if (d.showTop === false && d.showBottom === false && d.showScroll === false) {
      opts.push('uosc_danmaku-opacity=0')
    }
    const words = (d.blockWords ?? '')
      .split(/[,，\n]/)
      .map((w) => w.trim())
      .filter(Boolean)
    if (words.length > 0 && cfgDir) {
      // 屏蔽词文件：插件要求「一行一个正则」，这里从设置项生成（逗号分隔）
      const file = join(app.getPath('userData'), 'tmp', 'danmaku', 'blacklist.txt')
      try {
        mkdirSync(join(app.getPath('userData'), 'tmp', 'danmaku'), { recursive: true })
        writeFileSync(file, words.join('\n'), 'utf8')
        opts.push(`uosc_danmaku-blacklist_path=${slashPath(file)}`)
      } catch {
        /* 写不了就退化成不屏蔽 */
      }
    }
  }
  return opts.join(',')
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/**
 * 挂载 uosc 控制栏三件套（必须在 mpv create 之后用 load-script；理由见 bundledMpvConfigDir）。
 *
 * 加载顺序**不能改**：
 *   ① sakana-uosc-ctrl.lua（控制栏桥接脚本；它比 uosc 先加载，uosc 就绪后会广播
 *      uosc-version，脚本据此把按钮数据强制重发一次 —— 见脚本里的注释）
 *   ② uosc_danmaku（弹幕插件，仅当用户选了插件渲染；它要赶在 uosc 广播之前注册监听）
 *   ③ uosc（控制栏本身：按钮、进度条、音量、菜单）
 *
 * @param wantDanmaku 是否加载 uosc_danmaku（弹幕渲染方式 = uosc 时才加载）
 * @param wantBar 控制栏是否交给 uosc（设置项 uoscControlBar，默认 true）
 * @param thumbfastScript thumbfast.lua 的绝对路径；空串 = 这一轮不加载（缺 exe / 配置写不进去）
 */
function loadUoscPlugins(
  mod: MpvNative,
  cfgDir: string,
  wantDanmaku: boolean,
  wantBar: boolean,
  thumbfastScript: string
): boolean {
  const uoscDir = slashPath(join(cfgDir, 'scripts', 'uosc'))
  const danmakuDir = slashPath(join(cfgDir, 'scripts', 'uosc_danmaku'))

  /*
   * ⓪ thumbfast（进度条悬停缩略图，用户点名要的）
   *
   * 为什么必须**排在 uosc 之前**加载：uosc 在初始化时会问一遍 "有没有 thumbfast"，
   * 之后靠 `thumbfast-info` 消息拿缩略图。先挂上它，uosc 第一次渲染进度条就知道能画预览；
   * 反过来（uosc 先起）就要等它下一次探测，用户把鼠标压到进度条上可能还没有缩略图。
   *
   * 为什么它是一个 `load-script` 而不是 `<config-dir>/scripts/` 里的自动加载：
   * libmpv 这边 `load-scripts=no`（否则 uosc 会被加载两份，见上面的注释），
   * 所以每个脚本都得我们自己按绝对路径挂 —— 漏一个就等于没装。
   *
   * `thumbfastScript` 为空 = 这一轮不加载（缺 mpv.exe / 配置写不进去，原因已在 mpvAttach 记过）。
   * 为什么缺东西时宁可不挂：thumbfast 的 spawn 失败回调会自己 `show-text`
   * "ERROR! cannot create mpv subprocess" —— 那会变成用户眼里的“播放器莫名弹错”。
   * 不加载最多是没有悬停缩略图，uosc 不会报错。
   */
  if (thumbfastScript) {
    try {
      const p = slashPath(thumbfastScript)
      const okT = mod.command(['load-script', p])
      log.append(okT ? 'info' : 'warn', 'mpv', okT ? `thumbfast 已加载（进度条缩略图）: ${p}` : `thumbfast 加载失败: ${p}`)
    } catch (err) {
      log.append('warn', 'mpv', `加载 thumbfast 异常: ${String((err as Error)?.message ?? err)}`)
    }
  }

  // ① 控制栏桥接脚本
  const ctrlScript = bundledUoscCtrlScript()
  if (ctrlScript) {
    try {
      uoscCtrlLoaded = mod.command(['load-script', slashPath(ctrlScript)])
      log.append(
        uoscCtrlLoaded ? 'info' : 'warn',
        'mpv',
        uoscCtrlLoaded
          ? `uosc 控制栏桥接脚本已加载: ${ctrlScript}`
          : `uosc 控制栏桥接脚本加载失败: ${ctrlScript}`
      )
    } catch (err) {
      uoscCtrlLoaded = false
      log.append('warn', 'mpv', `加载 uosc 控制栏桥接脚本异常: ${String((err as Error)?.message ?? err)}`)
    }
  } else {
    log.append('warn', 'mpv', '找不到 sakana-uosc-ctrl.lua，uosc 控制栏将只有画面没有按钮')
  }

  // ② 弹幕插件（可选）
  if (wantDanmaku) {
    try {
      uoscDanmakuLoaded = mod.command(['load-script', danmakuDir])
    } catch (err) {
      uoscDanmakuLoaded = false
      log.append('warn', 'mpv', `加载 uosc_danmaku 异常: ${String((err as Error)?.message ?? err)}`)
    }
  }

  // ③ uosc 本体
  let ok = false
  try {
    ok = mod.command(['load-script', uoscDir])
  } catch (err) {
    log.append('warn', 'mpv', `加载 uosc 异常: ${String((err as Error)?.message ?? err)}`)
  }
  uoscBarLoaded = ok
  log.append(
    ok ? 'info' : 'warn',
    'mpv',
    ok
      ? `uosc 已加载（控制栏接管）：${uoscDir}${wantDanmaku ? ' + uosc_danmaku' : ''}`
      : `uosc 加载失败：${uoscDir}`
  )
  if (!ok) return false

  /*
   * 兜底：uosc 加载时只广播一次 uosc-version，而 uosc_danmaku 若在它之后才加载
   * （或广播被错过）就会把菜单降级成 mp.input。这里补发一次，顺序被改动也不会静默降级。
   * 控制栏桥接脚本也在监听同一条消息（它靠它决定何时重发按钮数据）。
   */
  try {
    mod.command(['script-message-to', 'uosc_danmaku', 'uosc-version', '5.13.0'])
  } catch {
    /* ignore */
  }
  /*
   * 用户在设置里把控制栏切回「应用自己的悬浮窗」时（wantBar=false），
   * uosc 仍可能因为**弹幕插件**而必须加载（插件的搜索/样式/延迟菜单要用 uosc 渲染）。
   * 那种情况下必须把它自己的控制栏关掉，否则画面上下会各挂一条控制栏。
   * 这里的逗号列表只能走 script-message（`--script-opts` 的逗号解析救不了，见 uosc.conf 头注释）。
   */
  if (!wantBar) {
    try {
      mod.command([
        'script-message-to',
        'uosc',
        'disable-elements',
        'sakana',
        'timeline,controls,volume,top_bar,window_border'
      ])
      log.append('info', 'mpv', '已关闭 uosc 自带的控制栏（用户在设置里选择了应用自己的控制栏）')
    } catch {
      /* ignore */
    }
  } else {
    /*
     * wantBar=true：那些元素正是我们要的（布局/按钮/时间显示全在
     * resources/mpv-config/script-opts/uosc.conf 里配），
     * 所以旧版那句无条件的 disable-elements 已经删掉。
     */
  }

  /*
   * v0.3.3：**桥接脚本存活检查**。
   *
   * 为什么需要：`load-script` 只表示「文件被接受了」，脚本在运行时报错（例如我们在 Lua 里
   * 误写了一个 JSDoc 风格的 `/** *​/` 注释）会立刻退出，而 load-script 依然返回成功 ——
   * 那时控制栏会**一个按钮都没有**、菜单全打不开，用户还以为「控制栏坏了」。
   * 脚本加载成功后会在自己末尾写 `user-data/sakana-ctrl-ready`；这里等一会儿去读，
   * 读不到就判定脚本没活下来，把 uosc 控制栏标记为不可用（渲染层会回落到应用自己的悬浮窗控制栏，
   * 至少保证用户有控制栏可用），并把原因写进日志与错误日志页。
   */
  if (uoscCtrlLoaded) {
    setTimeout(() => {
      if (!ready || !native) return
      let alive = ''
      try {
        const v = native.getProperty('user-data/sakana-ctrl-ready')
        alive = typeof v === 'string' ? v : ''
      } catch {
        alive = ''
      }
      if (alive) {
        log.append('info', 'mpv', `控制栏桥接脚本已就绪（版本 ${alive}）`)
        /*
         * v1.1.4：把「uosc 真的收下了多少个 button」写进日志。
         * 这是"控制栏有没有按钮"唯一不依赖截图的证据：uosc 的按钮是 ASS 图层，
         * Electron 侧看不到 DOM；脚本把已下发的按钮名写进 user-data，这里读回来记一行。
         * 同时把 1 秒后的状态快照强推一次，`sakana-status` 菜单在起播最开始就有数可看。
         */
        setTimeout(() => {
          const stats = uoscBridgeStats()
          log.append(
            'info',
            'mpv',
            `[uosc] 控制栏就绪：uosc 版本=${stats.version || '未广播'} 按钮=${stats.buttons.length} 个` +
              ` set-button 下发=${stats.setCalls} 次 [${stats.buttons.join(',')}]`
          )
          mpvPushUoscStatus(true)
        }, 200)
        return
      }
      uoscCtrlLoaded = false
      log.append(
        'error',
        'mpv',
        '控制栏桥接脚本没有就绪（多半是 Lua 语法/运行错误，见日志里的 Lua error）——' +
          '已回落到应用自己的控制栏，请检查 resources/mpv-scripts/sakana-uosc-ctrl.lua'
      )
    }, 1200)
  }
  return true
}

/* ───────────────── uosc 控制栏：状态下行 + 动作上行（v0.2.18） ───────────────── */

/**
 * 动作上行通道：mpv 侧 → 应用。
 *
 * 数据流：uosc 按钮 / 菜单项 / input.conf 快捷键
 *   → `script-message sakana-ctrl <动作> [参数…]`
 *   → sakana-uosc-ctrl.lua 写 mpv 属性 `user-data/sakana-ctrl`
 *   → 本文件的 250ms 状态泵读出来 → 转成 OverlayAction → 发给播放页（与悬浮窗同一条 IPC）
 *
 * 为什么不用 `--input-ipc-server`：那要在 libmpv 里再开一条本机命名管道，
 * 等于多一条任何本机进程都能连的控制通道；而需求只是「点一下按钮要生效」，
 * 250ms 的轮询完全够用，也不需要改原生插件。将来若要压到零延迟，
 * 换 transport 只影响这里与脚本里的 emit()。
 */
const UOSC_CTRL_PROP = 'user-data/sakana-ctrl'

/** 弹幕设置里允许被 uosc 菜单改的键（白名单：不接受脚本传什么就改什么） */
const UOSC_DANMAKU_KEYS: (keyof DanmakuSettings)[] = [
  'enabled',
  'area',
  'maxCount',
  'offsetMs',
  'showScroll',
  'showTop',
  'showBottom'
]

/**
 * uosc 动作字符串 → 播放页认识的 OverlayAction。
 * 认不出来的一律丢掉并记日志（宁可不动，也不要乱改播放状态）。
 */
function uoscActionToOverlay(raw: string): OverlayAction | null {
  const sp = raw.indexOf(' ')
  const name = (sp < 0 ? raw : raw.slice(0, sp)).trim()
  // 参数可能自带空格（例如 danmaku-json 里的 JSON），所以按「第一个空格之后」整体取
  const rest = sp < 0 ? '' : raw.slice(sp + 1).trim()
  const parts = rest ? rest.split(/\s+/) : []
  switch (name) {
    case 'play-pause':
      return { type: 'playPause' }
    case 'prev-episode':
      return { type: 'prevEpisode' }
    case 'next-episode':
      return { type: 'nextEpisode' }
    case 'back10':
      return { type: 'back10' }
    case 'forward10':
      return { type: 'forward10' }
    case 'toggle-danmaku':
      return { type: 'toggleDanmaku' }
    /*
     * 音量菜单里的「静音 / 恢复声音」项。
     * v1.1.6 之前这是 sakana-volume 按钮点一下的唯一下场；现在按钮改为弹菜单，
     * 这一条只由菜单项发出（见 sakana-uosc-ctrl.lua 的 menu_volume）。
     * 语义与旧控制栏的音量键一致：只切 mpv 的 mute 标记，不改 volume 数值。
     */
    case 'toggle-mute':
      return { type: 'toggleMute' }
    /*
     * v1.1.6：音量菜单（sakana-volume 点开）的"调大小"动作。
     *
     * 用户反馈旧按钮只发 toggle-mute，点了只能静音/恢复；Lua 侧现在发这两条，
     * 由播放页调 api.player.setVolume 写入。这里只做范围收敛，不直接碰内核 ——
     * 音量真源始终是主进程/内核，Lua 只发动作（见 sakana-uosc-ctrl.lua 的 menu_volume）。
     * 上限 100 与菜单快捷档一致；增量在播放页按应用现有上限（VOLUME_MAX=200）计算，
     * 不能在这里夹到 100，否则用户已经在 150% 时点 −10% 会突然掉到 100%。
     */
    case 'volume-set': {
      const v = Number(parts[0])
      if (!Number.isFinite(v)) return null
      return { type: 'volumeSet', value: Math.max(0, Math.min(100, Math.round(v))) }
    }
    case 'volume-delta': {
      const d = Number(parts[0])
      if (!Number.isFinite(d)) return null
      return { type: 'volumeDelta', delta: Math.max(-200, Math.min(200, Math.round(d))) }
    }
    case 'toggle-info':
      return { type: 'toggleInfo' }
    /*
     * v1.1.5：uosc 右上角角标「播放流详情」。
     * 动作名 `flow` 来自 `sakana-uosc-ctrl.lua` 的 sakana-flow 按钮；它打开的是**流详情面板**
     * （StreamInfoModal：嗅探地址 / 带宽 / 线路读数 / 播放流程），
     * 与「番剧详情」（toggle-info）是两件事，所以单独一条映射。
     */
    case 'flow':
      return { type: 'toggleStreamInfo' }
    case 'snapshot':
      return { type: 'snapshot' }
    case 'toggle-fullscreen':
      return { type: 'toggleFullscreen' }
    case 'exit':
      return { type: 'exitPlayer' }
    case 'escape':
      return { type: 'escape' }
    case 'open-danmaku-settings':
      return { type: 'openDanmakuSettings' }
    case 'reload-danmaku':
      return { type: 'reloadDanmaku' }
    case 'detect-danmaku-alias':
      return { type: 'detectDanmakuAlias' }
    /*
     * v1.1.4：弹幕线约定的控制栏动作（参数是裸数字 / 关键词，不是 JSON）。
     * 这些名字来自 `sakana-uosc-ctrl.lua` 的「弹幕」菜单；映射成 OverlayAction 后
     * 与旧悬浮窗走**完全相同**的那套处理（updateDanmaku / loadDanmaku）。
     */
    case 'danmakuArea':
    case 'danmakuFontSize':
    case 'danmakuOffset': {
      const v = Number(parts[0])
      if (!Number.isFinite(v)) return null
      const key = name === 'danmakuArea' ? 'area' : name === 'danmakuFontSize' ? 'fontSize' : 'offsetMs'
      return { type: 'danmakuSetting', key, value: v }
    }
    case 'danmakuReload':
      return { type: 'reloadDanmaku' }
    case 'danmakuAliasSearch':
      // 不带参数时 keyword 为空串，由播放页决定是弹输入框还是用当前剧名再搜
      return { type: 'searchDanmakuAlias', keyword: rest }
    case 'uosc-menu': {
      const k = parts[0]
      if (k === 'search' || k === 'total' || k === 'style' || k === 'delay' || k === 'add') {
        return { type: 'uoscMenu', key: k }
      }
      return null
    }
    case 'select-episode': {
      const line = Number(parts[0])
      const ep = Number(parts[1])
      if (!Number.isFinite(line) || !Number.isFinite(ep)) return null
      return { type: 'selectEpisode', line: Math.max(0, Math.trunc(line)), ep: Math.max(0, Math.trunc(ep)) }
    }
    case 'set-speed': {
      const v = Number(parts[0])
      if (!Number.isFinite(v)) return null
      return { type: 'setSpeed', value: v }
    }
    case 'set-aspect': {
      const m = parts[0]
      if (m !== 'fit' && m !== 'cover' && m !== 'stretch') return null
      return { type: 'setAspect', aspect: m }
    }
    case 'set-subtitle': {
      const id = Number(parts[0])
      if (!Number.isFinite(id)) return null
      return { type: 'setSubtitle', id: Math.trunc(id) }
    }
    case 'danmaku-json': {
      // 菜单项用 JSON 传参，类型（数字/布尔）不会在字符串里丢
      try {
        const o = JSON.parse(rest) as { key?: unknown; value?: unknown }
        const key = typeof o.key === 'string' ? o.key : ''
        const value = o.value
        if (!UOSC_DANMAKU_KEYS.includes(key as keyof DanmakuSettings)) return null
        if (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string') return null
        return { type: 'danmakuSetting', key: key as keyof DanmakuSettings, value }
      } catch {
        return null
      }
    }
    default:
      return null
  }
}

/** 读一次动作属性；有动作就清空并把对应的 OverlayAction 发给播放页 */
function pollUoscCtrl(win: BrowserWindow): void {
  if (!uoscCtrlLoaded || !ready || !native) return
  let raw = ''
  try {
    const v = native.getProperty(UOSC_CTRL_PROP)
    raw = typeof v === 'string' ? normalizeCtrlProp(v) : ''
  } catch {
    return
  }
  if (raw === '') return
  // 先清空再派发：清空失败也照样派发（最坏情况是同一动作被重复触发一次，
  // 比「读到了却不清空 → 每 250ms 触发一次」安全得多）
  try {
    native.setProperty(UOSC_CTRL_PROP, '')
  } catch {
    /* ignore */
  }
  const action = uoscActionToOverlay(raw)
  /*
   * v0.3.3：Anime4K 的动作**直接在主进程处理**，不绕渲染层。
   *
   * 理由：设置存在主进程的 store 里，处理完马上就要 change-list 重挂着色器链、
   * 再把新状态推回控制栏（角标/勾选态）。绕一圈渲染层只是多一次 IPC 往返，
   * 中间还可能出现「菜单已经关了但按钮还是旧状态」的空窗。
   */
  if (handleAnime4kUoscAction(raw)) {
    lastDispatchedAction = `${raw}（主进程直接处理）`
    dispatchedCount += 1
    return
  }
  if (!action) {
    log.append('warn', 'mpv', `uosc 控制栏动作无法识别，已忽略: ${raw.slice(0, 80)}`)
    return
  }
  lastDispatchedAction = raw
  dispatchedCount += 1
  /*
   * v1.1.6：音量菜单的动作单独记一行。
   *
   * 音量是这次用户反馈的核心，而「点了菜单项到底有没有到主进程」在界面上只能靠 toast；
   * 把动作名与参数原样留下，真机验证时搜 `uosc 音量菜单动作` 就能确认链路真的通了
   * （没这一行而只看到 unknown-action 警告，就说明映射表没接住）。
   */
  if (action.type === 'volumeSet' || action.type === 'volumeDelta') {
    log.append('info', 'mpv', `uosc 音量菜单动作：${raw}（已交给播放页执行）`)
  }
  /*
   * V1.1：uosc 控制栏（mpv 自己画的那条）的点击**不经过悬浮窗**，只有这里看得到。
   * 用户要的是"点播放器按钮没反应就提示 Esc/F"，而很多用户用的正是 uosc 这条，
   * 所以这条路上的动作也要交给同一套侦测（判据与悬浮窗那条完全相同：客观读数）。
   */
  noteControlAction(action)
  try {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(CH.overlayAction, action)
    }
  } catch (err) {
    log.append('warn', 'mpv', `uosc 控制栏动作派发失败: ${String((err as Error)?.message ?? err)}`)
  }
}

/**
 * 归一化 `user-data/sakana-ctrl` 读到的值（v0.3.3 关键修复）。
 *
 * `user-data/*` 是**节点（node）类型**的属性，mpv 把它转成字符串时对字符串节点会输出
 * JSON 风格字面量：脚本写进去的 `toggle-danmaku`，我们读回来是 `"toggle-danmaku"`（带引号）。
 * 而 `uoscActionToOverlay()` 按裸字符串匹配 → **每个动作都匹配不上**，
 * 用户看到的就是「控制栏按钮点了没反应」（他从 0.3.0 起一直反馈的问题）。
 *
 * 还有两个必须处理的形态：
 *  - 我们用 `setProperty(name, '')` 清空后，读回来是 `""`（两个引号字符，不是空串）——
 *    以前会被当成一个「无法识别的动作」，每 250ms 往日志页刷一条告警；
 *  - 将来若写成 JSON 对象/数组，也能原样还原成文本。
 */
function normalizeCtrlProp(value: string): string {
  const t = value.trim()
  if (t.length < 2 || !t.startsWith('"') || !t.endsWith('"')) return t
  try {
    const parsed = JSON.parse(t) as unknown
    return typeof parsed === 'string' ? parsed : t
  } catch {
    return t.slice(1, -1)
  }
}

/** 自检用：最近一次被成功派发的控制栏动作 + 累计条数（证明动作链路真的通了） */
let lastDispatchedAction = ''
let dispatchedCount = 0
export function uoscActionStats(): { last: string; count: number } {
  return { last: lastDispatchedAction, count: dispatchedCount }
}

/** 上一次推给桥接脚本的状态（内容没变就不重发；控制栏状态是低频变化） */
let lastUoscBarJson = ''

/**
 * 控制栏状态下行：播放页 → sakana-uosc-ctrl.lua。
 *
 * 按钮的图标/激活态/角标、以及选集/线路/字幕/倍速/比例/弹幕菜单的内容，
 * 全部由这份状态决定。故意**不含播放进度**（每秒都在变，没必要推）。
 */
export function mpvPushUoscBar(payload: unknown): boolean {
  if (!ready || !native || !uoscCtrlLoaded) return false
  /*
   * v0.3.3：把**当前画质设置**并进这份状态。
   *
   * 为什么由主进程来并：Anime4K 的设置存在主进程的 store 里（uosc 菜单改的也是它），
   * 渲染层那份 payload 里没有这个字段；而控制栏的「画质」按钮要靠它显示角标与勾选态。
   * 合并放在去重比较**之前** —— 这样菜单里改了模式之后重推同一份 payload 也能生效。
   */
  const a4kSettings = getSettings().anime4k ?? {}
  let merged: Record<string, unknown> | null = null
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    merged = {
      ...(payload as Record<string, unknown>),
      anime4k: {
        enabled: a4kSettings.enabled === true,
        mode: a4kSettings.mode ?? 'A',
        tier: a4kSettings.tier ?? 'fast'
      }
    }
    lastUoscPayload = merged
  }
  let json = ''
  try {
    json = JSON.stringify(merged ?? payload ?? null)
  } catch {
    return false
  }
  if (!json || json === 'null' || json === lastUoscBarJson) return true
  lastUoscBarJson = json
  try {
    const ok = native.command(['script-message', 'sakana-state', json])
    if (!ok) log.append('warn', 'mpv', '控制栏状态推送被拒（sakana-state）')
    return ok
  } catch (err) {
    log.append('warn', 'mpv', `控制栏状态推送异常: ${String((err as Error)?.message ?? err)}`)
    return false
  }
}

/**
 * 把应用解析好的弹幕（已写成 B 站格式 xml）交给 uosc_danmaku 渲染。
 *
 * 用的是插件**自带**的消息 `add-source-event <源>`（插件按 is_protocol 自动分派：
 * 本地路径走本地弹幕源、URL 走 extcomment），所以资源目录里的插件保持上游原版、
 * 升级时直接替换即可。
 *
 * ⚠️ 必须等 mpv 已经载入文件（`path` 非空）再发：否则插件写 history 时会 `history[nil]` 崩掉、
 * 脚本被 mpv 终止，之后所有消息都送不进去（见 startTimePump 里的注释）。
 * 所以这里只是**排队**，由 250ms 的状态轮询在 path 就绪后真正发出。
 */
export function mpvPushDanmakuFile(file: string): boolean {
  if (!ready || !native || !uoscDanmakuLoaded || !file) return false
  latestPluginDanmakuFile = file
  /*
   * v1.5 需求 ②：画面还没出现时**只排队、不注入**。
   *
   * 为什么必须在这里拦一道（哪怕 250ms 泵里也有一道）：弹幕通常在播放开始后几百毫秒
   * 就加载完了，而首帧往往要等好几秒（慢 CDN / 长片冷启动）。如果这里照旧立刻注入，
   * 插件会马上开画 —— 屏幕上就是"黑底 + 上一集的帧 + 一堆弹幕"，正是用户要修的那一幕。
   * 返回值仍然给 true：对调用方来说"已经收下、会负责送达"，不是失败。
   */
  if (!mpvHasPicture()) {
    log.append('info', 'mpv', `画面还没出现（hasPicture=false）：弹幕先排队，等首帧后交给 uosc_danmaku: ${file}`)
    return true
  }
  const curPath = mpvCurrentPath()
  if (curPath && injectedForPath !== curPath) return injectPluginDanmaku(file)
  // 文件还没载入：留给 250ms 的轮询在 path 就绪后补发（理由见 startTimePump 注释）
  log.append('info', 'mpv', `弹幕已就绪，等 mpv 载入文件后交给 uosc_danmaku: ${file}`)
  return true
}

/** 真正发出注入（内部使用：需要 path 已就绪） */
function injectPluginDanmaku(file: string): boolean {
  if (!ready || !native || !uoscDanmakuLoaded) return false
  try {
    const ok = native.command(['script-message-to', 'uosc_danmaku', 'add-source-event', slashPath(file)])
    if (ok) injectedForPath = mpvCurrentPath()
    log.append(
      ok ? 'info' : 'warn',
      'mpv',
      ok ? `已把弹幕交给 uosc_danmaku 渲染: ${file}（path=${(mpvCurrentPath() ?? '').slice(0, 60)}）` : '弹幕注入被拒'
    )
    return ok
  } catch (err) {
    log.append('warn', 'mpv', `弹幕注入失败: ${String((err as Error)?.message ?? err)}`)
    return false
  }
}

/**
 * 是否还有弹幕在等当前文件就绪（渲染层据此决定「再等等」还是「回落到画布」）。
 *
 * v1.5：**"等首帧"也会返回 true**（注入被 hasPicture 门控住了，见 mpvPushDanmakuFile）。
 * 所以渲染层不能把它一律当成"插件没挂上"去回落 —— 那会在画面出现后又叠一层内置画布弹幕。
 * 渲染层的正确做法是：`hasPicture=false` 期间继续等，画面出现后再按这个值判断。
 */
export function mpvPluginDanmakuPending(): boolean {
  if (!latestPluginDanmakuFile) return false
  const curPath = mpvCurrentPath()
  return !curPath || injectedForPath !== curPath
}

/** mpv 当前载入的文件/地址（未载入时为 ''） */
export function mpvCurrentPath(): string {
  if (!ready || !native) return ''
  try {
    const v = native.getProperty('path')
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/**
 * 直接给插件 episodeId，让插件自己去 api_server 取弹幕。
 * 也用插件自带消息（`load-danmaku <番剧名> <集标题> <episodeId>`），应用侧没有本地弹幕文件时用它。
 */
export function mpvPushDanmakuEpisode(episodeId: number, animeTitle = '', episodeTitle = ''): boolean {
  if (!ready || !native || !uoscDanmakuLoaded || !episodeId) return false
  try {
    const ok = native.command([
      'script-message-to',
      'uosc_danmaku',
      'load-danmaku',
      animeTitle,
      episodeTitle,
      String(episodeId)
    ])
    log.append(ok ? 'info' : 'warn', 'mpv', ok ? `已让 uosc_danmaku 自行拉取 episodeId=${episodeId}` : 'episodeId 注入被拒')
    return ok
  } catch {
    return false
  }
}

/** 弹幕时间轴微调（毫秒 → 插件接受的秒）；插件按自己的机制作用于当前所有来源 */
export function mpvPushDanmakuDelay(offsetMs: number): void {
  if (!ready || !native || !uoscDanmakuLoaded) return
  try {
    native.command(['script-message-to', 'uosc_danmaku', 'danmaku-delay', String(Math.round(offsetMs) / 1000)])
  } catch {
    /* ignore */
  }
}

/** 打开插件的一个菜单（uosc 渲染）：search=搜索弹幕 / total=总菜单 / style=弹幕样式 / delay=源延迟 */
export function mpvOpenDanmakuMenu(which: 'search' | 'total' | 'style' | 'delay' | 'add'): boolean {
  if (!ready || !native || !uoscDanmakuLoaded) return false
  const map: Record<string, string> = {
    search: 'open_search_danmaku_menu',
    total: 'open_add_total_menu',
    style: 'open_danmaku_style_menu',
    delay: 'open_source_delay_menu',
    add: 'open_add_source_menu'
  }
  try {
    return native.command(['script-message', map[which]])
  } catch {
    return false
  }
}

/**
 * 显式设置插件的弹幕开关（不是 toggle —— 应用侧知道自己要开还是关）。
 * 插件把开关状态存在自己的 history 文件里，这条消息同时会同步给 uosc 的按钮状态。
 */
export function mpvSetUoscDanmakuVisible(on: boolean): boolean {
  if (!ready || !native || !uoscDanmakuLoaded) return false
  try {
    return native.command(['script-message-to', 'uosc_danmaku', 'set', 'show_danmaku', on ? 'on' : 'off'])
  } catch {
    return false
  }
}

/** 清空插件当前关联的弹幕源（切集时避免上一集的弹幕残留） */
export function mpvClearUoscDanmakuSource(): void {
  if (!ready || !native || !uoscDanmakuLoaded) return
  try {
    native.command(['script-message-to', 'uosc_danmaku', 'clear-source'])
  } catch {
    /* ignore */
  }
}

/**
 * 插件是否已经**成功加载并显示了**弹幕。
 *
 * 注意：v2.1.0 里没有 `danmaku-count` 属性（那是上游 master 文档里的东西，代码里并不存在），
 * 只有 `user-data/uosc_danmaku/has-danmaku`（布尔，`show_danmaku_func` 里置 true）——
 * 拿它判断「插件到底有没有把弹幕挂上」，挂不上就回落到内置画布。
 */
export function mpvUoscDanmakuLoaded(): boolean {
  if (!ready || !native) return false
  try {
    return native.getProperty('user-data/uosc_danmaku/has-danmaku') === true
  } catch {
    return false
  }
}

/* ─────────────── Anime4K 超分 + 画面微调（v0.3.1） ─────────────── */

/**
 * 内置着色器目录（39 个 Anime4K v4.0.1 的 `.glsl`）。
 *
 * 与 mpv-config 一样走 extraResources：打包后在 `<安装目录>/resources/shaders`，
 * 开发态在仓库的 `resources/shaders`。判定存在的哨兵文件用
 * `Anime4K_Clamp_Highlights.glsl` —— 它是所有内置模式的第一颗着色器，
 * 少了它整条链都是错的，拿它当探针最贴切。
 */
export function bundledShaderDir(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'shaders'),
    join(app.getAppPath(), '..', 'shaders'),
    join(app.getAppPath(), 'resources', 'shaders')
  ]
  for (const p of candidates) {
    try {
      if (p && existsSync(join(p, 'Anime4K_Clamp_Highlights.glsl'))) return p
    } catch {
      /* ignore */
    }
  }
  return ''
}

/**
 * 目录里真实存在的着色器文件名（升序）。
 *
 * 给设置页的「自定义模式」用：只列真的躺在磁盘上的文件，
 * 免得用户勾了半天、播放时 mpv 报找不到文件。
 */
export function anime4kShaderFiles(): string[] {
  const dir = bundledShaderDir()
  if (!dir) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.glsl'))
      .sort()
  } catch {
    return []
  }
}

/** 当前设置解析出的着色器绝对路径（关闭 / 目录缺失时返回空数组） */
export function anime4kChainPaths(): string[] {
  const s = getSettings().anime4k
  if (!s?.enabled) return []
  const dir = bundledShaderDir()
  if (!dir) return []
  const names = anime4kChain(s.mode ?? 'A', s.tier ?? 'fast', s.custom)
  return names.map((n) => join(dir, n)).filter((p) => existsSync(p))
}

/** 把 -100~100 的微调值夹到 mpv 能接受的范围；非数字返回 null（= 不动这个属性） */
function tuneValue(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.max(-100, Math.min(100, Math.round(v)))
}

/**
 * 上一次真正应用过的画质设置指纹（v0.3.1）。
 *
 * 为什么需要：设置页每次改动都会写一遍 `settings`，而主进程在 store 写入钩子里
 * 顺手重应用画质项（见 ipc.ts）——如果每次都无脑 `glsl-shaders clr + append`，
 * 播放中随便改个**别的**设置（哪怕只是拖一下弹幕透明度）都会让着色器链重建、
 * 掉一帧。指纹相同就什么都不做。
 */
let lastEnhanceKey = ''

/**
 * 实例销毁时要复位的音频指纹（v0.3.6）。
 *
 * 音频指纹本身在 `services/audioSettings.ts` 里维护（那边才有「怎么拼链」的知识），
 * 而 `audioSettings.ts` 已经 import 了本模块（要用 mpvSetAudioFilter）——
 * 本模块再反向 import 就会形成循环依赖。所以这里放一个**回调插槽**：
 * audioSettings 在被主进程加载时注册进来，mpvDestroy 调用它即可。
 * 没注册（例如只在跑 mpv 自检）时就是个空操作，没有副作用。
 */
let audioResetHook: (() => void) | null = null

/** 由 audioSettings 注册「实例销毁后复位音频指纹」的回调 */
export function setAudioResetHook(fn: (() => void) | null): void {
  audioResetHook = fn
}

/** 由 audioSettings 注册「实例就绪后应用音频设置」的回调（避免循环依赖，同 audioResetHook） */
let audioApplyHook: (() => void) | null = null

export function setAudioApplyHook(fn: (() => void) | null): void {
  audioApplyHook = fn
}

/**
 * 把 Anime4K 与画面微调**当场**应用到正在播放的实例（v0.3.1）。
 *
 * 三个调用点：① mpvAttach 建好实例之后；② 用户在设置页改动画质选项（主进程在
 * 通用 store 写入钩子里调，见 ipc.ts 的 storeSet）；③ 播放中新开一集时沿用同一实例，
 * 无需重设 —— 着色器列表是 mpv 的全局属性，不随文件切换而清空。
 *
 * glsl-shaders 用 `change-list` 而不是 `--glsl-shaders`：列表分隔符在 mpv 里有
 * 逗号/分号两种写法（Anime4K 官方配置用分号），走 change-list 一条一条 append
 * 就不必赌分隔符，路径里带空格/中文也不会被拆开。
 *
 * 与上次完全相同的设置会直接返回（见 lastEnhanceKey）；重建实例后由 mpvAttach 复位指纹，
 * 保证新实例一定会被设置一次。
 *
 * @returns 实际挂上的着色器绝对路径（空数组 = 已清空或没有可用着色器）
 */
export function mpvApplyVideoEnhance(): string[] {
  if (!ready || !native) return []
  const s = getSettings().anime4k ?? {}
  const paths = anime4kChainPaths()
  const key = JSON.stringify({
    paths,
    saturation: tuneValue(s.saturation),
    contrast: tuneValue(s.contrast),
    brightness: tuneValue(s.brightness),
    gamma: tuneValue(s.gamma),
    hdr: s.hdr ?? {}
  })
  if (key === lastEnhanceKey) return paths
  lastEnhanceKey = key

  // ① 着色器链：先整体清空再按顺序 append（顺序 = 执行顺序，见 @shared/anime4k）
  try {
    native.command(['change-list', 'glsl-shaders', 'clr', ''])
    for (const p of paths) native.command(['change-list', 'glsl-shaders', 'append', slashPath(p)])
    log.append('info', 'mpv', paths.length ? `Anime4K 已挂载 ${paths.length} 个着色器` : 'Anime4K 着色器已清空')
  } catch (err) {
    log.append('warn', 'mpv', `Anime4K 着色器设置失败: ${String((err as Error)?.message ?? err)}`)
  }

  /*
   * ② 画面微调：这四个都是 mpv 的属性，运行时可改。
   * 值为空/非数字时写回 0（= 原始），用户把滑杆拨回中间就等于恢复原样。
   */
  const props: [string, number][] = [
    ['saturation', tuneValue(s.saturation) ?? 0],
    ['contrast', tuneValue(s.contrast) ?? 0],
    ['brightness', tuneValue(s.brightness) ?? 0],
    ['gamma', tuneValue(s.gamma) ?? 0]
  ]
  for (const [name, value] of props) {
    try {
      native.setProperty(name, value)
    } catch {
      /* 老版本 mpv 没有某个属性就跳过 */
    }
  }

  // ③ HDR：直通 / 色调映射 / 目标峰值
  const hdr = s.hdr ?? {}
  const hdrProps: [string, string | number | boolean][] = [
    ['target-colorspace-hint', hdr.passthrough === true],
    ['tone-mapping', hdr.toneMapping || 'auto'],
    ['target-peak', typeof hdr.targetPeak === 'number' && hdr.targetPeak > 0 ? hdr.targetPeak : 'auto']
  ]
  for (const [name, value] of hdrProps) {
    try {
      native.setProperty(name, value)
    } catch {
      /* 同上 */
    }
  }
  return paths
}

/** 内置着色器是否就位（设置页据此提示「安装目录不完整」） */
export function anime4kAvailable(): boolean {
  return bundledShaderDir() !== ''
}

/** 上一次渲染层推下来的原始状态：Anime4K 在 uosc 菜单里改完之后要拿它重推一次（合并新设置） */
let lastUoscPayload: Record<string, unknown> | null = null
/** 记录最近一次由 uosc 菜单改的画质设置，供自检核对 */
let lastA4kActionLog = ''

/** 把画质设置写回 store（与 ipc.ts 的 storeSet 同一条路，只是不经过渲染层） */
function saveAnime4kSettings(patch: Record<string, unknown>): void {
  const cur = store.get<Record<string, unknown>>('settings', {})
  const prev = (cur.anime4k ?? {}) as Record<string, unknown>
  store.set('settings', { ...cur, anime4k: { ...prev, ...patch } })
}

/**
 * 处理来自 uosc「画质」菜单的动作（v0.3.3）。
 *
 * 支持：`a4k-set <off|A|B|C|AA|BB|CA>`、`a4k-tier <fast|quality>`、`a4k-toggle`、
 * `open-quality-settings`。改完立刻重挂着色器链（播放中即时生效），并把新状态推回控制栏，
 * 让按钮角标与菜单勾选态马上跟手。
 *
 * @returns 是否消费了这个动作（消费了就不再往渲染层派发）
 */
function handleAnime4kUoscAction(raw: string): boolean {
  const [head, arg] = raw.trim().split(/\s+/)
  if (head === 'open-quality-settings') {
    dispatchOverlayAction({ type: 'openQualitySettings' })
    return true
  }
  if (head !== 'a4k-set' && head !== 'a4k-tier' && head !== 'a4k-toggle') return false

  const a4k = getSettings().anime4k ?? {}
  if (head === 'a4k-set') {
    if (arg === 'off') {
      saveAnime4kSettings({ enabled: false })
    } else if (anime4kChain(arg === 'custom' ? 'custom' : (arg as never), a4k.tier ?? 'fast', a4k.custom).length > 0) {
      saveAnime4kSettings({ enabled: true, mode: arg })
    } else {
      log.append('warn', 'mpv', `画质模式无法识别，已忽略: ${arg}`)
      return true
    }
  } else if (head === 'a4k-tier') {
    if (arg !== 'fast' && arg !== 'quality') return true
    saveAnime4kSettings({ tier: arg })
  } else {
    saveAnime4kSettings({ enabled: a4k.enabled !== true })
  }

  const applied = mpvApplyVideoEnhance()
  const now = getSettings().anime4k ?? {}
  lastA4kActionLog = `${raw} → enabled=${now.enabled === true} mode=${now.mode ?? 'A'} tier=${now.tier ?? 'fast'} 链长=${applied.length}`
  log.append('info', 'mpv', `控制栏画质菜单：${lastA4kActionLog}`)
  // 状态回推：控制栏按钮角标 / 菜单勾选态立刻跟着变
  if (lastUoscPayload) mpvPushUoscBar(lastUoscPayload)
  return true
}

/** 自检用：最近一次 uosc 画质菜单动作的处理结果 */
export function anime4kLastUoscAction(): string {
  return lastA4kActionLog
}

/** 把 OverlayAction 发给播放页（供主进程内部直接派发用，例如 uosc 菜单里的「完整画质设置」） */
function dispatchOverlayAction(action: Record<string, unknown>): void {
  try {
    const win = attachedWin
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(CH.overlayAction, action)
    }
  } catch (err) {
    log.append('warn', 'mpv', `动作派发失败: ${String((err as Error)?.message ?? err)}`)
  }
}

/**
 * 让 uosc 把控制栏**立刻显示出来**（v0.3.3）。
 *
 * 用户反馈「在播放器内移动鼠标时无法呼出控制栏」。实测 uosc 的设计是
 * **只有鼠标靠近底部（proximity_in 像素内）才显示**控制栏（见 Element.lua 的 get_visibility），
 * 在画面中间移动鼠标它按设计就不出来；再加上「鼠标事件能不能到 mpv」本身还受窗口层级影响，
 * 光靠 mpv 自己的鼠标处理不可靠。
 *
 * 所以这里由**应用侧主动唤出**：播放页/悬浮窗每次看到鼠标移动就调一次这个方法，
 * 它执行 uosc 自带的 `script-binding uosc/flash-ui`（强制显示 1 秒，见 uosc main.lua）。
 * flash 持续 1 秒，这里按 900ms 节流，避免鼠标一动就狂发命令。
 */
export function mpvRevealUoscUi(): boolean {
  if (!ready || !native || !uoscBarLoaded) return false
  /*
   * v1.5 需求 ④：**画面没出来就不唤出控制栏**。
   *
   * 渲染层那一侧已经拦了（PlayerOverlayPage 的 poke 直接 return，不再调这个接口），
   * 这里再拦一道是「唯一入口」层面的保证：只要还没有画面，无论谁调这个接口都不会
   * 让 uosc 把控制栏闪出来。判据与弹幕门控同源（mpvHasPicture = 首帧 width>0）。
   * 不涉及 uosc 的任何配置/元素 —— 被拒绝的是**我们的**唤出请求。
   */
  if (!mpvHasPicture()) return false
  const now = Date.now()
  if (now - lastRevealAt < 900) return true
  lastRevealAt = now
  let ok = false
  try {
    /*
     * 两条路都发，互为保险（uosc 两个入口都是它自己注册的，不是我们编的）：
     *  ① `script-binding uosc/flash-ui`：uosc main.lua 里 bind_command('flash-ui', …) 注册的命名键位，
     *     效果同它自己的快捷键（强制显示 timeline/controls/volume/top_bar 各 1 秒）；
     *  ② `script-message-to uosc flash-elements …`：uosc 专门为**外部脚本**注册的消息入口
     *     （main.lua: `mp.register_script_message('flash-elements', …)`），语义相同。
     * 两条都失败也不报错到界面 —— 用户还有 Tab 键与「靠近底部自动浮现」两条路。
     */
    const a = native.command(['script-binding', 'uosc/flash-ui'])
    const b = native.command([
      'script-message-to',
      'uosc',
      'flash-elements',
      'timeline,controls,volume,top_bar'
    ])
    ok = a || b
    if (!ok) log.append('warn', 'mpv', '唤出 uosc 控制栏被拒（flash-ui 与 flash-elements 都没成功）')
    return ok
  } catch (err) {
    log.append('warn', 'mpv', `唤出 uosc 控制栏异常: ${String((err as Error)?.message ?? err)}`)
    return false
  }
}

/** 自检用：绕过节流强制唤出一次（验证「应用侧唤出」这条路真的能让 uosc 画出控制栏） */
export function mpvRevealUoscUiForTest(): boolean {
  lastRevealAt = 0
  return mpvRevealUoscUi()
}

/**
 * 自检用：给 mpv 脚本发一条 script-message（例如让桥接脚本打开「画质」菜单）。
 * 业务代码不要用它 —— 正常路径都是通过属性/状态推下来的。
 */
export function mpvSendScriptMessage(args: string[]): boolean {
  if (!ready || !native) return false
  try {
    return native.command(['script-message', ...args])
  } catch {
    return false
  }
}

/** 自检用：画一条 OSD 文字（用来验证「subtitles 档截图到底拍不拍得到 OSD 层」） */
export function mpvShowTextForTest(text: string): boolean {
  if (!ready || !native) return false
  try {
    return native.command(['show-text', text, '4000'])
  } catch {
    return false
  }
}

/**
 * 自检用：直接写一条「控制栏动作」（等价于用户点了 uosc 菜单项 / 按钮）。
 *
 * 真实路径是：桥接脚本把动作写进 `user-data/sakana-ctrl`，主进程的 250ms 轮询读走并派发。
 * 这里就是替脚本写一次 —— 走的完全是同一条消费路径。
 */
export function mpvSetCtrlPropForTest(raw: string): boolean {
  if (!ready || !native) return false
  try {
    return native.setProperty(UOSC_CTRL_PROP, raw)
  } catch {
    return false
  }
}

/** 上一次主动唤出控制栏的时间（节流用） */
let lastRevealAt = 0

/**
 * 只读探测若干 mpv 属性（**仅供自检**：SAKANA_ANIME4K_TEST 用它证明
 * 「着色器链真的进了 mpv」而不是只在我们这边拼好了字符串）。
 */
export function mpvProbeProperties(names: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!ready || !native) return out
  for (const n of names) {
    try {
      out[n] = native.getProperty(n)
    } catch (err) {
      out[n] = `<读取失败: ${String((err as Error)?.message ?? err)}>`
    }
  }
  return out
}

/**
 * 试设一条 `af` 链并把 mpv 的错误原样带回来（**仅供自检**：SAKANA_AUDIO_TEST）。
 *
 * 为什么需要：`af` 里写了 mpv 不认识的滤镜时，`mpv_command` 会**同步返回错误**
 * （native 的 `command()` 返回 false 并把 `mpv_error_string` 放进 `lastError()`），
 * 这正是判断「这个滤镜在 libmpv 里到底有没有」的最可靠办法 ——
 * 比翻 DLL 里的字符串靠谱得多（那些字符串可能只是别处的引用）。
 *
 * @returns `{ ok, error }`；error 为 mpv 的原始错误字符串（含 `No such filter` 之类）
 */
export function mpvTryAudioFilter(chain: string): { ok: boolean; error: string } {
  if (!ready || !native) return { ok: false, error: '播放器未就绪' }
  try {
    const ok = chain
      ? native.command(['af', 'set', chain])
      : native.command(['af', 'clr'])
    return { ok, error: ok ? '' : native.lastError?.() || '命令被拒' }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/** 读回当前 `af` 链（自检用；mpv 会把它规范化后返回） */
export function mpvCurrentAudioFilter(): string {
  if (!ready || !native) return ''
  try {
    const v = native.getProperty('af')
    return typeof v === 'string' ? v : JSON.stringify(v ?? '')
  } catch {
    return ''
  }
}

/**
 * 设置 `af` 链（音频服务用）。
 * `chain` 为空串 = 清空滤镜链（**不能**用 `af set ""`，mpv 会报错）。
 */
export function mpvSetAudioFilter(chain: string): { ok: boolean; error: string } {
  if (!ready || !native) return { ok: false, error: '播放器未就绪' }
  try {
    const ok = chain ? native.command(['af', 'set', chain]) : native.command(['af', 'clr'])
    return { ok, error: ok ? '' : native.lastError?.() || '命令被拒' }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/**
 * 直接设音量属性（音频服务用；与 `mpvSetVolume` 的区别是不再做 0~1 的语义换算，
 * 收窄逻辑统一在 `@shared/audio` 里做过了）。
 */
export function mpvSetVolumeRaw(volume: number): void {
  if (!ready || !native) return
  const v = Math.max(0, Math.min(VOLUME_MAX, Math.round(volume)))
  native.setProperty('volume', v)
}

/**
 * 把当前画面存成 PNG（**仅供自检**：SAKANA_ANIME4K_TEST / SAKANA_UOSC_TEST 用它对比
 * 「开着色器 / 关着色器」或「控制栏显示 / 未显示」两块画面是否真的不同）。
 *
 * @param mode `video` = 不含 OSD（对比画质用）；`subtitles` = **包含 OSD**，
 *             uosc 的控制栏与菜单都画在 OSD 层上，所以验证控制栏必须用这一档。
 */
export function mpvScreenshotToFile(file: string, mode: 'video' | 'subtitles' = 'video'): boolean {
  if (!ready || !native) return false
  try {
    return native.command(['screenshot-to-file', file, mode])
  } catch {
    return false
  }
}

/* ─────────────────── 嵌入 ─────────────────── */

/** 嵌入 libmpv（在播放器视频区域创建输出子窗口） */
export function mpvAttach(win: BrowserWindow, bounds: MpvBounds): { ok: boolean; message: string } {
  const mod = loadNative()
  if (!mod) return { ok: false, message: '未找到 libmpv 运行时或原生插件（请运行 npm run libmpv:fetch）' }
  currentBounds = toPhysical(win, bounds)
  const bili = biliDanmakuConfig()
  // 两件不同的事：控制栏交给 uosc（默认开）／弹幕交给 uosc_danmaku 插件（设置里选）
  const wantUoscDanmaku = uoscDanmakuRequested()
  const wantUoscBar = uoscControlBarRequested()
  /*
   * config-dir **必须无条件给上**（v0.3.6 修的一个严重 bug）。
   *
   * 老代码是 `wantUoscDanmaku || wantUoscBar ? bundledMpvConfigDir() : ''` ——
   * 也就是「不用 uosc 就不给 config-dir」。而 v0.3.3 起 uosc **默认关闭**（控制栏改回应用自建），
   * 于是这条链整条断掉，后果比「少个配置文件」严重得多：
   *
   *   config-dir 没给 → mpv 用默认配置目录 → `config=yes` 也读不到我们的
   *   `resources/mpv-config/input.conf` → **input.conf 里的全部快捷键都不存在**：
   *     · `ESC`  → 应用侧的「退出全屏 / 退出播放」收不到（用户报「按 esc 也无法退出播放器」）
   *     · `q`    → 退出播放失效
   *     · `f`    → 全屏切换失效
   *     · `l/c/x/a/d/i/s` 等 → 选集/线路/字幕/倍速/比例/详情/截图 菜单全部失效
   *   只剩下 mpv **内置**的默认键位还在（SPACE 播放暂停、↑↓ 音量、m 静音）——
   *   这与用户描述的「按钮失灵、但快捷键还有效」完全吻合。
   *   注意这里说的是 **mpv 侧**的快捷键：应用侧那套是渲染层监听 keydown，
   *   只在 Electron 窗口有键盘焦点时生效；用户点过画面之后焦点在 mpv 子窗口上，
   *   所以那时能救场的只有 input.conf。两套是互补的，缺一套就等于没有。
   *
   * 现在无条件给 config-dir：它同时被 `config=yes` 用来定位
   * `input.conf`（快捷键）与 `script-opts/uosc.conf`（uosc 布局/字体）。
   * 不给 uosc 也不会多出任何东西 —— `load-scripts=no` 已经保证 scripts/ 目录不会被自动扫描。
   */
  const cfgDir = bundledMpvConfigDir()
  /** 真正交给 mpv 的 config-dir：安装目录可写时就是它，否则是临时镜像目录（见 prepareUoscConf） */
  let runtimeCfgDir = cfgDir
  if (!cfgDir) {
    log.append('warn', 'mpv', '未找到内置 mpv 配置目录：播放器的键盘快捷键（含 ESC 退出）会全部失效')
  } else {
    /*
     * uosc 只在**加载时**读一次 script-opts/uosc.conf（5.13 没有 set-option 消息），
     * 所以必须在 mpv 初始化之前把配色写进去。放在 create 之前不是"顺手"：
     * create 内部就会 mpv_initialize，uosc 的 read_options 发生在脚本加载时，但字体/配置
     * 目录的解析从初始化就开始了；早写只有好处，晚写就可能这一轮还是旧颜色。
     */
    runtimeCfgDir = prepareUoscConf(cfgDir)
  }
  /*
   * thumbfast 的独立 mpv 必须在 mpv 初始化之前就位：
   *   · exe 路径要写进 `<config-dir>/script-opts/thumbfast.conf` 的 mpv_path；
   *   · thumbfast 在 `load-script` 时立刻 read_options，晚写这一轮就还是默认的 "mpv"。
   *
   * 缺 exe 时 logThumbfastMpv() 已经 warn 过；这里把 thumbfastScript 置空，
   * loadUoscPlugins 会**跳过** thumbfast —— 不让它在画面上弹 spawn 失败的错误。
   * 缺 thumbfast.lua 是另一种原因（安装目录不完整），单独 warn 一句便于区分。
   */
  const thumbfastExe = logThumbfastMpv()
  const thumbfastLua = thumbfastExe ? bundledScript('thumbfast.lua') : ''
  if (thumbfastExe && !thumbfastLua) {
    log.append('warn', 'mpv', '找不到 resources/mpv-scripts/thumbfast.lua：进度条悬停缩略图不可用')
  }
  const thumbfastReady = !!thumbfastLua && prepareThumbfastConf(runtimeCfgDir, thumbfastExe)
  const thumbfastScript = thumbfastReady ? thumbfastLua : ''
  let hwnd: Buffer | undefined
  try {
    hwnd = win.getNativeWindowHandle()
  } catch {
    hwnd = undefined
  }
  /*
   * 选项组装：verbose 日志 + B 站弹幕脚本 + uosc 控制栏。
   * 所有选项都要在 create 之前给（脚本会在 load-script 时立刻 read_options，
   * 之后再改就来不及了）。
   */
  const scriptOptsParts = [bili.options['script-opts'], wantUoscDanmaku ? uoscScriptOpts() : ''].filter(Boolean)
  /*
   * Anime4K / 画面微调（v0.3.1）：能当选项给的就直接在建实例时给上
   * （第一帧就带上，不会出现「先原画闪一下再变清晰」）；
   * 着色器链必须在实例就绪后用 change-list 追加，见下面的 mpvApplyVideoEnhance()。
   */
  const a4k = getSettings().anime4k ?? {}
  const a4kHdr = a4k.hdr ?? {}
  const a4kOpts: Record<string, string> = {
    ...(tuneValue(a4k.saturation) !== null ? { saturation: String(tuneValue(a4k.saturation)) } : {}),
    ...(tuneValue(a4k.contrast) !== null ? { contrast: String(tuneValue(a4k.contrast)) } : {}),
    ...(tuneValue(a4k.brightness) !== null ? { brightness: String(tuneValue(a4k.brightness)) } : {}),
    ...(tuneValue(a4k.gamma) !== null ? { gamma: String(tuneValue(a4k.gamma)) } : {}),
    ...(a4kHdr.passthrough === true ? { 'target-colorspace-hint': 'yes' } : {}),
    ...(a4kHdr.toneMapping ? { 'tone-mapping': a4kHdr.toneMapping } : {}),
    ...(typeof a4kHdr.targetPeak === 'number' && a4kHdr.targetPeak > 0 ? { 'target-peak': String(a4kHdr.targetPeak) } : {})
  }
  const ok = mod.create({
    x: currentBounds.x,
    y: currentBounds.y,
    width: currentBounds.width,
    height: currentBounds.height,
    parentHwnd: hwnd,
    options: {
      ...(process.env.SAKANA_MPV_VERBOSE ? { terminal: 'yes', 'msg-level': 'all=v' } : {}),
      ...bili.options,
      ...a4kOpts,
      /*
       * ── v0.2.18「uosc 接管控制栏」新增的启动参数，四条都必要 ──
       *
       * osc=no：mpv 自带的 OSC 与 uosc 是两套东西（uosc 自己也会设一次）。
       *   这里显式给上：一是不依赖插件去关，二是防止将来 addon 默认值变化时静默多出一套控制栏。
       *
       * config=yes：**这条是整件事的前提**。libmpv 默认 config=no（addon.cc 里也设过），
       *   此时 `mp.find_config_file()` 一律返回 nil，连
       *   `<config-dir>/script-opts/uosc.conf`（布局/按钮/时间显示）与
       *   `<config-dir>/input.conf`（快捷键）都不会被读到 —— 无窗口探针实测。
       *   开启后 uosc 启动日志会打印 `Opened config file script-opts/uosc.conf.`。
       *
       * load-scripts=no：**必须显式关掉**。libmpv 下这个选项默认是 yes，配合 config=yes
       *   会在 mpv_initialize 时自动扫描 `<config-dir>/scripts/` 把 uosc 与 uosc_danmaku
       *   各加载一份，我们再 load-script 一次就会有两套控制栏（探针实测到这个坑）。
       *
       * config-dir=<安装目录>/resources/mpv-config：定位上面两个文件，
       *   同时 uosc 的图标字体（uosc.conf 里的 MaterialIconsRound）也从
       *   `<config-dir>/fonts` 取。开发态与打包态路径不同，由 bundledMpvConfigDir() 负责。
       */
      osc: 'no',
      'load-scripts': 'no',
      // v0.3.6：音量上限抬到 200%（用户反馈 100% 偏小）；不设这条的话 volume 会被夹回 100
      'volume-max': String(VOLUME_MAX),
      /*
       * ── v0.3.9：方案二实验开关（默认关闭）──
       *
       * 用户在工单里提的方案二：`--input-cursor-passthrough=yes`（mpv 把落在自己窗口上的
       * 鼠标事件透传给**下面**的窗口，而不是自己处理）。
       *
       * 为什么默认关、只做实验开关：
       *   ① 方向不对症 —— 本项目「按钮点不动」的根因是**悬浮窗在 mpv 之上**（见
       *      playerOverlay.ts 的文件头）。这个选项解决的是"mpv 在别人之上、想把手让给下面"，
       *      与"上面那层要不要把手让给 mpv"是相反的箭头；
       *   ② 它会把鼠标从 mpv 手里拿走（uosc 的按钮/进度条拖动全靠 mpv 收鼠标），
       *      开着它反而可能让控制栏和 uosc 都点不动。
       *   ③ **实测结论（v0.3.9，本机）**：这条选项在随包的 libmpv 里**存在**
       *      （120MB 的 libmpv-2.dll 里有 `input-cursor-passthrough` 字符串），加上它之后
       *      mpv 也能正常初始化（嵌入成功、uosc 照常加载），但视频子窗口的**扩展样式没有变化**：
       *      开与不开都是 `ex=0x4`（WS_EX_NOPARENTNOTIFY），**没有出现 `WS_EX_TRANSPARENT(0x20)`**，
       *      `WindowFromPoint` 的命中结果也完全一样。原因是本项目用 `--wid` 把 mpv 嵌进
       *      **我们自己创建的**子窗口（native/mpv/src/addon.cc 的 CreateChildWindow），
       *      mpv 不拥有那个窗口，窗口级选项落不到它身上。
       *      复现：`SAKANA_UOSC_TEST=<视频> SAKANA_UOSC_HOLD=6 electron .` 跑两次（第二次加
       *      `SAKANA_MPV_CURSOR_PASSTHROUGH=1`），对比日志里的 `[uosc-test] 窗口树=` 一行（含 `ex`）。
       *      ⇒ 所以这条**不作为**修复手段，只留成实验开关，默认关闭。
       *
       * 注意：addon.cc 里 `mpv_set_option_string` 的返回值是**不检查**的（见 addon.cc:302），
       * 所以即使这条选项在某个 libmpv 版本里不存在，也只会被忽略，不会导致初始化失败。
       */
      ...(process.env.SAKANA_MPV_CURSOR_PASSTHROUGH ? { 'input-cursor-passthrough': 'yes' } : {}),
      /*
       * ── v1.2.1：关掉 mpv 自带的「左键拖窗口」──
       *
       * 这一版把 mpv 的 VO 子窗口重新设成可接收鼠标（见 ensureMpvInputWindow），
       * uosc 的按钮/进度条才能真正收到点击。但 mpv 的 WndProc 里还有一条默认行为：
       * 左键按在画面上且不在任何控件上时，它执行
       * `SendMessage(hWnd, WM_NCLBUTTONDOWN, HTCAPTION)` 来拖动窗口。
       * 对独立 mpv 窗口这是正常功能，对我们这个**嵌在 Electron 里的子窗口**则是灾难：
       * 拖一下画面就会把视频子窗口从父窗口里拖走，画面与上报的 videoRect 永久错位。
       *
       * `window-dragging=no` 让 `mp_input_test_dragging()` 恒为 true，那条分支就不执行；
       * uosc 与 input.conf 的鼠标绑定不受影响（它们走的是 input 层的按键绑定）。
       * 窗口拖动本来就该由 Electron 自己的标题栏负责，mpv 不需要也不应该插手。
       */
      'window-dragging': 'no',
      ...(runtimeCfgDir ? { 'config-dir': slashPath(runtimeCfgDir), config: 'yes' } : {}),
      ...(scriptOptsParts.length > 0 ? { 'script-opts': scriptOptsParts.join(',') } : {})
    }
  })
  if (!ok) {
    log.append('error', 'mpv', `libmpv 初始化失败: ${mod.lastError()}`)
    return { ok: false, message: mod.lastError() || 'libmpv 初始化失败' }
  }
  /*
   * B 站弹幕脚本用**运行时命令**加载：libmpv 不接受 `script` 选项（见 biliDanmakuConfig 注释）。
   * 一次实例只加载一次 —— create() 在实例已存在时只更新尺寸，重复加载会出现两份脚本、
   * 弹幕被 sub-add 两次。
   */
  if (bili.scriptPath && !biliScriptLoaded) {
    let loaded = false
    try {
      loaded = mod.command(['load-script', bili.scriptPath])
    } catch (err) {
      log.append('warn', 'mpv', `加载 B 站弹幕脚本异常: ${String((err as Error)?.message ?? err)}`)
    }
    biliScriptLoaded = loaded
    log.append(
      loaded ? 'info' : 'warn',
      'mpv',
      loaded ? 'B 站弹幕脚本已加载（load-script）' : 'B 站弹幕脚本加载失败（load-script 命令被拒）'
    )
  }
  /*
   * uosc 控制栏三件套：同样只加载一次（create() 在实例已存在时只更新尺寸，
   * 重复 load-script 会出现两套控制栏 / 两份弹幕插件）。
   * v0.3.6：cfgDir 现在**无条件存在**，所以要显式判断「用户到底要不要 uosc」，
   * 否则默认关闭 uosc 的机器上会被塞进一套用不上的控制栏（还会抢走鼠标）。
   */
  if (cfgDir && !uoscBarLoaded && (wantUoscBar || wantUoscDanmaku)) {
    loadUoscPlugins(mod, cfgDir, wantUoscDanmaku, wantUoscBar, thumbfastScript)
  }
  /*
   * thumbfast 状态监听放在 create() 成功之后：它写的是 `<config-dir>/script-opts/thumbfast-status.json`，
   * 只有 uosc 真的会加载 thumbfast 时才有意义。放在这里也避免「初始化失败但 watcher 还在轮询」的泄漏。
   * 监听目录必须是 runtimeCfgDir —— prepareThumbfastConf 写配置的同一个目录，
   * thumbfast.lua 里 `~~/script-opts/thumbfast-status.json` 展开到的就是这里。
   */
  if (thumbfastReady && (wantUoscBar || wantUoscDanmaku)) {
    watchThumbfastStatus(runtimeCfgDir)
  }
  /*
   * Anime4K 着色器（v0.3.1）：实例就绪后按设置的链挂上。
   * 放在这里而不是 options 里，是因为列表选项的分隔符在 mpv 里有讲究，
   * 用 change-list 逐条 append 更稳（见 mpvApplyVideoEnhance 的注释）。
   * 先复位指纹：新实例（或重进播放页）必须重新设置一次，不能被「和上次一样」挡掉。
   */
  lastEnhanceKey = ''
  mpvApplyVideoEnhance()
  /*
   * 音频（v0.3.6）：实例就绪后按设置挂上滤镜链并设音量。
   * 同样先复位指纹 —— 滤镜链挂在实例上，新实例什么都不剩（见 audioSettings 的注释）。
   * 放在 Anime4K 之后没有依赖关系，只是让日志顺序保持「先画质后音频」。
   */
  try {
    audioApplyHook?.()
  } catch (err) {
    log.append('warn', 'mpv', `音频设置应用失败: ${String((err as Error)?.message ?? err)}`)
  }
  attachedWin = win
  lastPlaying = false
  lastLength = 0
  lastEof = false
  lastUoscBarJson = ''
  lastUoscStatusPushAt = 0
  surfaceVisible = true
  /*
   * v1.2.1：新实例/新窗口，mpv 的 VO 子窗口会重新创建（而且默认又是 disabled），
   * 输入窗口的缓存必须清零，由 250ms 泵重新找并重新启用。
   */
  inputHwnd = 0
  inputHwndEnabled = false
  inputCheckAt = 0
  inputLastFailure = ''
  startTimePump(win)
  startRaiseWatch(win)
  startCursorWatch(win)
  log.append('info', 'mpv', 'libmpv 已嵌入（页面渲染窗口内）')
  return { ok: true, message: 'libmpv 已就绪' }
}

/** 显示/隐藏视频输出窗口（探针网页视图需要同区域显示时必须隐藏） */
export function mpvSetSurfaceVisible(visible: boolean): void {
  surfaceVisible = visible
  if (!ready || !native) return
  try {
    native.setVisible(visible)
  } catch {
    /* ignore */
  }
  if (visible) {
    lastRaiseAt = 0
    raiseSurface()
  }
}

/**
 * 当前视频子窗口的 bounds（自检用）。
 *
 * 为什么要暴露它：用户报「退出播放器后卡在播放内容空白」——
 * 视频是**主窗口的原生 WS_CHILD 子窗口**，窗口退出全屏后如果它没有跟着 resize，
 * 就会比窗口还大（只显示画面左上角一块）或者位置错位（整块黑）。
 * 把每一步的 bounds 打出来，就能一眼看出是"没跟着改"还是"renderer 没上报"。
 */
export function mpvDiagnosticBounds(): MpvBounds | null {
  if (!currentBounds) return null
  return { ...currentBounds }
}

/**
 * 画面区域的最小可用尺寸（CSS px）。
 *
 * 为什么需要这条下限：视频不是网页画的，而是主窗口里的一个原生子窗口，
 * 它**只认渲染层上报的那个矩形**。而页面在「布局还没稳 / 抽屉展开动画中途 /
 * 全屏切换的两帧之间」会量到一个退化矩形（0 宽或几像素），照它 resize 的后果是
 * 画面窗口被缩成 1px —— **声音照常、画面看不见**（用户报的「有声音没画面」里最隐蔽的一类）。
 * 正常播放区的宽高都不可能小于 16px，所以这个判据不会误伤真正的布局变化。
 */
const MIN_SURFACE_PX = 16

let lastDegenerateBoundsLog = ''

export function mpvSetBounds(bounds: MpvBounds): void {
  if (!ready || !native || !attachedWin) return
  if (!(bounds.width >= MIN_SURFACE_PX) || !(bounds.height >= MIN_SURFACE_PX)) {
    /*
     * 退化矩形：**忽略，保留上一次可用矩形**（不写 currentBounds，也就不动窗口）。
     * 记一行日志（同样的退化值只记一次），这样「有没有发生过」「发生的是哪种」事后可查；
     * 但绝不把它当成新的画面区域 —— 那正是把画面弄丢的做法。
     */
    const key = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)}x${Math.round(bounds.height)}`
    if (key !== lastDegenerateBoundsLog) {
      lastDegenerateBoundsLog = key
      log.append(
        'warn',
        'mpv',
        `忽略退化的画面区域上报（${key}）：低于 ${MIN_SURFACE_PX}px 不可能是真实布局，继续用 ${
          currentBounds ? `${currentBounds.width}x${currentBounds.height}` : '未设置'
        }`
      )
    }
    return
  }
  lastDegenerateBoundsLog = ''
  currentBounds = toPhysical(attachedWin, bounds)
  try {
    native.resize(currentBounds)
  } catch {
    /* ignore */
  }
}

/**
 * 播放内核的现场读数（v0.3.9 自检用）。
 *
 * 用户报的两类现象之一就是「播放器销毁后没重建，界面却以为还在播」。
 * 判定它必须能看到**主进程侧**的真实情况：内核实例在不在（ready/native）、
 * 挂载的目标窗口是不是已经销毁（attachedWin.isDestroyed）、有没有留下尺寸记录。
 * 这几个变量都是模块私有的，所以由模块导出读数，自检再据此决定要不要重建。
 */
export function mpvDiagnostics(): {
  nativeLoaded: boolean
  ready: boolean
  attached: boolean
  attachedDestroyed: boolean
  hasBounds: boolean
  surfaceVisible: boolean
  hasPicture: boolean
  timePumpRunning: boolean
  /**
   * v1.2.1：uosc 能不能收到鼠标的**前提**（mpv 的 VO 子窗口是否已从 disabled 恢复）。
   * 自检与排障要能把「按钮没反应」分成两类：窗口根本没启用（本字段 false） versus
   * 窗口已启用但 uosc/动作链还有别的问题。只报事实，不下结论。
   */
  inputWindow: { hwnd: number; hwndHex: string; enabled: boolean; backendAvailable: boolean }
} {
  const inputWindow = mpvInputWindowState()
  return {
    nativeLoaded: native !== null,
    ready,
    attached: attachedWin !== null,
    /*
     * 「attach 目标窗口已销毁」是最典型的错配：main 这边还攥着一个死窗口，
     * 渲染层却以为画面在自己的窗口里 —— 于是所有后续 setBounds/raise 都作用在尸体上，
     * 用户看到的就是「有声音没画面」或「操作没反应」。
     */
    attachedDestroyed: !!attachedWin && attachedWin.isDestroyed(),
    hasBounds: currentBounds !== null,
    surfaceVisible,
    hasPicture: lastHadPicture,
    timePumpRunning: timeTimer !== null,
    inputWindow: {
      hwnd: inputWindow.hwnd,
      hwndHex: inputWindow.hwndHex,
      enabled: inputWindow.enabled,
      backendAvailable: inputWindow.backend.available
    }
  }
}

/**
 * 「到底有没有画面」的现场（v0.3.9，供 surfaceDebug / 自检读）。
 *
 * 这是判「有声音没画面」归属的**唯一硬数据**：
 *   · `hasPicture=false` 且 `audioOnlyMs>0` → 画面根本没解出来（流/解码问题）；
 *   · `hasPicture=true` 而用户仍看不到 → 那是窗口层的问题（子窗口被盖住/尺寸/可见性），
 *     配合 `mpvDiagnostics()` 与 `mpvHitTest()` 继续查。
 * 没有这两个字段时，用户报「没有画面」我们只能猜；有了它，一次截图就能定性。
 */
export function mpvSurfaceInfo(): {
  width: number
  height: number
  videoCodec: string
  audioCodec: string
  hasPicture: boolean
  audioOnlyMs: number
  audioOnlyReason: string
} {
  return {
    width: videoWidth(),
    height: (() => {
      try {
        const v = Number(native?.getProperty('height'))
        return Number.isFinite(v) && v > 0 ? Math.round(v) : 0
      } catch {
        return 0
      }
    })(),
    videoCodec: mpvStringProp('video-codec'),
    audioCodec: mpvStringProp('audio-codec'),
    hasPicture: lastHadPicture,
    audioOnlyMs: audioOnly.ms,
    audioOnlyReason: audioOnly.concluded
      ? audioOnly.videoTrack
        ? `已解出音频但视频轨（${audioOnly.videoTrack}）没有画面`
        : '已解出音频但没有视频轨（流里只有音频）'
      : ''
  }
}

/**
 * 把地址真正交给内核（loadfile）。
 *
 * `swap=true` 是 v1.3 新增的「换候选/接加速」路径，与首次装载的区别只有两点，
 * 但两点都不能少：
 *   · **不调用 `beginStage('inject')`** —— 那会重新武装 15 秒注入看门狗。
 *     换候选只是同一轮里的重试，必须让总兜底仍然是「首次装载后 15 秒」，
 *     否则三个候选就能把用户拖到 45 秒；
 *   · **不重置累计流量**，只把「当前候选」的字节基线挪到此刻。
 */
/**
 * 日志/界面上显示「交给内核的地址」时的脱敏（v1.4）。
 *
 * 本地临时缓存交给内核的是**本机地址**（127.0.0.1 上的 /cache/<id>）。
 * 红线是不许在日志与界面出现内部接口地址，所以这里只显示「会话号」，
 * 其它地址保持原样（上游地址本来就会被 log.append 的脱敏规则打码）。
 * 注意只做展示，不改变真正 loadfile 的 path。
 */
function displaySource(path: string): string {
  const m = /^https?:\/\/127\.0\.0\.1:\d+\/cache\/([A-Za-z0-9_-]+)/.exec(path)
  return m ? `本机临时缓存（会话 ${m[1].slice(0, 8)}）` : path.slice(0, 130)
}

/**
 * 把请求头序列化成 mpv 的 `http-header-fields` 值。
 *
 * 为什么不能直接 `join(',')`：这是 mpv 的**字符串列表**选项，逗号是列表分隔符；
 * BROWSER_UA 里的 "(KHTML, like Gecko)" 带逗号，直接拼会被 mpv 拆成两个头
 * （第二个没有冒号，等于 UA 被截断），Referer/Cookie 也会跟着错位。
 * 按 mpv 的规则把值里的反斜杠、逗号转义，读回来（包括 thumbfast 子进程）
 * 才是同一组头。thumbfast.lua 里也照这个规则反向读取。
 */
function joinMpvHeaderFields(headers: string[]): string {
  return headers.map((h) => h.replace(/\\/g, '\\\\').replace(/,/g, '\\,')).join(',')
}

function loadSource(
  path: string,
  referer: string | undefined,
  cookies: string | undefined,
  opts: { swap?: boolean; reason?: string } = {}
): boolean {
  if (!ready || !native) throw new Error('libmpv 尚未就绪')
  const headers: string[] = []
  // 必须带浏览器 UA：libVLC 路径（:http-user-agent）与 FFmpeg 中转（-user_agent）都发浏览器 UA，
  // 只有 mpv 默认会发 "libmpv"——不少 CDN/WAF 会因此拒流，
  // 表现为「校验地址可用（校验用浏览器 UA）但内核拿到地址却播不出来」。
  headers.push(`User-Agent: ${BROWSER_UA}`)
  if (referer) headers.push(`Referer: ${referer}`)
  if (cookies) headers.push(`Cookie: ${cookies}`)
  native.setProperty('http-header-fields', joinMpvHeaderFields(headers))
  // 新一次载入：重置状态基线，确保开播时一定会重新发出 playing 事件
  lastPlaying = false
  lastEof = false
  lastLength = 0
  lastHadPicture = false
  resetAudioOnly()
  /*
   * v1.5 需求 ①：换媒体 = 画面回到"还没有"。
   *
   * 必须在这里显式发一次 false（而不是等渲染层自己发现）：渲染层要立刻收起弹幕层、
   * 收起控制栏、把加载进度重新显示出来；等它按 800ms 轮询察觉就晚了 ——
   * 那一段时间里屏幕上会出现"上一集的最后一帧 + 上一集的弹幕 + 控制栏"。
   * 与 startTimePump 里的 true 是同一个字段、同一个来源（lastHadPicture）。
   */
  sendEvent(attachedWin, { type: 'picture', hasPicture: false })
  // 新媒体的视频输出窗口会在首帧时重建，届时需要再挂一次
  pendingReparent = true
  if (!opts.swap) {
    resetNetSampling()
    candidateBytesBase = 0
    boostSwapped = false
    /*
     * 新一集：清掉 thumbfast 状态去重键，让「缩略图已生成/失败」至少再记一行。
     * 只在新装载（不是换候选）时清 —— 换候选不换集，重复记同一条会刷日志。
     */
    lastThumbfastStatusKey = ''
    markPlayTiming('loadfile')
    /*
     * v0.3.9：「注入播放器」阶段从这里开始计时 ——
     * 这才是真正「把播放资源交给播放器」的那一刻（loadfile），
     * 之前的嗅探/校验都属于「获取播放资源」。阶段完成要等 startTimePump 看到首帧。
     */
    beginStage('inject', '正在把播放资源交给播放内核（loadfile）')
    pushStep('inject', `交给内核：${displaySource(path)}${referer ? `（带 Referer）` : ''}${cookies ? '（带 Cookie）' : ''}`)
  } else {
    /*
     * 换候选也必须**重置网络采样**。
     *
     * 为什么（v1.3 实测踩到的）：`netBytes` 是「已预读字节」的单调值，
     * 换源后内核从头开始报，`Math.max(旧值, 新值)` 会永远停在旧值上 ——
     * 于是「这个候选收到多少字节」恒为 0，5 秒零字节规则会把一条**正常的新地址**
     * 每 5 秒换掉一次。现在每次 loadfile 都从 0 起算，判据只属于当前候选。
     */
    resetNetSampling()
    candidateBytesBase = 0
    pushStep('inject', `切换播放源（${opts.reason ?? '换候选'}）：${path.slice(0, 90)}`)
  }
  candidateLoadedAt = Date.now()
  const loaded = native.command(['loadfile', path, 'replace'])
  /*
   * ⚠️ v0.2.7 附加 修「抓到了视频流却一直不播 / 连播与选集之后再也播不出来」。
   *
   * mpv 的 `loadfile` **会继承当前的 `pause` 状态**（这是 mpv 的既有行为）。
   * 而我们的切集流程是「先暂停当前播放 → 重新挂载播放页 → 抓到新流后交给内核」，
   * 于是新一集载入后直接停在 0 秒：内核明明在取流（日志能看到 m3u8 请求与分片），
   * UI 却是「已暂停 00:00」；15 秒看门狗判定「直连未开播」→ 重试 → 仍然暂停，
   * 于是一旦发生过一次切集，后面每一次播放都起不来（用户反馈的「所有规则都跑不通」就是这个）。
   * 载入成功后必须显式解除暂停。
   */
  if (loaded) {
    try {
      native.setProperty('pause', false)
    } catch {
      /* ignore */
    }
  }
  log.append(
    'info',
    'mpv',
    loaded
      ? `libmpv 取流${opts.swap ? `（切换：${opts.reason ?? '换候选'}）` : ''}: ${displaySource(path)} | Referer=${referer ? referer.slice(0, 60) : '(不带)'} Cookie=${cookies ? `${cookies.length} 字符` : '(无)'}`
      : `libmpv 取流失败${opts.swap ? `（切换：${opts.reason ?? '换候选'}）` : ''}: ${displaySource(path)} → ${native.lastError()}`
  )
  /*
   * 首次装载被内核当场拒绝：这是**确定性的失败**，不用等 15s 看门狗。
   * 立刻结束本轮并给出原因（用户看到的必须是一句「注入失败：…」而不是一直转圈）。
   * 换候选失败则只记日志：还有下一个候选 / 15 秒兜底，不能在这里把整轮判死。
   */
  if (!loaded && !opts.swap) {
    failStageAndEnd(
      'inject',
      `注入失败：播放内核拒绝了该地址（loadfile 返回失败：${native.lastError() || '未知原因'}）`,
      'site'
    )
  }
  return loaded
}

/** 本轮是否已经把加速中转换上去过（调用方据此决定「后台会话还要不要留」） */
export function mpvBoostSwapped(): boolean {
  return boostSwapped
}

/**
 * 当前这一路的播放进度读数（v1.3）。
 *
 * 用途：`enginePlay` 在「要不要启动加速测速」那一刻必须知道直连是不是已经有数据 ——
 * 有数据就说明不需要再开一条连接去测速（省带宽，也避免慢 CDN 上两条连接互相排队）。
 * 只读三个内存变量，不碰内核、不发请求。
 */
export function mpvPlaybackProgress(): { bytes: number; hasPicture: boolean; sinceLoadMs: number } {
  return {
    bytes: bytesSinceCandidate(),
    hasPicture: lastHadPicture,
    sinceLoadMs: candidateLoadedAt > 0 ? Date.now() - candidateLoadedAt : 0
  }
}

export function mpvPlay(path: string, referer?: string, cookies?: string): void {
  loadSource(path, referer, cookies, {})
}

/**
 * 本地临时缓存失败 → 把内核切回**直连原地址**（v1.4 边下边播的兜底）。
 *
 * 为什么单独一个函数，而不是复用 `mpvApplyBoost`：
 *   · 加速中转有自己的「2 秒 / 零字节」门槛，而这里失败已经由缓存会话**确定**了，
 *     再等 2 秒只会让用户多黑屏两秒；
 *   · 加速中转会设置 `boostSwapped`，回退直连并不是「加速已切换」，那个标记不能动
 *     （否则后台加速决策会误以为已经切过流）。
 *
 * 与加速切换相同的一条硬规则：**已经出画面就绝不切**。
 * 缓存可能是在播放中途才失败（上游断了），这时切源会把正在看的画面打回 0 秒；
 * 已经缓存的区间足够继续播，真播到断点再让内核自己报错/换候选更合理。
 */
export function mpvFallbackDirect(
  url: string,
  referer?: string,
  cookies?: string,
  reason = '缓存不可用'
): boolean {
  if (!ready || !native || !attachedWin || attachedWin.isDestroyed()) return false
  if (lastHadPicture) return false
  try {
    return loadSource(url, referer, cookies, { swap: true, reason: `本地缓存回退：${reason}` })
  } catch {
    return false
  }
}

/** 内核是否已经挂载好、可以 loadfile（播放页刚打开时地址可能比 attach 先到） */
export function mpvReady(): boolean {
  return ready && !!native && !!attachedWin && !attachedWin.isDestroyed()
}

/**
 * 换到交接队列里的下一个候选（v1.3 乐观交接的执行端）。
 *
 * 调用方是 250ms 状态泵：只有「当前候选 5 秒零字节」才会被调用。
 * 这里再复核一次判据（不信任调用方），因为泵的采样是异步的：
 * 万一这一帧刚好收到字节，就不能把一条已经通了的地址换掉。
 */
export function mpvSwitchToNextCandidate(reason = '5 秒零字节'): { url: string } | null {
  if (!ready || !native || !attachedWin || attachedWin.isDestroyed()) return null
  if (lastHadPicture) return null
  if (bytesSinceCandidate() > 0) return null
  const next = takeNextCandidate()
  if (!next) return null
  log.append(
    'warn',
    'mpv',
    `${HANDOFF_NO_BYTES_MS / 1000} 秒内内核一个字节都没收到，换下一个候选（${reason}；队列还剩 ${handoffSnapshot().queued} 个）`
  )
  try {
    if (!loadSource(next.url, next.referer, next.cookies, { swap: true, reason })) return null
  } catch {
    return null
  }
  return { url: next.url }
}

/**
 * 把「加速中转」地址接到内核上（v1.3：加速决策不再挡在起播前面）。
 *
 * 旧的顺序是「测速/预热（0.3~8 秒）→ 启用中转 → loadfile」，
 * 用户必须先等完测速才可能看到画面。现在直连地址**先交给内核**，
 * 测速在后台跑；只有「还没出画面」时才把内核切到中转地址（中转里已经缓存了头部分片，
 * 切过去通常立刻就能出画面），已经出画面则**绝不打断**。
 */
export function mpvApplyBoost(url: string, referer?: string, cookies?: string): boolean {
  if (!ready || !native || !attachedWin || attachedWin.isDestroyed()) return false
  if (lastHadPicture || boostSwapped) return false
  /*
   * 只有「还一个字节都没收到」才切加速。
   *
   * 为什么字节在动就不切：换流是 `loadfile replace`，进度必然回 0 ——
   * 一条慢但通的直连已经拉了几百 KB，切到中转反而把这段进度扔掉（实测慢源上更慢）。
   * 慢但通的源交给用户看即时进度（状态区有速率），或者由 5 秒零字节那条规则去换候选。
   *
   * 为什么还要等 2 秒：单连接慢≠死。正常慢 CDN 的首字节约 1~2 秒，
   * 抢在它前面切流会把正要出画面的那一路打断（脚本里实测：1.9 秒切流后首帧反而慢了 2 秒）。
   * 2 秒还没一个字节，才说明这一条连接确实卡住了，此时中转里通常已经有头部分片，切过去立刻出画。
   */
  if (bytesSinceCandidate() > 0) return false
  if (Date.now() - candidateLoadedAt < 2000) return false
  boostSwapped = true
  log.append('info', 'mpv', '把加速中转接到内核（直连这段时间还没出画面）')
  try {
    return loadSource(url, referer, cookies, { swap: true, reason: '加速中转' })
  } catch {
    return false
  }
}

/** 播放列表：第一个 replace，其余 append（供本地多集播放使用） */
export function mpvSetPlaylist(paths: string[]): void {
  if (!ready || !native) return
  paths.forEach((p, i) => {
    try {
      native!.command(['loadfile', p, i === 0 ? 'replace' : 'append'])
    } catch {
      /* ignore */
    }
  })
  // 同上：loadfile 会继承 pause，整套播放列表必须显式开播
  try {
    native.setProperty('pause', false)
  } catch {
    /* ignore */
  }
}

export function mpvTogglePause(): void {
  if (!ready || !native) return
  const paused = native.getProperty('pause')
  native.setProperty('pause', !(paused === true || paused === 1))
}

export function mpvSeekSec(sec: number): void {
  if (!ready || !native) return
  native.command(['seek', String(Math.max(0, sec)), 'absolute'])
}

export function mpvSetVolume(volume: number): void {
  if (!ready || !native) return
  native.setProperty('volume', Math.max(0, Math.min(VOLUME_MAX, Math.round(volume))))
}

/**
 * 音量上限（v0.3.6）。
 *
 * 用户反馈「就算 100% 声音也偏小，想再加 0.25 倍左右」。
 * mpv 的 `volume` 属于**软件增益**，可以把上限抬到 200 —— 关键是必须同时设 `volume-max`，
 * 否则 mpv 会按默认 100 把音量夹回去（`setProperty('volume', 150)` 静默变成 100）。
 * 超过 100 的部分有削波风险，由 `clipping-protection`（alimiter）兜住，
 * 见 `@shared/audio` 的 `needsLimiter()`。
 */
export const VOLUME_MAX = 200

export function mpvSetMute(muted: boolean): void {
  if (!ready || !native) return
  native.setProperty('mute', muted)
}

/**
 * 播放倍速（v0.2.9 最后更新；v0.3.6 改为与音频滤镜链合并）。
 *
 * 两个关键点：
 * 1. 变速必须挂 `af=scaletempo2`：不加音频滤镜时变速会**变调**，听起来像快进磁带；
 *    `max-speed=8` 足够覆盖 0.25–4 倍。
 * 2. 速度夹在 0.25–4：0 或负数会让播放器无声/卡死，误操作传进来就麻烦了。
 *
 * v0.3.6 的**行为修正**：老实现是 `af clr` / `af set scaletempo2` 的整链替换，
 * 一旦用户开了均衡器/压缩器，变速就会把它们整条冲掉（「变速之后音效没了」）。
 * 现在链的拼装只有一处（`@shared/audio.buildAudioFilterChain`），
 * 由 `services/audioSettings.applyAudio()` 统一应用；这里只把 speed 记下来并触发重拼。
 * 为避免循环依赖，通过回调插槽调用（audioSettings 注册）。
 */
let speedApplyHook: ((speed: number) => void) | null = null

/** 由 audioSettings 注册「倍速变化 → 重拼滤镜链」的回调 */
export function setSpeedApplyHook(fn: ((speed: number) => void) | null): void {
  speedApplyHook = fn
}

export function mpvSetSpeed(speed: number): void {
  if (!ready || !native) return
  try {
    const s = Math.max(0.25, Math.min(4, Number(speed) || 1))
    native.setProperty('speed', s)
    if (speedApplyHook) {
      // 链里带不带 scaletempo2 由音频服务决定（它同时管着其它音效）
      speedApplyHook(s)
    } else {
      // 没注册（例如只跑 mpv 自检）：退回最小实现，保证变速不变调
      if (s === 1) native.command(['af', 'clr'])
      else native.command(['af', 'set', 'scaletempo2=max-speed=8'])
    }
  } catch (err) {
    log.append('warn', 'mpv', `设置倍速失败: ${String((err as Error)?.message ?? err)}`)
  }
}

export function mpvGetState(): MpvState | null {
  if (!ready || !native) return null
  /*
   * v1.1.4：顺带带上 uosc 桥接脚本的按钮/版本读数（见 MpvState.uosc 的说明）。
   * 三次属性读取，挂在本来就会调用的 800ms/250ms 状态泵上，开销可以忽略。
   *
   * v1.5：再把 `hasPicture` 并进来 —— 它是渲染层弹幕门控（需求 ②）与加载进度（需求 ③）
   * 的唯一判据，必须和播放状态同一刻、同一来源（详见 mpvHasPicture 与 MpvState.hasPicture）。
   */
  return { ...native.state(), hasPicture: mpvHasPicture(), uosc: uoscBridgeStats() }
}

/**
 * 内核侧的网络读数（v1.1：修「地址交给内核后就没有速度/流量显示了」）。
 *
 * ## 为什么必须从 mpv 读，而不是继续用交给内核之前那次探测的数值
 *
 * 老实现里 `PlayFlowMetrics` 只在**交给内核之前**由可达性探测写一次
 * （见 ipc.ts 的 playerDiagnose → setMetrics）。地址交给 mpv 之后没有任何代码再写它，
 * 于是界面上那几个数字就**冻在探测结束时的那一刻**：
 * 用户看到的正是「刚把地址交给播放器，速度/流量显示就没了，也没有失败原因」。
 *
 * ## 读的是哪些属性，为什么每个都有兜底
 *
 * - `cache-speed`：mpv 的"缓存与底层流之间的当前读取速率"（字节/秒），最直接；
 * - `demuxer-cache-state/raw-input-rate`：老版本没有 cache-speed 时的等价读数；
 * - `demuxer-cache-state/fw-bytes`：已预读的前向字节数（累计流量的下界）。
 * 三者任一读不到就退到下一个，全都读不到时 `available=false` —— 界面显示「—」，
 * 不用估算值凑数字（这是本项目一贯的"不许假状态"）。
 * 注意：原生插件的 `getProperty` 只会按 double/flag/string 取值，**读不了 node**，
 * 所以这里一律用带子路径的属性名（`demuxer-cache-state/xxx`），而不是直接读 node。
 */
export interface MpvNetStats {
  /** 当前读取速率（字节/秒）；读不到是 0 */
  rateBps: number
  /** 已预读字节（fw-bytes）；读不到是 0 */
  forwardBytes: number
  /** 媒体总字节（file-size）；HLS 这类没有总长时是 0 */
  fileSize: number
  /** 是否至少读到了一个有效属性 */
  available: boolean
}

export function mpvNetStats(): MpvNetStats | null {
  const n = native
  if (!n || !ready) return null
  const num = (name: string): number => {
    try {
      const v = Number(n.getProperty(name))
      return Number.isFinite(v) && v > 0 ? v : 0
    } catch {
      return 0
    }
  }
  const rate = num('cache-speed') || num('demuxer-cache-state/raw-input-rate')
  const fw = num('demuxer-cache-state/fw-bytes') || num('demuxer-cache-state/file-cache-bytes')
  const size = num('file-size')
  return { rateBps: rate, forwardBytes: fw, fileSize: size, available: rate > 0 || fw > 0 || size > 0 }
}

/** 诊断：输出窗口树（排查「有声音无画面」用） */
export function mpvDumpWindows(): { parentChildren: string[]; childChildren: string[] } | null {
  if (!native) return null
  try {
    return native.windows()
  } catch {
    return null
  }
}

/** 诊断：任意窗口的子窗口树（两个内核都可用来对比 z 序/样式） */
export function mpvWindowsOf(hwnd: Buffer | number): string[] | null {
  const mod = loadNative()
  if (!mod) return null
  try {
    return mod.windowsOf(hwnd)
  } catch {
    return null
  }
}

/** 诊断：手动触发一次提升 */
export function mpvRaiseForTest(): void {
  lastRaiseAt = 0
  raiseSurface()
}

/** 诊断：把视频窗口重挂到 Chromium 渲染窗口内部（绕开 z 序竞争） */
export function mpvReparentToWidget(): boolean {
  if (!ready || !native) return false
  try {
    return native.reparentToRenderWidget()
  } catch {
    return false
  }
}

/** 诊断：直接读取关键属性（用于判断状态读取为何返回 0） */
export function mpvDebugProps(): Record<string, unknown> | null {
  if (!native || !ready) return null
  const names = [
    'filename',
    'media-title',
    'path',
    'idle-active',
    'pause',
    'time-pos',
    'duration',
    'eof-reached',
    'core-idle',
    'seeking'
  ]
  const out: Record<string, unknown> = {}
  for (const n of names) {
    try {
      out[n] = native.getProperty(n)
    } catch (err) {
      out[n] = `err:${String(err).slice(0, 40)}`
    }
  }
  return out
}

/**
 * 当前媒体的技术参数（播放状态栏「流详情」用）：
 * 分辨率、视频/音频编码、帧率、码率。读不到的字段留空，由调用方回落到播放列表解析。
 */
export function mpvStreamProps(): {
  width?: number
  height?: number
  videoCodec?: string
  audioCodec?: string
  fps?: number
  videoBitrate?: number
  audioBitrate?: number
} | null {
  const n = native
  if (!n || !ready) return null
  const num = (name: string): number | undefined => {
    try {
      const v = Number(n.getProperty(name))
      return Number.isFinite(v) && v > 0 ? Math.round(v) : undefined
    } catch {
      return undefined
    }
  }
  const str = (name: string): string | undefined => {
    try {
      const v = n.getProperty(name)
      const s = typeof v === 'string' ? v.trim() : ''
      return s && s !== 'no' ? s : undefined
    } catch {
      return undefined
    }
  }
  return {
    width: num('width'),
    height: num('height'),
    videoCodec: str('video-codec'),
    audioCodec: str('audio-codec'),
    fps: ((): number | undefined => {
      try {
        const v = Number(n.getProperty('container-fps'))
        return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : undefined
      } catch {
        return undefined
      }
    })(),
    videoBitrate: num('video-bitrate'),
    audioBitrate: num('audio-bitrate')
  }
}

/** 诊断：屏幕坐标处最上层的窗口是谁（判断视频窗口是否被覆盖） */
export function mpvHitTest(x: number, y: number): {
  hitClass: string
  hitHwnd: number
  isOurChild: boolean
  hitRootIsOurs: boolean
  ourChildHwnd: number
  ourChain: string[]
  hitChain: string[]
  parentChain: string[]
} | null {
  const mod = loadNative()
  if (!mod) return null
  try {
    return mod.hitTest(Math.round(x), Math.round(y))
  } catch {
    return null
  }
}

export function mpvSnapshot(file: string): void {
  if (!ready || !native) return
  native.command(['screenshot-to-file', file, 'video'])
}

/** 画面比例：fit=适应 / cover=裁剪铺满 / stretch=拉伸铺满（areaW/areaH 为视频区像素比） */
export function mpvSetAspect(mode: 'fit' | 'cover' | 'stretch'): void {
  if (!ready || !native) return
  try {
    if (mode === 'stretch') {
      // 拉伸：不保持宽高比，直接铺满窗口（会变形）
      native.setProperty('keepaspect', false)
      native.setProperty('panscan', 0)
      native.setProperty('video-aspect-override', '-1')
    } else if (mode === 'cover') {
      // 裁剪铺满：保持比例但放大到填满窗口，超出部分裁掉
      native.setProperty('keepaspect', true)
      native.setProperty('video-aspect-override', '-1')
      native.setProperty('panscan', 1)
    } else {
      // 适应：保持比例，必要时留黑边
      native.setProperty('keepaspect', true)
      native.setProperty('video-aspect-override', '-1')
      native.setProperty('panscan', 0)
    }
    log.append('info', 'mpv', `画面比例模式: ${mode}`)
  } catch {
    /* ignore */
  }
}

/** 字幕轨列表（mpv track-list） */export function mpvSubtitleTracks(): { id: number; label: string }[] {
  if (!ready || !native) return []
  const out: { id: number; label: string }[] = []
  try {
    const count = Number(native.getProperty('track-list/count') ?? 0)
    for (let i = 0; i < count; i++) {
      const type = String(native.getProperty(`track-list/${i}/type`) ?? '')
      if (type !== 'sub') continue
      const id = Number(native.getProperty(`track-list/${i}/id`) ?? 0)
      const title = String(native.getProperty(`track-list/${i}/title`) ?? '')
      const lang = String(native.getProperty(`track-list/${i}/lang`) ?? '')
      const external = native.getProperty(`track-list/${i}/external`) === true
      out.push({
        id,
        label: (title || lang || `字幕 ${id}`) + (external ? '（外挂）' : '')
      })
    }
  } catch {
    /* ignore */
  }
  return out
}

export function mpvSetSubtitle(id: number): void {
  if (!ready || !native) return
  native.setProperty('sid', id)
}

export function mpvAddSubtitleFile(path: string): void {
  if (!ready || !native) return
  native.command(['sub-add', path, 'select'])
}

export function mpvNotifyLayout(): void {
  if (!ready || !native || !currentBounds) return
  try {
    native.resize(currentBounds)
    // 布局变化后立即抢回顶层（Chromium 布局重绘会把自己提到上层）
    lastRaiseAt = 0
    raiseSurface()
  } catch {
    /* ignore */
  }
}

export function mpvDestroy(): void {
  /*
   * V1.3.1：退出链路插桩（真机 AppHang，Event 1002，1.2.5 / 1.2.9 / 1.3.0 都中招）。
   *
   * 为什么必须在**每一步之间**打点：Windows 判定"无响应"的依据是主线程 5 秒没处理窗口消息，
   * 而这里连续做了「停计时器 → 停各种 watch → destroy 内核 → 清状态」几件同步事，
   * 任何一件卡住，外部都只看到"整个窗口卡死"，看不出是哪一件。
   * 每一行都带相对开始时的毫秒数；下次卡住时，**最后一行就是卡住的那一步**。
   */
  const t0 = Date.now()
  const mark = (step: string): void => log.append('info', 'exit', `+${Date.now() - t0}ms ${step}`)
  mark('开始销毁播放器')
  stopTimePump()
  mark('已停时间泵')
  stopRaiseWatch()
  stopCursorWatch()
  stopThumbfastStatusWatch?.()
  mark('已停各种 watch（raise/cursor/thumbfast）')
  surfaceVisible = true
  biliScriptLoaded = false
  /* v1.2.1：实例销毁后 VO 窗口随之消失，输入窗口缓存作废（新实例会重新找/重新启用） */
  inputHwnd = 0
  inputHwndEnabled = false
  inputCheckAt = 0
  inputLastFailure = ''
  // 三个 uosc 相关的标记都要复位：实例销毁后脚本也随之消失，
  // 保留为 true 会让「动作回传」「弹幕插件渲染」在下一个实例上误判成可用。
  uoscBarLoaded = false
  uoscDanmakuLoaded = false
  uoscCtrlLoaded = false
  lastUoscBarJson = ''
  lastUoscStatusPushAt = 0
  // 画质设置的指纹也要复位：实例没了，新实例必须被重新设置一次（哪怕设置值没变）
  lastEnhanceKey = ''
  lastVolume = -1
  /*
   * 音频指纹同样要复位（v0.3.6）：滤镜链挂在实例上，实例销毁后什么都不剩，
   * 指纹还是旧值的话新实例不会再应用一次 —— 表现就是「第二次进播放器音效没了」。
   */
  try {
    audioResetHook?.()
  } catch {
    /* 复位失败不影响销毁流程 */
  }
  latestPluginDanmakuFile = ''
  injectedForPath = ''
  lastMpvPath = ''
  if (native && ready) {
    try {
      native.command(['stop'])
    } catch {
      /* ignore */
    }
    mark('已发 stop')
    /*
     * V1.3.2：内核销毁**挪到下一轮事件循环**。
     *
     * 真机日志（用户贴的）：
     *   [exit] +0ms 开始销毁播放器
     *   [exit] +0ms 已停时间泵
     *   [exit] +0ms 已停各种 watch（raise/cursor/thumbfast）
     *   ← 到这里就断了，`内核 destroy 完成` 再也没出现
     * 也就是**卡在 native.destroy() 这一句**（libmpv 释放时在等网络/解码线程收尾），
     * 而它是同步调用，主线程被它按住的这几秒里窗口消息没人处理 → Windows 判 AppHang 直接杀掉。
     *
     * 现在把销毁放到 setTimeout(0)：先把退出流程（关窗口、清状态）交给下一轮事件循环跑完，
     * 重建时窗口已经收起来了，再让 libmpv 在自己那一下里慢慢收尾。
     * **这不是把问题藏起来**：日志里仍然会打 `内核 destroy 完成 +Nms`，N 就是它真实的耗时，
     * 下一次要是还卡，这个数字会告诉我们它到底卡多久。
     */
    const inst = native
    native = null
    setTimeout(() => {
      const tDestroy = Date.now()
      try {
        inst.destroy()
      } catch {
        /* ignore */
      }
      log.append('info', 'mpv', 'libmpv 已销毁')
      log.append('info', 'exit', `+${Date.now() - tDestroy}ms 内核 destroy 完成（异步执行）`)
    }, 0)
  }
  ready = false
  attachedWin = null
  lastPlaying = false
  lastLength = 0
  lastEof = false
  /*
   * v1.5：销毁后「有没有画面」必须是 false。
   * 以前这里没复位（它只在 loadSource 里被清），销毁后如果还有人读这份状态
   * （自检、旧渲染层的迟到轮询），会得到"有画面"的假读数，弹幕/控制栏门控跟着失效。
   */
  lastHadPicture = false
  // v1.3：内核销毁后「当前候选」的计量与交接队列都不再有意义
  candidateLoadedAt = 0
  candidateBytesBase = 0
  boostSwapped = false
  resetHandoff()
}

import { app, BrowserWindow, screen } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CH } from '@shared/channels'
import type { OverlayAction } from '@shared/api'
import type { DanmakuSettings } from '@shared/types'
import { BROWSER_UA, getSettings } from '../net'
import { danmakuApiBase } from './danmaku'
import { log } from '../log'

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
const eventCounts = { playing: 0, paused: 0, time: 0, length: 0, ended: 0 }

export function mpvEventCounts(): typeof eventCounts {
  return { ...eventCounts }
}

export function mpvResetEventCounts(): void {
  eventCounts.playing = 0
  eventCounts.paused = 0
  eventCounts.time = 0
  eventCounts.length = 0
  eventCounts.ended = 0
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

function startTimePump(win: BrowserWindow): void {
  stopTimePump()
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
        // 失败时不要每 250ms 刷一次日志：同一文件最多重试 3 次、每次间隔 2 秒
        if (injectAttempts < 3 && Date.now() - lastInjectAttemptAt > 2000) {
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
 * libmpv 默认**不加载脚本**，所以必须显式给 `load-scripts=yes`；
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
 * uosc 控制栏是否接管（v0.2.18）。
 *
 * 默认开启；用户在「设置 → 播放器设置 → 播放器控制栏」里可以关掉，
 * 那时应用回落到自己那套悬浮窗控制栏（代码原样保留，见 playerOverlay.ts）。
 * 内置 uosc 缺失（安装目录不完整）时也回落到旧控制栏 —— 不能让人没有控制栏可用。
 */
export function uoscControlBarRequested(): boolean {
  const s = getSettings() as unknown as { uoscControlBar?: boolean }
  return s.uoscControlBar !== false && uoscPluginAvailable()
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
 */
function loadUoscPlugins(mod: MpvNative, cfgDir: string, wantDanmaku: boolean, wantBar: boolean): boolean {
  const uoscDir = slashPath(join(cfgDir, 'scripts', 'uosc'))
  const danmakuDir = slashPath(join(cfgDir, 'scripts', 'uosc_danmaku'))

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
    case 'toggle-info':
      return { type: 'toggleInfo' }
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
    raw = typeof v === 'string' ? v.trim() : ''
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
  if (!action) {
    log.append('warn', 'mpv', `uosc 控制栏动作无法识别，已忽略: ${raw.slice(0, 80)}`)
    return
  }
  try {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(CH.overlayAction, action)
    }
  } catch (err) {
    log.append('warn', 'mpv', `uosc 控制栏动作派发失败: ${String((err as Error)?.message ?? err)}`)
  }
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
  let json = ''
  try {
    json = JSON.stringify(payload ?? null)
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

/** 是否还有弹幕在等当前文件就绪（渲染层据此决定「再等等」还是「回落到画布」） */
export function mpvPluginDanmakuPending(): boolean {
  if (!latestPluginDanmakuFile) return false
  const curPath = mpvCurrentPath()
  return !curPath || injectedForPath !== curPath
}

/** mpv 当前载入的文件/地址（未载入时为 ''） */
function mpvCurrentPath(): string {
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

/** 嵌入 libmpv（在播放器视频区域创建输出子窗口） */
export function mpvAttach(win: BrowserWindow, bounds: MpvBounds): { ok: boolean; message: string } {
  const mod = loadNative()
  if (!mod) return { ok: false, message: '未找到 libmpv 运行时或原生插件（请运行 npm run libmpv:fetch）' }
  currentBounds = toPhysical(win, bounds)
  const bili = biliDanmakuConfig()
  // 两件不同的事：控制栏交给 uosc（默认开）／弹幕交给 uosc_danmaku 插件（设置里选）
  const wantUoscDanmaku = uoscDanmakuRequested()
  const wantUoscBar = uoscControlBarRequested()
  const cfgDir = wantUoscDanmaku || wantUoscBar ? bundledMpvConfigDir() : ''
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
  const ok = mod.create({
    x: currentBounds.x,
    y: currentBounds.y,
    width: currentBounds.width,
    height: currentBounds.height,
    parentHwnd: hwnd,
    options: {
      ...(process.env.SAKANA_MPV_VERBOSE ? { terminal: 'yes', 'msg-level': 'all=v' } : {}),
      ...bili.options,
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
      ...(cfgDir ? { 'config-dir': slashPath(cfgDir), config: 'yes' } : {}),
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
   */
  if (cfgDir && !uoscBarLoaded) {
    loadUoscPlugins(mod, cfgDir, wantUoscDanmaku, wantUoscBar)
  }
  attachedWin = win
  lastPlaying = false
  lastLength = 0
  lastEof = false
  lastUoscBarJson = ''
  surfaceVisible = true
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

export function mpvSetBounds(bounds: MpvBounds): void {
  if (!ready || !native || !attachedWin) return
  currentBounds = toPhysical(attachedWin, bounds)
  try {
    native.resize(currentBounds)
  } catch {
    /* ignore */
  }
}

export function mpvPlay(path: string, referer?: string, cookies?: string): void {
  if (!ready || !native) throw new Error('libmpv 尚未就绪')
  const headers: string[] = []
  // 必须带浏览器 UA：libVLC 路径（:http-user-agent）与 FFmpeg 中转（-user_agent）都发浏览器 UA，
  // 只有 mpv 默认会发 "libmpv"——不少 CDN/WAF 会因此拒流，
  // 表现为「校验地址可用（校验用浏览器 UA）但内核拿到地址却播不出来」。
  headers.push(`User-Agent: ${BROWSER_UA}`)
  if (referer) headers.push(`Referer: ${referer}`)
  if (cookies) headers.push(`Cookie: ${cookies}`)
  native.setProperty('http-header-fields', headers.join(','))
  // 新一次载入：重置状态基线，确保开播时一定会重新发出 playing 事件
  lastPlaying = false
  lastEof = false
  lastLength = 0
  // 新媒体的视频输出窗口会在首帧时重建，届时需要再挂一次
  pendingReparent = true
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
      ? `libmpv 取流: ${path.slice(0, 130)} | Referer=${referer ? referer.slice(0, 60) : '(不带)'} Cookie=${cookies ? `${cookies.length} 字符` : '(无)'}`
      : `libmpv 取流失败: ${path.slice(0, 130)} → ${native.lastError()}`
  )
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
  native.setProperty('volume', Math.max(0, Math.min(100, Math.round(volume))))
}

export function mpvSetMute(muted: boolean): void {
  if (!ready || !native) return
  native.setProperty('mute', muted)
}

/**
 * 播放倍速（v0.2.9 最后更新）。
 *
 * README 一直写着「支持倍速」，但代码里其实没有实现 —— 这是与 Kazumi 对照时发现的真实缺口。
 * 两个关键点：
 * 1. 变速必须挂 `af=scaletempo2`：不加音频滤镜时变速会**变调**，听起来像快进磁带；
 *    `max-speed=8` 足够覆盖 0.25–4 倍。
 * 2. 速度夹在 0.25–4：0 或负数会让播放器无声/卡死，误操作传进来就麻烦了。
 */
export function mpvSetSpeed(speed: number): void {
  if (!ready || !native) return
  try {
    const s = Math.max(0.25, Math.min(4, Number(speed) || 1))
    native.setProperty('speed', s)
    if (s === 1) {
      // 恢复原速时移除滤镜，免得白吃一点 CPU
      native.command(['af', 'clr'])
    } else {
      native.command(['af', 'set', 'scaletempo2=max-speed=8'])
    }
  } catch (err) {
    log.append('warn', 'mpv', `设置倍速失败: ${String((err as Error)?.message ?? err)}`)
  }
}

export function mpvGetState(): MpvState | null {
  if (!ready || !native) return null
  return native.state()
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
  stopTimePump()
  stopRaiseWatch()
  stopCursorWatch()
  surfaceVisible = true
  biliScriptLoaded = false
  // 三个 uosc 相关的标记都要复位：实例销毁后脚本也随之消失，
  // 保留为 true 会让「动作回传」「弹幕插件渲染」在下一个实例上误判成可用。
  uoscBarLoaded = false
  uoscDanmakuLoaded = false
  uoscCtrlLoaded = false
  lastUoscBarJson = ''
  lastVolume = -1
  latestPluginDanmakuFile = ''
  injectedForPath = ''
  lastMpvPath = ''
  if (native && ready) {
    try {
      native.command(['stop'])
    } catch {
      /* ignore */
    }
    try {
      native.destroy()
    } catch {
      /* ignore */
    }
    log.append('info', 'mpv', 'libmpv 已销毁')
  }
  ready = false
  attachedWin = null
  lastPlaying = false
  lastLength = 0
  lastEof = false
}

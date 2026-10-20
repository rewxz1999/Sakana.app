/*
 * winInput —— 用 koffi 直接调 user32，把 mpv 的画面输出子窗口恢复成「可接收鼠标」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（v1.2.1 的致命回归：uosc 控制栏所有按钮点了没反应）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 现象：控制栏由 mpv 的 uosc（原生 OSD）绘制，条画得出来、画面也在播，但底部栏与角标的
 * 每一个按钮都没有反应。应用自己的弹幕层是另一块永远穿透的悬浮窗，与这件事无关。
 *
 * 证据链（不是猜的，两处都能复核）：
 *   ① mpv 源码 `video/out/w32_common.c` 的 `gui_thread()`：用 `--wid` 嵌入时它创建
 *      `WS_CHILD | WS_VISIBLE` 的 "mpv" 子窗口，随后**主动**执行
 *      `EnableWindow(w32->window, 0)` —— 也就是给窗口加上 `WS_DISABLED`。
 *      这是 mpv 的设计：`--wid` 模式下由宿主负责输入，mpv 不自己抢鼠标。
 *   ② 本应用自己的窗口树（`[uosc-test] 窗口树=` / `mpvDumpWindows()`）实测：
 *      `{"class":"mpv", ..., "style":0x58000000}`；0x58000000 = WS_CHILD|WS_VISIBLE|WS_DISABLED。
 *      而 Windows 的 `WindowFromPoint` **不会返回 disabled 窗口**（文档明说），
 *      于是视频区域上的真实鼠标全部落到我们创建的外层 `Static` 容器上 ——
 *      那个窗口没有任何输入处理，点击就被它吞掉了；uosc 永远收不到 mouse-pos / MBTN_LEFT。
 *
 * 为什么 v0.3.2 的「投递 WM_MOUSEMOVE 后 mpv 的 mouse-pos 变了」不能推翻上面这条：
 * `PostMessage` 是直接进目标窗口的 WndProc，绕过了命中测试；它只能证明 mpv 的输入层
 * 有能力处理消息，证明不了真实鼠标能被路由给它。真实光标走的是命中测试，disabled 就出局。
 *
 * 为什么以前能点：以前按钮是应用自绘的 React 控件，落在 Electron 悬浮窗里，根本不经过 mpv；
 * 这一轮把控制栏整体交给 uosc 之后，点击必须进 mpv 的窗口，这条一直存在的断点才暴露出来。
 *
 * 修法：只做一件事 —— 把 mpv 的那个 VO 子窗口 `EnableWindow(TRUE)`。
 * 窗口一旦可命中，Windows 就会把鼠标消息直接送给 mpv 自己的 WndProc，
 * uosc 的 hover / 按钮 / 进度条拖动 / 滚轮全部走回 mpv 的原生路径，不需要我们转发任何事件。
 * （`src/main/services/mpv.ts` 里还配套把 mpv 的 `window-dragging` 关掉：见那里的说明。）
 *
 * 为什么用 koffi 而不是改 native/mpv 的 N-API 插件：
 * 改 .node 需要本机有 MSVC 才能重新编译，编译不了修复就等于不存在；koffi 自带预编译
 * 二进制、装完即用（与 services/winMem.ts 的选择一致）。本文件只在 Windows 上绑定
 * user32 的 3 个函数（白名单），其它平台直接返回「不可用」，绝不抛异常。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

// ---------------- 加载 koffi（失败必须优雅降级，绝不能让主进程崩） ----------------

type NativeFn = (...args: any[]) => any
interface KoffiLibrary {
  func(definition: string): NativeFn
}
interface KoffiNamespace {
  load(path: string): KoffiLibrary
}

/**
 * 取一个「能解析 node_modules」的 require —— 与 winMem.ts 完全相同的三种运行形态：
 * 1) electron-vite 打包后的主进程（CJS 输出）→ 直接用 CJS 的 require；
 * 2) 纯 node 直接跑本 .ts（Node 原生类型剥离）→ require 通常也在，否则用 __filename；
 * 3) 上面都没有（纯 ESM）→ 退化成「从工作目录解析」，只有开发/测试脚本会走到。
 */
function resolveRequire(): NodeRequire | null {
  try {
    if (typeof require === 'function') return require
  } catch {
    /* 纯 ESM 下 require 不存在，继续往下退 */
  }
  try {
    if (typeof __filename === 'string' && __filename) return createRequire(__filename)
  } catch {
    /* 同上 */
  }
  try {
    return createRequire(join(process.cwd(), 'index.js'))
  } catch {
    return null
  }
}

function errText(err: unknown): string {
  const m = (err as { message?: string } | null)?.message
  return m ? String(m) : String(err)
}

interface WinInputApi {
  EnableWindow: (hwnd: bigint, enable: number) => number
  IsWindow: (hwnd: bigint) => number
  IsWindowEnabled: (hwnd: bigint) => number
}

let api: WinInputApi | null = null
let initTried = false
let unavailableReason = '窗口输入组件未就绪'

function init(): WinInputApi | null {
  if (api) return api
  if (initTried) return null
  initTried = true

  if (process.platform !== 'win32') {
    unavailableReason = '当前系统不是 Windows，不需要（也无法）启用 mpv 子窗口输入'
    return null
  }
  const req = resolveRequire()
  if (!req) {
    unavailableReason = '无法解析模块加载器（require 不可用）'
    return null
  }
  try {
    const k = req('koffi') as KoffiNamespace
    const user32 = k.load('user32.dll')
    api = {
      // BOOL EnableWindow(HWND, BOOL)：把窗口从「禁用」恢复为「可接收鼠标/键盘」
      EnableWindow: user32.func('int __stdcall EnableWindow(void *hWnd, int bEnable)'),
      IsWindow: user32.func('int __stdcall IsWindow(void *hWnd)'),
      IsWindowEnabled: user32.func('int __stdcall IsWindowEnabled(void *hWnd)')
    }
    return api
  } catch (err) {
    unavailableReason = `user32 绑定失败（koffi 加载失败？）：${errText(err)}`
    api = null
    return null
  }
}

/** 后端是否可用；不可用时 reason 是可以直接写进日志的中文原因 */
export function winInputStatus(): { available: boolean; reason: string } {
  const ok = init() !== null
  return { available: ok, reason: ok ? '' : unavailableReason }
}

/** 句柄是否还是一个活着的窗口（视频子窗口被重建后旧句柄会失效，调用方要重新找） */
export function isWindowAlive(hwnd: number): boolean {
  const a = init()
  if (!a || !(hwnd > 0)) return false
  try {
    return a.IsWindow(BigInt(hwnd)) !== 0
  } catch {
    return false
  }
}

/** 窗口当前是否「启用」（false = WS_DISABLED，命中测试会跳过它） */
export function isWindowInputEnabled(hwnd: number): boolean {
  const a = init()
  if (!a || !(hwnd > 0)) return false
  try {
    return a.IsWindowEnabled(BigInt(hwnd)) !== 0
  } catch {
    return false
  }
}

/**
 * 启用窗口的鼠标/键盘输入（清掉 WS_DISABLED）。
 *
 * @returns `ok` = 调用本身成功；`enabled` = 调用之后读回来的真实状态。
 *          两者分开是刻意的：EnableWindow 对某些窗口会返回 0 但仍改变状态，
 *          排障时要能区分「没调成」和「调了但状态没变」。
 */
export function enableWindowInput(hwnd: number): { ok: boolean; enabled: boolean; reason: string } {
  const a = init()
  if (!a) return { ok: false, enabled: false, reason: unavailableReason }
  if (!(hwnd > 0)) return { ok: false, enabled: false, reason: '窗口句柄无效（0）' }
  try {
    const ok = a.EnableWindow(BigInt(hwnd), 1) !== 0
    const enabled = a.IsWindowEnabled(BigInt(hwnd)) !== 0
    return {
      ok,
      enabled,
      reason: enabled ? '' : `EnableWindow 返回 ${ok ? '非 0' : '0'}，但窗口仍是禁用状态`
    }
  } catch (err) {
    return { ok: false, enabled: false, reason: `EnableWindow 异常：${errText(err)}` }
  }
}

/// <reference types="electron" />

/**
 * 计时脚本用的最小 electron 桩。
 *
 * 为什么需要它：`scripts/play-speed/measure.cjs` 要跑的是**真实的主进程代码**
 * （ruleProbe / ruleWebview / playerEngine / rules …），而这些模块都会 `import … from 'electron'`。
 * 本沙箱里 Electron 起不来，esbuild 也起不了子进程（npm run build 被拒），
 * 所以走「tsc 编译成 CJS + require 钩子把 electron 指到这里」这条路：
 * 业务代码一行不改，只把 electron 这个外部依赖换掉。
 *
 * 注意：这里**只**实现被播放链路真正调用到的那几个 API，
 * 窗口相关的一律返回「不可用」，于是「网页嗅探」那条路在脚本里会自然跳过，
 * 计时脚本量到的就是**纯 HTTP 直出 + 播放内核**这一段（也正是本工单要提速的那一段）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'sakana-play-speed-'))

export const app = {
  getPath: (name: string): string => (name === 'userData' ? userData : userData),
  getAppPath: (): string => process.cwd(),
  isPackaged: false,
  getName: (): string => 'Sakana-play-speed',
  getVersion: (): string => '0.0.0-speed',
  quit: (): void => undefined,
  on: (): void => undefined,
  whenReady: async (): Promise<void> => undefined
}

/** `net.fetch`：真实 Node fetch（Chromium 网络栈在桩里没有） */
export const net = {
  fetch: (input: string, init?: RequestInit): Promise<Response> => fetch(input, init)
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  static fromWebContents(): BrowserWindow | null {
    return null
  }
  isDestroyed(): boolean {
    return true
  }
  webContents = {
    id: 1,
    send: (): void => undefined,
    isDestroyed: (): boolean => true,
    setWindowOpenHandler: (): void => undefined,
    on: (): void => undefined,
    once: (): void => undefined,
    removeListener: (): void => undefined,
    executeJavaScript: async (): Promise<unknown> => undefined,
    debugger: {
      attach: (): void => undefined,
      detach: (): void => undefined,
      on: (): void => undefined,
      sendCommand: async (): Promise<unknown> => ({}),
      isAttached: (): boolean => false
    },
    mainFrame: { framesInSubtree: [], executeJavaScript: async (): Promise<unknown> => undefined, isDestroyed: () => true }
  }
  getNativeWindowHandle(): Buffer {
    return Buffer.alloc(0)
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  loadURL(): Promise<void> {
    // 桩里没有真实浏览器窗口：显式拒绝，让 ruleWebview.open 走它自己的兜底分支
    return Promise.reject(new Error('stub: no window'))
  }
  destroy(): void {}
  show(): void {}
  hide(): void {}
  setBounds(): void {}
  setSize(): void {}
  focus(): void {}
  isFocusable(): boolean {
    return false
  }
  on(): void {}
}

export const screen = {
  getCursorScreenPoint: (): { x: number; y: number } => ({ x: 0, y: 0 }),
  getDisplayMatching: (): { scaleFactor: number } => ({ scaleFactor: 1 }),
  getPrimaryDisplay: (): {
    scaleFactor: number
    bounds: { x: number; y: number; width: number; height: number }
  } => ({
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }
  }),
  getAllDisplays: (): unknown[] => []
}

const noop = (): void => undefined

export const session = {
  defaultSession: {
    cookies: { get: async (): Promise<unknown[]> => [] },
    webRequest: {
      onBeforeRequest: noop,
      onCompleted: noop,
      onBeforeSendHeaders: noop,
      onHeadersReceived: noop
    }
  },
  fromPartition: (): unknown => ({
    cookies: { get: async (): Promise<unknown[]> => [] },
    webRequest: { onBeforeRequest: noop, onCompleted: noop, onBeforeSendHeaders: noop, onHeadersReceived: noop }
  })
}

export const ipcMain = { handle: noop, on: noop, removeHandler: noop }
export const dialog = { showMessageBox: async (): Promise<unknown> => ({}), showOpenDialog: async (): Promise<unknown> => ({}) }
export const shell = { openExternal: async (): Promise<void> => undefined, openPath: async (): Promise<string> => '' }
export const nativeImage = { createFromPath: (): unknown => ({}) }
export const clipboard = { readText: (): string => '', writeText: noop }
export const protocol = { registerFileProtocol: noop, handle: noop }
export const globalShortcut = { register: noop, unregisterAll: noop }
export const Menu = { buildFromTemplate: (): unknown => ({}), setApplicationMenu: noop }
export const Tray = class {}
export const desktopCapturer = { getSources: async (): Promise<unknown[]> => [] }
export default { app, net, BrowserWindow, screen, session, ipcMain }

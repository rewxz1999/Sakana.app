import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CH } from '@shared/channels'
import { log } from './log'
import { askCloseBehavior, isQuitting } from './tray'

let mainWindow: BrowserWindow | null = null

/** 小型配置窗口（按 hash 单例复用） */
const smallWindows = new Map<string, BrowserWindow>()

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function isSmallWindow(win: BrowserWindow): boolean {
  for (const w of smallWindows.values()) {
    if (w === win) return true
  }
  return false
}

export function closeSmallWindow(win: BrowserWindow): void {
  if (win && !win.isDestroyed() && isSmallWindow(win)) win.close()
}

function rendererUrl(): string {
  return join(__dirname, '../renderer/index.html')
}

/**
 * 打开/聚焦一个按 hash 单例的小窗口（设置项子页面、统计工具、下载详情等）。
 * 小窗口带原生边框，渲染层通过 preload 的 isSmallWindow 隐藏应用外壳。
 */
export function openSmallWindow(
  hash: string,
  opts: { width?: number; height?: number; title?: string } = {}
): BrowserWindow {
  const existing = smallWindows.get(hash)
  if (existing && !existing.isDestroyed()) {
    // 之前出现过渲染进程崩溃/加载失败时，直接重建，避免把"坏掉的空白窗口"再次显示出来
    const wc = existing.webContents
    if (wc.isCrashed() || wc.getURL() === '') {
      smallWindows.delete(hash)
      existing.destroy()
    } else {
      if (existing.isMinimized()) existing.restore()
      // 上次加载失败（例如启动竞态）时重载一次再显示
      if (wc.getURL().startsWith('about:blank')) void reloadSmallWindow(hash, existing)
      existing.show()
      existing.focus()
      return existing
    }
  }
  const win = new BrowserWindow({
    width: opts.width ?? 760,
    height: opts.height ?? 560,
    minWidth: 480,
    minHeight: 360,
    show: false,
    frame: false, // 去掉系统顶部 UI：由渲染层自绘标题栏与关闭按钮
    backgroundColor: '#f7f4f8',
    title: opts.title ?? 'Sakana',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--sakana-small']
    }
  })
  // 正常路径：就绪即显示；兜底路径：3 秒内没就绪也显示（否则渲染异常时会永远看不见窗口）
  let shown = false
  const showOnce = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    win.show()
  }
  win.once('ready-to-show', showOnce)
  setTimeout(showOnce, 3000)
  win.on('closed', () => {
    if (smallWindows.get(hash) === win) smallWindows.delete(hash)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // 加载失败/渲染进程崩溃：记录并自愈，避免留下永久空白的副窗口
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log.append('error', 'window', `副窗口加载失败 ${hash}: ${code} ${desc} ${url}`)
    if (code === -3) return // 主动中止（重定向/取消）不算失败
    setTimeout(() => {
      if (!win.isDestroyed()) {
        console.error(`[window] 副窗口重试加载: ${hash}`)
        void reloadSmallWindow(hash, win)
      }
    }, 600)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log.append('error', 'window', `副窗口渲染进程结束 ${hash}: ${details.reason}`)
    if (win.isDestroyed()) return
    // 重建而不是 reload：崩溃后的 webContents 状态不可靠
    smallWindows.delete(hash)
    win.destroy()
    setTimeout(() => openSmallWindow(hash, opts), 300)
  })
  applyIcon(win)
  smallWindows.set(hash, win)
  void loadSmallWindow(hash, win)
  return win
}

/** 加载副窗口内容（开发用 devServer，打包用本地文件） */
async function loadSmallWindow(hash: string, win: BrowserWindow): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  try {
    if (!app.isPackaged && devUrl) await win.loadURL(`${devUrl}#${hash}`)
    else await win.loadFile(rendererUrl(), { hash })
  } catch (err) {
    log.append('error', 'window', `副窗口加载异常 ${hash}: ${String((err as Error)?.message ?? err)}`)
  }
}

function reloadSmallWindow(hash: string, win: BrowserWindow): Promise<void> {
  return loadSmallWindow(hash, win)
}

export function iconPath(): string | null {
  const candidates = [
    join(app.getAppPath(), 'resources', 'icon.png'),
    join(process.resourcesPath ?? '', 'icon.png')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

export function applyIcon(win: BrowserWindow): void {
  const p = iconPath()
  if (p) win.setIcon(nativeImage.createFromPath(p))
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 980,
    height: 640,
    minWidth: 760,
    minHeight: 520,
    // v0.2.4：窗口尺寸只保留「初始小窗」与「全屏」两种，禁止用户自由拉伸
    //（自由拉伸会让页面在极端比例下错位）。
    // ⚠️ 必须保留 resizable: true —— Windows 上 Chromium 不允许「不可缩放」的窗口进入全屏，
    // setFullScreen() 会被静默忽略，表现就是「点了全屏没反应」。用户拖拽缩放改由
    // will-resize 事件拦截（见下方），程序化全屏不受影响。
    resizable: true,
    maximizable: false,
    fullscreenable: true,
    frame: false, // 方案 1：无边框 + 自定义标题栏（可拖动）
    show: false,
    backgroundColor: '#f7f4f8',
    title: 'Sakana',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())
  /*
   * 拦截用户拖拽缩放（等效于 resizable:false，但不影响全屏）。
   * will-resize 只在用户手动拉伸时触发，setBounds/setFullScreen 等程序化调用不会走这里。
   */
  win.on('will-resize', (e) => {
    e.preventDefault()
  })
  // 同理：最大化按钮已隐藏，这里再兜一层（例如双击标题栏、Win+↑ 触发系统最大化）
  win.on('maximize', () => {
    win.unmaximize()
    win.webContents.send(CH.evWinMaximize, false)
  })
  // 关闭询问：最小化至托盘 / 直接退出 / 取消
  win.on('close', (e) => {
    if (isQuitting()) return
    e.preventDefault()
    void askCloseBehavior(win)
  })
  win.on('unmaximize', () => win.webContents.send(CH.evWinMaximize, false))
  win.on('enter-full-screen', () => win.webContents.send(CH.evWinFullscreen, true))
  win.on('leave-full-screen', () => win.webContents.send(CH.evWinFullscreen, false))
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  applyIcon(win)
  mainWindow = win

  // 外部链接一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 冒烟测试模式（SAKANA_SMOKE=1）：转发渲染层日志并在加载完成后自动退出
  if (process.env.SAKANA_SMOKE) {
    win.webContents.on('console-message', (...args: unknown[]) => {
      const details =
        typeof args[1] === 'object' && args[1] !== null
          ? (args[1] as { level?: string; message?: string })
          : { level: String(args[1]), message: String(args[2]) }
      console.log(`[renderer:${details.level}] ${details.message}`)
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[smoke] did-fail-load ${code} ${desc} ${url}`)
    })
    win.webContents.on('render-process-gone', (_e, d) => {
      console.error(`[smoke] renderer gone: ${JSON.stringify(d)}`)
    })
    win.webContents.once('did-finish-load', () => {
      console.log('[smoke] did-finish-load OK')
      const ms = parseInt(process.env.SAKANA_SMOKE_MS ?? '9000', 10)
      setTimeout(() => {
        console.log('[smoke] done, quitting')
        app.quit()
      }, ms)
    })
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

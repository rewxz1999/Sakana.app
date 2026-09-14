import { app, BrowserWindow, dialog, Menu, screen, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import { log } from './log'
import { getMainWindow, iconPath } from './window'

let tray: Tray | null = null
let panelWin: BrowserWindow | null = null
let showTimer: NodeJS.Timeout | null = null
let hideTimer: NodeJS.Timeout | null = null
let quitting = false
/** 鼠标是否悬浮在小窗内部（悬浮期间不自动隐藏） */
let panelHovered = false

export function isQuitting(): boolean {
  return quitting
}

export function markQuitting(): void {
  quitting = true
}

function showMain(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 关闭主窗口时的询问（方案：最小化至托盘 / 直接退出 / 取消） */
export async function askCloseBehavior(win: BrowserWindow): Promise<void> {
  const res = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Sakana',
    message: '关闭 Sakana？',
    detail: '最小化到托盘后应用在后台继续运行，下载任务不会中断。',
    buttons: ['最小化到托盘', '直接退出', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  })
  if (res.response === 0) {
    win.hide()
    log.append('info', 'app', '最小化至托盘')
  } else if (res.response === 1) {
    markQuitting()
    app.quit()
  }
}

// ---------------- 悬浮数据小窗 ----------------

const PANEL_WIDTH = 198
const PANEL_HEIGHT = 282

function positionPanel(): void {
  if (!panelWin || !tray) return
  const bounds = tray.getBounds()
  const { workArea } = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
  let x = Math.round(bounds.x + bounds.width / 2 - PANEL_WIDTH / 2)
  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - PANEL_WIDTH - 8))
  // 托盘在屏幕上半部则窗口显示在下方，否则在上方
  const y =
    bounds.y < workArea.y + workArea.height / 2
      ? bounds.y + bounds.height + 8
      : bounds.y - PANEL_HEIGHT - 8
  panelWin.setPosition(x, y, false)
}

function rendererUrl(): string {
  return join(__dirname, '../renderer/index.html')
}

function ensurePanel(): BrowserWindow {
  if (panelWin && !panelWin.isDestroyed()) return panelWin
  panelWin = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    frame: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#10141f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void panelWin.loadURL(`${devUrl}#/tray`)
  } else {
    void panelWin.loadFile(rendererUrl(), { hash: '/tray' })
  }
  // mouse-enter / mouse-leave 为 Windows 专用事件（运行时支持）
  const w = panelWin as unknown as { on: (event: string, cb: () => void) => void }
  w.on('mouse-enter', () => {
    panelHovered = true
    cancelHide()
  })
  w.on('mouse-leave', () => {
    panelHovered = false
    scheduleHide(250)
  })
  panelWin.on('blur', () => {
    // 鼠标仍在小窗内时不因失焦而隐藏
    if (!panelHovered) scheduleHide(150)
  })
  panelWin.on('closed', () => {
    panelHovered = false
    panelWin = null
  })
  return panelWin
}

export function hidePanelNow(): void {
  if (panelWin && !panelWin.isDestroyed()) panelWin.hide()
}

function cancelHide(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

function scheduleHide(delay: number): void {
  cancelHide()
  hideTimer = setTimeout(() => {
    if (panelWin && !panelWin.isDestroyed()) panelWin.hide()
  }, delay)
}

function showPanel(): void {
  const win = ensurePanel()
  positionPanel()
  win.showInactive()
}

function scheduleShow(show: boolean): void {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
  if (show) {
    showTimer = setTimeout(() => {
      cancelHide()
      showPanel()
    }, 250)
  } else {
    scheduleHide(400)
  }
}

/** 创建系统托盘（方案：悬浮小窗显示下载/统计/历史，双击回主界面，右键退出） */
export function createTray(): void {
  const p = iconPath()
  const icon = p ? nativeImage.createFromPath(p) : nativeImage.createEmpty()
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('Sakana 番剧管理')
  const menu = Menu.buildFromTemplate([
    { label: '打开 Sakana', click: () => showMain() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        markQuitting()
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', () => showMain())
  // mouse-enter / mouse-leave 为 Windows 专用事件（类型定义未收录，运行时支持）
  const t = tray as unknown as { on: (event: string, cb: () => void) => void }
  t.on('mouse-enter', () => scheduleShow(true))
  t.on('mouse-leave', () => scheduleShow(false))
  log.append('info', 'app', '系统托盘已创建')
}

export function destroyTray(): void {
  try {
    tray?.destroy()
  } catch {
    /* ignore */
  }
  tray = null
  if (panelWin && !panelWin.isDestroyed()) panelWin.destroy()
  panelWin = null
}

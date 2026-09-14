import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, screen } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GalToolsConfig } from '@shared/types'
import { DEFAULT_GAL_TOOLS } from '@shared/types'
import { galReadWindowTitle, galRunningInfo } from './galgame'
import { maybeShowSaveHint } from './onboarding'
import { log } from '../log'
import { store } from '../store'

/**
 * galgame 截图助手 / 工具配置
 * - 配置持久化在 electron-store key `galgameTools`（渲染层经 gal:tools-get/set 读写）
 * - 截图助手开启后注册全局快捷键；不隐藏图标时在屏幕角落显示一个 56×56 悬浮拍摄按钮
 * - 截图在「截屏助手」或全局快捷键触发时由主进程 desktopCapturer 抓取整个主屏
 */

function getCfg(): GalToolsConfig {
  const c = store.get<Partial<GalToolsConfig>>('galgameTools', {})
  return { ...DEFAULT_GAL_TOOLS, ...c }
}

function saveCfg(patch: Partial<GalToolsConfig>): GalToolsConfig {
  const next = { ...getCfg(), ...patch }
  store.set('galgameTools', next)
  return next
}

// ---------------- 全局快捷键 ----------------

let lastAccel: string | null = null

function applyHotkey(cfg: GalToolsConfig): void {
  if (lastAccel) {
    try {
      globalShortcut.unregister(lastAccel)
    } catch {
      /* ignore */
    }
    lastAccel = null
  }
  if (!cfg.screenshotEnabled) return
  const accel = cfg.hotkey || DEFAULT_GAL_TOOLS.hotkey
  try {
    const ok = globalShortcut.register(accel, () => {
      void galScreenshotNow()
    })
    if (ok) {
      lastAccel = accel
      log.append('info', 'gal', `截图助手快捷键已注册: ${accel}`)
    } else {
      log.append('warn', 'gal', `截图快捷键注册失败（可能被占用或格式无效）: ${accel}`)
    }
  } catch (err) {
    log.append('warn', 'gal', `截图快捷键注册异常: ${String(err)}`)
  }
}

// ---------------- 悬浮拍摄窗口 ----------------

const OVERLAY_SIZE = 56
let overlayWin: BrowserWindow | null = null

function overlayHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;user-select:none;-webkit-user-select:none}
  #wrap{width:${OVERLAY_SIZE}px;height:${OVERLAY_SIZE}px;display:flex;align-items:center;justify-content:center}
  #btn{width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;
    background:rgba(0,0,0,.66);color:#fff;font-size:22px;line-height:1;
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 2px 10px rgba(0,0,0,.35);outline:none;backdrop-filter:blur(4px)}
  #btn:hover{background:rgba(30,30,30,.85)}
  #btn:active{transform:scale(.94)}
  #msg{position:absolute;right:8px;top:60px;background:rgba(0,0,0,.72);color:#fff;font-size:11px;
    padding:4px 8px;border-radius:6px;display:none;white-space:nowrap}
</style></head>
<body>
  <div id="wrap"><button id="btn" title="截图">📷</button></div>
  <div id="msg"></div>
  <script>
    const btn = document.getElementById('btn')
    const msg = document.getElementById('msg')
    let busy = false
    function flash(text, ok) {
      msg.textContent = text
      msg.style.display = 'block'
      msg.style.background = ok ? 'rgba(16,120,60,.85)' : 'rgba(190,40,40,.85)'
      clearTimeout(window.__t)
      window.__t = setTimeout(() => { msg.style.display = 'none' }, 1600)
    }
    btn.addEventListener('click', async () => {
      if (busy) return
      busy = true
      btn.style.opacity = '.6'
      try {
        const r = await window.sakana.gal.overlayShot()
        flash(r && r.ok ? '已保存' : ('失败: ' + (r && r.error ? r.error : '未知')), !!(r && r.ok))
      } catch (e) {
        flash('失败', false)
      } finally {
        busy = false
        btn.style.opacity = '1'
      }
    })
  </script>
</body></html>`
}

function positionOverlay(): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const wa = screen.getPrimaryDisplay().workArea
  const x = Math.round(wa.x + wa.width - OVERLAY_SIZE - 16)
  const y = Math.round(wa.y + 100)
  overlayWin.setPosition(x, y, false)
}

function ensureOverlay(): BrowserWindow {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin
  overlayWin = new BrowserWindow({
    width: OVERLAY_SIZE,
    height: OVERLAY_SIZE,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  positionOverlay()
  void overlayWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(overlayHtml()))
  overlayWin.once('ready-to-show', () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.showInactive()
  })
  overlayWin.on('closed', () => {
    overlayWin = null
  })
  return overlayWin
}

function destroyOverlay(): void {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy()
  }
  overlayWin = null
}

/** 依据配置应用快捷键与悬浮窗；仅在有游戏运行时激活（截图助手随游戏启动） */
function applyCfg(cfg: GalToolsConfig): void {
  const running = galRunningInfo() !== null
  if (!running || !cfg.screenshotEnabled) {
    applyHotkey({ ...cfg, screenshotEnabled: false })
    destroyOverlay()
    return
  }
  applyHotkey(cfg)
  if (!cfg.hideIcon) ensureOverlay()
  else destroyOverlay()
}

/** 应用启动时不激活截图助手（仅配置留存，随游戏启动而激活） */
export function galToolsInit(): void {
  applyCfg(getCfg())
}

/** 游戏启动时调用：按当前配置激活截图助手（快捷键 + 悬浮窗） */
export function galToolsActivate(): void {
  applyCfg(getCfg())
}

/** 最后一个游戏退出时调用：关闭截图助手（注销快捷键 + 销毁悬浮窗） */
export function galToolsDeactivate(): void {
  applyHotkey({ ...getCfg(), screenshotEnabled: false })
  destroyOverlay()
}

export function galToolsCleanup(): void {
  if (lastAccel) {
    try {
      globalShortcut.unregister(lastAccel)
    } catch {
      /* ignore */
    }
    lastAccel = null
  }
  destroyOverlay()
}

export function galToolsGet(): GalToolsConfig {
  return getCfg()
}

export function galToolsSet(patch: Partial<GalToolsConfig>): GalToolsConfig {
  const next = saveCfg(patch)
  applyCfg(next)
  log.append('info', 'gal', `截图助手配置已更新: ${JSON.stringify(next)}`)
  return next
}

// ---------------- 截图 ----------------

/**
 * 只截取当前运行的 galgame 窗口画面：
 * 1. 找到最近启动且仍在运行的游戏进程
 * 2. 读取其主窗口标题（检测程序的最新记录优先，其次即时读取）
 * 3. 枚举系统窗口，按标题匹配后抓取该窗口缩略图
 * 匹配不到（最小化 / 无标题 / 未启动）时报错提示，绝不截取整个屏幕。
 */
async function captureGameWindow(): Promise<Buffer> {
  const run = galRunningInfo()
  if (!run) throw new Error('未检测到正在运行的 galgame，请先启动游戏')

  const title =
    run.lastTitle ||
    (await galReadWindowTitle(run.pid)).trim() ||
    run.gameTitle

  const primary = screen.getPrimaryDisplay()
  const scale = primary.scaleFactor || 1
  const size = {
    width: Math.round(primary.size.width * scale),
    height: Math.round(primary.size.height * scale)
  }
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: size,
    fetchWindowIcons: false
  })

  const norm = (s: string): string => s.trim().toLowerCase()
  let src = title
    ? sources.find((s) => norm(s.name) === norm(title))
    : undefined
  if (!src && run.gameTitle) {
    src = sources.find((s) => norm(s.name) === norm(run.gameTitle))
  }
  if (!src) {
    throw new Error('未找到游戏窗口（窗口可能已最小化或被遮挡），请保持游戏窗口可见后重试')
  }
  if (src.thumbnail.isEmpty()) {
    throw new Error('无法截取游戏窗口画面（最小化或受保护窗口）')
  }
  const png = src.thumbnail.toPNG()
  if (!png || png.length === 0) throw new Error('截图数据为空')
  return png
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tsName(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 截图：先隐藏悬浮窗 200ms → 抓取当前游戏窗口 → 恢复悬浮窗 → 写入 <dir>/<游戏名>_<时间>.png */
export async function galScreenshotNow(): Promise<string> {
  const cfg = getCfg()
  const dir = cfg.dir || join(app.getPath('userData'), 'screenshots', 'galgame')
  mkdirSync(dir, { recursive: true })

  const win = overlayWin && !overlayWin.isDestroyed() ? overlayWin : null
  const wasVisible = !!win && win.isVisible()
  if (wasVisible) win.hide()
  try {
    await sleep(200)
    const png = await captureGameWindow()
    // 命名规则：游戏名_时间.png（无游戏信息时退回 sakana_时间.png）
    const run = galRunningInfo()
    const prefix = run?.gameTitle
      ? run.gameTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
      : 'sakana'
    const file = join(dir, `${prefix}_${tsName()}.png`)
    writeFileSync(file, png)
    log.append('info', 'gal', `游戏窗口截图已保存: ${file}`)
    maybeShowSaveHint()
    return file
  } finally {
    if (wasVisible && win && !win.isDestroyed()) win.showInactive()
  }
}

/** 悬浮窗拍摄按钮：与 galScreenshotNow 相同（截图时自动隐藏悬浮窗避免入镜） */
export function galOverlayShot(): Promise<string> {
  return galScreenshotNow()
}

// ---------------- 目录选择 ----------------

export async function galPickDir(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    title: '选择截图保存位置',
    defaultPath: getCfg().dir || undefined,
    properties: ['openDirectory', 'createDirectory']
  })
  return r.canceled ? null : (r.filePaths[0] ?? null)
}

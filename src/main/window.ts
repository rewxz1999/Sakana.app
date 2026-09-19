import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CH } from '@shared/channels'
import { log } from './log'
import { closeOffscreen, isOffscreenWindow } from './services/offscreenFetch'
import { askCloseBehavior, isQuitting } from './tray'

let mainWindow: BrowserWindow | null = null

/** 小型配置窗口（按 hash 单例复用） */
const smallWindows = new Map<string, BrowserWindow>()

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * 业务窗口列表（排除离屏取数等辅助窗口）。
 *
 * 为什么需要：`BrowserWindow.getAllWindows()` 会把离屏取数窗口也算进去，
 * 于是「第二个实例把主窗口提前」「对话框父窗口」这类逻辑可能选到那个不可见的窗口。
 */
export function realWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !isOffscreenWindow(w))
}

/** 焦点窗口（排除辅助窗口）→ 主窗口 → 任意业务窗口 */
export function focusedOrMain(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !isOffscreenWindow(focused)) return focused
  const main = getMainWindow()
  if (main && !main.isDestroyed()) return main
  return realWindows()[0] ?? null
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

/**
 * 打开**更新窗口**（v0.2.12）。
 *
 * 用户要求「更新程序现在需要一个可视化界面让用户看到更新进度，更新程序现在也是一个
 * 十分重要、且优先级较高的模块」——所以给它一个独立窗口：不占主窗口版面、
 * 不影响用户继续浏览番剧，进度条与阶段说明始终在眼前。
 * 直接复用小窗口那套壳（自绘标题栏 + 单例 + 崩溃重建），只有尺寸与标题不同。
 */
export function openUpdateWindow(): BrowserWindow {
  return openSmallWindow('/update', { width: 660, height: 560, title: 'Sakana 更新' })
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
    // v0.2.5：恢复自由缩放（用户要求「可以自由调节应用窗口大小」），并保留全屏能力。
    // 历史教训：不要用 resizable:false 或 will-resize 去锁尺寸 —— Windows 上 Chromium
    // 不允许「不可缩放」的窗口进入全屏，setFullScreen() 会被静默忽略（点了全屏没反应）。
    resizable: true,
    maximizable: true,
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
    /*
     * 主窗口关掉时一并收掉离屏取数窗口：
     * 否则它会让 `window-all-closed` 永远不触发，应用退不干净。
     */
    closeOffscreen()
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
      /*
       * 关闭行为自检（SAKANA_CLOSE_TEST=1，v0.2.8 附加）：
       * 触发一次「关闭窗口」，看它是弹询问框、直接退回托盘还是直接退出 ——
       * 配合 settings.closeBehaviorRemembered 验证「记住本次选择」是否生效。
       * 有弹框时本自检会卡住（不会自动点按钮），这也是一个明确的失败信号。
       */
      if (process.env.SAKANA_CLOSE_TEST) {
        setTimeout(() => {
          console.log('[smoke] 触发关闭窗口（SAKANA_CLOSE_TEST）')
          win.close()
          setTimeout(() => {
            console.log(`[smoke] 关闭后：窗口可见=${win.isVisible()} 已销毁=${win.isDestroyed()}`)
            app.quit()
          }, 2500)
        }, Math.max(4000, ms))
        return
      }
      if (process.env.SAKANA_ANNOUNCE_TEST) {
        setTimeout(() => {
          void (async () => {
            const sleep = (n: number): Promise<void> => new Promise((r) => setTimeout(r, n))
            try {
              const before = (await win.webContents.executeJavaScript(
                `JSON.stringify({open:/更新公告/.test(document.body.innerText), muted:(document.querySelector('input[type=checkbox]')||{}).checked===true})`,
                true
              )) as string
              console.log(`[smoke] 公告初始：${before}`)
              // 关键：**不勾选**「不再提示」，直接点「知道了」
              const clicked = (await win.webContents.executeJavaScript(
                `(function(){
                   var btns=Array.prototype.slice.call(document.querySelectorAll('button'));
                   var b=btns.filter(function(x){return (x.innerText||'').trim()==='知道了'})[0];
                   if(!b) return false;
                   b.click();
                   return true
                 })()`,
                true
              )) as boolean
              console.log(`[smoke] 已点击「知道了」（未勾选）：${clicked}`)
              await sleep(2500)
              const after = (await win.webContents.executeJavaScript(
                `JSON.stringify({open:/更新公告/.test(document.body.innerText)})`,
                true
              )) as string
              console.log(`[smoke] 关闭后：${after}（期望 open=false）`)
            } catch (err) {
              console.log(`[smoke] 公告自检失败: ${String(err).slice(0, 120)}`)
            }
            console.log('[smoke] done, quitting')
            app.quit()
          })()
        }, Math.max(5000, ms))
        return
      }
      setTimeout(() => {
        /*
         * v0.2.8 附加：退出前把主界面正文前 400 字带出来 ——
         * 启动公告（AnnouncementModal）这类只挂在主窗口上的弹窗，
         * 副窗口自检看不到，靠这里核对。
         */
        void win.webContents
          .executeJavaScript(
            `(function(){
               var b=document.body;
               var t=b?b.innerText:'';
               var imgs=Array.prototype.filter.call(document.images||[],function(i){return i.complete&&i.naturalWidth>0}).length;
               return JSON.stringify({
                 announce:/更新公告/.test(t), muted:/不再提示/.test(t), checkbox:!!document.querySelector('input[type=checkbox]'),
                 text:t.replace(/\\s+/g,' ').slice(0,160), len:t.length, imgs:imgs
               })
             })()`,
            true
          )
          .then((s) => console.log(`[smoke] 主界面：${String(s)}`))
          .catch(() => undefined)
          .finally(() => {
            console.log('[smoke] done, quitting')
            app.quit()
          })
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

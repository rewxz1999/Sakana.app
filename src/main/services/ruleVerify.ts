import { BrowserWindow } from 'electron'
import { log } from '../log'

/**
 * 人机验证窗口（v0.3.7，用户要求）。
 *
 * ## 为什么需要它
 *
 * 有些线路的站点会给非浏览器请求返回一张「人机验证」页（实测：樱之空 `skr.skrcc.cc:666`
 * 的搜索接口现在直接 403，正文就是验证页）。以前遇到这种情况应用只能报一句
 * 「搜索失败：Request failed with status code 403」，用户完全无从下手。
 *
 * 既然应用本来就有真实浏览器窗口（搜索回退、嗅探都用它），那就把这块能力交给用户：
 * **在应用内弹一个窗口把站点页面显示出来，让用户自己过一次验证**。
 *
 * ## 为什么验证完就能用
 *
 * 这个窗口用的是 `session.defaultSession`，与网页内搜索（`ruleSearchWebview`）**同一个会话** ——
 * 用户过完验证后站点下发的 Cookie 就在这个会话里，
 * 于是后续「用网页窗口搜索/嗅探」这条路直接就是已验证状态，不需要用户再做任何事。
 * （纯 HTTP 那条路（axios）没有 Cookie 罐，所以验证后仍然走网页窗口，这一点写在 rules.ts 的注释里。）
 *
 * ## 窗口怎么摆
 *
 * 渲染层弹出一个"缺一块"的蒙层，把中间那块矩形（CSS 像素、视口坐标）传过来，
 * 这里换算成屏幕坐标后开一个**属于主窗口的子窗口**盖在那一块上 ——
 * 与播放页把探针网页视图摆在画面区域上是同一个思路。
 * 子窗口随主窗口移动/最小化，不会浮到别的应用上面。
 */

let verifyWin: BrowserWindow | null = null
let hostWin: BrowserWindow | null = null
/** 当前验证的是哪条规则（日志与界面提示用） */
let currentRuleName = ''

export interface VerifyBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 视口坐标（CSS px）→ 屏幕坐标 */
function toScreen(win: BrowserWindow, b: VerifyBounds): VerifyBounds {
  let ox = 0
  let oy = 0
  try {
    const cb = win.getContentBounds()
    ox = cb.x
    oy = cb.y
  } catch {
    /* 拿不到窗口位置就按屏幕原点算 */
  }
  return {
    x: Math.round(ox + b.x),
    y: Math.round(oy + b.y),
    // 太小的话站点页面根本没法操作（验证码要看清）
    width: Math.max(360, Math.round(b.width)),
    height: Math.max(280, Math.round(b.height))
  }
}

export function openVerifyWindow(
  win: BrowserWindow,
  url: string,
  bounds: VerifyBounds,
  ruleName: string
): boolean {
  closeVerifyWindow()
  hostWin = win
  currentRuleName = ruleName
  const s = toScreen(win, bounds)
  try {
    verifyWin = new BrowserWindow({
      parent: win,
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      show: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
  } catch (err) {
    log.append('error', 'rule-verify', `验证窗口创建失败: ${String(err)}`)
    verifyWin = null
    return false
  }
  /*
   * 站点的验证页/跳转常常要开新窗口：一律在**同一个窗口里**打开，
   * 否则会弹出一个独立窗口跑到应用外面去（用户找不到，验证状态也散在多个窗口里）。
   */
  verifyWin.webContents.setWindowOpenHandler(({ url: target }) => {
    void verifyWin?.loadURL(target)
    return { action: 'deny' }
  })
  verifyWin.on('closed', () => {
    verifyWin = null
    hostWin = null
    currentRuleName = ''
  })
  void verifyWin.loadURL(url).catch((err) => {
    log.append('warn', 'rule-verify', `验证页加载失败: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
  })
  // 只记站点主机名，不打印完整地址（用户要求不打印站点地址）
  let host = '未知站点'
  try {
    host = new URL(url).host
  } catch {
    /* ignore */
  }
  log.append('info', 'rule-verify', `已打开人机验证窗口（${ruleName} / ${host}）`)
  return true
}

/** 蒙层尺寸变化时重新摆放（窗口缩放等） */
export function setVerifyBounds(bounds: VerifyBounds): void {
  if (!verifyWin || verifyWin.isDestroyed() || !hostWin || hostWin.isDestroyed()) return
  const s = toScreen(hostWin, bounds)
  try {
    verifyWin.setBounds(s)
  } catch {
    /* ignore */
  }
}

export function closeVerifyWindow(): void {
  const w = verifyWin
  verifyWin = null
  hostWin = null
  const rule = currentRuleName
  currentRuleName = ''
  if (!w || w.isDestroyed()) return
  try {
    w.webContents.stop()
    w.destroy()
    if (rule) log.append('info', 'rule-verify', `已关闭验证窗口（${rule}）`)
  } catch {
    /* ignore */
  }
}

export function verifyWindowOpen(): boolean {
  return !!verifyWin && !verifyWin.isDestroyed()
}

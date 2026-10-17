import { BrowserWindow } from 'electron'
import { CH } from '@shared/channels'
import { log } from '../log'

/**
 * 人机验证窗口（v0.3.7，用户要求；v1.1 改成「应用内一体化」）。
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
 * ## 为什么要「状态上报」（v1.1 新增，用户要求"用我们的应用 UI"）
 *
 * 以前渲染层只知道"窗口开了没有"：中间那块真实网页在加载中、加载完了、还是失败了，
 * 外框一点都不知道 —— 于是外框写死一句「验证窗口正在这里打开…」，
 * 和里面正在发生的真实事情对不上，正是用户说的"原生窗口与网页拼在一起的割裂感"。
 * 现在这里把 did-start-loading / did-stop-loading / did-fail-load 转成事件推给渲染层，
 * 外框用它自己的标题、进度条、状态文字与重试按钮来反映真实进度；
 * 页面本身仍然是真实的独立窗口（**不能**塞进主窗口 DOM：跨站会被 X-Frame-Options 拦）。
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
 * 渲染层弹出一个"缺一块"的应用内弹窗，把中间那块矩形（CSS 像素、视口坐标）传过来，
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

/**
 * 验证页的加载状态（推给渲染层）。
 *
 * `progress` 是 guessed：Chromium 的 did-start-loading/did-stop-loading 只给"开始/结束"
 * 两个边沿，没有真实百分比。所以 progress 只用来画一个**不确定**的动画条，
 * 到 `loaded` 就归 100 —— 不编造假百分比。
 */
export interface VerifyState {
  status: 'loading' | 'loaded' | 'failed' | 'closed'
  /** 0–100：loading 时是 -1（表示"不确定"），loaded 是 100 */
  progress: number
  /** 失败原因（status='failed' 时有值） */
  error?: string
  /** 当前页面的主机名（界面上显示"正在加载 xxx"；不打印完整路径） */
  host?: string
}

let lastState: VerifyState = { status: 'closed', progress: 0 }

/** 把状态推给宿主窗口（外框据此更新自己的 UI） */
function pushState(patch: Partial<VerifyState>): void {
  lastState = { ...lastState, ...patch }
  const w = hostWin
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return
  try {
    w.webContents.send(CH.evRuleVerifyState, lastState)
  } catch {
    /* 窗口正在销毁时忽略 */
  }
}

export function verifyState(): VerifyState {
  return { ...lastState }
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
    pushState({ status: 'closed', progress: 0 })
  })
  /*
   * 加载状态 → 推给外框（v1.1）。
   *
   * 这里**只做转述**：不推测"验证过没过"（站点没有可靠的判据），
   * 只如实报告"页面还在加载 / 加载完了 / 加载失败了，原因是 xxx"。
   * 用户要的是外框不再和里面的真实状态割裂，而不是一个假装的进度条。
   */
  const wc = verifyWin.webContents
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    /* ignore */
  }
  wc.on('did-start-loading', () => pushState({ status: 'loading', progress: -1, host, error: undefined }))
  wc.on('did-stop-loading', () => pushState({ status: 'loaded', progress: 100, host }))
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    // 子框架失败不算：验证页本身常常嵌广告/统计 iframe，它们失败是常态
    if (!isMainFrame) return
    // -3 = ERR_ABORTED（用户点了重试/页面自己跳转），不是失败
    if (code === -3) return
    const reason = `验证页加载失败（${code} ${desc}）：${String(failedUrl ?? '').slice(0, 80)}`
    log.append('warn', 'rule-verify', reason)
    pushState({ status: 'failed', progress: 0, error: reason, host })
  })
  wc.on('did-navigate', () => {
    // 页面跳转（例如验证通过后的跳转）：重新进入加载态，避免外框停在旧的"已完成"
    pushState({ status: 'loading', progress: -1 })
  })
  pushState({ status: 'loading', progress: -1, host, error: undefined })
  void verifyWin.loadURL(url).catch((err) => {
    const msg = String((err as Error)?.message ?? err).slice(0, 120)
    log.append('warn', 'rule-verify', `验证页加载失败: ${msg}`)
    pushState({ status: 'failed', progress: 0, error: msg, host })
  })
  // 只记站点主机名，不打印完整地址（用户要求不打印站点地址）
  log.append('info', 'rule-verify', `已打开人机验证窗口（${ruleName} / ${host || '未知站点'}）`)
  return true
}

/**
 * 重新加载验证页（v1.1：外框上的「重新加载」按钮）。
 *
 * 为什么需要：站点偶发 5xx / 网络抖动时，用户唯一的出路是关掉弹窗再点一次源 ——
 * 但那会把已经过了一半的验证（Cookie 也许已经下发）一起丢掉。就地重载更合理。
 */
export function reloadVerifyWindow(): boolean {
  const w = verifyWin
  if (!w || w.isDestroyed()) return false
  try {
    w.webContents.reload()
    pushState({ status: 'loading', progress: -1, error: undefined })
    return true
  } catch {
    return false
  }
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
  lastState = { status: 'closed', progress: 0 }
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

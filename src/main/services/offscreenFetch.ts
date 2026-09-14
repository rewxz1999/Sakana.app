import { BrowserWindow } from 'electron'
import { log } from '../log'
import { BROWSER_UA } from '../net'

/**
 * 离屏浏览器取数（v0.2.5）
 *
 * 为什么需要它：bangumi.vip 这类镜像站在前面挂了 JS 机器人校验
 * （Anubis 的 PoW / Cloudflare 的「Just a moment」），主进程 axios 只会拿到挑战页，
 * 而**真实浏览器导航**会自动完成校验并拿到真正的服务端渲染 HTML。
 *
 * 关键实现取舍：用「导航 + 读 DOM」而不是「页面内 fetch」。
 * 实测同一站点：导航已经通过校验，但紧接着的 fetch 仍可能被判定为未授权而再次返回挑战页；
 * 导航方式则天然复用校验流程，稳定性最好。
 */

const CHALLENGE_RE =
  /正在确认你是不是机器人|Just a moment|challenges\.cloudflare|within\.website\/x\/cmd\/anubis|Checking your browser|请稍候/i

let win: BrowserWindow | null = null
let busy: Promise<unknown> = Promise.resolve()
let idleTimer: NodeJS.Timeout | null = null

/** 空闲多久自动关掉离屏窗口：留着能省一次机器人校验，但也不能永久挂着一个窗口 */
const IDLE_CLOSE_MS = 5 * 60 * 1000

/**
 * 是否是本模块创建的离屏辅助窗口。
 *
 * 必须能被识别出来：它同样是 BrowserWindow，会出现在 `BrowserWindow.getAllWindows()` 中，
 * 于是会被「第二个实例」「对话框父窗口」「自检模式取窗口」等逻辑误当成主窗口 ——
 * 实测症状是：全屏自检测到的是这个离屏窗口（host=null），`second-instance` 会把镜像站页面
 * 当成主窗口去 show/focus。
 */
export function isOffscreenWindow(w: BrowserWindow | null | undefined): boolean {
  return !!win && !win.isDestroyed() && w === win
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    closeOffscreen()
  }, IDLE_CLOSE_MS)
  // 不因为这个定时器而阻止进程退出
  idleTimer.unref?.()
}

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    show: true,
    x: -4000,
    y: 0,
    width: 1280,
    height: 900,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  win.webContents.setUserAgent(BROWSER_UA)
  win.on('closed', () => {
    win = null
  })
  return win
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 页面当前是否仍是校验页（拿标题与正文长度判断） */
async function challengeState(wc: Electron.WebContents): Promise<{ challenge: boolean; len: number; title: string }> {
  try {
    const raw = (await wc.executeJavaScript(
      `JSON.stringify({ t: document.title || '', n: (document.documentElement.outerHTML || '').length, head: (document.documentElement.outerHTML || '').slice(0, 4000) })`,
      true
    )) as string
    const d = JSON.parse(raw) as { t: string; n: number; head: string }
    const challenge = CHALLENGE_RE.test(d.t) || CHALLENGE_RE.test(d.head) || d.n < 2000
    return { challenge, len: d.n, title: d.t }
  } catch {
    return { challenge: true, len: 0, title: '' }
  }
}

/**
 * 打开一个地址并返回其内容。
 * - `json: true` 时返回页面正文文本（导航到 JSON 地址时浏览器会把 JSON 显示在 body 里）
 * - 校验页会自动等待（最多 waitMs），仍失败则抛错，由调用方决定回退
 */
export async function offscreenGet(
  url: string,
  opts: { waitMs?: number; json?: boolean } = {}
): Promise<string> {
  const waitMs = opts.waitMs ?? 20000
  // 串行化：同一个离屏窗口不能同时被两个请求导航
  const task = busy.then(async () => {
    const w = ensureWindow()
    const wc = w.webContents
    try {
      await wc.loadURL(url, { userAgent: BROWSER_UA })
    } catch (err) {
      const e = err as { code?: string; message?: string }
      // -3 = ERR_ABORTED（校验完成后跳转），继续读内容即可
      if (e?.code !== 'ERR_ABORTED') {
        log.append('warn', 'offscreen', `加载失败 (${e?.code ?? ''}): ${String(e?.message ?? err).slice(0, 120)}`)
      }
    }
    const started = Date.now()
    let last = await challengeState(wc)
    if (last.challenge) {
      log.append('info', 'offscreen', `检测到机器人校验页，等待自动通过：${url.slice(0, 90)}`)
    }
    while (last.challenge && Date.now() - started < waitMs) {
      await sleep(1000)
      last = await challengeState(wc)
    }
    if (last.challenge) {
      throw new Error(`校验未通过（${last.title || '未知页面'}，${last.len} 字节）`)
    }
    const content = (await wc.executeJavaScript(
      opts.json ? `document.body ? document.body.innerText : ''` : `document.documentElement.outerHTML`,
      true
    )) as string
    log.append('info', 'offscreen', `取数成功 ${url.slice(0, 90)}（${content.length} 字节，${Date.now() - started}ms）`)
    // 每次用完都重置空闲计时：长时间不再取数就把这个窗口收掉，避免它一直占着一个 BrowserWindow
    scheduleIdleClose()
    return content
  })
  // 无论成功失败都把队列接下去，避免一次失败卡死后续请求
  busy = task.catch(() => undefined)
  return task as Promise<string>
}

/** 关闭离屏窗口（长时间不用或退出应用时调用） */
export function closeOffscreen(): void {
  const w = win
  win = null
  if (w && !w.isDestroyed()) {
    try {
      w.webContents.stop()
    } catch {
      /* ignore */
    }
    setImmediate(() => {
      try {
        if (!w.isDestroyed()) w.destroy()
      } catch {
        /* ignore */
      }
    })
  }
}

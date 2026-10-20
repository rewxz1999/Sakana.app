import { BrowserWindow, session } from 'electron'
import { log } from '../../log'

/**
 * 用**不可见窗口**加载一个页面，并截获它内部发出的某条请求 URL（V1.4）。
 *
 * ## 为什么需要它
 * E站（ezdmw）的弹幕池和视频流都在一个**跨站 iframe** 里：
 *   `https://player.ezdmw.com/danmuku/?nk=<nk>&…`
 * 外层播放页的 HTML 只有 iframe 地址，真正的两个请求都发生在 iframe 内部：
 *   · 弹幕：`/index/getData.html?video_id=…&json=xml&danmu=…&sign=<md5>`
 *   · 播放列表：`/index/listres/…/sign/<md5>.webp`（**伪装成图片的 m3u8**）
 * 应用现有的嗅探窗口加载的是外层页，看不到 iframe 里的请求（真机实测：日志里一条都没有）。
 * 所以这里单独起一个隐藏窗口，**只监听它自己的会话分区**，不碰主会话的流量。
 *
 * ## 为什么 `sign` 必须截获而不是自己算
 * sign 由站点 JS 现算（算法在 `ABPlayer.min.js` 里），拿不到就无法构造请求；
 * 复用"它自己发出的那条 URL"最稳 —— 等于让我们的窗口替用户点了一次播放。
 *
 * 任何失败都返回 null（调用方按"这次没拿到"处理），不抛异常影响上层。
 */
export interface CaptureOptions {
  /** 命中这条正则的请求 URL 会被返回（第一条命中的） */
  match: RegExp
  /** 最长等待（毫秒），默认 20 秒 */
  timeoutMs?: number
  /** 加载时带的 Referer（不少站点会校验） */
  referer?: string
  /** 日志里标识这次截获的用途（不写地址） */
  label: string
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export async function captureRequestUrl(url: string, opts: CaptureOptions): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  const partition = `persist:sakana-capture-${process.pid}`
  let win: BrowserWindow | null = null
  let ses: Electron.Session | null = null
  try {
    ses = session.fromPartition(partition)
    let resolveHit: (v: string | null) => void = () => {}
    const hit = new Promise<string | null>((res) => {
      resolveHit = res
    })
    const timer = setTimeout(() => resolveHit(null), timeoutMs)
    /*
     * 监听必须**早于** loadURL：否则页面首批请求（往往就包含目标 XHR）会漏掉。
     * 这也是为什么先注册 webRequest、再建窗口加载。
     */
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
      cb({})
      try {
        if (opts.match.test(details.url)) {
          clearTimeout(timer)
          resolveHit(details.url)
        }
      } catch {
        /* 正则异常不影响请求继续 */
      }
    })

    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: { partition, offscreen: true }
    })
    win
      .loadURL(url, {
        userAgent: UA,
        ...(opts.referer ? { extraHeaders: `Referer: ${opts.referer}\n` } : {})
      })
      .catch(() => {
        /* 加载失败就等超时或命中，下面统一处理 */
      })

    const found = await hit
    if (!found) log.append('info', 'danmaku', `${opts.label} 未截获到目标请求（超时 ${timeoutMs}ms）`)
    return found
  } catch (err) {
    log.append('warn', 'danmaku', `${opts.label} 截获失败：${String((err as Error)?.message ?? err).slice(0, 60)}`)
    return null
  } finally {
    try {
      ses?.webRequest.onBeforeRequest(null)
    } catch {
      /* ignore */
    }
    try {
      win?.destroy()
    } catch {
      /* ignore */
    }
  }
}

import { BrowserWindow, session } from 'electron'
import { CH } from '@shared/channels'
import { log } from '../log'
import { BROWSER_UA } from '../net'
import { addProbeListeners } from './probeEvents'
import { noteCapturedStream } from './playerInfo'
import { MEDIA_EXT_RE, extractStreamFromHtml, notifyProbeHook, resolvePlayable } from './ruleProbe'

/**
 * Kazumi 式在线播放（useWebview）：
 * 规则仓库里所有规则都声明 useWebview=true —— 先用**真实可见的网页视图**打开播放页，
 * 让站点自己的播放器在正常会话（Cookie / JS / 同源请求）中跑起来，
 * 再把它请求到的媒体地址交给 libVLC 播放。
 *
 * 与之前的"屏幕外隐藏窗口嗅探"的区别：
 * - 视图可见且附着在主窗口上（页面认为自己在前台，不会因不可见而不初始化播放器）
 * - 加载前先启用 CDP Network 域，页面首批请求（播放器配置 API）不会漏
 * - 命中流地址后立即移除视图，用户只会短暂看到网页内容
 */

let view: BrowserWindow | null = null
let hostWin: BrowserWindow | null = null
let active = false
/** 当前网页视图嗅探的监听注销函数 */
let disposeListeners: (() => void) | null = null
let foundUrls: string[] = []
let doneTimer: NodeJS.Timeout | null = null
let emitWin: BrowserWindow | null = null

function emit(payload: Record<string, unknown>): void {
  const w = emitWin
  if (w && !w.isDestroyed()) w.webContents.send(CH.evRuleProbe, payload)
  notifyProbeHook(payload)
  if (process.env.SAKANA_PROBE_VERBOSE) {
    console.log(`[rule-webview] emit: ${JSON.stringify(payload).slice(0, 180)}`)
  }
}

function pickBest(urls: string[]): string | null {
  const list = urls.map(unwrapPlayerUrl)
  const m3u8 = list.find((u) => /\.m3u8(\?|$)/i.test(u))
  if (m3u8) return m3u8
  const master = list.find((u) => /master|index\.m3u8|\.mpd(\?|$)/i.test(u))
  if (master) return master
  return list.find((u) => /\.(mp4|flv)(\?|$)/i.test(u)) ?? list[0] ?? null
}

/**
 * 播放器外壳解包：不少站点把真实流地址塞在播放器页面的查询参数里
 * （如 baimao 捕获到 `…/player/artplayer/index.html?url=https://…/index.m3u8`）。
 * 直接把这个 HTML 页面交给内核当然播不了 —— 这里把内层地址取出来。
 */
function unwrapPlayerUrl(raw: string): string {
  try {
    const u = new URL(raw)
    for (const key of ['url', 'v', 'video', 'src', 'file', 'u']) {
      const v = u.searchParams.get(key)
      if (!v) continue
      const inner = decodeURIComponent(v)
      if (/^https?:\/\//i.test(inner) && MEDIA_EXT_RE.test(inner)) return inner
    }
  } catch {
    /* 不是合法 URL 就原样返回 */
  }
  return raw
}

/** 把媒体地址交给渲染层（去重；附带该地址可用的 Cookie，便于播放器/FFmpeg 复用站点会话） */
function reportFound(url: string, kind: string, referer?: string): void {
  const target = unwrapPlayerUrl(url)
  if (!active || foundUrls.includes(target)) return
  foundUrls.push(target)
  noteCapturedStream({ url: target, kind, referer, channel: 'webview', capturedAt: Date.now() })
  log.append('info', 'rule-webview', `捕获媒体流(${kind}): ${target.slice(0, 130)}`)
  // 异步补齐 Cookie 后再上报，避免播放器取流时缺少站点会话
  void collectCookies(target).then((cookies) => {
    emit({ type: 'found', url: target, kind, referer, cookies })
  })
}

/** 取该地址对应站点的 Cookie（来自嗅探会话），供 libVLC / FFmpeg 中转复用 */
async function collectCookies(url: string): Promise<string | undefined> {
  try {
    const list = await session.defaultSession.cookies.get({ url })
    if (!list.length) return undefined
    const str = list.map((c) => `${c.name}=${c.value}`).join('; ')
    if (str) log.append('info', 'rule-webview', `附带 Cookie ${list.length} 条`)
    return str || undefined
  } catch {
    return undefined
  }
}

/**
 * 自动播放脚本。
 *
 * 返回值是**播放按钮在页面坐标系里的中心点**（可能为 null）：
 * 主进程拿到坐标后会用 `sendInputEvent` 发一次**真实鼠标事件**。
 * 为什么需要这样：部分站点（实测 TvTFun）的播放按钮 onClick 第一行是
 * `if (!e.nativeEvent.isTrusted) return;` —— `el.click()` 产生的是合成事件，
 * 会被直接丢弃，于是播放器解析组件永不挂载、网络层一个媒体请求都没有，
 * 表现为「能搜到剧集但 30 秒抓不到流」。真实输入事件 isTrusted=true，可以过这道门。
 */
const AUTO_PLAY_SCRIPT = `(() => {
  let firstRect = null
  const tryPlay = () => {
    for (const v of Array.from(document.querySelectorAll('video'))) {
      try { v.muted = false; v.play && v.play() } catch (e) {}
    }
    const sels = ['#play','.play','.play-btn','.play-button','.vjs-big-play-button','.dplayer-play-icon','.artplayer-plugin-video-control','.MacPlayer','.player-mask','[class*="play" i]','[title*="播放"]','[aria-label*="播放"]']
    for (const sel of sels) {
      const el = document.querySelector(sel)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (!firstRect && r.width > 2 && r.height > 2) {
        firstRect = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      }
      if (el.click) { try { el.click() } catch (e) {} }
    }
    // 常见"点击画面开始播放"遮罩
    const mask = document.querySelector('.dplayer-mask, .MacPlayer, .player-panel, #player')
    if (mask) {
      const r = mask.getBoundingClientRect()
      if (!firstRect && r.width > 2 && r.height > 2) {
        firstRect = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      }
      if (mask.click) { try { mask.click() } catch (e) {} }
    }
    return firstRect
  }
  let n = 0
  const t = setInterval(() => { n++; tryPlay(); if (n > 12) clearInterval(t) }, 1200)
  return JSON.stringify(tryPlay())
})()`

/**
 * 在页面脚本执行前注入的小补丁。
 *
 * TvTFun 这类站点把「播放器解析组件」的挂载门控在 `sessionStorage['tvt-play-gesture']==='1'`，
 * 只有真实点击播放按钮才会写入。这个门是**纯前端 UI 门**（服务端只校验播放页下发的 HttpOnly
 * Cookie），因此预置标记就能让解析组件挂载、发出取流的 API 请求，进而被我们的嗅探捕获。
 * 其它站点读不到这个 key，设置它是无害的。
 */
const PRELOAD_PATCH = `(() => {
  try { sessionStorage.setItem('tvt-play-gesture', '1') } catch (e) {}
  try { sessionStorage.setItem('tvt-play-ctx', '') } catch (e) {}
})()`

/** 用真实鼠标事件点击页面坐标（isTrusted=true，能过站点的「可信手势」校验） */
function sendRealClick(wc: Electron.WebContents, x: number, y: number): void {
  try {
    const cx = Math.round(x)
    const cy = Math.round(y)
    wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy })
    wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
    log.append('info', 'rule-webview', `已用真实鼠标事件点击播放按钮 (${cx},${cy})`)
  } catch (err) {
    log.append('warn', 'rule-webview', `真实鼠标事件失败: ${String((err as Error)?.message ?? err)}`)
  }
}

/** 打开嗅探窗口并开始捕获；命中后由渲染层调用 closeRuleWebview 销毁 */
export function openRuleWebview(
  mainWin: BrowserWindow,
  url: string,
  bounds: { x: number; y: number; width: number; height: number },
  referer?: string
): boolean {
  closeRuleWebview()
  active = true
  foundUrls = []
  emitWin = mainWin
  hostWin = mainWin

  /*
   * 用「屏幕外可见的 BrowserWindow」而不是 WebContentsView。
   * 实测（0.2.2）WebContentsView 这条路在本项目里 CDP 事件恒为 0、
   * 报 "target closed"，页面等于从未加载 —— 于是所有依赖网页播放器的站点
   * （akianime / baimao / 7sefun / TvTFun …）必然抓不到流，
   * 而此前成功的案例其实都来自「播放页 HTML 直出」这条路径。
   * 屏幕外可见窗口与搜索/选集用的是同一套（已验证可用）机制：
   * show:true 让页面不处于 document.hidden（多数播放器因此才会初始化），
   * 坐标放到屏幕外因此用户看不到。
   */
  const w = Math.max(640, Math.round(bounds.width))
  const h = Math.max(480, Math.round(bounds.height))
  let captureWin: BrowserWindow
  try {
    captureWin = new BrowserWindow({
      show: true,
      x: -4000,
      y: 0,
      width: w,
      height: h,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
  } catch (err) {
    log.append('error', 'rule-webview', `嗅探窗口创建失败: ${String(err)}`)
    active = false
    return false
  }
  view = captureWin
  const wc = captureWin.webContents
  const ses = session.defaultSession
  void ses

  // 1) 网络层嗅探（媒体扩展名 / media 资源类型）
  const onBeforeRequest = (details: { url: string; resourceType: string }): void => {
    if (!active) return
    if (details.resourceType === 'media' || MEDIA_EXT_RE.test(details.url)) {
      reportFound(details.url, /\.m3u8(\?|$)/i.test(details.url) ? 'm3u8' : 'media')
    }
  }
  const onCompleted = (details: { url: string; statusCode: number }): void => {
    if (!active) return
    if (details.statusCode < 400 && MEDIA_EXT_RE.test(details.url)) {
      reportFound(details.url, /\.m3u8(\?|$)/i.test(details.url) ? 'm3u8' : 'media')
    }
  }
  // 共享嗅探监听（webRequest 每事件只允许一个监听器，统一在 probeEvents 注册）
  if (disposeListeners) disposeListeners()
  disposeListeners = addProbeListeners({ onBeforeRequest, onCompleted })

  // 2) CDP 深度嗅探：先启用 Network 域再加载页面，页面首批请求（播放器 API）不会漏
  const cdpCandidates = new Map<string, string>()
  let cdpReady: Promise<void> = Promise.resolve()
  let cdpEvents = 0
  try {
    wc.debugger.attach('1.3')
    /*
     * 关键：CDP 握手不能阻塞页面加载。
     * 此前 `cdpReady.then(loadURL)` 把加载挂在 Network.enable 上，而该命令在某些情况下
     * 一直不返回（直到窗口销毁才报 "target closed"）——结果页面从未加载，
     * CDP 事件恒为 0、一个请求都发不出，表现为「所有依赖网页播放器的站点都抓不到流」。
     * 现在最多等 1.5 秒，超时就照样加载（Network.enable 与加载并行完成）。
     */
    cdpReady = Promise.race([
      // 页面脚本执行前注入补丁：部分站点（TvTFun）把播放器解析组件的挂载门控在
      // sessionStorage 标记上，只有「可信点击」才会写入 —— 预置标记即可让解析器挂载，
      // 进而发出取流请求被我们抓到（细节见 PRELOAD_PATCH 注释）
      wc.debugger
        .sendCommand('Page.enable')
        .then(() => wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PRELOAD_PATCH }))
        .then(() => undefined)
        .catch((err) => {
          log.append('warn', 'rule-webview', `预注入脚本失败（不影响嗅探）: ${String(err).slice(0, 120)}`)
        }),
      wc.debugger
        .sendCommand('Network.enable')
        .then(() => undefined)
        .catch((err) => {
          log.append('warn', 'rule-webview', `CDP Network.enable 失败: ${String(err).slice(0, 120)}`)
        }),
      new Promise<void>((r) => setTimeout(r, 1500))
    ])
    wc.debugger.on('detach', (_e, reason) =>
      log.append('warn', 'rule-webview', `CDP 调试器已分离: ${String(reason)}`)
    )
    if (process.env.SAKANA_PROBE_VERBOSE) {
      const timer = setInterval(() => {
        if (!active) {
          clearInterval(timer)
          return
        }
        console.log(`[rule-webview-net] 累计 CDP 事件 ${cdpEvents}`)
      }, 5000)
    }
    wc.debugger.on('message', (_e, method, params) => {
      if (!active) return
      cdpEvents++
      try {
        if (method === 'Network.responseReceived') {
          const p = params as {
            requestId?: string
            type?: string
            response?: { url?: string; mimeType?: string; status?: number }
          }
          const rurl = p.response?.url ?? ''
          const mime = (p.response?.mimeType ?? '').toLowerCase()
          if (process.env.SAKANA_PROBE_VERBOSE && rurl) {
            console.log(
              `[rule-webview-net] ${String(p.type ?? '?')} ${String(p.response?.status ?? '')} ${mime.split(';')[0]} ${rurl.slice(0, 150)}`
            )
          }
          if (!rurl) return
          if (/mpegurl|dash\+xml|vnd\.apple/i.test(mime) || /\.(m3u8|mpd)(\?|$)/i.test(rurl)) {
            reportFound(rurl, /mpd/i.test(rurl) ? 'dash' : 'm3u8')
            return
          }
          if (
            /^video\//i.test(mime) ||
            ['XHR', 'Fetch', 'Media', 'Other'].includes(String(p.type ?? '')) ||
            MEDIA_EXT_RE.test(rurl)
          ) {
            if (p.requestId) cdpCandidates.set(p.requestId, `${rurl}\u0000${mime}`)
          }
        } else if (method === 'Network.loadingFinished') {
          const p = params as { requestId?: string; encodedDataLength?: number }
          const id = p.requestId
          if (!id) return
          const cached = cdpCandidates.get(id)
          if (!cached) return
          cdpCandidates.delete(id)
          const [rurl, mime] = cached.split('\u0000')
          /*
           * 无扩展名的整片视频（实测 TvTFun 的 capcutvod mp4、部分站点的 blob 前置分片）
           * 既没有媒体后缀、响应体也不是播放列表，前面两条判据都抓不到。
           * 这里按「video/* 且传了 1MB 以上」判定为真实视频流：
           * 阈值用来排除几 KB 的贴片广告/预览小片段。
           */
          const bytes = Number(p.encodedDataLength ?? 0)
          if (/^video\//i.test(mime ?? '') && bytes >= 1024 * 1024 && !foundUrls.includes(rurl)) {
            reportFound(rurl, 'media')
            return
          }
          void wc.debugger
            .sendCommand('Network.getResponseBody', { requestId: id })
            .then((res) => {
              const body = (res as { body?: string })?.body
              if (!body) return
              const head = body.slice(0, 400)
              if (head.includes('#EXTM3U')) reportFound(rurl, 'm3u8')
              else if (head.includes('<MPD')) reportFound(rurl, 'dash')
            })
            .catch(() => undefined)
        }
      } catch {
        /* 忽略 */
      }
    })
  } catch (err) {
    log.append('warn', 'rule-webview', `CDP 不可用: ${String(err)}`)
  }

  // 3) 播放页 HTML 直出地址（MacCMS player_aaaa 等）——校验可播后优先采用
  void extractStreamFromHtml(url, referer).then(async (direct) => {
    if (!active || !direct) return
    const ok = await resolvePlayable(direct, referer)
    if (!active || !ok) return
    // referer 空串 = 经校验确定不能带 Referer（很多 CDN 因 Referer 返回 400）
    reportFound(ok.url, 'direct', ok.referer ?? '')
  })

  // 3b) 嵌套播放器：播放页 JS 常把真实播放页塞进 iframe（如 baimao 的 #hm_playfram），
  //     外层 HTML 里没有流地址 —— 读取 iframe.src 后按同样方式再解析一层。
  const digIframe = async (): Promise<void> => {
    if (!active || !captureWin || captureWin.isDestroyed()) return
    let srcs: string[] = []
    try {
      srcs = (await captureWin.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('iframe')).map(f=>f.src||f.getAttribute('data-src')||'').filter(Boolean)`,
        true
      )) as string[]
    } catch {
      return
    }
    for (const src of srcs.slice(0, 3)) {
      if (!active) return
      log.append('info', 'rule-webview', `发现内嵌播放器 iframe: ${src.slice(0, 120)}`)
      const inner = await extractStreamFromHtml(src, referer || url)
      if (!inner) continue
      const okInner = await resolvePlayable(inner, referer)
      if (okInner) {
        reportFound(okInner.url, 'direct', okInner.referer ?? '')
        return
      }
    }
  }
  for (const d of [4000, 9000, 15000]) {
    setTimeout(() => {
      void digIframe()
    }, d)
  }

  // 4) 页面加载完成后注入自动播放（含全部子框架，跨域 iframe 播放器也能点到）
  wc.on('did-finish-load', () => {
    const runAutoPlay = (): void => {
      if (!active) return
      const frames = [wc.mainFrame, ...wc.mainFrame.framesInSubtree]
      for (const f of frames) {
        if (!f || f.isDestroyed()) continue
        // 脚本会返回播放按钮的中心坐标：再用真实鼠标事件点一次
        // （合成 click 的 isTrusted=false 会被部分站点直接丢弃，见 AUTO_PLAY_SCRIPT 注释）
        void f
          .executeJavaScript(AUTO_PLAY_SCRIPT, true)
          .then((raw) => {
            if (!active || typeof raw !== 'string' || raw === 'null') return
            const pt = JSON.parse(raw) as { x?: number; y?: number }
            if (typeof pt?.x !== 'number' || typeof pt?.y !== 'number') return
            sendRealClick(wc, pt.x, pt.y)
          })
          .catch(() => undefined)
      }
      void wc
        .executeJavaScript(
          `Array.from(document.querySelectorAll('iframe')).forEach(f=>{try{f.click()}catch(e){}})`,
          true
        )
        .catch(() => undefined)
    }
    for (const d of [800, 2200, 4500, 8000, 12000]) setTimeout(runAutoPlay, d)
  })

  const loadOpts: Electron.LoadURLOptions = { userAgent: BROWSER_UA }
  if (referer) loadOpts.httpReferrer = referer
  void cdpReady.then(() => {
    if (!active) return
    void wc.loadURL(url, loadOpts).catch((err) => {
      const e = err as { code?: string; message?: string }
      log.append('warn', 'rule-webview', `播放页加载失败 (${e.code ?? ''}): ${e.message ?? String(err)}`)
    })
  })

  // 30 秒兜底：仍未命中则收尾（渲染层据此显示失败+退出）
  doneTimer = setTimeout(() => {
    if (!active) return
    const best = pickBest(foundUrls)
    emit({
      type: 'done',
      found: !!best,
      message: best ? '已捕获视频流' : '未捕获到视频流',
      url: best ?? undefined
    })
  }, 30000)

  log.append('info', 'rule-webview', `打开网页视图嗅探: ${url.slice(0, 120)}`)
  return true
}

/** 更新嗅探窗口尺寸（屏幕外窗口，仅保持合理视口，不影响用户界面） */
export function setRuleWebviewBounds(bounds: {
  x: number
  y: number
  width: number
  height: number
}): void {
  if (!view || view.isDestroyed()) return
  try {
    view.setSize(
      Math.max(640, Math.round(bounds.width)),
      Math.max(480, Math.round(bounds.height))
    )
  } catch {
    /* ignore */
  }
}

/** 关闭并销毁网页视图（命中流地址后立即调用：用完即毁）
 *  注意：不要同步销毁——页面仍在加载时 webContents.close() 会阻塞主进程，
 *  表现为"退出播放时界面卡死"。先停止加载并摘除视图，真正销毁放到下一个事件循环。 */
export function closeRuleWebview(): void {
  active = false
  if (disposeListeners) {
    try {
      disposeListeners()
    } catch {
      /* ignore */
    }
    disposeListeners = null
  }
  if (doneTimer) {
    clearTimeout(doneTimer)
    doneTimer = null
  }
  const v = view
  view = null
  hostWin = null
  if (!v) return
  setImmediate(() => {
    try {
      if (!v.isDestroyed() && v.webContents.debugger.isAttached()) v.webContents.debugger.detach()
    } catch {
      /* ignore */
    }
    try {
      if (!v.isDestroyed()) {
        v.webContents.stop()
        v.destroy()
      }
    } catch {
      /* ignore */
    }
    log.append('info', 'rule-webview', '嗅探窗口已销毁')
  })
}

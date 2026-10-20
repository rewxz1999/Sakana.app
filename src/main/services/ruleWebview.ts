import { BrowserWindow, session } from 'electron'
import { CH } from '@shared/channels'
import { ONLINE_PLAY_TIMEOUT_MS } from '@shared/onlinePlay'
import { log } from '../log'
import { BROWSER_UA } from '../net'
import { addProbeListeners } from './probeEvents'
import { noteCapturedStream } from './playerInfo'
import { beginStage, flowDetail, pushStep, succeedStage } from './playFlow'
import { offerHandoffCandidate } from './playHandoff'
import {
  MEDIA_EXT_RE,
  extractStreamCandidatesCached,
  hasMediaExtensionInPath,
  isPlayerOrDanmakuPage,
  isStreamCandidate,
  notifyProbeHook,
  refererForCandidate,
  rememberStream
} from './ruleProbe'

/** 本实现同样属于「获取播放资源」阶段（与 ruleProbe 共用同一阶段，二者是同一件事的两种做法） */
const STAGE = 'acquire' as const

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
/**
 * 嗅探窗口「代号」（v0.2.7 附加）。
 *
 * 关闭是**异步**的（IPC 侧 setImmediate，避免销毁窗口阻塞渲染层），
 * 而渲染层在重试时会连续做两件事：先 close 上一次的窗口、紧接着 open 新窗口。
 * 两个请求落在同一轮事件循环里，于是那条延迟的 close 会把**刚建好的新窗口**销毁掉：
 * 日志表现是「打开网页视图嗅探」→ 立刻「target closed」→「CDP Network.enable 失败」，
 * 结果是重试永远抓不到流、卡在「捕捉视频流中」直到超时 ——
 * 这正是用户反馈的「所有规则下的播放都跑不通」。
 * 每次 open 递增代号；延迟的 close 只允许关闭它当初看到的那个代号。
 */
let viewGen = 0
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
  /*
   * V1.4：**统一在这里挡掉"播放器/弹幕页"**。
   *
   * 前面在 webRequest 两处加了判断，但真机复测（E站/中二病）仍会把
   * `player.ezdmw.com/danmuku/?…` 当成候选上报 —— 说明它来自别的上报点
   * （CDP 深嗅探 / 页面 HTML 提取）。逐个点在源头挡既容易漏，也难维护；
   * 这里是所有候选的**唯一汇合处**，放在这里才真正兜住。
   */
  if (isPlayerOrDanmakuPage(target)) {
    log.append('info', 'rule-webview', `忽略播放器/弹幕页（不是媒体流）：${target.slice(0, 110)}`)
    return
  }
  foundUrls.push(target)
  noteCapturedStream({ url: target, kind, referer, channel: 'webview', capturedAt: Date.now() })
  log.append('info', 'rule-webview', `捕获媒体流(${kind}): ${target.slice(0, 130)}`)
  pushStep(STAGE, `网页播放器捕获媒体流（${kind}）：${target.slice(0, 70)}`)
  succeedStage(STAGE, '已获取播放资源（网页播放器嗅探）')
  /*
   * v1.3：先把候选交给交接队列（坏地址 5 秒内可换），再按既有语义补 Cookie 后上报。
   * Cookie 查询走的是会话内存，通常几毫秒；保留它是为了「带站点会话取流」不回归。
   */
  offerHandoffCandidate({ url: target, referer })
  void collectCookies(target).then((cookies) => {
    offerHandoffCandidate({ url: target, referer, cookies })
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
  const myGen = ++viewGen
  beginStage(STAGE, '正在打开网页嗅探窗口（真实可见窗口，让站点播放器跑起来）')
  pushStep(STAGE, `打开网页嗅探：${url.slice(0, 90)}`)

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
    /*
     * V1.3.5 诊断开关：`SAKANA_PROBE_LOG_ALL=1` 时把**所有** XHR/fetch 请求打到日志里。
     *
     * 为什么需要它：AniWatch 这类 SPA 站点开了 devtools 就 `about:blank`（反调试），
     * 用户拿不到列表接口，而规则又必须走 API 型才可能工作。
     * 我们自己的嗅探窗口没有附加 devtools，站点不会 self-blank —— 于是可以借它
     * "代理一次 devtools"：把 XHR 全打印出来，从里面找出真正的列表接口。
     * 默认关闭（正常播放不该被这些日志刷屏），只在排障时开。
     */
    if (process.env.SAKANA_PROBE_LOG_ALL === '1' && /^https?:/i.test(details.url)) {
      log.append('info', 'probe', `REQ[${details.resourceType}] ${details.url.slice(0, 180)}`)
    }
    // 先排除开发服务器/打包产物的 JS 模块（`.ts` 与 MPEG-TS 撞车，见 ruleProbe.isDevServerAsset）
    if (!isStreamCandidate(details.url)) return
    /*
     * V1.4：播放器/弹幕页不算媒体流。
     * E站的播放窗口是 `player.ezdmw.com/danmuku/?…` 这种 iframe 页面，扩展名藏在查询串里时
     * 会被当成视频候选（真机实测：中二病因此显示"1 个资源"，点进去必然失败）。
     * 假阳性会直接误导用户，所以这里在源头挡住。
     */
    if (isPlayerOrDanmakuPage(details.url)) return
    if (details.resourceType === 'media' || hasMediaExtensionInPath(details.url)) {
      reportFound(details.url, /\.m3u8(\?|$)/i.test(details.url) ? 'm3u8' : 'media')
    }
  }
  const onCompleted = (details: { url: string; statusCode: number }): void => {
    if (!active) return
    if (!isStreamCandidate(details.url)) return
    if (isPlayerOrDanmakuPage(details.url)) return
    if (details.statusCode < 400 && hasMediaExtensionInPath(details.url)) {
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
          if (!isStreamCandidate(rurl)) return
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

  // 3) 播放页 HTML 直出地址（MacCMS player_aaaa 等）——**首个候选立即交给播放器**（v1.3 乐观交接）
  void extractStreamCandidatesCached(url, referer).then((candidates) => {
    if (!active || candidates.length === 0) return
    const alts = candidates.slice(0, 6).map((u) => ({ url: u, referer: refererForCandidate(u, url) }))
    for (const a of alts) offerHandoffCandidate(a)
    const first = alts[0]
    /*
     * 为什么不再先 `resolveFirstPlayable`：那一步是 HEAD + Range GET 的探测（正常几百毫秒、慢 CDN 几秒），
     * 而它挡在「已经有了直链 → 交给内核」这条最短路上。判错的代价由内核侧的
     * 「5 秒零字节换候选」兜住，而备选候选已经在交接队列里了。
     * Referer 用启发式：同站带播放页地址、跨域 CDN 不带（见 ruleProbe.refererForCandidate）。
     */
    reportFound(first.url, 'direct', first.referer ?? '')
    // 记进会话直链缓存：同一集来回切、退出再进都能直接用，省掉整轮嗅探
    rememberStream(url, first.url, first.referer ?? referer, alts.slice(1))
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
      const inner = await extractStreamCandidatesCached(src, referer || url)
      if (inner.length === 0) continue
      const alts = inner.slice(0, 6).map((u) => ({ url: u, referer: refererForCandidate(u, src) }))
      for (const a of alts) offerHandoffCandidate(a)
      reportFound(alts[0].url, 'direct', alts[0].referer ?? '')
      rememberStream(url, alts[0].url, alts[0].referer ?? referer, alts.slice(1))
      return
    }
  }
  /*
   * iframe 抽取的时机（v0.2.7 附加 提速）：
   * 过去是 4000 / 9000 / 15000ms —— 而 iframe 的 src 通常**首屏 HTML 里就有**，
   * 早一点抽就能早几秒拿到真实播放页地址。现在提前到 600 / 1800 / 4000 / 9000，
   * 同时保留较晚的一次以覆盖「JS 动态插入 iframe」的站点。
   */
  for (const d of [600, 1800, 4000, 9000]) {
    setTimeout(() => {
      void digIframe()
    }, d)
  }

  /*
   * 4) 注入自动播放（含全部子框架，跨域 iframe 播放器也能点到）。
   *
   * v0.2.7 附加（提速）：过去只在 `did-finish-load` 之后才开始点播放 ——
   * 而 `did-finish-load` 要等**所有子资源**（广告图、统计脚本…）加载完，
   * 慢站点上这一步就要好几秒。播放器的播放按钮在 DOM 就绪后通常已经存在，
   * 所以现在 `dom-ready` 就先点几轮，`did-finish-load` 再补几轮，取两者中更早生效的。
   */
  const runAutoPlay = (): void => {
    /*
     * v0.2.7 附加：这里过去只判断全局 `active`，但**新一轮嗅探会把它重新置为 true**，
     * 于是上一轮残留的定时器会拿着已销毁的 webContents 去读 `mainFrame` ——
     * 主进程抛未捕获异常 `TypeError: Object has been destroyed`（日志实测出现过）。
     * 必须连窗口/webContents 自身的存活一起判断。
     */
    if (!active || viewGen !== myGen || captureWin.isDestroyed() || wc.isDestroyed()) return
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
  wc.on('dom-ready', () => {
    flowDetail(STAGE, '播放页 DOM 就绪，正在自动点击播放按钮并等待站点播放器取流')
    pushStep(STAGE, '播放页 DOM 就绪，开始自动点击')
    for (const d of [300, 1200, 2600, 5000]) setTimeout(runAutoPlay, d)
  })
  wc.on('did-finish-load', () => {
    for (const d of [300, 1500, 4000, 9000]) setTimeout(runAutoPlay, d)
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

  // 收尾兜底（v0.3.9：30 秒 → 60 秒，与在线播放链路口径统一）
  //
  // 为什么拉长：这个计时器决定「什么时候告诉界面『没抓到』」。
  // 30 秒对慢站点是不够的 —— 播放页首屏 + 广告脚本 + 播放器取流请求排队，
  // 实测经常要 40 秒以上才发出真正的媒体请求；提前收尾等于把能播的这一集判成失败。
  doneTimer = setTimeout(() => {
    // 代号必须还是自己：否则这是上一轮残留的兜底，会给新一轮发一个假的「结束」
    if (!active || viewGen !== myGen) return
    const best = pickBest(foundUrls)
    emit({
      type: 'done',
      found: !!best,
      message: best
        ? '已捕获视频流'
        : `等待 ${ONLINE_PLAY_TIMEOUT_MS / 1000} 秒仍未捕获到视频流（站点可能已失效、需要登录，或播放器未初始化）`,
      url: best ?? undefined
    })
  }, ONLINE_PLAY_TIMEOUT_MS)

  log.append('info', 'rule-webview', `打开网页视图嗅探: ${url.slice(0, 120)}`)
  return true
}

/**
 * 自检读数的现场快照（v0.3.9）。
 *
 * 与 `ruleProbe.ruleProbeDiagnostics()` 对应：用户报的「换源/换集后播放失败」
 * 必须能判定是不是**上一轮的嗅探窗口还没销毁**（它会盖在画面区域上，
 * 表现为「有声音没画面」或「抓到流却播不出来」）。
 */
export function ruleWebviewDiagnostics(): {
  active: boolean
  viewAlive: boolean
  viewDestroyed: boolean
  listenersRegistered: boolean
  doneTimerPending: boolean
  gen: number
} {
  const v = view
  return {
    active,
    viewAlive: !!v && !v.isDestroyed(),
    viewDestroyed: !!v && v.isDestroyed(),
    listenersRegistered: disposeListeners !== null,
    doneTimerPending: doneTimer !== null,
    gen: viewGen
  }
}

/** 当前嗅探窗口的代号：调用方在**发关闭请求**时取一次，延迟执行时用它判断是否已被新窗口取代 */
export function currentRuleWebviewGen(): number {
  return viewGen
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
 *  表现为"退出播放时界面卡死"。先停止加载并摘除视图，真正销毁放到下一个事件循环。
 *
 *  @param gen 调用方看到的代号（`currentRuleWebviewGen()`）。
 *             传了就只关闭「同一个」窗口：延迟执行期间若已经打开了新窗口，这次关闭作废，
 *             否则会把新窗口一起销毁（见 viewGen 注释）。
 */
export function closeRuleWebview(gen?: number): void {
  if (gen !== undefined && gen !== viewGen) return
  viewGen += 1 // 之后到达的旧 close 请求一律作废
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
    pushStep(STAGE, '嗅探窗口已销毁（释放资源）')
  })
}

import { BrowserWindow, session } from 'electron'
import { addProbeListeners } from './probeEvents'
import { noteCapturedStream } from './playerInfo'
import axios from 'axios'
import { CH } from '@shared/channels'
import { log } from '../log'
import { BROWSER_UA } from '../net'

/**
 * 播放页流嗅探（Kazumi 同思路）：隐藏窗口加载播放页，
 * 通过 webRequest 捕获视频流地址（m3u8/mp4/flv 等），交给 libVLC 直连播放。
 * 用户全程不看到网页。
 *
 * 另外：大量站点（MacCMS 系）把真实播放地址写在播放页 HTML 的 `player_aaaa.url` 里
 * 并做了一次百分号编码，播放器由 JS 解密后再请求，因此“只看网络请求”会一无所获。
 * 这里先直接抓取页面 HTML 提取真实地址，命中即用；未命中再走窗口嗅探兜底。
 */

const PARTITION = 'rule-probe'
export const MEDIA_EXT_RE = /\.(m3u8|mp4|flv|mkv|webm|ts|m4s|mov)(\?|$)/i

/** 只解码外层混淆（解码到成为 http(s) 地址为止），保留路径内的百分号编码 */
function decodeOuter(s: string): string {
  let out = String(s ?? '').replace(/\\\//g, '/')
  for (let i = 0; i < 3; i++) {
    if (/^https?:\/\//i.test(out)) return out
    try {
      const d = decodeURIComponent(out)
      if (d === out) return out
      out = d
    } catch {
      return out
    }
  }
  return out
}

/**
 * MacCMS `player_aaaa` 的 `encrypt` 解码。
 *
 * 实测（樱之空等 MacCMS V10 站点）：`encrypt:2` 时 `url` 是
 * **base64(百分号编码)** 双层编码，站点 player.js 里的算法就是
 * `unescape(base64decode(url))`；`encrypt:1` 只有百分号编码；其它为明文。
 * 过去这里不做 base64 解码，导致这类站点的直出地址恒为 null，
 * 只能依赖网页播放器（而 /player/ 对非浏览器请求常常 408），表现为「抓不到视频流」。
 */
function decodeMacPlayerUrl(raw: string, encrypt: unknown): string {
  let out = String(raw ?? '').replace(/\\\//g, '/')
  const mode = Number(encrypt ?? 0)
  if (mode === 2) {
    try {
      // 先按 base64 解码（站点用的是 unescape 的输入，即百分号编码串）
      const decoded = Buffer.from(out, 'base64').toString('utf8')
      if (decoded && /^%|^https?:\/\//i.test(decoded)) out = decoded
    } catch {
      /* 不是 base64 就按原文继续 */
    }
  }
  // 再解开百分号编码（encrypt 1/2 都需要）
  for (let i = 0; i < 3; i++) {
    if (/^https?:\/\//i.test(out)) break
    try {
      const d = decodeURIComponent(out)
      if (d === out) break
      out = d
    } catch {
      break
    }
  }
  return out.replace(/\\\//g, '/')
}

/** 从播放页 HTML 中提取真实媒体地址（MacCMS player_aaaa / 常见播放器字段 / 直链） */
export function findMediaUrl(html: string): string | null {
  const text = String(html ?? '')
  // 1) MacCMS 标准：player_aaaa = {... "url":"%68%74%74%70..." ...}
  const pa = text.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;)/)
  if (pa) {
    try {
      const obj = JSON.parse(pa[1]) as { url?: string; url_next?: string; encrypt?: unknown }
      const u = decodeMacPlayerUrl(obj?.url ?? '', obj?.encrypt)
      if (/^https?:\/\//i.test(u) && MEDIA_EXT_RE.test(u)) return u
      const next = decodeMacPlayerUrl(obj?.url_next ?? '', obj?.encrypt)
      if (/^https?:\/\//i.test(next) && MEDIA_EXT_RE.test(next)) return next
    } catch {
      const m = pa[1].match(/"url"\s*:\s*"([^"]+)"/)
      const enc = pa[1].match(/"encrypt"\s*:\s*(\d+)/)
      if (m) {
        const u = decodeMacPlayerUrl(m[1], enc ? Number(enc[1]) : 0)
        if (/^https?:\/\//i.test(u) && MEDIA_EXT_RE.test(u)) return u
      }
    }
  }
  // 2) 常见播放器配置字段
  const fieldRe = [
    /"url"\s*:\s*"([^"]+)"/g,
    /"video"\s*:\s*"([^"]+)"/g,
    /"source"\s*:\s*"([^"]+)"/g,
    /(?:source|file|src|videoUrl)\s*[:=]\s*['"]([^'"]+)['"]/g
  ]
  for (const re of fieldRe) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const u = decodeOuter(m[1])
      if (/^https?:\/\//i.test(u) && MEDIA_EXT_RE.test(u)) return u
    }
  }
  // 3) HTML/JS 中直接出现的媒体直链
  const direct = text.match(
    /https?:\\?\/\\?\/[^"'\s\\<>]+\.(?:m3u8|mp4|flv|mkv|webm)(?:\?[^"'\s\\<>]*)?/gi
  )
  if (direct) {
    for (const d of direct) {
      const u = decodeOuter(d)
      if (/^https?:\/\//i.test(u)) return u
    }
  }
  return null
}

/** 抓取播放页 HTML 并提取真实媒体地址（无则返回 null，交由窗口嗅探兜底） */
export async function extractStreamFromHtml(url: string, referer?: string): Promise<string | null> {  try {
    let origin = ''
    try {
      origin = new URL(url).origin + '/'
    } catch {
      origin = url
    }
    const res = await axios.get<string>(url, {
      timeout: 12000,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent': BROWSER_UA,
        Referer: referer || origin,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    })
    const found = findMediaUrl(String(res.data ?? ''))
    if (found) log.append('info', 'rule-probe', `播放页直出地址: ${found.slice(0, 120)}`)
    return found
  } catch (err) {
    log.append('warn', 'rule-probe', `播放页直出解析失败: ${String((err as { message?: string })?.message ?? err)}`)
    return null
  }
}

const PLAYABLE_MIME_RE = /^(video\/|audio\/|application\/(octet-stream|vnd\.apple\.mpegurl|mp2t|x-mpegurl|dash\+xml))/i

/**
 * 把 URL 规范成 VLC 能正确解析的形式：
 * 部分 CDN 的签名参数里带未转义的 '/'、'+'、'='，浏览器能容忍，
 * 但 libVLC 的 URL 解析会走偏（表现为拿到地址却一直不播放）。
 */
export function encodeForVlc(url: string): string {
  try {
    const u = new URL(url)
    const parts: string[] = []
    u.searchParams.forEach((v, k) => {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    })
    // searchParams 会把 '+' 解析成空格，这里用原始串重建更安全
    if (u.search && parts.length === 0) {
      const raw = u.search.slice(1).replace(/%(?![0-9a-fA-F]{2})/g, '%25')
      u.search = '?' + raw
    } else if (u.search) {
      const rawPairs = u.search
        .slice(1)
        .split('&')
        .map((pair) => {
          const idx = pair.indexOf('=')
          if (idx < 0) return encodeURIComponent(pair)
          const k = pair.slice(0, idx)
          let v = pair.slice(idx + 1)
          // 已转义的保持原样，其余保留字符统一转义
          v = v.replace(/%(?![0-9a-fA-F]{2})/g, '%25').replace(/[+/=]/g, (m) => {
            if (m === '+') return '%2B'
            if (m === '/') return '%2F'
            return '%3D'
          })
          return `${k}=${v}`
        })
        .join('&')
      u.search = '?' + rawPairs
    }
    return u.toString()
  } catch {
    return url
  }
}

/**
 * 校验直出地址是否真的可播：
 * 这类 CDN 常返回 302 跳转，跳转目标又可能 400/HTML 错误页——
 * 直接把原始地址交给 VLC 就会被当成「空播放列表」。
 * 优先用 HEAD 探测（避免消耗一次性下载令牌），必要时才回退 Range GET。
 */
export async function resolvePlayable(
  url: string,
  referer?: string
): Promise<{ url: string; referer?: string } | null> {
  const attempts: (string | undefined)[] = referer ? [referer, undefined] : [undefined]
  for (const ref of attempts) {
    const baseHeaders: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      ...(ref ? { Referer: ref } : {})
    }
    // 1) HEAD 探测（不消耗下载令牌）
    try {
      const head = await axios.head(url, {
        timeout: 12000,
        maxRedirects: 6,
        validateStatus: () => true,
        headers: baseHeaders
      })
      const mime = String(head.headers['content-type'] ?? '')
      const status = head.status
      const finalUrl = String((head.request as { res?: { responseUrl?: string } })?.res?.responseUrl ?? url)
      if (status >= 200 && status < 400 && PLAYABLE_MIME_RE.test(mime)) {
        log.append('info', 'rule-probe', `直出地址校验通过(HEAD ${mime.split(';')[0]} ${status})`)
        return { url: encodeForVlc(finalUrl), referer: ref }
      }
      log.append('warn', 'rule-probe', `HEAD 校验未通过(${status} ${mime.split(';')[0] || 'unknown'})`)
    } catch (err) {
      log.append('warn', 'rule-probe', `HEAD 校验异常: ${String((err as { message?: string })?.message ?? err)}`)
    }
    // 2) 回退：Range GET（有些 CDN 不支持 HEAD）
    try {
      const res = await axios.get(url, {
        timeout: 12000,
        maxRedirects: 6,
        responseType: 'arraybuffer',
        decompress: true,
        validateStatus: () => true,
        headers: { ...baseHeaders, Range: 'bytes=0-2047' }
      })
      const mime = String(res.headers['content-type'] ?? '')
      const status = res.status
      const finalUrl = String((res.request as { res?: { responseUrl?: string } })?.res?.responseUrl ?? url)
      if (status >= 200 && status < 400 && PLAYABLE_MIME_RE.test(mime)) {
        log.append('info', 'rule-probe', `直出地址校验通过(${mime.split(';')[0]} ${status})`)
        return { url: encodeForVlc(finalUrl), referer: ref }
      }
      log.append(
        'warn',
        'rule-probe',
        `直出地址不可播(${status} ${mime.split(';')[0] || 'unknown'}${ref ? ' 带 Referer' : ''}): ${finalUrl.slice(0, 110)}`
      )
    } catch (err) {
      log.append('warn', 'rule-probe', `直出地址校验失败: ${String((err as { message?: string })?.message ?? err)}`)
    }
  }
  return null
}

let probeWin: BrowserWindow | null = null
let foundUrls: string[] = []
let doneSent = false
let probeActive = false
let timeoutTimer: NodeJS.Timeout | null = null

/** 自检钩子：主进程内直接观察嗅探事件（SAKANA_ONLINE_TEST 使用） */
let probeHook: ((payload: Record<string, unknown>) => void) | null = null
export function setProbeHook(cb: ((payload: Record<string, unknown>) => void) | null): void {
  probeHook = cb
}

/** 供 ruleWebview 等其它嗅探实现复用同一个自检钩子 */
export function notifyProbeHook(payload: Record<string, unknown>): void {
  try {
    probeHook?.(payload)
  } catch {
    /* ignore */
  }
}

function emit(win: BrowserWindow | null | undefined, payload: Record<string, unknown>): void {
  // win 可能已经随窗口销毁而失效（播放页所在的窗口先没了），
  // 此时若直接读 win.isDestroyed() 会抛 TypeError 并变成未处理的 Promise 拒绝
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(CH.evRuleProbe, payload)
  }
  try {
    probeHook?.(payload)
  } catch {
    /* ignore */
  }
  if (process.env.SAKANA_PROBE_TEST) {
    console.log(`[rule-probe] emit: ${JSON.stringify(payload).slice(0, 160)}`)
  }
}

function pickBest(urls: string[]): string | null {
  // 优先 m3u8（HLS 主列表），其次 mp4/flv
  const m3u8 = urls.find((u) => /\.m3u8(\?|$)/i.test(u))
  if (m3u8) return m3u8
  const master = urls.find((u) => /master|index\.m3u8/i.test(u))
  if (master) return master
  return urls.find((u) => /\.(mp4|flv)(\?|$)/i.test(u)) ?? urls[0] ?? null
}

export function startRuleProbe(mainWin: BrowserWindow, url: string, referer?: string): boolean {
  stopRuleProbe()
  foundUrls = []
  doneSent = false
  probeActive = true
  // 使用默认会话（自定义分区会话会导致页面加载 ERR_FAILED；probeActive 标志防止误报）
  const ses = session.defaultSession
  try {
    // 注意：show:false 的窗口会被页面视为不可见（document.hidden），
    // 多数站点因此不初始化播放器；改为屏幕外可见窗口，页面行为与正常浏览一致。
    probeWin = new BrowserWindow({
      show: true,
      x: -4000,
      y: 0,
      width: 1280,
      height: 720,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })
  } catch (err) {
    log.append('error', 'rule-probe', `隐藏窗口创建失败: ${String(err)}`)
    return false
  }

  // 嗅探会话结束：注销共享监听，避免与其它实现互相覆盖
  const onBeforeRequest = (details: { url: string; resourceType: string }): void => {
    if (!probeActive) return
    const u = details.url
    if (details.resourceType === 'media' || MEDIA_EXT_RE.test(u)) {
      if (!foundUrls.includes(u)) {
        foundUrls.push(u)
        log.append('info', 'rule-probe', `捕获媒体流: ${u.slice(0, 120)}`)
        noteCapturedStream({ url: u, kind: /\.m3u8(\?|$)/i.test(u) ? 'm3u8' : 'media', channel: 'webRequest', capturedAt: Date.now() })
        emit(mainWin, { type: 'found', url: u, kind: /\.m3u8(\?|$)/i.test(u) ? 'm3u8' : 'media' })
      }
    }
  }
  const onCompleted = (details: { url: string; statusCode: number }): void => {
    if (!probeActive) return
    if (details.statusCode < 400 && MEDIA_EXT_RE.test(details.url) && !foundUrls.includes(details.url)) {
      foundUrls.push(details.url)
      emit(mainWin, { type: 'found', url: details.url, kind: /\.m3u8(\?|$)/i.test(details.url) ? 'm3u8' : 'media' })
    }
  }
  // 共享嗅探监听（webRequest 每事件只允许一个监听器，统一在 probeEvents 注册）
  if (disposeListeners) disposeListeners()
  disposeListeners = addProbeListeners({ onBeforeRequest, onCompleted })

  // 先尝试直接从播放页 HTML 提取真实地址（MacCMS 等），校验可播后再用，窗口仅作兜底
  void extractStreamFromHtml(url, referer).then(async (direct) => {
    if (!probeActive || !direct) return
    const ok = await resolvePlayable(direct, referer)
    if (!probeActive || !ok) return
    if (foundUrls.includes(ok.url)) return
    foundUrls.push(ok.url)
    log.append('info', 'rule-probe', `直出地址命中: ${ok.url.slice(0, 120)}`)
    noteCapturedStream({
      url: ok.url,
      kind: /\.m3u8(\?|$)/i.test(ok.url) ? 'm3u8' : 'direct',
      referer: ok.referer,
      channel: 'html 直出',
      capturedAt: Date.now()
    })
    // referer 用空串表示「经校验确定不能带 Referer」（很多 CDN 会因 Referer 直接 400）
    emit(mainWin, { type: 'found', url: ok.url, referer: ok.referer ?? '', kind: 'direct' })
  })

  /**
   * CDP 深度嗅探：现代站点常用无扩展名地址（签名 URL / MSE / blob 前置分片），
   * 只看 URL 会漏。这里通过 DevTools Protocol 读取 XHR/Fetch 响应体，
   * 识别 #EXTM3U（HLS）与 <MPD（DASH）播放列表，直接拿到真实流地址。
   */
  const cdpCandidates = new Map<string, string>()
  const dbg = probeWin.webContents.debugger
  let cdpReady: Promise<void> = Promise.resolve()
  try {
    dbg.attach('1.3')
    // 必须先完成 Network.enable 再加载页面，否则页面首批请求（播放器 API）不会被记录
    cdpReady = dbg
      .sendCommand('Network.enable')
      .then(() => undefined)
      .catch(() => undefined)
    const emitFound = (u: string, kind: string): void => {
      if (foundUrls.includes(u)) return
      foundUrls.push(u)
      log.append('info', 'rule-probe', `捕获媒体流(${kind}): ${u.slice(0, 120)}`)
      emit(mainWin, { type: 'found', url: u, kind })
    }
    dbg.on('message', (_e, method, params) => {
      if (!probeActive) return
      try {
        if (method === 'Network.responseReceived') {
          const p = params as {
            requestId?: string
            type?: string
            response?: { url?: string; mimeType?: string; status?: number }
          }
          const url = p.response?.url ?? ''
          const mime = (p.response?.mimeType ?? '').toLowerCase()
          if (process.env.SAKANA_PROBE_VERBOSE && url) {
            console.log(
              `[probe-net] ${String(p.type ?? '?')} ${String(p.response?.status ?? '')} ${mime.split(';')[0]} ${url.slice(0, 150)}`
            )
          }
          if (!url) return
          const looksPlaylist =
            /mpegurl|dash\+xml|vnd\.apple/i.test(mime) || /\.(m3u8|mpd)(\?|$)/i.test(url)
          const looksMedia = /^video\//i.test(mime) || /audio\/(mpegurl|mp4)/i.test(mime)
          if (looksPlaylist) {
            // 播放列表地址本身就是可播流，优先直接采用
            emitFound(url, /mpd/i.test(url) ? 'dash' : 'm3u8')
          } else if (
            looksMedia ||
            ['XHR', 'Fetch', 'Media', 'Other'].includes(String(p.type ?? '')) ||
            MEDIA_EXT_RE.test(url)
          ) {
            if (p.requestId) cdpCandidates.set(p.requestId, url)
          }
        } else if (method === 'Network.loadingFinished') {
          const p = params as { requestId?: string }
          const id = p.requestId
          if (!id) return
          const url = cdpCandidates.get(id)
          if (!url) return
          cdpCandidates.delete(id)
          void dbg
            .sendCommand('Network.getResponseBody', { requestId: id })
            .then((res) => {
              const body = (res as { body?: string; base64Encoded?: boolean })?.body
              if (!body) return
              const head = body.slice(0, 400)
              if (head.includes('#EXTM3U')) emitFound(url, 'm3u8')
              else if (head.includes('<MPD')) emitFound(url, 'dash')
            })
            .catch(() => undefined)
        }
      } catch {
        /* CDP 消息异常忽略 */
      }
    })
  } catch (err) {
    log.append('warn', 'rule-probe', `CDP 深度嗅探不可用（仅按 URL 嗅探）: ${String(err)}`)
  }

  const headers: Record<string, string> = { 'User-Agent': BROWSER_UA }
  if (referer) headers['Referer'] = referer
  const loadOpts: Electron.LoadURLOptions = { userAgent: BROWSER_UA }
  if (referer) loadOpts.httpReferrer = referer
  // 等 CDP 就绪后再加载页面（保证不丢首批请求）
  void cdpReady.then(() => {
    const w = probeWin
    if (!probeActive || !w || w.isDestroyed()) return
    void w.loadURL(url, loadOpts).catch((err) => {
      const e = err as { code?: string; message?: string }
      log.append('warn', 'rule-probe', `播放页加载失败 (${e.code ?? ''}): ${e.message ?? String(err)}`)
    })
  })
  probeWin.on('closed', () => {
    probeWin = null
  })

  // 播放页大多需要“交互”才会加载播放器：注入脚本自动点击播放按钮 / 触发 video.play()
  const autoPlayScript = `(() => {
    const tryPlay = () => {
      const videos = Array.from(document.querySelectorAll('video'))
      for (const v of videos) {
        try { v.muted = true; v.play && v.play() } catch (e) {}
      }
      const sels = ['#play','.play','.play-btn','.play-button','.vjs-big-play-button','.dplayer-play-icon','.artplayer-plugin-video-control','[class*="play" i]','[title*="播放"]','[aria-label*="播放"]']
      for (const sel of sels) {
        const el = document.querySelector(sel)
        if (el && el.click) { try { el.click() } catch (e) {} }
      }
      const iframes = Array.from(document.querySelectorAll('iframe'))
      for (const f of iframes) {
        try { f.contentWindow && f.contentWindow.postMessage('play', '*') } catch (e) {}
      }
    }
    let n = 0
    const t = setInterval(() => { n++; tryPlay(); if (n > 8) clearInterval(t) }, 1500)
    tryPlay()
  })()`

  probeWin.webContents.on('did-finish-load', () => {
    // 关键：播放器常位于跨域 iframe 内，主框架脚本点不到它。
    // 用 WebFrameMain 把自动点击注入到每一个子框架（含跨域 iframe）。
    const runAutoPlay = (): void => {
      const w = probeWin
      if (!w || w.isDestroyed()) return
      const frames = [w.webContents.mainFrame, ...w.webContents.mainFrame.framesInSubtree]
      for (const f of frames) {
        if (!f || f.isDestroyed()) continue
        void f.executeJavaScript(autoPlayScript, true).catch(() => undefined)
      }
      // 再直接点击页面里的 iframe 元素（部分站点靠父页点击才初始化播放器）
      void w.webContents
        .executeJavaScript(
          `Array.from(document.querySelectorAll('iframe')).forEach(f=>{try{f.click()}catch(e){}})`,
          true
        )
        .catch(() => undefined)
    }
    for (const delay of [1200, 3000, 6000, 10000]) setTimeout(runAutoPlay, delay)
  })

  // 20 秒后收尾：把最佳候选地址通知渲染层
  timeoutTimer = setTimeout(() => {
    const best = pickBest(foundUrls)
    if (!doneSent) {
      doneSent = true
      emit(mainWin, {
        type: 'done',
        found: !!best,
        message: best ? '已捕获视频流' : '未捕获到视频流，可回退到网页播放',
        url: best ?? undefined
      })
    }
    stopRuleProbe()
  }, 20000)
  return true
}

/** 当前嗅探的监听注销函数（停止/换集时清掉，避免与其它嗅探实现互相覆盖） */
let disposeListeners: (() => void) | null = null

export function stopRuleProbe(): void {
  probeActive = false
  if (disposeListeners) {
    try {
      disposeListeners()
    } catch {
      /* ignore */
    }
    disposeListeners = null
  }
  if (timeoutTimer) {
    clearTimeout(timeoutTimer)
    timeoutTimer = null
  }
  const w = probeWin
  probeWin = null
  try {
    if (w && !w.isDestroyed()) {
      if (w.webContents.debugger.isAttached()) w.webContents.debugger.detach()
      w.destroy()
    }
  } catch {
    /* ignore */
  }
}

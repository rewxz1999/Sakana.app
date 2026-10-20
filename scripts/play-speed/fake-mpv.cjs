/*
 * 假播放内核（计时脚本专用）。
 *
 * 它替代 `src/main/services/mpv.ts`（libmpv 原生插件在沙箱里加载不了），
 * 只实现 `playerEngine.enginePlay` 真正调用到的那几个函数，
 * 并把「内核拿到地址之后发生了什么」用**真实 HTTP** 模拟出来：
 *
 *   loadfile  → 真发一次请求（m3u8 先拉列表、再拉第一片；整段文件只拉 Range 头）
 *   首帧      ← 收到第一个正文字节的那一刻（标签写清楚这是「模拟首帧」，不是解码）
 *
 * 这样脚本量到的「命中→loadfile / loadfile→首帧」是真实网络耗时，
 * 与真机上 libmpv 的差别只在解码那几十毫秒（本工单要优化的是它前面的等待，不是解码）。
 *
 * 5 秒零字节换候选：由环境变量 SAKANA_SPEED_HANDOFF 打开，
 * 策略与队列**都直接调用真实模块** `playHandoff.js`（SAKANA_SPEED_HANDOFF_MODULE 指定路径），
 * 脚本里跑的是产品代码，不是脚本自己编的规则。
 */
const path = require('path')
const fs = require('fs')
const OUT =
  process.env.SAKANA_SPEED_OUT || path.join(__dirname, '..', '..', '.tmp-play-speed', 'out')
if (!fs.existsSync(path.join(OUT, 'src', 'main', 'services', 'playFlow.js'))) {
  throw new Error(`缺少编译产物：${OUT}（先跑 tsc -p scripts/play-speed/tsconfig.json）`)
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const flow = require(path.join(OUT, 'src', 'main', 'services', 'playFlow.js'))
const timing = process.env.SAKANA_SPEED_TIMING_MODULE ? require(process.env.SAKANA_SPEED_TIMING_MODULE) : null
const handoff = process.env.SAKANA_SPEED_HANDOFF_MODULE ? require(process.env.SAKANA_SPEED_HANDOFF_MODULE) : null

const state = {
  ready: false,
  attached: false,
  gen: 0,
  loads: [],
  current: null,
  firstFrameAt: 0,
  firstFramePath: '',
  firstFrameLoad: null,
  switches: [],
  boostSwapped: false,
  timer: null
}

function headersFor(referer, cookies) {
  const h = { 'User-Agent': BROWSER_UA, Accept: '*/*' }
  if (referer) h.Referer = referer
  if (cookies) h.Cookie = cookies
  return h
}

/** 读响应正文的前 n 字节（只用来看「有没有真的拿到数据」） */
async function firstChunk(res, limit) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.subarray(0, limit)
  }
  const out = []
  let got = 0
  while (got < limit) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || !value.length) continue
    out.push(Buffer.from(value))
    got += value.length
  }
  try {
    await reader.cancel()
  } catch {
    /* ignore */
  }
  return Buffer.concat(out)
}

function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).toString()
  } catch {
    return ''
  }
}

/**
 * 模拟内核取流：先看地址是否活着（m3u8 先拉列表），再把「首帧」定义为正文第一个字节。
 * 任何非 2xx 都按「没有字节」处理 —— 与真机上「内核收到了一个 404/空响应」一致。
 */
async function probe(c, url, referer, cookies, depth) {
  try {
    const res = await fetch(url, {
      headers: headersFor(referer, cookies),
      redirect: 'follow',
      signal: AbortSignal.timeout(20000)
    })
    if (c.gen !== state.gen) return
    c.status = res.status
    if (!res.ok && res.status !== 206) {
      c.error = `HTTP ${res.status}`
      return
    }
    const ct = String(res.headers.get('content-type') || '')
    const looksHls = /mpegurl|vnd\.apple/i.test(ct) || /\.m3u8(\?|#|$)/i.test(url)
    if (!looksHls) {
      const body = await firstChunk(res, 128 * 1024)
      if (c.gen !== state.gen) return
      if (body.length > 0) c.alive = true
      c.bytes += body.length
      markFirstFrame(c, url)
      return
    }
    // HLS：列表本身也算「有字节」
    const text = await res.text()
    if (c.gen !== state.gen) return
    if (text.length > 0) c.alive = true
    c.bytes += Buffer.byteLength(text)
    if (!text.includes('#EXTM3U')) {
      c.error = '不是 HLS 播放列表'
      return
    }
    // 主列表 → 选第一个变体；媒体列表 → 第一片
    const lines = text.split(/\r?\n/).map((l) => l.trim())
    let segUrl = ''
    const variantAt = lines.findIndex((l) => /^#EXT-X-STREAM-INF/i.test(l))
    if (variantAt >= 0) {
      const variant = lines.slice(variantAt + 1).find((l) => l && !l.startsWith('#'))
      if (!variant) {
        c.error = '主列表没有变体'
        return
      }
      if (depth === 0) {
        // 变体列表也要走一次（真实播放器就是这么做的）
        await probe(c, resolveUrl(url, variant), referer, cookies, 1)
        return
      }
      segUrl = resolveUrl(url, variant)
    } else {
      const seg = lines.find((l) => l && !l.startsWith('#'))
      if (!seg) {
        c.error = '媒体列表没有分片'
        return
      }
      segUrl = resolveUrl(url, seg)
    }
    if (!segUrl) {
      c.error = '分片地址解析失败'
      return
    }
    const segRes = await fetch(segUrl, {
      headers: { ...headersFor(referer, cookies), Range: 'bytes=0-65535' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000)
    })
    if (c.gen !== state.gen) return
    c.segStatus = segRes.status
    if (!segRes.ok && segRes.status !== 206) {
      c.error = `分片 HTTP ${segRes.status}`
      return
    }
    const body = await firstChunk(segRes, 64 * 1024)
    if (c.gen !== state.gen) return
    if (body.length > 0) c.alive = true
    c.bytes += body.length
    markFirstFrame(c, segUrl)
  } catch (err) {
    if (c.gen === state.gen) c.error = String((err && err.message) || err).slice(0, 120)
  }
}

function markFirstFrame(c, url) {
  if (c.firstFrameAt) return
  c.firstFrameAt = Date.now()
  state.firstFrameAt = c.firstFrameAt
  state.firstFramePath = url
  state.firstFrameLoad = c
  // 与真实 mpv 的 startTimePump 一致：首帧 = 「注入播放器」阶段完成 + 整轮成功
  if (timing) timing.markPlayTiming('首帧')
  try {
    flow.succeedStage('inject', '画面已就绪（计时脚本模拟首帧，真实字节）')
    flow.endFlow({ ok: true, summary: '计时脚本：首帧已到' })
  } catch {
    /* 脚本里没有开流程时忽略 */
  }
}

function load(file, referer, cookies, isSwitch) {
  const gen = ++state.gen
  const c = {
    gen,
    path: file,
    referer,
    cookies,
    bytes: 0,
    alive: false,
    status: 0,
    segStatus: 0,
    error: '',
    loadedAt: Date.now(),
    firstFrameAt: 0,
    isSwitch: !!isSwitch
  }
  state.current = c
  state.loads.push({ at: c.loadedAt, path: file, referer, isSwitch: !!isSwitch })
  if (timing) timing.markPlayTiming('loadfile')
  if (flow.flowRunning && flow.flowRunning()) {
    try {
      // 第一次 loadfile 才开阶段（切换候选不能重置 15s 看门狗，这里用 flowRunning 判断）
      const snap = flow.snapshot()
      const st = snap.stages.find((s) => s.key === 'inject')
      if (!st || st.status !== 'running') flow.beginStage('inject', '正在把播放资源交给播放内核（loadfile）')
    } catch {
      /* ignore */
    }
  }
  void probe(c, file, referer, cookies, 0)
  return c
}

/**
 * 假内核的状态泵（对应真机 startTimePump 里那段 250ms 检查）。
 * 判据与执行都调用真实模块：`playHandoff.shouldSwitchCandidate` 决定「该不该换」，
 * `mpvSwitchToNextCandidate` 是产品里同一个执行函数（这里用本文件的实现，逻辑一致）。
 */
function tick() {
  if (!handoff) return
  const c = state.current
  if (!c || c.firstFrameAt) return
  if (!flow.flowRunning || !flow.flowRunning()) return
  const elapsedMs = Date.now() - c.loadedAt
  if (!handoff.shouldSwitchCandidate({ elapsedMs, bytesSinceCandidate: c.bytes, noBytesMs: handoff.HANDOFF_NO_BYTES_MS })) {
    return
  }
  mpvSwitchToNextCandidate('5 秒零字节')
}

/* ── 内核 API（与 npm 模块 mpv.ts 同名，playerEngine 只依赖这些） ── */
function mpvAttach() {
  state.ready = true
  state.attached = true
  return { ok: true, message: 'fake kernel' }
}
function mpvPlay(file, referer, cookies) {
  if (!state.ready) throw new Error('libmpv 尚未就绪')
  if (!state.timer) {
    state.timer = setInterval(tick, 100)
    state.timer.unref()
  }
  state.boostSwapped = false
  load(file, referer, cookies, false)
}
function mpvReady() {
  return state.ready && state.attached
}
/** 对应真机 mpvPlaybackProgress：enginePlay 用它决定「要不要启动测速」 */
function mpvPlaybackProgress() {
  const c = state.current
  return {
    bytes: c ? c.bytes : 0,
    hasPicture: !!(c && c.firstFrameAt),
    sinceLoadMs: c ? Date.now() - c.loadedAt : 0
  }
}
/**
 * 把加速中转接到内核（对应真机 mpvApplyBoost）。
 * 判据与真机一致：已经出首帧就不切；本轮已经切过一次也不切。
 */
function mpvApplyBoost(url, referer, cookies) {
  const c = state.current
  if (!c || c.firstFrameAt || state.boostSwapped) return false
  // 与真机同一条策略：已经有字节在动就不切；且至少给直连 2 秒
  if (c.alive) return false
  if (Date.now() - c.loadedAt < 2000) return false
  state.boostSwapped = true
  state.switches.push({ at: Date.now(), from: c.path, to: url, reason: 'boost' })
  load(url, referer, cookies, true)
  return true
}
function mpvBoostSwapped() {
  return !!state.boostSwapped
}
/** 换下一个候选（对应真机 mpvSwitchToNextCandidate；策略/队列用真实 playHandoff） */
function mpvSwitchToNextCandidate(reason) {
  const c = state.current
  if (!c || c.firstFrameAt || c.alive) return null
  if (!handoff) return null
  const next = handoff.takeNextCandidate()
  if (!next) return null
  state.switches.push({ at: Date.now(), from: c.path, to: next.url, reason: reason || 'no-bytes' })
  load(next.url, next.referer, next.cookies, true)
  return { url: next.url }
}
function mpvFallbackDirect(url, referer, cookies, reason) {
  // 对应真机 mpvFallbackDirect：缓存失败时把内核切回直连原地址（不等 2 秒门槛）
  const c = state.current
  if (!c || c.firstFrameAt) return false
  state.switches.push({ at: Date.now(), from: c.path, to: url, reason: reason || 'cache-fallback' })
  load(url, referer, cookies, true)
  return true
}
function mpvCurrentPath() {
  return state.current ? state.current.path : ''
}
function mpvHasPicture() {
  return !!(state.current && state.current.firstFrameAt)
}
/** 已有字节/首帧就不要换（保留给旧脚本用） */
function mpvTrySwapSource(candidate, reason) {
  const c = state.current
  if (!c) return false
  if (c.firstFrameAt || c.alive) return false
  load(candidate.url, candidate.referer, candidate.cookies, true)
  state.switches.push({ at: Date.now(), from: c.path, to: candidate.url, reason: reason || 'swap' })
  return true
}
function mpvAvailable() {
  return true
}
function mpvDestroy() {
  state.ready = false
  state.attached = false
  if (state.timer) clearInterval(state.timer)
  state.timer = null
}
function mpvGetState() {
  const c = state.current
  return {
    ready: state.ready,
    time: c && c.firstFrameAt ? 1000 : 0,
    length: 0,
    paused: false,
    idle: !c,
    eof: false,
    volume: 100,
    mute: false
  }
}
const noop = () => undefined
module.exports = {
  mpvAttach,
  mpvPlay,
  mpvReady,
  mpvPlaybackProgress,
  mpvApplyBoost,
  mpvBoostSwapped,
  mpvSwitchToNextCandidate,
  mpvTrySwapSource,
  mpvFallbackDirect,
  mpvCurrentPath,
  mpvHasPicture,
  mpvAvailable,
  mpvDestroy,
  mpvGetState,
  mpvNotifyLayout: noop,
  mpvSeekSec: noop,
  mpvSetAspect: noop,
  mpvSetBounds: noop,
  mpvSetMute: noop,
  mpvSetPlaylist: noop,
  mpvSetSpeed: noop,
  mpvSetSubtitle: noop,
  mpvSetVolume: noop,
  mpvSnapshot: noop,
  mpvSubtitleTracks: () => [],
  mpvTogglePause: noop,
  mpvAddSubtitleFile: noop,
  /** 计时脚本读取现场用 */
  __state: state,
  /** 每个场景开始前清一次（首帧/装载记录都属于上一轮） */
  __reset() {
    state.gen += 1
    state.loads.length = 0
    state.current = null
    state.firstFrameAt = 0
    state.firstFramePath = ''
    state.firstFrameLoad = null
    state.switches.length = 0
    state.boostSwapped = false
  }
}

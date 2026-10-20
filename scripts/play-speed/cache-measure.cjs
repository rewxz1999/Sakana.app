/*
 * 本地临时缓存（边下边播）计时脚本（v1.4，可复跑）。
 *
 * 用法（在仓库根目录）：
 *   node node_modules/typescript/bin/tsc -p scripts/play-speed/tsconfig.json
 *   node -r ./scripts/play-speed/bootstrap.cjs ./scripts/play-speed/cache-measure.cjs
 *
 * 它跑的是**真实业务代码 + 真实 HTTP + 真实磁盘**：
 *   · transcode.initLiveServer() 起真实的本机中转监听（mediaCache 的 /cache/ 挂在同一个端口）；
 *   · mediaCache.startTempMediaCache() 真的去拉上游、真的写临时文件；
 *   · 剧本是本地 HTTP fixture，延迟/抖动可控但字节是真的（不 mock fetch、不 mock fs）。
 * 只有 electron（桩）和 libmpv（假内核）被替换，与本工单要量的那段无关。
 *
 * 量三件事：
 *   ① 首字节：上游首字节 → 播放器从本机拿到首字节（工单要求写进 [play-flow] 的那一段）；
 *   ② 已缓存区间的 Range 延迟：直连 vs 本机缓存（这就是「播放速度源自缓存速度」的证据）；
 *   ③ 回退：缓存目录不可写 / 上游 403 时，playerEngine 必须改回直连原地址（不能播不了）。
 * 另外顺手验证 LRU 淘汰与退出清理。
 *
 * 红线：脚本只打印毫秒数、字节数、会话号，不打印任何源站/本机地址。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')

const OUT = process.env.SAKANA_SPEED_OUT || path.join(__dirname, '..', '..', '.tmp-play-speed', 'out')
/* fake-mpv 在 require 时读这两个环境变量：把计时/交接都指向真实编译产物 */
process.env.SAKANA_SPEED_TIMING_MODULE = path.join(OUT, 'src', 'main', 'services', 'playTiming.js')
process.env.SAKANA_SPEED_HANDOFF_MODULE = path.join(OUT, 'src', 'main', 'services', 'playHandoff.js')
/*
 * 允许缓存「本机 fixture 地址」只给自检用：生产里本机地址意味着 HLS/加速中转，
 * 再套一层缓存没有意义；但计时脚本必须用本机 HTTP 才能不依赖外网、可复跑。
 */
process.env.SAKANA_TEMP_CACHE_ALLOW_LOOPBACK = '1'

const R = (p) => require(path.join(OUT, 'src', 'main', 'services', p))
const CORE = (p) => require(path.join(OUT, 'src', 'main', p))

const { store } = CORE('store')
const { log } = CORE('log')
const transcode = R('transcode')
const mediaCache = R('mediaCache')
const timing = R('playTiming')
const flow = R('playFlow')
const playerEngine = R('playerEngine')
const fake = require(path.join(__dirname, 'fake-mpv.cjs'))

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sakana-cache-measure-'))
const CACHE_DIR = path.join(WORK, 'cache')

const now = () => Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ms = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v)}ms`)
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)}MB`

/** 截断/中位数：抖动场景看中位数比看平均更贴近播放器体感 */
function pct(arr, p) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y)
  if (!a.length) return null
  return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))]
}

/* ───────────────────────── 真实 HTTP 剧本 ───────────────────────── */

/**
 * 剧本参数（字节是真的，延迟只是可控）：
 *   total      总字节数
 *   headDelay  响应头延迟（模拟慢 CDN 的 TTFB）
 *   chunk      每块大小
 *   burst      一轮突发发多少块
 *   gap        每轮突发之间的停顿（模拟抖动）
 *   这些数字取自「慢但不死」的真实形状：首字节约 0.4s、平均 100~300KB/s、周期性卡顿。
 */
const SCENES = {
  jitter: { total: 6 * 1024 * 1024, headDelay: 380, chunk: 64 * 1024, burst: 4, gap: 260 },
  slow: { total: 6 * 1024 * 1024, headDelay: 180, chunk: 32 * 1024, burst: 2, gap: 160 },
  small: { total: 2 * 1024 * 1024, headDelay: 320, chunk: 64 * 1024, burst: 8, gap: 120 },
  dead: { total: 0, headDelay: 40, status: 403 },
  // 直播/分块流的形状：不给 Content-Length（node 会自动用 chunked）
  chunked: { total: 1024 * 1024, headDelay: 60, chunk: 32 * 1024, burst: 2, gap: 40, noLength: true },
  // 超大单集：只给一个 20GB 的 Content-Length，不发正文；缓存应在响应头处拒绝
  huge: { total: 0, headDelay: 40, chunk: 0, burst: 1, gap: 0, fakeLength: 20 * 1024 * 1024 * 1024 }
}

function startFixture() {
  /** 每个请求的现场：第 3 个数字就是「上游首字节」 */
  const requests = []
  let base = ''
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const name = /^\/media\/([a-z0-9_-]+)\.mp4$/i.exec(u.pathname)?.[1]
    const scene = name ? SCENES[name] : null
    if (!scene) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const rec = {
      name,
      at: now(),
      headersAt: 0,
      firstBodyAt: 0,
      status: scene.status || 200,
      bytes: 0,
      range: String(req.headers.range || '')
    }
    requests.push(rec)
    if (scene.status && scene.status >= 400) {
      setTimeout(() => {
        if (res.destroyed) return
        rec.headersAt = now()
        res.writeHead(scene.status, { 'Content-Type': 'text/plain' })
        res.end('forbidden')
      }, scene.headDelay)
      return
    }
    // Range：直连对照组要量「seek 到已缓存区间」的代价，所以 fixture 必须真的支持
    let start = 0
    let end = scene.total - 1
    const m = /^bytes=(\d+)-(\d*)$/.exec(rec.range)
    if (m) {
      start = Number(m[1])
      if (m[2]) end = Math.min(scene.total - 1, Number(m[2]))
      if (start >= scene.total) {
        res.writeHead(416, { 'Content-Range': `bytes */${scene.total}` })
        res.end()
        return
      }
    }
    const partial = !!m
    setTimeout(() => {
      if (res.destroyed) return
      rec.headersAt = now()
      const headers = {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1)
      }
      if (scene.noLength) delete headers['Content-Length']
      if (scene.fakeLength) headers['Content-Length'] = String(scene.fakeLength)
      if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${scene.total}`
      res.writeHead(partial ? 206 : 200, headers)
      let pos = start
      let inBurst = 0
      const push = () => {
        if (res.destroyed || pos > end) {
          if (!res.destroyed) res.end()
          return
        }
        const n = Math.min(scene.chunk, end - pos + 1)
        const buf = Buffer.alloc(n, 0x47)
        if (!rec.firstBodyAt) rec.firstBodyAt = now()
        rec.bytes += n
        pos += n
        inBurst += 1
        res.write(buf)
        if (inBurst >= scene.burst) {
          inBurst = 0
          setTimeout(push, scene.gap)
        } else {
          setTimeout(push, 12)
        }
      }
      push()
    }, scene.headDelay)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve({ base, server, requests, reset: () => (requests.length = 0) })
    })
  })
}

/* ───────────────────────── HTTP 读取小工具 ───────────────────────── */

/**
 * 发一个真实 GET，读到 n 字节就断（模拟播放器「拿到首帧就走」）。
 * 返回 headersAt / firstByteAt / bytes，以及客户端真正拿到的耗时。
 */
function readHttp(url, opts = {}) {
  const { range, maxBytes = 512 * 1024, timeoutMs = 15000 } = opts
  return new Promise((resolve) => {
    const t0 = now()
    let headersAt = 0
    let firstByteAt = 0
    let bytes = 0
    let statusCode = 0
    let error = ''
    const req = http.get(url, { headers: { 'User-Agent': 'sakana-cache-measure', ...(range ? { Range: range } : {}) } }, (res) => {
      statusCode = res.statusCode || 0
      headersAt = now()
      if (res.statusCode >= 400) {
        error = `HTTP ${res.statusCode}`
        res.resume()
        finish()
        return
      }
      res.on('data', (buf) => {
        if (!firstByteAt) firstByteAt = now()
        bytes += buf.length
        if (bytes >= maxBytes) {
          req.destroy()
          finish()
        }
      })
      res.on('end', finish)
      res.on('error', (e) => {
        error = String(e.message || e)
        finish()
      })
    })
    req.setTimeout(timeoutMs, () => {
      error = 'timeout'
      req.destroy()
      finish()
    })
    req.on('error', (e) => {
      error = String(e.message || e)
      finish()
    })
    let done = false
    function finish() {
      if (done) return
      done = true
      resolve({
        status: statusCode,
        headersMs: headersAt ? headersAt - t0 : null,
        firstByteMs: firstByteAt ? firstByteAt - t0 : null,
        headersAtAbs: headersAt,
        firstByteAtAbs: firstByteAt,
        bytes,
        error
      })
    }
  })
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (fn()) return true
    await sleep(30)
  }
  throw new Error(`等待超时：${label}`)
}

function cacheSnapshot() {
  return mediaCache.tempMediaCacheSnapshot()
}

function cacheSession(id) {
  return cacheSnapshot().sessions.find((s) => s.id === id) || null
}

/* ───────────────────────── ① 首字节可播 ───────────────────────── */

async function measureFirstByte(fx, scene) {
  const directUrl = `${fx.base}/media/${scene}.mp4`

  // 改前：直连（播放器直接向上游取流）
  fx.reset()
  const direct = await readHttp(directUrl, { maxBytes: 256 * 1024 })
  const directRec = fx.requests[fx.requests.length - 1]
  const directHop = direct.firstByteAtAbs && directRec?.firstBodyAt ? direct.firstByteAtAbs - directRec.firstBodyAt : null

  // 改后：本地缓存（播放器读本机服务）
  mediaCache.releaseTempMediaCacheOnQuit()
  mediaCache.initTempMediaCache()
  fx.reset()
  timing.beginPlayTiming(`cache-measure/${scene}`)
  const started = mediaCache.startTempMediaCache({ url: directUrl })
  if (!started.ok) throw new Error(`缓存会话没起来：${started.reason}`)
  const local = await readHttp(started.url, { maxBytes: 256 * 1024 })
  const upRec = fx.requests[fx.requests.length - 1]
  const snap = timing.playTimingSnapshot()
  const marks = snap.cacheMarks
  const line = timing.playTimingLine()
  const upstreamToLocal = marks['本地可播'] && marks['上游首字节'] ? marks['本地可播'] - marks['上游首字节'] : null
  const session = cacheSession(started.sessionId)
  timing.logPlayTimingSummary('（首字节测量结束）')
  mediaCache.pauseTempMediaCache(started.sessionId)

  return {
    scene,
    directFirstByteMs: direct.firstByteMs,
    directHopMs: directHop,
    directFromUpstream: direct.firstByteAtAbs && directRec?.firstBodyAt ? direct.firstByteAtAbs - directRec.firstBodyAt : null,
    cacheUpstreamFirstByteMs: marks['上游首字节'] && snap.clickAt ? marks['上游首字节'] - snap.clickAt : null,
    cacheLocalFirstByteMs: marks['本地可播'] && snap.clickAt ? marks['本地可播'] - snap.clickAt : null,
    upstreamToLocalMs: upstreamToLocal,
    localFirstByteMs: local.firstByteMs,
    cacheSessionBytes: session ? session.received : 0,
    timingLine: line
  }
}

/* ───────────────────────── ② 已缓存区间的 Range 延迟 ───────────────────────── */

async function measureRange(fx, scene, offsets) {
  const directUrl = `${fx.base}/media/${scene}.mp4`
  // 先量直连的同一批 Range（fixture 每个请求都要重新付 TTFB + 抖动）
  const direct = []
  for (const off of offsets) {
    const r = await readHttp(directUrl, { range: `bytes=${off}-${off + 64 * 1024 - 1}`, maxBytes: 64 * 1024 })
    direct.push(r.firstByteMs)
  }

  // 再起缓存，等它把要测的区间拉回来
  mediaCache.releaseTempMediaCacheOnQuit()
  mediaCache.initTempMediaCache()
  fx.reset()
  const started = mediaCache.startTempMediaCache({ url: directUrl })
  if (!started.ok) throw new Error(`缓存会话没起来：${started.reason}`)
  const need = Math.max(...offsets) + 64 * 1024
  await waitFor(() => {
    const s = cacheSession(started.sessionId)
    return !!s && s.received >= need
  }, 30000, `缓存到 ${mb(need)}`)
  // 暂停上游，避免后台继续拉抢带宽（已缓存区间的读不受影响）
  mediaCache.pauseTempMediaCache(started.sessionId)
  const cached = []
  for (const off of offsets) {
    const r = await readHttp(started.url, { range: `bytes=${off}-${off + 64 * 1024 - 1}`, maxBytes: 64 * 1024 })
    cached.push(r.firstByteMs)
  }
  const snap = cacheSession(started.sessionId)
  return {
    scene,
    directMedian: pct(direct, 0.5),
    directP95: pct(direct, 0.95),
    cachedMedian: pct(cached, 0.5),
    cachedP95: pct(cached, 0.95),
    cachedBytes: snap ? snap.received : 0,
    count: offsets.length
  }
}

/* ───────────────────────── ②b 未缓存区间的跳转（非 faststart MP4 / 拖进度条） ───────────────────────── */

/**
 * 缓存只到 1MB，播放器却要 5.5MB 处的一段（真实形状：moov 在尾部 / 用户拖到后面）。
 * 期望：服务端不「等缓存爬过去」，而是直接向上游要那一段（206），
 * 耗时约等于一次上游 TTFB，而不是等到缓存把 5.5MB 全拉完。
 */
async function measureJump(fx) {
  const url = `${fx.base}/media/jitter.mp4`
  mediaCache.releaseTempMediaCacheOnQuit()
  mediaCache.initTempMediaCache()
  fx.reset()
  const started = mediaCache.startTempMediaCache({ url })
  if (!started.ok) throw new Error(`缓存会话没起来：${started.reason}`)
  await waitFor(() => (cacheSession(started.sessionId)?.received || 0) >= 1024 * 1024, 15000, '缓存到 1MB')
  const cached = cacheSession(started.sessionId)?.received || 0
  const start = 5.5 * 1024 * 1024
  const r = await readHttp(started.url, { range: `bytes=${start}-${start + 64 * 1024 - 1}`, maxBytes: 64 * 1024 })
  mediaCache.releaseTempMediaCacheOnQuit()
  return { cached, start, firstByteMs: r.firstByteMs, status: r.status, bytes: r.bytes, error: r.error }
}

/* ───────────────────────── ③ 回放（同一集再看一次） ───────────────────────── */

async function measureReplay(fx) {
  const url = `${fx.base}/media/small.mp4`
  mediaCache.releaseTempMediaCacheOnQuit()
  mediaCache.initTempMediaCache()
  fx.reset()
  const first = mediaCache.startTempMediaCache({ url })
  if (!first.ok) throw new Error(`缓存会话没起来：${first.reason}`)
  await waitFor(() => cacheSession(first.sessionId)?.state === 'done', 30000, '缓存完整落盘')
  const full = cacheSession(first.sessionId)?.received || 0
  mediaCache.pauseTempMediaCache(first.sessionId) // 已 done，pause 是空操作

  // 改前：再向上游要一次（真实 CDN 上这就是「重新起播」的代价）
  fx.reset()
  const direct = await readHttp(url, { maxBytes: 256 * 1024 })
  const directRec = fx.requests[fx.requests.length - 1]

  // 改后：复用已缓存的会话
  timing.beginPlayTiming('cache-measure/replay')
  const again = mediaCache.startTempMediaCache({ url })
  if (!again.ok || !again.reused) throw new Error('重播没有复用已缓存的会话')
  const local = await readHttp(again.url, { maxBytes: 256 * 1024 })
  const line = timing.playTimingLine()
  timing.logPlayTimingSummary('（回放测量结束）')
  return {
    fullBytes: full,
    reused: again.reused,
    directFirstByteMs: direct.firstByteMs,
    directUpstreamFirstByteMs: directRec?.firstBodyAt ? direct.firstByteAt - (directRec.at || direct.firstByteAt) : null,
    cachedFirstByteMs: local.firstByteMs,
    timingLine: line
  }
}

/* ───────────────────────── ④ playerEngine 集成 + 回退 ───────────────────────── */

async function runEngineCase(fx, { name, url, expectCached }) {
  fake.__reset()
  flow.resetFlow()
  flow.beginFlow({ mode: 'cache-measure', title: name })
  flow.beginStage('locate')
  flow.succeedStage('locate')
  flow.beginStage('acquire')
  flow.succeedStage('acquire')
  timing.beginPlayTiming(`cache-engine/${name}`)
  playerEngine.engineAttach(null, { x: 0, y: 0, width: 1280, height: 720 })
  playerEngine.enginePlay(url, fx.base, undefined)
  await waitFor(() => fake.__state.firstFrameAt > 0 || fake.__state.loads.length >= 2, 8000, `${name} 首帧或回退`).catch(() => false)
  await sleep(300)
  const loads = fake.__state.loads.map((l) => l.path)
  const cachedLoad = loads.some((p) => /\/cache\//.test(p))
  const directLoad = loads.some((p) => p === url)
  const result = { name, expectCached, loads, cachedLoad, directLoad, firstFrame: !!fake.__state.firstFrameAt }
  playerEngine.engineDetach()
  fake.__reset()
  return result
}

/* ───────────────────────── ⑤ LRU / 清理 / 写盘失败 ───────────────────────── */

async function runLimits(fx) {
  mediaCache.releaseTempMediaCacheOnQuit()
  mediaCache.initTempMediaCache()
  store.set('settings', { ...store.get('settings', {}), tempMediaCacheEpisodes: 2, cacheDir: CACHE_DIR })

  // 安全闸：总长未知（直播/分块）与超大单集必须拒绝缓存（否则会写满磁盘）
  // 注：0 字节的失败会话会被 mediaCache 立刻清出会话表（不占集数名额），所以这里以「会话消失」为判据，
  // 失败原因从日志里读（与真机排障看到的是同一行）。
  const waitRejected = async (started, label) => {
    const from = captured.length
    await waitFor(() => !cacheSession(started.sessionId), 8000, label)
    const line = captured
      .slice(from)
      .filter((l) => l.source === 'cache' && /本地临时缓存失败/.test(l.message))
      .pop()
    return line ? line.message.replace(/（会话 [^）]+）$/, '') : ''
  }
  const chunked = mediaCache.startTempMediaCache({ url: `${fx.base}/media/chunked.mp4` })
  const chunkedReason = await waitRejected(chunked, '分块流被拒绝')
  const huge = mediaCache.startTempMediaCache({ url: `${fx.base}/media/huge.mp4` })
  const hugeReason = await waitRejected(huge, '超大单集被拒绝')
  mediaCache.releaseTempMediaCacheOnQuit()
  mediaCache.initTempMediaCache()

  // 启动清理：模拟「上次被强杀留下一个半截文件」，initTempMediaCache 必须把它删掉
  const leftovers = path.join(mediaCache.tempMediaCacheDir(), 'media-crashed.bin')
  fs.writeFileSync(leftovers, Buffer.alloc(1024 * 1024))
  mediaCache.initTempMediaCache()
  const startupClean =
    !fs.existsSync(leftovers) && fs.readdirSync(mediaCache.tempMediaCacheDir()).length === 0

  const ids = []
  for (let i = 0; i < 3; i += 1) {
    const r = mediaCache.startTempMediaCache({ url: `${fx.base}/media/slow.mp4?ep=${i}` })
    if (!r.ok) throw new Error(`第 ${i + 1} 集缓存没起来：${r.reason}`)
    ids.push(r.sessionId)
    await waitFor(() => (cacheSession(r.sessionId)?.received || 0) > 0, 10000, `第 ${i + 1} 集首字节`)
    await sleep(60)
  }
  const snap = cacheSnapshot()
  const lru = {
    limit: snap.limit,
    sessions: snap.sessions.length,
    oldestEvicted: !snap.sessions.some((s) => s.id === ids[0]),
    newestKept: snap.sessions.some((s) => s.id === ids[2])
  }

  // 写盘失败：把 cacheDir 指向一个**已存在的文件**，mkdir 必然失败
  const blocked = path.join(WORK, 'blocked-file')
  fs.writeFileSync(blocked, 'x')
  store.set('settings', { ...store.get('settings', {}), cacheDir: blocked })
  const failed = mediaCache.startTempMediaCache({ url: `${fx.base}/media/slow.mp4?blocked=1` })
  store.set('settings', { ...store.get('settings', {}), cacheDir: CACHE_DIR })

  // 退出清理
  const before = fs.existsSync(mediaCache.tempMediaCacheDir()) ? fs.readdirSync(mediaCache.tempMediaCacheDir()).length : 0
  mediaCache.releaseTempMediaCacheOnQuit()
  const after = fs.existsSync(mediaCache.tempMediaCacheDir()) ? fs.readdirSync(mediaCache.tempMediaCacheDir()).length : 0
  return { lru, writeFail: { ok: failed.ok, reason: failed.reason }, cleanup: { before, after }, chunkedReason, hugeReason, startupClean }
}

/* ───────────────────────── 日志捕获（验证红线与关键字） ───────────────────────── */

const captured = []
const origAppend = log.append.bind(log)
log.append = (level, source, message) => {
  captured.push({ level, source, message })
  return origAppend(level, source, message)
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function main() {
  store.init()
  log.init()
  store.set('settings', { ...store.get('settings', {}), cacheDir: CACHE_DIR, tempMediaCacheEpisodes: 3 })
  const port = await transcode.initLiveServer()
  mediaCache.initTempMediaCache()
  const fx = await startFixture()

  const mode = process.argv.find((a) => a.startsWith('--')) || '--all'

  console.log(`\n本机缓存服务端口 ${port > 0 ? '已就绪' : '未就绪'}（端口号不打印，红线）`)
  const rows = []

  if (mode === '--all' || mode === '--first-byte') {
    console.log('\n## ① 首字节可播（同一路慢源：上游 380ms TTFB + 周期性停顿）\n')
    console.log('| 场景 | 直连：上游首字节→播放器首字节 | 缓存：上游首字节→本地可播 | 缓存：播放器首字节（从发起算） |')
    console.log('| --- | --- | --- | --- |')
    const a = await measureFirstByte(fx, 'jitter')
    const b = await measureFirstByte(fx, 'slow')
    rows.push(a, b)
    for (const r of [a, b]) {
      console.log(`| ${r.scene} | ${ms(r.directFromUpstream)} | ${ms(r.upstreamToLocalMs)} | ${ms(r.localFirstByteMs)} |`)
    }
    console.log('\n[play-flow] 计时（改后，jitter）：' + a.timingLine)
    console.log('[play-flow] 计时（改后，slow）：' + b.timingLine)
  }

  if (mode === '--all' || mode === '--range') {
    const offsets = [0, 96, 192, 288, 384, 480, 576, 672].map((n) => n * 1024 * 8)
    const r = await measureRange(fx, 'jitter', offsets)
    console.log('\n## ② 已缓存区间的 Range 延迟（同一批 8 个 64KB 请求）\n')
    console.log('| 场景 | 取数位置 | 直连中位数 | 直连 P95 | 缓存中位数 | 缓存 P95 | 已缓存 |')
    console.log('| --- | --- | --- | --- | --- | --- | --- |')
    console.log(
      `| ${r.scene} | 0–6.5MB | ${ms(r.directMedian)} | ${ms(r.directP95)} | ${ms(r.cachedMedian)} | ${ms(r.cachedP95)} | ${mb(r.cachedBytes)} |`
    )
    rows.push(r)

    const j = await measureJump(fx)
    console.log('\n## ②b 未缓存区间的跳转（缓存只到 1MB，播放器要 5.5MB 处）\n')
    console.log('| 已缓存 | 请求位置 | HTTP | 直供首字节 | 取到 | 说明 |')
    console.log('| --- | --- | --- | --- | --- | --- |')
    console.log(
      `| ${mb(j.cached)} | ${mb(j.start)} | ${j.status} | ${ms(j.firstByteMs)} | ${mb(j.bytes)} | ${
        j.status === 206 ? '上游 Range 直供，不写缓存' : j.error || '未生效'
      } |`
    )
    rows.push(j)
  }

  if (mode === '--all' || mode === '--replay') {
    const r = await measureReplay(fx)
    console.log('\n## ③ 回放（同一集第二次起播）\n')
    console.log('| 已缓存 | 直连首字节 | 复用缓存首字节 | 提速 |')
    console.log('| --- | --- | --- | --- |')
    const gain =
      r.cachedFirstByteMs !== null && r.directFirstByteMs !== null
        ? `${Math.max(0, r.directFirstByteMs - r.cachedFirstByteMs)}ms`
        : '—'
    console.log(`| ${mb(r.fullBytes)} | ${ms(r.directFirstByteMs)} | ${ms(r.cachedFirstByteMs)} | ${gain} |`)
    console.log('[play-flow] 计时（回放）：' + r.timingLine)
    rows.push(r)
  }

  if (mode === '--all' || mode === '--engine') {
    console.log('\n## ④ playerEngine 集成与回退\n')
    console.log('| 用例 | 内核第一次 loadfile | 是否本机缓存 | 是否直连 | 回退到直连 | 首帧 |')
    console.log('| --- | --- | --- | --- | --- | --- |')
    const good = await runEngineCase(fx, { name: '正常缓存', url: `${fx.base}/media/small.mp4`, expectCached: true })
    console.log(
      `| 正常缓存 | ${good.cachedLoad ? '本机/缓存' : good.directLoad ? '直连' : '未知'} | ${good.cachedLoad} | ${good.directLoad} | — | ${good.firstFrame} |`
    )
    // 上游 403：缓存会话失败 → 播放层必须把内核切回直连原地址
    const badUrl = `${fx.base}/media/dead.mp4`
    const bad = await runEngineCase(fx, { name: '上游403回退', url: badUrl, expectCached: false })
    const fallbackLoad = bad.loads.find((p) => p === badUrl) || ''
    console.log(
      `| 上游403回退 | ${bad.loads.length} 次装载 | ${bad.cachedLoad} | ${bad.directLoad} | ${fallbackLoad ? '是' : '否'} | ${bad.firstFrame} |`
    )
    // 写盘失败：把缓存目录指向一个文件 → start 直接失败 → 内核只 loadfile 直连
    const blocked = path.join(WORK, 'blocked-file-engine')
    fs.writeFileSync(blocked, 'x')
    store.set('settings', { ...store.get('settings', {}), cacheDir: blocked })
    const writeFail = await runEngineCase(fx, {
      name: '写盘失败回退',
      url: `${fx.base}/media/jitter.mp4`,
      expectCached: false
    })
    store.set('settings', { ...store.get('settings', {}), cacheDir: CACHE_DIR })
    console.log(
      `| 写盘失败回退 | ${writeFail.directLoad ? '直连' : '未知'} | ${writeFail.cachedLoad} | ${writeFail.directLoad} | ${writeFail.directLoad ? '是（未启用缓存）' : '否'} | ${writeFail.firstFrame} |`
    )
    // 环境变量关掉缓存 = 改前行为，同一份代码做对照
    process.env.SAKANA_TEMP_CACHE = '0'
    const off = await runEngineCase(fx, { name: '关闭缓存（改前）', url: `${fx.base}/media/slow.mp4`, expectCached: false })
    delete process.env.SAKANA_TEMP_CACHE
    console.log(
      `| 关闭缓存（改前） | ${off.directLoad ? '直连' : '未知'} | ${off.cachedLoad} | ${off.directLoad} | — | ${off.firstFrame} |`
    )
    const fallbackLogs = captured.filter((l) => /自动回退直连原地址/.test(l.message))
    const cacheLogs = captured.filter((l) => l.source === 'cache')
    console.log(`\n回退日志 ${fallbackLogs.length} 条；新增 [cache] 日志 ${cacheLogs.length} 条（全部走 log.append）`)
    /*
     * 红线自检只针对**这次新增的日志**（source=cache 或文案含「临时缓存」）：
     * 应用原本就会记录本机中转服务端口（transcode 的历史日志），那不属于本次改动。
     */
    const ownLogs = captured.filter((l) => l.source === 'cache' || /临时缓存/.test(l.message))
    const leak = ownLogs.filter((l) => /\/cache\/[A-Za-z0-9_-]+/.test(l.message) || /127\.0\.0\.1:\d+/.test(l.message))
    console.log(`新增日志里出现本机缓存地址的条数：${leak.length}（应为 0；红线）`)
    if (leak.length > 0) console.log(leak.slice(0, 3).map((l) => `  ! ${l.message}`).join('\n'))
    const timingLines = captured.filter((l) => l.source === 'play-flow' && /计时/.test(l.message))
    const last = timingLines[timingLines.length - 1]
    if (last) console.log(`\n[play-flow] ${last.message}`)
    console.log(
      `计时行包含「上游首字节→本地可播」：${
        timingLines.some((l) => /上游首字节→本地可播/.test(l.message)) ? '是' : '否'
      }`
    )
  }

  if (mode === '--all' || mode === '--limits') {
    const r = await runLimits(fx)
    console.log('\n## ⑤ 上限 / 淘汰 / 写盘失败 / 退出清理\n')
    console.log('| 项 | 结果 |')
    console.log('| --- | --- |')
    console.log(`| 上限（集） | ${r.lru.limit} |`)
    console.log(`| 起 3 集后会话数 | ${r.lru.sessions}（应为 2） |`)
    console.log(`| 最久未用已淘汰 | ${r.lru.oldestEvicted} |`)
    console.log(`| 最新一集保留 | ${r.lru.newestKept} |`)
    console.log(`| 目录不可写时启动缓存 | ok=${r.writeFail.ok}（应为 false，原因：${r.writeFail.reason}） |`)
    console.log(`| 分块/直播流（无总长） | ${r.chunkedReason} |`)
    console.log(`| 超大单集（20GB） | ${r.hugeReason} |`)
    console.log(`| 启动清理上次残留 | ${r.startupClean ? '已删除（目录为空）' : '未删除'} |`)
    console.log(`| 退出清理文件数 | ${r.cleanup.before} → ${r.cleanup.after}（应为 0） |`)
    rows.push(r)
  }

  // 收尾：删除所有会话与临时目录，关监听
  mediaCache.releaseTempMediaCacheOnQuit()
  transcode.closeLiveServer()
  await new Promise((resolve) => {
    try {
      fx.server.closeAllConnections()
    } catch {
      /* 旧 node 没有也正常 */
    }
    fx.server.close(resolve)
  })
  try {
    fs.rmSync(WORK, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  console.log('\n（以上数字均来自真实 HTTP + 真实磁盘；fixture 只控制延迟，不伪造字节。）')
  return rows
}

void main().then(
  () => {
    setTimeout(() => process.exit(0), 200)
  },
  (e) => {
    console.error('缓存计时脚本失败：', e)
    setTimeout(() => process.exit(1), 100)
  }
)

/*
 * 「播放规则 → 真正出画面」分段计时脚本（可复跑）。
 *
 * 为什么要有它：Electron 在沙箱里起不来，但这条链路的慢点**几乎全在主进程的等待上**
 * （解析播放页 → 预取/嗅探 → 交给内核之前的校验 → 内核取流），
 * 所以用 tsc 把真实的主进程代码编译成 CJS、把 electron 与 libmpv 换成桩/假内核，
 * 就能用**真实 HTTP** 量出「点击→选源→嗅探命中→loadfile→首帧」每一段。
 *
 * 用法（在仓库根目录）：
 *   node node_modules/typescript/bin/tsc -p scripts/play-speed/tsconfig.json
 *   node -r ./scripts/play-speed/bootstrap.cjs ./scripts/play-speed/measure.cjs --real
 *   node -r ./scripts/play-speed/bootstrap.cjs ./scripts/play-speed/measure.cjs --fixture
 *   node -r ./scripts/play-speed/bootstrap.cjs ./scripts/play-speed/measure.cjs --scan
 *
 * 三个模式测的东西不同，报告里必须分开看：
 *   --real    真实规则站点（7sefun）+ 真实 HTTP：量「点击→选源」「选源→直出判定」。
 *             这些站点在当前网络下播放页里**没有直出地址**（都是 JS 播放器），
 *             所以真正的取流只能靠网页嗅探 —— 脚本起不了真实浏览器窗口，这一段不模拟。
 *   --fixture 本地起一个**真实 HTTP** 的 MacCMS 风格播放页 + HLS 分片（延迟可控），
 *             跑的是真实的 extractStreamCandidates / prefetchStream / getCachedStreamOrWait /
 *             playerEngine.enginePlay 与真实 libmpv 替身（假内核用真实网络取流）。
 *             它补的是「命中→loadfile→首帧」这两段，且结果可复现。
 *   --scan    先扫一遍哪条规则/哪部番能拿到候选（排障用）。
 *
 * 改前/改后怎么复现：脚本本身只有一套逻辑，不做「两套代码各测各的」。
 * 「改前」那组数字是在本次改动**之前**用同一个脚本跑出来的；要重新得到它，
 * 把两个串行点恢复即可：① `prefetchStream` 里的 `await resolveFirstPlayable(...)`（预校验），
 * ② `enginePlay` 里在 loadfile 之前 `await planStreamBoost(...)`。git diff 里就是这两处。
 *
 * 可选环境变量：
 *   SAKANA_SPEED_ANIME="番剧A,番剧B,番剧C"   真实模式要测的三部番
 *   SAKANA_SPEED_REPEAT=3                    每项跑几次取中位数（默认 1）
 *   SAKANA_SPEED_NAV_MS=120                  「选源→播放页挂载」之间的模拟导航耗时
 *   SAKANA_SPEED_HANDOFF=1                   打开「5 秒零字节换候选」（改后版本用）
 *   SAKANA_SPEED_HANDOFF_MODULE=<path>       真实 playHandoff.js 路径
 *   SAKANA_SPEED_TIMING_MODULE=<path>        真实 playTiming.js 路径（打点用）
 *
 * 红线：脚本输出只打印**番剧名/规则名/毫秒数**，不打印流地址与本机端口（与 log.append 同口径）。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // 本机代理根证书不被 node 信任；应用里由 Chromium 网络栈兜底

const http = require('http')
const path = require('path')

const OUT = process.env.SAKANA_SPEED_OUT || path.join(__dirname, '..', '..', '.tmp-play-speed', 'out')
const R = (p) => require(path.join(OUT, 'src', 'main', 'services', p))
const CORE = (p) => require(path.join(OUT, 'src', 'main', p))

const { store } = CORE('store')
const { log } = CORE('log')
const { ensureDefaultRules, rulePlay, ruleSearch, ruleEpisodes } = R('rules')
const flow = R('playFlow')
const ruleProbe = R('ruleProbe')
const streamBoost = R('streamBoost')
/** 交接队列（改后版本才有；改前跑基线时允许不存在） */
let handoff = null
try {
  handoff = R('playHandoff')
} catch {
  handoff = null
}
const playerEngine = R('playerEngine')
const transcode = R('transcode')
const fake = require(path.join(__dirname, 'fake-mpv.cjs'))
const timing = process.env.SAKANA_SPEED_TIMING_MODULE ? require(process.env.SAKANA_SPEED_TIMING_MODULE) : null

/** 真实模式：三部番都走 7sefun（当前网络下唯一稳定返回播放页的站点） */
const REAL_COMBOS = [
  { anime: '葬送的芙莉莲', rule: 'default-7sefun' },
  { anime: '无职转生', rule: 'default-7sefun' },
  { anime: '学生会也有洞', rule: 'default-7sefun' }
]

const NAV_MS = Number(process.env.SAKANA_SPEED_NAV_MS || 120)
const CACHE_WAIT_MS = 2500 // 与播放页 `getCachedStreamOrWait` 的默认值一致
const FIRST_FRAME_TIMEOUT_MS = 25000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()

function ms(v) {
  return v === null || v === undefined ? '—' : `${Math.round(v)}ms`
}

function median(arr) {
  const a = arr.filter((x) => typeof x === 'number').sort((x, y) => x - y)
  return a.length ? a[Math.floor(a.length / 2)] : null
}

function rulesList() {
  return store.get('rules', []).filter((r) => r && r.enabled)
}

/* ───────────────────────── 真实站点 ───────────────────────── */

async function measureReal(combo) {
  const rule = rulesList().find((r) => r.id === combo.rule)
  if (!rule) return { skipped: `没有规则 ${combo.rule}` }
  const search = await ruleSearch(rule.id, combo.anime)
  if (!search.items || !search.items.length) return { skipped: `搜索「${combo.anime}」无结果` }
  const entry = search.items[0]
  const eps = await ruleEpisodes(rule.id, entry)
  const group = eps.groups && eps.groups[0]
  if (!group || !group.episodes || !group.episodes.length) return { skipped: '无剧集' }

  // —— 从这里开始才是「用户点击之后」的计时范围 ——
  const tClick = now()
  if (timing) timing.beginPlayTiming(`real-${combo.anime}`)
  const reply = await rulePlay(rule.id, entry, 0, 0, group.episodes[0].link, eps.vars || {})
  const tSource = now()
  if (timing) timing.markPlayTiming('选源')
  if (!reply || !reply.url) return { skipped: '播放页解析失败' }

  /*
   * 与产品同一时刻发起预取：播放页在 `api.rules.play` 返回后立刻请求 prefetchStream。
   * 改后这一步由主进程在 rulesPlay 里直接发起（省一次 IPC + 一次重复的播放页解析）。
   */
  const prefetch = ruleProbe.prefetchStream(reply.url, rule.baseUrl).catch(() => null)
  await sleep(NAV_MS) // 页面导航 + 播放页挂载
  const hit = await ruleProbe.getCachedStreamOrWait(reply.url, CACHE_WAIT_MS)
  const tDecision = now()
  const prefetched = await prefetch
  const tPrefetch = now()
  return {
    anime: combo.anime,
    rule: rule.name,
    clickToSource: tSource - tClick,
    sourceToDecision: tDecision - tSource,
    prefetchMs: tPrefetch - tSource,
    direct: !!(hit || prefetched),
    cacheHit: !!hit,
    webview: !hit && !prefetched,
    page: reply.url
  }
}

async function runReal() {
  const rows = []
  for (const combo of REAL_COMBOS) {
    ruleProbe.clearStreamCache()
    const r = await measureReal(combo)
    rows.push(r)
    if (r.skipped) {
      console.log(`✗ ${combo.anime}：${r.skipped}`)
      continue
    }
    console.log(
      `[play-flow] 计时 ${r.anime}（${r.rule}）｜点击→选源 ${ms(r.clickToSource)} / ` +
        `选源→直出判定 ${ms(r.sourceToDecision)}（预取 ${ms(r.prefetchMs)}，` +
        `${r.direct ? '有直出候选' : '无直出候选 → 必须网页嗅探'}）`
    )
    await sleep(400) // 对站点礼貌一点，避免连续请求被限流
  }
  console.log('\n| 番剧 | 点击→选源（真实） | 选源→直出判定（真实） | 预取总耗时 | 结论 |')
  console.log('| --- | --- | --- | --- | --- |')
  for (const r of rows) {
    if (r.skipped) {
      console.log(`| ${r.anime} | 跳过：${r.skipped} | | | |`)
      continue
    }
    console.log(
      `| ${r.anime} | ${ms(r.clickToSource)} | ${ms(r.sourceToDecision)} | ${ms(r.prefetchMs)} | ` +
        `${r.direct ? '有直出候选' : '无直出候选 → 网页嗅探'} |`
    )
  }
  return rows
}

/* ───────────────────────── 本地真实 HTTP fixture ───────────────────────── */

/**
 * 本地 fixture：一个 MacCMS 风格的播放页 + 一份真 HLS 列表 + 真分片。
 *
 * 为什么用它补「嗅探/内核」两段：真实站点在这一网络下都要网页嗅探，而 Electron 起不来。
 * 这里起的是**真实 HTTP 服务**，跑的是**真实业务代码**（解析/预取/交接/内核取流），
 * 只是把「站点/CDN 的延迟」变成可控参数，于是结果可复现、可比。
 */
function startFixture() {
  const SCEN = {
    fast: { page: 120, m3u8: 60, seg: 150 },
    slow: { page: 250, m3u8: 60, seg: 1800 },
    dead: { page: 120, m3u8: 60, seg: 150 }
  }
  let base = ''
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    const send = (delay, headers, body) => {
      setTimeout(() => {
        if (res.destroyed) return
        res.writeHead(200, headers)
        if (req.method === 'HEAD') res.end()
        else res.end(body)
      }, delay)
    }
    // 播放页：player_aaaa 里写直链（encrypt=0），死候选场景把 url 放前、url_next 放后
    const play = /^\/play\/(fast|slow|dead)\.html$/.exec(p)
    if (play) {
      const name = play[1]
      const d = SCEN[name]
      const live = `${base}/hls/${name}/index.m3u8`
      const first = name === 'dead' ? `${base}/dead/index.m3u8` : live
      const body =
        `<html><head><title>fixture</title></head><body><script>` +
        `var player_aaaa={"flag":"play","encrypt":0,"url":${JSON.stringify(first)},` +
        `"url_next":${JSON.stringify(name === 'dead' ? live : '')}};` +
        `</script></body></html>`
      send(d.page, { 'Content-Type': 'text/html; charset=utf-8' }, body)
      return
    }
    // HLS 列表
    const hls = /^\/hls\/(fast|slow|dead)\/index\.m3u8$/.exec(p)
    if (hls) {
      const name = hls[1]
      const d = SCEN[name]
      const segs = [`${base}/media/${name}/seg0.ts`, `${base}/media/${name}/seg1.ts`]
      const body =
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n' +
        `#EXTINF:4.0,\n${segs[0]}\n#EXTINF:4.0,\n${segs[1]}\n#EXT-X-ENDLIST\n`
      send(d.m3u8, { 'Content-Type': 'application/vnd.apple.mpegurl' }, body)
      return
    }
    // 分片：真字节（0x47 打头，像 MPEG-TS），延迟可控
    const seg = /^\/media\/(fast|slow|dead)\/seg\d\.ts$/.exec(p)
    if (seg) {
      const name = seg[1]
      const buf = Buffer.alloc(512 * 1024, 0x47)
      send(SCEN[name].seg, { 'Content-Type': 'video/mp2t', 'Content-Length': String(buf.length) }, buf)
      return
    }
    // 死候选：接受连接但一个字节都不回（真机上「地址失效但连接不断」就是这种形状）
    if (p === '/dead/index.m3u8') return
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      base = `http://127.0.0.1:${port}`
      resolve({ base, server })
    })
  })
}

/** 完整跑一次 fixture：点击 → 预取/命中 → 交接 → loadfile → 首帧 */
async function measureFixture(fx, name) {
  const playUrl = `${fx.base}/play/${name}.html`
  const tClick = now()
  if (timing) timing.beginPlayTiming(`fixture-${name}`)
  /*
   * 开一轮真实的播放流程：真机上播放页挂载时就会 beginFlow，
   * 「注入播放器」阶段与 15 秒看门狗都由 mpv 的 loadfile 武装。
   * 脚本里走同一条路，于是最后那行 `[play-flow] 计时 …` 是**产品代码**打出来的。
   */
  flow.beginFlow({ mode: 'fixture', title: `fixture/${name}` })
  flow.beginStage('locate', 'fixture 播放页地址就绪')
  flow.succeedStage('locate', '播放页地址已就绪')
  // 点击瞬间就发预取（与产品一致）；播放页地址由 fixture 直接给出，故「选源」= 0ms
  const prefetch = ruleProbe.prefetchStream(playUrl, fx.base, { handoff: true }).catch(() => null)
  const tSource = now()
  if (timing) timing.markPlayTiming('选源')
  flow.beginStage('acquire', '正在嗅探播放页里的媒体地址')
  await sleep(NAV_MS)
  const hit = await ruleProbe.getCachedStreamOrWait(playUrl, CACHE_WAIT_MS)
  const tHit = now()
  const prefetched = await prefetch
  // 没有命中缓存时，「拿到候选」的时刻就是预取真正返回的时刻（与播放页被迫开网页嗅探同一条路）
  const tHand = hit ? tHit : now()
  if (timing) timing.markPlayTiming('命中')
  const target = hit || prefetched
  if (!target || !target.url) return { skipped: '没有拿到候选' }
  flow.succeedStage('acquire', '已拿到可交给内核的地址')

  const loadsBefore = fake.__state.loads.length
  /*
   * 真机上这一步是 `CH.playerPlay` 做的：把「正在交给内核的地址」记进交接队列。
   * 不记的话，5 秒零字节换候选会先换回同一个地址（脚本里实测到过，会多等一轮 5 秒）。
   */
  if (handoff) handoff.noteHandoffActive(target.url)
  playerEngine.enginePlay(target.url, target.referer || fx.base, undefined)
  const deadline = now() + FIRST_FRAME_TIMEOUT_MS
  while (now() < deadline && !fake.__state.firstFrameAt) await sleep(40)
  const tFrame = fake.__state.firstFrameAt
  const firstLoad = fake.__state.loads[loadsBefore]
  const loadAt = firstLoad ? firstLoad.at : null
  const frameLoad = fake.__state.firstFrameLoad
  /*
   * 「网页嗅探复用预取那份播放页」的实测：
   * 预取先抓过播放页，嗅探窗口再解析同一个地址时应该命中 8 秒短缓存（≈0ms）；
   * 不走缓存（旧行为）就得再拉一次页面，fixture 里就是 page 延迟那一档。
   * 这段放在首帧之后跑，不进入上面的分段计时。
   */
  const tCached = now()
  await ruleProbe.extractStreamCandidatesCached(playUrl, fx.base).catch(() => [])
  const cachedExtractMs = now() - tCached
  const tRaw = now()
  await ruleProbe.extractStreamCandidates(playUrl, fx.base).catch(() => [])
  const rawExtractMs = now() - tRaw
  return {
    name,
    cached: !!hit,
    cachedExtractMs,
    rawExtractMs,
    clickToSource: tSource - tClick,
    sourceToHit: tHand - tSource,
    hitToLoadfile: loadAt ? loadAt - tHand : null,
    loadfileToFirstFrame: loadAt && tFrame ? tFrame - loadAt : null,
    total: loadAt && tFrame ? tFrame - tClick : null,
    switches: fake.__state.switches.length,
    loads: fake.__state.loads.length - loadsBefore,
    frame: frameLoad ? `${frameLoad.status}/${frameLoad.bytes}B` : '—',
    error: frameLoad ? frameLoad.error : '没有首帧'
  }
}

async function runFixture() {
  const fx = await startFixture()
  const names = ['fast', 'slow', 'dead']
  const rows = []
  for (const name of names) {
    ruleProbe.clearStreamCache()
    fake.__reset()
    const r = await measureFixture(fx, name)
    rows.push(r)
    if (r.skipped) {
      console.log(`✗ fixture/${name}：${r.skipped}`)
      continue
    }
    console.log(
      `[play-flow] 计时 fixture/${name}｜点击→选源 ${ms(r.clickToSource)} / 选源→嗅探命中 ${ms(r.sourceToHit)}` +
        ` / 命中→loadfile ${ms(r.hitToLoadfile)} / loadfile→首帧 ${ms(r.loadfileToFirstFrame)}` +
        `（合计 ${ms(r.total)}，换候选 ${r.switches} 次，取流 ${r.frame}${r.error ? `，${r.error}` : ''}）`
    )
    console.log(
      `[play-flow] 播放页解析复用：网页嗅探第二次解析 ${ms(r.cachedExtractMs)}（不走缓存 ${ms(r.rawExtractMs)}）`
    )
    // 让这一轮的「延迟加速决策」（2.5 秒）先落地，避免它拿着上一轮的地址干扰下一轮
    await sleep(2600)
  }
  console.log('\n| fixture 场景 | 点击→选源 | 选源→嗅探命中 | 命中→loadfile | loadfile→首帧 | 合计 | 换候选 |')
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  for (const r of rows) {
    if (r.skipped) {
      console.log(`| ${r.name} | 跳过：${r.skipped} | | | | | |`)
      continue
    }
    console.log(
      `| ${r.name} | ${ms(r.clickToSource)} | ${ms(r.sourceToHit)} | ${ms(r.hitToLoadfile)} | ` +
        `${ms(r.loadfileToFirstFrame)} | ${ms(r.total)} | ${r.switches} |`
    )
  }
  await new Promise((r) => {
    try {
      fx.server.closeAllConnections()
    } catch {
      /* 老 node 没有这个方法也不影响 */
    }
    fx.server.close(r)
  })
  return rows
}

/* ───────────────────────── 真实 CDN（可选） ───────────────────────── */

/**
 * 真实 CDN 对照（可选，`--realstream`）。
 *
 * 为什么还要这一行：fixture 的慢速是「造出来的 1.8 秒」，真实慢 CDN 的首字节可能是 8~20 秒。
 * 这里用**同一条真实地址**跑两种顺序，量的是「命中→loadfile」这一段：
 *   · `旧顺序`：脚本按改前代码复刻（await planStreamBoost 的测速/预热 → loadfile）；
 *   · `新代码`：直接调 playerEngine.enginePlay（loadfile 立刻发生）。
 * 地址从环境变量给，不写进仓库（避免把第三方直链固化成一个会过期的测试依赖）：
 *   SAKANA_SPEED_REAL_STREAM_URL=https://…/xxx.mp4
 *   SAKANA_SPEED_REAL_STREAM_REFERER=https://…/   （可选）
 */
async function runRealStream() {
  const url = process.env.SAKANA_SPEED_REAL_STREAM_URL
  if (!url) {
    console.log('（未设置 SAKANA_SPEED_REAL_STREAM_URL，跳过真实 CDN 对照）')
    return []
  }
  const referer = process.env.SAKANA_SPEED_REAL_STREAM_REFERER || undefined
  const run = async (legacy) => {
    ruleProbe.clearStreamCache()
    fake.__reset()
    if (timing) timing.beginPlayTiming(legacy ? '旧顺序' : '新代码')
    flow.beginFlow({ mode: 'realstream', title: legacy ? '旧顺序' : '新代码' })
    flow.beginStage('locate')
    flow.succeedStage('locate')
    flow.beginStage('acquire')
    const tHit = now()
    if (timing) timing.markPlayTiming('命中')
    flow.succeedStage('acquire')
    const loadsBefore = fake.__state.loads.length
    let boostPlanMs = null
    if (legacy) {
      // 改前 enginePlay 的真实顺序：先等测速/预热，再 loadfile（这里用真实 planStreamBoost）
      const t0 = now()
      const plan = await streamBoost.planStreamBoost(url, { referer }).catch(() => null)
      boostPlanMs = now() - t0
      const target = plan && plan.boosted && plan.url ? plan.url : url
      fake.mpvPlay(target, referer, undefined)
    } else {
      playerEngine.enginePlay(url, referer, undefined)
    }
    const deadline = now() + 45_000
    while (now() < deadline && !fake.__state.firstFrameAt) await sleep(50)
    const firstLoad = fake.__state.loads[loadsBefore]
    const loadAt = firstLoad ? firstLoad.at : null
    const tFrame = fake.__state.firstFrameAt
    await sleep(1500) // 给后台测速收尾，别把下一轮的日志串进来
    return {
      mode: legacy ? '旧顺序（脚本复刻）' : '新代码',
      hitToLoadfile: loadAt ? loadAt - tHit : null,
      loadfileToFirstFrame: loadAt && tFrame ? tFrame - loadAt : null,
      total: loadAt && tFrame ? tFrame - tHit : null,
      boostPlanMs
    }
  }
  const rows = [await run(true), await run(false)]
  console.log('\n| 真实 CDN | 命中→loadfile | 测速/预热耗时 | loadfile→首帧 | 命中→首帧 |')
  console.log('| --- | --- | --- | --- | --- |')
  for (const r of rows) {
    console.log(
      `| ${r.mode} | ${ms(r.hitToLoadfile)} | ${r.boostPlanMs === null ? '—' : ms(r.boostPlanMs)} | ` +
        `${ms(r.loadfileToFirstFrame)} | ${ms(r.total)} |`
    )
  }
  return rows
}

/* ───────────────────────── 扫描 ───────────────────────── */

async function scan() {
  const anime = (process.env.SAKANA_SPEED_ANIME || '葬送的芙莉莲,无职转生,学生会也有洞').split(',')
  for (const kw of anime) {
    for (const rule of rulesList()) {
      const t0 = now()
      let search
      try {
        search = await ruleSearch(rule.id, kw)
      } catch (e) {
        console.log(`— ${kw} × ${rule.name}: 搜索异常 ${String(e).slice(0, 80)}`)
        continue
      }
      if (!search.items || !search.items.length) {
        console.log(`— ${kw} × ${rule.name}: 搜索 0 条（${now() - t0}ms）`)
        continue
      }
      const eps = await ruleEpisodes(rule.id, search.items[0])
      const group = eps.groups && eps.groups[0]
      if (!group || !group.episodes || !group.episodes.length) {
        console.log(`— ${kw} × ${rule.name}: 无剧集`)
        continue
      }
      const t1 = now()
      const play = await rulePlay(rule.id, search.items[0], 0, 0, group.episodes[0].link, eps.vars || {}).catch(() => null)
      if (!play || !play.url) {
        console.log(`— ${kw} × ${rule.name}: 拿不到播放页`)
        continue
      }
      const t2 = now()
      const cands = await ruleProbe.extractStreamCandidates(play.url, rule.baseUrl).catch(() => [])
      console.log(
        `● ${kw} × ${rule.name}: 播放页 ${now() - t1}ms / 直出 ${cands.length} 个 ${now() - t2}ms`
      )
    }
  }
}

async function main() {
  store.init()
  log.init()
  ensureDefaultRules()
  // 真机上播放页会先 attach；假内核同样要求先 attach 才能 loadfile
  playerEngine.engineAttach(null, { x: 0, y: 0, width: 1280, height: 720 })
  /*
   * 本机中转服务（广告过滤 + 在线播放加速共用同一个端口）：
   * 真机启动时就绪，`planStreamBoost` 只有在端口就绪时才真的做测速/预热；
   * 这里把它一并起起来，量到的「命中→loadfile」才是真机上的那一段。
   */
  try {
    await transcode.initLiveServer()
  } catch (e) {
    console.log(`（本机中转服务未启动：${String(e).slice(0, 80)}；加速测速会被跳过）`)
  }
  const arg = process.argv.find((a) => ['--real', '--fixture', '--realstream', '--scan'].includes(a))
  if (arg === '--scan') return await scan()
  const real = arg === '--real'
  const fixture = arg === '--fixture'
  const realStream = arg === '--realstream'
  if (real || !arg) await runReal()
  if (fixture || !arg) {
    if (!arg) console.log('')
    await runFixture()
  }
  if (realStream || !arg) {
    if (!arg) console.log('')
    await runRealStream()
  }
}

void main().then(
  () => {
    // 假内核/加速器可能还留着计时器与本地服务：脚本自己退出，不等事件循环清空
    setTimeout(() => process.exit(0), 200)
  },
  (e) => {
    console.error('计时脚本失败：', e)
    process.exit(1)
  }
)

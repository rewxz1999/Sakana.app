/*
 * TvTFun 在线播放规则诊断脚本（Node + axios，不启动 Electron）
 *
 * 背景：TvTFun 规则能搜到番剧、也能解析出剧集，但应用侧用屏幕外浏览器窗口
 * 嗅探播放页 20~40 秒都抓不到任何媒体地址。本脚本用纯 HTTP 复现并定位原因。
 *
 * 依次探测：
 *   1. 搜索 API   GET https://www.tvtfun.net/api/videos/search?q=<kw>&pageSize=5
 *   2. 详情 API   GET https://www.tvtfun.net/api/videos/<id>（注意：slug 不行）
 *   3. 播放页 HTML（对照规则生成的 playUrlTemplate + playQuery 与站点真实地址）
 *   4. 播放页引用的 JS chunk：找 m3u8 / #EXTM3U / playUrl / /api/ 等线索
 *   5. 猜测并实测「取流接口」，验证是否要鉴权 / Referer
 *
 * 用法： node scripts/diag-tvtfun.js [keyword]
 */
const axios = require('axios')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const BASE = 'https://www.tvtfun.net'
const KEYWORD = process.argv[2] || '葬送的芙莉莲'

const client = axios.create({
  timeout: 20000,
  responseType: 'text',
  maxRedirects: 5,
  validateStatus: () => true,
  headers: {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, text/html, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
})

const hr = (t) => console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78))
const short = (s, n = 300) => {
  const t = String(s == null ? '' : s)
  return t.length > n ? t.slice(0, n) + ` …(+${t.length - n} chars)` : t
}
const uniq = (a) => [...new Set(a)]

async function get(url, extraHeaders = {}) {
  const started = Date.now()
  try {
    const res = await client.get(url, { headers: { ...extraHeaders } })
    return { res, ms: Date.now() - started, ok: true }
  } catch (e) {
    return { res: null, ms: Date.now() - started, ok: false, err: e.message }
  }
}
const bodyOf = (res) => String(res?.data ?? '')
function parseJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** 结构概览：只打印字段名与类型 */
function shape(v, depth = 0, maxDepth = 3) {
  const pad = '  '.repeat(depth)
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}[] (empty)`
    return `${pad}[${v.length}] of\n${shape(v[0], depth + 1, maxDepth)}`
  }
  if (v && typeof v === 'object') {
    if (depth >= maxDepth) return `${pad}{…}`
    return Object.entries(v)
      .map(([k, val]) => {
        const t = Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val
        const preview = t === 'string' ? ` = ${JSON.stringify(short(val, 70))}` : ''
        const child = t === 'object' || t === 'array' ? '\n' + shape(val, depth + 2, maxDepth) : ''
        return `${pad}  ${k}: ${t}${preview}${child}`
      })
      .join('\n')
  }
  return `${pad}${typeof v}`
}

const state = { mediaHits: [], endpoints: [], notes: [] }

;(async () => {
  // ---------------------------------------------------------------- 1. 搜索
  hr(`1) 搜索 API   keyword=${KEYWORD}`)
  const searchUrl = `${BASE}/api/videos/search?q=${encodeURIComponent(KEYWORD)}&pageSize=5`
  console.log('GET ' + searchUrl)
  const s = await get(searchUrl)
  if (!s.ok) return console.log('搜索失败: ' + s.err)
  console.log(`→ HTTP ${s.res.status}  ${s.ms}ms  content-type=${s.res.headers['content-type']}`)
  const searchJson = parseJson(bodyOf(s.res))
  if (!searchJson) return console.log('搜索返回非 JSON: ' + short(bodyOf(s.res), 500))
  console.log('结构：\n' + shape(searchJson))
  const videos = searchJson?.data?.videos ?? []
  const first = videos[0]
  if (!first) return console.log('!! 搜索无结果')
  console.log('\n规则用到的字段： id=' + first.id + '  slug=' + first.slug + '  name=' + first.name)
  console.log('说明：规则用 itemSourceJsonPath=$.id 作为 @source，详情 API 只认 id（slug 会返回「视频不存在」）')

  // ---------------------------------------------------------------- 2. 详情
  hr('2) 详情 API')
  let d = null
  for (const u of [`${BASE}/api/videos/${first.id}`, `${BASE}/api/videos/${first.slug}`]) {
    console.log('\nGET ' + u)
    const r = await get(u)
    if (!r.ok) {
      console.log('→ 失败 ' + r.err)
      continue
    }
    const j = parseJson(bodyOf(r.res))
    console.log(`→ HTTP ${r.res.status}  ${r.ms}ms`)
    console.log('  顶层键: ' + (j ? Object.keys(j).join(', ') : '(非 JSON)'))
    if (j?.error) console.log('  error: ' + j.error)
    if (j?.data) {
      console.log('  data 键: ' + Object.keys(j.data).join(', '))
      if (!d) d = j
    }
  }
  if (!d) return console.log('!! 详情 API 不可用')

  const v = d.data
  const slug = v.slug
  const playSources = v.playSources || []
  console.log(`\nplaySources: ${playSources.length} 条`)
  playSources.forEach((ps, i) => {
    console.log(
      `\n  [线路索引 ${i}] id=${ps.id} name=${JSON.stringify(ps.name)} fromCode=${JSON.stringify(ps.fromCode)}` +
        ` openlistPath=${JSON.stringify(ps.openlistPath)} requireLogin=${ps.requireLogin} episodes=${(ps.episodes || []).length}`
    )
    const ep = ps.episodes?.[0]
    if (ep) console.log('      ep[0] = ' + JSON.stringify(ep))
  })
  const lineNames = playSources.map((p) => p.name).join(' / ')
  console.log(`\n注意线路名：${lineNames}  ← 若出现「跳号」（如 线路A/线路B/线路D），` +
    `说明 search 接口返回的 playSources 顺序未必等于站点播放页的 source 序号`)
  console.log('\n关键：每一集的 url 字段 = ' +
    JSON.stringify(playSources[0]?.episodes?.[0]?.url) +
    '  ← 不是直链，需要另取')

  const rulePlayUrl = `${BASE}/video/${slug}/play?source=0&episode=0`
  console.log('\n规则生成的播放页 URL（rules.ts rulePlay：@slug=%.data.slug / source=@roadIndex / episode=@episodeIndex）:')
  console.log('  ' + rulePlayUrl)

  // ---------------------------------------------------------------- 3. 播放页
  hr('3) 播放页 HTML')
  const pageUrls = uniq([
    rulePlayUrl,
    `${BASE}/video/${slug}/play`,
    `${BASE}/video/${slug}/play?source=0&episode=1`,
    `${BASE}/video/${slug}`
  ])
  let pageHtml = null
  let pageUrlUsed = null
  for (const u of pageUrls) {
    console.log('\nGET ' + u)
    const r = await get(u, { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' })
    if (!r.ok) {
      console.log('→ 失败 ' + r.err)
      continue
    }
    const b = bodyOf(r.res)
    console.log(
      `→ HTTP ${r.res.status}  ${r.ms}ms  bytes=${b.length}  ct=${r.res.headers['content-type']}`
    )
    const markers = [
      'player_aaaa',
      '__NUXT__',
      '__NEXT_DATA__',
      '__INITIAL_STATE__',
      'm3u8',
      '#EXTM3U',
      'playUrl',
      'videoUrl',
      '<video',
      'Artplayer',
      'DPlayer',
      'Hls',
      'requireLogin'
    ]
    console.log('  标记命中: ' + (markers.filter((m) => b.includes(m)).join(', ') || '(无)'))
    if (!pageHtml && /html/i.test(String(r.res.headers['content-type'] || ''))) {
      pageHtml = b
      pageUrlUsed = u
    }
  }
  if (!pageHtml) return console.log('!! 播放页 HTML 不可用')

  console.log('\n--- 播放页里出现的 /api/ 路径（RSC payload / 内联脚本中的线索）---')
  const apisInHtml = uniq(
    (pageHtml.match(/\/api\/[a-zA-Z0-9_\-/{}$.:]*/g) || []).map((x) => x.replace(/["'`\\].*$/, ''))
  )
  apisInHtml.forEach((a) => console.log('  ' + a))
  console.log('--- 播放页里出现的 http(s) 媒体线索 ---')
  const mediaInHtml = uniq(
    pageHtml.match(/https?:\\?\/\\?\/[^"'\s\\<>]{4,}\.(?:m3u8|mp4|flv|mkv|webm)(?:\?[^"'\s\\<>]*)?/gi) || []
  )
  mediaInHtml.forEach((m) => {
    console.log('  ' + short(m, 200))
    state.mediaHits.push(m.replace(/\\\//g, '/'))
  })
  const pdIdx = pageHtml.indexOf('protected')
  if (pdIdx >= 0) {
    console.log('\n--- "protected" 在播放页 HTML 中的上下文 ---')
    console.log(short(pageHtml.slice(Math.max(0, pdIdx - 500), pdIdx + 500), 1100))
  }

  // ---------------------------------------------------------------- 4. JS chunk
  hr('4) 播放页引用的 JS chunk：查找取流接口')
  const scripts = uniq(
    [...pageHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map((m) => {
        try {
          return new URL(m[1], pageUrlUsed).toString()
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .filter((u) => !/cloudflareinsights|googletagmanager|google-analytics|hm\.baidu/i.test(u))
  )
  console.log(`共 ${scripts.length} 个 chunk，逐个扫描…`)
  for (const js of scripts) {
    const r = await get(js, { Accept: '*/*' })
    if (!r.ok) {
      console.log(`  ${js.split('/').pop()} → 失败 ${r.err}`)
      continue
    }
    const code = bodyOf(r.res)
    const score = ['m3u8', 'EXTM3U', 'playUrl', 'videoUrl', '/api/', 'protected', 'player']
      .map((k) => [k, code.split(k).length - 1])
      .filter(([, n]) => n > 0)
    if (!score.length) continue
    console.log(
      `\n  ${js.split('/').pop()} (${code.length}B) ${JSON.stringify(Object.fromEntries(score))}`
    )
    const apiPaths = uniq(
      (code.match(/\/api\/[a-zA-Z0-9_\-/{}$.:]*/g) || []).map((x) => x.replace(/["'`\\].*$/, ''))
    )
    apiPaths.slice(0, 40).forEach((a) => {
      console.log('      API: ' + a)
      state.endpoints.push(a)
    })
    if (/playUrl|m3u8|EXTM3U|protected/i.test(code)) {
      const snips =
        code.match(/.{0,120}(?:playUrl|m3u8|EXTM3U|"protected"|'protected'|protected).{0,160}/gi) || []
      uniq(snips)
        .slice(0, 10)
        .forEach((x) => console.log('      · ' + short(x.replace(/\s+/g, ' '), 300)))
    }
    const abs = code.match(/https?:\\?\/\\?\/[^\s"'\\)]{4,}\.(?:m3u8|mp4|flv)[^\s"'\\)]*/gi) || []
    abs.slice(0, 8).forEach((u) => state.mediaHits.push(u.replace(/\\\//g, '/')))

    // 播放器 chunk 里，取流逻辑一定紧邻 /api/ 字符串与 fetch —— 打印足够长的上下文
    const keyTokens = [
      '/api/openlist',
      '/api/videos/',
      'source:"direct"',
      'function nq(',
      // 取流请求带 headers: nj() —— 找出这个凭证头的来源
      'function nj(',
      'function nB(',
      'tvt-pt',
      '播放凭证',
      'play-token',
      'playToken',
      'x-play',
      // 凭证（X-Play-Ctx）是在哪里被写入 sessionStorage 的？谁签发它？
      'setItem(nN',
      'nN,',
      'play-ctx',
      'play-ct',
      'X-Play-Ctx',
      'gesture',
      'flutter_inappwebview',
      'rateLimited',
      'pt-',
      'too',
      'frequent'
    ]
    for (const tok of keyTokens) {
      let idx = -1
      let n = 0
      while ((idx = code.indexOf(tok, idx + 1)) >= 0 && n < 4) {
        n++
        console.log(
          `\n      [${tok}] 上下文 @${idx}:\n        ` +
            short(code.slice(Math.max(0, idx - 450), idx + 450).replace(/\s+/g, ' '), 950)
        )
      }
    }
  }

  // ---------------------------------------------------------------- 5. 取流接口试探
  hr('5) 猜测并实测「取流接口」')
  const ep0 = playSources[0]?.episodes?.[0]
  const cands = uniq(
    [
      // ★ 从播放器 chunk a880b2746a117d27.js 挖出的真实取流接口：
      //   nO.request.get("/videos/resolve-play-url", { params: { episodeId: e }, headers: nj() })
      ep0 && `${BASE}/api/videos/resolve-play-url?episodeId=${ep0.id}`,
      ep0 && `${BASE}/videos/resolve-play-url?episodeId=${ep0.id}`,
      ep0 && `${BASE}/api/openlist?action=get&path=${encodeURIComponent(ep0.url || '')}`,
      ep0 && `${BASE}/api/episodes/${ep0.id}`,
      ep0 && `${BASE}/api/videos/episodes/${ep0.id}/play`,
      `${BASE}/api/videos/${first.id}/play?source=0&episode=0`,
      `${BASE}/api/videos/${slug}/play?source=0&episode=0`,
      `${BASE}/api/play/${slug}?source=0&episode=0`,
      `${BASE}/api/videos/${first.id}/sources`,
      `${BASE}/api/videos/${first.id}/episodes`,
      `${BASE}/api/videos/${first.id}/playSources`,
      // 上面从 JS 里挖出来的接口
      ...state.endpoints
        .filter((p) => !p.includes('[') && !p.includes('$') && !p.includes('{'))
        .slice(0, 40)
        .map((p) => (p.includes('?') ? `${BASE}${p}&source=0&episode=0` : `${BASE}${p}?source=0&episode=0`))
    ].filter(Boolean)
  )
  for (const u of cands) {
    const r = await get(u)
    if (!r.ok) {
      console.log(`\nGET ${u}\n  → 失败 ${r.err}`)
      continue
    }
    const b = bodyOf(r.res)
    const flag = /m3u8|EXTM3U|\.mp4|"url"\s*:\s*"http/i.test(b) ? '  <<< 有流线索' : ''
    console.log(`\nGET ${u}\n  → HTTP ${r.res.status} ${b.length}B ${r.res.headers['content-type']}${flag}`)
    if (b.length <= 900) console.log('  body: ' + b.replace(/\s+/g, ' '))
    else if (flag) console.log('  ' + short(b, 700))
  }

  // ---------------------------------------------------------------- 5b. 鉴权/防盗链
  hr('5b) resolve-play-url 的鉴权 / 防盗链校验')
  const rp = `${BASE}/api/videos/resolve-play-url?episodeId=${ep0?.id}`
  const combos = [
    ['原始（仅 UA）', {}],
    ['+ Referer: 播放页', { Referer: rulePlayUrl }],
    ['+ Origin', { Origin: BASE }],
    ['+ Referer + Origin', { Referer: rulePlayUrl, Origin: BASE, Accept: '*/*' }],
    ['+ X-Requested-With', { 'X-Requested-With': 'XMLHttpRequest', Referer: rulePlayUrl, Origin: BASE }],
    ['+ RSC/Next 头', { RSC: '1', Referer: rulePlayUrl, Origin: BASE, 'Next-Router-State-Tree': '%5B%22%22%5D' }]
  ]
  for (const [label, h] of combos) {
    const r = await get(rp, h)
    if (!r.ok) {
      console.log(`\n${label} → 失败 ${r.err}`)
      continue
    }
    const b = bodyOf(r.res)
    console.log(`\n${label}\n  → HTTP ${r.res.status} ${b.length}B ${r.res.headers['content-type']}`)
    console.log('  set-cookie: ' + short(r.res.headers['set-cookie']?.join(' | ') || '(无)', 200))
    console.log('  body: ' + short(b.replace(/\s+/g, ' '), 400))
  }

  // ---------------------------------------------------------------- 5c. 伪造凭证
  hr('5c) 伪造 X-Play-Ctx（播放页 JS 的凭证算法）')
  console.log(`播放页 JS（chunk a880b2746a117d27.js）里的原文：
  let nB="tvt-play-gesture", nN="tvt-play-ctx";
  function nj(){ try{ let e=sessionStorage.getItem(nN); if(e) return {"X-Play-Ctx": e} }catch(e){} return {} }
  // 播放按钮 onClick:
  onClick: e => {
    if (!e.nativeEvent.isTrusted) return;              // 合成点击直接被丢弃
    let t = "visible" === document.visibilityState, a = window.innerWidth, n = window.innerHeight, o = r.current
    if (t && !(o <= 0)) {
      let l = btoa(JSON.stringify({ f: o, v: 1, w: a, hgt: n, p: +!!s.current }))
      sessionStorage.setItem(nN, l); sessionStorage.setItem(nB, "1"); i()
    }
  }
→ 凭证 = base64(JSON.stringify({f:帧计数, v:1, w:视口宽, hgt:视口高, p:是否检测到指针移动}))
`)
  const mk = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
  const ctxVariants = [
    ['无 X-Play-Ctx（应用当前行为）', {}],
    ['伪造 {f:1,v:1,w:1280,hgt:720,p:1}', { 'X-Play-Ctx': mk({ f: 1, v: 1, w: 1280, hgt: 720, p: 1 }) }],
    ['伪造 {f:120,v:1,w:1280,hgt:720,p:1}', { 'X-Play-Ctx': mk({ f: 120, v: 1, w: 1280, hgt: 720, p: 1 }) }],
    ['伪造 {f:600,v:1,w:1920,hgt:1080,p:1}', { 'X-Play-Ctx': mk({ f: 600, v: 1, w: 1920, hgt: 1080, p: 1 }) }],
    ['伪造 + Referer/Origin', {
      'X-Play-Ctx': mk({ f: 300, v: 1, w: 1280, hgt: 720, p: 1 }),
      Referer: rulePlayUrl,
      Origin: BASE
    }],
    ['随便一个 base64', { 'X-Play-Ctx': Buffer.from('hello').toString('base64') }]
  ]
  for (const [label, h] of ctxVariants) {
    const r = await get(rp, h)
    if (!r.ok) {
      console.log(`\n${label} → 失败 ${r.err}`)
      continue
    }
    const b = bodyOf(r.res)
    console.log(`\n${label}\n  → HTTP ${r.res.status} ${b.length}B ${r.res.headers['content-type']}`)
    console.log('  body: ' + short(b.replace(/\s+/g, ' '), 500))
  }

  // ---------------------------------------------------------------- 5d. 其它视频的 url 字段分布
  hr('5d) 其它番剧的 episodes[*].url 分布（看是否存在非 protected 的直链）')
  const listRes = await get(`${BASE}/api/videos/?pageSize=8`)
  const listJson = parseJson(bodyOf(listRes.res))
  const listVideos = listJson?.data?.videos || listJson?.data || []
  const checked = (Array.isArray(listVideos) ? listVideos : []).slice(0, 6)
  for (const lv of checked) {
    if (!lv?.id) continue
    const dr = await get(`${BASE}/api/videos/${lv.id}`)
    const dj = parseJson(bodyOf(dr.res))
    const ps = dj?.data?.playSources || []
    const urls = uniq(ps.flatMap((p) => (p.episodes || []).map((e) => e.url)))
    console.log(
      `\n  ${lv.name} (id=${lv.id}) lines=${ps.length} ` +
        `url 取值=${JSON.stringify(urls.map((u) => (u && u.length > 60 ? u.slice(0, 60) + '…' : u)))} ` +
        `openlistPath=${JSON.stringify(ps.map((p) => p.openlistPath))}`
    )
  }

  // ---------------------------------------------------------------- 5e. 播放页 Set-Cookie / 挑战串
  hr('5e) 播放页是否下发 Cookie / 挑战串（判断凭证能否离线伪造）')
  const pr = await get(rulePlayUrl, { Accept: 'text/html' })
  console.log('播放页响应头：')
  Object.entries(pr.res?.headers || {}).forEach(([k, v]) => console.log(`  ${k}: ${short(v, 160)}`))
  const phtml = bodyOf(pr.res)
  const tokenish = uniq(
    (phtml.match(/(?:nonce|token|challenge|sign|sig|ctx|credential)[^,;"'<>\s]{0,60}/gi) || []).map((x) =>
      x.slice(0, 80)
    )
  )
  console.log('\nHTML 中疑似挑战串（前 20 条）：')
  tokenish.slice(0, 20).forEach((t) => console.log('  ' + t))

  // ---------------------------------------------------------------- 5f. 播放器 UI 关键逻辑原文
  hr('5f) 播放器 chunk 中「取流 → 播放」关键逻辑原文（用于确认是否必须真实点击）')
  const playerChunk = scripts.find((u) => /a880b2746a117d27/.test(u)) || scripts[scripts.length - 1]
  const pc = await get(playerChunk, { Accept: '*/*' })
  const pcode = bodyOf(pc.res)
  console.log('chunk: ' + playerChunk + '  (' + pcode.length + 'B)')
  for (const [label, from, to] of [
    ['凭证 + 手势（nj/nG）', 741300, 743600],
    ['nq 渲染：手势是否门控取流', 743600, 744760],
    ['取流 hook（n$/resolve-play-url）', 744760, 747400]
  ]) {
    console.log(`\n--- ${label} [${from}..${to}] ---`)
    console.log(pcode.slice(from, to).replace(/\s+/g, ' '))
  }
  console.log('\n--- 全文里所有 nG / nB / tvt-play-gesture 的出现位置 ---')
  for (const tok of ['nG,', 'nB)', 'tvt-play-gesture', 'isTrusted']) {
    let idx = -1
    while ((idx = pcode.indexOf(tok, idx + 1)) >= 0) {
      console.log(`  [${tok}] @${idx}: ` + short(pcode.slice(Math.max(0, idx - 160), idx + 160).replace(/\s+/g, ' '), 330))
    }
  }

  // ---------------------------------------------------------------- 5g. source/episode 参数语义
  hr('5g) 播放页 source / episode 参数语义（规则 playQuery 是否拼对）')
  console.log(`线路列表：${playSources.map((p, i) => `[${i}] ${p.name} fromCode=${p.fromCode} id=${p.id}`).join('\n           ')}`)
  for (const q of ['source=0&episode=0', 'source=1&episode=0', 'source=source-1&episode=0', `source=${playSources[0]?.id}&episode=0`]) {
    const u = `${BASE}/video/${slug}/play?${q}`
    const r = await get(u)
    const b = bodyOf(r.res)
    // 找被标为选中的线路按钮（class 含 primary）与集数按钮
    const activeLine = (b.match(/title="(线路[A-Z])"[^>]*class="([^"]*)"/g) || []).concat(
      b.match(/class="([^"]*primary[^"]*)"[^>]*title="(线路[A-Z])"/g) || []
    )
    const lines = [...b.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).slice(0, 8)
    console.log(`\nGET ${u}\n  → HTTP ${r.res.status} ${b.length}B`)
    console.log('  含「线路A/B/D」的按钮片段: ' + short((b.match(/[^>]{0,120}线路[ABD][^<]{0,40}/g) || []).slice(0, 3).join(' || '), 400))
  }
  console.log('\n站点自己的播放页链接格式（从详情页 /video/<slug> 里找 href）：')
  const detailPage = await get(`${BASE}/video/${slug}`, { Accept: 'text/html' })
  const dhtml = bodyOf(detailPage.res)
  const hrefs = uniq(
    (dhtml.match(/\/video\/[^"'\\\s<]*play[^"'\\\s<]*/g) || []).map((h) => h.replace(/\\u0026/g, '&'))
  )
  console.log(`  详情页 HTTP ${detailPage.res?.status} ${dhtml.length}B`)
  hrefs.slice(0, 12).forEach((h) => console.log('  ' + h))
  if (!hrefs.length) console.log('  （详情页 HTML 里没有 play 链接，说明是客户端路由跳转）')
  // 客户端路由跳转的写法：找 router.push 附近的 source/episode
  console.log('\n全站 chunk 中所有 searchParams.get("…") 读取的参数名：')
  const paramNames = new Map()
  for (const js of scripts) {
    const r = await get(js, { Accept: '*/*' })
    if (!r.ok) continue
    const code = bodyOf(r.res)
    for (const re of [/\.get\("([a-zA-Z_][a-zA-Z0-9_]*)"\)/g, /searchParams\["([a-zA-Z_]+)"\]/g]) {
      let m
      while ((m = re.exec(code))) {
        const k = m[1]
        if (!paramNames.has(k)) paramNames.set(k, js.split('/').pop())
      }
    }
  }
  console.log('  ' + [...paramNames.entries()].map(([k, f]) => `${k}(${f})`).join(', '))
  console.log('\n在 chunk 中查找 tvt-play-gesture / sessionStorage 的写入点：')
  for (const js of scripts) {
    const r = await get(js, { Accept: '*/*' })
    if (!r.ok) continue
    const code = bodyOf(r.res)
    for (const tok of ['tvt-play-gesture', 'sessionStorage.setItem']) {
      let idx = -1
      let n = 0
      while ((idx = code.indexOf(tok, idx + 1)) >= 0 && n < 3) {
        n++
        console.log(
          `  [${js.split('/').pop()} ${tok}] @${idx}: ` +
            short(code.slice(Math.max(0, idx - 220), idx + 220).replace(/\s+/g, ' '), 460)
        )
      }
    }
  }

  // ---------------------------------------------------------------- 5h. Cookie + 伪造凭证
  hr('5h) 带播放页下发的 tvt-pt Cookie + 伪造凭证（判断服务端到底校验什么）')
  const p2 = await get(rulePlayUrl, { Accept: 'text/html' })
  const setCookie = (p2.res?.headers?.['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')
  console.log('播放页 set-cookie → ' + setCookie)
  const combos2 = [
    ['Cookie(tvt-pt) 单独', { Cookie: setCookie }],
    ['Cookie + 无 X-Play-Ctx 之外的真实头', { Cookie: setCookie, 'X-Play-Ctx': '' }],
    ['Cookie + 伪造 ctx {f:60,...}', {
      Cookie: setCookie,
      'X-Play-Ctx': mk({ f: 60, v: 1, w: 1280, hgt: 720, p: 1 })
    }],
    ['Cookie + 伪造 ctx + Referer/Origin', {
      Cookie: setCookie,
      'X-Play-Ctx': mk({ f: 60, v: 1, w: 1280, hgt: 720, p: 1 }),
      Referer: rulePlayUrl,
      Origin: BASE,
      Accept: 'application/json'
    }],
    ['Cookie + 空 base64 ctx', { Cookie: setCookie, 'X-Play-Ctx': mk({}) }]
  ]
  for (const [label, h] of combos2) {
    const r = await get(rp, h)
    if (!r.ok) {
      console.log(`\n${label} → 失败 ${r.err}`)
      continue
    }
    const b = bodyOf(r.res)
    console.log(`\n${label}\n  → HTTP ${r.res.status} ${b.length}B ${r.res.headers['content-type']}`)
    console.log('  body: ' + short(b.replace(/\s+/g, ' '), 600))
  }

  // ---------------------------------------------------------------- 5i. 解析出的真实流 + 可播性
  hr('5i) 用 Cookie 解析真实流地址，并验证可播性 / 防盗链')
  for (let i = 0; i < 3; i++) {
    const r = await get(rp, { Cookie: setCookie })
    console.log(
      `  第 ${i + 1} 次「只带 tvt-pt Cookie、不带 X-Play-Ctx」→ HTTP ${r.res?.status}  ` +
        short(bodyOf(r.res).replace(/\s+/g, ' '), 200)
    )
    if (i === 0 && r.res?.status === 200) {
      const j = parseJson(bodyOf(r.res))
      console.log('  （由解析结果反推：服务端其实只校验 tvt-pt Cookie，X-Play-Ctx 不是必需的）')
      var streamData = j?.data
    }
  }
  const stream = streamData?.url
  if (stream) {
    const ref = streamData?.headers?.Referer
    console.log('\n解析出的媒体地址: ' + stream)
    console.log('服务端要求的 Referer: ' + ref)
    console.log('（type=' + streamData.type + ', source=' + streamData.source + '）')
    for (const [label, h] of [
      ['无 Referer', {}],
      ['带服务端给的 Referer', ref ? { Referer: ref } : {}],
      ['带站点 Referer', { Referer: `${BASE}/` }]
    ]) {
      const started = Date.now()
      try {
        // 只要前 64KB 就够判断可播性；该 CDN 会忽略 Range，因此读到首块立即断开，
        // 避免为验证而下 700MB 整片。
        const res = await axios.get(stream, {
          headers: { 'User-Agent': UA, Range: 'bytes=0-65535', ...h },
          responseType: 'stream',
          validateStatus: () => true,
          maxRedirects: 5,
          timeout: 20000
        })
        const first = await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('首块超时')), 15000)
          res.data.once('data', (chunk) => {
            clearTimeout(t)
            resolve(chunk)
          })
          res.data.once('error', (e) => {
            clearTimeout(t)
            reject(e)
          })
        })
        try {
          res.data.destroy()
        } catch {
          /* ignore */
        }
        const head = Buffer.from(first).slice(0, 16)
        const isMp4 = head.slice(4, 8).toString('ascii') === 'ftyp'
        console.log(
          `  ${label}: HTTP ${res.status} ct=${res.headers['content-type']} clen=${res.headers['content-length']} ` +
            `首块=${Buffer.from(first).length}B ${Date.now() - started}ms head=${JSON.stringify(head.toString('latin1'))}` +
            `${isMp4 ? '  ← 确认是 MP4 (ftyp)' : ''}`
        )
      } catch (e) {
        console.log(`  ${label}: 失败 ${e.message}`)
      }
    }
  } else {
    console.log('（未取到流地址）')
  }

  // ---------------------------------------------------------------- 6. 媒体可播性
  hr('6) 发现的媒体地址可播性探测（含 Referer 依赖）')
  const media = uniq(state.mediaHits)
  if (!media.length) {
    console.log('未在 HTML / JS 静态文本中找到任何 m3u8/mp4 地址')
    console.log('→ 结论倾向：地址必须由播放页 JS 运行时向后端请求后才拿到（静态抓取与预先嗅探都拿不到）')
  }
  for (const u of media.slice(0, 6)) {
    for (const ref of [undefined, `${BASE}/`]) {
      const started = Date.now()
      try {
        const res = await axios.get(u, {
          headers: { 'User-Agent': UA, ...(ref ? { Referer: ref } : {}) },
          responseType: 'arraybuffer',
          validateStatus: () => true,
          maxRedirects: 5,
          timeout: 15000
        })
        const buf = Buffer.from(res.data || [])
        console.log(
          `\n${short(u, 130)}\n  Referer=${ref || '(无)'} → HTTP ${res.status} ct=${res.headers['content-type']} bytes=${buf.length} ${Date.now() - started}ms\n  head: ${short(buf.slice(0, 160).toString('utf8').replace(/\s+/g, ' '), 200)}`
        )
      } catch (e) {
        console.log(`\n${short(u, 130)}\n  Referer=${ref || '(无)'} → 失败 ${e.message}`)
      }
    }
  }

  hr('摘要')
  console.log(
    JSON.stringify(
      {
        searchOk: true,
        videoId: first.id,
        slug,
        playSourceNames: playSources.map((p) => p.name),
        episodeUrlField: playSources[0]?.episodes?.[0]?.url,
        playPageUrl: rulePlayUrl,
        playPageBytes: pageHtml.length,
        apiPathsInHtml: apisInHtml,
        mediaHitsInStaticText: media,
        snippetEndpoints: uniq(state.endpoints).slice(0, 40)
      },
      null,
      2
    )
  )
})().catch((e) => {
  console.error('脚本异常:', e)
  process.exit(1)
})

/**
 * 自建反代链路自检（v0.2.4 紧急更新）
 *
 * 作用：不依赖真实的 Cloudflare Worker，就能验证「应用是否真的把自建反代当作
 * 最高优先级 API 数据源」——这在公共镜像全灭、只能自建反代时是最关键的一条链路。
 *
 * 做法：
 *   1. 本机起一个假的「反代」HTTP 服务，实现 Worker 同款路径（/v0/calendar、/v0/subjects/:id、/v0/search/subjects、/__health）；
 *   2. 把设置的 bangumiCustomApi 指向它，并把公共镜像写成必失败的域名（证明数据只可能来自反代）；
 *   3. 用 SAKANA_SMOKE 启动应用，检查日志是否出现「番剧表已更新」而不是「所有 bangumi 镜像均不可访问」；
 *   4. 结束后恢复用户原本的设置，并打印结论。
 *
 * 用法：node scripts/diag-custom-mirror.js
 */
const http = require('node:http')
const { spawn } = require('node:child_process')
const { readFileSync, writeFileSync, existsSync, copyFileSync } = require('node:fs')
const { join } = require('node:path')

const appData = process.env.APPDATA || ''
const settingsPath = join(appData, 'sakana', 'data', 'settings.json')
const logsPath = join(appData, 'sakana', 'data', 'logs.json')
const PORT = 18923
const BASE = `http://127.0.0.1:${PORT}`

/** 假反代：只需要让应用能拿到合法的 v0 JSON 即可 */
function startMock() {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (req.url.startsWith('/v0/calendar')) {
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((weekday, i) => ({
        weekday: { en: weekday, cn: `周${i + 1}`, ja: weekday },
        items: [
          {
            id: 400000 + i,
            name: `Mock Anime ${i + 1}`,
            name_cn: `模拟番剧 ${i + 1}`,
            air_date: '2026-09-14',
            air_weekday: i + 1,
            images: { large: 'https://lain.bgm.tv/pic/cover/l/mock.jpg', common: '', medium: '', small: '', grid: '' },
            rating: { score: 7.5, total: 100 },
            rank: 100 + i
          }
        ]
      }))
      res.end(JSON.stringify(days))
      return
    }
    if (req.url.startsWith('/v0/subjects/')) {
      res.end(JSON.stringify({ id: 1, name: 'Mock', name_cn: '模拟', images: {}, rating: {}, tags: [] }))
      return
    }
    if (req.url.startsWith('/v0/search/subjects')) {
      res.end(JSON.stringify({ data: [] }))
      return
    }
    if (req.url === '/__health') {
      res.end(JSON.stringify({ role: 'api', upstream: 'api.bgm.tv' }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve({ server, hits })))
}

async function main() {
  if (!existsSync(settingsPath)) {
    console.error(`找不到设置文件：${settingsPath}（先启动一次应用）`)
    process.exit(1)
  }
  const backupPath = `${settingsPath}.diag-backup`
  copyFileSync(settingsPath, backupPath)
  const original = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  const { server, hits } = await startMock()
  console.log(`[mock] 假反代已启动：${BASE}`)

  // 公共镜像写成必失败地址：只要应用还显示「番剧表已更新」，就证明数据来自自建反代
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        ...original,
        bangumiCustomApi: BASE,
        bangumiBase: 'http://127.0.0.1:1',
        bangumiMirrors: ['http://127.0.0.1:1'],
        dataSources: { main: BASE, mirrors: [BASE, 'http://127.0.0.1:1'] }
      },
      null,
      2
    ),
    'utf-8'
  )
  console.log('[mock] 已把 bangumiCustomApi 指向假反代，公共镜像指向必失败地址')

  let child = null
  let ok = false
  const startedAt = Date.now()
  try {
    // 用 spawn + stdio:ignore：应用是 GUI 程序，抓它的 stdout 不可靠；
    // 判定改为「反代是否收到请求」+「应用日志里是否记录了成功」两条独立证据。
    child = spawn('node_modules\\.bin\\electron.cmd', ['.'], {
      env: { ...process.env, SAKANA_SMOKE: '1', SAKANA_SMOKE_MS: '14000' },
      stdio: 'ignore',
      shell: true
    })

    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      await sleep(1000)
      if (readCalendarCache(startedAt)) break
    }
    const requested = hits.filter((u) => u.startsWith('/v0/'))
    /*
     * 判据（三条独立证据，全部基于磁盘/网络事实，不受日志延迟落盘影响）：
     *  1. 假反代确实收到了 /v0/calendar 请求；
     *  2. 应用把自己的日历缓存**用这一轮的数据**覆盖了（缓存里的 fetchedAt ≥ 本轮开始时间）；
     *  3. 缓存内容就是假反代返回的「模拟番剧」（说明 JSON 被正确解析，而不是按网页 HTML 解析）。
     */
    const cached = readCalendarCache(startedAt)
    ok = hits.some((u) => u.startsWith('/v0/calendar')) && !!cached
    console.log(`\n[mock] 反代收到的请求：${requested.slice(0, 8).join(', ') || '(无)'}`)
    console.log(`  应用日历缓存：${cached ? `已用本轮数据刷新（${cached}）` : '未刷新'}`)
    for (const l of readCalendarLogs(startedAt).slice(-4)) console.log(`  应用日志: ${l}`)
    console.log(
      `\n结论：${ok ? '✅ 自建反代链路可用（应用把它当作了最高优先级 API 数据源，并按 v0 JSON 正确解析）' : '❌ 自建反代未被使用，请检查'}` 
    )
  } finally {
    try {
      child?.kill()
    } catch {
      /* ignore */
    }
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf-8')
    console.log('[mock] 已恢复原设置')
    server.close()
  }
  process.exit(ok ? 0 : 1)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 读取应用写下的日历缓存，判断它是否被本轮数据刷新过。
 * 返回 null 表示没刷新；否则返回一句人可读的说明（含条目数）。
 */
function readCalendarCache(since) {
  const candidates = [
    join(appData, 'sakana', 'cache', 'bangumi', 'calendar.json'),
    join(appData, 'sakana', 'data', 'cache', 'bangumi', 'calendar.json')
  ]
  for (const f of candidates) {
    try {
      if (!existsSync(f)) continue
      const json = JSON.parse(readFileSync(f, 'utf-8'))
      if (Number(json?.fetchedAt ?? 0) < since) continue
      const text = JSON.stringify(json.data ?? [])
      if (!text.includes('模拟番剧')) continue
      const days = Array.isArray(json.data) ? json.data.length : 0
      return `${days} 天 / 含假反代的模拟条目`
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  return null
}

/** 读取应用日志里与番剧表/镜像相关的最近记录 */
function readCalendarLogs(startedAt) {
  try {
    const list = JSON.parse(readFileSync(logsPath, 'utf-8'))
    if (!Array.isArray(list)) return []
    return list
      .slice(-40)
      .filter((e) => e && Number(e.at ?? 0) >= since && typeof e.message === 'string' && /番剧表|bangumi|镜像/.test(e.message))
      .map((e) => `[${e.source}] ${e.message}`)
  } catch {
    return []
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

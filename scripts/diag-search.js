const https = require('https')
const http = require('http')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const KW = process.argv[2] || '败犬女主太多了'
const BASE = 'https://raw.githubusercontent.com/Predidit/KazumiRules/main'

function get(url, extraHeaders, redirects = 4) {
  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*', ...(extraHeaders || {}) },
        timeout: 20000
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume()
          const next = new URL(res.headers.location, url).toString()
          return resolve(get(next, extraHeaders, redirects - 1))
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers })
        )
      }
    )
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message, headers: {} }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, body: 'TIMEOUT', headers: {} })
    })
    req.end()
  })
}

const RULES = ['mgnacg', 'mutefun', 'baimao', 'AGE', 'akianime', 'mxdm']

;(async () => {
  for (const name of RULES) {
    const r = await get(`${BASE}/${name}.json`)
    let j
    try {
      j = JSON.parse(r.body)
    } catch {
      console.log(`${name}: 规则读取失败 ${r.status}`)
      continue
    }
    const searchUrl = String(j.searchURL || '').replace('@keyword', encodeURIComponent(KW))
    console.log(`\n=== ${name} ===`)
    console.log(`  baseURL=${j.baseURL} usePost=${j.usePost} ua=${j.userAgent || '(默认)'}`)
    console.log(`  searchURL=${searchUrl}`)
    const t0 = Date.now()
    const page = await get(searchUrl, j.userAgent ? { 'User-Agent': j.userAgent } : undefined)
    const ms = Date.now() - t0
    const hasKw = page.body.includes(KW)
    const cf = /cloudflare|cf-browser-verification|Just a moment|challenge-platform/i.test(page.body)
    console.log(`  → HTTP ${page.status} ${page.body.length}B ${ms}ms  含关键词=${hasKw}  疑似Cloudflare=${cf}`)
    const title = (page.body.match(/<title>([^<]*)<\/title>/i) || [])[1]
    if (title) console.log(`  title: ${title.slice(0, 80)}`)
    if (page.status !== 200) console.log(`  body: ${page.body.slice(0, 160).replace(/\s+/g, ' ')}`)
  }
})()

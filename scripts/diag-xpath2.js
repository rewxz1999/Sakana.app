const https = require('https')
const xpathHtml = require('xpath-html')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const KW = '败犬女主太多了'
const BASE = 'https://raw.githubusercontent.com/Predidit/KazumiRules/main'

function get(url, headers, redirects = 5) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, ...(headers || {}) }, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume()
        return resolve(get(new URL(res.headers.location, url).toString(), headers, redirects - 1))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, body: 'TIMEOUT' })
    })
  })
}

// 与应用 rules.ts 完全一致的命名空间处理
function enhance(expr) {
  return expr.replace(/(^|[/.])([a-zA-Z][a-zA-Z0-9_-]*)(?=\s*\[|$|\/)/g, (m, p1, p2) =>
    p2 === 'x' ? m : `${p1}x:${p2}`
  )
}

;(async () => {
  for (const name of ['baimao', 'AGE', 'akianime']) {
    const j = JSON.parse((await get(`${BASE}/${name}.json`)).body)
    const searchUrl = String(j.searchURL).replace('@keyword', encodeURIComponent(KW))
    const page = await get(searchUrl, j.userAgent ? { 'User-Agent': j.userAgent } : undefined)
    console.log(`\n=== ${name} (HTTP ${page.status}, ${page.body.length}B) ===`)
    const doc = xpathHtml.fromPageSource(page.body)
    const items = doc.findElements(j.searchList)
    console.log(`  searchList → ${items.length} 个条目`)
    if (!items.length) continue
    const item = items[0]
    for (const expr of [j.searchName, j.searchResult]) {
      let asIs = 0
      let rel = 0
      let relText = ''
      try {
        const r1 = doc.select(enhance(expr), item, false)
        asIs = Array.isArray(r1) ? r1.length : r1 ? 1 : 0
      } catch (e) {
        asIs = -1
      }
      try {
        const relExpr = expr.startsWith('//') ? '.' + expr : expr
        const r2 = doc.select(enhance(relExpr), item, false)
        rel = Array.isArray(r2) ? r2.length : r2 ? 1 : 0
        const first = Array.isArray(r2) ? r2[0] : r2
        if (first) {
          const n = first
          relText = (n.textContent || n.nodeValue || '').replace(/\s+/g, ' ').trim().slice(0, 60)
        }
      } catch (e) {
        rel = -1
      }
      console.log(`  ${expr}:  原样=${asIs}  加 . 前缀=${rel}  ${relText ? `文本「${relText}」` : ''}`)
    }
  }
})()

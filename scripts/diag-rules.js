const https = require('https')

function get(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': 'Sakana/0.1.4' }, timeout: 20000 }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => resolve({ status: r.statusCode, body: d }))
      })
      .on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }))
  })
}

const BASE = 'https://raw.githubusercontent.com/Predidit/KazumiRules/main'

;(async () => {
  const idx = await get(`${BASE}/index.json`)
  const arr = JSON.parse(idx.body)
  for (const item of arr) {
    console.log(`- ${item.name} v${item.version} ${item.useNativePlayer ? '[native]' : '[webview]'}`)
  }
  console.log('\n=== 抓取 moonci / aafun / 7sefun 规则 ===')
  for (const name of ['moonci', 'aafun', '7sefun']) {
    const r = await get(`${BASE}/${name}.json`)
    console.log(`\n--- ${name}.json (HTTP ${r.status}, ${r.body.length} bytes) ---`)
    try {
      const j = JSON.parse(r.body)
      console.log(JSON.stringify(j, null, 1).slice(0, 1600))
    } catch (e) {
      console.log('解析失败:', r.body.slice(0, 300))
    }
  }
})()

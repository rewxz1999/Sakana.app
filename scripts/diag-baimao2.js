const https = require('https')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function get(url, redirects = 5) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, timeout: 20000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume()
          return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1))
        }
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => resolve({ status: res.statusCode, body: d }))
      })
      .on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }))
  })
}

function summarize(html, label) {
  console.log(`\n===== ${label} =====`)
  const cls = {}
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) cls[c] = (cls[c] || 0) + 1
  }
  console.log('classes:', Object.entries(cls).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k}(${v})`).join(' '))
  const ids = {}
  for (const m of html.matchAll(/id="([^"]+)"/g)) ids[m[1]] = (ids[m[1]] || 0) + 1
  console.log('ids:', Object.entries(ids).slice(0, 20).map(([k, v]) => `${k}(${v})`).join(' '))
}

;(async () => {
  const rule = JSON.parse((await get('https://raw.githubusercontent.com/Predidit/KazumiRules/main/baimao.json')).body)
  console.log('=== 仓库 baimao 规则 ===')
  console.log(JSON.stringify(rule, null, 1))

  const show = await get('https://www.baimaodm.com/show/464376.html')
  console.log(`\n详情页 HTTP ${show.status} ${show.body.length}B`)
  summarize(show.body, '详情页结构')
  // 播放链接（剧集）片段
  const playLinks = show.body.match(/<a\b[^>]*href="[^"]*\/play\/[^"]*"[^>]*>[\s\S]{0,60}?<\/a>/gi) || []
  console.log('\n播放链接样例（前 6）：')
  playLinks.slice(0, 6).forEach((l) => console.log('  ' + l.replace(/\s+/g, ' ').slice(0, 170)))
  const idx = show.body.indexOf('/play/')
  if (idx > 0) {
    console.log('\n播放链接上下文：')
    console.log('  ' + show.body.slice(Math.max(0, idx - 500), idx + 200).replace(/\s+/g, ' '))
  }
})()

const https = require('https')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const URL_ = process.argv[2] || 'https://www.baimaodm.com/s_all?ex=1&kw=%E8%B4%A5%E7%8A%AC%E5%A5%B3%E4%B8%BB%E5%A4%AA%E5%A4%9A%E4%BA%86'

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

;(async () => {
  const r = await get(URL_)
  const d = r.body
  console.log('HTTP', r.status, d.length, 'bytes')
  const idx = d.indexOf('败犬女主太多了')
  if (idx >= 0) {
    console.log('\n--- 关键词附近片段 ---')
    console.log(d.slice(Math.max(0, idx - 700), idx + 300).replace(/\s+/g, ' '))
  }
  console.log('\n--- 所有 a 标签（前 20 个）---')
  const links = d.match(/<a\b[^>]*>[\s\S]{0,80}?<\/a>/gi) || []
  links.slice(0, 20).forEach((l, i) => console.log(`${i}: ${l.replace(/\s+/g, ' ').slice(0, 150)}`))
  console.log('\n--- class 名统计（前 25）---')
  const cls = {}
  for (const m of d.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) cls[c] = (cls[c] || 0) + 1
  }
  console.log(
    Object.entries(cls)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([k, v]) => `${k}(${v})`)
      .join(' ')
  )
})()

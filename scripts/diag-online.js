const https = require('https')
const http = require('http')

const URLS = [
  'https://apn.moedot.net/d/wo/2407/%E8%B4%A5%E5%8C%9701z.mp4',
  'https://apn.moedot.net/d/wo/2407/败犬01z.mp4'
]

function probe(url, referer, method = 'GET') {
  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Range: 'bytes=0-1023'
    }
    if (referer) headers.Referer = referer
    const req = mod.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 15000 },
      (res) => {
        const info = {
          status: res.statusCode,
          type: res.headers['content-type'],
          len: res.headers['content-length'],
          range: res.headers['content-range'],
          server: res.headers['server']
        }
        res.destroy()
        resolve({ url: url.slice(0, 70), referer: referer || '(none)', method, ...info })
      }
    )
    req.on('error', (e) => resolve({ url: url.slice(0, 70), referer: referer || '(none)', method, error: e.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ url: url.slice(0, 70), referer: referer || '(none)', method, error: 'timeout' })
    })
    req.end()
  })
}

function fetchJson(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': 'Sakana/0.1.4' }, timeout: 15000 }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => resolve({ status: r.statusCode, body: d }))
      })
      .on('error', (e) => resolve({ status: 0, body: '', error: e.message }))
  })
}

;(async () => {
  console.log('=== 直出地址 HTTP 行为 ===')
  for (const u of URLS) {
    for (const ref of [undefined, 'https://www.moonci.com/', 'https://www.moonci.com/anime/874/play/1-1.html']) {
      const r = await probe(u, ref)
      console.log(JSON.stringify(r))
    }
  }
  console.log('=== KazumiRules 仓库索引 ===')
  const idx = await fetchJson('https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json')
  console.log('index.json status:', idx.status, 'len:', idx.body.length)
  try {
    const arr = JSON.parse(idx.body)
    console.log('规则数:', Array.isArray(arr) ? arr.length : 'not array')
    if (Array.isArray(arr)) {
      console.log('样本:', arr.slice(0, 6).map((r) => `${r.name}(${r.version})`).join(', '))
      const moon = arr.filter((r) => /月之祠|moonci|aafun|TvT|AGE|7se/i.test(JSON.stringify(r)))
      console.log('相关规则:', moon.map((r) => r.name).join(', ') || '无')
    }
  } catch (e) {
    console.log('解析失败:', e.message, idx.body.slice(0, 200))
  }
})()

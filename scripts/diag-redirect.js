const https = require('https')

function follow(url, referer, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 6) return resolve({ error: 'too many redirects' })
    const u = new URL(url)
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Range: 'bytes=0-2047'
    }
    if (referer) headers.Referer = referer
    https
      .get({ hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 20000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const next = new URL(res.headers.location, url).toString()
          console.log(`  ${res.statusCode} → ${next.slice(0, 120)}`)
          res.destroy()
          resolve(follow(next, referer, depth + 1))
          return
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          resolve({
            status: res.statusCode,
            type: res.headers['content-type'],
            len: res.headers['content-length'],
            range: res.headers['content-range'],
            head: body.slice(0, 32).toString('hex'),
            ascii: body.slice(0, 120).toString('utf8').replace(/[^\x20-\x7e]/g, '.')
          })
        })
      })
      .on('error', (e) => resolve({ error: e.message }))
      .on('timeout', function () {
        this.destroy()
        resolve({ error: 'timeout' })
      })
  })
}

;(async () => {
  const url = 'https://apn.moedot.net/d/wo/2407/%E8%B4%A5%E5%8C%9701z.mp4'
  console.log('跟随重定向:', url)
  const r = await follow(url, 'https://www.moonci.com/')
  console.log('最终:', JSON.stringify(r).slice(0, 400))
})()

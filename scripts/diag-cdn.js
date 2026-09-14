const https = require('https')

const TARGET =
  'https://tjdownload.pan.wo.cn/openapi/download?fid=84ZWz_aoavJPZt6%2Bv6rjw9B9ioR225nwP54ViiRvU/C/huZaGlE5HQWHwbIvsmlWYEs8'

function req(url, headers, method = 'GET') {
  return new Promise((resolve) => {
    const u = new URL(url)
    const r = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 20000 },
      (res) => {
        const chunks = []
        let total = 0
        res.on('data', (c) => {
          total += c.length
          if (chunks.length < 3) chunks.push(c)
          if (total > 4096) res.destroy()
        })
        const finish = () =>
          resolve({
            status: res.statusCode,
            type: res.headers['content-type'],
            len: res.headers['content-length'],
            range: res.headers['content-range'],
            accept: res.headers['accept-ranges'],
            head: Buffer.concat(chunks).slice(0, 64).toString('utf8').replace(/[^\x20-\x7e]/g, '.')
          })
        res.on('end', finish)
        res.on('close', finish)
      }
    )
    r.on('error', (e) => resolve({ error: e.message }))
    r.on('timeout', () => {
      r.destroy()
      resolve({ error: 'timeout' })
    })
    r.end()
  })
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

;(async () => {
  const variants = [
    { name: '无 Range 无 Referer', headers: { 'User-Agent': UA } },
    { name: '无 Range 带 Referer(播放页)', headers: { 'User-Agent': UA, Referer: 'https://www.moonci.com/anime/874/play/1-1.html' } },
    { name: '带 Range 无 Referer', headers: { 'User-Agent': UA, Range: 'bytes=0-2047' } },
    { name: '无 Range 无 UA', headers: {} }
  ]
  for (const v of variants) {
    const r = await req(TARGET, v.headers)
    console.log(v.name, '→', JSON.stringify(r))
  }
  console.log('--- HEAD ---')
  console.log('HEAD →', JSON.stringify(await req(TARGET, { 'User-Agent': UA }, 'HEAD')))
})()

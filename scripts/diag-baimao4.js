const https = require('https')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function get(u, d = 5) {
  return new Promise((res) => {
    https
      .get(u, { headers: { 'User-Agent': UA, Accept: 'text/html', Referer: 'https://www.baimaodm.com/' }, timeout: 20000 }, (r) => {
        if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && d > 0) {
          r.resume()
          return res(get(new URL(r.headers.location, u).toString(), d - 1))
        }
        let s = ''
        r.on('data', (c) => (s += c))
        r.on('end', () => res({ st: r.statusCode, b: s }))
      })
      .on('error', (e) => res({ st: 0, b: 'ERR ' + e.message }))
  })
}

;(async () => {
  const r = await get('https://www.baimaodm.com/play/464376-0-0.html')
  console.log('播放页 HTTP', r.st, r.b.length, 'B')
  console.log('含 m3u8:', (r.b.match(/m3u8/g) || []).length)
  console.log('含 player_aaaa:', /player_aaaa/.test(r.b))
  const pa = r.b.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;)/)
  if (pa) console.log('player_aaaa:', pa[1].slice(0, 400))
  const m = r.b.match(/https?:\/\/[^"'\s\\]+\.(?:m3u8|mp4)[^"'\s\\]*/gi) || []
  console.log('直链:', Array.from(new Set(m)).slice(0, 5).join(' | ') || '(无)')
  const ifr = r.b.match(/<iframe[^>]*>/gi) || []
  console.log('iframe 数:', ifr.length, ifr.slice(0, 2).join(' | ').slice(0, 260))
  const scr = r.b.match(/<script[^>]*src=["'][^"']+["']/gi) || []
  console.log('外部脚本:', scr.slice(0, 8).map((s) => s.replace(/<script[^>]*src=/, '').slice(0, 70)).join(' | '))
  const idx = r.b.indexOf('m3u8')
  if (idx > 0) console.log('\nm3u8 上下文:', r.b.slice(Math.max(0, idx - 400), idx + 200).replace(/\s+/g, ' '))
})()

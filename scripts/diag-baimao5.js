const https = require('https')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function get(u, d = 4) {
  return new Promise((res) => {
    https
      .get(u, { headers: { 'User-Agent': UA, Accept: '*/*', Referer: 'https://www.baimaodm.com/play/464376-0-0.html' }, timeout: 20000 }, (r) => {
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
  for (const p of ['/hdst/js/pck.js?ver=186155', '/hdst/hm_js/hm_pck.js?ver=186155', '/hdst/hm_js/changes.js']) {
    const r = await get('https://www.baimaodm.com' + p)
    console.log(`\n===== ${p} (HTTP ${r.st}, ${r.b.length}B) =====`)
    const b = r.b
    const keys = ['hm_playfram', 'iframe', 'playfram', 'm3u8', 'parse', 'player_', 'src=', 'url', 'jiekou', 'jiexi']
    for (const k of keys) {
      const idx = b.indexOf(k)
      if (idx >= 0) {
        console.log(`  [${k}] …${b.slice(Math.max(0, idx - 120), idx + 200).replace(/\s+/g, ' ')}…`)
      }
    }
  }
})()

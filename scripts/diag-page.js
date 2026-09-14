const https = require('https')

function get(url, referer) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            Referer: referer || url
          }
        },
        (r) => {
          let d = ''
          r.on('data', (c) => (d += c))
          r.on('end', () => resolve({ status: r.statusCode, body: d, headers: r.headers }))
        }
      )
      .on('error', reject)
  })
}

const target = process.argv[2] || 'https://www.moonci.com/anime/874/play/1-1.html'
get(target, 'https://www.moonci.com/')
  .then((res) => {
    const d = res.body
    console.log('URL:', target)
    console.log('HTTP:', res.status, 'bytes:', d.length)
    console.log('iframes:', (d.match(/<iframe/gi) || []).length)
    console.log('m3u8 mentions:', (d.match(/m3u8/gi) || []).length)
    console.log('player mentions:', (d.match(/player/gi) || []).length)
    const iframes = d.match(/<iframe[^>]*>/gi) || []
    iframes.slice(0, 4).forEach((x) => console.log('IFRAME:', x.slice(0, 200)))
    const scripts = d.match(/<script[^>]*src=["'][^"']+["']/gi) || []
    console.log('external scripts:', scripts.length)
    scripts.slice(0, 6).forEach((s) => console.log('SCRIPT:', s.slice(0, 160)))
    const title = (d.match(/<title>([^<]*)<\/title>/i) || [])[1]
    console.log('title:', title)
  })
  .catch((e) => console.log('ERR:', e.message))

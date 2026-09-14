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
          r.on('end', () => resolve({ status: r.statusCode, body: d }))
        }
      )
      .on('error', reject)
  })
}

const url = process.argv[2]
get(url, 'https://' + new URL(url).host + '/').then((res) => {
  const d = res.body
  console.log('HTTP:', res.status, 'bytes:', d.length)
  const pa = d.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)
  if (pa) {
    console.log('player_aaaa:', pa[1].slice(0, 600))
  } else {
    const alt = d.match(/"url"\s*:\s*"([^"]+)"/)
    console.log('player_aaaa not found. url field:', alt ? alt[1] : 'none')
  }
  const parsers = d.match(/https?:\/\/[^"'\s]*\?url=/g) || []
  console.log('parse endpoints:', parsers.slice(0, 3))
  const direct = d.match(/https?:\\?\/\\?\/[^"'\s\\]+\.m3u8[^"'\s\\]*/g) || []
  console.log('direct m3u8 in HTML:', direct.slice(0, 3))
})

const https = require('https')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function decodeOuter(s) {
  let out = String(s).replace(/\\\//g, '/')
  for (let i = 0; i < 3; i++) {
    if (/^https?:\/\//i.test(out)) return out
    try {
      const d = decodeURIComponent(out)
      if (d === out) return out
      out = d
    } catch {
      return out
    }
  }
  return out
}

function freshDirectUrl() {
  return new Promise((resolve) => {
    https
      .get({ hostname: 'www.moonci.com', path: '/anime/874/play/1-1.html', headers: { 'User-Agent': UA } }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => {
          const m = d.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;)/)
          resolve(m ? decodeOuter(JSON.parse(m[1]).url) : null)
        })
      })
      .on('error', () => resolve(null))
  })
}

function fetchFollow(url, headers, label) {
  return new Promise((resolve) => {
    const u = new URL(url)
    https
      .get({ hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 20000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const next = new URL(res.headers.location, url).toString()
          res.resume()
          res.on('end', () => fetchFollow(next, headers, label).then(resolve))
          return
        }
        const size = Number(res.headers['content-length'] ?? 0)
        res.destroy()
        resolve(`${label} → ${res.statusCode} ${(res.headers['content-type'] || '').split(';')[0]} ${size}B`)
      })
      .on('error', (e) => resolve(`${label} → ERR ${e.message}`))
  })
}

/** 只编码 query 值里的保留字符（保持 %XX 不变） */
function encodeQueryReserved(url) {
  const u = new URL(url)
  const raw = u.search.slice(1)
  const out = raw
    .split('&')
    .map((pair) => {
      const i = pair.indexOf('=')
      if (i < 0) return pair
      const v = pair
        .slice(i + 1)
        .replace(/%(?![0-9a-fA-F]{2})/g, '%25')
        .replace(/\+/g, '%2B')
        .replace(/\//g, '%2F')
        .replace(/=/g, '%3D')
      return `${pair.slice(0, i)}=${v}`
    })
    .join('&')
  u.search = '?' + out
  return u.toString()
}

;(async () => {
  const direct = await freshDirectUrl()
  console.log('直出地址:', direct)
  const r0 = await fetchFollow(direct, { 'User-Agent': UA, Referer: 'https://www.moonci.com/', Range: 'bytes=0-1023' }, '原始(未编码)')
  console.log(r0)
  const enc = encodeQueryReserved(direct)
  console.log('编码后:', enc)
  const r1 = await fetchFollow(enc, { 'User-Agent': UA, Referer: 'https://www.moonci.com/', Range: 'bytes=0-1023' }, '编码保留字符')
  console.log(r1)
  // 无 Referer 的对照
  const r2 = await fetchFollow(enc, { 'User-Agent': UA, Range: 'bytes=0-1023' }, '编码且无 Referer')
  console.log(r2)
})()

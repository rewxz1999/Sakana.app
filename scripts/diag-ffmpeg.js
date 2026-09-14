const https = require('https')
const { spawn } = require('child_process')
const path = require('path')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const PLAY_PAGE = process.argv[2] || 'https://www.moonci.com/anime/874/play/1-1.html'
const FFMPEG = path.join(__dirname, '..', 'resources', 'ffmpeg', 'ffmpeg.exe')

function get(url, headers, raw = false) {
  return new Promise((resolve) => {
    const u = new URL(url)
    https
      .get({ hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 20000 }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: raw ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')
          })
        )
      })
      .on('error', (e) => resolve({ status: 0, error: e.message, headers: {}, body: '' }))
  })
}

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

function runFfmpeg(args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args, { windowsHide: true })
    let err = ''
    let outBytes = 0
    p.stderr.on('data', (d) => (err += d.toString()))
    p.stdout.on('data', (d) => (outBytes += d.length))
    const t = setTimeout(() => {
      p.kill()
      resolve({ timeout: true, outBytes, err: err.slice(-900) })
    }, timeoutMs)
    p.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, outBytes, err: err.slice(-900) })
    })
    p.on('error', (e) => {
      clearTimeout(t)
      resolve({ error: e.message })
    })
  })
}

;(async () => {
  console.log('=== 1) 打开播放页取直出地址 ===')
  const page = await get(PLAY_PAGE, { 'User-Agent': UA })
  console.log('播放页 HTTP', page.status, page.body.length, 'bytes')
  const pa = page.body.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;)/)
  if (!pa) return console.log('未找到 player_aaaa')
  const direct = decodeOuter(JSON.parse(pa[1]).url)
  console.log('直出地址:', direct)

  console.log('\n=== 2) 跟随跳转看最终响应 ===')
  const r = await get(direct, { 'User-Agent': UA, Referer: 'https://www.moonci.com/', Range: 'bytes=0-2047' }, true)
  console.log('状态:', r.status, '类型:', r.headers['content-type'], '长度:', r.headers['content-length'], 'Range:', r.headers['content-range'])
  const finalUrl = r.headers.location ? new URL(r.headers.location, direct).toString() : direct
  if (r.headers.location) console.log('302 →', finalUrl.slice(0, 130))

  console.log('\n=== 3) FFmpeg 直取（前 3 秒）===')
  const ff1 = await runFfmpeg([
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-user_agent', UA,
    '-headers', 'Referer: https://www.moonci.com/\r\n',
    '-t', '3', '-i', direct, '-f', 'null', '-'
  ])
  console.log('FFmpeg 直取结果:', JSON.stringify({ code: ff1.code, outBytes: ff1.outBytes, timeout: ff1.timeout }))
  console.log('FFmpeg stderr:', (ff1.err || '').replace(/\s+/g, ' ').slice(0, 600))
})()

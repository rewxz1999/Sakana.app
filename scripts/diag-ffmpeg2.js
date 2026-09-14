const https = require('https')
const { spawn } = require('child_process')
const path = require('path')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const PLAY_PAGE = 'https://www.moonci.com/anime/874/play/1-1.html'
const FFMPEG = path.join(__dirname, '..', 'resources', 'ffmpeg', 'ffmpeg.exe')

function get(url, headers) {
  return new Promise((resolve) => {
    const u = new URL(url)
    https
      .get({ hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 20000 }, (res) => {
        res.resume()
        resolve({ status: res.statusCode, type: res.headers['content-type'] })
      })
      .on('error', (e) => resolve({ status: 0, error: e.message }))
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

function runFfmpeg(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args, { windowsHide: true })
    let err = ''
    let outBytes = 0
    p.stderr.on('data', (d) => (err += d.toString()))
    p.stdout.on('data', (d) => (outBytes += d.length))
    const t = setTimeout(() => {
      p.kill()
      resolve({ timeout: true, outBytes, err: err.slice(-500) })
    }, timeoutMs)
    p.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, outBytes, err: err.slice(-500) })
    })
    p.on('error', (e) => {
      clearTimeout(t)
      resolve({ error: e.message })
    })
  })
}

function playPageUrl() {
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

;(async () => {
  const direct = await playPageUrl()
  console.log('直出地址:', direct)

  console.log('\n=== A) 请求头组合测试（Node）===')
  const combos = [
    { name: 'UA + Referer + Range: bytes=0-2047', h: { 'User-Agent': UA, Referer: 'https://www.moonci.com/', Range: 'bytes=0-2047' } },
    { name: 'UA + Referer + Range: bytes=0-（FFmpeg 风格）', h: { 'User-Agent': UA, Referer: 'https://www.moonci.com/', Range: 'bytes=0-' } },
    { name: 'UA + Range: bytes=0-', h: { 'User-Agent': UA, Range: 'bytes=0-' } },
    { name: 'UA 仅（无 Range）', h: { 'User-Agent': UA } },
    { name: 'UA + Referer（无 Range）', h: { 'User-Agent': UA, Referer: 'https://www.moonci.com/' } },
    { name: '无 UA + 无 Range', h: {} }
  ]
  for (const c of combos) {
    const r = await get(direct, c.h)
    console.log(`  ${c.name} → ${r.status} ${r.type || r.error || ''}`)
  }

  console.log('\n=== B) FFmpeg 变体测试（各取 3 秒）===')
  const variants = [
    { name: '默认（会发 Range）', args: ['-hide_banner', '-loglevel', 'warning', '-y', '-user_agent', UA, '-headers', 'Referer: https://www.moonci.com/\r\n', '-t', '3', '-i', direct, '-f', 'null', '-'] },
    { name: 'http_seekable=0（不发 Range）', args: ['-hide_banner', '-loglevel', 'warning', '-y', '-http_seekable', '0', '-user_agent', UA, '-headers', 'Referer: https://www.moonci.com/\r\n', '-t', '3', '-i', direct, '-f', 'null', '-'] },
    { name: '无 Referer + http_seekable=0', args: ['-hide_banner', '-loglevel', 'warning', '-y', '-http_seekable', '0', '-user_agent', UA, '-t', '3', '-i', direct, '-f', 'null', '-'] }
  ]
  for (const v of variants) {
    const r = await runFfmpeg(v.args)
    const tail = (r.err || '').replace(/\s+/g, ' ').slice(0, 260)
    console.log(`  ${v.name} → code=${r.code ?? 'timeout'} 输出=${r.outBytes}B ${tail.includes('400') ? '【400】' : ''}`)
    console.log(`     stderr: ${tail}`)
  }
})()

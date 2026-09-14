const https = require('https')
const { spawn } = require('child_process')
const path = require('path')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const FFMPEG = path.join(__dirname, '..', 'resources', 'ffmpeg', 'ffmpeg.exe')

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

function runFfmpeg(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args, { windowsHide: true })
    let err = ''
    let outBytes = 0
    p.stderr.on('data', (d) => (err += d.toString()))
    p.stdout.on('data', (d) => (outBytes += d.length))
    const t = setTimeout(() => {
      p.kill()
      resolve({ timeout: true, outBytes, err: err.slice(-400) })
    }, timeoutMs)
    p.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, outBytes, err: err.slice(-400) })
    })
    p.on('error', (e) => {
      clearTimeout(t)
      resolve({ error: e.message })
    })
  })
}

;(async () => {
  // 场景 1：拿到地址后【不做任何预校验】，直接交给 FFmpeg
  const u1 = await freshDirectUrl()
  console.log('场景1 直出地址:', u1)
  const r1 = await runFfmpeg([
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-user_agent', UA, '-headers', 'Referer: https://www.moonci.com/\r\n',
    '-t', '3', '-i', u1, '-c', 'copy', '-f', 'mpegts', 'pipe:1'
  ])
  console.log(
    `场景1 FFmpeg 首个客户端: code=${r1.code ?? 'timeout'} 输出=${r1.outBytes}B ${r1.outBytes > 0 ? '✅ 拿到数据' : '❌ 无数据'}`
  )
  console.log('   stderr:', (r1.err || '').replace(/\s+/g, ' ').slice(0, 300))

  // 场景 2：同一地址被 Node 先 HEAD 一次（模拟"预校验"），再交给 FFmpeg
  const u2 = await freshDirectUrl()
  console.log('\n场景2 直出地址（新 token）:', u2)
  await new Promise((resolve) => {
    const u = new URL(u2)
    https
      .request({ method: 'HEAD', hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': UA, Referer: 'https://www.moonci.com/' } }, (res) => {
        console.log('   预校验 HEAD →', res.statusCode, res.headers['content-type'])
        res.resume()
        res.on('end', resolve)
        setTimeout(resolve, 3000)
      })
      .on('error', () => resolve())
      .end()
  })
  const r2 = await runFfmpeg([
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-user_agent', UA, '-headers', 'Referer: https://www.moonci.com/\r\n',
    '-t', '3', '-i', u2, '-c', 'copy', '-f', 'mpegts', 'pipe:1'
  ])
  console.log(
    `场景2 预校验后的 FFmpeg: code=${r2.code ?? 'timeout'} 输出=${r2.outBytes}B ${r2.outBytes > 0 ? '✅ 拿到数据' : '❌ 无数据'}`
  )
  console.log('   stderr:', (r2.err || '').replace(/\s+/g, ' ').slice(0, 300))
})()

// 回显服务器：记录播放器真实发出的请求（供 libVLC / libmpv 请求头对照）
// 用法：node scripts/echo-server.js [port]   → 请求写入 .echo.log
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = Number(process.argv[2] || 18099)
const VIDEO = path.join(__dirname, '..', '.testmedia', 'sample.mp4')
const LOG = path.join(__dirname, '..', '.echo.log')

function log(line) {
  fs.appendFileSync(LOG, line + '\n', 'utf-8')
  console.log(line)
}

const server = http.createServer((req, res) => {
  const headers = Object.entries(req.headers)
    .filter(([k]) =>
      ['user-agent', 'referer', 'cookie', 'range', 'accept', 'accept-encoding', 'connection', 'host'].includes(k)
    )
    .map(([k, v]) => `${k}=${v}`)
    .join(' ; ')
  log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.url} | ${headers}`)

  const size = fs.statSync(VIDEO).size
  const range = req.headers.range
  const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null
  if (m) {
    const start = Number(m[1])
    const end = m[2] ? Number(m[2]) : size - 1
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    })
    fs.createReadStream(VIDEO, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(size), 'Accept-Ranges': 'bytes' })
  fs.createReadStream(VIDEO).pipe(res)
})

fs.writeFileSync(LOG, `echo server :${PORT} 启动\n`, 'utf-8')
server.listen(PORT, '127.0.0.1', () => console.log(`回显服务器 http://127.0.0.1:${PORT}/sample.mp4`))

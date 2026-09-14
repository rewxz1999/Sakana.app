// 诊断：libmpv 在 HTTP 请求里到底发了什么（URL 转义、UA、Referer/Cookie 头）
// 用本地回显服务器捕获真实请求，逐项与 libVLC 路径的参数对照。
const http = require('node:http')
const path = require('node:path')

const napi = require(path.join(__dirname, '..', 'native', 'mpv', 'build', 'Release', 'sakana_mpv.node'))
const DLL = path.join(__dirname, '..', 'resources', 'libmpv', 'libmpv-2.dll')

const seen = []
const server = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, headers: { ...req.headers } })
  // 返回一段假数据即可：我们只关心请求本身
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '2048' })
  res.end(Buffer.alloc(2048))
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一个用例：设置 header fields → 播放 → 打印服务器看到的请求 */
async function runCase(port, label, urlPath, headerFields) {
  seen.length = 0
  const opts = { vo: 'null', ao: 'null' }
  const ok = napi.create({ x: 0, y: 0, width: 320, height: 180, options: opts })
  if (!ok) {
    console.log(`\n### ${label}: 创建实例失败 → ${napi.lastError()}`)
    return
  }
  napi.setProperty('http-header-fields', headerFields ?? '')
  const url = `http://127.0.0.1:${port}${urlPath}`
  napi.command(['loadfile', url, 'replace'])
  for (let i = 0; i < 12 && seen.length === 0; i++) await sleep(250)
  console.log(`\n### ${label}`)
  console.log(`  交给 mpv 的 URL: ${url}`)
  console.log(`  http-header-fields: ${JSON.stringify(headerFields ?? '')}`)
  if (seen.length === 0) {
    console.log('  ❌ mpv 未发出任何请求')
  } else {
    for (const s of seen.slice(0, 3)) {
      console.log(`  → ${s.method} ${s.url}`)
      for (const k of ['user-agent', 'referer', 'cookie', 'range', 'accept', 'accept-encoding', 'connection']) {
        if (s.headers[k] !== undefined) console.log(`      ${k}: ${s.headers[k]}`)
      }
    }
  }
  napi.command(['stop'])
  napi.destroy()
  await sleep(400)
}

;(async () => {
  if (!napi.load(DLL)) {
    console.error('加载 libmpv 失败:', napi.lastError())
    process.exit(2)
  }
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  console.log(`回显服务器 127.0.0.1:${port}；libmpv ${napi.getProperty('mpv-version')}`)

  // A：encodeForVlc 产出的转义形态（fid 里带 %2F %2B %3D），不带头
  await runCase(port, 'A. 转义 URL + 不带头（当前 mpvPlay 在 ref/cookie 都为空时的行为）',
    '/openapi/download?fid=c59FI_nsf8uSa7tkzkq5HfdGtL06%2FTXa09W98%2FEEz8Nj09VifPqDPEJHXqCllIQ37R1cXL', '')

  // B：转义 URL + Referer/Cookie（当前 mpvPlay 有头时的拼接方式）
  await runCase(port, 'B. 转义 URL + Referer/Cookie（当前拼接方式）',
    '/openapi/download?fid=abc%2Fdef%2Bghi%3Djkl', 'Referer: https://www.moonci.com/,Cookie: sid=abc123')

  // C：转义 URL + 浏览器 UA
  await runCase(port, 'C. 转义 URL + 浏览器 UA（libVLC 路径始终这么发）',
    '/openapi/download?fid=abc%2Fdef%2Bghi%3Djkl',
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

  // D：未转义 URL（原始 / + =）
  await runCase(port, 'D. 未转义 URL（原始 / + =）', '/openapi/download?fid=abc/def+ghi=jkl', '')

  // E：修复后的 mpvPlay 实际发送内容（浏览器 UA + Referer + Cookie 三段逗号拼接）
  await runCase(port, 'E. 修复后 mpvPlay 的完整头部（UA+Referer+Cookie）',
    '/openapi/download?fid=abc%2Fdef%2Bghi%3Djkl',
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36,Referer: https://www.moonci.com/,Cookie: sid=abc123; uid=9')

  server.close()
  console.log('\n完成')
  process.exit(0)
})()

// 诊断：aria2 在当前环境能否真正连上 P2P 网络（用 Ubuntu 官方种子做对照）
// 用法：node scripts/diag-aria2-p2p.js
const { spawn } = require('node:child_process')
const axios = require('axios')
const { existsSync } = require('node:fs')

const BIN = process.argv[2] || 'E:\\aria2\\aria2c.exe'
const PORT = 6899
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rpc(method, params) {
  const res = await axios.post(
    `http://127.0.0.1:${PORT}/jsonrpc`,
    { jsonrpc: '2.0', id: 'd', method, params },
    { timeout: 8000 }
  )
  if (res.data?.error) throw new Error(res.data.error.message)
  return res.data?.result
}

;(async () => {
  if (!existsSync(BIN)) {
    console.log('aria2c 不存在:', BIN)
    return
  }
  // 与应用完全相同的启动参数（见 src/main/services/downloader/aria2.ts）
  const args = [
    '--enable-rpc',
    `--rpc-listen-port=${PORT}`,
    '--dir=E:\\sakana.app\\.testmedia\\p2p',
    '--auto-file-renaming=false',
    '--seed-time=0',
    '--file-allocation=none',
    '--max-concurrent-downloads=5',
    '--continue=true',
    '--console-log-level=warn'
  ]
  const proc = spawn(BIN, args, { stdio: 'ignore', windowsHide: true })
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try {
      const v = await rpc('aria2.getVersion', [])
      console.log('aria2 版本:', v.version)
      break
    } catch {
      /* 等待 RPC 就绪 */
    }
  }
  console.log('全局选项:', JSON.stringify(await rpc('aria2.getGlobalOption', []), null, 0).slice(0, 600))

  // 对照种子：Ubuntu 官方（种子充足）
  const torrentUrl = 'https://releases.ubuntu.com/24.04/ubuntu-24.04.3-desktop-amd64.iso.torrent'
  let b64 = ''
  try {
    const t = await axios.get(torrentUrl, { timeout: 30000, responseType: 'arraybuffer', headers: { 'User-Agent': UA } })
    b64 = Buffer.from(t.data).toString('base64')
    console.log(`对照种子已下载: ${torrentUrl} (${Buffer.from(t.data).length} bytes)`)
  } catch (err) {
    console.log('对照种子下载失败:', String(err.message).slice(0, 120))
    proc.kill()
    return
  }

  const gid = await rpc('aria2.addTorrent', [b64, [], { dir: 'E:\\sakana.app\\.testmedia\\p2p' }])
  console.log('gid =', gid)
  for (let i = 0; i < 12; i++) {
    await sleep(4000)
    const s = await rpc('aria2.tellStatus', [
      gid,
      ['status', 'totalLength', 'completedLength', 'downloadSpeed', 'connections', 'numSeeders', 'errorCode', 'errorMessage']
    ])
    console.log(
      `${(i + 1) * 4}s 状态=${s.status} 完成=${s.completedLength}/${s.totalLength} 速度=${s.downloadSpeed} 连接=${s.connections} 做种=${s.numSeeders} 错误=${s.errorMessage || '-'}`
    )
    if (s.status === 'complete' || Number(s.completedLength) > 0) break
  }
  try {
    await rpc('aria2.remove', [gid])
  } catch {
    /* ignore */
  }
  proc.kill()
  console.log('done')
})()

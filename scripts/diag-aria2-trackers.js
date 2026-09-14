// 诊断：aria2 的 tracker 是否真的连得上（getServers 会给出每个 tracker 的 lastAnnounceResult）
// 用法：node scripts/diag-aria2-trackers.js
const { spawn } = require('node:child_process')
const axios = require('axios')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')

const BIN = process.argv[2] || 'E:\\aria2\\aria2c.exe'
const PORT = 6898
const DIR = 'E:\\sakana.app\\.testmedia\\p2p2'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36'
const TORRENT_URL =
  'https://mikanani.kas.pub/Download/20241104/0651a36393eabaf6aee48624efc951983ebd3156.torrent'
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://9.rarbg.com:2810/announce'
].join(',')

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
  if (!existsSync(BIN)) return console.log('aria2c 不存在')
  mkdirSync(DIR, { recursive: true })
  // 与应用一致的参数（含新增公共 tracker）
  const proc = spawn(
    BIN,
    [
      '--enable-rpc',
      `--rpc-listen-port=${PORT}`,
      `--dir=${DIR}`,
      '--seed-time=0',
      '--file-allocation=none',
      '--console-log-level=warn',
      `--bt-tracker=${TRACKERS}`,
      '--enable-dht=true',
      '--enable-peer-exchange=true',
      '--bt-enable-lpd=true',
      '--listen-port=6881-6999'
    ],
    { stdio: 'ignore', windowsHide: true }
  )
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try {
      await rpc('aria2.getVersion', [])
      break
    } catch {
      /* wait */
    }
  }
  const go = await rpc('aria2.getGlobalOption', [])
  console.log('生效的 bt-tracker:', String(go['bt-tracker'] ?? '').slice(0, 120) || '(空)')
  console.log('生效的 enable-dht:', go['enable-dht'], ' listen-port:', go['listen-port'])

  const t = await axios.get(TORRENT_URL, { timeout: 30000, responseType: 'arraybuffer', headers: { 'User-Agent': UA } })
  writeFileSync(`${DIR}\\t.torrent`, Buffer.from(t.data))
  const gid = await rpc('aria2.addTorrent', [Buffer.from(t.data).toString('base64'), [], { dir: DIR }])
  console.log('gid =', gid)
  for (let i = 0; i < 8; i++) {
    await sleep(5000)
    const st = await rpc('aria2.tellStatus', [gid, ['status', 'completedLength', 'downloadSpeed', 'connections', 'numSeeders']])
    const servers = await rpc('aria2.getServers', [gid])
    const peers = await rpc('aria2.getPeers', [gid]).catch(() => [])
    console.log(
      `\n${(i + 1) * 5}s 状态=${st.status} 完成=${st.completedLength} 速度=${st.downloadSpeed} 连接=${st.connections} 做种=${st.numSeeders} 对端明细=${peers.length}`
    )
    for (const s of servers) {
      console.log(`  tracker ${String(s.uri).slice(0, 60)} → ${s.verdict ?? '-'} ${s.lastAnnounceResult ?? ''}`)
    }
    if (Number(st.completedLength) > 0) break
  }
  try {
    await rpc('aria2.remove', [gid])
  } catch {
    /* ignore */
  }
  proc.kill()
  console.log('done')
})()

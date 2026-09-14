// 下载 libVLC（VLC 3.0.x win64）并解压到 resources/libvlc/
const { createWriteStream, existsSync, mkdirSync, rmSync, readdirSync, copyFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const https = require('node:https')

const VLC_VERSION = '3.0.21'
const URLS = [
  `https://mirrors.aliyun.com/videolan/vlc/${VLC_VERSION}/win64/vlc-${VLC_VERSION}-win64.zip`,
  `https://download.videolan.org/pub/videolan/vlc/${VLC_VERSION}/win64/vlc-${VLC_VERSION}-win64.zip`,
  `https://get.videolan.org/vlc/${VLC_VERSION}/win64/vlc-${VLC_VERSION}-win64.zip`
]
const outDir = join(__dirname, '..', 'resources', 'libvlc')
const zipPath = join(outDir, 'vlc.zip')

function download(u) {
  return new Promise((resolve, reject) => {
    console.log(`下载: ${u}`)
    const req = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 600000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        resolve(download(res.headers.location))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const file = createWriteStream(zipPath)
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('下载超时')))
    req.on('error', reject)
  })
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  if (existsSync(zipPath) && require('node:fs').statSync(zipPath).size > 10 * 1024 * 1024) {
    console.log('zip 已存在，跳过下载')
  } else {
    rmSync(zipPath, { force: true })
    let lastErr = null
    for (const u of process.env.SAKANA_VLC_URL ? [process.env.SAKANA_VLC_URL] : URLS) {
      try {
        await download(u)
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        console.warn(`下载失败 (${err.message})，尝试下一个镜像…`)
        rmSync(zipPath, { force: true })
      }
    }
    if (lastErr) throw lastErr
  }
  console.log('解压中…')
  const extractDir = join(outDir, '_extract')
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  execFileSync('tar', ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' })
  // vlc-3.0.21/ 根目录包含 libvlc.dll libvlccore.dll plugins/
  const root = join(extractDir, `vlc-${VLC_VERSION}`)
  if (!existsSync(root)) throw new Error('压缩包结构不符')
  for (const name of ['libvlc.dll', 'libvlccore.dll']) {
    copyFileSync(join(root, name), join(outDir, name))
  }
  const pluginsSrc = join(root, 'plugins')
  const pluginsDst = join(outDir, 'plugins')
  rmSync(pluginsDst, { recursive: true, force: true })
  copyDir(pluginsSrc, pluginsDst)
  rmSync(extractDir, { recursive: true, force: true })
  rmSync(zipPath, { force: true })
  console.log(`完成: ${outDir}`)
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

main().catch((err) => {
  console.error('下载失败:', err.message)
  process.exit(1)
})

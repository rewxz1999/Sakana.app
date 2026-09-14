// 下载内置 aria2c（Windows 64 位）到 resources/aria2/
// 用法：npm run aria2:fetch
// 可用环境变量：
//   SAKANA_ARIA2_URL  自定义 aria2 下载地址
//   ELECTRON_MIRROR   已由 .npmrc 配置 npmmirror
const { createWriteStream, existsSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const https = require('node:https')
const http = require('node:http')

const ARIA2_VERSION = '1.37.0'
const DEFAULT_URL = `https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/aria2-${ARIA2_VERSION}-win-64bit-build1.zip`
const MIRROR_URL = `https://ghproxy.net/https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/aria2-${ARIA2_VERSION}-win-64bit-build1.zip`

const url = process.env.SAKANA_ARIA2_URL || DEFAULT_URL
const resourcesDir = join(__dirname, '..', 'resources', 'aria2')
const zipPath = join(resourcesDir, 'aria2.zip')

function download(u) {
  return new Promise((resolve, reject) => {
    console.log(`下载: ${u}`)
    const lib = u.startsWith('https') ? https : http
    const req = lib.get(
      u,
      { headers: { 'User-Agent': 'Sakana/0.1' }, timeout: 120000 },
      (res) => {
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
      }
    )
    req.on('timeout', () => req.destroy(new Error('下载超时')))
    req.on('error', reject)
  })
}

async function main() {
  mkdirSync(resourcesDir, { recursive: true })
  try {
    await download(url)
  } catch (err) {
    console.warn(`主地址下载失败 (${err.message})，尝试镜像…`)
    await download(process.env.SAKANA_ARIA2_URL || MIRROR_URL)
  }
  console.log('解压中…')
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${resourcesDir}' -Force`
  ])
  const { readdirSync, copyFileSync, rmSync } = require('node:fs')
  const extracted = readdirSync(resourcesDir).find((n) => n.startsWith('aria2-') && n.endsWith('-build1'))
  if (extracted) {
    const exe = join(resourcesDir, extracted, 'aria2c.exe')
    if (existsSync(exe)) {
      copyFileSync(exe, join(resourcesDir, 'aria2c.exe'))
      rmSync(join(resourcesDir, extracted), { recursive: true, force: true })
    }
  }
  rmSync(zipPath, { force: true })
  console.log(`完成: ${join(resourcesDir, 'aria2c.exe')}`)
}

main().catch((err) => {
  console.error('下载失败:', err.message)
  process.exit(1)
})

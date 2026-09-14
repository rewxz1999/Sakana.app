// 下载 FFmpeg（Windows 64 位 essentials 构建）到 resources/ffmpeg/
// 用法：npm run ffmpeg:fetch；解压使用 Windows 自带 tar.exe（比 Expand-Archive 快得多）
const { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const https = require('node:https')
const http = require('node:http')

const DEFAULT_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
const FALLBACK_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'

const url = process.env.SAKANA_FFMPEG_URL || DEFAULT_URL
const outDir = join(__dirname, '..', 'resources', 'ffmpeg')
const zipPath = join(outDir, 'ffmpeg.zip')

function download(u) {
  return new Promise((resolve, reject) => {
    console.log(`下载: ${u}`)
    const lib = u.startsWith('https') ? https : http
    const req = lib.get(u, { headers: { 'User-Agent': 'Sakana/0.1' }, timeout: 600000 }, (res) => {
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
      const total = Number(res.headers['content-length'] ?? 0)
      let received = 0
      const file = createWriteStream(zipPath)
      res.on('data', (chunk) => {
        received += chunk.length
        if (total > 0 && received % (10 * 1024 * 1024) < chunk.length) {
          console.log(`  进度: ${((received / total) * 100).toFixed(0)}% (${(received / 1048576).toFixed(0)}MB / ${(total / 1048576).toFixed(0)}MB)`)
        }
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('下载超时')))
    req.on('error', reject)
  })
}

function findExe(dir, name) {
  const walk = (d) => {
    let found = null
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        found = walk(p)
        if (found) break
      } else if (entry.name.toLowerCase() === name) {
        found = p
        break
      }
    }
    return found
  }
  return existsSync(dir) ? walk(dir) : null
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  if (existsSync(zipPath) && statSync(zipPath).size > 10 * 1024 * 1024) {
    console.log('zip 已存在，跳过下载')
  } else {
    rmSync(zipPath, { force: true })
    try {
      await download(url)
    } catch (err) {
      console.warn(`主地址下载失败 (${err.message})，尝试镜像…`)
      rmSync(zipPath, { force: true })
      await download(process.env.SAKANA_FFMPEG_URL || FALLBACK_URL)
    }
  }
  console.log('解压中…（tar.exe，请稍候）')
  const extractDir = join(outDir, '_extract')
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  execFileSync('tar', ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' })
  const ffmpegExe = findExe(extractDir, 'ffmpeg.exe')
  const ffprobeExe = findExe(extractDir, 'ffprobe.exe')
  if (ffmpegExe) copyFileSync(ffmpegExe, join(outDir, 'ffmpeg.exe'))
  if (ffprobeExe) copyFileSync(ffprobeExe, join(outDir, 'ffprobe.exe'))
  rmSync(extractDir, { recursive: true, force: true })
  rmSync(zipPath, { force: true })
  if (existsSync(join(outDir, 'ffmpeg.exe')) && existsSync(join(outDir, 'ffprobe.exe'))) {
    console.log(`完成: ${outDir}`)
  } else {
    console.error('未找到 ffmpeg.exe / ffprobe.exe，请检查下载包结构')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('下载失败:', err.message)
  process.exit(1)
})

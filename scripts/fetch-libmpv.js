// 下载 libmpv（mpv-dev 开发包）到 resources/libmpv，供内置 libmpv 播放内核使用
// 用法：node scripts/fetch-libmpv.js
const https = require('node:https')
const { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

const API = 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest'
const OUT_DIR = join(__dirname, '..', 'resources', 'libmpv')
const TMP = join(__dirname, '..', '.npm-cache', 'libmpv-download')

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Sakana/0.1.4', Accept: 'application/vnd.github+json' }, timeout: 20000 }, (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(d))
          } catch (e) {
            reject(new Error(`解析失败: ${d.slice(0, 120)}`))
          }
        })
      })
      .on('error', reject)
  })
}

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Sakana/0.1.4' }, timeout: 60000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume()
          const next = new URL(res.headers.location, url).toString()
          resolve(download(next, dest, redirects - 1))
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`))
          res.resume()
          return
        }
        const file = createWriteStream(dest)
        const total = Number(res.headers['content-length'] || 0)
        let got = 0
        let lastPct = -1
        res.on('data', (c) => {
          got += c.length
          const pct = total ? Math.floor((got / total) * 100) : 0
          if (pct !== lastPct && pct % 10 === 0) {
            process.stdout.write(`\r下载中 ${pct}%（${(got / 1048576).toFixed(1)}MB）`)
            lastPct = pct
          }
        })
        res.pipe(file)
        file.on('finish', () => {
          file.close()
          process.stdout.write('\n')
          resolve(dest)
        })
        file.on('error', reject)
      })
      .on('error', reject)
  })
}

/** 查找可用的 7z 解压工具：优先 7zip-bin（npm），其次系统安装的 7z */
function find7z() {
  const candidates = []
  try {
    const bin = require('7zip-bin')
    candidates.push(bin.path7za)
  } catch {
    /* 未安装 7zip-bin */
  }
  candidates.push('C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe')
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

function walk(dir, depth = 0) {
  const out = []
  if (depth > 3) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full, depth + 1))
    else out.push(full)
  }
  return out
}

;(async () => {
  console.log('查询最新 mpv-dev 版本…')
  const rel = await fetchJson(API)
  const tag = rel.tag_name || '(unknown)'
  const assets = (rel.assets || []).filter((a) => /^mpv-dev-x86_64-\d{8}-git-.*\.7z$/.test(a.name))
  if (!assets.length) {
    console.error('未找到 mpv-dev-x86_64 资产，可用资产：', (rel.assets || []).map((a) => a.name).join(', '))
    process.exit(2)
  }
  const asset = assets[0]
  console.log(`版本 ${tag} → ${asset.name}（${(asset.size / 1048576).toFixed(1)}MB）`)

  mkdirSync(TMP, { recursive: true })
  const archive = join(TMP, asset.name)
  if (!existsSync(archive)) {
    await download(asset.browser_download_url, archive)
  } else {
    console.log('已存在下载缓存，跳过下载')
  }

  const sevenZip = find7z()
  if (!sevenZip) {
    console.error('未找到 7z 解压工具。请安装 7-Zip，或运行：npm i -D 7zip-bin')
    process.exit(3)
  }
  const extractDir = join(TMP, 'extracted')
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  console.log(`解压（${sevenZip}）…`)
  execFileSync(sevenZip, ['x', archive, `-o${extractDir}`, '-y'], { stdio: 'inherit' })

  const files = walk(extractDir)
  const wanted = files.filter((f) => /(libmpv-2\.dll|libmpv\.dll|mpv-2\.dll)$/i.test(f))
  if (!wanted.length) {
    console.error('解压后未找到 libmpv dll，内容如下：')
    files.slice(0, 30).forEach((f) => console.error('  ' + f))
    process.exit(4)
  }
  mkdirSync(OUT_DIR, { recursive: true })
  for (const f of wanted) {
    const dest = join(OUT_DIR, f.split(/[\\/]/).pop())
    copyFileSync(f, dest)
    console.log(`已安装 ${dest}（${(statSync(dest).size / 1048576).toFixed(1)}MB）`)
  }
  // 一并保留头文件与导入库，方便后续写 N-API 插件
  for (const f of files) {
    if (/[\\/](include|lib)[\\/]/i.test(f) || /\.(def|lib|h)$/i.test(f)) {
      const rel2 = f.slice(extractDir.length + 1)
      const dest = join(OUT_DIR, rel2)
      mkdirSync(join(dest, '..'), { recursive: true })
      try {
        copyFileSync(f, dest)
      } catch {
        /* ignore */
      }
    }
  }
  console.log(`\n完成：libmpv 运行时已就绪于 ${OUT_DIR}`)
  console.log(`版本：${tag}（${asset.name}）`)
})().catch((err) => {
  console.error('失败:', err.message)
  process.exit(1)
})

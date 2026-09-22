/**
 * 下载 Anime4K 的 GLSL 着色器（v0.3.1 超分辨率功能用）。
 *
 * 为什么要这个脚本：本机到 `github.com:443` 不通（git push 与 Releases 页面直链都打不开），
 * 但 `api.github.com` 可达，资产端点会 302 到 `release-assets.githubusercontent.com` 并能正常下载 ——
 * 所以走 REST API 拿资产、再按 octet-stream 拉字节。
 *
 * 用法：node scripts/fetch-anime4k.js
 * 产物：resources/shaders/*.glsl（由 electron-builder 的 extraResources 复制到安装目录，不进 asar）
 */
const { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = 'bloc97/Anime4K'
const OUT_DIR = join(__dirname, '..', 'resources', 'shaders')
const TMP_ZIP = join(__dirname, '..', '.anime4k.zip')

async function fetchLatestAsset() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sakana-fetch' }
  })
  if (!res.ok) throw new Error(`查询 release 失败：HTTP ${res.status}`)
  const rel = await res.json()
  const asset = (rel.assets ?? []).find((a) => /\.zip$/i.test(a.name))
  if (!asset) throw new Error('该 release 里没有 zip 资产')
  console.log(`使用 ${rel.tag_name}（${rel.name ?? ''}）→ ${asset.name}（${(asset.size / 1024 / 1024).toFixed(2)}MB）`)
  return asset
}

async function download(asset) {
  // ① 先试直链（普通网络最快）；② 失败改资产端点（本机实测这条可达）
  const attempts = [
    { url: asset.browser_download_url, headers: { 'User-Agent': 'Sakana-fetch' } },
    {
      url: asset.url,
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Sakana-fetch' }
    }
  ]
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, { headers: a.headers, redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 1000) throw new Error(`内容过小（${buf.length} 字节）`)
      createWriteStream(TMP_ZIP).end(buf)
      await new Promise((r) => setTimeout(r, 300)) // 等落盘
      console.log(`已下载 ${buf.length} 字节 → ${TMP_ZIP}`)
      return
    } catch (err) {
      console.log(`尝试失败（${a.url.slice(0, 48)}…）：${String(err?.message ?? err)}`)
    }
  }
  throw new Error('两条通道都下载失败')
}

function extract() {
  // 7zip 二进制随 electron 生态一起装在 node_modules 里，省得依赖系统解压工具
  const sevenZip = join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
  const exe = existsSync(sevenZip) ? sevenZip : 'tar'
  const args = existsSync(sevenZip)
    ? ['x', TMP_ZIP, `-o${OUT_DIR}`, '-y']
    : ['-x', '-f', TMP_ZIP, '-C', OUT_DIR]
  execFileSync(exe, args, { stdio: 'inherit' })
  rmSync(TMP_ZIP, { force: true })
  // 有些包里 GLSL 在子目录里，平铺到 shaders 根方便 mpv 按文件名拼路径
  const flatten = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        flatten(p)
        try {
          rmSync(p, { recursive: true, force: true })
        } catch {
          /* 非空就留着 */
        }
      }
    }
  }
  flatten(OUT_DIR)
  const glsl = readdirSync(OUT_DIR).filter((f) => f.toLowerCase().endsWith('.glsl'))
  console.log(`解出 ${glsl.length} 个 .glsl 着色器：`)
  for (const f of glsl.sort()) console.log(`  ${(statSync(join(OUT_DIR, f)).size / 1024).toFixed(1)}KB  ${f}`)
  if (glsl.length === 0) throw new Error('解压后没有 .glsl 文件')
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const asset = await fetchLatestAsset()
  await download(asset)
  extract()
  console.log(`\n✅ 着色器就位：${OUT_DIR}`)
}

main().catch((err) => {
  console.error(String(err?.message ?? err))
  process.exit(1)
})

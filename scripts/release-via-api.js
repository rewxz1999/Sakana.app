/**
 * 发布 GitHub Release 并上传安装包 / 增量补丁（v0.2.9 最后更新 → v0.2.10 增量补丁）。
 *
 * 为什么需要它：用户要求「把安装包通过 GitHub Releases 上传」，而本机到 `github.com:443`
 * 被重置（`git push` 与 Releases 页面的直链下载都不通），只有 `api.github.com` 与
 * `uploads.github.com` 可达 —— 于是用 REST API 手工建 release、再把附件传上去。
 *
 * v0.2.10 追加：用户要「安装包层面的小更新」，所以除了完整安装包，还会把
 * `patch-<旧版本>-to-<新版本>.zip`（由 `scripts/make-patch.js` 生成）一起传上去，
 * 应用内一键更新会优先挑这个补丁下载（几 MB），找不到才回落完整安装包。
 *
 * 用法：
 *   node scripts/release-via-api.js                     # 版本取自 package.json，说明取自 version.json
 *   node scripts/release-via-api.js --tag v0.2.10       # 指定 tag
 *   node scripts/release-via-api.js --asset <文件路径>   # 指定要上传的安装包（默认 release/Sakana-<版本>-setup.exe）
 *   node scripts/release-via-api.js --patch <文件路径>   # 追加一个附件（增量补丁）；--no-patch 则不传补丁
 *
 * 安全性：token 从 git 凭据管理器读取，不落盘、不打印；只操作这一个仓库。
 */
const { execFileSync } = require('node:child_process')
const { createReadStream, existsSync, statSync } = require('node:fs')
const { basename, join } = require('node:path')

const REPO = 'rewxz1999/Sakana.app'

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf-8'
  })
  const m = /^password=(.*)$/m.exec(out)
  if (!m) throw new Error('未从凭据管理器取到 token')
  return m[1]
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${String(body).slice(0, 400)}`)
    this.status = status
  }
}

async function api(tok, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `token ${tok}`,
      'User-Agent': 'Sakana-release',
      Accept: 'application/vnd.github+json',
      ...(init.headers ?? {})
    }
  })
  const text = await res.text()
  if (!res.ok) throw new HttpError(res.status, text)
  return text ? JSON.parse(text) : null
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

/** 用 fetch + 流上传（Node 的 fetch 支持 ReadableStream body；要带 Content-Length 才不会走 chunked） */
async function uploadAsset(tok, uploadUrl, file, name) {
  const size = statSync(file).size
  const stream = createReadStream(file)
  // 需要 duplex: 'half' 才能把 Node 流转成 web 流
  const body = require('node:stream').Readable.toWeb(stream)
  const res = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    duplex: 'half',
    body,
    headers: {
      Authorization: `token ${tok}`,
      'User-Agent': 'Sakana-release',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size)
    }
  })
  const text = await res.text()
  if (!res.ok) throw new HttpError(res.status, text)
  return JSON.parse(text)
}

async function main() {
  const pkg = JSON.parse(require('node:fs').readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  const version = String(pkg.version)
  const tag = arg('--tag', `v${version}`)
  const versionFile = JSON.parse(
    require('node:fs').readFileSync(join(__dirname, '..', 'version.json'), 'utf8')
  )
  const assetPath = arg('--asset', join(__dirname, '..', 'release', `Sakana-${version}-setup.exe`))
  if (!existsSync(assetPath)) throw new Error(`安装包不存在：${assetPath}（先运行 npm run dist）`)
  const assetName = basename(assetPath)
  const sizeMB = (statSync(assetPath).size / 1024 / 1024).toFixed(1)

  // 增量补丁：默认自动找 release/patch-*-to-<版本>.zip，找不到就只发安装包
  const patchDir = join(__dirname, '..', 'release')
  const autoPatch = existsSync(patchDir)
    ? require('node:fs')
        .readdirSync(patchDir)
        .filter((f) => f.startsWith('patch-') && f.endsWith(`-to-${version}.zip`))
        .map((f) => join(patchDir, f))[0]
    : undefined
  const patchPath = process.argv.includes('--no-patch') ? null : arg('--patch', autoPatch ?? null)
  if (patchPath && !existsSync(patchPath)) throw new Error(`补丁不存在：${patchPath}`)
  const patchMB = patchPath ? (statSync(patchPath).size / 1024 / 1024).toFixed(1) : null

  const tok = token()
  const notes = [
    versionFile.notes ?? '',
    '',
    `下载安装包：${assetName}（${sizeMB} MB）`,
    patchPath && patchMB
      ? `增量补丁：${basename(patchPath)}（${patchMB} MB）—— 已安装旧版本的用户在「设置 → 软件更新」里点一下即可，无需重下完整安装包。`
      : ''
  ]
    .filter((s, i) => s !== '' || i === 1)
    .join('\n')

  // 已有同名 release 就复用（重复发布时只补/换附件）
  let release = null
  try {
    release = await api(tok, `/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`)
    console.log(`已存在 release ${tag}（id=${release.id}），将复用`)
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404) throw err
  }
  if (!release) {
    release = await api(tok, `/repos/${REPO}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: `Sakana ${tag}`,
        body: notes,
        draft: false,
        prerelease: false
      })
    })
    console.log(`已创建 release ${tag}（id=${release.id}）`)
  } else if (release.body !== notes) {
    // 复用旧 release 时把说明同步成最新的（否则补丁信息写不进去）
    release = await api(tok, `/repos/${REPO}/releases/${release.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: notes })
    })
    console.log('已更新 release 说明')
  }

  // 待上传附件（顺序：安装包 → 补丁）
  const uploads = [
    { path: assetPath, name: assetName, sizeMB },
    ...(patchPath && patchMB ? [{ path: patchPath, name: basename(patchPath), sizeMB: patchMB }] : [])
  ]

  // 同名附件先删掉再传（GitHub 不允许重复文件名）
  const assets = await api(tok, `/repos/${REPO}/releases/${release.id}/assets`)
  for (const a of assets ?? []) {
    if (uploads.some((u) => u.name === a.name)) {
      await api(tok, `/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' })
      console.log(`已删除同名旧附件 ${a.name}`)
    }
  }

  for (const u of uploads) {
    console.log(`开始上传 ${u.name}（${u.sizeMB} MB）→ uploads.github.com …`)
    const t0 = Date.now()
    const started = await uploadAsset(tok, release.upload_url.replace('{?name,label}', ''), u.path, u.name)
    console.log(
      `✅ 上传完成：${started.name}（${(started.size / 1024 / 1024).toFixed(1)} MB，用时 ${(
        (Date.now() - t0) / 1000
      ).toFixed(0)}s）`
    )
    console.log(`   下载地址（api）：${started.url}`)
    console.log(`   下载地址（浏览器）：${started.browser_download_url}`)
  }
  console.log(`   发布页：${release.html_url}`)
}

main().catch((err) => {
  console.error(String(err?.message ?? err))
  process.exit(1)
})

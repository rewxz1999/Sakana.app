/**
 * 增量更新补丁生成器（v0.2.10）。
 *
 * 背景与目标：完整安装包 ~361MB，但两次版本之间真正变化的只有应用代码那几 MB
 * （`resources/app.asar`、少量资源），libmpv / ffmpeg / aria2 这些大件几乎从不变化。
 * 用户要求「安装包层面的小更新」，所以这里生成**文件级补丁**：
 *
 *   对比「旧版本的文件树」与「新版本的 win-unpacked」，只把**新增/内容变化**的文件打进 zip，
 *   并把删除清单一起写进 zip 内的 `patch.json`；应用端按它校验、覆盖、删文件、重启。
 *
 * 用法：
 *   # 1) 只生成清单（用于下次比较，也可作为发布产物留存）
 *   node scripts/make-patch.js manifest --dir release/win-unpacked --out release/manifest-0.2.10.json
 *
 *   # 2) 生成补丁（--from 可以是目录，也可以是上一次的清单 json）
 *   node scripts/make-patch.js patch --from E:/sakana-prev-0.2.9 --app release/win-unpacked \
 *        --zip release/patch-0.2.9-to-0.2.10.zip --from-version 0.2.9 --to-version 0.2.10
 *
 * 旧版本文件树怎么来：用 7za 解开上一次发布的安装包即可（NSIS 的 exe 7za 能解）：
 *   node_modules/7zip-bin/win/x64/7za.exe x release/Sakana-<旧版本>-setup.exe -oE:/sakana-prev-<旧版本> -y
 */
const { createHash } = require('node:crypto')
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { dirname, join, relative, sep } = require('node:path')
const { execFileSync } = require('node:child_process')

/**
 * 安装目录里的**运行期数据**（用户数据/缓存/下载/截图/日志）。
 *
 * 这些目录在打包产物里不存在，只会出现在「用户实际安装目录」里。
 * 如果拿一个装过、跑过的目录当 `--from` 基准，它们会被算成「新版本没有的文件」进入 `removed[]`，
 * 安装脚本就会把用户的收藏、订阅、下载全删掉 —— 所以两边都直接忽略，永不下发、永不删除。
 */
const RUNTIME_TOP = new Set([
  'data',
  'cache',
  'downloads',
  'screenshots',
  'galgame-screenshots',
  '.shots',
  '.testmedia'
])

function isRuntimePath(rel) {
  const top = rel.split('/')[0]
  return RUNTIME_TOP.has(top) || /\.log$/i.test(rel)
}

/** 递归列出目录下所有文件（相对路径统一用 / 分隔，跨平台一致），跳过运行期数据 */
function walk(root) {
  const out = []
  const visit = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (isRuntimePath(relative(root, full).split(sep).join('/'))) continue
        visit(full)
      } else if (e.isFile()) out.push(full)
    }
  }
  visit(root)
  return out
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 生成 { "相对路径": {sha256, size} } 清单 */
function buildManifest(dir) {
  const map = {}
  for (const f of walk(dir)) {
    const rel = relative(dir, f).split(sep).join('/')
    if (isRuntimePath(rel)) continue
    map[rel] = { sha256: sha256(f), size: statSync(f).size }
  }
  return map
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * 大文件的**字节级增量**（v0.2.10 关键优化）。
 *
 * 为什么需要：`Sakana.exe` 有 233MB，但版本之间它其实只变了几百字节 ——
 * electron-builder 会把 `app.asar` 的完整性校验哈希写进 exe 的资源段
 * （日志里的「updating asar integrity executable resource」），asar 一变，exe 里那一小块就变。
 * 如果按整文件下发，补丁会白白多出 100MB+（等于完整安装包的一半），「小更新」就无从谈起。
 *
 * 做法：同尺寸的两个文件逐字节比较，把差异位置合并成若干「区段」（间隔小于 GAP 的差异并成一段，
 * 免得 JSON 里出现上千条记录），只下发这些区段的字节。应用端先校验**旧文件**的 sha256
 * 与 `baseSha256` 一致，再把这些字节写进去，最后校验**新文件**的 sha256 —— 任一步不符就整包作废，
 * 让用户改走完整安装包，绝不带着「半对」的文件覆盖安装目录。
 *
 * 安全性边界：区段总量或条数超限就返回 null（回落整文件下发），避免给一个巨大的「增量」。
 */
function tryDelta(oldFile, newFile) {
  const a = readFileSync(oldFile)
  const b = readFileSync(newFile)
  const n = a.length
  if (n !== b.length || n === 0) return null

  const GAP = 1024 // 差异间隔小于它就并成一段
  const MAX_SPANS = 512
  const MAX_BYTES = 16 * 1024 * 1024

  const spans = []
  let total = 0
  let i = 0
  while (i < n) {
    if (a[i] === b[i]) {
      i++
      continue
    }
    let end = i
    let probe = i
    while (probe < n) {
      if (a[probe] !== b[probe]) {
        end = probe
        probe++
        continue
      }
      // 后面这段相同区如果很短、且之后又有差异，就并入当前段（减少条数）
      let k = probe
      while (k < n && k - probe < GAP && a[k] === b[k]) k++
      if (k < n && a[k] !== b[k]) probe = k
      else break
    }
    spans.push({ off: i, data: b.subarray(i, end + 1).toString('base64') })
    total += end + 1 - i
    if (spans.length > MAX_SPANS || total > MAX_BYTES) return null
    i = end + 1
  }
  return spans.length > 0 ? { spans, total } : null
}

function main() {
  const [mode] = process.argv.slice(2)
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(name)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
  }

  if (mode === 'manifest') {
    const dir = arg('--dir', 'release/win-unpacked')
    const out = arg('--out', 'release/manifest.json')
    const m = buildManifest(dir)
    writeFileSync(out, JSON.stringify(m, null, 2))
    console.log(`清单已写出：${out}（${Object.keys(m).length} 个文件）`)
    return
  }

  if (mode !== 'patch') {
    console.log('用法：node scripts/make-patch.js manifest|patch ...（详见文件头注释）')
    process.exit(1)
  }

  const fromPath = arg('--from')
  const appDir = arg('--app', 'release/win-unpacked')
  const zipPath = arg('--zip')
  const fromVersion = arg('--from-version', '?')
  const toVersion = arg('--to-version', '?')
  if (!fromPath || !zipPath) {
    console.error('缺少参数：--from <旧文件树目录或清单 json> --zip <输出 zip>')
    process.exit(1)
  }
  if (!existsSync(appDir)) {
    console.error(`新版本目录不存在：${appDir}（先运行 npm run dist）`)
    process.exit(1)
  }

  const oldManifest = statSync(fromPath).isDirectory() ? buildManifest(fromPath) : readJson(fromPath)
  const newManifest = buildManifest(appDir)
  const oldIsDir = statSync(fromPath).isDirectory()
  console.log(`旧版本文件 ${Object.keys(oldManifest).length} 个，新版本文件 ${Object.keys(newManifest).length} 个`)

  /*
   * 逐个变化文件决定下发方式：
   * - 旧文件存在且能压成字节增量 → `delta`（只带差异区段，不进 zip）
   * - 否则 → `full`（整文件进 zip）
   */
  const fullFiles = []
  const deltaFiles = []
  let fullBytes = 0
  let deltaBytes = 0
  for (const [rel, info] of Object.entries(newManifest)) {
    const old = oldManifest[rel]
    if (old && old.sha256 === info.sha256) continue
    const oldFile = oldIsDir ? join(fromPath, rel) : null
    const delta = old && oldFile && existsSync(oldFile) ? tryDelta(oldFile, join(appDir, rel)) : null
    if (delta) {
      deltaFiles.push({
        path: rel,
        sha256: info.sha256,
        size: info.size,
        mode: 'delta',
        baseSha256: old.sha256,
        spans: delta.spans
      })
      deltaBytes += delta.total
    } else {
      fullFiles.push({ path: rel, sha256: info.sha256, size: info.size, mode: 'full' })
      fullBytes += info.size
    }
  }
  const removed = Object.keys(oldManifest).filter((rel) => !newManifest[rel])

  console.log(`需要下发 ${fullFiles.length} 个整文件（${(fullBytes / 1024 / 1024).toFixed(1)}MB）`)
  for (const f of fullFiles.slice(0, 20)) console.log(`  ~ ${f.path}`)
  if (fullFiles.length > 20) console.log(`  …（其余 ${fullFiles.length - 20} 个）`)
  if (deltaFiles.length) {
    console.log(`另有 ${deltaFiles.length} 个文件走字节增量（共 ${(deltaBytes / 1024).toFixed(1)}KB 差异数据）`)
    for (const f of deltaFiles) console.log(`  ± ${f.path}（${f.spans.length} 段 / ${(f.size / 1024 / 1024).toFixed(1)}MB）`)
  }
  if (removed.length) {
    console.log(`需要删除 ${removed.length} 个文件：`)
    for (const rel of removed.slice(0, 10)) console.log(`  - ${rel}`)
  }

  /*
   * 打包：只把「整文件下发」的那些按原目录结构放进 zip，另外在最外层放一个 patch.json
   * 供应用端校验与打增量（delta 的区段数据都在 patch.json 里，不额外占体积）。
   * 用系统自带 tar（Windows 10+ 自带 bsdtar，支持 zip）—— 避免为打包再引一个依赖。
   */
  const staging = join(dirname(zipPath), '.patch-stage')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  for (const f of fullFiles) {
    const dest = join(staging, f.path)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(appDir, f.path), dest)
  }
  const patchJson = {
    from: fromVersion,
    to: toVersion,
    generatedAt: new Date().toISOString(),
    /** 补丁内包含的**整文件**（在 zip 里的路径 + 校验值） */
    files: fullFiles,
    /** 字节增量文件：baseSha256 是旧版本那一个文件的哈希，spans 是差异区段 */
    deltas: deltaFiles,
    /** 新版本已不存在的文件，应用端需要删除 */
    removed,
    /** 新版本全量文件数（便于排查补丁是否完整） */
    total: Object.keys(newManifest).length
  }
  writeFileSync(join(staging, 'patch.json'), JSON.stringify(patchJson, null, 2))

  mkdirSync(dirname(zipPath), { recursive: true })
  if (existsSync(zipPath)) rmSync(zipPath)
  // zip 里除了文件本身还有 patch.json（校验清单 + 删除清单），应用端解包后先校验再覆盖
  execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', staging, '.'], { stdio: 'inherit' })
  rmSync(staging, { recursive: true, force: true })
  const size = statSync(zipPath).size
  const setup = join('release', `Sakana-${toVersion}-setup.exe`)
  const ratio = existsSync(setup) ? `，相当于完整安装包的 ${((size / statSync(setup).size) * 100).toFixed(1)}%` : ''
  console.log(`✅ 补丁已生成：${zipPath}（${(size / 1024 / 1024).toFixed(1)}MB${ratio}）`)
}

main()

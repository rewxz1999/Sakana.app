/**
 * 无 github.com 直连时的推送工具（v0.2.4 紧急更新期间网络被封时使用）
 *
 * 背景：本机到 `github.com:443`（git push 的通道）被重置，但 `api.github.com` 仍然可达。
 * 于是用 GitHub 的 Git Data API 手工构造一次提交并更新 ref：
 *   blobs → tree（base_tree = 远端当前 tree）→ commit（parent = 远端 HEAD）→ PATCH ref
 *
 * 安全性：只读写这一个仓库；token 从 git 凭据管理器读取，不落盘、不打印。
 * 用法：node scripts/push-via-api.js ["提交说明"]
 */
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')

const REPO = 'rewxz1999/Sakana.app'
const BRANCH = 'main'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim()
}

/** 计算 git blob 哈希（sha1("blob <len>\0" + content)），用于与远端 tree 的 blob sha 比对 */
function gitBlobSha(content) {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8')
  return require('node:crypto').createHash('sha1').update(Buffer.concat([header, content])).digest('hex')
}

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf-8'
  })
  const m = /^password=(.*)$/m.exec(out)
  if (!m) throw new Error('未从凭据管理器取到 token')
  return m[1]
}

async function api(tok, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `token ${tok}`,
      'User-Agent': 'Sakana-push',
      Accept: 'application/vnd.github+json',
      ...(init.headers ?? {})
    }
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

async function main() {
  const message = process.argv[2] || '紧急更新：数据源自建反代 + 全屏修复'
  const tok = token()

  // 1) 远端当前 HEAD 与 tree
  const ref = await api(tok, `/repos/${REPO}/git/ref/heads/${BRANCH}`)
  const parentSha = ref.object.sha
  const parent = await api(tok, `/repos/${REPO}/git/commits/${parentSha}`)
  console.log(`远端 HEAD = ${parentSha.slice(0, 7)}（tree ${String(parent.tree.sha).slice(0, 7)}）`)

  // 2) 与远端比较，取出需要变更的文件
  /*
   * 不用 `git diff origin/main HEAD`：github.com 被封时 `git fetch` 拿不到新提交，
   * 本地跟踪引用会停在旧位置，diff 结果就不可信了。
   * 这里改成用 API 拉取远端完整 tree，再按「git blob 哈希」逐个文件比对 ——
   * 完全不依赖本地引用，也顺带解决 CRLF 差异（比对前统一按 LF 计算哈希）。
   */
  const remoteTree = await api(
    tok,
    `/repos/${REPO}/git/trees/${parentSha}?recursive=1`
  )
  const remoteBlobs = new Map()
  for (const node of remoteTree.tree ?? []) {
    if (node.type === 'blob') remoteBlobs.set(node.path, node.sha)
  }
  const localFiles = git(['ls-files']).split(/\r?\n/).filter(Boolean)
  const changed = []
  /*
   * 二进制判定：**看内容，不看扩展名**。
   *
   * 这里踩过一次坑：以前用扩展名白名单（png|jpg|…|ttf 之类）判断，
   * 漏了 `.otf`（uosc 的图标字体 `resources/mpv-config/fonts/uosc_icons.otf`），
   * 于是那个字体被当成文本做了 CRLF→LF 归一化后上传 —— 远端那份字体文件从此是坏的，
   * 谁从仓库 clone 出来自己构建，uosc 的图标就会出问题（本地打包不受影响，因为用的是本地那份）。
   * 现在改成「前 8KB 里出现 NUL 字节即二进制」，字体/图片/压缩包都逃不掉。
   */
  const looksBinary = (raw) => raw.subarray(0, 8192).includes(0)
  for (const path of localFiles) {
    const rel = path.replace(/\\/g, '/')
    const raw = readFileSync(path)
    const isBinary = looksBinary(raw)
    const content = isBinary ? raw : Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
    const sha = gitBlobSha(content)
    if (remoteBlobs.get(rel) !== sha) {
      changed.push({ status: remoteBlobs.has(rel) ? 'M' : 'A', path, content, binary: isBinary })
    }
    remoteBlobs.delete(rel)
  }
  // 远端有、本地已删除的文件
  for (const path of remoteBlobs.keys()) changed.push({ status: 'D', path, content: null })
  if (changed.length === 0) {
    console.log('本地与远端内容一致，无需推送')
    return
  }
  console.log(`需要推送 ${changed.length} 个文件`)

  // 3) 逐个上传 blob
  const entries = []
  for (const c of changed) {
    if (c.status === 'D') {
      entries.push({ path: c.path, mode: '100644', type: 'blob', sha: null })
      console.log(`  - 删除 ${c.path}`)
      continue
    }
    const content = c.content
    const blob = await api(tok, `/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' })
    })
    entries.push({ path: c.path.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.sha })
    console.log(`  ${c.status === 'A' ? '+' : '~'} ${c.path}（${content.length} 字节）`)
  }

  // 4) 基于远端 tree 生成新 tree
  const tree = await api(tok, `/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries })
  })

  // 5) 建提交并移动分支
  const commit = await api(tok, `/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: `${message}\n\n（通过 GitHub Git Data API 提交：本机到 github.com:443 被重置，改用 api.github.com）`, tree: tree.sha, parents: [parentSha] })
  })
  await api(tok, `/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false })
  })
  console.log(`\n✅ 已通过 API 推送：${commit.sha.slice(0, 7)}（${changed.length} 个文件）`)
}

main().catch((err) => {
  console.error(String(err.message ?? err))
  process.exit(1)
})

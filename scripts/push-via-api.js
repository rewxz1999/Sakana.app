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
  const changed = git(['diff', '--name-status', `origin/${BRANCH}`, 'HEAD'])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t')
      return { status, path: rest.join('\t') }
    })
  if (changed.length === 0) {
    console.log('没有差异，无需推送')
    return
  }

  // 3) 逐个上传 blob
  const entries = []
  for (const c of changed) {
    if (c.status === 'D') {
      entries.push({ path: c.path, mode: '100644', type: 'blob', sha: null })
      console.log(`  - 删除 ${c.path}`)
      continue
    }
    const raw = readFileSync(c.path)
    /*
     * 行尾归一化：Windows 工作区是 CRLF，而 git 提交时会按 core.autocrlf 转成 LF。
     * 直接上传原始字节会把 CRLF 写进仓库，导致「整个文件都被改动」的假 diff。
     */
    const isBinary = /\.(png|jpe?g|webp|gif|ico|zip|7z|exe|dll|node|woff2?|ttf|mp4|mp3)$/i.test(c.path)
    const content = isBinary ? raw : Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
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

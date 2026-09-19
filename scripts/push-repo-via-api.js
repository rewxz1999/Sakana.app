/**
 * 把**任意本地目录**推成一个 GitHub 仓库的提交（v0.2.12）。
 *
 * 背景：本机到 `github.com:443`（git push 的通道）被重置，只有 `api.github.com` 可达，
 * 所以沿用 `push-via-api.js` 那套 Git Data API 思路；但那个脚本是给 Sakana.app 用的
 * （它按 `git ls-files` 比对本地仓库），这里要推的是**另一个仓库里的一堆松散文件**
 * （例如把「最XX的角色 9宫格」独立版推到 Sakana-tool），所以单独写一个。
 *
 * 用法：
 *   node scripts/push-repo-via-api.js --dir .e2e/tool-9grid --repo rewxz1999/Sakana-tool \
 *        --message "首个版本：最XX的角色 9宫格" [--branch main]
 *
 * 安全性：token 从 git 凭据管理器读取，不落盘、不打印；只写命令行指定的那一个仓库。
 * 空仓库（没有 main 分支）与已有仓库（增量更新）都能处理。
 */
const { execFileSync } = require('node:child_process')
const { readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative, sep } = require('node:path')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
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
      'User-Agent': 'Sakana-release',
      Accept: 'application/vnd.github+json',
      ...(init.headers ?? {})
    }
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  return text ? JSON.parse(text) : null
}

/** 递归收集文件（相对路径统一用 /），跳过 .git 与常见垃圾 */
function walk(root) {
  const out = []
  const visit = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) visit(full)
      else if (e.isFile()) out.push(full)
    }
  }
  visit(root)
  return out
}

async function main() {
  const dir = arg('--dir')
  const repo = arg('--repo')
  const branch = arg('--branch', 'main')
  const message = arg('--message', '更新')
  if (!dir || !repo) {
    console.error('用法：node scripts/push-repo-via-api.js --dir <目录> --repo <owner/repo> [--branch main] [--message "..."]')
    process.exit(1)
  }
  const tok = token()

  // 1) 当前分支（空仓库会 404/409）
  let parentSha = null
  let baseTree = null
  try {
    const ref = await api(tok, `/repos/${repo}/git/ref/heads/${branch}`)
    parentSha = ref.object.sha
    const commit = await api(tok, `/repos/${repo}/git/commits/${parentSha}`)
    baseTree = commit.tree.sha
    console.log(`仓库已有分支 ${branch}：HEAD=${parentSha.slice(0, 7)}`)
  } catch (err) {
    if (err.status === 404 || err.status === 409) {
      console.log(`仓库 ${repo} 还没有 ${branch} 分支（空仓库），将创建首个提交`)
    } else {
      throw err
    }
  }

  /*
   * 空仓库的特殊路径：GitHub 的 Git Data API（建 blob）在**完全空的仓库**上会返回
   * 409 "Git Repository is empty."（实测）—— 必须先有一次提交才有 git 对象库。
   * 而 Contents API 可以在空仓库上直接建文件并顺带创建首个提交与分支，所以空仓库走它。
   * 非空仓库仍然走 Git Data API：一次提交推完所有文件，比逐文件提交干净。
   */
  const files = walk(dir)
  if (files.length === 0) {
    console.error(`目录里没有文件：${dir}`)
    process.exit(1)
  }
  if (!parentSha) {
    let last = null
    for (const f of files) {
      const rel = relative(dir, f).split(sep).join('/')
      const content = readFileSync(f)
      const body = content.toString('base64')
      const res = await api(tok, `/repos/${repo}/contents/${encodeURIComponent(rel)}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `${message}（${rel}）`,
          content: body,
          branch
        })
      })
      last = res?.commit?.sha ?? last
      console.log(`  + ${rel}（${content.length} 字节）`)
    }
    console.log(`\n✅ 已在空仓库 ${repo} 上创建首个提交（${files.length} 个文件）：${String(last).slice(0, 7)}`)
    console.log(`   https://github.com/${repo}`)
    return
  }

  // 2) 上传所有文件为 blob
  const entries = []
  for (const f of files) {
    const rel = relative(dir, f).split(sep).join('/')
    const content = readFileSync(f)
    const isBinary = /\.(png|jpe?g|webp|gif|ico|zip|7z|exe|dll|woff2?|ttf)$/i.test(f)
    const body = isBinary
      ? content.toString('base64')
      : Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'), 'utf8').toString('base64')
    const blob = await api(tok, `/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: body, encoding: 'base64' })
    })
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha })
    console.log(`  + ${rel}（${content.length} 字节）`)
  }
  if (entries.length === 0) {
    console.error(`目录里没有文件：${dir}`)
    process.exit(1)
  }

  // 3) tree（有 base_tree 就是在原基础上增量更新；空仓库不带 base_tree）
  const tree = await api(tok, `/repos/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify(baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries })
  })

  // 4) commit
  const commitBody = {
    message: `${message}\n\n（通过 GitHub Git Data API 提交）`,
    tree: tree.sha,
    parents: parentSha ? [parentSha] : []
  }
  const commit = await api(tok, `/repos/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify(commitBody)
  })

  // 5) 移动（或创建）分支引用
  if (parentSha) {
    await api(tok, `/repos/${repo}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false })
    })
  } else {
    await api(tok, `/repos/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha })
    })
  }
  console.log(`\n✅ 已推送 ${entries.length} 个文件到 ${repo}@${branch}：${commit.sha.slice(0, 7)}`)
  console.log(`   https://github.com/${repo}`)
}

main().catch((err) => {
  console.error(String(err?.message ?? err))
  process.exit(1)
})

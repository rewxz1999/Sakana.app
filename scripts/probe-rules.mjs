// 探测 KazumiRules 规则仓库结构
import { createRequire } from 'node:module'
const { default: axios } = createRequire(import.meta.url)('axios')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'

async function get(url) {
  const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': UA }, validateStatus: () => true })
  return res
}

console.log('=== 1. GitHub API 仓库树 ===')
const tree = await get('https://api.github.com/repos/Predidit/KazumiRules/git/trees/main?recursive=1')
console.log('status:', tree.status)
if (tree.status === 200) {
  const paths = tree.data.tree.map((t) => t.path).filter((p) => p.endsWith('.json'))
  console.log('JSON 文件数:', paths.length, '| 样本:', paths.slice(0, 10).join(', '))
}

console.log('\n=== 2. gitcode 镜像探测 ===')
for (const u of [
  'https://gitcode.com/gh_mirrors/ka/KazumiRules',
  'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/main/README.md',
  'https://gitcode.com/gh_mirrors/ka/KazumiRules/-/raw/main/README.md'
]) {
  const r = await get(u)
  const body = String(r.data ?? '')
  console.log(`${r.status} ${body.length}B ${u}`)
  if (body.includes('Kazumi')) console.log('  片段:', body.slice(0, 120).replace(/\s+/g, ' '))
}

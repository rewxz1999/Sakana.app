import { createRequire } from 'node:module'
const { default: axios } = createRequire(import.meta.url)('axios')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
async function get(url) {
  const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': UA }, validateStatus: () => true })
  return res
}

console.log('=== GitHub 树真实路径（含目录） ===')
for (const branch of ['main', 'master']) {
  const r = await get(`https://api.github.com/repos/Predidit/KazumiRules/git/trees/${branch}?recursive=1`)
  console.log(`branch ${branch}: HTTP ${r.status}`)
  if (r.status === 200) {
    const paths = r.data.tree.map((t) => t.path)
    console.log('前 12 条路径:', paths.slice(0, 12).join(' | '))
    break
  }
}

console.log('\n=== GitHub raw 直链 ===')
const gh = await get('https://raw.githubusercontent.com/Predidit/KazumiRules/main/AGE.json')
console.log('main/AGE.json:', gh.status, String(gh.data ?? '').length)
const gh2 = await get('https://raw.githubusercontent.com/Predidit/KazumiRules/master/AGE.json')
console.log('master/AGE.json:', gh2.status, String(gh2.data ?? '').length)

import { createRequire } from 'node:module'
const { default: axios } = createRequire(import.meta.url)('axios')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
async function getJson(url) {
  const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': UA }, validateStatus: () => true })
  if (res.status !== 200) return { ok: false, status: res.status }
  try {
    return { ok: true, data: typeof res.data === 'string' ? JSON.parse(res.data) : res.data }
  } catch {
    return { ok: false, status: 'parse' }
  }
}

console.log('=== index.json（GitHub raw） ===')
const idx = await getJson('https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json')
if (idx.ok) {
  const data = idx.data
  console.log('类型:', typeof data, Array.isArray(data) ? 'array' : 'object')
  console.log('前 800 字:', JSON.stringify(data).slice(0, 800))
  // 试 gitcode
  const idx2 = await getJson('https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/main/index.json')
  console.log('\ngitcode index.json:', idx2.ok ? `OK ${JSON.stringify(idx2.data).length}B` : `失败(${idx2.status})`)
} else {
  console.log('失败:', idx.status)
}

console.log('\n=== AGE.json 完整结构 ===')
const age = await getJson('https://raw.githubusercontent.com/Predidit/KazumiRules/main/AGE.json')
if (age.ok) {
  console.log(JSON.stringify(age.data, null, 1).slice(0, 4000))
}

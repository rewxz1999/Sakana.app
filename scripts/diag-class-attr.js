// 诊断：站点搜索结果里 class 属性的真实写法（用于判断精确 @class 匹配是否过时）
// 用法：node scripts/diag-class-attr.js <url> <关键词片段>
const axios = require('axios')
const url = process.argv[2]
const needle = process.argv[3] || 'public-list-box'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

;(async () => {
  const r = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': UA }, validateStatus: () => true })
  const h = String(r.data)
  console.log(`HTTP ${r.status} ${h.length}B`)
  const re = new RegExp(`class="[^"]*${needle}[^"]*"`, 'g')
  const found = [...h.matchAll(re)].slice(0, 5)
  console.log(`含 ${needle} 的 class 属性 ${found.length} 种写法：`)
  for (const f of found) console.log('  ', f[0])
  console.log(`出现次数: ${(h.match(new RegExp(needle, 'g')) || []).length}`)
})()

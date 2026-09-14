// 诊断某条规则的三个阶段（搜索 / 剧集页 / 播放页），把 HTML 存到 .tmp-rules/ 供分析
// 用法：node scripts/diag-rule-site.js <规则名> <关键词>
const axios = require('axios')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { readFileSync } = require('node:fs')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const name = process.argv[2] || 'ezdmw'
const kw = process.argv[3] || '败犬女主太多了'
const OUT = join(__dirname, '..', '.tmp-rules')
mkdirSync(OUT, { recursive: true })

const storePath = join(process.env.APPDATA || '', 'sakana', 'data', 'rules.json')
const rules = JSON.parse(readFileSync(storePath, 'utf-8'))
const rule = rules.find((r) => (r.name || '').toLowerCase() === name.toLowerCase())
if (!rule) {
  console.log('规则不存在:', name, '可用:', rules.map((r) => r.name).join(','))
  process.exit(1)
}
console.log(`规则 ${rule.name} baseUrl=${rule.baseUrl} useWebview=${rule.useWebview}`)
console.log('search.url =', rule.search?.url)
console.log('search.listXPath =', rule.search?.listXPath)
console.log('episodes.linesXPath =', rule.episodes?.linesXPath)
console.log('episodes.episodesXPath =', rule.episodes?.episodesXPath)

const get = async (url, headers = {}) => {
  const t0 = Date.now()
  try {
    const r = await axios.get(url, {
      timeout: 20000,
      responseType: 'text',
      headers: { 'User-Agent': UA, ...headers },
      validateStatus: () => true
    })
    console.log(`GET ${url}\n   → HTTP ${r.status} ${String(r.data).length}B ${Date.now() - t0}ms`)
    return { status: r.status, text: String(r.data) }
  } catch (e) {
    console.log(`GET ${url}\n   → 失败: ${String(e.message).slice(0, 120)}`)
    return null
  }
}

;(async () => {
  const searchUrl = String(rule.search?.url ?? '').replace('@keyword', encodeURIComponent(kw))
  const s = await get(searchUrl, JSON.parse(rule.search?.headers || '{}'))
  if (s) {
    const f = join(OUT, `${name}-search.html`)
    writeFileSync(f, s.text)
    console.log(`   已存 ${f}`)
    // 粗看条目结构：列出正文里的 a 标签与 li 结构数量
    const links = [...s.text.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,60}?)<\/a>/g)].slice(0, 12)
    console.log('  前若干链接:')
    for (const m of links) console.log(`    ${m[1].slice(0, 70)}  |  ${m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)}`)
    console.log(`  含 <li> 数量=${(s.text.match(/<li/g) || []).length}，含 a 数量=${(s.text.match(/<a /g) || []).length}`)
  }
  const ep = rule.episodes?.url ? String(rule.episodes.url).replace('@source', '') : ''
  if (ep) await get(ep)
})()

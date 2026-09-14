const https = require('https')
const xpathHtml = require('xpath-html')
const { DOMParser } = require('@xmldom/xmldom')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const KW = process.argv[2] || '败犬女主太多了'
const BASE = 'https://raw.githubusercontent.com/Predidit/KazumiRules/main'

function get(url, headers) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': UA, ...(headers || {}) }, timeout: 20000 }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      })
      .on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }))
  })
}

;(async () => {
  for (const name of ['baimao', 'AGE', 'akianime']) {
    const r = await get(`${BASE}/${name}.json`)
    const j = JSON.parse(r.body)
    const searchUrl = String(j.searchURL).replace('@keyword', encodeURIComponent(KW))
    const page = await get(searchUrl, j.userAgent ? { 'User-Agent': j.userAgent } : undefined)
    console.log(`\n=== ${name} (HTTP ${page.status}, ${page.body.length}B) ===`)
    console.log(`  searchList:   ${j.searchList}`)
    console.log(`  searchName:   ${j.searchName}`)
    console.log(`  searchResult: ${j.searchResult}`)
    // 用与应用一致的 xpath-html 进行求值
    let doc
    try {
      doc = xpathHtml.fromPageSource(page.body)
    } catch (e) {
      console.log('  xpath-html 解析失败:', e.message)
      continue
    }
    const tryEval = (label, expr, relative) => {
      try {
        const e = relative ? expr.replace(/^\.\//, '//') : expr
        const nodes = doc.findElements(e)
        console.log(`  ${label} (${e}) → ${nodes.length} 个节点`)
        return nodes
      } catch (err) {
        console.log(`  ${label} 求值异常: ${String(err.message).slice(0, 120)}`)
        return []
      }
    }
    const list = tryEval('searchList', j.searchList, false)
    if (list.length > 0) {
      tryEval('searchName(绝对)', j.searchName, true)
      tryEval('searchResult(绝对)', j.searchResult, true)
      const first = list[0]
      const html = typeof first.outerHTML === 'string' ? first.outerHTML : String(first.toString())
      console.log(`  首个条目片段: ${html.replace(/\s+/g, ' ').slice(0, 220)}`)
    }
  }
})()

// 诊断：逐条规则搜索 URL 的实际返回 + listXPath 命中数（用应用同款 xpath-html）
// 用法：node scripts/diag-rule-search.js "从零开始的异世界生活" [规则名...]
const axios = require('axios')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const xhtml = require('xpath-html')
const { default: xhtmlDefault } = { default: xhtml }
void xhtmlDefault

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const kw = process.argv[2] || '从零开始的异世界生活'
const only = process.argv.slice(3)
const storePath = join(process.env.APPDATA || '', 'sakana', 'data', 'rules.json')
const rules = JSON.parse(readFileSync(storePath, 'utf-8'))

;(async () => {
  for (const r of rules) {
    if (only.length && !only.some((o) => (r.name || '').toLowerCase().includes(o.toLowerCase()))) continue
    const tpl = String(r.search?.url ?? '')
    if (!tpl) {
      console.log(`\n=== ${r.name} ===\n  ❌ 搜索 URL 为空（规则定义缺失）baseUrl=${r.baseUrl}`)
      continue
    }
    const url = tpl.replace('@keyword', encodeURIComponent(kw))
    const t0 = Date.now()
    try {
      const res = await axios.get(url, {
        timeout: 20000,
        responseType: 'text',
        headers: { 'User-Agent': UA, ...(JSON.parse(r.search?.headers || '{}') || {}) },
        validateStatus: () => true,
        maxRedirects: 5
      })
      const html = String(res.data)
      let hits = -1
      let err = ''
      try {
        const doc = (xhtml.default ?? xhtml).fromPageSource(html)
        hits = doc.findElements(String(r.search.listXPath ?? '')).length
      } catch (e) {
        err = String(e.message).slice(0, 60)
      }
      console.log(
        `\n=== ${r.name} ===\n  ${url.slice(0, 110)}\n  HTTP ${res.status} ${html.length}B ${Date.now() - t0}ms listXPath 命中=${hits}${err ? ` (求值失败: ${err})` : ''}`
      )
      const hasJs = /window\.location|document\.write|<script[^>]*src=/.test(html)
      const title = (/<title>([\s\S]{0,60}?)<\/title>/.exec(html) ?? [])[1] ?? ''
      console.log(`  标题=${title.replace(/\s+/g, ' ').trim()}  含脚本=${hasJs ? '是' : '否'}`)
    } catch (e) {
      console.log(`\n=== ${r.name} ===\n  ${url.slice(0, 110)}\n  ❌ 请求失败: ${String(e.message).slice(0, 110)}`)
    }
  }
})()

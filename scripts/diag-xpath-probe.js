// 诊断：同一份 HTML 上用 xpath-html 试多种 XPath，定位"字符串在但 XPath 命中 0"的原因
const axios = require('axios')
const xhtml = require('xpath-html')
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const url = process.argv[2]
const EXPRS = [
  '//div',
  "//div[@class='public-list-box search-box flex rel']",
  "//*[@class='public-list-box search-box flex rel']",
  "//div[contains(@class,'public-list-box')]",
  "//*[contains(@class,'public-list-box')]",
  "//ul[@class='anthology-list-play size']",
  "//li/a"
]

;(async () => {
  const r = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': UA }, validateStatus: () => true })
  const html = String(r.data)
  const doc = (xhtml.default ?? xhtml).fromPageSource(html)
  console.log(`HTTP ${r.status} ${html.length}B`)
  for (const e of EXPRS) {
    let n = -1
    let err = ''
    try {
      n = doc.findElements(e).length
    } catch (er) {
      err = ` (${String(er.message).slice(0, 50)})`
    }
    console.log(`  ${String(n).padStart(5)}  ${e}${err}`)
  }
})()

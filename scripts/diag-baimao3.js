const https = require('https')
const xpathHtml = require('xpath-html')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function get(url, redirects = 5) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, timeout: 20000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume()
          return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1))
        }
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => resolve({ status: res.statusCode, body: d }))
      })
      .on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }))
  })
}

function enhance(expr) {
  return expr.replace(/(^|[/.])([a-zA-Z][a-zA-Z0-9_-]*)(?=\s*\[|$|\/)/g, (m, p1, p2) =>
    p2 === 'x' ? m : `${p1}x:${p2}`
  )
}

;(async () => {
  const page = await get('https://www.baimaodm.com/show/464376.html')
  console.log(`详情页 HTTP ${page.status} ${page.body.length}B`)
  const doc = xpathHtml.fromPageSource(page.body)

  const candidates = [
    '//div[contains(@class,"main0")]/div[contains(@class,"movurl")]',
    '//div[@id="main0"]/div[contains(@class,"movurl")]',
    '//div[contains(@class,"movurl")]'
  ]
  for (const c of candidates) {
    try {
      const n = doc.findElements(c)
      console.log(`线路 XPath ${c} → ${n.length} 个`)
    } catch (e) {
      console.log(`线路 XPath ${c} → 异常 ${e.message}`)
    }
  }
  // 取第一个线路节点，测试条目相对 XPath
  const lines = doc.findElements(candidates[0])
  if (lines.length) {
    for (const epExpr of ['.//li/a', './/a', 'li/a']) {
      try {
        const raw = doc.select(enhance(epExpr), lines[0], false)
        const arr = Array.isArray(raw) ? raw : raw ? [raw] : []
        const first = arr[0]
        const text = first ? String(first.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) : ''
        const href = first && first.getAttribute ? first.getAttribute('href') : ''
        console.log(`条目 XPath ${epExpr} → ${arr.length} 个  ${text} ${href}`)
      } catch (e) {
        console.log(`条目 XPath ${epExpr} → 异常 ${e.message}`)
      }
    }
  }
  // 搜索页验证
  const s = await get('https://www.baimaodm.com/s_all?ex=1&kw=%E8%B4%A5%E7%8A%AC%E5%A5%B3%E4%B8%BB%E5%A4%AA%E5%A4%9A%E4%BA%86')
  const sdoc = xpathHtml.fromPageSource(s.body)
  const items = sdoc.findElements('//div[contains(@class,"lpic")]/ul/li')
  console.log(`\n搜索页条目数: ${items.length}`)
  if (items.length) {
    const raw = sdoc.select(enhance('.//h2/a'), items[0], false)
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : []
    console.log(
      `  条目名/链接: ${arr.length} 个`,
      arr[0] ? String(arr[0].textContent).trim().slice(0, 20) + ' ' + arr[0].getAttribute('href') : '(无)'
    )
  }
})()

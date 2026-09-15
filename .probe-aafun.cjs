const axios = require('axios')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
;(async () => {
  // aafun 规则 = moonci.com：搜索 → 剧集页 → 选集列表
  const kw = encodeURIComponent('败犬女主太多了')
  const s = await axios.get(`https://www.moonci.com/search/-------------.html?wd=${kw}`, { headers: { 'User-Agent': UA }, timeout: 20000, responseType: 'text' })
  const detail = (/href="(\/anime\/\d+\.html)"/.exec(s.data) ?? [])[1] || (/href="(\/detail\/\d+\.html)"/.exec(s.data) ?? [])[1]
  console.log('搜索页命中详情链接:', detail)
  if (!detail) { console.log('搜索页片段:', String(s.data).replace(/\s+/g,' ').slice(0, 400)); return }
  const d = await axios.get('https://www.moonci.com' + detail, { headers: { 'User-Agent': UA }, timeout: 20000, responseType: 'text' })
  const links = [...String(d.data).matchAll(/<a[^>]+href="([^"]*\/play\/[^"]+)"[^>]*>([^<]{0,24})<\/a>/g)].map((m) => ({ href: m[1], name: m[2].trim() }))
  console.log('剧集链接数:', links.length)
  console.log('前 6 条:', JSON.stringify(links.slice(0, 6), null, 1))
  console.log('后 3 条:', JSON.stringify(links.slice(-3), null, 1))
  // 线路容器
  const lines = [...String(d.data).matchAll(/<ul[^>]*class="[^"]*hl-plays-list[^"]*"[^>]*>/g)].length
  console.log('hl-plays-list 容器数:', lines)
})()

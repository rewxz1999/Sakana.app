// 用真实解析器验证真实页面（Node 24 原生 TS 类型剥离）
import { parseCalendar, parseSearchPage, parseSubjectPage, parseRatingOnly } from '../src/main/services/bangumiHtml.ts'
import { createRequire } from 'node:module'
const { default: axios } = createRequire(import.meta.url)('axios')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function get(url) {
  const res = await axios.get(url, {
    timeout: 20000,
    responseType: 'text',
    headers: { 'User-Agent': UA },
    validateStatus: () => true
  })
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  return String(res.data)
}

async function main() {
  console.log('=== 1. 日历解析 ===')
  const calHtml = await get('https://bangumi.pro/calendar')
  const days = parseCalendar(calHtml)
  console.log(`解析出 ${days.length} 天`)
  let total = 0
  for (const d of days) {
    console.log(`  ${d.weekday.cn}(${d.weekday.en}): ${d.items.length} 部`)
    total += d.items.length
  }
  console.log(`总计 ${total} 条目`)
  if (days[0]?.items[0]) {
    const first = days[0].items[0]
    console.log('  样本:', JSON.stringify({ id: first.id, cn: first.name_cn, name: first.name, cover: first.images?.common?.slice(0, 80) }))
  }

  console.log('\n=== 2. 详情页解析 ===')
  const subjHtml = await get('https://bangumi.pro/subject/255209')
  const detail = parseSubjectPage(subjHtml, 255209)
  console.log('名称:', detail.name_cn, '|', detail.name)
  console.log('评分:', detail.rating?.score, '人数:', detail.rating?.total, 'rank:', detail.rating?.rank)
  console.log('标签:', detail.tags.slice(0, 5).map((t) => t.name).join(' / '))
  console.log('简介:', detail.summary.slice(0, 60).replace(/\n/g, ' ⏎ '))
  console.log('infobox 行数:', detail.infobox.length, '| 放送:', detail.air_date, '| 话数:', detail.eps)
  const keyRows = detail.infobox.filter((x) => ['动画制作', '导演', '声优'].includes(x.key))
  console.log('关键信息:', JSON.stringify(keyRows.slice(0, 3)))
  console.log('封面:', detail.images?.common?.slice(0, 90))

  console.log('\n=== 3. 评分提取 ===')
  console.log('ratingOnly:', JSON.stringify(parseRatingOnly(subjHtml)))

  console.log('\n=== 4. 搜索解析 ===')
  const searchHtml = await get('https://bangumi.pro/subject_search/%E5%AD%A4%E7%8B%AC%E6%91%87%E6%BB%9A?cat=2')
  const results = parseSearchPage(searchHtml)
  console.log(`搜索结果 ${results.length} 条`)
  for (const r of results.slice(0, 3)) {
    console.log('  ', JSON.stringify({ id: r.id, cn: r.name_cn, name: r.name, rating: r.rating?.score, date: r.air_date, img: !!r.images }))
  }
}

main().then(() => console.log('\n验证完成')).catch((err) => {
  console.error('失败:', err.message)
  process.exit(1)
})

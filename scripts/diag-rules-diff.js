// 对照：本地存储的规则 vs KazumiRules 仓库最新规则（找出过时的定义）
// 用法：node scripts/diag-rules-diff.js
const axios = require('axios')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const BASE = 'https://cdn.jsdelivr.net/gh/Predidit/KazumiRules@main'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const storePath = join(process.env.APPDATA || '', 'sakana', 'data', 'rules.json')

;(async () => {
  const idx = (await axios.get(`${BASE}/index.json`, { timeout: 20000, headers: { 'User-Agent': UA } })).data
  console.log(`仓库规则 ${idx.length} 条: ${idx.map((r) => r.name).join(', ')}\n`)

  const local = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf-8')) : []
  console.log(`本地存储 ${local.length} 条: ${local.map((r) => r.name).join(', ')}\n`)

  for (const item of idx) {
    const raw = (await axios.get(`${BASE}/${encodeURIComponent(item.name)}.json`, { timeout: 20000, headers: { 'User-Agent': UA } })).data
    const mine = local.find((r) => (r.name || '').toLowerCase() === item.name.toLowerCase())
    console.log(`\n=== ${item.name} (仓库 v${item.version}${item.author ? ' · ' + item.author : ''}) ===`)
    console.log(`  仓库 baseURL   : ${raw.baseURL}`)
    console.log(`  仓库 searchURL : ${raw.searchURL}`)
    console.log(`  仓库 searchList: ${raw.searchList ?? raw.searchJsonList ?? '(JSON)'}`)
    console.log(`  仓库 searchName: ${raw.searchName ?? raw.searchJsonName ?? ''}`)
    console.log(`  仓库 searchRes : ${raw.searchResult ?? raw.searchJsonResult ?? ''}`)
    console.log(`  仓库 chapterRoads : ${raw.chapterRoads ?? raw.chapterJsonRoads ?? '(JSON)'}`)
    console.log(`  仓库 chapterResult: ${raw.chapterResult ?? raw.chapterJsonResult ?? ''}`)
    if (!mine) {
      console.log('  本地: ❌ 未导入')
      continue
    }
    const same = (a, b) => String(a ?? '') === String(b ?? '')
    const rows = [
      ['baseUrl', mine.baseUrl, raw.baseURL],
      ['search.url', mine.search?.url, raw.searchURL],
      ['search.listXPath', mine.search?.listXPath, raw.searchList],
      ['search.itemNameXPath', mine.search?.itemNameXPath, raw.searchName],
      ['search.itemLinkXPath', mine.search?.itemLinkXPath, raw.searchResult],
      ['episodes.linesXPath', mine.episodes?.linesXPath, raw.chapterRoads],
      ['episodes.episodesXPath', mine.episodes?.episodesXPath, raw.chapterResult],
      ['search.listJsonPath', mine.search?.listJsonPath, raw.searchJsonList],
      ['episodes.linesJsonPath', mine.episodes?.linesJsonPath, raw.chapterJsonRoads],
      ['episodes.episodesJsonPath', mine.episodes?.episodesJsonPath, raw.chapterJsonResult]
    ]
    for (const [label, a, b] of rows) {
      if (!same(a, b)) console.log(`  本地≠仓库 ${label}:\n    本地: ${a}\n    仓库: ${b}`)
    }
    console.log(`  本地 useWebview=${mine.useWebview} 版本=${mine.version ?? '-'}`)
  }
})()

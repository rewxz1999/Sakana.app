// 剧集线路规范化单测（不需要启动 Electron）：
//   node scripts/test-episode-normalize.js
// 用 esbuild 把 TS 源文件打成 CJS，并把 `../log` 换成空实现（避免把 electron 拖进来）。
const { build } = require('esbuild')
const { join } = require('node:path')
const { mkdirSync } = require('node:fs')

async function main() {
  const out = join(__dirname, '..', '.tmp-test')
  mkdirSync(out, { recursive: true })
  const outfile = join(out, 'episodeNormalize.cjs')

  await build({
    entryPoints: [join(__dirname, '..', 'src', 'main', 'services', 'episodeNormalize.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'warning',
    plugins: [
      {
        name: 'stub-log',
        setup(b) {
          b.onResolve({ filter: /(^|\/)log$/ }, () => ({ path: 'stub-log', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'exports.log = { append: () => {} }',
            loader: 'js'
          }))
        }
      }
    ]
  })

  const { normalizeEpisodeGroups } = require(outfile)

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}\n     得到: ${a}\n     期望: ${e}`)
  }
}

const ep = (name, link = '/p/1') => ({ name, link })
const names = (g) => g.episodes.map((e) => e.name)

console.log('剧集线路规范化：')

// ① 线路名是整串集名 → 改名为「线路 N」
check(
  '拼接线路名改为「线路 1」',
  normalizeEpisodeGroups([
    { lineName: '第01集第02集第03集第04集', episodes: [ep('第01集'), ep('第02集')] }
  ]).map((g) => g.lineName),
  ['线路 1']
)

// ② 正常线路名保持不变
check(
  '正常线路名保留',
  normalizeEpisodeGroups([
    { lineName: '七色A线', episodes: [ep('第01集'), ep('第02集')] },
    { lineName: '七色B线', episodes: [ep('第01集'), ep('第02集')] }
  ]).map((g) => g.lineName),
  ['七色A线', '七色B线']
)

// ③ 一个列表里两条线路（编号 1..4 后重启）→ 拆成两条
const merged = normalizeEpisodeGroups([
  {
    lineName: '',
    episodes: [
      ep('第01集'),
      ep('第02集'),
      ep('第03集'),
      ep('第04集'),
      ep('第01集'),
      ep('第02集'),
      ep('第03集'),
      ep('第04集')
    ]
  }
])
check('合并列表按编号重启拆成 2 条', merged.length, 2)
check('拆分后集数分别为 4/4', merged.map((g) => g.episodes.length), [4, 4])
check('拆分后线路名', merged.map((g) => g.lineName), ['线路 1-1', '线路 1-2'])

// ④ 正常递增的 12 集不能被误切
const normal12 = normalizeEpisodeGroups([
  { lineName: '线路一', episodes: Array.from({ length: 12 }, (_, i) => ep(`第${String(i + 1).padStart(2, '0')}集`)) }
])
check('连续 12 集不拆分', normal12.length, 1)
check('连续 12 集集数不变', normal12[0].episodes.length, 12)

// ⑤ 纯数字集名且重启（01..06 / 01..06）
const numeric = normalizeEpisodeGroups([
  { lineName: '', episodes: ['01', '02', '03', '04', '05', '06', '01', '02', '03', '04', '05', '06'].map((n) => ep(n)) }
])
check('纯数字集名按重启拆分', numeric.map((g) => g.episodes.length), [6, 6])

// ⑥ 集名没有编号（如站点用「上一集/下一集」）→ 不拆、只改名
const noNum = normalizeEpisodeGroups([{ lineName: '第01集第02集', episodes: [ep('上集'), ep('下集')] }])
check('无编号时只改名不拆', noNum.length, 1)

// ⑦ 完全重名的多条线路统一编号
check(
  '重名线路统一编号',
  normalizeEpisodeGroups([
    { lineName: '线路', episodes: [ep('第01集')] },
    { lineName: '线路', episodes: [ep('第01集')] }
  ]).map((g) => g.lineName),
  ['线路 1', '线路 2']
)

// ⑧ 幂等：跑两次结果一致
const once = normalizeEpisodeGroups([{ lineName: '', episodes: ['01', '02', '03', '01', '02', '03'].map((n) => ep(n)) }])
check('幂等', normalizeEpisodeGroups(once), once)

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

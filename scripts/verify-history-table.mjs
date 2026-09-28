/**
 * 番剧表「历史表」弹窗自检（纯逻辑 + 静态接线检查）。
 *
 * 为什么要有它：这个弹窗的核心是「年份横轴的滚动位置 ↔ 选中年份」这段换算，
 * 它错起来**不会报任何错**，只会让交互悄悄失灵。v0.3.7 第一版就踩到了：
 * 卡上同时写了容器 `gap` 和自身 `margin`，真实步长 96px 而代码按 90px 算，
 * 结果「停下后吸附」把轴又拽回原处（拖到 2025，抬头仍写 2026）。
 * 所以这里把算法从组件里抽出来（`axisIndexAtScroll`）并逐值断言，
 * 再用静态检查把「CSS 与 JS 的步长必须一致」钉死。
 *
 * 用法（项目根目录）：node scripts/verify-history-table.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/**
 * 组件是 .tsx（含 JSX），Node 的类型擦除不能直接跑它，所以这里**只**把常量与两个纯函数
 * 抠出来求值 —— 抠出来的仍是**真实源码**，不是抄一份（抄一份就失去意义了）。
 * 落地成 .ts 再 import：`data:` URL 会被当成纯 JS，带类型标注的函数体会语法报错；
 * 写成 .ts 文件才能让 Node 24 的类型擦除生效（与 import `src/shared/favoritesSeason.ts` 同理）。
 */
const src = readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'HistoryTableModal.tsx'), 'utf8')

function grabConst(name) {
  // 组件的常量是模块内 `const`（只有函数才是 export），所以两种写法都要认
  const m = new RegExp(`^(?:export )?const ${name} = ([^\\n]+)`, 'm').exec(src)
  if (!m) throw new Error(`源码里找不到常量 ${name}`)
  return m[1].trim()
}
function grabFunction(name) {
  const start = src.indexOf(`export function ${name}(`)
  if (start < 0) throw new Error(`源码里找不到函数 ${name}`)
  // 从函数头开始做括号配对，取到完整的函数体
  let i = src.indexOf('{', start)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(start, j + 1).replace(/^export /, '')
    }
  }
  throw new Error(`函数 ${name} 的花括号不配对`)
}

const snippet = [
  `const CHIP_W = ${grabConst('CHIP_W')}`,
  `const CHIP_GAP = ${grabConst('CHIP_GAP')}`,
  `const CHIP_STEP = ${grabConst('CHIP_STEP')}`,
  `const EARLIEST_YEAR = ${grabConst('EARLIEST_YEAR')}`,
  `const SETTLE_MS = ${grabConst('SETTLE_MS')}`,
  // seasonIndexOfMonth 用项目里那一份真实实现的同一算法（1-3 冬 / 4-6 春 / 7-9 夏 / 10-12 秋）
  `const seasonIndexOfMonth = (month: number): number => { const m = Math.min(12, Math.max(1, Math.trunc(month) || 1)); return Math.floor((m - 1) / 3) + 1 }`,
  grabFunction('seasonOrderFor'),
  grabFunction('axisIndexAtScroll'),
  'export { CHIP_W, CHIP_GAP, CHIP_STEP, EARLIEST_YEAR, SETTLE_MS, seasonOrderFor, axisIndexAtScroll }'
].join('\n')

mkdirSync(join(root, '.e2e'), { recursive: true })
const snippetFile = join(root, '.e2e', '.tmp-history-check.ts')
writeFileSync(
  snippetFile,
  `/* 由 scripts/verify-history-table.mjs 生成，从真实源码里抠出来的常量与纯函数；临时文件，可随时删除 */\n${snippet}\n`,
  'utf8'
)

const mod = await import(pathToFileURL(snippetFile).href)

const { CHIP_W, CHIP_GAP, CHIP_STEP, EARLIEST_YEAR, SETTLE_MS, seasonOrderFor, axisIndexAtScroll } = mod

let passed = 0
const failures = []
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) passed++
  else failures.push(`${name}\n    期望: ${e}\n    实际: ${a}`)
}
const section = (t) => console.log(`\n=== ${t} ===`)

// ------------------------------------------------------------------
section('1. 常量与年份范围')
check('最早年份 = 2005（用户要求「只到 2005，再往前不支持」）', EARLIEST_YEAR, 2005)
check('卡宽 / 间隙 / 步长 自洽', [CHIP_W, CHIP_GAP, CHIP_STEP], [84, 6, 90])
check('步长 = 卡宽 + 间隙', CHIP_STEP, CHIP_W + CHIP_GAP)
check('停下判定是正数毫秒（0 会让滑动中每一步都提交）', SETTLE_MS > 0, true)

// ------------------------------------------------------------------
section('2. 滚动位置 → 年份下标（含边界与脏值）')
const N = 22 // 2005..2026
const CASES = [
  [0, 0],
  [45, 1], // 半格 → 四舍五入到下一格
  [90, 1],
  [1800, 20], // 第 20 格 = 2025
  [1890, 21], // 最后一格 = 2026（最大可滚值）
  [1920, 21], // 超过最大可滚值也不能越界（就是 v0.3.7 第一版算出脏值的那个输入）
  [99999, 21],
  [-100, 0],
  [NaN, 0],
  [Infinity, 0],
  [0, 21] // 占位：下一行会覆盖
]
for (const [left, want] of CASES.slice(0, 10)) {
  check(`scrollLeft=${left} → 下标 ${want}`, axisIndexAtScroll(left, N), want)
}
check('奇数张卡时也不越界', axisIndexAtScroll(99999, 3), 2)
check('yearCount=0 不崩（返回 0）', axisIndexAtScroll(500, 0), 0)
// 每一格的中心都应解析回它自己（首尾与中间都验）
let centerOk = true
for (let i = 0; i < N; i++) if (axisIndexAtScroll(i * CHIP_STEP, N) !== i) centerOk = false
check('每一格「正好居中」时都解析回自己', centerOk, true)
// 最大可滚值正好等于最后一格居中：容器内边距是 calc(50% - 半张卡) 时成立
check('最大可滚值 = 最后一格居中的位置', (N - 1) * CHIP_STEP, 1890)

// ------------------------------------------------------------------
section('3. 季度加载顺序')
check('历史年份：冬→春→夏→秋', seasonOrderFor(2019, new Date('2026-09-29T12:00:00')), [1, 2, 3, 4])
check('今年（9 月 = 夏）先加载夏季，再补齐其余三季', seasonOrderFor(2026, new Date('2026-09-29T12:00:00')), [3, 1, 2, 4])
check('今年 1 月 = 冬', seasonOrderFor(2026, new Date('2026-01-05T12:00:00')), [1, 2, 3, 4])
check('今年 4 月 = 春', seasonOrderFor(2026, new Date('2026-04-05T12:00:00')), [2, 1, 3, 4])
check('今年 10 月 = 秋', seasonOrderFor(2026, new Date('2026-10-05T12:00:00')), [4, 1, 2, 3])
check('四个季度一个不少（去重且长度恒为 4）', [1, 2, 3, 4].every((m) => seasonOrderFor(2026, new Date(2026, m - 1, 15)).length === 4), true)
check('四个季度互不重复', [1, 2, 3, 4].every((m) => new Set(seasonOrderFor(2026, new Date(2026, m - 1, 15))).size === 4), true)

// ------------------------------------------------------------------
section('4. 静态接线检查（读组件源码）')
// 横轴：容器 gap 必须 == CHIP_GAP，且卡上不能再写 margin（这就是 v0.3.7 那个 bug）
const axisTag = src.slice(src.indexOf('ref={axisRef}'), src.indexOf('ref={axisRef}') + 700)
check('横轴容器带 gap-1.5（= 6px）', /gap-1\.5/.test(axisTag), true)
check('年份卡上不再写 marginRight（否则步长会变成 96）', /marginRight/.test(src), false)
check('横轴内边距用 calc(50% - 半张卡) 让首尾也能居中', src.includes('calc(50% - ${CHIP_W / 2}px)'), true)
check('滚动位置换算只走 axisIndexAtScroll（不另写一套）', /years\[axisIndexAtScroll\(/.test(src), true)
check('滚轮用原生非 passive 监听（React 的 onWheel 是 passive，preventDefault 无效）', src.includes("addEventListener('wheel', onWheel, { passive: false })"), true)
check('支持按住拖动（setPointerCapture）', src.includes('setPointerCapture'), true)
// 加载只依赖「选中年份」，不依赖「待选年份」——这就是「停下才加载」的实现方式
check('加载只由 year 触发', /if \(open\) loadYear\(year\)/.test(src), true)
check('加载的依赖数组里只有 year（没有 pendingYear）', /\}, \[open, year, loadYear\]\)/.test(src), true)
check('滚动处理里不调用 loadYear（滚动中绝不加载）', /onAxisScroll[\s\S]{0,1200}?loadYear/.test(src), false)
check('停下后才提交年份（settleTimer 里 setYear）', /settleTimer\.current = window\.setTimeout\(\(\) => \{[\s\S]{0,200}?setYear\(y\)/.test(src), true)
// 屏蔽规则
check('复用番剧表屏蔽配置', src.includes('useScheduleBlock') && src.includes('blockReason'), true)
check('显示「已隐藏 N 部」', src.includes('已隐藏'), true)
// 缓存说明
check('说明里写清了本地缓存（主进程季度缓存）', /7 天/.test(src), true)

// ------------------------------------------------------------------
section('5. 与番剧表页面的接线')
const schedule = readFileSync(join(root, 'src', 'renderer', 'src', 'pages', 'SchedulePage.tsx'), 'utf8')
check('番剧表引入了历史表弹窗', schedule.includes("from '@/components/HistoryTableModal'"), true)
check('时间区域是可点按钮（不是 div）', /title="点击查看历史表/.test(schedule), true)
check('点击后打开弹窗', /onClick=\{\(\) => setHistoryOpen\(true\)\}/.test(schedule), true)
check('点弹窗里的番剧先关弹窗再跳详情', /setHistoryOpen\(false\)\s*\n\s*navigate\(`\/subject\/\$\{id\}`\)/.test(schedule), true)

// ------------------------------------------------------------------
console.log('\n================ 结果 ================')
console.log(`通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('全部断言通过 ✓')

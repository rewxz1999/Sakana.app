/**
 * 番剧表屏蔽规则自检（纯函数 + 节流队列）。
 *
 * 直接 import **真实源码** src/shared/scheduleBlock.ts（Node 24 自带 TS 类型擦除，
 * 不需要先编译）—— 所以下面的输入→输出就是产品代码的真实行为，不是测试里的副本。
 *
 * 用法（项目根目录）：
 *   node scripts/verify-schedule-block.mjs
 * 退出码 0 = 全部断言通过。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const m = await import(new URL('../src/shared/scheduleBlock.ts', import.meta.url).href)
const {
  BLOCK_LEVELS,
  DEFAULT_SCHEDULE_BLOCK,
  blockReason,
  isBlockingActive,
  parseCustomTags,
  resolveBlockConfig,
  shouldLoadTags,
  splitBlocked,
  summarizeBlocked,
  blockTagsOf,
  fetchTagsThrottled,
  TAG_FETCH_CONCURRENCY,
  TAG_FETCH_GAP_MS
} = m

let passed = 0
const failures = []
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
  } else {
    failures.push(`${name}\n    期望: ${e}\n    实际: ${a}`)
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`)
}

// ------------------------------------------------------------------
// 0. 分级标签表 + 默认值
// ------------------------------------------------------------------
section('0. 分级标签表与默认配置')
for (const level of BLOCK_LEVELS) {
  console.log(`L${level.level} ${level.title}：${level.tags.length ? level.tags.join(' / ') : '（用户自定义）'}`)
}
console.log('默认配置：', JSON.stringify(DEFAULT_SCHEDULE_BLOCK))
check('默认只开一级', [DEFAULT_SCHEDULE_BLOCK.l1, DEFAULT_SCHEDULE_BLOCK.l2, DEFAULT_SCHEDULE_BLOCK.l3], [true, false, false])
check('默认无自定义标签/黑名单', [DEFAULT_SCHEDULE_BLOCK.customTags.length, DEFAULT_SCHEDULE_BLOCK.blacklist.length], [0, 0])
check('老设置文件缺键 → 回落默认', resolveBlockConfig(null), DEFAULT_SCHEDULE_BLOCK)
check('老设置文件只有部分键 → 其余补默认', resolveBlockConfig({ l2: true }), {
  ...DEFAULT_SCHEDULE_BLOCK,
  l2: true
})
check('脏数据（NaN / 重复 id / 非数组）被清掉', resolveBlockConfig({ blacklist: [3, 3, 'x', NaN, 5] }).blacklist, [3, 5])

// ------------------------------------------------------------------
// 1. 匹配行为表（输入 → 输出）
// ------------------------------------------------------------------
section('1. blockReason 输入→输出（cfg 按用例单独给）')
const CASES = [
  {
    title: '默认配置：命中一级',
    id: 1,
    tags: ['恋爱', '子供向', '2026年7月'],
    cfg: DEFAULT_SCHEDULE_BLOCK,
    expect: '一级：子供向'
  },
  { title: '默认配置：不命中', id: 2, tags: ['恋爱', '奇幻'], cfg: DEFAULT_SCHEDULE_BLOCK, expect: null },
  { title: '默认配置：没标签（undefined）', id: 3, tags: undefined, cfg: DEFAULT_SCHEDULE_BLOCK, expect: null },
  { title: '默认配置：没标签（空数组）', id: 4, tags: [], cfg: DEFAULT_SCHEDULE_BLOCK, expect: null },
  {
    title: '默认配置：二级标签不命中（L2 关着）',
    id: 5,
    tags: ['泡面番'],
    cfg: DEFAULT_SCHEDULE_BLOCK,
    expect: null
  },
  { title: 'L1 关掉后同一个标签不命中', id: 6, tags: ['子供向'], cfg: { ...DEFAULT_SCHEDULE_BLOCK, l1: false }, expect: null },
  { title: 'L2 打开：泡面番', id: 7, tags: ['泡面番'], cfg: { ...DEFAULT_SCHEDULE_BLOCK, l2: true }, expect: '二级：泡面番' },
  { title: 'L2 打开：里番', id: 8, tags: ['里番'], cfg: { ...DEFAULT_SCHEDULE_BLOCK, l2: true }, expect: '二级：里番' },
  {
    title: 'L3 打开：标签 3D / 关键词 3d（大小写）',
    id: 9,
    tags: ['3D'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, l3: true },
    expect: '三级：3D'
  },
  {
    title: 'L3 打开：标签 3d（小写）',
    id: 10,
    tags: ['3d'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, l3: true },
    expect: '三级：3d'
  },
  {
    title: 'L3 打开：标签 3DCG（含 3d 即命中）',
    id: 11,
    tags: ['3DCG'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, l3: true },
    expect: '三级：3DCG'
  },
  {
    title: 'L3 打开：平台标签 腾讯视频',
    id: 12,
    tags: ['腾讯视频', '国产'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, l3: true },
    expect: '三级：腾讯视频'
  },
  {
    title: 'L3 打开：平台标签 芒果TV（关键词芒果tv）',
    id: 13,
    tags: ['芒果TV'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, l3: true },
    expect: '三级：芒果TV'
  },
  {
    title: 'L3 打开：国创 / 网文改 / 中国动画 这些补充标签',
    id: 14,
    tags: ['网文改'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, l3: true },
    expect: '三级：网文改'
  },
  {
    title: 'L3 打开：只打「中国」的日番不被误杀（故意不加裸中国/大陆）',
    id: 15,
    tags: ['中国', '历史'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, l3: true },
    expect: null
  },
  {
    title: '自定义标签：大小写不敏感（YURI vs yuri）',
    id: 16,
    tags: ['yuri'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, l1: false, customTags: ['YURI'] },
    expect: '四级：yuri'
  },
  {
    title: '自定义标签：去空格（"  美国 " 命中 美国）',
    id: 17,
    tags: ['美国'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, l1: false, customTags: parseCustomTags('  美国  ') },
    expect: '四级：美国'
  },
  {
    title: '自定义标签：包含匹配（后宫 命中 逆后宫）',
    id: 18,
    tags: ['逆后宫'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, l1: false, customTags: parseCustomTags('后宫') },
    expect: '四级：逆后宫'
  },
  {
    title: '黑名单优先于标签（同一部同时命中一级）',
    id: 255209,
    tags: ['子供向'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, blacklist: [255209] },
    expect: '黑名单'
  },
  {
    title: '黑名单命中不需要标签（tags 为空）',
    id: 255209,
    tags: [],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, blacklist: [255209] },
    expect: '黑名单'
  },
  {
    title: '优先级：二级先于三级（同时命中取更早的一级）',
    id: 19,
    tags: ['3D', '泡面番'],
    cfg: { ...DEFAULT_SCHEDULE_BLOCK, l1: false, l2: true, l3: true },
    expect: '二级：泡面番'
  }
]
console.log('| 用例 | 输入标签 | 配置(l1/l2/l3/自定义/黑名单) | 输出 |')
console.log('| --- | --- | --- | --- |')
for (const c of CASES) {
  const cfg = resolveBlockConfig(c.cfg)
  const got = blockReason({ id: c.id }, c.tags, cfg)
  const cfgText = `${cfg.l1 ? 1 : 0}/${cfg.l2 ? 1 : 0}/${cfg.l3 ? 1 : 0}/${
    cfg.customTags.length ? cfg.customTags.join('+') : '-'
  }/${cfg.blacklist.length ? cfg.blacklist.join('+') : '-'}`
  console.log(
    `| ${c.title} | ${c.tags === undefined ? '(undefined)' : c.tags.length ? c.tags.join('、') : '[]'} | ${cfgText} | ${
      got === null ? 'null（不屏蔽）' : got
    } |`
  )
  check(c.title, got, c.expect)
}

// ------------------------------------------------------------------
// 2. 开关全关：不命中 + 不发请求
// ------------------------------------------------------------------
section('2. 开关全关')
const OFF = { l1: false, l2: false, l3: false, customTags: [], blacklist: [] }
const ALL_TAGS = [...blockTagsOf(1), ...blockTagsOf(2), ...blockTagsOf(3)]
let offHits = 0
for (const tag of ALL_TAGS) {
  if (blockReason({ id: 1 }, [tag], OFF) !== null) offHits++
}
console.log(`全关时逐一尝试 ${ALL_TAGS.length} 个分级关键词，命中数 = ${offHits}`)
check('全关时任何标签都不命中', offHits, 0)
for (const level of [1, 2, 3]) {
  check(`全关时 L${level} 标签表命中数`, blockTagsOf(level).filter((t) => blockReason({ id: 1 }, [t], OFF)).length, 0)
}
check('shouldLoadTags(全关) = false', shouldLoadTags(OFF), false)
check('isBlockingActive(全关) = false', isBlockingActive(OFF), false)
check('shouldLoadTags(默认) = true（一级开着）', shouldLoadTags(DEFAULT_SCHEDULE_BLOCK), true)
check('只设黑名单时不需要标签', shouldLoadTags({ ...OFF, blacklist: [1] }), false)
check('只设黑名单时仍然有屏蔽规则', isBlockingActive({ ...OFF, blacklist: [1] }), true)

/** 模拟番剧表页的 effect：`if (!shouldLoadTags(cfg)) return; ensureTags(ids)` —— 用真实判据数请求次数 */
async function countRequestsForConfig(cfg) {
  let calls = 0
  const ids = [11, 22, 33, 44]
  if (shouldLoadTags(cfg)) {
    await fetchTagsThrottled(ids, async () => {
      calls++
      return ['子供向']
    })
  }
  return calls
}
check('全关时标签请求次数 = 0', await countRequestsForConfig(OFF), 0)
check('默认配置（一级开）标签请求次数 = 4', await countRequestsForConfig(DEFAULT_SCHEDULE_BLOCK), 4)

// ------------------------------------------------------------------
// 3. 真实番剧表（111 条真实 id + 假标签）过滤统计
// ------------------------------------------------------------------
section('3. 真实番剧表 111 条过滤统计')
const cachePath = join(root, 'data', 'userData', 'cache', 'bangumi', 'calendar.json')
let weekItems = []
try {
  const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
  const days = Array.isArray(raw.data) ? raw.data : raw.data?.days ?? []
  const seen = new Set()
  for (const day of days) {
    for (const item of day.items ?? []) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      weekItems.push({ id: item.id, name: item.name_cn || item.name })
    }
  }
  console.log(`读取真实缓存：${weekItems.length} 条（${cachePath}）`)
} catch (err) {
  console.log(`读不到真实缓存（${String(err)}），改用 20 条假数据`)
  weekItems = Array.from({ length: 20 }, (_, i) => ({ id: 1000 + i, name: `假番剧 ${i}` }))
}

/** 假标签：按 id 取模给不同条目挂上不同类型的标签（只用于验证过滤/统计逻辑） */
function fakeTags(id) {
  const k = id % 6
  if (k === 0) return ['恋爱', '奇幻']
  if (k === 1) return ['子供向', '美国']
  if (k === 2) return ['泡面番', '日常']
  if (k === 3) return ['3DCG', '国产']
  if (k === 4) return ['腾讯视频', '玄幻']
  return undefined // 第 6 类：没有标签（模拟"取不到标签"→ 必须不屏蔽）
}
const tagsById = {}
for (const it of weekItems) tagsById[it.id] = fakeTags(it.id)
const noTagCount = weekItems.filter((it) => tagsById[it.id] === undefined).length

function report(cfg, label) {
  const { kept, blocked } = splitBlocked(weekItems, tagsById, cfg)
  console.log(`\n[${label}] 共 ${weekItems.length} → 保留 ${kept.length}，屏蔽 ${blocked.length}`)
  const stats = summarizeBlocked(blocked)
  for (const [reason, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason}  ${count} 部`)
  }
  return { kept, blocked, stats }
}

const r1 = report(DEFAULT_SCHEDULE_BLOCK, '默认配置（只开一级）')
const r2 = report({ l1: true, l2: true, l3: true, customTags: ['玄幻'], blacklist: [weekItems[0].id] }, '全开 + 自定义 + 黑名单')
const r3 = report(OFF, '开关全关')
check('全关时一条都不屏蔽', r3.blocked.length, 0)
check('全关时全部保留', r3.kept.length, weekItems.length)
check('没标签的条目一律不屏蔽', r1.blocked.filter((b) => tagsById[b.item.id] === undefined).length, 0)
check('没标签的条目数 = id%6==5 的数量（假数据独立算一遍）', noTagCount, weekItems.filter((it) => it.id % 6 === 5).length)
check('黑名单原因只在全开那一组出现', r2.stats['黑名单'] ?? 0, 1)
check('被屏蔽 + 保留 = 总数', r2.kept.length + r2.blocked.length, weekItems.length)
console.log('\n前 3 条被屏蔽的条目：')
for (const b of r2.blocked.slice(0, 3)) console.log(`    #${b.item.id} ${b.item.name} → ${b.reason}`)

// ------------------------------------------------------------------
// 4. 节流队列：并发 ≤2、每条之间 sleep、失败降级、连续失败中止
// ------------------------------------------------------------------
section('4. 标签补全节流队列')
{
  const ids = Array.from({ length: 9 }, (_, i) => i + 1)
  let inFlight = 0
  let maxInFlight = 0
  const starts = []
  const t0 = Date.now()
  const res = await fetchTagsThrottled(ids, async (id) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    starts.push(Date.now() - t0)
    await new Promise((r) => setTimeout(r, 20))
    inFlight--
    return [`tag-${id}`]
  })
  const elapsed = Date.now() - t0
  const batchGaps = []
  for (let i = TAG_FETCH_CONCURRENCY; i < starts.length; i += TAG_FETCH_CONCURRENCY) {
    batchGaps.push(starts[i] - starts[i - TAG_FETCH_CONCURRENCY])
  }
  console.log(
    `9 条全部成功：并发上限=${maxInFlight}，批间隔(ms)=${batchGaps.join(',')}，总耗时=${elapsed}ms，ok=${res.ok.size}，failed=${res.failed.length}，aborted=${res.aborted}`
  )
  check('并发上限 = 2', maxInFlight, TAG_FETCH_CONCURRENCY)
  check('全部成功', [res.ok.size, res.failed.length], [9, 0])
  check('批间隔 ≥ 配置的 150ms', batchGaps.every((g) => g >= TAG_FETCH_GAP_MS - 5), true)
}
{
  // 连续失败中止：第 4 次失败后不再请求余下条目
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  let calls = 0
  const res = await fetchTagsThrottled(ids, async () => {
    calls++
    return null
  })
  console.log(`全失败：请求次数=${calls}，aborted=${res.aborted}，failed=${res.failed.length}（含未请求的）`)
  check('连续失败 4 次即中止', calls, 4)
  check('中止后余下 id 记入 failed', res.failed.length, ids.length)
}
{
  // 失败降级：失败/中止的条目 tags 为空 → 不屏蔽
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const res = await fetchTagsThrottled(ids, async (id) => (id <= 2 ? ['子供向'] : null))
  const tags = {}
  for (const [id, value] of res.ok) tags[id] = value
  const { kept, blocked } = splitBlocked(
    ids.map((id) => ({ id, name: `条目 ${id}` })),
    tags,
    DEFAULT_SCHEDULE_BLOCK
  )
  console.log(`部分失败：成功=${res.ok.size}，失败=${res.failed.length}，保留=${kept.length}，屏蔽=${blocked.length}`)
  check('只有取到标签的条目被屏蔽', [kept.length, blocked.length], [8, 2])
}
{
  // 抛错也算失败（fetchOne 内部异常不会中断整条队列）
  const res = await fetchTagsThrottled([1, 2, 3, 4, 5], async (id) => {
    if (id === 2) throw new Error('boom')
    return ['ok']
  })
  console.log(`抛错降级：ok=${res.ok.size}，failed=${JSON.stringify(res.failed)}`)
  check('抛错被吞掉并记入 failed', [res.ok.size, res.failed], [4, [2]])
}

// ------------------------------------------------------------------
// 5. 真实标签：用 data/userData/cache/bangumi/subject3-*.json 里已缓存的真实详情跑真实规则
// ------------------------------------------------------------------
section('5. 真实缓存标签（subject3-*.json）跑真实规则')
{
  const dir = join(root, 'data', 'userData', 'cache', 'bangumi')
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('subject3-') && f.endsWith('.json'))
  } catch {
    console.log('（没有详情缓存目录，跳过）')
  }
  const CFGS = [
    { label: '默认(仅L1)', cfg: DEFAULT_SCHEDULE_BLOCK },
    { label: 'L1+L2+L3', cfg: { l1: true, l2: true, l3: true } },
    { label: 'L1+L2+L3+自定义「后宫」', cfg: { l1: true, l2: true, l3: true, customTags: ['后宫'] } }
  ]
  if (files.length > 0) {
    console.log('| 条目 | 标签数 | ' + CFGS.map((c) => c.label).join(' | ') + ' |')
    console.log('| --- | --- | ' + CFGS.map(() => '---').join(' | ') + ' |')
  }
  let hits = 0
  for (const f of files) {
    const id = Number(f.replace('subject3-', '').replace('.json', ''))
    const detail = JSON.parse(readFileSync(join(dir, f), 'utf8')).data
    const tags = (detail.tags ?? []).map((t) => t.name)
    const cells = CFGS.map((c) => {
      const got = blockReason({ id }, tags, c.cfg)
      if (got) hits++
      return got ?? '—'
    })
    console.log(`| #${id} ${detail.name_cn || detail.name} | ${tags.length} | ${cells.join(' | ')} |`)
  }
  console.log(`（共 ${files.length} 条真实缓存详情，命中 ${hits} 次）`)
  check('真实缓存里「没标签就不屏蔽」仍成立', files.every((f) => {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8')).data
    const t = (d.tags ?? []).map((x) => x.name)
    return t.length > 0 || blockReason({ id: 1 }, undefined, DEFAULT_SCHEDULE_BLOCK) === null
  }), true)
}

// ------------------------------------------------------------------
// 6. 可选：--live 时向反代取真实详情，用真实标签跑真实规则（需要网络）
// ------------------------------------------------------------------
if (process.argv.includes('--live')) {
  section('6. 真实反代标签（--live，需要网络）')
  /*
   * 反代地址**不在这里写死**：从 `src/main/services/bangumi.ts` 里读应用自己的默认值。
   * 一是避免仓库里多一份内网/反代地址副本（本项目约定不在提交物里散落这些地址），
   * 二是保证自检用的就是应用真正会请求的那个地址，不会两边漂移。
   */
  const API = (() => {
    const src = readFileSync(join(root, 'src/main/services/bangumi.ts'), 'utf8')
    const hit = /const\s+PROXY_API\s*=\s*'([^']+)'/.exec(src)
    if (!hit) throw new Error('未能从 bangumi.ts 里取到默认反代地址（PROXY_API）')
    return hit[1]
  })()
  // 从本周番剧表里挑几条"看起来会命中"的（欧美 / 里番 / 国产），只为展示真实命中长什么样
  const probe = weekItems.filter((it) => [481295, 574041, 668113, 633354].includes(it.id))
  const ids = probe.length > 0 ? probe.map((p) => p.id) : [481295, 574041, 668113, 633354]
  const liveCfg = { l1: true, l2: true, l3: true, customTags: [] }
  for (const id of ids) {
    try {
      const res = await fetch(`${API}/v0/subjects/${id}`, { headers: { 'User-Agent': 'Sakana/verify-schedule-block' } })
      const json = await res.json()
      const tags = (json.tags ?? []).map((t) => t.name)
      const reason = blockReason({ id }, tags, liveCfg)
      console.log(`#${id} ${json.name_cn || json.name}`)
      console.log(`    标签(${tags.length})：${tags.slice(0, 10).join('/')}`)
      console.log(`    默认(仅L1)：${blockReason({ id }, tags, DEFAULT_SCHEDULE_BLOCK) ?? '—'}    L1+L2+L3：${reason ?? '—'}`)
      check(`反代 #${id} 返回了非空标签`, tags.length > 0, true)
    } catch (err) {
      console.log(`#${id} 取详情失败（网络不可用？）：${String(err)}`)
    }
  }
}

// ------------------------------------------------------------------
console.log('\n================ 结果 ================')
console.log(`通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('全部断言通过 ✓')

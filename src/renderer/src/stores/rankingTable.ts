import { create } from 'zustand'
import type { CardExportImageEntry, CoverImages, GalGame, YmgalCandidate } from '@shared/types'
import { api } from '@/lib/api'
import { coverFields } from '@/stores/customHistory'

/**
 * 「作品评级排名表」（工具页入口 /tools/ranking，v0.3.7 用户需求）的数据层。
 *
 * 用户在做什么：新建一张表（自定义表名 + 选一套等级标签 + 每个标签可自定义颜色与内容），
 * 自建作品池（最多 5 个）放在**左侧**（可折叠），把收藏 / 书签 / galgame 库里的作品导入池子、
 * 或用池子里的搜索框搜番剧与 galgame 加进池子，再把作品**拖**到右侧等级里排位。
 * 拖到**两个等级的分界线**上时作品**骑缝**：封面中心压在分界线上、同时计入上下两档，且排在这两档所有作品的最后。
 * 排完导出成一张高清图片：只有「排名表信息 + 排名详细区域」，**每个等级一行**，
 * **宽度等于最宽那一行的实际内容宽度**（不再固定、不再换行）。
 *
 * ============================ 数据怎么存 ============================
 *
 * 表数据以**一个数组**写进 `api.store` 的 `sakana-ranking`；界面偏好（作品池是否折叠）单独写
 * `sakana-ranking-ui`。两个 key 分开而不是塞进同一个对象：表数据的形状保持不变，
 * 老版本写在磁盘上的**数组**不需要任何迁移就能读回来（见 normalizeTables）。
 * 读法沿用本项目其它工具的做法：挂载时读一次 → 逐字段收窄 → 之后每次改动整份写回。
 * 不做增量写：排名表是低频编辑的小数据，整份写回只有一条代码路径，
 * 不存在「写了一半、内存与磁盘不一致」的中间态 —— 那类 bug 在用户眼里就是「我刚排的图没了」。
 *
 * ============================ 几个刻意的取舍（改之前先看这段） ============================
 *
 * ① **作品 id 由「来源 + 外部 id」推导，不是随机值。**
 *    `bgm-123` / `gal-xxx` / `manual-<随机>`。这样同一个番剧无论从收藏、书签还是搜索进来都是**同一个 id**，
 *    「池子里有没有」「排名区里有没有」都退化成一次集合查找；随机 id 的话同一部番能从两条路各进一次，
 *    用户会在一张排名表里看到两个一模一样的封面，而代码里没有任何地方能判断它们是同一部作品。
 *
 * ② **排名条目内嵌作品快照，而不是引用池子里的对象。**
 *    用户删池子 / 改池子名字时，排名区不该跟着坏掉（排名区才是用户真正在乎的成果，池子只是候选区）。
 *    代价是同一部作品在「拖进排名区」时会从池子里**移走**（移动语义，不是复制）——
 *    所以 `RankedItem.poolId` 记着它从哪个池子来，右键「移出排名区」时原路还回去。
 *
 * ③ **「骑缝」= `straddle: true`，语义是「同时属于上下两档」，不是「第三档」。**
 *    v1 曾把它写成 `between`（介于两档之间的第三个位置）：那样它既不属于上一档也不属于下一档，
 *    档内计数、导出排版、右键换级都要为它单开一套逻辑。现在按用户要求改成
 *    「**封面中心**压在分界线上（视觉骑缝）+ 同时计入上下两档（语义双属）」：
 *    `tierIndex` 始终表示**上方那一档**，`straddle` 表示它同时计入 `tierIndex` 与 `tierIndex + 1`。
 *    好处是所有「这一档里有什么」的问题都能用一个函数回答（`itemsOfTier`），
 *    不需要再在每个调用点记得把"半档"也算进来。老数据里的 `between: true` 在收窄时直接映射成
 *    `straddle: true` —— 语义一致（都在两档之间），不会丢作品。
 *    另外用户这轮要求：骑缝作品**永远排在这两档所有作品的最后面**，所以放置时忽略落点锚点（见 withPlaced）。
 *
 * ④ **`items` 是一维数组，靠稳定的槽位排序保持「同一格内的先后」。**
 *    每个槽位（第 i 档本身 / 第 i 档与下一档的分界线）用 `slotRank = tierIndex * 2 + (straddle ? 1 : 0)`
 *    排序，同槽位内保持原有相对顺序（JS 的 Array.sort 是稳定排序）。渲染时按槽位过滤即可，
 *    不需要再维护一套嵌套结构；拖动重排也只是「按锚点插入 + 重新排序」两步。
 *    ⚠️ 这里的「顺序」只决定**同一行内的先后**：界面上每一档只有一行、不换行（用户要求），
 *    一行放不下的部分靠横向滚动看，宽度由 `rankRowLayouts` 统一算（界面与导出共用）。
 *
 * ⑤ **同一部作品在一张表里只允许出现一次**（无论在池子里还是排名区里）。
 *    这是「排名表」这个东西的语义要求：同一部番出现两次，这张表就没有意义了。
 *    （骑缝作品在**两档里各占一位**，但它在 `items` 里仍然只有一条记录、在池子里也仍然只有一份。）
 *
 * ⑥ **等级是 `{ name, color }` 而不是裸字符串**，因为用户要求标签可自定义颜色与内容，
 *    而且导出图必须用**同一套颜色**。把颜色和标签存在一起（而不是另开一个平行数组）后，
 *    「删掉中间某一档」「把标签排序」这类操作不可能把颜色错位配到别的标签上。
 */

/** 表数据的持久化命名空间（本项目约定：渲染层缓存统一用 sakana- 前缀） */
export const RANKING_STORE_KEY = 'sakana-ranking'

/** 界面偏好（作品池折叠）的持久化命名空间：与表数据分开，见文件头「数据怎么存」 */
export const RANKING_UI_KEY = 'sakana-ranking-ui'

/** 作品池数量上限（用户明确要求「最多 5 个」） */
export const MAX_POOLS = 5

/** 等级数量下限：少于两级就没有「排名」可言 */
export const MIN_TIERS = 2
/**
 * 等级数量上限（用户明确要求「最多 10 个」）。
 * 这个数不是随手定的：排名区要在一屏里完整显示所有档（用户要求「不要滚动才能看完」），
 * 10 档 × 每档约 60px 正好是一屏能压到的极限，再多就只能靠滚动，那正是用户不想看到的。
 */
export const MAX_TIERS = 10

/** 表背景默认白色（用户原话）；导出图也用它，所以这里必须是导出也好看的颜色 */
export const DEFAULT_BACKGROUND = '#ffffff'

/** 背景可选色（编辑器里的一排色块；第一个就是默认的白色） */
export const BACKGROUND_PRESETS: { value: string; label: string }[] = [
  { value: '#ffffff', label: '白' },
  { value: '#faf7f2', label: '米白' },
  { value: '#f4f5f7', label: '浅灰' },
  { value: '#eef4fb', label: '浅蓝' },
  { value: '#fdeef2', label: '浅粉' }
]

/**
 * 导出图的版式宽度上下限（CSS 像素）。
 *
 * v1 固定 1400、v2 按"最挤那一档的列数"估算 —— 都不是用户要的：用户要的是
 * **每个等级只有一行，导出宽度就等于最宽的那一行的实际内容宽度**（见 exportLayout）。
 * 所以上限放到 4000（主进程 exportCardImage 的入参范围也是 600–4000），下限保留 720
 * 是因为再窄连标题与标签列都排不开。宽度够用时绝不夹紧，不会出现右侧大片空白。
 */
export const EXPORT_MIN_WIDTH = 720
export const EXPORT_MAX_WIDTH = 4000

/**
 * 导出倍率。默认 **3 倍**（用户要求"加强清晰度"；实际像素 = 版式宽度 × 倍率），上限仍是 3（主进程硬上限）。
 * 注意：宽度跟着内容走之后，一张 3000px 宽的版式 3 倍就是 9000px —— 主进程按 Chromium 的安全值兜着，
 * 弹窗里也会把实际像素写清楚，用户觉得太大可以自己降到 1–2 倍。
 */
export const EXPORT_SCALES = [1, 2, 3] as const
export const DEFAULT_EXPORT_SCALE = 3

/** 作品来源。三种来源在**数据**里必须区分（右键菜单/提示里也照实写），但卡面上不再挂角标（用户要求去掉） */
export type RankingSource = 'bangumi' | 'galgame' | 'manual'

/** 来源的界面文案。用在鼠标悬停提示与右键菜单里（用户明确不要卡片下面那一行标签） */
export const SOURCE_LABELS: Record<RankingSource, string> = {
  bangumi: '番剧',
  galgame: 'galgame',
  manual: '手动'
}

/**
 * 排名表里的一部作品。
 *
 * 只存渲染要用的最小字段（封面 + 名字 + 来源 + 评分），不存整个 SubjectDetail / GalGame：
 * 这份数据要落盘并且会长期存在，塞大对象意味着以后接口字段一改就得写一堆历史数据兼容。
 */
export interface RankingWork {
  /** 稳定 id = 来源 + 外部 id（见文件头 ①），同时用于去重与拖动标识 */
  id: string
  source: RankingSource
  /** 番剧的 bangumi subjectId（galgame / 手动添加时为 null） */
  subjectId: number | null
  /** galgame 的 id（番剧 / 手动添加时为 null；月幕搜索来的写成 `ymgal-<id>`） */
  galId: string | null
  /** 展示名（番剧取中文名优先） */
  name: string
  /** 副名（原名），只在 title 提示里出现，不占版面 */
  nameAlt: string
  /** 界面列表/卡片用的封面（番剧取 common 档：一屏几十张，加载快最重要） */
  cover: string
  /** 导出用的封面候选链（large 优先），导出图按 2–3 倍画，拿小图会糊 */
  covers: string[]
  /** bangumi 评分（取不到为 null）；界面放在 tooltip 里，卡面上只有封面 + 名字 */
  rating: number | null
  addedAt: number
}

/**
 * 排名区里的一条：作品 + 它落在哪儿。
 *
 * `straddle` 的语义见文件头 ③：true = 骑在 `tierIndex` 与 `tierIndex + 1` 的分界线上，
 * **同时计入上下两档**（不是第三个位置）。
 * `poolId` 记来源池，用于「移出排名区」时原路归还（见文件头 ②）。
 */
export interface RankedItem {
  work: RankingWork
  /** 上方那一档。骑缝时它同时属于 tierIndex 与 tierIndex + 1 */
  tierIndex: number
  /** 是否骑缝（中心挂在分界线上、上下两档各占一位） */
  straddle: boolean
  poolId: string | null
}

/** 一个落点：第 tierIndex 档本身，或它与下一档的**分界线**（骑缝位） */
export interface RankingSlot {
  tierIndex: number
  /** true = 落在 tierIndex 与 tierIndex + 1 的分界线上 */
  straddle: boolean
}

/** 一个作品池 */
export interface RankingPool {
  id: string
  name: string
  works: RankingWork[]
}

/**
 * 一个等级标签：名字 + 底色。
 * 颜色存在标签里（见文件头 ⑥），界面画布与导出图用的是**同一份**色值 —— 所见即所得。
 */
export interface TierDef {
  name: string
  /** 标签底色（#rrggbb）。文字颜色由 readableTextOn 按底色亮度自动取黑/白 */
  color: string
}

/** 一张排名表 */
export interface RankingTable {
  id: string
  name: string
  /** 等级标签，**从高到低**（用户选模板或自定义输入；每个标签自带颜色） */
  tiers: TierDef[]
  /** 已排名的作品（顺序 = 槽位内顺序，见文件头 ④） */
  items: RankedItem[]
  /** 作品池（最多 MAX_POOLS 个） */
  pools: RankingPool[]
  /** 表背景色（默认白色） */
  background: string
  createdAt: number
}

/** 内置三套等级模板（用户原话给定的词，逐字保留，不要改写） */
export interface TierTemplate {
  id: string
  name: string
  desc: string
  tiers: TierDef[]
}

/**
 * 自定义标签的循环配色（最多 10 档，这里给足 10 个）。
 * 顺序刻意与第一套模板的观感一致：高→低 由暖到冷、最后落到白/灰，
 * 用户自己写一套标签时也能直接认出色阶的含义。
 */
export const TIER_PALETTE = [
  '#e5484d', // 红
  '#f76b15', // 橙
  '#f5c518', // 黄
  '#46a758', // 绿
  '#8b8d98', // 灰
  '#ffffff', // 白
  '#3b82f6', // 蓝
  '#8b5cf6', // 紫
  '#ec4899', // 粉
  '#14b8a6' // 青
] as const

/** 预设色板：界面上的色点就按这个顺序排（比 10 个循环色多给几个常用色） */
export const TIER_COLOR_PRESETS = [
  '#e5484d',
  '#f76b15',
  '#f5c518',
  '#46a758',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#8b8d98',
  '#ffffff'
] as const

/** 按序号取循环配色（自定义标签 / 老数据缺颜色时的兜底） */
export function paletteColor(index: number): string {
  const i = Math.abs(Math.trunc(index)) % TIER_PALETTE.length
  return TIER_PALETTE[i]
}

/** 把一串标签名按循环配色补成 TierDef[] */
export function tierDefs(names: string[]): TierDef[] {
  return names.map((name, i) => ({ name, color: paletteColor(i) }))
}

export const TIER_TEMPLATES: TierTemplate[] = [
  {
    id: 'meme',
    name: '第一套：夯 → 区',
    desc: '夯、顶级、人上人、npc、拉完了、区（六档）· 默认配色 红/橙/黄/绿/灰/白',
    tiers: [
      { name: '夯', color: '#e5484d' },
      { name: '顶级', color: '#f76b15' },
      { name: '人上人', color: '#f5c518' },
      { name: 'npc', color: '#46a758' },
      { name: '拉完了', color: '#8b8d98' },
      { name: '区', color: '#ffffff' }
    ]
  },
  {
    id: 'tier',
    name: '第二套：T0 → T4',
    desc: 'T0、T1、T2、T3、T4（五档）· 默认配色 红/橙/黄/绿/灰',
    tiers: [
      { name: 'T0', color: '#e5484d' },
      { name: 'T1', color: '#f76b15' },
      { name: 'T2', color: '#f5c518' },
      { name: 'T3', color: '#46a758' },
      { name: 'T4', color: '#8b8d98' }
    ]
  },
  {
    id: 'grade',
    name: '第三套：S → D',
    desc: 'S、A、B、C、D（五档）· 默认配色 红/橙/黄/绿/灰',
    // 与 T 阶同一套色阶：S–D 和 T0–T4 表达的是同一件事（从高到低五档），
    // 两套模板给不一样的颜色只会让用户以为它们含义不同。
    tiers: [
      { name: 'S', color: '#e5484d' },
      { name: 'A', color: '#f76b15' },
      { name: 'B', color: '#f5c518' },
      { name: 'C', color: '#46a758' },
      { name: 'D', color: '#8b8d98' }
    ]
  }
]

/** 新建表时的默认等级（用户第一眼看到的就是一套完整模板，而不是空标签） */
export const DEFAULT_TIERS: TierDef[] = TIER_TEMPLATES[0].tiers

// ------------------------------------------------------------------
// 纯函数：id
// ------------------------------------------------------------------

let localSeq = 0

/** 本地生成的短 id（表 / 池 / 手动作品用）。带随机后缀是为了同一毫秒内连点也不会撞号 */
function localId(prefix: string): string {
  localSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${localSeq.toString(36)}-${Math.floor(Math.random() * 46656).toString(36)}`
}

/** 番剧作品的稳定 id（同一个 subjectId 在任何入口都得到同一个值，见文件头 ①） */
export function bangumiWorkId(subjectId: number): string {
  return `bgm-${Math.trunc(subjectId)}`
}

/** galgame 作品的稳定 id */
export function galgameWorkId(galId: string): string {
  return `gal-${galId}`
}

/** 手动添加的作品 id（没有外部 id 可用，只能本地生成） */
export function manualWorkId(): string {
  return localId('manual')
}

/** 展示名（名字为空时的兜底，避免卡面上出现一个空白框） */
export function displayName(work: RankingWork): string {
  return work.name || work.nameAlt || '未命名'
}

// ------------------------------------------------------------------
// 纯函数：各种来源 → RankingWork
// ------------------------------------------------------------------

/**
 * 番剧搜索结果 / 当季番剧 / 收藏 → RankingWork。
 *
 * 封面档位规则直接复用「自建历史表」那一份（`coverFields`）：同一套取舍 ——
 * 列表用 common 图（快）、导出链用 large 图（清）。这里再抄一遍只会让两处日后各自漂移。
 */
export function bangumiWork(input: {
  subjectId: number
  name: string
  nameCn?: string
  images?: CoverImages | null
  cover?: string
  rating?: number | null
}): RankingWork {
  const id = bangumiWorkId(input.subjectId)
  const cn = (input.nameCn ?? '').trim()
  const orig = (input.name ?? '').trim()
  // 已有单独封面字段（收藏 / 书签条目）时按它建链：那边给的本来就是大图
  const single = (input.cover ?? '').trim()
  const fields = input.images ? coverFields(input.images) : { cover: single, covers: single ? [single] : [] }
  return {
    id,
    source: 'bangumi',
    subjectId: Math.trunc(input.subjectId),
    galId: null,
    name: cn || orig || '未命名',
    nameAlt: cn && orig && cn !== orig ? orig : '',
    cover: fields.cover,
    covers: fields.covers,
    rating: typeof input.rating === 'number' && Number.isFinite(input.rating) ? input.rating : null,
    addedAt: Date.now()
  }
}

/** 已导入的 galgame 库条目 → RankingWork（封面优先用用户自定义的那张，与 galgame 库列表的取法一致） */
export function galgameWork(game: GalGame): RankingWork {
  const cover = (game.customCover || game.cover || '').trim()
  const cn = (game.titleCn ?? '').trim()
  const orig = (game.title ?? '').trim()
  return {
    id: galgameWorkId(game.id),
    source: 'galgame',
    subjectId: null,
    galId: game.id,
    name: cn || orig || '未命名',
    nameAlt: cn && orig && cn !== orig ? orig : '',
    cover,
    // galgame 的封面只有一张（本地文件或远端 URL），没有档位可选，候选链就是它自己
    covers: cover ? [cover] : [],
    rating: typeof game.rating === 'number' && Number.isFinite(game.rating) ? game.rating : null,
    addedAt: Date.now()
  }
}

/**
 * 月幕搜索到的 galgame 候选 → RankingWork。
 *
 * 候选没有稳定的本地 id，所以 galId 写成 `ymgal-<id>`：它不会被当成「已导入的游戏」，
 * 因此同一款游戏从「galgame 库」和从「搜索」进来会是**两条不同的作品**（故意的）——
 * 前者是用户真装了的、可能带自定义封面，后者只是条目；混成一个反而会丢信息。
 */
export function ymgalWork(candidate: YmgalCandidate): RankingWork {
  const cn = (candidate.titlesCn ?? '').trim()
  const orig = (candidate.title ?? '').trim()
  const cover = (candidate.cover ?? '').trim()
  return {
    id: galgameWorkId(`ymgal-${candidate.id}`),
    source: 'galgame',
    subjectId: null,
    galId: `ymgal-${candidate.id}`,
    name: cn || orig || '未命名',
    nameAlt: cn && orig && cn !== orig ? orig : '',
    cover,
    covers: cover ? [cover] : [],
    rating: null,
    addedAt: Date.now()
  }
}

/** 手动添加的作品（用户自己填名字，可选填一张封面地址） */
export function manualWork(name: string, cover = ''): RankingWork {
  const trimmed = name.trim()
  const url = cover.trim()
  return {
    id: manualWorkId(),
    source: 'manual',
    subjectId: null,
    galId: null,
    name: trimmed || '未命名',
    nameAlt: '',
    cover: url,
    covers: url ? [url] : [],
    rating: null,
    addedAt: Date.now()
  }
}

/**
 * 书签条目 → RankingWork。
 *
 * 书签**不一定带 subjectId**（早期数据只有标题 + 封面），那种条目只能当成手动作品。
 * 但它的 id 刻意用标题推导而不是像 `manualWork` 那样随机：书签是用户会反复导入的一批候选，
 * 随机 id 会让「导入书签」按两次就在池子里出现两份同名作品 —— 去重（文件头 ①）会因此失效。
 */
export function markWork(item: { subjectId?: number; title: string; cover: string }): RankingWork {
  const title = (item.title ?? '').trim()
  const cover = (item.cover ?? '').trim()
  const subjectId = typeof item.subjectId === 'number' && Number.isFinite(item.subjectId) ? Math.trunc(item.subjectId) : 0
  if (subjectId > 0) return bangumiWork({ subjectId, name: title, cover })
  return {
    id: `manual-mark-${title || 'untitled'}`,
    source: 'manual',
    subjectId: null,
    galId: null,
    name: title || '未命名',
    nameAlt: '',
    cover,
    covers: cover ? [cover] : [],
    rating: null,
    addedAt: Date.now()
  }
}

// ------------------------------------------------------------------
// 纯函数：等级标签
// ------------------------------------------------------------------

/**
 * 自定义等级标签的解析：换行 / 顿号 / 逗号 / 空格都能当分隔符。
 *
 * 为什么宽容到「空格也算分隔」：用户最可能的输入是「夯 顶级 人上人」或一行一个，
 * 而等级名本身几乎不会含空格（含空格的名字用换行输入即可）。去重是必须的 ——
 * 两个同名等级会让「移到这一档」变得没有意义。
 * 超过 MAX_TIERS 的部分在这里就截掉，界面另用 `customTierOverflow` 给出「已忽略几个」的提示，
 * 不能默默吞掉（用户要求「超出要拦住并提示」）。
 */
export function parseCustomTiers(text: string): string[] {
  return customTierNames(text).slice(0, MAX_TIERS)
}

/** 自定义输入里真正写了几个（去重后、未截断）：界面用它判断要不要提示「超出上限」 */
export function customTierOverflow(text: string): number {
  return Math.max(0, customTierNames(text).length - MAX_TIERS)
}

/** 解析出的全部标签名（去空、去重，不截断） */
function customTierNames(text: string): string[] {
  return text
    .split(/[\n\r、,，;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s, i, arr) => arr.indexOf(s) === i)
}

/**
 * 收窄任意输入成合法等级数组（带颜色）。
 *
 * 兼容三种历史形状，读到旧数据不许崩：
 *   · `[{name,color}]`（当前格式）；
 *   · `['夯','顶级']`（v1 的裸字符串）→ 按顺序补循环配色；
 *   · 其它脏值 → 丢掉。
 * 标签少于 MIN_TIERS 时回落到默认模板：一张没有任何等级的排名表是完全不可用的。
 * 颜色非法（不是 #rrggbb）的按序号补色 —— 不能留空，否则导出图上会出现看不见的标签。
 */
export function normalizeTierList(raw: unknown): TierDef[] {
  const list: TierDef[] = []
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (typeof row === 'string') {
        const name = row.trim()
        if (name.length > 0) list.push({ name, color: '' })
        continue
      }
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const name = asString(r.name).trim()
      if (name.length === 0) continue
      list.push({ name, color: isHexColor(r.color) ? r.color : '' })
    }
  }
  const unique = list
    .filter((t, i, arr) => arr.findIndex((x) => x.name === t.name) === i)
    .slice(0, MAX_TIERS)
    .map((t, i) => ({ name: t.name, color: t.color || paletteColor(i) }))
  return unique.length >= MIN_TIERS ? unique : DEFAULT_TIERS.map((t) => ({ ...t }))
}

/** 标签名数组（导出、列表页概要、右键菜单文案都用它，避免各处各写一遍 map） */
export function tierNames(tiers: TierDef[]): string[] {
  return tiers.map((t) => t.name)
}

/**
 * 底色上该用黑字还是白字。
 *
 * 为什么需要它：用户可以把标签涂成白色（第一套模板的「区」就是白的），
 * 也可以涂成深红/深蓝。写死深色文字会让深色底上的字看不见，写死白色则白底上看不见。
 * 用 sRGB 相对亮度粗略判断（阈值 0.6）足够稳，不需要引入完整的 WCAG 对比度计算。
 */
export function readableTextOn(color: string): string {
  if (!isHexColor(color)) return '#1b1b1f'
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return lum > 0.6 ? '#1b1b1f' : '#ffffff'
}

/**
 * 槽位排序权重（见文件头 ④）。
 * `straddle` 用 +1 排在档本身之后，于是「第 i 档 → 第 i 档与下一档的分界线 → 第 i+1 档」自然成序。
 */
export function slotRank(slot: RankingSlot): number {
  return slot.tierIndex * 2 + (slot.straddle ? 1 : 0)
}

/** 某个槽位里的作品（保持数组顺序 = 用户摆的顺序） */
export function slotItems(items: RankedItem[], slot: RankingSlot): RankedItem[] {
  return items.filter((it) => it.tierIndex === slot.tierIndex && it.straddle === slot.straddle)
}

/** 坐在第 i 档**里面**的作品（不含骑缝的） */
export function seatedItemsOfTier(items: RankedItem[], tierIndex: number): RankedItem[] {
  return items.filter((it) => !it.straddle && it.tierIndex === tierIndex)
}

/** 骑在第 i 档与第 i+1 档分界线上的作品 */
export function straddleItemsAt(items: RankedItem[], tierIndex: number): RankedItem[] {
  return items.filter((it) => it.straddle && it.tierIndex === tierIndex)
}

/**
 * 第 i 档**实际包含**的所有作品：坐在它里面的 + 骑在它上边界与下边界的。
 *
 * 这是「骑缝 = 同时计入上下两档」（文件头 ③）唯一的落地口：档内计数、导出排版、
 * 空档提示全走它，别处不要再自己 filter（那样一定会漏掉骑缝的一半）。
 */
export function itemsOfTier(items: RankedItem[], tierIndex: number): RankedItem[] {
  return items.filter((it) => itemCoversTier(it, tierIndex))
}

/** 一条排名条目是否计入第 tierIndex 档 */
export function itemCoversTier(item: RankedItem, tierIndex: number): boolean {
  if (item.tierIndex === tierIndex) return true
  return item.straddle && item.tierIndex + 1 === tierIndex
}

/** 一条排名条目计入的档次（骑缝时是两档） */
export function tiersOfItem(item: RankedItem): number[] {
  return item.straddle ? [item.tierIndex, item.tierIndex + 1] : [item.tierIndex]
}

/**
 * 把颜色按比例压暗（用于标签色块的左边条 / 边框：需要一个"同色的深一档"）。
 * 只在 sRGB 上做线性缩放 —— 标签底色都是用户随手挑的纯色，这一步不需要真正的色彩空间转换。
 */
export function darkenColor(color: string, amount = 0.28): string {
  if (!isHexColor(color)) return '#1b1b1f'
  const k = Math.min(0.9, Math.max(0, amount))
  const channel = (hex: string): string => {
    const v = Math.round(parseInt(hex, 16) * (1 - k))
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')
  }
  return `#${channel(color.slice(1, 3))}${channel(color.slice(3, 5))}${channel(color.slice(5, 7))}`
}

/**
 * 一档在版面里的几何（**界面画布与导出图共用这一份计算**，两侧排版不会各自漂移）。
 *
 * 用户这轮的两条硬要求都落在这里：
 *   ① **每个等级只有一行**：所以一行的宽度就是该档作品卡的宽度之和（不换行、不折行）；
 *   ② **骑缝作品排在这两档所有作品的最后面**：所以骑缝带的左偏移取上下两档中较长的那一行，
 *      并且两档的长度都要把这条带算进去（骑缝在两档里各占居末尾的位置）。
 */
export interface RankRow {
  tierIndex: number
  /** 坐在这一档里的作品 */
  seated: RankedItem[]
  /** 骑在这一档与下一档分界线上的作品（最后一行没有） */
  below: RankedItem[]
  /** 本档自己作品的宽度（空档为 0） */
  seatedW: number
  /** 骑缝带相对作品区起点的左偏移 */
  bandLeft: number
  /** 骑缝带的宽度（没有骑缝作品时为 0） */
  bandW: number
  /** 本行连同骑缝带在内的总宽（含标签列，相对内容原点） */
  rowW: number
}

export interface RankRowMetrics {
  cardW: number
  gap: number
  labelW: number
  labelGap: number
  /**
   * 每一行除了"标签列 + 作品"之外还要占掉的横向宽度（界面里是档位卡的内边距与边框，见 TierBoard）。
   * 导出图的行没有内边距，所以不传（默认 0）—— 两侧共用同一个函数，但各自的"壳"不同。
   */
  rowChrome?: number
}

export function rankRowLayouts(
  table: RankingTable,
  metrics: RankRowMetrics
): { rows: RankRow[]; contentW: number } {
  const { cardW, gap, labelW, labelGap, rowChrome = 0 } = metrics
  const widthOf = (n: number): number => (n > 0 ? n * cardW + (n - 1) * gap : 0)
  const rows: RankRow[] = table.tiers.map((_, i) => {
    const seated = seatedItemsOfTier(table.items, i)
    const below = straddleItemsAt(table.items, i)
    return {
      tierIndex: i,
      seated,
      below,
      seatedW: widthOf(seated.length),
      bandLeft: 0,
      bandW: widthOf(below.length),
      rowW: 0
    }
  })
  rows.forEach((row, i) => {
    const next = rows[i + 1]
    // 骑缝带排在两档所有作品的后面（见上面 ②）
    row.bandLeft = next ? Math.max(row.seatedW, next.seatedW) : 0
  })
  rows.forEach((row) => {
    const worksStart = labelW + labelGap
    const bandEnd = worksStart + row.bandLeft + (row.bandW > 0 ? gap + row.bandW : 0) + rowChrome
    row.rowW = Math.max(worksStart + row.seatedW + rowChrome, bandEnd)
  })
  const contentW = rows.reduce((max, row) => Math.max(max, row.rowW), labelW + labelGap + rowChrome)
  return { rows, contentW }
}

// ------------------------------------------------------------------
// 纯函数：整块画布的几何（骑缝卡片为什么不会压到别人，全靠这里）
// ------------------------------------------------------------------

/**
 * 画布尺寸参数（界面侧的排版常量，见 TierBoard 的 layoutFor）。
 * 全部是"内容盒子"里的相对坐标：x 从左内边距开始、y 从画布内容顶端开始。
 */
export interface BoardMetrics {
  /** 档位卡（每一档那张卡）的高度 */
  rowH: number
  /** 两档之间**没有**骑缝时的间距 */
  rowGap: number
  /** 两档之间**有**骑缝时，那条独立骑缝条的高度 */
  stripH: number
  cardW: number
  cardH: number
  cardGap: number
  /** 标签列宽 */
  labelW: number
  /** 标签列与作品行之间的间距 */
  labelGap: number
  /** 档位卡自己的内边距 + 边框（上下/左右各一份） */
  rowPad: number
  /** 作品行自己的内边距 */
  worksPad: number
}

/** 一张作品卡在画布里的矩形（给渲染与"任意两张卡不相交"的自测共用） */
export interface BoardCardBox {
  workId: string
  /** seated = 坐在某一档里；straddle = 骑在两档分界线上 */
  kind: 'seated' | 'straddle'
  /** 计入的**上方**那一档（骑缝时是分界线上方那一档） */
  tierIndex: number
  left: number
  top: number
  width: number
  height: number
}

/** 画布上的一块：档位行，或两档之间那条骑缝条 */
export interface BoardBlock {
  kind: 'row' | 'strip'
  tierIndex: number
  top: number
  height: number
  /** 相对上一块下沿的间距（渲染时就是 marginTop，保证 DOM 与这里的坐标一致） */
  marginTop: number
  /** 骑缝条里卡片相对作品区起点的左偏移（档位行恒为 0） */
  bandLeft: number
  cards: BoardCardBox[]
}

export interface BoardGeometry {
  blocks: BoardBlock[]
  /** 作品区相对档位卡左边的内缩（档位卡内边距 + 边框 + 标签列 + 间距 + 作品行内边距） */
  worksLeftInset: number
  contentW: number
  contentH: number
}

/**
 * 算出画布的完整几何。
 *
 * ============================ 为什么骑缝卡片单独占一条"高带" ============================
 *
 * 之前骑缝卡片是绝对定位、跨在分界线上（上半伸进上一档、下半伸进下一档）。它的高度是整张卡片，
 * 而两档之间的缝只有 8px，所以它必然侵入行内空间；更糟的是它纵向能伸到**下一档之外**，
 * 只要下下档的作品比这两档更长，就会压到人家的卡片上（用户实测："骑缝的作品有时候会遮住其它区域正常的作品"）。
 *
 * 现在的做法（用户给的方案之一）：**两档之间给骑缝单独留一条横向的高带**（`stripH`），
 * 带里除了骑缝卡片什么都没有，于是有两条硬保证：
 *   ① 纵向：骑缝卡片被夹在两个档位行之间，永远不与任何档位行重叠；
 *   ② 横向：骑缝卡片只落在这一条带里，带内没有别的卡片，所以也不会与任何档的卡片重叠。
 * 卡片在带里**垂直居中**——带的中心就是两档的分界线，所以"封面中心压在交界线上"依然成立。
 *
 * 渲染侧（TierBoard）用的就是这里的 `top / height / marginTop / left`，
 * 自测里"任意两张卡片矩形都不相交"也是断言同一组数字，两边不可能对不上。
 */
export function boardGeometry(table: RankingTable, m: BoardMetrics): BoardGeometry {
  const worksLeftInset = m.rowPad + m.labelW + m.labelGap + m.worksPad
  // 横向仍然复用 rankRowLayouts：一行一档 + 骑缝排在两档所有作品之后
  const { rows, contentW } = rankRowLayouts(table, {
    cardW: m.cardW,
    gap: m.cardGap,
    // 把"档位卡内边距 + 标签列 + 间距 + 作品行内边距"整体当成左边距，右边只留档位卡与作品行的内边距
    labelW: worksLeftInset,
    labelGap: 0,
    rowChrome: m.rowPad + m.worksPad
  })

  const blocks: BoardBlock[] = []
  let y = 0
  let prevBottom = 0
  const push = (block: Omit<BoardBlock, 'marginTop'>): void => {
    blocks.push({ ...block, marginTop: block.top - prevBottom })
    prevBottom = block.top + block.height
  }

  rows.forEach((row, i) => {
    const cardTop = y + (m.rowH - m.cardH) / 2
    push({
      kind: 'row',
      tierIndex: i,
      top: y,
      height: m.rowH,
      bandLeft: 0,
      cards: row.seated.map((item, k) => ({
        workId: item.work.id,
        kind: 'seated' as const,
        tierIndex: i,
        left: worksLeftInset + k * (m.cardW + m.cardGap),
        top: cardTop,
        width: m.cardW,
        height: m.cardH
      }))
    })
    y += m.rowH
    if (i >= rows.length - 1) return
    if (row.below.length > 0) {
      const stripTop = y
      const stripCardTop = stripTop + (m.stripH - m.cardH) / 2
      push({
        kind: 'strip',
        tierIndex: i,
        top: stripTop,
        height: m.stripH,
        bandLeft: row.bandLeft,
        cards: row.below.map((item, k) => ({
          workId: item.work.id,
          kind: 'straddle' as const,
          tierIndex: i,
          left: worksLeftInset + row.bandLeft + k * (m.cardW + m.cardGap),
          top: stripCardTop,
          width: m.cardW,
          height: m.cardH
        }))
      })
      y += m.stripH
    } else {
      // 没有骑缝：这 8px 的间距由下一块的 marginTop 表达（这里只把游标推过去）
      y += m.rowGap
    }
  })

  return { blocks, worksLeftInset, contentW, contentH: prevBottom }
}

/** 这张表里已经用掉的作品 id（池子 + 排名区），用于去重判断 */
export function usedWorkIds(table: RankingTable): Set<string> {
  const set = new Set<string>()
  for (const it of table.items) set.add(it.work.id)
  for (const pool of table.pools) for (const w of pool.works) set.add(w.id)
  return set
}

/** 排名区里的作品总数（骑缝作品只算一部，它是一条记录） */
export function rankedCount(table: RankingTable): number {
  return table.items.length
}

/**
 * 改等级标签后会**离开排名区（回到作品池）**的条目数。
 *
 * 只有「连上方那一档都没了」的条目才算真的出局；骑缝作品在下方档被删掉时会**降级**
 * 成坐在上方档里（见 setTiers / normalizeTable）：用户只是把档数改短，
 * 不该让一个已经排好的作品凭空回到候选池。
 */
export function itemsLostByTiers(table: RankingTable, tiers: TierDef[]): number {
  const n = normalizeTierList(tiers).length
  return table.items.filter((it) => it.tierIndex >= n).length
}

// ------------------------------------------------------------------
// 纯函数：收窄（磁盘 → 内存）
// ------------------------------------------------------------------

function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function asFiniteNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 一条作品收窄。
 *
 * 名字全空、且外部 id 也取不到的条目一律丢掉：它既画不出卡面也没法去重，
 * 留着的唯一效果是让用户看到一片空白格子却查不出原因。番剧/galgame 的 id 一律**重算**
 * （见文件头 ①）——外部 id 在就一定能推出正确的 id，磁盘上那个旧值不参与判断。
 */
function normalizeWork(raw: unknown): RankingWork | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const source: RankingSource =
    r.source === 'galgame' ? 'galgame' : r.source === 'manual' ? 'manual' : r.source === 'bangumi' ? 'bangumi' : 'bangumi'
  const name = asString(r.name).trim()
  const nameAlt = asString(r.nameAlt).trim()
  const subjectId = typeof r.subjectId === 'number' && Number.isFinite(r.subjectId) ? Math.trunc(r.subjectId) : null
  const galId = typeof r.galId === 'string' && r.galId.length > 0 ? r.galId : null
  let id = asString(r.id).trim()
  if (source === 'bangumi' && subjectId !== null && subjectId > 0) id = bangumiWorkId(subjectId)
  else if (source === 'galgame' && galId) id = galgameWorkId(galId)
  if (id.length === 0) return null
  if (name.length === 0 && nameAlt.length === 0) return null
  const cover = asString(r.cover).trim()
  const covers = Array.isArray(r.covers)
    ? r.covers.filter((u): u is string => typeof u === 'string' && u.trim().length > 0).map((u) => u.trim())
    : []
  return {
    id,
    source,
    subjectId: subjectId !== null && subjectId > 0 ? subjectId : null,
    galId,
    name: name || nameAlt,
    nameAlt: name && nameAlt && nameAlt !== name ? nameAlt : '',
    cover: cover || covers[0] || '',
    // 候选链丢了（老数据 / 只有一个 cover）时退化成 [cover]：导出至少还有一张能画
    covers: covers.length > 0 ? covers : cover ? [cover] : [],
    rating: typeof r.rating === 'number' && Number.isFinite(r.rating) ? r.rating : null,
    addedAt: asFiniteNumber(r.addedAt, 0)
  }
}

function normalizePool(raw: unknown): RankingPool | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = asString(r.id).trim() || localId('pool')
  const works: RankingWork[] = []
  const seen = new Set<string>()
  if (Array.isArray(r.works)) {
    for (const w of r.works) {
      const work = normalizeWork(w)
      if (!work || seen.has(work.id)) continue
      seen.add(work.id)
      works.push(work)
    }
  }
  return { id, name: asString(r.name).trim() || '作品池', works }
}

/** 把一条排名条目归还到它的来源池（池子被删了就回第一个池；一个池都没有则返回 null = 只能丢弃） */
export function returnToPool(table: RankingTable, item: RankedItem): RankingTable {
  const target = table.pools.find((p) => p.id === item.poolId) ?? table.pools[0]
  if (!target) return { ...table, items: table.items.filter((it) => it.work.id !== item.work.id) }
  const pools = table.pools.map((p) =>
    p.id === target.id && !p.works.some((w) => w.id === item.work.id)
      ? { ...p, works: [...p.works, item.work] }
      : p
  )
  return { ...table, pools, items: table.items.filter((it) => it.work.id !== item.work.id) }
}

/**
 * 整张表收窄。
 *
 * 顺序上**先收排名区再收池子**，并且排名区先占住 `used` 集合：
 * 排名区是用户显式摆放的结果，池子里的只是候选副本；万一磁盘上同一部作品两处都有
 * （早期版本或手工改过数据），保留它排在哪儿的信息比保留它在池子里更有价值。
 */
function normalizeTable(raw: unknown): RankingTable | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  // 「这到底是不是一张排名表」的最小判据：名字、等级、排名、池子四个字段里一个都不像就丢掉。
  // 不猜默认值建一张空表 —— 用户会莫名其妙多出一张「未命名排名表」，还没法解释它是哪来的。
  if (typeof r.name !== 'string' && !Array.isArray(r.tiers) && !Array.isArray(r.items) && !Array.isArray(r.pools)) {
    return null
  }
  const id = asString(r.id).trim() || localId('table')
  const tiers = normalizeTierList(r.tiers)
  const used = new Set<string>()

  const items: RankedItem[] = []
  if (Array.isArray(r.items)) {
    for (const rawItem of r.items) {
      if (!rawItem || typeof rawItem !== 'object') continue
      const ri = rawItem as Record<string, unknown>
      const work = normalizeWork(ri.work)
      if (!work || used.has(work.id)) continue
      const tierIndex = asFiniteNumber(ri.tierIndex, 0)
      // 等级被改短了：落在已消失等级里的条目直接丢掉（保留下来会画在一个不存在的格子里）
      if (tierIndex < 0 || tierIndex >= tiers.length) continue
      /**
       * ⚠️ 老数据迁移：v1 存的是 `between: true`（介于两档之间的"半档"）。
       * 新语义下它等价于「骑缝、同时计入上下两档」，所以直接映射成 `straddle`。
       * 若这一条已经是最后一档（下面没有档了），骑缝不成立 → 降级成坐在这一档里，
       * 而不是把作品丢掉 —— 用户重新打开旧表时看到的应该还是原来那批作品。
       */
      const wantsStraddle = ri.straddle === true || ri.between === true
      const straddle = wantsStraddle && tierIndex < tiers.length - 1
      used.add(work.id)
      items.push({
        work,
        tierIndex: Math.trunc(tierIndex),
        straddle,
        poolId: typeof ri.poolId === 'string' && ri.poolId.length > 0 ? ri.poolId : null
      })
    }
  }
  items.sort((a, b) => slotRank(a) - slotRank(b))

  const pools: RankingPool[] = []
  if (Array.isArray(r.pools)) {
    for (const rawPool of r.pools) {
      if (pools.length >= MAX_POOLS) break
      const pool = normalizePool(rawPool)
      if (!pool) continue
      // 已在排名区里的作品从池子里去掉：同一部作品不该同时出现在两处（见文件头 ⑤）
      const works = pool.works.filter((w) => !used.has(w.id))
      for (const w of works) used.add(w.id)
      pools.push({ ...pool, works })
    }
  }

  // poolId 指向一个已经不存在的池子时清成 null：归还逻辑会自动落到第一个池子
  const poolIds = new Set(pools.map((p) => p.id))
  const fixedItems = items.map((it) => (it.poolId && !poolIds.has(it.poolId) ? { ...it, poolId: null } : it))

  return {
    id,
    name: asString(r.name).trim() || '未命名排名表',
    tiers,
    items: fixedItems,
    pools,
    background: isHexColor(r.background) ? r.background : DEFAULT_BACKGROUND,
    createdAt: asFiniteNumber(r.createdAt, Date.now())
  }
}

/** 整份数据收窄（读盘用） */
export function normalizeTables(raw: unknown): RankingTable[] {
  if (!Array.isArray(raw)) return []
  const out: RankingTable[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    const table = normalizeTable(row)
    if (!table || seen.has(table.id)) continue
    seen.add(table.id)
    out.push(table)
  }
  return out
}

// ------------------------------------------------------------------
// 纯函数：拖动落点 → 插入位置
// ------------------------------------------------------------------

/**
 * 把「拖动的作品」插入到 `rest`（已剔除拖动项）里的哪个下标。
 *
 * 用**锚点 id** 而不是「悬停到第几张的序号」来表达落点：卡片是按槽位过滤后渲染的，
 * 序号会因为「拖动项自己也在这一格里」而每次都要做 ±1 的换算 —— 那是这类拖拽排序最容易出错的地方。
 * 锚点就是"插到这张卡片前面"，拖动项在不在同一格都不影响这句话的含义；锚点为 null = 追加到该格末尾。
 */
function insertIndexIn(rest: RankedItem[], slot: RankingSlot, anchorId: string | null): number {
  if (anchorId) {
    const at = rest.findIndex((it) => it.work.id === anchorId)
    if (at >= 0) return at
  }
  const members = slotItems(rest, slot)
  const last = members[members.length - 1]
  if (last) return rest.indexOf(last) + 1
  // 该格还空着：插到「排序在它后面」的第一条之前，保证 sort 之后它仍落在这一格里
  const next = rest.findIndex((it) => slotRank(it) > slotRank(slot))
  return next < 0 ? rest.length : next
}

/** 把一条作品放进某个槽位（内部共用：从池子里拖进来、以及排名区内换格都是它） */
function withPlaced(
  table: RankingTable,
  work: RankingWork,
  slot: RankingSlot,
  anchorId: string | null,
  poolId: string | null
): RankingTable {
  const rest = table.items.filter((it) => it.work.id !== work.id)
  // 最后一档下面没有分界线：骑缝位不成立时落到该档本身（宁可少一点语义，也不让作品消失）
  const straddle = slot.straddle && slot.tierIndex < table.tiers.length - 1
  /**
   * 骑缝作品**忽略落点锚点、永远追加到末尾**（用户要求"横跨两个等级的作品要自动排在这两个区域所有作品的最后面"）。
   * 它画在分界线上、排在两档所有作品之后，所以"插到某张卡前面"对骑缝没有意义；
   * 档内（非骑缝）的落点仍然按锚点精确插入（同格内排顺序还是要保留的）。
   */
  const index = insertIndexIn(rest, slot, straddle ? null : anchorId)
  const next = [...rest]
  next.splice(index, 0, { work, tierIndex: slot.tierIndex, straddle, poolId })
  // 稳定排序：槽位内保持插入顺序（见文件头 ④）
  next.sort((a, b) => slotRank(a) - slotRank(b))
  return { ...table, items: next }
}

// ------------------------------------------------------------------
// 纯函数：导出 HTML
// ------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 导出图的卡片尺寸（CSS 像素）。比界面上的大一点，因为成图是要发给别人看的 */
const EXPORT_CARD_W = 104
const EXPORT_COVER_H = 146
/** 卡片总高 = 封面 + 名字（6 边距 + 32 两行）+ 角标（约 18）。骑缝卡片要按它的一半往上提 */
const EXPORT_CARD_H = EXPORT_COVER_H + 56
const EXPORT_CARD_GAP = 14
/** 标签列宽与它与卡片区之间的间距 */
const EXPORT_LABEL_W = 152
const EXPORT_LABEL_GAP = 20
/** 左右内边距 */
const EXPORT_PAD = 44
/** 骑缝带上下各留的空白（卡片在带里垂直居中 → 带心就是两档的分界线） */
const EXPORT_STRIP_PAD = 10

/**
 * 算出导出图该多宽。
 *
 * 用户的规则（原话）：「在某个等级下面放了超出页面宽度的多个作品，输出图片宽度就以**这一等级下作品的最大宽度**为准」。
 * 也就是：**每个等级只有一行、作品不换行**，宽度 = 最宽那一行的实际内容宽度（内边距 + 标签列 + 该行所有卡片宽度之和）。
 * 这里直接用 rankRowLayouts（界面画布用的是同一个函数）算出 contentW，再加左右内边距。
 *
 * 上下限只做安全兜底：宽度够用时绝不夹紧（夹紧就等于又把内容压回去、右边留白）。
 */
export function exportLayout(table: RankingTable): { width: number; contentW: number; rows: RankRow[] } {
  const { rows, contentW } = rankRowLayouts(table, {
    cardW: EXPORT_CARD_W,
    gap: EXPORT_CARD_GAP,
    labelW: EXPORT_LABEL_W,
    labelGap: EXPORT_LABEL_GAP
  })
  const raw = contentW + EXPORT_PAD * 2
  return {
    width: Math.round(Math.min(EXPORT_MAX_WIDTH, Math.max(EXPORT_MIN_WIDTH, raw))),
    contentW,
    rows
  }
}

/**
 * 拼导出用的完整 HTML 文档 + 需要主进程预取的封面清单。
 *
 * 为什么自己拼 HTML 而不是在 canvas 里手画（与主进程 cardExport.ts 的取舍一致）：
 * 版式只有一份（这份 HTML），界面所见与成图基本一致，改样式不用改两处。
 * 图片位置写 `{{img:key}}`，主进程会换成 data URL（离屏窗口不加载任何外部资源）。
 *
 * 版式只有两段（用户要求简化）：**排名表信息**（表名 / 排名人 / 导出时间 / 规模）
 * 与**排名详细区域**（标签列 + 作品卡）。页脚说明、图例、"介于两档之间"的独立虚线格全部没有。
 *
 * 三条本轮的排版规则（与界面画布共用 rankRowLayouts，所以两侧永远一致）：
 *   ① 每个等级**只有一行**，作品不换行（`flex-wrap: nowrap`）—— 宽度不够就看不着，这是用户要的；
 *   ② 骑缝卡片的**封面中心**压在分界线上（上下各一半负外边距，净位移为 0），
 *      并且骑缝带排在**这两档所有作品的后面**（左偏移 = 两档中较长的那一行）；
 *   ③ 卡面上不再有"番剧 / galgame"来源角标（用户要求去掉），只保留骑缝小标。
 *
 * 配色**不跟随应用主题**：表背景用这张表自己的背景色（默认白色），
 * 标签色块用用户在界面上给这一档选的颜色 + 同色系加深的左边条（见文件头 ⑥）。
 */
export function buildRankingExportHtml(
  table: RankingTable,
  author: string
): { html: string; images: CardExportImageEntry[] } {
  const images: CardExportImageEntry[] = []
  const bg = isHexColor(table.background) ? table.background : DEFAULT_BACKGROUND
  const name2 = author.trim()
  const stamped = new Date()
  const dateText = `${stamped.getFullYear()}-${String(stamped.getMonth() + 1).padStart(2, '0')}-${String(
    stamped.getDate()
  ).padStart(2, '0')}`
  const { width, rows } = exportLayout(table)

  const cardHtml = (item: RankedItem): string => {
    const work = item.work
    const name = displayName(work)
    const url = work.covers[0] ?? work.cover
    let cover: string
    if (url) {
      const key = `c${images.length}`
      images.push({ key, url, label: name })
      cover = `<div class="cover"><img src="{{img:${key}}}" alt=""></div>`
    } else {
      // 没有封面地址（手动添加的居多）：画名字前两个字当占位，别在成图里留一块白
      cover = `<div class="cover ph">${escapeHtml(name.slice(0, 2))}</div>`
    }
    // 只有骑缝作品带小标（来源角标已按用户要求去掉）
    const mark = item.straddle
      ? `<span class="mark">骑缝 · 计入「${escapeHtml(table.tiers[item.tierIndex]?.name ?? '')}」「${escapeHtml(
          table.tiers[item.tierIndex + 1]?.name ?? ''
        )}」</span>`
      : ''
    return `<figure class="card${item.straddle ? ' straddle' : ''}">${cover}<figcaption class="name">${escapeHtml(
      name
    )}</figcaption>${mark}</figure>`
  }

  const labelHtml = (tier: TierDef, ghost = false): string => {
    if (ghost) return '<div class="label ghost"></div>'
    return `<div class="label" style="background:${tier.color};color:${readableTextOn(tier.color)};border-left-color:${darkenColor(
      tier.color
    )}">${escapeHtml(tier.name)}</div>`
  }

  const blocks: string[] = []
  rows.forEach((row, i) => {
    const tier = table.tiers[i]
    blocks.push(
      `<section class="tier">${labelHtml(tier)}<div class="works${row.seated.length > 0 ? '' : ' empty'}">${row.seated
        .map(cardHtml)
        .join('')}</div></section>`
    )
    if (i >= rows.length - 1) return
    if (row.below.length === 0) {
      blocks.push('<div class="divider"></div>')
      return
    }
    // 骑缝带：**两档之间一条独立的行**（不是压在分界线上的浮层）——
    // 这样它在文档流里就有自己的高度，永远不会压到上一档或下一档的卡片（界面侧同理，见 boardGeometry）
    // 横向仍排在两档所有作品的后面（padding-left = bandLeft）
    blocks.push(
      `<section class="straddle-row">${labelHtml(tier, true)}<div class="straddle-works" style="padding-left:${
        row.bandLeft
      }px">${row.below.map(cardHtml).join('')}</div></section>`
    )
  })

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(table.name)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: ${bg}; }
  body {
    color: #1b1b1f;
    font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* 版式宽度按内容算（见 exportLayout），不留大片空白 */
  .sheet { width: ${width}px; padding: ${EXPORT_PAD}px ${EXPORT_PAD}px ${EXPORT_PAD + 8}px; background: ${bg}; }

  /* ---- 排名表信息 ---- */
  .info { margin-bottom: 18px; }
  h1 { margin: 0; font-size: 30px; font-weight: 800; letter-spacing: 0.5px; line-height: 1.25; word-break: break-word; }
  .meta { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px 22px; font-size: 13px; color: #55565e; }
  .meta b { font-weight: 700; color: #1b1b1f; }

  /* ---- 排名详细区域：每个等级一行，不换行 ---- */
  .tier { display: flex; align-items: stretch; gap: ${EXPORT_LABEL_GAP}px; padding: 8px 0; width: max-content; }
  /* 等级标签：带底色的色块 + 同色系加深的左边条，层级一眼能看出来 */
  .label {
    flex: 0 0 ${EXPORT_LABEL_W}px; width: ${EXPORT_LABEL_W}px; display: flex; align-items: center; justify-content: center;
    padding: 8px 6px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.14); border-left: 8px solid rgba(0,0,0,0.3);
    font-size: 20px; font-weight: 800; letter-spacing: 0.5px; text-align: center; word-break: break-all; line-height: 1.15;
  }
  .label.ghost { background: transparent; border-color: transparent; }
  /* flex-wrap: nowrap —— 作品只放在这一行里，宽度不够的部分靠"导出宽度跟着内容走"解决 */
  .works { flex: 0 0 auto; display: flex; flex-wrap: nowrap; align-items: flex-start; gap: ${EXPORT_CARD_GAP}px; min-height: ${EXPORT_CARD_H}px; }
  .works.empty { min-height: 40px; align-items: center; }
  .works.empty::after { content: "（空）"; color: #b9b9c0; font-size: 13px; }

  .card { width: ${EXPORT_CARD_W}px; margin: 0; }
  .cover {
    width: ${EXPORT_CARD_W}px; height: ${EXPORT_COVER_H}px; border-radius: 8px; overflow: hidden; background: #ececed;
    display: flex; align-items: center; justify-content: center; color: #9d9da6; font-size: 15px; font-weight: 700;
  }
  .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .name {
    margin-top: 6px; height: 32px; font-size: 12px; line-height: 1.35; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word;
  }
  /* 卡面上没有来源角标（用户要求去掉），只有骑缝作品带这一行说明 */
  :empty.mark { display: none; }
  .mark { display: inline-block; margin-top: 4px; padding: 0 6px; border: 1px solid #c9c9d1; border-radius: 999px; font-size: 10px; color: #4b4c55; background: #ffffff; font-weight: 700; }

  /* 骑缝带：两档之间一条独立的行，卡片在带里垂直居中（带心 = 两档分界线），
     文档流里占自己的高度 → 不可能压到上下两档的卡片 */
  .straddle-row { display: flex; align-items: center; gap: ${EXPORT_LABEL_GAP}px; width: max-content; padding: ${EXPORT_STRIP_PAD}px 0; }
  .straddle-row .straddle-works { flex: 0 0 auto; display: flex; align-items: center; gap: ${EXPORT_CARD_GAP}px; }
  .straddle-row .mark { color: #4b4c55; border-color: #c9c9d1; background: #ffffff; font-weight: 700; }
  .divider { height: 1px; margin: 0 0 0 ${EXPORT_LABEL_W + EXPORT_LABEL_GAP}px; background: #e8e8ea; }
</style>
</head>
<body>
<div class="sheet">
  <div class="info">
    <h1>${escapeHtml(table.name)}</h1>
    <div class="meta">
      <span>共 <b>${table.tiers.length}</b> 档</span>
      <span>排名作品 <b>${table.items.length}</b> 部</span>
      <span>导出于 <b>${dateText}</b></span>
      ${name2 ? `<span>排名人 <b>${escapeHtml(name2)}</b></span>` : ''}
    </div>
  </div>
  ${blocks.join('\n  ')}
</div>
</body>
</html>`

  return { html, images }
}

// ------------------------------------------------------------------
// store
// ------------------------------------------------------------------

export type AddWorksResult = { added: number; skipped: number }
export type AddPoolResult = { ok: true; pool: RankingPool } | { ok: false; message: string }
/** 改标签名的结果（重名 / 空名都要给用户一句人话，而不是静默失败） */
export type SetTierNameResult = { ok: true } | { ok: false; message: string }
/** 移出排名区后作品去哪儿了：回到池子里 / 表里一个池子都没有，只能丢掉 */
export type RemoveRankedResult = 'pool' | 'dropped'

interface RankingTableState {
  tables: RankingTable[]
  /** 是否已经从磁盘读过一次（页面据此决定要不要显示加载态） */
  loaded: boolean
  load: () => Promise<void>
  createTable: (name: string, tiers: TierDef[], background?: string) => RankingTable
  deleteTable: (tableId: string) => void
  renameTable: (tableId: string, name: string) => void
  /** 改等级标签与颜色；返回**离开排名区（回到作品池）**的条目数（调用方负责提前警告用户） */
  setTiers: (tableId: string, tiers: TierDef[]) => number
  /** 只改某一档的底色（右键菜单 / 标签上的色板）：不动标签名，也不动任何作品 */
  setTierColor: (tableId: string, tierIndex: number, color: string) => void
  /** 只改某一档的标签内容（右键菜单）。重名会被拒绝：两个同名档会让「移到「X」」失去意义 */
  setTierName: (tableId: string, tierIndex: number, name: string) => SetTierNameResult
  setBackground: (tableId: string, background: string) => void
  addPool: (tableId: string, name?: string) => AddPoolResult
  renamePool: (tableId: string, poolId: string, name: string) => void
  removePool: (tableId: string, poolId: string) => void
  /** 往池子里加作品（导入 / 搜索添加共用）：已在表里的会被跳过 */
  addWorks: (tableId: string, poolId: string, works: RankingWork[]) => AddWorksResult
  removeWorkFromPool: (tableId: string, poolId: string, workId: string) => void
  /** 从池子拖进排名区（按移动语义：进排名区后从池子里消失） */
  placeWork: (
    tableId: string,
    poolId: string,
    workId: string,
    slot: RankingSlot,
    anchorId: string | null
  ) => void
  /** 排名区内换格 / 同格内排序 */
  moveRanked: (tableId: string, workId: string, slot: RankingSlot, anchorId: string | null) => void
  /** 移出排名区（右键菜单）：归还到来源池 */
  removeRanked: (tableId: string, workId: string) => RemoveRankedResult
  /** 清空排名区（同样把作品还回池子，保证这个动作是可逆的） */
  clearRanked: (tableId: string) => number
  /** 界面偏好：左侧作品池是否收起（用户要求「状态要记住」） */
  poolVisible: boolean
  setPoolVisible: (visible: boolean) => void
}

export const useRankingTable = create<RankingTableState>((set, get) => {
  /** 所有写动作的唯一出口：改内存 → 整份写回磁盘 */
  function commit(tables: RankingTable[]): void {
    set({ tables })
    void api.store.set(RANKING_STORE_KEY, tables)
  }

  /** 就地替换某一张表 */
  function patch(tableId: string, fn: (table: RankingTable) => RankingTable): RankingTable | null {
    const cur = get().tables
    const target = cur.find((t) => t.id === tableId)
    if (!target) return null
    const next = fn(target)
    commit(cur.map((t) => (t.id === tableId ? next : t)))
    return next
  }

  return {
    tables: [],
    loaded: false,
    poolVisible: true,
    load: async () => {
      // 表数据与界面偏好一次读完：两个 key 分开存（见文件头「数据怎么存」）
      const [r, ui] = await Promise.all([api.store.get(RANKING_STORE_KEY), api.store.get(RANKING_UI_KEY)])
      const uiData = ui.ok && ui.data && typeof ui.data === 'object' ? (ui.data as Record<string, unknown>) : null
      set({
        tables: r.ok ? normalizeTables(r.data) : [],
        // 只有明确写了 false 才收起：老版本没写过这个键，默认应当是"看得见作品池"
        poolVisible: uiData?.poolVisible === false ? false : true,
        loaded: true
      })
    },
    setPoolVisible: (visible) => {
      set({ poolVisible: visible })
      void api.store.set(RANKING_UI_KEY, { poolVisible: visible })
    },
    createTable: (name, tiers, background) => {
      const table: RankingTable = {
        id: localId('table'),
        name: name.trim() || '未命名排名表',
        tiers: normalizeTierList(tiers),
        items: [],
        pools: [],
        background: isHexColor(background) ? background : DEFAULT_BACKGROUND,
        createdAt: Date.now()
      }
      commit([...get().tables, table])
      return table
    },
    deleteTable: (tableId) => {
      const next = get().tables.filter((t) => t.id !== tableId)
      if (next.length === get().tables.length) return
      commit(next)
    },
    renameTable: (tableId, name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      patch(tableId, (t) => ({ ...t, name: trimmed }))
    },
    setTiers: (tableId, tiers) => {
      const list = normalizeTierList(tiers)
      const target = get().tables.find((t) => t.id === tableId)
      if (!target) return 0
      /**
       * 改档数时每条作品的去向：
       *   · 上方那一档都没了（tierIndex >= n）→ 离开排名区、回到作品池；
       *   · 上方档还在、但它是骑缝且下面没档了 → **降级**成坐在上方档里（见文件头 ③）。
       * 降级而不是丢掉：用户只是把档数改短，"已经排好的作品"不该因此退回候选池。
       */
      const lost = target.items.filter((it) => it.tierIndex >= list.length).length
      patch(tableId, (t) => {
        const items: RankedItem[] = []
        const dropped: RankedItem[] = []
        for (const it of t.items) {
          if (it.tierIndex >= list.length) {
            dropped.push(it)
            continue
          }
          const straddle = it.straddle && it.tierIndex < list.length - 1
          items.push(straddle === it.straddle ? it : { ...it, straddle })
        }
        // 出局的作品逐条还回作品池：等级改短不该让作品凭空消失（用户还能重新摆）
        let next: RankingTable = { ...t, tiers: list, items }
        for (const item of dropped) next = returnToPool(next, item)
        return next
      })
      return lost
    },
    setTierColor: (tableId, tierIndex, color) => {
      if (!isHexColor(color)) return
      patch(tableId, (t) =>
        t.tiers.some((_, i) => i === tierIndex)
          ? { ...t, tiers: t.tiers.map((tier, i) => (i === tierIndex ? { ...tier, color } : tier)) }
          : t
      )
    },
    setTierName: (tableId, tierIndex, name) => {
      const trimmed = name.trim()
      if (trimmed.length === 0) return { ok: false, message: '标签内容不能为空' }
      const target = get().tables.find((t) => t.id === tableId)
      if (!target) return { ok: false, message: '排名表不存在' }
      if (!target.tiers.some((_, i) => i === tierIndex)) return { ok: false, message: '这一档已经不存在了' }
      if (target.tiers.some((tier, i) => i !== tierIndex && tier.name === trimmed)) {
        return { ok: false, message: `已经有一档叫「${trimmed}」了，换个名字` }
      }
      patch(tableId, (t) => ({ ...t, tiers: t.tiers.map((tier, i) => (i === tierIndex ? { ...tier, name: trimmed } : tier)) }))
      return { ok: true }
    },
    setBackground: (tableId, background) => {
      if (!isHexColor(background)) return
      patch(tableId, (t) => ({ ...t, background }))
    },
    addPool: (tableId, name) => {
      const table = get().tables.find((t) => t.id === tableId)
      if (!table) return { ok: false, message: '排名表不存在' }
      if (table.pools.length >= MAX_POOLS) {
        return { ok: false, message: `最多只能建 ${MAX_POOLS} 个作品池，先删掉一个再建` }
      }
      const pool: RankingPool = {
        id: localId('pool'),
        name: (name ?? '').trim() || `作品池 ${table.pools.length + 1}`,
        works: []
      }
      patch(tableId, (t) => ({ ...t, pools: [...t.pools, pool] }))
      return { ok: true, pool }
    },
    renamePool: (tableId, poolId, name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      patch(tableId, (t) => ({ ...t, pools: t.pools.map((p) => (p.id === poolId ? { ...p, name: trimmed } : p)) }))
    },
    removePool: (tableId, poolId) => {
      patch(tableId, (t) => {
        const pools = t.pools.filter((p) => p.id !== poolId)
        // 池子没了，从它拖进排名区的作品仍然留着（排名区是用户的成果，见文件头 ②），
        // 只是把 poolId 清成 null，让「移出排名区」时落到剩下第一个池子里
        const items = t.items.map((it) => (it.poolId === poolId ? { ...it, poolId: null } : it))
        return { ...t, pools, items }
      })
    },
    addWorks: (tableId, poolId, works) => {
      const target = get().tables.find((t) => t.id === tableId)
      const pool = target?.pools.find((p) => p.id === poolId)
      if (!target || !pool) return { added: 0, skipped: works.length }
      const used = usedWorkIds(target)
      const fresh: RankingWork[] = []
      for (const w of works) {
        if (used.has(w.id)) continue
        used.add(w.id)
        fresh.push(w)
      }
      const added = fresh.length
      if (added > 0) {
        // 一次导入只写一次盘：收藏可能有几百条，逐条 commit 会写上百次
        patch(tableId, (t) => ({
          ...t,
          pools: t.pools.map((p) => (p.id === poolId ? { ...p, works: [...p.works, ...fresh] } : p))
        }))
      }
      return { added, skipped: works.length - added }
    },
    removeWorkFromPool: (tableId, poolId, workId) => {
      patch(tableId, (t) => ({
        ...t,
        pools: t.pools.map((p) => (p.id === poolId ? { ...p, works: p.works.filter((w) => w.id !== workId) } : p))
      }))
    },
    placeWork: (tableId, poolId, workId, slot, anchorId) => {
      patch(tableId, (t) => {
        const pool = t.pools.find((p) => p.id === poolId)
        const work = pool?.works.find((w) => w.id === workId)
        if (!pool || !work) return t
        const placed = withPlaced(t, work, slot, anchorId, pool.id)
        // 移动语义：进排名区就从池子里移走（见文件头 ②）
        return { ...placed, pools: placed.pools.map((p) => (p.id === pool.id ? { ...p, works: p.works.filter((w) => w.id !== workId) } : p)) }
      })
    },
    moveRanked: (tableId, workId, slot, anchorId) => {
      patch(tableId, (t) => {
        const item = t.items.find((it) => it.work.id === workId)
        if (!item) return t
        return withPlaced(t, item.work, slot, anchorId, item.poolId)
      })
    },
    removeRanked: (tableId, workId) => {
      const target = get().tables.find((t) => t.id === tableId)
      const item = target?.items.find((it) => it.work.id === workId)
      if (!target || !item) return 'dropped'
      const back: RemoveRankedResult = target.pools.length > 0 ? 'pool' : 'dropped'
      patch(tableId, (t) => returnToPool(t, item))
      return back
    },
    clearRanked: (tableId) => {
      const target = get().tables.find((t) => t.id === tableId)
      if (!target || target.items.length === 0) return 0
      const count = target.items.length
      // 逐条归还（而不是把 items 置空）：清空之后池子里能原样找回这些作品
      patch(tableId, (t) => t.items.reduce<RankingTable>((acc, item) => returnToPool(acc, item), t))
      return count
    }
  }
})

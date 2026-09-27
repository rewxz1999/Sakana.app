/*
 * 番剧表「分级标签屏蔽 + 黑名单」的配置类型与**纯函数**规则（主进程 / 渲染层共用）。
 *
 * 为什么单独放一个 shared 文件：
 * 1. 规则（哪一级屏蔽哪些标签、怎么匹配）是**唯一事实来源** —— 设置页展示的标签列表、
 *    番剧表的过滤结果、自检脚本用的是同一份常量，不会出现「界面写了 3D 但代码漏了」；
 * 2. 全是无副作用的纯函数（不碰 api / DOM / localStorage），可以在 Node 里直接跑真实源码自检；
 * 3. 配置**不进 AppSettings**（shared/types.ts 的 settings），而是单独一个 store 键
 *    `scheduleBlock` —— 屏蔽是番剧表这一个页面的事，塞进全局设置只会让设置文件越来越重，
 *    也避免以后「导出/导入设置」把屏蔽规则一起带走。
 *
 * 数据来源的现实约束（决定了本文件为什么只认「标签」）：
 * 番剧表的 CalendarItem.genres 实测**恒为空**、platform 只有 TV/剧场版/WEB/其他，
 * 所以「按标签屏蔽」「按播放平台屏蔽」都必须落到**番剧详情的 tags** 上
 * （Bangumi 的详情标签里会出现 优酷 / 腾讯视频 / 爱奇艺 / 芒果TV 这类平台名）。
 * 详情由渲染层按需补全并缓存（见 stores/schedule.ts 的 useScheduleTags）。
 */

/** 屏蔽配置（存 `store` 的 `scheduleBlock` 键；老设置文件缺键时按 DEFAULT_SCHEDULE_BLOCK 工作） */
export interface ScheduleBlockConfig {
  /** 一级：美国 / 美漫 / 英国 / 子供向（**默认开启**，用户要求） */
  l1: boolean
  /** 二级：泡面番 / 里番 */
  l2: boolean
  /** 三级：3D / 国产 / 国漫 / 玄幻 等，以及国内播放平台名 */
  l3: boolean
  /** 四级：用户自定义标签（已按 normalizeTag 归一化后保存） */
  customTags: string[]
  /** 黑名单：Bangumi 条目 id（subject id），优先级最高 */
  blacklist: number[]
}

/** 默认配置：只开一级，其余全关（用户要求「默认开启一级选项」） */
export const DEFAULT_SCHEDULE_BLOCK: ScheduleBlockConfig = {
  l1: true,
  l2: false,
  l3: false,
  customTags: [],
  blacklist: []
}

export type BlockLevel = 1 | 2 | 3 | 4

export interface BlockLevelMeta {
  level: BlockLevel
  /** 开关旁边的短标题 */
  title: string
  /** 这一级屏蔽什么（设置页的一行说明） */
  desc: string
  /** 命中即屏蔽的标签关键词（已归一化：小写 + 去首尾空格） */
  tags: string[]
}

/**
 * 国内播放平台标签。
 *
 * 为什么按标签而不是 `CalendarItem.platform`：平台字段只有 TV / 剧场版 / WEB / 其他，
 * 而 Bangumi 的详情标签里确实会出现平台名（优酷/腾讯视频/爱奇艺/芒果TV），这是唯一可用的信号。
 */
export const PLATFORM_TAGS: string[] = ['优酷', '腾讯视频', '爱奇艺', '芒果tv']

/**
 * 三级里「国产动画」这一类关键词。
 *
 * 用户点名了 3d / 国产 / 国漫 / 玄幻，这里补了三个同类的常见标签：
 * - `国创`：B 站对国产动画的官方叫法，Bangumi 也常打这个标签；
 * - `中国动画`：把「国产」的同义说法一起覆盖，只打这个标签的条目才不会漏网；
 * - `网文改`：国产网文改编的常见标签；日番一般写「轻小说改 / 小说改」，区分度高。
 *
 * **故意不加**裸的 `中国` / `大陆`：日番里以中国为题材/背景的作品（例如三国、中华风题材）
 * 也会打「中国」标签，加进去就是误杀 —— 本项目一贯的原则是宁可不屏蔽，也不能误杀。
 */
const L3_KEYWORDS: string[] = ['3d', '国产', '国漫', '玄幻', '国创', '中国动画', '网文改']

/** 分级标签表（设置页直接渲染它，保证「界面写的」与「代码匹配的」永远一致） */
export const BLOCK_LEVELS: BlockLevelMeta[] = [
  {
    level: 1,
    title: '一级屏蔽',
    desc: '欧美与低龄向：命中任一标签就不显示（默认开启）',
    tags: ['美国', '美漫', '英国', '子供向']
  },
  {
    level: 2,
    title: '二级屏蔽',
    desc: '泡面番与里番',
    tags: ['泡面番', '里番']
  },
  {
    level: 3,
    title: '三级屏蔽',
    desc: '3D、国产动画，以及只在优酷/腾讯视频/爱奇艺/芒果TV 播出的番剧',
    tags: [...L3_KEYWORDS, ...PLATFORM_TAGS]
  },
  {
    level: 4,
    title: '四级：自定义标签屏蔽',
    desc: '自己填关键词，命中番剧详情里任一标签就不显示',
    tags: []
  }
]

/** 按级别取标签关键词（1/2/3 级；4 级是用户自定义，不走这里） */
export function blockTagsOf(level: BlockLevel): string[] {
  return BLOCK_LEVELS.find((l) => l.level === level)?.tags ?? []
}

/** 标签归一化：去首尾空格 + 转小写（`3D` 与 `3d`、`芒果TV` 与 `芒果tv` 视为同一个） */
export function normalizeTag(raw: string): string {
  return String(raw ?? '').trim().toLowerCase()
}

/**
 * 解析「逗号或换行分隔」的自定义标签。
 *
 * 容错点（用户手输的文本很随意，这里全都吃掉）：
 * - 分隔符：半角逗号 `,`、全角逗号 `，`、顿号 `、`、分号 `;；`、换行/回车、制表符；
 * - 每个词去首尾空格，忽略大小写（统一小写后比较）；
 * - 去重、丢掉空串；
 * - 传入数组（已存盘的旧值）时先 join 再按同样规则解析，
 *   这样「以前用逗号存进去的一整串」也能被正确拆开。
 */
export function parseCustomTags(raw: string | readonly string[] | null | undefined): string[] {
  const text = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '')
  const out: string[] = []
  for (const part of text.split(/[,，、;；\r\n\t]+/)) {
    const n = normalizeTag(part)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

/** 把任意来源（IPC 读回的旧值 / 局部 patch）补成完整配置；非法值一律回落到默认值 */
export function resolveBlockConfig(raw: unknown): ScheduleBlockConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ScheduleBlockConfig>
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  const ids = Array.isArray(r.blacklist) ? r.blacklist : []
  return {
    l1: bool(r.l1, DEFAULT_SCHEDULE_BLOCK.l1),
    l2: bool(r.l2, DEFAULT_SCHEDULE_BLOCK.l2),
    l3: bool(r.l3, DEFAULT_SCHEDULE_BLOCK.l3),
    customTags: parseCustomTags(Array.isArray(r.customTags) ? r.customTags : []),
    // id 去重 + 只保留有限数字（手改过 store 文件时也不能让 NaN 混进来）
    blacklist: [...new Set(ids.map((n) => Number(n)).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b)
  }
}

/**
 * 是否需要**为了屏蔽去取标签**。
 *
 * 这是「开关全关时不发任何标签请求」的唯一判据：四级自定义也关着、黑名单也空着时返回 false。
 * 注意黑名单不需要标签（按 id 直接命中），所以它不参与这里的判断。
 */
export function shouldLoadTags(cfg: Partial<ScheduleBlockConfig> | null | undefined): boolean {
  const c = resolveBlockConfig(cfg)
  return c.l1 || c.l2 || c.l3 || c.customTags.length > 0
}

/** 有没有任何屏蔽规则生效（黑名单也算）；番剧表据此决定要不要显示提示条 */
export function isBlockingActive(cfg: Partial<ScheduleBlockConfig> | null | undefined): boolean {
  const c = resolveBlockConfig(cfg)
  return shouldLoadTags(c) || c.blacklist.length > 0
}

/** 标签命中判据：**标签名包含关键词**即命中（用户原话「屏蔽含有 X 的标签的番剧」） */
export function tagMatches(tag: string, keyword: string): boolean {
  const t = normalizeTag(tag)
  const k = normalizeTag(keyword)
  if (!t || !k) return false
  return t.includes(k)
}

/**
 * 在一条番剧的标签里找出第一个命中的关键词 —— 按**标签本身的顺序**（Bangumi 的 tags 按热度降序）
 * 遍历标签、每个标签再依次比对关键词。
 *
 * 返回的是**原始标签名**（不是关键词）：界面与日志要能说明「命中的到底是哪个标签」，
 * 例如关键词写的是 `3d`、数据里的标签是 `3D`，原因里显示 `3D` 才解释得清。
 */
function firstTagHit(tags: readonly string[], keywords: readonly string[]): string | null {
  for (const tag of tags) {
    for (const k of keywords) {
      if (tagMatches(tag, k)) return String(tag).trim()
    }
  }
  return null
}

export interface BlockTarget {
  id: number
}

/**
 * 判断一条番剧是否该被番剧表屏蔽，命中返回**可读原因**，不命中返回 null。
 *
 * 语义（顺序即优先级）：
 * 1. 黑名单优先 —— 命中的原因固定是 `黑名单`，不再看标签；
 * 2. **没拿到标签（undefined / 空数组）时一律返回 null** ——
 *    宁可不屏蔽，也不能误杀：标签要逐条补详情才有，网络失败/反代 503 时若把「标签未知」
 *    当成「没命中任何屏蔽词」之外的第三种状态去屏蔽，用户会莫名其妙少一半番剧。
 *    所以「未知」= 不屏蔽，这是本功能的硬约束；
 * 3. 一级 → 二级 → 三级 → 四级自定义，返回最早命中的那一级（`一级：子供向` 这种格式）。
 */
export function blockReason(
  item: BlockTarget,
  tags: readonly string[] | null | undefined,
  cfg: Partial<ScheduleBlockConfig> | null | undefined
): string | null {
  const c = resolveBlockConfig(cfg)
  if (c.blacklist.includes(item.id)) return '黑名单'
  if (!tags || tags.length === 0) return null
  if (c.l1) {
    const hit = firstTagHit(tags, blockTagsOf(1))
    if (hit) return `一级：${hit}`
  }
  if (c.l2) {
    const hit = firstTagHit(tags, blockTagsOf(2))
    if (hit) return `二级：${hit}`
  }
  if (c.l3) {
    const hit = firstTagHit(tags, blockTagsOf(3))
    if (hit) return `三级：${hit}`
  }
  if (c.customTags.length > 0) {
    const hit = firstTagHit(tags, c.customTags)
    if (hit) return `四级：${hit}`
  }
  return null
}

/** 条目 id → 已经拿到的标签（取不到 = 键不存在 / undefined = 不屏蔽） */
export type TagLookup = Record<number, readonly string[] | undefined> | Map<number, readonly string[]>

function lookupTags(tagsById: TagLookup, id: number): readonly string[] | undefined {
  if (tagsById instanceof Map) return tagsById.get(id)
  return tagsById[id]
}

export interface BlockableItem {
  id: number
  name?: string | null
  name_cn?: string | null
}

export interface BlockedItem<T> {
  item: T
  /** 命中原因（blockReason 的返回值） */
  reason: string
}

/**
 * 按配置把一批条目拆成「保留」与「被屏蔽（带原因）」两组。
 *
 * 番剧表页用 `blocked.length` 显示「已按番剧表设置屏蔽 N 部」，
 * 用 `kept` 渲染卡片并对星期按钮计数 —— **被屏蔽的条目不参与渲染与计数**。
 */
export function splitBlocked<T extends BlockableItem>(
  items: readonly T[],
  tagsById: TagLookup,
  cfg: Partial<ScheduleBlockConfig> | null | undefined
): { kept: T[]; blocked: BlockedItem<T>[] } {
  const c = resolveBlockConfig(cfg)
  const kept: T[] = []
  const blocked: BlockedItem<T>[] = []
  for (const item of items) {
    const reason = blockReason(item, lookupTags(tagsById, item.id), c)
    if (reason) blocked.push({ item, reason })
    else kept.push(item)
  }
  return { kept, blocked }
}

/** 屏蔽原因统计（`{ '一级：子供向': 3, 黑名单: 1 }`）—— 自检脚本与日志用 */
export function summarizeBlocked(blocked: readonly { reason: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const b of blocked) out[b.reason] = (out[b.reason] ?? 0) + 1
  return out
}

/*
 * ------------------------- 标签补全的节流队列 -------------------------
 *
 * 为什么需要它：番剧表要屏蔽就必须知道每条的标签，而标签只能一条一条查详情。
 * 111 条一次性并发会把反代打到 503（项目历史上已经踩过一次，见 stores/schedule.ts 的注释），
 * 所以这里统一用「并发 2 + 每条之间 sleep」的批量队列，并且：
 * - 连续失败到阈值就**中止余下请求**（反代挂了时不要继续砸），
 *   中止掉的与失败的 id 都进 `failed`，界面据此说明「N 部未取到标签（不屏蔽）」；
 * - 队列只处理去重后的 id，已经取到的由调用方（渲染层的标签缓存）提前过滤掉。
 */

/** 并发上限（用户要求「并发必须很小，建议 2」） */
export const TAG_FETCH_CONCURRENCY = 2
/** 两条请求之间的间隔（用户要求 100~200ms，取中间值 150ms） */
export const TAG_FETCH_GAP_MS = 150
/** 连续失败达到这个数就中止队列（反代整体不可用时的止损） */
export const TAG_FETCH_MAX_CONSECUTIVE_FAILURES = 4

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface TagFetchResult<T> {
  /** 成功拿到的 id → 值 */
  ok: Map<number, T>
  /** 失败 + 因中止而未请求的 id（两者对屏蔽而言等价：都不屏蔽） */
  failed: number[]
  /** 是否因为连续失败提前中止 */
  aborted: boolean
}

export interface TagFetchOptions<T> {
  concurrency?: number
  gapMs?: number
  maxConsecutiveFailures?: number
  /** 每拿到一个结果就回调一次（调用方用它做**渐进式**落盘，中断也不丢已取到的部分） */
  onResult?: (id: number, value: T | null) => void
}

/**
 * 受控地批量取标签：并发 `concurrency`，每批之间 `gapMs`。
 *
 * `fetchOne` 返回 null / 抛错都算失败（失败降级由调用方处理：不屏蔽该条目）。
 * 返回的 `ok` / `failed` 覆盖所有入参 id（除非中止，中止时余下的进 failed）。
 */
export async function fetchTagsThrottled<T>(
  ids: readonly number[],
  fetchOne: (id: number) => Promise<T | null>,
  opts: TagFetchOptions<T> = {}
): Promise<TagFetchResult<T>> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? TAG_FETCH_CONCURRENCY))
  const gapMs = Math.max(0, Math.floor(opts.gapMs ?? TAG_FETCH_GAP_MS))
  const maxFail = Math.max(1, Math.floor(opts.maxConsecutiveFailures ?? TAG_FETCH_MAX_CONSECUTIVE_FAILURES))

  const queue = [...new Set(ids)]
  const ok = new Map<number, T>()
  const failed: number[] = []
  let consecutiveFailures = 0
  let cursor = 0
  let aborted = false

  while (cursor < queue.length) {
    const batch = queue.slice(cursor, cursor + concurrency)
    cursor += batch.length
    // 一批内并发（Promise.all），批间串行 —— 这样「同时最多 2 个在途请求」是可验证的
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          return { id, value: await fetchOne(id) }
        } catch {
          return { id, value: null as T | null }
        }
      })
    )
    for (const r of results) {
      if (r.value === null || r.value === undefined) {
        failed.push(r.id)
        consecutiveFailures++
      } else {
        ok.set(r.id, r.value)
        consecutiveFailures = 0
      }
      opts.onResult?.(r.id, r.value ?? null)
    }
    if (consecutiveFailures >= maxFail) {
      aborted = true
      break
    }
    if (cursor < queue.length && gapMs > 0) await sleep(gapMs)
  }

  if (aborted) {
    // 中止后没轮到的 id 也记为失败：它们同样「没有标签」，因此同样不参与屏蔽
    for (let i = cursor; i < queue.length; i++) failed.push(queue[i])
  }
  return { ok, failed, aborted }
}

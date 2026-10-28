/**
 * 本地缓存数据库的**保留策略**（V1.5.1）—— 纯函数 + 常量，主进程与界面共用同一份。
 *
 * 为什么单独一个文件：
 *   · 用户给的是一张「时间表」（收藏永久 / 当季一个季度 / 历史表 15 天 / 其它 7 天），
 *     这张表既决定主进程删什么，也要**原样显示在设置页**。两处各写一遍必然对不上
 *     （界面上写 15 天、代码里其实是 7 天，用户只会觉得"清理不听话"），
 *     所以把数字与判定规则都放在这里，清理器和设置页都只读它。
 *   · 全是无副作用的纯函数，可以在 Node 里直接跑断言（`.e2e/verify-cache-policy.mjs`），
 *     不需要起 Electron —— 时间相关的逻辑最怕"看代码觉得对"，需要能真跑边界。
 *
 * 时间表的来历（用户原话，逐条对应）：
 *   | 被收藏番剧                  | 永久（除非被取消收藏）        |
 *   | 当季新番（番剧表中的番剧）  | 一个季度（3 个月）            |
 *   | 历史表中的番剧（仅加载过的） | 15 天                        |
 *   | 其它近期被加载过信息的番剧  | 7 天                         |
 *
 * 「被加载过信息」的口径：只要加载出封面（哪怕只加载出一点数据）就算，
 * 所以判定发生在**真的写出/读到条目数据**的地方（见 cacheDb 的 touch），
 * 而不是"打开过番剧表"。
 */

/** 一天的毫秒数：所有时长都用它乘，避免出现 86400 * 1000 这类散落魔数 */
export const DAY_MS = 86_400_000

/**
 * 一条缓存归属的档位（从永久到最近，优先级从高到低）。
 *
 * 注意这里是**四选一**：同一部番同时被收藏、又在当季表里时按收藏算（永久），
 * 因为"收藏"是用户的显式意愿，任何自动清理都不该覆盖它。
 */
export type CacheTier = 'favorite' | 'season' | 'history' | 'recent'

/** 档位顺序（设置页按这个顺序显示，也是优先级顺序） */
export const CACHE_TIER_ORDER: CacheTier[] = ['favorite', 'season', 'history', 'recent']

/** 番剧**信息**（条目/角色/评分/集数 JSON）的保留时长 */
export const CACHE_TTL: Record<CacheTier, number> = {
  favorite: Number.POSITIVE_INFINITY,
  season: 90 * DAY_MS,
  history: 15 * DAY_MS,
  recent: 7 * DAY_MS
}

/**
 * 番剧**图片**的保留时长。
 *
 * 用户原话：「图片之类的信息一定要缓存的久一点，因为图片的数据量是最大的」。
 * 数据量大 → 重新拉取最贵（一张封面原图 900KB、缩放图 5~50KB，且要占用反代并发额度），
 * 所以图片一律比同档位的信息多留一截：7→30 天、15→60 天、一个季度→半年。
 *
 * V1.5.3 又整体拉长了一档（原来 15/30/120 天）：用户第二次要求「图片跨页面复用 + 更长缓存」，
 * 而翻页/切季度之后重新拉一屏封面既慢又费流量；图片文件本身没有时效性（换封面是极少见的事），
 * 留旧了也不会显示错内容 —— 地址里带尺寸/路径，同名不同图的情况不存在。
 * 收藏的图片与收藏信息一样是永久的 —— 否则用户的收藏卡会在一年后集体变成灰块，
 * 而重新加载要再打一遍 API，正好和"减少 api 压力"的目标相反。
 */
export const CACHE_IMAGE_TTL: Record<CacheTier, number> = {
  favorite: Number.POSITIVE_INFINITY,
  season: 180 * DAY_MS,
  history: 60 * DAY_MS,
  recent: 30 * DAY_MS
}

/** 档位 → 界面文案（设置页与清理日志共用，避免同一个档位有两种叫法） */
export const CACHE_TIER_LABEL: Record<CacheTier, string> = {
  favorite: '收藏',
  season: '当季新番表',
  history: '历史表',
  recent: '其它近期加载'
}

/** 判定输入：只关心"它在哪个表里"，不关心具体是哪个接口拿到的 */
export interface CacheTierInput {
  /** 是否被收藏（store 'favorites'） */
  favorite: boolean
  /** 是否属于**当季**番剧表（日历 / 当前季度，读的是当时抓取时的季度标记） */
  inCurrentSeason: boolean
  /** 是否属于**历史表**（历史表里被加载过的年份/季度） */
  inHistory: boolean
}

/**
 * 优先级判定：收藏 > 当季 > 历史表 > 其它近期。
 *
 * 为什么"历史表"排在"当季"之后：一部番可能同时出现在两处（例如本季正在播、用户又在历史表里翻到它），
 * 当季那份的保留时长更长、复用到它的页面也更多，所以按更长的那档算 ——
 * 缓存清理的原则是"宁可多留，不能把正在用的删掉"。
 */
export function tierOf(input: CacheTierInput): CacheTier {
  if (input.favorite) return 'favorite'
  if (input.inCurrentSeason) return 'season'
  if (input.inHistory) return 'history'
  return 'recent'
}

/**
 * 是否已过期。
 *
 * `ttl` 显式传入（而不是在函数里查表）：信息与图片用的是两张表，
 * 调用方必须自己说清问的是哪一张，避免「用信息 TTL 去删图片」这种静默的错误。
 */
export function isExpired(tier: CacheTier, lastAccessAt: number, now: number, ttl: Record<CacheTier, number>): boolean {
  const limit = ttl[tier]
  if (!Number.isFinite(limit)) return false
  if (!Number.isFinite(lastAccessAt) || lastAccessAt <= 0) return true
  return now - lastAccessAt > limit
}

/** 设置页要显示的一行策略说明（数字直接来自上面的常量，界面不写死） */
export interface CachePolicyRow {
  tier: CacheTier
  label: string
  /** 信息保留时长的人话描述 */
  keep: string
  /** 图片保留时长的人话描述 */
  imageKeep: string
  /** 说明（为什么是这样） */
  note: string
}

/** 把毫秒说成人话：永久 / N 天 / N 个月（三个月与四个月按 30 天折算，面板上不需要精确到天） */
export function humanizeKeep(ms: number): string {
  if (!Number.isFinite(ms)) return '永久'
  const days = Math.round(ms / DAY_MS)
  if (days % 30 === 0 && days >= 30) return `${days / 30} 个月（${days} 天）`
  return `${days} 天`
}

/** 策略表（设置页直接渲染它：界面上的数字永远等于清理器用的数字） */
export function cachePolicyRows(): CachePolicyRow[] {
  return [
    {
      tier: 'favorite',
      label: CACHE_TIER_LABEL.favorite,
      keep: humanizeKeep(CACHE_TTL.favorite),
      imageKeep: humanizeKeep(CACHE_IMAGE_TTL.favorite),
      note: '取消收藏后自动降级到下面某一档，重新开始计时'
    },
    {
      tier: 'season',
      label: CACHE_TIER_LABEL.season,
      keep: humanizeKeep(CACHE_TTL.season),
      imageKeep: humanizeKeep(CACHE_IMAGE_TTL.season),
      note: '番剧表过季后自动降级为历史表口径'
    },
    {
      tier: 'history',
      label: CACHE_TIER_LABEL.history,
      keep: humanizeKeep(CACHE_TTL.history),
      imageKeep: humanizeKeep(CACHE_IMAGE_TTL.history),
      note: '只缓存历史表里**真的加载过信息**的番剧'
    },
    {
      tier: 'recent',
      label: CACHE_TIER_LABEL.recent,
      keep: humanizeKeep(CACHE_TTL.recent),
      imageKeep: humanizeKeep(CACHE_IMAGE_TTL.recent),
      note: '搜索/详情等临时加载过的番剧'
    }
  ]
}

/**
 * 一条缓存记录的展示用摘要（设置页"最近缓存"列表）。
 *
 * 放 shared 是因为渲染层要画它，而它由主进程算好（主进程才知道磁盘上的真实字节数）。
 */
export interface CacheDbEntrySummary {
  id: number
  title: string
  cover: string
  tier: CacheTier
  /** 信息 JSON 的字节数 */
  infoBytes: number
  /** 已知关联图片的字节数 */
  imageBytes: number
  /** 最近一次访问（毫秒时间戳） */
  lastAccessAt: number
  /** 信息是否已被清理（只剩图片） */
  infoRemoved: boolean
}

import type { DanmakuComment, DanmakuOrigin, DanmakuSourceRunInfo } from '@shared/types'
import { DEFAULT_TOLERANCE_MS, mergeDanmakuBatches } from '@shared/danmakuTimeline'
import { log } from '../log'

/**
 * 弹幕集成器（V1.2 弹幕重构的第四层）。
 *
 * 位置：`弹幕源 → fetcher → 本地缓存 → **集成器** → 播放器`。
 *
 * ## 为什么要有独立一层
 * 旧实现里"合并"散落在三处：内置弹弹play 在同集多来源那里写了一遍去重、
 * 数据源那一路又写了一遍、渲染层拿到两段结果再写第三遍。三处口径一旦不同就会出现
 * "第二段合并后反而变少"或"同一条弹幕出现两次"。用户这次明确要求**多源合并只有一个入口**，
 * 所以从这里开始，所有"把几批弹幕变成一批"的动作都必须调用 `integrateDanmaku`：
 *   · 主进程第一段（内置 + 本地缓存）；
 *   · 主进程第二段（已启用的数据源）；
 *   · 渲染层拿到第二段后与画面上那一批的合并（只调 `mergeComments`，同一套去重键）。
 *
 * ## 去重与排序
 * 交给 `@shared/danmakuTimeline`（渲染层也要用同一套）。这里只负责**元数据**：
 * 每个源原始多少条、谁来自缓存、主来源是谁 —— 播放器状态区与「获取记录」靠它说清"这批从哪来"。
 */

/** 一批来自某个源的弹幕（缓存命中或刚抓下来的都算） */
export interface DanmakuBatch {
  sourceId: string
  sourceName: string
  comments: DanmakuComment[]
  /** 这一批是否来自本地缓存（true 表示没有为它发网络请求） */
  fromCache?: boolean
  /** 命中条目/文件的一句话说明 */
  detail?: string
  /** 源内条目名（便于用户核对） */
  entryName?: string
  /** 实际搜到的关键词（巴哈要用日文名/繁体名，这一栏是证据） */
  keyword?: string
  /** 这一趟耗时（毫秒） */
  ms?: number
  /** 来源类型（默认按 sourceId 猜） */
  kind?: DanmakuOrigin['kind']
  /** 这批的优先级（越小越靠前；默认按传入顺序） */
  priority?: number
}

export interface DanmakuIntegration {
  /** 合并去重、按时间排好序的最终时间轴 */
  comments: DanmakuComment[]
  count: number
  /** 每个源的原始条数（**去重前**，用户看到的"巴哈 3001 条"就是这个数） */
  sources: DanmakuSourceRunInfo[]
  /** 主来源（状态区显示「来自 …」；没有批次时为 null） */
  primary: DanmakuOrigin | null
  /** 所有参与合并的批次都来自缓存 → 本次没有为弹幕发网络请求 */
  fromCache: boolean
  /** 本次合并去掉了多少条重复（日志与自检用） */
  duplicates: number
}

function kindOf(batch: DanmakuBatch): DanmakuOrigin['kind'] {
  if (batch.kind) return batch.kind
  if (batch.sourceId === 'builtin') return 'builtin'
  if (batch.sourceId === 'library') return 'library'
  if (batch.sourceId === 'bahamut') return 'api'
  if (batch.sourceId === 'danmubox') return 'site'
  return 'link'
}

/**
 * 多批弹幕 → 一条时间轴（**唯一入口**）。
 *
 * ## 上限从 8000 提到 20000 的真实原因（V1.1.4，用户报的"看不到源弹幕"）
 *
 * 原来的 8000 是**整条时间轴的总量上限**，先到先占。实测（真机日志）：
 *   内置弹弹play 这一批自己就有 8000 条 → 直接把额度占满 → 巴哈姆特那 3001 条**一条都进不去**，
 *   而日志里还把这件事写成"去重 3001 条"，看起来像"重复被去掉"，实际上是**被额度饿死了**。
 *   用户看到的就是"设置里测试能搜到 3001 条，播放时却没有源弹幕"。
 *
 * 为什么敢提到 20000：渲染层早就是**按时间开窗**（`[t-2s, t+12s]`），同一时刻真正参与绘制的
 * 只有几百条，条数多只是内存里多一个数组；而 IPC 传的是同一个数组的一份拷贝。
 * 真出现几万条的单集，20000 仍然是安全阀 —— 超了照样截断并写日志，不静默丢。
 */
export function integrateDanmaku(
  batches: readonly DanmakuBatch[],
  opts: { toleranceMs?: number; maxComments?: number } = {}
): DanmakuIntegration {
  const ordered = [...batches]
    .filter((b) => b && Array.isArray(b.comments) && b.comments.length > 0)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))

  const rawTotal = ordered.reduce((n, b) => n + b.comments.length, 0)
  const comments = mergeDanmakuBatches(
    ordered.map((b) => b.comments),
    { toleranceMs: opts.toleranceMs ?? DEFAULT_TOLERANCE_MS, maxComments: opts.maxComments ?? 20000 }
  )

  const sources: DanmakuSourceRunInfo[] = ordered.map((b) => ({
    sourceId: b.sourceId,
    sourceName: b.sourceName,
    count: b.comments.length,
    fromCache: b.fromCache === true,
    detail: b.detail ?? '',
    ms: b.ms
  }))

  const first = ordered[0]
  const primary: DanmakuOrigin | null = first
    ? {
        sourceId: first.sourceId,
        sourceName: first.sourceName,
        kind: kindOf(first),
        detail: first.detail ?? `${first.sourceName} ${first.comments.length} 条`,
        entryName: first.entryName
      }
    : null

  const duplicates = Math.max(0, rawTotal - comments.length)
  if (ordered.length > 1) {
    log.append(
      'info',
      'danmaku',
      `集成器合并 ${ordered.length} 个来源：${sources.map((s) => `${s.sourceName}:${s.count}`).join(' + ')}` +
        ` → 去重 ${duplicates} 条，最终 ${comments.length} 条`
    )
  }
  return {
    comments,
    count: comments.length,
    sources,
    primary,
    fromCache: ordered.length > 0 && ordered.every((b) => b.fromCache === true),
    duplicates
  }
}

/**
 * 合并两批弹幕（渲染层第二段合并用）。
 *
 * 与集成器同一套去重键；保留这个薄封装是因为渲染层只需要"两批 → 一批"，
 * 不需要每个源的元数据。**不要再在别处写第三份去重逻辑。**
 */
export function mergeComments(
  a: DanmakuComment[],
  b: DanmakuComment[],
  toleranceMs = DEFAULT_TOLERANCE_MS
): DanmakuComment[] {
  return mergeDanmakuBatches([a, b], { toleranceMs })
}

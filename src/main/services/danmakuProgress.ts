import type { DanmakuLoadProgress, DanmakuProgressSnapshot } from '@shared/types'
import { log } from '../log'

/**
 * 弹幕获取进度（V1.2）。
 *
 * ## 为什么由主进程维护
 * 真正的步骤（搜索番剧 → 取集列表 → 取弹幕 → 写本地缓存）都发生在主进程，而且可能**多源并行**。
 * 渲染层只能看到"最后拿到多少条"，看不到"卡在哪一步、是不是有一个源一直没回来"。
 * 用户要求在「播放流详情」里看到「正在从巴哈姆特取弹幕… 第 3/5 步」，所以这里把每一步记下来，
 * 渲染层按秒轮询快照即可 —— 不推送事件、不增加常驻开销。
 *
 * ## 为什么要保留"每个源最近一步"
 * 多源合并时（巴哈 + 弹幕盒子同时开），只看一条进度会掩盖"另一个源其实已经失败"。
 * 这里同时给出 `current`（整体焦点）与 `sources`（每个源各自的状态），详情面板两个都显示。
 */

const MAX_RECORDS = 60

let records: DanmakuLoadProgress[] = []
/** 最近一次 beginLoad 的标题/集数（步骤上报时补全，避免每个调用方都传一遍） */
let session: { title: string; episode: number; startedAt: number } = { title: '', episode: 0, startedAt: 0 }

function push(rec: DanmakuLoadProgress): void {
  // 同一个源**同一集**的相邻步骤合并成一条，避免 4 步占 4 条把最近记录挤爆
  const i = records.findIndex(
    (r) =>
      r.sourceId === rec.sourceId &&
      r.sourceName === rec.sourceName &&
      r.title === rec.title &&
      r.episode === rec.episode &&
      r.startedAt === rec.startedAt
  )
  if (i >= 0) records[i] = rec
  else records.unshift(rec)
  if (records.length > MAX_RECORDS) records = records.slice(0, MAX_RECORDS)
}

/** 开始一轮加载（同一集可能随后启动多个源） */
export function progressBegin(title: string, episode: number): void {
  session = { title: String(title ?? ''), episode: Number(episode) || 0, startedAt: Date.now() }
  /*
   * 不在这里清空历史：用户切回同一集时，如果所有源都命中缓存，本轮不会产生任何新步骤，
   * 详情面板应当显示"上一轮已经完成/缓存命中"，而不是突然变成空白。
   * `progressSnapshot` 的 `current` 取最近更新的一条，旧集记录最多把 `steps` 挤到后面。
   */
}

function sourceRecord(
  sourceId: string,
  sourceName: string,
  step: number,
  total: number,
  label: string,
  done = false,
  error?: string
): DanmakuLoadProgress {
  const now = Date.now()
  const prev = records.find(
    (r) =>
      r.sourceId === sourceId &&
      r.sourceName === sourceName &&
      r.title === session.title &&
      r.episode === session.episode
  )
  return {
    active: !done && !error,
    title: session.title,
    episode: session.episode,
    sourceId,
    sourceName,
    step: Math.max(1, Math.trunc(step)),
    total: Math.max(1, Math.trunc(total)),
    label,
    startedAt: prev?.startedAt ?? session.startedAt ?? now,
    updatedAt: now,
    done: done && !error,
    error
  }
}

/** 上报一步（`active` 会保持 true，直到 done/fail） */
export function progressStep(
  sourceId: string,
  sourceName: string,
  step: number,
  total: number,
  label: string
): void {
  push(sourceRecord(sourceId, sourceName, step, total, label))
}

/** 这个源成功结束 */
export function progressDone(sourceId: string, sourceName: string, step: number, total: number, label: string): void {
  push(sourceRecord(sourceId, sourceName, step, total, label, true))
}

/** 这个源失败（保留错误原因，详情面板直接显示） */
export function progressFail(
  sourceId: string,
  sourceName: string,
  step: number,
  total: number,
  label: string,
  error: string
): void {
  push(sourceRecord(sourceId, sourceName, step, total, label, true, error))
  log.append('warn', 'danmaku', `获取进度：${sourceName} 第 ${step}/${total} 步失败 —— ${error}`)
}

/**
 * 当前快照。
 *
 * `current` 的选择顺序：正在跑的（最近更新）→ 最近一条已结束的。
 * 这样详情面板在网络请求结束后仍能看到"最后一次结果"，而不是突然空白。
 */
export function progressSnapshot(): DanmakuProgressSnapshot {
  const active = records.filter((r) => r.active).sort((a, b) => b.updatedAt - a.updatedAt)
  const latest = [...records].sort((a, b) => b.updatedAt - a.updatedAt)
  /*
   * 有进行中的就显示进行中的；都结束了优先显示**成功**的那条。
   * 为什么不总是显示最新一条：多源并行时内置库经常先失败（没条目），
   * 如果它的 updatedAt 更晚，详情面板就会显示"失败"，而实际上巴哈已经成功——
   * 用户会误以为这一集没有弹幕。失败的源仍会列在 `sources` 里。
   */
  const current = active[0] ?? latest.find((r) => r.done && !r.error) ?? latest[0] ?? null

  // 每个源只留最近一条
  const bySource = new Map<string, DanmakuLoadProgress>()
  for (const r of latest) {
    const key = `${r.sourceId}|${r.sourceName}|${r.title}|${r.episode}`
    if (!bySource.has(key)) bySource.set(key, r)
  }

  return {
    current,
    sources: [...bySource.values()].slice(0, 6),
    steps: latest.slice(0, 12)
  }
}

/** 自检 / 换集时清空（避免详情面板显示上一集的进度） */
export function progressReset(): void {
  records = []
  session = { title: '', episode: 0, startedAt: 0 }
}

import { log } from '../log'
import { appendFetchRecord } from './danmakuFetchLog'
import { readCachedSource, resetCacheStats, writeCachedSource } from './danmakuCache'
import { progressDone, progressFail, progressStep } from './danmakuProgress'
import type { DanmakuBatch } from './danmakuIntegrator'
import { bahamutKeywords } from './danmaku/bahamut'
import { enabledFetchers, type EnabledFetcher } from './danmaku/index'
import type { FetcherContext, FetcherEntry, FetcherEpisodeResult } from './danmaku/types'
import { FETCH_STEPS } from './danmaku/types'

/**
 * 「获取器 → 本地缓存」执行层（V1.2 弹幕重构的第三层前半）。
 *
 * 职责只有三件：
 *   1. 对每个启用的源先查缓存（命中就不发请求）；
 *   2. 未命中时驱动该源的 fetcher（搜索 → 取集 → 取弹幕），把结果写成
 *      `<缓存根>/弹幕/<番剧名>/第NN集-<源名>.xml`；
 *   3. 把每个源的原始条数/耗时/关键词交给集成器与「获取记录」。
 *
 * 它**不合并**（合并只有一个入口：`danmakuIntegrator.integrateDanmaku`），也**不决定**
 * 第一段/第二段的先后（那是 `danmaku.ts` 的事）。这样每一层都能单独测。
 */

export interface SourceRunOutput {
  batches: DanmakuBatch[]
  errors: string[]
  cacheHits: number
}

export interface SourceRunInput {
  title: string
  episode: number
  aliases: string[]
  /** 用户手动输入的别名搜索词 */
  keyword?: string
  /** 番剧库条目 id（巴哈取日文原名用） */
  subjectId?: number
  /** true = 不信缓存，重新请求并覆盖缓存（「重新检测弹幕」） */
  force?: boolean
  /**
   * V1.2：只跑这些源（按显示名）。第一段已经命中缓存的源不再重复读一遍缓存，
   * 也避免同一集同一源出现两条「本地缓存命中」日志。
   */
  missingSourceNames?: string[]
  trigger: 'play' | 'test' | 'manual'
}

/**
 * 网络计数（自检用）。
 *
 * 为什么单独计数而不是数日志：用户要的证据是"第二次进同一集不应出现网络请求"，
 * 这必须是一个能被脚本断言的数字，不能靠人看日志。缓存命中时它为 0。
 */
let networkFetches = 0
let cacheHits = 0
let cacheMisses = 0

export function sourceRunnerStats(): { networkFetches: number; cacheHits: number; cacheMisses: number } {
  return { networkFetches, cacheHits, cacheMisses }
}

export function resetSourceRunnerStats(): void {
  networkFetches = 0
  cacheHits = 0
  cacheMisses = 0
  resetCacheStats()
}

/** 内置弹弹play 的一趟请求也要计入（否则"0 网络请求"会漏掉它，自检结论就不诚实） */
export function noteNetworkFetch(): void {
  networkFetches++
}

/** 关键词候选：巴哈要日文/繁体；其它源按「用户输入 → 番剧名 → 别名」 */
async function keywordsFor(binding: EnabledFetcher, input: SourceRunInput): Promise<string[]> {
  const ctx: FetcherContext = {
    title: input.title,
    episode: input.episode,
    aliases: input.aliases,
    keyword: input.keyword,
    subjectId: input.subjectId,
    source: binding.source
  }
  if (binding.fetcher.id === 'bahamut') return await bahamutKeywords(ctx)

  const out: string[] = []
  const push = (s: unknown): void => {
    const t = String(s ?? '').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  push(input.keyword)
  push(binding.source?.matchMode === 'keyword' ? binding.source.keyword : '')
  push(input.title)
  for (const a of input.aliases) push(a)
  return out
}

/** 从多个关键词/候选条目里试出第一个能取到该集的 */
async function fetchOne(binding: EnabledFetcher, input: SourceRunInput, keywords: string[]): Promise<FetcherEpisodeResult> {
  const errors: string[] = []
  const ctxBase: FetcherContext = {
    title: input.title,
    episode: input.episode,
    aliases: input.aliases,
    keyword: input.keyword,
    subjectId: input.subjectId,
    source: binding.source
  }
  for (const kw of keywords) {
    const ctx: FetcherContext = {
      ...ctxBase,
      onProgress: (p) => progressStep(binding.fetcher.id, binding.name, p.step, p.total, p.label)
    }
    let entries: FetcherEntry[] = []
    try {
      networkFetches++
      entries = await binding.fetcher.search(kw, ctx)
    } catch (err) {
      errors.push(`搜索「${kw}」失败：${String((err as Error)?.message ?? err)}`)
      continue
    }
    if (entries.length === 0) {
      errors.push(`搜索「${kw}」没有结果`)
      continue
    }
    for (const entry of entries.slice(0, 3)) {
      try {
        networkFetches++
        const r = await binding.fetcher.fetchEpisode(entry, input.episode, ctx)
        if (r.comments.length > 0) return r
        errors.push(`「${entry.title}」第 ${input.episode} 集没有弹幕`)
      } catch (err) {
        errors.push(`「${entry.title}」：${String((err as Error)?.message ?? err)}`)
      }
    }
  }
  throw new Error(errors.slice(0, 4).join('；') || '没有可用的关键词/条目')
}

/**
 * 跑一遍所有启用的源（并行），返回**每个源**的批次。
 *
 * 为什么并行：用户既要求"必须调用源"又要求"快"；串行等巴哈再等盒子会把首屏拖到十几秒。
 * 每个源自己的失败只影响它自己（`Promise.allSettled`），一个源挂了另一个仍能出弹幕。
 */
export async function runEnabledSources(input: SourceRunInput): Promise<SourceRunOutput> {
  const wanted = input.missingSourceNames ? new Set(input.missingSourceNames) : null
  const bindings = enabledFetchers().filter((b) => !wanted || wanted.has(b.name))
  const out: SourceRunOutput = { batches: [], errors: [], cacheHits: 0 }
  if (bindings.length === 0 && !wanted) {
    out.errors.push('没有启用的弹幕源（设置 → 弹幕 → 选择启用弹幕源）')
    return out
  }

  const settled = await Promise.allSettled(
    bindings.map(async (binding): Promise<DanmakuBatch | null> => {
      const t0 = Date.now()
      const name = binding.name
      // 1) 缓存优先（用户要求：命中就直接用，不再请求）
      if (!input.force) {
        const hit = readCachedSource(input.title, input.episode, name)
        if (hit) {
          cacheHits++
          out.cacheHits++
          progressDone(binding.fetcher.id, name, FETCH_STEPS, FETCH_STEPS, `已命中本地缓存（${hit.comments.length} 条）`)
          return {
            sourceId: binding.fetcher.id,
            sourceName: name,
            comments: hit.comments,
            fromCache: true,
            detail: `本地缓存 ${hit.relPath}（未发网络请求）`,
            entryName: hit.item.title,
            kind: binding.fetcher.kind
          }
        }
        cacheMisses++
      }

      // 2) 缓存没有 → 真发请求
      progressStep(binding.fetcher.id, name, 1, FETCH_STEPS, `正在从${name}取弹幕…`)
      try {
        const keywords = await keywordsFor(binding, input)
        if (keywords.length === 0) throw new Error('没有可用的搜索关键词')
        const r = await fetchOne(binding, input, keywords)
        const ms = Date.now() - t0
        // 3) 成功即落盘：下次同一集直接命中
        progressStep(binding.fetcher.id, name, 4, FETCH_STEPS, `正在写入本地缓存（${r.comments.length} 条）…`)
        const saved = writeCachedSource({
          title: input.title,
          episode: input.episode,
          sourceId: binding.fetcher.id,
          sourceName: name,
          origin: r.detail,
          comments: r.comments
        })
        progressDone(
          binding.fetcher.id,
          name,
          FETCH_STEPS,
          FETCH_STEPS,
          saved ? `已取到 ${r.comments.length} 条并写入缓存` : `已取到 ${r.comments.length} 条（缓存写入失败）`
        )
        appendFetchRecord({
          at: Date.now(),
          trigger: input.trigger,
          title: input.title,
          episode: input.episode,
          sourceId: binding.fetcher.id,
          sourceName: name,
          keyword: r.keyword,
          ok: true,
          count: r.comments.length,
          ms,
          detail: r.detail
        })
        return {
          sourceId: binding.fetcher.id,
          sourceName: name,
          comments: r.comments,
          fromCache: false,
          detail: `${r.detail}${saved ? ` → ${saved.file.replace(/\\/g, '/')}` : ''}`,
          entryName: r.entryName,
          keyword: r.keyword,
          ms,
          kind: binding.fetcher.kind
        }
      } catch (err) {
        const msg = String((err as Error)?.message ?? err)
        out.errors.push(`${name}：${msg}`)
        progressFail(binding.fetcher.id, name, 1, FETCH_STEPS, `从${name}取弹幕失败`, msg)
        appendFetchRecord({
          at: Date.now(),
          trigger: input.trigger,
          title: input.title,
          episode: input.episode,
          sourceId: binding.fetcher.id,
          sourceName: name,
          ok: false,
          count: 0,
          ms: Date.now() - t0,
          detail: msg
        })
        log.append('warn', 'danmaku', `${name} 取弹幕失败：${msg}`)
        return null
      }
    })
  )

  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) out.batches.push(r.value)
    else if (r.status === 'rejected') out.errors.push(String((r.reason as Error)?.message ?? r.reason))
  }
  return out
}

/** 只查缓存（第一段用）：不联网，返回每个源已有的数据 + 还缺哪些源 */
export function readCachedBatches(
  title: string,
  episode: number,
  bindings = enabledFetchers()
): { batches: DanmakuBatch[]; missing: EnabledFetcher[] } {
  const batches: DanmakuBatch[] = []
  const missing: EnabledFetcher[] = []
  for (const binding of bindings) {
    const hit = readCachedSource(title, episode, binding.name)
    if (!hit) {
      missing.push(binding)
      continue
    }
    cacheHits++
    progressDone(binding.fetcher.id, binding.name, 1, 1, `本地缓存命中（${hit.comments.length} 条，未发网络请求）`)
    batches.push({
      sourceId: binding.fetcher.id,
      sourceName: binding.name,
      comments: hit.comments,
      fromCache: true,
      detail: `本地缓存 ${hit.relPath}（未发网络请求）`,
      entryName: hit.item.title,
      kind: binding.fetcher.kind
    })
  }
  return { batches, missing }
}

/** 给详情面板用：这批源各自的名字（开跑前就能显示"正在从…"） */
export function enabledSourceNames(): string[] {
  return enabledFetchers().map((b) => b.name)
}

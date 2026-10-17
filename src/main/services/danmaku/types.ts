import type { DanmakuComment, DanmakuFetcherId, DanmakuSource } from '@shared/types'

/**
 * 弹幕获取器（fetcher）的统一接口（V1.2 弹幕重构的第二层）。
 *
 * ## 用户给的架构
 * `弹幕源 → **弹幕数据获取器** → 缓存到本地 → 弹幕集成器 → 弹幕播放器`
 *
 * 不同源拿弹幕的方式完全不同：巴哈姆特是 JSON 接口（先搜番剧、再取集、最后取弹幕），
 * 弹幕盒子是"下整包 7z 再解出 XML"。如果让上层各写一遍流程，切换源时到处改；
 * 所以这里把两件事固定成接口：
 *   · `search(keyword)`  —— 这个关键词在该源能搜到哪些条目、每个条目有哪些集；
 *   · `fetchEpisode(entry)` —— 从条目里取某一集，返回统一结构的弹幕。
 * 上层（`danmakuSourceRunner`）只认这个接口，不知道也不需要知道源内部是 JSON 还是 7z。
 */

/** 一个源内的剧集引用（`id` 是源内标识：巴哈 videoSn / 盒子包内文件序号） */
export interface FetcherEpisodeRef {
  id: string
  /** 第几集（1 起） */
  index: number
  title: string
  /** 巴哈的 volume：0 本篇 / 1 剧场版 / 2 OVA / 3 中配；其它源为空 */
  volume?: string
  volumeName?: string
}

/** 搜索结果里的一个条目（含剧集表，避免再搜一次） */
export interface FetcherEntry {
  /** 源内唯一 id（巴哈 animeSn；弹幕盒子 repo/文件名） */
  id: string
  title: string
  /** 一句补充（年份/集数/包内文件数），界面与日志用 */
  extra?: string
  /** 实际搜出这个条目的关键词（巴哈只认日文/繁体，这一栏是证据） */
  keyword: string
  episodes: FetcherEpisodeRef[]
  /** 源内部对象（包实例/原始 JSON）；只在本进程内传递，不落盘 */
  raw?: unknown
}

/** 某一集的弹幕（统一结构；缓存层负责落盘） */
export interface FetcherEpisodeResult {
  comments: DanmakuComment[]
  /** 一句话说明：命中了哪个条目、第几集、包内文件等 */
  detail: string
  /** 源内条目名（写进「获取记录」，用户能核对是不是同一部） */
  entryName: string
  /** 实际生效的关键词 */
  keyword: string
  /** 这一集的标题（巴哈有；盒子没有就为空） */
  episodeTitle?: string
}

/** 上报进度的回调；步数由 fetcher 自己定，`total` 固定 4（第 4 步"写缓存"由 runner 报） */
export interface FetcherProgress {
  step: number
  total: number
  label: string
}

export interface FetcherContext {
  /** 番剧名（播放页显示的标题，也是缓存目录名） */
  title: string
  /** 第几集（1 起） */
  episode: number
  /** 番剧库别名（日文原名/繁体名），由渲染层或主进程反查得到 */
  aliases: string[]
  /** 用户手动输入的别名搜索词（播放器「输入别名搜索弹幕」）；有它时优先用它搜 */
  keyword?: string
  /** 番剧库条目 id（巴哈取日文原名用；没有就按标题反查一次） */
  subjectId?: number
  /** 这条源的配置（基址/固定关键词等）；没有就走适配器默认值 */
  source?: DanmakuSource
  /** 进度上报（可选；测试按钮也走同一套实现，但可以不显示进度） */
  onProgress?: (p: FetcherProgress) => void
}

export interface DanmakuFetcher {
  id: DanmakuFetcherId
  /** 界面显示名（也是缓存文件名里的来源名） */
  name: string
  kind: 'api' | 'site' | 'link'
  search(keyword: string, ctx: FetcherContext): Promise<FetcherEntry[]>
  fetchEpisode(entry: FetcherEntry, episode: number, ctx: FetcherContext): Promise<FetcherEpisodeResult>
}

/** 获取器固定的 4 步（搜索 → 取集 → 取弹幕 → 写缓存） */
export const FETCH_STEPS = 4

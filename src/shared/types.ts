// ============================================================
// Sakana 共享领域类型（主进程 / 渲染层共用）
// ============================================================

import type { Anime4kMode, Anime4kTier } from './anime4k'
import type { AudioSettings } from './audio'
// 「导入工具」的容错解析产物（v0.3.9）：ToolMeta 会把它们存下来供界面复查
import type { ToolImportNote, ToolRunMeta } from './toolImport'
// 内置规则三件套（AGE / sorani / aafun）：规则内容在 resources/rules/*.json，这里只做汇总
import { BUILTIN_RULES } from './builtinRules'

/**
 * Anime4K 超分辨率与画面微调（v0.3.1）。
 *
 * 分三块：① 着色器链（模式 + 显卡档位，或自定义）；② 画面微调（mpv 的
 * saturation/contrast/brightness/gamma，范围 -100~100，0 = 不动）；
 * ③ HDR（直通显示器 / 色调映射算法 / 目标峰值亮度）。
 */
export interface Anime4kSettings {
  /** 总开关；缺省 = 关 */
  enabled?: boolean
  /** 内置模式（A/B/C/A+A/B+B/C+A）或自定义；缺省 'A' */
  mode?: Anime4kMode
  /** 显卡档位；缺省 'fast'（官方 Low-end 模板，低端显卡也跑得动） */
  tier?: Anime4kTier
  /** 自定义模式的着色器文件名列表（顺序即执行顺序），仅 mode='custom' 时使用 */
  custom?: string[]
  /** 饱和度 -100~100（0 = 原始） */
  saturation?: number
  /** 对比度 -100~100（0 = 原始） */
  contrast?: number
  /** 亮度 -100~100（0 = 原始） */
  brightness?: number
  /** 伽马 -100~100（0 = 原始） */
  gamma?: number
  /** HDR 相关（`passthrough` = 把 HDR 原样交给显示器，需要显示器支持） */
  hdr?: {
    passthrough?: boolean
    /** `--tone-mapping` 的算法名，见 ANIME4K_TONE_MAPPINGS；缺省 'auto' */
    toneMapping?: string
    /** 目标峰值亮度（nits），0/未填 = auto */
    targetPeak?: number
  }
}

export interface Rating {
  score: number | null
  total: number
  rank?: number
}

export interface CoverImages {
  common: string
  large: string
  medium: string
  small: string
  grid: string
}

export interface WeekdayInfo {
  id: number // 1=周一 ... 7=周日
  cn: string
  en: string
  ja: string
}

export interface CalendarItem {
  id: number
  name: string
  name_cn: string
  images: CoverImages | null
  rating: Rating | null
  air_date: string | null
  genres: string[]
  rank?: number
}

export interface CalendarDay {
  weekday: WeekdayInfo
  items: CalendarItem[]
}

export interface SourceError {
  kind: 'ALL_DOWN' | 'TIMEOUT' | 'HTTP' | 'NETWORK' | 'PARSE'
  message: string
  tried: string[]
}

export interface CalendarResult {
  fromCache: boolean
  stale?: boolean
  fetchedAt: number | null
  days: CalendarDay[]
  error?: SourceError
  /**
   * v0.3.2：这份数据是不是**备用数据源（Jikan/AniList）兜底**来的。
   *
   * 语义：字段**缺失 = 主数据源（自建反代 / 镜像）**；`source === 'jikan'` = 本次走了兜底。
   * 兜底数据的覆盖面比主源小（AniList 的季度模型只给「当季在播」），
   * 所以界面必须能显示出来，否则用户会以为「番剧变少了」。
   */
  dataSource?: JikanFallbackMeta
}

/**
 * 备用数据源（Jikan / AniList）兜底元信息（v0.3.2）。
 *
 * `endpoints` 记录本次实际用到的端点链（AniList 的写成 `anilist:Page.media(...)`），
 * `reason` 是**兜底也失败**时的原因（主源与兜底各一段），方便用户与日志一眼看出问题在哪。
 */
export interface JikanFallbackMeta {
  source: 'bangumi' | 'jikan'
  endpoints?: string[]
  ms?: number
  reason?: string
}

/**
 * 季度（新番季）预览里的一个条目。
 *
 * 数据来自 `GET {反代}/v0/subjects?type=2&year=<y>&month=<m>&sort=rank&limit=100`
 * （一个季度 = 三个月份合并去重，见 main/services/bangumi.ts 的 season()）。
 * 与 CalendarItem 的差别：v0 的放送日期字段叫 `date`（不是 `air_date`），
 * 且季度条目多带 `platform`（TV / WEB / 剧场版…）。
 */
export interface SeasonItem {
  id: number
  name: string
  name_cn: string
  images: CoverImages | null
  rating: Rating | null
  air_date: string | null
  platform?: string
}

export interface SeasonResult {
  /** 实际命中的年份 */
  year: number
  /** 实际命中的季度序号：1=冬 2=春 3=夏 4=秋（约定见 shared/season.ts） */
  season: number
  fromCache: boolean
  /** 命中的是**已过期**的缓存（数据仍照常返回，界面照常渲染） */
  stale?: boolean
  fetchedAt: number | null
  items: SeasonItem[]
  error?: SourceError
  /** v0.3.2：季度列表是否来自备用数据源兜底（见 JikanFallbackMeta） */
  dataSource?: JikanFallbackMeta
}

/**
 * 「更新到第几集」（v0.3.7，用户要求番剧表详情页显示）。
 *
 * 数据来自 Bangumi 的**分集接口**（`/v0/episodes?subject_id=…&type=0`），每一集都带
 * `airdate`，所以「已更新到第几集」是**真的数出来的**，不是按「开播日 + 每周一集」猜的
 * （猜的算法遇到停播、连播、分割放送就会错）。
 */
export interface EpisodeProgress {
  /** 已放送集数（airdate <= 今天 的集数） */
  aired: number
  /** 本篇总集数（**已经登记**的集数；未播完的番可能只登记到当前集） */
  total: number
  /** 已放送的最后一集日期（YYYY-MM-DD），没有则 null */
  lastAirDate: string | null
  /** 下一集的放送日期（今天之后最近的一集），全部播完/未登记则 null */
  nextAirDate: string | null
  /** 是否已全部放送完（aired >= total 且 total > 0） */
  finished: boolean
}

export interface SubjectDetail {
  id: number
  name: string
  name_cn: string
  summary: string
  air_date: string | null
  images: CoverImages | null
  rating: Rating | null
  tags: { name: string; count?: number }[]
  infobox: { key: string; value: string }[]
  eps?: number
  volumes?: number
  /** v0 接口给的平台（TV / WEB / 剧场版…）与总集数，详情页会显示（v0.2.7） */
  platform?: string
  totalEpisodes?: number
}

export interface SubjectResult {
  fromCache: boolean
  data: SubjectDetail | null
  /** v0.2.7 附加：命中的是**已过期**的缓存（界面可照常渲染，后台正在静默刷新） */
  stale?: boolean
  error?: SourceError
  /** v0.3.2：详情是否来自备用数据源兜底（兜底时 `data.id` 是**负数 = -MAL id**） */
  dataSource?: JikanFallbackMeta
}

export interface SearchResultItem {
  id: number
  name: string
  name_cn: string
  images: CoverImages | null
  rating: Rating | null
  air_date: string | null
  summary: string
}

export interface SearchResult {
  items: SearchResultItem[]
  error?: SourceError
  /** v0.3.2：搜索结果是否来自备用数据源兜底（见 JikanFallbackMeta） */
  dataSource?: JikanFallbackMeta
}

/**
 * 角色条目（「最XX的角色 9宫格」工具用）。
 *
 * 两条路都能拿到，字段名不完全一样（见 main/services/bangumi.ts 的 characters()）：
 * - v0：`GET {base}/v0/subjects/{id}/characters` → `{id,name,relation,images}`
 * - 老接口：`GET {base}/subject/{id}?responseGroup=large` → `crt[]` 的 `{id,name,role_name,images}`
 */
export interface CharacterItem {
  id: number
  name: string
  /** 中文名：v0 的角色接口不返回该字段（老接口偶尔有），没有时为空串 */
  name_cn: string
  /** 与作品的关系：主角 / 配角 / 客串…（老接口的字段名是 role_name） */
  relation: string
  images: CoverImages | null
}

/** 角色列表结果：`source` 用来在界面上如实标出「数据来自哪条路」 */
export interface CharactersResult {
  subjectId: number
  items: CharacterItem[]
  /**
   * - `v0`：首选接口，字段最全；
   * - `legacy`：老接口兜底，**角色数可能比 v0 少**（实测它只给主要角色），界面要照实提示。
   */
  source: 'v0' | 'legacy'
  fromCache: boolean
  /** 命中的是**已过期**的缓存（数据照常可用，后台已在尝试刷新） */
  stale?: boolean
  error?: SourceError
}

/**
 * 远程图片 → data URL 的结果（九宫格导出把立绘画进 canvas 用）。
 *
 * **失败不抛异常**：单张立绘取不到时返回 `dataUrl: ''` + `error`，
 * 导出链路按「这一格用占位色块」降级，而不是让整张图导出失败。
 */
export interface ImageDataUrlResult {
  /** 成功时形如 `data:image/jpeg;base64,…`；失败为空串 */
  dataUrl: string
  mime: string
  bytes: number
  error?: string
}

export interface MirrorTestResult {
  url: string
  ok: boolean
  ms: number
  error?: string
}

// ---------------- 收藏 / 重点关心 ----------------

export interface FavoriteItem {
  subjectId: number
  name: string
  nameCn: string
  cover: string // 大图地址（原始 http(s) 地址，渲染层经图片协议加载）
  rating: number | null
  airDate: string | null
  genres: string[]
  eps?: number | null // 总集数（用于「已看完」自动判定）
  watchedAt?: number | null // 手动标记看完的时间戳；自动判定时亦可展示最后观看时间
  addedAt: number
}

// ---------------- 订阅 / 蜜柑计划 ----------------

export type SubStatus = 'complete' | 'updating' | 'waiting'

export interface Subscription {
  id: string
  subjectId: number
  name: string
  nameCn: string
  cover: string
  group: string | null // 选定的字幕组
  episode: number | null // 已下载到的最新集数
  status: SubStatus // complete=已下载所有资源 updating=资源更新中 waiting=有新资源待确认
  lastPubDate: string | null
  folder: string | null // 本地播放文件夹
  mikanKeyword: string
  createdAt: number
  /**
   * 蜜柑「按番剧 + 字幕组」官方订阅 RSS 的解析结果缓存（v0.3.3）。
   *
   * 为什么要有这三个字段：蜜柑的订阅地址是
   * `RSS/Bangumi?bangumiId=…&subgroupid=…`，`bangumiId` 要从搜索页 HTML 里解析、
   * `subgroupId` 要从番剧页 HTML 里解析 —— 一次解析要 2 个请求。缓存下来后
   * 后续每次检测都是 **0 个解析请求**（直接用缓存拼 feed 地址），否则「每次检测都重解析」
   * 既慢又平白多打蜜柑两下。
   *
   * 三个字段都可选：老订阅记录里没有，第一次检测时解析并回写。
   * `cachedGroupName` 是缓存**有效性的键** —— 用户在界面上换了字幕组时
   * （`group` 变了而 id 还是旧的），必须重新解析，否则会一直拉旧字幕组的 feed。
   */
  mikanBangumiId?: number
  mikanSubgroupId?: number
  cachedGroupName?: string | null
}

export interface MikanItem {
  guid: string
  title: string
  link: string
  torrentUrl: string | null
  magnet: string | null
  size: string
  pubDate: string
  group: string | null
  episode: number | null
  resolution: string | null
  isNew?: boolean
}

export interface MikanSearchResult {
  items: MikanItem[]
  error?: string
}

export interface SubUpdateCheck {
  subId: string
  newItems: MikanItem[]
  checkedAt: number
}

// ---------------- 下载任务 ----------------

export type DownloadStatus =
  | 'queued'
  | 'parsing'
  | 'torrent'
  | 'downloading'
  | 'paused'
  | 'seeding'
  | 'done'
  | 'error'

export interface DownloadTask {
  id: string
  subscriptionId?: string
  subjectId?: number
  animeTitle: string
  episode: number | null
  group: string | null
  name: string // 资源名称
  cover?: string
  magnet?: string
  torrentUrl?: string
  pubDate?: string // 资源发布日期（用于订阅更新判定）
  downloaderId?: string // aria2 gid 或 qBittorrent hash
  dir?: string // 实际保存目录（播放按钮使用）
  engine?: 'aria2' | 'qbit' // 双下载器模式下该任务使用的下载器
  status: DownloadStatus
  progress: number // 0-100
  speed?: string
  /** 已连接的对端数（BT 任务；用于区分"没有做种者"与"真在下载"） */
  peers?: number
  /** 已连接的做种者数 */
  seeders?: number
  eta?: string
  size?: string
  error?: string
  addedAt: number
  finishedAt?: number
}

export interface AddDownloadInput {
  subscriptionId?: string
  subjectId?: number
  animeTitle: string
  episode: number | null
  group: string | null
  name: string
  cover?: string
  magnet?: string
  torrentUrl?: string
  pubDate?: string // 资源发布日期（用于订阅更新判定）
}

// ---------------- 本地资源（下载目录自动推导 / 删除本地资源 / 删除下载记录） ----------------

/**
 * 定位某部番剧本地目录的入参（订阅卡片与下载卡片共用）。
 *
 * 三种来源按优先级：下载任务记录的 dir > 订阅记录的 folder > 按「下载根目录 + 番剧名」推导。
 * 有了它，「本地播放」不再需要弹文件夹选择框（用户明确要求：从卡片进入直接播）。
 */
export interface LocalTargetInput {
  subscriptionId?: string
  subjectId?: number
  animeTitle?: string
  /** 已知的下载目录（例如下载任务里记录的 dir），优先级最高 */
  dir?: string
}

/** 本地目录推导结果 */
export interface LocalDirInfo {
  /** 推导出的绝对路径（番剧文件夹） */
  dir: string
  exists: boolean
  /** 目录内可播放的视频文件数（0 = 还没下载完 / 已删干净） */
  videos: number
  /** 目录来源：task=下载任务记录 / folder=订阅记录 / derived=按下载根目录推导 */
  source: 'task' | 'folder' | 'derived'
}

/** 删除本地资源（文件 + 对应下载记录）的结果 */
export interface DeleteLocalResult {
  dir: string
  /** 真正删掉的视频文件数（目录不存在时为 0） */
  filesDeleted: number
  /** 一并清理掉的下载记录数 */
  recordsRemoved: number
  /** 被取消的进行中任务数（文件删了，任务不能再留着） */
  tasksCancelled: number
  /** 非致命错误（文件被占用 / 权限不足等），由界面 toast 呈现 */
  errors: string[]
}

/** 只删下载记录（不碰磁盘文件）的结果 */
export interface RemoveRecordsResult {
  removed: number
  /** 被取消的进行中任务数（只取消下载，不删已下载的部分文件） */
  tasksCancelled: number
}

// ---------------- 历史记录 ----------------

export interface WatchHistoryItem {
  id: string
  subjectId?: number
  title: string
  episode: number | null
  source: 'local' | 'online'
  watchedAt: number
  hour: number // 0-23，用于时间段分布统计
  durationSec: number
}

export interface SubHistoryItem {
  id: string
  kind: 'subscribe' | 'unsubscribe' | 'update' | 'download' | 'play'
  title: string
  detail: string
  at: number
}

// ---------------- 在线观看进度（v0.2.4：集数记录 + 断点续播） ----------------

/**
 * 单个番剧（按「来源 + 番剧条目」聚合）的观看进度。
 * id 是稳定键：在线用 `${ruleId}::${entryLink}`，本地用 `local::${filePath}`。
 */
export interface WatchProgressItem {
  id: string
  subjectId?: number
  title: string
  cover?: string
  source: 'online' | 'local'
  // ---- 在线播放需要的定位信息（本地播放只填 filePath） ----
  ruleId?: string
  ruleName?: string
  entryName?: string
  entryLink?: string
  groupIndex: number
  episodeIndex: number
  episodeName?: string
  /** 已观看集数键：`${groupIndex}:${episodeIndex}` */
  watched: string[]
  /** 本地播放的文件路径 */
  filePath?: string
  positionSec: number
  durationSec: number
  /**
   * 每集各自的断点（v0.2.6）。
   *
   * 只用 positionSec 会串集：第 1 集看到 20 分钟，自动连播到第 2 集时会把「整部番剧的断点」
   * 当成第 2 集的位置，一开播就跳到 20 分钟处。这里按集号分别记录，键同 watched（`线路:集`）。
   */
  positions?: Record<string, number>
  durations?: Record<string, number>
  updatedAt: number
}

// ---------------- 标记列表（想看但不想收藏） ----------------

export interface MarkList {
  id: string
  name: string
  createdAt: number
  /**
   * 创建该书签时搜索框里的关键词（v0.2.9）。
   * 搜索页书签弹窗的「重新搜索」据此重跑一次搜索；老数据没有这个字段（可选）。
   */
  keyword?: string
}

export interface MarkItem {
  id: string
  listId: string
  subjectId?: number
  title: string
  cover: string
  /** 番剧详情页路由参数（通常为 subjectId） */
  link: string
  addedAt: number
}

export interface SearchHistoryItem {
  kw: string
  at: number
}

// ---------------- 播放状态与流详情 ----------------

/** 播放器顶部状态栏展示的状态 */
export type PlayStatus = 'idle' | 'searching' | 'capturing' | 'loading' | 'playing' | 'failed' | 'ended'

// ---------------- 播放过程进度（v0.3.9） ----------------
//
// 用户原话：「播放器还没有显示时，在控制栏顶部的播放器状态里加一个过程进度显示器，
// 显示找播放资源、获取播放资源、将播放资源注入播放器这一过程，这样我就能判定播放卡在哪个步骤，
// 而且必需是实时更新的，详细显示问题所在」。
//
// 所以这里的状态**不是**给动画用的假进度，而是三个阶段各自的真实起止时间与结论：
// 每一段的 startedAt/endedAt 由真正做那件事的代码写下（规则解析 / 嗅探 / 内核注入），
// 没发生的阶段就一直是 pending —— 进度显示因此能如实反映「卡在哪一步」。

/** 三个阶段：找资源 → 取资源 → 注入播放器 */
export type PlayFlowStageKey = 'locate' | 'acquire' | 'inject'

export type PlayFlowStageStatus = 'pending' | 'running' | 'ok' | 'failed' | 'timeout'

/**
 * 失败归因（v0.3.9）。
 *
 * 存在的意义：用户明确要求「不许只说播放失败」，必须区分
 * 「网站问题/资源失效」与「资源获取速度过慢」—— 这两者的处置方式完全相反
 * （前者该换源，后者该继续等）。
 */
export type PlayFlowReason =
  /** 一点数据都拿不到：HTTP 报错 / DNS 解析失败 / TLS 失败 / 连接被拒 */
  | 'site'
  /** 能拿到数据但速率长期过低：**不算失败**，继续等并显示实时速率 */
  | 'slow'
  /** 拿到了但解不出：容器/编码不被支持 */
  | 'format'
  /** 等够了仍无结论（首字节超时） */
  | 'timeout'
  /** 我们自己的问题（内核未就绪、参数错误…） */
  | 'internal'
  | 'none'

export interface PlayFlowStep {
  /** 毫秒时间戳 */
  at: number
  text: string
}

export interface PlayFlowStage {
  key: PlayFlowStageKey
  label: string
  status: PlayFlowStageStatus
  startedAt: number | null
  endedAt: number | null
  /** 实时耗时：running 时由主进程按「现在 - startedAt」算，不是定时器凑出来的 */
  elapsedMs: number
  /** 当前正在做的事（实时刷新，例如「等待首字节… 已收 128 KB」） */
  detail: string
  /** 失败/超时的原因（人话，一行以内） */
  error?: string
  /** 该阶段的归因 */
  reason?: PlayFlowReason
  /** 该阶段的关键步骤流水（谁在什么时候做了什么） */
  steps: PlayFlowStep[]
}

/** 资源可达性采集到的网络指标（失败分析的证据） */
export interface PlayFlowMetrics {
  /** 累计收到的字节数（可达性探测采样，不是播放器解码量） */
  bytes: number
  /** 实时速率（字节/秒） */
  rateBps: number
  /** 首字节耗时（毫秒），还没到就是 null */
  ttfbMs: number | null
  /** HTTP 状态码 */
  status?: number
  contentType?: string
  /** 网络层错误类别：dns / tls / refused / timeout / http / network */
  errorKind?: string
  /** 最近一次错误原文（含 HTTP 状态、DNS/TLS 说明） */
  lastError?: string
  /** 响应头里挑出来的关键几行 */
  headers?: Record<string, string>
}

export interface PlayFlowSnapshot {
  /** 每开一轮新流程 +1：渲染层据此识别「换了一集/换了一条线」，而不是同一轮的抖动 */
  id: number
  mode: string
  title: string
  startedAt: number
  endedAt: number | null
  running: boolean
  stages: PlayFlowStage[]
  /** 当前正在进行（或失败）的阶段 key，界面高亮用 */
  activeStage: PlayFlowStageKey | null
  metrics: PlayFlowMetrics
  /** 一句话结论：正在做什么 / 卡在哪一步 / 为什么失败 */
  summary: string
  reason: PlayFlowReason
}

/**
 * 渲染层 → 主进程的「我进到哪一步了」标记（v0.3.9）。
 *
 * 为什么阶段切换要由渲染层发：三阶段的边界是**页面流程**决定的
 * （规则搜索 / 取集 / 解析播放页 → 建嗅探窗口 → 把直链交给内核），
 * 这套顺序只有播放页知道；而状态只能有一份，所以渲染层只发标记、主进程持有状态。
 * 底层服务（ruleProbe / ruleWebview / mpv）则直接往同一个状态里写细节，
 * 于是详情面板看到的是「页面视角 + 底层证据」合起来的一条时间线。
 */
export type PlayFlowMark =
  | { kind: 'begin'; mode: string; title: string }
  | { kind: 'stage'; stage: PlayFlowStageKey; detail?: string }
  | { kind: 'detail'; stage?: PlayFlowStageKey; text: string }
  | { kind: 'step'; stage?: PlayFlowStageKey; text: string }
  | { kind: 'ok'; stage: PlayFlowStageKey; detail?: string }
  | { kind: 'fail'; stage: PlayFlowStageKey; error: string; reason: PlayFlowReason }
  | { kind: 'done'; ok: boolean; summary?: string; reason?: PlayFlowReason }
  | { kind: 'metrics'; patch: PlayFlowMetrics }
  /** 清空当前流程：播放页在没有真实播放目标时被打开（托盘/小窗口/上个会话残留）用它，
   *  否则状态区会一直挂着「找播放资源 进行中」这种**假进度**（v0.3.9 自查） */
  | { kind: 'reset' }

/** 隐藏窗口嗅探（ruleProbe）的现场读数 */
export interface ProbeDiagnostics {
  active: boolean
  windowAlive: boolean
  windowDestroyed: boolean
  listenersRegistered: boolean
  timeoutPending: boolean
  foundCount: number
}

/** 网页视图嗅探（ruleWebview）的现场读数 */
export interface WebviewDiagnostics {
  active: boolean
  viewAlive: boolean
  viewDestroyed: boolean
  listenersRegistered: boolean
  doneTimerPending: boolean
  gen: number
}

/** 播放内核（libmpv）的现场读数 */
export interface EngineDiagnostics {
  nativeLoaded: boolean
  ready: boolean
  attached: boolean
  attachedDestroyed: boolean
  hasBounds: boolean
  surfaceVisible: boolean
  hasPicture: boolean
  timePumpRunning: boolean
}

export interface PlaySelfCheckFinding {
  id: string
  title: string
  /** ok=正常 / warn=发现异常 / fixed=发现并已修复 */
  level: 'ok' | 'warn' | 'fixed'
  detail: string
}

/** 在线播放自检结果（v0.3.9） */
export interface PlaySelfCheckResult {
  at: number
  reset: boolean
  findings: PlaySelfCheckFinding[]
  problems: number
  probeReset: boolean
  /** 内核侧发现错配：渲染层应重新 attach（重建播放器） */
  needsReattach: boolean
  engineDestroyed: boolean
  probe: ProbeDiagnostics
  webview: WebviewDiagnostics
  engine: EngineDiagnostics
}

/** 资源可达性取证的结论（v0.3.9） */
export interface StreamReachabilityReport {
  reason: PlayFlowReason
  /** 直接显示给用户的结论 */
  verdict: string
  metrics: PlayFlowMetrics
  container?: string
}

/** 在线播放加速档位（v0.3.9）：见 `@shared/streamBoost` 的实测依据与阈值 */
export type StreamBoostMode = 'auto' | 'off' | 'force'

/**
 * 加速器当前状态（设置页与自检读它，主进程是唯一写入方）。
 *
 * `active` 只有在本机中转**真的在给播放器供流**时才为 true ——
 * 界面上「是否正在加速」不允许靠档位猜（档位是 auto 时可能这次直连更快，那就是没在加速）。
 */
export interface StreamBoostStatus {
  /** 当前档位 */
  mode: StreamBoostMode
  /** 是否正在通过本机中转供流 */
  active: boolean
  /** 加速形态：hls=并发预读分片 / file=并发 Range 分段拉取 */
  kind: 'hls' | 'file' | 'none'
  /** 当前会话的源地址（截断） */
  origin: string
  /** 交给播放器的本机地址（截断） */
  local: string
  /** 并发连接数（0 = 未加速） */
  parallel: number
  /** 实时速率（字节/秒，1 秒窗口） */
  rateBps: number
  /** 最近 5 秒平均速率（字节/秒）—— 判「过慢」用这个，避免被瞬时抖动带偏 */
  avg5sBps: number
  /** 首字节耗时（毫秒），还没测到就是 null */
  ttfbMs: number | null
  /** 本次会话已转发给播放器的字节数 */
  bytes: number
  /** 本轮为什么这么决定（人话，一行） */
  reason: string
  /** 会话开始时间（毫秒时间戳） */
  startedAt: number | null
}

/**
 * 一条「优化记录」（v0.3.9 补充更新）。
 *
 * ## 只记真实量到的值
 *
 * 这里的每个数字都来自主进程**真实测量**：
 * · `direct*` 是决策阶段对源站实际发请求量出来的（`measureThroughput` / HLS 第 1 片）；
 * · `boostedRateBps` 是**真正转发给播放器**的字节数 ÷ 从开始处理到现在的墙钟
 *   （分母含决策 + 预热：预热进来的那几 MB 播放器是瞬间拿到的，若算成"白送"会把提升系统性高估）；
 * · `localTtfbMs` 是播放器从本机拿到首字节的实测耗时。
 * 任何一项没测到就是 `null`（界面上显示「—」）—— 不允许用估算值凑出一个好看的对比。
 *
 * `coldStartSavedMs` 只算「首字节」这一段的差（源站首字节 − 本机首字节）：
 * 它**不包含**决策 + 预热那几秒（那部分是真实成本，单独记在 `decisionMs` 里，
 * 界面上也一并显示，免得把「加速 = 起播一定更快」说成无条件成立）。
 */
export interface StreamBoostRecord {
  /** 会话 id：同一会话的多次落盘按它覆盖，避免同一次播放记成好几条 */
  id: string
  /** 开始加速的时间戳 */
  at: number
  /** 结束时间；还在播时是 null */
  endedAt: number | null
  /** 片源域名（HLS 取媒体列表所在的 CDN 域名，file 取直链域名）—— 优化记录要能看出「救的是哪个源」 */
  host: string
  /** 站点域名（Referer 的 host）：规则名没传进播放链路，用站点域名代替，如实标注 */
  site: string
  /** 加速形态 */
  kind: 'hls' | 'file'
  /** 生效的档位（auto/force） */
  mode: StreamBoostMode
  /** 并发路数 */
  parallel: number
  /** 决策时量到的直连速率（字节/秒） */
  directRateBps: number | null
  /** 加速速率（字节/秒）：转发给播放器的字节 ÷ **从开始处理到现在**的墙钟（含决策 + 预热） */
  boostedRateBps: number | null
  /** 源站首字节（毫秒） */
  directTtfbMs: number | null
  /** 播放器从本机拿到首字节（毫秒） */
  localTtfbMs: number | null
  /** 首字节节省（directTtfbMs - localTtfbMs），两项都缺就是 null */
  coldStartSavedMs: number | null
  /** 决策 + 预热花了多久（真实成本，毫秒） */
  decisionMs: number | null
  /** 本次会话转发给播放器的字节数 */
  bytes: number
  /** 中途退化为单连接直连的原因；没退化就是 null */
  degraded: string | null
  /** HLS 取片失败次数（>0 说明源站有抖动） */
  segFailed: number
}

/** 播放状态栏点开后的详细流信息（媒体地址 / 播放列表 / 分辨率 / 编码 / 码率） */
export interface StreamInfo {
  url: string
  kind: string
  referer?: string
  /** 嗅探来源：html 直出 / webRequest / CDP 响应体 / 网页播放器 */
  channel?: string
  /** m3u8 文本（截断到前 4000 字符） */
  playlist?: string
  width?: number
  height?: number
  videoCodec?: string
  audioCodec?: string
  fps?: number
  /** 视频码率（bps） */
  videoBitrate?: number
  audioBitrate?: number
  /** 总码率（bps） */
  bitrate?: number
  engine?: string
  capturedAt?: number
  /**
   * 播放过程进度快照（v0.3.9）。
   *
   * 挂在 `StreamInfo` 上是**故意的**：播放状态详情面板已经在按 1 秒轮询这个接口
   * （见 StreamInfoModal 的实时刷新），把过程进度并进同一个快照，
   * 就不需要再为它单开一条每帧轮询 —— 用户要的「实时更新」复用同一条链路。
   */
  flow?: PlayFlowSnapshot
  /**
   * 嗅探 / 内核的现场读数（v0.3.9 自检）。
   *
   * 放在同一个快照里同样是复用考虑：详情面板本来就是每秒拉一次，
   * 顺带就能显示「嗅探窗口还在不在、内核挂载有没有错配」——
   * 用户报的「换源后播放失败」要排查时，这一组布尔值是最直接的证据。
   */
  selfCheck?: {
    probeWindowAlive: boolean
    probeActive: boolean
    probeListeners: boolean
    webviewAlive: boolean
    webviewActive: boolean
    engineReady: boolean
    engineAttached: boolean
    engineAttachedDestroyed: boolean
    engineHasPicture: boolean
    engineVideoWidth: number
    timePumpRunning: boolean
  }
  message?: string
}

// ---------------- 更新检查（git 仓库） ----------------

export interface UpdateInfo {
  current: string
  latest: string
  hasUpdate: boolean
  notes?: string
  /** 仓库地址 / 下载页 */
  url: string
  checkedAt: number
  error?: string
  /**
   * v0.2.9 最后更新：GitHub Releases 里找到了可用的 Windows 安装包 → 支持应用内一键更新。
   * 只有版本号（旧 version.json 通道）时为 false，此时只能引导用户去 Releases 手动下载。
   */
  canInstall?: boolean
  /** 安装包文件名（用于显示与本地缓存去重） */
  assetName?: string
  /** 安装包字节数（下载进度与完整性校验用） */
  assetSize?: number
  /**
   * v0.2.10：GitHub Releases 里找到了**增量补丁**（`patch-<当前>-to-<新>.zip`）。
   * 有补丁时优先用它 —— 只下变化的文件（几 MB），用户不用为一次小更新重下 361MB 安装包。
   */
  patchName?: string
  /** 补丁字节数（界面显示「增量更新（x MB）」） */
  patchSize?: number
  /**
   * v0.2.12：是否为**重要更新**。
   * 判定来源：Release 说明里带 `【重要更新】` 标记（或 version.json 里 `important: true`）。
   * 重要的版本在应用启动后会**弹窗强提醒**（用户要求：「之后只要是十分重要的更新，
   * 都要在应用启动后弹窗强烈提醒用户更新」）。
   */
  important?: boolean
}

/**
 * 应用内一键更新的下载/安装状态（主进程 → 渲染层推送）。
 * `received/total` 用来画进度条；`file` 在下载完成后给出本地路径。
 * `mode` 区分这次下的是增量补丁还是完整安装包（决定安装方式与界面文案）。
 */
export type UpdateInstallState =
  | { phase: 'idle' }
  | { phase: 'downloading'; received: number; total: number; version: string }
  | { phase: 'done'; file: string; version: string; mode?: 'patch' | 'installer' }
  | { phase: 'installing'; file: string }
  /** reason='download' 是没下下来；'apply' 是包已经下好但没装上（补丁校验不过/脚本没起来/上次没跑完） */
  | { phase: 'failed'; message: string; reason?: 'download' | 'apply' }

// ---------------- 弹幕（预留：弹弹play） ----------------

export interface DanmakuComment {
  /** 出现时间（秒） */
  time: number
  text: string
  /** 16 进制颜色，如 #ffffff */
  color?: string
  /** 1=滚动 4=底部 5=顶部 */
  mode?: number
  size?: number
}

export interface DanmakuMatch {
  animeId: number
  episodeId: number
  animeTitle: string
  episodeTitle: string
}

/** v0.2.8：一次拿到的完整弹幕结果（播放器与本地播放共用） */
export interface DanmakuLoadResult extends DanmakuMatch {
  count: number
  comments: DanmakuComment[]
  /** 命中本地缓存（未再请求接口） */
  fromCache: boolean
  /** 这次是用哪个关键词匹配上的（别名检测命中时不是原始番剧名） */
  matchedBy?: string
  /** 是否用到了别名 */
  aliasUsed?: boolean
}

/** v0.2.8：弹幕显示设置（播放器悬浮窗 + 设置页共用；未设置项用默认值） */
export interface DanmakuSettings {
  /** 总开关 */
  enabled: boolean
  /** 覆盖区域：占画面高度的比例（0.25 / 0.5 / 0.75 / 1） */
  area: number
  /** 同屏最大条数 */
  maxCount: number
  /** 时间轴微调（毫秒，正数 = 弹幕提前出现） */
  offsetMs: number
  /** 字号（px） */
  fontSize: number
  /** 不透明度 0~1 */
  opacity: number
  /** 滚动弹幕穿过屏幕的秒数（越小越快） */
  speedSec: number
  /** 显示滚动弹幕 */
  showScroll: boolean
  /** 显示顶部弹幕 */
  showTop: boolean
  /** 显示底部弹幕 */
  showBottom: boolean
  /** 加粗描边（提升复杂画面下的可读性） */
  bold: boolean
  /**
   * 是否画描边（v0.3.8）。
   * 关掉之后是"纯色文字"（配阴影更清爽），适合深色画面；复杂画面上建议保持开启。
   */
  outline?: boolean
  /** 是否加文字阴影（v0.3.8）：浅色画面上比描边更自然 */
  shadow?: boolean
  /** 屏蔽词（逗号 / 换行分隔，命中即不显示） */
  blockWords: string
  /**
   * v0.2.9：弹幕渲染方式。
   * - `canvas`（默认）：应用自己的画布渲染（画在控制栏悬浮窗里，与视频窗口同层）；
   * - `uosc`：交给 mpv 内置的 uosc_danmaku 插件渲染（ASS 字幕层，字幕样式/搜索菜单由插件提供）。
   * 两种方式用的是**同一份**弹幕数据（应用侧统一做季集判定与多来源合并）。
   */
  renderer?: 'canvas' | 'uosc'
}

export const DEFAULT_DANMAKU_SETTINGS: DanmakuSettings = {
  enabled: true,
  area: 1,
  maxCount: 30,
  offsetMs: 0,
  fontSize: 22,
  opacity: 0.9,
  speedSec: 8,
  showScroll: true,
  showTop: true,
  showBottom: true,
  bold: true,
  outline: true,
  shadow: false,
  blockWords: ''
}

/** 把设置里的零散字段补成完整弹幕设置（兼容未设置/半设置的历史数据） */
export function resolveDanmakuSettings(raw: Partial<DanmakuSettings> | undefined): DanmakuSettings {
  const d = DEFAULT_DANMAKU_SETTINGS
  if (!raw) return { ...d }
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return {
    enabled: raw.enabled !== false,
    area: num(raw.area, d.area),
    maxCount: num(raw.maxCount, d.maxCount),
    offsetMs: num(raw.offsetMs, d.offsetMs),
    fontSize: num(raw.fontSize, d.fontSize),
    opacity: num(raw.opacity, d.opacity),
    speedSec: num(raw.speedSec, d.speedSec),
    showScroll: raw.showScroll !== false,
    showTop: raw.showTop !== false,
    showBottom: raw.showBottom !== false,
    bold: raw.bold !== false,
    outline: raw.outline !== false,
    shadow: raw.shadow === true,
    blockWords: typeof raw.blockWords === 'string' ? raw.blockWords : d.blockWords
  }
}


// ---------------- 工具 ----------------

export interface ToolMeta {
  id: string
  name: string
  description: string
  cover: string | null // 本地图片绝对路径，经图片协议加载
  scriptPath: string
  version: string | null
  importedAt: number
  /**
   * v0.3.9：以下字段都是"放宽导入"时解析出来的信息，全部可选（老数据没有，照常工作）。
   * 之所以要存下来：工具卡片/详情要显示"从哪来、什么语言、能不能跑"，
   * 而这些结论是读脚本内容得到的 —— 不存的话每次都要重新读盘解析。
   */
  /** 脚本种类（python / shell / javascript / other…），见 shared/toolImport.ts */
  kind?: string
  /** 该种类在界面上显示的名字（中英各一份，菜单语言不同也不怕） */
  kindLabel?: string
  kindLabelEn?: string
  /** 是否能在 Sakana 里直接运行（目前只有 Python 有运行时） */
  runnable?: boolean
  /** 脚本里声明的作者 */
  author?: string | null
  /** 脚本里声明的封面（相对路径或绝对路径，优先于同名图片） */
  coverHint?: string | null
  /** docstring 所在行号（1 起） */
  docstringLine?: number | null
  /** 版本号来自哪一行（1 起），用于在界面上说明"版本是从哪读到的" */
  versionLine?: number | null
  /** 导入时产生的提示（已入库，工具卡片上可复查） */
  notes?: ToolImportNote[]
  /** 解析出的脚本语言信息（binary / shebang 版本要求等） */
  run?: ToolRunMeta
}

/**
 * 单份文件的导入结果。
 *
 * 为什么 import 返回"一次多份"：用户要"能尽量吃进去"，就得允许一次拖/选多个文件，
 * 并且**每份单独结算**（某一份失败不该让其它份也不导入）。
 */
export interface ToolImportItem {
  /** 源文件绝对路径 */
  path: string
  /** 文件名（提示里用） */
  fileName: string
  status: 'imported' | 'updated' | 'failed' | 'canceled'
  /** 成功入库的元数据（failed/canceled 时为 null） */
  tool: ToolMeta | null
  /** 失败原因（failed 时必有） */
  error?: string
  /** 解析提示：成功也带（"成功导入 N 条，其中 M 条带警告"就靠它统计） */
  notes: ToolImportNote[]
  /** 有多少条 warn 级提示 */
  warnCount: number
  /** 这次是新增还是覆盖了同路径的旧记录 */
  replaced: boolean
}

export interface ToolImportReport {
  items: ToolImportItem[]
  /** 成功（含覆盖）的份数 */
  imported: number
  /** 失败的份数 */
  failed: number
  /** 用户取消对话框 */
  canceled: boolean
}

export interface ToolRunResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  error?: string
}

// ---------------- 播放规则（Kazumi 风格：XPath / API 双类型） ----------------

export interface RuleSearchDef {
  type: 'xpath' | 'api'
  method: 'GET' | 'POST'
  url: string // @keyword 占位
  headers: string // JSON 文本
  query: string // JSON 文本（GET 附加到 URL，POST 作为请求体/参数）
  bodyType: string // '' | 'form' | 'json'
  listXPath: string
  itemNameXPath: string
  itemLinkXPath: string
  listJsonPath: string
  itemNameJsonPath: string
  itemSourceJsonPath: string
  /**
   * 可选（v0.3.9）：api 型搜索时，用条目的 `source` 字段拼**详情页地址**的模板，`@source` 占位。
   *
   * 为什么需要它：MacCMS 系站点的搜索补全接口（如 aafun 用的 `/index.php/ajax/suggest`）
   * 只返回条目的 id，而选集要靠详情页 HTML（XPath）—— 过去 api 型搜索的条目 link 恒为空，
   * 选集就只能拿 id 去拼 URL，拼出来的地址是错的（`https://站点/3291`）。
   * 有了这个模板，规则可以直接写 `https://站点/anime/@source.html`，
   * 搜索→选集整条链就通了，也不必为此再写一个专用规则类型。
   */
  itemLinkTemplate?: string
}

export interface RuleEpisodesDef {
  type: 'xpath' | 'api'
  method: 'GET' | 'POST'
  url: string // @source 占位
  headers: string
  query: string
  bodyType: string
  responseFormat: string
  linesXPath: string
  episodesXPath: string
  /**
   * 可选：线路名 XPath（相对线路节点求值；以 @ 开头则读属性，如 '@alt'）。
   * 有些站点（MacCMS + sakura 模板）的线路名标签与剧集盒子是兄弟节点，
   * 靠 XPath 1.0 无法在"以线路节点为上下文"时做位置配对，
   * 此时把 linesXPath 指向线路名标签（如 #NumTab/a），
   * 并在 episodesXPath 里用 {n} 占位第 n 条线路的剧集容器。
   */
  lineNameXPath?: string
  linesJsonPath: string
  lineNameJsonPath: string
  episodesJsonPath: string
  episodeNameJsonPath: string
  /** api 模式：每集自带的自定义字段（如 sorani 的 episodeOrder），用于 playUrlTemplate 的 @episodeUrl */
  episodeUrlPath?: string
  vars: Record<string, string> // 响应变量：变量名 → JSONPath
  playUrlTemplate: string // @slug 等变量占位
  playQuery: Record<string, string> // @roadIndex / @episodeIndex 占位
}

/**
 * 规则来源（v0.3.9，用户要求「界面要如实显示当前用的是 git 版还是本地版」）。
 * - builtin：随应用分发的内置规则（resources/rules）
 * - repo：从 git 规则仓库（KazumiRules）导入/更新来的
 * - local：当前内容来自**本地库**（用户改过的版本，或从本地库替换回来的）
 *
 * 这是"这条规则现在是谁的版本"的**事实记录**，不是推断：写入方在导入/替换时就落下来，
 * 界面直接显示它，避免靠 id 前缀猜（用户完全可以改掉 id）。
 */
export type RuleOrigin = 'builtin' | 'repo' | 'local'

export interface PlayRule {
  id: string
  name: string
  version: string
  baseUrl: string
  search: RuleSearchDef
  episodes: RuleEpisodesDef
  enabled: boolean
  createdAt: number
  /**
   * 可选：来源标记。老数据没有这个字段，界面按 id 前缀兜底显示
   * （default- → 内置、repo- → 仓库），所以这里是可选的、不需要数据迁移。
   */
  origin?: RuleOrigin
}

export function emptyRule(): PlayRule {
  return {
    id: '',
    name: '',
    version: '1.0',
    baseUrl: '',
    search: {
      type: 'xpath',
      method: 'GET',
      url: '',
      headers: '{}',
      query: '{}',
      bodyType: '',
      listXPath: '',
      itemNameXPath: '',
      itemLinkXPath: '',
      listJsonPath: '',
      itemNameJsonPath: '',
      itemSourceJsonPath: ''
    },
    episodes: {
      type: 'xpath',
      method: 'GET',
      url: '',
      headers: '{}',
      query: '{}',
      bodyType: '',
      responseFormat: '',
      linesXPath: '',
      episodesXPath: '',
      linesJsonPath: '',
      lineNameJsonPath: '',
      episodesJsonPath: '',
      episodeNameJsonPath: '',
      vars: {},
      playUrlTemplate: '',
      playQuery: {}
    },
    enabled: true,
    createdAt: Date.now()
  }
}

/**
 * 内置规则总表 = 「用户点名必须内置」的三条 + 其余三条。
 *
 * 为什么 AGE / sorani / aafun 不写在这里，而是放到 `resources/rules/*.json`：
 *  这三条是要**随应用分发**的（用户原话：「AGE、sorani、aafun 是默认规则，这三个规则一定要内置到应用中」），
 *  规则本体是一堆 XPath/JSONPath **数据**，放在 resources/rules 下谁都能一眼看到应用到底带了哪几条、内容是什么；
 *  而且以后要加内置规则只需丢一个 json 进去，不必动这个两千行的类型文件。
 *  它们由 builtinRules.ts 打包进应用（app.asar，开发态与安装态同一份内容），不依赖首次启动去 git 拉取。
 *
 * 剩下的三条（TvTFun / 樱之空 / 7sefun）暂时仍写在这里：它们不在用户点名范围内，
 * 一并搬走会让这次改动的面变大，收益却只是"文件更整齐"。
 */
export const DEFAULT_RULES: PlayRule[] = [
  // 内置三条：AGE / sorani / aafun（顺序 = 列表展示顺序，且都在 PINNED_RULES 置顶名单里）
  ...BUILTIN_RULES,
  {
    id: 'default-tvtfun',
    name: 'TvTFun',
    version: '1.1',
    baseUrl: 'https://www.tvtfun.net/',
    search: {
      type: 'api',
      method: 'GET',
      url: 'https://www.tvtfun.net/api/videos/search',
      headers: '{}',
      query: '{\n  "q": "@keyword",\n  "pageSize": 5\n}',
      bodyType: '',
      listXPath: '',
      itemNameXPath: '',
      itemLinkXPath: '',
      listJsonPath: '$.data.videos[*]',
      itemNameJsonPath: '$.name',
      itemSourceJsonPath: '$.id'
    },
    episodes: {
      type: 'api',
      method: 'GET',
      url: 'https://www.tvtfun.net/api/videos/@source',
      headers: '{}',
      query: '{}',
      bodyType: '',
      responseFormat: '嵌套JSON',
      linesXPath: '',
      episodesXPath: '',
      linesJsonPath: '$.data.playSources[*]',
      lineNameJsonPath: '$.name',
      episodesJsonPath: '$.episodes[*]',
      episodeNameJsonPath: '$.name',
      vars: { slug: '$.data.slug' },
      playUrlTemplate: 'https://www.tvtfun.net/video/@slug/play',
      playQuery: { source: '@roadIndex', episode: '@episodeIndex' }
    },
    enabled: true,
    createdAt: 0
  },
  {
    id: 'default-skrsks',
    name: '樱之空',
    version: '1.0',
    baseUrl: 'https://skr.skrcc.cc:666/',
    search: {
      type: 'xpath',
      method: 'GET',
      url: 'https://skr.skrcc.cc:666/vodsearch/@keyword-------------/',
      headers: '{}',
      query: '{}',
      bodyType: '',
      listXPath: '//li[contains(@class,"searchlist_item")]',
      // 用 /text() 剥掉标题里内嵌的 <span class="info_right">日漫</span>
      itemNameXPath: '//h4[contains(@class,"vodlist_title")]/a/text()',
      itemLinkXPath: '//h4[contains(@class,"vodlist_title")]/a',
      listJsonPath: '',
      itemNameJsonPath: '',
      itemSourceJsonPath: ''
    },
    episodes: {
      type: 'xpath',
      method: 'GET',
      url: '',
      headers: '{}',
      query: '{}',
      bodyType: '',
      responseFormat: '',
      // 线路名取 #NumTab 的标签（线一/线二…），剧集容器与其是兄弟节点，
      // 因此用 {n} 占位做位置配对（见 RuleEpisodesDef.lineNameXPath 注释）
      linesXPath: '//div[@id="NumTab"]/a',
      lineNameXPath: '@alt',
      episodesXPath: '(//div[contains(@class,"play_list_box")])[{n}]//div[@id="playlistbox"]/ul/li/a',
      linesJsonPath: '',
      lineNameJsonPath: '',
      episodesJsonPath: '',
      episodeNameJsonPath: '',
      vars: {},
      playUrlTemplate: '',
      playQuery: {}
    },
    enabled: true,
    createdAt: 0
  },
  {
    id: 'default-7sefun',
    name: '7sefun',
    version: '1.3',
    baseUrl: 'https://www.7sefun.top/',
    search: {
      type: 'xpath',
      method: 'GET',
      url: 'https://www.7sefun.top/vodsearch/-------------.html?wd=@keyword',
      headers: '{}',
      query: '{}',
      bodyType: '',
      listXPath: '//div[contains(@class,"videos")]/div',
      // 结果卡片的 <a class="video-wrapper"> 内只有 <img>，文字为空；
      // 标题在 <div class="video-by"> 里，缺了它列表会显示成空白条目
      itemNameXPath: '//div[contains(@class,"video-by")]/text()',
      itemLinkXPath: '//a[contains(@class,"video-wrapper")]',
      listJsonPath: '',
      itemNameJsonPath: '',
      itemSourceJsonPath: ''
    },
    episodes: {
      type: 'xpath',
      method: 'GET',
      url: '',
      headers: '{}',
      query: '{}',
      bodyType: '',
      responseFormat: '',
      linesXPath: '//div[contains(@class,"chat-stream")]',
      // 线路标签 div.chat-stream 与剧集容器 div.vod-play-list-container 是兄弟节点，
      // 相对路径取不到 → 用 {n} 位置配对（同樱之空）
      episodesXPath: '(//div[contains(@class,"vod-play-list-container")])[{n}]//a',
      linesJsonPath: '',
      lineNameJsonPath: '',
      episodesJsonPath: '',
      episodeNameJsonPath: '',
      vars: {},
      playUrlTemplate: '',
      playQuery: {}
    },
    enabled: true,
    createdAt: 0
  }
]

export interface RuleSearchEntry {
  name: string
  link: string
  source: string
}

export interface RuleEpisode {
  name: string
  link: string
}

export interface RuleEpisodeGroup {
  lineName: string | null
  episodes: RuleEpisode[]
}

export interface RuleSearchResult {
  items: RuleSearchEntry[]
  error?: string
}

export interface RuleEpisodesResult {
  groups: RuleEpisodeGroup[]
  vars: Record<string, string>
  error?: string
}

export interface RulePlayResult {
  url: string
  /** 该规则站点根地址：可作为播放页/媒体请求的 Referer（v0.2.7 附加，预取与播放共用） */
  referer?: string
}

// ---------------- 日志 / 设置 ----------------

export interface LogEntry {
  id: string
  level: 'info' | 'warn' | 'error'
  source: string
  message: string
  at: number
}

export interface ProxyConfig {
  enabled: boolean
  type: 'http' | 'socks5'
  host: string
  port: number
  username: string
  password: string
}

export interface Aria2Config {
  host: string
  port: number
  secret: string
  binaryPath: string // 留空则使用内置 aria2c
  autoStart: boolean
  maxConcurrent: number // 同时下载任务数上限
}

export interface QbitConfig {
  url: string
  username: string
  password: string
  /**
   * qBittorrent 程序路径（.exe）。
   *
   * 外部 qb 不归应用管，但没在跑的时候任务一个也下不动，所以允许应用拉起它来自动化下载。
   * 便携版请填 `qBittorrentPortable.exe`（PortableApps 启动器会自己拉起真正的 qbittorrent.exe）。
   */
  exePath?: string
  /**
   * 用户已授权应用启动 qBittorrent（在授权弹窗里点过「启动」就记住，之后不再每次询问）。
   * 旧设置文件没有该字段时按「未授权」处理：第一次需要启动时会问一次。
   */
  launchAuthorized?: boolean
  /** 每次下载前都询问是否启动 qBittorrent（授权框里的勾选，或设置页的开关） */
  askBeforeLaunch?: boolean
}

/**
 * 外部 qBittorrent 的实时状态（设置页据此如实显示「为什么连不上」，不留假按钮）。
 *
 * qb 的 WebUI 端口/密码/免密白名单都在 qb 自己的设置里，应用只能探测、不能代为修改，
 * 所以这里把「探测到什么」全部摊开给界面。
 */
export interface QbitStatus {
  /** WebUI 是否答话 */
  reachable: boolean
  /** 当前设置里的地址 */
  url: string
  version?: string
  webapiVersion?: string
  /** 程序路径（设置里填的，或自动探测到的常见安装位置） */
  exePath: string
  exeExists: boolean
  exeSource: 'setting' | 'auto' | 'none'
  /** 用户是否已授权应用启动 qb */
  launchAuthorized: boolean
  /** 是否每次下载都询问 */
  askBeforeLaunch: boolean
  /** 设置里的地址连不上时，探测到的其它可用端口（界面可一键采用） */
  detectedPorts: number[]
  /** 连不上时的中文原因，可直接显示 */
  error?: string
}

export interface DataSourcesConfig {
  main: string // 主数据源（请求日历/条目的地址）
  mirrors: string[] // 镜像站列表（含主数据源，主数据源排首位）
}

/** 画面比例模式：fit=适应（保持比例，可能留黑边）/ cover=裁剪铺满 / stretch=拉伸铺满 */
export type AspectMode = 'fit' | 'cover' | 'stretch'

/**
 * 番剧表「显示范围」筛选（v0.2.9 附加）：三个开关相互独立、同时生效，默认全关 = 全部显示。
 * 只影响界面显示，不改动数据。
 */
export interface ScheduleDisplayFilters {
  hideWatched: boolean // 隐藏已看完的番剧
  hideDropped: boolean // 隐藏已抛弃的番剧
  onlyWatching: boolean // 只看在看的番剧
}

export interface AppSettings {
  theme: string
  bangumiBase: string
  bangumiMirrors: string[]
  dataSources: DataSourcesConfig
  proxy: ProxyConfig
  screenshotDir: string
  downloadDir: string
  ffmpegPath: string // 留空自动使用内置 resources/ffmpeg
  aspectMode: AspectMode // 画面比例：fit=保持比例（可留黑边）/ cover=裁剪铺满 / stretch=拉伸铺满
  cacheDir: string // 自定义缓存目录，留空使用 userData/cache
  downloader: {
    type: 'aria2' | 'qbit'
    dual: boolean // 同时启用两个下载器，任务自动分配以加速下载
    aria2: Aria2Config
    qbit: QbitConfig
  }
  language: 'zh' | 'en'
  autoCheckUpdate: boolean
  galgameDetect: boolean // 游戏信息检测（读取游戏窗口标题，用于记录游玩进度）
  /** 内存识别 BGM / 章节（只读：仅读取游戏内存中的音频文件名与章节名，不修改游戏任何数据） */
  galgameMemRead: boolean
  /**
   * 在线播放 HLS 时剔除贴片广告分片（默认开启）。
   * 判据保守：只删「被 #EXT-X-DISCONTINUITY 夹住的 4~60s 短区段」，
   * 判据不足时完全不改并让播放器回源原始播放列表。
   * 可选字段：旧设置文件缺省该键时按「开启」处理（见 adFilter.adFilterEnabled）。
   */
  hlsAdFilter?: boolean
  /** 在线播放加速档位（v0.3.9）：auto=先直连测到慢再加速（默认）/ off=完全直连 / force=强制加速 */
  streamBoost?: StreamBoostMode
  /**
   * 自建反代（Cloudflare Worker，见 deploy/bangumi-proxy-README.md）。
   *
   * bangumi.pro / bangumi.lol 已被墙、api.bgm.tv 直连也不稳，公共镜像随时可能全灭，
   * 因此允许用户填自己的反代域名：
   * - `bangumiCustomApi`：API 反代地址（Worker 的 API_HOST），会作为**最高优先级**镜像，
   *   并强制按 v0 API 路径（`/v0/...`）请求，不再依赖域名里是否含 `api.`；
   * - `bangumiCustomImg`：图片反代地址（Worker 的 IMG_HOST），
   *   命中 `lain.bgm.tv` 等官方图床时按原路径改写过去。
   * 两者留空则维持原有的公共镜像链。
   */
  bangumiCustomApi?: string
  bangumiCustomImg?: string
  /**
   * 弹幕显示设置（v0.2.8）。
   *
   * 播放器悬浮窗里的「弹幕设置」与设置页里的「弹幕设置」改的是同一份数据；
   * 缺省字段由 `resolveDanmakuSettings()` 补默认值，所以历史用户升级后直接可用。
   */
  danmaku?: Partial<DanmakuSettings>
  /**
   * 启动公告（v0.2.8 附加）。
   * - `announcementSeenVersion`：用户上次看完公告时的版本号；
   * - `announcementMuted`：用户勾了「不再提示」。
   * 两者同时成立才不再弹；版本变化后无视勾选再弹一次。
   */
  announcementSeenVersion?: string
  announcementMuted?: boolean
  /**
   * 关闭窗口时记住的选择（v0.2.8 附加）：`'tray'` = 最小化到托盘，`'quit'` = 直接退出。
   * 为空时每次关闭都会询问；设置了这个值就不再询问。
   */
  closeBehaviorRemembered?: 'tray' | 'quit'
  /**
   * B 站弹幕（mpv 脚本）配置（v0.2.8 附加七）。
   *
   * 管线：yt-dlp 抓 danmaku 字幕（xml）→ biliass 转 ASS → mpv `sub-add`。
   * 这两个可执行文件需要用户自行下载（本机网络到 GitHub Release 不通，无法随包分发），
   * 内置脚本 `resources/mpv-scripts/sakana-bdanmaku.lua` 负责串起这条管线；
   * 也可以把自己的 bdanmaku.lua 路径填进来（那时优先用它）。
   */
  biliDanmaku?: {
    enabled?: boolean
    /** yt-dlp 可执行文件路径（留空按 PATH 里的 yt-dlp） */
    ytdlpPath?: string
    /** biliass 可执行文件路径（留空按 PATH 里的 biliass） */
    biliassPath?: string
    /** 自定义 mpv 脚本（留空用内置的 sakana-bdanmaku.lua） */
    scriptPath?: string
    /** 临时目录：biliass 在 Windows 上必须有一个可写 tmpdir，否则弹幕下载会失败 */
    tmpdir?: string
  }
  /**
   * 番剧表「显示范围」筛选（v0.2.9 附加）：属偏好设置，随设置一起持久化。
   * 可选字段：旧设置文件缺省该键时按「全关（全部显示）」处理，
   * 渲染层由 `resolveScheduleFilters()` 补默认值。
   */
  scheduleFilters?: Partial<ScheduleDisplayFilters>
  /**
   * 播放器控制栏是否交给 uosc（v0.2.18 引入；**v0.3.3 起默认关闭**）。
   *
   * - 缺省 / false：用**应用自己的悬浮窗控制栏**（v0.3.3 起这是默认）——
   *   进度条、播放控制、选集、字幕、倍速、画面比例、弹幕、画质（Anime4K 超分）、全屏与退出
   *   都在里面，按钮/菜单是应用自己的界面（见 renderer 的 PlayerOverlayPage）；
   * - true：改由 mpv 的 uosc 画控制栏（布局在 resources/mpv-config/script-opts/uosc.conf，
   *   快捷键在 resources/mpv-config/input.conf，按钮/菜单由 resources/mpv-scripts/sakana-uosc-ctrl.lua 驱动）。
   *
   * ⚠️ 主进程与渲染层两处判定必须一致（mpv.ts 的 `uoscControlBarRequested()` 与
   * PlayerPage 的 `uoscBarMode`），否则会出现「uosc 不画 + 自建控制栏也不画」= 完全没有控制栏。
   * 内置 uosc 缺失（安装目录不完整）时也会自动回落，不需要用户去改这个开关。
   */
  uoscControlBar?: boolean
  /**
   * 投屏策略（v0.3.8，用户要求「投屏相关设置记得添加到设置中」）。
   *
   * 影响"怎么把这一路流交给电视/接收端"，直接决定流畅度：
   *   · `auto`（默认）：需要鉴权的片源走本机中转，不需要鉴权的直连；Sakana 接收端一律直连（它自己能带会话）；
   *   · `direct`：一律直连（最流畅，但需要 Referer 的站点可能放不出来）；
   *   · `relay`：一律经本机中转（**不重编码**，只转发字节；适合电视取不到流的情况）；
   *   · `transcode`：交给 FFmpeg 转码后中转（电视解不了 HEVC 时才用，会明显增加延迟与画质损失）。
   */
  castStrategy?: 'auto' | 'direct' | 'relay' | 'transcode'
  /*
   * v0.3.9：这里原来的 `searchCarouselSec`（搜索页空态「自定义轮播展示位」的切换间隔）
   * 已随那块展示位一起删除 —— 它的唯一读者是渲染层那个被删掉的轮播组件与 SearchPage，
   * 设置页里从来也没有它的入口（滑块画在组件自己身上）。留一个没人读的设置键就是死代码。
   *
   * 老设置文件里残留的 `searchCarouselSec` 不会报错也不会被读取：
   * 设置是「整体存整体取」，多出来的键只是被忽略（详见 stores/app.ts 的 load 合并逻辑）。
   */
  /**
   * Anime4K 超分辨率与画面微调（v0.3.1）。
   *
   * 着色器是随包内置的 39 个 `.glsl`（`resources/shaders`，由 extraResources 复制到
   * 安装目录 `resources/shaders`，不进 asar），模式 → 着色器链的对照表在
   * `@shared/anime4k`，链本身照抄 Anime4K v4.0.1 官方 mpv 模板。
   *
   * 主进程在 libmpv 初始化之后用运行时的
   * `change-list glsl-shaders clr "" / append <path>` 挂载，所以改设置**当场生效**，
   * 不需要重进播放器（见 mpv.ts 的 mpvApplyVideoEnhance）。
   * 老设置文件里没有这个键时按「关闭」处理。
   */
  anime4k?: Anime4kSettings
  /**
   * 音频（音质调控）设置（v0.3.6）。
   *
   * 结构定义在 `@shared/audio`（`AudioSettings`）—— 那边同时负责收窄（脏数据夹到合法区间）
   * 与「拼成 mpv 的 af 滤镜链」，渲染层设置页与主进程共用同一份，
   * 所以界面上显示的值与真正下发给内核的一定一致。
   */
  audio?: AudioSettings
  /**
   * 截图后自动复制到系统剪贴板（v0.3.6「快速粘贴」）。
   * 默认开启（`!== false`）；关掉后截图仍会存盘，只是不动剪贴板
   * —— 因为写剪贴板会顶掉用户原先复制的内容，必须给一个能关的开关。
   */
  screenshotClipboard?: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'sakura',
  /*
   * v0.2.7：默认改用自建反代（用户已部署 Cloudflare Worker）。
   * 与官方 v0 的两处差异见 bangumi.ts 的注释：
   * - 每日放送在 `/calendar`（不是 `/v0/calendar`），直接返回本应用需要的 7 天 JSON；
   * - 搜索是 `POST /v0/search/subjects`（不是 GET）。
   * 图片由反代自己改写成 `/img/...`，图片反代字段主要用于兜底。
   */
  bangumiBase: 'https://sankana-bangumi.de5.net/api',
  bangumiMirrors: [
    'https://sankana-bangumi.de5.net/api',
    'https://bangumi.vip',
    'https://bangumi.lol'
  ],
  dataSources: {
    main: 'https://sankana-bangumi.de5.net/api',
    mirrors: [
      'https://sankana-bangumi.de5.net/api',
      'https://bangumi.vip',
      'https://bangumi.lol'
    ]
  },
  proxy: { enabled: false, type: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
  screenshotDir: '',
  downloadDir: '',
  ffmpegPath: '',
  aspectMode: 'fit',
  cacheDir: '',
  downloader: {
    type: 'aria2',
    dual: false,
    aria2: { host: '127.0.0.1', port: 6800, secret: '', binaryPath: '', autoStart: true, maxConcurrent: 5 },
    qbit: {
      url: 'http://127.0.0.1:8080',
      username: '',
      password: '',
      exePath: '',
      // 默认不授权 + 不每次询问：第一次需要启动时问一次，点过「启动」就记住
      launchAuthorized: false,
      askBeforeLaunch: false
    }
  },
  language: 'zh',
  autoCheckUpdate: false,
  /*
   * galgame 的两个检测开关（v0.3.9 用户要求：默认开启）。
   *
   * 「未设置过=开，显式关=关」：`getSettings()` 是 `{...DEFAULT_SETTINGS, ...磁盘设置}`，
   * 老用户的设置文件里没有这两个键时就会取到这里的 true；用户显式关过（磁盘上是 false）
   * 时磁盘值覆盖默认值，仍然保持关闭 —— 不会把用户关掉的开关又偷偷打开。
   */
  galgameDetect: true,
  galgameMemRead: true,
  hlsAdFilter: true,
  /** 在线播放加速：默认「自动」，与 `@shared/streamBoost` 的 BOOST_FAST_BPS 判定配套 */
  streamBoost: 'auto',
  // 自建反代（默认启用，可在「设置 → 数据源配置」改回公共镜像）
  bangumiCustomApi: 'https://sankana-bangumi.de5.net/api',
  bangumiCustomImg: 'https://sankana-bangumi.de5.net/img',
  // 番剧表「显示范围」筛选默认全关 = 全部显示
  scheduleFilters: { hideWatched: false, hideDropped: false, onlyWatching: false }
}

// ---------------- 工具数据导出 ----------------

export interface SakanaDataExport {
  exportedAt: number
  favorites: FavoriteItem[]
  subscriptions: Subscription[]
  watchHistory: WatchHistoryItem[]
  stats: {
    favoriteCount: number
    subscriptionCount: number
    watchedEpisodeCount: number
    watchedHourCount: number
  }
}

// ---------------- 播放列表 ----------------

export interface LocalSubFile {
  path: string
  name: string
  label: string // 简体 / 繁体 / 日文 / 字幕
  type: 'srt' | 'ass' | 'ssa' | 'vtt'
}

export interface LocalVideoFile {
  path: string
  name: string
  episode: number | null
  size: number
  subs: LocalSubFile[]
}

// ---------------- 转码播放 ----------------

export interface MediaInspectResult {
  videoCodec: string | null
  audioCodec: string | null
  width: number | null
  height: number | null
  durationSec: number
  compatible: boolean // Chromium 可直接播放
  reason: string
  hasFfmpeg: boolean
}

export interface LiveStartResult {
  sessionId: string
  url: string
  mode: 'vcopy' | 'vtranscode'
}

// ---------------- 内置统计工具 v0.2（条目详情大改） ----------------

/**
 * 统计条目（v0.2）。
 *
 * 字段分三类，改动时别混：
 * 1. **自动带出**（添加时从收藏/番剧表写入，详情窗口只读）：name/nameCn/cover/airDate/genres/bgmRating。
 *    其中 `bgmRating` 允许在条目上手工校正（旧数据没有该值时用户仍可填），但详情窗口不给输入框。
 * 2. **用户录入**（详情窗口可改）：watchedAt、四档评分、三段评价、overallReview、historyTier、photos、remark。
 * 3. **兼容字段**：`reviews` 是 v0.1 的两段评价数组，迁移后保留原值不再读取（删掉会让老数据无法回滚）。
 */
export interface StatEntry {
  id: string
  listId: string
  subjectId: number
  /** 序号：默认规则 = 放送年份 + 顺序（202601、202602…）；也可以按列表的 seqRule 自定义（见 shared/statSeq.ts） */
  seq: string
  name: string
  nameCn: string
  cover: string
  airDate: string | null // 放送时间
  /**
   * 番剧**类型标签**（bangumi 详情页的 tags，按热度排序）。
   *
   * v0.3.5 起来源固定为详情接口 `SubjectDetail.tags`：
   * 收藏里的 `genres` 也能带出一份，但「当季 / 搜索」两个添加入口拿不到标签，
   * 所以渲染层会对 `genres` 为空的条目回填一次详情标签（见 stores/statTool.ts 的 backfillTags），
   * 落盘进条目后不再重复请求。字段名沿用 `genres` 以免老数据要迁移。
   */
  genres: string[]
  /**
   * 看完时间，**只到天**（`YYYY-MM-DD`，本地时间，无时区）。
   *
   * 为什么砍掉时分秒（用户要求「看完时间不用精确到分秒，只用到天」）：
   * 1. 统计表上多出来的 `T21:04` 没人看，导出图还被它撑宽；
   * 2. 旧值是 `YYYY-MM-DDTHH:mm`，主进程读取时统一归一化成天（见 statStore 的 normalizeEntry），
   *    所以这里放宽成「天」不会让老数据读不出来。
   */
  watchedAt: string | null
  initialRating: number | null // 初始评分 0–10
  midRating: number | null // 中期评分 0–10
  endRating: number | null // 结束评分 0–10
  personalRating: number | null // 个人评分 0–10
  bgmRating: number | null // bangumi 评分（自动带出）
  initialReview: string // 初期评价
  midReview: string // 中期评价
  endReview: string // 结束评价
  overallReview: string // 总体评价
  /** 历史级：自由文本（如「历史级 9」，空串 = 未评级） */
  historyTier: string
  photos: string[] // 剧照（本地图片绝对路径，最多 STAT_MAX_PHOTOS 张）
  remark: string // 备注
  reviews: string[] // 旧评价字段（兼容迁移用）
  finalReview: string // v0.1 的「完结评价」——迁移时并入 endReview，保留原值
  /**
   * 列表内顺序（1 起）：界面与导出图都按它排序，拖动条目只改它、不动 `seq`。
   * 老数据没有该字段时按 `seq` 排序兜底（见 shared/statSeq.ts 的 compareStatOrder）。
   */
  order: number
  /** 最近一次修改时间（详情窗口底部显示） */
  updatedAt?: number
}

/** 剧照上限（渲染层与导出图片共用同一个数字） */
export const STAT_MAX_PHOTOS = 5

export interface StatList {
  id: string
  name: string
  createdAt: number
  /** 置顶：置顶列表排在列表栏最前，排序持久化（undefined = 未置顶） */
  pinned?: boolean
  /**
   * 序号规则模板（空/未填 = 默认「放送年份 + 01、02…」）。
   *
   * 形态只有两种（校验与续号逻辑都在 shared/statSeq.ts，主进程与渲染层共用）：
   * - 纯数字，最多 8 位：`20260701` → 下一条 `20260702`；
   * - 字母前缀 + 数字（字母只能在最前）：`A0701` → 下一条 `A0702`。
   * 规则里的数字部分就是**起始号**：第一条用规则本身，之后按「已有最大号 + 1」续。
   */
  seqRule?: string
}

export interface StatToolData {
  lists: StatList[]
  entries: StatEntry[]
  /**
   * 数据修订号：主进程每次写入 +1。
   *
   * 渲染层「乐观更新 → 等广播确认」靠它收敛：只认 `revision >= 自己发出的那次`
   * 的广播，避免两次快速编辑（比如连按两次置顶）被乱序广播打回旧状态。
   */
  revision?: number
}

/** 渲染层可改的条目字段（白名单，主进程会再过滤一次） */
export type StatEntryPatch = Partial<
  Pick<
    StatEntry,
    | 'watchedAt'
    | 'initialRating'
    | 'midRating'
    | 'endRating'
    | 'personalRating'
    | 'initialReview'
    | 'midReview'
    | 'endReview'
    | 'overallReview'
    | 'historyTier'
    | 'photos'
    | 'remark'
    | 'bgmRating'
    | 'seq'
    | 'order'
    /** 类型标签：允许渲染层回填（详情接口的 tags）与手工修正 */
    | 'genres'
  >
>

/**
 * 统计工具的全部写操作（渲染层 → 主进程）。
 *
 * 为什么不是「渲染层把整个数组写回 store」：多窗口/多次快速编辑会互相覆盖。
 * 主进程是唯一写入方，读-改-写在主进程内存里串行完成，改完广播给所有窗口。
 */
export type StatAction =
  | { kind: 'createList'; name: string; makeCurrent?: boolean; seqRule?: string }
  | { kind: 'renameList'; listId: string; name: string }
  | { kind: 'deleteList'; listId: string }
  | { kind: 'setPinned'; listId: string; pinned: boolean }
  /** 设置/清空列表的序号规则（空串 = 回到默认「年份 + 01、02…」）。非法规则会被主进程拒绝并写日志 */
  | { kind: 'setSeqRule'; listId: string; seqRule: string }
  /**
   * 重新排序：
   * - **不给 entryIds**：按「放送年份 + 当前顺序」整表重排，并按规则重编号（工具栏/右键的「重新排序」）；
   * - **给了 entryIds**：只按这个顺序写 `order`（拖动排序），**不改 `seq`** ——
   *   否则用户拖一下就把自己的自定义编号顺序打乱，那是另一件事（要改编号就点「重新排序」）。
   */
  | { kind: 'resort'; listId: string; entryIds?: string[] }
  | { kind: 'addEntries'; listId: string; items: StatAddItem[] }
  | { kind: 'updateEntry'; entryId: string; patch: StatEntryPatch }
  | { kind: 'removeEntry'; entryId: string }

/**
 * 「添加番剧」的输入项（收藏 / 季度列表 / 搜索结果共用一种形态）。
 * subjectId 为 0 表示没有 bangumi 条目（本地番剧），此时按 name 去重。
 */
export interface StatAddItem {
  subjectId: number
  name: string
  nameCn: string
  cover: string
  airDate: string | null
  rating: number | null
  genres?: string[]
  watchedAt?: string | null
}

/** 可以放进「添加番剧」弹窗的来源 */
export type StatAddSource = 'favorites' | 'season' | 'search'

/**
 * 详情窗口里的观看进度（由主进程按 subjectId / 标题聚合 watchProgress + watchHistory 得出）。
 * 「被标记看完的就是已看完」：`[FLAG]` 标记来自收藏条目上的手动 watchedAt。
 */
export interface StatWatchProgress {
  /** 已观看集数 */
  watchedEpisodes: number
  /** 总集数（未知为 null） */
  totalEpisodes: number | null
  /** 是否已看完（手动标记 / 集数覆盖 / 统计条目自己填了看完时间） */
  completed: boolean
  /** 最后观看时间（毫秒时间戳） */
  lastWatchedAt: number | null
  /** 进度文案，界面上直接显示 */
  text: string
}

/** 剧照候选：截图目录里的一个图片文件 */
export interface StatShotFile {
  path: string
  name: string
  mtime: number
  size: number
}

/** 番剧截图目录信息（详情窗口的「打开截图目录」与图库标题用） */
export interface StatShotDirInfo {
  /** 该番剧的截图子目录（<截图目录>/<番剧名>图片） */
  dir: string
  /** 截图根目录 */
  root: string
  /** 子目录是否存在（不存在时图库只列根目录里的图） */
  dirExists: boolean
  /** 一次返回的最大张数 */
  limit: number
  files: StatShotFile[]
}

/** 导出图片时可勾选的内容 */
export type StatExportField =
  | 'seq'
  | 'cover'
  | 'name'
  | 'airDate'
  | 'watchedAt'
  | 'genres'
  | 'initialRating'
  | 'midRating'
  | 'endRating'
  | 'personalRating'
  | 'bgmRating'
  | 'deviation'
  | 'initialReview'
  | 'midReview'
  | 'endReview'
  | 'overallReview'
  | 'historyTier'
  | 'photos'
  | 'progress'
  | 'remark'

/**
 * 导出图用的主题色。
 *
 * 为什么不在主进程里写死配色：应用支持多套主题（见 styles/main.css 的 `--bg/--elev1/…`），
 * 导出图要和「界面上的列表条目」一个观感，就必须用**当前主题**的颜色。
 * 渲染层在导出前把 `getComputedStyle(document.documentElement)` 里的这些变量读出来传进来，
 * 主进程只负责把它们填进导出 HTML（拿不到时用浅色主题的值兜底）。
 */
export interface StatExportTheme {
  bg: string
  elev1: string
  elev2: string
  border: string
  text: string
  dim: string
  faint: string
  accent: string
  accentSoft: string
  ok: string
  danger: string
  warn: string
}

/** 导出选项：勾选字段 + 条目宽度 + 剧照尺寸 + 配色 + bangumi 评分显示策略 */
export interface StatExportOptions {
  fields: StatExportField[]
  /** 条目宽度倍数（1 = 默认画布宽度；内容多时渲染层会自动加宽，用户也能手动再加宽） */
  widthScale?: number
  /** 剧照图上尺寸倍数（1 = 默认 92×56） */
  photoScale?: number
  /**
   * 是否显示 bangumi 评分（统计工具工具栏那个开关）。
   *
   * 与界面**同一套规则**：`开关打开 || 该条已有个人评分` ——
   * 填了个人评分的条目无论开关如何都显示 bgm 评分（用户要求「填完个人评分后自动显示」）。
   */
  showBgmRating?: boolean
  /** 导出图配色（缺省 = 浅色主题的一组默认值） */
  theme?: StatExportTheme
}

// ---------------- 订阅+下载组合操作 ----------------

export interface SubscribeAndDownloadInput {
  subjectId: number
  name: string
  nameCn: string
  cover: string
  mikanItem: MikanItem
}

export interface SubscribeAndDownloadResult {
  subscription: Subscription
  task: DownloadTask | null
}

// ---------------- galgame 快捷启动器 ----------------

export interface GalGame {
  id: string
  exePath: string
  folder: string
  title: string // 原作名 (from VNDB title or folder name)
  titleCn: string // 汉化名 (VNDB alttitle/zh title, or '')
  vndbId?: string
  cover?: string // local cover file path or remote URL (prefer downloaded local file)
  banner?: string // 横版背景图（VNDB 高清截图，16:9）
  customCover?: string // 用户自定义封面（本地文件）
  customBanner?: string // 用户自定义背景图（本地文件）
  description?: string // VNDB description (plain text, original language)
  descriptionCn?: string // 中文简介（月幕 description 填充，兼容旧数据）
  released?: string
  developers?: string[]
  rating?: number
  length?: string // e.g. 'Long'
  tags?: string[]
  playtimeSec: number // accumulated playtime
  finished: boolean
  finishedAt?: number
  lastRouteInfo?: string // last non-empty game window title captured by detection
  /** 内存识别到的当前章节名（只读扫描；空=未识别） */
  chapterName?: string
  importedAt: number
  /** 月幕Galgame 中文数据源（优先用于中文展示） */
  ymgal?: {
    title: string // 月幕标题（中文）
    description: string // 中文简介
    cover?: string // 封面 URL（可下载到本地后填本地路径，规则与现有 cover 相同）
    released?: string
    developers?: string[]
    staff?: { name: string; role: string }[]
    rating?: number
    url?: string // 月幕游戏详情页链接（https://www.ymgal.games/ga<id>）
    /** 横向背景图（月幕无横图字段时回退为 mainImg 竖封面；本地路径或远程 URL） */
    banner?: string
    /** 出场角色（从 /open/archive?cid= 解析，最多 12 个） */
    characters?: { name: string; nameCn?: string; image?: string; cv?: string; role?: string }[]
    fetchedAt?: number
  }
}

/** 最近截图条目（gal:recent-shots） */
export interface GalRecentShot {
  path: string
  mtime: number
  name: string
}

/**
 * galgame BGM 识别结果（gal:bgm-read）。
 *
 * 悬浮按钮「读取 BGM」调它。识别服务由另一模块提供（只读内存识别），
 * 未开启 / 未识别到时 `name` 为 null、`message` 给出中文提示，前端据此显示，
 * 绝不用假数据占位。
 */
export interface GalBgmResult {
  /** 真实曲名（游戏数据里有映射时）；没有映射时与 code 相同 */
  name: string | null
  /** 代号（音频资源文件名，如 bgm01_a.ogg）——悬浮窗「保存这首」要用它定位档案里的资源 */
  code?: string | null
  /** 附加信息（识别来源 / 识别于几秒前 / 引擎等） */
  detail?: string
  /** 未开启 / 未识别到时的中文提示 */
  message?: string
}

/**
 * 站点搜索结果统计（gal:search-sites）。
 *
 * 「galgame 库」顶部搜索只回传**数量 + 跳转链接**，永远不回传站点正文：
 * 各站页面结构随时会变、且大多靠 JS 渲染，抓正文既不可靠也没必要。
 */
export interface GalSiteSearchResult {
  /** 站点标识（稳定，前端按固定顺序展示） */
  key: string
  /** 站点展示名，如「稻荷acg」 */
  name: string
  /** 站点域名（展示与跳转用） */
  host: string
  /** 命中数量；null = 无法统计 */
  count: number | null
  /**
   * 数量语义（决定前端文案，避免把「首屏条数」冒充「总数」）：
   * - total：站点自己给出的（分页）总数 → 「约 N 个结果」
   * - page：只数出站点返回的首页清单里的条目 → 「首屏 N 个」
   * - none：无法统计（需要 JS / 被 Cloudflare 拦截 / TLS 证书过期等）
   */
  countKind: 'total' | 'page' | 'none'
  /** 站点搜索页跳转链接（能否统计都始终可用） */
  url: string
  /** countKind='none' 时的简短原因（只进日志与提示，不含站点内容） */
  note?: string
}

/** 月幕搜索候选 */
export interface YmgalCandidate {
  id: number
  title: string // 原名
  titlesCn?: string // 中文名
  url: string
  cover?: string
}

export interface GalLaunchResult {
  started: boolean
}

// ---------------- galgame 内存识别（只读） ----------------

/** 一次识别到的 BGM / 章节条目（只读扫描结果缓存） */
export interface GalMemEntry {
  time: number // 识别时间戳
  name: string // 文件名（音频资源名 / 代号）
  engine: string // 来源引擎（空 = 未识别）
  /**
   * 真实曲名（来自游戏自己的数据：明文曲目表，或档案里的 soundlist.csv 之类）。
   * 空串 = 游戏数据里没有「代号→曲名」的映射，界面必须如实显示"只有代号"，不许编曲名。
   */
  title?: string
  /**
   * 这条是怎么来的（只读扫描的三种来源，界面必须区分，不能都当成"正在播放"）：
   * - 'playing'：出现签名刚发生变化 —— 真机实测这就是游戏刚切/刚播放某首 BGM 的信号；
   * - 'new'：本轮扫描新出现的名字；
   * - 'candidate'：游戏内存里现存的音乐类候选（很多游戏一启动就把 BGM 名单常驻内存）。
   */
  kind?: 'playing' | 'new' | 'candidate'
}

/** 某款游戏最近的 BGM 识别结果（供右键面板展示） */
export interface GalMemRecent {
  entries: GalMemEntry[]
  engine: string // 当前识别引擎（空 = 未识别）
  lastError: string // 最近一次错误（空 = 正常；含权限不足的中文提示）
  /** 当前判定为在播的那首（null = 还没捕捉到切曲信号） */
  playing?: GalMemEntry | null
  /** 判定时间（界面显示"识别于 N 秒前"） */
  playingAt?: number
  /** 曲名来源说明（例如「档案 main/soundlist.csv」；空 = 没找到映射） */
  titleSource?: string
  /** true = 游戏数据里没有曲名映射，只有代号（界面如实提示） */
  codeOnly?: boolean
}

/** 已保存的 BGM 文件（gal:bgm-saved） */
export interface GalBgmSaved {
  path: string
  name: string
  mtime: number
  size: number
}

/** galgame galgame 助手 / 工具配置（electron-store key: galgameTools） */
export interface GalToolsConfig {
  screenshotEnabled: boolean // 启动galgame 助手
  hideIcon: boolean // 启动后是否隐藏图标（仅快捷键截图）
  hotkey: string // 全局截图快捷键，如 CommandOrControl+Shift+G
  dir: string // 截图保存位置（空则使用 userData/screenshots/galgame）
}

export const DEFAULT_GAL_TOOLS: GalToolsConfig = {
  screenshotEnabled: false,
  hideIcon: false,
  hotkey: 'CommandOrControl+Shift+G',
  dir: ''
}

/** galgame 推送事件（ev:gal） */
export type GalEvent =
  | { type: 'games'; games: GalGame[] }
  | { type: 'running'; gameId: string; running: boolean }
  | { type: 'mem'; gameId: string; error?: string; chapter?: string; engine?: string }

// ---------------- 规则仓库（KazumiRules）自动更新元信息 ----------------

/**
 * 产品指定的「推荐规则」名单（详情页搜索结果的「推荐」角标只用这份名单判定）。
 *
 * 为什么单独抽成常量：推荐名单是**产品决策**，而判定代码落在详情页组件里，
 * 两处一旦分叉（组件里写死正则、文档里写另一个名单）就会出现「界面上标了推荐，
 * 但产品并没有推荐它」这种对不上的情况。名单只此一份，组件引用它即可。
 *
 * ⚠️ 注意：名单里的名字必须能在**本地规则库**里找到才有意义 ——
 * 内置 DEFAULT_RULES 现在包含 AGE / sorani / aafun / TvTFun / 樱之空 / 7sefun
 * （前三条来自 `resources/rules/*.json`，见 builtinRules.ts），
 * 所以这两个名字在全新安装上就已经存在，不需要先去规则仓库导入。
 */
export const RECOMMENDED_RULES = ['aafun', 'sorani']

/**
 * 置顶规则（v0.3.7，用户要求：「将 aafun、AGE、sorani 规则置顶」）。
 *
 * 与 RECOMMENDED_RULES 的区别：
 *   · RECOMMENDED_RULES 决定**角标**（哪几条值得推荐）；
 *   · 这一份决定**顺序**（列表里排在最前面，用户不用往下翻就能点到）。
 * 为什么要有单独一份而不是复用推荐名单：推荐是「产品觉得好用」，
 * 置顶是「实测最快/最稳、优先试这几条」，两者的名单本来就可能不一样。
 *
 * 名单按**规则名**匹配（忽略大小写）。用户点名的是这三条，就只放这三条 ——
 * 不顺手把「樱之空」也塞进来：置顶是用户对顺序的明确要求，多放一条就等于替他做了决定。
 */
export const PINNED_RULES = ['aafun', 'age', 'sorani']

/**
 * 这条规则是否属于置顶名单（按名字匹配，忽略大小写与首尾空格）。
 */
export function isPinnedRule(name: string): boolean {
  const n = (name ?? '').trim().toLowerCase()
  if (!n) return false
  return PINNED_RULES.some((p) => p.toLowerCase() === n)
}

/**
 * 按置顶名单排序（置顶的排前面，各自保持原有相对顺序）。
 *
 * 放在 shared 里而不是某个页面里：来源选择弹窗与规则管理页都要用同一套顺序，
 * 两处各写一份迟早会分叉（一处置顶了、另一处没置顶，用户会以为置顶失效了）。
 */
export function sortRulesPinnedFirst<T extends { name: string }>(rules: T[]): T[] {
  const pinned = rules.filter((r) => isPinnedRule(r.name))
  const rest = rules.filter((r) => !isPinnedRule(r.name))
  return [...pinned, ...rest]
}

/**
 * 规则仓库自动更新状态（store 命名空间 `rulesRepoMeta`，规则页读它展示「上次自动检测」）。
 * 网络失败只落到这里的 'failed'，不会弹错误框。
 */
export interface RulesRepoMeta {
  /** 上次自动检测时间（毫秒时间戳）；无记录时为空 */
  lastCheckAt?: number
  /** updated=有更新且已导入 / latest=本地都不低于远端 / failed=取不到索引或全部导入失败 */
  lastResult?: 'updated' | 'latest' | 'failed'
  /** 本次实际成功导入（含覆盖）的规则名 */
  updated?: string[]
  /** 本次导入失败的规则名 */
  failed?: string[]
  /** 远端索引条目总数（便于一眼看出"检测到了多少条"） */
  remoteTotal?: number
}

// ---------------- 规则本地库（v0.3.9，用户要求） ----------------

/**
 * 本地库快照的入库原因 —— 界面上要能回答"这条是从哪来的"，所以原因必须落盘而不是靠猜。
 * - builtin：内置版本（随应用分发的那份），是"出问题时最可靠的兜底"
 * - first-seen：第一次见到这条规则（装应用/首次导入时记个底）
 * - before-change / after-change：一次修改前的旧版 / 修改后的新版
 * - repo-import：从 git 规则仓库导入或更新（覆盖前先把被覆盖的那版存下来）
 * - auto-fix：应用启动时按站点改版修正表改写的版本
 * - local-replace：用户用本地库版本替换当前规则（被替换掉的那版同样留档）
 * - removed：这条规则被删掉了（留档，方便找回）
 */
export type LocalRuleReason =
  | 'builtin'
  | 'first-seen'
  | 'before-change'
  | 'after-change'
  | 'repo-import'
  | 'auto-fix'
  | 'local-replace'
  | 'removed'

/**
 * 本地库条目：某条规则在某个时刻的完整快照。
 *
 * 为什么要有这个东西（用户原话）："所有有问题的规则你都可以修改，修改到跑通，
 * 另外规则设置中新增本地库，修改过的规则全部放在本地库中（任何修改都是），
 * 当从 git 规则库中导入的规则或者从 git 规则库中更新的规则跑不通时，我们还有本地库可以替换使用。"
 *
 * 为什么单独一个 store 命名空间（`rulesLocal`）而不是塞进 `rules`：
 * `rules` 会被"从仓库导入/启动自动更新"整条覆盖掉，本地库混在里面就会被一起冲走 ——
 * 那就正好失去了"仓库版本跑不通时还能退回本地版本"的意义。
 */
export interface LocalRuleEntry {
  /** 条目 id：`<ruleId>#<内容哈希>`，同一内容天然去重（不会重复入库） */
  id: string
  /** 对应规则的 id（替换时用它保持规则身份：启用状态、创建时间都不变） */
  ruleId: string
  name: string
  version: string
  /** 快照本体（完整规则，替换时直接写回 store） */
  rule: PlayRule
  /** 入库时间（毫秒时间戳） */
  savedAt: number
  /** 入库原因 */
  reason: LocalRuleReason
  /** 入库时这条内容的来源（界面显示"当前用的是 git 版还是本地版"） */
  origin: RuleOrigin
  /** 内容哈希（名字+版本+地址+搜索/选集定义），用于判断"当前规则是不是就是这个快照" */
  hash: string
}

// ---------------- 搜索页空态：随机推荐番剧 ----------------

/**
 * 推荐分组的种类（搜索页「没有进行搜索」时的空态区）。
 *
 * 四条判据由产品指定，实现集中在 renderer 的 components/RecommendRail.tsx ——
 * 那里同时写明**候选池从哪来**（为什么只用这几个接口、为什么不需要逐条补评分）。
 */
export type RecommendGroupKey = 'hot' | 'top' | 'hidden' | 'season'

/**
 * 推荐区里的一部番剧。
 *
 * 刻意**不**直接复用 SearchResultItem / SeasonItem / CalendarItem：
 * 三个池子的字段名并不一致（放送日期有 `air_date` 也有 `date`，封面可能为 null），
 * 归一化放在取数那一层做，界面层只认这一种形状，卡片代码才不会到处判空。
 */
export interface RecommendItem {
  id: number
  name: string
  /** 中文名（可能为空串，卡片回退到 name） */
  nameCn: string
  images: CoverImages | null
  /** bangumi 评分；null = 该条目还没有评分 */
  score: number | null
  /** 评分人数；0 = 没有评分。四条推荐规则全都靠它和 score 判定 */
  total: number
  airDate: string | null
}

/** 一个推荐分组（四个分组在页面上竖向排列，组内条目也竖向排列） */
export interface RecommendGroup {
  key: RecommendGroupKey
  title: string
  /**
   * 该组的筛选判据文案，界面照实写出来。
   * 推荐这种东西最怕「说不清为什么是这几部」，把判据写在组标题旁，用户自己能核对。
   */
  rule: string
  /** 随机挑出的条目，最多 RECOMMEND_PICK（5）部 */
  items: RecommendItem[]
  /** 候选池里符合该判据的**总数**；< 5 时组末尾显示「真的没有了」 */
  candidates: number
}

/** 空态推荐区的整体状态（候选池可能分几次到位，见 RecommendRail 的渐进式取数） */
export interface RecommendState {
  groups: RecommendGroup[]
  /** 候选池还没取完（界面显示「正在挑选推荐…」） */
  loading: boolean
  /** 候选池整体不可用时的原因；非空时界面给一个重试入口，已有内容照常显示 */
  error: string
}

/** 每个推荐分组最多挑几部（用户要求：每种推荐五部） */
export const RECOMMEND_PICK = 5

/** 候选不足 5 部时组末尾的文案（用户指定的原话） */
export const RECOMMEND_EMPTY_TEXT = '真的没有了'

// ============================================================
// 播放源列表的批量预嗅探（v0.3.7）
// ============================================================

/** 要探测的一条规则（只带探测需要的最小信息） */
export interface BatchProbeTarget {
  id: string
  name: string
  baseUrl: string
}

/**
 * 一条规则的探测进度/结果。
 *
 * 字段刻意分成「能不能找到这部番」与「找到后能不能抓到流」两件事：
 * 用户看到的「没有资源」其实有三种完全不同的原因（这条线路没有这部番 /
 * 有番但播放页拿不到地址 / 拿到了地址但没有可识别的视频请求），
 * 混成一个布尔值会让用户无法判断该换线路还是该换番剧。
 */
export interface BatchProbeUpdate {
  jobId: string
  ruleId: string
  ruleName: string
  /** search=正在搜番剧 / sniff=已进播放页正在嗅探 / done=这条规则出结果了 */
  phase: 'search' | 'sniff' | 'done'
  /** 这条规则里有没有这部番剧 */
  hit: boolean
  /** 解析到的总集数（0 = 没解析到剧集） */
  episodes: number
  /** 嗅探到的候选流数量（用户要的"嗅探到多少资源"） */
  count: number
  /** 最佳候选地址：只用于日志与内部判断，界面不展示完整地址 */
  url?: string
  ok: boolean
  /** 给用户看的一句话说明（中文，直接显示在规则条目上） */
  message?: string
  /** 这条规则已经花掉的毫秒数（界面可显示"12s"让人知道探测有多慢） */
  ms: number
  /**
   * 这条结果是**缓存**里捞出来的（v0.3.7）。
   *
   * 用户要求「批量预嗅探的结果要做一个缓存，再进播放源界面不要重新嗅探，
   * 只有点刷新时才重新嗅探」——一次探测要开窗口访问站点、十几秒起步，
   * 每次进播放源列表都重跑一遍既慢又打扰站点。缓存命中时界面直接显示上次结果，
   * 并在标题上说明是"上次探测于 hh:mm"，让用户知道什么时候该点刷新。
   */
  cached?: boolean
  /** 这份缓存的探测时间（毫秒时间戳）；仅 cached=true 时有值 */
  probedAt?: number
}

// ============================================================
// 自制版式导出为高清图片（v0.3.7：作品评级排名表 / 番剧推荐表）
// ============================================================
/*
 * 为什么导出走「渲染层拼 HTML → 主进程渲染截图」这条路，而不是在渲染进程用 canvas 画：
 *   · 版式复杂（等级标签、封面墙、评分星级、长文本换行）用 HTML/CSS 写一遍就够了，
 *     canvas 手绘等于把同样的版式再实现一次，改一次样式要改两处；
 *   · 渲染进程的 canvas 只能落到浏览器默认下载目录，**没法让用户自选文件夹**（用户明确要求）；
 *   · 主进程的离屏窗口可以按倍率放大渲染（清晰度），还能复用主进程已有的封面取图链路。
 *
 * 协议很薄：渲染层给出完整 HTML（图片位置写成 `{{img:key}}` 占位符）+ 需要预取的图片清单，
 * 主进程负责取图、替换、渲染、放大、弹保存框、落盘，并把「缺了哪几张图」如实报回来。
 */

/** 一张需要主进程预取的图片（封面 / 剧照） */
export interface CardExportImageEntry {
  /** 与 HTML 里 `{{img:key}}` 对应的键 */
  key: string
  /** 远程地址（http/https）或本地绝对路径；空串表示本来就没有图 */
  url: string
  /** 出错时给用户看是哪一条（一般填番剧名） */
  label?: string
}

export interface CardExportImageRequest {
  /** 保存对话框标题，例如「导出排名表为图片」 */
  title: string
  /** 版式宽度（CSS 像素）；导出的实际像素宽 = width × scale */
  width: number
  /** 完整 HTML 文档（含 <style>），图片位置写 `{{img:key}}` */
  html: string
  /** 需要预取的图片清单 */
  images?: CardExportImageEntry[]
  /** 默认文件名（不含目录，可不带 .png 后缀） */
  defaultName: string
  /** 放大倍率，默认 2，上限 3 */
  scale?: number
}

export interface CardExportImageResult {
  /** 实际保存到的路径；用户取消时为空串 */
  path: string
  /** 是否被用户取消 */
  canceled: boolean
  /** 图片取图报告（缺图时界面要提示，不能让用户以为都导进去了） */
  images: {
    /** 需要联网取图的张数（本地图与空地址不计入） */
    total: number
    ok: number
    missing: { label: string; reason: string }[]
  }
  /** 导出图的像素尺寸 */
  width: number
  height: number
}

// ============================================================
// 投屏（v0.3.8）
// ============================================================

/**
 * 一台可投屏的设备。
 *
 * 两种来源（`kind`）：
 *   · `dlna`  —— 标准 DLNA 电视/盒子（SSDP 发现，SOAP 控制）。**不能带 Referer/Cookie**，
 *                需要鉴权的片源要经本机中转；
 *   · `sakana` —— 本仓库 `android-receiver/` 那个小应用（UDP 发现，HTTP JSON 控制）。
 *                可以把 Referer/Cookie 直接交给它，电脑完全不参与传输，最流畅。
 */
export interface CastDevice {
  /** 稳定标识：DLNA 用 UDN，Sakana 接收端用 `ip:port` */
  id: string
  name: string
  kind: 'dlna' | 'sakana'
  host: string
  port: number
  /** DLNA 的 AVTransport 控制地址（Sakana 接收端为空） */
  controlUrl?: string
  /** DLNA 的音量控制地址（RenderingControl） */
  volumeUrl?: string
  /** 设备自报的能力（界面据此决定显示哪些按钮） */
  caps: string[]
  lastSeen: number
}

/** 投给设备的一路媒体（播放页把当前这一集的相关信息打包过来） */
export interface CastMediaInput {
  url: string
  title?: string
  referer?: string
  cookies?: string
  userAgent?: string
  /** 从第几毫秒开始播（投屏时接上电脑这边的进度） */
  startMs?: number
  /** 当前是播放列表里的第几项（接收端选集用） */
  index?: number
  /** 播放列表（接收端能在电视上选集） */
  playlist?: { url: string; title: string }[]
}

/** 接收端当前状态（Sakana 接收端有完整状态；DLNA 电视没有查询接口，返回 null） */
export interface CastReceiverInfo {
  name?: string
  playing?: boolean
  positionMs?: number
  durationMs?: number
  volume?: number
  muted?: boolean
  index?: number
  total?: number
  titles?: string[]
  state?: string
}

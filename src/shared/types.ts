// ============================================================
// Sakana 共享领域类型（主进程 / 渲染层共用）
// ============================================================

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

export interface PlayRule {
  id: string
  name: string
  version: string
  baseUrl: string
  search: RuleSearchDef
  episodes: RuleEpisodesDef
  enabled: boolean
  createdAt: number
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

export const DEFAULT_RULES: PlayRule[] = [
  {
    id: 'default-age',
    name: 'AGE',
    version: '1.5',
    baseUrl: 'https://www.agedm.io/',
    search: {
      type: 'xpath',
      method: 'GET',
      url: 'https://www.agedm.io/search?query=@keyword',
      headers: '{}',
      query: '{}',
      bodyType: '',
      listXPath: '//div[contains(@class,"cata_video_item")]',
      itemNameXPath: '//a[contains(@class,"d-block")]',
      itemLinkXPath: '//a[contains(@class,"d-block")]',
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
      linesXPath: '//div[2]/div/section/div/div[2]/div[2]/div[2]/div',
      episodesXPath: '//ul/li/a',
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
    id: 'default-aafun',
    name: 'aafun',
    version: '1.2',
    baseUrl: 'https://www.moonci.com/',
    search: {
      type: 'xpath',
      method: 'GET',
      url: 'https://www.moonci.com/search/-------------.html?wd=@keyword&submit=',
      headers: '{}',
      query: '{}',
      bodyType: '',
      listXPath: '//ul[contains(@class,"hl-one-list")]/li',
      itemNameXPath: '//div[contains(@class,"hl-item-title")]/a',
      itemLinkXPath: '//div[contains(@class,"hl-item-title")]/a',
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
      episodesXPath: '//ul[contains(@class,"hl-plays-list")]/li/a',
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
  /**
   * 在线播放 HLS 时剔除贴片广告分片（默认开启）。
   * 判据保守：只删「被 #EXT-X-DISCONTINUITY 夹住的 4~60s 短区段」，
   * 判据不足时完全不改并让播放器回源原始播放列表。
   * 可选字段：旧设置文件缺省该键时按「开启」处理（见 adFilter.adFilterEnabled）。
   */
  hlsAdFilter?: boolean
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
    qbit: { url: 'http://127.0.0.1:8080', username: '', password: '' }
  },
  language: 'zh',
  autoCheckUpdate: false,
  galgameDetect: false,
  hlsAdFilter: true,
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

// ---------------- 内置统计工具 v0.1 ----------------

export interface StatEntry {
  id: string
  listId: string
  subjectId: number
  seq: string // 序号：年份+排序，如 202601
  name: string
  nameCn: string
  cover: string
  airDate: string | null // 放送时间
  watchedAt: string | null // 看完时间（YYYY-MM-DD，可手动输入）
  personalRating: number | null // 个人评分
  bgmRating: number | null // bangumi 评分
  photos: string[] // 剧照 1-3（本地图片绝对路径）
  reviews: string[] // 旧评价字段（兼容迁移用）
  initialReview: string // 初始评价
  finalReview: string // 完结评价
  order: number
}

export interface StatList {
  id: string
  name: string
  createdAt: number
}

export interface StatToolData {
  lists: StatList[]
  entries: StatEntry[]
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

/** galgame 截图助手 / 工具配置（electron-store key: galgameTools） */
export interface GalToolsConfig {
  screenshotEnabled: boolean // 启动截图助手
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

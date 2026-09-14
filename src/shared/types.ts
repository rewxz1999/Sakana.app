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
}

export interface SubjectResult {
  fromCache: boolean
  data: SubjectDetail | null
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
  updatedAt: number
}

// ---------------- 标记列表（想看但不想收藏） ----------------

export interface MarkList {
  id: string
  name: string
  createdAt: number
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
}

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

export interface AppSettings {
  theme: string
  bangumiBase: string
  bangumiMirrors: string[]
  dataSources: DataSourcesConfig
  proxy: ProxyConfig
  screenshotDir: string
  downloadDir: string
  ffmpegPath: string // 留空自动使用内置 resources/ffmpeg
  vlcPath: string // 留空自动探测：内置 libvlc / 系统 VLC / 磁盘根目录 VLC（如 E:\VLC）
  playerEngine: 'vlc' | 'mpv' // 播放器内核：mpv=libmpv（推荐，默认），vlc=libVLC（兼容性备选）
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'sakura',
  // bangumi.pro 已被墙，改用同款镜像 bangumi.vip（结构与 bangumi.pro 一致）
  bangumiBase: 'https://bangumi.vip',
  bangumiMirrors: ['https://bangumi.vip', 'https://bangumi.lol', 'https://api.bgm.tv'],
  dataSources: {
    main: 'https://bangumi.vip',
    mirrors: ['https://bangumi.vip', 'https://bangumi.lol', 'https://api.bgm.tv']
  },
  proxy: { enabled: false, type: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
  screenshotDir: '',
  downloadDir: '',
  ffmpegPath: '',
  vlcPath: '',
  playerEngine: 'mpv',
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
  bangumiCustomApi: '',
  bangumiCustomImg: ''
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

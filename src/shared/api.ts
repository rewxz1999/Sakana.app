import type {
  AddDownloadInput,
  AppSettings,
  AspectMode,
  CalendarResult,
  DanmakuComment,
  DanmakuMatch,
  DownloadTask,
  GalEvent,
  GalGame,
  GalLaunchResult,
  GalRecentShot,
  GalToolsConfig,
  LiveStartResult,
  LocalVideoFile,
  LogEntry,
  MediaInspectResult,
  MikanSearchResult,
  MirrorTestResult,
  PlayStatus,
  RuleEpisodeGroup,
  RuleEpisodesResult,
  RulePlayResult,
  RuleSearchEntry,
  RuleSearchResult,
  SearchResult,
  StreamInfo,
  SubUpdateCheck,
  SubjectResult,
  SubscribeAndDownloadInput,
  SubscribeAndDownloadResult,
  Subscription,
  ToolMeta,
  ToolRunResult,
  UpdateInfo,
  YmgalCandidate
} from './types'

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** 主窗口播放页 → 控制栏悬浮窗 的状态快照（只放控制栏需要的字段） */
export interface OverlayState {
  title: string
  subtitle: string
  playing: boolean
  current: number
  duration: number
  volume: number
  muted: boolean
  aspect: AspectMode
  hasEpisodes: boolean
  canPrev: boolean
  canNext: boolean
  subs: { id: number; label: string }[]
  subIdx: number
  /** v0.2.4：控制栏现在也用于小窗口模式，需要知道当前是否全屏（退出键语义不同） */
  fullscreen: boolean
  /** 顶部状态栏文案（捕捉视频流中 / 播放中 / 播放失败…） */
  status: { kind: PlayStatus; text: string }
  /** 失败原因，非空时悬浮窗显示可退出的错误条 */
  error?: string | null
}

/** 悬浮窗 → 播放页 的控制栏动作 */
export type OverlayAction =
  | { type: 'playPause' }
  | { type: 'forward10' }
  | { type: 'back10' }
  | { type: 'volumeUp' }
  | { type: 'volumeDown' }
  | { type: 'toggleMute' }
  | { type: 'seek'; time: number }
  | { type: 'prevEpisode' }
  | { type: 'nextEpisode' }
  | { type: 'cycleSubtitle' }
  | { type: 'setSubtitle'; id: number }
  | { type: 'toggleEpisodes' }
  | { type: 'toggleInfo' }
  | { type: 'snapshot' }
  | { type: 'setAspect'; aspect: AspectMode }
  | { type: 'toggleFullscreen' }
  | { type: 'exitFullscreen' }
  | { type: 'exitPlayer' }

/** 渲染层通过 window.sakana 访问的完整 API 契约（preload 实现） */
export interface SakanaApi {
  window: {
    minimize(): Promise<void>
    maximizeToggle(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    setFullscreen(full: boolean): Promise<void>
    isFullscreen(): Promise<boolean>
    showMain(): Promise<void>
    hideTrayPanel(): Promise<void>
    openSmall(hash: string, opts?: { width?: number; height?: number; title?: string }): Promise<void>
    /** 当前是否为小型配置窗口（主进程以 --sakana-small 启动） */
    isSmallWindow: boolean
    onMaximizeChange(cb: (maximized: boolean) => void): () => void
    onFullscreenChange(cb: (fullscreen: boolean) => void): () => void
  }
  store: {
    get(ns: string): Promise<ApiResult<unknown>>
    set(ns: string, data: unknown): Promise<ApiResult<boolean>>
  }
  bangumi: {
    calendar(force?: boolean): Promise<ApiResult<CalendarResult>>
    subject(id: number): Promise<ApiResult<SubjectResult>>
    search(keyword: string): Promise<ApiResult<SearchResult>>
    ratings(ids: number[]): Promise<ApiResult<Record<number, { score: number | null; total: number }>>>
    testMirrors(): Promise<ApiResult<MirrorTestResult[]>>
  }
  mikan: {
    search(keyword: string): Promise<ApiResult<MikanSearchResult>>
    checkSub(subId: string): Promise<ApiResult<SubUpdateCheck>>
    checkAll(): Promise<ApiResult<SubUpdateCheck[]>>
    onSubUpdates(cb: (updates: SubUpdateCheck[]) => void): () => void
  }
  /** 订阅数据：主进程为唯一写入方，渲染层只读 + 触发操作（变更后自动广播） */
  subs: {
    list(): Promise<ApiResult<Subscription[]>>
    remove(id: string): Promise<ApiResult<Subscription[]>>
    setFolder(id: string, folder: string): Promise<ApiResult<Subscription[]>>
    markUpdated(id: string, episode: number, lastPubDate: string): Promise<ApiResult<Subscription[]>>
    onChanged(cb: (subs: Subscription[]) => void): () => void
  }
  downloads: {
    add(input: AddDownloadInput): Promise<ApiResult<DownloadTask>>
    subscribeAndDownload(
      input: SubscribeAndDownloadInput
    ): Promise<ApiResult<SubscribeAndDownloadResult>>
    subscribeOnly(input: SubscribeAndDownloadInput): Promise<ApiResult<SubscribeAndDownloadResult>>
    pause(id: string): Promise<ApiResult<boolean>>
    resume(id: string): Promise<ApiResult<boolean>>
    retry(id: string): Promise<ApiResult<DownloadTask>>
    remove(id: string): Promise<ApiResult<boolean>>
    list(): Promise<ApiResult<DownloadTask[]>>
    test(): Promise<ApiResult<{ ok: boolean; message: string }>>
    onChanged(cb: (tasks: DownloadTask[]) => void): () => void
  }
  rules: {
    search(ruleId: string, keyword: string): Promise<ApiResult<RuleSearchResult>>
    episodes(ruleId: string, entry: RuleSearchEntry): Promise<ApiResult<RuleEpisodesResult>>
    play(
      ruleId: string,
      entry: RuleSearchEntry,
      lineIndex: number,
      episodeIndex: number,
      episodeLink: string,
      vars: Record<string, string>
    ): Promise<ApiResult<RulePlayResult>>
  }
  media: {
    listVideos(folder: string): Promise<ApiResult<LocalVideoFile[]>>
    inspect(path: string): Promise<ApiResult<MediaInspectResult>>
    startLive(
      path: string,
      opts: {
        mode: 'vcopy' | 'vtranscode'
        startSec?: number
        height?: number | null
        /** 源视频编码（由 inspect 得到）：vcopy 时只有 hevc 才需要 hvc1 标签 */
        videoCodec?: string | null
      }
    ): Promise<ApiResult<LiveStartResult>>
    stopLive(sessionId: string): Promise<ApiResult<boolean>>
    /** 在线流中转：FFmpeg 带站点会话取流并 remux 成本地流 */
    startLiveUrl(
      url: string,
      opts?: { referer?: string; cookies?: string; userAgent?: string }
    ): Promise<ApiResult<LiveStartResult>>
  }
  vlc: {
    attach(bounds?: { x: number; y: number; width: number; height: number }): Promise<
      ApiResult<{ ok: boolean; message: string }>
    >
    play(path: string, referer?: string, cookies?: string): Promise<ApiResult<boolean>>
    setPlaylist(paths: string[]): Promise<ApiResult<boolean>>
    togglePause(): Promise<ApiResult<boolean>>
    seek(sec: number): Promise<ApiResult<boolean>>
    setVolume(volume: number): Promise<ApiResult<boolean>>
    getState(): Promise<ApiResult<{ time: number; length: number; playing: boolean; volume: number; muted: boolean }>>
    setMute(muted: boolean): Promise<ApiResult<boolean>>
    subtitleTracks(): Promise<ApiResult<{ id: number; label: string }[]>>
    setSubtitle(id: number): Promise<ApiResult<boolean>>
    addSubtitleFile(path: string): Promise<ApiResult<boolean>>
    snapshot(title?: string): Promise<ApiResult<string | boolean>>
    detach(): Promise<ApiResult<boolean>>
    notifyLayout(bounds?: { x: number; y: number; width: number; height: number }): Promise<ApiResult<boolean>>
    /** 画面比例：fit=适应 / cover=裁剪铺满 / stretch=拉伸铺满 */
    setAspect(mode: AspectMode, areaW: number, areaH: number): Promise<ApiResult<boolean>>
    onEvent(
      cb: (ev: {
        type: string
        time?: number
        length?: number
        playing?: boolean
        message?: string
        index?: number
      }) => void
    ): () => void
  }
  player: {
    screenshot(title?: string): Promise<ApiResult<string>>
    /** 探测随包内置的播放/下载组件（libVLC / FFmpeg / aria2） */
    assets(): Promise<ApiResult<PlayerAssets>>
    /** 当前流的详细信息（地址/播放列表/分辨率/编码/码率），供播放状态栏展示 */
    streamInfo(): Promise<ApiResult<StreamInfo>>
  }
  /** 全屏控制栏悬浮窗：主窗口播放页 ↔ 悬浮窗渲染层 */
  overlay: {
    isOverlay: boolean
    show(): Promise<ApiResult<boolean>>
    hide(): Promise<ApiResult<boolean>>
    setInteractive(interactive: boolean): Promise<ApiResult<boolean>>
    pushState(state: OverlayState): void
    poke(): void
    action(action: OverlayAction): void
    onState(cb: (state: OverlayState) => void): () => void
    onPoke(cb: () => void): () => void
    onAction(cb: (action: OverlayAction) => void): () => void
  }
  tools: {
    import(): Promise<ApiResult<ToolMeta | null>>
    list(): Promise<ApiResult<ToolMeta[]>>
    remove(id: string): Promise<ApiResult<boolean>>
    run(id: string): Promise<ApiResult<ToolRunResult>>
    exportDocs(format: 'md' | 'txt'): Promise<ApiResult<string>>
  }
  logs: {
    list(): Promise<ApiResult<LogEntry[]>>
    clear(): Promise<ApiResult<boolean>>
    /** 读取日志文件最近 500 行文本（不存在返回空字符串） */
    readFile(): Promise<ApiResult<string>>
    onEntry(cb: (entry: LogEntry) => void): () => void
  }
  dialog: {
    pickFolder(defaultPath?: string): Promise<ApiResult<string | null>>
    pickImages(): Promise<ApiResult<string[]>>
    pickSubtitle(): Promise<ApiResult<string | null>>
    pickDir(defaultPath?: string): Promise<ApiResult<string | null>>
    /** 选择本地视频文件（本地播放） */
    pickVideo(): Promise<ApiResult<string | null>>
    /** 选择本地视频文件夹（批量加入播放列表） */
    pickVideoDir(): Promise<ApiResult<string | null>>
  }
  rulesRepo: {
    index(): Promise<ApiResult<{ name: string; version: string; author: string; lastUpdate: number }[]>>
    import(names: string[]): Promise<ApiResult<{ imported: number; failed: string[] }>>
  }
  ruleProbe: {
    start(url: string, referer?: string): Promise<ApiResult<boolean>>
    stop(): Promise<ApiResult<boolean>>
    onFound(cb: (ev: { url: string; kind: string; referer?: string; cookies?: string }) => void): () => void
    onDone(cb: (ev: { found: boolean; message?: string }) => void): () => void
  }
  ruleWebview: {
    /** Kazumi 式在线播放：用可见网页视图打开播放页并嗅探流地址 */
    open(
      url: string,
      bounds: { x: number; y: number; width: number; height: number },
      referer?: string
    ): Promise<ApiResult<boolean>>
    setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<ApiResult<boolean>>
    close(): Promise<ApiResult<boolean>>
  }
  gal: {
    import(): Promise<ApiResult<GalGame | null>> // null = 用户取消
    list(): Promise<ApiResult<GalGame[]>>
    remove(id: string): Promise<ApiResult<boolean>>
    launch(id: string): Promise<ApiResult<GalLaunchResult>>
    toggleFinished(id: string): Promise<ApiResult<GalGame>>
    updateDetail(id: string): Promise<ApiResult<GalGame>>
    searchYmgal(name: string): Promise<ApiResult<YmgalCandidate[]>>
    applyYmgal(id: string, ymgalId: number): Promise<ApiResult<GalGame>>
    /** 选择一张本地图片（自定义封面/背景用），返回绝对路径 */
    pickImage(): Promise<ApiResult<string | null>>
    /** 设置自定义封面 / 背景图（复制到应用数据目录并持久化） */
    setCustomImage(id: string, kind: 'cover' | 'banner', srcPath: string): Promise<ApiResult<GalGame>>
    /** 清除自定义封面 / 背景图 */
    clearCustomImage(id: string, kind: 'cover' | 'banner'): Promise<ApiResult<GalGame>>
    toolsGet(): Promise<ApiResult<GalToolsConfig>>
    toolsSet(patch: Partial<GalToolsConfig>): Promise<ApiResult<GalToolsConfig>>
    pickDir(): Promise<ApiResult<string | null>>
    screenshotNow(): Promise<ApiResult<string>>
    overlayShot(): Promise<ApiResult<string>>
    dirsGet(): Promise<ApiResult<{ dir: string }>>
    dirsSet(dir: string): Promise<ApiResult<{ dir: string }>>
    recentShots(): Promise<ApiResult<GalRecentShot[]>>
    onEvent(cb: (ev: GalEvent) => void): () => void
  }
  stat: {
    exportImage(listId: string): Promise<ApiResult<string>> // 空字符串 = 用户取消
  }
  app: {
    dataPath(): Promise<ApiResult<string>>
    /** 应用版本号（取自 package.json） */
    version(): Promise<ApiResult<string>>
    openDataDir(): Promise<ApiResult<string>>
    openPath(path: string): Promise<ApiResult<string>>
    /** 从 git 仓库检查更新（比对远端 package.json / version.json） */
    checkUpdate(): Promise<ApiResult<UpdateInfo>>
    /** 用系统浏览器打开链接（更新下载页等） */
    openUrl(url: string): Promise<ApiResult<boolean>>
  }
  /** 弹幕（预留：弹弹play API，接入方式参考 Kazumi） */
  danmaku: {
    /** 按番剧标题 + 集数匹配弹幕库条目 */
    match(title: string, episode: number): Promise<ApiResult<DanmakuMatch | null>>
    /** 拉取该集弹幕 */
    comments(episodeId: number): Promise<ApiResult<DanmakuComment[]>>
  }
  cache: {
    info(): Promise<ApiResult<CacheInfo>>
    clear(): Promise<ApiResult<{ bytes: number }>>
    junkClear(): Promise<ApiResult<number>>
    /** 设置自定义缓存目录（''=恢复默认 userData/cache），主进程会 mkdir -p */
    setDir(dir: string): Promise<ApiResult<{ dir: string }>>
  }
  navBg: {
    get(): Promise<ApiResult<{ path: string }>>
    set(path: string): Promise<ApiResult<boolean>>
    pick(): Promise<ApiResult<{ ok: boolean; error?: string; path?: string }>>
  }
  saveDirs: {
    info(): Promise<ApiResult<SaveDirsInfo>>
    /** 修改保存目录并**立即生效**（主进程同步给下载器/截图服务，并返回最新配置） */
    set(patch: Partial<SaveDirsInfo>): Promise<ApiResult<SaveDirsInfo>>
  }
}

export interface SaveDirsInfo {
  baseDir: string
  downloadDir: string
  screenshotDir: string
  galDir: string
}

/** 随包内置的播放/下载组件探测结果（player:assets） */
export interface PlayerAssets {
  vlc: boolean
  ffmpeg: boolean
  aria2: boolean
  /** libmpv 运行时（libmpv-2.dll）是否就绪 */
  mpv: boolean
}

/** 缓存占用信息（cache:info）：dir 为当前生效的缓存根目录 */
export interface CacheInfo {
  bytes: number
  dir: string
  custom: boolean
}

export type SettingsPatch = Partial<AppSettings>

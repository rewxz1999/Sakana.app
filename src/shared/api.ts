import type {
  AddDownloadInput,
  AppSettings,
  AspectMode,
  CalendarResult,
  DanmakuComment,
  DanmakuLoadResult,
  DanmakuMatch,
  DanmakuSettings,
  DeleteLocalResult,
  DownloadTask,
  GalEvent,
  GalGame,
  GalLaunchResult,
  GalRecentShot,
  GalSiteSearchResult,
  GalToolsConfig,
  LiveStartResult,
  LocalDirInfo,
  LocalTargetInput,
  LocalVideoFile,
  LogEntry,
  MediaInspectResult,
  MikanSearchResult,
  MirrorTestResult,
  PlayStatus,
  RemoveRecordsResult,
  RuleEpisodeGroup,
  RuleEpisodesResult,
  RulePlayResult,
  RuleSearchEntry,
  RuleSearchResult,
  SearchResult,
  SeasonResult,
  StreamInfo,
  SubUpdateCheck,
  SubjectResult,
  SubscribeAndDownloadInput,
  SubscribeAndDownloadResult,
  Subscription,
  ToolMeta,
  ToolRunResult,
  UpdateInstallState,
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
  /** v0.2.9 最后更新：当前播放倍速（控制栏显示档位，1 = 原速） */
  speed: number
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
  /**
   * v0.2.6：选集与详情面板改由悬浮窗绘制。
   * 原生视频窗口永远盖在网页之上，画在页面里的抽屉根本看不见（用户反馈「详情点了没反应」），
   * 所以这两个面板和状态栏一样走悬浮窗，做成半透明浮层盖在画面上。
   */
  showEpisodes: boolean
  showInfo: boolean
  currentLine: number
  currentEp: number
  /** 番剧 id：悬浮窗自己去拉详情，避免把大对象塞进高频状态推送 */
  subjectId?: number
  /** 断点续播提示（非空时悬浮窗右下角显示「撤销跳转」）：同样因为画在页面里会被视频盖住 */
  resume?: { target: number } | null
  /**
   * v0.2.8：视频区域矩形（相对窗口的 CSS 像素）。
   * 弹幕要精确地盖在画面之上、且不压到上下控制栏，所以由播放页把 `#player-host` 的矩形推过来。
   */
  videoRect?: { x: number; y: number; width: number; height: number }
}

/** 选集数据（低频变化，单独走一个通道；避免把大数组塞进每秒多次的状态推送） */
export interface OverlayEpisodes {
  lines: { name: string; episodes: string[] }[]
  currentLine: number
  currentEp: number
}

/**
 * 弹幕数据（v0.2.8）。
 *
 * 与选集同理单独走一个通道：一集可能有上千条弹幕，不能塞进每秒多次的状态推送。
 * 只有「换集 / 改设置 / 开关弹幕」时才推一次。
 */
export interface OverlayDanmaku {
  /** 整集弹幕（已按时间排序）；空数组表示这一集没找到弹幕 */
  comments: DanmakuComment[]
  /** 显示设置（覆盖区域、同屏条数、时间轴微调、字号…） */
  settings: DanmakuSettings
  /** 当前这一集的来源描述，例如「败犬女主太多了！ 第01集」；空表示没匹配到 */
  source: string
  /** 正在加载弹幕 */
  loading: boolean
  /**
   * v0.2.9：弹幕是否由 mpv 的 uosc_danmaku 插件渲染。
   * 为 true 时内置画布层必须**停止绘制**（否则两套弹幕会叠在一起），
   * 但条数/来源信息照常显示 —— 数据本来就是同一份。
   */
  pluginActive?: boolean
}

/** 悬浮窗 → 播放页 的控制栏动作 */
export type OverlayAction =
  | { type: 'playPause' }
  | { type: 'forward10' }
  | { type: 'back10' }
  | { type: 'volumeUp' }
  | { type: 'volumeDown' }
  /** v0.2.9：控制栏音量滑杆（0-100），取代原来的静音按钮 */
  | { type: 'setVolume'; value: number }
  /** v0.2.9 最后更新：设置播放倍速（0.25–4） */
  | { type: 'setSpeed'; value: number }
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
  /** 选集浮层里点了某一集 */
  | { type: 'selectEpisode'; line: number; ep: number }
  /** v0.2.8 弹幕：开关 / 改单项设置 / 打开详细设置 / 重新检测 / 别名检测 */
  | { type: 'toggleDanmaku' }
  | { type: 'danmakuSetting'; key: keyof DanmakuSettings; value: number | boolean | string }
  | { type: 'openDanmakuSettings' }
  /** v0.2.9：打开 mpv 弹幕插件（uosc_danmaku）自己的菜单 */
  | { type: 'uoscMenu'; key: 'search' | 'total' | 'style' | 'delay' | 'add' }
  | { type: 'reloadDanmaku' }
  | { type: 'detectDanmakuAlias' }
  /** 断点续播提示上的两个按钮 */
  | { type: 'undoResume' }
  | { type: 'dismissResume' }

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
    /**
     * 某个季度的番剧列表（番剧表「预览 20xx年春」弹窗）。
     * month 可传该季度内的任意一个月，主进程会规范化到季度并按季度缓存。
     */
    season(year: number, month: number, force?: boolean): Promise<ApiResult<SeasonResult>>
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
    /**
     * 推导某番剧/订阅的本地目录。卡片上的「本地播放」用它取代旧的文件夹选择框：
     * 目录自动按「下载任务记录 → 订阅记录 → 下载根目录/番剧名」推导。
     */
    localDir(input: LocalTargetInput): Promise<ApiResult<LocalDirInfo>>
    /** 删除本地资源：磁盘文件 + 对应下载记录（不可撤销，界面必须二次确认） */
    deleteLocal(input: LocalTargetInput): Promise<ApiResult<DeleteLocalResult>>
    /** 只删下载记录，**绝不**删除磁盘上已下载的文件（下载列表综合卡片用） */
    removeRecords(input: { animeTitle?: string; ids?: string[] }): Promise<ApiResult<RemoveRecordsResult>>
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
    /** 查该播放页已缓存的直链（命中可跳过整轮嗅探） */
    cachedStream(pageUrl: string): Promise<ApiResult<{ url: string; referer?: string } | null>>
    /** 把刚嗅探到的直链记进会话缓存 */
    rememberStream(pageUrl: string, url: string, referer?: string): Promise<ApiResult<boolean>>
    /** 后台预取某集的直链（只走 HTML 直出，不创建窗口）；一并返回播放页地址供切集复用 */
    prefetchStream(
      ruleId: string,
      entry: RuleSearchEntry,
      lineIndex: number,
      episodeIndex: number,
      episodeLink: string,
      vars: Record<string, string>
    ): Promise<ApiResult<{ pageUrl: string; url: string | null; referer?: string } | null>>
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
  player: {
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
    /** v0.2.9 最后更新：播放倍速（0.25–4，scaletempo2 变速不变调） */
    setSpeed(speed: number): Promise<ApiResult<boolean>>
    subtitleTracks(): Promise<ApiResult<{ id: number; label: string }[]>>
    setSubtitle(id: number): Promise<ApiResult<boolean>>
    addSubtitleFile(path: string): Promise<ApiResult<boolean>>
    snapshot(title?: string, episode?: number): Promise<ApiResult<string | boolean>>
    detach(): Promise<ApiResult<boolean>>
    notifyLayout(bounds?: { x: number; y: number; width: number; height: number }): Promise<ApiResult<boolean>>
    /** 画面比例：fit=适应 / cover=裁剪铺满 / stretch=拉伸铺满 */
    setAspect(mode: AspectMode, areaW: number, areaH: number): Promise<ApiResult<boolean>>
    /** v0.2.8 附加七：把当前播放页地址告知 mpv 的 B 站弹幕脚本（直链无法反推页面） */
    setDanmakuSource(pageUrl: string): Promise<ApiResult<boolean>>
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
    /** 截图（v0.2.9：目录/文件名规则统一由主进程处理，见 snapshotPath） */
    screenshot(title?: string, episode?: number): Promise<ApiResult<string>>
    /** 探测随包内置的播放/下载组件（libmpv / FFmpeg / aria2） */
    assets(): Promise<ApiResult<PlayerAssets>>
    /** 当前流的详细信息（分辨率/编码/码率等），供播放状态栏展示 */
    streamInfo(): Promise<ApiResult<StreamInfo>>
  }
  /** 全屏控制栏悬浮窗：主窗口播放页 ↔ 悬浮窗渲染层 */
  overlay: {
    isOverlay: boolean
    /**
     * 显示/销毁控制栏悬浮窗。
     * v0.2.8 附加：show 会返回「代号」，hide 时把它带回来 ——
     * 切集时旧的播放页实例卸载得比新实例的 show 晚，迟到的 hide 不能把新控制栏一起关掉。
     */
    show(): Promise<ApiResult<{ ok: boolean; gen: number }>>
    hide(gen?: number): Promise<ApiResult<boolean>>
    setInteractive(interactive: boolean): Promise<ApiResult<boolean>>
    pushState(state: OverlayState): void
    /** v0.2.6：推送选集数据（低频），供悬浮窗绘制半透明选集浮层 */
    setEpisodes(payload: OverlayEpisodes): void
    onEpisodes(cb: (payload: OverlayEpisodes) => void): () => void
    /** v0.2.8：推送弹幕数据与设置（换集 / 改设置时一次） */
    setDanmaku(payload: OverlayDanmaku): void
    onDanmaku(cb: (payload: OverlayDanmaku) => void): () => void
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
    /** 某款游戏自己的截图（只读该游戏的截图子目录） */
    listShots(gameName: string): Promise<ApiResult<GalRecentShot[]>>
    /** 按游戏名统计各资源站的搜索结果数量（只回数量 + 跳转链接，不回传站点内容） */
    searchSites(keyword: string): Promise<ApiResult<GalSiteSearchResult[]>>
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
    /**
     * 从 git 仓库检查更新（v0.2.9 最后更新后以 **GitHub Releases** 为准：
     * 能拿到更新说明与安装包资产，因此可以一键更新；拿不到 API 时回落到 version.json 镜像）。
     */
    checkUpdate(): Promise<ApiResult<UpdateInfo>>
    /** 下载安装包（进度通过 onUpdateState 推送） */
    updateDownload(): Promise<ApiResult<{ ok: boolean; file?: string; message: string }>>
    /** 静默安装已下载的安装包并自动重启（本进程会退出） */
    updateInstall(): Promise<ApiResult<{ ok: boolean; message: string }>>
    /** 打开 Releases 页面（该版本没有可用安装包时的兜底） */
    updateOpenReleases(): Promise<ApiResult<boolean>>
    /** 查询当前下载/安装状态（刚打开面板时用） */
    updateState(): Promise<ApiResult<UpdateInstallState>>
    /** 订阅下载/安装状态推送 */
    onUpdateState(cb: (state: UpdateInstallState) => void): () => void
    /** 用系统浏览器打开链接（更新下载页等） */
    openUrl(url: string): Promise<ApiResult<boolean>>
  }
  /** 弹幕（弹弹play 接口；签名由反代完成，客户端无需 AppId） */
  danmaku: {
    /** 按番剧标题 + 集数匹配弹幕库条目 */
    match(title: string, episode: number): Promise<ApiResult<DanmakuMatch | null>>
    /** 拉取该集弹幕 */
    comments(episodeId: number): Promise<ApiResult<DanmakuComment[]>>
    /** 一步到位：番剧标题 + 集数 → 弹幕列表（播放器与本地播放共用） */
    load(
      title: string,
      episode: number,
      opts?: { aliases?: string[]; aliasMode?: boolean }
    ): Promise<ApiResult<DanmakuLoadResult | null>>
    /** 预取：只预热主进程缓存、不回传弹幕本体（进播放 / 切集时提前加载） */
    prefetch(
      title: string,
      episode: number,
      opts?: { aliases?: string[]; aliasMode?: boolean }
    ): Promise<ApiResult<{ ok: boolean; count: number; cached: boolean }>>
  }
  /**
   * uosc_danmaku（mpv 弹幕插件）集成（v0.2.9）。
   *
   * 应用只暴露「语义动作」：把弹幕交给插件、开关、打开插件的菜单、清空来源。
   * 插件自身的渲染、布局、样式菜单完全由上游实现，替换资源目录即可升级。
   */
  uosc: {
    /** 插件当前状态：用户是否选了插件渲染 / 插件是否真的挂上了 / 是否已显示弹幕 / 是否有弹幕在等文件就绪 */
    status(): Promise<ApiResult<{ requested: boolean; active: boolean; loaded: boolean; pending: boolean }>>
    /** 打开插件的菜单（uosc 渲染）：搜索弹幕 / 总菜单 / 弹幕样式 / 源延迟 / 从源添加 */
    menu(which: 'search' | 'total' | 'style' | 'delay' | 'add'): Promise<ApiResult<boolean>>
    /** 显式设置插件的弹幕开关（与内置开关联动；插件把开关状态存在自己的记录文件里） */
    setVisible(on: boolean): Promise<ApiResult<boolean>>
    /** 清空当前关联的弹幕源（切集时用，避免上一集残留） */
    clear(): Promise<ApiResult<boolean>>
    /** 弹幕时间轴微调（毫秒） */
    delay(offsetMs: number): Promise<ApiResult<boolean>>
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
  player: boolean
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

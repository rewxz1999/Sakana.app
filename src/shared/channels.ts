// IPC 通道常量（主进程与 preload 共用，避免字符串漂移）
export const CH = {
  // 窗口控制
  winMinimize: 'win:minimize',
  winMaximizeToggle: 'win:maximize-toggle',
  winClose: 'win:close',
  winIsMaximized: 'win:is-maximized',
  winSetFullscreen: 'win:set-fullscreen',
  winIsFullscreen: 'win:is-fullscreen',
  winShowMain: 'win:show-main',
  winHideTrayPanel: 'win:hide-tray-panel',
  winOpenSmall: 'win:open-small',
  evWinMaximize: 'ev:win-maximize',
  evWinFullscreen: 'ev:win-fullscreen',

  // 存储
  storeGet: 'store:get',
  storeSet: 'store:set',

  // bangumi 数据源
  bgmCalendar: 'bgm:calendar',
  bgmSubject: 'bgm:subject',
  bgmSearch: 'bgm:search',
  bgmRatings: 'bgm:ratings',
  // 季度（新番季）预览：年份 + 该季度内任意月份
  bgmSeason: 'bgm:season',
  bgmTestMirrors: 'bgm:test-mirrors',
  /** 角色列表（「最XX的角色 9宫格」工具）：v0 优先 + 老接口兜底 */
  bgmCharacters: 'bgm:characters',
  /**
   * 远程图片 → data URL（九宫格导出画 canvas 用）。
   * 走主进程取字节：自定义协议 sakana-img:// 是跨源资源，直接画进 canvas 会污染画布，
   * toBlob() 会抛 SecurityError；data URL 永不污染。
   */
  bgmImageDataUrl: 'bgm:image-data-url',

  // 蜜柑计划
  mikanSearch: 'mikan:search',
  mikanCheckSub: 'mikan:check-sub',
  mikanCheckAll: 'mikan:check-all',
  evSubUpdates: 'ev:sub-updates',

  // 下载
  dlAdd: 'dl:add',
  dlSubscribeAndDownload: 'dl:subscribe-and-download',
  dlSubscribeOnly: 'dl:subscribe-only',
  dlPause: 'dl:pause',
  dlResume: 'dl:resume',
  dlRetry: 'dl:retry',
  dlRemove: 'dl:remove',
  dlList: 'dl:list',
  dlStatus: 'dl:status',
  dlTest: 'dl:test',
  /** 推导某番剧的本地目录（自动用下载目录，不再让用户选文件夹） */
  dlLocalDir: 'dl:local-dir',
  /** 删除本地资源：磁盘文件 + 对应下载记录（不可撤销） */
  dlDeleteLocal: 'dl:delete-local',
  /** 只删下载记录，不删文件（下载列表综合卡片用） */
  dlRemoveRecords: 'dl:remove-records',
  evDownloads: 'ev:downloads',

  // 播放规则引擎
  rulesSearch: 'rules:search',
  rulesEpisodes: 'rules:episodes',
  rulesPlay: 'rules:play',
  /*
   * v0.2.7 附加：直链会话缓存与预取 —— 用来加速「进入播放」与「播放器内切集」。
   * - cachedStream：查某个播放页已缓存的直链（命中就跳过整轮嗅探）
   * - prefetchStream：后台预取某个播放页的直链（只走 HTML 直出，不开窗口）
   * - rememberStream：把刚嗅探到的直链记进缓存
   */
  rulesCachedStream: 'rules:cached-stream',
  rulesPrefetchStream: 'rules:prefetch-stream',
  rulesRememberStream: 'rules:remember-stream',

  // 媒体
  mediaListVideos: 'media:list-videos',
  mediaInspect: 'media:inspect',
  mediaStartLive: 'media:start-live',
  mediaStopLive: 'media:stop-live',
  mediaStartLiveUrl: 'media:start-live-url',
  playerAttach: 'player:attach',
  playerPlay: 'player:play',
  playerSetPlaylist: 'player:set-playlist',
  playerTogglePause: 'player:toggle-pause',
  playerSeek: 'player:seek',
  playerSetVolume: 'player:set-volume',
  playerGetState: 'player:get-state',
  playerSetMute: 'player:set-mute',
  /** v0.2.9 最后更新：播放倍速（0.25–4，变速不变调） */
  playerSetSpeed: 'player:set-speed',
  playerSubtitleTracks: 'player:subtitle-tracks',
  playerSetSubtitle: 'player:set-subtitle',
  playerAddSubtitleFile: 'player:add-subtitle-file',
  playerSnapshot: 'player:snapshot',
  playerDetach: 'player:detach',
  playerNotifyLayout: 'player:notify-layout',
  playerSetAspect: 'player:set-aspect',
  evPlayer: 'ev:player',
  playerScreenshot: 'player:screenshot',
  // 全屏控制栏悬浮窗（原生视频窗口永远盖在网页之上，全屏时控制栏需独立透明窗口叠加）
  overlayShow: 'overlay:show',
  overlayHide: 'overlay:hide',
  overlaySetSpace: 'overlay:set-interactive',
  overlayState: 'overlay:state',
  // v0.2.6：选集数据单独走一条低频通道（状态推送是每秒多次的，不适合塞大数组）
  overlayEpisodes: 'overlay:episodes',
  // v0.2.8：弹幕数据同理（一集可能上千条，换集/改设置时才推）
  overlayDanmaku: 'overlay:danmaku',
  overlayAction: 'overlay:action',
  overlayPoke: 'overlay:poke',
  // 内置组件探测（libmpv / FFmpeg / aria2 是否随包内置）
  playerAssets: 'player:assets',
  /** v0.2.8 附加七：把「当前播放页地址」告知 mpv 的 B 站弹幕脚本 */
  playerDanmakuSource: 'player:danmaku-source',
  /**
   * v0.2.9：uosc_danmaku（mpv 弹幕插件）的集成接口。
   * 应用侧只负责「把已解析好的弹幕交给插件」与「调用插件的菜单/开关」，
   * 渲染、布局、样式菜单全部由插件自己实现。
   */
  playerUoscStatus: 'player:uosc-status',
  playerUoscMenu: 'player:uosc-menu',
  playerUoscVisible: 'player:uosc-visible',
  /** 直接给插件 episodeId（插件自己去 api_server 取弹幕）—— 应用侧本地弹幕文件不可用时的第二级 */
  playerUoscEpisode: 'player:uosc-episode',
  playerUoscClear: 'player:uosc-clear',
  playerUoscDelay: 'player:uosc-delay',

  // 订阅（主进程为唯一写入方：变更后广播，渲染层只读 + 触发操作）
  subsList: 'subs:list',
  subsRemove: 'subs:remove',
  subsSetFolder: 'subs:set-folder',
  subsMarkUpdated: 'subs:mark-updated',
  evSubs: 'ev:subs',

  // 工具
  toolImport: 'tool:import',
  toolList: 'tool:list',
  toolRemove: 'tool:remove',
  toolRun: 'tool:run',
  toolExportDocs: 'tool:export-docs',

  // 日志
  logList: 'log:list',
  logClear: 'log:clear',
  evLog: 'ev:log',

  // 对话框
  dialogPickFolder: 'dialog:pick-folder',
  dialogPickImages: 'dialog:pick-images',
  dialogPickSubtitle: 'dialog:pick-subtitle',
  /** 选择本地视频文件播放（v0.2.4 本地播放） */
  dialogPickVideo: 'dialog:pick-video',
  /** 选择本地视频文件夹 */
  dialogPickVideoDir: 'dialog:pick-video-dir',

  // 播放状态与流详情（播放器顶部状态栏）
  playerStreamInfo: 'player:stream-info',

  // 更新检查与一键更新（GitHub Releases）
  appUpdateCheck: 'app:update-check',
  /** v0.2.9 最后更新：下载安装包（带进度推送） */
  appUpdateDownload: 'app:update-download',
  /** v0.2.9 最后更新：静默安装并重启 */
  appUpdateInstall: 'app:update-install',
  /** v0.2.9 最后更新：打不开安装包时引导到 Releases 页面 */
  appUpdateOpenReleases: 'app:update-open-releases',
  /** 查询当前下载/安装状态（渲染层刚打开面板时用） */
  appUpdateState: 'app:update-state',
  /** 下载/安装状态下行（进度条） */
  evUpdateState: 'ev:update-state',
  /**
   * v0.2.12：打开**更新窗口**（独立可视化界面，用户要求「更新程序需要可视化界面看到进度」）。
   * 设置页、重要更新弹窗、托盘菜单都通过它打开同一个窗口。
   */
  appUpdateOpenWindow: 'app:update-open-window',
  /** v0.2.12：重要更新提醒里点「稍后」——记下这个版本，本次不再打扰 */
  appUpdateSnooze: 'app:update-snooze',
  /** v0.2.12：发现**重要更新**时下行给主窗口，由应用外壳弹出强提醒 */
  evUpdateImportant: 'ev:update-important',
  appOpenUrl: 'app:open-url',

  // 弹幕（预留：弹弹play）
  danmakuMatch: 'danmaku:match',
  danmakuComments: 'danmaku:comments',
  /** v0.2.8：一步到位（番剧名 + 集数 → 弹幕列表），播放器与本地播放共用 */
  danmakuLoad: 'danmaku:load',
  /** v0.2.8 附加：只预热缓存、不回传弹幕本体（进播放/切集时预加载用） */
  danmakuPrefetch: 'danmaku:prefetch',

  // 保存目录（立即生效）
  saveDirsSet: 'save-dirs:set',

  // 规则仓库导入 / 播放页流嗅探
  rulesRepoIndex: 'rules:repo-index',
  rulesRepoImport: 'rules:repo-import',
  ruleProbeStart: 'rule:probe-start',
  ruleProbeStop: 'rule:probe-stop',
  ruleWebviewOpen: 'rule:webview-open',
  ruleWebviewBounds: 'rule:webview-bounds',
  ruleWebviewClose: 'rule:webview-close',
  evRuleProbe: 'ev:rule-probe',

  // galgame 快捷启动器
  galImport: 'gal:import',
  galList: 'gal:list',
  galRemove: 'gal:remove',
  galLaunch: 'gal:launch',
  galToggleFinished: 'gal:toggle-finished',
  galUpdateDetail: 'gal:update-detail',
  galSearchYmgal: 'gal:search-ymgal',
  galApplyYmgal: 'gal:apply-ymgal',
  galPickImage: 'gal:pick-image',
  galSetCustomImage: 'gal:set-custom-image',
  galClearCustomImage: 'gal:clear-custom-image',
  galToolsGet: 'gal:tools-get',
  galToolsSet: 'gal:tools-set',
  galPickDir: 'gal:pick-dir',
  galScreenshotNow: 'gal:screenshot-now',
  galOverlayShot: 'gal:overlay-shot',
  galRecentShots: 'gal:recent-shots',
  /** 某款游戏自己的截图（「最近截图」挂在每张游戏卡片上，只看该游戏目录） */
  galListShots: 'gal:list-shots',
  /** 按游戏名统计各资源站的搜索结果数量（只回数量 + 跳转链接，不回传站点内容） */
  galSearchSites: 'gal:search-sites',
  evGal: 'ev:gal',

  // 统计工具
  statExportImage: 'stat:export-image',

  // 设置页扩展：日志文件 / 数据目录 / 缓存 / 保存目录 / 导航背景
  logRead: 'log:read',
  appDataPath: 'app:data-path',
  /** 应用版本号（唯一来源：package.json，避免各处硬编码漂移） */
  appVersion: 'app:version',
  openDataDir: 'app:open-data-dir',
  openPath: 'app:open-path',
  cacheInfo: 'cache:info',
  cacheClear: 'cache:clear',
  junkClear: 'cache:junk-clear',
  cacheSetDir: 'cache:set-dir',
  navBgGet: 'nav-bg:get',
  navBgSet: 'nav-bg:set',
  navBgPick: 'nav-bg:pick',
  galDirsGet: 'gal:dirs-get',
  galDirsSet: 'gal:dirs-set',
  pickDir: 'dialog:pick-dir',
  saveDirsInfo: 'save-dirs:info'
} as const

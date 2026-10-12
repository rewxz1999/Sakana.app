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
  /** galgame 沉浸模式：进/出时记住窗口几何并切换全屏（退出恢复小窗口） */
  winImmersive: 'win:immersive',
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
  /** 「更新到第几集」（v0.3.7）：按分集接口的 airdate 数已放送集数 */
  bgmEpisodeProgress: 'bgm:episode-progress',
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
  /** v0.3.0：按标题用 Jikan（MAL）取角色 —— 9宫格可切换到更清晰的立绘数据源 */
  bgmCharactersJikan: 'bgm:characters-jikan',
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
  dlTest: 'dl:test',
  /** 推导某番剧的本地目录（自动用下载目录，不再让用户选文件夹） */
  dlLocalDir: 'dl:local-dir',
  /** 删除本地资源：磁盘文件 + 对应下载记录（不可撤销） */
  dlDeleteLocal: 'dl:delete-local',
  /** 只删下载记录，不删文件（下载列表综合卡片用） */
  dlRemoveRecords: 'dl:remove-records',
  /** 外部 qBittorrent 状态：是否可连、版本、程序路径、探测到的可用端口（设置页如实显示原因） */
  qbitStatus: 'qbit:status',
  /** 由应用启动 qBittorrent 并等 WebUI 就绪（设置页的手动启动按钮） */
  qbitLaunch: 'qbit:launch',
  /** 选择 qBittorrent 程序（.exe） */
  dialogPickExe: 'dialog:pick-exe',
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
  /** v0.3.7：画面子窗口诊断快照（查「正在播放但没有画面」用） */
  playerSurfaceDebug: 'player:surface-debug',
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
  /** v0.3.6：把一张截图写进系统剪贴板（快速粘贴） */
  clipboardCopyImage: 'clipboard:copy-image',
  /** v0.3.6：剪贴板里是否已有图片 */
  clipboardHasImage: 'clipboard:has-image',
  /** v0.3.9：把一段文本写进系统剪贴板（galgame 悬浮按钮「复制 BGM 名称」用） */
  clipboardCopyText: 'clipboard:copy-text',
  // 全屏控制栏悬浮窗（原生视频窗口永远盖在网页之上，全屏时控制栏需独立透明窗口叠加）
  overlayShow: 'overlay:show',
  overlayHide: 'overlay:hide',
  overlaySetSpace: 'overlay:set-interactive',
  overlayState: 'overlay:state',
  /** v0.3.6：控制栏点不动时的自救提示（疑似点击击穿 → 告诉用户按 F 重全屏 / Esc 退出） */
  overlayClickThrough: 'overlay:click-through',
  /** v0.3.6：渲染层上报「这个位置点了但没落到按钮上」（主进程据此判定击穿） */
  overlayMissedClick: 'overlay:missed-click',
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
  /*
   * v0.3.6（清理）：删掉了 `playerUoscEpisode`（'player:uosc-episode'）。
   * 它是全仓唯一的**完全死通道**：没有 ipcMain handler、preload 里也没暴露给渲染层，
   * 它原本的消费方（mpv.ts 的 `mpvPushDanmakuEpisode`）同样没有任何调用方。
   * 留着会让人误以为「还有一条给插件喂 episodeId 的路」。
   */
  playerUoscClear: 'player:uosc-clear',
  playerUoscDelay: 'player:uosc-delay',
  /**
   * v0.2.18：uosc 控制栏的状态下行（播放页 → mpv 侧桥接脚本）。
   *
   * 与上面的插件接口是两件事：这里传的是**控制栏自己的状态**
   * （选集/线路/字幕表/倍速/比例/弹幕设置…），桥接脚本据此刷新按钮与菜单。
   */
  playerUoscBar: 'player:uosc-bar',
  /**
   * v0.3.3：让 uosc 立刻把控制栏显示出来。
   *
   * 为什么需要：uosc 按设计只在鼠标靠近底部时显示控制栏，画面中间移动鼠标它不出来；
   * 而且鼠标事件能否到 mpv 还受窗口层级影响。所以改由**应用侧主动唤出**：
   * 播放页每次看到鼠标移动就调它，主进程执行 uosc 自带的 `script-binding uosc/flash-ui`。
   */
  playerUoscReveal: 'player:uosc-reveal',

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
  /** v0.3.7：把自制版式（排名表 / 推荐表）导出成高清 PNG 并保存到用户自选位置 */
  cardExportImage: 'card:export-image',

  // 日志
  logList: 'log:list',
  logClear: 'log:clear',
  evLog: 'ev:log',

  // 对话框
  dialogPickFolder: 'dialog:pick-folder',
  dialogPickImages: 'dialog:pick-images',
  /** 只选一张本地图片（v0.3.5：「最XX的角色」右键格子添加本地立绘） */
  dialogPickImage: 'dialog:pick-image',
  dialogPickSubtitle: 'dialog:pick-subtitle',
  /** 选择本地视频文件播放（v0.2.4 本地播放） */
  dialogPickVideo: 'dialog:pick-video',
  /** 选择本地视频文件夹 */
  dialogPickVideoDir: 'dialog:pick-video-dir',

  // 播放状态与流详情（播放器顶部状态栏）
  playerStreamInfo: 'player:stream-info',
  /*
   * 播放过程进度（v0.3.9）。
   *
   * flow：**纯内存读**的三阶段快照（找资源 / 取资源 / 注入播放器，含实时耗时）。
   *   与 playerStreamInfo 的区别是它不发任何网络请求，所以可以按秒拉而不心疼
   *   （渲染层在「尚未开播」时本来就已经在轮询内核状态，直接并进那一次轮询）。
   * flowMark：渲染层把「我现在进到哪一步了」写回主进程 ——
   *   阶段划分的知识在渲染层（规则搜索/取集/进播放页的顺序），
   *   而状态必须只有一份（主进程），否则详情面板与状态栏会各说各话。
   */
  playerFlow: 'player:flow',
  playerFlowMark: 'player:flow-mark',
  /**
   * 资源可达性取证（v0.3.9）：拿直链真的去请求一次，量首字节/速率/HTTP 状态，
   * 返回「网站问题 / 速度过慢 / 格式不支持」的判定。在交给播放器之后**并行**调用。
   */
  playerDiagnose: 'player:diagnose',
  /** 在线播放自检（v0.3.9）：查嗅探残留与内核错配，可按需自动重置 */
  playerSelfCheck: 'player:self-check',
  /** 一键重置整条播放链路（关嗅探、清直链缓存、销毁内核） */
  playerHardReset: 'player:hard-reset',

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

  // 弹幕数据源集合器 + 弹幕盒子 + 本地弹幕库（v1.1）
  /** 读集合器（顺带把内置源/适配器能力一起回给设置页） */
  danmakuSourcesGet: 'danmaku:sources-get',
  /** 整表保存集合器（增删改、启停、排序都在渲染层改完整体提交，主进程再校验一遍） */
  danmakuSourcesSet: 'danmaku:sources-set',
  /** 测试一条数据源：真发请求，逐步回结果（不是假按钮） */
  danmakuSourceTest: 'danmaku:source-test',
  /** 弹幕盒子：按关键字搜索引 */
  danmakuBoxSearch: 'danmaku:box-search',
  /** 弹幕盒子：下载某条并（尽量）取到指定集，落到本地弹幕库 */
  danmakuBoxDownload: 'danmaku:box-download',
  /** 本地弹幕库：列表 / 删除 / 清空 / 改目录 / 打开目录 */
  danmakuLibList: 'danmaku:lib-list',
  danmakuLibRemove: 'danmaku:lib-remove',
  danmakuLibClear: 'danmaku:lib-clear',
  danmakuLibSetDir: 'danmaku:lib-set-dir',
  danmakuLibOpenDir: 'danmaku:lib-open-dir',

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
  /** v0.3.7：播放源列表的批量预嗅探（每条规则命中多少资源） */
  rulesBatchProbe: 'rules:batch-probe',
  rulesBatchProbeStop: 'rules:batch-probe-stop',
  evRuleBatchProbe: 'ev:rule-batch-probe',
  /** v0.3.7：人机验证窗口（站点要求验证时，在应用内弹窗让用户自己过） */
  rulesVerifyOpen: 'rules:verify-open',
  rulesVerifyBounds: 'rules:verify-bounds',
  rulesVerifyClose: 'rules:verify-close',

  // 投屏（v0.3.8）：发现设备、投屏、遥控
  castDiscover: 'cast:discover',
  castStopDiscover: 'cast:stop-discover',
  castAddManual: 'cast:add-manual',
  castPlay: 'cast:play',
  castControl: 'cast:control',
  castInfo: 'cast:info',
  castStop: 'cast:stop',
  /** v0.3.8：投屏/同步服务的局域网地址（手机端手填它就能互通） */
  castSyncUrl: 'cast:sync-url',
  /** 记住"投给哪台设备"（用户选过之后下一次自动用它） */
  castSetTarget: 'cast:set-target',
  evCastDevices: 'ev:cast-devices',

  // galgame 快捷启动器
  galImport: 'gal:import',
  galList: 'gal:list',
  galRemove: 'gal:remove',
  galLaunch: 'gal:launch',
  galToggleFinished: 'gal:toggle-finished',
  galUpdateDetail: 'gal:update-detail',
  galSearchYmgal: 'gal:search-ymgal',
  galApplyYmgal: 'gal:apply-ymgal',
  /** v0.3.9：读取某款游戏最近识别到的 BGM（只读内存识别，供卡片右键面板） */
  galMemRecent: 'gal:mem-recent',
  galPickImage: 'gal:pick-image',
  galSetCustomImage: 'gal:set-custom-image',
  galClearCustomImage: 'gal:clear-custom-image',
  galToolsGet: 'gal:tools-get',
  galToolsSet: 'gal:tools-set',
  galPickDir: 'gal:pick-dir',
  galScreenshotNow: 'gal:screenshot-now',
  galOverlayShot: 'gal:overlay-shot',
  /** v0.3.9：悬浮按钮展开/收起选择面板（动态调整悬浮窗尺寸，height=面板所需窗口高度） */
  galOverlayResize: 'gal:overlay-resize',
  /** v0.3.9：读取当前正在运行的 galgame 的 BGM（内存识别，服务就绪前返回未开启提示） */
  galBgmRead: 'gal:bgm-read',
  /** v0.3.9：把识别到的 BGM 从游戏档案只读提取并保存到本地（代号或曲名） */
  galBgmSave: 'gal:bgm-save',
  /** v0.3.9：最近保存的 BGM（卡片右键菜单「最近保存的 bgm」） */
  galBgmSaved: 'gal:bgm-saved',
  /** V1.1：引擎检测 + 自动解包 + 解析曲名映射（只读游戏档案） */
  galUnpack: 'gal:unpack',
  /** V1.1：解包状态（未解包时给出为什么还不能识别曲名/提取立绘） */
  galUnpackStatus: 'gal:unpack-status',
  /** V1.1：立绘 / CG 提取（只写自己的保存目录） */
  galExtractImages: 'gal:extract-images',
  /** V1.1：手动刷新当前 BGM 识别（跳过轮询） */
  galMemRefresh: 'gal:mem-refresh',
  galRecentShots: 'gal:recent-shots',
  /** 某款游戏自己的截图（「最近截图」挂在每张游戏卡片上，只看该游戏目录） */
  galListShots: 'gal:list-shots',
  /** 按游戏名统计各资源站的搜索结果数量（只回数量 + 跳转链接，不回传站点内容） */
  galSearchSites: 'gal:search-sites',
  evGal: 'ev:gal',

  // 统计工具（v0.2：主进程为唯一写入方——get 拉全量，apply 发一个动作，改完广播 ev:stat）
  statGet: 'stat:get',
  statApply: 'stat:apply',
  evStat: 'ev:stat',
  /*
   * v0.3.8：主进程改了「收藏 / 观看历史」这类库数据后广播一次，界面重新读一遍。
   * 目前唯一的触发点是手机端把观看历史推回电脑（castSync.mergeHistory）——
   * 渲染层那份 watchHistory 是整份缓存 + 整份写回，不重新读就会被旧数组覆盖掉。
   */
  evLibrary: 'ev:library',
  /*
   * v0.3.9 体检 H1：**任何一方**写了设置就广播一次，所有窗口重新读取。
   *
   * 为什么必须有它：`settings` 有两个写入方 —— 渲染层（设置页、播放器浮层）与主进程十几处
   * （Anime4K 画质、音频、投屏目标、缓存目录、数据源迁移标记…），而两边以前都拿自己那份快照
   * 整份回写，谁后写谁赢。典型表现是"在播放器里调好的画质，回主窗口点一个不相关的开关就变回默认"。
   * 广播挂在 store 的写入钩子上，主进程那十几处因此**自动**被覆盖，不需要逐个改。
   */
  evSettings: 'ev:settings',
  statExportImage: 'stat:export-image',
  /** 详情窗口的剧照来源：番剧截图目录（<截图目录>/<番剧名>图片） */
  statShots: 'stat:shots',
  /** 在系统文件管理器里打开番剧截图目录 */
  statShotsOpenDir: 'stat:shots-open-dir',
  /** 详情窗口的观看进度（watchProgress + watchHistory 聚合，主进程算） */
  statWatchProgress: 'stat:watch-progress',

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
  galDirsGet: 'gal:dirs-get',
  galDirsSet: 'gal:dirs-set',
  pickDir: 'dialog:pick-dir',
  saveDirsInfo: 'save-dirs:info',
  /**
   * 搜索页展示位（空态轮播图）：把用户挑的图片复制进应用数据目录并返回新路径。
   * 必须过主进程：`sakana-img://local` 只放行白名单目录，用户随手选的图片路径不在白名单里。
   */
  showcaseImportImages: 'showcase:import-images',
  /**
   * v0.3.9：在线播放加速器的当前状态（是否在加速 / 实时速率 / 为什么这么决定）。
   * 只读、纯内存；设置页按秒轮询它显示**真实**状态，而不是按档位猜。
   */
  playerBoostStatus: 'player:boost-status',
  /**
   * v0.3.9 补充更新：优化记录（每次真正启用加速的真实测量结果）。
   * 读一次返回最近 N 条（主进程已按 BOOST_RECORD_MAX 截断），另有一个清空入口。
   */
  playerBoostRecords: 'player:boost-records',
  playerBoostClearRecords: 'player:boost-clear-records'
} as const

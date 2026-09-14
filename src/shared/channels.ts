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
  bgmTestMirrors: 'bgm:test-mirrors',

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
  evDownloads: 'ev:downloads',

  // 播放规则引擎
  rulesSearch: 'rules:search',
  rulesEpisodes: 'rules:episodes',
  rulesPlay: 'rules:play',

  // 媒体
  mediaListVideos: 'media:list-videos',
  mediaInspect: 'media:inspect',
  mediaStartLive: 'media:start-live',
  mediaStopLive: 'media:stop-live',
  mediaStartLiveUrl: 'media:start-live-url',
  vlcAttach: 'vlc:attach',
  vlcPlay: 'vlc:play',
  vlcSetPlaylist: 'vlc:set-playlist',
  vlcTogglePause: 'vlc:toggle-pause',
  vlcSeek: 'vlc:seek',
  vlcSetVolume: 'vlc:set-volume',
  vlcGetState: 'vlc:get-state',
  vlcSetMute: 'vlc:set-mute',
  vlcSubtitleTracks: 'vlc:subtitle-tracks',
  vlcSetSubtitle: 'vlc:set-subtitle',
  vlcAddSubtitleFile: 'vlc:add-subtitle-file',
  vlcSnapshot: 'vlc:snapshot',
  vlcDetach: 'vlc:detach',
  vlcNotifyLayout: 'vlc:notify-layout',
  vlcSetAspect: 'vlc:set-aspect',
  evVlc: 'ev:vlc',
  playerScreenshot: 'player:screenshot',
  // 全屏控制栏悬浮窗（原生视频窗口永远盖在网页之上，全屏时控制栏需独立透明窗口叠加）
  overlayShow: 'overlay:show',
  overlayHide: 'overlay:hide',
  overlaySetSpace: 'overlay:set-interactive',
  overlayState: 'overlay:state',
  overlayAction: 'overlay:action',
  overlayPoke: 'overlay:poke',
  // 内置组件探测（libVLC / FFmpeg / aria2 是否随包内置）
  playerAssets: 'player:assets',

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

  // 更新检查（git 仓库）
  appUpdateCheck: 'app:update-check',
  appOpenUrl: 'app:open-url',

  // 弹幕（预留：弹弹play）
  danmakuMatch: 'danmaku:match',
  danmakuComments: 'danmaku:comments',

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

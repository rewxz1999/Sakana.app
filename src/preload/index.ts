import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { SakanaApi, ApiResult } from '@shared/api'
import { CH } from '@shared/channels'

async function call<T>(channel: string, ...args: unknown[]): Promise<ApiResult<T>> {
  try {
    const data = (await ipcRenderer.invoke(channel, ...args)) as T
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function subscribe<T extends unknown[]>(
  channel: string,
  cb: (...args: T) => void
): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as T))
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: SakanaApi = {
  window: {
    minimize: () => ipcRenderer.invoke(CH.winMinimize),
    maximizeToggle: () => ipcRenderer.invoke(CH.winMaximizeToggle),
    close: () => ipcRenderer.invoke(CH.winClose),
    isMaximized: () => ipcRenderer.invoke(CH.winIsMaximized),
    setFullscreen: (full: boolean) => ipcRenderer.invoke(CH.winSetFullscreen, full),
    setImmersive: (immersive: boolean) => ipcRenderer.invoke(CH.winImmersive, immersive),
    isFullscreen: () => ipcRenderer.invoke(CH.winIsFullscreen),
    showMain: () => ipcRenderer.invoke(CH.winShowMain),
    hideTrayPanel: () => ipcRenderer.invoke(CH.winHideTrayPanel),
    openSmall: (hash, opts) => ipcRenderer.invoke(CH.winOpenSmall, hash, opts),
    isSmallWindow: process.argv.includes('--sakana-small'),
    onMaximizeChange: (cb) => subscribe<[boolean]>(CH.evWinMaximize, cb),
    onFullscreenChange: (cb) => subscribe<[boolean]>(CH.evWinFullscreen, cb)
  },
  clipboard: {
    copyImage: (file) => call(CH.clipboardCopyImage, file),
    hasImage: () => call(CH.clipboardHasImage),
    copyText: (text) => call(CH.clipboardCopyText, text)
  },
  store: {
    get: (ns) => call(CH.storeGet, ns),
    set: (ns, data) => call(CH.storeSet, ns, data),
    /** 库数据（收藏/历史）被主进程改过（v0.3.8：手机端同步回来）时通知界面重新读 */
    onChanged: (cb) => subscribe<[]>(CH.evLibrary, cb),
    /** 设置被**任意一方**（含主进程内部）改过时通知界面重新读（v0.3.9 体检 H1） */
    onSettingsChanged: (cb) => subscribe<[]>(CH.evSettings, cb)
  },
  bangumi: {
    calendar: (force) => call(CH.bgmCalendar, force),
    subject: (id) => call(CH.bgmSubject, id),
    search: (keyword) => call(CH.bgmSearch, keyword),
    ratings: (ids, force) => call(CH.bgmRatings, ids, force),
    season: (year, month, force) => call(CH.bgmSeason, year, month, force),
    // v0.3.7：「更新到第几集」（番剧表详情页用；取不到返回 null）
    episodeProgress: (id) => call(CH.bgmEpisodeProgress, id),
    testMirrors: () => call(CH.bgmTestMirrors),
    // 「最XX的角色 9宫格」：角色列表（v0 优先 + 老接口兜底）与导出用的图片 data URL
    characters: (id) => call(CH.bgmCharacters, id),
    // v0.3.0：按标题用 Jikan（MAL）取角色（工具里可切换的数据源，主进程侧统一节流）
    charactersJikan: (title) => call(CH.bgmCharactersJikan, title),
    imageDataUrl: (url) => call(CH.bgmImageDataUrl, url)
  },
  mikan: {
    search: (keyword) => call(CH.mikanSearch, keyword),
    checkSub: (subId, full) => call(CH.mikanCheckSub, subId, full),
    checkAll: () => call(CH.mikanCheckAll),
    onSubUpdates: (cb) => subscribe(CH.evSubUpdates, cb)
  },
  subs: {
    list: () => call(CH.subsList),
    remove: (id) => call(CH.subsRemove, id),
    setFolder: (id, folder) => call(CH.subsSetFolder, id, folder),
    markUpdated: (id, episode, lastPubDate) => call(CH.subsMarkUpdated, id, episode, lastPubDate),
    onChanged: (cb) => subscribe(CH.evSubs, cb)
  },
  downloads: {
    add: (input) => call(CH.dlAdd, input),
    subscribeAndDownload: (input) => call(CH.dlSubscribeAndDownload, input),
    subscribeOnly: (input) => call(CH.dlSubscribeOnly, input),
    pause: (id) => call(CH.dlPause, id),
    resume: (id) => call(CH.dlResume, id),
    retry: (id) => call(CH.dlRetry, id),
    remove: (id) => call(CH.dlRemove, id),
    list: () => call(CH.dlList),
    test: () => call(CH.dlTest),
    // 本地资源：目录自动推导（不再弹文件夹选择框）/ 删除文件+记录 / 只删记录
    localDir: (input) => call(CH.dlLocalDir, input),
    deleteLocal: (input) => call(CH.dlDeleteLocal, input),
    removeRecords: (input) => call(CH.dlRemoveRecords, input),
    // 外部 qBittorrent：状态（连不上时给中文原因 + 探测到的端口）/ 由应用启动并等 WebUI 就绪
    qbitStatus: () => call(CH.qbitStatus),
    qbitLaunch: () => call(CH.qbitLaunch),
    onChanged: (cb) => subscribe(CH.evDownloads, cb)
  },
  rules: {
    search: (ruleId, keyword) => call(CH.rulesSearch, ruleId, keyword),
    episodes: (ruleId, entry) => call(CH.rulesEpisodes, ruleId, entry),
    play: (ruleId, entry, lineIndex, episodeIndex, episodeLink, vars) =>
      call(CH.rulesPlay, ruleId, entry, lineIndex, episodeIndex, episodeLink, vars),
    // v0.2.7 附加：直链会话缓存 / 预取（进入播放与切集提速）
    cachedStream: (pageUrl) => call(CH.rulesCachedStream, pageUrl),
    rememberStream: (pageUrl, url, referer) => call(CH.rulesRememberStream, pageUrl, url, referer),
    prefetchStream: (ruleId, entry, lineIndex, episodeIndex, episodeLink, vars) =>
      call(CH.rulesPrefetchStream, ruleId, entry, lineIndex, episodeIndex, episodeLink, vars)
  },
  media: {
    listVideos: (folder) => call(CH.mediaListVideos, folder),
    inspect: (path) => call(CH.mediaInspect, path),
    startLive: (path, opts) => call(CH.mediaStartLive, path, opts),
    stopLive: (sessionId) => call(CH.mediaStopLive, sessionId),
    startLiveUrl: (url, opts) => call(CH.mediaStartLiveUrl, url, opts)
  },
  player: {
    attach: (bounds) => call(CH.playerAttach, bounds),
    play: (path, referer, cookies) => call(CH.playerPlay, path, referer, cookies),
    setPlaylist: (paths) => call(CH.playerSetPlaylist, paths),
    togglePause: () => call(CH.playerTogglePause),
    seek: (sec) => call(CH.playerSeek, sec),
    setVolume: (volume) => call(CH.playerSetVolume, volume),
    getState: () => call(CH.playerGetState),
    // v0.3.7：画面子窗口诊断（「正在播放但没有画面」时取现场）
    surfaceDebug: () => call(CH.playerSurfaceDebug),
    setMute: (muted) => call(CH.playerSetMute, muted),
    setSpeed: (speed) => call(CH.playerSetSpeed, speed),
    subtitleTracks: () => call(CH.playerSubtitleTracks),
    setSubtitle: (id) => call(CH.playerSetSubtitle, id),
    addSubtitleFile: (path) => call(CH.playerAddSubtitleFile, path),
    snapshot: (title, episode) => call(CH.playerSnapshot, title, episode),
    // v0.2.9：截图 / 组件探测 / 流信息合并进同一个 player 命名空间（此前它们在第二个同名对象里）
    screenshot: (title, episode) => call(CH.playerScreenshot, title, episode),
    assets: () => call(CH.playerAssets),
    streamInfo: () => call(CH.playerStreamInfo),
    // v0.3.9：在线播放加速器状态（是否真的在加速 / 实时速率 / 决策原因），纯内存读
    boostStatus: () => call(CH.playerBoostStatus),
    // v0.3.9 补充更新：优化记录（读最近 N 条 / 清空），只碰 <userData>/data/streamBoostLog.json
    boostRecords: () => call(CH.playerBoostRecords),
    boostClearRecords: () => call(CH.playerBoostClearRecords),
    /*
     * v0.3.9：播放过程进度（三阶段实时状态）。
     * flow 是纯内存读，可以按秒拉；flowMark 把渲染层知道的阶段边界写回主进程。
     */
    flow: () => call(CH.playerFlow),
    flowMark: (mark) => call(CH.playerFlowMark, mark),
    /** 资源可达性取证：网站问题 / 速度过慢 / 格式不支持 */
    diagnose: (url, referer, cookies) => call(CH.playerDiagnose, url, referer, cookies),
    /** 嗅探残留 + 内核错配自检（可按需自动重置） */
    selfCheck: (opts) => call(CH.playerSelfCheck, opts),
    /** 一键重置整条播放链路 */
    hardReset: () => call(CH.playerHardReset),
    detach: () => call(CH.playerDetach),
    notifyLayout: (bounds) => call(CH.playerNotifyLayout, bounds),
    setAspect: (mode, areaW, areaH) => call(CH.playerSetAspect, mode, areaW, areaH),
    // v0.2.8 附加七：告知 mpv 的 B 站弹幕脚本「当前播放页地址」
    setDanmakuSource: (pageUrl) => call(CH.playerDanmakuSource, pageUrl),
    onEvent: (cb) => subscribe(CH.evPlayer, cb)
  },
  // v0.2.9：uosc_danmaku（mpv 弹幕插件）集成（与 api.uosc 命名空间对应）
  uosc: {
    status: () => call(CH.playerUoscStatus),
    menu: (which) => call(CH.playerUoscMenu, which),
    setVisible: (on) => call(CH.playerUoscVisible, on),
    clear: () => call(CH.playerUoscClear),
    delay: (offsetMs) => call(CH.playerUoscDelay, offsetMs),
    // v0.2.18：控制栏状态下行（uosc 按钮的图标/激活态/角标、各菜单的内容）
    bar: (payload) => call(CH.playerUoscBar, payload),
    // v0.3.3：让 uosc 立刻显示控制栏（播放页看到鼠标移动时调）
    reveal: () => call(CH.playerUoscReveal)
  },
  overlay: {
    isOverlay: process.argv.includes('--sakana-overlay'),
    show: () => call(CH.overlayShow),
    hide: (gen) => call(CH.overlayHide, gen),
    setInteractive: (interactive) => call(CH.overlaySetSpace, interactive),
    // 高频消息用 send：状态下行、动作上行、鼠标唤出
    pushState: (state) => ipcRenderer.send(CH.overlayState, state),
    setEpisodes: (payload) => ipcRenderer.send(CH.overlayEpisodes, payload),
    onEpisodes: (cb) => subscribe(CH.overlayEpisodes, cb),
    // v0.2.8：弹幕数据与设置
    setDanmaku: (payload) => ipcRenderer.send(CH.overlayDanmaku, payload),
    onDanmaku: (cb) => subscribe(CH.overlayDanmaku, cb),
    poke: () => ipcRenderer.send(CH.overlayPoke),
    action: (action) => ipcRenderer.send(CH.overlayAction, action),
    /*
     * v0.3.6「点击击穿」自救：渲染层把每次指针按下报上来（含坐标），
     * 主进程结合「当前是不是穿透态 + 鼠标最近有没有动过」判断是否属于击穿，
     * 连续命中就发 overlayClickThrough 事件回来，由悬浮窗弹一条提示浮层。
     */
    reportMissedClick: (x: number, y: number) => ipcRenderer.send(CH.overlayMissedClick, x, y),
    onClickThrough: (cb) => subscribe(CH.overlayClickThrough, cb),
    onState: (cb) => subscribe(CH.overlayState, cb),
    onPoke: (cb) => subscribe<[]>(CH.overlayPoke, cb),
    onAction: (cb) => subscribe(CH.overlayAction, cb)
  },
  tools: {
    import: () => call(CH.toolImport),
    list: () => call(CH.toolList),
    remove: (id) => call(CH.toolRemove, id),
    run: (id) => call(CH.toolRun, id),
    exportDocs: (format) => call(CH.toolExportDocs, format),
    // v0.3.7：自制版式导出成高清 PNG（排名表 / 推荐表用同一个入口）
    exportCardImage: (req) => call(CH.cardExportImage, req)
  },
  logs: {
    list: () => call(CH.logList),
    clear: () => call(CH.logClear),
    readFile: () => call(CH.logRead),
    onEntry: (cb) => subscribe(CH.evLog, cb)
  },
  dialog: {
    pickFolder: (defaultPath) => call(CH.dialogPickFolder, defaultPath),
    pickImages: () => call(CH.dialogPickImages),
    pickImage: () => call(CH.dialogPickImage),
    pickSubtitle: () => call(CH.dialogPickSubtitle),
    pickDir: (defaultPath) => call(CH.pickDir, defaultPath),
    pickVideo: () => call(CH.dialogPickVideo),
    pickVideoDir: () => call(CH.dialogPickVideoDir),
    // 选 .exe（qBittorrent 程序路径）
    pickExe: (defaultPath) => call(CH.dialogPickExe, defaultPath)
  },
  showcase: {
    // 搜索页展示位（空态轮播图）：把选中的图片收进应用数据目录（白名单内）后返回新路径
    importImages: (paths) => call(CH.showcaseImportImages, paths)
  },
  rulesRepo: {
    index: () => call(CH.rulesRepoIndex),
    import: (names) => call(CH.rulesRepoImport, names)
  },
  ruleProbe: {
    start: (url, referer) => call(CH.ruleProbeStart, url, referer),
    stop: () => call(CH.ruleProbeStop),
    onFound: (cb) =>
      subscribe(CH.evRuleProbe, (ev: { type?: string }) => {
        if (ev && ev.type === 'found') cb(ev as never)
      }),
    onDone: (cb) =>
      subscribe(CH.evRuleProbe, (ev: { type?: string }) => {
        if (ev && ev.type === 'done') cb(ev as never)
      })
  },
  // v0.3.7：播放源列表的批量预嗅探（每条规则命中多少资源）
  ruleBatchProbe: {
    start: (req) => call(CH.rulesBatchProbe, req),
    stop: () => call(CH.rulesBatchProbeStop),
    onUpdate: (cb) => subscribe(CH.evRuleBatchProbe, cb)
  },
  // v0.3.7：人机验证窗口（站点要求验证时在应用内弹窗，让用户自己过）
  ruleVerify: {
    open: (ruleId, keyword, bounds) => call(CH.rulesVerifyOpen, ruleId, keyword, bounds),
    setBounds: (bounds) => call(CH.rulesVerifyBounds, bounds),
    close: () => call(CH.rulesVerifyClose)
  },
  // v0.3.8：投屏（发现设备 / 投屏 / 遥控）
  cast: {
    discover: () => call(CH.castDiscover),
    stopDiscover: () => call(CH.castStopDiscover),
    addManual: (addr) => call(CH.castAddManual, addr),
    play: (deviceId, media) => call(CH.castPlay, deviceId, media),
    control: (deviceId, action, value) => call(CH.castControl, deviceId, action, value),
    info: (deviceId) => call(CH.castInfo, deviceId),
    stop: (deviceId) => call(CH.castStop, deviceId),
    syncUrl: () => call(CH.castSyncUrl),
    setTarget: (deviceId) => call(CH.castSetTarget, deviceId),
    onDevices: (cb) => subscribe(CH.evCastDevices, cb)
  },
  ruleWebview: {
    open: (url, bounds, referer) => call(CH.ruleWebviewOpen, url, bounds, referer),
    setBounds: (bounds) => call(CH.ruleWebviewBounds, bounds),
    close: () => call(CH.ruleWebviewClose)
  },
  gal: {
    import: () => call(CH.galImport),
    list: () => call(CH.galList),
    remove: (id) => call(CH.galRemove, id),
    launch: (id) => call(CH.galLaunch, id),
    toggleFinished: (id) => call(CH.galToggleFinished, id),
    updateDetail: (id) => call(CH.galUpdateDetail, id),
    searchYmgal: (name) => call(CH.galSearchYmgal, name),
    applyYmgal: (id, ymgalId) => call(CH.galApplyYmgal, id, ymgalId),
    pickImage: () => call(CH.galPickImage),
    setCustomImage: (id, kind, srcPath) => call(CH.galSetCustomImage, id, kind, srcPath),
    clearCustomImage: (id, kind) => call(CH.galClearCustomImage, id, kind),
    toolsGet: () => call(CH.galToolsGet),
    toolsSet: (patch) => call(CH.galToolsSet, patch),
    pickDir: () => call(CH.galPickDir),
    screenshotNow: () => call(CH.galScreenshotNow),
    overlayShot: () => call(CH.galOverlayShot),
    overlayResize: (open, height) => ipcRenderer.invoke(CH.galOverlayResize, open, height),
    readBgm: () => call(CH.galBgmRead),
    memRecent: (gameId) => call(CH.galMemRecent, gameId),
    saveBgm: (gameId, code) => call(CH.galBgmSave, gameId, code),
    savedBgm: (gameId, gameName) => call(CH.galBgmSaved, gameId, gameName),
    unpack: (gameId, exePath, gameName, force) => call(CH.galUnpack, gameId, exePath, gameName, !!force),
    unpackStatus: (gameId, exePath) => call(CH.galUnpackStatus, gameId, exePath),
    extractImages: (gameId, exePath, gameName, kind, limit) =>
      call(CH.galExtractImages, gameId, exePath, gameName, kind, limit),
    refreshBgm: (gameId) => call(CH.galMemRefresh, gameId),
    dirsGet: () => call(CH.galDirsGet),
    dirsSet: (dir) => call(CH.galDirsSet, dir),
    recentShots: () => call(CH.galRecentShots),
    listShots: (gameName) => call(CH.galListShots, gameName),
    searchSites: (keyword) => call(CH.galSearchSites, keyword),
    onEvent: (cb) => subscribe(CH.evGal, cb)
  },
  stat: {
    get: () => call(CH.statGet),
    apply: (action) => call(CH.statApply, action),
    onChanged: (cb) => subscribe(CH.evStat, cb),
    exportImage: (listId, opts) => call(CH.statExportImage, listId, opts),
    shots: (entry) => call(CH.statShots, entry),
    shotsOpenDir: (entry) => call(CH.statShotsOpenDir, entry),
    watchProgress: (entry) => call(CH.statWatchProgress, entry)
  },
  app: {
    dataPath: () => call(CH.appDataPath),
    version: () => call(CH.appVersion),
    openDataDir: () => call(CH.openDataDir),
    openPath: (path) => call(CH.openPath, path),
    checkUpdate: () => call(CH.appUpdateCheck),
    // v0.2.9 最后更新：应用内一键更新（下载 → 静默安装 → 自动重启）
    updateDownload: () => call(CH.appUpdateDownload),
    updateInstall: () => call(CH.appUpdateInstall),
    updateOpenReleases: () => call(CH.appUpdateOpenReleases),
    updateState: () => call(CH.appUpdateState),
    onUpdateState: (cb) => subscribe(CH.evUpdateState, cb),
    // v0.2.12：独立的更新窗口 + 重要更新强提醒
    updateOpenWindow: () => call(CH.appUpdateOpenWindow),
    updateSnooze: (version) => call(CH.appUpdateSnooze, version),
    onUpdateImportant: (cb) => subscribe(CH.evUpdateImportant, cb),
    openUrl: (url) => call(CH.appOpenUrl, url)
  },
  danmaku: {
    match: (title, episode) => call(CH.danmakuMatch, title, episode),
    comments: (episodeId) => call(CH.danmakuComments, episodeId),
    // v0.2.8：一步到位（播放器 / 本地播放共用）；opts 支持别名检测
    load: (title, episode, opts) => call(CH.danmakuLoad, title, episode, opts),
    // v0.2.8 附加：预取（只预热缓存）
    prefetch: (title, episode, opts) => call(CH.danmakuPrefetch, title, episode, opts),
    // v1.1：数据源集合器 + 弹幕盒子 + 本地弹幕库
    sources: () => call(CH.danmakuSourcesGet),
    sourcesSave: (sources) => call(CH.danmakuSourcesSet, sources),
    sourceTest: (source, keyword) => call(CH.danmakuSourceTest, source, keyword),
    boxSearch: (keyword, sourceId) => call(CH.danmakuBoxSearch, keyword, sourceId),
    boxDownload: (entry, opts) => call(CH.danmakuBoxDownload, entry, opts),
    library: (filter) => call(CH.danmakuLibList, filter),
    libraryRemove: (ids) => call(CH.danmakuLibRemove, ids),
    libraryClear: () => call(CH.danmakuLibClear),
    librarySetDir: (dir) => call(CH.danmakuLibSetDir, dir),
    libraryOpenDir: () => call(CH.danmakuLibOpenDir),
    // v1.1.2：数据源的「获取记录」（用户要求：设置里点开就能看每次去要弹幕的结果）
    fetchLog: () => call(CH.danmakuFetchLog),
    fetchLogClear: () => call(CH.danmakuFetchLogClear)
  },
  cache: {
    info: () => call(CH.cacheInfo),
    clear: () => call(CH.cacheClear),
    junkClear: () => call(CH.junkClear),
    setDir: (dir) => call(CH.cacheSetDir, dir)
  },
  saveDirs: {
    info: () => call(CH.saveDirsInfo),
    set: (patch) => call(CH.saveDirsSet, patch)
  }
}

contextBridge.exposeInMainWorld('sakana', api)

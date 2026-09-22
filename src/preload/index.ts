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
    isFullscreen: () => ipcRenderer.invoke(CH.winIsFullscreen),
    showMain: () => ipcRenderer.invoke(CH.winShowMain),
    hideTrayPanel: () => ipcRenderer.invoke(CH.winHideTrayPanel),
    openSmall: (hash, opts) => ipcRenderer.invoke(CH.winOpenSmall, hash, opts),
    isSmallWindow: process.argv.includes('--sakana-small'),
    onMaximizeChange: (cb) => subscribe<[boolean]>(CH.evWinMaximize, cb),
    onFullscreenChange: (cb) => subscribe<[boolean]>(CH.evWinFullscreen, cb)
  },
  store: {
    get: (ns) => call(CH.storeGet, ns),
    set: (ns, data) => call(CH.storeSet, ns, data)
  },
  bangumi: {
    calendar: (force) => call(CH.bgmCalendar, force),
    subject: (id) => call(CH.bgmSubject, id),
    search: (keyword) => call(CH.bgmSearch, keyword),
    ratings: (ids) => call(CH.bgmRatings, ids),
    season: (year, month, force) => call(CH.bgmSeason, year, month, force),
    testMirrors: () => call(CH.bgmTestMirrors),
    // 「最XX的角色 9宫格」：角色列表（v0 优先 + 老接口兜底）与导出用的图片 data URL
    characters: (id) => call(CH.bgmCharacters, id),
    // v0.3.0：按标题用 Jikan（MAL）取角色（工具里可切换的数据源，主进程侧统一节流）
    charactersJikan: (title) => call(CH.bgmCharactersJikan, title),
    imageDataUrl: (url) => call(CH.bgmImageDataUrl, url)
  },
  mikan: {
    search: (keyword) => call(CH.mikanSearch, keyword),
    checkSub: (subId) => call(CH.mikanCheckSub, subId),
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
    bar: (payload) => call(CH.playerUoscBar, payload)
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
    onState: (cb) => subscribe(CH.overlayState, cb),
    onPoke: (cb) => subscribe<[]>(CH.overlayPoke, cb),
    onAction: (cb) => subscribe(CH.overlayAction, cb)
  },
  tools: {
    import: () => call(CH.toolImport),
    list: () => call(CH.toolList),
    remove: (id) => call(CH.toolRemove, id),
    run: (id) => call(CH.toolRun, id),
    exportDocs: (format) => call(CH.toolExportDocs, format)
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
    pickSubtitle: () => call(CH.dialogPickSubtitle),
    pickDir: (defaultPath) => call(CH.pickDir, defaultPath),
    pickVideo: () => call(CH.dialogPickVideo),
    pickVideoDir: () => call(CH.dialogPickVideoDir)
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
    prefetch: (title, episode, opts) => call(CH.danmakuPrefetch, title, episode, opts)
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

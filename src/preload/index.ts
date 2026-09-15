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
    testMirrors: () => call(CH.bgmTestMirrors)
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
    onChanged: (cb) => subscribe(CH.evDownloads, cb)
  },
  rules: {
    search: (ruleId, keyword) => call(CH.rulesSearch, ruleId, keyword),
    episodes: (ruleId, entry) => call(CH.rulesEpisodes, ruleId, entry),
    play: (ruleId, entry, lineIndex, episodeIndex, episodeLink, vars) =>
      call(CH.rulesPlay, ruleId, entry, lineIndex, episodeIndex, episodeLink, vars)
  },
  media: {
    listVideos: (folder) => call(CH.mediaListVideos, folder),
    inspect: (path) => call(CH.mediaInspect, path),
    startLive: (path, opts) => call(CH.mediaStartLive, path, opts),
    stopLive: (sessionId) => call(CH.mediaStopLive, sessionId),
    startLiveUrl: (url, opts) => call(CH.mediaStartLiveUrl, url, opts)
  },
  vlc: {
    attach: (bounds) => call(CH.vlcAttach, bounds),
    play: (path, referer, cookies) => call(CH.vlcPlay, path, referer, cookies),
    setPlaylist: (paths) => call(CH.vlcSetPlaylist, paths),
    togglePause: () => call(CH.vlcTogglePause),
    seek: (sec) => call(CH.vlcSeek, sec),
    setVolume: (volume) => call(CH.vlcSetVolume, volume),
    getState: () => call(CH.vlcGetState),
    setMute: (muted) => call(CH.vlcSetMute, muted),
    subtitleTracks: () => call(CH.vlcSubtitleTracks),
    setSubtitle: (id) => call(CH.vlcSetSubtitle, id),
    addSubtitleFile: (path) => call(CH.vlcAddSubtitleFile, path),
    snapshot: (title) => call(CH.vlcSnapshot, title),
    detach: () => call(CH.vlcDetach),
    notifyLayout: (bounds) => call(CH.vlcNotifyLayout, bounds),
    setAspect: (mode, areaW, areaH) => call(CH.vlcSetAspect, mode, areaW, areaH),
    onEvent: (cb) => subscribe(CH.evVlc, cb)
  },
  overlay: {
    isOverlay: process.argv.includes('--sakana-overlay'),
    show: () => call(CH.overlayShow),
    hide: () => call(CH.overlayHide),
    setInteractive: (interactive) => call(CH.overlaySetSpace, interactive),
    // 高频消息用 send：状态下行、动作上行、鼠标唤出
    pushState: (state) => ipcRenderer.send(CH.overlayState, state),
    setEpisodes: (payload) => ipcRenderer.send(CH.overlayEpisodes, payload),
    onEpisodes: (cb) => subscribe(CH.overlayEpisodes, cb),
    poke: () => ipcRenderer.send(CH.overlayPoke),
    action: (action) => ipcRenderer.send(CH.overlayAction, action),
    onState: (cb) => subscribe(CH.overlayState, cb),
    onPoke: (cb) => subscribe<[]>(CH.overlayPoke, cb),
    onAction: (cb) => subscribe(CH.overlayAction, cb)
  },
  player: {
    screenshot: (title) => call(CH.playerScreenshot, title),
    assets: () => call(CH.playerAssets),
    streamInfo: () => call(CH.playerStreamInfo)
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
    onEvent: (cb) => subscribe(CH.evGal, cb)
  },
  stat: {
    exportImage: (listId) => call(CH.statExportImage, listId)
  },
  app: {
    dataPath: () => call(CH.appDataPath),
    version: () => call(CH.appVersion),
    openDataDir: () => call(CH.openDataDir),
    openPath: (path) => call(CH.openPath, path),
    checkUpdate: () => call(CH.appUpdateCheck),
    openUrl: (url) => call(CH.appOpenUrl, url)
  },
  danmaku: {
    match: (title, episode) => call(CH.danmakuMatch, title, episode),
    comments: (episodeId) => call(CH.danmakuComments, episodeId)
  },
  cache: {
    info: () => call(CH.cacheInfo),
    clear: () => call(CH.cacheClear),
    junkClear: () => call(CH.junkClear),
    setDir: (dir) => call(CH.cacheSetDir, dir)
  },
  navBg: {
    get: () => call(CH.navBgGet),
    set: (path) => call(CH.navBgSet, path),
    pick: () => call(CH.navBgPick)
  },
  saveDirs: {
    info: () => call(CH.saveDirsInfo),
    set: (patch) => call(CH.saveDirsSet, patch)
  }
}

contextBridge.exposeInMainWorld('sakana', api)

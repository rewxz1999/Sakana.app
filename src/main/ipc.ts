import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { CH } from '@shared/channels'
import type {
  AddDownloadInput,
  GalRecentShot,
  GalToolsConfig,
  SubHistoryItem,
  SubscribeAndDownloadInput,
  Subscription
} from '@shared/types'
import type { SaveDirsInfo } from '@shared/api'
import { safeName } from './lib/parse'
import { log } from './log'
import { store } from './store'
import { bangumi } from './services/bangumi'
import { mikan } from './services/mikan'
import { downloadManager } from './services/downloader/manager'
import { aria2 } from './services/downloader/aria2'
import { listVideos } from './services/media'
import { ruleEpisodes, rulePlay, ruleSearch, rulesRepoImport, rulesRepoIndex } from './services/rules'
import {
  getCachedStreamOrWait,
  prefetchStream,
  rememberStream,
  startRuleProbe,
  stopRuleProbe
} from './services/ruleProbe'
import { closeRuleWebview, currentRuleWebviewGen, openRuleWebview, setRuleWebviewBounds } from './services/ruleWebview'
import { mpvRuntimeAvailable } from './services/mpv'
import { buildStreamInfo } from './services/playerInfo'
import { checkUpdate, REPO_URL } from './services/updater'
import { fetchDanmaku, matchDanmaku } from './services/danmaku'
import { saveDirsInfo, setSaveDirs } from './services/saveDirs'
import { ffmpegExe, inspectMedia, startLive, startLiveUrl, stopLive } from './services/transcode'
import { resolveVlcDir } from './services/vlc'
import {
  engineAddSubtitleFile,
  engineAttach,
  engineDetach,
  engineGetState,
  engineNotifyLayout,
  enginePlay,
  engineSeekSec,
  engineSetAspect,
  engineSetMute,
  engineSetPlaylist,
  engineSetSubtitle,
  engineSetVolume,
  engineSnapshot,
  engineSubtitleTracks,
  engineTogglePause
} from './services/playerEngine'
import {
  destroyOverlay,
  pokeOverlay,
  pushOverlayEpisodes,
  pushOverlayState,
  sendOverlayAction,
  setOverlayInteractive,
  showOverlay
} from './services/playerOverlay'
import { toolService } from './services/tools'
import { listSubscriptions, mutateSubscriptions } from './services/subsStore'
import { hidePanelNow } from './tray'
import { focusedOrMain, getMainWindow, openSmallWindow } from './window'
import {
  galApplyYmgal as galApplyYmgalFn,
  galImport as galImportFn,
  galLaunch as galLaunchFn,
  galPushRunning,
  galSearchYmgal as galSearchYmgalFn,
  galUpdateDetail as galUpdateDetailFn,
  galgameService
} from './services/galgame'
import {
  galPickDir,
  galScreenshotNow,
  galToolsCleanup,
  galToolsGet,
  galToolsInit,
  galToolsSet
} from './services/galgameTools'
import { statExportImage } from './services/statExport'
import { maybeShowSaveHint } from './services/onboarding'
import { ensureSaveDirs } from './services/saveDirs'
import { clearCache, clearJunk, getCacheBytes, pickDirectory, pickNavBgImage, setCacheDir } from './services/settingsExt'

function focused(): BrowserWindow | undefined {
  // focusedOrMain 会排除离屏取数窗口：否则对话框可能被挂到一个不可见的窗口上
  return focusedOrMain() ?? undefined
}

function addSubHistory(kind: SubHistoryItem['kind'], title: string, detail: string): void {
  const list = store.get<SubHistoryItem[]>('subHistory', [])
  list.unshift({ id: randomUUID(), kind, title, detail, at: Date.now() })
  store.set('subHistory', list.slice(0, 500))
}

export function registerIpc(): void {
  // ---------- 窗口控制 ----------
  ipcMain.handle(CH.winMinimize, () => focused()?.minimize())
  ipcMain.handle(CH.winMaximizeToggle, () => {
    const w = focused()
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle(CH.winClose, () => focused()?.close())
  ipcMain.handle(CH.winIsMaximized, () => !!focused()?.isMaximized())
  ipcMain.handle(CH.winSetFullscreen, (_e, full: boolean) => focused()?.setFullScreen(full))
  ipcMain.handle(CH.winIsFullscreen, () => !!focused()?.isFullScreen())
  ipcMain.handle(CH.winShowMain, () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  ipcMain.handle(CH.winHideTrayPanel, () => hidePanelNow())
  ipcMain.handle(CH.winOpenSmall, (_e, hash: string, opts?: { width?: number; height?: number; title?: string }) => {
    openSmallWindow(hash, opts)
  })

  // ---------- 存储 ----------
  ipcMain.handle(CH.storeGet, (_e, ns: string) => store.get(ns, null))
  ipcMain.handle(CH.storeSet, (_e, ns: string, data: unknown) => {
    store.set(ns, data)
    return true
  })

  // ---------- bangumi 数据源 ----------
  ipcMain.handle(CH.bgmCalendar, (_e, force?: boolean) => bangumi.calendar(!!force))
  ipcMain.handle(CH.bgmSubject, (_e, id: number) => bangumi.subject(id))
  ipcMain.handle(CH.bgmSearch, (_e, keyword: string) => bangumi.search(keyword))
  ipcMain.handle(CH.bgmRatings, (_e, ids: number[]) => bangumi.ratings(ids))
  ipcMain.handle(CH.bgmTestMirrors, () => bangumi.testMirrors())

  // ---------- 蜜柑计划 ----------
  ipcMain.handle(CH.mikanSearch, (_e, keyword: string) => mikan.search(keyword))
  ipcMain.handle(CH.mikanCheckSub, async (_e, subId: string) => {
    const sub = store.get<Subscription[]>('subscriptions', []).find((s) => s.id === subId)
    if (!sub) throw new Error('订阅不存在')
    return mikan.checkSub(sub)
  })
  ipcMain.handle(CH.mikanCheckAll, async () => {
    const updates = await mikan.checkAllSubscriptions()
    if (updates.length > 0) {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send(CH.evSubUpdates, updates)
      }
    }
    return updates
  })

  // ---------- 下载 ----------
  ipcMain.handle(CH.dlAdd, (_e, input: AddDownloadInput) => downloadManager.add(input))

  /** 创建/更新订阅（与下载组合操作共用） */
  function upsertSubscription(input: SubscribeAndDownloadInput): Subscription {
    const subs = listSubscriptions()
    const existing = subs.find((s) => s.subjectId === input.subjectId)
    if (existing) {
      const updated: Subscription = {
        ...existing,
        group: input.mikanItem.group ?? existing.group,
        episode: Math.max(existing.episode ?? 0, input.mikanItem.episode ?? 0),
        lastPubDate: input.mikanItem.pubDate || existing.lastPubDate
      }
      mutateSubscriptions((list) => list.map((s) => (s.id === existing.id ? updated : s)))
      return updated
    }
    const created: Subscription = {
      id: randomUUID(),
      subjectId: input.subjectId,
      name: input.name,
      nameCn: input.nameCn,
      cover: input.cover,
      group: input.mikanItem.group,
      episode: input.mikanItem.episode,
      status: 'updating',
      lastPubDate: input.mikanItem.pubDate,
      folder: null,
      mikanKeyword: input.nameCn || input.name,
      createdAt: Date.now()
    }
    mutateSubscriptions((list) => [...list, created])
    addSubHistory('subscribe', input.nameCn || input.name, `订阅字幕组: ${input.mikanItem.group ?? '未识别'}`)
    return created
  }

  ipcMain.handle(CH.dlSubscribeAndDownload, async (_e, input: SubscribeAndDownloadInput) => {
    const subscription = upsertSubscription(input)
    const task = await downloadManager.add({
      subscriptionId: subscription.id,
      subjectId: input.subjectId,
      animeTitle: subscription.nameCn || subscription.name,
      episode: input.mikanItem.episode,
      group: input.mikanItem.group,
      name: input.mikanItem.title,
      cover: input.cover,
      magnet: input.mikanItem.magnet ?? undefined,
      torrentUrl: input.mikanItem.torrentUrl ?? undefined,
      pubDate: input.mikanItem.pubDate
    })
    addSubHistory('download', subscription.nameCn || subscription.name, `开始下载: ${safeName(input.mikanItem.title)}`)
    return { subscription, task }
  })
  ipcMain.handle(CH.dlSubscribeOnly, async (_e, input: SubscribeAndDownloadInput) => {
    const subscription = upsertSubscription(input)
    addSubHistory('subscribe', subscription.nameCn || subscription.name, `订阅字幕组: ${input.mikanItem.group ?? '未识别'}`)
    log.append('info', 'subs', `仅订阅: ${subscription.nameCn} (${subscription.group ?? '未识别字幕组'})`)
    return { subscription, task: null }
  })
  // ---------- 订阅（唯一写入方在主进程，写后广播） ----------
  ipcMain.handle(CH.subsList, () => listSubscriptions())
  ipcMain.handle(CH.subsRemove, (_e, id: string) =>
    mutateSubscriptions((list) => list.filter((s) => s.id !== id))
  )
  ipcMain.handle(CH.subsSetFolder, (_e, id: string, folder: string) =>
    mutateSubscriptions((list) => list.map((s) => (s.id === id ? { ...s, folder } : s)))
  )
  ipcMain.handle(
    CH.subsMarkUpdated,
    (_e, id: string, episode: number, lastPubDate: string) =>
      mutateSubscriptions((list) =>
        list.map((s) =>
          s.id === id ? { ...s, episode, lastPubDate, status: 'complete' as const } : s
        )
      )
  )
  ipcMain.handle(CH.dlPause, (_e, id: string) => downloadManager.pause(id))
  ipcMain.handle(CH.dlResume, (_e, id: string) => downloadManager.resume(id))
  ipcMain.handle(CH.dlRetry, (_e, id: string) => downloadManager.retry(id))
  ipcMain.handle(CH.dlRemove, (_e, id: string) => downloadManager.remove(id))
  ipcMain.handle(CH.dlList, () => downloadManager.list())
  ipcMain.handle(CH.dlStatus, () => downloadManager.test())
  ipcMain.handle(CH.dlTest, () => downloadManager.test())

  // ---------- 播放规则引擎 ----------
  ipcMain.handle(CH.rulesSearch, (_e, ruleId: string, keyword: string) => ruleSearch(ruleId, keyword))
  ipcMain.handle(CH.rulesEpisodes, (_e, ruleId: string, entry) => ruleEpisodes(ruleId, entry))
  ipcMain.handle(
    CH.rulesPlay,
    (_e, ruleId: string, entry, lineIndex: number, episodeIndex: number, episodeLink: string, vars: Record<string, string>) =>
      rulePlay(ruleId, entry, lineIndex, episodeIndex, episodeLink, vars)
  )
  /*
   * v0.2.7 附加：直链会话缓存（加速进入播放与切集）。
   * 播放器优先用缓存直链，命中就跳过整轮嗅探；正在预取时会短暂等一下（最多 2.5 秒），
   * 于是「详情页点选集 → 跳转播放页」这段路上预取就已经把直链准备好了。
   */
  ipcMain.handle(CH.rulesCachedStream, (_e, pageUrl: string) => getCachedStreamOrWait(pageUrl))
  ipcMain.handle(CH.rulesRememberStream, (_e, pageUrl: string, url: string, referer?: string) => {
    rememberStream(pageUrl, url, referer)
    return true
  })
  ipcMain.handle(
    CH.rulesPrefetchStream,
    async (
      _e,
      ruleId: string,
      entry,
      lineIndex: number,
      episodeIndex: number,
      episodeLink: string,
      vars: Record<string, string>
    ) => {
      // 先解析出该集的播放页地址（与真实播放同一条路），再做「直出解析 + 校验」入缓存
      const play = await rulePlay(ruleId, entry, lineIndex, episodeIndex, episodeLink, vars)
      if (!play?.url) return null
      const stream = await prefetchStream(play.url, play.referer)
      // 连播放页地址一起返回：切集时可直接复用，省掉一次 play 解析
      return { pageUrl: play.url, url: stream?.url ?? null, referer: stream?.referer ?? play.referer }
    }
  )
  // 规则仓库导入（KazumiRules 镜像优先）
  ipcMain.handle(CH.rulesRepoIndex, () => rulesRepoIndex())
  ipcMain.handle(CH.rulesRepoImport, (_e, names: string[]) => rulesRepoImport(names))
  // 播放页流嗅探（隐藏窗口捕获 m3u8/mp4 → libVLC 直连）
  ipcMain.handle(CH.ruleProbeStart, (_e, url: string, referer?: string) => {
    const w = getMainWindow()
    if (!w) return false
    return startRuleProbe(w, url, referer)
  })
  ipcMain.handle(CH.ruleProbeStop, () => {
    stopRuleProbe()
    return true
  })
  // Kazumi 式在线播放：可见网页视图嗅探
  ipcMain.handle(
    CH.ruleWebviewOpen,
    (
      e,
      url: string,
      bounds: { x: number; y: number; width: number; height: number },
      referer?: string
    ) => {
      const w = BrowserWindow.fromWebContents(e.sender) ?? focused()
      if (!w) return false
      return openRuleWebview(w, url, bounds, referer)
    }
  )
  ipcMain.handle(
    CH.ruleWebviewBounds,
    (_e, bounds: { x: number; y: number; width: number; height: number }) => {
      setRuleWebviewBounds(bounds)
      return true
    }
  )
  ipcMain.handle(CH.ruleWebviewClose, () => {
    /*
     * 异步清理：销毁网页视图可能阻塞，退出播放时不能卡住渲染层。
     *
     * v0.2.7 附加：必须带上「请求时看到的窗口代号」——
     * 渲染层重试时会同一轮里先 close 再 open，延迟执行的 close 过去会把刚建好的
     * 新嗅探窗口一起销毁（CDP 报 target closed），于是重试永远抓不到流。
     * 带上代号后，这种「迟到的关闭」会被识别为针对旧窗口而作废。
     */
    const gen = currentRuleWebviewGen()
    setImmediate(() => closeRuleWebview(gen))
    return true
  })

  // ---------- 媒体 ----------
  ipcMain.handle(CH.mediaListVideos, (_e, folder: string) => listVideos(folder))
  ipcMain.handle(CH.mediaInspect, (_e, path: string) => inspectMedia(path))
  ipcMain.handle(
    CH.mediaStartLive,
    (
      _e,
      path: string,
      opts: {
        mode: 'vcopy' | 'vtranscode'
        startSec?: number
        height?: number | null
        videoCodec?: string | null
      }
    ) => startLive(path, opts)
  )
  ipcMain.handle(CH.mediaStopLive, (_e, sessionId: string) => {
    stopLive(sessionId)
    return true
  })
  // 在线流中转：FFmpeg 带站点会话取流并 remux，交给播放器
  ipcMain.handle(
    CH.mediaStartLiveUrl,
    (_e, url: string, opts: { referer?: string; cookies?: string; userAgent?: string }) =>
      startLiveUrl(url, opts)
  )

  // ---------- libVLC 播放器 ----------
  ipcMain.handle(CH.vlcAttach, (_e, bounds?: { x: number; y: number; width: number; height: number }) => {
    const w = focused()
    if (!w) return { ok: false, message: '窗口不存在' }
    return engineAttach(w, bounds)
  })
  ipcMain.handle(CH.vlcPlay, (_e, path: string, referer?: string, cookies?: string) => {
    enginePlay(path, referer, cookies)
    return true
  })
  ipcMain.handle(CH.vlcSetPlaylist, (_e, paths: string[]) => {
    engineSetPlaylist(paths)
    return true
  })
  ipcMain.handle(CH.vlcTogglePause, () => {
    engineTogglePause()
    return true
  })
  ipcMain.handle(CH.vlcSeek, (_e, sec: number) => {
    engineSeekSec(sec)
    return true
  })
  ipcMain.handle(CH.vlcSetVolume, (_e, volume: number) => {
    engineSetVolume(volume)
    return true
  })
  ipcMain.handle(CH.vlcGetState, () => {
    try {
      return engineGetState()
    } catch {
      return { time: 0, length: 0, playing: false, volume: 100, muted: false }
    }
  })
  ipcMain.handle(CH.vlcSetMute, (_e, muted: boolean) => {
    engineSetMute(muted)
    return true
  })
  ipcMain.handle(CH.vlcSubtitleTracks, () => engineSubtitleTracks())
  ipcMain.handle(CH.vlcSetSubtitle, (_e, id: number) => {
    engineSetSubtitle(id)
    return true
  })
  ipcMain.handle(CH.vlcAddSubtitleFile, (_e, path: string) => {
    engineAddSubtitleFile(path)
    return true
  })
  ipcMain.handle(CH.vlcSnapshot, (_e, title?: string) => {
    const settings = store.get<{ screenshotDir?: string }>('settings', {})
    const dir = settings.screenshotDir || join(app.getPath('userData'), 'screenshots')
    mkdirSync(dir, { recursive: true })
    const ts = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const timeStr = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
    // 命名规则：番剧名_时间.png（无番剧名时退回 sakana_时间.png）
    const prefix = title ? title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) : 'sakana'
    const file = join(dir, `${prefix}_${timeStr}.png`)
    engineSnapshot(file)
    log.append('info', 'player', `播放器截图已保存: ${file}`)
    maybeShowSaveHint()
    return file
  })
  ipcMain.handle(CH.vlcDetach, () => {
    // 异步销毁：libVLC 的 stop/destroy 可能阻塞主进程（表现为退出播放时界面卡死）
    setImmediate(() => engineDetach())
    return true
  })
  ipcMain.handle(CH.vlcNotifyLayout, (_e, bounds?: { x: number; y: number; width: number; height: number }) => {
    engineNotifyLayout(bounds)
    return true
  })
  ipcMain.handle(
    CH.vlcSetAspect,
    (_e, mode: 'fit' | 'cover' | 'stretch', areaW: number, areaH: number) => {
      engineSetAspect(mode, areaW, areaH)
      return true
    }
  )
  // ---------- 全屏控制栏悬浮窗 ----------
  ipcMain.handle(CH.overlayShow, () => {
    const w = focused()
    if (!w) return false
    showOverlay(w)
    return true
  })
  ipcMain.handle(CH.overlayHide, () => {
    destroyOverlay()
    return true
  })
  ipcMain.on(CH.overlayEpisodes, (_e, payload: unknown) => pushOverlayEpisodes(payload))
  ipcMain.handle(CH.overlaySetSpace, (_e, interactive: boolean) => {
    setOverlayInteractive(interactive)
    return true
  })
  // 播放页 → 悬浮窗
  ipcMain.on(CH.overlayState, (_e, state: unknown) => pushOverlayState(state))
  ipcMain.on(CH.overlayPoke, () => pokeOverlay())
  // 悬浮窗 → 播放页
  ipcMain.on(CH.overlayAction, (_e, action: Record<string, unknown>) => sendOverlayAction(action))
  ipcMain.handle(CH.playerScreenshot, async (_e, title?: string) => {
    const w = focused()
    if (!w) throw new Error('窗口不存在')
    const image = await w.webContents.capturePage()
    const settings = store.get<{ screenshotDir?: string }>('settings', {})
    const dir = settings.screenshotDir || join(app.getPath('userData'), 'screenshots')
    mkdirSync(dir, { recursive: true })
    const ts = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const timeStr = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
    // 命名规则：番剧名_时间.png
    const prefix = title ? title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) : 'sakana'
    const file = join(dir, `${prefix}_${timeStr}.png`)
    writeFileSync(file, image.toPNG())
    log.append('info', 'player', `截图已保存: ${file}`)
    maybeShowSaveHint()
    return file
  })

  // 内置组件探测：libVLC / FFmpeg / aria2 / libmpv 是否随包内置
  ipcMain.handle(CH.playerAssets, async () => ({
    vlc: resolveVlcDir() !== null,
    ffmpeg: ffmpegExe() !== null,
    aria2: (await aria2.findBinary()) !== null,
    mpv: mpvRuntimeAvailable()
  }))

  // ---------- 工具 ----------
  ipcMain.handle(CH.toolImport, () => toolService.import())
  ipcMain.handle(CH.toolList, () => toolService.list())
  ipcMain.handle(CH.toolRemove, (_e, id: string) => toolService.remove(id))
  ipcMain.handle(CH.toolRun, (_e, id: string) => toolService.run(id))
  ipcMain.handle(CH.toolExportDocs, (_e, format: 'md' | 'txt') => toolService.exportDocs(format))

  // ---------- 日志 ----------
  ipcMain.handle(CH.logList, () => log.list())
  ipcMain.handle(CH.logClear, () => {
    log.clear()
    return true
  })
  log.onPush((entry) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(CH.evLog, entry)
    }
  })

  // ---------- 对话框 ----------
  ipcMain.handle(CH.dialogPickFolder, async (_e, defaultPath?: string) => {
    const w = focused()
    if (!w) return null
    const r = await dialog.showOpenDialog(w, {
      title: '选择文件夹',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory']
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle(CH.dialogPickImages, async () => {
    const w = focused()
    if (!w) return []
    const r = await dialog.showOpenDialog(w, {
      title: '选择剧照（可选多张）',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle(CH.dialogPickSubtitle, async () => {
    const w = focused()
    if (!w) return null
    const r = await dialog.showOpenDialog(w, {
      title: '选择字幕文件',
      filters: [{ name: '字幕文件', extensions: ['srt', 'ass', 'ssa', 'vtt', 'sub'] }],
      properties: ['openFile']
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  // v0.2.4 本地播放：直接选视频文件
  ipcMain.handle(CH.dialogPickVideo, async () => {
    const w = focused()
    if (!w) return null
    const r = await dialog.showOpenDialog(w, {
      title: '选择视频文件',
      filters: [
        {
          name: '视频文件',
          extensions: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'ts', 'm4v', 'rmvb', 'wmv', 'mpg', 'mpeg']
        },
        { name: '全部文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle(CH.dialogPickVideoDir, async () => {
    const w = focused()
    if (!w) return null
    const r = await dialog.showOpenDialog(w, {
      title: '选择视频文件夹',
      properties: ['openDirectory']
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  // ---------- galgame 快捷启动器 ----------
  ipcMain.handle(CH.galImport, () => galImportFn())
  ipcMain.handle(CH.galList, () => {
    galPushRunning()
    return galgameService.list()
  })
  ipcMain.handle(CH.galRemove, (_e, id: string) => galgameService.remove(id))
  ipcMain.handle(CH.galLaunch, (_e, id: string) => galLaunchFn(id))
  ipcMain.handle(CH.galToggleFinished, (_e, id: string) => galgameService.toggleFinished(id))
  ipcMain.handle(CH.galUpdateDetail, (_e, id: string) => galUpdateDetailFn(id))
  ipcMain.handle(CH.galSearchYmgal, (_e, name: string) => galSearchYmgalFn(name))
  ipcMain.handle(CH.galApplyYmgal, (_e, id: string, ymgalId: number) => galApplyYmgalFn(id, ymgalId))
  // 自定义封面 / 背景图
  ipcMain.handle(CH.galPickImage, async () => {
    const w = focused()
    if (!w) return null
    const r = await dialog.showOpenDialog(w, {
      title: '选择图片',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
      properties: ['openFile']
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle(CH.galSetCustomImage, (_e, id: string, kind: 'cover' | 'banner', srcPath: string) =>
    galgameService.setCustomImage(id, kind, srcPath)
  )
  ipcMain.handle(CH.galClearCustomImage, (_e, id: string, kind: 'cover' | 'banner') =>
    galgameService.clearCustomImage(id, kind)
  )
  ipcMain.handle(CH.galToolsGet, () => galToolsGet())
  ipcMain.handle(CH.galToolsSet, (_e, patch: Partial<GalToolsConfig>) => galToolsSet(patch))
  ipcMain.handle(CH.galPickDir, async () => galPickDir())
  ipcMain.handle(CH.galScreenshotNow, async () => galScreenshotNow())
  ipcMain.handle(CH.galOverlayShot, async () => galScreenshotNow())
  // 最近截图：读取截图目录，返回最新 30 个图片文件
  ipcMain.handle(CH.galRecentShots, () => {
    const dir = galToolsGet().dir || join(app.getPath('userData'), 'screenshots', 'galgame')
    if (!existsSync(dir)) return [] as GalRecentShot[]
    const exts = new Set(['.png', '.jpg', '.jpeg', '.webp'])
    const out: GalRecentShot[] = []
    for (const name of readdirSync(dir)) {
      if (!exts.has(extname(name).toLowerCase())) continue
      try {
        const st = statSync(join(dir, name))
        if (!st.isFile()) continue
        out.push({ path: join(dir, name), mtime: st.mtimeMs, name })
      } catch {
        /* 忽略单个文件读取失败 */
      }
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out.slice(0, 30)
  })
  // 统计工具：导出列表为图片（自选保存位置）
  ipcMain.handle(CH.statExportImage, (_e, listId: string) => statExportImage(listId))

  // ---------- 设置页扩展：日志文件 / 数据目录 / 缓存 / 保存目录 / 导航背景 ----------
  ipcMain.handle(CH.logRead, () => {
    const pad = (n: number): string => String(n).padStart(2, '0')
    const lines = log.list().map((e) => {
      const d = new Date(e.at)
      const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      return `[${ts}] [${e.level.toUpperCase()}] [${e.source}] ${e.message}`
    })
    // 与 log.ts 的 1000 条上限保持一致，避免两处数字漂移导致「保存 1000 条却只看到 500 条」
    return lines.slice(-1000).join('\n')
  })
  ipcMain.handle(CH.appDataPath, () => app.getPath('userData'))
  ipcMain.handle(CH.appVersion, () => app.getVersion())
  ipcMain.handle(CH.openDataDir, async () => shell.openPath(app.getPath('userData')))
  ipcMain.handle(CH.openPath, async (_e, path: string) => shell.openPath(path))
  ipcMain.handle(CH.cacheInfo, () => getCacheBytes())
  ipcMain.handle(CH.cacheClear, () => clearCache())
  ipcMain.handle(CH.junkClear, () => clearJunk())
  // 自定义缓存目录：保存并 mkdir -p（'' = 恢复默认 userData/cache）
  ipcMain.handle(CH.cacheSetDir, (_e, dir: string) => setCacheDir(dir))
  ipcMain.handle(CH.navBgGet, () => store.get<{ path: string }>('navBg', { path: '' }))
  ipcMain.handle(CH.navBgSet, (_e, path: string) => {
    store.set('navBg', { path })
    return true
  })
  ipcMain.handle(CH.navBgPick, () => pickNavBgImage())
  ipcMain.handle(CH.galDirsGet, () => ({ dir: galToolsGet().dir }))
  ipcMain.handle(CH.galDirsSet, (_e, dir: string) => {
    galToolsSet({ dir })
    return { dir }
  })
  ipcMain.handle(CH.pickDir, async (_e, defaultPath?: string) => pickDirectory(defaultPath))
  ipcMain.handle(CH.saveDirsInfo, () => saveDirsInfo())
  // 保存目录改动立即生效（建目录 + 同步运行中的下载器 + 媒体白名单）
  ipcMain.handle(CH.saveDirsSet, (_e, patch: Partial<SaveDirsInfo>) => setSaveDirs(patch ?? {}))

  // ---------- v0.2.4：播放状态栏 / 更新检查 / 弹幕 ----------
  ipcMain.handle(CH.playerStreamInfo, () => buildStreamInfo())
  ipcMain.handle(CH.appUpdateCheck, () => checkUpdate(true))
  ipcMain.handle(CH.appOpenUrl, async (_e, url: string) => {
    const target = /^https?:\/\//i.test(String(url ?? '')) ? String(url) : REPO_URL
    await shell.openExternal(target)
    return true
  })
  ipcMain.handle(CH.danmakuMatch, (_e, title: string, episode: number) => matchDanmaku(title, episode))
  ipcMain.handle(CH.danmakuComments, (_e, episodeId: number) => fetchDanmaku(episodeId))

  // 自动创建未配置的保存目录（baseDir = userData/saves）
  ensureSaveDirs()
  // 启动时恢复截图助手（快捷键 + 悬浮窗）
  galToolsInit()
  // 退出前结算游玩时长并回收截图助手资源
  app.on('before-quit', () => {
    galgameService.shutdown()
    store.flushAll()
    galToolsCleanup()
  })
}

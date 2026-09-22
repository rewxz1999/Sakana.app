import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { CH } from '@shared/channels'
import type {
  AddDownloadInput,
  GalRecentShot,
  GalToolsConfig,
  LocalTargetInput,
  StatAction,
  StatEntry,
  StatExportOptions,
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
import { deleteLocalResources, localDirInfo, removeDownloadRecords } from './services/downloader/localCleanup'
import { aria2 } from './services/downloader/aria2'
import { imageDataUrl, listVideos } from './services/media'
import { ruleEpisodes, rulePlay, ruleSearch, rulesRepoImport, rulesRepoIndex } from './services/rules'
import {
  getCachedStreamOrWait,
  prefetchStream,
  rememberStream,
  startRuleProbe,
  stopRuleProbe
} from './services/ruleProbe'
import { closeRuleWebview, currentRuleWebviewGen, openRuleWebview, setRuleWebviewBounds } from './services/ruleWebview'
import { mpvRuntimeAvailable, mpvSetDanmakuSource, mpvPushDanmakuFile, uoscDanmakuRequested, mpvOpenDanmakuMenu, mpvSetUoscDanmakuVisible, mpvClearUoscDanmakuSource, mpvPushDanmakuDelay, uoscDanmakuActive, mpvUoscDanmakuLoaded, mpvPluginDanmakuPending, mpvPushUoscBar, uoscControlBarActive, uoscControlBarRequested, mpvApplyVideoEnhance, anime4kAvailable, anime4kShaderFiles } from './services/mpv'
import { buildStreamInfo } from './services/playerInfo'
import {
  checkUpdate,
  downloadUpdate,
  installUpdate,
  onUpdateInstallState,
  openReleases,
  REPO_URL,
  snoozeImportantUpdate,
  updateInstallState
} from './services/updater'
import { fetchDanmaku, loadDanmaku, matchDanmaku, prefetchDanmaku, writeDanmakuXml } from './services/danmaku'
// v0.3.0：Jikan（MAL）作为角色立绘的备用数据源（带 3 次/秒、60 次/分钟节流）
import { jikanCharactersByTitle } from './services/jikan'
import { saveDirsInfo, setSaveDirs } from './services/saveDirs'
import { ffmpegExe, inspectMedia, startLive, startLiveUrl, stopLive } from './services/transcode'
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
  engineSetSpeed,
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
  pushOverlayDanmaku,
  pushOverlayState,
  sendOverlayAction,
  setOverlayInteractive,
  showOverlay
} from './services/playerOverlay'
import { toolService } from './services/tools'
import { listSubscriptions, mutateSubscriptions } from './services/subsStore'
import { hidePanelNow } from './tray'
import { focusedOrMain, getMainWindow, openSmallWindow, openUpdateWindow } from './window'
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
  galListShots,
  galPickDir,
  galRecentShots,
  galScreenshotNow,
  galToolsCleanup,
  galToolsGet,
  galToolsInit,
  galToolsSet
} from './services/galgameTools'
import { galSearchSites } from './services/galgameSearch'
import { statExportImage } from './services/statExport'
import { applyStatAction, readStatData, statWatchProgressFor } from './services/statStore'
import { listStatShots, statShotsDirToOpen } from './services/statShots'
import { maybeShowSaveHint } from './services/onboarding'
import { ensureSaveDirs } from './services/saveDirs'
import { clearCache, clearJunk, getCacheBytes, importShowcaseImages, pickDirectory, setCacheDir } from './services/settingsExt'

function focused(): BrowserWindow | undefined {
  // focusedOrMain 会排除离屏取数窗口：否则对话框可能被挂到一个不可见的窗口上
  return focusedOrMain() ?? undefined
}

function addSubHistory(kind: SubHistoryItem['kind'], title: string, detail: string): void {
  const list = store.get<SubHistoryItem[]>('subHistory', [])
  list.unshift({ id: randomUUID(), kind, title, detail, at: Date.now() })
  store.set('subHistory', list.slice(0, 500))
}

/**
 * 播放器截图路径（v0.2.9，用户指定的新规则）。
 *
 * - **目录**：`<截图目录>/<番剧名>图片/` —— 每部番剧一个文件夹，
 *   否则上百张截图全堆在根目录里没法找（用户明确要求「文件夹名字为番剧名+图片」）；
 * - **文件名**：`<番剧名>_<集数>_<分.秒>.png`，例如 `无职转生_12_17.26.png`
 *   （`17.26` = 第 12 集播到 17 分 26 秒）；
 * - 时间取**内核当前播放位置**而不是墙上时间 —— 用户要的是「当前播放集的几分几秒」，
 *   用系统时间的话同一集的截图完全无法按剧情定位；
 *   注意 `engineGetState().time` 的单位是**毫秒**（原生插件里是 `time-pos * 1000`），
 *   这里必须除以 1000 再换算「分.秒」—— 第一版漏了这步，截出来是 `282.13` 这种离谱值；
 * - 集数未知（本地文件没解析出集数）时省略该段，退化成 `<番剧名>_<分.秒>.png`。
 */
function snapshotPath(title?: string, episode?: number): string {
  const settings = store.get<{ screenshotDir?: string }>('settings', {})
  const root = settings.screenshotDir || join(app.getPath('userData'), 'screenshots')
  const safe = (s: string): string => s.replace(/[\\/:*?"<>|]/g, '_').trim()
  const name = title ? safe(title).slice(0, 60) || 'sakana' : 'sakana'
  const dir = join(root, `${name}图片`)
  mkdirSync(dir, { recursive: true })
  const st = engineGetState()
  const sec = Math.max(0, Math.floor((st?.time ?? 0) / 1000))
  const stamp = `${Math.floor(sec / 60)}.${String(sec % 60).padStart(2, '0')}`
  const ep = episode && episode > 0 ? `_${episode}` : ''
  return join(dir, `${name}${ep}_${stamp}.png`)
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
    /*
     * v0.3.1：设置里带播放画质项（Anime4K 模式/着色器链、饱和度对比度、HDR…），
     * 而这些项对 mpv 都是**运行时属性**，所以在这里顺手重应用一次 ——
     * 用户改完设置立刻能看到画面变化，不必退出播放页再进来。
     * 只在播放器实例存在时才有实际动作（mpvApplyVideoEnhance 自己会判 ready）。
     */
    if (ns === 'settings') mpvApplyVideoEnhance()
    return true
  })

  // ---------- bangumi 数据源 ----------
  ipcMain.handle(CH.bgmCalendar, (_e, force?: boolean) => bangumi.calendar(!!force))
  ipcMain.handle(CH.bgmSubject, (_e, id: number) => bangumi.subject(id))
  ipcMain.handle(CH.bgmSearch, (_e, keyword: string) => bangumi.search(keyword))
  ipcMain.handle(CH.bgmRatings, (_e, ids: number[]) => bangumi.ratings(ids))
  ipcMain.handle(CH.bgmSeason, (_e, year: number, month: number, force?: boolean) =>
    bangumi.season(Number(year), Number(month), !!force)
  )
  ipcMain.handle(CH.bgmTestMirrors, () => bangumi.testMirrors())
  // 「最XX的角色 9宫格」：角色列表（v0 优先 + 老接口兜底）与导出用的图片 data URL
  ipcMain.handle(CH.bgmCharacters, (_e, id: number) => bangumi.characters(Number(id)))
  /*
   * v0.3.0：按**标题**用 Jikan（MAL）取角色 —— 「最XX的角色 9宫格」可以切换到这个数据源，
   * 目的是拿到更清晰的立绘（Bangumi 的角色图不少只有 250x300）。
   *
   * 为什么按标题而不是 id：我们的条目 id 是 Bangumi 的，Jikan 认 MAL id，两套 id 体系不通，
   * 标题是唯一可靠的桥。Jikan 限制 3 次/秒、60 次/分钟，节流统一在 services/jikan.ts 里做。
   */
  ipcMain.handle(CH.bgmCharactersJikan, async (_e, title: string) => {
    const r = await jikanCharactersByTitle(String(title ?? ''))
    return {
      title: String(title ?? ''),
      /** 复用 Bangumi 的角色结构，渲染层不用分支处理 */
      items: r.characters.map((c) => ({
        id: c.id,
        name: c.name,
        name_cn: c.nameCn,
        relation: c.relation,
        images: c.images
      })),
      source: 'jikan' as const,
      animeTitle: r.anime?.title ?? '',
      malId: r.anime?.malId ?? 0
    }
  })
  /*
   * 图片 → data URL。必须走主进程：渲染层直接用 sakana-img:// 画 canvas 会污染画布，
   * toBlob() 会抛 SecurityError（导出整条链路断在这里），data URL 则永不污染。
   */
  ipcMain.handle(CH.bgmImageDataUrl, (_e, url: string) => imageDataUrl(String(url ?? '')))

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

  // ---------- 本地资源（自动推导下载目录 / 删除本地资源 / 只删下载记录） ----------
  /** 卡片上的「本地播放」先问这里：目录自动推导，不再弹文件夹选择框 */
  ipcMain.handle(CH.dlLocalDir, (_e, input: LocalTargetInput) => localDirInfo(input))
  /**
   * 删除本地资源：磁盘文件 + 下载记录 + 订阅集数复位（界面已做二次确认）。
   * 删除明细写进运行日志（订阅历史是给用户看的「订阅/下载」流水，不适合塞路径）。
   */
  ipcMain.handle(CH.dlDeleteLocal, (_e, input: LocalTargetInput) => deleteLocalResources(input))
  /** 只删下载记录，绝不删文件 */
  ipcMain.handle(CH.dlRemoveRecords, (_e, input: { animeTitle?: string; ids?: string[] }) =>
    removeDownloadRecords(input)
  )

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
  // 播放页流嗅探（隐藏窗口捕获 m3u8/mp4 → 交给 libmpv 直连）
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

  // ---------- 播放内核（libmpv） ----------
  ipcMain.handle(CH.playerAttach, (_e, bounds?: { x: number; y: number; width: number; height: number }) => {
    const w = focused()
    if (!w) return { ok: false, message: '窗口不存在' }
    return engineAttach(w, bounds)
  })
  ipcMain.handle(CH.playerPlay, (_e, path: string, referer?: string, cookies?: string) => {
    enginePlay(path, referer, cookies)
    return true
  })
  ipcMain.handle(CH.playerSetPlaylist, (_e, paths: string[]) => {
    engineSetPlaylist(paths)
    return true
  })
  ipcMain.handle(CH.playerTogglePause, () => {
    engineTogglePause()
    return true
  })
  ipcMain.handle(CH.playerSeek, (_e, sec: number) => {
    engineSeekSec(sec)
    return true
  })
  ipcMain.handle(CH.playerSetVolume, (_e, volume: number) => {
    engineSetVolume(volume)
    return true
  })
  ipcMain.handle(CH.playerGetState, () => {
    try {
      return engineGetState()
    } catch {
      return { time: 0, length: 0, playing: false, volume: 100, muted: false }
    }
  })
  // v0.2.9 最后更新：播放倍速（0.25–4）
  ipcMain.handle(CH.playerSetSpeed, (_e, speed: number) => {
    engineSetSpeed(speed)
    return true
  })
  ipcMain.handle(CH.playerSetMute, (_e, muted: boolean) => {
    engineSetMute(muted)
    return true
  })
  ipcMain.handle(CH.playerSubtitleTracks, () => engineSubtitleTracks())
  ipcMain.handle(CH.playerSetSubtitle, (_e, id: number) => {
    engineSetSubtitle(id)
    return true
  })
  ipcMain.handle(CH.playerAddSubtitleFile, (_e, path: string) => {
    engineAddSubtitleFile(path)
    return true
  })
  ipcMain.handle(CH.playerSnapshot, (_e, title?: string, episode?: number) => {
    const file = snapshotPath(title, episode)
    engineSnapshot(file)
    log.append('info', 'player', `播放器截图已保存: ${file}`)
    maybeShowSaveHint()
    return file
  })
  ipcMain.handle(CH.playerDetach, () => {
    // 异步销毁：内核的 stop/destroy 可能阻塞主进程（表现为退出播放时界面卡死）
    setImmediate(() => engineDetach())
    return true
  })
  ipcMain.handle(CH.playerNotifyLayout, (_e, bounds?: { x: number; y: number; width: number; height: number }) => {
    engineNotifyLayout(bounds)
    return true
  })
  ipcMain.handle(
    CH.playerSetAspect,
    (_e, mode: 'fit' | 'cover' | 'stretch') => {
      engineSetAspect(mode)
      return true
    }
  )
  // v0.2.8 附加七：把播放页地址告知 mpv 的 B 站弹幕脚本（我们播的是直链，脚本无法自行反推页面）
  ipcMain.handle(CH.playerDanmakuSource, (_e, pageUrl: string) => {
    mpvSetDanmakuSource(pageUrl)
    return true
  })
  /*
   * v0.2.9：uosc_danmaku（mpv 弹幕插件）集成。
   * 渲染层只发「语义」，插件真正的能力（菜单、搜索、样式、延迟）由它自己实现 ——
   * 这样上游插件更新时我们只需要替换资源目录，不用改业务代码。
   */
  ipcMain.handle(CH.playerUoscStatus, () => ({
    requested: uoscDanmakuRequested(),
    active: uoscDanmakuActive(),
    // v2.1.0 没有「条数」属性，只有 has-danmaku 布尔值：够用来判断插件到底有没有把弹幕挂上
    loaded: mpvUoscDanmakuLoaded(),
    // 有弹幕在排队等 mpv 载入文件：渲染层此时应当「再等等」而不是回落到画布
    pending: mpvPluginDanmakuPending(),
    // v0.2.18：uosc 本体（控制栏）是否挂上了 —— 渲染层据此决定要不要回落到旧控制栏
    bar: uoscControlBarRequested() && uoscControlBarActive()
  }))
  ipcMain.handle(CH.playerUoscMenu, (_e, which: 'search' | 'total' | 'style' | 'delay' | 'add') =>
    mpvOpenDanmakuMenu(which)
  )
  ipcMain.handle(CH.playerUoscVisible, (_e, on: boolean) => mpvSetUoscDanmakuVisible(Boolean(on)))
  ipcMain.handle(CH.playerUoscClear, () => {
    mpvClearUoscDanmakuSource()
    return true
  })
  ipcMain.handle(CH.playerUoscDelay, (_e, offsetMs: number) => {
    mpvPushDanmakuDelay(offsetMs)
    return true
  })
  /*
   * v0.2.18：uosc 控制栏的状态下行。
   * 播放页把「选集/线路/字幕/倍速/比例/弹幕设置」推过来，主进程按内容去重后
   * 交给 mpv 侧的 sakana-uosc-ctrl.lua —— 它据此刷新按钮与菜单。
   * 反向的动作（点按钮 / 菜单项 / input.conf 快捷键）走 user-data/sakana-ctrl 轮询，
   * 在主进程里直接派发成 OverlayAction（见 mpv.ts 的 pollUoscCtrl），不经过本文件。
   */
  ipcMain.handle(CH.playerUoscBar, (_e, payload: unknown) => mpvPushUoscBar(payload))
  // ---------- 全屏控制栏悬浮窗 ----------
  /*
   * v0.2.8 附加 修「控制栏按钮点了没反应」：
   * 这里过去用 `focused()`（当前聚焦窗口）当悬浮窗的 owner ——
   * 一旦此刻聚焦的是别的小窗口（例如刚打开的「弹幕设置」），
   * 悬浮窗的控制栏动作就会**发到那个窗口**上，而它没有播放器，于是所有按钮都像失灵。
   * 现在改为认「发起请求的窗口」（也就是播放页所在窗口）：
   * `BrowserWindow.fromWebContents(e.sender)`。
   */
  ipcMain.handle(CH.overlayShow, (e) => {
    const w =
      BrowserWindow.fromWebContents(e.sender) ?? focused() ?? getMainWindow() ?? undefined
    if (!w) return { ok: false, gen: 0 }
    const gen = showOverlay(w)
    return { ok: true, gen }
  })
  ipcMain.handle(CH.overlayHide, (_e, gen?: number) => {
    destroyOverlay(gen)
    return true
  })
  ipcMain.on(CH.overlayEpisodes, (_e, payload: unknown) => pushOverlayEpisodes(payload))
  // v0.2.8：弹幕数据 / 设置（换集或改设置时推一次）
  ipcMain.on(CH.overlayDanmaku, (_e, payload: unknown) => pushOverlayDanmaku(payload))
  ipcMain.handle(CH.overlaySetSpace, (_e, interactive: boolean) => {
    setOverlayInteractive(interactive)
    return true
  })
  // 播放页 → 悬浮窗
  ipcMain.on(CH.overlayState, (_e, state: unknown) => pushOverlayState(state))
  ipcMain.on(CH.overlayPoke, () => pokeOverlay())
  // 悬浮窗 → 播放页
  ipcMain.on(CH.overlayAction, (_e, action: Record<string, unknown>) => sendOverlayAction(action))
  ipcMain.handle(CH.playerScreenshot, async (_e, title?: string, episode?: number) => {
    const w = focused()
    if (!w) throw new Error('窗口不存在')
    const image = await w.webContents.capturePage()
    const file = snapshotPath(title, episode)
    writeFileSync(file, image.toPNG())
    log.append('info', 'player', `截图已保存: ${file}`)
    maybeShowSaveHint()
    return file
  })

  // 内置组件探测：libmpv / FFmpeg / aria2 是否随包内置
  ipcMain.handle(CH.playerAssets, async () => ({
    ffmpeg: ffmpegExe() !== null,
    aria2: (await aria2.findBinary()) !== null,
    mpv: mpvRuntimeAvailable(),
    // v0.3.1：Anime4K 着色器是否随包内置（设置页据此显示/隐藏画质卡片与自定义列表）
    anime4k: anime4kAvailable(),
    shaders: anime4kShaderFiles()
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
  /*
   * 搜索页展示位（空态轮播图）：把 pickImages 返回的图片复制到应用数据目录后回传新路径。
   * 不直接改 dialogPickImages：那个通道还被「统计工具 → 剧照」用来挑系统目录里的原图，
   * 给它加上「偷偷复制一份」的副作用会打乱那边的语义（同一张图会有两个路径）。
   */
  ipcMain.handle(CH.showcaseImportImages, (_e, paths: string[]) =>
    importShowcaseImages(Array.isArray(paths) ? paths.map((p) => String(p)) : [])
  )
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
  // 最近截图：截图目录 + 各游戏子目录里最新的 30 张（兼容旧版直接放在根目录的截图）
  ipcMain.handle(CH.galRecentShots, () => galRecentShots(30))
  // 某款游戏自己的截图：只读 <截图目录>/<游戏名>/，供游戏卡片上的「最近截图」使用
  ipcMain.handle(CH.galListShots, (_e, gameName: string) => galListShots(String(gameName ?? '')))
  // 站点搜索统计：并行查 7 个资源站，只回「数量 + 跳转链接」，绝不回传站点内容
  ipcMain.handle(CH.galSearchSites, (_e, keyword: string) => galSearchSites(String(keyword ?? '')))
  // 统计工具：导出列表为图片（自选保存位置 + 勾选要导出的字段）
  ipcMain.handle(CH.statExportImage, (_e, listId: string, opts?: StatExportOptions) =>
    statExportImage(String(listId ?? ''), opts)
  )
  // 统计工具：主进程为唯一写入方（读全量 / 发一个写动作，改完广播 ev:stat）
  ipcMain.handle(CH.statGet, () => readStatData())
  ipcMain.handle(CH.statApply, (_e, action: StatAction) => applyStatAction(action))
  // 详情窗口：剧照图库（读番剧截图目录，不复制文件）
  ipcMain.handle(CH.statShots, (_e, entry: StatEntry) => listStatShots(entry))
  ipcMain.handle(CH.statShotsOpenDir, async (_e, entry: StatEntry) => {
    const dir = statShotsDirToOpen(entry)
    const err = await shell.openPath(dir)
    // openPath 失败时返回错误字符串（空串 = 成功），原样回给渲染层显示
    return { dir, error: err || '' }
  })
  ipcMain.handle(CH.statWatchProgress, (_e, entry: StatEntry) => statWatchProgressFor(entry))

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
  /*
   * v0.2.9 最后更新：应用内一键更新。
   * - download：下载安装包到「安装目录/data/updates」，进度通过 ev:update-state 下行；
   * - install：`installer.exe /S --force-run` 静默安装并自动重启（本进程先退出，避免文件占用）；
   * - openReleases：该版本没有可用安装包资产时的兜底（引导用户去 Releases 页面）。
   */
  ipcMain.handle(CH.appUpdateDownload, () => downloadUpdate())
  ipcMain.handle(CH.appUpdateInstall, () => installUpdate())
  ipcMain.handle(CH.appUpdateOpenReleases, () => {
    openReleases()
    return true
  })
  ipcMain.handle(CH.appUpdateState, () => updateInstallState())
  /*
   * v0.2.12：把「更新」做成一个独立可视化窗口（用户要求更新程序要有进度界面、
   * 且是优先级较高的模块）。设置页、重要更新弹窗、托盘菜单都调这一个入口。
   */
  ipcMain.handle(CH.appUpdateOpenWindow, () => {
    openUpdateWindow()
    return true
  })
  ipcMain.handle(CH.appUpdateSnooze, (_e, version: string) => {
    snoozeImportantUpdate(String(version ?? ''))
    return true
  })
  onUpdateInstallState((s) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(CH.evUpdateState, s)
    }
  })
  ipcMain.handle(CH.appOpenUrl, async (_e, url: string) => {
    const target = /^https?:\/\//i.test(String(url ?? '')) ? String(url) : REPO_URL
    await shell.openExternal(target)
    return true
  })
  ipcMain.handle(CH.danmakuMatch, (_e, title: string, episode: number) => matchDanmaku(title, episode))
  ipcMain.handle(CH.danmakuComments, (_e, episodeId: number) => fetchDanmaku(episodeId))
  /*
   * v0.2.8：播放器与本地播放共用的一步到位接口（opts.aliases / aliasMode 用于「别名检测弹幕」）
   *
   * v0.2.9：如果用户把弹幕渲染方式选成了 uosc_danmaku（mpv 插件），
   * 这里顺手把**同一份**合并后的弹幕写成 B 站格式 XML 交给插件渲染 ——
   * 两个渲染器数据完全一致，插件不需要自己再请求一次（也不会出现两边数量不一样的困惑）。
   */
  ipcMain.handle(
    CH.danmakuLoad,
    async (_e, title: string, episode: number, opts?: { aliases?: string[]; aliasMode?: boolean }) => {
      const r = await loadDanmaku(title, episode, opts)
      if (r && r.comments.length > 0 && uoscDanmakuRequested()) {
        const file = writeDanmakuXml(r.comments, `${r.episodeId}:${r.episodeTitle}`)
        if (file) mpvPushDanmakuFile(file)
      }
      return r
    }
  )
  // v0.2.8 附加：预取（只预热缓存，不回传弹幕本体），用于「进播放/切集时提前加载」
  ipcMain.handle(
    CH.danmakuPrefetch,
    (_e, title: string, episode: number, opts?: { aliases?: string[]; aliasMode?: boolean }) =>
      prefetchDanmaku(title, episode, opts)
  )

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
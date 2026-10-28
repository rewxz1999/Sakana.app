import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { CH } from '@shared/channels'
import type {
  AddDownloadInput,
  BatchProbeTarget,
  CardExportImageRequest,
  CastMediaInput,
  DanmakuBoxEntry,
  DanmakuSource,
  GalBgmResult,
  GalRecentShot,
  GalToolsConfig,
  LocalTargetInput,
  PlayFlowMark,
  PlayRule,
  StreamReachabilityReport,
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
import { setOfficialBangumiSource } from './services/bangumiProxy'
import { getSettings } from './net'
import { store } from './store'
import { bangumi } from './services/bangumi'
import { mikan } from './services/mikan'
import { downloadManager } from './services/downloader/manager'
import { deleteLocalResources, localDirInfo, removeDownloadRecords } from './services/downloader/localCleanup'
import { launchQbitAndWait, qbitStatus } from './services/downloader/qbitLauncher'
import { aria2 } from './services/downloader/aria2'
import { imageDataUrl, listVideos } from './services/media'
import { clipboardHasImage, copyImageToClipboard, copyScreenshotIfEnabled } from './services/clipboardCopy'
/*
 * v0.3.6：这个 import 不只是"为了用函数"，它还有**副作用** ——
 * audioSettings 在模块顶层向 mpv 注册了三个回调（实例就绪后应用设置、实例销毁后复位指纹、
 * 倍速变化时重拼滤镜链）。不 import 的话那些回调永远不会被注册，
 * 表现就是「设置页改了音频设置但播放器毫无反应」（而且完全不报错）。
 */
import { applyAudio } from './services/audioSettings'
import {
  archiveRuleChanges,
  ruleEpisodes,
  ruleName,
  rulePlay,
  ruleSearch,
  ruleSearchUrl,
  rulesRepoImport,
  rulesRepoIndex
} from './services/rules'
import {
  alternativesForStreamUrl,
  getCachedStreamOrWait,
  prefetchStream,
  rememberStream,
  startRuleProbe,
  stopRuleProbe
} from './services/ruleProbe'
// v0.3.7：播放源列表的批量预嗅探（每条规则命中多少资源）
import { startBatchProbe, stopBatchProbe } from './services/ruleProbeBatch'
// V2.0：点选集之后才开的无头取流（拿到直链 → 立即销毁窗口 → 先缓存再注入）
import { acquireStream, cancelAcquire } from './services/playAcquire'
// v0.3.7：人机验证窗口
import { closeVerifyWindow, openVerifyWindow, reloadVerifyWindow, setVerifyBounds } from './services/ruleVerify'
// v0.3.8：投屏（发现设备 + DLNA/Sakana 控制）
import {
  addCastDevice,
  castControl,
  castInfo,
  castPlay,
  castStopRemote,
  startCastDiscovery,
  stopCastDiscovery,
  type CastAction
} from './services/cast'
import { closeRuleWebview, currentRuleWebviewGen, openRuleWebview, setRuleWebviewBounds } from './services/ruleWebview'
import { mpvRuntimeAvailable, mpvSetDanmakuSource, mpvPushDanmakuFile, uoscDanmakuRequested, mpvOpenDanmakuMenu, mpvSetUoscDanmakuVisible, mpvClearUoscDanmakuSource, mpvPushDanmakuDelay, uoscDanmakuActive, mpvUoscDanmakuLoaded, mpvPluginDanmakuPending, mpvPushUoscBar, uoscControlBarActive, uoscControlBarRequested, mpvApplyVideoEnhance, anime4kAvailable, anime4kShaderFiles, mpvRevealUoscUi, uoscBridgeStats, mpvSendScriptMessage } from './services/mpv'
// v0.3.7：画面子窗口诊断（查「正在播放但没有画面」）
import { mpvDiagnosticBounds, mpvDumpWindows, mpvHitTest, mpvInputWindowState, mpvRaiseStats, mpvSurfaceInfo } from './services/mpv'
import { buildStreamInfo } from './services/playerInfo'
import { applyMark, flowDetail, noteSlow, pushStep, setMetrics, snapshot as flowSnapshot } from './services/playFlow'
// v1.3 提速工单：分段计时 + 乐观交接（见两个模块的注释）
import { beginPlayTiming, markPlayTiming } from './services/playTiming'
import { noteHandoffActive, offerHandoffCandidate } from './services/playHandoff'
import { probeStreamReachability } from './services/streamDiag'
import { hardResetPlayChain, runPlaySelfCheck, selfCheckSnapshotForInfo } from './services/playSelfCheck'
import { isOneTimeStream } from './services/ruleProbe'
import { clearStreamBoostRecords, getStreamBoostRecords, getStreamBoostStatus } from './services/streamBoost'
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
import { cacheStats, danmakuCacheRoot } from './services/danmakuCache'
import { progressReset, progressSnapshot } from './services/danmakuProgress'
import { resetSourceRunnerStats, sourceRunnerStats } from './services/danmakuSourceRunner'
// v1.1：数据源集合器（适配器自述/增删改/测试）与本地弹幕库（列表/删除/清空/目录）
import { DANMAKU_ADAPTERS, danmuboxFetchEpisode, danmuboxSearch, listSources, saveSources, testSource } from './services/danmakuSources'
import { clearLibrary, ensureLibraryDir, libraryInfo, removeFromLibrary, saveToLibrary } from './services/danmakuLibrary'
import { clearFetchLog, readFetchLog } from './services/danmakuFetchLog'
// v0.3.0：Jikan（MAL）作为角色立绘的备用数据源（带 3 次/秒、60 次/分钟节流）
import { jikanCharactersByTitle } from './services/jikan'
import { saveDirsInfo, setSaveDirs } from './services/saveDirs'
// V1.5.1 本地库（下载目录扫描 / 按条目解析本地目录）
import { localDirForSubject, scanLocalLibrary } from './services/localLibrary'
// V1.5.2 附加在线数据源
import { ONLINE_SOURCES, onlineEpisodes, onlineResolve, onlineSearch, onlineSourceAvailability } from './services/onlineSources'
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
  noteOverlayMissedClick,
  onOverlayClickThrough,
  pushOverlayClickThrough,
  pushOverlayState,
  sendOverlayAction,
  setOverlayInteractive,
  showOverlay
} from './services/playerOverlay'
import { toolService } from './services/tools'
import { listSubscriptions, mutateSubscriptions } from './services/subsStore'
import { hidePanelNow } from './tray'
import { focusedOrMain, getMainWindow, isSmallWindow, openSmallWindow, openUpdateWindow } from './window'
import {
  galApplyYmgal as galApplyYmgalFn,
  galImport as galImportFn,
  galLaunch as galLaunchFn,
  galPushRunning,
  galRunningInfo,
  galSearchYmgal as galSearchYmgalFn,
  galUpdateDetail as galUpdateDetailFn,
  galgameService
} from './services/galgame'
import {
  galMemExtractImages,
  galMemForceRefresh,
  galSaveRootDir,
  galMemRecent,
  galMemSaveBgm,
  galMemSavedBgm,
  galMemUnpack,
  galMemUnpackStatus
} from './services/galgameMem'
import { galExtractAll, galExtractPreview, galListResources } from './services/galResources'
import {
  galListShots,
  galOverlayResize,
  galPickDir,
  galRecentShots,
  galScreenshotNow,
  migrateAllGalSaves,
  galToolsCleanup,
  galToolsGet,
  galToolsInit,
  galToolsSet
} from './services/galgameTools'
import { galSearchSites, galSiteList, galSiteSearchUrl } from './services/galgameSearch'
import { statExportImage } from './services/statExport'
import { exportCardImage } from './services/cardExport'
import { applyStatAction, readStatData, statWatchProgressFor } from './services/statStore'
import { listStatShots, statShotsDirToOpen } from './services/statShots'
import { maybeShowSaveHint } from './services/onboarding'
import { ensureSaveDirs } from './services/saveDirs'
import { clearCache, clearJunk, getCacheBytes, importShowcaseImages, pickDirectory, setCacheDir } from './services/settingsExt'
// V1.5.1 本地缓存数据库（统计 / 立即清理 / 移除条目 / 清缓存时重置索引）
import { cacheDbEntries, cacheDbStats, flushCacheDb, forgetSubject, pruneCacheDbNow, resetCacheDb } from './services/cacheDb'
// V1.5.3 数据源流量监控（本次运行的内存计数）
import { resetTraffic, trafficSnapshot } from './services/traffic'

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

/**
 * 等一个文件真的落盘（存在且非空），最多等 `timeoutMs` 毫秒。
 *
 * 为什么需要它：mpv 的 `screenshot-to-file` 是**异步**命令 —— 命令返回只代表「已受理」，
 * 文件通常还要几十到几百毫秒才写完。紧接着去读文件会扑空（表现为「截图存了，但没进剪贴板」）。
 * 轮询而不是 `fs.watch`：这里等的是**一次性的短事件**，watch 在 Windows 上对
 * 「目录还不存在 / 文件被重命名」等边角情况要处理的失败模式更多，轮询反而更稳。
 * 每 40ms 探一次，2.5s 上限 —— 正常情况两三次就命中，超时说明 mpv 那边真出问题了，
 * 调用方只记日志、不报错（截图本身可能仍然是成功的）。
 */
async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    try {
      if (existsSync(file) && statSync(file).size > 0) return true
    } catch {
      /* 文件正在被写、暂时 stat 不到：继续等 */
    }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 40))
  }
}

/**
 * 播放器截图（mpv 路径）的完整收尾：交给 mpv 存盘 → 等它真的落盘 → 按设置写进系统剪贴板。
 *
 * v0.3.7 修复（用户报「上个版本的截图快速导入到剪贴板没有实现」）：
 *
 * 播放器里有**两条**截图路径，而用户实际走的这条以前**根本没有复制剪贴板**：
 *   · 这条（mpv 的 `screenshot-to-file`，截图带 OSD/弹幕、不受网页限制）——
 *     `s` 键、控制栏截图按钮走的都是它，之前只有一行「已保存」日志，没有复制；
 *   · 另一条 `playerScreenshot`（`webContents.capturePage()` 截网页，mpv 内核不可用时的兜底）——
 *     那条在 v0.3.6 就接了剪贴板。所以上一版自检「通过」了：自检验的是兜底那条，
 *     真正播放时走的是这条，于是用户那边永远不生效。
 *
 * 还有一个必须处理的时序问题：`screenshot-to-file` 是**异步落盘**的，
 * 命令返回时文件往往还没写完 —— 立刻去复制只会得到「文件不存在」。
 * 所以这里等文件真的出现（最多 2.5s）再复制；等不到只记日志，不影响「截图已保存」这个事实。
 *
 * 抽成导出函数的原因：`SAKANA_SNAPSHOT_TEST` 自检（index.ts）要跑到**同一段代码**。
 * 自检里另写一遍的话，验的是副本 —— 产品代码里的 bug 照样漏过去（上一版就是这么漏的）。
 */
export async function snapshotViaMpv(
  title?: string,
  episode?: number
): Promise<{ file: string; wrote: boolean; copied: boolean }> {
  const file = snapshotPath(title, episode)
  engineSnapshot(file)
  const wrote = await waitForFile(file, 2500)
  const copied = wrote ? await copyScreenshotIfEnabled(file) : false
  log.append(
    'info',
    'player',
    `播放器截图已保存: ${file}` +
      (wrote ? '' : '（等待落盘超时）') +
      (wrote ? (copied ? '；已复制到剪贴板' : '；未复制剪贴板（按设置关闭或写入失败）') : '')
  )
  maybeShowSaveHint()
  return { file, wrote, copied }
}

export function registerIpc(): void {
  /*
   * ---------- 窗口控制 ----------
   *
   * ⚠️ v0.3.6 修的一个严重 bug：这些 handler 以前一律用 `focused()`（= 当前有焦点的窗口）。
   * 但播放器一开始就会创建一个**透明、无边框的控制栏悬浮窗**（playerOverlay），
   * 而且它是主窗口的 owned window、点一下控制栏/点一下画面它就可能成为焦点窗口。
   * 于是播放页点「全屏」时：
   *   · `focused()` 拿到的是**悬浮窗**，`setFullScreen(true)` 作用在了一个
   *     不该全屏的透明覆盖窗上（主窗口一点变化都没有 → 用户看到「全屏按钮没反应」）；
   *   · `winIsFullscreen` 同样返回悬浮窗的状态（恒 false）→ 渲染层的 `fullscreen`
   *     状态永远不更新 → 退出时不会调 setFullscreen(false)，界面卡在「以为全屏」的布局里
   *     （用户报的「退出时播放器卡白、无法退出」）；
   *   · `winClose` 可能去关悬浮窗而不是主窗口。
   *
   * 现在窗口控制一律以**主窗口**为准（`getMainWindow()`）；只有在没有主窗口、
   * 或调用方确实来自某个小窗口（设置小窗自己的关闭/最小化按钮）时才回退到焦点窗口。
   * 判据：小窗口里的按钮点的是自己，用焦点窗口是对的；播放器/播放页永远属于主窗口。
   */
  const controlWindow = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null => {
    const sender = BrowserWindow.fromWebContents(e.sender)
    // 来自小窗口的请求：操作它自己（设置小窗的关闭/最小化按钮）
    if (sender && isSmallWindow(sender)) return sender
    const main = getMainWindow()
    if (main && !main.isDestroyed()) return main
    return sender && !sender.isDestroyed() ? sender : (focused() ?? null)
  }
  ipcMain.handle(CH.winMinimize, (e) => controlWindow(e)?.minimize())
  ipcMain.handle(CH.winMaximizeToggle, (e) => {
    const w = controlWindow(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle(CH.winClose, (e) => controlWindow(e)?.close())
  ipcMain.handle(CH.winIsMaximized, (e) => !!controlWindow(e)?.isMaximized())
  ipcMain.handle(CH.winSetFullscreen, (e, full: boolean) => {
    const w = controlWindow(e)
    if (!w) return false
    w.setFullScreen(!!full)
    // 主动回一条状态：setFullScreen 是**异步**生效的，而 enter/leave-full-screen 事件
    // 在部分情况下（窗口未显示、已处于目标状态）不会发出 —— 渲染层就永远等不到更新。
    // 这里在事件之外补一条，保证按钮图标与布局立刻跟手。
    return w.isFullScreen()
  })
  ipcMain.handle(CH.winIsFullscreen, (e) => !!controlWindow(e)?.isFullScreen())
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
  /*
   * galgame 沉浸模式（v0.3.9）：进入时记住窗口几何并全屏，退出时恢复小窗口。
   *
   * 为什么单独一条通道而不是复用 win:set-fullscreen：
   * 沉浸模式要求「退出后回到进入前的小窗口」—— 进全屏那一刻窗口的 bounds 已经是全屏尺寸，
   * 光退全屏只能得到全屏前的尺寸；必须先记住 getNormalBounds()（无论最大化/全屏都返回
   * 恢复态的尺寸）与是否最大化，退出全屏后再恢复，才能覆盖
   * 「普通 / 最大化 / 全屏下进沉浸再退出」这几种边界而不丢窗口尺寸。
   */
  let immersiveSnapshot: { bounds: Electron.Rectangle; maximized: boolean } | null = null
  ipcMain.handle(CH.winImmersive, (e, immersive: boolean) => {
    const w = controlWindow(e)
    if (!w) return
    if (immersive) {
      // 重复进入（连点按钮 / 幂等调用）不覆盖第一次记住的几何，否则恢复态会漂移
      if (immersiveSnapshot) return
      immersiveSnapshot = { bounds: w.getNormalBounds(), maximized: w.isMaximized() }
      if (!w.isFullScreen()) w.setFullScreen(true)
    } else {
      const snap = immersiveSnapshot
      immersiveSnapshot = null
      if (w.isFullScreen()) w.setFullScreen(false)
      if (snap) {
        // 退出全屏是异步的，等窗口回到普通状态再恢复尺寸/最大化，避免竞态
        setTimeout(() => {
          if (w.isDestroyed()) return
          if (snap.maximized) w.maximize()
          else w.setBounds(snap.bounds)
        }, 200)
      }
    }
  })

  // ---------- 存储 ----------
  ipcMain.handle(CH.storeGet, (_e, ns: string) => store.get(ns, null))
  ipcMain.handle(CH.storeSet, (_e, ns: string, data: unknown) => {
    /*
     * 规则被界面改了就留一份到本地库（v0.3.9，用户要求"任何修改都留一份在本地库"）。
     *
     * 为什么钩在这里而不是 RulesPage 的保存函数里：规则至少有四条写入路径
     * （规则页保存、从仓库导入、恢复默认、本地库替换），把留档挂在唯一的写入口上，
     * 才不会出现"某条路径改了规则但没留档"的漏洞；而且改动前后的对比需要旧值，
     * 只有这一层同时拿得到旧值和新值。
     */
    if (ns === 'rules' && Array.isArray(data)) {
      try {
        const prev = store.get<PlayRule[]>('rules', [])
        archiveRuleChanges(prev, data as PlayRule[], 'before-change')
      } catch (err) {
        // 留档失败不能挡住保存本身（规则能不能用比留档重要）
        log.append('warn', 'rules', `本地库留档失败（界面保存规则）: ${String(err)}`)
      }
    }
    store.set(ns, data)
    /*
     * v0.3.1：设置里带播放画质项（Anime4K 模式/着色器链、饱和度对比度、HDR…），
     * 而这些项对 mpv 都是**运行时属性**，所以在这里顺手重应用一次 ——
     * 用户改完设置立刻能看到画面变化，不必退出播放页再进来。
     * 只在播放器实例存在时才有实际动作（mpvApplyVideoEnhance 自己会判 ready）。
     */
    if (ns === 'settings') {
      mpvApplyVideoEnhance()
      /*
       * v0.3.6：音频设置（音量增益、均衡器、压缩、响度、可视化）同样是 mpv 的**运行时**状态，
       * 走同一钩子重应用一次 —— 用户在设置页拖 EQ 滑杆就能当场听到变化。
       * `applyAudio()` 内部有指纹去重，连续拖动不会反复重建滤镜链（那会听得见断音）。
       */
      applyAudio()
    }
    return true
  })

  // ---------- bangumi 数据源 ----------
  /*
   * V1.5.1：切换数据源模式（官方直连 / 内置反代）。
   * 两层都要改：网络层的模块级开关（立即生效）+ settings（下次启动自动应用）。
   * 只改设置不切开关 = 用户点了没反应；只切开关不写设置 = 重启后又变回去。
   */
  ipcMain.handle(CH.bgmSetSource, (_e, official: boolean) => {
    const on = official === true
    setOfficialBangumiSource(on)
    store.set('settings', { ...store.get<Record<string, unknown>>('settings', {}), bangumiOfficial: on })
    log.append('info', 'startup', `数据源已切换为${on ? '官方直连' : '内置反代'}（设置页）`)
    return { official: on }
  })
  ipcMain.handle(CH.bgmCalendar, (_e, force?: boolean, opts?: { allowRefresh?: boolean }) =>
    bangumi.calendar(!!force, { allowRefresh: opts?.allowRefresh === true })
  )
  ipcMain.handle(CH.bgmSubject, (_e, id: number, priority?: string) =>
    bangumi.subject(Number(id), priority === 'A' || priority === 'B' ? priority : 'S')
  )
  // v1.1.4：详情页首屏的「纯缓存快照」与独立的评分板块（都不阻塞正文）
  ipcMain.handle(CH.bgmSubjectCached, (_e, id: number) => bangumi.subjectCached(Number(id)))
  ipcMain.handle(CH.bgmRating, (_e, id: number, refresh?: boolean) => bangumi.rating(Number(id), !!refresh))
  ipcMain.handle(CH.bgmSearch, (_e, keyword: string) => bangumi.search(keyword))
  ipcMain.handle(CH.bgmRatings, (_e, ids: number[], force?: boolean) => bangumi.ratings(ids, !!force))
  ipcMain.handle(CH.bgmSeason, (_e, year: number, month: number, force?: boolean, priority?: string) =>
    bangumi.season(Number(year), Number(month), !!force, priority === 'A' || priority === 'B' ? priority : 'S')
  )
  /** 「更新到第几集」（v0.3.7）：取不到返回 null，界面据此隐藏这一行而不是显示 0 */
  ipcMain.handle(CH.bgmEpisodeProgress, (_e, id: number, priority?: string) =>
    bangumi.episodeProgress(Number(id), priority === 'A' || priority === 'B' ? priority : 'S')
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
      malId: r.anime?.malId ?? 0,
      /*
       * v0.3.2：把「到底是谁给的」如实透出。
       * Jikan 的搜索/角色端点目前会整片 504（它自己连不上 MAL 上游），
       * 这时会改走 AniList；界面徽章与导出图页脚必须按实际来源写，
       * 否则用户看到的仍是「来源：Jikan/MAL」——等于骗人（上一版就是这么错的）。
       */
      via: r.via,
      imageSource: r.imageSource,
      /** 两条路都失败时的具体原因：界面要常驻显示，不能只弹一个会消失的 toast */
      reason: r.reason ?? ''
    }
  })
  /*
   * 图片 → data URL。必须走主进程：渲染层直接用 sakana-img:// 画 canvas 会污染画布，
   * toBlob() 会抛 SecurityError（导出整条链路断在这里），data URL 则永不污染。
   */
  ipcMain.handle(CH.bgmImageDataUrl, (_e, url: string) => imageDataUrl(String(url ?? '')))

  // ---------- 蜜柑计划 ----------
  ipcMain.handle(CH.mikanSearch, (_e, keyword: string) => mikan.search(keyword))
  ipcMain.handle(CH.mikanCheckSub, async (_e, subId: string, full?: boolean) => {
    const sub = store.get<Subscription[]>('subscriptions', []).find((s) => s.id === subId)
    if (!sub) throw new Error('订阅不存在')
    /*
     * v0.3.5：`full=true` 表示「获取全部资源」——不看发布日期，把该番该组的**历史集数**也列出来
     * （用户反馈：订阅《无职转生 第三季》时字幕组已更到第 13 集，但 1~12 集永远不会出现，
     *  日志里就是「官方订阅RSS条目 39 → 命中 3」）。订阅页有对应按钮，订阅刚创建时也会自动跑一次。
     */
    return mikan.checkSub(sub, { full: full === true })
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
      /*
       * v0.3.9 体检 H3：集号合并**不能拿 0 当"未知"**。
       * 以前是 `Math.max(existing.episode ?? 0, item.episode ?? 0)`：字幕组资源标题里没有集号时
       * （合集 / 剧场版 / OP-ED，parseEpisode 返回 null）两次都是 0，结果写进库里的 episode=0，
       * 而界面判据是 `!= null` → 一条什么都没下载的订阅被标成「已下载所有资源」。
       * 现在：两边都为 null 就保持 null（"还不知道"），只有真的有集号时才取较大值。
       */
      const prevEp = existing.episode ?? null
      const nextEp = input.mikanItem.episode ?? null
      const mergedEp = prevEp == null ? nextEp : nextEp == null ? prevEp : Math.max(prevEp, nextEp)
      const updated: Subscription = {
        ...existing,
        group: input.mikanItem.group ?? existing.group,
        episode: mergedEp,
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
    // v0.3.9 体检 H3：集号允许为 null（"不知道下到第几集"），不再强制成 0
    (_e, id: string, episode: number | null, lastPubDate: string) =>
      mutateSubscriptions((list) =>
        list.map((s) =>
          s.id === id
            ? { ...s, episode: episode ?? null, lastPubDate, status: 'complete' as const }
            : s
        )
      )
  )
  ipcMain.handle(CH.dlPause, (_e, id: string) => downloadManager.pause(id))
  ipcMain.handle(CH.dlResume, (_e, id: string) => downloadManager.resume(id))
  ipcMain.handle(CH.dlRetry, (_e, id: string) => downloadManager.retry(id))
  ipcMain.handle(CH.dlRemove, (_e, id: string) => downloadManager.remove(id))
  ipcMain.handle(CH.dlList, () => downloadManager.list())
  /*
   * v0.3.6（清理）：删掉了 `CH.dlStatus` 的 handler —— 它与下一行 `dlTest` 完全重复
   * （两个 handler 都是 `downloadManager.test()`），而 `dlStatus` 那条通道在 preload 里
   * 从来没有暴露过，渲染层不可能调到它。留着的唯一效果是让人以为有两条不同的接口。
   */
  ipcMain.handle(CH.dlTest, () => downloadManager.test())

  // ---------- 外部 qBittorrent（状态 / 由应用启动 / 选程序路径） ----------
  /** 设置页「连接测试」与状态卡都用它：如实返回能不能连、什么版本、路径对不对 */
  ipcMain.handle(CH.qbitStatus, () => qbitStatus())
  /** 手动启动：拉起 qb 并等 WebUI 就绪（失败/超时回中文原因） */
  ipcMain.handle(CH.qbitLaunch, () => launchQbitAndWait())
  /*
   * V1.5.2：aria2 Tracker 列表（下载器加速）。
   *
   * 状态是纯本地读（磁盘缓存 + 内置列表），不会因为打开设置页就联网；
   * 「立即更新」才会拉社区列表并通过 changeGlobalOption 热更到运行中的 aria2。
   */
  ipcMain.handle(CH.dlTrackerStatus, () => aria2.trackerStatus())
  ipcMain.handle(CH.dlTrackerUpdate, () => aria2.refreshTrackersNow())

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
  // subjectId 只给库驱动规则（巴哈姆特）用来把中文名换成日文原名，XPath 规则忽略它
  ipcMain.handle(CH.rulesSearch, (_e, ruleId: string, keyword: string, subjectId?: number) =>
    ruleSearch(ruleId, keyword, subjectId)
  )
  ipcMain.handle(CH.rulesEpisodes, (_e, ruleId: string, entry) => ruleEpisodes(ruleId, entry))
  /*
   * 播放页解析 = 用户点下某一集的那一刻（v1.3 计时起点）。
   *
   * 两个提速点都在这里：
   *   ① `beginPlayTiming` 记下点击时刻，后续 `rules.play → player.play → loadfile → 首帧`
   *      四段耗时都相对它计算，最后在 playFlow.endFlow 打一行；
   *   ② 播放页地址一确定就**在同一个 IPC 里直接发起预取**，不再等渲染层跳转后再发一次请求。
   *      这样「页面抓取/候选解析」与「页面导航 + 播放页挂载」是并行的；
   *      下一步 `cachedStream` 来查时，预取往往已经落地，可以完全跳过网页嗅探。
   */
  ipcMain.handle(
    CH.rulesPlay,
    async (
      _e,
      ruleId: string,
      entry,
      lineIndex: number,
      episodeIndex: number,
      episodeLink: string,
      vars: Record<string, string>
    ) => {
      beginPlayTiming('规则播放')
      const r = await rulePlay(ruleId, entry, lineIndex, episodeIndex, episodeLink, vars)
      markPlayTiming('选源')
      // handoff=true：这就是用户马上要播的那一集，候选可以进交接队列
      if (r?.url) void prefetchStream(r.url, r.referer, { handoff: true })
      return r
    }
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
      vars: Record<string, string>,
      /**
       * v1.3：渲染层刚刚已经解析过播放页时把地址带过来，**不再重跑一次 rulePlay**。
       * 这一步在过去是一次多余的主进程往返 + 一次重复解析（API 规则要拼模板、XPath 规则要读规则）。
       */
      knownPageUrl?: string,
      /**
       * v1.3：`true` = 这一集马上就要播（候选可以进交接队列）；
       * 预取下一集时必须 false/省略，否则当前这集卡住 5 秒会被换到下一集的地址上。
       */
      forCurrentEpisode?: boolean
    ) => {
      const pageUrl = knownPageUrl && /^https?:\/\//i.test(knownPageUrl)
        ? knownPageUrl
        : (await rulePlay(ruleId, entry, lineIndex, episodeIndex, episodeLink, vars))?.url
      if (!pageUrl) return null
      /*
       * 预取的 Referer 交给 extractStreamCandidates 自己按播放页 origin 兜底：
       * 这里只负责「尽快把播放页抓下来」，不再为了一个 Referer 再解析一次规则。
       */
      const stream = await prefetchStream(pageUrl, undefined, { handoff: forCurrentEpisode === true })
      return { pageUrl, url: stream?.url ?? null, referer: stream?.referer }
    }
  )
  // 规则仓库导入（KazumiRules 镜像优先）
  ipcMain.handle(CH.rulesRepoIndex, () => rulesRepoIndex())
  ipcMain.handle(CH.rulesRepoImport, (_e, names: string[]) => rulesRepoImport(names))
  /*
   * V2.0「点播放才取流」：播放页地址 → 直链（无头窗口，拿到候选立刻销毁；先起本地缓存）。
   *
   * 为什么主窗口传 null：这条路径的结果由**调用方**（播放页）直接消费，
   * 事件再推一份给渲染层会让页面自己的 onFound 与这里同时接手同一条流（两次 loadfile）。
   * 失败原因走返回值，不靠事件 —— 调用方能直接 toast/写进错误条。
   */
  ipcMain.handle(CH.rulesAcquireStream, async (_e, playUrl: string, referer?: string) => {
    const r = await acquireStream(null, String(playUrl ?? ''), referer)
    /*
     * 失败用 throw 而不是 {ok:false}：preload 的 `call()` 会把异常统一包成
     * `{ ok:false, error }`，渲染层拿到的形状与其它 rules.* 接口完全一致
     * （界面已有"分类失败原因 + 换线路重试"的那套 UI，直接复用）。
     */
    if (!r.ok || !r.url) throw new Error(r.error ?? '取流失败：没有拿到可播放的视频地址')
    return {
      url: r.url,
      referer: r.referer,
      ms: r.ms,
      channel: r.channel,
      cacheStarted: r.cacheStarted,
      cacheReason: r.cacheReason
    }
  })
  ipcMain.handle(CH.rulesAcquireCancel, () => {
    cancelAcquire()
    return true
  })
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
  /*
   * 播放源列表的批量预嗅探（v0.3.7）：只探测、不播放。
   * 结果按规则逐条推事件回去，界面上的徽章随到随更新。
   */
  ipcMain.handle(
    CH.rulesBatchProbe,
    (e, req: { keyword: string; rules: BatchProbeTarget[]; force?: boolean; subjectId?: number }) => {
      const w = BrowserWindow.fromWebContents(e.sender) ?? focused()
      if (!w) return { jobId: '', total: 0, cached: false }
      return startBatchProbe(w, {
        keyword: String(req?.keyword ?? ''),
        rules: req?.rules ?? [],
        force: req?.force === true,
        subjectId: typeof req?.subjectId === 'number' ? req.subjectId : undefined
      })
    }
  )
  ipcMain.handle(CH.rulesBatchProbeStop, () => {
    stopBatchProbe()
    return true
  })
  /*
   * 人机验证窗口（v0.3.7）：把这条规则的搜索页摆在用户点出来的那块"洞"里，
   * 用户过完验证后 Cookie 留在同一个会话，后续网页内搜索/嗅探直接就是已验证状态。
   */
  ipcMain.handle(
    CH.rulesVerifyOpen,
    (
      e,
      ruleId: string,
      keyword: string,
      bounds: { x: number; y: number; width: number; height: number }
    ) => {
      const w = BrowserWindow.fromWebContents(e.sender) ?? focused()
      const url = ruleSearchUrl(String(ruleId ?? ''), String(keyword ?? ''))
      const name = ruleName(String(ruleId ?? ''))
      if (!w || !url) return { ok: false, ruleName: name, url: '' }
      const ok = openVerifyWindow(
        w,
        url,
        {
          x: Number(bounds?.x) || 0,
          y: Number(bounds?.y) || 0,
          width: Number(bounds?.width) || 720,
          height: Number(bounds?.height) || 480
        },
        name
      )
      return { ok, ruleName: name, url }
    }
  )
  ipcMain.handle(
    CH.rulesVerifyBounds,
    (_e, bounds: { x: number; y: number; width: number; height: number }) => {
      setVerifyBounds({
        x: Number(bounds?.x) || 0,
        y: Number(bounds?.y) || 0,
        width: Number(bounds?.width) || 720,
        height: Number(bounds?.height) || 480
      })
      return true
    }
  )
  ipcMain.handle(CH.rulesVerifyClose, () => {
    closeVerifyWindow()
    return true
  })
  // v1.1：外框上的「重新加载」（站点 5xx / 网络抖动时就地重试，不丢已过一半的验证）
  ipcMain.handle(CH.rulesVerifyReload, () => reloadVerifyWindow())
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

  // ---------- 投屏（v0.3.8） ----------
  ipcMain.handle(CH.castDiscover, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender) ?? focused()
    if (!w) return []
    return startCastDiscovery(w)
  })
  ipcMain.handle(CH.castStopDiscover, () => {
    stopCastDiscovery()
    return true
  })
  ipcMain.handle(CH.castAddManual, (_e, addr: string) => addCastDevice(String(addr ?? '')))
  ipcMain.handle(CH.castPlay, (_e, deviceId: string, media: CastMediaInput) =>
    castPlay(String(deviceId ?? ''), media)
  )
  ipcMain.handle(
    CH.castControl,
    (_e, deviceId: string, action: string, value?: number) =>
      castControl(String(deviceId ?? ''), action as CastAction, value)
  )
  ipcMain.handle(CH.castInfo, (_e, deviceId: string) => castInfo(String(deviceId ?? '')))
  ipcMain.handle(CH.castStop, async (_e, deviceId: string) => {
    await castStopRemote(String(deviceId ?? ''))
    return true
  })
  /** 投屏/同步服务的局域网地址：设置页把它显示出来，手机端手填这个地址即可互通 */
  ipcMain.handle(CH.castSyncUrl, async () => {
    const { ensureCastServer } = await import('./services/castRelay')
    await ensureCastServer().catch(() => 0)
    const { castSyncUrl } = await import('./services/castSync')
    return castSyncUrl()
  })
  /** 记住默认投屏设备（设置页里"手动连接"成功之后写它） */
  ipcMain.handle(CH.castSetTarget, (_e, deviceId: string) => {
    /*
     * 走 store 直接写 settings：这里只是记一个"默认投给谁"的偏好，
     * 不需要触发设置变更的那些副作用钩子（画质/音频重应用）。
     */
    const cur = store.get<Record<string, unknown>>('settings', {})
    store.set('settings', { ...cur, castTargetId: String(deviceId ?? '') })
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
    /*
     * v1.3：这条 IPC 就是「嗅探命中 → 交给内核」的交接点，因此计时打「命中」。
     * 同时把同一次嗅探里发现的备选候选放进交接队列：
     * 缓存/直出地址失效时，内核 5 秒零字节就能换下一条，不必重开一整轮嗅探。
     */
    markPlayTiming('命中')
    noteHandoffActive(path)
    for (const c of alternativesForStreamUrl(path)) offerHandoffCandidate(c)
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
  /*
   * 画面子窗口诊断（v0.3.7）：把原生子窗口的现场整体交给渲染层。
   * 「正在播放但没有画面」的判据只能从窗口层拿 —— 子窗口在不在、多大、那个点上谁在最上面。
   */
  ipcMain.handle(CH.playerSurfaceDebug, () => {
    const bounds = mpvDiagnosticBounds()
    const cx = bounds ? bounds.x + bounds.width / 2 : 0
    const cy = bounds ? bounds.y + bounds.height / 2 : 0
    let hit: unknown = null
    try {
      hit = mpvHitTest(cx, cy)
    } catch {
      hit = null
    }
    let windows: unknown = null
    try {
      windows = mpvDumpWindows()
    } catch {
      windows = null
    }
    let state: unknown = null
    try {
      state = engineGetState()
    } catch {
      state = null
    }
    /*
     * v0.3.9：把「到底有没有画面」的硬数据一并交出去（见 mpvSurfaceInfo 的注释）。
     *
     * 没有它时，「正在播放但没有画面」只能靠用户描述，无法区分
     * 「画面根本没解出来（width=0）」与「解出来了但窗口没显示」——
     * 而这两种的处置方式完全不同。`video.hasPicture / width / audioOnlyMs` 就是那条分界线。
     */
    let video: unknown = null
    try {
      video = mpvSurfaceInfo()
    } catch {
      video = null
    }
    /*
     * v1.2.1：把「uosc 能不能收到鼠标」的前置条件一并交出去。
     *
     * `hit.hitClass` 只能说明那一刻窗口树里最上层是谁；真正决定按钮生死的是
     * mpv 的 VO 子窗口有没有从 disabled 恢复（见 mpv.ts 的 ensureMpvInputWindow）。
     * 两项并排返回，排障时能直接区分「窗口没启用」与「窗口启用但命中到别的东西」。
     */
    let input: unknown = null
    try {
      input = mpvInputWindowState()
    } catch {
      input = null
    }
    return { bounds, state, video, hit, windows, input, raiseStats: mpvRaiseStats() }
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
  ipcMain.handle(CH.playerSnapshot, async (_e, title?: string, episode?: number) => {
    const r = await snapshotViaMpv(title, episode)
    return r.file
  })
  ipcMain.handle(CH.playerDetach, () => {
    /*
     * 异步释放（V1.5.2 起「释放」= 停播放 + 收画面，内核常驻不销毁）。
     *
     * 仍然放到 setImmediate：退出流程里还有关窗口等一堆事，让本帧先跑完再来收内核状态，
     * 用户看到的是"窗口立刻回来"，而不是"点了退出先卡一下"。
     * 顺便打一行耗时：如果哪天又出现退出卡顿，日志能直接指出是不是这一步。
     */
    setImmediate(() => {
      const t = Date.now()
      try {
        engineDetach()
      } catch (err) {
        log.append('warn', 'exit', `播放器释放失败（忽略）：${String((err as Error)?.message ?? err)}`)
      }
      const ms = Date.now() - t
      log.append(ms > 300 ? 'warn' : 'info', 'exit', `播放器释放完成（${ms}ms，内核常驻未销毁）`)
    })
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
    // v0.2.18：uosc 本体（控制栏）是否挂上了
    bar: uoscControlBarRequested() && uoscControlBarActive(),
    /*
     * v1.1.4：桥接脚本侧的硬证据 —— uosc 版本、实际下发的按钮名、set-button 次数。
     * 自检用：uosc 的按钮画在 mpv 的 ASS 图层里，Electron 侧看不到 DOM，
     * 「控制栏到底有没有按钮」只能问脚本自己（属性由 sakana-uosc-ctrl.lua 写入）。
     */
    bridge: uoscBridgeStats()
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
  /*
   * v1.1.4：**自检/排障专用**的 uosc 按钮旁路。
   *
   * uosc 的按钮画在原生 mpv 子窗口里，CDP 往视频区域派发 DOM 点击是打不中的
   * （点击落在 mpv 的 HWND 上，不经过 Chromium）。所以自检走「按钮点击的**同一条**命令路径」：
   *   这里 → `script-message sakana-ctrl <动作>` → 桥接脚本写 user-data → 250ms 泵派发。
   * 它不新增任何业务逻辑，只是把 input.conf 里已有的那条 script-message 暴露给自检，
   * 因此"这条通了"等价于"按钮的命令通了"（差别只在 uosc 有没有收到鼠标，由 uosc 自己负责）。
   */
  ipcMain.handle(CH.playerUoscCtrl, (_e, action: string) => {
    if (typeof action !== 'string' || action.trim() === '') return false
    return mpvSendScriptMessage(['sakana-ctrl', action])
  })
  // v0.3.3：播放页/悬浮窗看到鼠标移动时调它 → uosc 立刻把控制栏显示出来（flash-ui，节流在 mpv.ts 里）
  ipcMain.handle(CH.playerUoscReveal, () => mpvRevealUoscUi())
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
  /*
   * v0.3.6「点击击穿」自救（三条通道，配合 playerOverlay.ts 里那一大段说明读）：
   *   ① 悬浮窗每次指针按下 → ② 主进程判定是否属于击穿 → ③ 命中就给悬浮窗发一条提示。
   * 判定与节流都在 playerOverlay 里，这里只做转发。
   */
  ipcMain.on(CH.overlayMissedClick, (_e, x: number, y: number) => noteOverlayMissedClick(Number(x) || 0, Number(y) || 0))
  onOverlayClickThrough((payload) => pushOverlayClickThrough(payload))
  ipcMain.handle(CH.playerScreenshot, async (_e, title?: string, episode?: number) => {
    const w = focused()
    if (!w) throw new Error('窗口不存在')
    const image = await w.webContents.capturePage()
    const file = snapshotPath(title, episode)
    writeFileSync(file, image.toPNG())
    log.append('info', 'player', `截图已保存: ${file}`)
    /*
     * v0.3.6「快速粘贴」：按设置把刚存的截图写进系统剪贴板。
     * 必须 await —— Electron 44 的 clipboard 是**异步 API**（见 clipboardCopy.ts 的文件头说明：
     * 同步版 readImage/writeImage 已经没有了）。内部不抛异常，所以不影响「截图已成功」这个事实。
     */
    await copyScreenshotIfEnabled(file)
    maybeShowSaveHint()
    return file
  })
  /** 手动把某张截图复制到剪贴板（截图提示条上的「复制」按钮 / 剧照右键菜单用） */
  ipcMain.handle(CH.clipboardCopyImage, (_e, file: string) => copyImageToClipboard(String(file ?? '')))
  /** 剪贴板是否已有图片（界面提示用） */
  ipcMain.handle(CH.clipboardHasImage, () => clipboardHasImage())
  /** 把一段文本写进剪贴板（galgame 悬浮按钮「复制 BGM 名称」用） */
  ipcMain.handle(CH.clipboardCopyText, async (_e, text: string) => {
    await clipboard.writeText(String(text ?? ''))
    return true
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
  /*
   * v0.3.9：导入返回值从「单个 ToolMeta | null」改成「ToolImportReport」。
   * 放宽语言要求的核心是"给什么都能尽量吃进去"：一次可选多个文件、每份单独结算、
   * 每份都带回解析提示（哪一项没认出来 / 该怎么补），界面据此显示"成功 N 份 / M 份带警告"。
   */
  ipcMain.handle(CH.toolImport, () => toolService.import())
  ipcMain.handle(CH.toolList, () => toolService.list())
  ipcMain.handle(CH.toolRemove, (_e, id: string) => toolService.remove(id))
  ipcMain.handle(CH.toolRun, (_e, id: string) => toolService.run(id))
  ipcMain.handle(CH.toolExportDocs, (_e, format: 'md' | 'txt') => toolService.exportDocs(format))
  /*
   * 自制版式导出成高清 PNG（v0.3.7）。
   * 走主进程的原因见 cardExport.ts 的注释：封面取图链路在这里、离屏窗口能按倍率放大、
   * 而且只有主进程能弹「自选文件夹」的保存对话框。
   */
  ipcMain.handle(CH.cardExportImage, (_e, req: CardExportImageRequest) => exportCardImage(req))

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
   * 单选一张图片：给「最XX的角色」右键格子换本地立绘用（v0.3.5）。
   * 与上面那条只差「单选 + 标题」，但它决定了对话框文案是否与动作相符，
   * 也避免用户多选之后系统只取第一张、剩下几张静默丢弃。
   */
  ipcMain.handle(CH.dialogPickImage, async () => {
    const w = focused()
    if (!w) return null
    const r = await dialog.showOpenDialog(w, {
      title: '选择一张立绘图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
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
  /**
   * 选可执行文件（目前用于 qBittorrent 程序路径）。
   * 便携版要选 `qBittorrentPortable.exe`（PortableApps 启动器），所以不做名字过滤，
   * 只限定 .exe —— 用户也可能直接指向 App\qBittorrent\qbittorrent.exe。
   */
  ipcMain.handle(CH.dialogPickExe, async (_e, defaultPath?: string) => {
    const w = focused()
    if (!w) return null
    const r = await dialog.showOpenDialog(w, {
      title: '选择 qBittorrent 程序（便携版选 qBittorrentPortable.exe）',
      filters: [{ name: '可执行文件', extensions: ['exe'] }],
      defaultPath: defaultPath || undefined,
      properties: ['openFile']
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
  // v0.3.9：某款游戏最近识别到的 BGM（只读内存识别，供卡片右键面板）
  ipcMain.handle(CH.galMemRecent, (_e, gameId: string) => galMemRecent(String(gameId ?? '')))
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
  // 悬浮按钮展开/收起选择面板：渲染层 overlay HTML 告诉主进程该把悬浮窗调到多大
  ipcMain.handle(CH.galOverlayResize, (_e, open: boolean, height?: number) => {
    galOverlayResize(!!open, height)
  })
  /*
   * v0.3.9：悬浮按钮「读取 BGM」—— 读取**当前正在运行的游戏**最近的识别结果。
   *
   * 只读内存识别服务（services/galgameMem）由另一模块维护，这里只做「解析当前游戏 → 读缓存」：
   * 有结果回 name + 引擎；没结果/未开启回明确中文提示，绝不编造一个名字。
   */
  ipcMain.handle(CH.galBgmRead, async (): Promise<GalBgmResult> => {
    const run = galRunningInfo()
    if (!run) return { name: null, message: '未检测到正在运行的 galgame，请先启动游戏' }
    if (!getSettings().galgameMemRead) {
      return { name: null, message: 'BGM 识别未开启（请在设置中开启内存识别）' }
    }
    const recent = galMemRecent(run.gameId)
    if (recent.lastError) return { name: null, message: recent.lastError }
    const entry = recent.entries[0]
    if (!entry) return { name: null, message: '暂未识别到 BGM（游戏可能尚未播放音乐）' }
    /*
     * 分清来源（见 GalMemEntry.kind）：
     * - playing：出现签名刚变化 —— 实测这是"游戏刚切/刚播放"的信号，可以当作当前在播；
     * - new / candidate：只是"刚出现"或"内存里现存的候选"，必须说清楚，不能让用户以为就是在播。
     * 曲名优先用游戏数据里的真实曲名，取不到就如实显示代号。
     */
    const how =
      entry.kind === 'playing'
        ? recent.playingAt
          ? `识别于 ${Math.max(0, Math.round((Date.now() - recent.playingAt) / 1000))} 秒前`
          : '刚捕捉到切曲'
        : entry.kind === 'new'
          ? '刚出现（未捕捉到切曲信号）'
          : '内存中的候选（未捕捉到切曲信号）'
    const detail = [
      entry.title ? `${entry.name}` : recent.codeOnly ? `${entry.name}（游戏数据里没有曲名，只有代号）` : entry.name,
      how,
      recent.engine ? `识别引擎：${recent.engine}` : ''
    ]
      .filter(Boolean)
      .join(' · ')
    return { name: entry.title || entry.name, code: entry.name, detail }
  })
  /*
   * v0.3.9：把某首 BGM 从游戏档案只读提取并保存到本地（文件名优先真实曲名，其次代号）。
   * gameId 允许为空 —— 悬浮窗（galgame 助手）只知道自己正在跟着哪个游戏，不知道 gameId，
   * 这时按「当前正在运行的游戏」解析，与 gal:bgm-read 保持一致。
   */
  ipcMain.handle(CH.galBgmSave, (_e, gameId: string, code: string) => {
    const id = String(gameId ?? '') || galRunningInfo()?.gameId || ''
    if (!id) return { ok: false, path: '', error: '未检测到正在运行的 galgame，无法定位它的资源档案' }
    return galMemSaveBgm(id, String(code ?? ''))
  })
  ipcMain.handle(CH.galBgmSaved, (_e, gameId: string, gameName?: string) =>
    galMemSavedBgm(String(gameId ?? ''), gameName ? String(gameName) : undefined)
  )
  /*
   * V1.1：引擎检测 + 自动解包 + 解析曲名映射。
   * 渲染层只传 gameId / exePath / 游戏名，游戏目录由主进程从 exePath 推导（dirname），
   * 既不用渲染层拼路径，也不会把任意路径交给解包器。全程只读游戏档案。
   */
  ipcMain.handle(CH.galUnpack, async (_e, gameId: string, exePath: string, gameName: string, force?: boolean) => {
    const exe = String(exePath ?? '')
    if (!exe) {
      return { ok: false, engine: '', evidence: [], files: 0, bytes: 0, archives: 0, readableArchives: 0, titles: 0, codes: 0, scripts: 0, sources: [], elapsedMs: 0, error: '这款游戏没有记录 exe 路径，无法定位资源档案' }
    }
    try {
      return await galMemUnpack(String(gameId ?? ''), String(gameName ?? ''), dirname(exe), !!force)
    } catch (err) {
      return { ok: false, engine: '', evidence: [], files: 0, bytes: 0, archives: 0, readableArchives: 0, titles: 0, codes: 0, scripts: 0, sources: [], elapsedMs: 0, error: `解包失败：${String((err as { message?: string })?.message ?? err)}` }
    }
  })
  ipcMain.handle(CH.galUnpackStatus, (_e, gameId: string, exePath: string) => {
    const exe = String(exePath ?? '')
    return galMemUnpackStatus(String(gameId ?? ''), exe ? dirname(exe) : undefined)
  })
  ipcMain.handle(
    CH.galExtractImages,
    async (_e, gameId: string, exePath: string, gameName: string, kind: '立绘' | 'cg', limit?: number) => {
      const exe = String(exePath ?? '')
      const empty = { ok: false, count: 0, candidates: 0, dir: '', files: [] as string[], error: '' }
      if (!exe) return { ...empty, error: '这款游戏没有记录 exe 路径，无法定位资源档案' }
      /*
       * 这里**不要求**开启内存识别：立绘/CG 是从游戏档案里只读取出素材（立绘按坐标表合成），
       * 与"读进程内存"是两条完全独立的链路。之前把它挂在内存识别开关上，
       * 没开内存识别的用户点「提取立绘」会被告知"内存识别未开启"——把两件事错绑在一起了。
       */
      return galMemExtractImages(String(gameId ?? ''), String(gameName ?? ''), dirname(exe), kind, limit ?? 12)
    }
  )
  /*
   * V1.5.2：全部提取 + 资源查看。
   *
   * 与旧 `galExtractImages` 的区别：
   *   · 旧接口带 limit（默认 12），是"候选预览"时代的产物；
   *   · 新接口**不设张数上限**（只在界面侧对 >30 张先弹确认），并把 BGM 也纳入；
   *   · 全部只读游戏档案、只写 `<保存根目录>/<游戏名>/{立绘,cg,bgm}`。
   */
  ipcMain.handle(CH.galExtractPreview, (_e, exePath: string, kind: '立绘' | 'cg' | 'bgm') => {
    const exe = String(exePath ?? '')
    if (!exe) return { kind, candidates: 0, hint: '这款游戏没有记录 exe 路径，无法定位资源档案' }
    return galExtractPreview(dirname(exe), kind)
  })
  ipcMain.handle(
    CH.galExtractAll,
    async (_e, exePath: string, gameName: string, kind: '立绘' | 'cg' | 'bgm') => {
      const exe = String(exePath ?? '')
      if (!exe) {
        return { ok: false, kind, count: 0, candidates: 0, dir: '', error: '这款游戏没有记录 exe 路径，无法定位资源档案', skipped: 0 }
      }
      return galExtractAll({
        gameDir: dirname(exe),
        rootDir: galSaveRootDir(),
        gameName: String(gameName ?? ''),
        kind
      })
    }
  )
  ipcMain.handle(CH.galResources, (_e, gameId: string, gameName: string) =>
    galListResources({
      gameId: String(gameId ?? ''),
      rootDir: galSaveRootDir(),
      gameName: String(gameName ?? '')
    })
  )
  // V1.1：悬浮球「手动刷新」——跳过 2 秒轮询，立刻重扫当前场景（等这一轮扫完再返回，避免拿到旧值）
  ipcMain.handle(CH.galMemRefresh, async (_e, gameId?: string) => {
    const id = String(gameId ?? '') || galRunningInfo()?.gameId || ''
    if (!id) return { ok: false, error: '未检测到正在运行的 galgame' }
    return galMemForceRefresh(id)
  })
  // 最近截图：截图目录 + 各游戏子目录里最新的 30 张（兼容旧版直接放在根目录的截图）
  ipcMain.handle(CH.galRecentShots, () => galRecentShots(30))
  // 某款游戏自己的截图：只读 <截图目录>/<游戏名>/，供游戏卡片上的「最近截图」使用
  ipcMain.handle(CH.galListShots, (_e, gameName: string) => galListShots(String(gameName ?? '')))
  // 站点搜索统计：并行查 7 个资源站，只回「数量 + 跳转链接」，绝不回传站点内容
  ipcMain.handle(CH.galSearchSites, (_e, keyword: string) => galSearchSites(String(keyword ?? '')))
  // V1.5.2：站点清单与按站点生成搜索地址（纯本地常量，不联网）
  ipcMain.handle(CH.galSiteList, () => galSiteList())
  ipcMain.handle(CH.galSiteUrl, (_e, key: string, keyword: string) => galSiteSearchUrl(String(key ?? ''), String(keyword ?? '')))
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
  /*
   * `openPath` 会交给系统外壳打开（资源管理器 / 默认程序），所以不能什么字符串都收
   * （v0.3.9 体检 L7）：当前调用点都是硬编码的下载页 URL 或主进程自己返回的路径，暂时没有风险，
   * 但一旦将来有人把用户可控的字符串接进来（比如"用默认播放器打开这个文件"），
   * `shell.openPath` 就可能变成任意文件/协议的执行入口。这里按 `appOpenUrl` 的思路加白名单：
   * 只允许 http(s) 链接与 Windows 绝对路径，其余一律拒绝并留日志。
   */
  ipcMain.handle(CH.openPath, async (_e, path: string) => {
    const target = String(path ?? '')
    const ok = /^https?:\/\//i.test(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\')
    if (!ok) {
      log.append('warn', 'app', `拒绝打开不在白名单内的路径：${target.slice(0, 80)}`)
      return ''
    }
    return shell.openPath(target)
  })
  ipcMain.handle(CH.cacheInfo, () => getCacheBytes())
  ipcMain.handle(CH.cacheClear, () => {
    // v1.1.4：清磁盘缓存的同时清掉主进程内存里的 L1（否则同一会话仍会读到已删除的旧数据）
    bangumi.clearMemoryCache()
    // V1.5.1：索引也一起重置 —— 否则「清除缓存」之后索引里还留着一堆指向已删除文件的记录，
    // 设置页会显示"有 N 部番的缓存"，但磁盘上一个字节都没有。
    resetCacheDb()
    return clearCache()
  })
  ipcMain.handle(CH.junkClear, () => clearJunk())
  // 自定义缓存目录：保存并 mkdir -p（'' = 恢复默认 <数据根>/cache）
  ipcMain.handle(CH.cacheSetDir, (_e, dir: string) => setCacheDir(dir))
  // V1.5.1 本地缓存数据库
  ipcMain.handle(CH.cacheDbStats, () => cacheDbStats())
  ipcMain.handle(CH.cacheDbEntries, (_e, limit?: number) => cacheDbEntries(Number(limit) || 30))
  ipcMain.handle(CH.cacheDbPrune, () => pruneCacheDbNow())
  ipcMain.handle(CH.cacheDbForget, (_e, id: number) => forgetSubject(Number(id)))
  // V1.5.3：数据源流量监控（快照 / 清空）
  ipcMain.handle(CH.trafficSnapshot, () => trafficSnapshot())
  ipcMain.handle(CH.trafficReset, () => {
    resetTraffic()
    return true
  })
  ipcMain.handle(CH.galDirsGet, () => ({ dir: galToolsGet().dir }))
  ipcMain.handle(CH.galDirsSet, (_e, dir: string) => {
    galToolsSet({ dir })
    return { dir }
  })
  ipcMain.handle(CH.pickDir, async (_e, defaultPath?: string) => pickDirectory(defaultPath))
  ipcMain.handle(CH.libraryLocal, () => scanLocalLibrary())
  /*
   * V1.5.2：附加在线数据源（Apple CMS / REST / AnimePahe / AllManga）。
   * 全部按「失败抛错 → preload 包装成 { ok:false, error }」的既有约定，界面直接 toast 原因。
   */
  ipcMain.handle(CH.onlineSourcesList, () => ({
    meta: ONLINE_SOURCES,
    availability: onlineSourceAvailability()
  }))
  ipcMain.handle(CH.onlineSearch, (_e, source: string, keyword: string) =>
    onlineSearch(source as Parameters<typeof onlineSearch>[0], String(keyword ?? ''))
  )
  ipcMain.handle(CH.onlineEpisodes, (_e, source: string, item: unknown) =>
    onlineEpisodes(source as Parameters<typeof onlineEpisodes>[0], item as Parameters<typeof onlineEpisodes>[1])
  )
  ipcMain.handle(CH.onlineResolve, (_e, source: string, item: unknown, ep: unknown) =>
    onlineResolve(
      source as Parameters<typeof onlineResolve>[0],
      item as Parameters<typeof onlineResolve>[1],
      ep as Parameters<typeof onlineResolve>[2]
    )
  )
  ipcMain.handle(
    CH.libraryLocalDir,
    (_e, input: { subjectId?: number | null; animeTitle?: string } | null | undefined) =>
      localDirForSubject({
        subjectId: Number(input?.subjectId) || null,
        animeTitle: typeof input?.animeTitle === 'string' ? input.animeTitle : ''
      })
  )
  ipcMain.handle(CH.saveDirsInfo, () => saveDirsInfo())
  // 保存目录改动立即生效（建目录 + 同步运行中的下载器 + 媒体白名单）
  ipcMain.handle(CH.saveDirsSet, (_e, patch: Partial<SaveDirsInfo>) => setSaveDirs(patch ?? {}))

  // ---------- v0.2.4：播放状态栏 / 更新检查 / 弹幕 ----------
  /*
   * v0.3.9：在**同一次快照**里补上「播放过程进度」与「嗅探/内核现场读数」。
   *
   * 为什么不塞进 playerInfo.buildStreamInfo 自己算：那会让
   * `playerInfo → playSelfCheck → ruleProbe → playerInfo` 形成 import 环
   * （ruleProbe 需要 playerInfo 的 noteCapturedStream）。环在 ESM 下靠函数提升勉强能跑，
   * 但这属于「能跑但没人敢动」的结构，不值得为省两行代码留下。
   * 组合放在 IPC 边界上，语义也更清楚：详情面板要的是一份「播放现场」的完整快照。
   */
  ipcMain.handle(CH.playerStreamInfo, async () => ({
    ...(await buildStreamInfo()),
    flow: flowSnapshot(),
    selfCheck: selfCheckSnapshotForInfo()
  }))
  /*
   * ---------- v0.3.9：播放过程进度 / 失败原因分析 / 自检重置 ----------
   *
   * 这四条都刻意做成「薄壳」：真正的逻辑在 playFlow / streamDiag / playSelfCheck 三个服务里，
   * IPC 层只负责转一次参数。这样自检脚本（SAKANA_ONLINE_TEST / .e2e/*.mjs）
   * 可以直接 import 那些服务，不必绕过渲染层去伪造一次 IPC 调用。
   */
  ipcMain.handle(CH.playerFlow, () => flowSnapshot())
  ipcMain.handle(CH.playerFlowMark, (_e, mark: PlayFlowMark) => {
    applyMark(mark)
    return true
  })
  ipcMain.handle(CH.playerDiagnose, async (_e, url: string, referer?: string, cookies?: string) => {
    /*
     * ⚠️ 一次性/超短时效的直链**不能探测**（v0.3.9 的关键约束）。
     *
     * 有些站点（实测 aafun 的 `tjdownload.pan.wo.cn/openapi/download?fid=…`）给出的是
     * 一次性下载令牌：**被请求过一次就失效**（完整取证见 ruleProbe.isOneTimeStream 的注释）。
     * 而这条可达性探测是与播放器**并行**跑的 —— 对这类地址探测就等于把令牌烧掉，
     * 播放器随即拿不到数据。那会把「本来能播」变成「播不了」，
     * 属于比不做诊断严重得多的回归。所以这类地址一律跳过，并如实说明跳过了。
     */
    if (isOneTimeStream(url)) {
      const skipped: StreamReachabilityReport = {
        reason: 'none',
        verdict: '这条地址是一次性短效直链，已跳过可达性探测（探测会消耗掉令牌，反而导致播放失败）',
        metrics: { bytes: 0, rateBps: 0, ttfbMs: null }
      }
      flowDetail('acquire', skipped.verdict)
      return skipped
    }
    const outcome = await probeStreamReachability({
      url,
      referer,
      cookies,
      onProgress: (metrics, note) => {
        setMetrics(metrics)
        flowDetail('acquire', note)
      }
    })
    if (outcome.reason !== 'none') {
      if (outcome.reason === 'slow') {
        // 「过慢」不结束播放，只归因（用户明确要求：还有数据在动就继续等）
        noteSlow(outcome.metrics.rateBps, outcome.verdict)
      } else {
        /*
         * ⚠️ v1.2.1：可达性探测是**并行取证**，不是注入的裁判。
         *
         * 上一版在这里直接 `failStage('inject', …)`：探测只要拿不到数据（403/一次性令牌/
         * 本应用网络队列排队超时）就把「注入播放器」判死，而 playFlow 的 settled 会
         * **永久锁住**这个阶段 —— 内核稍后真的解出首帧，succeedStage 也被忽略。
         * 用户看到的就是「所有规则都卡在最后一步」。
         *
         * 现在把证据原样写进阶段步骤：内核真没起来 → 由 playFlow 的 15s 注入看门狗
         * 统一判失败（原因里同样带这些数据）；内核起来了 → 探测结论只作参考。
         */
        pushStep('inject', `资源可达性取证：${outcome.verdict}`)
      }
    }
    const report: StreamReachabilityReport = {
      reason: outcome.reason,
      verdict: outcome.verdict,
      metrics: outcome.metrics,
      container: outcome.container
    }
    return report
  })
  ipcMain.handle(
    CH.playerSelfCheck,
    (_e, opts?: { reset?: boolean; failedPageUrl?: string }) =>
      runPlaySelfCheck({ reset: opts?.reset !== false, failedPageUrl: opts?.failedPageUrl })
  )
  ipcMain.handle(CH.playerHardReset, () => hardResetPlayChain())
  /*
   * v0.3.9：在线播放加速器状态（是否真的在加速 / 并发几路 / 实时速率 / 决策原因）。
   * 与上面几条一样是薄壳：逻辑在 streamBoost.ts，而且**纯内存读**，不触发任何网络请求。
   */
  ipcMain.handle(CH.playerBoostStatus, () => getStreamBoostStatus())
  /*
   * v0.3.9 补充更新：优化记录（最近 N 条真实测量结果 / 清空）。
   * 读取走 store 的一份小 JSON（见 streamBoost 的 RECORD_NS 说明），清空只删这一份记录，不动设置。
   */
  ipcMain.handle(CH.playerBoostRecords, () => getStreamBoostRecords())
  ipcMain.handle(CH.playerBoostClearRecords, () => clearStreamBoostRecords())
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
    async (
      _e,
      title: string,
      episode: number,
      opts?: {
        aliases?: string[]
        aliasMode?: boolean
        sourcesOnly?: boolean
        keyword?: string
        subjectId?: number
        force?: boolean
        trigger?: 'play' | 'test' | 'manual'
      }
    ) => {
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
    (
      _e,
      title: string,
      episode: number,
      opts?: { aliases?: string[]; aliasMode?: boolean; keyword?: string; subjectId?: number; force?: boolean }
    ) => prefetchDanmaku(title, episode, opts)
  )
  // V1.2：获取进度（流详情面板按秒轮询；数据来自主进程真实步骤）
  ipcMain.handle(CH.danmakuProgress, () => progressSnapshot())
  // V1.2：运行期统计（自检断言"第二次进同一集网络请求为 0"）
  ipcMain.handle(CH.danmakuStats, () => ({
    cacheRoot: danmakuCacheRoot(),
    runner: sourceRunnerStats(),
    cache: cacheStats(),
    progress: progressSnapshot()
  }))
  ipcMain.handle(CH.danmakuStatsReset, () => {
    resetSourceRunnerStats()
    progressReset()
    return true
  })

  /* ─────────────── v1.1：弹幕数据源集合器 + 弹幕盒子 + 本地弹幕库 ─────────────── */

  ipcMain.handle(CH.danmakuSourcesGet, () => ({
    sources: listSources(),
    adapters: DANMAKU_ADAPTERS,
    library: libraryInfo()
  }))
  ipcMain.handle(CH.danmakuSourcesSet, (_e, sources: DanmakuSource[]) => saveSources(sources))
  ipcMain.handle(CH.danmakuSourceTest, (_e, source: DanmakuSource, keyword?: string) =>
    testSource(source, keyword)
  )
  ipcMain.handle(CH.danmakuBoxSearch, async (_e, keyword: string) => {
    const list = await danmuboxSearch(keyword)
    log.append('info', 'danmaku', `弹幕盒子搜索「${keyword}」→ ${list.length} 条`)
    return list
  })
  /*
   * 弹幕盒子下载：下载 → 解压 → 取指定集 → 存进本地库，返回落库条目。
   * 这里**不**顺手塞给播放器：这条路是用户在设置页点「下载」用的；
   * 播放时的自动加载走 `loadDanmaku`（它自己会查库、会按优先级用数据源）。
   */
  ipcMain.handle(
    CH.danmakuBoxDownload,
    async (_e, entry: DanmakuBoxEntry, opts?: { title?: string; episode?: number; sourceId?: string }) => {
      const title = opts?.title?.trim() || entry.name
      const episode = Math.max(1, Math.trunc(Number(opts?.episode) || 1))
      const r = await danmuboxFetchEpisode(entry, episode)
      if (r.comments.length === 0) throw new Error('这个包里没有可用的弹幕（解压成功但一条都没解析出来）')
      return saveToLibrary({
        title,
        episode,
        sourceId: opts?.sourceId || 'danmubox',
        sourceName: '弹幕盒子',
        origin: `弹幕盒子：${entry.name}（${entry.from}）${r.detail}`,
        comments: r.comments
      })
    }
  )
  ipcMain.handle(CH.danmakuLibList, () => libraryInfo())
  ipcMain.handle(CH.danmakuLibRemove, (_e, ids: string[]) =>
    removeFromLibrary(Array.isArray(ids) ? ids : [])
  )
  ipcMain.handle(CH.danmakuLibClear, () => clearLibrary())
  ipcMain.handle(CH.danmakuLibSetDir, (_e, dir: string) => {
    const settings = store.get<Record<string, unknown>>('settings', {})
    const prev = (settings.danmaku as Record<string, unknown>) ?? {}
    store.set('settings', { ...settings, danmaku: { ...prev, libraryDir: String(dir ?? '').trim() } })
    return libraryInfo()
  })
  ipcMain.handle(CH.danmakuLibOpenDir, async () => {
    const dir = ensureLibraryDir()
    await shell.openPath(dir)
    return dir
  })
  /*
   * v1.1.2：数据源的「获取记录」。
   * 用户要求「在弹幕设置中加上点击获取弹幕记录」—— 数据源那条链是黑的，
   * 只有把"每次去要弹幕的结果（关键词/耗时/条数/失败原因）"记下来，
   * 才能回答"设置里测试能搜到、播放时却没有源弹幕"这类问题。
   */
  ipcMain.handle(CH.danmakuFetchLog, () => readFetchLog())
  ipcMain.handle(CH.danmakuFetchLogClear, () => ({ removed: clearFetchLog(), records: readFetchLog() }))

  // 自动创建未配置的保存目录（baseDir = userData/saves）
  ensureSaveDirs()
  /*
   * V1.1：把旧版散落在「根目录/游戏名」下的截图挪进「根目录/游戏名/截图」。
   * 与「截图/BGM/立绘/CG」新布局兼容迁移，避免两套目录并存（用户明确要求）；
   * 开机扫一次，用户升级后即使不截图也已经归位。
   */
  try {
    const migrated = migrateAllGalSaves()
    if (migrated > 0) log.append('info', 'gal', `galgame 保存目录已按新布局检查：${migrated} 个游戏目录`)
  } catch (err) {
    log.append('warn', 'gal', `保存目录迁移检查失败（不影响使用）: ${String(err)}`)
  }
  // 启动时恢复galgame 助手（快捷键 + 悬浮窗）
  galToolsInit()
  // 退出前结算游玩时长并回收galgame 助手资源
  app.on('before-quit', () => {
    galgameService.shutdown()
    store.flushAll()
    // V1.5.1：缓存索引是独立文件（不走 store），退出前必须自己落盘
    flushCacheDb()
    galToolsCleanup()
  })
}

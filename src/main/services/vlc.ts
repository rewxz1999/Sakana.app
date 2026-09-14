import { app, BrowserWindow, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CH } from '@shared/channels'
import { VlcPlayer, probeDefaultVlcDir } from 'electron-vlc-player'
import { log } from '../log'
import { getSettings } from '../net'

/**
 * libVLC 播放器管理（electron-vlc-player）
 * - 本地/在线视频全部交给 libVLC：MKV/HEVC/10bit/杜比音轨/内封字幕原生支持
 * - 内建控制条（zh-CN）负责播放/进度/音量/音轨/字幕切换
 * - 渲染层保留顶部条（退出/选集/详情/截屏）与集数抽屉（不覆盖视频区域）
 */

let player: VlcPlayer | null = null
let attachedWin: BrowserWindow | null = null
let embedded = false
let timeTimer: NodeJS.Timeout | null = null
/** attach 串行化：StrictMode/多次调用时共享同一次嵌入，避免互相销毁 */
let attachPromise: Promise<{ ok: boolean; message: string }> | null = null

function bundledVlcDir(): string | null {
  const candidates = [
    join(app.getAppPath(), 'resources', 'libvlc'),
    join(process.resourcesPath ?? '', 'libvlc')
  ]
  for (const p of candidates) {
    if (existsSync(join(p, 'libvlc.dll')) && existsSync(join(p, 'libvlccore.dll'))) return p
  }
  return null
}

function validVlcDir(p: string): boolean {
  return existsSync(join(p, 'libvlc.dll')) && existsSync(join(p, 'libvlccore.dll'))
}

/** 探测非标准安装位置（如 E:\VLC）：遍历磁盘根目录 + 常见子路径 */
function scanDriveVlc(): string | null {
  const subPaths = ['VLC', 'VideoLAN/VLC', 'Program Files/VideoLAN/VLC', 'Program Files (x86)/VideoLAN/VLC']
  for (let c = 65; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`
    for (const sub of subPaths) {
      const p = join(drive, sub)
      if (validVlcDir(p)) return p
    }
  }
  return null
}

export function resolveVlcDir(): string | null {
  // 设置中手动指定的路径优先
  const cfg = getSettings()
  if (cfg.vlcPath && validVlcDir(cfg.vlcPath)) return cfg.vlcPath
  return bundledVlcDir() ?? probeDefaultVlcDir() ?? scanDriveVlc()
}

export function vlcAvailable(): boolean {
  return resolveVlcDir() !== null
}

function sendEvent(win: BrowserWindow | null | undefined, payload: Record<string, unknown>): void {
  // 窗口可能已经销毁（副窗口自愈重建期间），必须同时判空，否则抛 TypeError
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(CH.evVlc, payload)
  }
}

function startTimePump(win: BrowserWindow): void {
  if (timeTimer) clearInterval(timeTimer)
  timeTimer = setInterval(() => {
    if (!player || !embedded) return
    try {
      // 暂停时无需高频推送：进度条位置由渲染层 seek 操作本地同步，减少 IPC 与重渲染
      if (!player.isPlaying()) return
      const time = player.getTime()
      const length = player.getLength()
      sendEvent(win, { type: 'time', time, length, playing: true })
    } catch {
      /* 播放器过渡期忽略 */
    }
  }, 500)
}

function stopTimePump(): void {
  if (timeTimer) {
    clearInterval(timeTimer)
    timeTimer = null
  }
}

/**
 * 光标监听：libVLC 的视频画面渲染在独立子窗口中，鼠标在画面区域移动时
 * 渲染层收不到 mousemove 事件（尤其全屏时画面铺满整屏，控制栏因此唤不出来）。
 * 主进程轮询系统光标位置，位置变化即通知渲染层 poke，从而唤出控制栏。
 */
let cursorTimer: NodeJS.Timeout | null = null
let lastCursor: { x: number; y: number } | null = null

function startCursorWatch(win: BrowserWindow): void {
  stopCursorWatch()
  lastCursor = null
  cursorTimer = setInterval(() => {
    if (!embedded || win.isDestroyed()) return
    try {
      const p = screen.getCursorScreenPoint()
      if (!lastCursor || lastCursor.x !== p.x || lastCursor.y !== p.y) {
        lastCursor = { x: p.x, y: p.y }
        sendEvent(win, { type: 'cursor' })
      }
    } catch {
      /* ignore */
    }
  }, 200)
}

function stopCursorWatch(): void {
  if (cursorTimer) {
    clearInterval(cursorTimer)
    cursorTimer = null
  }
  lastCursor = null
}

/** 嵌入 libVLC 到当前窗口的 #vlc-host 容器 */
export function attachVlc(win: BrowserWindow): Promise<{ ok: boolean; message: string }> {
  if (embedded && player && attachedWin === win) return Promise.resolve({ ok: true, message: '已就绪' })
  // 串行化：并发 attach（StrictMode 双挂载 / 快速重进播放页）共享同一次嵌入
  if (attachPromise) return attachPromise
  const dir = resolveVlcDir()
  if (!dir) {
    return Promise.resolve({
      ok: false,
      message: '未找到 libVLC：请运行 npm run libvlc:fetch 下载内置运行时，或安装 VLC 播放器'
    })
  }
  attachPromise = doAttach(win, dir).finally(() => {
    attachPromise = null
  })
  return attachPromise
}

async function doAttach(
  win: BrowserWindow,
  dir: string
): Promise<{ ok: boolean; message: string }> {
  destroyVlc()
  // 使用局部引用：失败时只清理自己创建的实例（防止旧 attach 的 catch 误伤新实例）
  const p = new VlcPlayer({
    window: win,
    container: '#vlc-host',
    vlcDir: dir,
    locale: 'zh-CN',
    controls: false, // 关闭内置 overlay：上下控制条全部由渲染层自绘（一体化、不遮挡、5 秒自动隐藏）
    pageFullscreenButton: false
  })
  player = p
  try {
    // 必须先 embed 成功，再注册事件（on() 会触发 requirePlayerId）
    await p.embed()
    p.on('playing', () => sendEvent(win, { type: 'playing', playing: true }))
    p.on('paused', () => sendEvent(win, { type: 'paused', playing: false }))
    p.on('stopped', () => sendEvent(win, { type: 'stopped', playing: false }))
    p.on('endReached', () => sendEvent(win, { type: 'ended' }))
    p.on('error', (ev: unknown) =>
      sendEvent(win, { type: 'error', message: String((ev as { message?: string })?.message ?? ev) })
    )
    p.on('lengthChanged', (ev: unknown) => {
      const length = (ev as { length?: number })?.length
      if (typeof length === 'number') sendEvent(win, { type: 'length', length })
    })
    p.on('playlistItemChanged', (ev: unknown) => {
      const index = (ev as { index?: number })?.index
      if (typeof index === 'number') sendEvent(win, { type: 'playlistItem', index })
    })
    embedded = true
    attachedWin = win
    startTimePump(win)
    startCursorWatch(win)
    log.append('info', 'vlc', `libVLC 已嵌入（${dir}）`)
    return { ok: true, message: 'libVLC 已就绪' }
  } catch (err) {
    if (player === p) {
      player = null
      embedded = false
    }
    const msg = err instanceof Error ? err.message : String(err)
    log.append('error', 'vlc', `libVLC 嵌入失败: ${msg}`)
    return { ok: false, message: `libVLC 嵌入失败: ${msg}` }
  }
}

function need(): VlcPlayer {
  if (!player || !embedded) throw new Error('libVLC 尚未就绪')
  return player
}

export function vlcPlay(path: string, referer?: string, cookies?: string): void {
  const p = need()
  const mediaOptions: string[] = []
  if (referer) mediaOptions.push(`:http-referrer=${referer}`)
  mediaOptions.push(':http-user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36')
  // 站点会话 Cookie：部分 CDN 需要它才允许取流
  if (cookies) mediaOptions.push(`:http-cookie=${cookies}`)
  p.setSource(path, { mediaOptions })
}

export function vlcSetPlaylist(paths: string[]): void {
  const p = need()
  p.setPlaylist(paths)
}

export function vlcTogglePause(): void {
  need().togglePause()
}

export function vlcSeekSec(sec: number): void {
  need().setTime(Math.max(0, Math.round(sec * 1000)))
}

export function vlcSetVolume(volume: number): void {
  need().setVolume(Math.max(0, Math.min(100, Math.round(volume))))
}

export function vlcGetState(): { time: number; length: number; playing: boolean; volume: number; muted: boolean } {
  const p = need()
  return {
    time: p.getTime(),
    length: p.getLength(),
    playing: p.isPlaying(),
    volume: p.getVolume(),
    muted: p.getMute()
  }
}

export function vlcSetMute(muted: boolean): void {
  need().setMute(muted)
}

export function vlcSubtitleTracks(): { id: number; label: string }[] {
  try {
    const p = need()
    const tracks = p.getSubtitleTracks()
    return (Array.isArray(tracks) ? tracks : []).map((t) => ({ id: t.id, label: t.name || `字幕 ${t.id}` }))
  } catch {
    return []
  }
}

export function vlcSetSubtitle(id: number): void {
  need().setSubtitleTrack(id)
}

export function vlcAddSubtitleFile(path: string): void {
  need().addSubtitleFile(path)
}

export function vlcSnapshot(path: string): void {
  need().takeSnapshot(path)
}

/**
 * 画面比例：fit=适应 / cover=裁剪铺满 / stretch=拉伸铺满。
 * electron-vlc-player 的高层类没有暴露比例接口，这里直接用它内部的 N-API 绑定
 * （setAspectRatio / setCropGeometry，传空串即恢复自动），失败时静默忽略。
 */
export function vlcSetAspect(
  mode: 'fit' | 'cover' | 'stretch',
  areaW: number,
  areaH: number
): void {
  try {
    if (!player) return
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBinding } = require('electron-vlc-player/dist/native') as {
      getBinding: () => {
        setAspectRatio(id: number, ratio: string): void
        setCropGeometry(id: number, geometry: string): void
      }
    }
    const id = (player as unknown as { playerId?: number }).playerId ?? -1
    if (id < 0) return
    const b = getBinding()
    const w = Math.max(1, Math.round(areaW))
    const h = Math.max(1, Math.round(areaH))
    const area = `${w}:${h}`
    if (mode === 'stretch') {
      b.setCropGeometry(id, '')
      b.setAspectRatio(id, area)
    } else if (mode === 'cover') {
      b.setAspectRatio(id, '')
      b.setCropGeometry(id, area)
    } else {
      b.setAspectRatio(id, '')
      b.setCropGeometry(id, '')
    }
    log.append('info', 'vlc', `画面比例模式: ${mode}（区域 ${area}）`)
  } catch (err) {
    log.append('warn', 'vlc', `设置画面比例失败: ${String((err as Error)?.message ?? err)}`)
  }
}

/** 容器尺寸变化后通知库同步布局（详情/选集抽屉开合时调用） */export function vlcNotifyLayout(): void {
  try {
    player?.notifyLayoutChange()
  } catch {
    /* ignore */
  }
}

export function destroyVlc(): void {
  stopTimePump()
  stopCursorWatch()
  const p = player
  player = null
  embedded = false
  attachedWin = null
  if (p) {
    try {
      p.stop()
    } catch {
      /* ignore */
    }
    try {
      p.destroy()
    } catch {
      /* ignore */
    }
    log.append('info', 'vlc', 'libVLC 已销毁')
  }
}

/** 自检/调试：当前播放状态快照 */
export function getVlcState(): { ready: boolean; playing: boolean; time: number; length: number } | null {
  if (!player || !embedded) return null
  try {
    return {
      ready: true,
      playing: player.isPlaying(),
      time: player.getTime(),
      length: player.getLength()
    }
  } catch {
    return null
  }
}

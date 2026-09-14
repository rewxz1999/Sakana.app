import type { BrowserWindow } from 'electron'
import { getSettings } from '../net'
import { log } from '../log'
import { proxyHlsUrl } from './adFilter'
import {
  attachVlc,
  destroyVlc,
  vlcAddSubtitleFile,
  vlcGetState,
  vlcNotifyLayout,
  vlcPlay,
  vlcSeekSec,
  vlcSetAspect,
  vlcSetMute,
  vlcSetPlaylist,
  vlcSetSubtitle,
  vlcSetVolume,
  vlcSnapshot,
  vlcSubtitleTracks,
  vlcTogglePause
} from './vlc'
import {
  mpvAddSubtitleFile,
  mpvAttach,
  mpvAvailable,
  mpvDestroy,
  mpvGetState,
  mpvNotifyLayout,
  mpvPlay,
  mpvSeekSec,
  mpvSetAspect,
  mpvSetBounds,
  mpvSetMute,
  mpvSetPlaylist,
  mpvSetSubtitle,
  mpvSetVolume,
  mpvSnapshot,
  mpvSubtitleTracks,
  mpvTogglePause
} from './mpv'

/**
 * 播放内核调度器：渲染层只调用一套 API，
 * 由这里按设置（settings.playerEngine）在 libVLC 与 libmpv 之间分发。
 * libmpv 不可用时自动回退 libVLC，保证任何环境下都能播放。
 */

export interface PlayerBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 实际已挂载的内核。
 * 必须记录它：engineAttach 在 libmpv 初始化失败时会回退 libVLC，
 * 若后续仍按"偏好"选 mpv，就会出现「画面挂的是 VLC、播放却调用 mpv」的错配
 * （mpvPlay 抛「libmpv 尚未就绪」、getState 返回 null → 完全不能播）。
 */
let mounted: 'mpv' | 'vlc' | null = null

/** 按设置/自检开关得到"期望使用"的内核（未挂载时的偏好） */
function preferredEngine(): 'mpv' | 'vlc' {
  // 自检/排障：SAKANA_FORCE_ENGINE=mpv|vlc 可临时指定内核，不修改用户设置
  const forced = process.env.SAKANA_FORCE_ENGINE
  if (forced === 'vlc') return 'vlc'
  if (forced === 'mpv') return mpvAvailable() ? 'mpv' : 'vlc'
  const wantMpv = getSettings().playerEngine === 'mpv'
  if (wantMpv && mpvAvailable()) return 'mpv'
  return 'vlc'
}

/** 当前实际使用的内核（已挂载则一律以挂载结果为准） */
export function activeEngine(): 'mpv' | 'vlc' {
  return mounted ?? preferredEngine()
}

export function engineAttach(
  win: BrowserWindow,
  bounds?: PlayerBounds
): Promise<{ ok: boolean; message: string }> {
  const engine = preferredEngine()
  if (engine === 'mpv') {
    const b = bounds ?? { x: 0, y: 56, width: 1280, height: 640 }
    const r = mpvAttach(win, b)
    if (r.ok) {
      mounted = 'mpv'
      return Promise.resolve(r)
    }
    log.append('warn', 'player', `libmpv 启用失败，回退 libVLC: ${r.message}`)
  }
  return attachVlc(win).then((r) => {
    mounted = r.ok ? 'vlc' : null
    return r
  })
}

export function engineSetBounds(bounds: PlayerBounds): void {
  if (activeEngine() === 'mpv') mpvSetBounds(bounds)
}

export function enginePlay(path: string, referer?: string, cookies?: string): void {
  /*
   * HLS 广告过滤的唯一入口：渲染层所有在线播放都走 enginePlay
   * （网页嗅探命中的地址、历史续播、以及 FFmpeg 中转后的本机地址）。
   * 非 .m3u8 输入、过滤关闭、或中转服务未就绪时 proxyHlsUrl 原样返回，
   * 因此这里对本地文件与中转流是零副作用。
   */
  const src = proxyHlsUrl(path, { referer, cookies })
  if (activeEngine() === 'mpv') mpvPlay(src, referer, cookies)
  else vlcPlay(src, referer, cookies)
}

export function engineTogglePause(): void {
  if (activeEngine() === 'mpv') mpvTogglePause()
  else vlcTogglePause()
}

export function engineSeekSec(sec: number): void {
  if (activeEngine() === 'mpv') mpvSeekSec(sec)
  else vlcSeekSec(sec)
}

export function engineSetVolume(volume: number): void {
  if (activeEngine() === 'mpv') mpvSetVolume(volume)
  else vlcSetVolume(volume)
}

export function engineSetMute(muted: boolean): void {
  if (activeEngine() === 'mpv') mpvSetMute(muted)
  else vlcSetMute(muted)
}

export function engineGetState(): {
  time: number
  length: number
  playing: boolean
  volume: number
  muted: boolean
} | null {
  if (activeEngine() === 'mpv') {
    const st = mpvGetState()
    if (!st || !st.ready) return null
    return { time: st.time, length: st.length, playing: !st.paused, volume: st.volume, muted: st.mute }
  }
  return vlcGetState()
}

export function engineSubtitleTracks(): { id: number; label: string }[] {
  return activeEngine() === 'mpv' ? mpvSubtitleTracks() : vlcSubtitleTracks()
}

export function engineSetSubtitle(id: number): void {
  if (activeEngine() === 'mpv') mpvSetSubtitle(id)
  else vlcSetSubtitle(id)
}

export function engineAddSubtitleFile(path: string): void {
  if (activeEngine() === 'mpv') mpvAddSubtitleFile(path)
  else vlcAddSubtitleFile(path)
}

export function engineSnapshot(file: string): void {
  if (activeEngine() === 'mpv') mpvSnapshot(file)
  else vlcSnapshot(file)
}

export function engineNotifyLayout(bounds?: PlayerBounds): void {
  if (bounds) engineSetBounds(bounds)
  if (activeEngine() === 'mpv') mpvNotifyLayout()
  else vlcNotifyLayout()
}

/** 画面比例：fit=适应 / cover=裁剪铺满 / stretch=拉伸铺满 */
export function engineSetAspect(
  mode: 'fit' | 'cover' | 'stretch',
  areaW: number,
  areaH: number
): void {
  if (activeEngine() === 'mpv') mpvSetAspect(mode)
  else vlcSetAspect(mode, areaW, areaH)
}

export function engineDetach(): void {
  // 两个后端都清理，避免切换内核后残留
  mpvDestroy()
  destroyVlc()
  mounted = null
}

export function engineSetPlaylist(paths: string[]): void {
  if (activeEngine() === 'mpv') {
    mpvSetPlaylist(paths)
    return
  }
  vlcSetPlaylist(paths)
}

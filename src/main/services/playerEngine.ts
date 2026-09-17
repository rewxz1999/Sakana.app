import type { BrowserWindow } from 'electron'
import { getSettings } from '../net'
import { proxyHlsUrl } from './adFilter'
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
  mpvSetSpeed,
  mpvSetSubtitle,
  mpvSetVolume,
  mpvSnapshot,
  mpvSubtitleTracks,
  mpvTogglePause
} from './mpv'

/**
 * 播放内核门面（v0.2.9：VLC 内核已整体删除，只保留 libmpv）。
 *
 * 保留这一层的原因：
 * - 渲染层与 IPC 一直只调用这套 `engine*` 接口，视频区域矩形上报、HLS 广告过滤、
 *   字幕/截图/画面比例等**跨切面逻辑**都收敛在这里；
 * - 删掉 VLC 后不需要把这些调用点全部重写（那正是「为了稳定」最不该做的事）。
 *
 * 历史包袱已清掉的部分：内核选择设置（playerEngine）、挂载失败时回退 libVLC 的兜底、
 * `mounted` 状态跟踪 —— 现在只有一个内核，不存在错配问题。
 */

export interface PlayerBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 当前内核：恒定 libmpv（保留函数是为了让调用方与日志继续有单一出处） */
export function activeEngine(): 'mpv' {
  return 'mpv'
}

export function engineAttach(
  win: BrowserWindow,
  bounds?: PlayerBounds
): Promise<{ ok: boolean; message: string }> {
  const b = bounds ?? { x: 0, y: 56, width: 1280, height: 640 }
  return Promise.resolve(mpvAttach(win, b))
}

export function engineSetBounds(bounds: PlayerBounds): void {
  mpvSetBounds(bounds)
}

export function enginePlay(path: string, referer?: string, cookies?: string): void {
  /*
   * HLS 广告过滤的唯一入口：渲染层所有在线播放都走 enginePlay
   * （网页嗅探命中的地址、历史续播、以及 FFmpeg 中转后的本机地址）。
   * 非 .m3u8 输入、过滤关闭、或中转服务未就绪时 proxyHlsUrl 原样返回，
   * 因此这里对本地文件与中转流是零副作用。
   */
  mpvPlay(proxyHlsUrl(path, { referer, cookies }), referer, cookies)
}

export function engineTogglePause(): void {
  mpvTogglePause()
}

export function engineSeekSec(sec: number): void {
  mpvSeekSec(sec)
}

export function engineSetVolume(volume: number): void {
  mpvSetVolume(volume)
}

/** 播放倍速（v0.2.9 最后更新：README 一直宣称有，实际缺失，这里补上） */
export function engineSetSpeed(speed: number): void {
  mpvSetSpeed(speed)
}

export function engineSetMute(muted: boolean): void {
  mpvSetMute(muted)
}

export function engineGetState(): {
  time: number
  length: number
  playing: boolean
  volume: number
  muted: boolean
} | null {
  const st = mpvGetState()
  if (!st || !st.ready) return null
  return { time: st.time, length: st.length, playing: !st.paused, volume: st.volume, muted: st.mute }
}

export function engineSubtitleTracks(): { id: number; label: string }[] {
  return mpvSubtitleTracks()
}

export function engineSetSubtitle(id: number): void {
  mpvSetSubtitle(id)
}

export function engineAddSubtitleFile(path: string): void {
  mpvAddSubtitleFile(path)
}

export function engineSnapshot(file: string): void {
  mpvSnapshot(file)
}

export function engineNotifyLayout(bounds?: PlayerBounds): void {
  if (bounds) engineSetBounds(bounds)
  mpvNotifyLayout()
}

/** 画面比例：fit=适应 / cover=裁剪铺满 / stretch=拉伸铺满 */
export function engineSetAspect(mode: 'fit' | 'cover' | 'stretch'): void {
  mpvSetAspect(mode)
}

export function engineDetach(): void {
  mpvDestroy()
}

export function engineSetPlaylist(paths: string[]): void {
  mpvSetPlaylist(paths)
}

/** 内核运行时是否就绪（libmpv DLL + 原生插件都在）——设置页与自检共用 */
export function engineAvailable(): boolean {
  return mpvAvailable()
}

/** 供设置页显示：当前内核名（固定 mpv） */
export function engineName(): string {
  const s = getSettings() as unknown as { playerEngine?: string }
  // 兼容历史设置文件里残留的 playerEngine 字段：不再影响行为，仅用于日志提示
  return s.playerEngine === 'vlc' ? 'mpv（已移除 VLC 内核，强制使用 libmpv）' : 'libmpv'
}

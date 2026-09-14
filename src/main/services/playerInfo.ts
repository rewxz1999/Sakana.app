import type { StreamInfo } from '@shared/types'
import { log } from '../log'
import { httpGetText } from '../net'
import { activeEngine } from './playerEngine'
import { mpvStreamProps } from './mpv'

/**
 * 当前播放流的登记处（v0.2.4 播放状态栏）。
 *
 * 嗅探到地址的那一层（`ruleProbe` 的 webRequest/CDP 分支、`ruleWebview` 的网页播放器分支）
 * 只知道自己抓到了什么；播放内核知道的是分辨率/编码/码率。
 * 这里做一处极小的登记 + 汇总，供 `player:stream-info` 一次性返回给渲染层。
 */

export interface CapturedStream {
  url: string
  kind: string
  referer?: string
  /** 来源：direct / webRequest / cdp / media */
  channel?: string
  capturedAt: number
}

let last: CapturedStream | null = null

export function noteCapturedStream(s: CapturedStream): void {
  last = s
}

export function lastCapturedStream(): CapturedStream | null {
  return last
}

export function clearCapturedStream(): void {
  last = null
}

/** 解析 m3u8：主列表取首个变体的分辨率/带宽/编码，媒体列表累加时长 */
export function parseM3u8(text: string): {
  width?: number
  height?: number
  videoBitrate?: number
  bitrate?: number
  videoCodec?: string
  audioCodec?: string
  durationSec?: number
} {
  const out: {
    width?: number
    height?: number
    videoBitrate?: number
    bitrate?: number
    videoCodec?: string
    audioCodec?: string
    durationSec?: number
  } = {}
  const streamInf = /#EXT-X-STREAM-INF:([^\n\r]+)/i.exec(text)
  if (streamInf) {
    const attrs = streamInf[1]
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(attrs)
    if (res) {
      out.width = Number(res[1])
      out.height = Number(res[2])
    }
    const bw = /AVERAGE-BANDWIDTH=(\d+)/i.exec(attrs) ?? /BANDWIDTH=(\d+)/i.exec(attrs)
    if (bw) out.bitrate = Number(bw[1])
    const codecs = /CODECS="([^"]+)"/i.exec(attrs)
    if (codecs) {
      const list = codecs[1].split(',').map((s) => s.trim())
      const v = list.find((c) => /^(avc|hvc|hev|vp0?9|av01)/i.test(c))
      const a = list.find((c) => /^(mp4a|ac-3|ec-3|opus|flac)/i.test(c))
      if (v) out.videoCodec = v
      if (a) out.audioCodec = a
    }
  }
  // 媒体列表：累加 #EXTINF
  const extinf = [...text.matchAll(/#EXTINF:([\d.]+)/gi)]
  if (extinf.length > 0 && !streamInf) {
    out.durationSec = extinf.reduce((n, m) => n + (Number.parseFloat(m[1]) || 0), 0)
  }
  return out
}

/** 汇总出一个可展示的流详情快照 */
export async function buildStreamInfo(): Promise<StreamInfo> {
  const cur = lastCapturedStream()
  const info: StreamInfo = {
    url: cur?.url ?? '',
    kind: cur?.kind ?? '',
    referer: cur?.referer,
    channel: cur?.channel,
    capturedAt: cur?.capturedAt,
    engine: activeEngine()
  }
  if (!cur?.url) {
    info.message = '当前没有已捕获的在线流（本地播放或尚未开始嗅探）'
    return info
  }

  // 播放列表文本 + 分辨率/码率（HLS 主列表里带着这些信息，两个内核都通用）
  if (/\.m3u8(\?|$)/i.test(cur.url) || cur.kind === 'm3u8') {
    try {
      const text = await httpGetText(cur.url, 8000, {
        headers: cur.referer ? { Referer: cur.referer } : {}
      })
      info.playlist = text.slice(0, 4000)
      const parsed = parseM3u8(text)
      if (parsed.width) info.width = parsed.width
      if (parsed.height) info.height = parsed.height
      if (parsed.bitrate) info.bitrate = parsed.bitrate
      if (parsed.videoBitrate) info.videoBitrate = parsed.videoBitrate
      if (parsed.videoCodec) info.videoCodec = parsed.videoCodec
      if (parsed.audioCodec) info.audioCodec = parsed.audioCodec
      if (info.width && info.bitrate) info.videoBitrate = info.videoBitrate ?? info.bitrate
    } catch (err) {
      info.message = `播放列表读取失败：${String((err as Error)?.message ?? err).slice(0, 120)}`
    }
  }

  // 内核给出的实际解码参数更可信，覆盖播放列表里的声明值
  if (info.engine === 'mpv') {
    const props = mpvStreamProps()
    if (props) {
      info.width = props.width ?? info.width
      info.height = props.height ?? info.height
      info.videoCodec = props.videoCodec ?? info.videoCodec
      info.audioCodec = props.audioCodec ?? info.audioCodec
      info.fps = props.fps
      info.videoBitrate = props.videoBitrate ?? info.videoBitrate
      info.audioBitrate = props.audioBitrate
    }
  }
  log.append('info', 'player-info', `流详情：${info.width ?? '?'}x${info.height ?? '?'} ${info.videoCodec ?? '?'}`)
  return info
}

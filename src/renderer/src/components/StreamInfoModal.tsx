import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import type { StreamInfo } from '@shared/types'
import { api } from '@/lib/api'
import { Spinner } from '@/components/ui'

/**
 * 播放状态栏点开后的「流详情」弹窗（v0.2.4）。
 *
 * 展示嗅探到的媒体地址、播放列表原文、分辨率与编码/码率参数。
 * 数据全部来自主进程 `player:stream-info`（嗅探登记处 + 播放内核属性 + m3u8 解析），
 * 渲染层只负责显示，不做任何解析，避免两处口径不一致。
 *
 * 之所以做成独立组件：控制栏有两套实现（页面内控制栏、全屏/小窗用的透明悬浮窗），
 * 两边都要能弹出同一个详情面板，悬浮窗那边拿不到播放页的 state。
 */
export function StreamInfoModal({
  open,
  onClose,
  extraLog
}: {
  open: boolean
  onClose: () => void
  /** 播放页额外提供的状态流水（悬浮窗里为空） */
  extraLog?: string[]
}) {
  const [info, setInfo] = useState<StreamInfo | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await api.player.streamInfo()
    setLoading(false)
    // 失败也把错误显示出来，方便用户反馈「为什么播不了」
    setInfo(r.ok ? r.data : { url: '', kind: '', message: r.error })
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  if (!open) return null

  const row = (label: string, value: string | number | undefined | null): React.ReactElement | null =>
    value === undefined || value === null || value === '' ? null : (
      <div className="flex gap-2 py-0.5 text-[11px]">
        <span className="w-20 shrink-0 text-faint">{label}</span>
        <span className="min-w-0 flex-1 break-all text-dim">{String(value)}</span>
      </div>
    )

  const bitrate = (v?: number): string | null =>
    !v ? null : v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)} Mbps` : `${Math.round(v / 1000)} kbps`

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-full w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-elev1 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold text-text">播放状态 · 流详情</span>
          <div className="flex items-center gap-2">
            <button
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-dim transition-colors hover:bg-elev2 hover:text-text"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? <Spinner size={12} /> : <RefreshCw size={12} />} 刷新
            </button>
            <button className="rounded-md p-1 text-dim hover:bg-elev2 hover:text-text" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {info?.message ? (
            <div className="mb-2 rounded-lg bg-warn/15 px-2 py-1.5 text-[11px] text-warn">{info.message}</div>
          ) : null}
          {row('媒体地址', info?.url)}
          {row('类型', info?.kind)}
          {row('嗅探来源', info?.channel)}
          {row('播放内核', info?.engine)}
          {row('分辨率', info?.width && info?.height ? `${info.width}×${info.height}` : undefined)}
          {row('帧率', info?.fps ? `${info.fps} fps` : undefined)}
          {row('视频编码', info?.videoCodec)}
          {row('音频编码', info?.audioCodec)}
          {row('总码率', bitrate(info?.bitrate))}
          {row('视频码率', bitrate(info?.videoBitrate))}
          {row('音频码率', bitrate(info?.audioBitrate))}
          {row('Referer', info?.referer === '' ? '(不带 Referer)' : info?.referer)}
          {row('捕获时间', info?.capturedAt ? new Date(info.capturedAt).toLocaleString() : undefined)}
          {extraLog && extraLog.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1 text-[11px] font-medium text-faint">状态记录</div>
              <div className="max-h-32 overflow-y-auto rounded-lg bg-elev2 p-2 font-mono text-[10px] leading-relaxed text-dim">
                {extraLog.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </div>
          ) : null}
          {info?.playlist ? (
            <div className="mt-3">
              <div className="mb-1 text-[11px] font-medium text-faint">播放列表（前 4000 字符）</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-elev2 p-2 font-mono text-[10px] leading-relaxed text-dim">
                {info.playlist}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

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
  /** 内核的实时状态（播放中/进度/倍速/音量）：这是「播放状态详情」里唯一每秒都在变的部分 */
  const [state, setState] = useState<{
    time: number
    length: number
    playing: boolean
    volume: number
    muted: boolean
  } | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)
  /**
   * 画面子窗口的现场（v0.3.7）。
   *
   * 为什么要显示它：视频是主窗口里的**原生子窗口**，不是网页画的 ——
   * 「正在播放但没有画面」这类问题在界面上完全看不出来，只能问窗口层。
   * 这里把子窗口的位置/尺寸与「画面中心点上谁在最上层」一并显示，
   * 出问题时用户截个图就能定位（是窗口没了、尺寸错了、还是被别的窗口盖住了）。
   */
  const [surface, setSurface] = useState<{
    bounds: { x: number; y: number; width: number; height: number } | null
    hit: { hitClass: string; isOurChild: boolean } | null
  } | null>(null)

  /**
   * 拉一次快照。
   *
   * `silent` 用于轮询：不显示 loading（否则每秒闪一次转圈），也不清掉已有内容 ——
   * 面板要保持「一直有数据、数字在动」的观感，而不是每秒重画一次白板。
   */
  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true)
    const [r, st, sd] = await Promise.all([
      api.player.streamInfo(),
      api.player.getState(),
      api.player.surfaceDebug().catch(() => null)
    ])
    if (!silent) setLoading(false)
    // 失败也把错误显示出来，方便用户反馈「为什么播不了」
    setInfo(r.ok ? r.data : { url: '', kind: '', message: r.error })
    if (st.ok) setState(st.data)
    if (sd && sd.ok) setSurface({ bounds: sd.data.bounds, hit: sd.data.hit })
    setUpdatedAt(Date.now())
  }, [])

  /*
   * 实时刷新（v0.3.7）。
   *
   * 用户反馈「播放状态详情更新不及时」：过去这个面板只在**打开的那一瞬间**取一次快照，
   * 之后除非手动点「刷新」，否则分辨率/码率/进度都停在那一刻 —— 换线路、切集之后看到的还是旧值。
   * 现在打开期间按 1 秒轮询：内核状态（进度/暂停/倍速）每秒都变，流信息（列表/码率）由主进程
   * 用 10 秒短缓存兜住，所以这里的轮询不会变成对源站的持续请求（见 playerInfo.getPlaylistText）。
   */
  useEffect(() => {
    if (!open) return
    void load(false)
    const timer = window.setInterval(() => void load(true), 1000)
    return () => window.clearInterval(timer)
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

  /** 秒 → 0:00 / 1:02:03 */
  const clock = (sec?: number): string | undefined => {
    if (sec == null || !Number.isFinite(sec) || sec < 0) return undefined
    const s = Math.floor(sec % 60)
    const m = Math.floor((sec / 60) % 60)
    const h = Math.floor(sec / 3600)
    const two = (n: number): string => String(n).padStart(2, '0')
    return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
  }

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
          <span className="flex items-center gap-2 text-sm font-semibold text-text">
            播放状态 · 流详情
            {/* 说清这个面板是活的，免得用户以为要手动刷新 */}
            <span className="rounded-full bg-ok/15 px-1.5 py-0.5 text-[10px] font-normal text-ok">实时</span>
            {updatedAt ? (
              <span className="text-[10px] font-normal text-faint">
                更新于 {new Date(updatedAt).toLocaleTimeString()}
              </span>
            ) : null}
          </span>
          <div className="flex items-center gap-2">
            <button
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-dim transition-colors hover:bg-elev2 hover:text-text whitespace-nowrap"
              onClick={() => void load(false)}
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
          {/*
            实时状态放在最前面：这是面板里唯一「每秒都在动」的一组数字，
            也是用户打开这个面板最想看的东西（在播吗？播到哪了？）
          */}
          <div className="mb-2 rounded-lg bg-elev2 px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
              <span className={state?.playing ? 'text-ok' : 'text-dim'}>
                {state?.playing ? '● 播放中' : state ? '‖ 已暂停/未开播' : '— 未取到内核状态'}
              </span>
              <span className="text-dim">
                进度 {clock(state?.time) ?? '—'} / {clock(state?.length) ?? '—'}
              </span>
              <span className="text-dim">
                音量 {state?.muted ? '静音' : `${state?.volume ?? '—'}%`}
              </span>
            </div>
          </div>
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
          {/*
            画面窗口一行：查「正在播放但没有画面」的关键证据。
            「顶层」应当是我们的视频窗口（isOurChild=1）；显示成 Chromium 的网页窗口
            就说明画面被页面/探针窗口盖住了。
          */}
          {row(
            '画面窗口',
            surface?.bounds
              ? `${surface.bounds.width}×${surface.bounds.height} @ (${surface.bounds.x},${surface.bounds.y}) · 顶层 ${surface.hit ? `${surface.hit.hitClass}${surface.hit.isOurChild ? '（我们的画面）' : '（被它盖住）'}` : '未知'}`
              : '未挂载原生画面窗口'
          )}
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

import { useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import {
  Camera,
  Cast,
  Crop,
  Expand,
  Info,
  ListVideo,
  LogOut,
  Maximize,
  MessageSquareOff,
  MessagesSquare,
  Minimize,
  Pause,
  Play,
  RectangleHorizontal,
  Rewind,
  FastForward,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Subtitles,
  Volume1,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import type { OverlayAction, OverlayDanmaku, OverlayState } from '@shared/api'
import type { Anime4kSettings, AspectMode, PlayFlowSnapshot } from '@shared/types'
import { ANIME4K_MODES, ANIME4K_TIERS } from '@shared/anime4k'
import { PlayFlowStages } from '@/components/PlayFlowProgress'

/**
 * 旧的自绘控制栏（v1.1.4 起**已停用**，仅作为实现保留）。
 *
 * 为什么还要留着这个文件：
 *   用户明确要求「不要删除这些代码」——它是 uosc 之外唯一一套完整控制栏
 *   （顶栏 + 底栏 + 字幕/倍速/比例/弹幕/画质五个 popover），里面有不少交互细节
 *   （进度条拖动节流、200% 音量滑杆、画质角标、投屏入口）是踩坑换来的。
 *   真要回退时直接 import 这个组件即可，不必从 git 历史里翻。
 *
 * 为什么默认不渲染：
 *   v1.1.4 工单要求 uosc 是**唯一**控制栏。`PlayerOverlayPage` 里已经不再引用本文件；
 *   原位置只留一句说明。这个组件**没有**被任何地方 import —— 它只是编译期存在的备份，
 *   不会出现在界面上，也不会再抢 mpv 的鼠标。
 *
 * ⚠️ 如果哪天要重新启用它，必须同时把 `PlayerPage` 的 `uoscBarMode` 改成可配置，
 *    否则会出现「uosc 画一条 + 这条也画一条」的双控制栏。
 */

const ASPECT_LABEL: Record<AspectMode, string> = {
  fit: '适应',
  cover: '裁剪铺满',
  stretch: '拉伸铺满'
}

const A4K_SHORT: Record<string, string> = Object.fromEntries(ANIME4K_MODES.map((m) => [m.id, m.short]))

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

const VOLUME_UI_MAX = 200

function VolumeSlider({ volume, onSet }: { volume: number; onSet: (v: number) => void }): ReactElement {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const v = Math.max(0, Math.min(VOLUME_UI_MAX, volume))
  const hundredPct = 100 / (VOLUME_UI_MAX / 100)

  const applyFromEvent = (clientX: number): void => {
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const ratio = r.width > 0 ? (clientX - r.left) / r.width : 0
    onSet(Math.round(Math.max(0, Math.min(1, ratio)) * VOLUME_UI_MAX))
  }

  const Icon = v === 0 ? VolumeX : v > 50 ? Volume2 : Volume1
  return (
    <div className="ml-1 flex items-center gap-1.5" title={`音量 ${v}%`}>
      <Icon size={16} className="shrink-0 text-white/80" />
      <div
        ref={trackRef}
        data-sakana-volume={v}
        className="group relative flex h-6 w-[76px] cursor-pointer items-center"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.stopPropagation()
          try {
            ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
          } catch {
            /* 忽略：拿不到捕获也不影响按位置计算音量 */
          }
          setDragging(true)
          applyFromEvent(e.clientX)
        }}
        onPointerMove={(e) => {
          if (!dragging) return
          e.stopPropagation()
          applyFromEvent(e.clientX)
        }}
        onPointerUp={(e) => {
          if (!dragging) return
          e.stopPropagation()
          setDragging(false)
          applyFromEvent(e.clientX)
        }}
        onPointerCancel={() => setDragging(false)}
      >
        <div className="h-1 w-full overflow-hidden rounded-full bg-white/25">
          <div className="h-full rounded-full bg-white/85" style={{ width: `${(v / VOLUME_UI_MAX) * 100}%` }} />
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-white/45"
          style={{ left: `${hundredPct}%` }}
        />
        <div
          className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow transition-opacity ${
            dragging ? 'opacity-100' : 'opacity-80 group-hover:opacity-100'
          }`}
          style={{ left: `calc(${(v / VOLUME_UI_MAX) * 100}% - 6px)` }}
        />
      </div>
      <span className="w-9 shrink-0 text-[11px] tabular-nums text-white/60">{v}%</span>
    </div>
  )
}

const SPEED_CHOICES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]
const fmtSpeed = (s: number): string => `${Number.isInteger(s) ? s.toFixed(1) : s}x`

function Chip({
  active,
  onClick,
  children
}: {
  active?: boolean
  onClick: () => void
  children: ReactNode
}): ReactElement {
  return (
    <button
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        onClick()
      }}
      className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
        active ? 'border-accent bg-accent/30 text-white' : 'border-white/20 text-white/70 hover:bg-white/10'
      } whitespace-nowrap `}
    >
      {children}
    </button>
  )
}

function SettingRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] text-white/55">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  )
}

function IconBtn({
  title,
  onClick,
  children,
  active
}: {
  title: string
  onClick: () => void
  children: ReactNode
  active?: boolean
}): ReactElement {
  return (
    <button
      title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        onClick()
      }}
      className={`flex h-10 w-10 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/20 hover:text-white active:bg-white/30 ${
        active ? 'bg-white/20 text-white' : ''
      } whitespace-nowrap `}
    >
      {children}
    </button>
  )
}

export interface PlayerOverlayBarProps {
  state: OverlayState | null
  danmaku: OverlayDanmaku | null
  a4k: Anime4kSettings
  flow?: PlayFlowSnapshot | null
  visible: boolean
  castActive: boolean
  /** 投屏面板是否打开（旧栏的按钮高亮；真正的面板仍在 PlayerOverlayPage 里） */
  castPanel?: boolean
  castDeviceName: string
  onSend: (action: OverlayAction) => void
  onPatchA4k: (patch: Partial<Anime4kSettings>) => void
  onShowStreamInfo: () => void
  onToggleCastPanel: () => void
  onRefreshCastDevices: () => void
}

/**
 * 顶栏 + 底栏 + 全部 popover。`visible` 仍由调用方控制（5 秒自动隐藏）。
 *
 * 注意这里**没有** `uoscBar` 开关：这个组件本身就是"非 uosc 模式"的实现，
 * 调用方要么渲染它、要么不渲染；再叠一个开关只会制造第三种状态。
 */
export default function PlayerOverlayBar({
  state,
  danmaku,
  a4k,
  flow,
  visible,
  castActive,
  castPanel = false,
  castDeviceName,
  onSend,
  onPatchA4k,
  onShowStreamInfo,
  onToggleCastPanel,
  onRefreshCastDevices
}: PlayerOverlayBarProps): ReactElement {
  const [subMenu, setSubMenu] = useState(false)
  const [aspectMenu, setAspectMenu] = useState(false)
  const [speedMenu, setSpeedMenu] = useState(false)
  const [danmakuMenu, setDanmakuMenu] = useState(false)
  const [qualityMenu, setQualityMenu] = useState(false)
  const seekRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dragPercent, setDragPercent] = useState<number | null>(null)
  const lastSeekAtRef = useRef(0)

  const duration = state?.duration ?? 0
  const current = state?.current ?? 0
  const shownPercent =
    dragging && dragPercent !== null ? dragPercent : duration > 0 ? Math.min(100, (current / duration) * 100) : 0
  const displayedTime = dragging && dragPercent !== null ? (dragPercent / 100) * duration : current
  const currentSubId = state && state.subIdx >= 0 ? state.subs[state.subIdx]?.id : undefined

  const a4kEnabled = a4k.enabled === true
  const a4kMode = a4k.mode ?? 'A'
  const a4kTier = a4k.tier ?? 'fast'
  const a4kShort = A4K_SHORT[a4kMode] ?? a4kMode

  const ratioFromEvent = (clientX: number): number => {
    const el = seekRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }

  /**
   * 拖动时真正下发 seek（节流 120ms）。
   * 一次 seek 在 mpv 侧是"冲刷解复用器 + 重新定位"的重动作，拖一下发几十次会卡。
   */
  const seekTo = (sec: number, force = false): void => {
    if (!Number.isFinite(sec) || sec < 0) return
    const now = Date.now()
    if (!force && now - lastSeekAtRef.current < 120) return
    lastSeekAtRef.current = now
    onSend({ type: 'seek', time: sec })
  }

  return (
    <>
      {/* 顶部：退出 / 标题 / 状态 / 详情 / 截图 */}
      <div
        data-sakana-hit="1"
        data-sakana-topbar="1"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        className={`absolute inset-x-0 top-0 z-30 flex h-14 items-center justify-between bg-gradient-to-b from-black/70 via-black/25 to-transparent px-2 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <IconBtn
          title={state?.fullscreen ? '退出全屏' : '退出播放'}
          onClick={() => onSend({ type: state?.fullscreen ? 'exitFullscreen' : 'exitPlayer' })}
        >
          <X size={22} />
        </IconBtn>
        <div className="pointer-events-none min-w-0 flex-1 px-2">
          <div className="truncate text-sm font-medium text-white drop-shadow">{state?.title ?? ''}</div>
          <div className="truncate text-[10px] text-white/60">{state?.subtitle ?? ''}</div>
        </div>
        {/* 状态药丸：点击查看流详情（地址/播放列表/分辨率/码率） */}
        <button
          title="查看播放状态与流详情"
          data-sakana-hit="1"
          onPointerDown={(e) => {
            e.stopPropagation()
            onShowStreamInfo()
          }}
          className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11px] transition-colors ${
            state?.status.kind === 'failed'
              ? 'bg-danger/30 text-white hover:bg-danger/45'
              : 'bg-white/15 text-white hover:bg-white/30'
          } whitespace-nowrap `}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              state?.status.kind === 'playing'
                ? 'bg-ok'
                : state?.status.kind === 'failed'
                  ? 'bg-danger'
                  : 'animate-pulse bg-warn'
            }`}
          />
          {flow && flow.running && state?.startedOnce && !state.error ? (
            <PlayFlowStages flow={flow} compact tone="onVideo" />
          ) : (
            (state?.status.text ?? '加载中')
          )}
        </button>
        <div className="flex items-center gap-1">
          <IconBtn title="番剧详情" onClick={() => onSend({ type: 'toggleInfo' })}>
            <Info size={20} />
          </IconBtn>
          <IconBtn title="截图" onClick={() => onSend({ type: 'snapshot' })}>
            <Camera size={20} />
          </IconBtn>
        </div>
      </div>

      {/* 底部：进度条 + 控制按钮（弹幕设置面板也挂在这条容器里） */}
      <div
        data-sakana-hit="1"
        data-sakana-bottombar="1"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        className={`absolute inset-x-0 bottom-0 z-30 flex flex-col gap-1 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-3 pb-2 pt-6 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {/* 弹幕设置面板（覆盖区域 / 弹幕数量 / 时间轴 / 别名检测 + 更多设置） */}
        {danmakuMenu ? (
          <div
            data-sakana-hit="1"
            data-sakana-popover="1"
            className="absolute bottom-[86px] right-3 z-40 w-80 rounded-xl border border-white/15 bg-black/85 p-3 text-white shadow-2xl backdrop-blur"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium">弹幕设置</span>
              <button
                className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  setDanmakuMenu(false)
                }}
              >
                <X size={14} />
              </button>
            </div>
            {danmaku ? (
              <>
                <div className="mb-1 text-[10px] text-white/45">
                  {danmaku.source ? `来源：${danmaku.source}` : '未匹配到弹幕库条目'}
                </div>
                <SettingRow label="覆盖区域">
                  {[
                    { v: 0.25, t: '1/4' },
                    { v: 0.5, t: '1/2' },
                    { v: 0.75, t: '3/4' },
                    { v: 1, t: '全屏' }
                  ].map((o) => (
                    <Chip
                      key={o.t}
                      active={Math.abs(danmaku.settings.area - o.v) < 0.01}
                      onClick={() => onSend({ type: 'danmakuSetting', key: 'area', value: o.v })}
                    >
                      {o.t}
                    </Chip>
                  ))}
                </SettingRow>
                <SettingRow label="弹幕数量">
                  {[10, 20, 30, 50, 80].map((n) => (
                    <Chip
                      key={n}
                      active={danmaku.settings.maxCount === n}
                      onClick={() => onSend({ type: 'danmakuSetting', key: 'maxCount', value: n })}
                    >
                      {n}
                    </Chip>
                  ))}
                </SettingRow>
                <SettingRow label="时间轴">
                  <Chip onClick={() => onSend({ type: 'danmakuSetting', key: 'offsetMs', value: danmaku.settings.offsetMs - 500 })}>
                    −0.5s
                  </Chip>
                  <span className="min-w-[52px] text-center text-[11px] tabular-nums text-white/80">
                    {(danmaku.settings.offsetMs / 1000).toFixed(1)}s
                  </span>
                  <Chip onClick={() => onSend({ type: 'danmakuSetting', key: 'offsetMs', value: danmaku.settings.offsetMs + 500 })}>
                    +0.5s
                  </Chip>
                  <Chip active={danmaku.settings.offsetMs === 0} onClick={() => onSend({ type: 'danmakuSetting', key: 'offsetMs', value: 0 })}>
                    重置
                  </Chip>
                </SettingRow>
                <SettingRow label="显示类型">
                  <Chip
                    active={danmaku.settings.showScroll}
                    onClick={() => onSend({ type: 'danmakuSetting', key: 'showScroll', value: !danmaku.settings.showScroll })}
                  >
                    滚动
                  </Chip>
                  <Chip
                    active={danmaku.settings.showTop}
                    onClick={() => onSend({ type: 'danmakuSetting', key: 'showTop', value: !danmaku.settings.showTop })}
                  >
                    顶部
                  </Chip>
                  <Chip
                    active={danmaku.settings.showBottom}
                    onClick={() => onSend({ type: 'danmakuSetting', key: 'showBottom', value: !danmaku.settings.showBottom })}
                  >
                    底部
                  </Chip>
                </SettingRow>
                {danmaku.pluginActive ? (
                  <SettingRow label="插件菜单">
                    <Chip onClick={() => onSend({ type: 'uoscMenu', key: 'search' })}>搜索弹幕</Chip>
                    <Chip onClick={() => onSend({ type: 'uoscMenu', key: 'style' })}>弹幕样式</Chip>
                    <Chip onClick={() => onSend({ type: 'uoscMenu', key: 'delay' })}>源延迟</Chip>
                    <Chip onClick={() => onSend({ type: 'uoscMenu', key: 'total' })}>总菜单</Chip>
                  </SettingRow>
                ) : null}
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/10 pt-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className="rounded-md border border-white/20 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10 whitespace-nowrap"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        onSend({ type: 'detectDanmakuAlias' })
                      }}
                    >
                      别名检测弹幕
                    </button>
                    <button
                      className="rounded-md border border-white/20 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10 whitespace-nowrap"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        onSend({ type: 'reloadDanmaku' })
                      }}
                    >
                      重新检测弹幕
                    </button>
                  </div>
                  <button
                    className="shrink-0 text-[11px] text-accent hover:underline whitespace-nowrap"
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      onSend({ type: 'openDanmakuSettings' })
                    }}
                  >
                    更多设置 ›
                  </button>
                </div>
              </>
            ) : (
              <div className="py-3 text-center text-[11px] text-white/60">弹幕数据还没到，稍候…</div>
            )}
          </div>
        ) : null}

        <div
          ref={seekRef}
          data-sakana-hit="1"
          data-sakana-seek="1"
          className="group relative flex h-6 cursor-pointer items-center"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            try {
              ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
            } catch {
              /* 拿不到捕获也不影响按位置计算进度 */
            }
            setDragging(true)
            const r = ratioFromEvent(e.clientX)
            setDragPercent(r * 100)
            seekTo(r * duration, true)
          }}
          onPointerMove={(e) => {
            if (!dragging) return
            e.stopPropagation()
            const r = ratioFromEvent(e.clientX)
            setDragPercent(r * 100)
            seekTo(r * duration, false)
          }}
          onPointerUp={(e) => {
            if (!dragging) return
            e.stopPropagation()
            setDragging(false)
            const r = ratioFromEvent(e.clientX)
            setDragPercent(null)
            seekTo(r * duration, true)
          }}
          onPointerCancel={() => {
            setDragging(false)
            setDragPercent(null)
          }}
        >
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/25">
            <div className="h-full rounded-full bg-accent" style={{ width: `${shownPercent}%` }} />
          </div>
          <div
            className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow"
            style={{ left: `calc(${shownPercent}% - 7px)` }}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-0.5">
            <IconBtn title="播放/暂停" onClick={() => onSend({ type: 'playPause' })}>
              {state?.playing ? <Pause size={20} /> : <Play size={20} fill="currentColor" />}
            </IconBtn>
            <IconBtn title="上一集" onClick={() => onSend({ type: 'prevEpisode' })}>
              <SkipBack size={18} />
            </IconBtn>
            <IconBtn title="下一集" onClick={() => onSend({ type: 'nextEpisode' })}>
              <SkipForward size={18} />
            </IconBtn>
            <IconBtn title="后退 10 秒" onClick={() => onSend({ type: 'back10' })}>
              <Rewind size={18} />
            </IconBtn>
            <IconBtn title="前进 10 秒" onClick={() => onSend({ type: 'forward10' })}>
              <FastForward size={18} />
            </IconBtn>
            <span className="ml-1 text-[11px] tabular-nums text-white/80">
              {fmt(displayedTime)} / {fmt(duration)}
            </span>
            <VolumeSlider volume={state?.volume ?? 0} onSet={(nv) => onSend({ type: 'setVolume', value: nv })} />
          </div>

          <div className="flex items-center gap-0.5">
            <IconBtn title="选集" onClick={() => onSend({ type: 'toggleEpisodes' })}>
              <ListVideo size={18} />
            </IconBtn>

            {/* 字幕 */}
            <div className="relative">
              <IconBtn
                title="字幕"
                active={subMenu}
                onClick={() => {
                  setSubMenu(!subMenu)
                  setAspectMenu(false)
                }}
              >
                <Subtitles size={18} />
              </IconBtn>
              {subMenu && (
                <div
                  data-sakana-hit="1"
                  data-sakana-popover="1"
                  className="absolute bottom-12 right-0 z-40 max-h-64 w-48 overflow-y-auto rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur"
                >
                  <button
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 whitespace-nowrap"
                    onClick={() => {
                      onSend({ type: 'cycleSubtitle' })
                      setSubMenu(false)
                    }}
                  >
                    切换字幕（下一轨 / 关闭）
                  </button>
                  {(state?.subs ?? []).length === 0 ? (
                    <div className="px-2 py-1.5 text-[11px] text-white/45">未检测到字幕轨</div>
                  ) : (
                    (state?.subs ?? []).map((s) => (
                      <button
                        key={s.id}
                        className={`block w-full truncate rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                          currentSubId != null && currentSubId === s.id ? 'text-accent' : ''
                        }`}
                        onClick={() => {
                          onSend({ type: 'setSubtitle', id: s.id })
                          setSubMenu(false)
                        }}
                      >
                        {s.label}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* 倍速 */}
            <div className="relative">
              <IconBtn
                title="播放倍速"
                active={speedMenu || (state?.speed ?? 1) !== 1}
                onClick={() => {
                  setSpeedMenu(!speedMenu)
                  setAspectMenu(false)
                  setSubMenu(false)
                }}
              >
                <span className="min-w-[30px] text-center text-[12px] font-semibold tabular-nums whitespace-nowrap">
                  {fmtSpeed(state?.speed ?? 1)}
                </span>
              </IconBtn>
              {speedMenu && (
                <div
                  data-sakana-hit="1"
                  data-sakana-popover="1"
                  className="absolute bottom-12 right-0 z-40 w-28 rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur"
                >
                  {SPEED_CHOICES.map((s) => (
                    <button
                      key={s}
                      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        Math.abs((state?.speed ?? 1) - s) < 0.001 ? 'text-accent' : ''
                      } whitespace-nowrap`}
                      onClick={() => {
                        onSend({ type: 'setSpeed', value: s })
                        setSpeedMenu(false)
                      }}
                    >
                      {fmtSpeed(s)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 弹幕开关 / 弹幕设置 */}
            <IconBtn
              title={
                danmaku?.loading
                  ? '弹幕加载中…'
                  : danmaku?.settings.enabled === false
                    ? '打开弹幕'
                    : `关闭弹幕${danmaku ? `（${danmaku.comments.length} 条）` : ''}`
              }
              active={danmaku?.settings.enabled !== false}
              onClick={() => onSend({ type: 'toggleDanmaku' })}
            >
              {danmaku?.settings.enabled === false ? <MessageSquareOff size={18} /> : <MessagesSquare size={18} />}
            </IconBtn>
            <div className="relative">
              <IconBtn
                title="弹幕设置"
                active={danmakuMenu}
                onClick={() => {
                  setDanmakuMenu(!danmakuMenu)
                  setSubMenu(false)
                  setAspectMenu(false)
                }}
              >
                <SlidersHorizontal size={18} />
              </IconBtn>
            </div>

            {/* 画面比例 */}
            <div className="relative">
              <IconBtn
                title={`画面比例：${ASPECT_LABEL[state?.aspect ?? 'fit']}`}
                active={aspectMenu}
                onClick={() => {
                  setAspectMenu(!aspectMenu)
                  setSubMenu(false)
                }}
              >
                {state?.aspect === 'cover' ? (
                  <Crop size={18} />
                ) : state?.aspect === 'stretch' ? (
                  <RectangleHorizontal size={18} />
                ) : (
                  <Expand size={18} />
                )}
              </IconBtn>
              {aspectMenu && (
                <div
                  data-sakana-hit="1"
                  data-sakana-popover="1"
                  className="absolute bottom-12 right-0 z-40 w-40 rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur"
                >
                  {(['fit', 'cover', 'stretch'] as AspectMode[]).map((m) => (
                    <button
                      key={m}
                      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        state?.aspect === m ? 'text-accent' : ''
                      } whitespace-nowrap `}
                      onClick={() => {
                        onSend({ type: 'setAspect', aspect: m })
                        setAspectMenu(false)
                      }}
                    >
                      {ASPECT_LABEL[m]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 画质（Anime4K 超分） */}
            <div className="relative">
              <IconBtn
                title={`画质（Anime4K 超分）：${a4kEnabled ? `模式 ${a4kShort}` : '已关闭'}`}
                active={qualityMenu || a4kEnabled}
                onClick={() => {
                  setQualityMenu(!qualityMenu)
                  setSubMenu(false)
                  setAspectMenu(false)
                }}
              >
                <span className="flex items-center gap-0.5">
                  <Sparkles size={18} />
                  <span className="min-w-[14px] text-[10px] font-semibold tabular-nums">
                    {a4kEnabled ? a4kShort : '关'}
                  </span>
                </span>
              </IconBtn>
              {qualityMenu && (
                <div
                  data-sakana-hit="1"
                  data-sakana-popover="1"
                  className="absolute bottom-12 right-0 z-40 w-60 rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur"
                >
                  <div className="px-2 py-1 text-[10px] text-white/50">Anime4K 超分（改完立刻生效）</div>
                  <button
                    className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                      a4kEnabled ? '' : 'text-accent'
                    }`}
                    onClick={() => {
                      onPatchA4k({ enabled: false })
                      setQualityMenu(false)
                    }}
                  >
                    关闭超分
                  </button>
                  {ANIME4K_MODES.filter((m) => m.id !== 'custom').map((m) => (
                    <button
                      key={m.id}
                      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        a4kEnabled && a4kMode === m.id ? 'text-accent' : ''
                      }`}
                      onClick={() => {
                        onPatchA4k({ enabled: true, mode: m.id })
                        setQualityMenu(false)
                      }}
                    >
                      <span className="font-medium">{m.short}</span>
                      <span className="ml-2 text-[10px] text-white/50">{m.desc}</span>
                    </button>
                  ))}
                  <div className="my-1 border-t border-white/10" />
                  <div className="px-2 py-1 text-[10px] text-white/50">显卡档位</div>
                  {ANIME4K_TIERS.map((t) => (
                    <button
                      key={t.id}
                      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        a4kTier === t.id ? 'text-accent' : ''
                      }`}
                      onClick={() => {
                        onPatchA4k({ tier: t.id })
                        setQualityMenu(false)
                      }}
                    >
                      <span className="font-medium">{t.label}</span>
                      <span className="ml-2 text-[10px] text-white/50">{t.desc}</span>
                    </button>
                  ))}
                  <div className="my-1 border-t border-white/10" />
                  <button
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-white/10"
                    onClick={() => {
                      setQualityMenu(false)
                      onSend({ type: 'openQualitySettings' })
                    }}
                  >
                    完整画质设置…
                  </button>
                </div>
              )}
            </div>

            {/* 全屏 / 窗口 */}
            {state?.fullscreen ? (
              <IconBtn title="退出全屏" onClick={() => onSend({ type: 'exitFullscreen' })}>
                <Minimize size={18} />
              </IconBtn>
            ) : (
              <IconBtn title="全屏播放" onClick={() => onSend({ type: 'toggleFullscreen' })}>
                <Maximize size={18} />
              </IconBtn>
            )}
            {/* 投屏 */}
            <IconBtn
              title={castActive ? `正在投屏：${castDeviceName}` : '投屏到电视 / 接收端'}
              active={castPanel}
              onClick={() => {
                onToggleCastPanel()
                setSubMenu(false)
                setAspectMenu(false)
                onRefreshCastDevices()
              }}
            >
              {castActive ? <Cast size={18} className="text-accent" /> : <Cast size={18} />}
            </IconBtn>
            <IconBtn title="退出播放" onClick={() => onSend({ type: 'exitPlayer' })}>
              <LogOut size={18} />
            </IconBtn>
          </div>
        </div>
      </div>
    </>
  )
}

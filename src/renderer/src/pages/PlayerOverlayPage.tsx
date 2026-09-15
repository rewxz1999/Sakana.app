import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  Crop,
  Expand,
  Info,
  ListVideo,
  LogOut,
  Maximize,
  Minimize,
  Pause,
  Play,
  RectangleHorizontal,
  Rewind,
  FastForward,
  SkipBack,
  SkipForward,
  Subtitles,
  Volume1,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import type { OverlayAction, OverlayEpisodes, OverlayState } from '@shared/api'
import type { AspectMode, SubjectDetail } from '@shared/types'
import { api } from '@/lib/api'
import { StreamInfoModal } from '@/components/StreamInfoModal'
import { CoverImage } from '@/components/CoverImage'

/**
 * 全屏控制栏悬浮窗（透明窗口内的控制栏）
 *
 * 原生视频窗口永远盖在网页之上，所以全屏时画面铺满整屏后，
 * 主窗口页面里的控制栏会被画面挡住 —— 控制栏必须画在这个独立的透明窗口里。
 * 本窗口默认点击穿透（鼠标移动仍会转发进来用于唤出控制栏），
 * 控制栏出现时才接收鼠标事件。
 */

const ASPECT_LABEL: Record<AspectMode, string> = {
  fit: '适应',
  cover: '裁剪铺满',
  stretch: '拉伸铺满'
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function IconBtn({
  title,
  onClick,
  children,
  active
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
  active?: boolean
}) {
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
      }`}
    >
      {children}
    </button>
  )
}

export default function PlayerOverlay(): React.ReactElement {
  const [state, setState] = useState<OverlayState | null>(null)
  const [episodes, setEpisodes] = useState<OverlayEpisodes | null>(null)
  const [visible, setVisible] = useState(false)
  const [subMenu, setSubMenu] = useState(false)
  const [aspectMenu, setAspectMenu] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  /** 选集浮层里正在查看的线路（悬浮窗本地状态，切换线路不打断播放） */
  const [browseLine, setBrowseLine] = useState(0)
  /** 番剧详情（打开详情浮层时自己去拉，避免主窗口往高频状态里塞大对象） */
  const [detail, setDetail] = useState<SubjectDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const hideTimer = useRef<number | undefined>(undefined)
  const seekRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  /** 菜单/浮层打开期间禁止自动隐藏（否则 5 秒后窗口恢复点击穿透，浮层就点不动了） */
  const holdRef = useRef(false)

  const send = useCallback((action: OverlayAction) => {
    api.overlay.action(action)
  }, [])

  /** 唤出控制栏：显示 + 接收鼠标事件；空闲 5 秒后隐藏 + 恢复点击穿透 */
  const poke = useCallback(() => {
    setVisible(true)
    void api.overlay.setInteractive(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (holdRef.current) return
      setSubMenu(false)
      setAspectMenu(false)
      setVisible(false)
      void api.overlay.setInteractive(false)
    }, 5000)
  }, [])

  // 选集数据（低频）：由播放页单独推送
  useEffect(() => api.overlay.onEpisodes(setEpisodes), [])

  // 打开详情浮层时拉一次番剧详情（悬浮窗有完整的 api 能力）
  const showInfoPanel = state?.showInfo === true
  useEffect(() => {
    if (!showInfoPanel) return
    const id = state?.subjectId
    if (id == null || detail) return
    setDetailLoading(true)
    void api.bangumi.subject(id).then((r) => {
      setDetailLoading(false)
      if (r.ok && r.data.data) setDetail(r.data.data)
    })
  }, [showInfoPanel, state?.subjectId, detail])

  // 选集浮层打开时，默认定位到当前播放的线路
  useEffect(() => {
    if (state?.showEpisodes && episodes) setBrowseLine(episodes.currentLine)
  }, [state?.showEpisodes, episodes])

  // 浮层/菜单打开时保持可交互，关闭后恢复正常 5 秒自动隐藏
  useEffect(() => {
    holdRef.current = showInfo || subMenu || aspectMenu || showInfoPanel || state?.showEpisodes === true
    if (holdRef.current) {
      setVisible(true)
      void api.overlay.setInteractive(true)
    } else {
      poke()
    }
  }, [showInfo, subMenu, aspectMenu, poke])

  useEffect(() => api.overlay.onState(setState), [])
  // 透明窗口：给根元素打标记，让全局样式把底色设为透明（否则会盖住整屏画面）
  useEffect(() => {
    document.documentElement.classList.add('sakana-overlay')
    document.body.classList.add('sakana-overlay')
    return () => {
      document.documentElement.classList.remove('sakana-overlay')
      document.body.classList.remove('sakana-overlay')
    }
  }, [])
  useEffect(() => api.overlay.onPoke(poke), [poke])
  useEffect(() => {
    // 点击穿透时 mousemove 依然会转发到本窗口，因此可以自行感知鼠标移动
    const onMove = (): void => poke()
    window.addEventListener('mousemove', onMove)
    poke()
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.clearTimeout(hideTimer.current)
    }
  }, [poke])

  /** 进度条拖动 */
  const ratioFromEvent = (clientX: number): number => {
    const el = seekRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }

  const duration = state?.duration ?? 0
  const current = state?.current ?? 0
  const percent = duration > 0 ? Math.min(100, (current / duration) * 100) : 0
  const currentSubId = state && state.subIdx >= 0 ? state.subs[state.subIdx]?.id : undefined

  return (
    <div
      className="fixed inset-0 select-none"
      style={{ background: 'transparent' }}
      onDoubleClick={() => send({ type: 'playPause' })}
    >
      {/*
        v0.2.6：选集浮层 —— 半透明浮在画面上，打开时不再改动播放内容区域。
        点空白处关闭（回到纯播放画面）。
      */}
      {state?.showEpisodes && episodes ? (
        <div
          className="absolute inset-0 z-40 flex bg-black/35 backdrop-blur-[2px]"
          onPointerDown={(e) => {
            // 点浮层以外的地方 = 关闭
            if (e.target === e.currentTarget) send({ type: 'toggleEpisodes' })
          }}
        >
          <div className="ml-auto flex h-full w-[380px] max-w-[70vw] flex-col border-l border-white/10 bg-black/72 backdrop-blur-md">
            <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
              <span className="text-sm font-medium text-white">
                选集 · 共 {episodes.lines.reduce((n, l) => n + l.episodes.length, 0)} 集
              </span>
              <button
                className="rounded-md p-1 text-white/70 hover:bg-white/10 hover:text-white"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  send({ type: 'toggleEpisodes' })
                }}
              >
                <X size={16} />
              </button>
            </div>
            {episodes.lines.length > 1 ? (
              <div className="flex flex-wrap gap-1 border-b border-white/10 px-2 py-2">
                {episodes.lines.map((l, i) => (
                  <button
                    key={i}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      setBrowseLine(i)
                    }}
                    className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                      browseLine === i ? 'bg-accent text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'
                    }`}
                  >
                    {l.name}
                    <span className="ml-1 text-[10px] text-white/50">{l.episodes.length}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <div className="grid grid-cols-4 gap-1">
                {(episodes.lines[browseLine]?.episodes ?? []).map((name, ei) => {
                  const activeLine = browseLine === episodes.currentLine
                  const active = activeLine && ei === episodes.currentEp
                  return (
                    <button
                      key={ei}
                      title={name}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        // 与规则页选集一致：切集由播放页重新挂载播放页来完成（更稳）
                        send({ type: 'selectEpisode', line: browseLine, ep: ei })
                      }}
                      className={`truncate rounded-md px-1 py-1.5 text-center text-[11px] transition-colors ${
                        active
                          ? 'bg-accent font-medium text-white'
                          : 'bg-white/8 text-white/75 hover:bg-white/20 hover:text-white'
                      }`}
                    >
                      {name}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* v0.2.6：详情浮层（同样盖在画面上；过去画在页面里被视频完全盖住 → 「详情按钮没反应」） */}
      {showInfoPanel ? (
        <div
          className="absolute inset-0 z-40 flex bg-black/35 backdrop-blur-[2px]"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) send({ type: 'toggleInfo' })
          }}
        >
          <div className="ml-auto flex h-full w-[380px] max-w-[70vw] flex-col overflow-y-auto border-l border-white/10 bg-black/72 p-3 backdrop-blur-md">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-white">番剧详情</span>
              <button
                className="rounded-md p-1 text-white/70 hover:bg-white/10 hover:text-white"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  send({ type: 'toggleInfo' })
                }}
              >
                <X size={16} />
              </button>
            </div>
            {detailLoading ? (
              <div className="py-8 text-center text-xs text-white/60">加载中…</div>
            ) : detail ? (
              <>
                <div className="flex gap-3">
                  <CoverImage
                    src={detail.images?.common ?? detail.images?.large ?? null}
                    className="h-32 w-24 shrink-0 rounded-lg"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold leading-snug text-white">
                      {detail.name_cn || detail.name}
                    </div>
                    <div className="mt-1 text-[11px] text-white/60">{detail.name}</div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-white/75">
                      {detail.rating?.score ? <span>★ {detail.rating.score}</span> : null}
                      {detail.air_date ? <span>{detail.air_date}</span> : null}
                      {detail.eps ? <span>共 {detail.eps} 集</span> : null}
                    </div>
                  </div>
                </div>
                {detail.tags.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {detail.tags.slice(0, 10).map((t) => (
                      <span key={t.name} className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70">
                        {t.name}
                      </span>
                    ))}
                  </div>
                ) : null}
                {detail.summary ? (
                  <div className="mt-3 whitespace-pre-wrap text-[11px] leading-relaxed text-white/70">
                    {detail.summary}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="py-8 text-center text-xs text-white/60">
                暂无详情数据（该番剧可能不是通过番剧表进入的）
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/*
        v0.2.6：断点续播提示。用户反馈「提示时间太短」——真正的原因是它过去画在播放页里，
        被原生视频窗口挡住根本看不见，只看到一闪而过的 toast。现在画在悬浮窗右下角，10 秒后自动消失。
      */}
      {state?.resume ? (
        <div className="absolute bottom-24 right-5 z-40 flex w-72 flex-col gap-2 rounded-xl border border-white/15 bg-black/80 p-3 text-white shadow-2xl backdrop-blur">
          <div className="text-xs">已自动跳转到上次观看位置 {fmt(state.resume.target)}</div>
          <div className="text-[11px] text-white/60">如果不想从这里继续，可以回到本集开头。</div>
          <div className="flex justify-end gap-2">
            <button
              className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] text-white/80 hover:bg-white/20"
              onPointerDown={(e) => {
                e.stopPropagation()
                send({ type: 'dismissResume' })
              }}
            >
              保持
            </button>
            <button
              className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:brightness-110"
              onPointerDown={(e) => {
                e.stopPropagation()
                send({ type: 'undoResume' })
              }}
            >
              撤销跳转
            </button>
          </div>
        </div>
      ) : null}

      {/*
        播放状态覆盖层：捕捉视频流/加载中时给出明确的等待反馈，
        失败时给出可点击的退出入口（原生视频窗口会盖住主窗口页面里的同类提示）。
      */}
      {state && (state.status.kind === 'capturing' || state.status.kind === 'loading') ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-full bg-black/65 px-4 py-2 text-xs text-white backdrop-blur">
            <span className="h-2 w-2 animate-pulse rounded-full bg-warn" />
            {state.status.text}…
          </div>
        </div>
      ) : null}
      {state?.error ? (
        <div className="absolute inset-x-0 bottom-24 z-30 flex justify-center">
          <div className="flex items-center gap-3 rounded-xl bg-black/80 px-4 py-2.5 text-xs text-white backdrop-blur">
            <span className="max-w-md">{state.error}</span>
            <button
              className="rounded-lg bg-white/20 px-3 py-1 hover:bg-white/30"
              onPointerDown={(e) => {
                e.stopPropagation()
                send({ type: 'exitPlayer' })
              }}
            >
              ✕ 退出播放
            </button>
          </div>
        </div>
      ) : null}

      {/* 顶部：退出 / 标题 / 状态 / 详情 / 截图 */}
      <div
        className={`absolute inset-x-0 top-0 z-30 flex h-14 items-center justify-between bg-gradient-to-b from-black/70 via-black/25 to-transparent px-2 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {/* 小窗口时「✕」表示退出播放（没有全屏可退），全屏时先退全屏 */}
        <IconBtn
          title={state?.fullscreen ? '退出全屏' : '退出播放'}
          onClick={() => send({ type: state?.fullscreen ? 'exitFullscreen' : 'exitPlayer' })}
        >
          <X size={22} />
        </IconBtn>
        <div className="pointer-events-none min-w-0 flex-1 px-2">
          <div className="truncate text-sm font-medium text-white drop-shadow">
            {state?.title ?? ''}
          </div>
          <div className="truncate text-[10px] text-white/60">{state?.subtitle ?? ''}</div>
        </div>
        {/* 状态药丸：点击查看流详情（地址/播放列表/分辨率/码率） */}
        <button
          title="查看播放状态与流详情"
          onPointerDown={(e) => {
            e.stopPropagation()
            setShowInfo(true)
          }}
          className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11px] transition-colors ${
            state?.status.kind === 'failed'
              ? 'bg-danger/30 text-white hover:bg-danger/45'
              : 'bg-white/15 text-white hover:bg-white/30'
          }`}
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
          {state?.status.text ?? '加载中'}
        </button>
        <div className="flex items-center gap-1">
          <IconBtn title="番剧详情" onClick={() => send({ type: 'toggleInfo' })}>
            <Info size={20} />
          </IconBtn>
          <IconBtn title="截图" onClick={() => send({ type: 'snapshot' })}>
            <Camera size={20} />
          </IconBtn>
        </div>
      </div>

      {/* 底部：进度条 + 控制按钮 */}
      <div
        className={`absolute inset-x-0 bottom-0 z-30 flex flex-col gap-1 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-3 pb-2 pt-6 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div
          ref={seekRef}
          className="group relative flex h-6 cursor-pointer items-center"
          onPointerDown={(e) => {
            e.stopPropagation()
            setDragging(true)
            const r = ratioFromEvent(e.clientX)
            send({ type: 'seek', time: r * duration })
          }}
          onPointerMove={(e) => {
            if (!dragging) return
            const r = ratioFromEvent(e.clientX)
            send({ type: 'seek', time: r * duration })
          }}
          onPointerUp={() => setDragging(false)}
          onPointerLeave={() => setDragging(false)}
        >
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/25">
            <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
          </div>
          <div
            className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow"
            style={{ left: `calc(${percent}% - 7px)` }}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-0.5">
            <IconBtn title="播放/暂停" onClick={() => send({ type: 'playPause' })}>
              {state?.playing ? <Pause size={20} /> : <Play size={20} fill="currentColor" />}
            </IconBtn>
            <IconBtn title="上一集" onClick={() => send({ type: 'prevEpisode' })}>
              <SkipBack size={18} />
            </IconBtn>
            <IconBtn title="下一集" onClick={() => send({ type: 'nextEpisode' })}>
              <SkipForward size={18} />
            </IconBtn>
            <IconBtn title="后退 10 秒" onClick={() => send({ type: 'back10' })}>
              <Rewind size={18} />
            </IconBtn>
            <IconBtn title="前进 10 秒" onClick={() => send({ type: 'forward10' })}>
              <FastForward size={18} />
            </IconBtn>
            <span className="ml-1 text-[11px] tabular-nums text-white/80">
              {fmt(current)} / {fmt(duration)}
            </span>
            <IconBtn title="静音" onClick={() => send({ type: 'toggleMute' })}>
              {state?.muted ? (
                <VolumeX size={18} />
              ) : (state?.volume ?? 0) > 50 ? (
                <Volume2 size={18} />
              ) : (
                <Volume1 size={18} />
              )}
            </IconBtn>
          </div>

          <div className="flex items-center gap-0.5">
            {/* 选集（需要空间：交给主窗口打开抽屉，画面会让出位置） */}
            <IconBtn title="选集" onClick={() => send({ type: 'toggleEpisodes' })}>
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
                <div className="absolute bottom-12 right-0 z-40 max-h-64 w-48 overflow-y-auto rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur">
                  <button
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-white/10"
                    onClick={() => {
                      send({ type: 'cycleSubtitle' })
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
                          send({ type: 'setSubtitle', id: s.id })
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
                <div className="absolute bottom-12 right-0 z-40 w-40 rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur">
                  {(['fit', 'cover', 'stretch'] as AspectMode[]).map((m) => (
                    <button
                      key={m}
                      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        state?.aspect === m ? 'text-accent' : ''
                      }`}
                      onClick={() => {
                        send({ type: 'setAspect', aspect: m })
                        setAspectMenu(false)
                      }}
                    >
                      {ASPECT_LABEL[m]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 全屏按钮：小窗口时无意义（不能自由拉伸窗口），隐藏 */}
            {state?.fullscreen ? (
              <IconBtn title="退出全屏" onClick={() => send({ type: 'exitFullscreen' })}>
                <Minimize size={18} />
              </IconBtn>
            ) : (
              <IconBtn title="全屏播放" onClick={() => send({ type: 'toggleFullscreen' })}>
                <Maximize size={18} />
              </IconBtn>
            )}
            <IconBtn title="退出播放" onClick={() => send({ type: 'exitPlayer' })}>
              <LogOut size={18} />
            </IconBtn>
          </div>
        </div>
      </div>

      {/* 流详情弹窗（与播放页里的那个是同一组件，两处口径一致） */}
      <StreamInfoModal open={showInfo} onClose={() => setShowInfo(false)} />
    </div>
  )
}

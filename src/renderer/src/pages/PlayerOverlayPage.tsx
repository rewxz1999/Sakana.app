import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
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
  Subtitles,
  Volume1,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import type { OverlayAction, OverlayDanmaku, OverlayEpisodes, OverlayState } from '@shared/api'
import type { AspectMode, SubjectDetail } from '@shared/types'
import { api } from '@/lib/api'
import { StreamInfoModal } from '@/components/StreamInfoModal'
import { CoverImage } from '@/components/CoverImage'
import { DanmakuLayer } from '@/components/DanmakuLayer'

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

/**
 * 详情面板要显示的「详细信息」几行（v0.2.7 附加）。
 *
 * 播放器里的详情面板是唯一一份，但过去只有评分/日期/标签/简介 —— 用户明确要求
 * 「番剧详情等信息还是要有」。这里按关键度挑出常用几项（导演/脚本/原作/制作/音乐/平台…），
 * 数据全部来自详情页同一份缓存，不额外请求反代，也不删减详情页本身的展示。
 */
function detailRows(d: SubjectDetail): { key: string; value: string }[] {
  const score = (key: string): number => {
    const rules: [RegExp, number][] = [
      [/^(平台|话数|总集数)$/, 0],
      [/^(放送开始|上映|发售|播放结束)/, 1],
      [/^(导演|监督)/, 2],
      [/^(系列构成|脚本|分镜|演出)/, 3],
      [/^(原作|原案|人物设定)/, 4],
      [/^(动画制作|製作|制作|音乐制作)/, 5],
      [/^(音乐|主题歌)/, 6],
      [/^(播放电视台|官方网站)/, 7]
    ]
    for (const [re, n] of rules) if (re.test(key)) return n
    return 99
  }
  const rows = [...d.infobox]
  if (d.platform && !rows.some((r) => r.key === '平台')) rows.unshift({ key: '平台', value: d.platform })
  if (d.totalEpisodes && !rows.some((r) => r.key === '总集数')) {
    rows.push({ key: '总集数', value: String(d.totalEpisodes) })
  }
  return rows
    .filter((r) => score(r.key) < 99)
    .sort((a, b) => score(a.key) - score(b.key))
    .slice(0, 8)
    .map((r) => ({ key: r.key, value: typeof r.value === 'string' ? r.value : String(r.value) }))
}

/**
 * 音量滑杆（v0.2.9）。
 *
 * 用户要求：控制栏要能调音量，**不需要静音键**。
 * 所以这里没有「点一下静音」的行为 —— 图标只是当前音量档位的指示（拖到 0 自然就没声音），
 * 拖动过程中持续发送 setVolume；用 pointer capture 保证拖出滑杆外也不断。
 */
function VolumeSlider({ volume, onSet }: { volume: number; onSet: (v: number) => void }): React.ReactElement {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const v = Math.max(0, Math.min(100, volume))

  const applyFromEvent = (clientX: number): void => {
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const ratio = r.width > 0 ? (clientX - r.left) / r.width : 0
    onSet(Math.round(Math.max(0, Math.min(1, ratio)) * 100))
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
          /*
           * 指针捕获要用 try/catch 包住：合成事件（自检里 dispatch 的 PointerEvent）没有真实
           * pointerId，setPointerCapture 会抛 NotFoundError；抛出去会把整个拖动逻辑打断。
           */
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
          <div className="h-full rounded-full bg-white/85" style={{ width: `${v}%` }} />
        </div>
        <div
          className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow transition-opacity ${
            dragging ? 'opacity-100' : 'opacity-80 group-hover:opacity-100'
          }`}
          style={{ left: `calc(${v}% - 6px)` }}
        />
      </div>
      <span className="w-7 shrink-0 text-[11px] tabular-nums text-white/60">{v}</span>
    </div>
  )
}

/** 倍速档位（与控制栏按钮里的显示顺序一致；播放页那份是给快捷键循环用的） */
const SPEED_CHOICES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]
const fmtSpeed = (s: number): string => `${Number.isInteger(s) ? s.toFixed(1) : s}x`

/** 弹幕设置面板里的小胶囊按钮（v0.2.8） */
function Chip({
  active,
  onClick,
  children
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
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

/** 弹幕区域：视频矩形往里收，避开顶部标题栏与底部控制栏（v0.2.8） */
const DANMAKU_TOP_GAP = 58
const DANMAKU_BOTTOM_GAP_VISIBLE = 104
const DANMAKU_BOTTOM_GAP_HIDDEN = 26

function danmakuRect(
  state: OverlayState,
  controlsVisible: boolean
): { x: number; y: number; width: number; height: number } {
  const r =
    state.videoRect ??
    ({ x: 0, y: 56, width: window.innerWidth, height: Math.max(120, window.innerHeight - 112) } as const)
  const bottomGap = controlsVisible ? DANMAKU_BOTTOM_GAP_VISIBLE : DANMAKU_BOTTOM_GAP_HIDDEN
  return {
    x: r.x,
    y: r.y + DANMAKU_TOP_GAP,
    width: r.width,
    height: Math.max(80, r.height - DANMAKU_TOP_GAP - bottomGap)
  }
}

/** 弹幕设置面板的一行：左侧标签 + 右侧一组胶囊 */function SettingRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
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
      } whitespace-nowrap `}
    >
      {children}
    </button>
  )
}

export default function PlayerOverlay(): React.ReactElement {
  const [state, setState] = useState<OverlayState | null>(null)
  const [episodes, setEpisodes] = useState<OverlayEpisodes | null>(null)
  /** v0.2.8：弹幕数据与设置（由播放页推送，换集/改设置时更新） */
  const [danmaku, setDanmaku] = useState<OverlayDanmaku | null>(null)
  const [danmakuMenu, setDanmakuMenu] = useState(false)
  const [visible, setVisible] = useState(false)
  const [subMenu, setSubMenu] = useState(false)
  const [aspectMenu, setAspectMenu] = useState(false)
  // v0.2.9 最后更新：倍速菜单
  const [speedMenu, setSpeedMenu] = useState(false)
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
      setDanmakuMenu(false)
      setVisible(false)
      void api.overlay.setInteractive(false)
    }, 5000)
  }, [])

  // 选集数据（低频）：由播放页单独推送
  useEffect(() => api.overlay.onEpisodes(setEpisodes), [])
  // 弹幕数据（v0.2.8，低频）：同样由播放页推送
  useEffect(() => api.overlay.onDanmaku(setDanmaku), [])

  // 打开详情浮层时拉一次番剧详情（悬浮窗有完整的 api 能力）
  const showInfoPanel = state?.showInfo === true
  /**
   * v0.2.18：控制栏是否已交给 uosc（mpv 侧绘制，见 PlayerPage 的 uoscBarMode）。
   *
   * 为 true 时这个悬浮窗**不再画任何控件**：
   * - 底栏（进度条 + 全部按钮 + 弹幕设置面板）整条隐藏 —— 它们由 uosc 提供；
   * - 顶栏只留「标题 + 状态药丸」（纯展示），✕ / 番剧详情 / 截图 三个按钮撤掉（uosc 里有）。
   *
   * 保留下来的部分都是 uosc **给不了**的：
   * ① 弹幕画布（canvas 渲染方式时，弹幕必须由网页画在视频之上）；
   * ② 番剧详情浮层、选集抽屉（应用自己的富面板）；
   * ③ 断点续播提示、错误条、流详情弹窗、捕捉视频流中的提示。
   */
  const uoscBar = state?.uoscBar === true
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
    holdRef.current =
      showInfo || subMenu || aspectMenu || danmakuMenu || showInfoPanel || state?.showEpisodes === true
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
  /** 排障探针：把控制栏的真实显隐状态暴露给自检脚本（DOM 上的 opacity 判断不可靠） */
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__sakanaOverlayVisible = visible
  }, [visible])
  /**
   * 交互状态心跳（v0.2.8 附加六）。
   *
   * 「切到后台再回来，控制栏按钮全部失灵」的最后一环：主进程会在失焦时复位点击穿透，
   * 回到前台后如果用户**不移动鼠标直接点**，就收不到 mousemove、交互状态也不会恢复 ——
   * 表现为控制栏看得见、点不动。这里在控制栏可见期间每 1.5 秒幂等地重申一次
   * 「我在接收点击」，保证窗口的系统级状态始终与界面状态一致。
   */
  useEffect(() => {
    if (!visible) return
    const t = window.setInterval(() => {
      void api.overlay.setInteractive(true)
    }, 1500)
    return () => {
      window.clearInterval(t)
      // 控制栏收起时归还点击穿透，避免透明窗口挡住画面上的其它操作
      void api.overlay.setInteractive(false)
    }
  }, [visible])
  useEffect(() => {
    // 点击穿透时 mousemove 依然会转发到本窗口，因此可以自行感知鼠标移动
    const onMove = (): void => poke()
    window.addEventListener('mousemove', onMove)
    /*
     * 窗口被隐藏（切到后台）后再显示时，主动把控制栏唤出一次：
     * 否则「看不见 → 回来」之后可能停在既不可见也不可交互的状态（用户反馈过按钮全失灵）。
     */
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') poke()
    }
    document.addEventListener('visibilitychange', onVisibility)
    poke()
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('visibilitychange', onVisibility)
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
        v0.2.8：弹幕层 —— 画在悬浮窗里才能盖在原生视频之上（页面里的元素会被视频整个挡住）。
        位置取播放页推送过来的视频区域矩形，再**往里收一圈**：
        - 顶部让出标题/状态栏的高度（否则最上面几行弹幕会被顶栏盖住 —— 用户反馈过）；
        - 底部让出控制栏（控制栏隐藏时只留一点点安全边）。
      */}
      {state && danmaku && danmaku.settings.enabled && danmaku.comments.length > 0 && !danmaku.pluginActive ? (
        <DanmakuLayer
          comments={danmaku.comments}
          settings={danmaku.settings}
          time={state.current}
          playing={state.playing}
          rect={danmakuRect(state, visible)}
          scale={window.devicePixelRatio || 1}
        />
      ) : null}

      {/*
        v0.2.6：选集浮层 —— 半透明浮在画面上，打开时不再改动播放内容区域。
        点空白处关闭（回到纯播放画面）。
      */}
      {/*
        v0.2.7：选集数据还没到（悬浮窗比数据晚就绪）时给一个明确的加载态 ——
        否则点「选集」后什么都没出现，看起来就像按钮没反应。
      */}
      {state?.showEpisodes && !episodes ? (
        <div className="absolute inset-0 z-40 flex bg-black/35 backdrop-blur-[2px]">
          <div className="ml-auto flex h-full w-[380px] max-w-[70vw] flex-col items-center justify-center gap-2 border-l border-white/10 bg-black/72 backdrop-blur-md">
            <span className="text-xs text-white/80">正在读取选集…</span>
            <button
              className="rounded-lg bg-white/10 px-3 py-1 text-[11px] text-white/80 hover:bg-white/20 whitespace-nowrap"
              onPointerDown={(e) => {
                e.stopPropagation()
                send({ type: 'toggleEpisodes' })
              }}
            >
              关闭
            </button>
          </div>
        </div>
      ) : null}
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
                      <span key={t.name} className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70 whitespace-nowrap">
                        {t.name}
                      </span>
                    ))}
                  </div>
                ) : null}
                {/*
                  v0.2.7 附加：补上「详细信息」几行（导演 / 制作 / 平台 / 放送日期…）。
                  播放器里的详情面板现在是唯一一份（页面内那份已经不再绘制），
                  过去这里只有评分/日期/标签/简介，看不到制作信息；
                  数据来自同一份详情缓存（subject3-<id>），不会再给反代增加请求。
                */}
                {detailRows(detail).length > 0 ? (
                  <div className="mt-3 flex flex-col gap-1 border-t border-white/10 pt-3">
                    {detailRows(detail).map((r) => (
                      <div key={r.key} className="flex gap-2 text-[11px] leading-relaxed">
                        <span className="w-14 shrink-0 text-white/45">{r.key}</span>
                        <span className="min-w-0 flex-1 break-words text-white/75">{r.value}</span>
                      </div>
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
          <div className="flex flex-wrap justify-end gap-2">
            <button
              className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] text-white/80 hover:bg-white/20 whitespace-nowrap"
              onPointerDown={(e) => {
                e.stopPropagation()
                send({ type: 'dismissResume' })
              }}
            >
              保持
            </button>
            <button
              className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:brightness-110 whitespace-nowrap"
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
          <div className="flex items-center gap-2 rounded-full bg-black/65 px-4 py-2 text-xs text-white backdrop-blur whitespace-nowrap">
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
              className="rounded-lg bg-white/20 px-3 py-1 hover:bg-white/30 whitespace-nowrap"
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

      {/* 顶部：退出 / 标题 / 状态 / 详情 / 截图（v0.2.18：uosc 接管控制栏后只留标题与状态） */}
      <div
        className={`absolute inset-x-0 top-0 z-30 flex h-14 items-center justify-between bg-gradient-to-b from-black/70 via-black/25 to-transparent px-2 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {/* 小窗口时「✕」表示退出播放（没有全屏可退），全屏时先退全屏 */}
        {uoscBar ? null : (
          <IconBtn
            title={state?.fullscreen ? '退出全屏' : '退出播放'}
            onClick={() => send({ type: state?.fullscreen ? 'exitFullscreen' : 'exitPlayer' })}
          >
            <X size={22} />
          </IconBtn>
        )}
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
          {state?.status.text ?? '加载中'}
        </button>
        <div className="flex items-center gap-1">
          {uoscBar ? null : (
            <>
              <IconBtn title="番剧详情" onClick={() => send({ type: 'toggleInfo' })}>
                <Info size={20} />
              </IconBtn>
              <IconBtn title="截图" onClick={() => send({ type: 'snapshot' })}>
                <Camera size={20} />
              </IconBtn>
            </>
          )}
        </div>
      </div>

      {/*
        底部：进度条 + 控制按钮
        v0.2.8：弹幕开关与弹幕设置放在**控制栏上方**（同一容器里、进度条之前），
        跟着控制栏一起显隐，不额外占用画面。
        v0.2.18：控制栏交给 uosc 后，这整条（含弹幕设置面板）不再显示 ——
        进度条/播放控制/倍速/字幕/比例/弹幕菜单全部由 uosc 画在视频画面上。
        这里只关显隐、不删代码：设置里把「播放器控制栏」切回旧版即可原样恢复。
      */}
      <div
        className={`absolute inset-x-0 bottom-0 z-30 flex flex-col gap-1 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-3 pb-2 pt-6 transition-opacity duration-300 ${
          visible && !uoscBar ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {/* 弹幕设置面板（覆盖区域 / 弹幕数量 / 时间轴 / 别名检测 + 更多设置） */}
        {danmakuMenu ? (
          <div className="absolute bottom-[86px] right-3 z-40 w-80 rounded-xl border border-white/15 bg-black/85 p-3 text-white shadow-2xl backdrop-blur">
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
                      onClick={() => send({ type: 'danmakuSetting', key: 'area', value: o.v })}
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
                      onClick={() => send({ type: 'danmakuSetting', key: 'maxCount', value: n })}
                    >
                      {n}
                    </Chip>
                  ))}
                </SettingRow>
                <SettingRow label="时间轴">
                  <Chip onClick={() => send({ type: 'danmakuSetting', key: 'offsetMs', value: danmaku.settings.offsetMs - 500 })}>
                    −0.5s
                  </Chip>
                  <span className="min-w-[52px] text-center text-[11px] tabular-nums text-white/80">
                    {(danmaku.settings.offsetMs / 1000).toFixed(1)}s
                  </span>
                  <Chip onClick={() => send({ type: 'danmakuSetting', key: 'offsetMs', value: danmaku.settings.offsetMs + 500 })}>
                    +0.5s
                  </Chip>
                  <Chip active={danmaku.settings.offsetMs === 0} onClick={() => send({ type: 'danmakuSetting', key: 'offsetMs', value: 0 })}>
                    重置
                  </Chip>
                </SettingRow>
                <SettingRow label="显示类型">
                  <Chip
                    active={danmaku.settings.showScroll}
                    onClick={() => send({ type: 'danmakuSetting', key: 'showScroll', value: !danmaku.settings.showScroll })}
                  >
                    滚动
                  </Chip>
                  <Chip
                    active={danmaku.settings.showTop}
                    onClick={() => send({ type: 'danmakuSetting', key: 'showTop', value: !danmaku.settings.showTop })}
                  >
                    顶部
                  </Chip>
                  <Chip
                    active={danmaku.settings.showBottom}
                    onClick={() => send({ type: 'danmakuSetting', key: 'showBottom', value: !danmaku.settings.showBottom })}
                  >
                    底部
                  </Chip>
                </SettingRow>
                {/*
                  v0.2.9：插件渲染时，画面上的弹幕由 mpv 的 uosc_danmaku 负责，
                  它自带一套菜单（搜索弹幕 / 弹幕样式 / 弹幕源延迟 / 总菜单）。
                  这里只做「入口」——菜单本身由插件用 uosc 画在画面上。
                */}
                {danmaku.pluginActive ? (
                  <SettingRow label="插件菜单">
                    <Chip onClick={() => send({ type: 'uoscMenu', key: 'search' })}>搜索弹幕</Chip>
                    <Chip onClick={() => send({ type: 'uoscMenu', key: 'style' })}>弹幕样式</Chip>
                    <Chip onClick={() => send({ type: 'uoscMenu', key: 'delay' })}>源延迟</Chip>
                    <Chip onClick={() => send({ type: 'uoscMenu', key: 'total' })}>总菜单</Chip>
                  </SettingRow>
                ) : null}
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/10 pt-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {/*
                      v0.2.8：两个检测入口 ——
                      「别名检测弹幕」会用番剧别名（番剧库别名 + 弹幕库自身别名）再搜一轮，
                      中文译名/日文原名/其它译名不一致时特别有用；
                      「重新检测弹幕」按当前番剧名重查一次（也会绕过本地缓存重新拉取）。
                    */}
                    <button
                      className="rounded-md border border-white/20 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10 whitespace-nowrap"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        send({ type: 'detectDanmakuAlias' })
                      }}
                    >
                      别名检测弹幕
                    </button>
                    <button
                      className="rounded-md border border-white/20 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10 whitespace-nowrap"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        send({ type: 'reloadDanmaku' })
                      }}
                    >
                      重新检测弹幕
                    </button>
                  </div>
                  <button
                    className="shrink-0 text-[11px] text-accent hover:underline whitespace-nowrap"
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      send({ type: 'openDanmakuSettings' })
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
            {/* v0.2.9：音量改为滑杆（用户要求，不加静音键） */}
            <VolumeSlider volume={state?.volume ?? 0} onSet={(nv) => send({ type: 'setVolume', value: nv })} />
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
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 whitespace-nowrap"
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

            {/*
              v0.2.9 最后更新：倍速。与画面比例同一套写法（点按钮弹出档位菜单），
              当前档位直接显示在按钮上，非 1x 时用强调色，避免「忘了自己开过倍速」。
            */}
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
                <div className="absolute bottom-12 right-0 z-40 w-28 rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur">
                  {SPEED_CHOICES.map((s) => (
                    <button
                      key={s}
                      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        Math.abs((state?.speed ?? 1) - s) < 0.001 ? 'text-accent' : ''
                      } whitespace-nowrap`}
                      onClick={() => {
                        send({ type: 'setSpeed', value: s })
                        setSpeedMenu(false)
                      }}
                    >
                      {fmtSpeed(s)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/*
              v0.2.8：弹幕开关与弹幕设置放进**控制栏内部**（与选集/字幕/比例同一排），
              不再单独占控制栏外的一行。
            */}
            <IconBtn
              title={
                danmaku?.loading
                  ? '弹幕加载中…'
                  : danmaku?.settings.enabled === false
                    ? '打开弹幕'
                    : `关闭弹幕${danmaku ? `（${danmaku.comments.length} 条）` : ''}`
              }
              active={danmaku?.settings.enabled !== false}
              onClick={() => send({ type: 'toggleDanmaku' })}
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
                <div className="absolute bottom-12 right-0 z-40 w-40 rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur">
                  {(['fit', 'cover', 'stretch'] as AspectMode[]).map((m) => (
                    <button
                      key={m}
                      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        state?.aspect === m ? 'text-accent' : ''
                      } whitespace-nowrap `}
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

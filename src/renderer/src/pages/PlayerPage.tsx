import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Camera,
  Captions,
  Crop,
  Expand,
  ExternalLink,
  Info,
  ListVideo,
  Maximize,
  MessageSquare,
  Minimize,
  Pause,
  Play,
  RectangleHorizontal,
  Settings2,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
// v0.3.8：投屏要往悬浮窗推一份「这一段媒体是什么」，类型取自悬浮窗状态契约
import type { OverlayState } from '@shared/api'
import type {
  AspectMode,
  DanmakuComment,
  DanmakuSettings,
  LiveStartResult,
  LocalSubFile,
  LocalVideoFile,
  MediaInspectResult,
  PlayStatus,
  PlayFlowSnapshot,
  PlayRule,
  RuleEpisodeGroup,
  RuleSearchEntry,
  SubjectDetail
} from '@shared/types'
import { resolveDanmakuSettings } from '@shared/types'
import { mergeDanmakuBatches } from '@shared/danmakuTimeline'
import { ENGINE_ATTACH_TIMEOUT_MS, ONLINE_PLAY_TIMEOUT_MS, RELAY_READY_TIMEOUT_MS } from '@shared/onlinePlay'
import { api } from '@/lib/api'
import { fmtDuration, localSubUrl, localVideoUrl } from '@/lib/format'
import { useLibrary } from '@/stores/library'
import { epKey, localKey, onlineKey, useWatchProgress } from '@/stores/watchProgress'
import { enterPlayer, whenPlayerGone } from '@/lib/playerSession'
import { matchShortcut, useShortcuts } from '@/stores/shortcuts'
import { toast, useSettings } from '@/stores/app'
import { Badge, Spinner } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import { StreamInfoModal } from '@/components/StreamInfoModal'
import { PlayFlowStages } from '@/components/PlayFlowProgress'

/**
 * 合并两批弹幕并按时间排序（V1.1.2，与主进程 `danmaku.ts` 的 `mergeComments` 同一套规则）。
 *
 * 为什么渲染层也要有一份：两段式加载的第二段只把"数据源那一批"送回来，
 * 要与画面上已有的内置那批合并 —— 让主进程再算一次需要把它手上的量再传回来，不值当。
 * 去重键 = 「时间（0.1 秒精度）+ 正文」：不同源对同一条弹幕的毫秒位常有差异，
 * 但同一句话在同一秒出现两次本来就该算重复。
 */
/**
 * 合并两批弹幕（V1.2：调共享实现，不再在渲染层写第三份去重逻辑）。
 *
 * 去重键/容差与主进程集成器完全一致（`@shared/danmakuTimeline`），
 * 容差来自设置里的「弹幕误差」，所以用户在设置里改 100→200ms 时两端同时生效。
 */
function mergeCommentsLocal(a: DanmakuComment[], b: DanmakuComment[], toleranceMs = 100): DanmakuComment[] {
  return mergeDanmakuBatches([a, b], { toleranceMs })
}

interface PlayerState {
  mode: 'local' | 'online' | 'rule'
  title: string
  url?: string
  folder?: string
  subjectId?: number
  episode?: number
  // 规则播放状态（直连流解析）
  ruleId?: string
  entry?: RuleSearchEntry
  vars?: Record<string, string>
  groups?: RuleEpisodeGroup[]
  referer?: string
  /** 从「继续观看」跳进来时的续播时间点（秒） */
  startSec?: number
  /**
   * 播放器内切集时用「重新挂载」的方式（v0.2.6）：带上当前线路/集序号，
   * 让新挂载的播放页知道自己在放第几集（否则选集列表高亮与自动连播都会错位）。
   */
  startLine?: number
  startEp?: number
  /** 已经预解析好的播放页地址：切集时直接用，省掉一次 rules.play */
  prefetchedUrl?: string
  /** 自动连播：不要对目标集做断点续播（应该从头播） */
  noResume?: boolean
  /**
   * 重新挂载用的键（v0.2.6）。
   *
   * react-router 里 navigate 到**同一个路由**不会重新挂载组件，只更新 location.state ——
   * 于是「切集」变成只改状态：旧的嗅探/内核状态全部残留，实测表现为切集后卡在 0 秒。
   * 这里给每次切集一个变化的值，配合 App.tsx 里的 `key` 让它真正重新挂载，
   * 从而和「从规则页进选集」走完全一样的初始化流程。
   */
  playKey?: number
}

const HIDE_DELAY = 5000
/** 距离结束多少秒开始预解析下一集（提前拿播放页地址，减少切集等待） */
const PRELOAD_LEAD = 40
/** 续播阈值：上次进度超过这个秒数才自动跳转，太小会显得莫名其妙 */
const RESUME_MIN_SEC = 30

/**
 * 播放倍速档位（v0.2.9 最后更新）。
 * 与 Kazumi 的档位一致（0.25–3.0 里取常用段），顺序即「按钮循环」的顺序；
 * 1 放在中间位置，循环一圈不会出现跳档突兀感。
 */
export const SPEED_STEPS: number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]
/** 倍速显示文案：1 → `1.0x`，1.25 → `1.25x` */
export function formatSpeed(s: number): string {
  return `${Number(s).toFixed(Number.isInteger(s) ? 1 : 2).replace(/0$/, '')}x`.replace('.x', '.0x')
}

export function PlayerPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const baseState = (location.state ?? { mode: 'online', title: '播放' }) as PlayerState
  // 自检/调试入口：?folder=<路径> 可直接以本地模式打开播放器（SAKANA_PLAYERUI_TEST 使用）
  const query = new URLSearchParams(location.search)
  const queryFolder = query.get('folder')
  /**
   * 自检专用的状态注入通道（两种，按优先级）：
   * 1. URL 参数 `?ts=<base64(JSON)>` —— 主进程没法直接给 react-router 传 state，
   *    而 file:// 源下 Chromium 不保留 sessionStorage，所以以 URL 参数为主；
   * 2. sessionStorage 的 `sakana-test-state`（dev URL 下可用）。
   * 正常运行时两者都不会出现，对用户行为零影响；
   * 自动连播自检（SAKANA_EPISODE_TEST）靠它在真实播放器里复现「播完是否跳到下一集」。
   */
  const injectedState = ((): PlayerState | null => {
    const raw = query.get('ts')
    if (raw) {
      try {
        const bin = atob(raw)
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
        return JSON.parse(new TextDecoder().decode(bytes)) as PlayerState
      } catch {
        /* 参数损坏则忽略 */
      }
    }
    try {
      const stored = sessionStorage.getItem('sakana-test-state')
      if (!stored) return null
      sessionStorage.removeItem('sakana-test-state')
      return JSON.parse(stored) as PlayerState
    } catch {
      return null
    }
  })()
  const state: PlayerState = queryFolder
    ? {
        mode: 'local',
        title: query.get('title') ?? '测试视频',
        folder: queryFolder,
        episode: undefined
      }
    : (injectedState ?? baseState)
  const addWatch = useLibrary((s) => s.addWatch)

  const videoRef = useRef<HTMLVideoElement>(null)
  const [files, setFiles] = useState<LocalVideoFile[]>([])
  const [filesLoading, setFilesLoading] = useState(state.mode === 'local')
  const [currentIndex, setCurrentIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [visible, setVisible] = useState(true)
  const [showInfo, setShowInfo] = useState(false)
  const [showEpisodes, setShowEpisodes] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [detail, setDetail] = useState<SubjectDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [subIndex, setSubIndex] = useState(-1)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [src, setSrc] = useState('')
  const [live, setLive] = useState<(LiveStartResult & { height: number | null }) | null>(null)
  const [inspectInfo, setInspectInfo] = useState<MediaInspectResult | null>(null)
  const [preparing, setPreparing] = useState(state.mode === 'local')
  const [engineState, setEngineState] = useState<'trying' | 'active' | 'fallback'>('trying')
  const [engineError, setEngineError] = useState<string | null>(null)
  const [ruleStreamUrl, setRuleStreamUrl] = useState<string | null>(null)
  const [rulePageUrl, setRulePageUrl] = useState(state.url ?? '')
  const [ruleProbeFailed, setRuleProbeFailed] = useState(false)
  const [ruleProbing, setRuleProbing] = useState(false)
  /**
   * 进来时确认「正在放第几集」：
   * 1. 优先用跳转参数带进来的 startLine/startEp（规则页选集、继续观看、播放器内切集都会带）；
   * 2. 没带就按播放页地址在剧集列表里反查（v0.2.7 兜底）——
   *    过去漏带参数时播放器会默认按第 1 集算，于是「看第 3 集却显示第 1 集」，
   *    自动连播也会从第 1 集往后跳（用户反馈的「第 3 集播完跳到第 2 集」）。
   */
  const [ruleCurrent, setRuleCurrent] = useState<{ line: number; ep: number } | null>(() => {
    if (state.startLine != null && state.startEp != null) {
      return { line: state.startLine, ep: state.startEp }
    }
    const target = (state.url ?? '').split('?')[0].replace(/\/+$/, '')
    if (!target) return null
    const groups = state.groups ?? []
    for (let li = 0; li < groups.length; li++) {
      const eps = groups[li]?.episodes ?? []
      for (let ei = 0; ei < eps.length; ei++) {
        const link = (eps[ei]?.link ?? '').split('?')[0].replace(/\/+$/, '')
        if (link && link === target) return { line: li, ep: ei }
      }
    }
    return null
  })
  const [playerVolume, setPlayerVolume] = useState(100)
  const [playerMuted, setPlayerMuted] = useState(false)
  /**
   * 播放倍速（v0.2.9 最后更新）。
   *
   * 为什么用 1 作为默认、并把档位常量放在组件外：倍速是「一次设置、长期保持」的状态，
   * 切集不该被重置（用户调了 1.5x 通常希望下一集也是 1.5x）；
   * 档位表放在模块级，Overlay 与快捷键共用同一份，避免两处各写一遍档位。
   */
  const [playerSpeed, setPlayerSpeed] = useState(1)
  const playerSpeedRef = useRef(playerSpeed)
  playerSpeedRef.current = playerSpeed

  /**
   * 应用倍速（v0.2.9 最后更新：README 一直宣称支持倍速，实际缺失，对照 Kazumi 时补上）。
   *
   * 用 `function` 声明而不是 `const` 箭头函数：控制栏动作与快捷键处理都在下面几百行处调用它，
   * `const` 会因为暂时性死区（TDZ）在运行时抛 ReferenceError（类型检查也会直接报「找不到名字」）。
   * 内核走 mpv 的 `speed` + `scaletempo2` 音频滤镜（**变速不变调**），HTML5 回退路径走 `playbackRate`。
   */
  function applySpeed(speed: number): void {
    const s = Math.max(0.25, Math.min(4, speed || 1))
    setPlayerSpeed(s)
    if (engineState !== 'fallback') void api.player.setSpeed(s)
    const el = videoRef.current
    if (el) el.playbackRate = s
    toast.info(s === 1 ? '已恢复原速' : `倍速 ${formatSpeed(s)}`)
  }
  const [engineSubs, setEngineSubs] = useState<{ id: number; label: string }[]>([])
  const [engineSubIdx, setEngineSubIdx] = useState(-1)
  /** 画面比例：fit=适应 / cover=裁剪铺满 / stretch=拉伸铺满 */
  const [aspect, setAspect] = useState<AspectMode>('fit')
  /** 顶部状态栏文案（捕捉视频流中 / 加载中 / 播放中 / 播放失败…） */
  const [statusLog, setStatusLog] = useState<string[]>([])
  const [showStreamInfo, setShowStreamInfo] = useState(false)
  /**
   * 播放过程进度（v0.3.9）：三阶段（找资源 / 取资源 / 注入播放器）的实时快照。
   *
   * 数据完全来自主进程（`api.player.flow()` 是纯内存读），这里只负责显示。
   * 刷新挂在**既有的**「尚未开播时每 800ms 问一次内核」那条轮询上，
   * 不新开定时器 —— 用户明确要求「复用现有播放状态详情的实时推送，别再开一条每帧轮询」。
   */
  const [flow, setFlow] = useState<PlayFlowSnapshot | null>(null)
  /** 最近一次自检的结果（v0.3.9）：非空时在状态区显示「自检做了什么」，用户要求不许静默 */
  const [selfCheckNote, setSelfCheckNote] = useState('')
  /**
   * 本轮流程是否**成功出过画面**（v0.3.9）。
   *
   * 为什么必须有它：「加载中」这一层不能只看 `!playing` ——
   * 用户暂停之后 `playing` 也是 false，那时再盖一层「加载中 + 过程进度」就成了严重的误报
   * （暂停的画面被一块半透明黑罩住，还写着加载中）。
   * 所以判据是「本轮还没有真正开播过」。
   */
  const [startedOnce, setStartedOnce] = useState(false)
  /** 自动续播提示：非空时右下角显示「是否撤销本次跳转」 */
  const [resumeHint, setResumeHint] = useState<{ at: number; target: number } | null>(null)
  const [switching, setSwitching] = useState(false)
  const { settings: appSettings, save: saveSettings } = useSettings()
  /** v0.2.8：弹幕（整集数据 + 显示设置），推送悬浮窗绘制 */
  const [danmaku, setDanmaku] = useState<{ comments: DanmakuComment[]; source: string; loading: boolean }>({
    comments: [],
    source: '',
    loading: false
  })
  const danmakuSettings = resolveDanmakuSettings(appSettings?.danmaku)
  const danmakuSettingsRef = useRef(danmakuSettings)
  danmakuSettingsRef.current = danmakuSettings
  /**
   * v0.2.9：弹幕是否由 mpv 的 uosc_danmaku 插件渲染。
   * 插件是在「进入播放器时」跟着 mpv 一起挂载的，所以这里在引擎就绪后查一次状态；
   * 为 true 时内置画布让位（同一份弹幕数据交给插件画），避免两套弹幕叠在一起。
   */
  const [uoscActive, setUoscActive] = useState(false)
  const uoscActiveRef = useRef(false)
  uoscActiveRef.current = uoscActive
  /** 已经为哪一集拉过弹幕（避免重复请求） */
  const danmakuKeyRef = useRef('')
  /** 当前弹幕对应的「集」标识（同一集内重载时保留已有弹幕） */
  const danmakuBaseKeyRef = useRef('')
  // 设置加载完成后同步一次（首帧可能拿不到设置）
  useEffect(() => {
    if (appSettings?.aspectMode && appSettings.aspectMode !== aspect) setAspect(appSettings.aspectMode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSettings?.aspectMode])
  const hideTimer = useRef<number | undefined>(undefined)
  const recordedRef = useRef('')
  const fallbackTriedRef = useRef(false)
  const seekTimerRef = useRef<number | undefined>(undefined)
  const ruleStreamRef = useRef<string | null>(null)
  const probeCancelRef = useRef<(() => void) | null>(null)
  /**
   * 上一轮嗅探的**完整**清理函数（v0.3.9 体检 M3）。
   *
   * 为什么单独立一个 ref：`startRuleProbe()` 内部会注册 `onFound/onDone` 两个 ipcRenderer 监听
   * （每次调用都是**新的一对**）并返回清理函数。但看门狗里的「重新嗅探」以前直接把它调掉、返回的清理函数丢掉，
   * 于是每重嗅探一次就多两个永不注销的监听，长会话下会积累到 `MaxListenersExceededWarning`，
   * 而且已卸载实例的闭包被长期持有。现在统一存进这个 ref，并在下一轮开始前先清干净。
   */
  const probeDisposeRef = useRef<(() => void) | null>(null)
  const pokeRef = useRef<(() => void) | null>(null)
  /** 当前播放页地址（重试嗅探时要用，state 里读不到最新值） */
  const rulePageUrlRef = useRef('')
  /** 网页嗅探进行中：期间不自动隐藏控制条（否则用户无法点击退出） */
  const probingRef = useRef(false)
  /** 当前是否已进入播放（用于判断直连失败并切换到 FFmpeg 中转） */
  const playingRef = useRef(false)
  const relayRef = useRef<{ sessionId: string } | null>(null)
  const relayTriedRef = useRef(false)
  /** 切集互斥：连点/快捷键重复触发时只允许一次切换在飞，避免卡在中间态 */
  const switchRef = useRef(false)
  /**
   * 下一集预取结果：播放页地址（切集直接用，省一次解析）与已验证的直链
   * （写进主进程会话缓存，切集时可跳过整轮嗅探）。
   */
  const prefetchRef = useRef<{
    key: string
    pageUrl: string
    vars?: Record<string, string>
    stream?: { url: string; referer?: string }
  } | null>(null)
  /** 本集是否已经做过续播跳转（只在每集第一次播放时做一次） */
  const resumeDoneRef = useRef('')
  /** 自动连播是否已经触发（防止 time 事件高频重复触发） */
  const autoNextRef = useRef('')
  /** 上次自动连播的时间：两次之间强制间隔，避免异常信号把整季快进完 */
  const lastAutoNextRef = useRef(0)
  /** 本集开播时间戳（毫秒）：进度兜底判定需要「已播够久」才允许连播 */
  const playStartedAtRef = useRef(0)
  /**
   * 是否还在等「本集真正开播」（v0.2.6）。
   *
   * 关键修复：换集是重新挂载播放页，但内核还持有**上一集**的媒体 ——
   * 它会继续上报旧媒体的 time/length（例如 1440/1440）以及 ended，
   * 于是新页面刚挂载就以为「已经播完」，自动连播被反复触发、一路快进到最后一集
   * （实测日志：0:0→0:1→0:2→…→0:8）。这里在收到本集自己的 playing 之前，
   * 一律忽略时间与结束事件。
   */
  const awaitingStartRef = useRef(true)
  /** 播放进度上报节流 */
  const progressRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const progressApi = useWatchProgress()

  /**
   * 播放状态（顶部状态栏文案）：失败 > **播放中** > 捕捉视频流 > 切换中 > 加载 > 已暂停。
   *
   * v0.2.8 修「已经在播放了（有声音）却一直显示捕捉视频流中」：
   * 「播放中」必须排在「捕捉视频流」**前面**。原因见下面 `playing` 事件里的说明 ——
   * 缓存直链 / 上一集下一集切换时可能还有一轮嗅探在跑，此时画面与声音早就起来了，
   * 若让嗅探状态优先，状态栏就会一直卡在「捕捉视频流中」。
   */
  const playStatus: { kind: PlayStatus; text: string } = videoError
    ? { kind: 'failed', text: '播放失败' }
    : ruleProbeFailed
      ? { kind: 'failed', text: '播放失败' }
      : playing
        ? { kind: 'playing', text: '播放中' }
        : ruleProbing
          ? { kind: 'capturing', text: '捕捉视频流中' }
          : switching
            ? { kind: 'loading', text: '切换中' }
            : engineState === 'trying' || preparing
              ? // 规则模式挂载到开始嗅探之间还有一个「解析播放页」的阶段，单独给出文案（v0.2.7）
                state.mode === 'rule'
                ? { kind: 'loading' as PlayStatus, text: '准备播放源' }
                : { kind: 'loading' as PlayStatus, text: '加载中' }
              : { kind: 'idle', text: '已暂停' }

  /**
   * 直连播放失败时的补救（v0.2.6）。
   *
   * 实测发现：部分站点（aafun/moonci 的 `pan.wo.cn` 直链）给出的是**短时效/一次性地址** ——
   * 抓到时可用，稍后再去取就返回 5XX/400（用 ffprobe 复验过）。
   * 因此直连失败时不再直接把这条可能已过期的地址丢给 FFmpeg 中转，而是**先重新嗅探一次**
   * 拿一条新鲜地址；只有重嗅也不成功才走中转。
   */
  const retriedCaptureRef = useRef(false)
  /** 重嗅探的兜底计时器（超时就改走中转，并随卸载清理） */
  const probeFallbackTimerRef = useRef<number | undefined>(undefined)
  /**
   * 直连看门狗（15 秒未开播 → 重嗅探/中转）的**当前**计时器（v0.3.7）。
   *
   * 为什么必须只留一个：`onFound` 每收到一个候选就起一个 15 秒计时器，
   * 而一次嗅探常常连着推好几个候选（先广告短片、后正片，或多码率变体），
   * 旧写法让这些计时器各活各的 —— 它们虽然都自守 `playingRef`，
   * 但「切集之后上一集残留的计时器」仍可能在 15 秒后触发「视频流可能已过期，正在重新解析…」，
   * 把正在播的这一集重新嗅一遍（甚至顶掉当前流）。现在换成新的候选来了就取消上一个。
   */
  const streamWatchdogRef = useRef<number | undefined>(undefined)
  /**
   * 「嗅探窗口该关，但要等确认开播再关」（v0.3.5）。
   *
   * 以前一抓到候选就立刻销毁网页视图，于是：万一这个候选是广告短片 / 失效地址，
   * 后续真正的流请求再也没人接得住 —— 界面卡在加载态，声音却还在（网页播放器还在放）。
   * 现在改为命中后置位，真正开播时（playing 事件或状态轮询确认）再关。
   */
  const pendingCloseWebviewRef = useRef(false)
  /**
   * 本集是否已经做过一次「开播后重新校准画面区域」（v0.3.7）。
   * 每次换媒体都要能再校准一次，所以在新一次 play 成功时复位。
   */
  const layoutResyncRef = useRef(false)

  /** 直连播放失败时：用内置 FFmpeg 带站点会话去取流并 remux，再交给播放器 */
  const startFfmpegRelay = async (url: string, referer?: string, cookies?: string) => {
    if (relayTriedRef.current) return
    relayTriedRef.current = true
    toast.info('直连未成功，正在通过内置 FFmpeg 中转该视频流…')
    const r = await api.media.startLiveUrl(url, { referer, cookies })
    if (!r.ok) {
      setVideoError(`在线播放失败：${r.error}`)
      return
    }
    relayRef.current = { sessionId: r.data.sessionId }
    void api.player.play(r.data.url)
    /*
     * 中转成功的判定要给足时间：FFmpeg 需要先连上源站、缓冲一段才会开始出数据，
     * 24 分钟的长片在冷启动 + 慢 CDN 下超过 12 秒很常见。
     * v0.3.9：30 秒 → 60 秒，与在线播放链路统一（见 @shared/onlinePlay）。
     */
    window.setTimeout(() => {
      if (!playingRef.current) {
        setVideoError(
          `在线播放失败：该站点的视频流在中转 ${RELAY_READY_TIMEOUT_MS / 1000} 秒内仍未出数据，请切换其它规则或退出`
        )
      }
    }, RELAY_READY_TIMEOUT_MS)
  }
  const subtitlesLoadedRef = useRef('')

  const currentFile = files[currentIndex]
  const currentSubs: LocalSubFile[] = currentFile?.subs ?? []
  const subtitleLabel = engineSubIdx >= 0 && engineSubs[engineSubIdx] ? engineSubs[engineSubIdx].label : null

  // 刷新字幕轨列表（libmpv 接口）
  const refreshEngineSubs = async (retries = 0): Promise<void> => {
    const r = await api.player.subtitleTracks()
    if (r.ok) {
      setEngineSubs(r.data)
      setEngineSubIdx((prev) => (prev === -1 ? -1 : Math.min(prev, r.data.length - 1)))
      // 内核解析字幕轨需要时间（libmpv 读 track-list 更晚）：为空时短暂重试，避免误报「无字幕轨」
      if (r.data.length === 0 && retries < 5) {
        window.setTimeout(() => void refreshEngineSubs(retries + 1), 700)
      }
    }
  }

  const cycleEngineSubtitle = async () => {
    if (engineSubs.length === 0) {
      toast.info('未检测到字幕轨（内封或外挂字幕文件）')
      return
    }
    const next = engineSubIdx + 1 >= engineSubs.length ? -1 : engineSubIdx + 1
    setEngineSubIdx(next)
    await api.player.setSubtitle(next === -1 ? -1 : engineSubs[next].id)
    toast.info(next === -1 ? '字幕已关闭' : `字幕：${engineSubs[next].label}`)
  }

  // 内核就绪后拉取初始状态；播放时刷新字幕轨、加载外挂字幕
  useEffect(() => {
    if (engineState !== 'active') return
    void api.player.getState().then((r) => {
      if (r.ok) {
        setPlayerVolume(r.data.volume)
        setPlayerMuted(r.data.muted)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineState])

  useEffect(() => {
    if (engineState !== 'active') return
    const sourceKey = state.mode === 'local' ? (currentFile?.path ?? '') : (ruleStreamUrl ?? '')
    if (!sourceKey || subtitlesLoadedRef.current === sourceKey) return
    subtitlesLoadedRef.current = sourceKey
    // 本地模式：加载同名字幕文件
    if (state.mode === 'local' && currentSubs.length > 0) {
      for (const s of currentSubs) void api.player.addSubtitleFile(s.path)
    }
    setTimeout(() => void refreshEngineSubs(), 800)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineState, currentFile?.path, ruleStreamUrl])

  /**
   * 播放过程进度：本轮流程开始 + 「找播放资源」阶段（v0.3.9）。
   *
   * 为什么阶段边界由渲染层划：三阶段的顺序是**页面流程**决定的
   * （先准备好播放页地址 / 扫描本地文件 → 再嗅探直链 → 最后交给内核），
   * 这套顺序只有播放页自己知道。但状态只保留一份（在主进程），
   * 所以这里只发「标记」，由主进程维护时间线，
   * 详情面板（每秒轮询 streamInfo）与状态栏看到的因此永远是同一份数据。
   */
  useEffect(() => {
    /*
     * ⚠️ 没有真实播放目标时**不要**开一轮流程（v0.3.9 自查补的）。
     *
     * 这个 effect 在挂载时无条件跑，而播放页也可能被**直接打开**（托盘、小窗口列表、
     * 上个会话残留、或者只是路由切错）——那种情况下流程永远推进不到第二步，
     * 状态区就会一直显示「找播放资源 进行中 4.0s」：这是**假进度**，比不显示更糟
     * （用户会以为卡在找资源，而实际上根本没有在找）。
     */
    const hasTarget =
      state.mode === 'local' ? files.length > 0 : Boolean((state.url ?? '').trim() || rulePageUrl.trim())
    if (!hasTarget) {
      void api.player.flowMark({ kind: 'reset' })
      setFlow(null)
      setSelfCheckNote('')
      setStartedOnce(false)
      return
    }
    void api.player.flowMark({ kind: 'begin', mode: state.mode, title: state.title })
    void api.player.flowMark({
      kind: 'stage',
      stage: 'locate',
      detail: state.mode === 'local' ? '正在扫描本地视频文件' : '正在解析播放页地址（规则搜索 / 取集）'
    })
    setFlow(null)
    setSelfCheckNote('')
    setStartedOnce(false)
    // 切集是重新挂载播放页，所以这个 effect 每次换集都会重跑一轮流程
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode, state.title, state.url])

  // 尝试嵌入 libmpv 播放内核；失败回退 HTML5 + FFmpeg 管线
  useEffect(() => {
    let alive = true
    /*
     * 进播放页先做一次**嗅探自检 + 重置**（v0.3.9）。
     *
     * 这里过去只有一句 `api.ruleWebview.close()`（v0.3.7 的保险）。
     * 但用户报的问题是**两类**：①上一路播完后嗅探程序没反应过来（残留窗口/残留监听）；
     * ②播放器销毁后没重建。只关一次网页视图覆盖不了 ②，也不会告诉用户发生了什么。
     * 现在换成完整的自检：它会查残留探针窗口、残留 webRequest 监听、残留收尾计时器，
     * 以及内核挂载是否指向已销毁的窗口；发现异常就地重置，并把「做了什么」回报上来
     * （用户明确要求不许静默）。
     */
    void api.player
      .selfCheck({ reset: true })
      .then((r) => {
        if (!r.ok) return
        const problems = r.data.findings.filter((f) => f.level !== 'ok')
        if (problems.length > 0) {
          setSelfCheckNote(
            `自检已重置：${problems.map((f) => f.title).join('；')}${
              r.data.needsReattach ? '（已销毁错配内核，正在重建播放器）' : ''
            }`
          )
        }
        /*
         * 内核侧发现错配 → 主进程已经把死掉的实例销毁了，这里重新挂载一次。
         * 「重建播放器」只由渲染层做：attach 需要视频区域的屏幕矩形，那个矩形只有页面知道。
         */
        if (r.data.needsReattach) {
          void api.player.attach({
            x: 0,
            y: 56,
            width: window.innerWidth,
            height: Math.max(120, window.innerHeight - 120)
          })
        }
      })
      .catch(() => undefined)
    void (async () => {
      // 视频区域矩形：libmpv 用它定位画面子窗口
      const hostRect = (): { x: number; y: number; width: number; height: number } => {
        const el = document.getElementById('player-host')
        const r = el?.getBoundingClientRect()
        if (r && r.width > 0 && r.height > 0) {
          return { x: r.left, y: r.top, width: r.width, height: r.height }
        }
        return { x: 0, y: 56, width: window.innerWidth, height: Math.max(120, window.innerHeight - 120) }
      }
      /*
       * 防卡死：attach 若迟迟不响应（内核初始化异常）就降级，避免播放器界面卡住。
       *
       * v0.3.9：20 秒 → 60 秒，与在线播放链路统一（见 @shared/onlinePlay）。
       * 为什么敢放宽：libmpv 初始化 + 创建原生子窗口在低端机上偶发很慢，
       * 20 秒投降的结果是「慢机器上第一次进播放页必失败、第二次就好」——
       * 用户只会觉得播放器时好时坏。放宽到 60 秒后，真正卡死的仍然是 60 秒给结论，
       * 但慢机器不再被误判。
       */
      const attachResult = await Promise.race([
        api.player.attach(hostRect()),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ENGINE_ATTACH_TIMEOUT_MS))
      ])
      if (!alive) return
      if (attachResult === null) {
        const msg = `播放内核初始化超时（${ENGINE_ATTACH_TIMEOUT_MS / 1000} 秒无响应）`
        setEngineError(msg)
        if (state.mode === 'rule') setVideoError(`在线播放初始化失败：${msg}`)
        else setEngineState('fallback')
        return
      }
      const r = attachResult
      if (r.ok && r.data.ok) {
        setEngineState('active')
        setPreparing(false)
      } else {
        const msg = r.ok ? r.data.message : r.error
        setEngineError(msg)
        if (state.mode === 'rule') {
          // 在线播放初始化失败：不再回退网页播放，直接显示错误并允许退出
          setVideoError(`在线播放初始化失败：${msg}`)
        } else {
          setEngineState('fallback')
        }
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode])

  /**
   * 规则模式：Kazumi 式在线播放 —— 用可见网页视图打开播放页，
   * 让站点播放器在真实会话中运行并嗅探媒体地址，命中后交给 libmpv 播放。
   *
   * v0.2.7 附加（提速）：进这一集之前若已有**缓存直链**（上一轮嗅探、或切集前的预取），
   * 直接交给内核播放，跳过「建窗口 → 加载播放页 → 等播放器发请求」整轮嗅探；
   * 4 秒内没开播就自动回到完整嗅探（缓存直链有时效，失败不能让用户干等）。
   */
  const startRuleProbe = (pageUrl: string, opts?: { skipCache?: boolean }) => {
    // 先彻底拆掉上一轮（含它的两个 IPC 监听与看门狗），再开新的 —— 否则重嗅探会越积越多（体检 M3）
    if (probeDisposeRef.current) {
      probeDisposeRef.current()
      probeDisposeRef.current = null
    }
    if (probeCancelRef.current) probeCancelRef.current()
    // 新一轮嗅探：重置播放/中转状态并停掉上一条中转流
    playingRef.current = false
    relayTriedRef.current = false
    // 上一轮留下的「待关网页视图」标记作废（这一轮会重新决定）
    pendingCloseWebviewRef.current = false
    if (relayRef.current) {
      void api.media.stopLive(relayRef.current.sessionId)
      relayRef.current = null
    }
    setRulePageUrl(pageUrl)
    rulePageUrlRef.current = pageUrl
    setRuleStreamUrl(null)
    ruleStreamRef.current = null
    setRuleProbeFailed(false)
    setRuleProbing(true)
    probingRef.current = true
    setVisible(true)
    /*
     * 过程进度（v0.3.9）：播放页地址已经拿到 = 「找播放资源」完成，进入「获取播放资源」。
     * 后面的窗口建立/页面加载/自动点击等细节由主进程的 ruleProbe/ruleWebview 直接补进同一阶段。
     */
    void api.player.flowMark({ kind: 'ok', stage: 'locate', detail: '播放页地址已就绪' })
    void api.player.flowMark({
      kind: 'step',
      stage: 'acquire',
      text: `播放页：${pageUrl.slice(0, 80)}`
    })
    void api.player.flowMark({ kind: 'stage', stage: 'acquire', detail: '正在嗅探播放页里的媒体地址' })
    let cancelled = false
    let usedWebview = false
    /** 缓存直链是否命中（命中时先不建嗅探窗口，等看门狗判定失败再建） */
    let cacheHit = false
    /** 网页视图位置：视频区域（上下控制条之外），保证退出按钮始终可点 */
    const currentBounds = (): { x: number; y: number; width: number; height: number } => {
      const host = document.getElementById('player-host')
      const r = host?.getBoundingClientRect()
      if (r && r.width > 0 && r.height > 0) {
        return { x: r.left, y: r.top, width: r.width, height: r.height }
      }
      return { x: 0, y: 56, width: window.innerWidth, height: Math.max(120, window.innerHeight - 112) }
    }
    const syncBounds = (): void => {
      if (usedWebview) void api.ruleWebview.setBounds(currentBounds())
    }
    window.addEventListener('resize', syncBounds)

    probeCancelRef.current = () => {
      cancelled = true
      probingRef.current = false
      window.removeEventListener('resize', syncBounds)
      if (usedWebview) void api.ruleWebview.close()
      void api.ruleProbe.stop()
    }
    /*
     * 嗅探窗口「用完即毁」但**必须等到真的开播**（v0.3.5）。
     *
     * 用户报的现象：AGE 一直卡在「加载播放流」却已经能听到声音。
     * 查日志发现真因是「第一个候选被锁死」：嗅探窗口一开，
     * 渲染层自己的模块 `http://localhost:5173/src/stores/library.ts` 先被当成媒体流
     * 上报（开发服务器源码后缀就是 `.ts`，与 MPEG-TS 撞车，主进程已加过滤），
     * 而这里旧代码是「已经有一个流地址就再也不接受新的、非 m3u8 的候选」——
     * 于是随后捕获到的**真流地址被无声丢弃**，mpv 拿到一个 JS 模块，
     * 界面停在加载态、声音却来自仍在播放的网页播放器。
     * 现在两处都修了：主进程过滤掉开发服务器资源；这里改成
     * 「只要还没真正开播，后来的候选（尤其 m3u8）可以顶掉前一个」，并且
     * **网页视图保留到确认开播**（`pendingCloseWebviewRef`），
     * 这样万一第一个地址是个广告/短片，后续请求还能被抓到并自动接管。
     */
    /** 确认开播后收尾：关掉嗅探窗口并清掉待关标记（多处调用，收敛成一个函数） */
    const closeWebviewIfIdle = (): void => {
      if (!usedWebview) return
      if (playingRef.current) {
        void api.ruleWebview.close()
        return
      }
      pendingCloseWebviewRef.current = true
    }
    const offFound = api.ruleProbe.onFound((ev) => {
      if (cancelled) return
      const current = ruleStreamRef.current
      const started = playingRef.current
      // 已经在放这一个地址 → 忽略重复上报
      if (current === ev.url) return
      /*
       * 已开播：只有 m3u8（真正的列表地址）才值得换，避免播放中被打断；
       * 未开播：后到的候选一律可以顶掉先到的（先到的很可能是广告/失效地址）。
       */
      if (current && started) {
        /*
         * 已经在放，而且**已经看进去一段了**（v0.3.7）：一律忽略新候选。
         *
         * 换流实现上是给内核 `loadfile replace`，进度必然回 0。开播头 75 秒内出现新候选
         * 是常见且值得换的（先抓到广告短片 / 占位流，真流随后才请求），
         * 但用户看了两分钟之后再来一个候选就换，就是「看着看着跳回开头」——
         * 那比多看一段广告难受得多。所以只在前 75 秒允许换。
         */
        if (Date.now() - playStartedAtRef.current > 75_000) {
          console.log('[player] 已开播较久，忽略后到的候选（避免把进度打回 0）')
          return
        }
        if (ev.kind !== 'm3u8') return
      }
      {
        ruleStreamRef.current = ev.url
        setRuleStreamUrl(ev.url)
        setRuleProbing(false)
        probingRef.current = false
        relayTriedRef.current = false
        // 命中后先别销毁网页视图：等确认开播再关（见上面的说明）
        closeWebviewIfIdle()
        void api.ruleProbe.stop()
        playingRef.current = false
        // referer 语义：undefined=未判定（回退规则站点）；''=经校验确定不带 Referer
        const refForPlay = ev.referer !== undefined ? ev.referer || undefined : state.referer
        /*
         * v0.2.7 附加：这里过去是 `void api.player.play(...)` —— 引擎还没就绪（attach 未完成）
         * 或内核报错时，失败被直接丢掉：界面停在「捕捉视频流中/已暂停 0:00」，
         * 既没有日志也没有提示，看起来就是「抓到了流但播不出来」。
         * 现在带重试并记录；仍然失败才提示用户。
         */
        const playWithRetry = async (attempt = 0): Promise<void> => {
          const r = await api.player.play(ev.url, refForPlay, ev.cookies)
          if (r.ok) {
            // 新一次交给内核播放：允许开播后再校准一次画面区域（见 layoutResyncRef 的说明）
            layoutResyncRef.current = false
            /*
             * v0.2.8 附加七：把**播放页地址**告知 mpv 的 B 站弹幕脚本。
             * 交给内核的是直链，脚本无法据此反推 B 站页面（也就取不到弹幕），
             * 所以必须由宿主把 `state.url`（规则模式下就是播放页地址）告诉它。
             */
            if (state.mode === 'rule' && state.url) void api.player.setDanmakuSource(state.url)
            /*
             * 正在投屏时，换集/换源要**跟着电视一起换**（v0.3.8）。
             *
             * 规则模式下每一集都是新的播放页地址与新抓到的直链，接收端拿不到别的集的地址
             * （那需要再走一遍"解析播放页 + 嗅探"），所以"选集"这件事以电脑这边为准：
             * 用户在电脑上切集，投屏自动把新的一集推给同一台设备。
             */
            if (castDeviceRef.current) {
              const deviceId = castDeviceRef.current
              window.setTimeout(() => {
                if (castDeviceRef.current === deviceId) void startCastTo(deviceId)
              }, 600)
            }
            return
          }
          console.warn(`[player] 交给内核播放失败（第 ${attempt + 1} 次）：${r.error}`)
          /*
           * 「内核还没 attach」是**过程态**而不是失败（v0.3.7）：
           * 命中直链缓存时这一步会跑在拿缓存的同时，而 attach 可能还在路上；
           * 旧代码只重试 3 次（2.7 秒）就放弃并弹一句红字，而那时内核刚刚就绪 ——
           * 用户看到的就是「明明抓到了流却提示内核不接受」。
           * 所以这一种错误给足等待窗口（约 9 秒），其它错误仍旧只重试 3 次。
           */
          const transient = /还没\s*attach|未就绪|not\s*attached/i.test(r.error ?? '')
          const maxAttempt = transient ? 9 : 2
          if (attempt < maxAttempt) {
            await new Promise((res) => window.setTimeout(res, 900))
            if (cancelled) return
            return playWithRetry(attempt + 1)
          }
          toast.error(`播放内核未接受该视频流：${r.error}`)
        }
        void playWithRetry()
        /*
         * v0.3.9：地址交给内核之后**并行**做一次资源可达性取证。
         *
         * 用户要求「拿到媒体地址后仍然播放失败…显示原因，是网站问题，还是网速太慢」。
         * 关键在**并行**：这一步绝不能挡「把地址交给 mpv」（否则最快能播的那条路也要多等一次往返）。
         * 正常情况下用户完全感觉不到它（确认数据在流动就立刻收手，不会把整集拉下来）；
         * 播不出来时它已经量好首字节耗时/速率/HTTP 状态，结论可以直接给用户。
         */
        void api.player
          .diagnose(ev.url, refForPlay, ev.cookies)
          .then((r) => {
            if (!r.ok) return
            /*
             * 「速度过慢」不结束播放（用户明确要求：还有数据在动就继续等，并显示实时速率），
             * 只在状态区把它说出来；主进程那边已经把它记进过程进度里了。
             */
            if (r.data.reason === 'slow') {
              toast.info(`资源获取速度过慢（约 ${Math.round(r.data.metrics.rateBps / 1024)} KB/s），仍在继续等待…`)
            }
          })
          .catch(() => undefined)
        /*
         * 记进会话直链缓存（v0.2.7 附加）：同一集来回切、退出再进、以及切集预取命中时
         * 都能跳过整轮嗅探。缓存有 6 分钟 TTL，过期或一次性令牌失效时看门狗会重新嗅探。
         */
        void api.rules.rememberStream(pageUrl, ev.url, refForPlay)
        /*
         * 换新候选之前先取消上一个看门狗（v0.3.7）：见 streamWatchdogRef 的说明 ——
         * 一次嗅探会推多个候选，旧计时器不该在新候选已经接手之后继续倒计时。
         */
        if (streamWatchdogRef.current !== undefined) window.clearTimeout(streamWatchdogRef.current)
        /*
         * 直连迟迟未开播 → 先用新地址重试（对付短时效直链），再不行才切 FFmpeg 中转。
         *
         * v0.3.9：15 秒 → 60 秒，与在线播放链路统一（见 @shared/onlinePlay 的说明）。
         * 为什么必须放宽：15 秒对慢 CDN + 长片冷启动是明显不够的
         * （实测 20–40 秒才出首帧的站点不少），提前重嗅探会把**正在正常拉流**的那一集顶掉，
         * 用户看到的就是「明明在放，突然重新捕捉视频流」。
         * 现在 60 秒才动，而只要数据还在动，可达性取证也会如实报「过慢但仍在等」。
         */
        streamWatchdogRef.current = window.setTimeout(() => {
          streamWatchdogRef.current = undefined
          if (cancelled || playingRef.current || relayTriedRef.current) return
          void api.player.flowMark({
            kind: 'detail',
            stage: 'inject',
            text: `交给内核后 ${ONLINE_PLAY_TIMEOUT_MS / 1000} 秒仍未出画面，正在重新解析地址`
          })
          if (!retriedCaptureRef.current) {
            retriedCaptureRef.current = true
            const pageUrl = rulePageUrlRef.current || state.url
            if (pageUrl) {
              toast.info(`视频流 ${ONLINE_PLAY_TIMEOUT_MS / 1000} 秒未出画面，正在重新解析…`)
              console.log('[player] 直连未开播：重新嗅探获取新的直链')
              // 返回的清理函数必须留下来（体检 M3）：下一轮开始前要先把这一轮的两个 IPC 监听拆掉
              probeDisposeRef.current = startRuleProbe(pageUrl) ?? null
              /*
               * 重嗅探也要有上限：站点有时不再给出新地址（或直接限流），
               * 那就退回到 FFmpeg 中转再试一次，而不是让用户一直盯着「捕捉视频流中」。
               * 同样按 60 秒口径（原来是 12 秒）。
               */
              probeFallbackTimerRef.current = window.setTimeout(() => {
                if (!cancelled && !playingRef.current && !relayTriedRef.current) {
                  console.log('[player] 重嗅探超时，改走 FFmpeg 中转')
                  void startFfmpegRelay(ev.url, refForPlay, ev.cookies)
                }
              }, ONLINE_PLAY_TIMEOUT_MS)
              return
            }
          }
          void startFfmpegRelay(ev.url, refForPlay, ev.cookies)
        }, ONLINE_PLAY_TIMEOUT_MS)
      }
    })
    const offDone = api.ruleProbe.onDone((ev) => {
      if (cancelled) return
      if (!ruleStreamRef.current) {
        setRuleProbeFailed(true)
        setRuleProbing(false)
        probingRef.current = false
        if (usedWebview) void api.ruleWebview.close()
        toast.info(ev.message ?? '未捕获到视频流')
      }
    })
    /** 完整嗅探（建窗口 / 隐藏窗口）；缓存直链失败时也会走这里 */
    const runFullProbe = (): void => {
      if (cancelled) return
      setRuleProbing(true)
      probingRef.current = true
      void api.player.flowMark({ kind: 'stage', stage: 'acquire', detail: '正在打开播放页并嗅探媒体地址' })
      // 优先走可见网页视图；创建失败则回退到隐藏窗口嗅探
      void api.ruleWebview.open(pageUrl, currentBounds(), state.referer).then((r) => {
        if (cancelled) return
        if (r.ok && r.data) {
          usedWebview = true
        } else {
          void api.ruleProbe.start(pageUrl, state.referer)
        }
      })
    }
    /*
     * 先看会话直链缓存（v0.2.7 附加）：命中就直接播，省掉整轮嗅探。
     * 缓存直链迟迟没开播（缓存已过期 / 一次性令牌被用掉）就自动回到完整嗅探，
     * 因此不会出现「点了没反应」——最坏情况只是多等这几秒。
     *
     * v0.3.9：这里的 2.5 秒**刻意不跟着 60 秒统一**。
     * 它不是「失败判定」而是一个**快路试探**：缓存直链要么几秒内就开播（那就省下整轮嗅探），
     * 要么说明缓存已经失效，早点回到完整嗅探反而更快。
     * 把它拉长到 60 秒只会让「缓存里是坏地址」这种情况白等一分钟。
     */
    if (!opts?.skipCache) {
      void api.rules.cachedStream(pageUrl).then((r) => {
        if (cancelled) return
        const hit = r.ok ? r.data : null
        if (!hit) {
          runFullProbe()
          return
        }
        cacheHit = true
        console.log(`[player] 直链缓存命中，跳过嗅探直接播放: ${hit.url.slice(0, 90)}`)
        ruleStreamRef.current = hit.url
        setRuleStreamUrl(hit.url)
        setRuleProbing(false)
        probingRef.current = false
        void api.player.flowMark({
          kind: 'step',
          stage: 'acquire',
          text: `命中会话直链缓存，直接交给播放器：${hit.url.slice(0, 70)}`
        })
        void api.player.flowMark({ kind: 'ok', stage: 'acquire', detail: '命中会话直链缓存' })
        void api.player.play(hit.url, hit.referer ?? state.referer, undefined)
        // 命中缓存这条路也一样要做可达性取证（缓存里的地址常常正是失效的那一条）
        void api.player
          .diagnose(hit.url, hit.referer ?? state.referer, undefined)
          .then((dr) => {
            if (dr.ok && dr.data.reason === 'site') {
              // 证据说明这条缓存地址已失效：直接忘记它，下次切到这一集会重新嗅探
              void api.player.selfCheck({
                reset: true,
                failedPageUrl: pageUrl
              })
            }
          })
          .catch(() => undefined)
        window.setTimeout(() => {
          if (cancelled || playingRef.current || relayTriedRef.current) return
          console.log('[player] 缓存直链未开播，改为完整嗅探')
          void api.player.flowMark({
            kind: 'step',
            stage: 'acquire',
            text: '缓存直链未开播，回到完整嗅探'
          })
          runFullProbe()
        }, 2500)
      })
    } else {
      runFullProbe()
    }
    return () => {
      offFound()
      offDone()
      if (probeCancelRef.current) probeCancelRef.current()
      probeCancelRef.current = null
      if (probeFallbackTimerRef.current) window.clearTimeout(probeFallbackTimerRef.current)
      // 直连看门狗也要随卸载清掉：否则退出播放页后它还会去重嗅探一次（v0.3.7）
      if (streamWatchdogRef.current !== undefined) {
        window.clearTimeout(streamWatchdogRef.current)
        streamWatchdogRef.current = undefined
      }
      void cacheHit
    }
  }

  /**
   * 「重跑」：播放失败之后重新走一遍「重新解析地址 → 嗅探 → 交给内核」（v0.3.9 补充）。
   *
   * 用户原话：「对于播放失败的播放源，在播放详情中增加一个『重跑』按钮，
   * 播放失败后重新跑一遍来获取资源播放」。
   *
   * 关键点是**复用**而不是新写一套：内部就是既有的 `startRuleProbe`
   * （它管着建窗口、onFound/onDone 订阅、直连看门狗、探针取消句柄），
   * 这里只做三件失败态特有的收尾：
   *   ① 清掉界面上的失败文案（否则新的一轮还没开始，界面已经写着「播放失败」）；
   *   ② 重新开一条过程进度（`kind: 'begin'` → 主进程重开一轮，阶段与失败原因一起清空）；
   *   ③ **跳过直链缓存**（`skipCache: true`）—— 失败最常见的原因之一就是命中了
   *      缓存里那条已经失效的直链，重跑还去读它等于原地打转。
   */
  const retryStream = (): void => {
    const pageUrl = rulePageUrlRef.current || state.url || ''
    if (state.mode !== 'rule' || !pageUrl) {
      // 本地播放没有「重新解析地址」这一步，不该给重跑入口；给出明确反馈而不是静默
      toast.info('本地播放不支持重跑，请重新选择文件')
      return
    }
    console.log(`[player] 用户点了「重跑」：重新解析并嗅探 ${pageUrl.slice(0, 90)}`)
    setVideoError(null)
    setRuleProbeFailed(false)
    setSelfCheckNote('')
    retriedCaptureRef.current = false
    void api.player.flowMark({ kind: 'begin', mode: state.mode, title: state.title })
    void api.player.flowMark({ kind: 'stage', stage: 'locate', detail: '重跑：正在重新解析播放页地址' })
    toast.info('正在重新解析并嗅探该播放源…')
    startRuleProbe(pageUrl, { skipCache: true })
  }

  /** 当前播放对象的进度键：在线用「规则 + 条目链接」，本地用文件路径 */
  const progressKeyOf = useCallback((): string => {
    if (state.mode === 'rule' && state.ruleId && state.entry?.link) {
      return onlineKey(state.ruleId, state.entry.link)
    }
    if (state.mode === 'local') {
      const f = files[currentIndex]
      if (f) return localKey(f.path)
    }
    return ''
  }, [state.mode, state.ruleId, state.entry, files, currentIndex])

  /** 开始播放某一集时登记进度（同时把该集标为已看） */
  const rememberEpisode = useCallback(
    (line: number, ep: number): void => {
      const id = progressKeyOf()
      if (!id) return
      const groups = state.groups ?? []
      const epName = groups[line]?.episodes?.[ep]?.name
      progressApi.noteEpisode({
        id,
        title: state.title,
        subjectId: state.subjectId,
        source: state.mode === 'local' ? 'local' : 'online',
        ruleId: state.mode === 'rule' ? state.ruleId : undefined,
        ruleName: undefined,
        entryName: state.entry?.name,
        entryLink: state.entry?.link,
        groupIndex: line,
        episodeIndex: ep,
        episodeName: epName
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [progressKeyOf, state.title, state.subjectId, state.mode, state.ruleId, state.entry, state.groups]
  )

  /** 本地播放也记一条（本地没有线路/集序号，用当前索引） */
  const rememberLocal = useCallback(
    (index: number): void => {
      const id = progressKeyOf()
      const f = files[index]
      if (!id || !f) return
      progressApi.noteEpisode({
        id,
        title: state.title,
        subjectId: state.subjectId,
        source: 'local',
        filePath: f.path,
        groupIndex: 0,
        episodeIndex: index,
        episodeName: f.episode != null ? `第 ${f.episode} 集` : f.name
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [progressKeyOf, files, state.title, state.subjectId]
  )

  /**
   * 上报播放位置：每 10 秒一次（节流在 store 里也有合并写），
   * 暂停/切集/退出时再补一次，保证「继续观看」拿到的时间点足够新。
   */
  const reportPosition = useCallback(
    (force = false): void => {
      const id = progressKeyOf()
      if (!id || duration <= 0 || current <= 0) return
      const now = Date.now()
      if (!force && progressRef.current.key === id && now - progressRef.current.at < 10000) return
      progressRef.current = { key: id, at: now }
      progressApi.setPosition(id, current, duration)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [progressKeyOf, current, duration]
  )

  /**
   * 预取某一集（v0.2.7 附加：切集提速）。
   *
   * 一次调用同时拿到「播放页地址 + 已验证的直链」，直链会写进主进程的会话缓存；
   * 切到该集时播放器命中缓存直接播，跳过「建嗅探窗口 → 加载播放页 → 等播放器发请求」。
   * 只走 HTML 直出（不开窗口），拿不到也没关系 —— 那一集仍走正常嗅探。
   */
  const prefetchNext = useCallback(
    (line: number, ep: number): void => {
      if (state.mode !== 'rule' || !state.ruleId || !state.entry) return
      const key = `${line}:${ep}`
      if (prefetchRef.current?.key === key) return
      prefetchRef.current = { key, pageUrl: '' }
      /*
       * 同时预取**弹幕**（v0.2.8 附加）：切集时弹幕直接命中缓存，
       * 不用等「搜索弹幕库 → 拉弹幕」这一两秒。
       */
      void api.danmaku.prefetch(state.title, ep + 1)
      const link = state.groups?.[line]?.episodes?.[ep]?.link ?? ''
      void api.rules
        .prefetchStream(state.ruleId, state.entry, line, ep, link, state.vars ?? {})
        .then((r) => {
          if (prefetchRef.current?.key !== key) return
          if (!r.ok || !r.data) {
            prefetchRef.current = null
            return
          }
          prefetchRef.current = {
            key,
            pageUrl: r.data.pageUrl,
            stream: r.data.url ? { url: r.data.url, referer: r.data.referer } : undefined
          }
          if (r.data.url) console.log(`[player] 已预取下一集直链（切集可秒开）: ${r.data.url.slice(0, 90)}`)
        })
        .catch(() => {
          if (prefetchRef.current?.key === key) prefetchRef.current = null
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.mode, state.ruleId, state.entry, state.groups, state.vars, state.title]
  )

  // 规则模式：选集切换
  /**
   * 切集（v0.2.6 重做：与「规则页选集」走同一条路 —— 重新挂载播放页）。
   *
   * 为什么要改成重新挂载：
   * - 规则页（番剧详情 → 播放源 → 选集）之所以稳，是因为它每次都**重新进入播放页**：
   *   内核重新 attach、嗅探窗口重新创建、状态全部干净；
   * - 原地的「边播边切」要在旧流还在跑、旧嗅探刚拆掉的情况下再开一轮嗅探，
   *   实测经常抓不到流或明显变慢（用户反馈的正是这一点）。
   * 另外先暂停当前播放再切，避免旧流继续占着网络（用户建议，也确实更稳）。
   */
  const handleRuleEpisode = async (line: number, ep: number, opts?: { auto?: boolean }): Promise<void> => {
    if (!state.ruleId || !state.entry) return
    if (switchRef.current) return
    switchRef.current = true
    setSwitching(true)
    try {
      setShowEpisodes(false)
      setVideoError(null)
      // 先暂停当前播放：旧流继续拉流会和新一轮嗅探抢带宽
      if (playing) void api.player.togglePause()
      reportPosition(true)

      // 目标播放页地址：优先用预解析结果，否则现解析一次
      const key = `${line}:${ep}`
      let pageUrl = ''
      /*
       * 切集的弹幕预取（v0.2.8 附加）：与播放页地址并行发起，
       * 跳转 + 挂载这段时间刚好用来加载弹幕，切过去基本立刻就有弹幕。
       */
      void api.danmaku.prefetch(state.title, ep + 1)
      const cached = prefetchRef.current
      if (cached && cached.key === key && cached.pageUrl) {
        pageUrl = cached.pageUrl
      } else {
        const link = state.groups?.[line]?.episodes?.[ep]?.link ?? ''
        const r = await api.rules.play(state.ruleId, state.entry, line, ep, link, state.vars ?? {})
        if (!r.ok) {
          toast.error(`切换失败：${r.error}`)
          setVideoError(`切换剧集失败：${r.error}`)
          return
        }
        pageUrl = r.data.url
      }
      prefetchRef.current = null

      // 重新挂载播放页（与规则页选集的跳转参数完全一致，额外带上当前线路/集序号）
      navigate('/player', {
        replace: true,
        state: {
          mode: 'rule',
          title: state.title,
          url: pageUrl,
          subjectId: state.subjectId,
          ruleId: state.ruleId,
          entry: state.entry,
          vars: state.vars,
          groups: state.groups,
          referer: state.referer,
          startLine: line,
          startEp: ep,
          prefetchedUrl: pageUrl,
          // 自动连播到下一集时从头播；手动切集沿用该集自己的断点
          noResume: !!opts?.auto,
          // 让 App.tsx 上的 key 变化 → 真正重新挂载（同路由 navigate 默认不重挂载）
          playKey: Date.now()
        } satisfies PlayerState
      })
    } finally {
      switchRef.current = false
      setSwitching(false)
    }
  }

  /** 自动连播：播到本集末尾（或收到 ended）时自动切下一集 */
  const autoNext = useCallback((): void => {
    if (state.mode !== 'rule') return
    const line = ruleCurrent?.line ?? 0
    const ep = ruleCurrent?.ep ?? 0
    const total = state.groups?.[line]?.episodes.length ?? 0
    const key = `${line}:${ep}`
    if (autoNextRef.current === key) return
    if (ep + 1 >= total) return
    // 两次连播之间至少间隔 30 秒：即使内核异常地连续上报结束，也不会一路快进到最后一集
    if (lastAutoNextRef.current && Date.now() - lastAutoNextRef.current < 30_000) return
    autoNextRef.current = key
    lastAutoNextRef.current = Date.now()
    console.log(`[player] 自动连播：当前 ${line}:${ep}（共 ${total} 集）→ 切到 ${line}:${ep + 1}`)
    toast.info('本集播放结束，正在自动播放下一集…')
    void handleRuleEpisode(line, ep + 1, { auto: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode, state.groups, ruleCurrent, handleRuleEpisode])

  /**
   * 预加载下一集 + 自动连播判定。
   *
   * v0.2.6 修「播完总是跳到最后一集」：
   * 旧实现只要 `current >= duration - 1.5` 就立刻连播，而内核刚开播时会短暂上报
   * 一个很小的 duration（甚至分片长度），于是条件在开播瞬间就成立 —— 表现为自动连播
   * 被反复触发、一路快进到最后一集。
   * 现在改成：
   * - **内核报 ended 才是主要信号**（最可靠，见下面的 ended 事件处理）；
   * - 进度兜底必须同时满足：时长 ≥ 60 秒、已播到 80% 以上、且距离开播已超过 60 秒；
   * - 同一集的连播只允许触发一次（autoNextRef），并且两次连播之间至少间隔 30 秒。
   */
  useEffect(() => {
    if (state.mode !== 'rule' || !ruleCurrent || duration <= 0 || !state.ruleId || !state.entry) return
    const line = ruleCurrent.line
    const ep = ruleCurrent.ep
    const total = state.groups?.[line]?.episodes.length ?? 0
    // ① 自动连播（严格兜底判定）
    const startedAt = playStartedAtRef.current
    const watchedEnough =
      startedAt > 0 &&
      duration >= 60 &&
      current >= duration * 0.8 &&
      Date.now() - startedAt > 60_000
    if (watchedEnough && current >= duration - 1.5) {
      autoNext()
      return
    }
    // ② 预加载下一集
    if (ep + 1 >= total) return
    const key = `${line}:${ep + 1}`
    if (prefetchRef.current?.key === key) return
    /*
     * v0.2.7 附加（切集提速）：只要已经播起来（current ≥ 30s）就预取下一集，
     * 不再等到快播完 —— 预取会同时解析「下一集播放页地址」和「直链」，
     * 于是切集时播放器直接命中直链缓存、跳过整轮嗅探。
     */
    if (current < 30) return
    void prefetchNext(line, ep + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, duration, ruleCurrent, state.mode, state.groups, state.ruleId, state.entry, autoNext])

  /**
   * 嗅探看门狗：迟迟仍在「捕捉视频流中」就给出可操作的失败提示（而不是一直转圈）。
   *
   * v0.3.9：45 秒 → 60 秒，与在线播放链路统一。
   * 主进程侧的嗅探本身也是按 60 秒收尾的（ruleProbe/ruleWebview 的兜底计时器），
   * 这里与它同口径之后，界面不会再出现「主进程还在试、界面先判失败」的错位。
   */
  useEffect(() => {
    if (!ruleProbing) return
    const t = window.setTimeout(() => {
      if (!ruleStreamRef.current) {
        setRuleProbing(false)
        probingRef.current = false
        setVideoError(
          `捕捉视频流超时：等待 ${ONLINE_PLAY_TIMEOUT_MS / 1000} 秒仍未捕获到媒体地址，该线路可能已失效，请切换线路或其它规则`
        )
      }
    }, ONLINE_PLAY_TIMEOUT_MS)
    return () => window.clearTimeout(t)
  }, [ruleProbing])

  /**
   * 失败后的收尾（v0.3.9）：跑一次自检重置，并把结论如实说出来。
   *
   * 为什么挂在「出现失败提示」这件事上：用户报的正是「换源/换集之后播放失败」，
   * 而这类失败的成因（残留探针窗口 / 内核错配 / 缓存里是坏直链）
   * 恰恰是自检能查、也能就地修掉的那几种。修完还要说明做了什么 —— 用户明确要求不许静默。
   */
  useEffect(() => {
    if (!videoError && !ruleProbeFailed) return
    void api.player
      .selfCheck({ reset: true, failedPageUrl: rulePageUrlRef.current || state.url })
      .then((r) => {
        if (!r.ok) return
        const problems = r.data.findings.filter((f) => f.level !== 'ok')
        if (problems.length > 0) {
          setSelfCheckNote(`失败后自检已重置：${problems.map((f) => f.title).join('；')}`)
        }
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoError, ruleProbeFailed])

  /**
   * 断点续播（v0.2.6 按集记录）。
   *
   * 谨慎点：
   * - 只在「本集第一次真正开播（playing=true 且时长已知）」时做一次，避免还没出画面就 seek 造成卡死；
   * - 目标位置必须大于 30 秒且距结尾还有 15 秒以上，否则不跳；
   * - 自动连播（noResume）进来的集数**不**续播，从头开始；
   * - 跳转后右下角给出「撤销」提示（现在画在悬浮窗里，否则会被原生视频窗口盖住看不见）。
   */
  useEffect(() => {
    if (!playing || duration <= 0) return
    if (state.noResume) return
    const id = progressKeyOf()
    if (!id) return
    const line = ruleCurrent?.line ?? 0
    const ep = ruleCurrent?.ep ?? currentIndex
    const stamp = `${id}#${line}:${ep}`
    if (resumeDoneRef.current === stamp) return
    resumeDoneRef.current = stamp
    const stored = progressApi.items.find((i) => i.id === id)
    // 先看「这一集自己的断点」，没有再退回整部番剧的断点（兼容旧记录）
    const perEpisode = state.mode === 'rule' ? progressApi.positionOf(id, epKey(line, ep)) : 0
    const explicit = state.startSec
    const target =
      explicit && explicit > RESUME_MIN_SEC
        ? explicit
        : perEpisode > RESUME_MIN_SEC
          ? perEpisode
          : stored && stored.positionSec > RESUME_MIN_SEC
            ? stored.positionSec
            : 0
    if (target <= 0 || target >= duration - 15) return
    setCurrent(target)
    void api.player.seek(target)
    setResumeHint({ at: Date.now(), target })
    toast.info(`已从上次位置 ${fmtDuration(target)} 继续播放`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration, progressKeyOf, ruleCurrent, currentIndex, state.startSec, state.noResume])

  // 撤销提示 10 秒后自动消失（用户反馈原来时间太短）
  useEffect(() => {
    if (!resumeHint) return
    const t = window.setTimeout(() => setResumeHint(null), 10000)
    return () => window.clearTimeout(t)
  }, [resumeHint])

  // 播放位置定时上报（每 15 秒一次；暂停时也上报，保证退出前的时间点不丢）
  useEffect(() => {
    if (duration <= 0) return
    const t = window.setInterval(() => reportPosition(), 15000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, reportPosition])

  // 规则模式：attach 就绪后开始探流
  useEffect(() => {
    if (engineState !== 'active' || state.mode !== 'rule') return
    const pageUrl = rulePageUrl || state.url
    if (!pageUrl) return
    const cleanup = startRuleProbe(pageUrl)
    // 记下这一轮的清理函数，供看门狗重嗅探时先拆旧的（体检 M3）
    probeDisposeRef.current = cleanup ?? null
    return () => {
      cleanup?.()
      if (probeDisposeRef.current === cleanup) probeDisposeRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineState, state.mode, rulePageUrl])

  // ---------- 观看进度（v0.2.4）：集数记录 + 断点续播 ----------
  // 原生内核模式：设置播放列表并播放当前集
  useEffect(() => {
    if (engineState !== 'active') return
    if (state.mode === 'local') {
      if (files.length === 0) return
      void api.player.setPlaylist(files.map((f) => f.path))
      const f = files[currentIndex]
      if (f) void api.player.play(f.path)
    } else if (state.mode === 'online') {
      // 直连流模式：url 本身就是媒体地址
      if (state.url) void api.player.play(state.url)
    }
    /*
     * rule 模式**不能**把 url 交给内核：那是**播放页 HTML 地址**，不是媒体地址
     * （内核会当成一个无法解码的媒体，表现为 time/length 恒为 0 的「已暂停」）。
     * 真实流由嗅探窗口捕获后再交给内核播放。
     * 实测（v0.2.6 自动连播自检）过去这里会把 …/play/1-2.html 当媒体播，导致切集后黑屏卡住。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineState, currentIndex, files.length, state.mode, state.url])

  // 内核事件 → 播放状态/进度/集数同步
  useEffect(() => {
    if (engineState !== 'active') return
    return api.player.onEvent((ev) => {
      switch (ev.type) {
        case 'cursor':
          // 主进程光标监听：画面是原生子窗口、会吞掉 mousemove，全屏时靠它唤出控制栏
          pokeRef.current?.()
          break
        case 'playing':
          playingRef.current = true
          setPlaying(true)
          /*
           * v0.2.8 修「已经在播放了却仍显示捕捉视频流中」：
           * 一旦内核真的开播，就把还在跑的那一轮嗅探**收掉**。
           * 什么时候会出现「边播边嗅探」：
           * - 命中会话直链缓存后播放，2.5 秒看门狗以为没开播、又起了一轮完整嗅探（慢 CDN 上常见）；
           * - 直连 15 秒未开播的补救重嗅探刚刚启动，媒体紧接着开播；
           * - 上一集/下一集按钮连点。
           * 收掉之后状态栏才会正确显示「播放中」，也顺带关掉多出来的嗅探窗口（省资源）。
           */
          if (probingRef.current) {
            probingRef.current = false
            setRuleProbing(false)
            probeCancelRef.current?.()
            probeCancelRef.current = null
          }
          /*
           * v0.3.5：真开播了，这才把「命中时留着」的网页视图关掉。
           * 留着它的意义见 startRuleProbe 里 pendingCloseWebviewRef 的说明 ——
           * 万一第一个候选是广告/失效地址，后面的真流请求还能被抓到并自动接管。
           */
          if (pendingCloseWebviewRef.current) {
            pendingCloseWebviewRef.current = false
            void api.ruleWebview.close()
          }
          /*
           * ★ 开播后重新校准画面区域（v0.3.7 修「换播放源后正在播放但没有画面」）★
           *
           * 画面是主窗口里的**原生子窗口**，它只认我们上报的那个矩形。
           * 从「详情页 → 播放源列表 → 再进播放器」这条路上，页面刚挂载时量到的
           * `#player-host` 有可能还在入场动画/布局未稳的状态（量早了一步），
           * 于是子窗口被摆到了错误的位置或尺寸上，声音照常、画面却看不到 ——
           * 用户看到的就是「正在播放但没有任何画面」。
           *
           * 所以真正开播后再补报几次矩形（300/1000/2200ms）：这时布局一定稳了，
           * 报一次就能把窗口摆正。补报是幂等的，对正常情况零副作用。
           */
          if (!layoutResyncRef.current) {
            layoutResyncRef.current = true
            for (const delay of [300, 1000, 2200]) {
              window.setTimeout(() => {
                const el = document.getElementById('player-host')
                const r = el?.getBoundingClientRect()
                if (r && r.width > 0 && r.height > 0) {
                  void api.player.notifyLayout({ x: r.left, y: r.top, width: r.width, height: r.height })
                }
              }, delay)
            }
          }
          // 本集真正开播了：这之后的时间/结束事件才算数
          awaitingStartRef.current = false
          /*
           * v0.3.9：把「内核已经在拉流」这一步写进过程进度。
           *
           * 注意这里**不**把「注入播放器」判成功 —— 用户要的是「等到真的有画面/首帧」，
           * 那个判据在主进程（mpv 的 width 属性 > 0，见 mpv.startTimePump）：
           * `playing` 只说明内核开始拉了，地址失效/CDN 慢的时候它一样会先变成 playing。
           */
          void api.player.flowMark({
            kind: 'detail',
            stage: 'inject',
            text: '内核已开始拉流，正在等待首帧画面…'
          })
          // 本轮已经真正开播过：此后不再显示「加载中」那一层（暂停不该被当成加载中）
          setStartedOnce(true)
          // 记录本集开播时刻：自动连播的进度兜底要求「已经播够久」，避免刚开播就被判定为播完
          playStartedAtRef.current = Date.now()
          recordWatch()
          // 记住「正在看第几集」，让剧集列表能高亮已看集数与最近进度
          if (state.mode === 'rule' && ruleCurrent) rememberEpisode(ruleCurrent.line, ruleCurrent.ep)
          else if (state.mode === 'local') rememberLocal(currentIndex)
          // 新媒体的比例设置会被内核重置，重新下发一次
          applyAspect(aspectRef.current)
          setTimeout(() => void refreshEngineSubs(), 300)
          break
        case 'paused':
          if (awaitingStartRef.current) break
          setPlaying(false)
          reportPosition(true)
          break
        case 'stopped':
          if (awaitingStartRef.current) break
          setPlaying(false)
          reportPosition(true)
          break
        case 'ended':
          /*
           * 本集播完：规则模式自动连下一集。
           * 注意「本集」二字：换集后内核可能仍在报上一集的 ended，
           * 那种事件必须丢掉，否则会出现「刚切过去就又被判定播完」的逐集快进（实测复现过）。
           */
          if (awaitingStartRef.current) break
          reportPosition(true)
          if (state.mode === 'rule') autoNext()
          break
        case 'time':
          // 本集开播前的时间上报来自上一集的媒体，必须忽略（否则进度/连播判定全被污染）
          if (awaitingStartRef.current) break
          if (typeof ev.time === 'number') {
            setCurrent(ev.time / 1000)
            if (typeof ev.length === 'number') setDuration(ev.length / 1000)
          }
          break
        case 'length':
          if (awaitingStartRef.current) break
          if (typeof ev.length === 'number') setDuration(ev.length / 1000)
          break
        /**
         * v0.2.18：音量变化（uosc 的竖排滑杆直接改 mpv 的 volume 属性，不经过应用 IPC）。
         * 不同步的话，鼠标拖过音量之后再按 ↑/↓ 会突然跳回拖之前的档位。
         */
        case 'volume':
          if (typeof ev.volume === 'number') setPlayerVolume(Math.round(ev.volume))
          break
        case 'playlistItem':
          if (typeof ev.index === 'number' && state.mode === 'local') {
            setCurrentIndex(ev.index)
            setVideoError(null)
          }
          break
        case 'error':
          if (state.mode === 'rule' && !ruleStreamRef.current) {
            // 规则模式播放出错且无流 → 回退 iframe（可正常退出）
            setRuleProbeFailed(true)
          } else {
            if (ev.message) setVideoError(`播放失败: ${ev.message}`)
          }
          break
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineState, state.mode, currentIndex, files.length])

  const stopCurrentLive = () => {
    if (live) {
      void api.media.stopLive(live.sessionId)
      setLive(null)
    }
  }

  /** 视频加载失败提示（区分错误码给出可操作建议） */
  const handleVideoError = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    const code = v.error?.code ?? -1
    // HEVC 复制流不被硬件支持时自动降级为视频转码（H.264）
    if (
      state.mode === 'local' &&
      currentFile &&
      live?.mode === 'vcopy' &&
      (code === 3 || code === 4) &&
      !fallbackTriedRef.current
    ) {
      fallbackTriedRef.current = true
      toast.info('当前视频编码无法直接解码，自动切换为转码播放…')
      void startTranscode(currentFile, 'vtranscode')
      return
    }
    const hints: Record<number, string> = {
      1: '加载被中止',
      2: '网络错误：无法访问文件（可能路径变化或文件被占用）',
      3: '解码失败：该视频的编码格式当前环境不支持',
      4: '格式不支持：该容器或编码格式无法播放'
    }
    setVideoError(hints[code] ?? `视频加载失败（错误码 ${code}）`)
    setPlaying(false)
  }

  /** 启动转码流会话 */
  const startTranscode = async (file: LocalVideoFile, mode: 'vcopy' | 'vtranscode', startSec = 0) => {
    stopCurrentLive()
    setPreparing(true)
    setVideoError(null)
    const r = await api.media.startLive(file.path, {
      mode,
      startSec,
      height: inspectInfo?.height ?? null,
      videoCodec: inspectInfo?.videoCodec ?? null
    })
    setPreparing(false)
    if (!r.ok) {
      setVideoError(r.error)
      return
    }
    const s = r.data
    setLive({ ...s, height: inspectInfo?.height ?? null })
    setSrc(s.url)
    fallbackTriedRef.current = false
  }

  /** 准备播放：探测编码，兼容直连 / 不兼容走 FFmpeg */
  const prepareFile = async (file: LocalVideoFile) => {
    stopCurrentLive()
    fallbackTriedRef.current = false
    setPreparing(true)
    setVideoError(null)
    setInspectInfo(null)
    const r = await api.media.inspect(file.path)
    if (!r.ok) {
      setPreparing(false)
      setVideoError(r.error)
      return
    }
    const info = r.data
    setInspectInfo(info)
    if (info.compatible || !info.hasFfmpeg) {
      // 兼容编码直接播放；未装 FFmpeg 时按兼容处理（失败会显示明确错误）
      setPreparing(false)
      setSrc(localVideoUrl(file.path))
      return
    }
    await startTranscode(file, 'vcopy')
  }

  // 本地模式：切换集数时（重新）准备播放源（仅在 HTML5 回退路径启用）
  useEffect(() => {
    if (state.mode !== 'local' || !currentFile || engineState !== 'fallback') return
    void prepareFile(currentFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFile?.path, state.mode, engineState])

  // 非本地模式：直接使用传入地址
  useEffect(() => {
    if (state.mode !== 'local') {
      setSrc(state.url ?? '')
      setLive(null)
      setPreparing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode])

  // 卸载时停止转码会话
  useEffect(() => {
    return () => {
      if (live) void api.media.stopLive(live.sessionId)
      if (seekTimerRef.current) window.clearTimeout(seekTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.sessionId])

  /**
   * 播放实例登记 + 离开时的内核处理（v0.2.6）。
   *
   * 切集是「重新挂载播放页」，React 会在同一次提交里卸载旧实例、挂载新实例：
   * 新实例 attach 好内核之后，旧实例的清理才跑 —— 若此刻直接 detach，会把新实例刚准备好的
   * 内核销毁，表现为「切集后抓到了流却一直黑屏/0 秒」。所以这里延迟 600ms 再判断，
   * 只有确实没有任何播放实例存活时才释放内核。
   */
  useEffect(() => {
    const handle = enterPlayer()
    return () => {
      handle.leave()
      whenPlayerGone(() => {
        void api.ruleWebview.close()
        void api.ruleProbe.stop()
        void api.player.detach()
        /*
         * v0.3.6 修（审计查出的高危遗留）：**FFmpeg 中转会话必须在这里停掉**。
         *
         * 以前只有 `exitPlayer()`（用户主动点退出/按 Esc）里才 `stopLive(relayRef…)`，
         * 而「切集」是**重新挂载播放页**（App.tsx 用 playKey 做 key），走的是这条卸载清理 ——
         * 于是：上一集如果已经切到了 FFmpeg 中转，新一集直接直连播放时，
         * **上一集的 ffmpeg.exe 会一直在后台拉流**，占带宽、占进程，
         * 一直到下一次 `startLiveUrl`（它会先杀旧会话）或应用退出才死。
         * 讽刺的是同文件 839 行的注释恰好写着「旧流继续拉流会和新一轮嗅探抢带宽」——
         * 说的是嗅探窗口，真正拉流的那个进程反倒没人管。
         *
         * 放在 `whenPlayerGone` 里（而不是直接放在清理函数里）：切集时新旧实例会在同一次提交里
         * 交替，新实例可能**已经**建好了自己的中转会话；只有在确认没有别的播放实例存活时才停，
         * 才不会把新实例刚建好的那个会话杀掉。
         */
        if (relayRef.current) {
          void api.media.stopLive(relayRef.current.sessionId)
          relayRef.current = null
        }
        // 带上 show 时拿到的代号：迟到的 hide 不会关掉新实例刚建好的控制栏（v0.2.8 附加）
        void api.overlay.hide(overlayGenRef.current ?? undefined)
        // 世代号判定：只要新实例已经进入过播放页，上面这些清理就不会执行
      }, handle.epoch)
    }
  }, [])

  /** 转码流拖动进度：防抖后重启 FFmpeg（从目标时间继续转码） */
  const seekLive = (t: number) => {
    if (!currentFile || !live) return
    if (seekTimerRef.current) window.clearTimeout(seekTimerRef.current)
    setPreparing(true)
    seekTimerRef.current = window.setTimeout(() => {
      void startTranscode(currentFile, live.mode, t)
    }, 700)
  }

  // 本地模式：扫描文件夹
  useEffect(() => {
    if (state.mode !== 'local' || !state.folder) return
    void (async () => {
      const r = await api.media.listVideos(state.folder!)
      setFilesLoading(false)
      if (r.ok) {
        setFiles(r.data)
        if (r.data.length === 0) toast.warn('该文件夹内没有找到视频文件')
        const idx = r.data.findIndex((f) => f.episode === state.episode)
        setCurrentIndex(idx >= 0 ? idx : 0)
      } else {
        toast.error(r.error)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 全屏状态同步
  useEffect(() => {
    void api.window.isFullscreen().then(setFullscreen)
    return api.window.onFullscreenChange(setFullscreen)
  }, [])

  /*
   * ⚠️ v0.3.6 删掉了这里原有的「离开播放页时确保退出全屏」。
   *
   * 它原来是为了「避免下次点击播放直接被全屏」—— 但那条理由在用户要求
   * 「主窗口全屏时进播放器也自然是全屏」之后就不成立了：窗口全屏是**主窗口**的状态，
   * 播放器只是借它显示；离开播放器就把用户的全屏踢掉，等于"我从全屏主页点进播放器再退回来，
   * 全屏没了"。这恰恰是用户这次报的 bug 之一（退出播放器后回不到原来那个全屏主窗口）。
   * 现在全屏完全跟随主窗口：进播放器时读它、退出时不动它。
   * 用户想退出全屏，用播放器里的全屏按钮或 Esc（Esc 在全屏时会先退全屏）即可。
   */

  const videoSrc = src

  // 切换视频时重置字幕为第一条（有字幕则自动开启）
  useEffect(() => {
    setSubIndex(currentSubs.length > 0 ? 0 : -1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFile?.path])

  // 应用字幕轨道开关
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const tracks = v.textTracks
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = i === subIndex ? 'showing' : 'disabled'
    }
  }, [subIndex, currentSubs.length, currentFile?.path])

  const cycleSubtitle = () => {
    if (currentSubs.length === 0) {
      toast.info('未找到该视频的字幕文件（支持 srt / ass / ssa / vtt）')
      return
    }
    const next = subIndex + 1 >= currentSubs.length ? -1 : subIndex + 1
    setSubIndex(next)
    if (next === -1) toast.info('字幕已关闭')
    else toast.info(`字幕：${currentSubs[next].label}（${currentSubs[next].name}）`)
  }

  // 控件自动隐藏（鼠标移动浮现，静止 5 秒隐藏；选集/详情抽屉保持打开，点击按钮再关闭）
  const poke = useCallback(() => {
    setVisible(true)
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      // 网页嗅探期间保持控制条可见（保证「退出播放」始终可点）
      if (probingRef.current) return
      setVisible(false)
    }, HIDE_DELAY)
  }, [])
  pokeRef.current = poke

  useEffect(() => {
    poke()
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    }
  }, [poke, currentIndex])

  // 全屏切换时短暂显示控件（全屏后移动鼠标同样会唤起）
  useEffect(() => {
    poke()
  }, [fullscreen, poke])

  // ---------- 画面比例（fit / cover / stretch） ----------
  const aspectRef = useRef<AspectMode>(aspect)
  useEffect(() => {
    aspectRef.current = aspect
  }, [aspect])
  /** 把比例模式下发给内核（区域尺寸用于内核的拉伸/裁剪几何） */
  const applyAspect = useCallback((mode: AspectMode): void => {
    const el = document.getElementById('player-host')
    const r = el?.getBoundingClientRect()
    void api.player.setAspect(mode, r?.width ?? window.innerWidth, r?.height ?? window.innerHeight)
  }, [])
  useEffect(() => {
    if (engineState !== 'active') return
    applyAspect(aspect)
  }, [aspect, engineState, fullscreen, showEpisodes, showInfo, applyAspect])
  const changeAspect = useCallback(
    (mode: AspectMode) => {
      setAspect(mode)
      saveSettings({ aspectMode: mode })
      applyAspect(mode)
      toast.info(`画面比例：${mode === 'fit' ? '适应（可能留黑边）' : mode === 'cover' ? '裁剪铺满' : '拉伸铺满'}`)
    },
    [applyAspect, saveSettings]
  )

  // ---------- 控制栏悬浮窗 ----------
  /**
   * 原生视频窗口永远盖在网页之上：页面里的控制栏、选集面板、详情面板都看不见。
   *
   * v0.2.4：不再只在全屏生效 —— 小窗口下同样交给悬浮窗，否则控制栏会把画面挤小。
   * v0.2.6：改为「只要用的是原生内核就一直接管」，因为选集与详情面板也搬进了悬浮窗：
   * 打开它们时画面不再需要让位（用户反馈「打开播放列表不该改动播放内容页面」），
   * 同时修掉「详情按钮点了没反应」——面板过去画在页面里，被原生视频窗口完全盖住了。
   */
  const overlayActive = engineState !== 'fallback'
  /**
   * v1.1.4：控制栏是否由 uosc（mpv 侧绘制）接管 —— **现在恒为"是"**。
   *
   * 为什么不再看 `settings.uoscControlBar`：
   *   v1.1.4 把旧的自绘控制栏整体剥离到 `playerLegacy/PlayerOverlayBar.tsx` 并且不再渲染
   *   （PlayerOverlayPage 里只剩一句说明）。如果这里还允许 false，结果就是
   *   「uosc 不画 + 旧栏不画」= 完全没有控制栏 —— 老用户设置里残留 false 时会直接踩中。
   *   设置项保留只是为了兼容旧 settings.json（见 shared/types.ts 的字段注释）。
   *
   * 仍然保留的两条判据：
   *   ① 内核必须是 libmpv（HTML5 回退路径里没有 mpv，也就没有 uosc）；
   *   ② uosc 本体没有明确报告「没挂上」（`uoscBarReady === false`）。
   *      这一条现在只用于日志/排障：旧栏不会再作为回退出现，
   *      所以 uosc 挂不上时应当在日志里看到 `uosc 加载失败`，而不是悄悄少一条控制栏。
   */
  const [uoscBarReady, setUoscBarReady] = useState<boolean | null>(null)
  /*
   * v1.1.4：**不再用 `uoscBarReady` 决定画不画状态**。
   * 旧栏已删，uosc 是唯一控制栏；即使状态查询偶尔晚一拍，也要把按钮状态推过去，
   * 否则 uosc 的按钮会停在占位态（没有图标/菜单内容）。`uoscBarReady` 只留给日志与排障。
   */
  const uoscBarMode = engineState === 'active'
  /** 最近一次 show 拿到的悬浮窗代号（hide 时带回去，防止迟到的 hide 关掉新窗口） */
  const overlayGenRef = useRef<number | null>(null)
  useEffect(() => {
    if (overlayActive) {
      void api.overlay.show().then((r) => {
        if (r.ok && r.data.ok) overlayGenRef.current = r.data.gen
      })
    } else {
      void api.overlay.hide(overlayGenRef.current ?? undefined)
    }
  }, [overlayActive])
  /**
   * 悬浮窗心跳（v0.2.8 附加三）。
   *
   * 切集是重新挂载播放页，期间悬浮窗可能被各种时序问题（旧实例的清理、主窗口失焦隐藏、
   * 迟到销毁）弄成隐藏或消失的状态 —— 用户看到的就是「切集后控制栏按钮失灵」。
   * 这里每 3 秒幂等地 show 一次（主进程侧会顺带把被隐藏的窗口重新显示），
   * 并把代号更新到 ref，任何一次自愈都不会被随后的迟到 hide 影响。
   */
  useEffect(() => {
    if (!overlayActive) return
    const t = window.setInterval(() => {
      void api.overlay.show().then((r) => {
        if (r.ok && r.data.ok) {
          const prev = overlayGenRef.current
          overlayGenRef.current = r.data.gen
          if (prev !== null && prev !== r.data.gen) {
            console.log(`[player] 悬浮窗自愈：代号 ${prev} → ${r.data.gen}`)
          }
        }
      })
    }, 3000)
    return () => window.clearInterval(t)
  }, [overlayActive])
  /*
   * 这里过去还有一句无条件的 `useEffect(() => () => api.overlay.hide(), [])`：
   * 切集时旧的播放页实例卸载会**无条件销毁**悬浮窗，而新实例的 show 可能已经先执行了 ——
   * 结果控制栏整个消失，点哪都没反应，只有 Esc（键盘）还能退出（用户反馈的「所有按键都失灵」）。
   * 现在统一由上面带代号的 show/hide 与 `whenPlayerGone` 保护的清理负责，不再单独挂一个。
   */

  /** 剧集前后切换（悬浮窗与快捷键共用） */
  const goPrevEpisode = useCallback((): void => {
    if (state.mode === 'rule') {
      if (ruleCurrent && ruleCurrent.ep > 0) void handleRuleEpisode(ruleCurrent.line, ruleCurrent.ep - 1)
    } else if (currentIndex > 0) {
      switchEpisode(currentIndex - 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode, ruleCurrent, currentIndex, handleRuleEpisode])
  const goNextEpisode = useCallback((): void => {
    if (state.mode === 'rule') {
      const total = state.groups?.[ruleCurrent?.line ?? 0]?.episodes.length ?? 0
      if (ruleCurrent && ruleCurrent.ep + 1 < total) void handleRuleEpisode(ruleCurrent.line, ruleCurrent.ep + 1)
    } else if (currentIndex < files.length - 1) {
      switchEpisode(currentIndex + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode, state.groups, ruleCurrent, currentIndex, files.length, handleRuleEpisode])

  /** 悬浮窗动作 → 与主界面控制栏完全相同的处理逻辑 */
  useEffect(() => {
    if (!overlayActive) return
    const off = api.overlay.onAction((a) => {
      switch (a.type) {
        case 'playPause':
          void api.player.togglePause()
          break
        case 'forward10': {
          const t = duration > 0 ? Math.min(duration, current + 10) : current + 10
          setCurrent(t)
          void api.player.seek(t)
          break
        }
        case 'back10': {
          const t = Math.max(0, current - 10)
          setCurrent(t)
          void api.player.seek(t)
          break
        }
        case 'volumeUp': {
          const nv = Math.min(200, playerVolume + 10)
          setPlayerVolume(nv)
          void api.player.setVolume(nv)
          break
        }
        case 'volumeDown': {
          const nv = Math.max(0, playerVolume - 10)
          setPlayerVolume(nv)
          void api.player.setVolume(nv)
          break
        }
        case 'setVolume': {
          // v0.2.9：控制栏音量滑杆（0-100）。拖动时高频触发，这里只改状态与音量，不做其它副作用。
          const nv = Math.max(0, Math.min(100, Math.round(a.value)))
          setPlayerVolume(nv)
          void api.player.setVolume(nv)
          break
        }
        case 'setSpeed': {
          // v0.2.9 最后更新：控制栏倍速菜单/按钮 → 内核 speed（变速不变调）
          applySpeed(a.value)
          break
        }
        case 'toggleMute': {
          const next = !playerMuted
          setPlayerMuted(next)
          void api.player.setMute(next)
          break
        }
        case 'seek':
          setCurrent(a.time)
          void api.player.seek(a.time)
          break
        case 'prevEpisode':
          goPrevEpisode()
          break
        case 'nextEpisode':
          goNextEpisode()
          break
        case 'cycleSubtitle':
          void cycleEngineSubtitle()
          break
        case 'setSubtitle': {
          const idx = engineSubs.findIndex((s) => s.id === a.id)
          if (idx >= 0) {
            setEngineSubIdx(idx)
            void api.player.setSubtitle(a.id)
            toast.info(`字幕：${engineSubs[idx].label}`)
          }
          break
        }
        case 'toggleEpisodes':
          setShowEpisodes((v) => !v)
          poke()
          break
        case 'toggleInfo':
          setShowInfo((v) => !v)
          if (!detail) void loadDetail()
          poke()
          break
        /*
         * v1.1.5：uosc 右上角角标「播放流详情」。
         * 只切已有的 showStreamInfo 状态 —— 面板、数据源、每秒轮询都在 StreamInfoModal 里，
         * 这里不另造 UI，保证和「状态药丸」打开的是同一个面板。
         */
        case 'toggleStreamInfo':
          setShowStreamInfo((v) => !v)
          poke()
          break
        /**
         * 选集浮层里点了某一集（v0.2.6：与规则页选集走同一套「重新挂载」逻辑）
         * v0.2.7 附加：本地播放时选集也走悬浮窗（见下面 setEpisodes 的分支），这里分流到本地切集。
         */
        case 'selectEpisode':
          if (state.mode === 'rule') void handleRuleEpisode(a.line, a.ep)
          else switchEpisode(a.ep)
          break
        /** 断点续播提示：撤销跳转 → 回到开头 */
        case 'undoResume':
          setCurrent(0)
          void api.player.seek(0)
          setResumeHint(null)
          toast.info('已回到本集开头')
          break
        case 'dismissResume':
          setResumeHint(null)
          break
        case 'snapshot':
          void api.player.snapshot(state.title, currentEpisodeNo()).then((r) => {
            if (r.ok) toast.success(`截图已保存: ${r.data}`)
            else toast.error(r.error)
          })
          break
        case 'setAspect':
          changeAspect(a.aspect)
          break
        /*
         * v0.2.5 修：小窗口下控制栏也由悬浮窗绘制，而悬浮窗的「全屏播放」按钮发的是
         * toggleFullscreen —— 这里过去没有对应分支，点了完全没反应（用户反馈「播放器全屏按钮没反应」）。
         */
        case 'toggleFullscreen':
          toggleFullscreen()
          break
        case 'exitFullscreen':
          void api.window.setFullscreen(false)
          break
        /** v0.2.8 弹幕：开关 / 逐项设置 / 打开详细设置 / 重新匹配 */
        case 'toggleDanmaku': {
          const next = !danmakuSettingsRef.current.enabled
          void updateDanmaku({ enabled: next })
          // v0.2.9：插件渲染时，把开关同步给插件自己（它有自己的弹幕开关状态）
          if (uoscActiveRef.current) void api.uosc.setVisible(next)
          if (next) toast.info('已打开弹幕')
          else toast.info('已关闭弹幕')
          break
        }
        case 'danmakuSetting':
          void updateDanmaku({ [a.key]: a.value } as Partial<DanmakuSettings>)
          // 时间轴微调对两种渲染方式都生效：同步告诉插件（它按「秒」处理延迟）
          if (uoscActiveRef.current && a.key === 'offsetMs') void api.uosc.delay(Number(a.value) || 0)
          break
        case 'openDanmakuSettings':
          // V1.1：数据源集合器 + 弹幕盒子检索 + 本地弹幕库都在这一页，窗口要比以前宽
          void api.window.openSmall('/danmaku-settings', { width: 900, height: 760, title: '弹幕设置' })
          break
        case 'openQualitySettings':
          // v0.3.3：uosc 的「画质」菜单里点了「完整画质设置…」→ 打开播放器设置页（Anime4K 卡片在最前面）
          void api.window.openSmall('/player-settings', { width: 700, height: 620, title: '播放器设置' })
          break
        case 'uoscMenu':
          // v0.2.9：打开插件自己的菜单（uosc 渲染）：搜索弹幕 / 总菜单 / 弹幕样式 / 源延迟
          void api.uosc.menu(String(a.key) as 'search' | 'total' | 'style' | 'delay' | 'add')
          break
        case 'reloadDanmaku':
          // V1.2：重新检测 = 绕过本地缓存真去各源要一遍（否则"重新检测"永远命中缓存，等于没点）
          void loadDanmaku(true, { force: true })
          break
        case 'danmakuReload':
          // uosc 菜单那一侧的动作名（与旧 reloadDanmaku 同一个行为）
          void loadDanmaku(true, { force: true })
          break
        case 'detectDanmakuAlias':
          void loadDanmaku(true, { aliasMode: true, force: true })
          break
        /*
         * V1.2：播放器内的弹幕动作（uosc 菜单通过 `script-message sakana-ctrl …` 发过来）。
         *
         * 为什么做成"动作"而不是继续放在旧控制栏的 popover 里：用户这轮要求控制栏完全交给
         * uosc、旧底栏默认不渲染；旧栏里的弹幕 popover 因此不可见。这里把动作语义固定下来，
         * uosc 那条线只要在菜单里挂入口即可，不需要再复制一套弹幕设置逻辑。
         *   · danmakuArea / danmakuFontSize / danmakuOffset：改显示参数（立即生效、持久化）；
         *   · danmakuReload：绕过缓存重新取；
         *   · danmakuAliasSearch：用用户输入的关键词当别名再搜一遍。
         */
        case 'danmakuArea': {
          const value = Math.min(1, Math.max(0.15, Number(a.value) || 1))
          void updateDanmaku({ area: value })
          break
        }
        case 'danmakuFontSize': {
          const value = Math.min(40, Math.max(12, Math.round(Number(a.value) || 22)))
          void updateDanmaku({ fontSize: value })
          break
        }
        case 'danmakuOffset': {
          const cur = danmakuSettingsRef.current.offsetMs
          const next = Math.min(10000, Math.max(-10000, cur + (Number(a.deltaMs) || 0)))
          void updateDanmaku({ offsetMs: next })
          // 时间轴微调对两种渲染方式都生效：同步告诉 mpv 插件（它按「秒」处理延迟）
          if (uoscActiveRef.current) void api.uosc.delay(next)
          toast.info(`弹幕时序 ${next / 1000 >= 0 ? '+' : ''}${(next / 1000).toFixed(1)}s`)
          break
        }
        case 'danmakuAliasSearch': {
          const kw = String(a.keyword ?? '').trim()
          if (!kw) {
            toast.warn('请输入别名/关键词后再搜索')
            break
          }
          toast.info(`正在用「${kw}」到各源搜索弹幕…`)
          void loadDanmaku(true, { keyword: kw, force: true })
          break
        }
        case 'exitPlayer':
          exitPlayer()
          break
        /**
         * v0.2.18：Esc（来自 uosc 控制栏的快捷键 / input.conf）。
         * 语义与键盘 Esc 完全一致：依次关闭 选集 → 详情 → 退出全屏 → 退出播放，
         * 避免「全屏时按 Esc 直接退出播放」这种意外。
         */
        case 'escape':
          if (showEpisodes) setShowEpisodes(false)
          else if (showInfo) setShowInfo(false)
          else if (fullscreen) toggleFullscreen()
          else exitPlayer()
          break
        /**
         * v0.3.8 投屏：面板在悬浮窗里，但"这一集是什么"只有播放页知道，
         * 所以开始投屏这个动作回到播放页来执行（媒体信息由它组装）。
         */
        case 'castPlay':
          void startCastTo(a.deviceId)
          break
        case 'castControl':
          if (castDeviceRef.current) void api.cast.control(castDeviceRef.current, a.action)
          break
        case 'castStop':
          if (castDeviceRef.current) {
            const id = castDeviceRef.current
            castDeviceRef.current = null
            setCastDeviceId(null)
            void api.cast.stop(id)
            toast.info('已停止投屏')
            // 投屏时本机是暂停的（把带宽让给电视），停止后恢复本机播放
            if (!playingRef.current) void api.player.togglePause()
          }
          break
        /**
         * v0.3.9 补充：详情面板（画在悬浮窗里）点了「重跑」。
         * 真正的链路在播放页，所以这里只是把意图接回来执行 —— 与 castPlay 同一个道理。
         */
        case 'retryStream':
          retryStream()
          break
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    overlayActive,
    duration,
    current,
    playerVolume,
    playerMuted,
    engineSubs,
    goPrevEpisode,
    goNextEpisode,
    changeAspect,
    state.title,
    poke,
    /*
     * v0.2.18：Esc 的「先关面板、再退全屏」这条链需要这三个状态，
     * 所以它们必须进依赖表（否则会捕获到旧闭包，Esc 会直接退出播放）。
     */
    showEpisodes,
    showInfo,
    fullscreen,
    /*
     * v0.2.7 附加：本地播放的选集走悬浮窗后，这里必须跟着文件列表长度重新注册，
     * 否则「暂停时列表才加载完」的情况下会捕获到 files 为空的旧闭包，点了没反应。
     */
    files.length
  ])

  /**
   * 内核实际状态轮询（v0.2.8 附加三）。
   *
   * 修「已经在播放了（有声音）却仍显示捕捉视频流中 / 已暂停」：
   * 内核的 `playing` 事件可能在渲染层订阅之前就发出了（快速开播的源、断点里继续播放这条路尤其常见），
   * 于是 React 里的 `playing` 一直是 false，状态栏就一直停在嗅探态。
   * 这里在「尚未开播」时每 800ms 问一次内核，**以内核的真实状态为准**纠正界面。
   */
  useEffect(() => {
    if (!overlayActive) return
    const timer = window.setInterval(() => {
      /*
       * v0.3.9：**无论开没开播**都顺手拉一次「播放过程进度」。
       *
       * 这就是过程进度显示器的实时数据来源，走的是这条**既有**的 800ms 轮询
       * （它本来就在「尚未开播」时每 800ms 问一次内核）——
       * 用户明确要求「复用现有播放状态详情的实时推送，别再开一条每帧轮询」，
       * 所以没有新增任何定时器，只是把同一次 tick 的另一个纯内存接口也读回来。
       * `api.player.flow()` 不联网、不读磁盘，代价可以忽略。
       */
      void api.player.flow().then((fr) => {
        if (fr.ok) setFlow(fr.data)
      })
      if (playingRef.current) return
      void api.player.getState().then((r) => {
        if (!r.ok) return
        const st = r.data
        if (!st.playing || (st.time <= 0 && st.length <= 0)) return
        console.log(`[player] 轮询确认内核已在播放（time=${Math.round(st.time)}s length=${Math.round(st.length)}s）`)
        playingRef.current = true
        awaitingStartRef.current = false
        if (!playStartedAtRef.current) playStartedAtRef.current = Date.now()
        setPlaying(true)
        setStartedOnce(true)
        setRuleProbeFailed(false)
        if (probingRef.current) {
          probingRef.current = false
          setRuleProbing(false)
          probeCancelRef.current?.()
          probeCancelRef.current = null
        }
        // 轮询这条路也要负责关掉「命中时留着」的网页视图（同 'playing' 事件里的处理）
        if (pendingCloseWebviewRef.current) {
          pendingCloseWebviewRef.current = false
          void api.ruleWebview.close()
        }
      })
    }, 800)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayActive])

  /** 状态下行到悬浮窗（控制栏只依赖这些字段） */
  useEffect(() => {
    if (!overlayActive) return
    const line = ruleCurrent?.line ?? 0
    const groups = state.groups ?? []
    const epName = groups[line]?.episodes?.[ruleCurrent?.ep ?? 0]?.name
    api.overlay.pushState({
      title: state.title,
      subtitle:
        state.mode === 'rule'
          ? `${epName ?? '规则播放'}${groups.length > 1 ? ` · 线路 ${line + 1}/${groups.length}` : ''}`
          : currentFile
            ? `${currentFile.episode != null ? `第 ${currentFile.episode} 集 · ` : ''}${currentFile.name}`
            : `${currentIndex + 1} / ${files.length}`,
      playing,
      current,
      duration,
      volume: playerVolume,
      muted: playerMuted,
      /** v0.2.9 最后更新：倍速（控制栏显示当前档位） */
      speed: playerSpeed,
      aspect,
      hasEpisodes: state.mode === 'rule' ? groups.length > 0 : files.length > 1,
      canPrev: state.mode === 'rule' ? !!ruleCurrent && ruleCurrent.ep > 0 : currentIndex > 0,
      canNext:
        state.mode === 'rule'
          ? !!ruleCurrent && ruleCurrent.ep + 1 < (groups[line]?.episodes.length ?? 0)
          : currentIndex < files.length - 1,
      subs: engineSubs,
      subIdx: engineSubIdx,
      fullscreen,
      status: playStatus,
      error: videoError ?? (ruleProbeFailed ? '未能捕获到视频流，请切换线路或退出' : null),
      // v0.2.6：选集/详情/续播提示都交给悬浮窗绘制（页面里的浮层会被原生视频窗口盖住）
      showEpisodes,
      showInfo,
      currentLine: line,
      currentEp: ruleCurrent?.ep ?? 0,
      subjectId: state.subjectId,
      resume: resumeHint ? { target: resumeHint.target } : null,
      // v0.2.8：弹幕要精确盖在画面之上（避开上下控制栏），所以把视频区域矩形一并推过去
      videoRect: (() => {
        const el = document.getElementById('player-host')
        const r = el?.getBoundingClientRect()
        if (r && r.width > 0 && r.height > 0) {
          return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
        }
        return { x: 0, y: 56, width: window.innerWidth, height: Math.max(120, window.innerHeight - 112) }
      })(),
      // v0.2.18：控制栏已交给 uosc 时，悬浮窗不再绘制自己的控件
      uoscBar: uoscBarMode,
      /*
       * v0.3.8：投屏面板要用到的"这一段媒体是什么"。
       *
       * 为什么放在这条高频推送里：悬浮窗的 `onState` 是**整体替换**语义（`setState`），
       * 只在低频通道里推的话会被这条每秒几次的推送覆盖掉。
       * 内容本身按"流地址 + 集数"缓存（castMediaRef），只有换集/换源时才重建，
       * 所以每一次推送传的都是同一个对象引用，代价可以忽略。
       */
      castMedia: castMediaPayload(),
      // v0.3.9：过程进度与自检说明跟着这条既有推送一起下去（悬浮窗画进度显示器要用）
      flow,
      selfCheckNote,
      startedOnce
    })
  }, [
    overlayActive,
    uoscBarMode,
    state.title,
    state.mode,
    state.groups,
    state.subjectId,
    ruleCurrent,
    currentFile,
    currentIndex,
    files.length,
    playing,
    current,
    duration,
    playerVolume,
    playerMuted,
    aspect,
    engineSubs,
    engineSubIdx,
    fullscreen,
    playStatus,
    videoError,
    ruleProbeFailed,
    showEpisodes,
    showInfo,
    resumeHint,
    // v0.3.9：过程进度与自检说明也在这次推送里，必须进依赖表，否则悬浮窗看不到它们变化
    flow,
    selfCheckNote,
    startedOnce
  ])

  /**
   * 选集数据单独推送（低频）：不跟着每秒多次的进度推送走，避免无谓的大数组传输。
   *
   * v0.2.7 修「选集按钮点了没反应」：悬浮窗是**异步创建**的，而这里原先只在挂载时推一次，
   * 推送很可能早于悬浮窗就绪 → 悬浮窗拿不到选集数据 → 点按钮后浮层渲染为空，看起来像没响应。
   * 现在首推之后加两次延时补推，并跟着浮层开合再推一次。
   *
   * v0.2.7 附加：本地播放（本地文件 / 本地文件夹）也要推 ——
   * 画面由原生窗口绘制后，选集浮层只有悬浮窗这一份（页面里那份已经不再显示），
   * 不推的话本地播放点「选集」只会一直停在「正在读取选集…」。
   */
  useEffect(() => {
    if (!overlayActive) return
    const push = (): void => {
      if (state.mode === 'rule') {
        const groups = state.groups ?? []
        api.overlay.setEpisodes({
          lines: groups.map((g, i) => ({
            name: g.lineName ?? `线路 ${i + 1}`,
            episodes: g.episodes.map((e, j) => e.name || `第 ${j + 1} 集`)
          })),
          currentLine: ruleCurrent?.line ?? 0,
          currentEp: ruleCurrent?.ep ?? 0
        })
        return
      }
      // 本地播放：文件列表当成单条线路，高亮当前文件
      if (files.length === 0) return
      api.overlay.setEpisodes({
        lines: [{ name: '本地文件', episodes: files.map((f, i) => f.episode != null ? `第 ${f.episode} 集` : (f.name || `第 ${i + 1} 个`)) }],
        currentLine: 0,
        currentEp: currentIndex
      })
    }
    push()
    const t1 = window.setTimeout(push, 1200)
    const t2 = window.setTimeout(push, 3500)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [overlayActive, state.mode, state.groups, ruleCurrent, showEpisodes, files, currentIndex])

  // 播放历史记录（方案 3.2 历史 + 继续观看）
  const recordWatch = useCallback(() => {
    const key = `${state.mode}:${state.subjectId ?? ''}:${currentFile?.episode ?? state.url ?? ''}`
    if (recordedRef.current === key) return
    recordedRef.current = key
    addWatch({
      subjectId: state.subjectId,
      title: state.title,
      episode: state.mode === 'local' ? (currentFile?.episode ?? null) : null,
      source: state.mode === 'local' ? 'local' : 'online',
      watchedAt: Date.now(),
      hour: new Date().getHours(),
      durationSec: Math.floor(duration || 0)
    })
  }, [addWatch, state, currentFile, duration])

  const loadDetail = async () => {
    if (!state.subjectId) return
    setShowInfo((v) => !v)
    if (!detail && !detailLoading) {
      setDetailLoading(true)
      const r = await api.bangumi.subject(state.subjectId)
      setDetailLoading(false)
      if (r.ok && r.data.data) setDetail(r.data.data)
    }
  }

  /**
   * 全屏切换（v0.3.6 修）。
   *
   * 老实现只有一句 `void api.window.setFullscreen(!fullscreen)`，完全依赖主进程回发
   * `onFullscreenChange` 事件来更新这里的 `fullscreen` 状态。但 `setFullScreen()` 是
   * **异步**生效的，且窗口已经处于目标状态（或窗口未显示）时 Electron **不发**那对事件 ——
   * 于是状态永远停在旧值：按钮图标不变、退出时不会调 setFullscreen(false)、
   * 界面卡在「以为全屏」的布局里（用户报的「退出时播放器卡白、退不出去」）。
   *
   * 现在主进程的 `setFullscreen` 直接返回**切换后的实际状态**，这里立刻用上，
   * 不再把状态同步押在事件上（事件仍然保留，用于用户用系统方式全屏/退出全屏的情形）。
   */
  const toggleFullscreen = () => {
    const target = !fullscreen
    void api.window.setFullscreen(target).then((now) => {
      if (typeof now === 'boolean') setFullscreen(now)
    })
  }

  // ---------------- 弹幕（v0.2.8） ----------------

  /** 保存弹幕设置（写进 settings.danmaku，播放器悬浮窗与设置页共用同一份） */
  const updateDanmaku = async (patch: Partial<DanmakuSettings>): Promise<void> => {
    const next = { ...danmakuSettingsRef.current, ...patch }
    danmakuSettingsRef.current = next
    await saveSettings({ danmaku: next })
  }

  /**
   * 番剧库里的别名（用于「别名检测弹幕」）。
   *
   * 数据来自番剧详情的 infobox「别名」与中/日文名，按 、/ 分隔拆开；
   * 只在第一次用时拉一次（详情本身有 30 天缓存，代价很低）。
   */
  const danmakuAliasRef = useRef<string[] | null>(null)
  const danmakuAliases = async (): Promise<string[]> => {
    if (danmakuAliasRef.current) return danmakuAliasRef.current
    const out: string[] = []
    const push = (s: unknown): void => {
      for (const part of String(s ?? '').split(/[、,，/|]/)) {
        const t = part.trim()
        if (t && t !== state.title && !out.includes(t)) out.push(t)
      }
    }
    if (state.subjectId != null) {
      const r = await api.bangumi.subject(state.subjectId)
      const d = r.ok ? r.data.data : null
      if (d) {
        push(d.name)
        push(d.name_cn)
        for (const row of d.infobox ?? []) {
          if (/别名|別名|中文名|日文名/.test(row.key)) push(row.value)
        }
      }
    } else if (state.title) {
      /*
       * V1.1.2：没有 subjectId 时**按标题反查一次**，把日文原名/中文名补成别名。
       *
       * 为什么必须补：从订阅、历史、搜索结果直接进播放器时拿不到条目 id，
       * 于是别名是空的，只剩一个中文标题 —— 而巴哈姆特只认**日文名/繁体名**，
       * 结果是"设置里测试能搜到，播放时却没有源弹幕"（用户报的就是这个）。
       * 反查失败不影响播放，只是回到原来的行为。
       */
      const s = await api.bangumi.search(state.title)
      const hit = s.ok ? s.data.items?.[0] : null
      if (hit) {
        push(hit.name)
        push(hit.name_cn)
        console.log(`[player] 按标题反查到条目，用它补别名：${[hit.name, hit.name_cn].filter(Boolean).join(' / ')}`)
      }
    }
    danmakuAliasRef.current = out.slice(0, 6)
    if (out.length > 0) console.log(`[player] 别名候选（${out.length}）：${out.slice(0, 4).join(' / ')}`)
    return danmakuAliasRef.current
  }

  /**
   * V1.2：**进播放器就预加载弹幕**（不等内核起来）。
   *
   * 为什么提前：用户要求「进播放器就预加载」，而内核挂载/首帧通常要 1~3 秒；
   * 等 `engineState === 'active'` 再发请求，等于把弹幕链路的起点推迟到视频已经播起来之后。
   * 这里在标题/集数一确定就发起预取（与正式加载共用同一套单飞与缓存，不会重复请求），
   * 正式加载时通常已经命中缓存或正在跑。
   */
  useEffect(() => {
    if (!state.title) return
    const ep =
      state.mode === 'rule' ? (ruleCurrent?.ep ?? -1) + 1 : (currentFile?.episode ?? currentIndex + 1)
    if (!ep || ep < 1) return
    let alive = true
    void (async () => {
      const aliases = await danmakuAliases()
      if (!alive) return
      const r = await api.danmaku.prefetch(state.title, ep, { aliases, subjectId: state.subjectId })
      if (r.ok) console.log(`[player] 弹幕预取完成：${r.data.count} 条（缓存=${r.data.cached}）`)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.title, state.mode, state.subjectId, ruleCurrent?.ep, currentIndex])

  /**
   * 拉取当前这一集的弹幕。
   *
   * - 规则播放：番剧名用 `state.title`，集数用当前线路里的集序号（从 1 开始）；
   * - 本地播放：番剧名用标题（通常是文件夹名），集数优先用文件名里解析出的集数；
   * 匹配不到就显示「未找到弹幕」，不影响播放。
   *
   * `opts.aliasMode`（悬浮窗里的「别名检测弹幕」）：把番剧库的别名（原名 / 其它译名）
   * 与弹幕库自己的别名一起当搜索关键词 —— 番剧名与弹幕库标题对不上时靠它救回来。
   */
  /**
   * 当前播放的是第几集（v0.2.9：截图命名要用它）。
   * 规则模式下 `ruleCurrent.ep` 从 0 开始，本地模式优先用文件名解析出的集数，
   * 解析不出才退回播放列表序号 —— 与弹幕匹配用的是同一套口径，避免两处算出来不一样。
   */
  const currentEpisodeNo = (): number =>
    state.mode === 'rule' ? (ruleCurrent?.ep ?? 0) + 1 : (currentFile?.episode ?? currentIndex + 1)

  // ---------------- 投屏（v0.3.8） ----------------

  /** 正在投屏的设备 id；为空表示没在投屏 */
  const castDeviceRef = useRef<string | null>(null)
  /**
   * 同一个设备 id 的**响应式**副本（v1.1.4）。
   *
   * 为什么不能只留 ref：`sakana-status`（播放状态菜单）要显示"投屏状态"，
   * 而状态下行只在 React 重新渲染时才会推。ref 改了不会触发渲染 ——
   * 菜单就会一直显示"未投屏"，直到下一集。所以 ref 仍用于动作回调里的同步判断，
   * 这个 state 专门用于把投屏状态带进 uosc 状态载荷。
   */
  const [castDeviceId, setCastDeviceId] = useState<string | null>(null)

  /**
   * 投屏要用的这一段媒体（按「模式 + 番剧 + 流地址 + 线路 + 集」缓存）。
   *
   * 为什么缓存：这份数据要跟着每秒几次的状态推送进悬浮窗（那边是整体替换语义），
   * 每帧重新构造一个几十项的播放列表纯属浪费；只有换集/换源时才真的变。
   *
   * 本地播放没有可投的在线地址（`url` 为空），界面据此提示改用接收端自己打开文件。
   */
  const castMediaCacheRef = useRef<{ key: string; payload: OverlayState['castMedia'] } | null>(null)
  /*
   * V1.1：电脑上的「数据源」清单（= 已启用的规则），随投屏一起交给接收端，
   * 手机/电视上才有得选、切回来的事才有得做（契约见 android-receiver/README.md §2.5c）。
   *
   * 为什么缓存在 ref 而不是每次现取：`castMediaPayload()` 在渲染期被**同步**调用
   * （悬浮窗状态每 800ms 整体推一次），那里不能 await。这份清单只在改规则时变，
   * 真正要投屏前（`startCastTo`）再刷一次就足够新。
   */
  const castSourcesRef = useRef<{ id: string; name: string }[]>([])
  const refreshCastSources = async (): Promise<void> => {
    const r = await api.store.get('rules')
    if (!r.ok || !Array.isArray(r.data)) return
    const next = (r.data as PlayRule[]).filter((x) => x.enabled).map((x) => ({ id: x.id, name: x.name }))
    const prev = castSourcesRef.current
    // 只有清单真的变了才让投屏缓存失效：否则每次投屏都会白重建一遍播放列表
    if (prev.length === next.length && prev.every((s, i) => s.id === next[i].id && s.name === next[i].name)) return
    castSourcesRef.current = next
    castMediaCacheRef.current = null
  }
  const castMediaPayload = (): OverlayState['castMedia'] => {
    const url =
      state.mode === 'rule' ? (ruleStreamRef.current ?? '') : state.mode === 'online' ? (state.url ?? '') : ''
    const line = ruleCurrent?.line ?? 0
    const ep = ruleCurrent?.ep ?? currentIndex
    // 缓存键要带上"哪一部 + 哪条数据源"：换源/换条目后直链可能一样，但契约字段必须跟着变
    const key = `${state.mode}|${state.title}|${url}|${line}|${ep}|${files.length}|${state.subjectId ?? ''}|${state.ruleId ?? ''}`
    if (castMediaCacheRef.current?.key === key) return castMediaCacheRef.current.payload
    const groups = state.groups ?? []
    const playlist =
      state.mode === 'rule'
        ? (groups[line]?.episodes ?? []).map((e, i) => ({ url: '', title: e.name || `第 ${i + 1} 集` }))
        : files.map((f, i) => ({ url: f.path, title: f.name || `第 ${i + 1} 集` }))
    const payload: OverlayState['castMedia'] = url
      ? {
          url,
          title: `${state.title}${ep >= 0 ? ` · 第 ${ep + 1} 集` : ''}`,
          referer: state.referer,
          index: ep,
          /*
           * V1.1 投屏契约三项：给接收端"这是哪一部 / 还有哪些数据源 / 现在用哪条"。
           * 缺了它们，接收端上的选集、连播、换数据源都只能是摆设（它只有一个直链，
           * 既不知道条目 id 也没有别的线路可解析）。本地播放没有在线地址，走不到这里。
           */
          subjectId: state.subjectId,
          sources: castSourcesRef.current,
          sourceId: state.mode === 'rule' ? state.ruleId : undefined,
          /*
           * 播放列表只带**标题**、不带地址：规则模式下每集的直链都要重新"解析播放页 + 嗅探"才能拿到，
           * 现在没有现成的地址可给。所以接收端/电视上的"选集"列表是只读的展示，
           * 真正的选集以电脑这边为准（换集时播放页会自动把新的一集推给同一台设备，见 onFound 里的注释）。
           */
          playlist
        }
      : null
    castMediaCacheRef.current = { key, payload }
    return payload
  }

  /**
   * 开始投屏：把当前这一集（含进度与选集列表）交给选中的设备。
   *
   * 投屏成功后**暂停本机播放**：同一路流在两个地方同时拉会互相抢带宽，
   * 而用户真正在看的是电视 —— 把带宽让给它，这也是「投屏要流畅」的一部分。
   */
  const startCastTo = async (deviceId: string): Promise<void> => {
    // 先把数据源清单刷成最新的，再构造载荷（顺序不能反，见 refreshCastSources 的注释）
    await refreshCastSources().catch(() => undefined)
    const media = castMediaPayload()
    if (!media) {
      toast.warn('本地文件没有可投的在线地址：请在接收端直接打开这个文件')
      return
    }
    const r = await api.cast.play(deviceId, { ...media, startMs: Math.round(current * 1000) })
    if (!r.ok) {
      toast.error(`投屏失败：${r.error}`)
      return
    }
    if (!r.data.ok) {
      toast.error(`投屏失败：${r.data.message}`)
      return
    }
    castDeviceRef.current = deviceId
    setCastDeviceId(deviceId)
    toast.success(r.data.message)
    if (playingRef.current) void api.player.togglePause()
  }

  /**
   * 两段式加载的第二段：把「已启用的数据源」那批弹幕合并到画面上（V1.1.2）。
   *
   * 为什么单独一段：用户既要「数据源必须被调用」，又要「别拖慢」。第一段（内置/本地库）
   * 几百毫秒上屏，主进程同时已经在跑数据源那一路；这里把它取回来做**去重合并**，
   * 合并进已有的那批而不是替换 —— 内置那批不能因为源回来了就消失。
   */
  const mergeSourceDanmaku = async (
    key: string,
    episode: number,
    aliases: string[],
    extra: { keyword?: string; force?: boolean } = {}
  ): Promise<void> => {
    try {
      const r = await api.danmaku.load(state.title, episode, {
        aliases,
        sourcesOnly: true,
        trigger: 'play',
        keyword: extra.keyword,
        subjectId: state.subjectId,
        force: extra.force
      })
      // 期间换集/换源了 → 这批结果属于上一集，丢掉
      if (danmakuKeyRef.current !== key) return
      if (!r.ok || !r.data || r.data.count === 0) {
        console.log('[player] 数据源没有可用弹幕（获取记录里能看到每次尝试的结果）')
        return
      }
      const add = r.data
      const who = add.sources?.length
        ? add.sources.map((s) => `${s.sourceName} ${s.count}${s.fromCache ? '·缓存' : ''}`).join(' ＋ ')
        : `${add.origin?.sourceName ?? '数据源'} ${add.count} 条`
      setDanmaku((prev) => ({
        comments: mergeCommentsLocal(
          prev.comments,
          add.comments,
          danmakuSettingsRef.current.errorToleranceMs ?? 100
        ),
        source: `${prev.source} ＋ ${who}`,
        loading: false
      }))
      console.log(`[player] 数据源弹幕已合并：${who}（新增 ${add.count} 条，去重后并入画面）`)
    } catch (err) {
      console.warn(`[player] 合并数据源弹幕失败：${String((err as Error)?.message ?? err)}`)
    }
  }

  const loadDanmaku = async (
    force = false,
    opts: { aliasMode?: boolean; keyword?: string; force?: boolean } = {}
  ): Promise<void> => {
    const episode =
      state.mode === 'rule'
        ? (ruleCurrent?.ep ?? 0) + 1
        : (currentFile?.episode ?? currentIndex + 1)
    const hard = force || opts.force === true
    const baseKey = `${state.mode}:${state.title}:${episode}`
    const key = `${baseKey}:${opts.aliasMode ? 'alias' : 'plain'}:${opts.keyword ?? ''}`
    if (!hard && danmakuKeyRef.current === key) return
    /** 同一集内的「重新检测 / 别名检测」：保留现有弹幕，别让画面上的弹幕先消失 */
    const sameEpisode = danmakuBaseKeyRef.current === baseKey
    danmakuKeyRef.current = key
    danmakuBaseKeyRef.current = baseKey
    setDanmaku((prev) => ({
      comments: sameEpisode ? prev.comments : [],
      source: sameEpisode ? prev.source : '',
      loading: true
    }))
    if (opts.aliasMode) {
      toast.info('正在用别名检测弹幕…')
      console.log('[player] 弹幕：收到别名检测请求')
    }
    const aliases = await danmakuAliases()
    try {
      const r = await api.danmaku.load(state.title, episode, {
        aliases,
        aliasMode: opts.aliasMode,
        keyword: opts.keyword,
        subjectId: state.subjectId,
        force: hard
      })
      if (danmakuKeyRef.current !== key) return // 期间又换集了
      if (r.ok && r.data) {
        const by = r.data.aliasUsed ? `（别名「${r.data.matchedBy}」命中）` : ''
        /*
         * v1.1：把「这条弹幕从哪来」写进来源串 —— 用户装了多个数据源之后，
         * 最需要一眼看出的就是"这份弹幕是内置库还是巴哈/弹幕盒子给的"，
         * 否则数量对不上时无从判断。来源串显示在播放器状态区与悬浮窗的来源行。
         * V1.2：多源合并后单个 origin 会丢掉"另一半从哪来"，所以把每个源的条数也带上。
         */
        const from = r.data.sources?.length
          ? `〔${r.data.sources.map((s) => `${s.sourceName} ${s.count}${s.fromCache ? '·缓存' : ''}`).join(' ＋ ')}〕`
          : r.data.origin
            ? `〔来自 ${r.data.origin.sourceName}〕`
            : ''
        setDanmaku({
          comments: r.data.comments,
          source: `${r.data.animeTitle} · ${r.data.episodeTitle}${by}${from}`,
          loading: false
        })
        console.log(
          `[player] 弹幕已加载：${r.data.episodeTitle} 共 ${r.data.count} 条（缓存=${r.data.fromCache}）${by}` +
            (r.data.sources?.length
              ? ` 来源=${r.data.sources.map((s) => `${s.sourceName}:${s.count}${s.fromCache ? '(缓存)' : ''}`).join(' + ')}`
              : '')
        )
        /*
         * v1.1.2 两段式加载的第二段：数据源那批弹幕。
         *
         * 第一段（上面这次调用）拿到的是本地库/内置那批，几百毫秒就上屏了；
         * 主进程在返回它的同时**已经**把"已启用的数据源"那一路发起（所以"播放前必须调用数据源"
         * 是结构上的保证，不取决于这里）。这里只是去把已经在跑的结果取回来合并。
         * 用户报的正是"设置里能搜到、播放时却没有源弹幕"，根因就是以前压根没这一步。
         */
        if (r.data.sourcesPending)
          void mergeSourceDanmaku(key, episode, aliases, { keyword: opts.keyword, force: hard })
        /*
         * v0.2.9：插件渲染时，确认插件**真的**把这批弹幕挂上了。
         * 判据是插件自己暴露的 `user-data/uosc_danmaku/has-danmaku`（v2.1.0 没有条数属性）。
         *
         * 分两轮看：注入必须等 mpv 载入文件（否则插件会崩、脚本被终止），
         * 所以第一轮看到 pending=true 时不能急着回落，再等一轮；两轮都没挂上才回落到内置画布 ——
         * 用户要的是「看到弹幕」，不是「必须由插件画」。
         */
        if (uoscActiveRef.current) {
          const checkKey = key
          const check = (round: number): void => {
            window.setTimeout(() => {
              void (async () => {
                if (danmakuKeyRef.current !== checkKey) return
                const s = await api.uosc.status()
                if (!s.ok || !s.data.active) return
                if (s.data.loaded) {
                  console.log('[player] uosc_danmaku 已挂上弹幕（has-danmaku=true）')
                  return
                }
                if (s.data.pending && round < 2) {
                  console.log('[player] uosc_danmaku 弹幕还在等文件就绪，稍后再确认')
                  check(round + 1)
                  return
                }
                console.warn('[player] uosc_danmaku 未挂上弹幕，回落到内置画布渲染')
                setUoscActive(false)
              })()
            }, 4500)
          }
          check(0)
        }
        if (opts.aliasMode) toast.success(`别名检测成功：${r.data.episodeTitle} 共 ${r.data.count} 条`)
      } else {
        // 失败也保留原弹幕（同一集重载时先前那一份仍然可用）
        setDanmaku((prev) => ({ comments: sameEpisode ? prev.comments : [], source: prev.source, loading: false }))
        console.log(`[player] 未找到弹幕（${state.title} 第 ${episode} 集，别名模式=${!!opts.aliasMode}）`)
        if (opts.aliasMode) toast.warn('别名检测后仍未找到弹幕')
      }
    } catch (err) {
      if (danmakuKeyRef.current === key) {
        setDanmaku((prev) => ({ comments: sameEpisode ? prev.comments : [], source: prev.source, loading: false }))
      }
      console.warn('[player] 弹幕加载失败:', String(err))
    }
  }

  /** 弹幕数据 / 设置推送到悬浮窗（低频：换集、改设置、开关时各一次） */
  useEffect(() => {
    if (!overlayActive) return
    const push = (): void => {
      api.overlay.setDanmaku({
        comments: danmaku.comments,
        settings: danmakuSettings,
        source: danmaku.source,
        loading: danmaku.loading,
        // v0.2.9：插件渲染时内置画布让位，避免两套弹幕叠加
        pluginActive: uoscActive
      })
    }
    push()
    // 悬浮窗是异步创建的：和选集一样补推两次，避免首推早于窗口就绪
    const t1 = window.setTimeout(push, 1200)
    const t2 = window.setTimeout(push, 3500)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayActive, danmaku, danmakuSettings.enabled, danmakuSettings.area, danmakuSettings.maxCount, danmakuSettings.offsetMs, uoscActive])

  /**
   * v0.2.18：uosc 控制栏状态下行（按钮的图标/激活态/角标 + 各菜单的内容）。
   *
   * 为什么不复用上面那条 pushState：那条每次播放进度变化（每秒多次）都会推，
   * 而这份状态里的字段都是**低频**的（选集列表可能几十项，不能每秒推）。
   * 主进程还会按内容去重，所以这里「依赖变了就推」是安全的。
   *
   * 反方向的动作（点按钮/菜单项/快捷键）由主进程转成 OverlayAction 派发回来，
   * 走的是同一条 overlayAction 通道 —— 也就是说按钮与旧控制栏的行为是同一套代码。
   */
  useEffect(() => {
    if (!uoscBarMode) return
    const groups = state.groups ?? []
    const line = ruleCurrent?.line ?? 0
    const lines =
      state.mode === 'rule'
        ? groups.map((g, i) => ({
            name: g.lineName ?? `线路 ${i + 1}`,
            episodes: g.episodes.map((e, j) => e.name || `第 ${j + 1} 集`)
          }))
        : files.length > 0
          ? [
              {
                name: '本地文件',
                episodes: files.map((f, i) =>
                  f.episode != null ? `第 ${f.episode} 集` : f.name || `第 ${i + 1} 个`
                )
              }
            ]
          : []
    void api.uosc.bar({
      title: state.title,
      subtitle:
        state.mode === 'rule'
          ? `${groups[line]?.episodes?.[ruleCurrent?.ep ?? 0]?.name ?? '规则播放'}${
              groups.length > 1 ? ` · 线路 ${line + 1}/${groups.length}` : ''
            }`
          : currentFile
            ? `${currentFile.episode != null ? `第 ${currentFile.episode} 集 · ` : ''}${currentFile.name}`
            : `${currentIndex + 1} / ${files.length}`,
      playing,
      speed: playerSpeed,
      aspect,
      fullscreen,
      canPrev: state.mode === 'rule' ? !!ruleCurrent && ruleCurrent.ep > 0 : currentIndex > 0,
      canNext:
        state.mode === 'rule'
          ? !!ruleCurrent && ruleCurrent.ep + 1 < (groups[line]?.episodes.length ?? 0)
          : currentIndex < files.length - 1,
      lines,
      currentLine: state.mode === 'rule' ? line : 0,
      currentEp: state.mode === 'rule' ? (ruleCurrent?.ep ?? 0) : currentIndex,
      subs: engineSubs,
      subId: engineSubIdx >= 0 ? (engineSubs[engineSubIdx]?.id ?? -1) : -1,
      danmaku: {
        enabled: danmakuSettings.enabled,
        count: danmaku.comments.length,
        area: danmakuSettings.area,
        maxCount: danmakuSettings.maxCount,
        fontSize: danmakuSettings.fontSize,
        offsetMs: danmakuSettings.offsetMs,
        showScroll: danmakuSettings.showScroll,
        showTop: danmakuSettings.showTop,
        showBottom: danmakuSettings.showBottom,
        pluginActive: uoscActive,
        source: danmaku.source
      },
      status: playStatus,
      /*
       * v1.1.4：投屏状态（`sakana-status` 菜单要显示它）。
       * 只有设备 id：渲染层在投屏面板里才知道设备名，而"是否在投"只看 id 就够了；
       * 菜单里显示「投屏中（设备 xxxxxxxx…）」——显示 id 前缀，不编造名字。
       */
      cast: { active: castDeviceId !== null, deviceId: castDeviceId ?? undefined }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    uoscBarMode,
    state.title,
    state.mode,
    state.groups,
    ruleCurrent,
    currentFile,
    currentIndex,
    files,
    playing,
    playerSpeed,
    aspect,
    fullscreen,
    engineSubs,
    engineSubIdx,
    danmaku,
    danmakuSettings.enabled,
    danmakuSettings.area,
    danmakuSettings.maxCount,
    danmakuSettings.offsetMs,
    danmakuSettings.showScroll,
    danmakuSettings.showTop,
    danmakuSettings.showBottom,
    uoscActive,
    playStatus,
    castDeviceId
  ])

  /** 换集（或首次进入）时自动拉弹幕：规则模式按当前集数，本地模式按文件集数 */
  useEffect(() => {
    if (engineState !== 'active') return
    void loadDanmaku()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineState, ruleCurrent?.line, ruleCurrent?.ep, currentIndex, state.mode])

  /**
   * v0.2.9：mpv 弹幕插件（uosc_danmaku）状态。
   * 引擎就绪后再查（插件是随 mpv 实例一起挂载的），拿到 active 后：
   * - 内置画布让位；
   * - 设置里的时间轴微调同步给插件；
   * - 顺便清一次来源，避免上一集残留。
   */
  useEffect(() => {
    if (engineState !== 'active') return
    let alive = true
    const sync = async (): Promise<void> => {
      const r = await api.uosc.status()
      if (!alive || !r.ok) return
      setUoscActive(r.data.active)
      // v0.2.18：uosc 本体（控制栏）有没有挂上 —— 没挂上就回落到旧控制栏，不能让人没有控制栏可用
      setUoscBarReady(r.data.bar)
      if (r.data.active) {
        console.log(`[player] 弹幕由 uosc_danmaku 插件渲染（已显示=${r.data.loaded}）`)
        void api.uosc.delay(danmakuSettingsRef.current.offsetMs)
        // 开关状态与内置开关保持一致（插件自己记状态，显式设一次避免两边不一致）
        void api.uosc.setVisible(danmakuSettingsRef.current.enabled)
      } else if (r.data.requested) {
        console.warn('[player] 已选择插件渲染，但插件未挂上（回落到内置画布）')
      }
    }
    void sync()
    // 插件是异步挂载的，补查两次
    const t1 = window.setTimeout(() => void sync(), 2500)
    return () => {
      alive = false
      window.clearTimeout(t1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineState])

  /**
   * 退出播放器（v0.3.6 重排了这里的清理顺序）。
   *
   * ## 用户报的现象
   * 「全屏主窗口进入播放器时，退出播放会卡在播放内容空白、控制栏不消失，没有返回主窗口」。
   *
   * ## 三个真因（都在"顺序"上，不在"有没有清理"上）
   *
   * ① **控制栏悬浮窗要等到 `whenPlayerGone`（600ms 后）才隐藏**。
   *    那 600ms 里主窗口已经切回主页了，而覆盖整窗的透明控制栏还浮在上面 ——
   *    用户看到的就是「控制栏不消失、也回不到主窗口」（其实主页已经在下面了，只是被盖着）。
   *    现在**退出时立刻 hide**，不等 600ms。
   *
   * ② **退出全屏被延后 150ms**，而 `navigate` 是同步的。于是窗口先画主页、
   *    再退出全屏，中间那一帧是「全屏尺寸的主页」→ 原生视频子窗口也是全屏大小，
   *    看起来就是一块空白。现在**先退出全屏、再导航**（同步做完，不留这一帧）。
   *
   * ③ **视频子窗口在窗口缩小后没有立刻跟着缩**：`notifyLayout` 只由页面里的
   *    resize 监听触发，而页面马上就要卸载了。现在退出时显式把画面区域通知成
   *    **整个窗口**（退出全屏后就是窗口大小），让内核先缩到正确尺寸再销毁。
   *
   * 另外：只有**全屏时**才退出全屏。用户明确要求「全屏主窗口进播放器也自然是全屏」，
   * 所以从全屏主窗口进来时退出播放器本就该回到全屏主页 —— 那个场景下不该动窗口状态。
   */
  const exitPlayer = () => {
    probingRef.current = false
    playingRef.current = false
    const needDetach = engineState !== 'fallback'
    const relayId = relayRef.current?.sessionId
    relayRef.current = null
    // 退出前落一次进度，「继续观看」才能接着上次的位置
    reportPosition(true)

    // ① 控制栏悬浮窗立刻收掉（不等 whenPlayerGone 的 600ms，那段时间它会盖住主页）
    void api.overlay.hide(overlayGenRef.current ?? undefined)
    // ② 全屏时先退出全屏再导航：避免"主页已经画出来、窗口还是全屏"的那一帧空白
    if (fullscreen) void api.window.setFullscreen(false)
    // ③ 让内核把画面区域先缩回窗口大小（退出全屏后 window.innerWidth/Height 已经是窗口尺寸）
    if (needDetach) {
      void api.player.notifyLayout({
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight
      })
    }

    // ④ 再离开播放页：渲染层不再等待主进程清理（避免退出卡死）
    //    有番剧 id 时回到该番剧详情页（也就是播放源列表所在的页面），否则退回上一页
    if (state.subjectId != null) {
      navigate(`/subject/${state.subjectId}`, { state: { openSources: true }, replace: true })
    } else {
      navigate(-1)
    }
    /*
     * ⑤ 主进程的其余清理延后执行：销毁网页视图 / detach 内核都可能阻塞。
     * 注意这里**不再重复退出全屏**（已在上面同步做过），也不再重复 hide 控制栏 ——
     * 都在上面做完了，重复发一遍只会给主进程增加无意义的时序竞争。
     */
    window.setTimeout(() => {
      if (relayId) void api.media.stopLive(relayId)
      void api.ruleWebview.close()
      void api.ruleProbe.stop()
      if (needDetach) void api.player.detach()
    }, 150)
  }

  const switchEpisode = (index: number) => {
    if (index < 0 || index >= files.length) return
    setCurrentIndex(index)
    setCurrent(0)
    setDuration(0)
    setShowEpisodes(false)
    setVideoError(null)
    const v = videoRef.current
    if (v) v.currentTime = 0
  }

  // 键盘快捷键（可自定义绑定，见设置 → 播放器快捷键）
  const shortcutMap = useShortcuts((s) => s.map)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = matchShortcut(e, shortcutMap)
      if (!action) return
      const v = videoRef.current
      const useEngine = engineState !== 'fallback'
      switch (action) {
        case 'exit':
          // 依次关闭：选集 → 详情 → 退出全屏 → 退出播放（全屏时第一次 ESC 仅退出全屏）
          if (showEpisodes) setShowEpisodes(false)
          else if (showInfo) setShowInfo(false)
          else if (fullscreen) toggleFullscreen()
          else exitPlayer()
          break
        case 'fullscreen':
          toggleFullscreen()
          break
        case 'playPause':
          e.preventDefault()
          if (useEngine) void api.player.togglePause()
          else if (v) {
            if (v.paused) void v.play()
            else v.pause()
          }
          break
        case 'forward10':
          if (useEngine) {
            const t = duration > 0 ? Math.min(duration, current + 10) : current + 10
            setCurrent(t)
            void api.player.seek(t)
          } else if (v) {
            v.currentTime = Math.min(duration || 0, v.currentTime + 10)
          }
          break
        case 'back10':
          if (useEngine) {
            const t = Math.max(0, current - 10)
            setCurrent(t)
            void api.player.seek(t)
          } else if (v) {
            v.currentTime = Math.max(0, v.currentTime - 10)
          }
          break
        case 'volumeUp':
          if (useEngine) {
            const nv = Math.min(200, playerVolume + 10)
            setPlayerVolume(nv)
            void api.player.setVolume(nv)
            if (playerMuted) {
              setPlayerMuted(false)
              void api.player.setMute(false)
            }
          } else {
            setVolume((vol) => Math.min(1, vol + 0.1))
            setMuted(false)
          }
          break
        case 'volumeDown':
          if (useEngine) {
            const nv = Math.max(0, playerVolume - 10)
            setPlayerVolume(nv)
            void api.player.setVolume(nv)
          } else {
            setVolume((vol) => Math.max(0, vol - 0.1))
          }
          break
        case 'mute':
          if (useEngine) {
            const next = !playerMuted
            setPlayerMuted(next)
            void api.player.setMute(next)
          } else {
            setMuted((m) => !m)
          }
          break
        case 'nextEp':
          if (state.mode === 'local') switchEpisode(currentIndex + 1)
          break
        case 'prevEp':
          if (state.mode === 'local') switchEpisode(currentIndex - 1)
          break
        case 'episodes':
          if (state.mode === 'local') setShowEpisodes((s) => !s)
          break
        case 'info':
          void loadDetail()
          break
        case 'subtitle':
          if (useEngine) void cycleEngineSubtitle()
          else if (v) cycleSubtitle()
          break
        /**
         * 倍速切换（v0.2.9 最后更新）：按预设档位循环，1.0x 之后回到 1.25x。
         * HTML5 回退路径同样支持（`video.playbackRate`）。
         */
        case 'speed': {
          const idx = SPEED_STEPS.indexOf(playerSpeedRef.current)
          const next = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length] ?? 1
          applySpeed(next)
          break
        }
        case 'screenshot':
          if (engineState !== 'fallback') {
            void api.player.snapshot(state.title, currentEpisodeNo()).then((r) => {
              if (r.ok) toast.success(`截图已保存: ${r.data}`)
              else toast.error(r.error)
            })
          } else {
            void api.player.screenshot(state.title, currentEpisodeNo()).then((r) => {
              if (r.ok) toast.success(`截图已保存: ${r.data}`)
              else toast.error(r.error)
            })
          }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    shortcutMap,
    showEpisodes,
    showInfo,
    fullscreen,
    duration,
    current,
    files.length,
    currentIndex,
    engineState,
    playerVolume,
    playerMuted,
    subIndex,
    currentSubs.length
  ])

  useEffect(() => {
    const v = videoRef.current
    if (v) v.volume = volume
  }, [volume])
  useEffect(() => {
    const v = videoRef.current
    if (v) v.muted = muted
  }, [muted])

  const effectiveVolume = muted ? 0 : volume

  /** 状态流水：状态变化时追加一条（最多 40 条），供流详情弹窗展示「捕捉视频流过程」 */
  useEffect(() => {
    const line = `${new Date().toLocaleTimeString()} ${playStatus.text}`
    setStatusLog((prev) => (prev[prev.length - 1]?.endsWith(playStatus.text) ? prev : [...prev, line].slice(-40)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playStatus.text])


  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={`fixed inset-0 z-50 bg-black ${visible ? '' : 'cursor-none'}`}
      onMouseMove={poke}
      onMouseDown={poke}
    >
      {engineState !== 'fallback' ? (
        <EngineModeUI
          title={state.title}
          files={files}
          currentIndex={currentIndex}
          currentEpisode={currentFile?.episode ?? null}
          showEpisodes={showEpisodes}
          setShowEpisodes={setShowEpisodes}
          showInfo={showInfo}
          detail={detail}
          detailLoading={detailLoading}
          fullscreen={fullscreen}
          visible={visible}
          initError={engineError}
          videoError={videoError ?? (ruleProbeFailed ? '在线播放失败：未能捕获到视频流，请切换线路重试或退出' : null)}
          playing={playing}
          current={current}
          duration={duration}
          volume={playerVolume}
          muted={playerMuted}
          subtitleLabel={subtitleLabel}
          ruleMode={state.mode === 'rule'}
          ruleGroups={state.groups}
          ruleCurrent={ruleCurrent}
          ruleProbing={ruleProbing}
          playStatus={playStatus}
          onShowStatus={() => setShowStreamInfo(true)}
          onExit={exitPlayer}
          onSelectEpisode={(i) => switchEpisode(i)}
          onSelectRuleEpisode={(line, ep) => void handleRuleEpisode(line, ep)}
          onToggleInfo={() => void loadDetail()}
          onToggleFullscreen={toggleFullscreen}
          aspect={aspect}
          onChangeAspect={changeAspect}
          flow={flow}
          selfCheckNote={selfCheckNote}
          startedOnce={startedOnce}
          onTogglePause={() => void api.player.togglePause()}
          onSeek={(t) => {
            // 本地同步进度（暂停时内核不推送进度事件，避免进度条不响应）
            setCurrent(t)
            void api.player.seek(t)
          }}
          onVolume={(v) => {
            setPlayerVolume(v)
            void api.player.setVolume(v)
            if (v === 0) {
              setPlayerMuted(true)
              void api.player.setMute(true)
            } else if (playerMuted) {
              setPlayerMuted(false)
              void api.player.setMute(false)
            }
          }}
          onToggleMute={() => {
            const next = !playerMuted
            setPlayerMuted(next)
            void api.player.setMute(next)
          }}
          onCycleSubtitle={cycleEngineSubtitle}
          subs={engineSubs}
          subIdx={engineSubIdx}
          onSelectSub={(i) => {
            setEngineSubIdx(i)
            void api.player.setSubtitle(i < 0 ? -1 : (engineSubs[i]?.id ?? -1))
            if (i < 0) toast.info('字幕已关闭')
            else if (engineSubs[i]) toast.info(`字幕：${engineSubs[i].label}`)
          }}
          onPickSubtitle={() => {
            void api.dialog.pickSubtitle().then(async (r) => {
              if (!r.ok) {
                toast.error(r.error)
                return
              }
              if (!r.data) return
              const add = await api.player.addSubtitleFile(r.data)
              if (!add.ok) {
                toast.error(add.error)
                return
              }
              toast.success('字幕已加载')
              setTimeout(() => void refreshEngineSubs(), 800)
            })
          }}
          onToggleEpisodes={() => {
            setShowEpisodes(!showEpisodes)
            poke()
          }}
        />
      ) : (
        <>
      {/* 视频 / 规则页（规则模式不再回退网页播放：失败直接给出退出入口） */}
      <div className="absolute inset-0 flex items-center justify-center">
        {state.mode === 'rule' ? (
          <div className="flex flex-col items-center justify-center gap-3 px-8 text-center">
            <div className="text-sm text-white">
              {videoError ?? (ruleProbeFailed ? '在线播放失败：未能捕获到视频流' : '没有可播放的地址')}
            </div>
            <button
              className="rounded-lg bg-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/25 whitespace-nowrap"
              onClick={exitPlayer}
            >
              ✕ 退出播放
            </button>
          </div>
        ) : filesLoading ? (
          <Spinner size={30} />
        ) : videoSrc ? (
          <video
            ref={videoRef}
            src={videoSrc}
            autoPlay
            crossOrigin="anonymous"
            className="h-full w-full"
            onPlay={() => {
              setPlaying(true)
              // 本地 HTML5 回退路径也要标记「本轮已开播」，否则暂停时会被当成还在加载
              setStartedOnce(true)
              recordWatch()
            }}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
            onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
            onEnded={() => {
              if (state.mode === 'local' && currentIndex < files.length - 1) {
                switchEpisode(currentIndex + 1)
              }
            }}
            onError={handleVideoError}
          >
            {currentSubs.map((s) => (
              <track key={s.path} src={localSubUrl(s.path)} kind="subtitles" srcLang="zh" label={s.label} />
            ))}
          </video>
        ) : (
          <div className="text-sm text-white/60">
            {state.mode === 'local' ? '未找到可播放的视频文件' : '没有可播放的地址'}
          </div>
        )}
      </div>

      {/* 转码准备中遮罩 */}
      {preparing ? (
        <div className="absolute inset-0 z-[6] flex flex-col items-center justify-center gap-2 bg-black/60">
          <Spinner size={28} />
          <div className="text-xs text-white/70">
            {live ? '正在定位播放位置…' : '正在准备播放（编码探测 / 启动转码）…'}
          </div>
        </div>
      ) : null}

      {/* 视频加载错误提示 */}
      {videoError ? (
        <div className="absolute inset-0 z-[5] flex flex-col items-center justify-center gap-3 bg-black/70 px-8 text-center">
          <div className="text-sm text-white">{videoError}</div>
          {state.mode === 'local' && files.length > 1 ? (
            <div className="flex gap-2">
              <button
                className="rounded-lg bg-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/25 whitespace-nowrap"
                onClick={() => switchEpisode(currentIndex + 1)}
              >
                播放下一集
              </button>
            </div>
          ) : null}
          <div className="text-[11px] text-white/50">
            当前文件：{currentFile?.name ?? '未知'}
          </div>
        </div>
      ) : null}

      {/* 顶部控制栏（方案 3.9） */}
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: -24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -24 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 pb-8 pt-3"
          >
            <button
              onPointerDown={(e) => {
                // pointerdown 比 click 更可靠（控件自动隐藏动画期间也能触发）；仅响应左键
                if (e.button !== 0) return
                e.stopPropagation()
                e.preventDefault()
                exitPlayer()
              }}
              title="退出播放"
              className="flex h-10 w-14 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/20 hover:text-white active:bg-white/30"
            >
              <X size={20} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="line-clamp-1 text-sm font-medium text-white">
                {state.title}
                {currentFile?.episode != null ? ` · 第 ${currentFile.episode} 集` : ''}
              </div>
              {state.mode === 'local' && files.length > 0 ? (
                <div className="text-[11px] text-white/55">
                  {currentIndex + 1} / {files.length}
                  {live ? (
                    <span className="ml-2 rounded bg-accent/80 px-1.5 py-0.5 text-[10px] text-white">
                      {live.mode === 'vcopy' ? '转码播放 · 音轨转换' : '转码播放 · 视频转 H.264'}
                    </span>
                  ) : inspectInfo && !inspectInfo.compatible ? (
                    <span className="ml-2 rounded bg-white/20 px-1.5 py-0.5 text-[10px]">兼容模式</span>
                  ) : null}
                </div>
              ) : state.mode === 'rule' ? (
                <div className="text-[11px] text-white/55">规则播放 · 页面由站点提供</div>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              {state.mode === 'rule' && state.url ? (
                <TopBtn title="在浏览器中打开" onClick={() => window.open(state.url!, '_blank')}>
                  <ExternalLink size={16} />
                </TopBtn>
              ) : null}
              <TopBtn title="详情" onClick={() => void loadDetail()}>
                <Info size={16} />
              </TopBtn>
              <TopBtn title="弹幕开关（预留，后续实现）" disabled>
                <MessageSquare size={16} />
              </TopBtn>
              <TopBtn title="弹幕配置（预留，后续实现）" disabled>
                <Settings2 size={16} />
              </TopBtn>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 底部控制栏 */}
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/75 to-transparent px-4 pb-3 pt-8"
          >
            {/* 进度条（可拖动；转码流拖动会重启 FFmpeg 从目标时间继续） */}
            {state.mode !== 'rule' ? (
              <SeekBar
                current={current}
                duration={duration}
                onSeek={(t) => {
                  if (live) {
                    seekLive(t)
                    return
                  }
                  const v = videoRef.current
                  if (v) v.currentTime = t
                }}
              />
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {state.mode !== 'rule' ? (
                <>
                  <button
                    onClick={() => {
                      const v = videoRef.current
                      if (!v) return
                      if (v.paused) void v.play()
                      else v.pause()
                    }}
                    className="text-white transition-transform hover:scale-110 whitespace-nowrap"
                    title={playing ? '暂停' : '播放'}
                  >
                    {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
                  </button>
                  {state.mode === 'local' ? (
                    <>
                      <button
                        disabled={currentIndex <= 0}
                        className="text-white/85 transition-colors hover:text-white disabled:opacity-30"
                        onClick={() => switchEpisode(currentIndex - 1)}
                        title="上一集"
                      >
                        <SkipBack size={17} />
                      </button>
                      <button
                        disabled={currentIndex >= files.length - 1}
                        className="text-white/85 transition-colors hover:text-white disabled:opacity-30"
                        onClick={() => switchEpisode(currentIndex + 1)}
                        title="下一集"
                      >
                        <SkipForward size={17} />
                      </button>
                    </>
                  ) : null}
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setMuted((m) => !m)}
                      className="text-white/85 hover:text-white whitespace-nowrap"
                      title={muted ? '取消静音' : '静音'}
                    >
                      {effectiveVolume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={effectiveVolume}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        setVolume(v)
                        setMuted(v === 0)
                      }}
                      className="h-1 w-20 cursor-pointer accent-white"
                    />
                  </div>
                  <button
                    onClick={cycleSubtitle}
                    className={`flex items-center gap-1 text-[11px] transition-colors ${
                      subIndex >= 0 ? 'text-accent' : 'text-white/70 hover:text-white'
                    } whitespace-nowrap `}
                    title="切换字幕（srt / ass / ssa / vtt 自动转换）"
                  >
                    <Captions size={16} />
                    {subIndex >= 0 && currentSubs[subIndex] ? currentSubs[subIndex].label : ''}
                  </button>
                  <span className="text-[11px] tabular-nums text-white/75">
                    {fmtDuration(current)} / {fmtDuration(duration)}
                  </span>
                </>
              ) : (
                <span className="text-[11px] text-white/60">页面播放由站点控制（播放/暂停在页面内操作）</span>
              )}
              <div className="flex-1" />
              <div className="flex items-center gap-1">
                {state.mode === 'local' && files.length > 0 ? (
                  <TopBtn title="选集" onClick={() => { setShowEpisodes((v) => !v); poke() }}>
                    <ListVideo size={16} />
                  </TopBtn>
                ) : null}
                <TopBtn title={fullscreen ? '退出全屏' : '全屏'} onClick={toggleFullscreen}>
                  {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                </TopBtn>
                <TopBtn
                  title="截屏（保存到截图文件夹）"
                  onClick={() => {
                    void api.player.screenshot(state.title, currentEpisodeNo()).then((r) => {
                      if (r.ok) toast.success(`截图已保存: ${r.data}`)
                      else toast.error(r.error)
                    })
                  }}
                >
                  <Camera size={16} />
                </TopBtn>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 选集面板 */}
      <AnimatePresence>
        {showEpisodes && (
          <motion.div
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            className="absolute bottom-20 right-4 z-20 max-h-[60vh] w-64 overflow-y-auto rounded-xl border border-white/10 bg-black/80 p-2 backdrop-blur"
          >
            <div className="px-2 py-1.5 text-xs font-semibold text-white/85">选集（{files.length}）</div>
            {files.map((f, i) => (
              <button
                key={f.path}
                onClick={() => switchEpisode(i)}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                  i === currentIndex ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/8 hover:text-white'
                }`}
              >
                <span className="line-clamp-1">{f.episode != null ? `第 ${f.episode} 集` : f.name}</span>
                {i === currentIndex ? <Play size={11} fill="currentColor" /> : null}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 详情侧栏（再次点击关闭） */}
      <AnimatePresence>
        {showInfo && (
          <motion.div
            initial={{ opacity: 0, x: 60 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 60 }}
            className="absolute right-0 top-14 bottom-24 z-20 w-80 overflow-y-auto rounded-l-xl border border-white/10 bg-black/80 p-4 backdrop-blur"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-white">番剧详情</span>
              <button onClick={() => setShowInfo(false)} className="text-white/60 hover:text-white">
                <X size={15} />
              </button>
            </div>
            {detailLoading ? (
              <div className="flex justify-center py-10"><Spinner /></div>
            ) : detail ? (
              <>
                <div className="flex gap-3">
                  <CoverImage src={detail.images?.common ?? detail.images?.large ?? null} className="h-28 w-20 shrink-0 rounded-lg" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold leading-snug text-white">{detail.name_cn || detail.name}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {detail.rating?.score ? (
                        <Badge tone="warn">★ {detail.rating.score.toFixed(1)}</Badge>
                      ) : null}
                      {detail.air_date ? <Badge>{detail.air_date}</Badge> : null}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {detail.tags.slice(0, 8).map((t) => (
                    <Badge key={t.name}>{t.name}</Badge>
                  ))}
                </div>
                <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-white/70">{detail.summary || '暂无简介'}</p>
              </>
            ) : (
              <div className="py-6 text-center text-xs text-white/50">暂无详情数据</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
        </>
      )}

      {/* 流详情弹窗（顶部状态栏点击打开） */}
      <StreamInfoModal
        open={showStreamInfo}
        onClose={() => setShowStreamInfo(false)}
        extraLog={statusLog}
        /*
         * v0.3.9 补充：只有在线播放才给「重跑」——
         * 本地播放没有「重新解析地址」这一步，传了回调反而会造出一个点了没用的假按钮。
         */
        onRetry={state.mode === 'rule' ? retryStream : undefined}
      />
      {/* 断点续播的撤销提示（12 秒后自动消失） */}
      {resumeHint ? (
        <ResumeUndoHint
          target={resumeHint.target}
          onClose={() => setResumeHint(null)}
          onUndo={() => {
            setCurrent(0)
            void api.player.seek(0)
            setResumeHint(null)
            toast.info('已回到本集开头')
          }}
        />
      ) : null}
    </motion.div>
  )
}

/** 右下角「撤销自动跳转」提示（v0.2.4 断点续播） */
function ResumeUndoHint({ target, onUndo, onClose }: { target: number; onUndo: () => void; onClose: () => void }) {
  return (
    <div className="fixed bottom-24 right-5 z-[55] flex w-72 flex-col gap-2 rounded-xl border border-white/15 bg-black/85 p-3 text-white shadow-2xl backdrop-blur">
      <div className="text-xs">已自动跳转到上次观看位置 {fmtDuration(target)}</div>
      <div className="text-[11px] text-white/60">如果不想从这里继续，可以回到本集开头。</div>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] text-white/80 hover:bg-white/20 whitespace-nowrap"
          onClick={onClose}
        >
          保持
        </button>
        <button
          className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:brightness-110 whitespace-nowrap"
          onClick={onUndo}
        >
          撤销跳转
        </button>
      </div>
    </div>
  )
}

/** 原生内核模式界面（一体化控制布局）：顶条 + 视频区 + 底条均为 DOM，
 *  无内置 overlay 遮挡，上下控件同步 5 秒自动隐藏 */
function EngineModeUI({
  title,
  files,
  currentIndex,
  currentEpisode,
  showEpisodes,
  setShowEpisodes,
  showInfo,
  detail,
  detailLoading,
  fullscreen,
  visible,
  initError,
  videoError,
  playing,
  current,
  duration,
  volume,
  muted,
  subtitleLabel,
  ruleMode,
  ruleGroups,
  ruleCurrent,
  ruleProbing,
  playStatus,
  onShowStatus,
  onExit,
  onSelectEpisode,
  onSelectRuleEpisode,
  onToggleInfo,
  onToggleFullscreen,
  onTogglePause,
  onSeek,
  onVolume,
  onToggleMute,
  onCycleSubtitle,
  onSelectSub,
  onPickSubtitle,
  subs,
  subIdx,
  onToggleEpisodes,
  aspect,
  onChangeAspect,
  flow,
  selfCheckNote,
  startedOnce
}: {
  title: string
  files: LocalVideoFile[]
  currentIndex: number
  currentEpisode: number | null
  showEpisodes: boolean
  setShowEpisodes: (v: boolean) => void
  showInfo: boolean
  detail: SubjectDetail | null
  detailLoading: boolean
  fullscreen: boolean
  visible: boolean
  initError: string | null
  videoError: string | null
  playing: boolean
  current: number
  duration: number
  volume: number
  muted: boolean
  subtitleLabel: string | null
  ruleMode: boolean
  ruleGroups?: RuleEpisodeGroup[]
  ruleCurrent: { line: number; ep: number } | null
  ruleProbing: boolean
  playStatus: { kind: PlayStatus; text: string }
  onShowStatus: () => void
  onExit: () => void
  onSelectEpisode: (index: number) => void
  onSelectRuleEpisode: (line: number, ep: number) => void
  onToggleInfo: () => void
  onToggleFullscreen: () => void
  aspect: AspectMode
  onChangeAspect: (mode: AspectMode) => void
  onTogglePause: () => void
  onSeek: (sec: number) => void
  onVolume: (v: number) => void
  onToggleMute: () => void
  onCycleSubtitle: () => void
  onSelectSub: (index: number) => void
  onPickSubtitle: () => void
  subs: { id: number; label: string }[]
  subIdx: number
  onToggleEpisodes: () => void
  /** v0.3.9：播放过程进度（三阶段实时快照），来源是主进程 */
  flow: PlayFlowSnapshot | null
  /** v0.3.9：自检做过什么（非空时显示一行，用户要求不许静默） */
  selfCheckNote: string
  /**
   * v0.3.9 补充：本轮是否**成功出过画面**。
   *
   * 这条药丸要靠它判断「悬浮窗那张居中进度卡现在还在不在」——
   * 卡片只在「还没出过画面」时显示，两者必须互斥，否则屏幕上会同时出现两处进度提示。
   */
  startedOnce: boolean
}) {
  const [subMenuOpen, setSubMenuOpen] = useState(false)
  const [aspectMenuOpen, setAspectMenuOpen] = useState(false)
  const [selectedLine, setSelectedLine] = useState(0)
  // 抽屉开合/全屏切换/控制栏显隐后同步画面位置（libmpv 子窗口需要新矩形）
  useEffect(() => {
    const sync = (delay: number): void => {
      const t = setTimeout(() => {
        const el = document.getElementById('player-host')
        const r = el?.getBoundingClientRect()
        const bounds =
          r && r.width > 0 && r.height > 0
            ? { x: r.left, y: r.top, width: r.width, height: r.height }
            : undefined
        void api.player.notifyLayout(bounds)
      }, delay)
      timers.push(t)
    }
    const timers: number[] = []
    sync(200)
    // 全屏切换/窗口尺寸变化时布局会晚一步稳定（Electron 全屏过渡），再补两次
    sync(450)
    sync(900)
    const onResize = (): void => sync(150)
    window.addEventListener('resize', onResize)
    return () => {
      for (const t of timers) clearTimeout(t)
      window.removeEventListener('resize', onResize)
    }
  }, [showEpisodes, showInfo, visible, fullscreen])

  const hasEpisodes = ruleMode ? (ruleGroups?.length ?? 0) > 0 : files.length > 1
  /** 线路切换：规则模式下同一番剧可能有多个播放线路 */
  const activeLine = ruleCurrent?.line ?? selectedLine
  const activeLineEps = ruleMode ? ((ruleGroups ?? [])[activeLine]?.episodes.length ?? 0) : files.length
  const canPrev = ruleMode ? !!ruleCurrent && ruleCurrent.ep > 0 : currentIndex > 0
  const canNext = ruleMode
    ? !!ruleCurrent && ruleCurrent.ep + 1 < activeLineEps
    : currentIndex < files.length - 1
  const onPrevEpisode = (): void => {
    if (ruleMode) {
      if (ruleCurrent && ruleCurrent.ep > 0) onSelectRuleEpisode(ruleCurrent.line, ruleCurrent.ep - 1)
    } else {
      onSelectEpisode(currentIndex - 1)
    }
  }
  const onNextEpisode = (): void => {
    if (ruleMode) {
      if (ruleCurrent && ruleCurrent.ep + 1 < activeLineEps) onSelectRuleEpisode(ruleCurrent.line, ruleCurrent.ep + 1)
    } else {
      onSelectEpisode(currentIndex + 1)
    }
  }
  /** 控制条：透明背景 + 轻微渐变保证可读；5 秒无操作整体淡出 */
  const barCls = `z-30 shrink-0 transition-opacity duration-300 ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`
  const topBarCls = `${barCls} flex h-14 items-center justify-between bg-gradient-to-b from-black/70 via-black/25 to-transparent px-2`
  /**
   * v0.2.6：本组件只在「原生内核可用」时渲染（fallback 走另一条 HTML5 分支），
   * 而原生视频窗口永远盖在网页之上，页面里画的控制栏/抽屉都看不见。
   * 因此这里恒为 true：页面内控制栏不再渲染，画面铺满整窗，
   * 控制栏与选集/详情浮层统一由悬浮窗绘制。
   */
  const overlayActive = true
  const bottomBarCls = `${barCls} flex flex-col gap-1 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-3 pb-2 pt-6`

  return (
    <div className="absolute inset-0 flex flex-col bg-black">
      {/* 顶部（透明）：左侧退出，中/右侧状态与功能键。overlayActive 时由悬浮窗绘制，避免与视频层重复 */}
      <div className={overlayActive ? 'hidden' : topBarCls}>
        <button
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            onExit()
          }}
          title="退出播放（Esc）"
          className="pointer-events-auto flex h-11 w-16 items-center justify-center rounded-lg text-white transition-colors hover:bg-white/20 active:bg-white/30"
        >
          <X size={22} />
        </button>
        <div className="pointer-events-none min-w-0 flex-1 px-2">
          <div className="line-clamp-1 text-sm font-medium text-white drop-shadow">
            {title}
            {!ruleMode && currentEpisode != null ? ` · 第 ${currentEpisode} 集` : ''}
            {ruleMode && ruleCurrent != null ? ` · ${ruleGroups?.[ruleCurrent.line]?.episodes[ruleCurrent.ep]?.name ?? ''}` : ''}
          </div>
          <div className="text-[10px] text-white/60">
            {ruleMode
              ? // 已开播就不再显示「正在解析视频流」（v0.2.8：边播边嗅探时状态栏会误报，见 playStatus 注释）
                ruleProbing && !playing
                ? '正在解析视频流…'
                : '规则播放 · 直连视频流'
              : files.length > 0
                ? `${currentIndex + 1} / ${files.length}`
                : '内核播放'}
          </div>
        </div>
        {/*
          状态栏（居中）：显示当前播放状态，点击打开流详情。
          半透明药丸 + 至少 h-9 的命中区域，避免「只有下半部分能点」的问题
          （以前中间这块是纯文本，视觉上看不出可点，点上去也没反应）。
        */}
        <button
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            onShowStatus()
          }}
          title="查看播放状态与流详情（媒体地址 / 播放列表 / 分辨率 / 码率）"
          className={`pointer-events-auto flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11px] transition-colors ${
            playStatus.kind === 'failed'
              ? 'bg-danger/25 text-white hover:bg-danger/40'
              : playStatus.kind === 'playing'
                ? 'bg-white/12 text-white/90 hover:bg-white/25'
                : 'bg-white/18 text-white hover:bg-white/30'
          } whitespace-nowrap `}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              playStatus.kind === 'playing'
                ? 'bg-ok'
                : playStatus.kind === 'failed'
                  ? 'bg-danger'
                  : 'animate-pulse bg-warn'
            }`}
          />
          {/*
            v0.3.9 补充：药丸里**同一时刻只说一件事**，而且**只在别处没有进度提示时才说**。

            用户反馈「出现了两重提示：播放过程提示和加载提示…叠在一起」，给到的判据是
            「进播放到出画面这段过程里，屏幕上只出现一处进度/加载提示」。
            悬浮窗那张居中卡覆盖了「还没出画面」的整段时间，所以这一条药丸在那一整段时间里
            必须闭嘴（否则就是卡片 + 药丸两处同时显示进度）。
            它只在下面两种情况说话：
              · 已经开播过（居中卡已经消失）× 流程还在跑（例如播放中触发的重嗅探）；
              · 没有在跑的流程 → 退回原来的状态词（「播放中 / 已暂停」等，那不是进度提示）。
          */}
          {flow && flow.running && startedOnce && !videoError ? (
            <PlayFlowStages flow={flow} compact tone="onVideo" />
          ) : (
            playStatus.text
          )}
        </button>
        <div className="flex items-center gap-1">
          <TopBtn title="番剧详情" onClick={onToggleInfo}>
            <Info size={20} />
          </TopBtn>
          <TopBtn title="弹幕开关（预留，后续实现）" disabled>
            <MessageSquare size={20} />
          </TopBtn>
          <TopBtn title="弹幕设置（预留，后续实现）" disabled>
            <Settings2 size={20} />
          </TopBtn>
          <TopBtn
            title="截图（保存到截图文件夹）"
            onClick={() => {
              void api.player.snapshot(title, currentEpisode ?? undefined).then((r) => {
                if (r.ok) toast.success(`截图已保存: ${r.data}`)
                else toast.error(r.error)
              })
            }}
          >
            <Camera size={20} />
          </TopBtn>
        </div>
      </div>

      {/* 内容行：抽屉与视频容器为 flex 兄弟，视频区域随抽屉缩放 */}
      <div className="flex min-h-0 flex-1">
        {/*
          v0.2.7 附加 修「左侧和右侧都出现选集列表」：
          悬浮窗（overlayActive）已经用浮层画了选集，页面里再画一份就会左右各一个 ——
          左侧正是这个 `border-r` 抽屉（它过去没有被 overlayActive 屏蔽，只受 showEpisodes 控制）。
          画面由原生窗口绘制时，页面内的这套抽屉/控制栏一律不画，统一由悬浮窗呈现。
        */}
        {showEpisodes && !overlayActive ? (
          <div className="z-10 flex h-full w-60 shrink-0 flex-col border-r border-white/10 bg-[#111]">
            <div className="border-b border-white/10 px-3 py-2 text-xs font-semibold text-white/85">
              选集（{ruleMode ? (ruleGroups?.reduce((n, g) => n + g.episodes.length, 0) ?? 0) : files.length}）
            </div>
            {/* 线路切换：同一番剧的多个播放线路（第 1/2/3 线路…） */}
            {ruleMode && (ruleGroups?.length ?? 0) > 1 ? (
              <div className="flex flex-wrap gap-1 border-b border-white/10 px-2 py-2">
                {(ruleGroups ?? []).map((g, li) => {
                  const activeLine = (ruleCurrent?.line ?? selectedLine) === li
                  return (
                    <button
                      key={li}
                      onClick={() => setSelectedLine(li)}
                      title={g.lineName ?? `线路 ${li + 1}`}
                      className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                        activeLine ? 'bg-accent text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'
                      }`}
                    >
                      {g.lineName ?? `线路 ${li + 1}`}
                      <span className="ml-1 text-[10px] text-white/50">{g.episodes.length}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
            <div className="flex-1 overflow-y-auto p-2">
              {ruleMode ? (
                (() => {
                  const li = ruleCurrent?.line ?? selectedLine
                  const g = (ruleGroups ?? [])[li]
                  if (!g) return null
                  return (
                    <div className="grid grid-cols-4 gap-1">
                      {g.episodes.map((ep, ei) => {
                        const active = ruleCurrent?.line === li && ruleCurrent.ep === ei
                        return (
                          <button
                            key={ei}
                            onClick={() => {
                              onSelectRuleEpisode(li, ei)
                              setShowEpisodes(false)
                            }}
                            className={`truncate rounded-md px-1 py-1.5 text-center text-[11px] transition-colors ${
                              active
                                ? 'bg-accent text-white'
                                : 'bg-white/8 text-white/70 hover:bg-white/15 hover:text-white'
                            }`}
                            title={ep.name}
                          >
                            {ep.name || `第 ${ei + 1} 集`}
                          </button>
                        )
                      })}
                    </div>
                  )
                })()
              ) : (
                files.map((f, i) => (
                  <button
                    key={f.path}
                    onClick={() => {
                      onSelectEpisode(i)
                      setShowEpisodes(false)
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                      i === currentIndex ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/8 hover:text-white'
                    }`}
                  >
                    <span className="line-clamp-1">{f.episode != null ? `第 ${f.episode} 集` : f.name}</span>
                    {i === currentIndex ? <Play size={11} fill="currentColor" /> : null}
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}
        <div className="relative min-w-0 flex-1">
          {/*
            全屏时把画面铺满整屏：原生视频窗口永远盖在网页之上，所以控制栏不能叠在画面上，
            只能在控制栏隐藏（5 秒无操作）时占满整屏，控制栏出现时让出上下两条空间。
            非全屏保持原布局（控制栏常驻可见）。
          */}
          <div
            id="player-host"
            className={overlayActive ? 'fixed inset-0' : 'absolute inset-x-0 bottom-0 top-1.5'}
          />
          {/* 播放画面右侧悬浮截屏按钮（随控件一同显示/隐藏） */}
          <div
            className={`absolute right-3 top-1/2 z-10 -translate-y-1/2 transition-opacity duration-300 ${
              visible ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            <button
              title="截屏（保存到截图文件夹）"
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                void api.player.snapshot(title, currentEpisode ?? undefined).then((r) => {
                  if (r.ok) toast.success(`截图已保存: ${r.data}`)
                  else toast.error(r.error)
                })
              }}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white/90 shadow-lg backdrop-blur transition-colors hover:bg-black/75 hover:text-white"
            >
              <Camera size={20} />
            </button>
          </div>
          {/*
            v0.3.9 补充：这里**故意不再画**「加载中 + 过程进度」的居中整层。
            用户反馈「刚进入播放器播放时出现了两重提示：播放过程提示和加载提示，两个相同作用的东西叠在一起」。
            原因就是这一层与悬浮窗里那张提示卡同时存在：
            悬浮窗是覆盖整个主窗口的透明窗口，它画在中心的那张卡正好压在这一层上面，
            两个半透明黑底叠在一起，看起来就是两层提示糊在一块。
            
            现在统一成一处：**过程进度只由悬浮窗那张卡承担**（它是唯一保证画在原生视频窗口之上的层，
            见 PlayerOverlayPage 的说明）。这一层整块去掉 —— 这也正是用户给的第二个选项
            （「干脆去掉整层、由过程进度承担'正在加载'的表达」）。
          */}
          {videoError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60">
              <div className="max-w-md text-center text-sm text-white">{videoError}</div>
              <button
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  onExit()
                }}
                className="rounded-lg bg-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/25 whitespace-nowrap"
              >
                ✕ 退出播放
              </button>
            </div>
          ) : null}
          {initError ? (
            <div className="absolute inset-x-0 bottom-2 z-10 mx-auto w-fit rounded-lg bg-red-900/80 px-3 py-1.5 text-[11px] text-white">
              {initError}
            </div>
          ) : null}
        </div>
        {/* 详情面板同理：悬浮窗已经画了「番剧详情」，页面内不再重复画一份 */}
        {showInfo && !overlayActive ? (
          <div className="z-10 flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l border-white/10 bg-[#111] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-white">番剧详情</span>
              <button onClick={onToggleInfo} className="text-white/60 hover:text-white">
                <X size={15} />
              </button>
            </div>
            {detailLoading ? (
              <div className="flex justify-center py-10"><Spinner /></div>
            ) : detail ? (
              <>
                <div className="flex gap-3">
                  <CoverImage src={detail.images?.common ?? detail.images?.large ?? null} className="h-28 w-20 shrink-0 rounded-lg" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold leading-snug text-white">{detail.name_cn || detail.name}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {detail.rating?.score ? <Badge tone="warn">★ {detail.rating.score.toFixed(1)}</Badge> : null}
                      {detail.air_date ? <Badge>{detail.air_date}</Badge> : null}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {detail.tags.slice(0, 8).map((t) => (
                    <Badge key={t.name}>{t.name}</Badge>
                  ))}
                </div>
                <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-white/70">{detail.summary || '暂无简介'}</p>
              </>
            ) : (
              <div className="py-6 text-center text-xs text-white/50">暂无详情数据</div>
            )}
          </div>
        ) : null}
      </div>

      {/* 底部控制条（透明）：整宽进度条；左侧播放/暂停+上下集，右侧选集/字幕/全屏。overlayActive 时交给悬浮窗 */}
      <div className={overlayActive ? 'hidden' : bottomBarCls}>
        {/* 进度条（接近播放器整宽） */}
        <SeekBar current={current} duration={duration} onSeek={onSeek} />
        <div className="flex items-center justify-between gap-3 px-1">
          {/* 左：播放/暂停、上一集、下一集、时间、音量 */}
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                onTogglePause()
              }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/20 active:bg-white/30 whitespace-nowrap"
              title="播放/暂停（空格）"
            >
              {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
            </button>
            <button
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                onPrevEpisode()
              }}
              disabled={!canPrev}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/20 hover:text-white disabled:opacity-30"
              title="上一集"
            >
              <SkipBack size={18} />
            </button>
            <button
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                onNextEpisode()
              }}
              disabled={!canNext}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/20 hover:text-white disabled:opacity-30"
              title="下一集"
            >
              <SkipForward size={18} />
            </button>
            <span className="ml-1 shrink-0 text-[11px] tabular-nums text-white/80 drop-shadow">
              {fmtDuration(current)} / {fmtDuration(duration)}
            </span>
            <div className="ml-1 hidden shrink-0 items-center gap-1 sm:flex">
              <button
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  onToggleMute()
                }}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-white/90 hover:bg-white/20 hover:text-white whitespace-nowrap"
                title="静音（m）"
              >
                {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={muted ? 0 : volume}
                onChange={(e) => onVolume(Number(e.target.value))}
                className="h-1 w-20 cursor-pointer accent-white"
              />
            </div>
          </div>

          {/* 右：选集、字幕、全屏 */}
          <div className="flex shrink-0 items-center gap-1">
            {hasEpisodes ? (
              <button
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  onToggleEpisodes()
                }}
                className={`flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[12px] transition-colors ${
                  showEpisodes ? 'bg-white/25 text-white' : 'text-white/85 hover:bg-white/20 hover:text-white'
                } whitespace-nowrap `}
                title="选集（l）"
              >
                <ListVideo size={18} />
                选集
              </button>
            ) : null}
            {/* 字幕：选择字幕轨或手动选择字幕文件（在线播放不适用） */}
            <div className="relative shrink-0">
              <button
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  if (ruleMode) {
                    toast.info('在线播放不支持选择字幕文件')
                    return
                  }
                  setSubMenuOpen((v) => !v)
                }}
                className={`flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[12px] transition-colors ${
                  subtitleLabel ? 'bg-white/20 text-accent' : 'text-white/85 hover:bg-white/20 hover:text-white'
                } ${ruleMode ? 'opacity-50' : ''} whitespace-nowrap `}
                title={ruleMode ? '在线播放不适用字幕选择' : '字幕（c 快速切换）'}
              >
                <Captions size={17} />
                {subtitleLabel ?? '字幕'}
              </button>
              {subMenuOpen ? (
                <>
                  <div className="fixed inset-0 z-20" onPointerDown={() => setSubMenuOpen(false)} />
                  <div className="absolute bottom-full right-0 z-30 mb-2 w-60 overflow-hidden rounded-xl border border-white/15 bg-black/90 py-1 shadow-2xl backdrop-blur">
                    <div className="px-3 py-1.5 text-[10px] text-white/50">字幕轨道</div>
                    <button
                      onPointerDown={(e) => {
                        if (e.button !== 0) return
                        e.stopPropagation()
                        onSelectSub(-1)
                        setSubMenuOpen(false)
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-white/10 ${
                        subIdx < 0 ? 'text-accent' : 'text-white/80'
                      } whitespace-nowrap `}
                    >
                      关闭字幕
                    </button>
                    {subs.map((s, i) => (
                      <button
                        key={s.id}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return
                          e.stopPropagation()
                          onSelectSub(i)
                          setSubMenuOpen(false)
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-white/10 ${
                          i === subIdx ? 'text-accent' : 'text-white/80'
                        }`}
                      >
                        <span className="truncate">{s.label}</span>
                      </button>
                    ))}
                    {subs.length === 0 ? (
                      <div className="px-3 py-1.5 text-[11px] text-white/45">未检测到内封字幕轨</div>
                    ) : null}
                    <div className="my-1 border-t border-white/10" />
                    <button
                      onPointerDown={(e) => {
                        if (e.button !== 0) return
                        e.stopPropagation()
                        setSubMenuOpen(false)
                        onPickSubtitle()
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-white/85 hover:bg-white/10 whitespace-nowrap"
                    >
                      选择字幕文件…
                    </button>
                  </div>
                </>
              ) : null}
            </div>
            {/* 画面比例：适应 / 裁剪铺满 / 拉伸铺满 */}
            <div className="relative">
              <button
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  setAspectMenuOpen(!aspectMenuOpen)
                  setSubMenuOpen(false)
                }}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/20 hover:text-white ${
                  aspectMenuOpen ? 'bg-white/20 text-white' : ''
                } whitespace-nowrap `}
                title={`画面比例：${ASPECT_TEXT[aspect]}`}
              >
                {aspect === 'cover' ? (
                  <Crop size={18} />
                ) : aspect === 'stretch' ? (
                  <RectangleHorizontal size={18} />
                ) : (
                  <Expand size={18} />
                )}
              </button>
              {aspectMenuOpen ? (
                <div className="absolute bottom-11 right-0 z-40 w-40 rounded-lg border border-white/10 bg-black/85 p-1 text-[11px] text-white/85 backdrop-blur">
                  {(['fit', 'cover', 'stretch'] as AspectMode[]).map((m) => (
                    <button
                      key={m}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return
                        e.stopPropagation()
                        onChangeAspect(m)
                        setAspectMenuOpen(false)
                      }}
                      className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        aspect === m ? 'text-accent' : ''
                      }`}
                    >
                      <span>{ASPECT_TEXT[m]}</span>
                      {aspect === m ? <span>✓</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                onToggleFullscreen()
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/20 hover:text-white whitespace-nowrap"
              title="全屏（f）"
            >
              {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 画面比例文案 */
const ASPECT_TEXT: Record<AspectMode, string> = {
  fit: '适应（可能留黑边）',
  cover: '裁剪铺满',
  stretch: '拉伸铺满'
}

function TopBtn({
  title,
  onClick,
  disabled,
  active,
  children
}: {
  title: string
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onPointerDown={(e) => {
        // pointerdown 触发比 click 更灵敏（控件自动隐藏动画期间也能响应）；仅响应左键
        if (e.button !== 0) return
        e.stopPropagation()
        onClick?.()
      }}
      className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'bg-white/25 text-white'
          : 'text-white/90 hover:bg-white/20 hover:text-white active:bg-white/30'
      } whitespace-nowrap `}
    >
      {children}
    </button>
  )
}

/** 可拖动进度条 */
function SeekBar({ current, duration, onSeek }: { current: number; duration: number; onSeek: (t: number) => void }) {
  const barRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const seekFromEvent = (e: React.PointerEvent) => {
    // 仅响应左键（buttons 位掩码：1=左键），避免右键/中键触发拖动
    if (e.buttons !== 0 && e.buttons !== 1) return
    const bar = barRef.current
    if (!bar || duration <= 0) return
    const rect = bar.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(ratio * duration)
  }

  const pct = duration > 0 ? (current / duration) * 100 : 0

  return (
    <div
      ref={barRef}
      className="group relative flex h-6 cursor-pointer items-center"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        dragging.current = true
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        seekFromEvent(e)
      }}
      onPointerMove={(e) => {
        if (dragging.current) seekFromEvent(e)
      }}
      onPointerUp={() => {
        dragging.current = false
      }}
    >
      <div className="relative h-1.5 w-full overflow-visible rounded-full bg-white/25 transition-all group-hover:h-2">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <div
        className="absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover:opacity-100"
        style={{ left: `${pct}%` }}
      />
    </div>
  )
}
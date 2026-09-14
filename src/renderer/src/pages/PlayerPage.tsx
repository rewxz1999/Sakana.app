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
import type {
  AspectMode,
  LiveStartResult,
  LocalSubFile,
  LocalVideoFile,
  MediaInspectResult,
  PlayStatus,
  RuleEpisodeGroup,
  RuleSearchEntry,
  SubjectDetail
} from '@shared/types'
import { api } from '@/lib/api'
import { fmtDuration, localSubUrl, localVideoUrl } from '@/lib/format'
import { useLibrary } from '@/stores/library'
import { epKey, localKey, onlineKey, useWatchProgress } from '@/stores/watchProgress'
import { matchShortcut, useShortcuts } from '@/stores/shortcuts'
import { toast, useSettings } from '@/stores/app'
import { Badge, Spinner } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import { StreamInfoModal } from '@/components/StreamInfoModal'

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
}

const HIDE_DELAY = 5000
/** 距离结束多少秒开始预解析下一集（提前拿播放页地址，减少切集等待） */
const PRELOAD_LEAD = 40
/** 续播阈值：上次进度超过这个秒数才自动跳转，太小会显得莫名其妙 */
const RESUME_MIN_SEC = 30

export function PlayerPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const baseState = (location.state ?? { mode: 'online', title: '播放' }) as PlayerState
  // 自检/调试入口：?folder=<路径> 可直接以本地模式打开播放器（SAKANA_PLAYERUI_TEST 使用）
  const query = new URLSearchParams(location.search)
  const queryFolder = query.get('folder')
  const state: PlayerState = queryFolder
    ? {
        mode: 'local',
        title: query.get('title') ?? '测试视频',
        folder: queryFolder,
        episode: undefined
      }
    : baseState
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
  const [vlcState, setVlcState] = useState<'trying' | 'active' | 'fallback'>('trying')
  const [vlcError, setVlcError] = useState<string | null>(null)
  const [ruleStreamUrl, setRuleStreamUrl] = useState<string | null>(null)
  const [rulePageUrl, setRulePageUrl] = useState(state.url ?? '')
  const [ruleProbeFailed, setRuleProbeFailed] = useState(false)
  const [ruleCurrent, setRuleCurrent] = useState<{ line: number; ep: number } | null>(null)
  const [ruleProbing, setRuleProbing] = useState(false)
  const [vlcVolume, setVlcVolume] = useState(100)
  const [vlcMuted, setVlcMuted] = useState(false)
  const [vlcSubs, setVlcSubs] = useState<{ id: number; label: string }[]>([])
  const [vlcSubIdx, setVlcSubIdx] = useState(-1)
  /** 画面比例：fit=适应 / cover=裁剪铺满 / stretch=拉伸铺满 */
  const [aspect, setAspect] = useState<AspectMode>('fit')
  /** 顶部状态栏文案（捕捉视频流中 / 加载中 / 播放中 / 播放失败…） */
  const [statusLog, setStatusLog] = useState<string[]>([])
  const [showStreamInfo, setShowStreamInfo] = useState(false)
  /** 自动续播提示：非空时右下角显示「是否撤销本次跳转」 */
  const [resumeHint, setResumeHint] = useState<{ at: number; target: number } | null>(null)
  const [switching, setSwitching] = useState(false)
  const { settings: appSettings, save: saveSettings } = useSettings()
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
  const pokeRef = useRef<(() => void) | null>(null)
  /** 网页嗅探进行中：期间不自动隐藏控制条（否则用户无法点击退出） */
  const probingRef = useRef(false)
  /** 当前是否已进入播放（用于判断直连失败并切换到 FFmpeg 中转） */
  const playingRef = useRef(false)
  const relayRef = useRef<{ sessionId: string } | null>(null)
  const relayTriedRef = useRef(false)
  /** 切集互斥：连点/快捷键重复触发时只允许一次切换在飞，避免卡在中间态 */
  const switchRef = useRef(false)
  /** 下一集预解析结果（播放页地址与变量），播到末尾前提前拿到，切集几乎无等待 */
  const prefetchRef = useRef<{ key: string; pageUrl: string; vars?: Record<string, string> } | null>(null)
  /** 本集是否已经做过续播跳转（只在每集第一次播放时做一次） */
  const resumeDoneRef = useRef('')
  /** 自动连播是否已经触发（防止 time 事件高频重复触发） */
  const autoNextRef = useRef('')
  /** 播放进度上报节流 */
  const progressRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const progressApi = useWatchProgress()

  /**
   * 播放状态（顶部状态栏文案）：
   * 失败 > 捕捉视频流 > 加载 > 播放中 > 已暂停，优先级从高到低，保证异常状态不会被覆盖。
   */
  const playStatus: { kind: PlayStatus; text: string } = videoError
    ? { kind: 'failed', text: '播放失败' }
    : ruleProbeFailed
      ? { kind: 'failed', text: '播放失败' }
      : ruleProbing
        ? { kind: 'capturing', text: '捕捉视频流中' }
        : switching
          ? { kind: 'loading', text: '切换中' }
          : vlcState === 'trying' || preparing
            ? { kind: 'loading', text: '加载中' }
            : playing
              ? { kind: 'playing', text: '播放中' }
              : { kind: 'idle', text: '已暂停' }

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
    void api.vlc.play(r.data.url)
    window.setTimeout(() => {
      if (!playingRef.current) {
        setVideoError('在线播放失败：该站点的视频流无法播放，请切换其它规则或退出')
      }
    }, 12000)
  }
  const subtitlesLoadedRef = useRef('')

  const currentFile = files[currentIndex]
  const currentSubs: LocalSubFile[] = currentFile?.subs ?? []
  const subtitleLabel = vlcSubIdx >= 0 && vlcSubs[vlcSubIdx] ? vlcSubs[vlcSubIdx].label : null

  // 刷新字幕轨列表（libmpv / libVLC 共用同一接口）
  const refreshVlcSubs = async (retries = 0): Promise<void> => {
    const r = await api.vlc.subtitleTracks()
    if (r.ok) {
      setVlcSubs(r.data)
      setVlcSubIdx((prev) => (prev === -1 ? -1 : Math.min(prev, r.data.length - 1)))
      // 内核解析字幕轨需要时间（libmpv 读 track-list 更晚）：为空时短暂重试，避免误报「无字幕轨」
      if (r.data.length === 0 && retries < 5) {
        window.setTimeout(() => void refreshVlcSubs(retries + 1), 700)
      }
    }
  }

  const cycleVlcSubtitle = async () => {
    if (vlcSubs.length === 0) {
      toast.info('未检测到字幕轨（内封或外挂字幕文件）')
      return
    }
    const next = vlcSubIdx + 1 >= vlcSubs.length ? -1 : vlcSubIdx + 1
    setVlcSubIdx(next)
    await api.vlc.setSubtitle(next === -1 ? -1 : vlcSubs[next].id)
    toast.info(next === -1 ? '字幕已关闭' : `字幕：${vlcSubs[next].label}`)
  }

  // VLC 就绪后拉取初始状态；播放时刷新字幕轨、加载外挂字幕
  useEffect(() => {
    if (vlcState !== 'active') return
    void api.vlc.getState().then((r) => {
      if (r.ok) {
        setVlcVolume(r.data.volume)
        setVlcMuted(r.data.muted)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vlcState])

  useEffect(() => {
    if (vlcState !== 'active') return
    const sourceKey = state.mode === 'local' ? (currentFile?.path ?? '') : (ruleStreamUrl ?? '')
    if (!sourceKey || subtitlesLoadedRef.current === sourceKey) return
    subtitlesLoadedRef.current = sourceKey
    // 本地模式：加载同名字幕文件
    if (state.mode === 'local' && currentSubs.length > 0) {
      for (const s of currentSubs) void api.vlc.addSubtitleFile(s.path)
    }
    setTimeout(() => void refreshVlcSubs(), 800)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vlcState, currentFile?.path, ruleStreamUrl])

  // 尝试嵌入播放内核（libVLC 或 libmpv，由主进程按设置分发）；失败回退 HTML5 + FFmpeg 管线
  useEffect(() => {
    let alive = true
    void (async () => {
      // 视频区域矩形：libmpv 用它定位画面子窗口（libVLC 忽略该参数）
      const hostRect = (): { x: number; y: number; width: number; height: number } => {
        const el = document.getElementById('vlc-host')
        const r = el?.getBoundingClientRect()
        if (r && r.width > 0 && r.height > 0) {
          return { x: r.left, y: r.top, width: r.width, height: r.height }
        }
        return { x: 0, y: 56, width: window.innerWidth, height: Math.max(120, window.innerHeight - 120) }
      }
      // 防卡死：attach 若 20 秒内无响应（内核初始化异常），直接降级，避免播放器界面卡住
      const attachResult = await Promise.race([
        api.vlc.attach(hostRect()),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 20000))
      ])
      if (!alive) return
      if (attachResult === null) {
        const msg = '播放内核初始化超时（20 秒无响应）'
        setVlcError(msg)
        if (state.mode === 'rule') setVideoError(`在线播放初始化失败：${msg}`)
        else setVlcState('fallback')
        return
      }
      const r = attachResult
      if (r.ok && r.data.ok) {
        setVlcState('active')
        setPreparing(false)
      } else {
        const msg = r.ok ? r.data.message : r.error
        setVlcError(msg)
        if (state.mode === 'rule') {
          // 在线播放初始化失败：不再回退网页播放，直接显示错误并允许退出
          setVideoError(`在线播放初始化失败：${msg}`)
        } else {
          setVlcState('fallback')
        }
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode])

  // 规则模式：Kazumi 式在线播放 —— 用可见网页视图打开播放页，
  // 让站点播放器在真实会话中运行并嗅探媒体地址，命中后交给 libVLC 播放。
  const startRuleProbe = (pageUrl: string) => {
    if (probeCancelRef.current) probeCancelRef.current()
    // 新一轮嗅探：重置播放/中转状态并停掉上一条中转流
    playingRef.current = false
    relayTriedRef.current = false
    if (relayRef.current) {
      void api.media.stopLive(relayRef.current.sessionId)
      relayRef.current = null
    }
    setRulePageUrl(pageUrl)
    setRuleStreamUrl(null)
    ruleStreamRef.current = null
    setRuleProbeFailed(false)
    setRuleProbing(true)
    probingRef.current = true
    setVisible(true)
    let cancelled = false
    let usedWebview = false
    /** 网页视图位置：视频区域（上下控制条之外），保证退出按钮始终可点 */
    const currentBounds = (): { x: number; y: number; width: number; height: number } => {
      const host = document.getElementById('vlc-host')
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
    const offFound = api.ruleProbe.onFound((ev) => {
      if (cancelled) return
      if (!ruleStreamRef.current || ev.kind === 'm3u8') {
        ruleStreamRef.current = ev.url
        setRuleStreamUrl(ev.url)
        setRuleProbing(false)
        probingRef.current = false
        relayTriedRef.current = false
        // 命中即移除网页视图（用完即毁），再交给 libVLC（带站点 Cookie）
        if (usedWebview) void api.ruleWebview.close()
        void api.ruleProbe.stop()
        playingRef.current = false
        // referer 语义：undefined=未判定（回退规则站点）；''=经校验确定不带 Referer
        const refForPlay = ev.referer !== undefined ? ev.referer || undefined : state.referer
        void api.vlc.play(ev.url, refForPlay, ev.cookies)
        // 直连 8 秒仍未开播 → 切换到 FFmpeg 中转（换一套取流实现）
        window.setTimeout(() => {
          if (!cancelled && !playingRef.current && !relayTriedRef.current) {
            void startFfmpegRelay(ev.url, refForPlay, ev.cookies)
          }
        }, 8000)
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
    // 优先走可见网页视图；创建失败则回退到隐藏窗口嗅探
    void api.ruleWebview.open(pageUrl, currentBounds(), state.referer).then((r) => {
      if (cancelled) return
      if (r.ok && r.data) {
        usedWebview = true
      } else {
        void api.ruleProbe.start(pageUrl, state.referer)
      }
    })
    return () => {
      offFound()
      offDone()
      if (probeCancelRef.current) probeCancelRef.current()
      probeCancelRef.current = null
    }
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

  // 规则模式：选集切换（加载页 → 解析播放页 → 嗅探流 → 播放）
  /**
   * 切集。
   *
   * 过去的实现有两个毛病：连点/快捷键重复触发会同时发多条解析请求（表现为「卡住」）；
   * 切换过程中界面没有任何反馈（用户以为没响应）。现在：
   * - `switchRef` 做互斥，同一时间只允许一次切换；
   * - 立刻进入加载页（ruleProbing=true）并有超时兜底；
   * - 命中预解析结果时跳过 `rules.play`，切集几乎无等待。
   */
  const handleRuleEpisode = async (line: number, ep: number, opts?: { auto?: boolean }): Promise<void> => {
    if (!state.ruleId || !state.entry) return
    if (switchRef.current) return
    switchRef.current = true
    setSwitching(true)
    try {
      setShowEpisodes(false)
      setVideoError(null)
      setRuleProbeFailed(false)
      setRuleProbing(true)
      probingRef.current = true
      reportPosition(true)
      const key = `${line}:${ep}`
      const cached = prefetchRef.current
      let pageUrl = ''
      if (cached && cached.key === key && cached.pageUrl) {
        pageUrl = cached.pageUrl
      } else {
        const link = state.groups?.[line]?.episodes?.[ep]?.link ?? ''
        const r = await api.rules.play(state.ruleId, state.entry, line, ep, link, state.vars ?? {})
        if (!r.ok) {
          toast.error(`切换失败：${r.error}`)
          setRuleProbing(false)
          probingRef.current = false
          setVideoError(`切换剧集失败：${r.error}`)
          return
        }
        pageUrl = r.data.url
      }
      prefetchRef.current = null
      autoNextRef.current = ''
      setRuleCurrent({ line, ep })
      rememberEpisode(line, ep)
      startRuleProbe(pageUrl)
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
    autoNextRef.current = key
    toast.info('本集播放结束，正在自动播放下一集…')
    void handleRuleEpisode(line, ep + 1, { auto: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode, state.groups, ruleCurrent, handleRuleEpisode])

  /**
   * 预加载下一集 + 自动连播判定（播放进度驱动）。
   *
   * - 距结束 40 秒内先解析下一集的播放页地址（纯 HTTP，很便宜），切集时可直接复用；
   * - 进度到达结尾（或内核报 ended）时自动切下一集。两处都用 ref 去重，避免 time 事件高频重复触发。
   */
  useEffect(() => {
    if (state.mode !== 'rule' || !ruleCurrent || duration <= 0 || !state.ruleId || !state.entry) return
    const line = ruleCurrent.line
    const ep = ruleCurrent.ep
    const total = state.groups?.[line]?.episodes.length ?? 0
    // ① 自动连播
    if (current >= duration - 1.5) {
      autoNext()
      return
    }
    // ② 预加载下一集
    if (ep + 1 >= total) return
    const key = `${line}:${ep + 1}`
    if (prefetchRef.current?.key === key) return
    if (duration - current > PRELOAD_LEAD) return
    prefetchRef.current = { key, pageUrl: '' }
    const link = state.groups?.[line]?.episodes?.[ep + 1]?.link ?? ''
    void api.rules
      .play(state.ruleId, state.entry, line, ep + 1, link, state.vars ?? {})
      .then((r) => {
        if (!r.ok) {
          prefetchRef.current = null
          return
        }
        prefetchRef.current = { key, pageUrl: r.data.url }
      })
      .catch(() => {
        prefetchRef.current = null
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, duration, ruleCurrent, state.mode, state.groups, state.ruleId, state.entry, autoNext])

  /** 嗅探看门狗：超过 45 秒仍在「捕捉视频流中」就给出可操作的失败提示（而不是一直转圈） */
  useEffect(() => {
    if (!ruleProbing) return
    const t = window.setTimeout(() => {
      if (!ruleStreamRef.current) {
        setRuleProbing(false)
        probingRef.current = false
        setVideoError('捕捉视频流超时：该线路可能已失效，请切换线路或其它规则')
      }
    }, 45000)
    return () => window.clearTimeout(t)
  }, [ruleProbing])

  /**
   * 断点续播。
   *
   * 谨慎点：
   * - 只在「本集第一次真正开播（playing=true 且时长已知）」时做一次，避免还没出画面就 seek 造成卡死；
   * - 目标位置必须大于 30 秒且距结尾还有 15 秒以上，否则不跳；
   * - 跳转后右下角给出「撤销」提示，用户可一键回到开头。
   */
  useEffect(() => {
    if (!playing || duration <= 0) return
    const id = progressKeyOf()
    if (!id) return
    const stamp = `${id}#${ruleCurrent?.line ?? 0}:${ruleCurrent?.ep ?? currentIndex}`
    if (resumeDoneRef.current === stamp) return
    resumeDoneRef.current = stamp
    const stored = progressApi.items.find((i) => i.id === id)
    const explicit = state.startSec
    const target =
      explicit && explicit > RESUME_MIN_SEC
        ? explicit
        : stored && stored.positionSec > RESUME_MIN_SEC
          ? stored.positionSec
          : 0
    if (target <= 0 || target >= duration - 15) return
    setCurrent(target)
    void api.vlc.seek(target)
    setResumeHint({ at: Date.now(), target })
    toast.info(`已从上次位置 ${fmtDuration(target)} 继续播放`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration, progressKeyOf, ruleCurrent, currentIndex, state.startSec])

  // 撤销提示 12 秒后自动消失
  useEffect(() => {
    if (!resumeHint) return
    const t = window.setTimeout(() => setResumeHint(null), 12000)
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
    if (vlcState !== 'active' || state.mode !== 'rule') return
    const pageUrl = rulePageUrl || state.url
    if (!pageUrl) return
    const cleanup = startRuleProbe(pageUrl)
    return () => {
      cleanup?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vlcState, state.mode, rulePageUrl])

  // ---------- 观看进度（v0.2.4）：集数记录 + 断点续播 ----------
  // VLC 模式：设置播放列表并播放当前集
  useEffect(() => {
    if (vlcState !== 'active') return
    if (state.mode === 'local') {
      if (files.length === 0) return
      void api.vlc.setPlaylist(files.map((f) => f.path))
      const f = files[currentIndex]
      if (f) void api.vlc.play(f.path)
    } else if (state.url) {
      void api.vlc.play(state.url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vlcState, currentIndex, files.length, state.mode, state.url])

  // VLC 事件 → 播放状态/进度/集数同步
  useEffect(() => {
    if (vlcState !== 'active') return
    return api.vlc.onEvent((ev) => {
      switch (ev.type) {
        case 'cursor':
          // 主进程光标监听：libVLC 画面子窗口会吞掉 mousemove，全屏时靠它唤出控制栏
          pokeRef.current?.()
          break
        case 'playing':
          playingRef.current = true
          setPlaying(true)
          recordWatch()
          // 记住「正在看第几集」，让剧集列表能高亮已看集数与最近进度
          if (state.mode === 'rule' && ruleCurrent) rememberEpisode(ruleCurrent.line, ruleCurrent.ep)
          else if (state.mode === 'local') rememberLocal(currentIndex)
          // 新媒体的比例设置会被内核重置，重新下发一次
          applyAspect(aspectRef.current)
          setTimeout(() => void refreshVlcSubs(), 300)
          break
        case 'paused':
          setPlaying(false)
          reportPosition(true)
          break
        case 'stopped':
          setPlaying(false)
          reportPosition(true)
          break
        case 'ended':
          // 本集播完：规则模式自动连下一集；本地模式交给 libVLC 播放列表（主进程已下发 setPlaylist）
          reportPosition(true)
          if (state.mode === 'rule') autoNext()
          break
        case 'time':
          if (typeof ev.time === 'number') {
            setCurrent(ev.time / 1000)
            if (typeof ev.length === 'number') setDuration(ev.length / 1000)
          }
          break
        case 'length':
          if (typeof ev.length === 'number') setDuration(ev.length / 1000)
          break
        case 'playlistItem':
          if (typeof ev.index === 'number' && state.mode === 'local') {
            setCurrentIndex(ev.index)
            setVideoError(null)
          }
          break
        case 'error':
          if (state.mode === 'rule' && !ruleStreamRef.current) {
            // 规则模式 VLC 播放出错且无流 → 回退 iframe（可正常退出）
            setRuleProbeFailed(true)
          } else {
            if (ev.message) setVideoError(`播放失败: ${ev.message}`)
          }
          break
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vlcState, state.mode, currentIndex, files.length])

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
    if (state.mode !== 'local' || !currentFile || vlcState !== 'fallback') return
    void prepareFile(currentFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFile?.path, state.mode, vlcState])

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

  // 离开播放页时确保退出全屏（避免下次点击播放直接被全屏）
  useEffect(() => {
    return () => {
      void api.window.isFullscreen().then((full) => {
        if (full) void api.window.setFullscreen(false)
      })
    }
  }, [])

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
  /** 把比例模式下发给内核（区域尺寸用于 VLC 的拉伸/裁剪几何） */
  const applyAspect = useCallback((mode: AspectMode): void => {
    const el = document.getElementById('vlc-host')
    const r = el?.getBoundingClientRect()
    void api.vlc.setAspect(mode, r?.width ?? window.innerWidth, r?.height ?? window.innerHeight)
  }, [])
  useEffect(() => {
    if (vlcState !== 'active') return
    applyAspect(aspect)
  }, [aspect, vlcState, fullscreen, showEpisodes, showInfo, applyAspect])
  const changeAspect = useCallback(
    (mode: AspectMode) => {
      setAspect(mode)
      saveSettings({ aspectMode: mode })
      applyAspect(mode)
      toast.info(`画面比例：${mode === 'fit' ? '适应（可能留黑边）' : mode === 'cover' ? '裁剪铺满' : '拉伸铺满'}`)
    },
    [applyAspect, saveSettings]
  )

  // ---------- 全屏控制栏悬浮窗 ----------
  /**
   * 原生视频窗口永远盖在网页之上，全屏后画面铺满整屏就会挡住页面里的控制栏，
   * 所以全屏且没有抽屉占用空间时，控制栏改由独立的透明悬浮窗绘制（见 playerOverlay.ts）。
   *
   * v0.2.4 起不再只在全屏生效：小窗口时原生视频窗口同样盖在网页之上，
   * 页面里的控制栏既看不见、又把画面挤小（用户反馈「小窗口播放画面填不满」）。
   * 现在只要没打开抽屉，就把画面铺满整窗、控制栏交给悬浮窗，两种模式表现一致。
   */
  const overlayActive = !showEpisodes && !showInfo
  useEffect(() => {
    if (overlayActive) void api.overlay.show()
    else void api.overlay.hide()
  }, [overlayActive])
  useEffect(() => () => void api.overlay.hide(), [])

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
          void api.vlc.togglePause()
          break
        case 'forward10': {
          const t = duration > 0 ? Math.min(duration, current + 10) : current + 10
          setCurrent(t)
          void api.vlc.seek(t)
          break
        }
        case 'back10': {
          const t = Math.max(0, current - 10)
          setCurrent(t)
          void api.vlc.seek(t)
          break
        }
        case 'volumeUp': {
          const nv = Math.min(100, vlcVolume + 10)
          setVlcVolume(nv)
          void api.vlc.setVolume(nv)
          break
        }
        case 'volumeDown': {
          const nv = Math.max(0, vlcVolume - 10)
          setVlcVolume(nv)
          void api.vlc.setVolume(nv)
          break
        }
        case 'toggleMute': {
          const next = !vlcMuted
          setVlcMuted(next)
          void api.vlc.setMute(next)
          break
        }
        case 'seek':
          setCurrent(a.time)
          void api.vlc.seek(a.time)
          break
        case 'prevEpisode':
          goPrevEpisode()
          break
        case 'nextEpisode':
          goNextEpisode()
          break
        case 'cycleSubtitle':
          void cycleVlcSubtitle()
          break
        case 'setSubtitle': {
          const idx = vlcSubs.findIndex((s) => s.id === a.id)
          if (idx >= 0) {
            setVlcSubIdx(idx)
            void api.vlc.setSubtitle(a.id)
            toast.info(`字幕：${vlcSubs[idx].label}`)
          }
          break
        }
        case 'toggleEpisodes':
          setShowEpisodes((v) => !v)
          poke()
          break
        case 'toggleInfo':
          setShowInfo(true)
          void loadDetail()
          poke()
          break
        case 'snapshot':
          void api.vlc.snapshot(state.title).then((r) => {
            if (r.ok) toast.success(`截图已保存: ${r.data}`)
            else toast.error(r.error)
          })
          break
        case 'setAspect':
          changeAspect(a.aspect)
          break
        case 'exitFullscreen':
          void api.window.setFullscreen(false)
          break
        case 'exitPlayer':
          exitPlayer()
          break
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    overlayActive,
    duration,
    current,
    vlcVolume,
    vlcMuted,
    vlcSubs,
    goPrevEpisode,
    goNextEpisode,
    changeAspect,
    state.title,
    poke
  ])

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
      volume: vlcVolume,
      muted: vlcMuted,
      aspect,
      hasEpisodes: state.mode === 'rule' ? groups.length > 0 : files.length > 1,
      canPrev: state.mode === 'rule' ? !!ruleCurrent && ruleCurrent.ep > 0 : currentIndex > 0,
      canNext:
        state.mode === 'rule'
          ? !!ruleCurrent && ruleCurrent.ep + 1 < (groups[line]?.episodes.length ?? 0)
          : currentIndex < files.length - 1,
      subs: vlcSubs,
      subIdx: vlcSubIdx,
      fullscreen,
      status: playStatus,
      error: videoError ?? (ruleProbeFailed ? '未能捕获到视频流，请切换线路或退出' : null)
    })
  }, [
    overlayActive,
    state.title,
    state.mode,
    state.groups,
    ruleCurrent,
    currentFile,
    currentIndex,
    files.length,
    playing,
    current,
    duration,
    vlcVolume,
    vlcMuted,
    aspect,
    vlcSubs,
    vlcSubIdx,
    fullscreen,
    playStatus,
    videoError,
    ruleProbeFailed
  ])

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

  const toggleFullscreen = () => {
    void api.window.setFullscreen(!fullscreen)
  }

  const exitPlayer = () => {
    probingRef.current = false
    playingRef.current = false
    const needDetach = vlcState !== 'fallback'
    const relayId = relayRef.current?.sessionId
    relayRef.current = null
    // 退出前落一次进度，「继续观看」才能接着上次的位置
    reportPosition(true)
    // ① 先离开播放页：渲染层不再等待主进程清理（避免退出卡死）
    //    有番剧 id 时回到该番剧详情页（也就是播放源列表所在的页面），否则退回上一页
    if (state.subjectId != null) {
      navigate(`/subject/${state.subjectId}`, { state: { openSources: true }, replace: true })
    } else {
      navigate(-1)
    }
    // ② 主进程清理全部延后执行：销毁网页视图 / detach libVLC 都可能阻塞
    window.setTimeout(() => {
      if (relayId) void api.media.stopLive(relayId)
      void api.ruleWebview.close()
      void api.ruleProbe.stop()
      if (fullscreen) void api.window.setFullscreen(false)
      if (needDetach) void api.vlc.detach()
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
      const useVlc = vlcState !== 'fallback'
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
          if (useVlc) void api.vlc.togglePause()
          else if (v) {
            if (v.paused) void v.play()
            else v.pause()
          }
          break
        case 'forward10':
          if (useVlc) {
            const t = duration > 0 ? Math.min(duration, current + 10) : current + 10
            setCurrent(t)
            void api.vlc.seek(t)
          } else if (v) {
            v.currentTime = Math.min(duration || 0, v.currentTime + 10)
          }
          break
        case 'back10':
          if (useVlc) {
            const t = Math.max(0, current - 10)
            setCurrent(t)
            void api.vlc.seek(t)
          } else if (v) {
            v.currentTime = Math.max(0, v.currentTime - 10)
          }
          break
        case 'volumeUp':
          if (useVlc) {
            const nv = Math.min(100, vlcVolume + 10)
            setVlcVolume(nv)
            void api.vlc.setVolume(nv)
            if (vlcMuted) {
              setVlcMuted(false)
              void api.vlc.setMute(false)
            }
          } else {
            setVolume((vol) => Math.min(1, vol + 0.1))
            setMuted(false)
          }
          break
        case 'volumeDown':
          if (useVlc) {
            const nv = Math.max(0, vlcVolume - 10)
            setVlcVolume(nv)
            void api.vlc.setVolume(nv)
          } else {
            setVolume((vol) => Math.max(0, vol - 0.1))
          }
          break
        case 'mute':
          if (useVlc) {
            const next = !vlcMuted
            setVlcMuted(next)
            void api.vlc.setMute(next)
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
          if (useVlc) void cycleVlcSubtitle()
          else if (v) cycleSubtitle()
          break
        case 'screenshot':
          if (vlcState !== 'fallback') {
            void api.vlc.snapshot(state.title).then((r) => {
              if (r.ok) toast.success(`截图已保存: ${r.data}`)
              else toast.error(r.error)
            })
          } else {
            void api.player.screenshot(state.title).then((r) => {
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
    vlcState,
    vlcVolume,
    vlcMuted,
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
      {vlcState !== 'fallback' ? (
        <VlcModeUI
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
          initError={vlcError}
          videoError={videoError ?? (ruleProbeFailed ? '在线播放失败：未能捕获到视频流，请切换线路重试或退出' : null)}
          playing={playing}
          current={current}
          duration={duration}
          volume={vlcVolume}
          muted={vlcMuted}
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
          onTogglePause={() => void api.vlc.togglePause()}
          onSeek={(t) => {
            // 本地同步进度（暂停时 libVLC 不推送进度事件，避免进度条不响应）
            setCurrent(t)
            void api.vlc.seek(t)
          }}
          onVolume={(v) => {
            setVlcVolume(v)
            void api.vlc.setVolume(v)
            if (v === 0) {
              setVlcMuted(true)
              void api.vlc.setMute(true)
            } else if (vlcMuted) {
              setVlcMuted(false)
              void api.vlc.setMute(false)
            }
          }}
          onToggleMute={() => {
            const next = !vlcMuted
            setVlcMuted(next)
            void api.vlc.setMute(next)
          }}
          onCycleSubtitle={cycleVlcSubtitle}
          subs={vlcSubs}
          subIdx={vlcSubIdx}
          onSelectSub={(i) => {
            setVlcSubIdx(i)
            void api.vlc.setSubtitle(i < 0 ? -1 : (vlcSubs[i]?.id ?? -1))
            if (i < 0) toast.info('字幕已关闭')
            else if (vlcSubs[i]) toast.info(`字幕：${vlcSubs[i].label}`)
          }}
          onPickSubtitle={() => {
            void api.dialog.pickSubtitle().then(async (r) => {
              if (!r.ok) {
                toast.error(r.error)
                return
              }
              if (!r.data) return
              const add = await api.vlc.addSubtitleFile(r.data)
              if (!add.ok) {
                toast.error(add.error)
                return
              }
              toast.success('字幕已加载')
              setTimeout(() => void refreshVlcSubs(), 800)
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
              className="rounded-lg bg-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/25"
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
                className="rounded-lg bg-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/25"
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
            <div className="mt-2 flex items-center gap-3">
              {state.mode !== 'rule' ? (
                <>
                  <button
                    onClick={() => {
                      const v = videoRef.current
                      if (!v) return
                      if (v.paused) void v.play()
                      else v.pause()
                    }}
                    className="text-white transition-transform hover:scale-110"
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
                      className="text-white/85 hover:text-white"
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
                    }`}
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
                    void api.player.screenshot(state.title).then((r) => {
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
      <StreamInfoModal open={showStreamInfo} onClose={() => setShowStreamInfo(false)} extraLog={statusLog} />
      {/* 断点续播的撤销提示（12 秒后自动消失） */}
      {resumeHint ? (
        <ResumeUndoHint
          target={resumeHint.target}
          onClose={() => setResumeHint(null)}
          onUndo={() => {
            setCurrent(0)
            void api.vlc.seek(0)
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
      <div className="flex justify-end gap-2">
        <button
          className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] text-white/80 hover:bg-white/20"
          onClick={onClose}
        >
          保持
        </button>
        <button
          className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:brightness-110"
          onClick={onUndo}
        >
          撤销跳转
        </button>
      </div>
    </div>
  )
}

/** libVLC 模式界面（一体化控制布局）：顶条 + 视频区 + 底条均为 DOM，
 *  无内置 overlay 遮挡，上下控件同步 5 秒自动隐藏 */
function VlcModeUI({
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
  onChangeAspect
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
}) {
  const [subMenuOpen, setSubMenuOpen] = useState(false)
  const [aspectMenuOpen, setAspectMenuOpen] = useState(false)
  const [selectedLine, setSelectedLine] = useState(0)
  // 抽屉开合/全屏切换/控制栏显隐后同步画面位置（libmpv 子窗口需要新矩形，libVLC 用其内部布局通知）
  useEffect(() => {
    const sync = (delay: number): void => {
      const t = setTimeout(() => {
        const el = document.getElementById('vlc-host')
        const r = el?.getBoundingClientRect()
        const bounds =
          r && r.width > 0 && r.height > 0
            ? { x: r.left, y: r.top, width: r.width, height: r.height }
            : undefined
        void api.vlc.notifyLayout(bounds)
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
   * 没有抽屉时画面铺满整窗（`fixed inset-0`），控制栏由透明悬浮窗绘制；
   * 打开抽屉后回到常规布局（画面只占内容行），让抽屉可见可点。
   * 组件内部同样用 overlayActive 决定要不要画页面内的控制栏，避免与悬浮窗重复。
   */
  const overlayActive = !showEpisodes && !showInfo
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
              ? ruleProbing
                ? '正在解析视频流…'
                : '规则播放 · 直连视频流'
              : files.length > 0
                ? `${currentIndex + 1} / ${files.length}`
                : 'libVLC 播放'}
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
          }`}
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
          {playStatus.text}
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
              void api.vlc.snapshot(title).then((r) => {
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
        {showEpisodes ? (
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
            id="vlc-host"
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
                void api.vlc.snapshot(title).then((r) => {
                  if (r.ok) toast.success(`截图已保存: ${r.data}`)
                  else toast.error(r.error)
                })
              }}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white/90 shadow-lg backdrop-blur transition-colors hover:bg-black/75 hover:text-white"
            >
              <Camera size={20} />
            </button>
          </div>
          {ruleProbing ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60">
              <Spinner size={26} />
              <div className="text-xs text-white/70">正在解析视频流…</div>
              <button
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  onExit()
                }}
                className="rounded-lg bg-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/25"
              >
                ✕ 退出播放
              </button>
            </div>
          ) : null}
          {videoError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60">
              <div className="max-w-md text-center text-sm text-white">{videoError}</div>
              <button
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  onExit()
                }}
                className="rounded-lg bg-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/25"
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
        {showInfo ? (
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
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/20 active:bg-white/30"
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
                className="flex h-9 w-9 items-center justify-center rounded-lg text-white/90 hover:bg-white/20 hover:text-white"
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
                }`}
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
                } ${ruleMode ? 'opacity-50' : ''}`}
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
                      }`}
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
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-white/85 hover:bg-white/10"
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
                }`}
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
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/20 hover:text-white"
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
      }`}
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

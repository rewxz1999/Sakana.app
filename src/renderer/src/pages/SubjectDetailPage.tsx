import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  CalendarDays,
  CircleCheck,
  CirclePlay,
  Copy,
  Download,
  FilePlay,
  Globe2,
  Heart,
  Play,
  Rss,
  Search,
  Star,
  Users,
  X
} from 'lucide-react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { CharacterItem, EpisodeProgress, MikanItem, PlayRule, SubjectDetail } from '@shared/types'
// 值导入（不是 type）：置顶排序是运行时要用的 —— 来源列表的顺序就由它决定（v0.3.7）
import { sortRulesPinnedFirst } from '@shared/types'
import { api } from '@/lib/api'
import { useLibrary } from '@/stores/library'
import { useSubs } from '@/stores/subs'
import { toast } from '@/stores/app'
import { progressSummary, useWatchProgress } from '@/stores/watchProgress'
import { fmtDateTime } from '@/lib/format'
import { Badge, Button, ConfirmModal, EmptyState, Modal, ProgressBar, Spinner } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
/*
 * 「选择数据源-选集界面」（v0.3.9）：三列级联（源 → 结果 → 选集）取代了原来的
 * 「选择播放源」+「在线播放」两级弹窗接力。失败原因归类与键盘导航都在它自己内部，
 * 因此本文件里原来那两个弹窗的实现（约 460 行）已随这次改造删除，不再留死代码。
 */
import { PlayerSourcePage } from '@/components/playerSource/PlayerSourcePage'


/** 时间戳 → YYYY-MM-DD（用于看完时间手动修改） */
function finishDateStr(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 取路径所在目录（渲染进程拿不到 node:path，这里手工兼容 Windows 反斜杠与 POSIX 斜杠） */
function dirOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return idx > 0 ? filePath.slice(0, idx) : filePath
}

/** 路径相等判断（Windows 大小写不敏感，斜杠统一后再比较） */
function samePath(a: string, b: string): boolean {
  return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()
}

/** 观看进度文案：「已看 3 集 · 上次看到第 4 集 62%」 */
function progressText(s: { watchedCount: number; lastEpisode: number | null; percent: number }): string {
  const parts: string[] = [`已看 ${s.watchedCount} 集`]
  const pct = s.percent > 0 ? ` ${s.percent}%` : ''
  if (s.lastEpisode != null) parts.push(`上次看到第 ${s.lastEpisode} 集${pct}`)
  else if (pct) parts.push(`${s.percent}%`)
  return parts.join(' · ')
}

/**
 * 详细信息取值的兜底格式化（v0.2.7）。
 * bgm 的 infobox `value` 可能是字符串，也可能是 `[{v:"..."}]` 这种对象数组；
 * 直接把数组塞进 JSX 会让 React 抛 "Objects are not valid as a React child" 而白屏。
 * 主进程已统一压平，这里再兜一层，避免任何来源（含网页镜像解析）漏网。
 */
function infoText(v: unknown): string {
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (item && typeof item === 'object') {
          const o = item as { v?: unknown; k?: unknown }
          return String(o.v ?? o.k ?? '')
        }
        return String(item ?? '')
      })
      .filter((s) => s.length > 0)
      .join('、')
  }
  return v === null || v === undefined ? '' : String(v)
}

/**
 * 骨架条（v1.1.4）。
 *
 * 详情页现在是「分板块先到先显」，每块在数据没到之前必须有自己的骨架，
 * 而不是全页一个 Spinner —— 用户要的是「能先看到已有内容」，不是「等全部到齐再看」。
 * 只用一个 animate-pulse 的灰条，避免引入新组件/新依赖。
 */
function Sk({ className = '' }: { className?: string }): React.ReactElement {
  return <div className={`animate-pulse rounded bg-elev2 ${className}`} />
}

/** 「详细信息」板块的骨架：列数/行数对齐真实内容，数据到了不会跳版 */
function InfoSkeleton(): React.ReactElement {
  return (
    <div className="mt-6 rounded-xl border border-border bg-elev1/80 p-4 backdrop-blur">
      <Sk className="mb-3 h-4 w-20" />
      <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Sk className="h-3 w-16 shrink-0" />
            <Sk className="h-3 flex-1" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 详情页首屏骨架（完全没有缓存时才显示）。
 *
 * 与以前的「大 Spinner + 空白页」不同：这里保留真实的版面结构（封面块、标题行、徽章行、
 * 简介行、信息面板），数据到达时是「填空」而不是「换页」，观感上不会突然跳一下。
 */
function DetailSkeleton(): React.ReactElement {
  return (
    <>
      <div className="flex gap-6" data-detail-section="skeleton">
        <Sk className="aspect-[3/4] w-52 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <Sk className="h-7 w-2/3" />
          <div className="mt-3 flex gap-2">
            <Sk className="h-5 w-16 rounded-full" />
            <Sk className="h-5 w-24 rounded-full" />
            <Sk className="h-5 w-14 rounded-full" />
          </div>
          <div className="mt-4 space-y-2">
            <Sk className="h-3 w-full" />
            <Sk className="h-3 w-11/12" />
            <Sk className="h-3 w-4/5" />
          </div>
        </div>
      </div>
      <InfoSkeleton />
    </>
  )
}

export function SubjectDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  /** 来源标记：搜索页以 navigate('/subject/:id', { state: { from: 'search' } }) 进入 */
  const fromSearch = (location.state as { from?: string } | null | undefined)?.from === 'search'
  const subjectId = Number(id)
  /**
   * 详情数据的三个来源**分开存**（v1.1.4「先到先显」）：
   *   · quick：主进程磁盘/内存缓存快照（毫秒级返回，绝不联网）；
   *   · detail：完整详情（缓存命中时也很快；未命中才联网，本次实测可能 30 秒以上）；
   *   · rating：独立评分板块（先显示缓存值，再后台换成新值）。
   * 渲染时 `view = detail ?? quick`，任何一份先到都能先把标题/封面/简介画出来，
   * 而不是像以前那样整页只有一个 Spinner、必须等全部数据到齐。
   */
  const [quick, setQuick] = useState<SubjectDetail | null>(null)
  const [detail, setDetail] = useState<SubjectDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(true)
  const [detailFailed, setDetailFailed] = useState('')
  /** 评分板块（与正文解耦：详情慢不影响评分先显示，评分慢也不影响正文） */
  const [rating, setRating] = useState<{ score: number | null; total: number } | null>(null)
  /** V1.5.3：角色板块已删除（减少人物图请求），这里不再保留 characters 状态 */
  /**
   * 「更新到第几集」（v0.3.7，用户要求）。
   * 单独一个请求（分集接口），失败/取不到就是 null —— 界面据此**整行不显示**。
   * 刻意不把它塞进 `detail`：详情接口 30 天缓存，而集数进度一周一变、还要 6 小时刷新一次，
   * 两者生命周期不同，混在一起会互相拖累。
   */
  const [epProgress, setEpProgress] = useState<EpisodeProgress | null>(null)
  const [epLoading, setEpLoading] = useState(true)
  const [ruleOpen, setRuleOpen] = useState(false)
  const [mikanOpen, setMikanOpen] = useState(false)
  const [rules, setRules] = useState<PlayRule[]>([])
  /**
   * 过完人机验证后要**自动选中并重新搜索**的那条线路（v0.3.9）。
   *
   * 旧实现是两个弹窗接力：验证回来直接 `setPlayRule(rule)` 打开「在线播放」弹窗。
   * 现在只有一个「选择数据源-选集界面」，于是改成带上这条线路并打开它 ——
   * 用户过完验证落在**结果列**上（而不是回到源列表第一列再自己点一次），
   * 与 v0.3.7「验证状态已保留，正在用这条线路重新搜索…」的承诺一致。
   */
  const [initialRule, setInitialRule] = useState<PlayRule | null>(null)
  /** 需要人机验证的那条规则（非空时弹出验证窗口，v0.3.7） */
  const [verify, setVerify] = useState<{ rule: PlayRule } | null>(null)
  /** 全屏状态（原生窗口全屏 / 页面级全屏）：全屏时返回按钮改为悬浮定位，避免贴边 */
  const [fullscreen, setFullscreen] = useState(false)
  /** 本地播放选择/扫描中（按钮 loading） */
  const [localBusy, setLocalBusy] = useState(false)
  /**
   * 「本地播放」的两个选项（V1.5.1，用户要求）：
   *   自行选择文件播放 / 从本地库播放（本地库没有就提示"本地库中暂未下载该番剧"）。
   * 用一个小弹层而不是直接把按钮一分为二：详情页底部操作区已经很挤，
   * 旧用户也习惯"点本地播放就选文件"这一下，弹层正好把新入口挂在同一处。
   */
  const [localMenuOpen, setLocalMenuOpen] = useState(false)
  const { favorites, toggleFavorite, toggleWatched, setWatchedAt, watchHistory } = useLibrary()
  const progressItems = useWatchProgress((s) => s.items)
  const progressLoaded = useWatchProgress((s) => s.loaded)
  const loadProgress = useWatchProgress((s) => s.load)

  useEffect(() => {
    let alive = true
    // 换条目时先清空上一部番的板块数据（否则会闪一下上一部的封面/评分）
    setQuick(null)
    setDetail(null)
    setRating(null)
    setDetailLoading(true)
    setDetailFailed('')
    setEpProgress(null)
    setEpLoading(true)

    /*
     * ① 纯缓存快照：毫秒级返回，先把标题/封面/简介/评分画出来。
     * 这是「分板块、先到先显」的第一块，绝不等待网络。
     */
    void api.bangumi.subjectCached(subjectId).then((r) => {
      if (!alive || !r.ok || !r.data.data) return
      setQuick(r.data.data)
    })

    // ② 完整详情（标签/详细信息所在）：命中缓存立即返回；没缓存才联网
    void (async () => {
      const r = await api.bangumi.subject(subjectId)
      if (!alive) return
      if (r.ok && r.data.data) {
        setDetail(r.data.data)
        setDetailFailed('')
      } else if (!r.ok) {
        setDetailFailed(r.error)
      } else if (r.data.error) {
        setDetailFailed(r.data.error.message)
      }
      setDetailLoading(false)
    })()

    /*
     * ③ 评分：先用 6 小时内缓存（零请求、毫秒级），再在后台强制刷新一次。
     * 两个 await 都是独立的，不阻塞正文；评分慢只是这一块晚一点变新。
     */
    void (async () => {
      const cached = await api.bangumi.rating(subjectId)
      if (!alive) return
      if (cached.ok) setRating({ score: cached.data.score, total: cached.data.total })
      /*
       * 只有「没有评分缓存」或「缓存超过 6 小时」才真的联网刷新。
       * 为什么不能每次都刷新：一次评分请求就是一次 `/v0/subjects/:id`（实测 30 秒级），
       * 每开一次详情页都打一次会把 S 级队列长期占满 —— 这正是旧的「详情页慢 + 番剧表加载不完」。
       */
      const SIX_HOURS = 6 * 3600 * 1000
      const fresh = cached.ok && cached.data.fromCache && cached.data.fetchedAt != null && Date.now() - cached.data.fetchedAt < SIX_HOURS
      if (fresh) return
      const freshRating = await api.bangumi.rating(subjectId, true)
      if (!alive) return
      if (freshRating.ok && !freshRating.data.error) {
        setRating({ score: freshRating.data.score, total: freshRating.data.total })
      }
    })()

    /*
     * ④ 分集进度：与详情**并行**（独立请求），失败只隐藏这一行，不置整页错误。
     */
    void (async () => {
      const p = await api.bangumi.episodeProgress(subjectId)
      if (!alive) return
      setEpProgress(p.ok ? p.data : null)
      setEpLoading(false)
    })()

    return () => {
      alive = false
    }
  }, [subjectId])

  /** 两个来源合成一份可渲染的详情：完整详情优先，其次缓存快照 */
  const view = detail ?? quick
  /**
   * 评分取「独立刷新的值 → 详情自带值」：
   * 评分缓存先到就先显示，后台刷新回来再替换；两者都没有时不显示 0 分。
   */
  const ratingScore = rating?.score ?? view?.rating?.score ?? null
  const ratingTotal = rating?.total ?? view?.rating?.total ?? 0

  // V1.5.3：角色接口调用一并删除（详情页不再加载人物介绍/人物图）

  // 全屏状态：原生窗口全屏（主进程事件）+ 页面级全屏（document.fullscreenElement）任一为真
  useEffect(() => {
    void api.window.isFullscreen().then(setFullscreen)
    const offFullscreen = api.window.onFullscreenChange(setFullscreen)
    const onDocFullscreen = (): void => {
      if (document.fullscreenElement) setFullscreen(true)
      else void api.window.isFullscreen().then(setFullscreen)
    }
    document.addEventListener('fullscreenchange', onDocFullscreen)
    return () => {
      offFullscreen()
      document.removeEventListener('fullscreenchange', onDocFullscreen)
    }
  }, [])

  // 观看进度：首次进入详情页时从主进程 store 载入（已载入则不再重复请求）
  useEffect(() => {
    if (!progressLoaded) void loadProgress()
  }, [progressLoaded, loadProgress])

  /** 观看进度摘要（已看集数 / 上次看到第几集 / 该集播放百分比） */
  const progress = useMemo(
    () => progressSummary(progressItems, { subjectId, title: view?.name_cn || view?.name }),
    [progressItems, subjectId, view]
  )

  /** 返回：来自搜索列表时回退一步即回到搜索结果，其它来源沿用原有「返回上一页」行为 */
  const goBack = (): void => {
    if (fromSearch || window.history.length > 1) {
      navigate(-1)
      return
    }
    // 无历史记录（如直接以 hash 打开详情页）时 navigate(-1) 无效果，兜底回首页
    navigate('/')
  }

  /**
   * Esc 退出详情页（v0.3.6，用户要求「退出响应对 esc 按钮」）。
   *
   * ⚠️ 三个「不该抢」的情况都按顺序让开，否则会出现「按 Esc 关掉弹窗的同时把详情页也退了」：
   *   ① 有弹窗打开（来源选择 / 蜜柑订阅 / 确认框）→ 交给弹窗自己处理，这里不动作；
   *   ② 有输入框 / 文本域正在聚焦（用户在写东西）→ 不动作；
   *   ③ 有 IME 组字中（`isComposing`，中文输入法打拼音时按 Esc 是取消候选）→ 不动作。
   *
   * 另外：用 **capture 阶段**监听并在动作后 `stopPropagation`，
   * 这样同一层里如果有别的 Esc 处理（比如未来的抽屉/浮层），不会被重复触发两次返回。
   * 依赖里带上所有弹窗状态，保证闭包里读到的是最新值（挂载时捕获一次会失效）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      if (ruleOpen || mikanOpen) return
      const el = document.activeElement as HTMLElement | null
      const tag = el?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
      e.stopPropagation()
      goBack()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleOpen, mikanOpen, fromSearch])

  /** 本地播放传给播放页的标题 */
  const playerTitle = view?.name_cn || view?.name || '本地播放'

  /**
   * 本地播放（单个文件）：播放页的本地模式以「文件夹」为单位建立播放列表
   * （见 PlayerPage 的 mode: 'local' 分支：folder 扫描列表 + episode 定位集数），
   * 因此这里取所选文件的目录，并用 listVideos 定位该文件的集序号后再跳转。
   *
   * v0.2.5：详情页只保留这一个本地播放入口（原先还有一个「从文件夹播放」，
   * 与这里的功能重叠：本方法本来就会用文件所在文件夹建立列表）。
   */
  const playLocalFile = async (): Promise<void> => {
    const picked = await api.dialog.pickVideo()
    if (!picked.ok) {
      toast.error(picked.error)
      return
    }
    if (!picked.data) return // 用户取消
    const filePath = picked.data
    const folder = dirOf(filePath)
    setLocalBusy(true)
    const listed = await api.media.listVideos(folder)
    setLocalBusy(false)
    if (!listed.ok) {
      toast.error(listed.error)
      return
    }
    const index = listed.data.findIndex((f) => samePath(f.path, filePath))
    const target = index >= 0 ? listed.data[index] : undefined
    if (!target) {
      toast.warn('未能识别该视频文件（可能不是受支持的视频格式），请换一个文件')
      return
    }
    if (target.episode == null && index > 0) {
      toast.info('该文件名未包含集数，播放器会从文件夹的第一集开始播放')
    }
    navigate('/player', {
      state: {
        mode: 'local',
        title: playerTitle,
        folder,
        subjectId,
        episode: target.episode ?? undefined
      }
    })
  }

  /**
   * 从本地库播放（V1.5.1）。
   *
   * 目录推导走主进程 `library.localDir`（与下载器建目录同一份规则），
   * 没有文件时按用户要求明确提示「本地库中暂未下载该番剧」，而不是弹一个文件夹选择框 ——
   * 那会让用户以为"本地库"只是一个换了名字的选文件按钮。
   */
  const playFromLocalLibrary = async (): Promise<void> => {
    setLocalMenuOpen(false)
    setLocalBusy(true)
    const r = await api.library.localDir({
      subjectId,
      animeTitle: view?.name_cn || view?.name || ''
    })
    setLocalBusy(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (!r.data.exists || r.data.videos === 0) {
      toast.warn('本地库中暂未下载该番剧')
      return
    }
    navigate('/local-anime', {
      state: {
        title: playerTitle,
        dir: r.data.dir,
        cover: view?.images?.large ?? '',
        subjectId
      }
    })
  }

  const fav = view ? favorites.find((f) => f.subjectId === view.id) : null
  const isFav = !!fav
  // 已看完：手动标记时间，或自动判定的最后观看时间
  const watchedAt = fav?.watchedAt ?? null
  const autoWatchedAt = (() => {
    if (watchedAt) return null
    if (fav?.eps && fav.eps > 0) {
      const eps = new Set<number>()
      for (const h of watchHistory) {
        if (h.subjectId === view?.id && h.episode != null) eps.add(h.episode)
      }
      if (eps.size >= fav.eps) {
        const last = watchHistory
          .filter((h) => h.subjectId === view?.id)
          .sort((a, b) => b.watchedAt - a.watchedAt)[0]
        return last?.watchedAt ?? null
      }
    }
    return null
  })()
  const finalWatchedAt = watchedAt ?? autoWatchedAt

  /**
   * 详细信息行（v0.2.7 重做）。
   *
   * 过去是一个只有 17 个键的**精确匹配白名单**（`动画制作/导演/放送开始/…`），
   * 而 bgm 的 infobox 实际有 40~60 个键，且同一含义有多种写法：
   * 「製作」（繁体，很多番剧的制作公司字段）、「别名」「放送星期」「播放电视台」「分镜」「演出」
   * 「总作画监督」「色彩设计」「音响监督」等全部被白名单丢掉 ——
   * 用户看到的「制作信息/监督等信息加载不出来」就是这么来的（数据在，是我们没显示）。
   *
   * 现在改为**关键词匹配 + 优先级排序**：先按重要度展示常用的十来项，
   * 其余折在「展开全部」里，既不丢信息也不把页面撑爆。
   */
  const { rows: infoRows, rest: infoRest } = useMemo(() => {
    if (!view) return { rows: [], rest: 0 }
    const rows = [...view.infobox]
    // 数据源额外给的平台/总集数也补成一行（v0 的字段不在 infobox 里）
    if (view.platform && !rows.some((r) => r.key === '平台')) rows.unshift({ key: '平台', value: view.platform })
    if (view.totalEpisodes && !rows.some((r) => r.key === '总集数'))
      rows.push({ key: '总集数', value: String(view.totalEpisodes) })
    const score = (key: string): number => {
      const rules: [RegExp, number][] = [
        [/^(中文名|别名)$/, 0],
        [/^(话数|总集数|平台|类型)$/, 1],
        [/^(放送开始|上映|发售|播放结束)/, 2],
        [/^(导演|监督|副导演)/, 3],
        [/^(系列构成|脚本|分镜|演出)/, 4],
        [/^(原作|原案|人物原案|人物设定)/, 5],
        [/^(动画制作|製作|制作|音乐制作)/, 6],
        [/^(音乐|主题歌)/, 7],
        [/^(美术|色彩|摄影|作画|剪辑|音响|设定)/, 8],
        [/^(官方网站|播放电视台|其他电视台|Copyright|©)/i, 9]
      ]
      for (const [re, n] of rules) if (re.test(key)) return n
      return 99
    }
    const sorted = rows.slice().sort((a, b) => score(a.key) - score(b.key))
    return { rows: sorted, rest: Math.max(0, sorted.length - 12) }
  }, [view])
  const [showAllInfo, setShowAllInfo] = useState(false)
  const infoShown = showAllInfo ? infoRows : infoRows.slice(0, 12)

  /**
   * 打开「选择数据源-选集界面」（v0.3.9 起是**一个**三列级联的页面，不再是两级弹窗接力）。
   *
   * 规则列表仍然在这里备好：过滤启用项 + 按 PINNED_RULES 置顶排序都只做一次，
   * 页面里只负责渲染与级联，避免"同一份顺序在两处各排一遍"（v0.3.7 的教训：
   * 以前这里写死过一份 preferred 名单，与规则管理页的置顶不一致，用户以为置顶没生效）。
   */
  const openRules = async (preselect?: PlayRule | null) => {
    const r = await api.store.get('rules')
    const list: PlayRule[] = r.ok && Array.isArray(r.data) ? (r.data as PlayRule[]) : []
    const enabled = sortRulesPinnedFirst(list.filter((rule) => rule.enabled))
    setRules(enabled)
    setInitialRule(preselect ?? null)
    if (enabled.length === 0) {
      toast.warn('暂无启用的播放规则，请先在「设置 → 规则管理」中添加')
    }
    setRuleOpen(true)
  }

  /**
   * 从播放页退出回来时自动打开「播放源列表」（v0.2.4）。
   * 播放页退出时带 `state.openSources`，用户期望看到的是「换一条线路/规则继续看」，
   * 而不是回到详情页顶部再自己找按钮。
   */
  useEffect(() => {
    const st = location.state as { openSources?: boolean } | null
    if (!st?.openSources) return
    if (!view) return // 等详情加载完再弹，否则没有番剧名可用于搜索
    void openRules()
    // 清掉标记，避免刷新/返回时再次弹出
    navigate(location.pathname, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, location.state])

  return (
    <div className="relative h-full overflow-y-auto">
      {/* 毛玻璃背景（方案 3.7）：缓存快照先到就先用它，不必等完整详情 */}
      {view?.images?.large ? (
        <div className="pointer-events-none fixed inset-0">
          <CoverImage src={view.images.large} className="h-full w-full opacity-40 blur-2xl" />
          <div className="absolute inset-0 bg-gradient-to-b from-bg/60 via-bg/75 to-bg" />
        </div>
      ) : null}

      <div className="relative mx-auto max-w-5xl px-8 py-6">
        {/*
          返回按钮（v0.3.6 调整）。
          用户要求：「番剧详情页的退出按钮增大一点（不需要太大），且退出响应对 esc 按钮」。
          · 尺寸：图标 14→16、内边距 px-3 py-1.5、字号 text-xs 保持不变 ——
            只放大可点区域与图标，不改变整体观感（用户特别说了「不需要太大」）。
          · 非全屏下也补上边框与浅底：以前非全屏是一个纯文字按钮，点击热区只有文字那么大，
            鼠标要精准怼上去；现在它是一个明确的按钮，热区至少 28px 高。
          · 键盘：Esc 绑定见下面的 useEffect（只在没有打开弹窗时生效，见注释）。
        */}
        <button
          onClick={goBack}
          title={fromSearch ? '返回搜索结果（Esc）' : '返回上一页（Esc）'}
          className={`whitespace-nowrap ${
            fullscreen
              ? // 全屏时窗口边框消失、左侧留白变窄，按钮显得贴边：向右让出 4rem（ml-16），
                // 既不与标题栏/侧边栏等控件重叠，也加浅色底以适配全屏下的毛玻璃背景
                'mb-4 ml-16 flex items-center gap-2 rounded-lg border border-border bg-elev1/80 px-3.5 py-2 text-xs text-dim backdrop-blur transition-colors hover:border-accent hover:text-text'
              : 'mb-4 flex items-center gap-2 rounded-lg border border-border bg-elev1/60 px-3.5 py-2 text-xs text-dim transition-colors hover:border-accent hover:text-text'
          }`}
        >
          <ArrowLeft size={16} /> {fromSearch ? '返回搜索' : '返回'}
        </button>

        {view ? (
          <>
            <div className="flex gap-6" data-detail-section="header">
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-52 shrink-0"
              >
                <CoverImage
                  /*
                   * V1.5.2 修「详情页封面加载不出来」：卡片用的是 400px 缩放图（已缓存），
                   * 详情页原来用 large（原尺寸），命中不了同一缓存条目，且部分网络下直连会被中断。
                   * 头部封面实际只显示 208px 宽，用 common（400px）既清晰又直接命中缓存；
                   * large 仍作为兜底（万一 common 缺失）。
                   */
                  src={view.images?.common ?? view.images?.large ?? null}
                  className="aspect-[3/4] w-full rounded-xl shadow-xl shadow-black/25"
                />
              </motion.div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-3">
                  <div>
                    <h1 className="text-2xl font-bold leading-tight">{view.name_cn || view.name}</h1>
                    {view.name_cn && view.name !== view.name_cn ? (
                      <div className="mt-0.5 text-sm text-faint">{view.name}</div>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {/*
                    评分板块（独立加载）：先用缓存值，后台刷新到了再换。
                    没有分数且还在加载时给一个骨架胶囊，避免"先没有后突然冒出来"的抖动。
                  */}
                  {ratingScore ? (
                    <Badge tone="warn">
                      <Star size={11} fill="currentColor" /> {ratingScore.toFixed(1)}
                      {ratingTotal ? ` · ${ratingTotal} 人评分` : ''}
                    </Badge>
                  ) : !detailLoading || !quick ? (
                    <Sk className="h-5 w-16 rounded-full" />
                  ) : null}
                  {view.air_date ? (
                    <Badge tone="accent">
                      <CalendarDays size={11} /> {view.air_date}
                    </Badge>
                  ) : null}
                  {view.eps != null ? <Badge>全 {view.eps} 话</Badge> : null}
                  {/*
                    「更新到第几集」（v0.3.7）：数据来自分集接口每集的放送日期，数出来的真值。
                    · 还在播：显示「更新至 第 N 集」（有下一集日期时补一句「下集 MM-DD」）；
                    · 已播完：显示「已完结 · 共 N 集」（和上面的「全 X 话」不重复 ——
                      那个是 bangumi 登记的计划集数，这个是真的播完了）。
                    取不到进度（离线 / 兜底数据源 / 没登记分集）时整块不渲染，不显示 0。
                    v1.1.4：加载中显示骨架胶囊，成功后替换 —— 分集接口慢不再让这一行"凭空出现"。
                  */}
                  {epLoading ? (
                    <Sk className="h-5 w-28 rounded-full" />
                  ) : epProgress && epProgress.aired > 0 ? (
                    epProgress.finished ? (
                      <Badge tone="ok">
                        <CircleCheck size={11} /> 已完结 · 共 {epProgress.total} 集
                      </Badge>
                    ) : (
                      <>
                        <Badge tone="accent">
                          <CirclePlay size={11} /> 更新至 第 {epProgress.aired} 集
                          {epProgress.total > 0 ? ` / 全 ${epProgress.total} 集` : ''}
                        </Badge>
                        {epProgress.nextAirDate ? (
                          <Badge>下集 {String(epProgress.nextAirDate).slice(5)}</Badge>
                        ) : null}
                      </>
                    )
                  ) : null}
                  {finalWatchedAt ? (
                    <Badge tone="ok">
                      <CircleCheck size={11} /> 看完于 {fmtDateTime(finalWatchedAt)}
                    </Badge>
                  ) : null}
                  {/* 标签板块：完整详情到了才有；加载中显示三个骨架胶囊 */}
                  {view.tags.length > 0 ? (
                    <span className="contents" data-detail-section="tags">
                      {view.tags.slice(0, 6).map((t) => (
                        <Badge key={t.name}>{t.name}</Badge>
                      ))}
                    </span>
                  ) : detailLoading ? (
                    <>
                      <Sk className="h-5 w-12 rounded-full" />
                      <Sk className="h-5 w-16 rounded-full" />
                      <Sk className="h-5 w-10 rounded-full" />
                    </>
                  ) : null}
                </div>
                {/* 观看进度（无记录时不显示） */}
                {progress.item ? (
                  <div className="mt-3 flex items-center gap-2 text-[11px] text-dim">
                    <CirclePlay size={12} className="shrink-0 text-accent" />
                    <span>{progressText(progress)}</span>
                    {progress.percent > 0 ? <ProgressBar value={progress.percent} className="w-24" /> : null}
                  </div>
                ) : null}
                {/* 简介板块：缓存快照里就带 summary，通常首屏即可见 */}
                <p
                  className="mt-4 max-h-44 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-dim"
                  data-detail-section="summary"
                >
                  {view.summary || (!detailLoading ? '暂无简介' : '')}
                </p>
                {detailLoading && !view.summary ? (
                  <div className="mt-2 space-y-2">
                    <Sk className="h-3 w-full" />
                    <Sk className="h-3 w-11/12" />
                    <Sk className="h-3 w-3/4" />
                  </div>
                ) : null}
              </div>
            </div>

            {/*
              完整详情失败但缓存快照可用：不整页报错，只给一行不打扰的说明 ——
              用户至少还能看标题/封面/简介，并继续点「播放」。
            */}
            {quick && detailFailed ? (
              <div className="mt-4 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] text-warn">
                完整详情暂时取不到，当前显示的是本地缓存（{detailFailed}）
              </div>
            ) : null}

            {/* 详细信息板块：完整详情到达后才渲染；未到且无数据时显示骨架 */}
            {infoRows.length > 0 ? (
              <div
                className="mt-6 rounded-xl border border-border bg-elev1/80 p-4 backdrop-blur"
                data-detail-section="infobox"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold">详细信息</span>
                  {infoRest > 0 ? (
                    <button
                      onClick={() => setShowAllInfo((v) => !v)}
                      className="text-[11px] text-accent hover:underline whitespace-nowrap"
                    >
                      {showAllInfo ? '收起' : `展开全部（还有 ${infoRest} 项）`}
                    </button>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                  {infoShown.map((row) => (
                    <div key={row.key + infoText(row.value)} className="flex gap-2 text-[13px]">
                      <span className="w-20 shrink-0 text-faint">{row.key}</span>
                      <span className="min-w-0 flex-1 break-words text-dim">{infoText(row.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : detailLoading ? (
              <InfoSkeleton />
            ) : null}

            {/*
              V1.5.3：删除「角色」板块（用户要求）。
              角色接口一次要拉 8 张人物图，是与番剧表/详情封面抢流量的主要来源；
              详情页只保留番剧本身的信息后，图片需求显著下降。
            */}
          </>
        ) : detailLoading ? (
          <DetailSkeleton />
        ) : detailFailed ? (
          <EmptyState icon={CalendarDays} title="加载详情失败" desc={detailFailed}>
            <Button size="sm" onClick={goBack}>
              返回
            </Button>
          </EmptyState>
        ) : null}
      </div>

      {/* 左下角操作按钮（方案 3.7） */}
      {view ? (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="fixed bottom-6 left-[212px] z-30 flex max-w-[calc(100vw-15rem)] flex-wrap items-center gap-2.5 rounded-2xl border border-border bg-elev1/90 px-4 py-3 shadow-xl backdrop-blur"
        >
          <Button icon={Play} onClick={() => void openRules()}>
            播放
          </Button>
          {/*
            V1.5.2：规则播放之外的四条附加在线路径（Apple CMS / REST / AnimePahe / AllManga）。
            独立一个入口而不是塞进「选源-选集」面板：两者的数据形态完全不同，分开更不容易互相影响。
          */}
          <Button
            variant="outline"
            icon={Globe2}
            title="附加在线数据源（Apple CMS / 自托管 REST / AnimePahe / AllManga）"
            onClick={() =>
              navigate('/online-sources', {
                state: { keyword: view?.name_cn || view?.name || '', subjectId }
              })
            }
          >
            在线源
          </Button>
          <Button
            variant="soft"
            icon={FilePlay}
            loading={localBusy}
            title="本地播放：可以自己选一个文件，也可以直接播放本地库里已经下载的集数"
            onClick={() => setLocalMenuOpen(true)}
          >
            本地播放
          </Button>
          <Button variant="soft" icon={Rss} onClick={() => setMikanOpen(true)}>
            订阅
          </Button>
          <Button
            variant={isFav ? 'soft' : 'outline'}
            icon={Heart}
            onClick={() => {
              toggleFavorite(view)
              toast.success(isFav ? '已取消收藏' : '已收藏')
            }}
          >
            {isFav ? '已收藏' : '收藏'}
          </Button>
          <Button
            variant={finalWatchedAt ? 'soft' : 'ghost'}
            icon={CircleCheck}
            onClick={() => {
              if (!isFav) {
                toast.info('请先收藏该番剧，再标记看完')
                return
              }
              toggleWatched(view.id)
              toast.success(finalWatchedAt ? '已取消看完标记' : '已标记为看完')
            }}
          >
            {finalWatchedAt ? '已看完' : '标记看完'}
          </Button>
          {finalWatchedAt ? (
            <label className="flex items-center gap-1.5 text-[11px] text-faint" title="修改看完时间">
              <CalendarDays size={13} />
              <input
                type="date"
                value={finishDateStr(finalWatchedAt)}
                onChange={(e) => {
                  const v = e.target.value
                  if (v) setWatchedAt(view.id, new Date(`${v}T12:00:00`).getTime())
                  else setWatchedAt(view.id, null)
                }}
                className="h-8 rounded-lg border border-border bg-elev1 px-2 text-[11px] text-dim outline-none focus:border-accent"
              />
            </label>
          ) : null}
        </motion.div>
      ) : null}

      {/*
        「选择数据源-选集界面」（v0.3.9）：三列级联同屏，取代原来的
        「选择播放源」+「在线播放」两级弹窗接力。
        人机验证仍然走同一个 VerifyModal（`onNeedVerify`），验证回来后带上那条线路重新打开本页。
      */}
      <PlayerSourcePage
        open={ruleOpen}
        onClose={() => {
          setRuleOpen(false)
          setInitialRule(null)
        }}
        rules={rules}
        keyword={view?.name_cn || view?.name || ''}
        title={view?.name_cn || view?.name || '播放'}
        subjectId={view?.id}
        initialRule={initialRule}
        onNeedVerify={(rule) => {
          setRuleOpen(false)
          setVerify({ rule })
        }}
      />
      <VerifyModal
        open={!!verify}
        rule={verify?.rule ?? null}
        keyword={view?.name_cn || view?.name || ''}
        onClose={() => setVerify(null)}
        onPassed={() => {
          const r = verify?.rule ?? null
          setVerify(null)
          if (r) {
            toast.success('验证状态已保留，正在用这条线路重新搜索…')
            // 重新打开选集界面，并把这条线路预选中 → 用户直接落在「搜索结果」列
            void openRules(r)
          }
        }}
      />
      <MikanSelectModal
        open={mikanOpen}
        onClose={() => setMikanOpen(false)}
        keyword={view?.name_cn || view?.name || ''}
        subject={view ? { subjectId: view.id, name: view.name, nameCn: view.name_cn, cover: view.images?.large ?? '' } : null}
        onDone={() => {
          setMikanOpen(false)
          navigate('/subs')
        }}
      />
      {/* V1.5.1：本地播放的两个入口（自行选择文件 / 从本地库） */}
      <Modal open={localMenuOpen} onClose={() => setLocalMenuOpen(false)} title="本地播放" width={420}>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              setLocalMenuOpen(false)
              void playLocalFile()
            }}
            className="flex flex-col items-start gap-0.5 rounded-lg border border-border bg-elev2/50 px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-accent-soft"
          >
            <span className="text-xs font-medium text-text">自行选择文件播放</span>
            <span className="text-[11px] leading-relaxed text-faint">
              弹窗选一个视频文件；同文件夹里的其它视频会作为播放列表
            </span>
          </button>
          <button
            type="button"
            onClick={() => void playFromLocalLibrary()}
            className="flex flex-col items-start gap-0.5 rounded-lg border border-border bg-elev2/50 px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-accent-soft"
          >
            <span className="text-xs font-medium text-text">从本地库播放</span>
            <span className="text-[11px] leading-relaxed text-faint">
              直接使用「我的番剧库 → 本地库」里已下载的集数（没有下载时会提示）
            </span>
          </button>
        </div>
      </Modal>
    </div>
  )
}

// ---------------- 人机验证弹窗（v0.3.7，v1.1 改成应用内一体化） ----------------

/**
 * 站点要求人机验证时的应用内弹窗。
 *
 * ## 为什么中间必须是一块"洞"
 *
 * 验证本身是**真实的网页**，只能交给真实浏览器窗口去渲染 —— 不能用 iframe：
 * 这些站点的 `X-Frame-Options` / CSP `frame-ancestors` 会直接拒绝被嵌，塞进主窗口 DOM 只会白屏。
 * 所以外框是应用 UI，中间那块矩形报给主进程，由它开一个属于本窗口的子窗口盖在那里
 * （与播放页把探针网页视图摆在画面区域上是同一个手法）。
 *
 * ## v1.1 改了什么（用户：「优化一下验证窗口，可以使用我们的应用 UI」）
 *
 * ① **外框开始反映里面的真实状态**：以前中间永远是那句「验证窗口正在这里打开…」，
 *    页面明明已经 404/超时了那句话还在 —— 这就是"原生窗口与网页拼在一起"的割裂感。
 *    现在主进程把 did-start/stop/fail-load 转成事件推来（`ruleVerify.onState`），
 *    标题栏的状态点、进度条、失败原因、重试按钮全部由应用 UI 渲染。
 * ② **对齐用 ResizeObserver 而不是 800ms 轮询**：轮询最多会差 0.8 秒，
 *    用户拖窗口时能看到网页和框错位；ResizeObserver 是"尺寸真的变了才发"，既准又不刷屏。
 * ③ 按钮状态跟着状态走：加载失败时「我已完成验证」不该还能点（点了也没用），
 *    改成可点的「重新加载」。
 * ④ 外框留出一圈内边距 + 圆角，视觉上把子窗口收进弹窗内部，而不是两块拼在一起。
 *
 * 备注（v0.3.9）：判「这条消息是不是验证墙」的唯一实现在
 * `components/playerSource/sourceFailure.ts` 的 `isVerifyWall()`，这里不重复一份。
 */
function VerifyModal({
  open,
  rule,
  keyword,
  onClose,
  onPassed
}: {
  open: boolean
  rule: PlayRule | null
  keyword: string
  onClose: () => void
  onPassed: () => void
}) {
  const holeRef = useRef<HTMLDivElement>(null)
  /**
   * 验证页的真实加载状态（来自主进程）。
   * `null` = 还没收到第一条（刚打开的那一瞬间），UI 按「正在打开」处理。
   */
  const [vs, setVs] = useState<{
    status: 'loading' | 'loaded' | 'failed' | 'closed'
    progress: number
    error?: string
    host?: string
  } | null>(null)

  useEffect(() => {
    if (!open || !rule) return
    let alive = true
    setVs(null)
    const off = api.ruleVerify.onState((st) => {
      if (alive) setVs(st)
    })
    const sendBounds = (): void => {
      const r = holeRef.current?.getBoundingClientRect()
      if (!r || r.width < 50) return
      void api.ruleVerify.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    const hole = holeRef.current?.getBoundingClientRect()
    void api.ruleVerify
      .open(rule.id, keyword, {
        x: hole?.left ?? 0,
        y: hole?.top ?? 0,
        width: hole?.width ?? 720,
        height: hole?.height ?? 460
      })
      .then((r) => {
        if (!alive) return
        if (!r.ok) toast.error(`验证窗口打不开：${r.error}`)
        else if (!r.data.ok) toast.error(`验证窗口打不开：这条规则的搜索地址不可用`)
      })
    /*
     * 尺寸对齐：ResizeObserver（弹窗本身 + 那块洞）+ 窗口 resize 兜底。
     * 不再用 800ms 轮询 —— 轮询会慢半拍，拖动窗口时能明显看到错位。
     */
    const ro = new ResizeObserver(() => sendBounds())
    if (holeRef.current) ro.observe(holeRef.current)
    window.addEventListener('resize', sendBounds)
    return () => {
      alive = false
      off()
      ro.disconnect()
      window.removeEventListener('resize', sendBounds)
      void api.ruleVerify.close()
    }
  }, [open, rule, keyword])

  if (!open || !rule) return null

  const failed = vs?.status === 'failed'
  const loaded = vs?.status === 'loaded'
  const host = vs?.host ?? ''

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6">
      <div className="flex h-[86vh] w-[900px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-elev1 shadow-2xl">
        {/* ---------- 头部：标题 + 真实状态 ---------- */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  failed
                    ? 'bg-danger'
                    : loaded
                      ? 'bg-ok'
                      : vs?.status === 'closed'
                        ? 'bg-faint'
                        : 'animate-pulse bg-warn'
                }`}
              />
              <span className="text-sm font-semibold text-text">人机验证 · {rule.name}</span>
              <Badge tone={failed ? 'danger' : loaded ? 'ok' : 'neutral'}>
                {failed ? '加载失败' : loaded ? '已加载' : vs?.status === 'closed' ? '已关闭' : '正在加载'}
              </Badge>
              {host ? <span className="truncate text-[10.5px] text-faint">{host}</span> : null}
            </div>
            <div className="mt-1 text-[11px] leading-relaxed text-faint">
              {failed
                ? '验证页没能加载出来：这通常是站点自身不可用或被网络拦截。可以点右下角「重新加载」再试，或换一条线路。'
                : loaded
                  ? '请在下面的窗口里完成验证（滑块/点选等），完成后点「我已完成验证」。验证状态保存在本机会话里。'
                  : '正在打开这条线路的验证页，稍等一下；如果一直停在这里，说明站点响应很慢。'}
            </div>
          </div>
          <button
            className="shrink-0 rounded-md p-1 text-dim transition-colors hover:bg-elev2 hover:text-text"
            title="关闭验证（Esc）"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* ---------- 进度条：不确定进度（loading）→ 100%（loaded） ---------- */}
        <div className="h-1 shrink-0 overflow-hidden bg-elev2">
          <div
            className={`h-full transition-all duration-300 ${
              failed ? 'bg-danger' : loaded ? 'bg-ok' : 'animate-pulse bg-warn'
            }`}
            style={{ width: failed ? '100%' : loaded ? '100%' : vs ? '45%' : '15%' }}
          />
        </div>

        {/* ---------- 中间：真实网页（由主进程的子窗口盖在这块洞上） ---------- */}
        <div className="relative min-h-0 flex-1">
          {/*
            洞内留 3px 边距 + 圆角：子窗口是矩形原生窗口，没法自己画圆角；
            外框这一圈底色把这个矩形"收"进弹窗里，视觉上不再像两块拼接。
          */}
          <div ref={holeRef} className="absolute inset-3 overflow-hidden rounded-xl bg-black/85" />
          {/* 只有还没加载成功时才盖提示文字：加载成功后这里应该让位给真实网页 */}
          {!loaded ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-[11px] text-faint">
              {failed ? (
                <>
                  <span className="text-danger">✗ {vs?.error ?? '验证页加载失败'}</span>
                  <span>验证窗口是真实网页，加载失败时这里会一直空着；点「重新加载」重试。</span>
                </>
              ) : (
                <>
                  <Spinner size={16} />
                  <span>验证窗口正在这里打开…（外框是应用 UI，里面是站点真实页面）</span>
                </>
              )}
            </div>
          ) : null}
        </div>

        {/* ---------- 底部：说明 + 取消 / 重新加载 / 我已完成验证 ---------- */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
          <span className="min-w-0 text-[11px] leading-relaxed text-faint">
            验证过一次之后，本机再访问这条线路就不需要重复验证（Cookie 保存在应用的浏览器会话里）。
          </span>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            {failed ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void api.ruleVerify.reload().then((r) => {
                    if (!r.ok) toast.error(`重新加载失败：${r.error}`)
                  })
                }}
              >
                重新加载
              </Button>
            ) : null}
            <Button size="sm" icon={Play} disabled={failed} onClick={onPassed}>
              我已完成验证
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------- 蜜柑资源选择弹窗（方案 4.1） ----------------

function MikanSelectModal({
  open,
  onClose,
  keyword,
  subject,
  onDone
}: {
  open: boolean
  onClose: () => void
  keyword: string
  subject: { subjectId: number; name: string; nameCn: string; cover: string } | null
  onDone: () => void
}) {
  const [query, setQuery] = useState(keyword)
  const [items, setItems] = useState<MikanItem[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [picked, setPicked] = useState<MikanItem | null>(null)
  const [pickMode, setPickMode] = useState<'download' | 'subscribe'>('download')
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    if (open) {
      setQuery(keyword)
      setItems([])
      setSearched(false)
      if (keyword) void doSearch(keyword)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keyword])

  const doSearch = async (kw: string) => {
    if (!kw.trim()) return
    setSearching(true)
    const r = await api.mikan.search(kw.trim())
    setSearching(false)
    setSearched(true)
    if (r.ok) {
      setItems(r.data.items)
      if (r.data.items.length === 0) toast.info('蜜柑计划未搜索到相关资源')
      if (r.data.error) toast.warn(`搜索提示: ${r.data.error}`)
    } else {
      toast.error(r.error)
    }
  }

  const copyLink = (item: MikanItem) => {
    const link = item.magnet || item.torrentUrl || item.link
    if (!link) return
    void navigator.clipboard.writeText(link)
    toast.success('已复制下载链接')
  }

  const confirmAction = async () => {
    if (!picked || !subject) return
    if (pickMode === 'download') {
      /*
       * v0.2.4：「下载」按钮的语义是「仅下载这一条资源」，不再顺手创建订阅。
       * 过去这里走 subscribeAndDownload，用户只是想下载一集却被动多出一个订阅
       * （而且同一页面已经有独立的「订阅」按钮，语义重复）。
       * 现在改用纯下载接口：不传 subscriptionId，就不会建订阅、也不会改订阅状态。
       */
      const r = await api.downloads.add({
        subjectId: subject.subjectId,
        animeTitle: subject.nameCn || subject.name,
        episode: picked.episode,
        group: picked.group ?? null,
        name: picked.title,
        cover: subject.cover,
        magnet: picked.magnet ?? undefined,
        torrentUrl: picked.torrentUrl ?? undefined,
        pubDate: picked.pubDate
      })
      if (r.ok) {
        toast.success(`已加入下载：${picked.title}`)
        onDone()
      } else {
        toast.error(r.error)
      }
    } else {
      const r = await api.downloads.subscribeOnly({
        subjectId: subject.subjectId,
        name: subject.name,
        nameCn: subject.nameCn,
        cover: subject.cover,
        mikanItem: picked
      })
      if (r.ok) {
        toast.success(`已订阅《${subject.nameCn || subject.name}》的字幕组「${picked.group ?? '未识别'}」，更新时仅下载该字幕组资源`)
        onClose()
        /*
         * v0.3.5：订阅成功后**立刻拉一次「全部资源」**。
         *
         * 用户反馈：订阅时字幕组可能早就更到第 13 集了，但只有「他确认的那一条」被记进 lastPubDate，
         * 于是第 1~12 集永远不会再出现（日志：官方订阅RSS条目 39 → 命中 3）。
         * 订阅这个动作的语义应该是「这部番这个组的资源我都要」——所以这里直接跑一次 full 检测，
         * 把历史集数一并列进确认弹窗；已经下载过的资源由主进程的 handled() 排除，不会重复问。
         */
        void useSubs
          .getState()
          .checkSub(r.data.subscription.id, true)
          .then((u) => {
            if (u && u.newItems.length > 0) {
              toast.info(`该字幕组共有 ${u.newItems.length} 个资源可下载，请在订阅页确认`)
            }
          })
      } else {
        toast.error(r.error)
      }
    }
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title="订阅 · 选择资源（蜜柑计划）" width={640}>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSearch(query)
              }}
              placeholder="搜索番剧名（蜜柑计划）"
              className="h-9 w-full rounded-lg border border-border bg-elev2/60 pl-8 pr-3 text-sm outline-none focus:border-accent"
            />
          </div>
          <Button size="sm" loading={searching} onClick={() => void doSearch(query)}>
            搜索
          </Button>
        </div>
        <div className="mt-3 flex max-h-[46vh] flex-col gap-1.5 overflow-y-auto pr-1">
          {items.map((item) => (
            <div
              key={item.guid}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-elev2/50 px-3 py-2.5 transition-colors hover:border-accent"
            >
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[13px] leading-snug" title={item.title}>
                  {item.title}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-faint">
                  {item.group ? <span className="font-medium text-accent">{item.group}</span> : null}
                  {item.episode != null ? <span>第 {item.episode} 集</span> : null}
                  {item.resolution ? <span>{item.resolution}</span> : null}
                  <span>{item.size}</span>
                  {item.pubDate ? <span>{new Date(item.pubDate).toLocaleDateString('zh-CN')}</span> : null}
                </div>
              </div>
              <button
                onClick={() => copyLink(item)}
                title="复制下载链接"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-elev3 hover:text-text"
              >
                <Copy size={13} />
              </button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPicked(item)
                  setPickMode('subscribe')
                  setConfirmOpen(true)
                }}
              >
                订阅
              </Button>
              <Button
                size="sm"
                variant="soft"
                icon={Download}
                onClick={() => {
                  setPicked(item)
                  setPickMode('download')
                  setConfirmOpen(true)
                }}
              >
                下载
              </Button>
            </div>
          ))}
          {searched && !searching && items.length === 0 ? (
            <EmptyState icon={Search} title="没有搜到资源" desc="换个关键词试试，或检查蜜柑计划是否可访问" />
          ) : null}
        </div>
        <div className="mt-3 text-[11px] leading-relaxed text-faint">
          选择字幕组资源后仅下载该资源，不会自动下载全部历史资源。
          <br />
          「下载」= 仅下载这一条资源（不创建订阅）；「订阅」= 仅追踪该字幕组，新资源检测到后经确认再下载。
        </div>
      </Modal>
      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={pickMode === 'download' ? '确认下载该资源' : '确认订阅字幕组'}
        confirmText={pickMode === 'download' ? '仅下载' : '仅订阅'}
        message={
          <div className="space-y-1.5">
            <div>
              番剧：<span className="text-text">{subject?.nameCn || subject?.name}</span>
            </div>
            <div className="break-all text-xs text-faint">{picked?.title}</div>
            <div className="text-xs">
              字幕组：{picked?.group ?? '未识别'} · 集数：
              {picked?.episode != null ? `第 ${picked.episode} 集` : '未知'}
            </div>
            <div className="text-xs text-faint">
              {pickMode === 'download'
                ? '仅把这一条资源加入下载队列，不会创建订阅（要跟番请用「订阅」按钮）。'
                : '仅创建订阅（不下载）。应用启动或手动检查时，若检测到该字幕组的新资源会提醒你确认下载。'}
            </div>
          </div>
        }
        onConfirm={() => void confirmAction()}
      />
    </>
  )
}

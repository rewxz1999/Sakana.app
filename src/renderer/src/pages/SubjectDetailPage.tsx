import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  CalendarDays,
  CircleCheck,
  CirclePlay,
  Clapperboard,
  Copy,
  Download,
  ExternalLink,
  FilePlay,
  Heart,
  Play,
  Rss,
  Search,
  Star,
  X
} from 'lucide-react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type {
  BatchProbeUpdate,
  EpisodeProgress,
  MikanItem,
  PlayRule,
  RuleEpisodeGroup,
  RuleSearchEntry,
  SubjectDetail
} from '@shared/types'
// 值导入（不是 type）：推荐名单与置顶排序都是运行时要用的，见来源选择弹窗里的用法
import { RECOMMENDED_RULES, sortRulesPinnedFirst } from '@shared/types'
import { api } from '@/lib/api'
import { useLibrary } from '@/stores/library'
import { useSubs } from '@/stores/subs'
import { toast } from '@/stores/app'
import { epKey, onlineKey, progressSummary, useWatchProgress } from '@/stores/watchProgress'
import { fmtDateTime } from '@/lib/format'
import { Badge, Button, ConfirmModal, EmptyState, Modal, ProgressBar, Spinner } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'


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

export function SubjectDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  /** 来源标记：搜索页以 navigate('/subject/:id', { state: { from: 'search' } }) 进入 */
  const fromSearch = (location.state as { from?: string } | null | undefined)?.from === 'search'
  const subjectId = Number(id)
  const [detail, setDetail] = useState<SubjectDetail | null>(null)
  /**
   * 「更新到第几集」（v0.3.7，用户要求）。
   * 单独一个请求（分集接口），失败/取不到就是 null —— 界面据此**整行不显示**。
   * 刻意不把它塞进 `detail`：详情接口 30 天缓存，而集数进度一周一变、还要 6 小时刷新一次，
   * 两者生命周期不同，混在一起会互相拖累。
   */
  const [epProgress, setEpProgress] = useState<EpisodeProgress | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState('')
  const [ruleOpen, setRuleOpen] = useState(false)
  const [mikanOpen, setMikanOpen] = useState(false)
  const [rules, setRules] = useState<PlayRule[]>([])
  const [playRule, setPlayRule] = useState<PlayRule | null>(null)
  /** 需要人机验证的那条规则（非空时弹出验证窗口，v0.3.7） */
  const [verify, setVerify] = useState<{ rule: PlayRule } | null>(null)
  /** 全屏状态（原生窗口全屏 / 页面级全屏）：全屏时返回按钮改为悬浮定位，避免贴边 */
  const [fullscreen, setFullscreen] = useState(false)
  /** 本地播放选择/扫描中（按钮 loading） */
  const [localBusy, setLocalBusy] = useState(false)
  const { favorites, toggleFavorite, toggleWatched, setWatchedAt, watchHistory } = useLibrary()
  const progressItems = useWatchProgress((s) => s.items)
  const progressLoaded = useWatchProgress((s) => s.loaded)
  const loadProgress = useWatchProgress((s) => s.load)

  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await api.bangumi.subject(subjectId)
      if (!alive) return
      if (r.ok && r.data.data) setDetail(r.data.data)
      else if (!r.ok) setFailed(r.error)
      else if (r.ok && r.data.error) setFailed(r.data.error.message)
      setLoading(false)
    })()
    /*
     * 集数进度与详情**并行**请求，谁先回来先渲染谁：
     * 分集接口是独立的一次请求（约 300ms），串行只会让详情页整体慢一拍。
     * 失败不置错、不弹提示 —— 这只是详情页的一个附加信息，不该因为它让整页显示「加载失败」。
     */
    void (async () => {
      const p = await api.bangumi.episodeProgress(subjectId)
      if (!alive) return
      setEpProgress(p.ok ? p.data : null)
    })()
    return () => {
      alive = false
    }
  }, [subjectId])

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
    () => progressSummary(progressItems, { subjectId, title: detail?.name_cn || detail?.name }),
    [progressItems, subjectId, detail]
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
  const playerTitle = detail?.name_cn || detail?.name || '本地播放'

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

  const fav = detail ? favorites.find((f) => f.subjectId === detail.id) : null
  const isFav = !!fav
  // 已看完：手动标记时间，或自动判定的最后观看时间
  const watchedAt = fav?.watchedAt ?? null
  const autoWatchedAt = (() => {
    if (watchedAt) return null
    if (fav?.eps && fav.eps > 0) {
      const eps = new Set<number>()
      for (const h of watchHistory) {
        if (h.subjectId === detail?.id && h.episode != null) eps.add(h.episode)
      }
      if (eps.size >= fav.eps) {
        const last = watchHistory
          .filter((h) => h.subjectId === detail?.id)
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
    if (!detail) return { rows: [], rest: 0 }
    const rows = [...detail.infobox]
    // 数据源额外给的平台/总集数也补成一行（v0 的字段不在 infobox 里）
    if (detail.platform && !rows.some((r) => r.key === '平台')) rows.unshift({ key: '平台', value: detail.platform })
    if (detail.totalEpisodes && !rows.some((r) => r.key === '总集数'))
      rows.push({ key: '总集数', value: String(detail.totalEpisodes) })
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
  }, [detail])
  const [showAllInfo, setShowAllInfo] = useState(false)
  const infoShown = showAllInfo ? infoRows : infoRows.slice(0, 12)

  const openRules = async () => {
    const r = await api.store.get('rules')
    const list: PlayRule[] = r.ok && Array.isArray(r.data) ? (r.data as PlayRule[]) : []
    /*
     * v0.3.7：置顶顺序统一由 shared 的 PINNED_RULES 决定（用户要求 aafun / AGE / sorani 置顶）。
     *
     * 以前这里写死了一份 preferred 名单，只影响本弹窗 —— 于是「置顶」在规则管理页看不到，
     * 用户会以为置顶没生效。现在两处都调同一个 sortRulesPinnedFirst()。
     */
    const enabled = sortRulesPinnedFirst(list.filter((rule) => rule.enabled))
    setRules(enabled)
    if (enabled.length === 0) {
      toast.warn('暂无启用的播放规则，请先在「设置 → 规则管理」中添加')
    }
    setRuleOpen(true)
  }

  const pickRule = (rule: PlayRule) => {
    setRuleOpen(false)
    setPlayRule(rule)
  }

  /**
   * 从播放页退出回来时自动打开「播放源列表」（v0.2.4）。
   * 播放页退出时带 `state.openSources`，用户期望看到的是「换一条线路/规则继续看」，
   * 而不是回到详情页顶部再自己找按钮。
   */
  useEffect(() => {
    const st = location.state as { openSources?: boolean } | null
    if (!st?.openSources) return
    if (!detail) return // 等详情加载完再弹，否则没有番剧名可用于搜索
    void openRules()
    // 清掉标记，避免刷新/返回时再次弹出
    navigate(location.pathname, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, location.state])

  return (
    <div className="relative h-full overflow-y-auto">
      {/* 毛玻璃背景（方案 3.7） */}
      {detail?.images?.large ? (
        <div className="pointer-events-none fixed inset-0">
          <CoverImage src={detail.images.large} className="h-full w-full opacity-40 blur-2xl" />
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

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Spinner size={26} />
          </div>
        ) : failed ? (
          <EmptyState icon={CalendarDays} title="加载详情失败" desc={failed}>
            <Button size="sm" onClick={goBack}>
              返回
            </Button>
          </EmptyState>
        ) : detail ? (
          <>
            <div className="flex gap-6">
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-52 shrink-0"
              >
                <CoverImage
                  src={detail.images?.large ?? detail.images?.common ?? null}
                  className="aspect-[3/4] w-full rounded-xl shadow-xl shadow-black/25"
                />
              </motion.div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-3">
                  <div>
                    <h1 className="text-2xl font-bold leading-tight">{detail.name_cn || detail.name}</h1>
                    {detail.name_cn && detail.name !== detail.name_cn ? (
                      <div className="mt-0.5 text-sm text-faint">{detail.name}</div>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {detail.rating?.score ? (
                    <Badge tone="warn">
                      <Star size={11} fill="currentColor" /> {detail.rating.score.toFixed(1)}
                      {detail.rating.total ? ` · ${detail.rating.total} 人评分` : ''}
                    </Badge>
                  ) : null}
                  {detail.air_date ? (
                    <Badge tone="accent">
                      <CalendarDays size={11} /> {detail.air_date}
                    </Badge>
                  ) : null}
                  {detail.eps != null ? <Badge>全 {detail.eps} 话</Badge> : null}
                  {/*
                    「更新到第几集」（v0.3.7）：数据来自分集接口每集的放送日期，数出来的真值。
                    · 还在播：显示「更新至 第 N 集」（有下一集日期时补一句「下集 MM-DD」）；
                    · 已播完：显示「已完结 · 共 N 集」（和上面的「全 X 话」不重复 ——
                      那个是 bangumi 登记的计划集数，这个是真的播完了）。
                    取不到进度（离线 / 兜底数据源 / 没登记分集）时整块不渲染，不显示 0。
                  */}
                  {epProgress && epProgress.aired > 0 ? (
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
                  {detail.tags.slice(0, 6).map((t) => (
                    <Badge key={t.name}>{t.name}</Badge>
                  ))}
                </div>
                {/* 观看进度（无记录时不显示） */}
                {progress.item ? (
                  <div className="mt-3 flex items-center gap-2 text-[11px] text-dim">
                    <CirclePlay size={12} className="shrink-0 text-accent" />
                    <span>{progressText(progress)}</span>
                    {progress.percent > 0 ? <ProgressBar value={progress.percent} className="w-24" /> : null}
                  </div>
                ) : null}
                <p className="mt-4 max-h-44 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-dim">
                  {detail.summary || '暂无简介'}
                </p>
              </div>
            </div>

            {infoRows.length > 0 ? (
              <div className="mt-6 rounded-xl border border-border bg-elev1/80 p-4 backdrop-blur">
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
            ) : null}
          </>
        ) : null}
      </div>

      {/* 左下角操作按钮（方案 3.7） */}
      {detail ? (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="fixed bottom-6 left-[212px] z-30 flex max-w-[calc(100vw-15rem)] flex-wrap items-center gap-2.5 rounded-2xl border border-border bg-elev1/90 px-4 py-3 shadow-xl backdrop-blur"
        >
          <Button icon={Play} onClick={() => void openRules()}>
            播放
          </Button>
          <Button
            variant="soft"
            icon={FilePlay}
            loading={localBusy}
            title="选择一个本地视频文件播放（同文件夹内的其它视频会作为播放列表）"
            onClick={() => void playLocalFile()}
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
              toggleFavorite(detail)
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
              toggleWatched(detail.id)
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
                  if (v) setWatchedAt(detail.id, new Date(`${v}T12:00:00`).getTime())
                  else setWatchedAt(detail.id, null)
                }}
                className="h-8 rounded-lg border border-border bg-elev1 px-2 text-[11px] text-dim outline-none focus:border-accent"
              />
            </label>
          ) : null}
        </motion.div>
      ) : null}

      <RuleSelectModal
        open={ruleOpen}
        onClose={() => setRuleOpen(false)}
        rules={rules}
        keyword={detail?.name_cn || detail?.name || ''}
        /* 探针判定这条线路要人机验证时，点它就先把验证过了再进搜索（v0.3.7） */
        onNeedVerify={(rule) => {
          setRuleOpen(false)
          setVerify({ rule })
        }}
        onPick={pickRule}
      />
      <RulePlayModal
        open={!!playRule}
        onClose={() => setPlayRule(null)}
        rule={playRule}
        keyword={detail?.name_cn || detail?.name || ''}
        title={detail?.name_cn || detail?.name || '播放'}
        subjectId={detail?.id}
        /* 搜索结果报「人机验证」时，给用户一个现场过验证的出口（v0.3.7） */
        onNeedVerify={(rule) => {
          setPlayRule(null)
          setVerify({ rule })
        }}
      />
      <VerifyModal
        open={!!verify}
        rule={verify?.rule ?? null}
        keyword={detail?.name_cn || detail?.name || ''}
        onClose={() => setVerify(null)}
        onPassed={() => {
          const r = verify?.rule ?? null
          setVerify(null)
          if (r) {
            toast.success('验证状态已保留，正在用这条线路重新搜索…')
            setPlayRule(r)
          }
        }}
      />
      <MikanSelectModal
        open={mikanOpen}
        onClose={() => setMikanOpen(false)}
        keyword={detail?.name_cn || detail?.name || ''}
        subject={detail ? { subjectId: detail.id, name: detail.name, nameCn: detail.name_cn, cover: detail.images?.large ?? '' } : null}
        onDone={() => {
          setMikanOpen(false)
          navigate('/subs')
        }}
      />
    </div>
  )
}

// ---------------- 人机验证弹窗（v0.3.7） ----------------

/**
 * 站点要求人机验证时的应用内弹窗。
 *
 * 为什么做成"蒙层 + 中间一块洞"：验证本身就是**真实的网页**，只能交给真实的浏览器窗口去渲染。
 * 所以这里弹一层说明蒙层，把中间那块矩形报给主进程，主进程开一个属于本窗口的子窗口盖在那里
 * （与播放页把探针网页视图摆在画面区域上是同一个手法）。
 * 用户过完验证点「继续」，那之后这条线路就带上验证 Cookie 了（主进程用同一个会话）。
 */
function VerifyNeedles(): RegExp {
  return /人机验证|安全验证|验证码|403|forbidden/i
}

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

  useEffect(() => {
    if (!open || !rule) return
    let alive = true
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
    // 窗口尺寸/蒙层大小变化时让验证窗口跟着走（节流到 800ms，够用且不刷屏）
    const timer = window.setInterval(sendBounds, 800)
    window.addEventListener('resize', sendBounds)
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('resize', sendBounds)
      void api.ruleVerify.close()
    }
  }, [open, rule, keyword])

  if (!open || !rule) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6">
      <div className="flex h-[86vh] w-[860px] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-elev1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text">需要人机验证 · {rule.name}</div>
            <div className="mt-0.5 text-[11px] text-faint">
              这条线路要求先通过人机验证（站点对我们返回了验证页）。请在下面的窗口里完成验证，
              然后点「我已完成验证」。验证状态保存在本机会话里，之后这条线路可以正常搜索与播放。
            </div>
          </div>
          <button className="rounded-md p-1 text-dim hover:bg-elev2 hover:text-text" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {/* 这块空白处由主进程的验证窗口盖住；边框只是为了让用户知道窗口应该出现在这里 */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={holeRef}
            className="absolute inset-3 rounded-lg border border-dashed border-border bg-elev2/40"
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-faint">
            验证窗口正在这里打开…
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
          <span className="text-[11px] leading-relaxed text-faint">
            提示：验证过一次之后，本机再访问这条线路就不需要重复验证。
            若窗口里一直加载不出来，可能是站点本身不可用，换一条线路即可。
          </span>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button size="sm" icon={Play} onClick={onPassed}>
              我已完成验证
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------- 规则选择弹窗（方案 5.1） ----------------

function RuleSelectModal({
  open,
  onClose,
  rules,
  keyword,
  onPick,
  onNeedVerify
}: {
  open: boolean
  onClose: () => void
  rules: PlayRule[]
  /** 用来预嗅探的关键词（番剧名）：弹窗一打开就按它逐条探测各线路有没有资源 */
  keyword: string
  onPick: (rule: PlayRule) => void
  /** 探针判定这条线路需要人机验证时，先让用户去验证（v0.3.7） */
  onNeedVerify: (rule: PlayRule) => void
}) {
  /**
   * 每条规则的探测结果（v0.3.7）。
   *
   * 用户要求「在选择播放源页就自动加载所有规则下是否嗅探到资源、嗅探到多少资源」——
   * 以前这里只有规则的静态元数据（版本/类型/baseUrl），哪条能播全靠用户一条条点进去试，
   * 试错成本极高（尤其某些线路根本没有这部番，点进去只会得到"未搜索到"）。
   */
  const [probe, setProbe] = useState<Record<string, BatchProbeUpdate>>({})
  /** 本批探测是吃缓存还是真跑；以及缓存时间（界面要如实说明结果有多旧） */
  const [probeMeta, setProbeMeta] = useState<{ cached: boolean; probedAt?: number; running: boolean }>({
    cached: false,
    running: false
  })
  useEffect(() => {
    if (!open || !keyword || rules.length === 0) return
    let alive = true
    setProbe({})
    // 先订阅再启动：批量任务是逐条推的，订阅晚一步就会漏掉第一条的结果
    const off = api.ruleBatchProbe.onUpdate((ev) => {
      if (!alive) return
      setProbe((prev) => ({ ...prev, [ev.ruleId]: ev }))
    })
    void runProbe(false)
    return () => {
      alive = false
      off()
      // 关掉弹窗就停探测：批量探测会开真实窗口访问站点，不该在用户离开后继续跑
      void api.ruleBatchProbe.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keyword, rules])

  /**
   * 发起一批探测（v0.3.7 加缓存）。
   *
   * `force=false` 时主进程会先看 30 分钟内的结果缓存 —— 命中就直接回放，
   * 不开窗口、不打扰站点；用户想拿最新结论时点「重新探测」（force=true）。
   */
  const runProbe = async (force: boolean): Promise<void> => {
    if (force) setProbe({})
    setProbeMeta({ cached: false, running: true })
    const r = await api.ruleBatchProbe.start({
      keyword,
      rules: rules.map((x) => ({ id: x.id, name: x.name, baseUrl: x.baseUrl })),
      force
    })
    setProbeMeta({
      cached: r.ok ? r.data.cached : false,
      probedAt: r.ok ? r.data.probedAt : undefined,
      running: !(r.ok && r.data.cached)
    })
  }

  /** 把一条规则的结果翻成一句人话 + 颜色（三种"没资源"要分得清，见 BatchProbeUpdate 的说明） */
  const probeBadge = (ruleId: string): React.ReactElement => {
    const p = probe[ruleId]
    if (!p) return <Badge tone="neutral">待探测</Badge>
    if (p.phase === 'search') return <Badge tone="neutral">搜索中…</Badge>
    if (p.phase === 'sniff') return <Badge tone="neutral">嗅探中…</Badge>
    if (p.count > 0) return <Badge tone="ok">命中 {p.count} 个资源</Badge>
    if (p.hit && p.episodes > 0) return <Badge tone="warn">有剧集·未抓到流</Badge>
    if (p.hit) return <Badge tone="neutral">有番剧·无剧集</Badge>
    return <Badge tone="neutral">没有这部番</Badge>
  }

  return (
    <Modal open={open} onClose={onClose} title="选择播放源" width={460}>
      {rules.length === 0 ? (
        <EmptyState
          icon={Clapperboard}
          title="暂无可用播放规则"
          desc="在「设置 → 规则管理」中添加播放规则（Kazumi 风格），即可在线播放"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {rules.map((rule, i) => {
            /*
             * 推荐标记（v0.3.6）：名单收敛到 `@shared/types` 的 `RECOMMENDED_RULES`
             * （产品指定 aafun / sorani）。
             * 老实现是 `/^(aafun|akianime|mxdm)$/i.test(...) || i < 3` ——
             * 那个 `|| i < 3` 会让**前三条一律标推荐**（哪怕它是搜不到的站），
             * 等于推荐位被"列表顺序"而不是"可用性"决定，用户按推荐点进去常常搜不到番。
             * 现在只认名单，名单里没有就老老实实不标。
             */
            const recommended = RECOMMENDED_RULES.includes(rule.name.toLowerCase())
            void i
            const p = probe[rule.id]
            /*
             * 探针说这条线路「需要人机验证」时（消息里带 403/验证字样），
             * 点它就先弹验证窗口 —— 直接进去只会再吃一次 403，用户会以为是"这条线路坏了"（v0.3.7）。
             */
            const needVerify = !!p && (p.count === 0 || p.hit) && VerifyNeedles().test(p.message ?? '')
            return (
              <button
                key={rule.id}
                onClick={() => (needVerify ? onNeedVerify(rule) : onPick(rule))}
                /* 探测详情挂在 title 上：一句"为什么没资源"比一个灰徽章有用得多 */
                title={p?.message}
                className="flex items-center justify-between rounded-xl border border-border bg-elev2/60 px-4 py-3 text-left transition-colors hover:border-accent hover:bg-accent-soft"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{rule.name}</span>
                    <Badge tone="neutral">v{rule.version}</Badge>
                    <Badge tone="accent">{rule.search.type === 'xpath' ? 'XPath' : 'API'}</Badge>
                    {recommended ? <Badge tone="ok">推荐</Badge> : null}
                    {/* v0.3.7：这条线路有没有资源（自动预嗅探的结果） */}
                    {probeBadge(rule.id)}
                    {needVerify ? <Badge tone="warn">需人机验证</Badge> : null}
                  </div>
                  <div className="mt-0.5 max-w-[320px] truncate text-[11px] text-faint">
                    {p?.phase === 'done' && p.message ? p.message : rule.baseUrl}
                  </div>
                </div>
                <Play size={15} className="shrink-0 text-accent" />
              </button>
            )
          })}
          <div className="mt-1 flex items-start justify-between gap-3 text-[10px] leading-relaxed text-faint">
            <span>
              提示：打开这张列表时会自动探测各线路有没有资源（「命中 N 个资源」= 抓到 N 个候选视频地址）。
              {probeMeta.cached && probeMeta.probedAt
                ? ` 当前显示的是 ${new Date(probeMeta.probedAt).toLocaleTimeString()} 的探测结果（30 分钟内不重复探测）。`
                : ' 探测只做搜索与嗅探、不会播放。'}
            </span>
            <button
              className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[10px] text-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              disabled={probeMeta.running}
              onClick={() => void runProbe(true)}
            >
              {probeMeta.running ? '探测中…' : '重新探测'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ---------------- 规则播放弹窗：搜索 → 选集 → 播放 ----------------

function RulePlayModal({
  open,
  onClose,
  rule,
  keyword,
  title,
  subjectId,
  onNeedVerify
}: {
  open: boolean
  onClose: () => void
  rule: PlayRule | null
  keyword: string
  title: string
  subjectId?: number
  /** 搜索被站点的人机验证挡住时，交给上层弹验证窗口（v0.3.7） */
  onNeedVerify: (rule: PlayRule) => void
}) {
  const navigate = useNavigate()
  const [results, setResults] = useState<RuleSearchEntry[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [entry, setEntry] = useState<RuleSearchEntry | null>(null)
  const [groups, setGroups] = useState<RuleEpisodeGroup[]>([])
  const [vars, setVars] = useState<Record<string, string>>({})
  const [loadingEps, setLoadingEps] = useState(false)
  const [lineIndex, setLineIndex] = useState(0)
  const [manualKw, setManualKw] = useState(keyword)
  const progressItems = useWatchProgress((s) => s.items)

  /** 当前条目的观看进度键：规则 + 条目链接（watchProgress store 的在线约定） */
  const progressKey = rule && entry ? onlineKey(rule.id, entry.link) : ''
  const progressItem = useMemo(
    () => (progressKey ? progressItems.find((i) => i.id === progressKey) ?? null : null),
    [progressItems, progressKey]
  )
  /** 已看集数键集合（`${groupIndex}:${episodeIndex}`，与下方剧集按钮的索引一致） */
  const watchedKeys = useMemo(() => new Set(progressItem?.watched ?? []), [progressItem])
  /** 上次观看的线路 / 集序号（-1 表示没有记录） */
  const lastLine = progressItem ? progressItem.groupIndex : -1
  const lastEp = progressItem ? progressItem.episodeIndex : -1
  const lastPercent =
    progressItem && progressItem.durationSec > 0
      ? Math.min(100, Math.round((progressItem.positionSec / progressItem.durationSec) * 100))
      : 0

  useEffect(() => {
    if (open && rule) {
      setResults([])
      setSearchError('')
      setEntry(null)
      setGroups([])
      setLineIndex(0)
      void doSearch(rule)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule?.id])

  const doSearch = async (r: PlayRule, overrideKeyword?: string) => {
    const kw = (overrideKeyword ?? manualKw).trim() || keyword
    setSearching(true)
    const res = await api.rules.search(r.id, kw)
    setSearching(false)
    if (res.ok) {
      setResults(res.data.items)
      if (res.data.error) setSearchError(res.data.error)
      else if (res.data.items.length === 0) setSearchError(`未搜索到「${kw}」相关条目，可手动修改关键词重试`)
    } else {
      setSearchError(res.error)
    }
  }

  /** 手动搜索：规则自动搜索无结果时，允许用户输入关键词重试 */
  const manualSearch = async () => {
    if (!rule) return
    const kw = manualKw.trim()
    if (!kw) {
      toast.warn('请输入搜索关键词')
      return
    }
    setEntry(null)
    await doSearch(rule, kw)
  }

  const doEpisodes = async (item: RuleSearchEntry) => {
    if (!rule) return
    setEntry(item)
    setLoadingEps(true)
    const res = await api.rules.episodes(rule.id, item)
    setLoadingEps(false)
    if (res.ok) {
      setGroups(res.data.groups)
      setVars(res.data.vars)
      setLineIndex(0)
      if (res.data.error) toast.warn(res.data.error)
    } else {
      toast.error(res.error)
    }
  }

  const doPlay = async (groupIdx: number, epIdx: number, episodeLink: string) => {
    if (!rule || !entry) return
    const res = await api.rules.play(rule.id, entry, groupIdx, epIdx, episodeLink, vars)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    /*
     * v0.2.7 附加（进入播放提速）：先去后台预取这一集的直链，再跳转播放器。
     * 跳转 + 播放页挂载大约要几百毫秒，而预取（抓播放页 HTML + 校验候选）刚好跑在这段时间里；
     * 播放器挂载后来查缓存时若预取还在飞会短暂等一下 —— 命中就完全跳过
     * 「建嗅探窗口 → 加载播放页 → 等站点播放器发请求」这 1.5~3 秒。
     */
    void api.rules.prefetchStream(rule.id, entry, groupIdx, epIdx, episodeLink, vars)
    /*
     * v0.2.8 附加：**同时预取这一集的弹幕**（用户建议：从规则页进入某一集播放时就把弹幕准备好）。
     * 弹幕要「搜索弹幕库 → 拉取弹幕」两步网络请求，正好利用跳转与播放页挂载这段时间；
     * 播放器随后取弹幕时直接命中缓存，几乎零等待。
     */
    void api.danmaku.prefetch(title, epIdx + 1)
    onClose()
    navigate('/player', {
      state: {
        mode: 'rule',
        title,
        url: res.data.url,
        subjectId,
        ruleId: rule.id,
        entry,
        vars,
        groups,
        referer: rule.baseUrl,
        /*
         * v0.2.7：必须把「当前是第几线路第几集」一并带进去。
         * 过去只带播放页地址，播放器内部 ruleCurrent 为 null 就默认按第 1 集算 ——
         * 于是用户在看第 3 集时左上角显示第 1 集，自动连播还会从第 1 集往后跳（用户反馈的「跳回第二集」）。
         */
        startLine: groupIdx,
        startEp: epIdx
      }
    })
  }

  /** 继续观看：切回上次观看的线路并直接播放那一集（复用 doPlay 的跳转逻辑） */
  const continueWatch = async (): Promise<void> => {
    const ep = groups[lastLine]?.episodes[lastEp]
    if (!ep) {
      toast.warn('上次观看的线路已不可用，请在剧集列表中选择')
      return
    }
    setLineIndex(lastLine)
    await doPlay(lastLine, lastEp, ep.link)
  }

  const group = groups[lineIndex] ?? null

  return (
    <Modal open={open} onClose={onClose} title={`在线播放 · ${rule?.name ?? ''}`} width={640}>
      {searching ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-dim">
          <Spinner /> 正在 {rule?.name} 搜索《{keyword}》…
        </div>
      ) : !entry ? (
        <div className="flex max-h-[52vh] flex-col gap-1.5 overflow-y-auto pr-1">
          {results.map((item) => (
            <button
              key={item.link + item.source}
              onClick={() => void doEpisodes(item)}
              className="flex items-center justify-between rounded-lg border border-border bg-elev2/50 px-3.5 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft"
            >
              <span className="line-clamp-2 flex-1 text-[13px]">{item.name || '（无名称）'}</span>
              <Play size={14} className="ml-2 shrink-0 text-accent" />
            </button>
          ))}
          {!searching && (searchError || results.length === 0) ? (
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-elev2/40 p-3.5">
              <div className="flex items-center gap-2 text-xs text-dim">
                <Search size={13} className="text-accent" />
                {searchError || '没有搜索结果'}
              </div>
              <div className="flex gap-2">
                <input
                  value={manualKw}
                  onChange={(e) => setManualKw(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void manualSearch()
                  }}
                  placeholder="手动输入番剧名称重新搜索…"
                  className="h-9 flex-1 rounded-lg border border-border bg-elev1 px-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-accent"
                />
                <Button size="sm" icon={Search} onClick={() => void manualSearch()}>
                  手动搜索
                </Button>
              </div>
              {/*
                人机验证出口（v0.3.7）：站点给非浏览器请求返回验证页时，
                界面上以前只有一句「403」，用户完全无从下手。
                这里给一个按钮，把这条线路的搜索页在应用内打开让用户自己过验证。
              */}
              {VerifyNeedles().test(searchError) && rule ? (
                <Button variant="outline" size="sm" icon={Play} onClick={() => onNeedVerify(rule)}>
                  这条线路需要人机验证 · 点这里去验证
                </Button>
              ) : null}
              <div className="text-[10px] leading-relaxed text-faint">
                提示：部分站点使用不同译名，可尝试日文原名、别名或去掉季数后缀。
              </div>
            </div>
          ) : null}
        </div>
      ) : loadingEps ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-dim">
          <Spinner /> 正在解析播放线路与剧集…
        </div>
      ) : (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEntry(null)}>
              ← 返回搜索结果
            </Button>
            <span className="line-clamp-1 text-xs text-dim">{entry.name}</span>
          </div>
          {groups.length > 1 ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {groups.map((g, i) => (
                <button
                  key={i}
                  onClick={() => setLineIndex(i)}
                  className={`rounded-lg px-2.5 py-1 text-[11px] transition-colors ${
                    i === lineIndex ? 'bg-accent-soft text-accent' : 'bg-elev2 text-dim hover:text-text'
                  } whitespace-nowrap `}
                >
                  {g.lineName ?? `线路 ${i + 1}`}
                </button>
              ))}
            </div>
          ) : null}
          {group && group.episodes.length > 0 ? (
            <div>
              {/* 继续观看：直接跳到上次观看的线路与集数 */}
              {progressItem && lastLine >= 0 && lastEp >= 0 ? (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft/50 px-3 py-2">
                  <Button size="sm" icon={CirclePlay} onClick={() => void continueWatch()}>
                    继续观看第 {lastEp + 1} 集
                  </Button>
                  <span className="text-[11px] text-dim">
                    已看 {watchedKeys.size} 集
                    {lastPercent > 0 ? ` · 上次进度 ${lastPercent}%` : ''}
                    {groups.length > 1 ? ` · 上次在第 ${lastLine + 1} 条线路` : ''}
                  </span>
                </div>
              ) : null}
              <div className="grid max-h-[42vh] grid-cols-5 gap-1.5 overflow-y-auto px-1.5 pb-1 pt-2 sm:grid-cols-6 md:grid-cols-8">
                {group.episodes.map((ep, i) => {
                  const seen = watchedKeys.has(epKey(lineIndex, i))
                  const isLast = lastLine === lineIndex && lastEp === i
                  return (
                    <button
                      key={i}
                      onClick={() => void doPlay(lineIndex, i, ep.link)}
                      className={`relative truncate rounded-lg border px-2 py-2 text-center text-[11px] transition-colors ${
                        isLast
                          ? 'border-accent bg-accent font-semibold text-white'
                          : seen
                            ? 'border-accent/60 bg-accent-soft font-medium text-accent'
                            : 'border-border bg-elev2/60 text-dim hover:border-accent hover:bg-accent-soft hover:text-accent'
                      }`}
                      title={isLast ? `${ep.name} · 上次看到这里` : seen ? `${ep.name} · 已看` : ep.name}
                    >
                      {ep.name || `第 ${i + 1} 集`}
                      {isLast ? (
                        <span className="absolute -right-1 -top-1 rounded-full bg-white px-1.5 py-px text-[9px] font-semibold text-accent shadow whitespace-nowrap">
                          继续
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <EmptyState icon={Clapperboard} title="未解析到剧集列表" desc="该规则可能已失效，请到规则配置页检查 XPath / JSONPath" />
          )}
          <div className="mt-3 flex items-center justify-between text-[11px] text-faint">
            <span>若播放页无法在应用内加载，可点右下角「在浏览器打开」</span>
            <a
              className="flex items-center gap-1 text-accent hover:underline"
              onClick={() => {
                if (rule) window.open(rule.baseUrl, '_blank')
              }}
            >
              <ExternalLink size={11} /> 打开站点
            </a>
          </div>
        </div>
      )}
    </Modal>
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

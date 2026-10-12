import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Clapperboard,
  ExternalLink,
  ListVideo,
  Play,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { BatchProbeUpdate, PlayRule, RuleEpisodeGroup, RuleSearchEntry } from '@shared/types'
// 值导入（不是 type）：推荐名单是运行时要用的
import { RECOMMENDED_RULES } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { epKey, onlineKey, useWatchProgress } from '@/stores/watchProgress'
import { Badge, Button, EmptyState, Spinner } from '@/components/ui'
import { classifySourceFailure, isVerifyWall, type SourceFailure } from './sourceFailure'

/**
 * 「选择数据源-选集界面」（v0.3.9）。
 *
 * ## 用户诉求（原话）
 *
 * 「在选择播放源界面点击播放源列表后，自动在该列表右侧弹出附属结果列表，再次点击
 *  （结果列表里的）再由结果列表继续在右侧弹出选集列表，这下我们就将 选择播放源—选择结果—选择集数
 *  这一过程放在了一个页面中，这个页面就叫做 选择数据源-选集界面。」
 *
 * 旧实现是**两级弹窗接力**：`RuleSelectModal`（选源）关掉之后才 `RulePlayModal`（搜索→选集）
 * 打开。两个问题：① 换源必须退回到第一级、重新走一遍；② 用户看不到"我是在哪条线路的哪个结果下"，
 * 因为上一级已经没了。这里改成**三列级联**，三列始终同屏、每列各自滚动、选中态一路可见。
 *
 * ## 为什么是「整屏浮层」而不是新路由
 *
 * 它需要的是**一页内的三列**（诉求 1），而不是一个可以被深链的独立页面；同时它必须能
 * "逐级收起"回到番剧详情（诉求 2），所以做成盖在详情页上的整屏浮层最贴合。
 * 走新路由的话，返回键语义、`openSources`（播放页退出回来要重新打开选源列表）以及
 * 详情页自身的 Esc 处理都要跟着改，改动面远大于收益。组件名仍按工单叫 `PlayerSourcePage`。
 *
 * 层级用 `z-[65]`：必须在人机验证弹窗（`VerifyModal`，z-[70]）**下面**——验证是真实子窗口
 * 盖在弹窗中间那块洞上的，浮层若压在它上面，用户就看不到自己在验证什么。
 *
 * ## 窄窗口的取舍（诉求 3）
 *
 * 三列在 900px 以下根本排不开（挤成三根条，标题全被截断）。实测 `< 960px` 时改成
 * **两栏 + 抽屉**：左列仍是播放源，右栏显示"当前层级"——没选结果时是结果列表，
 * 选了结果就换成选集列表（选集列带「← 返回结果」）。牺牲的是"三列同屏对比"，
 * 换来的是每一列都读得清、点得准。三列同屏只在窗口够宽时提供。
 *
 * ## 与既有能力的边界（诉求 4）
 *
 * · 批量预嗅探（`ruleBatchProbe`）：原样搬过来（订阅 / 重探 / 关闭即停），命中数与原因仍挂在源条目上；
 * · 置顶顺序：由调用方 `sortRulesPinnedFirst()` 排好再传进来，这里不重排、不改名；
 * · 人机验证：仍然走调用方的 `onNeedVerify`（同一个 `VerifyModal`），判据与主进程同源；
 * · 播放链路：**完全复用** `api.rules.play` + `/player` 的 navigate 参数（一个字段都没动），
 *   因此「点集数后换源换集自动重新投屏」等播放器内部逻辑不受影响。
 */

/** 三列同屏所需的最小宽度；低于它就退回「两栏 + 抽屉」（见文件头说明） */
const WIDE_MIN_PX = 960

interface PlayerSourcePageProps {
  open: boolean
  onClose: () => void
  /** 已启用且已按置顶顺序排好的规则（调用方负责过滤与排序） */
  rules: PlayRule[]
  /** 用来搜索的关键词（番剧中文名优先，回落原名） */
  keyword: string
  /** 番剧标题（播放页 title 与弹幕预取用） */
  title: string
  subjectId?: number
  /**
   * 指定后自动选中这条线路并立刻搜索（v0.3.7 的人机验证回来路径：
   * 过完验证要"用这条线路重新搜索"，而不是让用户自己再点一次）。
   */
  initialRule?: PlayRule | null
  /** 判定需要人机验证时，交给上层弹验证窗口 */
  onNeedVerify: (rule: PlayRule) => void
}

type Col = 0 | 1 | 2

export function PlayerSourcePage({
  open,
  onClose,
  rules,
  keyword,
  title,
  subjectId,
  initialRule,
  onNeedVerify
}: PlayerSourcePageProps) {
  const navigate = useNavigate()
  const progressItems = useWatchProgress((s) => s.items)

  // ---------- 左列：批量预嗅探结果（v0.3.7 的能力，原样保留） ----------
  const [probe, setProbe] = useState<Record<string, BatchProbeUpdate>>({})
  const [probeMeta, setProbeMeta] = useState<{ cached: boolean; probedAt?: number; started: boolean }>({
    cached: false,
    started: false
  })
  /**
   * 探测"卡死"的兜底（v0.3.9 修）。
   *
   * 旧实现把 `running` 设成"start() 没命中缓存就是 true"，之后再也没人把它改回 false ——
   * 于是只要这一批里有一条规则永远不出结果（主进程 150 秒预算到点会直接取消剩余规则，
   * 那些规则不会收到 'done'），「重新探测」按钮就**永久变灰**，用户只能关掉页面重开。
   * 现在 running 由"每条规则是否都出了结果"推导，再加一个比主进程预算略长的硬超时兜底。
   */
  const [probeExpired, setProbeExpired] = useState(false)

  // ---------- 中列：某条线路在这个关键词下的搜索结果 ----------
  const [activeRule, setActiveRule] = useState<PlayRule | null>(null)
  const [results, setResults] = useState<RuleSearchEntry[]>([])
  const [searching, setSearching] = useState(false)
  const [searchFailure, setSearchFailure] = useState<SourceFailure | null>(null)
  const [manualKw, setManualKw] = useState(keyword)

  // ---------- 右列：某个结果的剧集（按线路分组） ----------
  const [entry, setEntry] = useState<RuleSearchEntry | null>(null)
  const [groups, setGroups] = useState<RuleEpisodeGroup[]>([])
  const [vars, setVars] = useState<Record<string, string>>({})
  const [loadingEps, setLoadingEps] = useState(false)
  const [epsFailure, setEpsFailure] = useState<SourceFailure | null>(null)
  const [lineIndex, setLineIndex] = useState(0)
  /** 点集数后到跳转前的那一小段：禁用重复点击，并给出"正在解析播放地址"的指示 */
  const [starting, setStarting] = useState(false)

  // ---------- 交互状态 ----------
  /**
   * 键盘焦点：`col` 是 0/1/2（源 / 结果 / 选集），`idx` 是该列内的行号。
   * 上下键只在一列内移动、回车在当前列确认（= 鼠标单击同一件事），
   * 左右键换列。这样"三列级联"用键盘也能完整走通，不必去够鼠标。
   */
  const [kb, setKb] = useState<{ col: Col; idx: number }>({ col: 0, idx: 0 })
  const [narrow, setNarrow] = useState(false)

  /**
   * 请求序号：换线路 / 换结果 / 收起时都会 +1。
   * 迟到的响应一律丢弃 —— 否则"先点 aafun、再点 AGE，AGE 先返回"时，
   * aafun 的结果会盖在 AGE 的结果列表上（诉求 2 的"别残留串台"就是这件事）。
   */
  const searchSeq = useRef(0)
  const epsSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 键盘处理函数每次都换成最新一份，避免把一长串依赖塞进事件订阅 */
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => undefined)

  const group = groups[lineIndex] ?? null
  const epList = group?.episodes ?? []

  /** 当前条目的观看进度（与旧弹窗同一套 onlineKey 约定，进度不会因为换界面而丢） */
  const progressKey = activeRule && entry ? onlineKey(activeRule.id, entry.link) : ''
  const progressItem = useMemo(
    () => (progressKey ? progressItems.find((i) => i.id === progressKey) ?? null : null),
    [progressItems, progressKey]
  )
  const watchedKeys = useMemo(() => new Set(progressItem?.watched ?? []), [progressItem])
  const lastLine = progressItem ? progressItem.groupIndex : -1
  const lastEp = progressItem ? progressItem.episodeIndex : -1
  const lastPercent =
    progressItem && progressItem.durationSec > 0
      ? Math.min(100, Math.round((progressItem.positionSec / progressItem.durationSec) * 100))
      : 0

  // ---------------- 1) 窗口宽度 → 三列 or 两栏 ----------------
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${WIDE_MIN_PX - 1}px)`)
    const apply = (): void => setNarrow(mql.matches)
    apply()
    mql.addEventListener('change', apply)
    return () => mql.removeEventListener('change', apply)
  }, [])

  // ---------------- 2) 打开即重置（每次进来都是干净的"源 → 结果 → 选集"） ----------------
  useEffect(() => {
    if (!open) return
    searchSeq.current++
    epsSeq.current++
    setActiveRule(null)
    setResults([])
    setSearching(false)
    setSearchFailure(null)
    setManualKw(keyword)
    setEntry(null)
    setGroups([])
    setVars({})
    setLoadingEps(false)
    setEpsFailure(null)
    setLineIndex(0)
    setStarting(false)
    setKb({ col: 0, idx: 0 })
  }, [open, keyword])

  // ---------------- 3) 批量预嗅探：打开就探，关掉就停 ----------------
  useEffect(() => {
    if (!open || !keyword || rules.length === 0) return
    let alive = true
    setProbe({})
    // 先订阅再启动：批量任务是逐条推的，订阅晚一步就会漏掉第一条的结果
    const off = api.ruleBatchProbe.onUpdate((ev) => {
      if (!alive) return
      setProbe((prev) => ({ ...prev, [ev.ruleId]: ev }))
    })
    void runProbe(false, rules)
    return () => {
      alive = false
      off()
      // 关掉界面就停探测：批量探测会开真实窗口访问站点，不该在用户离开后继续跑
      void api.ruleBatchProbe.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keyword, rules])

  /**
   * 发起一批探测（v0.3.7 的缓存语义原样保留）。
   * `force=false` 时主进程先看 30 分钟内的结果缓存 —— 命中就直接回放，
   * 不开窗口、不打扰站点；用户想拿最新结论时点「重新探测」（force=true）。
   */
  const runProbe = async (force: boolean, list: PlayRule[]): Promise<void> => {
    if (force) setProbe({})
    setProbeExpired(false)
    setProbeMeta({ cached: false, probedAt: undefined, started: true })
    const r = await api.ruleBatchProbe.start({
      keyword,
      rules: list.map((x) => ({ id: x.id, name: x.name, baseUrl: x.baseUrl })),
      force
    })
    setProbeMeta({
      cached: r.ok ? r.data.cached : false,
      probedAt: r.ok ? r.data.probedAt : undefined,
      started: !(r.ok && r.data.cached)
    })
  }

  /** 这一批里已经出结果的条数 / 是否全部出结果（running 由它推导，见 probeExpired 的说明） */
  const probeDoneCount = rules.filter((r) => probe[r.id]?.phase === 'done').length
  const probeAllDone = rules.length > 0 && probeDoneCount >= rules.length
  const probing = probeMeta.started && !probeAllDone && !probeExpired

  // 硬超时：比主进程的 150 秒任务预算略长一点（到点后剩余规则不会再回消息了）
  useEffect(() => {
    if (!probeMeta.started || probeAllDone || probeExpired) return
    const t = window.setTimeout(() => setProbeExpired(true), 165_000)
    return () => window.clearTimeout(t)
  }, [probeMeta.started, probeAllDone, probeExpired])

  // ---------------- 4) 人机验证回来后自动选中那条线路并重新搜索 ----------------
  useEffect(() => {
    if (!open || !initialRule) return
    const rule = rules.find((r) => r.id === initialRule.id) ?? initialRule
    setActiveRule(rule)
    setResults([])
    setEntry(null)
    setGroups([])
    setLineIndex(0)
    setKb({ col: 1, idx: 0 })
    void runSearch(rule)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialRule?.id])

  // ---------------- 5) 搜索 / 取集 ----------------

  /** 搜索某条线路；结果只认最后一次（见 searchSeq 的说明） */
  const runSearch = async (rule: PlayRule, kwOverride?: string): Promise<void> => {
    const kw = (kwOverride ?? manualKw).trim() || keyword
    const seq = ++searchSeq.current
    setSearching(true)
    setSearchFailure(null)
    const res = await api.rules.search(rule.id, kw)
    if (seq !== searchSeq.current) return
    setSearching(false)
    if (!res.ok) {
      setResults([])
      setSearchFailure(classifySourceFailure(res.error, 'search'))
      return
    }
    setResults(res.data.items)
    if (res.data.error) setSearchFailure(classifySourceFailure(res.data.error, 'search'))
    else if (res.data.items.length === 0) setSearchFailure(classifySourceFailure('', 'search'))
    else setSearchFailure(null)
  }

  /** 取某个搜索结果的剧集；同样只认最后一次 */
  const runEpisodes = async (rule: PlayRule, item: RuleSearchEntry): Promise<void> => {
    const seq = ++epsSeq.current
    setLoadingEps(true)
    setEpsFailure(null)
    const res = await api.rules.episodes(rule.id, item)
    if (seq !== epsSeq.current) return
    setLoadingEps(false)
    if (!res.ok) {
      setGroups([])
      setEpsFailure(classifySourceFailure(res.error, 'episodes'))
      return
    }
    setGroups(res.data.groups)
    setVars(res.data.vars)
    setLineIndex(0)
    // 主进程可能"有剧集但也有 error"（例如网页内兜底才解析出来一部分）：如实展示，不吞
    if (res.data.error) setEpsFailure(classifySourceFailure(res.data.error, 'episodes'))
    else if (res.data.groups.length === 0) setEpsFailure(classifySourceFailure('', 'episodes'))
    else setEpsFailure(null)
  }

  // ---------------- 6) 三级操作（点已选中的一级 = 收起它右边的内容） ----------------

  const selectRule = (rule: PlayRule, idx: number): void => {
    if (activeRule?.id === rule.id) {
      // 再点一次已选中的源 → 收起右边两列（诉求 2：逐级回退，不要整页跳走）
      searchSeq.current++
      epsSeq.current++
      setActiveRule(null)
      setResults([])
      setSearching(false)
      setSearchFailure(null)
      setEntry(null)
      setGroups([])
      setEpsFailure(null)
      setKb({ col: 0, idx })
      return
    }
    // 换源：**先把上一次的结果清空**，否则新线路还没返回时右列还挂着上一条线路的结果
    searchSeq.current++
    epsSeq.current++
    setActiveRule(rule)
    setResults([])
    setSearching(true)
    setSearchFailure(null)
    setEntry(null)
    setGroups([])
    setVars({})
    setEpsFailure(null)
    setLineIndex(0)
    setKb({ col: 1, idx: 0 })
    void runSearch(rule)
  }

  const sameEntry = (a: RuleSearchEntry | null, b: RuleSearchEntry): boolean =>
    !!a && a.link === b.link && a.source === b.source

  const selectEntry = (item: RuleSearchEntry, idx: number): void => {
    if (!activeRule) return
    if (sameEntry(entry, item)) {
      // 再点一次已选中的结果 → 收起选集列
      epsSeq.current++
      setEntry(null)
      setGroups([])
      setEpsFailure(null)
      setKb({ col: 1, idx })
      return
    }
    epsSeq.current++
    setEntry(item)
    setGroups([])
    setVars({})
    setEpsFailure(null)
    setLineIndex(0)
    setKb({ col: 2, idx: 0 })
    void runEpisodes(activeRule, item)
  }

  /**
   * 点某一集 → 直接进入播放。
   *
   * 这一段**逐字沿用**旧弹窗的播放链路（`api.rules.play` → 预取直链 → 预取弹幕 →
   * `navigate('/player')`，state 字段一个不多一个不少），因为播放器侧的
   * 「换源换集自动重新投屏」依赖的就是这份 state（`ruleId/entry/vars/groups/startLine/startEp`）。
   * 这里绝不做"自己拼一份"的事，否则播放页拿不到线路/集序号，会退回按第 1 集算。
   */
  const playEpisode = async (groupIdx: number, epIdx: number, episodeLink: string): Promise<void> => {
    if (!activeRule || !entry || starting) return
    setStarting(true)
    const res = await api.rules.play(activeRule.id, entry, groupIdx, epIdx, episodeLink, vars)
    if (!res.ok) {
      setStarting(false)
      setEpsFailure(classifySourceFailure(res.error, 'play'))
      toast.error(`无法解析这一集的播放地址：${res.error}`)
      return
    }
    void api.rules.prefetchStream(activeRule.id, entry, groupIdx, epIdx, episodeLink, vars)
    void api.danmaku.prefetch(title, epIdx + 1)
    onClose()
    navigate('/player', {
      state: {
        mode: 'rule',
        title,
        url: res.data.url,
        subjectId,
        ruleId: activeRule.id,
        entry,
        vars,
        groups,
        referer: activeRule.baseUrl,
        startLine: groupIdx,
        startEp: epIdx
      }
    })
  }

  /** 逐级回退：选集 → 结果 → 关闭整页（窄窗下同样成立：先收起选集抽屉，再收起结果列） */
  const back = (): void => {
    if (entry) {
      epsSeq.current++
      setEntry(null)
      setGroups([])
      setEpsFailure(null)
      setKb({ col: 1, idx: 0 })
      return
    }
    if (activeRule) {
      searchSeq.current++
      setActiveRule(null)
      setResults([])
      setSearchFailure(null)
      setKb({ col: 0, idx: 0 })
      return
    }
    onClose()
  }

  const manualSearch = async (): Promise<void> => {
    if (!activeRule) return
    const kw = manualKw.trim()
    if (!kw) {
      toast.warn('请输入搜索关键词')
      return
    }
    setEntry(null)
    setGroups([])
    await runSearch(activeRule, kw)
  }

  /** 继续观看：切回上次观看的线路并直接播那一集 */
  const continueWatch = async (): Promise<void> => {
    const ep = groups[lastLine]?.episodes[lastEp]
    if (!ep) {
      toast.warn('上次观看的线路已不可用，请在剧集列表中选择')
      return
    }
    setLineIndex(lastLine)
    await playEpisode(lastLine, lastEp, ep.link)
  }

  // ---------------- 7) 键盘（诉求 3） ----------------
  keyHandlerRef.current = (e: KeyboardEvent): void => {
    if (!open) return
    const t = e.target as HTMLElement | null
    const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    if (inField && e.key !== 'Escape') return
    /*
     * 只接管这几个键：上下（列内移动）、左右（换列）、回车/空格（确认）、Esc（回退一级）。
     * 其余键一律放行，免得把应用级快捷键（如播放器的空格暂停）吞掉。
     */
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      back()
      return
    }
    const len = kb.col === 0 ? rules.length : kb.col === 1 ? results.length : epList.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (len === 0) return
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setKb((prev) => ({ col: prev.col, idx: Math.min(len - 1, Math.max(0, prev.idx + step)) }))
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (kb.col > 0) setKb({ col: (kb.col - 1) as Col, idx: 0 })
      else back()
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      // 右方向键=在当前列确认（等价回车）；选集列已经是最后一列，无事可做
      handleConfirm()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      handleConfirm()
    }
  }

  const handleConfirm = (): void => {
    if (kb.col === 0) {
      const rule = rules[kb.idx]
      if (rule) selectRule(rule, kb.idx)
      return
    }
    if (kb.col === 1) {
      const item = results[kb.idx]
      if (item) selectEntry(item, kb.idx)
      return
    }
    const ep = epList[kb.idx]
    if (ep) void playEpisode(lineIndex, kb.idx, ep.link)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => keyHandlerRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  /** 键盘选中项滚进视野（列很长时不然"选了但看不见"） */
  useEffect(() => {
    if (!open) return
    const el = rootRef.current?.querySelector('[data-ps-kb="1"]')
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
  }, [open, kb, activeRule?.id, entry, lineIndex, results.length, epList.length, narrow])

  /**
   * 窄窗下键盘焦点要跟着"抽屉"走。
   *
   * 窄窗只有两栏：选了结果之后中间那列被选集列顶掉了，如果键盘焦点还停在 col=1，
   * 上下键就会去移动一个**看不见**的列表 —— 表现成"按了没反应"。所以这里把焦点
   * 夹回实际可见的那一列（有结果 → 选集列；收起结果 → 结果列）。
   */
  useEffect(() => {
    if (!open || !narrow) return
    if (entry && kb.col === 1) setKb({ col: 2, idx: 0 })
    else if (!entry && activeRule && kb.col === 2) setKb({ col: 1, idx: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, narrow, entry, activeRule?.id])

  /**
   * 把一条规则的探测结果翻成一句人话 + 颜色（v0.3.7 原样保留）。
   * 三种"没资源"必须分得清：没有这部番 / 有番剧但没剧集 / 有剧集但抓不到流。
   */
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

  // ---------------- 各列的可见性 ----------------
  const stage: 0 | 1 | 2 = entry ? 2 : activeRule ? 1 : 0
  const showResultCol = narrow ? !entry : true
  const showEpisodeCol = narrow ? !!entry : true

  /** 失败提示块：结论 + 建议 + 原始错误（不吞错误，见 sourceFailure.ts 的说明） */
  const failureBlock = (f: SourceFailure, extra?: React.ReactNode): React.ReactElement => (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-elev2/50 p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          <Badge tone={f.kind === 'verify' ? 'warn' : f.kind === 'empty' ? 'neutral' : 'danger'}>
            {f.kind === 'verify'
              ? '需人机验证'
              : f.kind === 'empty'
                ? '无结果'
                : f.kind === 'timeout'
                  ? '超时'
                  : f.kind === 'unreachable'
                    ? '连不上'
                    : f.kind === 'blocked'
                      ? '被拒绝'
                      : '失败'}
          </Badge>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-text">{f.label}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-faint">{f.hint}</div>
          {f.raw ? (
            <div className="mt-1.5 break-all rounded-lg bg-elev1/70 px-2 py-1 font-mono text-[10px] leading-relaxed text-dim">
              {f.raw}
            </div>
          ) : null}
        </div>
      </div>
      {extra}
    </div>
  )

  return (
    <AnimatePresence>
      {/*
        用 `{open ? … : null}` 而不是在组件顶部 `if (!open) return null`：
        顶部早退会把 AnimatePresence 本身一起从树上摘掉，`exit` 动画就永远不会播
        （关掉时直接消失）。这也是 ui.tsx 的 Modal 的做法。
      */}
      {open ? (
      <motion.div
        ref={rootRef}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.18 }}
        /*
         * z-[65]：必须在验证弹窗（z-[70]）之下，见文件头说明。
         *
         * ⚠️ V1.1 改：不再用 `inset-0`，改成**从上沿留出一条**（`top-[104px]`）。
         *
         * 起因是用户报的「番剧详情页返回按钮不灵敏，需要点好几次才响应」。真机实测
         * （`.e2e/v11-back-sources.mjs`，真实命中测试的点击）：面板打开时，
         * 在详情页「返回」按钮中心取 `elementFromPoint` 拿到的是**这块浮层**，
         * 连点 3 次导航次数都是 0 —— 点击全被它吃掉了；按 Esc 关掉面板后同一个坐标
         * 点一次就立刻返回。而详情页有一条自动逻辑：**从播放页退出回来会把这块面板弹出来**
         * （`location.state.openSources`），于是"看完一集 → 回详情 → 想点返回"这条最常见的
         * 路径每次都会踩中它。
         *
         * 留出的 104px 正好是「标题栏 + 详情页返回按钮那一行」（实测按钮占 y=60~94），
         * 于是返回按钮在面板打开时**依然看得见、点得着**，不用先关面板再点第二次。
         * 面板本体跟着改成 `h-full`（父容器已经扣掉了这 104px），不会溢出屏幕。
         */
        className="fixed inset-x-0 bottom-0 top-[104px] z-[65] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
        data-ps-stage={stage}
        /*
         * 点浮层空白处 = 关闭（V1.1 补）。
         *
         * 以前点空白处**什么都不发生**：用户想点的是被它盖住的页面元素，反馈却是"死了一样"。
         * 用 `e.target === e.currentTarget` 判定"点在空白处而不是面板本体上"，
         * 避免误关正在操作的区域。
         */
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        {/* `h-full` 而不是 `h-[88vh]`：浮层自己已经从上面留掉了 104px（见上面的说明），
            再按视口高度算一次就会顶出屏幕底部（实测 642px 视口下会超出）。 */}
        <div className="flex h-full w-full max-w-[1220px] flex-col overflow-hidden rounded-2xl border border-border bg-elev1 shadow-2xl">
          {/* ---------------- 头部：面包屑（当前走到第几级一目了然） ---------------- */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-sm font-semibold text-text">选择数据源 · 选集</span>
              <span className="shrink-0 text-faint">|</span>
              <span className="min-w-0 truncate text-[12px] text-dim">{title}</span>
              <span className="hidden shrink-0 text-[11px] text-faint sm:inline">
                搜索关键词「{manualKw.trim() || keyword}」
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="hidden items-center gap-1 text-[11px] md:flex">
                <span className={stage >= 0 ? 'text-accent' : 'text-faint'}>播放源</span>
                <span className="text-faint">›</span>
                <span className={stage >= 1 ? 'text-accent' : 'text-faint'}>搜索结果</span>
                <span className="text-faint">›</span>
                <span className={stage >= 2 ? 'text-accent' : 'text-faint'}>选集</span>
              </div>
              {activeRule ? (
                <button
                  className="flex items-center gap-1 whitespace-nowrap rounded-md border border-border px-2 py-1 text-[11px] text-dim transition-colors hover:border-accent hover:text-accent"
                  title={`在系统浏览器里打开 ${activeRule.baseUrl}`}
                  onClick={() => window.open(activeRule.baseUrl, '_blank')}
                >
                  <ExternalLink size={11} /> 打开站点
                </button>
              ) : null}
              <button
                className="rounded-md p-1 text-dim transition-colors hover:bg-elev2 hover:text-text"
                title="关闭（Esc 逐级返回）"
                onClick={onClose}
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* ---------------- 三列本体 ---------------- */}
          <div className="flex min-h-0 flex-1">
            {/* ========== 左列：播放源（规则） ========== */}
            <div
              data-ps-col="source"
              className="flex w-[280px] shrink-0 flex-col border-r border-border bg-elev1/60"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
                <span className="text-[12px] font-medium text-text">播放源</span>
                <span className="text-[10px] text-faint">{rules.length} 条启用</span>
              </div>
              {rules.length === 0 ? (
                <div className="min-h-0 flex-1 overflow-y-auto px-3">
                  <EmptyState
                    icon={Clapperboard}
                    title="暂无可用播放规则"
                    desc="在「设置 → 规则管理」中添加播放规则（Kazumi 风格），即可在线播放"
                  />
                </div>
              ) : (
                <>
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    <div className="flex flex-col gap-1.5">
                      {rules.map((rule, i) => {
                        const recommended = RECOMMENDED_RULES.includes(rule.name.toLowerCase())
                        const p = probe[rule.id]
                        /*
                         * 探针说这条线路"需要人机验证"时，点它先弹验证窗口 ——
                         * 直接进去只会再吃一次 403，用户会以为是"这条线路坏了"（v0.3.7）。
                         */
                        const needVerify = !!p && (p.count === 0 || p.hit) && isVerifyWall(p.message ?? '')
                        const active = activeRule?.id === rule.id
                        const kbHere = kb.col === 0 && kb.idx === i
                        return (
                          <button
                            key={rule.id}
                            data-ps-rule={rule.id}
                            data-ps-kb={kbHere ? '1' : undefined}
                            title={p?.message}
                            onClick={() => (needVerify ? onNeedVerify(rule) : selectRule(rule, i))}
                            className={`flex flex-col gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                              active
                                ? 'border-accent bg-accent-soft'
                                : kbHere
                                  ? 'border-accent/70 bg-elev2/70'
                                  : 'border-border bg-elev2/50 hover:border-accent hover:bg-accent-soft'
                            }`}
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className={`text-[12.5px] font-medium ${active ? 'text-accent' : 'text-text'}`}
                              >
                                {rule.name}
                              </span>
                              <Badge tone="neutral">v{rule.version}</Badge>
                              <Badge tone="accent">{rule.search.type === 'xpath' ? 'XPath' : 'API'}</Badge>
                              {recommended ? <Badge tone="ok">推荐</Badge> : null}
                              {probeBadge(rule.id)}
                              {needVerify ? <Badge tone="warn">需人机验证</Badge> : null}
                            </div>
                            <div className="truncate text-[10.5px] text-faint">
                              {p?.phase === 'done' && p.message ? p.message : rule.baseUrl}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="shrink-0 border-t border-border px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 text-[10px] leading-relaxed text-faint">
                        {probing
                          ? `正在探测各线路有没有资源…（${probeDoneCount}/${rules.length}）`
                          : probeMeta.cached && probeMeta.probedAt
                            ? `${new Date(probeMeta.probedAt).toLocaleTimeString()} 的探测结果（30 分钟内不重复探测）`
                            : '「命中 N 个资源」= 抓到 N 个候选视频地址；探测不播放'}
                      </span>
                      <button
                        className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10px] text-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                        disabled={probing}
                        onClick={() => void runProbe(true, rules)}
                      >
                        <RefreshCw size={10} className={probing ? 'animate-spin' : ''} />
                        {probing ? '探测中…' : '重新探测'}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* ========== 中列：搜索结果 ========== */}
            {showResultCol ? (
              <div
                data-ps-col="result"
                className="flex w-[300px] shrink-0 flex-col border-r border-border bg-elev1/40"
              >
                <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
                  {activeRule ? (
                    <button
                      className="rounded p-0.5 text-dim transition-colors hover:bg-elev2 hover:text-text"
                      title="收起结果列（← 也是这个）"
                      onClick={() => {
                        searchSeq.current++
                        setActiveRule(null)
                        setResults([])
                        setSearchFailure(null)
                        setKb({ col: 0, idx: 0 })
                      }}
                    >
                      <X size={13} />
                    </button>
                  ) : null}
                  <span className="text-[12px] font-medium text-text">搜索结果</span>
                  {activeRule ? (
                    <span className="min-w-0 truncate text-[11px] text-faint">· {activeRule.name}</span>
                  ) : null}
                </div>

                {!activeRule ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-3">
                    <EmptyState
                      icon={Search}
                      title="先在左边选一条播放源"
                      desc="选中后这里会列出这条线路搜到的条目，再点条目就会在右边弹出选集"
                    />
                  </div>
                ) : (
                  <>
                    {/* 手动搜索：规则自动搜索没结果时改关键词重试（旧弹窗的能力，保留） */}
                    <div className="flex shrink-0 gap-1.5 border-b border-border px-2 py-2">
                      <input
                        value={manualKw}
                        onChange={(e) => setManualKw(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void manualSearch()
                        }}
                        placeholder="改关键词重新搜索…"
                        className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-elev1 px-2 text-[12px] outline-none transition-colors placeholder:text-faint focus:border-accent"
                      />
                      <Button size="sm" icon={Search} onClick={() => void manualSearch()}>
                        搜索
                      </Button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-2">
                      {searching ? (
                        <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-dim">
                          <Spinner size={14} /> 正在 {activeRule.name} 搜索《{manualKw.trim() || keyword}》…
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {/* 有结果也有告警（例如网页内兜底只解析出一部分）时，先说清楚再列结果 */}
                          {results.length > 0 && searchFailure ? failureBlock(searchFailure) : null}
                          {results.map((item, i) => {
                            const selected = sameEntry(entry, item)
                            const kbHere = kb.col === 1 && kb.idx === i
                            return (
                              <button
                                key={`${item.link}::${item.source}`}
                                data-ps-entry={i}
                                data-ps-kb={kbHere ? '1' : undefined}
                                onClick={() => selectEntry(item, i)}
                                className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                                  selected
                                    ? 'border-accent bg-accent-soft'
                                    : kbHere
                                      ? 'border-accent/70 bg-elev2/70'
                                      : 'border-border bg-elev2/50 hover:border-accent hover:bg-accent-soft'
                                }`}
                              >
                                <span
                                  className={`line-clamp-2 min-w-0 flex-1 text-[12px] ${
                                    selected ? 'text-accent' : 'text-text'
                                  }`}
                                >
                                  {item.name || '（无名称）'}
                                </span>
                                <Play size={13} className="shrink-0 text-accent" />
                              </button>
                            )
                          })}
                          {!searching && results.length === 0 && searchFailure
                            ? failureBlock(
                                searchFailure,
                                isVerifyWall(searchFailure.raw) ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    icon={Play}
                                    onClick={() => onNeedVerify(activeRule)}
                                  >
                                    这条线路需要人机验证 · 点这里去验证
                                  </Button>
                                ) : null
                              )
                            : null}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {/* ========== 右列：选集 ========== */}
            {showEpisodeCol ? (
              <div data-ps-col="episode" className="flex min-w-0 flex-1 flex-col bg-elev1/30">
                <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
                  {entry ? (
                    <button
                      className="rounded p-0.5 text-dim transition-colors hover:bg-elev2 hover:text-text"
                      title={narrow ? '返回搜索结果' : '收起选集列（← 也是这个）'}
                      onClick={() => {
                        epsSeq.current++
                        setEntry(null)
                        setGroups([])
                        setEpsFailure(null)
                        setKb({ col: 1, idx: 0 })
                      }}
                    >
                      <X size={13} />
                    </button>
                  ) : null}
                  <span className="text-[12px] font-medium text-text">选集</span>
                  {entry ? <span className="min-w-0 truncate text-[11px] text-faint">· {entry.name}</span> : null}
                </div>

                {!entry ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-3">
                    <EmptyState
                      icon={ListVideo}
                      title={activeRule ? '再点中间那条搜索结果' : '先选播放源，再选搜索结果'}
                      desc="选中搜索结果后，这里会列出它的剧集；点某一集就直接开始播放"
                    />
                  </div>
                ) : loadingEps ? (
                  <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12px] text-dim">
                    <Spinner size={14} /> 正在解析播放线路与剧集…
                  </div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {epsFailure && groups.length === 0 ? (
                      failureBlock(epsFailure, <div className="text-[11px] text-faint">可以换个播放源或换一个搜索结果</div>)
                    ) : (
                      <>
                        {epsFailure ? <div className="mb-2">{failureBlock(epsFailure)}</div> : null}
                        {/* 多线路（番剧的多个播放线路分组）切换 */}
                        {groups.length > 1 ? (
                          <div className="mb-2 flex flex-wrap gap-1.5">
                            {groups.map((g, i) => (
                              <button
                                key={i}
                                onClick={() => {
                                  setLineIndex(i)
                                  setKb({ col: 2, idx: 0 })
                                }}
                                className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-[11px] transition-colors ${
                                  i === lineIndex ? 'bg-accent-soft text-accent' : 'bg-elev2 text-dim hover:text-text'
                                }`}
                              >
                                {g.lineName ?? `线路 ${i + 1}`}
                                <span className="ml-1 text-faint">({g.episodes.length})</span>
                              </button>
                            ))}
                          </div>
                        ) : null}

                        {progressItem && lastLine >= 0 && lastEp >= 0 ? (
                          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft/50 px-2.5 py-2">
                            <Button size="sm" icon={Play} onClick={() => void continueWatch()}>
                              继续观看第 {lastEp + 1} 集
                            </Button>
                            <span className="text-[11px] text-dim">
                              已看 {watchedKeys.size} 集
                              {lastPercent > 0 ? ` · 上次进度 ${lastPercent}%` : ''}
                              {groups.length > 1 ? ` · 上次在第 ${lastLine + 1} 条线路` : ''}
                            </span>
                          </div>
                        ) : null}

                        {group && epList.length > 0 ? (
                          /*
                           * 网格用 auto-fill 而不是固定列数：三列同屏时本列只有 300 多像素、
                           * 窄窗抽屉里却有近 400 像素，写死 cols-5 会在其中一种下明显偏窄或偏空。
                           */
                          <div className="grid grid-cols-[repeat(auto-fill,minmax(62px,1fr))] gap-1.5">
                            {epList.map((ep, i) => {
                              const seen = watchedKeys.has(epKey(lineIndex, i))
                              const isLast = lastLine === lineIndex && lastEp === i
                              const kbHere = kb.col === 2 && kb.idx === i
                              return (
                                <button
                                  key={i}
                                  data-ps-ep={i}
                                  data-ps-kb={kbHere ? '1' : undefined}
                                  disabled={starting}
                                  onClick={() => void playEpisode(lineIndex, i, ep.link)}
                                  className={`relative truncate rounded-lg border px-2 py-2 text-center text-[11px] transition-colors disabled:opacity-60 ${
                                    isLast
                                      ? 'border-accent bg-accent font-semibold text-white'
                                      : kbHere
                                        ? 'border-accent bg-accent-soft font-medium text-accent'
                                        : seen
                                          ? 'border-accent/60 bg-accent-soft font-medium text-accent'
                                          : 'border-border bg-elev2/60 text-dim hover:border-accent hover:bg-accent-soft hover:text-accent'
                                  }`}
                                  title={isLast ? `${ep.name} · 上次看到这里` : seen ? `${ep.name} · 已看` : ep.name}
                                >
                                  {ep.name || `第 ${i + 1} 集`}
                                  {isLast ? (
                                    <span className="absolute -right-1 -top-1 whitespace-nowrap rounded-full bg-white px-1.5 py-px text-[9px] font-semibold text-accent shadow">
                                      继续
                                    </span>
                                  ) : null}
                                </button>
                              )
                            })}
                          </div>
                        ) : (
                          <EmptyState
                            icon={Clapperboard}
                            title="未解析到剧集列表"
                            desc="该规则可能已失效，请到规则配置页检查 XPath / JSONPath"
                          />
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : null}
          </div>

          {/* ---------------- 底部：键盘提示 + 播放中的过渡态 ---------------- */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2">
            <span className="min-w-0 truncate text-[10.5px] leading-relaxed text-faint">
              {narrow
                ? '窗口较窄：已改为「播放源 + 当前层级」两栏，选集会在右栏替换结果列表。'
                : '三列从左到右依次是：播放源 → 搜索结果 → 选集；点已选中的一项可收起它右边的列。'}
              <span className="ml-1 hidden sm:inline">↑↓ 移动 · ← → 换列 · 回车确认 · Esc 返回上一级</span>
            </span>
            {starting ? (
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-accent">
                <Spinner size={12} /> 正在解析这一集的播放地址…
              </span>
            ) : null}
          </div>
        </div>
      </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

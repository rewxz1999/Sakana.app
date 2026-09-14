import { useEffect, useMemo, useState } from 'react'
import {
  Bookmark,
  CirclePlay,
  Clock,
  Download,
  Heart,
  History,
  Puzzle,
  Rss,
  Tv
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type {
  FavoriteItem,
  PlayRule,
  RuleEpisodeGroup,
  RuleSearchEntry,
  WatchHistoryItem,
  WatchProgressItem
} from '@shared/types'
import { api } from '@/lib/api'
import { useLibrary } from '@/stores/library'
import { useSubs } from '@/stores/subs'
import { useTools } from '@/stores/tools'
import { useWatchProgress } from '@/stores/watchProgress'
import { fmtDateTime, timeAgo } from '@/lib/format'
import { Ring } from '@/components/Ring'
import { DownloadTaskList } from '@/components/DownloadTaskList'
import { CoverImage } from '@/components/CoverImage'
import { Badge, EmptyState, ProgressBar, Select, Spinner } from '@/components/ui'
import { toast } from '@/stores/app'

const RING_COLORS = ['#e8548a', '#5b8cff', '#27cfa5', '#f0a14e', '#a78bfa', '#f06a6a', '#4c9a5a', '#e8b04b']

/** 收藏类型分布中不计入统计的标签：地区、播放类型 */
const EXCLUDED_TAGS = new Set([
  // 地区标签
  '日本', '中国大陆', '中国', '中国台湾', '中国香港', '美国', '韩国', '法国', '英国', '德国', '俄罗斯', '欧美', '台湾', '香港', '国创',
  // 播放类型标签
  'TV', '剧场版', 'OVA', 'OAD', 'WEB', 'Web', '电影', '动画电影', 'TV动画', '特别篇'
])

/** 判断标签是否被排除（时间标签如「2026年7月」、地区、播放类型均不计入统计） */
function isExcludedTag(tag: string): boolean {
  if (EXCLUDED_TAGS.has(tag)) return true
  // 时间标签：2026年 / 2026年7月 / 2026年7月新番 等
  if (/^20\d{2}年(\d{1,2}月)?(新番|番剧)?$/.test(tag)) return true
  return false
}

type RingMode = 'time' | 'genre' | 'year' | 'finish'

const KIND_LABEL = {
  subscribe: '订阅',
  unsubscribe: '退订',
  update: '更新',
  download: '下载',
  play: '播放'
} as const

/** 「继续观看」最多展示的条目数：卡片位于统计格内，条目过多会把整行撑高 */
const CONTINUE_LIMIT = 3

/**
 * 「继续观看」归一化条目。
 *
 * 两种数据源（v0.2.4 观看进度 / v0.2.3 本地观看历史）统一成同一结构，渲染只认这个结构，
 * 点击时再按「来源 + 是否带进度记录」分流到在线播放或本地播放。
 */
interface ContinueEntry {
  /** React key：进度用 WatchProgressItem.id（ruleId::entryLink 或 local::filePath），回落时用观看历史 id */
  key: string
  title: string
  cover?: string
  /** 集号（从 1 开始）；进度记录用 episodeIndex + 1，与 watchProgress.progressSummary 口径一致 */
  episodeNo: number | null
  /** 进度百分比 0-100；没有时长信息时为 null，界面退回显示「上次观看时间」 */
  percent: number | null
  source: 'online' | 'local'
  updatedAt: number
  /** 进度记录本体：在线续播要靠它还原规则播放参数；回落条目为 null */
  progress: WatchProgressItem | null
  subjectId?: number
  /** 集名（如「第 3 话」），用作 tooltip */
  episodeName?: string
}

export function DashboardPage() {
  const navigate = useNavigate()
  const { favorites, watchHistory, subHistory } = useLibrary()
  const { subscriptions, downloads } = useSubs()
  const tools = useTools((s) => s.tools)
  const [ringMode, setRingMode] = useState<RingMode>('time')
  /**
   * 观看进度（v0.2.4）：仪表盘「继续观看」优先用它。
   * 本地观看历史（watchHistory）只记「看过哪部、第几集」，没有在线定位信息，无法联动在线播放；
   * 观看进度同时存了 ruleId / entryLink / groupIndex / episodeIndex / positionSec，才能回到在线播放现场。
   */
  const { items: progressItems, loaded: progressLoaded, load: loadProgress } = useWatchProgress()
  /** 正在解析在线播放地址的卡片 key（解析需要请求规则站点，期间禁用该卡片避免重复点击） */
  const [resumingKey, setResumingKey] = useState<string | null>(null)

  // 进度数据存在主进程 store，进页面兜底加载一次（与收藏页同一约定，store 内已加载则不重复请求）
  useEffect(() => {
    if (!progressLoaded) void loadProgress()
  }, [progressLoaded, loadProgress])

  const subUpdateCount = subscriptions.filter((s) => s.status === 'waiting' || s.status === 'updating').length
  const favSubUpdateCount = subscriptions.filter(
    (s) => (s.status === 'waiting' || s.status === 'updating') && favorites.some((f) => f.subjectId === s.subjectId)
  ).length

  const activeDownloads = downloads.filter((d) => !['done', 'error'].includes(d.status))

  /**
   * 「继续观看」数据源（产品要求：优先观看进度，并保留本地观看记录兜底）：
   * 1. 优先 useWatchProgress().items —— 已按 updatedAt 倒序排在数组头部，这里再排一次以防旧数据顺序错乱；
   *    百分比 = positionSec / durationSec，无时长（还没上报进度）时记 null。
   * 2. 进度记录为空（老版本数据 / 还没接入进度上报）时回落到 watchHistory 的前几条，
   *    保证「继续观看」不会出现空白，行为与 v0.2.3 的本地续播一致。
   */
  const continueList = useMemo<ContinueEntry[]>(() => {
    if (progressItems.length > 0) {
      return [...progressItems]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, CONTINUE_LIMIT)
        .map((p) => ({
          key: p.id,
          title: p.title,
          cover: p.cover,
          episodeNo: p.episodeIndex + 1,
          percent: p.durationSec > 0 ? Math.min(100, Math.round((p.positionSec / p.durationSec) * 100)) : null,
          source: p.source,
          updatedAt: p.updatedAt,
          progress: p,
          subjectId: p.subjectId,
          episodeName: p.episodeName
        }))
    }
    return watchHistory.slice(0, CONTINUE_LIMIT).map((h) => ({
      key: h.id,
      title: h.title,
      episodeNo: h.episode,
      percent: null,
      source: h.source,
      updatedAt: h.watchedAt,
      progress: null,
      subjectId: h.subjectId
    }))
  }, [progressItems, watchHistory])

  /**
   * 在线续播（source === 'online'）。
   *
   * PlayerPage 的 rule 模式播放需要完整状态：url（播放页地址）+ groups（剧集列表）+ vars（规则响应变量）
   * + ruleId/entry（后续选集时 api.rules.play 用）。而观看进度只存了定位信息
   * （ruleId / entryName / entryLink / groupIndex / episodeIndex），没有存剧集列表与变量，
   * 所以这里先向规则重新要一次剧集与播放地址，再按 PlayerPage 实际读取的字段跳转。
   */
  const resumeOnline = async (entry: ContinueEntry): Promise<void> => {
    const p = entry.progress
    if (!p?.ruleId || !p.entryLink) {
      toast.warn('该进度缺少在线播放定位信息（规则或条目链接），可到番剧详情页重新选择线路播放')
      return
    }
    // PlayerPage 的 entry 是 RuleSearchEntry { name, link, source }；
    // 进度里只存了条目名与条目链接，按详情页/搜索结果的约定用 entryLink 同时充当 link 与 source
    const ruleEntry: RuleSearchEntry = {
      name: p.entryName ?? entry.title,
      link: p.entryLink,
      source: p.entryLink
    }
    setResumingKey(entry.key)
    // 并行取：剧集列表/变量（缺了播放页无法播放与选集）与规则 baseUrl（作播放页 referer，与详情页一致）
    const [eps, rulesStore] = await Promise.all([
      api.rules.episodes(p.ruleId, ruleEntry),
      api.store.get('rules')
    ])
    if (!eps.ok) {
      setResumingKey(null)
      toast.error(`在线续播失败：${eps.error}`)
      return
    }
    const groups: RuleEpisodeGroup[] = eps.data.groups
    const vars = eps.data.vars
    // 站点改版可能让线路/集序号失效：夹到有效范围，避免点开就是空白或失败
    const line = groups.length > 0 ? Math.min(Math.max(p.groupIndex, 0), groups.length - 1) : 0
    const epCount = groups[line]?.episodes.length ?? 0
    const ep = epCount > 0 ? Math.min(Math.max(p.episodeIndex, 0), epCount - 1) : 0
    const episodeLink = groups[line]?.episodes[ep]?.link ?? ''
    const play = await api.rules.play(p.ruleId, ruleEntry, line, ep, episodeLink, vars)
    setResumingKey(null)
    if (!play.ok) {
      toast.error(`在线续播失败：${play.error}`)
      return
    }
    const rule =
      rulesStore.ok && Array.isArray(rulesStore.data)
        ? (rulesStore.data as PlayRule[]).find((r) => r.id === p.ruleId)
        : undefined
    navigate('/player', {
      /**
       * 跳转参数逐项对齐 PlayerPage 的 PlayerState（interface PlayerState 只读以下字段，
       * 多传/少传都不会生效）：mode / title / url / subjectId / ruleId / entry / vars / groups / referer。
       *
       * 另需说明：PlayerState 里没有「续播起始秒」（startSec 仅是 PlayerPage 内部 startTranscode 的参数），
       * 所以 positionSec 无法传给播放页 —— 本次只做「回到原规则、原线路、原集」的跳转，
       * 真正的秒级续播需要在播放页支持该参数后才能实现（不改 PlayerPage 的前提下无解）。
       */
      state: {
        mode: 'rule',
        title: p.title,
        url: play.data.url,
        subjectId: p.subjectId,
        ruleId: p.ruleId,
        entry: ruleEntry,
        vars,
        groups,
        // PlayerPage 用 referer 打开播放页网页视图；拿不到规则时留空（undefined 语义＝回退规则站点）
        referer: rule?.baseUrl
      }
    })
  }

  /**
   * 本地续播（source === 'local'，以及观看历史回落条目）。
   *
   * PlayerPage 本地模式只接受 folder（+ episode），不接受文件路径：它会扫描目录，
   * 再用 f.episode === state.episode 选中同一集。所以这里用进度记录里的文件路径取所在目录，
   * 并按主进程 parseEpisode 同样的规则从文件名解析集号，让它选中同一个文件。
   */
  const resumeLocal = (entry: ContinueEntry): void => {
    const p = entry.progress
    const sub = subscriptions.find((s) => s.subjectId === entry.subjectId)
    const folder = (p?.filePath ? folderOf(p.filePath) : '') || (sub?.folder ?? '')
    if (!folder) {
      toast.warn('未找到该番剧的本地资源，可在订阅页点击「本地播放」选择文件夹')
      return
    }
    const episode = p?.filePath
      ? (parseEpisodeFromName(p.filePath) ?? undefined)
      : (entry.episodeNo ?? undefined)
    navigate('/player', {
      state: {
        mode: 'local',
        title: entry.title,
        folder,
        subjectId: entry.subjectId ?? sub?.subjectId,
        episode
      }
    })
  }

  /** 「继续观看」卡片点击：在线进度走在线续播，本地进度与回落条目走本地播放 */
  const openContinue = (entry: ContinueEntry): void => {
    if (entry.source === 'online' && entry.progress) {
      void resumeOnline(entry)
      return
    }
    resumeLocal(entry)
  }

  const ringData = useMemo(() => {
    if (ringMode === 'time') {
      const buckets = [
        { label: '深夜 0-6 点', value: 0 },
        { label: '上午 6-12 点', value: 0 },
        { label: '下午 12-18 点', value: 0 },
        { label: '晚上 18-24 点', value: 0 }
      ]
      for (const h of watchHistory) {
        if (h.hour < 6) buckets[0].value++
        else if (h.hour < 12) buckets[1].value++
        else if (h.hour < 18) buckets[2].value++
        else buckets[3].value++
      }
      return { total: watchHistory.length, unit: '次观看', segments: buckets.map((b, i) => ({ ...b, color: RING_COLORS[i] })) }
    }
    if (ringMode === 'genre') {
      const map = new Map<string, number>()
      for (const f of favorites) {
        for (const g of f.genres) {
          if (isExcludedTag(g)) continue
          map.set(g, (map.get(g) ?? 0) + 1)
        }
      }
      const top = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      return { total: favorites.length, unit: '部收藏', segments: top.map(([label, value], i) => ({ label, value, color: RING_COLORS[i] })) }
    }
    // year / finish 走柱形图（YearBarChart），此处仅返回空数据占位
    return { total: 0, unit: '', segments: [] }
  }, [ringMode, watchHistory, favorites])

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      {/* 数量统计 + 继续观看 */}
      <div className="grid grid-cols-4 gap-3.5">
        <StatCard icon={Rss} label="已订阅番剧" value={subscriptions.length} accent onClick={() => navigate('/subs')} />
        <StatCard icon={Heart} label="已收藏番剧" value={favorites.length} accent onClick={() => navigate('/favorites')} />
        <StatCard icon={Puzzle} label="已安装工具" value={tools.length} accent onClick={() => navigate('/tools')} />
        <div className="col-span-1 rounded-xl border border-accent/25 bg-gradient-to-br from-accent-soft to-elev1 p-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs text-dim">
              <CirclePlay size={13} className="text-accent" /> 继续观看
            </span>
            {continueList.length > 0 ? <span className="text-[10px] text-faint">{continueList.length} 条</span> : null}
          </div>
          {continueList.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1.5">
              {continueList.map((item) => (
                <button
                  key={item.key}
                  onClick={() => openContinue(item)}
                  disabled={resumingKey === item.key}
                  title={item.episodeName ?? item.title}
                  className="flex items-center gap-2 rounded-lg border border-border bg-elev1/80 p-1.5 text-left transition-colors hover:border-accent disabled:opacity-60"
                >
                  {/* CoverImage 在 src 为空时会渲染渐变占位，所以没有封面也能直接用 */}
                  <CoverImage src={item.cover} className="h-11 w-8 shrink-0" rounded="rounded" />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-1 text-[11px] font-semibold">{item.title}</div>
                    <div className="line-clamp-1 text-[10px] text-faint">
                      {item.episodeNo != null ? `第 ${item.episodeNo} 集` : '集数未知'}
                      {item.percent != null
                        ? ` · 进度 ${item.percent}%`
                        : ` · 上次观看 ${timeAgo(item.updatedAt)}`}
                    </div>
                    {item.percent != null ? <ProgressBar value={item.percent} className="mt-1" /> : null}
                  </div>
                  {resumingKey === item.key ? (
                    <Spinner size={12} />
                  ) : (
                    <Badge tone={item.source === 'online' ? 'accent' : 'neutral'}>
                      {item.source === 'online' ? '在线' : '本地'}
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-2 text-xs text-faint">暂无观看记录</div>
          )}
        </div>
      </div>

      {/* 更新动态 + 历史记录 */}
      <div className="mt-4 grid grid-cols-3 gap-3.5">
        <div className="rounded-xl border border-border bg-elev1 p-4">
          <div className="mb-3 text-sm font-semibold">更新动态</div>
          <div className="flex gap-3">
            <div className="flex-1 rounded-lg bg-accent-soft p-3">
              <div className="text-2xl font-bold text-accent">{subUpdateCount}</div>
              <div className="mt-0.5 text-xs text-dim">订阅番剧更新</div>
            </div>
            <div className="flex-1 rounded-lg bg-elev2 p-3">
              <div className="text-2xl font-bold">{favSubUpdateCount}</div>
              <div className="mt-0.5 text-xs text-dim">收藏番剧更新</div>
            </div>
          </div>
          {subUpdateCount > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {subscriptions
                .filter((s) => s.status === 'waiting' || s.status === 'updating')
                .slice(0, 6)
                .map((s) => (
                  <Badge key={s.id} tone="accent">
                    {s.nameCn || s.name}
                  </Badge>
                ))}
            </div>
          ) : (
            <div className="mt-3 text-xs text-faint">所有订阅均为最新状态</div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-elev1 p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <History size={14} className="text-accent" /> 观看历史
            </span>
            <span className="text-[11px] text-faint">{watchHistory.length} 条</span>
          </div>
          <div className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
            {watchHistory.slice(0, 12).map((h) => (
              <div key={h.id} className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-elev2">
                <span className="line-clamp-1 flex-1">
                  {h.title}
                  {h.episode != null ? ` · 第${h.episode}集` : ''}
                </span>
                <span className="ml-2 shrink-0 text-[10px] text-faint">{timeAgo(h.watchedAt)}</span>
              </div>
            ))}
            {watchHistory.length === 0 ? <div className="py-6 text-center text-xs text-faint">暂无观看记录</div> : null}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-elev1 p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <Clock size={14} className="text-accent" /> 订阅历史
            </span>
            <span className="text-[11px] text-faint">{subHistory.length} 条</span>
          </div>
          <div className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
            {subHistory.slice(0, 12).map((h) => (
              <div key={h.id} className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-elev2">
                <span className="line-clamp-1 flex-1">
                  <span className="mr-1.5 rounded bg-elev2 px-1 py-0.5 text-[10px] text-dim">{KIND_LABEL[h.kind]}</span>
                  {h.title}
                </span>
                <span className="ml-2 shrink-0 text-[10px] text-faint">{timeAgo(h.at)}</span>
              </div>
            ))}
            {subHistory.length === 0 ? <div className="py-6 text-center text-xs text-faint">暂无订阅记录</div> : null}
          </div>
        </div>
      </div>

      {/* 圆环统计 + 正在下载 */}
      <div className="mt-4 grid grid-cols-5 gap-3.5">
        <div className="col-span-2 rounded-xl border border-border bg-elev1 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">统计分布</span>
            <Select value={ringMode} onChange={(e) => setRingMode(e.target.value as RingMode)} className="h-8 text-xs">
              <option value="time">观看时间段分布</option>
              <option value="genre">收藏类型分布</option>
              <option value="year">看过统计</option>
              <option value="finish">看完统计</option>
            </Select>
          </div>
          {ringMode === 'year' ? (
            <YearBarChart
              rows={watchYearRows(watchHistory)}
              emptyTitle="暂无观看记录"
              emptyDesc="观看番剧后这里会生成看过统计"
              unitLabel="看过"
            />
          ) : ringMode === 'finish' ? (
            <YearBarChart
              rows={finishYearRows(favorites)}
              emptyTitle="暂无看完记录"
              emptyDesc="在详情页标记「已看完」后，这里按看完时间年份统计"
              unitLabel="看完"
            />
          ) : ringData.total > 0 ? (
            <div className="flex items-center gap-5">
              <Ring
                segments={ringData.segments}
                center={
                  <>
                    <div className="text-2xl font-bold">{ringData.total}</div>
                    <div className="text-[11px] text-faint">{ringData.unit}</div>
                  </>
                }
              />
              <div className="min-w-0 flex-1 space-y-1.5">
                {ringData.segments.map((seg, i) => {
                  const pct = ringData.total > 0 ? Math.round((seg.value / ringData.total) * 100) : 0
                  return (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: seg.color }} />
                      <span className="w-28 truncate text-dim">{seg.label}</span>
                      <span className="ml-auto tabular-nums text-faint">
                        {seg.value} · {pct}%
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <EmptyState icon={Tv} title="暂无统计数据" desc="观看番剧或收藏后，这里会生成统计" />
          )}
        </div>

        <div className="col-span-3 rounded-xl border border-border bg-elev1 p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <Download size={14} className="text-accent" /> 正在下载
            </span>
            <Badge tone={activeDownloads.length > 0 ? 'accent' : 'neutral'}>
              {activeDownloads.length > 0 ? `${activeDownloads.length} 个任务进行中` : '空闲'}
            </Badge>
          </div>
          <div className="max-h-[260px] overflow-y-auto pr-1">
            <DownloadTaskList limit={6} />
          </div>
        </div>
      </div>

      <div className="mt-4 text-center text-[10px] text-faint">
        数据来自本地缓存 · 最近更新{' '}
        {/* 「最近更新」同时统计观看历史与观看进度（进度可能在历史之后才写入，如续播位置更新） */}
        {fmtDateTime(Math.max(...watchHistory.map((h) => h.watchedAt), ...progressItems.map((p) => p.updatedAt), 0))}
      </div>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
  onClick
}: {
  icon: typeof Bookmark
  label: string
  value: number
  accent?: boolean
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3.5 rounded-xl border border-border bg-elev1 p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${accent ? 'bg-accent-soft text-accent' : 'bg-elev2 text-dim'}`}
      >
        <Icon size={20} />
      </div>
      <div>
        <div className="text-2xl font-bold leading-tight tabular-nums">{value}</div>
        <div className="text-xs text-dim">{label}</div>
      </div>
    </button>
  )
}

/** 取文件所在目录（兼容 Windows 反斜杠与 POSIX 斜杠；用于把进度里的文件路径换算成 PlayerPage 需要的 folder） */
function folderOf(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return i > 0 ? filePath.slice(0, i) : ''
}

/**
 * 从文件名解析集号，规则与主进程 src/main/lib/parse.ts 的 parseEpisode 保持一致
 * （渲染层不能 import 主进程模块，这里复制最小实现）。
 * 用途：本地续播时 PlayerPage 按 f.episode === state.episode 选中文件，需要把文件路径换成集号。
 */
const EPISODE_PATTERNS = [
  /第\s*(\d{1,4})\s*[话話集]/u,
  /[Ee][Pp]?(\d{1,3})/u,
  /(?:^|[\s\[【（(])0*(\d{1,3})(?:\.5)?(?:v\d{1,2})?(?:[\s\]】）)]|$)/u
]

function parseEpisodeFromName(filePath: string): number | null {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  for (const re of EPISODE_PATTERNS) {
    const m = name.match(re)
    if (!m) continue
    const n = parseInt(m[1], 10)
    if (!Number.isNaN(n) && n > 0 && n < 2000) return n
  }
  return null
}

/** 看过统计：每年看过多少部番剧（有观看历史的番剧，按最后观看时间年份） */
function watchYearRows(history: WatchHistoryItem[]): { year: number; count: number }[] {
  const map = new Map<number, Set<string>>()
  for (const h of history) {
    const y = new Date(h.watchedAt).getFullYear()
    if (!map.has(y)) map.set(y, new Set())
    map.get(y)!.add(h.title)
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 8)
    .map(([year, set]) => ({ year, count: set.size }))
}

/** 看完统计：按标记看完时间的年份统计已标记看完的番剧数 */
function finishYearRows(favorites: FavoriteItem[]): { year: number; count: number }[] {
  const map = new Map<number, number>()
  for (const f of favorites) {
    if (!f.watchedAt) continue
    const d = new Date(f.watchedAt)
    if (Number.isNaN(d.getTime())) continue
    const y = d.getFullYear()
    map.set(y, (map.get(y) ?? 0) + 1)
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 8)
    .map(([year, count]) => ({ year, count }))
}

/** 横向柱状图（看过/看完统计共用）：左侧年份，横条下方显示数量 */
function YearBarChart({
  rows,
  emptyTitle,
  emptyDesc,
  unitLabel
}: {
  rows: { year: number; count: number }[]
  emptyTitle: string
  emptyDesc: string
  unitLabel: string
}) {
  const max = Math.max(...rows.map((r) => r.count), 1)
  const thisYear = new Date().getFullYear()
  const total = rows.reduce((s, r) => s + r.count, 0)
  if (rows.length === 0) {
    return <EmptyState icon={Tv} title={emptyTitle} desc={emptyDesc} />
  }
  return (
    <div className="py-1">
      <div className="flex flex-col gap-3">
        {rows.map(({ year, count }) => (
          <div key={year} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-right text-xs font-medium tabular-nums text-dim">{year}</span>
              <div className="h-4 flex-1 overflow-hidden rounded bg-elev2">
                <div
                  className="flex h-full min-w-[42px] items-center rounded bg-gradient-to-r from-accent to-accent/60"
                  style={{ width: `${Math.max(8, (count / max) * 100)}%` }}
                />
              </div>
            </div>
            <div className="pl-16 text-[10px] tabular-nums text-faint">{unitLabel} {count} 部</div>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-dim">
        {thisYear} 年{unitLabel} <span className="font-semibold text-accent">{rows.find((r) => r.year === thisYear)?.count ?? 0}</span>{' '}
        部 · 累计 <span className="font-semibold text-accent">{total}</span> 部
      </div>
    </div>
  )
}

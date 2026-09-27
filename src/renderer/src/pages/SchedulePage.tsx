import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { CalendarDays, CloudOff, RefreshCw, ShieldOff } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { CalendarItem, ScheduleDisplayFilters } from '@shared/types'
import { seasonLabel, seasonOfDate } from '@shared/season'
import { blockReason, isBlockingActive, shouldLoadTags } from '@shared/scheduleBlock'
import { useSchedule, useScheduleBlock, useScheduleTags } from '@/stores/schedule'
import { useLibrary } from '@/stores/library'
import { useSettings } from '@/stores/app'
import { fmtDateTime, mondayOf, weekdayDate, WEEKDAY_CN } from '@/lib/format'
import { DEFAULT_SCHEDULE_FILTERS, passesDisplayFilters, resolveScheduleFilters, watchStateOf } from '@/lib/timelineFilter'
import { AnimeCard } from '@/components/AnimeCard'
import { Button, EmptyState, Modal, Switch } from '@/components/ui'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'

/** 「显示范围」三个开关（默认全关 = 全部显示，对齐 Kazumi timeline_options.dart:105-123） */
const FILTER_CHIPS: { key: keyof ScheduleDisplayFilters; label: string; title: string }[] = [
  { key: 'hideWatched', label: '隐藏看过的番剧', title: '隐藏本日已看完的番剧（含观看记录自动判定）' },
  {
    key: 'hideDropped',
    label: '隐藏已抛弃的番剧',
    title: '收藏数据里没有「抛弃」状态，仅外部/历史数据带抛弃标记时才会命中'
  },
  { key: 'onlyWatching', label: '只看在看的番剧', title: '只显示已收藏且尚未看完的番剧' }
]

function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-elev1">
      <div className="aspect-[3/4] animate-pulse bg-elev2" />
      <div className="space-y-2 p-2.5">
        <div className="h-3 w-4/5 animate-pulse rounded bg-elev2" />
        <div className="h-2.5 w-2/5 animate-pulse bg-elev2" />
      </div>
    </div>
  )
}

export function SchedulePage() {
  const navigate = useNavigate()
  const { days, loading, error, fetchedAt, fromCache, stale, fallbackSource, selectedDay, weekOffset, ratings, load, loadRatings, selectDay } = useSchedule()
  const favorites = useLibrary((s) => s.favorites)
  const watchHistory = useLibrary((s) => s.watchHistory)
  const toggleFavorite = useLibrary((s) => s.toggleFavorite)
  const settings = useSettings((s) => s.settings)
  const saveSettings = useSettings((s) => s.save)
  const [showVpnDialog, setShowVpnDialog] = useState(false)

  // ---------- 番剧表设置（分级标签屏蔽 + 黑名单） ----------
  const blockCfg = useScheduleBlock((s) => s.cfg)
  const loadBlock = useScheduleBlock((s) => s.load)
  const tagMap = useScheduleTags((s) => s.tags)
  const tagFailed = useScheduleTags((s) => s.failed)
  const tagFetching = useScheduleTags((s) => s.fetching)
  const ensureTags = useScheduleTags((s) => s.ensureTags)
  /**
   * 「临时显示全部」：只在本页会话内有效，**不写进设置**。
   * 用户要的是一个「我怀疑误杀了，先看看全部」的临时出口，而不是又改一次设置。
   */
  const [showAllBlocked, setShowAllBlocked] = useState(false)

  /** 打开番剧表设置小窗口（本页提示条与空列表里的入口共用） */
  const openBlockSettings = (): void => {
    void api.window.openSmall('/schedule-settings', { width: 720, height: 640, title: '番剧表设置' })
  }

  // 「显示范围」三开关：属偏好，直接存在设置里（shared/types 的 scheduleFilters）
  const filters = resolveScheduleFilters(settings.scheduleFilters)

  const dayItems = useMemo(() => {
    const day = days.find((d) => d.weekday.id === selectedDay)
    return day?.items ?? []
  }, [days, selectedDay])

  /**
   * 条目 id → 是否通过「显示范围」筛选。
   * 收藏 / 已看完判定复用 library store 的 isCompleted（见 lib/timelineFilter），
   * 与详情页、收藏页的判定完全一致；未收藏的条目不受任何开关影响（全关时全部通过）。
   */
  const passById = (() => {
    const map = new Map<number, boolean>()
    for (const d of days) {
      for (const it of d.items) {
        if (map.has(it.id)) continue
        map.set(it.id, passesDisplayFilters(watchStateOf(it.id, favorites, watchHistory), filters))
      }
    }
    return map
  })()

  /*
   * 番剧表屏蔽（用户需求第 4 条）——**只在这一层过滤**。
   *
   * 为什么不在数据层/接口层做：屏蔽是番剧表这一个页面的展示偏好，
   * 一旦下沉到 store/主进程，搜索结果、收藏、详情、订阅都会被连带影响（用户明确要求不影响搜索）。
   * 所以这里只是渲染前的一张「id → 屏蔽原因」表，其它页面拿到的数据一个字节都没变。
   *
   * 关键降级：`tagMap[it.id]` 取不到标签时 blockReason 返回 null = **不屏蔽**。
   * 标签要逐条补详情才有，反代抖动/条目详情缺 tags 时宁可少屏蔽，也不能把整页番剧误杀。
   */
  const blockReasonById = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of days) {
      for (const it of d.items) {
        if (map.has(it.id)) continue
        const reason = blockReason(it, tagMap[it.id], blockCfg)
        if (reason) map.set(it.id, reason)
      }
    }
    return map
  }, [days, tagMap, blockCfg])
  const blockedCount = blockReasonById.size
  const dayBlockedCount = showAllBlocked ? 0 : dayItems.filter((it) => blockReasonById.has(it.id)).length

  const keepItem = (it: CalendarItem): boolean => {
    if (!showAllBlocked && blockReasonById.has(it.id)) return false
    return passById.get(it.id) ?? true
  }

  // ---------- 标签补全（只有开关打开时才做） ----------
  const tagRulesOn = shouldLoadTags(blockCfg)
  /** 本周（当前番剧表）去重后的全部条目 id；标签补全与进度显示都以它为分母 */
  const weekIds = useMemo(() => [...new Set(days.flatMap((d) => d.items.map((i) => i.id)))], [days])

  useEffect(() => {
    /*
     * 屏蔽配置在独立 store 键 `scheduleBlock` 里，而且是在**另一个窗口**（/schedule-settings 小窗口）
     * 改的 —— 小窗口是独立渲染进程，改了那边这里不会收到任何通知。
     * 所以除了挂载时读一次，每次窗口重新获得焦点也读一次：用户改完设置切回来立刻看到效果。
     */
    void loadBlock()
    const onFocus = (): void => void loadBlock()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadBlock])

  useEffect(() => {
    /*
     * 所有标签屏蔽开关都关着时**一个请求都不发**（省流量，也保证「不影响搜索结果」在流量层面可验证）：
     * 判据是 shared 的 shouldLoadTags（黑名单不需要标签，所以不参与这个判断）。
     */
    if (!tagRulesOn) return
    if (weekIds.length === 0) return
    // 当前显示日排在最前面：可见的那一天最先拿到标签、屏蔽最先生效，其余日子依次补齐
    ensureTags([...new Set([...dayItems.map((i) => i.id), ...weekIds])])
  }, [tagRulesOn, dayItems, weekIds, ensureTags])

  /** 标签缓存进度：已尝试（成功 + 失败）／本周条目数（界面上写「标签缓存 87/111」） */
  const tagDone = weekIds.filter((id) => id in tagMap || tagFailed.includes(id)).length
  const tagFailedCount = weekIds.filter((id) => tagFailed.includes(id)).length

  /** 当前显示日里通过筛选的条目；星期按钮上的「N 部」也一并按同一判据计数，避免数字与列表不符 */
  const visibleItems = dayItems.filter(keepItem)
  const hiddenCount = dayItems.length - visibleItems.length
  const dayCount = (weekdayId: number): number => {
    const day = days.find((d) => d.weekday.id === weekdayId)
    return day ? day.items.filter(keepItem).length : 0
  }

  const setFilter = (key: keyof ScheduleDisplayFilters, value: boolean): void => {
    saveSettings({ scheduleFilters: { ...filters, [key]: value } })
  }

  useEffect(() => {
    if (error && days.length === 0 && error.kind === 'ALL_DOWN') setShowVpnDialog(true)
  }, [error, days.length])

  // 日历页不含评分：切到某天时按需补全该天番剧评分（主进程 7 天缓存）
  useEffect(() => {
    if (dayItems.length > 0) void loadRatings(dayItems.map((i) => i.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDay, weekOffset, dayItems.length])

  const headerDate = useMemo(() => {
    const d = weekdayDate(weekOffset, selectedDay)
    const today = new Date()
    const isToday =
      d.year() === today.getFullYear() && d.month() === today.getMonth() + 1 && d.date() === today.getDate()
    return { d, isToday }
  }, [weekOffset, selectedDay])

  /*
   * 季节文案（「第 N 周」已被它取代，见用户要求）。
   *
   * 约定：1–3 月 冬 / 4–6 月 春 / 7–9 月 夏 / 10–12 月 秋，顺序 冬→春→夏→秋
   * （与 Bangumi「1 月 = 冬番」一致）。完整规则与换算都在 @shared/season 里，
   * 与主进程取数用的是同一份定义，不会出现「文案说春季、实际查的是别的月份」。
   */
  const currentSeasonLabel = useMemo(() => {
    const { year, season } = seasonOfDate(new Date())
    return seasonLabel(year, season)
  }, [])

  // 本周日期范围（上一周/下一周按钮已移除，weekOffset 恒为 0；
  // 周区间只是「这周是什么时候」的弱提示，放在底栏而不是主标题里）
  const weekRange = useMemo(() => {
    const mon = mondayOf(weekOffset)
    return `${mon.format('MM月DD日')} ~ ${mon.add(6, 'day').format('MM月DD日')}`
  }, [weekOffset])

  return (
    <div className="flex h-full flex-col">
      {/* 顶部导航：日期 + 季节 + 星期切换 */}
      <div className="flex items-center gap-3 border-b border-border bg-elev1/70 px-5 py-3 backdrop-blur">
        <div className="min-w-[120px] text-center">
          <div className="text-sm font-semibold">
            {headerDate.d.format('YYYY年MM月DD日')}
            {headerDate.isToday && <span className="ml-1 text-xs font-normal text-accent">今天</span>}
          </div>
          {/* 原「第 N 周」文案的位置，现在显示本季新番季名 */}
          <div className="text-[11px] text-faint">{currentSeasonLabel}</div>
        </div>
        <div className="flex flex-1 items-center justify-center gap-1">
          {WEEKDAY_CN.map((label, i) => {
            const id = i + 1
            const count = dayCount(id)
            const active = id === selectedDay
            return (
              <button
                key={id}
                onClick={() => selectDay(id)}
                className={`relative flex h-9 min-w-[64px] flex-col items-center justify-center rounded-lg px-2 text-xs transition-colors ${
                  active ? 'text-accent' : 'text-dim hover:bg-elev2'
                }`}
              >
                {active && (
                  <motion.div layoutId="day-pill" className="absolute inset-0 rounded-lg bg-accent-soft" />
                )}
                <span className="relative z-10">{label}</span>
                {count > 0 && <span className="relative z-10 text-[10px] text-faint">{count} 部</span>}
              </button>
            )
          })}
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={RefreshCw}
          loading={loading}
          onClick={() => {
            void load(true).then(() => {
              if (!error) toast.success('番剧表已刷新')
            })
          }}
        >
          刷新
        </Button>
      </div>

      {/*
        番剧表的「显示范围」筛选条已按用户要求删除（v0.3.0：去掉番剧表中的显示范围）。
        原先这里有三个开关（隐藏已抛弃/已收藏/已看过的番剧）。
        过滤本身与设置字段（scheduleFilters）保留在代码里但界面不再暴露，
        这样旧数据不会报错，将来若要恢复只需把这段 UI 加回来。
      */}

      {/*
        番剧表屏蔽提示条（用户需求第 4 条）。
        被屏蔽的条目**既不渲染也不计数**，所以必须有一行说明「少了多少 / 去哪调 / 怎么看全部」，
        否则用户只会看到「番剧表怎么少了几部」而不知道是自己开的开关。
        只读配置、只提示，不影响其它页面。
      */}
      {isBlockingActive(blockCfg) ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-elev1/70 px-5 py-2 text-[11px] text-dim">
          <span className="flex items-center gap-1.5">
            <ShieldOff size={13} className="text-accent" />
            {showAllBlocked
              ? `已临时显示全部：其中 ${blockedCount} 部本应被番剧表设置屏蔽`
              : `已按番剧表设置屏蔽 ${blockedCount} 部（可到设置里调整）`}
          </span>
          {tagRulesOn ? (
            <span className="text-faint">
              标签缓存 {tagDone}/{weekIds.length}
              {tagFetching ? '（补齐中…）' : ''}
              {tagFailedCount > 0 ? ` · ${tagFailedCount} 部未取到标签（不屏蔽）` : ''}
            </span>
          ) : null}
          <span className="flex-1" />
          <span className="flex items-center gap-1.5">
            临时显示全部
            <Switch checked={showAllBlocked} onChange={setShowAllBlocked} />
          </span>
          <button
            onClick={openBlockSettings}
            className="rounded-lg border border-border px-2 py-1 text-[11px] text-dim transition-colors hover:border-accent hover:text-accent whitespace-nowrap"
          >
            番剧表设置
          </button>
        </div>
      ) : null}

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading && days.length === 0 ? (
          <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : dayItems.length > 0 ? (
          <>
            {stale && error ? (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
                <CloudOff size={13} /> 数据源不可达，当前显示缓存数据（{fmtDateTime(fetchedAt)}）
              </div>
            ) : null}
            {visibleItems.length > 0 ? (
              <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {visibleItems.map((item: CalendarItem) => (
                  <AnimeCard
                    key={item.id}
                    item={{
                      id: item.id,
                      name: item.name,
                      nameCn: item.name_cn,
                      cover: item.images?.large ?? item.images?.common ?? null,
                      rating: ratings[item.id]?.score ?? item.rating?.score ?? null,
                      airDate: item.air_date
                    }}
                    fav={favorites.some((f) => f.subjectId === item.id)}
                    onFav={() => {
                      const wasFav = favorites.some((f) => f.subjectId === item.id)
                      toggleFavorite(item)
                      toast.success(wasFav ? '已取消收藏' : '已收藏')
                    }}
                    onClick={() => navigate(`/subject/${item.id}`)}
                    footer={item.air_date ? `开播 ${item.air_date.slice(0, 10)}` : undefined}
                  />
                ))}
              </div>
            ) : dayBlockedCount > 0 ? (
              /*
               * 本日的番剧被番剧表设置**全部**屏蔽了：
               * 给原因 + 两个出口（临时看全部 / 去改设置），而不是一个「没有符合条件的番剧」的冷冰冰空页。
               */
              <div className="flex flex-col items-center gap-2.5 py-16 text-center">
                <p className="text-sm text-dim">本日 {dayBlockedCount} 部番剧都被番剧表设置屏蔽了</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowAllBlocked(true)}>
                    临时显示全部
                  </Button>
                  <Button variant="ghost" size="sm" onClick={openBlockSettings}>
                    打开番剧表设置
                  </Button>
                </div>
              </div>
            ) : (
              /* 本日有番剧但被「显示范围」全部筛掉：给提示 + 一键恢复，而不是空列表 */
              <div className="flex flex-col items-center gap-2.5 py-16 text-center">
                <p className="text-sm text-dim">本日没有符合条件的番剧</p>
                <button
                  onClick={() => saveSettings({ scheduleFilters: { ...DEFAULT_SCHEDULE_FILTERS } })}
                  className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-dim transition-colors hover:border-accent hover:text-accent whitespace-nowrap"
                >
                  清除显示范围
                </button>
              </div>
            )}
          </>
        ) : error ? (
          <EmptyState
            icon={CloudOff}
            title="数据源连接失败"
            desc={error.message + (error.tried.length ? `（尝试: ${error.tried.join('；')}）` : '')}
          >
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => navigate('/settings')}>
                打开代理设置
              </Button>
              <Button size="sm" icon={RefreshCw} onClick={() => void load(true)}>
                重试
              </Button>
            </div>
          </EmptyState>
        ) : (
          <EmptyState icon={CalendarDays} title="当日暂无番剧信息" desc="切换上方星期查看其他日期的番剧表" />
        )}
      </div>

      {/* 底部：数据来源（本周日期范围作为弱提示留在这里） */}
      <div className="flex items-center justify-between border-t border-border bg-elev1/70 px-5 py-1.5 text-[11px] text-faint">
        <span>
          {/* v0.2.7 附加：走反代时统一显示「Bangumi」，不再把反代/镜像地址摊在界面上 */}
          {/*
            v0.3.2：主数据源全挂、本次番剧表是 Jikan/AniList 兜底来的，必须如实标出来。
            兜底数据的覆盖面比主源小（AniList 的季度模型只给「当季在播」），
            不标的话用户会以为「番剧变少了」。
          */}
          数据来源：
          {fallbackSource === 'jikan'
            ? 'Jikan / AniList 备用源（主数据源不可用）'
            : settings.bangumiCustomApi
              ? 'Bangumi'
              : settings.bangumiBase || 'Bangumi'}
          {` · 本周 ${weekRange}`}
          {fetchedAt ? ` · 缓存于 ${fmtDateTime(fetchedAt)}${fromCache ? '（本地缓存）' : ''}` : ''}
        </span>
        <span>图片与数据本地缓存，减少重复请求</span>
      </div>

      {/*
        数据源不可达提示（v0.2.7）。
        现在默认只使用自建反代、失败**不会**自动回退公共镜像（用户要求），
        所以这里必须给出一个明确的出口：直接打开「数据源配置」让用户切镜像或改反代地址。
      */}
      <Modal open={showVpnDialog} onClose={() => setShowVpnDialog(false)} title="无法连接数据源" width={470}>
        <div className="text-sm leading-relaxed text-dim">
          {settings.bangumiCustomApi ? (
            <>
              自建反代不可用：<span className="break-all font-mono text-[12px]">{settings.bangumiCustomApi}</span>
              <br />
              <br />
              应用默认只使用这个反代（避免在你不知情的情况下换源）。可以：
              <br />· 到「设置 → 数据源配置」检查反代地址是否写对、Worker 是否还在运行；
              <br />· 或把反代地址清空 / 改成其它镜像站，手动切换数据源。
            </>
          ) : (
            <>
              所有配置的 bangumi 镜像站均不可访问（{settings.bangumiMirrors.join('、')}）。
              <br />
              <br />
              是否开启 VPN 代理，或自行配置代理以连接 bangumi 主站？
            </>
          )}
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setShowVpnDialog(false)}>
            稍后再说
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setShowVpnDialog(false)
              navigate('/settings')
            }}
          >
            去配置代理
          </Button>
          <Button
            onClick={() => {
              setShowVpnDialog(false)
              // 数据源配置是小窗口页面（与设置页里的入口一致）
              void api.window.openSmall('/datasource', { width: 760, height: 620, title: '数据源配置' })
            }}
          >
            切换镜像站
          </Button>
        </div>
      </Modal>
    </div>
  )
}

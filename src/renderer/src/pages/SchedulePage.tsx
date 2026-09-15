import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, CalendarDays, CloudOff, RefreshCw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { CalendarItem } from '@shared/types'
import { useSchedule } from '@/stores/schedule'
import { useLibrary } from '@/stores/library'
import { useSettings } from '@/stores/app'
import { fmtDateTime, weekdayDate, WEEKDAY_CN } from '@/lib/format'
import { AnimeCard } from '@/components/AnimeCard'
import { Button, EmptyState, Modal } from '@/components/ui'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'

function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-elev1">
      <div className="aspect-[3/4] animate-pulse bg-elev2" />
      <div className="space-y-2 p-2.5">
        <div className="h-3 w-4/5 animate-pulse rounded bg-elev2" />
        <div className="h-2.5 w-2/5 animate-pulse rounded bg-elev2" />
      </div>
    </div>
  )
}

export function SchedulePage() {
  const navigate = useNavigate()
  const { days, loading, error, fetchedAt, fromCache, stale, selectedDay, weekOffset, ratings, load, loadRatings, selectDay, shiftWeek } = useSchedule()
  const favorites = useLibrary((s) => s.favorites)
  const toggleFavorite = useLibrary((s) => s.toggleFavorite)
  const settings = useSettings((s) => s.settings)
  const [showVpnDialog, setShowVpnDialog] = useState(false)

  const dayItems = useMemo(() => {
    const day = days.find((d) => d.weekday.id === selectedDay)
    return day?.items ?? []
  }, [days, selectedDay])

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

  return (
    <div className="flex h-full flex-col">
      {/* 顶部导航：日期 + 星期切换 */}
      <div className="flex items-center gap-3 border-b border-border bg-elev1/70 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => shiftWeek(-1)} title="上一周">
            <ChevronLeft size={14} />
          </Button>
          <div className="min-w-[110px] text-center">
            <div className="text-sm font-semibold">
              {headerDate.d.format('YYYY年MM月DD日')}
              {headerDate.isToday && <span className="ml-1 text-xs font-normal text-accent">今天</span>}
            </div>
            <div className="text-[11px] text-faint">第 {weekOffset === 0 ? '本周' : weekOffset > 0 ? `+${weekOffset} 周` : `${weekOffset} 周`}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => shiftWeek(1)} title="下一周">
            <ChevronRight size={14} />
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center gap-1">
          {WEEKDAY_CN.map((label, i) => {
            const id = i + 1
            const count = days.find((d) => d.weekday.id === id)?.items.length ?? 0
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
            <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {dayItems.map((item: CalendarItem) => (
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

      {/* 底部：数据来源 */}
      <div className="flex items-center justify-between border-t border-border bg-elev1/70 px-5 py-1.5 text-[11px] text-faint">
        <span>
          数据来源：{settings.bangumiBase}
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

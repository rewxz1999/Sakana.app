import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Clock3, Database, Eraser, RefreshCw } from 'lucide-react'
import type { TrafficDetailId, TrafficSnapshot, TrafficSourceId } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { Button } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'

/**
 * 数据源流量监控（V1.5.3，路由 `/traffic`）。
 *
 * 用户要求：「数据源流量监控 + 折线图」。
 *
 * 为什么单独一页而不是塞进「数据源配置」：那一页是小窗（720×560），
 * 而折线图 + 每个来源的明细需要横向空间；塞进去只能看个数字，看不出"什么时候、谁在用"。
 *
 * 数据全部来自主进程内存（`services/traffic.ts`）：2 秒轮询一次快照，不读盘、不联网。
 * 折线是**每 30 秒一个桶、最近 30 分钟**的速率（KB/s）；表格是本次运行的累计值。
 */

const SOURCE_COLOR: Record<TrafficSourceId, string> = {
  bangumi: '#60a5fa',
  image: '#34d399',
  mikan: '#fbbf24',
  danmaku: '#f472b6',
  site: '#a78bfa'
}

/** 番剧数据细分来源的配色（与上面主来源区分，但保持同一色系） */
const DETAIL_COLOR: Record<TrafficDetailId, string> = {
  api: '#60a5fa',
  online: '#22d3ee',
  mirror: '#818cf8',
  official: '#38bdf8'
}

const DETAIL_HINT: Record<TrafficDetailId, string> = {
  api: '内置双反代或自定义 API 反代',
  online: '在线数据库（详情 / 番剧表日历优先走它）',
  mirror: '网页镜像站（反代不可用时的兜底）',
  official: 'Bangumi 官方原站（直连模式）'
}

const SOURCE_HINT: Record<TrafficSourceId, string> = {
  bangumi: '番剧表 / 详情 / 评分 / 季度检索（内置反代、官方直连与在线库）',
  image: '封面与剧照（sakana-img 链路；命中本地缓存的会算在「省下」里）',
  mikan: '蜜柑计划的搜索与订阅 feed',
  danmaku: 'danmu_api 的搜索 / 剧集 / 评论',
  site: '规则播放页、嗅探、galgame 搜索等第三方站点'
}

/** 字节数：与设置页同一口径，但这里更强调"流量"而不是"磁盘占用" */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 速率：图表与表头都按 KB/s 口径（与播放器加载卡的写法一致），>1MB/s 才换单位 */
function fmtRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 KB/s'
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s`
}

function fmtClock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtDurationCN(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000))
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分钟`
}

/** 取一个"好看"的纵轴上限：1/2/5 × 10^n，避免刻度全是 37.42 这种数字 */
function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1024
  const exp = Math.floor(Math.log10(value))
  const base = Math.pow(10, exp)
  const n = value / base
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * base
}

interface ChartProps {
  snapshot: TrafficSnapshot
  hidden: Set<TrafficSourceId>
  onToggle: (id: TrafficSourceId) => void
}

/**
 * 折线图：纯 SVG，不引第三方图表库。
 *
 * 为什么手写：项目里没有任何图表依赖，为一张 60 点的折线引一个 100KB+ 的库不值当，
 * 而且主题色是 CSS 变量，第三方库的默认配色反而要额外覆盖。这里只需要折线、网格、悬停。
 */
function TrafficChart({ snapshot, hidden, onToggle }: ChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(760)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)))
    ro.observe(el)
    setWidth(Math.max(320, el.clientWidth))
    return () => ro.disconnect()
  }, [])

  const series = snapshot.series
  const seconds = Math.max(1, snapshot.bucketMs / 1000)
  /** 每个来源的速率数组（B/s） */
  const rates = useMemo(() => {
    const out = new Map<TrafficSourceId, number[]>()
    for (const s of snapshot.sources) out.set(s.id, series.map((b) => (b.bySource[s.id] ?? 0) / seconds))
    return out
  }, [series, snapshot.sources, seconds])

  const visible = snapshot.sources.filter((s) => !hidden.has(s.id))
  const maxRate = Math.max(
    1,
    ...visible.flatMap((s) => rates.get(s.id) ?? [])
  )
  const yMax = niceMax(maxRate)

  const H = 250
  const PAD = { left: 58, right: 18, top: 16, bottom: 28 }
  const plotW = Math.max(10, width - PAD.left - PAD.right)
  const plotH = H - PAD.top - PAD.bottom
  const n = series.length
  const x = (i: number): number => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW)
  const y = (v: number): number => PAD.top + plotH - Math.min(1, Math.max(0, v / yMax)) * plotH

  const grid = [0, 0.25, 0.5, 0.75, 1]
  const xTicks = [
    ...new Set(
      n <= 1
        ? [0]
        : [
            0,
            Math.floor((n - 1) / 4),
            Math.floor((n - 1) / 2),
            Math.floor(((n - 1) * 3) / 4),
            n - 1
          ]
    )
  ]
  const hoverIndex = hover != null ? Math.min(n - 1, Math.max(0, hover)) : null
  const hoverAt = hoverIndex != null ? series[hoverIndex] : null
  const hoverTotalRate = hoverAt ? hoverAt.totalBytes / seconds : 0
  const tooltipLeft = hoverIndex != null ? Math.min(Math.max(0, x(hoverIndex) - 100), Math.max(0, width - 210)) : 0

  const handleMove = (ev: React.MouseEvent<SVGSVGElement>): void => {
    const rect = ev.currentTarget.getBoundingClientRect()
    const mx = ev.clientX - rect.left
    if (mx < PAD.left - 8 || mx > width - PAD.right + 8) {
      setHover(null)
      return
    }
    const ratio = (mx - PAD.left) / plotW
    setHover(Math.round(ratio * (n - 1)))
  }

  return (
    <div>
      {/* 图例：点一下隐藏/显示某条线（线多时避免重叠看不清） */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {snapshot.sources.map((s) => {
          const off = hidden.has(s.id)
          return (
            <button
              key={s.id}
              type="button"
              title={SOURCE_HINT[s.id]}
              onClick={() => onToggle(s.id)}
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                off
                  ? 'border-border bg-transparent text-faint opacity-60'
                  : 'border-border bg-elev2/60 text-dim hover:border-accent/40'
              }`}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: off ? 'var(--color-faint, #888)' : SOURCE_COLOR[s.id] }}
              />
              {s.label}
            </button>
          )
        })}
        <span className="ml-auto text-[10px] text-faint">最近 30 分钟 · 每 30 秒一桶</span>
      </div>

      <div ref={wrapRef} className="relative w-full">
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
          className="block select-none"
        >
          {/* 横向网格 + 纵轴刻度 */}
          {grid.map((g) => {
            const rate = yMax * g
            const yy = y(g * yMax)
            return (
              <g key={g}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={yy}
                  y2={yy}
                  stroke="currentColor"
                  className="text-border"
                  strokeDasharray={g === 0 ? undefined : '3 5'}
                  strokeWidth={1}
                  opacity={0.8}
                />
                <text x={PAD.left - 8} y={yy + 3.5} textAnchor="end" className="fill-faint text-[10px]">
                  {rate > 0 ? fmtRate(rate).replace('/s', '') : '0'}
                </text>
              </g>
            )
          })}

          {/* 横轴时间 */}
          {xTicks.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={H - 8}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              className="fill-faint text-[10px]"
            >
              {fmtClock(series[i]?.at ?? snapshot.now)}
            </text>
          ))}

          {/* 折线：先画没命中的来源，最后画封面（通常点数最多） */}
          {[...visible]
            .sort((a, b) => (a.id === 'image' ? 1 : b.id === 'image' ? -1 : 0))
            .map((s) => {
              const arr = rates.get(s.id) ?? []
              const d = arr
                .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
                .join(' ')
              return (
                <path
                  key={s.id}
                  d={d}
                  fill="none"
                  stroke={SOURCE_COLOR[s.id]}
                  strokeWidth={1.8}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={0.95}
                />
              )
            })}

          {/* 悬停竖线 + 该时刻的点 */}
          {hoverIndex != null ? (
            <g>
              <line
                x1={x(hoverIndex)}
                x2={x(hoverIndex)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="currentColor"
                className="text-accent"
                strokeWidth={1}
                strokeDasharray="4 4"
                opacity={0.6}
              />
              {visible.map((s) => {
                const v = rates.get(s.id)?.[hoverIndex] ?? 0
                if (v <= 0) return null
                return <circle key={s.id} cx={x(hoverIndex)} cy={y(v)} r={2.4} fill={SOURCE_COLOR[s.id]} />
              })}
            </g>
          ) : null}
        </svg>

        {hoverAt ? (
          <div
            className="pointer-events-none absolute top-2 z-10 w-[200px] rounded-lg border border-border bg-elev1/95 p-2 text-[10px] shadow-lg backdrop-blur"
            style={{ left: tooltipLeft }}
          >
            <div className="mb-1 flex items-center justify-between text-faint">
              <span>{fmtClock(hoverAt.at)}</span>
              <span className="tabular-nums">{fmtRate(hoverTotalRate)}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              {visible.map((s) => {
                const v = rates.get(s.id)?.[hoverIndex ?? 0] ?? 0
                return (
                  <div key={s.id} className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: SOURCE_COLOR[s.id] }} />
                    <span className="min-w-0 flex-1 truncate text-dim">{s.label}</span>
                    <span className="tabular-nums text-faint">{v > 0 ? fmtRate(v) : '—'}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
      {/* 图例按钮既是开关也是说明；这里放一句更直白的提示，避免用户以为线掉了是 bug */}
      {hidden.size > 0 ? (
        <p className="mt-1 text-[10px] text-faint">
          已隐藏 {hidden.size} 个来源（点上方图例恢复）；悬停图表可以看某一刻各来源的速率。
        </p>
      ) : (
        <p className="mt-1 text-[10px] text-faint">悬停图表可以看某一刻各来源的速率；点图例可以隐藏/显示某条线。</p>
      )}
    </div>
  )
}

export function TrafficPage() {
  const [snapshot, setSnapshot] = useState<TrafficSnapshot | null>(null)
  const [resetting, setResetting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [hidden, setHidden] = useState<Set<TrafficSourceId>>(new Set())

  const load = async (): Promise<void> => {
    setRefreshing(true)
    const r = await api.traffic.snapshot()
    setRefreshing(false)
    if (r.ok) setSnapshot(r.data)
  }

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      const r = await api.traffic.snapshot()
      if (!alive) return
      if (r.ok) setSnapshot(r.data)
    }
    void tick()
    // 2 秒一次足够看出曲线在动；统计本身是纯内存读，不会给主进程添负担
    const timer = window.setInterval(() => void tick(), 2000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const toggle = (id: TrafficSourceId): void => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const reset = async (): Promise<void> => {
    setResetting(true)
    const r = await api.traffic.reset()
    setResetting(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    toast.success('流量统计已清空（只清计数，不动任何缓存文件）')
    void load()
  }

  const lastRate = (() => {
    if (!snapshot) return 0
    const last = snapshot.series[snapshot.series.length - 1]
    if (!last) return 0
    return last.totalBytes / Math.max(1, snapshot.bucketMs / 1000)
  })()
  const totalShare = Math.max(1, snapshot?.totals.bytes ?? 0)
  const detailTotal = Math.max(1, (snapshot?.details ?? []).reduce((n, d) => n + d.bytes, 0))

  return (
    <SubPage
      icon={Activity}
      title="流量监控"
      desc="按数据源统计本次运行的请求与流量，折线为最近 30 分钟的速率；统计数据只留在本机内存"
      maxWidth="max-w-5xl"
      actions={
        <>
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void load()} loading={refreshing}>
            刷新
          </Button>
          <Button size="sm" variant="outline" icon={Eraser} onClick={() => void reset()} loading={resetting}>
            清空统计
          </Button>
        </>
      }
    >
      {/* 概览四格 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl border border-border bg-elev1 p-3">
          <div className="text-[10px] text-faint">本次运行总流量</div>
          <div className="mt-1 text-lg font-bold tabular-nums text-accent">{fmtBytes(snapshot?.totals.bytes ?? 0)}</div>
          <div className="mt-0.5 text-[10px] text-faint">{(snapshot?.totals.requests ?? 0).toLocaleString()} 次请求</div>
        </div>
        <div className="rounded-xl border border-border bg-elev1 p-3">
          <div className="text-[10px] text-faint">最近 30 秒速率</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{fmtRate(lastRate)}</div>
          <div className="mt-0.5 text-[10px] text-faint">按最后一个时间桶平均</div>
        </div>
        <div className="rounded-xl border border-border bg-elev1 p-3">
          <div className="text-[10px] text-faint">缓存省下的流量</div>
          <div className="mt-1 text-lg font-bold tabular-nums text-ok">{fmtBytes(snapshot?.totals.cacheBytes ?? 0)}</div>
          <div className="mt-0.5 text-[10px] text-faint">
            {(snapshot?.totals.cacheHits ?? 0).toLocaleString()} 次命中（未走网络）
          </div>
        </div>
        <div className="rounded-xl border border-border bg-elev1 p-3">
          <div className="text-[10px] text-faint">运行时长 / 失败请求</div>
          <div className="mt-1 text-lg font-bold tabular-nums">
            {snapshot ? fmtDurationCN(snapshot.now - snapshot.startedAt) : '—'}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-faint">
            <Clock3 size={10} />
            {(snapshot?.totals.errors ?? 0).toLocaleString()} 次失败（超时 / 5xx）
          </div>
        </div>
      </div>

      {/* V1.5.4：番剧数据来源细分（API 反代 / 在线库 / 镜像站 / 官方原站） */}
      <Card
        title="番剧数据来源"
        desc="按实际出站请求细分流量；在线库与旧反代的流量分开看，便于判断该优化哪一条链路"
      >
        {snapshot ? (
          <div className="flex flex-col">
            {snapshot.details.map((d) => {
              const share = (d.bytes / detailTotal) * 100
              return (
                <div key={d.id} className="flex items-center gap-3 border-t border-border py-2 first:border-t-0">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: DETAIL_COLOR[d.id] }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-xs text-text">{d.label}</span>
                      <span className="text-sm font-semibold tabular-nums" style={{ color: DETAIL_COLOR[d.id] }}>
                        {fmtBytes(d.bytes)}
                      </span>
                      <span className="text-[10px] text-faint">{DETAIL_HINT[d.id]}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-elev3">
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${Math.min(100, share)}%`, background: DETAIL_COLOR[d.id] }}
                        />
                      </span>
                      <span className="w-10 text-right text-[10px] tabular-nums text-faint">
                        {d.bytes > 0 ? `${share.toFixed(1)}%` : '—'}
                      </span>
                    </div>
                  </div>
                  <div className="w-24 shrink-0 text-right text-[10px] leading-relaxed text-faint tabular-nums">
                    <div>{d.requests.toLocaleString()} 次请求</div>
                    {d.errors > 0 ? <div className="text-warn">{d.errors} 次失败</div> : <div>无失败</div>}
                  </div>
                </div>
              )
            })}
            {snapshot.details.every((d) => d.requests === 0) ? (
              <p className="pt-1 text-[10px] text-faint">还没有番剧数据请求：打开番剧表或条目详情后这里会开始统计。</p>
            ) : null}
          </div>
        ) : (
          <p className="text-[11px] text-faint">正在读取统计数据…</p>
        )}
      </Card>

      <Card
        title="流量折线"
        desc="纵轴是速率（KB/s），每 30 秒一个点；点图例可以只看某几个数据源"
        className="overflow-hidden"
      >
        {snapshot ? (
          <TrafficChart snapshot={snapshot} hidden={hidden} onToggle={toggle} />
        ) : (
          <div className="py-16 text-center text-[11px] text-faint">正在读取统计数据…</div>
        )}
      </Card>

      <Card title="分项统计" desc="本次运行的累计值；「省下」是命中本地图片缓存、没有走网络的字节数">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] border-collapse text-[11px]">
            <thead>
              <tr className="text-left text-faint">
                <th className="pb-2 font-normal">数据源</th>
                <th className="pb-2 text-right font-normal">请求</th>
                <th className="pb-2 text-right font-normal">流量</th>
                <th className="pb-2 text-right font-normal">占比</th>
                <th className="pb-2 text-right font-normal">缓存命中</th>
                <th className="pb-2 text-right font-normal">省下</th>
                <th className="pb-2 text-right font-normal">失败</th>
              </tr>
            </thead>
            <tbody>
              {(snapshot?.sources ?? []).map((s) => {
                const share = (s.bytes / totalShare) * 100
                return (
                  <tr key={s.id} className="border-t border-border">
                    <td className="py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SOURCE_COLOR[s.id] }} />
                        <span className="font-medium">{s.label}</span>
                      </div>
                      <div className="mt-0.5 max-w-[320px] text-[10px] leading-relaxed text-faint">{SOURCE_HINT[s.id]}</div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{s.requests.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{fmtBytes(s.bytes)}</td>
                    <td className="py-2 text-right tabular-nums">
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="h-1 w-12 overflow-hidden rounded-full bg-elev3">
                          <span
                            className="block h-full rounded-full"
                            style={{ width: `${Math.min(100, share)}%`, background: SOURCE_COLOR[s.id] }}
                          />
                        </span>
                        <span className="w-9 text-right">{s.bytes > 0 ? `${share.toFixed(1)}%` : '—'}</span>
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{s.cacheHits > 0 ? s.cacheHits.toLocaleString() : '—'}</td>
                    <td className="py-2 text-right tabular-nums text-ok">{s.cacheBytes > 0 ? fmtBytes(s.cacheBytes) : '—'}</td>
                    <td className={`py-2 text-right tabular-nums ${s.errors > 0 ? 'text-warn' : ''}`}>
                      {s.errors > 0 ? s.errors.toLocaleString() : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-2.5 text-[10px] leading-relaxed text-faint">
          <span className="inline-flex items-center gap-1">
            <Database size={10} /> 口径：应用内 API、封面图片、规则页与弹幕请求
          </span>
          <span>BT 下载不计入这里（下载器是独立进程，字节数在下载页看）。</span>
          <span>统计数据不落盘，重启应用后从零开始。</span>
        </div>
      </Card>
    </SubPage>
  )
}

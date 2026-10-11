import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Eraser } from 'lucide-react'
import type { StreamBoostMode, StreamBoostRecord, StreamBoostStatus } from '@shared/types'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { Button, Select } from '@/components/ui'
import { Card } from '@/components/SettingsShell'

/**
 * 在线播放加速器的设置内容（v0.3.9：从「下载与播放」页里搬出来，成为「在线播放设置」独立项的内容）。
 *
 * 三件事必须**如实**：
 * 1. 档位只影响下一次播放；当前这次是否在加速看主进程的实际会话（`boostStatus`）；
 * 2. 速率显示的是本机中转真正转发出去的字节（1 秒窗口 + 最近 5 秒平均），
 *    没有中转时它就不显示速率，而不是显示一个好看的假数字；
 * 3. 优化记录里的每个数字都来自真实测量，**量不到就显示「—」**（主进程给的是 null），
 *    图表不做平滑/插值 —— 柱高直接按实测速率画，趋势线只连「两次都测到速率」的记录，
 *    样本不足时**明说样本不足**，不补点画一条好看但没意义的线。
 *
 * 「只显示最近一条、其余折叠」（用户要求）：
 * 默认视图回答的是「上次加速到底有没有用」，所以对比图与记录都只渲染最近一条；
 * 想看历史/趋势要点「展开全部」。折叠状态**不持久化**是刻意的：
 * 设置页每次打开都该回到「最近一次」这个默认视图 —— 若记住展开态，
 * 用户下次进来会看到一屏历史，反而以为默认就是全展开（那是另一个默认值，不是这个功能的本意）。
 */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtRate(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps) || bps <= 0) return '—'
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`
}

function fmtMs(ms: number | null): string {
  return ms === null || !Number.isFinite(ms) ? '—' : `${Math.round(ms)}ms`
}

function fmtTime(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 提升百分比：只有两次速率都测到才算得出来，否则返回 null（界面显示「未测到」） */
function gainPct(r: StreamBoostRecord): number | null {
  if (!r.directRateBps || !r.boostedRateBps || r.directRateBps <= 0) return null
  return (r.boostedRateBps / r.directRateBps - 1) * 100
}

/** 提升徽章：正用 ok（成功色）、负用 warn；都是主题语义色，浅色/深色主题下都看得清 */
function GainBadge({ gain }: { gain: number | null }) {
  if (gain === null) return <span className="shrink-0 text-[10px] text-faint">未测到</span>
  return (
    <span
      className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${
        gain > 0 ? 'bg-ok/12 text-ok' : 'bg-warn/12 text-warn'
      }`}
    >
      {gain > 0 ? '+' : ''}
      {gain.toFixed(0)}%
    </span>
  )
}

/**
 * 单次会话的「直连 vs 加速」柱状对比。
 *
 * 为什么用两根横条而不是第三方图表库：这里要表达的就是「同一次播放、同一个源，
 * 两条路的速率差多少」，横条 + 同一把标尺最直观，也不给应用增加一个图表依赖。
 * 标尺取本组里最大的那个速率 —— 组内可比，跨组不该比（源不同）。
 * 颜色：直连=主题 `dim`（中性灰），加速=主题 `accent`（强调色），都不写死色值，
 * 因此浅色主题下同样是深灰 + 主题强调色，不会出现「白底白条」。
 */
function RateBars({ recs }: { recs: StreamBoostRecord[] }) {
  const usable = recs.filter((r) => r.directRateBps || r.boostedRateBps)
  if (usable.length === 0) {
    return <div className="text-[11px] text-faint">还没有可对比的会话（两次速率都测到才会画出来）</div>
  }
  const scale = Math.max(1, ...usable.map((r) => Math.max(r.directRateBps ?? 0, r.boostedRateBps ?? 0)))
  return (
    <div className="flex flex-col gap-2">
      {usable.map((r) => {
        const gain = gainPct(r)
        return (
          <div key={r.id} className="flex items-center gap-2">
            <div className="w-[92px] shrink-0 truncate text-[11px] text-dim" title={`${r.site} → ${r.host}`}>
              {r.host || r.site || '未知源'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="w-8 shrink-0 text-[10px] text-faint">直连</span>
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-elev3">
                  <div
                    className="h-2 rounded bg-dim"
                    style={{ width: `${r.directRateBps ? Math.max(2, (r.directRateBps / scale) * 100) : 0}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right text-[10px] text-faint">{fmtRate(r.directRateBps)}</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="w-8 shrink-0 text-[10px] text-accent">加速</span>
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-elev3">
                  <div
                    className="h-2 rounded bg-accent"
                    style={{ width: `${r.boostedRateBps ? Math.max(2, (r.boostedRateBps / scale) * 100) : 0}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right text-[10px] text-accent">{fmtRate(r.boostedRateBps)}</span>
              </div>
            </div>
            <div className="w-[52px] shrink-0 text-right">
              <GainBadge gain={gain} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * 提升趋势（最近若干次）。
 *
 * 只连「两次速率都测到」的记录；不足两个点就**明说样本不足**（默认只放最近一条时必然走到这一支），
 * 而不是补一个点画出一条好看但没意义的线。0% 处画一条基线（灰），线用强调色（currentColor）。
 */
function GainTrend({ recs, hint }: { recs: StreamBoostRecord[]; hint?: string }) {
  const pts = recs
    .map((r) => gainPct(r))
    .filter((g): g is number => g !== null)
    .reverse() // 记录是新→旧，趋势图按时间从左到右
    .slice(-12)
  if (pts.length < 2) {
    return (
      <div className="text-[11px] text-faint">
        样本不足：趋势需要至少 2 次「直连与加速速率都测到」的记录（当前 {pts.length} 次）
        {hint ? `　${hint}` : ''}
      </div>
    )
  }
  const W = 320
  const H = 48
  const PAD = 5
  const lo = Math.min(0, ...pts)
  const hi = Math.max(0, ...pts)
  const span = Math.max(1, hi - lo)
  const x = (i: number): number => PAD + (i * (W - PAD * 2)) / Math.max(1, pts.length - 1)
  const y = (v: number): number => H - PAD - ((v - lo) / span) * (H - PAD * 2)
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <div className="flex items-center gap-3">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="text-accent" role="img" aria-label="加速提升趋势">
        {/* 0% 基线：低于它说明这次加速反而更慢 */}
        <line x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)} stroke="currentColor" className="text-border" strokeWidth={1} />
        <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
        {pts.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={2} fill="currentColor" />
        ))}
      </svg>
      <div className="text-[10px] leading-relaxed text-faint">
        最近 {pts.length} 次
        <br />
        最高 {Math.max(...pts).toFixed(0)}% / 最低 {Math.min(...pts).toFixed(0)}%
      </div>
    </div>
  )
}

/** 一条记录的文字摘要（时间 / 源 / 形态 / 速率对比 / 首字节 / 决策成本 / 转发量 / 异常标记） */
function RecordRow({ r }: { r: StreamBoostRecord }) {
  const gain = gainPct(r)
  return (
    <div className="flex flex-col gap-0.5 border-t border-border py-1.5 first:border-t-0">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-dim">{fmtTime(r.at)}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-text" title={`${r.site} → ${r.host}`}>
          {r.host || r.site || '未知源'}
          {r.site && r.host ? <span className="text-faint">（站点 {r.site}）</span> : null}
        </span>
        <span className="shrink-0 rounded bg-elev2 px-1 py-0.5 text-[10px] text-faint">
          {r.kind === 'hls' ? 'HLS 预读' : 'Range 分段'} · {r.parallel} 路 · {r.mode === 'force' ? '强制' : '自动'}
        </span>
        <GainBadge gain={gain} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-faint">
        <span>
          速率 {fmtRate(r.directRateBps)} → {fmtRate(r.boostedRateBps)}
        </span>
        <span>
          首字节 源站 {fmtMs(r.directTtfbMs)} → 本机 {fmtMs(r.localTtfbMs)}
          {r.coldStartSavedMs !== null ? `（省 ${fmtMs(r.coldStartSavedMs)}）` : ''}
        </span>
        <span>决策+预热 {fmtMs(r.decisionMs)}</span>
        <span>转发 {fmtBytes(r.bytes)}</span>
        {r.degraded ? <span className="text-warn">中途退化为直连：{r.degraded}</span> : null}
        {r.segFailed > 0 ? <span className="text-warn">取片失败 {r.segFailed} 次</span> : null}
        {r.endedAt === null ? <span className="text-accent">进行中</span> : null}
      </div>
    </div>
  )
}

export function StreamBoostCard() {
  const { settings, save } = useSettings()
  const [boost, setBoost] = useState<StreamBoostStatus | null>(null)
  const [records, setRecords] = useState<StreamBoostRecord[]>([])
  const [clearing, setClearing] = useState(false)
  /** 是否展开全部记录：默认收起（只显示最近 1 条），取舍见文件头注释 */
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      const r = await api.player.boostStatus()
      if (!alive) return
      if (r.ok) setBoost(r.data)
    }
    void tick()
    // 按秒轮询：这只是主进程里的一小块内存状态，不发任何网络请求
    const timer = setInterval(() => void tick(), 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const r = await api.player.boostRecords()
      if (alive && r.ok) setRecords(r.data)
    }
    void load()
    /*
     * 5 秒拉一次：记录很少变（一次播放最多新增/更新一条），
     * 但「播放中途实时刷新那一条的速率」需要它 —— 比状态轮询慢，省得白读盘。
     */
    const timer = setInterval(() => void load(), 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const clearRecords = async (): Promise<void> => {
    setClearing(true)
    const r = await api.player.boostClearRecords()
    setClearing(false)
    if (r.ok) setRecords([])
  }

  const mode = settings.streamBoost ?? 'auto'
  const parallel = boost?.parallel ?? 0
  /** 默认只放最近一条；展开后按时间从新到旧全列（主进程已按上限 10 条截断） */
  const shown = expanded ? records : records.slice(0, 1)
  const canExpand = records.length > 1

  return (
    <>
      {/* ---------------- 档位与实时状态 ---------------- */}
      <Card
        title="在线播放加速"
        desc="拿到直链之后、交给播放器之前这一段：源站慢就用本机并发中转把它救回来（实测 MXdm 622→1018KB/s、baimao 592→966KB/s）"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-text">加速档位</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-faint">
              「自动」先量一次直连速度：够快就原样直连（多一层转发只会更慢），慢才启用并发中转 ——
              HLS 并发预读分片、整段文件并发 Range 分段分块拉取后按序汇流，视频数据不重编码、不改画质。
              源站不支持 Range 时整段文件自动退回单连接直连。
            </div>
          </div>
          <Select
            className="shrink-0"
            value={mode}
            onChange={(e) => void save({ streamBoost: e.target.value as StreamBoostMode })}
          >
            <option value="auto">自动（推荐）</option>
            <option value="off">关闭</option>
            <option value="force">强制加速</option>
          </Select>
        </div>

        {/* 真实状态：不按档位猜，读主进程的实际加速会话 */}
        <div className="mt-2.5 rounded-lg border border-border bg-elev2/60 px-2.5 py-2 text-[11px] leading-relaxed">
          {boost ? (
            <>
              <div className="text-text">
                {boost.active
                  ? `正在加速：${boost.kind === 'hls' ? 'HLS 并发预读' : '并发 Range 分段'} · ${parallel} 路并发`
                  : '当前没有在加速'}
              </div>
              {boost.active ? (
                <div className="mt-0.5 text-faint">
                  实时 {fmtRate(boost.rateBps)} · 最近 5 秒平均 {fmtRate(boost.avg5sBps)} · 已转发{' '}
                  {fmtBytes(boost.bytes)}
                  {boost.ttfbMs !== null ? ` · 首字节 ${boost.ttfbMs}ms` : ''}
                </div>
              ) : null}
              <div className="mt-0.5 text-faint">本次决定：{boost.reason}</div>
              {boost.origin ? <div className="mt-0.5 truncate text-faint">源：{boost.origin}</div> : null}
              {mode === 'off' && boost.active ? (
                <div className="mt-0.5 text-warn">
                  已改为「关闭」：当前这次播放继续走中转（中途换路会直接卡死），下次播放起生效
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-faint">读取加速状态…</div>
          )}
        </div>
      </Card>

      {/* ---------------- 优化记录与效果提升 ---------------- */}
      <Card
        title="优化记录与效果提升"
        desc="每次真正启用加速的真实测量结果（量不到的值显示「—」）。默认只看最近一次，其余折叠"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-text">效果提升对比</div>
          <div className="text-[10px] text-faint">柱高按实测速率、同一把标尺；加速速率含决策+预热</div>
        </div>
        <div className="mt-1.5">
          <RateBars recs={shown} />
        </div>
        <div className="mt-3">
          <div className="mb-1 text-[10px] text-faint">
            提升趋势（纵轴为提升百分比，灰线是 0%：低于它说明这次反而更慢）
          </div>
          <GainTrend recs={shown} hint={canExpand && !expanded ? '展开全部后可看多次趋势' : undefined} />
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-text">
              优化记录
              <span className="ml-1 text-[10px] font-normal text-faint">
                共 {records.length} 条（最多留 10 条，存 data/streamBoostLog.json）
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* 只有一条时没有可展开的东西，这个按钮就不出现（不留空按钮） */}
              {canExpand ? (
                <Button
                  size="sm"
                  variant="outline"
                  icon={expanded ? ChevronUp : ChevronDown}
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? '收起' : `展开全部（${records.length} 条）`}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                icon={Eraser}
                loading={clearing}
                disabled={records.length === 0}
                onClick={() => void clearRecords()}
              >
                清空记录
              </Button>
            </div>
          </div>
          <div className="mt-1">
            {shown.length === 0 ? (
              <div className="text-[11px] text-faint">
                还没有优化记录。真正启用加速并转发过 512KB 以上的播放才会留下一条 ——
                直连本来就够快的源不会被记录（因为那不算「优化」）。
              </div>
            ) : (
              shown.map((r) => <RecordRow key={r.id} r={r} />)
            )}
          </div>
          <div className="mt-1.5 text-[10px] leading-relaxed text-faint">
            清空只删历史；正在播的那一次播完仍会记下来（那是「现在正在发生的事」）。
          </div>
        </div>
      </Card>
    </>
  )
}

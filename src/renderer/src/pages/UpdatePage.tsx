import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Download, ExternalLink, Info, RefreshCw, Rocket, ShieldAlert } from 'lucide-react'
import dayjs from 'dayjs'
import type { UpdateInfo, UpdateInstallState } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { Button, Spinner } from '@/components/ui'

/**
 * 更新窗口（v0.2.12）——路由 `/update`，由 `window.openUpdateWindow()` 打开。
 *
 * 用户要求：「更新程序现在需要一个可视化界面让用户看到更新进度，更新程序现在也是一个
 * 十分重要、且优先级较高的模块」。所以这里不是设置页里的一个区块，而是一个独立界面：
 *
 *   · 顶部：当前版本 → 新版本，以及这次是**增量补丁还是完整安装包**（并显示体积对比）
 *   · 中部：更新说明（Release 正文），重要更新会带醒目提示
 *   · 下部：进度区 —— 阶段（检查 / 下载 / 校验 / 安装）、百分比、已下载/总量、
 *           **实时速度与预计剩余时间**（由两次进度推送的差值算出，不依赖主进程上报）
 *   · 底部：动作按钮（下载更新 / 立即重启更新 / 打开 Releases 页面）
 *
 * 更新状态由主进程推送（`onUpdateState`），窗口重新打开时先用 `updateState()` 取一次当前值，
 * 这样即使用户关掉窗口再打开，也能看到正在进行的下载。
 */
export function UpdatePage() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [phase, setPhase] = useState<UpdateInstallState>({ phase: 'idle' })
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 速度计算：记录上一次的 (时间, 已下载字节)，两次一减即可；不需要主进程额外上报
  const lastSample = useRef<{ at: number; received: number } | null>(null)
  const [speed, setSpeed] = useState(0)

  useEffect(() => {
    void api.app.updateState().then((r) => {
      if (r.ok) setPhase(r.data)
    })
    void api.app.checkUpdate().then((r) => {
      if (r.ok) setInfo(r.data)
      else setError(r.error)
    })
    return api.app.onUpdateState((s) => {
      setPhase(s)
      // 下载阶段顺便估算速度；不在下载阶段就清空，免得显示一个停在旧值的速度
      if (s.phase === 'downloading') {
        const now = Date.now()
        const prev = lastSample.current
        if (prev && now > prev.at) {
          const inst = ((s.received - prev.received) / (now - prev.at)) * 1000
          if (inst >= 0) setSpeed(inst)
        }
        lastSample.current = { at: now, received: s.received }
      } else {
        lastSample.current = null
        setSpeed(0)
      }
    })
  }, [])

  const check = (): void => {
    setChecking(true)
    setError('')
    void api.app.checkUpdate().then((r) => {
      if (r.ok) setInfo(r.data)
      else setError(r.error)
      setChecking(false)
    })
  }

  const download = (): void => {
    setBusy(true)
    void api.app.updateDownload().then((r) => {
      setBusy(false)
      if (!r.ok) toast.error(r.error)
      else if (!r.data.ok) toast.warn(r.data.message)
      else toast.success(r.data.message || '更新包已就绪')
    })
  }

  const install = (): void => {
    void api.app.updateInstall().then((r) => {
      if (!r.ok) toast.error(r.error)
      else if (!r.data.ok) toast.warn(r.data.message)
      else toast.info(r.data.message)
    })
  }

  const fmtMB = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`
  const fmtSpeed = (n: number): string => (n > 0 ? `${(n / 1024 / 1024).toFixed(2)} MB/s` : '—')
  const fmtEta = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—'
    if (seconds < 60) return `${Math.round(seconds)} 秒`
    const m = Math.floor(seconds / 60)
    return `${m} 分 ${Math.round(seconds - m * 60)} 秒`
  }

  const latest = info?.latest ?? ''
  const current = info?.current ?? ''
  const hasUpdate = info?.hasUpdate === true && !error
  const downloading = phase.phase === 'downloading'
  const percent =
    downloading && phase.total > 0 ? Math.min(100, Math.round((phase.received / phase.total) * 100)) : 0
  const eta = downloading && speed > 0 && phase.total > phase.received ? (phase.total - phase.received) / speed : 0
  // 有增量补丁时优先按补丁显示体积（和主进程的下载选择保持一致）
  const usingPatch = (info?.patchSize ?? 0) > 0
  const packSize = usingPatch ? (info?.patchSize ?? 0) : (info?.assetSize ?? 0)

  const stage = useMemo(() => {
    switch (phase.phase) {
      case 'downloading':
        return { text: `正在下载${usingPatch ? '增量补丁' : '安装包'}…`, tone: 'text-accent' }
      case 'done':
        return { text: '更新包已就绪，可以立即重启更新', tone: 'text-ok' }
      case 'installing':
        return { text: '正在安装（应用会退出并在覆盖完成后自动打开）…', tone: 'text-accent' }
      case 'failed':
        return { text: phase.reason === 'apply' ? '更新未完成' : '下载失败', tone: 'text-danger' }
      default:
        return { text: '等待开始', tone: 'text-faint' }
    }
  }, [phase, usingPatch])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {/* 顶部：版本对比 */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Rocket size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {hasUpdate ? `发现新版本 v${latest}` : '软件更新'}
            {info?.important && hasUpdate ? (
              <span className="flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] text-danger">
                <ShieldAlert size={11} /> 重要更新
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-[11px] text-faint">
            当前版本 v{current || '读取中…'}
            {info ? ` · 上次检查 ${dayjs(info.checkedAt).format('MM-DD HH:mm')}` : ''}
          </div>
        </div>
        <Button variant="outline" size="sm" icon={RefreshCw} loading={checking} onClick={check}>
          重新检查
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error ? (
          <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger">
            检查失败：{error}
          </div>
        ) : null}

        {hasUpdate ? (
          <>
            {/* 这次要下什么、比完整包省多少 */}
            <div className="rounded-xl border border-border bg-elev1 px-3 py-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-dim">
                  {usingPatch ? '增量更新（只下载变化的文件）' : '完整安装包'}
                </span>
                <span className="font-medium tabular-nums">{packSize ? fmtMB(packSize) : '体积未知'}</span>
              </div>
              {usingPatch && info?.assetSize ? (
                <div className="mt-1 text-[11px] text-faint">
                  相当于完整安装包 {fmtMB(info.assetSize)} 的{' '}
                  {Math.round((packSize / info.assetSize) * 100)}%，无需整体重下。
                </div>
              ) : null}
            </div>

            {/* 更新说明 */}
            {info?.notes ? (
              <div className="mt-3">
                <div className="mb-1 flex items-center gap-1 text-[11px] text-faint">
                  <Info size={12} /> 更新说明
                </div>
                <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-elev1 px-3 py-2 text-[11px] leading-relaxed text-dim">
                  {info.notes}
                </div>
              </div>
            ) : null}

            {/* 进度区：就是用户要的「看得见的更新进度」 */}
            <div className="mt-3 rounded-xl border border-border bg-elev1 px-3 py-3">
              <div className="flex items-center justify-between text-xs">
                <span className={stage.tone}>{stage.text}</span>
                <span className="tabular-nums text-dim">{downloading ? `${percent}%` : ''}</span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-elev3">
                <div
                  className={`h-full rounded-full transition-[width] duration-200 ${
                    phase.phase === 'failed' ? 'bg-danger' : 'bg-accent'
                  }`}
                  style={{ width: `${phase.phase === 'done' || phase.phase === 'installing' ? 100 : percent}%` }}
                />
              </div>
              {downloading ? (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dim">
                  <span className="tabular-nums">
                    {fmtMB(phase.received)} / {fmtMB(phase.total)}
                  </span>
                  <span className="tabular-nums">速度 {fmtSpeed(speed)}</span>
                  <span className="tabular-nums">剩余约 {fmtEta(eta)}</span>
                </div>
              ) : null}
              {phase.phase === 'failed' ? (
                <div className="mt-2 text-[11px] leading-relaxed text-danger">{phase.message}</div>
              ) : null}
            </div>

            {/* 动作 */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {phase.phase === 'done' || phase.phase === 'installing' ? (
                <Button size="sm" icon={Rocket} loading={phase.phase === 'installing'} onClick={install}>
                  {phase.phase === 'installing' ? '正在安装…' : `立即重启更新到 v${latest}`}
                </Button>
              ) : (
                <Button size="sm" icon={Download} loading={downloading || busy} onClick={download}>
                  {downloading ? '下载中…' : `${usingPatch ? '下载增量补丁' : '下载更新'}`}
                </Button>
              )}
              <Button variant="outline" size="sm" icon={ExternalLink} onClick={() => void api.app.updateOpenReleases()}>
                打开 Releases 页面
              </Button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-faint">
              下载完成后点「立即重启更新」：应用会退出，更新包在后台覆盖到安装目录（用户数据与设置都会保留），
              完成后自动重新打开。
            </p>
          </>
        ) : info && !error ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <CheckCircle2 size={28} className="text-ok" />
            <div className="text-sm">已是最新版本 v{current}</div>
            <div className="text-[11px] text-faint">启动时会自动检查一次；也可以在设置页手动检查。</div>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-10 text-xs text-faint">
            <Spinner size={14} /> 正在检查更新…
          </div>
        )}
      </div>
    </div>
  )
}

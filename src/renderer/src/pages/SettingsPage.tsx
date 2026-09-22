import { useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Camera,
  ChevronRight,
  CircleCheck,
  Database,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Rocket,
  Image,
  Info,
  MessagesSquare,
  MonitorPlay,
  RefreshCw,
  ScrollText,
  Wifi,
  WifiOff
} from 'lucide-react'
import type { UpdateInfo, UpdateInstallState } from '@shared/types'
import { api } from '@/lib/api'
import { fmtDateTime } from '@/lib/format'
import { toast, useSettings } from '@/stores/app'
import { THEME_PRESETS } from '@/theme'
import { Button, Input, Select, Spinner, Switch } from '@/components/ui'

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-elev1 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {desc ? <p className="mt-0.5 text-[11px] text-faint">{desc}</p> : null}
      </div>
      {children}
    </section>
  )
}

/** 统一入口行：图标 + 标题 + 一行说明 + 右侧箭头 */
function OpenRow({
  icon: Icon,
  title,
  desc,
  onOpen
}: {
  icon: LucideIcon
  title: string
  desc: string
  onOpen: () => void
}) {
  return (
    <button
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-elev2"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Icon size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-faint">{desc}</span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-faint transition-colors group-hover:text-accent" />
    </button>
  )
}

function RowDivider() {
  return <div className="my-1 border-t border-border" />
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 更新仓库（与主进程 services/updater.ts 的 REPO_SLUG 一致）；仅作主进程未返回 url 时的跳转兜底 */
const UPDATE_REPO_SLUG = 'rewxz1999/Sakana.app'
const UPDATE_REPO_URL = `https://github.com/${UPDATE_REPO_SLUG}`

/**
 * 「软件更新」区块：检查 GitHub Releases → **应用内一键更新**（v0.2.9 最后更新 / v0.2.10 增量补丁）。
 *
 * 用户要求：安装包传到 GitHub Releases，应用以后都从 git 检测更新包，直接在应用内一键更新。
 * v0.2.10 追加：用户要「安装包层面的小更新」—— 为此 release 里会同时传一份增量补丁
 * （`patch-<旧版本>-to-<新版本>.zip`，只含变化的文件）。有补丁时这里显示的就是
 * 「增量更新（x MB）」而不是几百 MB 的完整安装包，主进程负责下载 → 校验 → 覆盖安装目录。
 * 只有版本号、没有资产时（旧 version.json 通道）保留「前往下载」的兜底。
 *
 * 为什么不在挂载时自动检查：主进程启动后 8 秒已自动检查过一次，页面再触发一次纯属浪费。
 */
function UpdateSection({ version }: { version: string }) {
  // null = 本次进入设置页后还没有手动检查过（此时不展示「已是最新版本」以免误导）
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  // 下载/安装状态（主进程推送）：进度条、失败原因、完成提示都靠它
  const [phase, setPhase] = useState<UpdateInstallState>({ phase: 'idle' })
  const [busy, setBusy] = useState(false)
  // IPC 层失败（preload 返回 ok:false）与业务失败（info.error）分开存，前者不能覆盖上一次的有效结果
  const [ipcError, setIpcError] = useState('')

  const check = (): void => {
    setChecking(true)
    setIpcError('')
    // 主进程内部已 try/catch 并把失败写进 info.error，这里只需处理 IPC 自身异常
    void api.app.checkUpdate().then((r) => {
      if (r.ok) setInfo(r.data)
      else setIpcError(r.error)
      setChecking(false)
    })
  }

  // 进入页面时读一次当前下载状态（可能上次已经在下载了），并订阅后续推送
  useEffect(() => {
    void api.app.updateState().then((r) => {
      if (r.ok) setPhase(r.data)
    })
    return api.app.onUpdateState((s) => setPhase(s))
  }, [])

  // 用系统浏览器打开，避免更新下载页被应用内窗口拦截
  const openExternal = (url: string): void => {
    void api.app.openUrl(url)
  }

  const download = (): void => {
    setBusy(true)
    void api.app.updateDownload().then((r) => {
      setBusy(false)
      if (!r.ok) toast.error(r.error)
      else if (!r.data.ok) toast.warn(r.data.message)
      else toast.success(r.data.message || '更新包已下载完成，可以立即更新')
    })
  }

  const install = (): void => {
    void api.app.updateInstall().then((r) => {
      if (!r.ok) toast.error(r.error)
      else if (!r.data.ok) toast.warn(r.data.message)
      else toast.info(r.data.message)
    })
  }

  // 主进程返回的 current 来自 app.getVersion()，是权威值；渲染层单独取的版本号只作兜底
  const current = info?.current || version || '未知'
  // 业务错误与 IPC 错误合并成同一处提示；跳转地址始终回落到仓库首页，保证错误态也有出口
  const errorText = info?.error ?? ipcError
  const repoUrl = info?.url || UPDATE_REPO_URL
  // 注意：有错误时即使 hasUpdate 为 true 也按失败展示，避免给用户一个不可信的结果
  const hasUpdate = errorText === '' && info?.hasUpdate === true
  const latest = info?.latest ?? ''
  const notes = info?.notes ?? ''
  const downloading = phase.phase === 'downloading'
  const percent =
    downloading && phase.total > 0 ? Math.min(100, Math.round((phase.received / phase.total) * 100)) : 0
  const fmtMB = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`
  // v0.2.10：有增量补丁就按补丁走（几 MB），否则回落到完整安装包（几百 MB）
  const patchSize = info?.patchSize ?? 0
  const usingPatch = patchSize > 0
  const packSize = usingPatch ? patchSize : (info?.assetSize ?? 0)
  const packLabel = usingPatch ? '增量补丁' : '完整安装包'
  // 这次下的是哪种包：主进程已经决定了就听它的（避免「检查」和「下载」之间补丁被换掉导致文案撒谎）
  const doneMode = phase.phase === 'done' ? phase.mode : undefined
  const donePatch = doneMode ? doneMode === 'patch' : usingPatch

  return (
    <Section
      title="软件更新"
      desc={`应用启动时会自动检查一次；更新包来自 GitHub Releases（${UPDATE_REPO_SLUG}），有增量补丁时只需下载变化的文件即可在应用内一键更新。`}
    >
      <div className="flex flex-col gap-3">
        {/* 当前版本 + 手动检查入口 */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs text-dim">
              <Info size={13} className="text-accent" />
              当前版本 v{current}
            </div>
            <div className="mt-0.5 text-[11px] text-faint">
              {info ? `上次检查：${fmtDateTime(info.checkedAt)}` : '尚未手动检查'}
            </div>
          </div>
          <Button variant="soft" size="sm" icon={RefreshCw} loading={checking} onClick={check}>
            {checking ? '检查中' : '检查更新'}
          </Button>
        </div>

        {/* 请求中：按钮已由 loading 禁用，这里只补一条进度提示 */}
        {checking ? (
          <div className="flex items-center gap-2 text-[11px] text-faint">
            <Spinner size={12} /> 正在从仓库获取版本信息…
          </div>
        ) : null}

        {errorText ? (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-elev2 px-2.5 py-2">
            <div className="min-w-0 flex-1 pt-0.5 text-[11px] leading-relaxed text-danger">检查失败：{errorText}</div>
            <Button variant="outline" size="sm" icon={ExternalLink} onClick={() => openExternal(repoUrl)}>
              前往仓库
            </Button>
          </div>
        ) : hasUpdate ? (
          <div className="rounded-lg border border-accent/50 bg-accent-soft px-2.5 py-2">
            <div className="flex items-center gap-2 text-xs font-medium text-accent">
              <Download size={13} /> 发现新版本 v{latest}
            </div>
            {/* notes 来自 release 说明，可能自带多行内容，必须保留换行 */}
            {notes ? (
              <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-dim">
                {notes}
              </div>
            ) : null}

            {/* 下载进度：主进程按已收字节推送，这里只画条 */}
            {downloading ? (
              <div className="mt-2">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-elev3">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
                </div>
                <div className="mt-1 text-[11px] text-dim">
                  正在下载{packLabel}… {percent}%（{fmtMB(phase.received)} / {fmtMB(phase.total)}）
                </div>
              </div>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {phase.phase === 'done' || phase.phase === 'installing' ? (
                <Button size="sm" icon={Download} loading={phase.phase === 'installing'} onClick={install}>
                  {phase.phase === 'installing'
                    ? '正在安装…'
                    : donePatch
                      ? `立即重启更新到 v${latest}（增量）`
                      : `立即重启更新到 v${latest}`}
                </Button>
              ) : (
                <Button size="sm" icon={Download} loading={downloading || busy} onClick={download}>
                  {downloading
                    ? '下载中…'
                    : `${usingPatch ? '增量更新' : '下载更新'}（v${latest}${packSize ? ` · ${fmtMB(packSize)}` : ''}）`}
                </Button>
              )}
              <Button variant="outline" size="sm" icon={ExternalLink} onClick={() => void api.app.updateOpenReleases()}>
                打开 Releases 页面
              </Button>
              {/* v0.2.12：更新有了独立的可视化窗口（进度/速度/剩余时间），设置页留一个入口 */}
              <Button variant="ghost" size="sm" icon={Rocket} onClick={() => void api.app.updateOpenWindow()}>
                打开更新窗口
              </Button>
            </div>
            {/* 增量更新的说明：让用户知道为什么这次只有几 MB，以及和完整安装包的关系 */}
            {usingPatch ? (
              <div className="mt-1.5 text-[11px] leading-relaxed text-faint">
                本次为增量更新：只下载变化的文件（{fmtMB(patchSize)}），校验通过后自动覆盖到安装目录并重启，
                无需重新下载 {info?.assetSize ? fmtMB(info.assetSize) : '完整安装包'}。
              </div>
            ) : null}
            {phase.phase === 'failed' ? (
              <div className="mt-1.5 text-[11px] leading-relaxed text-danger">
                {phase.reason === 'apply' ? '更新未完成：' : '下载失败：'}
                {phase.message}（可点「打开 Releases 页面」手动下载）
              </div>
            ) : null}
            {!info?.canInstall ? (
              <div className="mt-1.5 text-[11px] leading-relaxed text-faint">
                这一版在 Releases 上没有找到 Windows 安装包或增量补丁，请到 Releases 页面手动下载。
              </div>
            ) : null}
          </div>
        ) : info ? (
          <div className="flex items-center gap-2 text-[11px] text-dim">
            <CircleCheck size={13} className="text-ok" /> 已是最新版本
          </div>
        ) : null}
      </div>
    </Section>
  )
}

export function SettingsPage() {
  const { settings, save, saveDeep } = useSettings()
  const [cacheBytes, setCacheBytes] = useState<number | null>(null)
  // 初始为空串：读取失败时显示「未知」，不谎报一个写死的版本号
  const [appVersion, setAppVersion] = useState('')

  const openSmall = (hash: string, width: number, height: number, title: string): void => {
    void api.window.openSmall(hash, { width, height, title })
  }

  useEffect(() => {
    void api.cache.info().then((r) => {
      if (r.ok) setCacheBytes(r.data.bytes)
    })
    void api.app.version().then((r) => {
      if (r.ok && r.data) setAppVersion(r.data)
    })
  }, [])

  const mainSource = settings.dataSources?.main || settings.bangumiBase || 'https://bangumi.pro'
  const mirrorCount = settings.dataSources?.mirrors?.length ?? settings.bangumiMirrors.length

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <h1 className="text-lg font-bold">设置</h1>

      <div className="mt-4 flex flex-col gap-4 pb-10">
        {/* 外观 */}
        <Section title="外观" desc="主题配色与界面外观">
          <div className="flex flex-col gap-3">
            <div>
              <div className="mb-2 text-[11px] text-faint">主题配色</div>
              <div className="flex gap-3">
                {THEME_PRESETS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => save({ theme: t.id })}
                    className={`group flex w-24 flex-col items-center gap-1.5 rounded-xl border p-2.5 transition-all ${
                      settings.theme === t.id ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent/50'
                    }`}
                  >
                    <span className="flex h-9 w-14 overflow-hidden rounded-lg border border-border">
                      <span className="w-1/2" style={{ background: t.swatch[0] }} />
                      <span className="w-1/2" style={{ background: t.swatch[1] }} />
                    </span>
                    <span className="text-[11px]">{t.label}</span>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.swatch[2] }} />
                  </button>
                ))}
              </div>
            </div>
            {/* v0.3.1：按用户要求删除「导航栏背景」设置项（连同页面、IPC 与主进程实现一并移除） */}
          </div>
        </Section>

        {/* 数据与存储 */}
        <Section title="数据与存储" desc="数据源、文件保存位置与缓存目录">
          <div className="flex flex-col">
            <OpenRow
              icon={Database}
              title="数据源配置"
              desc={`主数据源：${mainSource} · 镜像站 ${mirrorCount} 个`}
              onOpen={() => openSmall('/datasource', 720, 560, '数据源配置')}
            />
            <RowDivider />
            <OpenRow
              icon={FolderOpen}
              title="文件保存位置"
              desc="番剧下载 / 番剧截图 / galgame 截图保存目录"
              onOpen={() => openSmall('/save-dirs', 640, 520, '文件保存配置')}
            />
            <RowDivider />
            <OpenRow
              icon={HardDrive}
              title="缓存设置"
              desc={`图片 / 封面 / 条目缓存目录与清理 · 当前 ${
                cacheBytes == null ? '计算中…' : fmtBytes(cacheBytes)
              }`}
              onOpen={() => openSmall('/cache-settings', 640, 560, '缓存设置')}
            />
          </div>
        </Section>

        {/* 下载与播放 */}
        <Section title="下载与播放" desc="下载器、播放器内核与播放规则">
          <div className="flex flex-col">
            <OpenRow
              icon={Download}
              title="下载器配置"
              desc="内置 aria2 / 外部 qBittorrent / 双下载器，参数与连接测试"
              onOpen={() => openSmall('/downloader-config', 720, 600, '下载器配置')}
            />
            <RowDivider />
            <OpenRow
              icon={MonitorPlay}
              title="播放器设置"
              desc="播放内核（libmpv）、FFmpeg 路径与播放器快捷键"
              onOpen={() => openSmall('/player-settings', 700, 620, '播放器设置')}
            />
            <RowDivider />
            <OpenRow
              icon={MessagesSquare}
              title="弹幕设置"
              desc="弹幕开关、覆盖区域、同屏数量、时间轴、字号 / 透明度 / 速度与屏蔽词"
              onOpen={() => openSmall('/danmaku-settings', 640, 620, '弹幕设置')}
            />
            <RowDivider />
            <OpenRow
              icon={ScrollText}
              title="规则管理"
              desc="播放规则（Kazumi 风格：XPath / API），支持从 Kazumi 规则仓库导入"
              onOpen={() => openSmall('/rules', 800, 600, '规则管理')}
            />
          </div>
        </Section>

        {/* Galgame */}
        <Section title="Galgame" desc="游戏信息检测与截图助手">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs text-dim">
                  <Gamepad2 size={13} className="text-accent" />
                  游戏信息检测
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-faint">
                  开启后启动游戏时自动启用检测（不再弹窗询问）；通过系统读取游戏窗口标题记录进度（支线/章节），不开启则仅统计游玩时长
                </div>
              </div>
              <Switch checked={settings.galgameDetect} onChange={(v) => save({ galgameDetect: v })} />
            </div>
            <RowDivider />
            <OpenRow
              icon={Camera}
              title="Galgame 工具（截屏助手）"
              desc="游戏内截图快捷键、保存位置与悬浮拍摄按钮"
              onOpen={() => openSmall('/galgame/tools', 680, 600, 'Galgame 工具')}
            />
          </div>
        </Section>

        {/* 网络 */}
        <Section title="网络" desc="设置 HTTP / SOCKS 代理，用于访问 bangumi 主站或蜜柑计划">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-xs text-dim">
                {settings.proxy.enabled ? <Wifi size={13} className="text-ok" /> : <WifiOff size={13} className="text-faint" />}
                启用代理
              </span>
              <Switch
                checked={settings.proxy.enabled}
                onChange={(v) => saveDeep((s) => ({ ...s, proxy: { ...s.proxy, enabled: v } }))}
              />
            </div>
            {settings.proxy.enabled ? (
              <div className="grid grid-cols-4 gap-2.5">
                <Select
                  value={settings.proxy.type}
                  onChange={(e) => saveDeep((s) => ({ ...s, proxy: { ...s.proxy, type: e.target.value as 'http' | 'socks5' } }))}
                >
                  <option value="http">HTTP</option>
                  <option value="socks5">SOCKS5</option>
                </Select>
                <Input
                  className="col-span-2"
                  placeholder="主机 127.0.0.1"
                  value={settings.proxy.host}
                  onChange={(e) => saveDeep((s) => ({ ...s, proxy: { ...s.proxy, host: e.target.value } }))}
                />
                <Input
                  type="number"
                  placeholder="端口"
                  value={settings.proxy.port}
                  onChange={(e) => saveDeep((s) => ({ ...s, proxy: { ...s.proxy, port: Number(e.target.value) || 0 } }))}
                />
              </div>
            ) : null}
          </div>
        </Section>

        {/* 软件更新（紧跟「诊断与关于」之上，与「关于」信息相邻） */}
        <UpdateSection version={appVersion} />

        {/* 诊断与关于 */}
        <Section title="诊断与关于" desc="运行日志与应用信息">
          <div className="flex flex-col">
            <OpenRow
              icon={FileText}
              title="运行日志"
              desc="网络请求失败、下载器异常等错误记录，可复制用于反馈"
              onOpen={() => openSmall('/logs', 760, 560, '运行日志')}
            />
            <RowDivider />
            <OpenRow
              icon={Info}
              title="关于 Sakana"
              desc="版本、数据来源、目录与内置组件信息"
              onOpen={() => openSmall('/about', 620, 680, '关于 Sakana')}
            />
          </div>
        </Section>

        {/* 底部信息 */}
        <div className="flex flex-col items-center gap-1 pb-2 pt-1 text-center text-[11px] text-faint">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Database size={11} /> 数据源：{mainSource}
            </span>
            <span>版本 {appVersion ? `v${appVersion}` : '未知'}</span>
            <span>AI 编程助手：DeepSeek</span>
          </div>
          <span>数据优先本地缓存 · 图片与详情离线可读</span>
        </div>
      </div>
    </div>
  )
}

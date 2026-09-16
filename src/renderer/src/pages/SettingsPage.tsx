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
  Image,
  Info,
  MessagesSquare,
  MonitorPlay,
  RefreshCw,
  ScrollText,
  Wifi,
  WifiOff
} from 'lucide-react'
import type { UpdateInfo } from '@shared/types'
import { api } from '@/lib/api'
import { fmtDateTime } from '@/lib/format'
import { useSettings } from '@/stores/app'
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
 * 「软件更新」区块：手动检查 git 仓库版本 + 展示结果 + 跳转下载页。
 *
 * 为什么抽成独立组件而不是把 state 摊在 SettingsPage 里：
 * 检查状态（结果 / 进行中 / 错误）只服务于这一块 UI，放进页面顶层会与缓存、主题等
 * 无关逻辑互相干扰；抽出来后又与 Section / OpenRow 的写法保持一致。
 * 为什么不在挂载时自动检查：主进程启动后 8 秒已自动检查过一次，页面再触发一次纯属浪费。
 */
function UpdateSection({ version }: { version: string }) {
  // null = 本次进入设置页后还没有手动检查过（此时不展示「已是最新版本」以免误导）
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
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

  // 用系统浏览器打开，避免更新下载页被应用内窗口拦截
  const openExternal = (url: string): void => {
    void api.app.openUrl(url)
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

  return (
    <Section title="软件更新" desc={`应用启动时会自动检查一次；更新来自 GitHub 仓库 ${UPDATE_REPO_SLUG}。`}>
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
            {/* notes 来自 version.json，可能自带多行更新说明，必须保留换行 */}
            {notes ? (
              <div className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-dim">{notes}</div>
            ) : null}
            <div className="mt-2">
              <Button size="sm" icon={ExternalLink} onClick={() => openExternal(repoUrl)}>
                前往下载
              </Button>
            </div>
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
            <RowDivider />
            <OpenRow
              icon={Image}
              title="导航栏背景"
              desc="为左侧导航栏设置自定义背景图片（PNG/JPG/GIF/WEBP，≤ 8MB）"
              onOpen={() => openSmall('/nav-bg', 640, 560, '导航栏背景')}
            />
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
              desc="播放内核、FFmpeg / libVLC 路径与播放器快捷键"
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

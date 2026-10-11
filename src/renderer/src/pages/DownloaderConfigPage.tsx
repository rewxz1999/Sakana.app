import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, FolderOpen, RefreshCw, Rocket, XCircle } from 'lucide-react'
import type { PlayerAssets } from '@shared/api'
import type { AppSettings, QbitStatus } from '@shared/types'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, Input, Switch } from '@/components/ui'
import { AssetLink, Card, SubPage } from '@/components/SettingsShell'

function TestDownloader() {
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        icon={Download}
        loading={testing}
        onClick={async () => {
          setTesting(true)
          const r = await api.downloads.test()
          setTesting(false)
          if (r.ok) setStatus(r.data)
          else toast.error(r.error)
        }}
      >
        测试连接
      </Button>
      {status ? (
        <span className={`text-[11px] ${status.ok ? 'text-ok' : 'text-danger'}`}>
          {status.ok ? '✓ ' : '✗ '}
          {status.message}
        </span>
      ) : null}
    </div>
  )
}

type Mode = 'aria2' | 'qbit' | 'dual'

const MODES: { id: Mode; title: string; desc: string }[] = [
  { id: 'aria2', title: '仅内置 aria2', desc: '自动管理内置 aria2c 进程，通过 JSON-RPC 控制下载' },
  { id: 'qbit', title: '仅外部 qBittorrent', desc: '连接已运行的 qBittorrent，通过 Web API 控制下载' },
  { id: 'dual', title: '双下载器', desc: '同时启用 aria2 + qBittorrent，新任务自动分配给较空闲的一方以加速下载' }
]

/** 问题清单（实测踩过的坑，逐条写清楚现象与怎么办） */
const QBIT_TROUBLES: { title: string; body: string }[] = [
  {
    title: 'qb 没在运行 / 应用启动不了它',
    body: '现象：测试连接报「连不上 …（qBittorrent 没在运行，或 WebUI 端口/地址与设置不一致）」。先在设置里填好「qBittorrent 程序路径」，第一次下载时应用会弹窗征求许可，同意后它会把 qb 拉起来并等 WebUI 就绪；也可以在本页点「启动 qBittorrent」手动拉起。'
  },
  {
    title: '端口被占 / qb 自己换了端口',
    body: 'qb 默认 8080，安装时若 8080 已被占用会自动改用 8081（实测本机就是 8081）。地址必须与 qb「工具 → 选项 → WebUI」里的端口一致；本页在连不上时会自动探测 8080/8081/8085/8090/8888/9090，探测到就一键采用。'
  },
  {
    title: '用户名 / 密码不对，或本机免密没配好',
    body: '两种可用方式：① 在 qb 里勾选「WebUI → 对本机上的客户端跳过身份验证」，本机连接就不需要密码；② 不勾的话必须在应用里填与 qb 一致的用户名密码。注意登录失败次数过多 qb 会临时封禁，表现为 403。'
  },
  {
    title: '下载路径与 qb 的「文件保存配置」不一致',
    body: '应用会给每个任务指定保存目录（下载根目录 + 番剧名），qb 必须允许写入该路径。若 qb 里开了「按分类保存」或「默认保存路径」指向别的盘，qb 仍可能按自己的规则落盘——建议在 qb「选项 → 下载」里确认默认保存路径所在磁盘可写，并关闭「分类保存路径」的特殊设置。'
  },
  {
    title: '跨盘移动 / 任务卡在“移动中”',
    body: 'qb 完成后如果勾了「按分类移动到其它目录」而目标在不同磁盘，会先复制再删除，表现为长时间不动；应用会把这种状态显示为「解析中」。关掉 qb 的自动移动即可。'
  },
  {
    title: '做种 / 限速导致看起来“没速度”',
    body: 'qb 的全局限速、单任务限速、以及「做种到一定比例就停止」都会影响速度与完成判定。另外老番缺少做种者时，qb 状态是 stalledDL（应用显示「下载中 0%」），这与 aria2 的「正在寻找做种者」是同一个现象，不是应用故障。'
  },
  {
    title: '便携版路径每次变化',
    body: '便携版（PortableApps）的 qBittorrentPortable.exe 只是启动器，它拉起真正的 qbittorrent.exe 后自己就退出了，数据仍在便携目录里。程序路径请填 qBittorrentPortable.exe；换盘/换目录后要重新选一次。应用判断「启动成功」看的是 WebUI 是否就绪，不是启动器进程是否还在。'
  },
  {
    title: 'qb 版本差异（v4 与 v5 的接口不同）',
    body: '实测 qb 5.2.1（WebAPI 2.15.1）：登录成功返回 204 空响应（4.x 是 200 + “Ok.”）；暂停/继续的接口由 pause/resume 改名为 stop/start（旧名字返回 404）；添加任务改为异步返回 202（拿不到 hash，且重复添加不会新建任务）。应用已按“先试新接口、404 自动回退旧接口”和“用 infohash 识别任务”的方式兼容两代版本。'
  }
]

/**
 * 下载器配置小窗口（/downloader-config）
 * - 模式三选一：仅 aria2 / 仅 qBittorrent / 双下载器（写入 downloader.type + downloader.dual）
 * - qBittorrent 部分：程序路径（用文件对话框选 exe）、由应用启动、授权开关、真实状态与原因
 */
export function DownloaderConfigPage() {
  const { settings, saveDeep } = useSettings()
  const [assets, setAssets] = useState<PlayerAssets | null>(null)
  const [qb, setQb] = useState<QbitStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [launching, setLaunching] = useState(false)

  useEffect(() => {
    void api.player.assets().then((r) => {
      if (r.ok) setAssets(r.data)
    })
  }, [])

  const dual = settings.downloader.dual
  const mode: Mode = dual ? 'dual' : settings.downloader.type === 'qbit' ? 'qbit' : 'aria2'

  /** 读一次真实状态：能不能连、什么版本、路径对不对（连不上时带上中文原因与探测到的端口） */
  const refreshQbit = useCallback(async () => {
    setChecking(true)
    const r = await api.downloads.qbitStatus()
    setChecking(false)
    if (r.ok) setQb(r.data)
    else toast.error(r.error)
  }, [])

  useEffect(() => {
    // 只在用到 qb 的模式下拉取，避免纯 aria2 用户看到一堆无用请求
    if (mode !== 'aria2') void refreshQbit()
  }, [mode, refreshQbit])

  const setMode = (m: Mode): void => {
    saveDeep((s) => ({
      ...s,
      downloader: { ...s.downloader, type: m === 'qbit' ? 'qbit' : 'aria2', dual: m === 'dual' }
    }))
  }

  const patchQbit = (patch: Partial<AppSettings['downloader']['qbit']>): void => {
    saveDeep((s) => ({ ...s, downloader: { ...s.downloader, qbit: { ...s.downloader.qbit, ...patch } } }))
  }

  const pickExe = async (): Promise<void> => {
    const r = await api.dialog.pickExe(settings.downloader.qbit.exePath || undefined)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (r.data) {
      patchQbit({ exePath: r.data })
      toast.success('已记录 qBittorrent 程序路径')
      void refreshQbit()
    }
  }

  const launchNow = async (): Promise<void> => {
    setLaunching(true)
    const r = await api.downloads.qbitLaunch()
    setLaunching(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (r.data.ok) toast.success(r.data.message)
    else toast.error(r.data.message)
    void refreshQbit()
  }

  return (
    <SubPage icon={Download} title="下载器配置" desc="选择下载器模式、配置参数并测试连接">
      {/* 模式选择 */}
      <Card title="下载器模式" desc="三选一：内置 aria2 / 外部 qBittorrent / 双下载器同时启用">
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`flex-1 rounded-xl border px-4 py-3 text-left transition-colors ${
                  mode === m.id ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent/50'
                }`}
              >
                <div className="text-sm font-semibold">{m.title}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-faint">{m.desc}</div>
              </button>
            ))}
          </div>
          {dual ? (
            <div className="rounded-lg bg-accent-soft px-3 py-2 text-[11px] leading-relaxed text-dim">
              双下载器模式：两个下载器同时启用，新任务自动分配给「当前进行中任务较少」的一方（数量相同时优先内置
              aria2）。若任务被分给 qBittorrent 而它当前不可用（没运行 / 未授权启动），该任务会自动改用内置 aria2
              继续下载；每个任务实际用了哪个下载器，在下载列表的任务行里会标出来（暂停/继续/删除都按各自引擎执行）。
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2 text-[11px] leading-relaxed text-faint">
              当前仅启用{mode === 'aria2' ? '内置 aria2' : '外部 qBittorrent'}，另一方的参数仍会保留，切换模式后立即生效。
            </div>
          )}
        </div>
      </Card>

      {/* aria2 参数 */}
      {mode === 'aria2' || dual ? (
        <Card title="aria2 参数" desc="内置 aria2c 由应用自动启动，端口/密钥可按需修改">
          <div className="grid grid-cols-2 gap-2.5">
            <Input
              placeholder="RPC 主机"
              value={settings.downloader.aria2.host}
              onChange={(e) => saveDeep((s) => ({ ...s, downloader: { ...s.downloader, aria2: { ...s.downloader.aria2, host: e.target.value } } }))}
            />
            <Input
              type="number"
              placeholder="RPC 端口"
              value={settings.downloader.aria2.port}
              onChange={(e) => saveDeep((s) => ({ ...s, downloader: { ...s.downloader, aria2: { ...s.downloader.aria2, port: Number(e.target.value) || 6800 } } }))}
            />
            <Input
              type="number"
              placeholder="同时下载任务数（默认 5）"
              value={settings.downloader.aria2.maxConcurrent}
              onChange={(e) =>
                saveDeep((s) => ({
                  ...s,
                  downloader: { ...s.downloader, aria2: { ...s.downloader.aria2, maxConcurrent: Math.max(1, Number(e.target.value) || 5) } }
                }))
              }
            />
            <Input
              placeholder="RPC 密钥（可留空）"
              value={settings.downloader.aria2.secret}
              onChange={(e) => saveDeep((s) => ({ ...s, downloader: { ...s.downloader, aria2: { ...s.downloader.aria2, secret: e.target.value } } }))}
            />
            <Input
              className="col-span-2"
              placeholder="aria2c.exe 路径（留空使用内置）"
              value={settings.downloader.aria2.binaryPath}
              onChange={(e) => saveDeep((s) => ({ ...s, downloader: { ...s.downloader, aria2: { ...s.downloader.aria2, binaryPath: e.target.value } } }))}
            />
            <div className="col-span-2 text-[11px] text-faint">留空即使用随包内置的 aria2c；自行安装时请填写 aria2c.exe 的完整路径。</div>
          </div>
        </Card>
      ) : null}

      {/* qBittorrent 参数 */}
      {mode === 'qbit' || dual ? (
        <>
          <Card title="qBittorrent 参数（WebUI 连接）" desc="qb 的 WebUI 必须在 qb 里开启，端口要与下面地址一致">
            <div className="flex flex-col gap-2.5">
              {/* 真实状态：连不上时把原因写出来，不留假按钮 */}
              <div
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${
                  qb?.reachable ? 'border-ok/40 bg-ok/10' : 'border-danger/40 bg-danger/10'
                }`}
              >
                {qb?.reachable ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" />
                ) : (
                  <XCircle size={14} className="mt-0.5 shrink-0 text-danger" />
                )}
                <div className="min-w-0 flex-1 text-[11px] leading-relaxed">
                  {qb?.reachable ? (
                    <span className="text-ok">
                      已连接：{qb.version ?? 'qBittorrent'}
                      {qb.webapiVersion ? `（WebAPI ${qb.webapiVersion}）` : ''} · {qb.url}
                    </span>
                  ) : (
                    <span className="text-danger">{qb?.error ?? (checking ? '检测中…' : '尚未检测')}</span>
                  )}
                  {qb && !qb.reachable && qb.detectedPorts.length > 0 ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-dim">
                      <AlertTriangle size={12} className="text-warn" />
                      检测到本机 {qb.detectedPorts.map((p) => `127.0.0.1:${p}`).join('、')} 有 qBittorrent：
                      {qb.detectedPorts.map((p) => (
                        <Button
                          key={p}
                          size="sm"
                          variant="soft"
                          className="h-6"
                          onClick={() => {
                            patchQbit({ url: `http://127.0.0.1:${p}` })
                            setTimeout(() => void refreshQbit(), 300)
                          }}
                        >
                          改用 {p} 端口
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <Button size="sm" variant="ghost" icon={RefreshCw} loading={checking} className="h-6" onClick={() => void refreshQbit()}>
                  重新检测
                </Button>
              </div>

              <Input
                placeholder="qBittorrent 地址 http://127.0.0.1:8080"
                value={settings.downloader.qbit.url}
                onChange={(e) => patchQbit({ url: e.target.value })}
                onBlur={() => void refreshQbit()}
              />
              <div className="grid grid-cols-2 gap-2.5">
                <Input
                  placeholder="用户名（qb 里设置的）"
                  value={settings.downloader.qbit.username}
                  onChange={(e) => patchQbit({ username: e.target.value })}
                />
                <Input
                  placeholder="密码（qb 里设置的）"
                  type="password"
                  value={settings.downloader.qbit.password}
                  onChange={(e) => patchQbit({ password: e.target.value })}
                />
              </div>
              <div className="text-[11px] leading-relaxed text-faint">
                若在 qb 里勾选了「WebUI → 对本机上的客户端跳过身份验证」，用户名密码可以留空；
                否则必须与 qb 的 WebUI 账号一致。qb 默认地址是 <code>http://127.0.0.1:8080</code>，
                端口被占用时 qb 会自动更换（详见下方问题清单）。
              </div>
            </div>
          </Card>

          <Card title="由本应用启动 qBittorrent" desc="外部 qb 应用不会静默启动：需要你允许一次（可随时改成每次都问）">
            <div className="flex flex-col gap-2.5">
              <div className="flex gap-2">
                <Input
                  className="flex-1"
                  placeholder="qBittorrent 程序路径（便携版填 qBittorrentPortable.exe）"
                  value={settings.downloader.qbit.exePath ?? ''}
                  onChange={(e) => patchQbit({ exePath: e.target.value })}
                />
                <Button size="sm" variant="outline" icon={FolderOpen} className="h-9" onClick={() => void pickExe()}>
                  选择…
                </Button>
                <Button size="sm" variant="soft" icon={Rocket} className="h-9" loading={launching} onClick={() => void launchNow()}>
                  启动 qBittorrent
                </Button>
              </div>
              <div className="text-[11px] leading-relaxed text-faint">
                路径用于「下载器选择 qb / 双下载器时，由应用把它拉起来并等 WebUI 就绪再添加任务」。
                便携版请选 <code>qBittorrentPortable.exe</code>（它拉起真正的 qbittorrent.exe 后会自己退出，
                应用判断就绪看的是 WebUI，不是这个启动器进程）。qb 已经在运行时不会打扰你。
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-elev2/50 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs">每次下载前都询问是否启动 qBittorrent</div>
                  <div className="mt-0.5 text-[11px] text-faint">
                    {qb?.launchAuthorized
                      ? '已授权由本应用启动（点「启动」时记住的）；打开上面的开关则每次都问。'
                      : '当前未授权：下次需要启动时会弹一次询问框，同意后记住。'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={settings.downloader.qbit.askBeforeLaunch === true}
                    onChange={(v) => patchQbit({ askBeforeLaunch: v })}
                  />
                  {qb?.launchAuthorized ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-faint"
                      onClick={() => {
                        patchQbit({ launchAuthorized: false })
                        toast.info('已撤销启动授权，下次需要时会重新询问')
                        void refreshQbit()
                      }}
                    >
                      撤销授权
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </Card>

          <Card title="qBittorrent 模式下哪些功能可用" desc="与内置 aria2 的差异，实测结论（qb 5.2.1）">
            <ul className="flex flex-col gap-1.5 text-[11px] leading-relaxed text-dim">
              <li>✓ 任务进度与速度：直接读 qb 的 progress / dlspeed（实测 2.4~3.6 MB/s 正常显示）。</li>
              <li>✓ 对端与做种数：来自 qb 的 num_leechs / num_seeds，下载列表里同样能看到。</li>
              <li>✓ 暂停 / 继续：qb 5 用 stop/start（4.x 的 pause/resume 已移除），应用会自动匹配版本。</li>
              <li>✓ 删除任务：只从 qb 移除任务，磁盘文件保留（deleteFiles=false，与 aria2 口径一致）。</li>
              <li>
                <span className="text-warn">✗ 完成后自动整理命名</span>：这一步依赖 aria2 的文件列表接口，
                仅在内置 aria2 模式生效；qb 模式下文件保持资源原始文件名（例如
                <code>[KitaujiSub] Make Heroine ga Oosugiru! [12][WebRip][HEVC_AAC][CHS_JP&amp;CHT_JP].mkv</code>）。
              </li>
              <li>✗ 播放器内“边下边播”：两种下载器都要求任务完成后才播放（未完成的 .part 文件不会被列入播放列表）。</li>
            </ul>
          </Card>

          <Card title="怎么连上 qBittorrent（照做即可）">
            <ol className="flex flex-col gap-1.5 text-[11px] leading-relaxed text-dim">
              <li>1. 打开 qBittorrent，进入「工具 → 选项 → WebUI」。</li>
              <li>2. 勾选「Web 用户界面（远程控制）」，记下「端口」（默认 8080，被占用时 qb 会自己换，实测本机为 8081）。</li>
              <li>
                3. 设置用户名与密码；如果只在本机用，建议**同时勾选**「对本机上的客户端跳过身份验证（Bypass
                authentication for clients on localhost）」——这样应用连 127.0.0.1 不需要密码。
              </li>
              <li>4. 点「应用/确定」，确认 qb 顶部或托盘没有关闭 WebUI。</li>
              <li>5. 回到本页，把「qBittorrent 地址」写成 <code>http://127.0.0.1:&lt;上面的端口&gt;</code>，填好用户名密码（免密可留空），点「测试连接」。</li>
              <li>6. 在「由本应用启动 qBittorrent」里选择 qBittorrent 程序（便携版选 qBittorrentPortable.exe），这样没开着 qb 时应用能自动拉起它。</li>
              <li>7. 到订阅页点「确认下载」，或在番剧详情页点「下载」即可。</li>
            </ol>
          </Card>

          <Card title="可能出现的问题" desc="都是实测遇到过的，按现象对照处理">
            <div className="flex flex-col gap-2.5">
              {QBIT_TROUBLES.map((t) => (
                <div key={t.title} className="rounded-lg border border-border bg-elev2/50 px-3 py-2">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <AlertTriangle size={12} className="shrink-0 text-warn" />
                    {t.title}
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-faint">{t.body}</div>
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      <Card title="连接测试" desc="按当前模式检测下载器是否可用（qb 模式会顺带报告版本与 WebAPI 版本）">
        <TestDownloader />
      </Card>

      {/* 下载地址 */}
      <Card title="下载地址" desc="如需自行安装下载器，可从以下官方地址下载">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-elev2/50 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-dim">aria2（内置 aria2c）</div>
              <div className="mt-0.5 text-[11px] text-faint">
                {assets?.aria2 === false
                  ? '未检测到内置 aria2c，建议下载后把路径指向 aria2c.exe'
                  : '应用已内置 aria2c，通常无需下载'}
              </div>
            </div>
            <AssetLink
              asset="aria2"
              url="https://github.com/aria2/aria2/releases"
              label="github.com/aria2/aria2/releases"
              builtin={assets ? assets.aria2 : null}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-elev2/50 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-dim">qBittorrent（外部下载器）</div>
              <div className="mt-0.5 text-[11px] text-faint">
                外部下载器不随应用分发，需要自行安装；便携版同样可用（路径填 Portable 启动器）
              </div>
            </div>
            <button
              className="text-accent hover:underline whitespace-nowrap"
              onClick={() => void api.app.openPath('https://www.qbittorrent.org/download')}
            >
              qbittorrent.org/download
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-faint">
            提示：应用已内置 aria2c 与 FFmpeg、libmpv；若自行下载 aria2，解压后把「aria2c.exe 路径」指向该文件即可。
            点击 aria2 下载链接时，若检测到已内置会先提示「已内置，通常无需下载」，再次点击才会打开下载页。
          </p>
        </div>
      </Card>

      <p className="text-center text-[11px] text-faint">改动实时保存，与主设置页互通。</p>
    </SubPage>
  )
}

import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import type { PlayerAssets } from '@shared/api'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, Input } from '@/components/ui'
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

/**
 * 下载器配置小窗口（/downloader-config）
 * - 模式三选一：仅 aria2 / 仅 qBittorrent / 双下载器（写入 downloader.type + downloader.dual）
 */
export function DownloaderConfigPage() {
  const { settings, saveDeep } = useSettings()
  const [assets, setAssets] = useState<PlayerAssets | null>(null)

  useEffect(() => {
    void api.player.assets().then((r) => {
      if (r.ok) setAssets(r.data)
    })
  }, [])

  const dual = settings.downloader.dual
  const mode: Mode = dual ? 'dual' : settings.downloader.type === 'qbit' ? 'qbit' : 'aria2'

  const setMode = (m: Mode): void => {
    saveDeep((s) => ({
      ...s,
      downloader: { ...s.downloader, type: m === 'qbit' ? 'qbit' : 'aria2', dual: m === 'dual' }
    }))
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
              双下载器模式：两个下载器同时启用，新任务自动分配给当前进行中任务较少的一方。下面两栏分别配置 aria2 与 qBittorrent。
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
        <Card title="qBittorrent 参数" desc="需自行安装并运行 qBittorrent，且已开启 Web UI">
          <div className="grid grid-cols-3 gap-2.5">
            <Input
              className="col-span-3"
              placeholder="qBittorrent 地址 http://127.0.0.1:8080"
              value={settings.downloader.qbit.url}
              onChange={(e) => saveDeep((s) => ({ ...s, downloader: { ...s.downloader, qbit: { ...s.downloader.qbit, url: e.target.value } } }))}
            />
            <Input
              placeholder="用户名"
              value={settings.downloader.qbit.username}
              onChange={(e) => saveDeep((s) => ({ ...s, downloader: { ...s.downloader, qbit: { ...s.downloader.qbit, username: e.target.value } } }))}
            />
            <Input
              className="col-span-2"
              placeholder="密码"
              value={settings.downloader.qbit.password}
              onChange={(e) => saveDeep((s) => ({ ...s, downloader: { ...s.downloader, qbit: { ...s.downloader.qbit, password: e.target.value } } }))}
            />
          </div>
        </Card>
      ) : null}

      <Card title="连接测试" desc="按当前模式检测下载器是否可用">
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
              <div className="mt-0.5 text-[11px] text-faint">外部下载器不随应用分发，需要自行安装</div>
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

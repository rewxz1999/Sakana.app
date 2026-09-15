import { useEffect, useState } from 'react'
import { CheckCircle2, FolderOpen, Info, XCircle } from 'lucide-react'
import type { CacheInfo, PlayerAssets, SaveDirsInfo } from '@shared/api'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'
// 应用图标：resources/icon.png 只是打包资源，渲染层无法直接引用，
// 因此把同一份图标复制为渲染层静态资源由 Vite 打包（与 sidebar-art.png 同一做法）。
import appIcon from '@/assets/app-icon.png'

/** 版本号兜底（正常情况下由主进程 app.getVersion() 提供，避免多处硬编码漂移） */
const APP_VERSION_FALLBACK = '0.2.7'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs text-faint">{label}</span>
      <span className="min-w-0 flex-1 break-all text-right text-xs text-dim">{children}</span>
    </div>
  )
}

function AssetItem({ name, ok }: { name: string; ok: boolean | null }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-dim">{name}</span>
      <span className="flex items-center gap-1 text-[11px]">
        {ok == null ? (
          <span className="text-faint">检测中…</span>
        ) : ok ? (
          <>
            <CheckCircle2 size={12} className="text-ok" />
            <span className="text-ok">已内置</span>
          </>
        ) : (
          <>
            <XCircle size={12} className="text-danger" />
            <span className="text-danger">未内置</span>
          </>
        )}
      </span>
    </div>
  )
}

export function AboutPage() {
  const { settings } = useSettings()
  const [dataPath, setDataPath] = useState('')
  const [dirs, setDirs] = useState<SaveDirsInfo | null>(null)
  const [cache, setCache] = useState<CacheInfo | null>(null)
  const [assets, setAssets] = useState<PlayerAssets | null>(null)
  const [version, setVersion] = useState(APP_VERSION_FALLBACK)
  useEffect(() => {
    void api.app.version().then((r) => {
      if (r.ok && r.data) setVersion(r.data)
    })
  }, [])

  useEffect(() => {
    void api.app.dataPath().then((r) => {
      if (r.ok) setDataPath(r.data)
    })
    void api.saveDirs.info().then((r) => {
      if (r.ok) setDirs(r.data)
    })
    void api.cache.info().then((r) => {
      if (r.ok) setCache(r.data)
    })
    void api.player.assets().then((r) => {
      if (r.ok) setAssets(r.data)
    })
  }, [])

  const openDataDir = async (): Promise<void> => {
    const r = await api.app.openDataDir()
    if (!r.ok) toast.error(r.error)
    else if (r.data) toast.error(r.data)
  }

  const mainSource = settings.dataSources?.main || settings.bangumiBase || 'https://bangumi.pro'
  const mirrorCount = settings.dataSources?.mirrors?.length ?? settings.bangumiMirrors.length

  return (
    <SubPage icon={Info} title="关于 Sakana" desc="版本、数据来源、目录与内置组件信息" maxWidth="max-w-xl">
      {/* 版本 */}
      <div className="flex flex-col items-center gap-1 py-2 text-center">
        {/* 原本这里是一个 🐟 emoji 占位，改用打包内的应用封面图标，保证与任务栏/安装包图标一致 */}
        <img
          src={appIcon}
          alt="Sakana 应用图标"
          width={80}
          height={80}
          draggable={false}
          className="h-20 w-20 select-none rounded-2xl object-contain shadow-sm"
        />
        <div className="text-base font-bold">Sakana</div>
        <div className="text-xs text-faint">版本 v{version}</div>
        <div className="text-[11px] text-faint">番剧管理及播放桌面客户端</div>
      </div>

      {/* 数据来源 */}
      <Card title="数据来源" desc="番剧数据与 galgame 数据来源">
        <Row label="当前数据源">{mainSource}</Row>
        <div className="border-t border-border" />
        <Row label="镜像站数量">{mirrorCount} 个</Row>
        <div className="border-t border-border" />
        <Row label="番剧数据">Bangumi（bangumi.pro 等镜像站 / api.bgm.tv）</Row>
        <div className="border-t border-border" />
        <Row label="galgame 数据">月幕 galgame（ymgal.games）、VNDB</Row>
        <div className="border-t border-border" />
        <Row label="资源站">蜜柑计划（订阅 / 下载资源）</Row>
      </Card>

      {/* 目录 */}
      <Card title="目录" desc="数据、缓存与保存位置">
        <Row label="应用数据目录">
          <span className="font-mono text-[11px]">{dataPath || '读取中…'}</span>
        </Row>
        <div className="border-t border-border" />
        <Row label="缓存目录">
          <span className="font-mono text-[11px]">{cache?.dir ?? '读取中…'}</span>
        </Row>
        <div className="border-t border-border" />
        <Row label="下载目录">
          <span className="font-mono text-[11px]">{dirs?.downloadDir ?? '读取中…'}</span>
        </Row>
        <div className="border-t border-border" />
        <Row label="截图目录">
          <span className="font-mono text-[11px]">{dirs?.screenshotDir ?? '读取中…'}</span>
        </Row>
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="outline" icon={FolderOpen} onClick={() => void openDataDir()}>
            打开数据目录
          </Button>
        </div>
      </Card>

      {/* 内置组件 */}
      <Card title="内置组件" desc="随安装包一同分发，无需额外安装">
        <AssetItem name="libmpv（播放内核 / 默认推荐）" ok={assets?.mpv ?? null} />
        <div className="border-t border-border" />
        <AssetItem name="libVLC（播放内核 / 备选）" ok={assets?.vlc ?? null} />
        <div className="border-t border-border" />
        <AssetItem name="FFmpeg（转码 / 在线流中转）" ok={assets?.ffmpeg ?? null} />
        <div className="border-t border-border" />
        <AssetItem name="aria2c（内置下载器）" ok={assets?.aria2 ?? null} />
        <p className="mt-2 text-[11px] leading-relaxed text-faint">
          未内置时可在「播放器设置」「下载器配置」中填写自行安装的路径；libmpv 不可用时会自动回退 libVLC。
        </p>
      </Card>

      {/* 技术栈 */}
      <Card title="技术栈">
        <div className="flex flex-wrap gap-1.5">
          {['Electron', 'React', 'TypeScript', 'Vite', 'Node.js', 'libmpv', 'libVLC', 'aria2', 'FFmpeg'].map((t) => (
            <span key={t} className="rounded-full bg-elev2 px-2.5 py-0.5 text-[11px] text-dim">
              {t}
            </span>
          ))}
        </div>
      </Card>

      {/* 致谢 */}
      <Card title="致谢">
        <ul className="flex flex-col gap-1 text-xs text-dim">
          <li>应用使用 DeepSeek 构建</li>
          <li>galgame 数据来自月幕 galgame 与 VNDB</li>
          <li>番剧数据来自 Bangumi，资源来自蜜柑计划</li>
          <li>内置播放内核 libmpv 与 libVLC、内置下载器 aria2、转码组件 FFmpeg</li>
        </ul>
      </Card>
    </SubPage>
  )
}

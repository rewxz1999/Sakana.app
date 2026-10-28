import { useEffect, useState } from 'react'
import { CirclePlay, Download, FolderOpen, HardDrive, RefreshCw } from 'lucide-react'
import type { CacheInfo, SaveDirsInfo } from '@shared/api'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, Switch } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'

/**
 * 下载与播放（/playback-settings，v0.3.9 新增的设置项）。
 *
 * 用户原话：「将播放器设置中的一些板块拆出来，单独做成『下载与播放』中的设置选项」，
 * 并把范围点明为「与下载/播放行为相关的板块（下载和缓存相关、播放行为之类）」。
 *
 * 于是本页放两类东西：
 * 1. **播放行为开关** —— 从播放器设置里搬出来的「行为类」设置：
 *    · 在线播放剔除贴片广告（`settings.hlsAdFilter`）—— 之前这个开关在界面上**根本没有入口**，
 *      只有主进程 adFilter.ts 在读它，用户既看不到也改不了，正好归到这里；
 *    · 截图后自动复制到剪贴板（`settings.screenshotClipboard`）—— 原来埋在「音频」卡片最下面，
 *      它跟音频毫无关系，属于「播放/截图行为」，一并搬过来。
 * 2. **下载与缓存现状** —— 下载目录 / 缓存目录的真实路径与占用，以及通往
 *    「下载器配置」「文件保存位置」「缓存设置」的入口（不改这些设置本身，
 *    编辑入口仍在各自页面，避免同一个值出现两个可编辑的地方）。
 *
 * 所有字段名保持原样（hlsAdFilter / screenshotClipboard），老用户升级后设置原样生效。
 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 开关 + 标题 + 说明的一行（与弹幕设置页的排布一致，视觉上不突兀） */
function SwitchRow({
  title,
  desc,
  checked,
  onChange,
  extra
}: {
  title: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
  extra?: React.ReactNode
}) {
  return (
    <div className="border-t border-border py-2.5 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-text">{title}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-faint">{desc}</div>
        </div>
        <Switch checked={checked} onChange={onChange} />
      </div>
      {extra}
    </div>
  )
}

export function PlaybackSettingsPage() {
  const { settings, save } = useSettings()
  const [dirs, setDirs] = useState<SaveDirsInfo | null>(null)
  const [cache, setCache] = useState<CacheInfo | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    const [d, c] = await Promise.all([api.saveDirs.info(), api.cache.info()])
    setLoading(false)
    if (d.ok) setDirs(d.data)
    if (c.ok) setCache(c.data)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const openSmall = (hash: string, width: number, height: number, title: string): void => {
    void api.window.openSmall(hash, { width, height, title })
  }

  const openFolder = async (path: string): Promise<void> => {
    if (!path) return
    // openPath 的返回值是 shell 的错误文本（成功为空串），沿用其它设置页的处理方式
    const r = await api.app.openPath(path)
    if (!r.ok) toast.error(r.error)
    else if (r.data) toast.error(r.data)
  }

  const dual = settings.downloader.dual
  const engineName = (e: 'aria2' | 'qbit' | 'transmission'): string =>
    e === 'aria2' ? 'aria2' : e === 'qbit' ? 'qBittorrent' : 'Transmission'
  const dualPair = (() => {
    const picked = (settings.downloader.dualEngines ?? []).filter(
      (e): e is 'aria2' | 'qbit' | 'transmission' => e === 'aria2' || e === 'qbit' || e === 'transmission'
    )
    const uniq = [...new Set(picked)]
    return uniq.length === 2 ? uniq : (['aria2', 'qbit'] as ('aria2' | 'qbit' | 'transmission')[])
  })()
  const downloaderLabel = dual
    ? `双下载器（${dualPair.map(engineName).join(' + ')}）`
    : settings.downloader.type === 'qbit'
      ? '外部 qBittorrent'
      : settings.downloader.type === 'transmission'
        ? '外部 Transmission'
        : '内置 aria2'

  return (
    <SubPage
      icon={CirclePlay}
      title="下载与播放"
      desc="播放行为开关，以及下载 / 缓存用到哪些目录、当前用哪个下载器"
      maxWidth="max-w-2xl"
      actions={
        <Button size="sm" variant="outline" icon={RefreshCw} loading={loading} onClick={() => void refresh()}>
          刷新
        </Button>
      }
    >
      {/* ---------------- 播放行为 ---------------- */}
      <Card title="播放行为" desc="只影响播放时的行为，不改画质与音质（那些在「播放器设置」里）">
        <SwitchRow
          title="在线播放剔除贴片广告"
          desc="HLS 在线播放时按分片节奏剔除贴片广告（默认开启）。判据保守：只删被 #EXT-X-DISCONTINUITY 夹住的 4~60 秒短区段，判据不足时完全不改、直接回源原始播放列表，不会误删正片"
          checked={settings.hlsAdFilter !== false}
          onChange={(v) => save({ hlsAdFilter: v })}
        />
        <SwitchRow
          title="截图后自动复制到剪贴板"
          desc="在聊天/文档里直接 Ctrl+V 就能粘贴；同时会进入 Win+V 剪贴板历史。注意这会顶掉剪贴板里原有的内容（截图本身照常存盘）"
          checked={settings.screenshotClipboard !== false}
          onChange={(v) => save({ screenshotClipboard: v })}
        />
      </Card>

      {/* 在线播放加速已搬去独立设置项「在线播放设置」（v0.3.9 补充更新 /stream-boost-settings） */}

      {/* ---------------- 下载 ---------------- */}
      <Card title="下载" desc="下载器模式与文件落地位置（改这些要去各自的设置项）">
        <div className="flex items-center justify-between gap-3 border-b border-border pb-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-text">当前下载器：{downloaderLabel}</div>
            <div className="mt-0.5 text-[11px] text-faint">
              {dual ? '两个下载器同时启用，新任务自动分配给较空闲的一方' : '另一方的参数会保留，切换模式后立即生效'}
            </div>
          </div>
          <Button size="sm" variant="outline" icon={Download} onClick={() => openSmall('/downloader-config', 720, 600, '下载器配置')}>
            下载器配置
          </Button>
        </div>

        <div className="pt-2.5">
          <div className="text-xs text-text">下载保存位置</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-elev2 px-2 py-1 text-[11px] text-dim">
              {dirs?.downloadDir || '读取中…'}
            </code>
            <Button size="sm" variant="ghost" icon={FolderOpen} disabled={!dirs?.downloadDir} onClick={() => void openFolder(dirs?.downloadDir ?? '')}>
              打开
            </Button>
            <Button size="sm" variant="outline" onClick={() => openSmall('/save-dirs', 640, 520, '文件保存配置')}>
              修改位置
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            下载时会自动创建「番剧名」子文件夹；未配置时默认落在应用数据目录的 saves/downloads 下。
            番剧截图与 galgame 截图目录也在「文件保存位置」里。
          </p>
        </div>
      </Card>

      {/* ---------------- 缓存 ---------------- */}
      <Card title="缓存" desc="图片 / 封面 / 条目缓存占用与目录">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-text">
              当前占用 {cache ? fmtBytes(cache.bytes) : '计算中…'}
              {cache?.custom ? '（自定义目录）' : '（默认目录）'}
            </div>
            <code className="mt-1 block truncate rounded bg-elev2 px-2 py-1 text-[11px] text-dim">
              {cache?.dir || '读取中…'}
            </code>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost" icon={FolderOpen} disabled={!cache?.dir} onClick={() => void openFolder(cache?.dir ?? '')}>
              打开
            </Button>
            <Button size="sm" variant="outline" icon={HardDrive} onClick={() => openSmall('/cache-settings', 640, 560, '缓存设置')}>
              缓存设置
            </Button>
          </div>
        </div>
      </Card>

      <p className="text-center text-[11px] text-faint">
        播放画质（Anime4K 超分）、音频、画面比例与播放内核在「播放器设置」里；FFmpeg 路径在「高级设置」里；
        快捷键在「快捷键」里；弹幕在「弹幕设置」里。
      </p>
    </SubPage>
  )
}

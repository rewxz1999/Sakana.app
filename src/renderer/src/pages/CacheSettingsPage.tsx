import { useEffect, useState } from 'react'
import { FolderOpen, HardDrive, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import type { CacheInfo } from '@shared/api'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, ConfirmModal } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 缓存设置小窗口（/cache-settings）
 * - 自定义缓存目录（settings.cacheDir，'' = 默认 userData/cache），经 cache:set-dir 在主进程 mkdir -p
 * - 缓存占用统计与清理（cache:info / cache:clear / cache:junk-clear）均基于该目录
 */
export function CacheSettingsPage() {
  const { settings, save } = useSettings()
  const [info, setInfo] = useState<CacheInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)

  const refresh = async (): Promise<void> => {
    const r = await api.cache.info()
    if (r.ok) setInfo(r.data)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const pickDir = async (): Promise<void> => {
    setBusy(true)
    const r = await api.dialog.pickDir(settings.cacheDir || info?.dir || undefined)
    setBusy(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (!r.data) return
    // 先同步渲染层设置（save 会把完整设置写回 store），再由主进程保存并创建目录
    save({ cacheDir: r.data })
    const s = await api.cache.setDir(r.data)
    if (!s.ok) {
      toast.error(s.error)
      return
    }
    toast.success(`缓存目录已设置为 ${s.data.dir}`)
    await refresh()
  }

  const resetDir = async (): Promise<void> => {
    save({ cacheDir: '' })
    const s = await api.cache.setDir('')
    if (!s.ok) {
      toast.error(s.error)
      return
    }
    toast.success('已恢复默认缓存目录')
    await refresh()
  }

  const openDir = async (): Promise<void> => {
    if (!info?.dir) return
    const r = await api.app.openPath(info.dir)
    if (!r.ok) toast.error(r.error)
    else if (r.data) toast.error(r.data)
  }

  const doClear = async (): Promise<void> => {
    setClearing(true)
    const r = await api.cache.clear()
    setClearing(false)
    if (r.ok) {
      toast.success(`已清除 ${fmtBytes(r.data.bytes)}，番剧卡片与详情将重新加载`)
      await refresh()
    } else {
      toast.error(r.error)
    }
  }

  const doJunkClear = async (): Promise<void> => {
    const r = await api.cache.junkClear()
    if (r.ok) toast.success(`已清理 ${r.data} 个临时文件`)
    else toast.error(r.error)
  }

  const custom = (settings.cacheDir ?? '').trim().length > 0

  return (
    <SubPage
      icon={HardDrive}
      title="缓存设置"
      desc="图片/封面/条目缓存目录与缓存清理"
      actions={
        <Button size="sm" variant="outline" icon={RefreshCw} onClick={() => void refresh()}>
          刷新
        </Button>
      }
      maxWidth="max-w-xl"
    >
      {/* 缓存目录 */}
      <Card title="缓存目录" desc="图片缓存、封面缓存与条目 JSON 缓存存放位置">
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-dim">当前缓存根目录</span>
              <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] ${custom ? 'bg-accent-soft text-accent' : 'bg-elev2 text-faint'}`}>
                {custom ? '自定义' : '默认（userData/cache）'}
              </span>
            </div>
            <div className="mt-1 break-all font-mono text-[11px] text-accent">{info?.dir ?? settings.cacheDir ?? '读取中…'}</div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="soft" icon={FolderOpen} loading={busy} onClick={() => void pickDir()}>
              选择目录
            </Button>
            <Button size="sm" variant="outline" icon={RotateCcw} disabled={!custom} onClick={() => void resetDir()}>
              恢复默认
            </Button>
            <Button size="sm" variant="ghost" icon={FolderOpen} disabled={!info?.dir} onClick={() => void openDir()}>
              打开文件夹
            </Button>
          </div>

          <p className="text-[11px] leading-relaxed text-faint">
            选择新目录后主进程会立即创建（mkdir -p）并保存到 settings.cacheDir；留空 / 恢复默认则使用应用数据目录下的 cache。
            缓存目录变化后，新下载的图片与条目缓存写入新位置，旧缓存可通过下面的「清除本地缓存数据」删除。
            （galgame 封面固定保存在应用数据目录的 galgame-covers 中，不随本项变化。）
          </p>
        </div>
      </Card>

      {/* 缓存占用与清理 */}
      <Card title="缓存占用" desc="统计范围：图片缓存 + 封面缓存 + 条目 JSON 缓存">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-dim">当前占用 {info ? fmtBytes(info.bytes) : '计算中…'}</div>
              <div className="mt-0.5 text-[11px] text-faint">清除后番剧卡片图片与详情缓存将重新加载</div>
            </div>
            <Button variant="outline" icon={Trash2} loading={clearing} onClick={() => setConfirmClear(true)}>
              清除本地缓存数据
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-dim">清理临时文件</div>
              <div className="mt-0.5 text-[11px] text-faint">清理应用临时目录与系统临时目录下 sakana-* 临时文件</div>
            </div>
            <Button variant="ghost" icon={Trash2} onClick={() => void doJunkClear()}>
              清理临时文件
            </Button>
          </div>
        </div>
      </Card>

      <ConfirmModal
        open={confirmClear}
        title="清除本地缓存数据"
        message="将清除番剧卡片图片、封面与条目缓存，番剧卡片与详情将重新加载。确认继续？"
        confirmText="清除"
        danger
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void doClear()}
      />
    </SubPage>
  )
}

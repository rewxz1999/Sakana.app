import { useEffect, useState } from 'react'
import {
  Activity,
  Archive,
  Database,
  Download,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Image as ImageIcon,
  ListTree,
  RefreshCw,
  RotateCcw,
  Trash2
} from 'lucide-react'
import type { CacheDbStats, CacheInfo, StorageBreakdown } from '@shared/api'
import { CACHE_TIER_LABEL, cachePolicyRows, type CacheDbEntrySummary } from '@shared/cachePolicy'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, ConfirmModal } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'
import { CoverImage } from '@/components/CoverImage'

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 相对时间：缓存列表里"3 小时前"比时间戳好读，也不受时区影响 */
function fmtAgo(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '未知'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
  return `${Math.round(diff / 86_400_000)} 天前`
}

/** 档位徽标配色（收藏最醒目，其它随规则强弱递减） */
const TIER_CLS: Record<string, string> = {
  favorite: 'bg-accent-soft text-accent',
  season: 'bg-ok/15 text-ok',
  history: 'bg-warn/15 text-warn',
  recent: 'bg-elev2 text-faint'
}

/**
 * 缓存设置小窗口（/cache-settings）
 *
 * V1.5.1 起这一页同时也是「本地缓存数据库」的展示面板，用户点名的三项都要看得见：
 *   · 图片（cache/img）
 *   · 番剧信息（详情/角色/评分/集数 JSON）
 *   · 番剧缓存（番剧表/季度/搜索等列表 JSON + 索引）
 * 以及一条**按档位**的保留时间表（数字来自 `@shared/cachePolicy`，与清理器同一份常量）。
 *
 * 为什么把"最近加载过的条目"也放进来：用户要的是"能自己判断缓存有没有生效"。
 * 只给一个总字节数，他没法知道某部番到底在不在缓存里、属于哪一档、什么时候会被清。
 */
export function CacheSettingsPage() {
  const { settings, save } = useSettings()
  const [info, setInfo] = useState<CacheInfo | null>(null)
  const [stats, setStats] = useState<CacheDbStats | null>(null)
  const [storage, setStorage] = useState<StorageBreakdown | null>(null)
  const [entries, setEntries] = useState<CacheDbEntrySummary[]>([])
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    const [i, s, e, st] = await Promise.all([
      api.cache.info(),
      api.cache.dbStats(),
      api.cache.dbEntries(20),
      api.cache.storage()
    ])
    setRefreshing(false)
    if (i.ok) setInfo(i.data)
    if (s.ok) setStats(s.data)
    if (e.ok) setEntries(e.data)
    if (st.ok) setStorage(st.data)
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
    toast.success(`缓存目录已设置为 ${s.data.dir}（新缓存都会写到新目录）`)
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

  /** 打开存储占用里某一项的目录（路径由主进程给出，渲染层不自己拼） */
  const openStorage = async (path: string): Promise<void> => {
    if (!path) return
    const r = await api.app.openPath(path)
    if (!r.ok) toast.error(r.error)
    else if (r.data) toast.error(r.data)
  }

  const doPrune = async (): Promise<void> => {
    setPruning(true)
    const r = await api.cache.dbPrune()
    setPruning(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    const { subjects, images, lists, freedBytes } = r.data
    if (subjects + images + lists === 0) toast.success('没有过期缓存，无需清理')
    else toast.success(`已清理：${subjects} 项番剧信息、${images} 张图片、${lists} 个列表，释放 ${fmtBytes(freedBytes)}`)
    await refresh()
  }

  const doForget = async (entry: CacheDbEntrySummary): Promise<void> => {
    const r = await api.cache.dbForget(entry.id)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    toast.success(`已移除「${entry.title}」的缓存（${r.data.info} 个文件 / ${r.data.images} 张图）`)
    await refresh()
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
  const policy = cachePolicyRows()

  return (
    <SubPage
      icon={HardDrive}
      title="缓存设置"
      desc="本地缓存数据库：图片 / 番剧信息 / 番剧缓存，按保留策略自动清理"
      actions={
        <Button size="sm" variant="outline" icon={RefreshCw} loading={refreshing} onClick={() => void refresh()}>
          刷新
        </Button>
      }
      maxWidth="max-w-2xl"
    >
      {/* 缓存目录 */}
      <Card title="缓存目录" desc="图片、番剧信息、番剧缓存与索引都存放在这个目录下">
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-dim">当前缓存根目录</span>
              <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] ${custom ? 'bg-accent-soft text-accent' : 'bg-elev2 text-faint'}`}>
                {custom ? '自定义' : '默认（数据根/cache）'}
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
            选择新目录后主进程会立即创建并保存到设置；留空则使用数据根目录下的 cache。
            旧位置（老版本的 userData/cache）里的图片与条目缓存，会在启动时自动搬进新目录，不会丢。
          </p>
        </div>
      </Card>

      {/* 存储占用（V1.5.4：下载 / 截图 / galgame 解包 / 运行缓存） */}
      <Card
        title="存储占用"
        desc="除本地缓存数据库之外，应用还会占用这些目录；点「打开」可直接定位"
      >
        {!storage ? (
          <p className="text-[11px] text-faint">正在统计目录大小…（下载目录较大时需要几秒）</p>
        ) : (
          <div className="flex flex-col">
            {(
              [
                {
                  key: 'downloads' as const,
                  label: '下载到本地的番剧',
                  desc: '下载根目录（按番剧名分子文件夹）',
                  icon: Download
                },
                {
                  key: 'screenshots' as const,
                  label: '番剧截图',
                  desc: '播放器截图保存在的目录',
                  icon: ImageIcon
                },
                {
                  key: 'galgameShots' as const,
                  label: 'Galgame 截图',
                  desc: 'galgame 助手 / 沉浸模式截图目录',
                  icon: Gamepad2
                },
                {
                  key: 'galgameUnpack' as const,
                  label: 'Galgame 解包数据',
                  desc: '解包产物（立绘 / CG / 文本 / BGM）',
                  icon: Archive
                },
                {
                  key: 'runtime' as const,
                  label: '应用运行缓存',
                  desc: '边下边播临时媒体、弹幕临时文件与 Chromium 缓存',
                  icon: Activity
                }
              ] as const
            ).map((row) => {
              const Icon = row.icon
              const bytes = storage[row.key]
              return (
                <div key={row.key} className="flex items-center gap-3 border-t border-border py-2 first:border-t-0">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-elev2 text-dim">
                    <Icon size={13} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-xs text-text">{row.label}</span>
                      <span className="text-sm font-semibold tabular-nums text-accent">{fmtBytes(bytes)}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-faint" title={storage.paths[row.key]}>
                      {row.desc} · {storage.paths[row.key] || '未配置'}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={FolderOpen}
                    onClick={() => void openStorage(storage.paths[row.key])}
                  >
                    打开
                  </Button>
                </div>
              )
            })}
            <div className="mt-1 flex items-center justify-between border-t border-border pt-2.5 text-xs">
              <span className="text-dim">以上五项合计</span>
              <span className="font-semibold tabular-nums">{fmtBytes(storage.total)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-faint">
              <span>业务缓存（图片 / 番剧信息 / 列表）</span>
              <span className="tabular-nums">{fmtBytes(storage.cacheRoot)}</span>
            </div>
          </div>
        )}
      </Card>

      {/* 本地缓存数据库占用 */}
      <Card title="本地缓存数据库" desc="按用户的保留时间表自动清理；收藏与未过期的图片不会被删">
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-xs text-dim">
              合计占用 <span className="font-semibold text-accent">{fmtBytes(stats?.total ?? info?.bytes ?? 0)}</span>
            </div>
            <Button size="sm" variant="soft" icon={Archive} loading={pruning} onClick={() => void doPrune()}>
              立即清理过期
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-dim">
                <ImageIcon size={12} /> 图片
              </div>
              <div className="mt-1 text-sm font-semibold">{fmtBytes(stats?.images.bytes ?? 0)}</div>
              <div className="text-[10px] text-faint">{stats?.images.files ?? 0} 个文件</div>
            </div>
            <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-dim">
                <Database size={12} /> 番剧信息
              </div>
              <div className="mt-1 text-sm font-semibold">{fmtBytes(stats?.info.bytes ?? 0)}</div>
              <div className="text-[10px] text-faint">
                {stats?.info.subjects ?? 0} 部 / {stats?.info.files ?? 0} 个文件
              </div>
            </div>
            <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-dim">
                <ListTree size={12} /> 番剧缓存
              </div>
              <div className="mt-1 text-sm font-semibold">{fmtBytes((stats?.lists.bytes ?? 0) + (stats?.index.bytes ?? 0))}</div>
              <div className="text-[10px] text-faint">
                列表 {stats?.lists.files ?? 0} 个 · 索引 {fmtBytes(stats?.index.bytes ?? 0)}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint">
            <span>收藏 {stats?.favorites ?? 0} 部</span>
            <span>已停止加载（屏蔽/黑名单）{stats?.blocked ?? 0} 部</span>
            <span>已过期待清理 {stats?.expiredSubjects ?? 0} 部</span>
            <span>上次清理 {stats?.lastPruneAt ? fmtAgo(stats.lastPruneAt) : '本次启动后自动执行'}</span>
          </div>
        </div>
      </Card>

      {/* 保留策略 */}
      <Card title="保留时间表" desc="与清理器共用同一份常量，界面上的数字就是真实执行的标准">
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-[11px]">
            <thead className="bg-elev2/60 text-dim">
              <tr>
                <th className="px-3 py-2 text-left font-medium">档位</th>
                <th className="px-3 py-2 text-left font-medium">信息</th>
                <th className="px-3 py-2 text-left font-medium">图片</th>
                <th className="px-3 py-2 text-left font-medium">说明</th>
              </tr>
            </thead>
            <tbody>
              {policy.map((row) => (
                <tr key={row.tier} className="border-t border-border">
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${TIER_CLS[row.tier] ?? 'bg-elev2 text-faint'}`}>
                      {row.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-text">{row.keep}</td>
                  <td className="px-3 py-2 text-text">{row.imageKeep}</td>
                  <td className="px-3 py-2 text-faint">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-faint">
          图片一律比信息留得更久（数据量最大，重新下载也最贵）。被屏蔽或加入黑名单的番剧会**立即停止加载**并清理其信息。
        </p>
      </Card>

      {/* 最近加载过的条目 */}
      <Card title="最近加载过的番剧" desc="最多显示 20 部；「移除」会删掉它的信息与图片">
        {entries.length === 0 ? (
          <p className="text-[11px] text-faint">还没有缓存记录（打开番剧表或详情页后就会出现在这里）。</p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {entries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-2.5 py-1.5">
                <CoverImage src={entry.cover} className="h-9 w-7 shrink-0" rounded="rounded" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] text-text" title={entry.title}>
                    {entry.title}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-faint">
                    <span className={`rounded-full px-1.5 py-0.5 ${TIER_CLS[entry.tier] ?? 'bg-elev2 text-faint'}`}>
                      {CACHE_TIER_LABEL[entry.tier]}
                    </span>
                    <span>{entry.infoRemoved ? '信息已清理' : fmtBytes(entry.infoBytes)}</span>
                    <span>图 {fmtBytes(entry.imageBytes)}</span>
                    <span>{fmtAgo(entry.lastAccessAt)}</span>
                  </div>
                </div>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void doForget(entry)}>
                  移除
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 清理 */}
      <Card title="清理" desc="清除后番剧卡片与详情会重新加载">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-dim">清除全部本地缓存</div>
              <div className="mt-0.5 text-[11px] text-faint">图片、番剧信息、番剧缓存与索引一并清空（收藏列表本身不受影响）</div>
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
        message="将清除图片、番剧信息、番剧缓存与索引，番剧卡片与详情会重新加载（收藏列表本身不受影响）。确认继续？"
        confirmText="清除"
        danger
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void doClear()}
      />
    </SubPage>
  )
}

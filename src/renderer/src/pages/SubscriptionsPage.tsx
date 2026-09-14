import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Download, FolderOpen, Heart, Info, RefreshCw, Rss, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { DownloadTask, MikanItem, Subscription } from '@shared/types'
import { api } from '@/lib/api'
import { useSubs } from '@/stores/subs'
import { useSettings } from '@/stores/app'
import { useLibrary } from '@/stores/library'
import { toast } from '@/stores/app'
import { Badge, Button, ConfirmModal, EmptyState, IconButton, Modal, ProgressBar } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import { DownloadTaskList } from '@/components/DownloadTaskList'

function SubCard({ sub }: { sub: Subscription }) {
  const navigate = useNavigate()
  const { checkSub, checkingIds, updateChecks, removeSubscription, setSubFolder, downloads } = useSubs()
  const addSubHistory = useLibrary((s) => s.addSubHistory)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmUpdate, setConfirmUpdate] = useState(false)
  const checking = checkingIds.includes(sub.id)
  const check = updateChecks.find((u) => u.subId === sub.id)
  const activeDownloads = downloads.filter((d) => d.subscriptionId === sub.id && !['done', 'error'].includes(d.status))
  const doneCount = downloads.filter((d) => d.subscriptionId === sub.id && d.status === 'done').length

  const statusBadge = () => {
    if (activeDownloads.length > 0) return <Badge tone="accent">资源更新中 · {activeDownloads.length} 任务</Badge>
    if (sub.status === 'waiting') return <Badge tone="warn">发现新资源，待确认</Badge>
    if (sub.status === 'updating') return <Badge tone="accent">资源更新中</Badge>
    if (sub.episode != null) return <Badge tone="ok">已下载所有资源</Badge>
    return <Badge>尚未下载</Badge>
  }

  const playLocal = async () => {
    const r = await api.dialog.pickFolder(sub.folder ?? undefined)
    if (!r.ok) return
    if (!r.data) return
    const files = await api.media.listVideos(r.data)
    if (files.ok && files.data.length === 0) {
      toast.warn('该文件夹内没有找到视频文件')
      return
    }
    await setSubFolder(sub.id, r.data)
    navigate('/player', {
      state: { mode: 'local', title: sub.nameCn || sub.name, folder: r.data, subjectId: sub.subjectId }
    })
  }

  return (
    <motion.div layout className="flex gap-3.5 rounded-xl border border-border bg-elev1 p-3.5">
      <CoverImage src={sub.cover} className="h-28 w-20 shrink-0 rounded-lg" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="line-clamp-1 text-[15px] font-semibold">{sub.nameCn || sub.name}</div>
            <div className="mt-0.5 text-[11px] text-faint">
              字幕组：{sub.group ?? '未指定'} · 已下载 {doneCount > 0 ? `${doneCount} 个资源` : '—'}
              {sub.episode != null ? ` · 更新到第 ${sub.episode} 集` : ''}
            </div>
          </div>
          <div className="shrink-0">{statusBadge()}</div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            variant="soft"
            icon={RefreshCw}
            loading={checking}
            onClick={() => {
              void checkSub(sub.id).then((u) => {
                if (u && u.newItems.length > 0) toast.success(`《${sub.nameCn || sub.name}》发现 ${u.newItems.length} 个新资源`)
                else if (u) toast.info('暂无新资源')
              })
            }}
          >
            更新
          </Button>
          <Button size="sm" variant="outline" icon={FolderOpen} onClick={() => void playLocal()}>
            本地播放
          </Button>
          <Button size="sm" variant="ghost" icon={X} className="text-faint" onClick={() => setConfirmRemove(true)}>
            取消订阅
          </Button>
        </div>
        {sub.status === 'waiting' && check && check.newItems.length > 0 ? (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
            <Info size={12} className="shrink-0" />
            蜜柑计划检测到 {check.newItems.length} 个新资源
            <Button size="sm" variant="soft" className="ml-auto h-6" onClick={() => setConfirmUpdate(true)}>
              确认下载
            </Button>
          </div>
        ) : null}
      </div>
      <ConfirmModal
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="取消订阅"
        danger
        confirmText="取消订阅"
        message={`确定取消订阅《${sub.nameCn || sub.name}》吗？已下载的文件不会被删除。`}
        onConfirm={() => {
          void removeSubscription(sub.id)
          addSubHistory('unsubscribe', sub.nameCn || sub.name, '取消订阅')
          toast.info('已取消订阅')
        }}
      />
      <UpdateConfirmModal
        open={confirmUpdate}
        onClose={() => setConfirmUpdate(false)}
        sub={sub}
        items={check?.newItems ?? []}
      />
    </motion.div>
  )
}

function UpdateConfirmModal({
  open,
  onClose,
  sub,
  items
}: {
  open: boolean
  onClose: () => void
  sub: Subscription
  items: MikanItem[]
}) {
  const { confirmUpdate } = useSubs()
  const addSubHistory = useLibrary((s) => s.addSubHistory)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (open) setSelected(new Set(items.map((i) => i.guid)))
  }, [open, items])

  const toggle = (guid: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(guid)) next.delete(guid)
      else next.add(guid)
      return next
    })
  }

  return (
    <Modal open={open} onClose={onClose} title="确认下载新资源" width={560}>
      <div className="text-xs text-faint">
        《{sub.nameCn || sub.name}》 · 字幕组 {sub.group ?? '未指定'}，勾选要下载的资源（方案 4.2：经确认后才下载）
        <br />
        这里只添加下载任务，不会新建订阅（订阅已存在）。
      </div>
      <div className="mt-3 flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto pr-1">
        {items.map((item) => (
          <label
            key={item.guid}
            className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-elev2/50 px-3 py-2 hover:border-accent"
          >
            <input
              type="checkbox"
              checked={selected.has(item.guid)}
              onChange={() => toggle(item.guid)}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-xs leading-snug">{item.title}</div>
              <div className="mt-0.5 text-[10px] text-faint">
                {item.episode != null ? `第 ${item.episode} 集` : '集数未知'} · {item.size}
                {item.pubDate ? ` · ${new Date(item.pubDate).toLocaleDateString('zh-CN')}` : ''}
              </div>
            </div>
          </label>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          icon={Download}
          disabled={selected.size === 0}
          onClick={() => {
            const picked = items.filter((i) => selected.has(i.guid))
            /**
             * 「确认下载」= 纯下载：confirmUpdate 内部走 api.downloads.add（store/subs.ts），
             * 只往下载队列加任务、并把该订阅的集数往前推，不会新建订阅、也不会调用 subscribeAndDownload。
             * 订阅本身是本页/详情页的「订阅」按钮（api.downloads.subscribeOnly）负责的事，两条路径必须分开。
             */
            void confirmUpdate(sub, { subId: sub.id, newItems: picked, checkedAt: Date.now() }).then(() => {
              addSubHistory('download', sub.nameCn || sub.name, `确认下载 ${picked.length} 个新资源`)
              onClose()
            })
          }}
        >
          下载所选 {selected.size} 项
        </Button>
      </div>
    </Modal>
  )
}

export function SubscriptionsPage() {
  const { subscriptions, checkAll, checking, downloads } = useSubs()
  const settings = useSettings((s) => s.settings)
  const [downloaderStatus, setDownloaderStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const navigate = useNavigate()

  /**
   * 无订阅但有下载资源的番剧分组（与订阅卡片相近的下载卡片）。
   *
   * 筛选依据（v0.2.4 产品口径「仅下载的内容只在订阅页面出现下载卡片，订阅后出现订阅卡片」）：
   * 1. 「仅下载」不创建订阅（api.downloads.add 不带 subscriptionId），这类番剧在订阅页以虚线「下载卡片」出现；
   * 2. 同一部番剧一旦有订阅（按 subjectId 优先、退回番剧名匹配），它的下载任务就归上方订阅卡片
   *    （SubCard 已显示「资源更新中 · N 任务」与已下载数量），这里不再重复列一张下载卡片；
   * 3. 本筛选只决定左侧用哪种卡片呈现，不影响任务可见性：右侧「下载任务」栏的 DownloadTaskList
   *    展示全部下载任务（含订阅来源与仅下载），因此订阅页是下载任务唯一的归属页，其它页面不新增下载卡片。
   */
  const downloadGroups = useMemo(() => {
    const map = new Map<string, DownloadTask[]>()
    for (const d of downloads) {
      const key = d.subjectId != null ? `id:${d.subjectId}` : `name:${d.animeTitle}`
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(d)
    }
    return [...map.entries()].filter(([key]) => {
      if (key.startsWith('id:')) {
        const id = Number(key.slice(3))
        return !subscriptions.some((s) => s.subjectId === id)
      }
      const name = key.slice(5)
      return !subscriptions.some((s) => (s.nameCn || s.name) === name)
    })
  }, [downloads, subscriptions])

  const testDownloader = async () => {
    setTesting(true)
    const r = await api.downloads.test()
    setTesting(false)
    if (r.ok) setDownloaderStatus(r.data)
    else toast.error(r.error)
  }

  useEffect(() => {
    void testDownloader()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full">
      {/* 左侧：订阅列表 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border bg-elev1/70 px-5 py-3 backdrop-blur">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Rss size={15} className="text-accent" /> 我的订阅
            </div>
            <div className="mt-0.5 text-[11px] text-faint">
              启动时自动检测一次蜜柑计划新资源 · 手动「更新」随时检查
            </div>
          </div>
          <Button size="sm" variant="soft" icon={RefreshCw} loading={checking} onClick={() => void checkAll()}>
            检查全部更新
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {subscriptions.map((sub) => (
            <SubCard key={sub.id} sub={sub} />
          ))}
          {downloadGroups.length > 0 ? (
            <div className="pt-1">
              <div className="mb-2 text-xs font-semibold text-dim">
                已下载资源（仅下载 / 未订阅）
                <span className="ml-1.5 font-normal text-faint">
                  仅下载的资源不会创建订阅，因此以「下载卡片」呈现；订阅后同一番剧改由上方的订阅卡片呈现
                </span>
              </div>
              <div className="space-y-3">
                {downloadGroups.map(([key, tasks]) => {
                  const doneCount = tasks.filter((t) => t.status === 'done').length
                  const activeCount = tasks.filter((t) => !['done', 'error'].includes(t.status)).length
                  const first = tasks.find((t) => t.cover) ?? tasks[0]
                  const subjectId = key.startsWith('id:') ? Number(key.slice(3)) : (tasks.find((t) => t.subjectId)?.subjectId ?? null)
                  // 下载卡片也要能看到进度（产品要求：下载卡片含进度）：
                  // 与 DownloadTaskList 同一口径——未完成任务的进度取平均，全部完成记 100%
                  const progressTasks = tasks.filter((t) => !['done', 'error'].includes(t.status))
                  const progress =
                    progressTasks.length > 0
                      ? progressTasks.reduce((s, t) => s + (t.progress || 0), 0) / progressTasks.length
                      : doneCount > 0
                        ? 100
                        : 0
                  return (
                    <motion.div key={key} layout className="flex gap-3.5 rounded-xl border border-dashed border-border bg-elev1/70 p-3.5">
                      <CoverImage src={first?.cover} className="h-28 w-20 shrink-0 rounded-lg" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="line-clamp-1 text-[15px] font-semibold">{first?.animeTitle ?? '未知番剧'}</div>
                            <div className="mt-0.5 text-[11px] text-faint">
                              {doneCount > 0 ? `已下载 ${doneCount} 个资源` : '暂无已完成资源'}
                              {activeCount > 0 ? ` · ${activeCount} 个进行中` : ''}
                            </div>
                          </div>
                          {activeCount > 0 ? <Badge tone="accent">下载中</Badge> : doneCount > 0 ? <Badge tone="ok">已就绪</Badge> : null}
                        </div>
                        {/* 进度条：让「下载卡片」在订阅页也能看到完成度，不必只跳右侧任务栏 */}
                        <div className="mt-1.5 flex items-center gap-2">
                          <ProgressBar value={progress} className="max-w-[220px] flex-1" />
                          <span className="text-[11px] tabular-nums text-dim">{Math.round(progress)}%</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="soft"
                            icon={FolderOpen}
                            onClick={() => {
                              const dir = first?.dir
                              if (dir) {
                                navigate('/player', {
                                  state: { mode: 'local', title: first?.animeTitle ?? '', folder: dir, subjectId: subjectId ?? undefined }
                                })
                              } else {
                                toast.warn('未记录下载目录，请手动选择文件夹')
                              }
                            }}
                          >
                            本地播放
                          </Button>
                          {subjectId != null ? (
                            <Button size="sm" variant="outline" icon={Heart} onClick={() => navigate(`/subject/${subjectId}`)}>
                              去订阅
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </motion.div>
                  )
                })}
              </div>
            </div>
          ) : null}
          {subscriptions.length === 0 && downloadGroups.length === 0 ? (
            <EmptyState
              icon={Rss}
              title="还没有订阅番剧"
              desc="在番剧详情页点击「订阅」，从蜜柑计划选择字幕组资源后即可自动追踪更新"
            >
              <Button size="sm" onClick={() => navigate('/')}>
                去番剧表逛逛
              </Button>
            </EmptyState>
          ) : null}
        </div>
      </div>

      {/* 右侧：下载器 + 任务列表（方案 4.4） */}
      <div className="flex w-[360px] shrink-0 flex-col border-l border-border bg-elev1/50">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <Download size={14} className="text-accent" /> 下载器
            </span>
            <IconButton title="重新检测" onClick={() => void testDownloader()}>
              <RefreshCw size={13} className={testing ? 'animate-spin' : ''} />
            </IconButton>
          </div>
          <div className="mt-2 rounded-lg border border-border bg-elev1 px-3 py-2">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${downloaderStatus ? (downloaderStatus.ok ? 'bg-ok' : 'bg-danger') : 'bg-faint'}`}
              />
              <span className="text-xs font-medium">
                {settings.downloader.type === 'aria2' ? '内置 aria2' : '外部 qBittorrent'}
              </span>
            </div>
            <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-faint">
              {testing ? '检测中…' : (downloaderStatus?.message ?? '未检测')}
            </div>
            <button
              className="mt-1.5 text-[11px] text-accent hover:underline"
              onClick={() => navigate('/settings')}
            >
              下载器配置 →
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-sm font-semibold">下载任务</span>
          <Badge tone="neutral">实时刷新</Badge>
        </div>
        {/* 订阅页是下载任务的归属页：这里展示全部下载任务（订阅来源 + 仅下载），含进度条；
            其它页面（仪表盘）不新增下载卡片，只保留原有的「正在下载」汇总。 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <DownloadTaskList />
        </div>
      </div>
    </div>
  )
}

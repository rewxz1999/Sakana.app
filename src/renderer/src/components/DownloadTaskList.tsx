import { useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ListChecks, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { DownloadStatus, DownloadTask } from '@shared/types'
import { useSubs } from '@/stores/subs'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { Badge, EmptyState, IconButton, ProgressBar } from './ui'
import { CoverImage } from './CoverImage'

const STATUS_LABEL: Record<DownloadStatus, { text: string; tone: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' }> = {
  queued: { text: '排队中', tone: 'neutral' },
  parsing: { text: '解析中', tone: 'accent' },
  torrent: { text: '种子下载中', tone: 'warn' },
  downloading: { text: '下载中', tone: 'accent' },
  paused: { text: '已暂停', tone: 'neutral' },
  seeding: { text: '做种中', tone: 'ok' },
  done: { text: '已完成', tone: 'ok' },
  error: { text: '错误', tone: 'danger' }
}

const CONTROLLABLE: DownloadStatus[] = ['queued', 'parsing', 'torrent', 'downloading', 'seeding']

/** 打开番剧下载详情小窗口 */
export function openDownloadDetail(title: string): void {
  void api.window.openSmall(`/downloads-win?title=${encodeURIComponent(title)}`, {
    width: 680,
    height: 580,
    title: `${title} · 下载详情`
  })
}

/** 单任务行（详情小窗口与分组展开共用） */
export function TaskRow({ task }: { task: DownloadTask }) {
  const navigate = useNavigate()
  const st = STATUS_LABEL[task.status] ?? STATUS_LABEL.queued
  const done = task.status === 'done'
  const controllable = CONTROLLABLE.includes(task.status) || task.status === 'paused'

  const playLocal = (t: DownloadTask) => {
    if (!t.dir) {
      toast.warn('未记录下载目录，请在订阅页点击「本地播放」选择文件夹')
      return
    }
    navigate('/player', {
      state: {
        mode: 'local',
        title: t.animeTitle,
        folder: t.dir,
        subjectId: t.subjectId,
        episode: t.episode ?? undefined
      }
    })
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-elev1 p-2.5">
      <CoverImage src={task.cover} className="h-14 w-10 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-1 text-[13px] font-medium" title={task.name}>
          {task.name}
        </div>
        <div className="line-clamp-1 text-[11px] text-faint">
          {task.animeTitle}
          {task.episode != null ? ` · 第${task.episode}集` : ''}
          {task.group ? ` · ${task.group}` : ''}
        </div>
        {!done ? (
          <div className="mt-1.5 flex items-center gap-2">
            <ProgressBar value={task.progress} className="flex-1" />
            <span className="w-9 text-right text-[11px] tabular-nums text-dim">
              {Math.round(task.progress)}%
            </span>
          </div>
        ) : (
          <div className="mt-1.5 text-[11px] text-ok">✓ 已保存到本地，可随时播放</div>
        )}
        {/* 0% 且没有连接时说明原因，避免看起来像卡死 */}
        {!done && task.status === 'downloading' && (task.progress ?? 0) <= 0 && (task.peers ?? 0) === 0 ? (
          <div className="mt-1 text-[11px] text-warn">
            正在寻找做种者…（BT 需要 20~60 秒建立连接；若长时间无反应，该资源可能已无做种者，可换其它字幕组）
          </div>
        ) : null}
        {!done && (task.peers ?? 0) > 0 && task.status === 'downloading' ? (
          <div className="mt-1 text-[11px] text-faint">
            已连接 {task.peers} 个对端（做种 {task.seeders ?? 0}）
          </div>
        ) : null}
        {task.error ? (
          <div className="mt-1 line-clamp-2 text-[11px] text-danger" title={task.error}>
            {task.error}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <Badge tone={st.tone}>{st.text}</Badge>
        {!done && task.speed ? <span className="text-[10px] text-faint">{task.speed}</span> : null}
        <div className="flex gap-1">
          {done ? (
            <IconButton title="本地播放" className="h-7 w-7 !text-ok" onClick={() => playLocal(task)}>
              <Play size={13} fill="currentColor" />
            </IconButton>
          ) : controllable ? (
            task.status === 'paused' ? (
              <IconButton title="继续" className="h-7 w-7" onClick={() => void api.downloads.resume(task.id)}>
                <Play size={13} />
              </IconButton>
            ) : (
              <IconButton title="暂停" className="h-7 w-7" onClick={() => void api.downloads.pause(task.id)}>
                <Pause size={13} />
              </IconButton>
            )
          ) : task.status === 'error' ? (
            <IconButton
              title="重试"
              className="h-7 w-7"
              onClick={() => {
                void api.downloads.retry(task.id).then((r) => {
                  if (r.ok) toast.success('已重新加入下载队列')
                  else toast.error(r.error)
                })
              }}
            >
              <RotateCcw size={13} />
            </IconButton>
          ) : null}
          <IconButton
            title="删除任务"
            className="h-7 w-7 hover:!text-danger"
            onClick={() => {
              void api.downloads.remove(task.id)
              toast.info('已删除下载任务')
            }}
          >
            <Trash2 size={13} />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

/** 下载任务列表：同一番剧的任务折叠为一个分组，点击分组在详情小窗口中展开 */
export function DownloadTaskList({ limit }: { limit?: number }) {
  const downloads = useSubs((s) => s.downloads)
  const navigate = useNavigate()

  const groups = useMemo(() => {
    const map = new Map<string, DownloadTask[]>()
    for (const t of downloads) {
      const arr = map.get(t.animeTitle)
      if (arr) arr.push(t)
      else map.set(t.animeTitle, [t])
    }
    return [...map.entries()].map(([title, tasks]) => ({ title, tasks }))
  }, [downloads])

  const list = limit ? groups.slice(0, limit) : groups

  return (
    <div className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {list.map(({ title, tasks }) => {
          const cover = tasks[0].cover
          const activeCount = tasks.filter((t) => ['queued', 'parsing', 'torrent', 'downloading', 'seeding'].includes(t.status)).length
          const doneCount = tasks.filter((t) => t.status === 'done').length
          const errorCount = tasks.filter((t) => t.status === 'error').length
          const pausedCount = tasks.filter((t) => t.status === 'paused').length
          const downloading = tasks.some((t) => t.status === 'downloading')
          const progressTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'error')
          const progress =
            progressTasks.length > 0
              ? progressTasks.reduce((s, t) => s + (t.progress || 0), 0) / progressTasks.length
              : doneCount > 0
                ? 100
                : 0
          const badge = downloading
            ? { text: '下载中', tone: 'accent' as const }
            : errorCount > 0 && doneCount === 0
              ? { text: '失败', tone: 'danger' as const }
              : doneCount === tasks.length
                ? { text: '已完成', tone: 'ok' as const }
                : pausedCount === tasks.length
                  ? { text: '已暂停', tone: 'neutral' as const }
                  : { text: '排队中', tone: 'neutral' as const }
          const playDone = tasks.find((t) => t.status === 'done')

          return (
            <motion.div
              key={title}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-elev1 p-2.5 transition-colors hover:border-accent/60"
              onClick={() => openDownloadDetail(title)}
            >
              <CoverImage src={cover} className="h-14 w-10 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1">
                <div className="line-clamp-1 text-[13px] font-medium">{title}</div>
                <div className="mt-0.5 text-[11px] text-faint">
                  {tasks.length} 个任务
                  {activeCount > 0 ? ` · ${activeCount} 进行中` : ''}
                  {doneCount > 0 ? ` · 已完成 ${doneCount}` : ''}
                  {errorCount > 0 ? ` · 失败 ${errorCount}` : ''}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <ProgressBar value={progress} className="flex-1" />
                  <span className="w-9 text-right text-[11px] tabular-nums text-dim">
                    {Math.round(progress)}%
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Badge tone={badge.tone}>{badge.text}</Badge>
                <div className="flex gap-1">
                  {playDone ? (
                    <IconButton
                      title="本地播放已完成资源"
                      className="h-7 w-7 !text-ok"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!playDone.dir) {
                          toast.warn('未记录下载目录')
                          return
                        }
                        navigate('/player', {
                          state: {
                            mode: 'local',
                            title: playDone.animeTitle,
                            folder: playDone.dir,
                            subjectId: playDone.subjectId,
                            episode: playDone.episode ?? undefined
                          }
                        })
                      }}
                    >
                      <Play size={13} fill="currentColor" />
                    </IconButton>
                  ) : null}
                  <IconButton
                    title="展开下载详情"
                    className="h-7 w-7"
                    onClick={(e) => {
                      e.stopPropagation()
                      openDownloadDetail(title)
                    }}
                  >
                    <ListChecks size={13} />
                  </IconButton>
                </div>
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>
      {list.length === 0 ? (
        <EmptyState icon={Play} title="暂无下载任务" desc="在番剧详情页订阅资源，或在订阅页确认更新后开始下载" />
      ) : null}
    </div>
  )
}

import { useEffect } from 'react'
import { BookOpen, Heart, Pause, Play, Rss, Tv } from 'lucide-react'
import { useLibrary } from '@/stores/library'
import { useSubs } from '@/stores/subs'
import { useTools } from '@/stores/tools'
import { useSettings } from '@/stores/app'
import { api } from '@/lib/api'
import { timeAgo } from '@/lib/format'
import { ProgressBar } from '@/components/ui'
import { toast } from '@/stores/app'

/** 托盘悬浮小窗：下载任务控制 + 统计 + 观看历史 */
export function TrayPanelPage() {
  const { downloads, refreshDownloads } = useSubs()
  const favorites = useLibrary((s) => s.favorites)
  const subscriptions = useSubs((s) => s.subscriptions)
  const watchHistory = useLibrary((s) => s.watchHistory)
  const tools = useTools((s) => s.tools)
  const settings = useSettings((s) => s.settings)

  useEffect(() => {
    void refreshDownloads()
    const t = setInterval(() => void refreshDownloads(), 2500)
    return () => clearInterval(t)
  }, [refreshDownloads])

  const active = downloads.filter((d) => !['done', 'error'].includes(d.status))
  const watchedEps = watchHistory.length

  return (
    <div
      className="flex h-full flex-col overflow-hidden text-[11px]"
      onMouseLeave={() => {
        // 鼠标移出小窗后隐藏
        void api.window.hideTrayPanel()
      }}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border bg-elev1 px-3.5 py-2.5">
        <div className="flex items-center gap-1.5">
          <span>🐟</span>
          <span className="text-[13px] font-semibold">Sakana</span>
          <span className="text-[10px] text-faint">
            {settings.downloader.type === 'aria2' ? 'aria2' : 'qBittorrent'}
          </span>
        </div>
        <button
          className="rounded-md bg-accent-soft px-2 py-1 text-[10px] text-accent hover:bg-accent/20"
          onClick={() => void api.window.showMain()}
        >
          打开主界面
        </button>
      </div>

      {/* 统计 */}
      <div className="grid grid-cols-4 gap-1.5 px-3.5 py-2.5">
        <Stat icon={Rss} label="订阅" value={subscriptions.length} />
        <Stat icon={Heart} label="收藏" value={favorites.length} />
        <Stat icon={BookOpen} label="工具" value={tools.length} />
        <Stat icon={Tv} label="已观看" value={watchedEps} />
      </div>

      {/* 下载任务（可暂停/继续） */}
      <div className="border-t border-border px-3.5 py-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold text-dim">下载任务</span>
          <span className="text-[10px] text-faint">{active.length} 个进行中</span>
        </div>
        <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto pr-0.5">
          {active.slice(0, 8).map((task) => (
            <div key={task.id} className="rounded-lg border border-border bg-elev1 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="line-clamp-1 flex-1 text-[11px]">{task.animeTitle}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-faint">
                  {task.status === 'done' ? '✓' : `${Math.round(task.progress)}%`}
                </span>
                {task.status === 'downloading' || task.status === 'queued' || task.status === 'torrent' || task.status === 'parsing' ? (
                  <button
                    className="shrink-0 text-faint hover:text-text"
                    title="暂停"
                    onClick={() => void api.downloads.pause(task.id)}
                  >
                    <Pause size={12} />
                  </button>
                ) : task.status === 'paused' ? (
                  <button
                    className="shrink-0 text-ok"
                    title="继续"
                    onClick={() => void api.downloads.resume(task.id)}
                  >
                    <Play size={12} />
                  </button>
                ) : null}
              </div>
              {!['done', 'error'].includes(task.status) ? (
                <ProgressBar value={task.progress} className="mt-1.5" />
              ) : null}
              {task.error ? <div className="mt-1 line-clamp-1 text-[10px] text-danger">{task.error}</div> : null}
            </div>
          ))}
          {active.length === 0 ? (
            <div className="py-3 text-center text-[10px] text-faint">暂无进行中的下载任务</div>
          ) : null}
        </div>
      </div>

      {/* 观看历史 */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border px-3.5 py-2.5">
        <div className="mb-1.5 text-[11px] font-semibold text-dim">最近观看</div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {watchHistory.slice(0, 6).map((h) => (
            <div key={h.id} className="flex items-center justify-between rounded-md px-1 py-1 hover:bg-elev2">
              <span className="line-clamp-1 flex-1 text-[11px]">
                {h.title}
                {h.episode != null ? ` · 第${h.episode}集` : ''}
              </span>
              <span className="ml-1 shrink-0 text-[10px] text-faint">{timeAgo(h.watchedAt)}</span>
            </div>
          ))}
          {watchHistory.length === 0 ? (
            <div className="py-3 text-center text-[10px] text-faint">暂无观看记录</div>
          ) : null}
        </div>
      </div>

      <div
        className="cursor-pointer border-t border-border px-3.5 py-2 text-center text-[10px] text-faint hover:text-dim"
        onClick={() => {
          void api.window.showMain()
          toast.info('已打开主界面')
        }}
      >
        双击托盘图标也可打开主界面
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, value }: { icon: typeof Rss; label: string; value: number }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-border bg-elev1 py-2">
      <Icon size={13} className="text-accent" />
      <span className="mt-0.5 text-[13px] font-bold tabular-nums">{value}</span>
      <span className="text-[9px] text-faint">{label}</span>
    </div>
  )
}

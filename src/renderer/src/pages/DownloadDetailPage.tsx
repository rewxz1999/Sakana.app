import { useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { X } from 'lucide-react'
import { useSubs } from '@/stores/subs'
import { EmptyState } from '@/components/ui'
import { TaskRow } from '@/components/DownloadTaskList'

/** 番剧下载详情小窗口：显示该番剧所有下载任务 */
export function DownloadDetailPage() {
  const [params] = useSearchParams()
  const title = params.get('title') ?? ''
  const downloads = useSubs((s) => s.downloads)
  const refreshDownloads = useSubs((s) => s.refreshDownloads)

  useEffect(() => {
    void refreshDownloads()
  }, [refreshDownloads])

  const tasks = useMemo(
    () => downloads.filter((t) => t.animeTitle === title),
    [downloads, title]
  )

  return (
    <div className="flex h-full flex-col">
      {/* 小窗口标题栏已提供关闭按钮，这里不再重复 */}
      <div className="flex h-11 shrink-0 items-center border-b border-border bg-elev1/60 px-5">
        <div className="line-clamp-1 min-w-0 text-sm font-semibold">{title || '下载详情'}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tasks.length > 0 ? (
          <div className="flex flex-col gap-2">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={X}
            title="没有找到该番剧的下载任务"
            desc="任务可能已被删除，请返回主界面查看下载列表"
          />
        )}
      </div>
    </div>
  )
}

export default DownloadDetailPage

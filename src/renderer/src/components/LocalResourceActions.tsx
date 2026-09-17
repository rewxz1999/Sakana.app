import { useState } from 'react'
import type { LocalTargetInput } from '@shared/types'
import { ConfirmModal } from './ui'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'

/**
 * 「删除本地资源」与「删除下载记录」两套二次确认（订阅卡片 / 下载卡片共用）。
 *
 * 两条路径的区别必须一眼看清：
 * - 删除本地资源 = 删磁盘文件 + 清下载记录 + 复位订阅集数（危险，danger 按钮）；
 * - 删除下载记录 = 只删 store('downloads') 里的记录，**绝不碰文件**（普通按钮 + 文案明说）。
 *
 * 表单式的两个 Modal 组件是受控的（由调用方持有 target 状态），
 * 因为下载列表的分组是 map 出来的，不能在 map 里调 hook。
 */

/** 执行「删除本地资源」并按结果 toast（file 被占用 / 目录已不存在都如实报出） */
export async function runDeleteLocal(input: LocalTargetInput): Promise<void> {
  const r = await api.downloads.deleteLocal(input)
  if (!r.ok) {
    toast.error(r.error)
    return
  }
  const { filesDeleted, recordsRemoved, errors } = r.data
  if (errors.length > 0) {
    toast.warn(`${errors[0]}${recordsRemoved > 0 ? `（已清理 ${recordsRemoved} 条下载记录）` : ''}`)
    return
  }
  toast.success(
    `已删除本地资源：${filesDeleted} 个视频文件${recordsRemoved > 0 ? `、${recordsRemoved} 条下载记录` : ''}`
  )
}

/** 执行「只删下载记录」（不动文件） */
export async function runRemoveRecords(animeTitle: string): Promise<void> {
  const r = await api.downloads.removeRecords({ animeTitle })
  if (!r.ok) {
    toast.error(r.error)
    return
  }
  toast.success(
    `已删除 ${r.data.removed} 条下载记录（本地文件未删除）${
      r.data.tasksCancelled > 0 ? `，并取消 ${r.data.tasksCancelled} 个进行中的任务` : ''
    }`
  )
}

export interface DeleteLocalTarget {
  input: LocalTargetInput
  /** 弹窗里展示的目录（必须先解析出来，确认框才能把路径写清楚） */
  dir: string
  /** 进行中的任务数：删文件时它们会被取消，必须在弹窗里说明 */
  activeCount: number
}

export interface RemoveRecordsTarget {
  animeTitle: string
  taskCount: number
  activeCount: number
}

export function DeleteLocalModal({
  target,
  onClose
}: {
  target: DeleteLocalTarget | null
  onClose: () => void
}) {
  return (
    <ConfirmModal
      open={target !== null}
      onClose={onClose}
      title="删除本地资源"
      danger
      confirmText="删除"
      message={
        <div>
          <div>
            将删除 <span className="break-all font-medium text-danger">{target?.dir ?? ''}</span>{' '}
            下的视频文件，此操作不可撤销。
          </div>
          <div className="mt-1.5 text-faint">
            同时会清理该番剧的下载记录（卡片不再显示「已下载」）。
            {target?.activeCount
              ? `该番剧有 ${target.activeCount} 个进行中的下载任务，会一并取消。`
              : ''}
          </div>
        </div>
      }
      onConfirm={() => {
        if (target) void runDeleteLocal(target.input)
      }}
    />
  )
}

export function RemoveRecordsModal({
  target,
  onClose
}: {
  target: RemoveRecordsTarget | null
  onClose: () => void
}) {
  return (
    <ConfirmModal
      open={target !== null}
      onClose={onClose}
      title="删除下载记录"
      confirmText="仅删除记录"
      message={
        <div>
          <div>
            将删除《{target?.animeTitle ?? ''}》的{' '}
            <span className="font-medium text-text">{target?.taskCount ?? 0}</span> 条下载记录。
          </div>
          <div className="mt-1.5 font-medium text-ok">仅删除下载记录，不删除已下载的文件。</div>
          <div className="mt-1.5 text-faint">
            删除后该番剧不再出现在下载列表里，磁盘上的视频仍然保留、可继续播放。
            {target && target.activeCount > 0
              ? `其中 ${target.activeCount} 个进行中的任务会被取消下载（已下载的部分保留）。`
              : ''}
          </div>
        </div>
      }
      onConfirm={() => {
        if (target) void runRemoveRecords(target.animeTitle)
      }}
    />
  )
}

/** 订阅卡片用：一问一答式（解析目录 → 弹窗 → 确认） */
export function useDeleteLocal(input: {
  subscriptionId?: string
  subjectId?: number
  animeTitle: string
  activeCount?: number
}) {
  const [target, setTarget] = useState<DeleteLocalTarget | null>(null)

  /** 点「删除本地资源」：先问主进程要目录（与下载器建目录同一规则），确认框才能写清路径 */
  const ask = async () => {
    const r = await api.downloads.localDir({
      subscriptionId: input.subscriptionId,
      subjectId: input.subjectId,
      animeTitle: input.animeTitle
    })
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    setTarget({
      input: {
        subscriptionId: input.subscriptionId,
        subjectId: input.subjectId,
        animeTitle: input.animeTitle
      },
      dir: r.data.dir,
      activeCount: input.activeCount ?? 0
    })
  }

  return { ask, modal: <DeleteLocalModal target={target} onClose={() => setTarget(null)} /> }
}

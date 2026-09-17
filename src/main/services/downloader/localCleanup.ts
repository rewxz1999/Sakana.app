import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  DeleteLocalResult,
  DownloadTask,
  LocalDirInfo,
  LocalTargetInput,
  RemoveRecordsResult,
  Subscription
} from '@shared/types'
import { safeName } from '../../lib/parse'
import { log } from '../../log'
import { store } from '../../store'
import { listVideos } from '../media'
import { mutateSubscriptions } from '../subsStore'
import { downloadManager, downloadRoot } from './manager'

/**
 * 本地资源的定位与清理（订阅卡片 / 下载卡片上的「本地播放」「删除本地资源」）。
 *
 * 为什么放在主进程：番剧文件夹的推导规则（下载根目录 + safeName(番剧名)）与下载任务用的是
 * 同一份逻辑，渲染层拿不到 safeName/settings，也不该复制一份规则出来。
 *
 * 书签式说明（2/4 两项都涉及记账）：
 * - 磁盘文件：`<下载根目录>/<番剧名>/` 下的视频与字幕；
 * - 下载记录：store('downloads') 里的 DownloadTask（dir/status='done' 决定界面上的「已下载 N 个资源」）；
 * - 订阅记录：store('subscriptions') 里的 episode（决定「更新到第 N 集 / 已下载所有资源」徽标）。
 * 删掉文件后这两处都必须同步，否则界面会继续显示「已下载」。
 */

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

/** 该任务/订阅是否属于同一条目（按订阅 id / bangumi 条目 id / 番剧名三选一匹配） */
function matchesTarget(task: DownloadTask, input: LocalTargetInput): boolean {
  if (input.subscriptionId && task.subscriptionId === input.subscriptionId) return true
  if (input.subjectId != null && task.subjectId === input.subjectId) return true
  if (input.animeTitle && task.animeTitle === input.animeTitle) return true
  return false
}

function findSubscription(input: LocalTargetInput): Subscription | undefined {
  const subs = store.get<Subscription[]>('subscriptions', [])
  if (input.subscriptionId) {
    const hit = subs.find((s) => s.id === input.subscriptionId)
    if (hit) return hit
  }
  if (input.subjectId != null) {
    const hit = subs.find((s) => s.subjectId === input.subjectId)
    if (hit) return hit
  }
  if (input.animeTitle) return subs.find((s) => (s.nameCn || s.name) === input.animeTitle)
  return undefined
}

/**
 * 推导番剧的本地文件夹（优先级：显式传入 > 下载任务记录 > 订阅记录 > 下载根目录+番剧名）。
 * 返回的 source 只用于界面提示，不影响行为。
 */
export function resolveLocalTarget(input: LocalTargetInput): { dir: string; source: LocalDirInfo['source'] } {
  const explicit = input.dir?.trim()
  if (explicit) return { dir: explicit, source: 'task' }
  const sub = findSubscription(input)
  const tasks = store.get<DownloadTask[]>('downloads', [])
  // 最近添加的任务记录的 dir 最可信（任务完成后一直保留该目录）
  const taskDir = [...tasks]
    .filter((t) => t.dir && matchesTarget(t, { ...input, subscriptionId: input.subscriptionId ?? sub?.id }))
    .sort((a, b) => b.addedAt - a.addedAt)[0]?.dir
  if (taskDir) return { dir: taskDir, source: 'task' }
  if (sub?.folder) return { dir: sub.folder, source: 'folder' }
  const title = input.animeTitle || sub?.nameCn || sub?.name || ''
  return { dir: join(downloadRoot(), safeName(title)), source: 'derived' }
}

/** 解析番剧本地目录 + 目录内可播放视频数（「本地播放」据此判断能不能直接播） */
export function localDirInfo(input: LocalTargetInput): LocalDirInfo {
  const { dir, source } = resolveLocalTarget(input)
  const exists = existsSync(dir)
  return { dir, exists, videos: exists ? listVideos(dir).length : 0, source }
}

/**
 * 删除本地资源：磁盘文件 + 对应下载记录（订阅记录里的集数一并复位）。
 * 不可撤销，界面必须先弹二次确认。
 */
export async function deleteLocalResources(input: LocalTargetInput): Promise<DeleteLocalResult> {
  const { dir, source } = resolveLocalTarget(input)
  const root = downloadRoot()
  // 安全闸：目标必须是「番剧文件夹」本身，绝不能是下载根目录或盘符根目录
  if (samePath(dir, root) || samePath(dirname(dir), dir)) {
    throw new Error(`拒绝删除下载根目录或盘符根目录：${dir}`)
  }

  const sub = findSubscription(input)
  const tasks = store.get<DownloadTask[]>('downloads', [])
  const targets = tasks.filter((t) => matchesTarget(t, { ...input, subscriptionId: input.subscriptionId ?? sub?.id }))
  const errors: string[] = []
  const exists = existsSync(dir)
  // 视频文件数在删除前统计（就是弹窗里承诺要删掉的东西）
  const videos = exists ? listVideos(dir).length : 0

  if (exists) {
    try {
      rmSync(dir, { recursive: true, force: true })
      log.append('info', 'download', `删除本地资源: ${dir}（${videos} 个视频文件，来源 ${source}）`)
    } catch (err) {
      errors.push(`删除失败：${(err as Error)?.message ?? String(err)}`)
      log.append('warn', 'download', `删除本地资源失败 (${dir}): ${String(err)}`)
    }
    // 被占用（播放器正打开）时目录会残留：明确报出来，别让界面以为删干净了
    if (existsSync(dir) && errors.length === 0) errors.push('部分文件被占用，未能全部删除')
  } else {
    errors.push(`目录不存在（可能已被手动删除）：${dir}`)
  }

  const { removed, cancelled } = await downloadManager.removeRecords(
    targets.map((t) => t.id),
    { detach: true }
  )

  /*
   * 订阅记录复位：文件删了但 episode 还留着的话，卡片仍显示「更新到第 N 集 / 已下载所有资源」。
   * lastPubDate 故意保留 —— 否则下次「更新」会把刚删掉的旧集数重新当成新资源提示下载。
   */
  if (sub) {
    mutateSubscriptions((list) => list.map((s) => (s.id === sub.id ? { ...s, episode: null } : s)))
  }

  return { dir, filesDeleted: videos, recordsRemoved: removed, tasksCancelled: cancelled, errors }
}

/** 只删下载记录，**绝不**动磁盘文件（下载列表综合卡片的「删除」） */
export async function removeDownloadRecords(input: {
  animeTitle?: string
  ids?: string[]
}): Promise<RemoveRecordsResult> {
  const tasks = store.get<DownloadTask[]>('downloads', [])
  const targets = input.ids?.length
    ? tasks.filter((t) => input.ids!.includes(t.id))
    : tasks.filter((t) => !!input.animeTitle && t.animeTitle === input.animeTitle)
  // detach=true：进行中的任务会被取消下载（否则下载器会继续写没人管的文件）；
  // deleteUnfinishedFiles 保持 false —— 已下载的部分文件必须保留
  const { removed, cancelled } = await downloadManager.removeRecords(
    targets.map((t) => t.id),
    { detach: true, deleteUnfinishedFiles: false }
  )
  log.append('info', 'download', `仅删除下载记录: ${input.animeTitle ?? input.ids?.length} （${removed} 条）`)
  return { removed, tasksCancelled: cancelled }
}

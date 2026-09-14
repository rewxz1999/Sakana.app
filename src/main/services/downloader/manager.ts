import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { CH } from '@shared/channels'
import type { AddDownloadInput, DownloadTask, DownloadStatus, Subscription } from '@shared/types'
import { parseEpisode, padEpisode, safeName } from '../../lib/parse'
import { log } from '../../log'
import { getSettings, httpGetBuffer } from '../../net'
import { store } from '../../store'
import { aria2, type Aria2Progress } from './aria2'
import { qbit, type QbitProgress } from './qbit'
import { maybeShowSaveHint } from '../onboarding'

const ACTIVE_STATUSES: DownloadStatus[] = ['queued', 'parsing', 'torrent', 'downloading', 'paused', 'seeding']
/** 允许暂停/继续的状态 */
const PAUSABLE: DownloadStatus[] = ['queued', 'parsing', 'torrent', 'downloading', 'seeding']
/** 列表排序权重：正在下载的任务置顶 */
const STATUS_RANK: Record<DownloadStatus, number> = {
  downloading: 0,
  queued: 1,
  parsing: 1,
  torrent: 1,
  paused: 2,
  seeding: 3,
  error: 4,
  done: 5
}

/**
 * 下载任务管理器（方案 4.3/4.4/4.5）
 * - 种子文件先下载再交给下载器（状态「种子下载中」），不计入正片进度
 * - aria2 完成后按命名规则重命名：番剧名 + 字幕组 + 集数 + 后缀
 */
class DownloadManager {
  private timer: NodeJS.Timeout | null = null
  /** 轮询互斥：避免上一轮未结束时又起一轮（并发 patch 同一任务） */
  private polling = false

  private tasks(): DownloadTask[] {
    return store.get<DownloadTask[]>('downloads', [])
  }

  /** 排序后的任务列表（正在下载/排队/种子中置顶，已完成沉底） */
  private sorted(tasks: DownloadTask[]): DownloadTask[] {
    return [...tasks].sort(
      (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    )
  }

  list(): DownloadTask[] {
    return this.sorted(this.tasks())
  }

  private save(tasks: DownloadTask[]): void {
    store.set('downloads', tasks)
    this.emit()
  }

  private patch(id: string, patch: Partial<DownloadTask>): void {
    const tasks = this.tasks()
    const idx = tasks.findIndex((t) => t.id === id)
    if (idx < 0) return
    tasks[idx] = { ...tasks[idx], ...patch }
    store.set('downloads', tasks)
    this.emit()
  }

  private emit(): void {
    const payload = this.sorted(this.tasks())
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(CH.evDownloads, payload)
    }
  }

  /** 任务实际使用的下载器（双下载器模式下任务自带 engine 标记） */
  private engineOf(task?: DownloadTask): 'aria2' | 'qbit' {
    if (task?.engine) return task.engine
    const s = getSettings()
    return s.downloader.type
  }

  /** 双下载器模式：把新任务分配给当前进行中任务较少的下载器（均衡分配加速下载） */
  private assignEngine(): 'aria2' | 'qbit' {
    const s = getSettings()
    if (!s.downloader.dual) return s.downloader.type
    const tasks = this.tasks()
    const count = (e: 'aria2' | 'qbit'): number =>
      tasks.filter((t) => t.engine === e && ACTIVE_STATUSES.includes(t.status)).length
    return count('aria2') <= count('qbit') ? 'aria2' : 'qbit'
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    const s = getSettings()
    try {
      if (s.downloader.dual) {
        const results: string[] = []
        try {
          await aria2.ensureRunning()
          results.push(`aria2 v${await aria2.getVersion()}`)
        } catch (err) {
          results.push(`aria2 失败: ${String((err as { message?: string })?.message ?? err)}`)
        }
        try {
          results.push(`qBittorrent v${await qbit.test()}`)
        } catch (err) {
          results.push(`qBittorrent 失败: ${String((err as { message?: string })?.message ?? err)}`)
        }
        const allOk = results.every((r) => !r.includes('失败'))
        return { ok: allOk, message: `双下载器：${results.join('；')}` }
      }
      if (s.downloader.type === 'aria2') {
        await aria2.ensureRunning()
        const v = await aria2.getVersion()
        return { ok: true, message: `aria2 RPC 已连接 (v${v})` }
      }
      const v = await qbit.test()
      return { ok: true, message: `qBittorrent 已连接 (v${v})` }
    } catch (err) {
      const e = err as { message?: string }
      return { ok: false, message: e?.message ?? String(err) }
    }
  }

  async add(input: AddDownloadInput): Promise<DownloadTask> {
    const task: DownloadTask = {
      id: randomUUID(),
      ...input,
      engine: getSettings().downloader.dual ? this.assignEngine() : undefined,
      status: 'queued',
      progress: 0,
      addedAt: Date.now()
    }
    const tasks = this.tasks()
    tasks.push(task)
    this.save(tasks)
    log.append('info', 'download', `新增下载任务: ${input.name}`)
    // 首次下载行为：提示一次保存位置（只显示一次）
    maybeShowSaveHint()
    this.process(task.id).catch((err) => {
      const e = err as { message?: string }
      log.append('error', 'download', `任务启动失败 (${input.name}): ${e?.message ?? String(err)}`)
      this.patch(task.id, { status: 'error', error: e?.message ?? String(err) })
    })
    return task
  }

  /** 失败任务重试：删除旧任务并按原参数重新添加 */
  async retry(id: string): Promise<DownloadTask> {
    const task = this.tasks().find((t) => t.id === id)
    if (!task) throw new Error('任务不存在')
    await this.remove(id)
    return this.add({
      subscriptionId: task.subscriptionId,
      subjectId: task.subjectId,
      animeTitle: task.animeTitle,
      episode: task.episode,
      group: task.group,
      name: task.name,
      cover: task.cover,
      magnet: task.magnet,
      torrentUrl: task.torrentUrl
    })
  }

  private async process(id: string): Promise<void> {
    const task = this.tasks().find((t) => t.id === id)
    if (!task) return
    const settings = getSettings()
    const root = settings.downloadDir || join(app.getPath('userData'), 'downloads')
    const dir = join(root, safeName(task.animeTitle))
    mkdirSync(dir, { recursive: true })
    this.patch(id, { dir })

    if (this.engineOf(task) === 'aria2') {
      await aria2.ensureRunning()
      if (task.torrentUrl && !task.magnet) {
        // 方案 4.3：先下载种子文件（状态「种子下载中」，不算正片）
        this.patch(id, { status: 'torrent' })
        const buf = await httpGetBuffer(task.torrentUrl)
        const gid = await aria2.addTorrentBase64(buf.toString('base64'), dir)
        this.patch(id, { downloaderId: gid, status: 'downloading' })
      } else if (task.magnet) {
        const gid = await aria2.addUri(task.magnet, dir)
        this.patch(id, { downloaderId: gid, status: 'downloading' })
      } else {
        throw new Error('资源缺少磁力链接或种子地址')
      }
    } else {
      const url = task.torrentUrl || task.magnet
      if (!url) throw new Error('资源缺少磁力链接或种子地址')
      const hash = await qbit.add(url, dir)
      this.patch(id, { downloaderId: hash, status: 'downloading' })
    }
  }

  async pause(id: string): Promise<boolean> {
    const task = this.tasks().find((t) => t.id === id)
    if (!task || !task.downloaderId) return false
    // 已完成/出错任务不可暂停（aria2 对 complete 任务调用 pause 会报 400）
    if (!PAUSABLE.includes(task.status)) {
      log.append('warn', 'download', `任务状态为 ${task.status}，不可暂停`)
      return false
    }
    try {
      if (this.engineOf(task) === 'aria2') await aria2.pause(task.downloaderId)
      else await qbit.pause(task.downloaderId)
      this.patch(id, { status: 'paused' })
      return true
    } catch (err) {
      log.append('warn', 'download', `暂停失败: ${String(err)}`)
      return false
    }
  }

  async resume(id: string): Promise<boolean> {
    const task = this.tasks().find((t) => t.id === id)
    if (!task || !task.downloaderId) return false
    if (!PAUSABLE.includes(task.status)) return false
    try {
      if (this.engineOf(task) === 'aria2') await aria2.unpause(task.downloaderId)
      else await qbit.resume(task.downloaderId)
      this.patch(id, { status: 'downloading' })
      return true
    } catch (err) {
      log.append('warn', 'download', `继续失败: ${String(err)}`)
      return false
    }
  }

  async remove(id: string): Promise<boolean> {
    const task = this.tasks().find((t) => t.id === id)
    if (task?.downloaderId) {
      try {
        if (this.engineOf(task) === 'aria2') await aria2.remove(task.downloaderId)
        else await qbit.remove(task.downloaderId)
      } catch (err) {
        log.append('warn', 'download', `移除下载器任务失败: ${String(err)}`)
      }
    }
    // 未完成任务删除时清空已下载内容（已完成/做种的任务保留文件；目录被其它任务共用时不清空）
    if (task && task.dir && !['done', 'seeding'].includes(task.status)) {
      const shared = this.tasks().some((t) => t.id !== id && t.dir === task.dir)
      if (!shared) {
        try {
          rmSync(task.dir, { recursive: true, force: true })
          log.append('info', 'download', `已清空未完成任务下载内容: ${task.dir}`)
        } catch (err) {
          log.append('warn', 'download', `清空下载内容失败 (${task.dir}): ${String(err)}`)
        }
      }
    }
    this.save(this.tasks().filter((t) => t.id !== id))
    log.append('info', 'download', `删除下载任务: ${task?.name ?? id}`)
    return true
  }

  /** 下载完成时同步订阅：推进最新集数与资源日期，避免已下载资源重复提示更新 */
  private syncSubscriptionOnDone(task: DownloadTask): void {
    if (!task.subscriptionId) return
    const subs = store.get<Subscription[]>('subscriptions', [])
    const sub = subs.find((s) => s.id === task.subscriptionId)
    if (!sub) return
    const next: Subscription = { ...sub }
    if (task.episode != null) next.episode = Math.max(sub.episode ?? 0, task.episode)
    if (task.pubDate) {
      const t = new Date(task.pubDate).getTime()
      const cur = new Date(sub.lastPubDate ?? 0).getTime()
      if (!Number.isNaN(t) && (Number.isNaN(cur) || t > cur)) next.lastPubDate = task.pubDate
    }
    // 该订阅没有进行中任务 → 状态复位为已完成
    const tasks = this.tasks()
    const activeCount = tasks.filter(
      (t) => t.subscriptionId === sub.id && !['done', 'error'].includes(t.status)
    ).length
    if (activeCount === 0 && next.status === 'updating') next.status = 'complete'
    store.set('subscriptions', subs.map((s) => (s.id === sub.id ? next : s)))
  }

  async poll(): Promise<void> {
    const tasks = this.tasks()
    const active = tasks.filter(
      (t) => ACTIVE_STATUSES.includes(t.status) && t.downloaderId
    )
    if (active.length === 0) return
    // 双下载器模式：每个任务按其 engine 标记分别轮询对应下载器
    for (const task of active) {
      if (this.engineOf(task) === 'aria2') {
        const st: Aria2Progress | null = await aria2.status(task.downloaderId!)
        if (!st) continue
        const patch: Partial<DownloadTask> = {
          progress: Math.round(st.progress),
          speed: st.speed,
          peers: st.peers,
          seeders: st.seeders,
          eta: st.eta,
          size: st.size,
          status: st.status,
          error: st.error
        }
        // 完成处理：重命名 + 更新订阅集数
        if (st.status === 'seeding' && task.status !== 'seeding' && task.status !== 'done') {
          patch.status = 'done'
          patch.progress = 100
          patch.finishedAt = Date.now()
          void this.renameDone(task)
          // 必须先落盘再同步订阅：syncSubscriptionOnDone 内部按任务列表统计未完成任务数，
          // 顺序反了会把刚完成的这个任务仍算作"进行中"，订阅状态永远停留在 updating。
          this.patch(task.id, patch)
          this.syncSubscriptionOnDone({ ...task, ...patch })
        } else {
          this.patch(task.id, patch)
        }
      } else {
        const st: QbitProgress | null = await qbit.status(task.downloaderId!)
        if (!st) continue
        const patch: Partial<DownloadTask> = {
          progress: Math.round(st.progress),
          speed: st.speed,
          eta: st.eta,
          size: st.size,
          status: st.status,
          error: st.error
        }
        if (st.status === 'seeding' && task.status !== 'seeding' && task.status !== 'done') {
          patch.status = 'done'
          patch.progress = 100
          patch.finishedAt = Date.now()
          this.patch(task.id, patch)
          this.syncSubscriptionOnDone({ ...task, ...patch })
        } else {
          this.patch(task.id, patch)
        }
      }
    }
  }

  /** 方案 4.5：下载完成后按「番剧名 字幕组 第XX集.后缀」重命名 */
  private async renameDone(task: DownloadTask): Promise<void> {
    if (this.engineOf(task) !== 'aria2' || !task.downloaderId) return
    try {
      const files = await aria2.files(task.downloaderId)
      let unknownCount = 0
      for (const f of files) {
        const src = f.path
        if (!existsSync(src)) continue
        const ext = extname(src)
        const base = basename(src, ext)
        // 已按规则命名则跳过
        if (base.startsWith(task.animeTitle)) continue
        const ep = parseEpisode(base) ?? task.episode
        const epName =
          ep != null
            ? padEpisode(ep)
            : `未知集数${String(++unknownCount).padStart(2, '0')}`
        const dst = join(dirname(src), `${task.animeTitle} ${task.group ?? '未知字幕'} ${epName}${ext}`)
        if (src === dst || existsSync(dst)) continue
        try {
          renameSync(src, dst)
          log.append('info', 'download', `重命名完成: ${basename(dst)}`)
        } catch (err) {
          log.append('warn', 'download', `重命名失败 (${basename(src)}): ${String(err)}`)
        }
      }
    } catch (err) {
      log.append('warn', 'download', `重命名处理失败: ${String(err)}`)
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // 轮询内是逐个 await 的网络调用，2 秒间隔可能短于一轮耗时；
      // 不加锁会出现同一任务被并发轮询（重复 patch/重复触发完成回调）。
      if (this.polling) return
      this.polling = true
      this.poll()
        .catch((err) => log.append('warn', 'download', `轮询失败: ${String(err)}`))
        .finally(() => {
          this.polling = false
        })
    }, 2000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // aria2 为内置进程：无论单/双模式都随应用退出而停止；qBittorrent 为外部程序不受影响
    aria2.stop()
  }
}

export const downloadManager = new DownloadManager()

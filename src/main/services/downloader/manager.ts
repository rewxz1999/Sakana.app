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
import { ensureQbitForDownload } from './qbitLauncher'
import { transmission, type TransmissionProgress } from './transmission'
import { maybeShowSaveHint } from '../onboarding'

/** V1.5.2：三个可选下载引擎 */
export type DownloadEngine = 'aria2' | 'qbit' | 'transmission'

const ALL_ENGINES: DownloadEngine[] = ['aria2', 'qbit', 'transmission']

/**
 * 当前启用的引擎列表：单引擎 1 个；双下载器模式取用户选的两项（非法/不足回落到 aria2+qbit）。
 * 双下载器「三选二」的语义只在这里落地，调度/轮询都按这份列表走。
 */
function enabledEngines(): DownloadEngine[] {
  const s = getSettings()
  if (!s.downloader.dual) return [s.downloader.type]
  const picked = (s.downloader.dualEngines ?? []).filter((e): e is DownloadEngine =>
    ALL_ENGINES.includes(e as DownloadEngine)
  )
  const uniq = [...new Set(picked)]
  if (uniq.length === 2) return uniq
  return ['aria2', 'qbit']
}

const ACTIVE_STATUSES: DownloadStatus[] = ['queued', 'parsing', 'torrent', 'downloading', 'paused', 'seeding']

/**
 * 下载根目录（设置里的 downloadDir，留空则 userData/downloads）。
 *
 * 与 process() 里建番剧文件夹用的是同一份推导，抽出来是为了让
 * 「本地播放 / 删除本地资源」在订阅卡片上能算出**同一个**目录，不靠用户手选。
 */
export function downloadRoot(): string {
  const s = getSettings()
  return s.downloadDir || join(app.getPath('userData'), 'downloads')
}
/** 允许暂停的状态（已完成的不能暂停：aria2 对 complete 任务调用 pause 会报 400） */
const PAUSABLE: DownloadStatus[] = ['queued', 'parsing', 'torrent', 'downloading', 'seeding']
/**
 * 允许「继续」的状态：只有暂停态。
 *
 * 修 bug：这里原本复用 PAUSABLE，而 PAUSABLE 里没有 'paused' —— 任务一旦暂停就再也无法继续
 * （两个下载器都一样：界面上的「继续」点了没反应而且不报错）。实测 qb 侧 pause 后 state=stoppedDL、
 * resume() 直接 return false。
 */
const RESUMABLE: DownloadStatus[] = ['paused']
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
  /**
   * V1.5.2：已经为「长时间 0 对端」记录过警告的任务。
   *
   * 用户报「经常卡在寻找做种者」——界面会给提示，但日志里没有证据无法定位是
   * 「tracker 没 peer」还是「DHT 没响应」。这里每个任务只记一条，避免刷屏。
   */
  private noPeerWarned = new Set<string>()

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

  /**
   * 把任务列表推给所有窗口（v0.3.9 体检 M2）。
   *
   * 为什么要收拾它：下载轮询每 2 秒对每个活跃任务 `patch()` 一次，而 `patch` 以前**每次都整份推给所有窗口**；
   * 渲染层又是整数组替换 → 下载页 / 仪表盘 / 托盘三个订阅方全部重渲染。任务多、跑得久时这就是
   * "越用越卡"的一部分（而且每秒推的往往是"进度只多了 0.1%"这种无关紧要的变化）。
   *
   * 现在的策略（不牺牲实时感）：
   *   ① **指纹没变就不推** —— 状态/进度（0.1 精度）/速度/错误 任一变化才算变；
   *   ② **最快 800ms 一次**，中间的变化合并到尾部再推；
   *   ③ 推送时跳过正在销毁的窗口。
   */
  private emitFingerprint = ''
  private lastEmitAt = 0
  private emitTimer: NodeJS.Timeout | null = null

  private fingerprint(tasks: DownloadTask[]): string {
    return tasks
      .map(
        (t) =>
          `${t.id}:${t.status}:${Math.round((t.progress ?? 0) * 10)}:${t.speed ?? ''}:${t.error ?? ''}:${t.engine ?? ''}`
      )
      .join('|')
  }

  private emit(): void {
    const payload = this.sorted(this.tasks())
    const fp = this.fingerprint(payload)
    if (fp === this.emitFingerprint) return
    const now = Date.now()
    const gap = now - this.lastEmitAt
    if (gap < 800) {
      // 距上次推送太近：合并成一次尾部推送（到点后重新走一遍本函数，那时指纹是最新的）
      if (!this.emitTimer) {
        this.emitTimer = setTimeout(() => {
          this.emitTimer = null
          this.emit()
        }, 800 - gap)
      }
      return
    }
    this.emitFingerprint = fp
    this.lastEmitAt = now
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      try {
        w.webContents.send(CH.evDownloads, payload)
      } catch {
        /* 窗口正在销毁时忽略 */
      }
    }
  }

  /** 任务实际使用的下载器（双下载器模式下任务自带 engine 标记） */
  private engineOf(task?: DownloadTask): DownloadEngine {
    if (task?.engine) return task.engine
    const s = getSettings()
    return s.downloader.type
  }

  /** 双下载器模式：把新任务分配给当前进行中任务较少的引擎（均衡分配加速下载） */
  private assignEngine(): DownloadEngine {
    const s = getSettings()
    if (!s.downloader.dual) return s.downloader.type
    const pool = enabledEngines()
    const tasks = this.tasks()
    const count = (e: DownloadEngine): number =>
      tasks.filter((t) => t.engine === e && ACTIVE_STATUSES.includes(t.status)).length
    // 数量相同时按 pool 顺序（默认 aria2 优先），与旧行为一致
    return [...pool].sort((a, b) => count(a) - count(b))[0] ?? 'aria2'
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    const s = getSettings()
    try {
      if (s.downloader.dual) {
        const engines = enabledEngines()
        const results: string[] = []
        for (const e of engines) {
          if (e === 'aria2') {
            try {
              await aria2.ensureRunning()
              results.push(`aria2 v${await aria2.getVersion()}`)
            } catch (err) {
              results.push(`aria2 失败: ${String((err as { message?: string })?.message ?? err)}`)
            }
          } else if (e === 'qbit') {
            try {
              results.push(`qBittorrent ${await qbit.test()}`)
            } catch (err) {
              results.push(`qBittorrent 失败: ${String((err as { message?: string })?.message ?? err)}`)
            }
          } else {
            const ping = await transmission.ping()
            results.push(ping.reachable ? `Transmission ${ping.version ?? '已连接'}` : `Transmission 失败: ${ping.error}`)
          }
        }
        // 双下载器模式下"有一个能用"就不算全盘失败：任务会被调度到可用的那一个
        const okCount = results.filter((r) => !r.includes('失败')).length
        return { ok: okCount > 0, message: `双下载器：${results.join('；')}` }
      }
      if (s.downloader.type === 'aria2') {
        await aria2.ensureRunning()
        const v = await aria2.getVersion()
        return { ok: true, message: `aria2 RPC 已连接 (v${v})` }
      }
      if (s.downloader.type === 'transmission') {
        const ping = await transmission.ping()
        if (!ping.reachable) throw new Error(ping.error ?? '连不上 Transmission')
        return { ok: true, message: `Transmission 已连接（${ping.version ?? '未知版本'}）` }
      }
      const v = await qbit.test()
      return { ok: true, message: `qBittorrent 已连接（${v}）` }
    } catch (err) {
      const e = err as { message?: string }
      return { ok: false, message: e?.message ?? String(err) }
    }
  }

  async add(input: AddDownloadInput): Promise<DownloadTask> {
    const settings = getSettings()
    let engine: DownloadEngine = settings.downloader.dual ? this.assignEngine() : settings.downloader.type
    /*
     * 外部 qBittorrent 不归应用管，它没在运行的话任务一个也下不动。
     * 添加前先确认可用性（必要时弹一次授权框、由应用把它拉起来，见 qbitLauncher）：
     * - 双下载器模式且 qb 不可用 → 自动改用内置 aria2，任务照样能下；
     * - 仅 qb 模式 → 抛出中文原因，由界面 toast 出来，而不是留一条永远 0% 的任务。
     */
    if (engine === 'qbit') {
      const ensured = await ensureQbitForDownload()
      engine = ensured.engine as DownloadEngine
      if (ensured.note) log.append('info', 'download', ensured.note)
    }
    /*
     * V1.5.2：Transmission 同理 —— 连不上时不能留一条 0% 的任务。
     * 双下载器模式下自动改用 aria2；只有"仅 Transmission"模式才报错（由界面 toast 原因）。
     */
    if (engine === 'transmission') {
      const ping = await transmission.ping()
      if (!ping.reachable) {
        const note = `Transmission 不可用（${ping.error ?? '连不上'}）`
        if (settings.downloader.dual) {
          log.append('warn', 'download', `${note}，本任务改用内置 aria2`)
          engine = 'aria2'
        } else {
          throw new Error(`${note}：请在「下载器配置」里检查 RPC 地址/账号，或先启动 Transmission`)
        }
      }
    }
    const task: DownloadTask = {
      id: randomUUID(),
      ...input,
      // 双下载器模式要记录每个任务实际用的引擎；单 qb 模式下也记上，删除/暂停时才知道该找谁
      engine,
      status: 'queued',
      progress: 0,
      addedAt: Date.now()
    }
    const tasks = this.tasks()
    tasks.push(task)
    this.save(tasks)
    log.append('info', 'download', `新增下载任务: ${input.name}（引擎 ${engine}）`)
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
    const root = downloadRoot()
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
      if (this.engineOf(task) === 'transmission') {
        // V1.5.2：Transmission 的 torrent-add 直接吃磁力/种子 URL（不需要先下种子文件）
        const hash = await transmission.add(url, dir)
        this.patch(id, { downloaderId: hash, status: 'downloading' })
      } else {
        const hash = await qbit.add(url, dir)
        this.patch(id, { downloaderId: hash, status: 'downloading' })
      }
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
      const engine = this.engineOf(task)
      if (engine === 'aria2') await aria2.pause(task.downloaderId)
      else if (engine === 'transmission') await transmission.pause(task.downloaderId)
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
    // 只有「暂停」态才能继续（见 RESUMABLE 注释：这里以前误用 PAUSABLE，导致继续永远失败）
    if (!RESUMABLE.includes(task.status)) {
      log.append('warn', 'download', `任务状态为 ${task.status}，无需继续`)
      return false
    }
    try {
      const engine = this.engineOf(task)
      if (engine === 'aria2') await aria2.unpause(task.downloaderId)
      else if (engine === 'transmission') await transmission.resume(task.downloaderId)
      else await qbit.resume(task.downloaderId)
      this.patch(id, { status: 'downloading' })
      return true
    } catch (err) {
      log.append('warn', 'download', `继续失败: ${String(err)}`)
      return false
    }
  }

  /**
   * 批量删除下载任务记录（下载列表综合卡片的「删除」与「删除本地资源」共用）。
   *
   * - `detach`（默认 true）：有 downloaderId 的任务一并通知下载器移除，避免留下界面看不见、
   *   也没人管的孤儿任务（aria2 只是停止任务，qbit 用 deleteFiles=false，都不会删文件）；
   * - `deleteUnfinishedFiles`（默认 false）：是否顺手清空**未完成**任务的下载内容。
   *   两个新入口都明确要求「不动磁盘」，所以默认 false；只有单条「删除任务」保持老行为。
   */
  async removeRecords(
    ids: string[],
    opts: { detach?: boolean; deleteUnfinishedFiles?: boolean } = {}
  ): Promise<{ removed: number; cancelled: number }> {
    const tasks = this.tasks()
    const removeSet = new Set(ids)
    const targets = tasks.filter((t) => removeSet.has(t.id))
    let cancelled = 0
    for (const task of targets) {
      if (opts.detach === false || !task.downloaderId) continue
      if (!['done', 'error'].includes(task.status)) cancelled += 1
      try {
        const engine = this.engineOf(task)
        if (engine === 'aria2') await aria2.remove(task.downloaderId)
        else if (engine === 'transmission') await transmission.remove(task.downloaderId)
        else await qbit.remove(task.downloaderId)
      } catch (err) {
        log.append('warn', 'download', `移除下载器任务失败: ${String(err)}`)
      }
    }
    if (opts.deleteUnfinishedFiles) {
      for (const task of targets) {
        if (!task.dir || ['done', 'seeding'].includes(task.status)) continue
        // 目录被同一批之外的任务共用时不清空
        const shared = tasks.some((t) => !removeSet.has(t.id) && t.dir === task.dir)
        if (shared) continue
        try {
          rmSync(task.dir, { recursive: true, force: true })
          log.append('info', 'download', `已清空未完成任务下载内容: ${task.dir}`)
        } catch (err) {
          log.append('warn', 'download', `清空下载内容失败 (${task.dir}): ${String(err)}`)
        }
      }
    }
    this.save(tasks.filter((t) => !removeSet.has(t.id)))
    for (const task of targets) log.append('info', 'download', `删除下载任务: ${task.name}`)
    return { removed: targets.length, cancelled }
  }

  async remove(id: string): Promise<boolean> {
    // 单条「删除任务」保持老行为：未完成的任务顺手清空已下载内容
    await this.removeRecords([id], { deleteUnfinishedFiles: true })
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
          /*
           * V1.5.2：BT 任务 60 秒还没有任何对端 → 记一条「为什么」。
           *
           * 实测（本机，蜜柑 2024 年老番第 12 集）：四个不同字幕组的种子都是
           * `CN:0 SD:0` 持续 60 秒；同机用 Ubuntu ISO 测是 44 个对端 / 8MB/s，
           * 且 nyaatracker 返回 `0 peers`、DHT 引导节点超时 —— 说明资源确实没有做种者，
           * 不是下载器坏了。把它写进日志，用户报「卡住」时能直接区分两种情况。
           */
          if (
            (st.status === 'downloading' || st.status === 'queued') &&
            (st.peers ?? 0) === 0 &&
            (st.progress ?? 0) <= 0 &&
            Date.now() - task.addedAt > 60_000 &&
            !this.noPeerWarned.has(task.id)
          ) {
            this.noPeerWarned.add(task.id)
            log.append(
              'warn',
              'download',
              `BT 任务 60 秒内 0 对端（做种者 0）：${task.name}｜tracker 可能只回了空 peer 列表，且 DHT 没找到节点；` +
                `若同类资源都能下（可用热门种子自测），说明该资源当前无做种者，建议换字幕组/等做种`
            )
          }
        }
      } else if (this.engineOf(task) === 'transmission') {
        /*
         * V1.5.2：Transmission 的完成判定与 qb 同口径：
         * 做种态算完成；"下载完但被设置为停止"（percentDone=1 且 status=stopped）也算完成。
         */
        const st: TransmissionProgress | null = await transmission.status(task.downloaderId!)
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
        const finished = st.status === 'seeding' || (st.progress >= 99.5 && st.status === 'paused')
        if (finished && task.status !== 'seeding' && task.status !== 'done') {
          patch.status = 'done'
          patch.progress = 100
          patch.finishedAt = Date.now()
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
          // qb 也给了 leech/seed 数，填上以后下载列表里的「已连接 N 个对端」在 qb 模式下同样有值
          peers: st.peers,
          seeders: st.seeders,
          eta: st.eta,
          size: st.size,
          status: st.status,
          error: st.error
        }
        /*
         * 完成判定。
         * qb 下完会进入 uploading/stalledUP（映射为 seeding）；但如果用户开了「做种到...后停止」
         * 或「下载完成后停止」，最终状态是 stoppedUP（映射为 paused）——只看 seeding 会永远判不出完成，
         * 所以进度到 100% 且处于停止/暂停态时同样算完成。
         */
        const finished = st.status === 'seeding' || (st.progress >= 99.5 && st.status === 'paused')
        if (finished && task.status !== 'seeding' && task.status !== 'done') {
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

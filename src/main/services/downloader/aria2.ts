import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import axios from 'axios'
import { resolveAria2Tuning, type DownloadStatus } from '@shared/types'
import { humanSize } from '../../lib/parse'
import { log } from '../../log'
import { getSettings } from '../../net'
import { currentTrackerString, refreshTrackers, trackerStatus } from './trackers'
import type { TrackerStatus } from '@shared/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface Aria2Progress {
  status: DownloadStatus
  progress: number
  speed?: string
  /** 已连接对端数 / 做种者数：0 表示还没找到做种者（UI 用来解释"为什么一直是 0%"） */
  peers?: number
  seeders?: number
  eta?: string
  size?: string
  error?: string
}

/**
 * 公共 tracker 已迁到 `trackers.ts`（V1.5.2：支持社区列表自动更新 + 磁盘缓存）。
 * 这里保留常量名只是为了不破坏可能引用它的旧代码。
 */
const PUBLIC_TRACKERS = ''

function mapStatus(s: string): DownloadStatus {
  switch (s) {
    case 'active':
      return 'downloading'
    case 'waiting':
      return 'queued'
    case 'paused':
      return 'paused'
    case 'complete':
      return 'seeding'
    case 'error':
    case 'removed':
      return 'error'
    default:
      return 'queued'
  }
}

/** 内置 aria2 下载器（方案 4.3：JSON-RPC 控制） */
class Aria2Client {
  private proc: ChildProcess | null = null
  private started = false

  private get cfg() {
    return getSettings().downloader.aria2
  }

  private rpcUrl(): string {
    return `http://${this.cfg.host}:${this.cfg.port}/jsonrpc`
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const body = {
      jsonrpc: '2.0',
      id: `sakana-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method,
      params: this.cfg.secret ? [`token:${this.cfg.secret}`, ...params] : params
    }
    const res = await axios.post(this.rpcUrl(), body, { timeout: 8000 })
    const data = res.data as { error?: { message?: string }; result?: T }
    if (data?.error) throw new Error(data.error.message ?? 'aria2 RPC 错误')
    return data?.result as T
  }

  /** 查找可用的 aria2c：设置路径优先，其次打包资源目录，再项目内置 */
  async findBinary(): Promise<string | null> {
    const configured = this.cfg.binaryPath
    if (configured && existsSync(configured)) return configured
    const candidates: string[] = [
      // 打包后：extraResources 会把 resources/* 放到 process.resourcesPath
      join(process.resourcesPath ?? '', 'aria2', 'aria2c.exe'),
      join(app.getAppPath(), 'resources', 'aria2', 'aria2c.exe')
    ]
    for (const p of candidates) {
      if (p && existsSync(p)) return p
    }
    return null
  }

  async ensureRunning(): Promise<void> {
    if (this.started) {
      try {
        await this.rpc('aria2.getVersion', [])
        // 已连上也要把关键参数推过去：可能是上次运行残留的实例（旧参数会让 BT 找不到做种者）
        await this.applyOptions()
        return
      } catch {
        this.started = false
      }
    }
    const bin = await this.findBinary()
    if (!bin) {
      throw new Error('未找到 aria2c：请在「设置 → 下载器配置」中指定 aria2c.exe 路径，或运行 npm run aria2:fetch 下载内置 aria2')
    }
    const { port, secret, maxConcurrent } = this.cfg
    const downloadDir = getSettings().downloadDir || join(app.getPath('userData'), 'downloads')
    mkdirSync(downloadDir, { recursive: true })
    /*
     * V1.5.2「下载器加速」：按用户给的方案调 aria2 参数。
     *
     * · HTTP/通用：max-connection-per-server / split / min-split-size —— 对直链下载提速最明显；
     * · BT：bt-max-peers / bt-request-peer-speed-limit / DHT+PEX+LPD / Tracker 列表；
     * · 磁盘：prealloc（Windows 上 falloc 不可用，prealloc 等效）+ disk-cache + auto-save-interval；
     * · DHT 持久化：dht-file-path 放到应用数据目录，长期积累节点表，磁力首次解析更快
     *   （用户提到"提前下载热门种子帮助生成健康的 dht.dat"，这里至少保证它不会被反复丢弃）。
     */
    const tune = resolveAria2Tuning(this.cfg)
    const dhtFile = join(app.getPath('userData'), 'tmp', 'aria2-dht.dat')
    try {
      mkdirSync(dirname(dhtFile), { recursive: true })
    } catch {
      /* 目录不可写时 aria2 会退回默认路径 */
    }
    const args = [
      '--enable-rpc',
      `--rpc-listen-port=${port}`,
      ...(secret ? [`--rpc-secret=${secret}`] : []),
      `--dir=${downloadDir}`,
      '--auto-file-renaming=false',
      '--seed-time=0',
      '--file-allocation=prealloc',
      '--auto-save-interval=20',
      `--disk-cache=${tune.diskCache}`,
      `--max-concurrent-downloads=${maxConcurrent > 0 ? maxConcurrent : 5}`,
      `--max-connection-per-server=${tune.maxConnectionPerServer}`,
      `--split=${tune.split}`,
      `--min-split-size=${tune.minSplitSize}`,
      `--lowest-speed-limit=${tune.lowestSpeedLimit}`,
      '--timeout=30',
      '--connect-timeout=20',
      '--continue=true',
      '--console-log-level=warn',
      // BT 加速：蜜柑种子里自带的 tracker 常年失效，用合并后的公共/社区列表替换
      `--bt-tracker=${currentTrackerString()}`,
      /*
       * V1.5.2 修「卡在寻找做种者」（关键）：
       *
       * 蜜柑种子的 announce-list 里通常写死 `tr.bangumi.moe` / `t.nyaatracker.com` /
       * `open.acgtracker.com` / `open.nyaatorrents.info` —— 前三个实测**全部超时或 0 peer**。
       * aria2 的 multi-tracker 是按 tier 顺序 announce 的：它会先在这些死 tracker 上耗完
       * 连接/响应超时和重试，很久之后才轮到我们追加的 `--bt-tracker`。
       * 实测同一颗种子：不加排除 → 60 秒 `CN:0 SD:0`；加 `--bt-exclude-tracker=*`
       * 只用我们自己的列表（含 nyaa）→ 10 秒内 `CN:17 SD:2` 并开始下载。
       *
       * `*` 只清空**种子里自带**的 tracker，`--bt-tracker` 追加的列表不受影响（aria2 文档明确说明）。
       * 代价：极少数种子的私有 tracker 会被忽略 —— 蜜柑资源都是公网种子，不存在这个问题。
       */
      '--bt-exclude-tracker=*',
      '--bt-tracker-connect-timeout=6',
      '--bt-tracker-timeout=6',
      /*
       * announce 间隔压到 120 秒：默认跟随 tracker 返回（实测 nyaatracker 给 1800 秒），
       * 第一轮拿到空 peer 列表后要等半小时才会重问 —— 那时界面早就一直停在「寻找做种者」。
       */
      '--bt-tracker-interval=120',
      `--bt-max-peers=${tune.btMaxPeers}`,
      '--enable-dht=true',
      '--enable-dht6=false',
      /*
       * DHT 引导节点多给几个：aria2 默认只写一个 router.bittorrent.com，
       * 那个地址在某些网络里不通时「DHT 全废」，只能靠 tracker —— 而蜜柑种子的 tracker 又常常是死的。
       * 这五个节点都是公开的常用引导点，任一可达即可拉起节点表。
       */
      '--dht-entry-point=router.bittorrent.com:6881',
      '--dht-entry-point=router.utorrent.com:6881',
      '--dht-entry-point=dht.transmissionbt.com:6881',
      '--dht-entry-point=dht.libtorrent.org:25401',
      '--dht-entry-point=dht.aelitis.com:6881',
      `--dht-file-path=${dhtFile}`,
      '--enable-peer-exchange=true',
      '--bt-enable-lpd=true',
      `--listen-port=${tune.listenPort}`,
      `--bt-request-peer-speed-limit=${tune.btRequestPeerSpeedLimit}`
    ]
    try {
      this.proc = spawn(bin, args, { stdio: 'ignore', windowsHide: true })
    } catch (err) {
      throw new Error(`aria2c 启动失败: ${String(err)}`)
    }
    this.proc.on('error', (err) => {
      log.append('error', 'aria2', `aria2c 进程错误: ${err.message}`)
      this.started = false
    })
    this.proc.on('exit', (code) => {
      log.append('warn', 'aria2', `aria2c 退出 (code=${code ?? '?'})`)
      this.started = false
    })
    // 等待 RPC 就绪
    for (let i = 0; i < 12; i++) {
      await sleep(500)
      try {
        await this.rpc('aria2.getVersion', [])
        this.started = true
        // 同步关键参数（覆盖已运行实例/残留进程的旧参数）
        await this.applyOptions()
        log.append(
          'info',
          'aria2',
          `aria2c 已连接 (端口 ${port}, 并发 ${maxConcurrent}, tracker ${currentTrackerString().split(',').length} 条，已排除种子内嵌 tracker)`
        )
        return
      } catch {
        /* 继续等待 */
      }
    }
    throw new Error('aria2 RPC 未就绪：端口可能被占用或 aria2c 启动失败')
  }

  /** 把关键参数推给当前运行的实例（含"复用了上次残留进程"的情况） */
  private async applyOptions(): Promise<void> {
    const { maxConcurrent } = this.cfg
    const tune = resolveAria2Tuning(this.cfg)
    const downloadDir = getSettings().downloadDir || join(app.getPath('userData'), 'downloads')
    try {
      mkdirSync(downloadDir, { recursive: true })
    } catch {
      /* ignore */
    }
    try {
      await this.rpc('aria2.changeGlobalOption', [
        {
          dir: downloadDir,
          'max-concurrent-downloads': String(maxConcurrent > 0 ? maxConcurrent : 5),
          // V1.5.2：连接/分片/低速剔除/磁盘缓存（HTTP 与 BT 都受益的几项）
          'max-connection-per-server': String(tune.maxConnectionPerServer),
          split: String(tune.split),
          'min-split-size': tune.minSplitSize,
          'lowest-speed-limit': tune.lowestSpeedLimit,
          'disk-cache': tune.diskCache,
          'auto-save-interval': '20',
          // Tracker 用合并后的当前列表（社区列表 + 内置兜底）
          'bt-tracker': currentTrackerString(),
          'enable-dht': 'true',
          'enable-peer-exchange': 'true',
          'bt-enable-lpd': 'true',
          'bt-max-peers': String(tune.btMaxPeers),
          'bt-request-peer-speed-limit': tune.btRequestPeerSpeedLimit,
          'seed-time': '0',
          'auto-file-renaming': 'false',
          'file-allocation': 'prealloc'
        }
      ])
    } catch (err) {
      log.append('warn', 'aria2', `同步 aria2 参数失败（继续使用默认值）: ${String((err as Error)?.message ?? err)}`)
    }
    /*
     * V1.5.2：单独再推一次「BT tracker 策略」。
     *
     * 为什么要单独一次：`--bt-exclude-tracker` 是修复「卡在寻找做种者」的关键（见启动参数注释），
     * 但它是**启动参数**；如果复用的是上次残留的 aria2 进程（旧参数），exclude 不会生效。
     * 放在独立 try 里：万一这组选项在某个版本不可热更，也只会丢这几项，不会影响上面的
     * dir / 并发 / tracker 列表等真正重要的设置。
     */
    try {
      await this.rpc('aria2.changeGlobalOption', [
        {
          'bt-exclude-tracker': '*',
          'bt-tracker-interval': '120',
          'bt-tracker-connect-timeout': '6',
          'bt-tracker-timeout': '6'
        }
      ])
    } catch (err) {
      log.append(
        'warn',
        'aria2',
        `BT tracker 策略未能热更（继续用启动参数；若是旧进程请重启应用）：${String((err as Error)?.message ?? err)}`
      )
    }
    /*
     * Tracker 刷新放后台：ensureRunning 不该为了几 KB 的列表多等一次网络。
     * 拉到新列表后再推一次 bt-tracker（changeGlobalOption 支持热更，不需重启 aria2）。
     */
    void refreshTrackers()
      .then((r) => {
        if (r.updated) return this.pushTrackers()
        return undefined
      })
      .catch(() => undefined)
  }

  /** 把当前 Tracker 列表热更到运行中的 aria2（设置页「立即更新」也走这里） */
  private async pushTrackers(): Promise<void> {
    if (!this.started) return
    try {
      await this.rpc('aria2.changeGlobalOption', [{ 'bt-tracker': currentTrackerString() }])
      log.append('info', 'aria2', `已热更新 Tracker 列表（${currentTrackerString().split(',').length} 条），无需重启 aria2`)
    } catch (err) {
      log.append('warn', 'aria2', `Tracker 热更新失败：${String((err as Error)?.message ?? err)}`)
    }
  }

  /**
   * 设置页「立即更新 Tracker」：强制拉一次社区列表并热更到运行中的实例。
   * 没在跑时只更新磁盘缓存，下次启动自动用新列表。
   */
  async refreshTrackersNow(): Promise<{ updated: boolean; status: TrackerStatus }> {
    const r = await refreshTrackers(true)
    if (r.updated) await this.pushTrackers()
    return { updated: r.updated, status: trackerStatus() }
  }

  /** 当前 Tracker 状态（设置页显示条数/更新时间/错误） */
  trackerStatus(): TrackerStatus {
    return trackerStatus()
  }

  /**
   * 供设置页「文件保存配置」立即生效使用：把新的下载目录推给运行中的 aria2。
   * 已启动实例的 `--dir` 是全局选项，不改的话改了设置也还是往旧目录里写。
   */
  async refreshDir(): Promise<void> {
    if (!this.started) return
    await this.applyOptions()
  }

  async getVersion(): Promise<string> {
    const r = await this.rpc<{ version?: string }>('aria2.getVersion', [])
    return r?.version ?? 'ok'
  }

  async addUri(magnet: string, dir: string): Promise<string> {
    const gid = await this.rpc<string>('aria2.addUri', [[magnet], { dir }])
    return String(gid)
  }

  async addTorrentBase64(b64: string, dir: string): Promise<string> {
    const gid = await this.rpc<string>('aria2.addTorrent', [b64, [], { dir }])
    return String(gid)
  }

  async status(gid: string): Promise<Aria2Progress | null> {
    try {
      const s = await this.rpc<Record<string, unknown>>('aria2.tellStatus', [
        gid,
        [
          'status',
          'totalLength',
          'completedLength',
          'downloadSpeed',
          'connections',
          'numSeeders',
          'errorCode',
          'errorMessage',
          'bittorrent',
          'files'
        ]
      ])
      const status = mapStatus(String(s?.status ?? 'error'))
      const total = Number(s?.totalLength ?? 0)
      const done = Number(s?.completedLength ?? 0)
      const progress = total > 0 ? Math.min(100, (done / total) * 100) : 0
      // 错误码也要带上：aria2 的 errorMessage 在部分场景是空的（例如 3=资源未找到）
      const code = s?.errorCode !== undefined ? String(s.errorCode) : ''
      const msg = String(s?.errorMessage ?? '')
      const speedBytes = Number(s?.downloadSpeed ?? 0)
      return {
        status,
        progress,
        // 速度为 0 时不显示 "-/s" 这种噪声，交给上层展示"等待做种者"
        speed: speedBytes > 0 ? humanSize(speedBytes) + '/s' : undefined,
        peers: Number(s?.connections ?? 0),
        seeders: Number(s?.numSeeders ?? 0),
        eta: progress > 0 && speedBytes > 0
          ? humanSize((total - done) / speedBytes * 1000)
          : undefined,
        size: total > 0 ? humanSize(total) : undefined,
        error:
          status === 'error'
            ? `${msg || '未知错误'}${code && code !== '0' ? `（aria2 错误码 ${code}）` : ''}`
            : undefined
      }
    } catch {
      return null
    }
  }

  /** 诊断用：原始 tellStatus（含错误码、连接数、做种数等） */
  async rawStatus(gid: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.rpc<Record<string, unknown>>('aria2.tellStatus', [
        gid,
        [
          'status',
          'totalLength',
          'completedLength',
          'downloadSpeed',
          'connections',
          'numSeeders',
          'errorCode',
          'errorMessage',
          'dir',
          'files'
        ]
      ])
    } catch (err) {
      return { rpcError: String((err as Error)?.message ?? err) }
    }
  }

  async files(gid: string): Promise<{ path: string }[]> {
    try {
      const s = await this.rpc<{ files?: { path: string }[] }>('aria2.tellStatus', [gid, ['files']])
      return s?.files ?? []
    } catch {
      return []
    }
  }

  async pause(gid: string): Promise<void> {
    await this.rpc('aria2.pause', [gid])
  }

  async unpause(gid: string): Promise<void> {
    await this.rpc('aria2.unpause', [gid])
  }

  async remove(gid: string): Promise<void> {
    try {
      await this.rpc('aria2.remove', [gid])
    } catch {
      /* 任务可能已完成 */
    }
    try {
      await this.rpc('aria2.removeDownloadResult', [gid])
    } catch {
      /* ignore */
    }
  }

  /**
   * 停止 aria2c。
   *
   * ⚠️ v0.3.6 修（审计查出的高危遗留）：**不能只 `this.proc?.kill()`**。
   *
   * `ensureRunning()` 有一段「复用已运行实例」的逻辑：启动时先等 RPC 就绪，
   * 如果端口上**已经有一个 aria2c**（最典型的来源是上次被强杀/崩溃留下的孤儿进程），
   * 它会连上那个实例并把 `started = true` —— 而 `this.proc` 此时指向的是**自己刚 spawn 的、
   * 因为端口被占已经退出的那个子进程**。于是旧实现的两个后果都很糟：
   *   ① 孤儿 aria2c 永远不会被停（`kill()` 杀的是一个已经死掉的 pid），
   *      它会继续占着 6800 端口、可能仍在做 BT 下载，用户看起来就是「有没用的进程一直在跑」；
   *   ② 下次启动会再「复用」它，一直循环下去；而且它占着
   *      `resources\aria2\aria2c.exe`，增量更新脚本的 `Copy-Item -Force` 会失败
   *      （脚本里 `$ErrorActionPreference='Continue'`，失败是静默的）→ 新旧文件混装。
   *
   * 现在的策略是「先礼后兵」：先发 aria2 自己的 `aria2.shutdown` RPC（它会让进程体面退出），
   * 再对本进程 spawn 出来的那个子进程 `kill()` 兜底。
   * 两步都包在 try 里：RPC 通道已经断了、或进程早已退出，都不该让退出流程报错。
   */
  stop(): void {
    const proc = this.proc
    this.proc = null
    const wasStarted = this.started
    this.started = false
    if (wasStarted) {
      // 异步发完就不管了：Electron 退出流程不该等网络往返（RPC 超时上限 6 秒）
      void this.rpc('aria2.shutdown', []).catch(() => {
        /* 通道已断、或那个实例不是我们启的（会报未授权）—— 都交给下面的 kill 兜底 */
      })
    }
    try {
      proc?.kill()
    } catch {
      /* ignore */
    }
  }
}

export const aria2 = new Aria2Client()

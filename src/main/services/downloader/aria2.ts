import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import type { DownloadStatus } from '@shared/types'
import { humanSize } from '../../lib/parse'
import { log } from '../../log'
import { getSettings } from '../../net'

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

/** 公共 tracker（蜜柑种子自带的 tracker 多数已失效，补一批以加快做种者发现） */
const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://9.rarbg.com:2810/announce'
].join(',')

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
    const args = [
      '--enable-rpc',
      `--rpc-listen-port=${port}`,
      ...(secret ? [`--rpc-secret=${secret}`] : []),
      `--dir=${downloadDir}`,
      '--auto-file-renaming=false',
      '--seed-time=0',
      '--file-allocation=none',
      `--max-concurrent-downloads=${maxConcurrent > 0 ? maxConcurrent : 5}`,
      '--continue=true',
      '--console-log-level=warn',
      // BT 加速：蜜柑种子里自带的 tracker 常年失效，补一批公共 tracker 并开启
      // DHT/PEX/LPD，否则会出现「任务在跑但连接数恒为 0、进度永远 0%」。
      `--bt-tracker=${PUBLIC_TRACKERS}`,
      '--bt-tracker-connect-timeout=10',
      '--bt-tracker-timeout=10',
      '--bt-max-peers=100',
      '--enable-dht=true',
      '--enable-dht6=false',
      '--dht-entry-point=router.bittorrent.com:6881',
      '--enable-peer-exchange=true',
      '--bt-enable-lpd=true',
      '--listen-port=6881-6999',
      '--bt-request-peer-speed-limit=51200'
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
        log.append('info', 'aria2', `aria2c 已连接 (端口 ${port}, 并发 ${maxConcurrent})`)
        return
      } catch {
        /* 继续等待 */
      }
    }
    throw new Error('aria2 RPC 未就绪：端口可能被占用或 aria2c 启动失败')
  }

  /** 把关键参数推给当前运行的实例（含"复用了上次残留进程"的情况） */
  private async applyOptions(): Promise<void> {    const { maxConcurrent } = this.cfg
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
          'bt-tracker': PUBLIC_TRACKERS,
          'enable-dht': 'true',
          'enable-peer-exchange': 'true',
          'bt-enable-lpd': 'true',
          'bt-max-peers': '100',
          'seed-time': '0',
          'auto-file-renaming': 'false',
          'file-allocation': 'none'
        }
      ])
    } catch (err) {
      log.append('warn', 'aria2', `同步 aria2 参数失败（继续使用默认值）: ${String((err as Error)?.message ?? err)}`)
    }
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

  stop(): void {
    try {
      this.proc?.kill()
    } catch {
      /* ignore */
    }
    this.proc = null
    this.started = false
  }
}

export const aria2 = new Aria2Client()

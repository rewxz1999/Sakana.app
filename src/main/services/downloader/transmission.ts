import axios from 'axios'
import type { DownloadStatus, TransmissionConfig, TransmissionStatus } from '@shared/types'
import { humanSize } from '../../lib/parse'
import { log } from '../../log'
import { getSettings } from '../../net'

/**
 * Transmission 下载器（V1.5.2，第三个可选引擎）。
 *
 * ## 为什么选它
 *
 * 用户给了几类候选：纯 Node 库（WebTorrent / @jstorrent）、独立守护进程（qBittorrent /
 * Transmission）、aria2 的封装。本轮的构建环境**无法联网装新依赖**，也没有随包二进制，
 * 所以纯 JS 引擎暂时做不了；而 Transmission 与已有的 qBittorrent 一样是「标准 RPC + 用户自装」，
 * 集成成本最低、也不会让安装包变大。界面会明确标注「需自行安装 Transmission」。
 *
 * ## RPC 要点（实测过的基础行为）
 *
 * · 端点是 `http://127.0.0.1:9091/transmission/rpc`，POST JSON `{method, arguments, tag}`；
 * · 首次请求一定 409，响应头 `X-Transmission-Session-Id` 要带回后续请求（否则永远 409）；
 * · `torrent-add` 用 `filename` 传磁力/种子 URL，成功时返回 `torrent-added`（或 `torrent-duplicate`）；
 * · 状态码：0 停止 / 1-2 校验 / 3 等待 / 4 下载 / 5-6 做种。
 *
 * 所有失败都转成可直接显示的中文原因；本类不做自动拉起（用户自己启动 Transmission 更稳）。
 */

const DEFAULT_URL = 'http://127.0.0.1:9091/transmission/rpc'

export interface TransmissionProgress {
  status: DownloadStatus
  progress: number
  speed?: string
  eta?: string
  size?: string
  peers?: number
  seeders?: number
  error?: string
}

function cfg(): Required<TransmissionConfig> {
  const s = getSettings() as { downloader?: { transmission?: TransmissionConfig } }
  const t = s.downloader?.transmission
  return {
    url: (t?.url ?? '').trim() || DEFAULT_URL,
    username: t?.username ?? '',
    password: t?.password ?? '',
    exePath: t?.exePath ?? ''
  }
}

function mapStatus(code: number): DownloadStatus {
  switch (code) {
    case 0:
      return 'paused'
    case 1:
    case 2:
      return 'parsing'
    case 3:
      return 'queued'
    case 4:
      return 'downloading'
    case 5:
    case 6:
      return 'seeding'
    default:
      return 'downloading'
  }
}

function shortErr(err: unknown): string {
  const e = err as { response?: { status?: number }; message?: string }
  if (e?.response?.status) return `HTTP ${e.response.status}`
  const m = String(e?.message ?? err)
  if (/ECONNREFUSED/i.test(m)) return '连不上 Transmission（守护进程没启动，或 RPC 端口/地址与设置不一致）'
  if (/timeout/i.test(m)) return 'Transmission 响应超时'
  return m.slice(0, 140)
}

class TransmissionClient {
  private sid = ''
  private lastGoodAt = 0

  private headers(): Record<string, string> {
    const c = cfg()
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.sid) h['X-Transmission-Session-Id'] = this.sid
    if (c.username || c.password) {
      h.Authorization = `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`
    }
    return h
  }

  /** 一次 RPC 调用（自动处理 409 拿 session id 的那一次重试） */
  private async rpc<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const url = cfg().url
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await axios.post(
        url,
        { method, arguments: args, tag: Date.now() % 100000 },
        {
          timeout: 12_000,
          validateStatus: () => true,
          headers: this.headers(),
          transformResponse: (d: unknown) => d
        }
      )
      const sid = String(res.headers['x-transmission-session-id'] ?? '')
      if (res.status === 409) {
        if (!sid) throw new Error('Transmission 要求会话 ID，但响应里没给')
        this.sid = sid
        continue
      }
      if (res.status >= 400) throw new Error(`Transmission RPC 返回 HTTP ${res.status}`)
      const data = typeof res.data === 'string' ? (JSON.parse(res.data) as unknown) : res.data
      const body = data as { result?: string; arguments?: T }
      if (body?.result && body.result !== 'success') throw new Error(`Transmission：${body.result}`)
      this.lastGoodAt = Date.now()
      return (body?.arguments ?? {}) as T
    }
    throw new Error('Transmission 会话握手失败（连续 409）')
  }

  /** 设置页/测试连接：真的问一次版本 */
  async ping(): Promise<TransmissionStatus> {
    const c = cfg()
    try {
      const r = await this.rpc<{ version?: string }>('session-get')
      return { reachable: true, url: c.url, version: r.version }
    } catch (err) {
      return { reachable: false, url: c.url, error: shortErr(err) }
    }
  }

  /**
   * 添加任务，返回 infohash。
   *
   * Transmission 的 `torrent-add` 对**磁力**是同步返回 hash 的（不需要等元数据），
   * 对 `.torrent` URL 会先下载种子再添加 —— 两种都返回 `torrent-added.hashString`。
   * 重复添加返回 `torrent-duplicate`，同样带 hash，直接复用。
   */
  async add(url: string, savepath: string): Promise<string> {
    try {
      const r = await this.rpc<{
        'torrent-added'?: { hashString?: string; name?: string }
        'torrent-duplicate'?: { hashString?: string; name?: string }
      }>('torrent-add', { filename: url, 'download-dir': savepath, paused: false })
      const hit = r['torrent-added'] ?? r['torrent-duplicate']
      const hash = String(hit?.hashString ?? '').trim().toLowerCase()
      if (!hash) {
        log.append('warn', 'download', 'Transmission 添加任务后没有返回 hash（可能被限流或被拒绝）')
        return ''
      }
      log.append('info', 'download', `Transmission 已添加任务：${hit?.name ?? hash.slice(0, 8)}`)
      return hash
    } catch (err) {
      throw new Error(`Transmission 添加任务失败：${shortErr(err)}`)
    }
  }

  async status(hash: string): Promise<TransmissionProgress | null> {
    try {
      const r = await this.rpc<{
        torrents?: {
          percentDone?: number
          rateDownload?: number
          eta?: number
          totalSize?: number
          status?: number
          error?: number
          errorString?: string
          peersConnected?: number
          peersSendingToUs?: number
        }[]
      }>('torrent-get', {
        ids: [hash],
        fields: [
          'percentDone',
          'rateDownload',
          'eta',
          'totalSize',
          'status',
          'error',
          'errorString',
          'peersConnected',
          'peersSendingToUs'
        ]
      })
      const t = r.torrents?.[0]
      if (!t) return null
      const progress = Math.round((Number(t.percentDone) || 0) * 1000) / 10
      const rate = Number(t.rateDownload) || 0
      const etaSec = Number(t.eta)
      /*
       * Transmission 的 eta 是**秒**，不是字节；这里必须自己格式化成 mm:ss，
       * 不能复用 humanSize（那是字节格式化，会显示成几 MB 的假数字）。
       */
      const etaText = (() => {
        if (!Number.isFinite(etaSec) || etaSec <= 0 || etaSec >= 864000) return undefined
        const s = Math.round(etaSec)
        const h = Math.floor(s / 3600)
        const m = Math.floor((s % 3600) / 60)
        const ss = String(s % 60).padStart(2, '0')
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
      })()
      return {
        status: mapStatus(Number(t.status) || 0),
        progress,
        speed: rate > 0 ? `${humanSize(rate)}/s` : undefined,
        eta: etaText,
        size: Number(t.totalSize) > 0 ? humanSize(Number(t.totalSize)) : undefined,
        peers: Number(t.peersConnected) || 0,
        seeders: Number(t.peersSendingToUs) || 0,
        error: Number(t.error) > 0 ? String(t.errorString ?? `错误码 ${t.error}`) : undefined
      }
    } catch {
      return null
    }
  }

  async pause(hash: string): Promise<void> {
    await this.rpc('torrent-stop', { ids: [hash] })
  }

  async resume(hash: string): Promise<void> {
    await this.rpc('torrent-start', { ids: [hash] })
  }

  /** 只从下载器移除任务，**不删文件**（文件由应用自己的删除流程处理） */
  async remove(hash: string): Promise<void> {
    await this.rpc('torrent-remove', { ids: [hash], 'delete-local-data': false })
  }

  /** 上次成功通讯的时间（诊断/设置页显示） */
  lastOkAt(): number {
    return this.lastGoodAt
  }
}

export const transmission = new TransmissionClient()

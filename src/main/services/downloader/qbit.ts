import axios from 'axios'
import type { DownloadStatus } from '@shared/types'
import { humanSize } from '../../lib/parse'
import { getSettings } from '../../net'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface QbitProgress {
  status: DownloadStatus
  progress: number
  speed?: string
  eta?: string
  size?: string
  error?: string
}

function mapState(s: string): DownloadStatus {
  switch (s) {
    case 'downloading':
    case 'stalledDL':
    case 'forcedDL':
      return 'downloading'
    case 'queuedDL':
      return 'queued'
    case 'metaDL':
      return 'torrent'
    case 'checkingDL':
    case 'checkingUP':
    case 'allocating':
      return 'parsing'
    case 'pausedDL':
      return 'paused'
    case 'uploading':
    case 'stalledUP':
    case 'forcedUP':
      return 'seeding'
    case 'missingFiles':
    case 'error':
      return 'error'
    default:
      return 'queued'
  }
}

/** 外部 qBittorrent 下载器（方案 4.3：Web API） */
class QbitClient {
  private cookies = ''

  private base(): string {
    return getSettings().downloader.qbit.url.replace(/\/+$/, '')
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Cookie: this.cookies, Referer: this.base(), ...extra }
  }

  async login(): Promise<void> {
    const { username, password } = getSettings().downloader.qbit
    const form = new URLSearchParams({ username, password }).toString()
    const res = await axios.post(`${this.base()}/api/v2/auth/login`, form, {
      timeout: 8000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: this.base() }
    })
    const setCookie = res.headers['set-cookie'] as string[] | string | undefined
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
    this.cookies = list.map((c) => c.split(';')[0]).join('; ')
    if (res.data !== 'Ok.') {
      this.cookies = ''
      throw new Error('qBittorrent 登录失败')
    }
  }

  private async ensureLogin(): Promise<void> {
    if (!this.cookies) await this.login()
  }

  async test(): Promise<string> {
    await this.login()
    const res = await axios.get(`${this.base()}/api/v2/app/version`, {
      timeout: 8000,
      headers: this.headers()
    })
    return String(res.data ?? 'ok')
  }

  /** 本次进程内已被认领的 hash（并发添加时避免两个任务抢同一个 torrent） */
  private claimed = new Set<string>()

  private async sakanaList(): Promise<{ hash: string; name: string }[]> {
    const res = await axios.get<{ hash: string; name: string }[]>(
      `${this.base()}/api/v2/torrents/info?tag=sakana&sort=added_on&reverse=true&limit=20`,
      { timeout: 8000, headers: this.headers() }
    )
    return res.data ?? []
  }

  async add(url: string, savepath: string): Promise<string> {
    await this.ensureLogin()
    // 记录添加前的集合：添加后「新出现且未被认领」的才是本次任务
    let before = new Set<string>()
    try {
      before = new Set((await this.sakanaList()).map((t) => t.hash))
    } catch {
      /* 取不到就退化为按名字匹配 */
    }
    const form = new URLSearchParams({ urls: url, savepath, tags: 'sakana' }).toString()
    const res = await axios.post(`${this.base()}/api/v2/torrents/add`, form, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...this.headers() }
    })
    if (res.data !== 'Ok.') throw new Error('qBittorrent 添加任务失败')
    // 磁力链接自带 dn（显示名），优先按名字精确匹配，避免"最近一条"被并发添加串台
    const dnMatch = /[?&]dn=([^&]+)/.exec(url)
    const wantName = dnMatch ? decodeURIComponent(dnMatch[1]) : ''
    for (let i = 0; i < 10; i++) {
      const list = await this.sakanaList()
      const cands = list.filter((t) => !before.has(t.hash) && !this.claimed.has(t.hash))
      const hit = wantName ? cands.find((t) => t.name === wantName) : undefined
      const pick = hit ?? (cands.length === 1 ? cands[0] : undefined)
      if (pick) {
        this.claimed.add(pick.hash)
        return pick.hash
      }
      await sleep(500)
    }
    return ''
  }

  async status(hash: string): Promise<QbitProgress | null> {
    try {
      await this.ensureLogin()
      const res = await axios.get<
        {
          state?: string
          progress?: number
          dlspeed?: number
          eta?: number
          size?: number
        }[]
      >(`${this.base()}/api/v2/torrents/info?hashes=${encodeURIComponent(hash)}`, {
        timeout: 8000,
        headers: this.headers()
      })
      const t = res.data?.[0]
      if (!t) return null
      const status = mapState(t.state ?? '')
      const speed = Number(t.dlspeed ?? 0)
      return {
        status,
        progress: Math.min(100, Number(t.progress ?? 0) * 100),
        speed: speed > 0 ? humanSize(speed) + '/s' : undefined,
        eta: t.eta != null && t.eta > 0 ? humanSize(t.eta * 1000) : undefined,
        size: t.size ? humanSize(Number(t.size)) : undefined
      }
    } catch {
      return null
    }
  }

  async pause(hash: string): Promise<void> {
    await this.ensureLogin()
    await axios.post(
      `${this.base()}/api/v2/torrents/pause`,
      new URLSearchParams({ hashes: hash }).toString(),
      { timeout: 8000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...this.headers() } }
    )
  }

  async resume(hash: string): Promise<void> {
    await this.ensureLogin()
    await axios.post(
      `${this.base()}/api/v2/torrents/resume`,
      new URLSearchParams({ hashes: hash }).toString(),
      { timeout: 8000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...this.headers() } }
    )
  }

  async remove(hash: string): Promise<void> {
    await this.ensureLogin()
    await axios.post(
      `${this.base()}/api/v2/torrents/delete`,
      new URLSearchParams({ hashes: hash, deleteFiles: 'false' }).toString(),
      { timeout: 8000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...this.headers() } }
    )
  }
}

export const qbit = new QbitClient()

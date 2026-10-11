import axios from 'axios'
import type { DownloadStatus } from '@shared/types'
import { humanSize } from '../../lib/parse'
import { log } from '../../log'
import { getSettings, httpGetBuffer } from '../../net'
import { infohashFromUrl } from './torrentHash'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface QbitProgress {
  status: DownloadStatus
  progress: number
  speed?: string
  eta?: string
  size?: string
  /** qb 的 leech/seed 数（和 aria2 一样把对端情况显示出来，避免 qb 模式下这一行永远是空的） */
  peers?: number
  seeders?: number
  error?: string
}

/** WebUI 探测结果（不抛错，供启动器/设置页展示真实原因） */
export interface QbitPing {
  ok: boolean
  /** 例如 "v5.2.1" */
  version?: string
  /** 例如 "2.11.4"，5.x 的 pause/stop 端点改名就是靠它区分的 */
  webapiVersion?: string
  /** 连不上时的中文原因（可直接显示给用户） */
  error?: string
}

function mapState(s: string): DownloadStatus {
  switch (s) {
    case 'downloading':
    case 'stalledDL':
    case 'forcedDL':
      return 'downloading'
    case 'queuedDL':
    case 'queuedUP':
      return 'queued'
    case 'metaDL':
    case 'forcedMetaDL':
      return 'torrent'
    case 'checkingDL':
    case 'checkingUP':
    case 'checkingResumeData':
    case 'allocating':
    case 'moving':
      return 'parsing'
    /*
     * v5.x 把「暂停」改名成「停止」：状态字符串 pausedDL/pausedUP 变成 stoppedDL/stoppedUP。
     * 不认这两个字符串的话，qb 5 里暂停的任务会掉进 default 分支显示成「排队中」。
     */
    case 'pausedDL':
    case 'pausedUP':
    case 'stoppedDL':
    case 'stoppedUP':
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

/**
 * 外部 qBittorrent 下载器（Web API v2）。
 *
 * 实测差异（qBittorrent v5.2.1，见工单报告）：
 * - `POST /auth/login` 在 4.x 返回 200 + 文本 `Ok.`，**5.x 返回 204 + 空响应体**。
 *   老代码写死 `res.data !== 'Ok.'` 就抛「登录失败」，于是 test() 在 qb 5 上必然报错，
 *   而实际上 Cookie 早就发下来了（204 就是登录成功）。
 * - `POST /torrents/pause` / `torrents/resume` 在 5.x 被**移除**（404），改名 `stop` / `start`。
 *   这里先试新名字，404 再退回旧名字，两代版本都能用。
 */
class QbitClient {
  private cookies = ''
  /** 上一次登录用的地址：地址改了要重新登录（否则会拿旧 Cookie 去请求新端口） */
  private cookieBase = ''
  /** 记住本进程实测可用的暂停/继续端点，避免每次下载都先吃一个 404 */
  private pauseApi: 'stop' | 'pause' | null = null
  private resumeApi: 'start' | 'resume' | null = null

  private base(): string {
    return getSettings().downloader.qbit.url.replace(/\/+$/, '')
  }

  private cfg(): { username: string; password: string } {
    const { username, password } = getSettings().downloader.qbit
    return { username, password }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Cookie: this.cookies, Referer: this.base(), ...extra }
  }

  /**
   * 把所有 axios/GUI 层错误翻译成能直接显示的中文原因。
   *
   * 设置页要「如实显示原因」，所以这里必须区分：没启动 / 端口不对 / 密码错 / 被限流 / 端点不存在，
   * 而不是统一报「连接失败」。
   */
  private explain(err: unknown, action: string): Error {
    const e = err as {
      code?: string
      message?: string
      response?: { status?: number; data?: unknown }
    }
    const base = this.base()
    const status = e?.response?.status
    const body = typeof e?.response?.data === 'string' ? e.response.data.slice(0, 120) : ''
    if (e?.code === 'ECONNREFUSED' || e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') {
      return new Error(
        `${action}失败：连不上 ${base}（qBittorrent 没在运行，或 WebUI 端口/地址与设置不一致）`
      )
    }
    if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') {
      return new Error(`${action}失败：地址解析不了（${base}），请检查「qBittorrent 地址」是否写错`)
    }
    if (status === 401) {
      return new Error(`${action}失败：qBittorrent 要求登录（401），请填写正确的用户名/密码`)
    }
    if (status === 403) {
      return new Error(
        `${action}失败：被 qBittorrent 拒绝（403）—— 用户名或密码不对；也可能是登录失败次数过多被临时封禁，或「WebUI → 验证」里勾选了仅允许特定网段`
      )
    }
    if (status === 404) {
      return new Error(`${action}失败：qBittorrent 没有这个接口（404）—— Web 用户界面版本过旧或过新，请升级/降级后重试`)
    }
    if (status === 409) {
      return new Error(
        `${action}失败：qBittorrent 返回 409 —— 该种子已经在 qb 的任务列表里，或请求过于频繁，稍后再试`
      )
    }
    return new Error(`${action}失败：${body || e?.message || String(err)}${status ? `（HTTP ${status}）` : ''}`)
  }

  private async post(path: string, form: Record<string, string>, timeout = 8000): Promise<string> {
    const res = await axios.post(`${this.base()}${path}`, new URLSearchParams(form).toString(), {
      timeout,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...this.headers() },
      // 4xx 也要读响应体（qb 的错误说明在里面），所以不直接抛
      validateStatus: () => true
    })
    if (res.status >= 400) {
      const err = new Error(`HTTP ${res.status}`) as Error & { response?: unknown }
      err.response = { status: res.status, data: res.data }
      throw err
    }
    return typeof res.data === 'string' ? res.data : ''
  }

  async login(): Promise<void> {
    const { username, password } = this.cfg()
    let res
    try {
      res = await axios.post(`${this.base()}/api/v2/auth/login`, new URLSearchParams({ username, password }).toString(), {
        timeout: 8000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: this.base() },
        validateStatus: () => true
      })
    } catch (err) {
      throw this.explain(err, 'qBittorrent 登录')
    }
    const setCookie = res.headers['set-cookie'] as string[] | string | undefined
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
    this.cookies = list.map((c) => c.split(';')[0]).join('; ')
    if (res.status >= 400) {
      const err = new Error(`HTTP ${res.status}`) as Error & { response?: unknown }
      err.response = { status: res.status, data: res.data }
      throw this.explain(err, 'qBittorrent 登录')
    }
    const body = typeof res.data === 'string' ? res.data.trim() : ''
    // 4.x 成功返回 "Ok."；5.x 返回 204 + 空体。只有明确写着 Fails 才算失败。
    if (/fails/i.test(body)) {
      throw new Error('qBittorrent 登录失败：用户名或密码不正确（可在设置页「WebUI → 验证」里核对）')
    }
    // 本机免密（WebUI\LocalHostAuth=false）时即使不填密码也会拿到 Cookie，这里不算错误
    if (!this.cookies) {
      log.append('info', 'download', 'qBittorrent 未下发会话 Cookie（可能已开启「跳过本机客户端身份验证」）')
    }
  }

  private async ensureLogin(): Promise<void> {
    const base = this.base()
    // 地址被用户改过（或换了端口）：旧 Cookie 对不上，必须重新登录
    if (this.cookies && this.cookieBase !== base) this.cookies = ''
    if (!this.cookies) {
      await this.login()
      this.cookieBase = base
    }
  }

  /** 统一的请求封装：会话过期（401/403）时重新登录并重试一次 */
  private async request<T>(
    method: 'get' | 'post',
    path: string,
    opts: { params?: Record<string, string>; form?: Record<string, string>; timeout?: number } = {}
  ): Promise<T> {
    await this.ensureLogin()
    const doCall = async (): Promise<T> => {
      const url = `${this.base()}${path}`
      const cfg = {
        timeout: opts.timeout ?? 8000,
        headers: this.headers(
          opts.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}
        ),
        validateStatus: () => true as const
      }
      const res =
        method === 'get'
          ? await axios.get(url, { ...cfg, params: opts.params })
          : await axios.post(url, new URLSearchParams(opts.form ?? {}).toString(), cfg)
      if (res.status >= 400) {
        const err = new Error(`HTTP ${res.status}`) as Error & { response?: unknown }
        err.response = { status: res.status, data: res.data }
        throw err
      }
      return res.data as T
    }
    try {
      return await doCall()
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 401 || status === 403) {
        // 会话失效：清掉 Cookie 重新登录一次
        this.cookies = ''
        await this.ensureLogin()
        try {
          return await doCall()
        } catch (err2) {
          throw this.explain(err2, 'qBittorrent 请求')
        }
      }
      throw err
    }
  }

  /** 只探测，不抛错：给「启动器」和设置页判断 qb 到底在不在、什么版本 */
  async ping(): Promise<QbitPing> {
    try {
      const version = String(await this.request<string>('get', '/api/v2/app/version', { timeout: 4000 }))
      let webapiVersion = ''
      try {
        webapiVersion = String(await this.request<string>('get', '/api/v2/app/webapiVersion', { timeout: 4000 }))
      } catch {
        /* 老版本可能没有这个端点 */
      }
      return { ok: true, version, webapiVersion }
    } catch (err) {
      // 统一走 explain()：否则已经登录过（有 Cookie）时会漏出 axios 的原始英文错误，
      // 用户看到的就是 "connect ECONNREFUSED" 而不是「qb 没运行 / 端口不对」；
      // 已经是中文原因的（login 里解释过）不要二次套壳，避免出现「…失败：…失败：…」
      const raw = (err as Error)?.message ?? String(err)
      return { ok: false, error: /^qBittorrent/.test(raw) ? raw : this.explain(err, 'qBittorrent 连接').message }
    }
  }

  /** 连接测试：成功返回版本描述，失败抛**中文可读**的原因（设置页直接显示） */
  async test(): Promise<string> {
    try {
      const version = String(await this.request<string>('get', '/api/v2/app/version', { timeout: 8000 }))
      let webapiVersion = ''
      try {
        webapiVersion = String(await this.request<string>('get', '/api/v2/app/webapiVersion', { timeout: 8000 }))
      } catch {
        /* 忽略 */
      }
      log.append(
        'info',
        'download',
        `qBittorrent 连接成功：${version}${webapiVersion ? `（WebAPI ${webapiVersion}）` : ''} @ ${this.base()}`
      )
      return `${version}${webapiVersion ? ` / WebAPI ${webapiVersion}` : ''}`
    } catch (err) {
      throw this.explain(err, 'qBittorrent 连接')
    }
  }

  /** 本次进程内已被认领的 hash（并发添加时避免两个任务抢同一个 torrent） */
  private claimed = new Set<string>()

  private async sakanaList(): Promise<{ hash: string; name: string }[]> {
    return this.request<{ hash: string; name: string }[]>('get', '/api/v2/torrents/info', {
      params: { tag: 'sakana', sort: 'added_on', reverse: 'true', limit: '20' }
    })
  }

  /** 按 infohash 查 qb 里的任务（不存在返回 null） */
  private async findByHash(hash: string): Promise<{ hash: string; name: string } | null> {
    if (!hash) return null
    try {
      const list = await this.request<{ hash: string; name: string }[]>('get', '/api/v2/torrents/info', {
        params: { hashes: hash }
      })
      return list?.[0] ?? null
    } catch {
      return null
    }
  }

  /**
   * 添加任务，返回 qb 的 hash（失败返回空串，调用方会把它标成 error 并给出原因）。
   *
   * 实测坑（qBittorrent 5.2.1 / WebAPI 2.15.1）：
   * 1. `/torrents/add` 是**异步**的：返回 202 + `{"pending_count":1,"added_torrent_ids":[]}`，
   *    拿不到 hash，只能之后去列表里找；
   * 2. **重复添加**时响应与首次完全一样（202/空 id），但 qb 不会新建任务，
   *    于是「添加前后比对」永远找不到新 hash —— 任务会卡在 0% 且 downloaderId 为空；
   * 3. 磁力已存在时还可能直接返回 **409 Conflict**。
   * 所以这里先用 infohash（磁力解析 / 下载 .torrent 计算）做确定性识别：
   * 已经在 qb 里就直接复用那个 hash，不走「猜」的路径。
   */
  async add(url: string, savepath: string): Promise<string> {
    await this.ensureLogin()
    const infohash = await infohashFromUrl(url, (u) => httpGetBuffer(u, 20000))
    if (infohash) {
      const existing = await this.findByHash(infohash)
      if (existing) {
        this.claimed.add(existing.hash)
        log.append('info', 'download', `该种子已在 qBittorrent 中（${existing.hash.slice(0, 8)}），直接复用: ${existing.name}`)
        return existing.hash
      }
    }
    // 记录添加前的集合：添加后「新出现且未被认领」的才是本次任务（4.x 没有 infohash 时靠它兜底）
    let before = new Set<string>()
    try {
      before = new Set((await this.sakanaList()).map((t) => t.hash))
    } catch {
      /* 取不到就退化为按名字匹配 */
    }
    // 磁力链接自带 dn（显示名），优先按名字精确匹配，避免"最近一条"被并发添加串台
    const dnMatch = /[?&]dn=([^&]+)/.exec(url)
    const wantName = dnMatch ? decodeURIComponent(dnMatch[1]) : ''
    const form = { urls: url, savepath, tags: 'sakana' }
    try {
      const raw = await this.request<unknown>('post', '/api/v2/torrents/add', { form, timeout: 20000 })
      /*
       * 成功时 qb 返回 `Ok.`（4.x）或空响应体（5.x）；解析成非字符串时（axios 对空体的处理随
       * content-type 而变）不能当成错误 —— 真正的失败是 4xx/5xx，上面已经抛过了。
       */
      const body = typeof raw === 'string' ? raw.trim() : ''
      if (body && !/^ok\.?$/i.test(body)) throw new Error(`qBittorrent 添加任务失败：${body.slice(0, 120)}`)
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status
      // 409 = qb 侧冲突（该种子已在任务列表里）：不是错误，继续按 infohash 找回它
      if (status !== 409) throw this.explain(err, '添加下载任务')
      log.append('info', 'download', 'qBittorrent 返回 409（该种子可能已在 qb 里），按 infohash 复用已有任务')
    }
    for (let i = 0; i < 15; i++) {
      // 优先按 infohash 确认：重复添加 / 元数据还在抓的时候，只有它能确定性命中
      if (infohash) {
        const hit = await this.findByHash(infohash)
        if (hit) {
          this.claimed.add(hit.hash)
          return hit.hash
        }
      }
      const list = await this.sakanaList().catch(() => [])
      const cands = list.filter((t) => !before.has(t.hash) && !this.claimed.has(t.hash))
      const hit = wantName ? cands.find((t) => t.name === wantName) : undefined
      const pick = hit ?? (cands.length === 1 ? cands[0] : undefined)
      if (pick) {
        this.claimed.add(pick.hash)
        return pick.hash
      }
      await sleep(500)
    }
    if (infohash) {
      // 还没出现在列表里（qb 还在抓元数据）：先把 hash 记住，后续轮询能接上
      log.append('info', 'download', `qBittorrent 尚未登记该任务，先按 infohash 记录: ${infohash}`)
      this.claimed.add(infohash)
      return infohash
    }
    log.append('warn', 'download', 'qBittorrent 添加任务后没能确认 hash（可能被重复添加或被限流）')
    return ''
  }

  async status(hash: string): Promise<QbitProgress | null> {
    try {
      const res = await this.request<
        {
          state?: string
          progress?: number
          dlspeed?: number
          eta?: number
          size?: number
          num_leechs?: number
          num_seeds?: number
        }[]
      >('get', '/api/v2/torrents/info', { params: { hashes: hash } })
      const t = res?.[0]
      if (!t) return null
      const status = mapState(t.state ?? '')
      const speed = Number(t.dlspeed ?? 0)
      // qb 用 8640000 表示「剩余时间无限」，不要显示成 8640 秒
      const eta = t.eta != null && t.eta > 0 && t.eta < 8640000 ? t.eta : null
      return {
        status,
        progress: Math.min(100, Number(t.progress ?? 0) * 100),
        speed: speed > 0 ? humanSize(speed) + '/s' : undefined,
        eta: eta != null ? humanSize(eta * 1000) : undefined,
        size: t.size ? humanSize(Number(t.size)) : undefined,
        peers: t.num_leechs != null ? Number(t.num_leechs) : undefined,
        seeders: t.num_seeds != null ? Number(t.num_seeds) : undefined
      }
    } catch (err) {
      // 状态查询失败不抛（轮询里会一直重试），但要留下真实原因便于排障
      log.append('warn', 'download', `查询 qBittorrent 进度失败：${(err as Error)?.message ?? String(err)}`)
      return null
    }
  }

  /** 暂停：5.x 用 stop，4.x 用 pause（先试新名字，404 自动回退并记住） */
  private async control(kind: 'pause' | 'resume', hash: string): Promise<void> {
    const remembered = kind === 'pause' ? this.pauseApi : this.resumeApi
    const candidates: string[] =
      kind === 'pause' ? ['stop', 'pause'] : ['start', 'resume']
    const order = remembered ? [remembered, ...candidates.filter((c) => c !== remembered)] : candidates
    let lastErr: unknown = null
    for (const ep of order) {
      try {
        await this.request<void>('post', `/api/v2/torrents/${ep}`, { form: { hashes: hash } })
        if (kind === 'pause') this.pauseApi = ep as 'stop' | 'pause'
        else this.resumeApi = ep as 'start' | 'resume'
        return
      } catch (err) {
        lastErr = err
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status !== 404) break
      }
    }
    throw this.explain(lastErr, kind === 'pause' ? 'qBittorrent 暂停任务' : 'qBittorrent 继续任务')
  }

  async pause(hash: string): Promise<void> {
    await this.control('pause', hash)
  }

  async resume(hash: string): Promise<void> {
    await this.control('resume', hash)
  }

  async remove(hash: string): Promise<void> {
    // deleteFiles=false：删任务但**保留已下载的文件**（与内置 aria2 的删除口径一致）
    await this.request<void>('post', '/api/v2/torrents/delete', {
      form: { hashes: hash, deleteFiles: 'false' }
    })
  }
}

export const qbit = new QbitClient()

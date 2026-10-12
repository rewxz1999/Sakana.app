import dgram from 'node:dgram'
import axios from 'axios'
import type { BrowserWindow } from 'electron'
import { CH } from '@shared/channels'
import type { CastDevice, CastMediaInput, CastReceiverInfo } from '@shared/types'
import { log } from '../log'
import { getSettings } from '../net'
import { lanIPv4, startCastRelay, stopCastRelay, castRelayHits, castRelayRemoteHits, castRelayHitLog } from './castRelay'
import { store } from '../store'

/**
 * 投屏：发现设备 + 控制播放（v0.3.8）
 *
 * ## 支持两类接收端
 *
 * 1. **DLNA 电视/盒子**（标准协议，绝大多数电视都支持）
 *    - 发现：SSDP `M-SEARCH`（`urn:schemas-upnp-org:device:MediaRenderer:1`），
 *      再取设备描述 XML 拿 `friendlyName` 与 `AVTransport` / `RenderingControl` 的控制地址；
 *    - 控制：SOAP `SetAVTransportURI` / `Play` / `Pause` / `Stop` / `Seek` / `SetVolume`。
 *    - **限制**：DLNA 没法带 Referer/Cookie，所以需要鉴权的片源必须走本机中转（见 castRelay.ts）。
 *
 * 2. **Sakana 安卓接收端**（本仓库 `android-receiver/` 那个小应用）
 *    - 发现：UDP 广播 `{"sakana":"discover"}`（端口 52888），接收端单播回自己的名字与端口；
 *      接收端每 5 秒还会主动广播一次"我在"，所以电脑这边随时都能发现"已经打开的"设备；
 *    - 控制：HTTP JSON（`/ping` `/info` `/play` `/control`），**直接把 Referer/Cookie 交给它**，
 *      由它自己去 CDN 取流 —— 电脑完全不参与传输，这是最流畅的一条路。
 *
 * ## 手动连接（有线 / 其它网段）
 *
 * 广播发现只在同一广播域内有效：手机 USB 共享网络、或者电脑插网线而手机在 Wi-Fi 上时，
 * 广播到不了对端。所以界面上提供「手动填 IP:端口」，把可达性交给用户
 * （接收端的界面上会直接显示自己的 IP 与端口）。蓝牙在同一条思路上属于传输层，
 * 需要额外的原生能力，本期只做"地址可达"这一层。
 */

const SAKANA_PORT = 52888
const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
/** 设备表保留时长：超过这么久没再出现就从列表里去掉（避免列出已经关掉的设备） */
const DEVICE_TTL_MS = 60_000

const devices = new Map<string, CastDevice>()
let pushWin: BrowserWindow | null = null
let ssdpSock: dgram.Socket | null = null
let sakanaSock: dgram.Socket | null = null
let sweeper: NodeJS.Timeout | null = null

function devicesArray(): CastDevice[] {
  const now = Date.now()
  return [...devices.values()]
    .filter((d) => now - d.lastSeen < DEVICE_TTL_MS)
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'sakana' ? -1 : 1))
}

function pushDevices(): void {
  if (pushWin && !pushWin.isDestroyed() && !pushWin.webContents.isDestroyed()) {
    pushWin.webContents.send(CH.evCastDevices, devicesArray())
  }
}

function upsert(device: CastDevice): void {
  const prev = devices.get(device.id)
  devices.set(device.id, { ...prev, ...device, lastSeen: Date.now() })
  /*
   * 自动连接（v0.3.8，用户要求「启动时自动检测手机投屏应用是否打开，打开了就连接」）。
   *
   * 「连接」在这个架构里就是"记住默认投给谁"：电脑是客户端，没有长连接可维持，
   * 真正的连接动作发生在投屏那一刻。所以发现到 Sakana 接收端、且当前没有有效目标时，
   * 就把它记成默认目标（用户手动选过的优先，见 pickTargetDevice）。
   */
  const wanted = String((getSettings() as { castTargetId?: string }).castTargetId ?? '')
  const stillThere = wanted ? devicesArray().some((d) => d.id === wanted) : false
  if (device.kind === 'sakana' && (!wanted || !stillThere)) {
    const cur = store.get<Record<string, unknown>>('settings', {})
    store.set('settings', { ...cur, castTargetId: device.id })
    log.append('info', 'cast', `已自动连接移动端接收端：${device.name}（${device.host}:${device.port}）`)
  }
  pushDevices()
}

/** 广播地址：255.255.255.255 之外，再按 /24 推一个网段广播（部分系统不转发受限广播） */
function broadcastTargets(): string[] {
  const ip = lanIPv4()
  const out = ['255.255.255.255']
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip)
  if (m) out.push(`${m[1]}.${m[2]}.${m[3]}.255`)
  return out
}

// ---------------- 发现：Sakana 接收端（UDP 52888） ----------------

function ensureSakanaSocket(): dgram.Socket | null {
  if (sakanaSock) return sakanaSock
  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    /*
     * ⚠️ 必须用 `rinfo.address` 兜底（v0.3.8 修，接收端实现者帮我抓出来的）：
     * 早先这里只读报文里的 `host` 字段，取不到就把设备整条丢掉 ——
     * 而"按文档实现"的接收端未必会带 host（我的协议说明里当初就没写这一条），
     * 结果就是"能收到回包但列表里没有设备"。回包的**源地址**本来就是最可靠的设备地址，
     * 报文里的 host 只在"接收端想让电脑连另一块网卡"时才需要（多网卡场景）优先采用。
     */
    sock.on('message', (buf, rinfo) => {
      try {
        const msg = JSON.parse(buf.toString('utf-8')) as Record<string, unknown>
        if (msg.sakana !== 'receiver') return
        const host = String(msg.host || '').trim() || rinfo.address
        const port = Number(msg.port) || 52889
        const name = String(msg.name ?? 'Sakana 接收端')
        if (!host) return
        upsert({
          id: `sakana:${host}:${port}`,
          name,
          kind: 'sakana',
          host,
          port,
          caps: Array.isArray(msg.caps) ? (msg.caps as string[]) : [],
          lastSeen: Date.now()
        })
      } catch {
        /* 不是我们的报文，忽略 */
      }
    })
    sock.on('error', (err) => {
      log.append('warn', 'cast', `UDP 发现套接字异常: ${err.message}`)
    })
    sock.bind(SAKANA_PORT, () => {
      try {
        sock.setBroadcast(true)
      } catch {
        /* 某些系统不允许，广播发送时会失败，下面有兜底 */
      }
    })
    sakanaSock = sock
    return sock
  } catch (err) {
    log.append('warn', 'cast', `UDP 发现套接字创建失败: ${String(err)}`)
    return null
  }
}

let sakanaProbeTimer: NodeJS.Timeout | null = null

function probeSakana(): void {
  const sock = ensureSakanaSocket()
  if (!sock) return
  const payload = Buffer.from(JSON.stringify({ sakana: 'discover', v: 1, host: lanIPv4() }), 'utf-8')
  for (const target of broadcastTargets()) {
    try {
      sock.send(payload, SAKANA_PORT, target)
    } catch {
      /* 广播被系统拒绝时忽略：接收端每 5 秒自己广播一次，我们仍能收到 */
    }
  }
}

// ---------------- 发现：DLNA（SSDP） ----------------

interface SsdpHit {
  location: string
  usn: string
  st: string
}

function probeSsdp(): void {
  if (!ssdpSock) {
    try {
      ssdpSock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      ssdpSock.on('message', (buf, rinfo) => {
        const text = buf.toString('utf-8')
        if (!/^HTTP\/1\.1 200/i.test(text)) return
        const pick = (key: string): string => {
          const m = new RegExp(`^${key}:\\s*(.+)$`, 'im').exec(text)
          return m ? m[1].trim() : ''
        }
        const location = pick('LOCATION')
        if (!location) return
        const usn = pick('USN')
        const st = pick('ST')
        // 只要 MediaRenderer（电视/盒子）与 MediaServer 结果里的渲染器
        if (st && !/MediaRenderer|AVTransport/i.test(st) && !/MediaRenderer/i.test(usn)) return
        void resolveDlna(location, usn || location, rinfo.address)
      })
      ssdpSock.on('error', (err) => log.append('warn', 'cast', `SSDP 套接字异常: ${err.message}`))
      ssdpSock.bind(() => {
        try {
          ssdpSock?.setBroadcast(true)
        } catch {
          /* ignore */
        }
      })
    } catch (err) {
      log.append('warn', 'cast', `SSDP 套接字创建失败: ${String(err)}`)
      return
    }
  }
  const msg = Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      'MX: 2',
      'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
      '',
      ''
    ].join('\r\n'),
    'utf-8'
  )
  try {
    ssdpSock.send(msg, SSDP_PORT, SSDP_ADDR)
  } catch {
    /* ignore */
  }
}

/**
 * 在设备描述 XML 里找某个 serviceType 对应的 controlURL。
 * 相对地址要按 LOCATION 解析（不少电视给的是 `/upnp/control/AVTransport1` 这种相对路径）。
 */
function controlUrlOf(xml: string, base: URL, service: string): string {
  const re = new RegExp(
    `<service>[\\s\\S]*?<serviceType>[^<]*${service}[^<]*</serviceType>[\\s\\S]*?<controlURL>([^<]*)</controlURL>[\\s\\S]*?</service>`,
    'i'
  )
  const rel = re.exec(xml)?.[1]?.trim()
  if (!rel) return ''
  try {
    return new URL(rel, base).toString()
  } catch {
    return ''
  }
}

/** 取设备描述 XML，抽出名字与 AVTransport 控制地址 */
async function resolveDlna(location: string, usn: string, host: string): Promise<void> {
  try {
    const r = await axios.get<string>(location, {
      timeout: 4000,
      responseType: 'text',
      maxRedirects: 3,
      headers: { 'User-Agent': 'Sakana/0.0.1 UPnP/1.0' }
    })
    const xml = String(r.data ?? '')
    const name = /<friendlyName>([^<]*)<\/friendlyName>/i.exec(xml)?.[1]?.trim()
    const udn = /<UDN>([^<]*)<\/UDN>/i.exec(xml)?.[1]?.trim()
    const base = new URL(location)
    const avt = controlUrlOf(xml, base, 'AVTransport')
    if (!avt) return
    const id = `dlna:${udn || usn || host}`
    // 记住 ConnectionManager 的控制地址：投屏前要问它"你认哪些格式"（见 dlnaProtocolInfo）
    const connection = controlUrlOf(xml, base, 'ConnectionManager')
    if (connection) controlUrls.set(id, { connection })
    upsert({
      id,
      name: name || `电视（${host}）`,
      kind: 'dlna',
      host: base.hostname || host,
      port: Number(base.port) || 80,
      controlUrl: avt,
      volumeUrl: controlUrlOf(xml, base, 'RenderingControl') || undefined,
      caps: ['hls', 'mp4', 'seek', 'volume'],
      lastSeen: Date.now()
    })
  } catch {
    /* 描述取不到就跳过这台设备（很常见：部分电视不允许直接 GET） */
  }
}

/**
 * DLNA 设备的协议能力（`ConnectionManager.GetProtocolInfo` 的 Sink 列表）。
 *
 * 为什么要问它：**投屏能不能播出来，几乎全看电视认不认我们给的封装**。
 * 实测很多国产电视的 DLNA 只认 mp4/ts，**不认 HLS（m3u8）** —— 这时把 m3u8 地址交给它，
 * 它照样接受 `SetAVTransportURI`（返回成功）、然后什么都不播，用户看到的就是"连上了但播不出来"。
 * 拿到这张能力表之后，我们就能先选对封装（HLS 直通 / FFmpeg 原地重封成 MP4）再投。
 */
const protocolCache = new Map<string, string[]>()

async function dlnaProtocolInfo(device: CastDevice): Promise<string[]> {
  const cached = protocolCache.get(device.id)
  if (cached) return cached
  const cmUrl = controlUrls.get(device.id)?.connection
  if (!cmUrl) return []
  try {
    const r = await axios.post(
      cmUrl,
      soapEnvelope('ConnectionManager', 'GetProtocolInfo', ''),
      {
        timeout: 5000,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: '"urn:schemas-upnp-org:service:ConnectionManager:1#GetProtocolInfo"'
        },
        validateStatus: () => true
      }
    )
    const xml = String(r.data ?? '')
    const sink = /<Sink>([\s\S]*?)<\/Sink>/i.exec(xml)?.[1] ?? ''
    const list = sink
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    protocolCache.set(device.id, list)
    log.append('info', 'cast', `${device.name} 支持的投屏格式：${list.slice(0, 12).join(' | ').slice(0, 200)}`)
    return list
  } catch {
    protocolCache.set(device.id, [])
    return []
  }
}

/** 设备各类服务的控制地址（协议信息不在 CastDevice 里，避免把内部字段泄进共享类型） */
const controlUrls = new Map<string, { connection?: string }>()

/**
 * 电视认不认 HLS。
 *
 * ⚠️ 只看**明确写着 HLS** 的那几个 mime（v0.3.9 修）。早先的实现是
 * `/mpegurl|video\/mp2t|\.m3u8/`，问题出在 `video/mp2t` 上：
 *   · `video/mp2t` 是 **TS 分片**的 mime，不是"支持 HLS"的声明；
 *   · 而且它是个**前缀匹配** —— 实测这台电视（Hisense，「客厅电视 DLNA投屏」）的能力表里
 *     写的是 `video/mp2ts`（见 `.e2e/cast-tv-probe.mjs` 的完整 82 条 Sink 列表），
 *     `/video\/mp2t/` 命中 `video/mp2ts`，于是被判定成"支持 HLS = true"。
 *     可它 82 条里**一条 mpegurl 都没有**（既没有 application/vnd.apple.mpegurl，
 *     也没有 application/x-mpegURL）—— 于是「只用中转（HLS 直通）」这条策略会把 m3u8
 *     交给一台根本不认 HLS 的电视：SOAP 照样返回成功，电视转两圈然后说无法播放。
 * 结论：HLS 必须由电视**明说**，猜不得。
 */
function sinkSupportsHls(list: string[]): boolean {
  return list.some((p) => /mpegurl|\.m3u8/i.test(p))
}

/** 电视的能力表里有没有这个 mime（用于校验我们交给它的 res/protocolInfo 是否自报支持） */
export function sinkHasMime(list: string[], mime: string): boolean {
  const want = mime.toLowerCase()
  return list.some((p) => p.toLowerCase().includes(`:${want}:`))
}

// ---------------- 生命周期 ----------------

export function castDevices(): CastDevice[] {
  return devicesArray()
}

/**
 * 诊断用：读一台 DLNA 设备支持的投屏格式（**只读查询，不会让电视开始播放**）。
 *
 * 为什么单独暴露：用户报「能连上电视但播不出来」时，第一件要确认的事就是
 * "这台电视到底认不认 HLS" —— 不认的话就必须重封装成 MP4，靠猜是猜不出来的。
 */
export async function castDeviceFormats(deviceId: string): Promise<string[]> {
  const d = devices.get(deviceId)
  if (!d || d.kind !== 'dlna') return []
  return await dlnaProtocolInfo(d)
}

export function startCastDiscovery(win: BrowserWindow): CastDevice[] {
  pushWin = win
  probeSakana()
  probeSsdp()
  // 3 秒后再来一轮：UDP 丢包在局域网里并不罕见（尤其是电视刚开机时）
  setTimeout(() => {
    probeSakana()
    probeSsdp()
  }, 3000)
  if (sakanaProbeTimer) clearInterval(sakanaProbeTimer)
  sakanaProbeTimer = setInterval(() => {
    probeSakana()
    probeSsdp()
  }, 10_000)
  if (!sweeper) {
    sweeper = setInterval(() => {
      const before = devices.size
      const alive = devicesArray().length
      if (alive !== before) pushDevices()
    }, 15_000)
  }
  return devicesArray()
}

export function stopCastDiscovery(): void {
  if (sakanaProbeTimer) {
    clearInterval(sakanaProbeTimer)
    sakanaProbeTimer = null
  }
  for (const s of [sakanaSock, ssdpSock]) {
    try {
      s?.close()
    } catch {
      /* ignore */
    }
  }
  sakanaSock = null
  ssdpSock = null
  pushWin = null
}

/** 手动登记一台设备（有线 / 其它网段）：`192.168.1.20` 或 `192.168.1.20:52889` */
export async function addCastDevice(addr: string): Promise<CastDevice | null> {
  const m = /^([\d.]+)(?::(\d+))?$/.exec(addr.trim())
  if (!m) return null
  const host = m[1]
  const port = Number(m[2]) || 52889
  const info = await sakanaInfo(host, port).catch(() => null)
  if (info) {
    const device: CastDevice = {
      id: `sakana:${host}:${port}`,
      name: info.name || `Sakana 接收端（${host}）`,
      kind: 'sakana',
      host,
      port,
      caps: ['hls', 'mp4', 'seek', 'volume', 'playlist', 'headers'],
      lastSeen: Date.now()
    }
    upsert(device)
    return device
  }
  return null
}

// ---------------- 控制：Sakana 接收端 ----------------

function sakanaBase(host: string, port: number): string {
  return `http://${host}:${port}`
}

async function sakanaInfo(host: string, port: number): Promise<CastReceiverInfo | null> {
  try {
    const r = await axios.get<CastReceiverInfo>(`${sakanaBase(host, port)}/info`, { timeout: 2500 })
    return r.data ?? null
  } catch {
    return null
  }
}

async function sakanaPost(host: string, port: number, path: string, body: unknown): Promise<boolean> {
  try {
    const r = await axios.post(`${sakanaBase(host, port)}${path}`, body, {
      timeout: 6000,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true
    })
    /*
     * 既要看状态码，也要看响应体里的 ok（v0.3.8 修）。
     *
     * 起因：早先只看 `2xx` 就当成功，而"按文档实现"的接收端失败时会回
     * `200 {"ok":false,"error":"..."}` —— 电脑这边会当成"已投屏成功"，用户却什么都没看到。
     * 现在两边都认：非 2xx 失败；2xx 但显式 `ok:false` 也算失败（并把原因带回去）。
     */
    if (r.status < 200 || r.status >= 300) return false
    const data = r.data as { ok?: unknown } | undefined
    if (data && typeof data === 'object' && data.ok === false) return false
    return true
  } catch {
    return false
  }
}

// ---------------- 控制：DLNA SOAP ----------------

function soapEnvelope(service: string, action: string, inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${inner}</u:${action}></s:Body></s:Envelope>`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 一次 SOAP 调用的结果。
 *
 * 为什么要带上 `fault`：DLNA 电视拒绝投屏时会在 SOAP Fault 里给出**标准错误码**
 * （704=格式不支持、714=不接受的 MIME、716=找不到资源……），那正是"为什么播不出来"的答案。
 * 早先这里只留了个 `status`，fault 正文被丢掉 —— 于是所有失败在界面上都长成同一句
 * "电视拒绝了这次投屏（可能不支持该格式）"，等于没诊断。
 */
export interface SoapResult {
  ok: boolean
  status: number
  /** UPnPError/errorCode（拿不到就是 0） */
  errorCode: number
  /** UPnPError/errorDescription */
  errorText: string
  /** 原始响应正文（截断保存，排查时能贴出来） */
  body: string
  ms: number
}

/** UPnP AVTransport 标准错误码 → 人话（只列投屏真会遇到的几个） */
const UPNP_ERRORS: Record<number, string> = {
  401: '动作不被支持（Invalid Action）',
  402: '参数不合法（Invalid Args）',
  501: '动作执行失败（Action Failed）',
  701: '当前状态不允许这个动作（Transition not available）',
  702: '没有内容（No contents）',
  703: '读取失败（Read error）',
  704: '播放格式不被支持（Format not supported for playback）',
  705: '传输被锁（Transport is locked）',
  710: '不支持这种定位方式（Seek mode not supported）',
  711: '定位目标非法（Illegal seek target）',
  714: '不接受这个 MIME 类型（Illegal MIME-type）',
  715: '内容忙（Content BUSY）',
  716: '找不到资源（Resource not found）',
  718: 'InstanceID 非法'
}

function upnpErrorText(code: number, raw: string): string {
  if (!code) return ''
  const known = UPNP_ERRORS[code] ?? '未知错误'
  return raw ? `${code} ${known}（电视原话：${raw.slice(0, 80)}）` : `${code} ${known}`
}

async function dlnaSoap(url: string, service: string, action: string, inner: string): Promise<SoapResult> {
  const t0 = Date.now()
  try {
    const r = await axios.post(url, soapEnvelope(service, action, inner), {
      timeout: 8000,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"urn:schemas-upnp-org:service:${service}:1#${action}"`
      },
      validateStatus: () => true
    })
    const body = typeof r.data === 'string' ? r.data : String(r.data ?? '')
    const errorCode = Number(/<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(body)?.[1] ?? 0) || 0
    const errorText = /<errorDescription>\s*([^<]*?)\s*<\/errorDescription>/i.exec(body)?.[1]?.trim() ?? ''
    const ok = r.status >= 200 && r.status < 300 && errorCode === 0
    if (!ok) {
      log.append(
        'warn',
        'cast',
        `DLNA ${action} 被拒: HTTP ${r.status}${errorCode ? `，UPnP 错误 ${upnpErrorText(errorCode, errorText)}` : ''}｜${body.replace(/\s+/g, ' ').slice(0, 200)}`
      )
    }
    return { ok, status: r.status, errorCode, errorText, body: body.slice(0, 1200), ms: Date.now() - t0 }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 160)
    log.append('warn', 'cast', `DLNA ${action} 失败: ${msg}`)
    return { ok: false, status: 0, errorCode: 0, errorText: msg, body: '', ms: Date.now() - t0 }
  }
}

// ---------------- 投屏播放入口 ----------------

export interface CastPlayResult {
  ok: boolean
  message: string
  /** 实际交给设备的地址（排查用；界面不显示完整地址） */
  usedRelay: boolean
  url?: string
}

/**
 * 把一路媒体投到设备上。
 *
 * 策略（用户点名要"投屏流畅"）：
 *   1. **Sakana 接收端** → 把直链与 Referer/Cookie 直接给它（它自己带会话取流，电脑零参与 = 最流畅）；
 *   2. **DLNA** → 不需要鉴权就直连（电视自己取流）；需要鉴权就走本机局域网中转（**不重编码**）。
 * 设置里的 `castStrategy` 可以强制「只用直连 / 只用中转 / 强制转码」。
 */
export async function castPlay(deviceId: string, media: CastMediaInput): Promise<CastPlayResult> {
  const device = devices.get(deviceId)
  if (!device) return { ok: false, message: '设备不在列表里（可能刚关机）', usedRelay: false }
  const strategy = (getSettings() as { castStrategy?: string }).castStrategy ?? 'auto'
  /*
   * ⚠️ 这里**不再**清理全部旧会话（v0.3.9 修）。
   *
   * 早先是 `stopCastRelay()`（清空 sessions），理由是"别留垃圾会话"。但代价是：
   * 只要用户再投一次（换集、失败后重投、或者同时投给两台设备），**电视正在播的那一路会话
   * 也会被删掉** —— 而电视对 HLS 的每个分片都是独立请求，会话一没就全是 404，
   * 表现正是"刚才还好好的，突然说无法播放"。会话只是一个 Map 条目，留着毫无代价，
   * 过期的由 `SESSION_TTL_MS`（6 小时）在下次登记时清掉。
   * 只有用户显式「停止投屏」才应该删（走 castStopRemote → stopCastRelay）。
   */
  const needsHeaders = Boolean(media.referer || media.cookies)
  if (device.kind === 'sakana') {
    /*
     * 把**电脑的同步地址**一并交给手机（v0.3.8）：手机据此拉收藏/历史、推自己的历史。
     * 服务要先确保起来（它是常驻的，不依赖本次投屏）。
     */
    const { ensureCastServer } = await import('./castRelay')
    await ensureCastServer().catch(() => 0)
    const { castSyncUrl } = await import('./castSync')
    const payload = {
      url: media.url,
      title: media.title,
      headers: {
        ...(media.referer ? { Referer: media.referer } : {}),
        ...(media.cookies ? { Cookie: media.cookies } : {}),
        ...(media.userAgent ? { UserAgent: media.userAgent } : {})
      },
      startMs: media.startMs ?? 0,
      index: media.index ?? 0,
      playlist: media.playlist ?? [],
      /*
       * V1.1：把"这是哪一部、还有哪些数据源、现在用的是哪条"一并交给接收端。
       *
       * 接收端只知道一个直链时，它上面的"选集/连播/换数据源"全是假的（点了也没人执行）——
       * 有了这三个字段，它就能把用户的动作变成 `/sync/command` 里的 `play-subject`+`sourceId`
       * 发回来，由电脑重新解析后投回去（电脑有规则引擎和站点会话，手机没有）。
       * 三项都可选：老版本接收端直接忽略，新接收端拿不到就退化成旧行为。
       */
      ...(Number.isFinite(media.subjectId) ? { subjectId: Number(media.subjectId) } : {}),
      ...(media.sources && media.sources.length > 0 ? { sources: media.sources } : {}),
      ...(media.sourceId ? { sourceId: media.sourceId } : {}),
      /** 电脑端同步服务地址（空字符串=没起来，手机应把同步按钮置灰） */
      syncUrl: castSyncUrl()
    }
    const ok = await sakanaPost(device.host, device.port, '/play', payload)
    if (!ok) return { ok: false, message: '接收端没有接受这次投屏（应用可能已经退出）', usedRelay: false }
    log.append('info', 'cast', `已投屏到 ${device.name}（直连+会话，电脑不参与传输）`)
    return { ok: true, message: `已投屏到 ${device.name}`, usedRelay: false, url: media.url }
  }

  // DLNA
  if (!device.controlUrl) return { ok: false, message: '这台设备没有可用的 AVTransport 控制地址', usedRelay: false }
  /*
   * ★ 先问电视"你认哪些格式"，再决定给什么（v0.3.8 修「连上了却播不出来」）★
   *
   * 用户实测：设置成「自动」时能连上电视但没画面。原因就在这里 —— 番剧站的片源几乎都是 HLS（m3u8），
   * 而**很多电视的 DLNA 根本不支持 HLS**：它照样接受 `SetAVTransportURI`（返回成功），
   * 然后什么都不播。所以要按电视自报的能力选封装：
   *   · 电视说认 HLS → 走 HLS 直通（最流畅、还能拖进度）；
   *   · 电视没说自己认 HLS（或压根没给能力表）→ 用 FFmpeg **原地重封装成 MP4**（`-c:v copy`，不重编码）。
   */
  const sink = await dlnaProtocolInfo(device)
  const sourceIsHls = /\.m3u8(\?|$)/i.test(media.url)
  const tvTakesHls = sinkSupportsHls(sink)
  let target = media.url
  let usedRelay = false
  let relayId = ''
  /** 这一路最终用的是哪种封装（诊断与日志用） */
  let chosenMode: 'direct' | 'hls' | 'mp4' | 'transcode' = 'direct'
  let mime = sourceIsHls ? 'application/vnd.apple.mpegurl' : 'video/mp4'
  /*
   * 什么时候必须经本机中转：
   *   · 片源要鉴权（电视带不了 Referer/Cookie）；
   *   · 片源是 HLS 而电视不认 HLS（要重封成 MP4）；
   *   · 用户显式选了「只用中转 / 转头并转码」。
   * 直连只在"不需要鉴权、且电视认得这个封装"时才用 —— 那种情况最流畅（电脑完全不参与）。
   */
  const mustRemux = sourceIsHls && !tvTakesHls
  /*
   * ⚠️ `mustRemux` 必须**压过** `strategy === 'direct'`（V1.1 真机实测后改）。
   *
   * 原因：这台电视的能力表里**一条 mpegurl 都没有**，但我们把中转出来的 `.m3u8` 直接交给它时，
   * 它回了 SetAVTransportURI 200、报了 PLAYING，然后**一个包都没来取**，最后显示"无法播放"。
   * 也就是说"直连 HLS"在这种电视上是**必然失败**的一条路 —— 用户选了「只用直连」时照做，
   * 只会得到一个看起来成功、实际永远不出画的投屏。
   * 所以：电视不认 HLS 而片源是 HLS 时，无论用户选了什么策略，都走"重封装为可定位 MP4"，
   * 并把这次策略覆盖写进日志（不静默改变用户设置）。
   */
  const forcedRemux = mustRemux && strategy === 'direct'
  if (forcedRemux) {
    log.append(
      'warn',
      'cast',
      `电视（${device.name}）的能力表里没有 HLS（mpegurl）条目，直连 m3u8 必然不出画 → 本次改用重封装为可定位 MP4`
    )
  }
  const needRelay = mustRemux || (strategy !== 'direct' && (needsHeaders || strategy === 'relay' || strategy === 'transcode'))
  if (needRelay) {
    /*
     * 选封装（用户报「连上了却播不出来」之后定的默认）：
     *   · `transcode` → 真转 H.264/AAC（电视不认 HEVC 时唯一能播的路）；
     *   · `relay`     → 电视自报支持 HLS 才走 HLS 直通（省带宽、能拖进度），否则重封装；
     *   · `auto`      → **一律重封装成渐进式 MP4**：兼容性最高（`-c:v copy` 不重编码，
     *                  画质无损），代价是这一路只能顺序播、电脑要转发一遍带宽。
     * 换句话说：默认不再是"HLS 直通"，因为实测电视自报能力表里有 HLS、实际却放不出来 ——
     * 「它说自己支持」不等于「它真能放」，所以默认选最保守的那条。
     */
    const mode: 'hls' | 'mp4' | 'transcode' =
      strategy === 'transcode'
        ? 'transcode'
        : strategy === 'relay' && sourceIsHls && tvTakesHls
          ? 'hls'
          : 'mp4'
    const relay = await startCastRelay(media.url, {
      referer: media.referer,
      cookies: media.cookies,
      userAgent: media.userAgent,
      mode
    })
    if (!relay) return { ok: false, message: '投屏中转服务启动失败（端口被占用？）', usedRelay: false }
    target = relay.url
    usedRelay = true
    relayId = relay.id
    chosenMode = mode
    mime = mode === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4'
  }
  /*
   * DIDL 元数据里必须带 `<res protocolInfo>`：一部分电视只看 CurrentURI 就能播，
   * 但更严格的那批（尤其国产电视）会因为没有 res/protocolInfo 而"接受了却不播"。
   *
   * `DLNA.ORG_OP`：第一位=按字节定位，第二位=按时间定位。
   *   · HLS 直通：列表与分片都支持 Range → `01`；
   *   · 重封装/转码的那一路是**单向流**（没有 Content-Length、不接受 Range）→ `00`。
   *   报 `01` 会让电视发 Range 请求然后落空（它多半就此判定"无法播放"）。
   * `DLNA.ORG_CI`：0=未转换，1=已转换。重封装/转码确实转换了 → `1`。
   *   这里跟中转服务在 HTTP 头里报的值必须**一致**，否则较真的实现会判成前后矛盾。
   */
  const converted = chosenMode === 'mp4' || chosenMode === 'transcode'
  const seekable = chosenMode === 'hls' || chosenMode === 'direct'
  const dlnaFlags = `DLNA.ORG_OP=${seekable ? '01' : '00'};DLNA.ORG_CI=${converted ? 1 : 0};DLNA.ORG_FLAGS=01700000000000000000000000000000`
  const meta =
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">` +
    `<item id="0" parentID="-1" restricted="1">` +
    `<dc:title>${escapeXml(media.title || 'Sakana')}</dc:title>` +
    `<upnp:class>object.item.videoItem</upnp:class>` +
    `<res protocolInfo="http-get:*:${mime}:${dlnaFlags}">${escapeXml(target)}</res>` +
    `</item></DIDL-Lite>`
  const setUri = await dlnaSoap(
    device.controlUrl,
    'AVTransport',
    'SetAVTransportURI',
    `<InstanceID>0</InstanceID><CurrentURI>${escapeXml(target)}</CurrentURI><CurrentURIMetaData>${escapeXml(meta)}</CurrentURIMetaData>`
  )
  if (!setUri.ok) {
    /*
     * 这一步失败是"电视**直接拒绝**" —— 与"接受了但播不出来"是两码事，所以要分开报，
     * 并把它给的标准错误码翻成人话（704=格式不支持、714=MIME 不接受、716=资源找不到……）。
     */
    const why = setUri.errorCode
      ? upnpErrorText(setUri.errorCode, setUri.errorText)
      : setUri.status === 0
        ? `连不上电视的控制地址（${setUri.errorText}）`
        : `HTTP ${setUri.status}`
    log.append('warn', 'cast', `SetAVTransportURI 被电视拒绝：${why}；交给它的地址=${target}；protocolInfo=http-get:*:${mime}:${dlnaFlags}`)
    stopCastRelay()
    return { ok: false, message: `电视拒绝了这次投屏：${why}（投给它的格式是 ${mime}）`, usedRelay }
  }
  const play = await dlnaSoap(device.controlUrl, 'AVTransport', 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>')
  if (!play.ok) {
    // 地址收下了、但电视不肯进入播放：同样是"拒绝"，必须让用户看到原因（701=当前状态不允许）
    const why = play.errorCode ? upnpErrorText(play.errorCode, play.errorText) : `HTTP ${play.status}`
    log.append('warn', 'cast', `Play 被电视拒绝：${why}`)
  }
  if (media.startMs && media.startMs > 0) {
    const sec = Math.floor(media.startMs / 1000)
    const h = String(Math.floor(sec / 3600)).padStart(2, '0')
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
    const ss = String(sec % 60).padStart(2, '0')
    await dlnaSoap(device.controlUrl, 'AVTransport', 'Seek', `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${h}:${mm}:${ss}</Target>`)
  }
  log.append(
    'info',
    'cast',
    `已投屏到 ${device.name}（${usedRelay ? (mime.includes('mpegurl') ? '本机中转·HLS 直通' : '本机中转·重封装为 MP4') : '直连'}；电视能力 ${sink.length} 项，自报支持 HLS=${tvTakesHls}，protocolInfo=http-get:*:${mime}:${dlnaFlags}）`
  )
  /*
   * ★ 投完立刻回读电视自己的状态 ★
   *
   * 「连上了但播不出来」有四种完全不同的原因，靠猜是猜不出来的：
   *   · 电视**根本没来取流** → 地址它拿不到（网段不通 / 防火墙拦了本机端口）；
   *   · 电视**取了流但我们的中转回的是错误码** → 源站取流失败（403/过期地址）；
   *   · 电视**取了流也拿到了数据** → 封装/编码它不认；
   *   · 电视**根本没接受这个地址** → SetAVTransportURI 那一步就已经拒绝了（上面已返回）。
   * 前三种靠"中转请求流水（谁、什么路由、什么状态码、多少字节、第几秒）" + "电视自报的
   * TransportState/RelTime"一对齐就能定位，所以这里边等边采样，把结论直接写进提示里。
   */
  const diag = usedRelay
    ? await diagnoseDlna(device, relayId, false)
    : { state: '', note: '', category: 'ok' as CastFailure, relTime: '', remoteHits: -1 }
  const modeLabel =
    chosenMode === 'hls'
      ? 'HLS 直通'
      : chosenMode === 'transcode'
        ? '转码为 H.264'
        : chosenMode === 'mp4'
          ? '重封装为 MP4'
          : '直连'
  log.append('info', 'cast', `投屏方式=${modeLabel}；电视自报状态=${diag.state || '未知'}；RelTime=${diag.relTime || '-'}`)
  return {
    ok: true,
    message: `已投屏到 ${device.name}（${modeLabel}）${diag.note}`,
    usedRelay,
    url: target
  }
}

/**
 * 投屏失败的分类（界面据此给出**可操作**的提示，而不是一句"无法播放"）。
 *   · `relay`     —— 中转服务没起来（端口/权限），压根没到电视那一步；
 *   · `rejected`  —— 电视在 SOAP 那一步就拒绝了（带 UPnP 错误码）；
 *   · `nofetch`   —— 电视收下了地址但**一个包都没来取**：地址不可达（网段/防火墙）；
 *   · `upstream`  —— 电视来取了，但我们的中转从源站拿不到数据（回 4xx/5xx）；
 *   · `format`    —— 电视取到了 200 的正常数据，却播不出来：封装/编码不认；
 *   · `timeout`   —— 电视状态一直不动（既没到位也没报错）；
 *   · `ok`        —— 正常。
 */
export type CastFailure = 'ok' | 'relay' | 'rejected' | 'nofetch' | 'upstream' | 'format' | 'timeout'

/** 电视端的播放状态快照（GetTransportInfo + GetPositionInfo） */
export interface CastTransportSnapshot {
  state: string
  status: string
  speed: string
  /** 已播时间（推进 = 电视真的在出画的**最强机器证据**；画面本身只能靠人眼） */
  relTime: string
  duration: string
  trackUri: string
  error: string
}

/**
 * 读一次电视的播放状态（只读，不影响播放）。
 *
 * 为什么单独导出：投屏后的诊断、以及 `SAKANA_CAST_TEST` 的真机自检都需要**连续采样**，
 * 而"RelTime 在推进"是唯一能自动拿到的"电视真的在播"的证据。
 */
export async function castTransportSnapshot(deviceId: string): Promise<CastTransportSnapshot | null> {
  const device = devices.get(deviceId)
  if (!device || device.kind !== 'dlna' || !device.controlUrl) return null
  const info = await dlnaSoap(device.controlUrl, 'AVTransport', 'GetTransportInfo', '<InstanceID>0</InstanceID>')
  const pick = (re: RegExp, s: string): string => re.exec(s)?.[1]?.trim() ?? ''
  const pos = await dlnaSoap(device.controlUrl, 'AVTransport', 'GetPositionInfo', '<InstanceID>0</InstanceID>')
  return {
    state: pick(/<CurrentTransportState>([^<]*)</i, info.body),
    status: pick(/<CurrentTransportStatus>([^<]*)</i, info.body),
    speed: pick(/<CurrentSpeed>([^<]*)</i, info.body),
    relTime: pick(/<RelTime>([^<]*)</i, pos.body),
    duration: pick(/<TrackDuration>([^<]*)</i, pos.body),
    trackUri: pick(/<TrackURI>([^<]*)</i, pos.body),
    error: info.ok ? '' : info.errorCode ? upnpErrorText(info.errorCode, info.errorText) : `HTTP ${info.status}`
  }
}

/**
 * 投屏后回读电视状态，给出"为什么没播"的结论。
 *
 * 采样而不是"睡 4 秒看一眼"：电视从收到地址到真正出画要几秒（要先拉列表、拉首片、解码），
 * 只看一个时间点的状态很容易把"正常启动中"误判成"失败"。这里按 2s/5s/9s/14s 采四次，
 * 只要中途看过 PLAYING 或 RelTime 推进，就判成功。
 *
 * `verbose` 为真时把每次采样都写进日志（真机自检用）。
 */
async function diagnoseDlna(
  device: CastDevice,
  relayId: string,
  verbose: boolean
): Promise<{ state: string; note: string; category: CastFailure; relTime: string; remoteHits: number }> {
  const elapsed: number[] = [2000, 3000, 4000, 5000]
  let state = ''
  let relTime = ''
  let last: CastTransportSnapshot | null = null
  const seenStates: string[] = []
  let waited = 0
  for (const step of elapsed) {
    await new Promise((r) => setTimeout(r, step))
    waited += step
    const snap = await castTransportSnapshot(device.id)
    if (!snap) continue
    last = snap
    state = snap.state || state
    relTime = snap.relTime || relTime
    seenStates.push(`${(waited / 1000).toFixed(1)}s:${snap.state || '?'}/${snap.relTime || '-'}`)
    if (verbose) log.append('info', 'cast', `[cast-diag] +${(waited / 1000).toFixed(1)}s 电视状态=${snap.state || '?'} RelTime=${snap.relTime || '-'} TrackURI=${snap.trackUri || '-'}`)
    if (snap.state === 'PLAYING' && snap.relTime && snap.relTime !== '00:00:00') break
  }
  /*
   * 关键区分：**非本机**命中才算"电视来取流了"。
   * 老代码数的是全部命中，而投屏自检/播放器预探测也会命中一次，于是就出现了
   * "日志说电视来取流了、其实电视没来"这种把排查带偏的假证据。
   */
  const remoteHits = relayId ? castRelayRemoteHits(relayId) : -1
  const totalHits = relayId ? castRelayHits(relayId) : -1
  const log_ = relayId ? castRelayHitLog(relayId) : []
  const remote = log_.filter((h) => !h.local)
  const firstRemote = remote[0]
  const remoteBad = remote.filter((h) => h.status === 0 || h.status >= 400)
  log.append(
    'info',
    'cast',
    `投屏回读：电视状态=${seenStates.join(' → ') || '未知'}；中转命中 电视=${remoteHits}/本机自检=${totalHits - remoteHits}；首个电视请求=${firstRemote ? `${firstRemote.route} HTTP ${firstRemote.status} ${firstRemote.bytes}字节 @+${(firstRemote.sinceMs / 1000).toFixed(1)}s` : '无'}`
  )
  const advanced = Boolean(relTime && relTime !== '00:00:00')
  if (state === 'PLAYING' || advanced) {
    return { state, note: '', category: 'ok', relTime, remoteHits }
  }
  if (remoteHits === 0) {
    /*
     * 注意：这里**不要**直接甩锅给防火墙。实测本机的入站规则是放行我们自己的
     * `node_modules\electron\dist\electron.exe` 的（`netsh advfirewall firewall show rule name=Electron dir=in verbose`），
     * 所以更要先怀疑"地址/网段"（多网卡机器上选错网卡、电视在另一个网段/访客网络）。
     */
    return {
      state,
      note: `。电视收下了地址，但 ${(waited / 1000).toFixed(0)} 秒内**没有来本机取过流**：说明它拿不到我们给的地址（网段不通 / 防火墙拦了本机端口 / 电脑有多块网卡而地址选错了）。可先确认电视和电脑在同一网段，再检查 Windows 防火墙是否允许本程序通过入站`,
      category: 'nofetch',
      relTime,
      remoteHits
    }
  }
  if (remoteBad.length > 0 && remoteBad.length === remote.length) {
    return {
      state,
      note: `。电视来取流了，但我们的中转从源站拿不到数据（${remoteBad[0].route} 回 HTTP ${remoteBad[0].status || '连接中断'}）—— 多半是片源地址已过期或需要登录，重开一次这一集再投`,
      category: 'upstream',
      relTime,
      remoteHits
    }
  }
  return {
    state,
    note: `。电视取到了流（${remoteHits} 个请求，首个 ${firstRemote?.bytes ?? 0} 字节）却没能播放（它自报状态 ${state || '未知'}）—— 这台电视不认这个封装/编码，可在投屏设置里把策略改成「中转并转码」再试`,
    category: last ? 'format' : 'timeout',
    relTime,
    remoteHits
  }
}

export type CastAction = 'pause' | 'resume' | 'toggle' | 'stop' | 'seek' | 'volume' | 'mute'

export async function castControl(
  deviceId: string,
  action: CastAction,
  value?: number
): Promise<{ ok: boolean; message?: string }> {
  const device = devices.get(deviceId)
  if (!device) return { ok: false, message: '设备不在列表里' }
  if (device.kind === 'sakana') {
    const ok = await sakanaPost(device.host, device.port, '/control', { action, value })
    return ok ? { ok: true } : { ok: false, message: '接收端没有响应' }
  }
  if (!device.controlUrl) return { ok: false, message: '设备没有控制地址' }
  let ok = false
  if (action === 'pause') ok = (await dlnaSoap(device.controlUrl, 'AVTransport', 'Pause', '<InstanceID>0</InstanceID>')).ok
  else if (action === 'resume') ok = (await dlnaSoap(device.controlUrl, 'AVTransport', 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>')).ok
  else if (action === 'stop') ok = (await dlnaSoap(device.controlUrl, 'AVTransport', 'Stop', '<InstanceID>0</InstanceID>')).ok
  else if (action === 'toggle') {
    const info = await castInfo(deviceId)
    ok = info?.playing
      ? (await dlnaSoap(device.controlUrl, 'AVTransport', 'Pause', '<InstanceID>0</InstanceID>')).ok
      : (await dlnaSoap(device.controlUrl, 'AVTransport', 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>')).ok
  } else if (action === 'seek' && value != null) {
    const sec = Math.floor(value / 1000)
    const t = `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
    ok = (await dlnaSoap(device.controlUrl, 'AVTransport', 'Seek', `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${t}</Target>`)).ok
  } else if (action === 'volume' && device.volumeUrl && value != null) {
    ok = (
      await dlnaSoap(
        device.volumeUrl,
        'RenderingControl',
        'SetVolume',
        `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${Math.max(0, Math.min(100, Math.round(value)))}</DesiredVolume>`
      )
    ).ok
  } else if (action === 'mute' && device.volumeUrl && value != null) {
    ok = (
      await dlnaSoap(
        device.volumeUrl,
        'RenderingControl',
        'SetMute',
        `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>${value ? 1 : 0}</DesiredMute>`
      )
    ).ok
  }
  return ok ? { ok: true } : { ok: false, message: '设备没有接受这条指令' }
}

/** 读接收端当前状态（Sakana 接收端有完整 /info；DLNA 电视没有查询接口，返回 null） */
export async function castInfo(deviceId: string): Promise<CastReceiverInfo | null> {
  const device = devices.get(deviceId)
  if (!device) return null
  if (device.kind === 'sakana') return await sakanaInfo(device.host, device.port)
  return null
}

export async function castStopRemote(deviceId: string): Promise<void> {
  await castControl(deviceId, 'stop')
  stopCastRelay()
}

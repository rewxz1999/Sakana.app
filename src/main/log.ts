import { randomUUID } from 'node:crypto'
import type { LogEntry } from '@shared/types'
import { store } from './store'

/**
 * 运行日志保留最近 1000 条，超出丢弃最旧的。
 * - 该上限同时约束内存数组与持久化的 JSON（append 时先裁剪再 store.set），
 *   因此存档文件不会随运行时长无限膨胀。
 * - 1000 条足够覆盖一次完整播放/下载排障过程；更早的记录已无追溯价值，
 *   继续保留只会让 userData/data/logs.json 与日志页渲染变慢。
 */
const MAX_ENTRIES = 1000

/**
 * 日志脱敏（用户反复强调的红线：**界面与日志里不许出现内部地址 / 反代地址 / 弹幕接口 / 用户本机路径**）。
 *
 * 为什么把脱敏放在 `log.append` 这一层而不是各个调用点：日志是"用户反馈时最常被复制出去"的东西
 * （日志页有「复制全部」），而写日志的地方有近百处、还在不断增加。逐处记得脱敏迟早会漏，
 * 所以入口统一处理：**任何进入日志的文本都会先过这里**，调用方不需要（也不该）自己拼脱敏逻辑。
 *
 * 保留的诊断价值：
 *   · 地址 → 保留协议与"这是个域名/IP"的形状，打码主体与端口，路径只留前两段；
 *   · 本机路径 → 只留最后两段（知道是哪个文件，但看不到用户目录结构）；
 *   · 局域网/公网 IP → 打码后两段（能判断"是个局域网地址"，但拿不到具体主机）。
 */
export function maskLogText(input: string): string {
  let s = String(input ?? '')

  // ① http(s) 地址：`https://host[:port]/path` → `https://***/path(截断)`
  s = s.replace(/\b(https?):\/\/([^\s/]+)(\/[^\s]*)?/gi, (_m, scheme: string, host: string, path?: string) => {
    const keepPath = path ? maskUrlPath(path) : ''
    /*
     * 回环地址保留主机与端口：那是**应用自己的服务**（本机中转 / 实时流），
     * 界面上的诊断面板本来就会显示它，日志里保留端口对排障有用，也不涉及用户隐私。
     */
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.exec(host)
    if (loopback) return `${scheme}://127.0.0.1${loopback[2] ?? ''}${keepPath}`
    return `${scheme}://***${keepPath}`
  })

  // ② Windows 本机路径：`E:\a\b\c.txt` → `…\b\c.txt`（只留最后两段）
  s = s.replace(/\b[A-Za-z]:\\(?:[^\\\s"']+\\)*([^\\\s"']+)(\\)?([^\\\s"']+)?/g, (_m, last: string, sep?: string, last2?: string) => {
    return sep && last2 ? `…\\${last}\\${last2}` : `…\\${last}`
  })

  // ③ IP：打码后两段（局域网、公网都算；回环除外）
  s = s.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, a: string, b: string) => {
    if (a === '127') return m
    return `${a}.${b}.*.*`
  })

  return s
}

/** URL 路径只留前两段，避免把接口路径/密钥打出去（`/api/v1/xxx?token=...` → `/api/v1/…`） */
function maskUrlPath(path: string): string {
  const [clean] = path.split(/[?#]/)
  const segs = clean.split('/').filter(Boolean)
  if (segs.length <= 2) return `/${segs.join('/')}`
  return `/${segs.slice(0, 2).join('/')}/…`
}

/** 运行日志服务（方案 6：记录应用异常、网络失败、下载器错误，可复制） */
class LogService {
  private entries: LogEntry[] = []
  private targets = new Set<(e: LogEntry) => void>()
  /** 节流状态：key → 上次真正写入的时间与期间被压掉的条数 */
  private throttled = new Map<string, { at: number; suppressed: number }>()

  init(): void {
    this.entries = store.get<LogEntry[]>('logs', [])
  }

  append(level: LogEntry['level'], source: string, message: string): void {
    // 入口统一脱敏：写盘、控制台、推送给界面三处都是脱敏后的文本（见 maskLogText 的说明）
    const safe = maskLogText(message)
    const entry: LogEntry = { id: randomUUID(), level, source, message: safe, at: Date.now() }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    store.set('logs', this.entries)
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fn(`[${source}] ${safe}`)
    for (const cb of this.targets) {
      try {
        cb(entry)
      } catch {
        /* 忽略监听器异常 */
      }
    }
  }

  /**
   * 同一类高频日志的「浓缩」写入（V1.5.4）。
   *
   * 起因：一张封面在失败路径上会依次打「取图失败（第 1 次）」「缩放变体失败」「备用源失败」，
   * 一屏十几张图能刷出几十条，把真正有用的行挤掉；播放器控制栏每次显示/隐藏也会各打一条。
   *
   * 规则：同一 key 在窗口期内只写一条；被压掉的条数会累计，并在下一条里写明
   * 「另有 N 条同类记录已省略」——既不刷屏，也不假装什么都没发生。
   */
  appendThrottled(
    key: string,
    level: LogEntry['level'],
    source: string,
    message: string,
    windowMs = 60_000
  ): void {
    const now = Date.now()
    const prev = this.throttled.get(key)
    if (prev && now - prev.at < windowMs) {
      prev.suppressed += 1
      return
    }
    const tail = prev && prev.suppressed > 0 ? `（此前 ${prev.suppressed} 条同类记录已省略）` : ''
    this.throttled.set(key, { at: now, suppressed: 0 })
    this.append(level, source, `${message}${tail}`)
  }

  onPush(cb: (e: LogEntry) => void): () => void {
    this.targets.add(cb)
    return () => {
      this.targets.delete(cb)
    }
  }

  list(): LogEntry[] {
    // 老版本写进磁盘的条目没脱敏过，这里再过一遍（幂等），保证「复制全部日志」拿到的是干净的
    return this.entries.map((e) => (e.message === maskLogText(e.message) ? e : { ...e, message: maskLogText(e.message) }))
  }

  clear(): void {
    this.entries = []
    store.set('logs', [])
  }
}

export const log = new LogService()

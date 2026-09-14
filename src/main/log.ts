import { randomUUID } from 'node:crypto'
import type { LogEntry } from '@shared/types'
import { store } from './store'

const MAX_ENTRIES = 1000

/** 错误日志服务（方案 6：记录应用异常、网络失败、下载器错误，可复制） */
class LogService {
  private entries: LogEntry[] = []
  private targets = new Set<(e: LogEntry) => void>()

  init(): void {
    this.entries = store.get<LogEntry[]>('logs', [])
  }

  append(level: LogEntry['level'], source: string, message: string): void {
    const entry: LogEntry = { id: randomUUID(), level, source, message, at: Date.now() }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    store.set('logs', this.entries)
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fn(`[${source}] ${message}`)
    for (const cb of this.targets) {
      try {
        cb(entry)
      } catch {
        /* 忽略监听器异常 */
      }
    }
  }

  onPush(cb: (e: LogEntry) => void): () => void {
    this.targets.add(cb)
    return () => {
      this.targets.delete(cb)
    }
  }

  list(): LogEntry[] {
    return [...this.entries]
  }

  clear(): void {
    this.entries = []
    store.set('logs', [])
  }
}

export const log = new LogService()

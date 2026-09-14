import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 本地 JSON 持久化存储（方案 7：数据优先本地缓存，SQLite/JSON 二选一，当前采用 JSON）。
 * - 内存缓存 + 防抖落盘（250ms），写入采用 tmp+rename 原子替换
 * - 对象类型读取时与 fallback 浅合并，便于设置新增字段时平滑升级
 * - 读取一律返回**副本**：此前数组分支直接返回缓存内的同一引用，
 *   调用方原地修改（如 rules[idx] = x）会在未落盘的情况下悄悄改掉内存缓存，
 *   一旦进程异常退出就会出现"内存与磁盘分叉"。
 */
function clone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v
  try {
    return structuredClone(v)
  } catch {
    return JSON.parse(JSON.stringify(v)) as T
  }
}

class JsonStore {
  private dir = ''
  private cache = new Map<string, unknown>()
  private timers = new Map<string, NodeJS.Timeout>()

  init(): void {
    this.dir = join(app.getPath('userData'), 'data')
    mkdirSync(this.dir, { recursive: true })
  }

  private file(ns: string): string {
    const safe = ns.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.dir, `${safe}.json`)
  }

  get<T>(ns: string, fallback: T): T {
    if (!this.cache.has(ns)) {
      let data: T = fallback
      try {
        const f = this.file(ns)
        if (existsSync(f)) {
          const parsed = JSON.parse(readFileSync(f, 'utf-8')) as unknown
          data = this.merge(fallback, parsed)
        }
      } catch (err) {
        console.error(`[store] 读取 ${ns} 失败，使用默认值:`, err)
      }
      this.cache.set(ns, data)
      return clone(data)
    }
    // 命中缓存：仍需按 fallback 形态合并，避免 null 兜底读取污染后续读取
    return clone(this.merge(fallback, this.cache.get(ns)))
  }

  private merge<T>(fallback: T, parsed: unknown): T {
    if (parsed === null || parsed === undefined) return fallback
    if (Array.isArray(fallback)) {
      return (Array.isArray(parsed) ? parsed : fallback) as T
    }
    if (fallback && typeof fallback === 'object') {
      return { ...fallback, ...(typeof parsed === 'object' ? (parsed as object) : {}) } as T
    }
    return (parsed ?? fallback) as T
  }

  set<T>(ns: string, data: T): T {
    this.cache.set(ns, data)
    const existing = this.timers.get(ns)
    if (existing) clearTimeout(existing)
    this.timers.set(
      ns,
      setTimeout(() => {
        this.flush(ns)
      }, 250)
    )
    return data
  }

  private flush(ns: string): void {
    this.timers.delete(ns)
    if (!this.cache.has(ns)) return
    const f = this.file(ns)
    const tmp = `${f}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(tmp, JSON.stringify(this.cache.get(ns), null, 2), 'utf-8')
      renameSync(tmp, f)
    } catch (err) {
      console.error(`[store] 落盘 ${ns} 失败:`, err)
    }
  }

  flushAll(): void {
    for (const ns of [...this.timers.keys()]) this.flush(ns)
  }

  remove(ns: string): void {
    this.cache.delete(ns)
    const t = this.timers.get(ns)
    if (t) {
      clearTimeout(t)
      this.timers.delete(ns)
    }
    try {
      unlinkSync(this.file(ns))
    } catch {
      /* 不存在则忽略 */
    }
  }
}

export const store = new JsonStore()

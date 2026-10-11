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

  /**
   * 落盘失败的回调（v0.3.9 体检 M4）。
   *
   * 为什么用回调而不是直接 import 日志服务：`log.ts` 反过来 import 本模块（日志要落盘），
   * 直接互相 import 会形成循环依赖；由 `index.ts` 在启动时把两边接起来最干净。
   * 接的时候要**跳过 `logs` 这个命名空间**（否则磁盘满时会"写日志失败 → 再写日志"无限递归）。
   */
  onFlushError: ((ns: string, err: unknown) => void) | null = null

  /**
   * 某个命名空间被写入后的回调（v0.3.9 体检 H1）。
   *
   * 用途：`settings` 有两个写入方（渲染层 + 主进程十几处），谁后写谁赢会丢配置。
   * 广播挂在这里，主进程那十几处写入点就**自动**被覆盖，不需要逐个去改。
   * 回调要便宜（这里只做 `if (ns === 'settings')` 判断），因为 `set()` 调用非常频繁（日志、下载进度…）。
   */
  onNamespaceWritten: ((ns: string) => void) | null = null

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
      // fallback 是数组时 parsed 也是数组就直接用 parsed；否则用 fallback
      return (Array.isArray(parsed) ? parsed : fallback) as T
    }
    if (fallback && typeof fallback === 'object') {
      /*
       * 浅合并要**跳过 fallback 里的 undefined**（v0.2 统计工具修复）。
       *
       * fallback 通常是一个"字段样例/默认值"对象（如 `{ lists: [], entries: [], revision: 0 }`），
       * 用它给新字段兜底是对的；但过去的 `{...fallback, ...parsed}` 会让 fallback 里
       * **值为 undefined 的键**把磁盘上已有的值覆盖掉：
       *   fallback = { pinned: undefined }，parsed = { pinned: true } → 结果是 undefined
       * 统计列表的「置顶」与统计数据的 revision 都是这样被悄悄吃掉的
       * （表现：置顶后重启应用置顶消失；渲染层的"等广播确认"永远收敛不了）。
       * 现在只让 fallback 提供 parsed 里**没有的**键。
       */
      const merged: Record<string, unknown> = {}
      if (typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) merged[k] = v
      }
      for (const [k, v] of Object.entries(fallback as Record<string, unknown>)) {
        if (!(k in merged)) merged[k] = v
      }
      return merged as T
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
    // 写入即通知（见 onNamespaceWritten 的说明）；回调内部只对 settings 做实际动作
    this.onNamespaceWritten?.(ns)
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
      /*
       * v0.3.9 体检 M4：以前这里只 console.error —— 打包后没有终端，等于**彻底静默**：
       * 磁盘满/权限不足/被杀软拦住时，界面显示"已保存"、实际什么都没写。
       * 现在把它交给外部回调（index.ts 接到日志服务上，会出现在错误日志页）。
       * 注意：这里不直接 import log，因为 log 又 import 本模块，会形成循环依赖。
       */
      this.onFlushError?.(ns, err)
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

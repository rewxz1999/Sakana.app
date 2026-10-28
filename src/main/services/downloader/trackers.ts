import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import axios from 'axios'
import type { AppSettings, TrackerStatus } from '@shared/types'
import { resolveAria2Tuning } from '@shared/types'
import { BUILTIN_TRACKERS, DEFAULT_TRACKER_URL, MAX_TRACKERS, mergeTrackerLists } from '@shared/trackerList'
import { log } from '../../log'
import { BROWSER_UA, buildProxyAgents, getSettings, proxyForUrl } from '../../net'
import { dataPaths } from '../paths'

/**
 * aria2 Tracker 列表（V1.5.2 下载器加速）。
 *
 * 用户原话：「保持 Tracker 列表最新（关键）… 建议每周自动更新一次 Tracker 列表。
 * 数据源：使用社区维护的 ngosang/trackerslist 项目 … 通过 aria2 的 JSON-RPC 接口调用
 * aria2.changeGlobalOption 方法，动态更新 bt-tracker 选项，无需重启 aria2 进程。」
 *
 * 实现要点（为什么这么做）：
 *   1. **缓存到磁盘**（`<userData>/tmp/aria2-trackers.json`）：离线/源站失败时仍有一份可用列表，
 *      而且启动 aria2 时可以直接用同步读取的那份拼 `--bt-tracker`，不必等网络；
 *   2. **3 天刷新一次**（用户说每周一次；3 天更稳，代价只是几 KB 流量），启动时检查；
 *   3. **与内置公共 Tracker 合并**：外部列表偶尔会缺 UDP tracker，合并后去重，只增不减；
 *   4. **失败不清空**：拉取失败继续用旧列表，并记录 lastError 供设置页显示。
 *
 * 合并/过滤/上限这些**纯逻辑**在 `@shared/trackerList`（可脱离 Electron 断言）。
 */

/** 刷新间隔：3 天（用户建议每周一次，这里更勤一点，成本可忽略） */
const REFRESH_MS = 3 * 24 * 3600 * 1000

interface TrackerCacheFile {
  at: number
  list: string[]
  source: string
  error?: string
}

/* TrackerStatus 类型在 @shared/types（设置页也要用），这里只实现 */

let memory: TrackerCacheFile | null = null

function cacheFile(): string {
  return join(dataPaths().userData, 'tmp', 'aria2-trackers.json')
}

function readCache(): TrackerCacheFile | null {
  if (memory) return memory
  try {
    const f = cacheFile()
    if (!existsSync(f)) return null
    const parsed = JSON.parse(readFileSync(f, 'utf-8')) as TrackerCacheFile
    const list = Array.isArray(parsed?.list) ? parsed.list.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
    if (list.length === 0) return null
    memory = { at: Number(parsed.at) || 0, list, source: String(parsed.source ?? '缓存'), error: parsed.error }
    return memory
  } catch {
    return null
  }
}

function writeCache(next: TrackerCacheFile): void {
  memory = next
  try {
    const f = cacheFile()
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(next), 'utf-8')
  } catch (err) {
    log.append('warn', 'aria2', `写入 Tracker 缓存失败（不影响本次使用）：${String((err as Error)?.message ?? err)}`)
  }
}

function validTracker(line: string): boolean {
  const s = line.trim()
  if (!s || s.startsWith('#')) return false
  return /^(https?|udp|wss?):\/\/[^\s]+$/i.test(s)
}

/** 一行一个的文本 → 合法 Tracker 列表（内部仍用 validTracker，保持与旧行为一致） */
function parseLines(text: string): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter(validTracker)
}

/** 同步取当前可用列表（缓存优先，其次内置）。启动 aria2 时用它拼参数，不阻塞。 */
export function currentTrackers(): string[] {
  const cached = readCache()
  return mergeTrackerLists(cached?.list ?? [])
}

/** 当前列表的逗号串（直接给 aria2 的 bt-tracker） */
export function currentTrackerString(): string {
  return currentTrackers().join(',')
}

/** 状态（设置页显示） */
export function trackerStatus(): TrackerStatus {
  const cached = readCache()
  const count = currentTrackers().length
  return {
    count,
    updatedAt: cached?.at ?? null,
    source: cached?.source ?? '内置列表',
    error: cached?.error ?? ''
  }
}

function trackerUrl(): string {
  const cfg = resolveAria2Tuning((getSettings() as AppSettings).downloader?.aria2)
  return cfg.trackerListUrl || DEFAULT_TRACKER_URL
}

/**
 * 拉取并写入 Tracker 列表。
 *
 * @param force true = 忽略 3 天间隔（设置页「立即更新」）
 * @returns 是否真的发起了网络更新（false = 还没到时间 / 已关闭自动更新）
 */
export async function refreshTrackers(force = false): Promise<{ updated: boolean; status: TrackerStatus }> {
  const settings = getSettings() as AppSettings
  const cfg = resolveAria2Tuning(settings.downloader?.aria2)
  if (!cfg.updateTrackers && !force) {
    return { updated: false, status: trackerStatus() }
  }
  const cached = readCache()
  if (!force && cached && Date.now() - cached.at < REFRESH_MS) {
    return { updated: false, status: trackerStatus() }
  }
  const url = cfg.trackerListUrl || DEFAULT_TRACKER_URL
  try {
    const res = await axios.get(url, {
      timeout: 12_000,
      responseType: 'text',
      headers: { Accept: 'text/plain,*/*', 'User-Agent': BROWSER_UA },
      ...buildProxyAgents(proxyForUrl(url))
    })
    const lines = parseLines(String(res.data ?? ''))
    if (lines.length === 0) throw new Error('列表为空或格式不认识')
    const list = mergeTrackerLists(lines)
    writeCache({ at: Date.now(), list, source: 'ngosang/trackerslist' })
    log.append('info', 'aria2', `Tracker 列表已更新：${list.length} 条（来源 ngosang/trackerslist）`)
    return { updated: true, status: trackerStatus() }
  } catch (err) {
    const msg = String((err as { message?: string })?.message ?? err).slice(0, 120)
    // 失败保留旧列表，只记录原因（设置页会显示）
    writeCache({
      at: cached?.at ?? 0,
      list: cached?.list ?? [],
      source: cached?.source ?? '内置列表',
      error: msg
    })
    log.append('warn', 'aria2', `Tracker 列表更新失败（继续用现有 ${currentTrackers().length} 条）：${msg}`)
    return { updated: false, status: trackerStatus() }
  }
}

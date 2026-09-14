import { app } from 'electron'
import type { UpdateInfo } from '@shared/types'
import { log } from '../log'
import { httpGetText } from '../net'

/**
 * 从 git 仓库检查更新（v0.2.4）。
 *
 * 设计：
 * - 唯一事实来源是仓库根目录的 `version.json`（不存在时回落到 `package.json` 的 version 字段），
 *   这样发布时只改一处；远端版本比本地 `app.getVersion()` 高即视为有更新。
 * - 仓库是公开的，因此走 raw / jsDelivr / ghproxy 多镜像并发竞速（与规则仓库同一套思路），
 *   任一命中即可，避免单点被墙。
 * - 结果缓存，自动检查每 6 小时最多一次；手动检查忽略缓存。
 */

export const REPO_SLUG = 'rewxz1999/Sakana.app'
export const REPO_URL = `https://github.com/${REPO_SLUG}`

const RAW_BASES = [
  `https://raw.githubusercontent.com/${REPO_SLUG}/main`,
  `https://cdn.jsdelivr.net/gh/${REPO_SLUG}@main`,
  `https://ghproxy.net/https://raw.githubusercontent.com/${REPO_SLUG}/main`,
  `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO_SLUG}/main`
]

let cached: UpdateInfo | null = null
const CACHE_MS = 6 * 60 * 60 * 1000

/** 语义化版本比较：远端 > 本地返回 true（忽略本地 -beta 之类后缀） */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    String(v)
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((s) => parseInt(s, 10))
      .map((n) => (Number.isFinite(n) ? n : 0))
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

interface VersionFile {
  version?: string
  notes?: string
  url?: string
}

async function fetchVersionFile(): Promise<VersionFile | null> {
  // 并发竞速：谁先返回合法 JSON 用谁
  const tasks = RAW_BASES.map(async (base) => {
    const text = await httpGetText(`${base}/version.json`, 9000)
    const json = JSON.parse(text) as VersionFile
    if (!json || typeof json.version !== 'string') throw new Error('version.json 缺少 version 字段')
    return json
  })
  tasks.push(
    (async () => {
      const text = await httpGetText(`${RAW_BASES[0]}/package.json`, 9000)
      const json = JSON.parse(text) as { version?: string }
      if (!json?.version) throw new Error('package.json 缺少 version')
      return { version: json.version } satisfies VersionFile
    })()
  )
  try {
    return await Promise.any(tasks)
  } catch {
    return null
  }
}

/** 检查更新；`manual=true` 时忽略缓存 */
export async function checkUpdate(manual = false): Promise<UpdateInfo> {
  const current = app.getVersion()
  if (!manual && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached

  try {
    const remote = await fetchVersionFile()
    if (!remote?.version) {
      const info: UpdateInfo = {
        current,
        latest: current,
        hasUpdate: false,
        url: REPO_URL,
        checkedAt: Date.now(),
        error: '无法读取仓库版本信息（网络不可达或仓库为私有）'
      }
      cached = info
      return info
    }
    const info: UpdateInfo = {
      current,
      latest: remote.version,
      hasUpdate: isNewer(remote.version, current),
      notes: remote.notes,
      url: remote.url || `${REPO_URL}/releases`,
      checkedAt: Date.now()
    }
    cached = info
    log.append(
      'info',
      'update',
      info.hasUpdate
        ? `发现新版本 ${info.latest}（当前 ${current}）`
        : `已是最新版本（${current}）`
    )
    return info
  } catch (err) {
    const info: UpdateInfo = {
      current,
      latest: current,
      hasUpdate: false,
      url: REPO_URL,
      checkedAt: Date.now(),
      error: String((err as Error)?.message ?? err)
    }
    cached = info
    log.append('warn', 'update', `检查更新失败: ${info.error}`)
    return info
  }
}

/** 启动后自动检查一次（延迟 8 秒，避开启动网络高峰），有更新只写日志不打扰用户 */
export function scheduleAutoCheck(): void {
  setTimeout(() => {
    void checkUpdate(false)
  }, 8000)
}

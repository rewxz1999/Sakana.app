import { app, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import type { UpdateInfo, UpdateInstallState } from '@shared/types'
import { log } from '../log'
import { httpGetText } from '../net'
import { dataPaths } from './paths'

/**
 * 更新检查与**应用内一键更新**（v0.2.9 最后更新，用户要求）。
 *
 * 用户原话：把安装包传到 GitHub Releases，并且应用以后都从 git 上检测更新包，直接在应用内一键更新。
 *
 * 因此这里的顺序是：
 *  1. **GitHub Releases API 为准**（`/releases/latest`）：能拿到 tag、更新说明与**安装包资产**，
 *     这是「一键更新」的前提 —— 旧版只看 version.json，只能提示、不能装；
 *  2. 拿不到 API 时回落到旧的 version.json 镜像竞速（只提示、不下载），保证弱网/被墙时仍有更新提示；
 *  3. 下载安装包：优先 `browser_download_url`（普通网络最快），
 *     失败则改用 `api.github.com/.../releases/assets/<id>`（该端点在国内常可达，本机实测可用）；
 *  4. 下载完就地（安装目录的 data/updates）静默安装并重启：
 *     `installer.exe /S --force-run`，然后本进程退出。
 *
 * 安装包放在安装目录而不是系统临时目录，一是避免占 C 盘，二是同盘改名/执行更快，
 * 三是用户能自己看到下载下来的东西。
 */

export const REPO_SLUG = 'rewxz1999/Sakana.app'
export const REPO_URL = `https://github.com/${REPO_SLUG}`
const API_BASE = `https://api.github.com/repos/${REPO_SLUG}`

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

interface ReleaseAsset {
  id: number
  name: string
  size: number
  browserUrl: string
  apiUrl: string
}

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  assets?: {
    id: number
    name: string
    size: number
    browser_download_url: string
    url: string
  }[]
}

/** 取最新 release（走 api.github.com：本机与用户的网络实测这条最稳） */
async function fetchLatestRelease(): Promise<GithubRelease | null> {
  try {
    const text = await httpGetText(`${API_BASE}/releases/latest`, 12000, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sakana-Updater' }
    })
    const json = JSON.parse(text) as GithubRelease
    return json?.tag_name ? json : null
  } catch (err) {
    log.append('warn', 'update', `GitHub Releases 查询失败: ${String((err as Error)?.message ?? err)}`)
    return null
  }
}

/** 从 release 里挑出 Windows 安装包（没有就退而取任意 .exe 资产） */
function pickInstaller(release: GithubRelease): ReleaseAsset | null {
  const assets = release.assets ?? []
  const named =
    assets.find((a) => /setup.*\.exe$/i.test(a.name)) ??
    assets.find((a) => /\.exe$/i.test(a.name)) ??
    null
  if (!named) return null
  return {
    id: named.id,
    name: named.name,
    size: named.size,
    browserUrl: named.browser_download_url,
    apiUrl: named.url
  }
}

interface VersionFile {
  version?: string
  notes?: string
  url?: string
}

/** 旧通道：version.json 多镜像竞速（只用于「没有 release 资产」时的提示） */
async function fetchVersionFile(): Promise<VersionFile | null> {
  const tasks = RAW_BASES.map(async (base) => {
    const text = await httpGetText(`${base}/version.json`, 9000)
    const json = JSON.parse(text) as VersionFile
    if (!json || typeof json.version !== 'string') throw new Error('version.json 缺少 version 字段')
    return json
  })
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

  // ① GitHub Releases（可以一键更新的那条路）
  const release = await fetchLatestRelease()
  if (release?.tag_name) {
    const latest = String(release.tag_name).replace(/^v/i, '')
    const asset = pickInstaller(release)
    const info: UpdateInfo = {
      current,
      latest,
      hasUpdate: isNewer(latest, current),
      notes: release.body?.trim() || undefined,
      url: release.html_url || `${REPO_URL}/releases`,
      checkedAt: Date.now(),
      canInstall: Boolean(asset),
      assetName: asset?.name,
      assetSize: asset?.size
    }
    cached = info
    log.append(
      'info',
      'update',
      info.hasUpdate
        ? `发现新版本 ${info.latest}（当前 ${current}，安装包=${asset?.name ?? '无'}，可一键更新=${Boolean(asset)}）`
        : `已是最新版本（${current}）`
    )
    return info
  }

  // ② 回落：只有版本号，没有安装包（提示用户去 Releases 手动下载）
  try {
    const remote = await fetchVersionFile()
    if (!remote?.version) {
      const info: UpdateInfo = {
        current,
        latest: current,
        hasUpdate: false,
        url: REPO_URL,
        checkedAt: Date.now(),
        canInstall: false,
        error: '无法读取更新信息（网络不可达或仓库为私有）'
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
      checkedAt: Date.now(),
      canInstall: false
    }
    cached = info
    log.append(
      'info',
      'update',
      info.hasUpdate ? `发现新版本 ${info.latest}（仅版本号，无安装包信息）` : `已是最新版本（${current}）`
    )
    return info
  } catch (err) {
    const info: UpdateInfo = {
      current,
      latest: current,
      hasUpdate: false,
      url: REPO_URL,
      checkedAt: Date.now(),
      canInstall: false,
      error: String((err as Error)?.message ?? err)
    }
    cached = info
    log.append('warn', 'update', `检查更新失败: ${info.error}`)
    return info
  }
}

/* ------------------------------- 一键更新 ------------------------------- */

let state: UpdateInstallState = { phase: 'idle' }
const listeners = new Set<(s: UpdateInstallState) => void>()

function setState(next: UpdateInstallState): void {
  state = next
  for (const cb of listeners) {
    try {
      cb(next)
    } catch {
      /* 忽略监听器异常 */
    }
  }
}

export function updateInstallState(): UpdateInstallState {
  return state
}

export function onUpdateInstallState(cb: (s: UpdateInstallState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function updatesDir(): string {
  const dir = dataPaths().updates
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 已下载好的安装包（存在且大小与 release 一致才算完整） */
function existingDownload(name: string, size?: number): string | null {
  const file = join(updatesDir(), name)
  if (!existsSync(file)) return null
  if (size && size > 0) {
    try {
      if (statSync(file).size !== size) {
        unlinkSync(file)
        return null
      }
    } catch {
      return null
    }
  }
  return file
}

/**
 * 下载安装包。返回本地文件路径。
 * 两条通道都试：GitHub 直链 → API 资产端点（后者在国内常可达，本机实测可用）。
 */
export async function downloadUpdate(): Promise<{ ok: boolean; file?: string; message: string }> {
  const info = cached ?? (await checkUpdate(true))
  if (!info.hasUpdate) return { ok: false, message: '已是最新版本' }
  if (!info.canInstall || !info.assetName) {
    return { ok: false, message: '该版本没有可用的安装包，请到 Releases 页面手动下载' }
  }
  const reuse = existingDownload(info.assetName, info.assetSize)
  if (reuse) {
    setState({ phase: 'done', file: reuse, version: info.latest })
    return { ok: true, file: reuse, message: '安装包已就绪（复用已下载的文件）' }
  }

  // 重新取一次 release 拿到资产 URL（缓存里只留了展示用的字段）
  const release = await fetchLatestRelease()
  const asset = release ? pickInstaller(release) : null
  if (!asset) return { ok: false, message: '无法获取安装包地址（GitHub API 不可达）' }

  const file = join(updatesDir(), asset.name)
  const urls: { url: string; headers: Record<string, string> }[] = [
    // ① 直链：普通网络最快（本机到 github.com 不通，会自动落到 ②）
    { url: asset.browserUrl, headers: { 'User-Agent': 'Sakana-Updater' } },
    // ② 资产端点：走 api.github.com（实测国内可达）
    { url: asset.apiUrl, headers: { Accept: 'application/octet-stream', 'User-Agent': 'Sakana-Updater' } }
  ]

  setState({ phase: 'downloading', received: 0, total: asset.size, version: info.latest })
  let lastMessage = ''
  for (const attempt of urls) {
    try {
      await axios.get(attempt.url, {
        timeout: 0,
        responseType: 'stream',
        maxRedirects: 5,
        headers: attempt.headers,
        // 进度：按已收字节回调（写盘与进度同步，界面不会出现「下载完了还在转」）
        onDownloadProgress: (e) => {
          setState({
            phase: 'downloading',
            received: e.loaded ?? 0,
            total: e.total || asset.size,
            version: info.latest
          })
        }
      }).then(
        (res) =>
          new Promise<void>((resolve, reject) => {
            const ws = createWriteStream(file)
            res.data.pipe(ws)
            ws.on('finish', () => resolve())
            ws.on('error', reject)
            res.data.on('error', reject)
          })
      )
      log.append('info', 'update', `安装包下载完成: ${file}`)
      setState({ phase: 'done', file, version: info.latest })
      return { ok: true, file, message: '下载完成，可以开始安装' }
    } catch (err) {
      lastMessage = String((err as Error)?.message ?? err)
      log.append('warn', 'update', `安装包下载失败（${attempt.url.slice(0, 60)}…）: ${lastMessage}`)
      try {
        if (existsSync(file)) unlinkSync(file)
      } catch {
        /* ignore */
      }
    }
  }
  setState({ phase: 'failed', message: lastMessage })
  return { ok: false, message: `下载失败：${lastMessage}` }
}

/**
 * 静默安装并重启。
 *
 * electron-builder 的 NSIS 安装器支持 `/S`（静默）与 `--force-run`（装完自动拉起应用）；
 * 我们自己先退出，避免「正在运行的文件无法覆盖」。
 * 装完不重启的兜底：界面提示用户手动打开（安装目录不变时 exe 路径也不变）。
 */
export function installUpdate(): { ok: boolean; message: string } {
  const file = state.phase === 'done' ? state.file : undefined
  if (!file || !existsSync(file)) {
    return { ok: false, message: '安装包还没下载好，请先点击「下载更新」' }
  }
  try {
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const child = spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' })
    child.unref()
    log.append('info', 'update', `已启动静默安装：${file} /S --force-run，本进程即将退出`)
    setState({ phase: 'installing', file })
    // 给安装器一点时间接管，然后退出自己（否则文件占用会导致覆盖失败）
    setTimeout(() => app.quit(), 1200)
    return { ok: true, message: '安装程序已启动，应用会在安装完成后自动重新打开' }
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    log.append('error', 'update', `启动安装程序失败: ${message}`)
    setState({ phase: 'failed', message })
    return { ok: false, message }
  }
}

/** 打开 Releases 页面（没有安装包资产时的兜底给用户） */
export function openReleases(): void {
  void shell.openExternal(cached?.url || `${REPO_URL}/releases`)
}

/** 启动后自动检查一次（延迟 8 秒，避开启动网络高峰），有更新只写日志不打扰用户 */
export function scheduleAutoCheck(): void {
  setTimeout(() => {
    void checkUpdate(false)
  }, 8000)
}

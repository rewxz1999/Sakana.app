import { app, BrowserWindow, shell } from 'electron'
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import axios from 'axios'
import type { UpdateInfo, UpdateInstallState } from '@shared/types'
import { CH } from '@shared/channels'
import { log } from '../log'
import { unzipEntries } from '../lib/zip'
import { httpGetText } from '../net'
import { store } from '../store'
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

/**
 * 找增量补丁资产（v0.2.10，用户要的「安装包层面的小更新」）。
 *
 * 命名约定：`patch-<当前版本>-to-<新版本>.zip`（由 `scripts/make-patch.js` 生成、
 * `scripts/release-via-api.js` 上传）。补丁里只含**内容变化的文件**（App 代码那几 MB），
 * 因此下载量远小于完整安装包。
 * 找不到就回落到完整安装包 —— 「补丁没发」或「跨了多个版本」时照样能更新，只是下载大一些。
 */
function pickPatch(release: GithubRelease, current: string, latest: string): ReleaseAsset | null {
  const want = `patch-${current}-to-${latest}.zip`.toLowerCase()
  const hit = (release.assets ?? []).find((a) => a.name.toLowerCase() === want)
  return hit
    ? { id: hit.id, name: hit.name, size: hit.size, browserUrl: hit.browser_download_url, apiUrl: hit.url }
    : null
}

interface VersionFile {
  version?: string
  notes?: string
  url?: string
  /** v0.2.12：重要更新标记（与 Release 说明里的 `【重要更新】` 等价） */
  important?: boolean
}

/**
 * 是否为「重要更新」（v0.2.12）。
 *
 * 用户要求：「本次更新十分重要，之后只要是十分重要的更新都要在应用启动后弹窗强烈提醒用户更新」。
 * 判定做成**发布侧可控、不用改代码**：Release 的标题或说明里写上 `【重要更新】` 即可
 * （`[重要更新]` / `【重要】` 也认）。以后哪次发布重要，带上标记就会触发强提醒。
 */
function isImportantRelease(release: GithubRelease): boolean {
  const text = `${release.name ?? ''}\n${release.body ?? ''}`
  return /【重要更新】|\[重要更新\]|【重要】/.test(text)
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
    // v0.2.10：优先用增量补丁（只下变化的文件），没有补丁才用完整安装包
    const patch = pickPatch(release, current, latest)
    const info: UpdateInfo = {
      current,
      latest,
      hasUpdate: isNewer(latest, current),
      notes: release.body?.trim() || undefined,
      url: release.html_url || `${REPO_URL}/releases`,
      checkedAt: Date.now(),
      canInstall: Boolean(asset) || Boolean(patch),
      assetName: asset?.name,
      assetSize: asset?.size,
      patchName: patch?.name,
      patchSize: patch?.size,
      important: isImportantRelease(release)
    }
    cached = info
    log.append(
      'info',
      'update',
      info.hasUpdate
        ? `发现新版本 ${info.latest}（当前 ${current}）：` +
            (patch
              ? `增量补丁 ${patch.name}（${(patch.size / 1024 / 1024).toFixed(1)}MB）`
              : `完整安装包 ${asset?.name ?? '无'}（${asset ? (asset.size / 1024 / 1024).toFixed(1) + 'MB' : '—'}）`)
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
      canInstall: false,
      important: remote.important === true
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

/** 「更新进行中」标记文件名：辅助进程成功后删除，留着说明上次没走完 */
const PENDING_MARKER = '.pending-update'

/**
 * 「这台机器上补丁方式用不了」的标记（v0.2.17）。
 *
 * 用户实测：补丁能下载、能校验、能还原增量，但最后启动覆盖脚本时被安全策略挡住。
 * 记下这个事实之后，后续「下载更新」直接改用完整安装包，避免用户反复撞同一堵墙。
 * 只在用户手动点「下载更新」时读取；想重试补丁可以在设置里清空应用数据（极端情况）。
 */
const PATCH_BLOCKED_KEY = 'patchApplyBlocked'

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

/**
 * 清理 `data/updates` 里过期的下载（v0.2.11）。
 *
 * 为什么需要：完整安装包一个 200MB，而且新版安装器**会保留 data/**（以前升级会清空安装目录，
 * 现在为了保住用户数据改成保留了），于是每次下载完的安装包都会一直躺在安装目录里 ——
 * 用户明明只用一次，却要长期占几百 MB 磁盘。
 * 规则：超过 7 天的下载（安装包 / 补丁 / 解包残留 / 日志）一律删掉；
 * 「上次更新未完成」的标记留着，别把待排查的线索清了。
 */
export function cleanupUpdatesDir(): void {
  const dir = updatesDir()
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  let freed = 0
  try {
    for (const name of readdirSync(dir)) {
      if (name === PENDING_MARKER) continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.mtimeMs > cutoff) continue
        freed += st.isDirectory() ? 0 : st.size
        rmSync(full, { recursive: true, force: true })
      } catch {
        /* 单个条目失败不影响其它 */
      }
    }
  } catch {
    /* 目录读不到就算了，不值得打断启动 */
  }
  if (freed > 0) {
    log.append('info', 'update', `已清理过期的更新下载：${(freed / 1024 / 1024).toFixed(1)}MB`)
  }
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
 * 下载更新（v0.2.10：**优先增量补丁**）。
 *
 * 两条路：
 * - 有 `patch-<当前>-to-<新>.zip` → 只下变化的文件（通常几 MB），解包 + 逐文件校验；
 * - 没有补丁 → 下完整安装包（361MB，走直链或 API 资产端点）。
 * 下载统一两条通道：GitHub 直链 → api.github.com 资产端点（后者在国内常可达，实测可用）。
 */
export async function downloadUpdate(): Promise<{ ok: boolean; file?: string; message: string }> {
  const info = cached ?? (await checkUpdate(true))
  if (!info.hasUpdate) return { ok: false, message: '已是最新版本' }
  if (!info.canInstall) {
    return { ok: false, message: '该版本没有可用的更新包，请到 Releases 页面手动下载' }
  }

  // 重新取一次 release 拿到资产 URL（缓存里只留了展示用的字段）
  const release = await fetchLatestRelease()
  if (!release) return { ok: false, message: '无法获取更新地址（GitHub API 不可达）' }
  // v0.2.17：这台机器上补丁方式起不来过 → 直接走完整安装包，别再撞同一堵墙
  const patchBlocked = store.get<boolean>(PATCH_BLOCKED_KEY, false)
  const patch = patchBlocked ? null : pickPatch(release, info.current, info.latest)
  const installer = pickInstaller(release)
  if (patchBlocked && pickPatch(release, info.current, info.latest)) {
    log.append('info', 'update', '此前补丁方式在本机启动失败过，本次改用完整安装包')
  }
  const asset = patch ?? installer
  if (!asset) return { ok: false, message: '无法获取更新地址（release 里没有安装包或补丁）' }

  const reuse = existingDownload(asset.name, asset.size)
  if (reuse) {
    setState({ phase: 'done', file: reuse, version: info.latest, mode: patch ? 'patch' : 'installer' })
    const ready = patch ? verifyPatch(reuse) : { ok: true as const }
    if (ready.ok) return { ok: true, file: reuse, message: '更新包已就绪（复用已下载的文件）' }
    /*
     * 复用失败要把原因写进日志（v0.2.13）。之前这里一声不吭就把它删掉重下，
     * 用户看到的是「下载完了又下载一遍，最后说解包失败」，日志里却查不到任何线索 ——
     * 上一轮排查那个 EPERM 就是被这一点拖了很久。
     */
    if (patch) log.append('warn', 'update', `已下载的补丁不可用，将重新下载：${ready.message}`)
    try {
      unlinkSync(reuse)
    } catch (err) {
      log.append('warn', 'update', `清理旧补丁失败（不影响继续下载）：${String((err as Error)?.message ?? err)}`)
    }
  }

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
      await axios
        .get(attempt.url, {
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
        })
        .then(
          (res) =>
            new Promise<void>((resolve, reject) => {
              const ws = createWriteStream(file)
              res.data.pipe(ws)
              ws.on('finish', () => resolve())
              ws.on('error', reject)
              res.data.on('error', reject)
            })
        )
      log.append('info', 'update', `${patch ? '增量补丁' : '安装包'}下载完成: ${file}`)
      if (patch) {
        const ver = verifyPatch(file)
        if (!ver.ok) {
          // 校验失败是有价值的信息（补丁损坏/被中间设备改写/解析器不支持），必须留痕
          log.append('warn', 'update', `补丁校验未通过：${ver.message}`)
          lastMessage = ver.message
          try {
            unlinkSync(file)
          } catch (err) {
            log.append('warn', 'update', `清理未通过的补丁失败：${String((err as Error)?.message ?? err)}`)
          }
          continue
        }
      }
      setState({ phase: 'done', file, version: info.latest, mode: patch ? 'patch' : 'installer' })
      return {
        ok: true,
        file,
        message: patch
          ? `增量补丁已就绪（${(asset.size / 1024 / 1024).toFixed(1)}MB，只包含变化的文件）`
          : '安装包已就绪'
      }
    } catch (err) {
      lastMessage = String((err as Error)?.message ?? err)
      log.append('warn', 'update', `下载失败（${attempt.url.slice(0, 60)}…）: ${lastMessage}`)
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

interface PatchFile {
  path: string
  sha256: string
  size: number
  mode?: 'full' | 'delta'
}
/** 字节增量文件的差异区段（`data` 是 base64） */
interface PatchSpan {
  off: number
  data: string
}
interface PatchJson {
  from: string
  to: string
  files: PatchFile[]
  deltas?: (PatchFile & { baseSha256: string; spans: PatchSpan[] })[]
  removed: string[]
}

/**
 * 解包目录里落盘时的**安全后缀**（v0.2.13 关键修复）。
 *
 * Electron 给主进程的 `fs` 打过 asar 补丁：**任何以 `.asar` 结尾的路径都会被当成 asar 包解析**。
 * 我们的补丁里恰好有一个 `resources/app.asar`，于是应用进程一读一写它就炸 ——
 * 用户实测报的那个 `EPERM, Permission denied: '…zip.unpacked' -> '…同名'`，
 * 以及我在应用内复现出来的 `Invalid package …\app.asar`，根因都是它
 * （用 Node 单独跑同一段逻辑三遍全过，正是因为 Node 没有这个补丁）。
 *
 * 所以落盘时统一加这个后缀，让**应用进程**永远不碰 `.asar` 路径；
 * 覆盖脚本是独立的 PowerShell 进程（没有 asar 补丁），由它把后缀去掉、写回真实文件名。
 * 生成端（`scripts/make-patch.js`）与脚本端必须用同一个常量，改动要同步。
 */
const STAGED_SUFFIX = '.sakana-staged'

/** 补丁解包目录（每次校验都重建，避免残留旧文件污染） */
function patchStageDir(zip: string): string {
  return `${zip}.unpacked`
}

/** 已校验通过的补丁：zip 路径 → 解包目录。installUpdateFrom 用它，避免重复解包 */
const verifiedStage = new Map<string, string>()

/**
 * 校验补丁并把「整文件」落盘到解包目录。
 *
 * ## v0.2.13：不再调用外部 tar，也不再先删目录
 *
 * 用户实测（0.2.11 应用内更新到 0.2.12 时）报：
 *   `补丁解包失败：EPERM, Permission denied: '…patch-0.2.11-to-0.2.12.zip.unpacked' -> '…同路径'`
 * 同一个补丁、同一个带中文的目录，用 Node 单独跑三遍全过 —— 说明失败来自**应用进程特有的上下文**
 * （子进程创建 / 文件句柄 / 杀软扫描），而不是补丁或路径本身。补丁解包是更新链路的关键一步，
 * 不该依赖外部程序，所以这一版改成：
 *   ① **纯 JS 解压**（`src/main/lib/zip.ts`：EOCD → 中央目录 → inflateRawSync），没有任何子进程；
 *   ② **先在内存里把哈希全算完**，全部对得上才往磁盘写 —— 不会再出现「删目录失败」或
 *      「半个 app.asar 落进安装目录」这类中间状态；
 *   ③ 解包目录用**唯一名字**（带进程号与时间戳），彻底避开 Windows 上「删不掉又建不出来」的
 *      待删除状态；旧目录交给启动时的过期清理。
 * 另外每一处失败都把**是哪一步**写清楚（读文件 / 解压 / 哈希），下次再出问题一眼能定位。
 */
function verifyPatch(zip: string): { ok: true; stage: string } | { ok: false; message: string } {
  let zipBuf: Buffer
  try {
    zipBuf = readFileSync(zip)
  } catch (err) {
    return { ok: false, message: `读取补丁失败（${String((err as Error)?.message ?? err)}）` }
  }

  let entries: { name: string; data: Buffer }[]
  try {
    entries = unzipEntries(zipBuf)
  } catch (err) {
    return { ok: false, message: `解压补丁失败（${String((err as Error)?.message ?? err)}）` }
  }

  const manifestEntry = entries.find((e) => e.name === 'patch.json' || e.name === './patch.json')
  if (!manifestEntry) return { ok: false, message: '补丁里缺少 patch.json' }
  let manifest: PatchJson
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8')) as PatchJson
  } catch (err) {
    return { ok: false, message: `patch.json 解析失败（${String((err as Error)?.message ?? err)}）` }
  }
  if (!Array.isArray(manifest.files)) return { ok: false, message: 'patch.json 结构不正确' }

  // ① 内存里逐个核对整文件：这一轮**不碰磁盘**
  const staged = new Map<string, Buffer>()
  for (const f of manifest.files) {
    const hit = entries.find((e) => e.name === f.path || e.name === `./${f.path}`)
    if (!hit) return { ok: false, message: `补丁缺少文件：${f.path}` }
    const hash = createHash('sha256').update(hit.data).digest('hex')
    if (hash !== f.sha256) {
      return { ok: false, message: `补丁文件校验失败（哈希不一致）：${f.path}` }
    }
    staged.set(f.path, hit.data)
  }
  // 增量条目只检查结构：真正的字节写入放在安装前（那时才读安装目录里的旧文件）
  for (const d of manifest.deltas ?? []) {
    if (!d.baseSha256 || !Array.isArray(d.spans) || d.spans.length === 0) {
      return { ok: false, message: `补丁增量信息不完整：${d.path}` }
    }
  }

  // ② 全部通过后才写盘：解包目录用唯一名字，失败重试也不会撞上"待删除"的旧目录
  const stage = `${patchStageDir(zip)}-${process.pid}-${Date.now()}`
  try {
    mkdirSync(stage, { recursive: true })
    for (const [rel, data] of staged) {
      // 加安全后缀：应用进程绝不直接读写 `.asar` 路径（见 STAGED_SUFFIX 注释）
      const dest = join(stage, `${rel}${STAGED_SUFFIX}`)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, data)
    }
    // patch.json 一并写出：覆盖脚本与 removed 清单都要读它
    writeFileSync(join(stage, 'patch.json'), manifestEntry.data)
  } catch (err) {
    return { ok: false, message: `写入解包目录失败（${String((err as Error)?.message ?? err)}）` }
  }

  verifiedStage.set(zip, stage)
  log.append(
    'info',
    'update',
    `增量补丁校验通过：${manifest.files.length} 个整文件 + ${manifest.deltas?.length ?? 0} 个增量文件（${manifest.from} → ${manifest.to}），解包到 ${stage}`
  )
  // 顺手清掉同名补丁的历史解包目录（本次没用上的那些）
  try {
    for (const name of readdirSync(dirname(zip))) {
      if (name.startsWith(`${basename(zip)}.unpacked-`) && join(dirname(zip), name) !== stage) {
        rmSync(join(dirname(zip), name), { recursive: true, force: true })
      }
    }
  } catch {
    /* 清不掉就算了，启动时的过期清理会处理 */
  }
  return { ok: true, stage }
}

/**
 * 读补丁里「新版本已删除」的相对路径清单。
 *
 * 增量更新只覆盖文件，不会删东西；旧版里被删掉的脚本/资源如果留着，可能被新版当插件加载
 * 而崩溃 —— 所以生成补丁时把这类文件记进 `removed[]`，安装脚本负责删掉。
 * 路径做安全过滤：必须是相对路径，且不许出现 `..`（否则可能删到安装目录外面）。
 */
function removedFilesFor(stage: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(stage, 'patch.json'), 'utf8')) as PatchJson
    return (manifest.removed ?? []).filter(
      (p) => typeof p === 'string' && p.length > 0 && !p.includes('..') && !/^[a-zA-Z]:/.test(p)
    )
  } catch {
    return []
  }
}

/**
 * 把补丁里的**字节增量**落成完整文件（v0.2.10）。
 *
 * 背景：`Sakana.exe` 有 233MB，但每次版本它只变几百字节（electron-builder 会把 `app.asar`
 * 的完整性哈希写进 exe 的资源段）。整文件下发的话补丁会白白多出 100MB+，
 * 所以生成端只下发差异区段，这里负责把它贴回安装目录里**当前那份**旧文件上。
 *
 * 三道校验，任一步不过就放弃（返回 ok:false，界面提示改走完整安装包）：
 *  ① 安装目录里的旧文件读完后的 sha256 必须等于 `baseSha256`（否则说明用户的文件不是我们以为的那份）；
 *  ② 写入区段后重新计算的 sha256 必须等于 `sha256`（补丁里声明的新文件）；
 *  ③ 段必须落在文件范围内（防越界写坏文件）。
 * 只有全部通过，结果才写进解包目录，交给后面的 robocopy 覆盖。
 */
function materializeDeltas(stage: string): { ok: true } | { ok: false; message: string } {
  const manifestPath = join(stage, 'patch.json')
  let manifest: PatchJson
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PatchJson
  } catch (err) {
    return { ok: false, message: `无法读取补丁清单：${String((err as Error)?.message ?? err)}` }
  }
  const install = dirname(app.getPath('exe'))
  for (const d of manifest.deltas ?? []) {
    const source = join(install, d.path)
    if (!existsSync(source)) {
      return { ok: false, message: `安装目录缺少文件：${d.path}（请改用完整安装包更新）` }
    }
    let buf: Buffer
    try {
      buf = readFileSync(source)
    } catch (err) {
      return { ok: false, message: `读取 ${d.path} 失败：${String((err as Error)?.message ?? err)}` }
    }
    if (createHash('sha256').update(buf).digest('hex') !== d.baseSha256) {
      return { ok: false, message: `本地 ${d.path} 与补丁基准不一致（请改用完整安装包更新）` }
    }
    for (const span of d.spans) {
      const bytes = Buffer.from(span.data, 'base64')
      if (span.off < 0 || span.off + bytes.length > buf.length) {
        return { ok: false, message: `补丁区段越界：${d.path}@${span.off}` }
      }
      bytes.copy(buf, span.off)
    }
    if (createHash('sha256').update(buf).digest('hex') !== d.sha256) {
      return { ok: false, message: `增量还原校验失败：${d.path}（请改用完整安装包更新）` }
    }
    const dest = join(stage, `${d.path}${STAGED_SUFFIX}`)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, buf)
    log.append(
      'info',
      'update',
      `增量还原 ${d.path}：${d.spans.length} 段 / ${(buf.length / 1024 / 1024).toFixed(1)}MB 校验通过`
    )
  }
  return { ok: true }
}

/**
 * 生成交给辅助进程执行的覆盖脚本（v0.2.10 加固）。
 *
 * 为什么必须是**辅助进程**：`Sakana.exe` 与 `resources/app.asar` 在应用运行期间被占用，
 * 自己覆盖不了自己 —— electron-updater、Squirrel、NSIS 全都是这么做的。
 *
 * 这一版把三件事做扎实：
 *  ① **可审计**：脚本落成一个 `.ps1` 文件再执行，出问题时用户和我们都能直接看到它到底跑了什么
 *     （原来是把一大串命令塞进 `-Command`，失败时只有一句「点了没反应」）；
 *  ② **绝不留半个文件**：先把内容复制到目标同目录的 `*.sakana-new`，再 `Move-Item -Force` 改名覆盖。
 *     覆盖过程中被杀掉，最坏也只是「这个文件还是旧的」，不会出现被截断的 app.asar 导致应用打不开。
 *     （实测过：exe 与 asar 的完整性哈希对不上时 Electron 照样启动，所以「新旧混装」是**可恢复**状态，
 *     而不是把用户的应用弄坏。）
 *  ③ **失败可见**：脚本第一件事就是往日志写 `helper started`，应用等这个握手，
 *     等不到就**不退出**并直接报错，避免出现「应用关了、什么都没发生」这种最难排查的情况。
 *
 * 脚本正文**只用 ASCII**：Windows PowerShell 5.1 对没有 BOM 的 UTF-8 文件按 ANSI 解析，
 * 中文会让脚本直接语法错误（自检脚本上刚踩过这个坑）。
 */
function buildApplyScript(stage: string, target: string, exe: string, logFile: string, removed: string[]): string {
  // PowerShell 单引号字符串里的单引号要写成两个
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const removeLines = removed.map(
    (rel) => `Remove-Item -LiteralPath (Join-Path $target ${q(rel)}) -Force -ErrorAction SilentlyContinue`
  )
  return [
    `$ErrorActionPreference = 'Continue'`,
    `$stage  = ${q(stage)}`,
    `$target = ${q(target)}`,
    `$exe    = ${q(exe)}`,
    `$log    = ${q(logFile)}`,
    `function Say($m) { "$((Get-Date).ToString('s')) $m" | Out-File -FilePath $log -Append -Encoding utf8 }`,
    `Say 'helper started'`,
    // 等本进程退出：Sakana.exe / app.asar 被占用时覆盖会失败
    `try { Wait-Process -Id ${process.pid} -Timeout 180 -ErrorAction SilentlyContinue } catch {}`,
    `Start-Sleep -Milliseconds 800`,
    `Say 'app exited, applying patch'`,
    `$applied = 0`,
    `Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {`,
    `  if ($_.Name -eq 'patch.json') { return }`,
    `  $rel = $_.FullName.Substring($stage.Length + 1)`,
    // v0.2.13：应用进程落盘时给每个文件加了 .sakana-staged 后缀（避开 Electron 的 asar 补丁，
    // 详见 updater.ts 的 STAGED_SUFFIX 注释）。这里是独立进程，没有那个补丁 —— 负责把后缀去掉，
    // 写回真实文件名。两边的后缀必须一致。
    `  if ($rel.EndsWith('${STAGED_SUFFIX}')) { $rel = $rel.Substring(0, $rel.Length - ${STAGED_SUFFIX.length}) }`,
    `  $dst = Join-Path $target $rel`,
    `  $dir = Split-Path -Parent $dst`,
    `  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }`,
    `  $tmp = "$dst.sakana-new"`,
    `  Copy-Item -LiteralPath $_.FullName -Destination $tmp -Force`,
    `  Move-Item -LiteralPath $tmp -Destination $dst -Force`,
    `  $script:applied++`,
    `}`,
    `Say "applied $applied files"`,
    ...removeLines,
    `Say 'obsolete files removed'`,
    // 成功走到这里才清掉「更新进行中」标记；半途失败时它会留到下次启动被检测到
    `Remove-Item -LiteralPath ${q(join(updatesDir(), PENDING_MARKER))} -Force -ErrorAction SilentlyContinue`,
    `Start-Process -FilePath $exe`,
    `Say 'relaunched'`,
    `Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue`,
    `Say 'done'`,
    ''
  ].join('\r\n')
}

/** PowerShell 解释器：优先绝对路径（PATH 被改过时按名字找会失败） */
function powershellExe(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(full) ? full : 'powershell'
}

/** 追加方式打开一个文件用于子进程 stderr（目录不存在时先建出来） */
function openSyncAppend(file: string): number {
  const { openSync } = require('node:fs') as typeof import('node:fs')
  return openSync(file, 'a')
}

/**
 * 异步等待辅助进程「报到」（v0.2.17）。
 *
 * 用异步轮询而不是 `Atomics.wait` 阻塞：阻塞会冻住事件循环，
 * `child.on('error')` 回调永远轮不到执行 —— 真正的失败原因（spawn EPERM/ENOENT、被策略拦截）
 * 会被吞掉，用户只看到一句含糊的「PowerShell 未能运行」。这正是上一轮排查卡住的地方。
 */
async function waitForHelperStart(
  logFile: string,
  getSpawnError: () => string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (getSpawnError()) return false
    try {
      if (existsSync(logFile) && readFileSync(logFile, 'utf8').includes('helper started')) return true
    } catch {
      /* 日志刚创建还没写完，下一轮再看 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/** 启动失败时收集现场证据写进日志（判断「脚本有没有跑、被谁拦住」全靠这些） */
function collectPatchEvidence(scriptPath: string, logFile: string, stderrFile: string): string {
  const parts: string[] = []
  parts.push(`脚本存在=${existsSync(scriptPath)}`)
  if (existsSync(scriptPath)) {
    try {
      const head = readFileSync(scriptPath).subarray(0, 3)
      parts.push(`脚本BOM=${head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf}`)
    } catch {
      parts.push('脚本读取失败')
    }
  }
  parts.push(`启动日志=${existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(0, 150).replace(/\s+/g, ' ') : '未生成'}`)
  parts.push(
    `PowerShell报错=${existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8').slice(0, 300).replace(/\s+/g, ' ') : '无'}`
  )
  return parts.join('；')
}

/**
 * 安装更新（v0.2.10）。
 *
 * - **补丁模式**：解包校验 → 还原字节增量 → 写一个覆盖脚本并脱离启动辅助 PowerShell，
 *   它等我们退出后把补丁文件逐个改名覆盖进安装目录、删掉新版本已移除的文件、再重新拉起应用。
 * - **安装包模式**：`installer.exe /S --force-run`（NSIS 静默安装 + 装完自动拉起）。
 * 两种模式都先让本进程退出，避免「正在运行的文件无法覆盖」。
 */
export function installUpdate(): Promise<{ ok: boolean; message: string }> {
  const file = state.phase === 'done' ? state.file : undefined
  const mode = state.phase === 'done' ? state.mode : undefined
  if (!file || !existsSync(file)) {
    return Promise.resolve({ ok: false, message: '更新包还没下载好，请先点击「下载更新」' })
  }
  return installUpdateFrom(file, mode ?? 'installer')
}

/**
 * 用指定的更新包执行安装（`installUpdate` 的实体，也是自检入口 `SAKANA_PATCH_TEST` 走的同一条路）。
 *
 * 拆出来是为了让「增量补丁」这条路能被真实验证：自检模式直接喂一个本地补丁 zip 进来，
 * 跑的就是用户点「立即重启更新」时的同一段代码，不存在「测试路径与真实路径不一致」。
 */
export async function installUpdateFrom(
  file: string,
  mode: 'patch' | 'installer'
): Promise<{ ok: boolean; message: string }> {
  if (!existsSync(file)) return { ok: false, message: `更新包不存在：${file}` }
  try {
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const exe = app.getPath('exe')
    const installDir = dirname(exe)
    if (mode === 'patch') {
      /*
       * 安装前**重新解包并校验一次**，不依赖「下载那一步已经解过」这个隐式前提。
       * 起因是自检时踩到的：`SAKANA_PATCH_TEST` 直接调到这里，解包目录不存在，
       * 于是报「无法读取补丁清单」。真实路径也有同样的隐患 —— 用户先点「下载更新」、
       * 隔一会儿再点「立即重启更新」时，中间任何清理（临时目录被删、磁盘清理软件）
       * 都会让覆盖阶段拿到一个不完整的目录。校验幂等、成本只有几秒，值得每次重做。
       */
      const verified = verifyPatch(file)
      if (!verified.ok) {
        log.append('warn', 'update', `增量补丁不可用：${verified.message}`)
        setState({ phase: 'failed', message: verified.message, reason: 'apply' })
        return { ok: false, message: `${verified.message}（可在下方点「打开 Releases 页面」下载完整安装包）` }
      }
      const stage = verified.stage
      // 再把字节增量还原成完整文件（本进程还活着，能读安装目录里的旧 exe/asar）
      const built = materializeDeltas(stage)
      if (!built.ok) {
        log.append('warn', 'update', `增量更新无法应用：${built.message}`)
        setState({ phase: 'failed', message: built.message, reason: 'apply' })
        return { ok: false, message: `${built.message}（可在下方点「打开 Releases 页面」下载完整安装包）` }
      }

      const logFile = join(updatesDir(), 'patch-apply.log')
      const scriptPath = join(updatesDir(), 'apply-patch.ps1')
      // 日志每次重来，避免上一次的 helper started 让握手误判成功
      try {
        if (existsSync(logFile)) unlinkSync(logFile)
      } catch {
        /* ignore */
      }
      /*
       * ⚠️ 必须写 **UTF-8 BOM**（v0.2.15，用户实测「更新脚本没有启动（PowerShell 未能运行）」）。
       *
       * 原因：Windows PowerShell 5.1 读取**没有 BOM** 的文件时按系统 ANSI 代码页解析。
       * 脚本里必然含用户安装路径（例如 `D:\动画应用\sakana\sakana.data`），于是中文路径全变乱码 ——
       * 脚本还能跑，但 `Out-File` 写到的是乱码路径，应用在**正确**的路径上等 `helper started`，
       * 永远等不到，握手超时 → 报「更新脚本没有启动」。加 BOM 后 PS 正确识别 UTF-8，路径不再被破坏。
       * （同一个坑在本项目的 .ps1 自检脚本上踩过两次。）
       */
      writeFileSync(
        scriptPath,
        `\uFEFF${buildApplyScript(stage, installDir, exe, logFile, removedFilesFor(stage))}`,
        'utf8'
      )
      // 更新进行中的标记：辅助进程成功后会删掉它，留着就说明上次没走完
      writeFileSync(
        join(updatesDir(), PENDING_MARKER),
        JSON.stringify({ file, exe, startedAt: new Date().toISOString() }, null, 2),
        'utf8'
      )

      // 自检模式：只写脚本不启动辅助进程（沙箱里任何"比命令活得久"的进程都会被杀掉，
      // 只能由测试自己在前台执行这个脚本，见 .e2e/run-e2e.ps1）
      if (process.env.SAKANA_PATCH_TEST_FOREGROUND) {
        log.append('info', 'update', `自检模式：覆盖脚本已写出，未启动辅助进程 ${scriptPath}`)
        setState({ phase: 'installing', file })
        return { ok: true, message: `自检模式：脚本已写出 ${scriptPath}` }
      }

      /*
       * 启动辅助进程（v0.2.17 重写）。
       *
       * 用户实测（0.2.15 → 0.2.16）：补丁下载、校验、增量还原全部成功，卡在最后一步 ——
       * 「更新脚本没有启动（PowerShell 未能运行）」，整整 8 秒后超时。
       * 说明这台机器上 `powershell -File 脚本.ps1` 这条路走不通（脚本执行策略/杀软拦截/编码都可能），
       * 而原来那段代码有两个硬伤：
       *   ① 用 `Atomics.wait` 阻塞事件循环来等握手 —— 阻塞期间 `child.on('error')` **根本没机会执行**，
       *      真正的失败原因被吞掉，只剩一句含糊的「PowerShell 未能运行」；
       *   ② 只试一种启动方式，失败就没有退路。
       *
       * 现在：先试 `-File`（脚本落盘、可审计），失败改用 `-EncodedCommand`
       * （base64 传脚本、**完全不读文件**，绕过脚本文件执行策略与编码问题），
       * 每次尝试都把子进程 stderr 落盘、异步轮询握手、失败时收集现场证据写进日志。
       */
      const stderrFile = join(updatesDir(), 'helper-stderr.log')
      try {
        if (existsSync(stderrFile)) unlinkSync(stderrFile)
      } catch {
        /* ignore */
      }
      const scriptText = buildApplyScript(stage, installDir, exe, logFile, removedFilesFor(stage))
      const encoded = Buffer.from(scriptText, 'utf16le').toString('base64')

      const attempt = async (args: string[], tag: string): Promise<boolean> => {
        const child = spawn(powershellExe(), args, {
          detached: true,
          // stderr 落盘而不是丢掉：PowerShell 的报错（策略被禁、脚本损坏）全在这里
          stdio: ['ignore', 'ignore', openSyncAppend(stderrFile)],
          windowsHide: true
        })
        let spawnError = ''
        child.on('error', (e) => {
          spawnError = String(e?.message ?? e)
        })
        child.unref()
        const ok = await waitForHelperStart(logFile, () => spawnError, 7000)
        log.append(
          ok ? 'info' : 'warn',
          'update',
          ok
            ? `辅助进程已启动（方式 ${tag}）`
            : `辅助进程启动失败（方式 ${tag}）：spawn错误=${spawnError || '无'} 退出码=${child.exitCode ?? '仍在运行'}`
        )
        return ok
      }

      // ① -File：脚本落盘可审计，正常情况下走这条
      let started = await attempt(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], '-File')
      if (!started) {
        // ② -EncodedCommand：不读脚本文件，绕开脚本文件层面的限制
        started = await attempt(
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          '-EncodedCommand'
        )
      }
      if (!started) {
        const message = '更新脚本没有启动（PowerShell 未能运行或被安全策略拦截）'
        log.append('error', 'update', `增量更新未能启动：${message}；证据：${collectPatchEvidence(scriptPath, logFile, stderrFile)}`)
        /*
         * 自愈（v0.2.17）：记下「这台机器上补丁方式起不来」。
         * 下次用户再点「下载更新」时直接改用完整安装包，不用再撞一次同样的墙 ——
         * 用户的这台机器就出现过这种情况（补丁能下能校验，但脚本起不来）。
         */
        store.set(PATCH_BLOCKED_KEY, true)
        setState({ phase: 'failed', message, reason: 'apply' })
        try {
          unlinkSync(join(updatesDir(), PENDING_MARKER))
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          message: `${message}。已记下：下次点「下载更新」会直接改用完整安装包（也可现在点「打开 Releases 页面」手动下载）`
        }
      }

      log.append('info', 'update', `已启动增量更新：${stage} → ${installDir}（脚本 ${scriptPath}），本进程即将退出`)
      setState({ phase: 'installing', file })
      setTimeout(() => app.quit(), 1200)
      return { ok: true, message: '增量更新已开始，应用会在覆盖完成后自动重新打开' }
    }

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

/**
 * 启动时检查「上次增量更新是否走完」（v0.2.10）。
 *
 * 辅助进程成功覆盖后会删掉标记文件；如果它还在这儿，说明上次中途失败了
 * （被杀软拦、进程被结束、机器断电）。这时安装目录可能是新旧混装 —— 应用照样能启动
 * （实测完整性哈希不匹配也不影响启动），但要给用户一个明确说法和出口：
 * 把结论写进更新状态，用户在「设置 → 软件更新」里能直接看到「更新未完成」并重新下载，
 * 而不是一直看到「有新版本」却怎么点都升不上去。
 */
export function checkPendingUpdate(): { pending: boolean; message?: string } {
  const marker = join(updatesDir(), PENDING_MARKER)
  if (!existsSync(marker)) return { pending: false }
  let when = ''
  try {
    const raw = JSON.parse(readFileSync(marker, 'utf8')) as { startedAt?: string }
    when = raw.startedAt ? `（开始于 ${raw.startedAt}）` : ''
  } catch {
    /* ignore */
  }
  const message = `上次增量更新未完成${when}。可以再点一次「下载更新」重试；若反复失败，请用「打开 Releases 页面」下载完整安装包。`
  log.append('warn', 'update', message)
  setState({ phase: 'failed', message, reason: 'apply' })
  return { pending: true, message }
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
  // 顺手清掉过期的更新下载（安装包 200MB 一个，留着纯占地方）
  setTimeout(() => cleanupUpdatesDir(), 12000)
  // 重要更新的强提醒（用户要求：重要更新要在启动后弹窗提醒）
  setTimeout(() => void notifyImportantUpdate(), 14000)
}

/** 用户点过「稍后」的版本号（存在 store 里，重启后仍然不打扰同一版本） */
const SNOOZE_KEY = 'updateImportantSnoozed'

/**
 * 发现**重要更新**时弹窗强提醒（v0.2.12）。
 *
 * 为什么用弹窗而不是通知中心/气泡：用户的原话是「十分重要的更新都要在应用启动后
 * **弹窗强烈提醒**」—— 这次更新本身就属于这类（安装器/数据保护那批修复）。
 * 但也不能变成每 8 秒骚扰一次：同一个版本点过「稍后」就一直安静到下次版本变化，
 * 而且**登录/启动时只提醒一次**（这个函数只在启动后调用一次）。
 */
export async function notifyImportantUpdate(): Promise<void> {
  try {
    const info = await checkUpdate(false)
    if (!info.hasUpdate || !info.important) return
    if (store.get<string>(SNOOZE_KEY, '') === info.latest) {
      log.append('info', 'update', `重要版本 ${info.latest} 已被用户标记「稍后」，本次不再提醒`)
      return
    }
    log.append('info', 'update', `发现重要更新 ${info.latest}，向主窗口弹强提醒`)
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      try {
        w.webContents.send(CH.evUpdateImportant, info)
      } catch {
        /* 单个窗口发送失败不影响其它窗口 */
      }
    }
  } catch (err) {
    log.append('warn', 'update', `重要更新提醒失败: ${String((err as Error)?.message ?? err)}`)
  }
}

/** 重要更新弹窗里点「稍后」：记下版本号，本次启动不再打扰 */
export function snoozeImportantUpdate(version: string): void {
  store.set(SNOOZE_KEY, version)
  log.append('info', 'update', `用户选择稍后更新到 ${version}（下次启动仍会提醒）`)
}

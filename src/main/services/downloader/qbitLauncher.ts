import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import { dialog } from 'electron'
import type { QbitConfig, QbitStatus } from '@shared/types'
import { log } from '../../log'
import { getSettings } from '../../net'
import { store } from '../../store'
import { focusedOrMain } from '../../window'
import { qbit } from './qbit'

/**
 * 外部 qBittorrent 的「启动与授权」。
 *
 * 为什么要有这一层：外部 qb 不归应用管，但它没在跑的时候任务一个也下不动。
 * 产品要求是**不能静默启动**（那是用户自己的程序）也不能每次下载都问，
 * 所以规则是：
 *   1. qb 已经在跑（WebUI 能答话）→ 什么都不问，直接用；
 *   2. 没在跑 → 弹一次授权框（可勾「每次下载前都询问」）；
 *      用户点「启动」→ 记住授权，之后不再问；勾了每次询问 → 每次都问；
 *   3. 用户拒绝 → 双下载器模式自动改用内置 aria2，仅 qb 模式则明确报错。
 *
 * 便携版注意：用户给的路径可能是 `qBittorrentPortable.exe`（PortableApps 启动器，它拉起真正的
 * qbittorrent.exe 后自己就退出了），所以「启动成功」的判据是 **WebUI 就绪**，不是进程还活着。
 */

/** 启动后等待 WebUI 就绪的上限：qb 冷启动（尤其便携版要解压）实测要十几秒，45 秒足够且不会无限等 */
const READY_TIMEOUT_MS = 45000
/** 用户拒绝后的一段时间内不再追问（批量确认下载时是一串 add()，否则会一个任务问一次） */
let suppressAskUntil = 0

export interface QbitExe {
  path: string
  exists: boolean
  source: 'setting' | 'auto' | 'none'
}

function isQbitExe(p: string): boolean {
  return /qBittorrent(?:Portable)?\.exe$/i.test(p)
}

/** 程序路径：优先设置里填的；留空时试几个常见安装位置（便携版必然要用户自己填） */
export function resolveQbitExe(): QbitExe {
  const set = getSettings().downloader.qbit.exePath?.trim() ?? ''
  if (set) return { path: set, exists: existsSync(set), source: 'setting' }
  const candidates = [
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'qBittorrent', 'qbittorrent.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'qBittorrent', 'qbittorrent.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'qBittorrent', 'qbittorrent.exe')
  ].filter((p) => p && isQbitExe(p))
  for (const p of candidates) if (existsSync(p)) return { path: p, exists: true, source: 'auto' }
  return { path: '', exists: false, source: 'none' }
}

/** 写回 qb 设置（授权状态 / 每次询问开关由这里统一落盘） */
export function patchQbitConfig(patch: Partial<QbitConfig>): QbitConfig {
  const cur = store.get<{ downloader?: { qbit?: Partial<QbitConfig> } }>('settings', {})
  const next = { ...(cur.downloader?.qbit ?? {}), ...patch }
  store.set('settings', { ...cur, downloader: { ...(cur.downloader ?? {}), qbit: next } })
  return next as QbitConfig
}

/** qb 是否已经可用（WebUI 能答话即算） */
export async function qbitReady(): Promise<{ ok: boolean; error?: string }> {
  const ping = await qbit.ping()
  return ping.ok ? { ok: true } : { ok: false, error: ping.error }
}

/**
 * 探测常见 WebUI 端口。
 *
 * 实测（用户这台机器）：qBittorrent 安装时若 8080 已被占用会自动改用 8081，
 * 而设置里默认写的是 8080 —— 用户看到的就是「连接失败」但 qb 明明开着。
 * 连不上时顺手扫一遍常见端口，界面就能提示「检测到 127.0.0.1:8081」，一键改对。
 */
export async function detectQbitPorts(): Promise<number[]> {
  const ports = [8080, 8081, 8085, 8090, 8888, 9090]
  const hits: number[] = []
  await Promise.all(
    ports.map(async (p) => {
      try {
        const res = await axios.get(`http://127.0.0.1:${p}/api/v2/app/version`, {
          timeout: 1200,
          headers: { Referer: `http://127.0.0.1:${p}` },
          validateStatus: () => true
        })
        // 只有返回 qb 版本号那种 `v5.2.1` 的才算命中，否则同端口的其它服务会被误认
        if (res.status < 400 && /^v?\d+\.\d+/.test(String(res.data))) hits.push(p)
      } catch {
        /* 端口没人监听：正常情况，忽略 */
      }
    })
  )
  return hits.sort((a, b) => a - b)
}

/** 设置页要的完整状态：能连吗、哪个版本、路径对不对、要不要问用户 */
export async function qbitStatus(): Promise<QbitStatus> {
  const q = getSettings().downloader.qbit
  const exe = resolveQbitExe()
  const ping = await qbit.ping()
  const detectedPorts = ping.ok ? [] : await detectQbitPorts()
  return {
    reachable: ping.ok,
    url: q.url,
    version: ping.version,
    webapiVersion: ping.webapiVersion,
    exePath: exe.path,
    exeExists: exe.exists,
    exeSource: exe.source,
    launchAuthorized: q.launchAuthorized === true,
    askBeforeLaunch: q.askBeforeLaunch === true,
    detectedPorts,
    error: ping.error
  }
}

/** 拉起 qb 并等 WebUI 就绪 */
export async function launchQbitAndWait(): Promise<{ ok: boolean; message: string }> {
  const exe = resolveQbitExe()
  if (!exe.exists) {
    return {
      ok: false,
      message: exe.path
        ? `qBittorrent 程序路径不存在：${exe.path}（请在「设置 → 下载器配置」里重新选择）`
        : '还没有配置 qBittorrent 程序路径，无法启动。请在「设置 → 下载器配置」里选择 qBittorrent 程序（便携版选 qBittorrentPortable.exe）'
    }
  }
  try {
    // detached + unref：qb 是用户自己的程序，应用退出后它应当继续运行
    const child = spawn(exe.path, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    log.append('info', 'download', `已启动 qBittorrent: ${exe.path}`)
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    log.append('error', 'download', `启动 qBittorrent 失败: ${msg}`)
    return { ok: false, message: `启动 qBittorrent 失败：${msg}` }
  }

  // 便携版启动器会立刻退出，所以这里只认 WebUI
  return waitForQbitReady(READY_TIMEOUT_MS)
}

/** 等 WebUI 就绪（每 1 秒探一次），超时返回中文原因 */
async function waitForQbitReady(timeoutMs: number, hint = ''): Promise<{ ok: boolean; message: string }> {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    const ping = await qbit.ping()
    if (ping.ok) {
      return {
        ok: true,
        message: `qBittorrent ${ping.version ?? ''} 已就绪（WebUI ${getSettings().downloader.qbit.url}）`.trim()
      }
    }
    lastErr = ping.error ?? ''
    await new Promise((r) => setTimeout(r, 1000))
  }
  return {
    ok: false,
    message:
      `${hint}等 qBittorrent 的 WebUI 就绪超时（${timeoutMs / 1000} 秒）：请确认 qb 里已勾选「工具 → 选项 → WebUI → 启用 Web 用户界面」，` +
      `且端口与设置里的地址一致（当前 ${getSettings().downloader.qbit.url}）。${lastErr ? `最近一次探测：${lastErr}` : ''}`
  }
}

/**
 * 弹一次授权框。返回用户的选择。
 * 用系统对话框：它由主进程直接抛给用户，任何入口（订阅确认下载 / 详情页下载 / 重试）都能覆盖到。
 */
async function askLaunchPermission(
  exePath: string,
  reason: string | undefined,
  dual: boolean
): Promise<{ choice: 'launch' | 'manual' | 'cancel'; askEveryTime: boolean }> {
  const buttons = dual
    ? ['启动 qBittorrent', '我自己启动', '这次改用内置 aria2']
    : ['启动 qBittorrent', '我自己启动', '取消本次下载']
  const win = focusedOrMain()
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    title: '启动 qBittorrent',
    message: '下载器选择了 qBittorrent，但它当前没有运行。',
    detail:
      `程序：${exePath}\n` +
      `WebUI：${getSettings().downloader.qbit.url}\n\n` +
      '允许 Sakana 现在启动它吗？启动后会等 WebUI 就绪再开始下载。\n' +
      (reason ? `（最近一次探测：${reason}）` : ''),
    buttons,
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    checkboxLabel: '每次下载前都询问我',
    checkboxChecked: getSettings().downloader.qbit.askBeforeLaunch === true
  }
  const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  const askEveryTime = !!res.checkboxChecked
  if (res.response === 0) return { choice: 'launch', askEveryTime }
  if (res.response === 1) return { choice: 'manual', askEveryTime }
  return { choice: 'cancel', askEveryTime }
}

export interface EnsureQbitResult {
  /** 最终使用的引擎（双下载器模式下可能回退到 aria2） */
  engine: 'qbit' | 'aria2'
  /** 回退/启动的说明，写进日志与界面提示 */
  note: string
}

/**
 * 下载前确保 qb 可用（必要时征求许可并启动）。双下载器模式下不可用则回退 aria2；
 * 仅 qb 模式则抛出**中文可读**的错误（界面直接 toast）。
 */
export async function ensureQbitForDownload(): Promise<EnsureQbitResult> {
  const settings = getSettings()
  const dual = settings.downloader.dual
  const fallback = (why: string): EnsureQbitResult => {
    if (dual) {
      log.append('warn', 'download', `qBittorrent 不可用（${why}），本任务改用内置 aria2`)
      return { engine: 'aria2', note: `qBittorrent 不可用，已改用内置 aria2（${why}）` }
    }
    throw new Error(why)
  }

  const ping = await qbit.ping()
  if (ping.ok) return { engine: 'qbit', note: '' }

  const exe = resolveQbitExe()
  if (!exe.exists) {
    return fallback(
      exe.path
        ? `qBittorrent 没在运行，且配置的程序路径不存在：${exe.path}`
        : 'qBittorrent 没在运行，且没有配置程序路径（设置 → 下载器配置 → qBittorrent 程序路径；便携版请选 qBittorrentPortable.exe）'
    )
  }

  const q = settings.downloader.qbit
  const suppressed = Date.now() < suppressAskUntil
  const needAsk = q.askBeforeLaunch === true || !q.launchAuthorized
  if (needAsk && !suppressed) {
    const ans = await askLaunchPermission(exe.path, ping.error, dual)
    // 记住授权状态与「每次询问」开关（用户的选择必须落盘，否则下次又弹）
    patchQbitConfig({ askBeforeLaunch: ans.askEveryTime, ...(ans.choice === 'launch' ? { launchAuthorized: true } : {}) })
    if (ans.choice === 'manual') {
      // 用户选了「我自己启动」：等他手动把 qb 打开（最多 30 秒），而不是立刻判失败
      const waited = await waitForQbitReady(30_000, '选择了自己启动 qBittorrent，但')
      if (waited.ok) return { engine: 'qbit', note: waited.message }
      suppressAskUntil = Date.now() + 60_000
      return fallback('你选择了自己启动 qBittorrent，但 30 秒内它的 WebUI 还没就绪')
    }
    if (ans.choice === 'cancel') {
      suppressAskUntil = Date.now() + 60_000
      return fallback('用户取消了本次下载（未允许启动 qBittorrent）')
    }
  } else if (!q.launchAuthorized) {
    // 被 60 秒内的拒绝压住了：不再打扰，直接回退/报错
    return fallback('qBittorrent 没在运行（刚刚已询问过，暂不重复打扰）')
  }

  const launched = await launchQbitAndWait()
  if (!launched.ok) {
    suppressAskUntil = Date.now() + 60_000
    return fallback(launched.message)
  }
  return { engine: 'qbit', note: launched.message }
}

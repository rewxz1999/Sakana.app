import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SaveDirsInfo } from '@shared/api'
import { log } from '../log'
import { store } from '../store'
import { aria2 } from './downloader/aria2'
import { allowMediaRoot } from './media'
import { galToolsGet, galToolsSet } from './galgameTools'
import { dataPaths } from './paths'

type SaveSettings = { downloadDir?: string; screenshotDir?: string }

function getSaveSettings(): SaveSettings {
  return store.get<SaveSettings>('settings', {})
}

function patchSaveSettings(patch: SaveSettings): void {
  store.set('settings', { ...getSaveSettings(), ...patch })
}

/**
 * 自动创建保存文件夹（方案：设置页「文件保存配置」）。
 *
 * v0.2.9 最后更新（用户要求）：默认保存位置改到**安装目录**下 ——
 * `下载` → `<安装目录>/downloads`、番剧截图 → `<安装目录>/screenshots`、
 * galgame 截图 → `<安装目录>/galgame-screenshots`，
 * 而不是过去那个 `userData/saves/...`（哪怕 userData 现在也在安装目录里，
 * 少一层 `data/userData/saves` 用户更容易自己找到文件）。
 * 只影响**默认值**：用户已经显式指定过目录时一律尊重用户设置。
 * 应该在 app ready 且 store.init() 之后调用一次（ipc.ts 中）。
 */
export function ensureSaveDirs(): SaveDirsInfo {
  const p = dataPaths()
  const baseDir = p.root
  mkdirSync(baseDir, { recursive: true })

  const s = getSaveSettings()
  const downloadDir = s.downloadDir || p.downloads
  const screenshotDir = s.screenshotDir || p.screenshots

  const patch: SaveSettings = {}
  if (!s.downloadDir) patch.downloadDir = downloadDir
  if (!s.screenshotDir) patch.screenshotDir = screenshotDir
  if (Object.keys(patch).length > 0) patchSaveSettings(patch)

  mkdirSync(downloadDir, { recursive: true })
  mkdirSync(screenshotDir, { recursive: true })

  const gal = galToolsGet()
  const galDir = gal.dir || p.galgameShots
  if (!gal.dir) galToolsSet({ dir: galDir })
  mkdirSync(galDir, { recursive: true })

  return { baseDir, downloadDir, screenshotDir, galDir }
}

/** 返回当前（已回填后的）保存目录信息，不修改存储。 */
export function saveDirsInfo(): SaveDirsInfo {
  const p = dataPaths()
  const baseDir = p.root
  const s = getSaveSettings()
  const gal = galToolsGet()
  return {
    baseDir,
    downloadDir: s.downloadDir || p.downloads,
    screenshotDir: s.screenshotDir || p.screenshots,
    galDir: gal.dir || p.galgameShots
  }
}

/**
 * 修改保存目录并**立即生效**（v0.2.4）。
 *
 * 过去设置页只是把值写进 store，运行中的组件不一定重新读取：
 * 下载器（aria2 的 `--dir` 是全局选项）会继续往旧目录写，
 * 媒体协议的白名单也没包含新目录，表现为「改了保存位置但文件还在老地方」。
 * 这里统一做三件事：建目录 → 写入设置 → 通知在线组件刷新。
 */
export function setSaveDirs(patch: Partial<SaveDirsInfo>): SaveDirsInfo {
  const keys: (keyof SaveDirsInfo)[] = ['downloadDir', 'screenshotDir', 'galDir']
  const next: SaveSettings = {}
  for (const k of keys) {
    const v = patch[k]
    if (typeof v !== 'string' || !v.trim()) continue
    const dir = v.trim()
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      throw new Error(`目录不可用：${dir}（${String((err as Error)?.message ?? err)}）`)
    }
    if (k === 'downloadDir') next.downloadDir = dir
    if (k === 'screenshotDir') next.screenshotDir = dir
    if (k === 'galDir') galToolsSet({ dir })
    // 新目录要立刻加进自定义协议白名单，否则列表/播放会 403
    allowMediaRoot(dir)
  }
  if (Object.keys(next).length > 0) patchSaveSettings(next)

  // 下载中：把新目录推给运行中的 aria2（失败只记日志，不影响设置已保存）
  void aria2.refreshDir().catch((err) => {
    log.append('warn', 'save-dirs', `刷新 aria2 下载目录失败: ${String((err as Error)?.message ?? err)}`)
  })

  const info = saveDirsInfo()
  log.append(
    'info',
    'save-dirs',
    `保存目录已更新：下载=${info.downloadDir} 截图=${info.screenshotDir} galgame=${info.galDir}`
  )
  return info
}

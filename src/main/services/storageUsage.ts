import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { StorageBreakdown } from '@shared/api'
import { cacheRoot } from './cacheRoot'
import { downloadRoot } from './downloader/manager'
import { unpackRootDir } from './galUnpack'
import { saveDirsInfo } from './saveDirs'

/**
 * 各类存储占用（V1.5.4）。
 *
 * 用户要求：缓存设置里除了「本地缓存数据库」的图片/信息/列表，还要能看到
 * 下载的番剧、番剧截图、galgame 截图、galgame 解包数据与应用运行缓存各占多少。
 *
 * 为什么放在主进程：这些目录分别来自 saveDirs / 下载器 / galgame 解包 / cacheRoot，
 * 渲染层既拿不到完整路径，也不该为了统计去递归扫盘（那会卡住 UI 线程）。
 *
 * 为什么异步：下载目录可能有几千个视频文件，同步扫会卡住整个主进程（IPC/播放都受影响）。
 * 结果缓存 30 秒：用户连续点「刷新」不会反复扫同一个目录。
 */

interface CacheEntry {
  at: number
  value: StorageBreakdown
}

let cached: CacheEntry | null = null

/** 递归统计一个目录的字节数（目录不存在/无权限都返回 0） */
async function dirBytes(dir: string): Promise<number> {
  if (!dir) return 0
  let total = 0
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        total += await dirBytes(full)
      } else if (entry.isFile()) {
        const st = await fs.stat(full)
        total += st.size
      }
    } catch {
      /* 单个文件/目录读不到就跳过，不影响整体统计 */
    }
  }
  return total
}

async function sumDirs(dirs: string[]): Promise<number> {
  let total = 0
  for (const dir of dirs) total += await dirBytes(dir)
  return total
}

export async function storageBreakdown(force = false): Promise<StorageBreakdown> {
  const now = Date.now()
  if (!force && cached && now - cached.at < 30_000) return cached.value
  const dirs = saveDirsInfo()
  const userData = app.getPath('userData')
  /*
   * 运行缓存 = 临时媒体（边下边播）+ 应用临时目录 + Chromium 自带缓存。
   * 这几项都是"跑起来就会长、关掉也不心疼"的东西；和业务缓存（图片/条目）分开展示，
   * 用户才知道清哪个才能真正腾出空间。
   */
  const runtimeDirs = [
    join(cacheRoot(), 'tmp-media'),
    join(cacheRoot(), 'danmaku'),
    join(userData, 'tmp'),
    join(userData, 'Cache'),
    join(userData, 'Code Cache'),
    join(userData, 'GPUCache')
  ]
  const [downloads, screenshots, galgameShots, galgameUnpack, runtime, cacheRootBytes] = await Promise.all([
    dirBytes(downloadRoot()),
    dirBytes(dirs.screenshotDir),
    dirBytes(dirs.galDir),
    dirBytes(unpackRootDir()),
    sumDirs(runtimeDirs),
    dirBytes(cacheRoot())
  ])
  const value: StorageBreakdown = {
    downloads,
    screenshots,
    galgameShots,
    galgameUnpack,
    runtime,
    cacheRoot: cacheRootBytes,
    total: downloads + screenshots + galgameShots + galgameUnpack + runtime,
    measuredAt: now,
    paths: {
      downloads: downloadRoot(),
      screenshots: dirs.screenshotDir,
      galgameShots: dirs.galDir,
      galgameUnpack: unpackRootDir(),
      runtime: join(cacheRoot(), 'tmp-media'),
      cacheRoot: cacheRoot()
    }
  }
  cached = { at: now, value }
  return value
}

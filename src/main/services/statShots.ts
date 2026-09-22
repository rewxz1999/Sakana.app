import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { StatEntry, StatShotDirInfo, StatShotFile } from '@shared/types'
import { allowMediaRoot } from './media'
import { statShotPaths } from './statStore'

/**
 * 详情窗口的「剧照」图库：直接读番剧截图目录（默认截图目录），
 * 用户在应用内浏览、挑图、一键加为剧照，**不复制文件**（剧照只存路径）。
 *
 * 目录规则与播放器截图保持一致（见 ipc.ts 的 snapshotPath）：
 *   `<截图目录>/<番剧名>图片/<番剧名>_<集数>_<分.秒>.png`
 * 但用户也可能手动把图丢在截图根目录，所以：
 * - 优先列该番剧的 `<番剧名>图片` 子目录；
 * - 子目录里为空时退回列根目录里的图片（并在返回值里如实标出 dirExists=false）。
 */

const SHOT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif'])
/** 一次最多列多少张（缩略图都是本地文件，几百张也不至于卡，但没必要全塞给界面） */
const MAX_SHOTS = 200

function listImagesIn(dir: string, limit: number): StatShotFile[] {
  if (!dir || !existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: StatShotFile[] = []
  for (const name of names) {
    const dot = name.lastIndexOf('.')
    if (dot < 0 || !SHOT_EXTS.has(name.slice(dot).toLowerCase())) continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      out.push({ path: full, name, mtime: st.mtimeMs, size: st.size })
    } catch {
      /* 单张读失败跳过，不影响其余截图 */
    }
  }
  // 新截图在前
  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, limit)
}

/** 列某条目的截图候选（子目录优先，空则退回根目录） */
export function listStatShots(entry: Pick<StatEntry, 'name' | 'nameCn'>): StatShotDirInfo {
  const { root, dir } = statShotPaths(entry)
  const dirExists = existsSync(dir)
  let files = dirExists ? listImagesIn(dir, MAX_SHOTS) : []
  if (files.length === 0 && root !== dir) files = listImagesIn(root, MAX_SHOTS)
  return { dir, root, dirExists, limit: MAX_SHOTS, files }
}

/** 打开番剧截图所在目录（子目录不存在时打开根目录，避免「打开没反应」） */
export function statShotsDirToOpen(entry: Pick<StatEntry, 'name' | 'nameCn'>): string {
  const { root, dir } = statShotPaths(entry)
  if (dir && existsSync(dir)) {
    allowMediaRoot(dir)
    return dir
  }
  // 根目录也是图片协议的白名单根（media.ts 已注册），这里再确认一次
  allowMediaRoot(root)
  return root
}

import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log'
import { store } from '../store'
import { dataPaths } from './paths'

/**
 * 缓存根目录（V1.5.1 统一）—— **一处定义，四处复用**。
 *
 * 为什么单独拆一个模块：这个目录以前有两套事实来源，
 *   · `settingsExt.cacheRoot()` → `<数据根>/cache`（设置页的「缓存占用」统计的是它）；
 *   · `bangumi.ts` / `media.ts` → `app.getPath('userData')/cache`（真正写图片与条目 JSON 的地方）。
 * 两者在默认配置下**不是同一个目录**（userData 已经被重定向到 `<数据根>/data/userData`），
 * 于是出现两个真实问题：
 *   1. 设置页显示的缓存大小远小于实际占用（图片和条目 JSON 根本不在统计范围内）；
 *   2. 设置页点「清除本地缓存数据」清不掉真正的图片/条目缓存，用户以为清了、其实一点没动。
 * 现在三处（图片、条目 JSON、缓存数据库、设置页统计）全部走本文件，路径不可能再分叉。
 *
 * 迁移：老安装的图片与条目缓存留在 `<userData>/cache/{img,bangumi}`（本机实测 842MB）。
 * 不搬的话升级后等于全部缓存失效 —— 首屏要重拉几百张图，正好是用户最反感的"更新后变慢"。
 * 所以启动时**就地 rename** 进新根目录（同一分区，瞬间完成），跨分区/被占用就跳过并记日志。
 */

type CacheSettings = { cacheDir?: string }

function settings(): CacheSettings {
  return store.get<CacheSettings>('settings', {})
}

/** 是否使用用户自定义缓存目录（false = 默认「数据根/cache」） */
export function cacheRootIsCustom(): boolean {
  return (settings().cacheDir ?? '').trim().length > 0
}

/** 缓存根目录：settings.cacheDir 优先，留空回退安装目录下的 cache */
export function cacheRoot(): string {
  const custom = (settings().cacheDir ?? '').trim()
  return custom || dataPaths().cache
}

/** 老版本真正写缓存的位置（迁移用；只在默认配置下参与搬迁） */
function legacyCacheRoot(): string {
  return join(app.getPath('userData'), 'cache')
}

/**
 * 把老目录里的子项搬进新目录（目标已存在同名项就跳过：宁可留着旧的，也不能覆盖新数据）。
 * 返回搬动的顶层项数量。
 */
function moveInto(from: string, to: string): number {
  if (!existsSync(from)) return 0
  try {
    mkdirSync(to, { recursive: true })
  } catch {
    return 0
  }
  let moved = 0
  let names: string[] = []
  try {
    names = readdirSync(from)
  } catch {
    return 0
  }
  for (const name of names) {
    const src = join(from, name)
    const dst = join(to, name)
    if (existsSync(dst)) continue
    try {
      renameSync(src, dst)
      moved++
    } catch {
      /* 跨分区或被占用：跳过，下次启动再试（缓存不是关键数据，丢不了功能） */
    }
  }
  return moved
}

/**
 * 建立缓存目录骨架，并把老位置的数据搬过来。启动早期调用一次（bangumi/media 写缓存之前）。
 *
 * 只搬 img / bangumi 两个目录：其它（galgame-covers / tmp-media）一直就在数据根下，没有历史包袱。
 * 用户已经显式设置过 cacheDir 时不搬 —— 那是他自己的选择，乱搬只会把他配置好的目录搞乱。
 */
export function ensureCacheLayout(): { root: string; migrated: number } {
  const root = cacheRoot()
  for (const dir of [root, join(root, 'img'), join(root, 'bangumi')]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* 不可写时由具体写入方报错，这里不致命 */
    }
  }
  let migrated = 0
  if (!cacheRootIsCustom()) {
    const legacy = legacyCacheRoot()
    if (legacy !== root) {
      migrated += moveInto(join(legacy, 'img'), join(root, 'img'))
      migrated += moveInto(join(legacy, 'bangumi'), join(root, 'bangumi'))
      if (migrated > 0) {
        log.append(
          'info',
          'cache',
          `缓存目录已统一到数据根：从 userData/cache 搬入 ${migrated} 项（图片/条目 JSON）`
        )
      }
    }
  }
  return { root, migrated }
}

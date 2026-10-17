import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DanmakuComment, DanmakuLibraryItem } from '@shared/types'
import { log } from '../log'
import { parseDanmakuText } from './danmakuLibrary'
import {
  libraryDir,
  libraryRelPath,
  lookupLibraryBySource,
  readLibraryComments,
  saveToLibrary
} from './danmakuLibrary'

/**
 * 弹幕本地缓存层（V1.2 弹幕重构的第三层：`fetcher → **缓存** → 集成器`）。
 *
 * ## 目录与命名（用户逐字要求「文件夹名要附带弹幕源名称」）
 *   `<缓存根>/弹幕/<番剧名>/第01集-巴哈姆特动画疯.xml`
 *
 * 为什么这样命名：
 *   · 番剧名做目录：用户打开缓存目录能按番剧找到，删一整部只要删一个文件夹；
 *   · 文件名带「第几集 + 来源名」：同一集从巴哈与弹幕盒子会各存一份，**不能互相覆盖**，
 *     而且一眼能看出"这一集有哪些源已经缓存过"；
 *   · 不加哈希：路径由「番剧 + 集 + 源」唯一决定 → 命中缓存时不需要查索引、不需要遍历目录，
 *     直接拼路径 stat 一次即可。索引只是给设置页列条数用的，丢了也能重建。
 *
 * ## 命中就直接用，不再请求
 * `readCachedSource` 只在**这个源**有文件时返回数据；播放器第一段加载会为每个启用的源各查一次。
 * 这也是用户要的"第二次进同一集不应出现网络请求"：第二段加载看到 `fromCache` 就跳过 fetcher。
 */

export interface CachedDanmaku {
  comments: DanmakuComment[]
  item: DanmakuLibraryItem
  /** 命中的库内相对路径（日志/界面展示用） */
  relPath: string
}

export interface CacheStats {
  hits: number
  misses: number
  writes: number
  /** 最近一次命中的相对路径（自检/详情面板用） */
  lastHit: string
  /** 最近一次写入的相对路径 */
  lastWrite: string
}

const stats: CacheStats = { hits: 0, misses: 0, writes: 0, lastHit: '', lastWrite: '' }

/** 缓存根目录（用户在设置里改的就是它） */
export function danmakuCacheRoot(): string {
  return libraryDir()
}

/** 某一集的缓存绝对路径（文件名带来源名） */
export function danmakuCacheFile(title: string, episode: number, sourceName: string): string {
  return join(danmakuCacheRoot(), libraryRelPath(title, episode, sourceName))
}

/**
 * 读指定源的缓存。
 *
 * 两条路径：
 *   1. 直接按命名规则拼路径（最常见：番剧名没变）——一次 `existsSync` 就够，最快；
 *   2. 拼出来的路径不存在时退回索引做归一化匹配（番剧名带副标题/改过名的情况）。
 */
export function readCachedSource(title: string, episode: number, sourceName: string): CachedDanmaku | null {
  if (!String(title ?? '').trim() || !String(sourceName ?? '').trim()) return null
  const rel = libraryRelPath(title, episode, sourceName)
  const full = join(danmakuCacheRoot(), rel)
  try {
    if (existsSync(full)) {
      const text = readFileSync(full, 'utf-8')
      const parsed = parseDanmakuText(text)
      if (parsed.comments.length > 0) {
        stats.hits++
        stats.lastHit = rel.replace(/\\/g, '/')
        log.append('info', 'danmaku', `本地缓存命中：${rel.replace(/\\/g, '/')}（${parsed.comments.length} 条，未发网络请求）`)
        return {
          comments: parsed.comments,
          item: {
            id: rel.replace(/\\/g, '/'),
            title,
            episode: Number(episode) || 0,
            sourceId: '',
            sourceName,
            file: rel,
            bytes: Buffer.byteLength(text, 'utf-8'),
            count: parsed.comments.length,
            format: parsed.format,
            origin: '本地缓存',
            at: Date.now()
          },
          relPath: rel
        }
      }
    }
    // 直接路径没命中：用索引做归一化匹配（同名不同写法 / 旧命名迁移后的文件）
    const item = lookupLibraryBySource(title, episode, sourceName)
    if (item) {
      const comments = readLibraryComments(item)
      if (comments.length > 0) {
        stats.hits++
        stats.lastHit = item.file.replace(/\\/g, '/')
        log.append('info', 'danmaku', `本地缓存命中（索引）：${item.file.replace(/\\/g, '/')}（${comments.length} 条，未发网络请求）`)
        return { comments, item, relPath: item.file }
      }
    }
    stats.misses++
    return null
  } catch (err) {
    stats.misses++
    log.append('warn', 'danmaku', `读本地缓存失败（${rel}）：${String((err as Error)?.message ?? err)}`)
    return null
  }
}

/** 把一批弹幕写进缓存（每个源一份文件；同源同集覆盖旧文件） */
export function writeCachedSource(input: {
  title: string
  episode: number
  sourceId: string
  sourceName: string
  origin: string
  comments: DanmakuComment[]
}): DanmakuLibraryItem | null {
  if (!Array.isArray(input.comments) || input.comments.length === 0) return null
  try {
    const item = saveToLibrary({
      title: input.title,
      episode: input.episode,
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      origin: input.origin,
      comments: input.comments
    })
    stats.writes++
    stats.lastWrite = item.file.replace(/\\/g, '/')
    log.append(
      'info',
      'danmaku',
      `弹幕已写入缓存：${item.file.replace(/\\/g, '/')}（${item.count} 条，${Math.round(item.bytes / 1024)}KB）`
    )
    return item
  } catch (err) {
    log.append('warn', 'danmaku', `写弹幕缓存失败（${input.sourceName}）：${String((err as Error)?.message ?? err)}`)
    return null
  }
}

/** 缓存计数（自检 / 详情面板：用数字证明第二次进同一集没有发请求） */
export function cacheStats(): CacheStats {
  return { ...stats }
}

export function resetCacheStats(): void {
  stats.hits = 0
  stats.misses = 0
  stats.writes = 0
  stats.lastHit = ''
  stats.lastWrite = ''
}

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { FavoriteItem, LocalLibraryEpisode, LocalLibraryItem, Subscription } from '@shared/types'
import { safeName } from '../lib/parse'
import { log } from '../log'
import { store } from '../store'
import { downloadRoot } from './downloader/manager'
import { resolveLocalTarget } from './downloader/localCleanup'
import { listVideos } from './media'

/**
 * 本地库（V1.5.1）：以「番剧视频资源保存文件夹」为准，扫出本机已经下载的番剧与集数。
 *
 * 用户原话：「新增的分区为以番剧视频资源保存文件夹为基础的本地库。只显示本地下载的番剧，
 * 并且显示我们下载了那些集数。」
 *
 * 为什么在主进程扫：
 *   · 下载根目录、`safeName()` 的目录命名规则、集数解析（`parseEpisode`）全在主进程，
 *     渲染层既拿不到也不该复制一份（复制就会两边规则打架，出现"下载了但本地库不显示"）；
 *   · 只读文件系统，不产生任何网络请求 —— 断网也能用，这正是用户要一个"本地库"的意义。
 *
 * 与「在线库」的关系：同一个文件夹可能既在收藏里、又在磁盘上。这里只负责**磁盘事实**，
 * 封面/条目 id 靠标题匹配收藏与订阅补上（有就用，没有也能正常显示与播放）。
 */

/** 标题归一化：去掉空白并小写，用于文件夹名与收藏/订阅标题的匹配 */
function titleKey(raw: string): string {
  return String(raw ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 本地库条目与收藏/订阅的匹配结果 */
interface LibraryMatch {
  cover: string
  subjectId: number | null
}

/**
 * 建立"文件夹名 → 收藏/订阅"的索引。
 *
 * 三个来源都认：
 *   · 收藏：用户最可能从在线库切过来看"我下载了没有"，封面也从这里复用（不额外下载）；
 *   · 订阅：订阅记录里有 folder（用户指定/推导的目录）与 subjectId，按目录名精确匹配；
 *   · 都没有：条目照样显示，只是没有封面与条目 id。
 */
function buildMatchIndex(): Map<string, LibraryMatch> {
  const map = new Map<string, LibraryMatch>()
  const put = (key: string, value: LibraryMatch): void => {
    const k = titleKey(key)
    if (!k || map.has(k)) return
    map.set(k, value)
  }
  // 订阅优先写入：它的 subjectId 最可信（收藏里也可能有，两者一致）
  const subs = store.get<Subscription[]>('subscriptions', [])
  for (const sub of Array.isArray(subs) ? subs : []) {
    const title = sub.nameCn || sub.name || ''
    const cover = (sub as unknown as { cover?: string }).cover ?? ''
    const match: LibraryMatch = { cover, subjectId: Number(sub.subjectId) || null }
    if (sub.folder) put(basename(sub.folder), match)
    put(title, match)
  }
  const favorites = store.get<FavoriteItem[]>('favorites', [])
  for (const fav of Array.isArray(favorites) ? favorites : []) {
    const match: LibraryMatch = { cover: fav.cover ?? '', subjectId: Number(fav.subjectId) || null }
    put(fav.nameCn || fav.name || '', match)
  }
  return map
}

/** 把目录里能播的视频整理成按集数排序的列表（解析不出集数的按文件名排在后面） */
function toEpisodes(dir: string): { episodes: LocalLibraryEpisode[]; totalBytes: number; updatedAt: number } {
  const videos = listVideos(dir)
  let totalBytes = 0
  let updatedAt = 0
  for (const video of videos) {
    totalBytes += video.size
    try {
      const st = statSync(video.path)
      updatedAt = Math.max(updatedAt, st.mtimeMs)
    } catch {
      /* 单个文件状态读不到就跳过 */
    }
  }
  const episodes: LocalLibraryEpisode[] = videos.map((v) => ({
    path: v.path,
    name: v.name,
    episode: v.episode ?? null,
    size: v.size
  }))
  episodes.sort((a, b) => {
    if (a.episode != null && b.episode != null) return a.episode - b.episode
    if (a.episode != null) return -1
    if (b.episode != null) return 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return { episodes, totalBytes, updatedAt }
}

/**
 * 扫描本地库。
 *
 * 只扫**下载根目录下的一层子目录**（下载器的目录结构就是 `<下载根>/<番剧名>/…`）：
 * 不递归到任意深度是为了避免把用户放在下载目录里的其它东西也列成一"部番"；
 * 子目录内部的嵌套（字幕组子文件夹、SP 目录等）由 `listVideos` 自己递归处理。
 */
export function scanLocalLibrary(): LocalLibraryItem[] {
  const root = downloadRoot()
  if (!existsSync(root)) return []
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch (err) {
    log.append('warn', 'local-library', `读取下载目录失败（${root}）：${String((err as Error)?.message ?? err)}`)
    return []
  }
  const matchIndex = buildMatchIndex()
  const items: LocalLibraryItem[] = []
  for (const name of names) {
    if (name.startsWith('.') || name === '__MACOSX') continue
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const { episodes, totalBytes, updatedAt } = toEpisodes(dir)
    // 没有可播视频的文件夹不算"一部番"（可能是只下到一半、或者用户自己放的别的东西）
    if (episodes.length === 0) continue
    const match = matchIndex.get(titleKey(name)) ?? matchIndex.get(titleKey(safeName(name))) ?? null
    items.push({
      title: name,
      dir,
      cover: match?.cover ?? '',
      subjectId: match?.subjectId ?? null,
      episodes,
      totalBytes,
      updatedAt
    })
  }
  // 最近下载的排前面（用户打开本地库通常是想看"刚下的那部"）
  items.sort((a, b) => b.updatedAt - a.updatedAt)
  return items
}

/**
 * 按收藏/订阅条目解析出本地目录（详情页「本地播放 → 从本地库播放」用）。
 *
 * 直接复用 `resolveLocalTarget`：下载任务记录 → 订阅 folder → 下载根+番剧名，
 * 与下载器建目录时是同一份规则，所以不会出现"下载器放这里、本地播放找那里"。
 */
export function localDirForSubject(input: {
  subjectId?: number | null
  animeTitle?: string
}): { dir: string; exists: boolean; videos: number } {
  const info = resolveLocalTarget({
    subjectId: input.subjectId ?? undefined,
    animeTitle: input.animeTitle
  })
  const exists = existsSync(info.dir)
  return {
    dir: info.dir,
    exists,
    videos: exists ? listVideos(info.dir).length : 0
  }
}

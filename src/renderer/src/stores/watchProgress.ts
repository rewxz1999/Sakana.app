import { create } from 'zustand'
import type { WatchProgressItem } from '@shared/types'
import { api } from '@/lib/api'

/**
 * 观看进度（v0.2.4）：按「来源 + 番剧条目」聚合，记录
 * - 看过哪些集（剧集列表里加深显示）
 * - 最后播放到哪一集、哪一秒（再次进入时续播）
 * - 在线播放需要的定位信息（规则 / 条目 / 线路 / 集序号），让「继续观看」能直接回到在线播放
 *
 * 存储在主进程 store 的 `watchProgress` 键；positionSec 由播放器节流上报（每 10 秒或切集时）。
 */

export type ProgressKeyInput = {
  id: string
  title: string
  source: 'online' | 'local'
}

interface ProgressState {
  items: WatchProgressItem[]
  loaded: boolean
  load: () => Promise<void>
  get: (id: string) => WatchProgressItem | undefined
  /** 记录「开始播放某集」：写入定位信息、集数、并把该集标记为已看 */
  noteEpisode: (
    base: ProgressKeyInput & {
      subjectId?: number
      cover?: string
      ruleId?: string
      ruleName?: string
      entryName?: string
      entryLink?: string
      filePath?: string
      groupIndex: number
      episodeIndex: number
      episodeName?: string
    }
  ) => void
  /** 上报播放位置（节流由调用方负责） */
  setPosition: (id: string, positionSec: number, durationSec: number) => void
  /** 已观看集数集合（键为 `${groupIndex}:${episodeIndex}`） */
  watchedSet: (id: string) => Set<string>
  remove: (id: string) => void
}

const MAX_ITEMS = 300

export function epKey(groupIndex: number, episodeIndex: number): string {
  return `${groupIndex}:${episodeIndex}`
}

/** 在线播放的稳定键：规则 + 条目链接（与番剧表 subjectId 无关，规则站点的条目才是唯一标识） */
export function onlineKey(ruleId: string, entryLink: string): string {
  return `${ruleId}::${entryLink}`
}

/** 本地播放的稳定键：文件路径 */
export function localKey(filePath: string): string {
  return `local::${filePath}`
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function persist(items: WatchProgressItem[]): void {
  if (saveTimer) clearTimeout(saveTimer)
  // 合并短时间内的多次写入（播放中每 10 秒会上报一次进度）
  saveTimer = setTimeout(() => {
    saveTimer = null
    void api.store.set('watchProgress', items)
  }, 400)
}

export const useWatchProgress = create<ProgressState>((set, get) => ({
  items: [],
  loaded: false,
  load: async () => {
    const r = await api.store.get('watchProgress')
    set({
      items: r.ok && Array.isArray(r.data) ? (r.data as WatchProgressItem[]) : [],
      loaded: true
    })
  },
  get: (id) => get().items.find((i) => i.id === id),
  noteEpisode: (base) => {
    const items = get().items
    const prev = items.find((i) => i.id === base.id)
    const key = epKey(base.groupIndex, base.episodeIndex)
    const watched = prev?.watched ?? []
    const next: WatchProgressItem = {
      ...(prev ?? { watched: [], positionSec: 0, durationSec: 0 }),
      ...base,
      watched: watched.includes(key) ? watched : [...watched, key],
      // 换集时位置归零，交给播放器随后上报真实进度
      positionSec: prev && prev.episodeIndex === base.episodeIndex ? prev.positionSec : 0,
      updatedAt: Date.now()
    }
    const list = [next, ...items.filter((i) => i.id !== base.id)].slice(0, MAX_ITEMS)
    set({ items: list })
    persist(list)
  },
  setPosition: (id, positionSec, durationSec) => {
    const items = get().items
    const idx = items.findIndex((i) => i.id === id)
    if (idx < 0) return
    const cur = items[idx]
    if (
      Math.abs(cur.positionSec - positionSec) < 1 &&
      Math.abs((cur.durationSec ?? 0) - (durationSec ?? 0)) < 1
    ) {
      return
    }
    const next = { ...cur, positionSec, durationSec, updatedAt: Date.now() }
    const list = [...items]
    list[idx] = next
    set({ items: list })
    persist(list)
  },
  watchedSet: (id) => {
    const item = get().items.find((i) => i.id === id)
    return new Set(item?.watched ?? [])
  },
  remove: (id) => {
    const list = get().items.filter((i) => i.id !== id)
    set({ items: list })
    persist(list)
  }
}))

/** 单个番剧的进度摘要（收藏卡片 / 详情页用） */
export function progressSummary(
  items: WatchProgressItem[],
  opts: { subjectId?: number; title?: string }
): { watchedCount: number; lastEpisode: number | null; percent: number; item: WatchProgressItem | null } {
  const hit = items.find(
    (i) =>
      (opts.subjectId != null && i.subjectId === opts.subjectId) ||
      (!!opts.title && i.title === opts.title)
  )
  if (!hit) return { watchedCount: 0, lastEpisode: null, percent: 0, item: null }
  const last = hit.durationSec > 0 ? Math.min(100, Math.round((hit.positionSec / hit.durationSec) * 100)) : 0
  return {
    watchedCount: hit.watched.length,
    lastEpisode: hit.episodeIndex + 1,
    percent: last,
    item: hit
  }
}

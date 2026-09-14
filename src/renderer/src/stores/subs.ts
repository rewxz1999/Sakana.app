import { create } from 'zustand'
import type { DownloadTask, SubUpdateCheck, Subscription } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from './app'

interface SubsState {
  subscriptions: Subscription[]
  downloads: DownloadTask[]
  updateChecks: SubUpdateCheck[]
  checking: boolean
  checkingIds: string[]
  loaded: boolean
  load: () => Promise<void>
  refreshDownloads: () => Promise<void>
  startDownloadsLive: () => () => void
  /** 订阅变更实时广播（主进程写入后推送） */
  startSubsLive: () => () => void
  startSubUpdatesLive: () => () => void
  checkAll: () => Promise<SubUpdateCheck[]>
  checkSub: (subId: string) => Promise<SubUpdateCheck | null>
  confirmUpdate: (sub: Subscription, check: SubUpdateCheck) => Promise<void>
  removeSubscription: (id: string) => Promise<void>
  setSubFolder: (id: string, folder: string) => Promise<void>
  markSubUpdated: (subId: string, episode: number | null, pubDate: string | null) => Promise<void>
  setStatus: (subId: string, status: Subscription['status']) => Promise<void>
}

export const useSubs = create<SubsState>((set, get) => ({
  subscriptions: [],
  downloads: [],
  updateChecks: [],
  checking: false,
  checkingIds: [],
  loaded: false,
  load: async () => {
    // 订阅数据以主进程为准（唯一写入方），这里只读取展示
    const [s, d] = await Promise.all([api.subs.list(), api.downloads.list()])
    set({
      subscriptions: s.ok ? s.data : [],
      downloads: d.ok ? d.data : [],
      loaded: true
    })
  },
  refreshDownloads: async () => {
    const r = await api.downloads.list()
    if (r.ok) set({ downloads: r.data })
  },
  startDownloadsLive: () => {
    return api.downloads.onChanged((tasks) => set({ downloads: tasks }))
  },
  /** 订阅变更广播：任何窗口/流程（含新建订阅、集数推进、删除）都会即时同步 */
  startSubsLive: () => {
    return api.subs.onChanged((subs) => set({ subscriptions: subs }))
  },
  startSubUpdatesLive: () => {
    return api.mikan.onSubUpdates((updates) => {
      set({ updateChecks: updates })
      const subs = get().subscriptions
      if (subs.length) {
        const map = new Map(updates.map((u) => [u.subId, u]))
        set({ subscriptions: subs.map((s) => (map.has(s.id) ? { ...s, status: 'waiting' as const } : s)) })
      }
      toast.info(`发现 ${updates.length} 个订阅有资源更新，请在订阅页确认下载`)
    })
  },
  checkAll: async () => {
    set({ checking: true })
    const r = await api.mikan.checkAll()
    set({ checking: false, updateChecks: r.ok ? r.data : [] })
    if (r.ok && r.data.length > 0) {
      toast.info(`发现 ${r.data.length} 个订阅有资源更新`)
    } else if (r.ok) {
      toast.success('所有订阅均为最新')
    } else {
      toast.error(r.error)
    }
    return r.ok ? r.data : []
  },
  checkSub: async (subId) => {
    set((s) => ({ checkingIds: [...s.checkingIds, subId] }))
    const r = await api.mikan.checkSub(subId)
    set((s) => ({ checkingIds: s.checkingIds.filter((id) => id !== subId) }))
    if (!r.ok) {
      toast.error(r.error)
      return null
    }
    if (r.data.newItems.length > 0) {
      const sub = get().subscriptions.find((s) => s.id === subId)
      if (sub) {
        // 只更新本地展示状态；集数推进由 confirmUpdate → 主进程落盘后广播
        set({
          subscriptions: get().subscriptions.map((s) =>
            s.id === subId ? { ...s, status: 'waiting' as const } : s
          )
        })
      }
    }
    set((s) => ({
      updateChecks: [...s.updateChecks.filter((u) => u.subId !== subId), r.data]
    }))
    return r.data
  },
  confirmUpdate: async (sub, check) => {
    const newItems = check.newItems
    if (newItems.length === 0) return
    for (const item of newItems) {
      const r = await api.downloads.add({
        subscriptionId: sub.id,
        subjectId: sub.subjectId,
        animeTitle: sub.nameCn || sub.name,
        episode: item.episode,
        group: item.group,
        name: item.title,
        cover: sub.cover,
        magnet: item.magnet ?? undefined,
        torrentUrl: item.torrentUrl ?? undefined,
        pubDate: item.pubDate
      })
      if (!r.ok) {
        toast.error(`添加下载失败: ${r.error}`)
      }
    }
    const maxEp = Math.max(...newItems.map((i) => i.episode ?? 0), sub.episode ?? 0)
    const maxPub = newItems.map((i) => new Date(i.pubDate).getTime()).filter((t) => !Number.isNaN(t)).sort((a, b) => b - a)[0]
    const latestPub = maxPub ? new Date(maxPub).toUTCString() : sub.lastPubDate
    await get().markSubUpdated(sub.id, maxEp || sub.episode, latestPub)
    toast.success(`《${sub.nameCn || sub.name}》已添加 ${newItems.length} 个下载任务`)
  },
  removeSubscription: async (id) => {
    // 写操作交给主进程（唯一写入方），结果由广播回推
    const r = await api.subs.remove(id)
    if (r.ok) set({ subscriptions: r.data })
    else toast.error(r.error)
  },
  setSubFolder: async (id, folder) => {
    const r = await api.subs.setFolder(id, folder)
    if (r.ok) set({ subscriptions: r.data })
    else toast.error(r.error)
  },
  markSubUpdated: async (subId, episode, pubDate) => {
    const r = await api.subs.markUpdated(subId, episode ?? 0, pubDate ?? '')
    if (r.ok) set({ subscriptions: r.data })
    else toast.error(r.error)
  },
  setStatus: async (subId, status) => {
    // 状态是本地展示状态，随广播一起更新即可
    set({ subscriptions: get().subscriptions.map((s) => (s.id === subId ? { ...s, status } : s)) })
  }
}))

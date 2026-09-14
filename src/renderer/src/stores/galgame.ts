import { create } from 'zustand'
import type { GalEvent, GalGame } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from './app'

interface GalState {
  games: GalGame[]
  loaded: boolean
  /** gameId -> 是否正在运行 */
  running: Record<string, boolean>
  importing: boolean
  load: () => Promise<void>
  startLive: () => () => void
  importGame: () => Promise<GalGame | null>
  removeGame: (id: string) => Promise<void>
  toggleFinished: (id: string) => Promise<void>
  launch: (id: string) => Promise<boolean>
}

export const useGal = create<GalState>((set, get) => ({
  games: [],
  loaded: false,
  running: {},
  importing: false,
  load: async () => {
    // 每次拉取列表都会收到主进程推送的“运行中”快照，先清空避免残留
    set({ running: {} })
    const r = await api.gal.list()
    set({ games: r.ok ? r.data : [], loaded: true })
  },
  startLive: () =>
    api.gal.onEvent((ev: GalEvent) => {
      if (ev.type === 'games') {
        set({ games: ev.games })
      } else if (ev.type === 'running') {
        set((s) => ({
          running: { ...s.running, [ev.gameId]: ev.running }
        }))
      }
    }),
  importGame: async () => {
    set({ importing: true })
    const r = await api.gal.import()
    set({ importing: false })
    if (!r.ok) {
      // VNDB 失败时游戏其实已用文件夹名成功导入（主进程已推送列表）
      if (r.error.startsWith('VNDB 查询失败')) {
        toast.warn('已用文件夹名导入，VNDB 信息获取失败')
      } else {
        toast.error(r.error)
      }
      await get().load()
      return get().games[0] ?? null
    }
    if (r.data) {
      toast.success(`已导入: ${r.data.title}`)
      await get().load()
    }
    return r.data
  },
  removeGame: async (id) => {
    const r = await api.gal.remove(id)
    if (r.ok) {
      toast.info('已删除启动方式')
      await get().load()
    } else {
      toast.error(r.error)
    }
  },
  toggleFinished: async (id) => {
    const r = await api.gal.toggleFinished(id)
    if (r.ok) {
      toast.success(r.data.finished ? '已标记玩完' : '已取消玩完标记')
      await get().load()
    } else {
      toast.error(r.error)
    }
  },
  launch: async (id) => {
    const r = await api.gal.launch(id)
    if (!r.ok) {
      toast.error(r.error)
      return false
    }
    set((s) => ({ running: { ...s.running, [id]: true } }))
    toast.success('游戏已启动')
    return true
  }
}))

import { create } from 'zustand'
import { DEFAULT_SETTINGS, type AppSettings, type LogEntry } from '@shared/types'
import { api } from '@/lib/api'
import { applyTheme } from '@/theme'

/** 默认主题：白蓝（原「深夜蓝」深色主题已整体替换为白蓝浅色，id 保持 midnight） */
const DEFAULT_THEME = 'midnight'

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  load: () => Promise<void>
  save: (patch: Partial<AppSettings>) => void
  saveDeep: (patch: (s: AppSettings) => AppSettings) => void
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS, theme: DEFAULT_THEME },
  loaded: false,
  load: async () => {
    const r = await api.store.get('settings')
    let next: AppSettings = DEFAULT_SETTINGS
    let storedTheme: string | undefined
    if (r.ok && r.data && typeof r.data === 'object') {
      const stored = r.data as Partial<AppSettings>
      storedTheme = typeof stored.theme === 'string' ? stored.theme : undefined
      next = {
        ...DEFAULT_SETTINGS,
        ...stored,
        proxy: { ...DEFAULT_SETTINGS.proxy, ...(stored.proxy ?? {}) },
        downloader: {
          ...DEFAULT_SETTINGS.downloader,
          ...(stored.downloader ?? {}),
          aria2: { ...DEFAULT_SETTINGS.downloader.aria2, ...(stored.downloader?.aria2 ?? {}) },
          qbit: { ...DEFAULT_SETTINGS.downloader.qbit, ...(stored.downloader?.qbit ?? {}) }
        }
      }
      // 迁移旧数据源字段（bangumiBase / bangumiMirrors）→ dataSources
      if (!stored.dataSources) {
        const mirrors =
          Array.isArray(stored.bangumiMirrors) && stored.bangumiMirrors.length > 0
            ? stored.bangumiMirrors
            : [stored.bangumiBase || DEFAULT_SETTINGS.bangumiBase]
        const main = stored.bangumiBase || mirrors[0]
        next.dataSources = { main, mirrors: [...mirrors] }
      }
    }
    // 主题默认值与迁移：
    // - 全新安装（无已存主题）默认使用白蓝（midnight）
    // - 旧版本以 midnight 保存「深夜蓝」深色主题，其 palette 现已被整体替换为白蓝浅色，
    //   id 不变即自动完成迁移，无需额外改写
    if (!storedTheme) next.theme = DEFAULT_THEME
    applyTheme(next.theme)
    set({ settings: next, loaded: true })
  },
  save: (patch) => {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    if (patch.theme) applyTheme(patch.theme)
    void api.store.set('settings', next)
  },
  saveDeep: (fn) => {
    const next = fn(get().settings)
    set({ settings: next })
    void api.store.set('settings', next)
  }
}))

// ---------------- 日志（供设置页展示 + 全局推送） ----------------

interface LogState {
  entries: LogEntry[]
  live: boolean
  load: () => Promise<void>
  clear: () => Promise<void>
  startLive: () => () => void
}

export const useLogs = create<LogState>((set, get) => ({
  entries: [],
  live: false,
  load: async () => {
    const r = await api.logs.list()
    if (r.ok) set({ entries: r.data })
  },
  clear: async () => {
    await api.logs.clear()
    set({ entries: [] })
  },
  startLive: () => {
    if (get().live) return () => {}
    set({ live: true })
    return api.logs.onEntry((entry) => {
      set((s) => ({ entries: [entry, ...s.entries].slice(0, 1000) }))
    })
  }
}))

// ---------------- 轻提示 ----------------

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error' | 'warn'
  text: string
}

interface ToastState {
  toasts: Toast[]
  push: (kind: Toast['kind'], text: string) => void
  dismiss: (id: number) => void
}

let toastSeq = 0

export const useToast = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, text) => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 3500)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

export const toast = {
  info: (text: string): void => useToast.getState().push('info', text),
  success: (text: string): void => useToast.getState().push('success', text),
  error: (text: string): void => useToast.getState().push('error', text),
  warn: (text: string): void => useToast.getState().push('warn', text)
}

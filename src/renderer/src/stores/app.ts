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

/**
 * 是否已订阅"设置被任意一方改过"的通知（v0.3.9 体检 H1）。
 * 与 library 里的 storeSubscribed 同理：这是**进程级只订阅一次**的副作用，不是界面状态。
 */
let settingsSubscribed = false

export const useSettings = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS, theme: DEFAULT_THEME },
  loaded: false,
  load: async () => {
    /*
     * v0.3.9 体检 H1（渲染层这一半）：主进程（或另一个窗口）改了设置后，我们必须跟着重读。
     * 不做这一步的话，本窗口那份旧快照会在用户下一次点任何开关时把对方的改动整份覆盖掉。
     * 重读不会再写盘（load 只 set 本地状态），所以不存在"广播 → 写 → 再广播"的循环。
     */
    if (!settingsSubscribed) {
      settingsSubscribed = true
      api.store.onSettingsChanged(() => void get().load())
    }
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
    writeSettingsMerged(patch)
  },
  saveDeep: (fn) => {
    const next = fn(get().settings)
    set({ settings: next })
    /*
     * 与 save() 同一套合并策略：先把磁盘上的最新值取回来，再对它应用这次变换。
     * 这样"本窗口启动时那份快照"就不会把别的窗口/主进程刚写的设置整份抹掉。
     */
    void api.store.get('settings').then((cur) => {
      const base = cur.ok && cur.data && typeof cur.data === 'object' ? (cur.data as Partial<AppSettings>) : {}
      const merged = fn({ ...get().settings, ...base } as AppSettings)
      set({ settings: merged })
      void api.store.set('settings', merged)
    })
  }
}))

/**
 * 写设置时**先读磁盘、再按字段合并**（v0.3.9 体检 H1，渲染层这一半）。
 *
 * 为什么必须这样：`settings` 有**两个写入方** —— 渲染层（设置页、播放器浮层）与主进程
 * （十几处：Anime4K 画质、音频、投屏目标、缓存目录、数据源迁移标记…），两边互不通知。
 * 以前渲染层是拿"本窗口启动那一刻的对象"整份回写，谁后写谁赢：
 * 典型表现是"在播放器里调好的画质/音频，回主窗口点一个不相关的开关就变回默认"。
 *
 * 这里做的是**最小可用**的修法（读-合并-写）：把丢设置的概率压到极低。
 * 彻底的做法是主进程广播 `ev:settings` + 按字段 patch，那要动 IPC 契约与 17 处写入点，
 * 留给能和 main 一起改的时机（已记在体检清单里，不是"忘了"）。
 */
function writeSettingsMerged(patch: Partial<AppSettings>): void {
  void api.store.get('settings').then((cur) => {
    const base = cur.ok && cur.data && typeof cur.data === 'object' ? (cur.data as Partial<AppSettings>) : {}
    const merged: AppSettings = { ...useSettings.getState().settings, ...base, ...patch }
    useSettings.setState({ settings: merged })
    void api.store.set('settings', merged)
  })
}

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

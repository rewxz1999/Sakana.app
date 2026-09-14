import { create } from 'zustand'
import { api } from '@/lib/api'

export interface ShortcutDef {
  action: string
  label: string
  desc: string
  defaultKey: string
}

export const SHORTCUTS: ShortcutDef[] = [
  { action: 'playPause', label: '播放 / 暂停', desc: '切换播放与暂停', defaultKey: ' ' },
  { action: 'exit', label: '退出播放', desc: '返回上一页', defaultKey: 'Escape' },
  { action: 'fullscreen', label: '全屏', desc: '切换窗口全屏', defaultKey: 'f' },
  { action: 'forward10', label: '快进 10 秒', desc: '向后跳转 10 秒', defaultKey: 'ArrowRight' },
  { action: 'back10', label: '后退 10 秒', desc: '向前回退 10 秒', defaultKey: 'ArrowLeft' },
  { action: 'volumeUp', label: '音量增大', desc: '音量 +10%', defaultKey: 'ArrowUp' },
  { action: 'volumeDown', label: '音量减小', desc: '音量 -10%', defaultKey: 'ArrowDown' },
  { action: 'mute', label: '静音', desc: '切换静音', defaultKey: 'm' },
  { action: 'nextEp', label: '下一集', desc: '切换到下一集', defaultKey: 'n' },
  { action: 'prevEp', label: '上一集', desc: '切换到上一集', defaultKey: 'p' },
  { action: 'screenshot', label: '截屏', desc: '保存当前画面', defaultKey: 's' },
  { action: 'episodes', label: '选集', desc: '打开/关闭选集面板', defaultKey: 'l' },
  { action: 'info', label: '详情', desc: '显示/隐藏番剧详情', defaultKey: 'i' },
  { action: 'subtitle', label: '字幕切换', desc: '循环切换字幕（HTML5 模式）', defaultKey: 'c' }
]

export type ShortcutMap = Record<string, string>

function defaults(): ShortcutMap {
  const map: ShortcutMap = {}
  for (const s of SHORTCUTS) map[s.action] = s.defaultKey
  return map
}

interface ShortcutsState {
  map: ShortcutMap
  loaded: boolean
  load: () => Promise<void>
  setKey: (action: string, key: string) => void
  keyOf: (action: string) => string
}

export const useShortcuts = create<ShortcutsState>((set, get) => ({
  map: defaults(),
  loaded: false,
  load: async () => {
    const r = await api.store.get('shortcuts')
    const stored = r.ok && r.data && typeof r.data === 'object' ? (r.data as ShortcutMap) : {}
    set({ map: { ...defaults(), ...stored }, loaded: true })
  },
  setKey: (action, key) => {
    const next = { ...get().map, [action]: key }
    set({ map: next })
    void api.store.set('shortcuts', next)
  },
  keyOf: (action) => get().map[action] ?? defaults()[action] ?? ''
}))

/** 键盘事件 → 动作匹配（处理空格等特殊键） */
export function matchShortcut(e: KeyboardEvent, map: ShortcutMap): string | null {
  const key = e.key
  for (const [action, bound] of Object.entries(map)) {
    if (bound === key) return action
  }
  return null
}

export interface ThemePreset {
  id: string
  label: string
  kind: 'light' | 'dark'
  swatch: [string, string, string] // [背景, 卡片, 强调色]
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'sakura', label: '樱色', kind: 'light', swatch: ['#faf6f8', '#ffffff', '#e8548a'] },
  { id: 'matcha', label: '抹茶', kind: 'light', swatch: ['#f5f8f3', '#ffffff', '#4c9a5a'] },
  { id: 'midnight', label: '白蓝', kind: 'light', swatch: ['#eef2f9', '#ffffff', '#2f6bff'] },
  { id: 'obsidian', label: '曜石', kind: 'dark', swatch: ['#0c0d0f', '#15161a', '#27cfa5'] },
  { id: 'sunset', label: '落日', kind: 'dark', swatch: ['#1d1516', '#261b1d', '#f0814e'] }
]

export function applyTheme(id: string): void {
  document.documentElement.dataset.theme = id
}

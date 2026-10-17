/**
 * 主题调色板的**唯一数据源**（v1.1.4）。
 *
 * 为什么从渲染层搬到 shared：
 *   uosc 的控制栏颜色只能在它加载时由 `script-opts/uosc.conf` 决定（uosc 5.13 没有
 *   set-option / 重新读配置的消息），而这份配置文件是**主进程**在起播前生成的。
 *   如果主进程另抄一份颜色，主题一改、两边就会慢慢对不上（用户看到的就是
 *   「应用是樱粉、控制栏还是原来的蓝」）。所以调色板放在 shared，渲染层与主进程读同一份。
 *
 * 渲染层还在 `applyTheme()` 里把这些值写成 CSS 变量（内联到 :root），
 * `src/renderer/src/styles/main.css` 里的同名变量退回成"首屏兜底"——
 * 这样 CSS 与 uosc 不可能再各说各话。
 *
 * ⚠️ 改这里的颜色时顺手核对 main.css 的兜底值；两边不一致不会崩，
 * 但首屏（JS 还没跑起来的那一帧）会闪一下旧颜色。
 */

export type ThemeId = 'sakura' | 'matcha' | 'midnight' | 'obsidian' | 'sunset'

export interface ThemePalette {
  id: ThemeId
  label: string
  kind: 'light' | 'dark'
  bg: string
  elev1: string
  elev2: string
  elev3: string
  text: string
  dim: string
  faint: string
  accent: string
  accentSoft: string
  border: string
  danger: string
  ok: string
  warn: string
}

/**
 * 默认主题 = 白蓝（id 仍叫 midnight）。
 *
 * 注意 `DEFAULT_SETTINGS.theme` 写的是 sakura，但渲染层在"设置里没有 theme 键"时
 * 会显式改回 midnight（见 stores/app.ts 的 DEFAULT_THEME）。主进程生成 uosc 颜色时
 * 必须按**同一套规则**判定，否则新装用户会出现"界面白蓝、控制栏樱粉"。
 * 这也是 `resolveThemeId()` 存在的理由：不要直接拿 getSettings().theme 就用。
 */
export const DEFAULT_THEME_ID: ThemeId = 'midnight'

export const THEME_ORDER: ThemeId[] = ['sakura', 'matcha', 'midnight', 'obsidian', 'sunset']

export const THEME_PALETTES: Record<ThemeId, ThemePalette> = {
  sakura: {
    id: 'sakura',
    label: '樱色',
    kind: 'light',
    bg: '#faf6f8',
    elev1: '#ffffff',
    elev2: '#f4edf1',
    elev3: '#ece2e8',
    text: '#2c2430',
    dim: '#6f6370',
    faint: '#a79ba8',
    accent: '#e8548a',
    accentSoft: 'rgba(232, 84, 138, 0.12)',
    border: 'rgba(44, 36, 48, 0.1)',
    danger: '#d64545',
    ok: '#2f9e63',
    warn: '#cf8a1d'
  },
  matcha: {
    id: 'matcha',
    label: '抹茶',
    kind: 'light',
    bg: '#f5f8f3',
    elev1: '#ffffff',
    elev2: '#edf3ea',
    elev3: '#e0e9dc',
    text: '#28301f',
    dim: '#667060',
    faint: '#9da796',
    accent: '#4c9a5a',
    accentSoft: 'rgba(76, 154, 90, 0.13)',
    border: 'rgba(40, 48, 31, 0.1)',
    danger: '#cf4b4b',
    ok: '#3c8f5f',
    warn: '#c08a2a'
  },
  midnight: {
    id: 'midnight',
    label: '白蓝',
    kind: 'light',
    bg: '#eef2f9',
    elev1: '#ffffff',
    elev2: '#e9eef8',
    elev3: '#dfe7f3',
    text: '#1c2433',
    dim: '#4a566e',
    faint: '#8b96ad',
    accent: '#2f6bff',
    accentSoft: '#e3ecff',
    border: '#d4deee',
    danger: '#d64545',
    ok: '#2f9e63',
    warn: '#c07a1a'
  },
  obsidian: {
    id: 'obsidian',
    label: '曜石',
    kind: 'dark',
    bg: '#0c0d0f',
    elev1: '#15161a',
    elev2: '#1d1e24',
    elev3: '#272932',
    text: '#ececf0',
    dim: '#9b9ba6',
    faint: '#5f606b',
    accent: '#27cfa5',
    accentSoft: 'rgba(39, 207, 165, 0.14)',
    border: 'rgba(236, 236, 240, 0.08)',
    danger: '#f06a6a',
    ok: '#4ecb8c',
    warn: '#ecc05c'
  },
  sunset: {
    id: 'sunset',
    label: '落日',
    kind: 'dark',
    bg: '#1d1516',
    elev1: '#261b1d',
    elev2: '#2f2225',
    elev3: '#3b2b2e',
    text: '#f4e9e7',
    dim: '#b6a09e',
    faint: '#7d6b69',
    accent: '#f0814e',
    accentSoft: 'rgba(240, 129, 78, 0.15)',
    border: 'rgba(244, 233, 231, 0.09)',
    danger: '#ef6a6a',
    ok: '#53c487',
    warn: '#e9b44e'
  }
}

/** 把任意来源的 theme 字符串收窄成合法 id；非法/缺省一律回默认主题 */
export function resolveThemeId(raw: unknown): ThemeId {
  return typeof raw === 'string' && raw in THEME_PALETTES ? (raw as ThemeId) : DEFAULT_THEME_ID
}

/** 取某个主题的调色板（传入非法值也一定有返回值） */
export function themePalette(raw: unknown): ThemePalette {
  return THEME_PALETTES[resolveThemeId(raw)]
}

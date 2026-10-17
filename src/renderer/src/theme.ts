import { THEME_ORDER, THEME_PALETTES, resolveThemeId } from '@shared/themePalette'

export interface ThemePreset {
  id: string
  label: string
  kind: 'light' | 'dark'
  swatch: [string, string, string] // [背景, 卡片, 强调色]
}

/**
 * 主题列表从 `@shared/themePalette` 派生（v1.1.4）。
 *
 * 以前这里是手写的一份、CSS 里又是一份、uosc 配色还得再抄一份 —— 三份颜色迟早漂移。
 * 现在只有 shared 那一份是数据源：渲染层用它写 CSS 变量，主进程用它生成 uosc 的 `color=`。
 */
export const THEME_PRESETS: ThemePreset[] = THEME_ORDER.map((id) => {
  const p = THEME_PALETTES[id]
  return {
    id: p.id,
    label: p.label,
    kind: p.kind,
    swatch: [p.bg, p.elev1, p.accent]
  }
})

/**
 * 应用主题 = 打 `data-theme` + 把调色板写成内联 CSS 变量。
 *
 * 为什么还要内联（CSS 里明明已经有同名变量）：
 *   · 主进程生成 uosc 颜色与这里用的是**同一个** shared 调色板；
 *     内联之后页面实际渲染的颜色也来自它，"看到的"和"控制栏的"不可能对不上；
 *   · `main.css` 里的值保留为 JS 启动前的首屏兜底（那一帧还没执行到 applyTheme）。
 */
export function applyTheme(id: string): void {
  const p = THEME_PALETTES[resolveThemeId(id)]
  const root = document.documentElement
  root.dataset.theme = p.id
  const vars: Record<string, string> = {
    '--bg': p.bg,
    '--elev1': p.elev1,
    '--elev2': p.elev2,
    '--elev3': p.elev3,
    '--text': p.text,
    '--dim': p.dim,
    '--faint': p.faint,
    '--accent': p.accent,
    '--accent-soft': p.accentSoft,
    '--border': p.border,
    '--danger': p.danger,
    '--ok': p.ok,
    '--warn': p.warn
  }
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  root.style.colorScheme = p.kind
}

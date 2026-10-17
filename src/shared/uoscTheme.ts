/**
 * uosc 配色生成（v1.1.4）—— 纯函数，主进程与自检脚本共用同一份。
 *
 * 为什么单独拆出来：
 *   · 颜色映射有"幕布必须是深色""强调色上的文字按亮度选黑/白"这类规则，
 *     写在主进程里就只能靠读代码核对；拆成纯函数后可以直接在 Node 里逐主题跑一遍，
 *     把生成后的 `color=` 行贴进自检报告（本工单要求真机证据）。
 *   · 主进程只负责"写到哪、写不进去怎么办"，不负责颜色算法。
 *
 * 输出必须满足 uosc 的 `serialize_key_value_list` 约束：
 *   逗号分隔的 key=hex，hex **不带 #**，值只允许 [%w_.]（见 uosc/lib/std.lua）。
 */

import { themePalette, type ThemeId } from './themePalette'

/** 把 `#rrggbb` / `rgba(...)` 收成 6 位 hex（uosc 不接受 # 与 alpha） */
function uoscHex(color: string): string {
  const m = /^#?([0-9a-fA-F]{6})/.exec(String(color ?? '').trim())
  return (m?.[1] ?? 'ffffff').toLowerCase()
}

/** 16 进制颜色按比例混黑：用于把浅色主题的背景压成"幕布"色 */
function mixBlack(hex: string, ratio: number): string {
  const h = uoscHex(hex)
  const mix = (i: number): string => {
    const v = parseInt(h.slice(i, i + 2), 16)
    return Math.round(v * (1 - ratio))
      .toString(16)
      .padStart(2, '0')
  }
  return `${mix(0)}${mix(2)}${mix(4)}`
}

/** 相对亮度（0=黑，1=白）：只用来决定强调色上的文字用黑还是白 */
function luminance(hex: string): number {
  const h = uoscHex(hex)
  const channel = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/**
 * 生成 uosc 的 `color=` 值。
 *
 * 映射（用户要求"UI 颜色跟随应用主题"）：
 *   foreground      = accent       控制栏图标 / 进度条已播放段 / 菜单选中项
 *   foreground_text = 强调色上的文字（按亮度自动选黑/白）
 *   background      = elev1        菜单/提示框底（浅色主题就是白卡片）
 *   background_text = text         菜单正文
 *   curtain         = 背景压暗     **必须**是深色：uosc 的幕布是一整屏 0.8 不透明度覆盖，
 *                                  浅色主题直接拿 bg 会变成"一开控制栏整块画面泛白"
 *   match           = accent       菜单搜索命中高亮
 *   success/error   = ok/danger    与界面里的成功/错误色一致
 *
 * 不写 `window_border`：uosc.conf 里 `window_border_size=0` 已经不画描边。
 */
export function buildUoscColorLine(themeId: string | ThemeId): string {
  const p = themePalette(themeId)
  const fg = uoscHex(p.accent)
  const fgText = luminance(fg) > 0.55 ? '000000' : 'ffffff'
  const curtain = p.kind === 'light' ? mixBlack(p.bg, 0.85) : uoscHex(p.bg)
  return [
    `foreground=${fg}`,
    `foreground_text=${fgText}`,
    `background=${uoscHex(p.elev1)}`,
    `background_text=${uoscHex(p.text)}`,
    `curtain=${curtain}`,
    `match=${fg}`,
    `success=${uoscHex(p.ok)}`,
    `error=${uoscHex(p.danger)}`
  ].join(',')
}

/** uosc.conf 模板里的颜色占位符 */
export const UOSC_COLOR_MARKER = '@SAKANA_UOSC_COLOR@'

/**
 * 把模板渲染成最终 uosc.conf。
 *
 * 兼容两种模板：
 *   · 新模板（含 `@SAKANA_UOSC_COLOR@`）→ 直接替换；
 *   · 老模板（没有占位符）→ 删掉已有 color 行后追加。uosc 的 read_options 按行顺序赋值，
 *     后出现的同键覆盖前面的，所以追加是安全的。
 */
export function renderUoscConf(template: string, themeId: string | ThemeId): string {
  const colorValue = buildUoscColorLine(themeId)
  const colorLine = `color=${colorValue}`
  /*
   * 模板里写的是 `color=@SAKANA_UOSC_COLOR@`（`color=` 已在模板里），
   * 所以占位符只替换成**值**；没有占位符的老模板才追加整行。
   */
  if (template.includes(UOSC_COLOR_MARKER)) return template.replace(UOSC_COLOR_MARKER, colorValue)
  const body = template
    .split(/\r?\n/)
    .filter((line) => !/^\s*color\s*=/.test(line))
    .join('\n')
  return `${body.replace(/\s*$/, '')}\n${colorLine}\n`
}

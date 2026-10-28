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

/* ───────────────── V1.5.1：控制栏外观（图标/圆角/配色预设） ───────────────── */

/**
 * 控制栏外观。
 *
 * 用户原话：「我觉得现在的播放器控制按钮图标不够美观，建议修改，看看有没有现成的，认可度高的图标」，
 * 并点名了几个社区项目（Catppuccin for uosc / hikari / Glass UI / uoscVLC）。
 *
 * 我们**没有**整包搬那些项目：它们要么是整套 mpv 配置、要么是 uosc 的 fork，
 * 覆盖式安装会替换掉我们自己的按钮桥接脚本 `sakana-uosc-ctrl.lua`（选集/倍速/弹幕菜单全在它里面），
 * 风险远大于收益。可取的是它们**社区认可度最高的那部分——配色与造型**：
 *   · `catppuccin`：Catppuccin Mocha，柔和紫调；
 *   · `tokyo`：hikari 内置的 Tokyo Night 风味，蓝紫底 + 冷蓝强调；
 *   · `glass`：Glass UI 那种深色质感（uosc 不支持真正的模糊，用更深更中性的底色近似）。
 * `follow` 保持原行为：跟随应用主题。
 *
 * 圆角是「Glass UI / hikari」观感里最关键的一项，所以单独给一个 0–20 的滑块；
 * uosc 的 `border_radius` 是全局的，控制栏、菜单、提示框会一起变圆。
 */
export type UoscAppearancePreset = 'follow' | 'catppuccin' | 'tokyo' | 'glass'

export interface UoscAppearance {
  preset: UoscAppearancePreset
  /** 圆角像素（0–20），写进 uosc.conf 的 border_radius */
  radius: number
  /**
   * V1.5.2：按钮直径（px），写进 uosc.conf 的 controls_size。
   * uosc 的图标是按按钮尺寸等比画的，所以调这一个值就等于调「图标大小 + 点击热区」。
   */
  size: number
}

export const DEFAULT_UOSC_APPEARANCE: UoscAppearance = { preset: 'catppuccin', radius: 12, size: 42 }

/** 设置页要展示的预设（含色块预览；颜色值是给人看的，不参与渲染） */
export const UOSC_APPEARANCES: {
  id: UoscAppearancePreset
  label: string
  desc: string
  swatch: [string, string, string]
}[] = [
  {
    id: 'catppuccin',
    label: 'Catppuccin Mocha',
    desc: '柔和紫调（Catppuccin for uosc 的 Mocha 风味），深色低对比，久看不累',
    swatch: ['#1e1e2e', '#cba6f7', '#cdd6f4']
  },
  {
    id: 'tokyo',
    label: 'Tokyo Night',
    desc: 'hikari 内置的 Tokyo Night 风味：蓝紫底 + 冷蓝强调，清爽',
    swatch: ['#1a1b26', '#7aa2f7', '#c0caf5']
  },
  {
    id: 'glass',
    label: 'Glass 深色玻璃',
    desc: '参考 Glass UI：中性深色底 + 亮蓝强调，圆角拉满时最像一条玻璃控制栏',
    swatch: ['#0d1117', '#58a6ff', '#e6edf3']
  },
  {
    id: 'follow',
    label: '跟随应用主题',
    desc: '与主界面同一套主题色（原行为）',
    swatch: ['#e9eef8', '#e34b6d', '#1c2433']
  }
]

/** 收窄外观设置：任何来源（设置文件 / 界面）都先过这里 */
export function resolveUoscAppearance(raw: unknown): UoscAppearance {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<UoscAppearance>
  const preset: UoscAppearancePreset =
    src.preset === 'catppuccin' || src.preset === 'tokyo' || src.preset === 'glass' || src.preset === 'follow'
      ? src.preset
      : DEFAULT_UOSC_APPEARANCE.preset
  const n = Number(src.radius)
  const radius = Number.isFinite(n) ? Math.min(20, Math.max(0, Math.round(n))) : DEFAULT_UOSC_APPEARANCE.radius
  const s = Number(src.size)
  const size = Number.isFinite(s) ? Math.min(56, Math.max(32, Math.round(s))) : DEFAULT_UOSC_APPEARANCE.size
  return { preset, radius, size }
}

/** 预设调色板（uosc 的 color 键；hex 不带 #） */
const PRESET_PALETTES: Record<Exclude<UoscAppearancePreset, 'follow'>, Record<string, string>> = {
  catppuccin: {
    foreground: 'cba6f7',
    foreground_text: '1e1e2e',
    background: '1e1e2e',
    background_text: 'cdd6f4',
    curtain: '11111b',
    match: 'cba6f7',
    success: 'a6e3a1',
    error: 'f38ba8'
  },
  tokyo: {
    foreground: '7aa2f7',
    foreground_text: '1a1b26',
    background: '1a1b26',
    background_text: 'c0caf5',
    curtain: '16161e',
    match: '7aa2f7',
    success: '9ece6a',
    error: 'f7768e'
  },
  glass: {
    foreground: '58a6ff',
    foreground_text: '0d1117',
    background: '0d1117',
    background_text: 'e6edf3',
    curtain: '010409',
    match: '58a6ff',
    success: '3fb950',
    error: 'f85149'
  }
}

/** 按外观预设生成 `color=` 值（follow 走原来的主题映射） */
export function buildUoscColorLineFor(themeId: string | ThemeId, appearance?: UoscAppearance): string {
  const app = resolveUoscAppearance(appearance ?? DEFAULT_UOSC_APPEARANCE)
  if (app.preset === 'follow') return buildUoscColorLine(themeId)
  return Object.entries(PRESET_PALETTES[app.preset])
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
}

/** uosc.conf 模板里的圆角占位符（老模板没有它时按"删掉原行再追加"处理） */
export const UOSC_RADIUS_MARKER = '@SAKANA_UOSC_RADIUS@'

/** V1.5.2：按钮直径（图标大小）占位符 */
export const UOSC_SIZE_MARKER = '@SAKANA_UOSC_SIZE@'

/**
 * 把模板渲染成最终 uosc.conf。
 *
 * 兼容两种模板：
 *   · 新模板（含 `@SAKANA_UOSC_COLOR@` / `@SAKANA_UOSC_RADIUS@`）→ 直接替换；
 *   · 老模板（没有占位符）→ 删掉已有同名键那行后追加。uosc 的 read_options 按行顺序赋值，
 *     后出现的同键覆盖前面的，所以追加是安全的。
 */
export function renderUoscConf(template: string, themeId: string | ThemeId, appearance?: UoscAppearance): string {
  const app = resolveUoscAppearance(appearance ?? DEFAULT_UOSC_APPEARANCE)
  const colorValue = buildUoscColorLineFor(themeId, app)
  const colorLine = `color=${colorValue}`
  let out = template
  /*
   * 模板里写的是 `color=@SAKANA_UOSC_COLOR@`（`color=` 已在模板里），
   * 所以占位符只替换成**值**；没有占位符的老模板才追加整行。
   */
  if (out.includes(UOSC_COLOR_MARKER)) {
    out = out.replace(UOSC_COLOR_MARKER, colorValue)
  } else {
    const body = out
      .split(/\r?\n/)
      .filter((line) => !/^\s*color\s*=/.test(line))
      .join('\n')
    out = `${body.replace(/\s*$/, '')}\n${colorLine}\n`
  }
  // 圆角：新模板有占位符；老模板删掉原 border_radius 行再追加（老用户不会因为模板过旧失去这个设置）
  if (out.includes(UOSC_RADIUS_MARKER)) {
    out = out.replace(UOSC_RADIUS_MARKER, String(app.radius))
  } else {
    const body = out
      .split(/\r?\n/)
      .filter((line) => !/^\s*border_radius\s*=/.test(line))
      .join('\n')
    out = `${body.replace(/\s*$/, '')}\nborder_radius=${app.radius}\n`
  }
  /*
   * V1.5.2：按钮直径（= 图标大小 + 点击热区）。同样兼容老模板：
   * 没有 @SAKANA_UOSC_SIZE@ 时删掉旧的 controls_size 行再追加。
   */
  if (out.includes(UOSC_SIZE_MARKER)) {
    out = out.replace(UOSC_SIZE_MARKER, String(app.size))
  } else {
    const body = out
      .split(/\r?\n/)
      .filter((line) => !/^\s*controls_size\s*=/.test(line))
      .join('\n')
    out = `${body.replace(/\s*$/, '')}\ncontrols_size=${app.size}\n`
  }
  return out
}

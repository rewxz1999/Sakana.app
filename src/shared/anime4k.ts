/**
 * Anime4K 超分辨率（v0.3.1）。
 *
 * 这里只放「模式 → 着色器链」的对照表，主进程与渲染层共用：
 *  - 主进程用它拼出绝对路径交给 mpv（`--glsl-shaders` / `change-list glsl-shaders`）；
 *  - 设置页用它显示「这个模式会跑哪几个着色器」。
 *
 * ## 链的出处（没有自己编）
 * 完整照抄 Anime4K v4.0.1 官方给 mpv 用的模板（bloc97/Anime4K 的
 * `md/GLSL_Instructions_Windows_MPV.md` 指向的 Tama47/Anime4K 模板包）：
 *
 *  - **流畅档（Low-end，S/M 变体）**：`GLSL_Windows_Low-end.zip` 的 input.conf
 *    → `CTRL+1..6` 六条 `change-list glsl-shaders set "…"`
 *  - **画质档（High-end，VL/M 变体）**：`GLSL_Windows_High-end.zip` 的 input.conf
 *
 * 两个档位除了 CNN 变体字母（M/S ↔ VL/M）完全一致：
 * 第一段放大用大网络、`AutoDownscalePre` 之后的第二段放大换小网络 ——
 * 因为「放大之后的着色器耗时是放大前的 4 倍」（官方 Advanced 文档原话）。
 * `AutoDownscalePre_x2` 必须紧跟第一个 Upscale、`AutoDownscalePre_x4` 放在两次
 * 放大之间，位置错了就失去「不放大到超出屏幕」的性能意义。
 *
 * ## 模式含义（官方 Advanced 文档）
 * | 模式 | 链 | 适合 |
 * | --- | --- | --- |
 * | A | Restore → Upscale → Upscale | 大多数 1080p；模糊/压缩痕迹重的老番 |
 * | B | Restore_Soft → Upscale → Upscale | 部分 1080p、多数 720p；振铃/锯齿明显 |
 * | C | Upscale_Denoise → Upscale | 1080p 降到 480p 的番、几乎无损伤的片源；PSNR 最高 |
 * | A+A | Restore → Upscale → Restore → Upscale | 同 A，感知画质最高，但可能过度锐化（只在 ≥2 倍放大时用） |
 * | B+B | Restore_Soft → Upscale → Restore_Soft → Upscale | 同 B，感知画质更高 |
 * | C+A | Upscale_Denoise → Restore → Upscale | 同 C，感知画质略高 |
 *
 * `Clamp_Highlights` 官方建议永远放在最前面（防振铃），本表所有模式都带它。
 */

/** 内置模式 id（`custom` = 用户自己勾选着色器） */
export type Anime4kMode = 'A' | 'B' | 'C' | 'AA' | 'BB' | 'CA' | 'custom'

/** 显卡档位：`fast` = 官方 Low-end 模板（S/M），`quality` = High-end 模板（VL/M） */
export type Anime4kTier = 'fast' | 'quality'

export interface Anime4kModeInfo {
  id: Anime4kMode
  /** 短名（按钮上的字） */
  short: string
  /** 一句话说明（按钮下面那行小字） */
  desc: string
  /** 适合什么片源（设置页的详细说明） */
  target: string
}

export const ANIME4K_MODES: Anime4kModeInfo[] = [
  {
    id: 'A',
    short: 'A',
    desc: '通用 · 1080p 首选',
    target: '大多数 1080p 番剧、部分老 720p 与标清番；片源模糊、压缩痕迹重时效果最明显'
  },
  {
    id: 'B',
    short: 'B',
    desc: '720p / 振铃明显',
    target: '部分 1080p、多数 720p、1080p 降采样得到的片源；锯齿、振铃（边缘白边）明显时更合适'
  },
  {
    id: 'C',
    short: 'C',
    desc: '低码率 / 噪点多',
    target: '1080p 降到 480p 的番、动画电影、几乎无损伤的片源；PSNR 最高、感知画质偏低'
  },
  {
    id: 'AA',
    short: 'A+A',
    desc: '画质优先（慢）',
    target: '与 A 相同，但感知画质最高；仅在放大倍数 ≥2 时使用，否则容易过锐'
  },
  {
    id: 'BB',
    short: 'B+B',
    desc: '画质优先（慢）',
    target: '与 B 相同，感知画质更高；同样建议放大倍数 ≥2 时使用'
  },
  {
    id: 'CA',
    short: 'C+A',
    desc: '画质优先（慢）',
    target: '与 C 相同，感知画质略高'
  },
  {
    id: 'custom',
    short: '自定义',
    desc: '自己勾选着色器',
    target: '按顺序执行你勾选的着色器，需要自己了解每个着色器的作用'
  }
]

export const ANIME4K_TIERS: { id: Anime4kTier; label: string; desc: string }[] = [
  { id: 'fast', label: '流畅优先', desc: '官方 Low-end 模板（S/M 变体），低端显卡也跑得动' },
  { id: 'quality', label: '画质优先', desc: '官方 High-end 模板（VL/M 变体），需要较强的显卡' }
]

/** 内置模式的着色器链：[流畅档, 画质档]（文件名，不含目录） */
const CHAINS: Record<Exclude<Anime4kMode, 'custom'>, { fast: string[]; quality: string[] }> = {
  // CTRL+1
  A: {
    fast: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_M.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_S.glsl'
    ],
    quality: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_VL.glsl',
      'Anime4K_Upscale_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl'
    ]
  },
  // CTRL+2
  B: {
    fast: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_M.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_S.glsl'
    ],
    quality: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_VL.glsl',
      'Anime4K_Upscale_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl'
    ]
  },
  // CTRL+3
  C: {
    fast: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Upscale_Denoise_CNN_x2_M.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_S.glsl'
    ],
    quality: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Upscale_Denoise_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl'
    ]
  },
  // CTRL+4
  AA: {
    fast: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_M.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
      'Anime4K_Restore_CNN_S.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_S.glsl'
    ],
    quality: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_VL.glsl',
      'Anime4K_Upscale_CNN_x2_VL.glsl',
      'Anime4K_Restore_CNN_M.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl'
    ]
  },
  // CTRL+5
  BB: {
    fast: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_M.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Restore_CNN_Soft_S.glsl',
      'Anime4K_Upscale_CNN_x2_S.glsl'
    ],
    quality: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_VL.glsl',
      'Anime4K_Upscale_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Restore_CNN_Soft_M.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl'
    ]
  },
  // CTRL+6
  CA: {
    fast: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Upscale_Denoise_CNN_x2_M.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Restore_CNN_S.glsl',
      'Anime4K_Upscale_CNN_x2_S.glsl'
    ],
    quality: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Upscale_Denoise_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Restore_CNN_M.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl'
    ]
  }
}

/**
 * 解析出实际要交给 mpv 的着色器文件名列表。
 *
 * @param mode 模式；`custom` 时用 `custom` 参数
 * @param tier 显卡档位（只对内置模式有意义）
 * @param custom 自定义模式的文件名列表（会过滤掉空串与非法值，最多 32 个）
 */
export function anime4kChain(mode: Anime4kMode, tier: Anime4kTier, custom?: string[]): string[] {
  if (mode === 'custom') {
    return (custom ?? [])
      .filter((f): f is string => typeof f === 'string' && f.trim() !== '')
      .map((f) => f.trim())
      .slice(0, 32)
  }
  const entry = CHAINS[mode] ?? CHAINS.A
  return entry[tier] ?? entry.fast
}

/** mpv 的色调映射算法（`--tone-mapping`），只列常用且 mpv 0.3x 都有的 */
export const ANIME4K_TONE_MAPPINGS: { id: string; label: string; desc: string }[] = [
  { id: 'auto', label: '自动', desc: '由 mpv 按片源与屏幕自动挑（推荐）' },
  { id: 'bt.2390', label: 'BT.2390', desc: 'ITU 标准曲线，HDR 转 SDR 最常用' },
  { id: 'spline', label: 'Spline', desc: '样条曲线，观感偏亮、细节保留好' },
  { id: 'hable', label: 'Hable', desc: '电影感强，暗部压得比较狠' },
  { id: 'reinhard', label: 'Reinhard', desc: '整体偏软，高光不易过曝' },
  { id: 'mobius', label: 'Mobius', desc: '暗部保留较多，画面偏灰' },
  { id: 'clip', label: 'Clip', desc: '直接裁切，最快但高光会死白' }
]

/** 画面微调（mpv 属性）的取值范围：统一 -100 ~ 100，0 表示不改动 */
export const ANIME4K_TUNE_RANGE = { min: -100, max: 100, step: 5 } as const

/**
 * 音频（音质调控）设置的**唯一事实来源**（v0.3.6）。
 *
 * 为什么单独一个文件：这一组设置要同时被三方使用 ——
 *   ① 渲染层（播放器设置页的可视化界面、播放器控制栏的音量）
 *   ② 主进程 mpv 服务（拼 ffmpeg 的 `af` 滤镜链、设 `volume`）
 *   ③ 自检脚本（SAKANA_AUDIO_TEST 用它生成待验证的滤镜串）
 * 主进程与渲染层不能各写一份「怎么拼滤镜」的逻辑，否则改一处漏一处，
 * 表现就是「设置页看着生效了，实际声音没变」。
 *
 * 关于 ffmpeg 滤镜链的语法（**这一节的结论全部来自真机探针**，
 * `.e2e` 下的 SAKANA_AUDIO_TEST 会把每条滤镜送进 libmpv 试建图，结果记在这里）：
 *
 *   · 滤镜之间用 **逗号** 分隔：`loudnorm=…,alimiter=…`
 *   · 单个滤镜的参数用 **冒号** 分隔；`pan` 那种用 `|` 的语法在 mpv 里会**被拒**
 *   · **`pan` 整条不可用**（三种写法都试过：老式 `FL=…*FL`、新式 `c0=…*c0`、只给增益）——
 *     它是 libavfilter 里少见的要「解析表达式」的滤镜，mpv 的 af 串解析器过不去。
 *     所以立体声处理改用 `extrastereo`（宽度）+ `stereotools`（crossfeed/电平）。
 *   · **`superequalizer` 只能升不能降**：真机 + ffmpeg 双向确认它的 `nb` 参数范围是
 *     `[0, 20]` dB —— 传负值直接报 `out of range`，所以它做不了「衰减某段」。
 *     均衡器最终用 **`equalizer`（双极点 peaking）逐段串联**：它 `g` 支持正负，
 *     每段一个滤镜、最多 10 段，Q 由频点算出（≈ 1 个倍频程带宽），叠起来就是标准的
 *     10 段图示均衡器，音色平滑且能升能降。
 *   · `astats` 用来驱动可视化：`measure_overall=RMS_level` 会把 RMS 写进
 *     `af-metadata/<label>/Overall/RMS_level`，这是 libmpv 下**唯一**能拿到的
 *     实时音频能量（mpv 不导出 FFT 频谱，所以可视化是「电平柱」而不是真频谱）。
 *   · ⚠️ **`astats` → `af-metadata` 这条路在真机上走不通**（v0.3.6 实测）：
 *     `af-metadata` 属性读出 `null`（`getProperty('af-metadata')` 直接是 null），
 *     试过 `af-metadata/astats/...`、`af-metadata/lavfi.astats.Overall/...` 等 4 种 label
 *     写法，全部为 null；`astats` 滤镜本身能挂上，但它的 metadata 不通过这个属性暴露。
 *     mpv 也不会把音频采样交给宿主（那是内部的 audio chain）。
 *     **结论：libmpv 下拿不到实时频谱/电平**，所以「播放器上的音频可视化」这一版没做
 *     （画一个跟声音无关的假动画不如不画）。设置页里改成画**音色响应曲线**——
 *     那条曲线完全由用户自己的 EQ 增益算出来，是真数据，而且是调 EQ 时唯一真正想看的东西。
 *   · `sofalizer` 需要外部 `.sofa` HRTF 文件，没有文件必然被拒（属预期）；
 *     应用不随包分发这类文件（体积大 + 授权不明），所以空间音频只能用 crossfeed 近似。
 *   · `scaletempo2` 只在 mpv 里存在（独立 ffmpeg 没有这个滤镜，别用 ffmpeg.exe 去验它）。
 */

/** 均衡器段数（10 段倍频程，够用且界面上排得下） */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
export const EQ_BAND_COUNT = EQ_BANDS.length
/** 单段增益范围（dB） */
export const EQ_GAIN_MIN = -12
export const EQ_GAIN_MAX = 12

export interface EqPreset {
  id: string
  name: string
  /** 每段增益（dB），顺序与 EQ_BANDS 一致 */
  gains: number[]
  /** 一句话说明，显示在设置页 */
  desc: string
}

/**
 * 内置预设。
 *
 * 取值是常见调音的「温和版」：整体不超过 ±6dB，避免一上来就把人声削掉。
 * `flat` 是默认（全 0 = 不启用均衡器，等于原声）。
 */
export const EQ_PRESETS: EqPreset[] = [
  { id: 'flat', name: '原声（关闭）', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], desc: '不做任何改变' },
  { id: 'pop', name: '流行', gains: [-1, 0, 2, 4, 5, 3, 1, 0, -1, -1], desc: '突出人声与中频，适合 JPOP' },
  { id: 'rock', name: '摇滚', gains: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4], desc: '低频鼓点与高频镲更带感' },
  { id: 'jazz', name: '爵士', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3], desc: '宽松的低频与通透的高频' },
  { id: 'classical', name: '古典', gains: [3, 2, 1, 0, 0, 0, -1, -1, 2, 3], desc: '平顺，强调厅堂感' },
  { id: 'electronic', name: '电子', gains: [5, 4, 2, 0, -2, 1, 2, 3, 4, 5], desc: '两端抬升，适合电子与合成器' },
  { id: 'vocal', name: '人声（对白）', gains: [-3, -2, 0, 3, 5, 4, 2, 0, -1, -2], desc: '压低低频、突出语音频段' },
  { id: 'bass', name: '低音增强', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], desc: '只抬低频' },
  { id: 'treble', name: '高音增强', gains: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6], desc: '只抬高频' },
  { id: 'loudness', name: '等响度', gains: [5, 4, 2, 0, -2, 0, 1, 3, 4, 5], desc: '小音量下也听得出两端' }
]

export interface AudioSettings {
  /** 开关：整组音质增强的总闸（关掉 = 完全原声） */
  enabled?: boolean
  /**
   * 音量增益（软件增益，1.0 = 100%）。
   * 允许到 2.0（200%）—— 用户反馈 100% 偏小，要能再加。
   */
  gain?: number
  /** 主开关：音量超过 100% 时是否加限幅器防削波（默认开） */
  clippingProtection?: boolean

  /** 均衡器 */
  eqEnabled?: boolean
  eqPreset?: string
  /** 自定义各段增益（dB）；用户手调过之后就以它为准 */
  eqGains?: number[]
  /**
   * 「精细音色」（v0.3.6 实测后的替代方案）。
   *
   * 原计划用 `firequalizer` 的线性相位 FIR —— 真机探针证明它在 mpv 的 af 串里
   * **无法表达多段增益**（段分隔用的 `;` 与链分隔符冲突，转义也不行），
   * 所以均衡器主实现是 `superequalizer`（固定 18 段）。
   * 打开这一项会**额外**挂一条 `firequalizer=gain=…`：它只有整条链的单一增益、
   * 没有分段，但带 `zero_phase=on`（真·线性相位），作用是让整体音色更「干净」一点。
   * 默认关 —— 它更像一种风味开关，不是必需品。
   */
  eqLinearPhase?: boolean

  /** 立体声宽度（extrastereo 的 m 系数，1 = 不变，越大越宽） */
  stereoWidth?: number
  /** 交叉馈送（stereotools 的 mlev，1 = 不变，< 1 = 左右互串、耳机上更耐听） */
  crossfeed?: number
  /** 动态范围压缩（acompressor），适合深夜小音量看番 */
  compressorEnabled?: boolean
  /** 在压缩前把整体电平抬一点（compressor 的 makeup） */
  compressorMakeup?: number

  /** 响度归一化（loudnorm，EBU R128）：把忽大忽小的源拉齐 */
  loudnormEnabled?: boolean
  /** 目标响度（LUFS），默认 -16（比广播标准 -23 更响一点） */
  loudnormTarget?: number
}

export const DEFAULT_AUDIO: Required<
  Pick<
    AudioSettings,
    | 'enabled'
    | 'gain'
    | 'clippingProtection'
    | 'eqEnabled'
    | 'eqPreset'
    | 'eqLinearPhase'
    | 'stereoWidth'
    | 'crossfeed'
    | 'compressorEnabled'
    | 'compressorMakeup'
    | 'loudnormEnabled'
    | 'loudnormTarget'
  >
> = {
  enabled: true,
  /*
   * 默认增益 1.25 = 125%。
   *
   * 用户原话：「就算是 100% 的声音也有点偏小，可能要增加个 0.25 倍左右」。
   * 所以默认就带上这 0.25 倍，而不是给 1.0 让用户自己去调 —— 他说的是「现在偏小」，
   * 那就把默认值本身挪到他想要的听感上；`clippingProtection` 默认开会兜住削波。
   */
  gain: 1.25,
  clippingProtection: true,
  eqEnabled: false,
  eqPreset: 'flat',
  eqLinearPhase: false,
  stereoWidth: 1,
  crossfeed: 1,
  compressorEnabled: false,
  compressorMakeup: 1,
  loudnormEnabled: false,
  loudnormTarget: -16
}

/** 值的收窄：设置来自磁盘，什么都可能，全部夹到合法区间 */
function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 收窄后的完整设置（所有字段都有值） */
export interface ResolvedAudio extends Required<
  Pick<
    AudioSettings,
    | 'enabled'
    | 'gain'
    | 'clippingProtection'
    | 'eqEnabled'
    | 'eqPreset'
    | 'eqGains'
    | 'eqLinearPhase'
    | 'stereoWidth'
    | 'crossfeed'
    | 'compressorEnabled'
    | 'compressorMakeup'
    | 'loudnormEnabled'
    | 'loudnormTarget'
  >
> {}

/** 把磁盘上的（可能残缺/脏的）设置补齐成完整设置 */
export function resolveAudioSettings(raw: unknown): ResolvedAudio {
  const o = (raw && typeof raw === 'object' ? raw : {}) as AudioSettings
  const d = DEFAULT_AUDIO
  const preset = EQ_PRESETS.find((p) => p.id === o.eqPreset) ?? EQ_PRESETS[0]
  const rawGains = Array.isArray(o.eqGains) ? o.eqGains : preset.gains
  const eqGains = Array.from({ length: EQ_BAND_COUNT }, (_v, i) =>
    num(rawGains[i], preset.gains[i] ?? 0, EQ_GAIN_MIN, EQ_GAIN_MAX)
  )
  return {
    enabled: o.enabled !== false,
    gain: num(o.gain, d.gain, 0, 2),
    clippingProtection: o.clippingProtection !== false,
    eqEnabled: o.eqEnabled === true,
    eqPreset: preset.id,
    eqGains,
    eqLinearPhase: o.eqLinearPhase === true,
    stereoWidth: num(o.stereoWidth, d.stereoWidth, 0, 3),
    crossfeed: num(o.crossfeed, d.crossfeed, 0, 1),
    compressorEnabled: o.compressorEnabled === true,
    compressorMakeup: num(o.compressorMakeup, d.compressorMakeup, 1, 3),
    loudnormEnabled: o.loudnormEnabled === true,
    loudnormTarget: num(o.loudnormTarget, d.loudnormTarget, -30, -8)
  }
}

/**
 * 把 10 段滑杆的增益换算成 `equalizer` 逐段串联的参数。
 *
 * 为什么是逐段一个滤镜：`equalizer` 一次只能处理一个频点，
 * 但它的增益支持正负、带宽可控 —— 这正是「能升能降的图示均衡器」需要的。
 * 10 段就是 10 个滤镜，开销可以忽略（每段只多一次双极点运算）。
 *
 * 带宽：用固定 Q = 1.414（≈ 1 个倍频程），这是图形均衡器的惯例 ——
 * 相邻滑杆的频率比正好是 2（31→62→125…），Q=√2 时各段在 -3dB 处刚好衔接，
 * 既不会互相打太多架，也不会在段与段之间留下「坑」。
 */
export function eqFiltersFor(gains: number[]): string[] {
  const out: string[] = []
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    const g = num(gains[i], 0, EQ_GAIN_MIN, EQ_GAIN_MAX)
    // ±0.05dB 以内不挂滤镜：省一次运算，也避免「明明全 0 却挂了 10 个滤镜」
    if (Math.abs(g) < 0.05) continue
    out.push(`equalizer=f=${EQ_BANDS[i]}:t=q:w=1.414:g=${g.toFixed(1)}`)
  }
  return out
}

/**
 * 是否需要限幅器。
 *
 * 三种情况必须加：
 *   ① 用户把音量抬过 100%（软件增益会削波）
 *   ② 均衡器有正增益（抬起来的频段可能超过 0dBFS）
 *   ③ 开了响度归一化或压缩器（它们都会改变峰值）
 * 用户可以在设置里关掉（`clippingProtection: false`）—— 有些人更喜欢限幅器的染色。
 */
export function needsLimiter(s: AudioSettings): boolean {
  if (s.clippingProtection === false) return false
  const gain = Number(s.gain ?? 1)
  if (Number.isFinite(gain) && gain > 1.001) return true
  if (s.eqEnabled === true) {
    const gains = Array.isArray(s.eqGains) ? s.eqGains : []
    if (gains.some((g) => Number(g) > 0.01)) return true
  }
  return s.compressorEnabled === true || s.loudnormEnabled === true
}

/**
 * 把设置拼成 mpv 的 `af` 滤镜链。
 *
 * 顺序是有讲究的，**不是随便排**：
 *   1. `loudnorm` 放最前 —— 它要看到的是**原始**响度，放在 EQ 后面会被我们自己改过的
 *      频谱骗到，归一化目标就不准了（而且它开销最大，越早越省）。
 *   2. `firequalizer`（仅在开「精细音色」时）紧随其后 ——
 *      注意它**只能给整体增益**，分段的音色调整由 `equalizer` 逐段完成
 *      （原因见文件头：多段 `gain_entry` 在 af 串里表达不出来）。
 *   3. `extrastereo`（宽度）→ `stereotools`（crossfeed）：都在**下混之前**处理，
 *      顺序按「先展开声场、再把左右适度互串」，反过来的话展开会把互串也放大。
 *   4. `acompressor` + `alimiter` 收尾 —— 动态与峰值控制永远是**最后**一道，
 *      放前面的话后面抬起来的增益就没人管了（这正是「加音量就破音」的常见原因）。
 *   5. `scaletempo2`（变速）由 `opts.speed` 追加在**最末**：它只关心时域重采样，
 *      与音色无关，但必须真的挂在链上，否则变速会变调（v0.2.9 的教训）。
 *
 * @param opts.filterNames 只保留名字在这个集合里的滤镜（自检用，便于逐个验证）
 */
export function buildAudioFilterChain(
  raw: unknown,
  opts: { speed?: number; filterNames?: string[] } = {}
): string {
  const s = resolveAudioSettings(raw)
  const chain: string[] = []
  const want = (name: string): boolean => !opts.filterNames || opts.filterNames.includes(name)

  if (s.enabled) {
    if (s.loudnormEnabled && want('loudnorm')) {
      chain.push(`loudnorm=I=${s.loudnormTarget}:TP=-1.5:LRA=11`)
    }

    if (s.eqEnabled) {
      if (want('equalizer')) chain.push(...eqFiltersFor(s.eqGains))
      if (s.eqLinearPhase && want('firequalizer')) {
        chain.push('firequalizer=gain=0:zero_phase=on')
      }
    }

    if (s.stereoWidth > 1.001 && want('extrastereo')) {
      chain.push(`extrastereo=m=${s.stereoWidth.toFixed(2)}`)
    }

    if (s.crossfeed < 0.999 && want('stereotools')) {
      /*
       * stereotools 的 `mlev` 是「中间声道电平」：1 = 原样，越小左右互串越多
       * （耳机上声场更靠前、久听不累）。0.4 以下就明显发闷了，所以界面限制在 0.2~1。
       */
      chain.push(`stereotools=mlev=${Math.max(0.2, s.crossfeed).toFixed(2)}:slev=1`)
    }

    if (s.compressorEnabled && want('acompressor')) {
      // 温和压缩：阈值 -18dB、2:1，攻击慢一点以免吃掉人声的起音
      chain.push(
        `acompressor=threshold=-18dB:ratio=2:attack=20:release=250:makeup=${s.compressorMakeup.toFixed(2)}`
      )
    }

    if (needsLimiter(s) && want('alimiter')) {
      // 0.97 ≈ -0.26dBFS，留一点余量给编码器的 inter-sample peak
      chain.push('alimiter=limit=0.97:attack=5:release=50')
    }
  }


  if (opts.speed !== undefined && opts.speed !== 1 && want('scaletempo2')) {
    chain.push('scaletempo2=max-speed=8')
  }
  return chain.join(',')
}

/**
 * 「这条链里有没有滤镜」的判定 —— 用来决定是 `af set` 还是 `af clr`。
 * 空链必须走 clr，否则 mpv 会保留上一次的滤镜（用户关掉增强却还在生效）。
 */
export function hasFilterChain(raw: unknown, opts: { speed?: number } = {}): boolean {
  return buildAudioFilterChain(raw, opts).length > 0
}

/* ─────────────── 音色响应曲线（设置页的可视化） ─────────────── */

/**
 * 采样频率点（Hz）：对数刻度，20Hz~20kHz —— 与人耳可听范围一致。
 * 用对数而不是线性：线性刻度下 20Hz~1kHz 会被挤成左边一小撮，完全看不出低频在干什么。
 */
export const EQ_CURVE_MIN_HZ = 20
export const EQ_CURVE_MAX_HZ = 20000

/**
 * 算出当前 EQ 设置的**合成频率响应**（dB），用来在设置页画曲线。
 *
 * 为什么这是"真数据"：它是把每个 `equalizer` 段（双极点 peaking，中心频率 f、Q=1.414、
 * 增益 g）的**解析传递函数**逐点相加得到的 —— 也就是说，画出来的曲线就是用户实际会听到的
 * 频响，而不是随便画一条跟着滑杆动的线。
 *
 * 双极点 peaking 的幅频响应（归一化，A = 10^(g/40)）：
 *   |H(f)|² = ((f² − f0²)² + (A·f·f0/Q)²) / ((f² − f0²)² + (f·f0/(A·Q))²)
 * 单段结果取 20·log10|H|（dB），多段**直接相加**（dB 相加 = 幅频相乘，
 * 这也正是串联多个滤波器在频域上的效果）。
 *
 * @param gains 10 段增益（dB），顺序与 EQ_BANDS 一致
 * @param points 采样点数（默认 160，够画一条顺滑的曲线又不浪费）
 * @returns `{ hz, db }`，索引一一对应；hz 为对数等分
 */
export function eqResponseCurve(
  gains: number[],
  points = 160
): { hz: number[]; db: number[] } {
  const Q = 1.414
  const hz: number[] = []
  const db: number[] = []
  const lo = Math.log10(EQ_CURVE_MIN_HZ)
  const hi = Math.log10(EQ_CURVE_MAX_HZ)
  for (let i = 0; i < points; i++) {
    const f = Math.pow(10, lo + ((hi - lo) * i) / (points - 1))
    hz.push(f)
    let sum = 0
    for (let b = 0; b < EQ_BAND_COUNT; b++) {
      const g = Number(gains[b] ?? 0)
      if (!Number.isFinite(g) || Math.abs(g) < 0.01) continue
      const f0 = EQ_BANDS[b]
      const A = Math.pow(10, g / 40)
      const x = f / f0
      const num = Math.pow(x * x - 1, 2) + Math.pow((A * x) / Q, 2)
      const den = Math.pow(x * x - 1, 2) + Math.pow(x / (A * Q), 2)
      // 数值兜底：极端参数下 den 可能极小，加一个下限避免 log(0) → -Infinity
      sum += 10 * Math.log10(Math.max(num / Math.max(den, 1e-12), 1e-12))
    }
    db.push(sum)
  }
  return { hz, db }
}


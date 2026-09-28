import { useEffect, useState } from 'react'
import { CheckCircle2, MonitorPlay, RefreshCw, Sparkles, TriangleAlert, XCircle } from 'lucide-react'
import type { PlayerAssets } from '@shared/api'
import {
  ANIME4K_MODES,
  ANIME4K_TIERS,
  ANIME4K_TONE_MAPPINGS,
  ANIME4K_TUNE_RANGE,
  anime4kChain,
  type Anime4kMode
} from '@shared/anime4k'
/*
 * 音频设置（v0.3.6）：`EQ_PRESETS` / `EQ_BANDS` / `resolveAudioSettings` 与主进程用的是
 * **同一份** `@shared/audio` —— 界面上显示的段数、默认值、收窄规则都与真正下发给 mpv 的一致，
 * 不会出现「界面写着 125% 实际内核收到 100%」这类分叉。
 */
import {
  EQ_BANDS,
  EQ_BAND_COUNT,
  EQ_CURVE_MAX_HZ,
  EQ_CURVE_MIN_HZ,
  EQ_GAIN_MAX,
  EQ_GAIN_MIN,
  EQ_PRESETS,
  eqResponseCurve,
  resolveAudioSettings,
  type AudioSettings
} from '@shared/audio'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, Input, Switch } from '@/components/ui'
import { AssetLink, Card, SubPage, type BuiltinAsset } from '@/components/SettingsShell'
import { ShortcutsPanel } from './ShortcutsPage'

/** 内置组件状态行 */
function AssetRow({ name, ok, hint }: { name: string; ok: boolean | null; hint: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="flex items-center gap-2 text-xs text-dim">
        {ok == null ? (
          <RefreshCw size={13} className="animate-spin text-faint" />
        ) : ok ? (
          <CheckCircle2 size={13} className="text-ok" />
        ) : (
          <XCircle size={13} className="text-danger" />
        )}
        {name}
      </span>
      <span className="text-right text-[11px] text-faint">{ok == null ? '检测中…' : ok ? hint : '未内置（需自行安装）'}</span>
    </div>
  )
}

/** 画面微调滑杆：默认值域 -100~100（0 = 原始画面）；音频那边用 min/max/suffix 覆盖 */
function TuneSlider({
  label,
  hint,
  value,
  onChange,
  min = ANIME4K_TUNE_RANGE.min,
  max = ANIME4K_TUNE_RANGE.max,
  step = ANIME4K_TUNE_RANGE.step,
  suffix = '',
  zeroAt
}: {
  label: string
  hint: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  /** 数值后缀（例如 % / LUFS） */
  suffix?: string
  /** 哪个值算「中性」（显示成灰色）。默认 0；音量增益那类滑杆的中性值不是 0 */
  zeroAt?: number
}) {
  const neutral = zeroAt ?? 0
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text">
          {label}
          <span className="ml-2 text-[10px] text-faint">{hint}</span>
        </span>
        <span className={`w-16 text-right font-mono text-[11px] ${value === neutral ? 'text-faint' : 'text-accent'}`}>
          {value > neutral ? `+${value}` : value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-elev2 accent-accent"
      />
    </div>
  )
}

/** 卡片内的分隔线（与设置总览页同名同款，保持视觉一致） */
function RowDivider() {
  return <div className="my-1 border-t border-border" />
}

/**
 * 「开关 + 标题 + 说明」一行的通用排布（v0.3.6）。
 *
 * 为什么抽出来：音频卡片里有 **7 个**这样的一行（启用增强 / 削波保护 / 均衡器 /
 * 精细音色 / 动态压缩 / 响度归一化 / 截图剪贴板），
 * 各写一遍不仅重复，更麻烦的是**自动化自检没法稳定找到某一个开关** ——
 * 没有稳定锚点时只能靠"先找到文字再往上找父元素再 querySelector('button')"这种脆弱写法，
 * 实测就踩过：点击落到了相邻的滑杆上（presets 与 eqBands 都读到 0）。
 * 于是给每个开关一个 `data-audio-switch` 锚点：结构稳定、探针能精确定位、也不影响外观。
 */
function SwitchRow({
  id,
  title,
  desc,
  checked,
  onChange,
  children
}: {
  /** 稳定锚点（自检用；见上面的说明） */
  id: string
  title: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
  /** 开关下方的附加内容（例如展开后的滑杆） */
  children?: React.ReactNode
}) {
  return (
    <div className="py-1.5" data-audio-row={id}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-text">{title}</div>
          <div className="mt-0.5 text-[10px] leading-snug text-faint">{desc}</div>
        </div>
        <span data-audio-switch={id}>
          <Switch checked={checked} onChange={onChange} />
        </span>
      </div>
      {children}
    </div>
  )
}

/**
 * 音色响应曲线（v0.3.6）。
 *
 * 用 SVG 画而不是 canvas：这条曲线**不需要**逐帧刷新（只有用户改设置时才变），
 * SVG 天生随容器缩放、也能直接跟着主题的 CSS 变量上色，比 canvas 省一大截代码。
 *
 * 纵轴固定 ±15dB：这是「看得出形状」与「不被极端值压扁」的折中 ——
 * 单段最大 ±12dB，叠加后偶尔破 15，超出的部分**夹在边上**（不画到框外）。
 */
function EqCurve({ gains }: { gains: number[] }) {
  const W = 560
  const H = 120
  const PAD = 6
  const { hz, db } = eqResponseCurve(gains, 200)
  const DB_MAX = 15
  const x = (f: number): number => {
    const lo = Math.log10(EQ_CURVE_MIN_HZ)
    const hi = Math.log10(EQ_CURVE_MAX_HZ)
    return PAD + ((Math.log10(f) - lo) / (hi - lo)) * (W - PAD * 2)
  }
  const y = (v: number): number => {
    const clamped = Math.max(-DB_MAX, Math.min(DB_MAX, v))
    return PAD + ((DB_MAX - clamped) / (DB_MAX * 2)) * (H - PAD * 2)
  }
  const path = hz.map((f, i) => `${i === 0 ? 'M' : 'L'}${x(f).toFixed(1)},${y(db[i]).toFixed(1)}`).join(' ')
  const active = db.some((v) => Math.abs(v) > 0.05)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-[120px] w-full" role="img" aria-label="音色响应曲线">
      {/* 0dB 基准线 + 每 5dB 的刻度线：没有基准线就看不出"抬了多少" */}
      {[-10, -5, 0, 5, 10].map((g) => (
        <line
          key={g}
          x1={PAD}
          x2={W - PAD}
          y1={y(g)}
          y2={y(g)}
          stroke={g === 0 ? 'var(--color-border)' : 'var(--color-elev3)'}
          strokeWidth={g === 0 ? 1 : 0.6}
          strokeDasharray={g === 0 ? '' : '3 4'}
        />
      ))}
      {/* 每个滑杆的中心频率画一条竖线，让曲线和推子位置对得上 */}
      {EQ_BANDS.map((f) => (
        <line key={f} x1={x(f)} x2={x(f)} y1={PAD} y2={H - PAD} stroke="var(--color-elev3)" strokeWidth={0.5} />
      ))}
      {active ? (
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={1.6} strokeLinejoin="round" />
      ) : (
        <text x={W / 2} y={H / 2} textAnchor="middle" dominantBaseline="middle" className="fill-faint text-[11px]">
          均衡器未启用（曲线为一条 0dB 直线）
        </text>
      )}
      {/* 频率刻度 */}
      {[100, 1000, 10000].map((f) => (
        <text key={f} x={x(f)} y={H - 1} textAnchor="middle" className="fill-faint text-[8px]">
          {f >= 1000 ? `${f / 1000}k` : f}
        </text>
      ))}
    </svg>
  )
}

export function PlayerSettingsPage() {
  const { settings, save } = useSettings()
  const [assets, setAssets] = useState<PlayerAssets | null>(null)
  const [checking, setChecking] = useState(false)

  const detect = async (): Promise<void> => {
    setChecking(true)
    const r = await api.player.assets()
    setChecking(false)
    if (r.ok) setAssets(r.data)
    else toast.error(r.error)
  }

  useEffect(() => {
    void detect()
  }, [])

  const builtinOf = (a: BuiltinAsset): boolean | null => {
    if (!assets) return null
    return a === 'ffmpeg' ? assets.ffmpeg : assets.aria2
  }

  // libmpv 可用（运行时 + 原生插件都在）——VLC 内核已删除，这里只用于提示是否缺运行时
  const mpvUsable = !!assets?.mpv

  /*
   * Anime4K（v0.3.1）：设置里只存「模式 + 档位 + 自定义列表 + 微调值」，
   * 真正拼链在 @shared/anime4k，主进程与这里用同一份表 —— 界面显示的
   * 执行顺序就是 mpv 实际的执行顺序。
   */
  const a4k = settings.anime4k ?? {}
  const patchA4k = (patch: Partial<NonNullable<typeof settings.anime4k>>): void => {
    save({ anime4k: { ...a4k, ...patch } })
  }
  const a4kMode: Anime4kMode = a4k.mode ?? 'A'
  const a4kTier = a4k.tier ?? 'fast'
  const a4kChain = anime4kChain(a4kMode, a4kTier, a4k.custom)

  /*
   * 音频（v0.3.6）：界面上的值一律取自 `resolveAudioSettings`（与主进程同源），
   * 写回时只 patch 变化的字段 —— 这样旧设置文件里没有的字段也不会被界面覆盖成 undefined。
   */
  const audio = resolveAudioSettings(settings.audio)
  const patchAudio = (patch: Partial<AudioSettings>): void => {
    save({ audio: { ...(settings.audio ?? {}), ...patch } })
  }
  const a4kMissing = assets !== null && assets.anime4k === false
  const installedShaders = assets?.shaders ?? []

  return (
    <SubPage
      icon={MonitorPlay}
      title="播放器设置"
      desc="播放内核（libmpv）、FFmpeg 路径与播放器快捷键"
      actions={
        <Button size="sm" variant="outline" icon={RefreshCw} loading={checking} onClick={() => void detect()}>
          重新检测
        </Button>
      }
    >
      {/*
        播放器内核（v0.2.9）：VLC 内核已整体删除，这里不再让用户选内核，
        只显示当前内核状态 —— 免得留一个「选了也没用」的开关。
      */}
      <Card title="播放内核" desc="应用内置 libmpv（原生插件 + 子窗口输出），无需安装其它播放器">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-text">libmpv</div>
            <span
              className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${
                mpvUsable ? 'bg-ok/15 text-ok' : 'bg-elev2 text-faint'
              }`}
            >
              {assets === null ? '检测中' : mpvUsable ? '可用' : '缺失'}
            </span>
          </div>
          <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2.5 text-[11px] leading-relaxed text-dim">
            <span className="font-semibold text-text">说明：</span>
            <span className="text-faint">
              libmpv 由项目自带原生插件驱动（N-API 动态加载 libmpv-2.dll，在窗口内创建输出子窗口），
              控制栏 / 选集 / 字幕 / 弹幕全部走同一套实现。原生运行时缺失时开发环境需运行
              <code className="mx-1 font-mono">npm run libmpv:fetch</code> 与
              <code className="mx-1 font-mono">npm run mpv:build</code>。
            </span>
          </div>
        </div>
      </Card>

      {/* Anime4K 超分辨率 + 画面微调（v0.3.1） */}
      <Card
        title="Anime4K 超分辨率"
        desc="内置于安装目录的 Anime4K v4.0.1 GPU 着色器：实时修复线条、放大到屏幕分辨率；改动当场生效"
      >
        <div className="flex flex-col gap-3">
          {/* ① 总开关 */}
          <label className="flex items-center gap-2 text-xs text-text">
            <input
              type="checkbox"
              checked={a4k.enabled === true}
              onChange={(e) => patchA4k({ enabled: e.target.checked })}
              className="h-3.5 w-3.5 accent-accent"
            />
            <Sparkles size={13} className="text-accent" />
            启用 Anime4K 超分辨率
            <span className="text-[10px] text-faint">（需要 libmpv 内核；着色器随包内置，无需另外下载）</span>
          </label>

          {a4kMissing && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              <span>
                安装目录里没有找到着色器（应为 <code className="font-mono">resources/shaders/*.glsl</code>）。
                安装包不完整时会这样，重装一次即可；此开关暂时不会有效果。
              </span>
            </div>
          )}

          {/* ② 模式 */}
          <div>
            <div className="mb-1.5 text-xs font-semibold text-text">模式</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ANIME4K_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => patchA4k({ mode: m.id })}
                  className={`rounded-xl border px-2.5 py-2 text-left transition-colors ${
                    a4kMode === m.id ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent/50'
                  }`}
                >
                  <div className="text-xs font-semibold text-text">{m.short}</div>
                  <div className="mt-0.5 text-[10px] leading-snug text-faint">{m.desc}</div>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
              {ANIME4K_MODES.find((m) => m.id === a4kMode)?.target}
            </p>
          </div>

          {/* ③ 显卡档位（自定义模式不需要） */}
          {a4kMode !== 'custom' && (
            <div>
              <div className="mb-1.5 text-xs font-semibold text-text">显卡档位</div>
              <div className="flex gap-2">
                {ANIME4K_TIERS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => patchA4k({ tier: t.id })}
                    className={`flex-1 rounded-xl border px-3 py-2 text-left transition-colors ${
                      a4kTier === t.id ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent/50'
                    }`}
                  >
                    <div className="text-xs font-semibold text-text">{t.label}</div>
                    <div className="mt-0.5 text-[10px] leading-snug text-faint">{t.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ④ 自定义模式的着色器勾选（只列安装目录里真实存在的文件） */}
          {a4kMode === 'custom' && (
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-text">着色器（勾选顺序 = 执行顺序）</span>
                {(a4k.custom ?? []).length > 0 && (
                  <button className="text-[11px] text-accent hover:underline" onClick={() => patchA4k({ custom: [] })}>
                    清空
                  </button>
                )}
              </div>
              {installedShaders.length === 0 ? (
                <p className="text-[11px] text-faint">读取不到着色器列表（安装目录不完整）。</p>
              ) : (
                <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-elev2/40 p-2">
                  <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
                    {installedShaders.map((f) => {
                      const picked = (a4k.custom ?? []).includes(f)
                      const index = (a4k.custom ?? []).indexOf(f)
                      return (
                        <label key={f} className="flex items-center gap-2 py-0.5 text-[11px] text-dim">
                          <input
                            type="checkbox"
                            checked={picked}
                            onChange={(e) => {
                              const cur = a4k.custom ?? []
                              patchA4k({ custom: e.target.checked ? [...cur, f] : cur.filter((x) => x !== f) })
                            }}
                            className="h-3 w-3 shrink-0 accent-accent"
                          />
                          <span className="truncate font-mono" title={f}>
                            {picked && <span className="mr-1 text-accent">{index + 1}.</span>}
                            {f.replace(/^Anime4K_/, '').replace(/\.glsl$/, '')}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
              <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                同一个着色器只能用一次；<code className="font-mono">Clamp_Highlights</code> 建议放第一位（防振铃），
                <code className="mx-1 font-mono">AutoDownscalePre_x2</code> 要紧跟第一个放大着色器。
              </p>
            </div>
          )}

          {/* ⑤ 实际执行链预览（就是 mpv 收到的那串路径，按顺序） */}
          {a4kMode !== 'custom' && (
            <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2 text-[11px] leading-relaxed text-dim">
              <span className="font-semibold text-text">执行顺序：</span>
              {a4kChain.length === 0 ? (
                <span className="text-faint">（空）</span>
              ) : (
                <span className="font-mono text-faint">
                  {a4kChain.map((f) => f.replace(/^Anime4K_/, '').replace(/\.glsl$/, '')).join(' → ')}
                </span>
              )}
            </div>
          )}

          {/* ⑥ 画面微调 */}
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-text">画面微调</span>
              <button
                className="text-[11px] text-accent hover:underline"
                onClick={() => patchA4k({ saturation: 0, contrast: 0, brightness: 0, gamma: 0 })}
              >
                恢复默认
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <TuneSlider
                label="饱和度"
                hint="色彩浓淡"
                value={a4k.saturation ?? 0}
                onChange={(v) => patchA4k({ saturation: v })}
              />
              <TuneSlider
                label="对比度"
                hint="明暗反差"
                value={a4k.contrast ?? 0}
                onChange={(v) => patchA4k({ contrast: v })}
              />
              <TuneSlider
                label="亮度"
                hint="整体提亮/压暗"
                value={a4k.brightness ?? 0}
                onChange={(v) => patchA4k({ brightness: v })}
              />
              <TuneSlider label="伽马" hint="中间调" value={a4k.gamma ?? 0} onChange={(v) => patchA4k({ gamma: v })} />
            </div>
          </div>

          {/* ⑦ HDR */}
          <div className="rounded-lg border border-border bg-elev2/40 px-3 py-2.5">
            <label className="flex items-center gap-2 text-xs text-text">
              <input
                type="checkbox"
                checked={a4k.hdr?.passthrough === true}
                onChange={(e) => patchA4k({ hdr: { ...a4k.hdr, passthrough: e.target.checked } })}
                className="h-3.5 w-3.5 accent-accent"
              />
              HDR 直通显示器（<code className="font-mono">target-colorspace-hint</code>）
            </label>
            <p className="mt-1 text-[10px] leading-relaxed text-faint">
              仅在「HDR 片源 + 支持 HDR 的显示器 + 系统已开启 HDR」三者同时满足时才有意义；
              不满足时会出现画面发灰发暗，那就把它关掉。
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-dim">色调映射</span>
              <select
                value={a4k.hdr?.toneMapping ?? 'auto'}
                onChange={(e) => patchA4k({ hdr: { ...a4k.hdr, toneMapping: e.target.value } })}
                className="rounded-lg border border-border bg-elev1 px-2 py-1 text-[11px] text-text"
              >
                {ANIME4K_TONE_MAPPINGS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} — {t.desc}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-dim">目标峰值</span>
              <input
                type="number"
                min={0}
                max={4000}
                step={50}
                value={a4k.hdr?.targetPeak ?? 0}
                onChange={(e) =>
                  patchA4k({ hdr: { ...a4k.hdr, targetPeak: Math.max(0, Number(e.target.value) || 0) } })
                }
                className="w-20 rounded-lg border border-border bg-elev1 px-2 py-1 text-[11px] text-text"
              />
              <span className="text-[10px] text-faint">nits，0 = auto（按显示器上报值）</span>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-faint">
            着色器链取自 Anime4K v4.0.1 官方 mpv 模板（流畅档 = Low-end、画质档 = High-end），
            文件位于安装目录的 <code className="font-mono">resources/shaders</code>。
            这些选项对 mpv 都是运行时属性，<span className="text-dim">在播放中修改也会立刻生效</span>；
            若显卡跟不上（24fps 需要单帧 ≤41ms），把档位换成「流畅优先」或改用模式 C。
            按 <code className="font-mono">Shift+I</code> 再按 <code className="font-mono">2</code> 可看 mpv 自己的渲染耗时统计。
          </p>
        </div>
      </Card>

      {/* 播放器控制栏（v0.2.18 引入 uosc；**v0.3.3 起默认改回应用自己的控制栏**） */}
      <Card
        title="播放器控制栏"
        desc="默认使用应用自己的悬浮窗控制栏（含超分/画质按钮）；也可切换成 mpv 的 uosc 控制栏"
      >
        <div className="flex flex-col gap-2.5">
          <label className="flex items-center gap-2 text-xs text-text">
            <input
              type="checkbox"
              checked={settings.uoscControlBar === true}
              onChange={(e) => save({ uoscControlBar: e.target.checked })}
              className="h-3.5 w-3.5 accent-accent"
            />
            改用 mpv 的 uosc 控制栏（实验性）
          </label>
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="font-semibold text-text">默认（不勾选）：</span>
            用应用自己的悬浮窗控制栏 —— 进度条、播放控制、选集、字幕、倍速、画面比例、弹幕、
            <span className="text-dim">画质（Anime4K 超分）</span>、全屏与退出都在里面，
            按钮与菜单都是应用自己的界面，改起来、查起来都最直接。
          </p>
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="font-semibold text-text">勾选后：</span>
            控制栏改由 mpv 的 uosc 绘制（画在视频画面上）。布局与时间显示在
            <code className="mx-1 font-mono">resources/mpv-config/script-opts/uosc.conf</code>
            ，快捷键在
            <code className="mx-1 font-mono">resources/mpv-config/input.conf</code>
            ，按钮与菜单由
            <code className="mx-1 font-mono">resources/mpv-scripts/sakana-uosc-ctrl.lua</code>
            驱动。
            <span className="text-dim">
              {' '}
              切换在<strong className="font-medium">下次进入播放器</strong>时生效；无论用哪一个，
              弹幕画布、番剧详情浮层、选集抽屉都不受影响。
            </span>
          </p>
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="font-semibold text-text">uosc 模式怎么唤出：</span>
            鼠标移到画面下方（或任意位置移动，应用会主动唤出），控制栏就会浮现；
            <span className="text-dim">键盘兜底：</span>按 <code className="font-mono">Tab</code> 可显隐整条控制栏。
          </p>
        </div>
      </Card>

      {/*
        ── 音频（音质调控）（v0.3.6）──────────────────────────────────────────────
        全部设置都存在 `settings.audio`，由 `@shared/audio` 收窄并拼成 ffmpeg 的 `af` 滤镜链，
        主进程写设置的钩子里会重应用一次 —— 所以这里动任何一项，正在播放的声音立刻变。

        ⚠️ 界面上要**如实说明哪些做了、哪些没做**（见卡片底部的说明）：
        用户原话里点名的 firequalizer（线性相位 FIR）、sofalizer（HRTF 空间音频）经真机探针
        验证在 libmpv 的 af 串里无法表达（原因写在 @shared/audio 文件头），
        这里不能装作有 —— 否则用户调半天听不出差别，只会以为是坏了。
      */}
      <Card title="音频（音质调控）" desc="音量增益、均衡器、动态与降噪。改动立刻生效（播放中可听）">
        {/* ① 总开关 + 音量增益 */}
        <RowDivider />
        <SwitchRow
          id="enabled"
          title="启用音质增强"
          desc="关掉 = 完全原声（所有滤镜都不挂，音量增益仍然可用）"
          checked={audio.enabled !== false}
          onChange={(v) => patchAudio({ enabled: v })}
        />
        <RowDivider />
        <div className="py-2">
          {/*
            音量增益：用户明确说「100% 也有点偏小，可能要增加 0.25 倍左右」，
            所以默认就是 125%，上限 200%（mpv 的 volume-max 也同步抬到 200，否则会被夹回 100）。
          */}
          <TuneSlider
            label="音量增益"
            hint="默认 125%：解决「100% 也偏小」；超过 100% 会由限幅器防削波"
            value={Math.round((audio.gain ?? 1.25) * 100) - 100}
            min={-100}
            max={100}
            step={5}
            suffix="%"
            onChange={(v) => patchAudio({ gain: (100 + v) / 100 })}
          />
          <SwitchRow
            id="clipping"
            title="削波保护（限幅器）"
            desc="音量超过 100% 或有正增益时自动挂 alimiter；关掉会更「冲」，但大音量素材可能破音"
            checked={audio.clippingProtection !== false}
            onChange={(v) => patchAudio({ clippingProtection: v })}
          />
        </div>

        {/* ② 均衡器 */}
        <RowDivider />
        <SwitchRow
          id="eq"
          title="均衡器（10 段）"
          desc="逐段 ±12dB，能升也能降（每段一个 equalizer 滤镜，Q≈1 倍频程）"
          checked={audio.eqEnabled === true}
          onChange={(v) => patchAudio({ eqEnabled: v })}
        >
          {audio.eqEnabled ? (
            <div data-audio-eq="open">
              {/* 预设 */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {EQ_PRESETS.map((p) => {
                  const on = (audio.eqPreset ?? 'flat') === p.id
                  return (
                    <button
                      key={p.id}
                      title={p.desc}
                      onClick={() => patchAudio({ eqPreset: p.id, eqGains: [...p.gains] })}
                      className={`rounded-lg border px-2 py-1 text-[11px] transition-colors ${
                        on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-dim hover:border-accent/50'
                      }`}
                    >
                      {p.name}
                    </button>
                  )
                })}
              </div>
              <div className="mt-1 text-[10px] text-faint">
                {EQ_PRESETS.find((p) => p.id === (audio.eqPreset ?? 'flat'))?.desc ?? ''}
              </div>

              {/*
                10 段推子：**分两行**（v0.3.6 按用户要求改）。
                为什么必须分两行：10 个竖排推子挤在 700px 的小窗里时，
                每段只剩 40px 不到，滑杆只有 6px 宽、鼠标很难精确抓到某一格；
                而且频率标签（16k）在那个宽度下会被截断。
                现在每行 5 段（低频 31–500 / 高频 1k–16k），横向空间翻倍，
                数字不再被截断、拖动也稳。行的划分与 EQ_BANDS 的顺序一致，用户看曲线时不会错位。
              */}
              <div className="mt-3 space-y-3">
                {[0, 1].map((row) => (
                  <div key={row} className="flex items-end justify-between gap-2">
                    {EQ_BANDS.slice(row * 5, row * 5 + 5).map((f, k) => {
                      const i = row * 5 + k
                      const g = audio.eqGains?.[i] ?? 0
                      return (
                        <div key={f} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                          <span
                            className={`font-mono text-[10px] ${Math.abs(g) < 0.05 ? 'text-faint' : 'text-accent'}`}
                          >
                            {g > 0 ? `+${g.toFixed(0)}` : g.toFixed(0)}
                          </span>
                          <input
                            type="range"
                            min={EQ_GAIN_MIN}
                            max={EQ_GAIN_MAX}
                            step={1}
                            value={g}
                            data-eq-band={i}
                            title={`${f >= 1000 ? `${f / 1000}kHz` : `${f}Hz`}：${g > 0 ? '+' : ''}${g}dB`}
                            onChange={(e) => {
                              const next = [...(audio.eqGains ?? new Array(EQ_BAND_COUNT).fill(0))]
                              next[i] = Number(e.target.value)
                              // 手调过之后预设就"对不上"了，清掉 id 让界面不再高亮某个预设
                              patchAudio({ eqGains: next, eqPreset: '' })
                            }}
                            /* 竖排推子：writing-mode 是标准做法，Chromium 支持 */
                            className="h-20 w-2 cursor-pointer appearance-none rounded-full bg-elev2 accent-accent"
                            style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                          />
                          <span className="font-mono text-[10px] text-faint">
                            {f >= 1000 ? `${f / 1000}k` : f}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>

              <div className="mt-2">
                <SwitchRow
                  id="linear-phase"
                  title="精细音色（线性相位）"
                  desc="额外挂一条 firequalizer zero_phase。它只有整体增益、没有分段；听不出差别就别开"
                  checked={audio.eqLinearPhase === true}
                  onChange={(v) => patchAudio({ eqLinearPhase: v })}
                />
              </div>
            </div>
          ) : null}
        </SwitchRow>

        {/* ③ 立体声与耳机 */}
        <RowDivider />
        <div className="py-2">
          <TuneSlider
            label="立体声宽度"
            hint="100% = 原样；调大左右分离更明显（多声道源更明显）"
            value={Math.round((audio.stereoWidth ?? 1) * 100) - 100}
            min={-100}
            max={200}
            step={5}
            suffix="%"
            onChange={(v) => patchAudio({ stereoWidth: (100 + v) / 100 })}
          />
          <div className="mt-3">
            <TuneSlider
              label="耳机串音（crossfeed）"
              hint="100% = 关闭；调小左右互串更多，耳机久听不累、声场更靠前"
              value={Math.round((audio.crossfeed ?? 1) * 100)}
              min={20}
              max={100}
              step={5}
              suffix="%"
              onChange={(v) => patchAudio({ crossfeed: v / 100 })}
            />
          </div>
        </div>

        {/* ④ 动态与响度 */}
        <RowDivider />
        <div className="py-2">
          <SwitchRow
            id="compressor"
            title="动态压缩"
            desc="把大声音压小、小声音抬起来：深夜小音量看番时对白更清楚（-18dB / 2:1）"
            checked={audio.compressorEnabled === true}
            onChange={(v) => patchAudio({ compressorEnabled: v })}
          />
          <SwitchRow
            id="loudnorm"
            title="响度归一化"
            desc={`不同片源音量忽大忽小？统一到 ${audio.loudnormTarget ?? -16} LUFS（EBU R128）`}
            checked={audio.loudnormEnabled === true}
            onChange={(v) => patchAudio({ loudnormEnabled: v })}
          >
            {audio.loudnormEnabled ? (
              <div className="mt-3">
                <TuneSlider
                  label="目标响度"
                  hint="数值越大越响；-16 比广播标准（-23）更响一点，-14 更冲"
                  value={audio.loudnormTarget ?? -16}
                  min={-26}
                  max={-10}
                  step={1}
                  suffix=" LUFS"
                  onChange={(v) => patchAudio({ loudnormTarget: v })}
                />
              </div>
            ) : null}
          </SwitchRow>
        </div>

        {/* ⑤ 音色响应曲线 + 截图剪贴板 */}
        <RowDivider />
        <div className="py-2">
          {/*
            音色响应曲线：**由用户自己的 EQ 增益算出来的合成频响**（见 @shared/audio 的
            `eqResponseCurve`），不是跟着滑杆动的装饰动画 —— 上面每个推子动一下，这条曲线
            就跟着变形，能直接看出「我这一拨到底抬了哪一段、抬了多少」。
            这也是本版对「可视化」的交付方式：真正能反映声音的东西，而不是假动画（见下方说明）。
          */}
          <div className="text-xs font-semibold text-text">音色响应曲线</div>
          <div className="mt-0.5 text-[10px] leading-snug text-faint">
            当前均衡器设置会把各频段抬高/压低多少（对数刻度 20Hz–20kHz，竖直范围 ±15dB）
          </div>
          <EqCurve gains={audio.eqEnabled ? (audio.eqGains ?? []) : []} />
        </div>

        <RowDivider />
        <SwitchRow
          id="clipboard"
          title="截图后自动复制到剪贴板"
          desc="在聊天/文档里直接 Ctrl+V 就能粘贴；同时会进入 Win+V 剪贴板历史。注意这会顶掉剪贴板里原有的内容（截图本身照常存盘）"
          checked={settings.screenshotClipboard !== false}
          onChange={(v) => save({ screenshotClipboard: v })}
        />

        {/* 说明：如实交代哪些没做 */}
        <RowDivider />
        {/*
          ⚠️ 这里的文案**不能写 Markdown**：JSX 里的 `**...**` 会被当成普通星号原样显示给用户
          （审计在几个页面都发现了这个毛病）。要强调就用 <span className="text-dim"> 之类的样式。
        */}
        <div className="space-y-1.5 pt-2 text-[10px] leading-relaxed text-faint">
          <div className="text-dim">关于两条点名、但本版没有做的功能（均为真机实测结论）：</div>
          <div>
            · <span className="text-dim">firequalizer 的多段线性相位 EQ</span>：它用分号分隔各频段，
            而分号在 mpv 的 af 串里是「另一条链」的分隔符，转义成反斜杠加分号也过不去（试过 6 种写法）。
            所以均衡器改用<strong className="font-medium text-dim">能升能降的 10 段 equalizer 逐段串联</strong>，
            另提供上面那个「精细音色」开关来拿线性相位的味道。
          </div>
          <div>
            · <span className="text-dim">sofalizer（HRTF 虚拟环绕）</span>：需要外部 .sofa HRTF 数据文件，
            应用没有随包分发这类文件（体积大且有授权问题），所以空间音频用 crossfeed 近似。
          </div>
          <div>
            · <span className="text-dim">播放器上的实时频谱/电平可视化</span>：libmpv 不把音频采样交给宿主，
            它的 astats 滤镜 metadata（<code className="font-mono">af-metadata</code>）实测读出来是 null，
            拿不到任何真实音频数据。与其画一个跟声音无关的假动画，不如画上面那条
            <strong className="font-medium text-dim">由你自己的 EQ 设置算出来的音色响应曲线</strong> ——
            调均衡器时真正想看的其实是它。
          </div>
        </div>
      </Card>

      {/* 画面比例 */}
      <Card title="画面比例" desc="视频与屏幕比例不一致时的填充方式（播放器控制栏右下角也可随时切换）">
        <div className="flex gap-2">
          {(
            [
              { mode: 'fit' as const, label: '适应', desc: '保持原比例，必要时留黑边（默认）' },
              { mode: 'cover' as const, label: '裁剪铺满', desc: '放大裁掉多余部分，铺满画面不变形' },
              { mode: 'stretch' as const, label: '拉伸铺满', desc: '强行拉满整屏，画面会变形' }
            ] as const
          ).map((o) => (
            <button
              key={o.mode}
              onClick={() => save({ aspectMode: o.mode })}
              className={`flex-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                (settings.aspectMode ?? 'fit') === o.mode
                  ? 'border-accent bg-accent-soft'
                  : 'border-border hover:border-accent/50'
              }`}
            >
              <div className="text-xs font-semibold text-text">{o.label}</div>
              <div className="mt-0.5 text-[10px] leading-snug text-faint">{o.desc}</div>
            </button>
          ))}
        </div>
      </Card>

      {/* FFmpeg 配置 */}
      <Card title="FFmpeg 配置" desc="转码回退与在线流中转使用（留空自动使用内置 FFmpeg）">
        <div className="flex flex-col gap-2.5">
          <Input
            placeholder="FFmpeg 路径（留空使用内置，用于转码回退）"
            value={settings.ffmpegPath}
            onChange={(e) => save({ ffmpegPath: e.target.value })}
          />
          <p className="text-[11px] leading-relaxed text-faint">
            当内置解码器无法直接播放（如 HEVC / 10bit / 非常规封装）时，应用会调用 FFmpeg 进行转码或 remux；留空时优先使用随包内置的 FFmpeg，
            填写路径可改用自行安装的版本（指向 ffmpeg.exe 所在目录或可执行文件）。
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <AssetLink asset="ffmpeg" url="https://www.gyan.dev/ffmpeg/builds/" builtin={builtinOf('ffmpeg')} />
          </div>
        </div>
      </Card>

      {/* 播放器快捷键（原独立小窗口内容已并入本页） */}
      <Card title="播放器快捷键" desc="自定义播放器控件快捷键（播放/暂停、快进、音量、选集、截屏等）">
        <ShortcutsPanel />
      </Card>

      {/* B 站弹幕（mpv 脚本，v0.2.8 附加七） */}
      <Card title="B 站弹幕（mpv 脚本）" desc="播放 B 站视频时用 yt-dlp + biliass 抓取并显示弹幕（仅 libmpv 内核生效）">
        <div className="flex flex-col gap-2.5">
          <label className="flex items-center gap-2 text-xs text-text">
            <input
              type="checkbox"
              checked={settings.biliDanmaku?.enabled === true}
              onChange={(e) => save({ biliDanmaku: { ...settings.biliDanmaku, enabled: e.target.checked } })}
              className="h-3.5 w-3.5 accent-accent"
            />
            启用 B 站弹幕（需要自行准备 yt-dlp 与 biliass）
          </label>
          <Input
            placeholder="yt-dlp 可执行文件路径（留空按 PATH 里的 yt-dlp）"
            value={settings.biliDanmaku?.ytdlpPath ?? ''}
            onChange={(e) => save({ biliDanmaku: { ...settings.biliDanmaku, ytdlpPath: e.target.value } })}
          />
          <Input
            placeholder="biliass 可执行文件路径（留空按 PATH 里的 biliass）"
            value={settings.biliDanmaku?.biliassPath ?? ''}
            onChange={(e) => save({ biliDanmaku: { ...settings.biliDanmaku, biliassPath: e.target.value } })}
          />
          <Input
            placeholder="临时目录 tmpdir（必填；留空用应用数据目录下的 tmp/danmaku）"
            value={settings.biliDanmaku?.tmpdir ?? ''}
            onChange={(e) => save({ biliDanmaku: { ...settings.biliDanmaku, tmpdir: e.target.value } })}
          />
          <Input
            placeholder="自定义 mpv 脚本路径（留空使用内置的 sakana-bdanmaku.lua；也可指向你下载的 bdanmaku.lua）"
            value={settings.biliDanmaku?.scriptPath ?? ''}
            onChange={(e) => save({ biliDanmaku: { ...settings.biliDanmaku, scriptPath: e.target.value } })}
          />
          <p className="text-[11px] leading-relaxed text-faint">
            管线：yt-dlp 取弹幕字幕（xml）→ biliass 转 ASS → 挂到播放器上。
            <span className="text-dim"> biliass 在 Windows 上必须有一个可写的临时目录</span>，否则弹幕下载会失败 ——
            留空时应用会自动用「应用数据目录/tmp/danmaku」并把它通过 <code className="font-mono">script-opts=tmpdir=…</code> 传给脚本。
            <span className="text-dim">开关或路径改动在下次进入播放器时生效</span>（libmpv 启动时才加载脚本）。
            运行日志里能看到 <code className="font-mono">[mpv] B 站弹幕脚本已启用</code> 与脚本自己的进度；
            脚本日志写在上面 tmpdir 下的 <code className="font-mono">sakana-bdanmaku.log</code>。
          </p>
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="text-dim">与「弹幕 → 渲染方式」的关系</span>：如果同时把渲染方式选成了 mpv 插件
            （uosc_danmaku），同一部 B 站番剧会出现两份弹幕（一份由本脚本挂成字幕、一份由插件画在画面上），
            建议按需二选一。
          </p>
          <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2 text-[11px] leading-relaxed text-faint">
            需要自行下载的两个组件（本机网络到 GitHub Release 不通，无法随包分发）：
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <button
                className="text-accent hover:underline whitespace-nowrap"
                onClick={() => void api.app.openPath('https://github.com/yt-dlp/yt-dlp/releases')}
              >
                yt-dlp 下载页
              </button>
              <button
                className="text-accent hover:underline whitespace-nowrap"
                onClick={() => void api.app.openPath('https://github.com/yutto-dev/biliass/releases')}
              >
                biliass 下载页
              </button>
            </div>
            <div className="mt-1">
              也可以直接使用社区里的 <code className="font-mono">bdanmaku</code> 脚本：把它下载到本地后填进上面的「自定义 mpv 脚本路径」，
              应用会自动把 tmpdir / ytdlp / biliass 三个参数拼进 <code className="font-mono">script-opts</code> 一并传过去。
            </div>
          </div>
        </div>
      </Card>

      {/* 内置组件与下载链接 */}
      <Card title="内置组件" desc="应用已内置 libmpv 与 FFmpeg，无需安装">
        <div className="flex flex-col gap-2">
          <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2.5 text-[11px] leading-relaxed text-dim">
            <div className="mb-1 font-semibold text-text">开箱即用</div>
            <div className="text-faint">
              安装包已自带 libmpv 播放内核（含原生插件）以及 FFmpeg（转码/在线流中转），无需额外安装；
              aria2c 同样内置，供内置下载器使用。
              点击下面的下载链接时，若检测到已内置会先提示「已内置，通常无需下载」，再次点击才会打开下载页。
            </div>
          </div>

          <div className="rounded-lg border border-border bg-elev1 px-3 py-1.5">
            <AssetRow
              name="libmpv（播放内核 + 原生插件）"
              ok={assets?.mpv ?? null}
              hint="已内置，可播放"
            />
            <div className="border-t border-border" />
            <AssetRow name="FFmpeg（转码/流中转）" ok={assets?.ffmpeg ?? null} hint="已内置" />
            <div className="border-t border-border" />
            <AssetRow name="aria2c（内置下载器）" ok={assets?.aria2 ?? null} hint="已内置" />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <AssetLink
              asset="ffmpeg"
              url="https://www.gyan.dev/ffmpeg/builds/"
              label="下载 FFmpeg（可选）"
              builtin={builtinOf('ffmpeg')}
            />
          </div>
        </div>
      </Card>

      {/* 底部提示 */}
      <p className="text-center text-[11px] text-faint">
        改动实时保存，播放器下次启动/重新播放时生效；下载与缓存目录请在「文件保存配置」「缓存设置」中调整。
      </p>
    </SubPage>
  )
}

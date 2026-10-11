import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { localImgUrl } from '@/lib/format'
import {
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  type GradientLayer,
  type GradientStop
} from '@/stores/recommendTable'
import { Button } from '@/components/ui'
import { gradientCss } from './styles'

/**
 * 编辑模式左右菜单的**共用小件**（v0.3.9）。
 *
 * 为什么单独一个文件：左菜单 7 项、右菜单 3 项里有大量重复的"一个标题 + 一段说明 + 控件"、
 * "数字输入框 + 上下限 + 失焦夹取"、"分段按钮"。各写一遍的话，
 * 光"数字框失焦夹取"这一件事就能在七个地方写出七种行为（有的允许空、有的不允许）。
 */

// ------------------------------------------------------------------
// 面板骨架
// ------------------------------------------------------------------

/** 一段可折叠的菜单项（标题 + 说明 + 内容），标题右边可以放一个状态徽标 */
export function PanelSection({
  title,
  hint,
  right,
  children,
  defaultOpen = false
}: {
  title: string
  hint?: string
  right?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-xl border border-border bg-elev1/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left"
      >
        <ChevronDown
          size={13}
          className={`shrink-0 text-faint transition-transform ${open ? '' : '-rotate-90'}`}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-dim">{title}</span>
        {right ? <span className="shrink-0 text-[10px] text-faint">{right}</span> : null}
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border px-2.5 py-2">
          {hint ? <div className="text-[10px] leading-relaxed text-faint">{hint}</div> : null}
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** 一行「标签 + 控件」 */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] text-dim">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  )
}

/** 分段按钮（位置 / 显隐 / 清晰度都用它，选中的一眼能看出来） */
export function SegRow<T extends string | number>({
  value,
  options,
  onChange,
  disabled = false
}: {
  value: T
  options: { key: T; label: string; title?: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={String(o.key)}
          type="button"
          title={o.title}
          disabled={disabled}
          onClick={() => onChange(o.key)}
          className={`h-7 rounded-lg px-2 text-[11px] transition-colors disabled:opacity-40 ${
            value === o.key ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * 数字输入框（带上下限）。
 *
 * **失焦才提交**，输入过程中的中间态（空串、"12"）不会写进 store ——
 * 边打边写的话，用户输入 "16" 的第一个字符 "1" 就会把尺寸夹到下限，
 * 后面的 "6" 是在被改过的值上打的，最后得到的东西跟看到的完全不是一回事。
 * 失焦时把非法值夹回区间并**显示夹取后的结果**（不静默丢掉用户的输入）。
 */
export function NumInput({
  value,
  min,
  max,
  disabled = false,
  className = 'w-16',
  onCommit
}: {
  value: number
  min: number
  max: number
  disabled?: boolean
  className?: string
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  // 外部改了值（例如拖动改变了坐标）要同步进来，否则输入框会一直显示旧数字
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = Number(draft)
    const v = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : value
    setDraft(String(v))
    if (v !== value) onCommit(v)
  }
  return (
    <input
      value={draft}
      inputMode="numeric"
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className={`h-7 shrink-0 rounded-lg border border-border bg-elev1 px-2 text-[11px] tabular-nums text-text outline-none transition-colors focus:border-accent disabled:opacity-40 ${className}`}
    />
  )
}

// ------------------------------------------------------------------
// 渐变色标编辑器（背景渐变 / 内容区渐变共用）
// ------------------------------------------------------------------

/** 色标编辑器：角度 + 色标（位置 / 颜色 / 可选透明度） */
export function StopEditor({
  layer,
  onChange,
  showAlpha = false
}: {
  layer: GradientLayer
  onChange: (next: GradientLayer) => void
  /** 叠加层要能调透明度（内容区渐变不需要，全是实色） */
  showAlpha?: boolean
}) {
  const atMax = layer.stops.length >= MAX_GRADIENT_STOPS
  const atMin = layer.stops.length <= MIN_GRADIENT_STOPS
  const setStop = (i: number, patch: Partial<GradientStop>): void => {
    onChange({ ...layer, stops: layer.stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  }
  return (
    <>
      <Row label="角度">
        <input
          type="range"
          min={0}
          max={360}
          step={5}
          value={layer.angle}
          onChange={(e) => onChange({ ...layer, angle: Number(e.target.value) })}
          className="min-w-0 flex-1 accent-accent"
        />
        <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-faint">
          {layer.angle}°
        </span>
      </Row>

      <div className="space-y-1.5">
        {layer.stops.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              type="color"
              value={s.color}
              onChange={(e) => setStop(i, { color: e.target.value })}
              className="h-7 w-9 shrink-0 cursor-pointer rounded-lg border border-border bg-elev1"
            />
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={s.pos}
              title="这个色标在渐变上的位置"
              onChange={(e) => setStop(i, { pos: Number(e.target.value) })}
              className="min-w-0 flex-1 accent-accent"
            />
            <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-faint">{s.pos}%</span>
            {showAlpha ? (
              <>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(s.alpha * 100)}
                  title="这个色标的不透明度"
                  onChange={(e) => setStop(i, { alpha: Number(e.target.value) / 100 })}
                  className="w-16 shrink-0 accent-accent"
                />
                <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-faint">
                  {Math.round(s.alpha * 100)}%
                </span>
              </>
            ) : null}
            <button
              type="button"
              title={atMin ? `至少要有 ${MIN_GRADIENT_STOPS} 个色标` : '删掉这个色标'}
              disabled={atMin}
              onClick={() => onChange({ ...layer, stops: layer.stops.filter((_, j) => j !== i) })}
              className="shrink-0 rounded-md p-1 text-faint transition-colors hover:text-danger disabled:opacity-30"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          icon={Plus}
          disabled={atMax}
          onClick={() =>
            onChange({
              ...layer,
              stops: [
                ...layer.stops,
                {
                  ...(layer.stops[layer.stops.length - 1] ?? { color: '#ffffff', alpha: 1, pos: 100 }),
                  pos: 100
                }
              ]
            })
          }
        >
          添加色标（最多 {MAX_GRADIENT_STOPS} 个）
        </Button>
      </div>
    </>
  )
}

/** 一条渐变预览条（编辑菜单里让用户看到当前构图） */
export function GradientBar({ layer }: { layer: GradientLayer }) {
  return <div className="h-7 w-full rounded-lg border border-border" style={{ background: gradientCss(layer) }} />
}

// ------------------------------------------------------------------
// 本地图片：选取 → 复制进应用数据目录 → 量原图尺寸
// ------------------------------------------------------------------

/**
 * 量一张本地图（走 sakana-img 协议）的原始像素尺寸。
 *
 * 为什么要量：页面高度与图区比例都要用到"原图比例"，而**导出的离屏窗口不会替我们量图**
 * （它只按 width×scale 开窗口）。所以尺寸必须在选图这一刻量好、存进背景数据（`imgW/imgH`）。
 */
export function measureImage(path: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    // 量不到就回 0（= 页面沿用默认高度），不要因此挡住用户保存背景
    img.onerror = () => resolve({ w: 0, h: 0 })
    img.src = localImgUrl(path)
  })
}

/**
 * 选一张本地图并导入。
 *
 * 与 BackgroundDialog 当年那套一致：`api.dialog.pickImage()` 拿用户选的路径，
 * 再 `api.showcase.importImages()` 复制进应用数据目录 —— 存**应用自己**的绝对路径，
 * 用户之后挪动/删掉原图也不会让推荐表里的图集体消失。
 * 返回 null 表示用户取消或导入失败（失败原因已经 toast 过了）。
 */
export async function pickLocalImage(): Promise<{ path: string; w: number; h: number } | null> {
  const picked = await api.dialog.pickImage()
  if (!picked.ok) throw new Error(picked.error)
  if (!picked.data) return null
  const imp = await api.showcase.importImages([picked.data])
  if (!imp.ok || imp.data.length === 0) throw new Error('导入本地图片失败（文件可能过大或不可读）')
  return { path: imp.data[0], ...(await measureImage(imp.data[0])) }
}

/** 渐变的预设（内容区渐变菜单里"起手就有个能看的东西"，用户再自己调角度与色标） */
export const CONTENT_GRADIENT_PRESETS: { name: string; layer: GradientLayer }[] = [
  { name: '米白', layer: { angle: 135, stops: [{ color: '#ffffff', pos: 0, alpha: 1 }, { color: '#f5efe6', pos: 100, alpha: 1 }] } },
  { name: '樱粉', layer: { angle: 135, stops: [{ color: '#ffffff', pos: 0, alpha: 1 }, { color: '#fbe4ec', pos: 100, alpha: 1 }] } },
  { name: '雾蓝', layer: { angle: 160, stops: [{ color: '#ffffff', pos: 0, alpha: 1 }, { color: '#e3ecf8', pos: 100, alpha: 1 }] } },
  { name: '薄荷', layer: { angle: 120, stops: [{ color: '#ffffff', pos: 0, alpha: 1 }, { color: '#e2f2e8', pos: 100, alpha: 1 }] } },
  { name: '暮色', layer: { angle: 150, stops: [{ color: '#4b4f63', pos: 0, alpha: 1 }, { color: '#8e7d9a', pos: 100, alpha: 1 }] } }
]

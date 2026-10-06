import { useEffect, useState } from 'react'
import { Check, ImagePlus, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { localImgUrl } from '@/lib/format'
import { toast } from '@/stores/app'
import {
  BG_PRESET_COLORS,
  BG_PRESET_GRADIENTS,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  normalizeBackground,
  normalizeHexColor,
  type RecommendBackground,
  type RecommendPage
} from '@/stores/recommendTable'
import { Button, Input, Modal } from '@/components/ui'
import { backgroundCss, displayName } from './styles'

/**
 * 「页面背景」弹窗（v0.3.7 追加需求 3：右键当前页 → 背景）。
 *
 * 三种背景 + 「无背景」，与数据层的一对一对应：
 *   · 纯色：预设色板 + 自定颜色（`<input type="color">` 或直接填十六进制）；
 *   · 渐变：角度 + 2–4 个色标（每个色标有色值与该色在渐变上的位置）；
 *   · 图片：`api.dialog.pickImage()` 选本地图 → `api.showcase.importImages()` **复制进应用数据目录**。
 * 图片必须走复制这一条路：`sakana-img://local` 只放行白名单目录，
 * 直接存用户挑的原路径会 403，界面上就是一块空白（项目里踩过两次，见 media.ts 的注释）。
 *
 * ## 保存范围：默认这一页，「应用到所有页」是同一个弹窗里的第二个按钮
 *
 * 背景在数据层是**按页**存的（理由见 recommendTable.ts 的 RecommendBackground 注释）。
 * 用户要的「整表统一」用第二个按钮实现 —— 两个诉求共用一个编辑界面，
 * 比做两套入口（表级背景 + 页级覆盖）简单得多，也不会出现「表级改了、页级覆盖还在」这种迷惑状态。
 *
 * ## 草稿 + 实时预览
 *
 * 编辑过程全部在本地 draft 上（点保存才写库，与编辑面板同一套理由：可以中途放弃），
 * 弹窗内部顶部有一条**实时预览**（直接画 draft 的 CSS），
 * 免得用户要关掉弹窗才能看见背景长什么样。
 */
const KIND_NAMES: { key: 'none' | 'color' | 'gradient' | 'image'; label: string; hint: string }[] = [
  { key: 'none', label: '无背景', hint: '纯白底，与默认外观一致' },
  { key: 'color', label: '纯色', hint: '预设色板或自己调一个颜色' },
  { key: 'gradient', label: '渐变', hint: '角度 + 2–4 个色标，可自由调' },
  { key: 'image', label: '图片', hint: '选一张本地图，会复制进应用数据目录' }
]

type Kind = (typeof KIND_NAMES)[number]['key']

export function BackgroundDialog({
  open,
  page,
  onClose,
  onApply,
  onApplyAll
}: {
  open: boolean
  /** 正在编辑背景的那一页（null = 弹窗没开） */
  page: RecommendPage | null
  onClose: () => void
  /** 只改这一页（undefined = 清掉背景回白底） */
  onApply: (bg: RecommendBackground | undefined) => void
  /** 应用到这张表的所有页（undefined = 全部回白底） */
  onApplyAll: (bg: RecommendBackground | undefined) => void
}) {
  const [kind, setKind] = useState<Kind>('none')
  const [color, setColor] = useState('#ffffff')
  const [angle, setAngle] = useState(135)
  const [stops, setStops] = useState<{ color: string; pos: number }[]>([])
  const [imagePath, setImagePath] = useState('')
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (!open || !page) return
    const bg = page.background
    /*
     * 打开时把这一页当前的背景摊进草稿。依赖里只放 open 与 page.id（不放 page 本身）：
     * 背景是能「应用到所有页」的，改完所有页后 store 会重建每个 page 对象，
     * 若依赖 page 就会把用户正在调的角度/色标冲掉（与 PageEditDialog 同一个坑）。
     */
    if (!bg) {
      setKind('none')
      setColor('#ffffff')
      setAngle(135)
      setStops(BG_PRESET_GRADIENTS[0].stops.map((s) => ({ ...s })))
      setImagePath('')
      return
    }
    if (bg.kind === 'color') {
      setKind('color')
      setColor(bg.color)
    } else if (bg.kind === 'image') {
      setKind('image')
      setImagePath(bg.path)
    } else {
      setKind('gradient')
      setAngle(bg.angle)
      setStops(bg.stops.map((s) => ({ ...s })))
    }
    // 依赖刻意只写 [open, page?.id]：见上面的说明
  }, [open, page?.id])

  /**
   * 草稿 → 数据层的背景值（走 normalizeBackground，保证与落盘用的是同一套校验）。
   * 「无背景」返回 `undefined`（= 白底），而不是 null：数据层的口径就是 undefined。
   */
  function draft(): RecommendBackground | undefined {
    if (kind === 'none') return undefined
    if (kind === 'color') return normalizeBackground({ kind: 'color', color })
    if (kind === 'image') {
      return imagePath ? normalizeBackground({ kind: 'image', path: imagePath }) : undefined
    }
    return normalizeBackground({ kind: 'gradient', angle, stops })
  }

  /**
   * 背景的 CSS（预览条用）。
   *
   * 直接复用 `styles.backgroundCss`（推荐卡与导出图用的是同一个函数）而不是在这里再拼一次：
   * 预览条、推荐卡预览、导出图三处的构图（渐变方向、图片居中裁剪）因此不可能不一致。
   */
  function previewCss(): string {
    return backgroundCss(draft(), (p) => `url('${localImgUrl(p)}')`)
  }

  /** 选图并复制进应用数据目录（不复制的话图片协议读不到，见文件头） */
  async function pickImage(): Promise<void> {
    if (importing) return
    setImporting(true)
    try {
      const picked = await api.dialog.pickImage()
      if (!picked.ok) {
        toast.error(picked.error)
        return
      }
      if (!picked.data) return
      const imp = await api.showcase.importImages([picked.data])
      if (!imp.ok || imp.data.length === 0) {
        toast.error('导入本地图片失败（文件可能过大或不可读）')
        return
      }
      const path = imp.data[0]
      if (path === picked.data) {
        toast.warn('这张图没能复制进应用数据目录（格式可能不支持），预览和导出可能显示不出来')
      }
      setImagePath(path)
      setKind('image')
    } catch (err) {
      toast.error(`导入图片失败：${String((err as Error)?.message ?? err)}`)
    } finally {
      setImporting(false)
    }
  }

  const canSave = kind !== 'image' || imagePath !== ''
  const boxStyle = { background: previewCss() }
  const atMaxStops = stops.length >= MAX_GRADIENT_STOPS
  const atMinStops = stops.length <= MIN_GRADIENT_STOPS

  return (
    <Modal open={open} onClose={onClose} title={`页面背景 · ${page ? displayName(page) : ''}`} width={560}>
      <div className="space-y-4">
        {/* 实时预览：直接画草稿的 CSS，改了立刻能看到 */}
        <div
          className="flex h-24 items-end justify-end rounded-xl border border-border p-2 text-[10px] text-dim"
          style={boxStyle}
        >
          <span className="rounded bg-white/75 px-1.5 py-0.5">背景预览</span>
        </div>

        {/* 三种形态 + 无背景 */}
        <div className="flex flex-wrap gap-1.5">
          {KIND_NAMES.map((k) => (
            <button
              key={k.key}
              type="button"
              title={k.hint}
              onClick={() => setKind(k.key)}
              className={`h-8 rounded-lg px-3 text-xs transition-colors ${
                kind === k.key ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>

        {kind === 'color' ? (
          <div className="rounded-xl border border-border bg-elev1/60 p-3">
            <div className="mb-2 text-[11px] text-faint">预设</div>
            <div className="flex flex-wrap gap-2">
              {BG_PRESET_COLORS.map((p) => (
                <button
                  key={p.color}
                  type="button"
                  title={p.name}
                  onClick={() => setColor(p.color)}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-transform hover:scale-105 ${
                    color === p.color ? 'border-accent' : 'border-border'
                  }`}
                  style={{ background: p.color }}
                >
                  {color === p.color ? <Check size={13} className="text-accent" /> : null}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="w-16 text-xs text-dim">自定义</span>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-8 w-12 cursor-pointer rounded-lg border border-border bg-elev1"
              />
              <Input
                value={color}
                className="w-32 font-mono"
                onChange={(e) => setColor(e.target.value)}
                onBlur={(e) => {
                  // 失焦时把写法归一（#fff → #ffffff）；填了非法的就退回当前合法值，不写坏数据
                  const hex = normalizeHexColor(e.target.value)
                  setColor(hex || color)
                }}
              />
            </div>
          </div>
        ) : null}

        {kind === 'gradient' ? (
          <div className="rounded-xl border border-border bg-elev1/60 p-3">
            <div className="mb-2 text-[11px] text-faint">起手模板</div>
            <div className="flex flex-wrap gap-1.5">
              {BG_PRESET_GRADIENTS.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => {
                    setAngle(g.angle)
                    setStops(g.stops.map((s) => ({ ...s })))
                  }}
                  className="h-8 rounded-lg border border-border px-3 text-xs text-text transition-transform hover:scale-105"
                  style={{
                    background: `linear-gradient(${g.angle}deg, ${g.stops.map((s) => `${s.color} ${s.pos}%`).join(', ')})`
                  }}
                >
                  {g.name}
                </button>
              ))}
            </div>

            <label className="mt-3 flex items-center gap-3 text-xs text-dim">
              <span className="w-16 shrink-0">角度</span>
              <input
                type="range"
                min={0}
                max={360}
                step={5}
                value={angle}
                onChange={(e) => setAngle(Number(e.target.value))}
                className="flex-1 accent-accent"
              />
              <span className="w-14 shrink-0 text-right tabular-nums text-faint">{angle}°</span>
            </label>

            <div className="mt-3 space-y-2">
              {stops.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="color"
                    value={s.color}
                    onChange={(e) =>
                      setStops((cur) => cur.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))
                    }
                    className="h-8 w-12 shrink-0 cursor-pointer rounded-lg border border-border bg-elev1"
                  />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={s.pos}
                    onChange={(e) =>
                      setStops((cur) =>
                        cur.map((x, j) => (j === i ? { ...x, pos: Number(e.target.value) } : x))
                      )
                    }
                    className="flex-1 accent-accent"
                  />
                  <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-faint">
                    {s.pos}%
                  </span>
                  <button
                    type="button"
                    title={atMinStops ? '至少要有两个色标' : '删掉这个色标'}
                    disabled={atMinStops}
                    onClick={() => setStops((cur) => cur.filter((_, j) => j !== i))}
                    className="shrink-0 rounded-md p-1 text-faint transition-colors hover:text-danger disabled:opacity-30"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                icon={Plus}
                disabled={atMaxStops}
                onClick={() =>
                  setStops((cur) => [...cur, { color: cur[cur.length - 1]?.color ?? '#ffffff', pos: 100 }])
                }
              >
                添加色标（最多 {MAX_GRADIENT_STOPS} 个）
              </Button>
            </div>
          </div>
        ) : null}

        {kind === 'image' ? (
          <div className="rounded-xl border border-border bg-elev1/60 p-3">
            <div className="flex items-center gap-3">
              {imagePath ? (
                <img
                  src={localImgUrl(imagePath)}
                  alt="背景图"
                  className="h-16 w-28 rounded-lg border border-border object-cover"
                />
              ) : (
                <div className="flex h-16 w-28 items-center justify-center rounded-lg border border-dashed border-border text-faint">
                  <ImagePlus size={16} />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <Button size="sm" variant="soft" icon={ImagePlus} loading={importing} onClick={() => void pickImage()}>
                  {imagePath ? '换一张' : '选择图片'}
                </Button>
                {imagePath ? (
                  <button
                    type="button"
                    onClick={() => setImagePath('')}
                    className="ml-2 text-[11px] text-faint transition-colors hover:text-danger"
                  >
                    清除
                  </button>
                ) : null}
                <div className="mt-1 break-all text-[10px] leading-relaxed text-faint">
                  {imagePath
                    ? imagePath
                    : '会按「居中裁剪」铺满卡片（与导出图一致），背景上会盖一层半透明白板保证文字看得清。'}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="text-[10px] leading-relaxed text-faint">
          背景默认「只作用于这一页」（每部番可以不一样）。想让整张表统一，用下面的「应用到所有页」。
          背景上的文字画在一层半透明白板上：深色背景也能看清字，纯白底则和不加背景完全一样。
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          disabled={!canSave}
          onClick={() => {
            onApplyAll(draft())
            onClose()
          }}
        >
          应用到所有页
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              onApply(draft())
              onClose()
            }}
          >
            保存到这一页
          </Button>
        </div>
      </div>
    </Modal>
  )
}

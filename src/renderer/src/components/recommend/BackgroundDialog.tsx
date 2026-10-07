import { useEffect, useMemo, useState } from 'react'
import { Check, ImagePlus, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { localImgUrl } from '@/lib/format'
import { toast } from '@/stores/app'
import {
  BG_PRESET_COLORS,
  BG_PRESET_GRADIENTS,
  IMAGE_POS_NAMES,
  MAX_BLUR,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  normalizeBackground,
  normalizeHexColor,
  normalizePageSize,
  PAGE_SIZE_MIN,
  PAGE_SIZE_MAX,
  type GradientLayer,
  type GradientStop,
  type ImagePos,
  type CropRect,
  type PageSize,
  type RecommendBackground,
  type RecommendPage
} from '@/stores/recommendTable'
import { Button, Input, Modal } from '@/components/ui'
import { CropSelector } from './CropSelector'
import {
  RL,
  asReactStyle,
  contentHeightNeeded,
  blendStyle,
  displayName,
  frameOf,
  gradientCss,
  imageBandImageStyle,
  imageBandWrapStyle,
  pageBackgroundCss
} from './styles'

/**
 * 「页面背景」弹窗（v0.3.8 第三轮：背景大改之后的形态）。
 *
 * ## 现在只有四件事可选（用户要求的收敛结果）
 *
 *   · **无背景**（白底）/ **纯色** / **渐变（角度 + 色标）** / **图片**；
 *   · 图片额外有 **位置（左 / 右 / 上）** 与 **模糊度**；
 *   · 上一版那个"叠加渐变层"控件**已经合并掉了**：它的作用由「图区 → 内容区」的
 *     **交融渐变**自动承担（贴在图区靠内容区那一侧、渐隐到页面底色）——
 *     功能重叠的两套旋钮不如一套自动生效的（见 styles.ts 的 blendStyle）。
 *
 * ## 图片不再铺满整页
 *
 * 图只占页面的一部分（**图区**，与内容区比例固定 1.5 : 1），内容区落在页面底色上，
 * 两者之间的接缝就是那条交融渐变。页面高度按 `frameOf` 重算：
 * 上图时内容区要放得下整页版式（H ≥ 2300），左/右图时内容区要放得下侧栏一列（H ≥ SIDE_CONTENT_H），
 * 同时仍然参考原图比例（竖图会让页面更高）。
 *
 * ## 选图时为什么要量原图尺寸并存下来
 *
 * 页面高度要用到「原图比例」，而**导出的离屏窗口不会替我们量图**（它只按 width×scale 开窗口），
 * 所以尺寸必须在选图这一刻量好、存进背景数据（`imgW/imgH`），导出才能算出同一个页面高度。
 *
 * ## 保存范围
 *
 * 默认只改**这一页**；「应用到所有页」是同一个弹窗里的第二个按钮
 * （背景在数据层是按页存的，理由见 store 的 RecommendBackground 注释）。
 */
const KIND_NAMES: { key: 'none' | 'color' | 'gradient' | 'image'; label: string; hint: string }[] = [
  { key: 'none', label: '无背景', hint: '纯白底，与默认外观一致' },
  { key: 'color', label: '纯色', hint: '预设色板或自己调一个颜色' },
  { key: 'gradient', label: '渐变', hint: '角度 + 2–4 个色标，可自由调' },
  { key: 'image', label: '图片', hint: '选一张本地图（页面比例会跟着它变）' }
]

type Kind = (typeof KIND_NAMES)[number]['key']

/** 量一张本地图（走 sakana-img 协议）的原始像素尺寸 */
function measureImage(path: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    // 量不到就回 0（= 页面沿用默认高度），不要因此挡住用户保存背景
    img.onerror = () => resolve({ w: 0, h: 0 })
    img.src = localImgUrl(path)
  })
}

/** 色标编辑器（背景渐变与叠加渐变共用同一套交互） */
function StopEditor({
  layer,
  onChange,
  showAlpha
}: {
  layer: GradientLayer
  onChange: (next: GradientLayer) => void
  /** 叠加层要能调透明度（背景渐变不需要，全是实色） */
  showAlpha: boolean
}) {
  const atMax = layer.stops.length >= MAX_GRADIENT_STOPS
  const atMin = layer.stops.length <= MIN_GRADIENT_STOPS
  const setStop = (i: number, patch: Partial<GradientStop>): void => {
    onChange({ ...layer, stops: layer.stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  }
  return (
    <>
      <label className="flex items-center gap-3 text-xs text-dim">
        <span className="w-16 shrink-0">角度</span>
        <input
          type="range"
          min={0}
          max={360}
          step={5}
          value={layer.angle}
          onChange={(e) => onChange({ ...layer, angle: Number(e.target.value) })}
          className="flex-1 accent-accent"
        />
        <span className="w-12 shrink-0 text-right tabular-nums text-faint">{layer.angle}°</span>
      </label>

      <div className="mt-2 space-y-2">
        {layer.stops.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="color"
              value={s.color}
              onChange={(e) => setStop(i, { color: e.target.value })}
              className="h-8 w-12 shrink-0 cursor-pointer rounded-lg border border-border bg-elev1"
            />
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={s.pos}
              onChange={(e) => setStop(i, { pos: Number(e.target.value) })}
              className="flex-1 accent-accent"
              title="这个色标在渐变上的位置"
            />
            <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-faint">{s.pos}%</span>
            {showAlpha ? (
              <>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(s.alpha * 100)}
                  onChange={(e) => setStop(i, { alpha: Number(e.target.value) / 100 })}
                  className="w-20 accent-accent"
                  title="这个色标的不透明度"
                />
                <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-faint">
                  {Math.round(s.alpha * 100)}%
                </span>
              </>
            ) : null}
            <button
              type="button"
              title={atMin ? '至少要有两个色标' : '删掉这个色标'}
              disabled={atMin}
              onClick={() => onChange({ ...layer, stops: layer.stops.filter((_, j) => j !== i) })}
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
  /** 只改这一页（undefined = 清掉背景回白底）；size 为 null = 回到跟随内容自适应 */
  onApply: (bg: RecommendBackground | undefined, size: PageSize | null, crop: CropRect | null) => void
  /** 应用到这张表的所有页（undefined = 全部回白底） */
  onApplyAll: (bg: RecommendBackground | undefined) => void
}) {
  const [kind, setKind] = useState<Kind>('none')
  const [color, setColor] = useState('#ffffff')
  const [layer, setLayer] = useState<GradientLayer>(BG_PRESET_GRADIENTS[0].layer)
  const [imagePath, setImagePath] = useState('')
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })
  const [blur, setBlur] = useState(0)
  /** 图片放在哪一侧（v0.3.8 第三轮：图只占页面一部分，交融渐变自动接在中间） */
  const [imagePos, setImagePos] = useState<ImagePos>('left')
  /** 手填页面尺寸草稿（字符串：输入框里要能留空/中间态） */
  const [sizeW, setSizeW] = useState('')
  const [sizeH, setSizeH] = useState('')
  /** 跟随内容（自适应）= 不存 size */
  const [autoSize, setAutoSize] = useState(true)
  /** 背景图取景框草稿（null = 整图） */
  const [crop, setCrop] = useState<CropRect | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (!open || !page) return
    const bg = page.background
    /*
     * 打开时把这一页当前的背景摊进草稿。依赖里只放 open 与 page.id（不放 page 本身）：
     * 「应用到所有页」会重建每个 page 对象，若依赖 page 就会把用户正在调的角度/色标冲掉
     * （与 PageEditDialog 同一个坑）。
     */
    if (!bg) {
      setKind('none')
      setColor('#ffffff')
      setLayer(BG_PRESET_GRADIENTS[0].layer)
      setImagePath('')
      setImgSize({ w: 0, h: 0 })
      setBlur(0)
      setImagePos('left')
    } else {
      setBlur(bg.blur)
      setImagePos(bg.imagePos)
      setCrop(bg.crop)
      if (bg.kind === 'color') {
        setKind('color')
        setColor(bg.color)
      } else if (bg.kind === 'image') {
        setKind('image')
        setImagePath(bg.path)
        setImgSize({ w: bg.imgW, h: bg.imgH })
      } else {
        setKind('gradient')
        setLayer({ angle: bg.angle, stops: bg.stops })
      }
    }
    // 页面尺寸：有 size 就是手填过（关掉自适应），没有就是自适应
    setAutoSize(!page.size)
    setSizeW(page.size ? String(page.size.w) : '')
    setSizeH(page.size ? String(page.size.h) : '')
    // 依赖刻意只写 [open, page?.id]：见上面的说明
  }, [open, page?.id])

  /** 草稿 → 数据层的背景值（走 normalizeBackground，保证与落盘用同一套校验） */
  function draft(): RecommendBackground | undefined {
    // 取景框只在"图片背景"下有意义；其它背景类型一律 null（切回去时不会留着上一次的框）
    const shared = { blur, imagePos, crop: kind === 'image' ? crop : null }
    if (kind === 'none') return undefined
    if (kind === 'color') return normalizeBackground({ kind: 'color', color, ...shared })
    if (kind === 'image') {
      if (!imagePath) return undefined
      return normalizeBackground({
        kind: 'image',
        path: imagePath,
        imgW: imgSize.w,
        imgH: imgSize.h,
        ...shared
      })
    }
    return normalizeBackground({ kind: 'gradient', angle: layer.angle, stops: layer.stops, ...shared })
  }

  /** 草稿 → 页面尺寸：自适应时给 null（清掉 size），否则夹到合法区间 */
  function draftSize(): PageSize | null {
    if (autoSize) return null
    return normalizePageSize({ w: Number(sizeW), h: Number(sizeH) })
  }

  /**
   * 预览用的页面框与各层样式：走**同一套** `frameOf` / `imageBand*` / `blendStyle`，
   * 所以弹窗里看到的构图（图区在哪、多宽、怎么交融）与推荐卡、导出图完全一致。
   * 页面尺寸也用草稿（手填值优先），否则预览会与导出对不上。
   */
  const previewFrame = useMemo(
    () => frameOf({ background: draft(), size: draftSize() ?? undefined }),
    // eslint 无关：这里的依赖就是"草稿的每一部分"，少一个预览就会与导出不一致
    [kind, color, layer, imagePath, imgSize, blur, imagePos, crop, autoSize, sizeW, sizeH]
  )
  const previewBandWrap = imageBandWrapStyle(previewFrame)
  const previewResolve = (p: string): string => `url('${localImgUrl(p)}')`
  /** 预览条只有 260px 宽，所以按比例缩一下（只影响这个预览框，不影响真实页面尺寸） */
  const previewScale = Math.min(1, 260 / previewFrame.width)
  /** 内容区需要的实际高度：手填高度不够时提示用户（并给"一键按内容"按钮） */
  const neededH = contentHeightNeeded(previewFrame)
  const tooShort = previewFrame.height < neededH - 1

  /** 选图 → 复制进应用数据目录 → 量原图尺寸（页面高度要靠它算） */
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
      const size = await measureImage(path)
      setImagePath(path)
      setImgSize(size)
      setKind('image')
      if (size.w > 0) toast.success(`已选背景图（${size.w}×${size.h}）—— 页面比例会跟着它变`)
    } catch (err) {
      toast.error(`导入图片失败：${String((err as Error)?.message ?? err)}`)
    } finally {
      setImporting(false)
    }
  }

  const canSave = kind !== 'image' || imagePath !== ''
  // 页面高度：与渲染、导出用的是同一个函数（imgW/imgH 已经存进背景数据里了）

  return (
    <Modal open={open} onClose={onClose} title={`页面背景 · ${page ? displayName(page) : ''}`} width={600}>
      <div className="space-y-4">
        {/*
          实时预览：直接画草稿（底色 + 图区 + 交融渐变），几何走与卡片/导出同一套函数，
          所以这里看到的就是推荐页上的样子。按比例缩小只是为了塞进弹窗。
        */}
        <div className="rounded-xl border border-border p-2">
          <div
            className="relative overflow-hidden rounded-lg"
            style={{
              width: `${Math.round(previewFrame.width * previewScale)}px`,
              height: `${Math.round(previewFrame.height * previewScale)}px`,
              margin: '0 auto',
              background: pageBackgroundCss(draft())
            }}
          >
            {/* 图区（外层裁剪 + 图片层），与推荐页/导出同一套样式 */}
            {previewBandWrap ? (
              <div style={asReactStyle(previewBandWrap)}>
                <div style={asReactStyle(imageBandImageStyle(previewFrame, draft(), previewResolve))} />
              </div>
            ) : null}
            {previewFrame.pos === 'none' ? null : (
              <div style={asReactStyle(blendStyle(previewFrame))} />
            )}
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-faint">
            <span>
              页面 {RL.width} × {previewFrame.height}
            </span>
            <span>
              {previewFrame.pos === 'none'
                ? '整页都是内容区'
                : `图区在${previewFrame.pos === 'left' ? '左' : previewFrame.pos === 'right' ? '右' : '上'}侧 · 图区 ${previewFrame.imageW}×${previewFrame.imageH} · 比例 1.5 : 1`}
            </span>
          </div>
        </div>

        {/* 四种状态 */}
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
                  // 失焦时把写法归一（#fff → #ffffff）；填了非法的就退回当前合法值
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
            <div className="mb-3 flex flex-wrap gap-1.5">
              {BG_PRESET_GRADIENTS.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => setLayer(g.layer)}
                  className="h-8 rounded-lg border border-border px-3 text-xs text-text transition-transform hover:scale-105"
                  style={{ background: gradientCss(g.layer) }}
                >
                  {g.name}
                </button>
              ))}
            </div>
            <StopEditor layer={layer} onChange={setLayer} showAlpha={false} />
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
                <Button
                  size="sm"
                  variant="soft"
                  icon={ImagePlus}
                  loading={importing}
                  onClick={() => void pickImage()}
                >
                  {imagePath ? '换一张' : '选择图片'}
                </Button>
                {imagePath ? (
                  <button
                    type="button"
                    onClick={() => {
                      setImagePath('')
                      setImgSize({ w: 0, h: 0 })
                    }}
                    className="ml-2 text-[11px] text-faint transition-colors hover:text-danger"
                  >
                    清除
                  </button>
                ) : null}
                <div className="mt-1 break-all text-[10px] leading-relaxed text-faint">
                  {imagePath
                    ? `${imgSize.w > 0 ? `原图 ${imgSize.w}×${imgSize.h} · ` : ''}只占页面的一部分（图区），按 cover 居中裁剪不拉伸；页面高度算出来 ${previewFrame.height}px`
                    : '图会放在页面的左 / 右 / 上之一，与内容区比例固定 1.5 : 1，中间用渐变交融（没有硬边）。'}
                </div>
              </div>
            </div>

            {/* 位置：左 / 右 / 上（用户要求的三选一） */}
            <div className="mt-3 flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-dim">位置</span>
              <div className="flex gap-1.5">
                {IMAGE_POS_NAMES.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setImagePos(p.key)}
                    className={`h-8 rounded-lg px-3 text-xs transition-colors ${
                      imagePos === p.key ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/*
              框选背景图的展示区域（v0.3.8 第四轮）。
              交互与「最XX的角色」那个逐图裁切弹窗一致：视口比例 = 图区比例、拖动平移、滚轮缩放，
              确认后存归一化 `{x,y,w,h}`。viewport 里看到的**就是**图区里会显示的，
              因为两边用的是同一个换算（styles.bandImageCropPosition / cropToBackgroundCss）。
            */}
            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                <span className="text-dim">展示区域（框选）</span>
                <span className="text-[10px] text-faint">
                  {crop
                    ? `框 ${Math.round(crop.w * 100)}% × ${Math.round(crop.h * 100)}%`
                    : '整图（自动居中）'}
                </span>
              </div>
              {imagePath && imgSize.w > 0 ? (
                <CropSelector
                  key={imagePath}
                  url={localImgUrl(imagePath)}
                  imgW={imgSize.w}
                  imgH={imgSize.h}
                  aspect={previewFrame.imageH > 0 ? previewFrame.imageW / previewFrame.imageH : 1}
                  crop={crop}
                  onChange={setCrop}
                />
              ) : (
                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[10px] text-faint">
                  先选一张图片，再框选要展示的区域
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* 模糊度（三种背景通吃；叠加渐变已经合并进"图区 → 内容区"的交融渐变） */}
        <div className="space-y-2 rounded-xl border border-border bg-elev1/60 p-3">
          <label className="flex items-center gap-3 text-xs text-dim">
            <span className="w-16 shrink-0">模糊度</span>
            <input
              type="range"
              min={0}
              max={MAX_BLUR}
              step={1}
              value={blur}
              onChange={(e) => setBlur(Number(e.target.value))}
              className="flex-1 accent-accent"
              disabled={kind === 'none'}
            />
            <span className="w-14 shrink-0 text-right tabular-nums text-faint">{blur}px</span>
          </label>
          <div className="text-[10px] leading-relaxed text-faint">
            只模糊图区那一层：文字不受影响（图片层会向外多铺一点，免得模糊后四周露出底色）。
            图片与内容区之间的**交融渐变**是自动的，不需要额外设置。
          </div>
        </div>

        {/* 页面尺寸（v0.3.8 第四轮）：手填优先于自适应，「跟随内容」清掉手填值 */}
        <div className="space-y-2 rounded-xl border border-border bg-elev1/60 p-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold text-faint">页面尺寸</span>
            <span className="text-[10px] text-faint">
              当前 {previewFrame.width} × {previewFrame.height} px
              {autoSize ? '（跟随内容自适应）' : '（手填）'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-dim">
              <span className="shrink-0">宽</span>
              <Input
                value={sizeW}
                inputMode="numeric"
                placeholder={String(RL.width)}
                disabled={autoSize}
                className="h-8 w-20 text-xs"
                onChange={(e) => setSizeW(e.target.value)}
                onBlur={(e) => setSizeW(String(normalizePageSize({ w: Number(e.target.value), h: 1000 })?.w ?? RL.width))}
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-dim">
              <span className="shrink-0">高</span>
              <Input
                value={sizeH}
                inputMode="numeric"
                placeholder={String(RL.baseHeight)}
                disabled={autoSize}
                className="h-8 w-20 text-xs"
                onChange={(e) => setSizeH(e.target.value)}
                onBlur={(e) => setSizeH(String(normalizePageSize({ w: 1000, h: Number(e.target.value) })?.h ?? RL.baseHeight))}
              />
            </label>
            <button
              type="button"
              onClick={() => setAutoSize((v) => !v)}
              className={`h-8 rounded-lg px-3 text-xs transition-colors ${
                autoSize ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
              }`}
            >
              跟随内容（自适应）
            </button>
            <button
              type="button"
              disabled={autoSize || !tooShort}
              title="把高度设成内容刚好放得下的值"
              onClick={() => setSizeH(String(neededH))}
              className="h-8 rounded-lg bg-elev2 px-3 text-xs text-dim transition-colors hover:text-text disabled:opacity-40"
            >
              按内容高度（{neededH}）
            </button>
          </div>
          <div className="text-[10px] leading-relaxed text-faint">
            范围 {PAGE_SIZE_MIN}–{PAGE_SIZE_MAX} px。**手填之后就不再被自动公式覆盖**（预览与导出都用它）；
            想回到自动算尺寸，点亮「跟随内容（自适应）」。
            {tooShort
              ? ' 注意：当前高度装不下整页内容，超出的部分会被裁掉（可以点「按内容高度」一键调好）。'
              : ''}
          </div>
        </div>

        <div className="text-[10px] leading-relaxed text-faint">
          背景与页面尺寸默认「只作用于这一页」（每部番可以不一样）。想让整张表统一，用下面的「应用到所有页」。
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
              onApply(draft(), draftSize(), crop)
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

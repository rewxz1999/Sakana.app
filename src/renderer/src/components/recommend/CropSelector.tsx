import { useCallback, useEffect, useRef, useState } from 'react'
import { Crop } from 'lucide-react'
import { normalizeCrop, type CropRect } from '@/stores/recommendTable'
import { cropToBackgroundCss, asReactStyle } from './styles'

/**
 * 背景图**展示区域**框选器（v0.3.8 第四轮）。
 *
 * ## 与角色图鉴那套的关系（故意做成同一个手感）
 *
 * 「最XX的角色」工具早就做过逐图裁切（`CharacterGridPage` 里的 `CropDialog`），
 * 交互是：**视口比例 = 目标区域比例**，拖动平移图片、滚轮缩放，确认后存归一化 `{x,y,w,h}`。
 * 这里照搬同一套手感与同一份收据（`normalizeCrop` 直接复用），用户在两处操作不用重新学。
 *
 * ## 为什么只存归一化取景框，不存像素
 *
 * 存源图坐标（0–1）之后，换页面尺寸、换图区比例、导出放大 2~3 倍都只是换一套换算，
 * 取景框本身不动；而且换算可以写成**纯 CSS**（`background-size` / `background-position`），
 * 于是预览与导出（HTML→图片）能共用同一个函数 —— 导出是离屏渲染 HTML，
 * 用 canvas 裁剪只有预览能跑，两边就会不一致。
 *
 * ## 两种"自动"按钮
 *
 *   · **重置为整图**：crop = null（回到 `cover` 自动居中，也就是加这个功能之前的行为）；
 *   · **按背景区域比例自动框选**：把整张图里**最大的一块**与图区同比例的区域框出来
 *     （等于"最少裁切地铺满"），用户通常点一下就不折腾了。
 *
 * ## 边界情况
 *
 *   · 图片还没加载完（拿不到自然尺寸）→ 视口先显示占位，框选按钮不可用；
 *   · 源图比视口还小 / 框贴边 → 交给 `normalizeCrop` 把越界整体平移回来（不丢框）；
 *   · 超大图（>8000px）→ 只用 `naturalWidth/Height` 做一次换算，**不做任何逐帧重算**，
 *     预览用的还是浏览器自己的缩放绘制（`background-size`），不复制像素、不建 canvas。
 */
export function CropSelector({
  url,
  imgW,
  imgH,
  /** 图区的宽高比（宽/高）——视口照它显示，所以"框里看到的 = 图区里显示的" */
  aspect,
  crop,
  onChange
}: {
  url: string
  imgW: number
  imgH: number
  aspect: number
  crop: CropRect | null
  onChange: (c: CropRect | null) => void
}) {
  const VW = 320
  const VH = Math.max(120, Math.round(VW / Math.max(0.2, aspect)))
  /** 相对"铺满视口"的倍数（1 = 刚好铺满） */
  const [zoom, setZoom] = useState(1)
  /** 图片左上角相对视口的像素偏移（<= 0） */
  const [off, setOff] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)
  const [ready, setReady] = useState(false)

  const baseScale = imgW > 0 && imgH > 0 ? Math.max(VW / imgW, VH / imgH) : 1
  const scale = baseScale * zoom

  const clampOff = useCallback(
    (x: number, y: number, sc: number): { x: number; y: number } => ({
      x: Math.min(0, Math.max(VW - imgW * sc, x)),
      y: Math.min(0, Math.max(VH - imgH * sc, y))
    }),
    [imgW, imgH, VH]
  )

  /** 图片自然尺寸到手后，按已有 crop 还原缩放与偏移（没有就居中铺满） */
  useEffect(() => {
    if (!(imgW > 0 && imgH > 0)) return
    setReady(true)
    const base = Math.max(VW / imgW, VH / imgH)
    if (crop && crop.w > 0 && crop.h > 0) {
      const sc = VW / (crop.w * imgW)
      setZoom(Math.min(8, Math.max(1, sc / base)))
      setOff(clampOff(-crop.x * imgW * sc, -crop.y * imgH * sc, sc))
      return
    }
    const sc = base
    setZoom(1)
    setOff({ x: (VW - imgW * sc) / 2, y: (VH - imgH * sc) / 2 })
  }, [url, imgW, imgH, crop, clampOff])

  /** 当前视口对应的归一化取景框 */
  const currentCrop = (): CropRect | null => {
    if (!ready) return null
    return normalizeCrop({
      x: -off.x / scale / imgW,
      y: -off.y / scale / imgH,
      w: VW / scale / imgW,
      h: VH / scale / imgH
    })
  }

  const applyZoom = (next: number): void => {
    const z = Math.min(8, Math.max(1, next))
    const sc = baseScale * z
    // 以视口中心为锚点缩放
    const cx = (VW / 2 - off.x) / scale
    const cy = (VH / 2 - off.y) / scale
    setZoom(z)
    setOff(clampOff(VW / 2 - cx * sc, VH / 2 - cy * sc, sc))
  }

  /** 「按背景区域比例自动框选」：整图里最大的一块同比例区域（最少裁切） */
  const fitToBand = (): void => {
    if (!ready) return
    const target = VW / VH
    const imgAspect = imgW / imgH
    let w = 1
    let h = 1
    if (imgAspect > target) w = target / imgAspect
    else h = imgAspect / target
    onChange(normalizeCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h }))
  }

  const bg = cropToBackgroundCss(crop, () => `url('${url}')`, url)
  const cropNow = currentCrop()

  return (
    <div>
      <div
        className="relative mx-auto overflow-hidden rounded-lg border border-border bg-elev2"
        style={{ width: VW, height: VH, cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (!ready) return
          e.currentTarget.setPointerCapture(e.pointerId)
          dragRef.current = { px: e.clientX, py: e.clientY, ox: off.x, oy: off.y }
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (!d) return
          setOff(clampOff(d.ox + (e.clientX - d.px), d.oy + (e.clientY - d.py), scale))
        }}
        onPointerUp={(e) => {
          dragRef.current = null
          try {
            e.currentTarget.releasePointerCapture(e.pointerId)
          } catch {
            /* ignore */
          }
          onChange(currentCrop())
        }}
        onWheel={(e) => {
          e.preventDefault()
          applyZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12))
          // 滚轮结束再落一次（不停写盘，只在松手/滚完时提交）
          window.setTimeout(() => onChange(currentCrop()), 120)
        }}
      >
        {/*
          只放一层图片：尺寸 = 原图 × 缩放、位置 = 偏移。视口比例 = 图区比例，
          所以**视口里看到的就是图区里会显示的**（导出那边用同一套换算，见 bandImageCropPosition）。
        */}
        <div
          style={{
            position: 'absolute',
            left: `${off.x}px`,
            top: `${off.y}px`,
            width: `${imgW * scale}px`,
            height: `${imgH * scale}px`,
            backgroundImage: `url('${url}')`,
            backgroundSize: '100% 100%',
            backgroundRepeat: 'no-repeat'
          }}
        />
        {/* 框外遮罩：让"框选"这件事一眼可见（这里框 = 整个视口，遮罩只是示意不能动的边界） */}
        <div
          className="pointer-events-none absolute inset-0 rounded-lg"
          style={{ boxShadow: 'inset 0 0 0 2px rgba(47, 107, 255, 0.75)' }}
        />
        {!ready ? (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-faint">
            图片读取中…
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={fitToBand}
          className="flex h-7 items-center gap-1 rounded-lg bg-elev2 px-2.5 text-[11px] text-dim transition-colors hover:text-text disabled:opacity-40"
        >
          <Crop size={12} /> 按背景区域比例自动框选
        </button>
        <button
          type="button"
          disabled={!crop}
          onClick={() => onChange(null)}
          className="h-7 rounded-lg bg-elev2 px-2.5 text-[11px] text-dim transition-colors hover:text-text disabled:opacity-40"
        >
          重置为整图
        </button>
        <span className="text-[10px] tabular-nums text-faint">
          {cropNow ? `x${(cropNow.x * 100).toFixed(0)}% y${(cropNow.y * 100).toFixed(0)}%` : '整图'}
          {' · '}拖动平移 / 滚轮缩放
        </span>
      </div>

      {/* 当前取景在全图里的位置示意（小地图）：绿框是框选区域 */}
      <div
        className="relative mt-2 w-full overflow-hidden rounded-md border border-border bg-elev2"
        style={{ height: 54 }}
      >
        <div
          style={asReactStyle({
            position: 'absolute',
            inset: '0',
            backgroundImage: `url('${url}')`,
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            opacity: '0.9'
          })}
        />
        {crop ? (
          <div
            style={asReactStyle({
              position: 'absolute',
              left: `${crop.x * 100}%`,
              top: `${crop.y * 100}%`,
              width: `${crop.w * 100}%`,
              height: `${crop.h * 100}%`,
              boxShadow: 'inset 0 0 0 2px rgba(47, 107, 255, 0.95)'
            })}
          />
        ) : null}
      </div>
      <div className="mt-1 text-[10px] leading-relaxed text-faint">
        框选的是**源图坐标**，所以换页面尺寸、换图区位置、导出放大都不会让框跑偏。
        框的比例与图区不一致时，多出来的部分会被裁掉（**不会拉伸变形**）。
      </div>
    </div>
  )
}

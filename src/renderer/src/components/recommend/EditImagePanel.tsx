import { useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { localImgUrl } from '@/lib/format'
import { toast } from '@/stores/app'
import {
  IMAGE_POS_NAMES,
  MAX_BLUR,
  normalizeBackground,
  type ImagePos,
  type RecommendBackground
} from '@/stores/recommendTable'
import { Button } from '@/components/ui'
import { CropSelector } from './CropSelector'
import { PanelSection, Row, SegRow, pickLocalImage } from './editBits'
import type { EditCtx } from './editTypes'

/**
 * 编辑模式**左菜单 Ⅰ：版面图片**（v0.3.9）。
 *
 * 用户原话：「给推荐页的上/下/左/右放置版面图片（本地选取）」。
 * 四张位置按钮对应 `background.imagePos`（v0.3.9 补了「下」，见 store 的 ImagePos）。
 *
 * 几个刻意的做法：
 *   · **没选图之前位置按钮是禁用的**（disabled）而不是"点了没反应"——
 *     没有图的时候设位置没有任何意义，禁用 + 一行说明比留一个假控件诚实；
 *   · 选图走 `pickLocalImage()`：复制进应用数据目录之后再存路径，
 *     用户之后挪走原图也不会让整张推荐表变成一片空白；
 *   · 「应用到所有页」在这里也放一个：一页一页设同一个版面图片是这个菜单里最烦的操作。
 */
export function EditImageSection({ ctx }: { ctx: EditCtx }) {
  const bg = ctx.page.background
  const isImage = bg?.kind === 'image'
  const pos: ImagePos = isImage ? bg.imagePos : 'left'
  const [busy, setBusy] = useState(false)

  /** 在当前背景上叠一层改动（其余字段保留，避免"改位置把取景框/模糊弄丢"） */
  const withBg = (patch: Partial<RecommendBackground>, all = false): void => {
    const base: RecommendBackground = bg ?? {
      kind: 'image',
      color: '#ffffff',
      angle: 135,
      stops: [],
      path: '',
      imgW: 0,
      imgH: 0,
      imagePos: 'left',
      blur: 0,
      crop: null
    }
    const next = normalizeBackground({ ...base, ...patch })
    if (all) ctx.patchAll({ background: next })
    else ctx.patch({ background: next })
  }

  const choose = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const picked = await pickLocalImage()
      if (!picked) return
      withBg({ kind: 'image', path: picked.path, imgW: picked.w, imgH: picked.h })
      toast.success(
        picked.w > 0
          ? `已设置版面图片（${picked.w}×${picked.h}）—— 页面比例会跟着它变`
          : '已设置版面图片'
      )
    } catch (err) {
      toast.error(`导入图片失败：${String((err as Error)?.message ?? err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <PanelSection
      title="Ⅰ 版面图片"
      defaultOpen
      right={isImage ? IMAGE_POS_NAMES.find((p) => p.key === pos)?.label : '未设置'}
      hint="版面图片只占页面的一部分（图区），与内容区之间用渐变交融，没有硬边。四个方向都可以放。"
    >
      <div className="flex items-center gap-2">
        {isImage ? (
          <img
            src={localImgUrl(bg.path)}
            alt="版面图片"
            className="h-12 w-20 shrink-0 rounded-lg border border-border object-cover"
          />
        ) : (
          <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-faint">
            <ImagePlus size={15} />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <Button size="sm" variant="soft" icon={ImagePlus} loading={busy} onClick={() => void choose()}>
            {isImage ? '换一张' : '选择本地图片'}
          </Button>
          {isImage ? (
            <button
              type="button"
              onClick={() => ctx.patch({ background: undefined })}
              className="flex items-center gap-0.5 text-[10px] text-faint transition-colors hover:text-danger"
            >
              <X size={11} /> 去掉版面图片
            </button>
          ) : null}
        </div>
      </div>

      <Row label="位置">
        <SegRow
          value={pos}
          disabled={!isImage}
          options={IMAGE_POS_NAMES.map((p) => ({ key: p.key, label: p.label }))}
          onChange={(v) => withBg({ imagePos: v })}
        />
      </Row>
      {!isImage ? (
        <div className="text-[10px] leading-relaxed text-faint">
          先选一张图片，再选它放在页面的哪一侧。
        </div>
      ) : null}

      <Row label="模糊">
        <input
          type="range"
          min={0}
          max={MAX_BLUR}
          step={1}
          value={isImage ? bg.blur : 0}
          disabled={!isImage}
          onChange={(e) => withBg({ blur: Number(e.target.value) })}
          className="min-w-0 flex-1 accent-accent disabled:opacity-40"
        />
        <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-faint">
          {isImage ? bg.blur : 0}px
        </span>
      </Row>

      {isImage ? (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => ctx.patchAll({ background: normalizeBackground(bg) })}
          >
            应用到所有页
          </Button>
          <span className="text-[10px] leading-relaxed text-faint">
            图区大小由下面的「占比」决定
          </span>
        </div>
      ) : null}
    </PanelSection>
  )
}

/**
 * 编辑模式**左菜单 Ⅴ：版面图片的展示区域**（复用既有的框选器）。
 *
 * 框选的是**源图坐标**（0–1）：换页面尺寸、换占比、导出放大 2–3 倍都只是换一套换算，
 * 框本身不动 —— 预览与导出因此能共用同一个换算（`styles.bandImageCropPosition`）。
 */
export function EditCropSection({ ctx }: { ctx: EditCtx }) {
  const bg = ctx.page.background
  const isImage = bg?.kind === 'image'
  const ready = isImage && bg.imgW > 0 && bg.imgH > 0
  const crop = isImage ? bg.crop : null
  /** 视口比例 = 图区比例：所以框里看到的**就是**图区里会显示的 */
  const aspect = ctx.frame.imageH > 0 ? ctx.frame.imageW / ctx.frame.imageH : 1

  return (
    <PanelSection
      title="Ⅴ 版面图片的展示区域"
      right={crop ? `${Math.round(crop.w * 100)}% × ${Math.round(crop.h * 100)}%` : '整图'}
      hint="拖动平移、滚轮缩放。框选的是源图坐标，所以换页面尺寸 / 换占比 / 导出放大都不会让框跑偏。"
    >
      {ready ? (
        <CropSelector
          key={bg.path}
          url={localImgUrl(bg.path)}
          imgW={bg.imgW}
          imgH={bg.imgH}
          aspect={aspect}
          crop={crop}
          // 取景框挂在背景上（bg.crop）：所以"取景"只在有版面图片时才存在
          onChange={(c) => ctx.patch({ background: normalizeBackground({ ...bg, crop: c }) })}
        />
      ) : (
        <div className="rounded-lg border border-dashed border-border px-2 py-3 text-center text-[10px] leading-relaxed text-faint">
          先在上面「Ⅰ 版面图片」里选一张图片，再回来框选要展示的区域。
        </div>
      )}
    </PanelSection>
  )
}

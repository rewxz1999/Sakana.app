import { Palette, X } from 'lucide-react'
import { toast } from '@/stores/app'
import {
  BAND_RATIO_MAX,
  BAND_RATIO_MIN,
  DEFAULT_FONT_STACK,
  normalizeLayer,
  type GradientLayer
} from '@/stores/recommendTable'
import { Button } from '@/components/ui'
import { IMAGE_CONTENT_RATIO } from './styles'
import { EditCropSection, EditImageSection } from './EditImagePanel'
import { EditPositionSection, EditSizeSection, EditVisibleSection } from './EditModulePanel'
import { CONTENT_GRADIENT_PRESETS, GradientBar, PanelSection, Row, SegRow, StopEditor } from './editBits'
import type { EditCtx } from './editTypes'

/**
 * 编辑模式**左菜单**（v0.3.9）—— 用户点名的 Ⅰ–Ⅶ 全在这里：
 *
 *   Ⅰ 版面图片（上/下/左/右 + 本地选取）      —— EditImagePanel.tsx
 *   Ⅱ 展示哪些模块                            —— EditModulePanel.tsx
 *   Ⅲ 模块大小                                —— EditModulePanel.tsx
 *   Ⅳ 图区与内容区的占比（本文件）
 *   Ⅴ 版面图片的展示区域（框选）               —— EditImagePanel.tsx
 *   Ⅵ 内容区域的渐变背景色（本文件）
 *   Ⅶ 自定义模块排版位置（拖动 + 坐标输入）     —— EditModulePanel.tsx
 *
 * ## 窄窗口怎么处理（注释里说明取舍）
 *
 * 窗口宽度不够时（本项目允许把窗口缩到很小）左右两列各 250px 会把画布挤成一条缝。
 * 取舍：本面板**自身可滚动**（`overflow-y-auto`），并且在容器宽度小于 900px 时
 * 由页面把它折成"抽屉"（见 RecommendTablePage 里的 `narrow` 判断：
 * 两列改为绝对定位覆盖在画布两侧、点画布就收起）——这里只保证面板本身能滚、不会被裁。
 */
export function EditLeftPanel({ ctx }: { ctx: EditCtx }) {
  const isImage = ctx.page.background?.kind === 'image'
  const ratio = ctx.page.bandRatio ?? IMAGE_CONTENT_RATIO
  const frac = ratio / (ratio + 1)
  const grad = ctx.page.contentGradient ?? null

  /** 改内容区渐变（null = 去掉这一层） */
  const setGrad = (layer: GradientLayer | null, all = false): void => {
    const next = layer ? normalizeLayer(layer) : null
    if (all) ctx.patchAll({ contentGradient: next })
    else ctx.patch({ contentGradient: next })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto pr-1">
      <div className="px-0.5 text-[10px] leading-relaxed text-faint">
        编辑模式：画布居中，这里改的都是**当前这一页**。改动实时落盘，右上角「退出并保存」只是关掉编辑态。
      </div>

      <EditImageSection ctx={ctx} />

      {/* Ⅳ 图区 : 内容区 的占比 */}
      <PanelSection
        title="Ⅳ 图区与内容区的占比"
        right={`${Math.round(frac * 100)}% : ${Math.round((1 - frac) * 100)}%`}
        hint="改的是图区与内容区的分割位置。交界处默认用渐变交融（没有硬边），不需要额外设置。"
      >
        {!isImage ? (
          <div className="rounded-lg border border-dashed border-border px-2 py-3 text-[10px] leading-relaxed text-faint">
            暂不生效：没有版面图片时整页都是内容区，没有可分割的两块。
            先在上面选一张版面图片。
          </div>
        ) : null}
        <Row label="图区 : 内容区">
          <input
            type="range"
            min={BAND_RATIO_MIN * 100}
            max={BAND_RATIO_MAX * 100}
            step={5}
            disabled={!isImage}
            value={Math.round(ratio * 100)}
            onChange={(e) => ctx.patch({ bandRatio: Number(e.target.value) / 100 })}
            className="min-w-0 flex-1 accent-accent disabled:opacity-40"
          />
          <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-faint">
            {ratio.toFixed(2)}
          </span>
        </Row>
        <div className="flex flex-wrap items-center gap-1.5">
          <SegRow
            value={Math.round(ratio * 10) / 10}
            disabled={!isImage}
            options={[
              { key: 1, label: '1 : 1' },
              { key: IMAGE_CONTENT_RATIO, label: '1.5 : 1（默认）' },
              { key: 2, label: '2 : 1' },
              { key: 3, label: '3 : 1' }
            ]}
            onChange={(v) => ctx.patch({ bandRatio: v })}
          />
        </div>
        <Row label="图区尺寸">
          <span className="text-[10px] tabular-nums text-faint">
            {ctx.frame.pos === 'none'
              ? '—'
              : `${ctx.frame.imageW} × ${ctx.frame.imageH} px（页面 ${ctx.frame.width} × ${ctx.frame.height}）`}
          </span>
        </Row>
        {isImage ? (
          <Button size="sm" variant="outline" onClick={() => ctx.patchAll({ bandRatio: ratio })}>
            占比应用到所有页
          </Button>
        ) : null}
      </PanelSection>

      <EditVisibleSection ctx={ctx} />
      <EditSizeSection ctx={ctx} />

      {/* Ⅵ 内容区域的渐变背景色 */}
      <PanelSection
        title="Ⅵ 内容区渐变背景"
        right={grad ? `${grad.stops.length} 个色标` : '未设置'}
        hint="画在内容区那一块上（页面底色与图区之上、模块之下）。没有版面图片时内容区就是整页。"
      >
        <GradientBar layer={grad ?? { angle: 135, stops: [{ color: '#ffffff', pos: 0, alpha: 1 }, { color: '#f5efe6', pos: 100, alpha: 1 }] }} />
        <div className="flex flex-wrap gap-1.5">
          {CONTENT_GRADIENT_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => setGrad(p.layer)}
              className="h-7 rounded-lg border border-border px-2 text-[10px] text-text transition-transform hover:scale-105"
              style={{
                background: `linear-gradient(${p.layer.angle}deg, ${p.layer.stops
                  .map((s) => `${s.color} ${s.pos}%`)
                  .join(', ')})`
              }}
            >
              {p.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setGrad({ angle: 135, stops: [{ color: '#ffffff', pos: 0, alpha: 1 }, { color: '#e0577f', pos: 100, alpha: 1 }] })}
            className="h-7 rounded-lg bg-elev2 px-2 text-[10px] text-dim transition-colors hover:text-text"
            title="用两个相同的色标就是纯色底"
          >
            纯色（樱粉）
          </button>
        </div>
        {grad ? (
          <>
            <StopEditor layer={grad} onChange={(l) => setGrad(l)} />
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                icon={X}
                onClick={() => {
                  setGrad(null)
                  toast.success('已去掉内容区渐变')
                }}
              >
                去掉这一层
              </Button>
              <Button size="sm" variant="outline" onClick={() => setGrad(grad, true)}>
                应用到所有页
              </Button>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-1.5 text-[10px] leading-relaxed text-faint">
            <Palette size={12} /> 点上面的预设或色块开始，未设置时内容区就是页面底色。
          </div>
        )}
      </PanelSection>

      <EditCropSection ctx={ctx} />
      <EditPositionSection ctx={ctx} />

      <div className="px-0.5 pb-1 text-[10px] leading-relaxed text-faint">
        默认字体栈：{DEFAULT_FONT_STACK.split(',')[0]} —— 导出用的离屏窗口不加载外部字体，
        所以字体只提供系统内置的几种（右菜单 Ⅲ）。
      </div>
    </div>
  )
}

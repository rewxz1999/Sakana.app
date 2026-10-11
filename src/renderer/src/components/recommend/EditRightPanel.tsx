import { ImageDown, RotateCcw, Ruler } from 'lucide-react'
import { toast } from '@/stores/app'
import {
  MODULE_FONT_BASE,
  MODULE_FONTS,
  MODULE_FONT_SIZE_MAX,
  MODULE_FONT_SIZE_MIN,
  MODULE_NAMES,
  PAGE_SIZE_MAX,
  PAGE_SIZE_MIN,
  resolveModules,
  type ModuleFontKey
} from '@/stores/recommendTable'
import { Button } from '@/components/ui'
import { RL, contentHeightNeeded } from './styles'
import { NumInput, PanelSection, Row, SegRow } from './editBits'
import type { EditCtx } from './editTypes'

/**
 * 编辑模式**右菜单**（v0.3.9）—— 用户点名的 Ⅰ–Ⅲ：
 *
 *   Ⅰ 页面大小（有上下限，且与导出图片尺寸绑定）
 *   Ⅱ 导出为图片（含清晰度 2 / 3 倍）
 *   Ⅲ 选中模块的字体大小与字体样式（内置几种系统字体）
 *
 * ## 为什么"页面尺寸"和"导出尺寸"必须在同一处说清楚
 *
 * 导出链路是「按页面宽 × 清晰度开离屏窗口 → 截图」，所以**导出 PNG 的像素尺寸 = 页面尺寸 × 清晰度**
 * 是恒等式，不是巧合。用户在这里改宽度就是在改导出图的宽度，所以这一节里把这句话直接写出来，
 * 并把上下限（`PAGE_SIZE_MIN/MAX`）标在输入框上 —— 以前这两个数只藏在报错文案里。
 */
export function EditRightPanel({ ctx }: { ctx: EditCtx }) {
  const size = ctx.page.size
  const auto = !size
  const w = ctx.frame.width
  const h = ctx.frame.height
  const neededH = contentHeightNeeded(ctx.frame, ctx.page.layout)
  const tooShort = h < neededH - 1

  /** 手填尺寸（自动模式时先用当前算出来的值起手，免得用户从空框开始填） */
  const setSize = (patch: { w?: number; h?: number }): void => {
    ctx.patch({ size: { w: patch.w ?? w, h: patch.h ?? h } })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto pl-1">
      <PanelSection
        title="Ⅰ 推荐页面大小"
        defaultOpen
        right={`${w} × ${h}`}
        hint={`范围 ${PAGE_SIZE_MIN}–${PAGE_SIZE_MAX} px。**这个尺寸就是导出图片的尺寸**（导出 PNG = 页面尺寸 × 清晰度倍数）。`}
      >
        <Row label="宽">
          <NumInput
            value={w}
            min={PAGE_SIZE_MIN}
            max={PAGE_SIZE_MAX}
            disabled={auto}
            onCommit={(v) => setSize({ w: v })}
          />
          <span className="text-[10px] text-faint">px</span>
        </Row>
        <Row label="高">
          <NumInput
            value={h}
            min={PAGE_SIZE_MIN}
            max={PAGE_SIZE_MAX}
            disabled={auto}
            onCommit={(v) => setSize({ h: v })}
          />
          <span className="text-[10px] text-faint">px</span>
        </Row>
        <div className="flex flex-wrap gap-1.5">
          <SegRow
            value={auto ? 'auto' : 'manual'}
            options={[
              { key: 'auto', label: '跟随内容（自适应）', title: '按版式与图片比例自动算尺寸' },
              { key: 'manual', label: '手动填', title: '手填之后不再被自动公式覆盖' }
            ]}
            onChange={(v) => {
              if (v === 'auto') ctx.patch({ size: undefined })
              // 从自动切到手填：以**当前算出来的尺寸**起手，用户再从它微调
              else setSize({})
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={auto || !tooShort}
            title="把高度设成内容刚好放得下的值"
            onClick={() => {
              setSize({ h: Math.min(PAGE_SIZE_MAX, neededH) })
              toast.success(`高度已按内容调整为 ${Math.min(PAGE_SIZE_MAX, neededH)}`)
            }}
          >
            按内容高度（{neededH}）
          </Button>
        </div>
        {tooShort ? (
          <div className="rounded-lg bg-warn/12 px-2 py-1.5 text-[10px] leading-relaxed text-warn">
            当前高度装不下整页内容（需要约 {neededH}px），超出的部分会被裁掉。
          </div>
        ) : null}
        <div className="text-[10px] leading-relaxed text-faint">
          {auto
            ? `自适应：没版面图片时 ${RL.width} × ${RL.baseHeight}，有图片时按比例与内容所需高度算。`
            : `手填值不会再被自动公式覆盖；点回「跟随内容（自适应）」清掉它。`}
        </div>
        {!auto ? (
          <Button size="sm" variant="outline" onClick={() => ctx.patchAll({ size: { w, h } })}>
            尺寸应用到所有页
          </Button>
        ) : null}
      </PanelSection>

      <PanelSection
        title="Ⅱ 导出为图片"
        defaultOpen
        hint="清晰度（2 倍 / 3 倍）、导出范围（当前页 / 多页长图）、这次出现哪些模块，都在弹出的窗口里选。"
      >
        <Button
          variant="soft"
          icon={ImageDown}
          loading={ctx.exporting}
          onClick={() => ctx.openExport()}
          className="w-full"
        >
          导出为图片
        </Button>
        <div className="text-[10px] leading-relaxed text-faint">
          成图尺寸约 {w} × {h} px 的 2 倍或 3 倍（离屏窗口按倍率渲染，不是把小图放大）。
        </div>
      </PanelSection>

      <FontSection ctx={ctx} />
    </div>
  )
}

/** Ⅲ 选中模块的字体大小与字体样式 */
function FontSection({ ctx }: { ctx: EditCtx }) {
  const id = ctx.selected
  const mod = id ? resolveModules(ctx.page).find((m) => m.id === id) : undefined
  const base = id ? MODULE_FONT_BASE[id] : 16
  const size = mod?.fontSize ?? base
  const family = mod?.fontFamily

  return (
    <PanelSection
      title="Ⅲ 模块字体与字号"
      defaultOpen
      right={id ? MODULE_NAMES[id] : '未选中'}
      hint="先选中一块（左菜单 Ⅱ 的列表，或直接在画布上点它）。改完立刻显示在画布与导出图上。"
    >
      {!id ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2 py-3 text-[10px] text-faint">
          <Ruler size={12} /> 还没有选中模块
        </div>
      ) : (
        <>
          <Row label="字号">
            <input
              type="range"
              min={MODULE_FONT_SIZE_MIN}
              max={MODULE_FONT_SIZE_MAX}
              value={size}
              onChange={(e) => ctx.setModuleFont(id, { fontSize: Number(e.target.value) })}
              className="min-w-0 flex-1 accent-accent"
            />
            <NumInput
              value={size}
              min={MODULE_FONT_SIZE_MIN}
              max={MODULE_FONT_SIZE_MAX}
              onCommit={(v) => ctx.setModuleFont(id, { fontSize: v })}
            />
          </Row>
          <Row label="字体">
            <select
              value={family ?? 'default'}
              onChange={(e) =>
                ctx.setModuleFont(id, {
                  fontFamily: e.target.value === 'default' ? null : (e.target.value as ModuleFontKey)
                })
              }
              className="h-7 min-w-0 flex-1 rounded-lg border border-border bg-elev1 px-1.5 text-[11px] text-text outline-none focus:border-accent"
            >
              {MODULE_FONTS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </Row>
          <div className="text-[10px] leading-relaxed text-faint">
            这一块的基准字号是 {base}px（不设字号时就是它），范围 {MODULE_FONT_SIZE_MIN}–{MODULE_FONT_SIZE_MAX}px。
            字体只提供系统内置的几种：导出用的离屏窗口不加载外部字体，非系统字体会**掉字**，
            所以这里刻意不给"任意字体名"输入框。
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              icon={RotateCcw}
              onClick={() => {
                ctx.setModuleFont(id, { fontSize: null, fontFamily: null })
                toast.success('已把这一块的字号与字体恢复默认')
              }}
            >
              恢复默认
            </Button>
          </div>
        </>
      )}
    </PanelSection>
  )
}

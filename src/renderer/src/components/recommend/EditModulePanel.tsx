import { Move, RotateCcw } from 'lucide-react'
import { toast } from '@/stores/app'
import {
  MODULE_H_MIN,
  MODULE_NAMES,
  MODULE_W_MIN,
  MODULE_KINDS,
  resolveModules,
  type ModuleKind
} from '@/stores/recommendTable'
import { Button, Switch } from '@/components/ui'
import { NumInput, PanelSection, Row } from './editBits'
import type { EditCtx } from './editTypes'
/**
 * 编辑模式**左菜单 Ⅱ / Ⅲ / Ⅶ**：模块的显隐、大小、摆放。
 *
 * 三项都围绕同一个「当前选中的模块」工作（`ctx.selected`）：
 * 选中的方式有两种 —— 点这里的模块行，或者在画布上点它（拖动叠层）。
 * 两种入口共用同一份选中态，所以"在画布上点一下，右边字体面板跟着换"是自然成立的。
 *
 * 摆放的坐标**只在编辑模式里写**：退出编辑模式后翻阅模式不会再碰 `page.layout` 的坐标，
 * 于是"自由摆放"是这个工具的一个模式，而不是处处生效的默认行为。
 */

/** 一行模块（名称 + 状态 + 显隐开关）；点击整行 = 选中它 */
function ModuleRow({ ctx, id }: { ctx: EditCtx; id: ModuleKind }) {
  const mod = resolveModules(ctx.page).find((m) => m.id === id)
  const visible = mod?.visible !== false
  const r = ctx.rects[id]
  const custom = mod?.x !== undefined || mod?.y !== undefined
  const on = ctx.selected === id
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors ${
        on ? 'border-accent bg-accent-soft/40' : 'border-border bg-elev1/40'
      }`}
    >
      <button
        type="button"
        onClick={() => ctx.setSelected(on ? null : id)}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-center gap-1.5 text-[11px] font-medium">
          <span className="truncate">{MODULE_NAMES[id]}</span>
          {custom ? (
            <span className="shrink-0 rounded-full bg-elev2 px-1.5 text-[9px] text-faint">自定义位置</span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[9px] tabular-nums text-faint">
          x{r.x} y{r.y} · {r.w}×{r.h}
        </div>
      </button>
      <Switch checked={visible} onChange={(v) => ctx.setModuleVisible(id, v)} />
    </div>
  )
}

/** Ⅱ 展示哪些模块 */
export function EditVisibleSection({ ctx }: { ctx: EditCtx }) {
  const mods = resolveModules(ctx.page)
  const hidden = mods.filter((m) => !m.visible).length
  return (
    <PanelSection
      title="Ⅱ 展示哪些模块"
      right={hidden > 0 ? `已隐藏 ${hidden}` : '全部显示'}
      hint="点一行可以选中它，再配合下面的「模块大小」「排版位置」调整。隐藏的模块不渲染、不导出、也不会去取它的图。"
    >
      <div className="space-y-1">
        {MODULE_KINDS.map((id) => (
          <ModuleRow key={id} ctx={ctx} id={id} />
        ))}
      </div>
      <Button
        size="sm"
        variant="outline"
        icon={RotateCcw}
        disabled={hidden === 0}
        onClick={() => {
          ctx.resetModules()
          toast.success('已把这一页的模块全部显示出来')
        }}
      >
        全部显示
      </Button>
    </PanelSection>
  )
}

/** Ⅲ 模块大小（作用于选中的那一块） */
export function EditSizeSection({ ctx }: { ctx: EditCtx }) {
  const id = ctx.selected
  const r = id ? ctx.rects[id] : null
  return (
    <PanelSection
      title="Ⅲ 模块大小"
      right={id ? MODULE_NAMES[id] : '未选中'}
      hint="先选中一块（上面的列表，或在画布上点它）。宽高也可以直接在画布上拖右下角的手柄。"
    >
      {!id || !r ? (
        <div className="rounded-lg border border-dashed border-border px-2 py-3 text-center text-[10px] text-faint">
          还没有选中模块
        </div>
      ) : (
        <>
          <Row label="宽">
            <input
              type="range"
              min={MODULE_W_MIN}
              max={Math.max(MODULE_W_MIN, ctx.frame.width - r.x)}
              value={r.w}
              onChange={(e) => ctx.setModuleRect(id, { w: Number(e.target.value) })}
              className="min-w-0 flex-1 accent-accent"
            />
            <NumInput
              value={r.w}
              min={MODULE_W_MIN}
              max={Math.max(MODULE_W_MIN, ctx.frame.width)}
              onCommit={(v) => ctx.setModuleRect(id, { w: v })}
            />
          </Row>
          <Row label="高">
            <input
              type="range"
              min={MODULE_H_MIN}
              max={Math.max(MODULE_H_MIN, ctx.frame.height - r.y)}
              value={r.h}
              onChange={(e) => ctx.setModuleRect(id, { h: Number(e.target.value) })}
              className="min-w-0 flex-1 accent-accent"
            />
            <NumInput
              value={r.h}
              min={MODULE_H_MIN}
              max={Math.max(MODULE_H_MIN, ctx.frame.height)}
              onCommit={(v) => ctx.setModuleRect(id, { h: v })}
            />
          </Row>
          <div className="text-[10px] leading-relaxed text-faint">
            范围 {MODULE_W_MIN}–{ctx.frame.width} × {MODULE_H_MIN}–{ctx.frame.height} px（页面尺寸）。
            改动立刻显示在画布上，导出用的是同一份几何。
          </div>
        </>
      )}
    </PanelSection>
  )
}

/** Ⅶ 自定义内容区域模块排版位置（拖动 + 坐标输入） */
export function EditPositionSection({ ctx }: { ctx: EditCtx }) {
  const id = ctx.selected
  const r = id ? ctx.rects[id] : null
  const mod = id ? resolveModules(ctx.page).find((m) => m.id === id) : undefined
  const custom = mod?.x !== undefined || mod?.y !== undefined
  return (
    <PanelSection
      title="Ⅶ 模块排版位置"
      right={id ? MODULE_NAMES[id] : '未选中'}
      hint="在画布上直接**拖动**模块就能改位置（按 Esc 或点空白处取消选中）。这里也能精确填坐标，坐标会被夹进页面内。"
    >
      {!id || !r ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2 py-3 text-[10px] text-faint">
          <Move size={12} /> 先选中一个模块，再拖它或填坐标
        </div>
      ) : (
        <>
          <Row label="X">
            <NumInput
              value={r.x}
              min={0}
              max={Math.max(0, ctx.frame.width - r.w)}
              onCommit={(v) => ctx.setModuleRect(id, { x: v })}
            />
            <span className="text-[10px] text-faint">Y</span>
            <NumInput
              value={r.y}
              min={0}
              max={Math.max(0, ctx.frame.height - r.h)}
              onCommit={(v) => ctx.setModuleRect(id, { y: v })}
            />
          </Row>
          <Row label="层级">
            <NumInput
              value={mod?.z ?? MODULE_KINDS.indexOf(id)}
              min={0}
              max={MODULE_KINDS.length}
              onCommit={(v) => ctx.setModuleRect(id, { z: v })}
            />
            <span className="text-[10px] leading-relaxed text-faint">大者压在别的模块上面</span>
          </Row>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={!custom}
              onClick={() => ctx.setModuleRect(id, null)}
            >
              这一块回到默认位置
            </Button>
            <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => ctx.resetRects()}>
              全部回到默认版式
            </Button>
          </div>
        </>
      )}
    </PanelSection>
  )
}

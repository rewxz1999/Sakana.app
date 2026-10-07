import { useMemo } from 'react'
import { Eye, EyeOff, RotateCcw } from 'lucide-react'
import { MODULE_NAMES, resolveModules, type ModuleKind, type RecommendPage } from '@/stores/recommendTable'
import { toast } from '@/stores/app'
import { Button, Modal, Switch } from '@/components/ui'
import { RL, displayName, frameOf, moduleRectsOf, pageHeightOf } from './styles'

/**
 * 「显示哪些模块」面板（v0.3.8 第三轮：**只保留显示 / 隐藏**）。
 *
 * ## 这一版删掉了什么，为什么
 *
 * 上一版这里是"自由布局"面板：能改 x/y/w/h、拖动手柄、调模块缩放（剧照大小 / 字号）。
 * 用户实测后决定**取消自定义移动模块**，所以坐标输入、拖动、scale 滑杆全部撤掉 ——
 * 位置一律由版式决定（`moduleRectsOf(frameOf(page))`），这里只**只读展示**每块放在哪，
 * 真正能改的只有开关。少了一套"用户坐标"之后，界面与导出也不再需要同步两份数据。
 *
 * ## 保留 / 仍在生效的东西
 *
 *   · 每个模块的**显示 / 隐藏**（按页保存，落在 `page.layout` 里）；
 *   · 默认摆放（store 的 `DEFAULT_MODULES`）与图片背景下的重排（侧栏一列 / 上图整体下移）；
 *   · 导出弹窗里的"这次展示哪些模块"（与页面的隐藏取交集，见 ExportDialog）。
 */
export function ModuleLayoutDialog({
  open,
  page,
  onToggle,
  onReset,
  onClose
}: {
  open: boolean
  page: RecommendPage | null
  onToggle: (id: ModuleKind, visible: boolean) => void
  /** 全部显示（= 清掉 layout，回到默认） */
  onReset: () => void
  onClose: () => void
}) {
  const modules = useMemo(() => (page ? resolveModules(page) : []), [page])
  const frame = useMemo(() => (page ? frameOf(page) : null), [page])
  const rects = useMemo(() => (frame ? moduleRectsOf(frame) : null), [frame])
  const hiddenCount = modules.filter((m) => !m.visible).length

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`显示哪些模块 · ${page ? displayName(page) : ''}`}
      width={560}
    >
      <div className="space-y-3">
        <div className="text-[11px] leading-relaxed text-faint">
          位置由版式统一决定（不能再拖动），这里只控制每一块要不要出现。
          隐藏的模块**不会参与渲染、不会被导出**，也不会去预取它的封面 / 剧照。
        </div>

        <div className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-1">
          {modules.map((m) => {
            const r = rects?.[m.id]
            return (
              <div
                key={m.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-elev1/60 p-2.5"
              >
                <span className="text-dim">
                  {m.visible ? <Eye size={14} /> : <EyeOff size={14} className="text-faint" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    {MODULE_NAMES[m.id]}
                    {!m.visible ? (
                      <span className="rounded-full bg-elev2 px-1.5 py-0.5 text-[10px] text-faint">已隐藏</span>
                    ) : null}
                  </div>
                  {/* 位置只读展示：让用户知道这一块现在摆在页面哪里（不能改） */}
                  <div className="mt-0.5 text-[10px] tabular-nums text-faint">
                    {r ? `位置 x${r.x} y${r.y} · ${r.w}×${r.h}` : '—'}
                  </div>
                </div>
                <span className="text-[10px] text-faint">{m.visible ? '显示中' : '已隐藏'}</span>
                <Switch checked={m.visible} onChange={(v) => onToggle(m.id, v)} />
              </div>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-elev1/60 p-2.5">
          <span className="text-[10px] leading-relaxed text-faint">
            页面 {RL.width} × {page ? pageHeightOf(page) : RL.baseHeight} px
            {frame && frame.pos !== 'none'
              ? ` · 图区在${frame.pos === 'left' ? '左' : frame.pos === 'right' ? '右' : '上'}侧 ${frame.imageW}×${frame.imageH}`
              : ' · 没有图片背景（整页都是内容区）'}
            {hiddenCount > 0 ? ` · 已隐藏 ${hiddenCount} 块` : ''}
          </span>
          <Button
            size="sm"
            variant="outline"
            icon={RotateCcw}
            disabled={hiddenCount === 0}
            onClick={() => {
              onReset()
              toast.success('已把这一页的模块全部显示出来')
            }}
          >
            全部显示
          </Button>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>完成</Button>
      </div>
    </Modal>
  )
}

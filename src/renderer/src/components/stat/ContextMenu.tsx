import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'

/**
 * 通用右键菜单。
 *
 * 状态流转（为什么是「受控 + 自定位」）：
 * 1. 条目上 onContextMenu → `preventDefault()` + 记下鼠标坐标（clientX/Y）与目标 id；
 * 2. 菜单是**受控**组件（`open` + `x` + `y`），自己不做任何业务判断，
 *    点条目 → 菜单只是渲染在坐标处；
 * 3. 关闭时机：点空白（window mousedown，捕获阶段）/ Esc / 滚动 / 窗口 resize / 选了某一项之后。
 *
 * 定位：菜单用 portal 挂到 body，按坐标摆放；贴近右/下边缘时自动翻转，
 * 避免菜单被窗口裁掉（小窗口模式下尤其明显）。
 */
export interface ContextMenuItem {
  key: string
  label: string
  icon?: ReactNode
  danger?: boolean
  /** 分隔线画在这一项上边 */
  divider?: boolean
  onSelect: () => void
}

export function ContextMenu({
  open,
  x,
  y,
  items,
  onClose
}: {
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // 菜单尺寸算出来之后再决定向左/向上翻转（首次渲染先按原坐标，下一帧修正）
  useEffect(() => {
    if (!open) return
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    let left = x
    let top = y
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - r.width - pad)
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad)
    setPos({ left, top })
  }, [open, x, y, items.length])

  useEffect(() => {
    if (!open) return
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // mousedown 用捕获阶段：点条目本身也会先关菜单，避免菜单"粘"在屏幕上
    window.addEventListener('mousedown', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={ref}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        style={{ left: pos.left, top: pos.top }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        className="fixed z-[120] min-w-[168px] overflow-hidden rounded-xl border border-border bg-elev1 py-1 shadow-2xl"
      >
        {items.map((it) => (
          <div key={it.key}>
            {it.divider ? <div className="my-1 border-t border-border" /> : null}
            <button
              type="button"
              onClick={() => {
                onClose()
                it.onSelect()
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                it.danger ? 'text-danger hover:bg-danger/12' : 'text-text hover:bg-elev2'
              }`}
            >
              {it.icon}
              <span className="whitespace-nowrap">{it.label}</span>
            </button>
          </div>
        ))}
      </motion.div>
    </AnimatePresence>,
    document.body
  )
}

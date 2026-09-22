import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'

/**
 * 通用右键菜单。
 *
 * 状态流转（为什么是「受控 + 自定位」）：
 * 1. 条目上 onContextMenu → `preventDefault()` + 记下鼠标坐标（clientX/Y）与目标 id；
 * 2. 菜单是**受控**组件（`open` + `x` + `y`），自己不做任何业务判断，
 *    点条目 → 菜单只是渲染在坐标处；
 * 3. 关闭时机：点**菜单外面**（window mousedown，捕获阶段）/ Esc / 滚动 / 窗口 resize / 选了某一项之后。
 *
 * 定位：菜单用 portal 挂到 body，按坐标摆放；贴近右/下边缘时自动翻转，
 * 避免菜单被窗口裁掉（小窗口模式下尤其明显）。
 *
 * ⚠️ v0.3.2 修掉的坑（用户反馈「番剧条目右键菜单没一个有用」）：
 * 原来这里的 window mousedown 监听**无条件**关闭菜单。window 上的捕获阶段监听
 * 比 React 的合成事件（挂在 #root 容器上、冒泡阶段）**先执行**，所以用户按下左键的瞬间
 * 菜单就被 `setMenu(null)` 卸载了 —— 菜单项按钮已经从 DOM 里消失，
 * 后面的 `click` 自然不会派发到它身上（浏览器的 click 目标是 mousedown/mouseup 目标的
 * 最近公共祖先，目标被摘掉后只剩 body），`onClick` 里的 `it.onSelect()` 一次都没跑过。
 * 父元素上的 `onMouseDown={stopPropagation}` 拦不住它：捕获阶段在 window 就已经走完了。
 * 所以现在只在**按下的目标不在菜单内部**时才关闭；菜单内部的 mousedown 一律忽略，
 * 由 click/回车去执行动作。
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
  /** 菜单项按钮：键盘上下移动焦点、回车执行动作都要用 */
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
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
    /**
     * 点菜单外面才关。
     *
     * 这里的判定不能用 `stopPropagation` 代替（见文件头）：window 上是捕获阶段，
     * 事件还没走到菜单就已经被这里看到了，父层的 React onMouseDown 拦不住。
     */
    const close = (e: Event): void => {
      const el = ref.current
      const target = e.target as Node | null
      if (el && target && el.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
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

  // 打开后把焦点放到第一项：「回车就能执行」本身是用户对这个菜单的预期（键盘/触控场景）
  // preventScroll：焦点变化可能触发滚动，而滚动监听会关菜单（见上面的 close）
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => itemRefs.current[0]?.focus({ preventScroll: true }), 0)
    return () => window.clearTimeout(t)
  }, [open, items.length])

  /** 执行第 i 项：先关菜单再跑动作（动作可能开弹窗，留着菜单会挡在上面） */
  const activate = (i: number): void => {
    const it = items[i]
    if (!it) return
    onClose()
    it.onSelect()
  }

  /** 键盘导航：↑↓ 移焦点，Home/End 到首尾，回车/空格执行（不依赖浏览器的隐式激活，行为可预期） */
  const onMenuKeyDown = (e: ReactKeyboardEvent): void => {
    const buttons = itemRefs.current.filter((b): b is HTMLButtonElement => !!b)
    if (buttons.length === 0) return
    const current = buttons.findIndex((b) => b === document.activeElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      const next = current < 0 ? 0 : (current + dir + buttons.length) % buttons.length
      buttons[next]?.focus({ preventScroll: true })
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      buttons[e.key === 'Home' ? 0 : buttons.length - 1]?.focus({ preventScroll: true })
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (current >= 0) activate(current)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

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
        onKeyDown={onMenuKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        className="fixed z-[120] min-w-[168px] overflow-hidden rounded-xl border border-border bg-elev1 py-1 shadow-2xl"
      >
        {items.map((it, i) => (
          <div key={it.key}>
            {it.divider ? <div className="my-1 border-t border-border" /> : null}
            <button
              ref={(el) => {
                itemRefs.current[i] = el
              }}
              type="button"
              onClick={() => activate(i)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors outline-none focus-visible:bg-elev2 ${
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

import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { api } from '@/lib/api'

function WinBtn({
  onClick,
  danger,
  title,
  children
}: {
  onClick: () => void
  danger?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-6 w-9 items-center justify-center rounded-md text-dim transition-colors ${
        danger ? 'hover:bg-danger hover:text-white' : 'hover:bg-elev2 hover:text-text'
      } whitespace-nowrap `}
    >
      {children}
    </button>
  )
}

/** 自定义标题栏（方案 1：窗口可拖动；v0.2.5 恢复自由缩放与最大化按钮） */
export function TitleBar() {
  const [isMax, setIsMax] = useState(false)

  // 最大化状态由主进程广播：双击标题栏 / 系统快捷键同样会改变状态
  useEffect(() => {
    void api.window.isMaximized().then(setIsMax)
    return api.window.onMaximizeChange(setIsMax)
  }, [])

  return (
    <div className="drag-region relative z-40 flex h-9 shrink-0 items-center justify-between border-b border-border bg-elev1 pl-3 pr-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm">🐟</span>
        <span className="text-[13px] font-semibold tracking-wide">Sakana</span>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent whitespace-nowrap">番剧管理</span>
      </div>
      <div className="no-drag flex items-center gap-0.5">
        <WinBtn title="最小化" onClick={() => void api.window.minimize()}>
          <Minus size={13} />
        </WinBtn>
        {/* v0.2.5：窗口恢复自由缩放，最大化按钮也一并回来 */}
        <WinBtn title={isMax ? '还原' : '最大化'} onClick={() => void api.window.maximizeToggle()}>
          {isMax ? <Copy size={11} className="-scale-x-100" /> : <Square size={11} />}
        </WinBtn>
        <WinBtn title="关闭" danger onClick={() => void api.window.close()}>
          <X size={14} />
        </WinBtn>
      </div>
    </div>
  )
}

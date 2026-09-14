import { Minus, X } from 'lucide-react'
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
      }`}
    >
      {children}
    </button>
  )
}

/** 自定义标题栏（方案 1：窗口可拖动；v0.2.4 起窗口只有小窗/全屏两种尺寸，去掉最大化） */
export function TitleBar() {
  return (
    <div className="drag-region relative z-40 flex h-9 shrink-0 items-center justify-between border-b border-border bg-elev1 pl-3 pr-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm">🐟</span>
        <span className="text-[13px] font-semibold tracking-wide">Sakana</span>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">番剧管理</span>
      </div>
      <div className="no-drag flex items-center gap-0.5">
        <WinBtn title="最小化" onClick={() => void api.window.minimize()}>
          <Minus size={13} />
        </WinBtn>
        {/*
          v0.2.4：主窗口锁定为「初始小窗 / 全屏」两种尺寸，最大化按钮已无意义
          （点了不会有任何反应，反而像坏了），因此不再渲染，只保留最小化与关闭。
        */}
        <WinBtn title="关闭" danger onClick={() => void api.window.close()}>
          <X size={14} />
        </WinBtn>
      </div>
    </div>
  )
}

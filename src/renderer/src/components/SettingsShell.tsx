import { useEffect, useState } from 'react'
import { ArrowLeft, type LucideIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'

// ============================================================
// 设置类子页面统一外壳
// - 作为小窗口打开时：不提供额外的关闭/退出按钮（标题栏 ✕ 是唯一关闭控件）
// - 在主窗口内渲染时：提供一个「返回」按钮（navigate(-1)）
// ============================================================

/** 卡片容器（与设置主页面 Section 视觉一致） */
export function Card({
  title,
  desc,
  children,
  className = ''
}: {
  title?: string
  desc?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-xl border border-border bg-elev1 p-4 ${className}`}>
      {title ? (
        <div className="mb-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          {desc ? <p className="mt-0.5 text-[11px] text-faint">{desc}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/**
 * 子页面外壳：统一头部（图标 + 标题 + 一行说明）、统一内边距 px-5 py-4、
 * 统一 h-full overflow-y-auto（内容不会被小窗口标题栏裁剪）。
 */
export function SubPage({
  icon: Icon,
  title,
  desc,
  actions,
  maxWidth = 'max-w-2xl',
  gap = 'gap-4',
  children
}: {
  icon?: LucideIcon
  title: string
  desc?: string
  actions?: React.ReactNode
  maxWidth?: string
  gap?: string
  children: React.ReactNode
}) {
  const navigate = useNavigate()
  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <div className={`mx-auto flex flex-col ${gap} pb-8 ${maxWidth}`}>
        <div className="flex items-start gap-3">
          {api.window.isSmallWindow ? null : (
            <button
              onClick={() => navigate(-1)}
              title="返回上一页"
              className="mt-0.5 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-dim transition-colors hover:border-accent hover:text-accent"
            >
              <ArrowLeft size={13} /> 返回
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-base font-bold">
              {Icon ? <Icon size={17} className="text-accent" /> : null}
              {title}
            </h1>
            {desc ? <p className="mt-0.5 text-[11px] leading-relaxed text-faint">{desc}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
        {children}
      </div>
    </div>
  )
}

// ============================================================
// 下载链接：已内置时先提示、二次点击才打开下载页
// ============================================================

export type BuiltinAsset = 'vlc' | 'ffmpeg' | 'aria2'

const ASSET_NAME: Record<BuiltinAsset, string> = {
  vlc: 'libVLC',
  ffmpeg: 'FFmpeg',
  aria2: 'aria2c'
}

/**
 * 组件下载链接。
 * builtin=true 且首次点击 → 仅 toast 提示「已内置，通常无需下载」，不打开浏览器；
 * 再次点击同一链接才真正打开下载页（轻量二次确认，避免误开浏览器）。
 * builtin=false → 提示需要下载并直接打开；builtin=null（未探测出结果）→ 直接打开。
 */
export function AssetLink({
  asset,
  url,
  label,
  builtin,
  className = 'text-accent hover:underline'
}: {
  asset: BuiltinAsset
  url: string
  label?: string
  builtin: boolean | null
  className?: string
}) {
  const [armed, setArmed] = useState(false)
  const name = ASSET_NAME[asset]

  // 8 秒内未再次点击则复位，避免长期处于「已确认」状态
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 8000)
    return () => clearTimeout(t)
  }, [armed])

  const onClick = (): void => {
    if (builtin === true && !armed) {
      setArmed(true)
      toast.info(`${name} 已内置，通常无需下载；如仍要前往下载页，请再次点击该链接`)
      return
    }
    if (builtin === false) toast.info(`未检测到内置 ${name}，需要自行安装；正在打开下载页…`)
    setArmed(false)
    void api.app.openPath(url)
  }

  return (
    <button className={className} onClick={onClick}>
      {label ?? `${name} 下载页`}
      {builtin ? <span className="ml-1 text-[10px] text-ok">已内置</span> : null}
    </button>
  )
}

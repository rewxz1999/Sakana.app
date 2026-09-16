import { useEffect, useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui'
import { useSettings } from '@/stores/app'
import { announcementFor } from '@/lib/announcements'

/**
 * 启动公告弹窗（v0.2.8 附加）。
 *
 * 每次启动弹一次，内容为「本次版本的更新内容 + 开发者寄语」；
 * 勾选「不再提示」后以后不再弹，但**版本更新时无视该勾选**再弹一次 ——
 * 用 `settings.announcementSeenVersion` 记录用户已经看过哪个版本的公告：
 * - `seenVersion === 当前版本 && announcementMuted` → 不弹；
 * - 版本变了（seenVersion 不等于当前版本）→ 无论是否勾选都弹。
 *
 * 挂在应用根部（App），小窗口 / 播放器 / 悬浮窗里都不渲染。
 */
export function AnnouncementModal(): React.ReactElement | null {
  const { settings, save } = useSettings()
  const [version, setVersion] = useState('')
  const [open, setOpen] = useState(false)
  const [muted, setMuted] = useState(false)
  /**
   * v0.2.8 附加 修「必须勾选才能关掉」：
   * 之前关闭时会把 `announcementSeenVersion` 写进设置，而写入又触发本组件重渲染 →
   * 「同版本 + 未勾选不再提示」的条件依然成立 → 弹窗**立刻又被打开**，
   * 于是看起来就像「不勾『不再提示』就关不掉」。这里加一次性闸门，关掉就不再自动打开。
   */
  const autoOpenedRef = useRef(false)

  useEffect(() => {
    let alive = true
    void api.app
      .version()
      .then((r) => {
        if (alive && r.ok) setVersion(String(r.data ?? ''))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (autoOpenedRef.current) return
    if (!version || !settings) return
    const a = announcementFor(version)
    if (!a) return
    autoOpenedRef.current = true
    const seen = settings.announcementSeenVersion
    const mutedFlag = settings.announcementMuted === true
    if (seen === version && mutedFlag) return
    setMuted(false)
    setOpen(true)
  }, [version, settings])

  if (!open) return null
  const a = announcementFor(version)
  if (!a) return null

  /** 关闭（是否勾选都直接关；勾了才记住「不再提示」） */
  const close = (): void => {
    setOpen(false)
    save({ announcementSeenVersion: version, announcementMuted: muted })
  }

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 backdrop-blur-sm"
      onMouseDown={(e) => {
        // 点遮罩空白处也能关闭（不需要先勾选）
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="flex max-h-[86vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-border bg-elev1 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
          <Sparkles size={16} className="text-accent" />
          <div className="flex-1 text-sm font-semibold">Sakana v{version} 更新公告</div>
          <button
            title="关闭"
            onClick={close}
            className="rounded-md p-1 text-dim transition-colors hover:bg-elev2 hover:text-text"
          >
            <X size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {a.image ? (
            <img
              src={a.image}
              alt=""
              draggable={false}
              className="mb-4 w-full select-none rounded-xl border border-border object-cover"
            />
          ) : null}
          <div className="text-[11px] text-faint">本次更新</div>
          <ul className="mt-1.5 flex flex-col gap-1 text-[13px] leading-relaxed text-text">
            {a.notes.map((n) => (
              <li key={n} className="flex gap-2">
                <span className="text-accent">·</span>
                <span>{n}</span>
              </li>
            ))}
          </ul>
          {a.messages.length > 0 ? (
            <>
              <div className="mt-4 text-[11px] text-faint">开发者寄语</div>
              <div className="mt-1.5 flex flex-col gap-1 text-[13px] leading-relaxed text-dim">
                {a.messages.map((m) => (
                  <div key={m}>{m}</div>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-dim">
            <input
              type="checkbox"
              checked={muted}
              onChange={(e) => setMuted(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            不再提示（下次更新时仍会提醒）
          </label>
          <Button size="sm" onClick={close}>
            知道了
          </Button>
        </div>
      </div>
    </div>
  )
}

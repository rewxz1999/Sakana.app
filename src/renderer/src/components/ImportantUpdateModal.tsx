import { useEffect, useState } from 'react'
import { Rocket, ShieldAlert } from 'lucide-react'
import type { UpdateInfo } from '@shared/types'
import { api } from '@/lib/api'
import { Button } from '@/components/ui'

/**
 * 重要更新强提醒（v0.2.12）。
 *
 * 用户要求：「本次更新十分重要，之后只要是十分重要的更新都要在应用启动后**弹窗强烈提醒**用户更新」。
 *
 * 触发链路：主进程启动后 14 秒检查一次更新（`notifyImportantUpdate()`），
 * 发现 Release 说明里带 `【重要更新】` 标记就通过 `ev:update-important` 推给主窗口，
 * 这里弹出一个**不可忽略的强提醒**（点遮罩不关、必须点「立即更新」或「稍后」，
 * 与安装包里的公告弹窗一致——那个也是刻意不提供「点外面关闭」）。
 *
 * 为什么不复用启动公告：公告是「看过了就不弹」，重要更新是「没更新就一直提醒」，
 * 两者的记忆方式不同；分开做，用户点「稍后」也只是本次启动安静，下次启动仍会提醒。
 */
export function ImportantUpdateModal() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)

  useEffect(() => api.app.onUpdateImportant((i) => setInfo(i)), [])

  if (!info) return null

  const go = (): void => {
    void api.app.updateOpenWindow()
    setInfo(null)
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-elev1 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border bg-danger/10 px-4 py-3">
          <ShieldAlert size={18} className="shrink-0 text-danger" />
          <div className="text-sm font-semibold">重要更新：v{info.latest}</div>
        </div>
        <div className="max-h-64 overflow-y-auto px-4 py-3">
          <div className="text-xs leading-relaxed text-dim">
            这个版本包含重要修复或改动，建议尽快更新（当前版本 v{info.current}）。
          </div>
          {info.notes ? (
            <div className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-elev2 px-3 py-2 text-[11px] leading-relaxed text-dim">
              {info.notes}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void api.app.updateSnooze(info.latest)
              setInfo(null)
            }}
          >
            稍后
          </Button>
          <Button size="sm" icon={Rocket} onClick={go}>
            立即更新
          </Button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { CalendarClock, X } from 'lucide-react'
import type { StatEntry } from '@shared/types'
import { localInputToTs, tsToLocalInput } from '@/stores/statTool'

/**
 * 看完时间：**只用日期时间选择器**（用户明确要求「直接选时间」，不要手打）。
 *
 * 状态流转：
 * - 显示态：`<input type="datetime-local">` 外面包一层，同时显示当前值的可读文案；
 * - 改动：onChange 立刻回调（每改一段都会触发），交给调用方 `updateEntry`，
 *   store 做乐观更新 + 主进程广播收敛，所以这里不需要「确定」按钮；
 * - 清空：右侧小 × 把值置 null（= 还没看完）。
 *
 * 值格式说明：entry.watchedAt 存的是 `YYYY-MM-DDTHH:mm`（本地时间、无时区），
 * 与 input[type=datetime-local] 的 value 格式一致，不需要时区换算，避免"选 3 号显示 2 号"。
 */
export function DateTimeField({
  value,
  onChange,
  className = ''
}: {
  value: string | null
  onChange: (v: string | null) => void
  className?: string
}) {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])

  const ts = localInputToTs(value)
  const readable = ts != null ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '未填写'

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="relative flex-1">
        <CalendarClock
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
        />
        <input
          type="datetime-local"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            onChange(e.target.value || null)
          }}
          className="h-9 w-full rounded-lg border border-border bg-elev1 pl-8 pr-2 text-xs tabular-nums text-text outline-none transition-colors focus:border-accent"
        />
      </div>
      <span className="w-[132px] shrink-0 text-[11px] tabular-nums text-faint">{readable}</span>
      {value ? (
        <button
          type="button"
          title="清空看完时间"
          onClick={() => {
            setText('')
            onChange(null)
          }}
          className="shrink-0 text-faint transition-colors hover:text-danger"
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  )
}

/** 把收藏里可能存在的「YYYY-MM-DD」旧值补成 datetime-local 需要的完整值 */
export function normalizeWatchedAt(v: string | null): string | null {
  if (!v) return null
  const s = v.trim()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return s
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00`
  const ts = localInputToTs(s)
  return ts != null ? tsToLocalInput(ts) : null
}

/** 列表条目上展示看完时间用（紧凑：同一天不显示年份） */
export function shortWatchedAt(v: string | null): string {
  const t = normalizeWatchedAt(v)
  if (!t) return ''
  const [d, time] = t.split('T')
  const [y, m, day] = d.split('-')
  const thisYear = String(new Date().getFullYear()) === y
  return `${thisYear ? '' : `${y}-`}${m}-${day} ${time}`
}

/** 条目 → 详情窗口所需的全部派生值（放一起便于对照字段来源表） */
export function entryDeviation(e: Pick<StatEntry, 'personalRating' | 'bgmRating'>): number | null {
  if (e.personalRating == null || e.bgmRating == null) return null
  return e.personalRating - e.bgmRating
}

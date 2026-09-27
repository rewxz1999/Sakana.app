import { useEffect, useState } from 'react'
import { CalendarDays, X } from 'lucide-react'
import type { StatEntry } from '@shared/types'
import { dayToTs, tsToDay } from '@/stores/statTool'

/**
 * 看完时间：**只用日期选择器，且只到天**。
 *
 * 用户两条要求叠在一起：
 * - 「直接选时间，不要手打」→ 用原生 `<input type="date">`，没有输入框解析的坑；
 * - 「不用精确到分秒，只用到天」→ v0.3.5 起存 `YYYY-MM-DD`。
 *   过去是 `datetime-local` + `YYYY-MM-DDTHH:mm`：时分没人看，还把导出图的「看完」一行撑得很长。
 *
 * 状态流转：
 * - 显示态：日期选择器 + 右侧可读文案（`2026-09-21 周一`），改动立刻回调（无「确定」按钮）；
 * - 清空：右侧小 × 把值置 null（= 还没看完）。
 *
 * 值格式：`YYYY-MM-DD`（本地时间、无时区），与 `input[type=date]` 的 value 一致，
 * 不需要时区换算，避免"选 3 号显示 2 号"。老数据里的 `…T21:04` / 带时区的 ISO
 * 由 `normalizeWatchedAt` 归一化成天。
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

  const day = normalizeWatchedAt(value)
  const readable = day ? `${day} ${weekdayOf(day)}` : '未填写'

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="relative flex-1">
        <CalendarDays
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
        />
        <input
          type="date"
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

/** `2026-09-21` → `周一`（无效日期返回空串） */
function weekdayOf(day: string): string {
  const ts = dayToTs(day)
  if (ts == null) return ''
  return new Date(ts).toLocaleDateString('zh-CN', { weekday: 'short' })
}

/**
 * 看完时间归一化（**只到天**）：兼容历史三种形态 ——
 * `YYYY-MM-DD`（新）原样、`YYYY-MM-DDTHH:mm`（v0.2）取日期部分、带时区的 ISO 按本地时区取日期。
 * 与主进程 `statStore.dayOnly()` 同一套语义（那边是落盘的底线，这边是界面显示用）。
 */
export function normalizeWatchedAt(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m && !/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return `${m[1]}-${m[2]}-${m[3]}`
  const ts = Date.parse(s)
  if (Number.isNaN(ts)) return m ? `${m[1]}-${m[2]}-${m[3]}` : null
  return tsToDay(ts)
}

/**
 * 列表条目上展示看完时间用。
 *
 * 只到天之后不再拼接时分；同一年的条目省掉年份（表上年份重复出现没有信息量）。
 */
export function shortWatchedAt(v: string | null): string {
  const day = normalizeWatchedAt(v)
  if (!day) return ''
  const [y, m, d] = day.split('-')
  const thisYear = String(new Date().getFullYear()) === y
  return `${thisYear ? '' : `${y}-`}${m}-${d}`
}

/** 条目 → 详情窗口所需的全部派生值（放一起便于对照字段来源表） */
export function entryDeviation(e: Pick<StatEntry, 'personalRating' | 'bgmRating'>): number | null {
  if (e.personalRating == null || e.bgmRating == null) return null
  return e.personalRating - e.bgmRating
}

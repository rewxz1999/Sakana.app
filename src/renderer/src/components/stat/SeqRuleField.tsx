import { useMemo } from 'react'
import { Hash } from 'lucide-react'
import { describeSeqRule, validateSeqRule } from '@shared/statSeq'

/**
 * 「序号规则」输入框（新建列表 / 列表设置 / 添加番剧三处共用）。
 *
 * 为什么要一个共用组件：规则校验必须**和主进程一模一样**（两边都调 shared/statSeq.ts 的
 * validateSeqRule），所以在输入时就给出中文原因，而不是等用户点确定、主进程默默拒绝。
 *
 * 规则只有两种合法形态（用户要求）：
 * - 纯数字，最多 8 位：`20260701` → 第二条 `20260702`；
 * - 字母前缀 + 数字（字母只能在最前、最多 4 位）：`A0701` → 第二条 `A0702`。
 * 留空 = 默认规则「放送年份 + 01、02、03…」（2026 年第 1 条 = `202601`）。
 * 规则里的数字部分就是**起始号**：第一条用规则本身，之后按列表里已有最大号 + 1 续号。
 */
export function SeqRuleField({
  value,
  onChange,
  disabled,
  className = '',
  /** 占位提示里的示例（不同入口给的例子不同，列表默认 20260701、条目默认 A0701） */
  placeholder = '如 20260701 或 A0701（留空 = 放送年份 + 01、02…）'
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  className?: string
  placeholder?: string
}) {
  const check = useMemo(() => validateSeqRule(value), [value])
  const hint = useMemo(() => describeSeqRule(value), [value])
  const bad = !check.ok

  return (
    <div className={className} data-stat-seq-rule="">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-dim">
        <Hash size={13} className="text-accent" /> 序号规则
        <span className="text-[10px] font-normal text-faint">可留空 · 字母只能在最前面 · 数字最多 8 位</span>
      </div>
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`h-9 w-full rounded-lg border bg-elev1 px-3 text-sm tabular-nums outline-none transition-colors placeholder:text-faint disabled:opacity-60 ${
          bad ? 'border-danger focus:border-danger' : 'border-border focus:border-accent'
        }`}
      />
      <div className={`mt-1 text-[10px] leading-relaxed ${bad ? 'text-danger' : 'text-faint'}`} data-stat-seq-hint="">
        {bad ? `不合法的序号规则：${hint}` : hint}
      </div>
    </div>
  )
}

// ============================================================
// 统计工具「序号规则」的**唯一定义处**（主进程 / 渲染层共用）
// ============================================================
//
// 为什么单独一个文件：序号规则必须在**两处**同时成立 ——
// - 主进程 `statStore.applyStatAction()` 用它给新条目编号、给列表重新编号；
// - 渲染层「新建列表 / 序号规则」输入框用它做实时校验并给出中文原因。
// 两处各写一份实现必然漂移（历史上 season 那套就吃过这个亏，才有了 shared/season.ts），
// 所以这里只放纯函数：`(输入) → (输出)`，不碰 electron / fs / 网络，能被 Node 直接跑。
//
// 规则约定（用户原话）：
// - 形态只有两种：**纯数字**、或**字母前缀 + 数字**（字母只能在最前面几位）；
// - 数字部分**最多 8 位**；纯数字例 `20260701` → 下一个 `20260702`（数值 +1，保持位数）；
// - 带前缀例 `A0701` → 下一个 `A0702`（字母不变，数字 +1 且保持位数）；
// - 没有自定义规则 = 默认规则：**放送年份 + 01、02、03…**（2026 年第 1 条 = `202601`）；
//   年份取该条目的放送年份，取不到就用当前年份。
//
// 「保持位数、进位时按实际位数增长」的实现：数字部分先按数值 +1，再补前导零回到模板宽度；
// 若 +1 后位数已经超过模板宽度（如 A0999 → 1000），就按实际位数写（A1000），
// 但**始终**校验数字部分不超过 8 位，超了直接报错而不是写出一个 9 位序号。

/** 数字部分上限（用户要求：最大 8 位数） */
export const SEQ_MAX_DIGITS = 8
/** 字母前缀上限（用户说「字母只能在前面几位」，这里定 4 位，够用且不至于让序号长得离谱） */
export const SEQ_MAX_LETTERS = 4
/** 默认规则里顺序号的补零位数（2026 + 01 → 202601） */
export const SEQ_DEFAULT_PAD = 2

export interface SeqRuleSpec {
  /** 字母前缀（可为空串 = 纯数字规则），保留用户输入的大小写 */
  prefix: string
  /** 数字部分原文（含前导零，如 `0701`） */
  digits: string
  /** 数字部分模板宽度（= digits.length） */
  width: number
}

export type SeqRuleCheck = { ok: true; rule: string } | { ok: false; reason: string }
export type SeqNext = { ok: true; seq: string } | { ok: false; reason: string }
export interface SeqNextOptions {
  /**
   * 默认规则用的年份（4 位）。
   * 只有「无自定义规则」时用得到：自定义规则的序号与年份无关。
   */
  year?: string | number | null
  /** 便于测试注入「当前年份」（取不到放送年份时的兜底） */
  now?: Date
}

/** 当前年份（4 位字符串） */
export function currentYear(now: Date = new Date()): string {
  return String(now.getFullYear())
}

/**
 * 校验一条序号规则。
 *
 * 空串/空白 = **合法**，语义是「用默认规则（放送年份 + 01、02…）」——
 * 这样界面上「不填」和「填了又删掉」是同一个结果，不需要额外的开关。
 */
export function validateSeqRule(raw: string | null | undefined): SeqRuleCheck {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: true, rule: '' }
  // 空白先判：`A 0701` 这种给「不能包含空格」比给「只能用字母和数字」更好懂
  if (/\s/.test(s)) return { ok: false, reason: '不能包含空格' }
  if (/[^\x20-\x7E]/.test(s)) return { ok: false, reason: '只能用英文字母和数字（不支持中文、全角字符）' }
  if (/[^A-Za-z0-9]/.test(s)) return { ok: false, reason: '只能用英文字母和数字（不支持符号）' }

  const prefix = /^[A-Za-z]*/.exec(s)?.[0] ?? ''
  const digits = s.slice(prefix.length)
  if (!digits) return { ok: false, reason: '缺少数字部分（例如 A0701、20260701）' }
  if (!/^\d+$/.test(digits)) return { ok: false, reason: '字母只能放在最前面（例如 A0701，不能写成 0A701 或 A7B01）' }
  if (prefix.length > SEQ_MAX_LETTERS) return { ok: false, reason: `字母最多 ${SEQ_MAX_LETTERS} 位（当前 ${prefix.length} 位）` }
  if (digits.length > SEQ_MAX_DIGITS) return { ok: false, reason: `数字最多 ${SEQ_MAX_DIGITS} 位（当前 ${digits.length} 位）` }
  return { ok: true, rule: s }
}

/** 解析规则；非法返回 null（调用方一般先用 validateSeqRule 拿到中文原因） */
export function parseSeqSpec(raw: string | null | undefined): SeqRuleSpec | null {
  const check = validateSeqRule(raw)
  if (!check.ok || !check.rule) return null
  const prefix = /^[A-Za-z]*/.exec(check.rule)?.[0] ?? ''
  const digits = check.rule.slice(prefix.length)
  return { prefix, digits, width: digits.length }
}

/** 默认规则：放送年份 + 两位顺序（第 100 条自然变成三位，不再补零） */
export function defaultSeqOf(year: string, n: number): string {
  const value = Math.max(1, Math.trunc(n) || 1)
  return `${year}${String(value).padStart(SEQ_DEFAULT_PAD, '0')}`
}

/**
 * 放送年份：取 `airDate`（YYYY-MM-DD）前 4 位；取不到（空 / 不是 4 位数字）用当前年份。
 *
 * v0.3.5 起的行为变化：过去取不到时用 `'0000'`，编号会变成 `000001` 这种谁也看不懂的序号；
 * 用户明确要求「取不到就用当前年份」，所以这里回落到当前年份。
 */
export function yearOfAirDate(airDate: string | null | undefined, now: Date = new Date()): string {
  const y = String(airDate ?? '').slice(0, 4)
  return /^\d{4}$/.test(y) ? y : currentYear(now)
}

/** 该序号是否「属于」这条规则（字母前缀大小写不敏感比较） */
export function seqMatchesRule(seq: string, spec: SeqRuleSpec): boolean {
  const s = String(seq ?? '').trim()
  if (!s) return false
  if (spec.prefix) {
    if (s.length <= spec.prefix.length) return false
    if (s.slice(0, spec.prefix.length).toLowerCase() !== spec.prefix.toLowerCase()) return false
    return /^\d+$/.test(s.slice(spec.prefix.length))
  }
  return /^\d+$/.test(s)
}

/**
 * 算下一个序号。
 *
 * @param rule 序号规则模板；空/未填 = 默认规则（年份 + 01、02…）
 * @param existingSeqs 同一列表里**已有**的序号（顺序无关，内部取最大值续号）
 * @param opts 默认规则需要年份；`now` 只影响「取不到年份」时的兜底，便于测试注入
 *
 * 语义要点（对着用户给的例子）：
 * - 规则 `20260701` + 尚无条目 → 第一条就是 `20260701`（规则本身当作起始号），第二条 `20260702`；
 * - 规则 `A0701` + 尚无条目 → `A0701`，第二条 `A0702`；
 * - 已有条目时按「同规则序号的最大值 + 1」续号（用户要求「按当前最大值续号，不要重复」），
 *   所以拖删之后不会出现重号；纯数字规则还会把列表里已有的纯数字序号一并纳入比较，
 *   避免「默认编号 202601… 的列表改成 20260701 规则」时算出已经用过的号。
 */
export function nextSeq(
  rule: string | null | undefined,
  existingSeqs: (string | null | undefined)[] | null | undefined,
  opts: SeqNextOptions = {}
): SeqNext {
  const list = (Array.isArray(existingSeqs) ? existingSeqs : [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
  const raw = String(rule ?? '').trim()

  // ---- 默认规则：年份 + 01、02、03… ----
  if (!raw) {
    const year = String(opts.year ?? '').trim() || currentYear(opts.now)
    const y = /^\d{4}$/.test(year) ? year : currentYear(opts.now)
    let max = 0
    for (const s of list) {
      if (!s.startsWith(y)) continue
      const rest = s.slice(y.length)
      if (!/^\d+$/.test(rest)) continue
      max = Math.max(max, Number(rest))
    }
    return { ok: true, seq: defaultSeqOf(y, max + 1) }
  }

  // ---- 自定义规则 ----
  const check = validateSeqRule(raw)
  if (!check.ok) return { ok: false, reason: check.reason }
  const spec = parseSeqSpec(check.rule)
  if (!spec) return { ok: false, reason: '序号规则不合法' }

  const startValue = Number(spec.digits)
  let max = 0
  let hit = false
  for (const s of list) {
    if (!seqMatchesRule(s, spec)) continue
    const rest = spec.prefix ? s.slice(spec.prefix.length) : s
    const v = Number(rest)
    if (!Number.isFinite(v)) continue
    max = Math.max(max, v)
    hit = true
  }
  /*
   * 规则里的数字部分就是**起始号**：
   * - 没有任何同规则序号 → 直接用起始号（用户例子：规则 `20260701` 的第一条就是 `20260701`）；
   * - 已经有同规则序号 → 取 `已有最大号 + 1`，但不会小于起始号 ——
   *   因为起始号可能还没被用过（列表里只有更小的默认编号时），此时第一条应当拿到起始号本身。
   *   这样既满足「按当前最大值续号，不要重复」，又不会把规则给定的起始号跳过去。
   */
  const next = hit ? Math.max(max + 1, startValue) : startValue
  const digitStr = String(next)
  if (digitStr.length > SEQ_MAX_DIGITS) {
    return { ok: false, reason: `序号数字部分已达 ${SEQ_MAX_DIGITS} 位上限（${check.rule} 无法继续 +1）` }
  }
  // 保持模板位数；进位溢出时按实际位数（A0999 → A1000）
  const padded = digitStr.length >= spec.width ? digitStr : digitStr.padStart(spec.width, '0')
  return { ok: true, seq: `${spec.prefix}${padded}` }
}

/**
 * 规则的界面说明文案（输入框下面那行提示）。
 *
 * 例：`20260701` → 「纯数字 8 位 · 下一个 20260702」；
 * `A0701` → 「前缀 A + 数字 4 位 · 下一个 A0702」；
 * 空 → 默认规则说明。
 */
export function describeSeqRule(raw: string | null | undefined, opts: SeqNextOptions = {}): string {
  const check = validateSeqRule(raw)
  if (!check.ok) return check.reason
  if (!check.rule) {
    const y = yearOfAirDate(null, opts.now)
    return `默认规则：放送年份 + 顺序号（如 ${defaultSeqOf(y, 1)}、${defaultSeqOf(y, 2)}；取不到放送年份时用当前年份 ${currentYear(opts.now)}）`
  }
  const spec = parseSeqSpec(check.rule)
  if (!spec) return '序号规则不合法'
  const next = nextSeq(check.rule, [], opts)
  const shape = spec.prefix
    ? `前缀 ${spec.prefix} + 数字 ${spec.width} 位`
    : `纯数字 ${spec.width} 位`
  return next.ok ? `${shape} · 下一条将是 ${next.seq}` : `${shape} · ${next.reason}`
}

/**
 * 条目在列表 / 导出图里的排序。
 *
 * 为什么排序要放这里共用：界面列表与导出图片必须**完全同序**，
 * 两处各写一份很容易在「拖动排序」之后出现「界面一个顺序、导出图另一个顺序」。
 *
 * 主键是 `order`（用户拖动出来的顺序，加入时按编号给初值），
 * 次键是 `seq`（老数据只有 seq 时也能稳定排），最后用 `id` 保证比较结果确定。
 */
export function compareStatOrder(
  a: { order: number; seq: string; id: string },
  b: { order: number; seq: string; id: string }
): number {
  const oa = Number(a.order) || 0
  const ob = Number(b.order) || 0
  if (oa !== ob) return oa - ob
  const sa = String(a.seq ?? '')
  const sb = String(b.seq ?? '')
  if (sa !== sb) return sa.localeCompare(sb)
  return String(a.id ?? '').localeCompare(String(b.id ?? ''))
}

import { useEffect, useState } from 'react'
import { Check, Hash, Info, Layers } from 'lucide-react'
import { Button, Input, Modal, Textarea } from '@/components/ui'
import {
  MAX_TIERS,
  MIN_TIERS,
  TIER_TEMPLATES,
  customTierOverflow,
  parseCustomTiers,
  readableTextOn,
  tierDefs,
  type TierDef
} from '@/stores/rankingTable'

/**
 * 「新建排名表 / 修改等级标签」弹窗。
 *
 * 用户流程是「输入表名 → 选一套默认等级标签，或自己写一套 → 进入排表界面」（用户原话），
 * 所以这两件事必须在同一个弹窗里一次做完，而不是建完空表再让用户去别处设置等级 ——
 * 那样用户建完表会面对一张没有任何等级的表格，不知道下一步做什么。
 *
 * 自定义输入刻意做成「一行/空格/顿号分隔都认」（见 parseCustomTiers）：
 * 用户最可能直接从备忘录或群里把「夯 顶级 人上人」粘进来，要求他逐行换行是多余的摩擦。
 *
 * 三套模板都自带一套默认配色（见 stores/rankingTable.ts 的 TIER_TEMPLATES）：
 * 这里把它们**显示出来**（预览里的色点），但不在这个弹窗里改色 ——
 * 改色是在排表界面上点标签旁边的小色板（那里能一边看效果一边调）。超过 10 档的部分会被截掉，
 * 这里必须提示「已忽略几个」（用户要求"超出要拦住并提示"）。
 */

/** 选中的是哪一套（三套模板 + 自定义） */
type TierChoice = string

export function TableSetupDialog({
  open,
  mode,
  initialName,
  initialTiers,
  onClose,
  onSubmit
}: {
  open: boolean
  mode: 'create' | 'edit'
  initialName: string
  initialTiers: TierDef[]
  onClose: () => void
  onSubmit: (name: string, tiers: TierDef[]) => void
}) {
  const [name, setName] = useState(initialName)
  const [choice, setChoice] = useState<TierChoice>(TIER_TEMPLATES[0].id)
  const [custom, setCustom] = useState('')

  // 每次打开都把草稿重置成当前值：同一个弹窗会先用于新建、再用于改标签，留着上一轮的内容最容易误操作
  useEffect(() => {
    if (!open) return
    setName(initialName)
    const names = initialTiers.map((t) => t.name).join('|')
    const hit = TIER_TEMPLATES.find((t) => t.tiers.map((x) => x.name).join('|') === names)
    setChoice(hit ? hit.id : 'custom')
    setCustom(initialTiers.map((t) => t.name).join('\n'))
    // 只在弹窗打开的那一刻同步一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 自定义标签按顺序拿循环配色（模板则用各自写好的默认色）
  const picked: TierDef[] =
    choice === 'custom'
      ? tierDefs(parseCustomTiers(custom))
      : (TIER_TEMPLATES.find((t) => t.id === choice)?.tiers ?? [])
  const overflow = choice === 'custom' ? customTierOverflow(custom) : 0
  const nameOk = name.trim().length > 0
  const tiersOk = picked.length >= MIN_TIERS && picked.length <= MAX_TIERS

  return (
    <Modal open={open} onClose={onClose} title={mode === 'create' ? '新建排名表' : '表名与等级标签'} width={620}>
      <div className="flex flex-col gap-4">
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-dim">
            <Hash size={13} className="text-accent" /> 表名
          </div>
          <Input
            value={name}
            autoFocus
            maxLength={40}
            placeholder="例如：2025 年我看过的番剧排名"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-dim">
            <Layers size={13} className="text-accent" /> 默认排名标签（从高到低，每套自带默认配色）
          </div>
          <div className="flex flex-col gap-2">
            {TIER_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setChoice(t.id)}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                  choice === t.id ? 'border-accent bg-accent-soft' : 'border-border bg-elev1 hover:border-accent/50'
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    choice === t.id ? 'border-accent bg-accent text-white' : 'border-border'
                  }`}
                >
                  {choice === t.id ? <Check size={11} /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold">{t.name}</span>
                  <span className="mt-0.5 block text-[11px] text-faint">{t.desc}</span>
                </span>
                {/* 模板配色预览：让用户选之前就知道这套长什么样 */}
                <span className="flex shrink-0 items-center gap-0.5">
                  {t.tiers.map((tier) => (
                    <span
                      key={tier.name}
                      className="h-3 w-3 rounded-sm border border-black/10"
                      style={{ background: tier.color }}
                      title={`${tier.name}：${tier.color}`}
                    />
                  ))}
                </span>
              </button>
            ))}

            <button
              type="button"
              onClick={() => setChoice('custom')}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                choice === 'custom' ? 'border-accent bg-accent-soft' : 'border-border bg-elev1 hover:border-accent/50'
              }`}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  choice === 'custom' ? 'border-accent bg-accent text-white' : 'border-border'
                }`}
              >
                {choice === 'custom' ? <Check size={11} /> : null}
              </span>
              <span className="text-xs font-semibold">自定义</span>
            </button>

            {choice === 'custom' ? (
              <Textarea
                value={custom}
                rows={4}
                placeholder={`一行一个，或用空格 / 顿号分隔（最多 ${MAX_TIERS} 个）：\n神作\n佳作\n还行\n不太行`}
                onChange={(e) => setCustom(e.target.value)}
              />
            ) : null}

            {overflow > 0 ? (
              <div className="flex items-center gap-1.5 rounded-lg bg-warn/12 px-2.5 py-1.5 text-[11px] text-warn">
                <Info size={12} /> 最多 {MAX_TIERS} 档，已忽略多出来的 {overflow} 个标签
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-elev1 p-3">
          <div className="mb-1.5 text-[11px] text-faint">
            预览（{picked.length} 档，从上到下 = 从高到低；颜色可以在排表界面上点标签旁的小色板改）
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {picked.length === 0 ? (
              <span className="text-[11px] text-faint">至少要有 {MIN_TIERS} 个等级标签</span>
            ) : (
              picked.map((tier, i) => (
                <span
                  key={`${tier.name}-${i}`}
                  className="rounded-md border border-black/10 px-2 py-1 text-xs font-semibold"
                  style={{ background: tier.color, color: readableTextOn(tier.color) }}
                >
                  {tier.name}
                </span>
              ))
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-faint">
            {tiersOk
              ? `等级标签之后也能改（改短时落在被删档里的作品会回到作品池）· 最多 ${MAX_TIERS} 档`
              : `需要 ${MIN_TIERS}–${MAX_TIERS} 个等级`}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              disabled={!nameOk || !tiersOk}
              onClick={() => {
                onSubmit(name.trim(), picked)
                onClose()
              }}
            >
              {mode === 'create' ? '创建并开始排表' : '保存'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

import { Check, ImageDown } from 'lucide-react'
import type { StatEntry, StatExportField, StatExportOptions } from '@shared/types'
import { Button, Modal } from '@/components/ui'

/**
 * 导出图片：先勾选要导出哪些详情字段。
 *
 * 设计取舍（用户要求「内容过多时就算是加宽条目也要显示详情内容」）：
 * - 勾选项按「条目上的位置」分组（基本信息 / 时间与标签 / 评分 / 评价与备注 / 图片），
 *   勾了才有，没勾的连标签都不出现；
 * - 画布宽度由一个可预期的公式决定（`预估宽度 = 860 + 长文本 420 + 评分满档 120 + 剧照 4×26`，
 *   再乘用户拖动条给的倍数），不靠"内容自动撑开"这种不可控行为 ——
 *   所以这里实时把预估宽度显示出来，用户点导出前就知道图片有多宽；
 * - 剧照缩放单独一档，默认 1.25（比旧版的 92×56 明显大一圈）。
 */

/** 可勾选字段的顺序 = 弹窗里的展示顺序 */
const FIELD_GROUPS: { title: string; fields: { key: StatExportField; label: string }[] }[] = [
  {
    title: '基本信息',
    fields: [
      { key: 'seq', label: '序号' },
      { key: 'cover', label: '封面' },
      { key: 'name', label: '番剧名' }
    ]
  },
  {
    title: '时间与标签',
    fields: [
      { key: 'airDate', label: '放送时间' },
      { key: 'watchedAt', label: '看完时间' },
      { key: 'genres', label: '类型' },
      { key: 'historyTier', label: '历史级' },
      { key: 'progress', label: '观看进度' }
    ]
  },
  {
    title: '评分',
    fields: [
      { key: 'initialRating', label: '初始评分' },
      { key: 'midRating', label: '中期评分' },
      { key: 'endRating', label: '结束评分' },
      { key: 'personalRating', label: '个人评分' },
      { key: 'bgmRating', label: 'bangumi 评分' },
      { key: 'deviation', label: '差值' }
    ]
  },
  {
    title: '评价与备注',
    fields: [
      { key: 'initialReview', label: '初期评价' },
      { key: 'midReview', label: '中期评价' },
      { key: 'endReview', label: '结束评价' },
      { key: 'overallReview', label: '总体评价' },
      { key: 'remark', label: '备注' }
    ]
  },
  {
    title: '图片',
    fields: [
      { key: 'photos', label: '剧照（最多 5 张）' }
    ]
  }
]

/** 默认勾选：条目上显示的字段 + 总体评价 + 剧照（用户最常导的形态） */
export const DEFAULT_EXPORT_FIELDS: StatExportField[] = [
  'seq',
  'cover',
  'name',
  'airDate',
  'watchedAt',
  'personalRating',
  'bgmRating',
  'deviation',
  'overallReview',
  'photos'
]

const ALL_FIELDS: StatExportField[] = FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.key))

/** 与主进程 computeExportWidth 保持一致的预估公式（改这里必须同步改 statExport.ts） */
export function estimateWidth(fields: StatExportField[], opts: StatExportOptions): number {
  const has = (f: StatExportField): boolean => fields.includes(f)
  let w = 860
  const texts = (
    ['initialReview', 'midReview', 'endReview', 'overallReview', 'remark'] as StatExportField[]
  ).filter(has).length
  if (texts > 0) w += 420
  const rates = (
    ['initialRating', 'midRating', 'endRating', 'personalRating', 'bgmRating', 'deviation'] as StatExportField[]
  ).filter(has).length
  if (rates >= 4) w += 120
  if (has('photos')) w += 4 * 26
  return Math.round(w * (opts.widthScale ?? 1))
}

export function ExportDialog({
  open,
  entryCount,
  fields,
  onFieldsChange,
  widthScale,
  onWidthScaleChange,
  photoScale,
  onPhotoScaleChange,
  exporting,
  onExport,
  onClose,
  sample
}: {
  open: boolean
  entryCount: number
  fields: StatExportField[]
  onFieldsChange: (f: StatExportField[]) => void
  widthScale: number
  onWidthScaleChange: (v: number) => void
  photoScale: number
  onPhotoScaleChange: (v: number) => void
  exporting: boolean
  onExport: () => void
  onClose: () => void
  sample?: StatEntry | null
}) {
  const opts: StatExportOptions = { fields, widthScale, photoScale }
  const width = estimateWidth(fields, opts)

  function toggle(f: StatExportField): void {
    onFieldsChange(fields.includes(f) ? fields.filter((x) => x !== f) : [...ALL_FIELDS.filter((x) => fields.includes(x) || x === f)])
  }

  return (
    <Modal open={open} onClose={onClose} title="导出列表为图片" width={640}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-faint">
        <span>共 {entryCount} 个条目 · 勾选要出现在图片上的内容</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => onFieldsChange(ALL_FIELDS)}
          className="rounded-md bg-elev2 px-2 py-1 text-dim transition-colors hover:text-text"
        >
          全选
        </button>
        <button
          type="button"
          onClick={() => onFieldsChange(DEFAULT_EXPORT_FIELDS)}
          className="rounded-md bg-elev2 px-2 py-1 text-dim transition-colors hover:text-text"
        >
          默认
        </button>
        <button
          type="button"
          onClick={() => onFieldsChange([])}
          className="rounded-md bg-elev2 px-2 py-1 text-dim transition-colors hover:text-text"
        >
          全不选
        </button>
      </div>

      <div className="max-h-[42vh] space-y-3 overflow-y-auto pr-1">
        {FIELD_GROUPS.map((g) => (
          <div key={g.title} className="rounded-xl border border-border bg-elev1/60 p-2.5">
            <div className="mb-1.5 text-[11px] font-semibold text-faint">{g.title}</div>
            <div className="flex flex-wrap gap-1.5">
              {g.fields.map((f) => {
                const on = fields.includes(f.key)
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => toggle(f.key)}
                    className={`flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs transition-colors ${
                      on ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
                    }`}
                  >
                    {on ? <Check size={12} /> : null}
                    {f.label}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 space-y-2 rounded-xl border border-border bg-elev1/60 p-3">
        <label className="flex items-center gap-3 text-xs text-dim">
          <span className="w-24 shrink-0">条目宽度</span>
          <input
            type="range"
            min={0.8}
            max={1.6}
            step={0.05}
            value={widthScale}
            onChange={(e) => onWidthScaleChange(Number(e.target.value))}
            className="flex-1 accent-accent"
          />
          <span className="w-24 shrink-0 text-right tabular-nums text-faint">
            {widthScale.toFixed(2)}× · 约 {width}px
          </span>
        </label>
        <label className="flex items-center gap-3 text-xs text-dim">
          <span className="w-24 shrink-0">剧照大小</span>
          <input
            type="range"
            min={0.8}
            max={2}
            step={0.05}
            value={photoScale}
            onChange={(e) => onPhotoScaleChange(Number(e.target.value))}
            className="flex-1 accent-accent"
          />
          <span className="w-24 shrink-0 text-right tabular-nums text-faint">{photoScale.toFixed(2)}×</span>
        </label>
        <div className="text-[10px] leading-relaxed text-faint">
          勾了「评价 / 备注」时画布会自动加宽 420px，评分勾满再加 120px —— 内容多时是**图片更宽**，
          不会把条目压窄或截断。剧照默认 1.25×（约 115×70）。
          {sample && sample.photos.length === 0 && fields.includes('photos')
            ? ' 注意：当前列表里的条目还没有剧照，图片上不会出现剧照区。'
            : ''}
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button icon={ImageDown} loading={exporting} disabled={fields.length === 0} onClick={onExport}>
          导出为图片
        </Button>
      </div>
    </Modal>
  )
}

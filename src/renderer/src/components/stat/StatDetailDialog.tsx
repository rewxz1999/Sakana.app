import { useEffect, useState } from 'react'
import { CalendarClock, FolderOpen, ImageUp, Star } from 'lucide-react'
import type { StatEntry, StatWatchProgress } from '@shared/types'
import { STAT_MAX_PHOTOS } from '@shared/types'
import { api } from '@/lib/api'
import { useStatTool } from '@/stores/statTool'
import { toast } from '@/stores/app'
import { Badge, Button, Modal, Textarea } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import { DateTimeField, entryDeviation } from './DateTimeField'
import { InfoRow, LocalImageHint, PhotoStrip, ScoreBadge, ShotPicker } from './ShotPicker'

/**
 * 条目详情窗口（用户要求：点右键菜单「详情」弹出）。
 *
 * 字段 ↔ 数据来源对照（详见本次报告，也是本文件的组织顺序）：
 * | 字段 | 来源 | 可改 |
 * | 序号 seq | store（统计条目） | ✗ |
 * | 封面 cover / 番剧名 / 放送时间 airDate / 类型 genres | store（添加时从收藏或番剧表带出） | ✗ |
 * | bangumi 评分 bgmRating | store（添加时来自 bangumi，可在后台校正） | ✗ |
 * | 个人评分与 bangumi 评分差值 | 计算：personalRating - bgmRating | ✗ |
 * | 观看进度 | 主进程聚合 watchProgress + watchHistory + 收藏手动标记 | ✗ |
 * | 看完时间 | store | ✓（datetime-local 选择器） |
 * | 初始/中期/结束/个人评分 | store | ✓ |
 * | 初期/中期/结束/总体评价、历史级、备注 | store | ✓ |
 * | 剧照（≤5） | store（存**绝对路径**，不复制文件） | ✓ |
 *
 * 保存方式：所有编辑都是「改完即存」——数字/日期改动立刻提交，
 * 文本域在**失焦**时提交（并顺手 flush 一次，避免打字中途切走丢字），
 * 每次提交都是 `updateEntry` → 主进程读-改-写 → 广播，多窗口一致。
 */
export function StatDetailDialog({
  entryId,
  onClose
}: {
  entryId: string | null
  onClose: () => void
}) {
  // 取 store 里的**最新**条目（详情窗口开着时后台广播也可能改数据）
  const entry = useStatTool((s) => s.data.entries.find((e) => e.id === entryId) ?? null)
  return entry ? <DetailBody entry={entry} onClose={onClose} /> : null
}

/**
 * 详情主体。
 *
 * 为什么拆成两层：字段编辑都是「改完即存」，而交到回调里的 `entry` 必须是
 * 非空类型（TS 对闭包内的 null 收窄会失效）。外层用 `entry ? … : null` 保证非空，
 * 内层每个回调都能安全直接用 `entry`，比到处写 `entry!` 可靠。
 */
function DetailBody({ entry, onClose }: { entry: StatEntry; onClose: () => void }) {
  const updateEntry = useStatTool((s) => s.updateEntry)

  const [progress, setProgress] = useState<StatWatchProgress | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // 观看进度由主进程算（watchProgress / watchHistory / 收藏标记都在主进程侧读）
  useEffect(() => {
    let alive = true
    void api.stat.watchProgress(entry).then((r) => {
      if (alive && r.ok) setProgress(r.data)
    })
    return () => {
      alive = false
    }
  }, [entry.id, entry.watchedAt, entry.subjectId])

  const dev = entryDeviation(entry)
  const patch = (p: Parameters<typeof updateEntry>[1]): void => updateEntry(entry.id, p)

  /** 追加剧照：去重 + 截断到 5 张，超出的部分明确提示而不是静默丢弃 */
  function addPhotos(paths: string[]): void {
    const room = STAT_MAX_PHOTOS - entry.photos.length
    if (room <= 0) {
      toast.warn(`剧照最多 ${STAT_MAX_PHOTOS} 张，先移除一张再加`)
      return
    }
    const merged = [...entry.photos]
    let skipped = 0
    for (const p of paths) {
      if (merged.includes(p)) {
        skipped += 1
        continue
      }
      if (merged.length >= STAT_MAX_PHOTOS) {
        skipped += 1
        continue
      }
      merged.push(p)
    }
    if (merged.length !== entry.photos.length) patch({ photos: merged })
    if (skipped > 0) toast.warn(`已忽略 ${skipped} 张（重复或超出 ${STAT_MAX_PHOTOS} 张上限）`)
  }

  async function openShotDir(): Promise<void> {
    const r = await api.stat.shotsOpenDir(entry)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (r.data.error) toast.error(r.data.error)
    else toast.success(`已打开截图目录：${r.data.dir}`)
  }

  return (
    <Modal open onClose={onClose} title={`详情 · ${entry.nameCn || entry.name}`} width={920}>
      <div className="space-y-5">
        {/* ---------- 基本信息（只读，添加时自动带出） ---------- */}
        <div className="flex gap-4">
          <CoverImage src={entry.cover} className="h-32 w-[92px] shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-accent-soft px-2 py-0.5 font-mono text-sm font-bold tabular-nums text-accent">
                {entry.seq || '—'}
              </span>
              <span className="text-sm font-semibold">{entry.nameCn || entry.name}</span>
            </div>
            {entry.name && entry.name !== entry.nameCn ? (
              <div className="break-words text-[11px] text-dim">{entry.name}</div>
            ) : null}
            <InfoRow label="放送时间">{entry.airDate ?? '未知'}</InfoRow>
            <InfoRow label="类型">
              {entry.genres.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {entry.genres.map((g) => (
                    <Badge key={g} tone="neutral">
                      {g}
                    </Badge>
                  ))}
                </span>
              ) : (
                '未记录'
              )}
            </InfoRow>
            <InfoRow label="观看进度">
              {progress ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span>{progress.text}</span>
                  {progress.completed ? <Badge tone="ok">已看完</Badge> : null}
                  {progress.lastWatchedAt ? (
                    <span className="text-faint">
                      最后观看 {new Date(progress.lastWatchedAt).toLocaleDateString('zh-CN')}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="text-faint">读取中…</span>
              )}
            </InfoRow>
            <InfoRow label="bgm 评分">
              <span className="flex flex-wrap items-center gap-2">
                <ScoreBadge label="bangumi" value={entry.bgmRating != null ? entry.bgmRating.toFixed(1) : '暂无'} />
                <ScoreBadge
                  label="差值"
                  value={dev == null ? '—' : `${dev >= 0 ? '+' : '-'}${Math.abs(dev).toFixed(1)}`}
                  tone={dev == null ? 'neutral' : dev >= 0 ? 'ok' : 'danger'}
                />
                <span className="text-[10px] text-faint">（添加时自动带出，不可修改）</span>
              </span>
            </InfoRow>
          </div>
        </div>

        {/* ---------- 可修改：看完时间 ---------- */}
        <div className="rounded-xl border border-border bg-elev1/60 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-dim">
            <CalendarClock size={13} className="text-accent" /> 看完时间
            <span className="text-[10px] font-normal text-faint">时间选择器，选完立即保存；点 × 清空</span>
          </div>
          <DateTimeField value={entry.watchedAt} onChange={(v) => patch({ watchedAt: v })} />
        </div>

        {/* ---------- 可修改：四档评分 ---------- */}
        <div className="rounded-xl border border-border bg-elev1/60 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-dim">
            <Star size={13} className="text-warn" /> 评分
            <span className="text-[10px] font-normal text-faint">0–10，保留一位小数；留空表示未评分</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <RatingField label="初始评分" value={entry.initialRating} onSave={(v) => patch({ initialRating: v })} />
            <RatingField label="中期评分" value={entry.midRating} onSave={(v) => patch({ midRating: v })} />
            <RatingField label="结束评分" value={entry.endRating} onSave={(v) => patch({ endRating: v })} />
            <RatingField
              label="个人评分"
              value={entry.personalRating}
              onSave={(v) => patch({ personalRating: v })}
              highlight
            />
          </div>
        </div>

        {/* ---------- 可修改：四段评价 + 历史级 + 备注 ---------- */}
        <div className="space-y-3">
          <AutoTextarea
            label="初期评价"
            value={entry.initialReview}
            placeholder="刚开播时/看前几集时的第一印象…"
            onSave={(v) => patch({ initialReview: v })}
          />
          <AutoTextarea
            label="中期评价"
            value={entry.midReview}
            placeholder="看到中段时的感受…"
            onSave={(v) => patch({ midReview: v })}
          />
          <AutoTextarea
            label="结束评价"
            value={entry.endReview}
            placeholder="看完那一刻的评价…"
            onSave={(v) => patch({ endReview: v })}
          />
          <AutoTextarea
            label="总体评价"
            value={entry.overallReview}
            placeholder="沉淀之后的整体评价（列表条目上会显示这一段）…"
            onSave={(v) => patch({ overallReview: v })}
          />
          <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
            <div>
              <div className="mb-1.5 text-xs font-semibold text-dim">历史级</div>
              <input
                defaultValue={entry.historyTier}
                placeholder="如 历史级 8 / S 级"
                onBlur={(e) => {
                  if (e.target.value !== entry.historyTier) patch({ historyTier: e.target.value })
                }}
                className="h-9 w-full rounded-lg border border-border bg-elev1 px-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-accent"
              />
            </div>
            <AutoTextarea
              label="备注"
              value={entry.remark}
              placeholder="BD 收藏情况、推荐给谁、其它碎碎念…"
              rows={3}
              onSave={(v) => patch({ remark: v })}
            />
          </div>
        </div>

        {/* ---------- 可修改：剧照（≤5，存路径不复制文件） ---------- */}
        <div className="rounded-xl border border-border bg-elev1/60 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-dim">
              <ImageUp size={13} className="text-accent" /> 剧照
            </span>
            <span className="text-[10px] text-faint">
              {entry.photos.length}/{STAT_MAX_PHOTOS} 张 · 只记录文件路径，不复制图片
            </span>
            <span className="flex-1" />
            <Button size="sm" variant="outline" icon={FolderOpen} onClick={() => void openShotDir()}>
              打开截图目录
            </Button>
            <Button size="sm" variant="soft" icon={ImageUp} onClick={() => setPickerOpen(true)}>
              从截图目录添加
            </Button>
          </div>
          <PhotoStrip
            photos={entry.photos}
            onRemove={(i) => patch({ photos: entry.photos.filter((_, idx) => idx !== i) })}
          />
          {entry.photos.length < STAT_MAX_PHOTOS ? (
            <div className="mt-2">
              <LocalImageHint onPick={addPhotos} />
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between border-t border-border pt-3 text-[10px] text-faint">
          <span>改动即时保存{entry.updatedAt ? ` · 最近修改 ${new Date(entry.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</span>
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>

      <ShotPicker open={pickerOpen} entry={entry} onClose={() => setPickerOpen(false)} onPick={addPhotos} />
    </Modal>
  )
}

/** 单个评分输入：失焦/回车提交，非法输入回滚显示 */
function RatingField({
  label,
  value,
  onSave,
  highlight
}: {
  label: string
  value: number | null
  onSave: (v: number | null) => void
  highlight?: boolean
}) {
  const [text, setText] = useState(value == null ? '' : value.toFixed(1))
  useEffect(() => setText(value == null ? '' : value.toFixed(1)), [value])

  function commit(): void {
    const t = text.trim()
    if (!t) {
      if (value != null) onSave(null)
      return
    }
    const n = Number(t)
    if (Number.isNaN(n)) {
      setText(value == null ? '' : value.toFixed(1))
      return
    }
    const rounded = Math.round(Math.min(10, Math.max(0, n)) * 10) / 10
    setText(rounded.toFixed(1))
    if (rounded !== value) onSave(rounded)
  }

  return (
    <div>
      <div className={`mb-1.5 text-xs font-semibold ${highlight ? 'text-accent' : 'text-dim'}`}>{label}</div>
      <input
        type="number"
        min={0}
        max={10}
        step={0.1}
        value={text}
        placeholder="—"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        }}
        className="h-9 w-full rounded-lg border border-border bg-elev1 px-3 text-sm tabular-nums outline-none transition-colors placeholder:text-faint focus:border-accent"
      />
    </div>
  )
}

/** 评价文本域：失焦保存（并做一次显式提交，保证切走不丢） */
function AutoTextarea({
  label,
  value,
  placeholder,
  rows = 3,
  onSave
}: {
  label: string
  value: string
  placeholder: string
  rows?: number
  onSave: (v: string) => void
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])

  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-dim">
        {label}
        <span className="ml-2 text-[10px] font-normal text-faint">失焦自动保存</span>
      </div>
      <Textarea
        rows={rows}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== value) onSave(text)
        }}
      />
    </div>
  )
}

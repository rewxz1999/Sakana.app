import { useEffect, useState } from 'react'
import { FolderOpen, Plus, RefreshCw, Star, X } from 'lucide-react'
import type { StatEntry, StatShotDirInfo } from '@shared/types'
import { STAT_MAX_PHOTOS } from '@shared/types'
import { api } from '@/lib/api'
import { localImgUrl } from '@/lib/format'
import { toast } from '@/stores/app'
import { Badge, Button, Modal, Spinner } from '@/components/ui'

/**
 * 剧照选择器：在应用内浏览「番剧截图保存目录」里的截图，点一下就加为剧照。
 *
 * 图片怎么显示：直接走 `sakana-img://local/<base64 路径>`（localImgUrl）。
 * 该协议只读白名单目录（截图目录在 media.ts 里已注册），显示不需要复制文件。
 * 剧照记录的是**绝对路径**，不复制文件 —— 用户在截图目录里删了图，
 * 剧照就变成空位（详情窗口会显示占位图），这是刻意的：避免应用数据目录里
 * 堆一份几百 MB 的重复图片。
 */
export function ShotPicker({
  open,
  entry,
  onClose,
  onPick
}: {
  open: boolean
  entry: StatEntry
  onClose: () => void
  onPick: (paths: string[]) => void
}) {
  const [info, setInfo] = useState<StatShotDirInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  async function refresh(): Promise<void> {
    setLoading(true)
    const r = await api.stat.shots(entry)
    setLoading(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    setInfo(r.data)
  }

  useEffect(() => {
    if (open) {
      setSelected([])
      void refresh()
    }
    // entry 变化（切换条目）时也要重取
  }, [open, entry.id])

  async function openDir(): Promise<void> {
    const r = await api.stat.shotsOpenDir(entry)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (r.data.error) toast.error(r.data.error)
    else toast.success(`已打开截图目录：${r.data.dir}`)
  }

  const files = info?.files ?? []

  function toggle(path: string): void {
    setSelected((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]))
  }

  return (
    <Modal open={open} onClose={onClose} title={`从截图目录挑图 · ${entry.nameCn || entry.name}`} width={860}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-faint">
        <span className="min-w-0 flex-1 break-all">
          目录：{info?.dir ?? '读取中…'}
          {info && !info.dirExists ? '（该番剧还没有专属截图目录，下面是截图根目录里的图片）' : ''}
        </span>
        <Button size="sm" variant="outline" icon={FolderOpen} onClick={() => void openDir()}>
          打开截图目录
        </Button>
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void refresh()}>
          刷新
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner size={20} />
        </div>
      ) : files.length === 0 ? (
        <div className="py-12 text-center text-xs leading-relaxed text-faint">
          这个目录里还没有图片。
          <br />
          播放番剧时按截图快捷键就能生成 `<span className="text-dim">番剧名_集数_分.秒.png</span>`，
          或点上面的「打开截图目录」自己放图进去，再回来刷新。
        </div>
      ) : (
        <div className="grid max-h-[52vh] grid-cols-4 gap-2 overflow-y-auto pr-1">
          {files.map((f) => {
            const on = selected.includes(f.path)
            return (
              <button
                key={f.path}
                type="button"
                title={f.name}
                onClick={() => toggle(f.path)}
                className={`group relative overflow-hidden rounded-lg border-2 transition-colors ${
                  on ? 'border-accent' : 'border-transparent hover:border-accent/50'
                }`}
              >
                <img src={localImgUrl(f.path)} alt={f.name} className="h-24 w-full object-cover" />
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-left text-[10px] text-white/90">
                  {f.name}
                </span>
                {on ? (
                  <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-white">
                    ✓
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[11px] text-faint">
          已选 {selected.length} 张 · 剧照上限 {STAT_MAX_PHOTOS} 张
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={() => {
              onPick(selected)
              onClose()
            }}
          >
            添加为剧照
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** 点击条目的「选择本地图片」时用系统文件对话框（与剧照目录挑图并列的第二条路径） */
export function LocalImageHint({ onPick }: { onPick: (paths: string[]) => void }) {
  return (
    <button
      type="button"
      title="从系统文件对话框选图"
      onClick={async () => {
        const r = await api.dialog.pickImages()
        if (!r.ok) {
          toast.error(r.error)
          return
        }
        onPick(r.data)
      }}
      className="flex h-16 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-faint transition-colors hover:border-accent hover:text-accent"
    >
      <Plus size={14} />
      <span className="text-[10px]">本地图片</span>
    </button>
  )
}

/** 详情窗口里的一行只读信息 */
export function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="w-[70px] shrink-0 pt-0.5 text-faint">{label}</span>
      <span className="min-w-0 flex-1 break-words text-text">{children}</span>
    </div>
  )
}

/** 评分徽章（只读展示用：bgm 评分、差值） */
export function ScoreBadge({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'ok' | 'danger' }) {
  const cls = tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-text'
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-elev2 px-2 py-0.5 text-[11px]">
      <span className="text-faint">{label}</span>
      <span className={`font-semibold tabular-nums ${cls}`}>{value}</span>
    </span>
  )
}

/** 剧照缩略图行（详情窗口用）：点击移除 */
export function PhotoStrip({
  photos,
  onRemove
}: {
  photos: string[]
  onRemove: (i: number) => void
}) {
  const slots = Array.from({ length: STAT_MAX_PHOTOS }, (_, i) => photos[i] ?? null)
  return (
    <div className="flex flex-wrap gap-2">
      {slots.map((p, i) =>
        p ? (
          <button
            key={p}
            type="button"
            title="点击移除这张剧照"
            onClick={() => onRemove(i)}
            className="group relative h-16 w-24 shrink-0 overflow-hidden rounded-lg border border-border"
          >
            <img src={localImgUrl(p)} alt="剧照" className="h-full w-full object-cover" />
            <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
              <X size={14} className="text-white" />
            </span>
          </button>
        ) : (
          <div
            key={`empty-${i}`}
            className="flex h-16 w-24 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-faint"
          >
            <Star size={12} className="opacity-40" />
          </div>
        )
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Star, X } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import {
  MAX_PHOTOS,
  REASON_MAX,
  type RecommendPage,
  type RecommendPagePatch
} from '@/stores/recommendTable'
import { Button, Input, Modal, Textarea } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import { displayName } from './styles'

/**
 * 「编辑当前页」面板（用户需求 6：右键当前页可改推荐人评分 / 推荐指数 / 推荐理由 / 剧照）。
 *
 * ## 为什么是「本地草稿 + 保存才写库」
 *
 * 面板上的四个字段是**一组**要一起提交的编辑（用户填完评分和理由才点保存），
 * 每敲一个字就写盘会让「取消」变得没有意义（还得再改回去），也会让 store 的整份写盘
 * 变成打字机。所以这里全部改在本地 draft 上，点「保存」才回写一次。
 *
 * ## 为什么草稿只在「打开 / 换页」时重置
 *
 * 依赖数组里只放 `open` 和 `page.id`，**不放 page 对象本身**：
 * store 每次写入都会重建 page 对象（不可变更新），如果把 page 放进依赖，
 * 后台的「补齐标签」一回来就会把用户正在输入的理由冲掉 —— 这种 bug 很难复现。
 * 换页（id 变了）时重置是必须的，否则会把上一页的内容带到下一页。
 */
export function PageEditDialog({
  open,
  page,
  onClose,
  onSave
}: {
  open: boolean
  page: RecommendPage | null
  onClose: () => void
  onSave: (patch: RecommendPagePatch) => void
}) {
  /** 评分输入框的文本（不直接存数字：用户输入 '9.' 这种中间态要能留在框里） */
  const [ratingText, setRatingText] = useState('')
  const [level, setLevel] = useState(3)
  const [reason, setReason] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (!open || !page) return
    setRatingText(page.myRating === null ? '' : String(page.myRating))
    setLevel(page.recommendLevel)
    setReason(page.reason)
    setPhotos(page.photos)
    // 依赖里刻意只写 [open, page?.id]（不放 page 本身），原因见文件头「为什么草稿只在打开/换页时重置」
  }, [open, page?.id])

  /**
   * 解析评分输入。
   *
   * 允许多种「还没输完」的中间态（空串 / `9` / `9.` / `9.5`）：
   * 边打字边报错是最烦人的，所以只有超出 0–10 或超过一位小数时才提示。
   * 输入 `9.55` 会被截成 `9.5`（自动取一位小数），不打断输入。
   */
  function parseRating(text: string): { value: number | null; error: string } {
    const t = text.trim()
    if (!t) return { value: null, error: '' }
    if (!/^\d{0,2}(\.\d*)?$/.test(t)) return { value: null, error: '只能填 0–10 的数字，可带一位小数' }
    const n = Number(t)
    if (!Number.isFinite(n)) return { value: null, error: '不是合法数字' }
    if (n < 0 || n > 10) return { value: null, error: '评分范围是 0–10' }
    return { value: Math.round(n * 10) / 10, error: '' }
  }

  const parsed = parseRating(ratingText)
  const reasonLeft = REASON_MAX - reason.length
  /** 超长提示只弹一次（用 ref 记住这次输入里已经提醒过），否则粘贴长文会刷屏 */
  const warnedRef = useRef(false)

  /** 选图：pickImage 拿原路径 → importImages 复制进应用数据目录（否则图片协议 403，见 media.ts 白名单） */
  async function addPhoto(): Promise<void> {
    if (importing) return
    if (photos.length >= MAX_PHOTOS) {
      toast.warn(`剧照最多 ${MAX_PHOTOS} 张，先删掉一张再加`)
      return
    }
    setImporting(true)
    try {
      const picked = await api.dialog.pickImage()
      if (!picked.ok) {
        toast.error(picked.error)
        return
      }
      // 用户取消：data 为 null，什么都不做（不是错误）
      if (!picked.data) return
      const imp = await api.showcase.importImages([picked.data])
      if (!imp.ok || imp.data.length === 0) {
        toast.error('导入本地图片失败（文件可能过大或不可读）')
        return
      }
      const next = imp.data[0]
      /*
       * 主进程对「复制失败」的处理是**原样返回原路径**（见 settingsExt.importShowcaseImages 的注释），
       * 那种路径不在图片协议白名单里，界面上会是一块空白。这里如实提醒，
       * 而不是让用户对着一张空图猜原因。
       */
      if (next === picked.data) {
        toast.warn('这张图没能复制进应用数据目录（格式可能不支持），预览和导出可能显示不出来')
      }
      setPhotos((prev) => (prev.includes(next) || prev.length >= MAX_PHOTOS ? prev : [...prev, next]))
    } catch (err) {
      toast.error(`导入剧照失败：${String((err as Error)?.message ?? err)}`)
    } finally {
      setImporting(false)
    }
  }

  function save(): void {
    if (!page) return
    if (parsed.error) {
      toast.warn(parsed.error)
      return
    }
    onSave({
      myRating: parsed.value,
      recommendLevel: level,
      reason,
      photos
    })
  }

  return (
    <Modal open={open} onClose={onClose} title={`编辑这一页 · ${page ? displayName(page) : ''}`} width={560}>
      <div className="space-y-4">
        {/* ---- 推荐人评分 ---- */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium text-dim">推荐人评分</span>
            <span className="text-[10px] text-faint">0–10，允许一位小数；留空 = 未评分</span>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={ratingText}
              inputMode="decimal"
              placeholder="例如 9.5"
              className="w-28"
              onChange={(e) => setRatingText(e.target.value)}
            />
            <span className="text-sm text-faint">/ 10</span>
            {page && page.bgmRating !== null ? (
              <span className="text-[10px] text-faint">（bangumi 评分 {page.bgmRating.toFixed(1)}）</span>
            ) : null}
          </div>
          {parsed.error ? <div className="mt-1 text-[10px] text-danger">{parsed.error}</div> : null}
        </div>

        {/* ---- 推荐指数 ---- */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium text-dim">推荐指数</span>
            <span className="text-[10px] text-faint">1–5 星，点星星选择</span>
          </div>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                title={`${n} 星`}
                onClick={() => setLevel(n)}
                className="p-0.5 transition-transform hover:scale-110"
              >
                <Star
                  size={24}
                  className={n <= level ? 'text-warn' : 'text-faint'}
                  fill={n <= level ? 'currentColor' : 'none'}
                />
              </button>
            ))}
            <span className="ml-2 text-xs text-dim">{level} / 5</span>
          </div>
        </div>

        {/* ---- 推荐理由 ---- */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium text-dim">推荐理由</span>
            <span className={reasonLeft <= 0 ? 'text-[10px] text-warn' : 'text-[10px] text-faint'}>
              {reason.length} / {REASON_MAX} 字
            </span>
          </div>
          <Textarea
            rows={6}
            value={reason}
            maxLength={REASON_MAX}
            placeholder="写几句推荐理由（最多 300 字，导出图里会完整显示）"
            onChange={(e) => {
              const v = e.target.value
              /*
               * maxLength 已经挡住了超额输入，这里再兜一次是为了「粘贴」：
               * 个别输入法/拖拽路径能绕过 maxLength，而超长理由会把导出图的卡片撑变形。
               */
              if (v.length > REASON_MAX) {
                setReason(v.slice(0, REASON_MAX))
                if (!warnedRef.current) {
                  warnedRef.current = true
                  toast.warn(`推荐理由最多 ${REASON_MAX} 字，多出来的部分没有收进去`)
                }
                return
              }
              setReason(v)
            }}
          />
          <div className="mt-1 text-[10px] leading-relaxed text-faint">
            换行会保留（导出图与界面一致）。写满 {REASON_MAX} 字时版式正好放得下，不用自己数行数。
          </div>
        </div>

        {/* ---- 剧照 ---- */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium text-dim">剧照</span>
            <span className="text-[10px] text-faint">
              {photos.length} / {MAX_PHOTOS} 张（第 {MAX_PHOTOS + 1} 张起放不下，所以卡在这个数）
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {photos.map((p) => (
              <div key={p} className="group relative h-[92px] w-[148px] overflow-hidden rounded-lg border border-border">
                <CoverImage src={p} alt="剧照" className="h-full w-full" rounded="" />
                <button
                  type="button"
                  title="移除这张剧照"
                  onClick={() => setPhotos((prev) => prev.filter((x) => x !== p))}
                  className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            {photos.length < MAX_PHOTOS ? (
              <button
                type="button"
                disabled={importing}
                onClick={() => void addPhoto()}
                className="flex h-[92px] w-[148px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-faint transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                <ImagePlus size={16} />
                <span className="text-[10px]">{importing ? '导入中…' : '添加剧照'}</span>
              </button>
            ) : null}
          </div>
          <div className="mt-1 text-[10px] leading-relaxed text-faint">
            选中的图片会被复制进应用数据目录：之后你把它从「图片」文件夹里删掉，推荐表里的剧照也不会丢。
          </div>
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button onClick={save} disabled={parsed.error !== ''}>
          保存
        </Button>
      </div>
    </Modal>
  )
}

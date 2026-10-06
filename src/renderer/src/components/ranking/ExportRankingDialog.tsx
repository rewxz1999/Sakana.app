import { useState } from 'react'
import { CircleAlert, FolderOpen, ImageDown } from 'lucide-react'
import { Button, Input, Modal, Select } from '@/components/ui'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import {
  DEFAULT_EXPORT_SCALE,
  EXPORT_SCALES,
  buildRankingExportHtml,
  exportLayout,
  type RankingTable
} from '@/stores/rankingTable'

/**
 * 导出排名表为图片。
 *
 * 三条用户要求的落地方式：
 *   · **清晰度**：主进程按「版式宽度 × 倍率」放大渲染（矢量重绘，不是拉伸位图），默认 2 倍、最高 3 倍；
 *   · **排名人署名**：填了才出现在信息区（空名字不会留一行空白）；
 *   · **自选文件夹**：交给主进程的系统保存对话框，用户自己选目录与文件名，我们不预设路径。
 *
 * 版式宽度**不再是固定值**：用户反馈"长图右侧留大片空白"，所以宽度按内容算
 * （见 stores/rankingTable.ts 的 exportLayout：够用就窄，最多 1600）。这里把这个值显示出来，
 * 用户点导出前就知道图有多宽。
 *
 * 导出完成后**不立刻关闭弹窗**：缺图和尺寸这两个信息必须让用户看见（用户强调过「注意清晰度」，
 * 一张 1400×900 的图和 2800×1800 的图差别很大），关掉弹窗再提示等于把信息丢了。
 */
export function ExportRankingDialog({
  open,
  table,
  onClose
}: {
  open: boolean
  table: RankingTable
  onClose: () => void
}) {
  const [author, setAuthor] = useState('')
  const [scale, setScale] = useState<number>(DEFAULT_EXPORT_SCALE)
  const [exporting, setExporting] = useState(false)
  const layout = exportLayout(table)
  const [result, setResult] = useState<{
    path: string
    width: number
    height: number
    missing: { label: string; reason: string }[]
  } | null>(null)

  async function doExport(): Promise<void> {
    setExporting(true)
    setResult(null)
    const { html, images } = buildRankingExportHtml(table, author)
    const r = await api.tools.exportCardImage({
      title: '导出排名表为图片',
      // 宽度按内容算（用户要求"右侧不要留大片空白"）：与 HTML 内部用的是同一个函数，两处不会漂移
      width: exportLayout(table).width,
      html,
      images,
      defaultName: `${table.name}-排名表`,
      scale
    })
    setExporting(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    // 空路径 = 用户在保存对话框里点了取消，什么都不提示（照项目的惯例）
    if (r.data.canceled || !r.data.path) return
    setResult({
      path: r.data.path,
      width: r.data.width,
      height: r.data.height,
      missing: r.data.images.missing
    })
    if (r.data.images.missing.length > 0) {
      // 缺图必须如实说：用户以为封面都进去了，回头发现图上有空白格子，就再也不会信这个导出
      toast.warn(`图片已导出，但有 ${r.data.images.missing.length} 张封面没取到`)
    } else {
      toast.success(`图片已导出：${r.data.path}`)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="导出排名表为图片" width={560}>
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-elev1 p-3 text-[11px] leading-relaxed text-dim">
          表名「{table.name}」· {table.tiers.length} 档 · 排名区 {table.items.length} 部作品
          <br />
          版式只保留「排名表信息 + 排名详细区域」，宽度按内容自动收紧：
          <span className="text-text"> {layout.width}px</span> × {scale} 倍 =
          <span className="text-text"> {layout.width * scale}px</span> 宽，高由内容决定。
          背景与标签配色用这张表自己的设置，不跟随应用主题。
        </div>

        <div>
          <div className="mb-1.5 text-xs font-semibold text-dim">排名人（选填，填了才显示在信息区）</div>
          <Input value={author} maxLength={24} placeholder="例如：你的昵称" onChange={(e) => setAuthor(e.target.value)} />
        </div>

        <div className="flex items-end gap-3">
          <div>
            <div className="mb-1.5 text-xs font-semibold text-dim">清晰度</div>
            <Select value={String(scale)} onChange={(e) => setScale(Number(e.target.value))} className="w-[128px]">
              {EXPORT_SCALES.map((s) => (
                <option key={s} value={String(s)}>
                  {s} 倍{s === DEFAULT_EXPORT_SCALE ? '（推荐）' : ''}
                </option>
              ))}
            </Select>
          </div>
          <div className="pb-2 text-[11px] leading-relaxed text-faint">
            点导出后会弹出系统保存对话框，位置和文件名都由你自己选。
          </div>
        </div>

        {result ? (
          <div className="rounded-lg border border-ok/40 bg-ok/10 p-3 text-[11px] leading-relaxed">
            <div className="font-semibold text-ok">
              已导出 {result.width} × {result.height} 像素
            </div>
            <div className="mt-1 break-all text-dim">{result.path}</div>
            {result.missing.length > 0 ? (
              <div className="mt-2 flex gap-1.5 text-warn">
                <CircleAlert size={13} className="mt-px shrink-0" />
                <div>
                  有 {result.missing.length} 张封面没取到，图上对应位置是空白（不影响其它内容）：
                  <ul className="mt-1 list-disc pl-4">
                    {result.missing.slice(0, 8).map((m, i) => (
                      <li key={`${m.label}-${i}`}>
                        {m.label}（{m.reason}）
                      </li>
                    ))}
                  </ul>
                  {result.missing.length > 8 ? <div className="mt-1">…还有 {result.missing.length - 8} 张</div> : null}
                </div>
              </div>
            ) : null}
            <div className="mt-2">
              <Button
                size="sm"
                variant="outline"
                icon={FolderOpen}
                onClick={() => {
                  void api.app.openPath(result.path).then((r) => {
                    if (!r.ok) toast.error(r.error)
                  })
                }}
              >
                打开这张图
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button icon={ImageDown} loading={exporting} disabled={table.items.length === 0} onClick={() => void doExport()}>
            {table.items.length === 0 ? '排名区还是空的' : '导出图片'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

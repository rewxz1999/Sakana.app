import { useEffect, useMemo, useState } from 'react'
import { Check, ImageDown } from 'lucide-react'
import { MAX_LONG_PAGES, type RecommendPage } from '@/stores/recommendTable'
import { toast } from '@/stores/app'
import { Button, Input, Modal } from '@/components/ui'
import { cardWidthOfAll, displayName } from './styles'
import { estimateExportHeight } from './exportHtml'

/**
 * 导出图片弹窗（用户需求 5）。
 *
 * 用户要自己选三件事：
 *  1. **只导当前页**还是**把所有页面拼成一张长图**（长图最多 MAX_LONG_PAGES 页，超了要拦住）；
 *  2. 导出前填「推荐人」——填了才出现在标题下方（署名是**这张图**的信息，所以放在这里而不是表里）；
 *  3. 清晰度（2 倍 / 3 倍）：导出实际像素 = **版式宽 × 倍数**。
 *
 * ⚠️ 版式宽不是固定 1200：它按内容收紧（`cardWidthOfAll`，见 styles.ts 的文件头），
 * 所以这里预告的尺寸必须用同一个函数算 —— 弹窗上写多少，导出来就是多少（用户要「不留空白」）。
 *
 * ## 为什么长图是「勾选页面」而不是「自动全部」
 *
 * 用户明确要求「长图只支持最多 5 个页面拼接」，所以表里超过 5 页时**必然**要做取舍。
 * 与其拦住用户说"你的表超了，去删页"，不如让他在这里直接勾出要拼的那几页 ——
 * 一张 12 页的表完全可能只想拼其中 5 页代表作。默认勾选前 5 页（最常见的就是从头拼）。
 */
export function ExportDialog({
  open,
  tableName,
  pages,
  currentIndex,
  recommender,
  onRecommenderChange,
  exporting,
  onExport,
  onClose
}: {
  open: boolean
  tableName: string
  pages: RecommendPage[]
  /** 当前正在看的那一页（下标，0 起）：默认导出范围跟着它走 */
  currentIndex: number
  recommender: string
  onRecommenderChange: (v: string) => void
  exporting: boolean
  /** 真正导出：给出要导出的页（顺序即拼接顺序）与清晰度倍数 */
  onExport: (pages: RecommendPage[], scale: number) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<'current' | 'long'>('current')
  const [scale, setScale] = useState(2)
  /** 长图里勾中的页 id（顺序按表内顺序，不按勾选顺序 —— 长图的页序必须是表面顺序） */
  const [picked, setPicked] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    /*
     * 每次打开都重置：默认「只导当前页」（最常用），长图默认勾前 5 页。
     * 不保留上次的选择是因为页数会变（用户可能刚删/加过页），
     * 拿一份过期的勾选去导出，用户会得到一张少了几页的图而不知道哪里错了。
     */
    setMode('current')
    setScale(2)
    setPicked(pages.slice(0, MAX_LONG_PAGES).map((p) => p.id))
  }, [open, pages.length])

  const pickedPages = useMemo(
    () => pages.filter((p) => picked.includes(p.id)),
    [pages, picked]
  )
  const exportPages = mode === 'current' ? pages.slice(currentIndex, currentIndex + 1) : pickedPages
  const tooMany = pages.length > MAX_LONG_PAGES
  // 与真正导出用的是同一个宽度函数（buildExportDocument 内部也算它），所以预告尺寸不会骗人
  const width = cardWidthOfAll(exportPages)
  const height = estimateExportHeight(exportPages, recommender)

  function toggle(id: string): void {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= MAX_LONG_PAGES) {
        // 硬拦：主进程的离屏截图高度有上限，拼太多页会被截断（那比直接拒绝更糟）
        toast.warn(`长图最多拼 ${MAX_LONG_PAGES} 页，先去勾掉一页再选这一页`)
        return prev
      }
      return [...prev, id]
    })
  }

  const canExport = exportPages.length > 0 && !exporting

  return (
    <Modal open={open} onClose={onClose} title="导出推荐表为图片" width={620}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
          <span>
            表「{tableName}」共 {pages.length} 页 · 导出的是 PNG，实际像素 = 版式宽 × 清晰度
          </span>
        </div>

        {/* ---- 导出范围 ---- */}
        <div className="rounded-xl border border-border bg-elev1/60 p-3">
          <div className="mb-2 text-[11px] font-semibold text-faint">导出范围</div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setMode('current')}
              className={`h-8 rounded-lg px-3 text-xs transition-colors ${
                mode === 'current' ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
              }`}
            >
              只导出当前页
            </button>
            <button
              type="button"
              onClick={() => setMode('long')}
              className={`h-8 rounded-lg px-3 text-xs transition-colors ${
                mode === 'long' ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
              }`}
            >
              拼成长图（最多 {MAX_LONG_PAGES} 页）
            </button>
          </div>

          {tooMany ? (
            <div className="mt-2 rounded-lg bg-warn/12 px-2.5 py-2 text-[10px] leading-relaxed text-warn">
              这张表有 {pages.length} 页，超过长图上限（{MAX_LONG_PAGES} 页）。
              请勾选要拼进去的 {MAX_LONG_PAGES} 页 —— 已经默认勾了前 {MAX_LONG_PAGES} 页。
            </div>
          ) : null}

          {mode === 'long' ? (
            <>
              <div className="mb-1.5 mt-3 flex items-center justify-between text-[11px]">
                <span className="text-faint">勾选要拼进长图的页面（顺序按表内顺序）</span>
                <span className={picked.length >= MAX_LONG_PAGES ? 'text-warn' : 'text-faint'}>
                  已选 {picked.length} / {MAX_LONG_PAGES}
                </span>
              </div>
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pr-1">
                {pages.map((p, i) => {
                  const on = picked.includes(p.id)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggle(p.id)}
                      title={displayName(p)}
                      className={`flex h-7 max-w-[180px] items-center gap-1 rounded-lg px-2 text-xs transition-colors ${
                        on ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
                      }`}
                    >
                      {on ? <Check size={12} /> : null}
                      <span className="tabular-nums">{i + 1}</span>
                      <span className="truncate">{displayName(p)}</span>
                    </button>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="mt-2 text-[10px] leading-relaxed text-faint">
              当前看的是第 {currentIndex + 1} 页
              {pages[currentIndex] ? `《${displayName(pages[currentIndex])}》` : ''}，
              导出的图里页脚显示的仍是它在整张表里的真实页码。
            </div>
          )}
        </div>

        {/* ---- 推荐人 + 清晰度 ---- */}
        <div className="space-y-3 rounded-xl border border-border bg-elev1/60 p-3">
          <label className="flex items-center gap-3 text-xs text-dim">
            <span className="w-20 shrink-0">推荐人</span>
            <Input
              value={recommender}
              placeholder="留空则不显示署名"
              onChange={(e) => onRecommenderChange(e.target.value)}
            />
          </label>
          <div className="text-[10px] leading-relaxed text-faint">
            填了才会出现在番剧名「下方」（导出图与界面预览都会显示）。留空就是一张没有署名的推荐表。
          </div>
          <label className="flex items-center gap-3 text-xs text-dim">
            <span className="w-20 shrink-0">清晰度</span>
            <div className="flex gap-2">
              {[2, 3].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScale(s)}
                  className={`h-7 rounded-lg px-3 text-xs transition-colors ${
                    scale === s ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
                  }`}
                >
                  {s} 倍
                </button>
              ))}
            </div>
            <span className="text-[10px] text-faint">
              约 {width * scale} × {height * scale} 像素
            </span>
          </label>
        </div>

        <div className="text-[10px] leading-relaxed text-faint">
          导出图固定用浅色底 + 深色字（不跟随应用主题），这样发出去别人看得清；
          界面里的预览就是同一套配色，所以你看到的版式就是导出图的样子。
          保存位置在下一步的系统对话框里自己选。
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-[11px] text-faint">
          {exportPages.length > 0
            ? `将导出 ${exportPages.length} 页 · 版式 ${width}px 宽（已按内容收紧）· 成图约 ${width * scale} × ${height * scale} 像素`
            : '还没有可导出的页面'}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            icon={ImageDown}
            loading={exporting}
            disabled={!canExport}
            onClick={() => onExport(exportPages, scale)}
          >
            导出为图片
          </Button>
        </div>
      </div>
    </Modal>
  )
}

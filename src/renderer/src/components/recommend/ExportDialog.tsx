import { useEffect, useMemo, useState } from 'react'
import { Check, ImageDown } from 'lucide-react'
import {
  MAX_LONG_PAGES,
  MODULE_KINDS,
  MODULE_NAMES,
  resolveModules,
  type ModuleKind,
  type RecommendPage
} from '@/stores/recommendTable'
import { toast } from '@/stores/app'
import { Button, Input, Modal } from '@/components/ui'
import { RL, displayName, pageHeightOf } from './styles'

/**
 * 导出图片弹窗（v0.3.7 引入，v0.3.8 加了「导出哪些模块」）。
 *
 * 用户要自己选四件事：
 *  1. **只导当前页**还是**把所有页面拼成一张长图**（长图最多 MAX_LONG_PAGES 页，超了要拦住）；
 *  2. **这次要出现哪些模块**（例如只挑「封面 + 评分 + 推荐理由」）；
 *  3. 导出前填「推荐人」——填了才出现在番剧名下方；
 *  4. 清晰度（2 倍 / 3 倍）：导出实际像素 = **页面宽 1200 × 倍数**。
 *
 * ⚠️ 尺寸预告必须和真正导出的一致，所以宽度直接取 `RL.width`、高度直接累加 `pageHeightOf()` ——
 * 与 `buildExportDocument` 用的是同一批函数（页面宽度固定 1200，因此导出图**不会**比页面更宽）。
 *
 * ## 「模块勾选」与「页面里隐藏的模块」是两件事
 *
 *   · 页面上隐藏（模块与布局面板里的显示开关）是**这一页的版面设置**，会持久化、永远不导出；
 *   · 这里的勾选是**这一次导出**的临时选择，不落盘（下次打开回到"全选"）。
 * 两者取交集：页面已隐藏的模块在这里显示成不可选并注明原因，免得用户勾了却没出现。
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
  /** 真正导出：要导出的页、清晰度倍数、这次展示的模块 */
  onExport: (pages: RecommendPage[], scale: number, modules: ModuleKind[]) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<'current' | 'long'>('current')
  const [scale, setScale] = useState(2)
  /** 长图里勾中的页 id（顺序按表内顺序，不按勾选顺序 —— 长图的页序必须是表面顺序） */
  const [picked, setPicked] = useState<string[]>([])
  /** 这次要导出的模块（默认全选） */
  const [mods, setMods] = useState<ModuleKind[]>(MODULE_KINDS)

  useEffect(() => {
    if (!open) return
    /*
     * 每次打开都重置：默认「只导当前页」+ 全部模块。
     * 不保留上次的勾选是因为页数会变（用户可能刚删 / 加过页），
     * 拿一份过期的勾选去导出，用户会得到一张少了几页的图而不知道哪里错了。
     */
    setMode('current')
    setScale(2)
    setPicked(pages.slice(0, MAX_LONG_PAGES).map((p) => p.id))
    setMods(MODULE_KINDS)
  }, [open, pages.length])

  const pickedPages = useMemo(() => pages.filter((p) => picked.includes(p.id)), [pages, picked])
  const exportPages = mode === 'current' ? pages.slice(currentIndex, currentIndex + 1) : pickedPages
  const tooMany = pages.length > MAX_LONG_PAGES

  /** 这次导出的页里，哪些模块被页面自己隐藏了（隐藏的不能勾） */
  const hiddenInPages = useMemo(() => {
    const hidden = new Set<ModuleKind>()
    for (const p of exportPages) {
      for (const m of resolveModules(p)) if (!m.visible) hidden.add(m.id)
    }
    return hidden
  }, [exportPages])

  const width = RL.width
  const height =
    exportPages.reduce((sum, p) => sum + pageHeightOf(p), 0) +
    RL.splitH * Math.max(0, exportPages.length - 1) +
    RL.bodyPadV * 2

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

  /** 勾 / 取消一个模块（顺序始终按 MODULE_KINDS，导出弹窗与模块列表的顺序一致） */
  function toggleMod(id: ModuleKind): void {
    setMods((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : MODULE_KINDS.filter((k) => prev.includes(k) || k === id)
    )
  }

  const canExport = exportPages.length > 0 && mods.length > 0 && !exporting

  return (
    <Modal open={open} onClose={onClose} title="导出推荐表为图片" width={640}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
          <span>
            表「{tableName}」共 {pages.length} 页 · 导出 PNG，实际像素 = 页面宽 {RL.width} × 清晰度
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
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto pr-1">
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

        {/* ---- 模块勾选（v0.3.8 需求 4） ---- */}
        <div className="rounded-xl border border-border bg-elev1/60 p-3">
          <div className="mb-2 flex items-center justify-between text-[11px]">
            <span className="font-semibold text-faint">这次要出现哪些模块</span>
            <span className={mods.length === 0 ? 'text-danger' : 'text-faint'}>
              已选 {mods.length} / {MODULE_KINDS.length}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {MODULE_KINDS.map((id) => {
              const on = mods.includes(id)
              const forcedHidden = hiddenInPages.has(id)
              return (
                <button
                  key={id}
                  type="button"
                  disabled={forcedHidden}
                  title={forcedHidden ? '这一页已经把该模块隐藏了（去「模块与布局」里放回来）' : MODULE_NAMES[id]}
                  onClick={() => toggleMod(id)}
                  className={`flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs transition-colors ${
                    forcedHidden
                      ? 'bg-elev2 text-faint line-through'
                      : on
                        ? 'bg-accent text-white'
                        : 'bg-elev2 text-dim hover:text-text'
                  }`}
                >
                  {on && !forcedHidden ? <Check size={12} /> : null}
                  {MODULE_NAMES[id]}
                </button>
              )
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setMods(MODULE_KINDS)}
              className="rounded-md bg-elev2 px-2 py-1 text-[10px] text-dim transition-colors hover:text-text"
            >
              全选
            </button>
            <button
              type="button"
              onClick={() => setMods(['cover', 'ratings', 'reason'])}
              className="rounded-md bg-elev2 px-2 py-1 text-[10px] text-dim transition-colors hover:text-text"
            >
              只要封面 + 评分 + 理由
            </button>
            <button
              type="button"
              onClick={() => setMods([])}
              className="rounded-md bg-elev2 px-2 py-1 text-[10px] text-dim transition-colors hover:text-text"
            >
              全不选
            </button>
          </div>
          <div className="mt-1.5 text-[10px] leading-relaxed text-faint">
            没勾的模块不会出现在图上，但页面尺寸与其它模块的位置一点都不会变
            （模块是绝对定位在页面画布上的），所以导出的图与你在界面上看到的是同一张。
          </div>
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
            填了才会出现在「番剧名」模块里（导出图与界面预览都会显示）。
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
          界面里的预览用的是同一套配色与同一套坐标，所以你看到的就是导出的样子。
          保存位置在下一步的系统对话框里自己选。
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-[11px] text-faint">
          {exportPages.length === 0
            ? '还没有可导出的页面'
            : mods.length === 0
              ? '至少选一个模块'
              : `将导出 ${exportPages.length} 页 · 页面 ${width} 宽 · 成图约 ${width * scale} × ${height * scale} 像素`}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            icon={ImageDown}
            loading={exporting}
            disabled={!canExport}
            onClick={() => onExport(exportPages, scale, mods)}
          >
            导出为图片
          </Button>
        </div>
      </div>
    </Modal>
  )
}

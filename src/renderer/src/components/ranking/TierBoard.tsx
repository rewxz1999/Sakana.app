import { useEffect, useRef, useState } from 'react'
import { Anchor, GripVertical, MoveHorizontal, Palette } from 'lucide-react'
import { Badge, IconButton } from '@/components/ui'
import { WORK_CARD_CHROME, WorkCard, type WorkCardMetrics } from '@/components/ranking/WorkCard'
import {
  TIER_COLOR_PRESETS,
  effectiveStraddleSlot,
  maxSlotForBoundary,
  rankRowLayouts,
  readableTextOn,
  seatedItemsOfTier,
  slotToOffset,
  straddleItemsAt,
  type PlacedStraddle,
  type RankedItem,
  type RankingAnchor,
  type RankingSlot,
  type RankingTable,
  type TierDef
} from '@/stores/rankingTable'

/**
 * 排名区：每一档一张卡片（`rounded-xl border border-border bg-elev1`），左边是等级标签色块，右边是横排的作品卡。
 *
 * ============================ V0.3.9：骑缝改成"直接落在分界线上" ============================
 *
 * 用户原话：「现在的骑缝是在两个标签分界线上添加新的区域加入作品。我的需求是拖动作品时在两个标签分界线上时，
 * 不要新区域，就放在分界线上，可以给分界线上添加锚点，方便作品的放置与固定。」
 *
 * 所以：
 *   ① **没有"骑缝区/骑缝带"这种东西了**（上一版那条独立带、以及它带来的"挤压其它档"整块撤掉）：
 *      骑缝作品就是一张卡，**绝对定位画在两档的分界线上**（纵向以分界线为轴居中 `top: 线 - cardH/2`），
 *      横向位置由它自己的 `slot`（第几格）决定；两档的行高不再因为它变化。
 *   ② **吸附**：拖动时鼠标离分界线 `LINE_SNAP_PX` 以内 → 贴到线上（超过就正常落在档内，不粘）；
 *      松手就固定在那儿。横向位置就是用户拖到的格子（量化到 1/4 格，避免像素级抖动）。
 *   ③ **锚点**：用户可以在分界线上加锚点（右键分界线）、改名、沿分界线拖动、删除；
 *      作品拖到锚点附近（`ANCHOR_SNAP_PX` 内）会**吸附到锚点**并和锚点共用同一个 slot ——
 *      所以以后上下档高度/卡片尺寸变化时它跟着锚点走，不会漂移。没有锚点的分界线照样能直接落线。
 *   ④ 只有一档时没有分界线，界面上给中文说明（见 SINGLE_TIER_HINT）。
 *
 * ============================ 投放判定（"要拖好多次才能放上去"那次的教训） ============================
 *
 * 仍然**只在画布容器上做一次判定**，按坐标算（`hitTest`），子元素不各自判定、也不 stopPropagation：
 *   · 行矩形的**上下各外扩 6px**，行内空白/行间缝隙都算命中；落在所有行之外时退化为最近的一行；
 *   · 行内按鼠标 x 找最近的插入位（`Math.round`），不需要对准某张卡或缝隙；
 *   · 分界线是"线的上下 12px"这条带 → 骑缝；带内再看是否贴近锚点。
 * 拖拽期间画布 `overflow: hidden`（浏览器靠近边缘的自动滚动会让落点跑掉），滚轮横滑也在此期间关闭。
 */

/** 画布内边距、档位卡之间的间距、标签与作品行之间的间距、卡片间距 */
const BOARD_PAD = 8
const BOARD_GAP = 8
const LABEL_GAP = 12
const CARD_GAP = 8
/** 档位卡自己的内边距（p-1.5 = 6px）+ 边框 */
const ROW_PAD = 7
/** 作品行自己的内边距 */
const WORKS_PAD = 4
/** 标签在横向滚动时停在离左边缘这么远的地方（画布内边距 + 档位卡内边距） */
const LABEL_STICK_LEFT = BOARD_PAD + 6
/** 贴线吸附阈值：鼠标离分界线这么近就算"落在线上"（超过就正常落在档内，不粘） */
const LINE_SNAP_PX = 12
/** 锚点吸附阈值：作品拖到锚点这么近就钉上去 */
const ANCHOR_SNAP_PX = 26
/** 行命中矩形的上下外扩，避免落在行与行之间的缝里"谁都不算" */
const ROW_HIT_PAD = 6
/** 自由落线的横向量化：1/4 格（够自由，又不会因为一个像素的抖动而改变落点） */
const SLOT_QUANT = 4
/** 封面高度上下限：下限保证"卡片可读"，上限避免档少时封面大到离谱 */
const COVER_MIN = 44
const COVER_MAX = 96
/** 名字区高度：两行（含间距）与一行 */
const TEXT_TWO_LINE = 30
const TEXT_ONE_LINE = 17
/** 两行名字至少要能给封面留出这么高，否则退回一行（74px ≈ 应用列表条目封面的高度） */
const TWO_LINE_MIN_COVER = 74
/** 只有一档时的说明（用户要求边界情况给出清楚的中文空态） */
const SINGLE_TIER_HINT = '只有一档时没有分界线。在「等级标签」里加一档后，就能把作品拖到两档之间的分界线上（骑缝）。'

/** 当前拖动/悬停的落点 */
export interface DropTarget {
  /** 目标档（骑缝时 = 分界线上方那一档） */
  tierIndex: number
  /** true = 落在 tierIndex 与 tierIndex+1 的分界线上 */
  straddle: boolean
  /** 骑缝时的横向格位置（画 ghost 用） */
  position: number
  /** 骑缝时吸附到哪个锚点（null = 直接落线） */
  anchorId: string | null
  /** 档内插入位（画插入竖线用） */
  insertIndex: number
  /** 给用户看的提示（吸附到锚点时写锚点名） */
  hint: string
}

/** 一屏排版算出来的尺寸 */
interface BoardLayout {
  rowH: number
  /** 作品卡总高（封面 + 名字 + 卡片自身的一圈） */
  cardH: number
  coverH: number
  coverW: number
  lines: 1 | 2
  font: number
  labelW: number
  labelFont: number
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 格位置量化：只保留 1/SLOT_QUANT 的精度 */
function quantizeSlot(v: number): number {
  return Math.round(v * SLOT_QUANT) / SLOT_QUANT
}

/**
 * 按「可用高度 + 档数」反算排版。
 *
 * 注意：**骑缝不再影响这里**（V0.3.9）。上一版为了在分界线上插一条骑缝带，要让所有行一起变矮；
 * 现在骑缝作品直接画在线上、不占行高，所以这一档该多大还是多大（"不再挤压其它档"）。
 * 唯一保留的硬约束是 `行高 ≥ 卡片高 + 内边距`：装不下时撑高内容让画布纵向滚动，而不是让行与行互相叠。
 */
export function layoutFor(tiers: TierDef[], availH: number): BoardLayout {
  const count = Math.max(1, tiers.length)
  const usable = Math.max(
    COVER_MIN + TEXT_ONE_LINE + WORK_CARD_CHROME + ROW_PAD * 2,
    availH - BOARD_PAD * 2 - BOARD_GAP * Math.max(0, count - 1)
  )
  const wanted = usable / count
  const cardAvail = Math.max(COVER_MIN + TEXT_ONE_LINE + WORK_CARD_CHROME, Math.floor(wanted - ROW_PAD * 2))
  const lines: 1 | 2 = cardAvail - TEXT_TWO_LINE - WORK_CARD_CHROME >= TWO_LINE_MIN_COVER ? 2 : 1
  const textH = lines === 2 ? TEXT_TWO_LINE : TEXT_ONE_LINE
  const coverH = clamp(cardAvail - textH - WORK_CARD_CHROME, COVER_MIN, COVER_MAX)
  const cardH = coverH + textH + WORK_CARD_CHROME
  const rowH = Math.max(wanted, cardH + ROW_PAD * 2)
  const font = clamp(Math.round(coverH / 8), 9, 12)
  const coverW = Math.round(coverH * 0.72)
  // 标签列：按最长标签名定宽，保证「人上人」这种三字标签不会挤成两行竖排
  const maxLen = tiers.reduce((n, t) => Math.max(n, t.name.length), 1)
  const labelFont = clamp(Math.round(coverH * 0.26), 12, 20)
  const labelW = clamp(Math.round(maxLen * labelFont * 0.95) + 22, 54, 160)
  return { rowH, cardH, coverH, coverW, lines, font, labelW, labelFont }
}

export interface TierBoardProps {
  table: RankingTable
  /** 正在拖的作品（作品卡高亮用） */
  draggingWorkId: string | null
  /** 正在拖的锚点（锚点高亮用；与 draggingWorkId 互斥） */
  draggingAnchorId: string | null
  dropTarget: DropTarget | null
  onHover: (target: DropTarget | null) => void
  /** 作品落定（slot 里带了骑缝位置与吸附的锚点） */
  onDropWork: (slot: RankingSlot) => void
  /** 锚点落定（拖锚点 = 换位置/换分界线） */
  onDropAnchor: (anchorId: string, tierIndex: number, slot: number) => void
  onDragStartWork: (workId: string) => void
  onDragStartAnchor: (anchorId: string) => void
  onDragEnd: () => void
  onItemContextMenu: (e: React.MouseEvent, item: RankedItem) => void
  /** 右键等级标签 */
  onTierContextMenu: (e: React.MouseEvent, tierIndex: number) => void
  /** 右键锚点 */
  onAnchorContextMenu: (e: React.MouseEvent, anchor: RankingAnchor) => void
  /** 右键分界线（用来在鼠标那一格加锚点） */
  onBoundaryContextMenu: (e: React.MouseEvent, tierIndex: number, slot: number) => void
  /** 正在改哪一档的颜色（null = 没开色板） */
  colorPickTier: number | null
  onToggleColorPick: (tierIndex: number) => void
  onPickColor: (tierIndex: number, color: string) => void
}

export function TierBoard({
  table,
  draggingWorkId,
  draggingAnchorId,
  dropTarget,
  onHover,
  onDropWork,
  onDropAnchor,
  onDragStartWork,
  onDragStartAnchor,
  onDragEnd,
  onItemContextMenu,
  onTierContextMenu,
  onAnchorContextMenu,
  onBoundaryContextMenu,
  colorPickTier,
  onToggleColorPick,
  onPickColor
}: TierBoardProps) {
  const dragging = draggingWorkId !== null || draggingAnchorId !== null
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 每一档的行元素（投放判定要按它们的矩形算） */
  const rowRefs = useRef(new Map<number, HTMLDivElement>())
  const [box, setBox] = useState({ h: 0, w: 0 })
  const draggingRef = useRef(dragging)
  draggingRef.current = dragging

  // 画布尺寸只能量出来（窗口大小、作品池是否折叠都会变），所以量完再排版
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setBox({ h: el.clientHeight, w: el.clientWidth })
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * 纵向滚轮 → 横向滚动（React 的 onWheel 是 passive，preventDefault 不生效，只能用原生监听）。
   * 拖拽中直接返回：浏览器靠近边缘的自动滚动会让落点跑掉（用户明确要求拖拽时不要滚）。
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (draggingRef.current) return
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      const max = el.scrollWidth - el.clientWidth
      if (max <= 0) return
      const next = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY))
      if (next === el.scrollLeft) return
      e.preventDefault()
      el.scrollLeft = next
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 首帧还没量到尺寸：先按一个保守值排
  const layout = layoutFor(table.tiers, box.h > 0 ? box.h : 620)
  const metrics: WorkCardMetrics = {
    w: layout.coverW,
    h: layout.coverH,
    lines: layout.lines,
    font: layout.font
  }
  const cardW = layout.coverW + WORK_CARD_CHROME
  const step = cardW + CARD_GAP
  /** 作品区左边距（相对档位卡左边）：档位卡内边距 + 边框 + 标签列 + 间距 + 作品行内边距 */
  const worksLeftInset = ROW_PAD + layout.labelW + LABEL_GAP + WORKS_PAD
  const { rows, contentW } = rankRowLayouts(table, {
    cardW,
    gap: CARD_GAP,
    labelW: layout.labelW,
    labelGap: LABEL_GAP,
    rowChrome: ROW_PAD * 2 + WORKS_PAD * 2
  })
  const overflowX = box.w > 0 && contentW + BOARD_PAD * 2 > box.w + 1
  /** 分界线相对某一档行块顶部的 y（行块高 rowH，缝的中间就是分界线） */
  const boundaryY = layout.rowH + BOARD_GAP / 2

  const seatedOfRow = (tierIndex: number): RankedItem[] => seatedItemsOfTier(table.items, tierIndex)
  /** 这一档分界线上的骑缝作品（**已排好互不重叠的实际列**，见 rankRowLayouts） */
  const straddleOfRow = (tierIndex: number): PlacedStraddle[] =>
    rows.find((r) => r.tierIndex === tierIndex)?.below ?? []

  /** ghost 画在哪儿：与真正放下后的结果一致（都走 effectiveStraddleSlot，见 store 的说明） */
  function previewSlot(tierIndex: number, desired: number, movingWorkId: string | null): number {
    // 拖锚点时移动的是锚点，不参与骑缝的列位排列
    if (draggingAnchorId) return Math.max(0, desired)
    return effectiveStraddleSlot(table, tierIndex, desired, movingWorkId)
  }

  /**
   * 按坐标算落点（见文件头）。骑缝判定优先于档内判定：
   * 先看是不是贴在分界线上（线的上下 LINE_SNAP_PX），再看有没有锚点可吸。
   */
  function hitTest(clientX: number, clientY: number, forAnchor: boolean): DropTarget | null {
    const rects: { index: number; rect: DOMRect }[] = []
    rowRefs.current.forEach((el, index) => {
      const rect = el.getBoundingClientRect()
      if (rect.height > 0) rects.push({ index, rect })
    })
    if (rects.length === 0) return null
    rects.sort((a, b) => a.index - b.index)

    // ① 分界线（两行之间的中线上下各 LINE_SNAP_PX）
    if (table.tiers.length >= 2) {
      for (let i = 0; i < rects.length - 1; i += 1) {
        const boundary = (rects[i].rect.bottom + rects[i + 1].rect.top) / 2
        if (Math.abs(clientY - boundary) > LINE_SNAP_PX) continue
        const tierIndex = rects[i].index
        const worksLeft = rowRefs.current.get(tierIndex)?.querySelector('[data-ranking-works]')?.getBoundingClientRect().left
        const left = typeof worksLeft === 'number' ? worksLeft : rects[i].rect.left
        const maxSlot = maxSlotForBoundary(rows, tierIndex, cardW, CARD_GAP)
        const rawSlot = clamp(quantizeSlot((clientX - left) / step), 0, maxSlot)
        // 锚点吸附：带内离锚点 ANCHOR_SNAP_PX 以内就钉上去（拖拽经过时每帧重算，所以不会"粘住不放"）
        const anchor =
          table.anchors
            .filter((a) => a.tierIndex === tierIndex)
            .map((a) => ({ a, d: Math.abs(left + slotToOffset(a.slot, cardW, CARD_GAP) + cardW / 2 - clientX) }))
            .filter((x) => x.d <= ANCHOR_SNAP_PX)
            .sort((x, y) => x.d - y.d)[0]?.a ?? null
        return {
          tierIndex,
          straddle: true,
          // 期望列还要过一次"同一条线不共列"的排列，ghost 才不会和落点对不上（见 store 的 effectiveStraddleSlot）
          position: previewSlot(tierIndex, anchor ? anchor.slot : rawSlot, draggingWorkId),
          anchorId: forAnchor ? null : anchor?.id ?? null,
          insertIndex: 0,
          hint: anchor
            ? `吸附到锚点「${anchor.name || '未命名'}」`
            : forAnchor
              ? '把锚点放到这条分界线上'
              : '骑缝：作品落在分界线上，同时计入上下两档'
        }
      }
    }

    // ② 整行（外扩 ROW_HIT_PAD）；都没命中就取纵向最近的一行，绝不出现"哪儿都不是"
    const inRow = rects.find((e) => clientY >= e.rect.top - ROW_HIT_PAD && clientY <= e.rect.bottom + ROW_HIT_PAD)
    const hit =
      inRow ??
      rects.reduce(
        (best, e) => {
          const d = Math.min(Math.abs(clientY - e.rect.top), Math.abs(clientY - e.rect.bottom))
          return !best || d < best.d ? { ...e, d } : best
        },
        null as ({ index: number; rect: DOMRect; d: number } | null)
      )
    if (!hit) return null
    // 拖锚点时不允许落在档内（锚点只属于分界线）
    if (forAnchor) return null

    // ③ 行内按 x 找最近的插入位
    const worksEl = rowRefs.current.get(hit.index)?.querySelector('[data-ranking-works]')
    const worksLeft = worksEl instanceof Element ? worksEl.getBoundingClientRect().left : hit.rect.left
    const seated = seatedOfRow(hit.index)
    const raw = Math.round((clientX - worksLeft) / step)
    const insertIndex = Math.max(0, Math.min(seated.length, Number.isFinite(raw) ? raw : 0))
    return {
      tierIndex: hit.index,
      straddle: false,
      position: 0,
      anchorId: null,
      insertIndex,
      hint: table.tiers[hit.index] ? `放到「${table.tiers[hit.index].name}」` : ''
    }
  }

  /**
   * 同一个落点不要反复 setState（dragover 每秒几十次，白重渲染一整个画布）。
   * ⚠️ 提示文案（hint）也要参与比较：拖作品和拖锚点在同一格上的坐标完全一样，
   * 只有 hint 不同 —— 不比它就会把上一次的提示留在屏幕上（测试里就是这样发现"拖锚点时还显示作品提示"的）。
   */
  function hoverIfChanged(next: DropTarget | null): void {
    const cur = dropTarget
    if (next === null) {
      if (cur !== null) onHover(null)
      return
    }
    if (
      cur &&
      cur.tierIndex === next.tierIndex &&
      cur.straddle === next.straddle &&
      cur.position === next.position &&
      cur.anchorId === next.anchorId &&
      cur.insertIndex === next.insertIndex &&
      cur.hint === next.hint
    ) {
      return
    }
    onHover(next)
  }

  return (
    <div
      ref={scrollRef}
      data-ranking-board=""
      style={{ overflow: dragging ? 'hidden' : 'auto' }}
      className="relative h-full bg-bg"
      onMouseDown={(e) => {
        if (colorPickTier === null) return
        const target = e.target as HTMLElement | null
        if (!target?.closest('[data-tier-color-ui]')) onToggleColorPick(colorPickTier)
      }}
      // 投放判定只在容器上做：任何落在这里的 dragover 都被接受
      onDragOver={(e) => {
        if (!dragging) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        hoverIfChanged(hitTest(e.clientX, e.clientY, draggingAnchorId !== null))
      }}
      onDrop={(e) => {
        if (!dragging) return
        e.preventDefault()
        const hit = hitTest(e.clientX, e.clientY, draggingAnchorId !== null)
        hoverIfChanged(null)
        if (!hit) return
        if (draggingAnchorId) {
          if (!hit.straddle) return
          onDropAnchor(draggingAnchorId, hit.tierIndex, hit.position)
          return
        }
        onDropWork({
          tierIndex: hit.tierIndex,
          straddle: hit.straddle,
          position: hit.position,
          anchorId: hit.anchorId
        })
      }}
    >
      {/* 整张表还空着时的下一步提示 */}
      {table.items.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
          <div className="rounded-xl border border-dashed border-border bg-elev1/90 px-5 py-4 text-center">
            <div className="text-sm font-semibold">把作品拖到这里排名</div>
            <div className="mt-1 max-w-[420px] text-xs leading-relaxed text-faint">
              从左侧作品池把卡片拖进任意一档；拖到两档之间的分界线上就骑缝（作品落在线上、同时计入上下两档）。
              分界线上可以右键加锚点，把作品钉在固定位置。
            </div>
          </div>
        </div>
      ) : null}

      <div className="relative p-2" style={{ width: contentW + BOARD_PAD * 2 }}>
        {rows.map((row, tierIndex) => {
          const tier = table.tiers[tierIndex]
          const isLast = tierIndex === rows.length - 1
          const rowHover = dropTarget ? dropTarget.tierIndex === tierIndex && !dropTarget.straddle : false
          const hitHover = dropTarget ? dropTarget.tierIndex === tierIndex && dropTarget.straddle : false
          const insertX = rowHover && dropTarget ? dropTarget.insertIndex * step - CARD_GAP / 2 : null
          const straddlers = straddleOfRow(tierIndex)
          const anchorsHere = table.anchors.filter((a) => a.tierIndex === tierIndex)

          return (
            <div
              key={`row-${tierIndex}`}
              ref={(el) => {
                if (el) rowRefs.current.set(tierIndex, el)
                else rowRefs.current.delete(tierIndex)
              }}
              data-ranking-tier-row={tierIndex}
              className="relative"
              style={{ height: layout.rowH, marginTop: tierIndex === 0 ? 0 : BOARD_GAP }}
            >
              {/* 一档一张卡片：应用里的分区卡片写法 */}
              <div
                className={`group flex h-full w-max items-stretch gap-3 rounded-xl border bg-elev1 p-1.5 transition-colors ${
                  rowHover ? 'border-accent bg-accent-soft/40' : 'border-border'
                }`}
              >
                {/* 等级标签：沿用用户选的颜色；横滑时钉在左侧 */}
                <div
                  data-ranking-tier-label={tier.name}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onTierContextMenu(e, tierIndex)
                  }}
                  title="右键可改标签内容与颜色"
                  className="sticky z-30 flex shrink-0 items-center justify-center rounded-lg border border-black/10 px-2 py-1 text-center font-bold"
                  style={{
                    left: LABEL_STICK_LEFT,
                    width: layout.labelW,
                    fontSize: layout.labelFont,
                    background: tier.color,
                    color: readableTextOn(tier.color)
                  }}
                >
                  <span className="leading-tight break-all">{tier.name}</span>
                  <IconButton
                    title="改这一档的颜色（右键标签也能改）"
                    className={`absolute right-0.5 top-0.5 h-5 w-5 ${
                      colorPickTier === tierIndex ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    } hover:bg-black/10`}
                    onClick={() => onToggleColorPick(tierIndex)}
                  >
                    <Palette size={11} />
                  </IconButton>
                  {colorPickTier === tierIndex ? (
                    <ColorPicker
                      color={tier.color}
                      align={tierIndex >= table.tiers.length - 2 ? 'bottom' : 'top'}
                      onPick={(c) => {
                        onPickColor(tierIndex, c)
                        onToggleColorPick(tierIndex)
                      }}
                    />
                  ) : null}
                </div>

                {/* 这一档的作品行：只有一行、不换行；卡片垂直居中（与绝对定位的骑缝卡用同一套坐标） */}
                <div
                  data-ranking-works=""
                  className="relative flex shrink-0 items-center gap-2 rounded-lg px-1"
                  style={{ minHeight: layout.cardH }}
                >
                  {row.seated.map((item) => (
                    <WorkCard
                      key={item.work.id}
                      work={item.work}
                      size={metrics}
                      draggable
                      dragging={draggingWorkId === item.work.id}
                      onDragStart={onDragStartWork}
                      onDragEnd={onDragEnd}
                      onContextMenu={(e) => onItemContextMenu(e, item)}
                      extraTitle="拖动可换档、拖到分界线上骑缝 · 右键可移出排名区"
                    />
                  ))}
                  {insertX !== null ? (
                    <span
                      className="pointer-events-none absolute top-0 h-full w-0.5 rounded-full bg-accent ring-2 ring-accent/20"
                      style={{ left: WORKS_PAD + insertX }}
                    />
                  ) : null}
                  {row.seated.length === 0 && !rowHover ? (
                    <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-1 whitespace-nowrap text-[11px] text-faint">
                      <GripVertical size={11} />
                      {table.items.length === 0 ? '从左侧作品池拖作品进来' : '这一档还没有作品'}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* ---- 分界线（每两档之间一条）：锚点 + 骑缝作品都挂在这条线上 ---- */}
              {!isLast ? (
                <>
                  {/* 线本身：横向覆盖作品区；右键可以在这里加锚点 */}
                  <div
                    data-ranking-boundary={tierIndex}
                    title="把作品拖到这里 = 骑缝（落在分界线上）· 右键可加锚点"
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const rect = e.currentTarget.getBoundingClientRect()
                      const maxSlot = maxSlotForBoundary(rows, tierIndex, cardW, CARD_GAP)
                      const slot = clamp(quantizeSlot((e.clientX - rect.left) / step), 0, maxSlot)
                      onBoundaryContextMenu(e, tierIndex, slot)
                    }}
                    style={{ left: worksLeftInset, right: 0, top: layout.rowH + BOARD_GAP / 2 }}
                    className={`absolute z-10 h-6 -translate-y-1/2 ${
                      hitHover && !draggingAnchorId ? 'bg-accent-soft/40' : ''
                    }`}
                  >
                    <div
                      className={`absolute left-0 right-0 top-1/2 -translate-y-1/2 ${
                        hitHover
                          ? 'border-t-2 border-accent'
                          : dragging
                            ? 'border-t border-dashed border-accent/70'
                            : 'border-t border-dashed border-border'
                      }`}
                    />
                  </div>

                  {/* 锚点：分界线上的小标记（可拖、可右键改名/删除） */}
                  {anchorsHere.map((anchor) => {
                    const active = dropTarget?.anchorId === anchor.id || draggingAnchorId === anchor.id
                    const pinned = table.items.filter((it) => it.anchorId === anchor.id).length
                    return (
                      <div
                        key={anchor.id}
                        data-ranking-anchor={anchor.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData('text/plain', anchor.id)
                          onDragStartAnchor(anchor.id)
                        }}
                        onDragEnd={onDragEnd}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          onAnchorContextMenu(e, anchor)
                        }}
                        title={`锚点「${anchor.name || '未命名'}」：钉着 ${pinned} 部作品 · 拖动可沿分界线移动 · 右键可改名/删除`}
                        style={{ left: worksLeftInset + slotToOffset(anchor.slot, cardW, CARD_GAP) + cardW / 2, top: boundaryY }}
                        className={`absolute z-20 -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing ${
                          active ? 'opacity-40' : ''
                        }`}
                      >
                        <span
                          className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold shadow-sm transition-colors ${
                            active
                              ? 'border-accent bg-accent text-white'
                              : 'border-border bg-elev1 text-dim hover:border-accent hover:text-accent'
                          }`}
                        >
                          <Anchor size={10} />
                          <span className="max-w-[92px] truncate">{anchor.name || '未命名'}</span>
                        </span>
                      </div>
                    )
                  })}

                  {/* 骑缝作品：直接画在分界线上（中心落在线上），横向位置 = 它自己的 slot */}
                  {straddlers.map(({ item, slot }) => (
                    <div
                      key={item.work.id}
                      data-ranking-straddle={item.work.id}
                      style={{
                        // slot 是 rankRowLayouts 排好的**实际列**：同一条分界线上多张骑缝会依次往右顺开
                        left: worksLeftInset + slotToOffset(slot, cardW, CARD_GAP),
                        top: boundaryY - layout.cardH / 2,
                        width: cardW,
                        height: layout.cardH
                      }}
                      className="absolute z-20"
                    >
                      <WorkCard
                        work={item.work}
                        size={metrics}
                        draggable
                        dragging={draggingWorkId === item.work.id}
                        cornerBadge={
                          <Badge tone="warn">
                            {item.anchorId ? `锚点 · ${table.anchors.find((a) => a.id === item.anchorId)?.name ?? ''}` : '骑缝'}
                          </Badge>
                        }
                        onDragStart={onDragStartWork}
                        onDragEnd={onDragEnd}
                        onContextMenu={(e) => onItemContextMenu(e, item)}
                        extraTitle={
                          item.anchorId
                            ? '钉在锚点上：同时计入上下两档 · 右键可移出排名区'
                            : '骑缝：落在两档的分界线上，同时计入上下两档 · 右键可移出排名区'
                        }
                      />
                    </div>
                  ))}

                  {/* 拖动中的落点提示：ghost 框 + 一句话（吸附到锚点时会写锚点名） */}
                  {hitHover && dropTarget ? (
                    <>
                      <div
                        className="pointer-events-none absolute z-30 rounded-lg border-2 border-dashed border-accent bg-accent-soft/40"
                        style={{
                          left: worksLeftInset + slotToOffset(dropTarget.position, cardW, CARD_GAP),
                          top: boundaryY - layout.cardH / 2,
                          width: cardW,
                          height: layout.cardH
                        }}
                      />
                      <span
                        className="pointer-events-none absolute z-30"
                        style={{
                          left: worksLeftInset + slotToOffset(dropTarget.position, cardW, CARD_GAP) + cardW / 2,
                          top: boundaryY + layout.cardH / 2 + 6
                        }}
                      >
                        <Badge tone="accent" className="-translate-x-1/2 whitespace-nowrap">
                          {dropTarget.hint}
                        </Badge>
                      </span>
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          )
        })}
      </div>

      {/* 只有一档时的说明（用户要求边界情况给清楚的中文空态） */}
      {table.tiers.length < 2 ? (
        <div className="pointer-events-none sticky bottom-2 left-0 z-40 flex w-full justify-center">
          <Badge tone="neutral" className="bg-elev1/95">
            {SINGLE_TIER_HINT}
          </Badge>
        </div>
      ) : null}

      {/* 横向还有内容时的提示 */}
      {overflowX ? (
        <div className="pointer-events-none sticky bottom-1 left-0 z-40 flex w-full justify-end pr-2">
          <Badge tone="neutral" className="bg-elev3/90">
            <MoveHorizontal size={11} /> 横向滚动查看更多
          </Badge>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 标签配色板（挂在标签旁边的小弹层，属于"菜单"这一类临时浮层，所以用主题的弹层配色）。
 */
function ColorPicker({
  color,
  align,
  onPick
}: {
  color: string
  align: 'top' | 'bottom'
  onPick: (color: string) => void
}) {
  return (
    <div
      data-tier-color-ui=""
      style={align === 'bottom' ? { bottom: 0 } : { top: 0 }}
      className="absolute left-full z-40 ml-1 w-[176px] rounded-xl border border-border bg-elev1 p-2 shadow-2xl"
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="mb-1 text-[10px] text-faint">标签颜色</div>
      <div className="grid grid-cols-5 gap-1">
        {TIER_COLOR_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => onPick(c)}
            className={`h-6 w-6 rounded-md border transition-transform hover:scale-110 ${
              c.toLowerCase() === color.toLowerCase() ? 'border-accent ring-2 ring-accent/40' : 'border-border'
            }`}
            style={{ background: c }}
          />
        ))}
      </div>
      <label className="mt-2 flex items-center gap-2 text-[10px] text-faint">
        自定义
        <input
          type="color"
          value={color}
          onChange={(e) => onPick(e.target.value)}
          className="h-6 w-10 cursor-pointer rounded border border-border bg-elev2 p-0"
        />
      </label>
    </div>
  )
}

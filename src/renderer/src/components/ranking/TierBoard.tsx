import { useEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, MoveHorizontal, Palette } from 'lucide-react'
import { Badge, IconButton } from '@/components/ui'
import { WORK_CARD_CHROME, WorkCard, type WorkCardMetrics } from '@/components/ranking/WorkCard'
import {
  TIER_COLOR_PRESETS,
  boardGeometry,
  readableTextOn,
  seatedItemsOfTier,
  straddleItemsAt,
  type RankedItem,
  type RankingSlot,
  type RankingTable,
  type TierDef
} from '@/stores/rankingTable'

/**
 * 排名区：**每一档一张卡片**（`rounded-xl border border-border bg-elev1`），
 * 卡片左边是等级标签色块，右边是横排的作品卡。
 *
 * ============================ A. 投放判定（用户反馈"要拖好多次才能放上去"） ============================
 *
 * 旧的判定是"每张卡片 / 每条缝隙各自当投放目标"，可命中的地方太窄，还要靠子元素把事件冒泡上来。
 * 现在整块排名区**只有一个投放判定**，按坐标算（`hitTest`）：
 *
 *   ① **整行都是落点**：用行元素的 `getBoundingClientRect()` 做判定，并且**上下各外扩 6px**，
 *      所以行内空白、行与行之间的缝、甚至行稍微外面一点都算命中（用户原话："只要落在这一行的矩形里就算"）；
 *      落在所有行之外时退化为"最近的那一行"，绝不出现"哪儿都不是"。
 *   ② **行内按鼠标 x 找最近的插入位**：插入点是 `左内边距 + k×(卡宽+间距)` 这一串位置，
 *      取离鼠标最近的那个（`Math.round`），于是"放在第 3 张和第 4 张之间"不再需要精确对准缝隙。
 *   ③ **分界线命中带 24px**：上下两档分界线的中线上下各 12px 内、且在作品区横坐标内，就算"骑缝"。
 *   ④ `preventDefault()` 只在**容器**上调用一次（`onDragOver`），子元素不再 stopPropagation，
 *      卡片/标签/滚动容器都只是让事件冒泡；卡片本身也不再挂 onDragOver/onDrop。
 *   ⑤ **拖拽中关掉横向滚动**（`overflow: hidden`）：Chromium 在靠近滚动容器边缘时会自动滚动，
 *      那会让落点在用户没察觉的情况下跑掉（用户明确要求）。滚轮 → 横向滚动的监听在拖拽时也直接返回。
 *
 * 视觉反馈：整行高亮（`border-accent bg-accent-soft`）+ 光标处的**插入位置竖线**；
 * 分界线上是加粗的强调线 + 「骑缝：同时计入「A」和「B」」提示（悬停即显示）。
 *
 * ============================ B. 视觉：用应用自己的设计令牌 ============================
 * 用户要求"就像应用主界面 ui 一样来布置"，所以画布不再是自造的白底 + 固定色，而是：
 *   · 页面/画布背景 `bg-bg`，档位卡片 `bg-elev1`，作品卡 `bg-elev2`，边框统一 `border-border`，
 *     圆角统一 `rounded-xl`（档位卡）/ `rounded-lg`（作品卡），hover 统一 `hover:border-accent`；
 *   · 等级标签沿用用户选的**颜色**（那是数据），但样式改回应用规范：`rounded-lg` + 规范内边距/字号，
 *     不再自己加渐变高光与投影；
 *   · 工具条按钮全部走 `@/components/ui` 的 `Button` / `IconButton` / `Badge`（见 RankingEditor）。
 * 表格自己的背景色与标签色**只影响导出图**（导出仍是白纸 + 用户配色），这里不再用它们画界面。
 */

/** 画布内边距、档位卡之间的间距、标签与作品行之间的间距、卡片间距 */
const BOARD_PAD = 8
const BOARD_GAP = 8
const LABEL_GAP = 12
const CARD_GAP = 8
/** 档位卡自己的内边距（p-1.5 = 6px）+ 边框，行高与几何计算都要用它 */
const ROW_PAD = 7
/** 作品行自己的内边距（插入竖线的定位与几何计算都要用） */
const WORKS_PAD = 4
/** 标签在横向滚动时要停在离左边缘这么远的地方（画布内边距 + 档位卡内边距） */
const LABEL_STICK_LEFT = BOARD_PAD + 6
/** 分界线命中带的半高：上下各 12px（总宽 24px，比视觉上的 8px 缝宽得多） */
const BAND_HALF = 12
/** 行命中矩形的上下外扩，避免落在行与行之间的缝里"谁都不算" */
const ROW_HIT_PAD = 6
/** 骑缝条上下各留的空白（卡片在条里垂直居中 → 中心正好落在两档的分界线上） */
const STRIP_PAD = 8
/** 封面高度上下限：下限保证"卡片可读"，上限避免档少时封面大到离谱 */
const COVER_MIN = 44
const COVER_MAX = 96
/** 名字区高度：两行（含间距）与一行 */
const TEXT_TWO_LINE = 30
const TEXT_ONE_LINE = 17
/** 两行名字至少要能给封面留出这么高，否则退回一行（74px ≈ 应用列表条目封面的高度） */
const TWO_LINE_MIN_COVER = 74

/** 当前悬停的落点：哪个槽位 + 插到哪张卡前面（null = 追加到该槽末尾）+ 插入位下标（画竖线用） */
export interface DropTarget extends RankingSlot {
  anchorId: string | null
  insertIndex: number
}

/** 一屏排版算出来的尺寸（见文件头 B） */
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
  /** 骑缝条的高度（没有骑缝时是 0） */
  stripH: number
  /** 内容总高：超过可用高度时画布纵向滚动（宁可滚动，也不让两行互相叠） */
  contentH: number
  /** 有骑缝的分界线数量 */
  straddleCount: number
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/**
 * 按「可用高度 + 档数 + 有几条骑缝」反算排版。
 *
 * 关键点（用户这轮报的遮挡 bug 的根因就在这里）：
 *   · 有骑缝的分界线要在两档之间插一条**独立的高带**（高度 = 卡片高 + 上下留白），
 *     这条带会占掉高度，而带高又取决于卡片高 → 所以这里迭代几轮求不动点（收敛很快）；
 *   · `rowH` 必须**装得下整张卡片**（`cardH + 2×ROW_PAD`）。装不下时不让卡片溢出到下一行，
 *     而是把画布内容撑高、由画布自己纵向滚动 —— 这保证任何情况下两行都不会互相压。
 */
export function layoutFor(tiers: TierDef[], availH: number, straddleCount = 0): BoardLayout {
  const count = Math.max(1, tiers.length)
  const straddles = Math.max(0, Math.min(count - 1, straddleCount))
  // 名字几行只按"不考虑骑缝"的基础行高判断：否则它在迭代里来回翻，排版会抖
  const baseRow = (availH - BOARD_PAD * 2 - BOARD_GAP * Math.max(0, count - 1)) / count
  const baseCardAvail = Math.max(COVER_MIN + TEXT_ONE_LINE + WORK_CARD_CHROME, Math.floor(baseRow - ROW_PAD * 2))
  const lines: 1 | 2 = baseCardAvail - TEXT_TWO_LINE - WORK_CARD_CHROME >= TWO_LINE_MIN_COVER ? 2 : 1
  const textH = lines === 2 ? TEXT_TWO_LINE : TEXT_ONE_LINE

  let stripH = 0
  let rowH = baseRow
  let cardH = 0
  let coverH = COVER_MIN
  for (let pass = 0; pass < 4; pass += 1) {
    const gaps = BOARD_GAP * Math.max(0, count - 1 - straddles) + stripH * straddles
    const usable = Math.max(COVER_MIN + TEXT_ONE_LINE + WORK_CARD_CHROME + ROW_PAD * 2, availH - BOARD_PAD * 2 - gaps)
    const wanted = usable / count
    const cardAvail = Math.max(COVER_MIN + TEXT_ONE_LINE + WORK_CARD_CHROME, Math.floor(wanted - ROW_PAD * 2))
    coverH = clamp(cardAvail - textH - WORK_CARD_CHROME, COVER_MIN, COVER_MAX)
    cardH = coverH + textH + WORK_CARD_CHROME
    // 行高至少装得下整张卡片（否则行与行会互相压）
    rowH = Math.max(wanted, cardH + ROW_PAD * 2)
    const nextStrip = straddles > 0 ? cardH + STRIP_PAD * 2 : 0
    if (Math.abs(nextStrip - stripH) < 0.5) {
      stripH = nextStrip
      break
    }
    stripH = nextStrip
  }
  if (straddles === 0) stripH = 0

  const font = clamp(Math.round(coverH / 8), 9, 12)
  const coverW = Math.round(coverH * 0.72)
  // 标签列：按最长标签名定宽，保证「人上人」这种三字标签不会挤成两行竖排
  const maxLen = tiers.reduce((n, t) => Math.max(n, t.name.length), 1)
  const labelFont = clamp(Math.round(coverH * 0.26), 12, 20)
  const labelW = clamp(Math.round(maxLen * labelFont * 0.95) + 22, 54, 160)
  const contentH =
    count * rowH + (straddles > 0 ? straddles * stripH : 0) + BOARD_GAP * Math.max(0, count - 1 - straddles)
  return {
    rowH,
    cardH,
    coverH,
    coverW,
    lines,
    font,
    labelW,
    labelFont,
    stripH,
    contentH,
    straddleCount: straddles
  }
}

export interface TierBoardProps {
  table: RankingTable
  draggingWorkId: string | null
  dropTarget: DropTarget | null
  onHover: (target: DropTarget | null) => void
  onDropWork: (slot: RankingSlot, anchorId: string | null) => void
  onDragStartWork: (workId: string) => void
  onDragEnd: () => void
  onItemContextMenu: (e: React.MouseEvent, item: RankedItem) => void
  /** 右键等级标签（改标签内容 / 颜色都由调用方弹菜单） */
  onTierContextMenu: (e: React.MouseEvent, tierIndex: number) => void
  /** 正在改哪一档的颜色（null = 没开色板） */
  colorPickTier: number | null
  onToggleColorPick: (tierIndex: number) => void
  onPickColor: (tierIndex: number, color: string) => void
}

export function TierBoard({
  table,
  draggingWorkId,
  dropTarget,
  onHover,
  onDropWork,
  onDragStartWork,
  onDragEnd,
  onItemContextMenu,
  onTierContextMenu,
  colorPickTier,
  onToggleColorPick,
  onPickColor
}: TierBoardProps) {
  const dragging = draggingWorkId !== null
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 每一档的行元素（投放判定要按它们的矩形算，见文件头 A①） */
  const rowRefs = useRef(new Map<number, HTMLDivElement>())
  /** 骑缝条元素：整条带都是骑缝落点 */
  const stripRefs = useRef(new Map<number, HTMLDivElement>())
  const [box, setBox] = useState({ h: 0, w: 0 })
  // wheel 监听里要读最新的拖拽状态，但不想因为 dragging 变化重建监听
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
   * 纵向滚轮 → 横向滚动。
   *
   * 为什么不用 React 的 onWheel：React 在根容器上注册的 wheel 监听是 **passive** 的，
   * 在里面调 preventDefault() 不生效（页面会同时上下滚）。所以这里用原生监听 + `{ passive: false }`。
   * 拖拽中直接返回：用户明确要求不能在拖拽时滚动（落点会跑）。
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (draggingRef.current) return
      // 已经是横向滚动（触摸板横划 / Shift+滚轮）就不插手
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

  // 首帧还没量到尺寸：先按一个保守值排（避免先画出一屏超大卡片再跳变）
  const avail = box.h > 0 ? box.h : 620
  // 哪些分界线上真的放了骑缝作品：它们要在两档之间插一条独立的骑缝条（会占高度，所以先算出来）
  const straddleCount = useMemo(() => {
    let n = 0
    for (let i = 0; i < table.tiers.length - 1; i += 1) {
      if (straddleItemsAt(table.items, i).length > 0) n += 1
    }
    return n
  }, [table.items, table.tiers.length])
  const layout = layoutFor(table.tiers, avail, straddleCount)
  const metrics: WorkCardMetrics = {
    w: layout.coverW,
    h: layout.coverH,
    lines: layout.lines,
    font: layout.font
  }
  const cardW = layout.coverW + WORK_CARD_CHROME
  const step = cardW + CARD_GAP
  /**
   * 整块画布的几何（档位行、骑缝条、每张卡片的矩形）全部来自 store 的 boardGeometry：
   * 渲染用它的坐标，自测里"任意两张卡片不相交"也是断言同一组数字 —— 两侧不可能对不上。
   */
  const geometry = boardGeometry(table, {
    rowH: layout.rowH,
    rowGap: BOARD_GAP,
    stripH: layout.stripH,
    cardW,
    cardH: layout.cardH,
    cardGap: CARD_GAP,
    labelW: layout.labelW,
    labelGap: LABEL_GAP,
    rowPad: ROW_PAD,
    worksPad: WORKS_PAD
  })
  const contentW = geometry.contentW
  const overflowX = box.w > 0 && contentW + BOARD_PAD * 2 > box.w + 1

  /** 骑缝条里每条带要渲染哪几条作品（按 geometry 的卡片顺序取，保证与坐标一致） */
  const straddleItemsOf = (tierIndex: number): RankedItem[] => straddleItemsAt(table.items, tierIndex)

  /**
   * 按坐标算落点（见文件头 A）。
   * 每帧现算矩形：行数最多 10，成本可以忽略，但换来的是"永远和当前滚动/布局一致"。
   */
  function hitTest(clientX: number, clientY: number): DropTarget | null {
    const rects: { index: number; rect: DOMRect }[] = []
    rowRefs.current.forEach((el, index) => {
      const rect = el.getBoundingClientRect()
      if (rect.height > 0) rects.push({ index, rect })
    })
    if (rects.length === 0) return null
    rects.sort((a, b) => a.index - b.index)

    // ① 骑缝条：**整条带**都算命中（带里只有骑缝卡片，所以不会误判到别的档）
    for (const [index, el] of stripRefs.current) {
      const rect = el.getBoundingClientRect()
      if (rect.height <= 0) continue
      if (clientY >= rect.top - ROW_HIT_PAD && clientY <= rect.bottom + ROW_HIT_PAD && clientX >= rect.left) {
        return { tierIndex: index, straddle: true, anchorId: null, insertIndex: 0 }
      }
    }

    // ② 没有骑缝条的分界线：中线上下各 BAND_HALF 算骑缝（比视觉上的 8px 缝宽得多）
    for (let i = 0; i < rects.length - 1; i += 1) {
      const lineY = (rects[i].rect.bottom + rects[i + 1].rect.top) / 2
      if (Math.abs(clientY - lineY) <= BAND_HALF && clientX >= rects[i].rect.left) {
        return { tierIndex: rects[i].index, straddle: true, anchorId: null, insertIndex: 0 }
      }
    }

    // ③ 整行（外扩 ROW_HIT_PAD）；都没命中就取纵向最近的一行，绝不出现"哪儿都不是"
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

    // ④ 行内按 x 找最近的插入位（卡片下标取 geometry 里的顺序，与渲染完全一致）
    const worksEl = rowRefs.current.get(hit.index)?.querySelector('[data-ranking-works]')
    const worksLeft = worksEl instanceof Element ? worksEl.getBoundingClientRect().left : hit.rect.left
    const seated = geometry.blocks.find((b) => b.kind === 'row' && b.tierIndex === hit.index)?.cards ?? []
    const raw = Math.round((clientX - worksLeft) / step)
    const insertIndex = Math.max(0, Math.min(seated.length, Number.isFinite(raw) ? raw : 0))
    const anchorId = insertIndex < seated.length ? seated[insertIndex].workId : null
    return { tierIndex: hit.index, straddle: false, anchorId, insertIndex }
  }

  /** 同一个落点不要反复 setState（dragover 每秒几十次，白重渲染一整个画布） */
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
      cur.anchorId === next.anchorId &&
      cur.insertIndex === next.insertIndex
    ) {
      return
    }
    onHover(next)
  }

  return (
    <div
      ref={scrollRef}
      data-ranking-board=""
      // 拖拽中禁用滚动（见文件头 A⑤）：Chromium 靠近边缘会自动滚，落点会跑
      style={{ overflow: dragging ? 'hidden' : 'auto' }}
      className="relative h-full bg-bg"
      // 点画布别处就收起色板（色板挂在标签旁边，点空处不关会一直浮着）
      onMouseDown={(e) => {
        if (colorPickTier === null) return
        const target = e.target as HTMLElement | null
        if (!target?.closest('[data-tier-color-ui]')) onToggleColorPick(colorPickTier)
      }}
      // 投放判定只在容器上做（见文件头 A④）：任何落在这里的 dragover 都被接受
      onDragOver={(e) => {
        if (!dragging) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        hoverIfChanged(hitTest(e.clientX, e.clientY))
      }}
      onDrop={(e) => {
        if (!dragging) return
        e.preventDefault()
        const hit = hitTest(e.clientX, e.clientY)
        hoverIfChanged(null)
        if (!hit) return
        onDropWork({ tierIndex: hit.tierIndex, straddle: hit.straddle }, hit.anchorId)
      }}
    >
      {/* 整张表还空着时的下一步提示：占位但不挡拖拽（pointer-events-none） */}
      {table.items.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
          <div className="rounded-xl border border-dashed border-border bg-elev1/90 px-5 py-4 text-center">
            <div className="text-sm font-semibold">把作品拖到这里排名</div>
            <div className="mt-1 text-xs leading-relaxed text-faint">
              从左侧作品池把卡片拖进任意一档；拖到两档的分界线上会「骑缝」——落在两档之间那条骑缝带上，
              封面居中、同时计入上下两档。
            </div>
          </div>
        </div>
      ) : null}

      <div className="relative p-2" style={{ width: contentW + BOARD_PAD * 2 }}>
        {geometry.blocks.map((block) => {
          if (block.kind === 'strip') {
            const items = straddleItemsOf(block.tierIndex)
            const hitHover = dropTarget ? dropTarget.tierIndex === block.tierIndex && dropTarget.straddle : false
            return (
              <div
                key={`strip-${block.tierIndex}`}
                ref={(el) => {
                  if (el) stripRefs.current.set(block.tierIndex, el)
                  else stripRefs.current.delete(block.tierIndex)
                }}
                data-ranking-straddle-row={block.tierIndex}
                title="骑缝带：这里的作品同时计入上下两档"
                style={{
                  height: block.height,
                  marginTop: block.marginTop,
                  paddingLeft: geometry.worksLeftInset + block.bandLeft
                }}
                className={`flex w-max items-center gap-2 rounded-xl border border-dashed transition-colors ${
                  hitHover ? 'border-accent bg-accent-soft/40' : 'border-border/70 bg-elev1/40'
                }`}
              >
                {items.map((item) => (
                  <WorkCard
                    key={item.work.id}
                    work={item.work}
                    size={metrics}
                    draggable
                    dragging={draggingWorkId === item.work.id}
                    highlight={hitHover}
                    cornerBadge={<Badge tone="warn">骑缝</Badge>}
                    onDragStart={onDragStartWork}
                    onDragEnd={onDragEnd}
                    onContextMenu={(e) => onItemContextMenu(e, item)}
                    extraTitle="骑缝：同时计入上下两档 · 右键可移出排名区"
                  />
                ))}
                {hitHover ? (
                  <Badge tone="accent" className="ml-1">
                    <GripVertical size={11} />{' '}
                    {`骑缝：同时计入「${table.tiers[block.tierIndex]?.name}」和「${
                      table.tiers[block.tierIndex + 1]?.name ?? ''
                    }」`}
                  </Badge>
                ) : null}
              </div>
            )
          }

          const tierIndex = block.tierIndex
          const tier = table.tiers[tierIndex]
          const hasStrip = straddleItemsOf(tierIndex).length > 0
          const rowHover = dropTarget ? dropTarget.tierIndex === tierIndex && !dropTarget.straddle : false
          const hitHover = dropTarget ? dropTarget.tierIndex === tierIndex && dropTarget.straddle : false
          const insertX = rowHover && dropTarget ? dropTarget.insertIndex * step - CARD_GAP / 2 : null

          return (
            <div
              key={`row-${tierIndex}`}
              ref={(el) => {
                if (el) rowRefs.current.set(tierIndex, el)
                else rowRefs.current.delete(tierIndex)
              }}
              // 行元素带上档位序号：投放判定按它的矩形算，自动化测试也靠它定位（见文件头 A①）
              data-ranking-tier-row={tierIndex}
              className="relative"
              style={{ height: block.height, marginTop: block.marginTop }}
            >
              {/* 一档一张卡片：应用里的分区卡片写法（rounded-xl + border-border + bg-elev1） */}
              <div
                className={`group flex h-full w-max items-stretch gap-3 rounded-xl border bg-elev1 p-1.5 transition-colors ${
                  rowHover ? 'border-accent bg-accent-soft/40' : 'border-border'
                }`}
              >
                {/* 等级标签：沿用用户选的颜色（数据），样式回归应用规范；横滑时钉在左侧 */}
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
                      // 靠下两档的色板往上展开：画布是滚动容器，往下弹可能被视口裁掉
                      align={tierIndex >= table.tiers.length - 2 ? 'bottom' : 'top'}
                      onPick={(c) => {
                        onPickColor(tierIndex, c)
                        onToggleColorPick(tierIndex)
                      }}
                    />
                  ) : null}
                </div>

                {/* 这一档的作品行：只有一行、不换行；放不下靠横向滚动看。
                    垂直方向**不加内边距**、只用 items-center 居中：这样卡片位置与 boardGeometry 的
                    `top = 行顶 + (行高 - 卡高)/2` 完全一致（差一个像素都可能让"不相交"的断言失真） */}
                <div
                  data-ranking-works=""
                  className="relative flex shrink-0 items-center gap-2 rounded-lg px-1"
                  style={{ minHeight: layout.cardH }}
                >
                  {block.cards.map((box) => {
                    const item = seatedItemsOfTier(table.items, tierIndex).find((it) => it.work.id === box.workId)
                    if (!item) return null
                    return (
                      <WorkCard
                        key={box.workId}
                        work={item.work}
                        size={metrics}
                        draggable
                        dragging={draggingWorkId === item.work.id}
                        onDragStart={onDragStartWork}
                        onDragEnd={onDragEnd}
                        onContextMenu={(e) => onItemContextMenu(e, item)}
                        extraTitle="拖动可换档或调顺序 · 右键可移出排名区"
                      />
                    )
                  })}
                  {/* 插入位置竖线：拖到这里松手就插在这个位置（见文件头 A 的视觉反馈） */}
                  {insertX !== null ? (
                    <span
                      className="pointer-events-none absolute top-0 h-full w-0.5 rounded-full bg-accent ring-2 ring-accent/20"
                      style={{ left: WORKS_PAD + insertX }}
                    />
                  ) : null}
                  {/* 空档提示做成绝对定位：不能撑宽这一行（这一行的宽度会算进导出宽度） */}
                  {block.cards.length === 0 && !rowHover ? (
                    <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-1 whitespace-nowrap text-[11px] text-faint">
                      <GripVertical size={11} />
                      {table.items.length === 0 ? '从左侧作品池拖作品进来' : '这一档还没有作品'}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* 没有骑缝条的分界线：画一条细线 + 命中时的提示（骑缝带本身会充当这个提示） */}
              {tierIndex < table.tiers.length - 1 && !hasStrip ? (
                <div
                  className="pointer-events-none absolute left-0 right-0"
                  style={{ bottom: -BOARD_GAP / 2 }}
                  title="丢在这里 = 骑缝：同时计入上下两档"
                >
                  <div
                    className={`absolute left-0 right-0 -translate-y-1/2 ${
                      hitHover
                        ? 'border-t-2 border-accent'
                        : dragging
                          ? 'border-t border-dashed border-accent/70'
                          : 'border-t border-border'
                    }`}
                    style={{ left: geometry.worksLeftInset }}
                  />
                  {hitHover ? (
                    <span className="absolute" style={{ left: geometry.worksLeftInset + 8 }}>
                      <Badge tone="accent">
                        <GripVertical size={11} />{' '}
                        {`骑缝：同时计入「${tier.name}」和「${table.tiers[tierIndex + 1]?.name ?? ''}」`}
                      </Badge>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {/* 横向还有内容时的提示（每一档只有一行，超出部分要横滑才看得到） */}
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
 * 标签配色板。
 *
 * 挂在标签旁边的小弹层（属于"菜单"这一类的临时浮层），所以这里用固定的浅色底：
 * 它像右键菜单一样浮在内容之上，配色跟随主题的弹层（`bg-elev1` / `border-border`）即可，
 * 色点本身才是被选的内容。
 */
function ColorPicker({
  color,
  align,
  onPick
}: {
  color: string
  /** 往上还是往下展开（见 TierBoard 里的说明） */
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

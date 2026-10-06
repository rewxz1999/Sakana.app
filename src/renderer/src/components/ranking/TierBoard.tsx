import { useEffect, useRef, useState } from 'react'
import { Palette } from 'lucide-react'
import { WorkCard, type WorkCardMetrics } from '@/components/ranking/WorkCard'
import {
  TIER_COLOR_PRESETS,
  readableTextOn,
  seatedItemsOfTier,
  straddleItemsAt,
  type RankedItem,
  type RankingSlot,
  type RankingTable,
  type TierDef
} from '@/stores/rankingTable'

/**
 * 排名区（画布）：左边一列**带颜色的**等级标签，右边是放作品的地方。
 *
 * ============================ 两条用户明确要求的设计（改之前先看这段） ============================
 *
 * ① **骑缝 = 中心挂在分界线上 + 上下两档各占一位**（不再有"两档之间的独立区域"）。
 *    实现分两步：
 *      · 视觉：骑缝卡片放在一条**高度为 0 的绝对定位带**里（`bottom: -cardH/2`），
 *        于是它的竖直中心恰好落在两档的分界线上 —— 看起来就是"骑在缝上"；
 *      · 语义占位：分界线上下的**两档都在自己行首留出同宽的空白**（`spacer`），
 *        所以"它在上档占了一个位置、在下档也占了一个位置"在版面上是看得见的。
 *    落点靠一条 18px 高的**分界线命中带**（比视觉上的 6px 缝宽得多）：用户要求"容易命中"。
 *
 * ② **一屏放下所有档**（用户要求「不要滚动才能看完」），最多 10 档。
 *    卡片尺寸不是写死的，而是**按可用高度反算**（layoutFor）：先由档数算出每档行高，
 *    再把行高拆成"封面 + 名字 + 来源角标"，装不下就依次牺牲角标、行数、字号。
 *    所以 5 档时卡片明显更大、10 档时自动压成小尺寸，两种情况下都刚好铺满一屏。
 *
 * 配色用**这张表自己的标签颜色**（不跟随应用主题）：画布就是导出图的预览，
 * 两边必须是同一套色值，否则用户在深色主题下排好、导出却是另一张图。
 */

/** 画布内边距、档间距、标签与作品区之间的间距、卡片间距 */
const BOARD_PAD = 8
const ROW_GAP = 6
const LABEL_GAP = 10
const CARD_GAP = 8
/** 分界线命中带的高度（用户要求"命中区要有一定宽度"；视觉上的缝只有 ROW_GAP，命中区要明显更大） */
const HIT_H = 18

/** 当前悬停的落点：哪个槽位 + 插到哪张卡前面（null = 追加到该槽末尾） */
export interface DropTarget extends RankingSlot {
  anchorId: string | null
}

/** 一屏排版算出来的尺寸（见文件头 ②） */
interface BoardLayout {
  rowH: number
  cardW: number
  coverH: number
  cardH: number
  lines: 1 | 2
  font: number
  showSource: boolean
  labelW: number
  labelFont: number
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/**
 * 按「可用高度 + 档数」反算排版。
 *
 * 取舍顺序（先牺牲影响小的）：来源角标 → 名字第二行 → 字号 → 封面下限。
 * 这样档少的时候卡片尽量大，档多的时候还能保住"封面 + 名字"这两件用户点名要看的东西。
 */
export function layoutFor(tiers: TierDef[], availH: number): BoardLayout {
  const count = Math.max(1, tiers.length)
  const usable = Math.max(140, availH - BOARD_PAD * 2 - ROW_GAP * Math.max(0, count - 1))
  const rowH = usable / count
  // 行高里留 6px 给行内上下留白，剩下才是卡片的可用高度。
  // 下限取 24 而不是 40：窗口被拉得极小时宁可把卡片压成小图，也不让最后一档被裁掉（画布是 overflow-hidden 的）。
  const cardH = Math.max(24, Math.floor(rowH - 6))
  let showSource = cardH >= 78
  let lines: 1 | 2 = cardH >= 58 ? 2 : 1
  let font = clamp(Math.round(cardH / 6), 9, 12)
  const textH = (): number =>
    Math.round(font * 1.3) * lines + 3 + (showSource ? Math.round(font * 1.1) + 5 : 0)
  let coverH = cardH - textH()
  if (coverH < 34 && showSource) {
    // 高度不够就先砍角标（信息量最小的一行）
    showSource = false
    coverH = cardH - textH()
  }
  if (coverH < 30 && lines === 2) {
    lines = 1
    font = clamp(Math.round(cardH / 5), 9, 12)
    coverH = cardH - textH()
  }
  coverH = Math.max(18, coverH)
  const cardW = clamp(Math.round(coverH * 0.72), 18, 96)
  // 标签列：按最长标签名定宽，保证「人上人」这种三字标签不会挤成两行竖排
  const maxLen = tiers.reduce((n, t) => Math.max(n, t.name.length), 1)
  const labelFont = clamp(Math.round(rowH * 0.3), 10, 20)
  const labelW = clamp(Math.round(maxLen * labelFont * 0.95) + 14, 46, 128)
  return { rowH, cardW, coverH, cardH, lines, font, showSource, labelW, labelFont }
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
  colorPickTier,
  onToggleColorPick,
  onPickColor
}: TierBoardProps) {
  const dragging = draggingWorkId !== null
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [availH, setAvailH] = useState(0)

  // 排名区的高度只能量出来（窗口大小、作品池是否折叠都会变），所以量完再排版（见文件头 ②）
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = (): void => setAvailH(el.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 首帧还没量到高度：先按一个保守值排（避免先画出一屏超大卡片再跳变）
  const layout = layoutFor(table.tiers, availH > 0 ? availH : 620)
  const metrics: WorkCardMetrics = {
    w: layout.cardW,
    h: layout.coverH,
    lines: layout.lines,
    font: layout.font,
    showSource: layout.showSource
  }
  const sameSlot = (a: DropTarget, tierIndex: number, straddle: boolean): boolean =>
    a.tierIndex === tierIndex && a.straddle === straddle

  /** 一个槽位容器的投放属性（档本身 / 分界线命中带） */
  function slotHandlers(slot: RankingSlot) {
    return {
      onDragOver: (e: React.DragEvent): void => {
        if (!dragging) return
        // 只有 preventDefault 过，浏览器才认为这里可以放下
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!dropTarget || !sameSlot(dropTarget, slot.tierIndex, slot.straddle) || dropTarget.anchorId !== null) {
          onHover({ ...slot, anchorId: null })
        }
      },
      onDrop: (e: React.DragEvent): void => {
        if (!dragging) return
        e.preventDefault()
        onDropWork(slot, null)
      }
    }
  }

  /** 一张卡片的投放属性：落在它身上 = 插到它前面 */
  function cardHandlers(item: RankedItem, slot: RankingSlot) {
    const active = dropTarget
      ? sameSlot(dropTarget, slot.tierIndex, slot.straddle) && dropTarget.anchorId === item.work.id
      : false
    return {
      active,
      onDragOver: (e: React.DragEvent<HTMLDivElement>): void => {
        if (!dragging || draggingWorkId === item.work.id) return
        // 阻止冒泡：否则外层容器会把这个更精确的落点覆盖成「追加到末尾」
        e.stopPropagation()
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        onHover({ ...slot, anchorId: item.work.id })
      },
      onDrop: (e: React.DragEvent<HTMLDivElement>): void => {
        if (!dragging) return
        e.stopPropagation()
        e.preventDefault()
        onDropWork(slot, item.work.id)
      }
    }
  }

  /** 骑缝作品在相邻两档里各占掉的列位（保持与卡片同样的宽度，视觉上能与卡片对齐） */
  const reserveWidth = (count: number): number =>
    count > 0 ? count * layout.cardW + (count - 1) * CARD_GAP : 0

  return (
    <div
      ref={boxRef}
      data-ranking-board=""
      className="relative h-full overflow-hidden px-2 py-2 text-[#1b1b1f]"
      style={{ background: table.background }}
      // 点画布别处就收起色板（色板挂在标签旁边，点空处不关会一直浮着）
      onMouseDown={(e) => {
        if (colorPickTier === null) return
        const target = e.target as HTMLElement | null
        if (!target?.closest('[data-tier-color-ui]')) onToggleColorPick(colorPickTier)
      }}
    >
      {/* 整张表还空着时的下一步提示：占位但不挡拖拽（pointer-events-none） */}
      {table.items.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="rounded-xl border border-dashed border-[#c9c9d1] bg-white/85 px-5 py-4 text-center">
            <div className="text-sm font-semibold text-[#1b1b1f]">把作品拖到这里排名</div>
            <div className="mt-1 text-xs leading-relaxed text-[#6b6b73]">
              从左侧作品池把卡片拖进任意档；拖到两档之间的分界线上会「骑缝」——同时计入上下两档。
            </div>
          </div>
        </div>
      ) : null}

      {table.tiers.map((tier, tierIndex) => {
        const seated = seatedItemsOfTier(table.items, tierIndex)
        const straddlersBelow = straddleItemsAt(table.items, tierIndex)
        const straddlersAbove = straddleItemsAt(table.items, tierIndex - 1)
        const rowSlot: RankingSlot = { tierIndex, straddle: false }
        const boundarySlot: RankingSlot = { tierIndex, straddle: true }
        const isLast = tierIndex === table.tiers.length - 1
        const rowHover = dropTarget ? sameSlot(dropTarget, tierIndex, false) && dropTarget.anchorId === null : false
        const hitHover = dropTarget ? sameSlot(dropTarget, tierIndex, true) && dropTarget.anchorId === null : false
        // 这一档要为上边界与下边界上的骑缝作品各留出列位（见文件头 ①）
        const reserved = reserveWidth(straddlersAbove.length + straddlersBelow.length)

        return (
          <div
            key={`tier-${tierIndex}-${tier.name}`}
            className="relative"
            style={{ height: layout.rowH, marginBottom: isLast ? 0 : ROW_GAP }}
          >
            <div className="flex h-full items-stretch" style={{ gap: LABEL_GAP }}>
              {/* 等级标签列（在左侧，用户要求；颜色由用户自定义） */}
              <div
                data-ranking-tier-label={tier.name}
                className="relative flex shrink-0 items-center justify-center rounded-lg border text-center font-extrabold"
                style={{
                  width: layout.labelW,
                  background: tier.color,
                  color: readableTextOn(tier.color),
                  borderColor: 'rgba(0,0,0,0.12)',
                  fontSize: layout.labelFont
                }}
              >
                <span className="px-1 leading-tight break-all">{tier.name}</span>
                <button
                  type="button"
                  data-tier-color-ui=""
                  title="改这一档的颜色"
                  onClick={() => onToggleColorPick(tierIndex)}
                  className={`absolute right-0.5 top-0.5 rounded p-0.5 transition-opacity ${
                    colorPickTier === tierIndex ? 'opacity-100' : 'opacity-0 hover:opacity-100'
                  }`}
                  style={{ color: readableTextOn(tier.color) }}
                >
                  <Palette size={11} />
                </button>
                {colorPickTier === tierIndex ? (
                  <ColorPicker
                    color={tier.color}
                    // 靠下两档的色板往上展开：画布是 overflow-hidden 的，往下弹会被裁掉
                    align={tierIndex >= table.tiers.length - 2 ? 'bottom' : 'top'}
                    onPick={(c) => {
                      onPickColor(tierIndex, c)
                      onToggleColorPick(tierIndex)
                    }}
                  />
                ) : null}
              </div>

              {/* 这一档本身的作品格 */}
              <div
                {...slotHandlers(rowSlot)}
                className={`flex min-w-0 flex-1 flex-wrap content-start items-start rounded-lg border transition-colors ${
                  rowHover ? 'border-dashed border-accent bg-accent/10' : 'border-transparent bg-[#fafafa]'
                }`}
                style={{ gap: CARD_GAP, padding: 4 }}
              >
                {reserved > 0 ? <span aria-hidden style={{ width: reserved, height: layout.cardH }} /> : null}
                {seated.length === 0 && reserved === 0 ? (
                  <span className="self-center pl-1 text-[11px] text-[#a9a9b2]">
                    {table.items.length === 0 ? '从左侧作品池拖作品进来' : '这一档还没有作品'}
                  </span>
                ) : (
                  seated.map((item) => {
                    const h = cardHandlers(item, rowSlot)
                    return (
                      <div
                        key={item.work.id}
                        className={`rounded-md ${h.active ? 'ring-2 ring-accent ring-offset-1' : ''}`}
                      >
                        <WorkCard
                          work={item.work}
                          size={metrics}
                          draggable
                          dragging={draggingWorkId === item.work.id}
                          onDragStart={onDragStartWork}
                          onDragEnd={onDragEnd}
                          onDragOver={h.onDragOver}
                          onDrop={h.onDrop}
                          onContextMenu={(e) => onItemContextMenu(e, item)}
                          extraTitle="拖动可换档或调顺序 · 右键可移出排名区"
                        />
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            {/* 分界线：命中带（比视觉上的缝宽，见文件头 ①）+ 骑缝卡片 */}
            {!isLast ? (
              <>
                <div
                  {...slotHandlers(boundarySlot)}
                  title="丢在这里 = 骑缝：同时计入上下两档"
                  style={{ left: layout.labelW + LABEL_GAP, right: 0, height: HIT_H, bottom: -HIT_H / 2 }}
                  className={`absolute z-20 transition-colors ${dragging ? 'pointer-events-auto' : 'pointer-events-none'}`}
                >
                  <div
                    className={`absolute left-0 right-0 top-1/2 -translate-y-1/2 ${
                      hitHover
                        ? 'border-t-2 border-accent'
                        : dragging
                          ? 'border-t border-dashed border-accent/70'
                          : 'border-t border-[#e8e8ec]'
                    }`}
                  />
                  {hitHover ? (
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-white">
                      骑缝：同时计入「{tier.name}」和「{table.tiers[tierIndex + 1]?.name}」
                    </span>
                  ) : null}
                </div>

                {straddlersBelow.length > 0 ? (
                  <div
                    style={{
                      left: layout.labelW + LABEL_GAP,
                      right: 0,
                      height: layout.cardH,
                      bottom: -layout.cardH / 2,
                      gap: CARD_GAP
                    }}
                    className="pointer-events-none absolute z-30 flex flex-nowrap items-start"
                  >
                    {straddlersBelow.map((item) => {
                      const h = cardHandlers(item, boundarySlot)
                      return (
                        <div
                          key={item.work.id}
                          className={`pointer-events-auto rounded-md ${h.active ? 'ring-2 ring-accent' : ''}`}
                          title="骑缝：同时计入上下两档 · 右键可移出排名区"
                        >
                          <WorkCard
                            work={item.work}
                            size={metrics}
                            draggable
                            dragging={draggingWorkId === item.work.id}
                            onDragStart={onDragStartWork}
                            onDragEnd={onDragEnd}
                            onDragOver={h.onDragOver}
                            onDrop={h.onDrop}
                            onContextMenu={(e) => onItemContextMenu(e, item)}
                            extraTitle="骑缝：同时计入上下两档 · 右键可移出排名区"
                          />
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 标签配色板。
 *
 * 固定用浅色（白底深字）而不是应用主题色：画布本身是白纸 + 用户自选标签色，
 * 一个跟随深色主题的黑底弹窗浮在白纸上会非常突兀，也看不清色点。
 * 除了预设色点，另给一个系统取色器（`<input type="color">`）兜住"我就想要某个特定色"的情况。
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
      className="absolute left-full z-40 ml-1 w-[176px] rounded-lg border border-[#d8d8de] bg-white p-2 shadow-xl"
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="mb-1 text-[10px] text-[#6b6b73]">标签颜色</div>
      <div className="grid grid-cols-5 gap-1">
        {TIER_COLOR_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => onPick(c)}
            className={`h-6 w-6 rounded-md border transition-transform hover:scale-110 ${
              c.toLowerCase() === color.toLowerCase()
                ? 'border-[#1b1b1f] ring-2 ring-[#1b1b1f]/30'
                : 'border-[#d8d8de]'
            }`}
            style={{ background: c }}
          />
        ))}
      </div>
      <label className="mt-2 flex items-center gap-2 text-[10px] text-[#6b6b73]">
        自定义
        <input
          type="color"
          value={color}
          onChange={(e) => onPick(e.target.value)}
          className="h-6 w-10 cursor-pointer rounded border border-[#d8d8de] bg-white p-0"
        />
      </label>
    </div>
  )
}

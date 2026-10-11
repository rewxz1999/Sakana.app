import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { RecommendPage } from '@/stores/recommendTable'
import { frameOf } from './styles'
import { RecommendPageCard } from './RecommendPageCard'

/**
 * 把页面**等比缩放**到容器里（宽高都放得下 → 整页永远完整可见、不出现滚动条）。
 *
 * ⚠️ 量的必须是**容器**（`viewRef`），不能是承载缩放结果的那层：
 * 后者的尺寸是按缩放比写上去的，量它等于拿结果当输入，会自激（越缩越小或根本不缩）。
 *
 * 缩放只影响屏幕呈现：导出用的是同一份版式、由主进程按倍率放大像素，不受这里的 scale 影响。
 * 页面尺寸会随背景/占比/手填尺寸变（`frameOf`），所以那些一变就再量一次。
 *
 * ## 为什么把 `overlay` 做成"接收 scale 的函数"（v0.3.9）
 *
 * 编辑模式的拖动叠层画在页面坐标系里（跟着 `transform: scale()` 一起缩），
 * 但指针位移是**屏幕像素**：叠层要把位移除以这里算出来的 scale 才能换成页面坐标。
 * 于是把 scale 交给调用方，而不是让它自己去猜/再量一次（再量一次就是第二份真相）。
 *
 * 这个组件从 `RecommendPageCard.tsx` 里拆出来放到单独的文件，是因为两者都是本工具的核心
 * 组件、各自又要保持可读；拆开之后"缩放测量"这件事只有一个文件负责。
 */
export function FittedRecommendCard({
  className = '',
  overlay,
  ...props
}: {
  page: RecommendPage
  pageNo: number
  pageCount: number
  tableName: string
  recommender: string
  className?: string
  onContextMenu?: (e: ReactMouseEvent) => void
  /** 编辑模式的叠层（按当前缩放比渲染） */
  overlay?: (scale: number) => ReactNode
}) {
  const viewRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [boxW, setBoxW] = useState(0)
  const [boxH, setBoxH] = useState(0)
  const [cardH, setCardH] = useState(0)

  useEffect(() => {
    const view = viewRef.current
    const card = cardRef.current
    if (!view || !card) return
    const measure = (): void => {
      setBoxW(view.clientWidth)
      setBoxH(view.clientHeight)
      setCardH(card.offsetHeight)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(view)
    ro.observe(card)
    measure()
    return () => ro.disconnect()
  }, [])

  /*
   * 换背景 / 占比 / 手填尺寸 / 改模块坐标都会改页面高度（或模块矩形），
   * 显式再量一次，别等下一帧 —— 否则用户拖完模块会看到卡片尺寸慢半拍。
   */
  useEffect(() => {
    const card = cardRef.current
    if (card) setCardH(card.offsetHeight)
  }, [
    props.page.background,
    props.page.layout,
    props.page.size,
    props.page.bandRatio,
    props.page.contentGradient,
    props.page.cover,
    props.page.photos
  ])

  // 页面宽度也是可变的（手填尺寸），所以缩放比按**实际页面宽**算，不再固定用 RL.width。
  // 宽度取自 frameOf（与卡片内部用的是同一个函数/同一个优先级），不自己再判一次 size。
  const cardW = frameOf(props.page).width
  const widthScale = boxW > 0 ? boxW / cardW : 0
  const heightScale = boxH > 0 && cardH > 0 ? boxH / cardH : 1
  const scale = Math.min(1, widthScale, heightScale)
  const ready = boxW > 0 && cardH > 0

  return (
    <div
      ref={viewRef}
      className={className}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
    >
      <div
        style={{
          width: ready ? cardW * scale : 0,
          height: ready ? cardH * scale : 0,
          flex: '0 0 auto',
          visibility: ready ? 'visible' : 'hidden'
        }}
      >
        <div ref={cardRef} style={{ width: cardW, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <RecommendPageCard {...props} overlay={overlay ? overlay(scale) : undefined} />
        </div>
      </div>
    </div>
  )
}

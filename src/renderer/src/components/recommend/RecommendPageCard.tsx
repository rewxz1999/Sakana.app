import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { ModuleKind, ModuleLayout, ModuleRect, RecommendPage } from '@/stores/recommendTable'
import { MAX_PHOTOS, MODULE_KINDS, renderModules } from '@/stores/recommendTable'
import { CoverImage } from '@/components/CoverImage'
import { localImgUrl } from '@/lib/format'
import {
  RL,
  airDateText,
  asReactStyle,
  blend,
  blendStyle,
  chipStyle,
  dimTextStyle,
  displayName,
  emptyHintStyle,
  footRowStyle,
  frameOf,
  genreChips,
  imageBandImageStyle,
  imageBandWrapStyle,
  infoLabelStyle,
  infoRowStyle,
  infoValueStyle,
  levelParts,
  moduleBoxStyle,
  moduleInnerStyle,
  moduleRectsOf,
  pageBackgroundCss,
  pageNoText,
  pageStyle,
  photoBoxStyle,
  photoCellSize,
  photoRowStyle,
  reasonTextStyle,
  recTextStyle,
  scoreText,
  scoreTextStyle,
  secTitleStyle,
  starStyle,
  subName,
  subTextStyle,
  titleTextStyle
} from './styles'

/**
 * 推荐页的**界面渲染**（屏幕上看到的那一页）。
 *
 * 与 `exportHtml.ts` 是同一页的两套渲染器：结构逐层对应，样式与**几何全部来自 `styles.ts`**。
 *
 * ## 位置从哪来（v0.3.8 第三轮：取消了自定义移动）
 *
 * 模块位置**不由数据决定**，而是每次现算：`moduleRectsOf(frameOf(page))`。
 * 界面与导出调的是同一个函数、同一份常量，所以两边不可能不一致 ——
 * 上一版那套"用户拖动坐标 + 两份渲染各自读坐标"已经整条撤掉（拖不动，也就不会错位）。
 *
 * ## 页面结构（从下到上）
 *
 *   1. 页面底色（纯色 / 渐变，或图片背景时的白）；
 *   2. 图区里的图片层（只有设了图片背景）：`cover` 裁剪、可模糊；
 *   3. 交融渐变：贴在图区靠内容区那一侧，渐隐到底色（没有硬边）；
 *   4. 模块：绝对定位，**没有白底**，文字靠页面继承下来的 `TEXT_SHADOW` 白晕保证可读。
 */
export function RecommendPageCard({
  page,
  pageNo,
  pageCount,
  tableName,
  recommender,
  onContextMenu
}: {
  page: RecommendPage
  pageNo: number
  pageCount: number
  tableName: string
  recommender: string
  onContextMenu?: (e: ReactMouseEvent) => void
}) {
  const frame = useMemo(() => frameOf(page), [page])
  const rects = useMemo(() => moduleRectsOf(frame), [frame])
  /** 要画的模块：**一律走 renderModules**（补全 → 丢掉隐藏的），隐藏的完全不进渲染树 */
  const drawn = useMemo(() => renderModules(page), [page])
  const bgResolve = useCallback((p: string) => `url('${localImgUrl(p)}')`, [])
  const bandWrap = imageBandWrapStyle(frame)

  const renderModule = (m: ModuleLayout, rect: ModuleRect, order: number): React.ReactNode => {
    const inner = (() => {
      switch (m.id) {
        case 'cover':
          return <CoverImage src={page.cover} alt={displayName(page)} className="h-full w-full" rounded="" />
        case 'title': {
          const sub = subName(page)
          const rec = recommender.trim()
          return (
            <>
              <h1 style={asReactStyle(titleTextStyle())}>{displayName(page)}</h1>
              {sub ? <div style={asReactStyle(subTextStyle())}>{sub}</div> : null}
              {rec ? <div style={asReactStyle(recTextStyle())}>推荐人：{rec}</div> : null}
            </>
          )
        }
        case 'ratings':
          return (
            <>
              <InfoRow label="bangumi 评分">
                <span style={asReactStyle(scoreTextStyle())}>{scoreText(page.bgmRating)}</span>
              </InfoRow>
              <InfoRow label="推荐人评分">
                <span style={asReactStyle(scoreTextStyle())}>{scoreText(page.myRating, '未评分')}</span>
              </InfoRow>
            </>
          )
        case 'level':
          return (
            <InfoRow label="推荐指数">
              <Stars level={page.recommendLevel} />
            </InfoRow>
          )
        case 'meta':
          return (
            <>
              <InfoRow label="播出时间">{airDateText(page.airDate)}</InfoRow>
              <InfoRow label="类型标签">
                <Genres genres={page.genres} />
              </InfoRow>
            </>
          )
        case 'reason':
          return (
            <>
              <div style={asReactStyle(secTitleStyle())}>推荐理由</div>
              {page.reason ? (
                <p style={asReactStyle(reasonTextStyle())}>{page.reason}</p>
              ) : (
                <p style={asReactStyle(blend(reasonTextStyle(), emptyHintStyle()))}>还没有写推荐理由</p>
              )}
            </>
          )
        case 'photos': {
          const photos = page.photos.slice(0, MAX_PHOTOS)
          const cell = photoCellSize(rect, frame)
          return (
            <>
              <div style={asReactStyle(secTitleStyle())}>剧照</div>
              <div style={asReactStyle(photoRowStyle())}>
                {photos.length === 0 ? (
                  <span style={asReactStyle(emptyHintStyle())}>还没有剧照</span>
                ) : (
                  photos.map((p) => (
                    <span key={p} style={asReactStyle(photoBoxStyle(cell.w, cell.h))}>
                      <CoverImage src={p} alt="剧照" className="h-full w-full" rounded="" />
                    </span>
                  ))
                )}
              </div>
            </>
          )
        }
        case 'foot':
          return (
            <div style={asReactStyle(footRowStyle())}>
              <span>{tableName}</span>
              <span>{pageNoText(pageNo, pageCount)}</span>
            </div>
          )
        default:
          return null
      }
    })()

    // 模块**没有白板**：内容直接落在页面上（可读性靠页面级的 text-shadow）
    return (
      <div key={m.id} style={asReactStyle(moduleBoxStyle(rect, order))} data-module={m.id}>
        {m.id === 'cover' ? inner : <div style={asReactStyle(moduleInnerStyle(RL.rowGap))}>{inner}</div>}
      </div>
    )
  }

  return (
    <div
      style={asReactStyle({ ...pageStyle(frame), background: pageBackgroundCss(page.background) })}
      onContextMenu={onContextMenu}
    >
      {/* 图区（只有图片背景才有）：外层裁剪，里层图片层可模糊，模糊不会糊出边界 */}
      {bandWrap ? (
        <div style={asReactStyle(bandWrap)}>
          <div style={asReactStyle(imageBandImageStyle(frame, page.background, bgResolve))} />
        </div>
      ) : null}
      {/* 交融渐变：贴着图区靠内容区的那一侧，渐隐到页面底色 */}
      {frame.pos === 'none' ? null : <div style={asReactStyle(blendStyle(frame))} />}

      {/* 模块：按 MODULE_KINDS 的顺序画（顺序即层级，后面的盖前面的） */}
      {drawn.map((m) => renderModule(m, rects[m.id], MODULE_KINDS.indexOf(m.id)))}
    </div>
  )
}

/** 一行信息（标签 + 值） */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={asReactStyle(infoRowStyle())}>
      <span style={asReactStyle(infoLabelStyle())}>{label}</span>
      <span style={asReactStyle(infoValueStyle())}>{children}</span>
    </div>
  )
}

/** 推荐指数星星（字符，不依赖图标字体 —— 导出图那边同理） */
function Stars({ level }: { level: number }) {
  const { on, off } = levelParts(level)
  return (
    <span>
      <span style={asReactStyle(starStyle(true))}>{'★'.repeat(on)}</span>
      <span style={asReactStyle(starStyle(false))}>{'☆'.repeat(off)}</span>
    </span>
  )
}

/** 类型标签胶囊 */
function Genres({ genres }: { genres: string[] }) {
  const chips = genreChips(genres)
  if (chips.list.length === 0) return <span style={asReactStyle(dimTextStyle())}>暂无标签</span>
  return (
    <>
      {chips.list.map((g) => (
        <span key={g} style={asReactStyle(chipStyle(false))}>
          {g}
        </span>
      ))}
      {chips.rest > 0 ? <span style={asReactStyle(chipStyle(true))}>{`+${chips.rest}`}</span> : null}
    </>
  )
}

/**
 * 把页面**等比缩放**到容器里（宽高都放得下 → 整页永远完整可见、不出现滚动条）。
 *
 * ⚠️ 量的必须是**容器**（`viewRef`），不能是承载缩放结果的那层：
 * 后者的尺寸是按缩放比写上去的，量它等于拿结果当输入，会自激（越缩越小或根本不缩）。
 *
 * 缩放只影响屏幕呈现：导出用的是同一份版式、由主进程按倍率放大像素，不受这里的 scale 影响。
 * 页面高度会随背景图的位置与比例变（`frameOf`），所以背景一变就再量一次。
 */
export function FittedRecommendCard({
  className = '',
  ...props
}: {
  page: RecommendPage
  pageNo: number
  pageCount: number
  tableName: string
  recommender: string
  className?: string
  onContextMenu?: (e: ReactMouseEvent) => void
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

  // 换背景（位置 / 比例）会改页面高度，显式再量一次，别等下一帧
  useEffect(() => {
    const card = cardRef.current
    if (card) setCardH(card.offsetHeight)
  }, [props.page.background, props.page.layout, props.page.cover, props.page.photos])

  const widthScale = boxW > 0 ? boxW / RL.width : 0
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
          width: ready ? RL.width * scale : 0,
          height: ready ? cardH * scale : 0,
          flex: '0 0 auto',
          visibility: ready ? 'visible' : 'hidden'
        }}
      >
        <div ref={cardRef} style={{ width: RL.width, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <RecommendPageCard {...props} />
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { RecommendPage } from '@/stores/recommendTable'
import { MAX_PHOTOS } from '@/stores/recommendTable'
import { CoverImage } from '@/components/CoverImage'
import { localImgUrl } from '@/lib/format'
import {
  bodyStyle,
  cardStyleOf,
  chipStyle,
  chipRestStyle,
  coverBoxStyle,
  dimStyle,
  displayName,
  footStyle,
  genreChips,
  headStyle,
  infoLabelStyle,
  infoRowStyle,
  infoValueStyle,
  levelParts,
  pageNoText,
  panelStyleOf,
  photoBoxStyle,
  photoEmptyStyle,
  photoRowStyle,
  reasonStyle,
  recStyle,
  rightStyleOf,
  scoreStyle,
  secTitleStyle,
  starOffStyle,
  starOnStyle,
  subName,
  subTitleStyle,
  titleStyle,
  airDateText,
  scoreText
} from './styles'

/**
 * 推荐卡的**界面渲染**（屏幕上看到的那张卡）。
 *
 * 与 `exportHtml.ts` 是同一张卡的两套渲染器：结构逐层对应、尺寸全部来自 `styles.ts`。
 * 改这里的结构时，那个文件必须同步改（否则「所见即所得」就不成立了）。
 *
 * 分两个导出：
 *   · `RecommendPageCard` —— 按内容算出的版式宽度原尺寸画（不缩放）；
 *   · `FittedRecommendCard` —— 把它**等比缩小**塞进当前容器里，并且**宽高都塞得下**。
 *
 * ## 为什么要缩放而不是"自适应排版"
 *
 * 自适应（比如窄了就把封面改小、标签换行）会让窗口越窄版式越不一样，
 * 用户在小窗口里编辑时看到的就和导出图不是一回事了；等比缩放则永远和导出图同形。
 *
 * ## 缩放比为什么取 min(宽度比, 高度比)（v0.3.7 追加需求 1）
 *
 * 用户要求「整页内容全部展示在窗口里，不需要滚动」。只按宽度缩放时，
 * 一张内容很满的卡（300 字理由 + 5 张剧照）在窗口里仍然比可视区高，就会出滚动条；
 * 所以同时量容器**高度**，取两个比例里更小的那个 —— 保证上下左右都放得下。
 * 缩放的只是**屏幕上的呈现**：导出的 HTML/CSS 用的是 `styles.ts` 里的原始尺寸，
 * 与这里的 scale 完全无关（导出像素 = 版式宽度 × 2/3 倍，见导出弹窗）。
 */

/** 一行信息（标签 + 内容）；与 exportHtml 的 infoRow 对应 */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={infoRowStyle}>
      <span style={infoLabelStyle}>{label}</span>
      <span style={infoValueStyle}>{children}</span>
    </div>
  )
}

/** 推荐指数：亮星 + 暗星（字符，不依赖任何图标字体 —— 导出图那边同理） */
function Stars({ level }: { level: number }) {
  const { on, off } = levelParts(level)
  return (
    <span>
      <span style={starOnStyle}>{'★'.repeat(on)}</span>
      <span style={starOffStyle}>{'☆'.repeat(off)}</span>
    </span>
  )
}

export function RecommendPageCard({
  page,
  /** 这一页在整张表里的页码（1 起） */
  pageNo,
  /** 整张表的页数 */
  pageCount,
  tableName,
  recommender,
  /** 版式宽度（由 cardWidthOf / cardWidthOfAll 算出；导出用的是同一个值） */
  width,
  onContextMenu
}: {
  page: RecommendPage
  pageNo: number
  pageCount: number
  tableName: string
  recommender: string
  width: number
  onContextMenu?: (e: ReactMouseEvent) => void
}) {
  const sub = subName(page)
  const rec = recommender.trim()
  const chips = genreChips(page.genres)
  const photos = page.photos.slice(0, MAX_PHOTOS)
  /*
   * 背景图在**预览**里走 `localImgUrl`（sakana-img 协议，只放行白名单目录内的路径，
   * 而背景图是经 showcase.importImages 复制进应用数据目录的，所以能显示）；
   * 导出那边把同一个函数换成 `{{img:bgN}}` 占位符，构图完全一致（见 styles.backgroundCss）。
   * 单引号与导出那边保持一致（导出是塞进 HTML 属性里的，双引号会截断属性）。
   */
  const bgCss = (p: string): string => `url('${localImgUrl(p)}')`

  return (
    <div style={cardStyleOf(width, page.background, bgCss)} onContextMenu={onContextMenu}>
      {/* 内容板：所有文字画在它上面（没背景时是不透明纯白，与改造前外观一致） */}
      <div style={panelStyleOf(page.background)}>
        <div style={headStyle}>
          <div style={{ minWidth: 0 }}>
            <h1 style={titleStyle}>{displayName(page)}</h1>
            {sub ? <div style={subTitleStyle}>{sub}</div> : null}
            {/*
              推荐人署名放在**标题下方**（用户明确要求的署名位），没填就整行不画 ——
              留一行「推荐人：（空）」会让人以为这行必须在导出前填满。
            */}
            {rec ? <div style={recStyle}>推荐人：{rec}</div> : null}
          </div>
        </div>

        <div style={bodyStyle}>
          <div style={coverBoxStyle}>
            <CoverImage src={page.cover} alt={displayName(page)} className="h-full w-full" rounded="" />
          </div>

          <div style={rightStyleOf(width)}>
            <div>
              <InfoRow label="bangumi 评分">
                <span style={scoreStyle}>{scoreText(page.bgmRating)}</span>
              </InfoRow>
              <InfoRow label="推荐人评分">
                <span style={scoreStyle}>{scoreText(page.myRating, '未评分')}</span>
              </InfoRow>
              <InfoRow label="推荐指数">
                <Stars level={page.recommendLevel} />
              </InfoRow>
              <InfoRow label="播出时间">{airDateText(page.airDate)}</InfoRow>
              <InfoRow label="类型标签">
                {chips.list.length === 0 ? (
                  <span style={dimStyle}>暂无标签</span>
                ) : (
                  <>
                    {chips.list.map((g) => (
                      <span key={g} style={chipStyle()}>
                        {g}
                      </span>
                    ))}
                    {chips.rest > 0 ? <span style={chipRestStyle()}>+{chips.rest}</span> : null}
                  </>
                )}
              </InfoRow>
            </div>

            <div>
              <div style={secTitleStyle}>推荐理由</div>
              {page.reason ? (
                <p style={reasonStyle}>{page.reason}</p>
              ) : (
                // 空理由也占住同样的高度（reasonStyle 的 minHeight）：卡片高度不会因为写没写理由而跳
                <p style={{ ...reasonStyle, ...dimStyle }}>还没有写推荐理由</p>
              )}
            </div>

            <div>
              <div style={secTitleStyle}>剧照</div>
              <div style={photoRowStyle}>
                {photos.length === 0 ? (
                  <span style={photoEmptyStyle}>还没有剧照</span>
                ) : (
                  photos.map((p) => (
                    <span key={p} style={photoBoxStyle()}>
                      <CoverImage src={p} alt="剧照" className="h-full w-full" rounded="" />
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <div style={footStyle}>
          <span>{tableName}</span>
          <span>{pageNoText(pageNo, pageCount)}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * 把卡片**等比缩放**到容器里（宽高都要放得下，见文件头「缩放比为什么取 min」）。
 *
 * 为什么不直接用 CSS `zoom`：它在 Chromium 里能用，但布局行为（是否影响外层尺寸）
 * 在各版本间改过，用它就得赌 Electron 的版本；而 `transform: scale()` 不影响布局，
 * 所以「缩完以后占多大」要自己算 —— 这里用 ResizeObserver 量**容器**的宽高与卡片的
 * 真实高度，再按两个比例里更小的那个缩放，任何版本上都确定，拖窗口也不闪。
 *
 * ⚠️ 量的必须是**容器**（`viewRef`），不能是承载缩放结果的那层：
 * 后者的高度是我们自己按缩放比写上去的，量它等于拿结果当输入，会自激成一团乱（越缩越小或根本不缩）。
 *
 * 缩放比上限是 1：容器比卡片大时不放大（放大只会把图糊掉，且与导出像素密度无关）。
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
  /**
   * 版式宽度。**整张表取同一个值**（`cardWidthOfAll(pages)`）：
   * 翻页时卡片宽度不跳，而且这正是长图导出会用的宽度 —— 预览与长图一致。
   */
  width: number
  /** 由页面给的尺寸类（例如 `min-h-0 flex-1`）：缩放比的另一个输入就是它撑出来的可用区 */
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
    /*
     * 两边都要观察：
     * - 容器变尺寸（拖窗口、收起左侧面板）→ 缩放比要重算；
     * - 卡片变高（字体加载完、标题折行、理由变长）→ 缩放比与外层占位高度都要重算。
     * 只观察一边会出现「卡片被裁掉一截」或「下面留一大块空白」。
     */
    const measure = (): void => {
      setBoxW(view.clientWidth)
      setBoxH(view.clientHeight)
      setCardH(card.offsetHeight)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(view)
    ro.observe(card)
    // 首次同步量一次：ResizeObserver 回调要等下一帧，先量避免第一帧闪一下
    measure()
    return () => ro.disconnect()
  }, [])

  const widthScale = boxW > 0 ? boxW / props.width : 0
  const heightScale = boxH > 0 && cardH > 0 ? boxH / cardH : 1
  // 宽高都要塞得下 → 取小的那个；上限 1（容器比卡片大时不放大）
  const scale = Math.min(1, widthScale, heightScale)
  const ready = boxW > 0 && cardH > 0

  return (
    /*
     * 外层的尺寸完全由页面给（flex 撑出来），我们只量它、
     * 不让里面那张卡影响它的高度 —— 这是「不自激」的关键（见文件头）。
     */
    <div
      ref={viewRef}
      className={className}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
    >
      {/* 承载缩放结果的盒子：尺寸 = 卡片真实尺寸 × 缩放比，所以它在容器里一定是"刚好放得下"的 */}
      <div
        style={{
          width: ready ? props.width * scale : 0,
          height: ready ? cardH * scale : 0,
          flex: '0 0 auto',
          visibility: ready ? 'visible' : 'hidden'
        }}
      >
        <div
          ref={cardRef}
          style={{ width: props.width, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        >
          <RecommendPageCard {...props} />
        </div>
      </div>
    </div>
  )
}

import { useCallback, useMemo, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { ModuleLayout, ModuleRect, RecommendPage } from '@/stores/recommendTable'
import { MAX_PHOTOS, MODULE_KINDS, renderModules } from '@/stores/recommendTable'
import { CoverImage } from '@/components/CoverImage'
import { localImgUrl } from '@/lib/format'
import {
  RL,
  type ModuleFont,
  airDateText,
  asReactStyle,
  blend,
  blendStyle,
  chipStyle,
  contentBlendStyle,
  contentGradientStyle,
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
  moduleFontOf,
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
 * ## 位置从哪来（v0.3.9：自由摆放又回来了，但仍然只有一份几何）
 *
 * 模块位置由 `moduleRectsOf(frameOf(page), page.layout)` 现算：
 * `page.layout` 里带 `x/y/w/h` 的模块用用户坐标（夹进页面），其余按版式默认。
 * 界面与导出调的是**同一个函数**，所以"所见即所得"是代码结构保证的 ——
 * 上一版那种"两份渲染各自读坐标"的写法已经整条撤掉。
 *
 * ## 页面结构（从下到上）
 *
 *   1. 页面底色（纯色 / 渐变，或图片背景时的白）；
 *   2. 图区里的图片层（只有设了图片背景）：`cover` 裁剪、可模糊；
 *   3. 交融渐变：贴在图区靠内容区那一侧，渐隐到底色（没有硬边）；
 *   4. 内容区渐变底色（可选，v0.3.9 左菜单 Ⅵ）+ 它与页面底色之间的交融条；
 *   5. 模块：绝对定位，**没有白底**，文字靠页面继承下来的 `TEXT_SHADOW` 白晕保证可读；
 *   6. `overlay`：编辑模式下的拖动/选中叠层（由调用方给，不在预览里存在）。
 *
 * 层号见 `styles.moduleBoxStyle` 与 `contentGradientStyle`（背景 0 / 交融 1 / 内容渐变 1 / 交融条 2 / 模块 3+）。
 */
export function RecommendPageCard({
  page,
  pageNo,
  pageCount,
  tableName,
  recommender,
  onContextMenu,
  overlay
}: {
  page: RecommendPage
  pageNo: number
  pageCount: number
  tableName: string
  recommender: string
  onContextMenu?: (e: ReactMouseEvent) => void
  /** 编辑模式的叠层（画在页面坐标系里、模块之上），不传就是纯预览 */
  overlay?: ReactNode
}) {
  const frame = useMemo(() => frameOf(page), [page])
  const rects = useMemo(() => moduleRectsOf(frame, page.layout), [frame, page.layout])
  /** 要画的模块：**一律走 renderModules**（补全 → 丢掉隐藏的），隐藏的完全不进渲染树 */
  const drawn = useMemo(() => renderModules(page), [page])
  const bgResolve = useCallback((p: string) => `url('${localImgUrl(p)}')`, [])
  const bandWrap = imageBandWrapStyle(frame)
  /** 页面底色（纯色/渐变/白）：交融渐变要渐隐到它，两层必须用同一个值，否则接缝会显形 */
  const pageBase = pageBackgroundCss(page.background)
  const contentGrad = contentGradientStyle(frame, page.contentGradient)

  const renderModule = (m: ModuleLayout, rect: ModuleRect, order: number): React.ReactNode => {
    // 这一块的字体/字号（用户没设就是基准），块内所有文字都按它缩放
    const font: ModuleFont = moduleFontOf(page.layout, m.id)
    const inner = (() => {
      switch (m.id) {
        case 'cover':
          return <CoverImage src={page.cover} alt={displayName(page)} className="h-full w-full" rounded="" />
        case 'title': {
          const sub = subName(page)
          const rec = recommender.trim()
          return (
            <>
              <h1 style={asReactStyle(titleTextStyle(font))}>{displayName(page)}</h1>
              {sub ? <div style={asReactStyle(subTextStyle(font))}>{sub}</div> : null}
              {rec ? <div style={asReactStyle(recTextStyle(font))}>推荐人：{rec}</div> : null}
            </>
          )
        }
        case 'ratings':
          return (
            <>
              <InfoRow label="bangumi 评分" font={font}>
                <span style={asReactStyle(scoreTextStyle())}>{scoreText(page.bgmRating)}</span>
              </InfoRow>
              <InfoRow label="推荐人评分" font={font}>
                <span style={asReactStyle(scoreTextStyle())}>{scoreText(page.myRating, '未评分')}</span>
              </InfoRow>
            </>
          )
        case 'level':
          return (
            <InfoRow label="推荐指数" font={font}>
              <Stars level={page.recommendLevel} font={font} />
            </InfoRow>
          )
        case 'meta':
          return (
            <>
              <InfoRow label="播出时间" font={font}>
                {airDateText(page.airDate)}
              </InfoRow>
              <InfoRow label="类型标签" font={font}>
                <Genres genres={page.genres} font={font} />
              </InfoRow>
            </>
          )
        case 'reason':
          return (
            <>
              <div style={asReactStyle(secTitleStyle(font))}>推荐理由</div>
              {page.reason ? (
                <p style={asReactStyle(reasonTextStyle(font))}>{page.reason}</p>
              ) : (
                <p style={asReactStyle(blend(reasonTextStyle(font), emptyHintStyle(font)))}>
                  还没有写推荐理由
                </p>
              )}
            </>
          )
        case 'photos': {
          const photos = page.photos.slice(0, MAX_PHOTOS)
          const cell = photoCellSize(rect, frame)
          return (
            <>
              <div style={asReactStyle(secTitleStyle(font))}>剧照</div>
              <div style={asReactStyle(photoRowStyle())}>
                {photos.length === 0 ? (
                  <span style={asReactStyle(emptyHintStyle(font))}>还没有剧照</span>
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
            <div style={asReactStyle(footRowStyle(font))}>
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
      <div key={m.id} style={asReactStyle(moduleBoxStyle(rect, order, font))} data-module={m.id}>
        {m.id === 'cover' ? inner : <div style={asReactStyle(moduleInnerStyle(RL.rowGap))}>{inner}</div>}
      </div>
    )
  }

  return (
    <div
      style={asReactStyle({ ...pageStyle(frame), background: pageBase })}
      onContextMenu={onContextMenu}
    >
      {/* 图区（只有图片背景才有）：外层裁剪，里层图片层可模糊，模糊不会糊出边界 */}
      {bandWrap ? (
        <div style={asReactStyle(bandWrap)}>
          <div style={asReactStyle(imageBandImageStyle(frame, page.background, bgResolve))} />
        </div>
      ) : null}
      {/* 交融渐变：贴着图区靠内容区的那一侧，渐隐到页面底色 */}
      {frame.pos === 'none' ? null : <div style={asReactStyle(blendStyle(frame, pageBase))} />}
      {/* 内容区渐变底色（可选）+ 它与页面底色之间的交融条 */}
      {contentGrad ? (
        <>
          <div style={asReactStyle(contentGrad)} />
          {frame.pos === 'none' ? null : (
            <div style={asReactStyle(contentBlendStyle(frame, pageBase))} />
          )}
        </>
      ) : null}

      {/* 模块：按 MODULE_KINDS 的顺序画（顺序即层级，后面的盖前面的） */}
      {drawn.map((m) => renderModule(m, rects[m.id], MODULE_KINDS.indexOf(m.id)))}

      {/* 编辑模式的叠层（拖动 / 选中框），预览时不存在 */}
      {overlay}
    </div>
  )
}

/** 一行信息（标签 + 值） */
function InfoRow({
  label,
  children,
  font
}: {
  label: string
  children: React.ReactNode
  font?: ModuleFont
}) {
  return (
    <div style={asReactStyle(infoRowStyle())}>
      <span style={asReactStyle(infoLabelStyle(font))}>{label}</span>
      <span style={asReactStyle(infoValueStyle(font))}>{children}</span>
    </div>
  )
}

/** 推荐指数星星（字符，不依赖图标字体 —— 导出图那边同理） */
function Stars({ level, font }: { level: number; font?: ModuleFont }) {
  const { on, off } = levelParts(level)
  return (
    <span>
      <span style={asReactStyle(starStyle(true, font))}>{'★'.repeat(on)}</span>
      <span style={asReactStyle(starStyle(false, font))}>{'☆'.repeat(off)}</span>
    </span>
  )
}

/** 类型标签胶囊 */
function Genres({ genres, font }: { genres: string[]; font?: ModuleFont }) {
  const chips = genreChips(genres)
  if (chips.list.length === 0) return <span style={asReactStyle(dimTextStyle(font))}>暂无标签</span>
  return (
    <>
      {chips.list.map((g) => (
        <span key={g} style={asReactStyle(chipStyle(false, font))}>
          {g}
        </span>
      ))}
      {chips.rest > 0 ? (
        <span style={asReactStyle(chipStyle(true, font))}>{`+${chips.rest}`}</span>
      ) : null}
    </>
  )
}

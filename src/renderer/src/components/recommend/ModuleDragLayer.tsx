import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { MODULE_H_MIN, MODULE_NAMES, MODULE_W_MIN, type ModuleKind, type ModuleRect } from '@/stores/recommendTable'
import type { PageFrame } from './styles'

/**
 * 编辑模式下的**画布拖动叠层**（v0.3.9 左菜单 Ⅶ 的"拖动"那一半）。
 *
 * ## 为什么是一个独立的叠层，而不是把拖动写进 RecommendPageCard
 *
 * 卡片是**预览与导出共用的那份几何的呈现**，它不该知道"编辑模式"这回事
 * （否则翻阅模式、导出图与编辑模式三处都要处理"有没有拖动"的分支）。
 * 叠层画在卡片的页面坐标系里（作为 `overlay` 传进去），只多画一层虚线框与手柄。
 *
 * ## 为什么拖动过程中不写 store
 *
 * 指针每移动一像素就 `updatePage` 的话，一次拖动会写上百次盘（这个 store 是"每次改动整份写回"）。
 * 所以拖动期间只更新本地 `live` 状态，**松手那一刻**才提交一次 —— 与 CropSelector 的取舍一致。
 *
 * ## 缩放怎么换算（这里最容易错，写清楚）
 *
 * 叠层跟着父元素的 `transform: scale(s)` 一起缩小，但 PointerEvent 的 clientX/Y 是**屏幕像素**。
 * 所以位移要 `÷ s` 才是页面坐标：`scale` 由 FittedRecommendCard 交给调用方再传进来
 * （它才是唯一知道缩放比的地方，这里绝不自己再量一次）。
 */
export function ModuleDragLayer({
  frame,
  rects,
  ids,
  selected,
  scale,
  onSelect,
  onRect
}: {
  frame: PageFrame
  /** 每个模块的矩形（已经叠过用户坐标） */
  rects: Record<ModuleKind, ModuleRect>
  /** 要画手柄的模块（= 页面上真正画出来的那些，隐藏的模块不给拖） */
  ids: ModuleKind[]
  selected: ModuleKind | null
  /** 当前缩放比（页面 → 屏幕） */
  scale: number
  onSelect: (id: ModuleKind | null) => void
  /** 松手时提交（只提交一次，见文件头） */
  onRect: (id: ModuleKind, rect: ModuleRect) => void
}) {
  const [live, setLive] = useState<{ id: ModuleKind; rect: ModuleRect } | null>(null)
  /**
   * `live` 的镜像（引用）。
   *
   * 为什么不能只靠 state：pointerup 可能和最后一次 pointermove 落在**同一批**里，
   * 那一刻闭包里的 `live` 还是上一帧的值 —— 提交的坐标就会比用户松手的地方少一格。
   * 引用是同步写的，松手时读它一定是最后一次移动的结果。
   */
  const liveRef = useRef<{ id: ModuleKind; rect: ModuleRect } | null>(null)
  const [drag, setDrag] = useState<{
    id: ModuleKind
    mode: 'move' | 'resize'
    px: number
    py: number
    orig: ModuleRect
  } | null>(null)

  const setLiveBoth = (v: { id: ModuleKind; rect: ModuleRect } | null): void => {
    liveRef.current = v
    setLive(v)
  }

  // Esc = 取消选中（与"点空白处"同一个效果，给键盘用户留一条路）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onSelect(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSelect])

  /** 夹进页面范围（与 styles.moduleRectsOf 用的是同一套规则，用户拖出去也不会丢） */
  const clampRect = (r: ModuleRect): ModuleRect => {
    const x = Math.min(Math.max(0, Math.round(r.x)), Math.max(0, frame.width - MODULE_W_MIN))
    const y = Math.min(Math.max(0, Math.round(r.y)), Math.max(0, frame.height - MODULE_H_MIN))
    return {
      x,
      y,
      w: Math.min(Math.max(MODULE_W_MIN, Math.round(r.w)), Math.max(MODULE_W_MIN, frame.width - x)),
      h: Math.min(Math.max(MODULE_H_MIN, Math.round(r.h)), Math.max(MODULE_H_MIN, frame.height - y))
    }
  }

  const begin = (e: ReactPointerEvent, id: ModuleKind, mode: 'move' | 'resize'): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect(id)
    setDrag({ id, mode, px: e.clientX, py: e.clientY, orig: rects[id] })
  }

  const move = (e: ReactPointerEvent): void => {
    if (!drag) return
    const dx = (e.clientX - drag.px) / (scale || 1)
    const dy = (e.clientY - drag.py) / (scale || 1)
    const o = drag.orig
    setLiveBoth({
      id: drag.id,
      rect:
        drag.mode === 'move'
          ? clampRect({ ...o, x: o.x + dx, y: o.y + dy })
          : clampRect({ ...o, w: o.w + dx, h: o.h + dy })
    })
  }

  const end = (e: ReactPointerEvent): void => {
    if (!drag) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 指针已经释放过：忽略 */
    }
    const cur = liveRef.current
    if (cur && cur.id === drag.id) onRect(drag.id, cur.rect)
    setDrag(null)
    setLiveBoth(null)
  }

  return (
    <div style={{ position: 'absolute', inset: '0', zIndex: '60' }}>
      {/* 点画布空白处 = 取消选中（这一层在最底下，模块手柄盖在它上面） */}
      <div
        style={{ position: 'absolute', inset: '0' }}
        onPointerDown={() => onSelect(null)}
        title="点空白处取消选中"
      />
      {ids.map((id) => {
        const r = live && live.id === id ? live.rect : rects[id]
        const on = selected === id
        return (
          <div
            key={id}
            data-edit-handle={id}
            onPointerDown={(e) => begin(e, id, 'move')}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            title={`拖动移动「${MODULE_NAMES[id]}」`}
            style={{
              position: 'absolute',
              left: `${r.x}px`,
              top: `${r.y}px`,
              width: `${r.w}px`,
              height: `${r.h}px`,
              boxSizing: 'border-box',
              border: `${on ? 2 : 1}px dashed ${on ? 'rgba(224, 87, 127, 0.95)' : 'rgba(47, 107, 255, 0.45)'}`,
              background: on ? 'rgba(224, 87, 127, 0.08)' : 'transparent',
              cursor: drag?.id === id && drag.mode === 'move' ? 'grabbing' : 'grab',
              touchAction: 'none'
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: '2px',
                top: '2px',
                fontSize: '11px',
                lineHeight: '14px',
                padding: '0 3px',
                borderRadius: '4px',
                background: on ? 'rgba(224, 87, 127, 0.9)' : 'rgba(47, 107, 255, 0.65)',
                color: '#fff',
                whiteSpace: 'nowrap'
              }}
            >
              {MODULE_NAMES[id]} {r.w}×{r.h}
            </span>
            {on ? (
              <span
                data-edit-resize={id}
                onPointerDown={(e) => begin(e, id, 'resize')}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                title="拖动改大小"
                style={{
                  position: 'absolute',
                  right: '-6px',
                  bottom: '-6px',
                  width: '14px',
                  height: '14px',
                  borderRadius: '3px',
                  background: 'rgba(224, 87, 127, 0.95)',
                  border: '2px solid #fff',
                  cursor: 'nwse-resize',
                  touchAction: 'none'
                }}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

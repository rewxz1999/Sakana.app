import { useEffect, useState, type MouseEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ImagePlus, Images, Timer, Trash2 } from 'lucide-react'
import { localImgUrl } from '@/lib/format'
import { ConfirmModal } from '@/components/ui'

/**
 * 展示位：搜索页的轮播图。有两种使用形态，组件本身是同一套：
 *
 * 1. **悬浮小窗**（默认）：有搜索结果时贴在结果区右下角，是「类似广告位」的小窗，
 *    只负责展示与交互（轮播 / 右键菜单）；
 * 2. **空态大展示位**（`showcase`）：搜索页没有内容（初始态 / 没搜到结果）时，
 *    由页面放进空白区域撑满，并在底部常驻一条控制栏（添加 / 删除 / 清空 / 切换间隔）。
 *
 * 图片列表的读写与持久化仍由页面负责（见 SearchPage），组件保持无副作用、可复用。
 */

/** 自动切换间隔的默认值（秒）：6 秒既够看清一张图，又不会频繁闪烁打断阅读 */
const DEFAULT_INTERVAL_SEC = 6
/** 间隔可调范围（用户要求 2~15 秒/张）：下限别快到看不清，上限别慢到以为坏了 */
const MIN_INTERVAL_SEC = 2
const MAX_INTERVAL_SEC = 15
/** 淡入淡出时长（秒）：远小于切换间隔，避免两张图长时间半透明叠加糊在一起 */
const FADE_S = 0.8
/** 右键菜单尺寸估算：超出窗口时向内收，保证菜单整体落在可视区内 */
const MENU_W = 196
const MENU_H = 124
/** 菜单与窗口边缘的最小间距 */
const MENU_PAD = 8

export interface ImageCarouselProps {
  /** 展示图片绝对路径列表（持久化在 searchShowcase） */
  images: string[]
  /** 上传展示图片（页面负责调 api.dialog.pickImages 并持久化） */
  onUpload: () => void
  /** 删除当前正在展示的那张 */
  onDeleteCurrent: (path: string) => void
  /** 清空展示列表 */
  onClearAll: () => void
  /** 定位与尺寸由页面决定：广告位大小要跟着搜索页布局走 */
  className?: string
  /** 自动切换间隔（秒），由页面从 settings 读出来传进来；缺省/非法值按默认 6 秒 */
  intervalSec?: number
  /** 间隔变化回调：只在 `showcase` 形态下渲染滑块，页面负责持久化 */
  onIntervalChange?: (sec: number) => void
  /** 空态大展示位形态：底部加一条常驻控制栏，页码挪到右上角 */
  showcase?: boolean
}

/** 把外部/持久化里的脏值收窄成合法间隔（NaN、0、999 都不该让轮播失控） */
function clampInterval(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_INTERVAL_SEC
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, Math.round(v)))
}

export function ImageCarousel({
  images,
  onUpload,
  onDeleteCurrent,
  onClearAll,
  className = '',
  intervalSec,
  onIntervalChange,
  showcase = false
}: ImageCarouselProps) {
  const [index, setIndex] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [askClear, setAskClear] = useState(false)
  /** 加载失败的图片路径：文件被移动/删除时给一句人话，而不是留一个破图 */
  const [broken, setBroken] = useState('')
  /** 滑块的即时值：拖拽时先动滑块再落盘，避免每一帧都写一次设置 */
  const [sec, setSec] = useState(() => clampInterval(intervalSec))

  // 外部（设置里的值）变化时同步回来：设置被其它窗口/页面改了也要跟着走
  useEffect(() => {
    setSec(clampInterval(intervalSec))
  }, [intervalSec])

  const total = images.length
  // 图片被删掉后 index 可能越界：取模归位，保证永远指向一张存在的图片
  const active = total > 0 ? ((index % total) + total) % total : 0
  const current = total > 0 ? images[active] : ''

  // 定时切换：0~1 张图时不启动计时器，省掉无意义的 setState
  useEffect(() => {
    if (total <= 1) return
    const timer = window.setInterval(() => setIndex((i) => i + 1), sec * 1000)
    return () => window.clearInterval(timer)
  }, [total, sec])

  // 右键菜单：点击别处 / 再次右键 / Esc 关闭（与 GalgamePage 的右键菜单行为一致）
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const openMenu = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    // 必须阻止冒泡：菜单的关闭监听是在本次事件触发后才注册到 window 上的，
    // 若事件继续冒泡到 window，刚打开的菜单会被自己立刻关掉
    e.stopPropagation()
    const maxX = Math.max(MENU_PAD, window.innerWidth - MENU_W - MENU_PAD)
    const maxY = Math.max(MENU_PAD, window.innerHeight - MENU_H - MENU_PAD)
    setMenu({
      x: Math.min(Math.max(MENU_PAD, e.clientX), maxX),
      y: Math.min(Math.max(MENU_PAD, e.clientY), maxY)
    })
  }

  return (
    <>
      <div
        onContextMenu={openMenu}
        title="右键：上传 / 删除展示图片"
        className={`group relative overflow-hidden rounded-xl border border-border bg-elev1 shadow-lg ${className}`}
      >
        {/* 底板常驻在最下层：图片没加载出来 / 列表为空时都不会出现一块刺眼的白 */}
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-accent-soft/60 via-elev2 to-elev3">
          <Images size={22} className="text-faint" />
        </div>

        {total === 0 ? (
          /* 空列表：虚线框 + 提示。右键是产品指定的入口，但空框上的左键也顺手支持，否则没人知道要点右键 */
          <button
            onClick={onUpload}
            /* showcase 形态底部有控制栏（高约 34px），提示文字要往上挪，别被压住 */
            className={`absolute inset-x-0 top-0 flex flex-col items-center justify-center gap-1 whitespace-nowrap border border-dashed border-border text-faint transition-colors hover:border-accent hover:text-accent ${
              showcase ? 'bottom-9' : 'bottom-0'
            }`}
          >
            <ImagePlus size={16} />
            <span className="whitespace-nowrap text-[11px]">
              {showcase ? '点这里添加轮播图片' : '右键上传展示图片'}
            </span>
          </button>
        ) : (
          <>
            <AnimatePresence initial={false}>
              {current === broken ? (
                <motion.div
                  key={`${current}#broken`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: FADE_S }}
                  className="absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-faint"
                >
                  图片无法加载，可能已被移动或删除
                </motion.div>
              ) : (
                <motion.img
                  key={current}
                  src={localImgUrl(current)}
                  alt=""
                  draggable={false}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: FADE_S }}
                  onError={() => setBroken(current)}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
            </AnimatePresence>
          </>
        )}

        {/*
          角落标签保持克制：只留页码。
          悬浮小窗里页码在右下、悬停才提示右键用法；
          空态大展示位底部被控制栏占着，页码挪到右上角，右键提示则不需要（控制栏已经写明）。
        */}
        {total > 0 ? (
          <span
            className={`pointer-events-none absolute rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] tabular-nums text-white ${
              showcase ? 'right-1.5 top-1.5' : 'bottom-1.5 right-1.5'
            }`}
          >
            {active + 1}/{total}
          </span>
        ) : null}
        {!showcase && total > 0 ? (
          <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] text-white/85 opacity-0 transition-opacity group-hover:opacity-100 whitespace-nowrap">
            右键管理
          </span>
        ) : null}

        {/*
          空态大展示位的常驻控制栏：图片管理（添加/删除当前/清空）+ 轮播间隔滑块。
          放常驻控制栏而不是只靠右键菜单，是因为「怎么换图、怎么调速度」在空态里
          必须一眼看得见（右键菜单是隐藏入口，新手发现不了）。
          控制栏自己吃掉 mousedown：否则点「删除当前」等按钮会顺带触发页面级的
          「点到书签条以外就收起」「点下拉以外就关闭」，用户根本没想动那些东西。
        */}
        {showcase ? (
          <div
            className="absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 bg-gradient-to-t from-black/75 to-black/25 px-2.5 py-1.5 text-[11px] text-white backdrop-blur-sm"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={onUpload}
              title="添加本地图片（可多选）"
              className="flex items-center gap-1 rounded-md px-1.5 py-1 whitespace-nowrap transition-colors hover:bg-white/15"
            >
              <ImagePlus size={12} /> 添加图片
            </button>
            <button
              disabled={total === 0}
              onClick={() => {
                if (current) onDeleteCurrent(current)
              }}
              title="删除当前正在展示的这一张"
              className="flex items-center gap-1 rounded-md px-1.5 py-1 whitespace-nowrap transition-colors hover:bg-danger/25 disabled:pointer-events-none disabled:opacity-40"
            >
              <Trash2 size={12} /> 删除当前
            </button>
            <button
              disabled={total === 0}
              onClick={() => setAskClear(true)}
              title="清空全部展示图片"
              className="flex items-center gap-1 rounded-md px-1.5 py-1 whitespace-nowrap transition-colors hover:bg-white/15 disabled:pointer-events-none disabled:opacity-40"
            >
              <Trash2 size={12} /> 清空
            </button>
            <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap">
              <Timer size={12} className="text-white/80" />
              <span className="text-white/80">间隔</span>
              <input
                type="range"
                min={MIN_INTERVAL_SEC}
                max={MAX_INTERVAL_SEC}
                step={1}
                value={sec}
                disabled={!onIntervalChange}
                onChange={(e) => {
                  const v = clampInterval(Number(e.target.value))
                  // 先动本地值（滑块/计时器立刻跟随），同时交给页面写进设置
                  setSec(v)
                  onIntervalChange?.(v)
                }}
                title={`每 ${sec} 秒切换一张（${MIN_INTERVAL_SEC}~${MAX_INTERVAL_SEC} 秒）`}
                className="h-1 w-24 cursor-pointer accent-white disabled:cursor-default disabled:opacity-50"
              />
              <span className="w-7 text-right tabular-nums">{sec}s</span>
            </span>
          </div>
        ) : null}
      </div>

      {/* 右键菜单：绝对定位的小面板，样式跟随主题 token */}
      {menu ? (
        <div
          className="fixed z-[70] w-[196px] overflow-hidden rounded-xl border border-border bg-elev1 py-1 shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs hover:bg-elev2 whitespace-nowrap"
            onClick={() => {
              setMenu(null)
              onUpload()
            }}
          >
            <ImagePlus size={13} /> 上传展示图片
          </button>
          <button
            disabled={total === 0}
            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs text-danger hover:bg-danger/10 disabled:pointer-events-none disabled:opacity-40 whitespace-nowrap"
            onClick={() => {
              setMenu(null)
              if (current) onDeleteCurrent(current)
            }}
          >
            <Trash2 size={13} /> 删除当前展示图片
          </button>
          <button
            disabled={total === 0}
            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs text-dim hover:bg-elev2 disabled:pointer-events-none disabled:opacity-40 whitespace-nowrap"
            onClick={() => {
              setMenu(null)
              setAskClear(true)
            }}
          >
            <Trash2 size={13} /> 清空全部展示图片
          </button>
        </div>
      ) : null}

      {/* 清空属于不可逆操作，用 ConfirmModal 二次确认（不用 window.confirm） */}
      <ConfirmModal
        open={askClear}
        title="清空展示图片"
        danger
        confirmText="清空"
        message={`确定清空全部 ${total} 张展示图片？只会清空搜索页底部的展示位，不会删除磁盘上的图片文件。`}
        onConfirm={onClearAll}
        onClose={() => setAskClear(false)}
      />
    </>
  )
}

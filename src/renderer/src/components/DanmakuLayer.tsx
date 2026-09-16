import { useEffect, useRef } from 'react'
import type { DanmakuComment, DanmakuSettings } from '@shared/types'

/**
 * 弹幕渲染层（v0.2.8）。
 *
 * ## 为什么画在悬浮窗里
 * 画面由**原生子窗口**（libmpv / libVLC）绘制，它永远盖在网页内容之上 ——
 * 画在播放页里的弹幕会被视频整个挡住（控制栏与详情面板已经踩过同一个坑）。
 * 所以弹幕和它们一样画在独立的透明悬浮窗里，用 `pointer-events: none` 让点击穿透到控制栏。
 *
 * ## 渲染方式
 * 用 canvas + `requestAnimationFrame` 手绘，而不是 DOM：
 * 一集可能有上千条弹幕，DOM 元素的创建/销毁成本高，canvas 更稳。
 *
 * ## 时间基准
 * 播放位置由播放页以约 4Hz 推送过来，直接用它会让弹幕一跳一跳；
 * 这里用「推送值 + 本地时钟外推」得到平滑时间；推送值明显变化（拖动进度）时重新对齐。
 */

interface ActiveItem {
  text: string
  color: string
  /** 1=滚动 4=底部 5=顶部 */
  mode: number
  lane: number
  /** 该条弹幕的开始播放时间（秒，已含时间轴微调） */
  start: number
  width: number
  /** 滚动弹幕：穿过屏幕所需秒数 */
  duration: number
}

interface Props {
  comments: DanmakuComment[]
  settings: DanmakuSettings
  /** 播放位置（秒） */
  time: number
  playing: boolean
  /** 视频区域（相对悬浮窗窗口的像素矩形） */
  rect: { x: number; y: number; width: number; height: number }
  /** 分辨率缩放（devicePixelRatio） */
  scale?: number
}

/** 顶部/底部弹幕的停留时长（秒） */
const FIXED_DURATION = 4
/** 每秒最多新出现的弹幕条数（防止瞬间糊屏） */
const SPAWN_PER_SECOND = 18

export function DanmakuLayer({ comments, settings, time, playing, rect, scale = 1 }: Props): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const itemsRef = useRef<ActiveItem[]>([])
  const cursorRef = useRef(0)
  /** 时间基准：{播放时间, 本地时钟} */
  const baseRef = useRef({ time: 0, clock: 0 })
  const laneBusyRef = useRef<number[]>([])
  const spawnWindowRef = useRef<{ at: number; used: number }>({ at: 0, used: 0 })
  /** 每次 e 变化都要重建的常量放到 ref，避免闭包过期 */
  const cfgRef = useRef({ settings, comments, rect, playing })
  cfgRef.current = { settings, comments, rect, playing }

  // 外部时间跳变（拖动进度 / 换集）时重置
  useEffect(() => {
    const base = baseRef.current
    if (Math.abs(time - base.time) > 1.5 || time < base.time - 0.05) {
      itemsRef.current = []
      laneBusyRef.current = []
      // 重新定位游标：找到第一条 >= 当前时间的弹幕
      const list = comments
      let lo = 0
      let hi = list.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (list[mid].time < time) lo = mid + 1
        else hi = mid
      }
      cursorRef.current = lo
    }
    baseRef.current = { time, clock: performance.now() }
  }, [time, comments])

  useEffect(() => {
    // 换集 / 改设置：整体重置
    itemsRef.current = []
    laneBusyRef.current = []
    cursorRef.current = 0
    baseRef.current = { time: baseRef.current.time, clock: performance.now() }
  }, [comments])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas ? canvas.getContext('2d') : null
    // 挂载诊断（自检脚本读它）：能直接看出「ref 有没有、上下文有没有、循环跑了几帧」
    const w0 = window as unknown as Record<string, number | boolean>
    w0.__sakanaDanmakuMount = true
    w0.__sakanaDanmakuFrames = 0
    w0.__sakanaDanmakuHasCanvas = Boolean(canvas)
    w0.__sakanaDanmakuHasCtx = Boolean(ctx)
    if (!canvas || !ctx) return
    let raf = 0
    let lastFrameAt = performance.now()

    const blockList = (): string[] =>
      cfgRef.current.settings.blockWords
        .split(/[,，\n\r]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)

    const draw = (): void => {
      raf = window.requestAnimationFrame(draw)
      lastFrameAt = performance.now()
      ;(window as unknown as Record<string, number>).__sakanaDanmakuFrames =
        ((window as unknown as Record<string, number>).__sakanaDanmakuFrames ?? 0) + 1
      const { settings: cfg, comments: list, rect: r, playing: isPlaying } = cfgRef.current
      const w = Math.max(1, Math.round(r.width))
      const h = Math.max(1, Math.round(r.height))
      if (canvas.width !== Math.round(w * scale) || canvas.height !== Math.round(h * scale)) {
        canvas.width = Math.round(w * scale)
        canvas.height = Math.round(h * scale)
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
      }
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // 未开启 / 无弹幕：清空并停在这里
      if (!cfg.enabled || list.length === 0) {
        itemsRef.current = []
        return
      }

      // 平滑时间：推送值 + 本地时钟外推（暂停时不再推进）
      const base = baseRef.current
      const t = base.time + (isPlaying ? (performance.now() - base.clock) / 1000 : 0) + cfg.offsetMs / 1000

      const fontSize = Math.max(10, cfg.fontSize)
      const lineH = Math.round(fontSize * 1.35)
      // 覆盖区域：只占视频区域顶部的一部分
      const areaH = Math.max(lineH, Math.round(h * Math.min(1, Math.max(0.1, cfg.area))))
      const lanes = Math.max(1, Math.floor(areaH / lineH))
      if (laneBusyRef.current.length !== lanes) {
        laneBusyRef.current = new Array(lanes).fill(0)
      }

      const speed = Math.max(2, cfg.speedSec) // 秒/整屏

      // 1) 补生成：把 [t-0.4, t] 之间应当出现的弹幕放进来
      const spawnAt = spawnWindowRef.current
      const nowSec = Math.floor(t * 4) / 4
      if (spawnAt.at !== nowSec) spawnAtRef(spawnAt, nowSec)
      let cursor = cursorRef.current
      // 游标落后太多（长时间暂停后拖动）：直接对齐
      while (cursor < list.length && list[cursor].time < t - 1) cursor++
      const blocked = blockList()
      // 排障探针（自检脚本读它，见 SAKANA_DANMAKU_UI_TEST）：能直接看出「时间对不对、有没有生成、画了几条」
      ;(window as unknown as Record<string, unknown>).__sakanaDanmaku = {
        t: Math.round(t * 10) / 10,
        cursor,
        total: list.length,
        active: itemsRef.current.length,
        w,
        h,
        lanes,
        playing: isPlaying,
        offsetMs: cfg.offsetMs,
        area: cfg.area
      }
      while (cursor < list.length && list[cursor].time <= t) {
        const c = list[cursor]
        cursor++
        const mode = c.mode === 4 ? 4 : c.mode === 5 ? 5 : 1
        if (mode === 1 && !cfg.showScroll) continue
        if (mode === 5 && !cfg.showTop) continue
        if (mode === 4 && !cfg.showBottom) continue
        const text = String(c.text ?? '').trim()
        if (!text) continue
        if (blocked.length > 0) {
          const lower = text.toLowerCase()
          if (blocked.some((b) => lower.includes(b))) continue
        }
        if (spawnAt.used >= SPAWN_PER_SECOND) continue
        // 同屏上限
        if (itemsRef.current.length >= Math.max(1, cfg.maxCount)) continue
        const duration = speed * (1 + Math.min(text.length, 40) / 60)
        ctx.font = `${cfg.bold ? '700 ' : ''}${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
        const width = ctx.measureText(text).width
        const lane = pickLane(itemsRef.current, laneBusyRef.current, lanes, mode, t, w, duration, width)
        if (lane < 0) continue
        spawnAt.used++
        itemsRef.current.push({
          text,
          color: c.color ?? '#ffffff',
          mode,
          lane,
          start: c.time,
          width,
          duration
        })
      }
      cursorRef.current = cursor

      // 2) 绘制 + 回收
      const alive: ActiveItem[] = []
      ctx.globalAlpha = Math.min(1, Math.max(0.15, cfg.opacity))
      ctx.textBaseline = 'top'
      for (const it of itemsRef.current) {
        const age = t - it.start
        if (it.mode === 1) {
          const travel = w + it.width + 24
          const x = w - (age / it.duration) * travel
          if (x + it.width < -8) continue // 已出画
          const y = it.lane * lineH
          drawText(ctx, it.text, x, y, fontSize, it.color, cfg.bold)
        } else {
          if (age > FIXED_DURATION) continue
          const y = it.mode === 5 ? it.lane * lineH : h - (it.lane + 1) * lineH
          const x = Math.round((w - it.width) / 2)
          drawText(ctx, it.text, x, y, fontSize, it.color, cfg.bold)
        }
        alive.push(it)
      }
      itemsRef.current = alive
      ctx.globalAlpha = 1
    }

    raf = window.requestAnimationFrame(draw)
    raf = window.requestAnimationFrame(draw)
    /*
     * 兜底推进（v0.2.8）：悬浮窗是「透明 + 置顶 + 不可聚焦」的窗口，
     * Chromium 仍可能把它当作被遮挡窗口而压低 rAF 频率（实测出现过只画一帧就冻住）。
     * 这里用定时器检查：超过 400ms 没有新帧就手动画一帧，保证弹幕不会卡住。
     * 主进程侧同时也关掉了 backgroundThrottling，两层保险。
     */
    const fallbackTimer = window.setInterval(() => {
      if (performance.now() - lastFrameAt > 400) draw()
    }, 200)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearInterval(fallbackTimer)
    }
  }, [scale])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    />
  )
}

function spawnAtRef(box: { at: number; used: number }, nowSec: number): void {
  box.at = nowSec
  box.used = 0
}

/** 选一条车道：滚动弹幕要求该车道最后一条已经完整进画（尾巴不留边），否则丢弃该条 */
function pickLane(
  items: ActiveItem[],
  busy: number[],
  lanes: number,
  mode: number,
  t: number,
  w: number,
  duration: number,
  width: number
): number {
  const startLane = mode === 5 ? 0 : 0
  for (let i = 0; i < lanes; i++) {
    const lane = (startLane + i) % lanes
    const last = [...items].reverse().find((it) => it.lane === lane && it.mode === mode)
    if (!last) return lane
    if (mode === 1) {
      // 上一条的尾巴是否已经进入画面（避免追尾重叠）
      const age = t - last.start
      const travel = w + last.width + 24
      const lastTail = w - (age / last.duration) * travel + last.width
      if (lastTail < w - width - 12) return lane
    } else {
      if (t - last.start > FIXED_DURATION - 0.3) return lane
    }
  }
  void busy
  void duration
  return -1
}

function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  color: string,
  bold: boolean
): void {
  ctx.font = `${bold ? '700 ' : ''}${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
  ctx.lineWidth = Math.max(2, Math.round(fontSize / 8))
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

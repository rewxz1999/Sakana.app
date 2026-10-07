import { useEffect, useRef } from 'react'
import type { DanmakuComment, DanmakuSettings } from '@shared/types'

/**
 * 弹幕渲染层（v0.2.8 起；v0.3.8 重写布局与绘制）
 *
 * ## 为什么画在悬浮窗里
 * 画面由**原生子窗口**（libmpv）绘制，它永远盖在网页内容之上 ——
 * 画在播放页里的弹幕会被视频整个挡住（控制栏与详情面板已经踩过同一个坑）。
 * 所以弹幕和它们一样画在独立的透明悬浮窗里，用 `pointer-events: none` 让点击穿透到控制栏。
 *
 * ## 渲染方式
 * canvas + `requestAnimationFrame` 手绘，而不是 DOM：一集可能有上千条弹幕，
 * DOM 元素的创建/销毁成本高，canvas 更稳。
 *
 * ## 时间基准
 * 播放位置由播放页以约 4Hz 推送过来，直接用它会让弹幕一跳一跳；
 * 这里用「推送值 + 本地时钟外推」得到平滑时间；推送值明显变化（拖动进度）时重新对齐。
 *
 * ## v0.3.8 修了什么（用户反馈「卡顿 / 样式简陋 / 覆盖区域选了没反应」）
 *
 * ① **覆盖区域没反应** —— 根因是选道策略：老代码从 0 号道往下找**第一条空道**，
 *    于是弹幕永远挤在最上面几条道里；把区域从 1 调到 1/4 只是"少了几条空道"，
 *    画面看起来一模一样。现在改成**按占用时间最短优先**（每一条都挑"最快腾出来"的那条道），
 *    弹幕会**铺满整个允许区域**，区域设置立刻看得见。
 *    同时把「顶部/底部弹幕」也纳入同一片道里（老代码里顶部弹幕与滚动弹幕抢同一批道，
 *    底部弹幕更是画在整屏最底下、完全不受区域影响）。
 *
 * ② **卡顿** —— 老代码每画一条弹幕都要设一次 `ctx.font`（字符串解析是 canvas 里较慢的一环）、
 *    每条新弹幕都要 `measureText`、选道时还要 `[...items].reverse().find()`（每次分配数组）。
 *    现在：字体一帧只设一次、文本宽度带缓存的 Map、选道用「每条道最后一条弹幕」的索引表（零分配）。
 *    另外 rAF 被 Chromium 降频时（透明置顶窗口常见）会自动切到 16ms 定时器驱动，
 *    不再依赖那个 400ms 才兜底一次的保底定时器（那会造成 0.4 秒的顿挫）。
 *
 * ③ **样式** —— 描边改为圆角连接（`lineJoin/miterLimit`），并新增两个开关：
 *    描边（`outline`，关掉就是纯色文字，配阴影更清爽）与阴影（`shadow`，浅色画面上更清楚）。
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
const SPAWN_PER_SECOND = 24
/** 文本宽度测量缓存的上限（一集常见的弹幕文本远小于这个数，避免无限增长） */
const MEASURE_CACHE_MAX = 4000
/** rAF 帧间隔超过这个值就认为被降频，改用定时器驱动 */
const RAF_SLOW_MS = 40
/** 定时器驱动的间隔（≈60fps） */
const TIMER_FRAME_MS = 16

export function DanmakuLayer({ comments, settings, time, playing, rect, scale = 1 }: Props): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const itemsRef = useRef<ActiveItem[]>([])
  const cursorRef = useRef(0)
  /** 时间基准：{播放时间, 本地时钟} */
  const baseRef = useRef({ time: 0, clock: 0 })
  /** 每条道上「最后一条弹幕」的引用：选道时不用再遍历全部弹幕（v0.3.8） */
  const laneLastRef = useRef<(ActiveItem | null)[]>([])
  /** 每条道上次被使用的时间戳：选道时优先挑"闲置最久"的那条，让弹幕铺满整个区域 */
  const laneLastUsedRef = useRef<number[]>([])
  const spawnWindowRef = useRef<{ at: number; used: number }>({ at: 0, used: 0 })
  /** 文本宽度缓存：key = `${bold?'b':''}${fontSize}|${text}` */
  const measureRef = useRef<Map<string, number>>(new Map())
  /** 每次 e 变化都要重建的常量放到 ref，避免闭包过期 */
  const cfgRef = useRef({ settings, comments, rect, playing })
  cfgRef.current = { settings, comments, rect, playing }

  // 外部时间跳变（拖动进度 / 换集）时重置
  useEffect(() => {
    const base = baseRef.current
    if (Math.abs(time - base.time) > 1.5 || time < base.time - 0.05) {
      itemsRef.current = []
      laneLastRef.current = []
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
    laneLastRef.current = []
    cursorRef.current = 0
    baseRef.current = { time: baseRef.current.time, clock: performance.now() }
  }, [comments])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas ? canvas.getContext('2d') : null
    // 挂载诊断（自检脚本读它）：能直接看出「ref 有没有、上下文有没有、循环跑了几帧」
    const probe = window as unknown as Record<string, number | boolean>
    probe.__sakanaDanmakuMount = true
    probe.__sakanaDanmakuFrames = 0
    probe.__sakanaDanmakuHasCanvas = Boolean(canvas)
    probe.__sakanaDanmakuHasCtx = Boolean(ctx)
    if (!canvas || !ctx) return
    let raf = 0
    let timer: number | null = null
    let lastFrameAt = performance.now()
    /** 最近若干帧的间隔，用来判断 rAF 是否被降频 */
    const recentDeltas: number[] = []

    const blockList = (): string[] =>
      cfgRef.current.settings.blockWords
        .split(/[,，\n\r]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)

    /** 文本宽度：带缓存（同一句话反复出现时不再 measureText） */
    const measure = (text: string, fontKey: string, fontSize: number, bold: boolean): number => {
      const key = `${fontKey}|${text}`
      const cache = measureRef.current
      const hit = cache.get(key)
      if (hit !== undefined) return hit
      ctx.font = `${bold ? '700 ' : ''}${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
      const w = ctx.measureText(text).width
      if (cache.size > MEASURE_CACHE_MAX) cache.clear()
      cache.set(key, w)
      return w
    }

    /** 一条弹幕在它那条道上何时腾出位置（秒，相对当前时间）；越小越该优先用 */
    const laneFreeIn = (lane: number, mode: number, t: number, w: number): number => {
      const last = laneLastRef.current[lane]
      if (!last || last.mode !== mode) return 0
      const age = t - last.start
      if (mode === 1) {
        const travel = w + last.width + 24
        const tail = w - (age / last.duration) * travel + last.width
        // 尾巴离屏幕左侧还有多远 → 换算成"还要多久才会完全离开"
        return tail > 0 ? 0 : Math.max(0, (Math.abs(tail) + 12) / Math.max(1, travel / last.duration))
      }
      return Math.max(0, FIXED_DURATION - age)
    }

    const draw = (): void => {
      lastFrameAt = performance.now()
      probe.__sakanaDanmakuFrames = (Number(probe.__sakanaDanmakuFrames) || 0) + 1
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
        laneLastRef.current = []
        return
      }

      // 平滑时间：推送值 + 本地时钟外推（暂停时不再推进）
      const base = baseRef.current
      const t = base.time + (isPlaying ? (performance.now() - base.clock) / 1000 : 0) + cfg.offsetMs / 1000

      const fontSize = Math.max(10, cfg.fontSize)
      const bold = cfg.bold
      const lineH = Math.round(fontSize * 1.35)
      /*
       * 覆盖区域：滚动弹幕与顶部弹幕只在这个高度里排道（底部弹幕固定贴画面底部，这是常规做法）。
       * 注意这里**不再**把区域最小压到一条道 —— 区域越小道越少、越容易"来不及就丢"，
       * 但至少保证 1 条道，避免整个区域设成极小值时弹幕全消失。
       */
      const areaH = Math.max(lineH, Math.round(h * Math.min(1, Math.max(0.05, cfg.area))))
      const lanes = Math.max(1, Math.floor(areaH / lineH))
      if (laneLastRef.current.length !== lanes) {
        const next: (ActiveItem | null)[] = new Array(lanes).fill(null)
        // 保留仍然有效的那几条道上的记录（改区域时不要把所有弹幕都重置）
        for (const it of itemsRef.current) {
          if (it.lane < lanes && it.mode !== 4) next[it.lane] = it
        }
        laneLastRef.current = next
        // 使用时间也要跟着道数一起调整（改小区域时丢掉多出来的那些）
        laneLastUsedRef.current = laneLastUsedRef.current.slice(0, lanes)
      }

      const speed = Math.max(2, cfg.speedSec) // 秒/整屏
      // 一帧只设一次字体：canvas 的 font 解析是这条路里最贵的一步，老代码每条弹幕都设一次
      ctx.font = `${bold ? '700 ' : ''}${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
      const fontKey = `${bold ? 'b' : 'n'}${fontSize}`

      // 1) 补生成：把 [t-0.4, t] 之间应当出现的弹幕放进来
      const spawnAt = spawnWindowRef.current
      const nowSec = Math.floor(t * 4) / 4
      if (spawnAt.at !== nowSec) {
        spawnAt.at = nowSec
        spawnAt.used = 0
      }
      let cursor = cursorRef.current
      // 游标落后太多（长时间暂停后拖动）：直接对齐
      while (cursor < list.length && list[cursor].time < t - 1) cursor++
      const blocked = blockList()
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
        const width = measure(text, fontKey, fontSize, bold)
        /*
         * 选道（v0.3.8）：**可用的道里优先"最久没用过的"**，都被占着就挑"最快腾出来"的。
         *
         * 为什么不能用"最上面那条空的"（老策略）：那样弹幕永远挤在顶部几条道里，
         * 把覆盖区域从整屏调到 1/4 也看不出任何变化 —— 用户报的"选了没反应"就是这个原因。
         * 现在每条道记住自己上次被用的时间，新弹幕优先落在"闲置最久"的那条道上，
         * 于是弹幕自然铺满整个允许区域，区域设置立刻看得见。
         */
        const laneCount = mode === 4 ? Math.max(1, Math.floor(h / lineH)) : lanes
        let best = -1
        let bestKey = Number.POSITIVE_INFINITY
        for (let i = 0; i < laneCount; i++) {
          const free = laneFreeIn(i, mode, t, w)
          if (free > 1.2) continue // 这条道还要等太久，换别的
          // 立刻可用（free<=0）→ 按"上次使用时间"排（越小越久没用过，越优先）
          // 需要等一会儿 → 按等待时间排（越快腾出来越优先），加个大常数保证排在可用道之后
          const key = free <= 0 ? (laneLastUsedRef.current[i] ?? 0) : 1e6 + free
          if (key < bestKey) {
            bestKey = key
            best = i
          }
        }
        if (best < 0) continue
        spawnAt.used++
        laneLastUsedRef.current[best] = Date.now()
        const item: ActiveItem = {
          text,
          color: c.color ?? '#ffffff',
          mode,
          lane: best,
          start: c.time,
          width,
          duration
        }
        itemsRef.current.push(item)
        if (mode !== 4 && best < laneLastRef.current.length) laneLastRef.current[best] = item
      }
      cursorRef.current = cursor

      // 排障探针（自检脚本读它）：能直接看出「时间对不对、有没有生成、画了几条、几条道」
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

      // 2) 绘制 + 回收
      const alive: ActiveItem[] = []
      ctx.globalAlpha = Math.min(1, Math.max(0.15, cfg.opacity))
      ctx.textBaseline = 'top'
      ctx.lineJoin = 'round'
      ctx.miterLimit = 2
      const stroke = cfg.outline !== false
      const shadow = cfg.shadow === true
      if (stroke) {
        ctx.lineWidth = Math.max(2, Math.round(fontSize / 8))
        ctx.strokeStyle = 'rgba(0,0,0,0.9)'
      }
      if (shadow) {
        // 阴影只在需要时开：每帧设置 shadowBlur 会让文字绘制变慢，默认关闭
        ctx.shadowColor = 'rgba(0,0,0,0.85)'
        ctx.shadowBlur = Math.max(2, Math.round(fontSize / 5))
        ctx.shadowOffsetY = 1
      }
      for (const it of itemsRef.current) {
        const age = t - it.start
        let x = 0
        let y = 0
        if (it.mode === 1) {
          const travel = w + it.width + 24
          x = w - (age / it.duration) * travel
          if (x + it.width < -8) continue // 已出画
          y = it.lane * lineH
        } else if (it.mode === 5) {
          if (age > FIXED_DURATION) continue
          y = it.lane * lineH
          x = Math.round((w - it.width) / 2)
        } else {
          if (age > FIXED_DURATION) continue
          y = h - (it.lane + 1) * lineH
          x = Math.round((w - it.width) / 2)
        }
        // 取整避免半像素字发虚（滚动位置本身仍是连续的，因为 x 是浮点算出来的）
        const px = it.mode === 1 ? x : x
        const py = Math.round(y)
        ctx.fillStyle = it.color
        if (stroke) ctx.strokeText(it.text, px, py)
        ctx.fillText(it.text, px, py)
        alive.push(it)
      }
      if (shadow) {
        ctx.shadowColor = 'transparent'
        ctx.shadowBlur = 0
        ctx.shadowOffsetY = 0
      }
      itemsRef.current = alive
      ctx.globalAlpha = 1
    }

    /** 帧驱动：优先 rAF；一旦发现 rAF 被降频就改用 16ms 定时器（并对 rAF 保持观察） */
    const frame = (): void => {
      const now = performance.now()
      const delta = now - lastFrameAt
      recentDeltas.push(delta)
      if (recentDeltas.length > 30) recentDeltas.shift()
      draw()
      const avg = recentDeltas.reduce((n, d) => n + d, 0) / Math.max(1, recentDeltas.length)
      if (avg > RAF_SLOW_MS && timer === null) {
        // rAF 被 Chromium 降频（透明置顶窗口的常见情况）：改由定时器推进，保证滚动顺滑
        timer = window.setInterval(draw, TIMER_FRAME_MS)
      } else if (avg <= RAF_SLOW_MS / 2 && timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
      raf = window.requestAnimationFrame(frame)
    }

    raf = window.requestAnimationFrame(frame)
    /*
     * 最后一道保险：万一 rAF 与定时器都被停掉（窗口被系统判定完全不可见），
     * 200ms 的定时器至少让画面跟上，不至于"只画一帧就冻住"。
     */
    const fallbackTimer = window.setInterval(() => {
      if (performance.now() - lastFrameAt > 500) draw()
    }, 200)
    return () => {
      window.cancelAnimationFrame(raf)
      if (timer !== null) window.clearInterval(timer)
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

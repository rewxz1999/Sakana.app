import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Camera,
  Cast,
  Crop,
  Expand,
  Info,
  ListVideo,
  LogOut,
  Maximize,
  MessageSquareOff,
  MessagesSquare,
  Minimize,
  Pause,
  Play,
  RectangleHorizontal,
  Rewind,
  FastForward,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Subtitles,
  TriangleAlert,
  Volume1,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import type { OverlayAction, OverlayDanmaku, OverlayEpisodes, OverlayState } from '@shared/api'
import type { Anime4kSettings, AspectMode, CastDevice, CastReceiverInfo, SubjectDetail } from '@shared/types'
import { ANIME4K_MODES, ANIME4K_TIERS } from '@shared/anime4k'
import { api } from '@/lib/api'
import { StreamInfoModal } from '@/components/StreamInfoModal'
import { PlayFlowStages, flowHeadline } from '@/components/PlayFlowProgress'
import { CoverImage } from '@/components/CoverImage'
import { DanmakuLayer } from '@/components/DanmakuLayer'

/**
 * 全屏控制栏悬浮窗（透明窗口内的控制栏）
 *
 * 原生视频窗口永远盖在网页之上，所以全屏时画面铺满整屏后，
 * 主窗口页面里的控制栏会被画面挡住 —— 控制栏必须画在这个独立的透明窗口里。
 * 本窗口默认点击穿透（鼠标移动仍会转发进来用于唤出控制栏），
 * 控制栏出现时才接收鼠标事件。
 */

const ASPECT_LABEL: Record<AspectMode, string> = {
  fit: '适应',
  cover: '裁剪铺满',
  stretch: '拉伸铺满'
}

/**
 * 画质按钮角标用的模式短名（v0.3.3）。
 * 直接从 `@shared/anime4k` 的模式表里取 `short`，与设置页、mpv 桥接脚本三处口径一致 ——
 * 不再手写一遍，免得以后加模式时漏改。
 */
const A4K_SHORT: Record<string, string> = Object.fromEntries(ANIME4K_MODES.map((m) => [m.id, m.short]))

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/**
 * 详情面板要显示的「详细信息」几行（v0.2.7 附加）。
 *
 * 播放器里的详情面板是唯一一份，但过去只有评分/日期/标签/简介 —— 用户明确要求
 * 「番剧详情等信息还是要有」。这里按关键度挑出常用几项（导演/脚本/原作/制作/音乐/平台…），
 * 数据全部来自详情页同一份缓存，不额外请求反代，也不删减详情页本身的展示。
 */
function detailRows(d: SubjectDetail): { key: string; value: string }[] {
  const score = (key: string): number => {
    const rules: [RegExp, number][] = [
      [/^(平台|话数|总集数)$/, 0],
      [/^(放送开始|上映|发售|播放结束)/, 1],
      [/^(导演|监督)/, 2],
      [/^(系列构成|脚本|分镜|演出)/, 3],
      [/^(原作|原案|人物设定)/, 4],
      [/^(动画制作|製作|制作|音乐制作)/, 5],
      [/^(音乐|主题歌)/, 6],
      [/^(播放电视台|官方网站)/, 7]
    ]
    for (const [re, n] of rules) if (re.test(key)) return n
    return 99
  }
  const rows = [...d.infobox]
  if (d.platform && !rows.some((r) => r.key === '平台')) rows.unshift({ key: '平台', value: d.platform })
  if (d.totalEpisodes && !rows.some((r) => r.key === '总集数')) {
    rows.push({ key: '总集数', value: String(d.totalEpisodes) })
  }
  return rows
    .filter((r) => score(r.key) < 99)
    .sort((a, b) => score(a.key) - score(b.key))
    .slice(0, 8)
    .map((r) => ({ key: r.key, value: typeof r.value === 'string' ? r.value : String(r.value) }))
}

/**
 * 音量滑杆（v0.2.9；v0.3.6 扩到 200%）。
 *
 * 用户要求：控制栏要能调音量，**不需要静音键**。
 * 所以这里没有「点一下静音」的行为 —— 图标只是当前音量档位的指示（拖到 0 自然就没声音），
 * 拖动过程中持续发送 setVolume；用 pointer capture 保证拖出滑杆外也不断。
 *
 * v0.3.6：滑杆上限从 100 提到 **200**。用户反馈「100% 也有点偏小」，
 * 主进程那边 `volume-max` 也同步抬到 200（不设那条 mpv 会把音量夹回 100）。
 * 100% 的位置画一条刻度线：**200 的滑杆如果没有任何标记，用户会以为拖到底才是正常音量**。
 */
const VOLUME_UI_MAX = 200

function VolumeSlider({ volume, onSet }: { volume: number; onSet: (v: number) => void }): React.ReactElement {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const v = Math.max(0, Math.min(VOLUME_UI_MAX, volume))
  /** 100% 在滑杆上的位置（百分比），用来画那条刻度线 */
  const hundredPct = 100 / (VOLUME_UI_MAX / 100)

  const applyFromEvent = (clientX: number): void => {
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const ratio = r.width > 0 ? (clientX - r.left) / r.width : 0
    onSet(Math.round(Math.max(0, Math.min(1, ratio)) * VOLUME_UI_MAX))
  }

  const Icon = v === 0 ? VolumeX : v > 50 ? Volume2 : Volume1
  return (
    <div className="ml-1 flex items-center gap-1.5" title={`音量 ${v}%`}>
      <Icon size={16} className="shrink-0 text-white/80" />
      <div
        ref={trackRef}
        data-sakana-volume={v}
        className="group relative flex h-6 w-[76px] cursor-pointer items-center"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.stopPropagation()
          /*
           * 指针捕获要用 try/catch 包住：合成事件（自检里 dispatch 的 PointerEvent）没有真实
           * pointerId，setPointerCapture 会抛 NotFoundError；抛出去会把整个拖动逻辑打断。
           */
          try {
            ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
          } catch {
            /* 忽略：拿不到捕获也不影响按位置计算音量 */
          }
          setDragging(true)
          applyFromEvent(e.clientX)
        }}
        onPointerMove={(e) => {
          if (!dragging) return
          e.stopPropagation()
          applyFromEvent(e.clientX)
        }}
        onPointerUp={(e) => {
          if (!dragging) return
          e.stopPropagation()
          setDragging(false)
          applyFromEvent(e.clientX)
        }}
        onPointerCancel={() => setDragging(false)}
      >
        <div className="h-1 w-full overflow-hidden rounded-full bg-white/25">
          {/* 填充宽度按 200 的满量程算；100% 处另画一条刻度（见 VOLUME_UI_MAX 的说明） */}
          <div className="h-full rounded-full bg-white/85" style={{ width: `${(v / VOLUME_UI_MAX) * 100}%` }} />
        </div>
        {/* 100% 刻度线：越过它就进入「增益」区，超过这个点才需要限幅器 */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-white/45"
          style={{ left: `${hundredPct}%` }}
        />
        <div
          className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow transition-opacity ${
            dragging ? 'opacity-100' : 'opacity-80 group-hover:opacity-100'
          }`}
          style={{ left: `calc(${(v / VOLUME_UI_MAX) * 100}% - 6px)` }}
        />
      </div>
      <span className="w-9 shrink-0 text-[11px] tabular-nums text-white/60">{v}%</span>
    </div>
  )
}

/** 倍速档位（与控制栏按钮里的显示顺序一致；播放页那份是给快捷键循环用的） */
const SPEED_CHOICES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]
const fmtSpeed = (s: number): string => `${Number.isInteger(s) ? s.toFixed(1) : s}x`

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * v0.3.9「按区域申请鼠标交互」——这是「控制栏按钮点击击穿」的根治办法
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ## 这个 bug 的成因（一句话）
 *
 * 画面是原生 mpv 子窗口、永远盖在网页之上，所以控制栏只能画在**另一个铺满整屏的透明窗口**里。
 * 过去那个窗口的"是否接收点击"是**整窗切换**的（控制栏显示 → 整窗接收点击；收起 → 整窗穿透）：
 *   · 整窗接收点击时，画面中部也在吃鼠标 —— mpv 收不到鼠标（点画面不能暂停、拖不动 uosc 进度条）；
 *   · 而"控制栏显示/收起"与"窗口的系统级穿透状态"之间总有几十~几百毫秒的时间差
 *     （5 秒自动隐藏、切集重建、窗口隐藏再显示、切后台再回来时最大），
 *     用户正好在这几十毫秒里点下去，事件就落到"看不见的网"上或者没人接 —— 按钮看得见、点了没反应。
 *
 * ## 现在的做法
 *
 * 悬浮窗**永远点击穿透**（`setIgnoreMouseEvents(true, { forward: true })`），
 * 鼠标每次移动就按当前位置做一次命中判定：落在"需要点的东西"上 → 临时关掉穿透；
 * 移开 → 立刻恢复穿透，鼠标还给 mpv。
 *
 * 于是：
 *   · 不再有"整窗吃鼠标"的状态，画面中部永远是 mpv 的；
 *   · 时间差从"控制栏显隐那个几百毫秒"缩短到"鼠标从按钮上移开的那一帧"，
 *     而且**判定用的是鼠标的真实位置**，不是"控制栏应该显示着"这种猜测。
 *
 * 实现约定（改 UI 时务必遵守）：
 *   1. **凡是需要点击的区域**（控制栏、顶栏、各种菜单/浮层、自检提示），
 *      容器上都要打 `data-sakana-hit`；不打 = 那块区域是穿透明（点了会落到 mpv 上）。
 *   2. 判定用 `document.elementFromPoint`，所以"看不见但还在 DOM 里"的元素不能算数 ——
 *      控制栏收起时用的 `pointer-events-none`（见渲染代码）正好让 elementFromPoint 跳过它，
 *      这就是"收起后立刻穿透"的实现方式，不需要额外同步状态。
 *   3. 拖动（进度条/音量）期间指针会被捕获、可能拖到区域外，用 `holdPointerRef` 锁住，
 *      别让判定在中途把点击收回 —— 那会让拖动断在手里。
 */
const HIT_ATTR = 'data-sakana-hit'

/**
 * 「只要求被画出来」的标记（v0.3.9 第六轮）。
 *
 * 为什么需要：`setShape` 的裁剪是**双向的** —— 区域之外"不画也不收鼠标"。
 * 某个纯提示容器若是 `pointer-events-none`（不该吃点击），只按"可点容器"上报就会被**裁掉不画**。
 * 所以凡"必须显示、但不参与命中"的容器都打这个标记，区域上报时**不看 pointer-events** 一律算进来。
 *
 * ⚠️ 第六轮修订的两条硬规矩（踩过坑，别再犯）：
 *   1. **居中/铺满整窗的提示不能放在 UI 窗口里**：它是居中的，一旦算进区域，**画面正中就落进窗口形状**
 *      → 那块像素的点击被 Electron 吃掉、mpv 收不到（实测回归：`画面中部不在形状里 = false`）。
 *      「加载中/过程进度」卡因此搬到了**穿透层（弹幕窗口）**去画 —— 那里不受形状裁剪、还永远不接收鼠标。
 *   2. 万一将来真有"整窗大小的 draw 容器"，收集时**只取它里面够大的子元素矩形**（见下面的实现）：
 *      整窗矩形永远不该进入形状，否则等于整窗吃鼠标。
 */
const DRAW_ATTR = 'data-sakana-draw'

/**
 * 弹出面板/菜单的标记（v0.3.9 第六轮）。
 *
 * 用户实测 ①「控制栏按钮选项被遮盖：画质、画面比例、弹幕设置、字幕、倍速」的根因是：
 * 这些 popover 是**挂在底栏容器里、但视觉上伸到容器上方**的（`absolute bottom-12`），
 * 而形状当时只收了底栏容器自己的矩形 —— 伸出去的那部分既被裁掉不画、也不收鼠标。
 * 所以每个 popover 既要 `data-sakana-hit`（参与命中与形状），又用这个标记把自己标出来，
 * 供自检**逐个面板**核对"打开后的矩形是否真的落在下发的形状里"。
 */
const POPOVER_ATTR = 'data-sakana-popover'

/** 命中判定结果：命中可点区域 / 贴着可点区域边缘 / 明显离开（见 zoneAt） */
type HitZone = 'hit' | 'near' | 'away'

/**
 * 迟滞窗口（v0.3.9 补充工单）。
 *
 * 为什么需要：命中判定由 mousemove 驱动，而"接收点击"要等一次 IPC 往返才真正生效。
 * 鼠标在按钮与它旁边的空隙之间移动时，判定可能在一帧之内从"命中"变成"没命中"，
 * 用户正好在那几十毫秒里点下去，事件就落到 mpv 上 —— 这就是用户报的「点击击穿」。
 * 所以：命中过一次之后，HIT_LATCH_MS 内**不因为一次"没命中"就切回穿透**（除非明显离开，见 HIT_NEAR_PX）。
 * 取 650ms（工单给的 600–800ms 区间偏下限）：窗口越短，鼠标离开控制栏后画面越早拿回鼠标。
 */
const HIT_LATCH_MS = 650

/**
 * "还贴着可点区域"的容差（px）。
 *
 * 距最近可点区域在这个距离之内不算"明显离开控制栏/浮层"，迟滞窗口内保持接收点击；
 * 一旦超出（例如鼠标已经跑到画面中部，或光标离开窗口）就**立刻**恢复穿透 ——
 * 否则会重新犯"画面中间点不动"的老毛病（`.e2e/run-overlay-hit-test.cmd` 第 2 条断言守着它）。
 */
const HIT_NEAR_PX = 24

/**
 * 可点区域矩形缓存的刷新间隔。
 * near 判定只在"没命中"时才用得上，而它需要读所有可点容器的布局 —— 缓存 200ms 足够，
 * 免得每个 mousemove 都触发一次强制布局（弹幕画布就在同一个渲染进程里）。
 */
const HIT_RECT_TTL_MS = 200

/**
 * 判定结果的**最小上报间隔**（v0.3.9 补充工单第二次修改）。
 *
 * 规则：**每一次判定都上报**，只按这个间隔节流（鼠标快速划过时每秒最多约 16 条 IPC）。
 *
 * 为什么不再用"只在结论变化时上报"（上一版的做法，也是这次 #3 回归的元凶）：
 *   渲染层本地记着"我上次报的是 true/false"，结论没变就不再发。但主进程那侧的状态**会因兜底判定
 *   独立变化**（窗口未聚焦时它按系统光标自己判），一旦两边不一致，渲染层就会因为"我这条结论没变"
 *   而永远不再上报 —— 结果是鼠标明明在按钮上、主进程却一直停在穿透态，点下去就是击穿。
 *   每条判定都上报（60ms 节流）之后，这种"不一致且自愈不了"的状态最多存在 60ms。
 */
const VERDICT_MIN_REPORT_MS = 60

/**
 * 指针坐标的**模块级**记录 + 收到的鼠标移动次数（v0.3.9 补充工单）。
 *
 * 为什么必须放在组件外面：
 *   ① 自检（以及真实场景里"刚进播放页 / 刚按 F 全屏"）会在 `did-finish-load` 之后**立刻**注入
 *      mouseMove，而那时 React 还没挂载完、window 上的 mousemove 监听还不存在 —— 事件直接丢掉，
 *      主进程永远等不到判定，用户在这一瞬间点下去就是击穿。
 *      模块级代码在 bundle 执行时就开始记录，组件挂载后立刻用它算一次判定。
 *   ② `overlayMoves` 是排查"渲染层到底有没有收到鼠标"的硬证据（主进程日志会带上它）。
 * 只在悬浮窗这一侧记录：主窗口也 import 了这个模块，那边记它没有意义。
 */
let earlyPointer: { x: number; y: number } | null = null
let overlayMoves = 0
if (api.overlay.isOverlay || window.location.hash.startsWith('#/overlay')) {
  window.addEventListener(
    'mousemove',
    (e) => {
      overlayMoves += 1
      earlyPointer = { x: e.clientX, y: e.clientY }
    },
    { passive: true }
  )
}

/**
 * 收到的鼠标点击统计（v0.3.9 第五轮）。
 *
 * 为什么必须与 `[overlay-hit] ACTION` 分开数：ACTION 数的是"动作到达主进程"，
 * 而"点击有没有进来"是另一回事 —— 落在控制栏**热区空白处**的点击（自动收起后那一帧、按钮之间的空隙、
 * 面板留白）会到达窗口但不会产生任何动作。只数 ACTION 时，"点击没到窗口"和
 * "点击到了但没落在按钮上"会混成同一个数字，无法定位（上一轮 8/39 说不清就是这个原因）。
 *   · down       —— 渲染层收到的 pointerdown 总数（这一下确实落进了 Electron 窗口）
 *   · onButton   —— 其中落在 `<button>` 上的（正常应 1:1 产生动作）
 *   · onHitBlank —— 落在可点容器上但不是按钮（热区空白 / 面板留白）
 *   · elsewhere  —— 落在别处（理论上不该出现）
 * 用捕获阶段统计：按钮自己 stopPropagation 也不影响计数。
 */
/**
 * 悬浮窗的透明底色**在模块加载时就立刻打上**（v0.3.9 第六轮，用户实测 ④ 的修复之一）。
 *
 * 为什么不能只在组件里用 `useEffect` 打标记（原来的做法）：
 *   · effect 在**首次绘制之后**才跑 —— 这一段时间里 `body` 还是 `background: var(--bg)`
 *     （曜石黑主题 = 不透明 #0c0d0f），而弹幕窗口是**铺满整屏、位于主窗口之上**的，
 *     于是整屏会被一块不透明底色盖住（用户看到的「一片黢黑」）；
 *   · 而且那个 effect 的 cleanup 会在卸载时**移除**标记 —— 恰好是"播放页重建"这条路上
 *     最需要它的时候。
 * 现在：模块作用域立刻加（早于 React 首次渲染），并且**永不移除**；同时直接写内联样式兜底，
 * 不依赖 CSS 类是否命中（表里两层都保住"画面上没有不透明底色"这件事）。
 */
if (api.overlay.isOverlay) {
  const root = document.documentElement
  root.classList.add('sakana-overlay')
  root.style.background = 'transparent'
  const setBody = (): void => {
    document.body.classList.add('sakana-overlay')
    document.body.style.background = 'transparent'
  }
  if (document.body) setBody()
  else document.addEventListener('DOMContentLoaded', setBody, { once: true })
}

const overlayClicks = {
  down: 0,
  onButton: 0,
  onHitBlank: 0,
  elsewhere: 0,
  byTitle: {} as Record<string, number>
}
if (api.overlay.isOverlay && !window.location.hash.includes('part=danmaku')) {
  window.addEventListener(
    'pointerdown',
    (e) => {
      overlayClicks.down += 1
      const el = e.target as HTMLElement | null
      const btn = el?.closest?.('button') ?? null
      if (btn) {
        overlayClicks.onButton += 1
        // 按 title / 文本归类：便于回答"某个按钮系统性丢"还是"连点太快被吞"
        const key = btn.getAttribute('title') || (btn.textContent ?? '').trim().slice(0, 12) || '(untitled)'
        overlayClicks.byTitle[key] = (overlayClicks.byTitle[key] ?? 0) + 1
      } else if (el?.closest?.(`[${HIT_ATTR}]`)) {
        overlayClicks.onHitBlank += 1
      } else {
        overlayClicks.elsewhere += 1
      }
    },
    true
  )
}

/** 拖动进度条时下发 seek 的最小间隔（ms），见 seekTo 的说明 */
const SEEK_THROTTLE_MS = 120

/** 主进程（playerOverlay.ts）会通过这几个全局函数按需查询命中结果与可交互区域 */
interface HitProbeWindow extends Window {
  __sakanaHitAt?: (x: number, y: number) => boolean
  __sakanaHitLocked?: boolean
  __sakanaOverlayVisible?: boolean
  /** 判定细节（zone / 迟滞拦住次数 / 收到多少次鼠标移动…）：主进程读它写日志，不新增 IPC 通道 */
  __sakanaHitDiag?: () => {
    zone: HitZone
    verdict: boolean
    locked: boolean
    latched: number
    msSinceHit: number
    moves: number
  }
  /** 主进程兜底判定用的快照（降级回退与诊断）：可点矩形 + 拖动锁 + 当前判定 */
  __sakanaHitSnapshot?: () => {
    rects: { x: number; y: number; w: number; h: number; hittable: boolean }[]
    locked: boolean
    verdict: boolean
    zone: HitZone
    moves: number
  }
  /**
   * **可交互区域**（v0.3.9 第三轮）：这组矩形就是 UI 窗口的**窗口形状** ——
   * 区域内的点击由 Electron 窗口接手，区域外的点击由操作系统直接透给下面的 mpv 子窗口。
   * 命中判定交给 OS，就没有"切换时机"这件事了（用户实测切换式方案 46% 点击落空）。
   */
  __sakanaHitRegions?: () => { x: number; y: number; w: number; h: number }[]
  /**
   * 收到的点击统计（v0.3.9 第五轮）：把"点击没到窗口"与"到了但没落在按钮上"分开计数。
   * 主进程会把它打进 `[overlay-hit] STATS` 行，ps1 据此做分段统计。
   */
  __sakanaClickStats?: () => {
    down: number
    onButton: number
    onHitBlank: number
    elsewhere: number
    byTitle: Record<string, number>
  }
  /**
   * "这次区域为什么是空的"的自述（v0.3.9 第六轮）：主进程只在区域为空时问一次。
   * `uosc: true` 才允许隐藏窗口；其它原因一律走退化兜底（见 playerOverlay 的 NEVER_DEAD_STATE）。
   */
  __sakanaRegionsDiag?: () => {
    ready: boolean
    uosc: boolean
    hasTopBar: boolean
    hasBottomBar: boolean
    hitCount: number
    barVisible: boolean
    regions: number
  }
  /**
   * 逐个面板自检（v0.3.9 第六轮）：打开每个能从控制栏打开的面板/菜单，
   * 核对"它打开后的真实矩形是否落在下发的形状里"。返回每一项的判定与缺口比例。
   */
  __sakanaPanelProbe?: () => Promise<
    {
      kind: 'popover' | 'overlay'
      title: string
      found: boolean
      covered: boolean
      rect: { x: number; y: number; w: number; h: number } | null
      missing: number
      reason: string
    }[]
  >
}

/**
 * 悬浮窗角色（v0.3.9 第三轮拆窗口）：
 *   · `ui`      —— 控制栏与所有面板：铺满主窗口 + `setShape` 限定可点区域 + **一直接收鼠标**；
 *   · `danmaku` —— 弹幕：铺满主窗口、**永久穿透**（`setIgnoreMouseEvents(true,{forward:true})`）。
 * 为什么必须拆：`setShape` 会同时裁剪绘制，铺满画面中部的弹幕会被裁掉；
 * 而"整窗接收鼠标"又会把画面上的点击全吃掉。详见 playerOverlay.ts 文件头。
 */
type OverlayPart = 'ui' | 'danmaku'

/** 顶栏/底栏容器（控制栏"热区"）：它们即使自动收起也**必须留在可交互区域里**，否则控制栏唤不出来 */
const TOPBAR_SEL = '[data-sakana-topbar]'
const BOTTOMBAR_SEL = '[data-sakana-bottombar]'

/** 键位提示小胶囊（自救浮层里用；JSX 里不能写 Markdown，键位要用样式标出来） */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 rounded border border-white/25 bg-white/10 px-1 font-mono text-[10px] text-white">
      {children}
    </kbd>
  )
}

/** 弹幕设置面板里的小胶囊按钮（v0.2.8） */
function Chip({
  active,
  onClick,
  children
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        onClick()
      }}
      className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
        active ? 'border-accent bg-accent/30 text-white' : 'border-white/20 text-white/70 hover:bg-white/10'
      } whitespace-nowrap `}
    >
      {children}
    </button>
  )
}

/** 弹幕区域：视频矩形往里收，避开顶部标题栏与底部控制栏（v0.2.8） */
const DANMAKU_TOP_GAP = 58
const DANMAKU_BOTTOM_GAP_VISIBLE = 104
const DANMAKU_BOTTOM_GAP_HIDDEN = 26

function danmakuRect(
  state: OverlayState,
  controlsVisible: boolean
): { x: number; y: number; width: number; height: number } {
  const r =
    state.videoRect ??
    ({ x: 0, y: 56, width: window.innerWidth, height: Math.max(120, window.innerHeight - 112) } as const)
  const bottomGap = controlsVisible ? DANMAKU_BOTTOM_GAP_VISIBLE : DANMAKU_BOTTOM_GAP_HIDDEN
  return {
    x: r.x,
    y: r.y + DANMAKU_TOP_GAP,
    width: r.width,
    height: Math.max(80, r.height - DANMAKU_TOP_GAP - bottomGap)
  }
}

/** 弹幕设置面板的一行：左侧标签 + 右侧一组胶囊 */function SettingRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] text-white/55">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  )
}

function IconBtn({
  title,
  onClick,
  children,
  active
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
  active?: boolean
}) {
  return (
    <button
      title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        onClick()
      }}
      className={`flex h-10 w-10 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/20 hover:text-white active:bg-white/30 ${
        active ? 'bg-white/20 text-white' : ''
      } whitespace-nowrap `}
    >
      {children}
    </button>
  )
}

export default function PlayerOverlay(): React.ReactElement {
  const [state, setState] = useState<OverlayState | null>(null)
  /**
   * 本窗口的角色（v0.3.9 第三轮拆窗口）：主进程用 `#/overlay?part=ui|danmaku` 加载两块窗口，
   * 这里按 part 决定渲染哪一半 —— 弹幕窗口只画弹幕，UI 窗口画控制栏与所有面板。
   */
  const location = useLocation()
  const part: OverlayPart = new URLSearchParams(location.search).get('part') === 'danmaku' ? 'danmaku' : 'ui'
  const isDanmakuPart = part === 'danmaku'
  const [episodes, setEpisodes] = useState<OverlayEpisodes | null>(null)
  /** v0.2.8：弹幕数据与设置（由播放页推送，换集/改设置时更新） */
  const [danmaku, setDanmaku] = useState<OverlayDanmaku | null>(null)
  const [danmakuMenu, setDanmakuMenu] = useState(false)
  const [visible, setVisible] = useState(false)
  const [subMenu, setSubMenu] = useState(false)
  const [aspectMenu, setAspectMenu] = useState(false)
  // v0.2.9 最后更新：倍速菜单
  const [speedMenu, setSpeedMenu] = useState(false)
  /**
   * 画质（Anime4K）菜单与当前设置（v0.3.3）。
   *
   * 为什么悬浮窗要自己读一遍 settings：超分设置存在主进程，而这里要显示角标
   * （开着时显示当前模式 A/B/C…）。挂载时读一次，打开菜单时再读一次保证是最新的；
   * 改动写回 settings 后主进程的 store 钩子会立刻重挂着色器链 —— 播放中即时生效。
   */
  const [qualityMenu, setQualityMenu] = useState(false)
  /**
   * 「疑似点击击穿」自救浮层（v0.3.6）。
   *
   * 用户反馈：控制栏按钮偶尔点了没反应，而且**没法自救**（连 Esc 也没用，因为那时焦点在
   * mpv 的窗口上、应用侧快捷键收不到）。主进程侦测到「鼠标落在悬浮窗上、但连按三次都没点到按钮」
   * 之后会发一条事件过来，这里弹一个小浮层告诉用户两条逃生路线：
   * **按 F 重新全屏一次**（强制重建视频子窗口与悬浮窗的几何关系）或 **Esc 退出播放器**。
   * 为什么这两条有用、以及这个 bug 的成因，写在 playerOverlay.ts 的 noteOverlayMissedClick 上面。
   */
  const [clickThrough, setClickThrough] = useState(false)
  const [a4k, setA4k] = useState<Anime4kSettings>({})
  const [showInfo, setShowInfo] = useState(false)
  /** 选集浮层里正在查看的线路（悬浮窗本地状态，切换线路不打断播放） */
  const [browseLine, setBrowseLine] = useState(0)
  /**
   * 投屏（v0.3.8）：面板开关、设备列表、手动填的地址、投屏中的设备与它的状态。
   *
   * 为什么投屏 UI 在悬浮窗里：画面是原生子窗口，画在播放页里的面板会被它整个盖住
   * （选集/详情面板都因为同一个原因放在这里）。开始投屏这个动作则**发回播放页**执行 ——
   * "这一集是什么地址 / Referer / 播放列表"只有播放页知道。
   */
  const [castPanel, setCastPanel] = useState(false)
  const [castDevices, setCastDevices] = useState<CastDevice[]>([])
  const [castDevice, setCastDevice] = useState<CastDevice | null>(null)
  const [castInfo, setCastInfo] = useState<CastReceiverInfo | null>(null)
  /** 番剧详情（打开详情浮层时自己去拉，避免主窗口往高频状态里塞大对象） */
  const [detail, setDetail] = useState<SubjectDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const hideTimer = useRef<number | undefined>(undefined)
  const seekRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  /**
   * 拖动中的进度（0~100）。为 null 表示"没在拖"，显示跟随内核真实进度。
   * 为什么要有本地值：见下面 `shownPercent` 的说明 —— 拖动时不能再被回推的进度覆盖。
   */
  const [dragPercent, setDragPercent] = useState<number | null>(null)
  /** 上一次真的发出 seek 的时刻（节流用，见 seekTo） */
  const lastSeekAtRef = useRef(0)
  /** 菜单/浮层打开期间禁止自动隐藏（否则 5 秒后控制栏收起，浮层就点不动了） */
  const holdRef = useRef(false)

  const send = useCallback((action: OverlayAction) => {
    api.overlay.action(action)
  }, [])

  // ---------------- v0.3.9：按区域申请鼠标交互（见 HIT_ATTR 上面那段说明） ----------------

  /** 最后一次已知的光标位置（CSS 像素，悬浮窗客户区）；null = 还没收到过坐标/已离开 */
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  /** 当前是否已经申请了"接收点击"（只在**变化**时发 IPC，不再每次 mousemove 都发） */
  const interactiveRef = useRef(false)
  /**
   * 指针按下期间的锁（拖动进度条/音量时用）。
   *
   * 为什么必须锁：指针被捕获后可以拖出控制栏（甚至拖到窗口外），
   * 那时如果还按命中结果收回点击，鼠标事件会当场断掉 —— 表现就是"拖一半拖不动了"。
   */
  const holdPointerRef = useRef(false)
  /** 上次"真的命中可点区域"的时刻（迟滞窗口的起点，见 syncInteractive） */
  const lastHitAtRef = useRef(0)
  /** 被迟滞拦住的次数（本该收回点击、按迟滞规则先留着）：主进程轮询读它写日志 */
  const latchedBlocksRef = useRef(0)
  /** 可点区域矩形缓存（只有"没命中"时才要算距离，刷新间隔见 HIT_RECT_TTL_MS） */
  const hitRectsRef = useRef<{ at: number; rects: DOMRect[] }>({ at: 0, rects: [] })
  /** 最近一次判定得到的 zone（诊断与主进程日志用） */
  const lastZoneRef = useRef<HitZone>('away')
  /** 最近一次上报判定结果的时刻（心跳节流，见 VERDICT_HEARTBEAT_MS） */
  const lastReportAtRef = useRef(0)

  /**
   * 该点是否贴在某块可点区域边缘（HIT_NEAR_PX 之内）。
   *
   * 只用来**保持**已经申请到的"接收点击"，绝不用来开启（见 syncInteractive）：
   * 否则控制栏周围会多出一圈 24px 的隐形吃鼠标带，画面中部附近就点不动 mpv 了。
   */
  const nearHitRegion = useCallback((x: number, y: number): boolean => {
    const now = Date.now()
    const cache = hitRectsRef.current
    if (now - cache.at > HIT_RECT_TTL_MS) {
      const rects: DOMRect[] = []
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${HIT_ATTR}]`))) {
        // 控制栏收起时容器带 pointer-events:none —— 那种区域不算数，否则"看不见的网"会被当成邻域，
        // 鼠标一移开就再也回不到穿透态（正是用户抱怨过的"画面中间点不动"）。
        if (getComputedStyle(el).pointerEvents === 'none') continue
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        rects.push(r)
      }
      hitRectsRef.current = { at: now, rects }
    }
    for (const r of hitRectsRef.current.rects) {
      if (
        x >= r.left - HIT_NEAR_PX &&
        x <= r.right + HIT_NEAR_PX &&
        y >= r.top - HIT_NEAR_PX &&
        y <= r.bottom + HIT_NEAR_PX
      ) {
        return true
      }
    }
    return false
  }, [])

  /**
   * 命中判定（**唯一判据**：渲染层的 mousemove 与主进程的光标轮询都走这里）：
   *   · 'hit'  —— 该点上最上层的元素落在某个 `data-sakana-hit` **容器**里。
   *              标记打在容器上（顶栏/底栏/各种浮层，见 HIT_ATTR 约定 1），
   *              所以按钮之间的空隙、容器的内边距、进度条两侧的空白同样算命中；
   *              这里用 `closest` 向上找最近的标记祖先，命中按钮本身也归到它所在的容器。
   *   · 'near' —— 没命中，但仍在可点区域边缘 HIT_NEAR_PX 之内（鼠标刚滑出控制栏那种位置）。
   *   · 'away' —— 明显离开（画面中部、窗口外…）。
   * 顺序：先 elementFromPoint（它自己会跳过 pointer-events:none 的元素 —— 控制栏收起时正是靠这个
   * 立刻变回穿透），只有"没命中"时才去算与区域矩形的距离（贵，别在热路径上白算）。
   */
  const zoneAt = useCallback(
    (x: number, y: number): HitZone => {
      const el = document.elementFromPoint(x, y)
      const zone: HitZone = el && el.closest(`[${HIT_ATTR}]`) ? 'hit' : nearHitRegion(x, y) ? 'near' : 'away'
      lastZoneRef.current = zone
      return zone
    },
    [nearHitRegion]
  )

  /**
   * 判定并把结果同步给主进程。
   *
   * ⚠️ v0.3.9 第三轮：**"吃不吃鼠标"已经不由这个判定决定了** —— 那是 UI 窗口形状的事（OS 判定，
   * 见 `__sakanaHitRegions`）。这条上报现在的职责是：
   *   · 告诉主进程"渲染层有话要说"（主进程据此立刻重新拉一次可交互区域，窗口形状跟着控制栏显隐更新）；
   *   · 诊断（谁能看清"渲染层收到了几次鼠标"）；
   *   · 以及在没有 `setShape` 的平台上的降级回退（那时它仍然决定吃不吃鼠标）。
   * 三条规则（命中 / 贴边 24px 迟滞 / 明显离开）保持不变。
   */
  const syncInteractive = useCallback((): void => {
    // 弹幕窗口不上报：它永久穿透，没有任何可交互元素（报了只会污染主进程的诊断与回退判定）
    if (isDanmakuPart) return
    const p = pointerRef.current
    /*
     * 没有可用坐标时**不下结论**（保持上一次的结果）。
     *
     * 为什么：`mouseleave` / `mouseout(relatedTarget=null)` 会把坐标标记为失效，而那两个事件在
     * `forward: true` 下光标滑到原生 mpv 子窗口上时也会发 —— 若在这里按 null 上报"收回点击"，
     * 就又会重演"鼠标移到画面上那一帧被判穿透"的横跳（用户实测的击穿）。
     * "光标是否已离开悬浮窗"由主进程按窗口矩形判定（唯一权威，见 pollCursorHit）。
     * 拖动中例外：指针被捕获，此时必须保持接收点击，否则拖到窗外就断在手里。
     */
    if (!p && !holdPointerRef.current) return
    let want = holdPointerRef.current
    if (!want && p) {
      const zone = zoneAt(p.x, p.y)
      if (zone === 'hit') {
        want = true
        lastHitAtRef.current = Date.now()
      } else if (zone === 'near') {
        // 只"保持"不"开启"：贴着边缘不算命中
        const latched = interactiveRef.current && Date.now() - lastHitAtRef.current <= HIT_LATCH_MS
        if (latched) latchedBlocksRef.current += 1
        want = latched
      }
    }
    const now = Date.now()
    /*
     * **每一次判定都上报**（只按 VERDICT_MIN_REPORT_MS 节流），不再"结论没变就不吭声"：
     *   · 主进程据此知道"渲染层还活着、当前判定是这个"，能区分"渲染层说穿透"与"渲染层没收到鼠标"；
     *   · 更重要的是：主进程兜底判定会独立改状态，若渲染层还按"我这条没变"而静默，
     *     两边就会永久不一致（鼠标在按钮上、窗口却停穿透态）—— 每次判定都上报把这个窗口压到 60ms。
     */
    if (now - lastReportAtRef.current < VERDICT_MIN_REPORT_MS) return
    lastReportAtRef.current = now
    interactiveRef.current = want
    void api.overlay.setInteractive(want).then(
      (r) => {
        // IPC 返回失败（窗口正在销毁等）就把本地状态退回去，下一次事件会重发 ——
        // 否则本地以为"已经申请到接收点击了"，之后同样的判定不再发送，按钮就永远点不动了。
        if (!r.ok) interactiveRef.current = !want
      },
      () => {
        interactiveRef.current = !want
      }
    )
  }, [zoneAt, isDanmakuPart])

  /**
   * 算出"交给主进程做窗口形状"的**可交互区域**（v0.3.9 第三轮的核心）。
   *
   * 规则（改 UI 时务必遵守）：
   *   ① `data-sakana-topbar` / `data-sakana-bottombar` 两块控制栏容器 —— 只要它们带 `data-sakana-hit`
   *      （= 应用自己画控制栏、不是 uosc 接管），就**始终**算在内，包括自动收起的时候：
   *      窗口形状就是渲染层能收到鼠标的范围，若把它们去掉，鼠标移到底部时渲染层收不到事件，
   *      控制栏就永远唤不出来（死锁）；
   *   ② 其他 `data-sakana-hit` 容器（面板/浮层/提示）：只算**当前可点**的（`pointer-events !== none`），
   *      它们的矩形本身就是"面板的确切范围"；
   *   ③ 已经被已有区域完全包住的矩形不再重复上报（形状块数越少，系统开销越小）；
   *   ④ 容器自己没有尺寸时（子元素是 fixed 定位的浮层，例如流详情弹窗）退一步量它的一级子元素。
   *   ⑤ `data-sakana-draw` 的容器（例如"加载中/过程进度"提示）**不看 pointer-events 一律算进来** ——
   *      形状同时决定"画什么"，漏了它就会被裁掉不画（用户实测 ④ 的黑屏就是这么来的）。
   *   ⑥ 容器里**伸到容器外面**的可点后代（popover/菜单，`absolute bottom-12` 那种）单独补一块矩形 ——
   *      否则它们伸出去的部分既不画也不收鼠标（用户实测 ①「画质/画面比例/弹幕设置/字幕/倍速被遮盖」）。
   * uosc 接管控制栏时应用没有任何交互元素 → 返回空数组 → 整块区域交还给 mpv
   * （主进程据此**允许隐藏**窗口；其它原因的空区域一律走退化兜底，绝不隐藏 —— 见 playerOverlay 的
   *  NEVER_DEAD_STATE 说明与 `__sakanaRegionsDiag`）。
   */
  const hitRegionsNow = useCallback((): { x: number; y: number; w: number; h: number }[] => {
    const out: { x: number; y: number; w: number; h: number }[] = []
    const addRect = (rect: DOMRect): void => {
      if (rect.width < 2 || rect.height < 2) return
      const r = { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
      const contained = out.some(
        (o) => r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h
      )
      if (!contained) out.push(r)
    }
    const addElement = (el: HTMLElement): void => {
      const own = el.getBoundingClientRect()
      if (own.width >= 2 && own.height >= 2) {
        addRect(own)
        return
      }
      for (const child of Array.from(el.children)) addRect(child.getBoundingClientRect())
    }
    /**
     * 把"伸到容器外"的浮层补进来（见规则 ⑥）。
     *
     * 只认 `position: absolute | fixed` 的后代：按钮、图标这些 static 元素永远在容器内，
     * 把它们全量算一遍既慢又没有意义。用 `[class~="absolute"]` 做预筛（Tailwind 的 `absolute`
     * 就是 class 列表里的一个词），再按"是否真的伸出去 + 是否可点 + 是否有尺寸"三个条件确认。
     */
    const addOverflowing = (root: HTMLElement, base: DOMRect): void => {
      const candidates = root.querySelectorAll<HTMLElement>('[class~="absolute"], [class~="fixed"]')
      for (const el of Array.from(candidates)) {
        const r = el.getBoundingClientRect()
        if (r.width < 8 || r.height < 8) continue
        if (getComputedStyle(el).pointerEvents === 'none') continue
        const inside =
          r.left >= base.left - 0.5 && r.top >= base.top - 0.5 && r.right <= base.right + 0.5 && r.bottom <= base.bottom + 0.5
        if (inside) continue
        addRect(r)
      }
    }
    const top = document.querySelector<HTMLElement>(TOPBAR_SEL)
    const bottom = document.querySelector<HTMLElement>(BOTTOMBAR_SEL)
    // ① 控制栏热区（顶栏在 uosc 模式下没有 data-sakana-hit，那时不算）
    if (top?.hasAttribute(HIT_ATTR)) {
      addElement(top)
      addOverflowing(top, top.getBoundingClientRect())
    }
    if (bottom?.hasAttribute(HIT_ATTR)) {
      addElement(bottom)
      addOverflowing(bottom, bottom.getBoundingClientRect())
    }
    // ② 其余可点容器（面板/浮层/提示）
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${HIT_ATTR}]`))) {
      if (el === top || el === bottom) continue
      if (getComputedStyle(el).pointerEvents === 'none') continue
      addElement(el)
      addOverflowing(el, el.getBoundingClientRect())
    }
    // ⑤ 只要求"被画出来"的容器：不看 pointer-events（否则会被形状裁掉 → 加载提示/错误条消失）。
    //    **整窗大小的 draw 容器只取它里面够大的子元素**：整窗矩形进形状 = 整窗吃鼠标（见 DRAW_ATTR 的说明）。
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${DRAW_ATTR}]`))) {
      /* 窗口尺寸用 window.innerWidth/Height（CSS 像素，与 getBoundingClientRect 同单位，读的是当下值） */
      const vw = window.innerWidth || 1
      const vh = window.innerHeight || 1
      const own = el.getBoundingClientRect()
      const spansWindow = own.width >= vw * 0.8 && own.height >= vh * 0.8
      if (!spansWindow) {
        addElement(el)
        continue
      }
      let added = 0
      for (const child of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
        const r = child.getBoundingClientRect()
        if (r.width < 8 || r.height < 8) continue
        if (r.width >= vw * 0.8 && r.height >= vh * 0.8) continue
        addRect(r)
        added += 1
      }
      if (added === 0) {
        /* 里面没有可用的子元素（例如只有一个铺满的画布）：这时**宁可什么都不加** ——
           "少画一点提示"远好于"把整块画面从 mpv 手里抢走"。 */
        console.warn('[overlay] data-sakana-draw 容器铺满整窗且没有子元素，已跳过（不把整窗放进形状）')
      }
    }
    /*
     * ⑦ V1.1.1：**开着的浮层无条件并进形状**（用户报「所有控制栏按钮唤出的菜单都被播放器内容遮住」）。
     *
     * 规则 ②/⑥ 已经在管浮层，但它们各自带前提：②要求 `pointer-events !== none`，
     * ⑥只认 class 里带 `absolute`/`fixed` 这个词的后代。任何一个前提在某次改 UI 时不成立，
     * 浮层就会**既不画也不收鼠标**，而露出来的正是下面的原生视频 —— 用户看到的
     * "菜单被播放器内容遮住"就是它。这条兜底不看 class、不看 pointer-events，
     * 只问一句"它现在是不是真的可见"（`checkVisibility` 会把祖先的 display/opacity/visibility 一起算进来），
     * 可见就把它占的那块地方放进形状。**形状只会多不会少**，不会出现"凭空多出一块吃鼠标的区域"
     * 那种反向问题（不可见的浮层仍然会被排除）。
     */
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${POPOVER_ATTR}]`))) {
      const r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) continue
      const visible =
        typeof el.checkVisibility === 'function'
          ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          : getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden'
      if (!visible) continue
      addRect(r)
    }
    return out
  }, [])

  /**
   * 向主进程暴露命中查询（见 playerOverlay.ts 的 probeOverlayHit）。
   *
   * 主进程这一问有**两个**作用：
   *   ① 把"真实光标在哪"告诉渲染层（合成事件到不了的地方，例如按 F 全屏后光标一直没动过）；
   *   ② 让渲染层按这个坐标**重新判定一次**。
   * 外加两个只读接口（都用 executeJavaScript 读，不往 preload 契约里加通道）：
   *   · `__sakanaHitDiag()` —— zone / 迟滞拦住次数 / 收到多少次鼠标移动（排查用）；
   *   · `__sakanaHitSnapshot()` —— 可点矩形 + 拖动锁 + 当前判定，供**主进程在渲染层收不到
   *     鼠标事件时自己判定**（窗口未聚焦时就是这种情况，见 playerOverlay.ts 的说明）。
   */
  useEffect(() => {
    const w = window as HitProbeWindow
    w.__sakanaHitAt = (x: number, y: number): boolean => {
      pointerRef.current = { x, y }
      syncInteractive()
      // 返回值只表示"这个点上是否有可点区域"（拖动中恒为 true），供主进程诊断与日志使用
      return holdPointerRef.current || zoneAt(x, y) === 'hit'
    }
    w.__sakanaHitDiag = () => ({
      zone: lastZoneRef.current,
      verdict: interactiveRef.current,
      locked: holdPointerRef.current,
      latched: latchedBlocksRef.current,
      msSinceHit: lastHitAtRef.current > 0 ? Date.now() - lastHitAtRef.current : -1,
      moves: overlayMoves
    })
    w.__sakanaHitSnapshot = () => ({
      rects: Array.from(document.querySelectorAll<HTMLElement>(`[${HIT_ATTR}]`)).map((el) => {
        const r = el.getBoundingClientRect()
        return {
          x: r.left,
          y: r.top,
          w: r.width,
          h: r.height,
          // 控制栏收起时容器带 pointer-events:none —— 那种区域此刻不可点，主进程也不该拿它当命中区
          hittable: getComputedStyle(el).pointerEvents !== 'none' && r.width >= 2 && r.height >= 2
        }
      }),
      locked: holdPointerRef.current,
      verdict: interactiveRef.current,
      zone: lastZoneRef.current,
      moves: overlayMoves
    })
    /*
     * 可交互区域（= UI 窗口的窗口形状）。主进程在渲染层每次上报后立刻拉一次，
     * 所以控制栏显隐、面板开合都会在几毫秒内反映到形状上 —— 不需要新增 IPC 通道。
     */
    w.__sakanaHitRegions = () => hitRegionsNow()
    /** 点击统计（主进程打进 STATS 行；ps1 按阶段取差值，用来区分"没到窗口"与"没落在按钮上"） */
    w.__sakanaClickStats = () => ({ ...overlayClicks, byTitle: { ...overlayClicks.byTitle } })
    /**
     * "这次区域为什么是空的"的自述（v0.3.9 第六轮）。
     *
     * 主进程只在**区域为空**时问一次，用来区分两种情况：
     *   · `uosc: true` —— 控制栏交给 mpv 画，应用确实没有任何可交互元素 → **允许隐藏窗口**
     *     （整块交还 mpv，这是设计意图）；
     *   · 其它一切（页面还没就绪 / 控制栏还没渲染出来 / 控制栏正自动收起）→ 主进程**退化兜底**
     *     （沿用上一份区域或整窗形状），绝不隐藏 —— 否则形状裁剪会把控制栏和加载提示一起裁没。
     */
    w.__sakanaRegionsDiag = () => {
      const top = document.querySelector<HTMLElement>(TOPBAR_SEL)
      const bottom = document.querySelector<HTMLElement>(BOTTOMBAR_SEL)
      /*
       * uosc 判定**只看 DOM**（不看 React state）：与区域收集用的是同一个条件 ——
       * 两条控制栏都存在、但谁都没带 `data-sakana-hit`，就是"控制栏交给 mpv 画"。
       * 顺便避免了在 effect 闭包里读 state 的过期值问题。
       */
      const uosc = !!(top || bottom) && !top?.hasAttribute(HIT_ATTR) && !bottom?.hasAttribute(HIT_ATTR)
      return {
        ready: true,
        uosc,
        hasTopBar: !!top,
        hasBottomBar: !!bottom,
        hitCount: document.querySelectorAll(`[${HIT_ATTR}]`).length,
        /* 控制栏自动收起时容器带 pointer-events:none —— 直接量 DOM，不依赖 React 闭包 */
        barVisible: !!bottom && getComputedStyle(bottom).pointerEvents !== 'none',
        regions: hitRegionsNow().length
      }
    }
    /**
     * **逐个面板**核对"打开后的矩形是否落在下发的形状里"（v0.3.9 第六轮，用户实测 ①）。
     *
     * 为什么要做成浏览器里的自检而不是只看静态标记：形状是**算出来的**（起点是 DOM 实测矩形），
     * 标记打得对不对只有比对"打开后的真实矩形 vs 上报区域"才算数。这里对每个能从控制栏打开的
     * 面板/菜单：派发一次 `pointerdown` 打开它 → 等两帧让 React 把 DOM 落下去 → 读它自己和
     * `__sakanaHitRegions()` → 判断"完全被区域覆盖" → 再派发一次关掉。
     * 返回的每一项都带 `missing`（伸到区域外的面积比例），自检据此给出可定位的失败信息。
     */
    w.__sakanaPanelProbe = async (): Promise<
      {
        kind: 'popover' | 'overlay'
        title: string
        found: boolean
        covered: boolean
        rect: { x: number; y: number; w: number; h: number } | null
        missing: number
        reason: string
      }[]
    > => {
      const frames = (n: number): Promise<void> =>
        new Promise((resolve) => {
          let left = n
          const step = (): void => {
            left -= 1
            if (left <= 0) resolve()
            else requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        })
      /**
       * 打开面板的触发按钮：按 title **包含**匹配（标题里有动态数值，例如「画面比例：适应」「画质…：模式 A」）。
       *
       * `drive` 记录这个面板是**谁**在驱动（读代码逐个确认过），它决定"点了没反应"该怎么定性：
       *   · `local`   —— 面板由渲染层自己的 React state 打开（setSubMenu/setSpeedMenu/…/setShowInfo），
       *     按钮点下去**必须**立刻出现浮层；没出现就是真 FAIL；
       *   · `session` —— 面板由**主进程的播放会话状态**打开（`send({type:'toggleEpisodes'|'toggleInfo'})`），
       *     自检环境里没有真实播放会话，点下去本来就不会有反应 → 如实标 SKIP，
       *     不能以 FAIL 的形式留在报告里（用户要求能区分"产品坏了"与"环境测不了"）。
       */
      const triggers: { kind: 'popover' | 'overlay'; match: string; drive: 'local' | 'session' }[] = [
        { kind: 'popover', match: '字幕', drive: 'local' },
        { kind: 'popover', match: '播放倍速', drive: 'local' },
        { kind: 'popover', match: '画面比例', drive: 'local' },
        { kind: 'popover', match: '画质', drive: 'local' },
        { kind: 'popover', match: '弹幕设置', drive: 'local' },
        { kind: 'overlay', match: '选集', drive: 'session' },
        { kind: 'overlay', match: '番剧详情', drive: 'session' },
        { kind: 'overlay', match: '投屏', drive: 'local' },
        { kind: 'overlay', match: '查看播放状态与流详情', drive: 'local' }
      ]
      const findTrigger = (t: { match: string }): HTMLElement | null => {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>(`[${HIT_ATTR}] button, [${HIT_ATTR}] [role="button"]`))
        for (const el of nodes) {
          const title = el.getAttribute('title') ?? ''
          if (title.includes(t.match)) return el
        }
        return null
      }
      const fire = (el: HTMLElement): void => {
        /*
         * 两种处理器都要照顾到（读代码确认过）：
         *   · 控制栏按钮（IconBtn）用 React 的 `onClick`；
         *   · 状态药丸 / 浮层遮罩用 `onPointerDown`（原生窗口叠层下 click 更不可靠）。
         * 每个触发器**只有其中一种**，所以两个都派发不会把面板开了又关。
         */
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, isPrimary: true }))
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
      /**
       * 关掉当前打开的浮层。
       *
       * 触发器的关闭方式不统一（IconBtn 是"再点一次"；状态药丸的流详情弹窗只支持 `onMouseDown` 关闭，
       * 而且它恰好用遮罩的 mousedown 关），所以这里按顺序试三种办法，
       * 最后由调用方**复核**是否真的关掉了 —— 留着不管会污染后面的测量（遮罩本身就是一块区域，
       * 会让"画面中部不在形状里"这类断言为假）。
       */
      const closeOpen = async (trigger: HTMLElement): Promise<void> => {
        fire(trigger)
        await frames(2)
        const openNow = (): HTMLElement | null => {
          const marked = Array.from(document.querySelectorAll<HTMLElement>(`[${POPOVER_ATTR}]`)).find((n) => n.getBoundingClientRect().width >= 8)
          if (marked) return marked
          const covered = Array.from(document.querySelectorAll<HTMLElement>(`[${HIT_ATTR}]`)).filter((n) => {
            const r = n.getBoundingClientRect()
            return r.width >= 40 && r.height >= 40 && !n.hasAttribute('data-sakana-topbar') && !n.hasAttribute('data-sakana-bottombar')
          })
          return covered.length > 0 ? covered[covered.length - 1] : null
        }
        if (!openNow()) return
        /* 办法二：对遮罩本身派发 mousedown（流详情弹窗就是靠这个关的） */
        const backdrop = openNow()
        if (backdrop) {
          backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
          await frames(2)
        }
        if (!openNow()) return
        /* 办法三：找浮层里的"关闭"类按钮（aria-label / title / 文本） */
        const closer = Array.from(document.querySelectorAll<HTMLElement>('button')).find((b) => {
          const t = `${b.getAttribute('aria-label') ?? ''}${b.getAttribute('title') ?? ''}`
          return t.includes('关闭') && b.getBoundingClientRect().width > 0
        })
        if (closer) {
          fire(closer)
          await frames(2)
        }
      }
      const results: {
        kind: 'popover' | 'overlay'
        title: string
        found: boolean
        covered: boolean
        rect: { x: number; y: number; w: number; h: number } | null
        missing: number
        /** 结论：pass / fail / skip（skip = 环境测不了，绝不能以 FAIL 的形式留在报告里） */
        status: 'pass' | 'fail' | 'skip'
        reason: string
      }[] = []
      /**
       * 找"这次打开的浮层"。
       *
       * v0.3.9 第六轮修订：上一版只找打了 `data-sakana-popover` 的容器 + `data-sakana-hit` 里够大的那些，
       * 结果**流详情弹窗查不到** —— 它是 `fixed inset-0`，而它外面那层 `<div data-sakana-hit>` 自己**没有尺寸**
       * （尺寸全在 fixed 子元素上），于是两层都没被选中，面板明明打开了却报"没找到浮层"。
       * 现在补一条：`data-sakana-hit` 容器**里面**有尺寸的后代（和区域收集里"伸出去的浮层"用的是同一类判据）。
       */
      const findFloatingLayer = (): HTMLElement | null => {
        const sized = (n: HTMLElement): boolean => {
          const r = n.getBoundingClientRect()
          return r.width >= 40 && r.height >= 40 && getComputedStyle(n).pointerEvents !== 'none'
        }
        const marked = Array.from(document.querySelectorAll<HTMLElement>(`[${POPOVER_ATTR}]`)).filter(sized)
        if (marked.length > 0) return marked[0]
        const direct = Array.from(document.querySelectorAll<HTMLElement>(`[${HIT_ATTR}]`)).filter(
          (n) => sized(n) && !n.hasAttribute('data-sakana-topbar') && !n.hasAttribute('data-sakana-bottombar')
        )
        if (direct.length > 0) return direct[direct.length - 1]
        /* 没有尺寸的 data-sakana-hit 包装器（fixed 弹窗就是这种）：看它里面有没有够大的后代 */
        for (const wrap of Array.from(document.querySelectorAll<HTMLElement>(`[${HIT_ATTR}]`))) {
          if (sized(wrap)) continue
          for (const child of Array.from(wrap.querySelectorAll<HTMLElement>('*'))) {
            if (sized(child)) return child
          }
        }
        return null
      }
      for (const t of triggers) {
        const el = findTrigger(t)
        if (!el) {
          results.push({
            kind: t.kind,
            title: t.match,
            found: false,
            covered: false,
            rect: null,
            missing: 1,
            status: 'skip',
            reason: '控制栏里没有这个触发器（当前布局/会话下不显示它）'
          })
          continue
        }
        fire(el)
        await frames(3)
        const target: HTMLElement | null = findFloatingLayer()
        if (!target) {
          /*
           * 点了但没有任何浮层出现。**这里必须区分两种情况**（用户明确要求）：
           *   · 会话驱动的面板（选集 / 番剧详情）—— 它们由主进程的播放会话状态打开，
           *     自检环境里没有播放会话，点下去本来就不会有反应 → SKIP + 原因；
           *   · 本地状态驱动的面板 —— 点下去**必须**立刻出现，没出现就是真 FAIL。
           */
          results.push({
            kind: t.kind,
            title: el.getAttribute('title') ?? t.match,
            found: true,
            covered: false,
            rect: null,
            missing: 1,
            status: t.drive === 'session' ? 'skip' : 'fail',
            reason:
              t.drive === 'session'
                ? '需要真实播放会话（该面板由主进程的播放状态驱动：自检环境没有会话，点了不会有反应，不是产品问题）'
                : '点了触发器但没找到打开的浮层（本地状态驱动的面板应当立刻打开 —— 这是产品问题）'
          })
          await closeOpen(el)
          continue
        }
        const r = target.getBoundingClientRect()
        const regions = hitRegionsNow()
        /* 覆盖判定：浮层矩形是否被区域内矩形完全包住（形状裁剪是矩形并集，不做像素级抠图） */
        const coveredBy = (o: { x: number; y: number; w: number; h: number }): boolean =>
          r.left >= o.x - 0.5 && r.top >= o.y - 0.5 && r.right <= o.x + o.w + 0.5 && r.bottom <= o.y + o.h + 0.5
        const covering = regions.filter(coveredBy)
        const covered = covering.length > 0
        /* 没被覆盖时，算"伸出去多少"：把浮层矩形裁到最近的那块区域的缺口面积占比 */
        let missing = 0
        if (!covered && r.width > 0 && r.height > 0) {
          const area = r.width * r.height
          let best = 0
          for (const o of regions) {
            const w = Math.max(0, Math.min(r.right, o.x + o.w) - Math.max(r.left, o.x))
            const h = Math.max(0, Math.min(r.bottom, o.y + o.h) - Math.max(r.top, o.y))
            best = Math.max(best, w * h)
          }
          missing = Math.max(0, Math.min(1, 1 - best / area))
        }
        results.push({
          kind: t.kind,
          title: el.getAttribute('title') ?? t.match,
          found: true,
          covered,
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          missing: Math.round(missing * 1000) / 1000,
          status: covered ? 'pass' : 'fail',
          reason: covered ? '矩形被某一块上报区域完全包住' : `矩形有 ${Math.round(missing * 100)}% 落在所有上报区域之外（形状会裁掉它）`
        })
        /* 关掉它：留着会污染后面的测量（遮罩本身也是一块区域）。关不掉的要在结论里写明。 */
        await closeOpen(el)
        const stillOpen = ((): boolean => {
          const marked = Array.from(document.querySelectorAll<HTMLElement>(`[${POPOVER_ATTR}]`)).some((n) => n.getBoundingClientRect().width >= 8)
          if (marked) return true
          const r2 = target?.getBoundingClientRect()
          return !!r2 && r2.width >= 40 && r2.height >= 40
        })()
        if (stillOpen) {
          const last = results[results.length - 1]
          last.reason += '；⚠️ 探测后未能自动关闭（它可能影响后续面板的测量）'
        }
      }
      return results
    }
    return () => {
      delete w.__sakanaHitAt
      delete w.__sakanaHitDiag
      delete w.__sakanaHitSnapshot
      delete w.__sakanaHitRegions
      delete w.__sakanaClickStats
      delete w.__sakanaRegionsDiag
      delete w.__sakanaPanelProbe
      delete w.__sakanaHitLocked
    }
  }, [syncInteractive, zoneAt, hitRegionsNow])

  /**
   * 挂载时把"挂载之前就收到的鼠标位置"补上判一次（v0.3.9 补充工单）。
   *
   * 自检（以及真实场景里刚进播放页/刚按 F 全屏）会在页面加载完成后**立刻**把鼠标放在控制栏上、
   * 甚至直接点下去；那一刻 React 的 mousemove 监听还不存在，事件只能被模块级监听记下来。
   * 这里在挂载后（DOM 已经能命中）用那个坐标立刻判定一次，避免"第一次点击必击穿"。
   */
  useEffect(() => {
    if (!earlyPointer) return
    pointerRef.current = earlyPointer
    syncInteractive()
  }, [syncInteractive])

  /**
   * 控制栏**显隐变化**后重算一次判定（v0.3.9 补充工单）。
   *
   * 两个方向都要算：
   *   · 隐藏 → 可见：容器从 `pointer-events-none` 变成可点，`elementFromPoint` 才认它 ——
   *     "鼠标已经停在控制栏位置、此时因为 mousemove 才把控制栏唤出来"的那一帧判定必然是"没命中"，
   *     鼠标若就此停下就再没有第二次判定 → 用户点下去就是击穿。等一两帧让样式落到 DOM 上再算。
   *   · 可见 → 隐藏（5 秒自动收起）：那块位置已经不可点，判定必须跟着变成"穿透"，
   *     否则会留下一张**看不见却挡事的网**（用户抱怨过的"画面中间点不动"）。
   */
  useEffect(() => {
    let raf = 0
    const recheck = (): void => {
      syncInteractive()
      raf = window.requestAnimationFrame(() => {
        syncInteractive()
      })
    }
    recheck()
    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf)
    }
  }, [visible, syncInteractive])

  /**
   * 按下/抬起时刷新锁与命中。
   *
   * 用**捕获阶段**的 window 监听：按钮自己 `stopPropagation()` 也不影响这里（拖动时判断必须可靠）。
   * 用 pointer 事件而不是 mouse 事件：进度条/音量滑杆本来就用 pointer capture。
   */
  useEffect(() => {
    const down = (): void => {
      holdPointerRef.current = true
      const w = window as HitProbeWindow
      w.__sakanaHitLocked = true
      syncInteractive()
    }
    const up = (): void => {
      holdPointerRef.current = false
      const w = window as HitProbeWindow
      w.__sakanaHitLocked = false
      syncInteractive()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
    }
  }, [syncInteractive])

  /**
   * uosc 接管控制栏（见下面的 uoscBar）。
   *
   * v0.3.2 起这段的逻辑是"uosc 模式下一律穿透，把鼠标让给 mpv" —— 当时不得不这么做，
   * 因为整窗接收点击会把 mpv 的鼠标整个吞掉，uosc 永远等不到"鼠标动了"。
   * v0.3.9 改成按区域命中之后这条特殊规则不需要了：uosc 画的控制栏在视频子窗口里，
   * 而悬浮窗只在鼠标压到**应用自己的**浮层/按钮上时才接收点击 —— 两边天然不打架。
   * 这里只保留 uosc 状态供 poke 决定要不要让 uosc 闪一下控制栏。
   */
  const uoscBarRef = useRef(false)
  useEffect(() => {
    uoscBarRef.current = state?.uoscBar === true
  }, [state?.uoscBar])

  /** uosc reveal 的本地节流时间戳（见 poke） */
  const lastRevealAtRef = useRef(0)

  /** 唤出控制栏：显示 + 5 秒后自动隐藏（"接收鼠标"不再由这里决定，见 syncInteractive） */
  const poke = useCallback(() => {
    setVisible(true)
    /*
     * v0.3.3：uosc 模式下**主动让 mpv 把控制栏显示出来**。
     *
     * uosc 的设计是「鼠标靠近底部（默认 40px）才显示控制栏」，在画面中间移动鼠标它按设计不出现；
     * 而用户期望的正是「鼠标一动就出来」。这里每次鼠标移动（poke 由 mousemove 触发）
     * 就让主进程执行 uosc 自带的 flash-ui（强制显示 1 秒），节流在主进程里做（900ms）。
     *
     * v0.3.9：**这里再加一道本地节流**。主进程那道节流只能省掉"执行"，省不掉 IPC 本身；
     * 而 mousemove 每秒能来上百次 —— 每次一个 IPC 正是「控制栏不跟手」的来源之一。
     */
    if (uoscBarRef.current) {
      const now = Date.now()
      if (now - lastRevealAtRef.current > 900) {
        lastRevealAtRef.current = now
        void api.uosc.reveal()
      }
    }
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (holdRef.current) return
      setSubMenu(false)
      setAspectMenu(false)
      setSpeedMenu(false)
      setDanmakuMenu(false)
      // v0.3.3：画质菜单也要一起收起来，否则控制栏藏了、菜单还挂在屏幕上点不到
      setQualityMenu(false)
      setVisible(false)
    }, 5000)
  }, [])

  // 选集数据（低频）：由播放页单独推送
  useEffect(() => api.overlay.onEpisodes(setEpisodes), [])
  // 弹幕数据（v0.2.8，低频）：同样由播放页推送
  useEffect(() => api.overlay.onDanmaku(setDanmaku), [])

  // ---------------- 投屏（v0.3.8） ----------------

  /**
   * 刷新设备列表：`discover()` 会启动（或复用）主进程的发现线程，
   * 之后设备变化走 `onDevices` 推过来 —— 面板打开着就能看到设备自己冒出来。
   */
  const refreshCastDevices = useCallback(async (): Promise<void> => {
    const r = await api.cast.discover()
    if (r.ok) setCastDevices(r.data)
  }, [])

  useEffect(() => {
    const off = api.cast.onDevices((list) => setCastDevices(list))
    return () => off()
  }, [])

  /** 手动登记一台设备已挪到**设置页**（用户要求：播放器里不放 IP 输入框），这里不再提供 */

  /**
   * 投屏开始后由播放页把设备号记在这里 —— 怎么知道"正在投屏"？
   * 播放页执行 `castPlay` 成功后没有回推事件，所以这里用「面板里最后一次选择的设备」
   * 来记住它：用户点了设备就当作已经开始（失败时播放页会 toast 提示，这里再点一次即可）。
   */
  useEffect(() => {
    if (!castDevice) return
    let alive = true
    const tick = async (): Promise<void> => {
      const r = await api.cast.info(castDevice.id)
      if (alive && r.ok) setCastInfo(r.data)
    }
    void tick()
    // 2 秒一次：这是"遥控器"的状态回读，太频繁没有意义（电视端状态本来就秒级变化）
    const timer = window.setInterval(() => void tick(), 2000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [castDevice])

  const castActive = castDevice !== null

  // 打开详情浮层时拉一次番剧详情（悬浮窗有完整的 api 能力）
  const showInfoPanel = state?.showInfo === true
  /**
   * v0.2.18：控制栏是否已交给 uosc（mpv 侧绘制，见 PlayerPage 的 uoscBarMode）。
   *
   * 为 true 时这个悬浮窗**不再画任何控件**：
   * - 底栏（进度条 + 全部按钮 + 弹幕设置面板）整条隐藏 —— 它们由 uosc 提供；
   * - 顶栏只留「标题 + 状态药丸」（纯展示），✕ / 番剧详情 / 截图 三个按钮撤掉（uosc 里有）。
   *
   * 保留下来的部分都是 uosc **给不了**的：
   * ① 弹幕画布（canvas 渲染方式时，弹幕必须由网页画在视频之上）；
   * ② 番剧详情浮层、选集抽屉（应用自己的富面板）；
   * ③ 断点续播提示、错误条、流详情弹窗、捕捉视频流中的提示。
   */
  const uoscBar = state?.uoscBar === true
  useEffect(() => {
    if (!showInfoPanel) return
    const id = state?.subjectId
    if (id == null || detail) return
    setDetailLoading(true)
    void api.bangumi.subject(id).then((r) => {
      setDetailLoading(false)
      if (r.ok && r.data.data) setDetail(r.data.data)
    })
  }, [showInfoPanel, state?.subjectId, detail])

  // 选集浮层打开时，默认定位到当前播放的线路
  useEffect(() => {
    if (state?.showEpisodes && episodes) setBrowseLine(episodes.currentLine)
  }, [state?.showEpisodes, episodes])

  // 浮层/菜单打开时不要按 5 秒计时自动隐藏（否则菜单还在屏幕上、控制栏连窗口一起收了）
  useEffect(() => {
    holdRef.current =
      showInfo ||
      subMenu ||
      aspectMenu ||
      speedMenu ||
      danmakuMenu ||
      // v0.3.3：画质菜单同理 —— 不把它算进来，菜单开着的时候控制栏会按 5 秒计时收走，
      // 用户点菜单就是在点一个「已经不接收点击」的东西。
      qualityMenu ||
      showInfoPanel ||
      state?.showEpisodes === true
    if (holdRef.current) setVisible(true)
    else poke()
    /*
     * v0.3.2：依赖数组补全。以前只盯着「应用自己的三个本地菜单」，漏了
     * `danmakuMenu`、`showInfoPanel`（番剧详情）与 `state.showEpisodes`（选集）——
     * 后三个是从 uosc 菜单/桥接脚本回传过来的，依赖不全时这个 effect 不会重跑。
     * v0.3.9：补上 `speedMenu`（同一个坑：倍速菜单开着时控制栏会 5 秒收走）；
     * 并去掉这里过去的 `setInteractive(true)` —— "要不要接收点击"现在**只**看鼠标在哪，
     * 不再由"哪个面板开着"猜（见 HIT_ATTR 上面的说明）。
     */
  }, [showInfo, subMenu, aspectMenu, speedMenu, danmakuMenu, qualityMenu, showInfoPanel, state?.showEpisodes, poke])

  useEffect(() => api.overlay.onState(setState), [])

  /*
   * 画质设置：挂载时读一次（给按钮角标用），打开菜单时再读一次（保证是最新值）。
   * 写回走的也是同一个 settings，主进程的 store 钩子会立刻重挂着色器链。
   */
  const loadA4k = useCallback(async (): Promise<void> => {
    const r = await api.store.get('settings')
    if (!r.ok || !r.data || typeof r.data !== 'object') return
    const s = (r.data as Record<string, unknown>).anime4k
    setA4k(s && typeof s === 'object' ? (s as Anime4kSettings) : {})
  }, [])
  useEffect(() => {
    void loadA4k()
  }, [loadA4k])
  useEffect(() => {
    if (qualityMenu) void loadA4k()
  }, [qualityMenu, loadA4k])
  /** 改一项画质设置：先更新本地（角标立刻跟手），再整份写回 settings */
  const patchA4k = useCallback((patch: Partial<Anime4kSettings>): void => {
    setA4k((prev) => {
      const next = { ...prev, ...patch }
      void api.store.get('settings').then((r) => {
        const cur = (r.ok && r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>
        void api.store.set('settings', { ...cur, anime4k: next })
      })
      return next
    })
  }, [])
  const a4kEnabled = a4k.enabled === true
  const a4kMode = a4k.mode ?? 'A'
  const a4kTier = a4k.tier ?? 'fast'
  const a4kShort = A4K_SHORT[a4kMode] ?? a4kMode
  // 透明窗口：给根元素打标记，让全局样式把底色设为透明（否则会盖住整屏画面）
  useEffect(() => {
    /*
     * v0.3.9 第六轮：模块作用域已经打过一次（而且要**永不撤销**，见那里面的说明），
     * 这里只是"再补一遍"地幂等重复，不再在 cleanup 里移除标记 ——
     * 移除的窗口期正好是"播放页重建、悬浮窗重载"这条最容易出黑屏的路上。
     */
    document.documentElement.classList.add('sakana-overlay')
    document.body.classList.add('sakana-overlay')
  }, [])
  useEffect(() => api.overlay.onPoke(poke), [poke])
  /** 排障探针：把控制栏的真实显隐状态暴露给自检脚本（DOM 上的 opacity 判断不可靠） */
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__sakanaOverlayVisible = visible
  }, [visible])
  /**
   * 界面结构变化时**重新做一次命中判定**（v0.3.9）。
   *
   * 为什么必须补这一步：命中判定只在 mousemove 时才算 —— 而"面板打开/收起、控制栏显隐"
   * 这些变化发生时鼠标往往**一动不动**（例如按快捷键开菜单、5 秒自动隐藏、详情浮层加载完成）。
   * 那时如果还拿旧的判定结果，就会出现两种错：
   *   · 控制栏刚藏起来但窗口还在接收点击 → 又变成"看不见的网"，画面点不动；
   *   · 面板刚弹出来但窗口还在穿透 → 用户点面板没反应。
   * 这里用**最后一次已知的光标位置**重算一次即可（位置没变，变的是"那个点上有没有可点的东西"）。
   *
   * 依赖里放的是"会影响 DOM 里可点区域"的那些开关，不放每秒变化的状态本身 ——
   * 免得每个进度 tick 都白算一次（`elementFromPoint` 会强制一次布局）。 
   */
  useEffect(() => {
    syncInteractive()
  }, [
    syncInteractive,
    visible,
    uoscBar,
    showInfo,
    subMenu,
    aspectMenu,
    speedMenu,
    danmakuMenu,
    qualityMenu,
    castPanel,
    clickThrough,
    showInfoPanel,
    state?.showEpisodes,
    state?.resume,
    state?.error,
    detail,
    detailLoading,
    episodes
  ])
  /**
   * v0.3.6「点击击穿」自救侦测。
   *
   * 悬浮窗在**点击穿透**状态下依然收得到 `mousemove`（`setIgnoreMouseEvents(true, { forward: true })`
   * 会把鼠标移动转发过来），但收不到 click —— 所以能观测到的信号是：
   * **鼠标在这个窗口里按下了，却没有任何按钮接住**。
   * 这里用捕获阶段的 pointerdown 记录这个事实并上报（坐标一起给主进程，
   * 便于日志里看出用户点的是控制栏哪个位置）。
   *
   * 注意 `pointerdown` 在我们的按钮上是**先于 click** 触发的，而按钮自己会 `stopPropagation`，
   * 所以「按钮真的接住了」时这段代码根本不会跑到 —— 这正是我们想要的判据。
   */
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      void api.overlay.reportMissedClick(e.clientX, e.clientY)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])

  /**
   * 收到主进程的「疑似点击击穿」提示 → 显示自救浮层（见 clickThrough 的状态定义）。
   * 浮层只在悬浮窗里画，不影响播放页；用户按 F/Esc 后自行消失（或点「知道了」）。
   */
  useEffect(
    () =>
      api.overlay.onClickThrough(() => {
        setClickThrough(true)
      }),
    []
  )

  useEffect(() => {
    /*
     * 鼠标移动：既用来唤出控制栏，也用来做命中判定（两者都要，但频率完全不同）。
     *
     * ── v0.3.9 的性能改动（改前 → 改后）──
     * 改前：**每一个** mousemove 都会 `poke()`，而 poke 里有两处 IPC
     *   （`overlay.setInteractive(true)` 与 uosc 的 `reveal()`）+ 一次
     *   `clearTimeout/setTimeout`。鼠标划过控制栏时一秒能来上百次，
     *   主进程与渲染层就被这些 IPC 反复唤醒 —— 用户感觉就是"控制栏一卡一卡的"。
     * 改后：
     *   · 命中的 IPC **只在结果变化时**发（鼠标在画面上时一个字节都不发）；
     *   · 唤出控制栏（poke）用 rAF 合并到**每帧最多一次**，超出的移动直接丢弃 ——
     *     控制栏只需要"鼠标动过"这个事实，不需要每一次坐标；
     *   · uosc 的 reveal 再加一道 900ms 本地节流（主进程那道只省执行、不省 IPC）。
     */
    let rafId = 0
    const onMove = (e: MouseEvent): void => {
      // 命中判定用真实事件坐标：这是延迟最低的一条路（主进程的轮询是兜底）
      pointerRef.current = { x: e.clientX, y: e.clientY }
      syncInteractive()
      if (rafId !== 0) return
      rafId = window.requestAnimationFrame(() => {
        rafId = 0
        poke()
      })
    }
    /*
     * 鼠标离开窗口：只把坐标标记为"已失效"，**不再自己上报"收回点击"**。
     *
     * v0.3.9 补充工单：这里过去会直接 `syncInteractive()`（pointerRef = null → 立刻上报穿透）。
     * 但 `forward: true` 下光标滑到原生 mpv 子窗口上时 Chromium 也会发
     * `mouseout(relatedTarget === null)` —— 于是日志里出现「接收点击 → 穿透 → 接收点击」同一秒反复横跳，
     * 点下去那一刻窗口很可能正停在穿透态，这就是用户实测到的击穿。
     * 现在"光标是否已离开悬浮窗"只由**主进程**按窗口矩形判定（每 100ms 一次，见 pollCursorHit），
     * 那是这件事唯一权威的来源；渲染层不再对它下结论。
     */
    const onLeave = (): void => {
      pointerRef.current = null
    }
    const onOut = (e: MouseEvent): void => {
      if (e.relatedTarget === null) onLeave()
    }
    /*
     * 窗口被隐藏（切到后台）后再显示时，主动把控制栏唤出一次：
     * 否则「看不见 → 回来」之后可能停在既不可见也不可交互的状态（用户反馈过按钮全失灵）。
     */
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') poke()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseleave', onLeave)
    window.addEventListener('mouseout', onOut)
    document.addEventListener('visibilitychange', onVisibility)
    poke()
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('mouseout', onOut)
      document.removeEventListener('visibilitychange', onVisibility)
      if (rafId !== 0) window.cancelAnimationFrame(rafId)
      window.clearTimeout(hideTimer.current)
    }
    // syncInteractive 仍被 onMove（命中判定）用到，依赖必须保留
  }, [poke, syncInteractive])

  /** 进度条拖动 */
  const ratioFromEvent = (clientX: number): number => {
    const el = seekRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }

  /**
   * 拖动时真正下发 seek（节流）。
   *
   * 为什么要节流：一次 seek 在 mpv 侧是"冲刷解复用器 + 重新定位"的重动作，
   * 拖一下发几十次会让解码一直重启 —— 用户感觉是"拖进度条卡、画面一顿一顿"。
   * 120ms 的间隔既能让画面跟上（约每 8 帧跳一次），又不会把解码器打爆。
   * `force = true` 用于按下与松手：这两个时刻必须精确落到用户点的位置，不能等节流。
   */
  const seekTo = (sec: number, force = false): void => {
    if (!Number.isFinite(sec) || sec < 0) return
    const now = Date.now()
    if (!force && now - lastSeekAtRef.current < SEEK_THROTTLE_MS) return
    lastSeekAtRef.current = now
    send({ type: 'seek', time: sec })
  }

  const duration = state?.duration ?? 0
  const current = state?.current ?? 0
  /*
   * ── 进度条显示的"跟手"问题（v0.3.9）──
   *
   * 改前：拖动时 progress 仍取 `state.current`（内核每秒推 2~4 次的真实播放进度），
   * 于是拖动中滑块会**在手指位置与真实进度之间来回跳**（松手前看到的其实是没跟上的位置），
   * 同时每一次 pointermove 都发一个 `seek` IPC → 主进程每次都真的去 seek mpv
   * （seek 要冲刷解复用器） —— 拖一下发几十次，画面就会一顿一顿的，这就是"拖进度条卡"。
   *
   * 改后：
   *   · 拖动期间**用本地值显示**（dragPercent），不再被回推的进度覆盖；
   *   · 真正发给内核的 seek 节流到 ~120ms 一次（拖动结束一定补发最后那个位置），
   *     这样每帧都在动的是 UI，mpv 只在必要时真的跳。
   */
  const shownPercent = dragging && dragPercent !== null ? dragPercent : duration > 0 ? Math.min(100, (current / duration) * 100) : 0
  const displayedTime = dragging && dragPercent !== null ? (dragPercent / 100) * duration : current
  const currentSubId = state && state.subIdx >= 0 ? state.subs[state.subIdx]?.id : undefined

  return (
    <div
      className="fixed inset-0 select-none"
      /*
       * v0.3.9：显式声明**不是窗口拖拽区**。
       *
       * `-webkit-app-region: drag` 的区域会被 Chromium 当成标题栏：指针事件被系统接管、
       * DOM 收不到点击（这正是用户提的"方案三"担心的那件事）。本项目实测**没有**这个问题 ——
       * 悬浮窗走的是 App.tsx 里 `api.overlay.isOverlay` 那条早返回分支，根本不渲染 TitleBar
       * （唯一带 `.drag-region` 的组件），所以整页本来就没有 drag 区域。
       * 这里仍然显式写上 `no-drag`：一是把"这里绝不能变成拖拽区"这件事钉在代码里，
       * 二是以后有人往悬浮窗里加外壳组件时，不至于悄悄踩上。
       */
      style={{ background: 'transparent', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      // 弹幕窗口是永久穿透的，双击暂停这类交互只在 UI 窗口里生效
      onDoubleClick={isDanmakuPart ? undefined : () => send({ type: 'playPause' })}
    >
      {isDanmakuPart ? (
        <>
          {/*
           * 弹幕窗口（v0.3.9 第三轮拆出来的那一块）：**只画弹幕**。
           * 这块窗口铺满主窗口、永远 `setIgnoreMouseEvents(true, {forward:true})`
           * （由 playerOverlay.ts 设一次，此后绝不切换）—— 于是"要不要吃鼠标"不再有运行期决策。
           * 为什么弹幕必须单独一块窗口：控制栏那块窗口用 setShape 限定可点区域，而 setShape 同时裁剪绘制，
           * 铺满画面中部的弹幕会被裁没。
           */}
          {state && danmaku && danmaku.settings.enabled && danmaku.comments.length > 0 && !danmaku.pluginActive ? (
            <DanmakuLayer
              comments={danmaku.comments}
              settings={danmaku.settings}
              time={state.current}
              playing={state.playing}
              rect={danmakuRect(state, visible)}
              scale={window.devicePixelRatio || 1}
            />
          ) : null}
          {/*
            ── v0.3.9 第六轮修订：加载/过程进度卡搬到**穿透层**（弹幕窗口）来画 ──
            
            为什么必须搬走（用户复跑给的实测回归）：`setShape` 裁剪绘制，所以这张卡必须出现在
            区域里才画得出来；而它是**居中**的（`items-center justify-center`），一旦把它算进 UI 窗口的
            区域，**画面正中就落进了形状** → 那块像素的点击被 Electron 吃掉、mpv 再也收不到
            （点画面暂停 / uosc 唤出全部失效）。自检里"画面中部不在形状里"那条断言于是变红，
            而且它红得对：这张卡不该以"吃掉画面中心"为代价来显示。
            
            正解就是画在**弹幕窗口**：它铺满主窗口、永远鼠标穿透、且不受形状裁剪 ——
            卡片照样看得见，画面中心的点击照样归 mpv。z 序上它在 UI 窗口之下（主窗口 → 弹幕 → UI），
            但 UI 窗口只有在控制栏/面板那几块矩形里才绘制，所以卡片不会被挡住。
            卡片本身是 `pointer-events-none`（纯提示），放在穿透层里语义完全一致。
          */}
          {state && !state.startedOnce && !state.error ? (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
              <div className="flex max-w-lg flex-col items-center gap-2 rounded-2xl bg-black/70 px-5 py-4 text-xs text-white backdrop-blur">
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-amber-300" />
                  {state.flow && state.flow.stages.some((s) => s.startedAt !== null) ? (
                    // 进度已经在跑：标题直接说「现在在做什么」，不再叠一句「加载中」
                    <span className="text-white/90">{flowHeadline(state.flow)}</span>
                  ) : (
                    <span className="text-white/90">加载中…</span>
                  )}
                </div>
                {/* 三阶段过程进度：全屏下这是唯一能看出「卡在哪一步」的地方 */}
                <PlayFlowStages flow={state.flow} tone="onVideo" />
                {state.flow?.reason === 'slow' ? (
                  <div className="text-[11px] text-amber-300">
                    资源获取速度过慢，仍在继续等待（有数据在动就不结束）
                  </div>
                ) : null}
                {state.selfCheckNote ? (
                  <div className="max-w-md text-center text-[10px] text-white/70">{state.selfCheckNote}</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
      {/*
        v0.3.6「点击击穿」自救浮层。
        它必须画在**最上面**（z-[60]，高于选集/详情浮层），因为出现这个提示时
        用户很可能已经点不动别的东西了 —— 提示本身要是也被挡住就毫无意义。
        三个按钮都走 onPointerDown（与整个控制栏一致，click 在原生窗口叠层下更不可靠）。
      */}
      {clickThrough ? (
        <div
          data-sakana-clickthrough="1"
          data-sakana-hit="1"
          className="absolute left-1/2 top-4 z-[60] w-[min(560px,90vw)] -translate-x-1/2 rounded-xl border border-warn/50 bg-black/85 px-4 py-3 text-white shadow-2xl backdrop-blur"
        >
          <div className="flex items-start gap-3">
            <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warn" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">控制栏似乎没接住你的点击</div>
              <p className="mt-1 text-[11px] leading-relaxed text-white/75">
                播放画面是内核的原生子窗口，永远盖在网页之上，所以控制栏是一层独立的透明窗口；
                鼠标事件偶尔会落在两个窗口之间，表现为「按钮看得见、点了没反应」。
                <br />
                两条逃生路线：按 <Key>F</Key> 重新全屏一次（重建视频窗口与控制栏的位置关系），
                或按 <Key>Esc</Key> 退出播放器回主界面。
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    send({ type: 'toggleFullscreen' })
                    setClickThrough(false)
                  }}
                  className="rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 whitespace-nowrap"
                >
                  重新全屏（F）
                </button>
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    send({ type: 'escape' })
                  }}
                  className="rounded-lg bg-white/15 px-3 py-1.5 text-[11px] text-white hover:bg-white/25 whitespace-nowrap"
                >
                  退出播放器（Esc）
                </button>
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    setClickThrough(false)
                  }}
                  className="rounded-lg px-3 py-1.5 text-[11px] text-white/60 hover:text-white whitespace-nowrap"
                >
                  知道了
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {/*
        v0.2.8：弹幕层已迁到独立的弹幕窗口（见本组件顶部的 part 分支）——
        控制栏窗口用 setShape 限定可点区域，而 setShape 会裁剪绘制，弹幕必须画在另一块整窗穿透的窗口里。
      */}

      {/*
        v0.2.6：选集浮层 —— 半透明浮在画面上，打开时不再改动播放内容区域。
        点空白处关闭（回到纯播放画面）。
      */}
      {/*
        v0.2.7：选集数据还没到（悬浮窗比数据晚就绪）时给一个明确的加载态 ——
        否则点「选集」后什么都没出现，看起来就像按钮没反应。
      */}
      {state?.showEpisodes && !episodes ? (
        <div data-sakana-hit="1" className="absolute inset-0 z-40 flex bg-black/35 backdrop-blur-[2px]">
          <div className="ml-auto flex h-full w-[380px] max-w-[70vw] flex-col items-center justify-center gap-2 border-l border-white/10 bg-black/72 backdrop-blur-md">
            <span className="text-xs text-white/80">正在读取选集…</span>
            <button
              className="rounded-lg bg-white/10 px-3 py-1 text-[11px] text-white/80 hover:bg-white/20 whitespace-nowrap"
              onPointerDown={(e) => {
                e.stopPropagation()
                send({ type: 'toggleEpisodes' })
              }}
            >
              关闭
            </button>
          </div>
        </div>
      ) : null}
      {state?.showEpisodes && episodes ? (
        <div
          data-sakana-hit="1"
          className="absolute inset-0 z-40 flex bg-black/35 backdrop-blur-[2px]"
          onPointerDown={(e) => {
            // 点浮层以外的地方 = 关闭
            if (e.target === e.currentTarget) send({ type: 'toggleEpisodes' })
          }}
        >
          <div className="ml-auto flex h-full w-[380px] max-w-[70vw] flex-col border-l border-white/10 bg-black/72 backdrop-blur-md">
            <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
              <span className="text-sm font-medium text-white">
                选集 · 共 {episodes.lines.reduce((n, l) => n + l.episodes.length, 0)} 集
              </span>
              <button
                className="rounded-md p-1 text-white/70 hover:bg-white/10 hover:text-white"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  send({ type: 'toggleEpisodes' })
                }}
              >
                <X size={16} />
              </button>
            </div>
            {episodes.lines.length > 1 ? (
              <div className="flex flex-wrap gap-1 border-b border-white/10 px-2 py-2">
                {episodes.lines.map((l, i) => (
                  <button
                    key={i}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      setBrowseLine(i)
                    }}
                    className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                      browseLine === i ? 'bg-accent text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'
                    }`}
                  >
                    {l.name}
                    <span className="ml-1 text-[10px] text-white/50">{l.episodes.length}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <div className="grid grid-cols-4 gap-1">
                {(episodes.lines[browseLine]?.episodes ?? []).map((name, ei) => {
                  const activeLine = browseLine === episodes.currentLine
                  const active = activeLine && ei === episodes.currentEp
                  return (
                    <button
                      key={ei}
                      title={name}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        // 与规则页选集一致：切集由播放页重新挂载播放页来完成（更稳）
                        send({ type: 'selectEpisode', line: browseLine, ep: ei })
                      }}
                      className={`truncate rounded-md px-1 py-1.5 text-center text-[11px] transition-colors ${
                        active
                          ? 'bg-accent font-medium text-white'
                          : 'bg-white/8 text-white/75 hover:bg-white/20 hover:text-white'
                      }`}
                    >
                      {name}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* v0.2.6：详情浮层（同样盖在画面上；过去画在页面里被视频完全盖住 → 「详情按钮没反应」） */}
      {showInfoPanel ? (
        <div
          data-sakana-hit="1"
          className="absolute inset-0 z-40 flex bg-black/35 backdrop-blur-[2px]"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) send({ type: 'toggleInfo' })
          }}
        >
          <div className="ml-auto flex h-full w-[380px] max-w-[70vw] flex-col overflow-y-auto border-l border-white/10 bg-black/72 p-3 backdrop-blur-md">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-white">番剧详情</span>
              <button
                className="rounded-md p-1 text-white/70 hover:bg-white/10 hover:text-white"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  send({ type: 'toggleInfo' })
                }}
              >
                <X size={16} />
              </button>
            </div>
            {detailLoading ? (
              <div className="py-8 text-center text-xs text-white/60">加载中…</div>
            ) : detail ? (
              <>
                <div className="flex gap-3">
                  <CoverImage
                    src={detail.images?.common ?? detail.images?.large ?? null}
                    className="h-32 w-24 shrink-0 rounded-lg"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold leading-snug text-white">
                      {detail.name_cn || detail.name}
                    </div>
                    <div className="mt-1 text-[11px] text-white/60">{detail.name}</div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-white/75">
                      {detail.rating?.score ? <span>★ {detail.rating.score}</span> : null}
                      {detail.air_date ? <span>{detail.air_date}</span> : null}
                      {detail.eps ? <span>共 {detail.eps} 集</span> : null}
                    </div>
                  </div>
                </div>
                {detail.tags.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {detail.tags.slice(0, 10).map((t) => (
                      <span key={t.name} className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70 whitespace-nowrap">
                        {t.name}
                      </span>
                    ))}
                  </div>
                ) : null}
                {/*
                  v0.2.7 附加：补上「详细信息」几行（导演 / 制作 / 平台 / 放送日期…）。
                  播放器里的详情面板现在是唯一一份（页面内那份已经不再绘制），
                  过去这里只有评分/日期/标签/简介，看不到制作信息；
                  数据来自同一份详情缓存（subject3-<id>），不会再给反代增加请求。
                */}
                {detailRows(detail).length > 0 ? (
                  <div className="mt-3 flex flex-col gap-1 border-t border-white/10 pt-3">
                    {detailRows(detail).map((r) => (
                      <div key={r.key} className="flex gap-2 text-[11px] leading-relaxed">
                        <span className="w-14 shrink-0 text-white/45">{r.key}</span>
                        <span className="min-w-0 flex-1 break-words text-white/75">{r.value}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {detail.summary ? (
                  <div className="mt-3 whitespace-pre-wrap text-[11px] leading-relaxed text-white/70">
                    {detail.summary}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="py-8 text-center text-xs text-white/60">
                暂无详情数据（该番剧可能不是通过番剧表进入的）
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/*
        v0.2.6：断点续播提示。用户反馈「提示时间太短」——真正的原因是它过去画在播放页里，
        被原生视频窗口挡住根本看不见，只看到一闪而过的 toast。现在画在悬浮窗右下角，10 秒后自动消失。
      */}
      {state?.resume ? (
        <div
          data-sakana-hit="1"
          className="absolute bottom-24 right-5 z-40 flex w-72 flex-col gap-2 rounded-xl border border-white/15 bg-black/80 p-3 text-white shadow-2xl backdrop-blur"
        >
          <div className="text-xs">已自动跳转到上次观看位置 {fmt(state.resume.target)}</div>
          <div className="text-[11px] text-white/60">如果不想从这里继续，可以回到本集开头。</div>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] text-white/80 hover:bg-white/20 whitespace-nowrap"
              onPointerDown={(e) => {
                e.stopPropagation()
                send({ type: 'dismissResume' })
              }}
            >
              保持
            </button>
            <button
              className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:brightness-110 whitespace-nowrap"
              onPointerDown={(e) => {
                e.stopPropagation()
                send({ type: 'undoResume' })
              }}
            >
              撤销跳转
            </button>
          </div>
        </div>
      ) : null}

      {/*
        播放状态覆盖层：还没出画面时给出明确的等待反馈 + **过程进度**，
        失败时给出可点击的退出入口（原生视频窗口会盖住主窗口页面里的同类提示）。

        v0.3.9 重写：用户要求「播放器还没有显示时…在播放器状态里加一个过程进度显示器」，
        并且「在播放内容没加载出来之前增加一个加载中」。
        条件从「capturing / loading」改成「本轮还没出过画面且没有错误」——
        全屏/小窗下画面全是黑的，这一层是用户唯一的反馈来源；
        而用 `startedOnce` 而不是 `!playing`，是为了不让「暂停」被误判成「加载中」。
        flow 由播放页跟着那条既有的状态推送带下来（没有新增轮询）。

        v0.3.9 补充（用户报「两重提示叠在一起」）：这张卡现在是**全应用唯一**的加载/进度提示。
        主窗口页面里那张同内容的居中层已经删掉（见 PlayerPage 里那段说明），
        所以这里只在一处说话：
          · 过程进度还没开始（没有任何阶段的 startedAt）→ 标题写「加载中」；
          · 已经开始跑 → 标题换成本轮的一句话结论（阶段名 + 正在做什么），
            与下面那三行阶段明细是**同一件事的两个粒度**，不再出现两句同义文案。

        ⚠️ v0.3.9 第六轮修订：**这张卡的 JSX 已经搬到上面 `isDanmakuPart` 的穿透层里**（弹幕窗口）。
        原因见那段注释：它是居中的，算进 UI 窗口区域就会让"画面正中"落进窗口形状，
        于是画面中间的点击被 Electron 吃掉（实测回归：`画面中部不在形状里 = false`）。
        这里只留这段说明 —— 谁要再往 UI 窗口里加"居中提示"，先想清楚它会不会吃掉画面中心的点击。
      */}
      {state?.error ? (
        <div data-sakana-hit="1" className="absolute inset-x-0 bottom-24 z-30 flex justify-center">
          <div className="flex flex-col gap-2 rounded-xl bg-black/80 px-4 py-2.5 text-xs text-white backdrop-blur">
            <div className="flex items-center gap-3">
              <span className="max-w-md">{state.error}</span>
              <button
                className="rounded-lg bg-white/20 px-3 py-1 hover:bg-white/30 whitespace-nowrap"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  send({ type: 'exitPlayer' })
                }}
              >
                ✕ 退出播放
              </button>
            </div>
            {/* 失败时把三阶段摊开：用户要的就是「卡在哪一步、为什么」 */}
            <PlayFlowStages flow={state.flow} tone="onVideo" />
          </div>
        </div>
      ) : null}

      {/* 顶部：退出 / 标题 / 状态 / 详情 / 截图（v0.2.18：uosc 接管控制栏后只留标题与状态） */}
      <div
        /*
         * v0.3.9：uosc 接管控制栏时，整条顶栏**不再**算可点区域 ——
         * 那时控制栏由 mpv 画（包括它自己的顶栏），鼠标必须留给 mpv；
         * 应用只剩「状态药丸」这一个需要点的东西，它自己单独标了 data-sakana-hit。
         */
        data-sakana-hit={uoscBar ? undefined : '1'}
        data-sakana-topbar="1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={`absolute inset-x-0 top-0 z-30 flex h-14 items-center justify-between bg-gradient-to-b from-black/70 via-black/25 to-transparent px-2 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {/* 小窗口时「✕」表示退出播放（没有全屏可退），全屏时先退全屏 */}
        {uoscBar ? null : (
          <IconBtn
            title={state?.fullscreen ? '退出全屏' : '退出播放'}
            onClick={() => send({ type: state?.fullscreen ? 'exitFullscreen' : 'exitPlayer' })}
          >
            <X size={22} />
          </IconBtn>
        )}
        <div className="pointer-events-none min-w-0 flex-1 px-2">
          <div className="truncate text-sm font-medium text-white drop-shadow">
            {state?.title ?? ''}
          </div>
          <div className="truncate text-[10px] text-white/60">{state?.subtitle ?? ''}</div>
        </div>
        {/* 状态药丸：点击查看流详情（地址/播放列表/分辨率/码率） */}
        <button
          title="查看播放状态与流详情"
          /* v0.3.9：uosc 模式顶栏不算可点区域，这个药丸自己标一个（它仍由应用绘制） */
          data-sakana-hit="1"
          onPointerDown={(e) => {
            e.stopPropagation()
            setShowInfo(true)
          }}
          className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11px] transition-colors ${
            state?.status.kind === 'failed'
              ? 'bg-danger/30 text-white hover:bg-danger/45'
              : 'bg-white/15 text-white hover:bg-white/30'
          } whitespace-nowrap `}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              state?.status.kind === 'playing'
                ? 'bg-ok'
                : state?.status.kind === 'failed'
                  ? 'bg-danger'
                  : 'animate-pulse bg-warn'
            }`}
          />
          {/*
            v0.3.9 补充：药丸里**同一时刻只说一件事**，而且**只在别处没有进度提示时才说**。
            用户给的判据是「进播放到出画面这段过程里，屏幕上只出现一处进度/加载提示」，
            而上面那张居中卡恰好覆盖了「还没出画面」的整段时间 —— 所以那段时间里药丸必须闭嘴，
            否则就是「卡片 + 药丸」两处同时在报进度。
            它只在「已经开播过（卡片已消失）× 流程还在跑（例如播放中触发的重嗅探）」时
            才显示过程进度；其余时候显示状态词（「播放中 / 已暂停」，那不是进度提示）。
          */}
          {state?.flow && state.flow.running && state.startedOnce && !state.error ? (
            <PlayFlowStages flow={state.flow} compact tone="onVideo" />
          ) : (
            (state?.status.text ?? '加载中')
          )}
        </button>
        <div className="flex items-center gap-1">
          {uoscBar ? null : (
            <>
              <IconBtn title="番剧详情" onClick={() => send({ type: 'toggleInfo' })}>
                <Info size={20} />
              </IconBtn>
              <IconBtn title="截图" onClick={() => send({ type: 'snapshot' })}>
                <Camera size={20} />
              </IconBtn>
            </>
          )}
        </div>
      </div>

      {/*
        底部：进度条 + 控制按钮
        v0.2.8：弹幕开关与弹幕设置放在**控制栏上方**（同一容器里、进度条之前），
        跟着控制栏一起显隐，不额外占用画面。
        v0.2.18：控制栏交给 uosc 后，这整条（含弹幕设置面板）不再显示 ——
        进度条/播放控制/倍速/字幕/比例/弹幕菜单全部由 uosc 画在视频画面上。
        这里只关显隐、不删代码：设置里把「播放器控制栏」切回旧版即可原样恢复。
      */}
      <div
        /*
         * v0.3.9：**整条底栏**都是可点区域（含进度条、按钮、以及挂在它上面的各种菜单/面板）。
         *
         * 为什么标在容器上而不是逐个按钮：鼠标在按钮之间的空隙上也应当算"在控制栏上" ——
         * 否则点空隙会穿透到 mpv（把画面点成暂停），用户会以为又失灵了。
         * 控制栏收起时容器带 `pointer-events-none`，`elementFromPoint` 会跳过它 → 自动变回穿透，
         * 不需要额外同步状态（见 HIT_ATTR 的说明）。
         */
        data-sakana-hit={uoscBar ? undefined : '1'}
        data-sakana-bottombar="1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={`absolute inset-x-0 bottom-0 z-30 flex flex-col gap-1 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-3 pb-2 pt-6 transition-opacity duration-300 ${
          visible && !uoscBar ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {/* 弹幕设置面板（覆盖区域 / 弹幕数量 / 时间轴 / 别名检测 + 更多设置） */}
        {danmakuMenu ? (
          <div
            /* v0.3.9 第六轮：popover 挂在底栏容器里、却**伸到容器上方**（absolute bottom-[86px]）——
               不打这两个标记，伸出去的部分就会被窗口形状裁掉（用户实测 ①「弹幕设置被遮盖」）。 */
            data-sakana-hit="1"
            data-sakana-popover="1"
            className="absolute bottom-[86px] right-3 z-40 w-80 rounded-xl border border-white/15 bg-black/85 p-3 text-white shadow-2xl backdrop-blur"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium">弹幕设置</span>
              <button
                className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  setDanmakuMenu(false)
                }}
              >
                <X size={14} />
              </button>
            </div>
            {danmaku ? (
              <>
                <div className="mb-1 text-[10px] text-white/45">
                  {danmaku.source ? `来源：${danmaku.source}` : '未匹配到弹幕库条目'}
                </div>
                <SettingRow label="覆盖区域">
                  {[
                    { v: 0.25, t: '1/4' },
                    { v: 0.5, t: '1/2' },
                    { v: 0.75, t: '3/4' },
                    { v: 1, t: '全屏' }
                  ].map((o) => (
                    <Chip
                      key={o.t}
                      active={Math.abs(danmaku.settings.area - o.v) < 0.01}
                      onClick={() => send({ type: 'danmakuSetting', key: 'area', value: o.v })}
                    >
                      {o.t}
                    </Chip>
                  ))}
                </SettingRow>
                <SettingRow label="弹幕数量">
                  {[10, 20, 30, 50, 80].map((n) => (
                    <Chip
                      key={n}
                      active={danmaku.settings.maxCount === n}
                      onClick={() => send({ type: 'danmakuSetting', key: 'maxCount', value: n })}
                    >
                      {n}
                    </Chip>
                  ))}
                </SettingRow>
                <SettingRow label="时间轴">
                  <Chip onClick={() => send({ type: 'danmakuSetting', key: 'offsetMs', value: danmaku.settings.offsetMs - 500 })}>
                    −0.5s
                  </Chip>
                  <span className="min-w-[52px] text-center text-[11px] tabular-nums text-white/80">
                    {(danmaku.settings.offsetMs / 1000).toFixed(1)}s
                  </span>
                  <Chip onClick={() => send({ type: 'danmakuSetting', key: 'offsetMs', value: danmaku.settings.offsetMs + 500 })}>
                    +0.5s
                  </Chip>
                  <Chip active={danmaku.settings.offsetMs === 0} onClick={() => send({ type: 'danmakuSetting', key: 'offsetMs', value: 0 })}>
                    重置
                  </Chip>
                </SettingRow>
                <SettingRow label="显示类型">
                  <Chip
                    active={danmaku.settings.showScroll}
                    onClick={() => send({ type: 'danmakuSetting', key: 'showScroll', value: !danmaku.settings.showScroll })}
                  >
                    滚动
                  </Chip>
                  <Chip
                    active={danmaku.settings.showTop}
                    onClick={() => send({ type: 'danmakuSetting', key: 'showTop', value: !danmaku.settings.showTop })}
                  >
                    顶部
                  </Chip>
                  <Chip
                    active={danmaku.settings.showBottom}
                    onClick={() => send({ type: 'danmakuSetting', key: 'showBottom', value: !danmaku.settings.showBottom })}
                  >
                    底部
                  </Chip>
                </SettingRow>
                {/*
                  v0.2.9：插件渲染时，画面上的弹幕由 mpv 的 uosc_danmaku 负责，
                  它自带一套菜单（搜索弹幕 / 弹幕样式 / 弹幕源延迟 / 总菜单）。
                  这里只做「入口」——菜单本身由插件用 uosc 画在画面上。
                */}
                {danmaku.pluginActive ? (
                  <SettingRow label="插件菜单">
                    <Chip onClick={() => send({ type: 'uoscMenu', key: 'search' })}>搜索弹幕</Chip>
                    <Chip onClick={() => send({ type: 'uoscMenu', key: 'style' })}>弹幕样式</Chip>
                    <Chip onClick={() => send({ type: 'uoscMenu', key: 'delay' })}>源延迟</Chip>
                    <Chip onClick={() => send({ type: 'uoscMenu', key: 'total' })}>总菜单</Chip>
                  </SettingRow>
                ) : null}
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/10 pt-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {/*
                      v0.2.8：两个检测入口 ——
                      「别名检测弹幕」会用番剧别名（番剧库别名 + 弹幕库自身别名）再搜一轮，
                      中文译名/日文原名/其它译名不一致时特别有用；
                      「重新检测弹幕」按当前番剧名重查一次（也会绕过本地缓存重新拉取）。
                    */}
                    <button
                      className="rounded-md border border-white/20 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10 whitespace-nowrap"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        send({ type: 'detectDanmakuAlias' })
                      }}
                    >
                      别名检测弹幕
                    </button>
                    <button
                      className="rounded-md border border-white/20 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10 whitespace-nowrap"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        send({ type: 'reloadDanmaku' })
                      }}
                    >
                      重新检测弹幕
                    </button>
                  </div>
                  <button
                    className="shrink-0 text-[11px] text-accent hover:underline whitespace-nowrap"
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      send({ type: 'openDanmakuSettings' })
                    }}
                  >
                    更多设置 ›
                  </button>
                </div>
              </>
            ) : (
              <div className="py-3 text-center text-[11px] text-white/60">弹幕数据还没到，稍候…</div>
            )}
          </div>
        ) : null}

        <div
          ref={seekRef}
          data-sakana-hit="1"
          data-sakana-seek="1"
          className="group relative flex h-6 cursor-pointer items-center"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            /*
             * 指针捕获：拖动中指针移出进度条（往上滑到画面、拖到窗口外）时事件仍然回到这里。
             * 改前没有捕获，靠 `onPointerLeave` 把 dragging 置 false ——
             * 于是"手往上抖一下就断"，而且要重按一次才能继续拖。
             * 合成事件（自检里 dispatch 的 PointerEvent）没有真实 pointerId，会抛 NotFoundError，
             * 所以和音量滑杆一样用 try/catch 兜住。
             */
            try {
              ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
            } catch {
              /* 拿不到捕获也不影响按位置计算进度 */
            }
            setDragging(true)
            const r = ratioFromEvent(e.clientX)
            setDragPercent(r * 100)
            seekTo(r * duration, true)
          }}
          onPointerMove={(e) => {
            if (!dragging) return
            e.stopPropagation()
            const r = ratioFromEvent(e.clientX)
            setDragPercent(r * 100)
            seekTo(r * duration, false)
          }}
          onPointerUp={(e) => {
            if (!dragging) return
            e.stopPropagation()
            setDragging(false)
            const r = ratioFromEvent(e.clientX)
            setDragPercent(null)
            // 松手时**一定**把最后的位置补发一次：节流期间被丢掉的中间位置以这次为准
            seekTo(r * duration, true)
          }}
          onPointerCancel={() => {
            setDragging(false)
            setDragPercent(null)
          }}
        >
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/25">
            <div className="h-full rounded-full bg-accent" style={{ width: `${shownPercent}%` }} />
          </div>
          <div
            className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow"
            style={{ left: `calc(${shownPercent}% - 7px)` }}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-0.5">
            <IconBtn title="播放/暂停" onClick={() => send({ type: 'playPause' })}>
              {state?.playing ? <Pause size={20} /> : <Play size={20} fill="currentColor" />}
            </IconBtn>
            <IconBtn title="上一集" onClick={() => send({ type: 'prevEpisode' })}>
              <SkipBack size={18} />
            </IconBtn>
            <IconBtn title="下一集" onClick={() => send({ type: 'nextEpisode' })}>
              <SkipForward size={18} />
            </IconBtn>
            <IconBtn title="后退 10 秒" onClick={() => send({ type: 'back10' })}>
              <Rewind size={18} />
            </IconBtn>
            <IconBtn title="前进 10 秒" onClick={() => send({ type: 'forward10' })}>
              <FastForward size={18} />
            </IconBtn>
            <span className="ml-1 text-[11px] tabular-nums text-white/80">
              {fmt(displayedTime)} / {fmt(duration)}
            </span>
            {/* v0.2.9：音量改为滑杆（用户要求，不加静音键） */}
            <VolumeSlider volume={state?.volume ?? 0} onSet={(nv) => send({ type: 'setVolume', value: nv })} />
          </div>

          <div className="flex items-center gap-0.5">
            {/* 选集（需要空间：交给主窗口打开抽屉，画面会让出位置） */}
            <IconBtn title="选集" onClick={() => send({ type: 'toggleEpisodes' })}>
              <ListVideo size={18} />
            </IconBtn>

            {/* 字幕 */}
            <div className="relative">
              <IconBtn
                title="字幕"
                active={subMenu}
                onClick={() => {
                  setSubMenu(!subMenu)
                  setAspectMenu(false)
                }}
              >
                <Subtitles size={18} />
              </IconBtn>
              {subMenu && (
                <div
                  data-sakana-hit="1"
                  data-sakana-popover="1"
                  className="absolute bottom-12 right-0 z-40 max-h-64 w-48 overflow-y-auto rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur"
                >
                  <button
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 whitespace-nowrap"
                    onClick={() => {
                      send({ type: 'cycleSubtitle' })
                      setSubMenu(false)
                    }}
                  >
                    切换字幕（下一轨 / 关闭）
                  </button>
                  {(state?.subs ?? []).length === 0 ? (
                    <div className="px-2 py-1.5 text-[11px] text-white/45">未检测到字幕轨</div>
                  ) : (
                    (state?.subs ?? []).map((s) => (
                      <button
                        key={s.id}
                        className={`block w-full truncate rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                          currentSubId != null && currentSubId === s.id ? 'text-accent' : ''
                        }`}
                        onClick={() => {
                          send({ type: 'setSubtitle', id: s.id })
                          setSubMenu(false)
                        }}
                      >
                        {s.label}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {/*
              v0.2.9 最后更新：倍速。与画面比例同一套写法（点按钮弹出档位菜单），
              当前档位直接显示在按钮上，非 1x 时用强调色，避免「忘了自己开过倍速」。
            */}
            <div className="relative">
              <IconBtn
                title="播放倍速"
                active={speedMenu || (state?.speed ?? 1) !== 1}
                onClick={() => {
                  setSpeedMenu(!speedMenu)
                  setAspectMenu(false)
                  setSubMenu(false)
                }}
              >
                <span className="min-w-[30px] text-center text-[12px] font-semibold tabular-nums whitespace-nowrap">
                  {fmtSpeed(state?.speed ?? 1)}
                </span>
              </IconBtn>
              {speedMenu && (
                <div
                  data-sakana-hit="1"
                  data-sakana-popover="1"
                  className="absolute bottom-12 right-0 z-40 w-28 rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur"
                >
                  {SPEED_CHOICES.map((s) => (
                    <button
                      key={s}
                      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        Math.abs((state?.speed ?? 1) - s) < 0.001 ? 'text-accent' : ''
                      } whitespace-nowrap`}
                      onClick={() => {
                        send({ type: 'setSpeed', value: s })
                        setSpeedMenu(false)
                      }}
                    >
                      {fmtSpeed(s)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/*
              v0.2.8：弹幕开关与弹幕设置放进**控制栏内部**（与选集/字幕/比例同一排），
              不再单独占控制栏外的一行。
            */}
            <IconBtn
              title={
                danmaku?.loading
                  ? '弹幕加载中…'
                  : danmaku?.settings.enabled === false
                    ? '打开弹幕'
                    : `关闭弹幕${danmaku ? `（${danmaku.comments.length} 条）` : ''}`
              }
              active={danmaku?.settings.enabled !== false}
              onClick={() => send({ type: 'toggleDanmaku' })}
            >
              {danmaku?.settings.enabled === false ? <MessageSquareOff size={18} /> : <MessagesSquare size={18} />}
            </IconBtn>
            <div className="relative">
              <IconBtn
                title="弹幕设置"
                active={danmakuMenu}
                onClick={() => {
                  setDanmakuMenu(!danmakuMenu)
                  setSubMenu(false)
                  setAspectMenu(false)
                }}
              >
                <SlidersHorizontal size={18} />
              </IconBtn>
            </div>

            {/* 画面比例 */}
            <div className="relative">
              <IconBtn
                title={`画面比例：${ASPECT_LABEL[state?.aspect ?? 'fit']}`}
                active={aspectMenu}
                onClick={() => {
                  setAspectMenu(!aspectMenu)
                  setSubMenu(false)
                }}
              >
                {state?.aspect === 'cover' ? (
                  <Crop size={18} />
                ) : state?.aspect === 'stretch' ? (
                  <RectangleHorizontal size={18} />
                ) : (
                  <Expand size={18} />
                )}
              </IconBtn>
              {aspectMenu && (
                <div
                  data-sakana-hit="1"
                  data-sakana-popover="1"
                  className="absolute bottom-12 right-0 z-40 w-40 rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur"
                >
                  {(['fit', 'cover', 'stretch'] as AspectMode[]).map((m) => (
                    <button
                      key={m}
                      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        state?.aspect === m ? 'text-accent' : ''
                      } whitespace-nowrap `}
                      onClick={() => {
                        send({ type: 'setAspect', aspect: m })
                        setAspectMenu(false)
                      }}
                    >
                      {ASPECT_LABEL[m]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/*
              画质（Anime4K 超分，v0.3.3）。
              用户要求「控制栏里要有超分辨率按钮」——以前只能进设置页改，播放中没法切。
              数据来源是主进程的 settings（走 api.store 读写），主进程在 store 写入钩子里
              会立刻重挂着色器链，所以这里是**播放中即时生效**；按钮角标显示当前模式。
            */}
            <div className="relative">
              <IconBtn
                title={`画质（Anime4K 超分）：${a4kEnabled ? `模式 ${a4kShort}` : '已关闭'}`}
                active={qualityMenu || a4kEnabled}
                onClick={() => {
                  setQualityMenu(!qualityMenu)
                  setSubMenu(false)
                  setAspectMenu(false)
                }}
              >
                <span className="flex items-center gap-0.5">
                  <Sparkles size={18} />
                  <span className="min-w-[14px] text-[10px] font-semibold tabular-nums">
                    {a4kEnabled ? a4kShort : '关'}
                  </span>
                </span>
              </IconBtn>
              {qualityMenu && (
                <div
                  data-sakana-hit="1"
                  data-sakana-popover="1"
                  className="absolute bottom-12 right-0 z-40 w-60 rounded-lg border border-white/10 bg-black/85 p-1 text-xs text-white/85 backdrop-blur"
                >
                  <div className="px-2 py-1 text-[10px] text-white/50">
                    Anime4K 超分（改完立刻生效）
                  </div>
                  <button
                    className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                      a4kEnabled ? '' : 'text-accent'
                    }`}
                    onClick={() => {
                      patchA4k({ enabled: false })
                      setQualityMenu(false)
                    }}
                  >
                    关闭超分
                  </button>
                  {ANIME4K_MODES.filter((m) => m.id !== 'custom').map((m) => (
                    <button
                      key={m.id}
                      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        a4kEnabled && a4kMode === m.id ? 'text-accent' : ''
                      }`}
                      onClick={() => {
                        patchA4k({ enabled: true, mode: m.id })
                        setQualityMenu(false)
                      }}
                    >
                      <span className="font-medium">{m.short}</span>
                      <span className="ml-2 text-[10px] text-white/50">{m.desc}</span>
                    </button>
                  ))}
                  <div className="my-1 border-t border-white/10" />
                  <div className="px-2 py-1 text-[10px] text-white/50">显卡档位</div>
                  {ANIME4K_TIERS.map((t) => (
                    <button
                      key={t.id}
                      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 ${
                        a4kTier === t.id ? 'text-accent' : ''
                      }`}
                      onClick={() => {
                        patchA4k({ tier: t.id })
                        setQualityMenu(false)
                      }}
                    >
                      <span className="font-medium">{t.label}</span>
                      <span className="ml-2 text-[10px] text-white/50">{t.desc}</span>
                    </button>
                  ))}
                  <div className="my-1 border-t border-white/10" />
                  <button
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-white/10"
                    onClick={() => {
                      setQualityMenu(false)
                      send({ type: 'openQualitySettings' })
                    }}
                  >
                    完整画质设置…
                  </button>
                </div>
              )}
            </div>

            {/* 全屏按钮：小窗口时无意义（不能自由拉伸窗口），隐藏 */}
            {state?.fullscreen ? (
              <IconBtn title="退出全屏" onClick={() => send({ type: 'exitFullscreen' })}>
                <Minimize size={18} />
              </IconBtn>
            ) : (
              <IconBtn title="全屏播放" onClick={() => send({ type: 'toggleFullscreen' })}>
                <Maximize size={18} />
              </IconBtn>
            )}
            {/*
              投屏（v0.3.8）。放在「全屏 / 退出」左边：它属于"输出到哪"这一类动作，
              与画面比例、全屏同组，符合用户找它的习惯。
              面板也画在悬浮窗里 —— 画面是原生子窗口，画在播放页里的面板会被它整个盖住。
            */}
            <IconBtn
              title={castActive ? `正在投屏：${castDevice?.name ?? ''}` : '投屏到电视 / 接收端'}
              active={castPanel}
              onClick={() => {
                setCastPanel(!castPanel)
                setSubMenu(false)
                setAspectMenu(false)
                if (!castPanel) void refreshCastDevices()
              }}
            >
              {castActive ? <Cast size={18} className="text-accent" /> : <Cast size={18} />}
            </IconBtn>
            <IconBtn title="退出播放" onClick={() => send({ type: 'exitPlayer' })}>
              <LogOut size={18} />
            </IconBtn>
          </div>
        </div>
      </div>

      {/* 投屏面板（v0.3.8）：设备列表 + 手动连接 + 投屏中的遥控 */}
      {castPanel ? (
        <div
          data-sakana-hit="1"
          className="absolute bottom-[92px] right-4 z-50 w-[330px] rounded-xl border border-white/10 bg-black/85 p-3 text-white/90 shadow-2xl backdrop-blur"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">投屏</span>
            <button className="rounded px-1.5 py-0.5 text-[11px] text-white/60 hover:bg-white/10" onClick={refreshCastDevices}>
              刷新
            </button>
          </div>
          {castActive ? (
            <div className="mt-2 rounded-lg bg-white/5 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px]">{castDevice?.name ?? '已连接的设备'}</span>
                <span className="shrink-0 text-[10px] text-accent">投屏中</span>
              </div>
              <div className="mt-1 text-[10px] leading-relaxed text-white/50">
                {castInfo
                  ? `${castInfo.state === 'playing' ? '播放中' : castInfo.state ?? '已连接'} · ${Math.floor((castInfo.positionMs ?? 0) / 1000)}s${castInfo.durationMs ? ` / ${Math.floor(castInfo.durationMs / 1000)}s` : ''}${castInfo.total ? ` · 第 ${(castInfo.index ?? 0) + 1}/${castInfo.total} 集` : ''}`
                  : '这台电视不支持查询状态（DLNA）；用电视遥控器或下面按钮控制'}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip onClick={() => send({ type: 'castControl', action: 'pause' })}>暂停</Chip>
                <Chip onClick={() => send({ type: 'castControl', action: 'resume' })}>继续</Chip>
                <Chip
                  onClick={() => {
                    send({ type: 'castStop' })
                    setCastDevice(null)
                    setCastInfo(null)
                  }}
                >
                  停止投屏
                </Chip>
              </div>
              {castInfo?.titles && castInfo.titles.length > 0 ? (
                <div className="mt-2 max-h-32 overflow-y-auto rounded border border-white/10">
                  {castInfo.titles.map((t, i) => (
                    <div
                      key={`${t}-${i}`}
                      className={`truncate px-2 py-1 text-[11px] ${i === castInfo.index ? 'bg-accent/20 text-accent' : 'text-white/70'}`}
                    >
                      {t}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="mt-1.5 text-[10px] leading-relaxed text-white/40">
                投屏期间本机播放已暂停（把带宽让给电视）。换集请在电脑上操作 —— 会自动把新的一集推给同一台设备。
              </div>
            </div>
          ) : (
            <>
              <div className="mt-2 max-h-56 overflow-y-auto">
                {castDevices.length === 0 ? (
                  <div className="px-1 py-3 text-[11px] leading-relaxed text-white/50">
                    没有发现设备。请确认电视与本机在同一个网络，
                    或让安卓接收端保持打开；也可以直接在下面填地址。
                  </div>
                ) : (
                  castDevices.map((d) => (
                    <button
                      key={d.id}
                      className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left hover:bg-white/10"
                      onClick={() => {
                        send({ type: 'castPlay', deviceId: d.id })
                        setCastDevice(d)
                        setCastInfo(null)
                        setCastPanel(false)
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[12px]">{d.name}</span>
                        <span className="block text-[10px] text-white/40">
                          {d.kind === 'sakana' ? 'Sakana 接收端（直连，最流畅）' : 'DLNA 电视'}
                        </span>
                      </span>
                      <Cast size={14} className="shrink-0 text-accent" />
                    </button>
                  ))
                )}
              </div>
              <div className="mt-2 border-t border-white/10 pt-2 text-[10px] leading-relaxed text-white/45">
                有线共享网络 / 其它网段时自动发现不生效：请在「设置 → 播放器设置 → 投屏」里手动填接收端显示的 IP:端口
                （按用户要求，这一项已经挪到设置里，播放器里不再放输入框）。
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* 流详情弹窗（与播放页里的那个是同一组件，两处口径一致） */}
      <div data-sakana-hit="1">
        <StreamInfoModal
          open={showInfo}
          onClose={() => setShowInfo(false)}
          /*
           * v0.3.9 补充：详情面板画在悬浮窗里，而「重新解析地址 → 嗅探 → 交给内核」这条链
           * 在播放页手上（它才有播放页地址、探针取消句柄与看门狗），
           * 所以这里只把「用户点了重跑」这个意图发回去，由播放页执行。
           */
          onRetry={() => send({ type: 'retryStream' })}
        />
      </div>
        </>
      )}
    </div>
  )
}

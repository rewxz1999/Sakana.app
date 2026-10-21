import type { BrowserWindow } from 'electron'
import { session } from 'electron'
import { ONLINE_PLAY_TIMEOUT_MS } from '@shared/onlinePlay'
import { log } from '../log'
import { beginStage, endFlow, failStage, flowDetail, pushStep, succeedStage } from './playFlow'
import {
  onProbeEvent,
  refererForCandidate,
  rememberStream,
  resolveFirstPlayable,
  startRuleProbe,
  stopRuleProbe
} from './ruleProbe'
import { offerHandoffCandidate } from './playHandoff'
import { startTempMediaCache } from './mediaCache'
import { watchCacheSession } from './cacheFlowMeter'

/**
 * 「点播放才取流」的主进程实现（V2.0 重写「规则 → 播放」流程）。
 *
 * ## 为什么需要这一层（用户原话）
 *
 * 「批量嗅探只到拿到播放页 URL 为止……用户选定片源、从选集点播放之后，
 * 才启动无头 WebView 访问那个播放页；提前注入 Hook，同时劫持 XHR 与 fetch；
 * 从响应里识别视频流特征；拿到直链后立即销毁 WebView。
 * 我们比 kazumi 多一步：直链先缓存到本地，再注入播放器。」
 *
 * 这段顺序就是本模块的全部职责。它**不重写窗口逻辑**：窗口、webRequest、CDP、
 * 自动点击、广告短片判定全都在既有的 `ruleProbe` 里（那是几个月真机踩坑攒下来的），
 * 这里只负责把它的生命周期按用户要的顺序串起来：
 *
 *   ① 打开播放页（无头窗口；Hook 在页面脚本之前注入，见 ruleProbe 的 EARLY_HOOK_SOURCE）
 *   ② 等**第一个**候选（沿用 ruleProbe 的 onFound / 超时口径）
 *   ③ 拿到候选 → **立刻 stopRuleProbe() 销毁窗口**（不等收尾、不等宽限期）
 *   ④ `resolveFirstPlayable([url], referer)` 校验（短预算；超时也放行，见下）
 *   ⑤ 直链先起本地缓存（mediaCache），再交给播放器（PlayerPage 拿到返回值后 loadfile）
 *
 * ## 为什么校验失败也放行
 *
 * `resolveFirstPlayable` 是 HEAD/Range 预筛：它能过滤掉"地址已经 404"这种确定性坏候选，
 * 但慢 CDN 上也可能**超时**。用户要的是「拿到就播」，而内核有"5 秒零字节换下一条候选"
 * 的兜底（见 playHandoff）。所以这里只在**明确不可播**（返回 null 且预算用尽）时仍然
 * 交出原始地址，把判定权交给真正在拉流的内核 —— 否则我们又会退回"先校验后播放"的老路。
 *
 * ## 为什么窗口要立刻销毁
 *
 * 站点播放页会继续跑（广告、弹幕、轮询），窗口留着就是白烧一个渲染进程；
 * 而且候选已经拿到，后续的请求对我们没有价值。销毁时机由本模块保证，
 * 不再依赖渲染层在 onFound 里"顺手 stop"（那条路以前一旦渲染层代码改动就会漏关窗口）。
 */

const STAGE = 'acquire' as const

/**
 * 校验候选的预算。
 *
 * 为什么是 8 秒而不是 60 秒：候选是播放页**刚刚自己请求过**的地址，
 * 正常情况下 HEAD 在几百毫秒内就回来；8 秒还没回来意味着"这条连接被中间设备掐住"，
 * 继续等不会让画面更早出现。真正的失败判定留给内核的零字节看门狗。
 */
const VERIFY_BUDGET_MS = 8_000

/** 上一次播放页的 origin：预热用（同站点切集时省掉一次 DNS/TLS） */
let lastPlayOrigin = ''
/** 取流请求代次：用户快速换集时，旧的那一轮必须自己收手，不能把结果交给新的页面 */
let generation = 0
/** 正在等候选的那一轮的取消句柄（换集 / 退出播放页时由渲染层调用 cancelAcquire） */
let activeCancel: (() => void) | null = null

export interface AcquireStreamResult {
  ok: boolean
  /** 拿到的直链（ok=true 时必有） */
  url?: string
  /** undefined=未判定（回退规则站点）；''=经判定不能带 */
  referer?: string
  /** 可读的失败原因（ok=false 时必有） */
  error?: string
  /** 从开始到拿到候选的毫秒数（用户/日志关心的"取流有多快"） */
  ms: number
  /** 候选是从哪条通道抓到的（hook:... / webRequest / m3u8 / html 直出） */
  channel?: string
  /** 是否已经把直链交给本地缓存（true = 播放器将读本机地址） */
  cacheStarted: boolean
  /** 缓存没启动时的原因（HLS / 关闭 / 目录不可写） */
  cacheReason?: string
}

/**
 * 对播放页与规则站点的 origin 发 preconnect（提速 ②）。
 *
 * 为什么用 `session.preconnect` 而不是 `<link rel=preconnect>`：
 * 我们要热的是 **Chromium 网络栈**（嗅探窗口与播放器页面共用 defaultSession）的 socket 池，
 * 而"页面里的 link 标签"要等页面开始解析才生效 —— 那时播放页请求已经发出去了。
 * `session.preconnect` 是 Electron 暴露的同一个机制，在创建窗口前就能把 DNS/TCP/TLS 做完。
 *
 * 失败一律吞掉：预热只影响速度，不能因为它让取流失败。
 */
function preconnectOrigins(playUrl: string, referer?: string): void {
  const origins = new Set<string>()
  const push = (raw?: string): void => {
    if (!raw) return
    try {
      origins.add(new URL(raw).origin)
    } catch {
      /* 不是合法地址就跳过 */
    }
  }
  push(playUrl)
  // 规则站点（播放页的 Referer）与"最近一次播放页"：切集时两者通常就是同一批域名
  push(referer)
  push(lastPlayOrigin)
  try {
    lastPlayOrigin = new URL(playUrl).origin
  } catch {
    /* 非法地址留给后面的校验去报错 */
  }
  for (const origin of origins) {
    try {
      session.defaultSession.preconnect({ url: origin, numSockets: 2 })
      log.append('info', 'rule-probe', `预连接（preconnect）已发起：${origin}`)
    } catch (err) {
      log.append('warn', 'rule-probe', `预连接失败（不影响取流）：${String(err).slice(0, 80)}`)
    }
  }
}

/**
 * 取流。
 *
 * `mainWin` 故意传 null（见 startRuleProbe 的说明）：事件只走进程内订阅。
 * 否则播放页自己的 onFound 会和这里同时接手同一条流，出现两次 loadfile / 两个阶段的假状态。
 */
export async function acquireStream(
  mainWin: BrowserWindow | null,
  playUrl: string,
  referer?: string
): Promise<AcquireStreamResult> {
  const t0 = Date.now()
  const pageUrl = String(playUrl ?? '').trim()
  if (!/^https?:\/\//i.test(pageUrl)) {
    return { ok: false, error: '播放页地址无效（不是 http/https 地址）', ms: 0, cacheStarted: false }
  }
  /*
   * 新一轮开始前，先把上一轮**彻底结束**（而不只是关窗口）。
   *
   * 为什么不能只 stopRuleProbe：上一轮的 Promise 还在等事件，窗口被关掉后它收不到
   * 'done'，会一直挂到 65 秒看门狗才落地；那时它会把**这一轮**的窗口关掉并写一条假失败。
   * `cancelAcquire()` 会让上一轮立刻以「已取消」落地，代次也随之前进。
   */
  cancelAcquire()
  const gen = ++generation

  beginStage(STAGE, '正在打开播放页（无头窗口，Hook 已提前注入）')
  pushStep(STAGE, `用户点选集 → 开始取流：${pageUrl.slice(0, 90)}`)
  preconnectOrigins(pageUrl, referer)

  return await new Promise<AcquireStreamResult>((resolve) => {
    let settled = false
    /** 已经接收第一个候选并在做校验/缓存（防止第二个 found 再走一遍） */
    let handling = false
    let offEvent: (() => void) | null = null
    let guard: NodeJS.Timeout | null = null

    const cleanup = (): void => {
      if (offEvent) offEvent()
      offEvent = null
      if (guard) clearTimeout(guard)
      guard = null
      activeCancel = null
    }

    const finish = (r: AcquireStreamResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(r)
    }

    /**
     * 取消（渲染层换集 / 退出播放页时调用）：销毁窗口并让 Promise 立刻落地。
     *
     * 为什么不能只 `stopRuleProbe()`：窗口没了以后 ruleProbe 不会再发事件，
     * 这个 Promise 就会一直挂到 65 秒看门狗才结束 —— 旧的取流会在这段时间里
     * 继续往**新一轮**的过程进度写东西。所以取消必须自己把 Promise 结束掉。
     */
    activeCancel = (): void => {
      generation += 1
      stopRuleProbe()
      finish({ ok: false, error: '取流已取消（换集或退出播放）', ms: Date.now() - t0, cacheStarted: false })
    }

    /** 取流失败：既要给调用方可读原因，也要让过程进度有个**终点**（不许停在"正在识别"） */
    const fail = (message: string, reason: 'site' | 'timeout' | 'internal'): void => {
      failStage(STAGE, message, reason)
      endFlow({ ok: false, summary: `获取播放资源失败：${message}`, reason })
      finish({ ok: false, error: message, ms: Date.now() - t0, cacheStarted: false })
    }

    offEvent = onProbeEvent((ev) => {
      if (settled || gen !== generation) return
      const type = String(ev.type ?? '')
      if (type === 'done') {
        /*
         * ruleProbe 的收尾事件：它已经等满 ONLINE_PLAY_TIMEOUT_MS 仍没有候选。
         * message 是它写好的可读原因（"播放页没有发出可识别的视频请求" / 超时说明），
         * 直接透传，不在这里再编一句更笼统的。
         */
        const message = String(ev.message ?? '').trim() || '播放页没有发出可识别的视频请求'
        fail(message, /超时|未捕获|等待/.test(message) ? 'timeout' : 'site')
        return
      }
      if (type !== 'found') return
      /*
       * 只处理**第一个**候选：窗口在下面立刻被销毁，但校验是异步的（≤8s）。
       * 这段时间里如果还有事件挤进来，不能再走一遍"校验 + 起缓存 + 交队列"——
       * 那会开两个缓存会话、并把两条地址都记进直链缓存（后一条覆盖前一条）。
       */
      if (handling) return
      const candidate = String(ev.url ?? '')
      if (!candidate) return
      handling = true

      /*
       * ③ 立刻销毁窗口：候选已经拿到，站点播放页继续跑只会白烧 CPU/带宽。
       * 这一步必须在任何 await 之前 —— 窗口多活一秒，站点就多跑一秒。
       */
      const probeMs = Date.now() - t0
      stopRuleProbe()
      cleanup()
      flowDetail(STAGE, '已识别视频流，正在校验地址（立即关闭无头窗口）')
      log.append('info', 'rule-probe', `取流命中（${String(ev.channel ?? ev.kind ?? '?')}），已销毁无头窗口，用时 ${probeMs}ms`)

      void (async () => {
        const ref = refererForCandidate(candidate, pageUrl)
        const usableRef = ref === undefined ? referer : ref
        /*
         * ④ 校验候选。`resolveFirstPlayable` 内部会并行 HEAD 预筛（最多 6 个候选），
         * 这里只有一个候选，等价于一次 HEAD；失败/超时都放行（理由见文件头）。
         */
        const playable = await resolveFirstPlayable([candidate], usableRef, VERIFY_BUDGET_MS)
        if (gen !== generation) {
          finish({ ok: false, error: '取流已被新的请求取代', ms: Date.now() - t0, cacheStarted: false })
          return
        }
        const finalUrl = playable?.url ?? candidate
        const finalRef = playable ? playable.referer : usableRef
        if (!playable) {
          log.append(
            'warn',
            'rule-probe',
            `候选校验未通过或超时（${VERIFY_BUDGET_MS / 1000}s 预算），仍交给播放器 + 内核零字节兜底`
          )
          pushStep(STAGE, '候选校验超时，直接交给播放器（内核 5 秒零字节会换候选）')
        }

        /*
         * ⑤ 先缓存到本地，再注入播放器（比 kazumi 多的一步）。
         * 这里只**启动**缓存会话：`playerEngine.enginePlay` 拿到直链时会把同一个会话复用
         * （mediaCache 按 url+头去重），于是播放器一开始读到的就是本机已经落盘的那段。
         */
        rememberStream(pageUrl, finalUrl, finalRef)
        offerHandoffCandidate({ url: finalUrl, referer: finalRef })
        const cache = startTempMediaCache({ url: finalUrl, referer: finalRef })
        if (cache.ok) {
          watchCacheSession(cache.sessionId)
          flowDetail(STAGE, '直链已拿到，正在缓存到本地（播放器随后读本机文件）')
          pushStep(STAGE, cache.reused ? '复用已有的本地缓存' : '已开始把直链缓存到本地')
        } else {
          flowDetail(STAGE, `直链已拿到（本地缓存未启用：${cache.reason}）`)
          pushStep(STAGE, `本地缓存未启用：${cache.reason}`)
        }
        succeedStage(STAGE, `已获取播放资源（${String(ev.channel ?? ev.kind ?? 'hook')}）`)
        finish({
          ok: true,
          url: finalUrl,
          referer: finalRef,
          ms: Date.now() - t0,
          channel: String(ev.channel ?? ev.kind ?? ''),
          cacheStarted: cache.ok,
          cacheReason: cache.ok ? undefined : cache.reason
        })
      })()
    })

    // ② 开无头窗口等第一个候选。Hook 在 loadURL 之前注入（ruleProbe 内部保证）
    /*
     * V2.2：**用播放页自身作为 Referer**，而不是规则站点首页。
     *
     * 真机证据：同一部番第 1、2 集取流成功（2.6s），第 3、4 集与第 2 季第 1 集却 60 秒超时。
     * 这几种情况的差别不在站点，而在播放页里的播放器对 Referer 的校验：
     * 多数站点/CDN 只认「本站页面」，而首页与播放页在路径上不同（部分站点还按目录校验）。
     * 播放页地址本身一定是"本站页面"，作为 Referer 比首页更宽松，也更接近用户真实点击。
     */
    const usableReferer = pageUrl
    const started = startRuleProbe(mainWin, pageUrl, usableReferer)
    if (!started) {
      fail('无头窗口创建失败（当前系统可能不允许再开浏览器窗口）', 'internal')
      return
    }
    /*
     * 兜底看门狗：ruleProbe 自己会在 ONLINE_PLAY_TIMEOUT_MS 收尾并 emit 'done'，
     * 这里多给 5 秒只是防"事件丢了"导致 Promise 永远不 resolve（那会让加载卡永远转圈）。
     */
    guard = setTimeout(() => {
      if (settled) return
      stopRuleProbe()
      fail(`等待 ${ONLINE_PLAY_TIMEOUT_MS / 1000} 秒仍未捕获到视频流（站点可能已失效或需要交互）`, 'timeout')
    }, ONLINE_PLAY_TIMEOUT_MS + 5_000)
    guard.unref?.()
  })
}

/** 自检/计时脚本读现场：当前是否有取流在做 */
export function acquireDiagnostics(): { generation: number; lastPlayOrigin: string; active: boolean } {
  return { generation, lastPlayOrigin, active: activeCancel !== null }
}

/**
 * 取消当前取流（换集 / 退出播放页 / 用户点「重跑」前都会调）。
 *
 * 幂等，并且**只**做「结束当前这一轮」—— 没有进行中的取流时它不会去动 ruleProbe 的窗口。
 * 为什么这一点很重要：渲染层的取消是 fire-and-forget（不等返回），如果它在没有取流时
 * 也去 stopRuleProbe，就可能把用户刚刚用旧路径（可见网页视图）开的嗅探一起关掉。
 */
export function cancelAcquire(): void {
  const cancel = activeCancel
  generation += 1
  if (!cancel) return
  activeCancel = null
  stopRuleProbe()
  cancel()
}

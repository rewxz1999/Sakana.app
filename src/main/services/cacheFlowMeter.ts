import { tempMediaCacheSnapshot } from './mediaCache'
import { setCacheProgress } from './playFlow'

/**
 * 「直链缓存到本地」的进度采样器（V2.0）。
 *
 * ## 为什么单独一个模块
 *
 * 缓存进度有两个来源方、一个消费方：
 *   · 来源：`playAcquire`（点选集后先起缓存）与 `playerEngine`（交给内核时也会起/复用同一个会话）；
 *   · 消费：`playFlow` 的快照（加载卡与流详情面板都读它）。
 * 如果两处各自起一个 `setInterval` 写状态，就会出现两个定时器抢着写同一个数字
 * （一个报 3 MB、一个报 5 MB，界面闪烁），而且没人负责停。
 * 所以定时器只有这一份：谁启动了缓存会话就把 sessionId 交给它，它负责采样与停止。
 *
 * ## 为什么用「两次采样的差」算速率
 *
 * `mediaCache` 只记录"已可靠落盘的字节数"，没有速率字段（它不需要）。落盘速率必须是
 * Δbytes / Δt 才算得准 —— 拿上游声明的码率当速率是**假数据**（慢盘/慢源时差得很远）。
 * 这里 500ms 采一次，既够界面跳动、又不会把主进程吵醒太频繁。
 */

const SAMPLE_MS = 500

let timer: NodeJS.Timeout | null = null
let sessionId = ''
let lastAt = 0
let lastReceived = 0
/**
 * 第一帧只做基准，不报速率（V1.5.1）。
 *
 * 以前 watchCacheSession 把 lastReceived 置 0 后立刻采样：如果会话里已经有 300MB
 * （复用上一轮的缓存），第一帧就会算出 300MB/0.2s = 1.5GB/s 的假速度。
 * 现在第一帧只把"当前写盘字节数"记成基准，速率从第二帧开始算。
 */
let primed = false

/** 停掉采样（不清掉已写入的最终读数：界面要能看到"缓存完成时的最后状态"） */
export function stopCacheMeter(): void {
  if (timer) clearInterval(timer)
  timer = null
  sessionId = ''
}

function sample(): void {
  const snap = tempMediaCacheSnapshot()
  const s = snap.sessions.find((x) => x.id === sessionId)
  if (!s) {
    // 会话被 LRU 淘汰 / 应用退出清理：没有可报的进度了，停下但仍保留最后一次读数
    stopCacheMeter()
    return
  }
  const now = Date.now()
  const dt = Math.max(0.2, (now - lastAt) / 1000)
  /*
   * V1.5.1：速率用 `written`（本轮真实写盘字节）而不是 `received`（已完整缓存的部分）。
   * 并行分段下 `received` 会在一段 100+MB 的分段完成时**整段跳一下**，
   * 用它算速率就会闪出一个"几百 MB/s"的假速度；`written` 是每写一块就 +1，才是真实吞吐。
   */
  const written = typeof s.written === 'number' ? s.written : s.received
  const rate = primed ? Math.max(0, (written - lastReceived) / dt) : 0
  lastReceived = written
  lastAt = now
  primed = true
  setCacheProgress({
    received: s.received,
    total: s.total,
    rateBps: Math.round(rate),
    percent: s.total && s.total > 0 ? Math.min(100, Math.round((s.received / s.total) * 1000) / 10) : null,
    state: s.state,
    // V1.5.1：播放器正在等补字节（界面据此在播放中显示「正在加载中…」）
    waiting: s.waiting
  })
  // 已经完整落盘 / 失败 / 关闭：不再变化，停掉定时器（最终读数留在快照里）
  if (s.state === 'done' || s.state === 'failed' || s.state === 'closed') stopCacheMeter()
}

/**
 * 开始跟踪一个缓存会话。
 *
 * 重复调用同一个 sessionId 是幂等的：`playerEngine` 交给内核时会拿回**同一个**会话
 * （mediaCache 按 url+头去重复用），这里不能因此重启计时器 —— 重启会把速率打成 0。
 */
export function watchCacheSession(id: string): void {
  if (!id) return
  if (id === sessionId && timer) return
  stopCacheMeter()
  sessionId = id
  lastAt = Date.now()
  lastReceived = 0
  primed = false
  timer = setInterval(sample, SAMPLE_MS)
  // 纯展示采样器不该拖住进程退出
  timer.unref?.()
  sample()
}

/** 自检/计时脚本读现场用 */
export function cacheMeterState(): { watching: boolean; sessionId: string } {
  return { watching: timer !== null, sessionId }
}

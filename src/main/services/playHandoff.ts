/**
 * 「第一个候选先播，播不动再换」的候选交接队列（v1.3 提速工单）。
 *
 * ## 为什么要做成一个独立模块
 *
 * Kazumi 快的核心不是它解析得比我们快，而是它**不做预检查**：
 * 页面里第一个媒体请求直接丢给播放器，播不动才换下一个。
 * 我们过去的做法相反 —— 先对所有候选发 HEAD、再按优先级串行完整校验（单个最多 60 秒），
 * 校验通过才交给内核。正常站点上这一步是几百毫秒，慢 CDN 上就是几秒到几十秒，
 * 而它换来的只是「万一第一个候选是坏的」。用户的体感就是「点了半天不出画面」。
 *
 * 现在改成「乐观交接」：
 *   · 候选一被抓到就 **立刻** 交给内核（不探测、不排序）；
 *   · 内核 **5 秒内一个字节都没收到** 才换下一个候选；
 *   · 15 秒的注入看门狗仍然保留，作为最后一个兜底（它不再是正常路径的等待点）。
 *
 * ## 为什么判据是「零字节」而不是「没出画面」
 *
 * 慢 CDN 的常见形状是「首字节就慢，但数据在动」，那种情况换候选只会把已经暖起来的连接扔掉。
 * 「一个字节都没收到」才是地址失效/被墙/需要会话的确定性形状，换掉它是安全的。
 * 这条阈值与 mpv 里 `sampleNet` 读到的 `fw-bytes`/`cache-speed` 直接对齐。
 *
 * 本模块只放**策略与队列**（无 electron、无网络、无定时器），
 * 于是计时脚本可以在 node 里直接跑同一份规则，产品与验证不会各写一套。
 */

export interface HandoffCandidate {
  url: string
  /** undefined=未判定（回退到播放页地址）；''=经判定不能带 Referer */
  referer?: string
  cookies?: string
}

/**
 * 内核多久没有任何字节就换下一个候选。
 *
 * 为什么是 5 秒：正常站点首字节在 0.5~3 秒内（历史日志与本次真机/脚本测量都在这区间），
 * 5 秒还没一个字节基本可以断定这条地址不通；而等 15 秒（注入看门狗）对用户来说太久。
 * 这个值只影响「坏候选要多久才被绕过」，不影响正常路径。
 */
export const HANDOFF_NO_BYTES_MS = 5_000

/** 队列上限：一条播放页最多留这么多个候选（再多也轮不到，且会把内存和日志搞乱） */
const MAX_CANDIDATES = 8

let queue: HandoffCandidate[] = []
/** 已经交给过内核的地址（不再重复交） */
const tried = new Set<string>()
/** 当前内核正在播的地址（避免换候选时又换回它） */
let activeUrl = ''

/** 开一轮新的交接（换集/换源/重新嗅探时调用） */
export function resetHandoff(): void {
  queue = []
  tried.clear()
  activeUrl = ''
}

/** 记录候选；重复地址不重复入队，但会把后到的 Cookie/Referer 补上（嗅探先上报、Cookie 后到） */
export function offerHandoffCandidate(input: HandoffCandidate | string | null | undefined): void {
  if (!input) return
  const url = typeof input === 'string' ? input : input.url
  if (!url || !/^https?:\/\//i.test(url)) return
  if (tried.has(url)) return
  const existing = queue.find((c) => c.url === url)
  if (existing) {
    // 同一个地址可能先以「无 Cookie」上报，再补一次带 Cookie 的上报：后者才是有用的那份
    if (typeof input !== 'string') {
      if (input.referer !== undefined) existing.referer = input.referer
      if (input.cookies) existing.cookies = input.cookies
    }
    return
  }
  if (queue.length >= MAX_CANDIDATES) queue.shift()
  queue.push({
    url,
    referer: typeof input === 'string' ? undefined : input.referer,
    cookies: typeof input === 'string' ? undefined : input.cookies
  })
}

/** 内核开始播这个地址了（第一个候选或用户手选的地址） */
export function noteHandoffActive(url: string): void {
  if (url) activeUrl = url
}

/**
 * 取下一个候选。
 * 跳过「正在播的那个」与已经试过的；取出来就记为已试，避免同一条坏地址被反复交。
 */
export function takeNextCandidate(): HandoffCandidate | null {
  while (queue.length > 0) {
    const next = queue.shift() as HandoffCandidate
    if (!next.url || next.url === activeUrl || tried.has(next.url)) continue
    tried.add(next.url)
    return next
  }
  return null
}

/**
 * 是否该换候选。
 *
 * 判据只有两条，都是**保守**的（宁可多等，也不要把正在正常拉流的地址换掉）：
 *   ① 这 5 秒里收到过字节 → 不换（说明只是慢，不是死）；
 *   ② 没收到字节且已等满 `noBytesMs` → 换。
 */
export function shouldSwitchCandidate(opts: {
  elapsedMs: number
  bytesSinceCandidate: number
  noBytesMs?: number
}): boolean {
  if (opts.bytesSinceCandidate > 0) return false
  return opts.elapsedMs >= (opts.noBytesMs ?? HANDOFF_NO_BYTES_MS)
}

/** 自检/计时脚本读现场用（不改状态） */
export function handoffSnapshot(): {
  queued: number
  tried: number
  active: string
  noBytesMs: number
  candidates: HandoffCandidate[]
} {
  return {
    queued: queue.length,
    tried: tried.size,
    active: activeUrl,
    noBytesMs: HANDOFF_NO_BYTES_MS,
    candidates: queue.map((c) => ({ ...c }))
  }
}

import type { BrowserWindow } from 'electron'
import { getSettings } from '../net'
import { log } from '../log'
import { failStageAndEnd, flowRunning } from './playFlow'
import { proxyHlsUrl } from './adFilter'
import { onTempMediaCacheFailure, pauseTempMediaCache, startTempMediaCache } from './mediaCache'
import { planStreamBoost, stopAllBoost } from './streamBoost'
import {
  mpvAddSubtitleFile,
  mpvApplyBoost,
  mpvAttach,
  mpvAvailable,
  mpvBoostSwapped,
  mpvCurrentPath,
  mpvDestroy,
  mpvFallbackDirect,
  mpvGetState,
  mpvHasPicture,
  mpvNotifyLayout,
  mpvPlay,
  mpvPlaybackProgress,
  mpvReady,
  mpvSeekSec,
  mpvSetAspect,
  mpvSetBounds,
  mpvSetMute,
  mpvSetPlaylist,
  mpvSetSpeed,
  mpvSetSubtitle,
  mpvSetVolume,
  mpvSnapshot,
  mpvSubtitleTracks,
  mpvTogglePause
} from './mpv'

/**
 * 播放内核门面（v0.2.9：VLC 内核已整体删除，只保留 libmpv）。
 *
 * 保留这一层的原因：
 * - 渲染层与 IPC 一直只调用这套 `engine*` 接口，视频区域矩形上报、HLS 广告过滤、
 *   字幕/截图/画面比例等**跨切面逻辑**都收敛在这里；
 * - 删掉 VLC 后不需要把这些调用点全部重写（那正是「为了稳定」最不该做的事）。
 *
 * 历史包袱已清掉的部分：内核选择设置（playerEngine）、挂载失败时回退 libVLC 的兜底、
 * `mounted` 状态跟踪 —— 现在只有一个内核，不存在错配问题。
 */

export interface PlayerBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 播放代数（v0.3.9）。
 *
 * enginePlay 现在是**异步**的（要先测速、再起播预热），而用户可能在那一两秒里
 * 又点了别的集或直接退出播放器。每次调用递增代数，只有最新那一次才允许动内核 ——
 * 否则会出现「刚切到第 3 集，第 2 集那次迟到的 loadfile 把播放打回去」。
 */
let playGen = 0

/** 当前内核：恒定 libmpv（保留函数是为了让调用方与日志继续有单一出处） */
export function activeEngine(): 'mpv' {
  return 'mpv'
}

export function engineAttach(
  win: BrowserWindow,
  bounds?: PlayerBounds
): Promise<{ ok: boolean; message: string }> {
  const b = bounds ?? { x: 0, y: 56, width: 1280, height: 640 }
  /*
   * 重新挂载 = 新的一次播放会话：把「同一路流去重」的记忆清掉。
   * 不清的话，「切集/换源后又回到同一个地址」会被当成重复请求挡掉，什么都不播。
   */
  resetPlayDedupe()
  const r = mpvAttach(win, b)
  /*
   * v1.3：地址可能比内核先到（缓存命中时播放页几乎立刻就有直链，而 attach 还在建子窗口）。
   * 过去这种情况只能由渲染层「内核还没 attach」重试，每次间隔 900ms —— 白白多等近一秒。
   * 现在主进程把地址排队，attach 一成功就立刻 loadfile。
   */
  if (r.ok && pendingPlay) {
    const p = pendingPlay
    pendingPlay = null
    try {
      mpvPlay(p.path, p.referer, p.cookies)
      log.append('info', 'player', '内核挂载完成，立刻装载排队中的播放地址（不再等渲染层重试）')
    } catch (err) {
      log.append('warn', 'player', `挂载后装载排队地址失败：${String((err as Error)?.message ?? err).slice(0, 120)}`)
    }
  }
  return Promise.resolve(r)
}

/**
 * 内核还没挂载时先排队的播放地址（v1.3）。
 * 只保留最后一次：用户在这期间换了集，旧地址不该再被装载。
 */
let pendingPlay: { path: string; referer?: string; cookies?: string } | null = null

/* ─────────────────── 本地临时缓存（边下边播，v1.4） ─────────────────── */

/**
 * 当前交给内核的本地缓存会话。
 *
 * 为什么要在这里留一份、而不是全交给 mediaCache：
 * 缓存失败时是**主进程后台**知道的（上游 403/写盘失败），而「原始地址 + Referer/Cookie」
 * 只有播放层有；回退直连就是把这三样再交给内核。会话 id 用来过滤「上一集迟到的失败通知」。
 */
let activeCache: {
  sessionId: string
  localUrl: string
  directUrl: string
  referer?: string
  cookies?: string
  gen: number
} | null = null
let cacheFailureHooked = false

/**
 * 缓存失败 → 回退直连（「不许因为它播不了」的兜底，v1.4）。
 *
 * 只在三个条件同时成立时才切源，避免把一次后台失败变成用户可感知的中断：
 *   ① 失败的是**当前**这一路（不是上一集迟到的通知）；
 *   ② 内核还没出画面（已出画面时切源会把进度打回 0，已缓存区间足够继续播）；
 *   ③ 内核当前载入的确实是这个本机地址（用户已经换候选/切加速时不要把它拉回来）。
 * 任何一步不满足都只写日志、不动内核 —— 播放优先。
 */
function ensureCacheFailureHandler(): void {
  if (cacheFailureHooked) return
  cacheFailureHooked = true
  onTempMediaCacheFailure((f) => {
    const cur = activeCache
    if (!cur || cur.sessionId !== f.sessionId) return
    /*
     * 这个会话已经失败，不再代表「当前正在走缓存」：
     * 清掉它，2.5 秒的加速决策才能把已经回退过去的直连当作普通直连来救援
     * （否则会误以为缓存还在接管取流而跳过测速）。
     */
    activeCache = null
    if (mpvPlaybackProgress().hasPicture) {
      log.append('warn', 'cache', `本地临时缓存失败（${f.reason}），但画面已经在播，保持当前播放不回退`)
      return
    }
    const kernelPath = mpvCurrentPath()
    if (kernelPath && kernelPath !== cur.localUrl) {
      // 内核已经被换候选/加速中转带到别处：这次失败与当前播放无关，顺手把后台拉取停掉
      log.append('info', 'cache', '本地临时缓存失败，但内核已切到其它地址，不再回退')
      pauseTempMediaCache(cur.sessionId)
      return
    }
    if (!mpvReady()) {
      // 内核还没挂载、地址还在排队：把排队地址换成直连原地址，attach 后直接播它
      if (pendingPlay && pendingPlay.path === cur.localUrl) {
        pendingPlay = { path: cur.directUrl, referer: cur.referer, cookies: cur.cookies }
        log.append('warn', 'cache', `本地临时缓存失败（${f.reason}），排队中的播放地址已换成直连原地址`)
      }
      return
    }
    const ok = mpvFallbackDirect(cur.directUrl, cur.referer, cur.cookies, f.reason)
    log.append(
      ok ? 'warn' : 'error',
      'cache',
      ok
        ? `本地临时缓存失败（${f.reason}），已自动回退直连原地址，不影响本次播放`
        : `本地临时缓存失败（${f.reason}），回退直连也未成功（内核不可用）`
    )
  })
}

/**
 * 「要不要测速/加速」的延迟决策（v1.3）。
 *
 * 为什么不在 loadfile 之后立刻测速（脚本里实测到的真问题）：
 * 测速/预热会**再开一条连接去拉同一个地址**。对「同一 IP 只给一条连接」的慢 CDN，
 * 它和内核的取流互相排队 —— 实测同一路 11 秒首字节的地址，改后立刻测速会让首帧等到 10.6 秒，
 * 而让内核独占连接只要 3 秒。所以先给直连 2.5 秒：
 *   · 已经收到字节/已经出画面 → 这一轮**根本不测速**（省一条连接，也省 0.3~3 秒后台开销）；
 *   · 一个字节都没有 → 才启动测速/预热，作为「直连卡死」的救援（成功就切到中转，失败就交给 5 秒/15 秒兜底）。
 */
const BOOST_PLAN_DELAY_MS = 2_500
let boostTimer: NodeJS.Timeout | null = null

function clearBoostTimer(): void {
  if (boostTimer) clearTimeout(boostTimer)
  boostTimer = null
}

export function engineSetBounds(bounds: PlayerBounds): void {
  mpvSetBounds(bounds)
}

/**
 * 交给播放器的地址在**同一条链路上**完成两件事（顺序有讲究）：
 *
 * 1. `proxyHlsUrl`：HLS 广告过滤（把 m3u8 换成本机改写地址，贴片广告分片在这一层被剔除）；
 * 2. `planStreamBoost`：在线播放加速（v0.3.9）—— 先给源站测一次速，
 *    **慢**才启用本机并发中转（HLS=并发预读分片 / 整段文件=并发 Range 分段），
 *    快就直接原样直连（多一层转发只会更慢）。
 *
 * 顺序为什么不能反：加速器面对的是**去掉广告之后**的播放列表，
 * 否则预读窗口会把广告分片也算进去（白拉一段广告回来）。
 *
 * 为什么是异步的：测速 + 起播预热本身就要花掉最多几秒，而这几秒里拉回来的数据
 * 会作为「头部缓冲」直接喂给播放器（`streamBoost` 的 head / 分片缓存），
 * 所以它换来的不是白等，而是「起播就有数据」。预热失败/超时会立刻回退直连。
 *
 * ## v0.3.9 补的两道闸（都是拿真实日志定位出来的「在线播放失败」成因）
 *
 * ### ① 重复播放同一路流 → 会把**正在播的那一路**亲手掐断
 *
 * 真实日志（用户 19:46~19:47 的一次在线播放，同一路 `/videos/6aca…`）里，
 * 1 分钟内出现了十几次「加速中转已启用」与「停止加速中转（1 个会话）」交替 ——
 * 也就是说 `enginePlay` 被反复调用，而每次 `planStreamBoost` 开头都会
 * **`stopAllBoost()` 停掉所有加速会话**（包括内核此刻正在读的那一个），
 * 然后重新测速、重新 `loadfile`。结果就是：声音先出来几秒 → 会话被掐 → 播放截止。
 * 重复调用的来源有两处（都在渲染层，不在本文件）：React StrictMode 下播放页
 * 的 effect 会跑两遍；以及嗅探命中/缓存命中/重试多条路径都会再交一次同一个地址。
 *
 * 这里在**主进程侧**做去重（渲染层怎么重复调用都只会真的播一次）：
 * 同一路（地址+Referer+Cookie 相同）在 `PLAY_DEDUPE_MS` 内重复到达 → 直接忽略。
 *
 * ### ② 站点给的「占位播放列表」被当成可播地址交给了内核
 *
 * 同一份日志里的失败样本：`直出地址校验通过(application/vnd.apple.mpegurl 206)`，
 * 但那个 m3u8 **只有 97 字节**（`stream-diag` 的响应头里写着 content-length 97），
 * 加速器测速为「HLS 第 1 片 0KB / 该片 0.0s」，之后内核再也没有出过画面。
 * 校验只看 Content-Type，于是「一张空列表」被当成能播的地址交了出去，
 * 用户看到的就是「交给了内核 → 卡住 → 没有画面」。
 *
 * 这里在交给内核之前**再看一眼列表内容**（HLS 才看，整段文件不看）：
 * 既没有变体（不是主列表）也没有任何一个时长 > 0 的分片时，说明这不是可用播放列表，
 * 直接如实失败并写清证据（字节数 / 分片数 / 判据），不再让用户白等一轮。
 *
 * ## v1.3：上面这件事**不再挡在起播前面**
 *
 * 工单实测（`scripts/play-speed`）里最刺眼的一段就是这里：
 * 命中一个直链之后，`enginePlay` 会先 `await planStreamBoost(...)`（测速 + 预热，
 * 快源 ~0.3s、慢源 1~8s），再 `await checkPlaylistUsable(...)`（必要时再拉一次列表，最多 8s），
 * 全都结束才 `loadfile`。用户点完一集，内核其实**还没拿到地址** ——
 * 这正是「命中→loadfile」这一段，Kazumi 那里几乎是 0。
 *
 * 现在顺序反过来：
 *   ① 直连地址**立刻** loadfile（这是唯一能出画面的动作）；
 *   ② 测速/预热/列表校验在后台并行跑；
 *   ③ 只有「还没出画面」时才把内核切到加速中转（中转里已经缓存了头部分片，切过去通常立刻出画）；
 *      已经出画面则**绝不打断**，把后台中转停掉省带宽。
 *
 * 去重闸与「占位播放列表」两道闸都保留 —— 它们防的是真实踩过的坑，
 * 只是从「先判后播」改成「先播后判」，判失败仍然会结束本轮并给出原因。
 */
export function enginePlay(path: string, referer?: string, cookies?: string): void {
  const filtered = proxyHlsUrl(path, { referer, cookies })
  /*
   * 去重闸：同一路流在短时间内重复到达时只播一次（见上面 ① 的说明）。
   * 只按「地址 + 头」判等：换集/换线路地址必然不同，所以不会挡掉真实切换。
   */
  const key = `${filtered}\u0000${referer ?? ''}\u0000${cookies ?? ''}`
  const now = Date.now()
  if (key === lastPlayKey && now - lastPlayAt < PLAY_DEDUPE_MS) {
    log.append(
      'info',
      'player',
      `忽略重复的播放请求（${((now - lastPlayAt) / 1000).toFixed(1)}s 内同一路流）：不再重新测速/重新 loadfile`
    )
    return
  }
  lastPlayKey = key
  lastPlayAt = now
  const gen = ++playGen

  /*
   * ① 本地临时缓存（边下边播，v1.4）：
   * 先把候选地址交给本机缓存服务，拿到**本机播放地址**再 loadfile。
   * 缓存服务按顺序拉上游字节并写盘，播放器只读「已经落盘」的部分 ——
   * 起播不再受上游抖动影响，后续拖动/重播也只读磁盘。
   * 拿不到本机地址（HLS / 服务未就绪 / 目录不可写）就原样直连：这一步绝不能挡住播放。
   */
  if (activeCache && activeCache.directUrl !== filtered) {
    // 切集：上一集不必继续在后台把整集拉完，暂停但保留已落盘字节（LRU 里拖回来还能续）
    pauseTempMediaCache(activeCache.sessionId)
  }
  const cacheStart = startTempMediaCache({ url: filtered, referer, cookies })
  let playUrl = filtered
  let playReferer = referer
  let playCookies = cookies
  if (cacheStart.ok) {
    playUrl = cacheStart.url
    // 上游需要的 Referer/Cookie 由本机缓存服务带：内核不必、也不该把 Cookie 发给本机端口
    playReferer = undefined
    playCookies = undefined
    /*
     * 切到缓存链路 = 以后这路字节由缓存服务提供，上一集可能还挂着的加速中转没有用了：
     * 不收掉它会继续并发拉上游，和缓存抢带宽（慢源上尤其明显）。
     */
    stopAllBoost()
    activeCache = {
      sessionId: cacheStart.sessionId,
      localUrl: cacheStart.url,
      directUrl: filtered,
      referer,
      cookies,
      gen
    }
    ensureCacheFailureHandler()
    log.append(
      'info',
      'cache',
      cacheStart.reused
        ? '本次播放走本地临时缓存（复用已有缓存，播放器只读本地文件）'
        : '本次播放走本地临时缓存：先落盘再喂给播放器，未缓存到的位置边下边播'
    )
  } else {
    activeCache = null
    log.append('info', 'cache', `本地临时缓存未启用（${cacheStart.reason}），本次直连原地址播放`)
  }

  // ② 先交给内核：不等测速、不等列表校验、不等任何预检查
  if (mpvReady()) {    try {
      mpvPlay(playUrl, playReferer, playCookies)
    } catch (err) {
      pendingPlay = { path: playUrl, referer: playReferer, cookies: playCookies }
      log.append(
        'warn',
        'player',
        `内核暂时不可用，地址先排队（attach 完成立刻 loadfile）：${String((err as Error)?.message ?? err).slice(0, 100)}`
      )
    }
  } else {
    pendingPlay = { path: playUrl, referer: playReferer, cookies: playCookies }
    log.append('info', 'player', '内核还没挂载，地址先排队；attach 完成立刻 loadfile（不再让渲染层等 900ms 重试）')
  }

  // ③ 延迟决策：先让直连独占连接 2.5 秒；没数据才测速/预热（见 BOOST_PLAN_DELAY_MS 的说明）
  clearBoostTimer()
  boostTimer = setTimeout(() => {
    boostTimer = null
    // 期间用户又点了别的集/退出了播放器：这次的结果作废，别再动内核
    if (gen !== playGen) return
    /*
     * 这一轮已经结束（首帧已到 / 已判失败）就不再测速：
     * 首帧到了说明直连没问题，失败则已经由 15 秒看门狗收尾 —— 两种情况都不需要再开一条连接。
     */
    if (!flowRunning()) return
    /*
     * 本地临时缓存已经接管取流：不再做加速测速。
     *
     * 两个原因：
     *   · 测速/预热会**再开一条连接**去拉同一个地址，和缓存服务抢上游带宽（慢源上尤其明显）；
     *   · 加速中转的地址会绕开本地缓存，等于把刚缓存的字节作废、还要重新拉一遍。
     */
    if (activeCache && activeCache.gen === gen) {
      log.append('info', 'player', '本地临时缓存已接管取流：跳过加速测速/中转（避免与缓存拉取抢上游带宽）')
      return
    }
    if (!mpvReady()) {
      log.append('info', 'player', '内核还没挂载，跳过这一轮加速测速（地址已在排队，挂载后直接取流）')
      return
    }
    const progress = mpvPlaybackProgress()
    if (progress.hasPicture || progress.bytes > 0) {
      log.append(
        'info',
        'player',
        `直连已经在出数据（${Math.round(progress.bytes / 1024)} KB${progress.hasPicture ? '，已出画面' : ''}），跳过加速测速`
      )
      return
    }
    void planStreamBoost(filtered, { referer, cookies })
      .then(async (plan) => {
        // 期间用户又点了别的集/退出了播放器：这次的结果作废，别再动内核
        if (gen !== playGen) return
        /*
         * 什么时候可以省掉列表校验：测速/预热阶段已经从这路流里**真的取到一个分片**了
         * （≥1KB，见 streamBoost 的 sample）。那时再发一次 GET 纯属白拉。
         */
        const sample = plan.sample
        const alreadyProven = !!sample && sample.ok && sample.bytes >= 1024
        const usable = alreadyProven
          ? { ok: true, reason: '' }
          : await checkPlaylistUsable(filtered, referer, cookies)
        if (gen !== playGen) return
        if (!usable.ok) {
          log.append('error', 'player', `不把不可用的播放列表交给内核：${usable.reason}`)
          if (flowRunning()) {
            /*
             * 归因用 'site'：拿到的地址内容本身不可用（占位列表/需要会话），
             * 处置方式与「网络慢要再等等」完全不同 —— 用户该做的是换线路/换源。
             *
             * 用 failStageAndEnd 而不是 failStage —— 这是**确定性的失败**，
             * 必须结束整轮，否则 running 一直是 true、状态药丸停在「注入播放器」不动。
             */
            failStageAndEnd('inject', `注入失败：${usable.reason}`, 'site')
          }
          // 这次没播成：把去重记忆清掉，用户马上点重试/换回同一路时不能再被挡
          resetPlayDedupe()
          return
        }
        if (plan.boosted && plan.url) {
          const applied = mpvApplyBoost(plan.url, referer, cookies)
          if (applied) {
            log.append('info', 'player', `在线播放加速已接入内核：${plan.reason}`)
          } else if (!mpvBoostSwapped()) {
            /*
             * 没切过去，而且本轮也还没切过加速：说明直连在这段时间里已经出画面/开始拉流。
             * 这时把后台中转停掉 —— 它已经在并发拉分片，继续跑只会和内核抢带宽。
             */
            stopAllBoost()
            log.append('info', 'player', `直连已经起播，放弃加速中转（不再切流）：${plan.reason}`)
          }
        }
      })
      .catch((err) => {
        // 后台链路出任何问题都不该影响已经交给内核的直连播放
        log.append(
          'warn',
          'player',
          `后台加速决策异常（直连已在播）: ${String((err as Error)?.message ?? err).slice(0, 120)}`
        )
      })
  }, BOOST_PLAN_DELAY_MS)
}

/** 同一路流在该时间窗内重复到达时只播一次（见 enginePlay 的说明） */
const PLAY_DEDUPE_MS = 5000

let lastPlayKey = ''
let lastPlayAt = 0

/**
 * 清掉去重记忆。
 *
 * 三个必须清的时机（否则会把**应该播的**请求也挡掉）：
 *   · attach（重新挂载播放页 = 新会话）；
 *   · detach（内核已销毁，之前的"正在播这一路"不再成立）；
 *   · 这次播放被判不可用（用户马上点重试/换源，那个请求必须放行）。
 */
function resetPlayDedupe(): void {
  lastPlayKey = ''
  lastPlayAt = 0
}

/** 取播放列表的前若干字节（判「能不能播」只需要看头，不把整个列表拉下来） */
async function fetchPlaylistHead(url: string, referer?: string): Promise<{ text: string; bytes: number } | null> {
  try {
    const res = await fetch(url, {
      headers: referer ? { Referer: referer } : undefined,
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok && res.status !== 206) return null
    const text = await res.text()
    return { text, bytes: Buffer.byteLength(text, 'utf8') }
  } catch {
    return null
  }
}

/**
 * 判断这张播放列表是不是「真的能播」（只对 HLS 做，整段文件直接放过）。
 *
 * 判据刻意宽松，只挡**铁定播不出画面**的那一种：
 *   · 主列表：有 `#EXT-X-STREAM-INF` 且有变体地址 → 通过；
 *   · 媒体列表：至少有 1 个 `#EXTINF:<时长>` 且时长 > 0 → 通过；
 *   · 两者都不成立（空列表 / 全是 0 时长分片）→ 判定不可用，并把实测字段写进原因。
 * 拿不到列表（超时/网络错误）时**放过**交给内核自己报错 —— 不能因为我们的探针失败
 * 就说人家的地址不能用（那会变成新的"误报"）。
 */
async function checkPlaylistUsable(
  url: string,
  referer?: string,
  cookies?: string
): Promise<{ ok: boolean; reason: string }> {
  if (!/\.m3u8(\?|#|$)/i.test(url) && !/m3u8/i.test(url)) return { ok: true, reason: '' }
  const head = await fetchPlaylistHead(url, referer)
  if (!head) return { ok: true, reason: '' }
  const text = head.text
  if (!text.includes('#EXTM3U')) {
    return { ok: false, reason: `地址返回的不是 HLS 播放列表（${head.bytes} 字节，没有 #EXTM3U）` }
  }
  if (/#EXT-X-STREAM-INF/i.test(text)) {
    // 主列表：只要下面还有一行非注释的变体地址就算可用
    const hasVariant = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .some((l, i, arr) => i > 0 && !l.startsWith('#') && l !== '' && /#EXT-X-STREAM-INF/i.test(arr[i - 1] ?? ''))
    if (hasVariant) return { ok: true, reason: '' }
    return { ok: false, reason: `主播放列表里没有可用的变体地址（${head.bytes} 字节）` }
  }
  const durations = [...text.matchAll(/#EXTINF:\s*([0-9.]+)/gi)].map((m) => Number(m[1]))
  const usable = durations.filter((d) => Number.isFinite(d) && d > 0)
  if (usable.length > 0) return { ok: true, reason: '' }
  void cookies
  return {
    ok: false,
    reason:
      `站点返回的播放列表不可用：${head.bytes} 字节、${durations.length} 个分片` +
      (durations.length > 0 ? `、时长全为 0（多半是占位列表或需要会话的地址）` : '（没有分片，空列表）')
  }
}

export function engineTogglePause(): void {
  mpvTogglePause()
}

export function engineSeekSec(sec: number): void {
  mpvSeekSec(sec)
}

export function engineSetVolume(volume: number): void {
  mpvSetVolume(volume)
}

/** 播放倍速（v0.2.9 最后更新：README 一直宣称有，实际缺失，这里补上） */
export function engineSetSpeed(speed: number): void {
  mpvSetSpeed(speed)
}

export function engineSetMute(muted: boolean): void {
  mpvSetMute(muted)
}

export function engineGetState(): {
  time: number
  length: number
  playing: boolean
  volume: number
  muted: boolean
  /**
   * v1.5：本轮媒体是否真的出过画面（**不是** `playing`）。
   *
   * 渲染层用它做三件事：弹幕层门控、加载进度显示、控制栏门控。
   * 判据只有 `mpvHasPicture()` 一个来源（内核 `width`>0 的首帧判据），
   * 这里只做透传，绝不在这层再按 time/playing 二次推断 ——
   * 那样会出现"状态说有画面、屏幕上却一片黑"的两套说法。
   */
  hasPicture: boolean
} | null {
  const st = mpvGetState()
  if (!st || !st.ready) return null
  return {
    time: st.time,
    length: st.length,
    playing: !st.paused,
    volume: st.volume,
    muted: st.mute,
    hasPicture: mpvHasPicture()
  }
}

export function engineSubtitleTracks(): { id: number; label: string }[] {
  return mpvSubtitleTracks()
}

export function engineSetSubtitle(id: number): void {
  mpvSetSubtitle(id)
}

export function engineAddSubtitleFile(path: string): void {
  mpvAddSubtitleFile(path)
}

export function engineSnapshot(file: string): void {
  mpvSnapshot(file)
}

export function engineNotifyLayout(bounds?: PlayerBounds): void {
  if (bounds) engineSetBounds(bounds)
  mpvNotifyLayout()
}

/** 画面比例：fit=适应 / cover=裁剪铺满 / stretch=拉伸铺满 */
export function engineSetAspect(mode: 'fit' | 'cover' | 'stretch'): void {
  mpvSetAspect(mode)
}

export function engineDetach(): void {
  // 退出播放器：连同加速会话一起收掉，别让 4 条并发连接在后台继续拉流
  stopAllBoost()
  /*
   * 本地临时缓存同样要停：文件保留（LRU 里最多 N 集，拖回来还能继续），
   * 但后台不该在用户已经离开这一集之后继续拉整集 —— 那是在白烧带宽。
   */
  if (activeCache) {
    pauseTempMediaCache(activeCache.sessionId)
    activeCache = null
  }
  resetPlayDedupe()
  // 延迟决策的定时器也要撤：内核已经销毁，2.5 秒后不该再发测速请求
  clearBoostTimer()
  // 排队中的地址也要丢掉：内核已经销毁，再装载只会在下一次 attach 时播一集旧内容
  pendingPlay = null
  mpvDestroy()
}

export function engineSetPlaylist(paths: string[]): void {
  mpvSetPlaylist(paths)
}

/** 内核运行时是否就绪（libmpv DLL + 原生插件都在）——设置页与自检共用 */
export function engineAvailable(): boolean {
  return mpvAvailable()
}

/** 供设置页显示：当前内核名（固定 mpv） */
export function engineName(): string {
  const s = getSettings() as unknown as { playerEngine?: string }
  // 兼容历史设置文件里残留的 playerEngine 字段：不再影响行为，仅用于日志提示
  return s.playerEngine === 'vlc' ? 'mpv（已移除 VLC 内核，强制使用 libmpv）' : 'libmpv'
}

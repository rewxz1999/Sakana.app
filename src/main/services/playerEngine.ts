import type { BrowserWindow } from 'electron'
import { getSettings } from '../net'
import { log } from '../log'
import { failStage, flowRunning } from './playFlow'
import { proxyHlsUrl } from './adFilter'
import { planStreamBoost, stopAllBoost } from './streamBoost'
import {
  mpvAddSubtitleFile,
  mpvAttach,
  mpvAvailable,
  mpvDestroy,
  mpvGetState,
  mpvNotifyLayout,
  mpvPlay,
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
  return Promise.resolve(mpvAttach(win, b))
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
  void planStreamBoost(filtered, { referer, cookies })
    .then(async (plan) => {
      // 期间用户又点了别的集/退出了播放器：这次的结果作废，别再动内核
      if (gen !== playGen) return
      const target = plan.boosted && plan.url ? plan.url : filtered
      if (plan.boosted) {
        log.append('info', 'player', `在线播放加速生效：${plan.reason}`)
      }
      // 闸 ②：交给内核前确认这确实是一张能播的播放列表（只查 HLS）
      /*
       * 什么时候可以省掉这一查：测速/预热阶段已经从这路流里**真的取到一个分片**了
       * （≥1KB，见 streamBoost 的 sample）。那时再发一次 GET 纯属白等 ——
       * 而白等的这几百毫秒，恰好在用户最在意的"起播"路径上。
       * 只有当样本小到说明不了问题（例如真实日志里那个 0KB 的样本）时才去查列表内容。
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
           */
          failStage('inject', usable.reason, 'site')
        }
        // 这次没播成：把去重记忆清掉，用户马上点重试/换回同一路时不能再被挡
        resetPlayDedupe()
        return
      }
      mpvPlay(target, referer, cookies)
    })
    .catch((err) => {
      if (gen !== playGen) return
      log.append('warn', 'player', `加速决策异常，按直连播放: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
      try {
        mpvPlay(filtered, referer, cookies)
      } catch (e) {
        log.append('error', 'player', `直连播放也失败: ${String((e as Error)?.message ?? e).slice(0, 120)}`)
      }
    })
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
} | null {
  const st = mpvGetState()
  if (!st || !st.ready) return null
  return { time: st.time, length: st.length, playing: !st.paused, volume: st.volume, muted: st.mute }
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
  resetPlayDedupe()
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

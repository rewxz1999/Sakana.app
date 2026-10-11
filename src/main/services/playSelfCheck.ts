import { BrowserWindow } from 'electron'
import type { PlaySelfCheckFinding, PlaySelfCheckResult, StreamInfo } from '@shared/types'
import { log } from '../log'
import { closeRuleWebview, currentRuleWebviewGen, ruleWebviewDiagnostics } from './ruleWebview'
import { clearStreamCache, forgetStream, ruleProbeDiagnostics, stopRuleProbe } from './ruleProbe'
import { markReset, pushStep } from './playFlow'
import { mpvDestroy, mpvDiagnostics, mpvStreamProps } from './mpv'

/**
 * 在线播放自检 + 重置（v0.3.9）。
 *
 * 用户原话：「我之前提到的在这个播放源播放完过后切换其它播放源会出现播放失败的情况，
 * 我怀疑是资源嗅探程序没有反应过来，或者说播放器关闭后销毁切换播放源后没重建。
 * 但是一些播放源下面切换集数也会出现这种情况…所以我建议做个自检程序查看是否出现这两种情况
 * 并重置，让播放状态处于正常。」
 *
 * 所以这个自检只查**两件具体的事**，不搞泛泛的健康检查：
 *
 *   ① 嗅探残留：上一路播完之后，隐藏嗅探窗口 / 网页嗅探窗口 / webRequest 共享监听 /
 *      收尾计时器里，有没有「该销毁的还活着」「该注销的还挂着」的。
 *      这类残留实测会直接造成「抓到流却播不出来」与「有声音没画面」——
 *      残留窗口是**盖在画面区域上的独立窗口**。
 *
 *   ② 内核错配：libmpv 实例在不在、attach 的目标窗口是不是已经销毁、
 *      尺寸记录还在不在。渲染层以为在播、主进程那边其实已经销毁，是
 *      「换源后播放失败」的第二大成因。
 *
 * ⚠️ 用户要求「不要静默」：自检发现的每一条都会
 *   · 写进运行日志（log.append，日志页可见）；
 *   · 写进播放过程进度的步骤流水（过程进度显示器里能直接看到「自检做了什么」）。
 */

export interface SelfCheckOptions {
  /** false = 只体检不动作（用于「只看一眼」）；true = 发现异常就重置 */
  reset: boolean
  /**
   * 刚刚失败的那一页地址。给了就顺手把它的直链缓存删掉 ——
   * 「换源后播放失败」里有一类就是命中了缓存里已失效的一次性直链。
   */
  failedPageUrl?: string
}

// 结果类型定义在 @shared/types（要跨 IPC），这里只做一次别名，避免调用方两处 import
export type SelfCheckFinding = PlaySelfCheckFinding
export type SelfCheckResult = PlaySelfCheckResult

function finding(
  id: string,
  title: string,
  level: SelfCheckFinding['level'],
  detail: string
): SelfCheckFinding {
  return { id, title, level, detail }
}

function note(text: string): void {
  log.append('info', 'self-check', text)
  pushStep('inject', `自检：${text}`)
}

/**
 * 跑一次自检。默认 `reset: true`。
 *
 * 实现上刻意做成**同步**的：所有读数都是模块里的几个布尔量，
 * 重置动作（关窗口 / 销毁内核）本身也是异步排空的（setImmediate），
 * 没有任何需要等待的网络或磁盘 —— 所以自检可以随用户点、随失败链路自动调，不会卡界面。
 */
export function runPlaySelfCheck(opts: SelfCheckOptions = { reset: true }): SelfCheckResult {
  const at = Date.now()
  const findings: SelfCheckFinding[] = []
  const probe = ruleProbeDiagnostics()
  const webview = ruleWebviewDiagnostics()
  const engine = mpvDiagnostics()
  let probeReset = false
  let needsReattach = false
  let engineDestroyed = false

  // ---------- ① 嗅探残留 ----------
  // 隐藏窗口嗅探（ruleProbe）
  if (probe.windowDestroyed) {
    findings.push(
      finding(
        'probe-window-dead',
        '嗅探窗口已销毁但引用还在',
        'warn',
        '隐藏嗅探窗口的句柄仍被持有，但底层窗口已经销毁 —— 后续状态读写会命中尸体'
      )
    )
  } else if (probe.windowAlive && !probe.active) {
    findings.push(
      finding(
        'probe-window-residual',
        '残留的嗅探窗口',
        'warn',
        '上一轮嗅探已经结束，但隐藏窗口还活着（它可能盖在画面区域上，造成「有声音没画面」）'
      )
    )
  } else {
    findings.push(finding('probe-window', '隐藏嗅探窗口', 'ok', '没有残留窗口'))
  }
  if (!probe.active && (probe.listenersRegistered || probe.timeoutPending)) {
    findings.push(
      finding(
        'probe-listeners-residual',
        '残留的 webRequest 监听 / 收尾计时器',
        'warn',
        `嗅探已结束但监听仍挂着（listeners=${probe.listenersRegistered}）或收尾计时器仍在跑（${probe.timeoutPending}）`
      )
    )
  } else {
    findings.push(finding('probe-listeners', 'webRequest 共享监听', 'ok', '状态正常'))
  }

  // 网页视图嗅探（ruleWebview）
  if (webview.viewDestroyed) {
    findings.push(
      finding('webview-dead', '网页嗅探窗口已销毁但引用还在', 'warn', '同上：句柄指向已销毁的窗口')
    )
  } else if (webview.viewAlive && !webview.active) {
    findings.push(
      finding(
        'webview-residual',
        '残留的网页嗅探窗口',
        'warn',
        '上一轮网页嗅探已经结束，但嗅探窗口没有销毁 —— 这是「换源后失败 / 有声音没画面」的典型成因'
      )
    )
  } else {
    findings.push(finding('webview-window', '网页嗅探窗口', 'ok', '没有残留窗口'))
  }
  if (!webview.active && webview.doneTimerPending) {
    findings.push(
      finding('webview-timer-residual', '残留的嗅探收尾计时器', 'warn', '嗅探已结束但兜底计时器还挂着')
    )
  }

  // ---------- ② 内核错配 ----------
  if (engine.attachedDestroyed) {
    findings.push(
      finding(
        'engine-attach-dead',
        '播放器挂载目标窗口已销毁',
        'warn',
        '内核仍指向一个已销毁的宿主窗口：后续所有画面定位都会失败（界面以为在播，主进程这边已经没有画面了）'
      )
    )
    needsReattach = true
  } else if (!engine.attached && !engine.ready) {
    findings.push(finding('engine-idle', '播放内核', 'ok', '当前没有挂载（正常：还没进播放页或已退出）'))
  } else if (!engine.attached && engine.ready) {
    findings.push(
      finding(
        'engine-orphan',
        '内核实例存在但没有挂载窗口',
        'warn',
        'libmpv 实例还在，但宿主窗口引用已丢失 —— 表现为「界面以为在播、画面不出来」'
      )
    )
    needsReattach = true
  } else {
    findings.push(finding('engine-attach', '播放内核挂载状态', 'ok', '挂载状态正常'))
  }
  if (engine.ready && !engine.nativeLoaded) {
    findings.push(
      finding('engine-native', '原生模块引用丢失', 'warn', 'marker ready 为真但原生模块引用为空，属于内部不一致')
    )
    needsReattach = true
  }

  // ---------- 重置 ----------
  let didReset = false
  const probeProblems = findings.some((f) => f.level === 'warn' && f.id.startsWith('probe-'))
  const webviewProblems = findings.some((f) => f.level === 'warn' && f.id.startsWith('webview-'))

  if (opts.reset) {
    if (probeProblems || probe.active || probe.listenersRegistered || probe.timeoutPending) {
      // 关掉残留窗口 + 注销共享监听（stopRuleProbe 内部两者都会做）
      stopRuleProbe()
      probeReset = true
      didReset = true
    }
    if (webviewProblems || webview.active || webview.doneTimerPending) {
      const gen = currentRuleWebviewGen()
      closeRuleWebview(gen)
      didReset = true
    }
    if (probeProblems || webviewProblems) {
      markReset('关闭残留嗅探窗口与共享监听')
      note('已关闭残留的嗅探窗口并注销 webRequest 监听')
    }
    if (needsReattach) {
      // 先由主进程把已经死掉的内核实例销毁；重建交给渲染层（它才知道视频区域矩形）
      try {
        mpvDestroy()
        engineDestroyed = true
        didReset = true
        markReset('销毁错配的播放内核实例，等待渲染层重建')
        note('已销毁错配的播放内核实例，界面将重新挂载播放器')
      } catch (err) {
        log.append('warn', 'self-check', `销毁内核失败：${String((err as Error)?.message ?? err)}`)
      }
    }
    if (opts.failedPageUrl) {
      const cleared = forgetStream(opts.failedPageUrl)
      if (cleared) {
        didReset = true
        note('已清除刚刚失败那条流的直链缓存（下次会重新嗅探）')
      }
    }
  }

  if (didReset) {
    for (const f of findings) {
      if (f.level === 'warn') f.level = 'fixed'
    }
  }

  const problems = findings.filter((f) => f.level !== 'ok').length
  const result: SelfCheckResult = {
    at,
    reset: didReset,
    findings,
    problems,
    probeReset,
    needsReattach,
    engineDestroyed,
    probe,
    webview,
    engine
  }
  log.append(
    problems > 0 ? 'warn' : 'info',
    'self-check',
    problems > 0
      ? `自检发现 ${problems} 项异常${didReset ? '（已重置）' : '（仅体检，未重置）'}：${findings.filter((f) => f.level !== 'ok').map((f) => f.title).join('；')}`
      : '自检通过：嗅探与播放内核状态均正常'
  )
  return result
}

/**
 * 彻底重置整条播放链路（供设置页/自检面板的「一键重置」用）。
 *
 * 与 runPlaySelfCheck 的区别：这个不看病，直接清干净 ——
 * 关嗅探、清空直链缓存、销毁内核。用户遇到「怎么都不播」时点它一次，
 * 比退出重进应用快得多。
 */
export function hardResetPlayChain(): { clearedStreams: boolean; engineDestroyed: boolean } {
  stopRuleProbe()
  closeRuleWebview(currentRuleWebviewGen())
  clearStreamCache()
  let engineDestroyed = false
  try {
    mpvDestroy()
    engineDestroyed = true
  } catch {
    /* 内核本来就没起来 */
  }
  markReset('一键重置：清空直链缓存并销毁播放内核')
  log.append(
    'warn',
    'self-check',
    `一键重置播放链路：已关闭嗅探窗口、清空直链缓存、销毁内核（engineDestroyed=${engineDestroyed}）`
  )
  return { clearedStreams: true, engineDestroyed }
}

/** 给「播放状态详情」用：把自检的现场读数塞进 StreamInfo（避免界面再拉一次接口） */
export function selfCheckSnapshotForInfo(): StreamInfo['selfCheck'] {
  const probe = ruleProbeDiagnostics()
  const webview = ruleWebviewDiagnostics()
  const engine = mpvDiagnostics()
  const props = engine.ready ? mpvStreamProps() : null
  return {
    probeWindowAlive: probe.windowAlive,
    probeActive: probe.active,
    probeListeners: probe.listenersRegistered,
    webviewAlive: webview.viewAlive,
    webviewActive: webview.active,
    engineReady: engine.ready,
    engineAttached: engine.attached,
    engineAttachedDestroyed: engine.attachedDestroyed,
    engineHasPicture: engine.hasPicture,
    engineVideoWidth: props?.width ?? 0,
    timePumpRunning: engine.timePumpRunning
  }
}

/** 窗口在不在（自检里用来判断「界面是不是还在」） */
export function anyMainWindowAlive(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())
}

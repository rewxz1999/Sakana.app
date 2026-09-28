import { getSettings } from '../net'
import { store } from '../store'
import { log } from '../log'
import {
  buildAudioFilterChain,
  hasFilterChain,
  resolveAudioSettings,
  type AudioSettings
} from '@shared/audio'
import {
  VOLUME_MAX,
  mpvAvailable,
  mpvSetAudioFilter,
  mpvSetVolumeRaw,
  setAudioApplyHook,
  setAudioResetHook,
  setSpeedApplyHook
} from './mpv'

/**
 * 音频（音质调控）服务（v0.3.6）。
 *
 * 职责边界：
 *   · 设置的**读取与写回**（`settings.audio`）
 *   · 把设置翻译成 mpv 的 `af` 链与 `volume` 属性（翻译逻辑在 `@shared/audio`，与渲染层共用）
 *   · 指纹去重（设置页拖滑杆会连续写 store，不能每次重建滤镜链 —— 会掉音）
 *
 * 与倍速的关系是这一版的**关键修复点**：老代码 `mpvSetSpeed` 在 1x 时直接 `af clr`、
 * 变速时 `af set scaletempo2`，也就是**整链替换**。加上音频滤镜后如果还这么做，
 * 用户一变速就会把均衡器/压缩器整条冲掉（表现为「变速之后音效就没了」）。
 * 现在两边都走同一个 `applyAudio()`，链里同时包含音效与 scaletempo2。
 */

/** 上一次应用到 mpv 的（链 + 音量）指纹：一致就什么都不做 */
let lastAppliedKey = ''
/** 当前倍速（参与链的拼装：非 1x 时要带 scaletempo2） */
let currentSpeed = 1

/** 当前设置（已收窄） */
export function audioSettings(): ReturnType<typeof resolveAudioSettings> {
  return resolveAudioSettings((getSettings() as { audio?: AudioSettings }).audio)
}

/** mpv 的「音量」属性值：增益 × 100，夹在 0~VOLUME_MAX */
export function audioVolume(): number {
  const s = audioSettings()
  return Math.round(Math.max(0, Math.min(VOLUME_MAX, s.gain * 100)))
}

/**
 * 把音频设置应用到正在运行的 mpv。
 *
 * 三个调用点（与 Anime4K 的画质设置同构）：
 *   ① mpvAttach 建好实例之后；
 *   ② 用户在设置页改音频项（ipc.ts 的 store 写入钩子）；
 *   ③ 倍速变化（`setSpeedFromRenderer`）—— 因为 scaletempo2 也在这条链上。
 *
 * @returns 实际写进 mpv 的滤镜链（空串 = 已清空），供自检核对
 */
export function applyAudio(): string {
  if (!mpvAvailable()) return ''
  const s = audioSettings()
  const chain = buildAudioFilterChain(s, { speed: currentSpeed })
  const vol = audioVolume()
  const key = `${chain}\u0000${vol}`
  if (key === lastAppliedKey) return chain
  lastAppliedKey = key

  // ① 滤镜链：有一条就 set，没有就 clr（**必须** clr，否则关掉增强后旧滤镜还在生效）
  const r = mpvSetAudioFilter(hasFilterChain(s, { speed: currentSpeed }) ? chain : '')
  if (!r.ok) {
    log.append('warn', 'audio', `音频滤镜链被 mpv 拒绝（将继续用原声）: ${r.error}｜af=${chain}`)
  }
  // ② 音量（软件增益，上限 200%）
  mpvSetVolumeRaw(vol)
  log.append(
    'info',
    'audio',
    `音频设置已应用：音量 ${vol}%${chain ? `，滤镜 ${chain.split(',').length} 个` : '，无滤镜'}`
  )
  return chain
}

/** 复位指纹（实例销毁后必须重设一次，哪怕设置没变） */
export function resetAudioApplied(): void {
  lastAppliedKey = ''
}

/*
 * 注册给 mpv 的三个回调（放在模块顶层，import 本模块即生效）：
 *   · 实例销毁后复位指纹
 *   · 实例就绪后应用音频设置（音量 + 滤镜链）
 *   · 倍速变化时重拼滤镜链（scaletempo2 也在这条链上）
 * 用回调插槽而不是互相 import：audioSettings 已经 import 了 mpv，
 * 反向 import 会形成循环依赖（见 mpv.ts 里 setAudioResetHook 的注释）。
 */
setAudioResetHook(resetAudioApplied)
setAudioApplyHook(applyAudio)
setSpeedApplyHook(audioSetSpeed)

/** 倍速变化时同步重拼链（scaletempo2 在链上，见文件头说明） */
export function audioSetSpeed(speed: number): void {
  const s = Math.max(0.25, Math.min(4, Number(speed) || 1))
  currentSpeed = s
  resetAudioApplied()
  applyAudio()
}

/** 当前倍速（自检用） */
export function audioSpeed(): number {
  return currentSpeed
}

/**
 * 写回音频设置（供 uosc 菜单/控制栏这类不经渲染层设置的入口调用）。
 * 与 `store.set('settings', …)` 同一条路：主进程的写入钩子会顺手重应用一次。
 */
export function saveAudioSettings(patch: Partial<AudioSettings>): void {
  const cur = store.get<Record<string, unknown>>('settings', {})
  const prev = (cur.audio ?? {}) as AudioSettings
  store.set('settings', { ...cur, audio: { ...prev, ...patch } })
}

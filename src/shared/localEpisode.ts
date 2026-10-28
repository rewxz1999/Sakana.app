/**
 * 本地播放的「第几集」计算（V1.5.3）。
 *
 * 为什么单独一个纯函数：
 *   · 播放器写进度（rememberLocal / reportPosition / 断点续播）与本地详情页标记"已看"
 *     必须用**同一套**集数口径，否则会出现"播放页记第 5 集、详情页算第 1 集"；
 *   · 文件名解析不出集数时只能退回列表下标（`第 N 个文件`），这条兜底也要一致；
 *   · 纯函数可以在 Node 里直接断言（见 `.e2e/verify-v153.mjs`），不必起 Electron。
 *
 * 参数用 0-based：`episode` 是文件名里解析出的真实集数（如 5），返回值是 `4` ——
 * 与 `WatchProgressItem.episodeIndex` / `epKey(group, ep)` 的既有约定保持一致。
 */
export function localEpisodeIndex(
  episode: number | null | undefined,
  fallbackIndex: number
): number {
  if (typeof episode === 'number' && Number.isFinite(episode) && episode > 0) return episode - 1
  return Math.max(0, Math.floor(Number(fallbackIndex) || 0))
}

/** 0-based 集序号 → 展示用集数（第 N 集） */
export function localEpisodeNumber(episodeIndex: number): number {
  return Math.max(0, Math.floor(Number(episodeIndex) || 0)) + 1
}

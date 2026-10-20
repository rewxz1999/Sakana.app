/**
 * 本地临时缓存（边下边播）的共享口径。
 *
 * 这个文件只放「主进程与设置页必须一致」的常量与收窄函数：
 *   · 主进程按它决定最多保留几集（超过就按最久未用淘汰）；
 *   · 设置页按它画滑杆、夹范围；
 *   · 两边用**同一个** `resolveTempMediaCacheEpisodes`，所以界面显示 3 集时，
 *     主进程一定也是 3 集 —— 不会出现「界面写着 3、磁盘上留了 8 集」这种对不上的情况。
 *
 * 为什么上限是 10 集：一集临时缓存的文件体积与片源大小相当（常见 200MB~1.5GB），
 * 10 集就已经是 2~15GB。设置项是给「想多留几集、退出前还能回看」的人用的，
 * 不是拿来当长期片库；再往上放只会悄悄吃满用户的硬盘。
 */

/**
 * 允许临时缓存的集数下限。
 *
 * V1.2.8：从 1 改成 **0 = 关闭临时缓存**。
 * 为什么：真机上出现"进度条缩略图是白窗"，而 thumbfast 用的是**另一个独立 mpv 进程**、
 * 拿的是我们本地缓存服务器的地址 —— 要验证"是不是缓存服务让子进程截不到帧"，
 * 用户必须能一键关掉缓存。原来下限是 1，界面上根本设不了 0，这条排查路就断了。
 */
export const TEMP_MEDIA_CACHE_EPISODES_MIN = 0

/** 允许临时缓存的集数上限（见文件头的空间说明） */
export const TEMP_MEDIA_CACHE_EPISODES_MAX = 10

/** 默认集数（用户要求默认 3 集） */
export const TEMP_MEDIA_CACHE_EPISODES_DEFAULT = 3

/**
 * 把设置值收窄到 0–10 的整数（0 = 关闭临时缓存，V1.2.8）。
 *
 * 为什么要收窄而不是原样信任设置文件：`settings.json` 是用户可编辑的普通 JSON，
 * 也可能被旧版本/手工改坏。这里不抛错、只夹到合法区间：
 * 播放链路永远拿到一个能用的数字，坏值不会变成「无限缓存」。
 */
export function resolveTempMediaCacheEpisodes(v: unknown): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return TEMP_MEDIA_CACHE_EPISODES_DEFAULT
  return Math.min(TEMP_MEDIA_CACHE_EPISODES_MAX, Math.max(TEMP_MEDIA_CACHE_EPISODES_MIN, n))
}

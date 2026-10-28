/**
 * Tracker 列表的纯逻辑（V1.5.2）。
 *
 * 单独放在 shared 里有两个原因：
 *   1. 主进程的 `downloader/trackers.ts` 要联网/落盘，没法在自检里直接跑；
 *      而"合并、去重、截断、过滤"这些规则才是真正容易写错、也最值得断言的部分；
 *   2. 将来设置页若要显示"这一条是否合法"，渲染层也能直接用同一份判断。
 */

/** 内置兜底 Tracker（外部列表拉到后会与它合并，而不是替换） */
export const BUILTIN_TRACKERS: string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://9.rarbg.com:2810/announce',
  /*
   * V1.5.2：补几条 **HTTP** tracker。
   *
   * 为什么重要：部分网络/系统里 aria2 的 HTTPS（WinTLS）与 UDP 都不通，能用的只剩纯 HTTP；
   * 而蜜柑种子自带的 tracker（tr.bangumi.moe / t.nyaatracker.com）经常是死的。
   * 这里放的都是社区长期在用的 HTTP 入口，配合 `bt-tracker-interval=120` 能较快发现做种者。
   */
  'http://tracker.opentrackr.org:1337/announce',
  /*
   * nyaa 的 tracker 是**番剧种子最关键的一条**：蜜柑大量资源转载自 nyaa，
   * 但蜜柑种子自带的 announce-list 里往往没有 nyaa，而其它内嵌 tracker 全是死的。
   * 实测《败犬女主太多了》第 12 集：nyaa scrape 显示 16 个做种者；
   * 排除内嵌 tracker、只用这条 + 公共列表后，10 秒内连上 17 个对端并开始下载。
   */
  'http://nyaa.tracker.wf:7777/announce',
  'http://t.nyaatracker.com/announce',
  'http://tracker.files.fm:6969/announce',
  'http://tracker.bt4g.com:2095/announce',
  'http://tracker2.dler.org:80/announce'
]

/** 默认 Tracker 列表地址（ngosang/trackerslist 的 best 列表，走 jsDelivr CDN） */
export const DEFAULT_TRACKER_URL =
  'https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt'

/** 列表上限：aria2 的 bt-tracker 太长会拖慢 announce，200 条足够 */
export const MAX_TRACKERS = 200

/** 一条合法的 tracker 行（允许 http/https/udp/ws/wss；注释与空行不算） */
export function validTracker(line: string): boolean {
  const s = line.trim()
  if (!s || s.startsWith('#')) return false
  return /^(https?|udp|wss?):\/\/[^\s]+$/i.test(s)
}

/** 把 ngosang 那种"一行一个"的文本解析成列表 */
export function parseTrackerText(text: string): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter(validTracker)
}

/** 合并内置 + 外部列表，按字符串去重并截断到上限（内置永远在最先） */
export function mergeTrackerLists(list: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of [...BUILTIN_TRACKERS, ...list]) {
    const s = String(t ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= MAX_TRACKERS) break
  }
  return out
}

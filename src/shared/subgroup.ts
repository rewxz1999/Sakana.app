// 字幕组匹配规则（主进程过滤与「确认下载」弹窗共用同一份，避免两边规则漂移）

/**
 * 字幕组名归一化。
 *
 * 同一个字幕组在 RSS 里会写成 `[绿茶字幕组&LoliHouse]` / `[绿茶字幕组 & LoliHouse]`，
 * 全角半角、大小写、& 两侧空格都可能不一样；不归一化就会把自家资源当成别人的丢掉。
 */
export function normGroup(g: string | null | undefined): string {
  return (g ?? '')
    .normalize('NFKC')
    .replace(/\s*&\s*/g, '&')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * 该资源是否属于订阅选定的字幕组。
 *
 * 关键：订阅指定了字幕组时，**解析不出字幕组的资源一律不算**。
 * 蜜柑里存在整季不带 `[字幕组]` 前缀的资源（例如
 * 「二十世纪电气目录「…」Sparks of Tomorrow S01E11 1080p 日英双语-多国字幕」），
 * 老代码 `if (sub.group && item.group && item.group !== sub.group) return false` 里的
 * `item.group &&` 让这些条目绕过了过滤，于是订阅桜都字幕组的「确认下载」弹窗里
 * 混进了别的资源 —— 这就是「资源串了字幕组」的根因（见 mikan.checkSub）。
 */
export function matchesSubGroup(subGroup: string | null, itemGroup: string | null): boolean {
  if (!subGroup) return true // 订阅没指定字幕组（老数据）：无从过滤，保持原样
  if (!itemGroup) return false
  return normGroup(subGroup) === normGroup(itemGroup)
}

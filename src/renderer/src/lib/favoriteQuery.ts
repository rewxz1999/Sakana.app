// 收藏列表的「排序 + 多关键词筛选」（对齐 Kazumi 的 lib/pages/collect/collect_library_query.dart）
//
// 纯函数：不依赖 React，不改动入参，方便单独验证。

import type { FavoriteItem } from '@shared/types'

export type FavoriteSort = 'recent' | 'title' | 'rating' | 'airDate'

/** 四种排序模式，与 Kazumi 的 CollectSort 一一对应 */
export const FAVORITE_SORTS: { id: FavoriteSort; label: string; title: string }[] = [
  { id: 'recent', label: '最近变更', title: '最近变更（默认：保持原有顺序）' },
  { id: 'title', label: '番剧名称', title: '番剧名称（按名称排序）' },
  { id: 'rating', label: '评分最高', title: '评分最高（高→低，未评分排最后）' },
  { id: 'airDate', label: '开播时间', title: '开播时间（新→旧，开播日期未知排最后）' }
]

/** 展示名：优先中文名，其次原名（与 Kazumi 的 titleOf 一致） */
export function favoriteTitle(f: FavoriteItem): string {
  const cn = (f.nameCn || '').trim()
  return cn || f.name || String(f.subjectId)
}

/**
 * 参与匹配的名字字段。
 * 本应用的数据结构里只有「中文名 + 原名」；别名（aliases / alias）在历史或外部导入的数据里
 * 可能出现，存在就一并匹配、不存在也不影响（不改动 FavoriteItem 的类型定义）。
 */
function nameFieldsOf(f: FavoriteItem): string[] {
  const extra = f as FavoriteItem & { aliases?: unknown; alias?: unknown }
  const out: string[] = [f.nameCn, f.name]
  for (const raw of [extra.aliases, extra.alias]) {
    if (Array.isArray(raw)) {
      for (const v of raw) if (typeof v === 'string') out.push(v)
    } else if (typeof raw === 'string') {
      out.push(raw)
    }
  }
  return out.filter((s) => typeof s === 'string' && s.trim().length > 0)
}

/**
 * 多关键词匹配：关键词按空格拆分，**每个词都要命中**（AND），大小写不敏感。
 * 查询为空 → 全部通过。
 */
export function matchesFavoriteQuery(f: FavoriteItem, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const hay = nameFieldsOf(f).join('\n').toLowerCase()
  return terms.every((t) => hay.includes(t))
}

/**
 * 按模式排序（返回新数组）。
 * - recent：保持传入顺序（即 store 里的加入顺序）= 原有行为，不重新排列；
 * - 各模式平手时按加入时间新→旧，保证顺序稳定（与 Kazumi 的兜底一致）。
 */
export function sortFavorites(list: FavoriteItem[], mode: FavoriteSort): FavoriteItem[] {
  const out = list.slice()
  if (mode === 'recent') return out
  out.sort((a, b) => {
    let c = 0
    if (mode === 'title') {
      c = favoriteTitle(a).toLowerCase().localeCompare(favoriteTitle(b).toLowerCase(), 'zh-Hans-CN')
    } else if (mode === 'rating') {
      c = (b.rating ?? -1) - (a.rating ?? -1) // 未评分按 -1 处理 → 排最后
    } else {
      // 开播时间：airDate 是 YYYY-MM-DD 字符串，直接比较即按时间先后；缺日期的排最后
      const av = a.airDate
      const bv = b.airDate
      if (av && !bv) c = -1
      else if (!av && bv) c = 1
      else c = (bv ?? '').localeCompare(av ?? '')
    }
    if (c !== 0) return c
    return b.addedAt - a.addedAt
  })
  return out
}

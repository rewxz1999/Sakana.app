import { useEffect, useMemo, useState } from 'react'
import type { CalendarItem } from '@shared/types'
import { blockReason, shouldLoadTags, summarizeBlocked, type ScheduleBlockConfig } from '@shared/scheduleBlock'
import { api } from '@/lib/api'
import { useScheduleBlock, useScheduleTags } from '@/stores/schedule'

/**
 * 番剧表「屏蔽」相关的公共数据层（v0.3.9）。
 *
 * 为什么抽出来：用户在 v0.3.9 要求把「番剧表设置」里的黑名单、屏蔽表拆成两个独立设置项，
 * 三个页面（番剧表设置总览 / 黑名单 / 屏蔽表）都要用同一份数据：
 * 本周番剧表条目、标签缓存、每条目的屏蔽原因。如果每个页面各拉一次各算一遍，
 * 三份实现迟早会分叉（比如有的页面拿不到标签就当成"不屏蔽"、有的页面误杀），
 * 而且标签补全的节流队列也会被重复触发。所以统一放在这里，三个页面共用同一套判据。
 *
 * ⚠️ 关键降级语义保持原样：`reasonOf` 里没有的条目 = 不屏蔽（标签没取到一律不屏蔽）。
 */

export interface PickerRow {
  item: CalendarItem
  /** 该条目在番剧表里的星期（「周一」这种），列表里显示一下便于对上号 */
  weekday: string
}

export interface ScheduleBlockData {
  cfg: ScheduleBlockConfig
  patch: (p: Partial<ScheduleBlockConfig>) => void
  toggleBlacklist: (id: number) => void
  /** 本周番剧表条目（按 id 去重） */
  rows: PickerRow[]
  /** 番剧表是否已读完（读不到时界面要显示「暂时读不到番剧表数据」而不是空列表） */
  listReady: boolean
  weekCount: number
  /** 条目 id → 屏蔽原因（黑名单 / 一级：xxx / …；没有键 = 不屏蔽） */
  reasonOf: Map<number, string>
  blockedCount: number
  /** 屏蔽原因 → 条目数（黑名单 3 部 / 一级：子供向 5 部 …） */
  reasonStats: Record<string, number>
  /** 是否还有任何标签屏蔽规则开启（全关时不请求任何番剧详情） */
  tagRulesOn: boolean
  /** 标签缓存进度：已尝试（成功 + 失败）/ 本周总数 */
  tagDone: number
  tagFailedInWeek: number
  fetchingTags: boolean
}

export function useScheduleBlockData(): ScheduleBlockData {
  const { cfg, load, save, toggleBlacklist } = useScheduleBlock()
  const { tags, failed, fetching, ensureTags } = useScheduleTags()

  /* 番剧表本周条目：这里独立读一份，避免在小窗口里改到全局 schedule store 的状态 */
  const [rows, setRows] = useState<PickerRow[]>([])
  const [listReady, setListReady] = useState(false)

  // 读配置（独立 store 键 scheduleBlock；读不到就用默认值 = 只开一级）
  useEffect(() => {
    void load()
  }, [load])

  // 黑名单选择列表的数据：本周番剧表（主进程有磁盘缓存，正常情况不会真的发请求）
  useEffect(() => {
    let alive = true
    void api.bangumi.calendar().then((r) => {
      if (!alive) return
      if (r.ok) {
        const map = new Map<number, PickerRow>()
        for (const day of r.data.days) {
          for (const item of day.items) {
            if (!map.has(item.id)) map.set(item.id, { item, weekday: day.weekday.cn })
          }
        }
        setRows([...map.values()])
      }
      setListReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const tagRulesOn = shouldLoadTags(cfg)

  /**
   * 补齐本周条目的标签（与番剧表页用的是同一个缓存与队列）。
   * 开关全关时不发任何请求 —— 判据就是 shared 里的 shouldLoadTags，
   * 番剧表页与设置页共用它，所以「不影响搜索结果」在流量层面也成立。
   */
  const weekIds = useMemo(() => rows.map((r) => r.item.id), [rows])
  useEffect(() => {
    if (!tagRulesOn) return
    if (weekIds.length === 0) return
    ensureTags(weekIds)
  }, [tagRulesOn, weekIds, ensureTags])

  /** 每条目当前的屏蔽原因（没标签的条目恒为 null = 不屏蔽） */
  const reasonOf = useMemo(() => {
    const map = new Map<number, string>()
    for (const r of rows) {
      const reason = blockReason(r.item, tags[r.item.id], cfg)
      if (reason) map.set(r.item.id, reason)
    }
    return map
  }, [rows, tags, cfg])

  const blockedRows = useMemo(() => rows.filter((r) => reasonOf.has(r.item.id)), [rows, reasonOf])
  const reasonStats = useMemo(
    () => summarizeBlocked(blockedRows.map((r) => ({ reason: reasonOf.get(r.item.id) ?? '' }))),
    [blockedRows, reasonOf]
  )

  return {
    cfg,
    patch: save,
    toggleBlacklist,
    rows,
    listReady,
    weekCount: rows.length,
    reasonOf,
    blockedCount: blockedRows.length,
    reasonStats,
    tagRulesOn,
    tagDone: rows.filter((r) => r.item.id in tags || failed.includes(r.item.id)).length,
    tagFailedInWeek: rows.filter((r) => failed.includes(r.item.id)).length,
    fetchingTags: fetching
  }
}

import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Layers, Loader2, Plus, Search } from 'lucide-react'
import type { StatAddItem, StatAddSource } from '@shared/types'
import { absoluteSeasonIndex, fromAbsoluteSeasonIndex, seasonLabel, seasonOfDate, shiftAbsoluteSeasonIndex } from '@shared/season'
import { api } from '@/lib/api'
import { favoriteToAddItem, useStatTool } from '@/stores/statTool'
import { useLibrary } from '@/stores/library'
import { toast } from '@/stores/app'
import { Badge, Button, EmptyState, Modal } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'

/**
 * 添加番剧（批量 + 快速添加当季）。
 *
 * 三个来源共用一个候选网格，勾选是**跨来源累积**的（先挑收藏里的几部，
 * 再切到「当季」补几部，最后一次性加入），这正对应用户说的「可以批量添加番剧」。
 *
 * 状态流转：
 * - `source` = favorites | season | search，只影响候选列表怎么来；
 * - `picked`（key → StatAddItem）跨来源保留，切换 tab 不会清空；
 * - 「加入列表」把 picked 的值一次性发给主进程（addEntries 一次调用 = 一次读-改-写 + 一次广播），
 *   重复条目由主进程忽略，这里按返回值提示「新增 N 部，M 部已在列表中」。
 */
export function BatchAddDialog({
  open,
  listId,
  onClose
}: {
  open: boolean
  listId: string | null
  onClose: () => void
}) {
  const favorites = useLibrary((s) => s.favorites)
  const data = useStatTool((s) => s.data)
  const addEntries = useStatTool((s) => s.addEntries)

  const [source, setSource] = useState<StatAddSource>('favorites')
  const [picked, setPicked] = useState<Record<string, StatAddItem>>({})
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  // 当季番剧（默认当前季度，可前后翻季）
  const [seasonAbs, setSeasonAbs] = useState(() => {
    const s = seasonOfDate()
    return absoluteSeasonIndex(s.year, s.season)
  })
  const [seasonItems, setSeasonItems] = useState<StatAddItem[]>([])
  const [seasonLoading, setSeasonLoading] = useState(false)

  const [searchItems, setSearchItems] = useState<StatAddItem[]>([])
  const [searching, setSearching] = useState(false)

  const { year, season } = fromAbsoluteSeasonIndex(seasonAbs)

  // 打开时清空选择（避免上次的残留被误加进另一个列表）
  useEffect(() => {
    if (open) {
      setPicked({})
      setQuery('')
    }
  }, [open])

  // 只在切到「当季」时拉数据（打开弹窗默认收藏 tab，不会白拉一次季度接口）
  useEffect(() => {
    if (!open || source !== 'season') return
    let alive = true
    setSeasonLoading(true)
    void api.bangumi.season(year, season * 3).then((r) => {
      if (!alive) return
      setSeasonLoading(false)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      if (r.data.error) {
        toast.warn(`季度数据源异常：${r.data.error.message}（显示的可能是不完整结果）`)
      }
      setSeasonItems(
        r.data.items.map((it) => ({
          subjectId: it.id,
          name: it.name,
          nameCn: it.name_cn || it.name,
          cover: it.images?.large ?? it.images?.common ?? '',
          airDate: it.air_date,
          rating: it.rating?.score ?? null
        }))
      )
    })
    return () => {
      alive = false
    }
  }, [open, source, year, season])

  const existingIds = useMemo(
    () => new Set((data.entries ?? []).filter((e) => e.listId === listId).map((e) => e.subjectId)),
    [data.entries, listId]
  )

  const kw = query.trim().toLowerCase()
  const candidates: StatAddItem[] = useMemo(() => {
    if (source === 'favorites') {
      return favorites
        .filter((f) => !kw || f.nameCn.toLowerCase().includes(kw) || f.name.toLowerCase().includes(kw))
        .map(favoriteToAddItem)
    }
    if (source === 'season') return seasonItems
    return searchItems
  }, [source, favorites, kw, seasonItems, searchItems])

  async function runSearch(): Promise<void> {
    const k = query.trim()
    if (!k) {
      toast.warn('请输入关键词')
      return
    }
    setSearching(true)
    const r = await api.bangumi.search(k)
    setSearching(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (r.data.error) toast.warn(`搜索异常：${r.data.error.message}`)
    setSearchItems(
      r.data.items.map((it) => ({
        subjectId: it.id,
        name: it.name,
        nameCn: it.name_cn || it.name,
        cover: it.images?.large ?? it.images?.common ?? '',
        airDate: it.air_date,
        rating: it.rating?.score ?? null
      }))
    )
  }

  const pickedList = Object.values(picked)

  function toggle(it: StatAddItem): void {
    const key = it.subjectId > 0 ? String(it.subjectId) : `${it.nameCn}|${it.name}`
    setPicked((prev) => {
      const next = { ...prev }
      if (next[key]) delete next[key]
      else next[key] = it
      return next
    })
  }

  async function submit(): Promise<void> {
    if (!listId) return
    if (pickedList.length === 0) {
      toast.warn('先勾选要添加的番剧')
      return
    }
    setBusy(true)
    const added = await addEntries(listId, pickedList)
    setBusy(false)
    if (added === 0) toast.warn('这些番剧都已经在列表里了')
    else if (added < pickedList.length) toast.success(`新增 ${added} 部（${pickedList.length - added} 部已在列表中）`)
    else toast.success(`已添加 ${added} 部番剧`)
    onClose()
  }

  /** 一键把「当季」当前页里还没加过的全选上（用户要的「快速添加当季番剧」） */
  function pickWholeSeason(): void {
    setPicked((prev) => {
      const next = { ...prev }
      for (const it of seasonItems) {
        if (existingIds.has(it.subjectId)) continue
        next[String(it.subjectId)] = it
      }
      return next
    })
  }

  const tabs: { key: StatAddSource; label: string }[] = [
    { key: 'favorites', label: `收藏（${favorites.length}）` },
    { key: 'season', label: '当季番剧' },
    { key: 'search', label: '搜索' }
  ]

  return (
    <Modal open={open} onClose={onClose} title="添加番剧（可批量）" width={760}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setSource(t.key)}
            className={`h-8 rounded-lg px-3 text-xs font-medium transition-colors ${
              source === t.key ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
            }`}
          >
            {t.label}
          </button>
        ))}
        <span className="flex-1" />
        {source === 'season' ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="上一季"
              onClick={() => setSeasonAbs((a) => shiftAbsoluteSeasonIndex(a, -1))}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-dim transition-colors hover:border-accent hover:text-accent"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="min-w-[112px] text-center text-xs text-dim">{seasonLabel(year, season)}</span>
            <button
              type="button"
              title="下一季"
              onClick={() => setSeasonAbs((a) => shiftAbsoluteSeasonIndex(a, 1))}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-dim transition-colors hover:border-accent hover:text-accent"
            >
              <ChevronRight size={14} />
            </button>
            <Button size="sm" variant="soft" icon={Layers} onClick={pickWholeSeason}>
              全选当季
            </Button>
          </div>
        ) : null}
      </div>

      {source === 'search' ? (
        <div className="mb-3 flex gap-2">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch()
              }}
              placeholder="按番剧名搜索 bangumi 条目…"
              className="h-9 w-full rounded-lg border border-border bg-elev1 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-accent"
            />
          </div>
          <Button variant="outline" loading={searching} onClick={() => void runSearch()}>
            搜索
          </Button>
        </div>
      ) : null}

      {source === 'favorites' && favorites.length > 3 ? (
        <div className="relative mb-3">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="在收藏里过滤…"
            className="h-9 w-full rounded-lg border border-border bg-elev1 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-accent"
          />
        </div>
      ) : null}

      {source === 'season' && seasonLoading ? (
        <div className="flex items-center justify-center gap-2 py-14 text-xs text-faint">
          <Loader2 size={16} className="animate-spin text-accent" /> 正在获取 {seasonLabel(year, season)}…
        </div>
      ) : candidates.length === 0 ? (
        <EmptyState
          icon={source === 'favorites' ? Plus : Search}
          title={source === 'favorites' ? '没有匹配的收藏' : '暂无数据'}
          desc={
            source === 'favorites'
              ? '先在收藏页收藏番剧，或改用「当季番剧」/「搜索」添加。'
              : '换个季度或关键词再试。'
          }
        />
      ) : (
        <div className="grid max-h-[50vh] grid-cols-2 gap-2 overflow-y-auto pr-1">
          {candidates.map((it) => {
            const key = it.subjectId > 0 ? String(it.subjectId) : `${it.nameCn}|${it.name}`
            const on = !!picked[key]
            const exists = it.subjectId > 0 && existingIds.has(it.subjectId)
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggle(it)}
                className={`flex items-center gap-2.5 rounded-xl border p-2 text-left transition-colors ${
                  on ? 'border-accent bg-accent-soft' : 'border-border bg-elev1 hover:border-accent/50'
                }`}
              >
                <CoverImage src={it.cover} className="h-14 w-10 shrink-0 rounded-md" />
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-xs font-medium leading-snug">{it.nameCn || it.name}</div>
                  <div className="mt-0.5 text-[10px] text-faint">
                    {it.airDate ?? '放送时间未知'}
                    {it.rating != null ? ` · ${it.rating.toFixed(1)} 分` : ''}
                  </div>
                </div>
                {exists ? <Badge tone="warn">已在列表</Badge> : on ? <Badge tone="accent">已选</Badge> : null}
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[11px] text-faint">
          已选 {pickedList.length} 部
          {pickedList.length > 0 && source !== 'favorites'
            ? '（跨来源累积，切换标签不会清空）'
            : ''}
        </span>
        <div className="flex gap-2">
          {pickedList.length > 0 ? (
            <Button variant="ghost" onClick={() => setPicked({})}>
              清空选择
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={busy} disabled={pickedList.length === 0} onClick={() => void submit()}>
            加入列表
          </Button>
        </div>
      </div>
    </Modal>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Heart, Plus, Search } from 'lucide-react'
import type { SearchResultItem, SeasonItem } from '@shared/types'
import { monthsOfSeason, seasonLabel, seasonOfDate, SEASON_NAMES, type SeasonIndex } from '@shared/season'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { useLibrary } from '@/stores/library'
import {
  pageInputFromFavorite,
  pageInputFromSearch,
  pageInputFromSeason,
  type RecommendPageInput
} from '@/stores/recommendTable'
import { Badge, Button, Input, Select, Spinner } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'

/**
 * 「添加作品」面板 —— 三条入口：**搜索** / **当季番剧** / **收藏**（用户需求 2 及其追加）。
 *
 * 为什么三条都留着：起点完全不同 ——
 *   · 搜索：心里已经想好要推荐哪部（可能是老番）；
 *   · 当季：做「本季新番推荐」；
 *   · 收藏（v0.3.7 追加）：把本机已经收藏的那几部做成推荐表，一次点几下就够。
 *
 * 数据侧的三点：
 * 1. 季度与搜索结果**都没有类型标签**（只有详情接口有），所以这里只把能拿到的字段交出去，
 *    标签由 store 的 `backfill` 在加入之后补齐（见 recommendTable.ts 文件头 ⑤）；
 *    **收藏自带标签**，所以那一路不需要补。
 * 2. month 传该季度的第一个月即可：主进程按季度规范化并缓存（见 shared/api.ts 的注释）。
 * 3. 收藏读的是 `stores/library`（本机数据，不联网），从没进过收藏页时这里按需 load 一次。
 */

/** 年份选择范围：往前 6 年（补老番）、往后 1 年（明年 1 月番有时已经登记） */
const YEAR_SPAN_BACK = 6
const YEAR_SPAN_FORWARD = 1

type Tab = 'search' | 'season' | 'favorites'

/** 搜索结果与季度条目共用的展示行（两边的字段名一致，所以能共用） */
function ResultRow({
  title,
  sub,
  cover,
  rating,
  airDate,
  added,
  onAdd,
  /**
   * 可选的多选勾框（只有「收藏」这一路用得到）：
   * 单个添加走右侧按钮，勾框只负责「一次加多部」，两条路都留着（用户原话「可多选或逐个点加」）。
   */
  select
}: {
  title: string
  sub: string
  cover: string
  rating: number | null
  airDate: string | null
  added: boolean
  onAdd: () => void
  select?: { checked: boolean; onToggle: () => void }
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border bg-elev1 p-2">
      {select ? (
        <input
          type="checkbox"
          disabled={added}
          checked={select.checked}
          title={added ? '已经在这张表里了' : '勾上可以一次加多部'}
          onChange={select.onToggle}
          className="h-4 w-4 shrink-0 accent-accent disabled:opacity-30"
        />
      ) : null}
      <CoverImage src={cover} alt={title} className="h-16 w-11 shrink-0" rounded="rounded-md" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium" title={title}>
          {title}
        </div>
        {sub ? <div className="truncate text-[10px] text-faint">{sub}</div> : null}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-faint">
          {rating !== null ? <Badge tone="accent">{rating.toFixed(1)}</Badge> : null}
          <span>{airDate || '日期未知'}</span>
        </div>
      </div>
      <Button
        size="sm"
        variant={added ? 'ghost' : 'soft'}
        icon={added ? undefined : Plus}
        disabled={added}
        // 已在表里的条目直接禁用：点了也只会收到「已经在这张表里了」，不如当场说清楚
        title={added ? '这部番剧已经在这张推荐表里了' : '添加到推荐表'}
        onClick={onAdd}
      >
        {added ? '已添加' : '添加'}
      </Button>
    </div>
  )
}

export function SubjectPicker({
  /** 已经在表里的番剧 id（用来把「添加」变成「已添加」） */
  addedIds,
  onAdd,
  /** 一次加多部（从收藏多选时用；返回加了几部，界面据此给提示） */
  onAddMany
}: {
  addedIds: ReadonlySet<number>
  onAdd: (input: RecommendPageInput, title: string) => void
  onAddMany: (inputs: RecommendPageInput[], titles: string[]) => void
}) {
  const [tab, setTab] = useState<Tab>('search')

  // ---------------- 搜索 ----------------
  const [keyword, setKeyword] = useState('')
  const [searchItems, setSearchItems] = useState<SearchResultItem[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)

  async function runSearch(): Promise<void> {
    const k = keyword.trim()
    if (!k) {
      toast.warn('先输入关键词再搜索')
      return
    }
    setSearching(true)
    const r = await api.bangumi.search(k)
    setSearching(false)
    setSearched(true)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    // 数据源整体报错时仍可能有（不完整的）结果，照常渲染并把原因说出来
    if (r.data.error) toast.warn(`搜索异常：${r.data.error.message}（结果可能不完整）`)
    setSearchItems(r.data.items)
  }

  // ---------------- 当季番剧 ----------------
  const now = useMemo(() => seasonOfDate(), [])
  const [year, setYear] = useState(now.year)
  const [season, setSeason] = useState<SeasonIndex>(now.season)
  const [seasonItems, setSeasonItems] = useState<SeasonItem[]>([])
  const [seasonLoading, setSeasonLoading] = useState(false)

  useEffect(() => {
    // 只在真的切到「当季」标签时才拉数据（搜索用户不该为一次季度请求买单）
    if (tab !== 'season') return
    let alive = true
    setSeasonLoading(true)
    void api.bangumi
      .season(year, monthsOfSeason(season)[0])
      .then((r) => {
        if (!alive) return
        setSeasonLoading(false)
        if (!r.ok) {
          toast.error(r.error)
          setSeasonItems([])
          return
        }
        if (r.data.error) toast.warn(`季度数据源异常：${r.data.error.message}（显示的可能是不完整结果）`)
        setSeasonItems(r.data.items)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setSeasonLoading(false)
        setSeasonItems([])
        toast.error(`获取季度番剧失败：${String(err)}`)
      })
    return () => {
      alive = false
    }
  }, [tab, year, season])

  const years = useMemo(() => {
    const out: number[] = []
    for (let y = now.year + YEAR_SPAN_FORWARD; y >= now.year - YEAR_SPAN_BACK; y -= 1) out.push(y)
    return out
  }, [now.year])

  // ---------------- 收藏（v0.3.7 追加需求 2） ----------------
  /*
   * 收藏是**本机已有**的数据（stores/library），不需要联网，所以这个标签页永远可用 ——
   * 用户最常做的其实是「把收藏里那几部做成推荐表」，这条路的点击次数最少。
   * 收藏自带封面大图 / 评分 / 放送日期 / 类型标签，加进来就是一张完整的卡（还省掉 backfill 那次详情请求）。
   */
  const favorites = useLibrary((s) => s.favorites)
  const loadLibrary = useLibrary((s) => s.load)
  const libraryLoaded = useLibrary((s) => s.loaded)
  const [favKeyword, setFavKeyword] = useState('')
  const [pickedFav, setPickedFav] = useState<number[]>([])

  useEffect(() => {
    // 用户可能没进过收藏页；这里按需读一次（load 是幂等的：读内存 + 写 store，不联网）
    if (tab === 'favorites' && !libraryLoaded) void loadLibrary()
  }, [tab, libraryLoaded, loadLibrary])

  const favList = useMemo(() => {
    const k = favKeyword.trim().toLowerCase()
    if (!k) return favorites
    return favorites.filter(
      (f) => f.nameCn.toLowerCase().includes(k) || f.name.toLowerCase().includes(k)
    )
  }, [favorites, favKeyword])

  /** 勾选要批量加入的收藏（已在本表里的不给勾：勾了也会被 store 跳过，不如当场说明） */
  function toggleFav(subjectId: number): void {
    setPickedFav((cur) =>
      cur.includes(subjectId) ? cur.filter((x) => x !== subjectId) : [...cur, subjectId]
    )
  }

  function addPicked(): void {
    const inputs: RecommendPageInput[] = []
    const titles: string[] = []
    // 顺序按**收藏列表里的顺序**（不是勾选顺序）：批量加进来后页序与原收藏一致，用户好核对
    for (const fav of favorites) {
      if (!pickedFav.includes(fav.subjectId)) continue
      if (addedIds.has(fav.subjectId)) continue
      inputs.push(pageInputFromFavorite(fav))
      titles.push(fav.nameCn || fav.name)
    }
    if (inputs.length === 0) {
      toast.warn('勾中的都已经在表里了')
      return
    }
    onAddMany(inputs, titles)
    setPickedFav([])
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 三个入口的切换 */}
      <div className="mb-2 flex rounded-lg border border-border p-0.5">
        {(
          [
            { key: 'search', label: '搜索', icon: <Search size={13} /> },
            { key: 'season', label: '当季', icon: <CalendarDays size={13} /> },
            { key: 'favorites', label: '收藏', icon: <Heart size={13} /> }
          ] as { key: Tab; label: string; icon: React.ReactNode }[]
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors ${
              tab === t.key ? 'bg-accent text-white' : 'text-dim hover:text-text'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'search' ? (
        <>
          <div className="flex gap-2">
            <Input
              value={keyword}
              placeholder="输入番剧名，回车搜索"
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch()
              }}
            />
            <Button variant="soft" icon={Search} loading={searching} onClick={() => void runSearch()}>
              搜索
            </Button>
          </div>
          <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {searching ? (
              <div className="flex justify-center py-10">
                <Spinner size={20} />
              </div>
            ) : searchItems.length === 0 ? (
              <p className="px-1 py-6 text-center text-[11px] leading-relaxed text-faint">
                {searched
                  ? '没有搜到结果，换个关键词（日文原名往往更准）'
                  : '输入番剧名搜索 —— 加进来的作品会成为推荐表里的一页'}
              </p>
            ) : (
              searchItems.map((it) => (
                <ResultRow
                  key={it.id}
                  title={it.name_cn || it.name}
                  sub={it.name_cn && it.name !== it.name_cn ? it.name : ''}
                  cover={it.images?.common ?? ''}
                  rating={it.rating?.score ?? null}
                  airDate={it.air_date}
                  added={addedIds.has(it.id)}
                  onAdd={() => onAdd(pageInputFromSearch(it), it.name_cn || it.name)}
                />
              ))
            )}
          </div>
        </>
      ) : tab === 'season' ? (
        <>
          <div className="flex gap-2">
            <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-[104px]">
              {years.map((y) => (
                <option key={y} value={y}>
                  {y} 年
                </option>
              ))}
            </Select>
            <Select
              value={season}
              onChange={(e) => setSeason(Number(e.target.value) as SeasonIndex)}
              className="flex-1"
            >
              {SEASON_NAMES.map((n, i) => (
                <option key={n} value={i + 1}>
                  {n}季
                </option>
              ))}
            </Select>
          </div>
          <div className="mt-1 px-1 text-[10px] text-faint">{seasonLabel(year, season)}</div>
          <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {seasonLoading ? (
              <div className="flex justify-center py-10">
                <Spinner size={20} />
              </div>
            ) : seasonItems.length === 0 ? (
              <p className="px-1 py-6 text-center text-[11px] leading-relaxed text-faint">
                这个季度没有取到番剧（可能是数据源不可达，换个季度或稍后再试）
              </p>
            ) : (
              seasonItems.map((it) => (
                <ResultRow
                  key={it.id}
                  title={it.name_cn || it.name}
                  sub={it.name_cn && it.name !== it.name_cn ? it.name : it.platform || ''}
                  cover={it.images?.common ?? ''}
                  rating={it.rating?.score ?? null}
                  airDate={it.air_date}
                  added={addedIds.has(it.id)}
                  onAdd={() => onAdd(pageInputFromSeason(it), it.name_cn || it.name)}
                />
              ))
            )}
          </div>
        </>
      ) : (
        /* ---------------- 收藏 ---------------- */
        <>
          <Input
            value={favKeyword}
            placeholder="在收藏里过滤（可选）"
            onChange={(e) => setFavKeyword(e.target.value)}
          />
          <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {!libraryLoaded ? (
              <div className="flex justify-center py-10">
                <Spinner size={20} />
              </div>
            ) : favorites.length === 0 ? (
              <p className="px-1 py-6 text-center text-[11px] leading-relaxed text-faint">
                收藏是空的。先去番剧表 / 详情页把想推荐的番收藏起来，或者用左边「搜索 / 当季」添加。
              </p>
            ) : favList.length === 0 ? (
              <p className="px-1 py-6 text-center text-[11px] leading-relaxed text-faint">
                没有匹配「{favKeyword.trim()}」的收藏
              </p>
            ) : (
              favList.map((fav) => {
                const added = addedIds.has(fav.subjectId)
                return (
                  <ResultRow
                    key={fav.subjectId}
                    title={fav.nameCn || fav.name}
                    sub={fav.nameCn && fav.name !== fav.nameCn ? fav.name : ''}
                    cover={fav.cover}
                    rating={fav.rating}
                    airDate={fav.airDate}
                    added={added}
                    onAdd={() => onAdd(pageInputFromFavorite(fav), fav.nameCn || fav.name)}
                    select={{
                      checked: pickedFav.includes(fav.subjectId),
                      onToggle: () => toggleFav(fav.subjectId)
                    }}
                  />
                )
              })
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[10px] text-faint">
              共 {favorites.length} 部收藏 · 已勾 {pickedFav.length} 部
            </span>
            <Button size="sm" disabled={pickedFav.length === 0} onClick={addPicked}>
              {pickedFav.length === 0 ? '一次加多部' : `添加勾选的 ${pickedFav.length} 部`}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

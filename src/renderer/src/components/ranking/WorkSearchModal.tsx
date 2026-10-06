import { useEffect, useState } from 'react'
import { Check, Gamepad2, Plus, Search, Sparkles, Tv } from 'lucide-react'
import type { SearchResultItem, YmgalCandidate } from '@shared/types'
import { seasonOfDate, seasonShortLabel } from '@shared/season'
import { Badge, Button, Input, Modal, Spinner } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { bangumiWork, manualWork, ymgalWork, type RankingWork } from '@/stores/rankingTable'

/**
 * 「搜索添加作品」弹窗：番剧搜索 / galgame 搜索 / 手动添加三个来源，挑到的作品加进当前作品池。
 *
 * 为什么把三个来源放进同一个弹窗的三个页签：它们对用户来说是同一件事（「我要往池子里加一部作品」），
 * 分成三个入口只会让人先想「我要加的是番剧还是 galgame」——而用户手上往往只有一串名字。
 * 手动添加那一栏是兜底：搜不到的作品（早期番剧、没被月幕收录的同人 galgame）也得能进池子，否则这个工具就废了一半。
 *
 * 弹窗**不自动关闭**：排一张表通常要连着加十几部，每加一部就关一次弹窗是最烦人的交互。
 * 已经加过的条目就地变成「已添加」，用户一眼能看出还剩哪些没加。
 */
export function WorkSearchModal({
  open,
  initialKeyword,
  existingIds,
  onPick,
  onClose
}: {
  open: boolean
  initialKeyword: string
  /** 这张表里已经用掉的作品 id（用来把结果标成「已添加」） */
  existingIds: Set<string>
  onPick: (work: RankingWork) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'bangumi' | 'gal' | 'manual'>('bangumi')
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [bangumi, setBangumi] = useState<SearchResultItem[]>([])
  const [gal, setGal] = useState<YmgalCandidate[]>([])
  const [seasonNote, setSeasonNote] = useState('')
  const [manualName, setManualName] = useState('')
  const [manualCover, setManualCover] = useState('')

  // 从作品池的搜索框进来时直接用那个关键词搜一次（用户已经打过字了，不该再打一遍）
  useEffect(() => {
    if (!open) return
    const kw = initialKeyword.trim()
    if (kw) {
      setKeyword(kw)
      void searchBangumi(kw)
    }
    // 只在弹窗打开的这一刻跑一次（后再改关键词由用户自己点搜索）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function searchBangumi(kw: string): Promise<void> {
    if (!kw) return
    setBusy(true)
    setSeasonNote('')
    const r = await api.bangumi.search(kw)
    setBusy(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    setBangumi(r.data.items)
    if (r.data.items.length === 0) toast.info(`没搜到「${kw}」相关的番剧`)
  }

  /** 当季番剧：不想打字时直接从本季新番里挑（`api.bangumi.season` 按月取整季） */
  async function loadSeason(): Promise<void> {
    const { year, season } = seasonOfDate()
    setBusy(true)
    const r = await api.bangumi.season(year, season * 3)
    setBusy(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    setSeasonNote(seasonShortLabel(r.data.year, r.data.season))
    // 季度条目与搜索结果不是同一个类型，这里就地转成搜索结果需要的字段（都用得上：名字 / 封面 / 评分）
    setBangumi(
      r.data.items.map((it) => ({
        id: it.id,
        name: it.name,
        name_cn: it.name_cn,
        images: it.images,
        rating: it.rating,
        air_date: it.air_date,
        summary: ''
      }))
    )
  }

  async function searchGal(kw: string): Promise<void> {
    if (!kw) return
    setBusy(true)
    const r = await api.gal.searchYmgal(kw)
    setBusy(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    setGal(r.data)
    if (r.data.length === 0) toast.info(`月幕没搜到「${kw}」`)
  }

  const tabs: { key: typeof tab; label: string; icon: typeof Tv }[] = [
    { key: 'bangumi', label: '番剧', icon: Tv },
    { key: 'gal', label: 'galgame', icon: Gamepad2 },
    { key: 'manual', label: '手动添加', icon: Plus }
  ]

  return (
    <Modal open={open} onClose={onClose} title="搜索作品并加入作品池" width={720}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1 rounded-lg bg-elev2 p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                tab === t.key ? 'bg-elev1 text-accent shadow-sm' : 'text-dim hover:text-text'
              }`}
            >
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>

        {tab !== 'manual' ? (
          <div className="flex items-center gap-2">
            <Input
              value={keyword}
              autoFocus
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (tab === 'bangumi') void searchBangumi(keyword.trim())
                  else void searchGal(keyword.trim())
                }
              }}
              placeholder={tab === 'bangumi' ? '输入番剧名搜索 bangumi' : '输入 galgame 名搜索月幕'}
            />
            <Button
              icon={Search}
              loading={busy}
              onClick={() => {
                if (tab === 'bangumi') void searchBangumi(keyword.trim())
                else void searchGal(keyword.trim())
              }}
            >
              搜索
            </Button>
            {tab === 'bangumi' ? (
              <Button variant="outline" icon={Sparkles} onClick={() => void loadSeason()} title="载入本季新番">
                当季
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              placeholder="作品名（必填）—— 搜不到的作品可以这样直接加进池子"
            />
            <div className="flex items-center gap-2">
              <Input
                value={manualCover}
                onChange={(e) => setManualCover(e.target.value)}
                placeholder="封面图片地址（可选，支持本地路径）"
              />
              <Button
                icon={Plus}
                disabled={manualName.trim().length === 0}
                onClick={() => {
                  onPick(manualWork(manualName, manualCover))
                  setManualName('')
                  setManualCover('')
                }}
              >
                添加
              </Button>
            </div>
          </div>
        )}

        <div className="max-h-[46vh] min-h-[200px] overflow-y-auto rounded-lg border border-border">
          {busy ? (
            <div className="flex h-[200px] items-center justify-center">
              <Spinner size={20} />
            </div>
          ) : tab === 'bangumi' ? (
            <>
              {seasonNote ? (
                <div className="border-b border-border px-3 py-1.5 text-[11px] text-faint">
                  {seasonNote} 的当季番剧（按排名给出）
                </div>
              ) : null}
              {bangumi.length === 0 ? (
                <div className="px-3 py-10 text-center text-xs leading-relaxed text-faint">
                  输入关键词搜索番剧，或点「当季」直接挑本季新番
                </div>
              ) : (
                bangumi.map((it) => {
                  const work = bangumiWork({
                    subjectId: it.id,
                    name: it.name,
                    nameCn: it.name_cn,
                    images: it.images,
                    rating: it.rating?.score ?? null
                  })
                  const added = existingIds.has(work.id)
                  return (
                    <SearchRow
                      key={it.id}
                      cover={work.cover}
                      name={it.name_cn || it.name}
                      sub={it.name_cn && it.name !== it.name_cn ? it.name : ''}
                      meta={[
                        it.rating?.score != null ? `bangumi ${it.rating.score.toFixed(1)}` : '',
                        it.air_date ?? ''
                      ]
                        .filter((s) => s.length > 0)
                        .join(' · ')}
                      added={added}
                      onAdd={() => onPick(work)}
                    />
                  )
                })
              )}
            </>
          ) : (
            <>
              {gal.length === 0 ? (
                <div className="px-3 py-10 text-center text-xs leading-relaxed text-faint">
                  输入关键词搜索月幕galgame
                  <br />
                  已经导入到 galgame 库的作品，用底部的「导入 galgame」更省事（会带上你自定义的封面）
                </div>
              ) : (
                gal.map((c) => {
                  const work = ymgalWork(c)
                  return (
                    <SearchRow
                      key={c.id}
                      cover={work.cover}
                      name={c.titlesCn || c.title}
                      sub={c.titlesCn && c.title !== c.titlesCn ? c.title : ''}
                      meta="月幕galgame"
                      added={existingIds.has(work.id)}
                      onAdd={() => onPick(work)}
                    />
                  )
                })
              )}
            </>
          )}
        </div>

        <div className="text-[11px] leading-relaxed text-faint">
          添加进来的作品会进入当前作品池；从池子里把卡片拖到上面的等级里就能参与排名。
          {existingIds.size > 0 ? ` 这张表里已经有 ${existingIds.size} 部作品（重复的会被自动跳过）。` : ''}
        </div>
      </div>
    </Modal>
  )
}

/** 搜索结果的一行：封面 + 名字 + 来源信息 + 添加按钮 */
function SearchRow({
  cover,
  name,
  sub,
  meta,
  added,
  onAdd
}: {
  cover: string
  name: string
  sub: string
  meta: string
  added: boolean
  onAdd: () => void
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <CoverImage src={cover} className="h-[54px] w-[38px] shrink-0 rounded-md" />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-1 text-[13px] font-medium" title={name}>
          {name}
        </div>
        {sub ? (
          <div className="line-clamp-1 text-[11px] text-faint" title={sub}>
            {sub}
          </div>
        ) : null}
        {meta ? <div className="mt-0.5 text-[11px] text-dim">{meta}</div> : null}
      </div>
      {added ? (
        <Badge tone="ok">
          <Check size={11} /> 已添加
        </Badge>
      ) : (
        <Button size="sm" variant="soft" icon={Plus} onClick={onAdd}>
          加入池
        </Button>
      )}
    </div>
  )
}

import { useMemo, useState } from 'react'
import { Ban, Search, Trash2, X } from 'lucide-react'
import { CoverImage } from '@/components/CoverImage'
import { Button, Input } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'
import { useScheduleBlockData } from './scheduleBlockData'

/**
 * 黑名单（/schedule-blacklist，v0.3.9 从「番剧表设置」拆出的独立设置项）。
 *
 * 与「屏蔽表」的分工：屏蔽表管**规则**（标签 / 关键词），黑名单管**具体番剧**（条目 id）。
 * 黑名单优先级最高，命中就一律不出现在番剧表里，同样不影响搜索结果。
 *
 * 数据仍写在同一个 store 键（scheduleBlock）的 `blacklist` 字段上 ——
 * 字段名与存储位置都没变，老用户已加的黑名单原样生效。
 */
export function ScheduleBlacklistPage() {
  const { cfg, toggleBlacklist, rows, listReady, reasonOf, patch } = useScheduleBlockData()
  const [query, setQuery] = useState('')

  /** 过滤后的候选列表：无搜索词时把已加入黑名单的排在前面，方便确认/移除 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = [...rows].sort((a, b) => {
      const ab = reasonOf.get(a.item.id) === '黑名单' ? 0 : 1
      const bb = reasonOf.get(b.item.id) === '黑名单' ? 0 : 1
      if (ab !== bb) return ab - bb
      return a.item.id - b.item.id
    })
    if (!q) return sorted
    return sorted.filter((r) => {
      const names = `${r.item.name_cn || ''} ${r.item.name || ''}`.toLowerCase()
      return names.includes(q) || String(r.item.id).includes(q)
    })
  }, [rows, query, reasonOf])

  return (
    <SubPage
      icon={Ban}
      title="黑名单"
      desc="按具体番剧屏蔽（优先级最高）：命中的番剧一律不出现在番剧表里，不影响搜索结果"
      maxWidth="max-w-2xl"
      actions={
        cfg.blacklist.length > 0 ? (
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => patch({ blacklist: [] })}>
            清空黑名单
          </Button>
        ) : null
      }
    >
      {/* ---------------- 已加入的条目 ---------------- */}
      <Card title={`已加入黑名单（${cfg.blacklist.length} 部）`} desc="条目按 id 记录，番剧表换周也不会掉">
        {cfg.blacklist.length === 0 ? (
          <div className="py-2 text-[11px] text-faint">黑名单为空：从下面「本周番剧表」里点「加入黑名单」即可</div>
        ) : (
          <div className="flex flex-col">
            {cfg.blacklist.map((id) => {
              const row = rows.find((r) => r.item.id === id)
              return (
                <div key={id} className="flex items-center gap-2.5 border-b border-border py-2 last:border-b-0">
                  <CoverImage
                    src={row?.item.images?.common ?? row?.item.images?.large ?? null}
                    alt={row?.item.name_cn || row?.item.name || String(id)}
                    className="h-11 w-8 shrink-0"
                    rounded="rounded-md"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-text">
                      {row ? row.item.name_cn || row.item.name || '未知番剧' : `条目 #${id}（不在本周番剧表）`}
                    </div>
                    <div className="mt-0.5 text-[11px] text-faint">
                      #{id}
                      {row ? ` · ${row.weekday}` : ''}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" icon={Trash2} onClick={() => toggleBlacklist(id)}>
                    移除
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* ---------------- 从本周番剧表点选 ---------------- */}
      <Card title="从本周番剧表添加" desc="点右侧按钮即可加入 / 移出黑名单，改动立即生效">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <Input
              className="pl-7 text-xs"
              placeholder="搜索番剧表中的番剧（标题或 id）"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {query ? (
            <Button size="sm" variant="ghost" icon={X} onClick={() => setQuery('')}>
              清空
            </Button>
          ) : null}
        </div>

        <div className="mt-1.5 text-[11px] text-faint">
          本周番剧表共 {rows.length} 部{query ? `，匹配「${query}」${filtered.length} 部` : ''}
        </div>

        <div className="mt-2 flex max-h-[360px] flex-col overflow-y-auto rounded-lg border border-border">
          {!listReady ? (
            <div className="px-3 py-6 text-center text-[11px] text-faint">正在读取番剧表…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-faint">
              {rows.length === 0 ? '暂时读不到番剧表数据（数据源不可用），稍后再试' : '没有匹配的番剧'}
            </div>
          ) : (
            filtered.map((row) => {
              const inList = cfg.blacklist.includes(row.item.id)
              const reason = reasonOf.get(row.item.id)
              return (
                <div
                  key={row.item.id}
                  className="flex items-center gap-2.5 border-b border-border px-2.5 py-2 last:border-b-0"
                >
                  <CoverImage
                    src={row.item.images?.common ?? row.item.images?.large ?? null}
                    alt={row.item.name_cn || row.item.name}
                    className="h-11 w-8 shrink-0"
                    rounded="rounded-md"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-text">{row.item.name_cn || row.item.name || '未知番剧'}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                      <span>
                        #{row.item.id} · {row.weekday}
                      </span>
                      {reason ? (
                        <span
                          className={`rounded px-1 py-0.5 ${
                            reason === '黑名单' ? 'bg-danger/15 text-danger' : 'bg-warn/15 text-warn'
                          }`}
                        >
                          {reason}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={inList ? 'danger' : 'outline'}
                    icon={inList ? Trash2 : Ban}
                    onClick={() => toggleBlacklist(row.item.id)}
                  >
                    {inList ? '移出黑名单' : '加入黑名单'}
                  </Button>
                </div>
              )
            })
          )}
        </div>
      </Card>

      {/* ---------------- 说明 ---------------- */}
      <Card title="说明" desc="黑名单的性质与边界">
        <div className="text-[11px] leading-relaxed text-faint">
          1. 黑名单按<b>条目 id</b>记录：条目本身不受番剧表换周影响，本周之外的条目会显示为「条目 #id（不在本周番剧表）」。
          <br />
          2. 与「屏蔽表」的区别：屏蔽表按<b>标签 / 关键词</b>批量屏蔽（例如一级标签里的「子供向」），
          黑名单针对的是<b>某一部具体番剧</b>，两者同时生效时黑名单优先。
          <br />
          3. <b>只影响番剧表</b>：搜索结果、收藏、番剧详情、订阅与下载都不受影响。
        </div>
      </Card>
    </SubPage>
  )
}

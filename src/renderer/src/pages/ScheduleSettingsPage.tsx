import { useEffect, useMemo, useRef, useState } from 'react'
import { Ban, ListFilter, RotateCcw, Search, Tags, Trash2, X } from 'lucide-react'
import type { CalendarItem } from '@shared/types'
import {
  BLOCK_LEVELS,
  blockReason,
  DEFAULT_SCHEDULE_BLOCK,
  parseCustomTags,
  shouldLoadTags,
  summarizeBlocked,
  type ScheduleBlockConfig
} from '@shared/scheduleBlock'
import { api } from '@/lib/api'
import { CoverImage } from '@/components/CoverImage'
import { Button, Input, Switch } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'
import { toast } from '@/stores/app'
import { useScheduleBlock, useScheduleTags } from '@/stores/schedule'

/**
 * 番剧表设置（/schedule-settings，用户需求第 4 条）。
 *
 * 只做两件事：
 * 1. **分级标签屏蔽** —— 一级（美国/美漫/英国/子供向，默认开启）、二级（泡面番/里番）、
 *    三级（3D/国产/国漫/玄幻 等 + 优酷/腾讯视频/爱奇艺/芒果TV 平台标签）、四级（自定义标签）；
 * 2. **黑名单** —— 直接从「本周番剧表」的条目里点选，优先级最高。
 *
 * 两个必须写清楚的边界（页面上也有对应文案）：
 * - 这里的所有设置**只作用于番剧表页**：搜索结果、收藏、详情、订阅都不受影响；
 * - 标签屏蔽的判据是**番剧详情的标签**（番剧表自带的 genres 实测恒为空），
 *   所以要逐条补详情；**没取到标签的番剧不会被屏蔽**（宁可不屏蔽，也不能误杀）。
 */

interface PickerRow {
  item: CalendarItem
  /** 该条目在番剧表里的星期（「周一」这种），列表里显示一下便于对上号 */
  weekday: string
}

export function ScheduleSettingsPage() {
  const { cfg, load, save, toggleBlacklist } = useScheduleBlock()
  const { tags, failed, fetching, ensureTags } = useScheduleTags()

  /** 番剧表本周条目（本地读一份，避免在小窗口里改到全局 schedule store 的状态） */
  const [rows, setRows] = useState<PickerRow[]>([])
  const [listReady, setListReady] = useState(false)
  const [query, setQuery] = useState('')
  /** 自定义标签的**原始输入文本**：必须存原文，否则「后宫, 」这种半截输入会被解析结果回写吃掉 */
  const [customText, setCustomText] = useState('')
  const lastWrittenRef = useRef('')

  // 读配置（独立 store 键 scheduleBlock；读不到就用默认值 = 只开一级）
  useEffect(() => {
    void load()
  }, [load])

  // 自定义标签文本框与配置同步（只在「配置被外部改动」时回写，不打断用户输入）
  useEffect(() => {
    const incoming = cfg.customTags.join('\n')
    if (incoming === lastWrittenRef.current) return
    lastWrittenRef.current = incoming
    setCustomText(cfg.customTags.join(', '))
  }, [cfg.customTags])

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
   * 番剧表页与本页共用它，所以「不影响搜索结果」在流量层面也成立。
   */
  const weekIds = useMemo(() => rows.map((r) => r.item.id), [rows])
  useEffect(() => {
    if (!tagRulesOn) return
    if (weekIds.length === 0) return
    ensureTags(weekIds)
  }, [tagRulesOn, weekIds, ensureTags])

  /** 每条目当前的屏蔽原因（黑名单 / 一级：xxx / …；没标签的条目恒为 null = 不屏蔽） */
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

  /** 标签缓存进度：已尝试（成功 + 失败）／本周总条目。失败的条目在界面上要如实说明「不屏蔽」 */
  const tagDone = rows.filter((r) => r.item.id in tags || failed.includes(r.item.id)).length
  const tagFailedInWeek = rows.filter((r) => failed.includes(r.item.id)).length

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    // 无搜索词时把已加入黑名单的排在前面，方便确认/移除
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

  const patch = (p: Partial<ScheduleBlockConfig>): void => save(p)

  const onCustomChange = (value: string): void => {
    setCustomText(value)
    const parsed = parseCustomTags(value)
    // 记下「这次写入对应的解析结果」，避免上面的同步 effect 把用户正在输入的文本改掉
    lastWrittenRef.current = parsed.join('\n')
    save({ customTags: parsed })
  }

  return (
    <SubPage
      icon={ListFilter}
      title="番剧表设置"
      desc="分级标签屏蔽与黑名单。只影响番剧表：搜索结果、收藏、详情页与订阅都不受影响"
      maxWidth="max-w-2xl"
      actions={
        <Button
          size="sm"
          variant="outline"
          icon={RotateCcw}
          onClick={() => {
            lastWrittenRef.current = ''
            save({ ...DEFAULT_SCHEDULE_BLOCK })
            setCustomText('')
            toast.success('已恢复番剧表设置默认值（只开启一级屏蔽）')
          }}
        >
          恢复默认
        </Button>
      }
    >
      {/* ---------------- 分级标签屏蔽 ---------------- */}
      <Card
        title="分级标签屏蔽"
        desc="勾选后，番剧表里命中对应标签的番剧不再显示；标签来自番剧详情，匹配不区分大小写"
      >
        {BLOCK_LEVELS.filter((l) => l.level !== 4).map((level) => {
          const checked = level.level === 1 ? cfg.l1 : level.level === 2 ? cfg.l2 : cfg.l3
          return (
            <div key={level.level} className="border-t border-border py-2.5 first:border-t-0">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-xs text-text">
                    {level.title}
                    {level.level === 1 ? <span className="ml-1.5 text-[11px] text-accent">默认开启</span> : null}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-faint">{level.desc}</div>
                </div>
                <Switch
                  checked={checked}
                  onChange={(v) => patch(level.level === 1 ? { l1: v } : level.level === 2 ? { l2: v } : { l3: v })}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {level.tags.map((tag) => (
                  <span key={tag} className="rounded-md bg-elev2 px-1.5 py-0.5 text-[11px] text-dim">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )
        })}
      </Card>

      {/* ---------------- 四级：自定义标签 ---------------- */}
      <Card
        title="四级：自定义标签屏蔽"
        desc="自己填关键词，逗号或换行分隔，自动去空格且不区分大小写；匹配方式与分级一致 —— 标签名包含关键词即命中（例如填「后宫」会同时命中「逆后宫」）"
      >
        <textarea
          value={customText}
          onChange={(e) => onCustomChange(e.target.value)}
          rows={3}
          placeholder="例如：后宫, 异世界, 转生"
          className="w-full resize-y rounded-lg border border-border bg-elev2 px-3 py-2 text-xs text-text outline-none placeholder:text-faint focus:border-accent"
        />
        <div className="mt-2 text-[11px] leading-relaxed text-faint">
          {cfg.customTags.length > 0
            ? `已生效 ${cfg.customTags.length} 个关键词：${cfg.customTags.join(' / ')}`
            : '未填写自定义关键词'}
        </div>
      </Card>

      {/* ---------------- 黑名单 ---------------- */}
      <Card
        title="黑名单"
        desc="优先级最高：命中的番剧一律不出现在番剧表里（同样不影响搜索结果）。从下面的番剧表条目点选即可加入"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border pb-2.5">
          <div className="flex items-center gap-2 text-xs text-text">
            <Ban size={13} className="text-danger" />
            已加入黑名单（{cfg.blacklist.length} 部）
          </div>
          {cfg.blacklist.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => patch({ blacklist: [] })}>
              清空黑名单
            </Button>
          ) : null}
        </div>

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

        <div className="mt-3 flex items-center gap-2">
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

        <div className="mt-2 flex max-h-[320px] flex-col overflow-y-auto rounded-lg border border-border">
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

      {/* ---------------- 状态与说明 ---------------- */}
      <Card title="当前状态" desc="按当前设置，本周番剧表会被屏蔽多少部">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dim">
          <span className="flex items-center gap-1.5">
            <Tags size={12} className="text-accent" />
            本周共 {rows.length} 部，会被屏蔽 {blockedRows.length} 部
          </span>
          {tagRulesOn ? (
            <span className="text-faint">
              标签缓存 {tagDone}/{rows.length}
              {fetching ? '（补齐中…）' : ''}
            </span>
          ) : (
            <span className="text-faint">标签屏蔽全部关闭：不会请求任何番剧详情</span>
          )}
          {tagRulesOn && tagFailedInWeek > 0 ? (
            <span className="text-warn">· {tagFailedInWeek} 部未取到标签（这些不会被屏蔽）</span>
          ) : null}
        </div>
        {Object.keys(reasonStats).length > 0 ? (
          <div className="mt-2 flex flex-col gap-1">
            {Object.entries(reasonStats)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => (
                <div key={reason} className="flex items-center justify-between text-[11px]">
                  <span className="text-dim">{reason}</span>
                  <span className="tabular-nums text-faint">{count} 部</span>
                </div>
              ))}
          </div>
        ) : null}
      </Card>

      <Card title="说明" desc="屏蔽的生效范围与降级行为">
        <div className="text-[11px] leading-relaxed text-faint">
          1. <b>只影响番剧表</b>：搜索结果、收藏、番剧详情、订阅与下载都不受这里任何设置的影响。
          <br />
          2. 标签来自<b>番剧详情</b>（番剧表接口本身不返回标签），所以应用会按需逐条补全并缓存 7 天；首次开启时
          需要几秒才会陆续生效，期间界面上会显示「标签缓存 x/y」。
          <br />
          3. <b>没取到标签的番剧一律不屏蔽</b>（宁可不屏蔽，也不能误杀）；数据源不可用时最多连续失败 4 次就停止补全。
          <br />
          4. 黑名单按条目 id 记录：条目本身不受番剧表换周影响，本周之外的条目会显示为「条目 #id（不在本周番剧表）」。
        </div>
      </Card>
    </SubPage>
  )
}

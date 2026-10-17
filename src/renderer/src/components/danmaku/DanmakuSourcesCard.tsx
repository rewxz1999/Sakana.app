import { useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Info,
  Pencil,
  Plus,
  Power,
  Trash2,
  X
} from 'lucide-react'
import type { DanmakuAdapterInfo, DanmakuSource, DanmakuSourceKind } from '@shared/types'
import { Button, Input, Select } from '@/components/ui'
import { Card } from '@/components/SettingsShell'
import type { SourceCatalogState } from './useSourceCatalog'

/**
 * 「弹幕数据源」集合器（V1.1 用户要求：可插拔、能增删改启停排序、有真测试按钮）。
 *
 * 界面上的三段：
 *   ① 现有数据源列表（启用开关 + 优先级上下移 + 真测试 + 编辑 + 删除）；
 *   ② 新增/编辑表单（下拉选适配器，字段由适配器自述 `DanmakuAdapterInfo` 决定）；
 *   ③ 真测试结果（逐步骤：查了什么、回了几条、耗时多少 —— 不是假按钮）。
 *
 * 适配器说明文字（每个源"到底能不能用"的实测结论）来自主进程的 `DANMAKU_ADAPTERS`，
 * 这里只负责显示，不硬编码 —— 换了适配器实现界面自动跟着变。
 *
 * `catalog` 由页面统一持有并传进来（不是每个卡片各自 `useSourceCatalog()`）：
 * 三个卡片共用同一份集合器状态，否则会各拉一次、改完还要互相刷新。
 */

const KIND_LABEL: Record<DanmakuSourceKind, string> = {
  api: 'API',
  site: '网站',
  link: '链接'
}

const KIND_TONE: Record<DanmakuSourceKind, string> = {
  api: 'bg-accent-soft text-accent',
  site: 'bg-warn/15 text-warn',
  link: 'bg-ok/15 text-ok'
}

/** 新建数据源时的空白草稿（适配器默认值在选适配器时填进去） */
function blankDraft(adapter: DanmakuAdapterInfo): Omit<DanmakuSource, 'priority' | 'createdAt'> {
  return {
    id: `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: adapter.name,
    kind: adapter.kind,
    adapter: adapter.id,
    enabled: true,
    matchMode: 'title',
    keyword: '',
    base: adapter.defaultBase,
    credential: '',
    urlTemplate: adapter.needTemplate ? 'https://example.com/{title}/{episode2}.xml' : '',
    note: ''
  }
}

export function DanmakuSourcesCard({ catalog }: { catalog: SourceCatalogState }): React.ReactElement {
  const {
    registry,
    loading,
    saving,
    tests,
    reload,
    addSource,
    updateSource,
    removeSource,
    toggleSource,
    moveSource,
    testSource
  } = catalog

  /** 正在编辑的源 id（null = 没在编辑；'__new' = 正在新增） */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Omit<DanmakuSource, 'priority' | 'createdAt'> | null>(null)
  /** 每条的测试关键词（默认留空 = 用源自己的 keyword 或适配器的默认样例） */
  const [testKw, setTestKw] = useState<Record<string, string>>({})
  /** 展开哪一条的测试结果 */
  const [openTest, setOpenTest] = useState<string | null>(null)

  const adapters = registry?.adapters ?? []
  const sources = registry?.sources ?? []

  function startNew(): void {
    const a = adapters[0]
    if (!a) return
    setDraft(blankDraft(a))
    setEditingId('__new')
  }

  function startEdit(s: DanmakuSource): void {
    const { priority: _p, createdAt: _c, ...rest } = s
    setDraft(rest)
    setEditingId(s.id)
  }

  function changeAdapter(id: string): void {
    const a = adapters.find((x) => x.id === id)
    if (!a || !draft) return
    // 换适配器时把默认基址/模板带上，但名字如果用户改过就不动
    setDraft({
      ...draft,
      adapter: a.id,
      kind: a.kind,
      name: draft.name === adapters.find((x) => x.id === draft.adapter)?.name ? a.name : draft.name,
      base: a.defaultBase,
      urlTemplate: a.needTemplate ? draft.urlTemplate || 'https://example.com/{title}/{episode2}.xml' : ''
    })
  }

  async function submitDraft(): Promise<void> {
    if (!draft || !editingId) return
    if (editingId === '__new') {
      const created = await addSource(draft)
      // 新增后立刻拿主进程规范化过的那条去「真测试」，用户一步就知道这条源到底通不通
      if (created) void testSource(created)
    } else {
      await updateSource(editingId, draft)
      void testSource({ ...(sources.find((s) => s.id === editingId) as DanmakuSource), ...draft })
    }
    setEditingId(null)
    setDraft(null)
  }

  return (
    <Card
      title="弹幕获取规则"
      desc="为弹幕获取器添加新的弹幕规则（自建巴哈反代 / 弹幕盒子 / 直链模板）：进播放器时按优先级并行取，结果由集成器合并；内置弹弹play 与本地缓存始终优先"
    >
      {/* ---------- 现有数据源 ---------- */}
      <div className="mb-3 flex items-center gap-2 text-[11px] text-faint">
        <span>
          共 {sources.length} 条，启用 {sources.filter((s) => s.enabled).length} 条
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void reload()} loading={loading}>
          刷新
        </Button>
        <Button size="sm" variant="soft" icon={Plus} onClick={startNew} disabled={adapters.length === 0}>
          新增数据源
        </Button>
      </div>

      {sources.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] leading-relaxed text-faint">
          还没有自定义规则 —— 这不影响使用：上面的「选择启用弹幕源」默认已启用巴哈姆特。
          <br />
          需要自建反代 / 直链 / 老番存档时，点「新增数据源」加一条。
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sources.map((s, i) => {
            const test = tests[s.id]
            const expanded = openTest === s.id
            return (
              <div key={s.id} className="rounded-xl border border-border bg-elev2/40 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  {/* 优先级 */}
                  <span className="w-5 shrink-0 text-center font-mono text-xs font-bold tabular-nums text-accent">
                    {i + 1}
                  </span>
                  <div className="flex shrink-0 flex-col">
                    <button
                      title="上移（提高优先级）"
                      disabled={i === 0 || saving}
                      onClick={() => void moveSource(s.id, -1)}
                      className="text-faint transition-colors hover:text-accent disabled:opacity-30"
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      title="下移（降低优先级）"
                      disabled={i === sources.length - 1 || saving}
                      onClick={() => void moveSource(s.id, 1)}
                      className="text-faint transition-colors hover:text-accent disabled:opacity-30"
                    >
                      <ChevronDown size={13} />
                    </button>
                  </div>

                  {/* 开关 */}
                  <button
                    title={s.enabled ? '已启用（点击停用）' : '已停用（点击启用）'}
                    onClick={() => void toggleSource(s.id, !s.enabled)}
                    className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors ${
                      s.enabled ? 'bg-accent' : 'bg-elev3'
                    }`}
                  >
                    <span
                      className={`h-5 w-5 rounded-full bg-white shadow transition-all ${
                        s.enabled ? 'translate-x-[22px]' : 'translate-x-0'
                      }`}
                    />
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`text-sm font-medium ${s.enabled ? 'text-text' : 'text-faint'}`}>{s.name}</span>
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] whitespace-nowrap ${KIND_TONE[s.kind]}`}>
                        {KIND_LABEL[s.kind]}
                      </span>
                      <span className="rounded bg-elev3 px-1.5 py-0.5 font-mono text-[10px] text-dim">{s.adapter}</span>
                      {s.matchMode === 'keyword' && s.keyword ? (
                        <span className="rounded bg-elev3 px-1.5 py-0.5 text-[10px] text-dim">
                          固定词：{s.keyword}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-faint" title={s.base || s.urlTemplate || ''}>
                      {s.urlTemplate || s.base || '（使用适配器默认基址）'}
                      {s.note ? ` · ${s.note}` : ''}
                    </div>
                  </div>

                  <button
                    title="删除这条数据源"
                    onClick={() => void removeSource(s.id)}
                    className="shrink-0 text-faint transition-colors hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    title="编辑"
                    onClick={() => (editingId === s.id ? (setEditingId(null), setDraft(null)) : startEdit(s))}
                    className="shrink-0 text-faint transition-colors hover:text-accent"
                  >
                    {editingId === s.id ? <X size={14} /> : <Pencil size={14} />}
                  </button>
                </div>

                {/* 测试行 */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Input
                    value={testKw[s.id] ?? ''}
                    onChange={(e) => setTestKw((p) => ({ ...p, [s.id]: e.target.value }))}
                    placeholder={
                      s.keyword
                        ? `测试关键词（留空用「${s.keyword}」）`
                        : '测试关键词（留空用适配器默认样例，如「敗北女角太多了」）'
                    }
                    className="h-7 flex-1 text-[11px]"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    icon={FlaskConical}
                    loading={test === 'running'}
                    onClick={() => {
                      setOpenTest(s.id)
                      void testSource(s, testKw[s.id]?.trim() || undefined)
                    }}
                  >
                    真测试
                  </Button>
                  {test && test !== 'running' ? (
                    <button
                      className="text-[10px] text-faint underline"
                      onClick={() => setOpenTest(expanded ? null : s.id)}
                    >
                      {expanded ? '收起结果' : '看结果'}
                    </button>
                  ) : null}
                </div>

                {/* 测试结果：逐步骤 + 样本 */}
                {test && test !== 'running' && expanded ? (
                  <div className="mt-2 rounded-lg border border-border bg-elev1 p-2.5">
                    <div className={`flex items-center gap-1.5 text-[11px] ${test.ok ? 'text-ok' : 'text-danger'}`}>
                      {test.ok ? '✓' : '✗'} {test.message}
                    </div>
                    {test.steps.length > 0 ? (
                      <ul className="mt-1.5 space-y-0.5">
                        {test.steps.map((st, k) => (
                          <li key={k} className="flex gap-1.5 text-[11px] leading-relaxed">
                            <span className={st.ok ? 'text-ok' : 'text-danger'}>{st.ok ? '✓' : '✗'}</span>
                            <span className="text-dim">
                              {st.name}：{st.detail}
                            </span>
                            <span className="shrink-0 text-faint">{st.ms > 0 ? `${st.ms}ms` : ''}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {test.samples && test.samples.length > 0 ? (
                      <div className="mt-1.5 border-t border-border pt-1.5">
                        <div className="mb-0.5 text-[10px] text-faint">实测样本</div>
                        {test.samples.map((sm, k) => (
                          <div key={k} className="truncate text-[11px] text-dim" title={`${sm.title} ${sm.extra ?? ''}`}>
                            {sm.title}
                            {sm.episode != null ? ` 第${sm.episode}集` : ''}
                            {sm.count != null ? ` · ${sm.count} 条` : ''}
                            {sm.extra ? ` · ${sm.extra}` : ''}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {/* ---------- 新增 / 编辑表单 ---------- */}
      {draft && editingId ? (
        <div className="mt-3 rounded-xl border border-accent/40 bg-elev2/40 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-semibold">{editingId === '__new' ? '新增数据源' : '编辑数据源'}</span>
            <span className="flex-1" />
            <button
              className="text-faint hover:text-danger"
              onClick={() => {
                setEditingId(null)
                setDraft(null)
              }}
            >
              <X size={14} />
            </button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[11px] text-dim">
              适配器
              <Select value={draft.adapter} onChange={(e) => changeAdapter(e.target.value)} className="h-8 text-xs">
                {adapters.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}（{KIND_LABEL[a.kind]}）
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-dim">
              名称
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="h-8 text-xs"
                placeholder="显示名（可自定义）"
              />
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-dim">
              匹配方式
              <Select
                value={draft.matchMode}
                onChange={(e) => setDraft({ ...draft, matchMode: e.target.value === 'keyword' ? 'keyword' : 'title' })}
                className="h-8 text-xs"
              >
                <option value="title">按番剧名 + 别名（默认）</option>
                <option value="keyword">固定关键词（番剧名对不上站点标题时用）</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-dim">
              {draft.matchMode === 'keyword' ? '固定关键词' : '关键词（可留空）'}
              <Input
                value={draft.keyword ?? ''}
                onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
                className="h-8 text-xs"
                placeholder={draft.matchMode === 'keyword' ? '例如 敗北女角太多了' : '留空即用番剧名'}
              />
            </label>

            {draft.adapter === 'link' ? (
              <label className="flex flex-col gap-1 text-[11px] text-dim sm:col-span-2">
                直链模板
                <Input
                  value={draft.urlTemplate ?? ''}
                  onChange={(e) => setDraft({ ...draft, urlTemplate: e.target.value })}
                  className="h-8 font-mono text-xs"
                  placeholder="https://example.com/{title}/{episode2}.xml"
                />
                <span className="text-[10px] leading-relaxed text-faint">
                  占位符：<code className="font-mono">{'{title}'}</code>（URL 编码后的番剧名）、
                  <code className="font-mono">{'{episode}'}</code>、
                  <code className="font-mono">{'{episode2}'}</code>（两位补零）。支持 B 站 XML / 弹弹play JSON / 简单 JSON 数组。
                </span>
              </label>
            ) : (
              <label className="flex flex-col gap-1 text-[11px] text-dim sm:col-span-2">
                基址（可指向自建反代）
                <Input
                  value={draft.base ?? ''}
                  onChange={(e) => setDraft({ ...draft, base: e.target.value })}
                  className="h-8 font-mono text-xs"
                  placeholder={adapters.find((a) => a.id === draft.adapter)?.defaultBase || '（该适配器无需基址）'}
                />
              </label>
            )}

            <label className="flex flex-col gap-1 text-[11px] text-dim sm:col-span-2">
              备注（自己看的）
              <Input
                value={draft.note ?? ''}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                className="h-8 text-xs"
                placeholder="例如：走自建反代，失效了就换回来"
              />
            </label>
          </div>

          {/* 适配器自述：实测结论，别让用户自己猜哪个能用 */}
          {(() => {
            const a = adapters.find((x) => x.id === draft.adapter)
            if (!a) return null
            return (
              <div className="mt-2 flex gap-1.5 rounded-lg bg-elev1 px-2.5 py-2 text-[11px] leading-relaxed text-faint">
                <Info size={12} className="mt-0.5 shrink-0 text-accent" />
                <span>{a.desc}</span>
              </div>
            )
          })()}

          <div className="mt-2.5 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditingId(null)
                setDraft(null)
              }}
            >
              取消
            </Button>
            <Button size="sm" loading={saving} onClick={() => void submitDraft()}>
              {editingId === '__new' ? '添加并测试' : '保存'}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex items-start gap-1.5 border-t border-border pt-2.5 text-[11px] leading-relaxed text-faint">
        <Power size={12} className="mt-0.5 shrink-0" />
        <span>
          只有<b>启用</b>的规则会在播放时参与自动加载，顺序就是上面的优先级。
          播放器会先查<b>本地缓存</b>，缓存没有才发起请求；多个源的结果按「时间 + 正文」去重合并，
          并在播放器状态区显示<b>每个源各多少条、哪些来自缓存</b>。
        </span>
      </div>
    </Card>
  )
}

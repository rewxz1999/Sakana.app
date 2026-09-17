import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CirclePlus, CloudDownload, RotateCcw, Save, Search, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { PlayRule, RuleEpisodesDef, RuleSearchDef } from '@shared/types'
import { DEFAULT_RULES, emptyRule } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { Badge, Button, Input, Modal, Select, Spinner, Switch, Textarea } from '@/components/ui'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-dim">
        {label}
        {hint ? <span className="ml-1 text-faint">({hint})</span> : null}
      </span>
      {children}
    </label>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-elev1 p-4">
      <div className="mb-3 text-sm font-semibold">{title}</div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  )
}

export function RulesPage() {
  const navigate = useNavigate()
  const [rules, setRules] = useState<PlayRule[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<PlayRule | null>(null)
  const [repoOpen, setRepoOpen] = useState(false)
  const [repoItems, setRepoItems] = useState<{ name: string; version: string; author: string; lastUpdate: number }[]>([])
  const [repoLoading, setRepoLoading] = useState(false)
  const [repoFilter, setRepoFilter] = useState('')
  const [repoSelected, setRepoSelected] = useState<Set<string>>(new Set())
  const [repoImporting, setRepoImporting] = useState(false)

  const load = async () => {
    const r = await api.store.get('rules')
    let list: PlayRule[] = r.ok && Array.isArray(r.data) ? (r.data as PlayRule[]) : []
    if (list.length === 0) list = DEFAULT_RULES
    setRules(list)
    setSelectedId((prev) => prev ?? list[0]?.id ?? null)
  }
  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    const rule = rules.find((r) => r.id === selectedId) ?? null
    setDraft(rule ? structuredClone(rule) : null)
  }, [rules, selectedId])

  const persist = async (next: PlayRule[]) => {
    setRules(next)
    await api.store.set('rules', next)
  }

  const save = async () => {
    if (!draft) return
    if (!draft.name.trim()) {
      toast.warn('请填写规则名称')
      return
    }
    if (!draft.baseUrl.trim()) {
      toast.warn('请填写基础地址')
      return
    }
    const exists = rules.some((r) => r.id === draft.id)
    const next = exists ? rules.map((r) => (r.id === draft.id ? draft : r)) : [...rules, draft]
    await persist(next)
    setSelectedId(draft.id)
    toast.success('规则已保存')
  }

  const addNew = () => {
    const rule = emptyRule()
    setRules((prev) => [...prev, rule])
    setSelectedId(rule.id)
  }

  const remove = async (id: string) => {
    const next = rules.filter((r) => r.id !== id)
    await persist(next)
    if (selectedId === id) setSelectedId(next[0]?.id ?? null)
    toast.info('规则已删除')
  }

  const restoreDefaults = async () => {
    const defaults = DEFAULT_RULES.map((d) => ({ ...d, id: `default-${d.name.toLowerCase()}` }))
    const custom = rules.filter((r) => !r.id.startsWith('default-'))
    await persist([...custom, ...defaults])
    toast.success('默认规则已恢复')
  }

  const patch = (fn: (d: PlayRule) => PlayRule) => {
    setDraft((d) => (d ? fn(d) : d))
  }
  const patchSearch = (fn: (s: RuleSearchDef) => RuleSearchDef) => {
    setDraft((d) => (d ? { ...d, search: fn(d.search) } : d))
  }
  const patchEpisodes = (fn: (e: RuleEpisodesDef) => RuleEpisodesDef) => {
    setDraft((d) => (d ? { ...d, episodes: fn(d.episodes) } : d))
  }

  const enabledCount = useMemo(() => rules.filter((r) => r.enabled).length, [rules])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-elev1/70 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          {api.window.isSmallWindow ? null : (
            <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-xs text-dim hover:text-text whitespace-nowrap">
              <ArrowLeft size={14} /> 返回
            </button>
          )}
          <div className="text-sm font-semibold">规则配置</div>
          <div className="text-[11px] text-faint">
            播放规则（Kazumi 风格：XPath / API）· 已启用 {enabledCount} / {rules.length}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            icon={CloudDownload}
            onClick={() => {
              setRepoOpen(true)
              setRepoItems([])
              setRepoSelected(new Set())
              setRepoLoading(true)
              void api.rulesRepo.index().then((r) => {
                setRepoLoading(false)
                if (r.ok) setRepoItems(r.data)
                else toast.error(r.error)
              })
            }}
          >
            从仓库导入
          </Button>
          <Button variant="outline" size="sm" icon={RotateCcw} onClick={() => void restoreDefaults()}>
            恢复默认规则
          </Button>
          <Button size="sm" icon={CirclePlus} onClick={addNew}>
            添加规则
          </Button>
          <Button size="sm" icon={Save} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左侧：规则列表 */}
        <div className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border p-2.5">
          {rules.map((rule) => (
            <div
              key={rule.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedId(rule.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelectedId(rule.id)
                }
              }}
              className={`mb-1.5 flex w-full cursor-pointer flex-col gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                selectedId === rule.id ? 'border-accent bg-accent-soft' : 'border-border bg-elev1 hover:border-accent/50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="line-clamp-1 min-w-0 text-[13px] font-medium">{rule.name || '未命名规则'}</span>
                <button
                  className="text-faint hover:text-danger"
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(rule.id)
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={rule.enabled ? 'ok' : 'neutral'}>{rule.enabled ? '启用' : '停用'}</Badge>
                <Badge>{rule.search.type === 'xpath' ? 'XPath' : 'API'}</Badge>
                <span className="text-[10px] text-faint">v{rule.version}</span>
              </div>
            </div>
          ))}
          {rules.length === 0 ? (
            <div className="py-8 text-center text-xs text-faint">
              暂无规则
              <div className="mt-2">
                <Button size="sm" variant="soft" onClick={addNew}>
                  添加规则
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* 右侧：表单 */}
        <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {draft ? (
            <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
              <div className="flex items-center gap-3">
                <Switch
                  checked={draft.enabled}
                  onChange={(v) => patch((d) => ({ ...d, enabled: v }))}
                />
                <span className="text-xs text-dim">启用该规则</span>
              </div>

              <Section title="基本信息">
                <div className="grid grid-cols-3 gap-2.5">
                  <Field label="规则名称">
                    <Input value={draft.name} onChange={(e) => patch((d) => ({ ...d, name: e.target.value }))} placeholder="AGE" />
                  </Field>
                  <Field label="规则版本">
                    <Input value={draft.version} onChange={(e) => patch((d) => ({ ...d, version: e.target.value }))} placeholder="1.0" />
                  </Field>
                  <Field label="基础地址 (URL)">
                    <Input value={draft.baseUrl} onChange={(e) => patch((d) => ({ ...d, baseUrl: e.target.value }))} placeholder="https://example.com/" />
                  </Field>
                </div>
              </Section>

              <Section title="搜索规则（定义如何在站点内检索条目）">
                <div className="grid grid-cols-4 gap-2.5">
                  <Field label="搜索规则类型">
                    <Select value={draft.search.type} onChange={(e) => patchSearch((s) => ({ ...s, type: e.target.value as 'xpath' | 'api' }))}>
                      <option value="xpath">XPath</option>
                      <option value="api">API</option>
                    </Select>
                  </Field>
                  <Field label="搜索请求方法">
                    <Select value={draft.search.method} onChange={(e) => patchSearch((s) => ({ ...s, method: e.target.value as 'GET' | 'POST' }))}>
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                    </Select>
                  </Field>
                  <Field label="搜索请求类型" hint="POST 体格式">
                    <Select value={draft.search.bodyType} onChange={(e) => patchSearch((s) => ({ ...s, bodyType: e.target.value }))}>
                      <option value="">无</option>
                      <option value="form">表单</option>
                      <option value="json">JSON</option>
                    </Select>
                  </Field>
                </div>
                <Field label="搜索地址 (URL)" hint="@keyword 为关键词占位">
                  <Input value={draft.search.url} onChange={(e) => patchSearch((s) => ({ ...s, url: e.target.value }))} placeholder="https://example.com/search?query=@keyword" />
                </Field>
                {draft.search.type === 'api' ? (
                  <>
                    <div className="grid grid-cols-2 gap-2.5">
                      <Field label="搜索请求头 (JSON)">
                        <Textarea rows={2} className="font-mono text-xs" value={draft.search.headers} onChange={(e) => patchSearch((s) => ({ ...s, headers: e.target.value }))} />
                      </Field>
                      <Field label="搜索参数查询 (JSON)" hint="@keyword 占位">
                        <Textarea rows={2} className="font-mono text-xs" value={draft.search.query} onChange={(e) => patchSearch((s) => ({ ...s, query: e.target.value }))} />
                      </Field>
                    </div>
                    <Field label="搜索结果列表路径 (JSONPath)">
                      <Input value={draft.search.listJsonPath} onChange={(e) => patchSearch((s) => ({ ...s, listJsonPath: e.target.value }))} placeholder="$.data.videos[*]" />
                    </Field>
                    <div className="grid grid-cols-2 gap-2.5">
                      <Field label="条目名称路径 (JSONPath，相对条目)">
                        <Input value={draft.search.itemNameJsonPath} onChange={(e) => patchSearch((s) => ({ ...s, itemNameJsonPath: e.target.value }))} placeholder="$.name" />
                      </Field>
                      <Field label="条目来源路径 (JSONPath，相对条目)">
                        <Input value={draft.search.itemSourceJsonPath} onChange={(e) => patchSearch((s) => ({ ...s, itemSourceJsonPath: e.target.value }))} placeholder="$.id" />
                      </Field>
                    </div>
                  </>
                ) : (
                  <>
                    <Field label="搜索结果列表 (XPath)">
                      <Input value={draft.search.listXPath} onChange={(e) => patchSearch((s) => ({ ...s, listXPath: e.target.value }))} placeholder="//div[2]/div/section/div/div/div/div" />
                    </Field>
                    <div className="grid grid-cols-2 gap-2.5">
                      <Field label="条目名称 (XPath，相对条目)">
                        <Input value={draft.search.itemNameXPath} onChange={(e) => patchSearch((s) => ({ ...s, itemNameXPath: e.target.value }))} placeholder="//div/div[2]/h5/a" />
                      </Field>
                      <Field label="条目链接 (XPath，相对条目)">
                        <Input value={draft.search.itemLinkXPath} onChange={(e) => patchSearch((s) => ({ ...s, itemLinkXPath: e.target.value }))} placeholder="//div/div[2]/h5/a" />
                      </Field>
                    </div>
                  </>
                )}
              </Section>

              <Section title="选集规则（定义如何获取播放线路与剧集列表）">
                <div className="grid grid-cols-4 gap-2.5">
                  <Field label="选集规则类型">
                    <Select value={draft.episodes.type} onChange={(e) => patchEpisodes((x) => ({ ...x, type: e.target.value as 'xpath' | 'api' }))}>
                      <option value="xpath">XPath</option>
                      <option value="api">API</option>
                    </Select>
                  </Field>
                  {draft.episodes.type === 'api' ? (
                    <>
                      <Field label="选集请求方法">
                        <Select value={draft.episodes.method} onChange={(e) => patchEpisodes((x) => ({ ...x, method: e.target.value as 'GET' | 'POST' }))}>
                          <option value="GET">GET</option>
                          <option value="POST">POST</option>
                        </Select>
                      </Field>
                      <Field label="选集请求类型">
                        <Select value={draft.episodes.bodyType} onChange={(e) => patchEpisodes((x) => ({ ...x, bodyType: e.target.value }))}>
                          <option value="">无</option>
                          <option value="form">表单</option>
                          <option value="json">JSON</option>
                        </Select>
                      </Field>
                      <Field label="选集响应格式">
                        <Select value={draft.episodes.responseFormat} onChange={(e) => patchEpisodes((x) => ({ ...x, responseFormat: e.target.value }))}>
                          <option value="">默认</option>
                          <option value="嵌套JSON">嵌套 JSON</option>
                        </Select>
                      </Field>
                    </>
                  ) : null}
                </div>

                {draft.episodes.type === 'xpath' ? (
                  <>
                    <Field label="播放线路列表 (XPath)" hint="留空或 // 表示单线路">
                      <Input value={draft.episodes.linesXPath} onChange={(e) => patchEpisodes((x) => ({ ...x, linesXPath: e.target.value }))} placeholder="//div[2]/div/section/div/div[2]/div[2]/div[2]/div" />
                    </Field>
                    <Field label="剧集列表 (XPath，相对线路)">
                      <Input value={draft.episodes.episodesXPath} onChange={(e) => patchEpisodes((x) => ({ ...x, episodesXPath: e.target.value }))} placeholder="//ul/li/a" />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="选集请求地址 (URL)" hint="@source 为条目来源占位">
                      <Input value={draft.episodes.url} onChange={(e) => patchEpisodes((x) => ({ ...x, url: e.target.value }))} placeholder="https://example.com/api/videos/@source" />
                    </Field>
                    <div className="grid grid-cols-2 gap-2.5">
                      <Field label="选集请求头 (JSON)">
                        <Textarea rows={2} className="font-mono text-xs" value={draft.episodes.headers} onChange={(e) => patchEpisodes((x) => ({ ...x, headers: e.target.value }))} />
                      </Field>
                      <Field label="选集查询参数 (JSON)">
                        <Textarea rows={2} className="font-mono text-xs" value={draft.episodes.query} onChange={(e) => patchEpisodes((x) => ({ ...x, query: e.target.value }))} />
                      </Field>
                    </div>
                    <Field label="播放线路列表路径 (JSONPath)" hint="留空表示单线路">
                      <Input value={draft.episodes.linesJsonPath} onChange={(e) => patchEpisodes((x) => ({ ...x, linesJsonPath: e.target.value }))} placeholder="$.data.playSources[*]" />
                    </Field>
                    <div className="grid grid-cols-2 gap-2.5">
                      <Field label="线路名称路径 (JSONPath，相对线路)">
                        <Input value={draft.episodes.lineNameJsonPath} onChange={(e) => patchEpisodes((x) => ({ ...x, lineNameJsonPath: e.target.value }))} placeholder="$.name" />
                      </Field>
                      <Field label="剧集列表路径 (JSONPath，相对线路)">
                        <Input value={draft.episodes.episodesJsonPath} onChange={(e) => patchEpisodes((x) => ({ ...x, episodesJsonPath: e.target.value }))} placeholder="$.episodes[*]" />
                      </Field>
                    </div>
                    <Field label="剧集名称路径 (JSONPath，相对剧集)">
                      <Input value={draft.episodes.episodeNameJsonPath} onChange={(e) => patchEpisodes((x) => ({ ...x, episodeNameJsonPath: e.target.value }))} placeholder="$.name" />
                    </Field>
                    <Field label="响应变量 (JSON：变量名 → JSONPath)">
                      <Textarea
                        rows={2}
                        className="font-mono text-xs"
                        value={JSON.stringify(draft.episodes.vars, null, 2)}
                        onChange={(e) => {
                          try {
                            patchEpisodes((x) => ({ ...x, vars: JSON.parse(e.target.value || '{}') }))
                          } catch {
                            /* 输入中 */
                          }
                        }}
                        placeholder={'{"slug": "$.data.slug"}'}
                      />
                    </Field>
                    <Field label="播放页地址模板 (URL)" hint="@slug 等响应变量占位">
                      <Input value={draft.episodes.playUrlTemplate} onChange={(e) => patchEpisodes((x) => ({ ...x, playUrlTemplate: e.target.value }))} placeholder="https://example.com/video/@slug/play" />
                    </Field>
                    <Field label="播放页参数查询 (JSON)" hint="@roadIndex 线路序号 / @episodeIndex 剧集序号">
                      <Textarea
                        rows={2}
                        className="font-mono text-xs"
                        value={JSON.stringify(draft.episodes.playQuery, null, 2)}
                        onChange={(e) => {
                          try {
                            patchEpisodes((x) => ({ ...x, playQuery: JSON.parse(e.target.value || '{}') }))
                          } catch {
                            /* 输入中 */
                          }
                        }}
                        placeholder={'{"source": "@roadIndex", "episode": "@episodeIndex"}'}
                      />
                    </Field>
                  </>
                )}
              </Section>

              <div className="flex justify-end gap-2 pb-4">
                <Button icon={Save} onClick={() => void save()}>
                  保存规则
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-faint">
              <span className="text-4xl">📜</span>
              <div className="text-sm">选择或添加一条规则开始编辑</div>
            </div>
          )}
        </div>
      </div>

      {/* 规则仓库导入弹窗（KazumiRules，镜像优先） */}
      <Modal open={repoOpen} onClose={() => setRepoOpen(false)} title="从 Kazumi 规则仓库导入" width={620}>
        <div className="mb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
              placeholder="过滤规则名称…"
              className="h-9 w-full rounded-lg border border-border bg-elev2/60 pl-8 pr-3 text-sm outline-none focus:border-accent"
            />
          </div>
          <span className="text-[11px] text-faint">共 {repoItems.length} 条 · 已选 {repoSelected.size}</span>
        </div>
        {repoLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-dim">
            <Spinner /> 正在获取规则索引（镜像 → 原站）…
          </div>
        ) : (
          <div className="max-h-[44vh] overflow-y-auto pr-1">
            <div className="flex flex-col gap-1.5">
              {repoItems
                .filter((item) => !repoFilter.trim() || item.name.toLowerCase().includes(repoFilter.trim().toLowerCase()))
                .map((item) => (
                  <label
                    key={item.name}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
                      repoSelected.has(item.name) ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent/50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={repoSelected.has(item.name)}
                      onChange={() => {
                        setRepoSelected((prev) => {
                          const next = new Set(prev)
                          if (next.has(item.name)) next.delete(item.name)
                          else next.add(item.name)
                          return next
                        })
                      }}
                      className="accent-[var(--accent)]"
                    />
                    <span className="text-sm font-medium">{item.name}</span>
                    <Badge tone="neutral">v{item.version}</Badge>
                    {item.author ? <span className="text-[11px] text-faint">{item.author}</span> : null}
                    <span className="ml-auto text-[10px] text-faint">
                      {item.lastUpdate ? new Date(item.lastUpdate).toLocaleDateString('zh-CN') : ''}
                    </span>
                  </label>
                ))}
            </div>
            {repoItems.length === 0 && !repoLoading ? (
              <div className="py-8 text-center text-xs text-faint">索引为空（检查网络或代理设置）</div>
            ) : null}
          </div>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setRepoOpen(false)}>
            取消
          </Button>
          <Button
            icon={CloudDownload}
            loading={repoImporting}
            disabled={repoSelected.size === 0}
            onClick={async () => {
              setRepoImporting(true)
              const r = await api.rulesRepo.import([...repoSelected])
              setRepoImporting(false)
              if (r.ok) {
                toast.success(`导入成功 ${r.data.imported} 条${r.data.failed.length ? `，失败 ${r.data.failed.length} 条` : ''}`)
                setRepoOpen(false)
                await load()
              } else {
                toast.error(r.error)
              }
            }}
          >
            导入所选 {repoSelected.size} 条
          </Button>
        </div>
      </Modal>
    </div>
  )
}

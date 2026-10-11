import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Archive,
  CirclePlus,
  CloudDownload,
  Copy,
  Download,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Upload
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { LocalRuleEntry, PlayRule, RuleEpisodesDef, RuleOrigin, RuleSearchDef, RulesRepoMeta } from '@shared/types'
import { DEFAULT_RULES, emptyRule, isPinnedRule, sortRulesPinnedFirst } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { Badge, Button, Input, Modal, Select, Spinner, Switch, Textarea } from '@/components/ui'

/** 上次自动检测时间：当天只显示 HH:mm，跨天补上 MM-DD（主进程记录的是毫秒时间戳） */
function fmtCheckTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay ? hm : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`
}

/** 完整时间（本地库要显示"哪一版是什么时候存的"，只到分钟就够） */
function fmtFullTime(ts: number): string {
  const d = new Date(ts)
  return (
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    fmtCheckTime(ts)
  )
}

/**
 * 规则来源文案（用户要求：「界面要如实显示当前用的是 git 版还是本地版」）。
 *
 * 优先读规则自己带的 `origin`（写入方在导入/替换时就落下来的事实）；
 * 老数据没有这个字段时按 id 前缀兜底 —— 这是历史约定（default- 内置 / repo- 仓库），
 * 不去猜内容，猜错了比不显示更糟。
 */
function ruleOriginOf(rule: PlayRule): RuleOrigin {
  if (rule.origin) return rule.origin
  if (rule.id.startsWith('default-')) return 'builtin'
  if (rule.id.startsWith('repo-')) return 'repo'
  return 'local'
}

function originLabel(origin: RuleOrigin): string {
  if (origin === 'builtin') return '内置版'
  if (origin === 'repo') return 'GIT 仓库版'
  return '本地版'
}

/** 本地库条目的入库原因文案（让人看懂"这条为什么在库里"） */
function reasonLabel(reason: LocalRuleEntry['reason']): string {
  switch (reason) {
    case 'builtin':
      return '内置随应用分发'
    case 'first-seen':
      return '首次见到时留档'
    case 'before-change':
      return '被修改前的版本'
    case 'after-change':
      return '修改后的版本'
    case 'repo-import':
      return '从 GIT 仓库导入/更新'
    case 'auto-fix':
      return '应用改版修正'
    case 'local-replace':
      return '用本地库替换时留档'
    case 'removed':
      return '删除前留档'
    default:
      return String(reason)
  }
}

/**
 * 自动更新状态文案。检测失败只是**网络不可用的常态**（镜像全挂），因此这里只做文字说明，
 * 不弹错误框、也不要求用户处理 —— 与主进程「静默降级」的处理方式保持一致。
 */
function repoAutoUpdateText(meta: RulesRepoMeta | null): string {
  if (!meta?.lastCheckAt) return '上次自动检测：暂无记录'
  const n = meta.updated?.length ?? 0
  const fail = meta.failed?.length ?? 0
  const tail =
    meta.lastResult === 'updated'
      ? `更新 ${n} 条${fail > 0 ? `，失败 ${fail} 条` : ''}`
      : meta.lastResult === 'failed'
        ? `检测失败${fail > 0 ? `（${fail} 条导入失败）` : ''}`
        : '已是最新'
  return `上次自动检测：${fmtCheckTime(meta.lastCheckAt)} · ${tail}`
}

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
  /** 规则仓库自动更新状态（主进程写在 store 的 rulesRepoMeta 里，不新增 IPC 通道） */
  const [repoMeta, setRepoMeta] = useState<RulesRepoMeta | null>(null)
  /** 本地库（v0.3.9）：主进程写在 store 的 rulesLocal 命名空间里，这里只做展示与操作 */
  const [localOpen, setLocalOpen] = useState(false)
  const [localEntries, setLocalEntries] = useState<LocalRuleEntry[]>([])
  const localFileRef = useRef<HTMLInputElement | null>(null)

  /**
   * 读本地库。
   *
   * 为什么不新增 IPC 通道：规则页已经有通用的 `api.store.get/set`，本地库本身就是一个
   * store 命名空间 —— 为了读取它再开一条通道，只会让 preload/api/通道表三处跟着改，
   * 而且这些文件当前有别的 agent 在并行修改（改动面越小越不容易撞车）。
   */
  const loadLocal = async () => {
    try {
      const r = await api.store.get('rulesLocal')
      const list = r.ok && Array.isArray(r.data) ? (r.data as LocalRuleEntry[]) : []
      setLocalEntries([...list].sort((a, b) => b.savedAt - a.savedAt))
    } catch {
      setLocalEntries([])
    }
  }

  /** 把一份本地库快照写回 rules（替换 / 新增），并如实标成本地版 */
  const applyLocalEntry = async (entry: LocalRuleEntry) => {
    const current = rules.find((r) => r.id === entry.ruleId) ?? rules.find((r) => r.name === entry.name)
    let next: PlayRule[]
    if (current) {
      /*
       * 替换时**保留当前规则的身份**（id / 启用状态 / 创建时间）：
       * 用户想要的"换回能跑的那一版"，不该顺带把这条规则变成另一条（那样收藏的线路、
       * 停用状态都会跟着变），只换内容。
       */
      next = rules.map((r) =>
        r.id === current.id
          ? {
              ...entry.rule,
              id: current.id,
              enabled: current.enabled,
              createdAt: current.createdAt,
              origin: 'local' as const
            }
          : r
      )
    } else {
      next = [...rules, { ...entry.rule, id: entry.ruleId, origin: 'local' as const }]
    }
    await persist(next)
    // 重新读一遍本地库：主进程在保存时会把"被替换掉的那一版"也留档，列表要跟着更新
    await loadLocal()
    toast.success(`已用本地库版本替换「${entry.name}」v${entry.version}`)
  }
  const deleteLocalEntry = async (id: string) => {
    const next = localEntries.filter((e) => e.id !== id)
    await api.store.set('rulesLocal', next)
    setLocalEntries(next)
    toast.info('本地库条目已删除')
  }

  /** 导出：Blob 下载（Chromium 会按浏览器自己的下载流程落盘，不需要新通道） */
  const exportLocal = () => {
    const payload = {
      kind: 'sakana-rules-local',
      version: 1,
      exportedAt: Date.now(),
      entries: localEntries
    }
    const text = JSON.stringify(payload, null, 2)
    try {
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `sakana-rules-local-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
      toast.success(`已导出 ${localEntries.length} 条本地库版本`)
    } catch (err) {
      toast.error(`导出失败：${String(err)}`)
    }
  }

  /** 导出到剪贴板：文件下载受系统/权限影响时，这条永远能用（复制出去自己存文件） */
  const copyLocal = async () => {
    const text = JSON.stringify(
      { kind: 'sakana-rules-local', version: 1, exportedAt: Date.now(), entries: localEntries },
      null,
      2
    )
    try {
      await navigator.clipboard.writeText(text)
      toast.success('本地库 JSON 已复制到剪贴板')
    } catch (err) {
      toast.error(`复制失败：${String(err)}`)
    }
  }

  /** 导入：读用户选的 json 文件，按 id 去重后合并（同 id 视为同一条，不重复堆积） */
  const importLocalFile = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as { entries?: LocalRuleEntry[] } | LocalRuleEntry[]
      const incoming = Array.isArray(parsed) ? parsed : (parsed.entries ?? [])
      const valid = incoming.filter((e) => e && e.id && e.rule && e.name)
      if (valid.length === 0) {
        toast.warn('这个文件里没有可用的本地库条目')
        return
      }
      const merged = new Map(localEntries.map((e) => [e.id, e]))
      for (const e of valid) merged.set(e.id, e)
      const next = [...merged.values()].sort((a, b) => b.savedAt - a.savedAt)
      await api.store.set('rulesLocal', next)
      setLocalEntries(next)
      toast.success(`导入完成：文件里 ${valid.length} 条，本地库现共 ${next.length} 条`)
    } catch (err) {
      toast.error(`导入失败：${String(err)}`)
    }
  }

  const loadRepoMeta = async () => {
    try {
      const r = await api.store.get('rulesRepoMeta')
      setRepoMeta(r.ok && r.data && typeof r.data === 'object' ? (r.data as RulesRepoMeta) : null)
    } catch {
      setRepoMeta(null)
    }
  }

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
    void loadRepoMeta()
    // 启动时的自动检测排在启动后 12 秒（见 src/main/index.ts），若用户在这之前就打开了本页，
    // 首次读到的还是"暂无记录" —— 15 秒后再读一次，把这次检测结果显示出来。
    const timer = setTimeout(() => void loadRepoMeta(), 15000)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    void loadLocal()
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
    // 内置内容以 shared 的 DEFAULT_RULES 为准（AGE / sorani / aafun 来自 resources/rules/*.json），
    // 恢复的就是"随应用分发的那三版"，与仓库版本无关
    const defaults = DEFAULT_RULES.map((d) => ({
      ...d,
      id: `default-${d.name.toLowerCase()}`,
      origin: 'builtin' as const
    }))
    const custom = rules.filter((r) => !r.id.startsWith('default-'))
    await persist([...custom, ...defaults])
    toast.success('内置规则已恢复（AGE / sorani / aafun 等）')
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
          <div
            className="whitespace-nowrap text-[11px] text-faint"
            title={[
              ...(repoMeta?.updated?.length ? [`已更新：${repoMeta.updated.join('、')}`] : []),
              ...(repoMeta?.failed?.length ? [`失败：${repoMeta.failed.join('、')}`] : []),
              ...(repoMeta?.remoteTotal ? [`远端仓库共 ${repoMeta.remoteTotal} 条`] : [])
            ].join('\n')}
          >
            {repoAutoUpdateText(repoMeta)}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            icon={Archive}
            data-testid="rules-local-open"
            onClick={() => {
              setLocalOpen(true)
              void loadLocal()
            }}
          >
            本地库 {localEntries.length > 0 ? `(${localEntries.length})` : ''}
          </Button>
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
        {/* 左侧：规则列表（置顶规则（aafun / AGE / sorani…）排在最前，见 shared 的 PINNED_RULES） */}
        <div className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border p-2.5">
          {sortRulesPinnedFirst(rules).map((rule) => (
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
                <span className="line-clamp-1 min-w-0 text-[13px] font-medium">
                  {rule.name || '未命名规则'}
                  {/* 置顶规则标出来：顺序变了但没有任何提示的话，用户会以为是自己记错了 */}
                  {isPinnedRule(rule.name) ? (
                    <span className="ml-1 align-middle text-[10px] text-accent">置顶</span>
                  ) : null}
                </span>
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
                {/*
                  来源徽标（v0.3.9）：用户要求"如实显示当前用的是 git 版还是本地版"。
                  内置版单独用 accent 标出来，因为那三条是随应用分发的、最可靠的一版。
                */}
                <Badge tone={ruleOriginOf(rule) === 'builtin' ? 'ok' : 'neutral'}>
                  {originLabel(ruleOriginOf(rule))}
                </Badge>
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

      {/*
        本地库（v0.3.9，用户要求）。

        用户原话：「规则设置中新增本地库，修改过的规则全部放在本地库中（任何修改都是），
        当从 git 规则库中导入的规则或者从 git 规则库中更新的规则跑不通时，我们还有本地库可以替换使用。」

        这里的每一条都是**真实可用的一版规则快照**（不是只显示名字的列表）：
        点「用这版替换」会把该快照内容写回 rules 并立刻生效（搜索/选集读的就是 rules），
        并且如实把该规则标成"本地版"。
      */}
      <Modal open={localOpen} onClose={() => setLocalOpen(false)} title="规则本地库" width={720}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-dim">
            共 {localEntries.length} 条历史版本 · 规则被修改/被仓库覆盖时都会自动留一份
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" icon={Download} data-testid="rules-local-export" onClick={exportLocal} disabled={localEntries.length === 0}>
              导出
            </Button>
            <Button size="sm" variant="outline" icon={Copy} onClick={() => void copyLocal()} disabled={localEntries.length === 0}>
              复制 JSON
            </Button>
            <Button size="sm" variant="outline" icon={Upload} data-testid="rules-local-import" onClick={() => localFileRef.current?.click()}>
              导入
            </Button>
            {/* 真文件选择：导入读的是用户自己选的 json，不弹任何自造对话框 */}
            <input
              ref={localFileRef}
              type="file"
              accept="application/json,.json"
              data-testid="rules-local-file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void importLocalFile(f)
              }}
            />
          </div>
        </div>

        <div className="max-h-[52vh] overflow-y-auto pr-1">
          {localEntries.length === 0 ? (
            <div className="py-10 text-center text-xs text-faint">
              本地库还是空的
              <div className="mt-1">规则一旦被修改（或从仓库导入/更新），这里就会自动留下可回退的版本</div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {localEntries.map((entry) => {
                const current =
                  rules.find((r) => r.id === entry.ruleId) ?? rules.find((r) => r.name === entry.name)
                const isCurrent = !!current && current.version === entry.version
                return (
                  <div
                    key={entry.id}
                    className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2"
                    data-testid={`rules-local-entry-${entry.name.toLowerCase()}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{entry.name}</span>
                      <Badge tone={entry.origin === 'builtin' ? 'ok' : 'neutral'}>{originLabel(entry.origin)}</Badge>
                      <Badge>{`v${entry.version}`}</Badge>
                      <span className="text-[11px] text-faint">{reasonLabel(entry.reason)}</span>
                      <span className="ml-auto text-[10px] text-faint">{fmtFullTime(entry.savedAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {/* 版本/来源/时间三者对照，用户一眼能看出"当前这版和库里这版差在哪" */}
                      <span className="text-[11px] text-dim">
                        {current
                          ? `当前：${originLabel(ruleOriginOf(current))} v${current.version}${isCurrent ? '（与这条版本号相同）' : ''}`
                          : '当前：规则列表中已不存在这条'}
                      </span>
                      <div className="ml-auto flex gap-2">
                        <Button
                          size="sm"
                          variant="soft"
                          icon={RotateCcw}
                          data-testid={`rules-local-apply-${entry.name.toLowerCase()}`}
                          onClick={() => void applyLocalEntry(entry)}
                        >
                          用这版替换
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={Trash2}
                          onClick={() => void deleteLocalEntry(entry.id)}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={() => setLocalOpen(false)}>
            关闭
          </Button>
        </div>
      </Modal>
    </div>
  )
}

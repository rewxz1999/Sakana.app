import { useState } from 'react'
import { AlertTriangle, Check, Copy, FileCode2, Info, Languages } from 'lucide-react'
import type { ToolImportItem, ToolImportReport, ToolMeta } from '@shared/types'
import {
  TOOL_DOC_FIELDS,
  TOOL_DOC_PITFALLS,
  TOOL_DOC_SAMPLES,
  TOOL_DOC_SECTIONS,
  TOOL_PY_TEMPLATE
} from '@shared/toolDocs'
import { Badge, Button, Modal } from '@/components/ui'
import { toast } from '@/stores/app'

/**
 * 工具页的三个弹窗（v0.3.9）：导入说明 / 导入结果 / 工具详情。
 *
 * 为什么单独一个文件：ToolsPage.tsx 是共享入口（其它 agent 也在改），
 * 新功能整体放这里，页面只加"引入 + 三处渲染"的最小片段。
 *
 * 用户要求的两条在这里落地：
 * - 「工具要求文档够清晰就行」→ `ToolImportDocsModal`：字段表 + 3 个示例 + 常见错误，
 *   写在**界面里**（不是只躺在代码注释里），每个示例都能一键复制；
 * - 「放宽松导入工具需要的语言」→ `ToolImportReportModal` 把"吃进去了什么、哪一项降级了"
 *   逐条摊开给用户看（含行号与"该怎么写"）。
 */

/* ------------------------------------------------------------------ *
 * 复制按钮：navigator.clipboard 在 Electron 渲染层需要安全上下文，
 * 失败时退回 textarea + execCommand（离屏窗口/权限被拒时唯一可用的路）。
 * ------------------------------------------------------------------ */
function CopyButton({ text, label = '复制', size = 'sm' }: { text: string; label?: string; size?: 'sm' | 'md' }) {
  const [done, setDone] = useState(false)

  async function copy(): Promise<void> {
    let ok = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        ok = true
      }
    } catch {
      ok = false
    }
    if (!ok) {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch {
        ok = false
      }
    }
    if (ok) {
      setDone(true)
      toast.success('已复制')
      window.setTimeout(() => setDone(false), 1500)
    } else {
      toast.error('复制失败，请手动选中文本复制')
    }
  }

  return (
    <Button size={size} variant="outline" icon={done ? Check : Copy} onClick={() => void copy()}>
      {done ? '已复制' : label}
    </Button>
  )
}

/** 极简 markdown 渲染：只处理 **粗体**、`行内代码`、换行、`- ` 列表。
 *  为什么不引 markdown 库：文档是我们自己写的，需求只有"看得清"，多一个依赖不划算。 */
function InlineMd({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        const isLi = /^\s*[-*]\s+/.test(line)
        const body = isLi ? line.replace(/^\s*[-*]\s+/, '') : line
        const parts = body.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((p) => p !== '')
        const rendered = parts.map((p, j) => {
          if (p.startsWith('**') && p.endsWith('**')) {
            return (
              <strong key={j} className="font-semibold text-text">
                {p.slice(2, -2)}
              </strong>
            )
          }
          if (p.startsWith('`') && p.endsWith('`')) {
            return (
              <code key={j} className="selectable rounded bg-elev2 px-1 py-0.5 font-mono text-[11px] text-accent">
                {p.slice(1, -1)}
              </code>
            )
          }
          return <span key={j}>{p}</span>
        })
        if (!line.trim()) return <div key={i} className="h-1.5" />
        return (
          <div key={i} className={isLi ? 'flex gap-1.5 pl-1' : ''}>
            {isLi ? <span className="text-faint">·</span> : null}
            <span className="min-w-0 flex-1">{rendered}</span>
          </div>
        )
      })}
    </>
  )
}

/** 代码块 + 一键复制 */
function CodeBlock({ code, lang, title, note }: { code: string; lang: string; title?: string; note?: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-elev1">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <FileCode2 size={12} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-dim">{title ?? lang}</span>
        <CopyButton text={code} />
      </div>
      {note ? <div className="px-3 pt-2 text-[10px] leading-relaxed text-faint">{note}</div> : null}
      <pre className="selectable max-h-64 overflow-auto p-3 font-mono text-[11px] leading-relaxed whitespace-pre">{code}</pre>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 一、导入说明（界面内的文档）
 * ------------------------------------------------------------------ */

export function ToolImportDocsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // 中英对照开关：用户提到"语言"，所以给一个"只看中文"的开关，默认双语
  const [bilingual, setBilingual] = useState(true)

  return (
    <Modal open={open} onClose={onClose} title="导入工具 · 说明" width={880}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent-soft px-3 py-2.5">
          <Info size={14} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-dim">
            <strong className="text-text">元数据全部可选</strong>
            ：少写字段、写成中文、用全角冒号、编码不是 UTF-8、行尾 CRLF、甚至没有 docstring ——
            都能导入，只会在「导入结果」里给你一条可优化的提示。
            <span className="text-faint">
              {' '}
              All metadata is optional; missing fields degrade with explicit hints instead of failing.
            </span>
          </span>
          <button
            type="button"
            onClick={() => setBilingual((v) => !v)}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] transition-colors ${
              bilingual ? 'bg-accent text-white' : 'bg-elev2 text-dim hover:text-text'
            }`}
          >
            <Languages size={12} /> {bilingual ? '中英对照' : '仅中文'}
          </button>
        </div>

        {TOOL_DOC_SECTIONS.map((sec) => (
          <section key={sec.id}>
            <h3 className="mb-1.5 flex flex-wrap items-baseline gap-2 text-sm font-semibold">
              {sec.title}
              {bilingual ? <span className="text-[11px] font-normal text-faint">{sec.titleEn}</span> : null}
            </h3>
            <div className="space-y-0.5 text-xs leading-relaxed text-dim">
              <InlineMd text={sec.body} />
            </div>

            {/* 字段表：只在"字段表"这一节下面插表格 */}
            {sec.id === 'fields' ? (
              <div className="mt-2 overflow-x-auto rounded-xl border border-border">
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead className="bg-elev2 text-faint">
                    <tr>
                      <th className="px-2.5 py-1.5 font-medium">字段 / Field</th>
                      <th className="px-2.5 py-1.5 font-medium">认得的别名 / Aliases</th>
                      <th className="px-2.5 py-1.5 font-medium">缺了会怎样 / Fallback</th>
                    </tr>
                  </thead>
                  <tbody>
                    {TOOL_DOC_FIELDS.map((f) => (
                      <tr key={f.key} className="border-t border-border align-top">
                        <td className="px-2.5 py-1.5 whitespace-nowrap">
                          <div className="font-medium text-text">{f.label}</div>
                          <div className="text-[10px] text-faint">{f.labelEn}</div>
                        </td>
                        <td className="px-2.5 py-1.5">
                          <span className="flex flex-wrap gap-1">
                            {f.aliases.map((a) => (
                              <code key={a} className="rounded bg-elev2 px-1 py-0.5 font-mono text-[10px] text-dim">
                                {a}
                              </code>
                            ))}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 text-dim">
                          {f.fallback}
                          {bilingual ? <div className="text-[10px] text-faint">{f.fallbackEn}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {/* 应用数据 JSON：只在"怎么读取应用数据"那一节下面插 */}
            {sec.id === 'data' ? (
              <div className="mt-2">
                <CodeBlock code={TOOL_DATA_SNIPPET} lang="json" title="应用数据 JSON（节选 / excerpt）" />
              </div>
            ) : null}

            {/* 示例：三个都能一键复制 */}
            {sec.id === 'samples' ? (
              <div className="mt-2 space-y-2">
                {TOOL_DOC_SAMPLES.map((s) => (
                  <CodeBlock
                    key={s.id}
                    code={s.content}
                    lang={s.lang}
                    title={`${s.title} · ${s.titleEn}`}
                    note={bilingual ? `${s.note} ${s.noteEn}` : s.note}
                  />
                ))}
              </div>
            ) : null}

            {/* 常见错误：现象 → 原因 → 正确写法 */}
            {sec.id === 'pitfalls' ? (
              <div className="mt-2 space-y-2">
                {TOOL_DOC_PITFALLS.map((p) => (
                  <div key={p.id} className="rounded-xl border border-border bg-elev1/60 p-2.5">
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <AlertTriangle size={12} className="shrink-0 text-warn" />
                      <span className="font-medium text-text">{p.symptom}</span>
                      {bilingual ? <span className="text-[10px] text-faint">{p.symptomEn}</span> : null}
                    </div>
                    <div className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-dim">
                      <div>
                        <span className="text-faint">原因：</span>
                        {p.cause}
                        {bilingual ? <span className="text-faint"> · {p.causeEn}</span> : null}
                      </div>
                      <div>
                        <span className="text-ok">正确写法：</span>
                        {p.fix}
                        {bilingual ? <span className="text-faint"> · {p.fixEn}</span> : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ))}

        <section>
          <h3 className="mb-1.5 flex flex-wrap items-baseline gap-2 text-sm font-semibold">
            附录：Python 模板（复制即用）
            {bilingual ? <span className="text-[11px] font-normal text-faint">Appendix: template</span> : null}
          </h3>
          <CodeBlock
            code={TOOL_PY_TEMPLATE}
            lang="python"
            title="tool_template.py"
            note={bilingual ? '含两种取数方式（参数 / 环境变量）与元数据写法。 Save as .py and import directly.' : undefined}
          />
        </section>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <CopyButton text={TOOL_PY_TEMPLATE} label="复制 Python 模板" size="md" />
          <Button onClick={onClose}>知道了</Button>
        </div>
      </div>
    </Modal>
  )
}

/** 数据 JSON 节选：从 toolDocs 的完整样例里取前若干行，避免弹窗里贴 60 行 */
const TOOL_DATA_SNIPPET = `{
  "exportedAt": 1756450000000,
  "favorites": [
    { "subjectId": 123456, "nameCn": "中文名", "rating": 8.1,
      "airDate": "2024-01-07", "genres": ["恋爱", "日常"] }
  ],
  "subscriptions": [
    { "id": "uuid", "nameCn": "中文名", "group": "字幕组",
      "episode": 3, "status": "complete" }
  ],
  "watchHistory": [
    { "id": "uuid", "title": "番剧名", "episode": 3,
      "source": "local", "durationSec": 1420 }
  ],
  "stats": { "favoriteCount": 12, "watchedEpisodeCount": 300 }
}`

/* ------------------------------------------------------------------ *
 * 二、导入结果（"成功 N 份 / 其中 M 份带警告"，逐条摊开）
 * ------------------------------------------------------------------ */

function statusBadge(item: ToolImportItem): React.ReactElement {
  if (item.status === 'failed') return <Badge tone="danger">导入失败</Badge>
  if (item.status === 'updated') return <Badge tone="warn">已覆盖旧记录</Badge>
  return <Badge tone="ok">已导入</Badge>
}

export function ToolImportReportModal({
  report,
  onClose,
  onOpenDocs
}: {
  report: ToolImportReport | null
  onClose: () => void
  onOpenDocs: () => void
}) {
  if (!report) return null
  const warned = report.items.filter((i) => i.warnCount > 0).length
  return (
    <Modal open onClose={onClose} title="导入结果" width={720}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={report.failed > 0 ? 'warn' : 'ok'}>成功导入 {report.imported} 份</Badge>
          {warned > 0 ? <Badge tone="warn">其中 {warned} 份带提示</Badge> : null}
          {report.failed > 0 ? <Badge tone="danger">{report.failed} 份失败</Badge> : null}
          <span className="text-faint">共 {report.items.length} 份</span>
        </div>

        <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
          {report.items.map((item) => (
            <div key={item.path} className="rounded-xl border border-border bg-elev1/60 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <FileCode2 size={13} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium" title={item.path}>
                  {item.fileName}
                </span>
                {statusBadge(item)}
              </div>

              {item.tool ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
                  <span>
                    名称：<span className="text-text">{item.tool.name}</span>
                  </span>
                  <span>版本：{item.tool.version ?? '未识别'}</span>
                  <span>种类：{item.tool.kindLabel ?? '未知'}</span>
                  {item.tool.runnable === false ? <Badge tone="warn">不能直接运行</Badge> : null}
                  {item.tool.description ? null : <span className="text-faint">（无描述）</span>}
                </div>
              ) : null}
              {item.tool?.description ? (
                <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-faint">{item.tool.description}</div>
              ) : null}

              {item.error ? (
                <div className="mt-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-danger">
                  {item.error}
                </div>
              ) : null}

              {item.notes.length > 0 ? (
                <ul className="mt-1.5 space-y-1">
                  {item.notes.map((n, i) => (
                    <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed">
                      {n.level === 'warn' ? (
                        <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />
                      ) : (
                        <Info size={12} className="mt-0.5 shrink-0 text-faint" />
                      )}
                      <span className={n.level === 'warn' ? 'text-dim' : 'text-faint'}>
                        {n.line ? <span className="text-warn">第 {n.line} 行 · </span> : null}
                        {n.message}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <span className="text-[10px] leading-relaxed text-faint">
            提示里已经写明"哪一行、哪个字段、该怎么补"。按提示改完脚本后重新「添加工具」即可覆盖旧记录（id 不变）。
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onOpenDocs}>
              查看导入说明
            </Button>
            <Button onClick={onClose}>关闭</Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ *
 * 三、工具详情（解析出来的信息：从哪读到版本、是什么语言、能不能跑）
 * ------------------------------------------------------------------ */

export function ToolDetailModal({ tool, onClose }: { tool: ToolMeta | null; onClose: () => void }) {
  if (!tool) return null
  const samples = TOOL_DOC_SAMPLES
  return (
    <Modal open onClose={onClose} title={`工具信息 · ${tool.name}`} width={660}>
      <div className="space-y-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{tool.kindLabel ?? '未识别种类'}</Badge>
          {tool.runnable === false ? (
            <Badge tone="warn">不能直接运行（只有 Python 有运行时）</Badge>
          ) : (
            <Badge tone="ok">可运行</Badge>
          )}
          {tool.version ? <Badge tone="neutral">v{tool.version}</Badge> : <Badge tone="warn">无版本号</Badge>}
        </div>

        <dl className="grid grid-cols-[92px_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-faint">脚本路径</dt>
          <dd className="break-all text-dim">{tool.scriptPath}</dd>

          <dt className="text-faint">说明</dt>
          <dd className="whitespace-pre-wrap break-words text-dim">{tool.description || '（无描述）'}</dd>

          {tool.author ? (
            <>
              <dt className="text-faint">作者</dt>
              <dd className="text-dim">{tool.author}</dd>
            </>
          ) : null}

          <dt className="text-faint">版本来源</dt>
          <dd className="text-dim">
            {tool.versionLine ? `第 ${tool.versionLine} 行` : '未找到 —— 可写 __version__ / # version: x.y / 版本：x.y'}
          </dd>

          <dt className="text-faint">docstring</dt>
          <dd className="text-dim">
            {tool.docstringLine ? `第 ${tool.docstringLine} 行` : '未找到 —— 建议首行写 """一句话说明"""'}
          </dd>

          <dt className="text-faint">封面</dt>
          <dd className="break-all text-dim">{tool.cover ?? tool.coverHint ?? '无（可放同名图片或写 封面: xxx.png）'}</dd>
        </dl>

        {tool.notes && tool.notes.length > 0 ? (
          <div>
            <div className="mb-1 text-[11px] font-semibold text-dim">导入时的提示</div>
            <ul className="space-y-1">
              {tool.notes.map((n, i) => (
                <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed">
                  {n.level === 'warn' ? (
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />
                  ) : (
                    <Info size={12} className="mt-0.5 shrink-0 text-faint" />
                  )}
                  <span className={n.level === 'warn' ? 'text-dim' : 'text-faint'}>{n.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="rounded-xl border border-border bg-elev1/60 p-2.5 text-[11px] leading-relaxed text-faint">
          想补全上面的"未找到"？改写脚本后重新导入即可（同路径会覆盖，工具卡片 id 不变）。
          示例可复制：
          <div className="mt-1.5 flex flex-wrap gap-2">
            {samples.map((s) => (
              <CopyButton key={s.id} text={s.content} label={`复制${s.title.replace('示例 ', '示例')}`} />
            ))}
          </div>
        </div>

        <div className="flex justify-end border-t border-border pt-3">
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </Modal>
  )
}

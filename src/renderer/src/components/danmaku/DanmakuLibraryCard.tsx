import { useMemo, useState } from 'react'
import { FolderOpen, HardDrive, RefreshCw, Trash2 } from 'lucide-react'
import type { DanmakuLibraryInfo, DanmakuLibraryItem } from '@shared/types'
import { api } from '@/lib/api'
import type { SourceCatalogState } from './useSourceCatalog'
import { Button, ConfirmModal, Input, Select } from '@/components/ui'
import { Card } from '@/components/SettingsShell'
import { toast } from '@/stores/app'

/**
 * 本地弹幕库管理（V1.1 用户要求：列表、按番剧/来源筛选、体积、删除、清空、打开目录）。
 *
 * 与「下载」的关系：从弹幕盒子/巴哈姆特下载回来的弹幕都落到这里（每个「番剧+集+来源」一个
 * B 站 XML 文件），进播放器时**优先命中本地库**（不发任何请求），所以这里既是"资产管理"
 * 也是"离线可用的保证"。
 *
 * 为什么筛选在渲染层做：库条目通常几十到几百条，一次性拿回来做本地过滤比每敲一个字发一次 IPC 更跟手。
 * 主进程仍然提供 `library(filter)`（带 filter 参数），留给将来条目数上万的情况。
 */

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

const FORMAT_LABEL: Record<DanmakuLibraryItem['format'], string> = {
  'bili-xml': 'B站 XML',
  'ddp-json': '弹弹play JSON',
  'simple-json': '简单 JSON'
}

/**
 * 旧版外部弹幕源（V1.5.4 起不再使用）的缓存文件不展示。
 *
 * 数据源已经只剩 danmu_api，但本地库里还留着以前从巴哈/弹幕盒子/E站下回来的 XML。
 * 它们不会再被读取，列出来只会让用户以为"旧源还在"；这里直接隐藏（文件不动，
 * 需要的话仍可从缓存目录手动清理）。
 */
const LEGACY_SOURCE_IDS = new Set(['bahamut', 'danmubox', 'tucao', 'ezdmw', 'link'])
const LEGACY_SOURCE_RE = /巴哈|彈幕盒子|弹幕盒子|E站|ezdmw|Tucao|直链|动画疯/i

function isLegacySource(it: DanmakuLibraryItem): boolean {
  return LEGACY_SOURCE_IDS.has(String(it.sourceId ?? '')) || LEGACY_SOURCE_RE.test(String(it.sourceName ?? ''))
}

export function DanmakuLibraryCard({ catalog }: { catalog: SourceCatalogState }): React.ReactElement {
  const { registry, reload } = catalog
  const lib: DanmakuLibraryInfo | undefined = registry?.library

  const [titleFilter, setTitleFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  /** V1.2：用户要求「选择本地弹幕删除」——支持多选后一次删掉 */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmSelected, setConfirmSelected] = useState(false)
  const [busy, setBusy] = useState(false)

  const allItems = lib?.items ?? []
  const items = useMemo(() => allItems.filter((it) => !isLegacySource(it)), [allItems])

  /** 来源下拉的可选值（从现有条目里去重，避免硬编码源列表） */
  const sources = useMemo(() => {
    const m = new Map<string, string>()
    for (const it of items) m.set(it.sourceId, it.sourceName)
    return [...m.entries()]
  }, [items])

  const filtered = useMemo(() => {
    const t = titleFilter.trim().toLowerCase()
    return items.filter((it) => {
      if (t && !it.title.toLowerCase().includes(t)) return false
      if (sourceFilter && it.sourceId !== sourceFilter) return false
      return true
    })
  }, [items, titleFilter, sourceFilter])

  const filteredBytes = filtered.reduce((m, it) => m + (Number(it.bytes) || 0), 0)

  async function refresh(): Promise<void> {
    setBusy(true)
    await reload()
    setBusy(false)
  }

  async function removeOne(it: DanmakuLibraryItem): Promise<void> {
    setBusy(true)
    const r = await api.danmaku.libraryRemove([it.id])
    setBusy(false)
    if (!r.ok) {
      toast.error(`删除失败：${r.error}`)
      return
    }
    await reload()
    toast.success(`已删除「${it.title} 第${it.episode}集」`)
  }

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 多选删除：只提交当前勾选、且仍在列表里的 id（筛选后隐藏的不会被误删） */
  async function removeSelected(): Promise<void> {
    const ids = [...selected].filter((id) => items.some((it) => it.id === id))
    if (ids.length === 0) return
    setBusy(true)
    const r = await api.danmaku.libraryRemove(ids)
    setBusy(false)
    setConfirmSelected(false)
    setSelected(new Set())
    if (!r.ok) {
      toast.error(`删除失败：${r.error}`)
      return
    }
    await reload()
    toast.success(`已删除所选 ${ids.length} 个弹幕文件`)
  }

  async function pickDir(): Promise<void> {
    const r = await api.dialog.pickDir(lib?.dir)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (!r.data) return // 用户取消
    setBusy(true)
    const s = await api.danmaku.librarySetDir(r.data)
    setBusy(false)
    if (!s.ok) {
      toast.error(`设置目录失败：${s.error}`)
      return
    }
    await reload()
    // 换目录后旧目录里的文件不会跟着走，这里如实说明，不假装"迁移完成"
    toast.success(`弹幕库目录已改为 ${s.data.dir}（原目录里的文件不会自动搬迁）`)
  }

  return (
    <Card
      title="本地弹幕缓存"
      desc="按 <缓存根>/弹幕/<番剧名>/第01集-<源名>.xml 存放（文件名带来源名，不同源互不覆盖）。进播放器时优先命中，不发任何请求；可在这里查看/多选删除/改缓存文件夹"
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-2 text-[11px] text-faint">
        <HardDrive size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={lib?.dir ?? ''}>
          {lib?.dir ?? '（读取中…）'}
        </span>
        <span className="whitespace-nowrap">
          共 {items.length} 个文件 · {fmtBytes(lib?.bytes ?? 0)}
        </span>
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" icon={FolderOpen} onClick={() => void api.danmaku.libraryOpenDir()}>
          打开目录
        </Button>
        <Button size="sm" variant="outline" onClick={() => void pickDir()} loading={busy}>
          改目录
        </Button>
        {lib?.dir ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const r = await api.danmaku.librarySetDir('')
              if (!r.ok) {
                toast.error(r.error)
                return
              }
              await reload()
              toast.success('已恢复默认弹幕库目录')
            }}
          >
            恢复默认目录
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void refresh()} loading={busy}>
          刷新
        </Button>
        <Button
          size="sm"
          variant="outline"
          icon={Trash2}
          disabled={selected.size === 0 || busy}
          onClick={() => setConfirmSelected(true)}
        >
          删除所选{selected.size > 0 ? `（${selected.size}）` : ''}
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon={Trash2}
          disabled={items.length === 0}
          onClick={() => setClearOpen(true)}
        >
          清空
        </Button>
      </div>

      {/* 筛选：按番剧名 + 按来源 */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        <Input
          value={titleFilter}
          onChange={(e) => setTitleFilter(e.target.value)}
          placeholder="按番剧名筛选…"
          className="h-8 min-w-[150px] flex-1 text-xs"
        />
        <Select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="h-8 text-xs">
          <option value="">全部来源</option>
          {sources.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
        {titleFilter || sourceFilter ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setTitleFilter('')
              setSourceFilter('')
            }}
          >
            清除筛选
          </Button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] leading-relaxed text-faint">
          本地缓存还是空的。
          <br />
          进播放器播放一次就会按源自动缓存（文件名带来源名）；也可以自己把 B 站 XML 丢进上面那个目录，
          文件名按「第NN集-来源名.xml」，点「刷新」会重建索引。
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-faint">
          没有符合筛选条件的条目（当前筛选出 0 / {items.length} 条）
        </div>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-elev2 text-faint">
              <tr>
                <th className="w-6 px-2 py-1 font-medium">
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-accent"
                    checked={filtered.length > 0 && filtered.every((it) => selected.has(it.id))}
                    onChange={(e) => {
                      setSelected((prev) => {
                        const next = new Set(prev)
                        for (const it of filtered) {
                          if (e.target.checked) next.add(it.id)
                          else next.delete(it.id)
                        }
                        return next
                      })
                    }}
                    title="全选当前筛选结果"
                  />
                </th>
                <th className="px-2 py-1 font-medium">番剧</th>
                <th className="px-2 py-1 font-medium whitespace-nowrap">集</th>
                <th className="px-2 py-1 font-medium whitespace-nowrap">来源</th>
                <th className="px-2 py-1 font-medium whitespace-nowrap">条数</th>
                <th className="px-2 py-1 font-medium whitespace-nowrap">体积</th>
                <th className="px-2 py-1 font-medium whitespace-nowrap">格式</th>
                <th className="px-2 py-1 font-medium whitespace-nowrap" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => (
                <tr key={it.id} className="border-t border-border">
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-accent"
                      checked={selected.has(it.id)}
                      onChange={() => toggleSelect(it.id)}
                      title="选中后可批量删除"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="max-w-[200px] truncate text-text" title={`${it.origin} · ${it.file}`}>
                      {it.title}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap tabular-nums text-dim">
                    {it.episode > 0 ? `第 ${it.episode} 集` : '合集'}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-dim">{it.sourceName}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap tabular-nums text-dim">
                    {it.count > 0 ? it.count : '—'}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap tabular-nums text-dim">{fmtBytes(it.bytes)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-faint">{FORMAT_LABEL[it.format] ?? it.format}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <button
                      title="删除这个文件"
                      onClick={() => void removeOne(it)}
                      className="text-faint transition-colors hover:text-danger"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-1.5 text-[10px] text-faint">
            当前筛选：{filtered.length} 个文件 · {fmtBytes(filteredBytes)}
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmSelected}
        title="删除所选的本地弹幕"
        message={
          <>
            确定删除选中的 {selected.size} 个弹幕文件？
            <br />
            只删缓存文件，不影响收藏、播放进度；下次播放会重新从源获取。此操作不可撤销。
          </>
        }
        confirmText="删除所选"
        danger
        onConfirm={() => void removeSelected()}
        onClose={() => setConfirmSelected(false)}
      />

      <ConfirmModal
        open={clearOpen}
        title="清空本地弹幕库"
        message={
          <>
            确定删除全部 {items.length} 个弹幕文件（共 {fmtBytes(lib?.bytes ?? 0)}）？
            <br />
            只删弹幕库目录里的文件，不影响收藏、播放进度与其它缓存。此操作不可撤销。
          </>
        }
        confirmText="清空"
        danger
        onConfirm={async () => {
          const r = await api.danmaku.libraryClear()
          if (!r.ok) {
            toast.error(`清空失败：${r.error}`)
            return
          }
          await reload()
          toast.success('本地弹幕库已清空')
        }}
        onClose={() => setClearOpen(false)}
      />
    </Card>
  )
}

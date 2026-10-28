import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { FolderOpen, HardDrive, RefreshCw, Search } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { LocalLibraryEpisode, LocalLibraryItem } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { progressSummary, useWatchProgress } from '@/stores/watchProgress'
import { Button, EmptyState, Spinner } from '@/components/ui'
import { AnimeCard } from '@/components/AnimeCard'

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 把集数压成一句话：`第 1–4、6、9–12 集`。
 *
 * 为什么要压缩：本地库的一部番可能有几十集，把 24 个"第 N 集"全排在卡片上看不完，
 * 用户想知道的其实是"有没有断集"。解析不出集数的按文件数兜底（不编造序号）。
 */
export function episodeSummary(items: readonly LocalLibraryEpisode[]): string {
  const nums = [...new Set(items.map((e) => e.episode).filter((n): n is number => n != null))].sort((a, b) => a - b)
  if (nums.length === 0) return `${items.length} 个文件`
  const ranges: string[] = []
  let start = nums[0]
  let prev = nums[0]
  const push = (): void => {
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`)
  }
  for (const n of nums.slice(1)) {
    if (n === prev + 1) {
      prev = n
      continue
    }
    push()
    start = n
    prev = n
  }
  push()
  const unknown = items.length - nums.length
  return `第 ${ranges.join('、')} 集${unknown > 0 ? `（另有 ${unknown} 个未标集数的文件）` : ''}`
}

/**
 * 「我的番剧库 → 本地库」分区（V1.5.1）。
 *
 * 只显示**下载文件夹里真的存在**的番剧，并列出已下载的集数；点进去是本地番剧详情页
 * （`/local-anime`），那里只有本地播放、没有在线播放入口 —— 这是用户明确要求的区分。
 *
 * 数据来自主进程 `library:local`（只读文件系统，不联网）。断网时这一页照常可用，
 * 这正是它有别于「在线库」的意义。
 */
export function LocalLibraryTab() {
  const navigate = useNavigate()
  const [items, setItems] = useState<LocalLibraryItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  /*
   * V1.5.3：本地库卡片上直接显示「看到第 N 集」。
   * 进度由播放器写入（本地播放按番剧目录合并成一条记录），这里只读 store，不额外发请求。
   */
  const { items: progressItems, loaded: progressLoaded, load: loadProgress } = useWatchProgress()

  const load = async (): Promise<void> => {
    setLoading(true)
    const r = await api.library.local()
    setLoading(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setError('')
    setItems(r.data)
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    if (!progressLoaded) void loadProgress()
  }, [progressLoaded, loadProgress])

  /** 卡片底部：已下载集数 + 观看到第几集（进度只对能匹配到标题/条目的本地番剧有效） */
  const footerFor = (item: LocalLibraryItem): string => {
    const summary = episodeSummary(item.episodes)
    const progress = progressSummary(progressItems, { subjectId: item.subjectId ?? undefined, title: item.title })
    return progress.lastEpisode != null ? `${summary} · 看到第 ${progress.lastEpisode} 集` : summary
  }

  const filtered = useMemo(() => {
    const list = items ?? []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((item) => item.title.toLowerCase().includes(q))
  }, [items, query])

  const totals = useMemo(() => {
    const list = items ?? []
    return {
      count: list.length,
      episodes: list.reduce((n, item) => n + item.episodes.length, 0),
      bytes: list.reduce((n, item) => n + item.totalBytes, 0)
    }
  }, [items])

  /** 打开下载根目录（用户想自己搬文件/确认路径时最直接的入口） */
  const openRoot = async (): Promise<void> => {
    const first = items?.[0]
    if (!first) {
      toast.info('本地库还是空的，先在番剧详情页下载一集吧')
      return
    }
    // dir 是"下载根/番剧名"，取它的上一级就是下载根目录
    const idx = Math.max(first.dir.lastIndexOf('\\'), first.dir.lastIndexOf('/'))
    const root = idx > 0 ? first.dir.slice(0, idx) : first.dir
    const r = await api.app.openPath(root)
    if (!r.ok) toast.error(r.error)
    else if (r.data) toast.error(r.data)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <span className="text-[11px] text-dim">
          共 <span className="font-semibold text-text">{totals.count}</span> 部 ·{' '}
          <span className="font-semibold text-text">{totals.episodes}</span> 集 · {fmtBytes(totals.bytes)}
        </span>
        <span className="text-[11px] text-faint">只显示下载文件夹里真实存在的文件</span>
        <div className="relative ml-auto w-44 shrink-0">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="筛选本地番剧"
            className="h-7 w-full rounded-lg border border-border bg-elev1 pl-7 pr-2 text-[11px] outline-none transition-colors placeholder:text-faint focus:border-accent"
          />
        </div>
        <Button size="sm" variant="outline" icon={FolderOpen} onClick={() => void openRoot()}>
          打开下载目录
        </Button>
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onClick={() => void load()}>
          重新扫描
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading && items === null ? (
          <div className="flex items-center justify-center py-16 text-dim">
            <Spinner size={18} />
            <span className="ml-2 text-xs">正在扫描下载目录…</span>
          </div>
        ) : error ? (
          <EmptyState icon={HardDrive} title="扫描本地库失败" desc={error}>
            <Button size="sm" onClick={() => void load()}>
              重试
            </Button>
          </EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={HardDrive}
            title={items && items.length > 0 ? '没有匹配的本地番剧' : '本地库还是空的'}
            desc={
              items && items.length > 0
                ? '换个关键词试试'
                : '在番剧详情页「订阅」或下载资源后，文件会出现在下载目录里，这里就会列出来'
            }
          />
        ) : (
          <motion.div layout className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {filtered.map((item, index) => (
              <AnimeCard
                key={item.dir}
                item={{
                  // 没有匹配到 bangumi 条目时给一个稳定负数 id（卡片本身不依赖 id 做业务）
                  id: item.subjectId ?? -1 - index,
                  name: item.title,
                  nameCn: item.title,
                  cover: item.cover,
                  rating: null
                }}
                badge={
                  <span className="inline-flex items-center gap-0.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 backdrop-blur-sm">
                    <HardDrive size={9} /> 已下载 {item.episodes.length} 集
                  </span>
                }
                footer={footerFor(item)}
                onClick={() =>
                  navigate('/local-anime', {
                    state: {
                      title: item.title,
                      dir: item.dir,
                      cover: item.cover,
                      subjectId: item.subjectId ?? undefined
                    }
                  })
                }
              />
            ))}
          </motion.div>
        )}
      </div>
    </div>
  )
}

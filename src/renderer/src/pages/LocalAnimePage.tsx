import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, FolderOpen, HardDrive, PlayCircle, RefreshCw } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { LocalVideoFile, SubjectDetail } from '@shared/types'
import { localEpisodeIndex } from '@shared/localEpisode'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { useLibrary } from '@/stores/library'
import { epKey, localKey, useWatchProgress } from '@/stores/watchProgress'
import { Button, EmptyState, Spinner } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 本地库点进来的入口状态（由「我的番剧库 → 本地库」或详情页「从本地库播放」传入） */
interface LocalAnimeState {
  title?: string
  dir?: string
  cover?: string
  subjectId?: number
}

/**
 * 本地番剧详情页（V1.5.1，路由 `/local-anime`）。
 *
 * 用户要求：「这个从页面（本地库）进入的番剧详情页只有没有在线播放按钮，只有本地播放按钮，
 * 且直接选择本地已下载的集数进行播放。」
 *
 * 所以这里刻意**没有任何在线相关的东西**：不发 bangumi 请求、不显示评分/角色/简介，
 * 只有「磁盘上有什么」——封面（若能在收藏/订阅里匹配到就复用，否则占位）、
 * 已下载集数与体积、点一集直接进本地播放。
 *
 * 为什么不复用 `SubjectDetailPage`：那个页面有十几个联网 effect，为了"不联网"去逐个加守卫，
 * 既容易漏（漏一个就会在断网时转圈），也会让一个本可以 0 请求的页面变复杂。
 */
export function LocalAnimePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const initial = (location.state ?? null) as LocalAnimeState | null
  const { favorites } = useLibrary()
  const [videos, setVideos] = useState<LocalVideoFile[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /*
   * V1.5.2：复用番剧详情（用户要求「本地库的番剧选集页面也显示番剧详情页的数据，但布局可以不按详情页来」）。
   *
   * 数据复用原则：先取 `subjectCached`（纯磁盘/内存缓存，0 请求），有就直接用；
   * 没有缓存时才调 `subject()`（它本身也是缓存优先、命中就不再联网）。
   * 因此"有缓存 = 0 请求"，与详情页看到的是同一份数据，不会多打 api。
   */
  const [detail, setDetail] = useState<SubjectDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [showSummary, setShowSummary] = useState(false)

  /** 状态丢失（刷新/直接打开）时，退回到"按标题在收藏里找封面"的最低可用形态 */
  const title = initial?.title ?? ''
  const dir = initial?.dir ?? ''
  const cover = initial?.cover || favorites.find((f) => f.nameCn === title || f.name === title)?.cover || ''

  /*
   * V1.5.3：本地播放进度（按目录一条记录）。这里只读 store：
   *   · 头部显示「看到第 N 集」；
   *   · 集数网格里已看过的集加一层强调，避免用户重复点。
   * 播放器写完进度后 store 会更新，返回本页即是新的。
   */
  const { items: progressItems, loaded: progressLoaded, load: loadProgress } = useWatchProgress()
  useEffect(() => {
    if (!progressLoaded) void loadProgress()
  }, [progressLoaded, loadProgress])
  const localProgress = progressItems.find((p) => p.id === localKey(dir))
  const watchedKeys = new Set(localProgress?.watched ?? [])
  const lastWatchedEpisode = localProgress ? localProgress.episodeIndex + 1 : null

  const load = async (): Promise<void> => {
    if (!dir) {
      setLoading(false)
      setError('没有拿到本地目录（请从「我的番剧库 → 本地库」进入）')
      return
    }
    setLoading(true)
    const r = await api.media.listVideos(dir)
    setLoading(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setError('')
    setVideos(r.data)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir])

  // 详情：只有拿到 bangumi 条目 id 才有得取；先缓存、后联网（见上面的数据复用说明）
  const subjectId = initial?.subjectId
  useEffect(() => {
    if (!subjectId || subjectId <= 0) return
    let alive = true
    setDetailLoading(true)
    void (async () => {
      const cached = await api.bangumi.subjectCached(subjectId)
      if (!alive) return
      if (cached.ok && cached.data.data) {
        setDetail(cached.data.data)
        setDetailLoading(false)
        return
      }
      const full = await api.bangumi.subject(subjectId)
      if (!alive) return
      if (full.ok && full.data.data) setDetail(full.data.data)
      setDetailLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [subjectId])

  const sorted = useMemo(() => {
    const list = [...(videos ?? [])]
    list.sort((a, b) => {
      if (a.episode != null && b.episode != null) return a.episode - b.episode
      if (a.episode != null) return -1
      if (b.episode != null) return 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return list
  }, [videos])

  const totalBytes = sorted.reduce((n, v) => n + v.size, 0)

  const play = (file: LocalVideoFile): void => {
    navigate('/player', {
      state: {
        mode: 'local',
        title: title || '本地播放',
        folder: dir,
        subjectId: initial?.subjectId,
        episode: file.episode ?? undefined
      }
    })
  }

  const openFolder = async (): Promise<void> => {
    if (!dir) return
    const r = await api.app.openPath(dir)
    if (!r.ok) toast.error(r.error)
    else if (r.data) toast.error(r.data)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {/* 顶部：返回 + 标题 + 目录操作 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-2.5">
        <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => navigate(-1)}>
          返回
        </Button>
        <span className="rounded-md bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent">本地库</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title || '本地番剧'}</span>
        <Button size="sm" variant="outline" icon={FolderOpen} onClick={() => void openFolder()} disabled={!dir}>
          打开文件夹
        </Button>
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onClick={() => void load()}>
          重新扫描
        </Button>
      </div>

      {/* 头图区 */}
      <div className="relative shrink-0 overflow-hidden border-b border-border">
        <div className="pointer-events-none absolute inset-0 opacity-20">
          {cover ? <CoverImage src={cover} className="h-full w-full" rounded="" alt="" /> : null}
        </div>
        <div className="relative flex items-center gap-4 px-6 py-5">
          <CoverImage src={detail?.images?.large ?? detail?.images?.common ?? cover} className="h-32 w-24 shrink-0 shadow-lg" rounded="rounded-xl" alt={title} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold">{detail?.name_cn || detail?.name || title || '本地番剧'}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
              <span className="inline-flex items-center gap-1">
                <HardDrive size={12} /> {sorted.length} 集 · {fmtBytes(totalBytes)}
              </span>
              {lastWatchedEpisode != null ? (
                <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-accent">看到第 {lastWatchedEpisode} 集</span>
              ) : null}
              <span className="break-all text-faint">{dir}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                icon={PlayCircle}
                disabled={sorted.length === 0}
                onClick={() => {
                  const first = sorted[0]
                  if (first) play(first)
                }}
              >
                本地播放
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-faint">
              本地库只显示磁盘上已经存在的文件；这里没有在线播放按钮（在线播放请到「在线库」的详情页）。
            </p>
          </div>
        </div>
      </div>

      {/*
        V1.5.2：番剧详情数据（复用详情页同一份缓存，不额外发请求）。
        布局刻意**不照抄详情页**：本地库是"看我已经下好的"，所以做成一栏紧凑信息条
        （评分 / 放送日 / 类型标签 / 简介折叠），把纵向空间留给集数网格。
      */}
      {detailLoading ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-6 py-2 text-[11px] text-faint">
          <Spinner size={12} /> 正在读取番剧详情…
        </div>
      ) : detail ? (
        <div className="shrink-0 border-b border-border px-6 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            {detail.rating?.score ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-400/15 px-1.5 py-0.5 font-semibold text-amber-600">
                ★ {detail.rating.score.toFixed(1)}
                {detail.rating.total ? <span className="font-normal text-faint">（{detail.rating.total} 人）</span> : null}
              </span>
            ) : null}
            {detail.air_date ? <span className="text-dim">{detail.air_date} 放送</span> : null}
            {detail.eps ? <span className="text-faint">共 {detail.eps} 集</span> : null}
            {detail.tags?.slice(0, 8).map((t) => (
              <span key={t.name} className="rounded-md bg-elev2 px-1.5 py-0.5 text-dim">
                {t.name}
              </span>
            ))}
            {detail.summary ? (
              <button
                onClick={() => setShowSummary((v) => !v)}
                className="ml-auto rounded-md px-1.5 py-0.5 text-accent transition-colors hover:bg-accent-soft"
              >
                {showSummary ? '收起简介' : '展开简介'}
              </button>
            ) : null}
          </div>
          {detail.summary ? (
            <p
              className={`mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-dim ${showSummary ? '' : 'line-clamp-2'}`}
            >
              {detail.summary}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* 集数列表 */}
      <div className="min-h-0 flex-1 px-5 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-dim">
            <Spinner size={18} />
            <span className="ml-2 text-xs">正在扫描本地文件…</span>
          </div>
        ) : error ? (
          <EmptyState icon={HardDrive} title="读不到本地文件" desc={error}>
            <Button size="sm" onClick={() => void load()}>
              重试
            </Button>
          </EmptyState>
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={HardDrive}
            title="这个文件夹里没有可播放的视频"
            desc={dir ? `目录：${dir}` : '请从「我的番剧库 → 本地库」进入'}
          />
        ) : (
          <motion.div layout className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
            {sorted.map((video, index) => {
              const episodeIndex = localEpisodeIndex(video.episode, index)
              const watched = watchedKeys.has(epKey(0, episodeIndex))
              return (
                <button
                  key={video.path}
                  onClick={() => play(video)}
                  title={`${video.name}\n${fmtBytes(video.size)}`}
                  className={`group flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 transition-colors ${
                    watched
                      ? 'border-ok/40 bg-ok/5 hover:border-accent hover:bg-accent-soft'
                      : 'border-border bg-elev1/60 hover:border-accent hover:bg-accent-soft'
                  }`}
                >
                  <span className="text-sm font-semibold tabular-nums group-hover:text-accent">
                    {video.episode != null ? `第 ${video.episode} 集` : `文件 ${index + 1}`}
                  </span>
                  <span className="w-full truncate text-center text-[10px] text-faint">{video.name}</span>
                  <span className="flex items-center gap-1 text-[10px] tabular-nums text-faint">
                    {fmtBytes(video.size)}
                    {watched ? <span className="rounded bg-ok/15 px-1 text-[9px] text-ok">已看</span> : null}
                  </span>
                </button>
              )
            })}
          </motion.div>
        )}
      </div>
    </div>
  )
}

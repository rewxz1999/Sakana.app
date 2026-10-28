import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CircleAlert, ExternalLink, Globe2, Loader2, Play, Search, Sparkles } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import type {
  OnlineEpisodeItem,
  OnlineSearchItem,
  OnlineSourceAvailability,
  OnlineSourceId,
  OnlineSourceMeta
} from '@shared/types'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, EmptyState, Input, Spinner } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import { Card } from '@/components/SettingsShell'

/**
 * 附加在线数据源（V1.5.2，路由 `/online-sources`）。
 *
 * 用户需求：「我想开拓除了用规则嗅探资源的新在线源…… 用户选择在线播放后，可以选择使用原来的
 * 规则播放还是新的四条路径。」
 *
 * 这是一块独立的入口：
 *   输入名字 → 选源 → 搜索结果 → 选集 → 解析出直链 → 交给播放器（`mode:'online'`，走既有的直连/FFmpeg 中转链路）。
 * 每条路径的完成度如实标注（例如 AllManga 目前只能搜到条目与集数，直链还原未实现），
 * 不做「看起来都能用」的包装。
 *
 * 为什么不塞进现有的「选源-选集」面板：那个面板是围绕规则引擎做的（搜索/选集/播放页三列），
 * 硬塞四种完全不同的数据形态会把两边都弄复杂；独立一页也让"用它"和"不用它"互不影响。
 */
export function OnlineSourcesPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { settings, save } = useSettings()
  const initial = (location.state ?? {}) as { keyword?: string; subjectId?: number }

  const [meta, setMeta] = useState<OnlineSourceMeta[]>([])
  const [availability, setAvailability] = useState<OnlineSourceAvailability[]>([])
  const [source, setSource] = useState<OnlineSourceId>('applecms')
  const [keyword, setKeyword] = useState(initial.keyword ?? '')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<OnlineSearchItem[] | null>(null)
  const [picked, setPicked] = useState<OnlineSearchItem | null>(null)
  const [episodes, setEpisodes] = useState<OnlineEpisodeItem[] | null>(null)
  const [epLoading, setEpLoading] = useState(false)
  const [playingId, setPlayingId] = useState<string>('')

  // 配置（Apple CMS 接口 / REST base / AllAnime base）
  const [cmsText, setCmsText] = useState('')
  const [restBase, setRestBase] = useState('')
  const [allanimeBase, setAllanimeBase] = useState('')

  const cfg = settings.onlineSources ?? {}

  useEffect(() => {
    void api.online.sources().then((r) => {
      if (!r.ok) return
      setMeta(r.data.meta)
      setAvailability(r.data.availability)
      // 默认选第一个"可用"的源（未配置的源排后面）
      const firstReady = r.data.availability.find((a) => a.ready)
      if (firstReady) setSource(firstReady.id)
    })
  }, [])

  useEffect(() => {
    setCmsText((cfg.cmsApis ?? []).join('\n'))
    setRestBase(cfg.restBase ?? '')
    setAllanimeBase(cfg.allanimeBase ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.onlineSources])

  const readyMap = useMemo(() => new Map(availability.map((a) => [a.id, a])), [availability])
  const currentMeta = meta.find((m) => m.id === source)

  const saveConfig = (): void => {
    const cmsApis = cmsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//i.test(s))
    save({
      onlineSources: {
        ...cfg,
        enabled: true,
        cmsApis,
        restBase: restBase.trim(),
        allanimeBase: allanimeBase.trim()
      }
    })
    toast.success('在线数据源配置已保存')
    // 重新读可用性
    void api.online.sources().then((r) => {
      if (r.ok) setAvailability(r.data.availability)
    })
  }

  const runSearch = async (): Promise<void> => {
    const kw = keyword.trim()
    if (!kw) {
      toast.warn('请先输入番剧名')
      return
    }
    setSearching(true)
    setResults(null)
    setPicked(null)
    setEpisodes(null)
    const r = await api.online.search(source, kw)
    setSearching(false)
    if (!r.ok) {
      toast.error(r.error)
      setResults([])
      return
    }
    setResults(r.data)
    if (r.data.length === 0) toast.info('没有搜到结果：换一个源或换一个名字试试')
  }

  const openItem = async (item: OnlineSearchItem): Promise<void> => {
    setPicked(item)
    setEpisodes(null)
    setEpLoading(true)
    const r = await api.online.episodes(source, item)
    setEpLoading(false)
    if (!r.ok) {
      toast.error(r.error)
      setEpisodes([])
      return
    }
    setEpisodes(r.data)
  }

  const playEpisode = async (ep: OnlineEpisodeItem): Promise<void> => {
    if (!picked) return
    setPlayingId(ep.playId)
    const r = await api.online.resolve(source, picked, ep)
    setPlayingId('')
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    navigate('/player', {
      state: {
        mode: 'online',
        title: `${picked.title}${ep.title ? ` · ${ep.title}` : ''}`,
        url: r.data.url,
        referer: r.data.referer,
        subjectId: initial.subjectId,
        episode: ep.index + 1
      }
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-6 py-4">
      <div className="flex shrink-0 flex-wrap items-start gap-2">
        <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => navigate(-1)}>
          返回
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-base font-bold">
            <Globe2 size={16} className="text-accent" />
            在线数据源
          </h1>
          <p className="mt-1 text-[11px] leading-relaxed text-faint">
            规则嗅探之外的四条补充路径：Apple CMS 采集站 / 自托管 REST / AnimePahe / AllManga。
            每条路径的完成度不同，源卡片上会直接标注（例如只能取到条目与集数时会写「仅搜索」）。
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-dim">
        <CircleAlert size={13} className="shrink-0 text-warn" />
        <span>
          免责声明：本功能只做「从公开接口取播放地址并交给播放器」，不下载、不转存任何内容；请遵守你所在地区的法律与
          站点条款，仅用于个人观看。
        </span>
      </div>

      {/* 源选择 */}
      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
        {meta.map((m) => {
          const ready = readyMap.get(m.id)
          const active = source === m.id
          return (
            <button
              key={m.id}
              onClick={() => {
                setSource(m.id)
                setResults(null)
                setPicked(null)
                setEpisodes(null)
              }}
              className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                active ? 'border-accent bg-accent-soft' : 'border-border bg-elev1/60 hover:border-accent/40'
              }`}
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                {m.name}
                {m.canPlay ? null : <span className="rounded bg-warn/20 px-1 text-[10px] text-warn">仅搜索</span>}
                {ready?.ready ? null : <span className="rounded bg-elev3 px-1 text-[10px] text-faint">未配置</span>}
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-faint">{m.desc}</div>
              <div className="mt-1 text-[10px] text-dim">{ready?.reason ?? ''}</div>
            </button>
          )
        })}
      </div>

      {/* 搜索 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 max-w-lg">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch()
            }}
            placeholder={`在「${currentMeta?.name ?? source}」里搜索番剧名`}
            className="pl-8"
          />
        </div>
        <Button icon={Search} loading={searching} onClick={() => void runSearch()}>
          搜索
        </Button>
        {currentMeta?.canPlay === false ? (
          <span className="text-[11px] text-warn">该源本版只能搜到条目与集数（解析步骤未完成）</span>
        ) : null}
      </div>

      {/* 结果与集数 */}
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="搜索结果" desc="点击一个条目查看集数">
          {searching ? (
            <div className="flex items-center gap-2 py-6 text-[11px] text-faint">
              <Loader2 size={14} className="animate-spin" /> 正在请求「{currentMeta?.name}」…
            </div>
          ) : results === null ? (
            <div className="py-6 text-[11px] text-faint">输入名字后点「搜索」。</div>
          ) : results.length === 0 ? (
            <EmptyState icon={Search} title="没有搜到结果" desc="换一个源/关键词试试；未配置的源需先在下面填好接口" />
          ) : (
            <div className="flex max-h-[46vh] flex-col gap-1.5 overflow-y-auto pr-1">
              {results.map((item) => (
                <button
                  key={`${item.source}:${item.id}`}
                  onClick={() => void openItem(item)}
                  className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    picked?.id === item.id ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent/40'
                  }`}
                >
                  <CoverImage src={item.cover} className="h-14 w-10 shrink-0" rounded="rounded" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{item.title}</div>
                    <div className="mt-0.5 truncate text-[10px] text-faint">
                      {[item.year, item.remark].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card title={picked ? `集数 · ${picked.title}` : '集数'} desc={picked ? '点击集数直接播放（解析出直链后交给播放器）' : '先选一个搜索结果'}>
          {!picked ? (
            <div className="py-6 text-[11px] text-faint">还没有选择条目。</div>
          ) : epLoading ? (
            <div className="flex items-center gap-2 py-6 text-[11px] text-faint">
              <Spinner size={14} /> 正在取集数…
            </div>
          ) : (episodes?.length ?? 0) === 0 ? (
            <EmptyState icon={Sparkles} title="没有取到集数" desc="这个条目在该源没有可用剧集，或接口返回为空" />
          ) : (
            <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
              {episodes!.map((ep) => (
                <button
                  key={ep.playId}
                  onClick={() => void playEpisode(ep)}
                  disabled={playingId === ep.playId}
                  title={ep.title}
                  className="flex h-9 items-center justify-center gap-1 rounded-lg border border-border bg-elev1/60 text-[11px] transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-50"
                >
                  {playingId === ep.playId ? <Loader2 size={12} className="animate-spin" /> : <Play size={11} />}
                  {ep.index + 1}
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* 配置 */}
      <Card title="源配置" desc="Apple CMS 与自托管 REST 需要先填地址；AnimePahe / AllManga 无需配置">
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-dim">
              Apple CMS V10 接口（每行一个，形如 <code>https://example.com/api.php/provide/vod</code>）
            </span>
            <textarea
              value={cmsText}
              onChange={(e) => setCmsText(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={'https://example.com/api.php/provide/vod\n（可填多个，搜索只用第一个）'}
              className="w-full resize-y rounded-lg border border-border bg-elev1 px-3 py-2 font-mono text-[11px] outline-none transition-colors placeholder:text-faint focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-dim">
              自托管 REST base（兼容 Consumet/aniwatch，例如 <code>http://127.0.0.1:3000</code>）
            </span>
            <Input value={restBase} onChange={(e) => setRestBase(e.target.value)} placeholder="http://127.0.0.1:3000" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-dim">AllAnime API 基址（可留空用官方）</span>
            <Input value={allanimeBase} onChange={(e) => setAllanimeBase(e.target.value)} placeholder="https://api.allanime.day" />
          </label>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={saveConfig}>
              保存配置
            </Button>
            <span className="flex items-center gap-1 text-[11px] text-faint">
              <ExternalLink size={11} />
              采集站接口质量参差，建议只留自己验证过可用的
            </span>
          </div>
        </div>
      </Card>
    </div>
  )
}

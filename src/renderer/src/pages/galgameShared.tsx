import { useCallback, useEffect, useState } from 'react'
import {
  Camera,
  CircleCheck,
  Clock,
  ExternalLink,
  FolderOpen,
  Gamepad2,
  Play,
  RefreshCw,
  Search,
  Star,
  X,
  type LucideIcon
} from 'lucide-react'
import type { GalGame, GalRecentShot, YmgalCandidate } from '@shared/types'
import { toast } from '@/stores/app'
import { api } from '@/lib/api'
import { imgUrl, localImgUrl, timeAgo } from '@/lib/format'
import { Badge, Button, Input, Modal, Spinner } from '@/components/ui'

/**
 * galgame 两个视图（卡片库 / 沉浸模式）共用的零件。
 *
 * 为什么单独抽出来：详情面板、截图弹窗、右键菜单、月幕搜索弹窗在两种视图里是同一套东西，
 * 复制两份必然会漂移（用户改一处、另一处忘记改）。这里只放「展示 + 交互」，
 * 数据一律来自 @/stores/galgame，主进程调用一律走 @/lib/api。
 */

// ---------------- 小工具 ----------------

/** 游玩时长展示：Xh Ym / Ym Zs / Zs */
export function fmtPlay(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const z = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${z}s`
  return `${z}s`
}

export function coverIsLocal(cover: string | undefined): boolean {
  if (!cover) return false
  return /^[a-zA-Z]:[\\/]/.test(cover) || cover.startsWith('/') || cover.startsWith('\\\\')
}

/** 本地路径走 localImgUrl，远程地址走 imgUrl（sakana-img 协议代理，带缓存） */
export function coverSrcFor(cover: string): string {
  return coverIsLocal(cover) ? localImgUrl(cover) : imgUrl(cover)
}

/** 从截图列表第一条路径推断所在目录（用于「打开文件夹」） */
export function shotDir(shots: GalRecentShot[]): string {
  const p = shots[0]?.path
  if (!p) return ''
  const m = /^(.+)[\\/][^\\/]+$/.exec(p)
  return m ? m[1] : p
}

/** 用系统浏览器打开外部链接（Electron 内 window.open 会被当新窗口，统一走主进程 shell） */
export function openExternal(url: string): void {
  void api.app.openUrl(url).then((r) => {
    if (!r.ok) toast.error(r.error)
  })
}

// ---------------- 封面 ----------------

export function Cover({
  src,
  className,
  objectFit = 'object-cover'
}: {
  src?: string
  className?: string
  objectFit?: string
}) {
  const [failed, setFailed] = useState(false)
  const url = src ? coverSrcFor(src) : ''
  useEffect(() => setFailed(false), [url])
  if (!url || failed) {
    return (
      <div
        className={`flex items-center justify-center bg-gradient-to-br from-accent-soft via-elev2 to-elev3 text-faint ${className ?? ''}`}
      >
        <Gamepad2 size={26} />
      </div>
    )
  }
  return (
    <img
      src={url}
      alt="cover"
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`select-none ${objectFit} ${className ?? ''}`}
    />
  )
}

// ---------------- 数据源详情标签页 ----------------

function segCls(active: boolean): string {
  return `rounded-md px-3 py-1 text-xs font-medium transition-colors ${
    active ? 'bg-elev3 text-text' : 'text-dim hover:text-text'
  } disabled:pointer-events-none disabled:opacity-40`
}

/** 月幕详情标签页 */
export function YmgalTab({ game }: { game: GalGame }) {
  const y = game.ymgal
  if (!y) {
    return (
      <div className="rounded-xl border border-border bg-elev2/40 p-6 text-center text-xs leading-relaxed text-faint">
        暂无月幕详情数据，可点击下方「更新详情」，或在右键菜单中选择「从月幕galgame中搜索详情」。
      </div>
    )
  }
  return (
    <div>
      <div className="flex gap-5">
        <Cover src={game.customCover ?? y.cover ?? game.cover} className="h-52 w-[150px] shrink-0 rounded-xl object-cover" />
        <div className="min-w-0 flex-1">
          <div className="text-base font-bold">{y.title}</div>
          {game.title && game.title !== y.title ? <div className="mt-0.5 text-xs text-dim">{game.title}</div> : null}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
            {y.rating ? (
              <span className="flex items-center gap-0.5 text-warn">
                <Star size={11} fill="currentColor" /> {y.rating.toFixed(1)}
              </span>
            ) : null}
            {y.released ? <span>发售：{y.released}</span> : null}
            {game.playtimeSec > 0 ? (
              <span className="flex items-center gap-1">
                <Clock size={11} /> 已游玩 {fmtPlay(game.playtimeSec)}
              </span>
            ) : null}
          </div>
          {y.developers && y.developers.length > 0 ? (
            <div className="mt-1 text-[11px] text-dim">开发：{y.developers.join(' / ')}</div>
          ) : null}
          {game.tags && game.tags.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1">
              {game.tags.slice(0, 8).map((t) => (
                <Badge key={t} className="px-2 py-0.5 text-[10px]">
                  {t}
                </Badge>
              ))}
            </div>
          ) : null}
          {y.staff && y.staff.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1.5 text-[11px] font-medium text-dim">STAFF</div>
              <div className="flex flex-wrap gap-1.5">
                {y.staff.map((s, i) => (
                  <span
                    key={`${s.name}-${i}`}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-elev2/60 px-2 py-0.5 text-[10px]"
                  >
                    <span className="text-text">{s.name}</span>
                    {s.role ? <span className="text-faint">{s.role}</span> : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {y.url ? (
            <a
              className="mt-3 inline-flex cursor-pointer items-center gap-1 text-[11px] text-accent hover:underline"
              onClick={(e) => {
                e.preventDefault()
                openExternal(y.url as string)
              }}
            >
              <ExternalLink size={11} /> 在月幕查看
            </a>
          ) : null}
        </div>
      </div>

      {/* 出场角色 */}
      {y.characters && y.characters.length > 0 ? (
        <div className="mt-4">
          <div className="mb-2 text-[11px] font-medium text-dim">出场角色</div>
          {/*
            立绘是竖长图（月幕 mainImg，常带透明通道），所以图框固定高度 + object-contain + object-bottom：
            整张立绘都看得见，横竖比例不同也只是在框内留白（letterbox），不会被裁掉上下半身。
            图框单独一层 div：图缺失/加载失败时框还在（Cover 自己给占位图），卡片高度不会塌。
          */}
          <div className="grid grid-cols-3 gap-2">
            {y.characters.map((c, i) => (
              <div key={`${c.name}-${i}`} className="flex flex-col overflow-hidden rounded-lg border border-border bg-elev2/60">
                <div className="h-32 w-full bg-elev3/70">
                  <Cover src={c.image} objectFit="object-contain object-bottom" className="h-full w-full" />
                </div>
                <div className="w-full truncate px-1 pt-1 text-center text-[10px] leading-tight" title={c.nameCn || c.name}>
                  {c.nameCn || c.name}
                </div>
                {c.cv ? <div className="w-full truncate px-1 pb-1 text-center text-[9px] text-faint">{c.cv}</div> : null}
                {c.role ? <div className="w-full truncate px-1 pb-1 text-center text-[9px] text-faint">{c.role}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {y.description ? (
        <div className="selectable mt-4 max-h-56 overflow-y-auto rounded-xl bg-elev2/60 p-3.5 text-xs leading-relaxed text-dim">
          {y.description}
        </div>
      ) : null}
    </div>
  )
}

/** VNDB 详情标签页 */
export function VndbTab({ game }: { game: GalGame }) {
  const has = !!(
    game.vndbId ||
    game.description ||
    game.descriptionCn ||
    (game.tags && game.tags.length > 0) ||
    game.rating ||
    game.released ||
    (game.developers && game.developers.length > 0)
  )
  if (!has) {
    return (
      <div className="rounded-xl border border-border bg-elev2/40 p-6 text-center text-xs leading-relaxed text-faint">
        暂无详情数据，可在右键菜单中选择「从月幕galgame中搜索详情」或点击更新详情
      </div>
    )
  }
  return (
    <div>
      <div className="flex gap-5">
        <Cover src={game.customCover ?? game.cover} className="h-52 w-[150px] shrink-0 rounded-xl object-cover" />
        <div className="min-w-0 flex-1">
          <div className="text-base font-bold">{game.title}</div>
          {game.titleCn && game.titleCn !== game.title ? <div className="mt-0.5 text-sm text-dim">{game.titleCn}</div> : null}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
            {game.rating ? (
              <span className="flex items-center gap-0.5 text-warn">
                <Star size={11} fill="currentColor" /> {game.rating.toFixed(1)}
              </span>
            ) : null}
            {game.released ? <span>发售：{game.released}</span> : null}
            {game.length ? <span>长度：{game.length}</span> : null}
            {game.playtimeSec > 0 ? (
              <span className="flex items-center gap-1">
                <Clock size={11} /> 已游玩 {fmtPlay(game.playtimeSec)}
              </span>
            ) : null}
          </div>
          {game.developers && game.developers.length > 0 ? (
            <div className="mt-1 text-[11px] text-dim">开发：{game.developers.join(' / ')}</div>
          ) : null}
          {game.tags && game.tags.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1">
              {game.tags.slice(0, 8).map((t) => (
                <Badge key={t} className="px-2 py-0.5 text-[10px]">
                  {t}
                </Badge>
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex items-center gap-3 text-[11px] text-faint">
            <span className="break-all">本地：{game.folder}</span>
          </div>
          {game.vndbId ? (
            <a
              className="mt-2 inline-flex cursor-pointer items-center gap-1 text-[11px] text-accent hover:underline"
              onClick={(e) => {
                e.preventDefault()
                openExternal(`https://vndb.org/v${game.vndbId}`)
              }}
            >
              <ExternalLink size={11} /> vndb.org/v{game.vndbId}
            </a>
          ) : null}
        </div>
      </div>
      {game.descriptionCn || game.description ? (
        <div className="selectable mt-4 max-h-56 overflow-y-auto rounded-xl bg-elev2/60 p-3.5 text-xs leading-relaxed text-dim">
          {game.descriptionCn ?? game.description}
        </div>
      ) : null}
    </div>
  )
}

// ---------------- 游戏详情（卡片库弹窗 / 沉浸模式抽屉共用） ----------------

/**
 * 游戏详情面板：封面、标题、评分、游玩时长、进度、标签、月幕/VNDB 详情、简介、官网、本地路径。
 * 信息项与原「galgame 导航」抽屉完全一致（用户要求详情不能缩水），只是「开始游戏」改成
 * 用户指定的「启动游戏」文案。
 */
export function GalDetailView({
  game,
  running,
  onLaunch,
  onReload,
  onYmgalSearch,
  onSearchSites
}: {
  game: GalGame
  running: boolean
  onLaunch: (game: GalGame) => void
  onReload: () => void | Promise<void>
  onYmgalSearch: (game: GalGame) => void
  /** 「在资源站搜索数量」入口（卡片库提供；沉浸模式可以不传） */
  onSearchSites?: (game: GalGame) => void
}) {
  const [tab, setTab] = useState<'ymgal' | 'vndb'>(game.ymgal ? 'ymgal' : 'vndb')
  const [updating, setUpdating] = useState(false)

  // 切换游戏（弹窗复用同一实例）时把来源切回有数据的那一侧
  useEffect(() => {
    setTab(game.ymgal ? 'ymgal' : 'vndb')
  }, [game.id, game.ymgal])

  const updateDetail = async (): Promise<void> => {
    setUpdating(true)
    const r = await api.gal.updateDetail(game.id)
    setUpdating(false)
    if (r.ok) {
      toast.success('详情已更新')
      await onReload()
    } else {
      toast.error(r.error)
    }
  }

  return (
    <div>
      {/* 竖封面 + 标题 + 操作 */}
      <div className="flex gap-4">
        <Cover src={game.customCover || game.cover} objectFit="object-cover" className="h-44 w-[120px] shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="text-base font-bold leading-snug">{game.title}</div>
          {game.titleCn && game.titleCn !== game.title ? <div className="mt-0.5 text-xs text-dim">{game.titleCn}</div> : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {running ? <Badge tone="ok">运行中</Badge> : null}
            {game.finished ? (
              <Badge tone="ok">
                <CircleCheck size={9} /> 玩完
              </Badge>
            ) : null}
            {game.rating ? (
              <Badge tone="warn">
                <Star size={9} fill="currentColor" /> {game.rating.toFixed(1)}
              </Badge>
            ) : null}
          </div>
          <div className="mt-2 text-[11px] text-dim">
            {game.playtimeSec > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Clock size={11} /> 已游玩 {fmtPlay(game.playtimeSec)}
              </span>
            ) : (
              <span>未游玩</span>
            )}
          </div>
          {game.lastRouteInfo ? (
            <div className="mt-1.5 whitespace-pre-wrap break-all rounded-md bg-elev2/60 px-2 py-1 text-[10px] leading-relaxed text-faint">
              进度：{game.lastRouteInfo}
            </div>
          ) : null}
          <Button className="mt-3 w-full" icon={Play} loading={running} onClick={() => onLaunch(game)}>
            {running ? '游戏中' : '启动游戏'}
          </Button>
        </div>
      </div>

      {/* 评分 / 发售 / 长度 / 开发 / 标签 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
        {game.rating ? (
          <span className="flex items-center gap-0.5 text-warn">
            <Star size={11} fill="currentColor" /> {game.rating.toFixed(1)}
          </span>
        ) : null}
        {game.released ? <span>发售：{game.released}</span> : null}
        {game.length ? <span>长度：{game.length}</span> : null}
      </div>
      {game.developers && game.developers.length > 0 ? (
        <div className="mt-1 text-[11px] text-dim">开发：{game.developers.join(' / ')}</div>
      ) : null}
      {game.tags && game.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {game.tags.slice(0, 8).map((t) => (
            <Badge key={t} className="px-2 py-0.5 text-[10px]">
              {t}
            </Badge>
          ))}
        </div>
      ) : null}

      {/* 来源切换 */}
      <div className="mt-4 inline-flex items-center gap-1 rounded-lg bg-elev2/70 p-0.5">
        <button className={segCls(tab === 'ymgal')} disabled={!game.ymgal} onClick={() => setTab('ymgal')}>
          月幕
        </button>
        <button className={segCls(tab === 'vndb')} onClick={() => setTab('vndb')}>
          VNDB
        </button>
      </div>
      <div className="mt-3">{tab === 'ymgal' ? <YmgalTab game={game} /> : <VndbTab game={game} />}</div>

      {/* 底部操作 */}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" icon={Search} onClick={() => onYmgalSearch(game)}>
          从月幕搜索详情
        </Button>
        <div className="flex items-center gap-2">
          {onSearchSites ? (
            <Button variant="ghost" size="sm" icon={ExternalLink} onClick={() => onSearchSites(game)}>
              资源站搜索
            </Button>
          ) : null}
          <Button size="sm" variant="outline" loading={updating} onClick={() => void updateDetail()}>
            更新详情
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------- 截图弹窗（每张游戏卡片一份 / 沉浸模式看全部） ----------------

/**
 * 截图弹窗。
 * - 传 game：只读**这款游戏自己的**截图目录（<截图根目录>/<游戏名>/）
 * - 不传 game：读截图根目录 + 各游戏子目录的聚合「最近截图」（沉浸模式仍保留的旧入口）
 */
export function GalShotsModal({
  open,
  game,
  onClose
}: {
  open: boolean
  game?: GalGame | null
  onClose: () => void
}) {
  const [shots, setShots] = useState<GalRecentShot[]>([])
  const [loading, setLoading] = useState(false)
  const [lightbox, setLightbox] = useState<GalRecentShot | null>(null)
  // 只依赖标题字符串：store 每次推送都会换新的 game 对象，直接依赖对象会让弹窗每 2 秒重拉一次文件
  const gameTitle = game?.title ?? ''

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = gameTitle ? await api.gal.listShots(gameTitle) : await api.gal.recentShots()
    setLoading(false)
    if (r.ok) setShots(r.data)
    else toast.error(r.error)
  }, [gameTitle])

  // 打开时拉一次（game 变了也要重拉，避免弹窗里看到上一款游戏的截图）
  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  const openFolder = async (): Promise<void> => {
    const dir = shotDir(shots)
    if (!dir) return
    const r = await api.app.openPath(dir)
    if (!r.ok) toast.error(r.error)
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        width={720}
        title={game ? `最近截图 · ${game.titleCn || game.title}` : '最近截图'}
      >
        <div>
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-[11px] text-faint">
              {shots.length > 0 ? `${shots.length} 张截图` : '暂无截图'}
              {game ? '（只显示这款游戏自己的截图）' : ''}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" icon={FolderOpen} disabled={shots.length === 0} onClick={() => void openFolder()}>
                打开文件夹
              </Button>
              <Button variant="ghost" size="sm" icon={RefreshCw} loading={loading} onClick={() => void load()}>
                刷新
              </Button>
            </div>
          </div>
          {shots.length === 0 && !loading ? (
            <div className="py-10 text-center text-xs leading-relaxed text-faint">
              {game
                ? '这款游戏还没有截图。启动游戏后按截图快捷键（默认 Ctrl+Shift+G）或点悬浮拍摄按钮即可。'
                : '截图目录暂无图片。使用截图助手（随游戏启动）或「试截一张」生成截图。'}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 md:grid-cols-4">
              {shots.map((s) => (
                <button
                  key={s.path}
                  onClick={() => setLightbox(s)}
                  className="group relative aspect-video overflow-hidden rounded-lg border border-border bg-elev2"
                  title={s.name}
                >
                  <img
                    src={localImgUrl(s.path)}
                    alt={s.name}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-105"
                    onError={(e) => {
                      ;(e.currentTarget as HTMLImageElement).style.opacity = '0.2'
                    }}
                  />
                  <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-left text-[9px] text-white/80">
                    {timeAgo(s.mtime)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* 大图 lightbox */}
      {lightbox ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
        >
          <img
            src={localImgUrl(lightbox.path)}
            alt={lightbox.name}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>
      ) : null}
    </>
  )
}

// ---------------- 月幕搜索弹窗 ----------------

export function GalYmgalSearchModal({
  game,
  onClose,
  onApplied
}: {
  game: GalGame | null
  onClose: () => void
  onApplied: () => void | Promise<void>
}) {
  const [keyword, setKeyword] = useState('')
  const [candidates, setCandidates] = useState<YmgalCandidate[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [applying, setApplying] = useState<string | null>(null)
  const gameId = game?.id ?? ''

  // 每次针对某个游戏打开时，用它的中文名/原名预填关键词并清空上一次的结果
  useEffect(() => {
    if (!game) return
    setKeyword(game.titleCn || game.title)
    setCandidates(null)
    setApplying(null)
  }, [gameId, game?.title, game?.titleCn])

  const doSearch = async (): Promise<void> => {
    const kw = keyword.trim()
    if (!kw) return
    setSearching(true)
    const r = await api.gal.searchYmgal(kw)
    setSearching(false)
    if (r.ok) {
      setCandidates(r.data)
      if (r.data.length === 0) toast.warn('月幕未找到该游戏')
    } else {
      toast.error(r.error)
      setCandidates([])
    }
  }

  const doApply = async (c: YmgalCandidate): Promise<void> => {
    if (!game) return
    setApplying(String(c.id))
    const r = await api.gal.applyYmgal(game.id, c.id)
    setApplying(null)
    if (r.ok) {
      toast.success('已从月幕导入详情')
      await onApplied()
      onClose()
    } else {
      toast.error(r.error)
    }
  }

  return (
    <Modal open={!!game} onClose={onClose} title="从月幕galgame中搜索详情" width={520}>
      <div>
        <div className="flex gap-2">
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="输入游戏名，如 千恋万花"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doSearch()
            }}
          />
          <Button loading={searching} onClick={() => void doSearch()}>
            搜索
          </Button>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {candidates === null ? (
            <div className="py-6 text-center text-xs text-faint">输入关键词后搜索月幕 galgame 数据库</div>
          ) : candidates.length === 0 ? (
            <div className="py-6 text-center text-xs text-faint">月幕未找到该游戏</div>
          ) : (
            candidates.map((c) => (
              <button
                key={c.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-elev2/40 p-2 text-left transition-colors hover:bg-elev2"
                onClick={() => void doApply(c)}
              >
                {c.cover ? (
                  <img
                    src={imgUrl(c.cover)}
                    alt=""
                    className="h-14 w-10 shrink-0 rounded bg-elev3 object-cover"
                    onError={(e) => {
                      ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                    }}
                  />
                ) : (
                  <div className="h-14 w-10 shrink-0 rounded bg-elev3" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{c.titlesCn || c.title}</div>
                  {c.titlesCn && c.titlesCn !== c.title ? (
                    <div className="truncate text-[11px] text-faint">{c.title}</div>
                  ) : null}
                </div>
                {applying === String(c.id) ? <Spinner size={14} /> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  )
}

// ---------------- 右键菜单 ----------------

export interface GalMenuItem {
  key: string
  icon: LucideIcon
  label: string
  danger?: boolean
  onSelect: () => void
}

export interface GalMenuState {
  x: number
  y: number
  game: GalGame
}

/** 计算右键菜单出现位置（按最大条目数估算，超界就往回收，保证整块落在窗口内） */
export function menuPosition(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const MENU_W = 216
  const MENU_H = 320
  const pad = 8
  return {
    x: Math.min(Math.max(pad, e.clientX), Math.max(pad, window.innerWidth - MENU_W - pad)),
    y: Math.min(Math.max(pad, e.clientY), Math.max(pad, window.innerHeight - MENU_H - pad))
  }
}

/** 右键菜单：点击任意处 / 再次右键 / Esc 关闭 */
export function useMenuDismiss(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])
}

export function GalContextMenu({ menu, items }: { menu: GalMenuState | null; items: GalMenuItem[] }) {
  if (!menu) return null
  return (
    <div
      className="fixed z-[70] max-h-[calc(100vh-16px)] overflow-y-auto rounded-xl border border-border bg-elev1 py-1 shadow-2xl"
      style={{ left: menu.x, top: menu.y, width: 216 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it) => {
        const Icon = it.icon
        return (
          <button
            key={it.key}
            className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs hover:bg-elev2 ${
              it.danger ? 'text-danger hover:bg-danger/10' : ''
            }`}
            onClick={it.onSelect}
          >
            <Icon size={13} /> {it.label}
          </button>
        )
      })}
    </div>
  )
}

/** 卡片右下角的相机按钮图标（游戏卡片上的「最近截图」入口） */
export const ShotsIcon = Camera


import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Camera,
  CircleCheck,
  Clock,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  Gamepad2,
  PackageOpen,
  Play,
  RefreshCw,
  Search,
  Star,
  X,
  type LucideIcon
} from 'lucide-react'
import type { GalBgmSaved, GalGame, GalMemRecent, GalRecentShot, GalUnpackSummary, YmgalCandidate } from '@shared/types'
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

// ---------------- 引擎检测（卡片 + 详情共用一份缓存） ----------------

export interface EngineInfo {
  engine: string
  evidence: string[]
  reason: string
}

/**
 * 引擎检测结果缓存。
 * 为什么要有缓存：卡片墙上每张卡都要显示引擎，详情面板也要显示 —— 不缓存的话同一款游戏会发两次 IPC，
 * 卡片一多就是十几次目录扫描。检测依据是游戏目录里的特征文件，一次会话内不会变，缓存到进程结束即可。
 */
const engineCache = new Map<string, EngineInfo>()

/** 读某款游戏的引擎（+ 判定依据）。第一次走主进程，之后命中缓存。 */
export function useGameEngine(game: GalGame | null | undefined): EngineInfo {
  const key = game ? `${game.id}|${game.exePath ?? ''}` : ''
  const [info, setInfo] = useState<EngineInfo>(
    () => (key ? engineCache.get(key) : undefined) ?? { engine: '', evidence: [], reason: '' }
  )
  useEffect(() => {
    if (!key || !game) return
    const hit = engineCache.get(key)
    if (hit) {
      setInfo(hit)
      return
    }
    let alive = true
    void api.gal.unpackStatus(game.id, game.exePath ?? '').then((r) => {
      if (!alive || !r.ok) return
      const v: EngineInfo = {
        engine: r.data.engine || '未知',
        evidence: r.data.evidence ?? [],
        reason: r.data.reason ?? ''
      }
      engineCache.set(key, v)
      setInfo(v)
    })
    return () => {
      alive = false
    }
    // game 对象每次 store 推送都会换新，按 key（id+exePath）判定即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return info
}

/** 卡片上的小引擎标签（检测不到就什么都不显示，不占位、不编） */
export function EngineBadge({ game, className = '' }: { game: GalGame; className?: string }) {
  const info = useGameEngine(game)
  if (!info.engine || info.engine === '未知') return null
  return (
    <span
      title={`引擎：${info.engine}${info.evidence.length ? `（依据 ${info.evidence.join('、')}）` : ''}`}
      className={`inline-flex max-w-full items-center gap-0.5 truncate rounded bg-elev2 px-1 py-0.5 text-[10px] text-dim ${className}`}
    >
      <Cpu size={9} /> {info.engine}
    </span>
  )
}

// ---------------- 游戏详情（卡片库弹窗 / 沉浸模式抽屉共用） ----------------

/**
 * 各来源（月幕 / VNDB）**已经展示**了哪些字段。
 * 详情页据此只补缺口，避免同一个"发售/评分/开发"在上、下两块各显示一遍（用户明确要求去重）。
 */
const SOURCE_COVERS: Record<'ymgal' | 'vndb', Set<string>> = {
  // 月幕标签页展示：标题、简介、发售、开发(brand)、评分、标签、STAFF、角色、官网
  // —— tags 必须算进去：YmgalTab 本来就渲染 game.tags，不标记就会在下面再显示一遍
  ymgal: new Set(['description', 'released', 'developers', 'rating', 'tags']),
  // VNDB 标签页展示：简介、评分、发售、长度、开发、标签、本地路径、VNDB 链接
  vndb: new Set(['description', 'released', 'developers', 'rating', 'length', 'tags'])
}

/** 当前来源没覆盖到的本地字段，补成一行；全都被覆盖时什么都不渲染（不占位） */
function MissingMeta({ game, source }: { game: GalGame; source: 'ymgal' | 'vndb' }): ReactNode | null {
  const covers = SOURCE_COVERS[source]
  const rows: ReactNode[] = []
  if (game.length && !covers.has('length')) rows.push(<span key="len">长度：{game.length}</span>)
  if (game.tags && game.tags.length > 0 && !covers.has('tags')) {
    rows.push(
      <span key="tags" className="flex flex-wrap items-center gap-1">
        标签：
        {game.tags.slice(0, 8).map((t) => (
          <Badge key={t} className="px-2 py-0.5 text-[10px]">
            {t}
          </Badge>
        ))}
      </span>
    )
  }
  if (!rows.length) return null
  return <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">{rows}</div>
}

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

  // 引擎检测：与卡片共用同一份缓存（见 useGameEngine），拿不到就留空、不显示假信息
  const engineInfo = useGameEngine(game)
  const engine = engineInfo.engine
  const engineEvidence = engineInfo.evidence

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
          {game.chapterName ? (
            <div className="mt-1.5 whitespace-pre-wrap break-all rounded-md bg-elev2/60 px-2 py-1 text-[10px] leading-relaxed text-dim">
              章节：{game.chapterName}
            </div>
          ) : null}
          <Button className="mt-3 w-full" icon={Play} loading={running} onClick={() => onLaunch(game)}>
            {running ? '游戏中' : '启动游戏'}
          </Button>
        </div>
      </div>

      {/* 来源切换（V1.1：本地/导入的元信息已经并进这一块，不再单独重复一遍） */}
      <div className="mt-4 inline-flex items-center gap-1 rounded-lg bg-elev2/70 p-0.5">
        <button className={segCls(tab === 'ymgal')} disabled={!game.ymgal} onClick={() => setTab('ymgal')}>
          月幕
        </button>
        <button className={segCls(tab === 'vndb')} onClick={() => setTab('vndb')}>
          VNDB
        </button>
      </div>
      <div className="mt-3">{tab === 'ymgal' ? <YmgalTab game={game} /> : <VndbTab game={game} />}</div>

      {/*
        V1.1 去重：本地/导入的字段只在**当前来源没有它**时才补一行。
        取舍：不做"两套信息的对照表"（同一个发售日显示两遍正是用户要我们去掉的），
        所以先算出来源已经覆盖了哪些字段（见 SOURCE_COVERS），只渲染缺口。
      */}
      <MissingMeta game={game} source={tab} />

      {/* 引擎（只读游戏目录特征文件识别；解包面板里还能看到判定依据） */}
      <div className="mt-3 flex items-center gap-2 text-[11px] text-dim">
        <Cpu size={11} />
        <span>引擎：{engine || '检测中…'}</span>
        {engineEvidence.length ? <span className="text-faint">（{engineEvidence.join('、')}）</span> : null}
      </div>

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
                : '截图目录暂无图片。使用galgame 助手（随游戏启动）或「试截一张」生成截图。'}
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

// ---------------- 最近识别 BGM 面板 ----------------

/**
 * 「查看最近识别的 bgm 名称（可复制）」面板。
 * 数据来自只读内存识别服务（gal:mem-recent）：最近识别到的音频文件名 + 来源引擎。
 * 未开启 / 未识别到时给出明确中文说明，绝不用假数据占位。
 */
export function GalBgmModal({ game, onClose }: { game: GalGame | null; onClose: () => void }) {
  const [data, setData] = useState<GalMemRecent | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<GalBgmSaved[]>([])
  const gameId = game?.id ?? ''

  const load = useCallback(async (): Promise<void> => {
    if (!gameId) return
    setLoading(true)
    const r = await api.gal.memRecent(gameId)
    setLoading(false)
    if (r.ok) setData(r.data)
    else toast.error(r.error)
  }, [gameId])

  /** 已保存的 BGM（沿用截图那套目录：<galgame 保存根目录>/<游戏名>/bgm/） */
  const loadSaved = useCallback(async (): Promise<void> => {
    if (!game) return
    const r = await api.gal.savedBgm(game.id, game.title)
    if (r.ok) setSaved(r.data)
  }, [game])

  // 每次打开针对某款游戏时清空旧数据并重拉
  useEffect(() => {
    if (!game) return
    setData(null)
    setCopied(null)
    void load()
    void loadSaved()
  }, [game, load, loadSaved])

  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => setCopied(null), 1200)
    } catch {
      toast.error('复制失败')
    }
  }

  const copyAll = async (): Promise<void> => {
    const text = (data?.entries ?? []).map((e) => (e.title ? `${e.title}（${e.name}）` : e.name)).join('\n')
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast.success('已复制全部 BGM 名称')
    } catch {
      toast.error('复制失败')
    }
  }

  /** 把某首 BGM 从游戏档案里只读提取出来保存到本地（文件名优先真实曲名） */
  const saveOne = async (code: string): Promise<void> => {
    if (!gameId) return
    setSaving(code)
    const r = await api.gal.saveBgm(gameId, code)
    setSaving(null)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (!r.data.ok) {
      toast.error(r.data.error || '保存失败')
      return
    }
    toast.success(`已保存 BGM：${r.data.path}`)
    void loadSaved()
  }

  /** 打开保存目录（有文件时用文件的目录；一个都没存过就提示先保存） */
  const openDir = async (): Promise<void> => {
    const first = saved[0]
    if (!first) {
      toast.error('还没有保存过 BGM，先点某一首的「保存」')
      return
    }
    const dir = first.path.replace(/[\\/][^\\/]+$/, '')
    const r = await api.app.openPath(dir)
    if (!r.ok) toast.error(r.error)
  }

  const kindLabel = (k?: string): string =>
    k === 'playing' ? '当前在播' : k === 'candidate' ? '内存中的候选' : '刚出现'

  return (
    <Modal open={!!game} onClose={onClose} width={560} title="查看最近识别的 bgm 名称（可复制）">
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] text-faint">
            {data?.engine ? `识别引擎：${data.engine}` : '引擎：未识别'}
            {data?.titleSource ? ` · 曲名来源：${data.titleSource}` : ''}
            {data && data.entries.length > 0 ? ` · ${data.entries.length} 条` : ''}
          </span>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button variant="soft" size="sm" disabled={!(data && data.entries.length > 0)} onClick={() => void copyAll()}>
              复制全部
            </Button>
          </div>
        </div>

        {/*
          实时状态：识别「当前在播」靠的是内存里代号出现签名的变化（真机实测的唯一切曲信号），
          所以必须把"识别于 N 秒前"写出来 —— 用户切场景后能立刻看出刷新了没有。
        */}
        {data?.playing ? (
          <div className="mb-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2">
            <div className="truncate text-sm font-semibold text-accent" title={data.playing.name}>
              {data.playing.title || data.playing.name}
            </div>
            <div className="mt-0.5 truncate text-[10px] text-faint">
              {data.playing.title ? `代号 ${data.playing.name} · ` : '只有代号（游戏数据里没有曲名）· '}
              识别于 {Math.max(0, Math.round((Date.now() - (data.playingAt ?? data.playing.time)) / 1000))} 秒前
            </div>
          </div>
        ) : null}

        {data?.codeOnly && (data?.entries.length ?? 0) > 0 ? (
          <div className="mb-3 rounded-lg border border-border bg-elev2/40 px-3 py-2 text-[11px] leading-relaxed text-faint">
            游戏数据里没有「代号 → 曲名」的映射（明文曲目表与档案里的 soundlist/bgmtitle 表都没有），
            所以这里只能显示代号；可以点「保存」把这首 BGM 提取出来自己听。
          </div>
        ) : null}

        {data?.lastError ? (
          <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger">
            {data.lastError}
          </div>
        ) : null}

        {!loading && (!data || data.entries.length === 0) ? (
          <div className="py-10 text-center text-xs leading-relaxed text-faint">
            {data?.lastError
              ? '未识别到 BGM'
              : '还没有识别到 BGM。请在设置里开启「内存识别 BGM / 章节」并启动游戏；识别到音频文件名后会按时间列出（仅只读读取，不修改游戏任何数据）。'}
          </div>
        ) : (
          <div className="flex max-h-[46vh] flex-col gap-1.5 overflow-y-auto pr-0.5">
            {(data?.entries ?? []).map((e) => (
              <div
                key={`${e.time}-${e.name}`}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                  e.kind === 'playing' ? 'border-accent/40 bg-accent/10' : 'border-border bg-elev2/40'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium" title={e.title ? `${e.title}（${e.name}）` : e.name}>
                    {e.title || e.name}
                  </div>
                  <div className="truncate text-[10px] text-faint">
                    {kindLabel(e.kind)}
                    {e.title ? ` · 代号 ${e.name}` : ''}
                    {' · '}
                    {timeAgo(e.time)}
                    {e.engine ? ` · ${e.engine}` : ''}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={saving === e.name}
                  icon={Download}
                  onClick={() => void saveOne(e.name)}
                >
                  保存
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={copied === e.name ? CircleCheck : Copy}
                  onClick={() => void copyText(e.title ? `${e.title}（${e.name}）` : e.name)}
                >
                  {copied === e.name ? '已复制' : '复制'}
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* 已保存的 BGM：沿用截图那套目录约定（<galgame 保存根目录>/<游戏名>/bgm/） */}
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-dim">最近保存的 BGM（{saved.length}）</span>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" disabled={saved.length === 0} onClick={() => void openDir()}>
                打开所在目录
              </Button>
              <Button variant="ghost" size="sm" loading={loading} onClick={() => void loadSaved()}>
                刷新列表
              </Button>
            </div>
          </div>
          {saved.length === 0 ? (
            <div className="text-[11px] leading-relaxed text-faint">
              还没有保存过。点上面某一首的「保存」会把这首 BGM 从游戏档案里**只读提取**出来存到
              &lt;galgame 保存目录&gt;/&lt;游戏名&gt;/bgm/，文件名优先用真实曲名。
            </div>
          ) : (
            <div className="flex max-h-[22vh] flex-col gap-1 overflow-y-auto pr-0.5">
              {saved.slice(0, 20).map((s) => (
                <div key={s.path} className="flex items-center gap-2 rounded-lg bg-elev2/40 px-2.5 py-1">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium" title={s.path}>
                      {s.name}
                    </div>
                    <div className="truncate text-[10px] text-faint">
                      {timeAgo(s.mtime)} · {(s.size / 1024 / 1024).toFixed(2)} MB
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={copied === s.path ? CircleCheck : Copy}
                    onClick={() => void copyText(s.path)}
                  >
                    {copied === s.path ? '已复制' : '复制路径'}
                  </Button>
                  <Button variant="ghost" size="sm" icon={FolderOpen} onClick={() => void api.app.openPath(s.path)}>
                    打开
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ---------------- 解包 / 立绘 CG（V1.1） ----------------

/**
 * 卡片右键「解包」：引擎检测 + 自动解包 + 曲名映射。
 *
 * 为什么把它做成一个面板而不是"点一下后台跑"：解包结果里有**做不到的部分**
 * （Siglus 的 pfs 正文加密、部分 xp3 索引不是 zlib），必须让用户看见"做到哪一步、为什么做不到"，
 * 而不是静默失败。
 */
export function GalUnpackModal({ game, onClose }: { game: GalGame | null; onClose: () => void }) {
  const [status, setStatus] = useState<{ unpacked: boolean; at: number; files: number; engine: string; evidence: string[]; reason: string } | null>(null)
  const [summary, setSummary] = useState<GalUnpackSummary | null>(null)
  const [busy, setBusy] = useState('')
  const [imgResult, setImgResult] = useState('')

  const loadStatus = useCallback(async (): Promise<void> => {
    if (!game) return
    const r = await api.gal.unpackStatus(game.id, game.exePath ?? '')
    if (r.ok) setStatus(r.data)
  }, [game])

  useEffect(() => {
    if (!game) return
    setSummary(null)
    setImgResult('')
    void loadStatus()
  }, [game, loadStatus])

  const runUnpack = async (force: boolean): Promise<void> => {
    if (!game) return
    setBusy('unpack')
    const r = await api.gal.unpack(game.id, game.exePath ?? '', game.title, force)
    setBusy('')
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    setSummary(r.data)
    void loadStatus()
    toast.success(
      r.data.ok
        ? `解包完成：${r.data.engine} · ${r.data.files} 个文件 · ${r.data.titles} 条曲名`
        : `解包未完成：${r.data.error || '没有解出内容'}`
    )
  }

  const runExtract = async (kind: '立绘' | 'cg'): Promise<void> => {
    if (!game) return
    setBusy(kind)
    const r = await api.gal.extractImages(game.id, game.exePath ?? '', game.title, kind, 12)
    setBusy('')
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (!r.data.ok) {
      setImgResult(`${kind}：${r.data.error}（候选 ${r.data.candidates}）`)
      toast.error(r.data.error)
      return
    }
    // 立绘的主路径是"按坐标表合成"；回退路径（整身碎片）也要如实说清楚，不能让用户以为都是合成图
    const extra =
      kind === '立绘'
        ? `（加合成 ${r.data.composed ?? 0} 张${r.data.fallback ? ` · 回退整身碎片 ${r.data.fallback} 张` : ''} · 候选姿势 ${r.data.candidates}）`
        : `（候选 ${r.data.candidates}）`
    setImgResult(`${kind}：写出 ${r.data.count} 张${extra} → ${r.data.dir}`)
    toast.success(`${kind}已提取 ${r.data.count} 张`)
  }

  return (
    <Modal open={!!game} onClose={onClose} width={560} title={`解包 · ${game?.title ?? ''}`}>
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-border bg-elev2/40 px-3 py-2 text-[11px] leading-relaxed">
          <div>
            引擎：<span className="font-medium text-text">{status?.engine || '检测中…'}</span>
            {status?.evidence?.length ? <span className="text-faint">（依据 {status.evidence.join('、')}）</span> : null}
          </div>
          <div className="mt-0.5 text-faint">
            {status?.unpacked
              ? `已解包：${status.files} 个文本/脚本文件（${new Date(status.at).toLocaleString()}）`
              : status?.reason || '还没有解包'}
          </div>
          <div className="mt-1 text-faint">
            解包只读游戏档案，产物写在 Sakana 自己的缓存目录；游戏目录不会被改动。
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="soft" size="sm" loading={busy === 'unpack'} onClick={() => void runUnpack(false)}>
            {status?.unpacked ? '解析曲名（用已解包内容）' : '开始解包'}
          </Button>
          <Button variant="outline" size="sm" loading={busy === 'unpack'} onClick={() => void runUnpack(true)}>
            清掉缓存重新解包
          </Button>
          <Button variant="outline" size="sm" loading={busy === '立绘'} onClick={() => void runExtract('立绘')}>
            提取立绘
          </Button>
          <Button variant="outline" size="sm" loading={busy === 'cg'} onClick={() => void runExtract('cg')}>
            提取 CG
          </Button>
        </div>

        {summary ? (
          <div className="rounded-lg border border-border bg-elev2/40 px-3 py-2 text-[11px] leading-relaxed">
            <div>
              引擎 <span className="font-medium">{summary.engine}</span>
              {summary.evidence.length ? `（${summary.evidence.join('、')}）` : ''} · 耗时 {summary.elapsedMs}ms
            </div>
            <div className="mt-0.5">
              档案 {summary.archives} 个（索引可读 {summary.readableArchives}）· 解出 {summary.files} 个文件 /{' '}
              {(summary.bytes / 1024 / 1024).toFixed(1)}MB
            </div>
            <div className="mt-0.5">
              曲名 {summary.titles} 条 · 脚本引用代号 {summary.codes} 个 · 场景脚本 {summary.scripts} 个
            </div>
            {summary.sources.length ? <div className="mt-0.5 text-faint">来源：{summary.sources.join('、')}</div> : null}
            {summary.titles === 0 ? (
              <div className="mt-1 text-faint">
                没解析到曲名：内存里的代号会**如实显示为代号**，不会编曲名。
              </div>
            ) : null}
            {summary.error ? <div className="mt-1 text-danger">{summary.error}</div> : null}
          </div>
        ) : null}

        {imgResult ? <div className="rounded-lg border border-border bg-elev2/40 px-3 py-2 text-[11px] break-all">{imgResult}</div> : null}

        <div className="text-[11px] leading-relaxed text-faint">
          保存规则：<code>&lt;自定义根目录&gt;/&lt;游戏名&gt;/&lt;种类&gt;/&lt;文件&gt;</code>，种类分
          截图 / bgm / 立绘 / cg；立绘文件名用「角色名+序号」（另写 立绘清单.json 记下每张对应的姿势/级别），
          CG 与截图用原名，BGM 优先用真实曲名。
          <br />
          立绘是<b>按坐标表做的差分合成</b>：KiriKiri 系的立绘由「碎片 PNG + 坐标表」组成，
          Sakana 把坐标表（21 字节头 + zlib + UTF-16 图层表）解出来，按每层的 left/top/不透明度
          把 visible 的碎片逐层叠成整身立绘，再裁掉四周空白。该作没有可读坐标表时，
          自动回退成「提取整身底图碎片」，并在上面的结果里写明是哪一种。
        </div>
      </div>
    </Modal>
  )
}

// ---------------- 最近保存的 BGM ----------------

/**
 * 卡片右键「最近保存的 bgm」：列出从游戏档案里只读提取出来的 BGM 文件。
 * 与「最近截图」同一套心智：按游戏名分目录，可复制路径、可直接打开文件/所在目录。
 */
export function GalBgmSavedModal({ game, onClose }: { game: GalGame | null; onClose: () => void }) {
  const [list, setList] = useState<GalBgmSaved[]>([])
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!game) return
    setLoading(true)
    const r = await api.gal.savedBgm(game.id, game.title)
    setLoading(false)
    if (r.ok) setList(r.data)
    else toast.error(r.error)
  }, [game])

  useEffect(() => {
    if (!game) return
    setList([])
    setCopied(null)
    void load()
  }, [game, load])

  const copyPath = async (p: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(p)
      setCopied(p)
      setTimeout(() => setCopied(null), 1200)
    } catch {
      toast.error('复制失败')
    }
  }

  const dir = list[0] ? list[0].path.replace(/[\\/][^\\/]+$/, '') : ''

  return (
    <Modal open={!!game} onClose={onClose} width={560} title={`最近保存的 bgm · ${game?.title ?? ''}`}>
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] text-faint">
            {list.length > 0 ? `${list.length} 个文件 · 保存目录：${dir}` : '还没有保存过 BGM'}
          </span>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button
              variant="soft"
              size="sm"
              disabled={!dir}
              onClick={async () => {
                const r = await api.app.openPath(dir)
                if (!r.ok) toast.error(r.error)
              }}
            >
              打开所在目录
            </Button>
          </div>
        </div>

        {list.length === 0 ? (
          <div className="py-10 text-center text-xs leading-relaxed text-faint">
            还没有保存过 BGM。在游戏卡片右键菜单里选「查看最近识别的 bgm 名称」，点某一首的「保存」，
            Sakana 会把这首 BGM 从游戏档案里**只读提取**出来（不修改游戏目录），文件名优先用真实曲名。
          </div>
        ) : (
          <div className="flex max-h-[52vh] flex-col gap-1.5 overflow-y-auto pr-0.5">
            {list.map((s) => (
              <div key={s.path} className="flex items-center gap-2 rounded-lg border border-border bg-elev2/40 px-2.5 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium" title={s.path}>
                    {s.name}
                  </div>
                  <div className="truncate text-[10px] text-faint">
                    {timeAgo(s.mtime)} · {(s.size / 1024 / 1024).toFixed(2)} MB
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={copied === s.path ? CircleCheck : Copy}
                  onClick={() => void copyPath(s.path)}
                >
                  {copied === s.path ? '已复制' : '复制路径'}
                </Button>
                <Button variant="ghost" size="sm" icon={FolderOpen} onClick={() => void api.app.openPath(s.path)}>
                  打开
                </Button>
              </div>
            ))}
          </div>
        )}
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
  /**
   * 分组（用户反馈"菜单项太多"，所以分两列显示）。
   * 取舍：**不做折叠/二级菜单**（galgame 卡片是高频操作，多一次点击很难受），
   * 改成"常用"与"工具"两列并排 —— 常用列是启动/查详情/截图这类天天点的，
   * 工具列是解包/立绘/CG/自定义封面这类偶尔用的；两列都在一屏内、点一下到底。
   */
  group?: '常用' | '工具'
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
  // 两列布局：按 group 分组；没标 group 的按原来的单列顺序跟着"常用"走
  const usual = items.filter((i) => (i.group ?? '常用') === '常用')
  const tools = items.filter((i) => i.group === '工具')
  const renderItem = (it: GalMenuItem): ReactNode => {
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
  }
  return (
    <div
      className="fixed z-[70] max-h-[calc(100vh-16px)] overflow-y-auto rounded-xl border border-border bg-elev1 py-1 shadow-2xl"
      style={{ left: menu.x, top: menu.y, width: tools.length ? 452 : 216 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {tools.length ? (
        <div className="flex">
          <div className="w-[216px] border-r border-border">
            <div className="px-3.5 pb-1 pt-1.5 text-[10px] font-medium text-faint">常用</div>
            {usual.map(renderItem)}
          </div>
          <div className="w-[236px]">
            <div className="px-3.5 pb-1 pt-1.5 text-[10px] font-medium text-faint">工具</div>
            {tools.map(renderItem)}
          </div>
        </div>
      ) : (
        usual.map(renderItem)
      )}
    </div>
  )
}

/** 卡片右下角的相机按钮图标（游戏卡片上的「最近截图」入口） */
export const ShotsIcon = Camera


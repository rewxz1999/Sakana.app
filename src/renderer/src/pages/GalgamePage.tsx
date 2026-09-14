import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Camera,
  CircleCheck,
  Clock,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  Image as ImageIcon,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X
} from 'lucide-react'
import type { GalGame, GalRecentShot, YmgalCandidate } from '@shared/types'
import { useGal } from '@/stores/galgame'
import { toast } from '@/stores/app'
import { api } from '@/lib/api'
import { imgUrl, localImgUrl, timeAgo } from '@/lib/format'
import { Badge, Button, ConfirmModal, Input, Modal, Spinner } from '@/components/ui'

/** 游玩时长展示：Xh Ym / Ym Zs / Zs */
function fmtPlay(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const z = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${z}s`
  return `${z}s`
}

function coverIsLocal(cover: string | undefined): boolean {
  if (!cover) return false
  return /^[a-zA-Z]:[\\/]/.test(cover) || cover.startsWith('/') || cover.startsWith('\\\\')
}

function segCls(active: boolean): string {
  return `rounded-md px-3 py-1 text-xs font-medium transition-colors ${
    active ? 'bg-elev3 text-text' : 'text-dim hover:text-text'
  } disabled:pointer-events-none disabled:opacity-40`
}

/** 从最近截图第一条路径推断所在目录（用于「打开文件夹」） */
function shotDir(shots: GalRecentShot[]): string {
  const p = shots[0]?.path
  if (!p) return ''
  const m = /^(.+)[\\/][^\\/]+$/.exec(p)
  return m ? m[1] : p
}

export function GalgamePage() {
  const { games, running, importing, load, startLive, importGame, removeGame, toggleFinished, launch } = useGal()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<GalGame | null>(null)
  const [detailTab, setDetailTab] = useState<'ymgal' | 'vndb'>('vndb')
  const [updatingDetail, setUpdatingDetail] = useState(false)
  const [removing, setRemoving] = useState<GalGame | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; game: GalGame } | null>(null)
  const [ymgalSearch, setYmgalSearch] = useState<{ game: GalGame } | null>(null)
  const [ymgalKeyword, setYmgalKeyword] = useState('')
  const [ymgalCandidates, setYmgalCandidates] = useState<YmgalCandidate[] | null>(null)
  const [ymgalSearching, setYmgalSearching] = useState(false)
  const [ymgalApplying, setYmgalApplying] = useState<string | null>(null)
  const [shotsOpen, setShotsOpen] = useState(false)
  const [shots, setShots] = useState<GalRecentShot[]>([])
  const [shotsLoading, setShotsLoading] = useState(false)
  const [lightbox, setLightbox] = useState<GalRecentShot | null>(null)
  const [bgFailed, setBgFailed] = useState(false)
  // 空态背景：复用「导航栏背景」里用户自己设置的图片（未设置时为空串）
  const [navBgPath, setNavBgPath] = useState('')
  const [navBgFailed, setNavBgFailed] = useState(false)
  const stripRef = useRef<HTMLDivElement>(null)
  const dragState = useRef({ active: false, startX: 0, scrollLeft: 0, moved: false })

  const finishedCount = useMemo(() => games.filter((g) => g.finished).length, [games])

  // 当前选中的游戏（背景/信息区使用）；无选中时回退到第一款游戏
  const selectedGame = useMemo(() => games.find((g) => g.id === selectedId) ?? null, [games, selectedId])
  const bgGame = selectedGame ?? games[0] ?? null
  // 背景优先：用户自定义 > VNDB 横版截图（16:9 高清）> 月幕横/竖图 > 竖封面
  const bgShot = bgGame?.customBanner || bgGame?.banner
  const bgCover = bgGame?.ymgal?.banner || bgGame?.ymgal?.cover || bgGame?.cover
  const bgUrl = bgShot ? coverSrcFor(bgShot) : bgCover ? coverSrcFor(bgCover) : ''
  /** 横版截图可整屏铺满且清晰；竖封面才需要模糊垫底 + 完整显示 */
  const bgIsLandscape = !!bgGame?.customBanner || !!bgGame?.banner

  // 详情抽屉始终展示 store 中最新的游戏对象（保证游玩时长/评分等实时刷新）
  const detailGame = detail ? (games.find((g) => g.id === detail.id) ?? detail) : null
  const detailRunning = detailGame ? !!running[detailGame.id] : false

  useEffect(() => {
    void load()
    return startLive()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 进页面读一次自定义导航栏背景图，供「没有导入 galgame」的空态当背景用
  useEffect(() => {
    let alive = true
    void api.navBg.get().then((r) => {
      if (alive && r.ok) setNavBgPath(r.data.path)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    setBgFailed(false)
  }, [bgUrl])

  // 空态背景图同样走 sakana-img 协议（主进程白名单 + 磁盘缓存），失败则回落纯色渐变
  const navBgUrl = navBgPath ? localImgUrl(navBgPath) : ''

  // 底部封面条：竖向滚轮 → 横向滚动（原生非 passive 监听才能 preventDefault）
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY
        e.preventDefault()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [games.length])

  // 右键菜单：点击任意处 / Esc 关闭
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
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
  }, [menu])

  const onImport = useCallback(async () => {
    await importGame()
  }, [importGame])

  const onLaunch = useCallback(
    async (game: GalGame) => {
      await launch(game.id)
    },
    [launch]
  )

  /** 选择本地图片作为自定义封面 / 背景图 */
  const setCustom = useCallback(
    async (game: GalGame, kind: 'cover' | 'banner') => {
      const pick = await api.gal.pickImage()
      if (!pick.ok) {
        toast.error(pick.error)
        return
      }
      if (!pick.data) return
      const r = await api.gal.setCustomImage(game.id, kind, pick.data)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      toast.success(kind === 'cover' ? '已设置自定义封面' : '已设置自定义背景图')
      await load()
    },
    [load]
  )

  /** 恢复数据源图片 */
  const clearCustom = useCallback(
    async (game: GalGame) => {
      const a = await api.gal.clearCustomImage(game.id, 'cover')
      if (!a.ok) {
        toast.error(a.error)
        return
      }
      const b = await api.gal.clearCustomImage(game.id, 'banner')
      if (!b.ok) {
        toast.error(b.error)
        return
      }
      toast.success('已恢复数据源图片')
      await load()
    },
    [load]
  )

  const onMenu = (e: React.MouseEvent, game: GalGame): void => {
    e.preventDefault()
    e.stopPropagation()
    // 菜单尺寸按最大条目数估算，超界时向内收，保证完全落在窗口内
    const MENU_W = 200
    const MENU_H = 300
    const pad = 8
    const maxX = Math.max(pad, window.innerWidth - MENU_W - pad)
    const maxY = Math.max(pad, window.innerHeight - MENU_H - pad)
    setMenu({
      x: Math.min(Math.max(pad, e.clientX), maxX),
      y: Math.min(Math.max(pad, e.clientY), maxY),
      game
    })
  }

  const openDetail = (game: GalGame): void => {
    setDetail(game)
    setDetailTab(game.ymgal ? 'ymgal' : 'vndb')
  }

  /** 封面点击：首次选中（切换背景），再次点击已选中项打开详情抽屉 */
  const onCoverClick = (game: GalGame): void => {
    if (dragState.current.moved) {
      dragState.current.moved = false
      return
    }
    if (selectedId === game.id) {
      openDetail(game)
    } else {
      setSelectedId(game.id)
      // 抽屉已打开时保持打开并更新内容
      if (detail) openDetail(game)
    }
  }

  const onStripPointerDown = (e: React.PointerEvent): void => {
    const el = stripRef.current
    if (!el) return
    dragState.current = { active: true, startX: e.clientX, scrollLeft: el.scrollLeft, moved: false }
  }
  const onStripPointerMove = (e: React.PointerEvent): void => {
    const d = dragState.current
    const el = stripRef.current
    if (!d.active || !el) return
    const dx = e.clientX - d.startX
    if (Math.abs(dx) > 4) d.moved = true
    el.scrollLeft = d.scrollLeft - dx
  }
  const onStripPointerUp = (): void => {
    dragState.current.active = false
  }

  const onUpdateDetail = async (): Promise<void> => {
    if (!detail) return
    setUpdatingDetail(true)
    const r = await api.gal.updateDetail(detail.id)
    setUpdatingDetail(false)
    if (r.ok) {
      setDetail(r.data)
      toast.success('详情已更新')
    } else {
      toast.error(r.error)
    }
  }

  const doYmgalSearch = async (): Promise<void> => {
    const kw = ymgalKeyword.trim()
    if (!kw) return
    setYmgalSearching(true)
    const r = await api.gal.searchYmgal(kw)
    setYmgalSearching(false)
    if (r.ok) {
      setYmgalCandidates(r.data)
      if (r.data.length === 0) toast.warn('月幕未找到该游戏')
    } else {
      toast.error(r.error)
      setYmgalCandidates([])
    }
  }

  const doApplyYmgal = async (c: YmgalCandidate): Promise<void> => {
    if (!ymgalSearch) return
    setYmgalApplying(String(c.id))
    const r = await api.gal.applyYmgal(ymgalSearch.game.id, c.id)
    setYmgalApplying(null)
    if (r.ok) {
      toast.success('已从月幕导入详情')
      setYmgalSearch(null)
      setDetail((d) => (d && d.id === r.data.id ? r.data : d))
    } else {
      toast.error(r.error)
    }
  }

  const loadShots = useCallback(async (): Promise<void> => {
    setShotsLoading(true)
    const r = await api.gal.recentShots()
    setShotsLoading(false)
    if (r.ok) setShots(r.data)
    else toast.error(r.error)
  }, [])

  const openShots = (): void => {
    setShotsOpen(true)
    void loadShots()
  }

  const openShotFolder = async (): Promise<void> => {
    const dir = shotDir(shots)
    if (!dir) return
    const r = await api.app.openPath(dir)
    if (!r.ok) toast.error(r.error)
  }

  return (
    <div className="relative h-full overflow-hidden">
      {/* 背景层：横版高清截图直接整屏铺满（清晰）；竖封面才用模糊垫底 + 完整显示 */}
      <div className="absolute inset-0">
        {bgUrl && !bgFailed ? (
          bgIsLandscape ? (
            <img
              src={bgUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              onError={() => setBgFailed(true)}
            />
          ) : (
            <>
              <img
                src={bgUrl}
                alt=""
                aria-hidden
                className="absolute inset-0 h-full w-full scale-110 object-cover blur-2xl"
                onError={() => setBgFailed(true)}
              />
              <img
                src={bgUrl}
                alt=""
                className="absolute inset-0 h-full w-full object-contain"
                onError={() => setBgFailed(true)}
              />
            </>
          )
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-[#1b2233] via-[#16121f] to-[#0d0a12]" />
        )}
        {/* 暗色渐变：保证文字可读 */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/45 to-black/25" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/45" />
      </div>

      {/* 内容层 */}
      <div className="relative z-10 flex h-full flex-col">
        {/* 头部 */}
        <div className="flex shrink-0 items-start justify-between gap-3 px-6 pt-5">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-white drop-shadow">Galgame 导航</h1>
              <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur">快捷启动器</span>
            </div>
            <p className="mt-1 text-xs text-white/80 drop-shadow">
              已添加 {games.length} 款游戏 · 已玩完 {finishedCount}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={openShots}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-white/25 bg-white/10 px-3.5 text-sm font-medium text-white backdrop-blur transition-colors hover:bg-white/20"
            >
              <Camera size={15} /> 最近截图
            </button>
            <Button icon={FolderPlus} loading={importing} onClick={() => void onImport()}>
              导入 galgame
            </Button>
          </div>
        </div>

        {/* 中部：选中游戏信息 / 空状态 */}
        <div className="flex min-h-0 flex-1 items-end px-6 pb-4">
          {games.length === 0 ? (
            /* 空态：用用户自定义的导航栏背景图铺满整块区域代替纯色背景
               （父容器 items-end，用 self-stretch 让这块区域撑满中部空间，背景图才真的铺满） */
            <div className="relative flex w-full flex-1 self-stretch items-center justify-center overflow-hidden rounded-2xl">
              {navBgUrl && !navBgFailed ? (
                <img
                  src={navBgUrl}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={() => setNavBgFailed(true)}
                />
              ) : (
                /* 未设置背景图 / 图片加载失败：回落到原有纯色渐变，不报错、不白屏 */
                <div className="absolute inset-0 bg-gradient-to-br from-[#1b2233] via-[#16121f] to-[#0d0a12]" />
              )}
              {/*
                半透明遮罩保证文案可读。这里用主题 bg token：默认「白蓝」浅色主题下 bg-bg 是浅色薄纱，
                因此文字改用 text/dim token 而不是白色，深色主题下同样成立。
              */}
              <div className="absolute inset-0 bg-bg/70" />
              <div className="relative z-10 flex flex-col items-center gap-2 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-elev2 text-faint">
                  <Gamepad2 size={24} />
                </div>
                <div className="text-sm font-medium text-text">还没有导入 galgame</div>
                <div className="max-w-sm text-xs leading-relaxed text-dim">
                  点击「导入 galgame」选择游戏主程序（.exe）。应用会扫描游戏文件夹并尝试从 VNDB 与月幕Galgame 获取封面、评分与简介。
                </div>
                <div className="mt-2">
                  <Button icon={FolderPlus} loading={importing} onClick={() => void onImport()}>
                    导入第一个游戏
                  </Button>
                </div>
              </div>
            </div>
          ) : selectedGame ? (
            <div className="max-w-xl">
              <div className="text-2xl font-bold text-white drop-shadow-lg">{selectedGame.title}</div>
              {selectedGame.titleCn && selectedGame.titleCn !== selectedGame.title ? (
                <div className="mt-1 text-sm text-white/70 drop-shadow">{selectedGame.titleCn}</div>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/60">
                {selectedGame.rating ? (
                  <span className="flex items-center gap-0.5 text-amber-300">
                    <Star size={11} fill="currentColor" /> {selectedGame.rating.toFixed(1)}
                  </span>
                ) : null}
                {selectedGame.released ? <span>{selectedGame.released}</span> : null}
                {selectedGame.playtimeSec > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    <Clock size={11} /> {fmtPlay(selectedGame.playtimeSec)}
                  </span>
                ) : null}
                {selectedGame.finished ? (
                  <span className="inline-flex items-center gap-1 text-emerald-300">
                    <CircleCheck size={11} /> 玩完
                  </span>
                ) : null}
              </div>
              <div className="mt-3 text-[11px] text-white/40">点击封面切换背景 · 再次点击已选中封面查看详情</div>
            </div>
          ) : null}
        </div>

        {/* 底部封面条 */}
        {games.length > 0 ? (
          <div className="shrink-0 pb-4 pt-2">
            <div
              ref={stripRef}
              onPointerDown={onStripPointerDown}
              onPointerMove={onStripPointerMove}
              onPointerUp={onStripPointerUp}
              onPointerLeave={onStripPointerUp}
              className="flex gap-3 overflow-x-auto scroll-smooth px-6 py-2 [scrollbar-width:thin] [touch-action:pan-y]"
            >
              {games.map((game) => {
                const isSel = game.id === selectedId
                const isRunning = !!running[game.id]
                return (
                  <button
                    key={game.id}
                    title={game.title}
                    onClick={() => onCoverClick(game)}
                    onContextMenu={(e) => onMenu(e, game)}
                    className={`group relative h-[150px] w-[110px] shrink-0 overflow-hidden rounded-lg transition-transform duration-150 hover:scale-105 ${
                      isSel ? 'ring-2 ring-accent' : 'ring-1 ring-white/25 hover:ring-white/60'
                    }`}
                  >
                    <Cover src={game.customCover || game.cover} objectFit="object-cover" className="h-full w-full" />
                    {isRunning ? (
                      <span className="absolute right-1 top-1 inline-flex items-center gap-1 rounded-full bg-black/60 px-1 py-0.5">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
                        </span>
                      </span>
                    ) : null}
                    {game.finished ? (
                      <span className="absolute left-1 top-1 rounded-full bg-black/60 p-0.5 text-ok">
                        <CircleCheck size={12} />
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>

      {/* 右侧详情抽屉 */}
      {detailGame ? (
        <motion.div
          initial={{ x: 420 }}
          animate={{ x: 0 }}
          transition={{ type: 'spring', duration: 0.32 }}
          className="absolute right-0 top-0 z-40 flex h-full w-full max-w-[420px] flex-col border-l border-border bg-elev1/95 shadow-2xl backdrop-blur-xl"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <div className="text-sm font-semibold">游戏详情</div>
            <button
              onClick={() => setDetail(null)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-dim transition-colors hover:bg-elev2 hover:text-text"
              title="关闭"
            >
              <X size={15} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {/* 竖封面 + 标题 + 操作 */}
            <div className="flex gap-4">
              <Cover src={detailGame.customCover || detailGame.cover} objectFit="object-cover" className="h-44 w-[120px] shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1">
                <div className="text-base font-bold leading-snug">{detailGame.title}</div>
                {detailGame.titleCn && detailGame.titleCn !== detailGame.title ? (
                  <div className="mt-0.5 text-xs text-dim">{detailGame.titleCn}</div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {detailRunning ? <Badge tone="ok">运行中</Badge> : null}
                  {detailGame.finished ? (
                    <Badge tone="ok">
                      <CircleCheck size={9} /> 玩完
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-2 text-[11px] text-dim">
                  {detailGame.playtimeSec > 0 ? (
                    <span className="inline-flex items-center gap-1">
                      <Clock size={11} /> 已游玩 {fmtPlay(detailGame.playtimeSec)}
                    </span>
                  ) : (
                    <span>未游玩</span>
                  )}
                </div>
                {detailGame.lastRouteInfo ? (
                  <div className="mt-1.5 whitespace-pre-wrap break-all rounded-md bg-elev2/60 px-2 py-1 text-[10px] leading-relaxed text-faint">
                    进度：{detailGame.lastRouteInfo}
                  </div>
                ) : null}
                <Button className="mt-3 w-full" icon={Play} loading={detailRunning} onClick={() => void onLaunch(detailGame)}>
                  {detailRunning ? '游戏中' : '开始游戏'}
                </Button>
              </div>
            </div>

            {/* 评分 / 发售 / 长度 / 开发 / 标签 */}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
              {detailGame.rating ? (
                <span className="flex items-center gap-0.5 text-warn">
                  <Star size={11} fill="currentColor" /> {detailGame.rating.toFixed(1)}
                </span>
              ) : null}
              {detailGame.released ? <span>发售：{detailGame.released}</span> : null}
              {detailGame.length ? <span>长度：{detailGame.length}</span> : null}
            </div>
            {detailGame.developers && detailGame.developers.length > 0 ? (
              <div className="mt-1 text-[11px] text-dim">开发：{detailGame.developers.join(' / ')}</div>
            ) : null}
            {detailGame.tags && detailGame.tags.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {detailGame.tags.slice(0, 8).map((t) => (
                  <Badge key={t} className="px-2 py-0.5 text-[10px]">
                    {t}
                  </Badge>
                ))}
              </div>
            ) : null}

            {/* 来源切换 */}
            <div className="mt-4 inline-flex items-center gap-1 rounded-lg bg-elev2/70 p-0.5">
              <button className={segCls(detailTab === 'ymgal')} disabled={!detailGame.ymgal} onClick={() => setDetailTab('ymgal')}>
                月幕
              </button>
              <button className={segCls(detailTab === 'vndb')} onClick={() => setDetailTab('vndb')}>
                VNDB
              </button>
            </div>
            <div className="mt-3">{detailTab === 'ymgal' ? <YmgalTab game={detailGame} /> : <VndbTab game={detailGame} />}</div>

            {/* 底部操作 */}
            <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
              <Button
                variant="ghost"
                size="sm"
                icon={Search}
                onClick={() => {
                  setYmgalSearch({ game: detailGame })
                  setYmgalKeyword(detailGame.titleCn || detailGame.title)
                  setYmgalCandidates(null)
                  setYmgalApplying(null)
                }}
              >
                从月幕搜索详情
              </Button>
              <Button size="sm" variant="outline" loading={updatingDetail} onClick={() => void onUpdateDetail()}>
                更新详情
              </Button>
            </div>
          </div>
        </motion.div>
      ) : null}

      {/* 右键菜单 */}
      {menu ? (
        <div
          className="fixed z-[70] max-h-[calc(100vh-16px)] w-48 overflow-y-auto rounded-xl border border-border bg-elev1 py-1 shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs hover:bg-elev2"
            onClick={() => {
              const g = menu.game
              setMenu(null)
              setYmgalSearch({ game: g })
              setYmgalKeyword(g.titleCn || g.title)
              setYmgalCandidates(null)
              setYmgalApplying(null)
            }}
          >
            <Search size={13} /> 从月幕galgame中搜索详情
          </button>
          <button
            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs hover:bg-elev2"
            onClick={() => {
              const g = menu.game
              setMenu(null)
              void setCustom(g, 'cover')
            }}
          >
            <ImageIcon size={13} /> 自定义游戏封面
          </button>
          <button
            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs hover:bg-elev2"
            onClick={() => {
              const g = menu.game
              setMenu(null)
              void setCustom(g, 'banner')
            }}
          >
            <ImageIcon size={13} /> 自定义背景图
          </button>
          {menu.game.customCover || menu.game.customBanner ? (
            <button
              className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs text-dim hover:bg-elev2"
              onClick={() => {
                const g = menu.game
                setMenu(null)
                void clearCustom(g)
              }}
            >
              <RotateCcw size={13} /> 恢复数据源图片
            </button>
          ) : null}
          <button
            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs hover:bg-elev2"
            onClick={() => {
              const g = menu.game
              setMenu(null)
              void toggleFinished(g.id)
            }}
          >
            {menu.game.finished ? <X size={13} /> : <CircleCheck size={13} />}
            {menu.game.finished ? '取消标记玩完' : '标记玩完'}
          </button>
          <button
            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs text-danger hover:bg-danger/10"
            onClick={() => {
              const g = menu.game
              setMenu(null)
              setRemoving(g)
            }}
          >
            <Trash2 size={13} /> 删除启动方式
          </button>
        </div>
      ) : null}

      {/* 月幕搜索弹窗 */}
      <Modal open={!!ymgalSearch} onClose={() => setYmgalSearch(null)} title="从月幕galgame中搜索详情" width={520}>
        {ymgalSearch ? (
          <div>
            <div className="flex gap-2">
              <Input
                value={ymgalKeyword}
                onChange={(e) => setYmgalKeyword(e.target.value)}
                placeholder="输入游戏名，如 千恋万花"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doYmgalSearch()
                }}
              />
              <Button loading={ymgalSearching} onClick={() => void doYmgalSearch()}>
                搜索
              </Button>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {ymgalCandidates === null ? (
                <div className="py-6 text-center text-xs text-faint">输入关键词后搜索月幕 galgame 数据库</div>
              ) : ymgalCandidates.length === 0 ? (
                <div className="py-6 text-center text-xs text-faint">月幕未找到该游戏</div>
              ) : (
                ymgalCandidates.map((c) => (
                  <button
                    key={c.id}
                    className="flex items-center gap-3 rounded-lg border border-border bg-elev2/40 p-2 text-left transition-colors hover:bg-elev2"
                    onClick={() => void doApplyYmgal(c)}
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
                    {ymgalApplying === String(c.id) ? <Spinner size={14} /> : null}
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}
      </Modal>

      {/* 最近截图面板 */}
      <Modal open={shotsOpen} onClose={() => setShotsOpen(false)} title="最近截图" width={720}>
        <div>
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-[11px] text-faint">{shots.length > 0 ? `${shots.length} 张截图` : '暂无截图'}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" icon={FolderOpen} disabled={shots.length === 0} onClick={() => void openShotFolder()}>
                打开文件夹
              </Button>
              <Button variant="ghost" size="sm" icon={RefreshCw} loading={shotsLoading} onClick={() => void loadShots()}>
                刷新
              </Button>
            </div>
          </div>
          {shots.length === 0 && !shotsLoading ? (
            <div className="py-10 text-center text-xs text-faint">
              截图目录暂无图片。使用截图助手（随游戏启动）或「试截一张」生成截图。
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

      {/* 截图大图 lightbox */}
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

      {/* 删除确认 */}
      <ConfirmModal
        open={!!removing}
        title="删除启动方式"
        message="仅删除启动方式与游玩记录，不会删除游戏文件本身。确定删除？"
        danger
        confirmText="删除"
        onConfirm={() => {
          if (removing) void removeGame(removing.id)
          setRemoving(null)
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  )
}

/** 月幕详情标签页 */
function YmgalTab({ game }: { game: GalGame }) {
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
          {game.title && game.title !== y.title ? (
            <div className="mt-0.5 text-xs text-dim">{game.title}</div>
          ) : null}
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
                window.open(y.url as string, '_blank')
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
          <div className="grid grid-cols-4 gap-2">
            {y.characters.map((c, i) => (
              <div key={`${c.name}-${i}`} className="flex flex-col overflow-hidden rounded-lg border border-border bg-elev2/60">
                {c.image ? (
                  <img
                    src={coverSrcFor(c.image)}
                    alt={c.nameCn || c.name}
                    loading="lazy"
                    className="h-20 w-full bg-elev3 object-cover"
                    onError={(e) => {
                      ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                    }}
                  />
                ) : (
                  <div className="h-20 w-full bg-elev3" />
                )}
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
function VndbTab({ game }: { game: GalGame }) {
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
          {game.titleCn && game.titleCn !== game.title ? (
            <div className="mt-0.5 text-sm text-dim">{game.titleCn}</div>
          ) : null}
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
            <span>本地：{game.folder}</span>
          </div>
          {game.vndbId ? (
            <a
              className="mt-2 inline-flex cursor-pointer items-center gap-1 text-[11px] text-accent hover:underline"
              onClick={(e) => {
                e.preventDefault()
                window.open(`https://vndb.org/v${game.vndbId}`, '_blank')
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

/** 封面组件：本地路径走 localImgUrl，远程地址走 imgUrl（sakana-img 协议代理） */
function Cover({
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
      onError={() => {
        setFailed(true)
        toast.warn('封面加载失败')
      }}
      className={`select-none ${objectFit} ${className ?? ''}`}
    />
  )
}

function coverSrcFor(cover: string): string {
  return coverIsLocal(cover) ? localImgUrl(cover) : imgUrl(cover)
}

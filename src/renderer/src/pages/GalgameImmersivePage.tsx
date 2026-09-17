import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Camera,
  CircleCheck,
  Clock,
  FolderPlus,
  Gamepad2,
  Image as ImageIcon,
  LayoutGrid,
  Play,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X
} from 'lucide-react'
import type { GalGame } from '@shared/types'
import { useGal } from '@/stores/galgame'
import { toast } from '@/stores/app'
import { api } from '@/lib/api'
import { localImgUrl } from '@/lib/format'
import { Button, ConfirmModal } from '@/components/ui'
import {
  Cover,
  fmtPlay,
  GalContextMenu,
  GalDetailView,
  GalShotsModal,
  GalYmgalSearchModal,
  coverSrcFor,
  menuPosition,
  useMenuDismiss,
  type GalMenuState,
  type GalMenuItem
} from './galgameShared'
/** v0.2.8：没有导入任何 galgame 时的默认背景插画 */
import galgameDefaultBg from '@/assets/galgame-default.png'

/**
 * galgame 沉浸模式（原「galgame 导航」的整屏壁纸布局，用户要求原样保留）。
 *
 * 由 GalgameLibraryPage 以「沉浸模式」按钮挂载；这里的「返回库」按钮 / Esc 只是
 * 回到卡片库，不改动原有能力：底部封面条、快捷启动、自定义背景图、最近截图、详情抽屉都还在。
 */
export function GalgameImmersivePage({ onBack }: { onBack: () => void }) {
  const { games, running, importing, load, startLive, importGame, removeGame, toggleFinished, launch } = useGal()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<GalGame | null>(null)
  const [menu, setMenu] = useState<GalMenuState | null>(null)
  const [ymgalGame, setYmgalGame] = useState<GalGame | null>(null)
  const [shotsOpen, setShotsOpen] = useState(false)
  const [shotsGame, setShotsGame] = useState<GalGame | null>(null)
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

  // 详情抽屉始终展示 store 中最新的游戏对象（保证游玩时长/评分等实时刷新）
  const detailGame = detailId ? (games.find((g) => g.id === detailId) ?? null) : null
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
  const emptyBg = navBgUrl || galgameDefaultBg

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

  useMenuDismiss(!!menu, useCallback(() => setMenu(null), []))

  /**
   * Esc 返回卡片库。
   * 只有在「没有开右键菜单、没有弹窗、没有抽屉」时才响应，避免按 Esc 关弹窗的同时被踢回库。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (menu || ymgalGame || shotsOpen || shotsGame || removing || detailGame) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, ymgalGame, shotsOpen, shotsGame, removing, detailGame, onBack])

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
    setMenu({ ...menuPosition(e), game })
  }

  /** 封面点击：首次选中（切换背景），再次点击已选中项打开详情抽屉 */
  const onCoverClick = (game: GalGame): void => {
    if (dragState.current.moved) {
      dragState.current.moved = false
      return
    }
    if (selectedId === game.id) {
      setDetailId(game.id)
    } else {
      setSelectedId(game.id)
      if (detailId) setDetailId(game.id)
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

  const menuItems = (): GalMenuItem[] => {
    const g = menu?.game
    if (!g) return []
    const items: GalMenuItem[] = [
      { key: 'launch', icon: Play, label: running[g.id] ? '游戏中' : '启动游戏', onSelect: () => void onLaunch(g) },
      {
        key: 'ymgal',
        icon: Search,
        label: '从月幕galgame中搜索详情',
        onSelect: () => setYmgalGame(g)
      },
      { key: 'cover', icon: ImageIcon, label: '自定义游戏封面', onSelect: () => void setCustom(g, 'cover') },
      // 沉浸模式保留「自定义背景图」：整屏壁纸就是这张图，卡片库那边的右键菜单才去掉它
      { key: 'banner', icon: ImageIcon, label: '自定义背景图', onSelect: () => void setCustom(g, 'banner') }
    ]
    if (g.customCover || g.customBanner) {
      items.push({ key: 'clear', icon: RotateCcw, label: '恢复数据源图片', onSelect: () => void clearCustom(g) })
    }
    items.push(
      { key: 'shots', icon: Camera, label: '最近截图', onSelect: () => setShotsGame(g) },
      {
        key: 'finish',
        icon: g.finished ? X : CircleCheck,
        label: g.finished ? '取消标记玩完' : '标记玩完',
        onSelect: () => void toggleFinished(g.id)
      },
      { key: 'remove', icon: Trash2, label: '删除启动方式', danger: true, onSelect: () => setRemoving(g) }
    )
    return items
  }

  return (
    <div className="relative h-full overflow-hidden">
      {/*
        背景层（v0.2.9 重做，用户反馈「背景页还是有黑边」）：

        旧实现把「竖版封面」走成 模糊垫底 + object-contain 完整显示 ——
        竖图居中后左右两侧就是靠模糊层填的，而模糊层又被两层重黑渐变压暗，
        看上去就是**两条黑边**（这也是用户反复说不好看的原因）。

        现在只有一条规则：**背景永远 object-cover 铺满整屏，绝不 contain、绝不留边**。
        竖版封面铺满时会横向裁切，所以把取景位置抬到偏上（center 30%），
        更容易落在人物/主视觉上，而不是画面正中的空白处。
        暗色渐变也相应调轻：够保证文字可读，但不再把背景压成一片黑。
      */}
      <div className="absolute inset-0">
        {bgUrl && !bgFailed ? (
          <img
            src={bgUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{ objectPosition: 'center 30%' }}
            onError={() => setBgFailed(true)}
          />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-[#1b2233] via-[#16121f] to-[#0d0a12]" />
        )}
        {/* 暗色渐变：左侧重（信息区在左边）、右侧几乎透明，让背景图透出来 */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/75 via-black/30 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/20" />
      </div>

      {/* 内容层 */}
      <div className="relative z-10 flex h-full flex-col">
        {/* 头部 */}
        <div className="flex shrink-0 items-start justify-between gap-3 px-6 pt-5">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-white drop-shadow">Galgame 库</h1>
              <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur">
                沉浸模式
              </span>
            </div>
            <p className="mt-1 text-xs text-white/80 drop-shadow">
              已添加 {games.length} 款游戏 · 已玩完 {finishedCount} · 点击封面切换背景，再点一次看详情
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onBack}
              title="返回卡片库（Esc）"
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-white/25 bg-white/10 px-3.5 text-sm font-medium text-white backdrop-blur transition-colors hover:bg-white/20"
            >
              <LayoutGrid size={15} /> 返回库
            </button>
            <button
              onClick={() => setShotsOpen(true)}
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
              {emptyBg && !navBgFailed ? (
                <img
                  src={emptyBg}
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
                <div className="mt-2 flex gap-2">
                  <Button icon={FolderPlus} loading={importing} onClick={() => void onImport()}>
                    导入第一个游戏
                  </Button>
                  <Button variant="outline" icon={LayoutGrid} onClick={onBack}>
                    返回卡片库
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
              onClick={() => setDetailId(null)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-dim transition-colors hover:bg-elev2 hover:text-text"
              title="关闭"
            >
              <X size={15} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <GalDetailView
              game={detailGame}
              running={detailRunning}
              onLaunch={(g) => void onLaunch(g)}
              onReload={load}
              onYmgalSearch={(g) => setYmgalGame(g)}
            />
          </div>
        </motion.div>
      ) : null}

      {/* 右键菜单 */}
      <GalContextMenu menu={menu} items={menuItems()} />

      {/* 月幕搜索弹窗 */}
      <GalYmgalSearchModal game={ymgalGame} onClose={() => setYmgalGame(null)} onApplied={load} />

      {/* 最近截图：顶栏按钮看全部，右键菜单里的那一项只看该游戏自己的目录 */}
      <GalShotsModal open={shotsOpen} onClose={() => setShotsOpen(false)} />
      <GalShotsModal open={!!shotsGame} game={shotsGame} onClose={() => setShotsGame(null)} />

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

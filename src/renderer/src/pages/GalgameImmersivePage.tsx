import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Camera,
  CircleCheck,
  Clock,
  Ellipsis,
  FolderPlus,
  Gamepad2,
  Image as ImageIcon,
  LayoutGrid,
  Minimize2,
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
import { useShell } from '@/stores/shell'
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
 *
 * v0.3.0 起按用户要求「更沉浸」，额外做了四件事：
 * 1. **铺满整窗**：挂载时通过 stores/shell.ts 让外壳（App.tsx）收起左侧导航栏，
 *    本页的 absolute inset-0 壁纸于是连原来导航栏那一列一起铺满；
 *    TitleBar 保留 —— 它承载窗口拖动/最小化/关闭，藏掉就真成了「出不去」。
 * 2. **隐藏常驻按钮**：返回库 / 导入 galgame / 最近截图不再常驻，收进左下角小圆点的弹出层。
 * 3. **弹出层**：点小按钮开合，点别处或 Esc 关闭，选中任一项即执行并收起。
 * 4. **退出按钮优先级极高**：右上角 z-[999]（高于应用里所有浮层），Esc 也能退出，
 *    保证任何情况下都不会卡在沉浸模式里出不来。
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
  /** 左下角小按钮的弹出层：沉浸模式下被隐藏的那三个按钮都收在这里 */
  const [overflowOpen, setOverflowOpen] = useState(false)
  /**
   * 窗口是否足够宽（详情抽屉打开时退出按钮要挪到抽屉左边）。
   * 抽屉固定 max-w-[420px]，窗口窄到一定程度后「挪到左边」会把按钮挤到屏幕外，
   * 所以这里跟着窗口宽度走，窄窗口就老老实实贴右边。
   */
  const [wideEnough, setWideEnough] = useState(() => window.innerWidth >= 760)
  const stripRef = useRef<HTMLDivElement>(null)
  /** 包住「小按钮 + 弹出层」的容器：ref 判包含用来决定「点了别处才关」 */
  const overflowRef = useRef<HTMLDivElement>(null)
  const dragState = useRef({ active: false, startX: 0, scrollLeft: 0, moved: false })
  const setImmersive = useShell((s) => s.setImmersive)

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

  useEffect(() => {
    setBgFailed(false)
  }, [bgUrl])

  /** 空态背景图：只用内置默认背景（`galgameDefaultBg`），想换图直接替换 resources 里的默认图 */
  const emptyBg = galgameDefaultBg

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

  /*
   * 通知外壳：进入沉浸模式 → 隐藏左侧导航栏；本页卸载（返回库 / Esc / 路由跳走）立即恢复。
   * 用 effect 而不是在事件回调里写：这样「页面还在不在」与「导航栏隐不隐藏」永远一致，
   * 即便以后加了别的离开路径（比如详情页跳转），也不会留下一屏没有导航栏的界面。
   */
  useEffect(() => {
    setImmersive(true)
    return () => setImmersive(false)
  }, [setImmersive])

  // 退出按钮避让详情抽屉要用到窗口宽度（抽屉是固定宽度，窄窗口下不让位）
  useEffect(() => {
    const onResize = (): void => setWideEnough(window.innerWidth >= 760)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /*
   * 左下角弹出层：点「小按钮 / 弹出层」以外的地方，或按 Esc 关闭。
   *
   * 为什么不直接用 useMenuDismiss：它在 window 上监听 click 并**一律关闭**，
   * 而「点小按钮打开」也是一次 click —— 同一次点击里 onClick 先改变状态、接着冒泡到 window
   * 触发刚注册的关闭回调，结果就是「刚打开就被自己关掉」。
   * 这里改成 mousedown + ref 判包含（SearchPage 的搜索历史下拉也是这么修的），
   * mousedown 永远早于 click，打开那一下不会自相残杀。
   */
  useEffect(() => {
    if (!overflowOpen) return
    const onDown = (e: MouseEvent): void => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOverflowOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [overflowOpen])

  /**
   * Esc 返回卡片库。
   * 只有在「没有开右键菜单、没有弹窗、没有抽屉、左下角弹出层也关着」时才响应，
   * 避免按 Esc 关弹窗的同时被踢回库。
   * 顺序上不会冲突：弹出层监听在 document 上、这个退出监听在 window 上，
   * Esc 冒泡先到 document 再到 window —— 于是「关弹出层的那一次 Esc」被弹出层自己吃掉，
   * 这里读到的 overflowOpen 仍是 true，不会顺手退出沉浸模式（要再按一次才退出）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (menu || ymgalGame || shotsOpen || shotsGame || removing || detailGame || overflowOpen) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, ymgalGame, shotsOpen, shotsGame, removing, detailGame, overflowOpen, onBack])

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

  /**
   * 沉浸模式下被隐藏、改由左下角小按钮弹出的三个动作。
   * 复用右键菜单的条目结构（GalMenuItem），行为与原顶部按钮**完全一致**：
   * 返回库 = onBack、导入 galgame = importGame、最近截图 = 打开全部截图弹窗。
   */
  const hiddenActions: GalMenuItem[] = [
    { key: 'back', icon: LayoutGrid, label: '返回库', onSelect: onBack },
    { key: 'import', icon: FolderPlus, label: '导入 galgame', onSelect: () => void onImport() },
    { key: 'shots', icon: Camera, label: '最近截图', onSelect: () => setShotsOpen(true) }
  ]

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
        {/*
          头部：沉浸模式下只剩标题信息。
          「返回库 / 最近截图 / 导入 galgame」三个按钮按用户要求**不常驻**，
          全部收进左下角那个小圆点按钮的弹出层（见页面末尾），整屏只留壁纸与封面条。
        */}
        <div className="shrink-0 px-6 pt-5">
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
        </div>

        {/* 中部：选中游戏信息 / 空状态 */}
        <div className="flex min-h-0 flex-1 items-end px-6 pb-4">
          {games.length === 0 ? (
            /* 空态：用内置默认背景图铺满整块区域代替纯色背景
               （父容器 items-end，用 self-stretch 让这块区域撑满中部空间，背景图才真的铺满） */
            <div className="relative flex w-full flex-1 self-stretch items-center justify-center overflow-hidden rounded-2xl">
              {emptyBg && !bgFailed ? (
                <img
                  src={emptyBg}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={() => setBgFailed(true)}
                />
              ) : (
                /* 默认背景图缺失 / 图片加载失败：回落到原有纯色渐变，不报错、不白屏 */
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
              /* pl-14：给左下角的小圆点按钮（bottom-4 left-4）让出位置，
                 否则静止时它会压在第一张封面上；右侧仍是原来的 px-6 视觉 */
              className="flex gap-3 overflow-x-auto scroll-smooth pl-14 pr-6 py-2 [scrollbar-width:thin] [touch-action:pan-y]"
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

      {/*
        左下角小圆点：沉浸模式下唯一常驻的「入口」，点开就是被隐藏的那三个按钮。
        用户原话「留一个小按钮弹出这些按钮」——所以它刻意做得小、半透明，
        不抢画面，鼠标悬停才变实。
      */}
      <div ref={overflowRef} className="absolute bottom-4 left-4 z-30">
        <button
          title="显示被隐藏的按钮：返回库 / 导入 galgame / 最近截图"
          onClick={() => setOverflowOpen((v) => !v)}
          className={`flex h-8 w-8 items-center justify-center rounded-full border border-white/25 text-white shadow-lg backdrop-blur transition-colors ${
            overflowOpen ? 'bg-white/25' : 'bg-black/45 hover:bg-black/70'
          }`}
        >
          <Ellipsis size={15} />
        </button>

        {overflowOpen ? (
          /* 弹出层浮在封面条上方：整体半透明深色，看得清也点得准，选中任一项立即关闭 */
          <div className="absolute bottom-10 left-0 w-44 overflow-hidden rounded-xl border border-white/15 bg-black/80 py-1 text-white shadow-2xl backdrop-blur">
            <div className="px-3.5 pb-1 pt-1.5 text-[10px] text-white/50">被隐藏的按钮</div>
            {hiddenActions.map((it) => {
              const Icon = it.icon
              return (
                <button
                  key={it.key}
                  onClick={() => {
                    setOverflowOpen(false)
                    it.onSelect()
                  }}
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs whitespace-nowrap hover:bg-white/10"
                >
                  <Icon size={13} /> {it.label}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      {/*
        退出沉浸：用户要求「留一个优先级极高的退出小按钮在右侧」，防止界面卡住出不来。
        z-[999] 高于应用里所有浮层（Toast 99 / 公告 95 / 截图弹窗 90 / 通用弹窗 80 /
        右键菜单 70 / 详情抽屉 40），任何情况下都能点到；Esc 同样可以退出（见上面的键盘 effect）。
        放 absolute 而不是 fixed：本页根节点本身就是铺满 main 的定位上下文，
        祖先上有 framer-motion 的 transform 时 fixed 会退化，absolute 反而更稳。
        详情抽屉占右侧 420px：抽屉打开且窗口够宽时把按钮挪到抽屉左边，
        免得和抽屉自己的「关闭 ×」叠在一起；窗口窄到挪不开就保持贴右边（层级最高，仍可点）。
      */}
      <button
        onClick={onBack}
        title="退出沉浸模式（Esc）"
        className={`absolute top-3 z-[999] flex h-8 items-center gap-1.5 rounded-full border border-white/30 bg-black/60 px-3 text-xs font-medium text-white shadow-xl backdrop-blur transition-colors hover:bg-black/85 ${
          detailGame && wideEnough ? 'right-[436px]' : 'right-3'
        }`}
      >
        <Minimize2 size={13} /> 退出沉浸
      </button>
    </div>
  )
}

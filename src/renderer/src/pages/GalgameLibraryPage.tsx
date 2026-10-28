import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Camera,
  CircleCheck,
  PackageOpen,
  Download,
  Clock,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  Image as ImageIcon,
  MonitorPlay,
  Music,
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
import { Button, ConfirmModal, EmptyState, IconButton, Input, Modal, Spinner } from '@/components/ui'
import {
  Cover,
  EngineBadge,
  fmtPlay,
  GalUnpackModal,
  GalResourcesModal,
  GalContextMenu,
  GalDetailView,
  GalShotsModal,
  GalYmgalSearchModal,
  menuPosition,
  openExternal,
  useMenuDismiss,
  type GalMenuState,
  type GalMenuItem
} from './galgameShared'
import { GalgameImmersivePage } from './GalgameImmersivePage'

/**
 * 「galgame 库」（原「galgame 导航」，用户要求改名）。
 *
 * 布局回到卡片网格（与番剧卡片一致），当前整屏壁纸那套原样搬进了「沉浸模式」：
 * 本页顶部的「沉浸模式」按钮直接挂载 GalgameImmersivePage，返回库 / Esc 回到这里。
 *
 * 页面能力：
 * - 卡片：封面 + 标题 + 运行中/已玩完/评分角标；点卡片开详情（含「启动游戏」）
 * - 卡片右上角相机按钮：只看这款游戏自己的截图目录
 * - 右键菜单：启动 / 月幕搜详情 / 设置自定义封面 / 打开游戏目录 / 最近截图 / 标记玩完 / 恢复数据源图片 / 删除
 *   （按要求去掉了「自定义背景图」——背景图只属于沉浸模式）
 * - 顶部搜索（V1.5.2）：选择资源站 → 输入名字 → 在系统浏览器打开该站的搜索页；
 *   只提供站点跳转，不做结果数量统计、不抓取站点内容。
 */
export function GalgameLibraryPage() {
  const { games, running, loaded, importing, load, startLive, importGame, removeGame, toggleFinished, launch } = useGal()
  const [immersive, setImmersive] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [menu, setMenu] = useState<GalMenuState | null>(null)
  const [shotsGame, setShotsGame] = useState<GalGame | null>(null)
  const [ymgalGame, setYmgalGame] = useState<GalGame | null>(null)
  // V1.5.2：查看最近解包资源（立绘/CG/BGM/文本，在应用内查看）
  const [resGame, setResGame] = useState<GalGame | null>(null)
  // V1.5.2：内存读取 BGM 已取消（用户要求从 galgame 助手中删除），对应两个弹窗状态一并移除
  const [unpackGame, setUnpackGame] = useState<GalGame | null>(null)
  const [removing, setRemoving] = useState<GalGame | null>(null)

  /*
   * V1.5.2：站点跳转式搜索（用户要求）。
   *
   * 以前是"输入名字 → 并行统计 7 个资源站的结果数量"，慢且容易被站点限流；
   * 用户的原话是「不需要统计结果了，自行选择站点后输入 galgame 名字再跳转」。
   * 现在只有：站点下拉（默认 GalgameX）+ 搜索框 + 「前往站点搜索」按钮。
   */
  const [keyword, setKeyword] = useState('')
  const [sites, setSites] = useState<{ key: string; name: string; host: string }[]>([])
  const [siteKey, setSiteKey] = useState('galgamex')

  // 站点清单来自主进程的同一份常量（不联网）；默认选中 GalgameX
  useEffect(() => {
    void api.gal.sites().then((r) => {
      if (r.ok && r.data.length > 0) {
        setSites(r.data)
        if (!r.data.some((s) => s.key === siteKey)) setSiteKey(r.data[0].key)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 打开选中站点的搜索页（关键词为空时打开站点搜索页本身） */
  const openSiteSearch = useCallback(
    async (raw?: string) => {
      const kw = String(raw ?? keyword).trim()
      if (!kw && raw === undefined) {
        toast.warn('请先输入 galgame 名字')
        return
      }
      const r = await api.gal.siteUrl(siteKey, kw)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      if (!r.data) {
        toast.error('这个站点暂时没有可用的搜索地址')
        return
      }
      openExternal(r.data)
    },
    [keyword, siteKey]
  )

  const finishedCount = useMemo(() => games.filter((g) => g.finished).length, [games])
  const runningCount = useMemo(() => games.filter((g) => running[g.id]).length, [games, running])
  // 详情弹窗始终取 store 里最新的对象，游玩时长/评分能实时刷新
  const detailGame = detailId ? (games.find((g) => g.id === detailId) ?? null) : null

  /**
   * 列表 + 事件订阅只在「卡片库可见」时持有：进沉浸模式后由沉浸页自己订阅，
   * 避免两个页面同时订阅把列表来回刷两遍。
   */
  useEffect(() => {
    if (immersive) return
    void load()
    return startLive()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [immersive])

  useMenuDismiss(!!menu, useCallback(() => setMenu(null), []))

  const onImport = useCallback(async () => {
    await importGame()
  }, [importGame])

  const onLaunch = useCallback(
    async (game: GalGame) => {
      await launch(game.id)
    },
    [launch]
  )

  // ---------------- 站点搜索 ----------------
  // （V1.5.2：旧的"并行统计 7 个站点的结果数量"已删除，改为选站点直接跳转）

  /** 详情/右键菜单里的「资源站搜索」：把游戏名填进搜索框并直接跳转到选中站点 */
  const searchForGame = useCallback(
    (game: GalGame) => {
      const kw = game.titleCn || game.title
      setKeyword(kw)
      setImmersive(false)
      void openSiteSearch(kw)
    },
    [openSiteSearch]
  )

  // ---------------- 封面 / 背景图 ----------------

  const setCustomCover = useCallback(
    async (game: GalGame) => {
      const pick = await api.gal.pickImage()
      if (!pick.ok) {
        toast.error(pick.error)
        return
      }
      if (!pick.data) return
      const r = await api.gal.setCustomImage(game.id, 'cover', pick.data)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      toast.success('已设置自定义封面')
      await load()
    },
    [load]
  )

  const clearCustom = useCallback(
    async (game: GalGame) => {
      const a = await api.gal.clearCustomImage(game.id, 'cover')
      if (!a.ok) {
        toast.error(a.error)
        return
      }
      // 背景图只在沉浸模式用，这里一并清掉，语义是「恢复数据源图片」
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

  const openFolder = useCallback(async (game: GalGame) => {
    const r = await api.app.openPath(game.folder)
    if (!r.ok) toast.error(r.error)
  }, [])

  const onCardMenu = (e: React.MouseEvent, game: GalGame): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ ...menuPosition(e), game })
  }

  const menuItems = (): GalMenuItem[] => {
    const g = menu?.game
    if (!g) return []
    const items: GalMenuItem[] = [
      { key: 'launch', icon: Play, label: running[g.id] ? '游戏中' : '启动游戏', group: '常用', onSelect: () => void onLaunch(g) },
      { key: 'ymgal', icon: Search, label: '从月幕galgame中搜索详情', group: '常用', onSelect: () => setYmgalGame(g) },
      // V1.5.2：内存读 BGM 功能已删除（用户要求），这里不再提供「查看最近识别的 bgm」入口
      { key: 'sites', icon: ExternalLink, label: '在资源站搜索该游戏', group: '常用', onSelect: () => searchForGame(g) },
      { key: 'unpack', icon: PackageOpen, label: '解包（引擎检测 / 曲名映射 / 立绘 CG）', group: '工具', onSelect: () => setUnpackGame(g) },
      {
        key: 'resources',
        icon: FolderOpen,
        label: '查看最近解包资源（在应用中查看）',
        group: '常用',
        onSelect: () => {
          setMenu(null)
          setResGame(g)
        }
      },
      { key: 'cover', icon: ImageIcon, label: '设置自定义封面', group: '工具', onSelect: () => void setCustomCover(g) },
      { key: 'folder', icon: FolderOpen, label: '打开游戏目录', group: '工具', onSelect: () => void openFolder(g) },
      { key: 'shots', icon: Camera, label: '最近截图', group: '常用', onSelect: () => setShotsGame(g) }
    ]
    if (g.customCover || g.customBanner) {
      items.push({ key: 'clear', icon: RotateCcw, label: '恢复数据源图片', group: '工具', onSelect: () => void clearCustom(g) })
    }
    items.push(
      {
        key: 'finish',
        icon: g.finished ? X : CircleCheck,
        label: g.finished ? '取消标记玩完' : '标记玩完',
        onSelect: () => void toggleFinished(g.id)
      },
      { key: 'remove', icon: Trash2, label: '从库中移除', danger: true, group: '工具', onSelect: () => setRemoving(g) }
    )
    return items
  }

  // 沉浸模式：把整页交给壁纸视图（它自己订阅列表事件）
  if (immersive) {
    return <GalgameImmersivePage onBack={() => setImmersive(false)} />
  }

  const immersiveDisabled = games.length === 0

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* 头部：标题 + 右上角按钮（按要求去掉「最近截图」，新增「沉浸模式」） */}
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold">Galgame 库</h1>
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">
              {games.length} 款
            </span>
          </div>
          <p className="mt-1 text-xs text-faint">
            已添加 {games.length} 款游戏 · 已玩完 {finishedCount}
            {runningCount > 0 ? ` · 运行中 ${runningCount}` : ''} · 右键卡片查看更多操作
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/*
            沉浸模式在「一款游戏都没导入」时禁用：那里整屏都是游戏封面/背景，
            空库进去只会看到一句空态，所以用外层 span 挂 title 说明原因（禁用按钮自己收不到 hover）。
          */}
          <span
            className="inline-flex"
            title={
              immersiveDisabled
                ? '还没有导入 galgame：沉浸模式整屏展示游戏壁纸与封面条，导入第一款游戏后才能进入'
                : '切到整屏壁纸布局（原「galgame 导航」的样式）'
            }
          >
            <Button
              variant="soft"
              icon={MonitorPlay}
              disabled={immersiveDisabled}
              onClick={() => setImmersive(true)}
            >
              沉浸模式
            </Button>
          </span>
          <Button icon={FolderPlus} loading={importing} onClick={() => void onImport()}>
            导入 galgame
          </Button>
        </div>
      </div>
      {immersiveDisabled ? (
        <div className="shrink-0 px-5 pb-2 text-[11px] text-faint">导入第一款游戏后即可进入沉浸模式。</div>
      ) : null}

      {/*
        V1.5.2：站点跳转式搜索（用户要求）。
        顶部先声明「只提供站点跳转，不提供下载」，然后左侧选站点、右侧输名字、点按钮跳转。
        这里刻意**不再显示任何结果数量**：统计需要并发打 7 个站点，既慢又容易被限流，
        而用户要的只是"去那个站点搜索"。
      */}
      <div className="shrink-0 px-5">
        <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-border bg-elev1/60 px-3 py-2 text-[11px] leading-relaxed text-faint">
          <ExternalLink size={12} className="mt-0.5 shrink-0 text-accent" />
          <span>
            本应用<b className="text-dim">只提供资源站跳转</b>，不提供 galgame 下载、也不抓取资源站内容。
            搜索会在系统浏览器里打开你选择的站点。
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 站点选择放在搜索框左边（默认 GalgameX） */}
          <select
            value={siteKey}
            onChange={(e) => setSiteKey(e.target.value)}
            title="选择要跳转的资源站"
            className="h-9 shrink-0 rounded-lg border border-border bg-elev1 px-2 text-xs text-text outline-none transition-colors focus:border-accent"
          >
            {sites.length === 0 ? <option value="galgamex">GalgameX</option> : null}
            {sites.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="relative min-w-[200px] flex-1 max-w-md">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="输入 galgame 名字，按回车直接去站点搜索"
              className="pl-8"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void openSiteSearch()
              }}
            />
          </div>
          <Button icon={ExternalLink} onClick={() => void openSiteSearch()}>
            前往站点搜索
          </Button>
        </div>
      </div>

      {/* 卡片网格 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-3">
        {!loaded && games.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-xs text-faint">
            <Spinner size={14} /> 正在读取游戏库…
          </div>
        ) : games.length === 0 ? (
          <EmptyState
            icon={Gamepad2}
            title="还没有导入 galgame"
            desc="点击「导入 galgame」选择游戏主程序（.exe）。应用会扫描游戏文件夹并尝试从 VNDB 与月幕Galgame 获取封面、评分与简介。"
          >
            <Button icon={FolderPlus} loading={importing} onClick={() => void onImport()}>
              导入第一个游戏
            </Button>
          </EmptyState>
        ) : (
          <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {games.map((game) => {
              const isRunning = !!running[game.id]
              return (
                <div
                  key={game.id}
                  onClick={() => setDetailId(game.id)}
                  onContextMenu={(e) => onCardMenu(e, game)}
                  className="group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-elev1 shadow-sm transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:shadow-lg hover:shadow-black/10"
                >
                  <div className="relative aspect-[3/4] overflow-hidden">
                    <Cover
                      src={game.customCover || game.cover}
                      className="h-full w-full transition-transform duration-500 group-hover:scale-105"
                    />
                    {/* 左上：运行中 / 已玩完 */}
                    <div className="absolute left-1.5 top-1.5 flex flex-col items-start gap-1">
                      {isRunning ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-ok backdrop-blur-sm">
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
                          </span>
                          运行中
                        </span>
                      ) : null}
                      {game.finished ? (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-ok backdrop-blur-sm">
                          <CircleCheck size={10} /> 已玩完
                        </span>
                      ) : null}
                    </div>
                    {/* 右上：最近截图（只看这款游戏自己的截图目录） */}
                    <div className="absolute right-1.5 top-1.5">
                      <IconButton
                        title="最近截图"
                        className="h-7 w-7 bg-black/35 text-white backdrop-blur-sm hover:bg-black/55 hover:text-white"
                        onClick={(e) => {
                          e.stopPropagation()
                          setShotsGame(game)
                        }}
                      >
                        <Camera size={13} />
                      </IconButton>
                    </div>
                    {/* 右下：评分 */}
                    {game.rating && game.rating > 0 ? (
                      <div className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded-md bg-black/50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-300 backdrop-blur-sm">
                        <Star size={10} fill="currentColor" />
                        {game.rating.toFixed(1)}
                      </div>
                    ) : null}
                    {/* 悬停：快捷启动 */}
                    <button
                      title={isRunning ? '游戏中' : '启动游戏'}
                      onClick={(e) => {
                        e.stopPropagation()
                        void onLaunch(game)
                      }}
                      className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 whitespace-nowrap bg-gradient-to-t from-black/70 to-transparent py-2 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <Play size={12} /> {isRunning ? '游戏中' : '启动游戏'}
                    </button>
                  </div>
                  <div className="flex flex-1 flex-col gap-1 px-2.5 py-2">
                    <div className="line-clamp-2 text-[13px] font-medium leading-snug" title={game.titleCn || game.title}>
                      {game.titleCn || game.title}
                    </div>
                    {game.chapterName ? (
                      <div className="line-clamp-1 text-[10px] text-faint" title={`章节：${game.chapterName}`}>
                        章节：{game.chapterName}
                      </div>
                    ) : null}
                    <div className="flex items-center gap-2 text-[11px] text-faint">
                      {game.playtimeSec > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <Clock size={10} /> {fmtPlay(game.playtimeSec)}
                        </span>
                      ) : (
                        <span>未游玩</span>
                      )}
                      {/* 引擎标签（只读游戏目录特征文件识别；检测不到就不显示） */}
                      <EngineBadge game={game} className="ml-auto" />
                    </div>
                    {game.titleCn && game.titleCn !== game.title ? (
                      <div className="truncate text-[10px] text-faint" title={game.title}>
                        {game.title}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 详情弹窗：与沉浸模式抽屉同一套内容（含「启动游戏」） */}
      <Modal open={!!detailGame} onClose={() => setDetailId(null)} title="游戏详情" width={680}>
        {detailGame ? (
          <GalDetailView
            game={detailGame}
            running={!!running[detailGame.id]}
            onLaunch={(g) => void onLaunch(g)}
            onReload={load}
            onYmgalSearch={(g) => setYmgalGame(g)}
            onSearchSites={searchForGame}
          />
        ) : null}
      </Modal>

      {/* 右键菜单（已去掉「自定义背景图」） */}
      <GalContextMenu menu={menu} items={menuItems()} />

      {/* 每张卡片自己的最近截图 */}
      <GalShotsModal open={!!shotsGame} game={shotsGame} onClose={() => setShotsGame(null)} />

      {/* 月幕搜索弹窗 */}
      <GalYmgalSearchModal game={ymgalGame} onClose={() => setYmgalGame(null)} onApplied={load} />

      {/* 最近识别 BGM 面板已随内存读 BGM 功能一起删除（V1.5.2） */}
      <GalUnpackModal game={unpackGame} onClose={() => setUnpackGame(null)} />
      {/* V1.5.2：最近解包资源（立绘/CG/BGM/文本，在应用内查看） */}
      <GalResourcesModal game={resGame} onClose={() => setResGame(null)} />

      {/* 移除确认 */}
      <ConfirmModal
        open={!!removing}
        title="从库中移除"
        message="仅删除启动方式与游玩记录，不会删除游戏文件本身。确定移除？"
        danger
        confirmText="移除"
        onConfirm={() => {
          if (removing) void removeGame(removing.id)
          setRemoving(null)
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  )
}


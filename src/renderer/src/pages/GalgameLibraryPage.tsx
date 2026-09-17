import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Camera,
  CircleCheck,
  Clock,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  Image as ImageIcon,
  MonitorPlay,
  Play,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X
} from 'lucide-react'
import type { GalGame, GalSiteSearchResult } from '@shared/types'
import { useGal } from '@/stores/galgame'
import { toast } from '@/stores/app'
import { api } from '@/lib/api'
import { Button, ConfirmModal, EmptyState, IconButton, Input, Modal, Spinner } from '@/components/ui'
import {
  Cover,
  fmtPlay,
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
 * - 顶部搜索：输入游戏名 → 7 个资源站并行统计结果数量 + 跳转链接（只回数量，绝不回传站点内容）
 */
export function GalgameLibraryPage() {
  const { games, running, loaded, importing, load, startLive, importGame, removeGame, toggleFinished, launch } = useGal()
  const [immersive, setImmersive] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [menu, setMenu] = useState<GalMenuState | null>(null)
  const [shotsGame, setShotsGame] = useState<GalGame | null>(null)
  const [ymgalGame, setYmgalGame] = useState<GalGame | null>(null)
  const [removing, setRemoving] = useState<GalGame | null>(null)

  // 站点搜索统计
  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [siteResults, setSiteResults] = useState<GalSiteSearchResult[] | null>(null)
  const [searchedKeyword, setSearchedKeyword] = useState('')

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

  const runSiteSearch = useCallback(async (kw: string) => {
    const q = kw.trim()
    if (!q) return
    setSearching(true)
    setSiteResults(null)
    setSearchedKeyword(q)
    const r = await api.gal.searchSites(q)
    setSearching(false)
    if (r.ok) {
      setSiteResults(r.data)
      const unknown = r.data.filter((x) => x.countKind === 'none').length
      if (unknown === r.data.length) toast.warn('所有站点都无法统计，请直接点「前往搜索」')
    } else {
      toast.error(r.error)
      setSiteResults([])
    }
  }, [])

  /** 详情/右键菜单里的「资源站搜索」：把这款游戏的名字塞进顶部搜索并立刻统计 */
  const searchForGame = useCallback(
    (game: GalGame) => {
      const kw = game.titleCn || game.title
      setKeyword(kw)
      setImmersive(false)
      void runSiteSearch(kw)
    },
    [runSiteSearch]
  )

  /** 数量文案：分页总数才叫「约 N 个结果」，只数得清首屏就明说「首屏 N 个」，数不出来就直说 */
  const countText = (r: GalSiteSearchResult): string => {
    if (r.countKind === 'none' || r.count === null) return '无法统计（前往站点搜索）'
    if (r.count === 0) return '未找到结果'
    return r.countKind === 'total' ? `约 ${r.count} 个结果` : `首屏 ${r.count} 个`
  }

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
      { key: 'launch', icon: Play, label: running[g.id] ? '游戏中' : '启动游戏', onSelect: () => void onLaunch(g) },
      { key: 'ymgal', icon: Search, label: '从月幕galgame中搜索详情', onSelect: () => setYmgalGame(g) },
      { key: 'sites', icon: ExternalLink, label: '在资源站搜索该游戏', onSelect: () => searchForGame(g) },
      { key: 'cover', icon: ImageIcon, label: '设置自定义封面', onSelect: () => void setCustomCover(g) },
      { key: 'folder', icon: FolderOpen, label: '打开游戏目录', onSelect: () => void openFolder(g) },
      { key: 'shots', icon: Camera, label: '最近截图', onSelect: () => setShotsGame(g) }
    ]
    if (g.customCover || g.customBanner) {
      items.push({ key: 'clear', icon: RotateCcw, label: '恢复数据源图片', onSelect: () => void clearCustom(g) })
    }
    items.push(
      {
        key: 'finish',
        icon: g.finished ? X : CircleCheck,
        label: g.finished ? '取消标记玩完' : '标记玩完',
        onSelect: () => void toggleFinished(g.id)
      },
      { key: 'remove', icon: Trash2, label: '从库中移除', danger: true, onSelect: () => setRemoving(g) }
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

      {/* 顶部搜索：统计各资源站的结果数量（只显示数量 + 跳转链接） */}
      <div className="shrink-0 px-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-md">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="输入游戏名，统计各资源站有多少结果（不显示站点内容）"
              className="pl-8"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSiteSearch(keyword)
              }}
            />
          </div>
          <Button icon={Search} loading={searching} onClick={() => void runSiteSearch(keyword)}>
            统计结果数量
          </Button>
          {siteResults || searching ? (
            <Button
              variant="ghost"
              size="sm"
              icon={X}
              onClick={() => {
                setSiteResults(null)
                setSearchedKeyword('')
              }}
            >
              收起
            </Button>
          ) : null}
        </div>

        {/* 结果面板：7 个站点各一行，数量 + 跳转链接 */}
        {searching || siteResults ? (
          <div className="mt-3 rounded-xl border border-border bg-elev1 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-semibold">
                「{searchedKeyword}」在各资源站的结果数量
                <span className="ml-2 font-normal text-faint">只统计数量，不抓取站点内容</span>
              </div>
              {searching ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-faint">
                  <Spinner size={12} /> 正在并行统计 7 个站点…
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {siteResults && siteResults.length === 0 && !searching ? (
                <div className="rounded-lg border border-border bg-elev2/40 px-3 py-2 text-[11px] text-faint">
                  统计失败（主进程没有返回结果），可稍后重试，或点站点直接去搜。
                </div>
              ) : searching && !siteResults
                ? SITE_PLACEHOLDERS.map((s) => (
                    <div
                      key={s.key}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border bg-elev2/40 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium">{s.name}</div>
                        <div className="truncate text-[10px] text-faint">{s.host}</div>
                      </div>
                      <Spinner size={13} />
                    </div>
                  ))
                : (siteResults ?? []).map((r) => (
                    <div
                      key={r.key}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border bg-elev2/40 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium">{r.name}</div>
                        <div className="truncate text-[10px] text-faint">
                          {r.host} · <span title={r.note}>{countText(r)}</span>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" icon={ExternalLink} onClick={() => openExternal(r.url)}>
                        前往搜索
                      </Button>
                    </div>
                  ))}
            </div>
            <div className="mt-2 text-[10px] leading-relaxed text-faint">
              「约 N 个结果」来自站点自己的总数；「首屏 N 个」只数得清站点返回的首页清单；
              需要 JS、被 Cloudflare 拦截或证书过期的站点会显示「无法统计」，可直接点「前往搜索」。
            </div>
          </div>
        ) : null}
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
                      className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent py-2 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <Play size={12} /> {isRunning ? '游戏中' : '启动游戏'}
                    </button>
                  </div>
                  <div className="flex flex-1 flex-col gap-1 px-2.5 py-2">
                    <div className="line-clamp-2 text-[13px] font-medium leading-snug" title={game.titleCn || game.title}>
                      {game.titleCn || game.title}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-faint">
                      {game.playtimeSec > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <Clock size={10} /> {fmtPlay(game.playtimeSec)}
                        </span>
                      ) : (
                        <span>未游玩</span>
                      )}
                      {game.titleCn && game.titleCn !== game.title ? (
                        <span className="min-w-0 flex-1 truncate text-right">{game.title}</span>
                      ) : null}
                    </div>
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

/** 搜索中占位行（顺序与主进程 SITES 一致，用户能一眼看出在等哪些站点） */
const SITE_PLACEHOLDERS = [
  { key: 'inarigal', name: '稻荷acg', host: 'inarigal.com' },
  { key: 'kungal', name: '鲲gal', host: 'kungal.com' },
  { key: 'galgamex', name: 'GalgameX', host: 'galgamex.net' },
  { key: 'shinnku', name: '真红小站', host: 'shinnku.com' },
  { key: 'touchgal', name: 'TouchGal', host: 'touchgal.us' },
  { key: 'nekogal', name: 'NekoGAL', host: 'nekogal.com' },
  { key: 'acgfav', name: '绮梦 ACG', host: 'acgfav.com' }
]

import { AnimatePresence, motion } from 'framer-motion'
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { SideNav } from '@/components/SideNav'
import { TitleBar } from '@/components/TitleBar'
import { ToastHost } from '@/components/ToastHost'
import { SchedulePage } from '@/pages/SchedulePage'
import { DashboardPage } from '@/pages/DashboardPage'
import { SubscriptionsPage } from '@/pages/SubscriptionsPage'
import { FavoritesPage } from '@/pages/FavoritesPage'
import { SearchPage } from '@/pages/SearchPage'
import { ToolsPage } from '@/pages/ToolsPage'
import { CharacterGridPage } from '@/pages/CharacterGridPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { SubjectDetailPage } from '@/pages/SubjectDetailPage'
import { PlayerPage } from '@/pages/PlayerPage'
import { default as PlayerOverlayPage } from '@/pages/PlayerOverlayPage'
import { RulesPage } from '@/pages/RulesPage'
import { DataSourcePage } from '@/pages/DataSourcePage'
import { TrayPanelPage } from '@/pages/TrayPanelPage'
import { StatToolPage } from '@/pages/StatToolPage'
import { ShortcutsPage } from '@/pages/ShortcutsPage'
import { GalgamePage } from '@/pages/GalgamePage'
import { GalgameToolsPage } from '@/pages/GalgameToolsPage'
import { DownloadDetailPage } from '@/pages/DownloadDetailPage'
import { DownloaderConfigPage } from '@/pages/DownloaderConfigPage'
import { PlayerSettingsPage } from '@/pages/PlayerSettingsPage'
import { CacheSettingsPage } from '@/pages/CacheSettingsPage'
import { DanmakuSettingsPage } from '@/pages/DanmakuSettingsPage'
import { AnnouncementModal } from '@/components/AnnouncementModal'
import { ImportantUpdateModal } from '@/components/ImportantUpdateModal'
import { UpdatePage } from '@/pages/UpdatePage'
import { LogsPage } from '@/pages/LogsPage'
import { AboutPage } from '@/pages/AboutPage'
import { SaveDirsPage } from '@/pages/SaveDirsPage'
import { api } from '@/lib/api'
import { useShell } from '@/stores/shell'

/** 小窗口自定义标题栏上的路由标题 */
const SMALL_WINDOW_TITLES: Record<string, string> = {
  '/stattool': '统计工具',
  '/rules': '规则管理',
  '/shortcuts': '播放器快捷键',
  '/datasource': '数据源配置',
  '/logs': '运行日志',
  '/about': '关于 Sakana',
  '/save-dirs': '文件保存配置',
  '/downloader-config': '下载器配置',
  '/player-settings': '播放器设置',
  '/cache-settings': '缓存设置',
  '/danmaku-settings': '弹幕设置',
  '/downloads-win': '下载详情',
  '/galgame/tools': 'Galgame 工具',
  // v0.2.11：最XX的角色 9宫格（工具页入口，独立小窗口里用）
  '/tools/character-grid': '最XX的角色 9宫格',
  // v0.2.12：独立的更新窗口
  '/update': '软件更新'
}

function smallWindowTitle(pathname: string): string {
  return SMALL_WINDOW_TITLES[pathname] ?? ''
}

function PageTransition({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="h-full"
    >
      {children}
    </motion.div>
  )
}

function AnimatedRoutes() {
  const location = useLocation()
  const isPlayer = location.pathname.startsWith('/player')
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={isPlayer ? 'player' : location.pathname}>
        <Route path="/" element={<PageTransition><SchedulePage /></PageTransition>} />
        <Route path="/dashboard" element={<PageTransition><DashboardPage /></PageTransition>} />
        <Route path="/subs" element={<PageTransition><SubscriptionsPage /></PageTransition>} />
        <Route path="/favorites" element={<PageTransition><FavoritesPage /></PageTransition>} />
        <Route path="/search" element={<PageTransition><SearchPage /></PageTransition>} />
        <Route path="/tools" element={<PageTransition><ToolsPage /></PageTransition>} />
        {/* v0.2.11：最XX的角色 9宫格（工具页卡片入口指向这里） */}
        <Route path="/tools/character-grid" element={<PageTransition><CharacterGridPage /></PageTransition>} />
        <Route path="/settings" element={<PageTransition><SettingsPage /></PageTransition>} />
        <Route path="/rules" element={<PageTransition><RulesPage /></PageTransition>} />
        <Route path="/datasource" element={<PageTransition><DataSourcePage /></PageTransition>} />
        <Route path="/stattool" element={<PageTransition><StatToolPage /></PageTransition>} />
        <Route path="/shortcuts" element={<PageTransition><ShortcutsPage /></PageTransition>} />
        <Route path="/downloader-config" element={<PageTransition><DownloaderConfigPage /></PageTransition>} />
        <Route path="/player-settings" element={<PageTransition><PlayerSettingsPage /></PageTransition>} />
        <Route path="/cache-settings" element={<PageTransition><CacheSettingsPage /></PageTransition>} />
        <Route path="/danmaku-settings" element={<PageTransition><DanmakuSettingsPage /></PageTransition>} />
        <Route path="/logs" element={<PageTransition><LogsPage /></PageTransition>} />
        <Route path="/about" element={<PageTransition><AboutPage /></PageTransition>} />
        <Route path="/save-dirs" element={<PageTransition><SaveDirsPage /></PageTransition>} />
        <Route path="/galgame" element={<PageTransition><GalgamePage /></PageTransition>} />
        <Route path="/galgame/tools" element={<PageTransition><GalgameToolsPage /></PageTransition>} />
        <Route path="/downloads-win" element={<DownloadDetailPage />} />
        {/* v0.2.12：独立的更新窗口（可视化进度界面，由 app.updateOpenWindow() 打开） */}
        <Route path="/update" element={<UpdatePage />} />
        <Route path="/subject/:id" element={<PageTransition><SubjectDetailPage /></PageTransition>} />
        <Route path="/player" element={<PlayerRoute />} />
        <Route path="/overlay" element={<PlayerOverlayPage />} />
        <Route path="/tray" element={<TrayPanelPage />} />
        {/* 兜底：hash 不匹配任何路由时给出明确提示，避免窗口一片空白 */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AnimatePresence>
  )
}

/**
 * 播放页路由包装：用 `playKey` 作为 React key。
 *
 * 为什么需要：react-router 里 navigate 到**同一个路由**（/player → /player）时组件不会重新挂载，
 * 只会更新 location.state。而「播放器内切集」依赖一次干净的重建（内核重新 attach、
 * 嗅探窗口重新创建），否则会出现旧状态残留、切集后卡在 0 秒。
 * 切集时 state 里带一个新的 playKey，这里就会把 PlayerPage 整个重建一次，
 * 效果与「从番剧详情页重新进入播放页」完全一致。
 */
function PlayerRoute() {
  const location = useLocation()
  const key = (location.state as { playKey?: number } | null)?.playKey ?? 'player'
  return <PlayerPage key={key} />
}

/** 未匹配路由的提示页（副窗口空白问题的可见化兜底） */function NotFoundPage() {
  const location = useLocation()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-sm font-semibold text-dim">页面不存在</div>
      <div className="max-w-lg break-all rounded-lg bg-elev2 px-3 py-2 text-[11px] text-faint">
        {location.pathname}
        {location.search}
      </div>
      <button
        onClick={() => {
          window.location.hash = '/'
          window.location.reload()
        }}
        className="rounded-lg border border-border bg-elev1 px-3 py-1.5 text-xs text-dim transition-colors hover:border-accent hover:text-accent whitespace-nowrap"
      >
        返回首页
      </button>
    </div>
  )
}

export default function App() {
  return (
    <HashRouter>
      <AppFrame />
    </HashRouter>
  )
}

function AppFrame() {
  const location = useLocation()
  /*
   * 沉浸模式开关（galgame 页写入，见 stores/shell.ts）：为 true 时**不渲染左侧导航栏**，
   * 于是 main（flex-1）自动占满整宽 —— 沉浸页的 absolute inset-0 壁纸就铺满了原来导航栏那一列。
   * 这里必须放在函数最前面（早于下面几个 early return）：Hook 不能被条件分支跳过。
   */
  const immersive = useShell((s) => s.immersive)
  // 全屏控制栏悬浮窗：整窗透明，只有控制栏可见
  if (api.overlay.isOverlay || location.pathname.startsWith('/overlay')) {
    return (
      <ErrorBoundary>
        <AnimatedRoutes />
      </ErrorBoundary>
    )
  }
  // 托盘悬浮小窗：无外壳（标题栏/侧边栏）
  if (location.pathname.startsWith('/tray')) {
    return (
      <>
        <main className="h-full overflow-hidden bg-bg">
          <AnimatedRoutes />
        </main>
        <ToastHost />
      </>
    )
  }
  // 小窗口：系统边框已关闭，这里自绘可拖拽标题栏 + 关闭按钮
  if (api.window.isSmallWindow) {
    const title = smallWindowTitle(location.pathname)
    return (
      <div className="flex h-full flex-col overflow-hidden bg-bg">
        <div
          className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border bg-elev1 pl-3 pr-2"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <span className="min-w-0 truncate text-xs font-medium text-dim">
            {title ? `🐟 ${title}` : 'Sakana'}
          </span>
          <button
            title="关闭窗口"
            onClick={() => void api.window.close()}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className="flex h-6 w-8 shrink-0 items-center justify-center rounded text-dim transition-colors hover:bg-danger/15 hover:text-danger"
          >
            ✕
          </button>
        </div>
        <main className="min-h-0 flex-1 overflow-hidden bg-bg">
          <ErrorBoundary>
            <AnimatedRoutes />
          </ErrorBoundary>
        </main>
        <ToastHost />
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        {/* 沉浸模式隐藏导航栏：整窗只剩壁纸（TitleBar 保留，否则窗口就没法拖动/关闭了） */}
        {immersive ? null : <SideNav />}
        <main className="relative min-w-0 flex-1 overflow-hidden bg-bg">
          <ErrorBoundary>
            <AnimatedRoutes />
          </ErrorBoundary>
        </main>
      </div>
      <ToastHost />
      {/* v0.2.8 附加：启动公告（只在主界面弹，小窗口/播放器/悬浮窗不弹） */}
      <AnnouncementModal />
      {/* v0.2.12：重要更新的强提醒（用户要求「十分重要的更新要在启动后弹窗强烈提醒」） */}
      <ImportantUpdateModal />
    </div>
  )
}

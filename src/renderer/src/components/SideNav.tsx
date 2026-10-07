import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  CalendarDays,
  Gamepad2,
  Heart,
  LayoutDashboard,
  Puzzle,
  Rss,
  Search,
  Settings,
  type LucideIcon
} from 'lucide-react'
import { NavLink, useLocation } from 'react-router-dom'
import type { CastDevice } from '@shared/types'
import { api } from '@/lib/api'
import sidebarArt from '@/assets/sidebar-art.png'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '番剧表', icon: CalendarDays },
  { to: '/search', label: '搜索', icon: Search },
  { to: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
  { to: '/subs', label: '订阅', icon: Rss },
  { to: '/favorites', label: '收藏', icon: Heart },
  // 这一轮改版把「galgame 导航」改名成「galgame 库」（页面默认是卡片网格，整屏壁纸改叫沉浸模式）
  { to: '/galgame', label: 'Galgame 库', icon: Gamepad2 },
  { to: '/tools', label: '工具', icon: Puzzle },
  { to: '/settings', label: '设置', icon: Settings }
]

/** 导航栏下方空白区域的装饰图（随应用打包，非本地路径加载） */
const SIDEBAR_ART = sidebarArt

/** 侧面导航栏（方案 2：6 个标签，交互动画），支持自定义背景图片 */
export function SideNav() {
  const location = useLocation()
  /** 应用版本号（v0.2.8 附加：底部标签改为读真实版本，不再写死） */
  const [appVersion, setAppVersion] = useState('0.2.8')
  /** 已发现的移动端接收端（v0.3.8：底部左下的连接状态） */
  const [castDevice, setCastDevice] = useState<CastDevice | null>(null)

  useEffect(() => {
    void api.app
      .version()
      .then((r) => {
        if (r.ok && r.data) setAppVersion(String(r.data))
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    /*
     * 主进程在启动后就会开始自动发现（见 src/main/index.ts 的投屏服务启动），
     * 这里订阅设备变化即可；顺手主动问一次，避免订阅建立晚于首轮发现。
     */
    const off = api.cast.onDevices((list) => {
      setCastDevice(list.find((d) => d.kind === 'sakana') ?? null)
    })
    void api.cast.discover().then((r) => {
      if (r.ok) setCastDevice(r.data.find((d) => d.kind === 'sakana') ?? null)
    })
    return () => off()
  }, [])

  const active =
    NAV_ITEMS.find((item) =>
      item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
    ) ?? NAV_ITEMS[0]

  // v0.3.1：导航栏背景功能已按用户要求整体删除（设置项、页面、IPC、主进程实现一并移除）
  const bgUrl = ''

  return (
    <nav className="relative flex w-48 shrink-0 flex-col overflow-hidden border-r border-border bg-elev1">
      {bgUrl ? (
        <>
          <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${bgUrl}")` }} />
          <div className="absolute inset-0 bg-elev1/80" />
        </>
      ) : null}
      <div className="relative flex shrink-0 flex-col gap-1 p-2.5">
        {NAV_ITEMS.map((item) => {
          const isActive = active.to === item.to
          const Icon = item.icon
          return (
            <NavLink key={item.to} to={item.to} className="relative" title={item.label}>
              {({ isActive: navActive }) => (
                <div
                  className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors ${
                    navActive ? 'text-accent font-medium' : 'text-dim hover:bg-elev2 hover:text-text'
                  }`}
                >
                  {navActive && (
                    <motion.div
                      layoutId="nav-pill"
                      className="absolute inset-0 rounded-lg bg-accent-soft"
                      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                    />
                  )}
                  <Icon size={16} className="relative z-10 shrink-0" />
                  {/* 标签单行显示：窄栏时省略号截断，完整文本走 title 悬停查看 */}
                  <span className="relative z-10 min-w-0 flex-1 truncate" title={item.label}>
                    {item.label}
                  </span>
                  {isActive && (
                    <motion.span
                      layoutId="nav-dot"
                      className="relative z-10 ml-auto h-1.5 w-1.5 rounded-full bg-accent"
                    />
                  )}
                </div>
              )}
            </NavLink>
          )
        })}
      </div>
      {/* 导航栏下方空白区域装饰图 */}
      <div className="relative flex min-h-0 flex-1 items-end justify-center overflow-hidden px-2 pb-1">
        <img
          src={SIDEBAR_ART}
          alt=""
          draggable={false}
          className="max-h-full w-full select-none object-contain opacity-90"
          style={{
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 18%)',
            maskImage: 'linear-gradient(to bottom, transparent 0, #000 18%)'
          }}
        />
      </div>
      <div className="relative shrink-0 border-t border-border px-4 py-3 text-[10px] leading-relaxed text-faint">
        {/*
          移动端连接状态（v0.3.8，用户要求「应用主界面最左下方显示当前是否连接到移动端」）。
          判据是"发现到了 Sakana 接收端"——电脑是投屏的客户端，没有长连接可维持，
          能看见就等于能投；这里如实显示设备名，点一下去投屏设置。
        */}
        <button
          className="mb-1.5 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-elev2"
          title={castDevice ? `${castDevice.name}（${castDevice.host}:${castDevice.port}）` : '未发现手机投屏应用'}
          onClick={() => void api.window.openSmall('/player-settings', { width: 700, height: 620, title: '播放器设置' })}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${castDevice ? 'bg-ok' : 'bg-faint/60'}`}
            style={castDevice ? { boxShadow: '0 0 6px var(--color-ok, #46a758)' } : undefined}
          />
          <span className={`min-w-0 flex-1 truncate ${castDevice ? 'text-text' : ''}`}>
            {castDevice ? `已连接移动端：${castDevice.name}` : '未连接移动端'}
          </span>
        </button>
        {/* v0.2.8 附加：版本号改为读取应用版本（此前这里写死 v0.1.4，早就过期了） */}
        Sakana v{appVersion}
        <br />
        本地优先 · 数据不离开设备
      </div>
    </nav>
  )
}

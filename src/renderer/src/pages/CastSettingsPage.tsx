import { useEffect, useState } from 'react'
import { Cast, Copy, Download, Link2 } from 'lucide-react'
import type { CastDevice } from '@shared/types'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, Input } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'

/**
 * 投屏设置（/cast-settings，v0.3.9 从「播放器设置」里拆出的独立设置项）。
 *
 * 用户原话：「投屏放到外面作为单独的设置选项」。
 * 为什么值得单独一页：投屏这块有 4 个策略选项 + 手动连接 + 双端同步地址 + 接收端下载，
 * 全塞在播放器设置中间时，只想改画质（超分）的人要滚过一整屏投屏内容才能找到自己的设置。
 *
 * 设置字段仍是 `settings.castStrategy`（键名不变，老用户的策略原样生效）。
 * 侧边栏左下角的「未连接移动端 / 已连接移动端」也指向本页（见 components/SideNav.tsx）。
 */
export function CastSettingsPage() {
  const { settings, save } = useSettings()
  /** 手动连接的地址输入、已连接的移动端、本机同步地址（v0.3.8） */
  const [castAddr, setCastAddr] = useState('')
  const [castTarget, setCastTarget] = useState<CastDevice | null>(null)
  const [syncUrl, setSyncUrl] = useState('')

  /**
   * 接收端工程的仓库地址（用户要求"投屏设置里增加下载地址"）。
   *
   * 前两条分别是"直接下载可安装的 APK"与"看源码/构建说明"：
   * `dist/` 下的 APK 是 debug 签名（能直接装，适合自用）；要正式分发得自己换 keystore 重新签名。
   */
  const RECEIVER_REPO = 'https://github.com/rewxz1999/Sakana.app/tree/main/android-receiver'
  const RECEIVER_APK =
    'https://github.com/rewxz1999/Sakana.app/raw/main/android-receiver/dist/SakanaReceiver-0.3.8-debug.apk'

  const refreshSync = async (): Promise<void> => {
    const [url, devices] = await Promise.all([api.cast.syncUrl(), api.cast.discover()])
    if (url.ok) setSyncUrl(url.data)
    if (devices.ok) setCastTarget(devices.data.find((d) => d.kind === 'sakana') ?? null)
  }

  useEffect(() => {
    void refreshSync()
  }, [])

  const connectByHand = async (): Promise<void> => {
    const addr = castAddr.trim()
    if (!addr) {
      toast.warn('请先填接收端的 IP:端口（接收端主界面顶部就显示着）')
      return
    }
    const r = await api.cast.addManual(addr)
    if (!r.ok) {
      toast.error(`连接失败：${r.error}`)
      return
    }
    if (!r.data) {
      toast.error('连不上这个地址：确认接收端已打开、且与本机在同一网络（或已 USB 共享网络）')
      return
    }
    await api.cast.setTarget(r.data.id)
    setCastTarget(r.data)
    setCastAddr('')
    toast.success(`已连接 ${r.data.name}`)
  }

  const openReceiverRepo = (): void => {
    // 走系统浏览器：主进程的 setWindowOpenHandler 会把 http 外链交给默认浏览器
    window.open(RECEIVER_REPO, '_blank')
  }

  /** 直接下载 APK（浏览器打开 raw 链接即可下载） */
  const openReceiverApk = (): void => {
    window.open(RECEIVER_APK, '_blank')
  }

  const copyReceiverUrl = async (): Promise<void> => {
    // 纯文本复制直接用 Chromium 的剪贴板 API（Electron 里可用，也不需要额外 IPC）
    try {
      await navigator.clipboard.writeText(RECEIVER_REPO)
      toast.success('已复制接收端仓库地址')
    } catch (err) {
      toast.error(`复制失败：${String((err as Error)?.message ?? err)}`)
    }
  }

  return (
    <SubPage
      icon={Cast}
      title="投屏设置"
      desc="把当前这一集投到电视（DLNA）或本仓库的安卓接收端；播放器控制栏的「投屏」按钮里选设备"
      maxWidth="max-w-2xl"
    >
      {/* ---------------- 传输策略 ---------------- */}
      <Card title="传输策略" desc="决定「怎么把这一路流交给电视」，直接影响投屏能不能放、清不清晰">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap gap-2">
            {(
              [
                { v: 'auto' as const, label: '自动（推荐）', desc: '给电视时重封装成 MP4（-c:v copy，不重编码）以兼容大多数电视；Sakana 接收端直连' },
                { v: 'direct' as const, label: '只用直连', desc: '电脑完全不参与传输，但站点校验 Referer 时电视会 403' },
                { v: 'relay' as const, label: '只用中转（HLS 直通）', desc: '电脑只转发字节、不重封装；电视确认支持 HLS 时用它，能拖进度' },
                { v: 'transcode' as const, label: '中转并转码', desc: '转成 H.264/AAC；电视解不了 HEVC 时才用，会明显增加延迟与画质损失' }
              ] as const
            ).map((o) => (
              <button
                key={o.v}
                onClick={() => save({ castStrategy: o.v })}
                className={`min-w-[9rem] flex-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  (settings.castStrategy ?? 'auto') === o.v ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent/50'
                }`}
              >
                <div className="text-xs font-semibold text-text">{o.label}</div>
                <div className="mt-0.5 text-[10px] leading-snug text-faint">{o.desc}</div>
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-faint">
            投屏时本机播放会自动暂停，把带宽让给电视（同一路流在两处同时拉会互相抢带宽）。
            中转服务只监听局域网、端口 52890，不做任何重编码；投屏结束后自动停止。
            有线共享网络或跨网段时自动发现不生效，请用下面的「手动连接」填接收端显示的 IP:端口。
          </p>
        </div>
      </Card>

      {/* ---------------- 手动连接 ---------------- */}
      <Card title="手动连接移动端" desc="广播发现到不了的地方（USB 网络共享 / 跨网段 / AP 隔离）用这里兜底">
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-[12rem] flex-1"
            placeholder="接收端显示的 IP，例如 192.168.42.129:52889"
            value={castAddr}
            onChange={(e) => setCastAddr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void connectByHand()
            }}
          />
          <Button size="sm" icon={Link2} onClick={() => void connectByHand()}>
            连接
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
          地址在接收端应用的主界面顶部（点一下即可复制）。连接成功后电脑会记住它，之后投屏默认给这台设备。
          {castTarget ? ` 当前已连接：${castTarget.name}` : ' 当前未连接任何移动端。'}
        </p>
      </Card>

      {/* ---------------- 双端同步 ---------------- */}
      <Card title="双端同步" desc="连上移动端后自动同步收藏与观看历史">
        <p className="text-[11px] leading-relaxed text-faint">
          连上移动端后会自动同步：把电脑的收藏与观看历史给它，也接收它那边的观看历史合并回来。
          手机端会把这个地址（本机局域网地址）连同投屏一起收到，无需手动配置。
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-elev2 px-2 py-1 text-[11px] text-dim">
            {syncUrl || '同步服务未启动'}
          </code>
          <Button size="sm" variant="outline" onClick={() => void refreshSync()}>
            刷新
          </Button>
        </div>
      </Card>

      {/* ---------------- 接收端下载 ---------------- */}
      <Card title="安卓接收端" desc="用户要求：投屏设置里给出接收端下载地址">
        <p className="text-[11px] leading-relaxed text-faint">
          极简的安卓投屏接收端（约 1 MB 的 release 包，装到手机/平板/盒子上打开即可被搜到）。
          仓库地址：github.com/rewxz1999/Sakana.app 的 <code>android-receiver/</code> 目录。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" icon={Download} onClick={() => openReceiverApk()}>
            下载安卓接收端 APK
          </Button>
          <Button size="sm" variant="outline" onClick={() => openReceiverRepo()}>
            仓库目录 / 构建说明
          </Button>
          <Button size="sm" variant="ghost" icon={Copy} onClick={() => void copyReceiverUrl()}>
            复制地址
          </Button>
        </div>
      </Card>
    </SubPage>
  )
}

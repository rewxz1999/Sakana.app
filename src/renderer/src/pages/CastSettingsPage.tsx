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
 *
 * v0.3.9 追加（用户报「投屏到电视：能连上、加载一会后显示无法播放」）：
 *   · 把现场发现的 **DLNA 电视**也列出来（以前这一页只显示移动端接收端，电视是"看不见的目标"）；
 *   · 加一张「失败在哪一步」的对照卡：投屏失败的提示语就是按这几类写的，
 *     用户在电视前对着看就知道该改哪一项，而不用去翻日志。
 */
export function CastSettingsPage() {
  const { settings, save } = useSettings()
  /** 手动连接的地址输入、已连接的移动端、本机同步地址（v0.3.8） */
  const [castAddr, setCastAddr] = useState('')
  const [castTarget, setCastTarget] = useState<CastDevice | null>(null)
  const [syncUrl, setSyncUrl] = useState('')
  /** 现场发现到的 DLNA 电视（v0.3.9）：它们才是「投屏到电视」的实际目标 */
  const [tvDevices, setTvDevices] = useState<CastDevice[]>([])

  /**
   * 接收端工程的仓库地址（用户要求"投屏设置里增加下载地址"）。
   *
   * 前两条分别是"直接下载可安装的 APK"与"看源码/构建说明"：
   * `dist/` 下的 APK 是 debug 签名（能直接装，适合自用）；要正式分发得自己换 keystore 重新签名。
   */
  const RECEIVER_REPO = 'https://github.com/rewxz1999/Sakana.app/tree/main/android-receiver'
  /*
   * V1.1：文件名跟着安卓端版本走（`versionName` = 1.1.0）。
   *
   * ⚠️ 改名时**不要删掉旧的那份**：已经装出去的电脑端（V1.0.0 及更早）里写死的是
   * `SakanaReceiver-0.3.8-debug.apk`，删了它们那个"下载安卓接收端 APK"按钮就变成 404。
   * 两份并存只有十几 MB，换来的是一年内所有旧客户端都能继续下载。
   */
  const RECEIVER_APK =
    'https://github.com/rewxz1999/Sakana.app/raw/main/android-receiver/dist/SakanaReceiver-1.1.0-debug.apk'

  const refreshSync = async (): Promise<void> => {
    const [url, devices] = await Promise.all([api.cast.syncUrl(), api.cast.discover()])
    if (url.ok) setSyncUrl(url.data)
    if (devices.ok) {
      setCastTarget(devices.data.find((d) => d.kind === 'sakana') ?? null)
      setTvDevices(devices.data.filter((d) => d.kind === 'dlna'))
    }
  }

  useEffect(() => {
    void refreshSync()
    /*
     * 电视是"会来会走"的设备（关了就没了）：主进程发现到新设备会推 onDevices，
     * 这里跟着更新，用户不必手点刷新 —— 否则他打开的是一分钟前的列表，
     * 选中一台已经关机的电视，报错还看不出原因。
     */
    const off = api.cast.onDevices((list) => {
      setCastTarget(list.find((d) => d.kind === 'sakana') ?? null)
      setTvDevices(list.filter((d) => d.kind === 'dlna'))
    })
    return off
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

  /** 本机在中转时用的局域网地址（同步服务地址里就带着它，直接截出来给用户看） */
  const lanHost = /^https?:\/\/([^:/]+)(?::(\d+))?/.exec(syncUrl)?.[1] ?? ''

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
                { v: 'auto' as const, label: '自动（推荐）', desc: '电视不认 HLS 时用 FFmpeg 重封装成 MP4（-c:v copy，不重编码）；Sakana 接收端直连' },
                { v: 'direct' as const, label: '只用直连', desc: '电脑完全不参与传输，但站点校验 Referer 时电视会 403，且电视必须自己认这个封装' },
                { v: 'relay' as const, label: '只用中转（HLS 直通）', desc: '能拖进度、不重封装；**电视自报支持 HLS** 才真的走 HLS，否则会自动退回重封装' },
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
            中转服务只监听局域网、端口 52890，除「中转并转码」外不做重编码；投屏结束后自动停止。
            有线共享网络或跨网段时自动发现不生效，请用下面的「手动连接」填接收端显示的 IP:端口。
          </p>
        </div>
      </Card>

      {/* ---------------- DLNA 电视（v0.3.9） ---------------- */}
      <Card
        title="DLNA 电视"
        desc="SSDP 搜到、并且带 AVTransport 的电视/盒子；投屏时由播放器控制栏选目标"
      >
        {tvDevices.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-faint">
            现在没搜到电视。电视上的「投屏 / DLNA / 多屏互动」要处于打开状态，且与本机在同一网段
            （访客 Wi-Fi、AP 隔离、或有线无线分属两个网段时搜不到）。
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {tvDevices.map((d) => (
              <div key={d.id} className="flex items-center gap-2 rounded-lg bg-elev2 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-text">{d.name}</span>
                <code className="text-[10px] text-faint">
                  {d.host}:{d.port}
                </code>
              </div>
            ))}
            <p className="mt-1 text-[11px] leading-relaxed text-faint">
              电视只认局域网地址：本机用作中转的地址是{' '}
              <code className="text-dim">{lanHost || '（服务未启动）'}</code>
              ，端口 52890（被占用时自动顺延）。若同一台电视出现两条记录，通常是电视上不同的
              投屏应用各挂了一个渲染器，选名字里带「DLNA」的那个。
            </p>
          </div>
        )}
      </Card>

      {/* ---------------- 投屏失败在哪一步（v0.3.9） ---------------- */}
      <Card
        title="投屏失败时，先看卡在哪一步"
        desc="播放页弹出的投屏提示就是按这五类写的 —— 对上号再改设置，比反复重投快得多"
      >
        <div className="flex flex-col gap-2 text-[11px] leading-relaxed text-faint">
          <p>
            <span className="text-text">① 中转没起来</span>：提示里会写「中转服务启动失败」。
            多数是端口被占用或安全软件拦截；重启应用再试一次。
          </p>
          <p>
            <span className="text-text">② 电视直接拒绝</span>：提示里带 UPnP 错误码，例如
            <code className="mx-1 text-dim">704 播放格式不被支持</code>、
            <code className="mx-1 text-dim">714 不接受这个 MIME 类型</code>。
            这类改「传输策略」为自动或「中转并转码」最有效。
          </p>
          <p>
            <span className="text-text">③ 电视没来取流</span>：提示里会写「N 秒内没有来本机取过流」。
            说明它拿不到我们给的地址：先确认电视和电脑在同一网段；电脑有多块网卡（虚拟机 / VPN /
            WSL）时，中转地址可能选到了电视路由不到的那一块。
          </p>
          <p>
            <span className="text-text">④ 取到了流却播不了</span>：电视确实来取了，但我们的中转从片源
            拿不到数据（回 4xx/5xx），通常是片源地址过期，重开这一集再投。
          </p>
          <p>
            <span className="text-text">⑤ 拿到了正常数据仍不出画</span>：电视不认这个封装 / 编码
            （常见于 HEVC、10bit、AC-3 音轨）。把策略换成「中转并转码」。
          </p>
          <p className="text-[10px] text-faint">
            提示只区分到这一步为止；「画面到底有没有出现」只能靠人眼看 —— 程序能拿到的证据是电视自报的
            RelTime 是否在推进。
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

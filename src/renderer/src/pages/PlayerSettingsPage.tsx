import { useEffect, useState } from 'react'
import { CheckCircle2, MonitorPlay, RefreshCw, XCircle } from 'lucide-react'
import type { PlayerAssets } from '@shared/api'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, Input } from '@/components/ui'
import { AssetLink, Card, SubPage, type BuiltinAsset } from '@/components/SettingsShell'
import { ShortcutsPanel } from './ShortcutsPage'

/** 内置组件状态行 */
function AssetRow({ name, ok, hint }: { name: string; ok: boolean | null; hint: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="flex items-center gap-2 text-xs text-dim">
        {ok == null ? (
          <RefreshCw size={13} className="animate-spin text-faint" />
        ) : ok ? (
          <CheckCircle2 size={13} className="text-ok" />
        ) : (
          <XCircle size={13} className="text-danger" />
        )}
        {name}
      </span>
      <span className="text-right text-[11px] text-faint">{ok == null ? '检测中…' : ok ? hint : '未内置（需自行安装）'}</span>
    </div>
  )
}

export function PlayerSettingsPage() {
  const { settings, save } = useSettings()
  const [assets, setAssets] = useState<PlayerAssets | null>(null)
  const [checking, setChecking] = useState(false)

  const detect = async (): Promise<void> => {
    setChecking(true)
    const r = await api.player.assets()
    setChecking(false)
    if (r.ok) setAssets(r.data)
    else toast.error(r.error)
  }

  useEffect(() => {
    void detect()
  }, [])

  const builtinOf = (a: BuiltinAsset): boolean | null => {
    if (!assets) return null
    return a === 'ffmpeg' ? assets.ffmpeg : assets.aria2
  }

  // libmpv 可用（运行时 + 原生插件都在）——VLC 内核已删除，这里只用于提示是否缺运行时
  const mpvUsable = !!assets?.mpv

  return (
    <SubPage
      icon={MonitorPlay}
      title="播放器设置"
      desc="播放内核（libmpv）、FFmpeg 路径与播放器快捷键"
      actions={
        <Button size="sm" variant="outline" icon={RefreshCw} loading={checking} onClick={() => void detect()}>
          重新检测
        </Button>
      }
    >
      {/*
        播放器内核（v0.2.9）：VLC 内核已整体删除，这里不再让用户选内核，
        只显示当前内核状态 —— 免得留一个「选了也没用」的开关。
      */}
      <Card title="播放内核" desc="应用内置 libmpv（原生插件 + 子窗口输出），无需安装其它播放器">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-text">libmpv</div>
            <span
              className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${
                mpvUsable ? 'bg-ok/15 text-ok' : 'bg-elev2 text-faint'
              }`}
            >
              {assets === null ? '检测中' : mpvUsable ? '可用' : '缺失'}
            </span>
          </div>
          <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2.5 text-[11px] leading-relaxed text-dim">
            <span className="font-semibold text-text">说明：</span>
            <span className="text-faint">
              libmpv 由项目自带原生插件驱动（N-API 动态加载 libmpv-2.dll，在窗口内创建输出子窗口），
              控制栏 / 选集 / 字幕 / 弹幕全部走同一套实现。原生运行时缺失时开发环境需运行
              <code className="mx-1 font-mono">npm run libmpv:fetch</code> 与
              <code className="mx-1 font-mono">npm run mpv:build</code>。
            </span>
          </div>
        </div>
      </Card>

      {/* 画面比例 */}
      <Card title="画面比例" desc="视频与屏幕比例不一致时的填充方式（播放器控制栏右下角也可随时切换）">
        <div className="flex gap-2">
          {(
            [
              { mode: 'fit' as const, label: '适应', desc: '保持原比例，必要时留黑边（默认）' },
              { mode: 'cover' as const, label: '裁剪铺满', desc: '放大裁掉多余部分，铺满画面不变形' },
              { mode: 'stretch' as const, label: '拉伸铺满', desc: '强行拉满整屏，画面会变形' }
            ] as const
          ).map((o) => (
            <button
              key={o.mode}
              onClick={() => save({ aspectMode: o.mode })}
              className={`flex-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                (settings.aspectMode ?? 'fit') === o.mode
                  ? 'border-accent bg-accent-soft'
                  : 'border-border hover:border-accent/50'
              }`}
            >
              <div className="text-xs font-semibold text-text">{o.label}</div>
              <div className="mt-0.5 text-[10px] leading-snug text-faint">{o.desc}</div>
            </button>
          ))}
        </div>
      </Card>

      {/* FFmpeg 配置 */}
      <Card title="FFmpeg 配置" desc="转码回退与在线流中转使用（留空自动使用内置 FFmpeg）">
        <div className="flex flex-col gap-2.5">
          <Input
            placeholder="FFmpeg 路径（留空使用内置，用于转码回退）"
            value={settings.ffmpegPath}
            onChange={(e) => save({ ffmpegPath: e.target.value })}
          />
          <p className="text-[11px] leading-relaxed text-faint">
            当内置解码器无法直接播放（如 HEVC / 10bit / 非常规封装）时，应用会调用 FFmpeg 进行转码或 remux；留空时优先使用随包内置的 FFmpeg，
            填写路径可改用自行安装的版本（指向 ffmpeg.exe 所在目录或可执行文件）。
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <AssetLink asset="ffmpeg" url="https://www.gyan.dev/ffmpeg/builds/" builtin={builtinOf('ffmpeg')} />
          </div>
        </div>
      </Card>

      {/* 播放器快捷键（原独立小窗口内容已并入本页） */}
      <Card title="播放器快捷键" desc="自定义播放器控件快捷键（播放/暂停、快进、音量、选集、截屏等）">
        <ShortcutsPanel />
      </Card>

      {/* B 站弹幕（mpv 脚本，v0.2.8 附加七） */}
      <Card title="B 站弹幕（mpv 脚本）" desc="播放 B 站视频时用 yt-dlp + biliass 抓取并显示弹幕（仅 libmpv 内核生效）">
        <div className="flex flex-col gap-2.5">
          <label className="flex items-center gap-2 text-xs text-text">
            <input
              type="checkbox"
              checked={settings.biliDanmaku?.enabled === true}
              onChange={(e) => save({ biliDanmaku: { ...settings.biliDanmaku, enabled: e.target.checked } })}
              className="h-3.5 w-3.5 accent-accent"
            />
            启用 B 站弹幕（需要自行准备 yt-dlp 与 biliass）
          </label>
          <Input
            placeholder="yt-dlp 可执行文件路径（留空按 PATH 里的 yt-dlp）"
            value={settings.biliDanmaku?.ytdlpPath ?? ''}
            onChange={(e) => save({ biliDanmaku: { ...settings.biliDanmaku, ytdlpPath: e.target.value } })}
          />
          <Input
            placeholder="biliass 可执行文件路径（留空按 PATH 里的 biliass）"
            value={settings.biliDanmaku?.biliassPath ?? ''}
            onChange={(e) => save({ biliDanmaku: { ...settings.biliDanmaku, biliassPath: e.target.value } })}
          />
          <Input
            placeholder="临时目录 tmpdir（必填；留空用应用数据目录下的 tmp/danmaku）"
            value={settings.biliDanmaku?.tmpdir ?? ''}
            onChange={(e) => save({ biliDanmaku: { ...settings.biliDanmaku, tmpdir: e.target.value } })}
          />
          <Input
            placeholder="自定义 mpv 脚本路径（留空使用内置的 sakana-bdanmaku.lua；也可指向你下载的 bdanmaku.lua）"
            value={settings.biliDanmaku?.scriptPath ?? ''}
            onChange={(e) => save({ biliDanmaku: { ...settings.biliDanmaku, scriptPath: e.target.value } })}
          />
          <p className="text-[11px] leading-relaxed text-faint">
            管线：yt-dlp 取弹幕字幕（xml）→ biliass 转 ASS → 挂到播放器上。
            <span className="text-dim"> biliass 在 Windows 上必须有一个可写的临时目录</span>，否则弹幕下载会失败 ——
            留空时应用会自动用「应用数据目录/tmp/danmaku」并把它通过 <code className="font-mono">script-opts=tmpdir=…</code> 传给脚本。
            <span className="text-dim">开关或路径改动在下次进入播放器时生效</span>（libmpv 启动时才加载脚本）。
            运行日志里能看到 <code className="font-mono">[mpv] B 站弹幕脚本已启用</code> 与脚本自己的进度；
            脚本日志写在上面 tmpdir 下的 <code className="font-mono">sakana-bdanmaku.log</code>。
          </p>
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="text-dim">与「弹幕 → 渲染方式」的关系</span>：如果同时把渲染方式选成了 mpv 插件
            （uosc_danmaku），同一部 B 站番剧会出现两份弹幕（一份由本脚本挂成字幕、一份由插件画在画面上），
            建议按需二选一。
          </p>
          <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2 text-[11px] leading-relaxed text-faint">
            需要自行下载的两个组件（本机网络到 GitHub Release 不通，无法随包分发）：
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <button
                className="text-accent hover:underline whitespace-nowrap"
                onClick={() => void api.app.openPath('https://github.com/yt-dlp/yt-dlp/releases')}
              >
                yt-dlp 下载页
              </button>
              <button
                className="text-accent hover:underline whitespace-nowrap"
                onClick={() => void api.app.openPath('https://github.com/yutto-dev/biliass/releases')}
              >
                biliass 下载页
              </button>
            </div>
            <div className="mt-1">
              也可以直接使用社区里的 <code className="font-mono">bdanmaku</code> 脚本：把它下载到本地后填进上面的「自定义 mpv 脚本路径」，
              应用会自动把 tmpdir / ytdlp / biliass 三个参数拼进 <code className="font-mono">script-opts</code> 一并传过去。
            </div>
          </div>
        </div>
      </Card>

      {/* 内置组件与下载链接 */}
      <Card title="内置组件" desc="应用已内置 libmpv 与 FFmpeg，无需安装">
        <div className="flex flex-col gap-2">
          <div className="rounded-lg border border-border bg-elev2/50 px-3 py-2.5 text-[11px] leading-relaxed text-dim">
            <div className="mb-1 font-semibold text-text">开箱即用</div>
            <div className="text-faint">
              安装包已自带 libmpv 播放内核（含原生插件）以及 FFmpeg（转码/在线流中转），无需额外安装；
              aria2c 同样内置，供内置下载器使用。
              点击下面的下载链接时，若检测到已内置会先提示「已内置，通常无需下载」，再次点击才会打开下载页。
            </div>
          </div>

          <div className="rounded-lg border border-border bg-elev1 px-3 py-1.5">
            <AssetRow
              name="libmpv（播放内核 + 原生插件）"
              ok={assets?.mpv ?? null}
              hint="已内置，可播放"
            />
            <div className="border-t border-border" />
            <AssetRow name="FFmpeg（转码/流中转）" ok={assets?.ffmpeg ?? null} hint="已内置" />
            <div className="border-t border-border" />
            <AssetRow name="aria2c（内置下载器）" ok={assets?.aria2 ?? null} hint="已内置" />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <AssetLink
              asset="ffmpeg"
              url="https://www.gyan.dev/ffmpeg/builds/"
              label="下载 FFmpeg（可选）"
              builtin={builtinOf('ffmpeg')}
            />
          </div>
        </div>
      </Card>

      {/* 底部提示 */}
      <p className="text-center text-[11px] text-faint">
        改动实时保存，播放器下次启动/重新播放时生效；下载与缓存目录请在「文件保存配置」「缓存设置」中调整。
      </p>
    </SubPage>
  )
}

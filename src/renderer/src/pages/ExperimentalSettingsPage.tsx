import { useEffect, useState } from 'react'
import { FlaskConical, RefreshCw } from 'lucide-react'
import type { PlayerAssets } from '@shared/api'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, Input } from '@/components/ui'
import { AssetLink, Card, SubPage } from '@/components/SettingsShell'

/**
 * 测试性设置（/experimental-settings，v0.3.9 新增的设置项）。
 *
 * 用户原话：「FFmpeg 和播放器控制栏板块则放入测试性设置选项中」。
 *
 * 为什么这两块适合放一起：它们的共同点是「平时不用动，出问题时才来改」——
 * FFmpeg 是转码兜底/在线流中转的可执行文件路径（正常用户用内置的那份就够），
 * 播放器控制栏则是整套控制栏实现的切换（uosc 属于实验性，默认用应用自己的控制栏）。
 * 放在普通设置项里只会让「想调画质 / 音量」的人多滚两屏，所以单独归到「测试性」区域。
 *
 * 设置字段名没有变：`settings.ffmpegPath`、`settings.uoscControlBar`。
 */
export function ExperimentalSettingsPage() {
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

  return (
    <SubPage
      icon={FlaskConical}
      title="测试性设置"
      desc="实验性与排障用的开关：FFmpeg 路径、播放器控制栏实现。普通使用不需要改这里"
      maxWidth="max-w-2xl"
      actions={
        <Button size="sm" variant="outline" icon={RefreshCw} loading={checking} onClick={() => void detect()}>
          重新检测
        </Button>
      }
    >
      {/* ---------------- FFmpeg ---------------- */}
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
            <span className="text-dim"> 投屏的「中转并转码」策略同样走这条路径。</span>
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <AssetLink asset="ffmpeg" url="https://www.gyan.dev/ffmpeg/builds/" builtin={assets ? assets.ffmpeg : null} />
          </div>
        </div>
      </Card>

      {/* ---------------- 播放器控制栏 ---------------- */}
      <Card
        title="播放器控制栏"
        desc="默认使用应用自己的悬浮窗控制栏（含超分/画质按钮）；也可切换成 mpv 的 uosc 控制栏"
      >
        <div className="flex flex-col gap-2.5">
          <label className="flex items-center gap-2 text-xs text-text">
            <input
              type="checkbox"
              checked={settings.uoscControlBar === true}
              onChange={(e) => save({ uoscControlBar: e.target.checked })}
              className="h-3.5 w-3.5 accent-accent"
            />
            改用 mpv 的 uosc 控制栏（实验性）
          </label>
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="font-semibold text-text">默认（不勾选）：</span>
            用应用自己的悬浮窗控制栏 —— 进度条、播放控制、选集、字幕、倍速、画面比例、弹幕、
            <span className="text-dim">画质（Anime4K 超分）</span>、全屏与退出都在里面，
            按钮与菜单都是应用自己的界面，改起来、查起来都最直接。
          </p>
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="font-semibold text-text">勾选后：</span>
            控制栏改由 mpv 的 uosc 绘制（画在视频画面上）。布局与时间显示在
            <code className="mx-1 font-mono">resources/mpv-config/script-opts/uosc.conf</code>
            ，快捷键在
            <code className="mx-1 font-mono">resources/mpv-config/input.conf</code>
            ，按钮与菜单由
            <code className="mx-1 font-mono">resources/mpv-scripts/sakana-uosc-ctrl.lua</code>
            驱动。
            <span className="text-dim">
              {' '}
              切换在<strong className="font-medium">下次进入播放器</strong>时生效；无论用哪一个，
              弹幕画布、番剧详情浮层、选集抽屉都不受影响。
            </span>
          </p>
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="font-semibold text-text">uosc 模式怎么唤出：</span>
            鼠标移到画面下方（或任意位置移动，应用会主动唤出），控制栏就会浮现；
            <span className="text-dim">键盘兜底：</span>按 <code className="font-mono">Tab</code> 可显隐整条控制栏。
          </p>
        </div>
      </Card>

      {/* ---------------- 为什么在这里 ---------------- */}
      <Card title="说明" desc="为什么这些项被归为「测试性」">
        <div className="text-[11px] leading-relaxed text-faint">
          1. 两者都有<b>可用性够好的默认值</b>：FFmpeg 用内置那份、控制栏用应用自己实现的悬浮窗；
          只有在排障（转码失败、控制栏不显示）时才需要动。
          <br />
          2. 控制栏切换属于<b>整套实现二选一</b>，改错了会出现「两种控制栏都不显示」的观感问题，
          所以不放在日常调整的播放器设置里。
          <br />
          3. 改动都会实时写入设置；FFmpeg 路径在下次转码时生效，控制栏在下次进入播放器时生效。
        </div>
      </Card>
    </SubPage>
  )
}

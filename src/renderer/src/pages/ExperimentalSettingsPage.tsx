import { useEffect, useState } from 'react'
import { RefreshCw, SlidersHorizontal } from 'lucide-react'
import type { PlayerAssets } from '@shared/api'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, Input } from '@/components/ui'
import { AssetLink, Card, SubPage } from '@/components/SettingsShell'

/**
 * 测试设置（/experimental-settings）。
 *
 * V1.5.4：按用户要求，原「高级」模块删除，改名为「测试」；这里集中放
 * 仍处于测试阶段/排障用的选项（FFmpeg 路径、播放器控制栏），
 * 以及同模块里的「在线数据源」入口（4 个附加在线路径）。
 *
 * 为什么这两块适合放一起：它们的共同点是「平时不用动，出问题时才来改」——
 * FFmpeg 是转码兜底/在线流中转的可执行文件路径（正常用户用内置的那份就够），
 * 播放器控制栏则在 v1.1.4 固定成 uosc（旧自绘栏已剥离，这里只留说明，不再提供切换开关）。
 *
 * 设置字段 `settings.uoscControlBar` 还保留在类型里（旧 settings.json 兼容），
 * 但主进程与渲染层都已不再读它 —— 详见 shared/types.ts 的字段注释。
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
      icon={SlidersHorizontal}
      title="测试设置"
      desc="仍处于测试阶段与排障用的选项：FFmpeg 路径、播放器控制栏实现。普通使用不需要改这里"
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
        desc="v1.1.4 起固定使用 mpv 的 uosc 控制栏（旧的自绘控制栏已停用）"
      >
        <div className="flex flex-col gap-2.5">
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="font-semibold text-text">现在没有开关了：</span>
            uosc 是唯一控制栏。布局与时间显示在
            <code className="mx-1 font-mono">resources/mpv-config/script-opts/uosc.conf.base</code>
            （起播前会按当前主题生成同目录的
            <code className="mx-1 font-mono">uosc.conf</code>
            ），快捷键在
            <code className="mx-1 font-mono">resources/mpv-config/input.conf</code>
            ，按钮与菜单由
            <code className="mx-1 font-mono">resources/mpv-scripts/sakana-uosc-ctrl.lua</code>
            驱动。
          </p>
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="font-semibold text-text">为什么删掉切换：</span>
            旧的自绘控制栏已经整体搬到
            <code className="mx-1 font-mono">components/playerLegacy/PlayerOverlayBar.tsx</code>
            并停止渲染；再保留“切回应用控制栏”的开关只会得到一条控制栏都没有的结果，
            反而制造“按钮全失灵”的假故障。
          </p>
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="font-semibold text-text">uosc 模式怎么唤出：</span>
            鼠标移到画面下方（或任意位置移动，应用会主动唤出），控制栏就会浮现；
            <span className="text-dim">键盘兜底：</span>按 <code className="font-mono">Tab</code> 可显隐整条控制栏。
          </p>
        </div>
      </Card>

      {/* ---------------- 为什么在这里 ---------------- */}
      <Card title="说明" desc="为什么这些项被归为「测试」">
        <div className="text-[11px] leading-relaxed text-faint">
          1. 两者都有<b>可用性够好的默认值</b>：FFmpeg 用内置那份；控制栏从 v1.1.4 起固定用 uosc，
          不再提供切换。
          <br />
          2. 控制栏属于<b>整套实现</b>：旧自绘栏已剥离并停止渲染，所以这里只留下说明，
          不再放一个会把人带进“两种都不显示”的开关。
          <br />
          3. 改动都会实时写入设置；FFmpeg 路径在下次转码时生效。
        </div>
      </Card>
    </SubPage>
  )
}

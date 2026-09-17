import { useEffect, useState } from 'react'
import { MessageSquare, RotateCcw } from 'lucide-react'
import type { DanmakuSettings } from '@shared/types'
import { DEFAULT_DANMAKU_SETTINGS, resolveDanmakuSettings } from '@shared/types'
import { useSettings, toast } from '@/stores/app'
import { Button } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'

/**
 * 弹幕设置小窗口（/danmaku-settings，v0.2.8）。
 *
 * 播放器悬浮窗里的「弹幕设置」只放最常用的三项（覆盖区域 / 弹幕数量 / 时间轴），
 * 更细的项（字号、不透明度、滚动速度、显示类型、加粗、屏蔽词）都在这里。
 * 两处改的是同一份设置（`settings.danmaku`），关掉窗口立刻在播放器里生效。
 */
export function DanmakuSettingsPage() {
  const { settings, save } = useSettings()
  const [d, setD] = useState<DanmakuSettings>(() => resolveDanmakuSettings(settings?.danmaku))

  // 设置从主进程加载完成后再同步一次（首帧可能拿到默认值）
  useEffect(() => {
    setD(resolveDanmakuSettings(settings?.danmaku))
  }, [settings?.danmaku])

  const patch = (p: Partial<DanmakuSettings>): void => {
    const next = { ...d, ...p }
    setD(next)
    save({ danmaku: next })
  }

  return (
    <SubPage
      icon={MessageSquare}
      title="弹幕设置"
      desc="弹幕来自弹弹play 弹幕库，按番剧名与集数自动匹配；本地播放同样可用"
      maxWidth="max-w-xl"
      actions={
        <Button
          size="sm"
          variant="outline"
          icon={RotateCcw}
          onClick={() => {
            setD({ ...DEFAULT_DANMAKU_SETTINGS })
            save({ danmaku: { ...DEFAULT_DANMAKU_SETTINGS } })
            toast.success('已恢复弹幕默认设置')
          }}
        >
          恢复默认
        </Button>
      }
    >
      <Card title="渲染方式" desc="两种方式用的是同一份弹幕数据（季集判定与多来源合并都由应用完成）">
        <Row
          label="由谁绘制"
          desc="内置画布与控制栏同层，几乎不吃性能；mpv 插件用字幕层渲染，自带样式/搜索菜单"
        >
          <Pill active={d.renderer !== 'uosc'} onClick={() => patch({ renderer: 'canvas' })}>
            内置画布
          </Pill>
          <Pill active={d.renderer === 'uosc'} onClick={() => patch({ renderer: 'uosc' })}>
            mpv 插件（uosc_danmaku）
          </Pill>
        </Row>
        <div className="border-t border-border pt-2.5 text-[11px] leading-relaxed text-faint">
          选择「mpv 插件」后，进入播放器时应用会把这一集的弹幕交给内置的 <code className="font-mono">uosc_danmaku</code>{' '}
          插件渲染（附带 uosc 菜单）：画面上的弹幕由 mpv 的字幕层绘制，
          播放器控制栏的「弹幕设置」里会多出一行<b>插件菜单</b>（搜索弹幕 / 弹幕样式 / 源延迟 / 总菜单）。
          改动在<b>下次进入播放器</b>时生效（插件随播放内核一起加载）。
          插件取不到弹幕时会自动回落到内置画布，不会出现「两边都没有」。
        </div>
      </Card>

      <Card title="显示" desc="影响画面上的弹幕观感">
        <Toggle label="显示弹幕" desc="关闭后完全不绘制弹幕（数据仍会匹配）" value={d.enabled} onChange={(v) => patch({ enabled: v })} />
        <Row label="覆盖区域" desc="弹幕只占画面上方多大范围">
          {[
            { v: 0.25, t: '1/4' },
            { v: 0.5, t: '1/2' },
            { v: 0.75, t: '3/4' },
            { v: 1, t: '全屏' }
          ].map((o) => (
            <Pill key={o.t} active={Math.abs(d.area - o.v) < 0.01} onClick={() => patch({ area: o.v })}>
              {o.t}
            </Pill>
          ))}
        </Row>
        <Row label="弹幕数量" desc="同一屏最多显示多少条">
          {[10, 20, 30, 50, 80, 120].map((n) => (
            <Pill key={n} active={d.maxCount === n} onClick={() => patch({ maxCount: n })}>
              {n}
            </Pill>
          ))}
        </Row>
        <Row label="显示类型" desc="按弹幕位置分类过滤">
          <Pill active={d.showScroll} onClick={() => patch({ showScroll: !d.showScroll })}>
            滚动
          </Pill>
          <Pill active={d.showTop} onClick={() => patch({ showTop: !d.showTop })}>
            顶部
          </Pill>
          <Pill active={d.showBottom} onClick={() => patch({ showBottom: !d.showBottom })}>
            底部
          </Pill>
        </Row>
        <Row label="字号" desc="越大越显眼，也越容易挡画面">
          {[16, 18, 20, 22, 26, 30, 34].map((n) => (
            <Pill key={n} active={d.fontSize === n} onClick={() => patch({ fontSize: n })}>
              {n}
            </Pill>
          ))}
        </Row>
        <Row label="不透明度">
          {[0.4, 0.6, 0.8, 0.9, 1].map((n) => (
            <Pill key={n} active={Math.abs(d.opacity - n) < 0.01} onClick={() => patch({ opacity: n })}>
              {Math.round(n * 100)}%
            </Pill>
          ))}
        </Row>
        <Row label="滚动速度" desc="一条弹幕穿过屏幕所需秒数，越小越快">
          {[5, 6, 8, 10, 12].map((n) => (
            <Pill key={n} active={d.speedSec === n} onClick={() => patch({ speedSec: n })}>
              {n}s
            </Pill>
          ))}
        </Row>
        <Toggle label="加粗描边" desc="复杂画面上更清楚" value={d.bold} onChange={(v) => patch({ bold: v })} />
      </Card>

      <Card title="时间轴" desc="弹幕与画面不同步时在这里微调（正数 = 弹幕提前出现）">
        <Row label="偏移">
          {[-2000, -1000, -500, 0, 500, 1000, 2000].map((ms) => (
            <Pill key={ms} active={d.offsetMs === ms} onClick={() => patch({ offsetMs: ms })}>
              {ms === 0 ? '0' : `${ms > 0 ? '+' : ''}${(ms / 1000).toFixed(1)}s`}
            </Pill>
          ))}
        </Row>
        <Row label="细调">
          <Button size="sm" variant="outline" onClick={() => patch({ offsetMs: Math.max(-10000, d.offsetMs - 100) })}>
            −0.1s
          </Button>
          <span className="min-w-[64px] text-center text-xs tabular-nums text-dim">{(d.offsetMs / 1000).toFixed(1)}s</span>
          <Button size="sm" variant="outline" onClick={() => patch({ offsetMs: Math.min(10000, d.offsetMs + 100) })}>
            +0.1s
          </Button>
        </Row>
      </Card>

      <Card title="屏蔽" desc="命中任一关键词的弹幕不显示（逗号或换行分隔）">
        <textarea
          value={d.blockWords}
          onChange={(e) => patch({ blockWords: e.target.value })}
          rows={3}
          placeholder="例如：剧透, 广告, 前方高能"
          className="w-full resize-y rounded-lg border border-border bg-elev2 px-3 py-2 text-xs text-text outline-none placeholder:text-faint focus:border-accent"
        />
      </Card>

      <Card title="说明" desc="关于弹幕来源">
        <div className="text-[11px] leading-relaxed text-faint">
          弹幕按「番剧名 + 集数」自动匹配弹幕库，找不到对应条目时播放器会显示「未找到弹幕」，不影响播放。
          同一集只会请求一次，之后走本地缓存；播放器悬浮窗里的「重新检测弹幕」可以强制重新拉取，
          「别名检测弹幕」则会连别名一起搜（番剧名与弹幕库标题对不上时用它）。
        </div>
      </Card>
    </SubPage>
  )
}

function Row({
  label,
  desc,
  children
}: {
  label: string
  desc?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border py-2.5 first:border-t-0">
      <div className="min-w-0">
        <div className="text-xs text-text">{label}</div>
        {desc ? <div className="mt-0.5 text-[11px] text-faint">{desc}</div> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{children}</div>
    </div>
  )
}

function Pill({
  active,
  onClick,
  children
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-[11px] transition-colors ${
        active ? 'border-accent bg-accent-soft text-accent' : 'border-border text-dim hover:border-accent/50'
      } whitespace-nowrap `}
    >
      {children}
    </button>
  )
}

function Toggle({
  label,
  desc,
  value,
  onChange
}: {
  label: string
  desc?: string
  value: boolean
  onChange: (v: boolean) => void
}): React.ReactElement {
  return (
    <Row label={label} desc={desc}>
      <button
        onClick={() => onChange(!value)}
        className={`relative h-6 w-11 rounded-full transition-colors ${value ? 'bg-accent' : 'bg-elev3'}`}
        title={value ? '已开启' : '已关闭'}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${value ? 'left-[22px]' : 'left-0.5'}`}
        />
      </button>
    </Row>
  )
}

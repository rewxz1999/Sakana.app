import { useEffect, useState } from 'react'
import { MessageSquare, RotateCcw } from 'lucide-react'
import type { DanmakuSettings } from '@shared/types'
import { DEFAULT_DANMAKU_SETTINGS, resolveDanmakuSettings } from '@shared/types'
import { api } from '@/lib/api'
import { useSettings, toast } from '@/stores/app'
import { useSourceCatalog } from '@/components/danmaku/useSourceCatalog'
import { DanmakuSourcesCard } from '@/components/danmaku/DanmakuSourcesCard'
import { DanmakuBoxCard } from '@/components/danmaku/DanmakuBoxCard'
import { DanmakuLibraryCard } from '@/components/danmaku/DanmakuLibraryCard'
import { DanmakuFetchLogCard } from '@/components/danmaku/DanmakuFetchLogCard'
import { DanmakuEnabledSourcesCard } from '@/components/danmaku/DanmakuEnabledSourcesCard'
import { Button, Input } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'

/**
 * 弹幕设置小窗口（/danmaku-settings，v0.2.8）。
 *
 * 播放器悬浮窗里的「弹幕设置」只放最常用的三项（覆盖区域 / 弹幕数量 / 时间轴），
 * 更细的项（字号、不透明度、滚动速度、显示类型、加粗、屏蔽词）都在这里。
 * 两处改的是同一份设置（`settings.danmaku`），关掉窗口立刻在播放器里生效。
 *
 * v0.3.9：用户要求「B 站弹幕板块放在弹幕设置中」，于是原「播放器设置」里的
 * 「B 站弹幕（mpv 脚本）」整块搬到这里 —— 它本来就是弹幕来源相关（yt-dlp + biliass 管线），
 * 放在播放器设置里既难找、也和画质/音频那几块混在一起。设置字段仍是 `settings.biliDanmaku`。
 *
 * V1.1（本次）：新增「弹幕数据源」集合器 + 「弹幕盒子」检索下载 + 「本地弹幕库」管理三块。
 * 集合器状态由本页统一持有（`useSourceCatalog`）再传给三个卡片 —— 三处共用一份，
 * 不会各拉一次接口、也不会改完互相不同步。
 */
export function DanmakuSettingsPage() {
  const { settings, save } = useSettings()
  const [d, setD] = useState<DanmakuSettings>(() => resolveDanmakuSettings(settings?.danmaku))
  // 数据源集合器（含本地弹幕库）：三个卡片共用这一份状态
  const catalog = useSourceCatalog()

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
      desc="链路：弹幕源 → 获取器 → 本地缓存 → 集成器（多源合并）→ 播放器。进播放器先查缓存，没缓存才按优先级并行请求；默认启用巴哈姆特"
      maxWidth="max-w-2xl"
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

      {/* ---------------- V1.2：启用源 + 四项样式设置 ---------------- */}
      <DanmakuEnabledSourcesCard catalog={catalog} />

      <Card
        title="弹幕设置（样式）"
        desc="用户要求的四项：播放区域、播放速度、字体大小、弹幕时序（相对画面的偏移）"
      >
        <Row label="弹幕播放区域" desc="弹幕只占画面上方多大范围（底部弹幕仍贴画面底部）">
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
        <Row label="弹幕播放速度" desc="一条滚动弹幕穿过屏幕所需秒数，越小越快">
          {[5, 6, 8, 10, 12].map((n) => (
            <Pill key={n} active={d.speedSec === n} onClick={() => patch({ speedSec: n })}>
              {n}s
            </Pill>
          ))}
        </Row>
        <Row label="弹幕字体大小" desc="字号（px）；顶部/底部弹幕另受「特殊弹幕调整」的倍率影响">
          {[16, 18, 20, 22, 26, 30, 34].map((n) => (
            <Pill key={n} active={d.fontSize === n} onClick={() => patch({ fontSize: n })}>
              {n}
            </Pill>
          ))}
        </Row>
        <Row label="弹幕时序" desc="弹幕相对画面的偏移（正数 = 弹幕提前出现）；两种渲染方式共用">
          {[-2000, -1000, -500, 0, 500, 1000, 2000].map((ms) => (
            <Pill key={ms} active={d.offsetMs === ms} onClick={() => patch({ offsetMs: ms })}>
              {ms === 0 ? '0' : `${ms > 0 ? '+' : ''}${(ms / 1000).toFixed(1)}s`}
            </Pill>
          ))}
        </Row>
        <Row label="时序细调">
          <Button size="sm" variant="outline" onClick={() => patch({ offsetMs: Math.max(-10000, d.offsetMs - 100) })}>
            −0.1s
          </Button>
          <span className="min-w-[64px] text-center text-xs tabular-nums text-dim">{(d.offsetMs / 1000).toFixed(1)}s</span>
          <Button size="sm" variant="outline" onClick={() => patch({ offsetMs: Math.min(10000, d.offsetMs + 100) })}>
            +0.1s
          </Button>
        </Row>
      </Card>
      <DanmakuSourcesCard catalog={catalog} />
      <DanmakuBoxCard />
      <DanmakuLibraryCard catalog={catalog} />
      {/* v1.1.2：每次去数据源要弹幕的记录（排障用，默认折叠） */}
      <DanmakuFetchLogCard />

      <Card title="显示" desc="影响画面上的弹幕观感（区域/速度/字号/时序在上一张卡片）">
        <Toggle label="显示弹幕" desc="关闭后完全不绘制弹幕（数据仍会匹配）" value={d.enabled} onChange={(v) => patch({ enabled: v })} />
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
        <Row label="不透明度">
          {[0.4, 0.6, 0.8, 0.9, 1].map((n) => (
            <Pill key={n} active={Math.abs(d.opacity - n) < 0.01} onClick={() => patch({ opacity: n })}>
              {Math.round(n * 100)}%
            </Pill>
          ))}
        </Row>
        <Toggle label="加粗" desc="复杂画面上更清楚" value={d.bold} onChange={(v) => patch({ bold: v })} />
        {/* v0.3.8：描边与阴影分开控制，用户可按画面风格取舍 */}
        <Toggle label="描边" desc="文字外描一圈黑边，亮画面上最清晰" value={d.outline !== false} onChange={(v) => patch({ outline: v })} />
        <Toggle label="阴影" desc="柔和一点；与描边同开时最清楚" value={d.shadow === true} onChange={(v) => patch({ shadow: v })} />
      </Card>

      <Card
        title="详细弹幕设置"
        desc="排障与精细控制：误差、特殊弹幕、获取器记录、缓存目录、本地弹幕查看/删除、获取规则、启用源"
      >
        <Row label="弹幕误差" desc="多源合并时，时间相差多少毫秒以内算同一条（越大去重越狠；默认 100ms）">
          {[50, 100, 200, 300, 500].map((ms) => (
            <Pill key={ms} active={d.errorToleranceMs === ms} onClick={() => patch({ errorToleranceMs: ms })}>
              {ms}ms
            </Pill>
          ))}
        </Row>
        <div className="border-t border-border pt-2.5 text-[11px] font-medium text-dim">特殊弹幕调整</div>
        <Row label="特殊弹幕字号" desc="顶部/底部弹幕相对普通弹幕的倍率（特殊弹幕不滚动，太大容易挡画面）">
          {[0.8, 0.9, 1, 1.1, 1.2, 1.4].map((n) => (
            <Pill key={n} active={Math.abs((d.specialScale ?? 1) - n) < 0.01} onClick={() => patch({ specialScale: n })}>
              ×{n}
            </Pill>
          ))}
        </Row>
        <Row label="特殊弹幕停留" desc="顶部/底部弹幕在画面上停留几秒">
          {[2, 3, 4, 5, 6].map((n) => (
            <Pill key={n} active={d.specialDurationSec === n} onClick={() => patch({ specialDurationSec: n })}>
              {n}s
            </Pill>
          ))}
        </Row>
        {/* 下面这些是"入口说明"：真正的控件在对应的卡片里（保持一个功能只有一个实现） */}
        <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2.5 text-[11px] leading-relaxed text-faint">
          <div>
            <b className="text-dim">显示弹幕获取器记录</b>：见上方「显示弹幕获取器记录」卡片 —— 每次去哪个源、用什么关键词、
            花了多久、拿到多少条/为什么没拿到，都在那里。
          </div>
          <div>
            <b className="text-dim">选择弹幕数据缓存文件夹</b> / <b className="text-dim">在应用内查看本地弹幕</b> /{' '}
            <b className="text-dim">选择本地弹幕删除</b>：见上方「本地弹幕缓存」卡片（文件按
            <code className="mx-1 font-mono">&lt;缓存根&gt;/弹幕/&lt;番剧名&gt;/第01集-&lt;源名&gt;.xml</code>
            存放，文件名带来源名）。
          </div>
          <div>
            <b className="text-dim">为弹幕获取器添加新的弹幕规则</b>：见上方「弹幕获取规则」卡片（可加巴哈反代、
            弹幕盒子、直链模板，并逐条真测试）。
          </div>
          <div>
            <b className="text-dim">选择启用弹幕源</b>：本页最上面的「选择启用弹幕源」，默认只启用巴哈姆特动画疯。
          </div>
        </div>
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

      {/* ---------------- B 站弹幕（v0.3.9 从播放器设置搬入） ---------------- */}
      <Card
        title="B 站弹幕（mpv 脚本）"
        desc="播放 B 站视频时用 yt-dlp + biliass 抓取并显示弹幕（仅 libmpv 内核生效）"
      >
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
            留空时应用会自动用「应用数据目录/tmp/danmaku」并把它通过{' '}
            <code className="font-mono">script-opts=tmpdir=…</code> 传给脚本。
            <span className="text-dim">开关或路径改动在下次进入播放器时生效</span>（libmpv 启动时才加载脚本）。
            运行日志里能看到 <code className="font-mono">[mpv] B 站弹幕脚本已启用</code> 与脚本自己的进度；
            脚本日志写在上面 tmpdir 下的 <code className="font-mono">sakana-bdanmaku.log</code>。
          </p>
          <p className="text-[11px] leading-relaxed text-faint">
            <span className="text-dim">与上面「渲染方式」的关系</span>：如果同时把渲染方式选成了 mpv 插件
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
              也可以直接使用社区里的 <code className="font-mono">bdanmaku</code> 脚本：把它下载到本地后填进上面的「自定义
              mpv 脚本路径」，应用会自动把 tmpdir / ytdlp / biliass 三个参数拼进{' '}
              <code className="font-mono">script-opts</code> 一并传过去。
            </div>
          </div>
        </div>
      </Card>

      <Card title="说明" desc="关于弹幕来源与加载顺序">
        <div className="text-[11px] leading-relaxed text-faint">
          链路是「弹幕源 → 获取器 → 本地缓存 → 集成器 → 播放器」：每个源各自搜索、取该集、
          写成带来源名的缓存文件；集成器再按「时间 + 正文」去重、按时间排序后交给播放器。
          <div className="mt-1.5">
            进播放器时的顺序：<b className="text-dim">先查每个启用源 + 内置弹弹play 的本地缓存</b>
            （命中就直接用，不发请求）→ 缓存缺失的部分才并行请求。第一段先上屏，第二段回来后再合并，
            所以"快"和"源一定要被调用"同时成立。播放器状态区会写明
            <b className="text-dim">每个源各多少条、哪些来自缓存</b>；全部失败时「显示弹幕获取器记录」里
            能看到每个源各自的原因（未匹配 / 下载失败 / 格式不支持）。
          </div>
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

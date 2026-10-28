import { Radar, Split, Zap } from 'lucide-react'
import { MAX_CONNECTIONS, MIN_CONNECTIONS, SNIFF_TECH_NOTES, resolveSniffSettings } from '@shared/sniff'
import { Button, Switch } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'
import { StreamBoostCard } from '@/components/StreamBoostCard'
import { useSettings } from '@/stores/app'

/**
 * 嗅探设置（V1.5.1，路由 `/sniff-settings`）。
 *
 * 用户要求：「设置中增加嗅探设置，并说明采用了什么技术，原先的加速模块也放到这个设置中。」
 *
 * 三块内容：
 *   1. **技术说明**（`SNIFF_TECH_NOTES`）：把"我们到底做了什么加速"讲清楚，
 *      而不是只给几个开关让用户猜 —— 用户明确要求"说明采用了什么技术"；
 *   2. **取流加速参数**（多连接分段 / 自适应 / 请求头伪装 / 小文件阈值）；
 *   3. **原来的在线播放加速器**（StreamBoostCard，原样搬来，不再单独占一个入口）。
 *
 * 默认值全部来自 `@shared/sniff`，与主进程 mediaCache 用的同一份；界面不写死任何数字。
 */
export function SniffSettingsPage() {
  const { settings, save } = useSettings()
  const cfg = resolveSniffSettings(settings.sniff)

  /** 只改一个字段：其余字段原样保留（否则会把手里的旧值覆盖成默认） */
  const patch = (next: Partial<typeof cfg>): void => {
    save({ sniff: { ...(settings.sniff ?? {}), ...next } })
  }

  return (
    <SubPage
      icon={Radar}
      title="嗅探设置"
      desc="在线播放取流：Range 多连接分段下载、自适应并发、请求头伪装与本地缓存加速"
      maxWidth="max-w-2xl"
    >
      <Card title="采用的技术" desc="这些都在取流缓存链路里真实生效，不是开关摆设">
        <div className="flex flex-col gap-2.5">
          {SNIFF_TECH_NOTES.map((note) => (
            <div key={note.title} className="rounded-lg border border-border bg-elev2/50 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-text">
                <Zap size={12} className="text-accent" />
                {note.title}
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-faint">{note.desc}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="取流加速" desc="只影响「下载缓存」这一层，不改变站点/规则本身的行为">
        <div className="flex flex-col gap-3">
          <label className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-xs text-text">
                <Split size={12} className="text-accent" /> HTTP Range 多连接分段下载
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-faint">
                先探测源站是否支持 Range，支持就把一集切成 N 段并行拉取。不支持的站点会自动退回单连接。
              </span>
            </span>
            <Switch checked={cfg.multiConnection} onChange={(v) => patch({ multiConnection: v })} />
          </label>

          <div className={`flex flex-col gap-2 border-t border-border pt-3 ${cfg.multiConnection ? '' : 'opacity-50'}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-text">连接数</span>
              <span className="text-[11px] tabular-nums text-accent">{cfg.connections} 条</span>
            </div>
            <div className="flex items-center gap-1.5">
              {Array.from({ length: MAX_CONNECTIONS - MIN_CONNECTIONS + 1 }, (_, i) => MIN_CONNECTIONS + i).map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={!cfg.multiConnection}
                  onClick={() => patch({ connections: n })}
                  className={`h-7 w-7 rounded-md border text-[11px] tabular-nums transition-colors disabled:cursor-not-allowed ${
                    cfg.connections === n
                      ? 'border-accent bg-accent-soft font-semibold text-accent'
                      : 'border-border text-dim hover:border-accent/50'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-faint">
              不是越大越好：站点对「单 IP 总连接数」也有限制，4 条在多数 CDN 上是稳的。
            </p>
          </div>

          <label className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-text">自适应并发</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-faint">
                分段全部成功且速度偏低时加一条连接；出现失败立刻减一条（宁可慢一点，也别被站点封）
              </span>
            </span>
            <Switch
              checked={cfg.adaptive}
              disabled={!cfg.multiConnection}
              onChange={(v) => patch({ adaptive: v })}
            />
          </label>

          <label className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-text">请求头伪装</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-faint">
                补齐 Origin / Accept-Language / Sec-Fetch-*，并强制 identity 编码（避免压缩字节写进缓存）
              </span>
            </span>
            <Switch checked={cfg.headerSpoof} onChange={(v) => patch({ headerSpoof: v })} />
          </label>

          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-text">小于该体积不分段</span>
              <span className="mt-0.5 block text-[11px] text-faint">
                小文件单连接就够，多开会增加请求数。当前：{cfg.minFileMB} MB
              </span>
            </span>
            <div className="flex items-center gap-1">
              {[8, 16, 32, 64].map((mb) => (
                <Button
                  key={mb}
                  size="sm"
                  variant={cfg.minFileMB === mb ? 'soft' : 'ghost'}
                  onClick={() => patch({ minFileMB: mb })}
                >
                  {mb}M
                </Button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* 原先的「在线播放设置」整块搬进来（档位 / 实时状态 / 优化记录 / 对比图） */}
      <StreamBoostCard />
    </SubPage>
  )
}

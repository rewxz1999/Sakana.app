import type { DanmakuFetcherId } from '@shared/types'
import { resolveDanmakuSettings } from '@shared/types'
import { useSettings } from '@/stores/app'
import { Card } from '@/components/SettingsShell'
import type { SourceCatalogState } from './useSourceCatalog'

/**
 * 「选择启用弹幕源」（V1.2，用户要求：默认启用巴哈姆特）。
 *
 * 为什么单独一张卡片而不是继续用下面「获取规则」里的开关：
 *   规则表是高级配置（可填自建反代、关键词、直链），新用户一进来是空的；
 *   用户要的是"打开就能用巴哈"，所以这里放两个**内置源**的开关，
 *   默认 `['bahamut']`（弹幕盒子以 2019–2021 存档为主，新番基本搜不到，不默认开）。
 *
 * 与规则表的关系：如果用户在下面给巴哈配了一条**启用**的规则（例如自建反代），
 * 主进程会优先用那条规则的基址，这里不需要重复配置；两个开关只决定"是否参与自动加载"。
 */
const OPTIONS: { id: DanmakuFetcherId; name: string; desc: string }[] = [
  {
    id: 'bahamut',
    name: '巴哈姆特动画疯',
    desc: '新番最全；用日文原名/繁体名搜索（应用会自动从番剧库取原名）。默认启用。'
  },
  {
    id: 'danmubox',
    name: '弹幕盒子',
    desc: '2019–2021 的存档合集（含 B 站/优酷/爱奇艺等来源），新番基本搜不到；需要老番时再开。'
  }
]

export function DanmakuEnabledSourcesCard({ catalog }: { catalog: SourceCatalogState }): React.ReactElement {
  const { settings, save } = useSettings()
  const d = resolveDanmakuSettings(settings?.danmaku)
  const enabled = new Set<DanmakuFetcherId>(d.enabledSources ?? ['bahamut'])

  const toggle = (id: DanmakuFetcherId, on: boolean): void => {
    const next = new Set(enabled)
    if (on) next.add(id)
    else next.delete(id)
    save({ danmaku: { ...d, enabledSources: [...next] } })
  }

  return (
    <Card
      title="选择启用弹幕源"
      desc="进播放器时自动去这些源取弹幕；默认只启用巴哈姆特动画疯。关掉后仍可在下面手动测试/下载"
    >
      <div className="flex flex-col gap-2">
        {OPTIONS.map((opt) => {
          const adapter = catalog.registry?.adapters.find((a) => a.id === opt.id)
          const on = enabled.has(opt.id)
          return (
            <label
              key={opt.id}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                on ? 'border-accent/40 bg-accent-soft/40' : 'border-border bg-elev2/40'
              }`}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => toggle(opt.id, e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-text">
                  {opt.name}
                  <span className="rounded-full bg-elev3 px-1.5 py-0.5 text-[10px] text-faint">内置源</span>
                  {opt.id === 'bahamut' && on ? (
                    <span className="rounded-full bg-ok/15 px-1.5 py-0.5 text-[10px] text-ok">默认</span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-faint">
                  {adapter?.desc ?? opt.desc}
                </span>
              </span>
            </label>
          )
        })}
      </div>
      <div className="mt-2 text-[11px] leading-relaxed text-faint">
        两个都开时按「获取规则」里的优先级并行取，结果由集成器按「时间 + 正文」去重合并。
        当前启用：{enabled.size > 0 ? [...enabled].map((id) => OPTIONS.find((o) => o.id === id)?.name ?? id).join('、') : '（没有启用任何源）'}
      </div>
    </Card>
  )
}

import { Ban, ListFilter, ShieldOff, Tags } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, OpenRow, SubPage } from '@/components/SettingsShell'
import { useScheduleBlockData } from './scheduleBlockData'

/**
 * 番剧表设置（/schedule-settings，v0.3.9 调整为「番剧表与过滤」区域的总览页）。
 *
 * 用户原话：「将番剧表设置中的黑名单和屏蔽表做成单独的设置选项，将番剧表设置、黑名单、
 * 屏蔽表划为一个区域的设置选项，并将这个区域与外观设置区域分开」。
 *
 * 于是本页不再堆表单，只负责：
 * 1. 说明番剧表这条线的屏蔽现状（本周会被屏蔽多少部、都是什么原因）；
 * 2. 给出「黑名单」「屏蔽表」两个子入口（它们各自是独立设置项）；
 * 3. 讲清生效范围 —— 这里的一切只作用于番剧表。
 *
 * 设置数据仍在同一个 store 键 `scheduleBlock` 上，键名与字段名都没变。
 */
export function ScheduleSettingsPage() {
  const { cfg, weekCount, blockedCount, reasonStats, tagRulesOn, tagDone, tagFailedInWeek, fetchingTags, listReady } =
    useScheduleBlockData()

  /** 屏蔽表当前生效的规则条数（三档分级里开着的 + 自定义关键词数），作为入口行右侧的现状提示 */
  const ruleCount = [cfg.l1, cfg.l2, cfg.l3].filter(Boolean).length + cfg.customTags.length

  const openSmall = (hash: string, width: number, height: number, title: string): void => {
    void api.window.openSmall(hash, { width, height, title })
  }

  return (
    <SubPage
      icon={ListFilter}
      title="番剧表设置"
      desc="番剧表这条线的屏蔽总览：本周会被屏蔽多少部、按什么规则屏蔽，以及黑名单 / 屏蔽表两个子设置"
      maxWidth="max-w-2xl"
    >
      {/* ---------------- 现状总览 ---------------- */}
      <Card title="本周屏蔽情况" desc="按当前设置统计（数据来自本周番剧表，与你打开番剧表看到的一致）">
        {!listReady ? (
          <div className="text-[11px] text-faint">正在读取番剧表…</div>
        ) : weekCount === 0 ? (
          <div className="text-[11px] leading-relaxed text-faint">
            暂时读不到番剧表数据（数据源不可用），稍后再试；黑名单与屏蔽表本身仍可正常编辑。
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dim">
              <span className="flex items-center gap-1.5">
                <Tags size={12} className="text-accent" />
                本周共 {weekCount} 部，会被屏蔽 {blockedCount} 部
              </span>
              {tagRulesOn ? (
                <span className="text-faint">
                  标签缓存 {tagDone}/{weekCount}
                  {fetchingTags ? '（补齐中…）' : ''}
                </span>
              ) : (
                <span className="text-faint">屏蔽表未启用任何标签规则：不会请求任何番剧详情</span>
              )}
              {tagRulesOn && tagFailedInWeek > 0 ? (
                <span className="text-warn">· {tagFailedInWeek} 部未取到标签（这些不会被屏蔽）</span>
              ) : null}
            </div>

            {Object.keys(reasonStats).length > 0 ? (
              <div className="mt-2 flex flex-col gap-1">
                {Object.entries(reasonStats)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, count]) => (
                    <div key={reason} className="flex items-center justify-between text-[11px]">
                      <span className="text-dim">{reason}</span>
                      <span className="tabular-nums text-faint">{count} 部</span>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="mt-2 text-[11px] leading-relaxed text-faint">
                当前没有任何条目被屏蔽：黑名单为空，屏蔽表也没命中本周番剧。
              </div>
            )}
          </>
        )}
      </Card>

      {/* ---------------- 两个子设置入口 ---------------- */}
      <Card title="屏蔽设置" desc="两者分工不同：屏蔽表管规则，黑名单管具体番剧">
        <div className="flex flex-col">
          <OpenRow
            icon={ShieldOff}
            title="屏蔽表"
            desc="按标签 / 关键词批量屏蔽（一~三级分级标签 + 四级自定义关键词），只作用于番剧表"
            aside={`${ruleCount} 条规则`}
            onOpen={() => openSmall('/schedule-blocklist', 720, 640, '屏蔽表')}
          />
          <div className="my-1 border-t border-border" />
          <OpenRow
            icon={Ban}
            title="黑名单"
            desc="针对某一部具体番剧的屏蔽清单（优先级最高），从本周番剧表点选加入或移出"
            aside={`${cfg.blacklist.length} 部`}
            onOpen={() => openSmall('/schedule-blacklist', 720, 640, '黑名单')}
          />
        </div>
      </Card>

      {/* ---------------- 说明 ---------------- */}
      <Card title="说明" desc="生效范围与降级行为">
        <div className="text-[11px] leading-relaxed text-faint">
          1. <b>只影响番剧表</b>：搜索结果、收藏、番剧详情、订阅与下载都不受这里任何设置的影响。
          <br />
          2. 标签来自<b>番剧详情</b>（番剧表接口本身不返回标签），应用会按需逐条补全并缓存 7 天；
          首次开启屏蔽规则时需要几秒才会陆续生效，期间会显示「标签缓存 x/y」。
          <br />
          3. <b>没取到标签的番剧一律不屏蔽</b>（宁可不屏蔽，也不能误杀）；数据源不可用时最多连续失败 4 次就停止补全。
          <br />
          4. 番剧表被屏蔽时，表格上方会有一条提示条，并带「临时显示全部」开关（只当次有效，不写进设置）。
        </div>
      </Card>
    </SubPage>
  )
}

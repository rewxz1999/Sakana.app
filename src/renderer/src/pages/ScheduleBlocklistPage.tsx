import { useEffect, useRef, useState } from 'react'
import { RotateCcw, Tags, ShieldOff } from 'lucide-react'
import { BLOCK_LEVELS, DEFAULT_SCHEDULE_BLOCK, parseCustomTags } from '@shared/scheduleBlock'
import { Button, Switch } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'
import { toast } from '@/stores/app'
import { useScheduleBlockData } from './scheduleBlockData'

/**
 * 屏蔽表（/schedule-blocklist，v0.3.9 从「番剧表设置」拆出的独立设置项）。
 *
 * 为什么拆出来：用户原话「将番剧表设置中的黑名单和屏蔽表做成单独的设置选项」——
 * 原来一个页面里堆了「分级标签屏蔽 + 自定义标签 + 黑名单 + 状态 + 说明」五块，
 * 想改一条标签规则要先在一屏里找到它。拆开后本页只负责「按标签/关键词屏蔽」的规则表，
 * 按具体番剧屏蔽的清单在「黑名单」页。
 *
 * 设置仍然写在同一个 store 键（scheduleBlock）里，字段名（l1/l2/l3/customTags/blacklist）
 * 一个都没变 —— 老用户升级后规则原样生效，只是界面位置变了。
 */
export function ScheduleBlocklistPage() {
  const { cfg, patch, weekCount, blockedCount, reasonStats, tagRulesOn, tagDone, tagFailedInWeek, fetchingTags } =
    useScheduleBlockData()

  /**
   * 自定义标签的**原始输入文本**：必须存原文，
   * 否则「后宫, 」这种半截输入会被解析结果回写吃掉（原番剧表设置页的老问题，这里原样保留）。
   */
  const [customText, setCustomText] = useState('')
  const lastWrittenRef = useRef('')

  // 配置被外部改动（例如另一个窗口改了）时回写文本框，但不打断用户正在输入的内容
  useEffect(() => {
    const incoming = cfg.customTags.join('\n')
    if (incoming === lastWrittenRef.current) return
    lastWrittenRef.current = incoming
    setCustomText(cfg.customTags.join(', '))
  }, [cfg.customTags])

  const onCustomChange = (value: string): void => {
    setCustomText(value)
    const parsed = parseCustomTags(value)
    // 记下「这次写入对应的解析结果」，避免上面的同步 effect 把用户正在输入的文本改掉
    lastWrittenRef.current = parsed.join('\n')
    patch({ customTags: parsed })
  }

  /** 本页管的三档规则是否有开着的（用于「恢复默认」按钮的可用性提示，不做禁用，避免误以为坏了） */
  const anyRuleOn = cfg.l1 || cfg.l2 || cfg.l3 || cfg.customTags.length > 0

  return (
    <SubPage
      icon={ShieldOff}
      title="屏蔽表"
      desc="按番剧标签 / 关键词屏蔽的规则表。只影响番剧表：搜索结果、收藏、详情页与订阅都不受影响"
      maxWidth="max-w-2xl"
      actions={
        <Button
          size="sm"
          variant="outline"
          icon={RotateCcw}
          onClick={() => {
            lastWrittenRef.current = ''
            // 只重置本页管辖的规则，**不动黑名单**（黑名单在它自己的页面里管）
            patch({ l1: DEFAULT_SCHEDULE_BLOCK.l1, l2: DEFAULT_SCHEDULE_BLOCK.l2, l3: DEFAULT_SCHEDULE_BLOCK.l3, customTags: [] })
            setCustomText('')
            toast.success('已恢复屏蔽表默认值（只开启一级屏蔽）')
          }}
        >
          恢复默认
        </Button>
      }
    >
      {/* ---------------- 分级标签屏蔽 ---------------- */}
      <Card
        title="分级标签屏蔽"
        desc="勾选后，番剧表里命中对应标签的番剧不再显示；标签来自番剧详情，匹配不区分大小写"
      >
        {BLOCK_LEVELS.filter((l) => l.level !== 4).map((level) => {
          const checked = level.level === 1 ? cfg.l1 : level.level === 2 ? cfg.l2 : cfg.l3
          return (
            <div key={level.level} className="border-t border-border py-2.5 first:border-t-0">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-xs text-text">
                    {level.title}
                    {level.level === 1 ? <span className="ml-1.5 text-[11px] text-accent">默认开启</span> : null}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-faint">{level.desc}</div>
                </div>
                <Switch
                  checked={checked}
                  onChange={(v) => patch(level.level === 1 ? { l1: v } : level.level === 2 ? { l2: v } : { l3: v })}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {level.tags.map((tag) => (
                  <span key={tag} className="rounded-md bg-elev2 px-1.5 py-0.5 text-[11px] text-dim">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )
        })}
      </Card>

      {/* ---------------- 四级：自定义标签 ---------------- */}
      <Card
        title="四级：自定义标签屏蔽"
        desc="自己填关键词，逗号或换行分隔，自动去空格且不区分大小写；标签名包含关键词即命中（例如填「后宫」会同时命中「逆后宫」）"
      >
        <textarea
          value={customText}
          onChange={(e) => onCustomChange(e.target.value)}
          rows={3}
          placeholder="例如：后宫, 异世界, 转生"
          className="w-full resize-y rounded-lg border border-border bg-elev2 px-3 py-2 text-xs text-text outline-none placeholder:text-faint focus:border-accent"
        />
        <div className="mt-2 text-[11px] leading-relaxed text-faint">
          {cfg.customTags.length > 0
            ? `已生效 ${cfg.customTags.length} 个关键词：${cfg.customTags.join(' / ')}`
            : '未填写自定义关键词'}
        </div>
      </Card>

      {/* ---------------- 生效情况 ---------------- */}
      <Card title="当前生效情况" desc="按本页规则，本周番剧表会被屏蔽多少部">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dim">
          <span className="flex items-center gap-1.5">
            <Tags size={12} className="text-accent" />
            本周共 {weekCount} 部，本页规则命中 {blockedCount} 部
          </span>
          {tagRulesOn ? (
            <span className="text-faint">
              标签缓存 {tagDone}/{weekCount}
              {fetchingTags ? '（补齐中…）' : ''}
            </span>
          ) : (
            <span className="text-faint">屏蔽表未启用任何规则：不会请求任何番剧详情</span>
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
        ) : null}
        {!anyRuleOn ? (
          <div className="mt-2 text-[11px] leading-relaxed text-faint">
            当前三档分级与自定义关键词都是空的：番剧表会显示全部条目。
          </div>
        ) : null}
      </Card>

      {/* ---------------- 说明 ---------------- */}
      <Card title="说明" desc="屏蔽的生效范围与降级行为">
        <div className="text-[11px] leading-relaxed text-faint">
          1. <b>只影响番剧表</b>：搜索结果、收藏、番剧详情、订阅与下载都不受这里任何设置的影响。
          <br />
          2. 标签来自<b>番剧详情</b>（番剧表接口本身不返回标签），所以应用会按需逐条补全并缓存 7 天；首次开启时
          需要几秒才会陆续生效，期间界面上会显示「标签缓存 x/y」。
          <br />
          3. <b>没取到标签的番剧一律不屏蔽</b>（宁可不屏蔽，也不能误杀）；数据源不可用时最多连续失败 4 次就停止补全。
          <br />
          4. 按具体番剧屏蔽请看同一区域下的「黑名单」（它按条目 id 记录，优先级最高）。
        </div>
      </Card>
    </SubPage>
  )
}

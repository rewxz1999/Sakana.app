import type { DanmakuProgressSnapshot, PlayFlowSnapshot, PlayFlowStage, PlayFlowStageKey } from '@shared/types'

/**
 * 播放过程进度显示器（v0.3.9）。
 *
 * 用户原话：「我需要在还没获取完资源时，刚开始播放时，播放器还没有显示时，
 * 在播放器控制栏顶部的播放器状态显示中再加一个过程进度显示器，
 * 显示找播放资源、获取播放资源、将播放资源注入播放器这一过程，
 * 这样我就能判定播放卡在那个步骤，这个过程进度显示器必需是实时更新的，详细显示问题所在。」
 *
 * 实现要点（对应工单的「不留假状态」）：
 *   · 显示的耗时全部来自主进程的真实时间戳（`elapsedMs` 是每次快照现算的），
 *     这里只负责格式化，不跑任何本地计时器 —— 所以数字只会「真的在跳」；
 *   · 三阶段的状态（进行中/成功/失败/超时/未开始）也直接取自真实阶段，
 *     没发生的阶段就是「未开始」，不会为了好看而点亮；
 *   · 两种版式：`compact` 给控制栏顶部那条状态药丸（一行），
 *     非 compact 给「播放器还没显示」时那块大提示（逐阶段列出细节与失败原因）。
 *
 * ── 配色（v0.3.9 补充，用户报「播放过程下的内容字是白色的，看不清」）──
 *
 * 这段文字会出现在**两种完全不同的底色**上，所以配色不能只有一套：
 *
 *   · `tone='surface'`（默认）：主题表面（`bg-elev1`/`bg-elev2`），例如「播放状态 · 流详情」面板。
 *     必须用主题语义色（`text-text` 主 / `text-dim` 次 / `text-faint` 弱）——
 *     默认主题 midnight 的 `--elev1` 是 **#ffffff**，写死白色就等于白字白底。
 *     这正是用户看到的那条反馈。
 *   · `tone='onVideo'`：视频上的黑色半透明遮罩（控制栏状态药丸、悬浮窗提示卡）。
 *     这里的底色**与主题无关、恒为深色**，所以不能用主题语义色
 *     （浅色主题下 `text-text` 是 #1c2433，压在黑色遮罩上同样看不清），
 *     只能用一组固定的浅色。为了不再散落写死，这组值集中定义在下面的 TONE 表里，
 *     并且把不透明度整体上调（原来用 /45、/35 这类值，在视频上确实偏虚）。
 */

type Tone = 'surface' | 'onVideo'

/**
 * 两套配色的唯一出处。
 *
 * `primary/secondary/tertiary` 分别是三层文字（正文 / 次要 / 弱化），
 * `ok/warn/danger` 是状态色，`seg*` 是紧凑版那三根小色条。
 */
const TONE: Record<
  Tone,
  {
    primary: string
    secondary: string
    tertiary: string
    ok: string
    warn: string
    danger: string
    /** 语义色的**底色**版本：浅色主题下主题的 ok/warn/danger 当文字太浅（实测见下），
     *  所以「有颜色的那部分」改由色块承担，文字用主题主色 —— 语义还在，但读得清。 */
    chipOk: string
    chipWarn: string
    chipDanger: string
    segOk: string
    segRunning: string
    segBad: string
    segIdle: string
  }
> = {
  /*
   * surface：主题表面（「播放状态 · 流详情」面板里的「播放过程」那一块）。
   *
   * 文字一律用主题语义色 —— 默认主题 midnight 的 elev2 是 #e9eef8（浅色），
   * 写死白色就是白字白底，这正是用户报的那条。
   *
   * 状态色**不**直接给文字上色：实测（.tmp-flowtest 的对比度自检）
   * 主题的 --warn 在 sakura 下压 elev2 只有 2.50:1、--danger 只有 3.79:1，
   * 都达不到 11px 正文要的 4.5:1（这是整套主题调色板的既有性质，不是本组件引入的）。
   * 所以这里让文字保持主题主色（实测 12–14:1），
   * 把「成功/警告/失败」的语义交给 chip*：一个淡淡的本色底块。
   */
  surface: {
    primary: 'text-text',
    secondary: 'text-dim',
    // 用 dim 而不是 faint：faint 对 elev2 只有 2.6:1 左右，正是「看不清」的来源
    tertiary: 'text-dim',
    ok: 'text-text',
    warn: 'text-text',
    danger: 'text-text',
    chipOk: 'bg-ok/15',
    chipWarn: 'bg-warn/15',
    chipDanger: 'bg-danger/15',
    segOk: 'bg-ok',
    segRunning: 'bg-warn',
    segBad: 'bg-danger',
    segIdle: 'bg-faint'
  },
  onVideo: {
    /*
     * 视频遮罩恒为深色，所以这里用固定浅色系（不用主题色，理由见文件头注释）。
     *
     * 亮度档位是**算出来的**，不是估的：`.tmp-flowtest/verify.ts` 的对比度自检
     * 按 WCAG 把每个类名压在最坏底色上算一遍 ——
     * 最坏底色不是纯黑，而是「画面很亮时 70% 黑遮罩之后的 #4d4d4d」。
     * 一开始用的 red-400 只有 2.93:1、red-300 也只有 4.40:1，
     * 而这里的失败原因、阶段状态都是 11px 正文（要 ≥4.5:1），所以危险色提到 200 档。
     * 改配色时**必须重跑那个自检**，否则很容易又退回看不清的档位。
     */
    primary: 'text-white',
    secondary: 'text-white/85',
    tertiary: 'text-white/70',
    ok: 'text-emerald-300',
    warn: 'text-amber-200',
    danger: 'text-red-200',
    chipOk: 'bg-emerald-400/20',
    chipWarn: 'bg-amber-400/20',
    chipDanger: 'bg-red-400/25',
    segOk: 'bg-emerald-300',
    segRunning: 'bg-amber-200',
    segBad: 'bg-red-300',
    segIdle: 'bg-white/30'
  }
}

/** 阶段状态 → 记号与配色。用字符而不是图标：控制栏那一行只有 11px，图标反而看不清 */
function stageMark(stage: PlayFlowStage, tone: Tone): { mark: string; cls: string } {
  const t = TONE[tone]
  switch (stage.status) {
    case 'ok':
      return { mark: '✓', cls: t.ok }
    case 'failed':
      return { mark: '✗', cls: t.danger }
    case 'timeout':
      return { mark: '⏱', cls: t.warn }
    case 'running':
      return { mark: '●', cls: `${t.warn} animate-pulse` }
    default:
      return { mark: '○', cls: t.tertiary }
  }
}

const STATUS_TEXT: Record<PlayFlowStage['status'], string> = {
  pending: '未开始',
  running: '进行中',
  ok: '成功',
  failed: '失败',
  timeout: '超时'
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 1000)}s`
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtRate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '—'
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${Math.round(bps / 1024)} KB/s`
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`
}

/** 归因 → 界面文字（用户要求「不许只说播放失败」，所以每条都要说清是哪一类） */
export function reasonLabel(reason: string | undefined): string {
  switch (reason) {
    case 'site':
      return '网站问题 / 资源失效'
    case 'slow':
      return '资源获取速度过慢'
    case 'format':
      return '格式不支持'
    case 'timeout':
      return '等待超时'
    case 'internal':
      return '播放器内部错误'
    default:
      return ''
  }
}

/** 当前进度：第几阶段 / 共几个（给紧凑版用） */
function currentStageIndex(flow: PlayFlowSnapshot): number {
  const i = flow.stages.findIndex((s) => s.key === flow.activeStage)
  if (i >= 0) return i + 1
  const lastDone = flow.stages.filter((s) => s.status === 'ok').length
  return Math.max(1, lastDone)
}

/** 把网络指标压成一行——「速度过慢」时必须让用户看到实时速率，而不是一个笼统的提示 */
export function metricsLine(flow: PlayFlowSnapshot | null | undefined): string {
  if (!flow) return ''
  const m = flow.metrics
  const parts: string[] = []
  if (m.ttfbMs !== null && m.ttfbMs !== undefined) parts.push(`首字节 ${fmtMs(m.ttfbMs)}`)
  if (m.bytes > 0) parts.push(`已收 ${fmtBytes(m.bytes)}`)
  if (m.rateBps > 0) parts.push(`速率 ${fmtRate(m.rateBps)}`)
  /*
   * 指标来源（v1.1）——「内核实测」这几个字是用户要的凭据：
   * 以前速度只在"交给内核之前"那一次探测里出现，用户分不清看到的是探测值还是内核正在跑的读数。
   */
  if (m.source === 'engine') parts.push('内核实测')
  if (m.status) parts.push(`HTTP ${m.status}`)
  if (m.contentType) parts.push(m.contentType.split(';')[0])
  return parts.join(' · ')
}

/** 一句话结论（带归因前缀），失败与过慢时显示在状态药丸上 */
export function flowHeadline(flow: PlayFlowSnapshot | null | undefined): string {
  if (!flow) return ''
  return flow.summary || '准备中'
}

export function PlayFlowStages({
  flow,
  compact = false,
  className = '',
  tone = 'surface'
}: {
  flow: PlayFlowSnapshot | null | undefined
  /** true = 控制栏顶部状态药丸里的一行版式 */
  compact?: boolean
  className?: string
  /**
   * 底色：`surface` = 主题表面（详情面板等，用主题语义色）；
   * `onVideo` = 视频上的黑色遮罩（控制栏药丸、悬浮窗提示卡，用固定浅色）。
   * 两者的理由见文件头注释 —— 选错就会出现「白字白底」。
   */
  tone?: Tone
}): React.ReactElement | null {
  if (!flow) return null
  const t = TONE[tone]
  const running = flow.stages.find((s) => s.status === 'running')
  const bad = flow.stages.find((s) => s.status === 'failed' || s.status === 'timeout')
  const focus = bad ?? running ?? flow.stages[flow.stages.length - 1]

  if (compact) {
    return (
      <span className={`flex items-center gap-1.5 whitespace-nowrap ${className}`}>
        {/* 三段小方块：一眼看出卡在第几段 */}
        <span className="flex items-center gap-[3px]" title="找资源 → 取资源 → 注入播放器">
          {flow.stages.map((s) => (
            <span
              key={s.key}
              className={`block h-1 w-3 rounded-full ${
                s.status === 'ok'
                  ? t.segOk
                  : s.status === 'running'
                    ? `${t.segRunning} animate-pulse`
                    : s.status === 'failed' || s.status === 'timeout'
                      ? t.segBad
                      : t.segIdle
              }`}
            />
          ))}
        </span>
        <span className={t.primary}>
          {currentStageIndex(flow)}/3 {focus?.label ?? ''}
        </span>
        {focus?.startedAt !== null && focus?.elapsedMs ? (
          <span className={t.secondary}>{fmtMs(focus.elapsedMs)}</span>
        ) : null}
      </span>
    )
  }

  return (
    <div className={`flex w-full max-w-md flex-col gap-1.5 text-left ${className}`}>
      {flow.stages.map((s) => {
        const { mark, cls } = stageMark(s, tone)
        return (
          <div key={s.key} className="flex items-start gap-2 text-[11px] leading-relaxed">
            <span className={`${cls} w-3 shrink-0 text-center`}>{mark}</span>
            <span className={`w-20 shrink-0 ${t.primary}`}>{s.label}</span>
            <span className={`w-14 shrink-0 ${t.secondary}`}>{STATUS_TEXT[s.status]}</span>
            <span className={`w-12 shrink-0 text-right ${t.secondary}`}>
              {s.startedAt === null ? '—' : fmtMs(s.elapsedMs)}
            </span>
            <span className={`min-w-0 flex-1 ${t.secondary}`}>
              {s.error ? (
                /* 失败原因用「本色底块 + 主题文字色」而不是彩色文字：
                   浅色主题下主题的 danger 当 11px 正文只有 3.79:1（见 TONE.surface 的说明） */
                <span className={`rounded px-1 ${t.chipDanger} ${t.danger}`}>{s.error}</span>
              ) : (
                s.detail || ''
              )}
            </span>
          </div>
        )
      })}
      {metricsLine(flow) ? (
        /* 指标与阶段步骤都用 secondary 而不是 tertiary：这两行是**排障要看的内容**，
           faint 在浅色主题下对 elev2 的对比度只有 2.6:1 左右（实测见 .tmp-flowtest 的对比度自检），
           正是用户说的「看不清」。 */
        <div className={`ml-5 text-[10px] ${t.secondary}`}>
          {metricsLine(flow)}
          {flow.reason === 'slow' ? (
            <span className={`ml-1 rounded px-1 ${t.chipWarn} ${t.warn}`}>速度过慢，仍在继续等待</span>
          ) : null}
        </div>
      ) : null}
      {flow.reason !== 'none' && reasonLabel(flow.reason) ? (
        <div className={`ml-5 text-[10px] ${t.warn}`}>
          <span className={`rounded px-1 ${t.chipWarn}`}>判定：{reasonLabel(flow.reason)}</span>
        </div>
      ) : null}
      <div className={`ml-5 text-[10px] ${t.secondary}`}>
        阶段步骤：{flow.stages.filter((s) => s.steps.length > 0).length > 0
          ? flow.stages
              .flatMap((s) => s.steps.slice(-2).map((x) => `${x.text}`))
              .slice(-4)
              .join(' → ')
          : '（暂无）'}
      </div>
    </div>
  )
}

/** 供悬浮窗/页面共用：三阶段 key 的中文名（避免两处各写一份文案） */
export const STAGE_LABELS: Record<PlayFlowStageKey, string> = {
  locate: '找播放资源',
  acquire: '获取播放资源',
  inject: '注入播放器'
}

/**
 * 弹幕获取进度（V1.2，用户要求显示在「播放流详情」里）。
 *
 * 为什么单独做成一行而不是并进播放三阶段：播放三阶段说的是"视频流有没有起来"，
 * 弹幕是**另一条并行链路**（它慢不该让用户以为播放卡住）。这里把主进程真实上报的
 * 「第 3/4 步 · 正在从巴哈姆特取弹幕…」原样显示，并带上每个源自己的状态。
 * 文案里的步数是主进程给的，不是这里按时间猜的 —— 不会出现进度条走完却没拿到弹幕。
 */
export function DanmakuProgressLine({
  progress,
  tone = 'surface'
}: {
  progress: DanmakuProgressSnapshot | null | undefined
  tone?: Tone
}): React.ReactElement | null {
  if (!progress?.current) return null
  const t = TONE[tone]
  const cur = progress.current
  const elapsed = Math.max(0, cur.updatedAt - cur.startedAt)
  return (
    <div className="flex flex-col gap-1 text-[11px] leading-relaxed">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={t.primary}>
          {cur.active ? `正在从${cur.sourceName}取弹幕…` : cur.error ? `${cur.sourceName}取弹幕失败` : `${cur.sourceName}弹幕已就绪`}
        </span>
        <span className={`rounded px-1 ${cur.error ? t.chipDanger : cur.active ? t.chipWarn : t.chipOk}`}>
          第 {cur.step}/{cur.total} 步
        </span>
        <span className={t.secondary}>{cur.label}</span>
        {elapsed > 0 ? <span className={t.secondary}>{fmtMs(elapsed)}</span> : null}
      </div>
      {cur.title ? (
        <div className={`text-[10px] ${t.secondary}`}>
          《{cur.title}》{cur.episode > 0 ? ` 第 ${cur.episode} 集` : ''}
          {cur.error ? <span className={`ml-1 rounded px-1 ${t.chipDanger} ${t.danger}`}>{cur.error}</span> : null}
        </div>
      ) : null}
      {progress.sources.length > 1 ? (
        <div className={`flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] ${t.secondary}`}>
          {progress.sources.map((s) => (
            <span key={`${s.sourceId}-${s.sourceName}-${s.title}-${s.episode}`}>
              {s.sourceName}：{s.active ? `第 ${s.step}/${s.total} 步` : s.error ? `失败` : s.done ? '完成' : '等待'}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

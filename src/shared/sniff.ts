/**
 * 「嗅探设置」（V1.5.1）—— 在线播放取流/缓存加速的配置与纯函数。
 *
 * 用户要求：「设置中增加嗅探设置，并说明采用了什么技术，原先的加速模块也放到这个设置中。」
 *
 * 这里只放**配置形状 + 默认值 + 收窄规则**，具体实现分三块：
 *   · 请求头伪装 —— `main/services/mediaCache.ts` 的 upstreamHeaders()；
 *   · HTTP Range 多连接分段下载 —— 同文件的并行分段拉取（见 mediaCache 的 segment 部分）；
 *   · 自适应并发 —— 根据分段任务的成功/失败/速率调整下一次的连接数（`tuneConnections`）。
 *
 * 为什么把默认值放 shared：设置页要显示「默认开/关」，而主进程要按同一份默认值工作。
 * 两边各写一份的话，用户看到的与实际跑的会不一样（这类"设置没生效"最难排查）。
 */

/** 用户可调的嗅探/取流加速设置（存 settings.sniff，缺省字段用下面的默认值补齐） */
export interface SniffSettings {
  /** 多连接分段下载（HTTP Range）：把一集切成 N 段并行拉取，突破单连接限速 */
  multiConnection: boolean
  /** 基准连接数（2–8；自适应会在此基础上小幅调整） */
  connections: number
  /** 自适应并发：根据分段任务的成功率与速率调高/调低连接数 */
  adaptive: boolean
  /**
   * 请求头伪装：补上浏览器会带的 Origin / Accept-Language / Sec-Fetch-* 等头。
   * 部分 CDN 会按这些头做防盗链或人机判定，伪装能降低被限速/拒绝的概率。
   */
  headerSpoof: boolean
  /** 小文件不启用多连接（小于这个 MB 数时单连接就够，多开反而增加请求数） */
  minFileMB: number
}

export const DEFAULT_SNIFF_SETTINGS: SniffSettings = {
  multiConnection: true,
  connections: 4,
  adaptive: true,
  headerSpoof: true,
  minFileMB: 16
}

/** 连接数的硬边界（防止用户把 1 集切成 64 段把站点打挂） */
export const MIN_CONNECTIONS = 2
export const MAX_CONNECTIONS = 8

/** 收窄：任何来源（设置文件/界面）的值都先过一遍这里，越界一律夹回合法区间 */
export function resolveSniffSettings(raw: unknown): SniffSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<SniffSettings>
  const n = Number(src.connections)
  const mb = Number(src.minFileMB)
  return {
    multiConnection: typeof src.multiConnection === 'boolean' ? src.multiConnection : DEFAULT_SNIFF_SETTINGS.multiConnection,
    connections: Number.isFinite(n)
      ? Math.min(MAX_CONNECTIONS, Math.max(MIN_CONNECTIONS, Math.round(n)))
      : DEFAULT_SNIFF_SETTINGS.connections,
    adaptive: typeof src.adaptive === 'boolean' ? src.adaptive : DEFAULT_SNIFF_SETTINGS.adaptive,
    headerSpoof: typeof src.headerSpoof === 'boolean' ? src.headerSpoof : DEFAULT_SNIFF_SETTINGS.headerSpoof,
    minFileMB: Number.isFinite(mb) ? Math.min(4096, Math.max(1, Math.round(mb))) : DEFAULT_SNIFF_SETTINGS.minFileMB
  }
}

/**
 * 自适应并发的**纯函数**部分：根据上一次分段任务的表现算出下一轮的连接数。
 *
 * 判据刻意保守（用户提醒过"盲目提高并发可能触发单 IP 总连接数限制"）：
 *   · 有一次分段失败 → 直接减 1（宁可慢一点，也不要因为并发过高被站点掐掉全部连接）；
 *   · 全部成功且平均速率 < 2MB/s → 加 1（说明瓶颈可能在单连接限速，多开有用）；
 *   · 速率已经很高（> 8MB/s）→ 不加（带宽基本吃满，多开只会增加请求数）。
 * 返回的永远是 `[MIN_CONNECTIONS, MAX_CONNECTIONS]` 内的整数。
 */
export function tuneConnections(current: number, stats: { ok: number; failed: number; avgBytesPerSec: number }): number {
  const base = Math.min(MAX_CONNECTIONS, Math.max(MIN_CONNECTIONS, Math.round(current)))
  if (stats.failed > 0) return Math.max(MIN_CONNECTIONS, base - 1)
  if (stats.ok > 0 && stats.avgBytesPerSec < 2 * 1024 * 1024) return Math.min(MAX_CONNECTIONS, base + 1)
  return base
}

/** 设置页用的一行说明（文案集中在这里，避免页面里散落长句） */
export const SNIFF_TECH_NOTES: { title: string; desc: string }[] = [
  {
    title: 'HTTP Range 多连接分段下载',
    desc: '把一集切成若干段并行拉取（先探测 Accept-Ranges），再按绝对偏移写入同一个缓存文件；等效于 aria2/axel 的多线程下载思路，用来突破"单连接被限速"。'
  },
  {
    title: '自适应并发',
    desc: '分段全部成功且速度偏低时加一条连接，出现失败就立刻减一条：宁可慢一点，也不要把站点惹到封 IP（单 IP 总连接数限制是真实存在的）。'
  },
  {
    title: '请求头伪装',
    desc: '补齐 Origin / Accept-Language / Sec-Fetch-* 等真实浏览器会带的头，降低被 CDN 按请求特征识别成爬虫的概率；同时强制 identity 编码，避免压缩后的字节写进缓存。'
  },
  {
    title: '本地缓存复用（原有加速模块）',
    desc: '取到的字节先落盘再由本机喂给播放器，拖动/重播直接读磁盘；同一集重复播放不会再次回源。这一项与下面的"在线播放设置"里的加速档位配合工作。'
  }
]

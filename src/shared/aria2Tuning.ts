/**
 * aria2 调优参数的**纯逻辑**（V1.5.2）。
 *
 * 单独拆出来是为了两件事：
 *   1. 自检脚本可以在 Node 里直接断言"越界值会被夹回安全区间"，不必启动 Electron；
 *   2. 设置页、主进程、下载器读的是**同一份**收窄规则（界面写 999 也不会真的下发 999）。
 *
 * 数值来源：用户给的加速方案 + aria2 官方文档的推荐区间。
 *   · 单服务器连接 16 / 分片 16：对 HTTP 直链最有效；BT 由 bt-max-peers 管；
 *   · 最小分片 1M：再小只会增加连接管理开销；
 *   · 低速剔除 10K：把占着连接却不给数据的 peer / 服务器让出去；
 *   · 磁盘缓存 256M：边下边写时不至于被磁盘 I/O 拖住（HDD 尤其明显）。
 */

export interface Aria2TuningInput {
  maxConnectionPerServer?: number
  split?: number
  minSplitSize?: string
  lowestSpeedLimit?: string
  diskCache?: string
  listenPort?: number
  btMaxPeers?: number
  btRequestPeerSpeedLimit?: string
  updateTrackers?: boolean
  trackerListUrl?: string
}

export const DEFAULT_ARIA2_TUNING = {
  maxConnectionPerServer: 16,
  split: 16,
  minSplitSize: '1M',
  lowestSpeedLimit: '10K',
  diskCache: '256M',
  listenPort: 6888,
  btMaxPeers: 128,
  btRequestPeerSpeedLimit: '50K',
  updateTrackers: true,
  trackerListUrl: ''
} as const

/** 收窄 aria2 调优参数：越界夹回安全区间，避免用户填 1024 把站点/内存打挂 */
export function resolveAria2Tuning(raw: Aria2TuningInput | null | undefined): {
  maxConnectionPerServer: number
  split: number
  minSplitSize: string
  lowestSpeedLimit: string
  diskCache: string
  listenPort: number
  btMaxPeers: number
  btRequestPeerSpeedLimit: string
  updateTrackers: boolean
  trackerListUrl: string
} {
  const src = raw ?? {}
  const int = (v: unknown, min: number, max: number, dflt: number): number => {
    const n = Number(v)
    if (!Number.isFinite(n)) return dflt
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  const unit = (v: unknown, dflt: string, maxNum: number): string => {
    const s = String(v ?? '').trim().toUpperCase()
    const m = /^(\d{1,5})([KMG]?)$/.exec(s)
    if (!m) return dflt
    const n = Number(m[1])
    if (!Number.isFinite(n) || n <= 0) return dflt
    return `${Math.min(maxNum, n)}${m[2]}`
  }
  return {
    maxConnectionPerServer: int(src.maxConnectionPerServer, 1, 16, DEFAULT_ARIA2_TUNING.maxConnectionPerServer),
    split: int(src.split, 1, 16, DEFAULT_ARIA2_TUNING.split),
    minSplitSize: unit(src.minSplitSize, DEFAULT_ARIA2_TUNING.minSplitSize, 1024),
    lowestSpeedLimit: unit(src.lowestSpeedLimit, DEFAULT_ARIA2_TUNING.lowestSpeedLimit, 1024),
    diskCache: unit(src.diskCache, DEFAULT_ARIA2_TUNING.diskCache, 4096),
    listenPort: int(src.listenPort, 1024, 65535, DEFAULT_ARIA2_TUNING.listenPort),
    btMaxPeers: int(src.btMaxPeers, 20, 200, DEFAULT_ARIA2_TUNING.btMaxPeers),
    btRequestPeerSpeedLimit: unit(src.btRequestPeerSpeedLimit, DEFAULT_ARIA2_TUNING.btRequestPeerSpeedLimit, 1024),
    updateTrackers: src.updateTrackers !== false,
    trackerListUrl: String(src.trackerListUrl ?? '').trim()
  }
}

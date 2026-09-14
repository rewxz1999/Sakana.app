/**
 * HLS 播放列表广告分片判定的**纯函数核心**（无任何 Electron / 网络依赖，可单独验证）。
 *
 * 为什么判据是「被 discontinuity 夹住的短区段」：
 * MXdm（MacCMS 系）CDN 的正片 m3u8 是预处理拼接过广告的，
 * 分片 URL 同域同路径、命名规律一致、时长分布也一致——
 * 唯一暴露拼接点的信息就是 #EXT-X-DISCONTINUITY 与「广告段自成一条 PTS 时间轴」。
 * 详见 adFilter.ts 顶部的实测说明。
 */

/** 广告区段时长窗口（秒）：太短可能是正常切点，太长可能是正片段落
 *  实测贴片广告集中在 16~20s；上限收到 30s 以避免把偏长的片尾/预告误判为广告 */
const AD_MIN_SEC = 4
const AD_MAX_SEC = 30
/** 删除总量上限：比例与绝对值取较小者生效 */
const AD_MAX_RATIO = 0.1
const AD_MAX_TOTAL_SEC = 120
/** 过滤后必须留下的正片下限 */
const KEEP_MIN_SEC = 120
const KEEP_MIN_SEGMENTS = 10
const KEEP_MIN_BLOCK_SEC = 120

export interface AdRemovalPlan {
  text: string
  removedSegments: number
  removedSeconds: number
  keptSeconds: number
  removedBlocks: { from: number; to: number; seconds: number }[]
}

export interface PlaylistEntry {
  /** 该分片前的所有 # 标签（含 #EXTINF 与可能存在的 #EXT-X-DISCONTINUITY） */
  tags: string[]
  uri: string
  dur: number
  disc: boolean
}

export function parseEntries(text: string): {
  preamble: string[]
  entries: PlaylistEntry[]
  trailing: string[]
} {
  const preamble: string[] = []
  const entries: PlaylistEntry[] = []
  const trailing: string[] = []
  let pending: string[] = []
  let dur = 0
  let disc = false
  let started = false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      // 注意排除 #EXT-X-DISCONTINUITY-SEQUENCE：它是列表级标签，不是拼接点标记
      if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
        disc = true
      }
      if (line.startsWith('#EXTINF')) {
        const m = /#EXTINF:\s*([\d.]+)/.exec(line)
        dur = m ? Number(m[1]) : 0
        if (!started) {
          started = true
          // 首个分片之前的标签属于列表头（版本/类型/序列…），必须原样保留；
          // 唯一例外是「作用于首个分片的 DISCONTINUITY」：它属于该分片，
          // 留在 pending 里随分片一起输出，否则会与列表头里的同一行重复。
          preamble.push(...pending.filter((t) => t !== '#EXT-X-DISCONTINUITY'))
          pending = pending.filter((t) => t === '#EXT-X-DISCONTINUITY')
        }
      }
      pending.push(line)
      continue
    }
    entries.push({ tags: pending, uri: line, dur, disc })
    pending = []
    dur = 0
    disc = false
  }
  trailing.push(...pending)
  return { preamble, entries, trailing }
}

export function sumDur(entries: PlaylistEntry[], from: number, to: number): number {
  let n = 0
  for (let i = from; i <= to; i++) n += entries[i]?.dur ?? 0
  return n
}

/** 相对分片地址 → 绝对地址（改写后的列表由 127.0.0.1 提供，相对地址会解析到本机而 404） */
export function absolutize(uri: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(uri)) return uri
  try {
    return new URL(uri, baseUrl).toString()
  } catch {
    return uri
  }
}

/**
 * 计算改写后的播放列表。返回 null 表示「判据不足，放弃改写」（调用方回源原始地址）。
 * 绝不返回「可能删掉正片」的结果——所有闸门都是保守的。
 */
export function planAdRemoval(playlist: string, baseUrl: string): AdRemovalPlan | null {
  if (!playlist.includes('#EXTM3U')) return null
  // 直播列表（无 ENDLIST）不改：分片会滚动，删除会造成播放空洞
  if (!playlist.includes('#EXT-X-ENDLIST')) return null
  // fMP4（EXT-X-MAP）与分离音轨（EXT-X-MEDIA）结构复杂，放弃改写。
  // 注意必须带冒号：列表里的 #EXT-X-MEDIA-SEQUENCE 不应被误判为分离音轨。
  if (playlist.includes('#EXT-X-MAP:') || playlist.includes('#EXT-X-MEDIA:')) return null

  const { preamble, entries, trailing } = parseEntries(playlist)
  if (entries.length < 12) return null

  const total = sumDur(entries, 0, entries.length - 1)
  if (total <= 0) return null

  const discIdx: number[] = []
  for (let i = 0; i < entries.length; i++) if (entries[i].disc) discIdx.push(i)
  if (discIdx.length < 2) return null

  // 以 DISCONTINUITY 为界切分连续区段
  const bounds = [...new Set<number>([0, ...discIdx, entries.length])].sort((a, b) => a - b)
  const runs: { start: number; end: number }[] = []
  for (let k = 0; k < bounds.length - 1; k++) {
    const start = bounds[k]
    const end = bounds[k + 1] - 1
    if (start <= end) runs.push({ start, end })
  }

  // 只考虑「由 DISCONTINUITY 起头」的区段：区段起点必须本身带 DISCONTINUITY 标签。
  // 这样列表开头的正片段落（起点是 0 且没有 DISCONTINUITY）永远不可能被删除。
  const discSet = new Set(discIdx)
  const candidates: { from: number; to: number; seconds: number }[] = []
  for (const r of runs) {
    if (!discSet.has(r.start)) continue
    const sec = sumDur(entries, r.start, r.end)
    if (sec < AD_MIN_SEC || sec > AD_MAX_SEC) continue
    candidates.push({ from: r.start, to: r.end, seconds: sec })
  }
  if (candidates.length === 0) return null

  /*
   * 若列表声明了非 0 的 EXT-X-DISCONTINUITY-SEQUENCE，删掉「列表开头的区段」会让
   * 该序列号与首个分片对不上。这种情况直接放弃（极罕见，且宁放过不误删）。
   */
  const seqMatch = /#EXT-X-DISCONTINUITY-SEQUENCE:\s*(\d+)/.exec(playlist)
  if (seqMatch && Number(seqMatch[1]) !== 0 && candidates.some((c) => c.from === 0)) return null

  const removedSeconds = candidates.reduce((n, c) => n + c.seconds, 0)
  const keptSeconds = total - removedSeconds
  const removedSegments = candidates.reduce((n, c) => n + (c.to - c.from + 1), 0)
  const keptSegments = entries.length - removedSegments

  // ---- 保守闸门：任一条不满足就整体放弃，一个分片都不删 ----
  if (removedSeconds > AD_MAX_TOTAL_SEC) return null
  if (removedSeconds > total * AD_MAX_RATIO) return null
  if (keptSeconds < KEEP_MIN_SEC) return null
  if (keptSegments < KEEP_MIN_SEGMENTS) return null
  // 必须留下至少一段够长的连续正片（避免把「被切成小段的流」整片删空）
  const longestKept = runs.reduce(
    (best, r) =>
      candidates.some((c) => c.from === r.start)
        ? best
        : Math.max(best, sumDur(entries, r.start, r.end)),
    0
  )
  if (longestKept < KEEP_MIN_BLOCK_SEC) return null

  const removed = new Set<number>()
  for (const c of candidates) for (let i = c.from; i <= c.to; i++) removed.add(i)

  // 逐条重建：只丢掉广告分片自身的标签与地址行，其余字节原样保留。
  // 广告区段起头的 DISCONTINUITY 随该分片一起消失，于是拼接点两侧重新接上，
  // 得到与「未拼接前的正片」完全一致的时间轴。
  const out: string[] = preamble.map((t) => absolutizeTagUris(t, baseUrl))
  for (let i = 0; i < entries.length; i++) {
    if (removed.has(i)) continue
    const e = entries[i]
    for (const t of e.tags) out.push(absolutizeTagUris(t, baseUrl))
    out.push(absolutize(e.uri, baseUrl))
  }
  out.push(...trailing.map((t) => absolutizeTagUris(t, baseUrl)))
  return {
    // 结尾补换行：部分解析器对无换行的末行更敏感
    text: out.join('\n') + '\n',
    removedSegments,
    removedSeconds,
    keptSeconds,
    removedBlocks: candidates
  }
}

/**
 * 标签内的 URI="..." 也要绝对化。
 * 关键场景：`#EXT-X-KEY:METHOD=AES-128,URI="key.bin"` —— 改写后的列表由 127.0.0.1 提供，
 * 相对 URI 会被解析到本机而取不到密钥，导致整个流解不开。
 */
export function absolutizeTagUris(tag: string, baseUrl: string): string {
  if (!tag.includes('URI="')) return tag
  return tag.replace(/URI="([^"]*)"/g, (_m, uri: string) => `URI="${absolutize(uri, baseUrl)}"`)
}

/** 从 master 列表里挑一个媒体列表地址（取 BANDWIDTH 最大的变体） */
export function pickVariant(master: string, masterUrl: string): string | null {
  const lines = master.split(/\r?\n/).map((l) => l.trim())
  let best: { bw: number; url: string } | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('#EXT-X-STREAM-INF')) continue
    let uri = ''
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j] || lines[j].startsWith('#')) continue
      uri = lines[j]
      break
    }
    if (!uri) continue
    const bw = Number(/BANDWIDTH=(\d+)/i.exec(l)?.[1] ?? 0)
    if (!best || bw > best.bw) best = { bw, url: absolutize(uri, masterUrl) }
  }
  return best?.url ?? null
}

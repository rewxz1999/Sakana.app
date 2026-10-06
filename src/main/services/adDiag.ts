import { httpGetText } from '../net'
import { parseEntries, pickVariant, planAdRemoval, sumDur } from './hlsAdFilterCore'

/**
 * HLS 播放列表的**结构诊断**（v0.3.7）。
 *
 * ## 为什么需要它
 *
 * 广告过滤（`hlsAdFilterCore.planAdRemoval`）是一条"宁放过不误删"的判定链：
 * 十来个闸门里任何一条不通过，它就**静默放弃改写**（日志只有一句「未发现可安全剔除的贴片广告分片」），
 * 于是用户看到的就是"广告照播"。光看那句日志根本不知道是哪一道闸门挡住的，
 * 对着真实站点调判据只能靠把结构整个打出来。
 *
 * ## 输出什么
 *
 * 分片数、总时长、每个 DISCONTINUITY 的位置、以 discontinuity 分界的每一段（分片数与时长）、
 * 分片地址的主机与目录分布 —— 以及最后 planAdRemoval 的判定结果。
 * 有了这些就能一眼看出「广告段是不是被标成了 discontinuity」、「是不是时长窗口没覆盖到」、
 * 「是不是分片地址换了域导致判据不敢删」。
 *
 * 被两处复用：`SAKANA_AD_DIAG=<m3u8 地址>` 自检，以及在线测试的 `SAKANA_ONLINE_AD_DIAG=1`。
 */
export async function diagnoseAdStructure(url: string, referer?: string): Promise<string[]> {
  const out: string[] = []
  const line = (s: string): void => {
    out.push(s)
  }
  try {
    line(`地址类型=${/\.m3u8/i.test(url) ? 'm3u8' : '其它'} referer=${referer ? '有' : '无'}`)
    let text = await httpGetText(url, 20000, referer ? { headers: { Referer: referer } } : {})
    line(`拿到 ${text.length}B，共 ${text.split(/\r?\n/).length} 行`)
    /*
     * 先确认拿到的**真的是** HLS 播放列表再往下解析（v0.3.7）。
     *
     * 起因：AGE 的片源是**整段 mp4**（不是 m3u8）。早先没有这道判断时，
     * 诊断会把 49MB 的二进制当成播放列表逐行解析，得出「分片 211168 个、总时长 0s」这种垃圾结论，
     * 还白下载了 49MB。非 HLS 片源本来就没有"贴片广告分片"可谈，直接说明并结束才是正确的回答。
     */
    if (!text.includes('#EXTM3U')) {
      line('这不是 HLS 播放列表（没有 #EXTM3U）：广告过滤对它不适用 ——')
      line('  · 整段 mp4/flv 的片源里不可能"插"进广告分片，广告只可能是站点播放器的前置广告；')
      line('  · 这类站点要防的是"嗅探抓到了广告短片"，见 ruleProbe 的疑似广告短片判定。')
      return out
    }
    if (text.includes('#EXT-X-STREAM-INF')) {
      const v = pickVariant(text, url)
      line(`master 列表，选取变体：${v ? '已取到' : '解析失败'}`)
      if (!v) return out
      text = await httpGetText(v, 20000, referer ? { headers: { Referer: referer } } : {})
      line(`变体列表 ${text.length}B`)
    }
    line(
      `ENDLIST=${text.includes('#EXT-X-ENDLIST')} MAP=${text.includes('#EXT-X-MAP:')} MEDIA=${text.includes('#EXT-X-MEDIA:')}`
    )
    const { preamble, entries } = parseEntries(text)
    const total = sumDur(entries, 0, entries.length - 1)
    line(`列表头 ${preamble.length} 行；分片 ${entries.length} 个，总时长 ${total.toFixed(1)}s`)
    const discIdx = entries.map((e, i) => (e.disc ? i : -1)).filter((i) => i >= 0)
    line(
      `带 DISCONTINUITY 的分片序号：${
        discIdx.length > 40 ? `${discIdx.slice(0, 40).join(',')} …(共 ${discIdx.length})` : discIdx.join(',')
      }`
    )
    const bounds = [...new Set<number>([0, ...discIdx, entries.length])].sort((a, b) => a - b)
    for (let k = 0; k < bounds.length - 1; k++) {
      const start = bounds[k]
      const end = bounds[k + 1] - 1
      if (start > end) continue
      const sec = sumDur(entries, start, end)
      const flag = entries[start].disc ? 'DISCONT' : '不带头'
      line(`  段#${k} 分片 ${start}..${end}（${end - start + 1} 个）时长 ${sec.toFixed(2)}s ${flag}`)
    }
    const hosts = new Set(
      entries.map((e) => {
        try {
          return new URL(e.uri, url).host
        } catch {
          return '?'
        }
      })
    )
    const dirs = new Set(
      entries.map((e) => {
        try {
          return new URL(e.uri, url).pathname.replace(/[^/]+$/, '')
        } catch {
          return '?'
        }
      })
    )
    line(`分片主机 ${[...hosts].join(',')}；所在目录 ${dirs.size} 种`)
    line(`前 3 个分片：${entries.slice(0, 3).map((e) => `${e.dur.toFixed(2)}s ${e.uri.slice(0, 70)}`).join(' | ')}`)
    const plan = planAdRemoval(text, url)
    if (plan) {
      line(
        `判定：可删除 ${plan.removedSegments} 片 / ${plan.removedSeconds.toFixed(1)}s，保留 ${plan.keptSeconds.toFixed(1)}s，块=${JSON.stringify(plan.removedBlocks)}`
      )
    } else {
      line('判定：放弃改写（闸门：ENDLIST / 无 MAP 与 MEDIA / 分片≥12 / DISCONTINUITY≥2 /')
      line('      候选段（以 DISCONTINUITY 起头）4~30s / 删除量≤120s 且≤总时长10% / 剩余≥120s 且≥10 片 / 留一段≥120s 正片）')
    }
  } catch (err) {
    line(`诊断失败：${String((err as Error)?.message ?? err).slice(0, 200)}`)
  }
  return out
}

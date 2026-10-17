import type { DanmakuFetcher, FetcherContext, FetcherEntry, FetcherEpisodeResult } from './types'
import { FETCH_STEPS } from './types'
import { danmuboxFetchEpisode, danmuboxSearch } from '../danmakuSources'
import { log } from '../../log'

/**
 * 弹幕盒子获取器（V1.2）。
 *
 * 与巴哈姆特相反：它没有"按集"的 JSON 接口，索引里只有一个个 7z 包：
 *   1. 下载并解密站点索引（4299 条，24 小时磁盘缓存）→ 按关键字做子串匹配；
 *   2. 下载命中的 7z → 用系统 `tar.exe` 解出 B 站 XML；
 *   3. 包里通常是**一个** XML，也可能是一个合集包（按文件名里的 `P<n>` 挑对应集）。
 *
 * 所以 `search` 只能给"条目"，给不出可靠的集数表（要下包才知道）；`episodes` 留空，
 * 由 `fetchEpisode` 按包内文件名匹配。用户要求"统一接口封装搜索 + 取某集"，这里也满足：
 * 上层只调 `search` / `fetchEpisode`，不需要知道盒子是加密索引 + 7z。
 *
 * 实测限制（写在设置页的适配器说明里）：索引以 2019–2021 存档为主，新番基本搜不到。
 */

export const danmuboxFetcher: DanmakuFetcher = {
  id: 'danmubox',
  name: '弹幕盒子',
  kind: 'site',

  async search(keyword, _ctx) {
    const kw = String(keyword ?? '').trim()
    if (!kw) return []
    _ctx.onProgress?.({ step: 1, total: FETCH_STEPS, label: `正在检索弹幕盒子索引「${kw}」…` })
    const rows = await danmuboxSearch(kw)
    if (rows.length === 0) return []
    // 索引条目名就够上层写「获取记录」了；真正的集数在包内，取的时候再解析
    return rows.slice(0, 6).map(
      (r): FetcherEntry => ({
        id: `${r.repo}/${r.fileName}`,
        title: r.name,
        extra: `${r.from} · ${Math.round(r.bytes / 1024)}KB`,
        keyword: kw,
        episodes: [],
        raw: r
      })
    )
  },

  async fetchEpisode(entry, episode, _ctx): Promise<FetcherEpisodeResult> {
    _ctx.onProgress?.({ step: 3, total: FETCH_STEPS, label: `正在下载弹幕盒子的包并解出第 ${episode} 集…` })
    const raw = entry.raw as Parameters<typeof danmuboxFetchEpisode>[0] | undefined
    if (!raw) throw new Error('弹幕盒子条目缺少下载信息（索引可能已过期，请重新搜索）')
    const r = await danmuboxFetchEpisode(raw, episode)
    if (r.comments.length === 0) throw new Error(`弹幕盒子的包「${entry.title}」里没有可解析的弹幕`)
    log.append('info', 'danmaku', `弹幕盒子取到 ${r.comments.length} 条：${r.detail}`)
    return {
      comments: r.comments,
      detail: `「${entry.title}」${r.detail}`,
      entryName: entry.title,
      keyword: entry.keyword
    }
  }
}

/** 设置页测试用：走与播放完全相同的一条链 */
export async function danmuboxTest(keyword: string, episode = 1): Promise<FetcherEpisodeResult> {
  const ctx: FetcherContext = { title: keyword, episode, aliases: [], keyword }
  const entries = await danmuboxFetcher.search(keyword, ctx)
  if (entries.length === 0) throw new Error(`弹幕盒子索引里没有「${keyword}」`)
  return danmuboxFetcher.fetchEpisode(entries[0], episode, ctx)
}

import type { DanmakuFetcher, FetcherContext, FetcherEntry, FetcherEpisodeResult } from './types'
import { FETCH_STEPS } from './types'
import { fillTemplate } from '../danmakuSources'
import { parseDanmakuText } from '../danmakuLibrary'
import { httpGetBuffer } from '../../net'

/**
 * 直链/模板型获取器（V1.2 保留的老能力）。
 *
 * 用户这次说"弹幕源目前只有巴哈与弹幕盒子"，但设置里已经允许用户添加直链规则；
 * 直接删掉会让这些用户的自定义源静默失效。所以保留成第三个 fetcher：
 * 它不出现在「选择启用弹幕源」的两个默认项里，只在用户自己加了 link 规则时参与。
 */
export const linkFetcher: DanmakuFetcher = {
  id: 'link',
  name: '数据源链接（直链/模板）',
  kind: 'link',

  async search(keyword, ctx) {
    const tpl = ctx.source?.urlTemplate?.trim()
    if (!tpl) return []
    ctx.onProgress?.({ step: 1, total: FETCH_STEPS, label: `正在按直链模板取「${keyword}」…` })
    return [
      {
        id: tpl,
        title: ctx.source?.name || keyword,
        keyword,
        extra: tpl,
        episodes: []
      }
    ]
  },

  async fetchEpisode(entry, episode, ctx): Promise<FetcherEpisodeResult> {
    ctx.onProgress?.({ step: 3, total: FETCH_STEPS, label: `正在下载直链弹幕（第 ${episode} 集）…` })
    const url = fillTemplate(String(entry.id), ctx.title || entry.keyword, episode)
    const buf = await httpGetBuffer(url, 30000)
    if (buf.length === 0) throw new Error('直链下载到空文件')
    const parsed = parseDanmakuText(buf.toString('utf-8'))
    if (parsed.comments.length === 0) throw new Error(`直链返回的弹幕解析后为空（格式 ${parsed.format}）`)
    return {
      comments: parsed.comments,
      detail: `直链 ${url}（${parsed.format}）`,
      entryName: ctx.source?.name || url,
      keyword: entry.keyword
    }
  }
}

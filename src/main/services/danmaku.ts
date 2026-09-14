import { createHash } from 'node:crypto'
import axios from 'axios'
import type { DanmakuComment, DanmakuMatch } from '@shared/types'
import { log } from '../log'
import { buildProxyAgents, getSettings } from '../net'

/**
 * 弹幕接口（预留，v0.2.4）：对接弹弹play 开放平台，接入方式与 Kazumi 一致。
 *
 * 弹弹play 的 v2 接口需要 AppId/AppSecret 签名：
 *   X-AppId: <appId>
 *   X-Timestamp: <unix 秒>
 *   X-Signature: base64(sha256(appId + timestamp + path + appSecret))
 * 密钥在「设置 → 数据源」里填写（store 键 `settings.danmakuAppId` / `danmakuAppSecret`），
 * 未填写时接口会返回明确错误而不是静默失败，方便后续接入时排查。
 *
 * 目前的用途只是「预留 + 可被自检调用」，播放器里的渲染层（弹幕轨道）留到下一版实现。
 */

const BASE = 'https://api.dandanplay.net'

interface DanmakuKeys {
  appId: string
  appSecret: string
}

function keys(): DanmakuKeys {
  const s = getSettings() as unknown as { danmakuAppId?: string; danmakuAppSecret?: string }
  return { appId: s.danmakuAppId?.trim() ?? '', appSecret: s.danmakuAppSecret?.trim() ?? '' }
}

export function danmakuConfigured(): boolean {
  const k = keys()
  return Boolean(k.appId && k.appSecret)
}

function authHeaders(path: string): Record<string, string> {
  const { appId, appSecret } = keys()
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const raw = `${appId}${timestamp}${path}${appSecret}`
  const signature = createHash('sha256').update(raw).digest('base64')
  return {
    'X-AppId': appId,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    'X-AppVersion': '0.2.4',
    Accept: 'application/json'
  }
}

async function get<T>(path: string, timeoutMs = 12000): Promise<T> {
  if (!danmakuConfigured()) {
    throw new Error('弹幕接口未配置：请在「设置 → 数据源」填写弹弹play 的 AppId / AppSecret')
  }
  const res = await axios.get<T>(`${BASE}${path}`, {
    timeout: timeoutMs,
    headers: authHeaders(path),
    ...buildProxyAgents(getSettings().proxy)
  })
  return res.data
}

/**
 * 按「番剧名 + 集数」匹配弹幕库条目。
 * 弹弹play 的搜索接口一次返回多条候选，这里取第一条，并在标题里做一次包含匹配优先。
 */
export async function matchDanmaku(title: string, episode: number): Promise<DanmakuMatch | null> {
  const kw = String(title ?? '').trim()
  if (!kw) return null
  const path = `/api/v2/search/episodes?anime=${encodeURIComponent(kw)}&episode=${encodeURIComponent(String(episode || ''))}`
  try {
    const data = await get<{
      success?: boolean
      errorMessage?: string
      animes?: {
        animeId: number
        animeTitle: string
        episodes?: { episodeId: number; episodeTitle: string }[]
      }[]
    }>(path)
    if (!data?.success || !data.animes?.length) {
      log.append('info', 'danmaku', `未匹配到弹幕库条目（${kw} 第${episode}集）`)
      return null
    }
    const exact = data.animes.find((a) => a.animeTitle.includes(kw)) ?? data.animes[0]
    const ep = exact.episodes?.[0]
    if (!ep) {
      log.append('info', 'danmaku', `弹幕库条目没有可用剧集（${exact.animeTitle}）`)
      return null
    }
    return {
      animeId: exact.animeId,
      episodeId: ep.episodeId,
      animeTitle: exact.animeTitle,
      episodeTitle: ep.episodeTitle
    }
  } catch (err) {
    log.append('warn', 'danmaku', `弹幕匹配失败: ${String((err as Error)?.message ?? err)}`)
    throw err
  }
}

/** 拉取某一集的弹幕并解析成统一结构 */
export async function fetchDanmaku(episodeId: number): Promise<DanmakuComment[]> {
  if (!episodeId) return []
  const path = `/api/v2/comment/${episodeId}?withRelated=true&chConvert=0`
  const data = await get<{ comments?: { p?: string; m?: string }[] }>(path, 20000)
  const list = Array.isArray(data?.comments) ? data.comments : []
  const out: DanmakuComment[] = []
  for (const c of list) {
    if (!c?.m) continue
    // p = "出现时间,模式,颜色,用户ID"（时间秒，颜色为十进制 RGB）
    const p = String(c.p ?? '').split(',')
    const time = Number.parseFloat(p[0] ?? '0')
    if (!Number.isFinite(time) || time < 0) continue
    const mode = Number.parseInt(p[1] ?? '1', 10)
    const colorDec = Number.parseInt(p[2] ?? '16777215', 10)
    out.push({
      time,
      text: c.m,
      mode: Number.isFinite(mode) ? mode : 1,
      color: `#${(Number.isFinite(colorDec) ? colorDec : 0xffffff).toString(16).padStart(6, '0')}`
    })
  }
  out.sort((a, b) => a.time - b.time)
  log.append('info', 'danmaku', `拉取弹幕 ${out.length} 条（episodeId=${episodeId}）`)
  return out
}

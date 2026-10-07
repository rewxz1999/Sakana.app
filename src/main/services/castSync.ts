import { BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { CH } from '@shared/channels'
import type { CastDevice, CastMediaInput } from '@shared/types'
import { log } from '../log'
import { store } from '../store'
import { getSettings } from '../net'
import { castDevices, castPlay } from './cast'
import { castRelayUrl } from './castRelay'

/**
 * 电脑端 ↔ 手机接收端的数据同步（v0.3.8）
 *
 * ## 为什么由电脑开接口、手机来拉
 *
 * 投屏的方向是"电脑 → 手机"（电脑是客户端、手机是服务端），但**同步**这件事反过来更省事：
 * 手机只要知道电脑的地址（电脑每次投屏都会把自己的同步地址 `syncUrl` 一起发过去），
 * 就能随时拉收藏/历史、推自己的历史。电脑这边不用知道手机什么时候开机、也不用轮询。
 *
 * ## 接口（都挂在投屏中转服务上，端口 52890，仅局域网可访问）
 *
 *   GET  /sync/ping        → 探活（手机用来确认连上的是 Sakana、拿到电脑名与版本）
 *   GET  /sync/favorites   → 电脑端的收藏列表
 *   GET  /sync/history     → 电脑端的观看历史
 *   POST /sync/history     → 合并手机端的观看历史（按 id 去重，保留更新的那条）
 *   POST /sync/command     → 让电脑替手机干活：解析播放源 → 选集 → 嗅探直链 → 投屏回手机
 *
 * 历史条目里的 `position` / `duration` **一律毫秒**（手机端 Media3 原生单位；
 * 电脑端内部用秒，换算只在本文件里做，见 SyncHistory）。
 *
 * 安全边界要说清：这些接口没有任何鉴权，**只监听局域网**，暴露的是用户自己的收藏与观看历史
 * （不含密码、不含 Cookie）。这与投屏中转本身是同一个信任模型（同一网段内可互访）。
 */

/** 收藏条目的同步形状（只带手机端要展示与播放需要的字段） */
interface SyncFavorite {
  subjectId: number
  name: string
  nameCn: string
  cover: string
  rating: number | null
  airDate: string
  genres: string[]
  eps: number | null
}

interface SyncHistory {
  id: string
  subjectId: number | null
  title: string
  episode: number | null
  position: number
  duration: number
  watchedAt: number
}

/**
 * 历史条目里「进度」的单位约定：`position` / `duration` **一律毫秒**。
 *
 * 手机端 Media3 原生就是毫秒（`WatchRecorder` 直接取 `positionMs` / `durationMs`），
 * 电脑端内部用的却是**秒**（`WatchHistoryItem.durationSec`）。
 * 换算只在这一个文件里做：出口把秒换成毫秒，入口把毫秒换回秒 ——
 * 别处再补一次换算就会双重缩放，手机上会显示成 0:00 或天文数字。
 */
type RawHistory = Record<string, unknown>

/** 电脑端的收藏（读 store，不额外请求网络） */
function readFavorites(): SyncFavorite[] {
  const raw = store.get<unknown>('favorites', [])
  if (!Array.isArray(raw)) return []
  return raw
    .map((f) => {
      const item = f as Record<string, unknown>
      const id = Number(item.subjectId)
      if (!Number.isFinite(id)) return null
      return {
        subjectId: id,
        name: String(item.name ?? ''),
        nameCn: String(item.nameCn ?? item.name_cn ?? ''),
        cover: String(item.cover ?? ''),
        rating: typeof item.rating === 'number' ? item.rating : null,
        airDate: String(item.airDate ?? ''),
        genres: Array.isArray(item.genres) ? (item.genres as string[]).slice(0, 8) : [],
        eps: typeof item.eps === 'number' ? item.eps : null
      } satisfies SyncFavorite
    })
    .filter((x): x is SyncFavorite => x !== null)
}

/** 没有 id 的历史条目用的稳定键（同标题同时间视为同一条） */
function historyId(title: string, watchedAt: number): string {
  return `pc-${createHash('sha1').update(`${title}|${watchedAt}`).digest('hex').slice(0, 12)}`
}

/** 读**原始**历史条目：电脑端的字段比跨端形状多（source / hour / durationSec），合并时要原样保住它们 */
function readRawHistory(): RawHistory[] {
  const raw = store.get<unknown>('watchHistory', [])
  return Array.isArray(raw) ? (raw as RawHistory[]) : []
}

/** 电脑端历史 → 跨端形状（秒 → 毫秒） */
function pcToSync(item: RawHistory): SyncHistory | null {
  const title = String(item.title ?? '').trim()
  if (!title) return null
  const watchedAt = Number(item.watchedAt) || 0
  const durationSec = Number(item.durationSec)
  /*
   * v0.3.8 修：这里原来读的是 `item.duration`，而电脑端存的是 `durationSec` ——
   * 结果推给手机的每一条时长都是 0（手机上的进度条与"还剩多久"全是空的）。
   * 仍然认 `duration`（毫秒）：早期版本把手机推来的条目原样写进过 history。
   */
  const durationMs = durationSec > 0 ? Math.round(durationSec * 1000) : Number(item.duration) || 0
  return {
    id: String(item.id ?? '') || historyId(title, watchedAt),
    subjectId: Number.isFinite(Number(item.subjectId)) ? Number(item.subjectId) : null,
    title,
    episode: Number.isFinite(Number(item.episode)) ? Number(item.episode) : null,
    position: Math.round(Number(item.position) || 0),
    duration: Math.round(durationMs),
    watchedAt
  }
}

/** 电脑端的观看历史（跨端形状，毫秒） */
function readHistory(): SyncHistory[] {
  return readRawHistory()
    .map(pcToSync)
    .filter((x): x is SyncHistory => x !== null)
}

/**
 * 手机端推来的历史 → **电脑端形状**。
 *
 * 为什么必须转换、不能原样存：电脑端的历史是 `WatchHistoryItem`，比跨端形状多三个字段，
 * 而这三个字段全都是界面正在用的：
 *   · `durationSec` —— 工具页「总观看时长」直接 reduce 求和，缺一个就是 NaN；
 *   · `hour`        —— 仪表盘的「时段分布」按它分桶，缺了所有记录都会掉进最后一个桶；
 *   · `source`      —— 历史列表上的「在线 / 本地」标记。
 *
 * `prev` 是电脑端已有的同一条：**保住它独有的字段**（手机只播在线流，不能把"本地"的记成"在线"）。
 */
function syncToPc(item: SyncHistory, prev?: RawHistory): RawHistory {
  const watchedAt = Number(item.watchedAt) || Date.now()
  const title = String(item.title ?? '').trim()
  const durationSec = Math.round((Number(item.duration) || 0) / 1000)
  const prevSource = prev?.source === 'local' || prev?.source === 'online' ? prev.source : null
  const episode = Number.isFinite(Number(item.episode)) ? Number(item.episode) : null
  return {
    ...(prev ?? {}),
    id: String(item.id ?? '').trim() || String(prev?.id ?? '') || historyId(title, watchedAt),
    ...(Number.isFinite(Number(item.subjectId)) ? { subjectId: Number(item.subjectId) } : {}),
    title,
    episode: episode ?? (prev?.episode ?? null),
    source: prevSource ?? 'online',
    watchedAt,
    hour: typeof prev?.hour === 'number' ? prev.hour : new Date(watchedAt).getHours(),
    durationSec: Number(prev?.durationSec) > 0 ? Number(prev?.durationSec) : durationSec
  }
}

/**
 * 合并手机端推来的历史：同 id 保留「看得更晚」的那条，并按电脑端的字段形状落库。
 *
 * 上限跟本机写入保持一致（`addWatch` 是 1000 条），否则从手机同步一次就会把本机后面的记录挤掉。
 */
function mergeHistory(incoming: SyncHistory[]): number {
  const map = new Map<string, RawHistory>()
  for (const raw of readRawHistory()) {
    const item = pcToSync(raw)
    if (!item) continue
    map.set(item.id, { ...raw, id: item.id })
  }
  let merged = 0
  for (const h of incoming) {
    if (!h || !String(h.title ?? '').trim()) continue
    const id = String(h.id ?? '').trim() || historyId(String(h.title).trim(), Number(h.watchedAt) || 0)
    const prev = map.get(id)
    if (prev && (Number(prev.watchedAt) || 0) >= (Number(h.watchedAt) || 0)) continue
    map.set(id, syncToPc({ ...h, id }, prev))
    merged += 1
  }
  if (merged > 0) {
    const next = [...map.values()]
      .sort((a, b) => (Number(b.watchedAt) || 0) - (Number(a.watchedAt) || 0))
      .slice(0, 1000)
    store.set('watchHistory', next)
    log.append('info', 'cast', `已合并手机端观看历史 ${merged} 条（当前共 ${next.length} 条）`)
    notifyLibraryChanged()
  }
  return merged
}

/**
 * 通知所有界面窗口「收藏 / 历史变了，重新读一遍」。
 *
 * 为什么必须有这一步：渲染层把 watchHistory **整份缓存在 zustand 里、整份写回**磁盘
 * （`addWatch` → `api.store.set('watchHistory', next)`）。主进程这边悄悄合并了手机端记录后，
 * 那份旧数组会在用户下次看番时把它整段覆盖掉 —— 表现就是"同步过来的历史过一会儿自己没了"。
 */
function notifyLibraryChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      w.webContents.send(CH.evLibrary)
    } catch {
      /* 窗口正在销毁时忽略 */
    }
  }
}

/**
 * 一次性修复「被写坏的观看历史」（v0.3.8 的合并逻辑自己造成的）。
 *
 * 背景：v0.3.8 早期的合并实现把**整份**历史按手机端的形状回写了 ——
 * `readHistory()` 把每条都映射成 `{id, subjectId, title, episode, position, duration, watchedAt}`，
 * 于是只要同步一次，用户历史里每一条都变成这个样子：
 *   · `source` / `hour` / `durationSec` 全丢 → 工具页「总观看时长」算成 NaN、时段分布全挤进一个桶；
 *   · 原本是 `null` 的集数被 `Number(null)` 变成了 `0`（0 不是合法集数）。
 *
 * 这里只修**确实被写坏**的条目（缺 `source`/`hour`/`durationSec` 任一），正常条目一个字节都不动；
 * 幂等：修完就没有"缺字段"的条目了，再跑不会重复写盘。
 *
 * 修不了的部分说清楚：`source` 已经丢了，按"绝大多数记录来自在线播放"兜底（只有本地播放才写 local）；
 * `hour` 能从时间戳还原；`durationSec` 只能从遗留的毫秒 `duration` 换算，本来就是 0 的仍是 0。
 */
export function repairHistoryShape(): number {
  const raw = readRawHistory()
  let fixed = 0
  const next = raw.map((h) => {
    const healthy =
      typeof h.source === 'string' && typeof h.hour === 'number' && typeof h.durationSec === 'number'
    if (healthy) return h
    fixed += 1
    const watchedAt = Number(h.watchedAt) || 0
    const clean = { ...h } as RawHistory
    clean.source = h.source === 'local' ? 'local' : 'online'
    clean.hour = new Date(watchedAt).getHours()
    clean.durationSec = Math.round((Number(h.duration) || 0) / 1000)
    clean.episode = h.episode === 0 ? null : (h.episode ?? null)
    // 手机端的 `position` / `duration` 对电脑端没有意义，去掉免得以后又被当成秒/毫秒搞混
    delete clean.position
    delete clean.duration
    return clean
  })
  if (fixed > 0) {
    store.set('watchHistory', next)
    log.append('warn', 'cast', `修复了 ${fixed} 条被写坏的观看历史（补回 source/hour/durationSec）`)
    notifyLibraryChanged()
  }
  return fixed
}

/**
 * 让电脑替手机完成「选播放源 → 选集 → 嗅探 → 投屏」。
 *
 * 为什么这件事必须由电脑做：站点解析与直链嗅探要用到应用自己的规则引擎、真实浏览器窗口与
 * 站点会话，手机端没有这套东西（也不该有 —— 那正是它保持小巧的原因）。
 */
async function playSubjectOnPc(
  subjectId: number,
  episodeIndex = 0
): Promise<{ ok: boolean; message: string; episodes?: string[] }> {
  const target = pickTargetDevice()
  if (!target) return { ok: false, message: '电脑端没有找到已连接的手机接收端' }
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return { ok: false, message: '电脑端没有可用窗口，无法解析播放页' }

  const { bangumi } = await import('./bangumi')
  const { ruleSearch, ruleEpisodes, rulePlay } = await import('./rules')
  const detail = await bangumi.subject(subjectId).catch(() => null)
  const info = detail && 'data' in detail ? detail.data : null
  const name = info?.name_cn || info?.name || ''
  if (!name) return { ok: false, message: `拿不到条目 #${subjectId} 的名称，无法搜索` }

  // 规则按「置顶优先」的顺序试；命中就停
  const { sortRulesPinnedFirst } = await import('@shared/types')
  const rules = sortRulesPinnedFirst(
    store
      .get<import('@shared/types').PlayRule[]>('rules', [])
      .filter((r) => r.enabled)
  )
  for (const rule of rules) {
    try {
      const s = await ruleSearch(rule.id, name)
      if (!s.items.length) continue
      const entry = s.items[0]
      const ep = await ruleEpisodes(rule.id, entry)
      const group = ep.groups[0]
      if (!group || group.episodes.length === 0) continue
      const idx = Math.max(0, Math.min(episodeIndex, group.episodes.length - 1))
      const play = await rulePlay(rule.id, entry, 0, idx, group.episodes[idx].link, ep.vars)
      if (!play?.url) continue
      const stream = await sniffStream(win, play.url, rule.baseUrl)
      if (!stream) continue
      const media: CastMediaInput = {
        url: stream.url,
        title: `${name} · 第 ${idx + 1} 集`,
        referer: stream.referer ?? rule.baseUrl,
        cookies: stream.cookies,
        index: idx,
        playlist: group.episodes.map((e, i) => ({ url: '', title: e.name || `第 ${i + 1} 集` }))
      }
      const r = await castPlay(target.id, media)
      if (!r.ok) return { ok: false, message: r.message }
      log.append('info', 'cast', `已替手机端开始播放《${name}》第 ${idx + 1} 集（规则 ${rule.name}）`)
      return {
        ok: true,
        message: `正在播放《${name}》第 ${idx + 1} 集（线路：${rule.name}）`,
        episodes: group.episodes.map((e) => e.name || '')
      }
    } catch (err) {
      log.append('warn', 'cast', `替手机端解析失败（${rule.name}）: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
    }
  }
  return { ok: false, message: `已启用的规则里都搜不到《${name}》，请在电脑上手动播放一次或换一条线路` }
}

/** 用一次完整嗅探拿到直链（复用播放页那套：可见网页视图 → 失败再退回离屏隐藏窗口） */
async function sniffStream(
  win: BrowserWindow,
  pageUrl: string,
  referer: string
): Promise<{ url: string; referer?: string; cookies?: string } | null> {
  const { startRuleProbe, setProbeHook, stopRuleProbe } = await import('./ruleProbe')
  const { openRuleWebview, closeRuleWebview } = await import('./ruleWebview')
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      setProbeHook(null)
      stopRuleProbe()
      closeRuleWebview()
      resolve(null)
    }, 35000)
    setProbeHook((payload) => {
      if (payload.type !== 'found' || typeof payload.url !== 'string') return
      clearTimeout(timer)
      setProbeHook(null)
      stopRuleProbe()
      closeRuleWebview()
      resolve({
        url: payload.url,
        referer: typeof payload.referer === 'string' ? payload.referer : undefined,
        cookies: typeof payload.cookies === 'string' ? payload.cookies : undefined
      })
    })
    const ok = openRuleWebview(win, pageUrl, { x: 0, y: 60, width: 960, height: 480 }, referer)
    if (!ok) startRuleProbe(win, pageUrl, referer)
  })
}

/** 当前要投给哪台设备：用户选过的优先，否则用发现到的第一台 Sakana 接收端 */
export function pickTargetDevice(): CastDevice | null {
  const wanted = String((getSettings() as { castTargetId?: string }).castTargetId ?? '')
  const list = castDevices()
  if (wanted) {
    const hit = list.find((d) => d.id === wanted)
    if (hit) return hit
  }
  return list.find((d) => d.kind === 'sakana') ?? null
}

/** 投屏时告诉手机"电脑的同步地址"，手机据此拉收藏/历史、推自己的历史 */
export function castSyncUrl(): string {
  const { ip, port } = castRelayUrl()
  return port > 0 ? `http://${ip}:${port}` : ''
}

/**
 * 处理 `/sync/*` 请求（由 castRelay 转进来）。返回要回的 JSON 对象；`null` 表示不是同步请求。
 */
export async function handleCastSync(
  pathname: string,
  method: string,
  body: string
): Promise<Record<string, unknown> | null> {
  if (!pathname.startsWith('/sync/')) return null
  if (pathname === '/sync/ping') {
    const { app } = await import('electron')
    return { ok: true, pc: require('node:os').hostname(), version: app.getVersion() }
  }
  if (pathname === '/sync/favorites' && method === 'GET') {
    const items = readFavorites()
    log.append('info', 'cast', `手机端拉取收藏 ${items.length} 条`)
    return { ok: true, items }
  }
  if (pathname === '/sync/history' && method === 'GET') {
    return { ok: true, items: readHistory() }
  }
  if (pathname === '/sync/history' && method === 'POST') {
    let parsed: { items?: SyncHistory[] } = {}
    try {
      parsed = JSON.parse(body || '{}') as { items?: SyncHistory[] }
    } catch {
      return { ok: false, error: '请求体不是合法 JSON' }
    }
    const merged = mergeHistory(Array.isArray(parsed.items) ? parsed.items : [])
    return { ok: true, merged }
  }
  if (pathname === '/sync/command' && method === 'POST') {
    let parsed: { action?: string; subjectId?: number; episodeIndex?: number } = {}
    try {
      parsed = JSON.parse(body || '{}') as typeof parsed
    } catch {
      return { ok: false, error: '请求体不是合法 JSON' }
    }
    if (parsed.action !== 'play-subject') return { ok: false, error: `不支持的动作：${parsed.action}` }
    const id = Number(parsed.subjectId)
    if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'subjectId 无效' }
    const r = await playSubjectOnPc(id, Number(parsed.episodeIndex) || 0)
    return { ok: r.ok, message: r.message, episodes: r.episodes ?? [] }
  }
  return { ok: false, error: `未知的同步接口：${pathname}` }
}

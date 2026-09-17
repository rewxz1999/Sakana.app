import { app, BrowserWindow, dialog } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import axios from 'axios'
import iconv from 'iconv-lite'
import { CH } from '@shared/channels'
import type { GalGame, GalLaunchResult, YmgalCandidate } from '@shared/types'
import { log } from '../log'
import { store } from '../store'
import { buildProxyAgents, getSettings, httpGetBuffer, UA } from '../net'
import { galToolsActivate, galToolsDeactivate } from './galgameTools'
import { galgameCoversDir } from './settingsExt'

// ---------------- 运行状态（进程内） ----------------

interface RunningRun {
  gameId: string
  pid: number
  startedAt: number
  child: ChildProcess | null
  /** 本次运行是否已开启窗口标题检测 */
  detectOn: boolean
  lastTitle: string
  detectTimer: NodeJS.Timeout | null
  /** 标题检测进行中标记，避免并发 powershell */
  probing: boolean
}

const runs = new Map<string, RunningRun>()
let monitorTimer: NodeJS.Timeout | null = null

// ---------------- 事件推送 ----------------

function sendGal(payload: Record<string, unknown>): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(CH.evGal, payload)
  }
}

function pushGames(): void {
  sendGal({ type: 'games', games: galList() })
}

// ---------------- 存储 ----------------

function all(): GalGame[] {
  return store.get<{ games: GalGame[] }>('galgames', { games: [] }).games ?? []
}

function saveGames(games: GalGame[]): void {
  store.set('galgames', { games })
}

function findGame(id: string): GalGame | null {
  return all().find((g) => g.id === id) ?? null
}

function updateGame(id: string, fn: (g: GalGame) => GalGame): GalGame | null {
  const games = all()
  const idx = games.findIndex((g) => g.id === id)
  if (idx < 0) return null
  const next = fn(games[idx])
  games[idx] = next
  saveGames(games)
  return next
}

// ---------------- 列表 / 删除 / 完成标记 ----------------

export function galList(): GalGame[] {
  return all()
}

export function galRemove(id: string): boolean {
  saveGames(all().filter((g) => g.id !== id))
  log.append('info', 'gal', `删除启动方式: ${id}`)
  pushGames()
  return true
}

export function galToggleFinished(id: string): GalGame {
  const g = updateGame(id, (cur) =>
    cur.finished ? { ...cur, finished: false, finishedAt: undefined } : { ...cur, finished: true, finishedAt: Date.now() }
  )
  if (!g) throw new Error('游戏不存在')
  log.append('info', 'gal', `${g.finished ? '标记玩完' : '取消玩完'}: ${g.title}`)
  pushGames()
  return g
}

// ---------------- 文字读取（UTF-8 → GB18030 回退） ----------------

function readTextSmart(p: string): string | null {
  try {
    const buf = readFileSync(p)
    let text = buf.toString('utf-8')
    if (text.includes('\uFFFD')) {
      text = iconv.decode(buf, 'gb18030')
    }
    return text.replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

// ---------------- 文件夹标题推断 ----------------

/** 清理文件夹名/文件名，提取 VNDB 查询关键词 */
function cleanQueryName(raw: string): string {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  // 去除首尾括号对 【】 [] （）() 及括号内的版本/压缩信息
  s = s.replace(/^[【\[]/u, '').replace(/^[】\]]/u, '')
  s = s.replace(/^[【\[]/u, '').replace(/^[】\]]/u, '')
  // 去掉带括号的整段（括号内容仅含版本/汉化等标记时）
  s = s.replace(/[（(【\[][^）)】\]]*[）)】\]]/gu, '')
  // 版本号标记：v1.0 / ver 1.2 / V1.0 / 1.01 等
  s = s.replace(/(?:ver(?:sion)?\.?|v)?\s*\d+(?:\.\d+)+\s*/giu, ' ')
  s = s.replace(/\b(?:汉化|硬盘版|硬盘|免安装|绿色版|R18|全CG|全cg|存档|中文版|官方中文|完全版|合集)\b/gu, ' ')
  // 下划线/连字符结尾看起来像版本号/压缩信息的部分
  const seg = s.split(/[_\-]/)
  if (seg.length > 1) {
    const last = seg[seg.length - 1].trim()
    if (/^(?:\d|v\d|ver|汉化|硬盘|免安装|R18|全CG|存档)/i.test(last)) seg.pop()
    s = seg.join(' ')
  }
  s = s.replace(/\s+/gu, ' ').trim()
  return s
}

/** 从文件夹名/文件名挑选「像标题」的查询串：优先保留 CJK 连续串 */
function pickQueryToken(raw: string): string {
  const cleaned = cleanQueryName(raw)
  if (!cleaned) return ''
  // 优先：CJK 连续片段（包含汉字或日文假名，长度 >= 2）
  const cjk = cleaned.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]{2,}/gu)
  const token = cjk ? cjk[0] : cleaned
  return token.length > 40 ? token.slice(0, 40) : token
}

/** 从文件夹/说明文字推断查询关键词：readme 线索优先，其次文件夹名，最后 exe 名 */
function inferQuery(exePath: string, folderName: string, folderHints: string[]): string {
  for (const hint of folderHints) {
    const q = pickQueryToken(hint)
    if (q && q.length >= 2) return q
  }
  const qFolder = pickQueryToken(folderName)
  if (qFolder && qFolder.length >= 2) return qFolder
  const exeName = basename(exePath, extname(exePath))
  const qExe = pickQueryToken(exeName)
  return qExe && qExe.length >= 2 ? qExe : folderName
}

// ---------------- 文件夹扫描（深度 ≤ 2） ----------------

interface ScanHints {
  /** 说明文件里可能的标题行 */
  titleHints: string[]
  /** 同级其它可执行文件（不含所选 exe） */
  otherExes: string[]
  folderName: string
}

function scanFolder(exePath: string): ScanHints {
  const folder = dirname(exePath)
  const folderName = basename(folder)
  const hints: ScanHints = { titleHints: [], otherExes: [], folderName }

  const textExts = new Set(['.txt', '.md'])
  const interestingNames = ['game.ini', 'config.ini', 'setup.ini']
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (depth < 1) walk(full, depth + 1)
        continue
      }
      if (!st.isFile()) continue
      const lower = name.toLowerCase()
      const isExe = extname(lower) === '.exe'
      if (isExe) {
        // 排除自身，避免把所选的游戏 exe 当成别的
        if (full.toLowerCase() !== exePath.toLowerCase()) {
          hints.otherExes.push(name)
        }
        continue
      }
      const isInteresting = interestingNames.includes(lower) || /配置说明|安装说明|说明|readme|游戏名/.test(lower)
      if (textExts.has(extname(lower)) || isInteresting) {
        const text = readTextSmart(full)
        if (!text) continue
        // 结构化的「游戏名: xxx」行
        const lines = text.replace(/\r/g, '').split('\n')
        for (const line of lines) {
          const m = /(?:游戏名|游戏名称|作品名|タイトル|标题)\s*[:：=]\s*(.+)/u.exec(line)
          if (m && m[1]) {
            const v = m[1].trim().replace(/^[「『"']|[」』"']+$/gu, '')
            if (v && v.length <= 60 && !/[\\/:*?"<>|]/.test(v)) hints.titleHints.push(v)
          } else {
            // 行内容与文件夹名一致（trim 后相等）也算标题线索
            const t = line.trim()
            if (t.length >= 2 && t.length <= 60 && t === folderName) hints.titleHints.push(t)
          }
        }
      }
    }
  }
  walk(folder, 0)
  // 其余 exe 的文件名（去扩展名）也可作为兜底线索
  for (const exe of hints.otherExes) {
    const base = basename(exe, extname(exe))
    if (base && !/[\\/:*?"<>|]/.test(base)) hints.titleHints.push(base)
  }
  return hints
}

// ---------------- VNDB ----------------

const VNDB_BASE = 'https://api.vndb.org/kana'
/** VNDB length 数值 → 英文标签 */
const LENGTH_LABELS: Record<number, string> = {
  1: 'Very short',
  2: 'Short',
  3: 'Medium',
  4: 'Long',
  5: 'Very long'
}

const LENGTH_CN: Record<string, string> = {
  'Very short': '极短',
  Short: '短',
  Medium: '中',
  Long: '长',
  'Very long': '超长'
}

interface VndbVn {
  id?: number | string
  title?: string
  alttitle?: string
  titles?: { lang?: string; title?: string }[]
  released?: string
  length?: number | string
  rating?: number
  description?: string
  developers?: { name?: string }[]
  image?: { url?: string; sexual?: number; violence?: number }
  screenshots?: { url?: string; sexual?: number; violence?: number }[]
  tags?: { name?: string; rating?: number }[]
}

const VNDB_FIELDS =
  'title,alttitle,titles.lang,titles.title,released,length,rating,description,developers.name,image.url,image.sexual,image.violence,screenshots.url,screenshots.sexual,screenshots.violence'

async function vndbQuery(filters: unknown[], fields: string): Promise<VndbVn[]> {
  const res = await axios.post(
    `${VNDB_BASE}/vn`,
    { filters, fields, results: 8 },
    {
      timeout: 15000,
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      ...buildProxyAgents(getSettings().proxy)
    }
  )
  const data = res.data as { results?: VndbVn[] }
  const arr = data?.results
  return Array.isArray(arr) ? arr : []
}

async function vndbQueryWithTags(filters: unknown[]): Promise<VndbVn[]> {
  try {
    return await vndbQuery(filters, `${VNDB_FIELDS},tags.name,tags.rating`)
  } catch {
    // VNDB v2 的 tags 字段可能因缺少 tag 过滤器拒绝请求 → 去掉 tags 重试
    return vndbQuery(filters, VNDB_FIELDS)
  }
}

async function vndbSearch(query: string): Promise<VndbVn | null> {
  let results: VndbVn[]
  try {
    results = await vndbQueryWithTags(['search', '=', query])
  } catch (err) {
    const e = err as { message?: string }
    log.append('warn', 'gal', `VNDB 查询失败 (${query}): ${e?.message ?? String(err)}`)
    throw new Error(e?.message ?? String(err))
  }
  if (results.length === 0) return null
  // 取标题与查询匹配的结果（大小写不敏感、忽略空格）；无匹配则取第一条
  const qNorm = query.toLowerCase().replace(/\s+/g, '')
  for (const vn of results) {
    const names = [String(vn.title ?? ''), String(vn.alttitle ?? '')]
    for (const t of vn.titles ?? []) names.push(String(t.title ?? ''))
    if (names.some((n) => n.toLowerCase().replace(/\s+/g, '') === qNorm)) return vn
  }
  return results[0]
}

async function vndbSearchById(vndbId: string): Promise<VndbVn | null> {
  const results = await vndbQueryWithTags(['id', '=', vndbId])
  return results[0] ?? null
}

interface VndbMeta {
  title: string
  titleCn: string
  vndbId: string
  cover: string | null
  coverRemote: string | null
  /** 横版游戏截图（16:9 高清）：用作 galgame 页面背景，避免竖封面放大后模糊 */
  banner: string | null
  bannerRemote: string | null
  description: string
  released: string
  developers: string[]
  rating: number
  length: string
  tags: string[]
}

/** 从 VNDB 结果构建游戏元数据（不再自动翻译，中文内容由月幕补齐） */
async function vndbBuildMeta(vn: VndbVn): Promise<VndbMeta> {
  const titles = Array.isArray(vn.titles) ? vn.titles : []
  const findLang = (langs: string[]): string => {
    for (const l of langs) {
      const t = titles.find((x) => String(x?.lang ?? '').toLowerCase() === l)
      if (t && t.title) return t.title
    }
    return ''
  }
  // 原作名：优先日文标题，其次主 title
  let title = findLang(['ja', 'ja-jp'])
  if (!title) title = String(vn.title ?? '')
  // 汉化名：优先简中，其次繁中
  const titleCn = findLang(['zh-hans', 'zh']) || findLang(['zh-hant'])

  const plain = (s: unknown): string => String(s ?? '').replace(/\[[^\]]*\]/gu, ' ').replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()

  // 封面：VNDB v2 每条 VN 返回单个 image 对象（含 sexual/violence 标记）。
  // 只有标记为 0/0 的「安全」图才使用，避免收藏夹出现 NSFW 封面。
  let coverUrl = ''
  const img = vn.image
  const imgSafe =
    img?.url &&
    (img.sexual === 0 || img.sexual === undefined) &&
    (img.violence === 0 || img.violence === undefined)
  if (imgSafe) coverUrl = img.url ?? ''
  const coverRemote: string | null = coverUrl || null

  // 下载到本地 galgame-covers/<vndbId>.jpg
  let coverLocal: string | null = null
  if (coverUrl) {
    try {
      const idStr = String(vn.id ?? '')
      const coversDir = galgameCoversDir()
      mkdirSync(coversDir, { recursive: true })
      const file = join(coversDir, `${idStr || 'vndb'}.jpg`)
      const buf = await httpGetBuffer(coverUrl, 30000)
      writeFileSync(file, buf)
      coverLocal = file
    } catch (err) {
      log.append('warn', 'gal', `封面下载失败，回退远程地址: ${String((err as { message?: string })?.message ?? err)}`)
    }
  }

  // 横版背景图：优先取 VNDB 的安全截图（16:9，通常 1280×720，做背景清晰不模糊）
  let bannerRemote: string | null = null
  let bannerLocal: string | null = null
  const shots = Array.isArray(vn.screenshots) ? vn.screenshots : []
  const shotSafe = shots.find(
    (s) =>
      s?.url &&
      (s.sexual === 0 || s.sexual === undefined) &&
      (s.violence === 0 || s.violence === undefined)
  )
  if (shotSafe?.url) {
    bannerRemote = shotSafe.url
    try {
      const idStr = String(vn.id ?? '')
      const coversDir = galgameCoversDir()
      mkdirSync(coversDir, { recursive: true })
      const file = join(coversDir, `vndb-shot-${idStr || 'vndb'}.jpg`)
      const buf = await httpGetBuffer(shotSafe.url, 30000)
      writeFileSync(file, buf)
      bannerLocal = file
    } catch (err) {
      log.append('warn', 'gal', `背景截图下载失败，回退远程地址: ${String((err as { message?: string })?.message ?? err)}`)
    }
  }

  const rawRating = typeof vn.rating === 'number' ? vn.rating : Number(vn.rating ?? 0)
  const rating = Number.isFinite(rawRating) && rawRating > 0 ? Math.round((rawRating > 10 ? rawRating / 10 : rawRating) * 10) / 10 : 0

  let lengthLabel = ''
  const rawLen = vn.length
  if (typeof rawLen === 'number' && LENGTH_LABELS[rawLen]) lengthLabel = LENGTH_LABELS[rawLen]
  else {
    const s = String(rawLen ?? '')
    if (LENGTH_CN[s]) lengthLabel = s
  }

  const tags = Array.isArray(vn.tags)
    ? vn.tags
        .filter((t) => t && t.name && typeof t.rating === 'number' && (t.rating ?? 0) > 0)
        .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
        .slice(0, 5)
        .map((t) => String(t.name ?? ''))
    : []

  const developers = Array.isArray(vn.developers)
    ? vn.developers.map((d) => String(d?.name ?? '')).filter((n) => n)
    : []

  const description = plain(vn.description)

  return {
    title,
    titleCn,
    vndbId: String(vn.id ?? ''),
    cover: coverLocal,
    coverRemote,
    banner: bannerLocal,
    bannerRemote,
    description,
    released: String(vn.released ?? ''),
    developers,
    rating,
    length: lengthLabel,
    tags
  }
}

async function lookupVndb(query: string): Promise<VndbMeta | null> {
  const vn = await vndbSearch(query)
  if (!vn) return null
  return vndbBuildMeta(vn)
}

async function lookupVndbById(vndbId: string): Promise<VndbMeta | null> {
  const vn = await vndbSearchById(vndbId)
  if (!vn) return null
  return vndbBuildMeta(vn)
}

// ---------------- 月幕 Galgame ----------------

const YMGAL_BASE = 'https://www.ymgal.games'
const YMGAL_CLIENT_ID = 'ymgal'
const YMGAL_CLIENT_SECRET = 'luna0327'

interface YmgalListItem {
  id?: number | string
  name?: string
  chineseName?: string
  mainImg?: string
  releaseDate?: string
  orgName?: string
  score?: string | number
}

interface YmgalStaff {
  empName?: string
  jobName?: string
  empDesc?: string
}

interface YmgalGame {
  gid?: number | string
  name?: string
  chineseName?: string
  introduction?: string
  mainImg?: string
  releaseDate?: string
  developerId?: number | string
  staff?: YmgalStaff[]
  /** 出场角色引用（仅 cid/cvId/characterPosition，详情需按 cid 单独请求） */
  characters?: { cid?: number | string; cvId?: number | string; characterPosition?: number | string }[]
}

/** 角色详情（/open/archive?cid=） */
interface YmgalCharacterDetail {
  cid?: number | string
  name?: string
  chineseName?: string
  mainImg?: string
}

/** 解析后的角色元数据（写入 GalGame.ymgal.characters） */
interface YmgalCharacterMeta {
  name: string
  nameCn?: string
  image?: string
  cv?: string
  role?: string
}

interface YmgalMeta {
  id: string
  name: string
  titleCn: string
  description: string
  cover: string | null
  coverRemote: string | null
  /** 横向背景图（月幕无横图字段，回退为 mainImg） */
  banner: string | null
  bannerRemote: string | null
  released: string
  developers: string[]
  staff: { name: string; role: string }[]
  characters: YmgalCharacterMeta[]
  rating: number
  url: string
}

let ymgalTokenCache: { token: string; expiresAt: number } | null = null

async function ymgalToken(): Promise<string> {
  if (ymgalTokenCache && ymgalTokenCache.expiresAt > Date.now() + 60_000) {
    return ymgalTokenCache.token
  }
  const res = await axios.get(`${YMGAL_BASE}/oauth/token`, {
    timeout: 15000,
    params: {
      grant_type: 'client_credentials',
      client_id: YMGAL_CLIENT_ID,
      client_secret: YMGAL_CLIENT_SECRET,
      scope: 'public'
    },
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    ...buildProxyAgents(getSettings().proxy)
  })
  const data = res.data as { access_token?: string; expires_in?: number }
  if (!data?.access_token) throw new Error('月幕 access_token 获取失败')
  ymgalTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
  }
  return ymgalTokenCache.token
}

async function ymgalHeaders(): Promise<Record<string, string>> {
  return {
    'User-Agent': UA,
    Accept: 'application/json;charset=utf-8',
    Authorization: `Bearer ${await ymgalToken()}`,
    version: '1'
  }
}

function ymgalGameUrl(gid: number | string): string {
  return `https://www.ymgal.games/ga${String(gid)}`
}

async function ymgalSearchList(keyword: string, pageSize = 8): Promise<YmgalListItem[]> {
  const headers = await ymgalHeaders()
  const res = await axios.get(`${YMGAL_BASE}/open/archive/search-game`, {
    timeout: 15000,
    params: { mode: 'list', keyword, pageNum: 1, pageSize },
    headers,
    ...buildProxyAgents(getSettings().proxy)
  })
  const data = res.data as { success?: boolean; data?: { result?: YmgalListItem[] } }
  const arr = data?.data?.result
  return Array.isArray(arr) ? arr : []
}

async function ymgalDetail(gid: number | string): Promise<YmgalGame | null> {
  const headers = await ymgalHeaders()
  const res = await axios.get(`${YMGAL_BASE}/open/archive`, {
    timeout: 15000,
    params: { gid: String(gid) },
    headers,
    ...buildProxyAgents(getSettings().proxy)
  })
  const data = res.data as { success?: boolean; data?: { game?: YmgalGame } }
  return data?.data?.game ?? null
}

async function ymgalCharacterDetail(cid: number | string): Promise<YmgalCharacterDetail | null> {
  const headers = await ymgalHeaders()
  const res = await axios.get(`${YMGAL_BASE}/open/archive`, {
    timeout: 15000,
    params: { cid: String(cid) },
    headers,
    ...buildProxyAgents(getSettings().proxy)
  })
  const data = res.data as { success?: boolean; data?: { character?: YmgalCharacterDetail } }
  return data?.data?.character ?? null
}

async function ymgalOrgName(orgId: number | string): Promise<string> {
  const headers = await ymgalHeaders()
  const res = await axios.get(`${YMGAL_BASE}/open/archive`, {
    timeout: 15000,
    params: { orgId: String(orgId) },
    headers,
    ...buildProxyAgents(getSettings().proxy)
  })
  const data = res.data as { data?: { org?: { name?: string; chineseName?: string } } }
  const org = data?.data?.org
  if (!org) return ''
  return String(org.chineseName || org.name || '')
}

/** 由列表条目 + 详情构建月幕元数据（封面下载到本地） */
async function buildYmgalMeta(listItem: YmgalListItem | null, game: YmgalGame): Promise<YmgalMeta> {
  const gid = String(game.gid ?? listItem?.id ?? '')
  const name = String(game.name ?? listItem?.name ?? '')
  const titleCn = String(game.chineseName ?? listItem?.chineseName ?? '')
  const plain = (s: unknown): string => String(s ?? '').replace(/\[[^\]]*\]/gu, ' ').replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()
  const description = plain(game.introduction)
  const released = String(game.releaseDate ?? listItem?.releaseDate ?? '')

  const staff = Array.isArray(game.staff)
    ? game.staff
        .map((s) => ({ name: String(s?.empName ?? '').trim(), role: String(s?.jobName ?? '').trim() }))
        .filter((s) => s.name)
    : []

  // 开发商：优先列表条目自带的 orgName，缺失时按 developerId 查询机构
  let developers: string[] = []
  const orgName = listItem?.orgName ? String(listItem.orgName).trim() : ''
  if (orgName) developers = [orgName]
  else if (game.developerId) {
    try {
      const n = await ymgalOrgName(game.developerId)
      if (n) developers = [n]
    } catch {
      /* 忽略机构查询失败 */
    }
  }

  const coverRemote: string | null = String(game.mainImg ?? listItem?.mainImg ?? '') || null
  let coverLocal: string | null = null
  if (coverRemote) {
    try {
      const coversDir = galgameCoversDir()
      mkdirSync(coversDir, { recursive: true })
      const file = join(coversDir, `ymgal-${gid || 'game'}.jpg`)
      const buf = await httpGetBuffer(coverRemote, 30000)
      writeFileSync(file, buf)
      coverLocal = file
    } catch (err) {
      log.append('warn', 'gal', `月幕封面下载失败，回退远程地址: ${String((err as { message?: string })?.message ?? err)}`)
    }
  }

  // 横向背景图：月幕详情无横图字段（实测仅有 mainImg 竖封面），按规范回退为 mainImg 兜底，绝不空白
  const bannerRemote: string | null = coverRemote
  let bannerLocal: string | null = null
  if (bannerRemote) {
    try {
      const coversDir = galgameCoversDir()
      mkdirSync(coversDir, { recursive: true })
      const file = join(coversDir, `ymgal-banner-${gid || 'game'}.jpg`)
      const buf = await httpGetBuffer(bannerRemote, 30000)
      writeFileSync(file, buf)
      bannerLocal = file
    } catch (err) {
      log.append('warn', 'gal', `月幕背景图下载失败，回退远程地址: ${String((err as { message?: string })?.message ?? err)}`)
    }
  }

  // 出场角色：逐条按 cid 解析详情（名称/中文名/立绘），最多 12 个，全部 best-effort
  const ROLE_BY_POS: Record<string, string> = { '1': '主角', '2': '配角' }
  const charRefs = Array.isArray(game.characters) ? game.characters.slice(0, 12) : []
  const characters: YmgalCharacterMeta[] = []
  for (let i = 0; i < charRefs.length; i++) {
    const ref = charRefs[i]
    const cid = String(ref?.cid ?? '')
    if (!cid) continue
    try {
      const ch = await ymgalCharacterDetail(cid)
      if (!ch) continue
      const cName = String(ch.name ?? '').trim()
      const cNameCn = ch.chineseName ? String(ch.chineseName).trim() : ''
      const imgRemote = String(ch.mainImg ?? '') || null
      let imgLocal: string | undefined
      if (imgRemote) {
        try {
          const coversDir = galgameCoversDir()
          mkdirSync(coversDir, { recursive: true })
          const file = join(coversDir, `ymgal-char-${gid}-${i}.jpg`)
          const buf = await httpGetBuffer(imgRemote, 30000)
          writeFileSync(file, buf)
          imgLocal = file
        } catch (err) {
          log.append('warn', 'gal', `月幕角色立绘下载失败 (cid=${cid}): ${String((err as { message?: string })?.message ?? err)}`)
        }
      }
      const pos = String(ref.characterPosition ?? '')
      const role = ROLE_BY_POS[pos]
      if (cName || cNameCn || imgLocal || imgRemote) {
        characters.push({
          name: cName || cNameCn || '',
          ...(cNameCn ? { nameCn: cNameCn } : {}),
          ...(imgLocal ? { image: imgLocal } : imgRemote ? { image: imgRemote } : {}),
          ...(role ? { role } : {})
        })
      }
    } catch (err) {
      log.append('warn', 'gal', `月幕角色查询失败 (cid=${cid}): ${String((err as { message?: string })?.message ?? err)}`)
    }
  }

  return {
    id: gid,
    name,
    titleCn,
    description,
    cover: coverLocal,
    coverRemote,
    banner: bannerLocal,
    bannerRemote,
    released,
    developers,
    staff,
    characters,
    rating: 0,
    url: ymgalGameUrl(gid)
  }
}

/** 月幕搜索（列表 → 最优匹配 → 详情）；失败抛错由调用方兜底 */
async function lookupYmgal(query: string): Promise<YmgalMeta | null> {
  const items = await ymgalSearchList(query, 8)
  if (items.length === 0) return null
  const qNorm = query.toLowerCase().replace(/\s+/g, '')
  let pick = items[0]
  for (const it of items) {
    const names = [String(it.name ?? ''), String(it.chineseName ?? '')]
    if (names.some((n) => n.toLowerCase().replace(/\s+/g, '') === qNorm)) {
      pick = it
      break
    }
  }
  const game = await ymgalDetail(String(pick.id ?? ''))
  if (!game) return null
  return buildYmgalMeta(pick, game)
}

/** 把月幕元数据合并进已有游戏（覆盖中文展示相关字段） */
function mergeYmgal(cur: GalGame, meta: YmgalMeta): GalGame {
  return {
    ...cur,
    titleCn: meta.titleCn || cur.titleCn,
    descriptionCn: meta.description || cur.descriptionCn,
    cover: meta.cover ?? meta.coverRemote ?? cur.cover ?? undefined,
    released: cur.released || meta.released || undefined,
    developers:
      cur.developers && cur.developers.length > 0
        ? cur.developers
        : meta.developers.length
          ? meta.developers
          : undefined,
    ymgal: {
      title: meta.titleCn || meta.name,
      description: meta.description,
      ...(meta.cover ? { cover: meta.cover } : {}),
      ...(meta.banner ? { banner: meta.banner } : meta.bannerRemote ? { banner: meta.bannerRemote } : {}),
      ...(meta.released ? { released: meta.released } : {}),
      ...(meta.developers.length ? { developers: meta.developers } : {}),
      ...(meta.staff.length ? { staff: meta.staff } : {}),
      ...(meta.characters.length ? { characters: meta.characters } : {}),
      url: meta.url,
      fetchedAt: Date.now()
    }
  }
}

// ---------------- 导入 ----------------

export async function galImport(): Promise<GalGame | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    title: '导入 galgame（选择游戏主程序 .exe）',
    filters: [
      { name: '可执行文件', extensions: ['exe'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  if (r.canceled || !r.filePaths[0]) return null
  const exePath = r.filePaths[0]
  const folder = dirname(exePath)
  const scan = scanFolder(exePath)
  const query = inferQuery(exePath, scan.folderName, scan.titleHints)

  const id = randomUUID()
  const now = Date.now()
  const fallbackTitle = pickQueryToken(scan.folderName) || basename(exePath, extname(exePath)) || scan.folderName

  let game: GalGame
  let vndbError = ''
  let vndbMeta: VndbMeta | null = null
  let ymgalMeta: YmgalMeta | null = null
  try {
    vndbMeta = query ? await lookupVndb(query) : null
  } catch (err) {
    // VNDB 失败：仍以文件夹名标题导入成功
    vndbError = String((err as { message?: string })?.message ?? err)
    log.append('warn', 'gal', `VNDB 查询失败 (${query})，使用本地标题导入: ${vndbError}`)
  }
  if (query) {
    // 月幕搜索：best-effort，失败不影响导入
    try {
      ymgalMeta = await lookupYmgal(query)
    } catch (err) {
      log.append('warn', 'gal', `月幕查询失败 (${query}): ${String((err as { message?: string })?.message ?? err)}`)
    }
  }

  if (vndbMeta) {
    game = {
      id,
      exePath,
      folder,
      title: vndbMeta.title || fallbackTitle,
      titleCn: vndbMeta.titleCn,
      vndbId: vndbMeta.vndbId,
      cover: vndbMeta.cover ?? vndbMeta.coverRemote ?? undefined,
      banner: vndbMeta.banner ?? vndbMeta.bannerRemote ?? undefined,
      description: vndbMeta.description || undefined,
      released: vndbMeta.released || undefined,
      developers: vndbMeta.developers.length ? vndbMeta.developers : undefined,
      rating: vndbMeta.rating || undefined,
      length: vndbMeta.length ? LENGTH_CN[vndbMeta.length] || vndbMeta.length : undefined,
      tags: vndbMeta.tags.length ? vndbMeta.tags : undefined,
      playtimeSec: 0,
      finished: false,
      importedAt: now
    }
  } else {
    game = {
      id,
      exePath,
      folder,
      title: fallbackTitle,
      titleCn: '',
      playtimeSec: 0,
      finished: false,
      importedAt: now
    }
  }

  // 月幕数据优先用于中文展示（titleCn/descriptionCn/cover/ymgal 对象）
  if (ymgalMeta) {
    game = mergeYmgal(game, ymgalMeta)
  }

  const games = all()
  // 同一 exe 只保留一个启动方式
  const without = games.filter((g) => g.exePath.toLowerCase() !== exePath.toLowerCase())
  saveGames([game, ...without])
  log.append('info', 'gal', `导入 galgame: ${game.title} (${exePath})`)
  pushGames()

  if (vndbError && !ymgalMeta) {
    // VNDB 与月幕都失败：仍以文件夹名导入成功，但让渲染层感知失败提示
    throw new Error(`VNDB 查询失败: ${vndbError}`)
  }
  return game
}

// ---------------- 启动 / 游玩时长 / 标题检测 ----------------

function stopRun(gameId: string, run: RunningRun): void {
  // exit 事件与 monitor 轮询可能并发触发，保证幂等
  if (runs.get(gameId) !== run) return
  if (run.detectTimer) clearInterval(run.detectTimer)
  run.detectTimer = null
  runs.delete(gameId)
  // 累计游玩时长
  const elapsed = Date.now() - run.startedAt
  if (elapsed >= 1000) {
    updateGame(gameId, (g) => ({ ...g, playtimeSec: g.playtimeSec + Math.floor(elapsed / 1000) }))
    pushGames()
  }
  sendGal({ type: 'running', gameId, running: false })
  log.append('info', 'gal', `游戏退出: ${gameId}（本次 ${Math.round(elapsed / 1000)}s）`)
  // 没有游戏在运行 → 关闭截图助手（截图助手随游戏启动/退出）
  if (runs.size === 0) galToolsDeactivate()
}

/** 进程是否仍存活：ESRCH/ENOENT 视为已退出；EPERM 表示存在但无权限（仍存活） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

function tickMonitor(): void {
  for (const [gameId, run] of [...runs.entries()]) {
    if (!pidAlive(run.pid)) {
      stopRun(gameId, run)
    }
  }
  if (runs.size === 0 && monitorTimer) {
    clearInterval(monitorTimer)
    monitorTimer = null
  }
}

function ensureMonitor(): void {
  if (monitorTimer) return
  monitorTimer = setInterval(tickMonitor, 3000)
}

/** PowerShell 读取进程主窗口标题（3s 超时） */
function readWindowTitle(pid: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: string): void => {
      if (settled) return
      settled = true
      resolve(v)
    }
    try {
      // 强制 PowerShell 以 UTF-8 输出：默认控制台编码（中文系统为 GBK）会导致中文标题乱码
      const child = execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowTitle`
        ],
        { timeout: 3000, windowsHide: true, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          void err
          done(String(stdout ?? '').trim())
        }
      )
      child.on('error', () => done(''))
    } catch {
      done('')
    }
  })
}

/** 每 2s 读取一次窗口标题，写入 lastRouteInfo */
function startDetect(gameId: string, run: RunningRun): void {
  if (run.detectTimer) return
  run.detectOn = true
  run.detectTimer = setInterval(() => {
    if (run.probing) return
    run.probing = true
    readWindowTitle(run.pid)
      .then((title) => {
        if (runs.get(gameId) !== run) return
        if (title && title !== run.lastTitle) {
          run.lastTitle = title
          updateGame(gameId, (g) => ({ ...g, lastRouteInfo: title }))
          pushGames()
        }
      })
      .catch(() => undefined)
      .finally(() => {
        run.probing = false
      })
  }, 2000)
}

export async function galLaunch(id: string): Promise<GalLaunchResult> {
  const game = findGame(id)
  if (!game) throw new Error('游戏不存在')
  const running = runs.get(id)
  if (running) {
    // 旧 run 可能已失效（进程早已退出但未清理）：尝试结算后重新启动
    if (pidAlive(running.pid)) {
      throw new Error('游戏已在运行')
    }
    stopRun(id, running)
  }
  if (!existsSync(game.exePath)) throw new Error('游戏主程序不存在，可能已被移动或删除')

  // 启动（分离进程，避免阻塞主进程；stdio 忽略不接管道）
  const child = spawn(game.exePath, [], {
    cwd: game.folder,
    detached: true,
    windowsHide: false,
    stdio: 'ignore'
  })
  child.unref()
  // 先挂 error 监听避免 ENOENT 等异步错误变成 unhandled 'error' 崩溃主进程
  const failed = (err: Error): void => {
    log.append('error', 'gal', `游戏启动失败: ${err.message}`)
    const cur = runs.get(id)
    if (cur && cur.child === child) stopRun(id, cur)
  }
  child.on('error', failed)
  if (!child.pid) {
    // pid 尚不可用 → 等 spawn/error 事件，避免同步误报
    return waitLaunch(id, child)
  }
  return launchPidReady(id, child, child.pid)
}

/** 等待子进程 spawn（pid 就绪）或 error，随后进入正式流程 */
function waitLaunch(id: string, child: ChildProcess): Promise<GalLaunchResult> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup()
      if (child.pid) resolve(launchPidReady(id, child, child.pid))
      else reject(new Error('游戏启动失败（无法获取进程）'))
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(new Error(`游戏启动失败: ${err.message}`))
    }
    const cleanup = (): void => {
      child.off('spawn', onSpawn)
      child.off('error', onError)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

function launchPidReady(id: string, child: ChildProcess, pid: number): GalLaunchResult {
  const game = findGame(id)
  if (!game) throw new Error('游戏不存在')
  const run: RunningRun = {
    gameId: id,
    pid,
    startedAt: Date.now(),
    child,
    detectOn: false,
    lastTitle: '',
    detectTimer: null,
    probing: false
  }
  // 进程自行退出：立刻结算（精确时长）；monitor 每 3s 轮询作为兜底
  child.on('exit', () => {
    if (runs.get(id) === run) stopRun(id, run)
  })
  runs.set(id, run)
  ensureMonitor()
  sendGal({ type: 'running', gameId: id, running: true })
  log.append('info', 'gal', `启动游戏: ${game.title}`)

  // 截图助手随游戏启动而激活（应用启动时不激活）
  galToolsActivate()

  // 检测程序：设置开启后启动游戏即自动启用（读取窗口标题记录进度，不再弹窗确认）
  if (getSettings().galgameDetect) {
    startDetect(id, run)
  }
  return { started: true }
}

/** 应用退出前的清理（由 ipc.ts 末尾调用） */
export function galShutdown(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer)
    monitorTimer = null
  }
  for (const [gameId, run] of [...runs.entries()]) {
    if (run.detectTimer) clearInterval(run.detectTimer)
    runs.delete(gameId)
    const elapsed = Date.now() - run.startedAt
    if (elapsed >= 1000) {
      updateGame(gameId, (g) => ({ ...g, playtimeSec: g.playtimeSec + Math.floor(elapsed / 1000) }))
    }
  }
  runs.clear()
  galToolsDeactivate()
}

/** 供 ipc.ts 统一调用的服务对象（与工具服务风格一致） */
export const galgameService = {
  list: galList,
  remove: galRemove,
  toggleFinished: galToggleFinished,
  updateDetail: galUpdateDetail,
  searchYmgal: galSearchYmgal,
  applyYmgal: galApplyYmgal,
  setCustomImage: galSetCustomImage,
  clearCustomImage: galClearCustomImage,
  shutdown: galShutdown
}

/** 自定义封面 / 背景图：把用户选中的图片复制进应用数据目录并写入记录 */
export function galSetCustomImage(id: string, kind: 'cover' | 'banner', srcPath: string): GalGame {
  const game = findGame(id)
  if (!game) throw new Error('游戏不存在')
  if (!srcPath || !existsSync(srcPath)) throw new Error('图片文件不存在')
  const ext = extname(srcPath).toLowerCase() || '.jpg'
  const coversDir = galgameCoversDir()
  mkdirSync(coversDir, { recursive: true })
  const dst = join(coversDir, `custom-${id}-${kind}${ext}`)
  try {
    copyFileSync(srcPath, dst)
  } catch (err) {
    throw new Error(`复制图片失败: ${String((err as { message?: string })?.message ?? err)}`)
  }
  const updated = updateGame(id, (g) =>
    kind === 'cover' ? { ...g, customCover: dst } : { ...g, customBanner: dst }
  )
  if (!updated) throw new Error('保存失败')
  log.append('info', 'gal', `自定义${kind === 'cover' ? '封面' : '背景图'}已设置: ${game.title}`)
  pushGames()
  return updated
}

/** 清除自定义封面 / 背景图（回落到数据源图片） */
export function galClearCustomImage(id: string, kind: 'cover' | 'banner'): GalGame {
  const game = findGame(id)
  if (!game) throw new Error('游戏不存在')
  const cur = kind === 'cover' ? game.customCover : game.customBanner
  if (cur && existsSync(cur)) {
    try {
      rmSync(cur, { force: true })
    } catch {
      /* 文件删除失败不影响记录清理 */
    }
  }
  const updated = updateGame(id, (g) =>
    kind === 'cover' ? { ...g, customCover: undefined } : { ...g, customBanner: undefined }
  )
  if (!updated) throw new Error('保存失败')
  pushGames()
  return updated
}

/** VNDB 元数据合并进已有游戏（只覆盖成功返回的字段，保留旧数据兜底） */
function mergeVndb(cur: GalGame, meta: VndbMeta): GalGame {
  const hasYmgalCover = !!cur.ymgal?.cover
  return {
    ...cur,
    title: meta.title || cur.title,
    vndbId: meta.vndbId || cur.vndbId,
    cover: hasYmgalCover ? cur.cover : meta.cover ?? meta.coverRemote ?? cur.cover ?? undefined,
    banner: meta.banner ?? meta.bannerRemote ?? cur.banner,
    description: meta.description || cur.description,
    released: meta.released || cur.released,
    developers: meta.developers.length ? meta.developers : cur.developers,
    rating: meta.rating || cur.rating,
    length: meta.length ? LENGTH_CN[meta.length] || meta.length : cur.length,
    tags: meta.tags.length ? meta.tags : cur.tags,
    titleCn: cur.titleCn || meta.titleCn
  }
}

/** 重新拉取 VNDB + 月幕详情并合并（仅覆盖成功返回的字段，保留旧数据兜底） */
export async function galUpdateDetail(id: string): Promise<GalGame> {
  const game = findGame(id)
  if (!game) throw new Error('游戏不存在')

  // VNDB：有 vndbId 时用 id 精确匹配，否则用标题搜索
  try {
    const meta = game.vndbId ? await lookupVndbById(game.vndbId) : await lookupVndb(game.titleCn || game.title)
    if (meta) {
      updateGame(id, (cur) => mergeVndb(cur, meta))
    }
  } catch (err) {
    log.append('warn', 'gal', `更新详情 VNDB 失败: ${String((err as { message?: string })?.message ?? err)}`)
  }

  // 月幕
  try {
    const meta = await lookupYmgal(game.titleCn || game.title)
    if (meta) {
      updateGame(id, (cur) => mergeYmgal(cur, meta))
    }
  } catch (err) {
    log.append('warn', 'gal', `更新详情月幕失败: ${String((err as { message?: string })?.message ?? err)}`)
  }

  const updated = findGame(id)
  if (!updated) throw new Error('游戏不存在')
  pushGames()
  return updated
}

/** 搜索月幕游戏（最多 8 个候选） */
export async function galSearchYmgal(name: string): Promise<YmgalCandidate[]> {
  const keyword = String(name ?? '').trim()
  if (!keyword) return []
  const items = await ymgalSearchList(keyword, 8)
  return items.map((it) => ({
    id: Number(it.id ?? 0),
    title: String(it.name ?? ''),
    titlesCn: it.chineseName || undefined,
    url: ymgalGameUrl(String(it.id ?? '')),
    cover: it.mainImg || undefined
  }))
}

/** 按候选导入月幕详情到指定游戏 */
export async function galApplyYmgal(id: string, ymgalId: number | string): Promise<GalGame> {
  const game = findGame(id)
  if (!game) throw new Error('游戏不存在')
  const g = await ymgalDetail(String(ymgalId))
  if (!g) throw new Error('月幕未找到该游戏')
  const meta = await buildYmgalMeta(null, g)
  const updated = updateGame(id, (cur) => mergeYmgal(cur, meta))
  if (!updated) throw new Error('游戏不存在')
  pushGames()
  return updated
}

/** 列表查询后向渲染层推送一次运行中快照（页面刷新后能恢复“运行中”角标） */
export function galPushRunning(): void {
  for (const gameId of runs.keys()) {
    sendGal({ type: 'running', gameId, running: true })
  }
}

// ---------------- 供截图助手使用：当前运行的 galgame ----------------

export interface GalRunningInfo {
  gameId: string
  pid: number
  /** 导入的游戏标题（兜底匹配窗口用） */
  gameTitle: string
  /** 检测程序最近一次读到的窗口标题（优先匹配用） */
  lastTitle: string
}

/** 最近启动且仍在运行的 galgame（截图助手只截这个游戏窗口） */
export function galRunningInfo(): GalRunningInfo | null {
  let latest: RunningRun | null = null
  for (const run of runs.values()) {
    if (!latest || run.startedAt > latest.startedAt) latest = run
  }
  if (!latest) return null
  const game = findGame(latest.gameId)
  return {
    gameId: latest.gameId,
    pid: latest.pid,
    gameTitle: game?.title ?? '',
    lastTitle: latest.lastTitle
  }
}

/** 读取指定进程的主窗口标题（截图助手匹配窗口用） */
export function galReadWindowTitle(pid: number): Promise<string> {
  return readWindowTitle(pid)
}

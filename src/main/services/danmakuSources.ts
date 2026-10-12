import { createDecipheriv, createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  DanmakuAdapterInfo,
  DanmakuBoxEntry,
  DanmakuComment,
  DanmakuSource,
  DanmakuSourceKind,
  DanmakuSourceTestResult
} from '@shared/types'
import { log } from '../log'
import { getSettings, httpGetBuffer, httpGetText } from '../net'
import { store } from '../store'
import { episodeNumberFromTitle, seasonOfTitle } from './danmaku'
import { parseDanmakuText } from './danmakuLibrary'

/**
 * 弹幕数据源适配器（v1.1）。
 *
 * ## 三种数据源形态（用户原话：「有可能是 API，有可能是网站，也有可能是数据源链接」）
 * - `api`：有结构化接口的（巴哈姆特动画疯）。走 JSON 接口，稳。
 * - `site`：站点型（弹幕盒子）。它没有搜索 API —— 检索索引是**加密的静态文件**，
 *   适配器得按站点自己的结构去取、去解密。见下面 danmubox 段的详细说明。
 * - `link`：直链/模板型。用户贴地址（或填 `{title}`/`{episode}` 模板），应用只负责下载 + 转格式。
 *   这是「站点检索不了」时唯一能保证可用的路子。
 *
 * ## 与内置弹弹play 弹幕库的关系
 * 内置那条路（`danmaku.ts`）**仍然是默认源**，本模块只在它没拿到弹幕时按优先级补。
 * 两边都不改对方的数据结构与缓存语义。
 *
 * ## 实测结论（2026-10，本机直连）
 * - 弹幕盒子：索引可用（12 个分片、4299 条、AES-ECB 解密），包在 `dmrepository/repoNNN`
 *   仓库里、可由 jsdelivr 下载（`testingcf` 可通、`cdn.jsdelivr` 与 `raw.githubusercontent` 本机不通）。
 *   包是 **7z**，里面是**一个 B 站格式 XML**；用 Windows 自带的 `tar.exe`(bsdtar) 解压（实测可解）。
 * - 巴哈姆特：官方接口 `api.gamer.com.tw` 本机**连不通**（TCP 连接超时，站方有地区限制，
 *   弹幕接口本身就带 `geo=TW,HK`）。默认走社区反代 `bahamut-api-proxy.netlify.app`（实测可通，
 *   搜到并下到弹幕）；用户也可以填自建反代。
 */

// ============================================================
// HTTP
// ============================================================

/** 统一 UA：部分站点（巴哈反代）会看 UA，伪装成它自己的 App 最稳 */
const BAHAMUT_UA =
  'Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4'

async function getJson<T>(url: string, timeoutMs = 15000, headers: Record<string, string> = {}): Promise<T> {
  const text = await httpGetText(url, timeoutMs, { headers })
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`接口返回的不是 JSON（前 60 字：${text.slice(0, 60)}）`)
  }
}

// ============================================================
// 弹幕盒子（site 型）
// ============================================================

/**
 * 弹幕盒子的机制（读它的 `bin/search/main.min.js` + 实测确认，不是猜的）：
 *
 *   1. `https://dmrepository.github.io/list/index` → 逗号分隔的**分片名**（repo001…repo012）；
 *   2. 每个分片 `…/list/<repoNNN>` 是一段 **Base64 的 AES-256-ECB(PKCS7)** 密文；
 *   3. 解密后按 `;` 分条、按 `,` 分字段：`名称,字节数,来源下标,<分片号>/<md5>`；
 *      下载地址 = `https://<镜像>/gh/dmrepository/<分片名>/<分片号>/<md5>.7z`；
 *   4. 站点自己的搜索就是"把所有分片拉下来解密，然后按关键字做子串匹配"（客户端过滤），
 *      所以适配器也这么做，但**把分片缓存在磁盘上**（24 小时），不然每次搜索要下 ~700KB。
 *
 * 为什么密钥是这么一串 32 字节：站点源码里写的是一个 61 字符的字符串，而它自带的（被改过的）
 * crypto-js 取出来的**实际密钥**是其中第 13~44 个字符（`jQoRm5OREM7S3qy3ZBgFV8EqPAP6jsZJ`）。
 * 已用 node:crypto 验证：用它 aes-256-ecb 解出的明文就是上面那种条目表。
 */
const DANMUBOX_INDEX = 'https://dmrepository.github.io/list/index'
const DANMUBOX_KEY = 'jQoRm5OREM7S3qy3ZBgFV8EqPAP6jsZJ'
/** 下载镜像：实测本机能通的是 testingcf；其余留作兜底（顺序即优先级） */
const DANMUBOX_MIRRORS = [
  'https://testingcf.jsdelivr.net/gh/dmrepository',
  'https://fastly.jsdelivr.net/gh/dmrepository',
  'https://cdn.jsdelivr.net/gh/dmrepository',
  'https://raw.githubusercontent.com/dmrepository'
]
/** 站点自己的来源表（下标 → 站名），顺序不能改（索引里存的是下标） */
const DANMUBOX_FROM = ['bilibili', '优酷', '爱奇艺', '腾讯', '第一弹', '动画疯', 'AcFun', '搜狗']
const TTL_INDEX = 24 * 3600 * 1000

function danmuboxCacheDir(): string {
  const base = getSettings().cacheDir?.trim() || join(tmpdir(), 'sakana-danmaku')
  const dir = join(base, 'danmaku', 'danmubox')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 写的时候再报 */
  }
  return dir
}

function danmuboxShard(name: string): string | null {
  const f = join(danmuboxCacheDir(), `${name}.txt`)
  try {
    if (!existsSync(f)) return null
    if (Date.now() - statSync(f).mtimeMs > TTL_INDEX) return null
    return readFileSync(f, 'utf-8')
  } catch {
    return null
  }
}

function aesEcbDecrypt(b64: string): string {
  const buf = Buffer.from(String(b64).trim(), 'base64')
  const d = createDecipheriv('aes-256-ecb', Buffer.from(DANMUBOX_KEY, 'utf8'), null)
  return Buffer.concat([d.update(buf), d.final()]).toString('utf-8')
}

/** 拉取并解密全部分片 → 条目行（带 24 小时磁盘缓存） */
export async function danmuboxIndex(): Promise<{ name: string; from: string; bytes: number; repo: string; fileName: string }[]> {
  const indexText = await httpGetText(DANMUBOX_INDEX, 20000)
  const shards = indexText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (shards.length === 0) throw new Error('弹幕盒子的索引是空的（站点结构可能变了）')
  const out: { name: string; from: string; bytes: number; repo: string; fileName: string }[] = []
  for (const shard of shards) {
    let text = danmuboxShard(shard)
    if (!text) {
      text = await httpGetText(`${DANMUBOX_INDEX.replace(/\/index$/, '')}/${shard}`, 30000)
      try {
        // 缓存的是**密文**（原文就是 Base64），解密不落盘，避免明文索引被别的程序顺手读走
        writeFileSync(join(danmuboxCacheDir(), `${shard}.txt`), text, 'utf-8')
      } catch {
        /* 缓存失败不影响本次搜索 */
      }
    }
    let plain: string
    try {
      plain = aesEcbDecrypt(text)
    } catch (err) {
      throw new Error(`弹幕盒子索引分片 ${shard} 解密失败（站点可能换了密钥）：${String((err as Error)?.message ?? err)}`)
    }
    for (const row of plain.split(';')) {
      const f = row.split(',')
      if (f.length < 4) continue
      out.push({
        name: f[0],
        bytes: Number(f[1]) || 0,
        from: DANMUBOX_FROM[Number(f[2])] ?? `#${f[2]}`,
        repo: shard,
        fileName: f[3]
      })
    }
  }
  return out
}

/** 按关键字搜索引（站点是子串匹配，这里保持一致；大小写不敏感） */
export async function danmuboxSearch(keyword: string): Promise<DanmakuBoxEntry[]> {
  const kw = String(keyword ?? '').trim().toLowerCase()
  if (!kw) return []
  const rows = await danmuboxIndex()
  const hit = rows.filter((r) => r.name.toLowerCase().includes(kw))
  // 名称短的更像"正片"，排前面；同名再按大小降序（大的通常包含更多集/更多弹幕）
  hit.sort((a, b) => a.name.length - b.name.length || b.bytes - a.bytes)
  return hit.map((r) => ({
    name: r.name,
    from: r.from,
    bytes: r.bytes,
    repo: r.repo,
    fileName: `${r.fileName}.7z`,
    url: `${DANMUBOX_MIRRORS[0]}/${r.repo}/${r.fileName}.7z`
  }))
}

/** 下载条目对应的 7z（逐个镜像试，全失败就把试过的状态码报出来） */
async function danmuboxDownload(entry: DanmakuBoxEntry): Promise<Buffer> {
  const tried: string[] = []
  for (const base of DANMUBOX_MIRRORS) {
    const url = `${base}/${entry.repo}/${entry.fileName}`
    try {
      const buf = await httpGetBuffer(url, 60000)
      if (buf.length > 0) return buf
      tried.push('空响应')
    } catch (err) {
      const e = err as { response?: { status?: number }; message?: string }
      tried.push(e?.response?.status ? `HTTP ${e.response.status}` : String(e?.message ?? err).slice(0, 40))
    }
  }
  throw new Error(`弹幕盒子的包下载失败（依次试了 ${DANMUBOX_MIRRORS.length} 个镜像：${tried.join(' / ')}）`)
}

/**
 * 解压 7z。
 *
 * 为什么用系统自带的 `tar.exe`：Windows 10 1803+ 自带 bsdtar（libarchive），**能读 7z**
 * （实测 `bsdtar 3.8.4` 解开弹幕盒子的包）。这样不用为了"解一个压缩包"引入 7zip 依赖，
 * 也不用往安装包里塞一个第三方 exe。找不到 tar.exe 时如实报错，不静默失败。
 */
function extract7z(file: string, destDir: string): string[] {
  const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  if (!existsSync(tar)) {
    throw new Error('系统里没有 tar.exe（Windows 10 1803 以下？），无法解压 7z 弹幕包')
  }
  mkdirSync(destDir, { recursive: true })
  try {
    execFileSync(tar, ['-xf', file, '-C', destDir], { stdio: 'ignore', timeout: 60000 })
  } catch (err) {
    throw new Error(`解压 7z 失败：${String((err as Error)?.message ?? err)}`)
  }
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const full = join(dir, n)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(xml|json)$/i.test(n)) out.push(full)
    }
  }
  walk(destDir)
  return out
}

/**
 * 弹幕盒子的包内文件 → 集数。
 *
 * 实测它的合集包命名是 `<aid>plus_P<分P>.xml`（例如 `av111882plus_P1.xml`，一个「第一季」的包
 * 里能有 361 个这样的文件）。共享的 `episodeNumberFromTitle` 认不出这种（数字前面是字母 P），
 * 所以这里补一条**只用于弹幕盒子包内文件**的规则，然后退回共享解析器。
 *
 * 为什么不直接改共享解析器：它同时承担「番剧集数判定」（决定放哪一集的弹幕），
 * 给字母 P 这种形态开口子会影响现有匹配 —— 宁可在这里多写三行。
 */
function episodeFromPackageFile(name: string): number | null {
  const m = /[_\-–—]P(\d{1,4})(?:\D|$)/i.exec(name)
  if (m) {
    const n = Number.parseInt(m[1], 10)
    if (Number.isFinite(n) && n > 0 && n < 2000) return n
  }
  return episodeNumberFromTitle(name)
}

/**
 * 弹幕盒子的包 → 指定集数的弹幕。
 *
 * 包内通常是**一个** XML（对应条目名那一份弹幕）；「弹幕包」那种合集（站点说明里的
 * 「含 N 个 aid 的弹幕集」）里会有多个文件，那时按文件名里的集数挑，
 * 挑不到就挑第一个并在 detail 里说明（不假装匹配成功）。
 */
export async function danmuboxFetchEpisode(
  entry: DanmakuBoxEntry,
  episode: number
): Promise<{ comments: DanmakuComment[]; detail: string; raw: string }> {
  const tmp = mkdtempSync(join(tmpdir(), 'sakana-danmubox-'))
  try {
    const buf = await danmuboxDownload(entry)
    const pkg = join(tmp, 'pkg.7z')
    writeFileSync(pkg, buf)
    const files = extract7z(pkg, join(tmp, 'out'))
    if (files.length === 0) throw new Error('包解开后没有 .xml/.json 弹幕文件')
    let pick = files[0]
    let how = `包内 ${files.length} 个文件，取第一个`
    if (files.length > 1 && Number(episode) > 0) {
      const want = Math.trunc(Number(episode))
      const matched = files.find((f) => episodeFromPackageFile(basename(f)) === want)
      if (matched) {
        pick = matched
        how = `包内 ${files.length} 个文件，按文件名匹配到第 ${want} 集`
      } else {
        how = `包内 ${files.length} 个文件，没有文件名能对上第 ${want} 集，取了第一个（${basename(pick)}）`
      }
    }
    const raw = readFileSync(pick, 'utf-8')
    const parsed = parseDanmakuText(raw)
    return { comments: parsed.comments, detail: `${how}；${basename(pick)}`, raw }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败无所谓 */
    }
  }
}

// ============================================================
// 巴哈姆特动画疯（api 型）
// ============================================================

/** 默认基址：官方接口国内直连不通（geo 限制），默认走社区反代；可改成自建反代 */
const BAHAMUT_BASE = 'https://bahamut-api-proxy.netlify.app'
/** 集数分类（与站点/包的 VolumeType 一致，用户要求区分这四种） */
const BAHAMUT_VOLUME: Record<string, string> = {
  '0': '本篇（日语）',
  '1': '剧场版/电影',
  '2': 'OVA/特别篇',
  '3': '中文配音'
}

export interface BahamutAnime {
  animeSn: number
  title: string
  cover: string
  info: string
}

/** 搜索（官方 App 的搜索接口，实测反代下可用） */
export async function bahamutSearch(keyword: string, base?: string): Promise<BahamutAnime[]> {
  const kw = String(keyword ?? '').trim()
  if (!kw) return []
  const root = (base?.trim() || BAHAMUT_BASE).replace(/\/+$/, '')
  const data = await getJson<{ anime?: { anime_sn?: number; title?: string; cover?: string; info?: string }[] }>(
    `${root}/mobile_app/anime/v1/search.php?kw=${encodeURIComponent(kw)}`,
    20000,
    { 'User-Agent': BAHAMUT_UA }
  )
  return (data?.anime ?? [])
    .filter((a) => Number(a?.anime_sn) > 0)
    .map((a) => ({ animeSn: Number(a.anime_sn), title: String(a.title ?? ''), cover: String(a.cover ?? ''), info: String(a.info ?? '') }))
}

export interface BahamutEpisodeRef {
  videoSn: number
  volume: string
  volumeName: string
  index: number
  title: string
}

/** 取集：`v3/video.php?anime_sn=` 回 `data.anime.volumes`，键 0/1/2/3 = 本篇/电影/特别篇/中配 */
export async function bahamutEpisodes(animeSn: number, base?: string): Promise<BahamutEpisodeRef[]> {
  const root = (base?.trim() || BAHAMUT_BASE).replace(/\/+$/, '')
  const data = await getJson<{
    data?: { anime?: { volumes?: Record<string, { video_sn?: number; title?: string; video_title?: string }[]> } }
  }>(`${root}/mobile_app/anime/v3/video.php?anime_sn=${Number(animeSn)}`, 25000, { 'User-Agent': BAHAMUT_UA })
  const vols = data?.data?.anime?.volumes ?? {}
  const out: BahamutEpisodeRef[] = []
  for (const key of Object.keys(vols)) {
    const arr = Array.isArray(vols[key]) ? vols[key] : []
    arr.forEach((item, i) => {
      const sn = Number(item?.video_sn)
      if (!(sn > 0)) return
      out.push({
        videoSn: sn,
        volume: key,
        volumeName: BAHAMUT_VOLUME[key] ?? `分类 ${key}`,
        index: i + 1,
        title: String(item?.title ?? item?.video_title ?? '')
      })
    })
  }
  return out
}

/**
 * 取弹幕：`anime/v1/danmu.php?videoSn=<sn>&geo=TW,HK`。
 *
 * 为什么不用移动端包里的 `v3/token.php`（bahamut-anime 的 `episode.danmu()`）：
 * 这个 web 接口**实测拿到了真数据**（3001 条），且字段明确；
 * `token.php` 要配合 App 凭据，本机无法验证，所以不拿它当主路径。
 *
 * 字段映射（实测样本）：
 *   `time` 是 **1/10 秒**（样本最大 14450 → 24.1 分钟，与一集长度吻合）；
 *   `color` 已经是 `#RRGGBB`；`size` 1/2 = 小/大；`position` 0/1/2 = 滚动/顶部/底部
 *   （position 的语义站点没有文档，按播放器三种样式推断；真机上若上下颠倒，改这一处即可）。
 */
export async function bahamutDanmu(
  videoSn: number,
  base?: string
): Promise<{ comments: DanmakuComment[]; raw: number }> {
  const root = (base?.trim() || BAHAMUT_BASE).replace(/\/+$/, '')
  const data = await getJson<{ data?: { danmu?: { text?: string; color?: string; size?: number; position?: number; time?: number }[] } }>(
    `${root}/anime/v1/danmu.php?videoSn=${Number(videoSn)}&geo=TW,HK`,
    30000,
    { 'User-Agent': BAHAMUT_UA }
  )
  const rows = data?.data?.danmu ?? []
  const comments: DanmakuComment[] = []
  for (const r of rows) {
    const text = String(r?.text ?? '')
    if (!text) continue
    const time = (Number(r?.time) || 0) / 10
    if (!Number.isFinite(time) || time < 0) continue
    const pos = Number(r?.position)
    const mode = pos === 1 ? 5 : pos === 2 ? 4 : 1
    const color = /^#[0-9a-f]{6}$/i.test(String(r?.color ?? '')) ? String(r.color) : '#ffffff'
    comments.push({ time, text, mode, color, size: Number(r?.size) === 2 ? 30 : 25 })
  }
  comments.sort((a, b) => a.time - b.time)
  return { comments, raw: rows.length }
}

// ============================================================
// 直链 / 模板（link 型）
// ============================================================

/** 把模板里的占位符换掉：`{title} {episode} {episode2}`（两位补零） */
export function fillTemplate(tpl: string, title: string, episode: number): string {
  return String(tpl ?? '')
    .replace(/\{title\}/g, encodeURIComponent(title))
    .replace(/\{episode2\}/g, String(Math.max(0, Math.trunc(episode))).padStart(2, '0'))
    .replace(/\{episode\}/g, String(Math.max(0, Math.trunc(episode))))
}

// ============================================================
// 集合器：读 / 写 / 适配器自述
// ============================================================

/** 适配器自述（设置页「新增数据源」的下拉与说明都由它生成，实测结论写在这里） */
export const DANMAKU_ADAPTERS: DanmakuAdapterInfo[] = [
  {
    id: 'danmubox',
    name: '弹幕盒子',
    kind: 'site',
    defaultBase: DANMUBOX_INDEX.replace(/\/index$/, ''),
    needTemplate: false,
    desc:
      'danmubox.github.io：按番剧名检索它的加密静态索引（4299 条历史存档，2019–2021 为主），' +
      '下载 7z 包到本地并解出 B 站 XML。实测：索引可搜、包可下（走 testingcf 镜像）、可由系统 tar 解压；' +
      '但索引只到 2021 年，新番基本搜不到。'
  },
  {
    id: 'bahamut',
    name: '巴哈姆特动画疯',
    kind: 'api',
    defaultBase: BAHAMUT_BASE,
    needTemplate: false,
    desc:
      'ani.gamer.com.tw：搜索 → 取集（本篇/剧场版/OVA/中配）→ 取弹幕。' +
      '实测：官方 api.gamer.com.tw 国内直连不通（站方地区限制，弹幕接口自带 geo=TW,HK），' +
      '默认基址是社区反代（可换成自建反代）；反代下实测搜到《敗北女角太多了！》第 1 集 3001 条。'
  },
  {
    id: 'link',
    name: '数据源链接（直链/模板）',
    kind: 'link',
    defaultBase: '',
    needTemplate: true,
    desc:
      '自己贴弹幕文件地址，或用模板让应用按番剧名/集数拼：' +
      '例如 https://example.com/{title}/{episode2}.xml。支持 B 站 XML / 弹弹play JSON / 简单 JSON 数组。' +
      '适合站点检索不了、但有稳定直链的情况。'
  }
]

export function adapterOf(id: string): DanmakuAdapterInfo | undefined {
  return DANMAKU_ADAPTERS.find((a) => a.id === id)
}

/** 当前集合器（设置里的那份，按 priority 排好序） */
export function listSources(): DanmakuSource[] {
  const raw = getSettings().danmaku?.sources ?? []
  return [...raw].sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
}

/** 只在自动加载里参与的源（启用 + 有适配器） */
export function enabledSources(): DanmakuSource[] {
  return listSources().filter((s) => s.enabled && adapterOf(s.adapter))
}

/**
 * 整表保存集合器。
 *
 * 渲染层改完整体提交，这里**再校验一遍**（与统计工具的 apply 一个道理：界面校验是提示，
 * 主进程校验才是底线）：
 * - id 必须唯一，缺失就补一个；
 * - adapter 必须是已知适配器（未知的保留但标 enable 无效，避免整表被拒绝）；
 * - priority 归一化成 1..n（用户拖出来的顺序就是优先级）。
 */
export function saveSources(input: DanmakuSource[]): DanmakuSource[] {
  const seen = new Set<string>()
  const next: DanmakuSource[] = []
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== 'object') continue
    let id = String(raw.id ?? '').trim()
    if (!id || seen.has(id)) id = `src-${createHash('sha1').update(`${raw.adapter}|${raw.name}|${next.length}|${Date.now()}`).digest('hex').slice(0, 8)}`
    seen.add(id)
    const knownAdapter = adapterOf(String(raw.adapter))
    next.push({
      id,
      name: String(raw.name ?? '').trim() || knownAdapter?.name || '未命名数据源',
      kind: (raw.kind ?? knownAdapter?.kind ?? 'api') as DanmakuSourceKind,
      adapter: String(raw.adapter ?? ''),
      /*
       * 启用状态：**适配器不认识（含没填 adapter）就强制停用**。
       * 这种条目留着是为了让用户看得见、改得回来（静默丢掉等于把用户的配置删了），
       * 但它无论如何都执行不了 —— 若仍标成 enabled，自动加载会一次次失败并报
       * "未知适配器"，用户看到的是"明明开着却永远拿不到弹幕"。停用 + 界面上如实标注才对。
       */
      enabled: knownAdapter ? raw.enabled !== false : false,
      priority: Number(raw.priority) || next.length + 1,
      matchMode: raw.matchMode === 'keyword' ? 'keyword' : 'title',
      keyword: typeof raw.keyword === 'string' ? raw.keyword.trim() : '',
      base: typeof raw.base === 'string' ? raw.base.trim() : '',
      credential: typeof raw.credential === 'string' ? raw.credential : '',
      urlTemplate: typeof raw.urlTemplate === 'string' ? raw.urlTemplate.trim() : '',
      note: typeof raw.note === 'string' ? raw.note : '',
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Date.now()
    })
  }
  next.forEach((s, i) => {
    s.priority = i + 1
  })
  const settings = store.get<Record<string, unknown>>('settings', {})
  const danmaku = { ...((settings.danmaku as Record<string, unknown>) ?? {}), sources: next }
  store.set('settings', { ...settings, danmaku })
  log.append('info', 'danmaku', `弹幕数据源集合器已保存（${next.length} 条，启用 ${next.filter((s) => s.enabled).length} 条）`)
  return next
}

// ============================================================
// 测试（真发请求）
// ============================================================

/**
 * 测试一条数据源：**真发请求**并逐步记录（用户要求"不是假按钮"）。
 * 每一步都带耗时与细节，失败就停在那一步并把原因写清；
 * 成功时给出样本条数/条数（巴哈会回「第 1 集 N 条」，这是最能说服人的证据）。
 */
export async function testSource(source: DanmakuSource, keyword?: string): Promise<DanmakuSourceTestResult> {
  const steps: DanmakuSourceTestResult['steps'] = []
  const samples: NonNullable<DanmakuSourceTestResult['samples']> = []
  /** 跑一步并记录（describe 用来把返回值写成一句人话，不写就记「完成」） */
  const step = async <T>(name: string, fn: () => Promise<T>, describe?: (r: T) => string): Promise<T> => {
    const t0 = Date.now()
    try {
      const r = await fn()
      steps.push({ name, ok: true, detail: describe ? describe(r) : '完成', ms: Date.now() - t0 })
      return r
    } catch (err) {
      steps.push({ name, ok: false, detail: String((err as Error)?.message ?? err), ms: Date.now() - t0 })
      throw err
    }
  }

  const kw = String(keyword ?? '').trim() || source.keyword?.trim() || '葬送的芙莉莲'
  try {
    if (source.adapter === 'danmubox') {
      const rows = await step('下载并解密索引', () => danmuboxIndex(), (r) => `共 ${r.length} 条索引记录`)
      const hit = rows.filter((r) => r.name.toLowerCase().includes(kw.toLowerCase()))
      steps.push({ name: `检索「${kw}」`, ok: true, detail: `命中 ${hit.length} 条`, ms: 0 })
      for (const h of hit.slice(0, 5)) samples.push({ title: h.name, extra: `${h.from} · ${Math.round(h.bytes / 1024)}KB · ${h.repo}` })
      if (hit[0]) {
        const entry: DanmakuBoxEntry = {
          name: hit[0].name,
          from: hit[0].from,
          bytes: hit[0].bytes,
          repo: hit[0].repo,
          fileName: `${hit[0].fileName}.7z`,
          url: `${DANMUBOX_MIRRORS[0]}/${hit[0].repo}/${hit[0].fileName}.7z`
        }
        await step('下载第一个命中的包并解压', async () => {
          const r = await danmuboxFetchEpisode(entry, 1)
          samples.push({ title: entry.name, count: r.comments.length, extra: r.detail })
          return `${r.comments.length} 条弹幕（${r.detail}）`
        })
      }
      return {
        ok: true,
        message:
          hit.length > 0
            ? `可用：索引 ${rows.length} 条，检索「${kw}」命中 ${hit.length} 条${hit[0] ? '，并已成功下载解析' : ''}`
            : `索引可用（${rows.length} 条），但「${kw}」没有命中 —— 弹幕盒子是 2019–2021 的存档，新番搜不到`,
        steps,
        samples
      }
    }

    if (source.adapter === 'bahamut') {
      const base = source.base?.trim() || BAHAMUT_BASE
      const animes = await step(
        `搜索「${kw}」`,
        async () => {
          const r = await bahamutSearch(kw, base)
          if (r.length === 0) throw new Error('没有搜到任何番剧（巴哈用繁体/日文标题，可把「搜索关键词」填成繁体名）')
          return r
        },
        (r) => `搜到 ${r.length} 部，首选《${r[0].title}》`
      )
      for (const a of animes.slice(0, 5)) samples.push({ title: a.title, extra: `anime_sn=${a.animeSn} ${a.info}` })
      const first = animes[0]
      const eps = await step(
        '取集列表',
        async () => {
          const r = await bahamutEpisodes(first.animeSn, base)
          if (r.length === 0) throw new Error('这部番没有可播放的集')
          return r
        },
        (r) => `${r.length} 集（含本篇/剧场版/OVA/中配分类）`
      )
      const byVolume = new Map<string, number>()
      for (const e of eps) byVolume.set(e.volumeName, (byVolume.get(e.volumeName) ?? 0) + 1)
      steps.push({
        name: '集数分类',
        ok: true,
        detail: [...byVolume.entries()].map(([k, v]) => `${k} ${v} 集`).join('；'),
        ms: 0
      })
      const pick = eps.find((e) => e.volume === '0') ?? eps[0]
      await step(
        `取弹幕（第 ${pick.index} 集 ${pick.volumeName}）`,
        async () => {
          const r = await bahamutDanmu(pick.videoSn, base)
          samples.push({ title: first.title, episode: pick.index, count: r.comments.length, extra: `${pick.volumeName} · videoSn=${pick.videoSn}` })
          return `${r.comments.length} 条`
        },
        (s) => s
      )
      return {
        ok: true,
        message: `可用：搜到 ${animes.length} 部，首选《${first.title}》，${eps.length} 集，已成功取到弹幕`,
        steps,
        samples
      }
    }

    if (source.adapter === 'link') {
      if (!source.urlTemplate?.trim()) throw new Error('还没有填直链模板（例如 https://…/{title}/{episode2}.xml）')
      const url = fillTemplate(source.urlTemplate, kw, 1)
      await step(
        '按模板下载并解析',
        async () => {
          const buf = await httpGetBuffer(url, 30000)
          if (buf.length === 0) throw new Error('下载到空文件')
          const parsed = parseDanmakuText(buf.toString('utf-8'))
          samples.push({ title: kw, episode: 1, count: parsed.comments.length, extra: `格式 ${parsed.format}` })
          return `${parsed.comments.length} 条（${parsed.format}）`
        },
        (s) => s
      )
      return { ok: true, message: `直链可用：${url}`, steps, samples }
    }

    steps.push({ name: '适配器', ok: false, detail: `未知适配器 ${source.adapter}`, ms: 0 })
    return { ok: false, message: `未知适配器「${source.adapter}」，这条数据源不会生效`, steps, samples }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    log.append('warn', 'danmaku', `数据源测试失败（${source.name}）：${msg}`)
    return { ok: false, message: `测试失败：${msg}`, steps, samples }
  }
}

// ============================================================
// 自动加载：按优先级依次尝试已启用的数据源
// ============================================================

export interface SourceHit {
  comments: DanmakuComment[]
  sourceId: string
  sourceName: string
  detail: string
  entryName?: string
  /** 实际搜出结果的那个关键词（V1.1.2：写进「获取记录」，巴哈为什么只有日文名能搜到就靠它看） */
  keyword?: string
  /** 这条源这一趟花了多少毫秒 */
  ms?: number
}

/**
 * 按优先级尝试已启用的数据源，返回第一个成功拿到的弹幕。
 *
 * 关键词候选顺序（用户要求「容错：中文名/日文名/别名/年份」）：
 *   1. 数据源自己配置的固定关键词（matchMode='keyword'）；
 *   2. 番剧名；
 *   3. 调用方给的别名（番剧库的日文名/其它译名 —— 巴哈用繁体/日文标题，这一条最有用）。
 * 每个候选都失败时，把**每一个**候选的失败原因一并带回去，界面上能看出到底卡在哪。
 */
export async function loadFromSources(
  title: string,
  episode: number,
  aliases: string[] = []
): Promise<{ hit: SourceHit | null; errors: string[] }> {
  const sources = enabledSources()
  const errors: string[] = []
  for (const source of sources) {
    const keywords: string[] = []
    const fixed = source.matchMode === 'keyword' && source.keyword?.trim() ? source.keyword.trim() : ''
    const titleKw = title.trim()
    const aliasKw: string[] = []
    for (const a of aliases) {
      const t = String(a ?? '').trim()
      if (t && !aliasKw.includes(t)) aliasKw.push(t)
    }
    /*
     * 巴哈姆特：**只用日文名与繁体名搜**（用户两次强调的实测结论）。
     *
     * 用户原话：「使用巴哈姆特数据源时只能使用番剧的日文名和繁体名（日文名一般番剧详情里就有）」。
     * 所以这里不再把番剧名本身（一般是简体中文）当候选：
     *   · 日文名 —— 别名里带**假名**（平假名/片假名）的那些，番剧详情里本来就有，是最可靠的一条；
     *   · 繁体名 —— 别名里与标题**不同**的那些（详情页的「别名/中文名」栏常填繁体译名）；
     *   · 简体标题与简体固定关键词**一个都不发**：巴哈搜不到，只会白等一次网络往返，
     *     还可能按标题相似度匹配到无关条目（`pickBahamutAnime` 就是按相似度挑的）。
     * 其它数据源（弹幕盒子/直链）保持原来的顺序：固定关键词 → 番剧名 → 别名。
     */
    const isJapanese = (t: string): boolean => /[\u3040-\u30ff]/.test(t)
    if (source.adapter === 'bahamut') {
      keywords.push(...aliasKw.filter(isJapanese))
      keywords.push(...aliasKw.filter((t) => !isJapanese(t) && t !== titleKw))
      if (fixed && fixed !== titleKw) keywords.push(fixed)
    } else {
      if (fixed) keywords.push(fixed)
      if (titleKw) keywords.push(titleKw)
      keywords.push(...aliasKw)
    }
    if (keywords.length === 0) {
      errors.push(
        source.adapter === 'bahamut'
          ? `${source.name}：没有可用的搜索关键词（巴哈只认日文名/繁体名，这一集的别名里没有）`
          : `${source.name}：没有可用的搜索关键词`
      )
      continue
    }
    try {
      const t0 = Date.now()
      const hit = await trySource(source, keywords, title, episode)
      if (hit) {
        hit.ms = Date.now() - t0
        return { hit, errors }
      }
      errors.push(`${source.name}：没匹配到「${keywords.slice(0, 3).join(' / ')}」`)
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      errors.push(`${source.name}：${msg}`)
      log.append('warn', 'danmaku', `数据源 ${source.name} 失败：${msg}`)
    }
  }
  return { hit: null, errors }
}

/** 单个数据源：逐个关键词搜 → 命中 → 取该集弹幕 */
async function trySource(
  source: DanmakuSource,
  keywords: string[],
  title: string,
  episode: number
): Promise<SourceHit | null> {
  if (source.adapter === 'link') {
    if (!source.urlTemplate?.trim()) throw new Error('没有填直链模板')
    const url = fillTemplate(source.urlTemplate, title || keywords[0], episode)
    const buf = await httpGetBuffer(url, 30000)
    if (buf.length === 0) throw new Error('直链下载到空文件')
    const parsed = parseDanmakuText(buf.toString('utf-8'))
    if (parsed.comments.length === 0) return null
    return {
      comments: parsed.comments,
      sourceId: source.id,
      sourceName: source.name,
      detail: `直链 ${url}`,
      entryName: url
    }
  }

  if (source.adapter === 'bahamut') {
    const base = source.base?.trim() || BAHAMUT_BASE
    for (const kw of keywords) {
      const animes = await bahamutSearch(kw, base)
      // 标题对得上才继续：搜"败犬"也可能回一堆无关条目。
      // ⚠️ 日文名那一支例外，见 pickBahamutAnime 里 usedKeyword 的说明。
      const picked = pickBahamutAnime(animes, keywords, title, kw)
      if (!picked) continue
      const eps = await bahamutEpisodes(picked.animeSn, base)
      if (eps.length === 0) continue
      // 集数优先在本篇（volume 0）里按序号取；本篇没有再看中配/特别篇（并在 detail 里说明）
      const want = Math.max(1, Math.trunc(Number(episode) || 1))
      const inMain = eps.filter((e) => e.volume === '0')
      const target =
        inMain.find((e) => e.index === want) ??
        eps.find((e) => e.index === want && e.volume === '3') ??
        eps.find((e) => e.index === want)
      if (!target) continue
      const r = await bahamutDanmu(target.videoSn, base)
      if (r.comments.length === 0) continue
      return {
        comments: r.comments,
        sourceId: source.id,
        sourceName: source.name,
        detail: `《${picked.title}》第 ${target.index} 集（${target.volumeName}，videoSn=${target.videoSn}）`,
        entryName: picked.title,
        keyword: kw
      }
    }
    return null
  }

  if (source.adapter === 'danmubox') {
    const rows = await danmuboxIndex()
    for (const kw of keywords) {
      const lower = kw.toLowerCase()
      const hit = rows
        .filter((r) => r.name.toLowerCase().includes(lower))
        .sort((a, b) => a.name.length - b.name.length || b.bytes - a.bytes)[0]
      if (!hit) continue
      const entry: DanmakuBoxEntry = {
        name: hit.name,
        from: hit.from,
        bytes: hit.bytes,
        repo: hit.repo,
        fileName: `${hit.fileName}.7z`,
        url: `${DANMUBOX_MIRRORS[0]}/${hit.repo}/${hit.fileName}.7z`
      }
      const r = await danmuboxFetchEpisode(entry, episode)
      if (r.comments.length === 0) continue
      return {
        comments: r.comments,
        sourceId: source.id,
        sourceName: source.name,
        detail: `「${hit.name}」（${hit.from}）${r.detail}`,
        entryName: hit.name
      }
    }
    return null
  }

  throw new Error(`未知适配器「${source.adapter}」`)
}

/**
 * 从巴哈的搜索结果里挑出「跟我们要的是同一部」。
 *
 * 巴哈的搜索是模糊的（搜"敗北女角"也可能回一堆无关条目），所以：
 *   1. 先把标题归一化（去括号/年份/季标记/标点，全角转半角），做包含判断；
 *   2. 标题里带季标记时要求季数一致（避免把第 2 季的弹幕给第 1 季）；
 *   3. 都差不多时挑信息里年份/集数更完整的那条。
 */
function pickBahamutAnime(
  list: BahamutAnime[],
  keywords: string[],
  title: string,
  usedKeyword = ''
): BahamutAnime | null {
  if (list.length === 0) return null
  const norm = (s: string): string =>
    String(s ?? '')
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
      .replace(/[!！?？~～·・:：,，.。'"“”\-—_/\\|]/g, '')
      .replace(/\s+/g, '')
      .toLowerCase()
  /*
   * 用**日文名**搜出来的结果，标题一定是繁体/日文 —— 与简体番剧名本来就对不上，
   * 继续按相似度筛会把正确答案全部筛掉。
   *
   * 这是真机实测出来的（用户点名的两条就是要靠日文名搜）：
   *   拿《葬送のフリーレン》能搜到，但返回的条目叫《葬送的芙莉蓮》，
   *   相似度判定为 0 → 整条被丢弃 → 用户看到的就是"设置里能搜到、播放时没有源弹幕"。
   * 所以日文名这一路改用「巴哈自己的相关性排序 + 正片特征」来挑，不再要求标题能对上。
   */
  if (/[\u3040-\u30ff]/.test(usedKeyword)) {
    const main = list.filter((a) => /共\s*\d+\s*集/.test(a.info))
    return (main[0] ?? list[0]) || null
  }
  const want = norm(title)
  const cands = keywords.map((k) => norm(k)).filter(Boolean)
  const wantSeason = seasonOfTitle(title)
  let best: { a: BahamutAnime; score: number } | null = null
  for (const a of list) {
    const t = norm(a.title)
    if (!t) continue
    if (seasonOfTitle(a.title) !== wantSeason) continue
    let score = 0
    if (want && t === want) score = 100
    else if (want && (t.includes(want) || want.includes(t))) score = 80
    else if (cands.some((k) => t === k)) score = 90
    else if (cands.some((k) => t.includes(k) || k.includes(t))) score = 60
    if (score === 0) continue
    // 信息里带「共 N 集」的条目更可靠（说明是正片而不是预告/花絮）
    if (/共\s*\d+\s*集/.test(a.info)) score += 5
    if (!best || score > best.score) best = { a, score }
  }
  return best?.a ?? null
}

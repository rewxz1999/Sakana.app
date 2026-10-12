import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { app } from 'electron'
import type {
  DanmakuComment,
  DanmakuFormat,
  DanmakuLibraryInfo,
  DanmakuLibraryItem
} from '@shared/types'
import { log } from '../log'
import { getSettings } from '../net'

/**
 * 本地弹幕库（v1.1）。
 *
 * ## 为什么要有它
 * 用户要求「搜索后再下载弹幕到本地，下载的弹幕存在专门的本地文件夹，可以在设置中管理」。
 * 之前弹幕只有两层：**接口缓存**（`<缓存目录>/danmaku/<sha1>.json`，7 天过期、文件名是哈希、
 * 用户看不懂也管不了）与**内存里的合并结果**。数据源下载回来的弹幕是"资产"而不是"缓存"：
 * 它可能来自需要翻墙/需要反代的站点（下一次不一定还能下到），所以必须**落成用户能看见的文件**，
 * 并且能在设置里列出、按番剧/来源筛选、删除、清空、打开目录。
 *
 * ## 目录与命名
 * 默认 `<缓存目录>/danmaku/library/`（缓存目录沿用 `settings.cacheDir`，没设就是
 * `<userData>/cache`），设置里可改（`settings.danmaku.libraryDir`）。
 * 每个「番剧 + 集 + 数据源」一个文件，路径稳定可预测：
 *   `<库根>/<番剧名>/第03集-巴哈姆特动画疯-<短哈希>.xml`
 * 稳定路径的好处：命中本地库时**不需要索引**也能直接算出来（索引只是为了给设置页列大小/条数，
 * 索引丢了也能从磁盘重建 → `rebuildIndex()`）。
 *
 * ## 格式
 * 统一存成 **B 站 XML**（`<i><d p="时间,模式,字号,颜色,…">文本</d></i>`）：
 * 这是弹幕生态里最通用的一种，mpv 的 uosc_danmaku 插件与内置画布渲染器都能直接吃，
 * 弹幕盒子的包本身就是这个格式（下载后原样保留，不做二次转换）。
 */

/** 库根目录（相对路径都为它之下）；`settings.danmaku.libraryDir` 为空时用默认值 */
export function libraryDir(): string {
  const custom = getSettings().danmaku?.libraryDir?.trim()
  if (custom) return custom
  // 与 danmaku.ts 的 cacheDir() 同一套规则：自定义缓存目录优先，否则 userData/cache
  const base = getSettings().cacheDir?.trim() || join(app.getPath('userData'), 'cache')
  return join(base, 'danmaku', 'library')
}

/** 库索引文件（列表用；损坏/丢失都能从磁盘重建） */
function indexPath(): string {
  return join(libraryDir(), 'index.json')
}

export function ensureLibraryDir(): string {
  const dir = libraryDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 已存在或不可写：下面真正写文件时会报错并返回失败 */
  }
  return dir
}

/** 番剧名 → 安全目录名（与播放器截图的命名规则同一套非法字符表） */
function safeName(raw: string): string {
  const s = String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return s || '未命名'
}

/** 短哈希：同名同集可能来自多个数据源，用它区分（避免互相覆盖） */
function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 8)
}

/**
 * 库内相对路径。
 * `第03集` 用两位补零，按文件名排序时与集数顺序一致（用户翻目录时更直观）。
 */
export function libraryRelPath(title: string, episode: number, sourceName: string): string {
  const ep = Number(episode) > 0 ? `第${String(Math.trunc(Number(episode))).padStart(2, '0')}集` : '合集'
  const file = `${ep}-${safeName(sourceName)}-${shortHash(`${title}|${episode}|${sourceName}`)}.xml`
  return join(safeName(title), file)
}

// ---------------- 索引 ----------------

function readIndex(): DanmakuLibraryItem[] {
  try {
    const raw = JSON.parse(readFileSync(indexPath(), 'utf-8')) as { items?: DanmakuLibraryItem[] }
    return Array.isArray(raw?.items) ? raw.items : []
  } catch {
    return []
  }
}

function writeIndex(items: DanmakuLibraryItem[]): void {
  try {
    ensureLibraryDir()
    writeFileSync(indexPath(), JSON.stringify({ items }, null, 2), 'utf-8')
  } catch (err) {
    log.append('warn', 'danmaku', `写弹幕库索引失败: ${String((err as Error)?.message ?? err)}`)
  }
}

/**
 * 从磁盘重建索引（索引被用户删了、或从别处拷了目录进来时用）。
 *
 * 只认 `第NN集-来源-xxxxxxxx.xml` 这种我们自己写出来的命名，
 * 别的文件（用户自己丢进来的）跳过并记一条日志 —— 不猜、不误删。
 */
export function rebuildIndex(): DanmakuLibraryItem[] {
  const dir = libraryDir()
  if (!existsSync(dir)) return []
  const items: DanmakuLibraryItem[] = []
  try {
    for (const titleDir of readdirSync(dir)) {
      const titlePath = join(dir, titleDir)
      if (!statSync(titlePath).isDirectory()) continue
      for (const file of readdirSync(titlePath)) {
        const m = /^第(\d{2})集-(.+)-([0-9a-f]{8})\.xml$/.exec(file)
        if (!m) continue
        const full = join(titlePath, file)
        const st = statSync(full)
        items.push({
          id: `${titleDir}/${file}`,
          title: titleDir,
          episode: Number(m[1]),
          sourceId: 'unknown',
          sourceName: m[2],
          file: join(titleDir, file),
          bytes: st.size,
          count: 0,
          format: 'bili-xml',
          origin: '（索引重建，来源未知）',
          at: st.mtimeMs
        })
      }
    }
  } catch (err) {
    log.append('warn', 'danmaku', `重建弹幕库索引失败: ${String((err as Error)?.message ?? err)}`)
  }
  writeIndex(items)
  return items
}

/** 库总览（给设置页：目录 + 总大小 + 全部条目） */
export function libraryInfo(): DanmakuLibraryInfo {
  const dir = libraryDir()
  let items = readIndex()
  // 索引为空但目录里有东西 → 重建（拷目录进来、或索引被删）
  if (items.length === 0 && existsSync(dir)) items = rebuildIndex()
  const bytes = items.reduce((m, it) => m + (Number(it.bytes) || 0), 0)
  return { dir, bytes, items }
}

// ---------------- 写入 / 删除 ----------------

export interface SaveLibraryInput {
  title: string
  episode: number
  sourceId: string
  sourceName: string
  /** 原始来源描述（如「弹幕盒子：妄想学生会SYD - 第一季」） */
  origin: string
  comments: DanmakuComment[]
  /** 文件内容；不给就用上面的 comments 生成 B 站 XML */
  content?: string
  format?: DanmakuFormat
}

/**
 * 落一条弹幕到本地库（同时更新索引）。
 *
 * 返回落库后的条目；失败抛异常（调用方转成 ApiResult 的失败）——
 * 「下载成功但没存下来」不能当成功报给用户。
 */
export function saveToLibrary(input: SaveLibraryInput): DanmakuLibraryItem {
  const dir = ensureLibraryDir()
  const rel = libraryRelPath(input.title, input.episode, input.sourceName)
  const full = join(dir, rel)
  mkdirSync(dirname(full), { recursive: true })
  const content = input.content ?? toBiliXml(input.comments)
  writeFileSync(full, content, 'utf-8')
  const bytes = Buffer.byteLength(content, 'utf-8')
  const item: DanmakuLibraryItem = {
    id: rel.split(sep).join('/'),
    title: safeName(input.title),
    episode: Number(input.episode) || 0,
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    file: rel,
    bytes,
    count: input.comments.length,
    format: input.format ?? 'bili-xml',
    origin: input.origin,
    at: Date.now()
  }
  const items = readIndex().filter((it) => it.id !== item.id)
  items.push(item)
  writeIndex(items)
  log.append(
    'info',
    'danmaku',
    `弹幕已存入本地库：${item.title} 第${item.episode}集（${item.sourceName}，${item.count} 条，${Math.round(bytes / 1024)}KB）`
  )
  return item
}

/**
 * 命中本地库：按「番剧名 + 集数」找一条已下载的弹幕。
 *
 * 匹配规则（宽松但确定）：
 *   1. 先按库内目录名与番剧名做**归一化相等**（大小写、空格、常见标点差异都抹掉）；
 *   2. 同名的取集数相同的那条；
 *   3. 有多个来源时按传入的 sourcePriority（启用的数据源顺序）优先。
 */
export function lookupLibrary(
  title: string,
  episode: number,
  sourcePriority: string[] = []
): DanmakuLibraryItem | null {
  const norm = (s: string): string =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[\s_\-·・!！?？~～:：,，.。'"“”()（）[\]【】]/g, '')
  const want = norm(title)
  if (!want) return null
  const items = readIndex()
  const hit = items.filter((it) => Math.trunc(it.episode) === Math.trunc(Number(episode) || 0))
  const same = hit.filter((it) => norm(it.title) === want)
  // 归一化没命中时退一步：包含关系（番剧名带副标题/年份的情况很常见）
  const loose = same.length > 0 ? same : hit.filter((it) => norm(it.title).includes(want) || want.includes(norm(it.title)))
  if (loose.length === 0) return null
  const rank = (it: DanmakuLibraryItem): number => {
    const i = sourcePriority.indexOf(it.sourceId)
    return i < 0 ? 999 : i
  }
  return [...loose].sort((a, b) => rank(a) - rank(b) || b.at - a.at)[0]
}

/** 删除若干条（同时删文件；删不到文件也把索引项去掉） */
export function removeFromLibrary(ids: string[]): DanmakuLibraryInfo {
  const dir = libraryDir()
  const all = readIndex()
  const wanted = new Set(ids)
  for (const it of all) {
    if (!wanted.has(it.id)) continue
    try {
      unlinkSync(join(dir, it.file))
    } catch {
      /* 文件已被手动删掉：索引照删 */
    }
  }
  writeIndex(all.filter((it) => !wanted.has(it.id)))
  return libraryInfo()
}

/** 清空整个库（连文件带索引；目录本身保留） */
export function clearLibrary(): DanmakuLibraryInfo {
  const dir = libraryDir()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    log.append('warn', 'danmaku', `清空弹幕库失败: ${String((err as Error)?.message ?? err)}`)
  }
  ensureLibraryDir()
  writeIndex([])
  log.append('info', 'danmaku', '本地弹幕库已清空')
  return libraryInfo()
}

/** 读一条库里的弹幕（自动按内容判格式并解析） */
export function readLibraryComments(item: DanmakuLibraryItem): DanmakuComment[] {
  const full = join(libraryDir(), item.file)
  const text = readFileSync(full, 'utf-8')
  return parseDanmakuText(text).comments
}

/** 库内文件相对路径（设置页/日志展示用，避免把绝对路径铺到界面） */
export function libraryRelativeOf(item: DanmakuLibraryItem): string {
  return relative(libraryDir(), join(libraryDir(), item.file)).split(sep).join('/')
}

// ---------------- 格式解析 / 生成 ----------------

/**
 * 弹幕文本 → 统一结构（格式按**内容**判定，不看扩展名）。
 *
 * 三种格式的 `p` 字段**顺序不同**，这是最容易踩的坑：
 *   · B 站 XML：`p="时间秒,模式,字号,颜色十进制,时间戳,弹幕池,用户ID,行ID"`
 *     —— 颜色在第 **4** 格（下标 3），第 3 格是字号；
 *   · 弹弹play JSON：`p="时间秒,模式,颜色十进制,用户ID"` —— 颜色在下标 **2**；
 *   · 简单 JSON：`[{ time, text, mode, color }]`。
 * 把两者的下标搞混，结果是"弹幕全变成白色/字号被当颜色"，而且不会报错 —— 所以这里分开写。
 */
export function parseDanmakuText(raw: string): { format: DanmakuFormat; comments: DanmakuComment[] } {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim()
  if (!text) return { format: 'bili-xml', comments: [] }
  if (text.startsWith('<')) return { format: 'bili-xml', comments: parseBiliXml(text) }
  try {
    const json = JSON.parse(text) as unknown
    if (Array.isArray(json)) return { format: 'simple-json', comments: parseSimpleJson(json) }
    const obj = json as { comments?: unknown }
    if (Array.isArray(obj?.comments)) {
      // comments[].p 是弹弹play 的形态；如果 p 里逗号多于 3 个，说明其实是 B 站形态的 p
      return { format: 'ddp-json', comments: parseDdpJson(obj.comments) }
    }
  } catch {
    /* 落到下面统一报"解析不了" */
  }
  throw new Error('弹幕格式不认识（支持 B 站 XML / 弹弹play JSON / 简单 JSON 数组）')
}

/** 颜色十进制 → `#rrggbb`（越界一律当白色，与 PC 端弹幕解析一致） */
function colorHex(dec: unknown): string {
  const n = Number.parseInt(String(dec ?? ''), 10)
  const v = Number.isFinite(n) ? Math.max(0, Math.min(0xffffff, n)) : 0xffffff
  return `#${v.toString(16).padStart(6, '0')}`
}

/** B 站 XML：`<d p="时间,模式,字号,颜色,…">文本</d>`（弹幕盒子的包就是这个格式） */
function parseBiliXml(xml: string): DanmakuComment[] {
  const out: DanmakuComment[] = []
  // 只扫 <d p="...">…</d>：弹幕 XML 只有这一种元素，正则比通用 XML 解析器更快、也更抗畸形数据
  const re = /<d\s+p="([^"]*)"\s*>([\s\S]*?)<\/d>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const parts = m[1].split(',')
    const time = Number.parseFloat(parts[0] ?? '0')
    if (!Number.isFinite(time) || time < 0) continue
    const modeRaw = Number.parseInt(parts[1] ?? '1', 10)
    // B 站：1=滚动 4=底部 5=顶部；其它（含 6=逆向、7=高级）按滚动处理
    const mode = modeRaw === 4 ? 4 : modeRaw === 5 ? 5 : 1
    const text = decodeXmlEntities(m[2]).replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
    if (!text) continue
    out.push({ time, text, mode, color: colorHex(parts[3]), size: Number.parseInt(parts[2] ?? '', 10) || undefined })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

/** 弹弹play JSON：`{comments:[{p:"时间,模式,颜色,用户ID", m:"文本"}]}` */
function parseDdpJson(rows: unknown[]): DanmakuComment[] {
  const out: DanmakuComment[] = []
  for (const row of rows) {
    const it = row as { p?: string; m?: string }
    if (!it || typeof it.m !== 'string' || !it.m) continue
    const parts = String(it.p ?? '').split(',')
    const time = Number.parseFloat(parts[0] ?? '0')
    if (!Number.isFinite(time) || time < 0) continue
    const modeRaw = Number.parseInt(parts[1] ?? '1', 10)
    const mode = modeRaw === 4 ? 4 : modeRaw === 5 ? 5 : 1
    out.push({ time, text: it.m, mode, color: colorHex(parts[2]) })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

/** 简单 JSON：`[{time,text,mode,color}]`（用户自己贴的直链常见这种） */
function parseSimpleJson(rows: unknown[]): DanmakuComment[] {
  const out: DanmakuComment[] = []
  for (const row of rows) {
    const it = row as {
      time?: unknown
      t?: unknown
      text?: unknown
      mode?: unknown
      color?: unknown
      c?: unknown
    }
    if (!it) continue
    const text = typeof it.text === 'string' ? it.text : typeof it.c === 'string' ? it.c : ''
    const time = Number(it.time ?? it.t)
    if (!text || !Number.isFinite(time) || time < 0) continue
    const modeRaw = Number(it.mode ?? 1)
    const mode = modeRaw === 4 || modeRaw === 5 ? modeRaw : 1
    let color = '#ffffff'
    if (typeof it.color === 'string') {
      color = it.color.startsWith('#') ? it.color : colorHex(it.color)
    } else if (typeof it.color === 'number') {
      color = colorHex(it.color)
    }
    out.push({ time, text, mode, color })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 弹幕 → B 站 XML（本库的统一存储格式）。
 *
 * `p="时间秒,模式,字号,颜色十进制,…"` —— 与 danmaku.ts 的 `writeDanmakuXml`（交给 mpv 插件那份）
 * 保持**同一形态**，这样两个渲染器看到的是同一份格式，mpv 的 uosc_danmaku 也能直接用。
 */
export function toBiliXml(comments: DanmakuComment[]): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<i>']
  lines.push('  <chatserver>sakana</chatserver>')
  for (const c of comments) {
    const mode = c.mode === 4 || c.mode === 5 ? c.mode : 1
    const parsed = Number.parseInt(String(c.color ?? '').replace('#', ''), 16)
    const color = Number.isFinite(parsed) ? Math.max(0, Math.min(0xffffff, parsed)) : 0xffffff
    const size = c.size && c.size > 0 ? Math.trunc(c.size) : 25
    lines.push(`  <d p="${c.time.toFixed(2)},${mode},${size},${color}">${xmlEscape(String(c.text ?? ''))}</d>`)
  }
  lines.push('</i>')
  return lines.join('\n')
}

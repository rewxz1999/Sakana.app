/*
 * galArchive —— galgame 资源档案的**只读**读取（用于「代号 → 真实曲名」与提取 BGM）。
 *
 * ★ 安全红线：本文件只读**磁盘上游戏自己的文件**，不碰任何进程内存，更没有任何写内存 /
 *   注入 / hook 能力；打开文件只用 'r'，不写入、不修改、不删除游戏目录里的任何东西。
 *
 * 支持两种在真机上验证过的格式：
 *   · KiriKiri XP3（`.xp3`）：索引经 zlib 压缩，解压后是一串 File 块，每个块里有 info（名字 UTF-16）
 *     与 segm（段偏移/大小）；条目数据通常**原样存储** —— 所以既能读脚本/CSV 找曲名，也能完整解包。
 *     ★ 索引位置有三种真实变体（都在真机上遇到过，所以用组合策略去找）：
 *       ① 头部 11 字节 magic 后的 u64 直接就是索引偏移（实测 少女领域 data.xp3）；
 *       ② 该 u64 不是偏移（实测 patch.xp3 / fgimage.xp3 是 23），索引其实在**文件尾部**；
 *       ③ 索引不在尾部 24MB 内（实测 SANA EDITION 的 fgimage.xp3）→ 本版读不了，如实报"不支持"。
 *   · Siglus PFS（`.pfs`）：文件表是**明文**（magic 'pf8' + 重复的
 *     [offset:u32][size:u32][nameLen:u32][name][4 字节]）。但条目内容是加密的，实测读不出正文
 *     —— 所以 Siglus 只能列出代号，曲名/提取/立绘都要如实说"做不到"。
 */

import { closeSync, mkdirSync, openSync, readSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, extname, join } from 'node:path'

export interface ArchiveEntry {
  /** 档案文件绝对路径 */
  archive: string
  /** 档案内条目名（原样，KiriKiri 用 /，Siglus 用 \） */
  name: string
  /** 数据段在档案文件里的偏移 */
  offset: number
  /** 解压后大小 */
  size: number
  /** 档案里实际存的字节数（== size 表示原样存储） */
  packed: number
}

const XP3_MAGIC = Buffer.from([0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01])
/** 索引解压上限：真机实测 3GB 档案的索引 4.5MB，给 64MB 足够且不会撑爆内存 */
const MAX_INDEX_BYTES = 64 * 1024 * 1024
/** 单个条目读取上限（只用来读 CSV/脚本，不读音频） */
const MAX_TEXT_ENTRY_BYTES = 4 * 1024 * 1024
/** 尾部搜索索引 magic 的范围 */
const TAIL_SEARCH_BYTES = 16 * 1024 * 1024

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  const got = readSync(fd, buf, 0, length, offset)
  return got === length ? buf : buf.subarray(0, got)
}

/** 读一个文件的前 n 字节（失败返回 null，绝不抛） */
function readHead(file: string, n: number): Buffer | null {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    return readAt(fd, 0, n)
  } catch {
    return null
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

// ---------------- KiriKiri XP3 ----------------

function parseXp3Index(file: string): ArchiveEntry[] | null {
  let fd = -1
  try {
    const total = statSync(file).size
    if (total < 64) return null
    fd = openSync(file, 'r')
    const head = readAt(fd, 0, 64)
    if (!head.subarray(0, 11).equals(XP3_MAGIC)) return null

    // ① 头部第 11 字节起的 u64（实测 少女领域 data.xp3 就是索引偏移；patch.xp3 那里是 23，不是偏移）
    const headOff = Number(head.readBigUInt64LE(11))
    const fromHead = headOff > 0 && headOff < total ? tryInflateIndexAt(fd, headOff, total) : null
    if (fromHead) {
      const entries = walkXp3FileChunks(fromHead)
      if (entries.length) return entries.map((e) => ({ ...e, archive: file }))
    }

    // ② 尾部 / 头部扫描：找一个能解压出 "File..." 的 zlib 流
    for (const [from, to] of [
      [Math.max(0, total - TAIL_SEARCH_BYTES), total],
      [0, Math.min(total, TAIL_SEARCH_BYTES)]
    ]) {
      const scanned = scanForIndex(fd, from, to)
      if (scanned) {
        const entries = walkXp3FileChunks(scanned)
        if (entries.length) return entries.map((e) => ({ ...e, archive: file }))
      }
    }
    // ③ 都找不到 → 这个档案的索引不是 zlib（实测 SANA EDITION 的 fgimage.xp3 就是），如实返回 null
    return null
  } catch {
    return null
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/** 从某个偏移起尝试把「头 + zlib」解出来；解出来的必须是 XP3 索引（以 "File" 开头） */
function tryInflateIndexAt(fd: number, offset: number, total: number): Buffer | null {
  const blob = readAt(fd, offset, Math.min(total - offset, MAX_INDEX_BYTES))
  for (let skip = 0; skip <= 64; skip++) {
    if (blob.length < skip + 2) break
    if (skip > 0 && blob[skip] !== 0x78) continue
    try {
      const out = inflateSync(blob.subarray(skip))
      if (out.length > 64 && out.subarray(0, 4).toString('latin1') === 'File') return out
    } catch {
      /* 试下一个偏移 */
    }
  }
  return null
}

/**
 * 在 [from,to) 里逐块找 zlib 流（78 9c / 78 da / 78 01 / 78 5e），
 * 解出来以 "File" 开头就当索引。真机实测 patch.xp3 的索引在尾部，扫描 24MB 约 175ms。
 */
function scanForIndex(fd: number, from: number, to: number): Buffer | null {
  const CHUNK = 8 * 1024 * 1024
  let pos = from
  while (pos < to) {
    const len = Math.min(CHUNK, to - pos)
    const buf = readAt(fd, pos, len)
    for (let i = 0; i + 2 < buf.length; i++) {
      if (buf[i] !== 0x78) continue
      const b1 = buf[i + 1]
      if (b1 !== 0x9c && b1 !== 0xda && b1 !== 0x01 && b1 !== 0x5e) continue
      try {
        const out = inflateSync(buf.subarray(i))
        if (out.length > 64 && out.subarray(0, 4).toString('latin1') === 'File') return out
      } catch {
        /* 继续扫 */
      }
    }
    pos += len
  }
  return null
}

/** XP3 索引解压后是一串块：每个条目一个 `File` 块，块内是 info / segm 子块 */
function walkXp3FileChunks(index: Buffer): Omit<ArchiveEntry, 'archive'>[] {
  const out: Omit<ArchiveEntry, 'archive'>[] = []
  let p = 0
  while (p + 12 <= index.length) {
    const chunk = index.toString('latin1', p, p + 4)
    if (!/^[\x20-\x7e]{4}$/.test(chunk)) break
    const chunkSize = Number(index.readBigUInt64LE(p + 4))
    const dataStart = p + 12
    if (dataStart + chunkSize > index.length) break
    if (chunk === 'File') {
      let q = dataStart
      const end = dataStart + chunkSize
      let name = ''
      let size = 0
      let segmStart = -1
      while (q + 12 <= end) {
        const sub = index.toString('latin1', q, q + 4)
        const subSize = Number(index.readBigUInt64LE(q + 4))
        const sd = q + 12
        if (sub === 'info') {
          size = Number(index.readBigUInt64LE(sd + 4))
          const nameLen = index.readUInt16LE(sd + 20)
          name = index.toString('utf16le', sd + 22, sd + 22 + nameLen * 2)
        } else if (sub === 'segm') {
          segmStart = sd
        }
        q = sd + subSize
      }
      if (name && segmStart >= 0) {
        /*
         * 段结构（真机实测）：[u32 计数?][u64 偏移][u64 原大小][u64 存盘大小]。
         * 实测那 4 字节恒为 0、且只有一段，所以按"首个段从 +4 开始"解析；
         * 多段的情况（大文件分片）这里只取第一段 —— 读文本够用，提取音频另有 readEntryData 处理。
         */
        const offset = Number(index.readBigUInt64LE(segmStart + 4))
        const packed = Number(index.readBigUInt64LE(segmStart + 20))
        if (offset > 0 && packed > 0) out.push({ name, offset, size, packed })
      }
    }
    p = dataStart + chunkSize
  }
  return out
}

// ---------------- Siglus PFS（只能列名字） ----------------

function parsePfsIndex(file: string): ArchiveEntry[] | null {
  let fd = -1
  try {
    const total = statSync(file).size
    fd = openSync(file, 'r')
    const magic = readAt(fd, 0, 3)
    if (magic.toString('latin1') !== 'pf8' && magic.toString('latin1') !== 'pf6') return null
    const tableLen = Math.min(total, 8 * 1024 * 1024)
    const table = readAt(fd, 0, tableLen)
    const out: ArchiveEntry[] = []
    let p = 3
    while (p + 16 < table.length && out.length < 200000) {
      const offset = table.readUInt32LE(p)
      const size = table.readUInt32LE(p + 4)
      const nameLen = table.readUInt32LE(p + 8)
      if (nameLen === 0 || nameLen > 1024) break
      const name = table.toString('utf8', p + 12, p + 12 + nameLen)
      if (/[\u0000-\u001f]/.test(name)) break
      p += 12 + nameLen + 4
      if (offset >= total) continue
      out.push({ archive: file, name, offset, size, packed: size })
    }
    return out.length ? out : null
  } catch {
    return null
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

// ---------------- 对外接口（带缓存） ----------------

interface CacheEntry {
  key: string
  entries: ArchiveEntry[]
  /** 能不能读出条目正文（XP3 可以，pf8 不能） */
  readable: boolean
}

const cache = new Map<string, CacheEntry>()

/** 游戏目录里所有档案（.xp3 / .pfs，含分卷 .pfs.000 …） */
export function findArchives(gameDir: string): string[] {
  const out: string[] = []
  let names: string[]
  try {
    names = readdirSync(gameDir)
  } catch {
    return out
  }
  for (const n of names) {
    const lower = n.toLowerCase()
    if (lower.endsWith('.xp3') || /\.pfs(\.\d+)?$/.test(lower)) out.push(join(gameDir, n))
  }
  return out
}

/**
 * 列出游戏目录里所有档案的条目（只读；按「档案路径 + 大小 + mtime」缓存，游戏没更新就不重复解析）。
 * 解析失败的档案会被跳过，不影响其它档案。
 */
export function listArchiveEntries(gameDir: string): ArchiveEntry[] {
  const out: ArchiveEntry[] = []
  for (const archive of findArchives(gameDir)) {
    let key = archive
    try {
      const st = statSync(archive)
      key = `${archive}:${st.size}:${Math.floor(st.mtimeMs)}`
    } catch {
      continue
    }
    const hit = cache.get(archive)
    if (hit && hit.key === key) {
      out.push(...hit.entries)
      continue
    }
    const xp3 = parseXp3Index(archive)
    const entries = xp3 ?? parsePfsIndex(archive) ?? []
    cache.set(archive, { key, entries, readable: !!xp3 })
    if (cache.size > 8) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined && oldest !== archive) cache.delete(oldest)
    }
    out.push(...entries)
  }
  return out
}

/** 某个档案能不能读出正文（XP3 可以；Siglus pf8 实测正文是加密的） */
export function isArchiveReadable(archive: string): boolean {
  const hit = cache.get(archive)
  if (hit) return hit.readable
  /*
   * 缓存里没有 → 现场解析一次再回答（V1.1 复验时补）。
   *
   * 为什么不能让"没缓存"直接等于"读不出"：写缓存的是 `listArchiveEntries`，于是答案会被
   * **调用顺序**决定 —— 先问 `isArchiveReadable(data.xp3)` 得到 false（听起来像"索引被加密"），
   * 而同一个档案只要先被 listArchiveEntries 列过一次就是 true。独立复验脚本按"先判可读、
   * 再列条目"这个最自然的顺序写，当场把 3 卷里内容最多的那卷报成"索引读不出来"；
   * `archiveSummary` 用的是同一个顺序，冷缓存下会固定少算 1 卷。
   * 所以这里自己把缓存喂上：答案只取决于档案本身，与谁先问无关。
   */
  const dir = dirname(archive)
  if (findArchives(dir).includes(archive)) {
    listArchiveEntries(dir)
    const warmed = cache.get(archive)
    if (warmed) return warmed.readable
  }
  return false
}

// ---------------- 自动解包（只写我们自己的解包目录） ----------------

export interface UnpackOptions {
  /** 只解包这些扩展名（小写、含点）；不传 = 全部 */
  exts?: string[]
  /** 单个条目大小上限（超过就跳过；用于避免一次解出几 GB 音频/视频） */
  maxEntryBytes?: number
  /** 解包总量上限（字节） */
  maxTotalBytes?: number
  /** 每个档案最多解多少个条目 */
  maxEntries?: number
  /** 是否覆盖已存在的文件 */
  overwrite?: boolean
}

export interface UnpackResult {
  ok: boolean
  /** 解出来的文件数 */
  files: number
  /** 跳过的条目数（按大小/类型过滤） */
  skipped: number
  /** 解出的总字节 */
  bytes: number
  /** 解包目录 */
  dir: string
  /** 处理过的档案（含读不了索引的） */
  archives: { file: string; entries: number; readable: boolean }[]
  error: string
}

/** 把档案内名字转成安全的相对路径（防目录穿越；保留子目录结构） */
function safeRelPath(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/[<>:"|?*\u0000-\u001f]/g, '_'))
  return parts.join('/')
}

/**
 * 把一个游戏目录里的档案**解包**到 outDir（我们自己的目录，绝不写回游戏目录）。
 * 默认只解文本类（脚本/表/配置），因为这才是"解析曲目表与立绘坐标"需要的东西；
 * 传 exts 可以额外解音频或图片（保存 BGM / 提取立绘时用）。
 *
 * 是 async 的原因：多档案游戏（实测 SANA EDITION 9 个 xp3）里，找 zlib 索引要扫尾部 16MB，
 * 一路同步跑会在主进程里卡住十几秒（界面直接假死）。每解完一个档案就让出一轮事件循环，
 * IPC / 窗口消息还能插进来，界面保持可响应。
 */
export async function unpackArchives(gameDir: string, outDir: string, opts: UnpackOptions = {}): Promise<UnpackResult> {
  const exts = opts.exts ? new Set(opts.exts.map((e) => e.toLowerCase())) : null
  const maxEntry = opts.maxEntryBytes ?? 16 * 1024 * 1024
  const maxTotal = opts.maxTotalBytes ?? 512 * 1024 * 1024
  const maxEntries = opts.maxEntries ?? 20000
  const result: UnpackResult = { ok: true, files: 0, skipped: 0, bytes: 0, dir: outDir, archives: [], error: '' }

  try {
    mkdirSync(outDir, { recursive: true })
  } catch (err) {
    result.ok = false
    result.error = `无法创建解包目录：${String((err as { message?: string })?.message ?? err)}`
    return result
  }

  for (const archive of findArchives(gameDir)) {
    const entries = listArchiveEntries(dirname(archive) === gameDir ? gameDir : gameDir).filter((e) => e.archive === archive)
    const readable = isArchiveReadable(archive)
    result.archives.push({ file: archive, entries: entries.length, readable })
    if (!readable) continue

    for (const entry of entries) {
      if (result.files >= maxEntries || result.bytes >= maxTotal) break
      const ext = extname(entry.name).toLowerCase()
      if (exts && !exts.has(ext)) {
        result.skipped++
        continue
      }
      if (entry.packed > maxEntry) {
        result.skipped++
        continue
      }
      const rel = safeRelPath(entry.name)
      if (!rel) {
        result.skipped++
        continue
      }
      const target = join(outDir, rel)
      if (!opts.overwrite && existsSync(target)) {
        result.files++
        continue
      }
      const r = readArchiveEntry(entry, { maxBytes: maxEntry })
      if (!r.ok || !r.bytes) {
        result.skipped++
        continue
      }
      try {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, r.bytes)
        result.files++
        result.bytes += r.bytes.length
      } catch {
        result.skipped++
      }
    }
    // 一个档案处理完就让一轮：找索引要扫尾部 16MB，多档案游戏不能把主进程按住
    await yieldToLoop()
  }
  return result
}

/** 让出一轮事件循环（Windows/Node 下 setImmediate 最便宜，且不会像 setTimeout 那样有最小延迟） */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 条目名是否像一个「代号 → 曲名」的文本表（真机实测 KiriKiri 用 main/soundlist.csv） */
export function looksLikeTitleTable(name: string): boolean {
  const lower = name.toLowerCase()
  if (!/\.(csv|txt|ini|tsv|json|dat)$/.test(lower)) return false
  return /(soundlist|bgmtitle|bgm|music|sound|track|song|ost)/.test(lower)
}

/**
 * 只读一个条目**开头的 n 字节**（用于读图片头拿尺寸：PNG 的 IHDR 就在开头）。
 * 与 readArchiveEntry 不同，这里**不做大小上限判断** —— 一张 3MB 的立绘只需要前几十字节，
 * 之前用整条读取的上限去卡它，导致大图全被判成"太大读不了"（真机踩过）。
 */
export function readEntryHead(entry: ArchiveEntry, n: number): Buffer | null {
  if (entry.packed !== entry.size) return null // 压缩存储时头字节不是原图开头（图片实测都是原样存）
  let fd = -1
  try {
    fd = openSync(entry.archive, 'r')
    const want = Math.min(n, entry.packed)
    const buf = readAt(fd, entry.offset, want)
    return buf.length ? buf : null
  } catch {
    return null
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

export interface ReadEntryResult {
  ok: boolean
  text?: string
  bytes?: Buffer
  error?: string
}

/**
 * 读一个条目的正文（只读）。文本类条目会顺带给出 UTF-8/UTF-16 解码后的字符串。
 * 读不出来（Siglus 加密、或超出上限）时如实返回 error。
 */
export function readArchiveEntry(entry: ArchiveEntry, opts: { maxBytes?: number } = {}): ReadEntryResult {
  const max = opts.maxBytes ?? MAX_TEXT_ENTRY_BYTES
  if (entry.packed > max) return { ok: false, error: 'ENTRY_TOO_LARGE' }
  if (!isArchiveReadable(entry.archive)) return { ok: false, error: 'ARCHIVE_ENCRYPTED' }
  let fd = -1
  try {
    fd = openSync(entry.archive, 'r')
    const raw = readAt(fd, entry.offset, entry.packed)
    if (!raw.length) return { ok: false, error: 'ENTRY_EMPTY' }
    let data = raw
    // 存盘大小 < 原始大小 = 压缩存；KiriKiri 文本条目常用 zlib
    if (entry.packed !== entry.size) {
      try {
        data = inflateSync(raw)
      } catch {
        return { ok: false, error: 'ENTRY_DECOMPRESS_FAILED' }
      }
    }
    return { ok: true, bytes: data, text: decodeText(data) }
  } catch (err) {
    return { ok: false, error: String((err as { message?: string })?.message ?? err) }
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/** 文本条目解码：优先 BOM / UTF-16，其次 UTF-8 */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2)
  // KiriKiri 的 csv 常是「无 BOM 的 UTF-16LE」：偶数位大量 0x00 就是它
  if (buf.length >= 8) {
    let zeros = 0
    for (let i = 1; i < Math.min(buf.length, 512); i += 2) if (buf[i] === 0) zeros++
    if (zeros > 128) return buf.toString('utf16le')
  }
  return buf.toString('utf8')
}

/** 游戏目录是否看起来存在（供调用方给出更准确的理由） */
export function gameDirExists(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 目录扩展名（调试/日志用） */
export function archiveExt(file: string): string {
  return extname(file).toLowerCase()
}

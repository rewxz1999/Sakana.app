/*
 * galArchive —— galgame 资源档案的**只读**读取（用于「代号 → 真实曲名」与提取 BGM）。
 *
 * ★ 安全红线：本文件只读**磁盘上游戏自己的文件**，不碰任何进程内存，更没有任何写内存 /
 *   注入 / hook 能力；打开文件只用 'r'，不写入、不修改、不删除游戏目录里的任何东西。
 *
 * 支持两种在真机上验证过的格式：
 *   · KiriKiri XP3（`.xp3`）：文件名表在文件尾部、经 zlib 压缩（实测 少女领域 data.xp3：
 *     头部 11 字节 magic + u64 索引偏移；索引 = 17 字节头 + zlib；解压后是一串 File 块，
 *     每个块里有 info（名字 UTF-16）与 segm（段偏移/大小）。**条目数据通常是原样存储的**
 *     —— 所以既能读脚本/CSV 找曲名，也能把 .ogg 原样提取出来。
 *   · Siglus PFS（`.pfs`）：文件表是**明文**（magic 'pf8' + 重复的
 *     [offset:u32][size:u32][nameLen:u32][name][4 字节]）。但条目内容是加密/压缩的，
 *     实测读不出正文 —— 所以 Siglus 只能列出代号，曲名/提取要如实说"做不到"。
 */

import { closeSync, openSync, readSync, readdirSync, statSync, existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { extname, join } from 'node:path'

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

    // ① 头部第 11 字节起的 u64 指向索引（实测 少女领域 data.xp3 就是这样）
    const candidates: number[] = []
    const headOff = Number(head.readBigUInt64LE(11))
    if (headOff > 0 && headOff < total) candidates.push(headOff)
    // ② 兜底：标准 XP3 的索引偏移记在文件尾部的 magic 之后
    const tailLen = Math.min(TAIL_SEARCH_BYTES, total)
    const tail = readAt(fd, total - tailLen, tailLen)
    for (let at = tail.indexOf(XP3_MAGIC); at >= 0; at = tail.indexOf(XP3_MAGIC, at + 1)) {
      if (at + 19 <= tail.length) {
        const o = Number(tail.readBigUInt64LE(at + 11))
        if (o > 0 && o < total) candidates.push(o)
      }
    }

    for (const indexOffset of candidates) {
      const blob = readAt(fd, indexOffset, Math.min(total - indexOffset, MAX_INDEX_BYTES))
      // 索引本体：前面若干字节的头 + zlib 流；真机实测是 17 字节
      let index: Buffer | null = null
      for (let skip = 0; skip <= 32 && !index; skip++) {
        if (blob.length < skip + 2 || blob[skip] !== 0x78) continue
        try {
          index = inflateSync(blob.subarray(skip))
        } catch {
          /* 试下一个偏移 */
        }
      }
      if (!index) continue
      const entries = walkXp3FileChunks(index)
      if (entries.length) return entries.map((e) => ({ ...e, archive: file }))
    }
    return null
  } catch {
    return null
  } finally {
    if (fd >= 0) closeSync(fd)
  }
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
  return hit ? hit.readable : false
}

/** 条目名是否像一个「代号 → 曲名」的文本表（真机实测 KiriKiri 用 main/soundlist.csv） */
export function looksLikeTitleTable(name: string): boolean {
  const lower = name.toLowerCase()
  if (!/\.(csv|txt|ini|tsv|json|dat)$/.test(lower)) return false
  return /(soundlist|bgmtitle|bgm|music|sound|track|song|ost)/.test(lower)
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

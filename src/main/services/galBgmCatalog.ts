/*
 * galBgmCatalog —— 「代号 → 真实曲名」解析 + BGM 提取保存（**只读游戏数据**）。
 *
 * ★ 安全红线：只读磁盘上游戏自己的文件（档案 + 文本表），不读也不写任何进程内存，
 *   更没有任何写内存 / 注入 / hook 能力；提取=把档案里已存在的字节**复制**到 Sakana 的保存目录，
 *   游戏目录里的东西一个字节都不会被改动。
 *
 * 解析顺序（用户指定）：
 *   ① **解包产物**：从 .ks/.tjs/.rpy/.csv 里解析 `bgm "xxx.ogg"` 之类调用 + 曲目表，
 *      按游戏 id 落盘缓存（重新解包才更新，见 galUnpack）；
 *   ② 游戏目录里的明文数据（BGM 目录、csv/ini/json/txt 曲目表）；
 *   ③ 档案里的曲目表（KiriKiri XP3 实测 main/soundlist.csv 就是 `bgm01,Graceful lady`）；
 *   ④ 都没有 → 如实返回「只有代号」，绝不编曲名。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { GalBgmSaved } from '@shared/types'
import { listArchiveEntries, looksLikeTitleTable, readArchiveEntry, type ArchiveEntry } from './galArchive'
import { listUnpackedFiles, readBgmMap, readUnpackManifest, unpackRootDir, writeBgmMap, type GameBgmMap } from './galUnpack'

/** 曲名解析结果（缓存） */
export interface BgmCatalog {
  /** 代号（小写、去扩展名）→ 曲名 */
  titles: Map<string, string>
  /** 代号 → 档案里的真实文件名（含子目录，例如 `bgm/bgm01.ogg`）——内存联动时显示"真实文件名" */
  files: Map<string, string>
  /** 曲名来源（给界面/日志看，例如「档案 main/soundlist.csv」） */
  source: string
  /** 已知的 BGM 代号（小写、去扩展名）——没有曲名时用来如实说明"只有代号" */
  codes: Set<string>
}

/**
 * 按游戏目录找到「之前解包/解析过」的曲名映射（解包缓存是按游戏 id 落的盘，
 * 这里用 manifest 里的 gameDir 反查；只有重新解包才会更新，符合"重新解包才更新"的要求）。
 */
function readGameBgmMapByDir(gameDir: string): GameBgmMap | null {
  let ids: string[]
  try {
    ids = readdirSync(unpackRootDir())
  } catch {
    return null
  }
  for (const id of ids) {
    const manifest = readUnpackManifest(id)
    if (!manifest || manifest.gameDir !== gameDir) continue
    const map = readBgmMap(id)
    if (map) return map
  }
  return null
}

const catalogCache = new Map<string, { key: string; catalog: BgmCatalog }>()

/** 代号归一化：`sound\bgm\bgm01_a.ogg` → `bgm01_a` */
export function normalizeCode(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? raw
  return base.replace(/\.[a-z0-9]+$/i, '').toLowerCase()
}

// ---------------- 从解包产物解析「代号 → 真实文件名/曲名」 ----------------

/**
 * 从脚本里抽出 BGM 调用（用户指定的步骤③）。
 * 覆盖真机上常见的几种写法：
 *   · KiriKiri/KAG：`[playbgm storage="bgm01"]`、`[bgm storage="bgm/bgm01.ogg" loop=true]`
 *   · KiriKiri/TJS：`SoundLibrary.playBGM("bgm01")`、`playBGM("sound/bgm/bgm01.ogg")`
 *   · Ren'Py：`play music "audio/bgm01.ogg"`、`queue music "bgm/op.ogg" fadeout 1.0`
 * 只做字符串匹配，不执行任何脚本内容。
 */
const BGM_CALL_RES: RegExp[] = [
  /\[\s*(?:playbgm|bgm|fadebgm|stopbgm)\b[^\]]*?(?:storage|file)\s*=\s*["']([^"']+)["']/gi,
  /\bplayBGM\s*\(\s*["']([^"']+)["']/gi,
  /\bplaySE\s*\(\s*["']([^"']+)["']/gi, // 少数游戏把 BGM 也走 playSE
  /\bplay\s+music\s+["']([^"']+)["']/gi,
  /\bqueue\s+music\s+["']([^"']+)["']/gi,
  /\bbgm\s+["']([^"']+)["']/gi
]

/** 脚本里出现的音频文件名（含扩展名才算） */
function extractBgmCalls(text: string, into: Map<string, Set<string>>): number {
  let n = 0
  for (const re of BGM_CALL_RES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].trim()
      if (!/\.(ogg|mp3|wav|opus|m4a|flac|aac|adx|hca)$/i.test(raw)) continue
      const code = normalizeCode(raw)
      if (!code) continue
      const set = into.get(code) ?? new Set<string>()
      set.add(raw)
      into.set(code, set)
      n++
    }
  }
  return n
}

/**
 * 抽出**不带扩展名的代号**。
 *
 * 为什么必须做这一步：真机实测 少女领域 的场景脚本（`CN/scn/ky01_1.txt.scn`）里
 * BGM 是用**纯代号**引用的（字符串表里就是 `bgm` `bgm01` `bgm06` … `bgm_BGM01`），不带 `.ogg`。
 * 只认"带扩展名的调用"会一条都解析不到 —— 本版第一遍就踩了这个坑：
 * 解包出 40 个 .ks / 349 个 .scn，结果"脚本调用 0 个代号"。KAG 脚本里 `bgm01`
 * 这种 token 只出现在 BGM 相关位置，误报率很低。
 */
const BARE_CODE_RE = /\b((?:bgm|music|bkm|ost)[_-]?[a-z0-9_]{1,16})\b/gi

/** `bgm_BGM01` → `bgm01`（去掉重复的 bgm 前缀），其余原样小写 */
function normalizeBareToken(token: string): string {
  const t = token.toLowerCase()
  const stripped = t.replace(/^(?:bgm|music|bkm|ost)[_-]/, '')
  return /^(?:bgm|music|bkm|ost)/.test(stripped) ? stripped : t
}

export interface ScriptScanResult {
  /** 代号 → 该脚本里出现的**带扩展名**的真实文件名 */
  files: Map<string, Set<string>>
  /** 脚本里出现过的纯代号（不带扩展名）——只当"用到了"的证据 */
  used: Set<string>
  /** 场景脚本文件 → 它用到的代号（"这个场景大概会放哪几首"） */
  sceneCodes: Map<string, string[]>
}

/**
 * 纯代号只认「bgm/music/bkm/ost + 可选分隔符 + 数字开头」这种形状。
 * 为什么要卡这么死：KAG 脚本里还有一堆同前缀的**系统命令** token
 * （真机实测扫出 `bgmindiabsolute`/`bgmindiuistorage`/`bgmtitle`/`bgmindimoveleft` 这些），
 * 不卡形状就会把它们当成曲目代号写进映射表。
 */
function isTrackShaped(token: string): boolean {
  const t = normalizeBareToken(token)
  return /^(?:bgm|music|bkm|ost)[_-]?\d[a-z0-9_]{0,14}$/.test(t)
}

/** 扫一段脚本文本，抽出 BGM 代号（带扩展名的调用 + 纯代号 token） */
export function scanScriptForBgm(text: string, fileName: string, out: ScriptScanResult): number {
  const before = out.used.size
  extractBgmCalls(text, out.files)
  BARE_CODE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  const sceneSet = new Set<string>()
  while ((m = BARE_CODE_RE.exec(text)) !== null) {
    if (!isTrackShaped(m[1])) continue
    const code = normalizeBareToken(m[1])
    out.used.add(code)
    sceneSet.add(code)
  }
  if (sceneSet.size && /\.(ks|scn|tjs|rpy)$/i.test(fileName)) {
    out.sceneCodes.set(fileName, [...sceneSet].slice(0, 40))
  }
  return out.used.size - before
}

/**
 * 解析解包产物，产出「代号 → 曲名 / 真实文件名」映射并按游戏 id 落盘缓存。
 * 前提：先跑过 runUnpack（没有解包清单时直接返回 null，界面会提示"先解包"）。
 *
 * async：一次要读几百上千个脚本文件（实测 少女领域 803 个），同步读完会把主进程按住好几秒；
 * 每 50 个文件让出一轮事件循环，界面保持可响应。
 */
export async function buildBgmMapFromUnpacked(gameId: string, gameDir: string): Promise<GameBgmMap | null> {
  const manifest = readUnpackManifest(gameId)
  if (!manifest) return null

  const titles = new Map<string, string>()
  const sources: string[] = []
  const scan: ScriptScanResult = { files: new Map(), used: new Set(), sceneCodes: new Map() }

  // 注意：必须带上 .scn —— 真机实测这个引擎的 BGM 引用全在场景文件 .scn 里
  //（少写一个扩展名就只剩 5 个文件被扫到，330 多个场景全漏掉）
  const textFiles = listUnpackedFiles(gameId, [
    '.ks',
    '.scn',
    '.tjs',
    '.csv',
    '.txt',
    '.ini',
    '.tsv',
    '.rpy',
    '.rpyc',
    '.dat',
    '.stand',
    '.lua',
    '.ksd'
  ])
  let scriptCalls = 0
  let sinceYield = 0
  for (const f of textFiles) {
    let buf: Buffer
    try {
      buf = readFileSync(f)
    } catch {
      continue
    }
    const name = basename(f)
    /*
     * 一份文件按多种编码各扫一遍再取并集。
     * 为什么不能只挑一种：真机实测 .scn 场景文件是 **PSB 二进制容器**
     * （头 `PSB\0`），里面既有 UTF-8 字符串表也有 UTF-16 段；用"偶数位是否大量 0"
     * 这种启发式挑编码会挑错（实测挑成 UTF-16 → 一条代号都认不出，只剩 4 处）。
     * 正则扫描本身很便宜，两种都扫最稳。
     */
    const texts = new Set<string>([buf.toString('utf8'), buf.toString('utf16le'), decodeLocal(buf)])
    let matchedTitleTable = false
    for (const text of texts) {
      if (!matchedTitleTable && looksLikeTitleTable(name) && parseTitleTable(text, titles) > 0) {
        sources.push(name)
        matchedTitleTable = true
      }
      scriptCalls += scanScriptForBgm(text, name, scan)
    }
    // 每 50 个文件让出一轮事件循环（见函数注释：几百个脚本同步读完会卡住界面）
    if (++sinceYield >= 50) {
      sinceYield = 0
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  const map: GameBgmMap = {
    gameId,
    at: Date.now(),
    titles: Object.fromEntries(titles),
    files: Object.fromEntries([...scan.files].map(([k, v]) => [k, [...v]])),
    usedCodes: [...scan.used],
    scenes: Object.fromEntries(scan.sceneCodes),
    sources: [...new Set(sources)].slice(0, 12),
    filesUnpacked: manifest.files,
    scriptCalls
  }
  writeBgmMap(map)
  return map
}

/** 曲名表的行解析：找出「代号列 + 曲名列」。真机实测格式 `bgm01,Graceful lady`、`bgm01,01`、制表符/等号也兼容 */
function parseTitleTable(text: string, into: Map<string, string>): number {
  let added = 0
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//') || line.startsWith(';')) continue
    // 逗号 / 制表符 / 等号 都当分隔符（CSV 里的引号简单去掉）
    const parts = line
      .replace(/"/g, '')
      .split(/[,\t=]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (parts.length < 2) continue
    const codeIdx = parts.findIndex((p) => /^(bgm|music|bkm|ost)[-_]?[a-z0-9_]+$/i.test(p))
    if (codeIdx < 0) continue
    // 曲名取代号之后的第一个不是纯数字的字段（很多游戏的表里第二列是序号）
    const rest = parts.slice(codeIdx + 1)
    const title = rest.find((p) => p.length >= 2 && !/^\d+$/.test(p) && !/\.(ogg|wav|mp3|opus|flac)$/i.test(p))
    if (!title) continue
    const key = normalizeCode(parts[codeIdx])
    if (!into.has(key)) {
      into.set(key, title)
      added++
    }
  }
  return added
}

/** 明文文件里找曲目表：游戏目录（深度 ≤ 2）+ 常见 BGM 目录 */
function scanDiskTables(gameDir: string, titles: Map<string, string>): string[] {
  const sources: string[] = []
  const walk = (dir: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const full = join(dir, n)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (depth > 0 && !/^(patch|backup|备份|原版备份|补丁)/i.test(n)) walk(full, depth - 1)
        continue
      }
      if (st.size > 4 * 1024 * 1024) continue
      if (!/\.(csv|txt|ini|tsv|json|dat)$/i.test(n)) continue
      if (!looksLikeTitleTable(n)) continue
      try {
        const text = decodeLocal(readFileSync(full))
        if (parseTitleTable(text, titles) > 0) sources.push(n)
      } catch {
        /* 单文件失败不影响其它 */
      }
    }
  }
  walk(gameDir, 2)
  return sources
}

function decodeLocal(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2)
  if (buf.length >= 8) {
    let zeros = 0
    for (let i = 1; i < Math.min(buf.length, 512); i += 2) if (buf[i] === 0) zeros++
    if (zeros > 128) return buf.toString('utf16le')
  }
  return buf.toString('utf8')
}

/**
 * 解析一款游戏的曲名表（带缓存：按游戏目录 + 档案 mtime 缓存）。
 * 找不到任何映射时 titles 为空、codes 里仍有代号，界面据此显示「只有代号」。
 */
export function loadBgmCatalog(gameDir: string): BgmCatalog {
  let key = gameDir
  try {
    key = `${gameDir}:${statSync(gameDir).mtimeMs}`
  } catch {
    /* 目录读不到就用路径当 key */
  }
  const hit = catalogCache.get(gameDir)
  if (hit && hit.key === key) return hit.catalog

  const titles = new Map<string, string>()
  const files = new Map<string, string>()
  const codes = new Set<string>()
  const sources: string[] = []

  // ① 解包产物（最优先：脚本里的 BGM 调用 + 解包出的曲目表；按游戏 id 落盘缓存）
  const unpackedMap = readGameBgmMapByDir(gameDir)
  if (unpackedMap) {
    for (const [code, title] of Object.entries(unpackedMap.titles)) titles.set(code, title)
    // 只用"带扩展名的真实文件名"；纯代号只算"脚本用到过"，不能当成文件名
    for (const [code, list] of Object.entries(unpackedMap.files)) {
      codes.add(code)
      if (list[0]) files.set(code, list[0])
    }
    for (const code of unpackedMap.usedCodes ?? []) codes.add(code)
    if (unpackedMap.sources.length) sources.push(`解包脚本 ${unpackedMap.sources.slice(0, 3).join('/')}`)
  }

  // ② 明文文件
  sources.push(...scanDiskTables(gameDir, titles))

  // ③ 档案里的曲目表 + 代号清单（档案里的名字就是"真实文件名"）
  const entries: ArchiveEntry[] = listArchiveEntries(gameDir)
  for (const e of entries) {
    if (/\.(ogg|wav|mp3|opus|flac|m4a|aac)$/i.test(e.name)) {
      const code = normalizeCode(e.name)
      codes.add(code)
      if (!files.has(code)) files.set(code, e.name.replace(/\\/g, '/'))
    }
  }
  const tables = entries.filter((e) => looksLikeTitleTable(e.name) && e.size <= 1024 * 1024)
  for (const t of tables) {
    const r = readArchiveEntry(t)
    if (!r.ok || !r.text) continue
    if (parseTitleTable(r.text, titles) > 0) sources.push(`档案 ${t.name}`)
  }

  const catalog: BgmCatalog = {
    titles,
    files,
    source: sources.length ? sources.slice(0, 3).join('、') : '',
    codes
  }
  catalogCache.set(gameDir, { key, catalog })
  if (catalogCache.size > 6) {
    const oldest = catalogCache.keys().next().value
    if (oldest !== undefined && oldest !== gameDir) catalogCache.delete(oldest)
  }
  return catalog
}

/**
 * 代号 → 曲名。`bgm01_a` / `bgm01_b` 这类「同一首曲子的 A/B 段」会回退到 `bgm01`，
 * 这正是游戏自己 `bgmtitlemap.csv` 的对应关系（实测：bgm01→01、bgm10_full→10）。
 *
 * 另外还会先去掉**重复前缀**：真机实测 少女领域 的字符串表里出现过 `bgm_BGM01` 这种写法，
 * 不去重就永远匹配不上（它其实是 bgm01）。
 */
function stripDupPrefix(code: string): string {
  return code.replace(/^(?:bgm|music|bkm|ost)[_-]+(?=(?:bgm|music|bkm|ost)[_-]?\d)/i, '')
}

export function titleForCode(catalog: BgmCatalog, rawCode: string): string {
  let code = stripDupPrefix(normalizeCode(rawCode))
  for (let i = 0; i < 4 && code; i++) {
    const hit = catalog.titles.get(code)
    if (hit) return hit
    const next = code.replace(/[_\-][a-z0-9]{1,4}$/, '')
    if (next === code) break
    code = next
  }
  return ''
}

/** 代号是否已知（用于"只有代号"的如实说明） */
export function hasCode(catalog: BgmCatalog, rawCode: string): boolean {
  let code = stripDupPrefix(normalizeCode(rawCode))
  for (let i = 0; i < 4 && code; i++) {
    if (catalog.codes.has(code) || catalog.titles.has(code)) return true
    const next = code.replace(/[_\-][a-z0-9]{1,4}$/, '')
    if (next === code) break
    code = next
  }
  return false
}

/**
 * 代号 → **真实文件名**（档案/脚本里的原始写法，例如 `bgm/bgm01.ogg`）。
 * 与曲名一样支持 A/B 段与重复前缀回退（`bgm01_a` / `bgm_BGM01` → `bgm01`）。
 * 取不到返回空串，界面显示代号即可。
 */
export function fileForCode(catalog: BgmCatalog, rawCode: string): string {
  let code = stripDupPrefix(normalizeCode(rawCode))
  for (let i = 0; i < 4 && code; i++) {
    const hit = catalog.files.get(code)
    if (hit) return hit
    const next = code.replace(/[_\-][a-z0-9]{1,4}$/, '')
    if (next === code) break
    code = next
  }
  return ''
}

// ---------------- 保存规则（用户明确要求的目录约定） ----------------

/**
 * galgame 保存目录的**种类**（用户要求：`自定义根目录 / galgame 名称 / 种类 / 文件`）：
 *   bgm 用真实名字、截图维持原样、立绘用「角色名+序号」、CG 用原名。
 */
export type GalSaveKind = 'bgm' | '截图' | '立绘' | 'cg'

/**
 * 某款游戏某个种类的保存目录：`<可自定义根目录>/<游戏名>/<种类>/`。
 * 根目录来自「galgame 助手」配置里的 dir（设置页可改），默认 userData/screenshots/galgame。
 */
export function galKindDir(rootDir: string, gameName: string, kind: GalSaveKind): string {
  const dir = join(rootDir, sanitizeName(gameName), kind)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** BGM 保存目录（= 种类 bgm） */
export function bgmSaveDir(rootDir: string, gameName: string): string {
  return galKindDir(rootDir, gameName, 'bgm')
}

/** 与 galgameTools.sanitizeGalName 同规则（同理避免成环，保持行为一致） */
export function sanitizeName(raw: string): string {
  const s = String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return [...s].slice(0, 60).join('').trim() || 'sakana'
}

/**
 * 在游戏目录里找一个音频文件（不依赖档案的游戏很常见：sound/bgm/*.ogg 直接摆着）。
 * 只读目录、只匹配文件名（大小写不敏感），深度最多 3 层。
 */
function findAudioOnDisk(gameDir: string, code: string): string {
  const want = normalizeCode(code)
  const exts = ['.ogg', '.wav', '.mp3', '.opus', '.flac', '.m4a', '.aac']
  const walk = (dir: string, depth: number): string => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return ''
    }
    for (const n of names) {
      const full = join(dir, n)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (depth > 0) {
          const hit = walk(full, depth - 1)
          if (hit) return hit
        }
        continue
      }
      if (normalizeCode(n) === want && exts.includes(extname(n).toLowerCase())) return full
    }
    return ''
  }
  return walk(gameDir, 3)
}

export interface SaveBgmResult {
  ok: boolean
  path: string
  error: string
}

/**
 * 把某个代号对应的 BGM **原样提取**到保存目录。文件名优先用真实曲名，取不到就用代号。
 * 先找游戏档案（XP3 能读；Siglus pf8 加密读不出会如实报错），再退回"磁盘上的明文音频文件"。
 */
export function saveBgmFile(opts: {
  gameDir: string
  rootDir: string
  gameName: string
  code: string
  title: string
}): SaveBgmResult {
  const want = normalizeCode(opts.code)
  // 没有曲名时用代号，但要先去掉扩展名 —— 否则拼出来会是 bgm07.ogg.ogg
  const pretty = (opts.title || opts.code.replace(/\.[a-z0-9]+$/i, '')).replace(/[\\/:*?"<>|]/g, '_').trim() || opts.code
  const ext0 = (extname(opts.code) || '.ogg').toLowerCase()

  // ① 档案里（KiriKiri XP3 实测可以原样取出）
  const entry = listArchiveEntries(opts.gameDir).find(
    (e) => /\.(ogg|wav|mp3|opus|flac|m4a|aac)$/i.test(e.name) && normalizeCode(e.name) === want
  )
  if (entry) {
    const r = readArchiveEntry(entry, { maxBytes: 64 * 1024 * 1024 })
    if (r.ok && r.bytes) {
      return writeSaved(opts, pretty, extname(entry.name).toLowerCase() || ext0, r.bytes)
    }
    if (r.error === 'ARCHIVE_ENCRYPTED') {
      // 档案加密的游戏：如果磁盘上正好有明文音频就退回去用它，否则如实说明做不到
      const disk = findAudioOnDisk(opts.gameDir, opts.code)
      if (disk) {
        try {
          return writeSaved(opts, pretty, extname(disk).toLowerCase() || ext0, readFileSync(disk))
        } catch {
          /* 落到下面的统一错误 */
        }
      }
      return {
        ok: false,
        path: '',
        error: '该作的档案正文是加密的（Siglus pf8），Sakana 无法解出音频，只能显示代号'
      }
    }
    return { ok: false, path: '', error: `读取失败：${r.error ?? '未知原因'}` }
  }

  // ② 磁盘上的明文音频文件（不用档案的游戏）
  const disk = findAudioOnDisk(opts.gameDir, opts.code)
  if (disk) {
    try {
      return writeSaved(opts, pretty, extname(disk).toLowerCase() || ext0, readFileSync(disk))
    } catch (err) {
      return { ok: false, path: '', error: `复制失败：${String((err as { message?: string })?.message ?? err)}` }
    }
  }
  return { ok: false, path: '', error: `没找到 ${opts.code} 对应的音频文件（档案与游戏目录里都没有）` }
}

/** 写入保存目录（同名时用代号区分，避免同一首的 A/B 段互相覆盖） */
function writeSaved(
  opts: { rootDir: string; gameName: string; code: string },
  pretty: string,
  ext: string,
  bytes: Buffer
): SaveBgmResult {
  const dir = bgmSaveDir(opts.rootDir, opts.gameName)
  let file = join(dir, `${pretty}${ext}`)
  if (existsSync(file)) {
    const suffix = opts.code.replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|]/g, '_')
    file = join(dir, `${pretty}_${suffix}${ext}`)
  }
  try {
    writeFileSync(file, bytes)
  } catch (err) {
    return { ok: false, path: '', error: `写入失败：${String((err as { message?: string })?.message ?? err)}` }
  }
  return { ok: true, path: file, error: '' }
}

/** 最近保存的 BGM（按时间倒序，供卡片右键菜单展示） */
export function listSavedBgm(rootDir: string, gameName: string, limit = 60): GalBgmSaved[] {
  const dir = join(rootDir, sanitizeName(gameName), 'bgm')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: GalBgmSaved[] = []
  for (const n of names) {
    const full = join(dir, n)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      out.push({ path: full, name: n, mtime: Math.floor(st.mtimeMs), size: st.size })
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, limit)
}

/** 保存目录（供"打开所在目录"用） */
export function savedBgmDir(rootDir: string, gameName: string): string {
  return join(rootDir, sanitizeName(gameName), 'bgm')
}

/** 目录名的父目录（保证存在；不创建 bgm 子目录，避免"打开目录"时凭空建空文件夹） */
export function ensureDir(dir: string): string {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    /* 创建失败交给调用方处理 */
  }
  return dir
}

/** 供调用方拼路径用 */
export function joinPath(...parts: string[]): string {
  return join(...parts)
}

/** 目录是否已经存在（界面据此决定按钮是否可用） */
export function dirExists(dir: string): boolean {
  try {
    return existsSync(dir)
  } catch {
    return false
  }
}

/** 父目录（打开保存目录时用） */
export function parentDir(file: string): string {
  return dirname(file)
}

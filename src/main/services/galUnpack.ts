/*
 * galUnpack —— galgame 引擎检测 + 自动解包（只读游戏文件、只写我们自己的解包目录）。
 *
 * ★ 安全红线：
 *   · 只以 'r' 打开游戏目录 / 档案，**不修改游戏目录里的任何东西**；
 *   · 解包产物写进 Sakana 自己的缓存目录与保存目录；
 *   · 本文件不碰任何进程内存，没有写内存 / 注入 / hook 能力。
 *
 * 关于"用现成库解包"的结论（装依赖前先核实过，见报告）：
 *   · `@garbro-mcp` **不存在**（那是个 scope，不是包）；真正存在的是 **MCP server** `garbro-mcp`
 *     （0.1.0-beta.1，bin: garbro-mcp.cjs），它是给 LLM/agent 通过 stdio 调的 MCP 服务，
 *     不是能 import 的库 —— 在产品里 spawn 一个 MCP server 走 JSON-RPC 得不偿失，故不采用。
 *   · `@dynamicaaa/rpx`（1.1.0，Ren'Py RPA 提取库）存在，但依赖 `@dynamicaaa/pyrunner`
 *     （"portable Python environment"）+ chalk/ora/yargs，是 CLI 形态、要带 Python 运行时 ——
 *     在 Electron 44 里不适用，故不采用。
 *   · 机器上没有 GARbro / 7z / unrpa 等外部 CLI。
 *   → 于是用上一轮**已经真机验证过**的自研读取器（XP3 索引 + PFS 文件表）扩展成完整解包。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { findArchives, isArchiveReadable, listArchiveEntries, unpackArchives, type UnpackResult } from './galArchive'

export type GalEngine = 'KiriKiri' | "Ren'Py" | 'BGI' | 'SiglusEngine' | '未知'

export interface EngineInfo {
  engine: GalEngine
  /** 判定依据（界面上要能说清"凭什么这么认"） */
  evidence: string[]
}

/** 只读目录名，判断引擎（特征文件识别） */
export function detectGalEngine(gameDir: string): EngineInfo {
  let names: string[] = []
  try {
    names = readdirSync(gameDir)
  } catch {
    return { engine: '未知', evidence: ['游戏目录读不到'] }
  }
  const lower = names.map((n) => n.toLowerCase())
  const count = (re: RegExp): number => lower.filter((n) => re.test(n)).length
  const hasDir = (d: string): boolean => {
    try {
      return existsSync(join(gameDir, d)) && statSync(join(gameDir, d)).isDirectory()
    } catch {
      return false
    }
  }

  const xp3 = count(/\.xp3$/)
  const pfs = count(/\.pfs(\.\d+)?$/)
  const rpa = count(/\.rpa$/)
  const rpy = count(/\.rpyc?$/)
  const arc = count(/\.arc$/)
  const bin = count(/\.bin$/)

  // 判定顺序按"证据强度"：专属扩展名优先（xp3/pfs/rpa 基本一锤定音）
  if (xp3 > 0) return { engine: 'KiriKiri', evidence: [`*.xp3 ×${xp3}`] }
  if (pfs > 0) return { engine: 'SiglusEngine', evidence: [`*.pfs ×${pfs}`] }
  if (rpa > 0 || rpy > 0 || hasDir('renpy')) {
    const ev: string[] = []
    if (rpa) ev.push(`*.rpa ×${rpa}`)
    if (rpy) ev.push(`*.rpy/.rpyc ×${rpy}`)
    if (hasDir('renpy')) ev.push('renpy/ 目录')
    return { engine: "Ren'Py", evidence: ev }
  }
  if (arc > 0) return { engine: 'BGI', evidence: [`*.arc ×${arc}`] }
  if (bin > 0 && hasDir('bgimage')) return { engine: 'BGI', evidence: [`*.bin ×${bin} + bgimage/`] }
  return { engine: '未知', evidence: ['没找到 xp3/pfs/rpa/rpy/arc 等特征文件'] }
}

// ---------------- 解包缓存（按游戏 id 落盘） ----------------

export interface UnpackManifest {
  gameId: string
  gameDir: string
  at: number
  dir: string
  files: number
  bytes: number
  skipped: number
  archives: { file: string; entries: number; readable: boolean }[]
  engine: GalEngine
  evidence: string[]
  error: string
}

/** 解包缓存根目录（Sakana 自己的缓存目录，不写进游戏目录） */
export function unpackRootDir(): string {
  return join(app.getPath('userData'), 'cache', 'galgame-unpack')
}

export function unpackGameDir(gameId: string): string {
  return join(unpackRootDir(), gameId)
}

function manifestPath(gameId: string): string {
  return join(unpackGameDir(gameId), 'manifest.json')
}

export interface GameBgmMap {
  gameId: string
  at: number
  /** 代号（小写、无扩展名）→ 曲名 */
  titles: Record<string, string>
  /** 代号 → 脚本里出现的**真实文件名**（带扩展名的那种写法） */
  files: Record<string, string[]>
  /** 脚本里出现过的**纯代号**（不带扩展名，KAG 脚本常这么引用）——只当"用到了"的证据，不当文件名 */
  usedCodes?: string[]
  /** 场景脚本文件 → 它用到的代号（"这个场景大概放哪几首"，供实时判定参考） */
  scenes?: Record<string, string[]>
  /** 曲名来源（界面显示） */
  sources: string[]
  /** 解包时统计：解出多少个文件 */
  filesUnpacked?: number
  /** 脚本里一共扫到多少处 BGM 引用（0 = 脚本格式没被覆盖，要如实说） */
  scriptCalls?: number
}

function bgmMapPath(gameId: string): string {
  return join(unpackGameDir(gameId), 'bgm-map.json')
}

/** 读缓存：没解包过 / 没解析过就返回 null（界面据此提示"先解包"） */
export function readUnpackManifest(gameId: string): UnpackManifest | null {
  try {
    const raw = readFileSync(manifestPath(gameId), 'utf-8')
    return JSON.parse(raw) as UnpackManifest
  } catch {
    return null
  }
}

export function readBgmMap(gameId: string): GameBgmMap | null {
  try {
    return JSON.parse(readFileSync(bgmMapPath(gameId), 'utf-8')) as GameBgmMap
  } catch {
    return null
  }
}

export function writeBgmMap(map: GameBgmMap): void {
  try {
    mkdirSync(unpackGameDir(map.gameId), { recursive: true })
    writeFileSync(bgmMapPath(map.gameId), JSON.stringify(map), 'utf-8')
  } catch {
    /* 缓存写不进去不影响功能（下次会重新解析） */
  }
}

/** 清掉某款游戏的解包缓存（重新解包时用） */
export function clearUnpack(gameId: string): void {
  try {
    rmSync(unpackGameDir(gameId), { recursive: true, force: true })
  } catch {
    /* 删不掉就留着，overwrite 会覆盖 */
  }
}

/**
 * 自动解包：先解"文本/脚本/表"（解析曲目表与立绘坐标需要的），
 * 再按需要解音频/图片（保存 BGM、提取立绘时单独调用，见 galBgmCatalog / galSprite）。
 *
 * async：unpackArchives 会在每个档案之间让出事件循环（多档案游戏找索引很慢，见那边注释）。
 */
export async function runUnpack(
  gameId: string,
  gameDir: string,
  opts: { force?: boolean } = {}
): Promise<UnpackManifest> {
  const engine = detectGalEngine(gameDir)
  const dir = unpackGameDir(gameId)
  const existing = readUnpackManifest(gameId)
  /*
   * 已经解过同一个游戏目录就直接复用结果。
   *
   * 为什么不再要求 `files > 0`：有的游戏（真机实测 SANA EDITION 9 卷 xp3）索引**读不出来**，
   * 扫描一遍要 17 秒，结果却是 0 个文件。之前"0 文件就当没解过"会让用户每点一次解包都白等 17 秒。
   * 需要重新扫描（例如之后装了补丁）时，面板上的「清掉缓存重新解包」会带 force=true 重来。
   */
  if (existing && !opts.force && existing.gameDir === gameDir) {
    return existing
  }
  if (opts.force) clearUnpack(gameId)

  const r: UnpackResult = await unpackArchives(gameDir, join(dir, 'files'), {
    exts: TEXT_EXTS,
    maxEntryBytes: 8 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
    maxEntries: 20000,
    overwrite: true
  })
  const manifest: UnpackManifest = {
    gameId,
    gameDir,
    at: Date.now(),
    dir: join(dir, 'files'),
    files: r.files,
    bytes: r.bytes,
    skipped: r.skipped,
    archives: r.archives,
    engine: engine.engine,
    evidence: engine.evidence,
    error: r.error
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(manifestPath(gameId), JSON.stringify(manifest), 'utf-8')
  } catch {
    /* 忽略 */
  }
  return manifest
}

/** 解包时会解出来的文本类扩展名（脚本 / 表 / 配置） */
export const TEXT_EXTS = [
  '.ks',
  '.tjs',
  '.csv',
  '.txt',
  '.ini',
  '.tsv',
  '.json',
  '.rpy',
  '.rpyc',
  '.dat',
  '.stand',
  '.ksd',
  '.lua',
  '.snb',
  '.ws2',
  '.scn'
]

/** 解包目录里某个扩展名的文件列表（只读） */
export function listUnpackedFiles(gameId: string, exts: string[]): string[] {
  const root = join(unpackGameDir(gameId), 'files')
  const want = new Set(exts.map((e) => e.toLowerCase()))
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
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
      if (st.isDirectory()) walk(full, depth + 1)
      else if (want.has(n.slice(n.lastIndexOf('.')).toLowerCase()) && st.size <= 2 * 1024 * 1024) out.push(full)
    }
  }
  walk(root, 0)
  return out
}

/** 档案概况（界面「解包」菜单项与卡片上显示："能解几个档案、几个条目"） */
export function archiveSummary(gameDir: string): { total: number; readable: number; entries: number } {
  let total = 0
  let readable = 0
  let entries = 0
  for (const a of findArchives(gameDir)) {
    total++
    if (isArchiveReadable(a)) readable++
    entries += listArchiveEntries(gameDir).filter((e) => e.archive === a).length
  }
  return { total, readable, entries }
}

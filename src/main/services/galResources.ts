import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { GalExtractAllResult, GalExtractPreview, GalResourceFolder, GalResourcesResult } from '@shared/types'
import { log } from '../log'
import { listArchiveEntries, readArchiveEntry } from './galArchive'
import { galKindDir, sanitizeName } from './galBgmCatalog'
import { extractImages, listImageCandidates, listStandPoses } from './galSprite'
import { TEXT_EXTS, unpackGameDir } from './galUnpack'

/**
 * 「全部提取」与「在应用内查看最近解包资源」（V1.5.2 用户要求）。
 *
 * 为什么单独一个文件：
 *   · 立绘/CG 的提取逻辑在 `galSprite`（只读档案 + 写自己的保存目录），BGM 的在 `galBgmCatalog`；
 *   · 这里只做「预览数量 → 全部提取 → 列出成果」，不碰任何进程内存，也不改游戏目录；
 *   · 界面右键菜单、解包面板、资源查看器都走这三个函数，口径只在这里定义。
 *
 * 保存规则（沿用既有约定）：`<galgame 保存根目录>/<游戏名>/{立绘,cg,bgm}/`。
 * 文本类来自解包产物 `<userData>/galgame-unpack/<gameId>/files`。
 */

/** 一次最多提取多少个 BGM（防止某些游戏把上千个音效塞在同一条路径下） */
const MAX_BGM = 2000
/** 音频扩展名 */
const AUDIO_EXT = new Set(['.ogg', '.wav', '.mp3', '.opus', '.flac', '.m4a', '.aac', '.wma'])
/** 「像音乐」的路径判定（与内存识别时期的规则一致：bgm/music/ost/theme） */
const MUSIC_RE = /(^|[\\/_.-])(bgm|music|ost|theme|soundtrack)/i

/** 提取前预览：告诉界面「有多少个候选」，超过 30 张由界面弹确认 */
export function galExtractPreview(gameDir: string, kind: '立绘' | 'cg' | 'bgm'): GalExtractPreview {
  try {
    if (kind === '立绘') {
      const poses = listStandPoses(gameDir)
      if (poses.length > 0) {
        return {
          kind,
          candidates: poses.length,
          hint: `检测到 ${poses.length} 个立绘姿势（会按坐标表合成，全部提取）`
        }
      }
      /*
       * 没有坐标表时 extractStands 会**回退**到「整身底图整图」——预览必须走同一条路，
       * 否则这里报 0，界面就不让点提取，而实际上有一批整身图可提。
       */
      const all = listImageCandidates(gameDir).filter((c) => c.kind === '立绘')
      return {
        kind,
        candidates: all.length,
        hint: all.length
          ? `没有坐标表，检测到 ${all.length} 张整身立绘（会全部提取）`
          : '没有检测到立绘素材（既没有坐标表，也没有整身立绘整图）'
      }
    }
    if (kind === 'cg') {
      // 与 extractImages('cg') 同一份候选口径
      const all = listImageCandidates(gameDir)
      const cg = all.filter((c) => c.kind === 'cg').length
      return { kind, candidates: cg, hint: cg ? `检测到 ${cg} 张 CG（全部提取）` : '没找到 CG 整图' }
    }
    const entries = bgmEntries(gameDir)
    return {
      kind,
      candidates: entries.length,
      hint: entries.length ? `检测到 ${entries.length} 个 BGM 文件（全部提取）` : '没有找到 BGM（档案可能加密，或音乐不在 bgm/music 目录）'
    }
  } catch (err) {
    return { kind, candidates: 0, hint: `预览失败：${String((err as { message?: string })?.message ?? err)}` }
  }
}

/** 档案里「像音乐」的音频条目（去重，按路径排序） */
function bgmEntries(gameDir: string): { name: string; entry: Parameters<typeof readArchiveEntry>[0] }[] {
  const seen = new Set<string>()
  const out: { name: string; entry: Parameters<typeof readArchiveEntry>[0] }[] = []
  for (const entry of listArchiveEntries(gameDir)) {
    const name = String(entry.name ?? '')
    const ext = extname(name).toLowerCase()
    if (!AUDIO_EXT.has(ext)) continue
    if (!MUSIC_RE.test(name)) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, entry })
    if (out.length >= MAX_BGM) break
  }
  return out
}

/** 让出事件循环：提取是同步读盘 + 写盘，几百张图会卡住主进程的 UI 消息 */
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * 全部提取。
 *
 * 图片直接复用 `galSprite.extractImages`（limit 给一个足够大的数 = 全量）；
 * BGM 逐条从档案读出字节写到 `bgm/`，已存在就跳过（可重复点，不会重复写）。
 */
export async function galExtractAll(opts: {
  gameDir: string
  rootDir: string
  gameName: string
  kind: '立绘' | 'cg' | 'bgm'
}): Promise<GalExtractAllResult> {
  const t0 = Date.now()
  try {
    if (opts.kind === 'bgm') {
      const dir = galKindDir(opts.rootDir, opts.gameName, 'bgm')
      const entries = bgmEntries(opts.gameDir)
      let count = 0
      let skipped = 0
      let error = ''
      for (const [i, { name, entry }] of entries.entries()) {
        const file = join(dir, sanitizeName(basename(name)))
        if (existsSync(file)) {
          skipped++
        } else {
          const r = readArchiveEntry(entry, { maxBytes: 64 * 1024 * 1024 })
          if (!r.ok || !r.bytes) {
            skipped++
          } else {
            try {
              writeFileSync(file, r.bytes)
              count++
            } catch (err) {
              error = `写入失败：${String((err as { message?: string })?.message ?? err)}`
              break
            }
          }
        }
        if (i % 10 === 0) await yieldLoop()
      }
      log.append('info', 'gal', `BGM 全部提取：候选 ${entries.length}，写出 ${count}，跳过 ${skipped}（${Date.now() - t0}ms）→ ${dir}`)
      return { ok: count > 0 || skipped > 0, kind: 'bgm', count, candidates: entries.length, dir, error, skipped }
    }

    const r = await extractImages({
      gameDir: opts.gameDir,
      rootDir: opts.rootDir,
      gameName: opts.gameName,
      kind: opts.kind,
      // 5000 等于"不设上限"；真正的上限由档案里的候选数决定
      limit: 5000
    })
    log.append(
      'info',
      'gal',
      `${opts.kind} 全部提取：候选 ${r.candidates}，写出 ${r.count}（${Date.now() - t0}ms）→ ${r.dir}${r.error ? `｜${r.error}` : ''}`
    )
    return {
      ok: r.ok,
      kind: opts.kind,
      count: r.count,
      candidates: r.candidates,
      dir: r.dir,
      error: r.error,
      skipped: 0
    }
  } catch (err) {
    const message = String((err as { message?: string })?.message ?? err)
    log.append('warn', 'gal', `${opts.kind} 全部提取失败：${message}`)
    return { ok: false, kind: opts.kind, count: 0, candidates: 0, dir: '', error: message, skipped: 0 }
  }
}

/** 列一个目录里的文件（不递归），按修改时间倒序；只保留给定扩展名 */
function listFiles(dir: string, exts: Set<string> | null, limit: number): { name: string; path: string; size: number }[] {
  if (!dir || !existsSync(dir)) return []
  const out: { name: string; path: string; size: number }[] = []
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        if (exts && !exts.has(extname(name).toLowerCase())) continue
        out.push({ name, path: full, size: st.size })
      } catch {
        /* 单个文件读不到就跳过 */
      }
      if (out.length >= limit) break
    }
  } catch {
    return []
  }
  return out
}

/** 递归列文本类产物（解包目录结构可能多层），最多 limit 个 */
function listTextFiles(dir: string, limit: number): { name: string; path: string; size: number }[] {
  const out: { name: string; path: string; size: number }[] = []
  const walk = (d: string, depth: number): void => {
    if (out.length >= limit || depth < 0) return
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names) {
      if (out.length >= limit) return
      const full = join(d, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          if (depth > 0) walk(full, depth - 1)
          continue
        }
        if (TEXT_EXTS.includes(extname(name).toLowerCase())) out.push({ name, path: full, size: st.size })
      } catch {
        /* ignore */
      }
    }
  }
  walk(dir, 3)
  return out
}

/**
 * 「查看最近解包资源」的数据源：四个分类的目录 + 文件列表。
 *
 * 不读取游戏档案、不启动进程 —— 只列我们自己写过的保存目录与解包产物，
 * 所以打开面板永远是毫秒级，也不会因为游戏在运行而失败。
 */
export function galListResources(opts: {
  gameId: string
  rootDir: string
  gameName: string
}): GalResourcesResult {
  const unpackDir = join(unpackGameDir(opts.gameId), 'files')
  const imageExt = new Set(['.png', '.jpg', '.jpeg', '.webp'])
  const bgmExt = new Set([...AUDIO_EXT])
  const folders: GalResourceFolder[] = [
    { kind: '立绘', dir: galKindDir(opts.rootDir, opts.gameName, '立绘'), files: [], total: 0 },
    { kind: 'cg', dir: galKindDir(opts.rootDir, opts.gameName, 'cg'), files: [], total: 0 },
    { kind: 'bgm', dir: galKindDir(opts.rootDir, opts.gameName, 'bgm'), files: [], total: 0 },
    { kind: '文本', dir: unpackDir, files: [], total: 0 }
  ]
  for (const f of folders) {
    if (f.kind === '文本') {
      f.files = listTextFiles(f.dir, 300)
      f.total = f.files.length
    } else {
      const all = listFiles(f.dir, f.kind === 'bgm' ? bgmExt : imageExt, 2000)
      f.total = all.length
      // 图片只回传前 400 张给界面（缩略图太多会拖慢渲染）；音乐/文本回传列表
      f.files = f.kind === 'bgm' ? all.slice(0, 300) : all.slice(0, 400)
    }
  }
  return { dirs: folders.map((f) => ({ kind: f.kind, dir: f.dir })), folders, unpackDir }
}

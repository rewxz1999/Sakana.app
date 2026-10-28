/*
 * galSprite —— 立绘（差分合成）/ CG 提取（**只读游戏档案，只写我们自己的保存目录**）。
 *
 * ★ 安全红线：只以 'r' 读游戏档案，写只写 `<保存根目录>/<游戏名>/<种类>/`；
 *   本文件不读也不写任何进程内存，没有写内存 / 注入 / hook 能力。
 *
 * 保存规则（用户明确要求）：`自定义根目录 / galgame 名称 / 种类 / 文件`
 *   · 立绘 → 文件名「角色名+序号」（`<角色名>_001.png`，另写 立绘清单.json 记录它对应哪个姿势/级别）
 *   · CG  → 保存原名
 *
 * ★★ 差分立绘合成：**能做，而且这是本版的主路径**（上一轮曾误判为"做不到"，本轮真机复测推翻）★★
 *
 * 真机实测（少女领域 data.xp3，KiriKiri + emote/立ち絵 插件）：
 *   · 立绘是「碎片 PNG + 坐标表」：`fgimage/<角色>/<姿势>_<级别>_<图层id>.png` 是碎片，
 *     `fgimage/<角色>/<姿势>_<级别>.txt` 是坐标表；
 *   · 坐标表**不是**加密/自定义压缩，而是「21 字节小头 + zlib + UTF-16LE 的 TSV」：
 *     头是 `fe fe 02 ff fe | u32 | u32 | u64`，第 21 字节起就是标准 zlib 流（78 9c），
 *     解开后第一行是 `#layer_type name left top width height type opacity visible layer_id group_layer_id …`。
 *     （上一轮只按"整条读取 + 直接当文本解码"，看到乱码就下了"自定义压缩读不了"的结论；
 *       本轮按头长度试探 inflate 后一次解出来了 137 行坐标。）
 *   · level 0 的坐标与碎片像素尺寸 **1:1**；level 1..3 是**缩小版**（实测表内 1663x2737 / 碎片 2213x3646，
 *     比例 0.7516），所以合成时按「表内尺寸 ÷ 碎片尺寸」做缩放，级别 0 的缩放比就是 1。
 *   · 碎片在档案里是**原样存储的 PNG**（packed == size，开头 89504e47），可以直接解码叠加。
 *   · 坐标表的第二行（前两列为空）给出整张画的画布尺寸（实测 2362x4134）。
 *
 * 因此本版：按坐标表把 visible=1 的碎片逐层 source-over 叠成整身立绘（这就是"差分"：
 * 底图 + 表情/服装差分碎片合成一张），再按像素包围盒裁掉四周空白。
 * 合成失败（没有坐标表 / 碎片读不出 / 解码不动）时**自动回退**到"提取整身底图碎片"，
 * 并在结果里如实说明走到了哪一步。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { blit, cropToContent, decodePng, encodePng, opaqueRatio, type PngImage } from './galPng'
import { galKindDir, sanitizeName, type GalSaveKind } from './galBgmCatalog'
import { isArchiveReadable, listArchiveEntries, readArchiveEntry, readEntryHead, type ArchiveEntry } from './galArchive'

/** 判定"整身立绘底图"的最小高度（没有坐标表时的回退路径用；真机实测整图 3652px，碎片最大几百 px） */
const SPRITE_MIN_HEIGHT = 900
/** CG 目录名（不同游戏叫法不同；真机实测 少女领域用 evimage/） */
const CG_DIR_RE = /(^|\/)(evimage|cg|event|ev)(\/|$)/i
/** 坐标表里 visible 列的取值 */
const VISIBLE_ON = 1

// ---------------- 坐标表（碎片 + left/top/宽高/不透明度/可见） ----------------

export interface LayoutRow {
  /** 图层名（差分名，如「斜め」「目」；很多游戏这里是 0/1/2） */
  name: string
  left: number
  top: number
  width: number
  height: number
  opacity: number
  visible: number
  /** 图层 id —— 与碎片文件名末尾的数字一一对应 */
  layerId: string
  /** 差分分组 id：同组是同一处的多个候选（表情/服装） */
  group: string
}

export interface LayerLayout {
  /** 画布尺寸（坐标表第二行；拿不到时用碎片包围盒兜底） */
  canvasW: number
  canvasH: number
  rows: LayoutRow[]
  /** 解出坐标表用的 zlib 起始偏移（调试/日志用） */
  zlibOffset: number
}

/**
 * 解一个「碎片坐标表」。格式（真机实测）：21 字节头 + zlib + UTF-16LE TSV。
 * 头长度在不同引擎版本可能不同，所以这里从头 64 字节里**逐个找 zlib 起点**（78 9c/da/01/5e），
 * 解出来的内容必须含表头 `layer_type`，否则不算成功。
 */
export function decodeLayerLayout(buf: Buffer): LayerLayout | null {
  let text = ''
  let zlibOffset = -1
  for (let s = 0; s <= 64 && s + 2 < buf.length; s++) {
    if (buf[s] !== 0x78) continue
    const b1 = buf[s + 1]
    if (b1 !== 0x9c && b1 !== 0xda && b1 !== 0x01 && b1 !== 0x5e) continue
    try {
      const out = inflateSync(buf.subarray(s))
      // UTF-16LE 的判定：第二个字节为 0（ASCII 段）——坐标表是 ASCII 表头 + 日文图层名
      const t = out.length >= 2 && out[1] === 0 ? out.toString('utf16le') : out.toString('utf8')
      if (!t.includes('layer_type')) continue
      text = t
      zlibOffset = s
      break
    } catch {
      /* 试下一个偏移 */
    }
  }
  if (!text) return null

  const rows: LayoutRow[] = []
  let canvasW = 0
  let canvasH = 0
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith('#')) continue
    const c = rawLine.split('\t')
    if (c.length < 11) {
      // 画布行：前两列为空，第 3/4 列是整张画的宽高
      const w = Number(c[2])
      const h = Number(c[3])
      if (w > 0 && h > 0 && !canvasW) {
        canvasW = w
        canvasH = h
      }
      continue
    }
    const row: LayoutRow = {
      name: c[1],
      left: Number(c[2]),
      top: Number(c[3]),
      width: Number(c[4]),
      height: Number(c[5]),
      opacity: Number(c[7]) || 255,
      visible: Number(c[8]),
      layerId: c[9],
      group: c[10] ?? ''
    }
    if (!row.layerId || !Number.isFinite(row.left) || !Number.isFinite(row.top)) continue
    if (row.width <= 0 || row.height <= 0) continue
    rows.push(row)
  }
  if (!rows.length) return null
  return { canvasW, canvasH, rows, zlibOffset }
}

// ---------------- 碎片尺寸（只读开头几十字节） ----------------

function pngSize(entry: ArchiveEntry): { w: number; h: number } | null {
  const buf = readEntryHead(entry, 4096)
  if (!buf || buf.length < 24) return null
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

// ---------------- 姿势索引（<角色>/<姿势>_<级别>.txt + 对应碎片） ----------------

export interface StandPose {
  /** fgimage 下的角色目录名（真机实测就是角色名，如「ひなた」） */
  char: string
  /** 姿势名（如「ひなたＡ」） */
  pose: string
  /** 选中的级别（优先 0 = 原始比例） */
  level: string
  layout: ArchiveEntry
  /** 该姿势该级别的碎片：layerId → 条目 */
  pieces: Map<string, ArchiveEntry>
  /** 该级别的坐标表条目 */
  levels: string[]
}

const LAYOUT_RE = /^fgimage\/([^/]+)\/(.+)_(\d+)\.txt$/i

/**
 * 列出游戏里所有可合成的立绘姿势（只读档案索引）。
 * 收集策略：先按坐标表文件名分组，再把同目录同级别的碎片按「末尾图层 id」建索引。
 * 注意必须用**完整路径前缀**建 key（上一轮踩过：只按末尾数字索引会把不同姿势/版本的碎片混在一起，
 * 合成出来尺寸全错）。
 */
export function listStandPoses(gameDir: string): StandPose[] {
  const entries = listArchiveEntries(gameDir).filter((e) => /\.png$/i.test(e.name) || /\.txt$/i.test(e.name))
  const byKey = new Map<string, StandPose>()
  for (const e of entries) {
    const m = LAYOUT_RE.exec(e.name)
    if (!m) continue
    const [, char, pose, level] = m
    const key = `${char}\u0000${pose}`
    let s = byKey.get(key)
    if (!s) {
      s = { char, pose, level, layout: e, pieces: new Map(), levels: [] }
      byKey.set(key, s)
    }
    s.levels.push(level)
    // 级别 0 是原始比例，优先；没有 0 就用最小的级别
    const better =
      level === '0' || (s.level !== '0' && Number(level) < Number(s.level))
    if (better) {
      s.level = level
      s.layout = e
    }
  }
  // 碎片：fgimage/<角色>/<姿势>_<级别>_<图层id>.png
  const pieceRe = /^fgimage\/([^/]+)\/(.+)_(\d+)_(\d+)\.png$/i
  for (const e of entries) {
    const m = pieceRe.exec(e.name)
    if (!m) continue
    const [, char, pose, level, layerId] = m
    const s = byKey.get(`${char}\u0000${pose}`)
    if (!s || s.level !== level) continue
    s.pieces.set(layerId, e)
  }
  for (const s of byKey.values()) s.levels = [...new Set(s.levels)].sort()
  return [...byKey.values()].sort((a, b) => (a.char + a.pose).localeCompare(b.char + b.pose))
}

// ---------------- 合成 ----------------

export interface ComposeResult {
  png: Buffer
  width: number
  height: number
  /** 真正叠上去的层数 */
  drawn: number
  /** 表里有、但档案里找不到碎片（或碎片读不出）的层数 */
  missing: number
  /** 表内尺寸与碎片长宽比对不上、只能按 1:1 贴的层数（如实统计，便于排查素材混装） */
  nonUniform: number
  /** 该级别用的缩放比（level 0 = 1） */
  scale: number
  /** 不透明像素占比（自检：过低说明坐标/缩放出问题） */
  coverage: number
  layoutRows: number
}

/**
 * 按坐标表把一个姿势（某个级别）的碎片合成成整身立绘。
 * 只叠加 visible=1 的层（这就是游戏自己在这一级别下显示的差分组合），按坐标表的行序叠放。
 */
export function composePose(gameDir: string, pose: StandPose): ComposeResult | null {
  const lr = readArchiveEntry(pose.layout, { maxBytes: 8 * 1024 * 1024 })
  if (!lr.ok || !lr.bytes) return null
  const layout = decodeLayerLayout(lr.bytes)
  if (!layout) return null

  const visible = layout.rows.filter((r) => r.visible === VISIBLE_ON)
  if (!visible.length) return null

  // 画布：优先用坐标表给的尺寸；拿不到就用「visible 层的最大 right/bottom」兜底
  let W = layout.canvasW
  let H = layout.canvasH
  if (!W || !H) {
    W = 1
    H = 1
    for (const r of visible) {
      W = Math.max(W, r.left + r.width)
      H = Math.max(H, r.top + r.height)
    }
  }
  // 画布上限保护：异常坐标表不要把内存撑爆
  if (W > 20000 || H > 20000 || W < 2 || H < 2) return null

  const canvas: PngImage = { width: W, height: H, rgba: Buffer.alloc(W * H * 4) }
  let drawn = 0
  let missing = 0
  let scaleUsed = 1
  let nonUniform = 0
  for (const row of visible) {
    const entry = pose.pieces.get(row.layerId)
    if (!entry) {
      missing++
      continue
    }
    const r = readArchiveEntry(entry, { maxBytes: 64 * 1024 * 1024 })
    if (!r.ok || !r.bytes) {
      missing++
      continue
    }
    const img = decodePng(r.bytes)
    if (!img) {
      missing++
      continue
    }
    /*
     * 缩放比 = 表内尺寸 / 碎片实际尺寸。
     * · level 0 实测 1:1（表内 340x277，碎片也 340x277）→ 不缩放；
     * · level 1+ 是缩小版（表内 1663x2737 / 碎片 2213x3646 ≈ 0.7516）→ 按比例缩小。
     * 只有「横纵比一致」才认这是真缩放：万一某个碎片与表内尺寸长宽比对不上（不同版本素材混装），
     * 强行缩放会把那一层画歪，此时宁可按 1:1 贴上去。
     */
    const sx = row.width / img.width
    const sy = row.height / img.height
    const uniform = Math.abs(sx - sy) < 0.05
    const scale = uniform && Math.abs(sx - 1) > 0.02 ? (sx + sy) / 2 : 1
    if (scale !== 1) scaleUsed = scale
    else if (!uniform) nonUniform++
    blit(canvas, img, Math.round(row.left), Math.round(row.top), row.opacity || 255, scale)
    drawn++
  }
  if (!drawn) return null
  const cropped = cropToContent(canvas)
  return {
    png: encodePng(cropped),
    width: cropped.width,
    height: cropped.height,
    drawn,
    missing,
    nonUniform,
    scale: scaleUsed,
    coverage: opaqueRatio(cropped),
    layoutRows: layout.rows.length
  }
}

// ---------------- CG / 回退用的整图候选 ----------------

export interface ImageCandidate {
  entry: ArchiveEntry
  kind: '立绘' | 'cg'
  width: number
  height: number
  /** 角色名（立绘用；从路径取，取不到用文件名前缀） */
  charName: string
}

/**
 * 列出可提取的整图（只读档案索引 + 每张图的开头几十字节）。
 * 立绘：fgimage/ 下高度 ≥ SPRITE_MIN_HEIGHT 的整图（没有坐标表时的回退路径）；
 * CG：CG 目录下的整图。
 */
export function listImageCandidates(gameDir: string, opts: { maxProbe?: number } = {}): ImageCandidate[] {
  const maxProbe = opts.maxProbe ?? 4000
  const out: ImageCandidate[] = []
  let probed = 0
  for (const e of listArchiveEntries(gameDir)) {
    if (!/\.png$/i.test(e.name)) continue
    const isSprite = /(^|\/)fgimage(\/|$)/i.test(e.name)
    const isCg = CG_DIR_RE.test(e.name) || /(^|\/)cgimage(\/|$)/i.test(e.name)
    if (!isSprite && !isCg) continue
    if (probed++ > maxProbe) break
    const size = pngSize(e)
    if (!size) continue
    if (isSprite) {
      if (size.h < SPRITE_MIN_HEIGHT) continue
      const parts = e.name.replace(/\\/g, '/').split('/')
      const charName = parts.length >= 3 ? parts[1] : basename(parts[parts.length - 1]).replace(/[_\-].*$/, '')
      out.push({ entry: e, kind: '立绘', width: size.w, height: size.h, charName })
    } else {
      out.push({ entry: e, kind: 'cg', width: size.w, height: size.h, charName: '' })
    }
  }
  return out
}

// ---------------- 对外：提取 ----------------

export interface ExtractImagesResult {
  ok: boolean
  kind: '立绘' | 'cg'
  dir: string
  count: number
  files: string[]
  candidates: number
  /** 立绘：合成成功的张数 / 回退成整图的张数 */
  composed?: number
  fallback?: number
  error: string
}

/**
 * 让出一轮事件循环。
 *
 * 为什么要让：一张立绘要解 ~60 个碎片、叠到 2362x4134 的画布上（实测 1~2 秒/张），
 * 这是**同步 CPU 活**。一次提取 12 张就是十几秒，如果一路同步跑完，主进程会被彻底占住
 * —— 界面卡死、连"取消"都点不动。每合成一张就让一轮，IPC/窗口消息能插进来，界面保持可用。
 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 立绘提取（**主路径 = 按坐标数据合成差分立绘**）：
 *   ① 有坐标表的姿势 → 逐层叠加合成整身立绘，文件名 `<角色名>_<序号>.png`
 *      （另写 `立绘清单.json`，记录每张图对应的角色/姿势/级别/层数/尺寸）；
 *   ② 一个坐标表都没有（或全都合成失败）→ 回退成"提取整身底图碎片"，并在返回值里说明。
 */
export async function extractStands(opts: {
  gameDir: string
  rootDir: string
  gameName: string
  limit?: number
}): Promise<ExtractImagesResult> {
  const limit = opts.limit ?? 12
  const dir = galKindDir(opts.rootDir, opts.gameName, '立绘')
  const result: ExtractImagesResult = {
    ok: true,
    kind: '立绘',
    dir,
    count: 0,
    files: [],
    candidates: 0,
    composed: 0,
    fallback: 0,
    error: ''
  }

  const poses = listStandPoses(opts.gameDir)
  result.candidates = poses.length

  if (poses.length) {
    const index: Record<string, unknown>[] = []
    const perChar = new Map<string, number>()
    for (const pose of poses) {
      if (result.count >= limit) break
      const composed = composePose(opts.gameDir, pose)
      if (!composed) {
        result.fallback = (result.fallback ?? 0) + 1
        continue
      }
      const charName = pose.char || basename(pose.pose)
      const n = (perChar.get(charName) ?? 0) + 1
      perChar.set(charName, n)
      const file = join(dir, `${sanitizeName(charName)}_${String(n).padStart(3, '0')}.png`)
      try {
        writeFileSync(file, composed.png)
      } catch (err) {
        result.ok = false
        result.error = `写入失败：${String((err as { message?: string })?.message ?? err)}`
        break
      }
      result.count++
      result.composed = (result.composed ?? 0) + 1
      result.files.push(file)
      index.push({
        file: basename(file),
        角色: charName,
        姿势: pose.pose,
        级别: pose.level,
        层数: composed.drawn,
        缺失层: composed.missing,
        缩放: Number(composed.scale.toFixed(3)),
        尺寸: `${composed.width}x${composed.height}`
      })
      // 每张都让一轮事件循环，别把主进程按住（见 yieldToLoop 的说明）
      await yieldToLoop()
    }
    if (index.length) {
      try {
        writeFileSync(join(dir, '立绘清单.json'), JSON.stringify(index, null, 2), 'utf-8')
      } catch {
        /* 清单写不了不影响图片 */
      }
    }
    if (result.count > 0) return result
    // 全都合成失败 → 掉到下面的回退路径，并保留原因说明
    result.error = '坐标表读到了，但没有任何一层能合成（碎片缺失或解码失败），已回退为提取整身碎片'
  }

  // 回退：整身底图碎片（没有坐标表 / 合成全失败）
  const all = listImageCandidates(opts.gameDir)
  const wanted = all.filter((c) => c.kind === '立绘')
  if (result.candidates === 0) result.candidates = wanted.length
  if (!wanted.length) {
    result.ok = false
    result.error =
      result.error ||
      '没找到立绘素材：既没有碎片坐标表（fgimage/<角色>/<姿势>_<级别>.txt），也没有整身立绘整图'
    return result
  }
  const perChar = new Map<string, number>()
  for (const c of wanted.slice(0, limit)) {
    if (result.count >= limit) break
    const r = readArchiveEntry(c.entry, { maxBytes: 64 * 1024 * 1024 })
    if (!r.ok || !r.bytes) continue
    const n = (perChar.get(c.charName) ?? 0) + 1
    perChar.set(c.charName, n)
    const file = join(dir, `${sanitizeName(c.charName)}_${String(n).padStart(3, '0')}.png`)
    if (existsSync(file)) {
      result.files.push(file)
      continue
    }
    try {
      writeFileSync(file, r.bytes)
      result.count++
      result.fallback = (result.fallback ?? 0) + 1
      result.files.push(file)
    } catch (err) {
      result.ok = false
      result.error = `写入失败：${String((err as { message?: string })?.message ?? err)}`
      break
    }
  }
  if (result.count > 0 && !result.error) {
    result.error = '该作没有可读的碎片坐标表，已按「整身底图碎片」提取（不是差分合成）'
  }
  return result
}

/**
 * CG 提取：`<根目录>/<游戏名>/cg/`，文件名保持游戏内的原名。
 */
export async function extractImages(opts: {
  gameDir: string
  rootDir: string
  gameName: string
  kind: '立绘' | 'cg'
  limit?: number
}): Promise<ExtractImagesResult> {
  // 立绘走"坐标合成"主路径（内部会分帧让出事件循环）
  if (opts.kind === '立绘') return extractStands(opts)

  const limit = opts.limit ?? 40
  const dir = galKindDir(opts.rootDir, opts.gameName, 'cg' as GalSaveKind)
  const result: ExtractImagesResult = { ok: true, kind: 'cg', dir, count: 0, files: [], candidates: 0, error: '' }

  const all = listImageCandidates(opts.gameDir)
  const wanted = all.filter((c) => c.kind === 'cg')
  result.candidates = wanted.length
  if (!wanted.length) {
    result.ok = false
    result.error = '没找到 CG 整图（可能不在档案里，或档案正文读不出）'
    return result
  }

  for (const c of wanted.slice(0, limit)) {
    // V1.5.2：全部提取时可能有几百张 CG；每张让一轮事件循环，避免主进程 UI 卡死
    await yieldToLoop()
    const r = readArchiveEntry(c.entry, { maxBytes: 64 * 1024 * 1024 })
    if (!r.ok || !r.bytes) continue
    const file = join(dir, sanitizeName(basename(c.entry.name).replace(/\.png$/i, '')) + '.png')
    if (existsSync(file)) {
      result.files.push(file)
      continue
    }
    try {
      writeFileSync(file, r.bytes)
      result.count++
      result.files.push(file)
    } catch (err) {
      result.error = `写入失败：${String((err as { message?: string })?.message ?? err)}`
      result.ok = false
      break
    }
  }
  return result
}

/** 已提取的图片（供右键菜单/面板展示"最近提取的立绘/CG"） */
export function listExtractedImages(rootDir: string, gameName: string, kind: '立绘' | 'cg', limit = 60): string[] {
  const dir = join(rootDir, sanitizeName(gameName), kind)
  try {
    return readdirSync(dir)
      .filter((n) => /\.png$/i.test(n))
      .slice(0, limit)
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

/** 档案能不能读（解包/提取前的快速判断，用于把"为什么提取不到"讲清楚） */
export function imagesReadableHint(gameDir: string): string {
  const archives = listArchiveEntries(gameDir)
  if (!archives.length) return '游戏目录里没找到可读的档案（可能是散装文件或未收录的格式）'
  const readable = new Set(archives.filter((e) => isArchiveReadable(e.archive)).map((e) => e.archive))
  if (!readable.size) return '档案索引读不出来（该作使用了自定义压缩，本版无法解包）'
  return ''
}

/** 读取一个已提取的图片字节（给"预览"用，只读我们自己的目录） */
export function readExtractedImage(file: string): Buffer | null {
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

/** 立绘提取前的"能不能做"预判（界面用来解释"为什么没有立绘/走的是回退路径"） */
export function standsHint(gameDir: string): { poses: number; pieces: number; text: string } {
  const poses = listStandPoses(gameDir)
  const pieces = poses.reduce((n, p) => n + p.pieces.size, 0)
  if (poses.length && pieces) return { poses: poses.length, pieces, text: '' }
  if (poses.length) return { poses: poses.length, pieces: 0, text: '有坐标表但同级别碎片对不上（可能是别的引擎写法）' }
  return { poses: 0, pieces: 0, text: '没有碎片坐标表，立绘会按整身底图提取' }
}

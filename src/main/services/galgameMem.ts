import { BrowserWindow, app } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CH } from '@shared/channels'
import { DEFAULT_GAL_TOOLS } from '@shared/types'
import type { GalBgmSaved, GalMemEntry, GalMemRecent, GalUnpackSummary } from '@shared/types'
import { log } from '../log'
import { getSettings } from '../net'
import { store } from '../store'
import { listModules, scanProcessMemory, winMemStatus } from './winMem'
import { detectGalEngine, readBgmMap, readUnpackManifest, runUnpack } from './galUnpack'
import {
  buildBgmMapFromUnpacked,
  hasCode,
  listSavedBgm,
  loadBgmCatalog,
  normalizeCode,
  saveBgmFile,
  savedBgmDir,
  titleForCode,
  type BgmCatalog
} from './galBgmCatalog'
import { extractImages } from './galSprite'

/**
 * galgame「BGM / 章节」只读内存识别服务。
 *
 * ★★★ 安全红线（严格遵守）★★★
 * 本服务【只读】。底层实现是 services/winMem.ts（koffi 直接调 Windows API，不需要编译器），
 * 那里允许的 API 只有：OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION) +
 * ReadProcessMemory + VirtualQueryEx + 进程/模块枚举 + 只读窗口标题。
 * 绝不写内存、不注入 DLL、不 hook、不改任何游戏数据、不做加速/修改器类的事。
 * 只做两件事：识别正在播放的 BGM 文件名候选、识别当前章节名候选。
 *
 * 识别策略：
 * - 引擎识别：进程名 + 已加载模块（KiriKiri/Siglus/Unity/BGI/RealLive/Artemis/Majiro/RPGMaker 等）；
 * - BGM 名（通用兜底）：只读扫描进程可读内存中的音频文件名候选字符串，
 *   维护「最近新出现」的字符串 —— 刚被加载的那个通常就是正在播的 BGM；
 *   同名只记一次，缓存最近 N 条（时间 + 名字 + 来源引擎）；
 * - 章节名：优先窗口标题（很多 galgame 标题就是章节名），其次最近出现的脚本文件名；
 *   拿不到就如实显示「未识别」，不编造。
 *
 * 节流：默认 2 秒一次；只扫可读区域、跳过 MEM_FREE/MEM_RESERVE、
 * 单次总字节设上限（256MB）+ 时间上限（winMem 里 1.2 秒）、字符串长度/数量设上限。
 */

// ---------------- 引擎识别 ----------------

const ENGINE_RULES: { re: RegExp; label: string }[] = [
  { re: /krkr|kirikiri|tvpwin32/i, label: 'KiriKiri' },
  { re: /siglus/i, label: 'SiglusEngine' },
  { re: /unityplayer\.dll/i, label: 'Unity' },
  { re: /reallive/i, label: 'RealLive' },
  { re: /artemis/i, label: 'Artemis' },
  { re: /majiro|mware/i, label: 'Majiro' },
  { re: /rgss|rpgvx|nw\.exe/i, label: 'RPGMaker' },
  { re: /yu-ris|yuris/i, label: 'Yu-Ris' },
  { re: /system40|malie/i, label: 'System40/Malie' },
  { re: /bgi/i, label: 'BGI' }
]

function detectEngine(pid: number, exeName: string): string {
  const names = [exeName]
  try {
    for (const m of listModules(pid)) names.push(m.name)
  } catch {
    /* 模块枚举失败不影响 */
  }
  for (const rule of ENGINE_RULES) {
    if (names.some((n) => rule.re.test(n))) return rule.label
  }
  return ''
}

/**
 * 引擎兜底：看游戏目录里的资源包格式。
 *
 * 为什么需要兜底：现在的 galgame 普遍把引擎静态链进主 exe，进程里没有 `SiglusEngine.dll`
 * 之类的模块名（真机实测 hamidashi.exe 就是这种情况，日志里只留下 engine=未知）。
 * 但资源包扩展名很可靠：`.xp3` 是 KiriKiri、`.pfs` 是 Siglus，用它们认引擎比看模块名更稳。
 * 只读目录名，不改动游戏目录里的任何东西。
 */
function detectEngineFromDir(exePath: string): string {
  try {
    const dir = dirname(exePath)
    if (!dir || !existsSync(dir)) return ''
    const names = readdirSync(dir).map((n) => n.toLowerCase())
    if (names.some((n) => n.endsWith('.xp3'))) return 'KiriKiri'
    if (names.some((n) => n.endsWith('.pfs'))) return 'SiglusEngine'
    if (names.some((n) => n.endsWith('.ypf'))) return 'Yu-Ris'
    if (names.some((n) => n.endsWith('.nsa') || n.endsWith('.nsc'))) return 'NScripter'
    if (names.some((n) => n.endsWith('.paz'))) return 'Artemis'
  } catch {
    /* 目录读不到就当认不出引擎，不影响 BGM 识别 */
  }
  return ''
}

// ---------------- 运行会话 ----------------

interface ActiveSession {
  gameId: string
  pid: number
  exePath: string
  title: string
  engine: string
  prevScripts: Set<string>
  /** 「刚出现」的名字（kind='new'）：最可能是游戏刚切到的那首 */
  recent: GalMemEntry[]
  /** 见过（带路径）的音乐候选名，累计 —— 用来判断"这个名字是不是真的第一次被加载" */
  seenQualified: Set<string>
  /** 最近一轮扫描里内存中存在的「像音乐」的候选（每轮刷新，界面显示为「候选」） */
  candidates: { name: string; time: number }[]
  /** 候选名 → 第一次看到它的时间（面板上显示「首次出现」，避免每轮刷新时间戳） */
  candidateSeen: Map<string, number>
  /** 上一轮的「出现签名」（原始候选串 → 次数/地址异或），用来判断哪首刚被引用 */
  prevSig: Record<string, { n: number; x: string }>
  /** 最近判定为「刚切换/刚播放」的那首（含判定时间，界面显示"识别于 N 秒前"） */
  playing: { name: string; code: string; at: number } | null
  /** 游戏目录里的「代号 → 曲名」表（只读游戏数据；没有曲名时如实显示代号） */
  catalog: BgmCatalog
  /** BGM 保存根目录（沿用截图那套目录约定） */
  rootDir: string
  lastChapter: string
  lastError: string
  timer: NodeJS.Timeout | null
  baselineDone: boolean
  scanning: boolean
  onChapter?: (chapter: string) => void
}

const sessions = new Map<string, ActiveSession>()

const SCAN_INTERVAL_MS = 2000
/** 「刚出现」的累计上限 */
const RECENT_MAX = 20
/**
 * 面板里额外展示的「内存中的候选」条数。
 *
 * 为什么需要它：真机实测（Siglus 的 hamidashi.exe）游戏一启动，BGM 文件名就全都常驻内存了，
 * 之后几乎不会再有「新出现」的名字 —— 只靠「新出现」的话面板永远是空的（用户报的
 * 「BGM 识别没生效」就是这个）。所以除了「刚出现」，还要把内存里现有的音乐候选列出来，
 * 并明确标注是候选而不是「正在播放」。
 */
const CANDIDATE_MAX = 8
/** 「见过带路径的音乐候选名」集合的上限：超过就清空重来（长期游玩不会无限增长） */
const SEEN_QUALIFIED_MAX = 4000
/**
 * 「刚切换/刚播放」的判定有效期（毫秒）。
 * 真机实测：游戏播放一首 BGM 时会把代号再引用/复制一份，表现是出现次数 +1 或地址集合变化
 * —— 这是唯一的可观测信号，但扫描有时间闸、覆盖范围会抖，所以判定要**衰减**：
 * 超过这个时间没有新的变化信号，就不再声称"当前在播"，只留候选。
 */
const PLAYING_TTL_MS = 90_000

// ---------------- 错误映射（中文提示） ----------------

function mapError(code: string): string {
  switch (code) {
    case 'ACCESS_DENIED':
      return '无法读取游戏内存（权限不足）：游戏可能以管理员身份运行，请以管理员身份运行 Sakana 后重试'
    case 'NOT_FOUND':
      return '游戏进程已退出，无法继续识别 BGM / 章节'
    case 'INVALID_PID':
      return '游戏进程 PID 无效，无法识别 BGM / 章节'
    case 'NOT_AVAILABLE':
      // 理论上 tick 已经先查过可用性，这里是兜底：把真实原因带出来，不编造
      return winMemStatus().reason || '内存识别组件未就绪'
    default:
      return `读取游戏内存失败：${code}`
  }
}

// ---------------- 事件推送（供渲染层 toast） ----------------

function pushMemEvent(gameId: string, payload: { error?: string; chapter?: string; engine?: string }): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(CH.evGal, { type: 'mem', gameId, ...payload })
  }
}

// ---------------- 字符串清洗 ----------------

function basenameOf(s: string): string {
  return s.split(/[\\/]/).pop() ?? s
}

/** 音频候选 → 展示名；不合法返回 null */
function cleanAudioName(raw: string): string | null {
  let b = basenameOf(raw).trim()
  if (!b || b.length > 128) return null
  const dot = b.lastIndexOf('.')
  if (dot <= 0) return null // 无扩展名 / 扩展名在开头（如 ".ogg"）
  if (!b.slice(0, dot)) return null
  return b
}

/**
 * 窗口标题归一化后再比较。
 *
 * 为什么：KiriKiri 系游戏的主窗口标题固定是 `Information:<游戏名>`（真机实测 少女领域 =
 * `Information:オトメ＊ドメイン`），不做归一化就会把主窗口标题本身误记成"章节名"，
 * 卡片的章节名栏会变成 `Information:xxx`。
 */
function normTitle(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^information\s*[:：]\s*/i, '')
}

function sameTitle(a: string, b: string): boolean {
  return normTitle(a) === normTitle(b)
}

// ---------------- 扫描循环 ----------------

function scheduleTick(sess: ActiveSession): void {
  if (sess.timer) clearTimeout(sess.timer)
  sess.timer = setTimeout(() => void tick(sess), SCAN_INTERVAL_MS)
}

async function tick(sess: ActiveSession): Promise<void> {
  sess.timer = null
  if (!sessions.has(sess.gameId)) return // 已停止
  // 设置被关掉 → 立即停止本次会话（下次启动游戏时再按新设置决定）
  if (!getSettings().galgameMemRead) {
    galMemStop(sess.gameId)
    return
  }
  const status = winMemStatus()
  if (!status.available) {
    // 未就绪时把**真实原因**显示出来（例如 koffi 没打进包里），不假装在识别
    const err = status.reason || '内存识别组件未就绪'
    if (sess.lastError !== err) {
      sess.lastError = err
      pushMemEvent(sess.gameId, { error: err })
    }
    scheduleTick(sess)
    return
  }
  if (sess.scanning) {
    scheduleTick(sess)
    return
  }
  sess.scanning = true
  try {
    const r = scanProcessMemory(sess.pid)
    if (!r.ok) {
      const errText = mapError(r.error)
      if (sess.lastError !== errText) {
        sess.lastError = errText
        pushMemEvent(sess.gameId, { error: errText })
      }
      scheduleTick(sess)
      return
    }
    if (sess.lastError) {
      sess.lastError = ''
      pushMemEvent(sess.gameId, { error: '' })
    }

    // ---- 当前在播：靠「出现签名变化」判定（真机实测的唯一切歌信号，见 winMem.ts 的 audioSig） ----
    const bgmRaw = new Set(r.audioBgm.map((s) => s.toLowerCase()))
    const sigChanged: { name: string; code: string; at: number; first: boolean }[] = []
    if (sess.baselineDone) {
      for (const [raw, v] of Object.entries(r.audioSig)) {
        if (!bgmRaw.has(raw)) continue // 只看明确是 BGM 的（语音/音效碎片不算）
        const prev = sess.prevSig[raw]
        if (prev && prev.n === v.n && prev.x === v.x) continue
        const name = cleanAudioName(raw)
        if (!name) continue
        sigChanged.push({ name, code: normalizeCode(raw), at: Date.now(), first: !prev })
      }
    }
    /*
     * 判定"这首刚被播放"：
     * · 优先第一次出现的（first=true）——真机实测播放标题曲时 `bgm/bgm99.ogg` 这个正斜杠变体
     *   就是第一次出现在内存里；
     * · 其次是出现次数/地址集合变化的（同一首被反复播放时会再次变化）。
     * 扫描有时间闸、覆盖范围会抖，所以只认「BGM 类 + 签名变化」，并且用 PLAYING_TTL_MS 衰减：
     * 超过有效期没有新信号就不再声称"当前在播"，只在面板里留候选。
     */
    if (sigChanged.length) {
      const pick = sigChanged.find((c) => c.first) ?? sigChanged[0]
      const same = sess.playing && sess.playing.code === pick.code
      sess.playing = { name: pick.name, code: pick.code, at: pick.at }
      if (!same) {
        log.append(
          'info',
          'galmem',
          `识别到 BGM 切换: ${pick.name} → ${titleForCode(sess.catalog, pick.code) || '（无曲名，只有代号）'}（本轮变化 ${sigChanged.length} 个候选）`
        )
      }
    }
    sess.prevSig = r.audioSig

    // ---- BGM：新出现的音频文件名（只看「像音乐」的两类，语音/音效会淹掉真正的 BGM） ----
    const music = r.audioMusic
    /** 本轮「明确是 BGM」的候选名（只有它们能当「刚加载」的信号，原因见下） */
    const qualified = new Set<string>()
    for (const raw of r.audioBgm) {
      const name = cleanAudioName(raw)
      if (name) qualified.add(name.toLowerCase())
    }
    if (sess.baselineDone) {
      for (const a of qualified) {
        /*
         * 判据是「第一次见到一个**明确是 BGM** 的名字」，而不是「和上一轮比是新出现的」。
         *
         * 两个原因（都来自真机实测）：
         * 1) 必须是 BGM 类（名字里带 bgm/music/ost/theme 等）。内存里到处是截断出来的路径碎片，
         *    `estag02oem_kan_00456.ogg`（长块尾部）、`sysse/fem_shi_00279.ogg`（连 `vo` 段都掉了的
         *    语音碎片）都冒充过"刚加载"并顶到悬浮按钮上；它们都落在"其他"类，用 BGM 类当门槛即可排除。
         * 2) 累计判断而不是与上一轮比。单次扫描有时间闸（1.2 秒），每轮覆盖的内存范围会抖，
         *    用"上一轮没见到"当判据会把抖动误判成"新加载"，几轮就刷满列表。
         *
         * 基线（第一次扫描）只登记不产出：游戏一启动就常驻内存的那几十个 BGM 名不是"刚加载"。
         */
        if (sess.seenQualified.has(a)) continue
        // 同名只记一次（最近窗口内去重）
        if (sess.recent.some((e) => e.name.toLowerCase() === a)) continue
        // 取原始大小写：优先用本轮出现的原始名，否则用小写
        const display = findDisplayName(music, a)
        sess.recent.unshift({ time: Date.now(), name: display, engine: sess.engine, kind: 'new' })
      }
      if (sess.recent.length > RECENT_MAX) sess.recent = sess.recent.slice(0, RECENT_MAX)
    }
    for (const a of qualified) sess.seenQualified.add(a)
    // 长时间游玩会攒下成千上万个名字：超上限就清空重来（代价只是极少数老名字可能被再记一次）
    if (sess.seenQualified.size > SEEN_QUALIFIED_MAX) sess.seenQualified.clear()

    // ---- 候选：本轮内存里存在的音乐类候选（每轮刷新，不累积） ----
    const now = Date.now()
    const cand: { name: string; time: number }[] = []
    const seenCand = new Set<string>()
    for (const raw of music) {
      if (cand.length >= CANDIDATE_MAX) break
      const name = cleanAudioName(raw)
      if (!name) continue
      const key = name.toLowerCase()
      if (seenCand.has(key)) continue
      seenCand.add(key)
      // 时间用「本轮看到它」不行：候选每轮都会被重新扫到，时间戳会一直刷新，
      // 面板上看起来像每 2 秒又"识别"了一次。所以记住第一次看到它的时间。
      const first = sess.candidateSeen.get(key) ?? now
      sess.candidateSeen.set(key, first)
      cand.push({ name, time: first })
    }
    // 候选集合按轮刷新，第一次出现的时间表也要跟着收敛，否则长时间游玩会越攒越多
    if (sess.candidateSeen.size > CANDIDATE_MAX * 4) {
      const keep = new Set(cand.map((c) => c.name.toLowerCase()))
      for (const k of [...sess.candidateSeen.keys()]) {
        if (!keep.has(k)) sess.candidateSeen.delete(k)
      }
    }
    sess.candidates = cand


    // ---- 章节名 ----
    const curScripts = new Set<string>()
    for (const raw of r.scripts) {
      const b = basenameOf(raw).trim()
      if (b) curScripts.add(b.toLowerCase())
    }
    // 首次扫描只建立基线（脚本文件名不判定），窗口标题仍即时记录
    const chapter = resolveChapter(sess, r.windowTitle, r.scripts, sess.baselineDone ? sess.prevScripts : null)

    // 处理完本轮后再更新基线
    sess.baselineDone = true
    sess.prevScripts = curScripts

    if (chapter && chapter !== sess.lastChapter) {
      sess.lastChapter = chapter
      try {
        sess.onChapter?.(chapter)
      } catch {
        /* 忽略回调异常 */
      }
      pushMemEvent(sess.gameId, { chapter })
    }
  } catch (err) {
    const msg = String((err as { message?: string })?.message ?? err)
    if (sess.lastError !== msg) {
      sess.lastError = msg
      pushMemEvent(sess.gameId, { error: msg })
    }
  } finally {
    sess.scanning = false
    scheduleTick(sess)
  }
}

function findDisplayName(audioRaw: string[], lowerName: string): string {
  for (const raw of audioRaw) {
    const n = cleanAudioName(raw)
    if (n && n.toLowerCase() === lowerName) return n
  }
  return lowerName
}

function resolveChapter(
  sess: ActiveSession,
  windowTitle: string,
  scripts: string[],
  prevScripts: Set<string> | null
): string {
  const title = (windowTitle ?? '').trim()
  // 窗口标题 ≠ 游戏标题 → 视作章节名（很多 galgame 标题就是章节名）
  if (title && !sameTitle(title, sess.title)) return title
  // 兜底：最近新出现的脚本文件名
  if (prevScripts) {
    for (const raw of scripts) {
      const b = basenameOf(raw).trim()
      if (!b) continue
      if (!prevScripts.has(b.toLowerCase())) return b
    }
  }
  return ''
}

// ---------------- 对外接口 ----------------

export function galMemStart(opts: {
  gameId: string
  pid: number
  exePath: string
  title: string
  onChapter?: (chapter: string) => void
}): void {
  if (sessions.has(opts.gameId)) galMemStop(opts.gameId)
  // 先按进程名/模块名认；认不出再按游戏目录里的资源包格式兜底
  const engine = detectEngine(opts.pid, basename(opts.exePath)) || detectEngineFromDir(opts.exePath)
  /*
   * 曲名表：只读游戏自己的数据（明文 csv + 档案里的曲目表）。
   * 放在这里做一次（带缓存），面板一打开就能显示真实曲名；读不出来就如实显示代号。
   * 整段包在 try 里：曲名解析失败绝不能影响内存识别本身。
   */
  let catalog: BgmCatalog = { titles: new Map(), files: new Map(), source: '', codes: new Set() }
  try {
    const t0 = Date.now()
    catalog = loadBgmCatalog(dirname(opts.exePath))
    if (catalog.titles.size || catalog.codes.size) {
      log.append(
        'info',
        'galmem',
        `曲名表: ${catalog.titles.size} 条曲名 / ${catalog.codes.size} 个代号（来源 ${catalog.source || '档案代号清单'}，耗时 ${Date.now() - t0}ms）`
      )
    } else {
      log.append('info', 'galmem', '曲名表: 游戏数据里没找到代号→曲名 的映射（只显示代号）')
    }
  } catch (err) {
    log.append('warn', 'galmem', `曲名表解析失败（只显示代号）: ${String((err as { message?: string })?.message ?? err)}`)
  }
  const sess: ActiveSession = {
    gameId: opts.gameId,
    pid: opts.pid,
    exePath: opts.exePath,
    title: opts.title,
    engine,
    prevScripts: new Set(),
    recent: [],
    seenQualified: new Set(),
    candidates: [],
    candidateSeen: new Map(),
    prevSig: {},
    playing: null,
    catalog,
    rootDir: galRootDir(),
    lastChapter: '',
    lastError: '',
    timer: null,
    baselineDone: false,
    scanning: false,
    onChapter: opts.onChapter
  }
  sessions.set(opts.gameId, sess)
  log.append('info', 'galmem', `开始识别 BGM/章节: ${opts.title} (pid=${opts.pid}, engine=${engine || '未知'})`)
  scheduleTick(sess)
}

/** galgame 保存根目录：沿用「galgame 助手」里配置的截图根目录（不另立一套） */
function galRootDir(): string {
  try {
    const cfg = store.get<Partial<typeof DEFAULT_GAL_TOOLS>>('galgameTools', {})
    if (cfg && typeof cfg.dir === 'string' && cfg.dir) return cfg.dir
  } catch {
    /* 配置读不到就用默认目录 */
  }
  return join(app.getPath('userData'), 'screenshots', 'galgame')
}

/** V1.5.2：给「全部提取 / 查看资源」用的保存根目录（与截图、曲名同一套目录约定） */
export function galSaveRootDir(): string {
  return galRootDir()
}

export function galMemStop(gameId: string): void {
  const sess = sessions.get(gameId)
  if (!sess) return
  if (sess.timer) clearTimeout(sess.timer)
  sessions.delete(gameId)
  log.append('info', 'galmem', `停止识别 BGM/章节: ${gameId}`)
}

export function galMemStopAll(): void {
  for (const gameId of [...sessions.keys()]) galMemStop(gameId)
}

/**
 * 某款游戏最近的 BGM 识别结果（供右键面板 / 悬浮按钮展示）。
 *
 * 顺序 = 「当前在播」（kind='playing'，靠出现签名变化判定，带"识别于 N 秒前"）
 *      → 「刚出现的」（kind='new'）
 *      → 「内存中的候选」（kind='candidate'）。
 * 每一档都带 `title`（游戏数据里的真实曲名，解析不到就是空串 → 界面如实显示"只有代号"）。
 */
export function galMemRecent(gameId: string): GalMemRecent {
  const empty: GalMemRecent = {
    entries: [],
    engine: '',
    lastError: '',
    playing: null,
    playingAt: 0,
    titleSource: '',
    codeOnly: false
  }
  const sess = sessions.get(gameId)
  if (!sess) return empty

  const withTitle = (e: GalMemEntry): GalMemEntry => ({
    ...e,
    title: e.title || titleForCode(sess.catalog, normalizeCode(e.name))
  })

  const playingFresh = sess.playing && Date.now() - sess.playing.at < PLAYING_TTL_MS ? sess.playing : null
  const playing: GalMemEntry | null = playingFresh
    ? {
        time: playingFresh.at,
        name: playingFresh.name,
        engine: sess.engine,
        kind: 'playing',
        title: titleForCode(sess.catalog, playingFresh.code)
      }
    : null

  const known = new Set(sess.recent.map((e) => e.name.toLowerCase()))
  if (playing) known.add(playing.name.toLowerCase())
  const newest = sess.recent.map(withTitle)
  const candidates: GalMemEntry[] = sess.candidates
    .filter((c) => !known.has(c.name.toLowerCase()))
    .map((c) => withTitle({ time: c.time, name: c.name, engine: sess.engine, kind: 'candidate' as const }))

  return {
    entries: [...(playing ? [playing] : []), ...newest, ...candidates],
    engine: sess.engine,
    lastError: sess.lastError,
    playing,
    playingAt: playingFresh ? playingFresh.at : 0,
    titleSource: sess.catalog.source,
    // 一个曲名都没解析到时，界面要如实说"只有代号"，不能假装认识这首曲子
    codeOnly: sess.catalog.titles.size === 0
  }
}

/**
 * 把识别到（或面板里选中）的某首 BGM 从游戏档案**只读提取**并保存到本地。
 * 文件名优先用真实曲名，取不到用代号；目录沿用截图那套 <根目录>/<游戏名>/bgm/。
 */
export function galMemSaveBgm(gameId: string, code: string): { ok: boolean; path: string; error: string } {
  const sess = sessions.get(gameId)
  if (!sess) return { ok: false, path: '', error: '这款游戏当前没有在运行，无法定位它的资源档案' }
  const clean = String(code ?? '').split(/[\\/]/).pop() ?? ''
  if (!clean) return { ok: false, path: '', error: '没有指定要保存的 BGM' }
  const title = titleForCode(sess.catalog, normalizeCode(clean))
  const r = saveBgmFile({
    gameDir: dirname(sess.exePath),
    rootDir: sess.rootDir,
    gameName: sess.title,
    code: clean,
    title
  })
  if (r.ok) {
    log.append('info', 'galmem', `已保存 BGM: ${title || clean} → ${r.path}`)
    return { ok: true, path: r.path, error: '' }
  }
  return { ok: false, path: '', error: r.error }
}

/** 最近保存的 BGM（卡片右键菜单「最近保存的 bgm」用） */
export function galMemSavedBgm(gameId: string, gameName?: string): GalBgmSaved[] {
  const sess = sessions.get(gameId)
  const root = sess ? sess.rootDir : galRootDir()
  const name = sess ? sess.title : String(gameName ?? '')
  if (!name) return []
  return listSavedBgm(root, name)
}

/** 保存目录（"打开所在目录"用；不存在时按需创建） */
export function galMemSavedDir(gameId: string, gameName?: string): string {
  const sess = sessions.get(gameId)
  const root = sess ? sess.rootDir : galRootDir()
  const name = sess ? sess.title : String(gameName ?? '')
  return savedBgmDir(root, name || 'sakana')
}

/** 这款游戏的曲名表信息（面板头部显示"曲名来源"） */
export function galMemCatalogInfo(gameId: string): { titles: number; codes: number; source: string } {
  const sess = sessions.get(gameId)
  if (!sess) return { titles: 0, codes: 0, source: '' }
  return { titles: sess.catalog.titles.size, codes: sess.catalog.codes.size, source: sess.catalog.source }
}

/** 代号是否在游戏数据里出现过（界面据此区分"已知代号"与"内存碎片"） */
export function galMemHasCode(gameId: string, code: string): boolean {
  const sess = sessions.get(gameId)
  if (!sess) return false
  return hasCode(sess.catalog, code)
}

// ---------------- 解包 / 立绘 / 手动刷新（V1.1） ----------------

/**
 * 手动刷新（悬浮球「galgame 助手」的刷新按钮）：**跳过 2 秒轮询**，立刻重扫一次内存。
 *
 * 为什么做成 async 并 await tick：tick 里要扫 256MB 上限的可读内存（winMem 自己限 1.2 秒），
 * 上一版直接 `void tick()` 就返回，悬浮窗只能靠"等 800ms 再读"这种碰运气的方式拿结果 ——
 * 用户点了刷新却看到旧值，等于没刷新。现在等这一轮扫完再返回，调用方拿到的一定是新结果。
 */
export async function galMemForceRefresh(gameId: string): Promise<{ ok: boolean; error: string }> {
  const sess = sessions.get(gameId)
  if (!sess) return { ok: false, error: '这款游戏当前没有在运行，无法刷新识别' }
  if (sess.timer) {
    clearTimeout(sess.timer)
    sess.timer = null
  }
  // tick 结束时会自己排下一轮，所以这里 await 不会打断正常节奏
  try {
    await tick(sess)
  } catch (err) {
    return { ok: false, error: String((err as { message?: string })?.message ?? err) }
  }
  return { ok: true, error: '' }
}

/** 引擎信息（卡片/详情显示"识别到的引擎 + 判定依据"） */
export function galMemEngineInfo(gameId: string, gameDir?: string): { engine: string; evidence: string[] } {
  const sess = sessions.get(gameId)
  const dir = gameDir || (sess ? dirname(sess.exePath) : '')
  if (!dir) return { engine: sess?.engine ?? '', evidence: [] }
  try {
    const info = detectGalEngine(dir)
    if (info.engine === '未知' && sess?.engine) return { engine: sess.engine, evidence: ['运行时识别'] }
    return { engine: info.engine, evidence: info.evidence }
  } catch {
    return { engine: sess?.engine ?? '', evidence: [] }
  }
}

/**
 * 解包 + 解析（卡片右键「解包」）：
 *   ① 检测引擎 → ② 把文本/脚本解到 Sakana 缓存目录 → ③ 解析「代号 → 曲名/真实文件名」并落盘缓存。
 * 只读游戏文件；产物写在缓存目录里，游戏目录一个字节都不动。
 */
export async function galMemUnpack(
  gameId: string,
  gameName: string,
  gameDir: string,
  force = false
): Promise<GalUnpackSummary> {
  void gameName
  const t0 = Date.now()
  const engine = detectGalEngine(gameDir)
  const manifest = await runUnpack(gameId, gameDir, { force })
  /*
   * 映射按游戏 id 落盘缓存（用户要求）：不强制重建时直接用缓存，
   * 否则每次点「解包」都要把几百个脚本重扫一遍（实测 少女领域 803 个文件 ≈ 1.8 秒）。
   * 「清掉缓存重新解包」（force=true）才会真正重扫，与按钮文案一致。
   */
  const cached = readBgmMap(gameId)
  const map = !force && cached ? cached : await buildBgmMapFromUnpacked(gameId, gameDir)
  // 解包/映射变了 → 运行中的会话重新读一次曲名表（否则面板还是旧数据）
  const sess = sessions.get(gameId)
  if (sess) sess.catalog = loadBgmCatalog(gameDir)
  const readable = manifest.archives.filter((a) => a.readable).length
  /*
   * 「解不出来」有两种完全不同的原因，文案必须分开说（V1.1 复验时改）。
   *
   * 起因：用户库里的《灵感满溢的甜蜜创想》（SiglusEngine）解包 0 文件，界面却说
   * "档案索引读不出来"。实际拿字节验过（`.e2e/gal-pfs-probe.ts`）：
   *   · 5 个 .pfs 的文件表**全都读得出来**，29224 个真实文件名（`sound\bgm\bgm01_a.ogg`
   *     这种）都能列；代号 → 真实文件名这条链是通的（`fileForCode('bgm01_a')` 命中）；
   *   · 但正文一字节都取不到：1MB 窗口里 `OggS`/`PNG` 命中 **0 次**、熵 7.73~7.75 bit/字节，
   *     把偏移前后平移 ±64KB 重扫也一样 —— 所以不是"偏移算错"，是真加密。
   * 把这两件事说成一件，用户会以为"连文件表都没有、这游戏没救了"，
   * 而事实上他至少能拿到"这首曲子对应档案里哪个文件"。
   */
  const entriesTotal = manifest.archives.reduce((n, a) => n + a.entries, 0)
  const failReason = manifest.error
    ? manifest.error
    : readable === 0
      ? entriesTotal > 0
        ? `档案里的文件名列得出来（${entriesTotal} 个），但正文是加密的：音频/图片/脚本都取不到字节，本版导不出内容（代号 → 真实文件名仍然可用）`
        : '档案索引读不出来（该作使用了自定义压缩，本版无法解包）'
      : ''
  return {
    ok: manifest.files > 0,
    engine: engine.engine,
    evidence: engine.evidence,
    files: manifest.files,
    bytes: manifest.bytes,
    archives: manifest.archives.length,
    readableArchives: readable,
    titles: map ? Object.keys(map.titles).length : 0,
    codes: map ? (map.usedCodes?.length ?? 0) + Object.keys(map.files).length : 0,
    scripts: map ? Object.keys(map.scenes ?? {}).length : 0,
    sources: map?.sources ?? [],
    elapsedMs: Date.now() - t0,
    error: failReason
  }
}

/** 解包状态（没解过时给出"曲名映射/立绘提取都需要先解包"的原因） */
export function galMemUnpackStatus(
  gameId: string,
  gameDir?: string
): { unpacked: boolean; at: number; files: number; engine: string; evidence: string[]; reason: string } {
  const manifest = readUnpackManifest(gameId)
  const info = gameDir ? detectGalEngine(gameDir) : { engine: '', evidence: [] as string[] }
  if (!manifest) {
    return {
      unpacked: false,
      at: 0,
      files: 0,
      engine: info.engine,
      evidence: info.evidence,
      reason: '还没有解包：曲名映射与立绘/CG 提取都需要先解包（只读游戏档案，不会改动游戏目录）'
    }
  }
  return { unpacked: true, at: manifest.at, files: manifest.files, engine: manifest.engine, evidence: manifest.evidence, reason: '' }
}

/** 立绘 / CG 提取（只写 `<保存根目录>/<游戏名>/立绘|cg/`） */
export async function galMemExtractImages(
  gameId: string,
  gameName: string,
  gameDir: string,
  kind: '立绘' | 'cg',
  limit = 12
): Promise<{
  ok: boolean
  count: number
  candidates: number
  dir: string
  files: string[]
  error: string
  /** 立绘：按坐标表合成出来的张数（主路径） */
  composed?: number
  /** 立绘：回退成"整身底图碎片"的张数（没有坐标表时） */
  fallback?: number
}> {
  const sess = sessions.get(gameId)
  const root = sess ? sess.rootDir : galRootDir()
  try {
    const r = await extractImages({ gameDir, rootDir: root, gameName, kind, limit })
    if (r.ok) {
      log.append(
        'info',
        'galmem',
        `${kind}提取: 候选 ${r.candidates}，写出 ${r.count} 张（合成 ${r.composed ?? 0} / 回退 ${r.fallback ?? 0}）→ ${r.dir}`
      )
    }
    return {
      ok: r.ok,
      count: r.count,
      candidates: r.candidates,
      dir: r.dir,
      files: r.files,
      composed: r.composed,
      fallback: r.fallback,
      error: r.error
    }
  } catch (err) {
    return {
      ok: false,
      count: 0,
      candidates: 0,
      dir: '',
      files: [],
      error: String((err as { message?: string })?.message ?? err)
    }
  }
}

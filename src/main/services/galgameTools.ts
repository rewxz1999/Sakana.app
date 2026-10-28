import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, screen } from 'electron'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { GalRecentShot, GalToolsConfig } from '@shared/types'
import { DEFAULT_GAL_TOOLS } from '@shared/types'
import { galReadWindowTitle, galRunningInfo } from './galgame'
import { maybeShowSaveHint } from './onboarding'
import { copyScreenshotIfEnabled } from './clipboardCopy'
import { log } from '../log'
import { store } from '../store'

/**
 * galgame galgame 助手 / 工具配置
 * - 配置持久化在 electron-store key `galgameTools`（渲染层经 gal:tools-get/set 读写）
 * - galgame 助手开启后注册全局快捷键；不隐藏图标时在屏幕角落显示一个 56×56 悬浮拍摄按钮
 * - 截图在「galgame 助手」或全局快捷键触发时由主进程 desktopCapturer 抓取整个主屏
 */

function getCfg(): GalToolsConfig {
  const c = store.get<Partial<GalToolsConfig>>('galgameTools', {})
  return { ...DEFAULT_GAL_TOOLS, ...c }
}

function saveCfg(patch: Partial<GalToolsConfig>): GalToolsConfig {
  const next = { ...getCfg(), ...patch }
  store.set('galgameTools', next)
  return next
}

// ---------------- 全局快捷键 ----------------

let lastAccel: string | null = null

function applyHotkey(cfg: GalToolsConfig): void {
  if (lastAccel) {
    try {
      globalShortcut.unregister(lastAccel)
    } catch {
      /* ignore */
    }
    lastAccel = null
  }
  if (!cfg.screenshotEnabled) return
  const accel = cfg.hotkey || DEFAULT_GAL_TOOLS.hotkey
  try {
    const ok = globalShortcut.register(accel, () => {
      void galScreenshotNow()
    })
    if (ok) {
      lastAccel = accel
      log.append('info', 'gal', `galgame 助手快捷键已注册: ${accel}`)
    } else {
      log.append('warn', 'gal', `截图快捷键注册失败（可能被占用或格式无效）: ${accel}`)
    }
  } catch (err) {
    log.append('warn', 'gal', `截图快捷键注册异常: ${String(err)}`)
  }
}

// ---------------- 悬浮按钮窗口（v0.3.9：一个按钮 → 读取 BGM / 截图 选择面板） ----------------

const OVERLAY_SIZE = 56
/** 面板展开后的悬浮窗宽度（按钮固定在窗口右上角，面板在按钮下方右对齐） */
const PANEL_WIDTH = 208
let overlayWin: BrowserWindow | null = null

function overlayHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;user-select:none;-webkit-user-select:none}
  #btn{position:absolute;top:4px;right:4px;width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;
    background:rgba(0,0,0,.66);color:#fff;font-size:20px;line-height:1;
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 2px 10px rgba(0,0,0,.35);outline:none;backdrop-filter:blur(4px);z-index:2}
  #btn:hover{background:rgba(30,30,30,.85)}
  #btn:active{transform:scale(.94)}
  #panel{position:absolute;top:60px;right:4px;width:200px;border-radius:12px;background:rgba(18,18,22,.94);
    color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.45);backdrop-filter:blur(8px);
    display:none;flex-direction:column;overflow:hidden;z-index:1}
  #panel.open{display:flex}
  #menu{display:flex;flex-direction:column}
  .item{display:flex;align-items:center;gap:9px;padding:11px 14px;font-size:13px;color:#fff;cursor:pointer;
    background:transparent;border:none;text-align:left;width:100%;outline:none}
  .item:hover{background:rgba(255,255,255,.10)}
  .item .ic{font-size:16px;line-height:1}
  .divider{height:1px;background:rgba(255,255,255,.12);margin:1px 0}
  #result{display:none;flex-direction:column;gap:7px;padding:12px 14px}
  .r-title{font-size:11px;color:rgba(255,255,255,.55)}
  .r-name{font-size:13px;line-height:1.4;word-break:break-all;white-space:pre-wrap}
  .r-detail{font-size:11px;color:rgba(255,255,255,.6);word-break:break-all}
  .r-row{display:flex;align-items:center;gap:8px;margin-top:3px}
  .rbtn{display:inline-flex;align-items:center;justify-content:center;font-size:12px;padding:5px 12px;
    border-radius:8px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.10);color:#fff;
    cursor:pointer;outline:none}
  .rbtn:hover{background:rgba(255,255,255,.20)}
</style></head>
<body>
  <button id="btn" title="galgame 助手（截图）">🎮</button>
  <div id="panel">
    <div id="menu">
      <button class="item" id="shotItem"><span class="ic">📷</span>截图</button>
    </div>
    <div id="result">
      <div class="r-title" id="resultTitle">识别结果</div>
      <div class="r-name" id="resultName"></div>
      <div class="r-detail" id="resultDetail"></div>
      <div class="r-row">
        <button class="rbtn" id="saveBtn">保存这首</button>
        <button class="rbtn" id="copyBtn">复制</button>
        <button class="rbtn" id="backBtn">返回</button>
      </div>
    </div>
  </div>
  <script>
    var btn = document.getElementById('btn')
    var panel = document.getElementById('panel')
    var menu = document.getElementById('menu')
    var result = document.getElementById('result')
    var resultTitle = document.getElementById('resultTitle')
    var resultName = document.getElementById('resultName')
    var resultDetail = document.getElementById('resultDetail')
    var copyBtn = document.getElementById('copyBtn')
    var saveBtn = document.getElementById('saveBtn')
    var open = false
    var currentName = ''
    var currentCode = ''
    var busyShot = false

    function resizeNow() {
      var h = panel.offsetHeight || 0
      try { window.sakana.gal.overlayResize(true, 60 + h + 4) } catch (e) {}
    }
    function showMenu() {
      menu.style.display = 'flex'
      result.style.display = 'none'
      resizeNow()
    }
    function openPanel() {
      open = true
      panel.classList.add('open')
      btn.textContent = '✕'
      showMenu()
    }
    function closePanel() {
      open = false
      panel.classList.remove('open')
      btn.textContent = '🎮'
      try { window.sakana.gal.overlayResize(false, 0) } catch (e) {}
    }
    function showResult(title, name, detail, ok, withCopy) {
      menu.style.display = 'none'
      result.style.display = 'flex'
      resultTitle.textContent = title
      resultName.textContent = name
      resultDetail.textContent = detail || ''
      resultName.style.color = ok === null ? '#fff' : (ok ? '#7ee2a8' : '#f28b8b')
      copyBtn.style.display = withCopy ? 'inline-flex' : 'none'
      if (withCopy) copyBtn.textContent = '复制'
      resizeNow()
    }

    btn.addEventListener('click', function () {
      if (open) closePanel()
      else openPanel()
    })

    /* V1.5.2：内存读 BGM 功能已删除（用户要求），这两个按钮与对应逻辑一并移除。
       DOM 上不再有 bgmItem / refreshItem，下面的监听改为「有元素才绑定」，
       避免 getElementById 返回 null 时抛错把后面截图按钮的脚本一起打断。 */
    var bgmItemEl = document.getElementById('bgmItem')
    if (bgmItemEl) bgmItemEl.addEventListener('click', async function () {
      showResult('BGM 识别', '正在识别…', '', null, false)
      saveBtn.style.display = 'none'
      var r = null
      try { r = await window.sakana.gal.readBgm() } catch (e) { r = null }
      if (r && r.ok && r.data && r.data.name) {
        currentName = r.data.name
        currentCode = r.data.code || r.data.name
        showResult('BGM 识别', r.data.name, r.data.detail || '', null, true)
        saveBtn.style.display = 'inline-flex'
        saveBtn.textContent = '保存这首'
      } else if (r && r.ok) {
        currentName = ''
        currentCode = ''
        showResult('BGM 识别', (r.data && r.data.message) || '未识别到 BGM', '', null, false)
      } else {
        currentName = ''
        currentCode = ''
        showResult('BGM 识别', (r && r.error) ? r.error : 'BGM 识别失败', '', false, false)
      }
    })

    /* 手动刷新（V1.5.2：仅供旧的 BGM 面板使用，按钮已移除；有元素才绑定） */
    var refreshItemEl = document.getElementById('refreshItem')
    if (refreshItemEl) refreshItemEl.addEventListener('click', async function () {
      showResult('BGM 识别（已刷新）', '正在刷新…', '正在重扫游戏内存', null, false)
      var rr = null
      try { rr = await window.sakana.gal.refreshBgm('') } catch (e) { rr = null }
      if (rr && rr.ok && rr.data && rr.data.ok === false) {
        showResult('BGM 识别（已刷新）', rr.data.error || '刷新失败', '', false, false)
        return
      }
      var rr2 = null
      try { rr2 = await window.sakana.gal.readBgm() } catch (e) { rr2 = null }
      if (rr2 && rr2.ok && rr2.data && rr2.data.name) {
        currentName = rr2.data.name
        currentCode = rr2.data.code || rr2.data.name
        showResult('BGM 识别（已刷新）', rr2.data.name, rr2.data.detail || '', null, true)
        saveBtn.style.display = 'inline-flex'
        saveBtn.textContent = '保存这首'
      } else {
        showResult('BGM 识别（已刷新）', (rr2 && rr2.data && rr2.data.message) || '未识别到 BGM', '', null, false)
      }
    })

    saveBtn.addEventListener('click', async function () {
      if (!currentCode) return
      saveBtn.textContent = '保存中…'
      var r = null
      try { r = await window.sakana.gal.saveBgm('', currentCode) } catch (e) { r = null }
      if (r && r.ok && r.data && r.data.ok) {
        saveBtn.textContent = '已保存'
        resultDetail.textContent = '已保存到：' + r.data.path
      } else {
        saveBtn.textContent = '保存这首'
        resultDetail.textContent = (r && r.data && r.data.error) || (r && r.error) || '保存失败'
      }
      resizeNow()
    })

    copyBtn.addEventListener('click', async function () {
      if (!currentName) return
      try {
        await window.sakana.clipboard.copyText(currentName)
        copyBtn.textContent = '已复制'
        setTimeout(function () { if (copyBtn.textContent === '已复制') copyBtn.textContent = '复制' }, 1500)
      } catch (e) {
        copyBtn.textContent = '复制失败'
      }
    })

    document.getElementById('backBtn').addEventListener('click', showMenu)

    document.getElementById('shotItem').addEventListener('click', async function () {
      if (busyShot) return
      busyShot = true
      showResult('截图', '正在截图…', '', null, false)
      var r = null
      try { r = await window.sakana.gal.overlayShot() } catch (e) { r = null }
      showResult('截图', (r && r.ok) ? '截图已保存' : '截图失败', (r && r.ok) ? '' : ((r && r.error) || ''), !!(r && r.ok), false)
      busyShot = false
    })
  </script>
</body></html>`
}

function positionOverlay(): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const wa = screen.getPrimaryDisplay().workArea
  // 按钮固定在窗口右上角：窗口宽度变化时按右边缘重新定位，按钮位置始终不动
  const [w] = overlayWin.getSize()
  const x = Math.round(wa.x + wa.width - w - 16)
  const y = Math.round(wa.y + 100)
  overlayWin.setPosition(x, y, false)
}

/** 悬浮按钮展开/收起选择面板（渲染层 overlay HTML 调用，动态调整悬浮窗尺寸） */
export function galOverlayResize(open: boolean, height?: number): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  if (open) {
    const h = Math.max(OVERLAY_SIZE, Math.round(Number(height) || 0) || OVERLAY_SIZE)
    overlayWin.setSize(PANEL_WIDTH, h, false)
  } else {
    overlayWin.setSize(OVERLAY_SIZE, OVERLAY_SIZE, false)
  }
  positionOverlay()
}

function ensureOverlay(): BrowserWindow {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin
  overlayWin = new BrowserWindow({
    width: OVERLAY_SIZE,
    height: OVERLAY_SIZE,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  positionOverlay()
  void overlayWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(overlayHtml()))
  overlayWin.once('ready-to-show', () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.showInactive()
  })
  overlayWin.on('closed', () => {
    overlayWin = null
  })
  return overlayWin
}

function destroyOverlay(): void {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy()
  }
  overlayWin = null
}

/** 依据配置应用快捷键与悬浮窗；仅在有游戏运行时激活（galgame 助手随游戏启动） */
function applyCfg(cfg: GalToolsConfig): void {
  const running = galRunningInfo() !== null
  if (!running || !cfg.screenshotEnabled) {
    applyHotkey({ ...cfg, screenshotEnabled: false })
    destroyOverlay()
    return
  }
  applyHotkey(cfg)
  if (!cfg.hideIcon) ensureOverlay()
  else destroyOverlay()
}

/** 应用启动时不激活galgame 助手（仅配置留存，随游戏启动而激活） */
export function galToolsInit(): void {
  applyCfg(getCfg())
}

/** 游戏启动时调用：按当前配置激活galgame 助手（快捷键 + 悬浮窗） */
export function galToolsActivate(): void {
  applyCfg(getCfg())
}

/** 最后一个游戏退出时调用：关闭galgame 助手（注销快捷键 + 销毁悬浮窗） */
export function galToolsDeactivate(): void {
  applyHotkey({ ...getCfg(), screenshotEnabled: false })
  destroyOverlay()
}

export function galToolsCleanup(): void {
  if (lastAccel) {
    try {
      globalShortcut.unregister(lastAccel)
    } catch {
      /* ignore */
    }
    lastAccel = null
  }
  destroyOverlay()
}

export function galToolsGet(): GalToolsConfig {
  return getCfg()
}

export function galToolsSet(patch: Partial<GalToolsConfig>): GalToolsConfig {
  const next = saveCfg(patch)
  applyCfg(next)
  log.append('info', 'gal', `galgame 助手配置已更新: ${JSON.stringify(next)}`)
  return next
}

// ---------------- 截图 ----------------

/**
 * 只截取当前运行的 galgame 窗口画面：
 * 1. 找到最近启动且仍在运行的游戏进程
 * 2. 读取其主窗口标题（检测程序的最新记录优先，其次即时读取）
 * 3. 枚举系统窗口，按标题匹配后抓取该窗口缩略图
 * 匹配不到（最小化 / 无标题 / 未启动）时报错提示，绝不截取整个屏幕。
 */
async function captureGameWindow(): Promise<Buffer> {
  const run = galRunningInfo()
  if (!run) throw new Error('未检测到正在运行的 galgame，请先启动游戏')

  /*
   * V1.5.2：截图卡顿优化之一 —— **不再在截图路径里 spawn PowerShell 读窗口标题**。
   *
   * 原来是 `run.lastTitle || await readWindowTitle(pid) || gameTitle`，而 readWindowTitle 会起一个
   * powershell.exe（超时 3 秒）。正常有 2 秒轮询时 lastTitle 是有值的，但刚启动游戏/轮询没回来时
   * 就会走这条慢路径 —— 用户感知就是"按截图卡几秒"。这里直接用轮询值或游戏名，
   * 匹配失败时下面的名称兜底逻辑仍然会再试一次。
   */
  const title = run.lastTitle || run.gameTitle

  const primary = screen.getPrimaryDisplay()
  const scale = primary.scaleFactor || 1
  const size = {
    width: Math.round(primary.size.width * scale),
    height: Math.round(primary.size.height * scale)
  }
  /*
   * V1.5.2：截图卡顿优化之二 —— 限制缩略图上限。
   *
   * `desktopCapturer.getSources` 会按 thumbnailSize **逐个窗口**渲染缩略图；在 2K/4K 屏幕上
   * 传全屏物理分辨率（例如 3840×2160）意味着每次截图都要渲染十几张超大位图，这是卡顿主因。
   * 游戏窗口绝大多数不超过 1080p（窗口化的 galgame 通常 1280×720 / 1600×900），
   * 所以上限收到 1920×1080：1080p 以内**完全无损**，只有 4K 游戏会被缩到 1080p。
   */
  const thumbSize = {
    width: Math.min(size.width, 1920),
    height: Math.min(size.height, 1080)
  }
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: thumbSize,
    fetchWindowIcons: false
  })

  const norm = (s: string): string => s.trim().toLowerCase()
  let src = title
    ? sources.find((s) => norm(s.name) === norm(title))
    : undefined
  if (!src && run.gameTitle) {
    src = sources.find((s) => norm(s.name) === norm(run.gameTitle))
  }
  if (!src) {
    throw new Error('未找到游戏窗口（窗口可能已最小化或被遮挡），请保持游戏窗口可见后重试')
  }
  if (src.thumbnail.isEmpty()) {
    throw new Error('无法截取游戏窗口画面（最小化或受保护窗口）')
  }
  const png = src.thumbnail.toPNG()
  if (!png || png.length === 0) throw new Error('截图数据为空')
  return png
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tsName(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 游戏名 → 合法 Windows 文件名/目录名。
 *
 * 截图现在按「游戏名」建子目录、文件名也用游戏名打头（CLANNAD_20260917_143512.png），
 * 而游戏标题里常见 `:` `/` `?` `*` 等非法字符（例如「CLANNAD - 被光守望着的坡道」
 * 或带 `Fate/stay night` 这类斜杠），不清理会导致 mkdir/writeFile 直接抛 EINVAL。
 * 同时去掉结尾的点和空格（Windows 不允许），并限制长度避免超出路径上限。
 */
export function sanitizeGalName(raw: string): string {
  const s = String(raw ?? '')
    // Windows 非法字符 + 控制字符
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // 结尾的点和空格在 Windows 上会被系统悄悄丢掉，干脆自己清掉，保证「记录的名字」= 实际目录名
    .replace(/[. ]+$/g, '')
  // 按码点截断，避免把代理对（emoji / 生僻字）劈成半个字符
  const cut = [...s].slice(0, 60).join('').trim()
  return cut || 'sakana'
}

/** galgame 截图根目录（配置为空时回落 userData/screenshots/galgame） */
export function galShotRootDir(cfg: GalToolsConfig = getCfg()): string {
  return cfg.dir || join(app.getPath('userData'), 'screenshots', 'galgame')
}

/**
 * 某款游戏的截图目录：`<可自定义根目录>/<游戏名>/截图/`（自动创建）。
 *
 * V1.1 起统一成"根目录 / 游戏名 / 种类 / 文件"（种类 = 截图 / bgm / 立绘 / cg），
 * 之前截图直接堆在 `<根目录>/<游戏名>/` 下面；老的散文件由 migrateGalSaveLayout 一次性挪进来，
 * 不保留两套目录（用户明确要求"兼容迁移，不要并存两套"）。
 */
export function galGameShotDir(gameName: string): string {
  const dir = join(galShotRootDir(), sanitizeGalName(gameName), '截图')
  mkdirSync(dir, { recursive: true })
  migrateGalSaveLayout(gameName)
  return dir
}

/** 旧位置（V1.1 之前）：<根目录>/<游戏名>/ 直接放 png */
export function galGameLegacyShotDir(gameName: string): string {
  return join(galShotRootDir(), sanitizeGalName(gameName))
}

/**
 * 兼容迁移：把旧位置根目录下的图片文件挪进 `截图/`，只做一次、只动图片。
 * 幂等且保守：任何一步失败都不抛（截图功能不能因为迁移失败而不可用）。
 */
export function migrateGalSaveLayout(gameName: string): void {
  try {
    const legacy = galGameLegacyShotDir(gameName)
    const target = join(legacy, '截图')
    if (!existsSync(legacy)) return
    // 目标目录已经建好就说明迁移过了（或本来就是新布局）
    if (existsSync(target) && readdirSync(target).some((n) => /\.(png|jpg|jpeg|webp)$/i.test(n))) return
    mkdirSync(target, { recursive: true })
    let moved = 0
    for (const n of readdirSync(legacy)) {
      if (!/\.(png|jpg|jpeg|webp)$/i.test(n)) continue
      const from = join(legacy, n)
      try {
        if (!statSync(from).isFile()) continue
        // 目标同名就不覆盖（rename 在 Windows 上会失败，直接跳过并留原文件）
        renameSync(from, join(target, n))
        moved++
      } catch {
        /* 单个文件挪不动就留着 */
      }
    }
    if (moved > 0) log.append('info', 'gal', `截图目录迁移完成: ${moved} 个文件 → ${target}`)
  } catch (err) {
    log.append('warn', 'gal', `截图目录迁移失败（不影响新截图）: ${String(err)}`)
  }
}

/**
 * 启动时扫一遍保存根目录，把每个游戏目录下散落的旧截图挪进 `截图/`。
 *
 * 为什么要开机扫：只在"下次截图"时才迁移的话，用户升级后如果没马上截图，
 * 老截图会和新目录**并存**一段时间（用户明确要求"不要并存两套"）。
 * 只处理「根目录/游戏名」下直接躺着的图片，bgm/立绘/cg/截图 这些子目录一律不碰。
 */
export function migrateAllGalSaves(): number {
  const root = galShotRootDir()
  if (!existsSync(root)) return 0
  let games = 0
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return 0
  }
  for (const name of names) {
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    migrateGalSaveLayout(name)
    games++
  }
  return games
}

/**
 * 截图：先隐藏悬浮窗 200ms → 抓取当前游戏窗口 → 恢复悬浮窗 →
 * 写入 <截图根目录>/<游戏名>/<游戏名>_<时间>.png
 */
export async function galScreenshotNow(): Promise<string> {
  const cfg = getCfg()
  const dir = galShotRootDir(cfg)
  mkdirSync(dir, { recursive: true })

  const win = overlayWin && !overlayWin.isDestroyed() ? overlayWin : null
  const wasVisible = !!win && win.isVisible()
  if (wasVisible) win.hide()
  try {
    /*
     * V1.5.2：200ms → 100ms。
     * 隐藏悬浮窗到真正被系统重绘需要一帧多一点，100ms（约 6 帧）足够；
     * 原来 200ms 是纯等待，占用户感知延迟的一大截。
     */
    await sleep(100)
    const png = await captureGameWindow()
    /*
     * 命名规则（V1.1 统一布局）：`<根目录>/<游戏名>/截图/<游戏名>_<时间>.png`。
     * 必须走 galGameShotDir（它同时负责把旧版散落在 <游戏名>/ 下的截图迁进 截图/），
     * 否则新截图又落到根上、和迁移后的 截图/ 并存 —— 正是用户明确不要的"两套目录"。
     */
    const run = galRunningInfo()
    const name = sanitizeGalName(run?.gameTitle || 'sakana')
    const gameDir = galGameShotDir(name)
    const file = join(gameDir, `${name}_${tsName()}.png`)
    writeFileSync(file, png)
    log.append('info', 'gal', `游戏窗口截图已保存: ${file}`)
    /*
     * V1.5.2：剪贴板复制**不再阻塞截图返回**。
     *
     * 写剪贴板要先快照（读一次整个剪贴板，可能含大图）再原子写，慢的时候几百毫秒；
     * 而截图本身已经存盘成功、用户要的是"按下就有反馈"。所以后台做，失败只进日志。
     */
    void copyScreenshotIfEnabled(file)
    maybeShowSaveHint()
    return file
  } finally {
    if (wasVisible && win && !win.isDestroyed()) win.showInactive()
  }
}

/** 悬浮窗拍摄按钮：与 galScreenshotNow 相同（截图时自动隐藏悬浮窗避免入镜） */
export function galOverlayShot(): Promise<string> {
  return galScreenshotNow()
}

// ---------------- 截图列表 ----------------

const SHOT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

/** 读一个目录下的图片文件（不递归），按修改时间倒序 */
function listImagesIn(dir: string, limit: number): GalRecentShot[] {
  if (!existsSync(dir)) return []
  const out: GalRecentShot[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  for (const name of names) {
    if (!SHOT_EXTS.has(extname(name).toLowerCase())) continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      out.push({ path: full, mtime: st.mtimeMs, name })
    } catch {
      /* 单个文件读失败就跳过，不影响其余截图 */
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, limit)
}

/**
 * 某款游戏自己的截图（gal:list-shots）。
 *
 * 「最近截图」挂在每张游戏卡片上，只允许看**这款游戏自己的目录**。
 * V1.1 起截图在 `<根目录>/<游戏名>/截图/`；如果这一层还没有文件（迁移没触发或刚装新版），
 * 就退回读旧位置 `<根目录>/<游戏名>/`，保证老用户不会"截图突然不见了"。
 */
export function galListShots(gameName: string, limit = 60): GalRecentShot[] {
  const name = sanitizeGalName(gameName || 'sakana')
  const fresh = listImagesIn(join(galShotRootDir(), name, '截图'), limit)
  if (fresh.length) return fresh
  return listImagesIn(join(galShotRootDir(), name), limit)
}

/**
 * 最近截图（gal:recent-shots）：截图根目录 + 一级子目录。
 *
 * 兼容两代存储布局：旧版截图直接躺在根目录（<游戏名>_<时间>.png），
 * 新版按游戏名建子目录（<根目录>/<游戏名>/<游戏名>_<时间>.png）。
 * 沉浸模式里的「最近截图」面板仍然用这个聚合结果。
 */
export function galRecentShots(limit = 30): GalRecentShot[] {
  const root = galShotRootDir()
  const all: GalRecentShot[] = [...listImagesIn(root, limit)]
  if (existsSync(root)) {
    let names: string[] = []
    try {
      names = readdirSync(root)
    } catch {
      names = []
    }
    for (const name of names) {
      const sub = join(root, name)
      try {
        if (!statSync(sub).isDirectory()) continue
      } catch {
        continue
      }
      // V1.1 布局：<根目录>/<游戏名>/截图/；同时兼容旧位置 <根目录>/<游戏名>/
      all.push(...listImagesIn(join(sub, '截图'), limit))
      all.push(...listImagesIn(sub, limit))
    }
  }
  all.sort((a, b) => b.mtime - a.mtime)
  return all.slice(0, limit)
}

// ---------------- 目录选择 ----------------

export async function galPickDir(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    title: '选择截图保存位置',
    defaultPath: getCfg().dir || undefined,
    properties: ['openDirectory', 'createDirectory']
  })
  return r.canceled ? null : (r.filePaths[0] ?? null)
}

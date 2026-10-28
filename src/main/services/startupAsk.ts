import { dialog } from 'electron'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import { log } from '../log'
import { store } from '../store'
import { getMainWindow, openSmallWindow } from '../window'
import { setOfficialBangumiSource } from './bangumiProxy'
import { cacheRoot } from './cacheRoot'
import { dataPaths } from './paths'
import { saveDirsInfo } from './saveDirs'

/**
 * 启动询问（V1.5.1）：先问网络环境（决定数据源），再提醒保存位置。
 *
 * 用户原话：
 *   · 「开启应用后询问用户的网络环境是否能自行链接 bangumi 主站（推荐自行代理），如果不能，
 *      再启用我们的内置反代 api。如果能，数据源 api 就直接用 bangumi 官方的 api（包括图片）…
 *      这个询问框每次启动应用时弹出，除非用户勾选不再弹出」
 *   · 「在询问网络环境的弹窗之后，询问用户动画截图、番剧文件、galgame 截图保存位置，
 *      并提醒用户番剧资源缓存、本地缓存数据库文件位置。也是一样每次启动应用时弹出，
 *      除非用户勾选不再弹出，或者用户已经配置过了保存地址」
 *
 * 两个弹窗都用系统原生 `dialog.showMessageBox`，是因为它自带 `checkboxLabel`（"不再询问"）
 * 与「默认按钮 / 取消按钮」语义 —— 用自绘弹窗不仅要多写一套 UI，还没法做到"应用刚起来、
 * 窗口可能还没画完"时也能稳定显示。
 *
 * 为什么顺序固定（网络 → 保存位置）：数据源决定了启动后第一批请求走哪条链路，
 * 保存位置只影响之后的下载/截图；把更"急"的那个放前面，用户点错关掉窗口的概率更低。
 */

/** 自检/冒烟模式：环境里有任何 SAKANA_* 变量就完全不弹（脚本无法点系统弹窗） */
const QUIET = Object.keys(process.env).some((k) => k.startsWith('SAKANA_'))

function settings(): AppSettings {
  // 兜底对象只需能读字段：真实字段由 DEFAULT_SETTINGS 合并而来（渲染层保存时写全量）
  return store.get<AppSettings>('settings', {} as AppSettings)
}

function patchSettings(patch: Partial<AppSettings>): void {
  store.set('settings', { ...settings(), ...patch })
}

/**
 * 启动时把"上次选择的数据源模式"应用到网络层。
 *
 * 必须在 `bangumi.init()` **之前**调用：init 会立刻读端点池并把选中的链路写进日志，
 * 晚一步就会出现"日志说走官方、实际请求走反代"（排查数据源问题时最误导人的一种）。
 */
export function applySavedBangumiSource(): void {
  const official = settings().bangumiOfficial === true
  setOfficialBangumiSource(official)
}

/**
 * 第一个弹窗：网络环境 → 数据源。
 *
 * 三个按钮刻意是「能直连 / 不能，用内置反代 / 保持上次选择」：
 * 前两个是**切换**，第三个让用户可以直接关掉而不用被迫改变现状（点关闭/ESC 也归到这里）。
 */
async function askBangumiSource(): Promise<void> {
  const s = settings()
  if (s.askBangumiSourceOnStart === false) return
  const official = s.bangumiOfficial === true
  const opts = {
    type: 'question' as const,
    title: '数据源选择',
    message: '你的网络能直接访问 bangumi 主站（bgm.tv）吗？',
    detail:
      '能直连（例如自己开了代理）：将直接使用 bangumi 官方 API 与官方图床。\n' +
      '不能直连：使用应用内置的反向代理，无需任何配置。\n\n' +
      '这个选择只影响番剧数据与图片的取用链路，不影响播放与下载。\n' +
      '每次启动都会询问，可以勾选下面的选项不再询问（之后可在「设置」里重新选择）。',
    buttons: ['能直连（推荐自己开代理）', '不能，使用内置反代', '保持上次选择'],
    defaultId: official ? 0 : 1,
    cancelId: 2,
    noLink: true,
    checkboxLabel: '不再询问（记住这次的选择）',
    checkboxChecked: false
  }
  try {
    const win = getMainWindow()
    const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    const patch: Partial<AppSettings> = {}
    let mode: 'official' | 'proxy' | null = null
    if (res.response === 0) mode = 'official'
    else if (res.response === 1) mode = 'proxy'
    if (mode) {
      patch.bangumiOfficial = mode === 'official'
      setOfficialBangumiSource(mode === 'official')
      log.append(
        'info',
        'startup',
        `数据源已切换为${mode === 'official' ? '官方直连' : '内置反代'}（用户启动时选择）`
      )
    }
    // 勾选「不再询问」时，即使这次选了"保持上次"也记下来 —— 用户的意思就是别再弹了
    if (res.checkboxChecked) patch.askBangumiSourceOnStart = false
    patchSettings(patch)
  } catch (err) {
    log.append('warn', 'startup', `数据源询问弹窗失败（忽略）：${String((err as Error)?.message ?? err)}`)
  }
}

/**
 * 第二个弹窗：保存位置提醒。
 *
 * 只做"告知 + 一键跳到设置页"，不在弹窗里做目录选择（系统弹窗放不下三个目录选择器，
 * 也没有"浏览文件夹"按钮）。所以按钮是「使用默认位置 / 去设置…」：
 *   · 使用默认位置 = 承认现状（目录已经由 ensureSaveDirs 建好），以后不再提醒；
 *   · 去设置… = 打开「文件保存配置」小窗口，用户改完保存后同样不再提醒。
 * 两种情况都会写 `saveDirsConfigured`，对应需求里的「或者用户已经配置过了保存地址」。
 */
async function askSaveDirs(): Promise<void> {
  const s = settings()
  if (s.askSaveDirsOnStart === false) return
  if (s.saveDirsConfigured === true) return
  const dirs = saveDirsInfo()
  const cache = cacheRoot()
  const p = dataPaths()
  const opts = {
    type: 'info' as const,
    title: '保存位置',
    message: '请确认动画截图、番剧文件与 galgame 截图的保存位置',
    detail:
      `动画截图：${dirs.screenshotDir}\n` +
      `番剧文件：${dirs.downloadDir}\n` +
      `galgame 截图：${dirs.galDir}\n\n` +
      `另外两处属于应用自己管理、不需要你选：\n` +
      `番剧资源缓存（边下边播的临时文件）：${join(cache, 'tmp-media')}\n` +
      `本地缓存数据库：${join(cache, 'cache-db')}\n` +
      `全部数据都在安装目录下：${p.root}${p.fallback ? '（安装目录不可写，已回退到用户目录）' : ''}\n\n` +
      '每次启动都会提醒，可以勾选下面的选项不再提醒。',
    buttons: ['使用默认位置', '去设置…'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    checkboxLabel: '不再提醒',
    checkboxChecked: false
  }
  try {
    const win = getMainWindow()
    const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    const patch: Partial<AppSettings> = { saveDirsConfigured: true }
    if (res.checkboxChecked) patch.askSaveDirsOnStart = false
    patchSettings(patch)
    if (res.response === 1) {
      openSmallWindow('/save-dirs', { width: 640, height: 520, title: '文件保存配置' })
    }
    log.append('info', 'startup', `保存位置已确认：截图=${dirs.screenshotDir} 下载=${dirs.downloadDir}`)
  } catch (err) {
    log.append('warn', 'startup', `保存位置提醒弹窗失败（忽略）：${String((err as Error)?.message ?? err)}`)
  }
}

/**
 * 启动询问的主流程（串行：先数据源，再保存位置）。
 *
 * 调用方不要 await 它阻塞启动 —— 弹窗是模态的，用户可能几十秒才点。
 */
export async function runStartupAsks(): Promise<void> {
  if (QUIET) return
  await askBangumiSource()
  await askSaveDirs()
}

import { app, dialog, shell } from 'electron'
import { getMainWindow } from '../window'
import { log } from '../log'
import { store } from '../store'

/**
 * 新手引导弹窗（每个只显示一次）：
 * - 首次启动：提示数据/配置文件保存位置（附「打开文件夹」快捷跳转）
 * - 首次保存行为（下载 / 番剧截图 / 游戏截图）：再次提示一次保存位置
 */

const QUIET = Object.keys(process.env).some((k) => k.startsWith('SAKANA_'))

function showOnce(key: 'introShown' | 'saveHintShown', title: string, message: string): void {
  if (QUIET) return
  const seen = store.get<{ introShown?: boolean; saveHintShown?: boolean }>('onboarding', {})
  if (seen[key]) return
  store.set('onboarding', { ...seen, [key]: true })
  const win = getMainWindow()
  const detail = `数据与配置保存在：${app.getPath('userData')}`
  const buttons = ['打开文件夹', '知道了']
  const opts = {
    type: 'info' as const,
    title,
    message,
    detail,
    buttons,
    defaultId: 1,
    noLink: true
  }
  // 非阻塞显示（不 await，避免卡住调用方流程）
  const p = win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
  void p
    .then((r) => {
      if (r.response === 0) {
        void shell.openPath(app.getPath('userData'))
      }
    })
    .catch((err) => log.append('warn', 'app', `新手引导弹窗失败: ${String(err)}`))
}

/** 首次启动：提示数据保存位置（只显示一次） */
export function maybeShowIntro(): void {
  showOnce('introShown', '欢迎使用 Sakana 🐟', '你的番剧数据、配置与下载内容都保存在本地。')
}

/** 首次保存行为（下载/截图）：提示一次保存位置（只显示一次） */
export function maybeShowSaveHint(): void {
  showOnce('saveHintShown', '保存位置提示', '下载与截图会保存到本地目录，可随时在「设置 → 文件保存配置」中修改。')
}

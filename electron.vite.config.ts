import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 本地构建期信息（v0.2.12）。
 *
 * 用户要求：关于页里加上项目作者，但**作者名字不要传到 git 仓库**。
 * 于是名字只存在于被 .gitignore 忽略的 `sakana.local.json` 里，
 * 构建时读出来、通过 Vite 的 define 注入成 `__SAKANA_AUTHOR__` ——
 * 仓库里只有变量名，源码与提交历史里都不会出现这个名字。
 * 文件不存在（别人 clone 后构建）就注入空串，关于页自动隐藏那一行。
 */
function localAuthor(): string {
  try {
    const file = resolve('sakana.local.json')
    if (!existsSync(file)) return ''
    const json = JSON.parse(readFileSync(file, 'utf8')) as { author?: string }
    return typeof json.author === 'string' ? json.author.trim() : ''
  } catch {
    return ''
  }
}

const AUTHOR = localAuthor()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    // 注入本地作者名（未配置时是空串，页面里会自行隐藏）
    define: { __SAKANA_AUTHOR__: JSON.stringify(AUTHOR) },
    plugins: [react(), tailwindcss()]
  }
})

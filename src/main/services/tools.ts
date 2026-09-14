import { app, BrowserWindow, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { FavoriteItem, SakanaDataExport, Subscription, ToolMeta, ToolRunResult, WatchHistoryItem } from '@shared/types'
import { log } from '../log'
import { store } from '../store'

const RUN_TIMEOUT_MS = 10 * 60 * 1000

function extractDocstring(content: string): string | null {
  const m = content.match(/^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/m)
  if (!m) return null
  return m[1].trim()
}

function findCover(scriptPath: string): string | null {
  const stem = scriptPath.slice(0, -extname(scriptPath).length)
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    if (existsSync(stem + ext)) return stem + ext
  }
  return null
}

function pythonBin(): string {
  return process.platform === 'win32' ? 'python' : 'python3'
}

/**
 * 扩展工具服务（方案 3.5：导入 Python 脚本、运行、数据接口、要求文档生成）
 * 工具通过 `--sakana-data <json路径>` 参数 + SAKANA_DATA 环境变量读取应用数据。
 */
class ToolService {
  list(): ToolMeta[] {
    return store.get<ToolMeta[]>('tools', [])
  }

  async import(): Promise<ToolMeta | null> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: '导入 Python 工具脚本',
      filters: [{ name: 'Python 脚本', extensions: ['py'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    const scriptPath = r.filePaths[0]
    let content = ''
    try {
      content = readFileSync(scriptPath, 'utf-8')
    } catch (err) {
      throw new Error(`读取脚本失败: ${String(err)}`)
    }
    const doc = extractDocstring(content)
    const description = doc
      ? doc.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).join(' ')
      : ''
    const versionMatch = content.match(/(?:version|版本)\s*[:=]\s*["']?([\d.]+)/i)
    const meta: ToolMeta = {
      id: randomUUID(),
      name: basename(scriptPath, extname(scriptPath)),
      description,
      cover: findCover(scriptPath),
      scriptPath,
      version: versionMatch?.[1] ?? null,
      importedAt: Date.now()
    }
    const tools = this.list().filter((t) => t.scriptPath !== scriptPath)
    tools.push(meta)
    store.set('tools', tools)
    log.append('info', 'tools', `导入工具: ${meta.name}`)
    return meta
  }

  remove(id: string): boolean {
    store.set('tools', this.list().filter((t) => t.id !== id))
    return true
  }

  buildExportData(): SakanaDataExport {
    const favorites = store.get<FavoriteItem[]>('favorites', [])
    const subscriptions = store.get<Subscription[]>('subscriptions', [])
    const watchHistory = store.get<WatchHistoryItem[]>('watchHistory', [])
    return {
      exportedAt: Date.now(),
      favorites,
      subscriptions,
      watchHistory,
      stats: {
        favoriteCount: favorites.length,
        subscriptionCount: subscriptions.length,
        watchedEpisodeCount: watchHistory.length,
        watchedHourCount: Math.round(
          watchHistory.reduce((sum, h) => sum + h.durationSec, 0) / 3600
        )
      }
    }
  }

  async run(id: string): Promise<ToolRunResult> {
    const tool = this.list().find((t) => t.id === id)
    if (!tool) throw new Error('工具不存在')
    const dataDir = join(app.getPath('userData'), 'tool-data')
    mkdirSync(dataDir, { recursive: true })
    const dataFile = join(dataDir, `${tool.id}.json`)
    writeFileSync(dataFile, JSON.stringify(this.buildExportData(), null, 2), 'utf-8')
    const start = Date.now()
    log.append('info', 'tools', `运行工具: ${tool.name}`)
    return await new Promise<ToolRunResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (result: ToolRunResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      let child
      try {
        child = spawn(pythonBin(), [tool.scriptPath, '--sakana-data', dataFile], {
          cwd: dirname(tool.scriptPath),
          env: { ...process.env, SAKANA_DATA: dataFile, PYTHONIOENCODING: 'utf-8' },
          windowsHide: true
        })
      } catch (err) {
        finish({ exitCode: -1, stdout: '', stderr: '', durationMs: Date.now() - start, error: `无法启动 Python: ${String(err)}` })
        return
      }
      const timer = setTimeout(() => {
        child.kill()
        finish({ exitCode: -1, stdout, stderr, durationMs: Date.now() - start, error: '执行超时（10 分钟）' })
      }, RUN_TIMEOUT_MS)
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf-8')
        if (stdout.length > 200000) stdout = stdout.slice(-200000)
      })
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf-8')
        if (stderr.length > 200000) stderr = stderr.slice(-200000)
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        finish({ exitCode: -1, stdout, stderr, durationMs: Date.now() - start, error: `无法启动 Python: ${err.message}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish({ exitCode: code ?? -1, stdout, stderr, durationMs: Date.now() - start })
        log.append(code === 0 ? 'info' : 'warn', 'tools', `工具 ${tool.name} 结束 (exit=${code ?? '?'})`)
      })
    })
  }

  /** 方案 3.5：生成工具编写要求文档（TXT / MD） */
  async exportDocs(format: 'md' | 'txt'): Promise<string> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return ''
    const r = await dialog.showSaveDialog(win, {
      title: '保存工具开发文档',
      defaultPath: `Sakana工具开发文档.${format}`,
      filters: [{ name: format === 'md' ? 'Markdown' : '文本文件', extensions: [format] }]
    })
    if (r.canceled || !r.filePath) return ''
    writeFileSync(r.filePath, buildToolDocs(format), 'utf-8')
    return r.filePath
  }
}

function buildToolDocs(format: 'md' | 'txt'): string {
  const md = `# Sakana 扩展工具开发文档

## 一、编写要求

1. 工具必须使用 **Python 3** 编写，入口为单个 .py 脚本。
2. 脚本首部使用三引号 docstring 描述工具用途（导入时会自动提取前四行作为描述）。
3. 推荐在注释中标注版本号，格式：\`version: 1.0.0\`。
4. 可选的封面图：与脚本同目录、同文件名（.png/.jpg/.webp）。
5. 工具在导入后于 Sakana 工具页内直接运行，无需外部依赖（如需第三方库，请在脚本内自行处理异常并给出友好提示）。

## 二、接口规范

### 2.1 数据获取

运行工具时，Sakana 会：

1. 生成应用数据 JSON 文件，路径通过两种方式传给脚本：
   - 命令行参数：\`--sakana-data <json绝对路径>\`
   - 环境变量：\`SAKANA_DATA\`
2. 脚本的工作目录（cwd）为脚本所在目录。
3. 标准输出（stdout）与标准错误（stderr）会被捕获并显示在运行结果面板中。
4. 退出码 0 视为成功，非 0 视为失败。
5. 单次运行上限 10 分钟，超时将被终止。

### 2.2 数据格式

\`\`\`json
{
  "exportedAt": 1756450000000,
  "favorites": [
    {
      "subjectId": 123456,
      "name": "原名",
      "nameCn": "中文名",
      "cover": "https://...",
      "rating": 8.1,
      "airDate": "2024-01-07",
      "genres": ["恋爱", "日常"],
      "addedAt": 1756450000000
    }
  ],
  "subscriptions": [
    {
      "id": "uuid",
      "subjectId": 123456,
      "name": "原名",
      "nameCn": "中文名",
      "cover": "https://...",
      "group": "字幕组",
      "episode": 3,
      "status": "complete",
      "lastPubDate": "Sat, 20 Jan 2024 12:00:00 GMT",
      "folder": "D:/downloads/番剧名",
      "mikanKeyword": "番剧名",
      "createdAt": 1756450000000
    }
  ],
  "watchHistory": [
    {
      "id": "uuid",
      "subjectId": 123456,
      "title": "番剧名",
      "episode": 3,
      "source": "local",
      "watchedAt": 1756450000000,
      "hour": 21,
      "durationSec": 1420
    }
  ],
  "stats": {
    "favoriteCount": 12,
    "subscriptionCount": 5,
    "watchedEpisodeCount": 300,
    "watchedHourCount": 118
  }
}
\`\`\`

## 三、模板示例

\`\`\`python
"""导出我的收藏列表统计报告：按类型统计收藏数量并打印。"""

import json
import os
import sys
from collections import Counter


def main() -> int:
    data_path = None
    if "--sakana-data" in sys.argv:
        data_path = sys.argv[sys.argv.index("--sakana-data") + 1]
    data_path = data_path or os.environ.get("SAKANA_DATA")
    if not data_path or not os.path.exists(data_path):
        print("未找到 Sakana 数据文件", file=sys.stderr)
        return 1

    with open(data_path, encoding="utf-8") as f:
        data = json.load(f)

    genres = Counter()
    for item in data.get("favorites", []):
        for g in item.get("genres", []):
            genres[g] += 1

    print(f"收藏总数: {data['stats']['favoriteCount']}")
    print("类型分布:")
    for genre, count in genres.most_common():
        print(f"  {genre}: {count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
\`\`\`

## 四、注意事项

- 请勿在工具内长时间阻塞或无限循环（10 分钟超时）。
- 网络请求请自行设置超时（建议 15 秒内）。
- 输出编码统一使用 UTF-8（Sakana 已设置 PYTHONIOENCODING=utf-8）。
`
  if (format === 'txt') {
    return md
      .replace(/^#+ /gm, '')
      .replace(/```[a-z]*\n?/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
  }
  return md
}

export const toolService = new ToolService()

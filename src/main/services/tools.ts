import { app, BrowserWindow, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type {
  FavoriteItem,
  SakanaDataExport,
  Subscription,
  ToolImportItem,
  ToolImportReport,
  ToolMeta,
  ToolRunResult,
  WatchHistoryItem
} from '@shared/types'
import {
  detectToolKind,
  parseToolMeta,
  type ToolImportNote,
  type ToolMetaParse
} from '@shared/toolImport'
import { buildToolDocs, buildToolDocsText } from '@shared/toolDocs'
import { log } from '../log'
import { store } from '../store'

const RUN_TIMEOUT_MS = 10 * 60 * 1000

/* ------------------------------------------------------------------ *
 * Python 解释器探测（v0.3.9）
 *
 * 旧实现直接 `spawn('python')`：Windows 上只装了 py launcher、或 Python 只在
 * Microsoft Store 的 App Execution Alias 里时，运行会直接失败，而错误信息只有一句
 * "无法启动 Python: spawn python ENOENT" —— 用户不知道该怎么办。
 * 现在按 python → py -3 → python3 依次探测（结果缓存），全都没有时给一条
 * 说清楚"装什么、怎么装"的错误。
 * ------------------------------------------------------------------ */

interface PythonCandidate {
  binary: string
  args: string[]
}

const PYTHON_CANDIDATES: PythonCandidate[] =
  process.platform === 'win32'
    ? [
        { binary: 'python', args: [] },
        { binary: 'py', args: ['-3'] },
        { binary: 'python3', args: [] }
      ]
    : [
        { binary: 'python3', args: [] },
        { binary: 'python', args: [] }
      ]

let resolvedPython: PythonCandidate | null | undefined

/** 探测可用的 Python：跑 `<bin> --version`，退出码 0 就算可用 */
async function probePython(): Promise<PythonCandidate | null> {
  if (resolvedPython !== undefined) return resolvedPython
  for (const cand of PYTHON_CANDIDATES) {
    const ok = await new Promise<boolean>((resolveProbe) => {
      let settled = false
      const done = (v: boolean): void => {
        if (settled) return
        settled = true
        resolveProbe(v)
      }
      try {
        const child = spawn(cand.binary, [...cand.args, '--version'], { windowsHide: true })
        child.on('error', () => done(false))
        child.on('close', (code) => done(code === 0))
        // 探测也不能挂住：3 秒没有结果就判失败（Store 别名有时会弹窗等待）
        setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* 已经退出了 */
          }
          done(false)
        }, 3000)
      } catch {
        done(false)
      }
    })
    if (ok) {
      resolvedPython = cand
      return cand
    }
  }
  resolvedPython = null
  return null
}

/**
 * 找封面图（v0.3.9 放宽）。
 *
 * 旧实现只找"脚本同目录、同文件名"的 4 种扩展名。现在按优先级找：
 * ① 脚本里声明的 `封面: xxx.png`（相对脚本目录或绝对路径，能读出文件就算）
 * ② 同目录同名图片（**扩展名放宽**：png/jpg/jpeg/webp/bmp/gif/avif）
 * ③ 同目录 `cover.png` / `封面.png`（很多人这么放）
 * 找不到返回 null（封面本来就不是必填项）。
 */
function findCover(scriptPath: string, coverHint: string | null): string | null {
  const dir = dirname(scriptPath)
  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif']
  const fileExists = (p: string): boolean => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  }
  if (coverHint) {
    const candidates = isAbsolute(coverHint)
      ? [coverHint]
      : [resolve(dir, coverHint), resolve(dir, coverHint.replace(/^\.\//, ''))]
    for (const c of candidates) {
      if (fileExists(c) && !c.toLowerCase().endsWith('.py')) return c
    }
  }
  const stem = scriptPath.slice(0, -extname(scriptPath).length)
  for (const ext of exts) {
    if (fileExists(stem + ext)) return stem + ext
  }
  for (const name of ['cover', '封面', 'banner', 'icon']) {
    for (const ext of exts) {
      const p = join(dir, name + ext)
      if (fileExists(p)) return p
    }
  }
  return null
}

/** 导入时最多读多大（防止误选一个几十 MB 的文件把主进程读爆） */
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024

/**
 * 读取脚本文件（v0.3.9 放宽）。
 *
 * 关键改动：**不再假设 UTF-8 一定能读**。中文 Windows 上大量脚本是 GBK 存的，
 * 旧实现 `readFileSync(path, 'utf-8')` 要么抛错（整个导入失败）、要么读出满屏 `\uFFFD`
 * （描述显示成乱码）。现在读 Buffer 交给 `parseToolMeta` 做编码兜底（UTF-8 → GB18030）。
 */
function readScriptBuffer(scriptPath: string): Buffer {
  let buf: Buffer
  try {
    buf = readFileSync(scriptPath)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') throw new Error(`文件不存在或已被移动：${scriptPath}`)
    if (e.code === 'EISDIR') throw new Error(`这是一个文件夹，不是脚本文件：${scriptPath}`)
    if (e.code === 'EACCES' || e.code === 'EPERM') throw new Error(`没有读取权限：${scriptPath}`)
    if (e.code === 'EBUSY') throw new Error(`文件被其它程序占用（关掉编辑器再试）：${scriptPath}`)
    throw new Error(`读取文件失败（${e.code ?? 'unknown'}）：${scriptPath}`)
  }
  if (buf.length === 0) throw new Error(`文件是空的（0 字节）：${scriptPath}`)
  if (buf.length > MAX_SCRIPT_BYTES) {
    throw new Error(
      `文件太大（${(buf.length / 1024 / 1024).toFixed(1)} MB，上限 2 MB）：${scriptPath}`
    )
  }
  return buf
}

/** 旧实现遗留的 docstring 抽取（保留导出给自检用，实际解析走 parseToolMeta） */
function extractDocstring(content: string): string | null {
  const m = content.match(/^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/m)
  if (!m) return null
  return m[1].trim()
}

function pythonBin(): string {
  return process.platform === 'win32' ? 'python' : 'python3'
}

/**
 * 扩展工具服务（方案 3.5：导入 Python 脚本、运行、数据接口、要求文档生成）
 * 工具通过 `--sakana-data <json路径>` 参数 + SAKANA_DATA 环境变量读取应用数据。
 *
 * v0.3.9 放宽导入：见 `src/shared/toolImport.ts` 的文件头注释（设计原则与放宽点都在那里）。
 */
class ToolService {
  list(): ToolMeta[] {
    return store.get<ToolMeta[]>('tools', [])
  }

  /**
   * 导入工具（v0.3.9：一次可选多个文件，每份单独结算）。
   *
   * 返回 ToolImportReport 而不是单个 ToolMeta：用户要"给什么都能尽量吃进去"，
   * 那就不能出现"选了 5 个文件、其中一个格式怪就整批失败"。
   * 每份文件都会带上它的解析提示（notes），界面据此显示"成功 N 份，其中 M 份带警告"。
   */
  async import(): Promise<ToolImportReport> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { items: [], imported: 0, failed: 0, canceled: true }
    const r = await dialog.showOpenDialog(win, {
      title: '导入工具脚本（可多选；非 Python 也能导入，只是不能直接运行）',
      // v0.3.9：不再用 .py 过滤器把用户挡在门外 —— "所有文件"始终可选，
      // 因为 .txt / 无扩展名 / .py.txt 都是实际存在的存档方式。
      filters: [
        { name: '脚本文件（推荐 Python）', extensions: ['py', 'pyw'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    })
    if (r.canceled || r.filePaths.length === 0) {
      return { items: [], imported: 0, failed: 0, canceled: true }
    }
    const items = this.importPaths(r.filePaths)
    return {
      items,
      imported: items.filter((i) => i.status === 'imported' || i.status === 'updated').length,
      failed: items.filter((i) => i.status === 'failed').length,
      canceled: false
    }
  }

  /**
   * 按路径导入（不弹对话框）。
   *
   * 之所以单独抽出来：① 批量导入要"每份单独 try/catch"；② 自检（SAKANA 自测脚本）
   * 可以直接喂一批构造出来的"格式很烂"的文件，验证"成功 N 条 / M 条带警告"。
   */
  importPaths(paths: string[]): ToolImportItem[] {
    const items: ToolImportItem[] = []
    for (const p of paths) {
      items.push(this.importOne(p))
    }
    const okCount = items.filter((i) => i.status === 'imported' || i.status === 'updated').length
    if (okCount > 0) {
      log.append(
        'info',
        'tools',
        `导入工具 ${okCount}/${paths.length} 份（带警告 ${items.filter((i) => i.warnCount > 0).length} 份）`
      )
    }
    return items
  }

  /** 单份导入：任何异常都收敛成 failed 项（带"为什么 + 该怎么办"） */
  private importOne(scriptPath: string): ToolImportItem {
    const fileName = basename(scriptPath)
    try {
      const buf = readScriptBuffer(scriptPath)
      const parsed = parseToolMeta(scriptPath, buf)
      const meta = this.buildMeta(scriptPath, parsed)
      const tools = this.list()
      const replaced = tools.some((t) => t.scriptPath === scriptPath)
      // 同路径覆盖：保留原 id（工具卡片位置不变），其余用新解析结果
      const prev = tools.find((t) => t.scriptPath === scriptPath)
      const next: ToolMeta = prev ? { ...meta, id: prev.id, importedAt: prev.importedAt } : meta
      const list = tools.filter((t) => t.scriptPath !== scriptPath)
      list.push(next)
      store.set('tools', list)
      return {
        path: scriptPath,
        fileName,
        status: replaced ? 'updated' : 'imported',
        tool: next,
        notes: parsed.notes,
        warnCount: parsed.notes.filter((n) => n.level === 'warn').length,
        replaced
      }
    } catch (err) {
      const message = String((err as Error)?.message ?? err)
      const note: ToolImportNote = {
        level: 'warn',
        field: 'kind',
        source: scriptPath,
        message: `这份文件没能导入：${message}`,
        messageEn: `Could not import this file: ${message}`
      }
      log.append('warn', 'tools', `导入失败 ${fileName}: ${message}`)
      return {
        path: scriptPath,
        fileName,
        status: 'failed',
        tool: null,
        error: message,
        notes: [note],
        warnCount: 1,
        replaced: false
      }
    }
  }

  /** 解析结果 → 入库元数据（解析不出来的字段一律降级，不抛错） */
  private buildMeta(scriptPath: string, parsed: ToolMetaParse): ToolMeta {
    return {
      id: randomUUID(),
      name: parsed.name,
      description: parsed.description,
      cover: findCover(scriptPath, parsed.coverHint),
      scriptPath,
      version: parsed.version,
      importedAt: Date.now(),
      // 种类直接用解析结果（扩展名 / shebang 判定的结论都在里面），主进程不再自己判一次
      kind: parsed.kind.kind,
      kindLabel: parsed.kind.label,
      kindLabelEn: parsed.kind.labelEn,
      runnable: parsed.kind.runnable,
      author: parsed.author,
      coverHint: parsed.coverHint,
      docstringLine: parsed.docstringLine,
      versionLine: parsed.versionLine,
      notes: parsed.notes,
      run: parsed.run
    }
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

    /*
     * v0.3.9：运行前先确认"这份文件有运行时"。
     * 旧实现不管什么文件都用 python 去跑，用户导入一个 .sh 只会看到一句
     * "无法启动 Python: ..." —— 现在直接说清"这个种类不能跑、Python 才可以"。
     * `tool.kind` 是 v0.3.9 才入库的字段：老记录没有它，按扩展名/shabeg 现判一次。
     */
    const kind = tool.kind ?? detectToolKind(tool.scriptPath, '').kind
    if (kind !== 'python') {
      return {
        exitCode: -1,
        stdout: '',
        stderr: '',
        durationMs: 0,
        error:
          `「${tool.name}」是${labelOfKind(kind)}，Sakana 目前只有 Python 3 的运行时，无法直接运行。` +
          '把它改成 .py（或在首行加 `#!/usr/bin/env python3`）就能跑；' +
          '其它语言可以导入留档，但不能在应用内执行。'
      }
    }
    const py = await probePython()
    if (!py) {
      return {
        exitCode: -1,
        stdout: '',
        stderr: '',
        durationMs: 0,
        error:
          '找不到 Python 3 解释器。请安装 Python 3 并在安装时勾选「Add python.exe to PATH」' +
          '（Sakana 会依次尝试 python / py -3 / python3）；装好后重新点「运行」即可。'
      }
    }

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
        child = spawn(py.binary, [...py.args, tool.scriptPath, '--sakana-data', dataFile], {
          cwd: dirname(tool.scriptPath),
          env: { ...process.env, SAKANA_DATA: dataFile, PYTHONIOENCODING: 'utf-8' },
          windowsHide: true
        })
      } catch (err) {
        finish({
          exitCode: -1,
          stdout: '',
          stderr: '',
          durationMs: Date.now() - start,
          error: `无法启动 ${py.binary}: ${String(err)}`
        })
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
        finish({
          exitCode: -1,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          error: `无法启动 ${py.binary}: ${err.message}`
        })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish({ exitCode: code ?? -1, stdout, stderr, durationMs: Date.now() - start })
        log.append(code === 0 ? 'info' : 'warn', 'tools', `工具 ${tool.name} 结束 (exit=${code ?? '?'})`)
      })
    })
  }

  /** 方案 3.5：生成工具编写要求文档（TXT / MD）；内容见 shared/toolDocs.ts */
  async exportDocs(format: 'md' | 'txt'): Promise<string> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return ''
    const r = await dialog.showSaveDialog(win, {
      title: '保存工具开发文档',
      defaultPath: `Sakana工具开发文档.${format}`,
      filters: [{ name: format === 'md' ? 'Markdown' : '文本文件', extensions: [format] }]
    })
    if (r.canceled || !r.filePath) return ''
    writeFileSync(r.filePath, format === 'md' ? buildToolDocs() : buildToolDocsText(), 'utf-8')
    return r.filePath
  }
}

/** 种类 → 中文标签（与 shared/toolImport.ts 的 EXT_KIND 保持一致的口径） */
function labelOfKind(kind: string): string {
  const map: Record<string, string> = {
    python: 'Python 脚本',
    shell: 'Shell 脚本',
    powershell: 'PowerShell 脚本',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    text: '文本文件',
    other: '未知类型文件'
  }
  return map[kind] ?? '未知类型文件'
}

function labelOfKindEn(kind: string): string {
  const map: Record<string, string> = {
    python: 'Python script',
    shell: 'Shell script',
    powershell: 'PowerShell script',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    text: 'Text file',
    other: 'Unknown file type'
  }
  return map[kind] ?? 'Unknown file type'
}

export const toolService = new ToolService()
/** 自检入口：`extractDocstring` 保留给历史自检脚本用（实际解析已走 parseToolMeta） */
export { extractDocstring }


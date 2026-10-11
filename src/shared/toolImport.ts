/**
 * 「导入工具」的**入口规格与容错解析**（v0.3.9 放宽语言要求）。
 *
 * 为什么把这个文件放在 shared：同一套规则要被三处用到，规则只能有一份 ——
 * 1. 主进程导入时真正解析（`src/main/services/tools.ts`）；
 * 2. 界面上的「导入说明」文档（中英对照 + 字段表 + 示例，`src/shared/toolDocs.ts`）；
 * 3. 导出成 .md / .txt 的要求文档（同一个 toolDocs）。
 * 三处各写一份必然漂移（文档说"要有 docstring"、代码只认三引号 —— 用户按文档写反而导不进去）。
 *
 * 设计原则（用户原话「放宽松导入工具需要的语言」「用户给什么都能尽量吃进去」）：
 * - **任何文件都不整体拒绝**：认不出扩展名也照收（只是标注"不能运行"），
 *   因为用户可能把脚本存成 .txt / .py.txt / 无扩展名；真正的门槛只有"能不能跑"。
 * - 元数据（名称/描述/版本）**全部是可选的**：缺一个字段只降级 + 给警告，
 *   名称永远有兜底（文件名），不像以前那样"读不出来就是空描述"。
 * - 警告信息必须**说到点上**：第几行、哪个字段、为什么、应该怎么写（见 ToolImportNote）。
 */

/** 元数据字段键（用于把警告定位到具体字段） */
export type ToolMetaFieldKey = 'docstring' | 'version' | 'cover' | 'runnable' | 'kind'

/**
 * 可以被"键: 值"行赋值的字段（名称/描述/版本/作者/封面）。
 *
 * 与 ToolMetaFieldKey 分开：后者是"警告挂在哪一类问题上"（含 kind/runnable 这种
 * 不是字段的诊断标签），前者才是真正有别名表的字段。混用会让别名表被迫声明
 * kind/runnable，而它们根本没有同义词。
 */
export type ToolAliasFieldKey = 'name' | 'docstring' | 'version' | 'author' | 'cover'

/** 单条导入提示：既能给人看，也能被界面按"字段"分组展示 */
export interface ToolImportNote {
  level: 'info' | 'warn'
  /** 对应哪个元数据字段（界面按它归类显示） */
  field: ToolMetaFieldKey
  /** 中文说明（含"应该怎么写"） */
  message: string
  /** 英文说明（用户要求文档/提示中英对照） */
  messageEn: string
  /** 出错位置：脚本内的行号（1 起，能定位到才给） */
  line?: number
  /** 出错位置：源文件绝对路径（批量导入时区分是哪一份） */
  source?: string
}

/** 一个文件被判成的种类：决定"能不能导入 / 能不能运行" */
export interface ToolKindSpec {
  kind: string
  /** 界面上显示的名字 */
  label: string
  labelEn: string
  /** 是否能在 Sakana 里直接运行（目前只有 Python 有运行时） */
  runnable: boolean
  /** 认出来的依据 */
  via: 'ext' | 'shebang' | 'none'
}

/**
 * 运行元数据：主进程解析出来的"这份脚本怎么跑"。
 * 与 ToolMeta 分开是因为它是**读脚本内容得到的事实**，不是用户可编辑的数据。
 */
export interface ToolRunMeta {
  /** 实际要执行的命令（如 python / py / python3 / bash） */
  binary: string
  /** 传给运行时的额外参数（如 bash 的脚本路径、node 的脚本路径） */
  runnerArgs: string[]
  /** 脚本声明的 Python 版本要求（如 "3.9"），没有则 null */
  pythonRequires: string | null
  /** 脚本语言/种类（python / shell / javascript / other…） */
  kind: string
  runnable: boolean
}

/** 解析结果（结构化、可断言） */
export interface ToolMetaParse {
  /** 工具名：显式声明优先，否则文件名 */
  name: string
  /** 工具名从哪来：脚本里的 `name:` 声明 / 文件名 */
  nameSource: 'declared' | 'filename'
  /** 描述：docstring 里的说明文字（已去掉元数据行） */
  description: string
  /** docstring 原文（原样保留，界面"查看解析详情"用） */
  docstring: string
  /** docstring 所在行号（1 起，找不到为 null） */
  docstringLine: number | null
  /** 版本号（已去掉 v 前缀），认不出为 null */
  version: string | null
  /** 版本号来自哪一行（1 起） */
  versionLine: number | null
  /** 脚本自己声明的作者 */
  author: string | null
  /** 脚本自己声明的封面图（相对脚本目录或绝对路径） */
  coverHint: string | null
  /** 文件种类（含中英标签，入库时直接用，避免主进程再判一次） */
  kind: ToolKindSpec
  /** 运行元数据 */
  run: ToolRunMeta
  /** 逐条提示（warn = 降级但仍导入） */
  notes: ToolImportNote[]
}

/* ------------------------------------------------------------------ *
 * 字段同义词表：中英文 / 全半角 / 大小写 / 常见叫法都认
 *
 * 用法：`matchFieldKey(line)` 取到行首的 `键: 值`，键经过归一化后查这张表。
 * 归一化 = 去 BOM、trim、全角转半角、小写、去掉空格/下划线/横线/点。
 * 所以 `Title` / `title` / `标 题` / `作品名` / `番剧名` / `作品名称` 都会命中 name。
 * ------------------------------------------------------------------ */

export const TOOL_META_ALIASES: Record<ToolAliasFieldKey, string[]> = {
  // 工具名：以前只能靠文件名，现在脚本里写一行 name: 就能覆盖
  name: ['name', 'tool', 'toolname', 'title', '名称', '名字', '工具名', '工具名称', '标题', '作品名'],
  docstring: ['docstring', 'description', 'desc', 'summary', 'intro', 'about', '描述', '说明', '简介', '介绍', '用途', '功能', '摘要'],
  version: ['version', 'ver', 'ver.', 'v', '版本', '版本号', '修订', 'revision'],
  author: ['author', 'by', 'maintainer', '维护者', '作者', '制作', '制作人'],
  cover: ['cover', 'image', 'icon', 'thumbnail', 'thumb', '封面', '图标', '缩略图']
}

/** 归一化一个"键名"：全角转半角、小写、去掉分隔符与空格 */
export function normalizeMetaKey(raw: string): string {
  return toHalfWidth(raw)
    .replace(/^[\s"'`*#/\-]+/, '')
    .replace(/[\s_\-.]/g, '')
    .toLowerCase()
}

/** 全角字符转半角（含全角空格 U+3000）；只处理 ASCII 可见区，中文原样保留 */
export function toHalfWidth(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x3000) out += ' '
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0)
    else out += ch
  }
  return out
}

/**
 * 把一行 `标题: 值` / `标题：值` / `标题 = 值` / `标题 - 值` 拆成键值。
 * 认不出结构返回 null（调用方好判断"这行是不是元数据行"）。
 *
 * 为什么允许 `-` 当分隔符：很多人的脚本头写成
 *   `# Author - 张三`
 * 这种"松散写法"，以前会被当成描述正文塞进描述里。
 */
export function matchFieldKey(line: string): { key: string; value: string } | null {
  const cleaned = toHalfWidth(line).replace(/^[\s#/*;!]+/, '').trim()
  if (!cleaned) return null
  const m = /^([^:=:\-|\t]{1,24})\s*[:=:|\-]\s*(.*)$/.exec(cleaned)
  if (!m) return null
  const key = normalizeMetaKey(m[1])
  if (!key) return null
  return { key, value: m[2].trim() }
}

/** 键 → 字段（认不出返回 null） */
export function resolveMetaField(key: string): ToolAliasFieldKey | null {
  for (const [field, aliases] of Object.entries(TOOL_META_ALIASES)) {
    if (aliases.includes(key)) return field as ToolAliasFieldKey
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 文件种类识别
 * ------------------------------------------------------------------ */

const EXT_KIND: Record<string, { kind: string; label: string; labelEn: string; runnable: boolean }> = {
  py: { kind: 'python', label: 'Python 脚本', labelEn: 'Python script', runnable: true },
  pyw: { kind: 'python', label: 'Python 脚本', labelEn: 'Python script', runnable: true },
  sh: { kind: 'shell', label: 'Shell 脚本', labelEn: 'Shell script', runnable: false },
  bash: { kind: 'shell', label: 'Shell 脚本', labelEn: 'Shell script', runnable: false },
  ps1: { kind: 'powershell', label: 'PowerShell 脚本', labelEn: 'PowerShell script', runnable: false },
  js: { kind: 'javascript', label: 'JavaScript', labelEn: 'JavaScript', runnable: false },
  mjs: { kind: 'javascript', label: 'JavaScript', labelEn: 'JavaScript', runnable: false },
  cjs: { kind: 'javascript', label: 'JavaScript', labelEn: 'JavaScript', runnable: false },
  ts: { kind: 'typescript', label: 'TypeScript', labelEn: 'TypeScript', runnable: false },
  txt: { kind: 'text', label: '文本文件', labelEn: 'Text file', runnable: false },
  md: { kind: 'text', label: 'Markdown 文档', labelEn: 'Markdown', runnable: false }
}

/** 取小写扩展名（含 `.py.txt` 这类"假扩展名"：只认最后一段，但会把前一段一起报出来） */
export function extOf(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** 是否 python 家族（用于判定"能不能运行"） */
export function isPythonExt(filePath: string): boolean {
  const ext = extOf(filePath)
  return ext === 'py' || ext === 'pyw'
}

/**
 * 判断文件种类。
 *
 * 顺序：**shebang 优先** → 扩展名 → 兜底 other。
 *
 * 为什么 shebang 优先：扩展名可能是错的或多余的 ——
 * `我的工具.py.txt`（另存时多打了个后缀）、`下载(1)`（没后缀）这类很常见，
 * 而 `#!/usr/bin/env python3` 是脚本自己的声明，比后缀可信。
 * 反过来，`.py` 里写着 `#!/bin/bash` 也按 bash 算（运行时会失败，如实标注更好）。
 */
export function detectToolKind(filePath: string, content: string): ToolKindSpec {
  // 1) shebang
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  if (firstLine.startsWith('#!')) {
    const s = firstLine.toLowerCase()
    if (/\bpython[0-9.]*\b/.test(s)) {
      return {
        kind: 'python',
        label: 'Python 脚本（按首行 shebang 判定）',
        labelEn: 'Python script (by shebang)',
        runnable: true,
        via: 'shebang'
      }
    }
    if (/\b(bash|sh|zsh)\b/.test(s)) {
      return {
        kind: 'shell',
        label: 'Shell 脚本（按首行 shebang 判定）',
        labelEn: 'Shell script (by shebang)',
        runnable: false,
        via: 'shebang'
      }
    }
    if (/\bnode\b/.test(s)) {
      return {
        kind: 'javascript',
        label: 'JavaScript（按首行 shebang 判定）',
        labelEn: 'JavaScript (by shebang)',
        runnable: false,
        via: 'shebang'
      }
    }
  }
  // 2) 扩展名
  const byExt = EXT_KIND[extOf(filePath)]
  if (byExt) return { ...byExt, via: 'ext' }
  return { kind: 'other', label: '未知类型文件', labelEn: 'Unknown file type', runnable: false, via: 'none' }
}

/* ------------------------------------------------------------------ *
 * 编码 / 行尾 / BOM 归一化
 * ------------------------------------------------------------------ */

export interface NormalizedText {
  text: string
  /** 原始字节里有没有 UTF-8 BOM */
  hadBom: boolean
  /** 用的哪种编码解码成功 */
  encoding: 'utf-8' | 'gb18030'
  /** 有没有把 CRLF 归一化掉 */
  hadCrlf: boolean
}

/**
 * 能喂给 `normalizeText` 的东西。
 *
 * 刻意**不用 Node 的 `Buffer` 类型**：这个文件在 `tsconfig.web.json` 下也要编译，
 * 而 web 侧只有 DOM 类型（没有 @types/node），写 `Buffer` 会直接报 TS2591。
 * `Buffer` 本身是 `Uint8Array` 的子类，所以主进程传 Buffer 完全兼容。
 */
export type ToolByteSource = Uint8Array | string

/**
 * 把文件字节整理成"可以直接按行解析"的文本。
 *
 * 处理的坑（都是用户实际会踩的）：
 * - **UTF-8 BOM**：`\uFEFF` 会让第一行 `#!...` 匹配不上，必须剥掉；
 * - **CRLF**：Windows 记事本存的 `.py` 到处都是 `\r\n`，行尾的 `\r` 会让
 *   `version: 1.0\r` 这种匹配在正则里出问题；
 * - **GBK/GB18030**：中文 Windows 上 Python 2 风格的老脚本、或记事本"ANSI"另存，
 *   用 UTF-8 硬读会得到一堆 `\uFFFD`（表现为"描述全是乱码"）。
 *   这里按"先 UTF-8、出现替换字符再退 GB18030"的顺序解（与 media.ts 读字幕同一套思路）。
 *
 * 编码兜底用 `TextDecoder('gb18030')` 而不是 iconv-lite：
 * 渲染层也要编译这个文件，多引一个 Node 包不划算；`TextDecoder` 两边都在。
 */
export function normalizeText(raw: ToolByteSource): NormalizedText {
  let hadBom = false
  let encoding: 'utf-8' | 'gb18030' = 'utf-8'
  let text: string

  if (typeof raw === 'string') {
    text = raw
    if (text.charCodeAt(0) === 0xfeff) {
      hadBom = true
      text = text.slice(1)
    }
  } else {
    let bytes = raw
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      hadBom = true
      bytes = bytes.subarray(3)
    }
    text = new TextDecoder('utf-8').decode(bytes)
    if (text.includes('\uFFFD')) {
      try {
        const decoded = new TextDecoder('gb18030').decode(bytes)
        // 只有真的"变好了"才换（避免把本来正常的内容用错编码再解释一次）
        if (!decoded.includes('\uFFFD')) {
          text = decoded
          encoding = 'gb18030'
        }
      } catch {
        /* 环境不支持 gb18030 就保持 utf-8 结果 */
      }
    }
  }

  const hadCrlf = text.includes('\r\n')
  return { text: text.replace(/\r\n?/g, '\n'), hadBom, encoding, hadCrlf }
}

/* ------------------------------------------------------------------ *
 * docstring / 版本 / 作者 解析
 * ------------------------------------------------------------------ */

/**
 * 从脚本内容里抽第一段 docstring 与它的行号。
 *
 * 放宽点（对照旧实现 `content.match(/^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/m)`）：
 * - 支持 `r"""` / `u'''` / `f"""` 前缀（非贪婪只吃三引号，不吃前缀字符）；
 * - 支持**单引号单行** docstring（`"一句话说明"`），很多短脚本就这么写；
 * - 支持三引号写在**同一行**且同一行闭合（`"""说明"""`）；
 * - 只在**第一段可执行语句之前**找（`#` 注释、shebang、空行、from __future__ 除外），
 *   避免把函数体里某个字符串当成工具说明 —— 这也是旧实现最容易出错的地方
 *   （旧实现扫全文，脚本里任何一处 `'''` 都会抢先命中）。
 */
export function extractDocstring(text: string): { doc: string; line: number } | null {
  const lines = text.split('\n')
  // 跳过：空行、注释、shebang、import/from（docstring 允许写在 import 之后）
  const skipRe = /^\s*(#|$|from\s|import\s)/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (skipRe.test(line)) continue
    // 只在"看起来像字符串开头"的行上尝试
    const m = /^\s*[rubfRUBF]{0,2}("""|'''|"|')/.exec(line)
    if (!m) return null
    const quote = m[1]
    const startCol = m[0].length
    if (quote.length === 3) {
      // 同行闭合："""说明"""
      const rest = line.slice(startCol)
      const closeIdx = rest.indexOf(quote)
      if (closeIdx >= 0) return { doc: rest.slice(0, closeIdx).trim(), line: i + 1 }
      // 跨行：一直找到闭合引号
      const buf: string[] = [rest]
      for (let j = i + 1; j < lines.length; j++) {
        const idx = lines[j].indexOf(quote)
        if (idx >= 0) {
          buf.push(lines[j].slice(0, idx))
          return { doc: buf.join('\n').trim(), line: i + 1 }
        }
        buf.push(lines[j])
      }
      // 没有闭合引号（语法错误）：把剩余内容当描述，交给上层给警告
      return { doc: buf.join('\n').trim(), line: i + 1 }
    }
    // 单引号单行：必须同一行闭合
    const rest = line.slice(startCol)
    const idx = rest.indexOf(quote)
    if (idx >= 0) return { doc: rest.slice(0, idx).trim(), line: i + 1 }
    return null
  }
  return null
}

/**
 * 抽版本号。按"从最明确到最宽松"的顺序试，命中即返回。
 *
 * 认得的写法（旧实现只认前两条，且要求行内有 version/版本 关键词）：
 * - `__version__ = "1.0.0"` / `VERSION: 1.0` / `# version: v2.3.1`
 * - `version = '0.1'` / `ver 1.4`
 * - PEP 440 / 语义化版本裸串，如 `__version__ = 2.0-beta.1`
 * - docstring 里单独一行 `Version: 1.2.0`
 */
export function extractVersion(text: string): { version: string | null; line: number | null } {
  // 先全角转半角：`Version：v2.1.0` 里的全角冒号必须当成冒号，
  // 否则"中文冒号也认"这条承诺在版本号上就破了（自检里就是这么挂掉的）。
  const lines = text.split('\n').map((l) => toHalfWidth(l))
  /** `1.0` / `v1.0` / `1.0.0-rc.1` / `2024.1` */
  const versionToken = '(v?\\d+(?:\\.\\d+){0,3}(?:[-_][0-9A-Za-z.]+)?)'
  const patterns: RegExp[] = [
    // 1) 显式版本赋值（__version__ / VERSION / version）
    new RegExp(`^\\s*(?:__)?(?:version|ver|v)(?:__)?\\s*[:=]\\s*["']?\\s*${versionToken}`, 'i'),
    // 2) 中文"版本：1.0"
    new RegExp(`^\\s*(?:版本|版本号)\\s*[:=]\\s*["']?\\s*${versionToken}`)
  ]
  for (const re of patterns) {
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i])
      if (m) return { version: stripV(m[1]), line: i + 1 }
    }
  }
  // 3) 任意位置的 `version: 1.0` / `Ver 1.0`（注释、docstring 里都算）
  const loose = new RegExp(`(?:^|[\\s#/*;!])(?:version|ver|版本|版本号)\\s*[:=]?\\s*${versionToken}`, 'i')
  for (let i = 0; i < lines.length; i++) {
    const m = loose.exec(lines[i])
    if (m) return { version: stripV(m[1]), line: i + 1 }
  }
  return { version: null, line: null }
}

function stripV(v: string): string {
  return v.replace(/^[vV]/, '').replace(/^[_\-.\s]+|[_\-.\s]+$/g, '')
}

/** 从 shebang 里取 Python 版本要求（`#!/usr/bin/env python3.9` → "3.9"） */
export function extractPythonRequires(text: string): string | null {
  const first = text.split('\n', 1)[0] ?? ''
  if (!first.startsWith('#!')) return null
  const m = /python(\d+(?:\.\d+)?)/i.exec(first)
  if (!m) return null
  return m[1]
}

/**
 * 解析脚本里的元数据（**永不抛错**，解析不出来的部分只降级 + 给警告）。
 *
 * 返回的 `notes` 是这次放宽的核心产物：以前"字段对不上"是静默忽略，
 * 现在是"明确告诉你哪一行什么没认出来、应该怎么写"。
 */
export function parseToolMeta(filePath: string, raw: ToolByteSource): ToolMetaParse {
  const norm = normalizeText(raw)
  const text = norm.text
  const kind = detectToolKind(filePath, text)
  const notes: ToolImportNote[] = []

  if (norm.encoding === 'gb18030') {
    notes.push({
      level: 'info',
      field: 'docstring',
      message: `文件不是 UTF-8，已按 GB18030 解码读取（内容正常，不影响运行）`,
      messageEn: 'File was not UTF-8; decoded as GB18030. Contents are fine.'
    })
  }

  const hadCrlf = norm.hadCrlf
  const hadBom = norm.hadBom

  const doc = extractDocstring(text)
  const version = extractVersion(text)
  const pyReq = extractPythonRequires(text)

  // ---- docstring 里的键值行（name / description / version / author / cover） ----
  const declared: Partial<Record<ToolAliasFieldKey, string>> = {}
  const docLines = doc ? doc.doc.split('\n') : []
  const descriptionParts: string[] = []
  for (const line of docLines) {
    const kv = matchFieldKey(line)
    const field = kv ? resolveMetaField(kv.key) : null
    if (kv && field && kv.value) {
      // 首页命中优先（重复声明不覆盖第一条，避免"后来居下"）
      if (!declared[field]) declared[field] = kv.value
      continue
    }
    descriptionParts.push(line)
  }

  const declaredDescription = (declared.docstring ?? '').trim()
  const description = (declaredDescription || descriptionParts.join('\n')).replace(/\s*\n\s*/g, ' ').trim()

  const declaredName = (declared.name ?? '').trim()
  const baseName = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const fileName = baseName.replace(/\.[^.]+$/, '')
  const name = declaredName || fileName

  // ---- 警告：说清楚"哪一行、什么字段、为什么、该怎么做" ----
  if (!doc) {
    notes.push({
      level: 'warn',
      field: 'docstring',
      source: filePath,
      message:
        '没找到脚本说明（docstring）。不影响导入与运行，但工具卡片上会没有描述 —— ' +
        '在脚本第一行写 `"""一句话说明这个工具做什么"""` 即可。',
      messageEn:
        'No docstring found. Import/run still work, but the tool card will have no description. ' +
        'Add `"""What this tool does"""` as the first line of the script.'
    })
  } else if (!description) {
    notes.push({
      level: 'warn',
      field: 'docstring',
      line: doc.line,
      source: filePath,
      message: `第 ${doc.line} 行的 docstring 是空的，工具卡片会显示"（无描述）"。写一句说明即可。`,
      messageEn: `Docstring at line ${doc.line} is empty. Add a one-line summary.`
    })
  }
  if (!version.version) {
    notes.push({
      level: 'warn',
      field: 'version',
      source: filePath,
      message:
        '没找到版本号。可以在脚本里写 `__version__ = "1.0.0"`、`# version: 1.0` ' +
        '或 docstring 里写一行 `版本：1.0`（v 前缀可有可无，中英文皆可）。',
      messageEn:
        'No version found. Write `__version__ = "1.0.0"`, `# version: 1.0`, or a `Version: 1.0` line in the docstring.'
    })
  }
  if (!kind.runnable && kind.kind !== 'python') {
    notes.push({
      level: 'warn',
      field: 'runnable',
      source: filePath,
      message:
        `这份文件被识别为「${kind.label}」，可以导入但不带运行时，Sakana 里点「运行」会失败。` +
        '目前只有 Python 3（.py / .pyw，或首行 shebang 指向 python）能直接运行。',
      messageEn:
        `Detected as "${kind.labelEn}". It can be imported but Sakana has no runtime for it, so "Run" will fail. ` +
        'Only Python 3 (.py/.pyw, or a python shebang) is runnable today.'
    })
  }
  if (hadBom || hadCrlf) {
    notes.push({
      level: 'info',
      field: 'docstring',
      source: filePath,
      message:
        `已自动处理文件格式（${hadBom ? 'UTF-8 BOM；' : ''}${hadCrlf ? 'CRLF 行尾；' : ''}全角空格/中文冒号也认）`,
      messageEn: `Normalized file quirks automatically (${hadBom ? 'BOM; ' : ''}${hadCrlf ? 'CRLF; ' : ''}full-width chars and CJK colons are accepted too)`
    })
  }
  if (kind.via === 'shebang') {
    notes.push({
      level: 'info',
      field: 'kind',
      source: filePath,
      message: `文件没有 .py 扩展名，按首行 shebang 判定为「${kind.label}」`,
      messageEn: `No .py extension; detected as "${kind.labelEn}" from the shebang line.`
    })
  }

  // 作者/封面：只作为附加信息，认不出不报警告（它们不是"要求"）
  const author = (declared.author ?? '').trim() || null
  const coverHint = (declared.cover ?? '').trim() || null

  const runnerArgs = kind.kind === 'python' ? [filePath] : kind.kind === 'shell' ? [filePath] : [filePath]
  return {
    name,
    nameSource: declaredName ? 'declared' : 'filename',
    description,
    docstring: doc?.doc ?? '',
    docstringLine: doc?.line ?? null,
    version: version.version,
    versionLine: version.line,
    author,
    coverHint,
    kind,
    run: {
      binary: kind.kind === 'python' ? 'python' : kind.kind === 'shell' ? 'bash' : '',
      runnerArgs,
      pythonRequires: pyReq,
      kind: kind.kind,
      runnable: kind.runnable
    },
    notes
  }
}

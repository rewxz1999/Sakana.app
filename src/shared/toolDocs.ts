/**
 * 「导入工具」的要求文档（v0.3.9）。
 *
 * 用户原话：「放宽松导入工具需要的语言，这个你看这个来办，**工具要求文档够清晰就行**。」
 * 所以这份文档是这个工单的另一半交付物，并且**只有一份来源**：
 * - 界面里的「导入说明」弹窗直接渲染 `TOOL_DOC_SECTIONS`（结构化，可复制示例）；
 * - 「保存要求文档」导出的 .md / .txt 也由这里生成（`buildToolDocs`）。
 * 两边共用同一份内容，避免"界面说的"和"导出的文档说的"不一致。
 *
 * 写作原则（对着用户的要求来的）：
 * 1. **字段表**：每个字段写清「中文名 / English / 认得的别名 / 是否必填 / 缺了会怎样」；
 * 2. **3 个示例**：最小可用 / 带全部元数据 / **只有标题**（最烂也能用）；
 * 3. **常见错误**：每条给出"错误写法 → 现象 → 正确写法"；
 * 4. 中英对照（用户提到"语言"，所以说明本身就给双语，界面语言是中文也不影响英文用户）；
 * 5. 示例都标注**一键复制**（界面按钮复制 python 模板）。
 */

import { TOOL_META_ALIASES } from './toolImport'

/** `## 标题` + 一段块 */
export interface ToolDocSection {
  id: string
  /** 中文小节标题 */
  title: string
  /** 英文小节标题 */
  titleEn: string
  /** 正文（markdown 片段，中英对照） */
  body: string
}

/** 字段表的一行 */
export interface ToolDocFieldRow {
  key: string
  label: string
  labelEn: string
  /** 认得的别名（已从 TOOL_META_ALIASES 取，保证与代码一致） */
  aliases: string[]
  required: boolean
  /** 缺省时会怎样（"降级策略"） */
  fallback: string
  fallbackEn: string
}

/** 示例（界面上一键复制用） */
export interface ToolDocSample {
  id: string
  title: string
  titleEn: string
  /** 说明这份示例演示了什么 */
  note: string
  noteEn: string
  /** 完整的示例文件内容 */
  content: string
  /** 语言标记（markdown 代码块用） */
  lang: string
}

/** 常见错误（错误写法 → 现象 → 正确写法） */
export interface ToolDocPitfall {
  id: string
  /** 错误现象（用户在界面上看到的那句话） */
  symptom: string
  symptomEn: string
  /** 原因 */
  cause: string
  causeEn: string
  /** 正确写法 */
  fix: string
  fixEn: string
}

/** 字段表：别名直接取自解析器，保证"文档里说认得的，代码里真的认得" */
export const TOOL_DOC_FIELDS: ToolDocFieldRow[] = [
  {
    key: 'name',
    label: '工具名',
    labelEn: 'Name',
    aliases: TOOL_META_ALIASES.name,
    required: false,
    fallback: '用脚本文件名（`我的工具.py` → `我的工具`）',
    fallbackEn: 'Falls back to the file name.'
  },
  {
    key: 'description',
    label: '说明 / 描述',
    labelEn: 'Description',
    aliases: TOOL_META_ALIASES.docstring,
    required: false,
    fallback: 'docstring 里除"键: 值"之外的所有文字都会当成描述；完全没有则显示「（无描述）」',
    fallbackEn: 'All non key:value lines of the docstring become the description.'
  },
  {
    key: 'version',
    label: '版本号',
    labelEn: 'Version',
    aliases: TOOL_META_ALIASES.version,
    required: false,
    fallback: '不显示版本角标（不影响导入与运行）',
    fallbackEn: 'No version badge. Import/run unaffected.'
  },
  {
    key: 'author',
    label: '作者',
    labelEn: 'Author',
    aliases: TOOL_META_ALIASES.author,
    required: false,
    fallback: '留空',
    fallbackEn: 'Left empty.'
  },
  {
    key: 'cover',
    label: '封面图',
    labelEn: 'Cover',
    aliases: TOOL_META_ALIASES.cover,
    required: false,
    fallback: '找同名图片（`我的工具.png` / `.jpg` / `.jpeg` / `.webp`，与脚本同目录）',
    fallbackEn: 'Looks for a same-named image next to the script.'
  }
]

/**
 * Python 模板：**能直接跑**的最小完整脚本（界面「复制模板」按钮复制的就是它）。
 * 故意写得很朴素：只依赖标准库，且把"读数据"的两种方式（参数 / 环境变量）都演示一遍。
 */
export const TOOL_PY_TEMPLATE = `#!/usr/bin/env python3
"""
收藏类型统计：按类型统计收藏数量并打印前 10 名。

name: 收藏类型统计
version: 1.0.0
author: 你的名字
"""

import json
import os
import sys
from collections import Counter


def load_data() -> dict:
    """两种取数方式都支持：--sakana-data 参数 或 SAKANA_DATA 环境变量。"""
    path = None
    if "--sakana-data" in sys.argv:
        path = sys.argv[sys.argv.index("--sakana-data") + 1]
    path = path or os.environ.get("SAKANA_DATA")
    if not path or not os.path.exists(path):
        print("未找到 Sakana 数据文件（--sakana-data / SAKANA_DATA）", file=sys.stderr)
        raise SystemExit(1)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main() -> int:
    data = load_data()
    genres = Counter()
    for item in data.get("favorites", []):
        for g in item.get("genres", []):
            genres[g] += 1
    print(f"收藏总数: {data.get('stats', {}).get('favoriteCount', 0)}")
    for genre, count in genres.most_common(10):
        print(f"  {genre}: {count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`

/** 示例 1：最小可用（只有一行说明，其余全靠兜底） */
const SAMPLE_MINIMAL = `"""把收藏列表导出成一行一条的纯文本。"""
print("hello sakana")
`

/** 示例 2：写全元数据（演示所有字段与各种写法） */
const SAMPLE_FULL = `#!/usr/bin/env python3
r"""
订阅更新检查：列出最近有更新的订阅。

标题：订阅更新检查
描述：读取订阅列表，打印最近 7 天内有更新的番剧。
版本：v2.1.0
作者 - 张三
封面: cover.png
"""

import json
import os

VERSION = "2.1.0"  # 这种写法也认

print("这里放你的逻辑")
`

/** 示例 3：最烂的输入（只有标题、无 docstring、无版本、CRLF、没写扩展名也能导） */
const SAMPLE_BARE = `# 只有一行注释说明
# 没有 docstring、没有版本号、没有 name —— 依旧能导入
import json, sys
print("bare script ok")
`

export const TOOL_DOC_SAMPLES: ToolDocSample[] = [
  {
    id: 'minimal',
    title: '示例 1 · 最小可用',
    titleEn: 'Sample 1 · Minimal that works',
    note: '一行 docstring 就够了：名称取文件名，版本留空，只会在导入结果里给一条"没找到版本号"的提示。',
    noteEn: 'A single docstring line is enough. Name falls back to the file name.',
    content: SAMPLE_MINIMAL,
    lang: 'python'
  },
  {
    id: 'full',
    title: '示例 2 · 写全元数据（中英混排 / 全角冒号 / r-string / 注释里的版本）',
    titleEn: 'Sample 2 · All metadata, mixed CJK/ASCII, full-width colon, r-string',
    note: '演示每种"宽松写法"：`标题：`（全角冒号）、`版本：v2.1.0`（带 v）、`作者 - 张三`（横线分隔）、`VERSION = "2.1.0"`（赋值式）。',
    noteEn: 'Shows every tolerant form the parser accepts.',
    content: SAMPLE_FULL,
    lang: 'python'
  },
  {
    id: 'bare',
    title: '示例 3 · 只有标题（最烂的输入）',
    titleEn: 'Sample 3 · Bare minimum (worst case)',
    note: '没有 docstring、没有版本、没有 name，只有注释和代码 —— 照样导入，只是提示里会告诉你怎么补齐。',
    noteEn: 'No docstring, no version, no name — still imports, with explicit warnings.',
    content: SAMPLE_BARE,
    lang: 'python'
  }
]

export const TOOL_DOC_PITFALLS: ToolDocPitfall[] = [
  {
    id: 'not-utf8',
    symptom: '描述显示成乱码（一堆方块 / 问号）',
    symptomEn: 'Description shows as mojibake',
    cause: '脚本不是 UTF-8 存的（记事本"ANSI"另存就是 GBK）',
    causeEn: 'The script is not saved as UTF-8 (e.g. Notepad "ANSI" = GBK).',
    fix: '现在会自动按 GB18030 兜底解码；想彻底干净就用 UTF-8 保存。',
    fixEn: 'The importer now falls back to GB18030 automatically; saving as UTF-8 is still cleaner.'
  },
  {
    id: 'no-doc',
    symptom: '工具卡片显示「（无描述）」',
    symptomEn: 'The tool card says "(no description)"',
    cause: '脚本第一段可执行语句不是字符串（没有 docstring）',
    causeEn: 'The first statement is not a string literal (no docstring).',
    fix: '在脚本第一行加 `"""一句话说明"""`（单行也可以，不必三行）。',
    fixEn: 'Add `"""One line summary"""` as the first line.'
  },
  {
    id: 'no-version',
    symptom: '卡片上没有版本角标',
    symptomEn: 'No version badge on the card',
    cause: '全文找不到版本号',
    causeEn: 'No version token found in the file.',
    fix: '写 `__version__ = "1.0.0"`、`# version: 1.0` 或在 docstring 里写 `版本：1.0`（v 前缀可有可无）。',
    fixEn: 'Add `__version__ = "1.0.0"`, `# version: 1.0`, or a `Version: 1.0` line in the docstring.'
  },
  {
    id: 'cannot-run',
    symptom: '点「运行」提示「不支持直接运行」',
    symptomEn: '"Run" reports the file type has no runtime',
    cause: '文件不是 Python 3（.js / .sh / .ps1 / 无扩展名且没写 python shebang）',
    causeEn: 'The file is not Python 3.',
    fix: '目前只有 Python 3 能在 Sakana 里直接运行：改成 .py，或首行写 `#!/usr/bin/env python3`。',
    fixEn: 'Only Python 3 runs inside Sakana today: use .py, or add `#!/usr/bin/env python3` as line 1.'
  },
  {
    id: 'no-python',
    symptom: '点「运行」提示「找不到 Python 解释器」',
    symptomEn: '"Run" reports Python was not found',
    cause: '系统里没装 Python 3，或装了但没加进 PATH',
    causeEn: 'Python 3 is not installed or not on PATH.',
    fix: '安装 Python 3（勾选"Add python.exe to PATH"）；Sakana 会依次尝试 python / py -3 / python3。',
    fixEn: 'Install Python 3 with "Add to PATH". Sakana tries python / py -3 / python3 in order.'
  },
  {
    id: 'cwd',
    symptom: '读不到同目录的配置文件',
    symptomEn: 'Cannot read a config file next to the script',
    cause: '以为 cwd 是 Sakana 的安装目录',
    causeEn: 'Assuming cwd is the Sakana install folder.',
    fix: '运行时的 cwd 就是**脚本所在目录**（v0.3.9 前也是），用相对路径读同目录文件即可；要绝对可靠就用 `os.path.dirname(os.path.abspath(__file__))`。',
    fixEn: 'cwd is the script folder. For absolute reliability use `os.path.dirname(os.path.abspath(__file__))`.'
  }
]

/** 数据结构说明（导出文档里作为独立小节；界面弹窗里折叠展示） */
export const TOOL_DATA_JSON_SAMPLE = `{
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
}`

/** 界面「导入说明」弹窗的小节（渲染层直接遍历） */
export const TOOL_DOC_SECTIONS: ToolDocSection[] = [
  {
    id: 'quickstart',
    title: '一、三步就能导入',
    titleEn: '1. Import in three steps',
    body: `1. 写一个 Python 3 脚本（**任何文件名都行**，\`.py\` / \`.txt\` / 无扩展名都能导入；只有能不能"运行"取决于种类）。
2. 工具页点「添加工具」，可一次选**多个**文件。
3. 看导入结果：每份文件单独结算，告诉你"解析到什么 / 哪一项没认出来 / 该怎么补"。

> 一句话：**元数据全都是可选的**。导入不会因为少写字段而失败，只会给你更详细的提示。

1. Write a Python 3 script (any file name works; only "Run" depends on the file kind).
2. Click **Add tool** on the Tools page; you may select **multiple** files at once.
3. Read the import report: every file is settled separately, with per-field hints.`
  },
  {
    id: 'fields',
    title: '二、字段表（全部可选，认得中英文 / 全半角 / 大小写）',
    titleEn: '2. Field reference (all optional; CJK/ASCII, full/half width, any case)',
    body: `元数据写在文件**第一段 docstring** 里，或在注释里，写法是 \`键: 值\` / \`键：值\` / \`键 = 值\` / \`键 - 值\` 都行。
Metadata lives in the first docstring or in comments; \`key: value\`, CJK colon, \`=\`, and \`-\` all work.`
  },
  {
    id: 'data',
    title: '三、怎么读取应用数据',
    titleEn: '3. How to read app data',
    body: `运行时 Sakana 会生成一份应用数据 JSON，并同时用两种方式告诉你路径（任选一种读取）：
Sakana writes an app-data JSON and passes its path in two ways (use either):

- 命令行参数 \`--sakana-data <json 绝对路径>\`
- 环境变量 \`SAKANA_DATA\`

另外：**运行目录 cwd = 脚本所在目录**；stdout/stderr 会显示在结果面板；退出码 0 表示成功；单次运行上限 10 分钟。`
  },
  {
    id: 'samples',
    title: '四、示例（都能一键复制）',
    titleEn: '4. Samples (one-click copy)',
    body: `三个示例分别覆盖"最小可用 / 写全元数据 / 只有标题"三种情况，任选最接近的一种改。`
  },
  {
    id: 'pitfalls',
    title: '五、常见错误',
    titleEn: '5. Common pitfalls',
    body: `按"你看到的现象"查即可。`
  }
]

/**
 * 生成导出的要求文档（.md 原文；.txt 由 `toPlainText` 去掉标记）。
 *
 * 结构刻意与界面弹窗一致（字段表 → 示例 → 常见错误），
 * 这样用户"界面上看到的"和"保存下来的"是同一份东西。
 */
export function buildToolDocs(): string {
  const fieldTable = [
    '| 字段 / Field | 认得的别名 / Accepted aliases | 必填 | 缺了会怎样 / Fallback |',
    '| --- | --- | --- | --- |',
    ...TOOL_DOC_FIELDS.map((f) => {
      const aliases = f.aliases.map((a) => `\`${a}\``).join(' ')
      return `| ${f.label} · ${f.labelEn} | ${aliases} | 否 / No | ${f.fallback} |`
    })
  ].join('\n')

  const samples = TOOL_DOC_SAMPLES.map(
    (s) =>
      `### ${s.title} · ${s.titleEn}\n\n${s.note}\n_${s.noteEn}_\n\n\`\`\`${s.lang}\n${s.content}\`\`\``
  ).join('\n\n')

  const pitfalls = TOOL_DOC_PITFALLS.map(
    (p) =>
      `**现象 / Symptom**：${p.symptom} · _${p.symptomEn}_\n\n` +
      `- 原因 / Cause：${p.cause} · _${p.causeEn}_\n` +
      `- 正确写法 / Fix：${p.fix} · _${p.fixEn}_`
  ).join('\n\n')

  return `# Sakana 扩展工具：导入与编写说明

> English summary below each section. **元数据全部可选** —— 缺字段只会降级 + 给提示，不会导入失败。
> All metadata is optional; missing fields degrade gracefully with explicit hints.

## ${TOOL_DOC_SECTIONS[0].title}
${TOOL_DOC_SECTIONS[0].body}

## ${TOOL_DOC_SECTIONS[1].title}
${TOOL_DOC_SECTIONS[1].body}

${fieldTable}

未被认出的 \`键: 值\` 行会当成**描述正文**保留（不会丢），并在导入结果里提示"这一行没认出是哪个字段"。

## ${TOOL_DOC_SECTIONS[2].title}
${TOOL_DOC_SECTIONS[2].body}

\`\`\`json
${TOOL_DATA_JSON_SAMPLE}
\`\`\`

## ${TOOL_DOC_SECTIONS[3].title}
${TOOL_DOC_SECTIONS[3].body}

${samples}

## ${TOOL_DOC_SECTIONS[4].title}
${TOOL_DOC_SECTIONS[4].body}

${pitfalls}

## 附：Python 模板（复制即用）
## Appendix: copy-paste Python template

\`\`\`python
${TOOL_PY_TEMPLATE}\`\`\`
`
}

/** .md → .txt 的降级转换（与旧实现的处理保持一致，不去引 markdown 渲染器） */
export function buildToolDocsText(): string {
  return buildToolDocs()
    .replace(/^#+ /gm, '')
    .replace(/```[a-z]*\n?/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^> /gm, '')
}

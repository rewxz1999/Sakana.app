import { useState } from 'react'
import { motion } from 'framer-motion'
import { BarChart3, FileDown, FileText, LayoutGrid, Play, Puzzle, SquareTerminal, Trash2 } from 'lucide-react'
import { useTools } from '@/stores/tools'
import { timeAgo } from '@/lib/format'
import { api } from '@/lib/api'
import { Button, EmptyState, Modal } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import { toast } from '@/stores/app'

/** 内置统计工具（默认自带，无需导入即可从本页启动） */
const BUILTIN_STAT_TOOL = {
  id: '__stat',
  name: '统计工具',
  description: '内置统计工具：管理「看过 / 在看 / 计划」等自定义列表，记录个人评分、看完时间，从收藏一键添加条目。',
  icon: BarChart3
}

/**
 * 内置「最XX的角色 9宫格」（v0.2.11）。
 *
 * 选角色（数据来自 Bangumi）→ 排成 3×3～4×10 的格子 → 导出 PNG。
 * 与统计工具一样在新窗口里打开：这个页面是画布式编辑器，主窗口里塞不下。
 */
const BUILTIN_CHARACTER_GRID_TOOL = {
  id: '__character-grid',
  name: '最XX的角色 9宫格',
  description:
    '搜索作品并挑选角色，排成「最喜欢 / 最遗憾 / 最神秘 …」的九宫格（最多 4×10 = 40 格，标签可改写），导出 PNG（导出前需填写制作人）。',
  icon: LayoutGrid,
  hash: '/tools/character-grid'
}

export function ToolsPage() {
  const { tools, importTool, removeTool, runTool, exportDocs, runningId, lastResult } = useTools()
  const [docsMenu, setDocsMenu] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)

  return (
    <div className="relative h-full overflow-y-auto px-6 py-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-bold">工具</h1>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-faint">
            基于 Python 脚本的扩展工具。导入后可访问应用数据（收藏列表、订阅、观看历史、统计），直接在界面内运行。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="soft" icon={SquareTerminal} onClick={() => void importTool()}>
            添加工具
          </Button>
          <div className="relative">
            <Button variant="outline" icon={FileDown} onClick={() => setDocsMenu((v) => !v)}>
              保存要求文档
            </Button>
            {docsMenu && (
              <div className="absolute right-0 top-10 z-30 w-44 overflow-hidden rounded-xl border border-border bg-elev1 py-1 shadow-xl">
                <button
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs hover:bg-elev2 whitespace-nowrap"
                  onClick={() => {
                    setDocsMenu(false)
                    void exportDocs('md')
                  }}
                >
                  <FileText size={13} /> 导出 Markdown (.md)
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs hover:bg-elev2 whitespace-nowrap"
                  onClick={() => {
                    setDocsMenu(false)
                    void exportDocs('txt')
                  }}
                >
                  <FileText size={13} /> 导出文本 (.txt)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 内置统计工具（默认自带，在新窗口中打开） */}
      <motion.div
        layout
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        onClick={() => void api.window.openSmall('/stattool', { width: 1180, height: 820, title: '统计工具' })}
        whileHover={{ y: -3 }}
        className="mt-5 flex cursor-pointer flex-col overflow-hidden rounded-xl border border-accent/40 bg-elev1 transition-colors hover:border-accent"
      >
        <div className="flex items-center gap-4 p-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <BUILTIN_STAT_TOOL.icon size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{BUILTIN_STAT_TOOL.name}</span>
              <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent whitespace-nowrap">内置</span>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-dim">{BUILTIN_STAT_TOOL.description}</p>
          </div>
          <Button size="sm" icon={Play} onClick={(e) => {
            e.stopPropagation()
            void api.window.openSmall('/stattool', { width: 1180, height: 820, title: '统计工具' })
          }}>
            启动
          </Button>
        </div>
      </motion.div>

      {/* 内置「最XX的角色 9宫格」（v0.2.11，同样在新窗口中打开） */}
      <motion.div
        layout
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        onClick={() =>
          void api.window.openSmall(BUILTIN_CHARACTER_GRID_TOOL.hash, {
            width: 1320,
            height: 880,
            title: BUILTIN_CHARACTER_GRID_TOOL.name
          })
        }
        whileHover={{ y: -3 }}
        className="mt-4 flex cursor-pointer flex-col overflow-hidden rounded-xl border border-accent/40 bg-elev1 transition-colors hover:border-accent"
      >
        <div className="flex items-center gap-4 p-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <BUILTIN_CHARACTER_GRID_TOOL.icon size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{BUILTIN_CHARACTER_GRID_TOOL.name}</span>
              <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent whitespace-nowrap">内置</span>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-dim">{BUILTIN_CHARACTER_GRID_TOOL.description}</p>
          </div>
          <Button size="sm" icon={Play} onClick={(e) => {
            e.stopPropagation()
            void api.window.openSmall(BUILTIN_CHARACTER_GRID_TOOL.hash, {
              width: 1320,
              height: 880,
              title: BUILTIN_CHARACTER_GRID_TOOL.name
            })
          }}>
            启动
          </Button>
        </div>
      </motion.div>

      {tools.length > 0 ? (
        <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {tools.map((tool) => (
            <motion.div
              key={tool.id}
              layout
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              whileHover={{ y: -3 }}
              className="flex flex-col overflow-hidden rounded-xl border border-border bg-elev1"
            >
              <div className="relative h-28 w-full overflow-hidden bg-elev2">
                <CoverImage src={tool.cover} local className="h-full w-full" />
                {!tool.cover ? (
                  <div className="absolute inset-0 flex items-center justify-center text-faint">
                    <SquareTerminal size={30} />
                  </div>
                ) : null}
                {tool.version ? (
                  <span className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white backdrop-blur whitespace-nowrap">
                    v{tool.version}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-1 flex-col p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="line-clamp-1 text-sm font-semibold">{tool.name}</span>
                  <button
                    title="删除工具"
                    className="text-faint transition-colors hover:text-danger"
                    onClick={() => {
                      void removeTool(tool.id)
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <p className="mt-1 line-clamp-2 flex-1 text-[11px] leading-relaxed text-dim">
                  {tool.description || '（无描述）'}
                </p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[10px] text-faint">导入于 {timeAgo(tool.importedAt)}</span>
                  <Button
                    size="sm"
                    icon={Play}
                    loading={runningId === tool.id}
                    onClick={() => {
                      void runTool(tool.id).then((r) => {
                        if (r) setResultOpen(true)
                      })
                    }}
                  >
                    运行
                  </Button>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-border bg-elev1/40 p-8">
          <EmptyState
            icon={Puzzle}
            title="还没有导入外部工具"
            desc="点击「添加工具」导入 Python 脚本。脚本需接收 --sakana-data 参数或 SAKANA_DATA 环境变量以读取应用数据，详见「保存要求文档」。"
          >
            <Button onClick={() => void importTool()}>导入第一个工具</Button>
          </EmptyState>
        </div>
      )}

      {/* 运行结果弹窗 */}
      <Modal open={resultOpen} onClose={() => setResultOpen(false)} title="工具运行结果" width={620}>
        {lastResult ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span
                className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 font-medium ${
                  lastResult.error
                    ? 'bg-danger/15 text-danger'
                    : lastResult.exitCode === 0
                      ? 'bg-ok/15 text-ok'
                      : 'bg-warn/15 text-warn'
                }`}
              >
                {lastResult.error ? '运行失败' : lastResult.exitCode === 0 ? '运行成功' : `退出码 ${lastResult.exitCode}`}
              </span>
              <span className="text-faint">耗时 {(lastResult.durationMs / 1000).toFixed(1)}s</span>
            </div>
            {lastResult.error ? <div className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{lastResult.error}</div> : null}
            {lastResult.stdout ? (
              <div>
                <div className="mb-1 text-xs font-semibold text-dim">标准输出</div>
                <pre className="selectable max-h-44 overflow-auto rounded-lg bg-elev2 p-3 text-[11px] leading-relaxed whitespace-pre-wrap">{lastResult.stdout}</pre>
              </div>
            ) : null}
            {lastResult.stderr ? (
              <div>
                <div className="mb-1 text-xs font-semibold text-dim">标准错误</div>
                <pre className="selectable max-h-40 overflow-auto rounded-lg bg-danger/8 p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-danger">{lastResult.stderr}</pre>
              </div>
            ) : null}
            {!lastResult.stdout && !lastResult.stderr ? (
              <div className="py-4 text-center text-xs text-faint">（无输出）</div>
            ) : null}
            <div className="text-right text-[10px] text-faint">
              <a className="cursor-pointer underline" onClick={() => toast.info('输出已可选中复制')}>
                可选中文本复制
              </a>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

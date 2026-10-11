import { create } from 'zustand'
import type { ToolImportReport, ToolMeta, ToolRunResult } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from './app'

interface ToolsState {
  tools: ToolMeta[]
  loaded: boolean
  runningId: string | null
  lastResult: ToolRunResult | null
  /**
   * 最近一次导入的结算报告（v0.3.9）。
   *
   * 为什么留在这里而不是直接弹个 toast：用户要求「工具要求文档够清晰」，
   * 那导入结果的提示就得能**回看**（哪份文件、第几行、哪个字段没认出来、该怎么补）。
   * 页面用它在导入后自动打开「导入结果」弹窗。
   */
  lastImport: ToolImportReport | null
  load: () => Promise<void>
  importTool: () => Promise<void>
  removeTool: (id: string) => Promise<void>
  runTool: (id: string) => Promise<ToolRunResult | null>
  exportDocs: (format: 'md' | 'txt') => Promise<void>
  clearImport: () => void
}

export const useTools = create<ToolsState>((set, get) => ({
  tools: [],
  loaded: false,
  runningId: null,
  lastResult: null,
  lastImport: null,
  load: async () => {
    const r = await api.tools.list()
    set({ tools: r.ok ? r.data : [], loaded: true })
  },
  importTool: async () => {
    const r = await api.tools.import()
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    const report = r.data
    if (report.canceled) return // 用户取消：不提示、不弹窗
    set({ lastImport: report })
    await get().load()
    /*
     * 一句话总结（详细内容在「导入结果」弹窗里）：
     * 用户要「给什么都能尽量吃进去」，所以"部分成功 + 有警告"必须如实说出来，
     * 而不是像以前那样只在成功时弹一句"已导入工具"、失败时什么都不显示。
     */
    const warned = report.items.filter((i) => i.warnCount > 0).length
    if (report.imported === 0 && report.failed > 0) {
      toast.error(`${report.failed} 份文件没能导入，点「导入结果」看原因`)
    } else if (report.failed > 0) {
      toast.warn(`成功导入 ${report.imported} 份（${report.failed} 份失败），点「导入结果」看详情`)
    } else if (warned > 0) {
      toast.success(`已导入 ${report.imported} 份工具，其中 ${warned} 份有可优化的提示`)
    } else {
      toast.success(`已导入 ${report.imported} 份工具`)
    }
  },
  removeTool: async (id) => {
    await api.tools.remove(id)
    toast.info('已移除工具')
    await get().load()
  },
  runTool: async (id) => {
    set({ runningId: id })
    const r = await api.tools.run(id)
    set({ runningId: null })
    if (!r.ok) {
      toast.error(r.error)
      return null
    }
    set({ lastResult: r.data })
    if (r.data.error) toast.error(r.data.error)
    else if (r.data.exitCode === 0) toast.success('工具运行完成')
    else toast.warn(`工具以退出码 ${r.data.exitCode} 结束`)
    return r.data
  },
  exportDocs: async (format) => {
    const r = await api.tools.exportDocs(format)
    if (r.ok && r.data) toast.success(`文档已保存 ${r.data}`)
    else if (!r.ok) toast.error(r.error)
  },
  clearImport: () => set({ lastImport: null })
}))

import { create } from 'zustand'
import type { ToolMeta, ToolRunResult } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from './app'

interface ToolsState {
  tools: ToolMeta[]
  loaded: boolean
  runningId: string | null
  lastResult: ToolRunResult | null
  load: () => Promise<void>
  importTool: () => Promise<void>
  removeTool: (id: string) => Promise<void>
  runTool: (id: string) => Promise<ToolRunResult | null>
  exportDocs: (format: 'md' | 'txt') => Promise<void>
}

export const useTools = create<ToolsState>((set, get) => ({
  tools: [],
  loaded: false,
  runningId: null,
  lastResult: null,
  load: async () => {
    const r = await api.tools.list()
    set({ tools: r.ok ? r.data : [], loaded: true })
  },
  importTool: async () => {
    const r = await api.tools.import()
    if (r.ok && r.data) {
      toast.success(`已导入工具: ${r.data.name}`)
      await get().load()
    } else if (!r.ok) {
      toast.error(r.error)
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
    if (r.ok && r.data) toast.success(`文档已保存: ${r.data}`)
    else if (!r.ok) toast.error(r.error)
  }
}))

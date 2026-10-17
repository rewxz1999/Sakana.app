import { useCallback, useEffect, useState } from 'react'
import type {
  DanmakuSource,
  DanmakuSourceRegistry,
  DanmakuSourceTestResult
} from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'

/**
 * 弹幕数据源集合器的渲染层状态（V1.1）。
 *
 * 数据流（与统计工具同一套：主进程是唯一写入方）：
 * - 读：`api.danmaku.sources()` → `{ sources, adapters, library }`；
 * - 写：**整表提交** `api.danmaku.sourcesSave(sources)`，主进程再校验一遍
 *   （id 去重、未知适配器保留但无效、priority 归一化成 1..n）并返回规范化后的表；
 * - 所以这里保存后**用返回值覆盖本地**，而不是继续用本地那份乐观状态 ——
 *   否则用户拖出来的顺序与主进程实际存的顺序会不一致。
 *
 * 为什么增删改排序都在这一层做完再整表提交：集合器条目数是个位数，
 * 整表提交比给每种操作设计一条 IPC 简单得多，也不会出现"两个窗口各改一半"。
 */
export interface SourceCatalogState {
  registry: DanmakuSourceRegistry | null
  loading: boolean
  saving: boolean
  /** 每条源最近一次「真测试」的结果（key = source.id） */
  tests: Record<string, DanmakuSourceTestResult | 'running'>
  reload: () => Promise<void>
  /** 整表保存（会归一化 priority 为列表顺序） */
  save: (next: DanmakuSource[]) => Promise<DanmakuSource[] | null>
  /** 新增一条；返回主进程规范化后的那条（新增后立刻"真测试"要用它，而不是本地草稿） */
  addSource: (draft: Omit<DanmakuSource, 'priority' | 'createdAt'>) => Promise<DanmakuSource | null>
  updateSource: (id: string, patch: Partial<DanmakuSource>) => Promise<void>
  removeSource: (id: string) => Promise<void>
  toggleSource: (id: string, enabled: boolean) => Promise<void>
  /** 上移/下移一位（优先级排序，用户要的"排序"用这个实现：不引入拖拽库） */
  moveSource: (id: string, delta: number) => Promise<void>
  /** 真测试：发一次真请求并把逐步骤结果记下来 */
  testSource: (source: DanmakuSource, keyword?: string) => Promise<void>
  /** 改本地弹幕缓存目录（空串 = 回默认 `<缓存目录>/弹幕`） */
  saveLibraryDir: (dir: string) => Promise<void>
}

export function useSourceCatalog(): SourceCatalogState {
  const [registry, setRegistry] = useState<DanmakuSourceRegistry | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tests, setTests] = useState<Record<string, DanmakuSourceTestResult | 'running'>>({})

  const reload = useCallback(async () => {
    setLoading(true)
    const r = await api.danmaku.sources()
    setLoading(false)
    if (!r.ok) {
      toast.error(`读取弹幕数据源失败：${r.error}`)
      return
    }
    setRegistry(r.data)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = useCallback(
    async (next: DanmakuSource[]): Promise<DanmakuSource[] | null> => {
      setSaving(true)
      const r = await api.danmaku.sourcesSave(next)
      setSaving(false)
      if (!r.ok) {
        toast.error(`保存失败：${r.error}`)
        // 保存失败就把主进程那份重新读回来，避免界面停在一个"没存进去"的状态
        void reload()
        return null
      }
      setRegistry((prev) => (prev ? { ...prev, sources: r.data } : prev))
      return r.data
    },
    [reload]
  )

  /** 当前列表（主进程返回的顺序就是优先级顺序） */
  const current = useCallback((): DanmakuSource[] => registry?.sources ?? [], [registry])

  const addSource = useCallback<SourceCatalogState['addSource']>(
    async (draft) => {
      const list = current()
      const adapter = registry?.adapters.find((a) => a.id === draft.adapter)
      const next: DanmakuSource = {
        ...draft,
        // priority 由顺序决定（save 里会归一化），这里先放到末尾
        priority: list.length + 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      const saved = await save([...list, next])
      if (!saved) return null
      // 取主进程回传的那条：id 可能被去重逻辑改写、基址可能被补默认值
      const created = saved.find((s) => s.id === next.id) ?? saved[saved.length - 1] ?? null
      toast.success(`已添加数据源「${created?.name || adapter?.name || next.adapter}」`)
      return created
    },
    [current, registry, save]
  )

  const updateSource = useCallback<SourceCatalogState['updateSource']>(
    async (id, patch) => {
      const next = current().map((s) => (s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s))
      await save(next)
    },
    [current, save]
  )

  const removeSource = useCallback<SourceCatalogState['removeSource']>(
    async (id) => {
      const target = current().find((s) => s.id === id)
      await save(current().filter((s) => s.id !== id))
      toast.info(`已删除数据源「${target?.name ?? id}」`)
    },
    [current, save]
  )

  const toggleSource = useCallback<SourceCatalogState['toggleSource']>(
    async (id, enabled) => {
      await updateSource(id, { enabled })
    },
    [updateSource]
  )

  const moveSource = useCallback<SourceCatalogState['moveSource']>(
    async (id, delta) => {
      const list = [...current()]
      const i = list.findIndex((s) => s.id === id)
      const j = i + delta
      if (i < 0 || j < 0 || j >= list.length) return
      const [item] = list.splice(i, 1)
      list.splice(j, 0, item)
      await save(list)
    },
    [current, save]
  )

  const testSource = useCallback<SourceCatalogState['testSource']>(async (source, keyword) => {
    setTests((prev) => ({ ...prev, [source.id]: 'running' }))
    const r = await api.danmaku.sourceTest(source, keyword)
    setTests((prev) => ({
      ...prev,
      [source.id]: r.ok
        ? r.data
        : { ok: false, message: `测试没能执行：${r.error}`, steps: [], samples: [] }
    }))
    if (!r.ok) toast.error(`测试没能执行：${r.error}`)
  }, [])

  const saveLibraryDir = useCallback<SourceCatalogState['saveLibraryDir']>(
    async (dir) => {
      const r = await api.danmaku.librarySetDir(dir)
      if (!r.ok) {
        toast.error(`设置弹幕库目录失败：${r.error}`)
        return
      }
      setRegistry((prev) => (prev ? { ...prev, library: r.data } : prev))
      toast.success(dir ? `弹幕库目录已改为 ${r.data.dir}` : '弹幕库目录已恢复默认')
    },
    []
  )

  return {
    registry,
    loading,
    saving,
    tests,
    reload,
    save,
    addSource,
    updateSource,
    removeSource,
    toggleSource,
    moveSource,
    testSource,
    saveLibraryDir
  }
}

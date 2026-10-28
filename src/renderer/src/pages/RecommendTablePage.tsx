import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  ImageDown,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Star,
  Tags,
  Trash2,
  UserRound
} from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import {
  MAX_LONG_PAGES,
  renderModules,
  useRecommendTable,
  type ModuleKind,
  type ModuleRect,
  type RecommendPage,
  type RecommendPageInput,
  type RecommendPagePatch
} from '@/stores/recommendTable'
import { Badge, Button, ConfirmModal, EmptyState, Input, Modal, Select, Spinner } from '@/components/ui'
import { ContextMenu, type ContextMenuItem } from '@/components/stat/ContextMenu'
import { FittedRecommendCard } from '@/components/recommend/FittedCard'
import { SubjectPicker } from '@/components/recommend/SubjectPicker'
import { PageEditDialog } from '@/components/recommend/PageEditDialog'
import { ExportDialog } from '@/components/recommend/ExportDialog'
import { RecommendTableList } from '@/components/recommend/RecommendTableList'
import { EditLeftPanel } from '@/components/recommend/EditLeftPanel'
import { EditRightPanel } from '@/components/recommend/EditRightPanel'
import { ModuleDragLayer } from '@/components/recommend/ModuleDragLayer'
import type { EditCtx } from '@/components/recommend/editTypes'
import { buildExportDocument } from '@/components/recommend/exportHtml'
import { displayName, frameOf, moduleRectsOf, sheetStyle } from '@/components/recommend/styles'

/**
 * 「番剧推荐表」工具页（路由 `/tools/recommend-table`）。
 *
 * ## 这个工具做什么
 *
 * 建一张自己的推荐表（表名自定义）→ 搜索或从**当季番剧**、**收藏**里挑作品加进来（一页一部）→
 * 翻页阅览每页的推荐卡 → 导出成高清 PNG（只导当前页，或把最多 5 页拼成一张长图）。
 *
 * ## v0.3.9「自定义页面内容」编辑模式（用户这一轮的原话）
 *
 *   · 列表页那张表上**右键**：输入推荐人 / 补齐标签 / 导出为图片 / 推荐表改名（原来在编辑器顶栏）；
 *   · 画布上右键 →「自定义页面内容」→ 进入**编辑模式**：画布居中，左右各一列菜单；
 *   · 左菜单 Ⅰ–Ⅶ（版面图片 / 模块显隐 / 模块大小 / 占比 / 框选 / 内容区渐变 / 模块摆放），
 *     右菜单 Ⅰ–Ⅲ（页面尺寸 / 导出 / 模块字体字号）；画布上方只剩「退出并保存 / 移除这一页」；
 *   · 翻阅模式**不再写任何 layout 坐标** —— 自由摆放只在编辑模式里发生，
 *     所以老数据与不编辑的页仍然是那套默认版式（外观一字不变）。
 *
 * 本文件只做三件事：把 store 的状态画出来、把用户的动作转成 store 调用、把导出参数拼成 HTML。
 * 几何、样式、面板、拖动叠层分别在 `components/recommend/` 的对应文件里。
 *
 * ## 窄窗口下的取舍
 *
 * 编辑模式的两列各固定 260px、可各自滚动；中间画布用 `FittedRecommendCard` **等比缩小**
 * 把整页塞进去，所以窗口再窄也不会挤坏版式（不需要抽屉/浮层那套额外状态）。
 * 真到了很小的窗口（本项目允许的那种），画布会很小但仍完整可操作 —— 这正是"编辑模式看整体构图"的场景。
 */

/** 导出保存对话框的标题（主进程直接显示它，所以写死一处，别在几个地方各拼一遍） */
const EXPORT_TITLE = '导出推荐表为图片'

/** 编辑模式左右两列的宽度：够放下数字输入框 + 滑杆，又不至于把画布挤没 */
const EDIT_COL = 'w-[260px] shrink-0'

export function RecommendTablePage() {
  // ---- store（逐个字段订阅：任何一处改动都不会让整页跟着重渲染） ----
  const tables = useRecommendTable((s) => s.tables)
  const recommender = useRecommendTable((s) => s.recommender)
  const loaded = useRecommendTable((s) => s.loaded)
  const load = useRecommendTable((s) => s.load)
  const createTable = useRecommendTable((s) => s.createTable)
  const renameTable = useRecommendTable((s) => s.renameTable)
  const removeTable = useRecommendTable((s) => s.removeTable)
  const setRecommender = useRecommendTable((s) => s.setRecommender)
  const addPage = useRecommendTable((s) => s.addPage)
  const addPages = useRecommendTable((s) => s.addPages)
  const updatePage = useRecommendTable((s) => s.updatePage)
  const removePage = useRecommendTable((s) => s.removePage)
  const setModuleVisible = useRecommendTable((s) => s.setModuleVisible)
  const setModuleRect = useRecommendTable((s) => s.setModuleRect)
  const setModuleFont = useRecommendTable((s) => s.setModuleFont)
  const resetModuleRects = useRecommendTable((s) => s.resetModuleRects)
  const resetModules = useRecommendTable((s) => s.resetModules)
  const applyPagePatch = useRecommendTable((s) => s.applyPagePatch)
  const backfill = useRecommendTable((s) => s.backfill)
  /** 左侧「添加作品」面板是否收起（偏好，落盘记住） */
  const panelHidden = useRecommendTable((s) => s.panelHidden)
  const setPanelHidden = useRecommendTable((s) => s.setPanelHidden)

  const [openId, setOpenId] = useState<string | null>(null)
  const table = useMemo(() => tables.find((t) => t.id === openId) ?? null, [tables, openId])
  // useMemo 而不是 `?? []`：每次渲染新建一个空数组会让下面所有依赖 pages 的 memo/effect 白跑
  const pages = useMemo(() => table?.pages ?? [], [table])

  useEffect(() => {
    void load()
  }, [load])

  // ---------------- 翻页 ----------------

  const [pageIndex, setPageIndex] = useState(0)
  /*
   * 页数变化时把下标夹回合法范围。
   * 为什么必须夹：加了一页后 index 正常递增，但删掉最后一页时 index 会指到不存在的页 ——
   * 那时预览区会整块空白，用户只会觉得「表坏了」。
   */
  useEffect(() => {
    if (pageIndex > 0 && pageIndex >= pages.length) {
      setPageIndex(Math.max(0, pages.length - 1))
    }
  }, [pages.length, pageIndex])

  const currentPage: RecommendPage | null = pages[pageIndex] ?? null

  // ---------------- 编辑模式（v0.3.9） ----------------

  /** 编辑模式：画布居中、左右菜单负责所有页面设置；退出即保存（改动本来就实时落盘） */
  const [editMode, setEditMode] = useState(false)
  /** 当前选中的模块（右菜单 Ⅲ 与左菜单 Ⅲ/Ⅶ 都作用于它；画布上点一下也会选中） */
  const [selected, setSelected] = useState<ModuleKind | null>(null)
  /**
   * 导出目标与导出中标记（v0.3.9）。
   *
   * ⚠️ 这两个 state 必须声明在 `editCtx` **与 `menuItems`** 之前：`useMemo` 的工厂函数
   * 在渲染时就执行，而编辑菜单的「导出为图片」和画布右键菜单的「只导出这一页」都要用到它们
   * —— 声明在后面会踩到 TDZ（运行时报错，与这个页面以前那个 `pendingRemovePage` 的坑是同一类）。
   *
   * 为什么导出目标是 `{ tableId, pageIndex, mode }` 而不是"当前打开的表"：
   * 导出入口有三个（画布右键菜单 / 编辑模式右菜单 Ⅱ / 列表那张表的右键菜单），
   * 中间那个作用的对象不一定是当前打开的表，所以这里把"导谁、默认导哪一页、默认什么范围"存下来，
   * 弹窗与导出逻辑只认它。
   */
  const [exportTarget, setExportTarget] = useState<{
    tableId: string
    pageIndex: number
    /** 弹窗打开时预选的范围：current = 只导当前页（推荐页右键菜单），long = 多页长图（列表右键菜单） */
    mode: 'current' | 'long'
  } | null>(null)
  const [exporting, setExporting] = useState(false)

  /**
   * 打开导出弹窗（v0.3.9 补充：用户要求把「只导出当前页」放到**推荐页自己的右键菜单**里）。
   *
   * 为什么只是"打开弹窗、预选范围"而不是直接就导：清晰度（2 / 3 倍）是用户每次导出都要做的选择，
   * 而且导出会弹系统保存框 —— 直接导会让"点错了"的代价变成一次完整的导出流程。
   * 预选范围之后，从推荐页右键进来就是"这一页"，从列表右键进来就是"多页/长图"，
   * 两处的语义清楚，功能仍然只有一套。
   */
  const openExport = useCallback(
    (mode: 'current' | 'long'): void => {
      if (!table) return
      setExportTarget({ tableId: table.id, pageIndex, mode })
    },
    [table, pageIndex]
  )

  /** 换页时清掉选中：选中的是"上一页那一块"，留着会让右菜单显示另一个模块的字号 */
  useEffect(() => setSelected(null), [currentPage?.id])

  /** 这一页的页面框与模块矩形（左右菜单、拖动叠层、坐标输入框共用同一份） */
  const frame = useMemo(() => (currentPage ? frameOf(currentPage) : null), [currentPage])
  const rects = useMemo(
    () => (currentPage && frame ? moduleRectsOf(frame, currentPage.layout) : null),
    [currentPage, frame]
  )
  /** 页面上真正画出来的模块（隐藏的不给拖、不出现在手柄里） */
  const drawnIds = useMemo(
    () => (currentPage ? renderModules(currentPage).map((m) => m.id) : []),
    [currentPage]
  )

  const patchPage = useCallback(
    (p: RecommendPagePatch): void => {
      if (!table || !currentPage) return
      updatePage(table.id, currentPage.id, p)
    },
    [table, currentPage, updatePage]
  )

  const patchAllPages = useCallback(
    (p: RecommendPagePatch): void => {
      if (!table) return
      const n = applyPagePatch(table.id, p)
      toast.success(`已应用到全部 ${n} 页`)
    },
    [table, applyPagePatch]
  )

  const editCtx: EditCtx | null = useMemo(() => {
    if (!currentPage || !frame || !rects || !table) return null
    return {
      table,
      page: currentPage,
      frame,
      rects,
      selected,
      setSelected,
      patch: patchPage,
      patchAll: patchAllPages,
      setModuleVisible: (id, v) => setModuleVisible(table.id, currentPage.id, id, v),
      setModuleRect: (id, r) => setModuleRect(table.id, currentPage.id, id, r),
      setModuleFont: (id, p) => setModuleFont(table.id, currentPage.id, id, p),
      resetRects: () => resetModuleRects(table.id, currentPage.id),
      resetModules: () => resetModules(table.id, currentPage.id),
      // 编辑模式右菜单 Ⅱ：默认「只导当前页」（这一页就是用户正在编辑的那一页）
      openExport: () => openExport('current'),
      exporting
    }
  }, [
    currentPage,
    frame,
    rects,
    selected,
    table,
    patchPage,
    patchAllPages,
    setModuleVisible,
    setModuleRect,
    setModuleFont,
    resetModuleRects,
    resetModules,
    openExport,
    exporting
  ])

  /**
   * 编辑模式的两列菜单**共用这一个条件**（v0.3.9 补充：用户要求左右同时呼出）。
   *
   * 为什么抽成一个变量而不是在两处各写一遍条件：以前左右两列各写各的判断
   * （左边还套了一层"没内容就 null"的三元），只要有一处被后人改动，
   * 就会出现"只出一侧"的形态 —— 那时用户看到的是一半的编辑能力，而且没有任何报错。
   * 现在两列都由 `editPanels` 决定，`editCtx` 非空即两列同时出现，**不存在只出一侧的可能**。
   */
  const editPanels = editMode && editCtx !== null && currentPage !== null

  // ---------------- 添加作品 ----------------

  const addedIds = useMemo(() => new Set(pages.map((p) => p.subjectId)), [pages])

  /** 补齐进行中标记（store 里也是逐页串行 await 的，界面按钮据此显示 loading） */
  const backfillingRef = useRef(false)
  /** 「跑的过程中又有人要求补一次」的标记，见 runBackfill 里的说明 */
  const backfillQueuedRef = useRef(false)
  const [backfilling, setBackfilling] = useState(false)

  /**
   * 用 bangumi 详情补齐「类型标签 / 播出时间」。
   *
   * 为什么加进作品后要自动跑一次：搜索结果和季度列表**都没有 tags**（只有详情接口有），
   * 而类型标签是用户要求显示在卡片上的内容 —— 不补的话每一页都得用户自己右键补一次。
   * 补齐是异步的、可以慢，所以不阻塞添加（先让页面出现，标签随后填上）。
   */
  const runBackfill = useCallback(
    async (tableId: string, silent = false): Promise<void> => {
      if (backfillingRef.current) {
        /*
         * 已经有一轮在跑，就只记一个标记、等这一轮结束再补一轮。
         * 为什么不直接 return：正在跑的那一轮开始时就取好了「缺标签的页」名单，
         * 之后才加进来的页不在名单里 —— 直接丢弃会让刚加的页一直没有标签。
         */
        backfillQueuedRef.current = true
        return
      }
      backfillingRef.current = true
      setBackfilling(true)
      try {
        let total = 0
        do {
          backfillQueuedRef.current = false
          total += await backfill(tableId)
        } while (backfillQueuedRef.current)
        if (total > 0) toast.success(`已补齐 ${total} 页的类型标签 / 播出时间`)
        else if (!silent) toast.info('没有需要补齐的页面（标签和播出时间都齐了）')
      } finally {
        backfillingRef.current = false
        setBackfilling(false)
      }
    },
    [backfill]
  )

  const handleAdd = useCallback(
    (input: RecommendPageInput, title: string): void => {
      if (!table) return
      const r = addPage(table.id, input)
      if (!r.ok) {
        toast.warn(r.message)
        return
      }
      // 加完直接翻到新加的那一页：用户刚才选的就是它，不该还要自己翻过去
      setPageIndex(r.index)
      toast.success(`已加入《${title}》，这张表现在有 ${r.total} 页`)
      // silent：新加的页一定缺标签，success 提示已经说明了结果，不必再弹一次「已补齐 1 页」
      void runBackfill(table.id, true)
    },
    [addPage, runBackfill, table]
  )

  /**
   * 一次加多部（「收藏」标签页里勾选后批量加）。
   * store 只写一次盘（见 addPages），这里负责把结果如实说出来：已经在表里的会被跳过，
   * 必须告诉用户跳过了哪些 —— 否则他会以为"点了没反应"。
   */
  const handleAddMany = useCallback(
    (inputs: RecommendPageInput[], _titles: string[]): void => {
      if (!table) return
      const r = addPages(table.id, inputs)
      if (r.added === 0) {
        toast.warn(r.skipped.length > 0 ? `这些都已经在表里了：${r.skipped.join('、')}` : '没有可加入的作品')
        return
      }
      // 跳到新加的第一页（批量加进来后停在第 1 页最不容易迷路）
      setPageIndex(r.total - r.added)
      toast.success(
        `已加入 ${r.added} 部，这张表现在有 ${r.total} 页` +
          (r.skipped.length > 0 ? `；${r.skipped.length} 部已在表里，已跳过` : '')
      )
      void runBackfill(table.id, r.skipped.length === 0)
    },
    [addPages, runBackfill, table]
  )

  // ---------------- 右键当前页（画布） ----------------

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  /**
   * 待确认移除的这一页（右键菜单里选的，或编辑模式顶栏「移除这一页」点的）。
   * ⚠️ 必须声明在 `menuItems` **之前**：菜单项的回调里引用了 setter，
   * 而 `useMemo` 的工厂函数在渲染时就会跑 —— 声明在后面会踩到 TDZ（运行时报错）。
   */
  const [pendingRemovePage, setPendingRemovePage] = useState<RecommendPage | null>(null)

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu || !table || !currentPage) return []
    return [
      {
        key: 'edit',
        label: '编辑这一页（评分 / 指数 / 理由 / 剧照）',
        icon: <Pencil size={13} />,
        onSelect: () => setEditOpen(true)
      },
      {
        /*
         * 「自定义页面内容」= 进入编辑模式（v0.3.9）。
         * 它**只**切编辑模式，不顺手打开别的窗：背景 / 尺寸 / 框选 / 模块现在全在编辑模式的
         * 左右两列菜单里，再弹一个功能重叠的窗只会让用户分不清该用哪个。
         */
        key: 'custom',
        label: editMode ? '自定义页面内容（已在编辑模式）' : '自定义页面内容',
        icon: <Palette size={13} />,
        onSelect: () => {
          // 一次点击就把**左右两列**都呼出（两列由同一个 editPanels 条件控制，见它的注释）
          setEditMode(true)
          // 顺手清掉上一次的选中：进来时没有任何选中，右菜单的字体面板不会指向"上一页那一块"
          setSelected(null)
        }
      },
      {
        /*
         * v0.3.9 补充：用户要求把「只导出当前页」搬到**推荐页自己的右键菜单**里。
         *
         * 它与列表那张表右键菜单里的「导出为图片（多页 / 长图）」是同一个弹窗、
         * 只差**预选的范围**（current / long），所以不是两套功能。
         * 弹窗里仍然可以选清晰度（2 / 3 倍）与这次要出现哪些模块 —— 这两个选择必须留给用户，
         * 所以这一项是"打开导出（已选中当前页）"而不是"立刻导出一张固定倍率的图"。
         */
        key: 'export-page',
        label: '只导出这一页为图片（清晰度 2 / 3 倍）',
        icon: <ImageDown size={13} />,
        onSelect: () => openExport('current')
      },
      {
        key: 'backfill',
        label: '补齐类型标签 / 播出时间',
        icon: <Tags size={13} />,
        onSelect: () => void runBackfill(table.id)
      },
      {
        key: 'remove',
        label: '移除这一页',
        icon: <Trash2 size={13} />,
        danger: true,
        divider: true,
        onSelect: () => setPendingRemovePage(currentPage)
      }
    ]
  }, [menu, table, currentPage, editMode, runBackfill, openExport])

  const handleSavePage = useCallback(
    (patch: RecommendPagePatch): void => {
      if (!table || !currentPage) return
      updatePage(table.id, currentPage.id, patch)
      setEditOpen(false)
      toast.success('这一页已经保存')
    },
    [currentPage, table, updatePage]
  )

  // ---------------- 导出 ----------------

  const exportTable = useMemo(
    () => (exportTarget ? tables.find((t) => t.id === exportTarget.tableId) ?? null : null),
    [exportTarget, tables]
  )

  const runExport = useCallback(
    async (exportPages: RecommendPage[], scale: number, modules: ModuleKind[]): Promise<void> => {
      const t = exportTable
      if (!t) return
      if (exportPages.length === 0) {
        toast.warn('没有可导出的页面')
        return
      }
      if (modules.length === 0) {
        toast.warn('至少选一个模块再导出')
        return
      }
      // 双保险：弹窗里已经按 5 页卡过，这里再挡一次（将来别处调用也不会越过主进程的高度上限）
      if (exportPages.length > MAX_LONG_PAGES) {
        toast.warn(`长图最多拼 ${MAX_LONG_PAGES} 页`)
        return
      }
      setExporting(true)
      try {
        /*
         * 页码取「在整张表里的真实位置」：只导当前页时，图上的页脚仍然写「第 3 / 8 页」——
         * 写成「第 1 / 1 页」会让这张图失去上下文（用户往往是单页发出去）。
         */
        const pageNos = exportPages.map((p) => t.pages.findIndex((x) => x.id === p.id) + 1)
        const doc = buildExportDocument({
          pages: exportPages,
          pageNos,
          pageCount: t.pages.length,
          tableName: t.name,
          recommender,
          // 用户勾选的模块白名单：没勾的不画，但页面尺寸与其它模块的位置完全不变
          modules
        })
        const r = await api.tools.exportCardImage({
          title: EXPORT_TITLE,
          /*
           * 宽度 = **页面宽度**（手填尺寸优先，否则 1200）。
           * 离屏窗口按 `width × 清晰度` 开、并用 `setZoomFactor` 真正放大，
           * 所以**导出 PNG 的像素尺寸 = 页面尺寸 × 清晰度**，与预览的几何完全对得上。
           */
          width: doc.width,
          html: doc.html,
          images: doc.images,
          defaultName: t.name,
          scale
        })
        if (!r.ok) {
          toast.error(r.error)
          return
        }
        if (r.data.canceled) {
          // 用户主动取消保存：不是错误，用 info 级别的提示就好
          toast.info('已取消保存')
          return
        }
        const { width, height, images, path } = r.data
        if (images.missing.length > 0) {
          /*
           * 缺图必须如实说：主进程把取不到的图换成了透明占位，用户不被告知的话
           * 会以为「导出成功」但图上那几格是空的（统计工具当年就踩过这个坑）。
           */
          const head = images.missing
            .slice(0, 4)
            .map((m) => `${m.label}（${m.reason}）`)
            .join('；')
          toast.warn(
            `已导出 ${width}×${height}，但有 ${images.missing.length} 张图没取到：${head}${
              images.missing.length > 4 ? ' 等' : ''
            }`
          )
        } else {
          toast.success(`已导出 ${width}×${height} 的图片：${path}`)
        }
        setExportTarget(null)
      } catch (err) {
        toast.error(`导出失败：${String((err as Error)?.message ?? err)}`)
      } finally {
        setExporting(false)
      }
    },
    [recommender, exportTable]
  )

  // ---------------- 推荐人（列表右键菜单里的那一项） ----------------

  const [recOpen, setRecOpen] = useState(false)
  const [recDraft, setRecDraft] = useState(recommender)
  useEffect(() => {
    // 打开时把当前署名摊进草稿（与编辑面板同一个取舍：不进草稿就会"打开就写盘"）
    if (recOpen) setRecDraft(recommender)
  }, [recOpen, recommender])

  // ---------------- 渲染 ----------------

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    )
  }

  // ---------- 列表视图（v0.3.9 拆到 RecommendTableList：那张表的右键菜单在那里） ----------
  if (!table) {
    return (
      <>
        <RecommendTableList
          tables={tables}
          recommender={recommender}
          backfilling={backfilling}
          onOpen={(id) => {
            setOpenId(id)
            setPageIndex(0)
          }}
          onCreate={(name) => {
            const t = createTable(name)
            setOpenId(t.id)
            setPageIndex(0)
            toast.success(`已创建推荐表「${t.name}」，先搜索或从当季番剧里添加一部`)
          }}
          onRename={renameTable}
          onRemove={removeTable}
          onOpenRecommender={() => setRecOpen(true)}
          onBackfill={(id) => void runBackfill(id)}
          onExportTable={(t) => setExportTarget({ tableId: t.id, pageIndex: 0, mode: 'long' })}
        />
        <RecommenderModal
          open={recOpen}
          value={recDraft}
          onChange={setRecDraft}
          onClose={() => setRecOpen(false)}
          onSave={() => {
            setRecommender(recDraft)
            setRecOpen(false)
            toast.success(recDraft.trim() ? '已保存推荐人署名' : '已清空署名')
          }}
        />
        {exportTable ? (
          <ExportDialog
            open
            tableName={exportTable.name}
            pages={exportTable.pages}
            currentIndex={exportTarget?.pageIndex ?? 0}
            recommender={recommender}
            onRecommenderChange={setRecommender}
            exporting={exporting}
            onExport={(list, scale, mods) => void runExport(list, scale, mods)}
            onClose={() => setExportTarget(null)}
            initialMode={exportTarget?.mode ?? 'current'}
          />
        ) : null}
      </>
    )
  }

  // ---------- 编辑视图：一页一部，翻页阅览 ----------
  return (
    <div className="flex h-full min-h-0 flex-col px-4 py-3">
      {/* 顶栏：v0.3.9 只剩「添加作品」（推荐人 / 补齐标签 / 导出 / 改名都搬到了列表那张表的右键菜单） */}
      <div className="flex flex-wrap items-start gap-3">
        {/*
          「全部推荐表」**任何窗口尺寸下都要有**：
          它不是路由返回（那是列表页里那个「返回」按钮的事），而是本页内部的视图切换 ——
          在小型配置窗口里打开这个工具时，没有它用户就永远出不去编辑器、换不了表。
        */}
        <button
          onClick={() => {
            setOpenId(null)
            setEditMode(false)
          }}
          className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-xs text-dim transition-colors hover:text-text"
        >
          <ArrowLeft size={14} /> 全部推荐表
        </button>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-bold">{table.name}</h1>
            <Badge tone="neutral">{pages.length} 页</Badge>
            {editMode ? <Badge tone="accent">编辑模式</Badge> : null}
          </div>
          <p className="mt-0.5 text-xs text-faint">
            {editMode
              ? '左菜单改版面与模块，右菜单改页面尺寸 / 导出 / 字体字号；画布上的模块可以直接拖动。'
              : '一页一部番剧 · 右键当前页可以改推荐内容，或进入「自定义页面内容」编辑模式'}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/*
            「添加作品」是**唯一留在工具栏**的按钮（用户原话）。
            编辑模式下左列被编辑菜单占着，所以这个按钮改为"退出编辑并展开面板"——
            否则用户在编辑模式里就没有入口加作品了（不能留一个死路）。
          */}
          {editMode ? (
            <Button
              variant="soft"
              icon={BookOpen}
              onClick={() => {
                setEditMode(false)
                setPanelHidden(false)
              }}
            >
              添加作品
            </Button>
          ) : (
            <Button
              variant={panelHidden ? 'soft' : 'ghost'}
              icon={panelHidden ? PanelLeftOpen : PanelLeftClose}
              title={panelHidden ? '展开左侧「添加作品」面板' : '收起左侧「添加作品」面板'}
              onClick={() => setPanelHidden(!panelHidden)}
            >
              {panelHidden ? '添加作品' : '收起面板'}
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 gap-3 overflow-hidden">
        {/*
          左列：编辑模式 = 编辑菜单 Ⅰ–Ⅶ；翻阅模式 = 「添加作品」（可收起，偏好落盘）。
          两者不同时出现 —— 编辑模式要做的是"改这一页的样子"，加作品是另一件事。

          ⚠️ 左列的显示条件与右列**共用 `editPanels`**（见它的注释）：用户要求
          「自定义页面内容时左右两侧菜单同时呼出」，所以只要在编辑模式，两列一起出现。
        */}
        {editPanels && editCtx ? (
          <aside
            data-edit-panel="left"
            className={`flex min-h-0 flex-col rounded-xl border border-border bg-elev1/50 p-2 ${EDIT_COL}`}
          >
            <EditLeftPanel ctx={editCtx} />
          </aside>
        ) : panelHidden ? null : (
          /*
           * V1.5.2 修：这里以前多了一个 `pages.length === 0 || !currentPage` 的条件 ——
           * 于是**刚新建的空表**左侧「添加作品」面板根本不渲染，用户点「添加作品」
           * 只能看到按钮状态变化、没有任何面板出现（"不弹出添加作品的面板"）。
           * 添加面板恰恰是空表唯一需要的东西，条件只保留 `panelHidden`（用户手动收起）。
           */
          <aside className="flex min-h-0 w-[330px] shrink-0 flex-col rounded-xl border border-border bg-elev1/50 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-dim">
              <BookOpen size={13} />
              添加作品
              <button
                type="button"
                title="收起这个面板（把窗口让给推荐卡）"
                onClick={() => setPanelHidden(true)}
                className="ml-auto rounded-md p-0.5 text-faint transition-colors hover:text-text"
              >
                <PanelLeftClose size={14} />
              </button>
            </div>
            <SubjectPicker addedIds={addedIds} onAdd={handleAdd} onAddMany={handleAddMany} />
          </aside>
        )}

        {/*
          中：当前页的画布 + 翻页。
          `min-w-0` 必须写：flex 子项的默认 `min-width: auto` 会让它按内容的**最小宽度**撑着，
          窗口一窄就把右边那列编辑菜单顶出可视区（用户看到的就是"只出了一侧"）。
          画布本身会等比缩小（FittedRecommendCard），所以它可以被压得很窄而不坏版式。
        */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {pages.length === 0 || !currentPage ? (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-border bg-elev1/40">
              <EmptyState
                icon={Star}
                title="这张表还没有内容"
                desc="先搜索或从当季番剧里添加一部 —— 左边面板加进来的作品就是这张表里的一页。"
              />
            </div>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  icon={ChevronLeft}
                  disabled={pageIndex === 0}
                  onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
                >
                  上一页
                </Button>
                <span className="text-xs tabular-nums text-dim">
                  第 {pageIndex + 1} / {pages.length} 页
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pageIndex >= pages.length - 1}
                  onClick={() => setPageIndex((i) => Math.min(pages.length - 1, i + 1))}
                >
                  下一页
                  <ChevronRight size={13} />
                </Button>
                {/* 页数多了之后一页页翻太慢：给一个直接跳转的下拉 */}
                <Select
                  value={pageIndex}
                  className="ml-2 max-w-[220px]"
                  onChange={(e) => setPageIndex(Number(e.target.value))}
                >
                  {pages.map((p, i) => (
                    <option key={p.id} value={i}>
                      {i + 1}. {displayName(p)}
                    </option>
                  ))}
                </Select>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {/*
                    编辑模式（v0.3.9）：画布上方**只剩这两件事** —— 退出并保存 / 移除这一页。
                    所有"设置页面"的入口都在左右菜单里；翻阅模式下这几个入口在画布右键菜单里。
                  */}
                  {editMode ? (
                    <>
                      <Button size="sm" variant="primary" icon={Check} onClick={() => setEditMode(false)}>
                        退出并保存
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Trash2}
                        onClick={() => setPendingRemovePage(currentPage)}
                      >
                        移除这一页
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={Palette}
                      onClick={() => setEditMode(true)}
                    >
                      自定义页面内容
                    </Button>
                  )}
                </div>
              </div>

              {/*
                预览：整页**完整落在可视区里**（FittedRecommendCard 同时按宽高缩放），所以不会出现滚动条。
                页面尺寸（手填优先）与"图区 / 内容区"的划分由 styles.frameOf 决定；
                模块位置由 moduleRectsOf(frame, page.layout) 现算 —— 界面与导出用的是同一份几何。
                右键绑在卡片本体上（点空白处不该弹菜单）；编辑模式下多一层拖动叠层。
              */}
              <div className="flex min-h-0 flex-1 flex-col rounded-xl" style={sheetStyle}>
                <FittedRecommendCard
                  className="min-h-0 flex-1"
                  page={currentPage}
                  pageNo={pageIndex + 1}
                  pageCount={pages.length}
                  tableName={table.name}
                  recommender={recommender}
                  onContextMenu={(e) => {
                    if (!currentPage) return
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY })
                  }}
                  overlay={
                    // 叠层与左右菜单**共用同一个 `editPanels`**：不会出现"菜单开了但拖不动"的错位
                    editPanels && editCtx
                      ? (scale) => (
                          <ModuleDragLayer
                            frame={editCtx.frame}
                            rects={editCtx.rects}
                            ids={drawnIds}
                            selected={selected}
                            scale={scale}
                            onSelect={setSelected}
                            onRect={(id: ModuleKind, r: ModuleRect) =>
                              setModuleRect(table.id, currentPage.id, id, r)
                            }
                          />
                        )
                      : undefined
                  }
                />
              </div>
            </>
          )}
        </section>

        {/*
          右列：编辑模式的页面尺寸 / 导出 / 字体字号。
          与左列**共用 `editPanels`**，所以"左右同时呼出"是结构保证的（不存在只出一侧）。
        */}
        {editPanels && editCtx ? (
          <aside
            data-edit-panel="right"
            className={`flex min-h-0 flex-col rounded-xl border border-border bg-elev1/50 p-2 ${EDIT_COL}`}
          >
            <EditRightPanel ctx={editCtx} />
          </aside>
        ) : null}
      </div>

      {/* 右键菜单（复用统计工具的通用组件：自己处理点外面 / Esc / 滚动时关闭） */}
      <ContextMenu open={menu != null} x={menu?.x ?? 0} y={menu?.y ?? 0} items={menuItems} onClose={() => setMenu(null)} />

      {/* 编辑当前页（用户需求 6 的「可编辑面板」） */}
      <PageEditDialog
        open={editOpen}
        page={currentPage}
        onClose={() => setEditOpen(false)}
        onSave={handleSavePage}
      />

      {/* 导出（画布右键「只导出这一页」/ 编辑模式右菜单 Ⅱ / 列表右键）：范围与清晰度都在弹窗里 */}
      {exportTable ? (
        <ExportDialog
          open
          tableName={exportTable.name}
          pages={exportTable.pages}
          currentIndex={exportTarget?.pageIndex ?? 0}
          recommender={recommender}
          onRecommenderChange={setRecommender}
          exporting={exporting}
          onExport={(list, scale, mods) => void runExport(list, scale, mods)}
          onClose={() => setExportTarget(null)}
          initialMode={exportTarget?.mode ?? 'current'}
        />
      ) : null}

      <ConfirmModal
        open={pendingRemovePage != null}
        title="移除这一页？"
        danger
        confirmText="移除"
        message={
          <>
            将把《{pendingRemovePage ? displayName(pendingRemovePage) : ''}》这一页（含推荐理由与剧照）从
            「{table.name}」里删掉。番剧本身与 bangumi 数据不受影响。
          </>
        }
        onConfirm={() => {
          if (pendingRemovePage) {
            removePage(table.id, pendingRemovePage.id)
            toast.success('已移除这一页')
          }
        }}
        onClose={() => setPendingRemovePage(null)}
      />
    </div>
  )
}

/**
 * 「输入推荐人」弹窗（v0.3.9：入口搬到了列表那张表的右键菜单）。
 *
 * 用**草稿 + 保存**而不是边打边写 store：从右键菜单点进来时用户往往是想"看一眼现在是什么"，
 * 边打边写会让"打开弹窗 → 算了不改 → 关掉"也写一次盘（而署名会印在导出图上）。
 */
function RecommenderModal({
  open,
  value,
  onChange,
  onSave,
  onClose
}: {
  open: boolean
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onClose: () => void
}) {
  return (
    <Modal open={open} onClose={onClose} title="输入推荐人（导出署名）" width={420}>
      <div className="flex items-center gap-2">
        <UserRound size={15} className="shrink-0 text-faint" />
        <Input
          value={value}
          placeholder="留空则不显示署名"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave()
          }}
        />
      </div>
      <div className="mt-2 text-[10px] leading-relaxed text-faint">
        填了才会出现在每一页「番剧名」下方的署名行里（界面预览与导出图都会显示）。
        这是**整张表统一**的署名，不是某一页的。
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button onClick={onSave}>保存</Button>
      </div>
    </Modal>
  )
}

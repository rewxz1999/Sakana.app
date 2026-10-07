import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ImageDown,
  LayoutGrid,
  Move,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Tags,
  Trash2
} from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import {
  MAX_LONG_PAGES,
  useRecommendTable,
  type ModuleKind,
  type RecommendPage,
  type RecommendPageInput,
  type RecommendPagePatch,
  type RecommendTable
} from '@/stores/recommendTable'
import { Badge, Button, ConfirmModal, EmptyState, Input, Modal, Select, Spinner } from '@/components/ui'
import { CoverImage } from '@/components/CoverImage'
import { ContextMenu, type ContextMenuItem } from '@/components/stat/ContextMenu'
import { FittedRecommendCard } from '@/components/recommend/RecommendPageCard'
import { SubjectPicker } from '@/components/recommend/SubjectPicker'
import { PageEditDialog } from '@/components/recommend/PageEditDialog'
import { BackgroundDialog } from '@/components/recommend/BackgroundDialog'
import { ModuleLayoutDialog } from '@/components/recommend/ModuleLayoutDialog'
import { ExportDialog } from '@/components/recommend/ExportDialog'
import { buildExportDocument } from '@/components/recommend/exportHtml'
import { backgroundKindText, displayName, sheetStyle } from '@/components/recommend/styles'

/**
 * 「番剧推荐表」工具页（路由 `/tools/recommend-table`，v0.3.7 用户需求）。
 *
 * ## 这个工具做什么
 *
 * 建一张自己的番剧推荐表（表名自定义）→ 搜索或从**当季番剧**里挑作品加进来（一页一部）→
 * 翻页阅览每一页的推荐卡（封面 / bangumi 评分 / 推荐人评分 / 推荐指数 / 播出时间 / 类型标签 /
 * 推荐理由 / 剧照）→ 右键当前页编推荐内容 → 导出成高清 PNG
 * （只导当前页，或把多页拼成一张长图，长图最多 5 页，可写推荐人，保存位置自选）。
 *
 * ## 数据怎么存
 *
 * 全在 `stores/recommendTable.ts`：命名空间 `sakana-recommend`，挂载时整份读 → 收窄 → 每次改动整份写回。
 * 本页只做三件事：把 store 的状态画出来、把用户的动作转成 store 调用、把导出参数拼成 HTML。
 *
 * ## 导出怎么拼
 *
 * `components/recommend/exportHtml.ts` 按「与界面同一套版式常量」拼一个完整 HTML 文档，
 * 图片位置写 `{{img:key}}` 占位符，主进程负责取图 → 替换 → 离屏渲染 → 弹保存框。
 * 长图不是我们自己拼图片：把 N 页的版式依次放进同一个文档（页间用虚线分隔）一次导出即可。
 *
 * ## 界面版式与导出图一致
 *
 * 预览用的是 `RecommendPageCard`（同一套 `styles.ts` 常量），导出用的是 `exportHtml`（同一套常量），
 * 所以用户看到的卡片就是导出图上的卡片 —— 预览按容器**等比缩放**（宽高都塞得下，
 * 见 FittedRecommendCard），而不是自适应重排（重排会让小窗口里的版式和导出图不一样）。
 *
 * ============================ v0.3.8「推荐页自由布局」（用户实测后又提的一轮） ============================
 *
 * ① **背景图决定页面尺寸**：设了图片背景后，页面比例 = 背景图比例（宽仍固定 1200，
 *    高按比例算，见 `styles.pageHeightOf`），预览继续等比缩放把整页塞进窗口。
 * ② **模块化 + 自由拖动**：页面拆成 8 个模块（`MODULE_KINDS`），各有默认摆放（不改就是原来那套版式），
 *    可以拖到任意位置、右下角把手改大小；坐标按页存（`page.layout`），老数据靠 `resolveModules` 回落。
 * ③ **背景模糊 + 叠加渐变**：背景层可 `blur()`，其上可再叠一层带透明度的渐变（`background.blur/overlay`）。
 * ④ **导出可勾选模块**：导出弹窗里逐块勾选；导出宽度固定 = 页面宽度（不再按内容收窄）。
 *
 * 模块名与坐标系的说明在 store 的 `ModuleRect` / `ModuleKind` 注释里，
 * 「拖动坐标在缩放预览下为什么不会错位」在 `RecommendPageCard` 文件头与 `styles.toPagePx` 上。
 *

/** 导出保存对话框的标题（主进程直接显示它，所以写死一处，别在几个地方各拼一遍） */
const EXPORT_TITLE = '导出推荐表为图片'

export function RecommendTablePage() {
  const navigate = useNavigate()

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
  const resetModules = useRecommendTable((s) => s.resetModules)
  const applyBackground = useRecommendTable((s) => s.applyBackground)
  const backfill = useRecommendTable((s) => s.backfill)
  /** 左侧「添加作品」面板是否收起（偏好，落盘记住；用户要能隐藏它把窗口让给推荐卡） */
  const panelHidden = useRecommendTable((s) => s.panelHidden)
  const setPanelHidden = useRecommendTable((s) => s.setPanelHidden)

  const [openId, setOpenId] = useState<string | null>(null)
  const table = useMemo(() => tables.find((t) => t.id === openId) ?? null, [tables, openId])
  // useMemo 而不是 `?? []`：每次渲染新建一个空数组会让下面所有依赖 pages 的 memo/effect 白跑
  const pages = useMemo(() => table?.pages ?? [], [table])

  // ---- 列表视图 ----
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  /** 待确认删除的表（删除是不可撤销的：整张表连同每一页的推荐理由/剧照一起没） */
  const [pendingDelete, setPendingDelete] = useState<RecommendTable | null>(null)

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

  /*
   * 版式宽度是**固定值**（`styles.RL.width` = 1200），不再"按内容收紧"：
   * v0.3.8 用户明确要求「导出图片的最大宽度 = 推荐页宽度，不要再按内容另外收窄」。
   * 页面高度由背景图的比例决定（`styles.pageHeightOf`），卡片自己会算，页面这边不用管。
   */

  /**
   * v0.3.8 第三轮：模块**只剩显示 / 隐藏**（用户取消了自定义移动），
   * 所以这里只要一个「显示哪些模块」面板的开关 —— 拖动模式与选中态整条撤掉。
   */
  const [layoutOpen, setLayoutOpen] = useState(false)

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
         *
         * 为什么不直接 return：正在跑的那一轮开始时就取好了「缺标签的页」名单，
         * 之后才加进来的页不在名单里 —— 直接丢弃会让刚加的页一直没有标签，
         * 而用户看到的只是「标签没出来」，根本不知道要再点一次「补齐标签」。
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
   *
   * store 只写一次盘（见 addPages），这里负责把结果如实说出来：
   * 已经在表里的会被跳过，必须告诉用户跳过了哪些 —— 否则他会以为"点了没反应"。
   */
  const handleAddMany = useCallback(
    (inputs: RecommendPageInput[], titles: string[]): void => {
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
      // 收藏自带类型标签，但补一次也无害（缺播出时间的那些会被补上），保持与单个添加一致的体验
      void runBackfill(table.id, r.skipped.length === 0)
    },
    [addPages, runBackfill, table]
  )

  // ---------------- 右键当前页 ----------------

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [bgOpen, setBgOpen] = useState(false)
  /**
   * 待确认移除的这一页（右键菜单里选的，或工具栏「移除」按钮点的）。
   *
   * ⚠️ 必须声明在 `menuItems` **之前**：菜单项的回调里引用了 setter，
   * 而 `useMemo` 的工厂函数在渲染时就会执行 —— 声明在后面会踩到 TDZ（运行时报错）。
   */
  const [pendingRemovePage, setPendingRemovePage] = useState<RecommendPage | null>(null)

  const openCardMenu = (e: React.MouseEvent): void => {
    if (!currentPage) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

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
        key: 'modules',
        label: '显示哪些模块（隐藏 / 恢复）',
        icon: <LayoutGrid size={13} />,
        onSelect: () => setLayoutOpen(true)
      },
      {
        // 标签直接写出当前状态（「背景：图片（左侧图区 · 模糊 8px）」）
        key: 'background',
        label: `背景：${backgroundKindText(currentPage.background)}（点这里改）`,
        icon: <Palette size={13} />,
        onSelect: () => setBgOpen(true)
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
  }, [menu, table, currentPage, runBackfill])

  /** 显示 / 隐藏一块（v0.3.8 第三轮之后，模块面板唯一的写操作） */
  const handleModuleToggle = useCallback(
    (id: ModuleKind, visible: boolean): void => {
      if (!table || !currentPage) return
      setModuleVisible(table.id, currentPage.id, id, visible)
    },
    [currentPage, table, setModuleVisible]
  )

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

  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const runExport = useCallback(
    async (exportPages: RecommendPage[], scale: number, modules: ModuleKind[]): Promise<void> => {
      if (!table) return
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
        const pageNos = exportPages.map((p) => table.pages.findIndex((x) => x.id === p.id) + 1)
        const doc = buildExportDocument({
          pages: exportPages,
          pageNos,
          pageCount: table.pages.length,
          tableName: table.name,
          recommender,
          // 用户勾选的模块白名单：没勾的不画，但页面尺寸与其它模块的位置完全不变
          modules
        })
        const r = await api.tools.exportCardImage({
          title: EXPORT_TITLE,
          /*
           * 宽度 = **页面宽度**（固定 1200，见 styles.RL.width）。
           * v0.3.8 用户明确要求「导出图片的最大宽度 = 推荐页宽度，不要再按内容另外收窄」，
           * 所以这里直接取文档算出来的宽度（它内部就是 RL.width），
           * 与页面里模块的坐标系完全一致 —— 也就不会出现「内容只占左边一块」。
           */
          width: doc.width,
          html: doc.html,
          images: doc.images,
          defaultName: table.name,
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
        setExportOpen(false)
      } catch (err) {
        toast.error(`导出失败：${String((err as Error)?.message ?? err)}`)
      } finally {
        setExporting(false)
      }
    },
    [recommender, table]
  )
  // ---------------- 渲染 ----------------

  /**
   * 新建推荐表（回车与按钮两处共用）。
   *
   * 建完直接进入这张表：用户此刻的下一步必然是「往里加作品」，
   * 停在列表页还要自己再点一次「打开」。
   */
  const handleCreate = (): void => {
    if (!newName.trim()) {
      toast.warn('先给这张推荐表起个名字')
      return
    }
    const t = createTable(newName)
    setNewName('')
    setOpenId(t.id)
    setPageIndex(0)
    toast.success(`已创建推荐表「${t.name}」，先搜索或从当季番剧里添加一部`)
  }

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    )
  }

  // ---------- 列表视图：新建 / 打开 / 重命名 / 删除 ----------
  if (!table) {
    return (
      <div className="h-full overflow-y-auto px-6 py-5">
        {!api.window.isSmallWindow ? (
          <button
            onClick={() => navigate(-1)}
            className="mb-2 flex items-center gap-1.5 text-xs text-dim transition-colors hover:text-text"
          >
            <ArrowLeft size={14} /> 返回
          </button>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold">番剧推荐表</h1>
              <Badge tone="accent">工具</Badge>
            </div>
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-faint">
              建一张自己的推荐表（表名自定）→ 搜索或从当季番剧里挑作品（一页一部）→
              翻页阅览每页的推荐卡 → 导出成图片（只导当前页，或把最多 {MAX_LONG_PAGES} 页拼成一张长图）。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newName}
              placeholder="推荐表名字，例如 2026 春番推荐"
              className="w-56"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
              }}
            />
            <Button icon={Plus} onClick={handleCreate}>
              新建推荐表
            </Button>
          </div>
        </div>

        {tables.length === 0 ? (
          <EmptyState
            icon={Star}
            title="还没有推荐表"
            desc="在上面输入一个表名（例如「2026 春番推荐」）点「新建推荐表」。建好后，左边搜索或选当季番剧加作品，一页放一部。"
          />
        ) : (
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {tables.map((t) => (
              <div
                key={t.id}
                className="flex flex-col gap-3 rounded-xl border border-border bg-elev1 p-3.5 transition-colors hover:border-accent/60"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    onClick={() => {
                      setOpenId(t.id)
                      setPageIndex(0)
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-sm font-semibold">{t.name}</div>
                    <div className="mt-0.5 text-[11px] text-faint">
                      {t.pages.length} 页 · 建于 {new Date(t.createdAt).toLocaleDateString()}
                    </div>
                  </button>
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => {
                      setOpenId(t.id)
                      setPageIndex(0)
                    }}
                  >
                    打开
                  </Button>
                </div>
                {/* 表头缩略图：一眼看出这张表里是哪几部番（前 4 张 + 其余张数） */}
                <div className="flex gap-1.5">
                  {t.pages.slice(0, 4).map((p) => (
                    <CoverImage
                      key={p.id}
                      src={p.cover}
                      alt={displayName(p)}
                      className="h-16 w-11"
                      rounded="rounded-md"
                    />
                  ))}
                  {t.pages.length === 0 ? (
                    <div className="flex h-16 flex-1 items-center justify-center rounded-md border border-dashed border-border text-[10px] text-faint">
                      还是一张空表
                    </div>
                  ) : null}
                  {t.pages.length > 4 ? (
                    <div className="flex h-16 w-11 items-center justify-center rounded-md bg-elev2 text-[11px] text-faint">
                      +{t.pages.length - 4}
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRenaming({ id: t.id, name: t.name })}>
                    重命名
                  </Button>
                  <Button size="sm" variant="danger" icon={Trash2} onClick={() => setPendingDelete(t)}>
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 重命名 */}
        <Modal open={renaming != null} onClose={() => setRenaming(null)} title="重命名推荐表" width={420}>
          <Input
            value={renaming?.name ?? ''}
            onChange={(e) => setRenaming((cur) => (cur ? { ...cur, name: e.target.value } : cur))}
          />
          <div className="mt-2 text-[10px] leading-relaxed text-faint">
            表名会印在导出图的页脚上，方便别人知道这是哪一张表。
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button
              disabled={!renaming?.name.trim()}
              onClick={() => {
                if (!renaming) return
                renameTable(renaming.id, renaming.name)
                setRenaming(null)
                toast.success('已重命名')
              }}
            >
              保存
            </Button>
          </div>
        </Modal>

        <ConfirmModal
          open={pendingDelete != null}
          title="删除这张推荐表？"
          danger
          confirmText="删除"
          message={
            <>
              将删除「{pendingDelete?.name}」以及里面的 {pendingDelete?.pages.length ?? 0} 页推荐内容
              （评分、推荐指数、推荐理由、剧照）。<br />
              这个操作不能撤销。
            </>
          }
          onConfirm={() => {
            if (pendingDelete) {
              removeTable(pendingDelete.id)
              toast.success('已删除')
            }
          }}
          onClose={() => setPendingDelete(null)}
        />
      </div>
    )
  }

  // ---------- 编辑视图：一页一部，翻页阅览 ----------
  return (
    <div className="flex h-full min-h-0 flex-col px-4 py-3">
      {/* 顶栏 */}
      <div className="flex flex-wrap items-start gap-3">
        {/*
          「全部推荐表」**任何窗口尺寸下都要有**：
          它不是路由返回（那是列表页里那个「返回」按钮的事），而是本页内部的视图切换 ——
          在小型配置窗口里打开这个工具时，没有它用户就永远出不去编辑器、换不了表。
        */}
        <button
          onClick={() => setOpenId(null)}
          className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-xs text-dim transition-colors hover:text-text"
        >
          <ArrowLeft size={14} /> 全部推荐表
        </button>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-bold">{table.name}</h1>
            <Badge tone="neutral">{pages.length} 页</Badge>
            <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRenaming({ id: table.id, name: table.name })}>
              改名
            </Button>
          </div>
          <p className="mt-0.5 text-xs text-faint">
            一页一部番剧 · 右键当前页可以改推荐人评分 / 推荐指数 / 推荐理由 / 剧照
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/*
            面板收起后必须留一个"打开"的入口：否则用户收起面板又清空了表，
            就再也加不进作品了（工具栏是唯一常驻的地方）。
          */}
          <Button
            variant={panelHidden ? 'soft' : 'ghost'}
            icon={panelHidden ? PanelLeftOpen : PanelLeftClose}
            title={panelHidden ? '展开左侧「添加作品」面板' : '收起左侧「添加作品」面板'}
            onClick={() => setPanelHidden(!panelHidden)}
          >
            {panelHidden ? '添加作品' : '收起面板'}
          </Button>
          {/*
            推荐人输入框**边打边写 store**（不是失焦才提交）：这个名字会实时出现在预览卡的番剧名下方，
            用户是在「看着卡片调署名」，延迟提交会让预览落后于输入。
            代价是每敲一个字写一次盘 —— 这份数据很小（几张表、几十页的纯文本），
            而 api.store.set 是本地原子写，实测无感；换来的所见即所得更值。
          */}
          <Input
            value={recommender}
            placeholder="推荐人（导出署名）"
            className="w-44"
            title="填了才会出现在导出图的番剧名下方"
            onChange={(e) => setRecommender(e.target.value)}
          />
          <Button
            variant="outline"
            icon={RefreshCw}
            loading={backfilling}
            disabled={pages.length === 0}
            onClick={() => void runBackfill(table.id)}
          >
            补齐标签
          </Button>
          <Button
            variant="soft"
            icon={ImageDown}
            disabled={pages.length === 0}
            onClick={() => setExportOpen(true)}
          >
            导出图片
          </Button>
        </div>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 gap-3">
        {/*
          左：添加作品（搜索 / 当季 / 收藏）。
          v0.3.7 追加需求 2：面板可以整体收起来，让推荐卡占到几乎整屏宽度 ——
          收起状态存在 store 里（偏好，重启后仍是收起的），收起后靠工具栏那个按钮再打开。
        */}
        {panelHidden ? null : (
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

        {/* 右：当前页的预览 + 翻页 */}
        <section className="flex min-h-0 flex-1 flex-col">
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
                <div className="ml-auto flex items-center gap-2">
                  {/* 模块只剩「显示 / 隐藏」（v0.3.8 第三轮取消了自定义移动） */}
                  <Button size="sm" variant="ghost" icon={LayoutGrid} onClick={() => setLayoutOpen(true)}>
                    模块
                  </Button>
                  <Button size="sm" variant="ghost" icon={Palette} onClick={() => setBgOpen(true)}>
                    背景
                  </Button>
                  <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditOpen(true)}>
                    编辑这一页
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={Trash2}
                    onClick={() => setPendingRemovePage(currentPage)}
                  >
                    移除
                  </Button>
                </div>
              </div>

              {/*
                预览：整页**完整落在可视区里**（FittedRecommendCard 同时按宽高缩放），所以不会出现滚动条。
                页面宽度固定 1200，高度与"图区 / 内容区"的划分由 styles.frameOf 决定；
                模块位置也由版式现算（moduleRectsOf），界面与导出用的是同一份几何。
                右键绑在卡片本体上（点空白处不该弹菜单）。
              */}
              <div className="flex min-h-0 flex-1 flex-col rounded-xl" style={sheetStyle}>
                <FittedRecommendCard
                  className="min-h-0 flex-1"
                  page={currentPage}
                  pageNo={pageIndex + 1}
                  pageCount={pages.length}
                  tableName={table.name}
                  recommender={recommender}
                  onContextMenu={openCardMenu}
                />
              </div>
            </>
          )}
        </section>
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

      {/* 背景 / 页面尺寸 / 背景图取景框（v0.3.8 第四轮：尺寸与框选都按页保存） */}
      <BackgroundDialog
        open={bgOpen}
        page={currentPage}
        onClose={() => setBgOpen(false)}
        onApply={(bg, size, crop) => {
          if (!currentPage) return
          /*
           * 三样一起写回：背景（含取景框 crop）、页面尺寸（size=null 表示回到跟随内容自适应）。
           * 取景框挂在背景上（`bg.crop`），所以「取景」只在图片背景里存在 ——
           * 换成纯色/渐变时弹窗那边会把它置为 null，不留一份不生效的设置。
           */
          updatePage(table.id, currentPage.id, {
            background: bg ? { ...bg, crop } : undefined,
            size: size ?? undefined
          })
          toast.success(
            bg
              ? `已保存这一页的背景${size ? `（页面 ${size.w}×${size.h}）` : '（尺寸跟随内容）'}`
              : '这一页已恢复白底'
          )
        }}
        onApplyAll={(bg) => {
          const n = applyBackground(table.id, bg ?? null)
          toast.success(bg ? `已把背景应用到全部 ${n} 页` : `已把全部 ${n} 页恢复成白底`)
        }}
      />

      {/* 显示哪些模块（v0.3.8 第三轮：只剩显示 / 隐藏 + 全部显示） */}
      <ModuleLayoutDialog
        open={layoutOpen}
        page={currentPage}
        onToggle={handleModuleToggle}
        onReset={() => {
          if (!currentPage) return
          resetModules(table.id, currentPage.id)
        }}
        onClose={() => setLayoutOpen(false)}
      />

      {/* 导出（当前页 / 长图 + 模块勾选 + 推荐人 + 清晰度） */}
      <ExportDialog
        open={exportOpen}
        tableName={table.name}
        pages={pages}
        currentIndex={pageIndex}
        recommender={recommender}
        onRecommenderChange={setRecommender}
        exporting={exporting}
        onExport={(list, scale, mods) => void runExport(list, scale, mods)}
        onClose={() => setExportOpen(false)}
      />

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

      {/* 编辑视图里也要能重命名表（顶栏的「改名」按钮指向它） */}
      <Modal open={renaming != null} onClose={() => setRenaming(null)} title="重命名推荐表" width={420}>
        <Input
          value={renaming?.name ?? ''}
          onChange={(e) => setRenaming((cur) => (cur ? { ...cur, name: e.target.value } : cur))}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRenaming(null)}>
            取消
          </Button>
          <Button
            disabled={!renaming?.name.trim()}
            onClick={() => {
              if (!renaming) return
              renameTable(renaming.id, renaming.name)
              setRenaming(null)
              toast.success('已重命名')
            }}
          >
            保存
          </Button>
        </div>
      </Modal>
    </div>
  )
}

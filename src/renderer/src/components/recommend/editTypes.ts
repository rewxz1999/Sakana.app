import type {
  ModuleFontKey,
  ModuleKind,
  ModuleRect,
  ModuleRectPatch,
  RecommendPage,
  RecommendPagePatch,
  RecommendTable
} from '@/stores/recommendTable'
import type { PageFrame } from './styles'

/**
 * 编辑模式（v0.3.9）左右菜单与画布的**共同上下文**。
 *
 * 为什么把这么多回调打成**一个对象**往下传，而不是给每个面板摊开十几个 props：
 *   · 左右两个面板、画布拖动叠层、右菜单的导出，全都在改**同一页的同一份数据**；
 *   · 摊开之后每个面板的 props 列表都有十几项，加一个功能要改四个文件的签名，
 *     而且很容易出现"左边面板改了 A，右边面板还在用旧的回调"这种漂移。
 * 这里只规定"能做什么"，具体实现全在 `RecommendTablePage` 里一处（它才是 store 的调用方）。
 *
 * `patch` / `patchAll` 的差别就是"只改这一页"与"应用到所有页"——
 * 左菜单顶部那个开关决定当前是哪一个（用户原话里两条路都要有）。
 */
export interface EditCtx {
  table: RecommendTable
  page: RecommendPage
  /** 这一页算出来的页面框（图区 / 内容区 / 页面尺寸）——左右菜单里显示的数字都用它 */
  frame: PageFrame
  /** 这一页每个模块的矩形（已经叠过用户坐标），拖动叠层与坐标输入框共用 */
  rects: Record<ModuleKind, ModuleRect>
  /** 当前选中的模块（右菜单 Ⅲ 与左菜单 Ⅲ/Ⅶ 都作用于它） */
  selected: ModuleKind | null
  setSelected: (id: ModuleKind | null) => void
  /** 只改这一页 */
  patch: (p: RecommendPagePatch) => void
  /** 把同样的改动应用到这张表的**所有页** */
  patchAll: (p: RecommendPagePatch) => void
  setModuleVisible: (id: ModuleKind, visible: boolean) => void
  /** `rect = null` = 这一块回到版式默认位置 */
  setModuleRect: (id: ModuleKind, rect: ModuleRectPatch | null) => void
  setModuleFont: (
    id: ModuleKind,
    patch: { fontSize?: number | null; fontFamily?: ModuleFontKey | null }
  ) => void
  /** 所有模块的摆放回到版式默认（字体与显隐保留） */
  resetRects: () => void
  /** 模块全部显示（清掉整份 layout） */
  resetModules: () => void
  /** 打开导出弹窗（右菜单 Ⅱ） */
  openExport: () => void
  /** 导出是否正在进行（按钮显示 loading） */
  exporting: boolean
}

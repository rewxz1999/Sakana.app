/**
 * /galgame 路由入口（App.tsx 仍从这里取 GalgamePage）。
 *
 * 用户的这一轮改版把这一页拆成了两块：
 * - `GalgameLibraryPage`：新的「galgame 库」卡片网格（默认视图）
 * - `GalgameImmersivePage`：原「galgame 导航」的整屏壁纸布局，由库页的「沉浸模式」挂载
 *
 * 这里只做路由适配，避免为了改名去动 App.tsx（其它 agent 正在改同一批文件）。
 */
export { GalgameLibraryPage as GalgamePage } from './GalgameLibraryPage'

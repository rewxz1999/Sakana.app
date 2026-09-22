import { create } from 'zustand'

/**
 * 应用外壳（TitleBar 之下那块「左侧导航栏 + 主区域」）的共享状态。
 *
 * 为什么要有这个 store：
 * 「沉浸模式」是 galgame 页内部的视图状态，而**左侧导航栏是 App.tsx 渲染的外壳**，
 * 页面没法直接让外壳把导航栏收起来。跨层通信这里不用 window 事件：
 * 事件要手动 add/removeEventListener，组件卸载漏解绑就会残留监听，
 * 而且「页面挂载」与「外壳监听」的先后顺序决定了会不会漏掉第一次广播，
 * 时序上很难保证。zustand 就是一份普通状态：页面写、外壳订阅，
 * 挂载/卸载天然跟着 React 生命周期走，不存在漏解绑。
 *
 * 只被渲染层消费（不进设置、不下发主进程）：沉浸模式是纯粹的界面形态，
 * 重启后回到普通卡片库是符合预期的。
 */
interface ShellState {
  /** 沉浸模式：页面内容铺满整窗（含原导航栏那一列），左侧导航栏让位 */
  immersive: boolean
  setImmersive: (v: boolean) => void
}

export const useShell = create<ShellState>((set) => ({
  immersive: false,
  setImmersive: (v) => set({ immersive: v })
}))

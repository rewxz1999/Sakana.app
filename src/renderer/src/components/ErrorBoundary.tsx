import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * 渲染层错误边界：任何页面抛错时显示错误信息而不是空白窗口，
 * 避免"点开某个窗口一片空白却没有任何提示"的情况。
 */
interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-6 text-center">
        <div className="text-sm font-semibold text-danger">页面渲染出错</div>
        <div className="max-h-40 max-w-lg selectable overflow-auto rounded-lg bg-elev2 p-3 text-left text-[11px] leading-relaxed text-dim">
          {String(error.message || error)}
        </div>
        <button
          onClick={() => this.setState({ error: null })}
          className="rounded-lg border border-border bg-elev1 px-3 py-1.5 text-xs text-dim transition-colors hover:border-accent hover:text-accent whitespace-nowrap"
        >
          重试
        </button>
      </div>
    )
  }
}

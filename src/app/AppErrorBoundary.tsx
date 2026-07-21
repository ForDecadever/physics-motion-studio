import { Component, type ErrorInfo, type ReactNode } from 'react'

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  error: Error | null
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Motion Studio 遇到未恢复的界面错误。', error, info)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="fatal-error">
          <div className="fatal-error__card">
            <span className="fatal-error__eyebrow">MOTION STUDIO</span>
            <h1>界面暂时无法继续运行</h1>
            <p>当前场景仍可能保存在浏览器草稿中。重新载入页面通常可以恢复。</p>
            <details>
              <summary>查看错误信息</summary>
              <pre>{this.state.error.message}</pre>
            </details>
            <button type="button" onClick={() => window.location.reload()}>
              重新载入
            </button>
          </div>
        </main>
      )
    }

    return this.props.children
  }
}

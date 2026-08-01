import 'pixi.js/unsafe-eval'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App'
import { AppErrorBoundary } from './app/AppErrorBoundary'
import './styles/tokens.css'
import './styles/global.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('找不到应用挂载点 #root。')
}

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)

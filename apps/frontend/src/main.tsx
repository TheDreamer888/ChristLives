import { Component, StrictMode, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './WorkspaceApp.tsx'

class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: Error) {
    console.error('Não foi possível apresentar a interface Aegis.', error)
  }

  override render() {
    if (this.state.failed) return <main className="app-load-error" role="alert">
      <h1>Não foi possível abrir esta página.</h1>
      <p>Verifica a ligação e volta a carregar. Os rascunhos temporários serão perdidos.</p>
      <button type="button" onClick={() => window.location.reload()}>Voltar a carregar</button>
      <a href="/legal/privacy.html">Política de privacidade</a>
    </main>
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  createElement(StrictMode, null, createElement(AppBoundary, null, createElement(App))),
)

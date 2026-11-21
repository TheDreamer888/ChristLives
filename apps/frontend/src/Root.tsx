import { Suspense, lazy, useEffect, useState } from 'react'
import App from './WorkspaceApp.tsx'
import { I18nProvider } from './i18n'

// A consola de administração é carregada à parte: quem não é admin nunca descarrega o código.
const AdminConsole = lazy(() => import('./admin/AdminConsole.tsx'))
const isAdminHash = () => /^#admin(\/|$)/.test(window.location.hash)

export default function Root() {
  const [admin, setAdmin] = useState(isAdminHash)
  useEffect(() => {
    const onHash = () => setAdmin(isAdminHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  // A consola de administração é para a equipa e fica em português.
  if (!admin) return <I18nProvider><App /></I18nProvider>
  return (
    <Suspense fallback={<p role="status">A carregar a administração…</p>}>
      <AdminConsole />
    </Suspense>
  )
}

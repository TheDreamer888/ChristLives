import { Suspense, lazy, useEffect, useState } from 'react'
import App from './WorkspaceApp.tsx'

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
  if (!admin) return <App />
  return (
    <Suspense fallback={<p role="status">A carregar a administração…</p>}>
      <AdminConsole />
    </Suspense>
  )
}

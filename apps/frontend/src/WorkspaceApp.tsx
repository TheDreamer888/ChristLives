import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent } from 'react'
import { authClient } from './auth/authClient'
import { INTEGRATIONS, filterIntegrations, integrationStatus, type AiConfiguration } from './lib/integrations'
import { applyTheme, nextThemePreference, readStoredPreference, resolveTheme, storePreference, themeLabel, type ThemePreference } from './lib/theme'
import type { ChatSeed } from './components/ai/ChatView'
import {
  ApiError,
  apiClient,
  type AgencyPlan,
  type AgencyRef,
  type AgencySummary,
  type AssistantSource,
  type ClientWorkspace,
  type SalesLeadReceipt,
  type SecurityEvent,
  type TeamSecurityEvent,
  type AuthSession,
  type UrlCheckResponse,
} from './lib/api'
import './Workspace.css'
import './WorkspaceTheme.css'
import './WorkspaceModern.css'
import './WorkspaceDark.css'
import './components/ai/AiViews.css'

// Carregamento diferido resiliente: uma falha de rede (ou uma nova versão publicada,
// que muda os nomes dos ficheiros) tenta outra vez e, se persistir, recarrega a página
// uma única vez em vez de deixar o site inteiro no ecrã de erro.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mesma restrição que React.lazy
function lazyWithRetry<C extends ComponentType<any>, T extends { default: C } = { default: C }>(load: () => Promise<T>) {
  const loaded = (module: T) => {
    try { window.sessionStorage.removeItem('aegis-chunk-reload') } catch { /* sem armazenamento */ }
    return module
  }
  return lazy(async () => {
    try {
      return loaded(await load())
    } catch {
      await new Promise(resolve => window.setTimeout(resolve, 800))
      try {
        return loaded(await load())
      } catch (error) {
        let reloaded = false
        try { reloaded = window.sessionStorage.getItem('aegis-chunk-reload') === '1' } catch { /* sem armazenamento */ }
        if (!reloaded) {
          try { window.sessionStorage.setItem('aegis-chunk-reload', '1') } catch { /* sem armazenamento */ }
          window.location.reload()
          return new Promise<T>(() => {})
        }
        throw error
      }
    }
  })
}

const LoginTab = lazyWithRetry(() => import('./components/LoginTab'))
const HomeView = lazyWithRetry(() => import('./components/ai/HomeView'))
const ChatView = lazyWithRetry(() => import('./components/ai/ChatView'))
const TradingView = lazyWithRetry(() => import('./components/ai/TradingView'))
const NewsView = lazyWithRetry(() => import('./components/ai/NewsView'))
const CoursesView = lazyWithRetry(() => import('./components/ai/CoursesView'))
const OrganizeView = lazyWithRetry(() => import('./components/ai/OrganizeView'))
const SecurityCenter = lazyWithRetry(() => import('./components/ai/SecurityCenter'))

type View = 'overview' | 'chat' | 'trading' | 'news' | 'courses' | 'organize' | 'clients' | 'billing' | 'invite' | 'security' | 'integrations' | 'privacy' | 'account'

const AREAS: { id: View; label: string; title: string; subtitle: string; icon: string; group: 'ai' | 'tools' | 'account' }[] = [
  { id: 'overview', label: 'Início', title: 'Bem-vindo ao Aegis.', subtitle: 'A tua IA para conversar, analisar mercados, aprender economia e organizar o dia.', icon: 'home', group: 'ai' },
  { id: 'chat', label: 'Chat IA', title: 'Conversa com a melhor IA para cada tarefa.', subtitle: 'Claude, ChatGPT e Grok, com regras de segurança e sem conteúdo adulto.', icon: 'chat', group: 'ai' },
  { id: 'trading', label: 'Trading IA', title: 'Mercados com dados e disciplina.', subtitle: 'Cotações, análise por IA, gestão de risco e uma lista de decisão. Sem promessas de lucro.', icon: 'markets', group: 'ai' },
  { id: 'news', label: 'Notícias', title: 'Notícias globais de mercado.', subtitle: 'Títulos de todo o mundo, atualizados ao minuto, com briefing por IA.', icon: 'news', group: 'ai' },
  { id: 'courses', label: 'Cursos', title: 'Aprende economia com dados reais.', subtitle: 'Lições curtas, indicadores do Banco Mundial, quizzes e um tutor IA.', icon: 'education', group: 'ai' },
  { id: 'organize', label: 'Organização', title: 'Menos caixa de entrada. Mais foco.', subtitle: 'Resume emails do Gmail e Outlook, extrai tarefas e envia-as para o Notion.', icon: 'organize', group: 'ai' },
  { id: 'security', label: 'Segurança', title: 'Centro de segurança.', subtitle: 'Firewall com reputação de IP em tempo real, IA supervisora, verificação de ligações e segurança da tua conta.', icon: 'security', group: 'tools' },
  { id: 'integrations', label: 'Integrações', title: 'O teu ecossistema, com controlo.', subtitle: 'Consulta capacidades, configuração e requisitos antes de partilhar dados.', icon: 'integrations', group: 'tools' },
  { id: 'clients', label: 'Clientes', title: 'Clientes geridos', subtitle: 'Workspaces de cliente isolados para a tua agência.', icon: 'clients', group: 'account' },
  { id: 'billing', label: 'Plano e faturação', title: 'Plano da agência', subtitle: 'Subscrição, capacidade e gestão de pagamentos.', icon: 'billing', group: 'account' },
  { id: 'privacy', label: 'Privacidade', title: 'Privacidade', subtitle: 'Controla os teus dados.', icon: 'privacy', group: 'account' },
]
const isView = (value: string): value is View => AREAS.some(area => area.id === value) || value === 'account' || value === 'invite'
// Endereços antigos continuam a funcionar depois da mudança de tema.
const LEGACY_VIEWS: Record<string, View> = { assistant: 'chat', markets: 'trading', intelligence: 'trading', education: 'courses', worship: 'overview' }

function Icon({ name, size }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    community: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    home: 'M3 11l9-8 9 8 M5 9.5V20h14V9.5 M10 20v-6h4v6',
    chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z',
    news: 'M4 5h13v14H6a2 2 0 0 1-2-2Z M17 9h3v8a2 2 0 0 1-2 2 M8 9h5 M8 13h5',
    organize: 'M9 6h11 M9 12h11 M9 18h11 M4 6l1 1 2-2 M4 12l1 1 2-2 M4 18l1 1 2-2',
    clients: 'M3 7h18v14H3z M8 7V3h8v4 M3 12h18 M10 12v3h4v-3',
    billing: 'M3 5h18v14H3z M3 9h18 M7 15h4',
    security: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z M8 12l3 3 5-6',
    markets: 'M3 3v18h18 M7 15l4-5 4 2 6-7',
    intelligence: 'M9 18h6 M9 21h6 M8 14a6 6 0 1 1 8 0l-1 4H9z',
    assistant: 'M5 6h14v14H5z M12 2v4 M8 11h1 M15 11h1 M9 16h6 M2 10v6 M22 10v6',
    integrations: 'M9 3v4 M15 3v4 M6 7h12v5a6 6 0 0 1-12 0z M12 18v4',
    education: 'M2 9l10-6 10 6-10 6z M6 12v6l6 3 6-3v-6 M22 9v7',
    privacy: 'M12 3C6 3 3 8 2 12c1 4 4 9 10 9s9-5 10-9c-1-4-4-9-10-9 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    lock: 'M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0v3',
    arrow: 'M5 12h14 M14 7l5 5-5 5',
    search: 'M21 21l-6-6 M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14',
    close: 'M6 6l12 12 M18 6 6 18',
    menu: 'M4 7h16 M4 12h16 M4 17h10',
    up: 'M12 19V5 M6 11l6-6 6 6',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8',
    auto: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 3v18',
  }
  return <svg aria-hidden="true" width={size ?? 20} height={size ?? 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] ?? paths['arrow']} /></svg>
}

function External({ href, children }: { href: string; children: string }) {
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>
}

function useSecurity(view: View) {
  const [user, setUser] = useState<Awaited<ReturnType<typeof authClient.getSession>>>(null)
  const [events, setEvents] = useState<SecurityEvent[]>([])
  const [sessions, setSessions] = useState<AuthSession[]>([])
  const [teamEvents, setTeamEvents] = useState<TeamSecurityEvent[]>([])
  const [teamEventsLoading, setTeamEventsLoading] = useState(false)
  const [teamEventsError, setTeamEventsError] = useState('')
  const [managerAgencies, setManagerAgencies] = useState<AgencyRef[]>([])
  const [selectedAgencyId, setSelectedAgencyId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [refreshCount, setRefreshCount] = useState(0)

  useEffect(() => {
    if (view !== 'security' && view !== 'privacy') return
    let active = true
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const currentUser = await authClient.getSession()
        if (!active) return
        setUser(currentUser)
        if (!currentUser) {
          setEvents([])
          setSessions([])
          setTeamEvents([])
          setManagerAgencies([])
          setSelectedAgencyId('')
          return
        }
        const [securityEvents, activeSessions, agencies] = await Promise.all([
          apiClient.listSecurityEvents(),
          authClient.listSessions(),
          apiClient.listAgencies(),
        ])
        if (!active) return
        const manageableAgencies = agencies.filter(agency => agency.role === 'owner' || agency.role === 'admin')
        setEvents(securityEvents)
        setSessions(activeSessions)
        setManagerAgencies(manageableAgencies)
        setSelectedAgencyId(previous => {
          if (previous && manageableAgencies.some(agency => agency.id === previous)) return previous
          return manageableAgencies[0]?.id ?? ''
        })
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar os controlos de segurança.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [view, refreshCount])

  useEffect(() => {
    if (view !== 'security') return
    if (!user || !selectedAgencyId) {
      setTeamEvents([])
      setTeamEventsError('')
      setTeamEventsLoading(false)
      return
    }
    let active = true
    setTeamEventsLoading(true)
    setTeamEventsError('')
    void (async () => {
      try {
        const events = await apiClient.listAgencySecurityEvents(selectedAgencyId)
        if (!active) return
        setTeamEvents(events)
      } catch (cause) {
        if (!active) return
        setTeamEvents([])
        setTeamEventsError(cause instanceof Error ? cause.message : 'Não foi possível carregar os alertas da equipa.')
      } finally {
        if (active) setTeamEventsLoading(false)
      }
    })()
    return () => { active = false }
  }, [view, user, selectedAgencyId, refreshCount])

  return {
    user,
    events,
    sessions,
    teamEvents,
    teamEventsLoading,
    teamEventsError,
    managerAgencies,
    selectedAgencyId,
    loading,
    error,
    alertCount: events.filter(event => event.severity === 'warning').length,
    refresh: () => setRefreshCount(count => count + 1),
    selectAgency: setSelectedAgencyId,
  }
}

function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function AgencyConsole({ section, go }: { section: 'clients' | 'billing'; go: (view: View) => void }) {
  const [agencies, setAgencies] = useState<AgencyRef[]>([])
  const [agencyId, setAgencyId] = useState('')
  const [agency, setAgency] = useState<AgencySummary | null>(null)
  const [clients, setClients] = useState<ClientWorkspace[]>([])
  const [plans, setPlans] = useState<AgencyPlan[]>([])
  const [clientName, setClientName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
  const [clientIds, setClientIds] = useState<string[]>([])
  const [inviteUrl, setInviteUrl] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  const [clientSearch, setClientSearch] = useState('')

  const resetAgency = () => {
    setLoading(true)
    setAgency(null)
    setClients([])
    setClientIds([])
    setClientName('')
    setClientSearch('')
    setInviteEmail('')
    setInviteRole('member')
    setInviteUrl('')
    setMessage('')
    setError('')
    setErrorStatus(null)
  }
  const refreshAgency = () => {
    resetAgency()
    setReload(current => current + 1)
  }

  useEffect(() => {
    let cancelled = false
    authClient.getSession().then(session => {
      if (cancelled) return null
      if (!session) throw new ApiError('Inicia sessão para aceder às tuas agências e clientes.', 401)
      return Promise.all([apiClient.listAgencies(), apiClient.listPlans()])
    })
      .then(result => {
        if (cancelled || !result) return
        const [agencyList, availablePlans] = result
        setAgencies(agencyList)
        setPlans(availablePlans)
        setAgencyId(current => agencyList.some(item => item.id === current) ? current : agencyList[0]?.id || '')
        if (!agencyList.length) setLoading(false)
      })
      .catch(reason => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Não foi possível carregar a conta.')
          setErrorStatus(reason instanceof ApiError ? reason.status : null)
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [reload])

  useEffect(() => {
    if (!agencyId) return
    let cancelled = false
    Promise.all([apiClient.getAgency(agencyId), apiClient.listClients(agencyId)])
      .then(([summary, clientList]) => {
        if (cancelled) return
        setAgency(summary)
        setClients(clientList)
        setLoading(false)
      })
      .catch(reason => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Não foi possível carregar os dados da agência.')
          setErrorStatus(reason instanceof ApiError ? reason.status : null)
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [agencyId, agencies])

  const mutate = async (operation: () => Promise<void>, successMessage: string) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await operation()
      setMessage(successMessage)
      if (agencyId) {
        const [summary, clientList] = await Promise.all([
          apiClient.getAgency(agencyId),
          apiClient.listClients(agencyId),
        ])
        setAgency(summary)
        setClients(clientList)
        setClientIds(current => current.filter(id => clientList.some(client => client.id === id)))
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'A operação não foi concluída.')
      if (reason instanceof ApiError && reason.status === 401) {
        resetAgency()
        setAgencies([])
        setAgencyId('')
        setError(reason.message)
        setErrorStatus(401)
        setLoading(false)
      }
    } finally {
      setBusy(false)
    }
  }

  const addClient = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = clientName.trim()
    if (!name || !agencyId) return
    void mutate(async () => {
      await apiClient.createClient(agencyId, name)
      setClientName('')
    }, 'Cliente criado.')
  }

  const removeClient = (client: ClientWorkspace) => {
    if (!agencyId || !window.confirm(`Eliminar o workspace de ${client.name}?`)) return
    void mutate(() => apiClient.deleteClient(agencyId, client.id), 'Workspace eliminado.')
  }

  const inviteMember = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!agencyId) return
    void mutate(async () => {
      const invitation = await apiClient.createInvitation(agencyId, inviteEmail.trim(), inviteRole, inviteRole === 'member' ? clientIds : [])
      setInviteUrl(invitation.invite_url)
      setInviteEmail('')
      setClientIds([])
    }, 'Convite criado. Envia o link ao destinatário.')
  }

  const startCheckout = async (planId: AgencyPlan['id']) => {
    if (!agencyId) return
    setBusy(true)
    setError('')
    try {
      window.location.assign(await apiClient.startCheckout(agencyId, planId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível abrir o checkout.')
      setBusy(false)
    }
  }

  const openPortal = async () => {
    if (!agencyId) return
    setBusy(true)
    setError('')
    try {
      window.location.assign(await apiClient.openBillingPortal(agencyId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível abrir o portal de faturação.')
      setBusy(false)
    }
  }

  const checkoutState = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('checkout')
  const canManage = agency?.role === 'owner' || agency?.role === 'admin'
  const canManageBilling = agency?.role === 'owner' || agency?.role === 'admin'
  const canInviteAdmin = agency?.role === 'owner'
  const visibleClients = clients.filter(client => normalize(client.name).includes(normalize(clientSearch)))
  const atCapacity = !!agency && agency.clients_used >= agency.max_clients

  return (
    <section className="agency-console">
      {agencies.length > 1 && (
        <label className="agency-select-label">Agência
          <select aria-label="Selecionar agência" disabled={busy || loading} value={agencyId} onChange={event => { resetAgency(); setAgencyId(event.target.value) }}>
            {agencies.map(item => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}
          </select>
        </label>
      )}
      {error && <article className="aegis-panel agency-state">
        <span className="icon-box"><Icon name={errorStatus === 401 ? 'lock' : 'clients'} size={28} /></span>
        <h2>{errorStatus === 401 ? 'O teu workspace começa com uma sessão segura.' : 'Não foi possível carregar o workspace.'}</h2>
        <p className="assistant-error" role="alert">{error}</p>
        <p>Não mostramos clientes de demonstração nem substituímos os teus dados por valores fictícios.</p>
        <div className="workspace-actions">
          {errorStatus === 401 && <button className="button button-dark" onClick={() => go('account')}>Iniciar sessão</button>}
          <button className="button button-outline" disabled={loading || busy} onClick={refreshAgency}>Tentar novamente</button>
          <button className="button button-quiet" onClick={() => go('integrations')}>Explorar integrações</button>
        </div>
      </article>}
      {message && <p className="assistant-success" role="status">{message}</p>}
      {checkoutState === 'success' && <p className="assistant-success" role="status">Checkout concluído. A subscrição fica ativa assim que o Stripe confirmar o webhook.</p>}
      {checkoutState === 'cancelled' && <p className="agency-note">Checkout cancelado; não foi criada uma subscrição.</p>}
      {loading && <article className="aegis-panel agency-state" role="status" aria-live="polite"><h2>A carregar o workspace…</h2><p>A obter agências, permissões e clientes da API.</p></article>}
      {!loading && !agency && !error && <article className="aegis-panel agency-state"><h2>Ainda não tens acesso a uma agência.</h2><p>Pede um convite ao proprietário da agência. Os workspaces só aparecem depois de o acesso ser atribuído.</p><button className="button button-outline" onClick={refreshAgency}>Atualizar acesso</button></article>}

      {agency && !loading && errorStatus !== 401 && section === 'clients' && (
        <>
          <article className="aegis-panel agency-plan-summary">
            <div><p className="eyebrow">WORKSPACE DA AGÊNCIA</p><h2>{agency.name}</h2><p className="agency-note">{agency.plan_name ?? 'Sem plano contratado'} · {agency.role === 'owner' ? 'Proprietário' : agency.role === 'admin' ? 'Administrador' : 'Membro'}</p></div>
            <div><strong className="agency-capacity">{agency.clients_used} <span>/ {agency.max_clients || '—'}</span></strong><p className="agency-note">Workspaces na agência · {clients.length} acessíveis</p></div>
            <button className="button button-outline" onClick={() => { window.location.hash = '#billing' }}>Ver plano</button>
          </article>
          <div className="client-management-grid">
          <article className="aegis-panel client-directory">
            <div className="client-directory-heading"><div><p className="eyebrow">DIRETÓRIO</p><h2>Workspaces de cliente</h2></div><button className="button button-quiet" disabled={busy} onClick={refreshAgency}>Atualizar</button></div>
            <label className="client-search-label" htmlFor="client-search">Pesquisar clientes
              <input id="client-search" type="search" placeholder="Pesquisar pelo nome…" value={clientSearch} onChange={event => setClientSearch(event.target.value)} />
            </label>
            <p className="agency-note" role="status">{visibleClients.length} de {clients.length} clientes acessíveis</p>
            {clients.length === 0 ? <div className="client-empty"><Icon name="clients" size={32} /><h3>Um espaço para cada cliente.</h3><p>{canManage ? 'Adiciona o primeiro cliente quando o plano estiver ativo.' : 'Ainda não te foram atribuídos workspaces de cliente.'}</p></div> : visibleClients.length === 0 ? <p role="status">Nenhum cliente corresponde à pesquisa.</p> : (
              <ul className="agency-client-list">
                {visibleClients.map(client => (
                  <li key={client.id}>
                    <span className="client-avatar" aria-hidden="true">{client.name.slice(0, 2).toLocaleUpperCase('pt')}</span>
                    <div className="client-identity"><strong>{client.name}</strong><span>Criado em {Number.isNaN(Date.parse(client.created_at)) ? 'data indisponível' : new Date(client.created_at).toLocaleDateString('pt-PT')}</span></div>
                    {canManage && <button className="button button-quiet" aria-label={`Eliminar workspace de ${client.name}`} disabled={busy} onClick={() => removeClient(client)}>Eliminar</button>}
                  </li>
                ))}
              </ul>
            )}
          </article>
          <aside className="client-management-aside" aria-label="Gestão e ligações">
          {canManage && (
            <article className="aegis-panel">
              <h2>Adicionar cliente</h2>
              <form className="agency-form" onSubmit={addClient}>
                <label htmlFor="client-name">Nome do cliente</label>
                <input id="client-name" value={clientName} onChange={event => setClientName(event.target.value)} placeholder="Nome da organização" minLength={2} maxLength={120} required />
                <button className="button button-dark" disabled={busy || atCapacity || clientName.trim().length < 2 || !agency.plan_id || !['active', 'trialing'].includes(agency.subscription_status)}>Criar workspace</button>
              </form>
              {(!agency.plan_id || !['active', 'trialing'].includes(agency.subscription_status)) && <p className="agency-note">Ativa um plano para criar workspaces de cliente.</p>}
              {agency.plan_id && atCapacity && <p className="agency-note">A capacidade contratada foi atingida. Revê o plano para adicionar clientes.</p>}
            </article>
          )}
          <article className="aegis-panel client-connection-note"><p className="eyebrow">ECOSSISTEMA</p><h2>Ligações com transparência.</h2><p>Consulta o estado da IA e os requisitos para cloud, documentos e antivírus. Ainda não existem ligações externas por cliente.</p><button className="button button-outline" onClick={() => go('integrations')}>Ver catálogo de integrações</button></article>
          </aside>
          </div>
          {canManage && (
            <article className="aegis-panel">
              <h2>Convidar membro</h2>
              <form className="agency-form" onSubmit={inviteMember}>
                <label htmlFor="invite-email">Email da pessoa convidada</label>
                <input id="invite-email" type="email" value={inviteEmail} onChange={event => setInviteEmail(event.target.value)} required />
                <label htmlFor="invite-role">Permissão</label>
                <select id="invite-role" value={inviteRole} onChange={event => { setInviteRole(event.target.value as 'admin' | 'member'); setClientIds([]) }}>
                  <option value="member">Membro — apenas clientes selecionados</option>
                  {canInviteAdmin && <option value="admin">Administrador — todos os clientes</option>}
                </select>
                {inviteRole === 'member' && (
                  <fieldset className="agency-client-scope">
                    <legend>Clientes a que pode aceder</legend>
                    {clients.map(client => (
                      <label key={client.id}><input type="checkbox" checked={clientIds.includes(client.id)} onChange={event => setClientIds(current => event.target.checked ? [...current, client.id] : current.filter(id => id !== client.id))} />{client.name}</label>
                    ))}
                  </fieldset>
                )}
                <button className="button button-dark" disabled={busy || !inviteEmail || (inviteRole === 'member' && clientIds.length === 0)}>Criar convite</button>
              </form>
              <p className="agency-note">Por segurança, o convite expira em 7 dias. O envio por email não está configurado; partilha o link gerado apenas com o destinatário.</p>
              {inviteUrl && <p className="agency-invite-link"><a href={inviteUrl}>{inviteUrl}</a></p>}
            </article>
          )}
        </>
      )}

      {agency && !loading && errorStatus !== 401 && section === 'billing' && (
        <>
          <article className="aegis-panel">
            <p className="eyebrow">SUBSCRIÇÃO</p>
            <h2>{agency.plan_name ?? 'Escolhe um plano para começar'}</h2>
            <p>Estado: {agency.subscription_status}. Capacidade atual: {agency.clients_used} / {agency.max_clients || '—'} clientes.</p>
            {canManageBilling && agency.has_billing_customer && (
              <button className="button button-outline" disabled={busy} onClick={() => void openPortal()}>Gerir pagamento no Stripe</button>
            )}
          </article>
          <div className="agency-plan-grid">
            {plans.map(plan => (
              <article className={`aegis-panel agency-plan-card ${agency.plan_id === plan.id ? 'selected' : ''}`} key={plan.id}>
                <p className="eyebrow">AGÊNCIA</p><h2>{plan.name}</h2>
                <p>Até {plan.max_clients} clientes geridos.</p>
                <p className="agency-note">Preço e periodicidade definidos pela equipa no Stripe.</p>
                {canManageBilling && <button
                  className="button button-dark"
                  disabled={busy || (agency.has_subscription ? !agency.has_billing_customer : !plan.available)}
                  onClick={() => void (agency.has_subscription ? openPortal() : startCheckout(plan.id))}
                >
                  {agency.has_subscription
                    ? agency.plan_id === plan.id ? 'Plano atual' : 'Alterar no portal'
                    : !plan.available ? 'Indisponível' : 'Subscrever'}
                </button>}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function AcceptInviteView() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState(readInviteToken)

  useEffect(() => {
    let cancelled = false
    authClient.getSession().then(session => {
      if (!cancelled) setAuthenticated(Boolean(session))
    }).catch(reason => {
      if (cancelled) return
      setAuthenticated(false)
      setError(reason instanceof Error ? reason.message : 'Não foi possível verificar a sessão.')
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const updateToken = () => setToken(readInviteToken())
    window.addEventListener('hashchange', updateToken)
    return () => window.removeEventListener('hashchange', updateToken)
  }, [])

  const accept = async () => {
    setBusy(true)
    setError('')
    try {
      await apiClient.acceptInvitation(token)
      setStatus('Convite aceite. O teu acesso foi atualizado.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível aceitar o convite.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="aegis-panel invite-panel">
      <div className="invite-panel__heading">
        <span className="invite-panel__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <rect x="4.5" y="10" width="15" height="11" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
          </svg>
        </span>
        <div>
          <p className="eyebrow">CONVITE</p>
          <h2>Aceitar convite</h2>
          <p>Inicia sessão com a conta que recebeu este convite para continuar.</p>
        </div>
      </div>
      <div className="invite-panel__notice">
        <strong>Confirma o email da conta</strong>
        <p>Por segurança, só a conta associada ao email que recebeu o convite o pode aceitar.</p>
      </div>
      {authenticated === null && <p role="status">A verificar sessão…</p>}
      {authenticated === false && <LoginTab onAuthenticated={() => { setError(''); setAuthenticated(true) }} />}
      {authenticated === true && !status && (
        <button className="button button-dark" disabled={busy || token.length < 32} onClick={() => void accept()}>
          {busy ? 'A validar…' : 'Aceitar convite'}
        </button>
      )}
      {status && <p role="status">{status}</p>}
      {error && <p className="assistant-error" role="alert">{error}</p>}
    </section>
  )
}

function InvitePage() {
  return (
    <main className="invite-page">
      <header className="invite-header">
        <a className="invite-brand" href="#/">
          <span aria-hidden="true">Λ</span>
          AEGIS
        </a>
        <span>Acesso seguro</span>
      </header>
      <div className="invite-content">
        <div className="invite-intro">
          <p className="eyebrow">CONVITE AEGIS</p>
          <h1>Foste convidado para o Aegis</h1>
          <p>Aceita o convite com a conta que o recebeu.</p>
        </div>
        <AcceptInviteView />
      </div>
      <footer className="invite-footer">
        <a href="/legal/privacy.html">Privacidade</a>
        <a href="/legal/terms.html">Termos</a>
      </footer>
    </main>
  )
}

function SecurityView({ security, onExport, onManageAccount }: { security: ReturnType<typeof useSecurity>; onExport: () => void; onManageAccount: () => void }) {
  const [url, setUrl] = useState('')
  const [result, setResult] = useState<UrlCheckResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setResult(null)
    setError('')
    setBusy(true)
    try {
      setResult(await apiClient.checkUrl(url.trim()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível verificar o destino.')
    } finally {
      setBusy(false)
    }
  }

  const eventLabels: Record<string, string> = {
    login: 'Sessão iniciada',
    logout: 'Sessão terminada',
    passkey_registered: 'Nova passkey / chave de segurança adicionada',
    backup_codes_generated: 'Códigos de recuperação regenerados',
    session_revoked: 'Outra sessão terminada',
    passkey_failed: 'Tentativa de autenticação por passkey falhou',
    recovery_failed: 'Tentativa de recuperação falhou',
  }
  const loginMethod = (event: Pick<SecurityEvent, 'event_type' | 'details'>) => {
    if (event.event_type !== 'login') return eventLabels[event.event_type] ?? 'Atividade de segurança'
    const method = event.details['method'] as string | undefined
    if (method === 'backup_code') return 'Sessão iniciada com código de recuperação'
    if (method === 'passkey') return 'Sessão iniciada com passkey'
    return method ? `Sessão iniciada com ${method}` : eventLabels['login']
  }

  return <section className="aegis-panel" aria-label="Filtros de proteção e segurança da conta">
    <p className="eyebrow">CENTRO DE SEGURANÇA DA CONTA</p>
    <h2>Atividade e sessões</h2>
    {security.loading && <p role="status">A carregar a atividade de segurança…</p>}
    {security.error && <p className="assistant-error" role="alert">{security.error}</p>}
    {!security.loading && !security.user && (
      <div>
        <p>Inicia sessão para consultar os teus alertas e gerir as sessões ativas.</p>
        <button className="button button-dark" type="button" onClick={onManageAccount}>Abrir conta</button>
      </div>
    )}
    {security.user && (
      <div>
        <p>
          Passkeys e códigos de recuperação: <strong>{security.user.mfa_enrolled ? 'configurados' : 'ainda não configurados'}</strong>.
          {' '}Sessões ativas: <strong>{security.sessions.length}</strong>.
        </p>
        {!security.user.mfa_enrolled && <p role="status">Recomendação: adiciona uma passkey e guarda códigos de recuperação na área da conta.</p>}
        {security.alertCount > 0 && <p role="alert">{security.alertCount} alerta(s) de segurança requerem a tua atenção.</p>}
        <div className="agency-actions">
          <button className="button button-outline" type="button" onClick={security.refresh} disabled={security.loading}>Atualizar atividade</button>
          <button className="button button-outline" type="button" onClick={onManageAccount}>Gerir passkeys e sessões</button>
        </div>
        <h3>Eventos recentes</h3>
        {security.events.length === 0 && !security.loading && <p>Ainda não existem eventos de segurança registados.</p>}
        {security.events.length > 0 && (
          <ul className="security-event-list">
            {security.events.map(event => (
              <li key={event.id} className={event.severity === 'warning' ? 'security-event security-event--warning' : 'security-event'}>
                <strong>{loginMethod(event)}</strong>
                <span>{event.severity === 'warning' ? 'Alerta' : 'Informativo'}</span>
                <time dateTime={event.created_at ?? undefined}>
                  {event.created_at ? new Date(event.created_at).toLocaleString('pt-PT') : 'Data indisponível'}
                </time>
              </li>
            ))}
          </ul>
        )}
        <button className="button button-outline" type="button" onClick={onExport} disabled={security.events.length === 0}>Exportar registo</button>
        {security.managerAgencies.length > 0 && (
          <>
            <h3>Alertas da equipa</h3>
            <p>Visível apenas para proprietários e administradores da agência selecionada.</p>
            <label className="agency-select-label" htmlFor="security-agency-select">Agência
              <select
                id="security-agency-select"
                value={security.selectedAgencyId}
                onChange={event => security.selectAgency(event.target.value)}
                disabled={security.teamEventsLoading || security.managerAgencies.length === 1}
              >
                {security.managerAgencies.map(agency => (
                  <option key={agency.id} value={agency.id}>{agency.name}</option>
                ))}
              </select>
            </label>
            {security.teamEventsLoading && <p role="status">A carregar os alertas da equipa…</p>}
            {security.teamEventsError && <p className="assistant-error" role="alert">{security.teamEventsError}</p>}
            {!security.teamEventsLoading && !security.teamEventsError && security.teamEvents.length === 0 && (
              <p>Sem eventos de equipa registados para esta agência.</p>
            )}
            {!security.teamEventsLoading && security.teamEvents.length > 0 && (
              <ul className="security-event-list">
                {security.teamEvents.map(event => (
                  <li key={event.id} className={event.severity === 'warning' ? 'security-event security-event--warning' : 'security-event'}>
                    <strong>{loginMethod(event)} · {event.actor_name ?? 'Utilizador sem nome'}</strong>
                    <span>{event.severity === 'warning' ? 'Alerta' : 'Informativo'}</span>
                    <time dateTime={event.created_at ?? undefined}>
                      {event.created_at ? new Date(event.created_at).toLocaleString('pt-PT') : 'Data indisponível'}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    )}

    <hr />
    <p className="eyebrow">PROTEÇÃO DE URLS E DOMÍNIOS</p>
    <h2>Filtros de malware e phishing</h2>
    <p>Consulta local de listas públicas de ameaças e bloqueio de ligações sem HTTPS, credenciais no URL, destinos locais, portas não habituais e downloads executáveis.</p>
    <p>Não visitamos o destino nem enviamos o URL a fornecedores externos. Não introduzas segredos ou dados pessoais.</p>
    <form className="agency-form" onSubmit={event => void check(event)}>
      <label htmlFor="protection-url">URL ou domínio</label>
      <input id="protection-url" type="text" required maxLength={2048} placeholder="https://example.com" value={url} disabled={busy}
        onChange={event => { setUrl(event.target.value); setResult(null); setError('') }} />
      <button className="button button-dark" disabled={busy || !url.trim()}>{busy ? 'A verificar…' : 'Verificar destino'}</button>
    </form>
    {error && <p className="assistant-error" role="alert">{error}</p>}
    {result && <div role="status" aria-live="polite">
      <h3>{result.verdict === 'blocked' ? 'Bloqueado neste painel' : 'Não listado — segurança não garantida'}</h3>
      <p>Domínio: <strong>{result.host}</strong></p>
      <ul>{result.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      <p>{result.notice}</p>
      <p>Fonte: {result.source}. Lista descarregada: {new Date(result.feed_updated_at).toLocaleString('pt-PT')}.</p>
    </div>}
    <p>Este painel valida apenas os destinos submetidos: não é um antivírus nem bloqueia navegação noutros programas. Mantém Microsoft Defender e SmartScreen ativos; não alteramos as políticas Microsoft.</p>
  </section>
}

type AssistantTurn = {
  role: 'assistant' | 'user'
  text: string
  sources?: AssistantSource[]
}

function AegisSupportPanel() {
  const [turns, setTurns] = useState<AssistantTurn[]>([
    {
      role: 'assistant',
      text: 'Posso esclarecer dúvidas sobre o Aegis usando apenas a documentação publicada. Não partilhes dados pessoais, palavras-passe ou segredos.',
    },
  ])
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [chatError, setChatError] = useState('')
  const [showLeadForm, setShowLeadForm] = useState(false)
  const [leadName, setLeadName] = useState('')
  const [leadEmail, setLeadEmail] = useState('')
  const [adultConfirmed, setAdultConfirmed] = useState(false)
  const [leadConsent, setLeadConsent] = useState(false)
  const [leadBusy, setLeadBusy] = useState(false)
  const [leadError, setLeadError] = useState('')
  const [leadStatus, setLeadStatus] = useState('')
  const [receipt, setReceipt] = useState<SalesLeadReceipt | null>(null)

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const question = message.trim()
    if (!question || sending) return
    setTurns(current => [...current, { role: 'user', text: question }])
    setMessage('')
    setChatError('')
    setSending(true)
    try {
      const reply = await apiClient.askAssistant(question)
      setTurns(current => [...current, { role: 'assistant', text: reply.answer, sources: reply.sources }])
    } catch (error) {
      setChatError(error instanceof ApiError ? error.message : 'Não foi possível contactar o assistente.')
    } finally {
      setSending(false)
    }
  }

  const submitLead = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!adultConfirmed || !leadConsent || leadBusy) return
    setLeadError('')
    setLeadStatus('')
    setLeadBusy(true)
    try {
      const newReceipt = await apiClient.createSalesLead({
        name: leadName.trim(),
        email: leadEmail.trim(),
        adult_confirmed: true,
        consent: true,
      })
      setReceipt(newReceipt)
      setLeadStatus(newReceipt.message)
      setLeadName('')
      setLeadEmail('')
      setAdultConfirmed(false)
      setLeadConsent(false)
      setShowLeadForm(false)
    } catch (error) {
      setLeadError(error instanceof ApiError ? error.message : 'Não foi possível registar o pedido.')
    } finally {
      setLeadBusy(false)
    }
  }

  const deleteLead = async () => {
    if (!receipt) return
    setLeadError('')
    setLeadBusy(true)
    try {
      await apiClient.deleteSalesLead(receipt.delete_token)
      setReceipt(null)
      setLeadStatus('O pedido e os dados associados foram apagados.')
    } catch (error) {
      setLeadError(error instanceof ApiError ? error.message : 'Não foi possível apagar o pedido.')
    } finally {
      setLeadBusy(false)
    }
  }

  return (
    <section className="assistant-layout">
      <article className="aegis-panel assistant-panel">
        <div className="assistant-heading">
          <div><p className="eyebrow">SUPORTE BASEADO EM DOCUMENTAÇÃO</p><h2>Fala com o assistente</h2></div>
          <span className="assistant-badge">Sem ações na conta</span>
        </div>
        <p className="assistant-disclaimer">
          As respostas podem falhar. O assistente não presta aconselhamento jurídico, médico ou financeiro.
          As mensagens são enviadas ao fornecedor de IA configurado, mas o Aegis não guarda o histórico.
        </p>
        <div className="assistant-transcript" aria-live="polite" aria-label="Conversa com o assistente">
          {turns.map((turn, index) => (
            <article className={`assistant-turn ${turn.role}`} key={`${turn.role}-${index}`}>
              <strong>{turn.role === 'assistant' ? 'Aegis' : 'Tu'}</strong>
              <p>{turn.text}</p>
              {turn.sources && turn.sources.length > 0 && (
                <ul className="assistant-sources" aria-label="Fontes">
                  {turn.sources.map(source => (
                    <li key={source.url}>
                      <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
                      <small>{source.authority} · revisão do catálogo: {source.reviewed_at}</small>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
          {sending && <p className="assistant-pending" role="status">A consultar a documentação…</p>}
        </div>
        <form className="assistant-compose" onSubmit={sendMessage}>
          <label htmlFor="assistant-message">A tua pergunta</label>
          <textarea
            id="assistant-message"
            value={message}
            onChange={event => setMessage(event.target.value)}
            maxLength={2000}
            rows={3}
            required
            placeholder="Ex.: Como funciona a autenticação por passkey?"
          />
          <div className="assistant-compose-footer">
            <small>Máximo de 2.000 caracteres. Não incluas dados pessoais.</small>
            <button className="button button-dark" type="submit" disabled={sending || !message.trim()}>
              {sending ? 'A enviar…' : 'Enviar pergunta'}
            </button>
          </div>
        </form>
        {chatError && <p className="assistant-error" role="alert">{chatError}</p>}
      </article>

      <article className="aegis-panel sales-panel">
        <p className="eyebrow">PRÉ-VENDAS</p>
        <h2>Queres falar com a equipa?</h2>
        <p>O pedido é opcional e só recolhe nome e email para retorno comercial. Não é enviado se não deres consentimento.</p>
        {!showLeadForm && !receipt && (
          <button className="button button-outline" type="button" onClick={() => { setShowLeadForm(true); setLeadError('') }}>
            Pedir contato comercial
          </button>
        )}
        {showLeadForm && (
          <form className="sales-form" onSubmit={submitLead}>
            <label htmlFor="sales-name">Nome</label>
            <input id="sales-name" name="name" autoComplete="name" value={leadName} onChange={event => setLeadName(event.target.value)} maxLength={100} required />
            <label htmlFor="sales-email">Email para retorno</label>
            <input id="sales-email" name="email" type="email" autoComplete="email" value={leadEmail} onChange={event => setLeadEmail(event.target.value)} maxLength={254} required />
            <label className="assistant-check">
              <input type="checkbox" checked={adultConfirmed} onChange={event => setAdultConfirmed(event.target.checked)} required />
              Confirmo que tenho 18 anos ou mais.
            </label>
            <label className="assistant-check">
              <input type="checkbox" checked={leadConsent} onChange={event => setLeadConsent(event.target.checked)} required />
              Consinto que o Aegis use estes dados apenas para me contatar sobre o produto.
            </label>
            <p className="assistant-disclaimer">O prazo de conservação é informado após o envio. Podes apagar o pedido com o código de eliminação.</p>
            <div className="button-row">
              <button className="button button-dark" type="submit" disabled={leadBusy || !adultConfirmed || !leadConsent}>
                {leadBusy ? 'A enviar…' : 'Enviar pedido'}
              </button>
              <button className="button button-quiet" type="button" onClick={() => setShowLeadForm(false)}>Cancelar</button>
            </div>
          </form>
        )}
        {leadStatus && <p className="assistant-success" role="status">{leadStatus}</p>}
        {receipt && (
          <div className="lead-receipt">
            <p>Conservaremos o pedido até <strong>{receipt.retention_days} dias</strong>, salvo eliminação anterior.</p>
            <p>Código de eliminação — guarda-o num local seguro; não fica guardado no navegador:</p>
            <code>{receipt.delete_token}</code>
            <button className="button button-outline" type="button" onClick={deleteLead} disabled={leadBusy}>
              {leadBusy ? 'A apagar…' : 'Apagar o pedido agora'}
            </button>
          </div>
        )}
        {leadError && <p className="assistant-error" role="alert">{leadError}</p>}
        <p className="assistant-legal-links"><a href="/legal/privacy.html">Privacidade</a><span>·</span><a href="/legal/terms.html">Termos</a></p>
      </article>
    </section>
  )
}

function IntegrationsView({ openIntegration }: { openIntegration: (name: string) => void }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('Todas')
  const [configuration, setConfiguration] = useState<AiConfiguration>('checking')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let cancelled = false
    apiClient.getAiConfiguration().then(configured => {
      if (!cancelled) setConfiguration(configured ? 'configured' : 'not-configured')
    }).catch(reason => {
      if (cancelled) return
      setConfiguration(reason instanceof ApiError && reason.status === 401 ? 'sign-in' : 'unavailable')
      setError(reason instanceof Error ? reason.message : 'Não foi possível verificar a configuração de IA.')
    })
    return () => { cancelled = true }
  }, [reload])
  const items = filterIntegrations(query, category)
  return <section className="integration-catalog" aria-label="Catálogo de integrações">
    <article className="aegis-panel integration-intro"><div><p className="eyebrow">LIGAÇÕES RESPONSÁVEIS</p><h2>Primeiro, confiança. Depois, conexão.</h2><p>Capacidade implementada não significa serviço ligado. As integrações planeadas não enviam dados nem pedem credenciais.</p></div><span className="integration-symbol" aria-hidden="true"><Icon name="integrations" size={36} /></span></article>
    <div className="integration-controls">
      <label className="client-search-label" htmlFor="integration-search">Pesquisar integrações<input id="integration-search" type="search" placeholder="Cloud, documentos, IA…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label className="client-search-label" htmlFor="integration-category">Categoria<select id="integration-category" value={category} onChange={event => setCategory(event.target.value)}>{['Todas', 'Cloud', 'Produtividade', 'IA', 'Segurança'].map(value => <option key={value}>{value}</option>)}</select></label>
    </div>
    {error && <div className="integration-status-note"><p className="assistant-error" role="alert">{error}</p>{configuration === 'sign-in' ? <a className="button button-outline" href="#account">Iniciar sessão</a> : <button className="button button-outline" onClick={() => { setConfiguration('checking'); setError(''); setReload(current => current + 1) }}>Verificar novamente</button>}</div>}
    <p className="agency-note" role="status">{items.length} integrações · O estado da IA refere-se à configuração no servidor, não a um teste de ligação.</p>
    <div className="integration-grid">
      {items.map(item => <article className="aegis-panel integration-card" key={item.id}>
        <div className="integration-card-top"><span className={`integration-symbol integration-mark-${item.id}`} aria-hidden="true">{item.mark}</span><span className="integration-state">{integrationStatus(item, configuration)}</span></div>
        <p className="eyebrow">{item.category}</p><h2>{item.name}</h2><p>{item.text}</p>
        <button className="button button-outline" onClick={() => openIntegration(item.name)} aria-label={`Ver requisitos de ${item.name}`}>Ver requisitos <span aria-hidden="true">↗</span></button>
      </article>)}
    </div>
    {!items.length && <article className="aegis-panel client-empty"><h2>Nenhuma integração encontrada.</h2><p>Experimenta outro nome ou categoria.</p><button className="button button-outline" onClick={() => { setQuery(''); setCategory('Todas') }}>Limpar filtros</button></article>}
    <article className="aegis-panel integration-policy"><h2>Antes de ativar uma integração</h2><div><p><strong>Acesso mínimo</strong><br />Escolhe apenas os dados e permissões necessários à finalidade.</p><p><strong>Controlo de custos</strong><br />Define quotas, limites e preços claros antes de consumir APIs pagas.</p><p><strong>Privacidade por defeito</strong><br />Revê retenção, fornecedores e direitos dos titulares. Esta interface não constitui certificação de conformidade.</p></div><External href="https://eur-lex.europa.eu/eli/reg/2016/679/oj">Regulamento Geral sobre a Proteção de Dados ↗</External></article>
  </section>
}

function PrivacyView({ security, onExport }: { security: ReturnType<typeof useSecurity>; onExport: () => void }) {
  return <section className="aegis-panel"><p className="eyebrow">CONTROLO E TRANSPARÊNCIA</p><h2>Os teus dados, sem promessas vagas.</h2><p>As reflexões privadas do feed ficam apenas na memória desta área. Sair ou recarregar elimina-as. Os tokens de sessão continuam em cookies httpOnly, não no armazenamento JavaScript.</p><p>O estudo com IA encaminha a pergunta ao fornecedor configurado. A consulta bíblica pode carregar a medição de utilização exigida pelo fornecedor. Consulta os detalhes antes de usar estas ferramentas.</p>
    {security.loading ? <p role="status">A consultar a tua sessão…</p> : security.error ? <p role="alert" className="assistant-error">{security.error}</p> : <p>{security.user ? `${security.sessions.length} sessão(ões) devolvida(s) pela API. Gere os dispositivos na tua conta.` : 'Inicia sessão para consultar os registos da tua conta.'}</p>}
    <div className="button-row"><button className="button button-outline" onClick={onExport} disabled={security.loading || !!security.error || !security.events.length}>Exportar registo de segurança</button><a className="button button-outline" href="#account">Gerir sessões</a><a href="/legal/privacy.html">Política de privacidade</a></div>
  </section>
}

const TOAST_MS = 5000

function readHashView(): View {
  const hash = (window.location.hash.replace(/^#\/?/, '').split(/[/?]/, 1)[0] ?? '').trim()
  if (isView(hash)) return hash
  return LEGACY_VIEWS[hash] ?? 'overview'
}

function readInviteToken(): string {
  return window.location.hash.match(/^#\/invite\/([A-Za-z0-9_-]{32,128})(?:\?.*)?$/)?.[1] ?? ''
}

// Pesquisa tolerante a acentos: "biblia" encontra "Bíblia".
const normalize = (text: string) => text.trim().toLocaleLowerCase('pt').normalize('NFD').replace(/\p{Diacritic}/gu, '')

const BOTTOM_NAV: { id: View; short: string }[] = [
  { id: 'overview', short: 'Início' },
  { id: 'chat', short: 'Chat' },
  { id: 'trading', short: 'Trading' },
  { id: 'news', short: 'Notícias' },
]

function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readStoredPreference)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => applyTheme(resolveTheme(preference, media.matches))
    sync()
    if (preference !== 'system') return
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [preference])
  const cycle = () => {
    const next = nextThemePreference(preference)
    storePreference(next)
    setPreference(next)
  }
  return { preference, cycle }
}

function ThemeToggle({ preference, onToggle }: { preference: ThemePreference; onToggle: () => void }) {
  const icon = preference === 'dark' ? 'moon' : preference === 'light' ? 'sun' : 'auto'
  return <button type="button" className="theme-toggle" onClick={onToggle} aria-label={`${themeLabel(preference)}. Mudar tema`} title={themeLabel(preference)}>
    <Icon name={icon} size={18} />
  </button>
}

function greeting(date = new Date()): string {
  const hour = date.getHours()
  if (hour < 6) return 'BOA NOITE'
  if (hour < 13) return 'BOM DIA'
  if (hour < 20) return 'BOA TARDE'
  return 'BOA NOITE'
}

export default function WorkspaceApp() {
  const [view, setView] = useState<View>(readHashView)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [showTop, setShowTop] = useState(false)
  const [chatSeed, setChatSeed] = useState<ChatSeed | null>(null)
  const theme = useTheme()
  const security = useSecurity(view)
  const heading = useRef<HTMLHeadingElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const isFirstView = useRef(true)

  const current = AREAS.find(a => a.id === view) ?? (view === 'invite'
    ? { label: 'Convite', title: 'Aceder ao Aegis', subtitle: 'Inicia sessão com a conta que recebeu o convite para continuar.' }
    : undefined)
  const integration = INTEGRATIONS.find(i => i.name === detail)
  const query = normalize(search)
  const matches = useMemo(() => (query
    ? AREAS.filter(a => normalize(`${a.label} ${a.title} ${a.subtitle}`).includes(query))
      .sort((a, b) => Number(!normalize(a.label).includes(query)) - Number(!normalize(b.label).includes(query)))
    : []), [query])

  const go = (next: View) => {
    if (window.location.hash !== `#${next}`) window.location.hash = next
    setView(next)
    setSearch('')
    setMenuOpen(false)
    window.scrollTo({ top: 0 })
  }
  // Abre o Chat IA a partir de outra área, opcionalmente com pergunta e dados de contexto.
  const openChat = (seed: Omit<ChatSeed, 'id'> | null) => {
    setChatSeed(seed ? { ...seed, id: Date.now() } : null)
    go('chat')
  }
  const exportJournal = () => {
    const exportableEvents = security.events.map(({ event_type, severity, created_at }) => ({
      event_type,
      severity,
      created_at,
    }))
    downloadText(
      'aegis-registo-seguranca.json',
      JSON.stringify({ format: 'aegis-security-log-v1', events: exportableEvents }, null, 2),
      'application/json',
    )
    setToast('Registo exportado sem dados pessoais nem segredos.')
  }

  useEffect(() => {
    const onHashChange = () => { setView(readHashView()); setMenuOpen(false); setSearch(''); window.scrollTo({ top: 0 }) }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    document.title = `${current?.label ?? 'Conta'} · Aegis`
    // Move focus on navigation, not on first load.
    if (isFirstView.current) {
      isFirstView.current = false
      return
    }
    heading.current?.focus()
  }, [view, current?.label])

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    // showModal() throws if the dialog is already open.
    if (detail && !element.open) element.showModal()
    else if (!detail && element.open) element.close()
  }, [detail])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [toast])

  // Atalhos: "/" ou Ctrl/⌘+K focam a pesquisa; Escape fecha o menu móvel.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if ((event.key === 'k' && (event.ctrlKey || event.metaKey)) || (event.key === '/' && !typing)) {
        event.preventDefault()
        setMenuOpen(false)
        searchInput.current?.focus()
      } else if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setShowTop(window.scrollY > 700))
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', onScroll) }
  }, [])

  if (view === 'invite') return <InvitePage />

  return (
    <div className="aegis-frame">
      <a className="skip-link" href="#workspace" onClick={e => { e.preventDefault(); document.getElementById('workspace')?.focus() }}>Saltar para o conteúdo</a>

      <aside className={`aegis-sidebar ${menuOpen ? 'menu-open' : ''}`}>
        <button className="aegis-brand aegis-brand--ai" onClick={() => go('overview')} aria-label="Aegis, início"><span className="brand-orb" aria-hidden="true" />aegis<small>IA · mercados · organização</small></button>
        <button className="new-chat-button" type="button" onClick={() => openChat(null)}><Icon name="chat" size={17} />Nova conversa<kbd aria-hidden="true">IA</kbd></button>
        <button className="mobile-menu-toggle" aria-expanded={menuOpen} aria-controls="primary-navigation" onClick={() => setMenuOpen(value => !value)}>{menuOpen ? 'Fechar menu' : 'Explorar áreas'} <Icon name={menuOpen ? 'close' : 'community'} size={18} /></button>
        <nav id="primary-navigation" aria-label="Navegação principal">
          {(['ai', 'tools', 'account'] as const).map(group => <div className="nav-group" key={group}>
            <p className="nav-label">{{ ai: 'ASSISTENTE', tools: 'FERRAMENTAS', account: 'CONTA E EQUIPA' }[group]}</p>
            {AREAS.filter(a => a.group === group).map(a => (
              <button key={a.id} className={`aegis-nav ${view === a.id ? 'active' : ''}`} aria-current={view === a.id ? 'page' : undefined} onClick={() => go(a.id)}>
                <Icon name={a.icon} />
                {a.label}
                {a.id === 'security' && security.alertCount > 0 && <span className="nav-count">{security.alertCount}</span>}
              </button>
            ))}
          </div>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <Icon name="lock" size={17} />
            <strong>Os teus dados, sob controlo.</strong>
            <p>As conversas não ficam guardadas no Aegis. Sem publicidade comportamental.</p>
            <button onClick={() => go('privacy')}>Ver os controlos <span>↗</span></button>
          </div>
          <button className="account-button" onClick={() => go('account')}>
            <span className="account-avatar">TU</span>
            <span>A tua conta<small>Entrar com segurança</small></span>
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </aside>

      <div className="main-column">
        <header className="aegis-topbar">
          <div className="breadcrumb">Aegis <span>/</span> <b>{current?.label ?? 'Conta'}</b></div>
          <div className="top-actions">
            <div className="search-wrap">
              <Icon name="search" size={17} />
              <input ref={searchInput} type="search" aria-label="Pesquisar áreas" placeholder="Encontra o teu caminho" autoComplete="off" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearch(''); event.currentTarget.blur() } if (event.key === 'Enter' && matches[0]) go(matches[0].id) }} />
              {!query && <kbd className="search-kbd" aria-hidden="true">/</kbd>}
              {query && (
                <div className="search-results">
                  {matches.length
                    ? matches.map(a => <button key={a.id} onClick={() => go(a.id)}><Icon name={a.icon} size={16} />{a.label}</button>)
                    : <p>Nenhuma área encontrada.</p>}
                </div>
              )}
            </div>
            <ThemeToggle preference={theme.preference} onToggle={theme.cycle} />
            <button className="private-badge" onClick={() => go('privacy')}><Icon name="lock" size={14} />Privacidade</button>
            <button className="button button-quiet mobile-account" onClick={() => go('account')} aria-label="Abrir a tua conta"><Icon name="lock" size={17} />Conta</button>
          </div>
        </header>

        <main tabIndex={-1} id="workspace" className="workspace-main">
          <div className={view === 'chat' ? 'page-heading page-heading--compact' : 'page-heading'}>
            <div>
              <p className="eyebrow">{view === 'overview' ? `${greeting()} · AEGIS` : `AEGIS / ${(current?.label ?? 'Conta').toLocaleUpperCase('pt')}`}</p>
              <h1 tabIndex={-1} ref={heading}>{current?.title ?? 'Acesso ao teu espaço.'}</h1>
              <p className="page-subtitle">{current?.subtitle ?? 'A autenticação precisa de uma API configurada.'}</p>
            </div>
          </div>

          <Suspense fallback={<div className="view-loading" role="status"><span className="typing"><i /><i /><i /></span>A carregar…</div>}>
            {view === 'overview' && <HomeView go={go} openChat={openChat} />}
            {view === 'chat' && <ChatView seed={chatSeed} onSeedUsed={() => setChatSeed(null)} supportPanel={<AegisSupportPanel />} />}
            {view === 'trading' && <TradingView openChat={openChat} />}
            {view === 'news' && <NewsView openChat={openChat} />}
            {view === 'courses' && <CoursesView openChat={openChat} />}
            {view === 'organize' && <OrganizeView openChat={openChat} goAccount={() => go('account')} />}
            {view === 'clients' && <AgencyConsole key="clients" section="clients" go={go} />}
            {view === 'billing' && <AgencyConsole key="billing" section="billing" go={go} />}
            {view === 'security' && <><SecurityCenter /><SecurityView security={security} onExport={exportJournal} onManageAccount={() => go('account')} /></>}
            {view === 'integrations' && <IntegrationsView openIntegration={setDetail} />}
            {view === 'privacy' && <PrivacyView security={security} onExport={exportJournal} />}
            {view === 'account' && <section className="aegis-panel account-panel"><LoginTab /></section>}
          </Suspense>

          <footer className="workspace-footer">
            <span><b>Λ</b> AEGIS <i>/</i> Tecnologia com responsabilidade.</span>
            <div>
              <button onClick={() => go('privacy')}>Privacidade</button>
              <a href="/legal/terms.html">Termos</a>
              <span>Sem tracking publicitário</span>
            </div>
          </footer>
        </main>
      </div>

      <dialog ref={dialog} className="integration-dialog" aria-labelledby="dialog-title" onClose={() => setDetail(null)}>
        {integration && (
          <>
            <button className="dialog-close" aria-label="Fechar requisitos" onClick={() => setDetail(null)}><Icon name="close" /></button>
            <span className="integration-symbol">{integration.mark}</span>
            <p className="eyebrow">{integration.implementation === 'planned' ? 'INTEGRAÇÃO PLANEADA' : 'CAPACIDADE IMPLEMENTADA NO BACKEND'}</p>
            <h2 id="dialog-title">{integration.name}</h2>
            <p>{integration.text}</p>
            <ol>
              {integration.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}
            </ol>
            <External href={integration.url}>Documentação oficial ↗</External>
            <p className="caption">Abrir estes requisitos não cria ligações nem envia documentos ao fornecedor.</p>
          </>
        )}
      </dialog>

      {menuOpen && <div className="nav-backdrop" aria-hidden="true" onClick={() => setMenuOpen(false)} />}

      <nav className="bottom-nav" aria-label="Navegação rápida">
        {BOTTOM_NAV.map(({ id, short }) => {
          const area = AREAS.find(a => a.id === id)
          if (!area) return null
          return <button key={id} type="button" className={view === id && !menuOpen ? 'active' : ''} aria-current={view === id ? 'page' : undefined} aria-label={area.label} onClick={() => go(id)}>
            <Icon name={area.icon} size={20} />
            <span aria-hidden="true">{short}</span>
          </button>
        })}
        <button type="button" className={menuOpen || !BOTTOM_NAV.some(item => item.id === view) ? 'active' : ''} aria-expanded={menuOpen} aria-controls="primary-navigation" onClick={() => setMenuOpen(value => !value)}>
          <Icon name={menuOpen ? 'close' : 'menu'} size={20} />
          <span>{menuOpen ? 'Fechar' : 'Mais'}</span>
        </button>
      </nav>

      {showTop && <button className="back-to-top" type="button" aria-label="Voltar ao topo" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><Icon name="up" size={18} /></button>}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

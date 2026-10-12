import { ApiError, request } from './http'
export { ApiError } from './http'

export type RiskScoreResponse = {
  score: number
}

export type UrlCheckResponse = {
  verdict: 'blocked' | 'not_listed'
  host: string
  reasons: string[]
  checked_at: string
  feed_updated_at: string
  source: string
  notice: string
}

export type RiskScoreRequest = {
  finding_ids: string[]
  finding_count: number
}

export type AssistantSource = {
  title: string
  url: string
  authority: string
  reviewed_at: string
}

export type AssistantReply = {
  answer: string
  sources: AssistantSource[]
}

export type BibleConversationTurn = {
  role: 'assistant' | 'user'
  content: string
}

export type SalesLeadInput = {
  name: string
  email: string
  adult_confirmed: true
  consent: true
}

export type SalesLeadReceipt = {
  message: string
  delete_token: string
  retention_days: number
}

export type AgencyRef = {
  id: string
  name: string
  role: 'owner' | 'admin' | 'member'
}

export type AgencySummary = AgencyRef & {
  plan_id: 'starter' | 'growth' | 'scale' | null
  plan_name: string | null
  max_clients: number
  subscription_status: string
  clients_used: number
  has_billing_customer: boolean
  has_subscription: boolean
}

export type ClientWorkspace = {
  id: string
  name: string
  created_at: string
}

export type AgencyPlan = {
  id: 'starter' | 'growth' | 'scale'
  name: string
  max_clients: number
  available: boolean
}

export type AuthSession = {
  id: string
  created_at: string | null
  expires_at: string
  is_current: boolean
}

export type SecurityEvent = {
  id: string
  event_type: string
  severity: 'info' | 'warning'
  created_at: string | null
  details: Record<string, string>
}

function isAssistantSource(source: unknown): source is AssistantSource {
  if (typeof source !== 'object' || source === null || !('url' in source) || typeof source.url !== 'string') {
    return false
  }
  const internalPaths = ['/legal/terms.html', '/legal/privacy.html']
  const approvedHosts = new Set([
    'eur-lex.europa.eu',
    'commission.europa.eu',
    'diariodarepublica.pt',
    'cncs.gov.pt',
    'www.cncs.gov.pt',
    'edpb.europa.eu',
    'www.edpb.europa.eu',
    'api-security.owasp.org',
    'nist.gov',
    'www.nist.gov',
  ])
  const url = recordField(source, 'url')
  const title = recordField(source, 'title')
  const authority = recordField(source, 'authority')
  const reviewedAt = recordField(source, 'reviewed_at')
  if (
    typeof url !== 'string' ||
    typeof title !== 'string' ||
    typeof authority !== 'string' ||
    typeof reviewedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt)
  ) {
    return false
  }
  let approvedUrl = internalPaths.includes(url)
  if (!approvedUrl) {
    try {
      const parsedUrl = new URL(url)
      approvedUrl =
        parsedUrl.protocol === 'https:' &&
        !parsedUrl.username &&
        !parsedUrl.password &&
        approvedHosts.has(parsedUrl.hostname)
    } catch {
      approvedUrl = false
    }
  }
  return (
    approvedUrl
  )
}

function recordField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Object.entries(value).find(([field]) => field === key)?.[1]
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new ApiError(message, 502)
  return value
}

export const apiClient = {
  async listSecurityEvents(): Promise<SecurityEvent[]> {
    const { body, status } = await request('/api/auth/security/events')
    const events = recordField(body, 'events')
    if (!Array.isArray(events)) throw new ApiError('Resposta inválida dos eventos de segurança', status)
    return events.map(event => {
      const id = recordField(event, 'id')
      const eventType = recordField(event, 'event_type')
      const severity = recordField(event, 'severity')
      const createdAt = recordField(event, 'created_at')
      const details = recordField(event, 'details')
      if (
        typeof id !== 'string' ||
        typeof eventType !== 'string' ||
        (severity !== 'info' && severity !== 'warning') ||
        !(createdAt === null || typeof createdAt === 'string') ||
        typeof details !== 'object' ||
        details === null ||
        !Object.values(details).every(value => typeof value === 'string')
      ) {
        throw new ApiError('Evento de segurança inválido', status)
      }
      const safeDetails = Object.fromEntries(
        Object.entries(details).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
      return { id, event_type: eventType, severity, created_at: createdAt, details: safeDetails }
    })
  },

  async listAuthSessions(): Promise<AuthSession[]> {
    const { body, status } = await request('/api/auth/sessions')
    const sessions = recordField(body, 'sessions')
    if (!Array.isArray(sessions)) throw new ApiError('Resposta inválida das sessões', status)
    return sessions.map(item => {
      const id = recordField(item, 'id')
      const createdAt = recordField(item, 'created_at')
      const expiresAt = recordField(item, 'expires_at')
      const isCurrent = recordField(item, 'is_current')
      if (
        typeof id !== 'string' ||
        !(createdAt === null || typeof createdAt === 'string') ||
        typeof expiresAt !== 'string' ||
        typeof isCurrent !== 'boolean'
      ) {
        throw new ApiError('Sessão inválida', status)
      }
      return { id, created_at: createdAt, expires_at: expiresAt, is_current: isCurrent }
    })
  },

  async revokeAuthSession(sessionId: string): Promise<void> {
    await request(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  },

  async getAiConfiguration(): Promise<boolean> {
    const { body, status } = await request('/api/ai/plans')
    const configured = recordField(body, 'ai_configured')
    if (typeof configured !== 'boolean') throw new ApiError('Resposta inválida da configuração de IA', status)
    return configured
  },

  async checkUrl(url: string): Promise<UrlCheckResponse> {
    const { body, status } = await request('/api/protect/check-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    const verdict = recordField(body, 'verdict')
    const reasons = recordField(body, 'reasons')
    if ((verdict !== 'blocked' && verdict !== 'not_listed') ||
        !Array.isArray(reasons) || !reasons.every((reason): reason is string => typeof reason === 'string')) {
      throw new ApiError('Resposta inválida dos filtros de proteção', status)
    }
    return {
      verdict,
      reasons,
      host: requireString(recordField(body, 'host'), 'Domínio inválido na resposta'),
      checked_at: requireString(recordField(body, 'checked_at'), 'Data de verificação inválida'),
      feed_updated_at: requireString(recordField(body, 'feed_updated_at'), 'Data da lista inválida'),
      source: requireString(recordField(body, 'source'), 'Fonte inválida'),
      notice: requireString(recordField(body, 'notice'), 'Aviso de proteção inválido'),
    }
  },
  async scoreRisk(payload: RiskScoreRequest): Promise<RiskScoreResponse> {
    const result = await request('/api/protect/risk-score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (
      typeof result.body !== 'object' ||
      result.body === null ||
      !('score' in result.body) ||
      typeof result.body.score !== 'number' ||
      !Number.isFinite(result.body.score) ||
      result.body.score < 0 ||
      result.body.score > 1
    ) {
      throw new ApiError('Resposta inválida da API', result.status)
    }

    return { score: result.body.score }
  },

  async askAssistant(message: string): Promise<AssistantReply> {
    const result = await request('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    if (
      typeof result.body !== 'object' ||
      result.body === null ||
      !('answer' in result.body) ||
      typeof result.body.answer !== 'string' ||
      !('sources' in result.body) ||
      !Array.isArray(result.body.sources) ||
      !result.body.sources.every(isAssistantSource)
    ) {
      throw new ApiError('Resposta inválida do assistente', result.status)
    }
    return { answer: result.body.answer, sources: result.body.sources }
  },

  async askBibleAssistant(message: string, history: BibleConversationTurn[] = []): Promise<{ answer: string }> {
    const result = await request('/api/assistant/bible-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history }),
    })
    if (
      typeof result.body !== 'object' ||
      result.body === null ||
      !('answer' in result.body) ||
      typeof result.body.answer !== 'string' ||
      !result.body.answer.trim()
    ) {
      throw new ApiError('Resposta inválida do assistente bíblico', result.status)
    }
    return { answer: result.body.answer }
  },

  async createSalesLead(input: SalesLeadInput): Promise<SalesLeadReceipt> {
    const result = await request('/api/assistant/sales-leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (
      typeof result.body !== 'object' ||
      result.body === null ||
      !('message' in result.body) ||
      typeof result.body.message !== 'string' ||
      !('delete_token' in result.body) ||
      typeof result.body.delete_token !== 'string' ||
      !('retention_days' in result.body) ||
      typeof result.body.retention_days !== 'number' ||
      !Number.isInteger(result.body.retention_days) ||
      result.body.retention_days < 1 ||
      result.body.retention_days > 365
    ) {
      throw new ApiError('Resposta inválida ao registar o pedido', result.status)
    }
    return {
      message: result.body.message,
      delete_token: result.body.delete_token,
      retention_days: result.body.retention_days,
    }
  },

  async deleteSalesLead(deleteToken: string): Promise<void> {
    await request('/api/assistant/sales-leads', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete_token: deleteToken }),
    })
  },

  async listAgencies(): Promise<AgencyRef[]> {
    const { body, status } = await request('/api/agency/agencies')
    const agencies = recordField(body, 'agencies')
    if (!Array.isArray(agencies)) throw new ApiError('Resposta inválida das agências', status)
    return agencies.map(item => ({
      id: requireString(recordField(item, 'id'), 'ID de agência inválido'),
      name: requireString(recordField(item, 'name'), 'Nome de agência inválido'),
      role: requireString(recordField(item, 'role'), 'Permissão de agência inválida') as AgencyRef['role'],
    }))
  },

  async getAgency(agencyId: string): Promise<AgencySummary> {
    const { body, status } = await request('/api/agency', {
      headers: { 'X-Agency-ID': agencyId },
    })
    const id = requireString(recordField(body, 'id'), 'Resposta inválida da agência')
    const name = requireString(recordField(body, 'name'), 'Resposta inválida da agência')
    const role = requireString(recordField(body, 'role'), 'Resposta inválida da agência')
    const planId = recordField(body, 'plan_id')
    const planName = recordField(body, 'plan_name')
    const maxClients = recordField(body, 'max_clients')
    const statusValue = recordField(body, 'subscription_status')
    const clientsUsed = recordField(body, 'clients_used')
    const hasBillingCustomer = recordField(body, 'has_billing_customer')
    const hasSubscription = recordField(body, 'has_subscription')
    if (
      !['owner', 'admin', 'member'].includes(role) ||
      !(planId === null || ['starter', 'growth', 'scale'].includes(String(planId))) ||
      !(planName === null || typeof planName === 'string') ||
      typeof maxClients !== 'number' ||
      typeof clientsUsed !== 'number' ||
      typeof statusValue !== 'string' ||
      typeof hasBillingCustomer !== 'boolean' ||
      typeof hasSubscription !== 'boolean'
    ) {
      throw new ApiError('Resposta inválida da agência', status)
    }
    return {
      id,
      name,
      role: role as AgencySummary['role'],
      plan_id: planId as AgencySummary['plan_id'],
      plan_name: planName as string | null,
      max_clients: maxClients,
      clients_used: clientsUsed,
      subscription_status: statusValue,
      has_billing_customer: hasBillingCustomer,
      has_subscription: hasSubscription,
    }
  },

  async listClients(agencyId: string): Promise<ClientWorkspace[]> {
    const { body, status } = await request('/api/agency/clients', {
      headers: { 'X-Agency-ID': agencyId },
    })
    const clients = recordField(body, 'clients')
    if (!Array.isArray(clients)) throw new ApiError('Resposta inválida dos clientes', status)
    return clients.map(item => {
      const id = recordField(item, 'id')
      const name = recordField(item, 'name')
      const createdAt = recordField(item, 'created_at')
      if (typeof id !== 'string' || typeof name !== 'string' || typeof createdAt !== 'string') {
        throw new ApiError('Resposta inválida dos clientes', status)
      }
      return { id, name, created_at: createdAt }
    })
  },

  async createClient(agencyId: string, name: string): Promise<ClientWorkspace> {
    const { body, status } = await request('/api/agency/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agency-ID': agencyId },
      body: JSON.stringify({ name }),
    })
    const client = recordField(body, 'client')
    const id = recordField(client, 'id')
    const clientName = recordField(client, 'name')
    const createdAt = recordField(client, 'created_at')
    if (typeof id !== 'string' || typeof clientName !== 'string' || typeof createdAt !== 'string') {
      throw new ApiError('Resposta inválida ao criar o cliente', status)
    }
    return { id, name: clientName, created_at: createdAt }
  },

  async deleteClient(agencyId: string, clientId: string): Promise<void> {
    await request(`/api/agency/clients/${encodeURIComponent(clientId)}`, {
      method: 'DELETE',
      headers: { 'X-Agency-ID': agencyId },
    })
  },

  async listPlans(): Promise<AgencyPlan[]> {
    const { body, status } = await request('/api/agency/plans')
    const plans = recordField(body, 'plans')
    if (!Array.isArray(plans)) throw new ApiError('Resposta inválida dos planos', status)
    return plans.map(item => {
      const id = recordField(item, 'id')
      const name = recordField(item, 'name')
      const maxClients = recordField(item, 'max_clients')
      const available = recordField(item, 'available')
      if (
        !['starter', 'growth', 'scale'].includes(String(id)) ||
        typeof name !== 'string' ||
        typeof maxClients !== 'number' ||
        typeof available !== 'boolean'
      ) {
        throw new ApiError('Resposta inválida dos planos', status)
      }
      return { id: id as AgencyPlan['id'], name, max_clients: maxClients, available }
    })
  },

  async createInvitation(
    agencyId: string,
    email: string,
    role: 'admin' | 'member',
    clientIds: string[],
  ): Promise<{ invite_url: string; expires_in_days: number }> {
    const { body, status } = await request('/api/agency/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agency-ID': agencyId },
      body: JSON.stringify({ email, role, client_ids: clientIds }),
    })
    const url = recordField(body, 'invite_url')
    const expires = recordField(body, 'expires_in_days')
    if (typeof url !== 'string' || typeof expires !== 'number') {
      throw new ApiError('Resposta inválida do convite', status)
    }
    return { invite_url: url, expires_in_days: expires }
  },

  async acceptInvitation(token: string): Promise<void> {
    await request('/api/agency/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  },

  async startCheckout(agencyId: string, planId: AgencyPlan['id']): Promise<string> {
    const { body, status } = await request('/api/agency/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agency-ID': agencyId },
      body: JSON.stringify({ plan_id: planId }),
    })
    return requireString(recordField(body, 'url'), `Resposta inválida do Stripe (${status})`)
  },

  async openBillingPortal(agencyId: string): Promise<string> {
    const { body, status } = await request('/api/agency/billing-portal', {
      method: 'POST',
      headers: { 'X-Agency-ID': agencyId },
    })
    return requireString(recordField(body, 'url'), `Resposta inválida do Stripe (${status})`)
  },
}

/**
 * Cliente da API de administração. A sessão é o cookie httpOnly; aqui nunca
 * há tokens. Os erros trazem o código HTTP para a consola reagir (401/403/404).
 */
const API_BASE = import.meta.env['VITE_API_BASE_URL'] ?? 'http://localhost:8000'

export class AdminError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin${path}`, {
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const detail = typeof body.detail === 'string' ? body.detail : `Falha no pedido (${res.status})`
    throw new AdminError(res.status, detail)
  }
  return res.json() as Promise<T>
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) })

export interface Me {
  id: string
  name: string | null
  roles: string[]
  permissions: string[]
  session_expires_in: number
  step_up_valid_for: number
}

export interface AdminUser {
  id: string
  email: string | null
  name: string | null
  roles: string[]
  status: 'active' | 'suspended'
  methods: string[]
  mfa: boolean
  passkeys: number
  created_at: number
  last_login_at: number | null
}

export interface AuditItem {
  seq: number
  ts: number
  actor_id: string | null
  action: string
  outcome: 'success' | 'denied' | 'error'
  target: string | null
  ip: string | null
  reason: string | null
  details: Record<string, unknown>
  hash: string
}

export interface ChainStatus {
  valid: boolean
  checked: number
  total: number
  broken_at: number | null
}

export interface Overview {
  users_total: number
  users_active_24h: number
  users_suspended: number
  users_with_passkey: number
  staff: Record<string, number>
  approvals_pending: number
  audit_events_24h: number
  denied_24h: number
  audit_chain: ChainStatus
  recent: AuditItem[]
}

export interface RoleInfo {
  id: string
  label: string
  description: string
  privileged: boolean
  permissions: string[]
  members: number
}

export interface Approval {
  id: string
  action: string
  target_user_id: string
  role: string
  requested_by: string
  reason: string
  created_at: number
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  decided_by: string | null
  decided_at: number | null
  decision_note: string | null
}

export interface Posture {
  score: number
  checks: { id: string; label: string; ok: boolean }[]
}

export const adminClient = {
  me: () => call<Me>('/me'),
  overview: () => call<Overview>('/overview'),
  roles: () => call<{ roles: RoleInfo[]; two_person_rule: boolean }>('/roles'),
  users: (params: { q?: string; role?: string; status?: string; page?: number }) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, String(v))
    return call<{ total: number; page: number; page_size: number; items: AdminUser[] }>(`/users?${qs}`)
  },
  user: (id: string) => call<{ user: AdminUser; history: AuditItem[] }>(`/users/${encodeURIComponent(id)}`),
  audit: (params: { action?: string; outcome?: string; actor?: string }) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v)
    return call<{ total: number; items: AuditItem[] }>(`/audit?${qs}`)
  },
  verifyAudit: () => call<ChainStatus>('/audit/verify'),
  approvals: () => call<{ items: Approval[] }>('/approvals'),
  posture: () => call<Posture>('/security'),
  suspend: (id: string, reason: string) => post(`/users/${encodeURIComponent(id)}/suspend`, { reason }),
  reactivate: (id: string, reason: string) => post(`/users/${encodeURIComponent(id)}/reactivate`, { reason }),
  revokeSessions: (id: string, reason: string) => post(`/users/${encodeURIComponent(id)}/revoke-sessions`, { reason }),
  setRoles: (id: string, roles: string[], reason: string) =>
    post<{ pending_approvals: string[] }>(`/users/${encodeURIComponent(id)}/roles`, { roles, reason }),
  decide: (id: string, approve: boolean, note: string) =>
    post(`/approvals/${encodeURIComponent(id)}/decide`, { approve, note }),

  async exportAudit(): Promise<void> {
    const res = await fetch(`${API_BASE}/api/admin/audit/export`, { credentials: 'include', cache: 'no-store' })
    if (!res.ok) throw new AdminError(res.status, `Falha na exportação (${res.status})`)
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = `aegis-auditoria-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  },
}

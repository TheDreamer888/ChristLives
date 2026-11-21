/**
 * Ponte entre a consola de administração e o SDK oficial (@lusorbe/sdk).
 *
 * A consola continua a usar esta interface; o HTTP, as novas tentativas, os
 * tempos limite e os erros tipados vêm do SDK. Os erros são convertidos em
 * `AdminError` com o código HTTP, para a consola reagir a 401/403/404.
 */
import { ApiError, LusorbeError } from '@lusorbe/sdk'
import type {
  AdminMe,
  AdminUser,
  Approval,
  AuditEntry,
  ChainStatus,
  Overview,
  Posture,
  RoleInfo,
  WaitlistOverview,
} from '@lusorbe/sdk'

import { lusorbe } from '../lusorbe'

export type { AdminUser, Approval, ChainStatus, Overview, Posture, RoleInfo }
export type Me = AdminMe
export type AuditItem = AuditEntry
export type WaitlistData = WaitlistOverview

export const PAGE_SIZE = 25

export class AdminError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Converte os erros do SDK no formato que a consola espera (status 0 = sem ligação). */
async function wrap<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (err) {
    if (err instanceof ApiError) throw new AdminError(err.status, err.message)
    if (err instanceof LusorbeError) throw new AdminError(0, err.message)
    throw err
  }
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const today = () => new Date().toISOString().slice(0, 10)
const asStatus = (s?: string) => (s === 'active' || s === 'suspended' ? s : undefined)
const asOutcome = (s?: string) => (s === 'success' || s === 'denied' || s === 'error' ? s : undefined)

export const adminClient = {
  me: () => wrap(lusorbe.admin.me()),
  overview: () => wrap(lusorbe.admin.overview()),
  roles: () => wrap(lusorbe.admin.roles()),
  posture: () => wrap(lusorbe.admin.securityPosture()),

  /** Uma página da lista (a tabela da consola pagina por número). */
  users: (params: { q?: string; role?: string; status?: string; page?: number }) =>
    wrap(
      (async () => {
        const page = params.page ?? 1
        const pages = lusorbe.admin.users
          .list({ search: params.q, role: params.role, status: asStatus(params.status) })
          .byPage({ continuationToken: String(page), maxPageSize: PAGE_SIZE })
        const { value } = await pages.next()
        const items: AdminUser[] = value?.items ?? []
        return { total: value?.total ?? 0, page, page_size: PAGE_SIZE, items }
      })(),
    ),

  user: (id: string) => wrap(lusorbe.admin.users.get(id)),
  audit: (params: { action?: string; outcome?: string; actor?: string }) =>
    wrap(lusorbe.admin.audit.list({ action: params.action, outcome: asOutcome(params.outcome), actorId: params.actor })),
  verifyAudit: () => wrap(lusorbe.admin.audit.verify()),
  approvals: async () => ({ items: await wrap(lusorbe.admin.approvals.list()) }),

  suspend: (id: string, reason: string) => wrap(lusorbe.admin.users.suspend(id, { reason })),
  reactivate: (id: string, reason: string) => wrap(lusorbe.admin.users.reactivate(id, { reason })),
  revokeSessions: (id: string, reason: string) => wrap(lusorbe.admin.users.revokeSessions(id, { reason })),
  setRoles: (id: string, roles: string[], reason: string) => wrap(lusorbe.admin.users.setRoles(id, { roles, reason })),
  decide: (id: string, approve: boolean, note: string) => wrap(lusorbe.admin.approvals.decide(id, { approve, note })),

  exportAudit: async () => saveBlob(await wrap(lusorbe.admin.audit.export()), `lusorbe-auditoria-${today()}.csv`),
  waitlist: () => wrap(lusorbe.admin.waitlist.overview()),
  exportWaitlist: async () =>
    saveBlob(await wrap(lusorbe.admin.waitlist.export()), `lusorbe-lista-espera-${today()}.csv`),
  deleteWaitlist: (email: string, reason: string) => wrap(lusorbe.admin.waitlist.delete({ email, reason })),
}

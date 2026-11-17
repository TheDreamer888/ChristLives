import type {
  AdminMe,
  AdminUser,
  Approval,
  AuditEntry,
  ChainStatus,
  DecisionResult,
  Overview,
  Posture,
  Roles,
  RolesResult,
  UserDetail,
  UserResult,
  WaitlistOverview,
} from '../models.ts'
import { pagedIterator, type PagedAsyncIterableIterator } from '../paging.ts'
import type { HttpPipeline, OperationOptions } from '../pipeline.ts'

const enc = encodeURIComponent

/** Toda a alteração de administração exige uma justificação (fica na auditoria). Mínimo 10 caracteres. */
export interface Justified {
  reason: string
}

export interface ListUsersOptions extends OperationOptions {
  /** Procura no nome, email ou id. */
  search?: string | undefined
  role?: string | undefined
  status?: 'active' | 'suspended' | undefined
}

export interface ListAuditOptions extends OperationOptions {
  /** Prefixo da ação, ex.: `user.` ou `approval.`. */
  action?: string | undefined
  outcome?: 'success' | 'denied' | 'error' | undefined
  actorId?: string | undefined
  /** Máximo de entradas (1–500, por omissão 100), das mais recentes. */
  limit?: number | undefined
}

/**
 * Consola de administração. Exige sessão iniciada com passkey e uma função de staff.
 * Alterações exigem login recente (step-up); se falhar, recebes `PermissionDeniedError`.
 */
export class AdminOperations {
  private readonly http: HttpPipeline

  constructor(http: HttpPipeline) {
    this.http = http
  }

  /** Quem sou, as minhas funções e permissões, e quanto tempo resta à sessão. */
  me(options?: OperationOptions): Promise<AdminMe> {
    return this.http.send({ method: 'GET', path: '/api/admin/me', options })
  }

  overview(options?: OperationOptions): Promise<Overview> {
    return this.http.send({ method: 'GET', path: '/api/admin/overview', options })
  }

  roles(options?: OperationOptions): Promise<Roles> {
    return this.http.send({ method: 'GET', path: '/api/admin/roles', options })
  }

  securityPosture(options?: OperationOptions): Promise<Posture> {
    return this.http.send({ method: 'GET', path: '/api/admin/security', options })
  }

  readonly users = {
    /** Lista paginada. Usa `for await` ou `.byPage()`. */
    list: (opts: ListUsersOptions = {}): PagedAsyncIterableIterator<AdminUser> =>
      pagedIterator(async (token, maxPageSize) => {
        const page = Number(token ?? '1')
        const res = await this.http.send<{ total: number; page: number; page_size: number; items: AdminUser[] }>({
          method: 'GET',
          path: '/api/admin/users',
          query: { q: opts.search, role: opts.role, status: opts.status, page, page_size: maxPageSize },
          options: opts,
        })
        const more = res.page * res.page_size < res.total
        return { items: res.items, total: res.total, continuationToken: more ? String(res.page + 1) : undefined }
      }),

    get: (userId: string, options?: OperationOptions): Promise<UserDetail> =>
      this.http.send({ method: 'GET', path: `/api/admin/users/${enc(userId)}`, options }),

    /** Suspende a conta e termina já todas as sessões dela. */
    suspend: (userId: string, body: Justified, options?: OperationOptions): Promise<UserResult> =>
      this.http.send({ method: 'POST', path: `/api/admin/users/${enc(userId)}/suspend`, body, options }),

    reactivate: (userId: string, body: Justified, options?: OperationOptions): Promise<UserResult> =>
      this.http.send({ method: 'POST', path: `/api/admin/users/${enc(userId)}/reactivate`, body, options }),

    /** Termina todas as sessões da conta, em todos os dispositivos. */
    revokeSessions: (userId: string, body: Justified, options?: OperationOptions): Promise<{ ok: true }> =>
      this.http.send({ method: 'POST', path: `/api/admin/users/${enc(userId)}/revoke-sessions`, body, options }),

    /**
     * Define as funções da conta. Funções privilegiadas (owner, admin) não são aplicadas
     * logo: ficam em `pending_approvals` à espera de outro proprietário (regra das duas pessoas).
     */
    setRoles: (userId: string, body: Justified & { roles: string[] }, options?: OperationOptions): Promise<RolesResult> =>
      this.http.send({ method: 'POST', path: `/api/admin/users/${enc(userId)}/roles`, body, options }),
  }

  readonly approvals = {
    list: async (options?: OperationOptions): Promise<Approval[]> =>
      (await this.http.send<{ items: Approval[] }>({ method: 'GET', path: '/api/admin/approvals', options })).items,

    /** Aprova ou rejeita. Quem pediu não pode decidir. */
    decide: (
      requestId: string,
      body: { approve: boolean; note?: string | undefined },
      options?: OperationOptions,
    ): Promise<DecisionResult> =>
      this.http.send({
        method: 'POST',
        path: `/api/admin/approvals/${enc(requestId)}/decide`,
        body: { approve: body.approve, note: body.note ?? '' },
        options,
      }),
  }

  readonly audit = {
    list: async (opts: ListAuditOptions = {}): Promise<{ total: number; items: AuditEntry[] }> =>
      this.http.send({
        method: 'GET',
        path: '/api/admin/audit',
        query: { action: opts.action, outcome: opts.outcome, actor: opts.actorId, limit: opts.limit },
        options: opts,
      }),

    /** Verifica a cadeia HMAC. `valid: false` indica adulteração a partir de `broken_at`. */
    verify: (options?: OperationOptions): Promise<ChainStatus> =>
      this.http.send({ method: 'GET', path: '/api/admin/audit/verify', options }),

    /** CSV completo da auditoria (protegido contra injeção de fórmulas). */
    export: (options?: OperationOptions): Promise<Blob> =>
      this.http.send({ method: 'GET', path: '/api/admin/audit/export', responseType: 'blob', options }),
  }

  readonly waitlist = {
    overview: (options?: OperationOptions): Promise<WaitlistOverview> =>
      this.http.send({ method: 'GET', path: '/api/admin/waitlist', options }),

    export: (options?: OperationOptions): Promise<Blob> =>
      this.http.send({ method: 'GET', path: '/api/admin/waitlist/export', responseType: 'blob', options }),

    /** Direito ao apagamento. A auditoria guarda só uma referência cifrada do email. */
    delete: (body: Justified & { email: string }, options?: OperationOptions): Promise<{ ok: true }> =>
      this.http.send({ method: 'POST', path: '/api/admin/waitlist/delete', body, options }),
  }
}

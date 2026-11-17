/**
 * Hierarquia de erros do SDK.
 *
 * Todos herdam de {@link LusorbeError}, por isso basta um `catch` para tudo,
 * ou `instanceof` para tratar casos específicos:
 *
 * ```ts
 * try {
 *   await client.admin.users.suspend(id, { reason })
 * } catch (err) {
 *   if (err instanceof RateLimitError) wait(err.retryAfterSeconds)
 *   else if (err instanceof PermissionDeniedError) showForbidden()
 *   else throw err
 * }
 * ```
 */

/** Detalhe de um campo inválido (respostas 422 da API). */
export interface FieldError {
  /** Caminho do campo, ex.: `["body", "email"]`. */
  location: (string | number)[]
  message: string
  type: string
}

export class LusorbeError extends Error {
  override name = 'LusorbeError'
}

/** A API respondeu com um código de erro (4xx ou 5xx). */
export class ApiError extends LusorbeError {
  override name = 'ApiError'
  /** Código HTTP. */
  readonly status: number
  /** Método e caminho do pedido, ex.: `POST /api/waitlist`. Nunca inclui o corpo. */
  readonly operation: string
  /** Corpo da resposta já interpretado (JSON) ou texto, para diagnóstico. */
  readonly body: unknown
  /** Identificador do pedido, quando a API o devolve (cabeçalho `x-request-id`). */
  readonly requestId: string | undefined

  constructor(message: string, init: { status: number; operation: string; body: unknown; requestId?: string | undefined }) {
    super(message)
    this.status = init.status
    this.operation = init.operation
    this.body = init.body
    this.requestId = init.requestId
  }
}

/** 401 — não há sessão válida, ou expirou. */
export class AuthenticationError extends ApiError {
  override name = 'AuthenticationError'
}

/** 403 — sessão válida mas sem permissão, origem não permitida, ou é preciso voltar a autenticar (step-up). */
export class PermissionDeniedError extends ApiError {
  override name = 'PermissionDeniedError'
}

/** 404 — o recurso não existe (ou, na administração, a conta não tem acesso). */
export class NotFoundError extends ApiError {
  override name = 'NotFoundError'
}

/** 409 — conflito de estado, ex.: pedido já decidido ou conta alterada noutro pedido. */
export class ConflictError extends ApiError {
  override name = 'ConflictError'
}

/** 422 — dados do pedido inválidos. Ver {@link ValidationError.fields}. */
export class ValidationError extends ApiError {
  override name = 'ValidationError'
  readonly fields: FieldError[]

  constructor(message: string, init: ConstructorParameters<typeof ApiError>[1] & { fields: FieldError[] }) {
    super(message, init)
    this.fields = init.fields
  }
}

/** 429 — demasiados pedidos. Esperar {@link RateLimitError.retryAfterSeconds} antes de repetir. */
export class RateLimitError extends ApiError {
  override name = 'RateLimitError'
  readonly retryAfterSeconds: number | undefined

  constructor(message: string, init: ConstructorParameters<typeof ApiError>[1] & { retryAfterSeconds?: number | undefined }) {
    super(message, init)
    this.retryAfterSeconds = init.retryAfterSeconds
  }
}

/** 5xx — falha do servidor. O SDK já tentou de novo antes de lançar isto. */
export class ServerError extends ApiError {
  override name = 'ServerError'
}

/** Não houve resposta: sem rede, DNS, CORS ou ligação cortada. */
export class ConnectionError extends LusorbeError {
  override name = 'ConnectionError'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** O pedido excedeu o tempo limite (`timeoutMs`). */
export class TimeoutError extends LusorbeError {
  override name = 'TimeoutError'
}

/** O pedido foi cancelado pelo chamador (`abortSignal`). */
export class AbortError extends LusorbeError {
  override name = 'AbortError'
}

function parseFieldErrors(detail: unknown): FieldError[] {
  if (!Array.isArray(detail)) return []
  return detail
    .filter((d): d is { loc?: unknown; msg?: unknown; type?: unknown } => typeof d === 'object' && d !== null)
    .map((d) => ({
      location: Array.isArray(d.loc) ? (d.loc as (string | number)[]) : [],
      message: typeof d.msg === 'string' ? d.msg : 'Valor inválido.',
      type: typeof d.type === 'string' ? d.type : 'invalid',
    }))
}

/** Converte uma resposta de erro da API no erro tipado certo. */
export function errorFromResponse(
  status: number,
  operation: string,
  body: unknown,
  headers: Headers,
): ApiError {
  const detail = typeof body === 'object' && body !== null ? (body as { detail?: unknown }).detail : undefined
  const fields = parseFieldErrors(detail)
  const message =
    typeof detail === 'string'
      ? detail
      : fields.length
        ? `Pedido inválido: ${fields.map((f) => `${f.location.filter((l) => l !== 'body').join('.')}: ${f.message}`).join('; ')}`
        : `${operation} falhou com o código ${status}.`
  const init = { status, operation, body, requestId: headers.get('x-request-id') ?? undefined }

  if (status === 401) return new AuthenticationError(message, init)
  if (status === 403) return new PermissionDeniedError(message, init)
  if (status === 404) return new NotFoundError(message, init)
  if (status === 409) return new ConflictError(message, init)
  if (status === 422) return new ValidationError(message, { ...init, fields })
  if (status === 429) return new RateLimitError(message, { ...init, retryAfterSeconds: parseRetryAfter(headers) })
  if (status >= 500) return new ServerError(message, init)
  return new ApiError(message, init)
}

/** Lê `Retry-After` em segundos ou data HTTP. */
export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(raw)
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000))
}

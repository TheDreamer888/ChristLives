/**
 * Motor de pedidos HTTP do SDK.
 *
 * Segue as Azure SDK Design Guidelines para a política de novas tentativas:
 * espera exponencial com variação aleatória (jitter), respeito por `Retry-After`,
 * e só repete o que é seguro repetir:
 *   - métodos idempotentes (GET, HEAD, PUT, DELETE, OPTIONS) em 408/500/502/503/504 e falhas de rede;
 *   - qualquer método em 429, porque a API rejeita antes de processar.
 * Um POST que falhou a meio nunca é repetido em silêncio.
 */
import {
  AbortError,
  ConnectionError,
  LusorbeError,
  TimeoutError,
  errorFromResponse,
  parseRetryAfter,
} from './errors.ts'
import { SDK_VERSION } from './version.ts'

export interface RetryOptions {
  /** Número máximo de novas tentativas (além da primeira). Por omissão 3; 0 desliga. */
  maxRetries?: number | undefined
  /** Espera base em ms antes da 1.ª nova tentativa. Por omissão 800. */
  retryDelayMs?: number | undefined
  /** Espera máxima entre tentativas em ms. Se a API pedir mais, o SDK desiste e lança o erro. Por omissão 30 000. */
  maxRetryDelayMs?: number | undefined
}

export interface RequestInfo {
  method: string
  url: string
  attempt: number
}

export interface ResponseInfo extends RequestInfo {
  status: number
  durationMs: number
}

export interface Logger {
  /** Recebe só método, caminho, estado e duração. Nunca corpos, cookies nem emails. */
  info(message: string): void
  warn(message: string): void
}

export interface ClientOptions {
  /** Origem da API, ex.: `https://api.exemplo.pt`. Sem barra final. */
  baseUrl: string
  /** Tempo limite por tentativa, em ms. Por omissão 30 000. */
  timeoutMs?: number | undefined
  retry?: RetryOptions | undefined
  /**
   * Envio de cookies. Por omissão `include`: a sessão da Lusorbe é um cookie httpOnly.
   * Usa `omit` para pedidos anónimos (ex.: lista de espera numa página pública).
   */
  credentials?: RequestCredentials | undefined
  /** `fetch` alternativo (testes, proxies, ambientes sem fetch global). */
  fetch?: typeof fetch | undefined
  /** Identifica a tua aplicação na telemetria (só em Node). Ex.: `"painel-escolas/2.1"`. */
  applicationId?: string | undefined
  logger?: Logger | undefined
  /** Chamado antes de cada tentativa. */
  onRequest?: ((info: RequestInfo) => void) | undefined
  /** Chamado depois de cada resposta (incluindo erros HTTP). */
  onResponse?: ((info: ResponseInfo) => void) | undefined
}

export interface OperationOptions {
  /** Cancela o pedido. */
  abortSignal?: AbortSignal | undefined
  /** Substitui o tempo limite do cliente só para esta chamada. */
  timeoutMs?: number | undefined
}

type Query = Record<string, string | number | boolean | undefined>

interface SendRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query?: Query | undefined
  body?: unknown
  /** `json` (por omissão) ou `blob` para downloads. */
  responseType?: 'json' | 'blob' | undefined
  options?: OperationOptions | undefined
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'])
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504])
const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined'

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError('Pedido cancelado.'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new AbortError('Pedido cancelado.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export class HttpPipeline {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly retryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly credentials: RequestCredentials
  private readonly options: ClientOptions
  private readonly userAgent: string

  constructor(options: ClientOptions) {
    if (!options.baseUrl) throw new LusorbeError('baseUrl é obrigatório.')
    let parsed: URL
    try {
      parsed = new URL(options.baseUrl)
    } catch {
      throw new LusorbeError(`baseUrl inválido: ${options.baseUrl}`)
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    if (parsed.protocol !== 'https:' && !local) {
      throw new LusorbeError('baseUrl tem de usar https (http só é aceite para localhost).')
    }
    this.baseUrl = parsed.origin
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxRetries = Math.max(0, options.retry?.maxRetries ?? 3)
    this.retryDelayMs = options.retry?.retryDelayMs ?? 800
    this.maxRetryDelayMs = options.retry?.maxRetryDelayMs ?? 30_000
    this.credentials = options.credentials ?? 'include'
    this.options = options
    const app = options.applicationId ? `${options.applicationId} ` : ''
    const nodeVersion = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node
    const runtime = nodeVersion ? `node/${nodeVersion}` : 'js'
    this.userAgent = `${app}lusorbe-sdk-js/${SDK_VERSION} (${runtime})`
  }

  /** Espera exponencial com jitter de ±20 %, limitada a maxRetryDelayMs. */
  private backoff(attempt: number): number {
    const exp = this.retryDelayMs * 2 ** attempt
    const jitter = exp * (0.8 + Math.random() * 0.4)
    return Math.min(this.maxRetryDelayMs, Math.round(jitter))
  }

  async send<T>(req: SendRequest): Promise<T> {
    const url = new URL(req.path, this.baseUrl)
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
    }
    const operation = `${req.method} ${url.pathname}`
    const headers: Record<string, string> = { Accept: req.responseType === 'blob' ? '*/*' : 'application/json' }
    if (req.body !== undefined) headers['Content-Type'] = 'application/json'
    // Em browsers, um cabeçalho próprio obrigaria a um pedido CORS extra (preflight) por chamada.
    if (!isBrowser) headers['User-Agent'] = this.userAgent

    const userSignal = req.options?.abortSignal
    const timeoutMs = req.options?.timeoutMs ?? this.timeoutMs

    for (let attempt = 0; ; attempt++) {
      if (userSignal?.aborted) throw new AbortError('Pedido cancelado.')
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout
      const info: RequestInfo = { method: req.method, url: url.pathname, attempt }
      this.options.onRequest?.(info)
      const started = Date.now()

      let res: Response
      try {
        res = await this.fetchImpl(url, {
          method: req.method,
          headers,
          body: req.body === undefined ? null : JSON.stringify(req.body),
          credentials: this.credentials,
          cache: 'no-store',
          redirect: 'error',
          signal,
        })
      } catch (cause) {
        if (userSignal?.aborted) throw new AbortError('Pedido cancelado.')
        const timedOut = timeout.aborted
        const canRetry = IDEMPOTENT.has(req.method) && attempt < this.maxRetries
        this.options.logger?.warn(`${operation} ${timedOut ? 'excedeu o tempo limite' : 'falhou na rede'} (tentativa ${attempt + 1})`)
        if (canRetry) {
          await sleep(this.backoff(attempt), userSignal)
          continue
        }
        if (timedOut) throw new TimeoutError(`${operation} excedeu ${timeoutMs} ms.`)
        throw new ConnectionError(`Sem ligação à API (${operation}).`, { cause })
      }

      const durationMs = Date.now() - started
      this.options.onResponse?.({ ...info, status: res.status, durationMs })
      this.options.logger?.info(`${operation} → ${res.status} em ${durationMs} ms`)

      if (res.ok) {
        if (req.responseType === 'blob') return (await res.blob()) as T
        if (res.status === 204) return undefined as T
        return (await res.json()) as T
      }

      const retryAfter = parseRetryAfter(res.headers)
      const retryable =
        res.status === 429 || (RETRYABLE_STATUS.has(res.status) && IDEMPOTENT.has(req.method))
      if (retryable && attempt < this.maxRetries) {
        const waitMs = retryAfter !== undefined ? retryAfter * 1000 : this.backoff(attempt)
        if (waitMs <= this.maxRetryDelayMs) {
          await res.body?.cancel().catch(() => {})
          await sleep(waitMs, userSignal)
          continue
        }
      }

      const text = await res.text().catch(() => '')
      let body: unknown = text
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        /* corpo não-JSON: fica como texto */
      }
      throw errorFromResponse(res.status, operation, body, res.headers)
    }
  }
}

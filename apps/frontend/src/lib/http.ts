export function resolveApiBase(configured: string | undefined, development: boolean): string {
  return (configured ?? (development ? '' : 'http://localhost:8000')).replace(/\/+$/, '')
}

const API_BASE = resolveApiBase(import.meta.env?.['VITE_API_BASE_URL'], import.meta.env?.DEV ?? false)

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type ApiResponse = { body: unknown; status: number }
const pendingReads = new Map<string, Promise<ApiResponse>>()

async function send(path: string, init: RequestInit): Promise<ApiResponse> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include' })
  } catch (reason) {
    if (reason instanceof TypeError) {
      throw new ApiError('Não foi possível contactar a API. Verifica a ligação e se o serviço está disponível.', 0)
    }
    throw reason
  }
  const text = await response.text()
  let body: unknown
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      if (response.ok) throw new ApiError(`Resposta inválida da API (${response.status})`, response.status)
    }
  }
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null && 'detail' in body ? body.detail : undefined
    throw new ApiError(typeof detail === 'string' ? detail : `Falha no pedido (${response.status})`, response.status)
  }
  return { body, status: response.status }
}

export function request(path: string, init: RequestInit = {}): Promise<ApiResponse> {
  // Apenas leituras sem opções partilham pedidos em curso; nunca há cache de sessão.
  if (Object.keys(init).length) return send(path, init)
  const pending = pendingReads.get(path)
  if (pending) return pending
  const operation = send(path, init).finally(() => pendingReads.delete(path))
  pendingReads.set(path, operation)
  return operation
}

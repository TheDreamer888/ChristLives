import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  AbortError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  LusorbeClient,
  LusorbeError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  SDK_VERSION,
  ServerError,
  TimeoutError,
  ValidationError,
} from '../src/index.ts'

interface Call {
  url: URL
  init: RequestInit
}

/** fetch falso: devolve as respostas por ordem e regista as chamadas. */
function fakeFetch(responses: (Response | Error | ((init: RequestInit) => Promise<Response>))[]) {
  const calls: Call[] = []
  const fn = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(input)), init })
    const next = responses.shift()
    if (!next) throw new Error('sem mais respostas preparadas')
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next(init)
    return next
  }) as typeof fetch
  return { fn, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const fast = { maxRetries: 3, retryDelayMs: 1, maxRetryDelayMs: 50 }
const client = (fetch: typeof globalThis.fetch, extra: Partial<ConstructorParameters<typeof LusorbeClient>[0]> = {}) =>
  new LusorbeClient({ baseUrl: 'https://api.exemplo.pt', fetch, retry: fast, ...extra })

describe('configuração', () => {
  it('exige https fora de localhost', () => {
    assert.throws(() => new LusorbeClient({ baseUrl: 'http://api.exemplo.pt' }), LusorbeError)
    assert.doesNotThrow(() => new LusorbeClient({ baseUrl: 'http://localhost:8000' }))
  })

  it('a versão do SDK bate certo com o package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    assert.equal(SDK_VERSION, pkg.version)
  })
})

describe('pedidos', () => {
  it('envia cookies, JSON e identifica o SDK em Node', async () => {
    const { fn, calls } = fakeFetch([json(202, { ok: true, message: 'Obrigado!' })])
    const res = await client(fn, { applicationId: 'testes/1.0' }).waitlist.join({ email: 'a@b.pt', consent: true })
    assert.equal(res.message, 'Obrigado!')
    const { url, init } = calls[0]!
    assert.equal(url.href, 'https://api.exemplo.pt/api/waitlist')
    assert.equal(init.method, 'POST')
    assert.equal(init.credentials, 'include')
    assert.equal(init.redirect, 'error')
    assert.deepEqual(JSON.parse(String(init.body)), { email: 'a@b.pt', interest: 'outro', consent: true, website: '' })
    const headers = init.headers as Record<string, string>
    assert.match(headers['User-Agent']!, new RegExp(`^testes/1\\.0 lusorbe-sdk-js/${SDK_VERSION} \\(node/`))
  })

  it('codifica ids no caminho e omite filtros vazios', async () => {
    const { fn, calls } = fakeFetch([json(200, { total: 0, items: [] })])
    await client(fn).admin.audit.list({ action: 'user.', outcome: undefined, limit: 20 })
    assert.equal(calls[0]!.url.search, '?action=user.&limit=20')

    const f2 = fakeFetch([json(200, { user: {}, history: [] })])
    await client(f2.fn).admin.users.get('a/b?c')
    assert.equal(f2.calls[0]!.url.pathname, '/api/admin/users/a%2Fb%3Fc')
  })

  it('converte as opções da passkey de JSON para objeto', async () => {
    const { fn } = fakeFetch([json(200, { challenge_id: 'c1', options: '{"challenge":"abc","timeout":60000}' })])
    const res = await client(fn).auth.passkeys.loginOptions('a@b.pt')
    assert.deepEqual(res, { challengeId: 'c1', options: { challenge: 'abc', timeout: 60000 } })
  })
})

describe('erros tipados', () => {
  const cases: [number, unknown, new (...a: never[]) => Error][] = [
    [401, { detail: 'Autentica-te primeiro.' }, AuthenticationError],
    [403, { detail: 'Sem permissão.' }, PermissionDeniedError],
    [404, { detail: 'Not Found' }, NotFoundError],
    [409, { detail: 'Já decidido.' }, ConflictError],
  ]
  for (const [status, body, Kind] of cases) {
    it(`${status} → ${Kind.name}`, async () => {
      const { fn } = fakeFetch([json(status, body)])
      const err = await client(fn).admin.me().catch((e: unknown) => e)
      assert.ok(err instanceof Kind)
      assert.ok(err instanceof LusorbeError)
      assert.equal((err as unknown as { status: number }).status, status)
      assert.equal((err as Error).message, (body as { detail: string }).detail)
      assert.equal((err as unknown as { operation: string }).operation, 'GET /api/admin/me')
    })
  }

  it('422 traz os campos inválidos', async () => {
    const detail = [{ loc: ['body', 'reason'], msg: 'String should have at least 10 characters', type: 'string_too_short' }]
    const { fn } = fakeFetch([json(422, { detail })])
    const err = await client(fn).admin.users.suspend('u1', { reason: 'curto' }).catch((e: unknown) => e)
    assert.ok(err instanceof ValidationError)
    assert.deepEqual(err.fields, [{ location: ['body', 'reason'], message: detail[0]!.msg, type: 'string_too_short' }])
    assert.match(err.message, /reason: String should have/)
  })
})

describe('novas tentativas', () => {
  it('repete um GET em 503 e acaba por ter sucesso', async () => {
    const { fn, calls } = fakeFetch([json(503, {}), json(502, {}), json(200, { score: 90, checks: [] })])
    const res = await client(fn).admin.securityPosture()
    assert.equal(res.score, 90)
    assert.equal(calls.length, 3)
  })

  it('desiste ao fim de maxRetries e lança ServerError', async () => {
    const { fn, calls } = fakeFetch([json(500, {}), json(500, {}), json(500, {}), json(500, { detail: 'boom' })])
    await assert.rejects(client(fn).admin.overview(), ServerError)
    assert.equal(calls.length, 4)
  })

  it('NUNCA repete um POST que falhou com 5xx (pode já ter sido aplicado)', async () => {
    const { fn, calls } = fakeFetch([json(500, { detail: 'erro' })])
    await assert.rejects(client(fn).admin.users.suspend('u1', { reason: 'motivo suficiente' }), ServerError)
    assert.equal(calls.length, 1)
  })

  it('NUNCA repete um POST após falha de rede', async () => {
    const { fn, calls } = fakeFetch([new TypeError('fetch failed')])
    await assert.rejects(client(fn).waitlist.join({ email: 'a@b.pt', consent: true }), ConnectionError)
    assert.equal(calls.length, 1)
  })

  it('repete um GET após falha de rede', async () => {
    const { fn, calls } = fakeFetch([new TypeError('fetch failed'), json(200, null)])
    assert.equal(await client(fn).auth.session(), null)
    assert.equal(calls.length, 2)
  })

  it('429 repete mesmo em POST, respeitando Retry-After', async () => {
    const { fn, calls } = fakeFetch([json(429, { detail: 'Calma.' }, { 'retry-after': '0' }), json(202, { ok: true, message: 'ok' })])
    await client(fn).waitlist.join({ email: 'a@b.pt', consent: true })
    assert.equal(calls.length, 2)
  })

  it('429 com Retry-After maior que o máximo não espera: lança RateLimitError com o tempo', async () => {
    const { fn, calls } = fakeFetch([json(429, { detail: 'Muitas tentativas.' }, { 'retry-after': '120' })])
    const err = await client(fn).waitlist.join({ email: 'a@b.pt', consent: true }).catch((e: unknown) => e)
    assert.ok(err instanceof RateLimitError)
    assert.equal(err.retryAfterSeconds, 120)
    assert.equal(calls.length, 1)
  })

  it('maxRetries: 0 desliga as novas tentativas', async () => {
    const { fn, calls } = fakeFetch([json(503, {})])
    const c = new LusorbeClient({ baseUrl: 'https://api.exemplo.pt', fetch: fn, retry: { maxRetries: 0 } })
    await assert.rejects(c.admin.overview(), ServerError)
    assert.equal(calls.length, 1)
  })
})

describe('tempo limite e cancelamento', () => {
  const hang = (init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })

  it('lança TimeoutError quando a API não responde', async () => {
    const { fn } = fakeFetch([hang, hang, hang, hang])
    await assert.rejects(client(fn, { timeoutMs: 20 }).admin.me(), TimeoutError)
  })

  it('lança AbortError e não repete quando o chamador cancela', async () => {
    const { fn, calls } = fakeFetch([hang])
    const ctrl = new AbortController()
    const p = client(fn).admin.me({ abortSignal: ctrl.signal })
    ctrl.abort()
    await assert.rejects(p, AbortError)
    assert.equal(calls.length, 1)
  })
})

describe('paginação', () => {
  const user = (id: string) => ({ id, email: null, name: null, roles: [], status: 'active', methods: [], mfa: false, passkeys: 0, created_at: 0, last_login_at: null })

  it('for await percorre todas as páginas', async () => {
    const { fn, calls } = fakeFetch([
      json(200, { total: 3, page: 1, page_size: 2, items: [user('a'), user('b')] }),
      json(200, { total: 3, page: 2, page_size: 2, items: [user('c')] }),
    ])
    const ids: string[] = []
    for await (const u of client(fn).admin.users.list({ status: 'active' })) ids.push(u.id)
    assert.deepEqual(ids, ['a', 'b', 'c'])
    assert.equal(calls[1]!.url.searchParams.get('page'), '2')
    assert.equal(calls[1]!.url.searchParams.get('status'), 'active')
  })

  it('byPage respeita maxPageSize e devolve o token para continuar', async () => {
    const { fn, calls } = fakeFetch([json(200, { total: 120, page: 1, page_size: 50, items: [user('a')] })])
    const pages = client(fn).admin.users.list().byPage({ maxPageSize: 50 })
    const first = await pages.next()
    assert.equal(calls[0]!.url.searchParams.get('page_size'), '50')
    assert.equal(first.value?.continuationToken, '2')
    assert.equal(first.value?.total, 120)
  })
})

describe('downloads', () => {
  it('export devolve um Blob', async () => {
    const { fn } = fakeFetch([new Response('seq,ts\n1,2\n', { status: 200, headers: { 'content-type': 'text/csv' } })])
    const blob = await client(fn).admin.audit.export()
    assert.equal(await blob.text(), 'seq,ts\n1,2\n')
  })
})

describe('assistant', () => {
  it('envia a conversa com consentimento e não repete o POST num 503', async () => {
    const { fn, calls } = fakeFetch([json(503, { detail: 'O assistente não está disponível neste momento.' })])
    await assert.rejects(
      client(fn).assistant.send({ messages: [{ role: 'user', content: 'Olá' }], consent: true }),
      ServerError,
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url.pathname, '/api/assistant/messages')
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { messages: [{ role: 'user', content: 'Olá' }], consent: true })
  })

  it('expõe o Retry-After do limite diário', async () => {
    const { fn } = fakeFetch([json(429, { detail: 'Limite' }, { 'retry-after': '120' })])
    const err = await client(fn, { retry: { maxRetries: 0 } })
      .assistant.send({ messages: [{ role: 'user', content: 'Olá' }], consent: true })
      .catch((e: unknown) => e)
    assert.ok(err instanceof RateLimitError)
    assert.equal(err.retryAfterSeconds, 120)
  })
})

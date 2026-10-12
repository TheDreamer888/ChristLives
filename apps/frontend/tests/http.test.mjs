import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, request, resolveApiBase } from '../src/lib/http.ts'

test('development uses the frontend origin while explicit API origins stay unchanged', () => {
  assert.equal(resolveApiBase(undefined, true), '')
  assert.equal(resolveApiBase('', true), '')
  assert.equal(resolveApiBase('https://api.example.test///', true), 'https://api.example.test')
  assert.equal(resolveApiBase('https://api.example.test/', false), 'https://api.example.test')
  assert.equal(resolveApiBase(undefined, false), 'http://localhost:8000')
})

test('concurrent reads share one request but subsequent reads revalidate the session', async t => {
  let resolveResponse
  let calls = 0
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    assert.equal(init.credentials, 'include')
    calls += 1
    return new Promise(resolve => { resolveResponse = resolve })
  })
  const first = request('/api/auth/session')
  const second = request('/api/auth/session')
  assert.equal(first, second)
  assert.equal(calls, 1)
  resolveResponse(Response.json(null))
  assert.deepEqual(await first, { body: null, status: 200 })
  await second
  const next = request('/api/auth/session')
  assert.equal(calls, 2)
  resolveResponse(Response.json({ id: 'test-user' }))
  assert.deepEqual(await next, { body: { id: 'test-user' }, status: 200 })
})

test('unauthorized reads preserve status and can be retried without cached failures', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    return calls === 1
      ? Response.json({ detail: 'Inicia sessão para continuar.' }, { status: 401 })
      : Response.json([])
  })
  await assert.rejects(request('/api/agency/agencies'), error =>
    error instanceof ApiError && error.status === 401 && error.message === 'Inicia sessão para continuar.')
  assert.deepEqual(await request('/api/agency/agencies'), { body: [], status: 200 })
  assert.equal(calls, 2)
})

test('network failures and invalid JSON do not become anonymous sessions', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch') })
  await assert.rejects(request('/api/auth/session'), error => error instanceof ApiError && error.status === 0)
  mock.mock.mockImplementation(async () => new Response('<html>not an API</html>'))
  await assert.rejects(request('/api/auth/session'), error =>
    error instanceof ApiError && error.message.includes('Resposta inválida'))
})

test('mutations remain independent and preserve JSON bodies and cookies', async t => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.credentials, 'include')
    assert.equal(init.headers['Content-Type'], 'application/json')
    bodies.push(JSON.parse(init.body))
    return Response.json({ ok: true })
  })
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terms_accepted: true, privacy_accepted: true }),
  }
  await Promise.all([request('/api/auth/consent', init), request('/api/auth/consent', init)])
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0], { terms_accepted: true, privacy_accepted: true })
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSupervision } from '../src/lib/aiApi.ts'
import { securityClient } from '../src/lib/api.ts'

test('supervision verdicts are closed values; anything else is ignored', () => {
  assert.deepEqual(parseSupervision({ status: 'blocked', categories: ['promessa_financeira', 3], reason: 'x' }), {
    status: 'blocked', categories: ['promessa_financeira'], reason: 'x',
  })
  assert.equal(parseSupervision({ status: 'trust-me' }), null)
  assert.equal(parseSupervision(null), null)
})

test('security client calls the real endpoints with session cookies', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([new URL(url, 'http://localhost').pathname + new URL(url, 'http://localhost').search, init.method ?? 'GET', init.credentials])
    if (String(url).includes('/status')) {
      return Response.json({ firewall: { enabled: true }, supervisor: { enabled: false, model: null }, admin_configured: false })
    }
    return Response.json({ blocks: [], events: [] })
  })
  assert.equal((await securityClient.status()).firewall.enabled, true)
  await securityClient.addBlock('203.0.113.7', 'scanner', 60)
  await securityClient.removeBlock('203.0.113.0/24')
  assert.deepEqual(calls, [
    ['/api/security/status', 'GET', 'include'],
    ['/api/security/firewall/blocks', 'POST', 'include'],
    ['/api/security/firewall/blocks?network=203.0.113.0%2F24', 'DELETE', 'include'],
  ])
})

test('invalid status payloads are rejected', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ firewall: 'nope' }))
  await assert.rejects(securityClient.status())
})

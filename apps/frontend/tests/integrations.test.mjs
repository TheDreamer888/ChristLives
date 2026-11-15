import assert from 'node:assert/strict'
import test from 'node:test'
import { INTEGRATIONS, filterIntegrations, integrationStatus } from '../src/lib/integrations.ts'

test('catalog distinguishes planned connectors from implemented server capability', () => {
  assert.equal(new Set(INTEGRATIONS.map(item => item.id)).size, INTEGRATIONS.length)
  assert.deepEqual(INTEGRATIONS.filter(item => item.implementation === 'server').map(item => item.id), ['ai'])
  for (const item of INTEGRATIONS) {
    assert.equal(new URL(item.url).protocol, 'https:')
    assert.ok(item.requirements.length >= 3)
    if (item.implementation === 'planned') {
      for (const status of ['checking', 'configured', 'not-configured', 'sign-in', 'unavailable']) {
        assert.equal(integrationStatus(item, status), 'Planeada')
      }
    }
  }
})

test('AI configuration is never described as a verified connection', () => {
  const ai = INTEGRATIONS.find(item => item.id === 'ai')
  assert.equal(integrationStatus(ai, 'configured'), 'Configurada no servidor')
  assert.equal(integrationStatus(ai, 'not-configured'), 'Não configurada')
  assert.equal(integrationStatus(ai, 'unavailable'), 'Estado indisponível')
  assert.equal(integrationStatus(ai, 'sign-in'), 'Inicia sessão para verificar')
  assert.equal(integrationStatus(ai, 'checking'), 'A verificar configuração')
})

test('catalog filters combine search and category without mutating entries', () => {
  assert.equal(filterIntegrations('', 'Todas').length, 5)
  assert.deepEqual(filterIntegrations('  DROPBOX ', 'Cloud').map(item => item.id), ['dropbox'])
  assert.deepEqual(filterIntegrations('Word', 'Cloud'), [])
  assert.deepEqual(filterIntegrations('antivírus', 'Segurança').map(item => item.id), ['antivirus'])
  assert.deepEqual(filterIntegrations('inexistente', 'Todas'), [])
  assert.equal(INTEGRATIONS.length, 5)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import viteConfig from '../vite.config.ts'

test('dev proxy forwards only /api, to an explicit IPv4 backend by default', () => {
  const previous = process.env['VITE_API_PROXY_TARGET']
  delete process.env['VITE_API_PROXY_TARGET']
  try {
    const config = viteConfig({ mode: 'test' })
    assert.deepEqual(Object.keys(config.server.proxy), ['/api'])
    assert.equal(config.server.proxy['/api'].target, 'http://127.0.0.1:8000')
  } finally {
    if (previous !== undefined) process.env['VITE_API_PROXY_TARGET'] = previous
  }
})

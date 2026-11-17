import assert from 'node:assert/strict'
import test from 'node:test'
import { toCreationOptions, toRequestOptions } from '../src/auth/webauthn.ts'

// Formato real devolvido pelo servidor (py_webauthn options_to_json): ao nível de topo, sem `publicKey`.
const serverCreation = {
  challenge: 'AQID',
  rp: { id: 'localhost', name: 'Lusorbe' },
  user: { id: 'dTE', name: 'a@b.pt', displayName: 'a@b.pt' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  excludeCredentials: [{ type: 'public-key', id: 'AQI' }],
  timeout: 60000,
}

const bytes = (buf) => [...new Uint8Array(buf)]

test('opções de registo do servidor (sem publicKey) são convertidas', () => {
  const o = toCreationOptions(serverCreation)
  assert.deepEqual(bytes(o.challenge), [1, 2, 3])
  assert.deepEqual(bytes(o.user.id), [117, 49])
  assert.deepEqual(bytes(o.excludeCredentials[0].id), [1, 2])
  assert.equal(o.rp.name, 'Lusorbe')
})

test('aceita também o formato antigo com invólucro publicKey', () => {
  const o = toCreationOptions({ publicKey: serverCreation })
  assert.deepEqual(bytes(o.challenge), [1, 2, 3])
})

test('opções de login: challenge e allowCredentials convertidos; sem lista não cria a chave', () => {
  const o = toRequestOptions({ challenge: 'AQID', rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: 'AQI' }] })
  assert.deepEqual(bytes(o.challenge), [1, 2, 3])
  assert.deepEqual(bytes(o.allowCredentials[0].id), [1, 2])
  assert.equal('allowCredentials' in toRequestOptions({ challenge: 'AQID' }), false)
})

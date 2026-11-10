
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import {
  decryptPreference,
  encryptPreference,
  getLookupKey,
} from '../convex/encryption.ts'

const MASTER_KEY_ENV = 'CONVEX_PREFERENCES_MASTER_KEY_V1'

const preference = Object.freeze({
  owner: 'issuer|subject',
  product: 'veytrion',
  locale: 'pt-PT',
})

function generateKey() {
  return randomBytes(32).toString('base64')
}

function configureKey(t, key = generateKey()) {
  const previous = process.env[MASTER_KEY_ENV]

  t.after(() => {
    if (previous === undefined) {
      delete process.env[MASTER_KEY_ENV]
    } else {
      process.env[MASTER_KEY_ENV] = previous
    }
  })

  if (key === null) {
    delete process.env[MASTER_KEY_ENV]
  } else {
    process.env[MASTER_KEY_ENV] = key
  }
}

function hasErrorMessage(expected) {
  return error =>
    error instanceof Error && error.message === expected
}

function corruptBase64(value) {
  const bytes = Buffer.from(value, 'base64')

  assert.ok(bytes.length > 0, 'Conteúdo cifrado vazio')

  bytes[0] = bytes[0] ^ 0x01

  return bytes.toString('base64')
}

// 1. Confidencialidade e recuperação
test('cifra e recupera todos os campos', async t => {
  configureKey(t)

  const encrypted = await encryptPreference(preference)
  const serialized = JSON.stringify(encrypted)

  assert.equal(encrypted.keyVersion, 'v1')

  for (const value of Object.values(preference)) {
    assert.equal(
      serialized.includes(value),
      false,
      `Campo exposto no payload: ${value}`,
    )
  }

  const decrypted = await decryptPreference(encrypted)

  assert.deepEqual(decrypted, preference)
})

// 2. Aleatoriedade do IV
test('gera IV e ciphertext diferentes', async t => {
  configureKey(t)

  const samples = await Promise.all(
    Array.from({ length: 10 }, () =>
      encryptPreference(preference),
    ),
  )

  const ivs = new Set(samples.map(item => item.iv))
  const ciphertexts = new Set(
    samples.map(item => item.ciphertext),
  )

  assert.equal(ivs.size, samples.length)
  assert.equal(ciphertexts.size, samples.length)
})

// 3. HMAC determinístico
test('mantém lookupKey estável', async t => {
  configureKey(t)

  const first = await encryptPreference(preference)
  const second = await encryptPreference(preference)

  const expected = await getLookupKey(
    preference.owner,
    preference.product,
  )

  assert.equal(first.lookupKey, second.lookupKey)
  assert.equal(first.lookupKey, expected)
})

// 4. Separação de identidades e produtos
test('separa índices por owner e product', async t => {
  configureKey(t)

  const original = await getLookupKey(
    preference.owner,
    preference.product,
  )

  const differentOwner = await getLookupKey(
    'different-owner',
    preference.product,
  )

  const differentProduct = await getLookupKey(
    preference.owner,
    'different-product',
  )

  assert.notEqual(original, differentOwner)
  assert.notEqual(original, differentProduct)
})

// 5. Prevenção de colisões por concatenação
test('distingue componentes com delimitadores', async t => {
  configureKey(t)

  const first = await getLookupKey('a|b', 'c')
  const second = await getLookupKey('a', 'b|c')

  assert.notEqual(first, second)
})

// 6. Integridade do ciphertext
test('rejeita ciphertext adulterado', async t => {
  configureKey(t)

  const encrypted = await encryptPreference(preference)

  const corrupted = {
    ...encrypted,
    ciphertext: corruptBase64(encrypted.ciphertext),
  }

  await assert.rejects(
    decryptPreference(corrupted),
    hasErrorMessage('PREFERENCES_DECRYPTION_FAILED'),
  )
})

// 7. Integridade do IV
test('rejeita IV adulterado', async t => {
  configureKey(t)

  const encrypted = await encryptPreference(preference)

  const corrupted = {
    ...encrypted,
    iv: corruptBase64(encrypted.iv),
  }

  await assert.rejects(
    decryptPreference(corrupted),
    hasErrorMessage('PREFERENCES_DECRYPTION_FAILED'),
  )
})

// 8. Isolamento criptográfico entre chaves
test('não decifra com outra master key', async t => {
  configureKey(t)

  const encrypted = await encryptPreference(preference)

  process.env[MASTER_KEY_ENV] = generateKey()

  await assert.rejects(
    decryptPreference(encrypted),
    hasErrorMessage('PREFERENCES_DECRYPTION_FAILED'),
  )
})

// 9. Ausência de chave
test('falha quando a master key está ausente', async t => {
  configureKey(t, null)

  await assert.rejects(
    encryptPreference(preference),
    hasErrorMessage('PREFERENCES_ENCRYPTION_KEY_MISSING'),
  )
})

// 10. Validação de comprimento da chave
test('rejeita uma master key de 128 bits', async t => {
  configureKey(t, randomBytes(16).toString('base64'))

  await assert.rejects(
    encryptPreference(preference),
  )
})

// 11. Suporte a caracteres Unicode
test('preserva corretamente Unicode', async t => {
  configureKey(t)

  const unicodePreference = {
    ...preference,
    owner: 'emissor|utilizador-ação-日本',
  }

  const encrypted = await encryptPreference(unicodePreference)
  const decrypted = await decryptPreference(encrypted)

  assert.deepEqual(decrypted, unicodePreference)
})

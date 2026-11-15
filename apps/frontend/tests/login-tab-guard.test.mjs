import assert from 'node:assert/strict'
import test from 'node:test'
import { runUnauthenticatedGuard } from '../src/lib/loginTabGuard.ts'

test('records consent before unauthenticated action', async () => {
  const steps = []
  const consentArgs = []

  await runUnauthenticatedGuard(
    false,
    true,
    true,
    async (termsAccepted, privacyAccepted) => {
      steps.push('consent')
      consentArgs.push([termsAccepted, privacyAccepted])
    },
    async () => {
      steps.push('action')
    },
  )

  assert.deepEqual(consentArgs, [[true, true]])
  assert.deepEqual(steps, ['consent', 'action'])
})

test('does not start action when consent recording fails', async () => {
  const boom = new Error('falha ao gravar consentimento')
  let actionStarted = false

  await assert.rejects(
    runUnauthenticatedGuard(
      false,
      true,
      true,
      async () => {
        throw boom
      },
      async () => {
        actionStarted = true
      },
    ),
    boom,
  )

  assert.equal(actionStarted, false)
})

test('blocks unauthenticated action when mandatory consents are missing', async () => {
  let consentCalls = 0
  let actionStarted = false

  await assert.rejects(
    runUnauthenticatedGuard(
      false,
      true,
      false,
      async () => {
        consentCalls += 1
      },
      async () => {
        actionStarted = true
      },
    ),
    {
      message: 'Aceita os Termos e a Política de Privacidade para continuar.',
    },
  )

  assert.equal(consentCalls, 0)
  assert.equal(actionStarted, false)
})

test('does not record consent when session already exists', async () => {
  let consentCalls = 0
  let actionStarted = false

  await runUnauthenticatedGuard(
    true,
    true,
    true,
    async () => {
      consentCalls += 1
    },
    async () => {
      actionStarted = true
    },
  )

  assert.equal(consentCalls, 0)
  assert.equal(actionStarted, true)
})

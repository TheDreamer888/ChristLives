import assert from 'node:assert/strict'
import test from 'node:test'
import { DECISION_CHECKS, summarizeDecision } from '../src/lib/decision.ts'

test('checklist ids are unique and copy is present', () => {
  assert.equal(new Set(DECISION_CHECKS.map(check => check.id)).size, DECISION_CHECKS.length)
  for (const check of DECISION_CHECKS) {
    assert.ok(check.title.trim().length > 0)
    assert.ok(check.text.trim().length > 0)
  }
})

test('empty checklist asks for a pause and lists every pending item', () => {
  const summary = summarizeDecision([])
  assert.equal(summary.level, 'pause')
  assert.equal(summary.done, 0)
  assert.equal(summary.percent, 0)
  assert.equal(summary.pending.length, DECISION_CHECKS.length)
})

test('partial and complete checklists move through review to ready', () => {
  const ids = DECISION_CHECKS.map(check => check.id)
  assert.equal(summarizeDecision(ids.slice(0, 2)).level, 'pause')
  assert.equal(summarizeDecision(ids.slice(0, 3)).level, 'review')
  const ready = summarizeDecision(ids)
  assert.equal(ready.level, 'ready')
  assert.equal(ready.percent, 100)
  assert.deepEqual(ready.pending, [])
})

test('unknown and duplicated ids are ignored', () => {
  const first = DECISION_CHECKS[0].id
  const summary = summarizeDecision([first, first, 'inexistente'])
  assert.equal(summary.done, 1)
  assert.equal(summary.percent, 20)
})

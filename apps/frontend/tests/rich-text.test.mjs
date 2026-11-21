import assert from 'node:assert/strict'
import test from 'node:test'
import { hasMath, parseInline, parseRich } from '../src/lib/richText.ts'

test('separa fórmulas em bloco, código e parágrafos', () => {
  const b = parseRich('Temos:\n$$x = \\frac{-b}{2a}$$\nE código:\n```python\nprint(1)\n```\nFim.')
  assert.deepEqual(b.map(x => x.kind), ['para', 'math', 'para', 'codeblock', 'para'])
  assert.equal(b[1].value, 'x = \\frac{-b}{2a}')
  assert.equal(b[3].lang, 'python')
  assert.equal(b[3].value, 'print(1)')
  assert.ok(hasMath(b))
})

test('fórmulas na linha, negrito e código', () => {
  const p = parseInline('Se $a^2+b^2=c^2$ então **ok** com `x`.')
  assert.deepEqual(p.map(x => x.kind), ['text', 'math', 'text', 'bold', 'text', 'code', 'text'])
})

test('preços com $ não viram fórmulas', () => {
  const p = parseInline('Custa $5 e depois $10 por mês.')
  assert.ok(p.every(x => x.kind === 'text'))
  assert.equal(hasMath(parseRich('Custa $5 e depois $10.')), false)
})

test('HTML do modelo fica como texto', () => {
  const b = parseRich('<img src=x onerror=alert(1)>')
  assert.equal(b[0].kind, 'para')
  assert.deepEqual(b[0].parts, [{ kind: 'text', value: '<img src=x onerror=alert(1)>' }])
})
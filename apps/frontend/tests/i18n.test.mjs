import assert from 'node:assert/strict'
import test from 'node:test'
import { LANGS, detectLang } from '../src/i18n/langs.ts'
import pt from '../src/i18n/pt-PT.ts'
import en from '../src/i18n/en.ts'
import es from '../src/i18n/es.ts'
import fr from '../src/i18n/fr.ts'
import de from '../src/i18n/de.ts'
import ptBR from '../src/i18n/pt-BR.ts'

test('escolhe a língua guardada, depois a do navegador, depois pt-PT', () => {
  assert.equal(detectLang('fr', ['en-US']), 'fr')
  assert.equal(detectLang(null, ['de-AT', 'en']), 'de')
  assert.equal(detectLang(null, ['pt-BR']), 'pt-BR')
  assert.equal(detectLang(null, ['pt']), 'pt-PT')
  assert.equal(detectLang('xx', ['ja', 'zh']), 'pt-PT')
})

/** Lista "caminho → tipo" de todas as folhas, para comparar a forma das traduções. */
function shape(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k
    if (Array.isArray(v)) return [`${p}:array(${v.length})`]
    if (v && typeof v === 'object') return shape(v, p)
    return [`${p}:${typeof v}`]
  }).sort()
}

test('todas as línguas têm exatamente as mesmas chaves que o pt-PT', () => {
  const base = shape(pt)
  const all = { en, es, fr, de, 'pt-BR': ptBR }
  assert.equal(Object.keys(all).length + 1, LANGS.length)
  for (const [code, msgs] of Object.entries(all)) assert.deepEqual(shape(msgs), base, code)
})

test('as funções de texto funcionam em todas as línguas', () => {
  for (const msgs of [pt, en, es, fr, de, ptBR]) {
    assert.match(msgs.security.signals(3), /3/)
    assert.match(msgs.assistant.perDay(30), /30/)
    assert.match(msgs.login.continueWith('GitHub'), /GitHub/)
  }
})
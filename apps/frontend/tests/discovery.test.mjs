import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BIBLE_BOOKS,
  audienceSearchLinks,
  bibleBookSearchLinks,
  discoveryPack,
  formatVerseRef,
  isPortugueseLocation,
  marketSearchLinks,
  parseVerseRef,
  secondHandLinks,
  shopSearchLinks,
  verseLinks,
  verseOfTheDay,
  DAILY_VERSES,
} from '../src/lib/discovery.ts'

const allHttps = links => links.every(link => new URL(link.href).protocol === 'https:')

// ---- testes originais ------------------------------------------------------

test('market search links keep the query encoded and use known destinations', () => {
  const links = marketSearchLinks('Bíblia para crianças & estudo')
  assert.deepEqual(links.map(link => link.label), ['Google Shopping', 'Amazon.es', 'Wook', 'Bertrand'])
  assert.ok(allHttps(links))
  assert.ok(links[0].href.includes('tbm=shop'))
  assert.equal(new URL(links[1].href).searchParams.get('k'), 'Bíblia para crianças & estudo')
  assert.deepEqual(marketSearchLinks('   '), [])
})

test('shop searches require both a shop category and Portuguese location', () => {
  const links = shopSearchLinks('livraria', 'Porto 4000-008')
  assert.deepEqual(links.map(link => link.label), ['Google Maps', 'OpenStreetMap', 'Pesquisa Web'])
  assert.ok(allHttps(links))
  assert.equal(new URL(links[0].href).searchParams.get('query'), 'livraria Porto 4000-008')
  assert.deepEqual(shopSearchLinks('livraria', ''), [])
})

test('book search links cover booksellers and a Portuguese Bible publisher', () => {
  const links = bibleBookSearchLinks('Evangelhos')
  assert.deepEqual(links.map(link => link.label), ['Amazon.es', 'Wook', 'Bertrand', 'Sociedade Bíblica de Portugal'])
  assert.ok(allHttps(links))
  assert.deepEqual(bibleBookSearchLinks(''), [])
})

// ---- novos -----------------------------------------------------------------

test('wook and bertrand paths survive slashes and hash characters', () => {
  const [, , wook] = marketSearchLinks('a/b #1')
  assert.equal(new URL(wook.href).pathname, '/pesquisa/a%2Fb%20%231')
  assert.equal(new URL(wook.href).hash, '')
})

test('whitespace in queries is normalised', () => {
  const [, amazon] = marketSearchLinks('  Bíblia    ilustrada \n')
  assert.equal(new URL(amazon.href).searchParams.get('k'), 'Bíblia ilustrada')
})

test('second-hand links cover the main Portuguese marketplaces', () => {
  const links = secondHandLinks('Bíblia Almeida')
  assert.deepEqual(links.map(l => l.label), ['OLX', 'Vinted', 'Wallapop', 'eBay'])
  assert.ok(allHttps(links))
  assert.equal(new URL(links[0].href).searchParams.get('q'), 'Bíblia Almeida')
  assert.deepEqual(secondHandLinks(''), [])
})

test('location validation accepts cities and postcodes, rejects junk', () => {
  assert.ok(isPortugueseLocation('Lisboa'))
  assert.ok(isPortugueseLocation('1000-001'))
  assert.ok(isPortugueseLocation('Faro 8000-100'))
  assert.ok(!isPortugueseLocation(''))
  assert.ok(!isPortugueseLocation('  '))
  assert.ok(!isPortugueseLocation('12'))
  assert.deepEqual(shopSearchLinks('', 'Porto'), [])
})

test('bible book list is complete: 39 + 27 = 66', () => {
  assert.equal(BIBLE_BOOKS.antigoTestamento.length, 39)
  assert.equal(BIBLE_BOOKS.novoTestamento.length, 27)
  assert.equal(new Set([...BIBLE_BOOKS.antigoTestamento, ...BIBLE_BOOKS.novoTestamento]).size, 66)
})

test('verse references parse accent- and case-insensitively', () => {
  assert.deepEqual(parseVerseRef('joao 3:16'), { book: 'João', chapter: 3, verse: 16 })
  assert.deepEqual(parseVerseRef('1 CORÍNTIOS 13'), { book: '1 Coríntios', chapter: 13 })
  assert.deepEqual(parseVerseRef('Salmos 23,1'), { book: 'Salmos', chapter: 23, verse: 1 })
  assert.equal(parseVerseRef('Harry 3:16'), null)
  assert.equal(parseVerseRef('João 0:1'), null)
  assert.equal(parseVerseRef('João'), null)
  assert.equal(formatVerseRef({ book: 'João', chapter: 3, verse: 16 }), 'João 3:16')
})

test('verse links point to Portuguese Bible versions', () => {
  const links = verseLinks('Génesis 1:1')
  assert.equal(links.length, 4)
  assert.ok(allHttps(links))
  assert.equal(new URL(links[0].href).searchParams.get('search'), 'Génesis 1:1')
  assert.equal(new URL(links[0].href).searchParams.get('version'), 'ARC')
  assert.deepEqual(verseLinks('nada'), [])
})

test('verse of the day is deterministic, in the list and rotates daily', () => {
  const d = new Date(2026, 9, 11)
  assert.equal(verseOfTheDay(d), verseOfTheDay(new Date(2026, 9, 11, 23, 59)))
  assert.notEqual(verseOfTheDay(d), verseOfTheDay(new Date(2026, 9, 12)))
  assert.ok(DAILY_VERSES.includes(verseOfTheDay(d)))
  assert.ok(DAILY_VERSES.every(v => parseVerseRef(v) !== null), 'every daily verse must be parseable')
})

test('audience searches produce market links', () => {
  const links = audienceSearchLinks('criancas')
  const keyword = new URL(links[1].href).searchParams.get('k')
  assert.equal(links.length, 4)
  assert.ok(keyword)
  assert.match(keyword, /crianças/)
})

test('discovery pack omits empty groups and keeps order', () => {
  assert.deepEqual(discoveryPack({}), [])
  const ids = discoveryPack({ query: 'Salmos', category: 'livraria', location: 'Braga', verse: 'Salmos 23', audience: 'oferta' }).map(g => g.id)
  assert.deepEqual(ids, ['mercado', 'segunda-mao', 'biblias', 'lojas', 'versiculo', 'publico'])
  assert.deepEqual(discoveryPack({ category: 'livraria' }).map(g => g.id), [])
  assert.deepEqual(discoveryPack({ verse: 'João 1:1' }).map(g => g.id), ['versiculo'])
})

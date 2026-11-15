export type DiscoveryLink = {
  label: string
  href: string
}

export type VerseReference = {
  book: string
  chapter: number
  verse?: number
}

export type DiscoveryGroup = {
  id: string
  label: string
  links: DiscoveryLink[]
}

export type DiscoveryOptions = {
  query?: string
  category?: string
  location?: string
  verse?: string
  audience?: string
}

export const BIBLE_BOOKS = {
  antigoTestamento: [
    'Génesis', 'Êxodo', 'Levítico', 'Números', 'Deuteronómio', 'Josué',
    'Juízes', 'Rute', '1 Samuel', '2 Samuel', '1 Reis', '2 Reis',
    '1 Crónicas', '2 Crónicas', 'Esdras', 'Neemias', 'Ester', 'Jó',
    'Salmos', 'Provérbios', 'Eclesiastes', 'Cânticos', 'Isaías',
    'Jeremias', 'Lamentações', 'Ezequiel', 'Daniel', 'Oseias', 'Joel',
    'Amós', 'Obadias', 'Jonas', 'Miqueias', 'Naum', 'Habacuque',
    'Sofonias', 'Ageu', 'Zacarias', 'Malaquias',
  ],
  novoTestamento: [
    'Mateus', 'Marcos', 'Lucas', 'João', 'Atos', 'Romanos',
    '1 Coríntios', '2 Coríntios', 'Gálatas', 'Efésios', 'Filipenses',
    'Colossenses', '1 Tessalonicenses', '2 Tessalonicenses', '1 Timóteo',
    '2 Timóteo', 'Tito', 'Filemom', 'Hebreus', 'Tiago', '1 Pedro',
    '2 Pedro', '1 João', '2 João', '3 João', 'Judas', 'Apocalipse',
  ],
} as const

export const DAILY_VERSES = [
  'Salmos 23:1',
  'Provérbios 3:5',
  'Isaías 41:10',
  'Mateus 5:9',
  'João 3:16',
  'Romanos 12:12',
  'Filipenses 4:6',
]

const allBibleBooks = [
  ...BIBLE_BOOKS.antigoTestamento,
  ...BIBLE_BOOKS.novoTestamento,
]

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-PT')
    .replace(/\s+/g, ' ')
    .trim()
}

const canonicalBookByName = new Map(
  allBibleBooks.map(book => [normalizeText(book), book]),
)

export function parseVerseRef(value: string): VerseReference | null {
  const match = value.trim().match(/^(.+?)\s+(\d+)(?:\s*[:,]\s*(\d+))?$/)
  if (!match) return null

  const [, bookName, chapterValue, verseValue] = match
  if (bookName === undefined || chapterValue === undefined) return null

  const book = canonicalBookByName.get(normalizeText(bookName))
  const chapter = Number(chapterValue)
  const verse = verseValue === undefined ? undefined : Number(verseValue)
  if (!book || chapter < 1 || (verse !== undefined && verse < 1)) return null

  return verse === undefined ? { book, chapter } : { book, chapter, verse }
}

export function formatVerseRef(reference: VerseReference): string {
  return `${reference.book} ${reference.chapter}${reference.verse === undefined ? '' : `:${reference.verse}`}`
}

export function isPortugueseLocation(value: string): boolean {
  const location = value.trim()
  if (!location || /^\d+$/.test(location)) return false
  if (/\b\d{4}-\d{3}\b/.test(location)) return true
  return /^[\p{L}][\p{L}\s.'’-]*$/u.test(location) && location.replace(/[^\p{L}]/gu, '').length >= 2
}

function searchUrl(base: string, parameters: Record<string, string>): string {
  const url = new URL(base)
  for (const [parameter, value] of Object.entries(parameters)) {
    url.searchParams.set(parameter, value.trim())
  }
  return url.toString()
}

function cleanQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function marketSearchLinks(query: string): DiscoveryLink[] {
  const term = cleanQuery(query)
  if (!term) return []
  return [
    {
      label: 'Google Shopping',
      href: searchUrl('https://www.google.com/search', { q: term, tbm: 'shop' }),
    },
    {
      label: 'Amazon.es',
      href: searchUrl('https://www.amazon.es/s', { k: term }),
    },
    {
      label: 'Wook',
      href: `https://www.wook.pt/pesquisa/${encodeURIComponent(term)}`,
    },
    {
      label: 'Bertrand',
      href: searchUrl('https://www.google.com/search', { q: `site:bertrand.pt ${term}` }),
    },
  ]
}

export function shopSearchLinks(query: string, location: string): DiscoveryLink[] {
  const term = cleanQuery(query)
  const place = cleanQuery(location)
  if (!term || !place) return []
  const search = `${term} ${place}`
  const mapUrl = new URL('https://www.google.com/maps/search/')
  mapUrl.searchParams.set('api', '1')
  mapUrl.searchParams.set('query', search)
  return [
    {
      label: 'Google Maps',
      href: mapUrl.toString(),
    },
    {
      label: 'OpenStreetMap',
      href: searchUrl('https://www.openstreetmap.org/search', { query: search }),
    },
    {
      label: 'Pesquisa Web',
      href: searchUrl('https://www.google.com/search', { q: `${term} ${place} lojas` }),
    },
  ]
}

export function bibleBookSearchLinks(query: string): DiscoveryLink[] {
  const term = cleanQuery(query)
  if (!term) return []
  return [
    {
      label: 'Amazon.es',
      href: searchUrl('https://www.amazon.es/s', { k: term }),
    },
    {
      label: 'Wook',
      href: searchUrl('https://www.google.com/search', { q: `site:wook.pt ${term}` }),
    },
    {
      label: 'Bertrand',
      href: searchUrl('https://www.google.com/search', { q: `site:bertrand.pt ${term}` }),
    },
    {
      label: 'Sociedade Bíblica de Portugal',
      href: searchUrl('https://www.google.com/search', { q: `site:sociedade-biblica.pt ${term}` }),
    },
  ]
}

export function secondHandLinks(query: string): DiscoveryLink[] {
  const term = cleanQuery(query)
  if (!term) return []
  return [
    { label: 'OLX', href: searchUrl('https://www.olx.pt/ads/', { q: term }) },
    { label: 'Vinted', href: searchUrl('https://www.vinted.pt/catalog', { search_text: term }) },
    { label: 'Wallapop', href: searchUrl('https://www.wallapop.com/app/search', { keywords: term }) },
    { label: 'eBay', href: searchUrl('https://www.ebay.com/sch/i.html', { _nkw: term }) },
  ]
}

export function verseLinks(value: string): DiscoveryLink[] {
  const reference = parseVerseRef(value)
  if (!reference) return []
  const search = formatVerseRef(reference)
  return [
    {
      label: 'Bíblia Gateway (ARC)',
      href: searchUrl('https://www.biblegateway.com/passage/', { search, version: 'ARC' }),
    },
    {
      label: 'YouVersion',
      href: searchUrl('https://www.bible.com/search/bible', { query: search }),
    },
    {
      label: 'Bíblia Online',
      href: searchUrl('https://www.bibliaonline.com.br/arc', { busca: search }),
    },
    {
      label: 'Sociedade Bíblica de Portugal',
      href: searchUrl('https://www.google.com/search', { q: `site:sociedade-biblica.pt ${search}` }),
    },
  ]
}

export function verseOfTheDay(date = new Date()): string {
  const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const dayNumber = Math.floor(today / 86_400_000)
  const verse = DAILY_VERSES[((dayNumber % DAILY_VERSES.length) + DAILY_VERSES.length) % DAILY_VERSES.length]
  if (verse === undefined) throw new RangeError('A lista de versículos diários está vazia ou a data é inválida.')
  return verse
}

export function audienceSearchLinks(audience: string): DiscoveryLink[] {
  const term = normalizeText(audience)
  if (!term) return []
  const query = term === 'criancas' || term === 'criança' || term === 'crianca'
    ? 'Bíblia para crianças'
    : `Bíblia ${audience.trim()}`
  return [
    ...marketSearchLinks(query),
  ]
}

export function discoveryPack(options: DiscoveryOptions): DiscoveryGroup[] {
  const groups: DiscoveryGroup[] = []
  const query = options.query?.trim() ?? ''
  const verse = options.verse?.trim() ?? ''
  const audience = options.audience?.trim() ?? ''

  const candidates: DiscoveryGroup[] = [
    { id: 'mercado', label: 'Mercado', links: marketSearchLinks(query) },
    { id: 'segunda-mao', label: 'Em segunda mão', links: secondHandLinks(query) },
    { id: 'biblias', label: 'Livrarias', links: bibleBookSearchLinks(query) },
    {
      id: 'lojas',
      label: 'Lojas próximas',
      links: options.category && isPortugueseLocation(options.location ?? '')
        ? shopSearchLinks(options.category, options.location ?? '')
        : [],
    },
    { id: 'versiculo', label: 'Passagens bíblicas', links: verseLinks(verse) },
    { id: 'publico', label: 'Público', links: audienceSearchLinks(audience) },
  ]

  for (const group of candidates) {
    if (group.links.length > 0) groups.push(group)
  }
  return groups
}

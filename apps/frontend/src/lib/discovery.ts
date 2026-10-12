export type DiscoveryLink = {
  label: string
  href: string
}

function searchUrl(base: string, parameters: Record<string, string>): string {
  const url = new URL(base)
  for (const [parameter, value] of Object.entries(parameters)) {
    url.searchParams.set(parameter, value.trim())
  }
  return url.toString()
}

export function marketSearchLinks(query: string): DiscoveryLink[] {
  const term = query.trim()
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
      href: searchUrl('https://www.google.com/search', { q: `site:wook.pt ${term}` }),
    },
    {
      label: 'Bertrand',
      href: searchUrl('https://www.google.com/search', { q: `site:bertrand.pt ${term}` }),
    },
  ]
}

export function shopSearchLinks(query: string, location: string): DiscoveryLink[] {
  const term = query.trim()
  const place = location.trim()
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
  const term = query.trim()
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

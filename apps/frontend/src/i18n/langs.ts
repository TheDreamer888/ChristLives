/** Línguas suportadas pela interface e deteção da língua inicial. */
export const LANGS = [
  { code: 'pt-PT', name: 'Português' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
] as const
export type Lang = (typeof LANGS)[number]['code']

export const isLang = (v: unknown): v is Lang => LANGS.some(l => l.code === v)

/** Escolhe a língua: a guardada, senão a do navegador, senão pt-PT. */
export function detectLang(saved: string | null, browser: readonly string[]): Lang {
  if (isLang(saved)) return saved
  for (const raw of browser) {
    const tag = raw.toLowerCase()
    if (tag === 'pt-br') return 'pt-BR'
    if (tag.startsWith('pt')) return 'pt-PT'
    const base = tag.split('-')[0]
    const hit = LANGS.find(l => l.code === base)
    if (hit) return hit.code
  }
  return 'pt-PT'
}

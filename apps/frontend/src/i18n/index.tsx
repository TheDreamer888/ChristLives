/**
 * Línguas da app.
 *
 * - O português (pt-PT) vem no bundle principal; as outras línguas são
 *   carregadas à parte, só quando escolhidas.
 * - A escolha fica só neste navegador (localStorage, sem dados pessoais);
 *   sem escolha, usa a primeira língua suportada do navegador.
 * - Para acrescentar uma língua: criar `xx.ts` com o tipo `Messages` e
 *   juntá-la a `LANGS` e `LOADERS`. Se faltar uma chave, o build falha.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import pt from './pt-PT'
import type { Messages } from './pt-PT'

import { I18nContext, useI18n } from './context'
import { LANGS, detectLang, isLang } from './langs'
import type { Lang } from './langs'

const LOADERS: Record<Exclude<Lang, 'pt-PT'>, () => Promise<{ default: Messages }>> = {
  'pt-BR': () => import('./pt-BR'),
  en: () => import('./en'),
  es: () => import('./es'),
  fr: () => import('./fr'),
  de: () => import('./de'),
}

const KEY = 'lusorbe.lang'

function readSaved(): string | null {
  try { return window.localStorage.getItem(KEY) } catch { return null }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang(readSaved(), navigator.languages ?? [navigator.language]))
  // Última língua carregada. Enquanto a nova chega, continua a mostrar a anterior (sem piscar).
  const [loaded, setLoaded] = useState<Messages>(pt)
  const m = lang === 'pt-PT' ? pt : loaded

  useEffect(() => {
    document.documentElement.lang = lang
    if (lang === 'pt-PT') return
    let alive = true
    LOADERS[lang]().then(mod => { if (alive) setLoaded(mod.default) }).catch(() => { /* fica a língua anterior */ })
    return () => { alive = false }
  }, [lang])

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try { window.localStorage.setItem(KEY, l) } catch { /* sem armazenamento: vale só nesta página */ }
  }, [])

  const value = useMemo(() => ({ lang, m, setLang, locale: m.meta.locale }), [lang, m, setLang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function LanguageSelect({ className }: { className?: string }) {
  const { lang, setLang, m } = useI18n()
  return (
    <label className={className}>
      <span className="sr-only">{m.common.language}</span>
      <select value={lang} onChange={e => { if (isLang(e.target.value)) setLang(e.target.value) }}>
        {LANGS.map(l => <option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}
      </select>
    </label>
  )
}

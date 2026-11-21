/** Contexto e hook da língua (separados dos componentes, para o fast refresh do Vite). */
import { createContext, useContext } from 'react'

import pt from './pt-PT'
import type { Messages } from './pt-PT'
import type { Lang } from './langs'

export type I18nValue = { lang: Lang; m: Messages; setLang: (l: Lang) => void; locale: string }
export const I18nContext = createContext<I18nValue>({ lang: 'pt-PT', m: pt, setLang: () => {}, locale: 'pt-PT' })
export const useI18n = () => useContext(I18nContext)
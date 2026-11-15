/**
 * Preferência de tema: "system" segue o sistema operativo; "light"/"dark" fixam o tema.
 *
 * A preferência é uma conveniência visual, não um dado de sessão: fica em
 * localStorage (chave THEME_STORAGE_KEY) e é lida antes do primeiro render por
 * public/theme-init.js para evitar um flash de tema claro. Mantém os dois em sincronia.
 */
export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'aegis-theme'
export const THEME_COLORS: Record<ResolvedTheme, string> = { light: '#f5f6f2', dark: '#111511' }

const ORDER: readonly ThemePreference[] = ['system', 'light', 'dark']

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  return ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'system'
}

export function themeLabel(preference: ThemePreference): string {
  return { system: 'Tema: automático', light: 'Tema: claro', dark: 'Tema: escuro' }[preference]
}

export function readStoredPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

export function storePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Armazenamento bloqueado (modo privado, políticas): o tema funciona só nesta visita.
  }
}

export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement
  root.dataset['theme'] = theme
  root.style.colorScheme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme])
}

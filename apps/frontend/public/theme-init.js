// Aplica o tema antes do primeiro render (evita o flash de tema claro).
// Ficheiro externo porque a CSP (script-src 'self') bloqueia scripts inline.
// Mantém em sincronia com src/lib/theme.ts.
(function () {
  var stored = null
  try { stored = window.localStorage.getItem('aegis-theme') } catch (e) { /* armazenamento bloqueado */ }
  var dark = stored === 'dark' || (stored !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  var theme = dark ? 'dark' : 'light'
  var root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#111511' : '#f5f6f2')
})()

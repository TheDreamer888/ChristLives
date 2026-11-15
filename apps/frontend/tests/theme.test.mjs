import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { THEME_COLORS, THEME_STORAGE_KEY, nextThemePreference, parseThemePreference, resolveTheme, themeLabel } from '../src/lib/theme.ts'

test('stored values fall back to the system preference when unknown', () => {
  assert.equal(parseThemePreference('dark'), 'dark')
  assert.equal(parseThemePreference('light'), 'light')
  for (const value of [null, undefined, '', 'DARK', 'auto', 42]) assert.equal(parseThemePreference(value), 'system')
})

test('system preference follows the operating system, explicit choices win', () => {
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme('dark', false), 'dark')
})

test('toggle cycles system → light → dark → system with readable labels', () => {
  assert.equal(nextThemePreference('system'), 'light')
  assert.equal(nextThemePreference('light'), 'dark')
  assert.equal(nextThemePreference('dark'), 'system')
  assert.match(themeLabel('system'), /automático/)
})

test('pre-render script uses the same storage key and colors as the app', () => {
  const script = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8')
  assert.ok(script.includes(`'${THEME_STORAGE_KEY}'`))
  assert.ok(script.includes(THEME_COLORS.dark))
  assert.ok(script.includes(THEME_COLORS.light))
})

test('index.html loads the pre-render script before the app bundle', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const init = html.indexOf('/theme-init.js')
  assert.ok(init > 0 && init < html.indexOf('/src/main.tsx'))
})

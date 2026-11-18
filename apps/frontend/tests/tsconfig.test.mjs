import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const rootDir = fileURLToPath(new URL('../', import.meta.url))
const configPath = path.join(rootDir, 'tsconfig.app.json')

test('app compiler options are valid and resolve the source alias', () => {
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, rootDir)
  assert.deepEqual(parsed.errors, [])
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  assert.deepEqual(program.getOptionsDiagnostics(), [])

  const resolved = ts.resolveModuleName(
    '@/lib/workspace',
    path.join(rootDir, 'src/App.tsx'),
    parsed.options,
    ts.sys,
  ).resolvedModule
  // O TypeScript devolve sempre '/'; path.join usa '\' no Windows. Normalizar antes de comparar.
  assert.equal(
    path.resolve(resolved?.resolvedFileName ?? ''),
    path.resolve(rootDir, 'src/lib/workspace.ts'),
  )
})

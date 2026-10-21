import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// Content-Security-Policy só no build: o servidor de desenvolvimento precisa de scripts inline.
// connect-src fica limitado à própria origem e à API configurada em VITE_API_BASE_URL.
function contentSecurityPolicy(apiBase: string): Plugin {
  const api = new URL(apiBase).origin
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${api}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  return {
    name: 'aegis-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }],
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), contentSecurityPolicy(loadEnv(mode, rootDir, 'VITE_')['VITE_API_BASE_URL'] ?? 'http://localhost:8000')],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
}))

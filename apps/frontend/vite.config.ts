import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          // IPv4 explícito: o Node resolve "localhost" para ::1 e o uvicorn escuta em 127.0.0.1.
          target: env['VITE_API_PROXY_TARGET'] || 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },
  }
})

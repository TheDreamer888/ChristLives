import { defineConfig } from 'vite'

// LANDING_BASE: caminho onde a landing é servida (no GitHub Pages, "/<repo>/").
export default defineConfig({
  base: process.env.LANDING_BASE ?? '/',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0, // sem data: URIs para scripts; o GLB fica como ficheiro
    chunkSizeWarningLimit: 800, // o three.js vem num chunk próprio, carregado depois do texto
  },
})

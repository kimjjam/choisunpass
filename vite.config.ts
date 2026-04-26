import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'path'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        attend: resolve(__dirname, 'attend.html'),
        parents: resolve(__dirname, 'parents.html'),
        bomb: resolve(__dirname, 'bomb.html'),
        classroom: resolve(__dirname, 'classroom.html'),
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,ico,webmanifest}'],
      },
    }),
  ],
})

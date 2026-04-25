import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev-only proxy: forward /admin/api to the running OwlCoda router
// and inject the Bearer token from OWLCODA_ADMIN_TOKEN env var.
// In prod, the client is served by the router itself (same origin).
const routerTarget = process.env.OWLCODA_ROUTER_URL ?? 'http://127.0.0.1:8009'
const adminToken = process.env.OWLCODA_ADMIN_TOKEN ?? ''

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: '../dist/admin',
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
  },
  server: {
    port: 5174,
    proxy: {
      '/admin/api': {
        target: routerTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (adminToken) {
              proxyReq.setHeader('authorization', `Bearer ${adminToken}`)
            }
          })
        },
      },
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
  },
})

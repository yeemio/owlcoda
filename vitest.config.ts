import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['skills/**', 'node_modules/**', 'upstream/**'],
  },
  resolve: {
    alias: {
      'bun:bundle': new URL('./src/ink-shims/bun-bundle-runtime.ts', import.meta.url).pathname,
      'react/compiler-runtime': new URL('./src/react/compiler-runtime.ts', import.meta.url).pathname,
    },
  },
})

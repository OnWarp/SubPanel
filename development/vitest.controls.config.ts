import { defineConfig } from 'vitest/config'

// These frontend checks do not require a local Cloudflare worker or listening socket
export default defineConfig({
  server: { ws: false, watch: null },
  test: {
    environment: 'node',
    include: [
      'development/tests/controls/**/*.test.tsx',
      'development/tests/ui/users-page.test.tsx',
      'development/tests/worker/catalog-counts.test.ts',
      'development/tests/worker/kb-markdown.test.ts',
      'development/tests/worker/frontend-api.test.ts',
      'development/tests/worker/frontend-diagnostics.test.ts',
    ],
  },
})

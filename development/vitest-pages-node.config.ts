// Socket-free subset; canonical Worker integration coverage remains npm test.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'threads',
    include: [
      'development/tests/ui/invite-routes.test.ts',
      'development/tests/ui/navigation-structure.test.ts',
      'development/tests/ui/users-page.test.tsx',
      'development/tests/ui/user-pages-style.test.tsx',
      'development/tests/worker/catalog-counts.test.ts',
      'development/tests/worker/catalog-remote.test.ts',
      'development/tests/worker/delivery-renderers-compat.test.ts',
      'development/tests/worker/delivery-renderers.test.ts',
      'development/tests/worker/frontend-api.test.ts',
      'development/tests/worker/frontend-diagnostics.test.ts',
      'development/tests/worker/http.test.ts',
      'development/tests/worker/import-uri.test.ts',
      'development/tests/worker/kb-markdown.test.ts',
      'development/tests/worker/loon-compat.test.ts',
    ],
  },
})

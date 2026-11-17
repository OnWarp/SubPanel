import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/node/cloudflare-env.ts', import.meta.url)) } },
  test: { environment: 'node', pool: 'threads', include: ['development/tests/node/*.test.ts'] },
})

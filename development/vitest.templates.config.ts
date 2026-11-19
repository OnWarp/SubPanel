import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
export default defineConfig({resolve:{alias:{'cloudflare:workers':fileURLToPath(new URL('./tests/node/cloudflare-env.ts',import.meta.url))}},test:{environment:'node',include:['development/tests/worker/delivery-renderers.test.ts','development/tests/worker/delivery-renderers-compat.test.ts','development/tests/worker/catalog-remote.test.ts','development/tests/worker/templates.test.ts','development/tests/node/templates-lifecycle.test.ts']}})

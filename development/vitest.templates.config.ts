import { defineConfig } from 'vitest/config'
export default defineConfig({test:{environment:'node',include:['development/tests/worker/delivery-renderers.test.ts','development/tests/worker/delivery-renderers-compat.test.ts','development/tests/worker/catalog-remote.test.ts','development/tests/worker/templates.test.ts','development/tests/node/templates-lifecycle.test.ts']}})

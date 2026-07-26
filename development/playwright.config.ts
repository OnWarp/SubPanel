import { defineConfig, devices } from '@playwright/test'
import { join } from 'node:path'

process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'true'
process.env.XDG_CONFIG_HOME = join(process.cwd(), '.wrangler', 'xdg')
const externalServer = process.env.SUBPANEL_EXTERNAL_SERVER === '1'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: externalServer ? undefined : {
    command: 'node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 },
  },
})

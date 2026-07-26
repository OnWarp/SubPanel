import { spawn } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'

const root = process.cwd()
const env = {
  ...process.env,
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
  SUBPANEL_EXTERNAL_SERVER: '1',
  XDG_CONFIG_HOME: join(root, '.wrangler', 'xdg'),
}
const requested = process.argv.slice(2)
const suites = requested.length ? [requested] : readdirSync(join(root, 'development', 'tests', 'browser'))
  .filter((name) => name.endsWith('.spec.ts'))
  .sort()
  .map((name) => [name])

async function runSuite(files) {
  rmSync(join(root, '.wrangler', 'state'), { recursive: true, force: true })
  const server = spawn(
    process.execPath,
    [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
    { cwd: root, env, stdio: 'inherit' },
  )
  try {
    const deadline = Date.now() + 120_000
    while (true) {
      if (server.exitCode !== null) throw new Error(`Vite exited with ${server.exitCode}`)
      try {
        const response = await fetch('http://127.0.0.1:4173/')
        if (response.ok) break
      } catch {
        if (Date.now() >= deadline) throw new Error('Vite did not start within 120 seconds')
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }

    const runner = spawn(
      process.execPath,
      [join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--config', 'development/playwright.config.ts', ...files],
      { cwd: root, env, stdio: 'inherit' },
    )
    const [code] = await once(runner, 'exit')
    return typeof code === 'number' ? code : 1
  } finally {
    server.kill()
    await Promise.race([
      once(server, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
  }
}

for (const files of suites) {
  const code = await runSuite(files)
  if (code !== 0) {
    process.exitCode = code
    break
  }
}

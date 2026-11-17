// Pure behavior coverage runnable without workerd's localhost listener.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const directory = await mkdtemp(join(tmpdir(), 'ui-user-shell-'))
try {
  const outfile = join(directory, 'helpers.mjs')
  await build({ stdin: { contents: `export * from './src/features/user/client-import'; export * from './src/features/user/reminder'`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile })
  const { clientImportLink, reminderEnabled, reminderKey } = await import(pathToFileURL(outfile))
  const link = 'https://example.test/订阅?token=a&client=clash#配置'
  assert.equal(clientImportLink('clash', link), `clash://install-config?url=${encodeURIComponent(link)}`)
  assert.equal(clientImportLink('auto', link), null)
  assert.equal(clientImportLink('clash', ''), null)
  assert.equal(Buffer.from(clientImportLink('shadowrocket', link).split('sub://')[1], 'base64').toString(), link)
  assert.equal(reminderEnabled('a'), false, 'Unavailable storage defaults to off')
  const storage = new Map()
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null }
  storage.set(reminderKey('a'), '1')
  assert.equal(reminderEnabled('a'), true)
  assert.equal(reminderEnabled('b'), false, 'Preferences must not leak across accounts')
  storage.set(reminderKey('a'), '0')
  assert.equal(reminderEnabled('a'), false)
  delete globalThis.localStorage
  console.log('UI user shell: 8 behavioral assertions passed')
} finally { await rm(directory, { recursive: true, force: true }) }

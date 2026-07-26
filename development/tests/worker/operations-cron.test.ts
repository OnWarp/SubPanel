import { env } from 'cloudflare:workers'
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSource } from '../../../worker/catalog/import-service.js'
import { readCatalog, writeCatalog } from '../../../worker/catalog/repository.js'
import worker from '../../../worker/index.js'
import { runCron, selectDueSource } from '../../../worker/operations/cron.js'
import { resetData } from './helpers.js'

const NOW = '2026-07-25T00:15:00.000Z'

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 'src_1', name: 'Remote', type: 'remote', enabled: true,
    refreshIntervalMinutes: 15, warnings: [],
    encryptedUrl: { ciphertext: 'A', iv: 'B' }, encryptedHeaders: { ciphertext: 'A', iv: 'B' },
    createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:00.000Z',
    lastAttemptAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  } as any
}

beforeEach(resetData)

describe('Cron due-source selection', () => {
  it('selects the earliest due enabled remote source', () => {
    const result = selectDueSource([
      source({ id: 'src_1', lastAttemptAt: '2026-07-25T00:14:00.000Z' }),
      source({ id: 'src_2', lastAttemptAt: '2026-07-25T00:00:00.000Z' }),
      source({ id: 'src_3', enabled: false }),
      source({ id: 'src_4', type: 'manual' }),
    ], NOW)
    expect(result?.id).toBe('src_2')
  })

  it('does not refresh before the interval and keeps source order for ties', () => {
    const sources = [
      source({ id: 'src_2', lastAttemptAt: '2026-07-25T00:01:00.000Z' }),
      source({ id: 'src_1', lastAttemptAt: '2026-07-25T00:01:00.000Z' }),
    ]
    expect(selectDueSource(sources, '2026-07-25T00:15:59.000Z')).toBeUndefined()
    expect(selectDueSource(sources, '2026-07-25T00:16:00.000Z')?.id).toBe('src_2')
  })

  it('refreshes one due source from the scheduled Worker handler', async () => {
    const line = `ss://${btoa('aes-128-gcm:password')}@cron.example.com:8388#Cron`
    const fetcher = vi.fn(async () => new Response(line))
    await createSource(env.DATA, { type: 'remote', name: 'First', url: 'https://one.example/source', headers: {}, refreshIntervalMinutes: 15 }, { now: '2026-07-25T00:00:00.000Z', fetcher })
    await createSource(env.DATA, { type: 'remote', name: 'Second', url: 'https://two.example/source', headers: {}, refreshIntervalMinutes: 15 }, { now: '2026-07-25T00:00:00.000Z', fetcher })
    const catalog = await readCatalog(env.DATA)
    await writeCatalog(env.DATA, { ...catalog, sources: catalog.sources.map((item) => ({ ...item, lastAttemptAt: '2026-07-24T23:00:00.000Z' })) }, NOW)
    vi.stubGlobal('fetch', fetcher)

    const scheduled = worker.scheduled
    expect(scheduled).toBeTypeOf('function')
    const context = createExecutionContext()
    scheduled(createScheduledController({ scheduledTime: Date.parse(NOW) }), env, context)
    await waitOnExecutionContext(context)

    expect(fetcher).toHaveBeenCalledTimes(3)
    const status = JSON.parse(await env.DATA.get('state:cron') ?? '{}')
    expect(status).toMatchObject({ schemaVersion: 1, status: 'success', sourceId: 'src_1' })
    expect(status.catalogRevision).toBe((await readCatalog(env.DATA)).revision)
  })

  it('stores only sanitized failure data after a remote refresh error', async () => {
    const line = `ss://${btoa('aes-128-gcm:password')}@cron.example.com:8388#Cron`
    await createSource(env.DATA, {
      type: 'remote',
      name: 'Sensitive',
      url: 'https://cron.example/source?token=query-secret',
      headers: { Authorization: 'Bearer header-secret' },
      refreshIntervalMinutes: 15,
    }, { now: '2026-07-25T00:00:00.000Z', fetcher: async () => new Response(line) })

    await runCron(env.DATA, {
      now: NOW,
      fetcher: async () => {
        throw new Error('thrown-secret-detail query-secret header-secret')
      },
    })

    const stored = await env.DATA.get('state:cron')
    expect(JSON.parse(stored ?? '{}')).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      sourceId: 'src_1',
      errorCode: 'REMOTE_FETCH_FAILED',
    })
    expect(stored).not.toContain('query-secret')
    expect(stored).not.toContain('header-secret')
    expect(stored).not.toContain('thrown-secret-detail')
  })
})

import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { domainBindingsMigration, domainsMigration, initMigration } from './d1'

it('merges 0007 D1 rows, retains binding IDs and does not resurrect deleted bindings on replay', async () => {
  await applyD1Migrations(env.DB, [initMigration, domainsMigration])
  await env.DB.batch([
    env.DB.prepare(`UPDATE panel_domains SET verified_at = '2026-02-01', last_check_at = '2026-02-01',
      created_at = '2025-01-01' WHERE id = 'dom_panel_primary'`),
    env.DB.prepare(`UPDATE subscription_domains SET verification_status = 'failed', verified_at = '2026-02-02',
      last_check_at = '2026-03-01', last_check_error = 'DNS_MISMATCH' WHERE id = 'dom_sub_primary'`),
  ])
  for (let replay = 0; replay < 2; replay++) {
    await env.DB.batch(domainBindingsMigration.queries.map(sql => env.DB.prepare(sql)))
  }
  expect(await env.DB.prepare('SELECT count(*) AS total FROM domains').first()).toEqual({ total: 1 })
  expect(await env.DB.prepare('SELECT verification_status, verified_at, last_checked_at, last_error_code, created_at FROM domains').first())
    .toEqual({ verification_status: 'verified', verified_at: '2026-02-02', last_checked_at: '2026-03-01',
      last_error_code: 'DNS_MISMATCH', created_at: '2025-01-01' })
  expect((await env.DB.prepare('SELECT id, is_primary FROM domain_bindings ORDER BY id').all()).results)
    .toEqual([{ id: 'dom_panel_primary', is_primary: 1 }, { id: 'dom_sub_primary', is_primary: 1 }])
  await env.DB.prepare("DELETE FROM domain_bindings WHERE purpose = 'subscription'").run()
  await env.DB.batch(domainBindingsMigration.queries.map(sql => env.DB.prepare(sql)))
  expect(await env.DB.prepare('SELECT count(*) AS total FROM domain_bindings').first()).toEqual({ total: 1 })
})

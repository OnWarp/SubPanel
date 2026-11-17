import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDeliveryStorage, readDeliveryFromD1 } from '../../../worker/delivery/d1-repository'
import { applyMigrations } from './d1'
import { resetData } from './helpers'

const NOW = '2026-07-23T00:00:00.000Z'
const ENCRYPTED = {
  version: 1,
  algorithm: 'AES-GCM',
  iv: 'A'.repeat(16),
  ciphertext: 'B'.repeat(32),
}

async function insertSubscription(id: string, tokenHash: string, tokenPrefix: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO subscriptions (
      id, user_id, name, token_hash, token_prefix, encrypted_token,
      enabled, default_client, revision, starts_at, expires_at, created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, 1, 'mihomo', 1, NULL, NULL, ?, ?)`,
  ).bind(id, `Sub ${id}`, tokenHash, tokenPrefix, JSON.stringify(ENCRYPTED), NOW, NOW).run()
}

async function putSetting(key: string, rawValue: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, rawValue, NOW).run()
}

async function seedSnapshot(): Promise<void> {
  await insertSubscription('sub_1', 'A'.repeat(43), 'tokpre01')
  await insertSubscription('sub_2', 'B'.repeat(43), 'tokpre02')
  await putSetting('delivery_schema_version', '1')
  await putSetting('delivery_revision', '4')
  await putSetting('delivery_updated_at', JSON.stringify(NOW))
  await putSetting('next_subscription_id', '3')
  await putSetting('delivery_entity_order', '["sub_2","sub_1"]')
}

async function readIds(): Promise<string[]> {
  const snapshot = await readDeliveryFromD1(env.DB)
  return snapshot.subscriptions.map((item) => item.id)
}

beforeEach(async () => {
  await resetData()
  await applyMigrations()
  await clearDeliveryStorage(env.DB)
  await seedSnapshot()
})

describe('delivery entity order fallback', () => {
  it('keeps an intact stored order untouched', async () => {
    await expect(readIds()).resolves.toEqual(['sub_2', 'sub_1'])
  })

  it('derives ascending order when the entity order key is missing', async () => {
    await env.DB.prepare('DELETE FROM system_settings WHERE key = ?').bind('delivery_entity_order').run()
    await expect(readIds()).resolves.toEqual(['sub_1', 'sub_2'])
  })

  // Note: a literally invalid JSON text cannot be stored at all (the
  // system_settings.value column has a json_valid CHECK constraint), so the
  // reachable 'not a valid JSON array' shapes are valid JSON non-arrays and
  // arrays with non-string entries; both are covered here and below.
  it('derives ascending order when the entity order value is not an array (JSON number)', async () => {
    await putSetting('delivery_entity_order', '123')
    await expect(readIds()).resolves.toEqual(['sub_1', 'sub_2'])
  })

  it('ignores non-string entries in the entity order array', async () => {
    await putSetting('delivery_entity_order', '[123,"sub_2"]')
    await expect(readIds()).resolves.toEqual(['sub_2', 'sub_1'])
  })

  it('derives ascending order when the entity order value is not an array', async () => {
    await putSetting('delivery_entity_order', '"sub_1"')
    await expect(readIds()).resolves.toEqual(['sub_1', 'sub_2'])
  })

  it('drops stale ids and keeps the stored relative order', async () => {
    await putSetting('delivery_entity_order', '["sub_2","sub_9","sub_1"]')
    await expect(readIds()).resolves.toEqual(['sub_2', 'sub_1'])
  })

  it('appends missing subscriptions by ascending id', async () => {
    await putSetting('delivery_entity_order', '["sub_2"]')
    await expect(readIds()).resolves.toEqual(['sub_2', 'sub_1'])
  })

  it('does not write the derived order back to D1', async () => {
    await env.DB.prepare('DELETE FROM system_settings WHERE key = ?').bind('delivery_entity_order').run()
    await expect(readIds()).resolves.toEqual(['sub_1', 'sub_2'])
    const row = await env.DB.prepare('SELECT value FROM system_settings WHERE key = ?')
      .bind('delivery_entity_order')
      .first()
    expect(row).toBeNull()
  })
})

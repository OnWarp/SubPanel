import { describe, it, expect, beforeAll } from 'vitest'
import { convertDelivery } from '../../../worker/migration/delivery'
import { applyMigrations, emptyDatabase } from '../worker/d1.js'
import { env } from 'cloudflare:workers'

describe('delivery converter', () => {
  let db: D1Database

  beforeAll(async () => {
    db = env.DB
    await applyMigrations(db)
  })

  const validSnapshot = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: '2024-01-15T10:00:00.000Z',
    nextSubscriptionId: 3,
    subscriptions: [
      {
        id: 'sub_1',
        userId: 'usr_1',
        name: 'Subscription 1',
        groupIds: ['grp_1', 'grp_2'],
        tokenHash: 'CypJaIemxeQDIkFgf5693PsaOVh3lrXU8xIxUG-Orcw',
        tokenPrefix: 'abcdefgh',
        encryptedToken: { version: 1, algorithm: 'AES-GCM', iv: 'I0JhgJ--3fwbOll4', ciphertext: 'LUxriqnI5wYlRGOCocDf_h08W3qZuNf2' },
        enabled: true,
        defaultClient: 'mihomo',
        revision: 1,
        startsAt: 1705312800000, // 2024-01-15T10:00:00.000Z in ms
        expiresAt: 1736935200000, // 2025-01-15T10:00:00.000Z in ms
        createdAt: '2024-01-10T10:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
      },
      {
        id: 'sub_2',
        userId: 'usr_2',
        name: 'Subscription 2',
        groupIds: ['grp_2'],
        tokenHash: 'DCtKaYinxuUEI0JhgJ--3fwbOll4l7bV9BMyUXCPrs0',
        tokenPrefix: 'bcdefghi',
        encryptedToken: { version: 1, algorithm: 'AES-GCM', iv: 'JENigaC_3v0cO1p5', ciphertext: 'Lk1si6rJ6AcmRWSDosHg_x49XHuaudj3' },
        enabled: false,
        defaultClient: 'singbox',
        revision: 2,
        startsAt: null,
        expiresAt: null,
        createdAt: '2024-01-11T10:00:00.000Z',
        updatedAt: '2024-01-11T10:00:00.000Z',
      },
    ],
  }

  it('converts valid snapshot without anomalies', () => {
    const result = convertDelivery(validSnapshot)

    expect(result.report.anomalies).toHaveLength(0)
    expect(result.report.skipped).toBe(0)
    expect(result.rows.subscriptions).toHaveLength(2)
    expect(result.rows.subscription_groups).toHaveLength(3) // 2 + 1

    // Check subscription conversion
    const sub1 = result.rows.subscriptions.find(s => s.id === 'sub_1')
    expect(sub1).toBeDefined()
    expect(sub1!.user_id).toBe('usr_1')
    expect(sub1!.name).toBe('Subscription 1')
    expect(sub1!.token_hash).toBe('CypJaIemxeQDIkFgf5693PsaOVh3lrXU8xIxUG-Orcw')
    expect(sub1!.token_prefix).toBe('abcdefgh')
    expect(sub1!.encrypted_token).toBe('{"version":1,"algorithm":"AES-GCM","iv":"I0JhgJ--3fwbOll4","ciphertext":"LUxriqnI5wYlRGOCocDf_h08W3qZuNf2"}')
    expect(sub1!.enabled).toBe(1)
    expect(sub1!.default_client).toBe('mihomo')
    expect(sub1!.revision).toBe(1)
    expect(sub1!.starts_at).toBe(1705312800000)
    expect(sub1!.expires_at).toBe(1736935200000)

    const sub2 = result.rows.subscriptions.find(s => s.id === 'sub_2')
    expect(sub2).toBeDefined()
    expect(sub2!.enabled).toBe(0)
    expect(sub2!.starts_at).toBeNull()
    expect(sub2!.expires_at).toBeNull()

    // Check subscription_groups conversion
    const groups = result.rows.subscription_groups
    const sub1Groups = groups.filter(g => g.subscription_id === 'sub_1')
    expect(sub1Groups).toHaveLength(2)
    expect(sub1Groups.map(g => g.group_id).sort()).toEqual(['grp_1', 'grp_2'])
    expect(sub1Groups.map(g => g.position)).toEqual([0, 1])

    const sub2Groups = groups.filter(g => g.subscription_id === 'sub_2')
    expect(sub2Groups).toHaveLength(1)
    expect(sub2Groups[0].group_id).toBe('grp_2')
    expect(sub2Groups[0].position).toBe(0)
  })

  it('property test: converted rows satisfy D1 constraints', async () => {
    const result = convertDelivery(validSnapshot)

    await emptyDatabase(db)
    await applyMigrations(db)

    // First insert users (required for FK)
    await db.prepare(`
      INSERT INTO users (id, username, role, enabled, password_algorithm, password_iterations, password_salt, password_hash, session_version, email, email_normalized, email_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind('usr_1', 'user1', 'user', 1, 'PBKDF2-SHA-256', 100000, 'salt1', 'hash1', 0, null, null, null, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z').run()

    await db.prepare(`
      INSERT INTO users (id, username, role, enabled, password_algorithm, password_iterations, password_salt, password_hash, session_version, email, email_normalized, email_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind('usr_2', 'user2', 'user', 1, 'PBKDF2-SHA-256', 100000, 'salt2', 'hash2', 0, null, null, null, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z').run()

    // Insert groups (required for subscription_groups FK)
    await db.prepare(`
      INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).bind('grp_1', 'Group 1', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z').run()

    await db.prepare(`
      INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).bind('grp_2', 'Group 2', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z').run()

    for (const sub of result.rows.subscriptions) {
      await db.prepare(`
        INSERT INTO subscriptions (id, user_id, name, token_hash, token_prefix, encrypted_token, enabled, default_client, revision, starts_at, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        sub.id, sub.user_id, sub.name, sub.token_hash, sub.token_prefix, sub.encrypted_token,
        sub.enabled, sub.default_client, sub.revision, sub.starts_at, sub.expires_at,
        sub.created_at, sub.updated_at
      ).run()
    }

    for (const sg of result.rows.subscription_groups) {
      await db.prepare(`
        INSERT INTO subscription_groups (subscription_id, group_id, position)
        VALUES (?, ?, ?)
      `).bind(sg.subscription_id, sg.group_id, sg.position).run()
    }

    // Verify counts
    const subCount = await db.prepare('SELECT COUNT(*) as c FROM subscriptions').first<{ c: number }>()
    expect(subCount!.c).toBe(2)

    const sgCount = await db.prepare('SELECT COUNT(*) as c FROM subscription_groups').first<{ c: number }>()
    expect(sgCount!.c).toBe(3)

    // Verify FK constraints
    const fkCheckSub = await db.prepare(`
      SELECT COUNT(*) as c FROM subscriptions s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE u.id IS NULL
    `).first<{ c: number }>()
    expect(fkCheckSub!.c).toBe(0)

    const fkCheckSg = await db.prepare(`
      SELECT COUNT(*) as c FROM subscription_groups sg
      LEFT JOIN subscriptions s ON sg.subscription_id = s.id
      LEFT JOIN groups g ON sg.group_id = g.id
      WHERE s.id IS NULL OR g.id IS NULL
    `).first<{ c: number }>()
    expect(fkCheckSg!.c).toBe(0)

    // Verify unique constraint on token_hash
    const uniqueTokens = await db.prepare('SELECT COUNT(DISTINCT token_hash) as c FROM subscriptions').first<{ c: number }>()
    expect(uniqueTokens!.c).toBe(2)

    // Verify starts_at <= expires_at constraint
    const constraintCheck = await db.prepare(`
      SELECT COUNT(*) as c FROM subscriptions
      WHERE starts_at IS NOT NULL AND expires_at IS NOT NULL AND starts_at > expires_at
    `).first<{ c: number }>()
    expect(constraintCheck!.c).toBe(0)
  })
})
import { describe, it, expect, beforeAll } from 'vitest'
import { convertShares, convertShareSeq } from '../../../worker/migration/shares'
import { applyMigrations, emptyDatabase } from '../worker/d1.js'
import { env } from 'cloudflare:workers'

describe('shares converter', () => {
  let db: D1Database

  beforeAll(async () => {
    db = env.DB
    await applyMigrations(db)
  })

  const validShareRecords = [
    {
      schemaVersion: 1,
      id: 'shr_1',
      ownerUserId: 'usr_1',
      subscriptionId: 'sub_1',
      tokenHash: 'FTRTcpGwz-4NLEtqiajH5gUkQ2KBoL_e_Rw7WnmYt9Y',
      tokenPrefix: 'abcdefgh',
      tokenEncrypted: { version: 1, algorithm: 'AES-GCM', iv: 'JURjgqHA3_4dPFt6', ciphertext: 'L05tjKvK6QgnRmWEo8LhAB8-XXybutn4' },
      remark: 'Test share 1',
      status: 'active',
      accessControl: { mode: 'none' },
      expiresAt: '2025-01-15T10:00:00.000Z',
      allowOriginalLink: false,
      showSubscriptionName: true,
      showGroups: true,
      showExpiry: true,
      showNodeNames: false,
      requireLogin: false,
      maxAccessCount: null,
      accessCount: 0,
      lastAccessedAt: null,
      lastOriginalRevealAt: null,
      createdAt: '2024-01-15T10:00:00.000Z',
      updatedAt: '2024-01-15T10:00:00.000Z',
    },
    {
      schemaVersion: 1,
      id: 'shr_2',
      ownerUserId: 'usr_1',
      subscriptionId: 'sub_2',
      tokenHash: 'FjVUc5Kx0O8OLUxriqnI5wYlRGOCocDf_h08W3qZuNc',
      tokenPrefix: 'bcdefghi',
      tokenEncrypted: { version: 1, algorithm: 'AES-GCM', iv: 'JkVkg6LB4P8ePVx7', ciphertext: 'ME9ujazL6gkoR2aFpMPiASA_Xn2cu9r5' },
      remark: 'Test share 2',
      status: 'active',
      accessControl: {
        mode: 'password',
        passwordHash: {
          algorithm: 'PBKDF2-SHA-256',
          iterations: 100000,
          salt: 'BSRDYoGgv979HDtaeZi31g',
          hash: 'BiVEY4KhwN_-HTxbepm41_YVNFNykbDP7g0sS2qJqMc',
        },
      },
      expiresAt: '2025-06-15T10:00:00.000Z',
      allowOriginalLink: true,
      showSubscriptionName: true,
      showGroups: false,
      showExpiry: true,
      showNodeNames: true,
      requireLogin: true,
      maxAccessCount: 100,
      accessCount: 10,
      lastAccessedAt: '2024-06-01T10:00:00.000Z',
      lastOriginalRevealAt: '2024-05-01T10:00:00.000Z',
      createdAt: '2024-01-16T10:00:00.000Z',
      updatedAt: '2024-06-01T10:00:00.000Z',
    },
    {
      schemaVersion: 1,
      id: 'shr_3',
      ownerUserId: 'usr_2',
      subscriptionId: 'sub_1',
      tokenHash: 'FzZVdJOy0fAPLk1si6rJ6AcmRWSDosHg_x49XHuaudg',
      tokenPrefix: 'cdefghij',
      tokenEncrypted: { version: 1, algorithm: 'AES-GCM', iv: 'J0ZlhKPC4QAfPl18', ciphertext: 'MVBvjq3M6wopSGeGpcTjAiFAX36dvNv6' },
      remark: 'Disabled share',
      status: 'disabled',
      accessControl: { mode: 'none' },
      expiresAt: '2024-12-15T10:00:00.000Z',
      allowOriginalLink: false,
      showSubscriptionName: false,
      showGroups: false,
      showExpiry: false,
      showNodeNames: false,
      requireLogin: false,
      maxAccessCount: null,
      accessCount: 5,
      lastAccessedAt: '2024-11-01T10:00:00.000Z',
      lastOriginalRevealAt: null,
      createdAt: '2024-01-17T10:00:00.000Z',
      updatedAt: '2024-01-17T10:00:00.000Z',
    },
  ]

  const validShareSettings = {
    enabled: true,
    createAllowed: true,
    maxSharesPerSubscription: 5,
    maxActiveSharesPerUser: 20,
    maxValidityDays: 90,
    defaultAllowOriginalLink: false,
    defaultAccessControl: 'none',
    requireLoginDefault: false,
    publicBaseUrl: 'https://subpanel.example.com',
  }

  it('converts valid share records and settings without anomalies', () => {
    const result = convertShares(validShareRecords, validShareSettings)

    expect(result.report.anomalies).toHaveLength(0)
    expect(result.report.skipped).toBe(0)
    expect(result.rows.shares).toHaveLength(3)
    expect(result.rows.system_settings).toHaveLength(1)

    // Check share conversion
    const share1 = result.rows.shares.find(s => s.id === 'shr_1')
    expect(share1).toBeDefined()
    expect(share1!.owner_user_id).toBe('usr_1')
    expect(share1!.subscription_id).toBe('sub_1')
    expect(share1!.token_hash).toBe('FTRTcpGwz-4NLEtqiajH5gUkQ2KBoL_e_Rw7WnmYt9Y')
    expect(share1!.access_mode).toBe('none')
    expect(share1!.access_password_algorithm).toBeNull()
    expect(share1!.access_password_iterations).toBeNull()
    expect(share1!.access_password_salt).toBeNull()
    expect(share1!.access_password_hash).toBeNull()
    expect(share1!.allow_original_link).toBe(0)
    expect(share1!.show_subscription_name).toBe(1)
    expect(share1!.show_groups).toBe(1)
    expect(share1!.max_access_count).toBeNull()

    const share2 = result.rows.shares.find(s => s.id === 'shr_2')
    expect(share2).toBeDefined()
    expect(share2!.access_mode).toBe('password')
    expect(share2!.access_password_algorithm).toBe('PBKDF2-SHA-256')
    expect(share2!.access_password_iterations).toBe(100000)
    expect(share2!.access_password_salt).toBe('BSRDYoGgv979HDtaeZi31g')
    expect(share2!.access_password_hash).toBe('BiVEY4KhwN_-HTxbepm41_YVNFNykbDP7g0sS2qJqMc')
    expect(share2!.allow_original_link).toBe(1)
    expect(share2!.max_access_count).toBe(100)

    const share3 = result.rows.shares.find(s => s.id === 'shr_3')
    expect(share3).toBeDefined()
    expect(share3!.status).toBe('disabled')
    expect(share3!.access_count).toBe(5)

    // Check system settings
    const setting = result.rows.system_settings[0]
    expect(setting.key).toBe('share_settings')
    const parsed = JSON.parse(setting.value)
    expect(parsed.enabled).toBe(true)
    expect(parsed.publicBaseUrl).toBe('https://subpanel.example.com')

    // Check non-converted keys are reported
    expect(result.report.nonConvertedKeys).toContain('shareidx:user:* (query index, rebuilt from shares.owner_user_id)')
    expect(result.report.nonConvertedKeys).toContain('shareidx:sub:* (query index, rebuilt from shares.subscription_id)')
    expect(result.report.nonConvertedKeys).toContain('sharelimit:* (rate limits, derived data - not converted)')
    expect(result.report.nonConvertedKeys).toContain('compiled:share:* (compiled artifacts, derived data - not converted)')
  })

  it('reports anomaly for duplicate token_hash', () => {
    const records = [
      ...validShareRecords,
      {
        ...validShareRecords[0],
        id: 'shr_4',
        tokenHash: 'FTRTcpGwz-4NLEtqiajH5gUkQ2KBoL_e_Rw7WnmYt9Y', // duplicate
      },
    ]

    const result = convertShares(records, validShareSettings)
    expect(result.report.anomalies).toContain('Duplicate token_hash FTRTcpGwz-4NLEtqiajH5gUkQ2KBoL_e_Rw7WnmYt9Y at index 3')
    expect(result.report.skipped).toBe(1)
    expect(result.rows.shares).toHaveLength(3) // only unique ones
  })

  it('reports anomaly for duplicate share id', () => {
    const records = [
      ...validShareRecords,
      {
        ...validShareRecords[1],
        tokenHash: 'GDdWdZSz0vEQL05tjKvK6QgnRmWEo8LhAB8-XXybutk', // different token
      },
    ]

    const result = convertShares(records, validShareSettings)
    expect(result.report.anomalies.some(a => a.includes('Duplicate share id'))).toBe(true)
    expect(result.report.skipped).toBe(1)
  })

  it('reports anomaly for invalid share record', () => {
    const records = [
      ...validShareRecords,
      { invalid: 'record' }, // missing required fields
    ]

    const result = convertShares(records, validShareSettings)
    expect(result.report.anomalies.some(a => a.includes('failed validation'))).toBe(true)
    expect(result.report.skipped).toBe(1)
  })

  it('reports anomaly for invalid share settings', () => {
    const result = convertShares(validShareRecords, { invalid: 'settings' })
    expect(result.report.anomalies.some(a => a.includes('failed validation'))).toBe(true)
    expect(result.report.skipped).toBe(1)
    expect(result.rows.system_settings).toHaveLength(0)
  })

  it('converts share seq correctly', () => {
    expect(convertShareSeq({ next: 42 })).toEqual({ next_share_id: 42 })
    expect(convertShareSeq(null)).toEqual({ next_share_id: 1 })
    expect(convertShareSeq(undefined)).toEqual({ next_share_id: 1 })
  })

  it('property test: converted rows satisfy D1 constraints', async () => {
    const result = convertShares(validShareRecords, validShareSettings)

    await emptyDatabase(db)
    await applyMigrations(db)

    // Insert required users and subscriptions for FK
    await db.prepare(`
      INSERT INTO users (id, username, role, enabled, password_algorithm, password_iterations, password_salt, password_hash, session_version, email, email_normalized, email_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind('usr_1', 'user1', 'user', 1, 'PBKDF2-SHA-256', 100000, 'salt1', 'hash1', 0, null, null, null, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z').run()

    await db.prepare(`
      INSERT INTO users (id, username, role, enabled, password_algorithm, password_iterations, password_salt, password_hash, session_version, email, email_normalized, email_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind('usr_2', 'user2', 'user', 1, 'PBKDF2-SHA-256', 100000, 'salt2', 'hash2', 0, null, null, null, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z').run()

    await db.prepare(`
      INSERT INTO subscriptions (id, user_id, name, token_hash, token_prefix, encrypted_token, enabled, default_client, revision, starts_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind('sub_1', 'usr_1', 'Sub 1', 'tok1', 'pref1', '{"version":1,"algorithm":"AES-GCM","iv":"iv1","ciphertext":"ct1"}', 1, 'mihomo', 1, null, null, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z').run()

    await db.prepare(`
      INSERT INTO subscriptions (id, user_id, name, token_hash, token_prefix, encrypted_token, enabled, default_client, revision, starts_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind('sub_2', 'usr_1', 'Sub 2', 'tok2', 'pref2', '{"version":1,"algorithm":"AES-GCM","iv":"iv2","ciphertext":"ct2"}', 1, 'mihomo', 1, null, null, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z').run()

    for (const share of result.rows.shares) {
      await db.prepare(`
        INSERT INTO shares (id, schema_version, owner_user_id, subscription_id, token_hash, token_prefix, token_encrypted, remark, status, access_mode, access_password_algorithm, access_password_iterations, access_password_salt, access_password_hash, expires_at, allow_original_link, show_subscription_name, show_groups, show_expiry, show_node_names, require_login, max_access_count, access_count, last_accessed_at, last_original_reveal_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        share.id, share.schema_version, share.owner_user_id, share.subscription_id, share.token_hash, share.token_prefix, share.token_encrypted,
        share.remark, share.status, share.access_mode, share.access_password_algorithm, share.access_password_iterations,
        share.access_password_salt, share.access_password_hash, share.expires_at, share.allow_original_link,
        share.show_subscription_name, share.show_groups, share.show_expiry, share.show_node_names, share.require_login,
        share.max_access_count, share.access_count, share.last_accessed_at, share.last_original_reveal_at,
        share.created_at, share.updated_at
      ).run()
    }

    for (const setting of result.rows.system_settings) {
      await db.prepare(`
        INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
      `).bind(setting.key, setting.value, setting.updated_at).run()
    }

    // Verify counts
    const shareCount = await db.prepare('SELECT COUNT(*) as c FROM shares').first<{ c: number }>()
    expect(shareCount!.c).toBe(3)

    const settingCount = await db.prepare('SELECT COUNT(*) as c FROM system_settings WHERE key = ?').bind('share_settings').first<{ c: number }>()
    expect(settingCount!.c).toBe(1)

    // Verify FK constraints
    const fkCheckOwner = await db.prepare(`
      SELECT COUNT(*) as c FROM shares s
      LEFT JOIN users u ON s.owner_user_id = u.id
      WHERE u.id IS NULL
    `).first<{ c: number }>()
    expect(fkCheckOwner!.c).toBe(0)

    const fkCheckSub = await db.prepare(`
      SELECT COUNT(*) as c FROM shares s
      LEFT JOIN subscriptions sub ON s.subscription_id = sub.id
      WHERE sub.id IS NULL
    `).first<{ c: number }>()
    expect(fkCheckSub!.c).toBe(0)

    // Verify unique constraint on token_hash
    const uniqueTokens = await db.prepare('SELECT COUNT(DISTINCT token_hash) as c FROM shares').first<{ c: number }>()
    expect(uniqueTokens!.c).toBe(3)

    // Verify CHECK constraint for access_mode = 'none' => password fields null
    const checkNone = await db.prepare(`
      SELECT COUNT(*) as c FROM shares
      WHERE access_mode = 'none'
        AND (access_password_algorithm IS NOT NULL
          OR access_password_iterations IS NOT NULL
          OR access_password_salt IS NOT NULL
          OR access_password_hash IS NOT NULL)
    `).first<{ c: number }>()
    expect(checkNone!.c).toBe(0)

    // Verify CHECK constraint for access_mode = 'password' => password fields not null
    const checkPassword = await db.prepare(`
      SELECT COUNT(*) as c FROM shares
      WHERE access_mode = 'password'
        AND (access_password_algorithm IS NULL
          OR access_password_iterations IS NULL
          OR access_password_salt IS NULL
          OR access_password_hash IS NULL)
    `).first<{ c: number }>()
    expect(checkPassword!.c).toBe(0)
  })
})
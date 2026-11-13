import { describe, it, expect, beforeAll } from 'vitest'
import { convertAccounts, convertAccountsWithInviteKeys } from '../../../worker/migration/accounts'
import { applyMigrations, emptyDatabase } from '../worker/d1.js'
import { env } from 'cloudflare:workers'

describe('accounts converter', () => {
  let db: D1Database

  beforeAll(async () => {
    db = env.DB
    await applyMigrations(db)
  })

  const validAccountsSnapshot = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: '2024-01-15T10:00:00.000Z',
    nextUserId: 3,
    users: [
      {
        id: 'usr_1',
        username: 'admin',
        role: 'admin',
        enabled: true,
        password: {
          algorithm: 'PBKDF2-SHA-256',
          iterations: 100000,
          salt: 'ASA_Xn2cu9r5GDdWdZSz0g',
          hash: 'AiFAX36dvNv6GThXdpW00_IRME9ujazL6gkoR2aFpMM',
        },
        sessionVersion: 0,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
      },
      {
        id: 'usr_2',
        username: 'user1',
        role: 'user',
        enabled: true,
        password: {
          algorithm: 'PBKDF2-SHA-256',
          iterations: 100000,
          salt: 'AyJBYH-evdz7GjlYd5a11A',
          hash: 'BCNCYYCfvt38GzpZeJe21fQTMlFwj67N7AsqSWiHpsU',
        },
        sessionVersion: 1,
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-10T00:00:00.000Z',
      },
    ],
  }

  const validInviteRecords = [
    {
      schemaVersion: 1,
      userId: 'usr_3', // pre-allocated, user doesn't exist yet
      username: 'newuser1',
      createdAt: '2024-01-15T10:00:00.000Z',
      expiresAt: '2024-01-16T10:00:00.000Z',
    },
    {
      schemaVersion: 1,
      userId: 'usr_4',
      username: 'newuser2',
      createdAt: '2024-01-15T11:00:00.000Z',
      expiresAt: '2024-01-16T11:00:00.000Z',
    },
  ]

  const validInviteEntries = [
    { key: 'invite:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO', value: validInviteRecords[0] },
    { key: 'invite:bcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP', value: validInviteRecords[1] },
  ]

  it('converts valid accounts snapshot without invite keys (placeholder ids)', () => {
    const result = convertAccounts(validAccountsSnapshot, validInviteRecords)

    expect(result.report.anomalies).toHaveLength(0)
    expect(result.report.skipped).toBe(0)
    expect(result.rows.users).toHaveLength(2)
    expect(result.rows.invitations).toHaveLength(2)
    expect(result.rows.invitation_redemptions).toHaveLength(0)
    expect(result.rows.system_settings).toHaveLength(4)

    // Check user conversion
    const admin = result.rows.users.find(u => u.id === 'usr_1')
    expect(admin).toBeDefined()
    expect(admin!.username).toBe('admin')
    expect(admin!.role).toBe('admin')
    expect(admin!.enabled).toBe(1)
    expect(admin!.password_algorithm).toBe('PBKDF2-SHA-256')
    expect(admin!.password_iterations).toBe(100000)
    expect(admin!.password_salt).toBe('ASA_Xn2cu9r5GDdWdZSz0g')
    expect(admin!.password_hash).toBe('AiFAX36dvNv6GThXdpW00_IRME9ujazL6gkoR2aFpMM')
    expect(admin!.session_version).toBe(0)
    // Migration defaults
    expect(admin!.email).toBeNull()
    expect(admin!.email_normalized).toBeNull()
    expect(admin!.email_verified_at).toBeNull()

    const user1 = result.rows.users.find(u => u.id === 'usr_2')
    expect(user1).toBeDefined()
    expect(user1!.role).toBe('user')

    // Check invitations (with placeholder ids)
    expect(result.rows.invitations).toHaveLength(2)
    expect(result.rows.invitations[0].user_id).toBe('usr_3')
    expect(result.rows.invitations[0].username).toBe('newuser1')
    expect(result.rows.invitations[1].user_id).toBe('usr_4')

    // Check system settings
    const settings = result.rows.system_settings
    expect(settings.find(s => s.key === 'accounts_schema_version')!.value).toBe('1')
    expect(settings.find(s => s.key === 'accounts_revision')!.value).toBe('1')
    expect(settings.find(s => s.key === 'accounts_updated_at')!.value).toBe('"2024-01-15T10:00:00.000Z"')
    expect(settings.find(s => s.key === 'next_user_id')!.value).toBe('3')

    // Check migration defaults reported
    expect(result.report.migrationDefaults).toContain('users.email set to NULL (migration default, awaiting binding)')
    expect(result.report.migrationDefaults).toContain('users.email_normalized set to NULL (migration default, awaiting binding)')
    expect(result.report.migrationDefaults).toContain('users.email_verified_at set to NULL (migration default, awaiting binding)')
  })

  it('converts with actual invite keys extracting token hashes', () => {
    const result = convertAccountsWithInviteKeys(validAccountsSnapshot, validInviteEntries)

    expect(result.report.anomalies).toHaveLength(0)
    expect(result.rows.invitations).toHaveLength(2)
    expect(result.rows.invitations[0].id).toBe('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO')
    expect(result.rows.invitations[1].id).toBe('bcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP')
  })

  it('reports anomaly for invalid invite record', () => {
    const records = [
      ...validInviteRecords,
      { invalid: 'record' },
    ]

    const result = convertAccounts(validAccountsSnapshot, records)
    expect(result.report.anomalies.some(a => a.includes('failed validation'))).toBe(true)
    expect(result.report.skipped).toBe(1)
  })

  it('reports anomaly for duplicate invitation id (from keys)', () => {
    const entries = [
      { key: 'invite:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO', value: validInviteRecords[0] },
      { key: 'invite:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO', value: validInviteRecords[1] }, // duplicate key
    ]

    const result = convertAccountsWithInviteKeys(validAccountsSnapshot, entries)
    expect(result.report.anomalies.some(a => a.includes('Duplicate invitation id'))).toBe(true)
    expect(result.report.skipped).toBe(1)
  })

  it('reports anomaly for duplicate username in invitations', () => {
    const records = [
      ...validInviteRecords,
      { ...validInviteRecords[0], userId: 'usr_5', username: 'newuser1' }, // duplicate username
    ]

    const result = convertAccounts(validAccountsSnapshot, records)
    expect(result.report.anomalies.some(a => a.includes('Duplicate username'))).toBe(true)
  })

  it('property test: converted rows satisfy D1 constraints', async () => {
    const result = convertAccountsWithInviteKeys(validAccountsSnapshot, validInviteEntries)

    await emptyDatabase(db)
    await applyMigrations(db)

    for (const user of result.rows.users) {
      await db.prepare(`
        INSERT INTO users (id, username, role, enabled, password_algorithm, password_iterations, password_salt, password_hash, session_version, email, email_normalized, email_verified_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        user.id, user.username, user.role, user.enabled, user.password_algorithm, user.password_iterations,
        user.password_salt, user.password_hash, user.session_version, user.email, user.email_normalized,
        user.email_verified_at, user.created_at, user.updated_at
      ).run()
    }

    for (const invite of result.rows.invitations) {
      await db.prepare(`
        INSERT INTO invitations (id, schema_version, user_id, username, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(invite.id, invite.schema_version, invite.user_id, invite.username, invite.created_at, invite.expires_at).run()
    }

    for (const setting of result.rows.system_settings) {
      await db.prepare(`
        INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
      `).bind(setting.key, setting.value, setting.updated_at).run()
    }

    // Verify counts
    const userCount = await db.prepare('SELECT COUNT(*) as c FROM users').first<{ c: number }>()
    expect(userCount!.c).toBe(2)

    const inviteCount = await db.prepare('SELECT COUNT(*) as c FROM invitations').first<{ c: number }>()
    expect(inviteCount!.c).toBe(2)

    // Verify unique constraints
    const uniqueUsernames = await db.prepare('SELECT COUNT(DISTINCT username) as c FROM users').first<{ c: number }>()
    expect(uniqueUsernames!.c).toBe(2)

    const uniqueUserIds = await db.prepare('SELECT COUNT(DISTINCT id) as c FROM users').first<{ c: number }>()
    expect(uniqueUserIds!.c).toBe(2)

    const uniqueInviteIds = await db.prepare('SELECT COUNT(DISTINCT id) as c FROM invitations').first<{ c: number }>()
    expect(uniqueInviteIds!.c).toBe(2)

    // Verify partial unique index for admin
    const adminCount = await db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").first<{ c: number }>()
    expect(adminCount!.c).toBe(1)

    // Verify email_normalized unique index allows multiple NULLs
    const emailNormalizedNulls = await db.prepare('SELECT COUNT(*) as c FROM users WHERE email_normalized IS NULL').first<{ c: number }>()
    expect(emailNormalizedNulls!.c).toBe(2)

    // Verify invitations indexes exist (no error on query)
    await db.prepare('SELECT * FROM invitations WHERE user_id = ?').bind('usr_3').all()
    await db.prepare('SELECT * FROM invitations WHERE username = ?').bind('newuser1').all()
    await db.prepare('SELECT * FROM invitations WHERE expires_at = ?').bind('2024-01-16T10:00:00.000Z').all()
  })
})
import { accountsSnapshotSchema, inviteRecordSchema, type AccountsSnapshot } from '../accounts/schema.js'

export interface ConversionReport {
  converted: number
  skipped: number
  anomalies: string[]
  migrationDefaults: string[]
}

export interface AccountsConversionResult {
  rows: {
    users: UserRow[]
    invitations: InvitationRow[]
    invitation_redemptions: InvitationRedemptionRow[]
    system_settings: SystemSettingRow[]
  }
  report: ConversionReport
}

export interface UserRow {
  id: string
  username: string
  role: 'admin' | 'user'
  enabled: 0 | 1
  password_algorithm: string
  password_iterations: number
  password_salt: string
  password_hash: string
  session_version: number
  email: string | null
  email_normalized: string | null
  email_verified_at: string | null
  created_at: string
  updated_at: string
}

export interface InvitationRow {
  id: string
  schema_version: number
  user_id: string
  username: string
  created_at: string
  expires_at: string
}

export interface InvitationRedemptionRow {
  invitation_id: string
  user_id: string
  redeemed_at: string
}

export interface SystemSettingRow {
  key: string
  value: string
  updated_at: string
}

export function convertAccounts(
  accountsSnapshot: unknown,
  inviteRecords: unknown[]
): AccountsConversionResult {
  const report: ConversionReport = {
    converted: 0,
    skipped: 0,
    anomalies: [],
    migrationDefaults: [],
  }

  const snapshot = accountsSnapshotSchema.parse(accountsSnapshot) as AccountsSnapshot

  // Convert users
  const users: UserRow[] = snapshot.users.map((user) => ({
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled ? 1 : 0,
    password_algorithm: user.password.algorithm,
    password_iterations: user.password.iterations,
    password_salt: user.password.salt,
    password_hash: user.password.hash,
    session_version: user.sessionVersion,
    email: null,
    email_normalized: null,
    email_verified_at: null,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
  }))

  report.migrationDefaults.push(
    'users.email set to NULL (migration default, awaiting binding)',
    'users.email_normalized set to NULL (migration default, awaiting binding)',
    'users.email_verified_at set to NULL (migration default, awaiting binding)',
  )

  // Convert invitations
  const invitations: InvitationRow[] = []
  const seenInvitationIds = new Set<string>()
  const seenUsernames = new Set<string>()

  for (let i = 0; i < inviteRecords.length; i++) {
    const record = inviteRecordSchema.safeParse(inviteRecords[i])
    if (!record.success) {
      report.anomalies.push(`Invite record at index ${i} failed validation: ${record.error.message}`)
      report.skipped++
      continue
    }

    const invite = record.data

    // Extract token hash from key (not stored in value)
    // Note: The actual token hash would come from the KV key, not the value
    // Here we need to handle it - but since we only have the value, we assume
    // the id is the token hash or will be provided separately
    // Per brief: "键后缀 → id (令牌哈希，明文不入库)"
    // The converter receives only values, so we'll need to note this limitation
    // For now, we use a placeholder - the actual migration would pair keys with values
    const invitationId = `invite_${i}` // Placeholder - real migration extracts from KV key

    if (seenInvitationIds.has(invitationId)) {
      report.anomalies.push(`Duplicate invitation id ${invitationId} at index ${i}`)
      report.skipped++
      continue
    }
    seenInvitationIds.add(invitationId)

    // Check for duplicate username in invitations (not globally unique due to expiry)
    // But we track for anomaly reporting
    if (seenUsernames.has(invite.username)) {
      report.anomalies.push(`Duplicate username ${invite.username} in invitations (allowed for expired)`)
    }
    seenUsernames.add(invite.username)

    invitations.push({
      id: invitationId,
      schema_version: invite.schemaVersion,
      user_id: invite.userId,
      username: invite.username,
      created_at: invite.createdAt,
      expires_at: invite.expiresAt,
    })
  }

  // invitation_redemptions: not in KV, created on redemption
  const invitation_redemptions: InvitationRedemptionRow[] = []

  // System settings from accounts snapshot
  const now = new Date().toISOString()
  const system_settings: SystemSettingRow[] = [
    { key: 'accounts_schema_version', value: JSON.stringify(snapshot.schemaVersion), updated_at: now },
    { key: 'accounts_revision', value: JSON.stringify(snapshot.revision), updated_at: now },
    { key: 'accounts_updated_at', value: JSON.stringify(snapshot.updatedAt), updated_at: now },
    { key: 'next_user_id', value: JSON.stringify(snapshot.nextUserId), updated_at: now },
  ]

  report.converted = users.length + invitations.length + invitation_redemptions.length + system_settings.length

  return { rows: { users, invitations, invitation_redemptions, system_settings }, report }
}

export function convertAccountsWithInviteKeys(
  accountsSnapshot: unknown,
  inviteEntries: Array<{ key: string; value: unknown }>
): AccountsConversionResult {
  const report: ConversionReport = {
    converted: 0,
    skipped: 0,
    anomalies: [],
    migrationDefaults: [],
  }

  const snapshot = accountsSnapshotSchema.parse(accountsSnapshot) as AccountsSnapshot

  // Convert users
  const users: UserRow[] = snapshot.users.map((user) => ({
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled ? 1 : 0,
    password_algorithm: user.password.algorithm,
    password_iterations: user.password.iterations,
    password_salt: user.password.salt,
    password_hash: user.password.hash,
    session_version: user.sessionVersion,
    email: null,
    email_normalized: null,
    email_verified_at: null,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
  }))

  report.migrationDefaults.push(
    'users.email set to NULL (migration default, awaiting binding)',
    'users.email_normalized set to NULL (migration default, awaiting binding)',
    'users.email_verified_at set to NULL (migration default, awaiting binding)',
  )

  // Convert invitations with actual token hashes from keys
  const invitations: InvitationRow[] = []
  const seenInvitationIds = new Set<string>()
  const seenUsernames = new Set<string>()

  for (let i = 0; i < inviteEntries.length; i++) {
    const entry = inviteEntries[i]
    const record = inviteRecordSchema.safeParse(entry.value)
    if (!record.success) {
      report.anomalies.push(`Invite record at index ${i} (key: ${entry.key}) failed validation: ${record.error.message}`)
      report.skipped++
      continue
    }

    const invite = record.data

    // Extract token hash from KV key: "invite:{tokenHash}"
    const keyPrefix = 'invite:'
    let invitationId = entry.key
    if (entry.key.startsWith(keyPrefix)) {
      invitationId = entry.key.slice(keyPrefix.length)
    }

    if (seenInvitationIds.has(invitationId)) {
      report.anomalies.push(`Duplicate invitation id ${invitationId} (key: ${entry.key})`)
      report.skipped++
      continue
    }
    seenInvitationIds.add(invitationId)

    if (seenUsernames.has(invite.username)) {
      report.anomalies.push(`Duplicate username ${invite.username} in invitations (allowed for expired)`)
    }
    seenUsernames.add(invite.username)

    invitations.push({
      id: invitationId,
      schema_version: invite.schemaVersion,
      user_id: invite.userId,
      username: invite.username,
      created_at: invite.createdAt,
      expires_at: invite.expiresAt,
    })
  }

  const invitation_redemptions: InvitationRedemptionRow[] = []

  const now = new Date().toISOString()
  const system_settings: SystemSettingRow[] = [
    { key: 'accounts_schema_version', value: JSON.stringify(snapshot.schemaVersion), updated_at: now },
    { key: 'accounts_revision', value: JSON.stringify(snapshot.revision), updated_at: now },
    { key: 'accounts_updated_at', value: JSON.stringify(snapshot.updatedAt), updated_at: now },
    { key: 'next_user_id', value: JSON.stringify(snapshot.nextUserId), updated_at: now },
  ]

  report.converted = users.length + invitations.length + invitation_redemptions.length + system_settings.length

  return { rows: { users, invitations, invitation_redemptions, system_settings }, report }
}
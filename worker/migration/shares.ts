import { shareRecordSchema, shareSettingsSchema } from '../shares/schema.js'

export interface ConversionReport {
  converted: number
  skipped: number
  anomalies: string[]
  nonConvertedKeys: string[]
}

export interface SharesConversionResult {
  rows: {
    shares: ShareRow[]
    system_settings: SystemSettingRow[]
  }
  report: ConversionReport
}

export interface ShareRow {
  id: string
  schema_version: number
  owner_user_id: string
  subscription_id: string
  token_hash: string
  token_prefix: string
  token_encrypted: string
  remark: string
  status: 'active' | 'disabled' | 'revoked'
  access_mode: 'none' | 'password'
  access_password_algorithm: string | null
  access_password_iterations: number | null
  access_password_salt: string | null
  access_password_hash: string | null
  expires_at: string
  allow_original_link: 0 | 1
  show_subscription_name: 0 | 1
  show_groups: 0 | 1
  show_expiry: 0 | 1
  show_node_names: 0 | 1
  require_login: 0 | 1
  max_access_count: number | null
  access_count: number
  last_accessed_at: string | null
  last_original_reveal_at: string | null
  created_at: string
  updated_at: string
}

export interface SystemSettingRow {
  key: string
  value: string
  updated_at: string
}

export function convertShares(
  shareRecords: unknown[],
  shareSettings: unknown
): SharesConversionResult {
  const report: ConversionReport = {
    converted: 0,
    skipped: 0,
    anomalies: [],
    nonConvertedKeys: [],
  }

  // Convert share records
  const shares: ShareRow[] = []
  const seenTokenHashes = new Set<string>()
  const seenIds = new Set<string>()

  for (let i = 0; i < shareRecords.length; i++) {
    const record = shareRecordSchema.safeParse(shareRecords[i])
    if (!record.success) {
      report.anomalies.push(`Share record at index ${i} failed validation: ${record.error.message}`)
      report.skipped++
      continue
    }

    const share = record.data

    // Check for duplicate token_hash
    if (seenTokenHashes.has(share.tokenHash)) {
      report.anomalies.push(`Duplicate token_hash ${share.tokenHash} at index ${i}`)
      report.skipped++
      continue
    }
    seenTokenHashes.add(share.tokenHash)

    // Check for duplicate id
    if (seenIds.has(share.id)) {
      report.anomalies.push(`Duplicate share id ${share.id} at index ${i}`)
      report.skipped++
      continue
    }
    seenIds.add(share.id)

    const accessControl = share.accessControl
    const isPassword = accessControl.mode === 'password'
    const passwordHash = isPassword ? (accessControl as { mode: 'password'; passwordHash: { algorithm: 'PBKDF2-SHA-256'; iterations: number; salt: string; hash: string } }).passwordHash : null

    shares.push({
      id: share.id,
      schema_version: share.schemaVersion,
      owner_user_id: share.ownerUserId,
      subscription_id: share.subscriptionId,
      token_hash: share.tokenHash,
      token_prefix: share.tokenPrefix,
      token_encrypted: JSON.stringify(share.tokenEncrypted),
      remark: share.remark,
      status: share.status,
      access_mode: accessControl.mode,
      access_password_algorithm: passwordHash?.algorithm ?? null,
      access_password_iterations: passwordHash?.iterations ?? null,
      access_password_salt: passwordHash?.salt ?? null,
      access_password_hash: passwordHash?.hash ?? null,
      expires_at: share.expiresAt,
      allow_original_link: share.allowOriginalLink ? 1 : 0,
      show_subscription_name: share.showSubscriptionName ? 1 : 0,
      show_groups: share.showGroups ? 1 : 0,
      show_expiry: share.showExpiry ? 1 : 0,
      show_node_names: share.showNodeNames ? 1 : 0,
      require_login: share.requireLogin ? 1 : 0,
      max_access_count: share.maxAccessCount ?? null,
      access_count: share.accessCount,
      last_accessed_at: share.lastAccessedAt,
      last_original_reveal_at: share.lastOriginalRevealAt,
      created_at: share.createdAt,
      updated_at: share.updatedAt,
    })
  }

  // Convert share settings
  const settings = shareSettingsSchema.safeParse(shareSettings)
  const system_settings: SystemSettingRow[] = []

  if (settings.success) {
    const now = new Date().toISOString()
    system_settings.push({
      key: 'share_settings',
      value: JSON.stringify(settings.data),
      updated_at: now,
    })
    report.converted++
  } else {
    report.anomalies.push(`Share settings failed validation: ${settings.error.message}`)
    report.skipped++
  }

  // Record non-converted KV key types
  report.nonConvertedKeys = [
    'shareidx:user:* (query index, rebuilt from shares.owner_user_id)',
    'shareidx:sub:* (query index, rebuilt from shares.subscription_id)',
    'sharelimit:* (rate limits, derived data - not converted)',
    'compiled:share:* (compiled artifacts, derived data - not converted)',
  ]

  report.converted += shares.length

  return { rows: { shares, system_settings }, report }
}

export function convertShareSeq(kvValue: unknown): { next_share_id: number } {
  const data = kvValue as { next: number } | null
  return { next_share_id: data?.next ?? 1 }
}
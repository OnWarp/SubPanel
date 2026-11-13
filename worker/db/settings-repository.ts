import { z } from 'zod'
import {
  canonicalPublicBaseUrl,
  DEFAULT_SHARE_SETTINGS,
  shareSettingsSchema,
  type ShareSettings,
} from '../shares/schema.js'
import { queryFirst, type AppDatabase } from './db.js'

export const REGISTRATION_MODE_KEY = 'registration_mode'
export const SHARE_SETTINGS_KEY = 'share_settings'

// Mail configuration keys (batch 5). Read by worker/accounts/email.ts when
// no Worker secret covers the same setting; the admin settings UI that
// writes them lands in batch 9.
export const MAIL_SETTING_KEYS = {
  provider: 'mail_provider',
  from: 'mail_from',
  smtpHost: 'mail_smtp_host',
  smtpPort: 'mail_smtp_port',
  smtpUser: 'mail_smtp_user',
  smtpPass: 'mail_smtp_pass',
  resendApiKey: 'mail_resend_api_key',
} as const

export const registrationModeSchema = z.enum(['closed', 'invite', 'open'])
export type RegistrationMode = z.infer<typeof registrationModeSchema>

export const DEFAULT_REGISTRATION_MODE: RegistrationMode = 'invite'

type SettingRow = {
  value: string
}

export function encodeSettingJson(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') throw new Error('Setting value is corrupt')
  return encoded
}

export function decodeSettingJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Setting value is corrupt')
  }
}

export async function getSetting(db: AppDatabase, key: string): Promise<string | null> {
  const row = await queryFirst<SettingRow>(
    db.prepare('SELECT value FROM system_settings WHERE key = ?').bind(key),
  )
  return row?.value ?? null
}

export async function putSetting(
  db: AppDatabase,
  key: string,
  value: unknown,
  now = new Date().toISOString(),
): Promise<void> {
  if (key.length === 0) throw new Error('Setting value is corrupt')
  await db.prepare(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).bind(key, encodeSettingJson(value), now).run()
}

export async function getRegistrationMode(db: AppDatabase): Promise<RegistrationMode> {
  const raw = await getSetting(db, REGISTRATION_MODE_KEY)
  if (raw === null) return DEFAULT_REGISTRATION_MODE
  const parsed = registrationModeSchema.safeParse(decodeSettingJson(raw))
  if (!parsed.success) throw new Error('Setting value is corrupt')
  return parsed.data
}

export async function putRegistrationMode(
  db: AppDatabase,
  mode: RegistrationMode,
  now = new Date().toISOString(),
): Promise<void> {
  await putSetting(db, REGISTRATION_MODE_KEY, registrationModeSchema.parse(mode), now)
}

export async function getShareSettings(db: AppDatabase): Promise<ShareSettings> {
  const raw = await getSetting(db, SHARE_SETTINGS_KEY)
  if (raw === null) return { ...DEFAULT_SHARE_SETTINGS }
  const value = decodeSettingJson(raw)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Setting value is corrupt')
  }
  const parsed = shareSettingsSchema.safeParse({ ...DEFAULT_SHARE_SETTINGS, ...value })
  if (!parsed.success) throw new Error('Setting value is corrupt')
  const publicBaseUrl = canonicalPublicBaseUrl(parsed.data.publicBaseUrl)
  if (publicBaseUrl === null) throw new Error('Setting value is corrupt')
  return { ...parsed.data, publicBaseUrl }
}

export async function putShareSettings(
  db: AppDatabase,
  settings: ShareSettings,
  now = new Date().toISOString(),
): Promise<void> {
  const parsed = shareSettingsSchema.parse(settings)
  const publicBaseUrl = canonicalPublicBaseUrl(parsed.publicBaseUrl)
  if (publicBaseUrl === null) throw new Error('Setting value is corrupt')
  await putSetting(db, SHARE_SETTINGS_KEY, { ...parsed, publicBaseUrl }, now)
}

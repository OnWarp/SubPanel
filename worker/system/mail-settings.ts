import { z } from 'zod'
import type { AppDatabase } from '../db/db.js'
import { decodeSettingJson, getSetting, putSetting } from '../db/settings-repository.js'

export const MAIL_SETTING_KEYS = {
  provider: 'mail_provider',
  from: 'mail_from',
  smtpHost: 'mail_smtp_host',
  smtpPort: 'mail_smtp_port',
  smtpUser: 'mail_smtp_user',
  smtpPass: 'mail_smtp_pass',
  resendApiKey: 'mail_resend_api_key',
} as const

export const mailProviderSchema = z.enum(['smtp', 'resend'])
export type MailProvider = z.infer<typeof mailProviderSchema>

// Raw settings as stored. Only server code may see smtpPass / resendApiKey;
// anything returned to the admin UI goes through toPublicMailSettings.
export interface MailSettings {
  provider: MailProvider
  from: string
  smtpHost: string
  smtpPort: number | null
  smtpUser: string
  smtpPass: string | null
  resendApiKey: string | null
}

export interface PublicMailSettings {
  provider: MailProvider
  from: string
  smtpHost: string
  smtpPort: number | null
  smtpUser: string
  smtpPasswordSet: boolean
  resendApiKeySet: boolean
}

export const DEFAULT_MAIL_SETTINGS: MailSettings = {
  provider: 'smtp',
  from: '',
  smtpHost: '',
  smtpPort: null,
  smtpUser: '',
  smtpPass: null,
  resendApiKey: null,
}

// Sensitive fields follow write-only semantics: an absent field or an empty
// string keeps the stored value, a non-empty string replaces it. There is no
// way to read a stored secret back through this patch shape.
export const mailSettingsPatchSchema = z.object({
  provider: mailProviderSchema.optional(),
  from: z.string().trim().max(320).optional(),
  smtpHost: z.string().trim().max(255).optional(),
  smtpPort: z.number().int().min(1).max(65_535).nullable().optional(),
  smtpUser: z.string().trim().max(320).optional(),
  smtpPassword:
    z.string().max(1024).optional(),
  resendApiKey: z.string().max(512).optional(),
}).strict()
export type MailSettingsPatch = z.infer<typeof mailSettingsPatchSchema>

function readString(values: Map<string, unknown>, key: string): string | null {
  const value = values.get(key)
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('Setting value is corrupt')
  return value
}

function readPort(values: Map<string, unknown>): number | null {
  const value = values.get(MAIL_SETTING_KEYS.smtpPort)
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('Setting value is corrupt')
  }
  return value
}

function readProvider(values: Map<string, unknown>): MailProvider {
  const raw = readString(values, MAIL_SETTING_KEYS.provider)
  if (raw === null) return DEFAULT_MAIL_SETTINGS.provider
  const parsed = mailProviderSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Setting value is corrupt')
  return parsed.data
}

export function assembleMailSettings(values: Map<string, unknown>): MailSettings {
  return {
    provider: readProvider(values),
    from: readString(values, MAIL_SETTING_KEYS.from) ?? '',
    smtpHost: readString(values, MAIL_SETTING_KEYS.smtpHost) ?? '',
    smtpPort: readPort(values),
    smtpUser: readString(values, MAIL_SETTING_KEYS.smtpUser) ?? '',
    smtpPass: readString(values, MAIL_SETTING_KEYS.smtpPass),
    resendApiKey: readString(values, MAIL_SETTING_KEYS.resendApiKey),
  }
}

export async function readMailSettings(db: AppDatabase): Promise<MailSettings> {
  const keys = Object.values(MAIL_SETTING_KEYS)
  const values = new Map<string, unknown>()
  for (const key of keys) {
    const raw = await getSetting(db, key)
    if (raw !== null) values.set(key, decodeSettingJson(raw))
  }
  return assembleMailSettings(values)
}

export function toPublicMailSettings(settings: MailSettings): PublicMailSettings {
  return {
    provider: settings.provider,
    from: settings.from,
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpUser: settings.smtpUser,
    smtpPasswordSet: settings.smtpPass !== null && settings.smtpPass !== '',
    resendApiKeySet: settings.resendApiKey !== null && settings.resendApiKey !== '',
  }
}

// Pure patch application, exported for tests: returns the next raw settings
// plus the list of storage keys that must be written.
export function applyMailSettingsPatch(
  current: MailSettings,
  patch: MailSettingsPatch,
): { next: MailSettings; changedKeys: string[] } {
  const next: MailSettings = { ...current }
  const changedKeys: string[] = []
  if (patch.provider !== undefined) {
    next.provider = patch.provider
    changedKeys.push(MAIL_SETTING_KEYS.provider)
  }
  if (patch.from !== undefined) {
    next.from = patch.from
    changedKeys.push(MAIL_SETTING_KEYS.from)
  }
  if (patch.smtpHost !== undefined) {
    next.smtpHost = patch.smtpHost
    changedKeys.push(MAIL_SETTING_KEYS.smtpHost)
  }
  if (patch.smtpPort !== undefined) {
    next.smtpPort = patch.smtpPort
    changedKeys.push(MAIL_SETTING_KEYS.smtpPort)
  }
  if (patch.smtpUser !== undefined) {
    next.smtpUser = patch.smtpUser
    changedKeys.push(MAIL_SETTING_KEYS.smtpUser)
  }
  if (patch.smtpPassword !== undefined && patch.smtpPassword !== '') {
    next.smtpPass = patch.smtpPassword
    changedKeys.push(MAIL_SETTING_KEYS.smtpPass)
  }
  if (patch.resendApiKey !== undefined && patch.resendApiKey !== '') {
    next.resendApiKey = patch.resendApiKey
    changedKeys.push(MAIL_SETTING_KEYS.resendApiKey)
  }
  return { next, changedKeys }
}

const KEY_TO_FIELD: Record<string, keyof MailSettings> = {
  [MAIL_SETTING_KEYS.provider]: 'provider',
  [MAIL_SETTING_KEYS.from]: 'from',
  [MAIL_SETTING_KEYS.smtpHost]: 'smtpHost',
  [MAIL_SETTING_KEYS.smtpPort]: 'smtpPort',
  [MAIL_SETTING_KEYS.smtpUser]: 'smtpUser',
  [MAIL_SETTING_KEYS.smtpPass]: 'smtpPass',
  [MAIL_SETTING_KEYS.resendApiKey]: 'resendApiKey',
}

export async function updateMailSettings(
  db: AppDatabase,
  patch: MailSettingsPatch,
  now = new Date().toISOString(),
): Promise<MailSettings> {
  const current = await readMailSettings(db)
  const { next, changedKeys } = applyMailSettingsPatch(current, patch)
  for (const key of changedKeys) {
    const field = KEY_TO_FIELD[key]
    await putSetting(db, key, next[field], now)
  }
  return next
}

export type RegistrationMode = 'open' | 'invite' | 'closed'

export type MailProvider = 'smtp' | 'resend'

export type SystemMailSettings = {
  provider: MailProvider
  from: string
  smtpHost: string
  smtpPort: number | null
  smtpUser: string
  smtpPasswordSet: boolean
  resendApiKeySet: boolean
}

export type MailSettingsForm = {
  provider: MailProvider
  from: string
  smtpHost: string
  smtpPort: string
  smtpUser: string
  smtpPass: string
  resendKey: string
}

export type SystemModuleStatus = {
  module: string
  label: string
  backend: 'd1' | 'kv'
  schemaVersion: number | null
  updatedAt: string | null
}

export type SystemMigration = {
  name: string
  appliedAt: string | null
}

export type SystemStatus = {
  databaseName: string
  modules: SystemModuleStatus[]
  migrations: SystemMigration[]
}

export type EmailDomainEntry = {
  domain: string
  createdAt?: string
}

export function toMailSettingsForm(settings: SystemMailSettings): MailSettingsForm {
  return {
    provider: settings.provider,
    from: settings.from,
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort === null ? '' : String(settings.smtpPort),
    smtpUser: settings.smtpUser,
    smtpPass: '',
    resendKey: '',
  }
}

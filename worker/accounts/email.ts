import { env as workerEnv } from 'cloudflare:workers'
import { readSettingMap } from '../db/module-switch.js'
import { MAIL_SETTING_KEYS } from '../db/settings-repository.js'
import { sendViaSmtp, type SmtpConfig } from './mail-smtp.js'
import type { VerificationPurpose } from './email-verification.js'

// Mail infrastructure (batch 5). Two providers: Resend (HTTPS API) and SMTP
// (cloudflare:sockets submission client, see mail-smtp.ts). Configuration
// resolution order: Worker secrets first (RESEND_API_KEY, SMTP_URL,
// MAIL_FROM), then the system_settings mail_* keys (the settings page lands
// in batch 9; this batch implements reading and validation only). With no
// usable configuration, sending is a no-op that logs a warning.
//
// Outbound discipline: mail is sent only when a user action triggers it,
// one message at a time, and a failed send is retried at most once.

export interface EmailVerificationMessage {
  to: string
  code: string
  username?: string
  purpose?: VerificationPurpose
}

export interface MailMessage {
  to: string
  subject: string
  text: string
  html: string
}

export type MailProviderName = 'resend' | 'smtp'

export type ResolvedMailConfig =
  | { provider: 'resend'; apiKey: string; from: string }
  | { provider: 'smtp'; from: string; smtp: SmtpConfig }

export interface MailSendResult {
  ok: boolean
  provider: MailProviderName | null
  error?: string
}

type EmailVerificationDeliverer = (message: EmailVerificationMessage) => Promise<void>

let deliverer: EmailVerificationDeliverer | null = null

// Test hook and escape hatch: a registered deliverer replaces the built-in
// provider transport for verification codes (tests capture codes this way).
export function setEmailVerificationDeliverer(next: EmailVerificationDeliverer | null): void {
  deliverer = next
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function secretValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

async function mailSettings(): Promise<Map<string, unknown>> {
  try {
    return await readSettingMap(workerEnv.DB, Object.values(MAIL_SETTING_KEYS))
  } catch {
    return new Map()
  }
}

function settingString(settings: Map<string, unknown>, key: string): string | undefined {
  const value = settings.get(key)
  if (typeof value === 'string') return secretValue(value)
  if (typeof value === 'number') return String(value)
  return undefined
}

function unusable(reason: string): null {
  console.warn(`[mail] configuration unusable: ${reason}`)
  return null
}

function parseSmtpUrl(raw: string): SmtpConfig | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return unusable('SMTP_URL is not a valid URL')
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    return unusable('SMTP_URL must use the smtp:// or smtps:// scheme')
  }
  const port = url.port === '' ? (url.protocol === 'smtps:' ? 465 : 587) : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return unusable('SMTP_URL has an invalid port')
  const user = url.username === '' ? undefined : decodeURIComponent(url.username)
  const pass = url.password === '' ? undefined : decodeURIComponent(url.password)
  if ((user === undefined) !== (pass === undefined)) return unusable('SMTP_URL needs both a user and a password')
  return {
    host: url.hostname,
    port,
    user,
    pass,
    secure: url.protocol === 'smtps:' || port === 465,
  }
}

function smtpFromSettings(settings: Map<string, unknown>): SmtpConfig | null {
  const host = settingString(settings, MAIL_SETTING_KEYS.smtpHost)
  if (!host) return unusable('mail_smtp_host is missing')
  const rawPort = settingString(settings, MAIL_SETTING_KEYS.smtpPort)
  const port = rawPort === undefined ? 587 : Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return unusable('mail_smtp_port is invalid')
  const user = settingString(settings, MAIL_SETTING_KEYS.smtpUser)
  const pass = settingString(settings, MAIL_SETTING_KEYS.smtpPass)
  if ((user === undefined) !== (pass === undefined)) {
    return unusable('mail_smtp_user and mail_smtp_pass must be set together')
  }
  return { host, port, user, pass, secure: port === 465 }
}

export async function resolveMailConfig(): Promise<ResolvedMailConfig | null> {
  const settings = await mailSettings()
  const from = secretValue(workerEnv.MAIL_FROM) ?? settingString(settings, MAIL_SETTING_KEYS.from)
  const fromUsable = from !== undefined && EMAIL_PATTERN.test(from)

  const resendSecret = secretValue(workerEnv.RESEND_API_KEY)
  if (resendSecret) {
    return fromUsable ? { provider: 'resend', apiKey: resendSecret, from } : unusable('mail_from is missing or invalid')
  }
  const smtpSecret = secretValue(workerEnv.SMTP_URL)
  if (smtpSecret) {
    const smtp = parseSmtpUrl(smtpSecret)
    if (!smtp) return null
    return fromUsable ? { provider: 'smtp', from, smtp } : unusable('mail_from is missing or invalid')
  }

  const provider = settingString(settings, MAIL_SETTING_KEYS.provider)
  if (provider === 'resend') {
    const apiKey = settingString(settings, MAIL_SETTING_KEYS.resendApiKey)
    if (!apiKey) return unusable('mail_resend_api_key is missing')
    return fromUsable ? { provider: 'resend', apiKey, from } : unusable('mail_from is missing or invalid')
  }
  if (provider === 'smtp') {
    const smtp = smtpFromSettings(settings)
    if (!smtp) return null
    return fromUsable ? { provider: 'smtp', from, smtp } : unusable('mail_from is missing or invalid')
  }
  if (provider !== undefined) return unusable(`unknown mail_provider: ${provider}`)
  return null
}

async function sendViaResend(apiKey: string, from: string, message: MailMessage): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from, to: message.to, subject: message.subject, text: message.text, html: message.html }),
  })
  if (!response.ok) throw new Error(`Resend API responded with ${response.status}`)
}

export async function sendMail(message: MailMessage): Promise<MailSendResult> {
  const config = await resolveMailConfig()
  if (!config) {
    console.warn(`[mail] no mail provider configured; message to ${message.to} was not sent`)
    return { ok: false, provider: null, error: '邮件服务未配置' }
  }
  // One initial attempt plus at most one retry, then the failure is final.
  let lastError = 'unknown error'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (config.provider === 'resend') await sendViaResend(config.apiKey, config.from, message)
      else await sendViaSmtp(config.smtp, { from: config.from, ...message })
      return { ok: true, provider: config.provider }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  console.warn(`[mail] send via ${config.provider} failed: ${lastError}`)
  return { ok: false, provider: config.provider, error: lastError }
}

const PURPOSE_LINES: Record<VerificationPurpose, { zh: string; en: string }> = {
  register: { zh: '用途：注册账号', en: 'Purpose: account registration' },
  bind_email: { zh: '用途：绑定邮箱', en: 'Purpose: email binding' },
  change_email: { zh: '用途：更换邮箱', en: 'Purpose: email change' },
  reset_password: { zh: '用途：重置密码', en: 'Purpose: password reset' },
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function verificationEmailContent(message: EmailVerificationMessage): Omit<MailMessage, 'to'> {
  const purpose = PURPOSE_LINES[message.purpose ?? 'bind_email']
  const greetingZh = message.username ? `${message.username}，你好` : '你好'
  const greetingEn = message.username ? `Hello, ${message.username}` : 'Hello'
  const text = [
    `${greetingZh}，你的 SubPanel 验证码是 ${message.code}`,
    `${greetingEn}, your SubPanel verification code is ${message.code}`,
    '',
    purpose.zh,
    purpose.en,
    '',
    '验证码 10 分钟内有效，请勿告诉任何人',
    'The code is valid for 10 minutes. Do not share it with anyone',
  ].join('\n')
  const html = [
    `<p>${escapeHtml(greetingZh)}，你的 SubPanel 验证码是 <strong>${escapeHtml(message.code)}</strong></p>`,
    `<p>${escapeHtml(greetingEn)}, your SubPanel verification code is <strong>${escapeHtml(message.code)}</strong></p>`,
    `<p>${purpose.zh}<br>${purpose.en}</p>`,
    '<p>验证码 10 分钟内有效，请勿告诉任何人<br>The code is valid for 10 minutes. Do not share it with anyone</p>',
  ].join('\n')
  return { subject: 'SubPanel 验证码 / Verification code', text, html }
}

export async function sendEmailVerificationCode(message: EmailVerificationMessage): Promise<void> {
  if (deliverer) {
    await deliverer(message)
    return
  }
  const result = await sendMail({ to: message.to, ...verificationEmailContent(message) })
  if (!result.ok) {
    console.warn(`[email] verification code for ${message.to} was not delivered (${result.error ?? 'unknown error'})`)
  }
}

export async function sendTestEmail(to: string): Promise<MailSendResult> {
  return sendMail({
    to,
    subject: 'SubPanel 测试邮件 / Test email',
    text: [
      '这是一封来自 SubPanel 的测试邮件',
      'This is a test email from SubPanel',
      '',
      '收到这封邮件说明邮件发送配置工作正常',
      'Receiving this email means the mail configuration works',
    ].join('\n'),
    html: [
      '<p>这是一封来自 SubPanel 的测试邮件<br>This is a test email from SubPanel</p>',
      '<p>收到这封邮件说明邮件发送配置工作正常<br>Receiving this email means the mail configuration works</p>',
    ].join('\n'),
  })
}

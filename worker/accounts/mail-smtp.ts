import { connect } from 'cloudflare:sockets'

// Minimal SMTP submission client for Workers, built on cloudflare:sockets.
// Plain TCP is used to reach the relay; port 465 uses implicit TLS and any
// other port upgrades with STARTTLS when the server offers it (otherwise the
// session continues unencrypted only when no credentials are configured to
// protect). Only AUTH LOGIN is supported, which covers mainstream
// submission services; AUTH PLAIN / CRAM-MD5 relays are out of scope.
export interface SmtpConfig {
  host: string
  port: number
  user?: string
  pass?: string
  // true: TLS from the first byte (port 465); false: STARTTLS upgrade.
  secure: boolean
}

export interface SmtpMessage {
  from: string
  to: string
  subject: string
  text: string
  html: string
}

const COMMAND_TIMEOUT_MS = 15_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`SMTP ${label} timed out`)), COMMAND_TIMEOUT_MS)
    }),
  ])
}

class SmtpSession {
  private socket: Socket
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private buffer = ''

  constructor(socket: Socket) {
    this.socket = socket
    this.reader = socket.readable.getReader()
    this.writer = socket.writable.getWriter()
  }

  async readReply(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = []
    for (;;) {
      const newline = this.buffer.indexOf('\r\n')
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 2)
        lines.push(line)
        const match = /^(\d{3})([ -])/.exec(line)
        if (match && match[2] === ' ') return { code: Number(match[1]), lines }
        continue
      }
      const chunk = await withTimeout(this.reader.read(), 'read')
      if (chunk.done) throw new Error('SMTP connection closed unexpectedly')
      this.buffer += decoder.decode(chunk.value, { stream: true })
    }
  }

  async command(line: string, expected: number[]): Promise<{ code: number; lines: string[] }> {
    await withTimeout(this.writer.write(encoder.encode(`${line}\r\n`)), 'write')
    const reply = await this.readReply()
    if (!expected.includes(reply.code)) {
      throw new Error(`SMTP command ${line.split(' ')[0]} failed with ${reply.code}: ${reply.lines.at(-1) ?? ''}`)
    }
    return reply
  }

  async writeRaw(data: string): Promise<void> {
    await withTimeout(this.writer.write(encoder.encode(data)), 'write')
  }

  upgradeToTls(): void {
    this.reader.releaseLock()
    this.writer.releaseLock()
    this.socket = this.socket.startTls()
    this.reader = this.socket.readable.getReader()
    this.writer = this.socket.writable.getWriter()
    this.buffer = ''
  }

  async close(): Promise<void> {
    try {
      await this.socket.close()
    } catch {
      // The socket may already be gone after a failed session.
    }
  }
}

function encodeWord(value: string): string {
  return `=?UTF-8?B?${btoa(String.fromCharCode(...encoder.encode(value)))}?=`
}

function encodeBase64Body(value: string): string {
  const bytes = encoder.encode(value.replaceAll('\n', '\r\n'))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/.{76}/g, '$&\r\n')
}

function buildMimeMessage(message: SmtpMessage): string {
  const boundary = `subpanel-${crypto.randomUUID().replaceAll('-', '')}`
  const messageId = `<${crypto.randomUUID()}@subpanel>`
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${encodeWord(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBase64Body(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBase64Body(message.html),
    `--${boundary}--`,
  ]
  const payload = [...headers, '', ...parts].join('\r\n')
  // Dot-stuffing for the DATA phase.
  return payload
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n')
}

export async function sendViaSmtp(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  const socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: config.secure ? 'on' : 'starttls', allowHalfOpen: false },
  )
  const session = new SmtpSession(socket)
  try {
    await session.readReply() // 220 greeting (not asserted; some relays vary)
    const ehlo = await session.command(`EHLO ${config.host}`, [250])
    if (!config.secure && ehlo.lines.some((line) => line.toUpperCase().includes('STARTTLS'))) {
      await session.command('STARTTLS', [220])
      session.upgradeToTls()
      await session.command(`EHLO ${config.host}`, [250])
    } else if (!config.secure && config.user) {
      throw new Error('SMTP server does not offer STARTTLS; refusing to send credentials unencrypted')
    }
    if (config.user) {
      const encode = (value: string) => btoa(String.fromCharCode(...encoder.encode(value)))
      await session.command('AUTH LOGIN', [334])
      await session.command(encode(config.user), [334])
      await session.command(encode(config.pass ?? ''), [235])
    }
    await session.command(`MAIL FROM:<${message.from}>`, [250])
    await session.command(`RCPT TO:<${message.to}>`, [250, 251])
    await session.command('DATA', [354])
    await session.writeRaw(`${buildMimeMessage(message)}\r\n.\r\n`)
    const accepted = await session.readReply()
    if (accepted.code !== 250) {
      throw new Error(`SMTP message rejected with ${accepted.code}: ${accepted.lines.at(-1) ?? ''}`)
    }
    await session.command('QUIT', [221])
  } finally {
    await session.close()
  }
}

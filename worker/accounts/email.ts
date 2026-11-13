export interface EmailVerificationMessage {
  to: string
  code: string
  username: string
}

type EmailVerificationDeliverer = (message: EmailVerificationMessage) => Promise<void>

let deliverer: EmailVerificationDeliverer | null = null

// The single sending entry point for verification codes. The project has no
// mail transport yet: batch 5 wires SMTP/Resend by registering the real
// deliverer here (setEmailVerificationDeliverer). Until then sending is a
// no-op with a warning, so the binding flow stays exercisable in tests,
// which register a capturing deliverer through the same hook.
export function setEmailVerificationDeliverer(next: EmailVerificationDeliverer | null): void {
  deliverer = next
}

export async function sendEmailVerificationCode(message: EmailVerificationMessage): Promise<void> {
  if (deliverer) {
    await deliverer(message)
    return
  }
  console.warn(`[email] no transport configured; verification code for ${message.to} was not delivered`)
}

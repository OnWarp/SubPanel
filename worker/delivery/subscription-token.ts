const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function randomSubscriptionToken(): string {
  let token = ''
  // Reject values outside the largest multiple of 62 to keep characters uniform.
  const cutoff = 256 - (256 % alphabet.length)
  while (token.length < 16) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16 - token.length))) {
      if (byte < cutoff) token += alphabet[byte % alphabet.length]
    }
  }
  return token
}

export const tokenPattern = /^(?:[A-Za-z0-9]{16}|[A-Za-z0-9_-]{43})$/u

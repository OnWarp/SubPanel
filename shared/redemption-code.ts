export const redemptionAlphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
export const shortCodeLength = 12

const inputAlphabet = redemptionAlphabet + redemptionAlphabet.toLowerCase()
const group = `[${inputAlphabet}]{4}`
const shortCode = new RegExp(`^(?:[${inputAlphabet}]{${shortCodeLength}}|${group}(?:-${group}){2})$`, 'u')
const legacyCode = new RegExp(`^[${redemptionAlphabet}]{28}$`, 'u')

export function normalizeCode(input: string) {
  if (input.length > 100) return null
  const trimmed = input.trim()
  if (shortCode.test(trimmed)) {
    return trimmed.replace(/-/gu, '').toUpperCase()
  }

  // Preserve the original normalization for credentials already issued.
  const legacy = input.replace(/[\s-]/gu, '').toUpperCase()
  return legacyCode.test(legacy) ? legacy : null
}

export function formatCode(canonical: string) {
  return canonical.replace(/(.{4})(?=.)/gu, '$1-')
}

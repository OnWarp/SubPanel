export const DOMAIN_VERIFY_PATH = '/.well-known/subpanel-verify'
export const VERIFY_FAILURES = [
  'CHALLENGE_EXPIRED', 'CHALLENGE_INVALID', 'PROOF_INVALID', 'INSTANCE_MISMATCH', 'PROBE_FAILED', 'TIMEOUT',
] as const

export type VerifyFailure = typeof VERIFY_FAILURES[number]

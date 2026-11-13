import { md5Hex } from './md5.js'
import type { AccountUser } from './schema.js'

// Avatar selection (Roye's rule, batch 7): regular users always get a
// DiceBear notionists-neutral avatar generated from a fixed seed and can
// never upload one; administrators get their Gravatar (keyed by the bound
// email) and fall back to the same DiceBear avatar while no email is bound.
// The seed is the user id: it never changes, even if profile fields do.
export interface AvatarDescriptor {
  kind: 'gravatar' | 'dicebear'
  url: string
  seed: string
}

export const avatarSeed = (user: Pick<AccountUser, 'id'>): string => user.id

export const diceBearAvatarUrl = (seed: string): string =>
  `https://api.dicebear.com/9.x/notionists-neutral/svg?seed=${encodeURIComponent(seed)}`

export const gravatarAvatarUrl = (emailNormalized: string): string =>
  `https://www.gravatar.com/avatar/${md5Hex(emailNormalized)}?s=160`

export function resolveAvatar(user: AccountUser): AvatarDescriptor {
  const seed = avatarSeed(user)
  if (user.role === 'admin' && user.emailNormalized) {
    return { kind: 'gravatar', url: gravatarAvatarUrl(user.emailNormalized), seed }
  }
  return { kind: 'dicebear', url: diceBearAvatarUrl(seed), seed }
}

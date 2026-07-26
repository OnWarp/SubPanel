import { z } from 'zod'

export const roleSchema = z.enum(['admin', 'user'])
export const userIdSchema = z.string().regex(/^usr_[1-9]\d*$/)
export const usernameSchema = z.string().min(3).max(32).regex(/^[a-z0-9._-]+$/)
export const usernameInputSchema = z.string().trim().toLowerCase().pipe(usernameSchema)
export const passwordInputSchema = z.string().min(12).max(128)

export const passwordHashSchema = z.object({
  algorithm: z.literal('PBKDF2-SHA-256'),
  iterations: z.number().int().positive(),
  salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

export const userSchema = z.object({
  id: userIdSchema,
  username: usernameSchema,
  role: roleSchema,
  enabled: z.boolean(),
  password: passwordHashSchema,
  sessionVersion: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const accountsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
    nextUserId: z.number().int().positive(),
    users: z.array(userSchema),
  })
  .superRefine((snapshot, ctx) => {
    const ids = new Set<string>()
    const usernames = new Set<string>()
    let adminCount = 0
    let maxUserId = 0
    for (const user of snapshot.users) {
      if (ids.has(user.id)) ctx.addIssue({ code: 'custom', message: `Duplicate user id: ${user.id}` })
      if (usernames.has(user.username)) ctx.addIssue({ code: 'custom', message: `Duplicate username: ${user.username}` })
      ids.add(user.id)
      usernames.add(user.username)
      maxUserId = Math.max(maxUserId, Number(user.id.slice('usr_'.length)))
      if (user.role === 'admin') adminCount += 1
    }
    if (snapshot.nextUserId <= maxUserId) {
      ctx.addIssue({ code: 'custom', path: ['nextUserId'], message: 'nextUserId must be greater than all existing user IDs' })
    }
    if (adminCount > 1) ctx.addIssue({ code: 'custom', message: 'Only one administrator is allowed' })
    if (snapshot.users.length > 0 && adminCount !== 1) {
      ctx.addIssue({ code: 'custom', message: 'A non-empty account snapshot requires one administrator' })
    }
  })

export type PasswordHash = z.infer<typeof passwordHashSchema>
export type User = z.infer<typeof userSchema>
export type AccountsSnapshot = z.infer<typeof accountsSnapshotSchema>

export type PublicUser = Pick<User, 'id' | 'username' | 'role' | 'enabled' | 'createdAt' | 'updatedAt'>

export const toPublicUser = (user: User): PublicUser => ({
  id: user.id,
  username: user.username,
  role: user.role,
  enabled: user.enabled,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
})

export const emptyAccountsSnapshot = (now = '1970-01-01T00:00:00.000Z'): AccountsSnapshot => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: now,
  nextUserId: 1,
  users: [],
})

export const inviteRecordSchema = z.object({
  schemaVersion: z.literal(1),
  userId: userIdSchema,
  username: usernameSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
})

export type InviteRecord = z.infer<typeof inviteRecordSchema>

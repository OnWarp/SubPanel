import { ACCOUNTS_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import {
  findUserByEmailNormalized,
  findUserById,
  findUserByUsername,
  persistAccountsSnapshot,
  readAccountsFromD1,
} from './d1-repository.js'
import {
  accountsSnapshotSchema,
  emptyAccountsSnapshot,
  normalizeEmail,
  type AccountUser,
  type AccountsSnapshot,
  type User,
} from './schema.js'

export const ACCOUNTS_KEY = 'state:accounts'

export async function readAccountsKv(kv: KVNamespace): Promise<AccountsSnapshot> {
  const raw = await kv.get(ACCOUNTS_KEY)
  if (raw === null) return emptyAccountsSnapshot()

  try {
    return accountsSnapshotSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error('Accounts snapshot is corrupt')
  }
}

export async function accountsUseD1(env: DataEnv): Promise<boolean> {
  return isModuleReady(env.DB, ACCOUNTS_D1_READY_KEY)
}

export async function readAccounts(env: DataEnv): Promise<AccountsSnapshot> {
  if (await accountsUseD1(env)) return readAccountsFromD1(env.DB)
  return readAccountsKv(env.DATA)
}

export async function writeAccounts(
  env: DataEnv,
  snapshot: AccountsSnapshot,
  now = new Date().toISOString(),
): Promise<AccountsSnapshot> {
  const result = accountsSnapshotSchema.safeParse({
    ...snapshot,
    revision: snapshot.revision + 1,
    updatedAt: now,
  })
  if (!result.success) throw new Error('Accounts snapshot validation failed')

  // One backend only: the import flag selects D1, and its absence keeps KV.
  if (await accountsUseD1(env)) await persistAccountsSnapshot(env.DB, result.data)
  else await env.DATA.put(ACCOUNTS_KEY, JSON.stringify(result.data))
  return result.data
}

const withNullEmail = (user: User): AccountUser => ({
  ...user,
  email: null,
  emailNormalized: null,
  emailVerifiedAt: null,
})

export async function findAccountUserById(env: DataEnv, id: string): Promise<AccountUser | null> {
  if (await accountsUseD1(env)) return findUserById(env.DB, id)
  const accounts = await readAccountsKv(env.DATA)
  const user = accounts.users.find((candidate) => candidate.id === id)
  return user ? withNullEmail(user) : null
}

// Login accepts a single identifier: a username, or the account's bound
// email (normalized the same way as at binding time). Email only exists in
// D1 mode, so the KV branch can only match usernames.
export async function findAccountUserForLogin(
  env: DataEnv,
  identifier: string,
): Promise<AccountUser | null> {
  const username = identifier.trim().toLowerCase()
  if (await accountsUseD1(env)) {
    const byUsername = await findUserByUsername(env.DB, username)
    if (byUsername) return byUsername
    return findUserByEmailNormalized(env.DB, normalizeEmail(identifier))
  }
  const accounts = await readAccountsKv(env.DATA)
  const user = accounts.users.find((candidate) => candidate.username === username)
  return user ? withNullEmail(user) : null
}

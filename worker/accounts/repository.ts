import { accountsSnapshotSchema, emptyAccountsSnapshot, type AccountsSnapshot } from './schema.js'

export const ACCOUNTS_KEY = 'state:accounts'

export async function readAccounts(kv: KVNamespace): Promise<AccountsSnapshot> {
  const raw = await kv.get(ACCOUNTS_KEY)
  if (raw === null) return emptyAccountsSnapshot()

  try {
    return accountsSnapshotSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error('Accounts snapshot is corrupt')
  }
}

export async function writeAccounts(
  kv: KVNamespace,
  snapshot: AccountsSnapshot,
  now = new Date().toISOString(),
): Promise<AccountsSnapshot> {
  const result = accountsSnapshotSchema.safeParse({
    ...snapshot,
    revision: snapshot.revision + 1,
    updatedAt: now,
  })
  if (!result.success) throw new Error('Accounts snapshot validation failed')

  // ponytail: KV is last-writer-wins; move domain writes to a Durable Object or D1 when concurrent administrators or frequent writes become normal.
  await kv.put(ACCOUNTS_KEY, JSON.stringify(result.data))
  return result.data
}

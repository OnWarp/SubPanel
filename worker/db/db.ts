export type AppDatabase = D1Database

export async function queryFirst<Row>(statement: D1PreparedStatement): Promise<Row | null> {
  const row = await statement.first<Row>()
  return row ?? null
}

// D1 commits a batch as one atomic unit. There is no interactive BEGIN/COMMIT.
export async function batch(
  db: AppDatabase,
  statements: readonly D1PreparedStatement[],
): Promise<D1Result[]> {
  if (statements.length === 0) return []
  return db.batch([...statements])
}

export const transaction = batch

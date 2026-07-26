import { z } from 'zod'
import { refreshSource } from '../catalog/import-service.js'
import { readCatalog } from '../catalog/repository.js'
import { sourceIdSchema, type Source } from '../catalog/schema.js'

export const CRON_KEY = 'state:cron'

export const cronStatusSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['idle', 'success', 'failed']),
  ranAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  sourceId: sourceIdSchema.optional(),
  errorCode: z.string().min(1).optional(),
  catalogRevision: z.number().int().nonnegative().optional(),
})

export type CronStatus = z.infer<typeof cronStatusSchema>
export type CronRunOptions = { now?: string; fetcher?: typeof fetch }

function dueAt(source: Source): number {
  const base = Date.parse(source.lastAttemptAt ?? source.createdAt)
  if (!Number.isFinite(base) || !source.refreshIntervalMinutes) return Number.NEGATIVE_INFINITY
  return base + source.refreshIntervalMinutes * 60_000
}

export function selectDueSource(sources: Source[], now: string): Source | undefined {
  const current = Date.parse(now)
  return sources
    .map((source, index) => ({ source, index, due: dueAt(source) }))
    .filter(({ source, due }) => source.type === 'remote' && source.enabled && due <= current)
    .sort((left, right) => left.due - right.due || left.index - right.index || left.source.id.localeCompare(right.source.id))
    .at(0)?.source
}

async function writeCronStatus(kv: KVNamespace, status: CronStatus): Promise<CronStatus> {
  const value = cronStatusSchema.parse(status)
  await kv.put(CRON_KEY, JSON.stringify(value))
  return value
}

export async function readCronStatus(kv: KVNamespace): Promise<CronStatus | null> {
  const raw = await kv.get(CRON_KEY)
  if (raw === null) return null
  try {
    return cronStatusSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error('Cron status is corrupt')
  }
}

export async function runCron(kv: KVNamespace, options: CronRunOptions = {}): Promise<CronStatus> {
  const now = options.now ?? new Date().toISOString()
  try {
    const catalog = await readCatalog(kv)
    const selected = selectDueSource(catalog.sources, now)
    if (!selected) {
      return writeCronStatus(kv, {
        schemaVersion: 1,
        status: 'idle',
        ranAt: now,
        finishedAt: now,
        catalogRevision: catalog.revision,
      })
    }

    const result = await refreshSource(kv, selected.id, { now, fetcher: options.fetcher })
    const latest = await readCatalog(kv)
    return writeCronStatus(kv, {
      schemaVersion: 1,
      status: result.success ? 'success' : 'failed',
      ranAt: now,
      finishedAt: now,
      sourceId: selected.id,
      errorCode: result.success ? undefined : result.source.lastErrorCode ?? 'CRON_FAILED',
      catalogRevision: latest.revision,
    })
  } catch {
    return writeCronStatus(kv, {
      schemaVersion: 1,
      status: 'failed',
      ranAt: now,
      finishedAt: now,
      errorCode: 'CRON_FAILED',
    })
  }
}

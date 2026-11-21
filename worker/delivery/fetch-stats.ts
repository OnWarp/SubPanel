// Pull counters live in memory and are flushed to KV in batches. They are not
// a D1 column and they are not a device identity: the sample has no user agent.

const SESSION_KEY = 'fetch-stats:session'
const FLUSH_EVERY = 10

type FetchSample = {
  at: string
  platform: string
  ok: boolean
  status: number
  durationMs: number
}

type StoredStats = {
  lastFetchAt: string | null
  lastPlatform: string | null
  lastOk: boolean | null
  lastStatus: number | null
  success: number
  failure: number
  byStatus: Record<string, number>
  duration: { min: number; max: number; sum: number; count: number }
  pendingWrites: number
}

export type FetchSummary = {
  lastFetchAt: string | null
  lastPlatform: string | null
  lastOk: boolean | null
  lastStatus: number | null
  success: number
  failure: number
  statuses: Record<string, number>
  durationMs: { min: number; max: number; avg: number } | null
}

const memory = new Map<string, StoredStats>()
const staged = new Map<string, FetchSample[]>()
let session = ''
let sessionPromise: Promise<string> | null = null

const statsKey = (subscriptionId: string) => `fetch-stats:${subscriptionId}`

function emptyStats(): StoredStats {
  return {
    lastFetchAt: null,
    lastPlatform: null,
    lastOk: null,
    lastStatus: null,
    success: 0,
    failure: 0,
    byStatus: {},
    duration: { min: 0, max: 0, sum: 0, count: 0 },
    pendingWrites: 0,
  }
}

function applySample(stats: StoredStats, sample: FetchSample): void {
  stats.lastFetchAt = sample.at
  stats.lastPlatform = sample.platform
  stats.lastOk = sample.ok
  stats.lastStatus = sample.status
  if (sample.ok) stats.success += 1
  else stats.failure += 1
  const code = String(sample.status)
  stats.byStatus[code] = (stats.byStatus[code] ?? 0) + 1
  const duration = Math.max(0, sample.durationMs)
  stats.duration.min = stats.duration.count === 0 ? duration : Math.min(stats.duration.min, duration)
  stats.duration.max = Math.max(stats.duration.max, duration)
  stats.duration.sum += duration
  stats.duration.count += 1
}

export function presentFetchSummary(stats: StoredStats | null): FetchSummary {
  const value = stats ?? emptyStats()
  return {
    lastFetchAt: value.lastFetchAt,
    lastPlatform: value.lastPlatform,
    lastOk: value.lastOk,
    lastStatus: value.lastStatus,
    success: value.success,
    failure: value.failure,
    statuses: { ...value.byStatus },
    durationMs: value.duration.count === 0 ? null : {
      min: value.duration.min,
      max: value.duration.max,
      avg: Math.round(value.duration.sum / value.duration.count),
    },
  }
}

async function ensureSession(kv: KVNamespace): Promise<void> {
  if (session) {
    const current = await kv.get(SESSION_KEY)
    if (current === session) return
  }
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const current = await kv.get(SESSION_KEY)
      if (!current) {
        const next = crypto.randomUUID()
        memory.clear()
        staged.clear()
        await kv.put(SESSION_KEY, next)
        session = next
        return next
      }
      if (current !== session) {
        memory.clear()
        staged.clear()
      }
      session = current
      return current
    })().finally(() => { sessionPromise = null })
  }
  await sessionPromise
}

// The public response records the sample before any KV await, so a following
// admin read sees it even when the batched KV write is still pending.
export function stageSubscriptionFetch(subscriptionId: string, sample: FetchSample): void {
  const current = memory.get(subscriptionId)
  if (current) {
    applySample(current, sample)
    current.pendingWrites += 1
    return
  }
  const queue = staged.get(subscriptionId) ?? []
  queue.push(sample)
  staged.set(subscriptionId, queue)
}

async function materialize(kv: KVNamespace, subscriptionId: string): Promise<StoredStats> {
  const queued = staged.get(subscriptionId) ?? []
  if (queued.length) staged.delete(subscriptionId)
  await ensureSession(kv)
  let stats = memory.get(subscriptionId)
  if (!stats) {
    let stored: StoredStats | null = null
    try {
      stored = await kv.get<StoredStats>(statsKey(subscriptionId), 'json')
    } catch {
      stored = null
    }
    stats = memory.get(subscriptionId) ?? stored ?? emptyStats()
    memory.set(subscriptionId, stats)
  }
  if (queued.length) {
    for (const sample of queued) applySample(stats, sample)
    stats.pendingWrites += queued.length
  }
  return stats
}

export async function noteSubscriptionFetch(kv: KVNamespace, subscriptionId: string, sample: FetchSample): Promise<void> {
  try {
    const stats = await materialize(kv, subscriptionId)
    if (stats.pendingWrites < FLUSH_EVERY && sample.ok) return
    stats.pendingWrites = 0
    await kv.put(statsKey(subscriptionId), JSON.stringify(stats))
  } catch {
    // A stats write must never change the subscription response.
  }
}

export async function readFetchSummary(kv: KVNamespace, subscriptionId: string): Promise<FetchSummary> {
  try {
    return presentFetchSummary(await materialize(kv, subscriptionId))
  } catch {
    return presentFetchSummary(memory.get(subscriptionId) ?? null)
  }
}

export async function deleteFetchStats(kv: KVNamespace, subscriptionId: string): Promise<void> {
  memory.delete(subscriptionId)
  staged.delete(subscriptionId)
  try {
    await kv.delete(statsKey(subscriptionId))
  } catch {
    // Best effort. The subscription row is already gone.
  }
}

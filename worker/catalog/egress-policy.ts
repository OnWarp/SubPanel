import { env as workerEnv } from 'cloudflare:workers'
import { fetchRemoteTextWithMetadata } from './remote.js'

type FetchOptions = Parameters<typeof fetchRemoteTextWithMetadata>

export function fetchRemoteTextWithPolicy(
  request: FetchOptions[0],
  fetcher = fetch,
  timeoutMs?: number,
  cancellation?: AbortSignal,
  limits?: FetchOptions[4],
) {
  const egress = fetcher === fetch && (workerEnv.REQUIRE_WORKER_SECRETS as string | undefined) === 'true'
    ? {
        origins: new Set(workerEnv.REMOTE_FETCH_ORIGINS?.split(',').map(origin => origin.trim()) ?? []),
        gateway: workerEnv.REMOTE_FETCH_GATEWAY,
      }
    : undefined
  return fetchRemoteTextWithMetadata(request, fetcher, timeoutMs, cancellation, limits, egress)
}

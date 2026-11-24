import { useCallback, useEffect, useState } from 'react'
import { api, ApiClientError } from '../../app/api'

export const batchesPath = '/api/admin/redemption-batches'
export const recordsPath = '/api/admin/redemption-records'
export const myRedemptionsPath = '/api/me/redemptions'

export type Receipt = { id: string; name: string; expiresAt: number | null; templateId?: string }
export type RedemptionRecord = {
  id: string
  subscriptionId: string
  subscriptionName: string
  redeemedAt: string
  expiresAt: number | null
  hasSubscription?: number
}
type Page<T> = { items: T[]; total: number; page: number; pageSize: number }

export function errorText(error: unknown) {
  return error instanceof ApiClientError ? error.message : '操作失败，请重试'
}

export function useRedemptionPage<T>(path: string, page: number, version = 0) {
  const [state, setState] = useState<{ path: string; page: number; data?: Page<T>; error?: string }>()
  const [refresh, setRefresh] = useState(0)
  const reload = useCallback(() => setRefresh((value) => value + 1), [])
  useEffect(() => {
    const abort = new AbortController()
    if (!path) return
    void api<Page<T>>(`${path}${path.includes('?') ? '&' : '?'}page=${page}`, { signal: abort.signal })
      .then((data) => { if (!abort.signal.aborted) setState({ path, page, data }) })
      .catch((error) => { if (!abort.signal.aborted) setState({ path, page, error: errorText(error) }) })
    return () => abort.abort()
  }, [path, page, refresh, version])
  const current = state?.path === path && state.page === page ? state : undefined
  return { ...current, reload, loading: !current }
}

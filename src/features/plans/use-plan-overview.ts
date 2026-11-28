import { useCallback, useEffect, useState } from 'react'
import { api, ApiClientError } from '../../app/api'
import type { PlanOverview } from './my-plan-model'

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; overview: PlanOverview }

// `/api/me/overview` is the single source for the profile header and the plan
// counts. A failed request stays an error so the page can offer a retry
// instead of pretending the account has no plans.
export function usePlanOverview() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    const controller = new AbortController()
    void api<PlanOverview>('/api/me/overview', { signal: controller.signal, cache: 'no-store' })
      .then(overview => {
        if (!controller.signal.aborted) setState({ kind: 'ready', overview })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setState({ kind: 'error', message: cause instanceof ApiClientError ? cause.message : '无法加载套餐' })
      })
    return () => controller.abort()
  }, [revision])
  return { state, reload }
}

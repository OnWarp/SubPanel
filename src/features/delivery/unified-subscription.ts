import { useCallback, useEffect, useState } from 'react'
import { api, ApiClientError } from '../../app/api'

export const unifiedSubscriptionPath = '/api/user/subscription'
export const subscriptionStatus = { active: '有效', expired: '已过期', pending: '待生效', disabled: '已停用', none: '未开通' }

export type UnifiedSubscription = {
  status: keyof typeof subscriptionStatus
  expiresAt: string | null
  lastExpiredAt: string | null
  permanent: boolean
  subscriptionUrl: string | null
  supportedFormats: string[]
  importPlatforms: { platform: string; displayName: string }[]
  shareEnabled: boolean
  hasAvailableNodes: boolean
  nodeCount: number
}

export type SubscriptionNode = { name: string; protocol: string }

export function subscriptionError(error: unknown, fallback: string) {
  if (error instanceof ApiClientError) {
    if (error.status === 429) return '请求过于频繁，请稍后重试'
    if (error.code === 'BINDING_CONFLICT') return '授权已更新，请刷新后重试'
  }
  return fallback
}

type State = { kind: 'loading' } | { kind: 'legacy' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: UnifiedSubscription }

export function useUnifiedSubscription() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    const controller = new AbortController()
    void api<UnifiedSubscription>(unifiedSubscriptionPath, { signal: controller.signal, cache: 'no-store' })
      .then(summary => {
        if (!controller.signal.aborted) setState({ kind: 'ready', summary })
      })
      .catch(error => {
        if (controller.signal.aborted) return
        setState(error instanceof ApiClientError && error.code === 'UNIFIED_SUBSCRIPTION_DISABLED'
          ? { kind: 'legacy' }
          : { kind: 'error', message: subscriptionError(error, '加载订阅失败') })
      })
    return () => controller.abort()
  }, [revision])
  return { state, reload }
}

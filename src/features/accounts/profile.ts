import { useCallback, useEffect, useState } from 'react'
import { api, ApiClientError, type AccountProfile } from '../../app/api'

export function useAccountProfile() {
  const [profile, setProfile] = useState<AccountProfile | null>(null)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      const result = await api<AccountProfile>('/api/account/profile')
      setProfile(result)
      setError('')
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '账户资料加载失败')
    }
  }, [])

  useEffect(() => {
    reload().catch(() => undefined)
  }, [reload])

  return { profile, error, reload }
}

export function formatProfileDate(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN')
}

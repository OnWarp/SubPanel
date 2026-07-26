import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api, ApiClientError, jsonBody, type BootstrapResponse, type UserSummary } from './api'

type SessionState = BootstrapResponse & {
  loading: boolean
  bootstrapError: string
  refresh: () => Promise<void>
  retryBootstrap: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const SessionContext = createContext<SessionState | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [initialized, setInitialized] = useState(false)
  const [user, setUser] = useState<UserSummary | null>(null)
  const [bootstrapError, setBootstrapError] = useState('')

  const refresh = useCallback(async () => {
    const bootstrap = await api<BootstrapResponse>('/api/bootstrap')
    setBootstrapError('')
    setInitialized(bootstrap.initialized)
    setUser(bootstrap.user)
  }, [])

  const retryBootstrap = useCallback(async () => {
    setLoading(true)
    try {
      await refresh()
    } catch (cause) {
      setInitialized(false)
      setUser(null)
      setBootstrapError(cause instanceof ApiClientError ? cause.message : '无法连接服务，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [refresh])

  useEffect(() => { retryBootstrap().catch(() => undefined) }, [retryBootstrap])

  const login = useCallback(async (username: string, password: string) => {
    const result = await api<{ user: UserSummary }>('/api/login', {
      method: 'POST',
      body: jsonBody({ username, password }),
    })
    setInitialized(true)
    setUser(result.user)
    setBootstrapError('')
  }, [])

  const logout = useCallback(async () => {
    await api<{ ok: true }>('/api/account/logout', { method: 'POST', body: '{}' })
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ loading, initialized, user, bootstrapError, refresh, retryBootstrap, login, logout }),
    [bootstrapError, initialized, loading, login, logout, refresh, retryBootstrap, user],
  )
  return <SessionContext value={value}>{children}</SessionContext>
}

// eslint-disable-next-line react/only-export-components -- The hook and provider share one private context.
export function useSession(): SessionState {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession must be used inside SessionProvider')
  return value
}

export type Role = 'admin' | 'user'

export type UserSummary = {
  id: string
  username: string
  role: Role
  enabled: boolean
  createdAt?: string
  updatedAt?: string
}

export type CatalogSource = {
  id: string
  name: string
  type: 'manual' | 'file' | 'remote'
  enabled: boolean
  refreshIntervalMinutes?: number
  detectedFormat?: string
  warnings: Array<{ code: string; message: string; line?: number }>
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastErrorCode?: string
  remoteHost?: string
  createdAt: string
  updatedAt: string
}

export type CatalogNode = {
  id: string
  protocol: string
  displayName: string
  server: string
  port: number
  tls?: Record<string, unknown>
  transport?: Record<string, unknown>
  sourceIds: string[]
  enabled: boolean
  retained: boolean
  order: number
  createdAt: string
  updatedAt: string
}

export type CatalogGroup = {
  id: string
  name: string
  sourceIds: string[]
  includedNodeIds: string[]
  excludedNodeIds: string[]
  nodeOrder: string[]
  createdAt: string
  updatedAt: string
}

export type CatalogResponse = {
  schemaVersion: 2
  revision: number
  updatedAt: string
  sources: CatalogSource[]
  nodes: CatalogNode[]
  groups: CatalogGroup[]
}

export type SubscriptionDiagnostic = {
  inputNodes: number
  outputNodes: number
  skippedNodes: number
  diagnostics: Array<{
    nodeId: string
    nodeName?: string
    protocol?: string
    code: 'UNSUPPORTED_PROTOCOL' | 'UNSUPPORTED_FIELD' | 'INVALID_NODE' | string
    outcome?: 'included' | 'skipped'
    fields?: string[]
    message: string
  }>
  available: boolean
}

export type AdminSubscription = {
  id: string
  userId: string
  name: string
  groupIds: string[]
  tokenPrefix: string
  enabled: boolean
  defaultClient: string
  revision: number
  createdAt: string
  updatedAt: string
  links: Record<string, string>
  diagnostics: Record<string, SubscriptionDiagnostic>
}

export type BootstrapResponse = {
  initialized: boolean
  user: UserSummary | null
}

export type InviteStatus = {
  username: string
  expiresAt: string
}

type ApiErrorPayload = {
  error?: {
    code?: string
    message?: string
  }
}

export class ApiClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  let response: Response
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  } catch {
    throw new ApiClientError(0, 'NETWORK_ERROR', '无法连接服务，请稍后重试')
  }
  let payload: ApiErrorPayload | T | null = null
  if (response.status !== 204) {
    try {
      payload = await response.json() as ApiErrorPayload | T
    } catch {
      if (response.ok) throw new ApiClientError(response.status, 'INVALID_RESPONSE', '服务返回了无效数据')
    }
  }

  if (response.ok && response.status !== 204 && payload === null) {
    throw new ApiClientError(response.status, 'INVALID_RESPONSE', '服务返回了无效数据')
  }

  if (!response.ok) {
    const error = payload as ApiErrorPayload | null
    throw new ApiClientError(
      response.status,
      error?.error?.code ?? 'REQUEST_FAILED',
      error?.error?.message ?? '请求失败',
    )
  }
  return payload as T
}

export const jsonBody = (value: unknown): string => JSON.stringify(value)

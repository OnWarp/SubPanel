export type Role = 'admin' | 'user'

export type UserSummary = {
  id: string
  username: string
  role: Role
  enabled: boolean
  email?: string | null
  emailVerifiedAt?: string | null
  deletedAt?: string | null
  subscriptionCount?: number
  createdAt?: string
  updatedAt?: string
}

export type AccountAvatar = {
  kind: 'gravatar' | 'dicebear'
  url: string
  seed: string
}

export type AccountProfile = {
  user: UserSummary & {
    email: string | null
    emailVerifiedAt: string | null
  }
  emailBound: boolean
  avatar: AccountAvatar
  session: {
    issuedAt: string
    expiresAt: string
  } | null
}

export type AdminUsersResponse = {
  users: UserSummary[]
  total: number
  page: number
  pageSize: number
}

export type AdminUserSubscription = {
  id: string
  name: string
  tokenPrefix: string
  enabled: boolean
  defaultClient: string
  revision: number
  startsAt: number | null
  expiresAt: number | null
  groupIds: string[]
  createdAt: string
  updatedAt: string
}

export type AdminUserDetail = {
  user: UserSummary
  subscriptions: AdminUserSubscription[]
  invitationRedemptions: Array<{
    id: number
    invitationId: string
    invitationUsername: string
    redeemedAt: string
  }>
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
  userId: string | null
  name: string
  groupIds: string[]
  tokenPrefix: string
  enabled: boolean
  defaultClient: string
  revision: number
  startsAt: number | null
  expiresAt: number | null
  createdAt: string
  updatedAt: string
  links: Record<string, string>
  linkError?: string | null
  diagnostics: Record<string, SubscriptionDiagnostic>
}

export type BootstrapResponse = {
  initialized: boolean
  user: UserSummary | null
}

export type TemplateReference = {
  isDefault: boolean
  directBindings: number
  inheritedCount: number
}

export type SubscriptionTemplate = {
  id: string
  name: string
  revision: number
  status: 'draft' | 'published' | 'modified' | 'archived'
  publishedVersionId: string | null
  publishedAt: string | null
  publishedSequence: number | null
  updatedAt: string
  createdAt: string
  references: TemplateReference
}

export type TemplateVersion = {
  id: string
  sequence: number
  createdAt: string
  contentHash: string | null
  validatorVersion: string | null
  createdBy: string | null
}

export type TemplateListResponse = {
  templates: SubscriptionTemplate[]
  defaultId: string | null
  defaultRevision: number
  total: number
  page: number
  pageSize: number
}

export type TemplateDetailResponse = Omit<SubscriptionTemplate, 'publishedAt' | 'publishedSequence'> & {
  draft: string
  draftHash: string
  publishedVersion: TemplateVersion | null
  sourceUrl: string | null
  sourceFetchedAt: string | null
  sourceEtag: string | null
  sourceLastModified: string | null
}

export type TemplateValidateResponse = {
  normalized: TemplateStructure
  ignored: string[]
  diagnostics: Diagnostic[]
  contentHash: string
  validatorVersion: string
}

export type TemplatePreviewResponse = {
  ignored: string[]
  diagnostics: Diagnostic[]
  groups: TemplateStructure['proxy-groups']
  rules: string[]
  ruleProviders: NonNullable<TemplateStructure['rule-providers']>
  rendererVersion?: string
  subscriptionName: string | null
  outputNodes: number | null
  effectiveVersionId: string | null
  zeroNodeReason: string | null
}

export type TemplateStructure = {
  'proxy-groups': Array<{
    name: string
    type: 'select'
    proxies: string[]
  }>
  rules: string[]
  'rule-providers'?: Record<string, {
    type: 'http'
    behavior: 'domain' | 'ipcidr' | 'classical'
    url: string
    path?: string
    interval?: number
    format?: 'yaml' | 'text' | 'mrs'
  }>
}

export type TemplateSource = {
  url: string
  fetchedAt: string
  etag: string | null
  lastModified: string | null
}

export type TemplateImportResponse = { notModified: true; message: string } | {
  notModified: false
  candidate: {
    yaml: string
    normalized: TemplateStructure
    ignored: string[]
    diagnostics: Diagnostic[]
    contentHash: string
  }
  source: TemplateSource
}

export type TemplatePublishResponse = {
  versionId: string
  sequence: number
  contentHash: string
  references: TemplateReference
  revision: number
}

export type TemplateBinding = {
  subscriptionId: string
  mode: 'inherit' | 'specific' | 'base'
  templateId: string | null
  revision: number
  updatedAt: string | null
  effectiveTemplate: {
    templateId: string
    templateName: string
    versionId: string
    sequence: number
  } | null
}

export type SubscriptionTemplateBinding =
  | { mode: 'inherit' | 'base'; templateId?: null; expectedRevision: number }
  | { mode: 'specific'; templateId: string; expectedRevision: number }

export type Diagnostic = {
  code: string
  severity: 'error' | 'warning' | 'info'
  path: string
  line?: number
  column?: number
  message: string
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

export const subscriptionTemplatesPath = '/api/admin/system/subscription-templates'

export async function loadSubscriptionTemplates() {
  const templates: SubscriptionTemplate[] = []
  const first = await api<TemplateListResponse>(`${subscriptionTemplatesPath}?pageSize=100`)
  templates.push(...first.templates)
  for (let page = 2; templates.length < first.total; page += 1) {
    const result = await api<TemplateListResponse>(`${subscriptionTemplatesPath}?pageSize=100&page=${page}`)
    if (!result.templates.length) break
    templates.push(...result.templates)
  }
  return { templates, defaultId: first.defaultId, defaultRevision: first.defaultRevision }
}

export const jsonBody = (value: unknown): string => JSON.stringify(value)

// Metadata selectors need every user, not the default first page of twenty.
export async function loadAdminUserOptions(): Promise<{ users: UserSummary[] }> {
  const users: UserSummary[] = []
  for (let page = 1; ; page += 1) {
    const result = await api<{ users: UserSummary[]; total: number }>(`/api/admin/users?pageSize=100&page=${page}`)
    users.push(...result.users)
    if (users.length >= result.total) return { users }
    if (!result.users.length) throw new Error('用户列表不完整，请重试')
  }
}

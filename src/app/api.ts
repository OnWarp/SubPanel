import { cacheable, cachedRequest, cachedValue, cacheKey, inFamily, invalidateCache, requestPath, superseded } from './data-cache'

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
  keepOnFailure: boolean
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
  planId?: string | null
  planName?: string | null
  planState?: 'active' | 'none' | 'expired' | 'revoked' | 'pending' | 'disabled'
  trafficGb?: number
  usedGb?: number
  remainingGb?: number | null
  speedLimitMbps?: number
  deviceLimit?: number
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
  zeroNodeReason: TemplateZeroNodeReason | null
}

export type TemplateZeroNodeReason =
  | 'disabled' | 'unassigned' | 'pending' | 'expired' | 'ownerUnavailable'
  | 'noPlan' | 'noGroupIntersection' | 'noEnabledNodes' | 'incompatible'

export type TemplateDraftWrite = { id: string; revision: number; draftHash: string }
export type TemplateDraftUpdate = Omit<TemplateDraftWrite, 'id'> & { ok: true }
export type TemplateVersionPage = { versions: TemplateVersion[]; total: number; page: number; pageSize: number }
export type TemplateDefaultWrite = { ok: true; revision: number; references: TemplateReference; inheritedCount: number }
export type TemplateRollback = { ok: true; revision: number; versionId: string; references: TemplateReference }

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
    details?: unknown
  }
}

export class ApiClientError extends Error {
  readonly status: number
  readonly code: string

  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
    this.details = details
  }
}

const subscriptionRoutes = [
  '/api/admin/subscriptions', '/api/admin/delivery', '/api/admin/entitlements',
  '/api/account/subscriptions', '/api/account/delivery', '/api/subscriptions', '/api/user/subscriptions',
]
const shareRoutes = ['/api/admin/shares', '/api/shares']
export const subscriptionTemplatesPath = '/api/admin/system/subscription-templates'
const subscriptionFamilies = [
  ...subscriptionRoutes, ...shareRoutes, subscriptionTemplatesPath,
  '/api/account/entitlement', '/api/user/nodes', '/api/admin/users',
]
const writeFamilies: Array<[string[], string[]]> = [
  [['/api/admin/catalog'], ['/api/admin/catalog', ...subscriptionFamilies]],
  [['/api/admin/plans'], ['/api/admin/plans', '/api/account/plans', ...subscriptionFamilies]],
  [[...subscriptionRoutes, ...shareRoutes, subscriptionTemplatesPath], subscriptionFamilies],
  [['/api/admin/share-settings'], ['/api/admin/share-settings', ...subscriptionFamilies]],
  [['/api/admin/apps', '/api/admin/system/app-downloads'], ['/api/admin/apps', '/api/apps', '/api/admin/system/app-downloads']],
  [['/api/admin/tickets', '/api/tickets'], ['/api/admin/tickets', '/api/tickets']],
  [['/api/admin/notices'], ['/api/admin/notices', '/api/notices']],
  [['/api/admin/kb'], ['/api/admin/kb', '/api/kb']],
]
const sessionWrites = new Set([
  '/api/login', '/api/setup', '/api/register', '/api/password/reset',
  '/api/account/password', '/api/account/logout', '/api/account/logout-all',
])
const sessionChannel = typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'
  ? new BroadcastChannel('subpanel-session')
  : undefined

let identity: string | undefined
let sessionEpoch = 0

function changeSession(user?: UserSummary | null) {
  identity = user ? JSON.stringify([user.id, user.role]) : ''
  sessionEpoch++
  invalidateCache()
}

sessionChannel?.addEventListener('message', (event) => {
  if (event.data === 'changed') changeSession()
})

export function onSessionChange(listener: () => void): () => void {
  const receive = (event: MessageEvent) => { if (event.data === 'changed') listener() }
  sessionChannel?.addEventListener('message', receive)
  return () => sessionChannel?.removeEventListener('message', receive)
}

export function peekApi<T>(path: string, init: RequestInit = {}): T | undefined {
  return cacheable(path) ? cachedValue<T>(cacheKey(path, init)) : undefined
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if ((init.method?.toUpperCase() ?? 'GET') !== 'GET' || !cacheable(path)) return fetchApi<T>(path, init)
  const key = cacheKey(path, init)
  const epoch = sessionEpoch
  while (epoch === sessionEpoch && !init.signal?.aborted) {
    try {
      const result = await cachedRequest(key, init.signal, (signal) => fetchApi<T>(path, { ...init, signal }))
      if (epoch === sessionEpoch) return result
    } catch (cause) {
      if (cause === superseded) continue
      if (!init.signal?.aborted) throw cause
      break
    }
  }
  throw new ApiClientError(0, 'NETWORK_ERROR', '无法连接服务，请稍后重试')
}

export async function watchApi<T>(path: string, apply: (data: T) => void, init: RequestInit = {}): Promise<void> {
  const cached = peekApi<T>(path, init)
  if (cached !== undefined && !init.signal?.aborted) apply(cached)
  let fresh: T
  try {
    fresh = await api<T>(path, init)
  } catch (cause) {
    if (cached === undefined || !Object.is(peekApi<T>(path, init), cached) || init.signal?.aborted) throw cause
    return
  }
  if (!init.signal?.aborted && !Object.is(fresh, cached)) apply(fresh)
}

type Reader = typeof api
const missing = Symbol('cache miss')

// Publish a complete cached view, then publish fresh results only if an input changed.
export async function readData<T>(load: (read: Reader) => Promise<T>, apply: (data: T) => void): Promise<void> {
  const snapshot = new Map<string, unknown>()
  const epoch = sessionEpoch
  const cached = await load(async <R>(path: string, init?: RequestInit) => {
    const result = peekApi<R>(path, init)
    if (result === undefined || init?.signal?.aborted) throw missing
    snapshot.set(cacheKey(path, init ?? {}), result)
    return result
  }).then((value) => ({ value }), () => undefined)
  if (epoch !== sessionEpoch) return
  if (cached) apply(cached.value)

  let changed = false
  let value: T
  try {
    value = await load(async <R>(path: string, init?: RequestInit) => {
      const result = await api<R>(path, init)
      if (!Object.is(result, snapshot.get(cacheKey(path, init ?? {})))) changed = true
      return result
    })
  } catch (cause) {
    if (!cached || epoch !== sessionEpoch || [...snapshot.keys()].some((key) => cachedValue(key) === undefined)) throw cause
    return
  }
  if (epoch === sessionEpoch && (!cached || changed)) apply(value)
}

async function fetchApi<T>(path: string, init: RequestInit): Promise<T> {
  const epoch = sessionEpoch
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  let response: Response
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  } catch {
    throw new ApiClientError(0, 'NETWORK_ERROR', '无法连接服务，请稍后重试')
  }
  const url = requestPath(path)
  const method = init.method?.toUpperCase() ?? 'GET'
  const sessionWrite = sessionWrites.has(url)
  if (response.ok && method !== 'GET' && method !== 'HEAD') {
    if (sessionWrite) {
      changeSession()
      sessionChannel?.postMessage('changed')
    } else {
      const rule = writeFamilies.find(([writes]) => writes.some((family) => inFamily(url, family)))
      invalidateCache(rule && [...rule[1], '/api/admin/stats', '/api/admin/audit-logs', '/api/admin/system/status'])
    }
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
    if (epoch === sessionEpoch && response.status === 401 && error?.error?.code === 'AUTH_REQUIRED') changeSession()
    throw new ApiClientError(
      response.status,
      error?.error?.code ?? 'REQUEST_FAILED',
      error?.error?.message ?? '请求失败',
      error?.error?.details,
    )
  }
  if ((url === '/api/bootstrap' && epoch === sessionEpoch) || (sessionWrite && method === 'POST')) {
    const session = payload as { user?: UserSummary | null } | null
    if (session && 'user' in session) {
      const next = session.user ? JSON.stringify([session.user.id, session.user.role]) : ''
      if (identity !== next) changeSession(session.user)
    }
  }
  return payload as T
}

function* templatePages(archived: boolean): Generator<string, Pick<TemplateListResponse, 'templates' | 'defaultId' | 'defaultRevision'>, TemplateListResponse> {
  const path = `${subscriptionTemplatesPath}?pageSize=100${archived ? '&archived=true' : ''}`
  const first: TemplateListResponse = yield path
  const templates = [...first.templates]
  for (let page = 2; templates.length < first.total; page += 1) {
    const result: TemplateListResponse = yield `${path}&page=${page}`
    if (!result.templates.length) break
    templates.push(...result.templates)
  }
  return { templates, defaultId: first.defaultId, defaultRevision: first.defaultRevision }
}

function peekPages<T, R>(pages: Generator<string, T, R>): T | undefined {
  let next = pages.next()
  while (!next.done) {
    const page = peekApi<R>(next.value)
    if (page === undefined) return undefined
    next = pages.next(page)
  }
  return next.value
}

async function readPages<T, R>(pages: Generator<string, T, R>, read: Reader, signal?: AbortSignal): Promise<T> {
  let next = pages.next()
  while (!next.done) next = pages.next(await read<R>(next.value, { signal }))
  return next.value
}

export function peekSubscriptionTemplates(archived = false) {
  return peekPages(templatePages(archived))
}

export function loadSubscriptionTemplates(archived = false, read: Reader = api) {
  return readPages(templatePages(archived), read)
}

export async function loadTemplateSubscriptions(signal?: AbortSignal) {
  const subscriptions: Pick<AdminSubscription, 'id' | 'name'>[] = []
  for (let page = 1; ; page += 1) {
    const result = await api<{ subscriptions: typeof subscriptions; total: number }>(`/api/admin/subscriptions?pageSize=100&page=${page}`, { signal })
    subscriptions.push(...result.subscriptions.map(({ id, name }) => ({ id, name })))
    if (subscriptions.length >= result.total || result.subscriptions.length === 0) return subscriptions
  }
}

export const jsonBody = (value: unknown): string => JSON.stringify(value)

type UserOptions = { users: UserSummary[] }

// Metadata selectors need every user, including pages beyond the first.
function* adminUserPages(): Generator<string, UserOptions, UserOptions & { total: number }> {
  const users: UserSummary[] = []
  for (let page = 1; ; page += 1) {
    const result = yield `/api/admin/users?pageSize=100&page=${page}`
    users.push(...result.users)
    if (users.length >= result.total) return { users }
    if (!result.users.length) throw new Error('用户列表不完整，请重试')
  }
}

export function peekAdminUserOptions() {
  try {
    return peekPages(adminUserPages())
  } catch {
    // Pages cached at different times can have inconsistent totals.
    return undefined
  }
}

export function loadAdminUserOptions(read: Reader = api): Promise<UserOptions> {
  return readPages(adminUserPages(), read)
}

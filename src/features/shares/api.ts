import { api, ApiClientError, jsonBody } from '../../app/api'

/**
 * Shapes match worker/shares/schema.ts ShareView, ShareMeta, and the create/update inputs.
 * Share records keep the token encrypted; list and update responses never include it.
 */

export type ShareStatus = 'active' | 'disabled' | 'revoked'
export type ShareAccess = 'none' | 'password'

export type ShareView = {
  id: string
  ownerUserId: string
  subscriptionId: string
  tokenPrefix: string
  remark: string
  status: ShareStatus
  accessControl: ShareAccess
  expiresAt: string
  allowOriginalLink: boolean
  showSubscriptionName: boolean
  showGroups: boolean
  showExpiry: boolean
  showNodeNames: boolean
  requireLogin: boolean
  maxAccessCount: number | null
  accessCount: number
  lastAccessedAt: string | null
  lastOriginalRevealAt: string | null
  createdAt: string
  updatedAt: string
}

export type ShareMeta = {
  nodeCount: number
  subscriptionName?: string
  groupNames?: string[]
  expiresAt?: string
  nodeNames?: string[]
}

export type CreateShareInput = {
  subscriptionId: string
  remark?: string
  expiresAt?: string
  allowOriginalLink?: boolean
  showSubscriptionName?: boolean
  showGroups?: boolean
  showExpiry?: boolean
  showNodeNames?: boolean
  requireLogin?: boolean
  maxAccessCount?: number | null
  accessControl?: 'none' | 'password'
  password?: string
}

export type UpdateShareInput = {
  remark?: string
  expiresAt?: string
  allowOriginalLink?: boolean
  showSubscriptionName?: boolean
  showGroups?: boolean
  showExpiry?: boolean
  showNodeNames?: boolean
}

export type ShareIssued = {
  linkBaseUrl?: string | null
  share: ShareView
  token: string
}

export type ShareMetaResponse = {
  meta: ShareMeta
  linkBaseUrl?: string | null
}

export type ShareVerifyResponse = {
  verified: true
  expiresAt: string
}

export type ShareLinkExport = {
  link: string
}

/** Canonical export client ids. Aliases such as clash and sing-box map onto these on the server. */
export const SHARE_CLIENTS = [
  { client: 'shadowrocket', label: 'Shadowrocket' },
  { client: 'mihomo', label: 'Mihomo / Clash' },
  { client: 'singbox', label: 'Sing-box' },
  { client: 'surge', label: 'Surge' },
  { client: 'loon', label: 'Loon' },
  { client: 'quantumultx', label: 'Quantumult X' },
  { client: 'v2rayn', label: 'v2rayN' },
  { client: 'nekobox', label: 'NekoBox' },
] as const

export type ShareClientId = typeof SHARE_CLIENTS[number]['client']

const shareIdPath = (id: string, suffix = '') => `/api/shares/${encodeURIComponent(id)}${suffix}`
const shareTokenPath = (token: string, suffix: string) => `/api/shares/${encodeURIComponent(token)}${suffix}`

async function errorFromResponse(response: Response): Promise<ApiClientError> {
  let code = 'REQUEST_FAILED'
  let message = '请求失败'
  try {
    const payload = await response.json() as { error?: { code?: string, message?: string } }
    code = payload.error?.code ?? code
    message = payload.error?.message ?? message
  } catch {
    // The failure page only needs the status. The body is not shown when it is not JSON.
  }
  return new ApiClientError(response.status, code, message)
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(header)
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1])
    } catch {
      return fallback
    }
  }
  const plain = /filename="([^"]+)"/iu.exec(header)
  return plain?.[1] || fallback
}

export function listShares(): Promise<{ shares: ShareView[] }> {
  return api('/api/shares')
}

export function createShare(input: CreateShareInput): Promise<ShareIssued> {
  return api('/api/shares', { method: 'POST', body: jsonBody(input) })
}

export function updateShare(id: string, input: UpdateShareInput): Promise<{ share: ShareView }> {
  return api(shareIdPath(id), { method: 'PUT', body: jsonBody(input) })
}

export function disableShare(id: string): Promise<{ share: ShareView }> {
  return api(shareIdPath(id, '/disable'), { method: 'POST', body: jsonBody({}) })
}

export function enableShare(id: string): Promise<{ share: ShareView }> {
  return api(shareIdPath(id, '/enable'), { method: 'POST', body: jsonBody({}) })
}

export function revokeShare(id: string): Promise<{ share: ShareView }> {
  return api(shareIdPath(id, '/revoke'), { method: 'POST', body: jsonBody({}) })
}

export function resetShareToken(id: string): Promise<ShareIssued> {
  return api(shareIdPath(id, '/reset-token'), { method: 'POST', body: jsonBody({}) })
}

export function deleteShare(id: string): Promise<void> {
  return api(shareIdPath(id), { method: 'DELETE' })
}

export function getShareMeta(token: string): Promise<ShareMetaResponse> {
  return api(shareTokenPath(token, '/meta'))
}

export function verifyShare(token: string, password: string): Promise<ShareVerifyResponse> {
  return api(shareTokenPath(token, '/verify'), { method: 'POST', body: jsonBody({ password }) })
}

export function exportShareLink(token: string): Promise<ShareLinkExport> {
  return api(shareTokenPath(token, '/export?type=link'))
}

export async function downloadShareExport(token: string, client: ShareClientId): Promise<void> {
  let response: Response
  try {
    response = await fetch(shareTokenPath(token, `/export?client=${encodeURIComponent(client)}`), {
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiClientError(0, 'NETWORK_ERROR', '无法连接服务，请稍后重试')
  }
  if (!response.ok) throw await errorFromResponse(response)
  const blob = await response.blob()
  const fileName = filenameFromDisposition(response.headers.get('content-disposition'), `${client}.txt`)
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  // Revoking in the same turn cancels the download before the browser reads the blob.
  window.setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(objectUrl)
  }, 1500)
}

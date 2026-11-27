import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { DOMAIN_VERIFY_PATH } from './verification-contract.js'
import { DomainService } from './domain-service.js'

// Path-based request classes for the domain gate (plan §7.5):
// subscription-class paths serve subscription content to arbitrary
// clients; everything else is panel-class. Keep in sync with the public
// share API paths in worker/shares/routes.ts.
export function isSubscriptionClassPath(pathname: string): boolean {
  if (pathname === '/sub' || pathname.startsWith('/sub/') || pathname === '/s' || pathname.startsWith('/s/')) return true
  return /^\/api\/shares\/(?:[^/?#]+)\/(?:meta|verify|export)$/.test(pathname)
}

// Paths that must stay reachable from any host: health checks, and the
// instance identity endpoint that domain verification itself depends on.
const GATE_EXEMPT_PATHS = new Set(['/api/health', '/api/system/instance', DOMAIN_VERIFY_PATH])

export const hostGate = createMiddleware<AppEnv>(async (c, next) => {
  const { pathname, hostname } = new URL(c.req.url)
  if (pathname === DOMAIN_VERIFY_PATH || pathname.startsWith(`${DOMAIN_VERIFY_PATH}/`)) {
    if (pathname !== DOMAIN_VERIFY_PATH || c.req.raw.method !== 'GET') {
      throw apiError(404, 'NOT_FOUND', '请求的资源不存在')
    }
  }
  if (GATE_EXEMPT_PATHS.has(pathname)) return next()
  const purpose = isSubscriptionClassPath(pathname) ? 'subscription' : 'panel'
  const { allowed } = await new DomainService(c.env.DB).resolveAccess(hostname, purpose)
  if (!allowed) throw apiError(404, 'DOMAIN_NOT_ALLOWED', '该域名未被允许访问此服务')
  return next()
})

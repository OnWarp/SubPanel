import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { getGateState } from './service.js'

// Path-based request classes for the domain gate (plan §7.5):
// subscription-class paths serve subscription content to arbitrary
// clients; everything else is panel-class. Keep in sync with the public
// share API paths in worker/shares/routes.ts.
export function isSubscriptionClassPath(pathname: string): boolean {
  if (pathname === '/sub' || pathname.startsWith('/sub/')) return true
  return /^\/api\/shares\/(?:[^/?#]+)\/(?:meta|verify|export)$/.test(pathname)
}

// Paths that must stay reachable from any host: health checks, and the
// instance identity endpoint that domain verification itself depends on.
const GATE_EXEMPT_PATHS = new Set(['/api/health', '/api/system/instance'])

/**
 * Domain restriction gate. The Host is taken from the request URL only —
 * X-Forwarded-Host is never trusted, because through some tunnels or
 * proxies it can be attacker-controlled.
 *
 * Fail-safe: the gate only runs when the admin turned restriction on, and
 * when a class has no enabled domain at all the gate does not engage for
 * that class, so a misconfiguration can never lock everyone out.
 */
export const hostGate = createMiddleware<AppEnv>(async (c, next) => {
  const { pathname } = new URL(c.req.url)
  if (GATE_EXEMPT_PATHS.has(pathname)) return next()
  const state = await getGateState(c.env.DB)
  if (!state.restrictionEnabled) return next()
  const subscriptionClass = isSubscriptionClassPath(pathname)
  const allowedHosts = subscriptionClass ? state.subscriptionHosts : state.panelHosts
  if (allowedHosts.size === 0) return next()
  const host = new URL(c.req.url).hostname.toLowerCase()
  if (!allowedHosts.has(host)) {
    throw apiError(404, 'DOMAIN_NOT_ALLOWED', '该域名未被允许访问此服务')
  }
  return next()
})

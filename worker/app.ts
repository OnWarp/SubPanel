import { adminRedemptionRoutes, userRedemptionRoutes } from './redemption/routes.js'
import { compileJobRoutes } from './delivery/compile-jobs.js'
import { templateRoutes } from './templates/routes.js'
import { adminManagementRoutes } from './admin/routes.js'
import { auditAdminMutation } from './admin/audit.js'
import { adminPlanRoutes, userPlanRoutes } from './delivery/plan-routes.js'
import { Hono } from 'hono'
import type { AppEnv } from './app-env.js'
import { accountRoutes } from './accounts/account-routes.js'
import { adminAccountRoutes } from './accounts/admin-routes.js'
import { requireAdmin, requireAuth } from './accounts/auth.js'
import { publicAccountRoutes } from './accounts/public-routes.js'
import { adminRegistrationRoutes, registrationRoutes } from './accounts/registration-routes.js'
import { catalogRoutes } from './catalog/routes.js'
import { ApiError } from './platform/api-error.js'
import { noStore, originGuard, securityHeaders } from './platform/http.js'
import { entitlementTemplateRoutes } from './delivery/entitlement-template-routes.js'
import { adminDeliveryRoutes, userDeliveryRoutes } from './delivery/routes.js'
import { userNodeRoutes } from './delivery/user-nodes.js'
import { adminAppRoutes, userAppRoutes } from './apps/routes.js'
import { adminShareRoutes, shareRoutes } from './shares/routes.js'
import { readCronStatus } from './operations/cron.js'
import { migrationRoutes } from './migration/routes.js'
import { adminSystemRoutes } from './system/routes.js'
import { hostGate } from './domains/host-gate.js'
import { adminDomainRoutes, publicSystemRoutes, userDomainRoutes } from './domains/routes.js'
import { publicSubscriptionRoutes } from './public-subscriptions.js'
import { backfillRoutes } from './delivery/backfill-routes.js'
import { unifiedAdminRoutes, unifiedPublicRoutes, unifiedUserRoutes } from './delivery/unified-routes.js'
import { adminNoticeRoutes, adminTicketRoutes, noticeRoutes, userTicketRoutes } from './tickets/routes.js'
import { adminKbRoutes, userKbRoutes } from './kb/routes.js'

export const app = new Hono<AppEnv>()

app.use('*', securityHeaders)
app.use('/api/*', noStore)
app.use('/api/*', originGuard)
app.use('/sub/*', noStore)
app.use('*', hostGate)

app.get('/api/health', c => c.json({ ok: true }))

app.route('/api', publicAccountRoutes)
app.route('/api', registrationRoutes)

app.use('/api/account', requireAuth)
app.use('/api/account/*', requireAuth)
app.route('/api/account', accountRoutes)
app.use('/api/me/subscriptions/*', requireAuth)
app.use('/api/me/redemptions/*', requireAuth)
app.route('/api/me/redemptions', userRedemptionRoutes)
app.use('/api/subscriptions', requireAuth)
app.use('/api/subscriptions/*', requireAuth)
app.use('/api/user/subscriptions', requireAuth)
app.use('/api/user/subscriptions/*', requireAuth)
app.use('/api/user/nodes', requireAuth)
app.use('/api/user/nodes/*', requireAuth)
app.use('/api/apps', requireAuth)
app.use('/api/apps/*', requireAuth)
app.use('/api/tickets', requireAuth)
app.use('/api/tickets/*', requireAuth)
app.use('/api/notices', requireAuth)
app.use('/api/notices/*', requireAuth)
app.use('/api/kb', requireAuth)
app.use('/api/kb/*', requireAuth)

app.use('/api/admin/*', requireAuth)
app.use('/api/admin/*', requireAdmin)
app.use('/api/admin/*', auditAdminMutation)
app.get('/api/admin/operations/status', async c => {
  return c.json({ ok: true, cron: await readCronStatus(c.env.DATA) })
})
app.route('/api/admin', adminManagementRoutes)
app.route('/api/admin', adminRedemptionRoutes)
app.route('/api/admin', adminAccountRoutes)
app.route('/api/admin', adminPlanRoutes)
app.route('/api/account', userPlanRoutes)
app.route('/api/admin', adminRegistrationRoutes)
app.route('/api/admin', migrationRoutes)
app.route('/api/admin', adminSystemRoutes)
app.route('/api/admin/system/subscription-templates', templateRoutes)
app.route('/api/admin', adminDomainRoutes)
app.route('/api/admin', adminTicketRoutes)
app.route('/api/admin', adminNoticeRoutes)
app.route('/api/admin', adminKbRoutes)
app.route('/api/account', userDomainRoutes)
app.route('/api', publicSystemRoutes)
app.route('/api/admin/catalog', catalogRoutes)
app.route('/api/admin/subscription-templates', entitlementTemplateRoutes)
app.route('/api/admin/compile-jobs', compileJobRoutes)
app.route('/api/admin/subscriptions', adminDeliveryRoutes)
app.route('/api/admin/delivery/subscriptions', adminDeliveryRoutes)
app.route('/api/admin/delivery', adminDeliveryRoutes)
app.route('/api/account/subscriptions', userDeliveryRoutes)
app.route('/api/account/delivery/subscriptions', userDeliveryRoutes)
app.route('/api/account/delivery', userDeliveryRoutes)
app.route('/api/me/subscriptions', userDeliveryRoutes)
app.route('/api/subscriptions', userDeliveryRoutes)
app.route('/api/user/subscriptions', userDeliveryRoutes)
app.route('/api/user/nodes', userNodeRoutes)
app.route('/api/shares', shareRoutes)
app.route('/api/admin', adminShareRoutes)
app.route('/api/apps', userAppRoutes)
app.route('/api/admin/apps', adminAppRoutes)
app.route('/api/tickets', userTicketRoutes)
app.route('/api/notices', noticeRoutes)
app.route('/api/kb', userKbRoutes)
app.route('/', publicSubscriptionRoutes)
app.route('/api/user/subscription', unifiedUserRoutes)
app.route('/api/admin', unifiedAdminRoutes)
app.route('/api/admin', backfillRoutes)
app.route('/', unifiedPublicRoutes)

// SPA fallback: browser navigations (GET/HEAD, non-API path, Accept
// includes text/html) to client-side routes receive the app shell with a
// 200; everything else keeps the JSON 404 so API and subscription
// clients are unaffected.
app.notFound(async (c) => {
  const { pathname } = new URL(c.req.url)
  const accept = c.req.header('Accept') ?? ''
  const isApiPath = pathname === '/api' || pathname.startsWith('/api/')
  if (
    (c.req.method === 'GET' || c.req.method === 'HEAD') &&
    !isApiPath &&
    accept.includes('text/html')
  ) {
    const shell = await c.env.ASSETS.fetch(new URL('/index.html', c.req.url))
    if (shell.ok) return shell
  }
  return c.json({ error: { code: 'NOT_FOUND', message: '请求的资源不存在' } }, 404)
})

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      error.status,
    )
  }
  if (c.req.path.startsWith('/sub/')) {
    console.error(JSON.stringify({ event: 'subscription_request_error' }))
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }, 500)
  }
  console.error(JSON.stringify({ event: 'request_error' }))
  return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }, 500)
})

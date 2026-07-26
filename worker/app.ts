import { Hono } from 'hono'
import type { AppEnv } from './app-env.js'
import { accountRoutes } from './accounts/account-routes.js'
import { adminAccountRoutes } from './accounts/admin-routes.js'
import { requireAdmin, requireAuth } from './accounts/auth.js'
import { publicAccountRoutes } from './accounts/public-routes.js'
import { catalogRoutes } from './catalog/routes.js'
import { readAccounts } from './accounts/repository.js'
import { ApiError } from './platform/api-error.js'
import { noStore, originGuard, securityHeaders } from './platform/http.js'
import { adminDeliveryRoutes, userDeliveryRoutes } from './delivery/routes.js'
import { readCronStatus } from './operations/cron.js'
import { publicSubscriptionRoutes } from './public-subscriptions.js'

export const app = new Hono<AppEnv>()

app.use('*', securityHeaders)
app.use('/api/*', noStore)
app.use('/api/*', originGuard)
app.use('/sub/*', noStore)

app.get('/api/health', async (c) => {
  try {
    const [accounts, cron] = await Promise.all([
      readAccounts(c.env.DATA),
      readCronStatus(c.env.DATA),
    ])
    return c.json({ ok: true, version: '0.1.0' as const, initialized: accounts.users.length > 0, cron })
  } catch {
    return c.json({ ok: false, version: '0.1.0' as const, error: { code: 'HEALTH_STATE_INVALID', message: '健康状态不可用' } }, 503)
  }
})

app.route('/api', publicAccountRoutes)

app.use('/api/account', requireAuth)
app.use('/api/account/*', requireAuth)
app.route('/api/account', accountRoutes)
app.use('/api/subscriptions', requireAuth)
app.use('/api/subscriptions/*', requireAuth)
app.use('/api/user/subscriptions', requireAuth)
app.use('/api/user/subscriptions/*', requireAuth)

app.use('/api/admin/*', requireAuth)
app.use('/api/admin/*', requireAdmin)
app.route('/api/admin', adminAccountRoutes)
app.route('/api/admin/catalog', catalogRoutes)
app.route('/api/admin/subscriptions', adminDeliveryRoutes)
app.route('/api/admin/delivery', adminDeliveryRoutes)
app.route('/api/admin/delivery/subscriptions', adminDeliveryRoutes)
app.route('/api/account/subscriptions', userDeliveryRoutes)
app.route('/api/account/delivery', userDeliveryRoutes)
app.route('/api/account/delivery/subscriptions', userDeliveryRoutes)
app.route('/api/subscriptions', userDeliveryRoutes)
app.route('/api/user/subscriptions', userDeliveryRoutes)
app.route('/', publicSubscriptionRoutes)

app.notFound((c) =>
  c.json({ error: { code: 'NOT_FOUND', message: '请求的资源不存在' } }, 404),
)

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      error.status,
    )
  }
  console.error(JSON.stringify({ event: 'request_error', name: error.name, message: error.message }))
  return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }, 500)
})

import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { executeBackfill, inventory, migrationId, previewBackfill, reconcileBackfill, requireBackfillReady } from './backfill.js'

export const backfillRoutes = new Hono<AppEnv>()
const path = '/unified-subscription-migration'

backfillRoutes.use(path, ready)
backfillRoutes.use(`${path}/*`, ready)

async function ready(c: Context<AppEnv>, next: () => Promise<void>) {
  c.header('Cache-Control', 'private, no-store')
  await requireBackfillReady(c.env.DB)
  await next()
}

function userId(raw: string) {
  const parsed = migrationId.safeParse(raw)
  if (!parsed.success) throw apiError(400, 'MIGRATION_INVALID_USER', '用户编号无效')
  return parsed.data
}

backfillRoutes.get(path, async c => c.json(await inventory(c.env.DB, c.req.query('after') ?? '')))
backfillRoutes.get(`${path}/:id/preview`, async c =>
  c.json(await previewBackfill(c.env, userId(c.req.param('id')), c.get('principal').id)))
backfillRoutes.post(`${path}/:id/execute`, async c => {
  const input = await readJson(c, z.strictObject({ confirm: z.literal(true), digest: z.string().length(43) }))
  return c.json(await executeBackfill(c.env, userId(c.req.param('id')), c.get('principal').id, input.digest))
})
backfillRoutes.get(`${path}/:id/reconcile`, async c => c.json(await reconcileBackfill(c.env, userId(c.req.param('id')))))

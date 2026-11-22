import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { CATALOG_D1_READY_KEY, isModuleReady } from '../db/module-switch.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import {
  createEntitlementTemplate, getEntitlementTemplate, listEntitlementTemplates, listEntitlementVersions,
  templateInputSchema, templatePatchSchema, templateStatusSchema, updateEntitlementTemplate,
} from './entitlement-templates.js'

export const entitlementTemplateRoutes = new Hono<AppEnv>()

entitlementTemplateRoutes.get('/', async (c) => {
  const status = templateStatusSchema.optional().safeParse(c.req.query('status'))
  if (!status.success) throw apiError(422, 'VALIDATION_FAILED', '模板状态无效')
  return c.json({ templates: await listEntitlementTemplates(c.env.DB, status.data) })
})

entitlementTemplateRoutes.post('/', async (c) => {
  const input = await readJson(c, templateInputSchema)
  if (!await isModuleReady(c.env.DB, CATALOG_D1_READY_KEY)) throw apiError(409, 'CATALOG_STORAGE_NOT_READY', '请先完成目录 D1 迁移')
  return c.json({ template: await createEntitlementTemplate(c.env.DB, input, c.get('principal').id) }, 201)
})

entitlementTemplateRoutes.get('/:id', async (c) =>
  c.json({ template: await getEntitlementTemplate(c.env.DB, c.req.param('id')) }))

entitlementTemplateRoutes.patch('/:id', async (c) => {
  const input = await readJson(c, templatePatchSchema)
  return c.json({ template: await updateEntitlementTemplate(c.env.DB, c.req.param('id'), input, c.get('principal').id) })
})

entitlementTemplateRoutes.post('/:id/copy', async (c) => {
  const current = await getEntitlementTemplate(c.env.DB, c.req.param('id'))
  return c.json({ template: await createEntitlementTemplate(c.env.DB, {
    name: `${current.name.slice(0, 125)} 副本`,
    description: current.description,
    allowRedemption: current.allowRedemption,
    config: current.currentVersion.config,
  }, c.get('principal').id, 'disabled') }, 201)
})

entitlementTemplateRoutes.delete('/:id', async (c) => {
  const input = await readJson(c, z.object({ expectedRevision: z.number().int().positive() }).strict())
  return c.json({ template: await updateEntitlementTemplate(c.env.DB, c.req.param('id'), {
    ...input, status: 'archived',
  }, c.get('principal').id) })
})

entitlementTemplateRoutes.get('/:id/versions', async (c) =>
  c.json({ versions: await listEntitlementVersions(c.env.DB, c.req.param('id')) }))

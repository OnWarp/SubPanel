import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import {
  getRegistrationMode,
  getShowAppDownloads,
  putRegistrationMode,
  putShowAppDownloads,
  registrationModeSchema,
} from '../db/settings-repository.js'
import { readJson } from '../platform/http.js'
import {
  mailSettingsPatchSchema,
  readMailSettings,
  toPublicMailSettings,
  updateMailSettings,
} from './mail-settings.js'
import { readSystemStatus } from './status.js'

export const adminSystemRoutes = new Hono<AppEnv>()

const registrationBodySchema = z.object({ mode: registrationModeSchema }).strict()

adminSystemRoutes.get('/system/registration', async (c) => {
  const mode = await getRegistrationMode(c.env.DB)
  return c.json({ mode })
})

adminSystemRoutes.put('/system/registration', async (c) => {
  const input = await readJson(c, registrationBodySchema)
  await putRegistrationMode(c.env.DB, input.mode)
  return c.json({ mode: input.mode })
})

const appDownloadsBodySchema = z.object({ enabled: z.boolean() }).strict()

adminSystemRoutes.get('/system/app-downloads', async (c) => {
  const enabled = await getShowAppDownloads(c.env.DB)
  return c.json({ enabled })
})

adminSystemRoutes.put('/system/app-downloads', async (c) => {
  const input = await readJson(c, appDownloadsBodySchema)
  await putShowAppDownloads(c.env.DB, input.enabled)
  return c.json({ enabled: input.enabled })
})

adminSystemRoutes.get('/system/mail', async (c) => {
  const settings = await readMailSettings(c.env.DB)
  return c.json({ settings: toPublicMailSettings(settings) })
})

adminSystemRoutes.put('/system/mail', async (c) => {
  const patch = await readJson(c, mailSettingsPatchSchema)
  const settings = await updateMailSettings(c.env.DB, patch)
  return c.json({ settings: toPublicMailSettings(settings) })
})

adminSystemRoutes.get('/system/status', async (c) => {
  const status = await readSystemStatus(c.env.DB)
  return c.json({ status })
})

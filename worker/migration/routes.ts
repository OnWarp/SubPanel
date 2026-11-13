import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { MigrationError, runModuleImport } from './run.js'

const bodySchema = z.object({
  module: z.enum(['catalog', 'apps']),
})

export const migrationRoutes = new Hono<AppEnv>()

migrationRoutes.post('/migration/run', async (c) => {
  const body = await readJson(c, bodySchema)
  try {
    const report = await runModuleImport(c.env, body.module)
    return c.json(report)
  } catch (error) {
    if (error instanceof MigrationError) {
      throw apiError(409, error.code, error.message, error.report)
    }
    throw error
  }
})

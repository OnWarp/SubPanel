import { app } from './app.js'
import { runCron } from './operations/cron.js'

const worker = {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runCron(env.DATA, { now: new Date(controller.scheduledTime).toISOString() }).catch(() => undefined))
  },
}

export default worker

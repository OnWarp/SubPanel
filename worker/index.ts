import { app } from './app.js'
import { runCron } from './operations/cron.js'

const worker = {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runCron(env, { now: new Date(controller.scheduledTime).toISOString() }).then(result => {
      if (result.status === 'failed') console.warn(JSON.stringify({ event: 'cron_failed', code: result.errorCode }))
    }).catch(() => console.error(JSON.stringify({ event: 'cron_status_write_failed' }))))
  },
}

export default worker

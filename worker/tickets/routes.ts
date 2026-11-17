import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { createNoticeSchema, createTicketSchema, replyTicketSchema, updateNoticeSchema } from './schema.js'
import {
  TicketError,
  closeTicketAsAdmin,
  closeTicketAsUser,
  createNotice,
  createUserTicket,
  deleteNotice,
  listAllNotices,
  listTicketQueue,
  listUserTickets,
  listVisibleNotices,
  readAdminTicket,
  readUserTicket,
  reopenTicketAsAdmin,
  replyAsAdmin,
  replyAsUser,
  updateNotice,
} from './service.js'

const emptySchema = z.object({}).default({})
const recordIdPattern = /^[1-9]\d*$/u

function requireId(value: string | undefined, code: string, message: string): number {
  if (!value || !recordIdPattern.test(value)) throw apiError(404, code, message)
  const id = Number(value)
  if (!Number.isSafeInteger(id)) throw apiError(404, code, message)
  return id
}

function requireTicketId(value: string | undefined): number {
  return requireId(value, 'TICKET_NOT_FOUND', '工单不存在')
}

function requireNoticeId(value: string | undefined): number {
  return requireId(value, 'NOTICE_NOT_FOUND', '公告不存在')
}

function raise(error: unknown): never {
  if (error instanceof TicketError) throw apiError(error.status, error.code, error.message)
  throw error
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    raise(error)
  }
}

function parsePagination(query: Record<string, string | undefined>): { page: number, pageSize: number } {
  const page = Number.parseInt(query.page ?? '', 10)
  const pageSize = Number.parseInt(query.pageSize ?? '', 10)
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
  }
}

function parseStatus(query: Record<string, string | undefined>): 'open' | 'closed' | null {
  const status = query.status
  if (status === undefined || status === '') return null
  if (status !== 'open' && status !== 'closed') {
    throw apiError(422, 'VALIDATION_FAILED', '输入校验失败')
  }
  return status
}

export const userTicketRoutes = new Hono<AppEnv>()

userTicketRoutes.get('/', async (c) => {
  const tickets = await run(() => listUserTickets(c.env, c.get('principal').id))
  return c.json({ tickets })
})

userTicketRoutes.post('/', async (c) => {
  const input = await readJson(c, createTicketSchema)
  const ticket = await run(() => createUserTicket(c.env, c.get('principal').id, input))
  return c.json({ ticket }, 201)
})

userTicketRoutes.get('/:id', async (c) => {
  const id = requireTicketId(c.req.param('id'))
  const thread = await run(() => readUserTicket(c.env, c.get('principal').id, id))
  return c.json(thread)
})

userTicketRoutes.post('/:id/replies', async (c) => {
  const id = requireTicketId(c.req.param('id'))
  const input = await readJson(c, replyTicketSchema)
  const result = await run(() => replyAsUser(c.env, c.get('principal').id, id, input.body))
  return c.json(result)
})

userTicketRoutes.post('/:id/close', async (c) => {
  const id = requireTicketId(c.req.param('id'))
  await readJson(c, emptySchema)
  const ticket = await run(() => closeTicketAsUser(c.env, c.get('principal').id, id))
  return c.json({ ticket })
})

export const adminTicketRoutes = new Hono<AppEnv>()

adminTicketRoutes.get('/tickets', async (c) => {
  const query = c.req.query()
  const status = parseStatus(query)
  const { page, pageSize } = parsePagination(query)
  const result = await run(() => listTicketQueue(c.env, { status }, page, pageSize))
  return c.json({ tickets: result.tickets, total: result.total, page, pageSize })
})

adminTicketRoutes.get('/tickets/:id', async (c) => {
  const id = requireTicketId(c.req.param('id'))
  const thread = await run(() => readAdminTicket(c.env, id))
  return c.json(thread)
})

adminTicketRoutes.post('/tickets/:id/replies', async (c) => {
  const id = requireTicketId(c.req.param('id'))
  const input = await readJson(c, replyTicketSchema)
  const result = await run(() => replyAsAdmin(c.env, c.get('principal').id, id, input.body))
  return c.json(result)
})

adminTicketRoutes.post('/tickets/:id/close', async (c) => {
  const id = requireTicketId(c.req.param('id'))
  await readJson(c, emptySchema)
  const ticket = await run(() => closeTicketAsAdmin(c.env, id))
  return c.json({ ticket })
})

adminTicketRoutes.post('/tickets/:id/reopen', async (c) => {
  const id = requireTicketId(c.req.param('id'))
  await readJson(c, emptySchema)
  const ticket = await run(() => reopenTicketAsAdmin(c.env, id))
  return c.json({ ticket })
})

export const noticeRoutes = new Hono<AppEnv>()

noticeRoutes.get('/', async (c) => {
  const notices = await run(() => listVisibleNotices(c.env))
  return c.json({ notices })
})

export const adminNoticeRoutes = new Hono<AppEnv>()

adminNoticeRoutes.get('/notices', async (c) => {
  const notices = await run(() => listAllNotices(c.env))
  return c.json({ notices })
})

adminNoticeRoutes.post('/notices', async (c) => {
  const input = await readJson(c, createNoticeSchema)
  const notice = await run(() => createNotice(c.env, input))
  return c.json({ notice }, 201)
})

adminNoticeRoutes.put('/notices/:id', async (c) => {
  const id = requireNoticeId(c.req.param('id'))
  const input = await readJson(c, updateNoticeSchema)
  const notice = await run(() => updateNotice(c.env, id, input))
  return c.json({ notice })
})

adminNoticeRoutes.delete('/notices/:id', async (c) => {
  const id = requireNoticeId(c.req.param('id'))
  await run(() => deleteNotice(c.env, id))
  return c.body(null, 204)
})

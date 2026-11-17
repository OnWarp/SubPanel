import { readAccounts } from '../accounts/repository.js'
import { userAnchorStatement } from '../db/ensure-users.js'
import type { DataEnv } from '../db/module-switch.js'
import type { CreateNoticeInput, CreateTicketInput, TicketStatus, UpdateNoticeInput } from './schema.js'
import {
  countTicketsForQueue,
  deleteNoticeById,
  getNoticeById,
  getTicketById,
  insertNotice,
  insertTicket,
  insertTicketReply,
  listNotices,
  listTicketReplies,
  listTicketsForQueue,
  listTicketsForUser,
  touchTicketAfterReply,
  updateNoticeFields,
  updateTicketStatus,
  type Notice,
  type Ticket,
  type TicketReply,
} from './repository.js'

export type TicketsEnv = DataEnv

export class TicketError extends Error {
  readonly status: 404 | 409
  readonly code: string

  constructor(status: 404 | 409, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export type TicketThread = { ticket: Ticket, replies: TicketReply[] }

const nowIso = (): string => new Date().toISOString()

// Accounts may still live in KV while tickets run on D1; anchor the
// referenced user row before the foreign-keyed insert, exactly like
// subscriptions and shares do.
async function anchorUser(env: TicketsEnv, userId: string): Promise<void> {
  const accounts = await readAccounts(env)
  const user = accounts.users.find((candidate) => candidate.id === userId)
  if (!user) throw new Error('Referenced user is missing')
  await userAnchorStatement(env.DB, user).run()
}

async function requireTicket(env: TicketsEnv, id: number): Promise<Ticket> {
  const ticket = await getTicketById(env.DB, id)
  if (!ticket) throw new TicketError(404, 'TICKET_NOT_FOUND', '工单不存在')
  return ticket
}

async function requireOwnTicket(env: TicketsEnv, id: number, userId: string): Promise<Ticket> {
  const ticket = await requireTicket(env, id)
  // Other people's tickets are indistinguishable from missing ones.
  if (ticket.userId !== userId) throw new TicketError(404, 'TICKET_NOT_FOUND', '工单不存在')
  return ticket
}

async function requireNotice(env: TicketsEnv, id: number): Promise<Notice> {
  const notice = await getNoticeById(env.DB, id)
  if (!notice) throw new TicketError(404, 'NOTICE_NOT_FOUND', '公告不存在')
  return notice
}

export async function createUserTicket(
  env: TicketsEnv,
  userId: string,
  input: CreateTicketInput,
): Promise<Ticket> {
  await anchorUser(env, userId)
  const id = await insertTicket(env.DB, {
    userId,
    title: input.title,
    body: input.body,
    level: input.level,
  }, nowIso())
  return requireTicket(env, id)
}

export async function listUserTickets(env: TicketsEnv, userId: string): Promise<Ticket[]> {
  return listTicketsForUser(env.DB, userId)
}

export async function readUserTicket(env: TicketsEnv, userId: string, id: number): Promise<TicketThread> {
  const ticket = await requireOwnTicket(env, id, userId)
  return { ticket, replies: await listTicketReplies(env.DB, id) }
}

export async function replyAsUser(
  env: TicketsEnv,
  userId: string,
  id: number,
  body: string,
): Promise<{ ticket: Ticket, reply: TicketReply }> {
  const ticket = await requireOwnTicket(env, id, userId)
  if (ticket.status === 'closed') throw new TicketError(409, 'TICKET_CLOSED', '工单已关闭，请新建工单')
  await anchorUser(env, userId)
  const now = nowIso()
  const reply = await insertTicketReply(env.DB, {
    ticketId: id,
    authorId: userId,
    authorRole: 'user',
    body,
  }, now)
  await touchTicketAfterReply(env.DB, id, { authorRole: 'user', status: 'open' }, now)
  return { ticket: await requireTicket(env, id), reply }
}

export async function closeTicketAsUser(env: TicketsEnv, userId: string, id: number): Promise<Ticket> {
  const ticket = await requireOwnTicket(env, id, userId)
  if (ticket.status === 'closed') throw new TicketError(409, 'TICKET_ALREADY_CLOSED', '工单已经关闭')
  await updateTicketStatus(env.DB, id, 'closed', nowIso())
  return requireTicket(env, id)
}

export async function listTicketQueue(
  env: TicketsEnv,
  filters: { status: TicketStatus | null },
  page: number,
  pageSize: number,
): Promise<{ tickets: Ticket[], total: number }> {
  const [tickets, total] = await Promise.all([
    listTicketsForQueue(env.DB, filters, pageSize, (page - 1) * pageSize),
    countTicketsForQueue(env.DB, filters),
  ])
  return { tickets, total }
}

export async function readAdminTicket(env: TicketsEnv, id: number): Promise<TicketThread> {
  const ticket = await requireTicket(env, id)
  return { ticket, replies: await listTicketReplies(env.DB, id) }
}

export async function replyAsAdmin(
  env: TicketsEnv,
  actorId: string,
  id: number,
  body: string,
): Promise<{ ticket: Ticket, reply: TicketReply, reopened: boolean }> {
  const ticket = await requireTicket(env, id)
  const reopened = ticket.status === 'closed'
  await anchorUser(env, actorId)
  const now = nowIso()
  const reply = await insertTicketReply(env.DB, {
    ticketId: id,
    authorId: actorId,
    authorRole: 'admin',
    body,
  }, now)
  // Replying to a closed ticket is the documented reopen path.
  await touchTicketAfterReply(env.DB, id, { authorRole: 'admin', status: 'open' }, now)
  return { ticket: await requireTicket(env, id), reply, reopened }
}

export async function closeTicketAsAdmin(env: TicketsEnv, id: number): Promise<Ticket> {
  const ticket = await requireTicket(env, id)
  if (ticket.status === 'closed') throw new TicketError(409, 'TICKET_ALREADY_CLOSED', '工单已经关闭')
  await updateTicketStatus(env.DB, id, 'closed', nowIso())
  return requireTicket(env, id)
}

export async function reopenTicketAsAdmin(env: TicketsEnv, id: number): Promise<Ticket> {
  const ticket = await requireTicket(env, id)
  if (ticket.status === 'open') throw new TicketError(409, 'TICKET_ALREADY_OPEN', '工单已经处于开启状态')
  await updateTicketStatus(env.DB, id, 'open', nowIso())
  return requireTicket(env, id)
}

export async function listVisibleNotices(env: TicketsEnv): Promise<Notice[]> {
  return listNotices(env.DB, { visibleOnly: true })
}

export async function listAllNotices(env: TicketsEnv): Promise<Notice[]> {
  return listNotices(env.DB, { visibleOnly: false })
}

export async function createNotice(env: TicketsEnv, input: CreateNoticeInput): Promise<Notice> {
  const now = nowIso()
  const id = await insertNotice(env.DB, {
    title: input.title,
    body: input.body,
    sortOrder: input.sortOrder ?? 0,
    visible: input.visible ?? true,
    publishedAt: input.publishedAt ?? now,
  }, now)
  return requireNotice(env, id)
}

export async function updateNotice(
  env: TicketsEnv,
  id: number,
  input: UpdateNoticeInput,
): Promise<Notice> {
  const notice = await requireNotice(env, id)
  await updateNoticeFields(env.DB, id, {
    title: input.title ?? notice.title,
    body: input.body ?? notice.body,
    sortOrder: input.sortOrder ?? notice.sortOrder,
    visible: input.visible ?? notice.visible,
    publishedAt: input.publishedAt ?? notice.publishedAt,
  }, nowIso())
  return requireNotice(env, id)
}

export async function deleteNotice(env: TicketsEnv, id: number): Promise<void> {
  if (!(await deleteNoticeById(env.DB, id))) {
    throw new TicketError(404, 'NOTICE_NOT_FOUND', '公告不存在')
  }
}

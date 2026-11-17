import { batch, queryFirst, type AppDatabase } from '../db/db.js'
import type { TicketAuthorRole, TicketLevel, TicketStatus } from './schema.js'

export type Ticket = {
  id: number
  userId: string
  username: string
  title: string
  level: TicketLevel
  status: TicketStatus
  createdAt: string
  updatedAt: string
  lastReplyBy: TicketAuthorRole | null
  lastReplyAt: string | null
}

export type TicketReply = {
  id: number
  ticketId: number
  authorId: string
  authorRole: TicketAuthorRole
  body: string
  createdAt: string
}

export type Notice = {
  id: number
  title: string
  body: string
  sortOrder: number
  visible: boolean
  publishedAt: string
  createdAt: string
  updatedAt: string
}

type TicketRow = {
  id: number
  user_id: string
  username: string
  title: string
  level: TicketLevel
  status: TicketStatus
  created_at: string
  updated_at: string
  last_reply_by: TicketAuthorRole | null
  last_reply_at: string | null
}

type ReplyRow = {
  id: number
  ticket_id: number
  author_id: string
  author_role: TicketAuthorRole
  body: string
  created_at: string
}

type NoticeRow = {
  id: number
  title: string
  body: string
  sort_order: number
  visible: number
  published_at: string
  created_at: string
  updated_at: string
}

const TICKET_SELECT = `
  SELECT t.id, t.user_id, u.username, t.title, t.level, t.status,
         t.created_at, t.updated_at, t.last_reply_by, t.last_reply_at
  FROM tickets t
  JOIN users u ON u.id = t.user_id`

const TICKET_ORDER = 'ORDER BY COALESCE(t.last_reply_at, t.created_at) DESC, t.id DESC'

const toTicket = (row: TicketRow): Ticket => ({
  id: row.id,
  userId: row.user_id,
  username: row.username,
  title: row.title,
  level: row.level,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastReplyBy: row.last_reply_by,
  lastReplyAt: row.last_reply_at,
})

const toReply = (row: ReplyRow): TicketReply => ({
  id: row.id,
  ticketId: row.ticket_id,
  authorId: row.author_id,
  authorRole: row.author_role,
  body: row.body,
  createdAt: row.created_at,
})

const toNotice = (row: NoticeRow): Notice => ({
  id: row.id,
  title: row.title,
  body: row.body,
  sortOrder: row.sort_order,
  visible: row.visible === 1,
  publishedAt: row.published_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export async function insertTicket(
  db: AppDatabase,
  input: { userId: string, title: string, body: string, level: TicketLevel },
  now: string,
): Promise<number> {
  const inserted = await queryFirst<{ id: number }>(
    db.prepare(
      `INSERT INTO tickets (user_id, title, level, status, created_at, updated_at, last_reply_by, last_reply_at)
       VALUES (?, ?, ?, 'open', ?, ?, 'user', ?)
       RETURNING id`,
    ).bind(input.userId, input.title, input.level, now, now, now),
  )
  if (!inserted) throw new Error('Ticket insert did not return an id')
  await db.prepare(
    'INSERT INTO ticket_replies (ticket_id, author_id, author_role, body, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(inserted.id, input.userId, 'user', input.body, now).run()
  return inserted.id
}

export async function getTicketById(db: AppDatabase, id: number): Promise<Ticket | null> {
  const row = await queryFirst<TicketRow>(db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).bind(id))
  return row ? toTicket(row) : null
}

export async function listTicketsForUser(db: AppDatabase, userId: string): Promise<Ticket[]> {
  const listed = await db
    .prepare(`${TICKET_SELECT} WHERE t.user_id = ? ${TICKET_ORDER}`)
    .bind(userId)
    .all<TicketRow>()
  return listed.results.map(toTicket)
}

export async function listTicketsForQueue(
  db: AppDatabase,
  filters: { status: TicketStatus | null },
  limit: number,
  offset: number,
): Promise<Ticket[]> {
  const where = filters.status === null ? '' : 'WHERE t.status = ?'
  const binds = filters.status === null ? [] : [filters.status]
  const listed = await db
    .prepare(`${TICKET_SELECT} ${where} ${TICKET_ORDER} LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<TicketRow>()
  return listed.results.map(toTicket)
}

export async function countTicketsForQueue(
  db: AppDatabase,
  filters: { status: TicketStatus | null },
): Promise<number> {
  const where = filters.status === null ? '' : 'WHERE status = ?'
  const binds = filters.status === null ? [] : [filters.status]
  const row = await queryFirst<{ count: number }>(
    db.prepare(`SELECT COUNT(*) AS count FROM tickets ${where}`).bind(...binds),
  )
  return Number(row?.count ?? 0)
}

export async function listTicketReplies(db: AppDatabase, ticketId: number): Promise<TicketReply[]> {
  const listed = await db
    .prepare(
      `SELECT id, ticket_id, author_id, author_role, body, created_at
       FROM ticket_replies WHERE ticket_id = ? ORDER BY id ASC`,
    )
    .bind(ticketId)
    .all<ReplyRow>()
  return listed.results.map(toReply)
}

export async function insertTicketReply(
  db: AppDatabase,
  input: { ticketId: number, authorId: string, authorRole: TicketAuthorRole, body: string },
  now: string,
): Promise<TicketReply> {
  const inserted = await queryFirst<{ id: number }>(
    db.prepare(
      `INSERT INTO ticket_replies (ticket_id, author_id, author_role, body, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`,
    ).bind(input.ticketId, input.authorId, input.authorRole, input.body, now),
  )
  if (!inserted) throw new Error('Ticket reply insert did not return an id')
  return {
    id: inserted.id,
    ticketId: input.ticketId,
    authorId: input.authorId,
    authorRole: input.authorRole,
    body: input.body,
    createdAt: now,
  }
}

export async function touchTicketAfterReply(
  db: AppDatabase,
  ticketId: number,
  fields: { authorRole: TicketAuthorRole, status: TicketStatus },
  now: string,
): Promise<void> {
  await db
    .prepare(
      'UPDATE tickets SET status = ?, last_reply_by = ?, last_reply_at = ?, updated_at = ? WHERE id = ?',
    )
    .bind(fields.status, fields.authorRole, now, now, ticketId)
    .run()
}

export async function updateTicketStatus(
  db: AppDatabase,
  ticketId: number,
  status: TicketStatus,
  now: string,
): Promise<void> {
  await db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, ticketId).run()
}

export async function listNotices(db: AppDatabase, options: { visibleOnly: boolean }): Promise<Notice[]> {
  const where = options.visibleOnly ? 'WHERE visible = 1' : ''
  const listed = await db
    .prepare(
      `SELECT id, title, body, sort_order, visible, published_at, created_at, updated_at
       FROM notices ${where}
       ORDER BY sort_order ASC, published_at DESC, id DESC`,
    )
    .all<NoticeRow>()
  return listed.results.map(toNotice)
}

export async function getNoticeById(db: AppDatabase, id: number): Promise<Notice | null> {
  const row = await queryFirst<NoticeRow>(
    db.prepare(
      `SELECT id, title, body, sort_order, visible, published_at, created_at, updated_at
       FROM notices WHERE id = ?`,
    ).bind(id),
  )
  return row ? toNotice(row) : null
}

export async function insertNotice(
  db: AppDatabase,
  fields: { title: string, body: string, sortOrder: number, visible: boolean, publishedAt: string },
  now: string,
): Promise<number> {
  const inserted = await queryFirst<{ id: number }>(
    db.prepare(
      `INSERT INTO notices (title, body, sort_order, visible, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    ).bind(
      fields.title,
      fields.body,
      fields.sortOrder,
      fields.visible ? 1 : 0,
      fields.publishedAt,
      now,
      now,
    ),
  )
  if (!inserted) throw new Error('Notice insert did not return an id')
  return inserted.id
}

export async function updateNoticeFields(
  db: AppDatabase,
  id: number,
  fields: { title: string, body: string, sortOrder: number, visible: boolean, publishedAt: string },
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE notices
       SET title = ?, body = ?, sort_order = ?, visible = ?, published_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      fields.title,
      fields.body,
      fields.sortOrder,
      fields.visible ? 1 : 0,
      fields.publishedAt,
      now,
      id,
    )
    .run()
}

export async function deleteNoticeById(db: AppDatabase, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM notices WHERE id = ?').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

export async function clearTicketsStorage(db: AppDatabase): Promise<void> {
  await batch(db, [
    db.prepare('DELETE FROM ticket_replies'),
    db.prepare('DELETE FROM tickets'),
    db.prepare('DELETE FROM notices'),
  ])
}

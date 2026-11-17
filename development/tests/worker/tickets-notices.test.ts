import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

type Ticket = {
  id: number
  userId: string
  username: string
  title: string
  level: 0 | 1
  status: 'open' | 'closed'
  createdAt: string
  updatedAt: string
  lastReplyBy: 'user' | 'admin' | null
  lastReplyAt: string | null
}

type TicketReply = {
  id: number
  ticketId: number
  authorId: string
  authorRole: 'user' | 'admin'
  body: string
  createdAt: string
}

type Notice = {
  id: number
  title: string
  body: string
  sortOrder: number
  visible: boolean
  publishedAt: string
  createdAt: string
  updatedAt: string
}

type ErrorBody = { error: { code: string, message: string } }

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await setupAdmin()
})

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status)
  const body = await response.json() as ErrorBody
  expect(body.error.code).toBe(code)
  expect(body.error.message.endsWith('。')).toBe(false)
  expect(body.error.message.endsWith('.')).toBe(false)
}

async function provisionUser(
  adminCookie: string,
  username: string,
  password: string,
): Promise<{ id: string, cookie: string }> {
  const invite = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/invites`,
    jsonRequest({ username }, withCookie(adminCookie)),
  )
  expect(invite.status).toBe(201)
  const link = (await invite.json() as { invite: { link: string } }).invite.link
  const token = new URL(link).pathname.split('/').at(-1) ?? ''
  const redeemed = await exports.default.fetch(`${TEST_ORIGIN}/api/invites/${token}`, jsonRequest({ password }))
  expect(redeemed.status).toBe(201)
  const users = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/users`, withCookie(adminCookie))).json() as {
    users: Array<{ id: string, username: string }>
  }
  const user = users.users.find((item) => item.username === username)
  if (!user) throw new Error(`missing user ${username}`)
  return { id: user.id, cookie: await login(username, password) }
}

function call(cookie: string, method: string, path: string, body?: unknown): Promise<Response> {
  const init = body === undefined
    ? withCookie(cookie, { method, headers: method === 'GET' ? {} : { origin: TEST_ORIGIN } })
    : jsonRequest(body, withCookie(cookie, { method }))
  return exports.default.fetch(`${TEST_ORIGIN}${path}`, init)
}

async function createTicket(
  cookie: string,
  body: { title: string, body: string, level?: 0 | 1 },
): Promise<Ticket> {
  const response = await call(cookie, 'POST', '/api/tickets', { level: 0, ...body })
  expect(response.status).toBe(201)
  return (await response.json() as { ticket: Ticket }).ticket
}

async function readThread(cookie: string, path: string): Promise<{ ticket: Ticket, replies: TicketReply[] }> {
  const response = await call(cookie, 'GET', path)
  expect(response.status).toBe(200)
  return response.json() as Promise<{ ticket: Ticket, replies: TicketReply[] }>
}

async function createNotice(
  admin: string,
  body: { title: string, body: string, sortOrder?: number, visible?: boolean, publishedAt?: string },
): Promise<Notice> {
  const response = await call(admin, 'POST', '/api/admin/notices', body)
  expect(response.status).toBe(201)
  return (await response.json() as { notice: Notice }).notice
}

describe('tickets', () => {
  it('isolates tickets to their owner and guards the admin queue', async () => {
    const admin = await login()
    const alice = await provisionUser(admin, 'ticket-alice', 'alice ticket password')
    const bob = await provisionUser(admin, 'ticket-bob', 'bob ticket password')

    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/tickets`),
      401,
      'AUTH_REQUIRED',
    )

    const ticket = await createTicket(alice.cookie, {
      title: '节点无法连接',
      body: '今天上午开始连不上，换了好几个客户端',
      level: 1,
    })
    expect(ticket).toMatchObject({
      userId: alice.id,
      username: 'ticket-alice',
      title: '节点无法连接',
      level: 1,
      status: 'open',
      lastReplyBy: 'user',
    })
    expect(ticket.lastReplyAt).toEqual(expect.any(String))

    const aliceList = await call(alice.cookie, 'GET', '/api/tickets')
    expect(aliceList.status).toBe(200)
    expect((await aliceList.json() as { tickets: Ticket[] }).tickets.map((item) => item.id)).toEqual([ticket.id])

    const bobList = await call(bob.cookie, 'GET', '/api/tickets')
    expect(bobList.status).toBe(200)
    expect((await bobList.json() as { tickets: Ticket[] }).tickets).toEqual([])

    await expectError(await call(bob.cookie, 'GET', `/api/tickets/${ticket.id}`), 404, 'TICKET_NOT_FOUND')
    await expectError(
      await call(bob.cookie, 'POST', `/api/tickets/${ticket.id}/replies`, { body: '越权回复' }),
      404,
      'TICKET_NOT_FOUND',
    )
    await expectError(await call(bob.cookie, 'POST', `/api/tickets/${ticket.id}/close`, {}), 404, 'TICKET_NOT_FOUND')
    await expectError(await call(alice.cookie, 'GET', '/api/admin/tickets'), 403, 'ADMIN_REQUIRED')

    const adminThread = await readThread(admin, `/api/admin/tickets/${ticket.id}`)
    expect(adminThread.ticket.username).toBe('ticket-alice')
    expect(adminThread.replies).toHaveLength(1)
    expect(adminThread.replies[0]).toMatchObject({ authorId: alice.id, authorRole: 'user', body: '今天上午开始连不上，换了好几个客户端' })

    const queue = await call(admin, 'GET', '/api/admin/tickets')
    expect(queue.status).toBe(200)
    expect(await queue.json()).toMatchObject({ total: 1, page: 1, pageSize: 20 })

    await expectError(
      await call(alice.cookie, 'POST', '/api/tickets', { title: '', body: '正文', level: 0 }),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await call(alice.cookie, 'POST', '/api/tickets', { title: '标题', body: '', level: 0 }),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await call(alice.cookie, 'POST', '/api/tickets', { title: '标题', body: '正文', level: 2 }),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(await call(alice.cookie, 'GET', '/api/tickets/not-a-number'), 404, 'TICKET_NOT_FOUND')
  })

  it('runs create -> reply -> close and reopens on an admin reply', async () => {
    const admin = await login()
    const alice = await provisionUser(admin, 'lifecycle-user', 'lifecycle password')
    const ticket = await createTicket(alice.cookie, {
      title: '订阅更新失败',
      body: '订阅链接更新后客户端没有新节点',
      level: 0,
    })

    const firstReply = await call(alice.cookie, 'POST', `/api/tickets/${ticket.id}/replies`, { body: '已重启客户端，仍然没有' })
    expect(firstReply.status).toBe(200)
    const firstReplyBody = await firstReply.json() as { ticket: Ticket, reply: TicketReply }
    expect(firstReplyBody.reply).toMatchObject({ authorRole: 'user', body: '已重启客户端，仍然没有' })
    expect(firstReplyBody.ticket.lastReplyBy).toBe('user')

    const closed = await call(alice.cookie, 'POST', `/api/tickets/${ticket.id}/close`, {})
    expect(closed.status).toBe(200)
    expect((await closed.json() as { ticket: Ticket }).ticket.status).toBe('closed')
    await expectError(
      await call(alice.cookie, 'POST', `/api/tickets/${ticket.id}/replies`, { body: '关单后回复' }),
      409,
      'TICKET_CLOSED',
    )

    const adminReply = await call(admin, 'POST', `/api/admin/tickets/${ticket.id}/replies`, { body: '已定位到缓存问题，请重新拉取' })
    expect(adminReply.status).toBe(200)
    const adminReplyBody = await adminReply.json() as { ticket: Ticket, reply: TicketReply, reopened: boolean }
    expect(adminReplyBody.reopened).toBe(true)
    expect(adminReplyBody.ticket.status).toBe('open')
    expect(adminReplyBody.ticket.lastReplyBy).toBe('admin')
    expect(adminReplyBody.reply.authorRole).toBe('admin')

    const userReply = await call(alice.cookie, 'POST', `/api/tickets/${ticket.id}/replies`, { body: '好，已经恢复，谢谢' })
    expect(userReply.status).toBe(200)

    const thread = await readThread(alice.cookie, `/api/tickets/${ticket.id}`)
    expect(thread.replies.map((reply) => reply.body)).toEqual([
      '订阅链接更新后客户端没有新节点',
      '已重启客户端，仍然没有',
      '已定位到缓存问题，请重新拉取',
      '好，已经恢复，谢谢',
    ])

    const closedAgain = await call(admin, 'POST', `/api/admin/tickets/${ticket.id}/close`, {})
    expect(closedAgain.status).toBe(200)
    await expectError(
      await call(admin, 'POST', `/api/admin/tickets/${ticket.id}/close`, {}),
      409,
      'TICKET_ALREADY_CLOSED',
    )

    const reopened = await call(admin, 'POST', `/api/admin/tickets/${ticket.id}/reopen`, {})
    expect(reopened.status).toBe(200)
    expect((await reopened.json() as { ticket: Ticket }).ticket.status).toBe('open')
    await expectError(
      await call(admin, 'POST', `/api/admin/tickets/${ticket.id}/reopen`, {}),
      409,
      'TICKET_ALREADY_OPEN',
    )
  })

  it('filters and paginates the admin queue by last reply', async () => {
    const admin = await login()
    const alice = await provisionUser(admin, 'queue-alice', 'queue alice password')
    const bob = await provisionUser(admin, 'queue-bob', 'queue bob password')

    const oldest = await createTicket(alice.cookie, { title: '最早工单', body: '一' })
    const middle = await createTicket(bob.cookie, { title: '中间工单', body: '二' })
    const newest = await createTicket(alice.cookie, { title: '最新工单', body: '三' })

    await env.DB.prepare('UPDATE tickets SET last_reply_at = ? WHERE id = ?')
      .bind('2026-01-01T00:00:00.000Z', oldest.id).run()
    await env.DB.prepare('UPDATE tickets SET last_reply_at = ? WHERE id = ?')
      .bind('2026-02-01T00:00:00.000Z', middle.id).run()
    await env.DB.prepare('UPDATE tickets SET last_reply_at = ? WHERE id = ?')
      .bind('2026-03-01T00:00:00.000Z', newest.id).run()

    const firstPage = await call(admin, 'GET', '/api/admin/tickets?page=1&pageSize=2')
    expect(firstPage.status).toBe(200)
    expect(await firstPage.json()).toMatchObject({
      total: 3,
      page: 1,
      pageSize: 2,
      tickets: [{ id: newest.id }, { id: middle.id }],
    })

    const secondPage = await call(admin, 'GET', '/api/admin/tickets?page=2&pageSize=2')
    expect((await secondPage.json() as { tickets: Ticket[] }).tickets.map((item) => item.id)).toEqual([oldest.id])

    const close = await call(admin, 'POST', `/api/admin/tickets/${middle.id}/close`, {})
    expect(close.status).toBe(200)

    const closedQueue = await call(admin, 'GET', '/api/admin/tickets?status=closed')
    const closedQueueBody = await closedQueue.json() as { tickets: Ticket[], total: number }
    expect(closedQueueBody.total).toBe(1)
    expect(closedQueueBody.tickets.map((item) => item.id)).toEqual([middle.id])

    const openQueue = await call(admin, 'GET', '/api/admin/tickets?status=open')
    expect((await openQueue.json() as { tickets: Ticket[] }).tickets.map((item) => item.id)).toEqual([newest.id, oldest.id])

    await expectError(
      await call(admin, 'GET', '/api/admin/tickets?status=pending'),
      422,
      'VALIDATION_FAILED',
    )
  })
})

describe('notices', () => {
  it('searches visible titles and bodies with literal input and stable server pagination', async () => {
    const admin = await login()
    const reader = await provisionUser(admin, 'search-reader', 'search reader password')
    await createNotice(admin,{ title: 'Secret match', body: 'Needle', visible: false })
    const first = await createNotice(admin,{ title: 'NEEDLE title', body: 'First', sortOrder: 1 })
    const second = await createNotice(admin,{ title: 'Body match', body: 'A needle in text', sortOrder: 2 })
    const literal = await createNotice(admin,{ title: '100%_literal', body: '中文内容', sortOrder: 3 })
    await createNotice(admin,{ title: 'Unrelated', body: 'Other' })
    const query = (q: string, page = 1) => call(reader.cookie, 'GET', `/api/notices?q=${encodeURIComponent(q)}&page=${page}&pageSize=1`)
    expect(await (await query(' needle ')).json()).toMatchObject({ notices: [{ id: first.id }], total: 2, page: 1, pageSize: 1 })
    expect(await (await query('needle',2)).json()).toMatchObject({ notices: [{ id: second.id }], total: 2, page: 2 })
    expect(await (await query('needle',3)).json()).toMatchObject({ notices: [], total: 2 })
    expect(await (await query('%_')).json()).toMatchObject({ notices: [{ id: literal.id }], total: 1 })
    expect(await (await query('中文')).json()).toMatchObject({ total: 1 })
    expect(await (await query("' OR 1=1 --")).json()).toMatchObject({ notices: [], total: 0 })
    const bounded = await call(reader.cookie, 'GET', '/api/notices?q=&page=-1&pageSize=999')
    expect(await bounded.json()).toMatchObject({ total: 4, page: 1, pageSize: 100 })
    await expectError(await exports.default.fetch(`${TEST_ORIGIN}/api/notices?q=needle`),401,'AUTH_REQUIRED')
  })
  it('filters by visibility and orders by sort order then publish time', async () => {
    const admin = await login()
    const reader = await provisionUser(admin, 'notice-reader', 'notice reader password')

    await expectError(await exports.default.fetch(`${TEST_ORIGIN}/api/notices`), 401, 'AUTH_REQUIRED')
    await expectError(await call(reader.cookie, 'GET', '/api/admin/notices'), 403, 'ADMIN_REQUIRED')
    await expectError(
      await call(reader.cookie, 'POST', '/api/admin/notices', { title: '越权', body: '正文' }),
      403,
      'ADMIN_REQUIRED',
    )

    const hidden = await createNotice(admin, {
      title: '内部草稿',
      body: '尚未发布',
      sortOrder: 0,
      visible: false,
      publishedAt: '2026-01-01T00:00:00.000Z',
    })
    const later = await createNotice(admin, {
      title: '第二条公告',
      body: '正文二',
      sortOrder: 10,
      publishedAt: '2026-01-03T00:00:00.000Z',
    })
    const earlier = await createNotice(admin, {
      title: '第一条公告',
      body: '正文一',
      sortOrder: 20,
      publishedAt: '2026-01-02T00:00:00.000Z',
    })

    const adminList = await call(admin, 'GET', '/api/admin/notices')
    expect(adminList.status).toBe(200)
    expect((await adminList.json() as { notices: Notice[] }).notices.map((item) => item.id))
      .toEqual([hidden.id, later.id, earlier.id])

    const visible = await call(reader.cookie, 'GET', '/api/notices')
    expect(visible.status).toBe(200)
    const visibleBody = await visible.json() as { notices: Notice[] }
    expect(visibleBody.notices.map((item) => item.id)).toEqual([later.id, earlier.id])
    expect(visibleBody.notices[0]?.body).toBe('正文二')
    expect(JSON.stringify(visibleBody)).not.toContain('尚未发布')

    const publish = await call(admin, 'PUT', `/api/admin/notices/${hidden.id}`, { visible: true })
    expect(publish.status).toBe(200)
    expect((await publish.json() as { notice: Notice }).notice.visible).toBe(true)

    const afterPublish = await call(reader.cookie, 'GET', '/api/notices')
    expect((await afterPublish.json() as { notices: Notice[] }).notices.map((item) => item.id))
      .toEqual([hidden.id, later.id, earlier.id])

    const hide = await call(admin, 'PUT', `/api/admin/notices/${later.id}`, { visible: false, title: '第二条公告（修订）' })
    expect(hide.status).toBe(200)
    const afterHide = await call(reader.cookie, 'GET', '/api/notices')
    expect((await afterHide.json() as { notices: Notice[] }).notices.map((item) => item.id))
      .toEqual([hidden.id, earlier.id])

    const adminAfterHide = await call(admin, 'GET', '/api/admin/notices')
    expect((await adminAfterHide.json() as { notices: Notice[] }).notices.find((item) => item.id === later.id)?.title)
      .toBe('第二条公告（修订）')

    const removed = await call(admin, 'DELETE', `/api/admin/notices/${earlier.id}`)
    expect(removed.status).toBe(204)
    const afterDelete = await call(admin, 'GET', '/api/admin/notices')
    expect((await afterDelete.json() as { notices: Notice[] }).notices.map((item) => item.id))
      .not.toContain(earlier.id)

    await expectError(await call(admin, 'DELETE', '/api/admin/notices/9999'), 404, 'NOTICE_NOT_FOUND')
    await expectError(
      await call(admin, 'PUT', '/api/admin/notices/9999', { title: '不存在' }),
      404,
      'NOTICE_NOT_FOUND',
    )
    await expectError(
      await call(admin, 'POST', '/api/admin/notices', { title: '', body: '正文' }),
      422,
      'VALIDATION_FAILED',
    )
  })
})

import { z } from 'zod'

export const ticketLevelSchema = z.union([z.literal(0), z.literal(1)])
export const ticketStatusSchema = z.enum(['open', 'closed'])
export const ticketAuthorRoleSchema = z.enum(['user', 'admin'])

export const createTicketSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(5_000),
  level: ticketLevelSchema.default(0),
})

export const replyTicketSchema = z.object({
  body: z.string().trim().min(1).max(5_000),
})

const noticeFields = {
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20_000),
  sortOrder: z.number().int().min(0).max(100_000),
  visible: z.boolean(),
  publishedAt: z.iso.datetime(),
}

export const createNoticeSchema = z.object({
  title: noticeFields.title,
  body: noticeFields.body,
  sortOrder: noticeFields.sortOrder.optional(),
  visible: noticeFields.visible.optional(),
  publishedAt: noticeFields.publishedAt.optional(),
})

export const updateNoticeSchema = z.object(noticeFields).partial().refine(
  (value) => Object.keys(value).length > 0,
  '至少需要一个字段',
)

export type TicketLevel = z.infer<typeof ticketLevelSchema>
export type TicketStatus = z.infer<typeof ticketStatusSchema>
export type TicketAuthorRole = z.infer<typeof ticketAuthorRoleSchema>
export type CreateTicketInput = z.infer<typeof createTicketSchema>
export type CreateNoticeInput = z.infer<typeof createNoticeSchema>
export type UpdateNoticeInput = z.infer<typeof updateNoticeSchema>

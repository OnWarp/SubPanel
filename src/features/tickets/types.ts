import type { StatusBadgeTone } from '../../ui/StatusBadge'

export type TicketLevel = 0 | 1
export type TicketStatus = 'open' | 'closed'
export type TicketAuthorRole = 'user' | 'admin'

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

export type TicketThreadData = {
  ticket: Ticket
  replies: TicketReply[]
}

export function ticketState(ticket: Ticket): { label: string; tone: StatusBadgeTone } {
  if (ticket.status === 'closed') return { label: '已关闭', tone: 'muted' }
  if (ticket.lastReplyBy === 'admin') return { label: '已回复', tone: 'success' }
  return { label: '待回复', tone: 'info' }
}

export function levelLabel(level: TicketLevel): { label: string; tone: StatusBadgeTone } {
  return level === 1 ? { label: '优先', tone: 'warning' } : { label: '普通', tone: 'muted' }
}

export function formatTicketTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '-'
}

export function ticketTime(ticket: Ticket): string {
  return ticket.lastReplyAt ?? ticket.createdAt
}

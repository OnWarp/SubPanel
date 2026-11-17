import { StatusPill } from '../../ui/StatusPill'
import { StatusBadge } from '../../ui/StatusBadge'
import { formatTicketTime, levelLabel, ticketState, type Ticket, type TicketReply } from './types'

type TicketThreadProps = {
  ticket: Ticket
  replies: TicketReply[]
  viewerRole: 'user' | 'admin'
}

export function TicketThread({ ticket, replies, viewerRole }: TicketThreadProps) {
  const state = ticketState(ticket)
  const level = levelLabel(ticket.level)
  return (
    <section className="data-section tk-thread" aria-labelledby="tk-thread-title">
      <div className="tk-thread-head">
        <div className="tk-thread-title">
          <h2 id="tk-thread-title">{ticket.title}</h2>
          <span className="tk-thread-meta">
            {viewerRole === 'admin' ? `${ticket.username} · ` : ''}
            创建于 {formatTicketTime(ticket.createdAt)}
          </span>
        </div>
        <span className="tk-badges">
          <StatusPill tone={state.tone === 'muted' ? 'neutral' : state.tone}>{state.label}</StatusPill>
          <StatusBadge tone={level.tone} size="sm">{level.label}</StatusBadge>
        </span>
      </div>
      <ol className="tk-replies">
        {replies.map((reply) => (
          <li key={reply.id} className={`tk-message tk-message-${reply.authorRole}`}>
            <div className="tk-message-head">
              <strong>{reply.authorRole === 'admin' ? '管理员' : viewerRole === 'user' ? '我' : ticket.username}</strong>
              <time dateTime={reply.createdAt}>{formatTicketTime(reply.createdAt)}</time>
            </div>
            <p className="tk-message-body">{reply.body}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

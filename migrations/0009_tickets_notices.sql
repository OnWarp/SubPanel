-- Stage 2B: user tickets and notices.
-- Tickets are a user-owned conversation thread: the opening post is stored as
-- the first ticket_replies row so the detail view renders one uniform stream.
-- status only distinguishes open/closed; "replied" is derived from
-- last_reply_by so no extra status column drifts out of sync.
-- Cross-aggregate references use ON DELETE RESTRICT (users); replies are
-- children of their ticket and cascade with it.
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  level INTEGER NOT NULL DEFAULT 0 CHECK (level IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_reply_by TEXT CHECK (last_reply_by IS NULL OR last_reply_by IN ('user', 'admin')),
  last_reply_at TEXT
);

CREATE INDEX tickets_user_id ON tickets(user_id);
CREATE INDEX tickets_status ON tickets(status);
CREATE INDEX tickets_last_reply_at ON tickets(last_reply_at);

CREATE TABLE ticket_replies (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_role TEXT NOT NULL CHECK (author_role IN ('user', 'admin')),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_at TEXT NOT NULL
);

CREATE INDEX ticket_replies_ticket_id ON ticket_replies(ticket_id);
CREATE INDEX ticket_replies_author_id ON ticket_replies(author_id);

-- Notices are admin-authored broadcast messages. The user-facing list reads
-- only visible rows, ordered by sort_order then newest published_at.
CREATE TABLE notices (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX notices_visible_sort ON notices(visible, sort_order, published_at);

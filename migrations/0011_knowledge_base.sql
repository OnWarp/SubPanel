-- Stage 4: knowledge base.
-- Categories are a flat, admin-ordered list. Articles belong to exactly one
-- category and carry a draft/published flag; the user-facing queries only read
-- published rows. Cross-aggregate references use ON DELETE RESTRICT so a
-- category with articles cannot disappear underneath them.
CREATE TABLE kb_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  sort INTEGER NOT NULL DEFAULT 0 CHECK (sort >= 0),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX kb_categories_name ON kb_categories(name);
CREATE INDEX kb_categories_sort ON kb_categories(sort, id);

CREATE TABLE kb_articles (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES kb_categories(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  sort INTEGER NOT NULL DEFAULT 0 CHECK (sort >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX kb_articles_category ON kb_articles(category_id, sort, id);
CREATE INDEX kb_articles_published ON kb_articles(published, sort, id);

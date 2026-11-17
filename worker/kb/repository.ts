import { batch, queryFirst, type AppDatabase } from '../db/db.js'

export type KbCategory = {
  id: number
  name: string
  sort: number
  createdAt: string
}

export type KbArticleSummary = {
  id: number
  categoryId: number
  categoryName: string
  title: string
  published: boolean
  sort: number
  createdAt: string
  updatedAt: string
}

export type KbArticle = KbArticleSummary & { content: string }

type CategoryRow = {
  id: number
  name: string
  sort: number
  created_at: string
}

type ArticleRow = {
  id: number
  category_id: number
  category_name: string
  title: string
  content: string
  published: number
  sort: number
  created_at: string
  updated_at: string
}

const CATEGORY_SELECT = 'SELECT id, name, sort, created_at FROM kb_categories'

const ARTICLE_SELECT = `
  SELECT a.id, a.category_id, c.name AS category_name, a.title, a.content,
         a.published, a.sort, a.created_at, a.updated_at
  FROM kb_articles a
  JOIN kb_categories c ON c.id = a.category_id`

const ARTICLE_ORDER = 'ORDER BY c.sort ASC, a.sort ASC, a.id ASC'

const toCategory = (row: CategoryRow): KbCategory => ({
  id: row.id,
  name: row.name,
  sort: row.sort,
  createdAt: row.created_at,
})

const toSummary = (row: ArticleRow): KbArticleSummary => ({
  id: row.id,
  categoryId: row.category_id,
  categoryName: row.category_name,
  title: row.title,
  published: row.published === 1,
  sort: row.sort,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toArticle = (row: ArticleRow): KbArticle => ({
  ...toSummary(row),
  content: row.content,
})

export async function listCategories(db: AppDatabase): Promise<KbCategory[]> {
  const listed = await db
    .prepare(`${CATEGORY_SELECT} ORDER BY sort ASC, id ASC`)
    .all<CategoryRow>()
  return listed.results.map(toCategory)
}

export async function getCategoryById(db: AppDatabase, id: number): Promise<KbCategory | null> {
  const row = await queryFirst<CategoryRow>(db.prepare(`${CATEGORY_SELECT} WHERE id = ?`).bind(id))
  return row ? toCategory(row) : null
}

export async function findCategoryByName(db: AppDatabase, name: string): Promise<KbCategory | null> {
  const row = await queryFirst<CategoryRow>(db.prepare(`${CATEGORY_SELECT} WHERE name = ?`).bind(name))
  return row ? toCategory(row) : null
}

export async function countArticlesInCategory(db: AppDatabase, categoryId: number): Promise<number> {
  const row = await queryFirst<{ count: number }>(
    db.prepare('SELECT COUNT(*) AS count FROM kb_articles WHERE category_id = ?').bind(categoryId),
  )
  return Number(row?.count ?? 0)
}

export async function insertCategory(
  db: AppDatabase,
  fields: { name: string, sort: number },
  now: string,
): Promise<number> {
  const inserted = await queryFirst<{ id: number }>(
    db.prepare(
      'INSERT INTO kb_categories (name, sort, created_at) VALUES (?, ?, ?) RETURNING id',
    ).bind(fields.name, fields.sort, now),
  )
  if (!inserted) throw new Error('Category insert did not return an id')
  return inserted.id
}

export async function updateCategoryFields(
  db: AppDatabase,
  id: number,
  fields: { name: string, sort: number },
): Promise<void> {
  await db
    .prepare('UPDATE kb_categories SET name = ?, sort = ? WHERE id = ?')
    .bind(fields.name, fields.sort, id)
    .run()
}

export async function deleteCategoryById(db: AppDatabase, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM kb_categories WHERE id = ?').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

export async function listArticles(
  db: AppDatabase,
  filters: { categoryId: number | null, published: boolean | null },
  limit: number,
  offset: number,
): Promise<KbArticleSummary[]> {
  const conditions: string[] = []
  const binds: Array<string | number> = []
  if (filters.categoryId !== null) {
    conditions.push('a.category_id = ?')
    binds.push(filters.categoryId)
  }
  if (filters.published !== null) {
    conditions.push('a.published = ?')
    binds.push(filters.published ? 1 : 0)
  }
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
  const listed = await db
    .prepare(`SELECT a.id, a.category_id, c.name AS category_name, a.title, '' AS content,
                     a.published, a.sort, a.created_at, a.updated_at
              FROM kb_articles a
              JOIN kb_categories c ON c.id = a.category_id
              ${where} ${ARTICLE_ORDER} LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<ArticleRow>()
  return listed.results.map(toSummary)
}

export async function countArticles(
  db: AppDatabase,
  filters: { categoryId: number | null, published: boolean | null },
): Promise<number> {
  const conditions: string[] = []
  const binds: Array<number> = []
  if (filters.categoryId !== null) {
    conditions.push('category_id = ?')
    binds.push(filters.categoryId)
  }
  if (filters.published !== null) {
    conditions.push('published = ?')
    binds.push(filters.published ? 1 : 0)
  }
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
  const row = await queryFirst<{ count: number }>(
    db.prepare(`SELECT COUNT(*) AS count FROM kb_articles ${where}`).bind(...binds),
  )
  return Number(row?.count ?? 0)
}

export async function getArticleById(db: AppDatabase, id: number): Promise<KbArticle | null> {
  const row = await queryFirst<ArticleRow>(db.prepare(`${ARTICLE_SELECT} WHERE a.id = ?`).bind(id))
  return row ? toArticle(row) : null
}

export async function getPublishedArticleById(db: AppDatabase, id: number): Promise<KbArticle | null> {
  const row = await queryFirst<ArticleRow>(
    db.prepare(`${ARTICLE_SELECT} WHERE a.id = ? AND a.published = 1`).bind(id),
  )
  return row ? toArticle(row) : null
}

export async function insertArticle(
  db: AppDatabase,
  fields: {
    categoryId: number
    title: string
    content: string
    published: boolean
    sort: number
  },
  now: string,
): Promise<number> {
  const inserted = await queryFirst<{ id: number }>(
    db.prepare(
      `INSERT INTO kb_articles (category_id, title, content, published, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    ).bind(
      fields.categoryId,
      fields.title,
      fields.content,
      fields.published ? 1 : 0,
      fields.sort,
      now,
      now,
    ),
  )
  if (!inserted) throw new Error('Article insert did not return an id')
  return inserted.id
}

export async function updateArticleFields(
  db: AppDatabase,
  id: number,
  fields: {
    categoryId: number
    title: string
    content: string
    published: boolean
    sort: number
  },
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE kb_articles
       SET category_id = ?, title = ?, content = ?, published = ?, sort = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      fields.categoryId,
      fields.title,
      fields.content,
      fields.published ? 1 : 0,
      fields.sort,
      now,
      id,
    )
    .run()
}

export async function deleteArticleById(db: AppDatabase, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM kb_articles WHERE id = ?').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

export async function listPublishedArticles(db: AppDatabase): Promise<KbArticleSummary[]> {
  const listed = await db
    .prepare(`SELECT a.id, a.category_id, c.name AS category_name, a.title, '' AS content,
                     a.published, a.sort, a.created_at, a.updated_at
              FROM kb_articles a
              JOIN kb_categories c ON c.id = a.category_id
              WHERE a.published = 1 ${ARTICLE_ORDER}`)
    .all<ArticleRow>()
  return listed.results.map(toSummary)
}

export async function searchPublishedArticles(
  db: AppDatabase,
  pattern: string,
): Promise<KbArticleSummary[]> {
  const listed = await db
    .prepare(`SELECT a.id, a.category_id, c.name AS category_name, a.title, '' AS content,
                     a.published, a.sort, a.created_at, a.updated_at
              FROM kb_articles a
              JOIN kb_categories c ON c.id = a.category_id
              WHERE a.published = 1
                AND (a.title LIKE ? ESCAPE '\\' OR a.content LIKE ? ESCAPE '\\')
              ${ARTICLE_ORDER}`)
    .bind(pattern, pattern)
    .all<ArticleRow>()
  return listed.results.map(toSummary)
}

export async function clearKnowledgeBaseStorage(db: AppDatabase): Promise<void> {
  await batch(db, [
    db.prepare('DELETE FROM kb_articles'),
    db.prepare('DELETE FROM kb_categories'),
  ])
}

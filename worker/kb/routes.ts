import { Hono } from 'hono'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import {
  createArticleSchema,
  createCategorySchema,
  updateArticleSchema,
  updateCategorySchema,
} from './schema.js'
import {
  KbError,
  createKbArticle,
  createKbCategory,
  deleteKbArticle,
  deleteKbCategory,
  listAdminArticles,
  listKbCategories,
  readAdminArticle,
  readUserKb,
  readUserKbArticle,
  searchUserKb,
  updateKbArticle,
  updateKbCategory,
} from './service.js'

const recordIdPattern = /^[1-9]\d*$/u

function requireId(value: string | undefined, code: string, message: string): number {
  if (!value || !recordIdPattern.test(value)) throw apiError(404, code, message)
  const id = Number(value)
  if (!Number.isSafeInteger(id)) throw apiError(404, code, message)
  return id
}

function requireCategoryId(value: string | undefined): number {
  return requireId(value, 'KB_CATEGORY_NOT_FOUND', '知识库分类不存在')
}

function requireArticleId(value: string | undefined): number {
  return requireId(value, 'KB_ARTICLE_NOT_FOUND', '知识库文章不存在')
}

function raise(error: unknown): never {
  if (error instanceof KbError) throw apiError(error.status, error.code, error.message)
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

function parseCategoryFilter(query: Record<string, string | undefined>): number | null {
  const raw = query.categoryId
  if (raw === undefined || raw === '') return null
  if (!recordIdPattern.test(raw)) throw apiError(422, 'VALIDATION_FAILED', '输入校验失败')
  const id = Number(raw)
  if (!Number.isSafeInteger(id)) throw apiError(422, 'VALIDATION_FAILED', '输入校验失败')
  return id
}

function parsePublishedFilter(query: Record<string, string | undefined>): boolean | null {
  const raw = query.published
  if (raw === undefined || raw === '') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw apiError(422, 'VALIDATION_FAILED', '输入校验失败')
}

export const userKbRoutes = new Hono<AppEnv>()

userKbRoutes.get('/', async (c) => c.json(await run(() => readUserKb(c.env))))

userKbRoutes.get('/search', async (c) => {
  const query = (c.req.query('q') ?? '').trim()
  if (query.length === 0 || query.length > 100) {
    throw apiError(422, 'VALIDATION_FAILED', '搜索关键词不能为空且不能超过 100 个字符')
  }
  return c.json(await run(() => searchUserKb(c.env, query)))
})

userKbRoutes.get('/articles/:id', async (c) => {
  const id = requireArticleId(c.req.param('id'))
  return c.json({ article: await run(() => readUserKbArticle(c.env, id)) })
})

export const adminKbRoutes = new Hono<AppEnv>()

adminKbRoutes.get('/kb/categories', async (c) => {
  const categories = await run(() => listKbCategories(c.env))
  return c.json({ categories })
})

adminKbRoutes.post('/kb/categories', async (c) => {
  const input = await readJson(c, createCategorySchema)
  const category = await run(() => createKbCategory(c.env, input))
  return c.json({ category }, 201)
})

adminKbRoutes.put('/kb/categories/:id', async (c) => {
  const id = requireCategoryId(c.req.param('id'))
  const input = await readJson(c, updateCategorySchema)
  return c.json({ category: await run(() => updateKbCategory(c.env, id, input)) })
})

adminKbRoutes.delete('/kb/categories/:id', async (c) => {
  const id = requireCategoryId(c.req.param('id'))
  await run(() => deleteKbCategory(c.env, id))
  return c.body(null, 204)
})

adminKbRoutes.get('/kb/articles', async (c) => {
  const query = c.req.query()
  const filters = {
    categoryId: parseCategoryFilter(query),
    published: parsePublishedFilter(query),
  }
  const { page, pageSize } = parsePagination(query)
  const result = await run(() => listAdminArticles(c.env, filters, page, pageSize))
  return c.json({ articles: result.articles, total: result.total, page, pageSize })
})

adminKbRoutes.get('/kb/articles/:id', async (c) => {
  const id = requireArticleId(c.req.param('id'))
  return c.json({ article: await run(() => readAdminArticle(c.env, id)) })
})

adminKbRoutes.post('/kb/articles', async (c) => {
  const input = await readJson(c, createArticleSchema)
  const article = await run(() => createKbArticle(c.env, input))
  return c.json({ article }, 201)
})

adminKbRoutes.put('/kb/articles/:id', async (c) => {
  const id = requireArticleId(c.req.param('id'))
  const input = await readJson(c, updateArticleSchema)
  return c.json({ article: await run(() => updateKbArticle(c.env, id, input)) })
})

adminKbRoutes.delete('/kb/articles/:id', async (c) => {
  const id = requireArticleId(c.req.param('id'))
  await run(() => deleteKbArticle(c.env, id))
  return c.body(null, 204)
})

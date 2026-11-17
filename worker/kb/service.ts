import type { DataEnv } from '../db/module-switch.js'
import {
  countArticles,
  countArticlesInCategory,
  deleteArticleById,
  deleteCategoryById,
  findCategoryByName,
  getArticleById,
  getCategoryById,
  getPublishedArticleById,
  insertArticle,
  insertCategory,
  listArticles,
  listCategories,
  listPublishedArticles,
  searchPublishedArticles,
  updateArticleFields,
  updateCategoryFields,
  type KbArticle,
  type KbArticleSummary,
  type KbCategory,
} from './repository.js'
import type {
  CreateArticleInput,
  CreateCategoryInput,
  UpdateArticleInput,
  UpdateCategoryInput,
} from './schema.js'

export type KbEnv = DataEnv

export class KbError extends Error {
  readonly status: 404 | 409
  readonly code: string

  constructor(status: 404 | 409, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export type UserKbCategory = {
  id: number
  name: string
  sort: number
  articles: KbArticleSummary[]
}

const nowIso = (): string => new Date().toISOString()

async function requireCategory(env: KbEnv, id: number): Promise<KbCategory> {
  const category = await getCategoryById(env.DB, id)
  if (!category) throw new KbError(404, 'KB_CATEGORY_NOT_FOUND', '知识库分类不存在')
  return category
}

async function requireArticle(env: KbEnv, id: number): Promise<KbArticle> {
  const article = await getArticleById(env.DB, id)
  if (!article) throw new KbError(404, 'KB_ARTICLE_NOT_FOUND', '知识库文章不存在')
  return article
}

async function assertCategoryNameAvailable(
  env: KbEnv,
  name: string,
  currentId: number | null,
): Promise<void> {
  const existing = await findCategoryByName(env.DB, name)
  if (existing && existing.id !== currentId) {
    throw new KbError(409, 'KB_CATEGORY_NAME_TAKEN', '分类名称已存在')
  }
}

export async function listKbCategories(env: KbEnv): Promise<KbCategory[]> {
  return listCategories(env.DB)
}

export async function createKbCategory(env: KbEnv, input: CreateCategoryInput): Promise<KbCategory> {
  await assertCategoryNameAvailable(env, input.name, null)
  const id = await insertCategory(env.DB, { name: input.name, sort: input.sort ?? 0 }, nowIso())
  return requireCategory(env, id)
}

export async function updateKbCategory(
  env: KbEnv,
  id: number,
  input: UpdateCategoryInput,
): Promise<KbCategory> {
  const category = await requireCategory(env, id)
  const name = input.name ?? category.name
  await assertCategoryNameAvailable(env, name, id)
  await updateCategoryFields(env.DB, id, { name, sort: input.sort ?? category.sort })
  return requireCategory(env, id)
}

export async function deleteKbCategory(env: KbEnv, id: number): Promise<void> {
  await requireCategory(env, id)
  if ((await countArticlesInCategory(env.DB, id)) > 0) {
    throw new KbError(409, 'KB_CATEGORY_IN_USE', '分类下还有文章，不能删除')
  }
  if (!(await deleteCategoryById(env.DB, id))) {
    throw new KbError(404, 'KB_CATEGORY_NOT_FOUND', '知识库分类不存在')
  }
}

export async function listAdminArticles(
  env: KbEnv,
  filters: { categoryId: number | null, published: boolean | null },
  page: number,
  pageSize: number,
): Promise<{ articles: KbArticleSummary[], total: number }> {
  if (filters.categoryId !== null) await requireCategory(env, filters.categoryId)
  const [articles, total] = await Promise.all([
    listArticles(env.DB, filters, pageSize, (page - 1) * pageSize),
    countArticles(env.DB, filters),
  ])
  return { articles, total }
}

export async function readAdminArticle(env: KbEnv, id: number): Promise<KbArticle> {
  return requireArticle(env, id)
}

export async function createKbArticle(env: KbEnv, input: CreateArticleInput): Promise<KbArticle> {
  await requireCategory(env, input.categoryId)
  const id = await insertArticle(env.DB, {
    categoryId: input.categoryId,
    title: input.title,
    content: input.content,
    published: input.published ?? false,
    sort: input.sort ?? 0,
  }, nowIso())
  return requireArticle(env, id)
}

export async function updateKbArticle(
  env: KbEnv,
  id: number,
  input: UpdateArticleInput,
): Promise<KbArticle> {
  const article = await requireArticle(env, id)
  const categoryId = input.categoryId ?? article.categoryId
  await requireCategory(env, categoryId)
  await updateArticleFields(env.DB, id, {
    categoryId,
    title: input.title ?? article.title,
    content: input.content ?? article.content,
    published: input.published ?? article.published,
    sort: input.sort ?? article.sort,
  }, nowIso())
  return requireArticle(env, id)
}

export async function deleteKbArticle(env: KbEnv, id: number): Promise<void> {
  if (!(await deleteArticleById(env.DB, id))) {
    throw new KbError(404, 'KB_ARTICLE_NOT_FOUND', '知识库文章不存在')
  }
}

export async function readUserKb(env: KbEnv): Promise<{ categories: UserKbCategory[] }> {
  const [categories, articles] = await Promise.all([
    listCategories(env.DB),
    listPublishedArticles(env.DB),
  ])
  const byCategory = new Map<number, KbArticleSummary[]>()
  for (const article of articles) {
    const bucket = byCategory.get(article.categoryId)
    if (bucket) bucket.push(article)
    else byCategory.set(article.categoryId, [article])
  }
  return {
    categories: categories
      .map((category) => ({
        id: category.id,
        name: category.name,
        sort: category.sort,
        articles: byCategory.get(category.id) ?? [],
      }))
      .filter((category) => category.articles.length > 0),
  }
}

export async function readUserKbArticle(env: KbEnv, id: number): Promise<KbArticle> {
  const article = await getPublishedArticleById(env.DB, id)
  if (!article) throw new KbError(404, 'KB_ARTICLE_NOT_FOUND', '知识库文章不存在')
  return article
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`)
}

export async function searchUserKb(
  env: KbEnv,
  query: string,
): Promise<{ query: string, articles: KbArticleSummary[] }> {
  const articles = await searchPublishedArticles(env.DB, `%${escapeLike(query)}%`)
  return { query, articles }
}

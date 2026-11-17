import { z } from 'zod'

const categoryName = z.string().trim().min(1).max(60)
const sortOrder = z.number().int().min(0).max(100_000)

export const createCategorySchema = z.object({
  name: categoryName,
  sort: sortOrder.optional(),
})

export const updateCategorySchema = z.object({
  name: categoryName.optional(),
  sort: sortOrder.optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  '至少需要一个字段',
)

const articleFields = {
  categoryId: z.number().int().positive(),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(100_000),
  published: z.boolean(),
  sort: sortOrder,
}

export const createArticleSchema = z.object({
  categoryId: articleFields.categoryId,
  title: articleFields.title,
  content: articleFields.content,
  published: articleFields.published.optional(),
  sort: articleFields.sort.optional(),
})

export const updateArticleSchema = z.object({
  categoryId: articleFields.categoryId.optional(),
  title: articleFields.title.optional(),
  content: articleFields.content.optional(),
  published: articleFields.published.optional(),
  sort: articleFields.sort.optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  '至少需要一个字段',
)

export type CreateCategoryInput = z.infer<typeof createCategorySchema>
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>
export type CreateArticleInput = z.infer<typeof createArticleSchema>
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>

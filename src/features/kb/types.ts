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

export type KbArticle = KbArticleSummary & {
  content: string
}

export type UserKbCategory = {
  id: number
  name: string
  sort: number
  articles: KbArticleSummary[]
}

export function formatKbTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '-'
}

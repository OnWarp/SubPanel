export type Notice = {
  id: number
  title: string
  body: string
  sortOrder: number
  visible: boolean
  publishedAt: string
  createdAt: string
  updatedAt: string
}

export function formatNoticeTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '-'
}

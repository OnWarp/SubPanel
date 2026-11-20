import type { SubscriptionTemplate, TemplateReference } from '../../app/api'

export const templateStatus: Record<SubscriptionTemplate['status'], string> = {
  draft: '草稿', published: '已发布', modified: '有未发布更改', archived: '已归档',
}

export const versionLabel = (sequence: number | null | undefined) => sequence == null ? '—' : `v${sequence}`

export const templateDate = (value: string) => new Date(value).toLocaleString('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
})

export const referenceCount = (references: TemplateReference) => references.directBindings + references.inheritedCount

export const templateError = (cause: unknown) => cause instanceof Error ? cause.message : '操作失败'

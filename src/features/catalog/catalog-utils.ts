import { ApiClientError, type CatalogSource } from '../../app/api'

export const sourceTypeLabel = (type: CatalogSource['type']): string => ({
  manual: '手动文本',
  file: '文件导入',
  remote: '远程订阅',
}[type])

export const sourceStatus = (source: CatalogSource): '需处理' | '正常' | '已停用' =>
  source.lastErrorCode ? '需处理' : source.enabled ? '正常' : '已停用'

export const matchesText = (value: string, query: string): boolean =>
  value.toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN'))

export const formatLabel = (format: string | undefined): string => {
  if (!format) return '未检测'
  return ({
    'uri-list': 'URI 列表',
    mihomo: 'Mihomo',
    'sing-box': 'sing-box',
    sip008: 'SIP008',
    loon: 'Loon',
  } as Record<string, string>)[format] ?? format
}

export const formatDate = (value: string | undefined): string =>
  value ? new Date(value).toLocaleString('zh-CN') : '-'

// These administrator POSTs calculate previews or return sensitive fields without mutating catalog data.
export async function catalogPreview<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'same-origin',
  })
  const payload = await response.json()
  if (!response.ok) throw new ApiClientError(response.status, payload.error?.code ?? 'PREVIEW_FAILED',
    payload.error?.message ?? '预览失败，请检查输入后重试')
  return payload as T
}

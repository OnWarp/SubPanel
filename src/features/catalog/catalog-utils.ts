import type { CatalogSource } from '../../app/api'

export const sourceTypeLabel = (type: CatalogSource['type']): string => ({
  manual: '手工',
  file: '文件',
  remote: '远程',
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

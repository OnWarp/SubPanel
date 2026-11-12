import { Download, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataHeader } from '../../ui/DataHeader'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EditDrawer } from '../../ui/EditDrawer'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FilterChip } from '../../ui/FilterChip'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { SearchInput } from '../../ui/SearchInput'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { useToast } from '../../ui/Toast'

type PlatformName = 'android' | 'ios' | 'windows' | 'macos' | 'linux'
type TriFilter = 'all' | 'yes' | 'no'

type AppFlags = {
  isRecommended: boolean
  isOfficial: boolean
  isPopular: boolean
  isEnabled: boolean
  isPublic: boolean
}

type AppRecord = {
  id: string
  name: string
  icon: string
  summary: string
  description: string
  category: string
  officialWebsite: string
  developer?: string
  flags: AppFlags
  sortOrder: number
  createdAt: string
  updatedAt: string
}

type PlatformRecord = {
  id: string
  appId: string
  platform: PlatformName
  version: string
  downloadUrl: string
  downloadType: string
  fileSizeKb?: number
  officialStoreUrl: string
  officialDownloadUrl: string
  updateNotes: string
  importSupported: boolean
  importProtocol: string
  importUrlTemplate: string
  importInstructions: string
  isEnabled: boolean
  createdAt: string
  updatedAt: string
}

type AppsResponse = {
  schemaVersion: 1
  revision: number
  updatedAt: string
  apps: AppRecord[]
  platforms: PlatformRecord[]
}

type AppForm = {
  name: string
  icon: string
  summary: string
  description: string
  category: string
  officialWebsite: string
  developer: string
  flags: AppFlags
  sortOrder: string
}

type PlatformForm = {
  id?: string
  platform: PlatformName
  version: string
  downloadUrl: string
  downloadType: string
  fileSizeKb: string
  officialStoreUrl: string
  officialDownloadUrl: string
  updateNotes: string
  importSupported: boolean
  importProtocol: string
  importUrlTemplate: string
  importInstructions: string
  isEnabled: boolean
}

type DrawerState = { mode: 'create' } | { mode: 'edit', app: AppRecord }

const PAGE_SIZE = 20
const PLATFORM_OPTIONS: Array<{ value: PlatformName, label: string }> = [
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
]
const PLATFORM_RANK: Record<PlatformName, number> = {
  android: 0,
  ios: 1,
  windows: 2,
  macos: 3,
  linux: 4,
}

const emptyFlags = (): AppFlags => ({
  isRecommended: false,
  isOfficial: false,
  isPopular: false,
  isEnabled: true,
  isPublic: false,
})

const emptyAppForm = (): AppForm => ({
  name: '',
  icon: '',
  summary: '',
  description: '',
  category: '',
  officialWebsite: '',
  developer: '',
  flags: emptyFlags(),
  sortOrder: '0',
})

const emptyPlatformForm = (): PlatformForm => ({
  platform: 'android',
  version: '',
  downloadUrl: '',
  downloadType: '',
  fileSizeKb: '',
  officialStoreUrl: '',
  officialDownloadUrl: '',
  updateNotes: '',
  importSupported: false,
  importProtocol: '',
  importUrlTemplate: '',
  importInstructions: '',
  isEnabled: true,
})

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//iu.test(value) || value.length > 2048 || /[\s\\]/u.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

function matches(value: string, query: string): boolean {
  return value.toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN'))
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN')
}

function platformLabel(platform: PlatformName): string {
  return PLATFORM_OPTIONS.find((item) => item.value === platform)?.label ?? platform
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError || cause instanceof Error ? cause.message : fallback
}

function integerInRange(value: string, max: number): number | null {
  const trimmed = value.trim()
  if (!/^\d+$/u.test(trimmed)) return null
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed > max) return null
  return parsed
}

function optionalUrlProblem(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed || isHttpUrl(trimmed)) return ''
  return `${label}只允许 http 或 https 链接`
}

function validateApp(form: AppForm): string {
  if (!form.name.trim()) return '请填写名称'
  if (!form.category.trim()) return '请填写分类'
  if (integerInRange(form.sortOrder, 1_000_000) === null) return '排序必须是 0 到 1000000 的整数'
  return optionalUrlProblem(form.icon, '图标') || optionalUrlProblem(form.officialWebsite, '官网')
}

function validatePlatform(form: PlatformForm): string {
  if (!form.version.trim()) return '请填写版本'
  if (!form.downloadUrl.trim()) return '请填写下载链接'
  if (!isHttpUrl(form.downloadUrl.trim())) return '下载链接只允许 http 或 https 链接'
  if (!form.downloadType.trim()) return '请填写下载类型'
  if (form.fileSizeKb.trim() && integerInRange(form.fileSizeKb, 2_000_000_000) === null) return '文件大小必须是 0 到 2000000000 的整数'
  return optionalUrlProblem(form.officialStoreUrl, '商店链接') || optionalUrlProblem(form.officialDownloadUrl, '官方下载链接')
}

function toAppForm(app: AppRecord): AppForm {
  return {
    name: app.name,
    icon: app.icon,
    summary: app.summary,
    description: app.description,
    category: app.category,
    officialWebsite: app.officialWebsite,
    developer: app.developer ?? '',
    flags: { ...app.flags },
    sortOrder: String(app.sortOrder),
  }
}

function toPlatformForm(platform: PlatformRecord): PlatformForm {
  return {
    id: platform.id,
    platform: platform.platform,
    version: platform.version,
    downloadUrl: platform.downloadUrl,
    downloadType: platform.downloadType,
    fileSizeKb: platform.fileSizeKb === undefined ? '' : String(platform.fileSizeKb),
    officialStoreUrl: platform.officialStoreUrl,
    officialDownloadUrl: platform.officialDownloadUrl,
    updateNotes: platform.updateNotes,
    importSupported: platform.importSupported,
    importProtocol: platform.importProtocol,
    importUrlTemplate: platform.importUrlTemplate,
    importInstructions: platform.importInstructions,
    isEnabled: platform.isEnabled,
  }
}

function appBody(form: AppForm) {
  const developer = form.developer.trim()
  return {
    name: form.name.trim(),
    icon: form.icon.trim(),
    summary: form.summary.trim(),
    description: form.description.trim(),
    category: form.category.trim(),
    officialWebsite: form.officialWebsite.trim(),
    developer: developer || null,
    flags: form.flags,
    sortOrder: Number(form.sortOrder.trim()),
  }
}

function platformBody(form: PlatformForm) {
  const fileSizeKb = form.fileSizeKb.trim()
  return {
    platform: form.platform,
    version: form.version.trim(),
    downloadUrl: form.downloadUrl.trim(),
    downloadType: form.downloadType.trim(),
    fileSizeKb: fileSizeKb ? Number(fileSizeKb) : null,
    officialStoreUrl: form.officialStoreUrl.trim(),
    officialDownloadUrl: form.officialDownloadUrl.trim(),
    updateNotes: form.updateNotes.trim(),
    importSupported: form.importSupported,
    importProtocol: form.importProtocol.trim(),
    importUrlTemplate: form.importUrlTemplate.trim(),
    importInstructions: form.importInstructions.trim(),
    isEnabled: form.isEnabled,
  }
}

function orderPlatforms(platforms: PlatformRecord[]): PlatformRecord[] {
  return [...platforms].sort((left, right) => PLATFORM_RANK[left.platform] - PLATFORM_RANK[right.platform]
    || left.version.localeCompare(right.version, 'zh-CN')
    || left.id.localeCompare(right.id))
}

function versionSummary(platforms: PlatformRecord[]): string {
  if (platforms.length === 0) return '暂无'
  return orderPlatforms(platforms)
    .map((item) => `${platformLabel(item.platform)} ${item.version}${item.isEnabled ? '' : ' 停用'}`)
    .join(' · ')
}

function AppMark({ name, icon }: { name: string, icon: string }) {
  const [broken, setBroken] = useState(false)
  const letter = Array.from(name.trim())[0] ?? 'A'
  const showImage = !broken && isHttpUrl(icon)
  return (
    <span className="app-mark">
      <span>{letter}</span>
      {showImage ? <img src={icon} alt="" onError={() => setBroken(true)} /> : null}
    </span>
  )
}

function PlatformEditor({
  value,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  value: PlatformForm
  busy: boolean
  onChange: (patch: Partial<PlatformForm>) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="app-platform-editor"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.target instanceof HTMLTextAreaElement) return
        event.preventDefault()
        onSave()
      }}
    >
      <h4>{value.id ? '编辑平台配置' : '添加平台配置'}</h4>
      <div className="app-form-grid">
        <FormField label="平台" htmlFor="plt-platform">
          <select id="plt-platform" value={value.platform} disabled={busy} onChange={(event) => onChange({ platform: event.currentTarget.value as PlatformName })}>
            {PLATFORM_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </FormField>
        <FormField label="版本" htmlFor="plt-version">
          <input id="plt-version" value={value.version} maxLength={64} disabled={busy} onChange={(event) => onChange({ version: event.currentTarget.value })} />
        </FormField>
        <div className="app-span-2">
          <FormField label="下载链接" htmlFor="plt-download-url">
            <input id="plt-download-url" type="url" inputMode="url" value={value.downloadUrl} maxLength={2048} disabled={busy} onChange={(event) => onChange({ downloadUrl: event.currentTarget.value })} />
          </FormField>
        </div>
        <FormField label="下载类型" htmlFor="plt-download-type">
          <input id="plt-download-type" value={value.downloadType} maxLength={64} disabled={busy} placeholder="例如 direct" onChange={(event) => onChange({ downloadType: event.currentTarget.value })} />
        </FormField>
        <FormField label="文件大小 KB" htmlFor="plt-size">
          <input id="plt-size" inputMode="numeric" value={value.fileSizeKb} disabled={busy} onChange={(event) => onChange({ fileSizeKb: event.currentTarget.value })} />
        </FormField>
        <FormField label="商店链接" htmlFor="plt-store">
          <input id="plt-store" type="url" inputMode="url" value={value.officialStoreUrl} maxLength={2048} disabled={busy} onChange={(event) => onChange({ officialStoreUrl: event.currentTarget.value })} />
        </FormField>
        <FormField label="官方下载链接" htmlFor="plt-official">
          <input id="plt-official" type="url" inputMode="url" value={value.officialDownloadUrl} maxLength={2048} disabled={busy} onChange={(event) => onChange({ officialDownloadUrl: event.currentTarget.value })} />
        </FormField>
        <div className="app-span-2">
          <FormField label="更新说明" htmlFor="plt-notes">
            <textarea id="plt-notes" value={value.updateNotes} maxLength={8000} disabled={busy} onChange={(event) => onChange({ updateNotes: event.currentTarget.value })} />
          </FormField>
        </div>
        <div className="app-span-2">
          <FormField label="一键导入">
            <label className="app-flag">
              <input type="checkbox" checked={value.importSupported} disabled={busy} onChange={(event) => onChange({ importSupported: event.currentTarget.checked })} />
              支持一键导入
            </label>
            <p className="app-note">只保存配置，不会发起导入或猜测协议</p>
          </FormField>
        </div>
        <FormField label="导入协议" htmlFor="plt-protocol">
          <input id="plt-protocol" value={value.importProtocol} maxLength={64} disabled={busy} onChange={(event) => onChange({ importProtocol: event.currentTarget.value })} />
        </FormField>
        <FormField label="导入模板" htmlFor="plt-template">
          <input id="plt-template" value={value.importUrlTemplate} maxLength={2048} disabled={busy} placeholder="可使用 {url} 占位" onChange={(event) => onChange({ importUrlTemplate: event.currentTarget.value })} />
        </FormField>
        <div className="app-span-2">
          <FormField label="导入说明" htmlFor="plt-instructions">
            <textarea id="plt-instructions" value={value.importInstructions} maxLength={4000} disabled={busy} onChange={(event) => onChange({ importInstructions: event.currentTarget.value })} />
          </FormField>
        </div>
        <FormField label="状态">
          <label className="app-flag">
            <input type="checkbox" checked={value.isEnabled} disabled={busy} onChange={(event) => onChange({ isEnabled: event.currentTarget.checked })} />
            启用此平台
          </label>
        </FormField>
      </div>
      <div className="dialog-actions">
        <button className="button secondary" type="button" onClick={onCancel} disabled={busy}>取消</button>
        <button className="button primary" type="button" onClick={onSave} disabled={busy}>{busy ? '保存中' : value.id ? '保存平台' : '添加平台'}</button>
      </div>
    </div>
  )
}

export function AppsPage() {
  const [catalog, setCatalog] = useState<AppsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [platformFilter, setPlatformFilter] = useState<PlatformName | 'all'>('all')
  const [recommended, setRecommended] = useState<TriFilter>('all')
  const [enabled, setEnabled] = useState<TriFilter>('all')
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [form, setForm] = useState<AppForm>(emptyAppForm)
  const [platformEditor, setPlatformEditor] = useState<PlatformForm | null>(null)
  const [drawerError, setDrawerError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<AppRecord | null>(null)
  const [pendingPlatformId, setPendingPlatformId] = useState<string | null>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const toast = useToast()

  const load = useCallback(async () => {
    setError('')
    try {
      const next = await api<AppsResponse>('/api/admin/apps')
      setCatalog(next)
      return next
    } catch (cause) {
      setError(errorMessage(cause, '加载 APP 失败'))
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const apps = useMemo(() => [...(catalog?.apps ?? [])].sort((left, right) => left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name, 'zh-CN')
    || left.id.localeCompare(right.id)), [catalog])
  const platformsByApp = useMemo(() => {
    const grouped = new Map<string, PlatformRecord[]>()
    for (const platform of catalog?.platforms ?? []) {
      const list = grouped.get(platform.appId) ?? []
      list.push(platform)
      grouped.set(platform.appId, list)
    }
    return grouped
  }, [catalog])
  const categories = useMemo(() => [...new Set(apps.map((app) => app.category))].sort((left, right) => left.localeCompare(right, 'zh-CN')), [apps])
  const filtered = useMemo(() => apps.filter((app) => {
    const platforms = platformsByApp.get(app.id) ?? []
    if (!matches(`${app.name} ${app.category} ${app.developer ?? ''} ${app.summary}`, query)) return false
    if (category !== 'all' && app.category !== category) return false
    if (platformFilter !== 'all' && !platforms.some((item) => item.platform === platformFilter)) return false
    if (recommended === 'yes' && !app.flags.isRecommended) return false
    if (recommended === 'no' && app.flags.isRecommended) return false
    if (enabled === 'yes' && !app.flags.isEnabled) return false
    if (enabled === 'no' && app.flags.isEnabled) return false
    return true
  }), [apps, category, enabled, platformFilter, platformsByApp, query, recommended])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page])
  const drawerPlatforms = useMemo(() => {
    if (drawer?.mode !== 'edit') return []
    return orderPlatforms(platformsByApp.get(drawer.app.id) ?? [])
  }, [drawer, platformsByApp])

  useEffect(() => { setPage(1) }, [category, enabled, platformFilter, query, recommended])
  useEffect(() => { setPage((current) => Math.min(current, pageCount)) }, [pageCount])
  useEffect(() => {
    if (category !== 'all' && !categories.includes(category)) setCategory('all')
  }, [categories, category])

  const closeDrawer = () => {
    if (busy) return
    setDrawer(null)
    setPlatformEditor(null)
    setPendingPlatformId(null)
    setDrawerError('')
  }

  const guardPlatformEditor = (): boolean => {
    if (!platformEditor) return false
    const message = '请先保存或取消正在编辑的平台配置'
    setDrawerError(message)
    toast.notifyError(message)
    return true
  }

  const openCreate = () => {
    setForm(emptyAppForm())
    setPlatformEditor(null)
    setPendingPlatformId(null)
    setDrawerError('')
    setDrawer({ mode: 'create' })
  }

  const openEdit = (app: AppRecord) => {
    setForm(toAppForm(app))
    setPlatformEditor(null)
    setPendingPlatformId(null)
    setDrawerError('')
    setDrawer({ mode: 'edit', app })
  }

  const setFlag = (key: keyof AppFlags, value: boolean) => {
    setForm((current) => ({ ...current, flags: { ...current.flags, [key]: value } }))
  }

  const setText = (key: 'name' | 'category' | 'developer' | 'sortOrder' | 'icon' | 'officialWebsite' | 'summary' | 'description') =>
    (event: { currentTarget: { value: string } }) => {
      const value = event.currentTarget.value
      setForm((current) => ({ ...current, [key]: value }))
    }

  const saveApp = async (event: FormEvent) => {
    event.preventDefault()
    if (!drawer || guardPlatformEditor()) return
    const problem = validateApp(form)
    if (problem) {
      setDrawerError(problem)
      toast.notifyError(problem)
      return
    }
    setBusy(true)
    setDrawerError('')
    try {
      if (drawer.mode === 'create') {
        const result = await api<{ app: AppRecord }>('/api/admin/apps', { method: 'POST', body: jsonBody(appBody(form)) })
        setDrawer({ mode: 'edit', app: result.app })
        setForm(toAppForm(result.app))
        toast.notify('APP 已创建，可以继续添加平台配置')
      } else {
        await api<{ app: AppRecord }>(`/api/admin/apps/${drawer.app.id}`, { method: 'PUT', body: jsonBody(appBody(form)) })
        toast.notify('APP 已保存')
        setDrawer(null)
        setPlatformEditor(null)
        setPendingPlatformId(null)
      }
      await load()
    } catch (cause) {
      const message = errorMessage(cause, '保存 APP 失败')
      setDrawerError(message)
      toast.notifyError(message)
    } finally {
      setBusy(false)
    }
  }

  const savePlatform = async () => {
    if (!platformEditor || drawer?.mode !== 'edit') return
    const problem = validatePlatform(platformEditor)
    if (problem) {
      setDrawerError(problem)
      toast.notifyError(problem)
      return
    }
    const appId = drawer.app.id
    const path = platformEditor.id
      ? `/api/admin/apps/${appId}/platforms/${platformEditor.id}`
      : `/api/admin/apps/${appId}/platforms`
    setBusy(true)
    setDrawerError('')
    try {
      await api(path, { method: platformEditor.id ? 'PUT' : 'POST', body: jsonBody(platformBody(platformEditor)) })
      toast.notify(platformEditor.id ? '平台配置已更新' : '平台配置已添加')
      setPlatformEditor(null)
      await load()
    } catch (cause) {
      const message = errorMessage(cause, '保存平台配置失败')
      setDrawerError(message)
      toast.notifyError(message)
    } finally {
      setBusy(false)
    }
  }

  const removePlatform = async (platformId: string) => {
    if (drawer?.mode !== 'edit') return
    setBusy(true)
    setDrawerError('')
    try {
      await api(`/api/admin/apps/${drawer.app.id}/platforms/${platformId}`, { method: 'DELETE' })
      toast.notify('平台配置已删除')
      if (platformEditor?.id === platformId) setPlatformEditor(null)
      await load()
    } catch (cause) {
      const message = errorMessage(cause, '删除平台配置失败')
      setDrawerError(message)
      toast.notifyError(message)
    } finally {
      setPendingPlatformId(null)
      setBusy(false)
    }
  }

  const removeApp = async () => {
    if (!pendingDelete) return
    setBusy(true)
    try {
      await api(`/api/admin/apps/${pendingDelete.id}`, { method: 'DELETE' })
      toast.notify('APP 已删除')
      if (drawer?.mode === 'edit' && drawer.app.id === pendingDelete.id) {
        setDrawer(null)
        setPlatformEditor(null)
        setPendingPlatformId(null)
        setDrawerError('')
      }
      setPendingDelete(null)
      await load()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '删除 APP 失败'))
    } finally {
      setBusy(false)
    }
  }

  const columns: Array<DataTableColumn<AppRecord>> = [
    {
      key: 'icon',
      header: '图标',
      width: 72,
      render: (app) => <AppMark key={`${app.id}:${app.icon}`} name={app.name} icon={app.icon} />,
    },
    {
      key: 'name',
      header: '名称',
      render: (app) => <span className="app-identity"><strong>{app.name}</strong></span>,
    },
    { key: 'category', header: '分类', render: (app) => app.category },
    { key: 'platforms', header: '平台数', align: 'right', render: (app) => platformsByApp.get(app.id)?.length ?? 0 },
    {
      key: 'versions',
      header: '版本摘要',
      render: (app) => {
        const summary = versionSummary(platformsByApp.get(app.id) ?? [])
        return <span className="app-versions" title={summary}>{summary}</span>
      },
    },
    {
      key: 'marks',
      header: '推荐 / 启用',
      render: (app) => (
        <span className="app-badges">
          {app.flags.isRecommended ? <StatusBadge tone="info" size="sm">推荐</StatusBadge> : null}
          {app.flags.isOfficial ? <StatusBadge tone="info" size="sm">官方</StatusBadge> : null}
          {app.flags.isPopular ? <StatusBadge tone="warning" size="sm">热门</StatusBadge> : null}
          <StatusBadge tone={app.flags.isEnabled ? 'success' : 'muted'} size="sm">{app.flags.isEnabled ? '启用' : '停用'}</StatusBadge>
          <StatusBadge tone={app.flags.isPublic ? 'success' : 'muted'} size="sm">{app.flags.isPublic ? '公开' : '未公开'}</StatusBadge>
        </span>
      ),
    },
    { key: 'sortOrder', header: '排序', align: 'right', render: (app) => app.sortOrder },
    { key: 'updatedAt', header: '更新时间', render: (app) => formatDate(app.updatedAt) },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (app) => (
        <span className="row-actions">
          <button className="icon-button" type="button" aria-label={`编辑 ${app.name}`} title="编辑" disabled={busy} onClick={() => openEdit(app)}><Pencil aria-hidden="true" size={16} /></button>
          <button className="icon-button danger" type="button" aria-label={`删除 ${app.name}`} title="删除" disabled={busy} onClick={() => setPendingDelete(app)}><Trash2 aria-hidden="true" size={16} /></button>
        </span>
      ),
    },
  ]

  const description = catalog ? `${apps.length} 个 APP · 维护资料与各平台下载配置` : '维护资料与各平台下载配置'

  return (
    <div className="page-stack app-page">
      <PageHeader
        title="APP 管理"
        description={description}
        actions={<button ref={createButton} className="button primary" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加 APP</button>}
      />

      {error ? <ErrorState message={error} onRetry={() => load()} /> : null}
      <section className="data-section app-data" aria-labelledby="apps-title">
        <DataHeader id="apps-title" title="APP 列表" />
        {loading && !catalog ? (
          <div className="app-empty-wrap"><LoadingState label="正在加载 APP" /></div>
        ) : apps.length === 0 ? (
          <div className="app-empty-wrap"><EmptyState icon={Download} title="暂无 APP" description="添加后即可维护各平台的下载地址" /></div>
        ) : (
          <>
            <FilterBar className="app-filters">
              <SearchInput className="app-search" label="搜索 APP" placeholder="搜索名称、分类或开发者" value={query} onChange={setQuery} />
              <div className="app-chip-group" role="group" aria-label="按分类筛选">
                <span className="app-chip-label">分类</span>
                <FilterChip active={category === 'all'} onClick={() => setCategory('all')}>全部</FilterChip>
                {categories.map((item) => <FilterChip key={item} active={category === item} onClick={() => setCategory(item)}>{item}</FilterChip>)}
              </div>
              <div className="app-chip-group" role="group" aria-label="按平台筛选">
                <span className="app-chip-label">平台</span>
                <FilterChip active={platformFilter === 'all'} onClick={() => setPlatformFilter('all')}>全部</FilterChip>
                {PLATFORM_OPTIONS.map((item) => <FilterChip key={item.value} active={platformFilter === item.value} onClick={() => setPlatformFilter(item.value)}>{item.label}</FilterChip>)}
              </div>
              <div className="app-chip-group" role="group" aria-label="按推荐筛选">
                <span className="app-chip-label">推荐</span>
                <FilterChip active={recommended === 'all'} onClick={() => setRecommended('all')}>全部</FilterChip>
                <FilterChip active={recommended === 'yes'} onClick={() => setRecommended('yes')}>推荐</FilterChip>
                <FilterChip active={recommended === 'no'} onClick={() => setRecommended('no')}>未推荐</FilterChip>
              </div>
              <div className="app-chip-group" role="group" aria-label="按启用筛选">
                <span className="app-chip-label">启用</span>
                <FilterChip active={enabled === 'all'} onClick={() => setEnabled('all')}>全部</FilterChip>
                <FilterChip active={enabled === 'yes'} onClick={() => setEnabled('yes')}>启用</FilterChip>
                <FilterChip active={enabled === 'no'} onClick={() => setEnabled('no')}>停用</FilterChip>
              </div>
            </FilterBar>
            <DataTable
              columns={columns}
              rows={visible}
              rowKey={(app) => app.id}
              empty="没有符合筛选条件的 APP"
              pagination={filtered.length > 0 ? { page, pageCount, onPageChange: setPage } : undefined}
            />
          </>
        )}
      </section>

      <EditDrawer open={drawer !== null} title={drawer?.mode === 'create' ? '添加 APP' : '编辑 APP'} busy={busy} size="large" onClose={closeDrawer} returnFocusRef={createButton}>
        <form className="app-form" autoComplete="off" onSubmit={saveApp}>
          <div className="app-form-grid">
            <FormField label="名称" htmlFor="app-name">
              <input id="app-name" value={form.name} maxLength={128} disabled={busy} onChange={setText('name')} />
            </FormField>
            <FormField label="分类" htmlFor="app-category">
              <input id="app-category" value={form.category} maxLength={64} disabled={busy} onChange={setText('category')} />
            </FormField>
            <FormField label="开发者" htmlFor="app-developer">
              <input id="app-developer" value={form.developer} maxLength={128} disabled={busy} onChange={setText('developer')} />
            </FormField>
            <FormField label="排序" htmlFor="app-sort">
              <input id="app-sort" inputMode="numeric" value={form.sortOrder} disabled={busy} onChange={setText('sortOrder')} />
            </FormField>
            <div className="app-span-2">
              <FormField label="图标链接" htmlFor="app-icon">
                <input id="app-icon" type="url" inputMode="url" value={form.icon} maxLength={2048} disabled={busy} onChange={setText('icon')} />
              </FormField>
            </div>
            <div className="app-span-2">
              <FormField label="官网" htmlFor="app-website">
                <input id="app-website" type="url" inputMode="url" value={form.officialWebsite} maxLength={2048} disabled={busy} onChange={setText('officialWebsite')} />
              </FormField>
            </div>
            <div className="app-span-2">
              <FormField label="简介" htmlFor="app-summary">
                <input id="app-summary" value={form.summary} maxLength={512} disabled={busy} onChange={setText('summary')} />
              </FormField>
            </div>
            <div className="app-span-2">
              <FormField label="介绍" htmlFor="app-description">
                <textarea id="app-description" value={form.description} maxLength={8000} disabled={busy} onChange={setText('description')} />
              </FormField>
            </div>
            <div className="app-span-2">
              <FormField label="标记">
                <div className="app-flags" role="group" aria-label="标记">
                  <label className="app-flag"><input type="checkbox" checked={form.flags.isRecommended} disabled={busy} onChange={(event) => setFlag('isRecommended', event.currentTarget.checked)} />推荐</label>
                  <label className="app-flag"><input type="checkbox" checked={form.flags.isOfficial} disabled={busy} onChange={(event) => setFlag('isOfficial', event.currentTarget.checked)} />官方</label>
                  <label className="app-flag"><input type="checkbox" checked={form.flags.isPopular} disabled={busy} onChange={(event) => setFlag('isPopular', event.currentTarget.checked)} />热门</label>
                  <label className="app-flag"><input type="checkbox" checked={form.flags.isEnabled} disabled={busy} onChange={(event) => setFlag('isEnabled', event.currentTarget.checked)} />启用</label>
                  <label className="app-flag"><input type="checkbox" checked={form.flags.isPublic} disabled={busy} onChange={(event) => setFlag('isPublic', event.currentTarget.checked)} />对用户公开</label>
                </div>
              </FormField>
            </div>
          </div>

          <section className="app-platforms" aria-labelledby="app-platforms-title">
            <div className="app-platforms-heading">
              <h3 id="app-platforms-title">平台配置</h3>
              {drawer?.mode === 'edit' ? (
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (guardPlatformEditor()) return
                    setPendingPlatformId(null)
                    setDrawerError('')
                    setPlatformEditor(emptyPlatformForm())
                  }}
                >
                  添加平台
                </button>
              ) : null}
            </div>
            {drawer?.mode === 'create' ? <p className="app-note">保存 APP 后即可在这里添加各平台下载配置</p> : null}
            {drawer?.mode === 'edit' && drawerPlatforms.length === 0 && !platformEditor ? <p className="app-note">还没有平台配置</p> : null}
            {drawer?.mode === 'edit' && drawerPlatforms.length > 0 ? (
              <ul className="app-platform-list">
                {drawerPlatforms.map((platform) => (
                  <li key={platform.id} className={`app-platform-card${platformEditor?.id === platform.id ? ' is-active' : ''}`}>
                    {pendingPlatformId === platform.id ? (
                      <div className="app-inline-confirm">
                        <p>将删除该平台配置</p>
                        <button className="button danger" type="button" disabled={busy} onClick={() => removePlatform(platform.id)}>确认删除</button>
                        <button className="button secondary" type="button" disabled={busy} onClick={() => setPendingPlatformId(null)}>取消</button>
                      </div>
                    ) : (
                      <>
                        <span className="app-platform-meta">
                          <strong>{platformLabel(platform.platform)}</strong>
                          <span>{platform.version}</span>
                          <StatusBadge tone={platform.isEnabled ? 'success' : 'muted'} size="xs">{platform.isEnabled ? '启用' : '停用'}</StatusBadge>
                        </span>
                        <span className="row-actions">
                          <button className="icon-button" type="button" aria-label={`编辑 ${platformLabel(platform.platform)} 平台配置`} title="编辑" disabled={busy} onClick={() => { if (guardPlatformEditor()) return; setPendingPlatformId(null); setPlatformEditor(toPlatformForm(platform)) }}><Pencil aria-hidden="true" size={16} /></button>
                          <button className="icon-button danger" type="button" aria-label={`删除 ${platformLabel(platform.platform)} 平台配置`} title="删除" disabled={busy} onClick={() => { if (guardPlatformEditor()) return; setPendingPlatformId(platform.id) }}><Trash2 aria-hidden="true" size={16} /></button>
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {platformEditor ? (
              <PlatformEditor
                value={platformEditor}
                busy={busy}
                onChange={(patch) => setPlatformEditor((current) => current ? { ...current, ...patch } : current)}
                onSave={() => { savePlatform().catch(() => undefined) }}
                onCancel={() => { if (!busy) setPlatformEditor(null) }}
              />
            ) : null}
          </section>

          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
          <div className="dialog-actions">
            <button className="button secondary" type="button" onClick={closeDrawer} disabled={busy}>取消</button>
            <button className="button primary" type="submit" disabled={busy}>{busy ? '保存中' : drawer?.mode === 'create' ? '保存 APP' : '保存修改'}</button>
          </div>
        </form>
      </EditDrawer>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除 APP"
        description={pendingDelete ? `将删除「${pendingDelete.name}」及其全部平台配置，此操作无法撤销` : '将删除该 APP 及其全部平台配置'}
        confirmLabel="确认删除"
        danger
        busy={busy}
        onClose={() => { if (!busy) setPendingDelete(null) }}
        onConfirm={() => { removeApp().catch(() => undefined) }}
        returnFocusRef={createButton}
      />
    </div>
  )
}
